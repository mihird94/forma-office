import Foundation
import Darwin

private enum CLIError: LocalizedError {
    case usage(String)
    var errorDescription: String? {
        switch self { case let .usage(message): return message }
    }
}

@main
struct FormaIndexerCLI {
    private static let usage = """
        forma-indexer sync [--force] [--json]
        forma-indexer watch [--json]
        forma-indexer request-sync [--json]
        forma-indexer index <path> [--force] [--json]
        forma-indexer search <query> [--kind <kind>] [--limit <n>] [--json]
        forma-indexer read <path-or-doc-id> [--max-chars <n>] [--ocr] [--json]
        forma-indexer folders list|add <dir>|remove <dir> [--json]
        forma-indexer status [--json]
        """

    static func main() {
        let arguments = Array(CommandLine.arguments.dropFirst())
        let json = arguments.contains("--json")
        if arguments.first == "--help" || arguments.first == "-h" {
            print(usage)
            return
        }
        do {
            let watching = arguments.first == "watch"
            let requestSync = arguments.first == "request-sync"
            if watching || requestSync {
                guard arguments.dropFirst().allSatisfy({ $0 == "--json" }) else {
                    throw CLIError.usage("\(arguments[0]) only accepts --json")
                }
            }
            let store = FormaIndexConfigStore(directory: FormaIndexConfigStore.stateDirectory)
            if requestSync {
                try FormaIndexWatch.requestReconcile(store: store)
                write(["ok": true, "queued": true], json: json)
                return
            }
            let body = watching ? [:] : try requestBody(arguments)
            let backend = FormaSemanticBackend(allowOllamaFallback: false)
            let signalHandlers = [SIGINT, SIGTERM].map { code in
                Darwin.signal(code, SIG_IGN)
                let handler = DispatchSource.makeSignalSource(signal: code, queue: .global(qos: .utility))
                handler.setEventHandler {
                    backend.shutdown()
                    Darwin.exit(watching ? 0 : 128 + code)
                }
                handler.resume()
                return handler
            }
            if watching {
                let watcher = FormaIndexWatch(backend: backend, store: store) { write($0, json: json) }
                // Keep the signal subscriptions alive for the lifetime of the watch process.
                try withExtendedLifetime(signalHandlers) { try watcher.run() }
            }
            let result = invoke(backend, body)
            backend.shutdown()
            for handler in signalHandlers { handler.cancel() }
            write(result, json: json)
            if result["ok"] as? Bool != true { Darwin.exit(1) }
        } catch {
            write(["ok": false, "error": error.localizedDescription], json: json)
            if !json { fputs("\(usage)\n", stderr) }
            Darwin.exit(2)
        }
    }

    private static func invoke(_ backend: FormaSemanticBackend, _ body: [String: Any]) -> [String: Any] {
        final class Reply: @unchecked Sendable {
            var payload: [String: Any] = [:]
        }
        let reply = Reply()
        let complete = DispatchSemaphore(value: 0)
        backend.handleAIRequest(body) { payload in
            reply.payload = payload
            complete.signal()
        }
        complete.wait()
        return reply.payload
    }

    private static func requestBody(_ arguments: [String]) throws -> [String: Any] {
        guard let command = arguments.first else { throw CLIError.usage("A subcommand is required") }
        // MCP passes positional inputs first and uses separate argv entries. A query may contain spaces.
        var args = Array(arguments.dropFirst())
        func positional(_ label: String) throws -> String {
            guard !args.isEmpty else { throw CLIError.usage("Missing \(label)") }
            let literal = args.first == "--"
            if literal { args.removeFirst() }
            guard let value = args.first, (literal || value != "--json"),
                  !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                throw CLIError.usage("Missing \(label)")
            }
            args.removeFirst()
            return value
        }
        var body: [String: Any]
        var flags: [String: String] = [:]
        var valuedOptions: [String: String] = [:]
        switch command {
        case "sync":
            body = ["action": "syncWatchedFolders"]
            flags["--force"] = "force"
        case "index":
            body = ["action": "indexPath", "path": try positional("path")]
            flags["--force"] = "force"
        case "search":
            body = ["action": "semanticSearch", "query": try positional("query")]
            valuedOptions = ["--kind": "kindFilter", "--limit": "limit"]
        case "read":
            body = ["action": "readDocument", "target": try positional("file path or document ID")]
            flags["--ocr"] = "ocr"
            valuedOptions["--max-chars"] = "maxChars"
        case "folders":
            switch try positional("folder action") {
            case "list": body = ["action": "getIndexConfig"]
            case "add": body = ["action": "addWatchedFolder", "path": try positional("folder path"), "syncAfterAdd": false]
            case "remove": body = ["action": "removeWatchedFolder", "path": try positional("folder path")]
            default: throw CLIError.usage("Folder action must be list, add, or remove")
            }
        case "status":
            body = ["action": "getIndexConfig"]
        default:
            throw CLIError.usage("Unknown command: \(command)")
        }

        var i = 0
        while i < args.count {
            let argument = args[i]
            i += 1
            if argument == "--json" { continue }
            if let key = flags[argument] {
                body[key] = true
            } else if let key = valuedOptions[argument], i < args.count {
                let value = args[i]
                i += 1
                if key == "kindFilter" {
                    guard ["all", "document", "spreadsheet", "slides", "pdf", "notebook", "canvas", "image"].contains(value) else {
                        throw CLIError.usage("Unknown file kind: \(value)")
                    }
                    body[key] = value
                } else {
                    let maximum = key == "limit" ? 50 : 250_000
                    guard let number = Int(value), (1...maximum).contains(number) else {
                        throw CLIError.usage("\(argument) requires an integer from 1 to \(maximum)")
                    }
                    body[key] = number
                }
            } else {
                throw CLIError.usage("Unknown option or missing value: \(argument)")
            }
        }
        return body
    }

    private static func write(_ payload: [String: Any], json: Bool) {
        let options: JSONSerialization.WritingOptions = json
            ? [.sortedKeys, .withoutEscapingSlashes] : [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        guard let data = try? JSONSerialization.data(withJSONObject: payload, options: options) else {
            print(#"{"ok":false,"error":"Could not serialize the indexer response"}"#)
            return
        }
        print(String(decoding: data, as: UTF8.self))
        fflush(stdout)
    }
}
