import Foundation
import Darwin

/// Only connection coordinates are serializable. SSH owns configuration, keys and authentication.
public struct SSHConnectionConfiguration: Codable, Equatable, Sendable {
    public let alias: String
    public let remotePort: UInt16

    public init(alias: String, remotePort: UInt16 = 4319) throws {
        let bytes = Array(alias.utf8)
        func alphanumeric(_ byte: UInt8) -> Bool {
            (65...90).contains(byte) || (97...122).contains(byte) || (48...57).contains(byte)
        }
        guard let first = bytes.first, alphanumeric(first), bytes.count <= 255,
              bytes.allSatisfy({ alphanumeric($0) || [45, 46, 95].contains($0) }), remotePort != 0 else {
            throw SSHTunnelError.invalidConfiguration
        }
        self.alias = alias
        self.remotePort = remotePort
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        try self.init(alias: values.decode(String.self, forKey: .alias),
                      remotePort: values.decode(UInt16.self, forKey: .remotePort))
    }
}

public enum SSHTunnelError: Error, Equatable, Sendable {
    case invalidConfiguration
    case portAllocation
    case launchFailed
    case sshExited(Int32)
    case timedOut
    case rejectedHello
    case disconnected
}

public enum SSHTunnelState: Equatable, Sendable {
    case disconnected
    case connecting(attempt: Int)
    case connected(URL)
    case failed(SSHTunnelError)
}

/// One owned local tunnel per instance. No local daemon lifecycle or remote process control.
/// Owners must disconnect on removal/quit. Dropping the object also schedules local cleanup.
public final class ManagedSSHTunnel: Sendable {
    private let session: SSHTunnelSession

    /// The validator must decode /api/hello, check protocol/capabilities and pin/check daemon identity.
    /// A thrown validation error is terminal: never expose an incompatible or wrong-host endpoint.
    public init(configuration: SSHConnectionConfiguration,
                validateHello: @escaping @Sendable (Data) throws -> Void) {
        session = SSHTunnelSession(configuration: configuration, options: SSHTunnelOptions(),
                                   probe: { url, timeout in
            try await SSHTunnelHello.check(url: url, timeout: timeout, validate: validateHello)
        })
    }

    init(configuration: SSHConnectionConfiguration, options: SSHTunnelOptions,
         probe: @escaping SSHTunnelProbe) {
        session = SSHTunnelSession(configuration: configuration, options: options, probe: probe)
    }

    deinit {
        let session = session
        Task { await session.dispose() }
    }

    /// Coalesces concurrent callers. Cancelling one caller doesn't close another caller's tunnel.
    public func connect() async throws -> URL { try await session.connect() }
    public func disconnect() async { await session.disconnect() }
    public var state: SSHTunnelState { get async { await session.state } }

    /// Latest-only availability updates, independent of last-known agent outcome.
    public func states() async -> AsyncStream<SSHTunnelState> { await session.states() }
}

typealias SSHTunnelProbe = @Sendable (URL, TimeInterval) async throws -> Void

struct SSHTunnelOptions: Sendable {
    var executable = URL(filePath: "/usr/bin/ssh")
    // A finite budget across startup AND subsequent drops. Only explicit connect after exhaustion
    // starts a new budget. No perpetual background retries, even after briefly successful connects.
    var maxAttempts = 3
    var attemptTimeout: TimeInterval = 15
    var retryDelay: TimeInterval = 1
    var probeInterval: TimeInterval = 0.1
    var stopGrace: TimeInterval = 0.25
    var allocatePort: @Sendable () throws -> UInt16 = { try SSHLoopbackPort.allocate() }
}

private actor SSHTunnelSession {
    let configuration: SSHConnectionConfiguration
    let options: SSHTunnelOptions
    let probe: SSHTunnelProbe
    private(set) var state: SSHTunnelState = .disconnected
    private var runner: Task<Void, Never>?
    private var process: OwnedSSHProcess?
    private var command: OwnedSSHProcess?
    private var generation = UUID()
    private var waiters: [UUID: CheckedContinuation<URL, Error>] = [:]
    private var observers: [UUID: AsyncStream<SSHTunnelState>.Continuation] = [:]
    private var closing: Task<Void, Never>?

    init(configuration: SSHConnectionConfiguration, options: SSHTunnelOptions,
         probe: @escaping SSHTunnelProbe) {
        self.configuration = configuration
        self.options = options
        self.probe = probe
    }

    func states() -> AsyncStream<SSHTunnelState> {
        let id = UUID()
        let (stream, continuation) = AsyncStream<SSHTunnelState>.makeStream(bufferingPolicy: .bufferingNewest(1))
        observers[id] = continuation
        continuation.yield(state)
        continuation.onTermination = { [weak self] _ in Task { await self?.removeObserver(id) } }
        return stream
    }

    private func removeObserver(_ id: UUID) { observers.removeValue(forKey: id) }

    func connect() async throws -> URL {
        if let closing { await closing.value }
        try Task.checkCancellation()
        if case .connected(let url) = state, process?.status == nil { return url }
        let id = UUID()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                waiters[id] = continuation
                if runner == nil {
                    let token = UUID()
                    generation = token
                    runner = Task { await self.run(token: token) }
                }
            }
        } onCancel: {
            Task { await self.cancelWaiter(id) }
        }
    }

    private func cancelWaiter(_ id: UUID) {
        waiters.removeValue(forKey: id)?.resume(throwing: CancellationError())
    }

    func disconnect() async {
        if let closing { await closing.value; return }
        generation = UUID()
        let previous = runner
        previous?.cancel()
        // Cancellation must not strand the run loop in process-exit waiting.
        let child = process
        let pendingCommand = command
        let grace = options.stopGrace
        let cleanup = Task {
            await pendingCommand?.stop(grace: grace)
            await child?.stop(grace: grace)
            await previous?.value
            self.process = nil
            self.command = nil
            self.runner = nil
            self.closing = nil
        }
        closing = cleanup
        publish(.disconnected)
        finishWaiters(.failure(SSHTunnelError.disconnected))
        await cleanup.value
    }

    func dispose() async {
        await disconnect()
        for continuation in observers.values { continuation.finish() }
        observers.removeAll()
    }

    private func publish(_ value: SSHTunnelState) {
        state = value
        for continuation in observers.values { continuation.yield(value) }
    }

    private func finishWaiters(_ result: Result<URL, Error>) {
        let pending = waiters.values
        waiters.removeAll()
        for continuation in pending { continuation.resume(with: result) }
    }

    private func run(token: UUID) async {
        var failure = SSHTunnelError.launchFailed
        for attempt in 1...max(1, options.maxAttempts) {
            guard generation == token, !Task.isCancelled else { return }
            publish(.connecting(attempt: attempt))
            var socket: SSHControlSocket?
            do {
                let control = try SSHControlSocket()
                socket = control
                let port = try options.allocatePort()
                let child = try OwnedSSHProcess(executable: options.executable,
                    arguments: SSHArguments.master(configuration, socket: control.path))
                process = child
                try await forward(child, socket: control.path, port: port)
                let url = URL(string: "http://127.0.0.1:\(port)")!
                try await ready(child, url: url)
                guard generation == token, !Task.isCancelled else { throw CancellationError() }
                publish(.connected(url))
                finishWaiters(.success(url))
                failure = .sshExited(await child.exitStatus())
            } catch is CancellationError {
                await command?.stop(grace: options.stopGrace)
                await process?.stop(grace: options.stopGrace)
                socket?.remove()
                return
            } catch let error as SSHTunnelError {
                failure = error
            } catch {
                // Never retain SSH diagnostics, alias paths or raw HTTP/validator errors.
                failure = .launchFailed
            }
            await command?.stop(grace: options.stopGrace)
            command = nil
            await process?.stop(grace: options.stopGrace)
            process = nil
            socket?.remove()
            guard generation == token, !Task.isCancelled else { return }
            if [.rejectedHello, .launchFailed].contains(failure) { break }
            if attempt < max(1, options.maxAttempts) {
                // Remove the dead endpoint immediately, including during retry backoff.
                publish(.connecting(attempt: attempt + 1))
                do { try await Task.sleep(for: .seconds(options.retryDelay * Double(attempt))) }
                catch { return }
            }
        }
        guard generation == token else { return }
        runner = nil
        publish(.failed(failure))
        finishWaiters(.failure(failure))
    }

    private func forward(_ master: OwnedSSHProcess, socket: String, port: UInt16) async throws {
        let deadline = ProcessInfo.processInfo.systemUptime + options.attemptTimeout
        while !FileManager.default.fileExists(atPath: socket) {
            try Task.checkCancellation()
            if let status = master.status { throw SSHTunnelError.sshExited(status) }
            guard ProcessInfo.processInfo.systemUptime < deadline else { throw SSHTunnelError.timedOut }
            try await Task.sleep(for: .milliseconds(20))
        }
        try Task.checkCancellation()
        let child = try OwnedSSHProcess(executable: options.executable,
            arguments: SSHArguments.forward(configuration, localPort: port, socket: socket))
        command = child
        while child.status == nil {
            try Task.checkCancellation()
            if let status = master.status { throw SSHTunnelError.sshExited(status) }
            guard ProcessInfo.processInfo.systemUptime < deadline else { throw SSHTunnelError.timedOut }
            try await Task.sleep(for: .milliseconds(20))
        }
        guard child.status == 0 else { throw SSHTunnelError.sshExited(child.status ?? -1) }
        command = nil
    }

    private func ready(_ child: OwnedSSHProcess, url: URL) async throws {
        let deadline = ProcessInfo.processInfo.systemUptime + options.attemptTimeout
        while true {
            try Task.checkCancellation()
            if let status = child.status { throw SSHTunnelError.sshExited(status) }
            let remaining = deadline - ProcessInfo.processInfo.systemUptime
            guard remaining > 0 else { throw SSHTunnelError.timedOut }
            do {
                try await probe(url, min(remaining, 2))
                try Task.checkCancellation()
                if let status = child.status { throw SSHTunnelError.sshExited(status) }
                return
            } catch SSHTunnelError.rejectedHello { throw SSHTunnelError.rejectedHello }
            catch is CancellationError { throw CancellationError() }
            catch { /* Not listening, remote service absent, or a transient HTTP failure. */ }
            try await Task.sleep(for: .seconds(options.probeInterval))
        }
    }
}

enum SSHArguments {
    static let safety = [
        "-N", "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
        "-o", "ExitOnForwardFailure=yes", "-o", "ConnectTimeout=10", "-o", "ConnectionAttempts=1",
        "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=2", "-o", "TCPKeepAlive=yes",
        // Never fork or persist beyond our foreground master process.
        "-o", "ControlPersist=no",
        "-o", "ForkAfterAuthentication=no", "-o", "PermitLocalCommand=no", "-o", "RemoteCommand=none",
        "-o", "ForwardAgent=no", "-o", "ForwardX11=no", "-o", "Tunnel=no", "-o", "GatewayPorts=no",
    ]

    static func master(_ configuration: SSHConnectionConfiguration, socket: String) -> [String] {
        // Ignore ALL configured forwards. Our -L is added only after authenticated master startup.
        safety + ["-o", "ControlMaster=yes", "-S", socket, "-o", "ClearAllForwardings=yes", "--", configuration.alias]
    }

    static func forward(_ configuration: SSHConnectionConfiguration, localPort: UInt16, socket: String) -> [String] {
        // This command ONLY talks to our socket; -O fails closed if it is missing. Suppress config
        // here so mux_client_forwards cannot add an alias's other LocalForward/RemoteForward entries.
        ["-F", "/dev/null", "-S", socket, "-O", "forward", "-o", "BatchMode=yes", "-o", "ControlMaster=no",
         "-L", "127.0.0.1:\(localPort):127.0.0.1:\(configuration.remotePort)", "--", configuration.alias]
    }
}

private struct SSHControlSocket {
    let directory: String
    var path: String { directory + "/control" }

    init() throws {
        // Short path for sockaddr_un's macOS limit. mkdtemp atomically owns a new 0700 directory;
        // never reuse a user's socket, predictable filename or shared multiplex master.
        var template = Array("/tmp/pilot-ssh-XXXXXX".utf8CString)
        guard let directory = mkdtemp(&template) else { throw SSHTunnelError.launchFailed }
        self.directory = String(cString: directory)
    }

    func remove() { try? FileManager.default.removeItem(atPath: directory) }
}

/// No polling while connected. Foundation reaps this exact child and reports its exit.
private final class OwnedSSHProcess: @unchecked Sendable {
    private let process = Process()
    private let lock = NSLock()
    private var code: Int32?
    private var waiters: [CheckedContinuation<Int32, Never>] = []

    var status: Int32? { lock.withLock { code } }

    init(executable: URL, arguments: [String]) throws {
        process.executableURL = executable
        process.arguments = arguments
        process.currentDirectoryURL = FileManager.default.homeDirectoryForCurrentUser
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        // Prevent askpass prompts in GUI environments. Keep SSH_AUTH_SOCK and ordinary config.
        var environment = ProcessInfo.processInfo.environment
        environment["SSH_ASKPASS_REQUIRE"] = "never"
        process.environment = environment
        process.terminationHandler = { [weak self] process in self?.exited(process.terminationStatus) }
        do { try process.run() } catch { throw SSHTunnelError.launchFailed }
    }

    private func exited(_ status: Int32) {
        let pending = lock.withLock {
            code = status
            let pending = waiters
            waiters.removeAll()
            return pending
        }
        for waiter in pending { waiter.resume(returning: status) }
    }

    func exitStatus() async -> Int32 {
        await withCheckedContinuation { continuation in
            lock.withLock {
                if let code { continuation.resume(returning: code) }
                else { waiters.append(continuation) }
            }
        }
    }

    func stop(grace: TimeInterval) async {
        signal(SIGTERM)
        if status == nil { try? await Task.sleep(for: .seconds(grace)) }
        signal(SIGKILL)
        _ = await exitStatus()
    }

    private func signal(_ signal: Int32) {
        lock.withLock {
            // No PID registry, name matching, process-group signals, SSH control exit or remote kill.
            if code == nil, process.isRunning { Darwin.kill(process.processIdentifier, signal) }
        }
    }
}

enum SSHLoopbackPort {
    static func allocate() throws -> UInt16 {
        let descriptor = socket(AF_INET, SOCK_STREAM, 0)
        guard descriptor >= 0 else { throw SSHTunnelError.portAllocation }
        defer { Darwin.close(descriptor) }
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))
        var size = socklen_t(MemoryLayout<sockaddr_in>.size)
        let result = withUnsafeMutablePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { pointer in
                guard Darwin.bind(descriptor, pointer, size) == 0 else { return Int32(-1) }
                return getsockname(descriptor, pointer, &size)
            }
        }
        guard result == 0 else { throw SSHTunnelError.portAllocation }
        // OpenSSH cannot inherit a listener. A successful control-forward acknowledgment is
        // required before probing HTTP; a bind race therefore fails closed and retries a new port.
        return UInt16(bigEndian: address.sin_port)
    }
}

enum SSHTunnelHello {
    static func check(url: URL, timeout: TimeInterval,
                      validate: @Sendable (Data) throws -> Void) async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.connectionProxyDictionary = [:]
        configuration.httpCookieStorage = nil
        configuration.urlCredentialStorage = nil
        configuration.urlCache = nil
        configuration.timeoutIntervalForRequest = timeout
        configuration.timeoutIntervalForResource = timeout
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        var request = URLRequest(url: url.appending(path: "api/hello"))
        request.timeoutInterval = timeout
        let (bytes, response) = try await session.bytes(for: request, delegate: SSHHelloRedirects())
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw SSHTunnelError.timedOut
        }
        var data = Data()
        for try await byte in bytes {
            guard data.count < 65_536 else { throw SSHTunnelError.rejectedHello }
            data.append(byte)
        }
        do { try validate(data) } catch { throw SSHTunnelError.rejectedHello }
    }
}

private final class SSHHelloRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
