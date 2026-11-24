import Darwin
import Foundation

func ensureFormaPrivateDirectory(_ url: URL) throws {
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let fd = Darwin.open(url.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    guard fd >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
    defer { Darwin.close(fd) }
    var info = stat()
    guard fstat(fd, &info) == 0, info.st_uid == geteuid() else { throw POSIXError(.EACCES) }
    if (info.st_mode & 0o777) != 0o700, fchmod(fd, 0o700) != 0 { throw POSIXError(.EACCES) }
}

func openFormaPrivateFile(_ url: URL) throws -> Int32 {
    let fd = Darwin.open(url.path, O_CREAT | O_RDWR | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC, S_IRUSR | S_IWUSR)
    guard fd >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
    var info = stat()
    guard fstat(fd, &info) == 0, info.st_uid == geteuid(), info.st_mode & S_IFMT == S_IFREG,
          info.st_nlink == 1, info.st_mode & 0o777 == 0o600 || fchmod(fd, 0o600) == 0 else {
        Darwin.close(fd)
        throw POSIXError(.EACCES)
    }
    return fd
}

func withFormaFileLock<T>(_ url: URL, operation: Int32 = LOCK_EX, perform body: () throws -> T) throws -> T {
    try ensureFormaPrivateDirectory(url.deletingLastPathComponent())
    let fd = try openFormaPrivateFile(url)
    defer { Darwin.close(fd) }
    while flock(fd, operation) != 0 {
        if errno != EINTR { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
    }
    defer { flock(fd, LOCK_UN) }
    return try body()
}

struct FormaIndexConfig: Codable, Sendable {
    var version = 1
    var watchedFolders: [String]
    var includeStandaloneImages = false
    var maxFileSizeMB = 50
    var maxPdfVisualPages = 8
    var ignoreDirNames = [
        ".git", "node_modules", ".venv", "venv", "site-packages", "dist-packages",
        "__pycache__", "__MACOSX", ".mypy_cache", ".pytest_cache", ".tox", ".eggs",
        "dist", "build", ".next", ".cache", "target", ".Trash", "Library",
        ".ipynb_checkpoints", "DerivedData", "Pods", "bower_components",
    ]
    var lastFullSyncAt: Double = 0

    static func defaults(home: URL) -> FormaIndexConfig {
        let paths = ["Documents", "Desktop", "Downloads"].compactMap {
            existingDirectory(home.appendingPathComponent($0).path)
        }
        var seen = Set<String>()
        return FormaIndexConfig(watchedFolders: paths.filter { seen.insert($0).inserted })
    }

    static func existingDirectory(_ path: String) -> String? {
        guard let canonical = canonicalPath(path) else { return nil }
        let url = URL(fileURLWithPath: canonical, isDirectory: true)
        guard (try? url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true else { return nil }
        return canonical
    }

    static func canonicalPath(_ path: String) -> String? {
        guard !path.utf8.contains(0) else { return nil }
        let expanded = (path as NSString).expandingTildeInPath
        guard let resolved = expanded.withCString({ realpath($0, nil) }) else { return nil }
        defer { free(resolved) }
        return String(cString: resolved)
    }

    static func contains(_ path: String, in root: String) -> Bool {
        path == root || path.hasPrefix(root == "/" ? root : root + "/")
    }

    var maximumFileBytes: Int { max(1, min(maxFileSizeMB, 500)) * 1_048_576 }
    var pdfVisualPages: Int { max(0, min(maxPdfVisualPages, 8)) }

    func hasSameScanSettings(as other: Self) -> Bool {
        watchedFolders == other.watchedFolders && includeStandaloneImages == other.includeStandaloneImages
            && maximumFileBytes == other.maximumFileBytes && pdfVisualPages == other.pdfVisualPages
            && ignoreDirNames == other.ignoreDirNames
    }
}

struct FormaIndexConfigStore: Sendable {
    let directory: URL
    var home = FileManager.default.homeDirectoryForCurrentUser

    static var defaultSupportDirectory: URL {
        let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support")
        return appSupport.appendingPathComponent("FormaOffice", isDirectory: true)
    }

    static var stateDirectory: URL {
        ProcessInfo.processInfo.environment["FORMA_INDEX_SUPPORT_DIR"].map { URL(fileURLWithPath: $0) }
            ?? defaultSupportDirectory
    }

    var configURL: URL { directory.appendingPathComponent("index_config.json") }
    var watchLockURL: URL { directory.appendingPathComponent("index_watch.lock") }
    var reconcileRequestURL: URL { directory.appendingPathComponent("index_reconcile.request") }

    var isWatcherRunning: Bool {
        do {
            return try withFormaFileLock(watchLockURL, operation: LOCK_EX | LOCK_NB) { false }
        } catch let error as POSIXError {
            return error.code == .EWOULDBLOCK
        } catch {
            return false
        }
    }

    func loadIndexConfig() throws -> FormaIndexConfig {
        try locked { try readOrCreate() }
    }

    func withIndexConfig<T>(_ read: (FormaIndexConfig) throws -> T) throws -> T {
        try locked { try read(readOrCreate()) }
    }

    func saveIndexConfig(_ config: FormaIndexConfig) throws {
        try locked { try write(config) }
    }

    func update(_ change: (inout FormaIndexConfig) throws -> Void) throws -> FormaIndexConfig {
        try locked {
            var config = try readOrCreate()
            try change(&config)
            try write(config)
            return config
        }
    }

    func addWatchedFolder(_ path: String) throws -> FormaIndexConfig {
        guard !path.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let canonical = FormaIndexConfig.existingDirectory(path) else {
            throw CocoaError(.fileNoSuchFile, userInfo: [NSFilePathErrorKey: path])
        }
        return try update {
            if !$0.watchedFolders.contains(canonical) { $0.watchedFolders.append(canonical) }
        }
    }

    func removeWatchedFolder(_ path: String) throws -> FormaIndexConfig {
        let url = URL(fileURLWithPath: (path as NSString).expandingTildeInPath).standardizedFileURL
        let canonical = FormaIndexConfig.canonicalPath(url.path)
        return try update { $0.watchedFolders.removeAll { $0 == url.path || $0 == canonical } }
    }

    private func readOrCreate() throws -> FormaIndexConfig {
        do {
            return try JSONDecoder().decode(FormaIndexConfig.self, from: Data(contentsOf: configURL))
        } catch let error as CocoaError where error.code == .fileReadNoSuchFile {
            let config = FormaIndexConfig.defaults(home: home)
            try write(config)
            return config
        }
    }

    private func write(_ config: FormaIndexConfig) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        try encoder.encode(config).write(to: configURL, options: .atomic)
        Darwin.close(try openFormaPrivateFile(configURL))
    }

    private func locked<T>(_ body: () throws -> T) throws -> T {
        try withFormaFileLock(directory.appendingPathComponent("index_config.lock"), perform: body)
    }
}
