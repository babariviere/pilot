import AppKit
import CoreLocation
import CoreWLAN
import Network

// An independent accessory application. No location coordinates, scans, passwords or disk storage.
final class WiFiAgent: NSObject, NSApplicationDelegate, CLLocationManagerDelegate, CWEventDelegate {
    private let location = CLLocationManager()
    private let wifi = CWWiFiClient.shared()
    private let work = DispatchQueue(label: "pilot.wifi")
    private var connection: NWConnection?
    private var input = Data()
    private var pendingSample: DispatchWorkItem?
    private var monitorError = false
    private var authorizationRequested = false
    private var wakeObserver: NSObjectProtocol?

    func applicationDidFinishLaunching(_ notification: Notification) {
        guard CommandLine.arguments.count == 3,
              let port = NWEndpoint.Port(CommandLine.arguments[1]) else { exit(1) }
        location.delegate = self
        let connection = NWConnection(host: "127.0.0.1", port: port, using: .tcp)
        self.connection = connection
        connection.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready:
                self?.send(["token": CommandLine.arguments[2]])
                self?.receive()
                self?.sample()
            case .failed, .cancelled: exit(0)
            default: break
            }
        }
        wifi.delegate = self
        work.async { [weak self] in
            guard let self else { return }
            do {
                try self.wifi.startMonitoringEvent(with: .ssidDidChange)
                try self.wifi.startMonitoringEvent(with: .powerDidChange)
                try self.wifi.startMonitoringEvent(with: .linkDidChange)
            } catch { self.monitorError = true }
            connection.start(queue: .main)
        }
        wakeObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification, object: nil, queue: .main
        ) { [weak self] _ in self?.sample() }
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
                if command["authorize"] == true && self.location.authorizationStatus == .notDetermined {
                    // CoreLocation ignores requests from an app not currently in use.
                    // Foreground only in response to the app's explicit user action, never on GET/startup.
                    self.authorizationRequested = true
                    NSApp.activate(ignoringOtherApps: true)
                    self.requestAuthorizationIfActive()
                }
                self.sample()
            }
            if complete || error != nil { exit(0) }
            self.receive()
        }
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) { sample() }
    func applicationDidBecomeActive(_ notification: Notification) { requestAuthorizationIfActive() }
    private func requestAuthorizationIfActive() {
        guard authorizationRequested && NSApp.isActive else { return }
        authorizationRequested = false
        location.requestAlwaysAuthorization()
    }
    func ssidDidChangeForWiFiInterface(withName interfaceName: String) { scheduleSample() }
    func powerStateDidChangeForWiFiInterface(withName interfaceName: String) { scheduleSample() }
    func linkDidChangeForWiFiInterface(withName interfaceName: String) { scheduleSample() }

    private func scheduleSample() { DispatchQueue.main.async { [weak self] in self?.sample() } }
    private func sample() {
        dispatchPrecondition(condition: .onQueue(.main))
        let status = location.authorizationStatus
        // CW calls and global Location Services queries can block. Keep them off the main run loop.
        work.async { [weak self] in
            guard let self else { return }
            self.pendingSample?.cancel()
            let sample = DispatchWorkItem { [weak self] in self?.report(status) }
            self.pendingSample = sample
            self.work.asyncAfter(deadline: .now() + 0.15, execute: sample)
        }
    }
    private func report(_ status: CLAuthorizationStatus) {
        let authorization: String
        if !CLLocationManager.locationServicesEnabled() { authorization = "disabled" }
        else {
            switch status {
            case .notDetermined: authorization = "not_determined"
            case .denied: authorization = "denied"
            case .restricted: authorization = "restricted"
            case .authorizedAlways, .authorizedWhenInUse: authorization = "authorized"
            @unknown default: authorization = "unavailable"
            }
        }
        let interface = wifi.interface()
        let current = authorization == "authorized" ? interface?.ssid() : nil
        // A running link with no SSID is redacted/unknown, not a departure from a saved network.
        let redacted = authorization == "authorized" && interface?.interfaceMode() == .station && current == nil
        let available = interface != nil && !monitorError && !redacted
        var known = Set<String>()
        if authorization == "authorized", let profiles = interface?.configuration()?.networkProfiles {
            for case let profile as CWNetworkProfile in profiles {
                if let name = profile.ssid, !name.isEmpty, name.utf8.count <= 32 { known.insert(name) }
            }
            if let current { known.insert(current) }
        }
        var result: [String: Any] = [
            "authorization": authorization, "available": available,
            "currentNetwork": current as Any? ?? NSNull(),
            "knownNetworks": Array(known.sorted().prefix(256)),
        ]
        if !available { result["error"] = "Wi-Fi monitoring unavailable." }
        send(result)
    }
    private func send(_ value: [String: Any]) {
        guard var data = try? JSONSerialization.data(withJSONObject: value) else { return }
        data.append(10)
        connection?.send(content: data, completion: .contentProcessed { error in if error != nil { exit(0) } })
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let agent = WiFiAgent()
app.delegate = agent
app.run()
