import AppKit
import CoreGraphics
import IOKit
import IOKit.pwr_mgt

// IOMessage.h's iokit_common_msg() macros are not imported by Swift.
// These are the public header values (sys_iokit | sub_iokit_common | message).
private enum PowerMessage {
    static let canSleep: UInt32 = 0xe0000270
    static let willSleep: UInt32 = 0xe0000280
    static let hasPoweredOn: UInt32 = 0xe0000300
    static let capabilityChange: UInt32 = 0xe0000340
}

/// Runs in the independent helper, not the main app. No timers, assertions or sleep vetoes.
final class SystemPowerMonitor {
    private var port: IONotificationPortRef?
    private var connection: io_connect_t = 0
    private var sleepNotifier: io_object_t = 0
    private var capabilityNotifier: io_object_t = 0
    private var root: io_service_t = 0
    private var observers: [NSObjectProtocol] = []
    private var sleeping = false
    private var sleepAt: Double = 0
    private let send: ([String: Any]) -> Void

    init(send: @escaping ([String: Any]) -> Void) {
        self.send = send
        let context = Unmanaged.passUnretained(self).toOpaque()
        connection = IORegisterForSystemPower(context, &port, { context, _, message, argument in
            guard let context else { return }
            let monitor = Unmanaged<SystemPowerMonitor>.fromOpaque(context).takeUnretainedValue()
            if message == PowerMessage.canSleep || message == PowerMessage.willSleep {
                // Acknowledge immediately. Persistence/IPC must never hold up sleep.
                IOAllowPowerChange(monitor.connection, Int(bitPattern: argument))
            }
            if message == PowerMessage.willSleep {
                monitor.sleepAt = Date().timeIntervalSince1970 * 1000
                monitor.sleeping = true
                monitor.report()
            } else if message == PowerMessage.hasPoweredOn {
                monitor.sleeping = false
                monitor.report()
            }
        }, &sleepNotifier)
        root = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOPMrootDomain"))
        if let port, root != 0 {
            IOServiceAddInterestNotification(port, root, kIOPriorityPowerStateInterest, { context, _, message, argument in
                guard let context, message == PowerMessage.capabilityChange, let argument else { return }
                let monitor = Unmanaged<SystemPowerMonitor>.fromOpaque(context).takeUnretainedValue()
                let change = argument.assumingMemoryBound(to: IOPMSystemCapabilityChangeParameters.self).pointee
                if change.changeFlags & UInt32(kIOPMSystemCapabilityDidChange) != 0 {
                    monitor.sleeping = change.toCapabilities & UInt32(kIOPMSystemCapabilityCPU) == 0
                    monitor.report(capabilities: change.toCapabilities)
                }
            }, context, &capabilityNotifier)
            IONotificationPortSetDispatchQueue(port, .main)
        }
        for name in [NSWorkspace.screensDidWakeNotification, NSWorkspace.didWakeNotification] {
            observers.append(NSWorkspace.shared.notificationCenter.addObserver(
                forName: name, object: nil, queue: .main
            ) { [weak self] _ in self?.report() })
        }
    }

    func report(capabilities: UInt32? = nil) {
        let sleep = kernelTime("kern.sleeptime")
        sleepAt = max(sleepAt, sleep?.milliseconds ?? 0)
        let wake = kernelTime("kern.waketime")
        let graphics = (capabilities ?? currentCapabilities()) & UInt32(kIOPMSystemCapabilityGraphics) != 0
        var displays = [CGDirectDisplayID](repeating: 0, count: 32)
        var count: UInt32 = 0
        let displayOn = CGGetOnlineDisplayList(UInt32(displays.count), &displays, &count) == .success &&
            displays.prefix(Int(count)).contains { CGDisplayIsActive($0) != 0 && CGDisplayIsAsleep($0) == 0 }
        var value: [String: Any] = [
            "type": "power", "available": connection != 0 && capabilityNotifier != 0,
            "fullWake": !sleeping && graphics && displayOn,
        ]
        if sleepAt > 0 { value["sleepAt"] = sleepAt }
        if let wake { value["wakeToken"] = wake.token }
        send(value)
    }

    private func currentCapabilities() -> UInt32 {
        guard root != 0, let value = IORegistryEntryCreateCFProperty(
            root, "System Capabilities" as CFString, kCFAllocatorDefault, 0
        )?.takeRetainedValue() as? NSNumber else { return 0 }
        return value.uint32Value
    }

    private func kernelTime(_ key: String) -> (milliseconds: Double, token: String)? {
        var value = timeval()
        var size = MemoryLayout<timeval>.size
        guard sysctlbyname(key, &value, &size, nil, 0) == 0 else { return nil }
        return (Double(value.tv_sec) * 1000 + Double(value.tv_usec) / 1000, "\(value.tv_sec):\(value.tv_usec)")
    }

    deinit {
        for observer in observers { NSWorkspace.shared.notificationCenter.removeObserver(observer) }
        if capabilityNotifier != 0 { IOObjectRelease(capabilityNotifier) }
        if sleepNotifier != 0 { IODeregisterForSystemPower(&sleepNotifier) }
        if connection != 0 { IOServiceClose(connection) }
        if root != 0 { IOObjectRelease(root) }
        if let port { IONotificationPortDestroy(port) }
    }
}
