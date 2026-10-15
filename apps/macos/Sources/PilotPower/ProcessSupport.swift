import Foundation
import IOKit
import IOKit.pwr_mgt
import PilotPowerSupport

/// All callers use a utility queue (or the guardian), never the power notification run loop.
func command(_ file: String, _ arguments: [String], timeout: Double = 5) -> (Bool, String) {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: file)
    process.arguments = arguments
    let output = Pipe()
    process.standardOutput = output
    process.standardError = FileHandle.nullDevice
    process.standardInput = FileHandle.nullDevice
    let lock = NSLock()
    var data = Data()
    output.fileHandleForReading.readabilityHandler = { handle in
        lock.lock(); defer { lock.unlock() }
        let chunk = handle.availableData
        if data.count < 65_536 { data.append(chunk.prefix(65_536 - data.count)) }
    }
    let done = DispatchSemaphore(value: 0)
    process.terminationHandler = { _ in done.signal() }
    do { try process.run() } catch {
        output.fileHandleForReading.readabilityHandler = nil
        return (false, "")
    }
    if done.wait(timeout: .now() + timeout) == .timedOut {
        process.terminate()
        if done.wait(timeout: .now() + 1) == .timedOut { kill(process.processIdentifier, SIGKILL) }
        output.fileHandleForReading.readabilityHandler = nil
        return (false, "")
    }
    output.fileHandleForReading.readabilityHandler = nil
    lock.lock(); defer { lock.unlock() }
    let remaining = output.fileHandleForReading.readDataToEndOfFile()
    if data.count < 65_536 { data.append(remaining.prefix(65_536 - data.count)) }
    return (process.terminationStatus == 0, String(decoding: data, as: UTF8.self))
}

func sudoSleep(_ on: Bool) -> Bool {
    command("/usr/bin/sudo", ["-n", "-k", "/usr/bin/pmset", "disablesleep", on ? "1" : "0"]).0
}
func sleepDisabled() -> Bool? {
    let (ok, report) = command("/usr/bin/pmset", ["-g"])
    guard ok else { return nil }
    return report.range(of: #"SleepDisabled\s+1"#, options: .regularExpression) != nil
}
func permissionReady() -> Bool {
    // Ignore cached sudo credentials: a recent unrelated sudo must not masquerade as permanent permission.
    let (ok, listing) = command("/usr/bin/sudo", ["-n", "-k", "-l"])
    let normalized = listing.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
    return ok && normalized.contains("NOPASSWD: /usr/bin/pmset disablesleep 1, /usr/bin/pmset disablesleep 0")
}

func authorize() -> Bool {
    let shell = PowerPermission.installScript(uid: getuid())
    let quoted = shell.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
    return command("/usr/bin/osascript", ["-e",
        "do shell script \"\(quoted)\" with administrator privileges with prompt \"Allow Pilot to keep working with the lid closed. Only two sleep commands are authorized.\""
    ], timeout: 115).0 && permissionReady()
}

/// macOS has no public immediate-lock API. Resolve the login framework entry point at runtime so
/// an OS change fails closed instead of breaking helper launch. No Accessibility/Automation grant,
/// simulated keystroke, screensaver/password preference change, or administrator command is needed.
func lockSession() -> Bool {
    guard let handle = dlopen("/System/Library/PrivateFrameworks/login.framework/login", RTLD_NOW) else { return false }
    defer { dlclose(handle) }
    guard let symbol = dlsym(handle, "SACLockScreenImmediate") else { return false }
    typealias Lock = @convention(c) () -> Int32
    return unsafeBitCast(symbol, to: Lock.self)() == 0
}

/// Fixed, per-user state, independent of PILOT_HOME. Development daemons cannot fight over a global override.
func overrideDirectory() -> URL {
    FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Pilot/Power", isDirectory: true)
}
func withOverrideLock<T>(_ body: (SleepOverride) -> T) -> T? {
    let directory = overrideDirectory()
    do { try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
        attributes: [.posixPermissions: 0o700]) } catch { return nil }
    let fd = open(directory.appendingPathComponent("owner.lock").path, O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC, 0o600)
    guard fd >= 0 else { return nil }
    defer { close(fd) }
    guard flock(fd, LOCK_EX | LOCK_NB) == 0 else { return nil }
    defer { flock(fd, LOCK_UN) }
    return body(SleepOverride(marker: directory.appendingPathComponent("override"),
        readDisabled: sleepDisabled, writeDisabled: sudoSleep))
}

private let outputLock = NSLock()
func emit(_ value: [String: Any]) {
    guard var data = try? JSONSerialization.data(withJSONObject: value) else { return }
    data.append(10)
    outputLock.lock(); defer { outputLock.unlock() }
    try? FileHandle.standardOutput.write(contentsOf: data)
}

/// Independent process. EOF or a missed daemon lease restores sleep, even if the monitoring helper dies.
func runGuardian() -> Never {
    let result: Void? = withOverrideLock { override in
        let lock = NSLock()
        var heartbeat = ProcessInfo.processInfo.systemUptime
        // Recovery from a previous abrupt death is automatic and never asks for authorization in the background.
        let recovered = override.ownsOverride
        guard override.setEnabled(false) else { emit(["ok": false]); return }
        if recovered { restoreLidSleep() }
        emit(["ok": true])
        let timer = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
        timer.schedule(deadline: .now() + 5, repeating: 5)
        timer.setEventHandler {
            lock.lock(); defer { lock.unlock() }
            if ProcessInfo.processInfo.systemUptime - heartbeat > 20 {
                let owned = override.ownsOverride
                if override.setEnabled(false), owned { restoreLidSleep() }
                exit(0)
            }
        }
        timer.resume()
        defer {
            timer.cancel()
            lock.lock()
            let owned = override.ownsOverride
            if override.setEnabled(false), owned { restoreLidSleep() }
            lock.unlock()
        }
        while let line = readLine(), line.utf8.count <= 4096 {
            guard let data = line.data(using: .utf8),
                  let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { break }
            lock.lock()
            if value["heartbeat"] as? Bool == true {
                heartbeat = ProcessInfo.processInfo.systemUptime
            } else if let on = value["on"] as? Bool {
                let ok = override.setEnabled(on)
                emit(["ok": ok])
            } else { lock.unlock(); break }
            lock.unlock()
        }
    }
    if result == nil { emit(["ok": false]) }
    exit(0)
}

final class GuardianConnection {
    private let process = Process()
    private let input = Pipe()
    private let output = Pipe()
    private let lock = NSLock()
    private lazy var replies = PowerReplyReader(input: output.fileHandleForReading)
    init?(onExit: @escaping () -> Void) {
        process.terminationHandler = { _ in DispatchQueue.main.async(execute: onExit) }
        process.executableURL = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL
        process.arguments = ["--guardian"]
        process.standardInput = input
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        do { try process.run() } catch { return nil }
        guard replies.readReply() else { try? input.fileHandleForWriting.close(); return nil }
    }
    func send(_ value: [String: Any]) {
        guard var data = try? JSONSerialization.data(withJSONObject: value) else { return }
        data.append(10)
        lock.lock(); defer { lock.unlock() }
        try? input.fileHandleForWriting.write(contentsOf: data)
    }
    /// Only the serial work queue reads replies; heartbeats are write-only and may arrive during a command.
    func setEnabled(_ on: Bool) -> Bool { send(["on": on]); return replies.readReply() }
    func close() { try? input.fileHandleForWriting.close() }
    deinit { close() }
}

/// Re-evaluate live lid-specific protections on every retry. Ordinary idle assertions are not lid protections.
func sleepClosedLid() -> Bool {
    let root = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOPMrootDomain"))
    guard root != 0 else { return false }
    defer { IOObjectRelease(root) }
    func property(_ key: String) -> Any? {
        IORegistryEntryCreateCFProperty(root, key as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue()
    }
    guard property("AppleClamshellState") as? Bool == true else { return true }
    guard property("AppleClamshellCausesSleep") as? Bool == true else { return true }
    var snapshot: Unmanaged<CFDictionary>?
    guard IOPMCopyAssertionsByProcess(&snapshot) == kIOReturnSuccess,
          let processes = snapshot?.takeRetainedValue() as? [AnyHashable: [[String: Any]]] else { return false }
    for assertion in processes.values.flatMap({ $0 }) {
        let type = assertion["AssertType"] as? String
        if type == nil || ["UserIsActive", "DisplayWake", "PreventSystemSleep"].contains(type!) {
            if (assertion["AppliesOnLidClose"] as? Bool == true || assertion["ProcessingHotPlug"] as? Bool == true),
               assertion["AssertLevel"] as? Int != 0 { return true }
        }
    }
    let connection = IOPMFindPowerManagement(kIOMainPortDefault)
    guard connection != 0 else { return false }
    defer { IOServiceClose(connection) }
    return IOPMSleepSystem(connection) == kIOReturnSuccess
}
func restoreLidSleep() {
    for _ in 0..<6 {
        if sleepClosedLid() { return }
        Thread.sleep(forTimeInterval: 0.5)
    }
}
