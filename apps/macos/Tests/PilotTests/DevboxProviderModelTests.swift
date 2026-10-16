import Foundation
import Testing
@testable import Pilot
@testable import PilotCore

private let providerHost = HostRef(hostId: "box", daemonId: "d", lineageId: "l")
private func providerFixture<T: Decodable>(_ json: String, as type: T.Type = T.self) throws -> T {
    try JSONDecoder().decode(type, from: Data(json.utf8))
}
private func providerRun(state: String = "waiting", reauthentication: Bool = false) throws -> HostedSetupRun {
    HostedSetupRun(host: providerHost, run: try providerFixture("""
    {"id":"same","provider":"anthropic","method":"manual_code","state":"\(state)",
    "createdAt":1,"expiresAt":300001,"reauthenticationRequired":\(reauthentication)}
    """))
}
private func providerReadiness() throws -> SetupReadiness {
    try providerFixture("""
    {"providers":[{"id":"anthropic","name":"Anthropic","methods":["manual_code"],"credential":"missing"}],
    "integrations":[{"kind":"linear","state":"not_configured","login":"unsupported","problem":"Not relayed"}],
    "independentCredentials":true}
    """)
}

@Test @MainActor func providerChallengesAreTransientFencedAndAnswersAreNeverRetriedOrEchoedInErrors() async throws {
    let readiness = try providerReadiness(), run = try providerRun()
    var receiver: ((SetupServerMessage) -> Void)?, starts = 0, answers = 0, closes = 0, available = true
    let actions = DevboxProviderActions(available: { _ in available }, readiness: { _ in readiness }, runs: { _ in [run] },
        start: { host, _ in #expect(host == providerHost); starts += 1; return run }, cancel: { _ in try providerRun(state: "cancelled", reauthentication: true) },
        logout: { _, _ in try providerFixture("{\"state\":\"missing\"}") }, attach: { _, receive in
            receiver = receive
            return DevboxProviderAttachment(answer: { _, _ in answers += 1; throw NSError(domain: "fixture", code: 1, userInfo: [NSLocalizedDescriptionKey: "private-token-in-error"]) }, close: { closes += 1 })
        })
    let model = DevboxProviderModel(host: providerHost, actions: actions)
    await model.refresh()
    await model.start(readiness.providers[0])
    let challenge: SetupChallenge = try providerFixture("{\"id\":\"challenge\",\"type\":\"manual_code\",\"url\":\"https://claude.ai/oauth/authorize?state=private-state\"}")
    receiver?(.challenge(challenge))
    #expect(model.challenge?.id == "challenge")
    await model.answer("private-answer")
    #expect(answers == 1 && starts == 1)
    #expect(model.challenge == nil)
    #expect(model.problem?.contains("private-") == false)
    await model.answer("private-answer")
    #expect(answers == 1)
    let stale = receiver
    model.detach()
    stale?(.challenge(challenge))
    #expect(model.challenge == nil && closes == 1)
    available = false
    await model.start(readiness.providers[0]); await model.refresh()
    #expect(starts == 1)
}

@Test @MainActor func lostProviderStartRequiresReadOnlyReconciliationAndExplicitReattachment() async throws {
    let readiness = try providerReadiness(), run = try providerRun()
    var starts = 0, attachments = 0
    let actions = DevboxProviderActions(available: { _ in true }, readiness: { _ in readiness }, runs: { _ in [run] },
        start: { _, _ in starts += 1; throw URLError(.networkConnectionLost) }, cancel: { _ in run },
        logout: { _, _ in try providerFixture("{\"state\":\"missing\"}") }, attach: { _, _ in
            attachments += 1; return DevboxProviderAttachment(answer: { _, _ in }, close: {})
        })
    let model = DevboxProviderModel(host: providerHost, actions: actions)
    await model.start(readiness.providers[0]); await model.start(readiness.providers[0])
    #expect(starts == 1 && model.uncertainStart)
    await model.refresh()
    #expect(starts == 1 && attachments == 0)
    model.resume(run)
    #expect(starts == 1 && attachments == 1)
    model.detach()
}

@Test @MainActor func providerCancelOnlyReportsTheAcknowledgedHostOutcomeAndUnsupportedIntegrationsStayHonest() async throws {
    let readiness = try providerReadiness(), run = try providerRun()
    var fail = true
    let actions = DevboxProviderActions(available: { _ in true }, readiness: { _ in readiness }, runs: { _ in [] },
        start: { _, _ in run }, cancel: { _ in
            if fail { throw URLError(.networkConnectionLost) }
            return try providerRun(state: "cancelled", reauthentication: true)
        }, logout: { _, _ in try providerFixture("{\"state\":\"missing\"}") },
        attach: { _, _ in DevboxProviderAttachment(answer: { _, _ in }, close: {}) })
    let model = DevboxProviderModel(host: providerHost, actions: actions)
    await model.start(readiness.providers[0]); await model.cancel()
    #expect(model.selected?.run.state == .waiting)
    #expect(model.problem?.contains("not confirmed") == true)
    fail = false
    await model.cancel()
    #expect(model.selected?.run.state == .cancelled)
    #expect(model.selected?.run.reauthenticationRequired == true)
    #expect(DevboxProviderCopy.integration(readiness.integrations[0]).contains("not supported"))
}
