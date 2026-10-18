import AppKit
import Foundation
import PilotCore
import SwiftUI
import Testing
@testable import Pilot

private let logicalHome = HostRef(hostId: "local", daemonId: "home", lineageId: "h1")
private let logicalBox = HostRef(hostId: "box", daemonId: "box", lineageId: "b1")

private func logicalDashboard(replicas: [[String: Any]] = [], tasks: [[String: Any]] = [],
                              logical: [ControlLogicalMission]? = nil, logicalTotal: Int? = nil,
                              truncated: Bool = false) throws -> ControlDashboardResponse {
    var object: [String: Any] = ["untrusted": true, "source": "fixture", "projects": [], "chats": [],
        "missions": [], "pullRequests": [], "linear": [], "runningAgents": [], "activeMissions": [],
        "blockers": [], "pendingDecisions": [], "next": ["watches": [], "total": 0],
        "replicaMissions": replicas, "sharedTasks": tasks, "truncated": truncated,
        "totals": ["projects": 0, "chats": 0, "missions": 0, "pullRequests": 0, "linear": 0,
                   "runningAgents": 0, "activeMissions": 0, "blockers": 0, "pendingDecisions": 0]]
    if let logical { object["logicalMissions"] = try JSONSerialization.jsonObject(with: JSONEncoder().encode(logical)) }
    if let logicalTotal, var totals = object["totals"] as? [String: Any] {
        totals["logicalMissions"] = logicalTotal; object["totals"] = totals
    }
    return try JSONDecoder().decode(ControlDashboardResponse.self, from: JSONSerialization.data(withJSONObject: object))
}

private func logicalReplica(_ sequence: Int, title: String = "Synced", complete: Bool = true,
                            binding: String = "binding", time: Double = 100) -> [String: Any] {
    ["id": binding, "bindingId": binding, "projectId": "execution-project", "missionId": "same",
     "missionHome": ["hostId": "daemon", "daemonId": "home", "lineageId": "h1"],
     "title": title, "status": "active", "complete": complete, "sequence": sequence,
     "consistency": "committed", "replicaSyncedAt": time, "replicaAgeMs": 10]
}

private func logicalMission(_ id: String = "same", title: String = "Canonical", status: MissionStatus = .active,
                            done: Int? = nil, total: Int? = nil) -> Mission {
    Mission(id: id, projectId: "project", title: title, goal: "", status: status, createdAt: 1, updatedAt: 2,
            tasksDone: done, tasksTotal: total)
}

@Suite struct LogicalMissionCatalogTests {
    @Test func canonicalDefinitionAndArchiveWinAndUnknownProgressStaysUnknown() throws {
        let canonical = LogicalMissionCatalog.Source(host: logicalHome,
            missions: [logicalMission(status: .archived)], dashboard: nil)
        let replica = LogicalMissionCatalog.Source(host: logicalBox, missions: [],
            dashboard: try logicalDashboard(replicas: [logicalReplica(99)]))
        let result = try LogicalMissionCatalog.normalize([replica, canonical])
        let row = try #require(result.rows.first)
        #expect(result.rows.count == 1 && result.total == 1)
        #expect(row.title == "Canonical" && row.status == .archived)
        #expect(row.tasksDone == nil && row.tasksTotal == nil)
        #expect(row.provenance.count == 2)
    }

    @Test func replicaSequenceNotWallClockAndTiesNeverInventState() throws {
        let dashboard = try logicalDashboard(replicas: [logicalReplica(2, title: "Old", time: 9999),
            logicalReplica(3, title: "New", binding: "new", time: 1),
            logicalReplica(8, title: "Partial", complete: false, binding: "partial", time: 99999)])
        let source = LogicalMissionCatalog.Source(host: logicalBox, missions: [], dashboard: dashboard)
        let result = try LogicalMissionCatalog.normalize([source])
        #expect(result.rows.first?.title == "New")
        let conflict = LogicalMissionCatalog.Source(host: logicalBox, missions: [], dashboard:
            try logicalDashboard(replicas: [logicalReplica(3, title: "Other", binding: "other", time: 99999)]))
        let tied = try LogicalMissionCatalog.normalize([source, conflict])
        #expect(tied.rows.first?.title == nil)
        #expect(tied.rows.first?.status == nil)
        #expect(tied.conflicts == Set(tied.rows.map(\.id)))
        #expect(try LogicalMissionCatalog.normalize([conflict, source]).rows == tied.rows)
    }

    @Test func provisionalAndClippedTaskFactsIdentifyButNeverCountMissionProgress() throws {
        let task: [String: Any] = ["id": "proposal", "bindingId": "binding", "projectId": "execution-project",
            "missionId": "same", "missionHome": ["hostId": "daemon", "daemonId": "home", "lineageId": "h1"],
            "source": "replica", "consistency": "provisional", "title": "Not a mission title", "status": "done",
            "proposalId": "proposal", "proposalState": "pending"]
        let source = LogicalMissionCatalog.Source(host: logicalBox, missions: [], dashboard: try logicalDashboard(tasks: [task]))
        let result = try LogicalMissionCatalog.normalize([source])
        let row = try #require(result.rows.first)
        #expect(row.title == nil && row.status == nil && row.tasksDone == nil && row.tasksTotal == nil)
        #expect(result.provisional.contains(row.id))
    }

    @Test func frozenDtoAndLegacyFallbackHaveTheSameIdentityDefinitionAndProvenance() throws {
        let canonical = LogicalMissionCatalog.Source(host: logicalHome,
            missions: [logicalMission(done: 2, total: 4)], dashboard: nil)
        let replica = LogicalMissionCatalog.Source(host: logicalBox, missions: [], dashboard:
            try logicalDashboard(replicas: [logicalReplica(3)]))
        let fallback = try LogicalMissionCatalog.normalize([canonical, replica])
        let frozen = LogicalMissionCatalog.Source(host: logicalHome, missions: [logicalMission("ignored")],
            dashboard: try logicalDashboard(replicas: [logicalReplica(100, title: "Ignored")], logical: fallback.rows))
        let result = try LogicalMissionCatalog.normalize([frozen])
        #expect(result.rows == fallback.rows)
        #expect(result.total == 1)
        let empty = LogicalMissionCatalog.Source(host: logicalHome, missions: canonical.missions,
            dashboard: try logicalDashboard(logical: []))
        #expect(try LogicalMissionCatalog.normalize([empty]).rows.isEmpty)
    }

    @Test func sameNameAndLocalIdDifferentHomesStayDistinctAndDeduplicationPrecedesCaps() throws {
        let source = LogicalMissionCatalog.Source(host: logicalHome, missions: (0..<60).map {
            logicalMission("m\($0)", title: "Same")
        }, dashboard: nil)
        let other = LogicalMissionCatalog.Source(host: logicalBox, missions: [logicalMission("m0", title: "Same")], dashboard: nil)
        let result = try LogicalMissionCatalog.normalize([source, source, other])
        #expect(result.total == 61 && result.rows.count == 50 && result.truncated)
        #expect(Set(result.rows.map(\.id)).count == 50)
        let bounded = LogicalMissionCatalog.Source(host: logicalBox, missions: [], dashboard:
            try logicalDashboard(replicas: (0..<20).map { logicalReplica(3, binding: "binding-\($0)") }))
        let evidence = try LogicalMissionCatalog.normalize([bounded])
        #expect(evidence.total == 1 && evidence.rows.first?.provenance.count == 16 && evidence.truncated)
    }

    @Test func clippedSourceCannotInventAGlobalMissionCount() throws {
        let source = LogicalMissionCatalog.Source(host: logicalBox, missions: [], dashboard:
            try logicalDashboard(replicas: [logicalReplica(3)], truncated: true))
        let result = try LogicalMissionCatalog.normalize([source])
        #expect(result.total == nil && result.rows.count == 1 && result.truncated)
    }

    @Test func clippedDashboardDoesNotHideMissionsFromTheFullHomeFeed() throws {
        // Reproduce a busy dashboard: 15 stored missions, but only six fit its shared byte budget.
        let missions = (0..<15).map { logicalMission("mission-\($0)", title: "Mission \($0)",
            status: $0 == 14 ? .archived : $0 == 13 ? .done : .active, done: $0, total: 20) }
        let full = try LogicalMissionCatalog.normalize([.init(host: logicalHome, missions: missions, dashboard: nil)])
        let clipped = try logicalDashboard(logical: Array(full.rows.prefix(6)), logicalTotal: 15, truncated: true)
        let source = LogicalMissionCatalog.Source(host: logicalHome, missions: missions, dashboard: clipped)
        let result = try LogicalMissionCatalog.normalize([source])
        #expect(result.rows == full.rows)
        #expect(result.total == 15 && result.truncated)
        #expect(result.conflicts.isEmpty)
        // Repeated observations/reconnects cannot create duplicate mission rows.
        #expect(try LogicalMissionCatalog.normalize([source, source]).rows == full.rows)
    }

    @Test func clippedRecoveryKeepsPublishedFieldsAndHomeQualifiedIdentities() throws {
        let published = try LogicalMissionCatalog.normalize([.init(host: logicalHome,
            missions: [logicalMission("same", title: "Published", status: .archived)], dashboard: nil)])
        let dashboard = try logicalDashboard(replicas: [logicalReplica(100, title: "Ignore legacy")],
            logical: published.rows, logicalTotal: 3, truncated: true)
        let result = try LogicalMissionCatalog.normalize([.init(host: logicalHome,
            missions: [logicalMission("same", title: "Stale"), logicalMission("missing")], dashboard: dashboard),
            .init(host: logicalBox, missions: [logicalMission("same", title: "Different home")], dashboard: nil)])
        #expect(result.rows.count == 3)
        #expect(result.rows.contains { $0.title == "Published" && $0.status == .archived })
        #expect(result.rows.contains { $0.mission.missionId == "missing" && $0.mission.home.daemonId == logicalHome.daemonId })
        #expect(result.rows.contains { $0.title == "Different home" })
        #expect(result.total == nil && result.conflicts.isEmpty)
    }

    @Test func emptyClippedMissionsRecoverButCompleteEmptyListStillWins() throws {
        let missions = [logicalMission()]
        let clipped = try logicalDashboard(logical: [], logicalTotal: 1, truncated: true)
        #expect(try LogicalMissionCatalog.normalize([.init(host: logicalHome, missions: missions,
            dashboard: clipped)]).rows.count == 1)
        // Unrelated chat/watch clipping must not revive a deleted mission.
        let complete = try logicalDashboard(logical: [], logicalTotal: 0, truncated: true)
        #expect(try LogicalMissionCatalog.normalize([.init(host: logicalHome, missions: missions,
            dashboard: complete)]).rows.isEmpty)
        let unknownCount = try logicalDashboard(logical: [], truncated: true)
        let unknown = try LogicalMissionCatalog.normalize([.init(host: logicalHome, missions: missions, dashboard: unknownCount)])
        #expect(unknown.rows.count == 1 && unknown.total == nil)
    }

    @Test func aPublishedReplicaWithTheSameIdCannotSuppressAMissingHomeMission() throws {
        let remote = try LogicalMissionCatalog.normalize([.init(host: logicalBox,
            missions: [logicalMission(title: "Other home")], dashboard: nil)])
        let dashboard = try logicalDashboard(logical: remote.rows, logicalTotal: 2, truncated: true)
        let result = try LogicalMissionCatalog.normalize([.init(host: logicalHome,
            missions: [logicalMission()], dashboard: dashboard)])
        #expect(result.rows.count == 2 && result.total == 2)
        #expect(result.rows.contains { $0.title == "Canonical" && $0.mission.home.daemonId == logicalHome.daemonId })
        #expect(result.rows.contains { $0.title == "Other home" && $0.mission.home.daemonId == logicalBox.daemonId })
    }
}

@MainActor private func logicalEventually(_ predicate: () -> Bool) async throws {
    let deadline = ContinuousClock.now.advanced(by: .seconds(10))
    while !predicate() {
        guard ContinuousClock.now < deadline else { throw URLError(.timedOut) }
        try await Task.sleep(for: .milliseconds(5))
    }
}

@Test @MainActor func missionNavigationAndPaletteKeepCanonicalPinsAcrossExecutionChangesAndReconnect() async throws {
    let model = AppModel()
    try model.registerLocal(logicalHome)
    model.client.loadFixture(projects: [], sessions: [])
    model.client.handle(.missions([logicalMission()]))
    let second = HostRef(hostId: "second", daemonId: "second", lineageId: "s1")
    for host in [logicalBox, second] {
        let client = PilotClient()
        client.loadFixture(projects: [], sessions: [])
        client.handle(.missions([logicalMission()]))
        try model.hosts.install(client, host: host)
    }
    model.missionRegistry.start(model)
    defer { model.missionRegistry.stop() }
    try await logicalEventually { model.missionRegistry.rows.count == 3 }
    let ids = model.missionRegistry.rows.map(\.id)
    let local = try #require(model.missionRegistry.rows.first { $0.mission.home.matches(logicalHome) })
    model.openLogicalMission(local)
    let pinnedLocalKey = try #require(model.selectedMissionId)
    #expect(try HostResourceRef.decodeKey(pinnedLocalKey).host == logicalHome)
    model.newSessionForm.executionHost = second
    let remote = try #require(model.missionRegistry.rows.first { $0.mission.home.matches(logicalBox) })
    model.openLogicalMission(remote, tab: .brief)
    #expect(model.hosts.selection?.host == logicalBox)
    #expect(model.newSessionForm.executionHost == second)
    model.go(to: .tasks)
    #expect(model.missionTab == .tasks && model.hosts.selection?.host == logicalBox)
    let catalog = CommandPaletteCatalog(model: model, openSettings: {}, openKeyboardShortcuts: {})
    let entries = catalog.entries().filter { $0.item.kind == .mission }
    #expect(entries.count == 3 && Set(entries.map { $0.item.id }).count == 3)
    #expect(entries.allSatisfy { !($0.detail ?? "").contains("Local") && !($0.detail ?? "").contains("second") })
    await model.hosts.disconnect(logicalBox)
    try await logicalEventually { !model.missionAvailable(model.missionRegistry.destination(remote, model: model)) }
    #expect(model.missionRegistry.rows.map(\.id) == ids)
    #expect(model.selectedLogicalMission?.id == remote.id)
    let replacement = PilotClient()
    replacement.loadFixture(projects: [], sessions: [])
    replacement.handle(.missions([logicalMission()]))
    try model.hosts.install(replacement, host: logicalBox)
    try await logicalEventually { model.missionAvailable(model.missionRegistry.destination(remote, model: model)) }
    #expect(model.selectedLogicalMission?.id == remote.id)
    model.openMission(HostResourceRef(host: second, kind: .mission, localId: "same").storageKey)
    #expect(model.missionTab == .overview, "Switching missions resets tabs even with colliding IDs")
    #expect(model.hosts.selection?.host == second)
}

@Test @MainActor func replicaMissionRowOpensCanonicalReferenceNotExecutionHost() throws {
    let model = AppModel()
    try model.registerLocal(logicalHome)
    model.newSessionForm.executionHost = logicalBox
    var replica = logicalReplica(4)
    replica["missionHome"] = ["hostId": "daemon", "daemonId": "unavailable-home", "lineageId": "original"]
    let result = try LogicalMissionCatalog.normalize([.init(host: logicalBox, missions: [],
        dashboard: logicalDashboard(replicas: [replica]))])
    let row = try #require(result.rows.first)
    // The row's button runs exactly this action. Its RowButtonStyle draws no NSButton to click, so call it directly.
    model.openLogicalMission(row)
    let selected = try #require(model.selectedMissionId)
    let reference = try HostResourceRef.decodeKey(selected)
    #expect(reference.host.daemonId == "unavailable-home" && reference.host.lineageId == "original")
    #expect(reference.localId == "same" && reference.kind == .mission)
    #expect(model.newSessionForm.executionHost == logicalBox)
}

private struct LogicalProducerFixture: Decodable {
    let sourcePin: HostRef
    let cases: [Case]
    struct Case: Decodable {
        let name: String
        let definitions: [Mission]
        let dashboard: ControlDashboardResponse
        /// Captured compatibility arrays, with only the additive projection fields absent.
        func legacy() throws -> ControlDashboardResponse {
            var value = try JSONDecoder().decode([String: JSONValue].self, from: JSONEncoder().encode(dashboard))
            value["logicalMissions"] = nil
            if case .object(var totals) = value["totals"] {
                totals["logicalMissions"] = nil; value["totals"] = .object(totals)
            }
            return try JSONDecoder().decode(ControlDashboardResponse.self, from: JSONEncoder().encode(value))
        }
    }
    static func read() throws -> Self {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Fixtures/logical-mission-producer.json")
        return try JSONDecoder().decode(Self.self, from: Data(contentsOf: url))
    }
}

@Test func actualHttpProducerPayloadAndLegacyCompatibilityHaveTheSameCanonicalDefinitions() throws {
    let fixture = try LogicalProducerFixture.read()
    #expect(fixture.cases.count == 10)
    for sample in fixture.cases {
        let published = try LogicalMissionCatalog.normalize([.init(host: fixture.sourcePin,
            missions: sample.definitions + (sample.name == "clipped" ? [] : [logicalMission("must-not-augment-published")]),
            dashboard: sample.dashboard)])
        let wire = try #require(sample.dashboard.logicalMissions)
        if sample.name == "clipped" {
            #expect(published.total == 70 && published.truncated && published.rows.count <= 50)
            #expect(published.rows.contains { row in !wire.contains { $0.id == row.id } },
                "Clipped producer rows must be supplemented from the full home feed")
            let legacy = try LogicalMissionCatalog.normalize([.init(host: fixture.sourcePin,
                missions: sample.definitions, dashboard: sample.legacy())])
            #expect(legacy.total == nil && legacy.truncated, "Do not sum clipped compatibility arrays")
            continue
        }
        #expect(Set(published.rows.map(\.id)) == Set(wire.map(\.id)), "Published collection is the only mission input: \(sample.name)")
        for row in published.rows {
            let source = try #require(wire.first { $0.id == row.id })
            #expect(row.title == source.title && row.status == source.status, "\(sample.name)")
            #expect(row.tasksDone == source.tasksDone && row.tasksTotal == source.tasksTotal)
            #expect(row.coordinator == source.coordinator)
            #expect(row.id == LogicalMissionCatalog.identity(home: source.mission.home, missionId: source.mission.missionId))
        }
        let legacy = try LogicalMissionCatalog.normalize([.init(host: fixture.sourcePin,
            missions: sample.definitions, dashboard: sample.legacy())])
        #expect(Set(legacy.rows.map(\.id)) == Set(wire.map(\.id)), "\(sample.name)")
        for row in legacy.rows {
            let source = try #require(wire.first { $0.id == row.id })
            #expect(row.title == source.title && row.status == source.status, "\(sample.name)")
            #expect(row.tasksDone == source.tasksDone && row.tasksTotal == source.tasksTotal)
            #expect(row.coordinator == source.coordinator)
        }
        if sample.name == "equal-sequence-conflict" { #expect(!legacy.conflicts.isEmpty) }
        if sample.name == "provenance-cap" {
            #expect(legacy.rows.first?.provenance.count == 16)
            #expect(legacy.rows.first?.provenance.contains { $0.sequence == 19 } == true)
        }
        if sample.name == "task-only-provisional" {
            #expect(!published.provisional.isEmpty && published.provisional == legacy.provisional)
            #expect(published.rows.first?.tasksTotal == nil && legacy.rows.first?.tasksTotal == nil)
        }
    }
}

@Test func authoritativeCollectionsAreExclusivePerResponseAcrossMixedVersionSources() throws {
    let fixture = try LogicalProducerFixture.read()
    let sample = try #require(fixture.cases.first { $0.name == "greatest-complete" })
    let other = HostRef(hostId: "older-devbox", daemonId: "independent", lineageId: "independent-lineage")
    let result = try LogicalMissionCatalog.normalize([
        .init(host: fixture.sourcePin, missions: [logicalMission("discard-me")], dashboard: sample.dashboard),
        .init(host: logicalBox, missions: [logicalMission("discard-empty")], dashboard: logicalDashboard(logical: [])),
        .init(host: other, missions: [logicalMission("keep-legacy")], dashboard: nil),
    ])
    #expect(result.rows.count == 2)
    #expect(result.rows.contains { $0.mission.missionId == "keep-legacy" && $0.mission.home.daemonId == other.daemonId })
    #expect(!result.rows.contains { $0.mission.missionId.hasPrefix("discard") })
}

@Test @MainActor func publishedAliasHomeNavigatesByCanonicalPinWithoutWeakeningAuthorizationMatching() throws {
    let fixture = try LogicalProducerFixture.read()
    let sample = try #require(fixture.cases.first { $0.name == "greatest-complete" })
    let values = try #require(sample.dashboard.logicalMissions)
    let row = try #require(values.first)
    let pin = HostRef(hostId: "saved-devbox", daemonId: row.mission.home.daemonId, lineageId: row.mission.home.lineageId)
    #expect(LogicalMissionCatalog.matches(row.mission.home, pin: pin))
    #expect(!row.mission.home.matches(pin), "Do not loosen the shared authorization helper")
    let model = AppModel()
    try model.registerLocal(fixture.sourcePin)
    let client = PilotClient()
    client.loadFixture(projects: [], sessions: [])
    client.handle(.missions([logicalMission()]))
    try model.hosts.install(client, host: pin)
    model.openLogicalMission(row)
    #expect(model.hosts.selection?.host == pin)
    #expect(model.hosts.selection?.localId == row.mission.missionId)
}
