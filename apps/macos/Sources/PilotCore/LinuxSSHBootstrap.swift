import Foundation
import Darwin

public struct LinuxBootstrapFailure: LocalizedError, Sendable {
    public let code: String
    public let detail: String
    /// JSON containing argv package/linger plans, not shell commands to execute automatically.
    public let plan: JSONValue?
    public var errorDescription: String? { detail }

    init(_ code: String, _ detail: String, plan: JSONValue? = nil) {
        self.code = code; self.detail = detail; self.plan = plan
    }
}

/// A locally authenticated package. This value cannot be constructed from unverified metadata.
/// The owner retains/removes archiveURL after setup; it contains no account credentials.
public struct LinuxRuntimePackage: Sendable {
    public let manifest: LinuxRuntimeManifest
    public let archiveURL: URL
    // Exact authenticated bytes, retained for the independently journaled remote update.
    let manifestBytes: Data
    let signature: Data
    let publicKey: Data

    public static func verified(manifest: Data, signature: Data, pinnedPublicKey: Data,
                                releaseTag: String, expectedVersion: String, archiveURL: URL) async throws -> Self {
        try await Task.detached {
            let value = try LinuxRuntimeManifest.verified(data: manifest, signature: signature,
                publicKey: pinnedPublicKey, releaseTag: releaseTag, expectedVersion: expectedVersion)
            try value.verifyArchive(at: archiveURL)
            return Self(manifest: value, archiveURL: archiveURL, manifestBytes: manifest,
                        signature: signature, publicKey: pinnedPublicKey)
        }.value
    }

    /// Call with authenticated GitHub release metadata and the signed app bundle's trust configuration.
    /// No network-derived key is accepted. Downloads use the existing repository/CDN credential policy.
    public static func download(release: UpdateRelease, repository: UpdateRepository, token: String,
                                releaseTag: String, expectedVersion: String,
                                bundle: Bundle = .main, to archiveURL: URL) async throws -> Self {
        guard let encoded = bundle.object(forInfoDictionaryKey: "PilotLinuxRuntimePublicKey") as? String,
              let key = Data(base64Encoded: encoded), key.count == 32 else {
            throw LinuxBootstrapFailure("trust", "This app has no pinned Linux runtime signing key. Install a trusted configured app release; setup cannot bypass signature verification.")
        }
        guard let assets = release.linuxRuntimeAssets() else {
            throw LinuxBootstrapFailure("assets", "This stable release has no complete signed Linux runtime. Wait for verified release assets; setup cannot use a source-tree or unsigned package.")
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.urlCredentialStorage = nil
        configuration.urlCache = nil
        configuration.timeoutIntervalForResource = 600
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        func asset(_ id: Int, limit: Int, file: URL? = nil) async throws -> Data {
            let url = try await UpdateFeed.resolve(repository: repository, assetURL: repository.assetURL(id: id),
                                                   token: token, session: session)
            let (bytes, response) = try await session.bytes(from: url, delegate: LinuxBootstrapNoRedirects())
            guard (response as? HTTPURLResponse)?.statusCode == 200 else {
                throw LinuxBootstrapFailure("assets", "The signed runtime asset is unavailable. Retry when the release assets are available.")
            }
            var data = Data()
            var count = 0
            let output: FileHandle?
            if let file {
                // This file is inside the newly created private download directory.
                guard FileManager.default.createFile(atPath: file.path, contents: nil,
                    attributes: [.posixPermissions: 0o600]),
                    let handle = try? FileHandle(forWritingTo: file) else {
                    throw LinuxBootstrapFailure("download", "Cannot create the private runtime download.")
                }
                output = handle
            } else { output = nil }
            defer { try? output?.close() }
            for try await byte in bytes {
                count += 1
                guard count <= limit else { throw LinuxBootstrapFailure("assets", "Runtime asset exceeds its authenticated size limit.") }
                data.append(byte)
                if output != nil && data.count >= 1_048_576 {
                    try output?.write(contentsOf: data); data.removeAll(keepingCapacity: true)
                }
            }
            if let output { try output.write(contentsOf: data); return Data() }
            return data
        }
        let manifestBytes = try await asset(assets.manifest.id, limit: 65_536)
        let signatureBytes = try await asset(assets.signature.id, limit: 1024)
        guard let signatureText = String(data: signatureBytes, encoding: .utf8),
              let signature = Data(base64Encoded: signatureText.trimmingCharacters(in: .whitespacesAndNewlines)) else {
            throw LinuxRuntimeManifest.ValidationError.signature
        }
        let manifest = try LinuxRuntimeManifest.verified(data: manifestBytes, signature: signature, publicKey: key,
            releaseTag: releaseTag, expectedVersion: expectedVersion)
        // Download to an owned private directory so cleanup cannot delete an unrelated file.
        let temporary = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: temporary, withIntermediateDirectories: false,
                                                attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: temporary) }
        let staged = temporary.appendingPathComponent("runtime.tgz")
        _ = try await asset(assets.archive.id, limit: manifest.archive.size, file: staged)
        let package = try await verified(manifest: manifestBytes, signature: signature, pinnedPublicKey: key,
            releaseTag: releaseTag, expectedVersion: expectedVersion, archiveURL: staged)
        try FileManager.default.moveItem(at: package.archiveURL, to: archiveURL)
        return Self(manifest: manifest, archiveURL: archiveURL, manifestBytes: manifestBytes,
                    signature: signature, publicKey: key)
    }
}

/// Keep this tunnel, consume states(), and replace host clients after every reconnect.
/// Do not retain its first forwarded URL. disconnect() never stops the remote service.
public struct LinuxBootstrapConnection: Sendable {
    public let host: HostRef
    public let tunnel: ManagedSSHTunnel
}

public enum LinuxSSHBootstrap {
    /// Explicit initial setup/reconciliation, not a side effect of connection or an update transaction.
    /// Repeating with the same package never replaces credentials/data or restarts a running unit.
    /// Persist the returned HostRef only after user-confirmed enrollment, then always supply it on retry.
    public static func install(configuration: SSHConnectionConfiguration, package: LinuxRuntimePackage,
                               hostId: String, pinnedHost: HostRef? = nil) async throws -> LinuxBootstrapConnection {
        guard configuration.remotePort == 4319, pinnedHost == nil || pinnedHost?.hostId == hostId else {
            throw LinuxBootstrapFailure("configuration", "Initial runtime setup uses port 4319 and the configured host identity. Custom service ports require separate explicit configuration.")
        }
        // Recheck immediately before upload. A modified local file cannot become trusted by being staged.
        try await Task.detached { try package.manifest.verifyArchive(at: package.archiveURL) }.value
        try Task.checkCancellation()
        let script = try scriptSource()
        let args = try commandArguments(configuration: configuration, package: package, pinnedHost: pinnedHost, script: script)
        let output = try await LinuxBootstrapSSH.run(arguments: args, input: package.archiveURL)
        let report: Report
        do { report = try JSONDecoder().decode(Report.self, from: output) }
        catch { throw LinuxBootstrapFailure("ssh", "SSH setup returned no valid result. Check the working alias/authentication and Python 3, then retry the same package to reconcile partial setup.") }
        guard report.ok, let identity = report.identity else {
            throw LinuxBootstrapFailure(report.code ?? "setup", report.detail ?? "Remote setup did not complete.", plan: report.plan)
        }
        let host = HostRef(hostId: hostId, daemonId: identity.daemonId, lineageId: identity.lineageId)
        if let pinnedHost, pinnedHost != host { throw HostRoutingError.identityChanged }
        let tunnel = ManagedSSHTunnel(configuration: configuration) { data in
            try validateHello(data, host: host, version: package.manifest.version)
        }
        do { _ = try await tunnel.connect() }
        catch { await tunnel.disconnect(); throw error }
        return LinuxBootstrapConnection(host: host, tunnel: tunnel)
    }

    static func validateHello(_ data: Data, host: HostRef, version: String) throws {
        let hello = try JSONDecoder().decode(DaemonHello.self, from: data)
        try host.validate(hello)
        guard hello.platform == "linux", hello.arch == "x64", hello.daemonVersion == version else {
            throw HostRoutingError.incompatible
        }
        guard hello.capabilities.coordinatorIsolation else {
            throw LinuxBootstrapFailure("sandbox", "Daemon readiness passed, but hello reports coordinator isolation unavailable. Review the service-policy preflight; do not weaken global security.")
        }
    }

    /// Loads the helper without executing SSH, also used by the relocated-app packaging check.
    public static func scriptSource(main: Bundle = .main) throws -> String {
        let bundle: Bundle?
        if main.bundleURL.pathExtension == "app" {
            // SwiftPM's generated accessor checks the app root, not Contents/Resources, then
            // traps if the build checkout is gone. An installed app must use only its own assets.
            bundle = main.resourceURL.flatMap { Bundle(url: $0.appendingPathComponent("PilotMac_PilotCore.bundle")) }
        } else {
            bundle = .module
        }
        guard let url = bundle?.url(forResource: "LinuxSSHBootstrap", withExtension: "py") else {
            throw LinuxBootstrapFailure("assets", "The app is missing its SSH setup helper. Reinstall the trusted app bundle.")
        }
        return try String(contentsOf: url, encoding: .utf8)
    }

    static func commandArguments(configuration: SSHConnectionConfiguration, package: LinuxRuntimePackage,
                                 pinnedHost: HostRef?, script: String) throws -> [String] {
        struct Pin: Encodable { let daemonId: String; let lineageId: String }
        let pin: String
        if let pinnedHost {
            pin = String(decoding: try JSONEncoder().encode(Pin(daemonId: pinnedHost.daemonId, lineageId: pinnedHost.lineageId)), as: UTF8.self)
        } else { pin = "null" }
        let source = Data(script.utf8).base64EncodedString()
        let program = "import base64;exec(base64.b64decode('\(source)'))"
        func quote(_ value: String) -> String { "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'" }
        let prerequisite = #"if ! command -v python3 >/dev/null 2>&1 || ! python3 -c 'import sys;sys.exit(sys.version_info < (3,9))' >/dev/null 2>&1; then plan=null; for manager in dnf apt-get yum; do if command -v "$manager" >/dev/null 2>&1; then plan='["sudo","'"$manager"'","install","-y","python3"]'; break; fi; done; printf '%s\n' '{"ok":false,"code":"python","detail":"Python 3.9+ is required for safe archive setup. Review this privileged plan; setup never runs it.","plan":{"requiresPrivilege":true,"command":'"$plan"'}}'; exit 2; fi; "#
        let remote = prerequisite + "exec python3 -c \(quote(program)) \(quote(package.manifest.archive.sha256)) \(package.manifest.archive.size) \(quote(pin))"
        // Same auth/host-key policy as tunnels, but a single bounded command, no multiplex reuse.
        return SSHArguments.safety.filter { $0 != "-N" } + ["-o", "ControlMaster=no", "-S", "none",
            "-o", "ClearAllForwardings=yes", "--", configuration.alias, remote]
    }

    private struct Report: Decodable {
        struct Identity: Decodable { let daemonId: String; let lineageId: String }
        let ok: Bool
        let identity: Identity?
        let code: String?
        let detail: String?
        let plan: JSONValue?
    }
}

private final class LinuxBootstrapNoRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

/// Only the owned local SSH process is cancelled. No remote stop, kill or rollback is ever sent.
enum LinuxBootstrapSSH {
    static func run(arguments: [String], input: URL, executable: URL = URL(fileURLWithPath: "/usr/bin/ssh"),
                    timeout: TimeInterval = 600) async throws -> Data {
        let child = BootstrapChild()
        return try await withTaskCancellationHandler {
            try await Task.detached { try child.run(arguments: arguments, input: input, executable: executable, timeout: timeout) }.value
        } onCancel: { child.cancel() }
    }
}

private final class BootstrapChild: @unchecked Sendable {
    private let lock = NSLock()
    private let process = Process()
    private var cancelled = false
    private var launched = false

    func cancel() {
        lock.withLock {
            cancelled = true
            if launched && process.isRunning { process.terminate() }
        }
    }

    func run(arguments: [String], input: URL, executable: URL, timeout: TimeInterval) throws -> Data {
        let file = try FileHandle(forReadingFrom: input)
        defer { try? file.close() }
        let pipe = Pipe()
        process.executableURL = executable
        process.arguments = arguments
        process.currentDirectoryURL = FileManager.default.homeDirectoryForCurrentUser
        process.standardInput = file
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        var environment = ProcessInfo.processInfo.environment
        environment["SSH_ASKPASS_REQUIRE"] = "never"
        process.environment = environment
        try lock.withLock {
            guard !cancelled else { throw CancellationError() }
            try process.run(); launched = true
        }
        // A deadline and escalation cover hung reads/TERM-resistant SSH without retaining diagnostics.
        let timer = DispatchSource.makeTimerSource(queue: .global())
        let deadline = ProcessInfo.processInfo.systemUptime + timeout
        timer.schedule(deadline: .now() + 0.1, repeating: 0.1)
        timer.setEventHandler { [self] in
            lock.withLock {
                if ProcessInfo.processInfo.systemUptime >= deadline { cancelled = true }
                if cancelled && process.isRunning { Darwin.kill(process.processIdentifier, SIGKILL) }
            }
        }
        timer.resume()
        defer { timer.cancel() }
        var output = Data()
        while let chunk = try pipe.fileHandleForReading.read(upToCount: 4096), !chunk.isEmpty {
            output.append(chunk)
            if output.count > 65_536 { cancel(); break }
        }
        process.waitUntilExit()
        try? pipe.fileHandleForReading.close()
        if lock.withLock({ cancelled }) {
            throw LinuxBootstrapFailure("ssh", "SSH setup was cancelled or timed out. Remote setup may have progressed. Reconnect and repeat with the same package to reconcile; no service stop was sent.")
        }
        guard !output.isEmpty else {
            throw LinuxBootstrapFailure("ssh", "SSH setup produced no result. Check the existing alias, host trust and non-interactive authentication outside the app, then retry.")
        }
        return output
    }
}
