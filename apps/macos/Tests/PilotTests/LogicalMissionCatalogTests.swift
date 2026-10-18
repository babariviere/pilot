import AppKit
import Foundation
import PilotCore
import SwiftUI
import Testing
@testable import Pilot

private let logicalHome = HostRef(hostId: "local", daemonId: "home", lineageId: "h1")
private let logicalBox = HostRef(hostId: "box", daemonId: "box", lineageId: "b1")

private func logicalDashboard(replicas: [[String: Any]] = [], tasks: [[String: Any]] = [],
                              logical: [ControlLogicalMission]? = nil, truncated: Bool = false) throws -> ControlDashboardResponse {
    var object: [String: Any] = ["untrusted": true, "source": "fixture", "projects": [], "chats": [],
        "missions": [], "pullRequests": [], "linear": [], "runningAgents": [], "activeMissions": [],
        "blockers": [], "pendingDecisions": [], "next": ["watches": [], "total": 0],
        "replicaMissions": replicas, "sharedTasks": tasks, "truncated": truncated,
        "totals": ["projects": 0, "chats": 0, "missions": 0, "pullRequests": 0, "linear": 0,
                   "runningAgents": 0, "activeMissions": 0, "blockers": 0, "pendingDecisions": 0]]
    if let logical { object["logicalMissions"] = try JSONSerialization.jsonObject(with: JSONEncoder().encode(logical)) }
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
        #expect(tied.rows.first?.status == .active)
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

@Test @MainActor func mountedReplicaMissionRowOpensCanonicalReferenceNotExecutionHost() throws {
    let model = AppModel()
    try model.registerLocal(logicalHome)
    model.newSessionForm.executionHost = logicalBox
    var replica = logicalReplica(4)
    replica["missionHome"] = ["hostId": "daemon", "daemonId": "unavailable-home", "lineageId": "original"]
    let result = try LogicalMissionCatalog.normalize([.init(host: logicalBox, missions: [],
        dashboard: logicalDashboard(replicas: [replica]))])
    let row = try #require(result.rows.first)
    let host = NSHostingView(rootView: LogicalMissionSidebarRow(mission: row, model: model, registry: model.missionRegistry))
    host.frame = NSRect(x: 0, y: 0, width: 360, height: 80)
    let window = NSWindow(contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: false)
    window.contentView = host
    defer { window.contentView = nil; window.close() }
    host.layoutSubtreeIfNeeded()
    func buttons(_ view: NSView) -> [NSButton] {
        (view as? NSButton).map { [$0] } ?? view.subviews.flatMap(buttons)
    }
    let mounted = buttons(host)
    #expect(mounted.count == 1)
    let button = try #require(mounted.first)
    button.performClick(nil)
    let selected = try #require(model.selectedMissionId)
    let reference = try HostResourceRef.decodeKey(selected)
    #expect(reference.host.daemonId == "unavailable-home" && reference.host.lineageId == "original")
    #expect(reference.localId == "same" && reference.kind == .mission)
    #expect(model.newSessionForm.executionHost == logicalBox)
}
