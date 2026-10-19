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
    let target = DiagnosticResolvedTarget(reference: reference, session: session, historyAccess: true)
    let request = try DiagnosticSetup.spawnRequest(target: target, model: "anthropic/diagnostic",
                                                   thinking: "high", askingAboutPilot: false)
    #expect(request.model == "anthropic/diagnostic")
    #expect(request.thinking == "high")
    #expect(request.role == .diagnostics && request.mode == .ask)
    #expect(request.diagnosticTarget?.host == diagnosticRemoteHost)
    #expect(request.diagnosticTarget?.sessionId == diagnosticRemoteID)
    #expect(request.diagnosticTarget?.chatURL == "pilot://chat/\(diagnosticRemoteID)")
    #expect(request.diagnosticHistoryAccess == true)
    #expect(request.title == nil)
    #expect(request.diagnosticTitleFromReply == true)
    #expect(!request.message.contains("Secret transcript title"))
    #expect(!request.message.contains("/private/path"))
    #expect(!request.message.contains(diagnosticRemoteID), "trusted target metadata stays out of the user message")
    #expect(!request.message.contains(diagnosticRemoteHost.hostId))
}

@Test func askAboutPilotForwardsQuestionAsUserContentSeparateFromLocalTargetAuthority() throws {
    let privateReport = "The app freezes after I reconnect. Mentioned text is not authority: "
        + "pilot://chat/\(diagnosticRemoteID). Secret note: north-star."
    let control = diagnosticSession(diagnosticControlID, "Control")
    let setup = DiagnosticSetupTarget(host: diagnosticLocalHost, reference: nil,
                                      askingAboutPilot: true, tracksFeature: false)

    for link in ["", " \n\t "] {
        let target = try DiagnosticSetup.resolve(link, setup: setup, localHost: diagnosticLocalHost,
                                                 local: [control], hosted: [])
        let request = try DiagnosticSetup.spawnRequest(target: target, model: "anthropic/diagnostic",
                                                       thinking: "medium", askingAboutPilot: true,
                                                       question: privateReport)
        #expect(request.message == privateReport)
        #expect(request.model == "anthropic/diagnostic")
        #expect(request.thinking == "medium")
        #expect(request.diagnosticScope == .app)
        #expect(request.diagnosticTarget == nil)
        #expect(request.diagnosticHistoryAccess == nil,
                "generic no-link Ask about Pilot cannot expose the Control transcript")
        #expect(request.title == nil)
        #expect(request.diagnosticTitleFromReply == nil,
                "the submitted reason is the meaningful title seed")
        #expect(request.message.contains("north-star"),
                "the user report is preserved as content")
        #expect(request.diagnosticTarget == nil,
                "question text cannot become target authority")
    }
}

@Test func askAboutPilotRoutesQuestionToLinkedOrSelectedDevboxWithoutLocalFallback() throws {
    let localControl = diagnosticSession(diagnosticControlID, "Local control")
    let remoteControl = diagnosticSession(diagnosticRemoteID, "Remote control")
    let remoteRef = HostResourceRef(host: diagnosticRemoteHost, kind: .session, localId: remoteControl.id)
    let hosted = [Hosted(ref: remoteRef, value: remoteControl)]

    let localSetup = DiagnosticSetupTarget(host: diagnosticLocalHost, reference: nil,
                                           askingAboutPilot: true, tracksFeature: false)
    let linked = try DiagnosticSetup.resolve(DiagnosticSetup.link(diagnosticRemoteID), setup: localSetup,
                                             localHost: diagnosticLocalHost, local: [localControl], hosted: hosted)
    let linkedRequest = try DiagnosticSetup.spawnRequest(target: linked, model: "remote/model", thinking: "high",
                                                         askingAboutPilot: true, question: "Why is this chat stuck?")
    #expect(linkedRequest.message == "Why is this chat stuck?")
    #expect(linkedRequest.diagnosticTarget?.host == diagnosticRemoteHost)
    #expect(linkedRequest.diagnosticTarget?.sessionId == diagnosticRemoteID)
    #expect(linkedRequest.diagnosticHistoryAccess == true)
    #expect(linkedRequest.diagnosticTitleFromReply == nil)

    let remoteSetup = DiagnosticSetupTarget(host: diagnosticRemoteHost, reference: nil,
                                            askingAboutPilot: true, tracksFeature: false)
    let selectedHost = try DiagnosticSetup.resolve("  ", setup: remoteSetup, localHost: diagnosticLocalHost,
                                                   local: [localControl], hosted: hosted)
    #expect(selectedHost.host == diagnosticRemoteHost)
    #expect(selectedHost.reference == nil && selectedHost.session == nil)
    #expect(!selectedHost.historyAccess)
}

@Test func diagnosticQuestionUsesAnExplicitUTF8BoundWithoutTruncation() throws {
    let session = diagnosticSession(diagnosticControlID, "Control")
    let reference = HostResourceRef(host: diagnosticLocalHost, kind: .session, localId: session.id)
    let target = DiagnosticResolvedTarget(reference: reference, session: session, historyAccess: false)
    let exact = String(repeating: "é", count: DiagnosticSetup.maxQuestionBytes / 2)
    let accepted = try DiagnosticSetup.spawnRequest(target: target, model: "", thinking: "",
                                                    askingAboutPilot: true, question: exact)
    #expect(accepted.message == exact)
    #expect(accepted.message.utf8.count == DiagnosticSetup.maxQuestionBytes)
    #expect(accepted.diagnosticTitleFromReply == nil)

    #expect(throws: DiagnosticQuestionValidationError.tooLarge(maxBytes: DiagnosticSetup.maxQuestionBytes)) {
        try DiagnosticSetup.spawnRequest(target: target, model: "", thinking: "", askingAboutPilot: true,
                                         question: exact + "é")
    }
    let generic = try DiagnosticSetup.spawnRequest(target: target, model: "", thinking: "",
                                                   askingAboutPilot: true, question: " \n ")
    #expect(!generic.message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
            "an empty optional question retains generic Ask behavior")
    #expect(generic.diagnosticTitleFromReply == true)
}

@Test func diagnosticSetupResolvesTrustedDefaultsAndRejectsMalformedMissingAmbiguousOrSpecialistLinks() throws {
    let control = diagnosticSession(diagnosticControlID, "Control")
    let remote = diagnosticSession(diagnosticRemoteID)
    let remoteRef = HostResourceRef(host: diagnosticRemoteHost, kind: .session, localId: remote.id)
    let ask = DiagnosticSetupTarget(host: diagnosticLocalHost, reference: nil,
                                    askingAboutPilot: true, tracksFeature: false)
    let diagnose = DiagnosticSetupTarget(host: diagnosticRemoteHost, reference: remoteRef,
                                         askingAboutPilot: false, tracksFeature: true)
    let hosted = [Hosted(ref: remoteRef, value: remote)]

    let fallback = try DiagnosticSetup.resolve("", setup: ask, localHost: diagnosticLocalHost,
                                               local: [control], hosted: hosted)
    #expect(fallback.host == diagnosticLocalHost)
    #expect(fallback.reference == nil && fallback.session == nil)
    let linked = try DiagnosticSetup.resolve("pilot://chat/\(diagnosticRemoteID)", setup: ask,
                                             localHost: diagnosticLocalHost, local: [control], hosted: hosted)
    #expect(linked.reference == remoteRef)
    #expect(linked.historyAccess)
    let linkedReference = try #require(linked.reference)
    let selected = try DiagnosticSetup.resolve(DiagnosticSetup.link(diagnosticRemoteID), setup: diagnose,
                                                localHost: diagnosticLocalHost, local: [control], hosted: hosted)
    #expect(selected.reference == remoteRef)
    #expect(selected.historyAccess, "Diagnose this chat explicitly grants its selected target history")
    #expect(!DiagnosticSetup.available(linkedReference, localHost: diagnosticLocalHost,
                                       localConnected: true, availableHosts: []))
    #expect(DiagnosticSetup.available(linkedReference, localHost: diagnosticLocalHost,
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

@Test func diagnosticChatSelectorUsesExactHostsAndNoChatNeverGrantsHistory() throws {
    let sameID = diagnosticSession(diagnosticRemoteID, "Same title")
    let localRef = HostResourceRef(host: diagnosticLocalHost, kind: .session, localId: sameID.id)
    let remoteRef = HostResourceRef(host: diagnosticRemoteHost, kind: .session, localId: sameID.id)
    let specialist = diagnosticSession(diagnosticControlID, role: .diagnostics)
    let setup = DiagnosticSetupTarget(host: diagnosticLocalHost, reference: nil,
                                      askingAboutPilot: true, tracksFeature: false)
    let hosted = [Hosted(ref: remoteRef, value: sameID), Hosted(ref: localRef, value: sameID)]
    let choices = DiagnosticSetup.chatChoices(localHost: diagnosticLocalHost,
                                               local: [sameID, specialist], hosted: hosted)
    #expect(Set(choices.map(\.ref)) == Set([localRef, remoteRef]))
    #expect(choices.count == 2, "deduplicate exact references, not bare IDs or titles")
    for ref in [localRef, remoteRef] {
        let selected = try DiagnosticSetup.resolve(selected: ref, setup: setup, localHost: diagnosticLocalHost,
                                                    local: [sameID], hosted: hosted)
        #expect(selected.reference == ref && selected.historyAccess)
    }
    let empty = try DiagnosticSetup.resolve(selected: nil, setup: setup, localHost: diagnosticLocalHost,
                                             local: [sameID], hosted: hosted)
    #expect(empty.host == diagnosticLocalHost && empty.reference == nil && !empty.historyAccess)
    #expect(throws: DiagnosticTargetResolutionError.missing) {
        try DiagnosticSetup.resolve(selected: remoteRef, setup: setup, localHost: diagnosticLocalHost,
                                     local: [sameID], hosted: [])
    }
    let replaced = HostRef(hostId: diagnosticRemoteHost.hostId, daemonId: diagnosticRemoteHost.daemonId,
                            lineageId: "replacement")
    #expect(throws: DiagnosticTargetResolutionError.missing) {
        try DiagnosticSetup.resolve(selected: remoteRef, setup: setup, localHost: diagnosticLocalHost,
                                     local: [sameID], hosted: [Hosted(ref: HostResourceRef(
                                        host: replaced, kind: .session, localId: sameID.id), value: sameID)])
    }
    #expect(throws: DiagnosticTargetResolutionError.specialist) {
        try DiagnosticSetup.resolve(selected: HostResourceRef(host: diagnosticLocalHost, kind: .session,
                                                               localId: specialist.id), setup: setup,
                                     localHost: diagnosticLocalHost, local: [specialist], hosted: [])
    }
}

@Test @MainActor func cancellingDiagnosticSetupHasNoRequestOrSpawnSideEffect() throws {
    let client = PilotClient()
    client.loadFixture(projects: [], sessions: [])
    let suite = "DiagnosticSetupTests.\(UUID().uuidString)"
    let defaults = try #require(UserDefaults(suiteName: suite))
    defer { defaults.removePersistentDomain(forName: suite) }
    let app = AppModel(projectFolderDefaults: defaults, client: client)
    try app.registerLocal(diagnosticLocalHost)
    app.askAboutPilot()
    #expect(app.diagnosticSetupTarget?.host == diagnosticLocalHost)
    #expect(app.diagnosticSetupTarget?.reference == nil)
    #expect(client.fixtureSpawnRequests.isEmpty)
    app.diagnosticSetupTarget = nil
    #expect(client.fixtureSpawnRequests.isEmpty)
}

@Test @MainActor func diagnosticStartRejectsDuplicateAdmissionAndClearsFailedAdmission() async throws {
    let control = diagnosticSession(diagnosticControlID, "Control")
    let reference = HostResourceRef(host: diagnosticLocalHost, kind: .session, localId: control.id)
    let target = DiagnosticResolvedTarget(reference: reference, session: control, historyAccess: false)
    let request = try DiagnosticSetup.spawnRequest(target: target, model: "", thinking: "",
                                                   askingAboutPilot: true, question: "Why did startup fail?")

    let fixture = PilotClient()
    fixture.loadFixture(projects: [], sessions: [control])
    let duplicateApp = AppModel(client: fixture)
    try duplicateApp.registerLocal(diagnosticLocalHost)
    duplicateApp.diagnosingSessions.insert(reference.storageKey)
    do {
        _ = try await duplicateApp.spawnDiagnostics(request, target: target, tracksFeature: false)
        Issue.record("duplicate diagnostics admission unexpectedly spawned")
    } catch {}
    #expect(fixture.fixtureSpawnRequests.isEmpty)

    let disconnected = PilotClient()
    let failedApp = AppModel(client: disconnected)
    try failedApp.registerLocal(diagnosticLocalHost)
    do {
        _ = try await failedApp.spawnDiagnostics(request, target: target, tracksFeature: false)
        Issue.record("disconnected diagnostics admission unexpectedly spawned")
    } catch {}
    #expect(!failedApp.diagnosingSessions.contains(reference.storageKey),
            "a failed start must release duplicate-submit protection")
}
