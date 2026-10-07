import Foundation

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
        _ = try? await run("/bin/launchctl", ["bootout", "\(domain)/\(Self.label)"])
        status = .stopped
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
        let environment = try await loginShellEnvironment()
        guard let node = environment.node else {
            throw DaemonError("node was not found in your login shell's PATH")
        }
        let daemonDir = repoURL.appending(path: "packages/daemon")
        guard FileManager.default.fileExists(atPath: daemonDir.appending(path: "src/main.ts").path) else {
            throw DaemonError("pilotd sources not found at \(daemonDir.path). Set PILOT_REPO.")
        }
        try FileManager.default.createDirectory(at: logURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: plistURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        var variables = ["PATH": environment.path, "PILOT_PORT": String(port)]
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
    private func loginShellEnvironment() async throws -> (path: String, node: String?) {
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
            guard let output = try? await run(shell, arguments),
                  let line = output.split(separator: "\n").last(where: { $0.hasPrefix("__PILOT_PATH__") })
            else { continue }
            let path = String(line.dropFirst("__PILOT_PATH__".count))
            if let node = findNode(path) { return (path, node) }
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
