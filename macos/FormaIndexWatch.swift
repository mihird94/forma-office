import CoreServices
import Darwin
import Foundation

/// One background worker handles both targeted changes and scheduled reconciliation.
final class FormaIndexWatch: @unchecked Sendable {
    private let backend: FormaSemanticBackend
    private let store: FormaIndexConfigStore
    private let report: @Sendable ([String: Any]) -> Void
    private let queue = DispatchQueue(label: "com.formaoffice.indexer.watch", qos: .utility)
    private var config: FormaIndexConfig?
    private var stream: FSEventStreamRef?
    private var streamPaths: [String] = []
    private var statePath = ""
    private var lastReconcileRequest: Data?
    private var controlTimer: DispatchSourceTimer?
    private var pendingPaths: [String: Bool] = [:]
    private var reconcile = true
    private var workScheduled = false
    private var active: FormaIndexCancellation?

    init(backend: FormaSemanticBackend, store: FormaIndexConfigStore, report: @escaping @Sendable ([String: Any]) -> Void) {
        self.backend = backend
        self.store = store
        self.report = report
    }

    static func requestReconcile(store: FormaIndexConfigStore) throws {
        try ensureFormaPrivateDirectory(store.directory)
        try Data(UUID().uuidString.utf8).write(to: store.reconcileRequestURL, options: .atomic)
    }

    func run() throws -> Never {
        try withFormaFileLock(store.watchLockURL, operation: LOCK_EX | LOCK_NB) {
            queue.sync {
                statePath = FormaIndexConfig.canonicalPath(store.directory.path) ?? store.directory.path
                reloadControlFiles()
                report(["ok": true, "watching": stream != nil])
                // A small control-file check also catches a calendar request if FSEvents is unavailable.
                let timer = DispatchSource.makeTimerSource(queue: queue)
                timer.schedule(deadline: .now() + 30, repeating: 30, leeway: .seconds(2))
                timer.setEventHandler { [weak self] in self?.reloadControlFiles() }
                timer.resume()
                controlTimer = timer
            }
            dispatchMain()
        }
    }

    private func reloadControlFiles(restartStream: Bool = false) {
        do {
            let latest = try store.loadIndexConfig()
            if config?.hasSameScanSettings(as: latest) != true {
                config = latest
                reconcile = true
                active?.cancel()
            }
            if updateStream(for: latest.watchedFolders, force: restartStream) { reconcile = true }
        } catch {
            report(["ok": false, "error": error.localizedDescription])
        }
        let request = try? Data(contentsOf: store.reconcileRequestURL)
        if request != lastReconcileRequest {
            lastReconcileRequest = request
            if request != nil { reconcile = true }
        }
        scheduleWork()
    }

    private func updateStream(for roots: [String], force: Bool) -> Bool {
        // Watch the nearest existing parent when a configured root is temporarily offline.
        let paths = Set(roots.map { root -> String in
            var parent = URL(fileURLWithPath: root, isDirectory: true)
            while parent.path != "/", FormaIndexConfig.existingDirectory(parent.path) != parent.path {
                parent.deleteLastPathComponent()
            }
            return parent.path
        } + [statePath]).sorted()
        guard force || paths != streamPaths || stream == nil else { return false }
        var context = FSEventStreamContext()
        context.info = Unmanaged.passUnretained(self).toOpaque()
        let flags = FSEventStreamCreateFlags(kFSEventStreamCreateFlagUseCFTypes | kFSEventStreamCreateFlagFileEvents
            | kFSEventStreamCreateFlagWatchRoot)
        guard let next = FSEventStreamCreate(nil, { _, info, count, paths, flags, _ in
            guard let info else { return }
            let watcher = Unmanaged<FormaIndexWatch>.fromOpaque(info).takeUnretainedValue()
            let array = Unmanaged<CFArray>.fromOpaque(paths).takeUnretainedValue()
            guard let names = array as NSArray as? [String] else { return }
            watcher.receive(names, flags: UnsafeBufferPointer(start: flags, count: count))
        }, &context, paths as CFArray, FSEventStreamEventId(kFSEventStreamEventIdSinceNow), 0.5, flags) else {
            report(["ok": false, "error": "Could not create the Forma file-change stream"])
            return false
        }
        FSEventStreamSetDispatchQueue(next, queue)
        guard FSEventStreamStart(next) else {
            FSEventStreamInvalidate(next)
            FSEventStreamRelease(next)
            report(["ok": false, "error": "Could not start the Forma file-change stream"])
            return false
        }
        if let stream {
            FSEventStreamStop(stream)
            FSEventStreamInvalidate(stream)
            FSEventStreamRelease(stream)
        }
        stream = next
        streamPaths = paths
        return true
    }

    private func receive(_ paths: [String], flags: UnsafeBufferPointer<FSEventStreamEventFlags>) {
        let recovery = FSEventStreamEventFlags(kFSEventStreamEventFlagMustScanSubDirs | kFSEventStreamEventFlagEventIdsWrapped
            | kFSEventStreamEventFlagRootChanged | kFSEventStreamEventFlagMount | kFSEventStreamEventFlagUnmount)
        let resubscribe = FSEventStreamEventFlags(kFSEventStreamEventFlagRootChanged | kFSEventStreamEventFlagEventIdsWrapped)
        let treeChanges = FSEventStreamEventFlags(kFSEventStreamEventFlagItemCreated | kFSEventStreamEventFlagItemRemoved
            | kFSEventStreamEventFlagItemRenamed | kFSEventStreamEventFlagItemFinderInfoMod)
        let fileChanges = treeChanges | FSEventStreamEventFlags(kFSEventStreamEventFlagItemModified
            | kFSEventStreamEventFlagItemInodeMetaMod | kFSEventStreamEventFlagItemCloned)
        let configPath = statePath + "/" + store.configURL.lastPathComponent
        let requestPath = statePath + "/" + store.reconcileRequestURL.lastPathComponent
        var rereadControls = false
        var restartStream = false
        // FSEvents reports the real paths subscribed above. Foundation standardization can strip
        // /private for existing items, which would make a save and a deletion use different keys.
        for (path, flags) in zip(paths, flags) {
            if flags & recovery != 0 {
                reconcile = true
                rereadControls = true
                restartStream = restartStream || flags & resubscribe != 0
            }
            if path == configPath || path == requestPath { rereadControls = true }
            guard !reconcile, !FormaIndexConfig.contains(path, in: statePath),
                  config?.watchedFolders.contains(where: { FormaIndexConfig.contains(path, in: $0) }) == true else { continue }
            let directory = flags & FSEventStreamEventFlags(kFSEventStreamEventFlagItemIsDir) != 0
            if directory {
                guard flags & treeChanges != 0 else { continue }
            } else {
                guard flags & fileChanges != 0,
                      FormaDocExtractors.kind(for: (path as NSString).pathExtension.lowercased(), includeImages: true) != nil else { continue }
            }
            pendingPaths[path] = (pendingPaths[path] ?? false) || directory
            if pendingPaths.count > 256 {
                pendingPaths.removeAll(keepingCapacity: true)
                reconcile = true
            }
        }
        if rereadControls {
            let restart = restartStream
            // A stream can be replaced after its current callback returns.
            queue.async { self.reloadControlFiles(restartStream: restart) }
        } else {
            scheduleWork()
        }
    }

    private func scheduleWork() {
        guard active == nil, !workScheduled, reconcile || !pendingPaths.isEmpty else { return }
        workScheduled = true
        queue.asyncAfter(deadline: .now() + (reconcile ? .milliseconds(100) : .seconds(2))) {
            self.startWork()
        }
    }

    private func startWork() {
        workScheduled = false
        let changes = reconcile ? nil : pendingPaths.map { FormaIndexChange(path: $0.key, includesDescendants: $0.value) }
        reconcile = false
        pendingPaths.removeAll(keepingCapacity: true)
        let cancellation = FormaIndexCancellation()
        active = cancellation
        let mode = changes == nil ? "full" : "changes"
        backend.refreshWatchedFolders(changes: changes, cancellation: cancellation) { result in
            var summary = result
            summary["mode"] = mode
            self.report(summary)
            self.queue.async {
                self.active = nil
                self.scheduleWork()
            }
        }
    }
}
