import Foundation
import PilotCore
import Testing

@Test func appRepairAdmissionHasNoFabricatedChatAndRetainsExactConfigurationAndTitle() throws {
    let host = HostRef(hostId: "local", daemonId: "daemon", lineageId: "lineage")
    let binding = DiagnosticRepairProjectBinding(id: "00000000-0000-4000-8000-000000000009", revision: 4,
        host: host, projectId: "source", path: "/sources/pilot", configuredAt: "2026-10-19T00:00:00Z")
    let admission = DiagnosticRepairAdmission(specialistSessionId: "diagnostics", proposalId: "proposal",
        subject: .app(host: host), binding: binding, repairTitle: "Sidebar selection persists after a host switch")
    let request = SpawnRequest(projectId: "source", message: "Reviewed material", title: admission.repairTitle,
        model: "test/model", mode: .build, workspace: .clone, diagnosticRepair: admission)
    let data = try JSONEncoder().encode(request)
    let recovered = try JSONDecoder().decode(SpawnRequest.self, from: data)
    #expect(recovered.diagnosticRepair == admission)
    #expect(recovered.diagnosticRepair?.target == nil)
    #expect(recovered.diagnosticRepair?.evidenceSubject == .app(host: host))
    #expect(recovered.title == admission.repairTitle)
    #expect(recovered.model == "test/model")
    let object = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    let authority = try #require(object["diagnosticRepair"] as? [String: Any])
    #expect(authority["target"] == nil)
}

@Test func repairBindingMatchesIdentityAndRegisteredPathButNotNamesOrHostAliases() {
    let host = HostRef(hostId: "local", daemonId: "daemon", lineageId: "lineage")
    let binding = DiagnosticRepairProjectBinding(id: "00000000-0000-4000-8000-000000000009", revision: 1,
        host: host, projectId: "source", path: "/sources/pilot", configuredAt: "2026-10-19T00:00:00Z")
    let source = Project(id: "source", name: "Renamed source", path: "/sources/pilot", createdAt: 1)
    let clone = Project(id: "another", name: "Pilot", path: "/sources/another", createdAt: 1)
    #expect(binding.matches(host: host, projects: [source, clone]))
    #expect(!binding.matches(host: host, projects: [clone]))
    #expect(!binding.matches(host: HostRef(hostId: "alias", daemonId: "daemon", lineageId: "lineage"), projects: [source]))
    #expect(!binding.matches(host: HostRef(hostId: "local", daemonId: "daemon", lineageId: "new"), projects: [source]))
    #expect(!binding.matches(host: host, projects: [Project(id: "source", name: "Pilot", path: "/moved", createdAt: 1)]))
}

@Test func legacyChatOnlyRepairReceiptsRemainReadableWithoutCreatingAppAuthority() throws {
    let data = Data(#"{"specialistSessionId":"specialist","proposalId":"proposal","target":{"host":{"hostId":"local","daemonId":"daemon","lineageId":"lineage"},"sessionId":"01234567-89ab-4cde-8fab-0123456789ab","chatUrl":"pilot://chat/01234567-89ab-4cde-8fab-0123456789ab"}}"#.utf8)
    let receipt = try JSONDecoder().decode(DiagnosticRepairAdmission.self, from: data)
    #expect(receipt.binding == nil && receipt.repairTitle == nil)
    #expect(receipt.evidenceSubject?.kind == .chat)
    #expect(receipt.evidenceSubject?.sessionId == "01234567-89ab-4cde-8fab-0123456789ab")
}
