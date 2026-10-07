import Foundation
import PilotCore
import Darwin

/// Runs pilotd as a per-user launchd agent, so it outlives the app window and the app itself.
@MainActor
final class DaemonController: ObservableObject {
    enum Status: Equatable {
        case unknown
        case starting
        case running
        case stopped
        case failed(String)
    }

    static let label = "com.babariviere.pilot.daemon"

    @Published private(set) var status: Status = .unknown
    @Published private(set) var lifecycleBusy = false
    private(set) var lifecycleGeneration = 0
    private var snapshotMode = false

    /// Snapshots render with fixtures and never touch launchd.
    func markRunningForSnapshot() {
        snapshotMode = true
        status = .running
    }

    let port = Int(ProcessInfo.processInfo.environment["PILOT_PORT"] ?? "") ?? 4319
    var baseURL: URL { URL(string: "http://127.0.0.1:\(port)")! }

    private var home: URL { FileManager.default.homeDirectoryForCurrentUser }
    var plistURL: URL { home.appending(path: "Library/LaunchAgents/\(Self.label).plist") }
    var logURL: URL { home.appending(path: "Library/Logs/Pilot/pilotd.log") }
    private var domain: String { "gui/\(getuid())" }

    /// The Pilot checkout that provides pilotd. Set by the bundle script; falls back to this source tree.
    var repoURL: URL {
        if ProcessInfo.processInfo.environment["PILOT_REPO"] == nil,
           let resources = Bundle.main.resourceURL,
           FileManager.default.fileExists(atPath: resources.appending(path: "runtime/node/bin/node").path)
        {
            return resources.appending(path: "runtime")
        }
        if let path = ProcessInfo.processInfo.environment["PILOT_REPO"] ?? Bundle.main.object(forInfoDictionaryKey: "PilotRepoPath") as? String,
           !path.isEmpty, !path.hasPrefix("@")
        {
            return URL(filePath: path)
        }
        // apps/macos/Sources/Pilot/Daemon.swift -> repository root
        return URL(filePath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    }

    func ensureRunning() async {
        guard !lifecycleBusy else { return }
        lifecycleGeneration += 1
        lifecycleBusy = true
        defer { lifecycleBusy = false }
        if await isHealthy() {
            status = .running
            return
        }
        status = .starting
        do {
            try await install()
            try await launch(restart: false)
            status = await waitUntilHealthy() ? .running : .failed("pilotd did not become healthy. See \(logURL.path).")
        } catch {
            status = .failed(error.localizedDescription)
        }
    }

    func restart() async {
        guard !lifecycleBusy else { return }
        lifecycleGeneration += 1
        lifecycleBusy = true
        defer { lifecycleBusy = false }
        status = .starting
        do {
            try await install()
            try await launch(restart: true)
            status = await waitUntilHealthy() ? .running : .failed("pilotd did not become healthy. See \(logURL.path).")
        } catch {
            status = .failed(error.localizedDescription)
        }
    }

    /// Unloads the agent until the next login or the next app launch. Running sessions pause durably.
    func stop() async {
        guard !lifecycleBusy else { return }
        lifecycleGeneration += 1
        lifecycleBusy = true
        defer { lifecycleBusy = false }
        _ = try? await run("/bin/launchctl", ["bootout", "\(domain)/\(Self.label)"])
        status = .stopped
    }

    /// Hold lifecycle ownership from preparation through verified process exit. A menu restart
    /// cannot replace the daemon between granting its lease and shutting down that leased process.
    func stopIfIdleForUpdate() async throws -> Bool {
        guard !lifecycleBusy else { return false }
        lifecycleBusy = true
        defer { lifecycleBusy = false }
        guard try await isIdleForUpdate() else { return false }
        try Task.checkCancellation()
        try await stopForUpdate()
        return true
    }

    /// The daemon grants a short lease that blocks new admissions while launchd shuts it down.
    private func isIdleForUpdate() async throws -> Bool {
        // Do not pause admissions in an unmanaged foreground daemon that we cannot stop.
        guard (try? await run("/bin/launchctl", ["print", "\(domain)/\(Self.label)"])) != nil else {
            throw DaemonError("Automatic installation requires the app-managed pilotd launch agent.")
        }
        var request = URLRequest(url: baseURL.appending(path: "api/update/prepare"))
        request.httpMethod = "POST"
        request.timeoutInterval = 5
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data("{}".utf8)
        let (data, response) = try await URLSession.shared.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            throw DaemonError("pilotd could not prepare for an update. Restart pilotd from the new app once agents are idle.")
        }
        return try JSONDecoder().decode(UpdatePreparation.self, from: data).ready
    }

    private func stopForUpdate() async throws {
        // Never terminate an unmanaged foreground daemon or ignore a failed bootout.
        let definition = try await run("/bin/launchctl", ["print", "\(domain)/\(Self.label)"])
        guard let line = definition.split(separator: "\n").first(where: { $0.trimmingCharacters(in: .whitespaces).hasPrefix("pid = ") }),
              let pid = Int32(line.split(separator: "=").last!.trimmingCharacters(in: .whitespaces)), pid > 0
        else { throw DaemonError("Could not identify the managed pilotd process; installation has been postponed.") }
        try await run("/bin/launchctl", ["bootout", "\(domain)/\(Self.label)"])
        for _ in 0 ..< 40 {
            // HTTP closes before worker shutdown finishes. Only process exit proves the runtime
            // can be replaced, and PID reuse/permission failures must fail closed.
            if Darwin.kill(pid, 0) == -1 && errno == ESRCH { status = .stopped; return }
            // Once bootout succeeds, finish exit verification even if the update task aborts.
            // A detached delay is not canceled with the caller, so the safety proof still runs.
            await Task.detached { try? await Task.sleep(for: .milliseconds(250)) }.value
        }
        throw DaemonError("pilotd is still running; update installation has been postponed.")
    }

    func isHealthy() async -> Bool {
        if snapshotMode { return true }
        var request = URLRequest(url: baseURL.appending(path: "api/sessions"))
        request.timeoutInterval = 2
        guard let (_, response) = try? await URLSession.shared.data(for: request) else { return false }
        return (response as? HTTPURLResponse)?.statusCode == 200
    }

    private func waitUntilHealthy() async -> Bool {
        for _ in 0 ..< 60 {
            if await isHealthy() { return true }
            try? await Task.sleep(for: .milliseconds(500))
        }
        return false
    }

    private func launch(restart: Bool) async throws {
        let loaded = (try? await run("/bin/launchctl", ["print", "\(domain)/\(Self.label)"])) != nil
        if loaded {
            if restart { try await run("/bin/launchctl", ["kickstart", "-k", "\(domain)/\(Self.label)"]) }
            else { try await run("/bin/launchctl", ["kickstart", "\(domain)/\(Self.label)"]) }
        } else {
            try await run("/bin/launchctl", ["bootstrap", domain, plistURL.path])
        }
    }

    /// Writes the launch agent. GUI apps do not inherit the shell's PATH, so capture it from a login
    /// shell: pi extensions shell out to node, jj, gh, fnox and friends.
    private func install() async throws {
        let bundledNode = repoURL.appending(path: "node/bin/node").path
        let hasBundledNode = FileManager.default.isExecutableFile(atPath: bundledNode)
        let environment = try await loginShellEnvironment(requiresNode: !hasBundledNode)
        guard let node = hasBundledNode ? bundledNode : environment.node else {
            throw DaemonError("node was not found in your login shell's PATH")
        }
        let daemonDir = repoURL.appending(path: "packages/daemon")
        guard FileManager.default.fileExists(atPath: daemonDir.appending(path: "src/main.ts").path) else {
            throw DaemonError("pilotd sources not found at \(daemonDir.path). Set PILOT_REPO.")
        }
        try FileManager.default.createDirectory(at: logURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: plistURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        // Workers inherit execPath. Extensions also need this Node first in PATH, even without a
        // system Node installation. Keep the user's shell PATH for jj, gh, fnox and other tools.
        let path = hasBundledNode ? "\(repoURL.appending(path: "node/bin").path):\(environment.path)" : environment.path
        var variables = ["PATH": path, "PILOT_PORT": String(port)]
        for key in ["PILOT_HOME", "PILOT_AGENT_DIR"] {
            if let value = ProcessInfo.processInfo.environment[key] { variables[key] = value }
        }
        let plist: [String: Any] = [
            "Label": Self.label,
            "ProgramArguments": [node, "--import", "tsx", "src/main.ts"],
            "WorkingDirectory": daemonDir.path,
            "EnvironmentVariables": variables,
            "RunAtLoad": true,
            "KeepAlive": true,
            "ThrottleInterval": 10,
            "StandardOutPath": logURL.path,
            "StandardErrorPath": logURL.path,
        ]
        let data = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
        if (try? Data(contentsOf: plistURL)) != data {
            // A changed definition only applies after reloading the agent.
            _ = try? await run("/bin/launchctl", ["bootout", "\(domain)/\(Self.label)"])
            try data.write(to: plistURL, options: .atomic)
        }
    }

    /// GUI apps get launchd's minimal PATH, so ask login shells for the user's PATH. Try the user's
    /// shell in its own syntax, then zsh and bash, and keep the first PATH that can find node.
    func loginShellEnvironment(requiresNode: Bool, timeout: TimeInterval? = nil) async throws -> (path: String, node: String?) {
        let userShell = ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh"
        var attempts: [(String, [String])] = []
        switch URL(filePath: userShell).lastPathComponent {
        case "nu": attempts.append((userShell, ["-i", "-c", "print $\"__PILOT_PATH__($env.PATH | str join ':')\""]))
        case "fish": attempts.append((userShell, ["-l", "-c", "echo __PILOT_PATH__(string join : $PATH)"]))
        case "zsh", "bash", "sh": break
        default: attempts.append((userShell, ["-ilc", "printf '__PILOT_PATH__%s\\n' \"$PATH\""]))
        }
        attempts.append(("/bin/zsh", ["-ilc", "printf '__PILOT_PATH__%s\\n' \"$PATH\""]))
        attempts.append(("/bin/bash", ["-lc", "printf '__PILOT_PATH__%s\\n' \"$PATH\""]))

        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let fallbacks = ["\(home)/.local/share/mise/shims", "/opt/homebrew/bin", "/usr/local/bin", "\(home)/.volta/bin"]
        let base = ProcessInfo.processInfo.environment["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"
        let findNode = { (path: String) in
            path.split(separator: ":").map { "\($0)/node" }.first { FileManager.default.isExecutableFile(atPath: $0) }
        }
        for (shell, arguments) in attempts where FileManager.default.isExecutableFile(atPath: shell) {
            let output: String?
            if let timeout {
                output = await UpdateCommand.output(executable: URL(filePath: shell), arguments: arguments,
                                                    path: base, timeout: timeout)
            } else { output = try? await run(shell, arguments) }
            guard let output,
                  let line = output.split(separator: "\n").last(where: { $0.hasPrefix("__PILOT_PATH__") })
            else { continue }
            let path = String(line.dropFirst("__PILOT_PATH__".count))
            if !requiresNode || findNode(path) != nil { return (path, findNode(path)) }
        }
        // Last resort: common install locations (mise shims also expose jj, gh, fnox...).
        let path = (fallbacks + [base]).joined(separator: ":")
        return (path, findNode(path))
    }

    @discardableResult
    private func run(_ executable: String, _ arguments: [String]) async throws -> String {
        try await Task.detached {
            let process = Process()
            process.executableURL = URL(filePath: executable)
            process.arguments = arguments
            let pipe = Pipe()
            process.standardOutput = pipe
            process.standardError = pipe
            process.standardInput = FileHandle.nullDevice
            try process.run()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            let output = String(decoding: data, as: UTF8.self)
            guard process.terminationStatus == 0 else {
                throw DaemonError("\(executable) \(arguments.joined(separator: " ")) failed: \(output)")
            }
            return output
        }.value
    }
}

struct DaemonError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}
