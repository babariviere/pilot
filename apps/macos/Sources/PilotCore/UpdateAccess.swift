import Foundation
import Darwin

public enum UpdateAccessSource: Sendable, Equatable {
    case githubCLI
    case savedToken
}

/// Credentials are never Codable or persisted by the resolver. Only manual tokens use Keychain.
public struct UpdateAccess: Sendable {
    public let token: String
    public let source: UpdateAccessSource
}

@MainActor
public enum UpdateAccessResolver {
    public static func resolve(
        cliToken: () async -> String?, savedToken: () throws -> String?
    ) async throws -> UpdateAccess? {
        if let token = GitHubTokenCommand.validToken(await cliToken()) {
            return UpdateAccess(token: token, source: .githubCLI)
        }
        if let token = GitHubTokenCommand.validToken(try savedToken()) {
            return UpdateAccess(token: token, source: .savedToken)
        }
        return nil
    }
}

public enum GitHubTokenCommand {
    public static func validToken(_ value: String?) -> String? {
        guard let value else { return nil }
        let token = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !token.isEmpty, token.unicodeScalars.allSatisfy({ (0x21...0x7E).contains($0.value) }) else { return nil }
        return token
    }

    /// Capture stdout only, discard diagnostics, and never include credential output in errors.
    public static func read(executable: URL, path: String, timeout: TimeInterval = 10) async -> String? {
        validToken(await UpdateCommand.output(executable: executable,
            arguments: ["auth", "token", "--hostname", "github.com"], path: path, timeout: timeout))
    }
}

/// Bounded in-memory capture, including commands whose descendants keep stdout open.
public enum UpdateCommand {
    public static func output(executable: URL, arguments: [String], path: String,
                              timeout: TimeInterval, maxBytes: Int = 65_536) async -> String? {
        await Task.detached {
            run(executable: executable, arguments: arguments, path: path, timeout: timeout, maxBytes: maxBytes)
        }.value
    }

    // Process's run-loop bookkeeping must stay on the launching thread. Keep the bounded
    // polling synchronous inside the detached task, not across async suspension points.
    private static func run(executable: URL, arguments: [String], path: String,
                            timeout: TimeInterval, maxBytes: Int) -> String? {
        let process = Process()
        process.executableURL = executable
        process.arguments = arguments
        process.currentDirectoryURL = FileManager.default.homeDirectoryForCurrentUser
        var environment = ProcessInfo.processInfo.environment
        environment["PATH"] = path
        environment["GH_PROMPT_DISABLED"] = "1"
        process.environment = environment
        let output = Pipe()
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        process.standardInput = FileHandle.nullDevice
        do { try process.run() } catch { return nil }
        let descriptor = output.fileHandleForReading.fileDescriptor
        defer { try? output.fileHandleForReading.close() }
        guard fcntl(descriptor, F_SETFL, O_NONBLOCK) != -1 else {
            if process.isRunning { Darwin.kill(process.processIdentifier, SIGKILL) }
            process.waitUntilExit()
            return nil
        }
        let deadline = ProcessInfo.processInfo.systemUptime + timeout
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        var completed = false
        while ProcessInfo.processInfo.systemUptime < deadline {
            let count = Darwin.read(descriptor, &buffer, buffer.count)
            if count > 0 {
                guard data.count + count <= maxBytes else { break }
                data.append(contentsOf: buffer.prefix(count))
            } else if count == 0 {
                if !process.isRunning { completed = true; break }
            } else if errno != EAGAIN && errno != EINTR { break }
            Thread.sleep(forTimeInterval: 0.01)
        }
        // gh auth token only reads credentials. Kill only our child on timeout, never the
        // user's existing gh processes or their login. Do not wait for inherited pipe EOF.
        if process.isRunning { Darwin.kill(process.processIdentifier, SIGKILL) }
        process.waitUntilExit()
        guard completed, process.terminationStatus == 0 else { return nil }
        return String(data: data, encoding: .utf8)
    }
}
