import AppKit
import CoreGraphics
import IOKit
import IOKit.ps
import IOKit.pwr_mgt
import Network
import PilotPowerSupport

/// Event-driven sensors and a process-scoped idle assertion. No display assertion is held.
final class PowerRuntime {
    private let work = DispatchQueue(label: "pilot.power.operations", qos: .utility)
    private let wifi = NWPathMonitor(requiredInterfaceType: .wifi)
    private let network = NWPathMonitor()
    private var wifiConnected = false
    private var online = false
    private var sleeping = false
    private var closedLidActive = false
    private var authorized = false
    private var guardian: GuardianConnection?
    private var assertion: IOPMAssertionID = 0
    private var port: IONotificationPortRef?
    private var connection: io_connect_t = 0
    private var notifier: io_object_t = 0
    private var lidNotifier: io_object_t = 0
    private var capabilityNotifier: io_object_t = 0
    private var unsafeCutoff: DispatchWorkItem?
    private var root: io_service_t = 0
    private var acSource: CFRunLoopSource?
    private var sleepAcknowledgement = SleepAcknowledgement()
    private var buffer = Data()
    private var lastReport = Data()
    private var heartbeat = ProcessInfo.processInfo.systemUptime
    private var timer: DispatchSourceTimer?
    private var signals: [DispatchSourceSignal] = []
    private var stopping = false

    func start() {
        let context = Unmanaged.passUnretained(self).toOpaque()
        connection = IORegisterForSystemPower(context, &port, { context, _, message, argument in
            guard let context else { return }
            let runtime = Unmanaged<PowerRuntime>.fromOpaque(context).takeUnretainedValue()
            if message == 0xe0000270 { IOAllowPowerChange(runtime.connection, Int(bitPattern: argument)) }
            if message == 0xe0000280 {
                runtime.sleeping = true
                let generation = runtime.sleepAcknowledgement.begin(argument: Int(bitPattern: argument))
                runtime.report()
                // macOS grants a bounded preparation window. Never veto a requested sleep indefinitely.
                DispatchQueue.main.asyncAfter(deadline: .now() + SleepAcknowledgement.preparationTimeout) { [weak runtime] in
                    runtime?.allowSleep(generation: generation)
                }
            } else if message == 0xe0000300 {
                runtime.sleeping = false
                runtime.sleepAcknowledgement.woke()
                runtime.report()
            }
        }, &notifier)
        root = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOPMrootDomain"))
        if let port {
            if root != 0 {
                IOServiceAddInterestNotification(port, root, kIOGeneralInterest, { context, _, _, _ in
                    guard let context else { return }
                    Unmanaged<PowerRuntime>.fromOpaque(context).takeUnretainedValue().report()
                }, context, &lidNotifier)
            }
            if root != 0 {
                IOServiceAddInterestNotification(port, root, kIOPriorityPowerStateInterest, { context, _, message, argument in
                    guard let context, message == 0xe0000340, let argument else { return }
                    let runtime = Unmanaged<PowerRuntime>.fromOpaque(context).takeUnretainedValue()
                    let change = argument.assumingMemoryBound(to: IOPMSystemCapabilityChangeParameters.self).pointee
                    if change.changeFlags & UInt32(kIOPMSystemCapabilityDidChange) != 0 {
                        runtime.sleeping = change.toCapabilities & UInt32(kIOPMSystemCapabilityCPU) == 0
                        runtime.report(capabilities: change.toCapabilities)
                    }
                }, context, &capabilityNotifier)
            }
            IONotificationPortSetDispatchQueue(port, .main)
        }
        acSource = IOPSNotificationCreateRunLoopSource({ context in
            guard let context else { return }
            Unmanaged<PowerRuntime>.fromOpaque(context).takeUnretainedValue().report()
        }, context)?.takeRetainedValue()
        if let acSource { CFRunLoopAddSource(CFRunLoopGetMain(), acSource, .commonModes) }
        wifi.pathUpdateHandler = { [weak self] path in
            DispatchQueue.main.async { self?.wifiConnected = path.status == .satisfied; self?.report() }
        }
        network.pathUpdateHandler = { [weak self] path in
            DispatchQueue.main.async { self?.online = path.status == .satisfied; self?.report() }
        }
        let networkQueue = DispatchQueue(label: "pilot.power.network", qos: .utility)
        wifi.start(queue: networkQueue)
        network.start(queue: networkQueue)
        FileHandle.standardInput.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            DispatchQueue.main.async { self?.receive(data) }
        }
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now() + 5, repeating: 5)
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            if ProcessInfo.processInfo.systemUptime - self.heartbeat > 20 { self.shutdown() }
        }
        timer.resume()
        self.timer = timer
        for number in [SIGTERM, SIGINT] {
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
            source.setEventHandler { [weak self] in self?.shutdown() }
            source.resume()
            signals.append(source)
        }
        work.async { [weak self] in
            let guardian = GuardianConnection { [weak self] in self?.shutdown() }
            let authorized = permissionReady()
            DispatchQueue.main.async {
                self?.guardian = guardian
                self?.authorized = authorized
                self?.report()
            }
        }
    }

    private func receive(_ data: Data) {
        if data.isEmpty { shutdown(); return }
        buffer.append(data)
        if buffer.count > 8192 { shutdown(); return }
        while let newline = buffer.firstIndex(of: 10) {
            let line = buffer.prefix(upTo: newline)
            buffer.removeSubrange(...newline)
            guard let value = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
                  let action = value["action"] as? String else { shutdown(); return }
            if action == "heartbeat" {
                heartbeat = ProcessInfo.processInfo.systemUptime
                guardian?.send(["heartbeat": true])
                continue
            }
            guard let id = value["id"] as? Int else { shutdown(); return }
            switch action {
            case "allowSleep":
                guard let generation = value["generation"] as? Int else { emit(["id": id, "ok": false]); continue }
                allowSleep(generation: generation)
                emit(["id": id, "ok": true])
            case "sleep": requestSleep(id: id, attempts: 6)
            case "authorize":
                work.async { [weak self] in
                    let ok = authorize()
                    DispatchQueue.main.async {
                        self?.authorized = ok
                        self?.report()
                        emit(["id": id, "ok": ok])
                    }
                }
            case "activity":
                guard let awake = value["awake"] as? Bool, let closed = value["closedLid"] as? Bool else {
                    emit(["id": id, "ok": false]); continue
                }
                // Revalidate immediately before the global write. Wi-Fi names and location are never read.
                let guardian = self.guardian
                work.async { [weak self] in
                    let allowClosed = DispatchQueue.main.sync {
                        guard let self else { return false }
                        return closed && self.connectedToPower() && self.wifiConnected && !self.sleeping && !self.stopping
                    }
                    let ok = guardian?.setEnabled(allowClosed) ?? !allowClosed
                    let permission = ok ? nil : permissionReady()
                    DispatchQueue.main.async {
                        guard let self, !self.stopping else { return }
                        if ok { self.closedLidActive = allowClosed }
                        else {
                            self.authorized = permission ?? false
                            self.closedLidActive = self.closedLidActive || allowClosed
                        }
                        let assertionOK = self.setAwake(awake && ok)
                        self.report()
                        emit(["id": id, "ok": ok && assertionOK])
                    }
                }
            default: emit(["id": id, "ok": false])
            }
        }
    }

    private func setAwake(_ awake: Bool) -> Bool {
        if !awake, assertion != 0 { IOPMAssertionRelease(assertion); assertion = 0 }
        if awake, assertion == 0 {
            return IOPMAssertionCreateWithName(kIOPMAssertionTypePreventUserIdleSystemSleep as CFString,
                IOPMAssertionLevel(kIOPMAssertionLevelOn), "Pilot agents are working" as CFString, &assertion) == kIOReturnSuccess
        }
        return true
    }
    private func allowSleep(generation: Int? = nil) {
        if let argument = sleepAcknowledgement.take(generation: generation ?? sleepAcknowledgement.generation) {
            IOAllowPowerChange(connection, argument)
        }
    }
    private func property(_ key: String) -> Any? {
        guard root != 0 else { return nil }
        return IORegistryEntryCreateCFProperty(root, key as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue()
    }
    private func connectedToPower() -> Bool {
        guard let info = IOPSCopyPowerSourcesInfo()?.takeRetainedValue(),
              let source = IOPSGetProvidingPowerSourceType(info)?.takeUnretainedValue() else { return false }
        return source as String == kIOPSACPowerValue
    }
    private func wakeToken() -> String {
        var time = timeval()
        var size = MemoryLayout<timeval>.size
        guard sysctlbyname("kern.waketime", &time, &size, nil, 0) == 0 else { return "0:0" }
        return "\(time.tv_sec):\(time.tv_usec)"
    }
    private func report(capabilities suppliedCapabilities: UInt32? = nil) {
        let capabilities = suppliedCapabilities ?? (property("System Capabilities") as? NSNumber)?.uint32Value ?? 0
        let ac = connectedToPower()
        let closed = property("AppleClamshellState") as? Bool
        let unsafe = closedLidActive && closed == true && (!ac || !wifiConnected)
        if unsafe, unsafeCutoff == nil {
            // A live heartbeat is not proof that pilotd finished its durable pause. Bound that wait too.
            let cutoff = DispatchWorkItem { [weak self] in
                guard let self else { return }
                self.unsafeCutoff = nil
                if self.closedLidActive, self.property("AppleClamshellState") as? Bool == true,
                   !self.connectedToPower() || !self.wifiConnected { self.shutdown() }
            }
            unsafeCutoff = cutoff
            DispatchQueue.main.asyncAfter(deadline: .now() + 20, execute: cutoff)
        } else if !unsafe { unsafeCutoff?.cancel(); unsafeCutoff = nil }
        var displays = [CGDirectDisplayID](repeating: 0, count: 32)
        var displayCount: UInt32 = 0
        let displayAwake = CGGetOnlineDisplayList(UInt32(displays.count), &displays, &displayCount) == .success &&
            displays.prefix(Int(displayCount)).contains { CGDisplayIsActive($0) != 0 && CGDisplayIsAsleep($0) == 0 }
        let value: [String: Any] = [
            "type": "state", "available": connection != 0 && lidNotifier != 0 && capabilityNotifier != 0 && guardian != nil,
            "authorized": authorized, "connectedToPower": ac, "wifiConnected": wifiConnected,
            "online": online, "lidClosed": closed as Any? ?? NSNull(),
            "sleeping": sleeping, "fullWake": !sleeping && displayAwake && capabilities & UInt32(kIOPMSystemCapabilityGraphics) != 0,
            "wakeToken": wakeToken(), "closedLidActive": closedLidActive,
            "sleepGeneration": sleepAcknowledgement.generation,
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: value, options: .sortedKeys), data != lastReport else { return }
        lastReport = data
        emit(value)
    }
    /// Restore only once; guard EOF is independent of this work queue, signal handlers and parent lifetime.
    private func shutdown() {
        guard !stopping else { return }
        stopping = true
        _ = setAwake(false)
        allowSleep()
        guardian?.close()
        FileHandle.standardInput.readabilityHandler = nil
        work.async {
            // Covers a guardian crash too. Its lock is already gone; a live guardian owns its own cleanup.
            _ = withOverrideLock { override in
                let owned = override.ownsOverride
                if override.setEnabled(false), owned { restoreLidSleep() }
            }
            exit(0)
        }
    }
    private func requestSleep(id: Int, attempts: Int) {
        guard !closedLidActive, property("AppleClamshellState") as? Bool == true else {
            emit(["id": id, "ok": true]); return
        }
        let result = sleepClosedLid() ? kIOReturnSuccess : kIOReturnError
        if result != kIOReturnSuccess && attempts > 1 {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in self?.requestSleep(id: id, attempts: attempts - 1) }
        } else { emit(["id": id, "ok": result == kIOReturnSuccess]) }
    }
}

signal(SIGPIPE, SIG_IGN)
if CommandLine.arguments.dropFirst() == ["--guardian"] { runGuardian() }
let runtime = PowerRuntime()
runtime.start()
RunLoop.main.run()
