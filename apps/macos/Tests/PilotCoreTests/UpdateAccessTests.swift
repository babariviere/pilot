import Foundation
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

@Test func ghTokenCommandCapturesOnlySuccessfulStdout() async throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: "pilot-gh-test-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let executable = directory.appending(path: "gh")
    for (script, expected) in [
        ("[ \"$*\" = 'auth token --hostname github.com' ] || exit 1\nprintf 'diagnostic\\n' >&2\nprintf 'fixture-cli-token\\n'", "fixture-cli-token"),
        ("printf 'fixture-rejected-token\\n'; exit 1", nil),
        ("printf 'fixture-token extra-output\\n'", nil),
        ("exec /bin/sleep 30", nil),
        ("trap '' TERM; exec /bin/sleep 30", nil),
        ("exec 1>&-; exec /bin/sleep 30", nil),
        ("(/bin/sleep 0.5; printf 'late-fixture-token') & exit 0", nil),
    ] as [(String, String?)] {
        try "#!/bin/sh\n\(script)\n".write(to: executable, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: executable.path)
        let started = ProcessInfo.processInfo.systemUptime
        // Allow scheduling headroom for normal commands; only deliberate hangs use a short deadline.
        let timeout: TimeInterval = script.contains("/bin/sleep") ? 0.25 : 2
        let token = await GitHubTokenCommand.read(executable: executable, path: "/usr/bin:/bin", timeout: timeout)
        #expect(token == expected)
        #expect(ProcessInfo.processInfo.systemUptime - started < 3)
    }
    try "#!/bin/sh\nprintf 'fixture-too-long'\n".write(to: executable, atomically: true, encoding: .utf8)
    #expect(await UpdateCommand.output(executable: executable, arguments: [], path: "/usr/bin:/bin", timeout: 1, maxBytes: 4) == nil)
    #expect(await GitHubTokenCommand.read(executable: directory.appending(path: "missing-gh"), path: "/usr/bin:/bin") == nil)
}
