import AppKit
import Network

// An independent accessory application for authenticated system-power events only.
final class SystemEventsAgent: NSObject, NSApplicationDelegate {
    private var connection: NWConnection?
    private var input = Data()
    private var power: SystemPowerMonitor?

    func applicationDidFinishLaunching(_ notification: Notification) {
        guard CommandLine.arguments.count == 3,
              let port = NWEndpoint.Port(CommandLine.arguments[1]) else { exit(1) }
        let connection = NWConnection(host: "127.0.0.1", port: port, using: .tcp)
        self.connection = connection
        connection.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready:
                self?.send(["token": CommandLine.arguments[2]])
                self?.power = SystemPowerMonitor { [weak self] value in self?.send(value) }
                self?.receive()
                self?.power?.report()
            case .failed, .cancelled: exit(0)
            default: break
            }
        }
        connection.start(queue: .main)
        // A failed daemon launch/connection cannot leave an orphan helper running indefinitely.
        DispatchQueue.main.asyncAfter(deadline: .now() + 15) {
            if connection.state != .ready { exit(0) }
        }
    }

    private func receive() {
        connection?.receive(minimumIncompleteLength: 1, maximumLength: 4096) { [weak self] data, _, complete, error in
            guard let self else { return }
            if let data { self.input.append(data) }
            if self.input.count > 8192 { exit(1) }
            while let newline = self.input.firstIndex(of: 10) {
                let line = self.input.prefix(upTo: newline)
                self.input.removeSubrange(...newline)
                guard let command = try? JSONSerialization.jsonObject(with: line) as? [String: Bool] else { exit(1) }
                if command["power"] == true { self.power?.report() }
            }
            if complete || error != nil { exit(0) }
            self.receive()
        }
    }

    private func send(_ value: [String: Any]) {
        guard var data = try? JSONSerialization.data(withJSONObject: value) else { return }
        data.append(10)
        connection?.send(content: data, completion: .contentProcessed { error in if error != nil { exit(0) } })
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let agent = SystemEventsAgent()
app.delegate = agent
app.run()
