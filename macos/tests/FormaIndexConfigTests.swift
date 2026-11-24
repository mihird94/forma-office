import Foundation

@main
struct FormaIndexConfigTests {
    static func main() throws {
        let root = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
        let home = root.appendingPathComponent("home", isDirectory: true)
        let documents = home.appendingPathComponent("Documents", isDirectory: true)
        let desktop = home.appendingPathComponent("Desktop", isDirectory: true)
        let selected = root.appendingPathComponent("Another root", isDirectory: true)
        for directory in [documents, desktop, selected] {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        }
        let store = FormaIndexConfigStore(directory: root.appendingPathComponent("index"), home: home)
        let config = try store.loadIndexConfig()
        precondition(config.version == 1)
        precondition(config.watchedFolders == [documents, desktop].compactMap { FormaIndexConfig.canonicalPath($0.path) })
        precondition(!config.includeStandaloneImages && config.maxFileSizeMB == 50 && config.maxPdfVisualPages == 8)
        precondition(config.ignoreDirNames.contains(".git") && config.lastFullSyncAt == 0)
        precondition(FileManager.default.fileExists(atPath: store.directory.appendingPathComponent("index_config.json").path))

        let added = try store.addWatchedFolder(selected.path)
        let same = try store.addWatchedFolder(selected.appendingPathComponent(".").path)
        precondition(added.watchedFolders == same.watchedFolders && added.watchedFolders.count == 3)
        let updated = try store.update { $0.includeStandaloneImages = true; $0.lastFullSyncAt = 42 }
        let removed = try store.removeWatchedFolder(selected.path)
        precondition(removed.watchedFolders == config.watchedFolders && removed.includeStandaloneImages)
        precondition(updated.lastFullSyncAt == removed.lastFullSyncAt)
        try store.saveIndexConfig(config)
        let reopened = try store.loadIndexConfig()
        precondition(reopened.lastFullSyncAt == 0 && !reopened.includeStandaloneImages)
        precondition(FormaIndexConfig.contains("/files/docs/a.pdf", in: "/files/docs"))
        precondition(!FormaIndexConfig.contains("/files/docs-other/a.pdf", in: "/files/docs"))
    }
}
