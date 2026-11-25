import Cocoa
import WebKit
import UniformTypeIdentifiers
import Darwin

private enum FormaEditorOrigin {
    static func contains(_ url: URL) -> Bool {
        url.scheme == "forma" && url.host == "app" && url.port == nil && url.user == nil && url.password == nil
    }

    static func isEditor(_ url: URL?) -> Bool {
        guard let url, contains(url) else { return false }
        return url.path == "/index.html"
    }
}

private struct FormaFileGrants {
    let defaults: UserDefaults
    private let filesKey = "forma.native.authorizedFiles"
    private let foldersKey = "forma.native.authorizedWorkspaceFolders"

    func rememberFile(_ url: URL) {
        guard let file = regularFile(url.path) else { return }
        remember(file.path, key: filesKey)
    }

    func rememberWorkspace(_ url: URL) {
        guard let path = FormaIndexConfig.existingDirectory(url.path) else { return }
        remember(path, key: foldersKey)
    }

    func workspaceDirectory(_ path: String) -> URL? {
        guard path.hasPrefix("/"), let canonical = FormaIndexConfig.existingDirectory(path),
              belongsToWorkspace(canonical) else { return nil }
        return URL(fileURLWithPath: canonical, isDirectory: true)
    }

    func readableFile(_ path: String, includeIndex: Bool = true) -> URL? {
        guard let file = regularFile(path) else { return nil }
        if isExplicitFile(file.path) || belongsToWorkspace(file.path) { return file }
        return includeIndex && FormaSemanticBackend.shared.permitsIndexedFile(file.path) ? file : nil
    }

    func writableFile(_ path: String) -> URL? {
        guard let file = regularFile(path) else { return nil }
        let notebookInWorkspace = file.pathExtension.lowercased() == "ipynb" && belongsToWorkspace(file.path)
        return isExplicitFile(file.path) || notebookInWorkspace ? file : nil
    }

    private func regularFile(_ path: String) -> URL? {
        guard path.hasPrefix("/"), let canonical = FormaIndexConfig.canonicalPath(path) else { return nil }
        let file = URL(fileURLWithPath: canonical)
        return (try? file.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true ? file : nil
    }

    private func isExplicitFile(_ path: String) -> Bool {
        defaults.stringArray(forKey: filesKey)?.contains(path) == true
    }

    private func belongsToWorkspace(_ path: String) -> Bool {
        (defaults.stringArray(forKey: foldersKey) ?? []).contains { root in
            FormaIndexConfig.contains(path, in: root)
                && !path.dropFirst(root.count).split(separator: "/").contains { $0.hasPrefix(".") }
        }
    }

    private func remember(_ path: String, key: String) {
        var grants = Set(defaults.stringArray(forKey: key) ?? [])
        if grants.insert(path).inserted { defaults.set(grants.sorted(), forKey: key) }
    }
}

// MARK: - Thread-Safe Registry for Zero-Copy Local File Streaming (forma://local/<token>/<name>)

final class LocalFileRegistry: @unchecked Sendable {
    static let shared = LocalFileRegistry()
    private let lock = NSLock()
    private var tokenToURL: [String: URL] = [:]
    private var pathToToken: [String: String] = [:]

    func register(url: URL) -> String {
        lock.lock()
        defer { lock.unlock() }
        let stdPath = url.standardizedFileURL.path
        if let existing = pathToToken[stdPath] {
            return existing
        }
        _ = url.startAccessingSecurityScopedResource()
        let token = UUID().uuidString.replacingOccurrences(of: "-", with: "")
        tokenToURL[token] = url
        pathToToken[stdPath] = token
        return token
    }

    func url(for token: String) -> URL? {
        lock.lock()
        defer { lock.unlock() }
        return tokenToURL[token]
    }
}

// MARK: - Thread-Safe Isolated HTML Preview Scheme (forma-preview://doc/<token>)

private final class HtmlPreviewRegistry: @unchecked Sendable {
    static let shared = HtmlPreviewRegistry()
    private let lock = NSLock()
    private var entries: [String: (html: String, csp: String)] = [:]
    private var order: [String] = []

    func register(html: String, csp: String) -> String {
        let token = UUID().uuidString.replacingOccurrences(of: "-", with: "")
        lock.lock()
        defer { lock.unlock() }
        entries[token] = (html, csp)
        order.append(token)
        if order.count > 24, let oldest = order.first {
            order.removeFirst()
            entries.removeValue(forKey: oldest)
        }
        return token
    }

    func entry(for token: String) -> (html: String, csp: String)? {
        lock.lock()
        defer { lock.unlock() }
        return entries[token]
    }
}

private final class HtmlPreviewSchemeHandler: NSObject, WKURLSchemeHandler, @unchecked Sendable {
    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url,
              url.scheme == "forma-preview",
              url.host == "doc",
              (urlSchemeTask.request.httpMethod?.uppercased() ?? "GET") == "GET" else {
            urlSchemeTask.didFailWithError(URLError(.badURL))
            return
        }
        let token = url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard !token.isEmpty, let entry = HtmlPreviewRegistry.shared.entry(for: token) else {
            urlSchemeTask.didFailWithError(URLError(.fileDoesNotExist))
            return
        }
        let data = Data(entry.html.utf8)
        let headers: [String: String] = [
            "Content-Type": "text/html; charset=utf-8",
            "Content-Length": "\(data.count)",
            "Content-Security-Policy": entry.csp,
            "Cache-Control": "no-store",
        ]
        if let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers) {
            urlSchemeTask.didReceive(response)
            urlSchemeTask.didReceive(data)
            urlSchemeTask.didFinish()
        } else {
            urlSchemeTask.didFailWithError(URLError(.unknown))
        }
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}
}

// MARK: - Bundled Web Asset & Local HTTP-Range Streaming Scheme Handler

private struct UncheckedSchemeTask: @unchecked Sendable {
    let task: WKURLSchemeTask
    let id: ObjectIdentifier
}

final class BundledAssetSchemeHandler: NSObject, WKURLSchemeHandler, @unchecked Sendable {
    private let webRoot: URL
    private let ioQueue = DispatchQueue(
        label: "com.formaoffice.scheme.io",
        qos: .userInitiated,
        attributes: .concurrent
    )
    private let taskLock = NSLock()
    private var stoppedTasks = Set<ObjectIdentifier>()

    init(webRoot: URL) {
        self.webRoot = webRoot.resolvingSymlinksInPath().standardizedFileURL
    }

    private func isStopped(_ id: ObjectIdentifier) -> Bool {
        taskLock.lock()
        defer { taskLock.unlock() }
        return stoppedTasks.contains(id)
    }

    private func clearStopped(_ id: ObjectIdentifier) {
        taskLock.lock()
        stoppedTasks.remove(id)
        taskLock.unlock()
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        let method = urlSchemeTask.request.httpMethod?.uppercased() ?? "GET"
        guard let url = urlSchemeTask.request.url, FormaEditorOrigin.contains(url),
              method == "GET" || method == "HEAD" else {
            urlSchemeTask.didFailWithError(URLError(.badURL))
            return
        }

        // Fast zero-copy streaming for large local files (e.g., 100MB+ PDF books) with HTTP 206 Range support
        if url.path.hasPrefix("/__local/") {
            let box = UncheckedSchemeTask(task: urlSchemeTask, id: ObjectIdentifier(urlSchemeTask as AnyObject))
            let rangeHeader = urlSchemeTask.request.value(forHTTPHeaderField: "Range")
            ioQueue.async { [weak self] in
                self?.handleLocalFileStreamAsync(url: url, method: method, rangeHeader: rangeHeader, box: box)
            }
            return
        }

        var relativePath = url.path
        if relativePath.isEmpty || relativePath == "/" {
            relativePath = "/index.html"
        }
        let cleanRel = relativePath.hasPrefix("/") ? String(relativePath.dropFirst()) : relativePath
        let fileURL = webRoot.appendingPathComponent(cleanRel).resolvingSymlinksInPath().standardizedFileURL

        guard fileURL.path.hasPrefix(webRoot.path + "/"),
              (try? fileURL.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true,
              let data = try? Data(contentsOf: fileURL) else {
            let response = HTTPURLResponse(
                url: url,
                statusCode: 404,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "text/plain"]
            )!
            urlSchemeTask.didReceive(response)
            urlSchemeTask.didReceive(Data("Not Found".utf8))
            urlSchemeTask.didFinish()
            return
        }

        let mime = Self.mimeType(for: fileURL.pathExtension.lowercased())
        let response = HTTPURLResponse(
            url: url,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: [
                "Content-Type": mime,
                "Content-Length": "\(data.count)",
                "Cache-Control": "no-cache",
            ]
        )!
        urlSchemeTask.didReceive(response)
        if method == "GET" { urlSchemeTask.didReceive(data) }
        urlSchemeTask.didFinish()
    }

    private func deliverResponse(box: UncheckedSchemeTask, response: HTTPURLResponse, data: Data? = nil, finish: Bool = true) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            if self.isStopped(box.id) {
                if finish {
                    self.clearStopped(box.id)
                }
                return
            }
            box.task.didReceive(response)
            if let data, !data.isEmpty {
                box.task.didReceive(data)
            }
            if finish {
                box.task.didFinish()
                self.clearStopped(box.id)
            }
        }
    }

    private func deliverChunk(box: UncheckedSchemeTask, data: Data) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            if self.isStopped(box.id) { return }
            box.task.didReceive(data)
        }
    }

    private func deliverFinish(box: UncheckedSchemeTask) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            if !self.isStopped(box.id) {
                box.task.didFinish()
            }
            self.clearStopped(box.id)
        }
    }

    private func deliverError(box: UncheckedSchemeTask, error: Error) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            if !self.isStopped(box.id) {
                box.task.didFailWithError(error)
            }
            self.clearStopped(box.id)
        }
    }

    private func handleLocalFileStreamAsync(url: URL, method: String, rangeHeader: String?, box: UncheckedSchemeTask) {
        if isStopped(box.id) {
            clearStopped(box.id)
            return
        }
        let components = url.pathComponents.filter { $0 != "/" }
        // Path format: /__local/<token>/<filename>
        guard components.count >= 2,
              components[0] == "__local",
              let fileURL = LocalFileRegistry.shared.url(for: components[1]),
              let attrs = try? FileManager.default.attributesOfItem(atPath: fileURL.path),
              let fileSizeNum = attrs[.size] as? NSNumber else {
            let resp = HTTPURLResponse(url: url, statusCode: 404, httpVersion: "HTTP/1.1", headerFields: nil)!
            deliverResponse(box: box, response: resp)
            return
        }

        let totalSize = fileSizeNum.uint64Value
        let mime = fileURL.pathExtension.lowercased() == "pdf" ? "application/pdf" : "application/octet-stream"

        // Support HEAD requests
        if method == "HEAD" {
            let resp = HTTPURLResponse(
                url: url,
                statusCode: 200,
                httpVersion: "HTTP/1.1",
                headerFields: [
                    "Content-Type": mime,
                    "Content-Length": "\(totalSize)",
                    "Accept-Ranges": "bytes",
                    "X-Content-Type-Options": "nosniff",
                    "Access-Control-Expose-Headers": "Accept-Ranges, Content-Range, Content-Length",
                ]
            )!
            deliverResponse(box: box, response: resp)
            return
        }

        // Check for HTTP Range header (e.g. "bytes=0-65535") so PDF.js reads ONLY 64KB chunks!
        if let rangeHeader = rangeHeader,
           rangeHeader.hasPrefix("bytes=") {
            if totalSize == 0 {
                let resp = HTTPURLResponse(
                    url: url,
                    statusCode: 416,
                    httpVersion: "HTTP/1.1",
                    headerFields: [
                        "Content-Range": "bytes */0",
                        "X-Content-Type-Options": "nosniff",
                        "Access-Control-Expose-Headers": "Accept-Ranges, Content-Range, Content-Length",
                    ]
                )!
                deliverResponse(box: box, response: resp)
                return
            }

            let rawSpec = String(rangeHeader.dropFirst("bytes=".count))
                .split(separator: ",", maxSplits: 1, omittingEmptySubsequences: false)[0]
                .trimmingCharacters(in: .whitespaces)
            let parts = rawSpec.split(separator: "-", omittingEmptySubsequences: false)
            var validRange = false
            var start: UInt64 = 0
            var end: UInt64 = 0
            if parts.count == 2 {
                let p0 = parts[0].trimmingCharacters(in: .whitespaces)
                let p1 = parts[1].trimmingCharacters(in: .whitespaces)
                if p0.isEmpty && !p1.isEmpty, let suffix = UInt64(p1), suffix > 0 {
                    start = totalSize > suffix ? totalSize - suffix : 0
                    end = totalSize - 1
                    validRange = true
                } else if !p0.isEmpty, let s = UInt64(p0) {
                    if p1.isEmpty {
                        start = s
                        end = totalSize - 1
                        validRange = s < totalSize
                    } else if let parsedEnd = UInt64(p1) {
                        start = s
                        end = min(parsedEnd, totalSize - 1)
                        validRange = s <= end && s < totalSize
                    }
                }
            }

            guard validRange,
                  let handle = try? FileHandle(forReadingFrom: fileURL) else {
                let resp = HTTPURLResponse(
                    url: url,
                    statusCode: 416,
                    httpVersion: "HTTP/1.1",
                    headerFields: [
                        "Content-Range": "bytes */\(totalSize)",
                        "X-Content-Type-Options": "nosniff",
                        "Access-Control-Expose-Headers": "Accept-Ranges, Content-Range, Content-Length",
                    ]
                )!
                deliverResponse(box: box, response: resp)
                return
            }
            defer { try? handle.close() }

            let requestedLen = end - start + 1
            do {
                try handle.seek(toOffset: start)
                let resp = HTTPURLResponse(
                    url: url,
                    statusCode: 206,
                    httpVersion: "HTTP/1.1",
                    headerFields: [
                        "Content-Type": mime,
                        "Accept-Ranges": "bytes",
                        "Content-Range": "bytes \(start)-\(end)/\(totalSize)",
                        "Content-Length": "\(requestedLen)",
                        "X-Content-Type-Options": "nosniff",
                        "Access-Control-Expose-Headers": "Accept-Ranges, Content-Range, Content-Length",
                    ]
                )!
                deliverResponse(box: box, response: resp, data: nil, finish: false)
                var remaining = requestedLen
                while remaining > 0 && !isStopped(box.id) {
                    let toRead = Int(min(remaining, 1_048_576))
                    guard let chunk = try handle.read(upToCount: toRead), !chunk.isEmpty else { break }
                    deliverChunk(box: box, data: chunk)
                    remaining -= UInt64(chunk.count)
                }
                deliverFinish(box: box)
                return
            } catch {
                deliverError(box: box, error: error)
                return
            }
        }

        // Full file response (streamed off main thread in 1MB chunks)
        guard let handle = try? FileHandle(forReadingFrom: fileURL) else {
            let resp = HTTPURLResponse(url: url, statusCode: 500, httpVersion: "HTTP/1.1", headerFields: nil)!
            deliverResponse(box: box, response: resp)
            return
        }
        defer { try? handle.close() }

        let resp = HTTPURLResponse(
            url: url,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: [
                "Content-Type": mime,
                "Accept-Ranges": "bytes",
                "Content-Length": "\(totalSize)",
                "X-Content-Type-Options": "nosniff",
                "Access-Control-Expose-Headers": "Accept-Ranges, Content-Range, Content-Length",
            ]
        )!
        deliverResponse(box: box, response: resp, data: nil, finish: false)
        while !isStopped(box.id), let chunk = try? handle.read(upToCount: 1_048_576), !chunk.isEmpty {
            deliverChunk(box: box, data: chunk)
        }
        deliverFinish(box: box)
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        let id = ObjectIdentifier(urlSchemeTask as AnyObject)
        taskLock.lock()
        stoppedTasks.insert(id)
        taskLock.unlock()
    }

    private static func mimeType(for ext: String) -> String {
        switch ext {
        case "html", "htm": return "text/html; charset=utf-8"
        case "js", "mjs": return "application/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json": return "application/json; charset=utf-8"
        case "pdf": return "application/pdf"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "ico": return "image/x-icon"
        case "woff2": return "font/woff2"
        case "woff": return "font/woff"
        case "ttf": return "font/ttf"
        default: return "application/octet-stream"
        }
    }
}

// MARK: - Persistent Local Python 3 Kernel Manager (Forma Lab)

final class PythonKernelManager: @unchecked Sendable {
    private let ioQueue = DispatchQueue(label: "com.formaoffice.lab.kernel")
    private let onJsonEvent: @Sendable (String) -> Void
    private var process: Process?
    private var stdinHandle: FileHandle?
    private var stdoutHandle: FileHandle?
    private var stderrHandle: FileHandle?
    private var readBuffer = Data()
    private var scanOffset = 0
    private var currentReqId: String?
    private var activePythonPath: String = ""
    private var cachedEnvs: [[String: String]]?

    init(onJsonEvent: @escaping @Sendable (String) -> Void) {
        self.onJsonEvent = onJsonEvent
    }

    func handleRequest(_ body: [String: Any]) {
        let action = body["action"] as? String ?? ""
        let reqId = body["reqId"] as? String ?? ""
        let code = body["code"] as? String ?? ""
        let pythonPath = body["pythonPath"] as? String ?? ""
        let cwd = body["cwd"] as? String ?? ""

        ioQueue.async { [weak self] in
            guard let self else { return }
            if !pythonPath.isEmpty, ["exec", "trace", "sql", "restart"].contains(action),
               !self.discoverEnvs().contains(where: { $0["path"] == pythonPath }) {
                self.emitObject(["reqId": reqId, "ok": false, "error": "Choose an available Python interpreter"])
                return
            }
            switch action {
            case "listEnvs":
                let envs = self.discoverEnvs()
                if self.activePythonPath.isEmpty, let first = envs.first?["path"] {
                    self.activePythonPath = first
                }
                self.emitObject([
                    "reqId": reqId,
                    "envs": envs,
                    "activePath": self.activePythonPath,
                ])
            case "exec":
                self.execCode(reqId: reqId, code: code, requestedPython: pythonPath, cwd: cwd, mode: "exec")
            case "trace":
                self.execCode(reqId: reqId, code: code, requestedPython: pythonPath, cwd: cwd, mode: "trace")
            case "sql":
                self.execCode(reqId: reqId, code: code, requestedPython: pythonPath, cwd: cwd, mode: "sql")
            case "restart":
                self.stopLocked()
                let target = !pythonPath.isEmpty ? pythonPath : self.resolveDefaultPython()
                if !target.isEmpty {
                    self.activePythonPath = target
                    _ = self.ensureRunningLocked(pythonPath: target)
                }
                self.emitObject([
                    "reqId": reqId,
                    "ok": true,
                    "activePath": self.activePythonPath,
                ])
            case "interrupt":
                if let proc = self.process, proc.isRunning {
                    Darwin.kill(proc.processIdentifier, SIGINT)
                }
                self.emitObject(["reqId": reqId, "ok": true])
            default:
                self.emitObject(["reqId": reqId, "ok": false, "error": "Unknown kernel action: \(action)"])
            }
        }
    }

    func stop() {
        ioQueue.sync {
            self.stopLocked()
        }
    }

    private func stopLocked() {
        stdoutHandle?.readabilityHandler = nil
        stderrHandle?.readabilityHandler = nil
        try? stdinHandle?.close()
        process?.terminationHandler = nil
        if let proc = process, proc.isRunning {
            proc.terminate()
        }
        process = nil
        stdinHandle = nil
        stdoutHandle = nil
        stderrHandle = nil
        readBuffer.removeAll(keepingCapacity: false)
        scanOffset = 0
        currentReqId = nil
    }

    private func handleProcessExitLocked() {
        process = nil
        stdinHandle = nil
        stdoutHandle = nil
        stderrHandle = nil
        if let pendingReq = currentReqId {
            currentReqId = nil
            emitObject([
                "reqId": pendingReq,
                "ok": false,
                "execution_count": 0,
                "elapsed_ms": 0,
                "outputs": [[
                    "output_type": "error",
                    "ename": "KernelCrashedError",
                    "evalue": "Python kernel process exited unexpectedly",
                    "traceback": ["Python kernel process exited unexpectedly"],
                ]],
                "variables": [],
                "error": "Python kernel process exited unexpectedly",
            ])
        }
    }

    private func resolveDefaultPython() -> String {
        if !activePythonPath.isEmpty, FileManager.default.isExecutableFile(atPath: activePythonPath) {
            return activePythonPath
        }
        let envs = discoverEnvs()
        if let first = envs.first?["path"] {
            activePythonPath = first
            return first
        }
        return "/usr/bin/python3"
    }

    private func discoverEnvs() -> [[String: String]] {
        if let cached = cachedEnvs, !cached.isEmpty {
            return cached
        }
        let fm = FileManager.default
        let home = NSHomeDirectory()
        var candidates: [(path: String, label: String)] = [
            ("/opt/homebrew/Caskroom/miniconda/base/bin/python3", "conda: base"),
            ("\(home)/miniconda3/bin/python3", "conda: base"),
            ("\(home)/miniforge3/bin/python3", "mamba: base"),
            ("\(home)/anaconda3/bin/python3", "anaconda: base"),
        ]

        let envDirs = [
            "/opt/homebrew/Caskroom/miniconda/base/envs",
            "\(home)/miniconda3/envs",
            "\(home)/miniforge3/envs",
            "\(home)/anaconda3/envs",
        ]
        for dir in envDirs {
            if let names = try? fm.contentsOfDirectory(atPath: dir) {
                for envName in names.sorted() {
                    let py3 = "\(dir)/\(envName)/bin/python3"
                    let py = "\(dir)/\(envName)/bin/python"
                    if fm.isExecutableFile(atPath: py3) {
                        candidates.append((py3, "conda: \(envName)"))
                    } else if fm.isExecutableFile(atPath: py) {
                        candidates.append((py, "conda: \(envName)"))
                    }
                }
            }
        }

        candidates.append(contentsOf: [
            ("\(home)/.venv/bin/python3", "venv (~/.venv)"),
            ("/opt/homebrew/bin/python3", "Homebrew Python 3"),
            ("/usr/local/bin/python3", "Local Python 3"),
            ("/usr/bin/python3", "macOS System Python 3"),
        ])

        var seenRealPaths = Set<String>()
        var results: [[String: String]] = []

        for item in candidates {
            guard fm.isExecutableFile(atPath: item.path) else { continue }
            let resolved = URL(fileURLWithPath: item.path).resolvingSymlinksInPath().path
            if seenRealPaths.contains(resolved) { continue }
            seenRealPaths.insert(resolved)
            let version = probePythonVersion(item.path)
            results.append([
                "path": item.path,
                "label": item.label,
                "version": version,
            ])
        }

        cachedEnvs = results
        return results
    }

    private func probePythonVersion(_ path: String) -> String {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: path)
        p.arguments = ["--version"]
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = pipe
        do {
            try p.run()
            p.waitUntilExit()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            let text = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if text.hasPrefix("Python ") {
                return String(text.dropFirst("Python ".count))
            }
            return text
        } catch {
            return "3.x"
        }
    }

    private func ensureRunningLocked(pythonPath: String) -> String? {
        let target = !pythonPath.isEmpty ? pythonPath : resolveDefaultPython()
        if let proc = process, proc.isRunning, activePythonPath == target {
            return nil
        }

        stopLocked()

        guard FileManager.default.isExecutableFile(atPath: target) else {
            return "Python interpreter not found at \(target)"
        }
        guard let scriptURL = Bundle.main.resourceURL?.appendingPathComponent("forma_kernel.py"),
              FileManager.default.fileExists(atPath: scriptURL.path) else {
            return "Bundled forma_kernel.py not found in app Resources"
        }

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: target)
        proc.arguments = ["-u", scriptURL.path]

        var env = ProcessInfo.processInfo.environment
        env["PYTHONUNBUFFERED"] = "1"
        env["MPLBACKEND"] = "Agg"
        let basePath = env["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"
        let pyDir = URL(fileURLWithPath: target).deletingLastPathComponent().path
        env["PATH"] = "\(pyDir):/opt/homebrew/bin:/usr/local/bin:\(basePath)"
        proc.environment = env

        let inPipe = Pipe()
        let outPipe = Pipe()
        let errPipe = Pipe()
        proc.standardInput = inPipe
        proc.standardOutput = outPipe
        proc.standardError = errPipe

        outPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let chunk = handle.availableData
            guard let self else { return }
            if chunk.isEmpty {
                handle.readabilityHandler = nil
                self.ioQueue.async {
                    self.handleProcessExitLocked()
                }
                return
            }
            self.ioQueue.async {
                self.consumeStdoutLocked(chunk)
            }
        }

        proc.terminationHandler = { [weak self] _ in
            guard let self else { return }
            self.ioQueue.async {
                self.handleProcessExitLocked()
            }
        }

        errPipe.fileHandleForReading.readabilityHandler = { handle in
            let chunk = handle.availableData
            if chunk.isEmpty {
                handle.readabilityHandler = nil
            }
        }

        do {
            try proc.run()
            self.process = proc
            self.stdinHandle = inPipe.fileHandleForWriting
            self.stdoutHandle = outPipe.fileHandleForReading
            self.stderrHandle = errPipe.fileHandleForReading
            self.activePythonPath = target
            return nil
        } catch {
            return "Failed to launch Python kernel: \(error.localizedDescription)"
        }
    }

    private func consumeStdoutLocked(_ chunk: Data) {
        readBuffer.append(chunk)
        let newline = Data([0x0A])
        while true {
            let searchStart = readBuffer.startIndex + min(scanOffset, readBuffer.count)
            guard let range = readBuffer.range(of: newline, in: searchStart..<readBuffer.endIndex) else {
                scanOffset = readBuffer.count
                break
            }
            let lineData = readBuffer.subdata(in: readBuffer.startIndex..<range.lowerBound)
            readBuffer.removeSubrange(readBuffer.startIndex..<range.upperBound)
            scanOffset = 0
            if let line = String(data: lineData, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines),
               !line.isEmpty {
                if let pendingReq = currentReqId,
                   let data = line.data(using: .utf8),
                   let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                   let msgReqId = obj["reqId"] as? String,
                   msgReqId == pendingReq,
                   (obj["type"] as? String) != "stream_chunk" {
                    currentReqId = nil
                }
                onJsonEvent(line)
            }
        }
    }

    private func execCode(reqId: String, code: String, requestedPython: String, cwd: String, mode: String = "exec") {
        if let err = ensureRunningLocked(pythonPath: requestedPython) {
            emitObject([
                "reqId": reqId,
                "ok": false,
                "execution_count": 0,
                "elapsed_ms": 0,
                "outputs": [[
                    "output_type": "error",
                    "ename": "KernelStartupError",
                    "evalue": err,
                    "traceback": [err],
                ]],
                "variables": [],
                "error": err,
            ])
            return
        }

        var payload: [String: Any] = [
            "type": mode,
            "reqId": reqId,
            "code": code,
        ]
        if !cwd.isEmpty {
            payload["cwd"] = cwd
        }
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              var line = String(data: data, encoding: .utf8) else {
            emitObject(["reqId": reqId, "ok": false, "error": "Failed to encode execution request"])
            return
        }
        line.append("\n")
        currentReqId = reqId
        do {
            try stdinHandle?.write(contentsOf: Data(line.utf8))
        } catch {
            stopLocked()
            emitObject([
                "reqId": reqId,
                "ok": false,
                "execution_count": 0,
                "elapsed_ms": 0,
                "outputs": [[
                    "output_type": "error",
                    "ename": "KernelWriteError",
                    "evalue": error.localizedDescription,
                    "traceback": [error.localizedDescription],
                ]],
                "variables": [],
                "error": error.localizedDescription,
            ])
        }
    }

    private func emitObject(_ obj: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: obj),
              let json = String(data: data, encoding: .utf8) else { return }
        onJsonEvent(json)
    }
}

// MARK: - Per-Window Controller (Supports Multiple Simultaneous Windows)

@MainActor
final class FormaWindowController: NSObject, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    let window: NSWindow
    let webView: WKWebView
    private let appKind: String
    private let displayName: String
    private var isAppMounted = false
    private var allowImmediateClose = false
    private var pendingOpenURLs: [URL] = []
    private var pendingMountedActions: [() -> Void] = []
    private var watchedSources: [String: DispatchSourceFileSystemObject] = [:]
    private var selfWriteTimestamps: [String: Date] = [:]
    private var kernelManager: PythonKernelManager?
    private let fileGrants = FormaFileGrants(defaults: .standard)
    private let onOpenNewWindow: (String?) -> Void
    private let onRequestOpenDialog: (FormaWindowController) -> Void
    private let onClose: (FormaWindowController) -> Void

    init(
        appKind: String,
        displayName: String,
        initialFileId: String?,
        cascadeOffset: CGFloat,
        onOpenNewWindow: @escaping (String?) -> Void,
        onRequestOpenDialog: @escaping (FormaWindowController) -> Void,
        onClose: @escaping (FormaWindowController) -> Void
    ) {
        self.appKind = appKind
        self.displayName = displayName
        self.onOpenNewWindow = onOpenNewWindow
        self.onRequestOpenDialog = onRequestOpenDialog
        self.onClose = onClose

        let screenFrame = NSScreen.main?.visibleFrame ?? NSRect(x: 120, y: 120, width: 1280, height: 840)
        let width = min(1360, screenFrame.width * 0.86)
        let height = min(880, screenFrame.height * 0.88)
        let rect = NSRect(
            x: screenFrame.midX - width / 2 + cascadeOffset,
            y: screenFrame.midY - height / 2 - cascadeOffset,
            width: width,
            height: height
        )

        self.window = NSWindow(
            contentRect: rect,
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )

        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        config.preferences.javaScriptCanOpenWindowsAutomatically = false

        let contentController = WKUserContentController()
        config.userContentController = contentController

        let webRoot = Bundle.main.resourceURL!.appendingPathComponent("web")
        config.setURLSchemeHandler(BundledAssetSchemeHandler(webRoot: webRoot), forURLScheme: "forma")
        config.setURLSchemeHandler(HtmlPreviewSchemeHandler(), forURLScheme: "forma-preview")

        self.webView = WKWebView(frame: window.contentView!.bounds, configuration: config)

        super.init()

        contentController.add(self, name: "formaSaveFile")
        contentController.add(self, name: "formaPrint")
        contentController.add(self, name: "formaNewWindow")
        contentController.add(self, name: "formaAppReady")
        contentController.add(self, name: "formaResolveLocalPath")
        contentController.add(self, name: "formaRegisterHtmlPreview")
        contentController.add(self, name: "formaOpenFileDialog")
        if appKind == "lab" { contentController.add(self, name: "formaKernel") }
        contentController.add(self, name: "formaWorkspace")
        contentController.add(self, name: "formaWindowTitle")
        contentController.add(self, name: "formaAI")
        contentController.add(self, name: "formaPdfOcr")
        contentController.add(self, name: "formaSetDirty")
        contentController.add(self, name: "formaWatchFile")

        if appKind == "lab" {
            self.kernelManager = PythonKernelManager { [weak self] jsonLine in
                DispatchQueue.main.async {
                    guard let self else { return }
                    self.webView.callAsyncJavaScript(
                        "window.__formaKernelEvent && window.__formaKernelEvent(JSON.parse(jsonStr));",
                        arguments: ["jsonStr": jsonLine],
                        in: nil,
                        in: .page
                    ) { _ in }
                }
            }
        }

        window.title = displayName
        window.isReleasedWhenClosed = false
        window.minSize = NSSize(width: 860, height: 580)
        window.backgroundColor = NSColor(calibratedRed: 0.06, green: 0.09, blue: 0.16, alpha: 1.0)
        window.delegate = self

        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self
        webView.uiDelegate = self
        window.contentView?.addSubview(webView)

        var urlString = "forma://app/index.html?app=\(appKind)"
        if let fileId = initialFileId, !fileId.isEmpty {
            let encoded = fileId.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? fileId
            urlString += "&file=\(encoded)"
        }
        webView.load(URLRequest(url: URL(string: urlString)!))
        window.makeKeyAndOrderFront(nil)
    }

    func enqueueOpenURL(_ url: URL) {
        if isAppMounted {
            sendFileToWebView(url: url)
        } else {
            pendingOpenURLs.append(url)
        }
    }

    private func flushPendingOpenURLs() {
        guard isAppMounted else { return }
        if !pendingOpenURLs.isEmpty {
            let queued = pendingOpenURLs
            pendingOpenURLs.removeAll()
            for url in queued {
                sendFileToWebView(url: url)
            }
        }
        if !pendingMountedActions.isEmpty {
            let actions = pendingMountedActions
            pendingMountedActions.removeAll()
            for action in actions {
                action()
            }
        }
    }

    private func runWhenMounted(_ block: @escaping () -> Void) {
        if isAppMounted {
            block()
        } else {
            pendingMountedActions.append(block)
        }
    }

    func createNewBlankFile() {
        let jsKind: String
        switch appKind {
        case "docs": jsKind = "document"
        case "slides": jsKind = "slides"
        case "lab": jsKind = "notebook"
        case "pdf": jsKind = "pdf"
        case "canvas": jsKind = "canvas"
        default: jsKind = "spreadsheet"
        }
        runWhenMounted { [weak self] in
            self?.webView.evaluateJavaScript("window.__formaCreateNew && window.__formaCreateNew('\(jsKind)')")
        }
    }

    func showStartHub() {
        runWhenMounted { [weak self] in
            self?.webView.evaluateJavaScript("window.__formaShowHub && window.__formaShowHub()")
        }
    }

    func zoomIn() {
        webView.evaluateJavaScript("window.__formaZoom && window.__formaZoom('in')")
    }

    func zoomOut() {
        webView.evaluateJavaScript("window.__formaZoom && window.__formaZoom('out')")
    }

    func zoomReset() {
        webView.evaluateJavaScript("window.__formaZoom && window.__formaZoom('reset')")
    }

    func toggleReadingMode() {
        webView.evaluateJavaScript("window.__formaToggleReadingMode && window.__formaToggleReadingMode()")
    }

    func openFolderWorkspace() {
        runWhenMounted { [weak self] in
            self?.webView.evaluateJavaScript("window.__formaOpenFolder && window.__formaOpenFolder()")
        }
    }

    func saveActiveDocument() {
        webView.evaluateJavaScript("window.__formaSaveActive && window.__formaSaveActive()")
    }

    func closeTabOrWindow() {
        webView.evaluateJavaScript("window.__formaCloseActiveTab ? window.__formaCloseActiveTab() : false") { [weak self] res, _ in
            let closedTab = (res as? Bool) ?? false
            if !closedTab {
                self?.window.performClose(nil)
            }
        }
    }

    func performNativePrint() {
        let printInfo = NSPrintInfo.shared.copy() as! NSPrintInfo
        printInfo.topMargin = 36
        printInfo.bottomMargin = 36
        printInfo.leftMargin = 36
        printInfo.rightMargin = 36
        printInfo.isHorizontallyCentered = true
        printInfo.isVerticallyCentered = false

        let op = webView.printOperation(with: printInfo)
        op.showsPrintPanel = true
        op.showsProgressPanel = true
        op.runModal(for: window, delegate: nil, didRun: nil, contextInfo: nil)
    }

    private func sendFileToWebView(url: URL) {
        var isDir: ObjCBool = false
        if FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir), isDir.boolValue {
            fileGrants.rememberWorkspace(url)
            _ = url.startAccessingSecurityScopedResource()
            webView.callAsyncJavaScript(
                "window.__formaOpenNativeFolder && window.__formaOpenNativeFolder(folderPath);",
                arguments: ["folderPath": url.standardizedFileURL.path],
                in: nil,
                in: .page
            ) { _ in }
            return
        }

        let ext = url.pathExtension.lowercased()
        fileGrants.rememberFile(url)
        let token = LocalFileRegistry.shared.register(url: url)
        let attrs = try? FileManager.default.attributesOfItem(atPath: url.path)
        let fileSize = (attrs?[.size] as? NSNumber)?.intValue ?? 0
        let safeName = url.lastPathComponent.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? "document.\(ext.isEmpty ? "bin" : ext)"
        let streamUrl = "forma://app/__local/\(token)/\(safeName)"

        // Zero-copy HTTP-206 Range streaming for PDFs and streamed local fetch for all other files (avoids huge Base64 IPC!)
        let callbackName = ext == "pdf" ? "__formaOpenNativePdfStream" : "__formaOpenNativeStream"
        let script = """
        if (window.\(callbackName)) {
          window.\(callbackName)(streamUrl, filename, fileSize, filePath);
        }
        """
        webView.callAsyncJavaScript(
            script,
            arguments: [
                "streamUrl": streamUrl,
                "filename": url.lastPathComponent,
                "fileSize": fileSize,
                "filePath": url.standardizedFileURL.path,
            ],
            in: nil,
            in: .page
        ) { _ in }
    }

    // MARK: - NSWindowDelegate & File Watching

    func markSelfWrite(_ path: String) {
        selfWriteTimestamps[path] = Date()
    }

    private func startWatchingFile(_ path: String) {
        let stdPath = URL(fileURLWithPath: path).standardizedFileURL.path
        if watchedSources[stdPath] != nil { return }
        let fd = open(stdPath, O_EVTONLY)
        guard fd >= 0 else { return }
        let source = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: fd,
            eventMask: [.write, .rename, .extend, .attrib],
            queue: DispatchQueue.main
        )
        source.setEventHandler { [weak self] in
            guard let self else { return }
            if let lastSelf = self.selfWriteTimestamps[stdPath],
               Date().timeIntervalSince(lastSelf) < 1.5 {
                return
            }
            self.webView.callAsyncJavaScript(
                "window.__formaExternalFileChanged && window.__formaExternalFileChanged(filePath);",
                arguments: ["filePath": stdPath],
                in: nil,
                in: .page
            ) { _ in }
        }
        source.setCancelHandler {
            close(fd)
        }
        watchedSources[stdPath] = source
        source.resume()
    }

    private func stopAllFileWatchers() {
        for (_, src) in watchedSources {
            src.cancel()
        }
        watchedSources.removeAll()
    }

    func flushForClose(completion: @escaping (Bool) -> Void) {
        if !isAppMounted {
            completion(true)
            return
        }
        var completed = false
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) {
            guard !completed else { return }
            completed = true
            completion(true)
        }
        webView.callAsyncJavaScript(
            "return await (window.__formaFlushBeforeClose ? window.__formaFlushBeforeClose() : true);",
            arguments: [:],
            in: nil,
            in: .page
        ) { result in
            guard !completed else { return }
            completed = true
            switch result {
            case .success(let val):
                if let boolVal = val as? Bool {
                    completion(boolVal)
                } else {
                    completion(true)
                }
            case .failure:
                completion(true)
            }
        }
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if allowImmediateClose || !isAppMounted {
            return true
        }
        flushForClose { [weak self] savedOk in
            guard let self else { return }
            if savedOk {
                self.allowImmediateClose = true
                self.window.close()
                return
            }
            let alert = NSAlert()
            alert.messageText = "Changes could not be saved"
            alert.informativeText = "Forma could not finish saving your latest edits to local storage. Keep the window open to export or retry, or close anyway."
            alert.alertStyle = .warning
            alert.addButton(withTitle: "Keep Open")
            alert.addButton(withTitle: "Close Anyway")
            alert.beginSheetModal(for: self.window) { response in
                if response == .alertSecondButtonReturn {
                    self.allowImmediateClose = true
                    self.window.close()
                }
            }
        }
        return false
    }

    func windowWillClose(_ notification: Notification) {
        stopAllFileWatchers()
        kernelManager?.stop()
        kernelManager = nil
        window.delegate = nil
        webView.stopLoading()
        webView.navigationDelegate = nil
        webView.uiDelegate = nil
        let controller = webView.configuration.userContentController
        controller.removeScriptMessageHandler(forName: "formaSaveFile")
        controller.removeScriptMessageHandler(forName: "formaPrint")
        controller.removeScriptMessageHandler(forName: "formaNewWindow")
        controller.removeScriptMessageHandler(forName: "formaAppReady")
        controller.removeScriptMessageHandler(forName: "formaResolveLocalPath")
        controller.removeScriptMessageHandler(forName: "formaOpenFileDialog")
        controller.removeScriptMessageHandler(forName: "formaKernel")
        controller.removeScriptMessageHandler(forName: "formaWorkspace")
        controller.removeScriptMessageHandler(forName: "formaWindowTitle")
        controller.removeScriptMessageHandler(forName: "formaAI")
        controller.removeScriptMessageHandler(forName: "formaPdfOcr")
        controller.removeScriptMessageHandler(forName: "formaSetDirty")
        controller.removeScriptMessageHandler(forName: "formaWatchFile")
        DispatchQueue.main.async { [self] in
            self.onClose(self)
        }
    }

    // MARK: - WKNavigationDelegate

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let url = action.request.url
        if action.targetFrame?.isMainFrame == true, FormaEditorOrigin.isEditor(url) {
            decisionHandler(.allow)
            return
        }
        if action.targetFrame?.isMainFrame == false,
           let url, (url.scheme == "forma-preview" || url.absoluteString == "about:srcdoc"),
           FormaEditorOrigin.isEditor(action.sourceFrame.request.url) {
            decisionHandler(.allow)
            return
        }
        decisionHandler(.cancel)
        if action.navigationType == .linkActivated, action.sourceFrame.isMainFrame,
           FormaEditorOrigin.isEditor(action.sourceFrame.request.url),
           let url, let scheme = url.scheme, ["http", "https", "mailto"].contains(scheme) {
            NSWorkspace.shared.open(url)
        }
    }

    // MARK: - WKScriptMessageHandler

    private func handleSemanticIndexRequest(_ body: [String: Any]) {
        let reply: @Sendable ([String: Any]) -> Void = { [weak self] response in
            guard let data = try? JSONSerialization.data(withJSONObject: response),
                  let json = String(data: data, encoding: .utf8) else { return }
            DispatchQueue.main.async {
                self?.webView.callAsyncJavaScript(
                    "window.__formaAIEvent && window.__formaAIEvent(JSON.parse(jsonStr));",
                    arguments: ["jsonStr": json], in: nil, in: .page
                ) { _ in }
            }
        }
        let action = body["action"] as? String ?? ""
        guard action == "addWatchedFolder" else {
            var approved = body
            switch action {
            case "status", "listModels", "semanticSearch", "getIndexConfig", "syncWatchedFolders",
                 "removeWatchedFolder", "toggleIndexImages", "chat":
                break
            case "indexDocument", "removeDocument":
                guard let docId = body["docId"] as? String, !docId.hasPrefix("file:") else {
                    reply(["ok": false, "reqId": body["reqId"] ?? "", "error": "Use a workspace document"])
                    return
                }
                if let path = body["path"] as? String {
                    approved["path"] = fileGrants.readableFile(path)?.path ?? ""
                }
            default:
                reply(["ok": false, "reqId": body["reqId"] ?? "", "error": "Unsupported editor action"])
                return
            }
            FormaSemanticBackend.shared.handleAIRequest(approved, reply: reply)
            return
        }
        let picker = NSOpenPanel()
        picker.canChooseDirectories = true
        picker.canChooseFiles = false
        picker.allowsMultipleSelection = false
        picker.prompt = "Add Folder"
        picker.beginSheetModal(for: window) { result in
            guard result == .OK, let url = picker.url else {
                reply(["ok": true, "cancelled": true, "reqId": body["reqId"] as? String ?? ""])
                return
            }
            var selected = body
            selected["path"] = url.path
            FormaSemanticBackend.shared.handleAIRequest(selected, reply: reply)
        }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.webView === webView, message.frameInfo.isMainFrame,
              FormaEditorOrigin.isEditor(message.frameInfo.request.url), FormaEditorOrigin.isEditor(webView.url) else { return }
        if message.name == "formaAppReady" {
            isAppMounted = true
            flushPendingOpenURLs()
        } else if message.name == "formaResolveLocalPath",
                  let body = message.body as? [String: Any],
                  let requestId = body["requestId"] as? String,
                  let path = body["path"] as? String {
            var streamUrl = ""
            if let fileURL = fileGrants.readableFile(path) {
                let token = LocalFileRegistry.shared.register(url: fileURL)
                let safeName = fileURL.lastPathComponent.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? "document.pdf"
                streamUrl = "forma://app/__local/\(token)/\(safeName)"
            }
            webView.callAsyncJavaScript(
                "window.__formaResolveLocalPathCb && window.__formaResolveLocalPathCb(requestId, streamUrl);",
                arguments: ["requestId": requestId, "streamUrl": streamUrl],
                in: nil,
                in: .page
            ) { _ in }
        } else if message.name == "formaRegisterHtmlPreview",
                  let body = message.body as? [String: Any],
                  let requestId = body["requestId"] as? String,
                  let html = body["html"] as? String {
            let rawOrigins = body["allowedOrigins"] as? [String] ?? []
            var originSet = Set<String>()
            for candidate in rawOrigins {
                let trimmed = candidate.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !trimmed.isEmpty,
                      !trimmed.contains(where: { $0.isWhitespace || $0 == ";" || $0 == "'" || $0 == "\"" }),
                      let comps = URLComponents(string: trimmed),
                      let scheme = comps.scheme?.lowercased(), ["http", "https"].contains(scheme),
                      let host = comps.host, !host.isEmpty,
                      comps.user == nil, comps.password == nil,
                      comps.path.isEmpty, comps.query == nil, comps.fragment == nil else { continue }
                let origin = comps.port.map { "\(scheme)://\(host):\($0)" } ?? "\(scheme)://\(host)"
                originSet.insert(origin)
                if origin.lowercased() == "https://fonts.googleapis.com" {
                    originSet.insert("https://fonts.gstatic.com")
                }
            }
            let extra = originSet.isEmpty ? "" : " " + originSet.sorted().joined(separator: " ")
            let csp = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob: data:\(extra); style-src 'unsafe-inline' blob: data:\(extra); img-src data: blob:\(extra); font-src data: blob:\(extra); connect-src blob: data:\(extra); worker-src blob:; child-src blob:; media-src data: blob:\(extra); base-uri 'none'; form-action 'none';"
            let token = HtmlPreviewRegistry.shared.register(html: html, csp: csp)
            let previewUrl = "forma-preview://doc/\(token)"
            webView.callAsyncJavaScript(
                "window.__formaResolveHtmlPreview && window.__formaResolveHtmlPreview(requestId, previewUrl);",
                arguments: ["requestId": requestId, "previewUrl": previewUrl],
                in: nil,
                in: .page
            ) { _ in }
        } else if message.name == "formaSaveFile",
                  let body = message.body as? [String: Any],
                  let filename = body["filename"] as? String,
                  let base64 = body["base64"] as? String {
            let requestId = body["requestId"] as? String ?? ""
            DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                let decoded = Data(base64Encoded: base64)
                DispatchQueue.main.async {
                    guard let self else { return }
                    guard let data = decoded else {
                        self.webView.callAsyncJavaScript(
                            "window.__formaSaveResult && window.__formaSaveResult(result);",
                            arguments: ["result": ["requestId": requestId, "error": "Invalid binary save payload"]],
                            in: nil,
                            in: .page
                        ) { _ in }
                        return
                    }
                    self.presentNativeSavePanel(suggestedFilename: filename, data: data, requestId: requestId)
                }
            }
        } else if message.name == "formaPrint" {
            performNativePrint()
        } else if message.name == "formaNewWindow" {
            let body = message.body as? [String: Any]
            let fileId = body?["fileId"] as? String
            onOpenNewWindow(fileId)
        } else if message.name == "formaOpenFileDialog" {
            onRequestOpenDialog(self)
        } else if message.name == "formaKernel", appKind == "lab",
                  let body = message.body as? [String: Any] {
            kernelManager?.handleRequest(body)
        } else if message.name == "formaWorkspace",
                  let body = message.body as? [String: Any] {
            handleWorkspaceRequest(body)
        } else if message.name == "formaWindowTitle",
                  let body = message.body as? [String: Any],
                  let title = body["title"] as? String,
                  !title.isEmpty {
            window.title = title
        } else if message.name == "formaSetDirty",
                  let body = message.body as? [String: Any],
                  let dirty = body["dirty"] as? Bool {
            window.isDocumentEdited = dirty
        } else if message.name == "formaWatchFile",
                  let body = message.body as? [String: Any],
                  let path = body["path"] as? String,
                  let fileURL = fileGrants.readableFile(path) {
            startWatchingFile(fileURL.path)
        } else if message.name == "formaAI",
                  let body = message.body as? [String: Any] {
            handleSemanticIndexRequest(body)
        } else if message.name == "formaPdfOcr",
                  let body = message.body as? [String: Any] {
            var approved = body
            if let path = body["path"] as? String {
                approved["path"] = fileGrants.readableFile(path)?.path
            }
            FormaSemanticBackend.shared.handleOcrRequest(approved) { [weak self] responseObj in
                guard let data = try? JSONSerialization.data(withJSONObject: responseObj),
                      let json = String(data: data, encoding: .utf8) else { return }
                DispatchQueue.main.async {
                    self?.webView.callAsyncJavaScript(
                        "window.__formaOcrEvent && window.__formaOcrEvent(JSON.parse(jsonStr));",
                        arguments: ["jsonStr": json],
                        in: nil,
                        in: .page
                    ) { _ in }
                }
            }
        }
    }

    private func emitWorkspaceEvent(_ obj: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: obj),
              let json = String(data: data, encoding: .utf8) else { return }
        webView.callAsyncJavaScript(
            "window.__formaWorkspaceEvent && window.__formaWorkspaceEvent(JSON.parse(jsonStr));",
            arguments: ["jsonStr": json],
            in: nil,
            in: .page
        ) { _ in }
    }

    private static let ignoredFolderNames: Set<String> = [
        ".git", "node_modules", "__pycache__", ".ipynb_checkpoints",
        ".venv", "venv", ".mypy_cache", ".pytest_cache", ".DS_Store",
        "dist", "build", ".next", ".cache", "target", ".tox", ".eggs",
    ]

    private func scanWorkspaceDirectory(url: URL, depth: Int, budget: inout Int) -> [[String: Any]] {
        guard depth <= 5, budget > 0 else { return [] }
        let fm = FileManager.default
        guard let items = try? fm.contentsOfDirectory(
            at: url,
            includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey, .isRegularFileKey, .fileSizeKey],
            options: [.skipsHiddenFiles]
        ) else {
            return []
        }

        var dirs: [(name: String, url: URL)] = []
        var notebooks: [(name: String, url: URL, size: Int)] = []
        var others: [(name: String, url: URL, ext: String, size: Int)] = []

        for item in items {
            let name = item.lastPathComponent
            if Self.ignoredFolderNames.contains(name) { continue }
            guard let vals = try? item.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey, .isRegularFileKey, .fileSizeKey]),
                  vals.isSymbolicLink != true else { continue }
            if vals.isDirectory == true {
                dirs.append((name, item))
            } else if vals.isRegularFile == true {
                let ext = item.pathExtension.lowercased()
                let size = vals.fileSize ?? 0
                if ext == "ipynb" {
                    notebooks.append((name, item, size))
                } else {
                    others.append((name, item, ext, size))
                }
            }
        }

        dirs.sort { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
        notebooks.sort { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
        others.sort { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }

        var nodes: [[String: Any]] = []
        for d in dirs {
            guard budget > 0 else { break }
            budget -= 1
            let children = scanWorkspaceDirectory(url: d.url, depth: depth + 1, budget: &budget)
            nodes.append([
                "name": d.name,
                "path": d.url.standardizedFileURL.path,
                "kind": "dir",
                "children": children,
            ])
        }
        for nb in notebooks {
            guard budget > 0 else { break }
            budget -= 1
            nodes.append([
                "name": nb.name,
                "path": nb.url.standardizedFileURL.path,
                "kind": "file",
                "ext": "ipynb",
                "size": nb.size,
            ])
        }
        for f in others {
            guard budget > 0 else { break }
            budget -= 1
            nodes.append([
                "name": f.name,
                "path": f.url.standardizedFileURL.path,
                "kind": "file",
                "ext": f.ext,
                "size": f.size,
            ])
        }
        return nodes
    }

    private func handleWorkspaceRequest(_ body: [String: Any]) {
        let action = body["action"] as? String ?? ""
        let reqId = body["reqId"] as? String ?? ""

        switch action {
        case "pickFolder":
            guard appKind == "lab" else {
                emitWorkspaceEvent(["reqId": reqId, "ok": false, "error": "Choose a notebook folder in Forma Lab"])
                return
            }
            let panel = NSOpenPanel()
            panel.canChooseFiles = false
            panel.canChooseDirectories = true
            panel.allowsMultipleSelection = false
            panel.prompt = "Open Folder"
            panel.message = "Choose a folder of Jupyter notebooks (.ipynb) and Python files"
            panel.beginSheetModal(for: window) { [weak self] response in
                guard let self else { return }
                guard response == .OK, let folderURL = panel.url else {
                    self.emitWorkspaceEvent(["reqId": reqId, "ok": false, "cancelled": true])
                    return
                }
                _ = folderURL.startAccessingSecurityScopedResource()
                self.fileGrants.rememberWorkspace(folderURL)
                var budget = 800
                let entries = self.scanWorkspaceDirectory(url: folderURL, depth: 0, budget: &budget)
                self.emitWorkspaceEvent([
                    "reqId": reqId,
                    "ok": true,
                    "rootPath": folderURL.standardizedFileURL.path,
                    "rootName": folderURL.lastPathComponent,
                    "entries": entries,
                ])
            }
        case "listFolder":
            guard let path = body["path"] as? String, let folderURL = fileGrants.workspaceDirectory(path) else {
                emitWorkspaceEvent(["reqId": reqId, "ok": false, "error": "Choose this folder in Forma first"])
                return
            }
            var budget = 800
            let entries = scanWorkspaceDirectory(url: folderURL, depth: 0, budget: &budget)
            emitWorkspaceEvent([
                "reqId": reqId,
                "ok": true,
                "rootPath": folderURL.standardizedFileURL.path,
                "rootName": folderURL.lastPathComponent,
                "entries": entries,
            ])
        case "readFile":
            guard let path = body["path"] as? String, let fileURL = fileGrants.readableFile(path) else {
                emitWorkspaceEvent(["reqId": reqId, "ok": false, "error": "Open this file in Forma first"])
                return
            }
            do {
                let size = try fileURL.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
                guard size <= 50 * 1_048_576 else {
                    emitWorkspaceEvent(["reqId": reqId, "ok": false, "error": "This text file is too large to preview"])
                    return
                }
                let text = try String(contentsOf: fileURL, encoding: .utf8)
                emitWorkspaceEvent([
                    "reqId": reqId,
                    "ok": true,
                    "path": fileURL.standardizedFileURL.path,
                    "name": fileURL.lastPathComponent,
                    "content": text,
                ])
            } catch {
                emitWorkspaceEvent(["reqId": reqId, "ok": false, "error": error.localizedDescription])
            }
        case "writeFile":
            guard let path = body["path"] as? String,
                  let fileURL = fileGrants.writableFile(path),
                  let content = body["content"] as? String else {
                emitWorkspaceEvent(["reqId": reqId, "ok": false, "error": "Choose this file in Open or Save As before writing"])
                return
            }
            let stdPath = fileURL.standardizedFileURL.path
            markSelfWrite(stdPath)
            DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                do {
                    try content.write(to: fileURL, atomically: true, encoding: .utf8)
                    DispatchQueue.main.async {
                        self?.markSelfWrite(stdPath)
                        self?.emitWorkspaceEvent(["reqId": reqId, "ok": true, "path": stdPath])
                    }
                } catch {
                    let msg = error.localizedDescription
                    DispatchQueue.main.async {
                        self?.emitWorkspaceEvent(["reqId": reqId, "ok": false, "error": msg])
                    }
                }
            }
        case "writeBinaryFile":
            guard let path = body["path"] as? String,
                  let fileURL = fileGrants.writableFile(path),
                  let base64 = body["base64"] as? String else {
                emitWorkspaceEvent(["reqId": reqId, "ok": false, "error": "Choose this file in Open or Save As before writing"])
                return
            }
            let stdPath = fileURL.standardizedFileURL.path
            markSelfWrite(stdPath)
            DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                guard let data = Data(base64Encoded: base64) else {
                    DispatchQueue.main.async {
                        self?.emitWorkspaceEvent(["reqId": reqId, "ok": false, "error": "Invalid binary payload"])
                    }
                    return
                }
                do {
                    try data.write(to: fileURL, options: .atomic)
                    DispatchQueue.main.async {
                        self?.markSelfWrite(stdPath)
                        self?.emitWorkspaceEvent(["reqId": reqId, "ok": true, "path": stdPath])
                    }
                } catch {
                    let msg = error.localizedDescription
                    DispatchQueue.main.async {
                        self?.emitWorkspaceEvent(["reqId": reqId, "ok": false, "error": msg])
                    }
                }
            }
        case "createNotebook":
            guard let dirPath = body["dirPath"] as? String,
                  let folder = fileGrants.workspaceDirectory(dirPath),
                  let rawName = body["name"] as? String,
                  !rawName.isEmpty, !rawName.hasPrefix("."), !rawName.contains("/"), !rawName.utf8.contains(0),
                  let content = body["content"] as? String else {
                emitWorkspaceEvent(["reqId": reqId, "ok": false, "error": "Choose a notebook folder and enter a file name"])
                return
            }
            let cleanName = rawName.hasSuffix(".ipynb") ? rawName : "\(rawName).ipynb"
            let targetURL = folder.appendingPathComponent(cleanName)
            do {
                try Data(content.utf8).write(to: targetURL, options: .withoutOverwriting)
                emitWorkspaceEvent([
                    "reqId": reqId,
                    "ok": true,
                    "path": targetURL.standardizedFileURL.path,
                    "name": targetURL.lastPathComponent,
                ])
            } catch {
                emitWorkspaceEvent(["reqId": reqId, "ok": false, "error": error.localizedDescription])
            }
        default:
            emitWorkspaceEvent(["reqId": reqId, "ok": false, "error": "Unknown workspace action"])
        }
    }

    private func presentNativeSavePanel(suggestedFilename: String, data: Data, requestId: String) {
        let report: ([String: Any]) -> Void = { result in
            var payload = result
            payload["requestId"] = requestId
            self.webView.callAsyncJavaScript(
                "window.__formaSaveResult && window.__formaSaveResult(result);",
                arguments: ["result": payload], in: nil, in: .page
            ) { _ in }
        }
        let panel = NSSavePanel()
        panel.nameFieldStringValue = suggestedFilename
        panel.canCreateDirectories = true
        panel.isExtensionHidden = false

        let ext = (suggestedFilename as NSString).pathExtension
        if !ext.isEmpty, let ut = UTType(filenameExtension: ext) {
            panel.allowedContentTypes = [ut]
        }

        panel.beginSheetModal(for: window) { response in
            guard response == .OK, let targetURL = panel.url else { report(["cancelled": true]); return }
            DispatchQueue.global(qos: .userInitiated).async {
                do {
                    try data.write(to: targetURL, options: .atomic)
                    DispatchQueue.main.async {
                        self.fileGrants.rememberFile(targetURL)
                        report(["path": targetURL.standardizedFileURL.path])
                    }
                } catch {
                    let msg = error.localizedDescription
                    DispatchQueue.main.async {
                        report(["error": msg])
                        let alert = NSAlert()
                        alert.messageText = "Could not save file"
                        alert.informativeText = msg
                        alert.alertStyle = .warning
                        alert.runModal()
                    }
                }
            }
        }
    }

    // MARK: - WKUIDelegate

    func webView(
        _ webView: WKWebView,
        runOpenPanelWith parameters: WKOpenPanelParameters,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping ([URL]?) -> Void
    ) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = true
        panel.beginSheetModal(for: window) { response in
            completionHandler(response == .OK ? panel.urls : nil)
        }
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptAlertPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping () -> Void
    ) {
        let alert = NSAlert()
        alert.messageText = displayName
        alert.informativeText = message
        alert.addButton(withTitle: "OK")
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptConfirmPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping (Bool) -> Void
    ) {
        let alert = NSAlert()
        alert.messageText = displayName
        alert.informativeText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window) { resp in
            completionHandler(resp == .alertFirstButtonReturn)
        }
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptTextInputPanelWithPrompt prompt: String,
        defaultText: String?,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping (String?) -> Void
    ) {
        let alert = NSAlert()
        alert.messageText = prompt
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24))
        field.stringValue = defaultText ?? ""
        alert.accessoryView = field
        alert.window.initialFirstResponder = field
        alert.beginSheetModal(for: window) { resp in
            completionHandler(resp == .alertFirstButtonReturn ? field.stringValue : nil)
        }
    }
}

// MARK: - Multi-Window Application Delegate

@MainActor
final class FormaAppDelegate: NSObject, NSApplicationDelegate {
    private var controllers: [FormaWindowController] = []

    private var appKind: String {
        (Bundle.main.object(forInfoDictionaryKey: "FormaAppKind") as? String) ?? "sheets"
    }

    private var displayName: String {
        if let name = Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String {
            return name
        }
        switch appKind {
        case "docs": return "Forma Docs"
        case "slides": return "Forma Slides"
        case "lab": return "Forma Lab"
        case "pdf": return "Forma PDF"
        case "canvas": return "Forma Canvas"
        default: return "Forma Sheets"
        }
    }

    private var supportedExtensions: [String] {
        switch appKind {
        case "docs": return ["docx", "odt", "md", "markdown", "html", "htm"]
        case "slides": return ["pptx", "odp"]
        case "lab": return ["ipynb"]
        case "pdf": return ["pdf"]
        case "canvas": return ["fcanvas", "excalidraw"]
        default: return ["xlsx", "ods", "csv", "tsv"]
        }
    }

    private var activeController: FormaWindowController? {
        if let keyWin = NSApp.keyWindow {
            return controllers.first { $0.window === keyWin }
        }
        return controllers.last
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        setupMainMenu()
        if controllers.isEmpty {
            spawnWindow(initialFileId: nil)
        }
        NSApp.activate(ignoringOtherApps: true)
    }

    private var recentFilesMenu: NSMenu?

    private var recentDefaultsKey: String { "forma_recent_files_\(appKind)" }

    private func recordRecentURL(_ url: URL) {
        let path = url.standardizedFileURL.path
        var list = UserDefaults.standard.stringArray(forKey: recentDefaultsKey) ?? []
        list.removeAll { $0 == path }
        list.insert(path, at: 0)
        if list.count > 12 { list = Array(list.prefix(12)) }
        UserDefaults.standard.set(list, forKey: recentDefaultsKey)
        rebuildRecentFilesMenu()
    }

    private func rebuildRecentFilesMenu() {
        guard let menu = recentFilesMenu else { return }
        menu.removeAllItems()
        let list = UserDefaults.standard.stringArray(forKey: recentDefaultsKey) ?? []
        if list.isEmpty {
            let empty = NSMenuItem(title: "No Recent Files", action: nil, keyEquivalent: "")
            empty.isEnabled = false
            menu.addItem(empty)
        } else {
            for path in list {
                let url = URL(fileURLWithPath: path)
                let item = NSMenuItem(title: url.lastPathComponent, action: #selector(openRecentFileMenuAction(_:)), keyEquivalent: "")
                item.target = self
                item.representedObject = path
                item.toolTip = path
                menu.addItem(item)
            }
            menu.addItem(.separator())
            let clear = NSMenuItem(title: "Clear Menu", action: #selector(clearRecentFilesMenuAction(_:)), keyEquivalent: "")
            clear.target = self
            menu.addItem(clear)
        }
    }

    @objc private func openRecentFileMenuAction(_ sender: NSMenuItem) {
        guard let path = sender.representedObject as? String else { return }
        let url = URL(fileURLWithPath: path)
        guard FileManager.default.fileExists(atPath: path) else { return }
        let target = activeController ?? spawnWindow(initialFileId: nil)
        target.enqueueOpenURL(url)
        target.window.makeKeyAndOrderFront(nil)
    }

    @objc private func clearRecentFilesMenuAction(_ sender: Any?) {
        UserDefaults.standard.removeObject(forKey: recentDefaultsKey)
        rebuildRecentFilesMenu()
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        let mounted = controllers
        if mounted.isEmpty { return .terminateNow }
        let group = DispatchGroup()
        var allSaved = true
        for ctrl in mounted {
            group.enter()
            ctrl.flushForClose { ok in
                if !ok { allSaved = false }
                group.leave()
            }
        }
        group.notify(queue: .main) {
            if allSaved {
                sender.reply(toApplicationShouldTerminate: true)
            } else {
                let alert = NSAlert()
                alert.messageText = "Some changes could not be saved"
                alert.informativeText = "One or more open Forma windows failed to persist edits to local storage. Quit anyway?"
                alert.alertStyle = .warning
                alert.addButton(withTitle: "Cancel Quit")
                alert.addButton(withTitle: "Quit Anyway")
                let res = alert.runModal()
                sender.reply(toApplicationShouldTerminate: res == .alertSecondButtonReturn)
            }
        }
        return .terminateLater
    }

    func applicationWillTerminate(_ notification: Notification) {
        FormaSemanticBackend.shared.shutdown()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag {
            spawnWindow(initialFileId: nil)
        }
        return true
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        let target = activeController ?? spawnWindow(initialFileId: nil)
        for url in urls {
            recordRecentURL(url)
            target.enqueueOpenURL(url)
        }
        target.window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationDockMenu(_ sender: NSApplication) -> NSMenu? {
        let menu = NSMenu()
        if appKind == "pdf" {
            menu.addItem(withTitle: "Open PDF…", action: #selector(openFileMenuAction(_:)), keyEquivalent: "")
            menu.addItem(withTitle: "New Window (Start Hub)", action: #selector(newWindowMenuAction(_:)), keyEquivalent: "")
        } else {
            let newTitle: String
            switch appKind {
            case "docs": newTitle = "New Blank Document"
            case "slides": newTitle = "New Blank Presentation"
            case "lab": newTitle = "New Blank Notebook"
            case "canvas": newTitle = "New Blank Canvas"
            default: newTitle = "New Blank Workbook"
            }
            menu.addItem(withTitle: newTitle, action: #selector(newFileMenuAction(_:)), keyEquivalent: "")
            menu.addItem(withTitle: "New Window (Start Hub)", action: #selector(newWindowMenuAction(_:)), keyEquivalent: "")
            menu.addItem(.separator())
            menu.addItem(withTitle: "Open File…", action: #selector(openFileMenuAction(_:)), keyEquivalent: "")
            if appKind == "lab" {
                menu.addItem(withTitle: "Open Folder…", action: #selector(openFolderMenuAction(_:)), keyEquivalent: "")
            }
        }
        return menu
    }

    @discardableResult
    private func spawnWindow(initialFileId: String?) -> FormaWindowController {
        let offset = CGFloat(controllers.count % 6) * 28.0
        let ctrl = FormaWindowController(
            appKind: appKind,
            displayName: displayName,
            initialFileId: initialFileId,
            cascadeOffset: offset,
            onOpenNewWindow: { [weak self] fileId in
                self?.spawnWindow(initialFileId: fileId)
            },
            onRequestOpenDialog: { [weak self] targetCtrl in
                self?.presentOpenPanel(for: targetCtrl)
            },
            onClose: { [weak self] closed in
                self?.controllers.removeAll { $0 === closed }
            }
        )
        controllers.append(ctrl)
        return ctrl
    }

    private func presentOpenPanel(for ctrl: FormaWindowController) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false
        panel.canChooseFiles = true
        let types = supportedExtensions.compactMap { UTType(filenameExtension: $0) }
        if !types.isEmpty {
            panel.allowedContentTypes = types
        }
        panel.beginSheetModal(for: ctrl.window) { response in
            guard response == .OK else { return }
            for url in panel.urls {
                self.recordRecentURL(url)
                ctrl.enqueueOpenURL(url)
            }
        }
    }

    // MARK: - Menu Actions

    @objc private func newFileMenuAction(_ sender: Any?) {
        if appKind == "pdf" {
            // In PDF apps, New opens a fresh window / Open dialog rather than an empty "Untitled PDF"
            spawnWindow(initialFileId: nil)
            return
        }
        if let ctrl = activeController {
            ctrl.createNewBlankFile()
        } else {
            let ctrl = spawnWindow(initialFileId: nil)
            ctrl.createNewBlankFile()
        }
    }

    @objc private func newWindowMenuAction(_ sender: Any?) {
        spawnWindow(initialFileId: nil)
    }

    @objc private func showHubMenuAction(_ sender: Any?) {
        let ctrl = activeController ?? spawnWindow(initialFileId: nil)
        ctrl.showStartHub()
    }

    @objc private func openFileMenuAction(_ sender: Any?) {
        let ctrl = activeController ?? spawnWindow(initialFileId: nil)
        presentOpenPanel(for: ctrl)
    }

    @objc private func openFolderMenuAction(_ sender: Any?) {
        let ctrl = activeController ?? spawnWindow(initialFileId: nil)
        ctrl.openFolderWorkspace()
    }

    @objc private func closeTabOrWindowAction(_ sender: Any?) {
        activeController?.closeTabOrWindow()
    }

    @objc private func printMenuAction(_ sender: Any?) {
        activeController?.performNativePrint()
    }

    @objc private func saveMenuAction(_ sender: Any?) {
        activeController?.saveActiveDocument()
    }

    @objc private func zoomInMenuAction(_ sender: Any?) {
        activeController?.zoomIn()
    }

    @objc private func zoomOutMenuAction(_ sender: Any?) {
        activeController?.zoomOut()
    }

    @objc private func zoomResetMenuAction(_ sender: Any?) {
        activeController?.zoomReset()
    }

    @objc private func toggleReadingModeMenuAction(_ sender: Any?) {
        activeController?.toggleReadingMode()
    }

    // MARK: - Native macOS Menu Bar

    private func setupMainMenu() {
        let mainMenu = NSMenu()

        let appItem = NSMenuItem()
        mainMenu.addItem(appItem)
        let appMenu = NSMenu()
        appItem.submenu = appMenu
        appMenu.addItem(withTitle: "About \(displayName)", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide \(displayName)", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let hideOthers = appMenu.addItem(withTitle: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit \(displayName)", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")

        let fileItem = NSMenuItem()
        mainMenu.addItem(fileItem)
        let fileMenu = NSMenu(title: "File")
        fileItem.submenu = fileMenu
        if appKind == "pdf" {
            fileMenu.addItem(withTitle: "Open PDF…", action: #selector(openFileMenuAction(_:)), keyEquivalent: "o")
            fileMenu.addItem(withTitle: "New Window (Start Hub)", action: #selector(newWindowMenuAction(_:)), keyEquivalent: "n")
            let hubItem = fileMenu.addItem(withTitle: "Start Hub (Recent PDFs)", action: #selector(showHubMenuAction(_:)), keyEquivalent: "h")
            hubItem.keyEquivalentModifierMask = [.command, .shift]
        } else {
            let newTitle: String
            switch appKind {
            case "docs": newTitle = "New Blank Document"
            case "slides": newTitle = "New Blank Presentation"
            case "lab": newTitle = "New Blank Notebook"
            case "canvas": newTitle = "New Blank Canvas"
            default: newTitle = "New Blank Workbook"
            }
            fileMenu.addItem(withTitle: newTitle, action: #selector(newFileMenuAction(_:)), keyEquivalent: "n")
            let newWinItem = fileMenu.addItem(withTitle: "New Window", action: #selector(newWindowMenuAction(_:)), keyEquivalent: "n")
            newWinItem.keyEquivalentModifierMask = [.command, .shift]
            let hubItem = fileMenu.addItem(withTitle: "Start Hub (Templates & Recent)", action: #selector(showHubMenuAction(_:)), keyEquivalent: "h")
            hubItem.keyEquivalentModifierMask = [.command, .shift]
            fileMenu.addItem(.separator())
            fileMenu.addItem(withTitle: "Open…", action: #selector(openFileMenuAction(_:)), keyEquivalent: "o")
            if appKind == "lab" || appKind == "docs" {
                let openFolderItem = fileMenu.addItem(withTitle: "Open Folder…", action: #selector(openFolderMenuAction(_:)), keyEquivalent: "o")
                openFolderItem.keyEquivalentModifierMask = [.command, .shift]
            }
        }
        let recentItem = NSMenuItem(title: "Open Recent", action: nil, keyEquivalent: "")
        let recentSub = NSMenu(title: "Open Recent")
        recentItem.submenu = recentSub
        fileMenu.addItem(recentItem)
        self.recentFilesMenu = recentSub
        rebuildRecentFilesMenu()
        fileMenu.addItem(.separator())
        fileMenu.addItem(withTitle: "Save…", action: #selector(saveMenuAction(_:)), keyEquivalent: "s")
        fileMenu.addItem(withTitle: "Print / Save as PDF…", action: #selector(printMenuAction(_:)), keyEquivalent: "p")
        fileMenu.addItem(.separator())
        fileMenu.addItem(withTitle: "Close Tab / Window", action: #selector(closeTabOrWindowAction(_:)), keyEquivalent: "w")

        let editItem = NSMenuItem()
        mainMenu.addItem(editItem)
        let editMenu = NSMenu(title: "Edit")
        editItem.submenu = editMenu
        editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")

        let viewItem = NSMenuItem()
        mainMenu.addItem(viewItem)
        let viewMenu = NSMenu(title: "View")
        viewItem.submenu = viewMenu
        viewMenu.addItem(withTitle: "Zoom In", action: #selector(zoomInMenuAction(_:)), keyEquivalent: "=")
        viewMenu.addItem(withTitle: "Zoom Out", action: #selector(zoomOutMenuAction(_:)), keyEquivalent: "-")
        viewMenu.addItem(withTitle: "Actual Size", action: #selector(zoomResetMenuAction(_:)), keyEquivalent: "0")
        if appKind == "pdf" {
            viewMenu.addItem(.separator())
            viewMenu.addItem(withTitle: "Reading Mode", action: #selector(toggleReadingModeMenuAction(_:)), keyEquivalent: "\\")
        } else if appKind == "docs" || appKind == "lab" {
            viewMenu.addItem(.separator())
            viewMenu.addItem(withTitle: "Toggle Sidebar", action: #selector(toggleReadingModeMenuAction(_:)), keyEquivalent: "\\")
        }
        viewMenu.addItem(.separator())
        let fsItem = viewMenu.addItem(withTitle: "Enter Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        fsItem.keyEquivalentModifierMask = [.command, .control]

        let winItem = NSMenuItem()
        mainMenu.addItem(winItem)
        let winMenu = NSMenu(title: "Window")
        winItem.submenu = winMenu
        winMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        winMenu.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")

        NSApp.mainMenu = mainMenu
        NSApp.windowsMenu = winMenu
    }
}

// MARK: - Entry Point

@main
struct FormaAppMain {
    @MainActor
    static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.regular)
        let delegate = FormaAppDelegate()
        app.delegate = delegate
        app.run()
    }
}
