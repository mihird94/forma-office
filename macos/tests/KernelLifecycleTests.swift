import Foundation
import Darwin

final class KernelEvents: @unchecked Sendable {
    private let lock = NSLock()
    private var events: [[String: Any]] = []
    func add(_ line: String) {
        guard let data = line.data(using: .utf8), let event = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return }
        lock.lock(); events.append(event); lock.unlock()
    }
    func wait(_ id: String, type: String? = nil, timeout: TimeInterval = 15) -> [String: Any] {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            lock.lock()
            let found = events.first { event in
                guard event["reqId"] as? String == id else { return false }
                if let type { return event["type"] as? String == type }
                return event["type"] as? String != "stream_chunk"
            }
            lock.unlock()
            if let found { return found }
            Thread.sleep(forTimeInterval: 0.02)
        }
        lock.lock(); let snapshot = events; lock.unlock()
        fatalError("Timed out waiting for \(id) \(type ?? "result"): \(snapshot)")
    }
}

@main struct KernelLifecycleTests {
    static func main() {
        let events = KernelEvents()
        let manager = PythonKernelManager { events.add($0) }
        defer { manager.stop() }
        manager.handleRequest(["action": "listEnvs", "reqId": "envs"])
        let environments = events.wait("envs")["envs"] as? [[String: String]] ?? []
        guard let first = environments.first?["path"] else { fatalError("No Python environment found") }
        let second = environments.dropFirst().first?["path"] ?? first

        manager.handleRequest(["action": "exec", "reqId": "long", "pythonPath": first,
                               "code": "import time\nprint('started', flush=True)\ntime.sleep(30)"])
        _ = events.wait("long", type: "stream_chunk")
        manager.handleRequest(["action": "restart", "reqId": "switch", "pythonPath": second])
        let cancelled = events.wait("long")
        precondition(cancelled["ok"] as? Bool == false && (cancelled["error"] as? String)?.contains("restarted") == true)
        let switched = events.wait("switch")
        precondition(switched["ok"] as? Bool == true && switched["activePath"] as? String == second, "Kernel switch did not become ready")
        Thread.sleep(forTimeInterval: 0.2)
        manager.handleRequest(["action": "exec", "reqId": "after-switch", "pythonPath": second, "code": "import sys\nprint(sys.executable)"])
        let switchedExecution = events.wait("after-switch")
        let outputs = switchedExecution["outputs"] as? [[String: Any]] ?? []
        precondition(switchedExecution["ok"] as? Bool == true && outputs.contains { ($0["text"] as? String)?.contains(second) == true }, "New kernel did not use the selected interpreter")

        manager.handleRequest(["action": "exec", "reqId": "interrupt-me", "pythonPath": second,
                               "code": "import time\nprint('started', flush=True)\ntime.sleep(30)"])
        _ = events.wait("interrupt-me", type: "stream_chunk")
        manager.handleRequest(["action": "interrupt", "reqId": "interrupt"])
        precondition(events.wait("interrupt")["ok"] as? Bool == true)
        let interrupted = events.wait("interrupt-me")
        precondition(interrupted["ok"] as? Bool == false, "Execution was not interrupted")
        manager.handleRequest(["action": "exec", "reqId": "after-interrupt", "pythonPath": second, "code": "print('still alive')"])
        precondition(events.wait("after-interrupt")["ok"] as? Bool == true, "Kernel did not recover after interrupt")

        let freshEvents = KernelEvents()
        let fresh = PythonKernelManager { freshEvents.add($0) }
        fresh.handleRequest(["action": "exec", "reqId": "early", "pythonPath": first, "code": "import time\ntime.sleep(30)"])
        fresh.handleRequest(["action": "interrupt", "reqId": "early-interrupt"])
        precondition(freshEvents.wait("early-interrupt")["ok"] as? Bool == true)
        precondition(freshEvents.wait("early")["ok"] as? Bool == false, "Startup interrupt was lost")
        fresh.handleRequest(["action": "exec", "reqId": "early-recovery", "pythonPath": first, "code": "print('recovered')"])
        precondition(freshEvents.wait("early-recovery")["ok"] as? Bool == true, "Kernel failed after startup interrupt")
        fresh.stop()
        print("Native kernel lifecycle tests passed")
    }
}
