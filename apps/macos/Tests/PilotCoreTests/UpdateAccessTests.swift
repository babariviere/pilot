import Foundation
import Darwin
import Testing
@testable import PilotCore

@Test @MainActor func updateAccessPrefersCLIWithoutReadingKeychain() async throws {
    let access = try await UpdateAccessResolver.resolve(cliToken: { "fixture-cli-token\n" }, savedToken: {
        Issue.record("Keychain must not be read when gh provides a token")
        return "fixture-manual-token"
    })
    #expect(access?.token == "fixture-cli-token")
    #expect(access?.source == .githubCLI)
}

@Test @MainActor func updateAccessFallsBackToSavedTokenOrRequiresInput() async throws {
    for unavailable in [nil, "", "\n", "not a token", "invalid\u{0}token", "non-ascii-😀"] as [String?] {
        let access = try await UpdateAccessResolver.resolve(cliToken: { unavailable }, savedToken: { "fixture-manual-token" })
        #expect(access?.token == "fixture-manual-token")
        #expect(access?.source == .savedToken)
        #expect(try await UpdateAccessResolver.resolve(cliToken: { unavailable }, savedToken: { nil })?.source == nil)
    }
}

@Test(.timeLimit(.minutes(1))) func ghTokenCommandCapturesOnlySuccessfulStdout() async throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: "pilot-gh-test-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let executable = directory.appending(path: "gh")
    for (script, expected) in [
        ("[ \"$*\" = 'auth token --hostname github.com' ] || exit 1\nprintf 'diagnostic\\n' >&2\nprintf 'fixture-cli-token\\n'", "fixture-cli-token"),
        ("printf 'fixture-rejected-token\\n'; exit 1", nil),
        ("printf 'fixture-token extra-output\\n'", nil),
    ] as [(String, String?)] {
        try "#!/bin/sh\n\(script)\n".write(to: executable, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: executable.path)
        let token = await GitHubTokenCommand.read(executable: executable, path: "/usr/bin:/bin", timeout: 2)
        #expect(token == expected)
    }
    try "#!/bin/sh\nprintf 'fixture-too-long'\n".write(to: executable, atomically: true, encoding: .utf8)
    #expect(await UpdateCommand.output(executable: executable, arguments: [], path: "/usr/bin:/bin", timeout: 1, maxBytes: 4) == nil)
    #expect(await GitHubTokenCommand.read(executable: directory.appending(path: "missing-gh"), path: "/usr/bin:/bin") == nil)
}

@Test(.timeLimit(.minutes(1)), arguments: [
    "exec /bin/sleep 120",
    "trap '' TERM; exec /bin/sleep 120",
    "exec 1>&-; exec /bin/sleep 120",
    "printf 'fixture-cli-token'; /bin/sleep 120 & printf '%s' \"$!\" > child.pid; exit 0",
]) func ghTokenCommandTimesOutWithoutWaitingForExitOrInheritedStdout(script: String) async throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: "pilot-gh-timeout-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let executable = directory.appending(path: "gh")
    let childPID = directory.appending(path: "child.pid")
    defer {
        if let text = try? String(contentsOf: childPID, encoding: .utf8), let pid = Int32(text) {
            Darwin.kill(pid, SIGKILL)
        }
        try? FileManager.default.removeItem(at: directory)
    }
    // The child cannot finish before the test's deadline. Returning nil therefore proves
    // timeout handling without measuring wall time across a contended executor.
    // Keep the inherited pipe open until cleanup instead of racing a half-second sleep.
    try "#!/bin/sh\ncd '\(directory.path)' || exit 1\nprintf '%s' \"$$\" > child.pid\n\(script)\n".write(to: executable, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: executable.path)
    #expect(await GitHubTokenCommand.read(executable: executable, path: "/usr/bin:/bin", timeout: 2) == nil)
}
