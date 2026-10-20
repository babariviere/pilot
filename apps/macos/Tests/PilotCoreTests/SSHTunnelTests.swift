import Foundation
import Darwin
import Testing
@testable import PilotCore

// Assertions also throw, so these same focused checks can run with the Swift interpreter without
// building the app, Ghostty, or a SwiftPM test bundle. CI discovers the ordinary Swift Testing tests.
private func sshRequire(_ condition: Bool, _ message: String = "SSH transport assertion failed") throws {
    if !condition { throw NSError(domain: "SSHTunnelTests", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
}

private func sshEventually(_ predicate: () async throws -> Bool) async throws {
    let deadline = ProcessInfo.processInfo.systemUptime + 15
    while try await !predicate() {
        guard ProcessInfo.processInfo.systemUptime < deadline else {
            throw NSError(domain: "SSHTunnelTests", code: 2, userInfo: [NSLocalizedDescriptionKey: "Timed out waiting for fixture"])
        }
        try await Task.sleep(for: .milliseconds(10))
    }
}

private final class SSHFixture {
    let directory: URL
    let executable: URL
    var tunnels: [ManagedSSHTunnel] = []

    init(mode: String = "normal") throws {
        directory = FileManager.default.temporaryDirectory.appending(path: "pilot-ssh-\(UUID().uuidString)")
        executable = directory.appending(path: "ssh")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try Self.script.write(to: executable, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: executable.path)
        try setMode(mode)
    }

    func setMode(_ mode: String) throws {
        try mode.write(to: directory.appending(path: "mode"), atomically: true, encoding: .utf8)
    }

    func makeTunnel(attempts: Int = 3, timeout: TimeInterval = 15,
                    executable: URL? = nil,
                    allocate: @escaping @Sendable () throws -> UInt16 = { try SSHLoopbackPort.allocate() },
                    validator: @escaping @Sendable (Data) throws -> Void = { data in
                        try sshRequire(data == Data("{\"fixture\":true}".utf8), "Wrong hello")
                    }) throws -> ManagedSSHTunnel {
        var options = SSHTunnelOptions()
        options.executable = executable ?? self.executable
        options.maxAttempts = attempts
        options.attemptTimeout = timeout
        options.retryDelay = 0.05
        options.probeInterval = 0.02
        options.stopGrace = 0.05
        options.allocatePort = allocate
        let tunnel = ManagedSSHTunnel(configuration: try SSHConnectionConfiguration(alias: "fixture-alias"),
                                      options: options, probe: { url, timeout in
            try await SSHTunnelHello.check(url: url, timeout: timeout, validate: validator)
        })
        tunnels.append(tunnel)
        return tunnel
    }

    func launches() throws -> [[String: Any]] {
        let path = directory.appending(path: "launches")
        guard FileManager.default.fileExists(atPath: path.path) else { return [] }
        let data = try Data(contentsOf: path)
        return try data.split(separator: 10).map { line in
            try JSONSerialization.jsonObject(with: Data(line)) as! [String: Any]
        }
    }

    func tunnelPIDs() throws -> [Int32] {
        try launches().filter { $0["control"] as? Bool == false }.map { ($0["pid"] as! NSNumber).int32Value }
    }

    func cleanup() async {
        for tunnel in tunnels { await tunnel.disconnect() }
        try? FileManager.default.removeItem(at: directory)
    }

    static let script = #"""
    #!/usr/bin/env python3
    import json, os, signal, socket, sys, time
    root = os.path.dirname(__file__)
    mode = open(os.path.join(root, 'mode')).read()
    args = sys.argv[1:]
    is_control = '-O' in args
    with open(os.path.join(root, 'launches'), 'a') as log:
        log.write(json.dumps({'pid': os.getpid(), 'control': is_control, 'args': args}) + '\n')
    control_path = args[args.index('-S') + 1]
    assert control_path.startswith('/tmp/pilot-ssh-') and os.path.basename(control_path) == 'control'
    assert os.stat(os.path.dirname(control_path)).st_mode & 0o777 == 0o700
    assert len(control_path.encode()) < 104
    if is_control:
        assert args[args.index('-F') + 1] == '/dev/null'
        assert args[args.index('-O') + 1] == 'forward'
        client = socket.socket(socket.AF_UNIX)
        client.connect(control_path)
        client.sendall(args[args.index('-L') + 1].encode())
        sys.exit(int(client.recv(1024)))
    assert 'ClearAllForwardings=yes' in args
    assert '-L' not in args and 'ControlMaster=yes' in args
    if mode == 'exit':
        print('sensitive diagnostic must never escape', file=sys.stderr)
        sys.exit(255)
    if mode == 'fail-once':
        count = sum(1 for line in open(os.path.join(root, 'launches')) if not json.loads(line)['control'])
        if count == 1:
            sys.exit(255)
    if mode == 'stubborn':
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
    if mode == 'startup-hang':
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        time.sleep(60)
    if mode == 'noisy':
        print('sensitive diagnostics' * 20000)
        print('sensitive diagnostics' * 20000, file=sys.stderr)
    control = socket.socket(socket.AF_UNIX)
    control.bind(control_path)
    control.listen(1)
    client, _ = control.accept()
    with open(os.path.join(root, 'forward-started'), 'w') as marker:
        marker.write('ready')
    if mode == 'gated-forward':
        while not os.path.exists(os.path.join(root, 'release-forward')):
            time.sleep(0.01)
    if mode == 'forward-hang':
        time.sleep(60)
    forwarding = client.recv(4096).decode().split(':')
    assert forwarding[0] == forwarding[2] == '127.0.0.1'
    listener = socket.socket()
    try:
        listener.bind(('127.0.0.1', int(forwarding[1])))
        listener.listen(8)
    except OSError:
        client.sendall(b'255')
        time.sleep(60)
    client.sendall(b'0')
    client.close()
    while True:
        conn, _ = listener.accept()
        with conn:
            request = conn.recv(4096)
            if not request:
                continue
            with open(os.path.join(root, 'requests'), 'ab') as log:
                log.write(request.split(b'\r\n')[0] + b'\n')
            if mode == 'http-hang':
                time.sleep(60)
            body = b'{"fixture":true}'
            hello = os.path.join(root, 'hello')
            if os.path.exists(hello):
                body = open(hello, 'rb').read()
            if mode == 'oversized':
                body = b'x' * 65537
            if mode == 'wrong-hello':
                body = b'{"other":true}'
            header = b'HTTP/1.1 200 OK\r\n'
            if mode == 'redirect':
                header = b'HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/do-not-follow\r\n'
            try:
                conn.sendall(header + b'Content-Type: application/json\r\nContent-Length: ' +
                             str(len(body)).encode() + b'\r\nConnection: close\r\n\r\n' + body)
            except (BrokenPipeError, ConnectionResetError):
                pass
    """#
}

private func withSSHFixture(_ mode: String = "normal", _ body: (SSHFixture) async throws -> Void) async throws {
    let fixture = try SSHFixture(mode: mode)
    do { try await body(fixture) }
    catch { await fixture.cleanup(); throw error }
    await fixture.cleanup()
}

// Native process/HTTP fixtures should not fan out alongside one another in the large app suite.
// Keep startup headroom separate from the deliberately bounded timeout cases below.
@Suite(.serialized)
struct SSHTunnelTests {
    @Test
    func updateWaitRetriesPreviousVersionStopsOnOtherIdentityAndTimesOut() async throws {
        try await withSSHFixture { fixture in
            let host = HostRef(hostId: "fixture", daemonId: "daemon", lineageId: "lineage")
            let configuration = try SSHConnectionConfiguration(alias: "fixture-alias")
            func serve(_ version: String, daemon: String = "daemon") throws {
                let hello = #"{"daemonId":"DAEMON","lineageId":"lineage","daemonVersion":"VERSION","protocolVersion":1,"minimumClientProtocolVersion":1,"platform":"linux","arch":"x64","capabilities":{"powerManagement":false,"systemSleepEvents":false,"swiftUIArtifacts":false,"coordinatorIsolation":true,"independentExecution":true}}"#
                try hello.replacingOccurrences(of: "DAEMON", with: daemon).replacingOccurrences(of: "VERSION", with: version)
                    .write(to: fixture.directory.appending(path: "hello"), atomically: true, encoding: .utf8)
            }
            var options = SSHTunnelOptions()
            options.executable = fixture.executable
            options.maxAttempts = 1
            options.retryDelay = 0.05
            options.probeInterval = 0.02
            options.stopGrace = 0.05
            func wait(timeout: TimeInterval) async throws -> LinuxBootstrapConnection {
                try await LinuxSSHBootstrap.awaitUpdated(configuration: configuration, version: "1.38.0", host: host,
                                                         timeout: timeout, retryDelay: 0.05, options: options)
            }
            // The previous runtime still answers: keep checking read-only until the new version serves.
            try serve("1.37.0")
            let pending = Task { try await wait(timeout: 30) }
            try await sshEventually { try fixture.tunnelPIDs().count >= 2 }
            try serve("1.38.0")
            let connection = try await pending.value
            try sshRequire(connection.host == host)
            await connection.tunnel.disconnect()
            // Another installation is final, not something to wait out.
            try serve("1.38.0", daemon: "other")
            let launched = try fixture.tunnelPIDs().count
            do { _ = try await wait(timeout: 30); throw SSHTunnelError.rejectedHello }
            catch HostRoutingError.identityChanged { }
            try sshRequire(try fixture.tunnelPIDs().count == launched + 1, "Must not retry another identity")
            try serve("1.37.0")
            do { _ = try await wait(timeout: 0.2); throw SSHTunnelError.rejectedHello }
            catch let failure as LinuxBootstrapFailure { try sshRequire(failure.code == "update-pending") }
        }
    }

    @Test
    func sshConfigurationAndArgumentsAreSafe() throws {
        for invalid in ["", "-option", "alias name", "user@host", "host\n", "a;touch", "$(echo x)", "host/path", "é", String(repeating: "a", count: 256)] {
            do { _ = try SSHConnectionConfiguration(alias: invalid); throw SSHTunnelError.rejectedHello }
            catch SSHTunnelError.invalidConfiguration { }
        }
        do {
            _ = try JSONDecoder().decode(SSHConnectionConfiguration.self, from: Data(#"{"alias":"safe","remotePort":0}"#.utf8))
            throw SSHTunnelError.rejectedHello
        } catch SSHTunnelError.invalidConfiguration { }
        let configuration = try SSHConnectionConfiguration(alias: "my-dev_box.example", remotePort: 5432)
        let encoded = try JSONEncoder().encode(configuration)
        try sshRequire(try JSONDecoder().decode(SSHConnectionConfiguration.self, from: encoded) == configuration)
        let arguments = SSHArguments.forward(configuration, localPort: 12345, socket: "/tmp/fixture/control")
        try sshRequire(arguments.suffix(4) == ["-L", "127.0.0.1:12345:127.0.0.1:5432", "--", "my-dev_box.example"])
        let master = SSHArguments.master(configuration, socket: "/tmp/fixture/control")
        for option in ["BatchMode=yes", "StrictHostKeyChecking=yes", "ExitOnForwardFailure=yes",
                       "ControlPersist=no", "ForkAfterAuthentication=no", "PermitLocalCommand=no", "RemoteCommand=none",
                       "ForwardAgent=no", "ForwardX11=no", "GatewayPorts=no", "ClearAllForwardings=yes", "ControlMaster=yes"] {
            try sshRequire(master.contains(option), "Missing safety option \(option)")
        }
        try sshRequire(!master.contains("-F") && !master.contains("-R") && master.contains("-N") && !master.contains("-L"))
        try sshRequire(arguments.contains("/dev/null") && arguments.contains("forward") && !arguments.contains("exit"))
    }

    @Test
    func sshConcurrentTunnelsAndOwnedCleanup() async throws {
        try await withSSHFixture("stubborn") { fixture in
            // Stand-in for work not owned by either tunnel. Never discover or kill by process name.
            let independentWork = Process()
            independentWork.executableURL = URL(filePath: "/bin/sleep")
            independentWork.arguments = ["120"]
            try independentWork.run()
            defer { independentWork.terminate(); independentWork.waitUntilExit() }
            let first = try fixture.makeTunnel()
            let second = try fixture.makeTunnel()
            async let one = first.connect()
            async let two = second.connect()
            let (firstURL, secondURL) = try await (one, two)
            try sshRequire(firstURL != secondURL && firstURL.host == "127.0.0.1")
            try sshRequire(try await first.connect() == firstURL, "Must reuse connected tunnel")
            let pids = try fixture.tunnelPIDs()
            try sshRequire(pids.count == 2)
            await first.disconnect()
            try sshRequire(await first.state == .disconnected)
            try sshRequire(await second.state == .connected(secondURL), "One disconnect must not affect another host")
            try await SSHTunnelHello.check(url: secondURL, timeout: 1) { _ in }
            await second.disconnect()
            try sshRequire(independentWork.isRunning, "Closing connections must leave independently owned work alone")
            for pid in pids { try sshRequire(Darwin.kill(pid, 0) == -1 && errno == ESRCH, "Owned child must be reaped") }
            try sshRequire(try fixture.launches().allSatisfy { launch in
                let args = launch["args"] as! [String]
                return args.last == "fixture-alias" && !args.contains("exit") && !args.contains("stop") && !args.contains("kill")
            })
        }
    }

    @Test
    func sshRetriesFailuresAndExhaustsAfterDrops() async throws {
        try await withSSHFixture("fail-once") { fixture in
            let tunnel = try fixture.makeTunnel()
            _ = try await tunnel.connect()
            try sshRequire(try fixture.tunnelPIDs().count == 2)
            Darwin.kill(try fixture.tunnelPIDs().last!, SIGKILL)
            try await sshEventually {
                let state = await tunnel.state
                if case .connected = state { return try fixture.tunnelPIDs().count == 3 }
                return false
            }
            Darwin.kill(try fixture.tunnelPIDs().last!, SIGKILL)
            try await sshEventually { if case .failed = await tunnel.state { return true }; return false }
            try sshRequire(try fixture.tunnelPIDs().count == 3, "Reconnect budget must not reset on successful handshake")
            _ = try await tunnel.connect()
            try sshRequire(try fixture.tunnelPIDs().count == 4, "Explicit connect starts a fresh budget")
        }
        try await withSSHFixture("exit") { fixture in
            let tunnel = try fixture.makeTunnel(attempts: 2)
            do { _ = try await tunnel.connect(); throw SSHTunnelError.rejectedHello }
            catch SSHTunnelError.sshExited(255) { }
            try sshRequire(try fixture.tunnelPIDs().count == 2)
            try sshRequire(await tunnel.state == .failed(.sshExited(255)))
        }
    }

    @Test
    func sshDiscardsDiagnosticsAndRemovesPrivateSockets() async throws {
        try await withSSHFixture("noisy") { fixture in
            let tunnel = try fixture.makeTunnel()
            _ = try await tunnel.connect()
            let launches = try fixture.launches()
            try sshRequire(launches.count == 2)
            let args = launches[0]["args"] as! [String]
            let socket = args[args.firstIndex(of: "-S")! + 1]
            let directory = URL(filePath: socket).deletingLastPathComponent()
            await tunnel.disconnect()
            try sshRequire(!FileManager.default.fileExists(atPath: directory.path))
        }
    }

    @Test
    func sshBoundsHelloAndRefusesWrongIdentity() async throws {
        for mode in ["wrong-hello", "oversized"] {
            try await withSSHFixture(mode) { fixture in
                let tunnel = try fixture.makeTunnel()
                do { _ = try await tunnel.connect(); throw SSHTunnelError.invalidConfiguration }
                catch SSHTunnelError.rejectedHello { }
                try sshRequire(try fixture.tunnelPIDs().count == 1, "Rejected identity/protocol must not reconnect")
            }
        }
        for mode in ["http-hang", "redirect", "startup-hang", "forward-hang"] {
            try await withSSHFixture(mode) { fixture in
                let tunnel = try fixture.makeTunnel(attempts: 1, timeout: 5)
                let started = ProcessInfo.processInfo.systemUptime
                do { _ = try await tunnel.connect(); throw SSHTunnelError.invalidConfiguration }
                catch SSHTunnelError.timedOut { }
                try sshRequire(ProcessInfo.processInfo.systemUptime - started < 15)
                let launches = try fixture.launches()
                try sshRequire(!launches.isEmpty, "Timeout must reach the intended fixture, not expire before Python startup")
                if mode == "forward-hang" {
                    try sshRequire(FileManager.default.fileExists(atPath: fixture.directory.appending(path: "forward-started").path))
                }
                for launch in try fixture.launches() {
                    let pid = (launch["pid"] as! NSNumber).int32Value
                    try sshRequire(Darwin.kill(pid, 0) == -1 && errno == ESRCH)
                }
                let requestURL = fixture.directory.appending(path: "requests")
                if ["http-hang", "redirect"].contains(mode) {
                    let requests = try String(contentsOf: requestURL, encoding: .utf8)
                    try sshRequire(!requests.isEmpty && requests.split(separator: "\n").allSatisfy { $0 == "GET /api/hello HTTP/1.1" })
                }
            }
        }
    }

    @Test
    func sshDisconnectDuringStartupAndReconnectIsFinal() async throws {
        try await withSSHFixture("http-hang") { fixture in
            let tunnel = try fixture.makeTunnel()
            let connecting = Task { try await tunnel.connect() }
            try await sshEventually { FileManager.default.fileExists(atPath: fixture.directory.appending(path: "requests").path) }
            await tunnel.disconnect()
            do { _ = try await connecting.value; throw SSHTunnelError.invalidConfiguration }
            catch SSHTunnelError.disconnected { }
            try sshRequire(await tunnel.state == .disconnected)
            for pid in try fixture.tunnelPIDs() { try sshRequire(Darwin.kill(pid, 0) == -1 && errno == ESRCH) }
            try fixture.setMode("normal")
            _ = try await tunnel.connect()
            try fixture.setMode("startup-hang")
            Darwin.kill(try fixture.tunnelPIDs().last!, SIGKILL)
            try await sshEventually { if case .connecting = await tunnel.state { return true }; return false }
            await tunnel.disconnect()
            let count = try fixture.launches().count
            try await Task.sleep(for: .milliseconds(200))
            try sshRequire(await tunnel.state == .disconnected && fixture.launches().count == count)
        }
    }

    @Test
    func sshConcurrentCallersAndCancellation() async throws {
        try await withSSHFixture("gated-forward") { fixture in
            let tunnel = try fixture.makeTunnel()
            let cancelled = Task { try await tunnel.connect() }
            let retained = Task { try await tunnel.connect() }
            try await sshEventually { FileManager.default.fileExists(atPath: fixture.directory.appending(path: "forward-started").path) }
            cancelled.cancel()
            do { _ = try await cancelled.value; throw SSHTunnelError.invalidConfiguration }
            catch is CancellationError { }
            try Data().write(to: fixture.directory.appending(path: "release-forward"))
            let url = try await retained.value
            try sshRequire(await tunnel.state == .connected(url))
            try sshRequire(try fixture.tunnelPIDs().count == 1)
        }
    }

    @Test(.timeLimit(.minutes(1)), arguments: ["missing-ssh", "non-executable-ssh", "directory"])
    func sshMissingExecutableFailsWithoutRetry(path: String) async throws {
        try await withSSHFixture { fixture in
            let executable = fixture.directory.appending(path: path)
            if path == "non-executable-ssh" {
                try Data("#!/bin/sh\nexit 0\n".utf8).write(to: executable)
                try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: executable.path)
            } else if path == "directory" {
                try FileManager.default.createDirectory(at: executable, withIntermediateDirectories: false)
            }
            let tunnel = try fixture.makeTunnel(executable: executable)
            do { _ = try await tunnel.connect(); throw SSHTunnelError.invalidConfiguration }
            catch SSHTunnelError.launchFailed { }
            try sshRequire(await tunnel.state == .failed(.launchFailed))
            try sshRequire(try fixture.launches().isEmpty)
            // Concurrent connect/close callers must not strand a new runner behind old cleanup.
            let one = Task { await tunnel.disconnect() }
            let two = Task { await tunnel.disconnect() }
            await one.value
            await two.value
            try sshRequire(await tunnel.state == .disconnected)
        }
    }

    private final class SSHPortSequence: @unchecked Sendable {
        let lock = NSLock()
        var first: UInt16?
        init(_ first: UInt16) { self.first = first }
        func next() throws -> UInt16 {
            if let port = lock.withLock({ let port = first; first = nil; return port }) { return port }
            return try SSHLoopbackPort.allocate()
        }
    }

    @Test
    func sshPortCollisionAndAllocationFailure() async throws {
        try await withSSHFixture { fixture in
            let descriptor = socket(AF_INET, SOCK_STREAM, 0)
            defer { Darwin.close(descriptor) }
            var address = sockaddr_in()
            address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
            address.sin_family = sa_family_t(AF_INET)
            address.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))
            var size = socklen_t(MemoryLayout<sockaddr_in>.size)
            let bound = withUnsafeMutablePointer(to: &address) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { pointer in
                    guard Darwin.bind(descriptor, pointer, size) == 0 else { return Int32(-1) }
                    return getsockname(descriptor, pointer, &size)
                }
            }
            try sshRequire(bound == 0)
            let sequence = SSHPortSequence(UInt16(bigEndian: address.sin_port))
            let tunnel = try fixture.makeTunnel(allocate: { try sequence.next() })
            _ = try await tunnel.connect()
            try sshRequire(try fixture.tunnelPIDs().count == 2, "Collision must retry with a fresh port")
            let unavailable = try fixture.makeTunnel(attempts: 2, allocate: { throw SSHTunnelError.portAllocation })
            do { _ = try await unavailable.connect(); throw SSHTunnelError.invalidConfiguration }
            catch SSHTunnelError.portAllocation { }
            try sshRequire(await unavailable.state == .failed(.portAllocation))
        }
    }

    @Test
    func sshExistingHelloListenerCannotWinStartupRace() async throws {
        try await withSSHFixture { fixture in
            let existing = try fixture.makeTunnel()
            let existingURL = try await existing.connect()
            let sequence = SSHPortSequence(UInt16(existingURL.port!))
            // Both listeners return the same accepted body. Only the SSH forwarding acknowledgment,
            // not hello validation or a guessed startup delay, proves that our new listener was bound.
            let connecting = try fixture.makeTunnel(allocate: { try sequence.next() })
            let newURL = try await connecting.connect()
            try sshRequire(newURL != existingURL)
            try sshRequire(try fixture.tunnelPIDs().count == 3)
            try sshRequire(await existing.state == .connected(existingURL))
            let sockets = try fixture.launches().map { launch -> String in
                let args = launch["args"] as! [String]
                return args[args.firstIndex(of: "-S")! + 1]
            }
            await connecting.disconnect()
            await existing.disconnect()
            for socket in sockets {
                try sshRequire(!FileManager.default.fileExists(atPath: URL(filePath: socket).deletingLastPathComponent().path))
            }
        }
    }

    @Test
    func sshAvailabilityStreamAndOwnerRelease() async throws {
        try await withSSHFixture { fixture in
            var tunnel: ManagedSSHTunnel? = try fixture.makeTunnel()
            fixture.tunnels.removeAll()
            let stream = await tunnel!.states()
            var states = stream.makeAsyncIterator()
            try sshRequire(await states.next() == .disconnected)
            let url = try await tunnel!.connect()
            try sshRequire(await states.next() == .connected(url), "Availability stream must be latest-only")
            let pid = try fixture.tunnelPIDs().last!
            tunnel = nil
            try await sshEventually { Darwin.kill(pid, 0) == -1 && errno == ESRCH }
            try sshRequire(await states.next() == .disconnected)
            try sshRequire(await states.next() == nil, "Owner release must finish availability observers")
        }
    }
}
