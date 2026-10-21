import Foundation
import Testing
@testable import Pilot
@testable import PilotCore

private let githubHost = HostRef(hostId: "box", daemonId: "d", lineageId: "l")
private func githubStatus(_ phase: String = "key_ready", account: String = "octocat") throws -> GitHubSetupStatus {
    try JSONDecoder().decode(GitHubSetupStatus.self, from: Data("""
    {"phase":"\(phase)","account":"\(account)","apiReady":true,"sshReady":false,"publicKey":"ssh-ed25519 fixture","fingerprint":"SHA256:fixture"}
    """.utf8))
}

@Test @MainActor func githubApprovalBindsDisplayedHostAccountAndKeyAndNeverReplaysLostAcknowledgments() async throws {
    let initial = try githubStatus()
    var writes: [GitHubSetupAction] = [], available = true
    let model = GitHubSetupModel(host: githubHost, actions: GitHubSetupActions(available: { $0 == githubHost && available },
        status: { host in #expect(host == githubHost); return initial }, act: { host, action in
            #expect(host == githubHost); writes.append(action); throw URLError(.networkConnectionLost)
        }))
    await model.refresh()
    await model.perform("approve_key")
    await model.perform("approve_key", approval: try githubStatus(account: "other"))
    #expect(writes.isEmpty)
    await model.perform("approve_key", approval: initial)
    #expect(writes.count == 1 && writes[0].account == "octocat" && writes[0].fingerprint == "SHA256:fixture")
    #expect(model.uncertain)
    await model.perform("approve_key", approval: initial)
    #expect(writes.count == 1)
    await model.refresh()
    #expect(!model.uncertain && writes.count == 1)
    available = false; model.detach()
    await model.perform("authorize"); await model.refresh()
    #expect(model.status == nil && writes.count == 1)
}

@Test @MainActor func githubDisconnectedInFlightResponseCannotRestoreChallengeOrApproveAnotherHost() async throws {
    let value = try githubStatus("authorizing")
    var receive: CheckedContinuation<GitHubSetupStatus, any Error>?
    let model = GitHubSetupModel(host: githubHost, actions: GitHubSetupActions(available: { _ in true }, status: { _ in value },
        act: { _, _ in try await withCheckedThrowingContinuation { receive = $0 } }))
    let task = Task { await model.perform("authorize") }
    while receive == nil { await Task.yield() }
    model.detach(); receive?.resume(returning: value); await task.value
    #expect(model.status == nil)
}
