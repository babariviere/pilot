import Foundation
import PilotCore
import Testing
@testable import Pilot

private let diagnosticLocalHost = HostRef(hostId: "local", daemonId: "local-daemon", lineageId: "local-lineage")
private let diagnosticRemoteHost = HostRef(hostId: "remote-box", daemonId: "remote-daemon", lineageId: "remote-lineage")
private let diagnosticControlID = "00000000-0000-4000-8000-000000000001"
private let diagnosticRemoteID = "01234567-89ab-4cde-8fab-0123456789ab"

private func diagnosticSession(_ id: String, _ title: String = "Private chat title",
                               role: SessionRole? = nil) -> SessionSummary {
    SessionSummary(id: id, title: title, cwd: "/private/path", createdAt: 1, updatedAt: 2,
                   state: "idle", mode: .ask, role: role)
}

@Test func diagnosticSetupForwardsChosenModelThinkingAndCanonicalRemoteTargetWithoutTranscriptContext() throws {
    let session = diagnosticSession(diagnosticRemoteID, "Secret transcript title")
    let reference = HostResourceRef(host: diagnosticRemoteHost, kind: .session, localId: session.id)
    let target = DiagnosticResolvedTarget(reference: reference, session: session)
    let request = try DiagnosticSetup.spawnRequest(target: target, model: "anthropic/diagnostic",
                                                   thinking: "high", askingAboutPilot: false)
    #expect(request.model == "anthropic/diagnostic")
    #expect(request.thinking == "high")
    #expect(request.role == .diagnostics && request.mode == .ask)
    #expect(request.diagnosticTarget?.host == diagnosticRemoteHost)
    #expect(request.diagnosticTarget?.sessionId == diagnosticRemoteID)
    #expect(request.diagnosticTarget?.chatURL == "pilot://chat/\(diagnosticRemoteID)")
    #expect(!request.message.contains("Secret transcript title"))
    #expect(!request.message.contains("/private/path"))
}

@Test func diagnosticSetupResolvesTrustedDefaultsAndRejectsMalformedMissingAmbiguousOrSpecialistLinks() throws {
    let control = diagnosticSession(diagnosticControlID, "Control")
    let remote = diagnosticSession(diagnosticRemoteID)
    let controlRef = HostResourceRef(host: diagnosticLocalHost, kind: .session, localId: control.id)
    let remoteRef = HostResourceRef(host: diagnosticRemoteHost, kind: .session, localId: remote.id)
    let ask = DiagnosticSetupTarget(reference: controlRef, askingAboutPilot: true, tracksFeature: false)
    let hosted = [Hosted(ref: remoteRef, value: remote)]

    let fallback = try DiagnosticSetup.resolve("", setup: ask, localHost: diagnosticLocalHost,
                                               local: [control], hosted: hosted)
    #expect(fallback.reference == controlRef)
    let linked = try DiagnosticSetup.resolve("pilot://chat/\(diagnosticRemoteID)", setup: ask,
                                             localHost: diagnosticLocalHost, local: [control], hosted: hosted)
    #expect(linked.reference == remoteRef)
    #expect(!DiagnosticSetup.available(linked.reference, localHost: diagnosticLocalHost,
                                       localConnected: true, availableHosts: []))
    #expect(DiagnosticSetup.available(linked.reference, localHost: diagnosticLocalHost,
                                      localConnected: true, availableHosts: [diagnosticRemoteHost]))

    #expect(throws: DiagnosticTargetResolutionError.malformed) {
        try DiagnosticSetup.resolve("https://example.com/private", setup: ask, localHost: diagnosticLocalHost,
                                    local: [control], hosted: hosted)
    }
    #expect(throws: DiagnosticTargetResolutionError.missing) {
        try DiagnosticSetup.resolve("pilot://chat/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", setup: ask,
                                    localHost: diagnosticLocalHost, local: [control], hosted: hosted)
    }
    #expect(throws: DiagnosticTargetResolutionError.ambiguous) {
        try DiagnosticSetup.resolve("pilot://chat/\(diagnosticRemoteID)", setup: ask,
                                    localHost: diagnosticLocalHost, local: [control, remote], hosted: hosted)
    }
    let specialist = diagnosticSession(diagnosticRemoteID, role: .diagnostics)
    #expect(throws: DiagnosticTargetResolutionError.specialist) {
        try DiagnosticSetup.resolve("pilot://chat/\(diagnosticRemoteID)", setup: ask,
                                    localHost: diagnosticLocalHost, local: [control],
                                    hosted: [Hosted(ref: remoteRef, value: specialist)])
    }
}

@Test @MainActor func cancellingDiagnosticSetupHasNoRequestOrSpawnSideEffect() throws {
    let client = PilotClient()
    var control = diagnosticSession(diagnosticControlID, "Control")
    control.control = true
    client.loadFixture(projects: [], sessions: [control])
    let suite = "DiagnosticSetupTests.\(UUID().uuidString)"
    let defaults = try #require(UserDefaults(suiteName: suite))
    defer { defaults.removePersistentDomain(forName: suite) }
    let app = AppModel(projectFolderDefaults: defaults, client: client)
    try app.registerLocal(diagnosticLocalHost)
    app.askAboutPilot()
    #expect(app.diagnosticSetupTarget?.reference.localId == diagnosticControlID)
    #expect(client.fixtureSpawnRequests.isEmpty)
    app.diagnosticSetupTarget = nil
    #expect(client.fixtureSpawnRequests.isEmpty)
}
