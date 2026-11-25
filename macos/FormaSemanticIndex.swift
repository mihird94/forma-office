import Foundation
import Accelerate
import Darwin
import SQLite3
import CryptoKit
import PDFKit
import Vision
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

private let SQLITE_TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

private final class FormaModelSessionDelegate: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

// MARK: - Data Models

private struct DocumentChunk: Sendable {
    let index: Int
    let sectionLabel: String
    let text: String
    let imageBase64: String?

    init(index: Int, sectionLabel: String, text: String, imageBase64: String? = nil) {
        self.index = index
        self.sectionLabel = sectionLabel
        self.text = text
        self.imageBase64 = imageBase64
    }
}

private struct CachedVectorMatrix: @unchecked Sendable {
    let versionKey: String
    let dims: Int
    let rowCount: Int
    let chunkIds: [Int64]
    let docIds: [String]
    let matrix: [Float]
}

private struct OllamaDiscovery: Sendable {
    let online: Bool
    let embedModel: String
    let chatModels: [String]
    let activeChatModel: String
}

struct FormaIndexChange: Sendable {
    let path: String
    let includesDescendants: Bool
}

final class FormaIndexCancellation: @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled = false

    var isCancelled: Bool { lock.withLock { cancelled } }

    func cancel() { lock.withLock { cancelled = true } }
}

// MARK: - Forma Local Semantic Index & Ollama AI + Vision OCR Backend

final class FormaSemanticBackend: @unchecked Sendable {
    static let shared = FormaSemanticBackend()

    private let dbURL: URL
    private let ollamaBaseURL: String
    private let embeddedSocket: URL
    private let formaSupportDir: URL
    private let configStore: FormaIndexConfigStore
    private let allowOllamaFallback: Bool
    private let indexQueue = DispatchQueue(label: "com.formaoffice.semantic.index", qos: .utility)
    private let searchQueue = DispatchQueue(label: "com.formaoffice.semantic.search", qos: .userInitiated, attributes: .concurrent)
    private let chatQueue = DispatchQueue(label: "com.formaoffice.semantic.chat", qos: .userInitiated, attributes: .concurrent)
    private let ocrQueue = DispatchQueue(label: "com.formaoffice.semantic.ocr", qos: .userInitiated)
    private let session: URLSession
    private let databaseReady = DispatchGroup()
    private let queryVectorLock = NSLock()
    private var queryVectors: [String: [Float]] = [:]

    private var db: OpaquePointer?
    private let localWriteLock = NSLock()
    private var localWriteGeneration: Int64 = 0
    private let vectorCacheLock = NSLock()
    private var vectorMatrixCache: [String: CachedVectorMatrix] = [:]

    private let rerankSocket: URL
    private let runtimeLock = NSLock()
    private var runtimeStopping = false
    private var embeddedProcess: Process?
    private var embeddedLastUse: Date?
    private var embeddedIdleTimer: DispatchSourceTimer?
    private var rerankProcess: Process?
    private var rerankLastUse: Date?
    private var rerankIdleTimer: DispatchSourceTimer?

    private static let embeddedModelName = "embeddinggemma-2 (built-in)"
    private static let embeddedModelFile = "embeddinggemma-2-Q8_0.gguf"
    private static let embeddedMmprojFile = "mmproj-embeddinggemma-2-Q8_0.gguf"
    private static let rerankModelCandidates: [(file: String, name: String)] = [
        ("jina-reranker-v1-turbo-en-Q8_0.gguf", "jina-reranker-v1-turbo-en"),
        ("bge-reranker-v2-m3-Q4_K_M.gguf", "bge-reranker-v2-m3"),
    ]
    private static let defaultEmbedModel = "embeddinggemma-2"
    private static let preferredEmbedModels = [
        "embeddinggemma-2",
        "embeddinggemma",
        "qwen3-embedding:0.6b",
    ]
    private static let preferredChatModels = [
        "qwen3.5:9b",
        "qwen3:8b",
        "qwen2.5-coder:7b",
    ]

    static func isMultimodalEmbedModel(_ model: String) -> Bool {
        let lower = model.lowercased()
        return lower.contains("embeddinggemma-2") || lower.contains("embeddinggemma2")
    }

    init(
        dbURL: URL? = nil,
        ollamaBaseURL: String? = nil,
        embeddedPort: Int? = nil,
        allowOllamaFallback: Bool = true
    ) {
        let environment = ProcessInfo.processInfo.environment
        let defaultSupport = FormaIndexConfigStore.defaultSupportDirectory
        self.formaSupportDir = environment["FORMA_INDEX_RUNTIME_DIR"].map { URL(fileURLWithPath: $0) } ?? defaultSupport
        let stateDirectory = FormaIndexConfigStore.stateDirectory
        self.configStore = FormaIndexConfigStore(directory: stateDirectory)
        self.dbURL = dbURL ?? stateDirectory.appendingPathComponent("semantic_index.sqlite")
        let localOllama = "http://127.0.0.1:11434"
        let requestedOllama = ollamaBaseURL ?? environment["OLLAMA_HOST"] ?? localOllama
        if let url = URLComponents(string: requestedOllama), let scheme = url.scheme, ["http", "https"].contains(scheme),
           let host = url.host, ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host.lowercased()),
           url.user == nil, url.password == nil, url.query == nil, url.fragment == nil, ["", "/"].contains(url.path) {
            self.ollamaBaseURL = url.path == "/" ? String(requestedOllama.dropLast()) : requestedOllama
        } else {
            self.ollamaBaseURL = localOllama
        }
        let port = embeddedPort ?? environment["FORMA_INDEX_EMBED_PORT"].flatMap(Int.init) ?? 18434
        let slot = (1...65_535).contains(port) ? port : 18434
        // macOS limits Unix socket paths to a little over 100 bytes, including in long home paths.
        self.embeddedSocket = URL(fileURLWithPath: "/private/tmp/forma-embed-\(geteuid())/\(slot).sock")
        self.rerankSocket = URL(fileURLWithPath: "/private/tmp/forma-rerank-\(geteuid())/\(slot).sock")
        self.allowOllamaFallback = allowOllamaFallback

        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 30
        config.timeoutIntervalForResource = 120
        config.connectionProxyDictionary = [:]
        config.httpShouldSetCookies = false
        config.urlCredentialStorage = nil
        self.session = URLSession(configuration: config, delegate: FormaModelSessionDelegate(), delegateQueue: nil)

        databaseReady.enter()
        indexQueue.async {
            self.openDatabaseIfNeeded()
            self.databaseReady.leave()
        }
    }

    deinit {
        shutdownEmbeddedSync()
        shutdownRerankSync()
        if let handle = db { sqlite3_close(handle) }
    }

    func shutdown() {
        runtimeLock.withLock { runtimeStopping = true }
        shutdownEmbeddedSync()
        shutdownRerankSync()
    }

    func permitsIndexedFile(_ path: String) -> Bool {
        guard let config = try? configStore.loadIndexConfig(),
              config.watchedFolders.contains(where: { FormaIndexConfig.contains(path, in: $0) }),
              let reader = openReadDatabase() else { return false }
        defer { sqlite3_close(reader) }
        var found = false
        let ok = select(reader, "SELECT 1 FROM docs WHERE path = ? AND source = 'folder' LIMIT 1;", bind: {
            sqlite3_bind_text($0, 1, path, -1, SQLITE_TRANSIENT)
        }, row: { _ in found = true })
        return ok && found
    }

    func refreshWatchedFolders(
        changes: [FormaIndexChange]?, cancellation: FormaIndexCancellation,
        reply: @escaping @Sendable ([String: Any]) -> Void
    ) {
        indexQueue.async {
            reply(self.syncWatchedFoldersSync(force: false, changes: changes, cancellation: cancellation))
        }
    }

    // MARK: - Single Message Dispatchers

    func handleAIRequest(_ body: [String: Any], reply: @escaping @Sendable ([String: Any]) -> Void) {
        let reqId = body["reqId"] as? String ?? ""
        let action = body["action"] as? String ?? ""

        let respond: @Sendable ([String: Any]) -> Void = { payload in
            var out = payload
            if !reqId.isEmpty {
                out["reqId"] = reqId
            }
            reply(out)
        }

        switch action {
        case "status", "listModels":
            searchQueue.async { [weak self] in
                guard let self else {
                    respond(["ok": false, "error": "Backend unavailable"])
                    return
                }
                var status = self.getStatusSync()
                status["ok"] = true
                respond(status)
            }

        case "indexDocument":
            let docId = body["docId"] as? String ?? ""
            let kind = body["kind"] as? String ?? "document"
            let title = body["title"] as? String ?? "Untitled"
            let path = body["path"] as? String ?? ""
            let text = body["text"] as? String ?? ""
            let rawImages = body["images"] as? [[String: Any]] ?? []
            let images: [VisualIndexInput] = rawImages.prefix(8).compactMap { item in
                guard let rawB64 = item["base64"] as? String else { return nil }
                let cleanB64: String
                if let comma = rawB64.range(of: ",") {
                    cleanB64 = String(rawB64[comma.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
                } else {
                    cleanB64 = rawB64.trimmingCharacters(in: .whitespacesAndNewlines)
                }
                guard !cleanB64.isEmpty, cleanB64.count <= 6_000_000 else { return nil }
                let section = (item["sectionLabel"] as? String ?? "Image").trimmingCharacters(in: .whitespacesAndNewlines)
                let caption = (item["caption"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                return VisualIndexInput(sectionLabel: section.isEmpty ? "Image" : section, caption: caption, base64: cleanB64)
            }

            guard !docId.isEmpty else {
                respond(["ok": false, "error": "Missing docId"])
                return
            }

            indexQueue.async { [weak self] in
                guard let self else {
                    respond(["ok": false, "error": "Backend unavailable"])
                    return
                }
                let result = self.indexDocumentSync(
                    docId: docId,
                    kind: kind,
                    title: title,
                    path: path,
                    text: text,
                    images: images
                )
                respond(result)
            }

        case "removeDocument":
            let docId = body["docId"] as? String ?? ""
            guard !docId.isEmpty else {
                respond(["ok": false, "error": "Missing docId"])
                return
            }
            indexQueue.async { [weak self] in
                guard let self else {
                    respond(["ok": false, "error": "Backend unavailable"])
                    return
                }
                let removed = self.removeDocumentSync(docId: docId)
                respond(["ok": removed, "docId": docId])
            }

        case "semanticSearch":
            let query = body["query"] as? String ?? ""
            let kindFilter = body["kindFilter"] as? String ?? (body["kind"] as? String)
            let limit = body["limit"] as? Int ?? 12
            let lexicalOnly = body["lexicalOnly"] as? Bool ?? false

            searchQueue.async { [weak self] in
                guard let self else {
                    respond(["ok": false, "hits": [], "error": "Backend unavailable"])
                    return
                }
                let hits = self.semanticSearchSync(query: query, kindFilter: kindFilter, limit: max(1, min(limit, 50)), lexicalOnly: lexicalOnly)
                respond(["ok": true, "hits": hits])
            }

        case "indexFolder", "indexPath":
            let path = body["path"] as? String ?? body["folderPath"] as? String ?? ""
            let force = body["force"] as? Bool ?? false
            indexQueue.async {
                respond(self.indexPathSync(path, force: force))
            }

        case "getIndexConfig":
            searchQueue.async {
                respond(self.indexConfigResponse())
            }

        case "addWatchedFolder", "removeWatchedFolder", "toggleIndexImages":
            let path = body["path"] as? String ?? ""
            let enabled = body["enabled"] as? Bool ?? false
            let syncAfterAdd = body["syncAfterAdd"] as? Bool ?? true
            indexQueue.async {
                do {
                    switch action {
                    case "addWatchedFolder":
                        _ = try self.configStore.addWatchedFolder(path)
                    case "removeWatchedFolder":
                        guard !path.isEmpty else {
                            respond(["ok": false, "error": "Missing folder path"])
                            return
                        }
                        _ = try self.configStore.removeWatchedFolder(path)
                        _ = try self.pruneUnwatchedFiles()
                    default:
                        _ = try self.configStore.update { $0.includeStandaloneImages = enabled }
                        if !enabled { _ = try self.pruneUnwatchedFiles() }
                    }
                    respond(self.indexConfigResponse())
                    if action == "addWatchedFolder", syncAfterAdd, !self.configStore.isWatcherRunning,
                       let root = FormaIndexConfig.existingDirectory(path) {
                        _ = self.syncWatchedFoldersSync(
                            force: false, changes: [FormaIndexChange(path: root, includesDescendants: true)]
                        )
                    }
                } catch {
                    respond(["ok": false, "error": error.localizedDescription])
                }
            }

        case "syncWatchedFolders":
            let force = body["force"] as? Bool ?? false
            indexQueue.async {
                respond(self.syncWatchedFoldersSync(force: force))
            }

        case "readDocument":
            let target = body["target"] as? String ?? ""
            let maxChars = max(1, min(body["maxChars"] as? Int ?? 12_000, 250_000))
            let ocr = body["ocr"] as? Bool ?? false
            searchQueue.async {
                respond(self.readDocumentSync(target: target, maxChars: maxChars, ocr: ocr))
            }

        case "chat":
            let requestedModel = body["model"] as? String
            let rawMessages = body["messages"] as? [[String: Any]] ?? []
            let cleanMessages: [(role: String, content: String)] = rawMessages.compactMap { msg in
                guard let role = msg["role"] as? String,
                      let content = msg["content"] as? String else { return nil }
                return (role: role, content: content)
            }
            guard !cleanMessages.isEmpty else {
                respond(["ok": false, "error": "Missing chat messages"])
                return
            }

            chatQueue.async { [weak self] in
                guard let self else {
                    respond(["ok": false, "error": "Backend unavailable"])
                    return
                }
                let result = self.chatSync(messages: cleanMessages, requestedModel: requestedModel)
                respond(result)
            }

        default:
            respond(["ok": false, "error": "Unknown AI action: \(action)"])
        }
    }

    func handleOcrRequest(_ body: [String: Any], reply: @escaping @Sendable ([String: Any]) -> Void) {
        let reqId = body["reqId"] as? String ?? ""
        let path = body["path"] as? String
        let pageIndex = body["pageIndex"] as? Int ?? 0
        let base64Pdf = body["base64Pdf"] as? String

        ocrQueue.async { [weak self] in
            var result: [String: Any]
            if let self {
                result = self.ocrPdfPageSync(path: path, pageIndex: pageIndex, base64Pdf: base64Pdf)
            } else {
                result = ["ok": false, "pageIndex": pageIndex, "text": "", "lines": [], "error": "Backend unavailable"]
            }
            if !reqId.isEmpty {
                result["reqId"] = reqId
            }
            reply(result)
        }
    }

    // MARK: - Public Direct APIs

    func getStatus(completion: @escaping @Sendable ([String: Any]) -> Void) {
        searchQueue.async { [weak self] in
            completion(self?.getStatusSync() ?? [
                "ollamaOnline": false,
                "embedModel": Self.defaultEmbedModel,
                "chatModels": [],
                "indexedDocs": 0,
                "indexedChunks": 0,
            ])
        }
    }

    func indexDocument(
        docId: String,
        kind: String,
        title: String,
        path: String,
        text: String,
        images: [VisualIndexInput] = [],
        completion: (@Sendable ([String: Any]) -> Void)? = nil
    ) {
        indexQueue.async { [weak self] in
            let res = self?.indexDocumentSync(docId: docId, kind: kind, title: title, path: path, text: text, images: images)
                ?? ["ok": false, "error": "Backend unavailable"]
            completion?(res)
        }
    }

    func removeDocument(docId: String, completion: (@Sendable () -> Void)? = nil) {
        indexQueue.async { [weak self] in
            self?.removeDocumentSync(docId: docId)
            completion?()
        }
    }

    func semanticSearch(
        query: String,
        kindFilter: String? = nil,
        limit: Int = 12,
        completion: @escaping @Sendable ([[String: Any]]) -> Void
    ) {
        searchQueue.async { [weak self] in
            let hits = self?.semanticSearchSync(query: query, kindFilter: kindFilter, limit: limit) ?? []
            completion(hits)
        }
    }

    func indexFolder(folderPath: String, completion: @escaping @Sendable ([String: Any]) -> Void) {
        indexQueue.async { [weak self] in
            let res = self?.indexPathSync(folderPath, force: false) ?? ["ok": false, "error": "Backend unavailable"]
            completion(res)
        }
    }

    func ocrPdfPage(
        path: String?,
        pageIndex: Int,
        base64Pdf: String? = nil,
        completion: @escaping @Sendable ([String: Any]) -> Void
    ) {
        ocrQueue.async { [weak self] in
            let res = self?.ocrPdfPageSync(path: path, pageIndex: pageIndex, base64Pdf: base64Pdf)
                ?? ["ok": false, "pageIndex": pageIndex, "text": "", "lines": [], "error": "Backend unavailable"]
            completion(res)
        }
    }

    // MARK: - SQLite Management

    private func openDatabaseIfNeeded() {
        guard db == nil else { return }
        do {
            try ensureFormaPrivateDirectory(dbURL.deletingLastPathComponent())
            Darwin.close(try openFormaPrivateFile(dbURL))
        } catch { return }
        var handle: OpaquePointer?
        let flags = SQLITE_OPEN_CREATE | SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX
        guard sqlite3_open_v2(dbURL.path, &handle, flags, nil) == SQLITE_OK, let handle else {
            sqlite3_close(handle)
            return
        }
        db = handle
        sqlite3_busy_timeout(handle, 5000)
        // Completed migrations make opening another CLI reader independent of the writer lock.
        let initialized = executeSQL("PRAGMA journal_mode=WAL;") && executeSQL("PRAGMA synchronous=NORMAL;")
            && (databaseVersion(handle) >= 3 || writeTransaction {
                if databaseVersion(handle) < 2 {
                    guard executeSQL("""
                        CREATE TABLE IF NOT EXISTS docs (
                            doc_id TEXT PRIMARY KEY,
                            kind TEXT NOT NULL,
                            title TEXT NOT NULL,
                            path TEXT NOT NULL DEFAULT '',
                            content_hash TEXT NOT NULL DEFAULT '',
                            updated_at REAL NOT NULL DEFAULT 0,
                            embed_model TEXT NOT NULL DEFAULT '',
                            file_mtime REAL NOT NULL DEFAULT 0,
                            file_size INTEGER NOT NULL DEFAULT 0,
                            source TEXT NOT NULL DEFAULT 'workspace'
                        );
                        CREATE TABLE IF NOT EXISTS chunks (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            doc_id TEXT NOT NULL,
                            chunk_idx INTEGER NOT NULL,
                            section_label TEXT NOT NULL DEFAULT '',
                            text TEXT NOT NULL,
                            embedding BLOB,
                            embedding_q8 BLOB
                        );
                        CREATE INDEX IF NOT EXISTS idx_chunks_doc_id ON chunks(doc_id);
                        CREATE INDEX IF NOT EXISTS idx_docs_path ON docs(path);
                        """) else { return false }
                    var columns = Set<String>()
                    guard select(handle, "PRAGMA table_info(docs);", row: { columns.insert(columnText($0, 1)) }) else {
                        return false
                    }
                    for (name, definition) in [
                        ("file_mtime", "REAL NOT NULL DEFAULT 0"),
                        ("file_size", "INTEGER NOT NULL DEFAULT 0"),
                        ("source", "TEXT NOT NULL DEFAULT 'workspace'"),
                    ] where !columns.contains(name) {
                        if !executeSQL("ALTER TABLE docs ADD COLUMN \(name) \(definition);") { return false }
                    }
                    if !columns.contains("source"),
                       !executeSQL("UPDATE docs SET source = 'folder' WHERE doc_id LIKE 'file:%' AND path != '';") {
                        return false
                    }
                    guard createSearchIndex() else { return false }
                }
                if databaseVersion(handle) < 3 {
                    var chunkColumns = Set<String>()
                    guard select(handle, "PRAGMA table_info(chunks);", row: { chunkColumns.insert(columnText($0, 1)) }) else {
                        return false
                    }
                    if !chunkColumns.contains("embedding_q8") {
                        if !executeSQL("ALTER TABLE chunks ADD COLUMN embedding_q8 BLOB;") { return false }
                    }
                    var toBackfill: [(id: Int64, blob: Data)] = []
                    _ = select(handle, "SELECT id, embedding FROM chunks WHERE embedding IS NOT NULL AND embedding_q8 IS NULL;") { stmt in
                        guard let raw = sqlite3_column_blob(stmt, 1) else { return }
                        let count = Int(sqlite3_column_bytes(stmt, 1)) / MemoryLayout<Float>.stride
                        guard count > 0 else { return }
                        var floats = [Float](repeating: 0, count: count)
                        floats.withUnsafeMutableBytes { dst in
                            if let base = dst.baseAddress { memcpy(base, raw, count * MemoryLayout<Float>.stride) }
                        }
                        let normalized = Self.l2Normalize(floats)
                        toBackfill.append((sqlite3_column_int64(stmt, 0), Self.encodeInt8Normalized(normalized)))
                    }
                    if !toBackfill.isEmpty {
                        var stmt: OpaquePointer?
                        defer { sqlite3_finalize(stmt) }
                        guard sqlite3_prepare_v2(handle, "UPDATE chunks SET embedding_q8 = ? WHERE id = ?;", -1, &stmt, nil) == SQLITE_OK, let stmt else {
                            return false
                        }
                        for row in toBackfill {
                            sqlite3_reset(stmt)
                            _ = row.blob.withUnsafeBytes { bytes in
                                sqlite3_bind_blob(stmt, 1, bytes.baseAddress, Int32(row.blob.count), SQLITE_TRANSIENT)
                            }
                            sqlite3_bind_int64(stmt, 2, row.id)
                            if sqlite3_step(stmt) != SQLITE_DONE { return false }
                        }
                    }
                    if !executeSQL("PRAGMA user_version = 3;") { return false }
                }
                return true
            })
        if !initialized {
            sqlite3_close(handle)
            db = nil
        }
    }

    private func databaseVersion(_ handle: OpaquePointer) -> Int32 {
        var version: Int32 = 0
        _ = select(handle, "PRAGMA user_version;") { version = sqlite3_column_int($0, 0) }
        return version
    }

    private func createSearchIndex() -> Bool {
        executeSQL("""
            CREATE INDEX IF NOT EXISTS idx_docs_embed_kind ON docs(embed_model, kind);
            CREATE VIRTUAL TABLE IF NOT EXISTS chunk_search USING fts5(
                title, section_label, text,
                tokenize = 'unicode61 remove_diacritics 2 tokenchars ''_''',
                prefix = '2 3'
            );
            CREATE TRIGGER IF NOT EXISTS chunk_search_insert AFTER INSERT ON chunks BEGIN
                INSERT INTO chunk_search(rowid, title, section_label, text)
                SELECT new.id, title, new.section_label, new.text FROM docs WHERE doc_id = new.doc_id;
            END;
            CREATE TRIGGER IF NOT EXISTS chunk_search_delete AFTER DELETE ON chunks BEGIN
                DELETE FROM chunk_search WHERE rowid = old.id;
            END;
            INSERT OR REPLACE INTO chunk_search(rowid, title, section_label, text)
            SELECT c.id, d.title, c.section_label, c.text FROM chunks c JOIN docs d ON c.doc_id = d.doc_id;
            PRAGMA user_version = 2;
            """)
    }

    private func openReadDatabase() -> OpaquePointer? {
        databaseReady.wait()
        var handle: OpaquePointer?
        guard sqlite3_open_v2(dbURL.path, &handle, SQLITE_OPEN_READONLY | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK else {
            sqlite3_close(handle)
            return nil
        }
        sqlite3_busy_timeout(handle, 5000)
        return handle
    }

    @discardableResult
    private func executeSQL(_ sql: String) -> Bool {
        guard let db else { return false }
        return sqlite3_exec(db, sql, nil, nil, nil) == SQLITE_OK
    }

    private func writeTransaction(_ work: () -> Bool) -> Bool {
        guard executeSQL("BEGIN IMMEDIATE;") else { return false }
        if work() && executeSQL("COMMIT;") {
            localWriteLock.withLock { localWriteGeneration &+= 1 }
            return true
        }
        executeSQL("ROLLBACK;")
        return false
    }

    private func select(
        _ handle: OpaquePointer,
        _ sql: String,
        bind: (OpaquePointer) -> Void = { _ in },
        row: (OpaquePointer) -> Void
    ) -> Bool {
        var prepared: OpaquePointer?
        defer { sqlite3_finalize(prepared) }
        guard sqlite3_prepare_v2(handle, sql, -1, &prepared, nil) == SQLITE_OK, let stmt = prepared else { return false }
        bind(stmt)
        while true {
            switch sqlite3_step(stmt) {
            case SQLITE_ROW: row(stmt)
            case SQLITE_DONE: return true
            default: return false
            }
        }
    }

    private func columnText(_ stmt: OpaquePointer, _ index: Int32) -> String {
        sqlite3_column_text(stmt, index).map { String(cString: $0) } ?? ""
    }

    private func runStatement(_ handle: OpaquePointer, _ sql: String, bind: (OpaquePointer) -> Void) -> Bool {
        var prepared: OpaquePointer?
        defer { sqlite3_finalize(prepared) }
        guard sqlite3_prepare_v2(handle, sql, -1, &prepared, nil) == SQLITE_OK, let stmt = prepared else { return false }
        bind(stmt)
        return sqlite3_step(stmt) == SQLITE_DONE
    }

    private func queryCounts() -> (docs: Int, chunks: Int) {
        guard let reader = openReadDatabase() else { return (0, 0) }
        defer { sqlite3_close(reader) }
        var result = (0, 0)
        _ = select(reader, "SELECT (SELECT COUNT(*) FROM docs), (SELECT COUNT(*) FROM chunks);") {
            result = (Int(sqlite3_column_int64($0, 0)), Int(sqlite3_column_int64($0, 1)))
        }
        return result
    }

    private func existingDocMeta(docId: String) -> (hash: String, embedModel: String, unembeddedCount: Int, chunkCount: Int)? {
        openDatabaseIfNeeded()
        guard let db else { return nil }

        var hash = ""
        var embedModel = ""
        var found = false

        var stmt: OpaquePointer?
        let sql = "SELECT content_hash, embed_model FROM docs WHERE doc_id = ? LIMIT 1;"
        if sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK {
            sqlite3_bind_text(stmt, 1, docId, -1, SQLITE_TRANSIENT)
            if sqlite3_step(stmt) == SQLITE_ROW {
                found = true
                if let cHash = sqlite3_column_text(stmt, 0) {
                    hash = String(cString: cHash)
                }
                if let cModel = sqlite3_column_text(stmt, 1) {
                    embedModel = String(cString: cModel)
                }
            }
        }
        sqlite3_finalize(stmt)
        guard found else { return nil }

        var totalChunks = 0
        var nullEmbeddings = 0
        stmt = nil
        let countSql = "SELECT COUNT(*), SUM(CASE WHEN embedding IS NULL THEN 1 ELSE 0 END) FROM chunks WHERE doc_id = ?;"
        if sqlite3_prepare_v2(db, countSql, -1, &stmt, nil) == SQLITE_OK {
            sqlite3_bind_text(stmt, 1, docId, -1, SQLITE_TRANSIENT)
            if sqlite3_step(stmt) == SQLITE_ROW {
                totalChunks = Int(sqlite3_column_int64(stmt, 0))
                nullEmbeddings = Int(sqlite3_column_int64(stmt, 1))
            }
        }
        sqlite3_finalize(stmt)

        return (hash, embedModel, nullEmbeddings, totalChunks)
    }

    private struct ActiveEmbedEngine: Sendable {
        let online: Bool
        let backend: String   // "forma-embedded" | "ollama" | "lexical"
        let embedModel: String
        let multimodal: Bool
    }

    private func resolveEmbeddedPaths() -> (binURL: URL, modelURL: URL, mmprojURL: URL?)? {
        let fm = FileManager.default
        let binCandidates: [URL] = [
            formaSupportDir.appendingPathComponent("bin/llama-server"),
            Bundle.main.resourceURL?.appendingPathComponent("bin/llama-server"),
            URL(fileURLWithPath: "/opt/homebrew/bin/llama-server"),
            URL(fileURLWithPath: "/usr/local/bin/llama-server"),
        ].compactMap { $0 }

        guard let binURL = binCandidates.first(where: { fm.isExecutableFile(atPath: $0.path) }) else {
            return nil
        }

        let modelsDir = formaSupportDir.appendingPathComponent("models", isDirectory: true)
        let modelURL = modelsDir.appendingPathComponent(Self.embeddedModelFile)
        guard fm.fileExists(atPath: modelURL.path) else {
            return nil
        }

        let mmprojCandidate = modelsDir.appendingPathComponent(Self.embeddedMmprojFile)
        let mmprojURL = fm.fileExists(atPath: mmprojCandidate.path) ? mmprojCandidate : nil
        return (binURL, modelURL, mmprojURL)
    }

    private func probeEmbeddedPropsSync(timeout: TimeInterval = 1.0) -> (ready: Bool, hasVision: Bool, mediaMarker: String?) {
        guard embeddedResponse("/health", timeout: timeout) != nil,
              let data = embeddedResponse("/props", timeout: timeout),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return (false, false, nil)
        }
        let modalities = json["modalities"] as? [String: Any]
        let hasVision = (modalities?["vision"] as? Bool) ?? false
        let marker = json["media_marker"] as? String
        return (true, hasVision, marker)
    }

    private typealias EmbeddedState = (ready: Bool, hasVision: Bool, mediaMarker: String?)
    private var runtimeLockURL: URL {
        embeddedSocket.deletingPathExtension().appendingPathExtension("lock")
    }

    private func isOwnedEmbeddingSocket() -> Bool {
        var info = stat()
        return lstat(embeddedSocket.path, &info) == 0 && info.st_uid == geteuid() && info.st_mode & S_IFMT == S_IFSOCK
    }

    private func embeddedResponse(_ endpoint: String, body: Data? = nil, timeout: TimeInterval) -> Data? {
        guard (try? ensureFormaPrivateDirectory(embeddedSocket.deletingLastPathComponent())) != nil,
              isOwnedEmbeddingSocket() else { return nil }
        var bytes: UnsafeMutableRawPointer?
        var length = 0
        let url = "http://localhost" + endpoint
        let milliseconds = Int(timeout * 1_000)
        let status = if let body {
            body.withUnsafeBytes {
                forma_socket_http(embeddedSocket.path, url, $0.baseAddress, $0.count, milliseconds, &bytes, &length)
            }
        } else {
            forma_socket_http(embeddedSocket.path, url, nil, 0, milliseconds, &bytes, &length)
        }
        guard let bytes else { return nil }
        guard status == 200 else { free(bytes); return nil }
        return Data(bytesNoCopy: bytes, count: length, deallocator: .free)
    }

    private func resetEmbeddedIdleTimer() {
        embeddedLastUse = Date()
        embeddedIdleTimer?.cancel()
        embeddedIdleTimer = nil
        guard embeddedProcess != nil else { return }
        let timer = DispatchSource.makeTimerSource(queue: indexQueue)
        timer.schedule(deadline: .now() + 30)
        timer.setEventHandler { [weak self] in self?.shutdownEmbeddedSync(onlyIfIdle: true) }
        timer.resume()
        embeddedIdleTimer = timer
    }

    private func shutdownEmbeddedSync(onlyIfIdle: Bool = false) {
        guard runtimeLock.withLock({ embeddedProcess != nil }) else { return }
        _ = try? withFormaFileLock(runtimeLockURL) {
            runtimeLock.lock()
            defer { runtimeLock.unlock() }
            if onlyIfIdle, let lastUse = embeddedLastUse, Date().timeIntervalSince(lastUse) < 29 { return }
            embeddedIdleTimer?.cancel()
            embeddedIdleTimer = nil
            if let process = embeddedProcess, process.isRunning {
                process.terminate()
                process.waitUntilExit()
            }
            embeddedProcess = nil
            if isOwnedEmbeddingSocket() { _ = unlink(embeddedSocket.path) }
        }
    }

    private func ensureEmbeddedRunningSync() -> EmbeddedState {
        // 1. Check if a shared Forma embedded llama-server is already running (from this or another Forma app)
        let existing = probeEmbeddedPropsSync(timeout: 0.6)
        if existing.ready {
            return existing
        }

        // 2. Otherwise lazily spawn our self-contained arm64 Metal llama-server
        guard let paths = resolveEmbeddedPaths() else {
            return (false, false, nil)
        }

        // Clean up any dead process handle
        if let old = embeddedProcess, !old.isRunning {
            embeddedProcess = nil
        }

        if embeddedProcess == nil {
            if isOwnedEmbeddingSocket(), unlink(embeddedSocket.path) != 0 { return (false, false, nil) }
            let proc = Process()
            proc.executableURL = paths.binURL
            let binDir = paths.binURL.deletingLastPathComponent()
            proc.currentDirectoryURL = binDir
            var args = [
                "--model", paths.modelURL.path,
                "--embeddings",
                "--host", embeddedSocket.path,
                "--ctx-size", "4096",
                "--ubatch-size", "4096",
                "--batch-size", "4096",
            ]
            if let mm = paths.mmprojURL {
                args.append(contentsOf: ["--mmproj", mm.path])
            }
            proc.arguments = args

            var env = ProcessInfo.processInfo.environment.filter { !$0.key.hasPrefix("LLAMA_") && !$0.key.hasPrefix("DYLD_") }
            env["DYLD_LIBRARY_PATH"] = binDir.path
            proc.environment = env
            proc.standardOutput = FileHandle.nullDevice
            proc.standardError = FileHandle.nullDevice

            do {
                try proc.run()
                embeddedProcess = proc
            } catch {
                return (false, false, nil)
            }
        }

        // 3. Wait for /props to report ready (usually ~1.5s once Metal shaders are cached, up to 25s first run)
        for _ in 0..<85 {
            if let proc = embeddedProcess, !proc.isRunning {
                embeddedProcess = nil
                return (false, false, nil)
            }
            let probe = probeEmbeddedPropsSync(timeout: 0.5)
            if probe.ready {
                return probe
            }
            Thread.sleep(forTimeInterval: 0.3)
        }
        return (false, false, nil)
    }

    private func embedViaEmbeddedSync(_ makeItems: (EmbeddedState) -> [Any]?) -> [[Float]]? {
        for attempt in 0..<3 {
            guard !runtimeLock.withLock({ runtimeStopping }) else { return nil }
            // Keep a serving instance alive for the duration of its request. Other readers can
            // embed concurrently. Only starting or stopping a server needs an exclusive lease.
            let shared = try? withFormaFileLock(runtimeLockURL, operation: LOCK_SH) { () -> (ready: Bool, vectors: [[Float]]?) in
                let state = probeEmbeddedPropsSync(timeout: 0.6)
                guard state.ready else { return (false, nil) }
                defer { runtimeLock.withLock { resetEmbeddedIdleTimer() } }
                guard let items = makeItems(state) else { return (true, nil) }
                return (true, postEmbeddedItems(items))
            }
            guard let shared else { return nil }
            if shared.ready { return shared.vectors }
            if attempt == 2 { break }
            let started = try? withFormaFileLock(runtimeLockURL) {
                runtimeLock.withLock {
                    guard !runtimeStopping, ensureEmbeddedRunningSync().ready else { return false }
                    resetEmbeddedIdleTimer()
                    return true
                }
            }
            guard started == true else { return nil }
        }
        return nil
    }

    private func postEmbeddedItems(_ items: [Any]) -> [[Float]]? {
        let payload: [String: Any] = ["input": items]
        guard !items.isEmpty,
              let body = try? JSONSerialization.data(withJSONObject: payload),
              let data = embeddedResponse("/v1/embeddings", body: body, timeout: 50),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let rows = json["data"] as? [[String: Any]],
              rows.count == items.count else {
            return nil
        }

        let sorted = rows.sorted { ($0["index"] as? Int ?? 0) < ($1["index"] as? Int ?? 0) }
        var out: [[Float]] = []
        out.reserveCapacity(sorted.count)
        for row in sorted {
            guard let rawVec = row["embedding"] as? [NSNumber] else { return nil }
            out.append(rawVec.map { $0.floatValue })
        }
        return out
    }

    // MARK: - Embedded Cross-Encoder Reranker (llama-server --reranking)

    private func resolveRerankPaths() -> (binURL: URL, modelURL: URL, modelName: String)? {
        let fm = FileManager.default
        let binCandidates = [
            formaSupportDir.appendingPathComponent("bin/llama-server"),
            Bundle.main.resourceURL?.appendingPathComponent("bin/llama-server"),
            URL(fileURLWithPath: "/opt/homebrew/bin/llama-server"),
            URL(fileURLWithPath: "/usr/local/bin/llama-server"),
        ].compactMap { $0 }

        guard let binURL = binCandidates.first(where: { fm.isExecutableFile(atPath: $0.path) }) else {
            return nil
        }
        let modelsDir = formaSupportDir.appendingPathComponent("models", isDirectory: true)
        for candidate in Self.rerankModelCandidates {
            let modelURL = modelsDir.appendingPathComponent(candidate.file)
            if fm.fileExists(atPath: modelURL.path) {
                return (binURL, modelURL, candidate.name)
            }
        }
        return nil
    }

    private var rerankLockURL: URL {
        rerankSocket.deletingPathExtension().appendingPathExtension("lock")
    }

    private func isOwnedRerankSocket() -> Bool {
        var info = stat()
        return lstat(rerankSocket.path, &info) == 0 && info.st_uid == geteuid() && info.st_mode & S_IFMT == S_IFSOCK
    }

    private func rerankSocketResponse(_ endpoint: String, body: Data? = nil, timeout: TimeInterval) -> Data? {
        guard (try? ensureFormaPrivateDirectory(rerankSocket.deletingLastPathComponent())) != nil,
              isOwnedRerankSocket() else { return nil }
        var bytes: UnsafeMutableRawPointer?
        var length = 0
        let url = "http://localhost" + endpoint
        let milliseconds = Int(timeout * 1_000)
        let status = if let body {
            body.withUnsafeBytes {
                forma_socket_http(rerankSocket.path, url, $0.baseAddress, $0.count, milliseconds, &bytes, &length)
            }
        } else {
            forma_socket_http(rerankSocket.path, url, nil, 0, milliseconds, &bytes, &length)
        }
        guard let bytes else { return nil }
        guard status == 200 else { free(bytes); return nil }
        return Data(bytesNoCopy: bytes, count: length, deallocator: .free)
    }

    private func resetRerankIdleTimer() {
        rerankLastUse = Date()
        rerankIdleTimer?.cancel()
        rerankIdleTimer = nil
        guard rerankProcess != nil else { return }
        let timer = DispatchSource.makeTimerSource(queue: searchQueue)
        timer.schedule(deadline: .now() + 30)
        timer.setEventHandler { [weak self] in self?.shutdownRerankSync(onlyIfIdle: true) }
        timer.resume()
        rerankIdleTimer = timer
    }

    private func shutdownRerankSync(onlyIfIdle: Bool = false) {
        guard runtimeLock.withLock({ rerankProcess != nil }) else { return }
        _ = try? withFormaFileLock(rerankLockURL) {
            runtimeLock.lock()
            defer { runtimeLock.unlock() }
            if onlyIfIdle, let lastUse = rerankLastUse, Date().timeIntervalSince(lastUse) < 29 { return }
            rerankIdleTimer?.cancel()
            rerankIdleTimer = nil
            if let process = rerankProcess, process.isRunning {
                process.terminate()
                process.waitUntilExit()
            }
            rerankProcess = nil
            if isOwnedRerankSocket() { _ = unlink(rerankSocket.path) }
        }
    }

    private func ensureRerankRunningSync() -> Bool {
        if rerankSocketResponse("/health", timeout: 0.6) != nil {
            return true
        }
        guard let paths = resolveRerankPaths() else {
            return false
        }
        if let old = rerankProcess, !old.isRunning {
            rerankProcess = nil
        }
        if rerankProcess == nil {
            if isOwnedRerankSocket(), unlink(rerankSocket.path) != 0 { return false }
            let proc = Process()
            proc.executableURL = paths.binURL
            let binDir = paths.binURL.deletingLastPathComponent()
            proc.currentDirectoryURL = binDir
            proc.arguments = [
                "--model", paths.modelURL.path,
                "--reranking",
                "--host", rerankSocket.path,
                "--ctx-size", "4096",
                "--ubatch-size", "4096",
                "--batch-size", "4096",
            ]
            var env = ProcessInfo.processInfo.environment.filter { !$0.key.hasPrefix("LLAMA_") && !$0.key.hasPrefix("DYLD_") }
            env["DYLD_LIBRARY_PATH"] = binDir.path
            proc.environment = env
            proc.standardOutput = FileHandle.nullDevice
            proc.standardError = FileHandle.nullDevice
            do {
                try proc.run()
                rerankProcess = proc
            } catch {
                return false
            }
        }
        for _ in 0..<45 {
            if let proc = rerankProcess, !proc.isRunning {
                rerankProcess = nil
                return false
            }
            if rerankSocketResponse("/health", timeout: 0.4) != nil {
                return true
            }
            Thread.sleep(forTimeInterval: 0.2)
        }
        return false
    }

    private static func truncateUTF8(_ text: String, maxBytes: Int) -> String {
        guard text.utf8.count > maxBytes else { return text }
        var bytes = 0
        var end = text.startIndex
        for idx in text.indices {
            let next = text.index(after: idx)
            let charBytes = text[idx..<next].utf8.count
            if bytes + charBytes > maxBytes { break }
            bytes += charBytes
            end = next
        }
        return String(text[..<end])
    }

    private func rerankViaEmbeddedSync(query: String, documents: [String]) -> [Int: Double]? {
        guard !documents.isEmpty else { return [:] }
        for attempt in 0..<3 {
            guard !runtimeLock.withLock({ runtimeStopping }) else { return nil }
            let shared = try? withFormaFileLock(rerankLockURL, operation: LOCK_SH) { () -> (ready: Bool, scores: [Int: Double]?) in
                guard rerankSocketResponse("/health", timeout: 0.5) != nil else { return (false, nil) }
                defer { runtimeLock.withLock { resetRerankIdleTimer() } }
                let payload: [String: Any] = [
                    "query": query,
                    "documents": documents,
                    "top_n": documents.count,
                ]
                guard let body = try? JSONSerialization.data(withJSONObject: payload),
                      let data = rerankSocketResponse("/v1/rerank", body: body, timeout: 25),
                      let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let rows = json["results"] as? [[String: Any]] else {
                    return (true, nil)
                }
                var out: [Int: Double] = [:]
                out.reserveCapacity(rows.count)
                for row in rows {
                    guard let idx = (row["index"] as? Int) ?? (row["index"] as? NSNumber)?.intValue else { continue }
                    let score = (row["relevance_score"] as? Double)
                        ?? (row["relevance_score"] as? NSNumber)?.doubleValue
                        ?? 0.0
                    out[idx] = score
                }
                return (true, out)
            }
            guard let shared else { return nil }
            if shared.ready { return shared.scores }
            if attempt == 2 { break }
            let started = try? withFormaFileLock(rerankLockURL) {
                runtimeLock.withLock {
                    guard !runtimeStopping, ensureRerankRunningSync() else { return false }
                    resetRerankIdleTimer()
                    return true
                }
            }
            guard started == true else { return nil }
        }
        return nil
    }

    private func resolveActiveEmbedEngine(ollama: OllamaDiscovery? = nil) -> ActiveEmbedEngine {
        // Priority 1: Self-contained Forma Embedded EmbeddingGemma 2 (zero Ollama dependency!)
        if let paths = resolveEmbeddedPaths() {
            return ActiveEmbedEngine(
                online: true,
                backend: "forma-embedded",
                embedModel: Self.embeddedModelName,
                multimodal: paths.mmprojURL != nil
            )
        }
        // Check if an external embedded llama-server is already listening
        let liveProbe = probeEmbeddedPropsSync(timeout: 0.3)
        if liveProbe.ready {
            return ActiveEmbedEngine(
                online: true,
                backend: "forma-embedded",
                embedModel: Self.embeddedModelName,
                multimodal: liveProbe.hasVision
            )
        }
        // Priority 2: Local Ollama fallback
        let discovery = allowOllamaFallback ? (ollama ?? discoverOllamaModels()) : nil
        if let discovery, discovery.online {
            return ActiveEmbedEngine(
                online: true,
                backend: "ollama",
                embedModel: discovery.embedModel,
                multimodal: Self.isMultimodalEmbedModel(discovery.embedModel)
            )
        }
        return ActiveEmbedEngine(
            online: false,
            backend: "lexical",
            embedModel: Self.embeddedModelName,
            multimodal: false
        )
    }

    private func getStatusSync() -> [String: Any] {
        let ollama = discoverOllamaModels()
        let engine = resolveActiveEmbedEngine(ollama: ollama)
        let reranker = resolveRerankPaths()
        let counts = queryCounts()
        return [
            "ollamaOnline": engine.online || ollama.online,
            "embedOnline": engine.online,
            "embedBackend": engine.backend,
            "chatOnline": ollama.online,
            "embedModel": engine.embedModel,
            "multimodal": engine.multimodal,
            "rerankerReady": reranker != nil,
            "rerankModel": reranker?.modelName ?? "",
            "chatModels": ollama.chatModels,
            "activeChatModel": ollama.activeChatModel,
            "indexedDocs": counts.docs,
            "indexedChunks": counts.chunks,
            "backend": "native-sqlite",
        ]
    }

    // MARK: - Indexing

    private func indexDocumentSync(
        docId: String,
        kind: String,
        title: String,
        path: String,
        text: String,
        images: [VisualIndexInput] = [],
        diskFile: DiskFile? = nil,
        engineOverride: ActiveEmbedEngine? = nil,
        watchOnly: Bool = false
    ) -> [String: Any] {
        openDatabaseIfNeeded()
        guard let db else { return ["ok": false, "error": "SQLite database unavailable"] }

        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let engine = engineOverride ?? resolveActiveEmbedEngine()
        let isMultimodal = engine.online && engine.multimodal
        var effectiveImages = images
        if diskFile == nil && isMultimodal && kind == "pdf" && effectiveImages.isEmpty && !path.isEmpty {
            let pages = (try? configStore.loadIndexConfig().pdfVisualPages) ?? 8
            effectiveImages = FormaDocExtractors.pdfVisuals(at: path, maxPages: pages)
        }

        if diskFile == nil && trimmed.isEmpty && effectiveImages.isEmpty {
            let removed = removeDocumentSync(docId: docId)
            return ["ok": removed, "docId": docId, "skipped": removed, "chunks": 0, "embedded": false]
        }

        let imageFingerprint = effectiveImages.map {
            "\($0.sectionLabel)|\($0.caption)|\(sha256Hex($0.base64))"
        }.joined(separator: ";")
        let contentHash = sha256Hex("\(title)\n\(trimmed)\n\(isMultimodal ? "mm1" : "txt"):\(imageFingerprint)")
        if diskFile == nil, let existing = existingDocMeta(docId: docId), existing.hash == contentHash {
            let needsEmbeddings = engine.online && (existing.embedModel != engine.embedModel || existing.unembeddedCount > 0)
            if !needsEmbeddings {
                return [
                    "ok": true, "docId": docId, "skipped": true, "chunks": existing.chunkCount,
                    "embedded": existing.unembeddedCount == 0 && !existing.embedModel.isEmpty,
                ]
            }
        }

        var chunks = trimmed.isEmpty ? [] : chunkText(trimmed, maxChunkChars: 900, overlapChars: 140, maxChunks: 72)
        for image in (isMultimodal ? Array(effectiveImages.prefix(8)) : []) {
            let caption = image.caption.isEmpty ? title : image.caption
            chunks.append(DocumentChunk(
                index: chunks.count, sectionLabel: image.sectionLabel,
                text: "[Visual · \(image.sectionLabel)] \(caption)", imageBase64: image.base64
            ))
        }

        var embeddings: [[Float]?] = Array(repeating: nil, count: chunks.count)
        var embedModel = ""
        var embeddedAll = false

        if engine.online {
            let batchSize = isMultimodal ? 6 : 12
            var successCount = 0
            for start in stride(from: 0, to: chunks.count, by: batchSize) {
                let end = min(start + batchSize, chunks.count)
                let batch = chunks[start..<end]
                if let vectors = embedChunks(batch, title: title, engine: engine), vectors.count == batch.count {
                    for (offset, vector) in vectors.enumerated() {
                        embeddings[start + offset] = Self.l2Normalize(vector)
                        successCount += 1
                    }
                    continue
                }
                // Fallback: embed chunks individually and truncate ultra-dense chunks (e.g. hex/numeric CSVs)
                // that exceed the server's micro-batch token limit.
                var batchFailed = false
                for offset in 0..<batch.count {
                    let chunk = chunks[start + offset]
                    if let vector = embedSingleChunkWithFallback(chunk, title: title, engine: engine) {
                        embeddings[start + offset] = Self.l2Normalize(vector)
                        successCount += 1
                    } else {
                        batchFailed = true
                        break
                    }
                }
                if batchFailed { break }
            }
            embeddedAll = successCount == chunks.count
            if embeddedAll || successCount > 0 { embedModel = engine.embedModel }
            if diskFile != nil && !embeddedAll {
                return ["ok": false, "error": "EmbeddingGemma did not index every chunk"]
            }
        }

        let persist = {
            self.writeTransaction {
                let upsert = """
                    INSERT INTO docs (doc_id, kind, title, path, content_hash, updated_at, embed_model, file_mtime, file_size, source)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(doc_id) DO UPDATE SET kind=excluded.kind, title=excluded.title,
                        path=excluded.path, content_hash=excluded.content_hash, updated_at=excluded.updated_at,
                        embed_model=excluded.embed_model, file_mtime=excluded.file_mtime,
                        file_size=excluded.file_size, source=excluded.source;
                    """
                guard self.runStatement(db, upsert, bind: { stmt in
                    sqlite3_bind_text(stmt, 1, docId, -1, SQLITE_TRANSIENT)
                    sqlite3_bind_text(stmt, 2, kind, -1, SQLITE_TRANSIENT)
                    sqlite3_bind_text(stmt, 3, title, -1, SQLITE_TRANSIENT)
                    sqlite3_bind_text(stmt, 4, path, -1, SQLITE_TRANSIENT)
                    sqlite3_bind_text(stmt, 5, contentHash, -1, SQLITE_TRANSIENT)
                    sqlite3_bind_double(stmt, 6, Date().timeIntervalSince1970)
                    sqlite3_bind_text(stmt, 7, embedModel, -1, SQLITE_TRANSIENT)
                    sqlite3_bind_double(stmt, 8, diskFile?.mtime ?? 0)
                    sqlite3_bind_int64(stmt, 9, Int64(diskFile?.size ?? 0))
                    sqlite3_bind_text(stmt, 10, diskFile == nil ? "workspace" : "folder", -1, SQLITE_TRANSIENT)
                }), self.runStatement(db, "DELETE FROM chunks WHERE doc_id = ?;", bind: {
                    sqlite3_bind_text($0, 1, docId, -1, SQLITE_TRANSIENT)
                }) else { return false }

                var statement: OpaquePointer?
                defer { sqlite3_finalize(statement) }
                let insert = "INSERT INTO chunks (doc_id, chunk_idx, section_label, text, embedding, embedding_q8) VALUES (?, ?, ?, ?, ?, ?);"
                guard sqlite3_prepare_v2(db, insert, -1, &statement, nil) == SQLITE_OK, let statement else { return false }
                for (index, chunk) in chunks.enumerated() {
                    sqlite3_reset(statement)
                    sqlite3_bind_text(statement, 1, docId, -1, SQLITE_TRANSIENT)
                    sqlite3_bind_int(statement, 2, Int32(chunk.index))
                    sqlite3_bind_text(statement, 3, chunk.sectionLabel, -1, SQLITE_TRANSIENT)
                    sqlite3_bind_text(statement, 4, chunk.text, -1, SQLITE_TRANSIENT)
                    if let vector = embeddings[index], !vector.isEmpty {
                        let blob = Self.encodeFloat32LittleEndian(vector)
                        let q8Blob = Self.encodeInt8Normalized(vector)
                        _ = blob.withUnsafeBytes { bytes in
                            sqlite3_bind_blob(statement, 5, bytes.baseAddress, Int32(blob.count), SQLITE_TRANSIENT)
                        }
                        _ = q8Blob.withUnsafeBytes { bytes in
                            sqlite3_bind_blob(statement, 6, bytes.baseAddress, Int32(q8Blob.count), SQLITE_TRANSIENT)
                        }
                    } else {
                        sqlite3_bind_null(statement, 5)
                        sqlite3_bind_null(statement, 6)
                    }
                    if sqlite3_step(statement) != SQLITE_DONE { return false }
                }
                return true
            }
        }

        if let diskFile, !diskFile.stillCurrent() {
            return ["ok": false, "error": "File changed during indexing"]
        }
        let saved: Bool
        if watchOnly {
            saved = (try? configStore.withIndexConfig { config in
                guard config.watchedFolders.contains(where: { FormaIndexConfig.contains(path, in: $0) }),
                      FormaDocExtractors.kind(for: URL(fileURLWithPath: path).pathExtension.lowercased(),
                                              includeImages: config.includeStandaloneImages) != nil else { return false }
                return persist()
            }) == true
        } else {
            saved = persist()
        }
        guard saved else { return ["ok": false, "error": "Index write could not be committed"] }
        return [
            "ok": true, "docId": docId, "skipped": false,
            "chunks": chunks.count, "embedded": embeddedAll, "embedModel": embedModel,
        ]
    }

    private func embedSingleChunkWithFallback(
        _ chunk: DocumentChunk, title: String, engine: ActiveEmbedEngine
    ) -> [Float]? {
        if let vector = embedChunks([chunk][...], title: title, engine: engine)?.first, !vector.isEmpty {
            return vector
        }
        guard chunk.imageBase64 == nil else { return nil }
        for limit in [450, 220] where chunk.text.count > limit {
            let shorter = DocumentChunk(
                index: chunk.index,
                sectionLabel: chunk.sectionLabel,
                text: String(chunk.text.prefix(limit)),
                imageBase64: nil
            )
            if let vector = embedChunks([shorter][...], title: title, engine: engine)?.first, !vector.isEmpty {
                return vector
            }
        }
        return nil
    }

    private func embedChunks(
        _ chunks: ArraySlice<DocumentChunk>, title: String, engine: ActiveEmbedEngine
    ) -> [[Float]]? {
        let textForChunk: (DocumentChunk) -> String = { chunk in
            let section = chunk.sectionLabel.isEmpty ? "" : "\(chunk.sectionLabel): "
            return "title: \(title) | text: \(section)\(chunk.text)"
        }
        if engine.backend == "forma-embedded" {
            return embedViaEmbeddedSync { state in
                var items: [Any] = []
                for chunk in chunks {
                    if let image = chunk.imageBase64 {
                        guard state.hasVision, let marker = state.mediaMarker, !marker.isEmpty else { return nil }
                        items.append(["prompt_string": marker, "multimodal_data": [image]])
                    } else {
                        items.append(textForChunk(chunk))
                    }
                }
                return items
            }
        }
        if engine.multimodal {
            return embedMultimodalInputs(chunks.map { chunk in
                if let image = chunk.imageBase64 { return ["image": image] }
                return ["text": textForChunk(chunk)]
            }, model: engine.embedModel)
        }
        return embedTexts(chunks.map { "\(title) — \($0.sectionLabel)\n\($0.text)" }, model: engine.embedModel)
    }

    @discardableResult
    private func removeDocumentSync(docId: String) -> Bool {
        openDatabaseIfNeeded()
        guard let db else { return false }
        return writeTransaction { deleteDocument(db, docId: docId) }
    }

    private func deleteDocument(_ db: OpaquePointer, docId: String, diskOnly: Bool = false) -> Bool {
        let scoped = diskOnly ? " AND source = 'folder'" : ""
        let bind: (OpaquePointer) -> Void = { sqlite3_bind_text($0, 1, docId, -1, SQLITE_TRANSIENT); }
        return runStatement(db, "DELETE FROM chunks WHERE doc_id IN (SELECT doc_id FROM docs WHERE doc_id = ?\(scoped));", bind: bind)
            && runStatement(db, "DELETE FROM docs WHERE doc_id = ?\(scoped);", bind: bind)
    }

    private struct DiskFile {
        let url: URL
        let mtime: Double
        let size: Int

        static let resourceKeys: Set<URLResourceKey> = [
            .isDirectoryKey, .isRegularFileKey, .isSymbolicLinkKey, .isHiddenKey, .isPackageKey,
            .contentModificationDateKey, .fileSizeKey,
        ]

        init?(_ url: URL, values: URLResourceValues) {
            guard values.isRegularFile == true, values.isSymbolicLink != true,
                  let modified = values.contentModificationDate, let size = values.fileSize else { return nil }
            self.url = url
            self.mtime = modified.timeIntervalSince1970
            self.size = size
        }

        func stillCurrent() -> Bool {
            let fresh = URL(fileURLWithPath: url.path)
            guard FormaIndexConfig.canonicalPath(fresh.path) == fresh.path,
                  let values = try? fresh.resourceValues(forKeys: Self.resourceKeys),
                  let file = DiskFile(fresh, values: values) else { return false }
            return mtime == file.mtime && size == file.size
        }
    }

    private struct DiskStamp {
        let mtime: Double
        let size: Int
        let model: String

        func matches(_ disk: DiskFile, model: String) -> Bool {
            disk.mtime == mtime && disk.size == size && self.model == model
        }
    }

    private func diskEmbedEngine() -> ActiveEmbedEngine {
        let paths = resolveEmbeddedPaths()
        return ActiveEmbedEngine(
            online: paths != nil,
            backend: paths == nil ? "lexical" : "forma-embedded",
            embedModel: Self.embeddedModelName,
            multimodal: paths?.mmprojURL != nil
        )
    }

    private func indexConfigResponse() -> [String: Any] {
        do {
            let config = try configStore.loadIndexConfig()
            var indexedPaths: [String] = []
            guard let reader = openReadDatabase() else { return ["ok": false, "error": "SQLite database unavailable"] }
            defer { sqlite3_close(reader) }
            guard select(reader, "SELECT path FROM docs WHERE source = 'folder';", row: {
                indexedPaths.append(columnText($0, 0))
            }) else { return ["ok": false, "error": "Could not read indexed folders"] }
            let counts = queryCounts()
            let engine = diskEmbedEngine()
            let reranker = resolveRerankPaths()
            return [
                "ok": true, "watchedFolders": config.watchedFolders,
                "folders": config.watchedFolders.map { root in
                    ["path": root, "fileCount": indexedPaths.filter { FormaIndexConfig.contains($0, in: root) }.count]
                },
                "includeStandaloneImages": config.includeStandaloneImages, "lastFullSyncAt": config.lastFullSyncAt,
                "indexedDocs": counts.docs, "indexedChunks": counts.chunks, "backend": engine.backend,
                "embedModel": engine.embedModel, "multimodal": engine.multimodal,
                "rerankerReady": reranker != nil, "rerankModel": reranker?.modelName ?? "",
            ]
        } catch {
            return ["ok": false, "error": error.localizedDescription]
        }
    }

    private func eligibleDiskFile(_ url: URL, values: URLResourceValues, config: FormaIndexConfig) -> DiskFile? {
        let ext = url.pathExtension.lowercased()
        guard let file = DiskFile(url, values: values), file.size <= config.maximumFileBytes,
              FormaDocExtractors.kind(for: ext, includeImages: config.includeStandaloneImages) != nil else { return nil }
        if FormaDocExtractors.standaloneImages.contains(ext) && file.size >= 10 * 1_048_576 { return nil }
        return file
    }

    private func collectFiles(
        in roots: [String], config: FormaIndexConfig, cancellation: FormaIndexCancellation? = nil
    ) -> (files: [DiskFile], errors: [String]) {
        let manager = FileManager.default
        let ignored = Set(config.ignoreDirNames)
        var files: [DiskFile] = []
        var scannedPaths = Set<String>()
        var errors: [String] = []
        for path in roots {
            if cancellation?.isCancelled == true { break }
            guard let root = FormaIndexConfig.existingDirectory(path), root == path else {
                errors.append("Folder unavailable: \(path)")
                continue
            }
            let url = URL(fileURLWithPath: root, isDirectory: true)
            guard let items = manager.enumerator(
                at: url,
                includingPropertiesForKeys: Array(DiskFile.resourceKeys),
                options: [.skipsHiddenFiles, .skipsPackageDescendants],
                errorHandler: { item, error in
                    if errors.count < 12 { errors.append("\(item.path): \(error.localizedDescription)") }
                    return true
                }
            ) else { continue }
            for case let item as URL in items {
                if cancellation?.isCancelled == true { break }
                guard let values = try? item.resourceValues(forKeys: DiskFile.resourceKeys) else { continue }
                if values.isSymbolicLink == true || (values.isDirectory == true && ignored.contains(item.lastPathComponent)) {
                    items.skipDescendants()
                    continue
                }
                guard let file = eligibleDiskFile(item, values: values, config: config) else { continue }
                if scannedPaths.insert(item.path).inserted { files.append(file) }
            }
        }
        return (files, errors)
    }

    private func isMissingOnDisk(_ error: Error) -> Bool {
        let code = (error as? CocoaError)?.code
        return code == .fileNoSuchFile || code == .fileReadNoSuchFile
    }

    private func isVisibleWatchedPath(_ url: URL, values: URLResourceValues, config: FormaIndexConfig) throws -> Bool {
        guard config.watchedFolders.contains(where: { FormaIndexConfig.contains(url.path, in: $0) }),
              FormaIndexConfig.canonicalPath(url.path) == url.path else { return false }
        var item = url
        var info = values
        while !config.watchedFolders.contains(item.path) {
            if info.isSymbolicLink == true || info.isHidden == true || item.lastPathComponent.hasPrefix(".")
                || (info.isDirectory == true && (info.isPackage == true || config.ignoreDirNames.contains(item.lastPathComponent))) {
                return false
            }
            item.deleteLastPathComponent()
            info = try item.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey, .isHiddenKey, .isPackageKey])
        }
        return true
    }

    private func collectChangedFiles(
        _ changes: [FormaIndexChange], config: FormaIndexConfig, cancellation: FormaIndexCancellation?
    ) -> (files: [DiskFile], errors: [String]) {
        var directories: [String] = []
        var files: [DiskFile] = []
        var errors: [String] = []
        // Visit ancestors first so a directory rename and its descendant events scan only once.
        for change in changes.sorted(by: { $0.path < $1.path }) {
            if cancellation?.isCancelled == true { break }
            let url = URL(fileURLWithPath: change.path)
            guard !directories.contains(where: { FormaIndexConfig.contains(url.path, in: $0) }) else { continue }
            do {
                let values = try url.resourceValues(forKeys: DiskFile.resourceKeys)
                guard try isVisibleWatchedPath(url, values: values, config: config) else { continue }
                if values.isDirectory == true {
                    directories.append(url.path)
                } else if let file = eligibleDiskFile(url, values: values, config: config) {
                    files.append(file)
                }
            } catch where isMissingOnDisk(error) {
                // Deletions and the old side of renames are handled by pruning.
            } catch {
                if errors.count < 12 { errors.append("\(url.path): \(error.localizedDescription)") }
            }
        }
        let scan = collectFiles(in: directories, config: config, cancellation: cancellation)
        return (files + scan.files, errors + scan.errors)
    }

    private func diskStamps(_ handle: OpaquePointer, files: [DiskFile]) throws -> [String: DiskStamp] {
        guard !files.isEmpty else { return [:] }
        let paths = files.count <= 256 ? files.map { $0.url.path } : []
        let filter = paths.isEmpty ? "" : " AND path IN (\(Array(repeating: "?", count: paths.count).joined(separator: ",")))"
        var stamps: [String: DiskStamp] = [:]
        guard select(handle, "SELECT path, file_mtime, file_size, embed_model FROM docs WHERE source = 'folder'\(filter);", bind: { stmt in
            for (index, path) in paths.enumerated() {
                sqlite3_bind_text(stmt, Int32(index + 1), path, -1, SQLITE_TRANSIENT)
            }
        }, row: {
            stamps[columnText($0, 0)] = DiskStamp(mtime: sqlite3_column_double($0, 1),
                size: Int(sqlite3_column_int64($0, 2)), model: columnText($0, 3))
        }) else { throw CocoaError(.fileReadUnknown) }
        return stamps
    }

    private func pruneUnwatchedFiles(changes: [FormaIndexChange]? = nil) throws -> Int {
        if changes?.isEmpty == true { return 0 }
        openDatabaseIfNeeded()
        guard let db else { throw CocoaError(.fileWriteUnknown) }
        // A directory scope includes its former descendants even after a move or deletion.
        let scopes = changes?.map { change -> (sql: String, paths: [String]) in
            guard change.includesDescendants else { return ("path = ?", [change.path]) }
            if change.path == "/" { return ("1", []) }
            return ("(path = ? OR (path >= ? AND path < ?))", [change.path, change.path + "/", change.path + "0"])
        } ?? []
        let filter = scopes.isEmpty ? "" : " AND (\(scopes.map(\.sql).joined(separator: " OR ")))"
        return try configStore.withIndexConfig { config in
            let availableRoots = config.watchedFolders.filter { FormaIndexConfig.existingDirectory($0) == $0 }
            var stale: [String] = []
            guard select(db, "SELECT doc_id, path FROM docs WHERE source = 'folder'\(filter);", bind: { stmt in
                for (index, path) in scopes.flatMap(\.paths).enumerated() {
                    sqlite3_bind_text(stmt, Int32(index + 1), path, -1, SQLITE_TRANSIENT)
                }
            }, row: { stmt in
                let path = columnText(stmt, 1)
                let url = URL(fileURLWithPath: path)
                let excluded = !config.watchedFolders.contains { FormaIndexConfig.contains(path, in: $0) }
                    || FormaDocExtractors.kind(for: url.pathExtension.lowercased(), includeImages: config.includeStandaloneImages) == nil
                if excluded {
                    stale.append(columnText(stmt, 0))
                } else if availableRoots.contains(where: { FormaIndexConfig.contains(path, in: $0) }) {
                    do {
                        let values = try url.resourceValues(forKeys: DiskFile.resourceKeys)
                        let visible = try isVisibleWatchedPath(url, values: values, config: config)
                        if !visible || eligibleDiskFile(url, values: values, config: config) == nil {
                            stale.append(columnText(stmt, 0))
                        }
                    } catch where isMissingOnDisk(error) {
                        stale.append(columnText(stmt, 0))
                    } catch { /* Inaccessible folders do not imply deleted files. */ }
                }
            }) else { throw CocoaError(.fileReadUnknown) }
            guard stale.isEmpty || writeTransaction({ stale.allSatisfy { deleteDocument(db, docId: $0, diskOnly: true) } }) else {
                throw CocoaError(.fileWriteUnknown)
            }
            return stale.count
        }
    }

    private func syncWatchedFoldersSync(
        force: Bool, changes: [FormaIndexChange]? = nil, cancellation: FormaIndexCancellation? = nil
    ) -> [String: Any] {
        do {
            let config = try configStore.loadIndexConfig()
            let scan = changes.map { collectChangedFiles($0, config: config, cancellation: cancellation) }
                ?? collectFiles(in: config.watchedFolders, config: config, cancellation: cancellation)
            if cancellation?.isCancelled == true { return ["ok": true, "interrupted": true] }
            let pruned = try pruneUnwatchedFiles(changes: changes)
            var result = try indexDiskFiles(scan.files, config: config, force: force, watchOnly: true, cancellation: cancellation)
            let errors = (result["errors"] as? [String] ?? []) + scan.errors
            result["errors"] = errors
            result["prunedCount"] = pruned
            let interrupted = cancellation?.isCancelled == true
            if interrupted { result["interrupted"] = true }
            let failedCount = result["failedCount"] as? Int ?? 0
            let indexedCount = result["indexedCount"] as? Int ?? 0
            let skippedCount = result["skippedCount"] as? Int ?? 0
            let completedPass = failedCount == 0 || indexedCount > 0 || skippedCount > 0
            if changes == nil, !interrupted, completedPass, scan.errors.isEmpty {
                let latest = try configStore.update {
                    if $0.hasSameScanSettings(as: config) {
                        $0.lastFullSyncAt = Date().timeIntervalSince1970
                    }
                }
                result["lastFullSyncAt"] = latest.lastFullSyncAt
            }
            if !errors.isEmpty { result["ok"] = false }
            return result
        } catch {
            return ["ok": false, "error": error.localizedDescription]
        }
    }

    private func indexPathSync(_ rawPath: String, force: Bool) -> [String: Any] {
        guard !rawPath.isEmpty else { return ["ok": false, "error": "Missing path"] }
        guard let canonical = FormaIndexConfig.canonicalPath(rawPath) else {
            return ["ok": false, "error": "File or folder does not exist"]
        }
        let url = URL(fileURLWithPath: canonical)
        do {
            let config = try configStore.loadIndexConfig()
            let values = try url.resourceValues(forKeys: DiskFile.resourceKeys)
            if values.isDirectory == true {
                let scan = collectFiles(in: [url.path], config: config)
                var result = try indexDiskFiles(scan.files, config: config, force: force, watchOnly: false)
                result["folderPath"] = url.path
                if !scan.errors.isEmpty {
                    result["ok"] = false
                    result["errors"] = (result["errors"] as? [String] ?? []) + scan.errors
                }
                return result
            }
            guard let file = eligibleDiskFile(url, values: values, config: config) else {
                return ["ok": false, "error": "Unsupported file or file exceeds the configured size limit"]
            }
            return try indexDiskFiles([file], config: config, force: force, watchOnly: false)
        } catch {
            return ["ok": false, "error": error.localizedDescription]
        }
    }

    private func newestFilesAcrossFolders(_ files: [DiskFile], roots: [String]) -> [DiskFile] {
        let mostSpecificFirst = roots.sorted { $0.count > $1.count }
        let grouped = Dictionary(grouping: files) { file in
            mostSpecificFirst.first { FormaIndexConfig.contains(file.url.path, in: $0) } ?? ""
        }
        var groups = (roots + [""]).compactMap { root in
            grouped[root]?.sorted { a, b in
                a.mtime == b.mtime ? a.url.path < b.url.path : a.mtime > b.mtime
            }.dropFirst(0)
        }
        var ordered: [DiskFile] = []
        ordered.reserveCapacity(files.count)
        while !groups.isEmpty {
            for index in groups.indices { ordered.append(groups[index].removeFirst()) }
            groups.removeAll(where: \.isEmpty)
        }
        return ordered
    }

    private func indexDiskFiles(
        _ files: [DiskFile], config: FormaIndexConfig, force: Bool, watchOnly: Bool, cancellation: FormaIndexCancellation? = nil
    ) throws -> [String: Any] {
        openDatabaseIfNeeded()
        guard let db else { throw CocoaError(.fileReadUnknown) }
        let stamps = try diskStamps(db, files: files)
        let engine = diskEmbedEngine()
        let changed = files.filter { file in
            force || stamps[file.url.path]?.matches(file, model: engine.online ? engine.embedModel : "") != true
        }
        var indexed = 0
        var failed = 0
        var errors: [String] = []
        let ordered = newestFilesAcrossFolders(changed, roots: watchOnly ? config.watchedFolders : [])
        for file in ordered {
            if cancellation?.isCancelled == true { break }
            do {
                guard file.stillCurrent() else { throw CocoaError(.fileReadUnknown) }
                let document = try FormaDocExtractors.extract(file.url, config: config, includeVisuals: engine.multimodal)
                let result = indexDocumentSync(
                    docId: "file:\(file.url.path)", kind: document.kind, title: document.title,
                    path: file.url.path, text: document.text, images: document.images,
                    diskFile: file, engineOverride: engine, watchOnly: watchOnly
                )
                if result["ok"] as? Bool == true {
                    indexed += 1
                } else {
                    failed += 1
                    if errors.count < 12 { errors.append("\(file.url.path): \(result["error"] ?? "Indexing failed")") }
                }
            } catch {
                failed += 1
                if errors.count < 12 { errors.append("\(file.url.path): \(error.localizedDescription)") }
            }
        }
        return [
            "ok": failed == 0, "totalScanned": files.count, "indexedCount": indexed,
            "skippedCount": files.count - changed.count, "failedCount": failed, "errors": errors,
            "backend": engine.backend, "embedModel": engine.embedModel, "multimodal": engine.multimodal,
        ]
    }

    private func readDocumentSync(target: String, maxChars: Int, ocr: Bool) -> [String: Any] {
        guard !target.isEmpty else { return ["ok": false, "error": "Missing file path or document ID"] }
        var path = ""
        var title = ""
        var kind = ""
        var storedChunks: [[String: String]] = []
        if let reader = openReadDatabase() {
            let query = """
                SELECT d.path, d.title, d.kind, c.section_label, c.text
                FROM docs d LEFT JOIN chunks c ON c.doc_id = d.doc_id
                WHERE d.doc_id = ? ORDER BY c.chunk_idx;
                """
            var count = 0
            _ = select(reader, query, bind: { sqlite3_bind_text($0, 1, target, -1, SQLITE_TRANSIENT) }) { stmt in
                path = columnText(stmt, 0)
                title = columnText(stmt, 1)
                kind = columnText(stmt, 2)
                let text = String(columnText(stmt, 4).prefix(max(0, maxChars - count)))
                if !text.isEmpty {
                    storedChunks.append(["sectionLabel": columnText(stmt, 3), "text": text])
                    count += text.count + 2
                }
            }
            sqlite3_close(reader)
        }
        if target.hasPrefix("/") { path = target }
        if !path.isEmpty {
            do {
                let config = try configStore.loadIndexConfig()
                let url = URL(fileURLWithPath: path).standardizedFileURL
                let doc = try FormaDocExtractors.extract(url, config: config, includeVisuals: false, ocr: ocr)
                let text = String(doc.text.prefix(maxChars))
                let sections = chunkText(text, maxChunkChars: 1_800, overlapChars: 0, maxChunks: 150).map {
                    ["sectionLabel": $0.sectionLabel, "text": $0.text]
                }
                return ["ok": true, "title": doc.title, "path": url.path, "kind": doc.kind, "text": text, "sections": sections]
            } catch where title.isEmpty {
                return ["ok": false, "error": error.localizedDescription]
            } catch { /* Use the saved workspace content if the original file is unavailable. */ }
        }
        guard !title.isEmpty || !kind.isEmpty else { return ["ok": false, "error": "Document not found"] }
        let text = String(storedChunks.compactMap { $0["text"] }.joined(separator: "\n\n").prefix(maxChars))
        return [
            "ok": true, "docId": target, "path": path, "title": title, "kind": kind,
            "text": text, "sections": storedChunks,
        ]
    }

    // MARK: - Hybrid Search

    private struct RankedChunk {
        let id: Int64
        let docId: String
        var score: Double
        let hybrid: Bool
        var reranked: Bool = false
    }

    private struct CandidateRow {
        let kind: String
        let title: String
        let path: String
        let sectionLabel: String
        let rawText: String
    }

    private func semanticSearchSync(query: String, kindFilter: String?, limit: Int, lexicalOnly: Bool = false) -> [[String: Any]] {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let reader = openReadDatabase() else { return [] }
        defer { sqlite3_close(reader) }
        let kind = kindFilter?.trimmingCharacters(in: .whitespacesAndNewlines)
        let filter = kind == "all" || kind == "" ? nil : kind
        let tokens = Array(Self.tokenize(trimmed).prefix(48))

        // The embed call can start a process. Keep WAL snapshots open only during SQLite reads.
        let queryVector = lexicalOnly ? nil : queryVectorForSearch(trimmed, reader: reader, kind: filter)
        guard sqlite3_exec(reader, "BEGIN;", nil, nil, nil) == SQLITE_OK else { return [] }

        var keywordMatches = keywordScores(reader, tokens: tokens, kind: filter)
        var bestByDocument: [String: [RankedChunk]] = [:]
        func retain(_ candidate: RankedChunk) {
            var best = bestByDocument[candidate.docId] ?? []
            if best.isEmpty || Self.preferredRank(candidate, best[0]) {
                best.insert(candidate, at: 0)
            } else if best.count == 1 || Self.preferredRank(candidate, best[1]) {
                best.insert(candidate, at: 1)
            }
            if best.count > 2 { best.removeLast() }
            bestByDocument[candidate.docId] = best
        }
        if let (model, vector) = queryVector {
            rankVectors(reader, model: model, query: vector, kind: filter) { id, docId, cosine in
                let keywordScore = keywordMatches.removeValue(forKey: id)?.score ?? 0
                let score = 0.75 * cosine + 0.25 * keywordScore
                if score > 0.05 {
                    retain(RankedChunk(id: id, docId: docId, score: score, hybrid: true))
                }
            }
        }
        for match in keywordMatches.values { retain(match) }
        let sortedBest = bestByDocument.values.joined().sorted(by: Self.preferredRank)
        let poolSize = lexicalOnly ? limit : min(24, max(limit * 2, 16))
        var pool = Array(sortedBest.prefix(poolSize))
        let rows = fetchCandidateRows(reader, ranked: pool)
        _ = sqlite3_exec(reader, "ROLLBACK;", nil, nil, nil)

        // Optional local cross-encoder reranking pass over non-visual candidates.
        if !lexicalOnly && pool.count > 1 && resolveRerankPaths() != nil {
            var rerankIndices: [Int] = []
            var rerankTexts: [String] = []
            for (idx, candidate) in pool.enumerated() {
                guard let row = rows[candidate.id], !row.rawText.hasPrefix("[Visual ·") else { continue }
                let combined = [row.title, row.sectionLabel, row.rawText]
                    .filter { !$0.isEmpty }
                    .joined(separator: "\n")
                let docText = Self.truncateUTF8(combined, maxBytes: 1_200)
                rerankIndices.append(idx)
                rerankTexts.append(docText)
            }
            let rerankQuery = Self.truncateUTF8(trimmed, maxBytes: 400)
            if !rerankTexts.isEmpty, let scores = rerankViaEmbeddedSync(query: rerankQuery, documents: rerankTexts) {
                for (reqIdx, poolIdx) in rerankIndices.enumerated() {
                    guard let logit = scores[reqIdx] else { continue }
                    let prob = 1.0 / (1.0 + exp(-logit))
                    pool[poolIdx].score = 0.65 * prob + 0.35 * pool[poolIdx].score
                    pool[poolIdx].reranked = true
                }
                pool.sort(by: Self.preferredRank)
            }
        }

        return Array(pool.prefix(limit)).compactMap { candidate in
            guard let row = rows[candidate.id] else { return nil }
            let matchType = candidate.reranked ? "reranked" : (candidate.hybrid ? "hybrid" : "lexical")
            return [
                "docId": candidate.docId,
                "kind": row.kind,
                "title": row.title,
                "path": row.path,
                "sectionLabel": row.sectionLabel,
                "snippet": Self.makeSnippet(text: row.rawText, queryTerms: tokens, maxChars: 240),
                "score": (candidate.score * 1000).rounded() / 1000,
                "matchType": matchType,
            ]
        }
    }

    private static func preferredRank(_ lhs: RankedChunk, _ rhs: RankedChunk) -> Bool {
        lhs.score == rhs.score ? lhs.id < rhs.id : lhs.score > rhs.score
    }

    private func keywordScores(_ reader: OpaquePointer, tokens: [String], kind: String?) -> [Int64: RankedChunk] {
        guard !tokens.isEmpty else { return [:] }
        // Quote the tokenizer's words so punctuation in the user query never becomes FTS syntax.
        var match = Array(Set(tokens)).sorted().map { "\"\($0)\"*" }
        if tokens.count > 1 { match.append("\"\(tokens.joined(separator: " "))\"") }
        let kindCondition = kind == nil ? "" : " AND d.kind = ?"
        let query = """
            SELECT c.id, c.doc_id, -rank
            FROM chunk_search
            JOIN chunks c ON c.id = chunk_search.rowid
            JOIN docs d ON d.doc_id = c.doc_id
            WHERE chunk_search MATCH ?
              AND rank MATCH 'bm25(4.0, 1.5, 1.0)'\(kindCondition)
            ORDER BY rank;
            """
        var matches: [Int64: RankedChunk] = [:]
        var topScore: Double?
        _ = select(reader, query, bind: { stmt in
            sqlite3_bind_text(stmt, 1, match.joined(separator: " OR "), -1, SQLITE_TRANSIENT)
            if let kind { sqlite3_bind_text(stmt, 2, kind, -1, SQLITE_TRANSIENT) }
        }) { stmt in
            let id = sqlite3_column_int64(stmt, 0)
            let score = sqlite3_column_double(stmt, 2)
            if topScore == nil { topScore = score }
            let normalized = score / max(topScore ?? score, 0.00000001)
            matches[id] = RankedChunk(id: id, docId: columnText(stmt, 1), score: normalized, hybrid: false)
        }
        return matches
    }

    private func queryVectorForSearch(
        _ query: String, reader: OpaquePointer, kind: String?
    ) -> (model: String, vector: [Float])? {
        let kindCondition = kind == nil ? "" : " AND d.kind = ?"
        var availableModels = Set<String>()
        _ = select(reader, """
            SELECT DISTINCT d.embed_model FROM docs d
            WHERE d.embed_model != ''\(kindCondition)
              AND EXISTS (SELECT 1 FROM chunks c WHERE c.doc_id = d.doc_id AND c.embedding IS NOT NULL);
            """, bind: { stmt in
            if let kind { sqlite3_bind_text(stmt, 1, kind, -1, SQLITE_TRANSIENT) }
        }) { availableModels.insert(columnText($0, 0)) }
        guard !availableModels.isEmpty else { return nil }
        let engine = resolveActiveEmbedEngine()
        guard engine.online, availableModels.contains(engine.embedModel) else { return nil }
        let formatted = engine.multimodal || engine.backend == "forma-embedded"
            ? "task: search result | query: \(query)" : query
        let key = "\(engine.backend)\n\(engine.embedModel)\n\(formatted)"
        if let cached = queryVectorLock.withLock({ queryVectors[key] }) {
            return (engine.embedModel, cached)
        }
        let raw: [[Float]]?
        if engine.backend == "forma-embedded" {
            raw = embedViaEmbeddedSync { _ in [formatted] }
        } else {
            raw = embedTexts([formatted], model: engine.embedModel)
        }
        guard let first = raw?.first, !first.isEmpty else { return nil }
        let vector = Self.l2Normalize(first)
        queryVectorLock.withLock {
            if queryVectors.count >= 32 { queryVectors.removeAll(keepingCapacity: true) }
            queryVectors[key] = vector
        }
        return (engine.embedModel, vector)
    }

    private func loadVectorMatrix(
        _ reader: OpaquePointer, model: String, kind: String?, dims: Int, versionKey: String
    ) -> CachedVectorMatrix {
        let condition = kind == nil ? "" : " AND d.kind = ?"
        let byteCount = dims * MemoryLayout<Float>.stride
        var chunkIds: [Int64] = []
        var docIds: [String] = []
        var matrix: [Float] = []
        var scratchInt8 = [Int8](repeating: 0, count: dims)
        var scratchFloat = [Float](repeating: 0, count: dims)
        var divisor: Float = 127.0

        _ = select(reader, """
            SELECT c.id, c.doc_id, c.embedding_q8, c.embedding
            FROM docs d JOIN chunks c ON c.doc_id = d.doc_id
            WHERE d.embed_model = ? AND (length(c.embedding_q8) = ? OR length(c.embedding) = ?)\(condition);
            """, bind: { stmt in
            sqlite3_bind_text(stmt, 1, model, -1, SQLITE_TRANSIENT)
            sqlite3_bind_int(stmt, 2, Int32(dims))
            sqlite3_bind_int(stmt, 3, Int32(byteCount))
            if let kind { sqlite3_bind_text(stmt, 4, kind, -1, SQLITE_TRANSIENT) }
        }) { stmt in
            if let q8Blob = sqlite3_column_blob(stmt, 2), Int(sqlite3_column_bytes(stmt, 2)) == dims {
                scratchInt8.withUnsafeMutableBytes { dst in
                    if let base = dst.baseAddress { memcpy(base, q8Blob, dims) }
                }
                vDSP_vflt8(scratchInt8, 1, &scratchFloat, 1, vDSP_Length(dims))
                vDSP_vsdiv(scratchFloat, 1, &divisor, &scratchFloat, 1, vDSP_Length(dims))
                chunkIds.append(sqlite3_column_int64(stmt, 0))
                docIds.append(columnText(stmt, 1))
                matrix.append(contentsOf: scratchFloat)
            } else if let fBlob = sqlite3_column_blob(stmt, 3), Int(sqlite3_column_bytes(stmt, 3)) == byteCount {
                scratchFloat.withUnsafeMutableBytes { dst in
                    if let base = dst.baseAddress { memcpy(base, fBlob, byteCount) }
                }
                let normalized = Self.l2Normalize(scratchFloat)
                chunkIds.append(sqlite3_column_int64(stmt, 0))
                docIds.append(columnText(stmt, 1))
                matrix.append(contentsOf: normalized)
            }
        }

        let entry = CachedVectorMatrix(
            versionKey: versionKey,
            dims: dims,
            rowCount: chunkIds.count,
            chunkIds: chunkIds,
            docIds: docIds,
            matrix: matrix
        )
        vectorCacheLock.withLock {
            if vectorMatrixCache.count >= 2 { vectorMatrixCache.removeAll(keepingCapacity: true) }
            vectorMatrixCache["\(model)\n\(kind ?? "")"] = entry
        }
        return entry
    }

    private func rankVectors(
        _ reader: OpaquePointer, model: String, query: [Float], kind: String?,
        row: (Int64, String, Double) -> Void
    ) {
        let dims = query.count
        guard dims > 0 else { return }

        var dataVersion: Int64 = 0
        _ = select(reader, "PRAGMA data_version;") { dataVersion = sqlite3_column_int64($0, 0) }
        let localGen = localWriteLock.withLock { localWriteGeneration }
        let versionKey = "\(dataVersion):\(localGen)"
        let cacheKey = "\(model)\n\(kind ?? "")"

        let cached = vectorCacheLock.withLock { vectorMatrixCache[cacheKey] }
        let entry: CachedVectorMatrix
        if let cached, cached.versionKey == versionKey && cached.dims == dims {
            entry = cached
        } else {
            entry = loadVectorMatrix(reader, model: model, kind: kind, dims: dims, versionKey: versionKey)
        }

        let rowCount = entry.rowCount
        guard rowCount > 0 else { return }

        var scores = [Float](repeating: 0, count: rowCount)
        entry.matrix.withUnsafeBufferPointer { matPtr in
            query.withUnsafeBufferPointer { qPtr in
                scores.withUnsafeMutableBufferPointer { outPtr in
                    guard let matBase = matPtr.baseAddress,
                          let qBase = qPtr.baseAddress,
                          let outBase = outPtr.baseAddress else { return }
                    vDSP_mmul(matBase, 1, qBase, 1, outBase, 1, vDSP_Length(rowCount), 1, vDSP_Length(dims))
                }
            }
        }

        // Keep top-K candidates in O(N) without sorting the full corpus, then rescore exact float32 vectors.
        let topK = min(rowCount, 160)
        var topCandidates: [(index: Int, score: Float)] = []
        topCandidates.reserveCapacity(topK)
        var minScoreInTop: Float = -Float.greatestFiniteMagnitude
        var minPosInTop = 0

        for idx in 0..<rowCount {
            let s = scores[idx]
            if topCandidates.count < topK {
                if s < minScoreInTop {
                    minScoreInTop = s
                    minPosInTop = topCandidates.count
                }
                topCandidates.append((idx, s))
            } else if s > minScoreInTop {
                topCandidates[minPosInTop] = (idx, s)
                var nextMin: Float = Float.greatestFiniteMagnitude
                var nextPos = 0
                for (j, item) in topCandidates.enumerated() {
                    if item.score < nextMin {
                        nextMin = item.score
                        nextPos = j
                    }
                }
                minScoreInTop = nextMin
                minPosInTop = nextPos
            }
        }

        let topChunkIds = topCandidates.map { entry.chunkIds[$0.index] }
        guard !topChunkIds.isEmpty else { return }

        let byteCount = dims * MemoryLayout<Float>.stride
        let length = vDSP_Length(dims)
        let buffer = UnsafeMutablePointer<Float>.allocate(capacity: dims)
        defer { buffer.deallocate() }
        let placeholders = Array(repeating: "?", count: topChunkIds.count).joined(separator: ",")

        query.withUnsafeBufferPointer { coefficients in
            guard let queryValues = coefficients.baseAddress else { return }
            _ = select(reader, """
                SELECT c.id, c.doc_id, c.embedding
                FROM chunks c
                WHERE c.id IN (\(placeholders)) AND length(c.embedding) = ?;
                """, bind: { stmt in
                for (i, id) in topChunkIds.enumerated() {
                    sqlite3_bind_int64(stmt, Int32(i + 1), id)
                }
                sqlite3_bind_int(stmt, Int32(topChunkIds.count + 1), Int32(byteCount))
            }) { stmt in
                guard let blob = sqlite3_column_blob(stmt, 2) else { return }
                memcpy(buffer, blob, byteCount)
                var dot: Float = 0
                var energy: Float = 0
                vDSP_dotpr(queryValues, 1, buffer, 1, &dot, length)
                vDSP_svesq(buffer, 1, &energy, length)
                let cosine = energy > 1e-12 ? min(1, max(0, Double(dot / sqrtf(energy)))) : 0
                row(sqlite3_column_int64(stmt, 0), columnText(stmt, 1), cosine)
            }
        }
    }

    private func fetchCandidateRows(_ reader: OpaquePointer, ranked: [RankedChunk]) -> [Int64: CandidateRow] {
        guard !ranked.isEmpty else { return [:] }
        let placeholders = Array(repeating: "?", count: ranked.count).joined(separator: ",")
        var rows: [Int64: CandidateRow] = [:]
        _ = select(reader, """
            SELECT c.id, d.kind, d.title, d.path, c.section_label, c.text
            FROM chunks c JOIN docs d ON d.doc_id = c.doc_id
            WHERE c.id IN (\(placeholders));
            """, bind: { stmt in
            for (index, candidate) in ranked.enumerated() {
                sqlite3_bind_int64(stmt, Int32(index + 1), candidate.id)
            }
        }) { stmt in
            rows[sqlite3_column_int64(stmt, 0)] = CandidateRow(
                kind: columnText(stmt, 1),
                title: columnText(stmt, 2),
                path: columnText(stmt, 3),
                sectionLabel: columnText(stmt, 4),
                rawText: columnText(stmt, 5)
            )
        }
        return rows
    }

    // MARK: - Local Ollama HTTP Client

    private func discoverOllamaModels() -> OllamaDiscovery {
        guard let url = URL(string: "\(ollamaBaseURL)/api/tags") else {
            return OllamaDiscovery(
                online: false,
                embedModel: Self.defaultEmbedModel,
                chatModels: [],
                activeChatModel: Self.preferredChatModels[0]
            )
        }

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.timeoutInterval = 2.5

        guard let (data, statusCode) = performSyncRequest(request, timeout: 3.0),
              statusCode == 200,
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let modelsArray = json["models"] as? [[String: Any]] else {
            return OllamaDiscovery(
                online: false,
                embedModel: Self.defaultEmbedModel,
                chatModels: [],
                activeChatModel: Self.preferredChatModels[0]
            )
        }

        let names: [String] = modelsArray.compactMap { $0["name"] as? String }

        // Best embedding model (prefer EmbeddingGemma 2 multimodal, then Qwen3-Embedding, then any other embed model)
        let embedKeywords = ["embed", "nomic", "bge", "mxbai"]
        let embedModel: String = {
            for pref in Self.preferredEmbedModels {
                if let found = names.first(where: { $0 == pref || $0.hasPrefix("\(pref):") || $0.lowercased().hasPrefix(pref) }) {
                    return found
                }
            }
            if let matched = names.first(where: { name in
                let lower = name.lowercased()
                return embedKeywords.contains { lower.contains($0) }
            }) {
                return matched
            }
            return Self.defaultEmbedModel
        }()

        // Non-embed chat models, sorted by preference
        let nonEmbed = names.filter { name in
            let lower = name.lowercased()
            return !embedKeywords.contains { lower.contains($0) }
        }

        var orderedChat: [String] = []
        for pref in Self.preferredChatModels {
            if let found = nonEmbed.first(where: { $0 == pref || $0.hasPrefix(pref) }), !orderedChat.contains(found) {
                orderedChat.append(found)
            }
        }
        for name in nonEmbed where !orderedChat.contains(name) {
            orderedChat.append(name)
        }

        let activeChat = orderedChat.first ?? Self.preferredChatModels[0]
        return OllamaDiscovery(
            online: true,
            embedModel: embedModel,
            chatModels: orderedChat,
            activeChatModel: activeChat
        )
    }

    private func embedMultimodalInputs(_ inputs: [[String: Any]], model: String) -> [[Float]]? {
        guard !inputs.isEmpty else { return [] }
        guard let url = URL(string: "\(ollamaBaseURL)/api/embed") else { return nil }

        let payload: [String: Any] = [
            "model": model,
            "input": inputs,
        ]
        guard let body = try? JSONSerialization.data(withJSONObject: payload) else { return nil }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
        request.timeoutInterval = 45

        if let (data, statusCode) = performSyncRequest(request, timeout: 50),
           statusCode == 200,
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let rawEmbeddings = json["embeddings"] as? [[NSNumber]],
           rawEmbeddings.count == inputs.count {
            return rawEmbeddings.map { row in row.map { $0.floatValue } }
        }
        return nil
    }

    private func embedTexts(_ texts: [String], model: String) -> [[Float]]? {
        guard !texts.isEmpty else { return [] }

        // Primary endpoint: POST /api/embed
        if let url = URL(string: "\(ollamaBaseURL)/api/embed") {
            let payload: [String: Any] = [
                "model": model,
                "input": texts,
            ]
            if let body = try? JSONSerialization.data(withJSONObject: payload) {
                var request = URLRequest(url: url)
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                request.httpBody = body
                request.timeoutInterval = 30

                if let (data, statusCode) = performSyncRequest(request, timeout: 35),
                   statusCode == 200,
                   let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                   let rawEmbeddings = json["embeddings"] as? [[NSNumber]],
                   rawEmbeddings.count == texts.count {
                    return rawEmbeddings.map { row in row.map { $0.floatValue } }
                }
            }
        }

        // Legacy fallback endpoint: POST /api/embeddings (single prompt per call)
        guard let legacyURL = URL(string: "\(ollamaBaseURL)/api/embeddings") else { return nil }
        var result: [[Float]] = []
        result.reserveCapacity(texts.count)

        for text in texts {
            let payload: [String: Any] = [
                "model": model,
                "prompt": text,
            ]
            guard let body = try? JSONSerialization.data(withJSONObject: payload) else { return nil }
            var request = URLRequest(url: legacyURL)
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = body
            request.timeoutInterval = 20

            guard let (data, statusCode) = performSyncRequest(request, timeout: 25),
                  statusCode == 200,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let rawVec = json["embedding"] as? [NSNumber] else {
                return nil
            }
            result.append(rawVec.map { $0.floatValue })
        }

        return result
    }

    private func chatSync(
        messages: [(role: String, content: String)],
        requestedModel: String?
    ) -> [String: Any] {
        let discovery = discoverOllamaModels()
        guard discovery.online else {
            return [
                "ok": false,
                "error": "Ollama is not running on http://127.0.0.1:11434. Start Ollama (`ollama serve`) to chat locally.",
            ]
        }

        let chosenModel: String = {
            if let req = requestedModel?.trimmingCharacters(in: .whitespacesAndNewlines), !req.isEmpty {
                return req
            }
            return discovery.activeChatModel
        }()

        guard let url = URL(string: "\(ollamaBaseURL)/api/chat") else {
            return ["ok": false, "error": "Invalid Ollama URL"]
        }

        let serializedMessages: [[String: String]] = messages.map { ["role": $0.role, "content": $0.content] }

        // First attempt with `think: false` for fast crisp answers on qwen3 / qwen3.5 models
        let firstPayload: [String: Any] = [
            "model": chosenModel,
            "messages": serializedMessages,
            "stream": false,
            "think": false,
        ]

        if let response = executeChatPayload(url: url, payload: firstPayload, model: chosenModel) {
            return response
        }

        // Retry without `think` flag in case model or older Ollama rejects the parameter
        let fallbackPayload: [String: Any] = [
            "model": chosenModel,
            "messages": serializedMessages,
            "stream": false,
        ]
        if let response = executeChatPayload(url: url, payload: fallbackPayload, model: chosenModel) {
            return response
        }

        return [
            "ok": false,
            "model": chosenModel,
            "error": "Local Ollama chat request failed for model '\(chosenModel)'. Verify the model is pulled.",
        ]
    }

    private func executeChatPayload(url: URL, payload: [String: Any], model: String) -> [String: Any]? {
        guard let body = try? JSONSerialization.data(withJSONObject: payload) else { return nil }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
        request.timeoutInterval = 115

        guard let (data, statusCode) = performSyncRequest(request, timeout: 120) else {
            return nil
        }

        guard statusCode == 200,
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let message = json["message"] as? [String: Any],
              let rawContent = message["content"] as? String else {
            return nil
        }

        let cleaned = Self.stripThinkBlocks(rawContent)
        return [
            "ok": true,
            "model": (json["model"] as? String) ?? model,
            "content": cleaned,
        ]
    }

    private func performSyncRequest(_ request: URLRequest, timeout: TimeInterval) -> (Data, Int)? {
        final class ResultBox: @unchecked Sendable {
            var data: Data?
            var statusCode: Int = 0
        }
        let box = ResultBox()
        let semaphore = DispatchSemaphore(value: 0)

        let task = session.dataTask(with: request) { data, response, _ in
            box.data = data
            box.statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0
            semaphore.signal()
        }
        task.resume()

        let waitResult = semaphore.wait(timeout: .now() + timeout)
        if waitResult == .timedOut {
            task.cancel()
            return nil
        }
        guard let data = box.data else { return nil }
        return (data, box.statusCode)
    }

    // MARK: - Vision OCR for Scanned PDF Pages

    private func ocrPdfPageSync(path: String?, pageIndex: Int, base64Pdf: String?) -> [String: Any] {
        var document: PDFDocument? = nil
        if let path, !path.isEmpty, FileManager.default.fileExists(atPath: path) {
            document = PDFDocument(url: URL(fileURLWithPath: path))
        }
        if document == nil, let b64 = base64Pdf, !b64.isEmpty, let data = Data(base64Encoded: b64) {
            document = PDFDocument(data: data)
        }

        guard let pdfDoc = document else {
            return [
                "ok": false,
                "pageIndex": pageIndex,
                "text": "",
                "lines": [],
                "error": "Could not load PDF document for OCR",
            ]
        }

        guard pageIndex >= 0 && pageIndex < pdfDoc.pageCount,
              let page = pdfDoc.page(at: pageIndex) else {
            return [
                "ok": false,
                "pageIndex": pageIndex,
                "text": "",
                "lines": [],
                "error": "Invalid PDF pageIndex: \(pageIndex)",
            ]
        }

        let mediaBox = page.bounds(for: .mediaBox)
        let maxDim = max(1.0, max(mediaBox.width, mediaBox.height))
        let scale = min(2.0, 2200.0 / maxDim)
        let pixelWidth = max(1, Int((mediaBox.width * scale).rounded()))
        let pixelHeight = max(1, Int((mediaBox.height * scale).rounded()))

        let colorSpace = CGColorSpaceCreateDeviceRGB()
        let bitmapInfo = CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue

        guard let ctx = CGContext(
            data: nil,
            width: pixelWidth,
            height: pixelHeight,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: colorSpace,
            bitmapInfo: bitmapInfo
        ) else {
            return [
                "ok": false,
                "pageIndex": pageIndex,
                "text": "",
                "lines": [],
                "error": "Failed to create CoreGraphics rendering context",
            ]
        }

        ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: pixelWidth, height: pixelHeight))
        ctx.interpolationQuality = .high
        ctx.scaleBy(x: scale, y: scale)
        ctx.translateBy(x: -mediaBox.origin.x, y: -mediaBox.origin.y)
        page.draw(with: .mediaBox, to: ctx)

        guard let cgImage = ctx.makeImage() else {
            return [
                "ok": false,
                "pageIndex": pageIndex,
                "text": "",
                "lines": [],
                "error": "Failed to rasterize PDF page",
            ]
        }

        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = true

        let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
        do {
            try handler.perform([request])
        } catch {
            return [
                "ok": false,
                "pageIndex": pageIndex,
                "text": "",
                "lines": [],
                "error": "Vision OCR failed: \(error.localizedDescription)",
            ]
        }

        let observations = request.results ?? []
        var parsedLines: [(text: String, x: Double, y: Double, width: Double, height: Double)] = []
        parsedLines.reserveCapacity(observations.count)

        for obs in observations {
            guard let top = obs.topCandidates(1).first else { continue }
            let text = top.string.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { continue }
            let bbox = obs.boundingBox
            // Convert Vision normalized bottom-left coordinates into top-left 0..1 coordinates
            let x = max(0.0, min(1.0, Double(bbox.origin.x)))
            let y = max(0.0, min(1.0, Double(1.0 - bbox.origin.y - bbox.size.height)))
            let w = max(0.0, min(1.0 - x, Double(bbox.size.width)))
            let h = max(0.0, min(1.0 - y, Double(bbox.size.height)))
            parsedLines.append((text: text, x: x, y: y, width: w, height: h))
        }

        // Sort reading order: top-to-bottom, left-to-right within same visual row
        parsedLines.sort { a, b in
            if abs(a.y - b.y) > 0.012 {
                return a.y < b.y
            }
            return a.x < b.x
        }

        let fullText = parsedLines.map(\.text).joined(separator: "\n")
        let lineDicts: [[String: Any]] = parsedLines.map { line in
            [
                "text": line.text,
                "x": (line.x * 10000.0).rounded() / 10000.0,
                "y": (line.y * 10000.0).rounded() / 10000.0,
                "width": (line.width * 10000.0).rounded() / 10000.0,
                "height": (line.height * 10000.0).rounded() / 10000.0,
            ]
        }

        return [
            "ok": true,
            "pageIndex": pageIndex,
            "text": fullText,
            "lines": lineDicts,
        ]
    }

    // MARK: - Text Chunking, Hashing & Vector Math Helpers

    private func sha256Hex(_ text: String) -> String {
        let digest = SHA256.hash(data: Data(text.utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    private func chunkText(
        _ input: String,
        maxChunkChars: Int,
        overlapChars: Int,
        maxChunks: Int
    ) -> [DocumentChunk] {
        let normalized = input.replacingOccurrences(of: "\r\n", with: "\n")
        let lines = normalized.components(separatedBy: "\n")

        // Group into logical sections while tracking markdown/page/sheet/slide headers
        var sections: [(label: String, body: String)] = []
        var currentLabel = ""
        var currentLines: [String] = []

        func flushSection() {
            let joined = currentLines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
            if !joined.isEmpty {
                sections.append((label: currentLabel, body: joined))
            }
            currentLines.removeAll(keepingCapacity: true)
        }

        for line in lines {
            let trimmedLine = line.trimmingCharacters(in: .whitespaces)
            if trimmedLine.hasPrefix("#") {
                flushSection()
                let heading = trimmedLine.drop(while: { $0 == "#" || $0 == " " })
                currentLabel = String(heading).prefix(80).trimmingCharacters(in: .whitespaces)
                currentLines.append(line)
            } else {
                currentLines.append(line)
            }
        }
        flushSection()

        if sections.isEmpty {
            sections = [(label: "", body: normalized.trimmingCharacters(in: .whitespacesAndNewlines))]
        }

        var chunks: [DocumentChunk] = []
        for section in sections {
            if chunks.count >= maxChunks { break }
            let chars = Array(section.body)
            if chars.count <= maxChunkChars {
                chunks.append(DocumentChunk(index: chunks.count, sectionLabel: section.label, text: section.body))
                continue
            }

            var start = 0
            while start < chars.count && chunks.count < maxChunks {
                var end = min(start + maxChunkChars, chars.count)
                if end < chars.count {
                    // Prefer breaking at a newline or whitespace boundary near end
                    let searchBack = max(start + (maxChunkChars / 2), end - 140)
                    var breakPos = end
                    for pos in stride(from: end - 1, through: searchBack, by: -1) {
                        if chars[pos] == "\n" || chars[pos] == " " || chars[pos] == "." {
                            breakPos = pos + 1
                            break
                        }
                    }
                    end = breakPos
                }
                let slice = String(chars[start..<end]).trimmingCharacters(in: .whitespacesAndNewlines)
                if !slice.isEmpty {
                    chunks.append(DocumentChunk(index: chunks.count, sectionLabel: section.label, text: slice))
                }
                if end >= chars.count { break }
                start = max(end - overlapChars, start + 1)
            }
        }

        return chunks
    }

    private static func stripThinkBlocks(_ content: String) -> String {
        var result = content
        while let openRange = result.range(of: "<think>"),
              let closeRange = result.range(of: "</think>", range: openRange.lowerBound..<result.endIndex) {
            result.removeSubrange(openRange.lowerBound..<closeRange.upperBound)
        }
        return result.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func encodeFloat32LittleEndian(_ values: [Float]) -> Data {
        var data = Data(capacity: values.count * 4)
        for v in values {
            var le = v.bitPattern.littleEndian
            withUnsafeBytes(of: &le) { bytes in
                data.append(contentsOf: bytes)
            }
        }
        return data
    }

    private static func encodeInt8Normalized(_ values: [Float]) -> Data {
        var data = Data(capacity: values.count)
        for v in values {
            let clamped = max(-127, min(127, Int((v * 127.0).rounded())))
            data.append(UInt8(bitPattern: Int8(clamped)))
        }
        return data
    }

    private static func l2Normalize(_ values: [Float]) -> [Float] {
        var sumSq: Float = 0
        for v in values { sumSq += v * v }
        let norm = sqrtf(sumSq)
        guard norm > 1e-8 else { return values }
        return values.map { $0 / norm }
    }

    private static func tokenize(_ text: String) -> [String] {
        var tokens: [String] = []
        var current = ""
        for scalar in text.lowercased().unicodeScalars {
            if CharacterSet.alphanumerics.contains(scalar) || scalar == "_" {
                current.unicodeScalars.append(scalar)
            } else if !current.isEmpty {
                if current.count >= 2 {
                    tokens.append(current)
                }
                current.removeAll(keepingCapacity: true)
            }
        }
        if current.count >= 2 {
            tokens.append(current)
        }
        return tokens
    }

    private static func makeSnippet(text: String, queryTerms: [String], maxChars: Int) -> String {
        let collapsed = text
            .replacingOccurrences(of: "\n", with: " ")
            .replacingOccurrences(of: "  ", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard collapsed.count > maxChars else { return collapsed }

        let lower = collapsed.lowercased()
        var matchIndex: String.Index? = nil
        for term in queryTerms {
            if let range = lower.range(of: term) {
                if matchIndex == nil || range.lowerBound < matchIndex! {
                    matchIndex = range.lowerBound
                }
            }
        }

        guard let anchor = matchIndex else {
            return String(collapsed.prefix(maxChars)).trimmingCharacters(in: .whitespaces) + "…"
        }

        let startOffset = max(0, lower.distance(from: lower.startIndex, to: anchor) - 60)
        let startIdx = collapsed.index(collapsed.startIndex, offsetBy: min(startOffset, collapsed.count))
        let endOffset = min(collapsed.count, startOffset + maxChars)
        let endIdx = collapsed.index(collapsed.startIndex, offsetBy: endOffset)

        let prefix = startOffset > 0 ? "…" : ""
        let suffix = endOffset < collapsed.count ? "…" : ""
        return prefix + String(collapsed[startIdx..<endIdx]).trimmingCharacters(in: .whitespaces) + suffix
    }
}
