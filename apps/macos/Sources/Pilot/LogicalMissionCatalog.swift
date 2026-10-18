import Foundation
import PilotCore

/// Compatibility normalization into the existing shared DTO, not another wire projection. Run off
/// the UI actor. Sources are verified endpoints; only committed mission definitions supply progress.
enum LogicalMissionCatalog {
    struct Source: Sendable {
        let host: HostRef
        var missions: [Mission]
        var dashboard: ControlDashboardResponse?
    }
    struct Result: Sendable {
        let rows: [ControlLogicalMission]
        let total: Int?
        let truncated: Bool
        let conflicts: Set<String>
        let provisional: Set<String>
    }
    private struct Observation {
        let row: ControlLogicalMission
        let canonical: Bool
        let sequence: Int?
    }
    static let rowLimit = 50
    static let provenanceLimit = 16
    static let byteLimit = 24_000

    static func identity(home: OperationHost, missionId: String) -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.withoutEscapingSlashes]
        // Strings cannot fail JSON encoding.
        return String(decoding: try! encoder.encode([home.daemonId, home.lineageId, missionId]), as: UTF8.self)
    }

    static func normalize(_ sources: [Source]) throws -> Result {
        var groups: [String: [Observation]] = [:]
        var truncated = false
        var countKnown = true
        var provisional: Set<String> = []
        func append(_ row: ControlLogicalMission) {
            let home = row.mission.home
            guard home.hostId == "daemon", !home.daemonId.isEmpty, !home.lineageId.isEmpty,
                  !row.mission.missionId.isEmpty else { return }
            let canonical = row.provenance.contains { $0.kind == .canonical && $0.sourceHost == home }
            let sequence = row.provenance.filter { $0.kind == .replica && $0.complete == true }
                .compactMap(\.sequence).max()
            let id = identity(home: home, missionId: row.mission.missionId)
            groups[id, default: []].append(Observation(row: row, canonical: canonical, sequence: sequence))
        }
        for source in sources {
            let host = OperationHost(source.host)
            let dashboard = source.dashboard
            if dashboard?.truncated == true { truncated = true; countKnown = false }
            for task in dashboard?.sharedTasks ?? [] where task.consistency == "provisional" {
                provisional.insert(identity(home: task.missionHome, missionId: task.missionId))
            }
            if let logical = dashboard?.logicalMissions {
                // Presence, including an empty list, supersedes all legacy collections from this source.
                for row in logical { append(row) }
                if (dashboard?.totals.logicalMissions ?? logical.count) > logical.count { countKnown = false; truncated = true }
                continue
            }
            let known = Set(source.missions.map(\.id))
            for mission in source.missions {
                append(try row(home: host, id: mission.id, title: mission.title, status: mission.status,
                    done: mission.tasksDone, total: mission.tasksTotal, coordinator: mission.coordinatorSessionId,
                    provenance: provenance(kind: "canonical", host: host, projectId: mission.projectId)))
            }
            for mission in dashboard?.missions ?? [] where !known.contains(mission.id) {
                append(try row(home: host, id: mission.id, title: mission.title, status: mission.status,
                    done: mission.tasksDone, total: mission.tasksTotal, coordinator: mission.coordinatorSessionId,
                    provenance: provenance(kind: "canonical", host: host, projectId: mission.projectId)))
            }
            for replica in dashboard?.replicaMissions ?? [] where replica.consistency == "committed" && replica.sequence >= 0 {
                append(try row(home: replica.missionHome, id: replica.missionId,
                    title: replica.complete ? replica.title : nil, status: replica.complete ? replica.status : nil,
                    provenance: provenance(kind: "replica", host: host, projectId: replica.projectId,
                        bindingId: replica.bindingId, sequence: replica.sequence, complete: replica.complete,
                        syncedAt: replica.replicaSyncedAt, age: replica.replicaAgeMs)))
            }
            for task in dashboard?.sharedTasks ?? [] {
                // Clipped committed tasks and provisional proposals identify a mission, not its title/counts.
                append(try row(home: task.missionHome, id: task.missionId,
                    provenance: provenance(kind: "replica", host: host, projectId: task.projectId,
                        bindingId: task.bindingId, syncedAt: task.replicaSyncedAt, age: task.replicaAgeMs)))
            }
        }
        var conflicts: Set<String> = []
        var rows: [ControlLogicalMission] = []
        for id in groups.keys.sorted() {
            let observations = groups[id]!
            let canonical = observations.filter(\.canonical)
            let latest = observations.compactMap(\.sequence).max()
            let selected = !canonical.isEmpty ? canonical : observations.filter { latest != nil && $0.sequence == latest }
            var fields: [String: JSONValue] = ["id": .string(id), "mission": try json(observations[0].row.mission)]
            // Equal-sequence disagreements are unknown, never resolved by wall clock or input order.
            if let first = selected.first {
                let values = try selected.map { try json($0.row) }
                let firstValue = try json(first.row)
                for key in ["title", "status", "tasksDone", "tasksTotal", "coordinator"] {
                    if values.allSatisfy({ $0[key] == firstValue[key] }) { fields[key] = firstValue[key] }
                    else { conflicts.insert(id) }
                }
                if let coordinator = first.row.coordinator, coordinator.host != first.row.mission.home {
                    fields["coordinator"] = nil
                    conflicts.insert(id)
                }
            }
            var evidence: [ControlMissionProvenance] = []
            for observation in observations {
                for item in observation.row.provenance where !evidence.contains(item) { evidence.append(item) }
            }
            // Canonical evidence cannot be displaced by many replica bindings.
            evidence.sort {
                if $0.kind != $1.kind { return $0.kind == .canonical }
                return evidenceKey($0) < evidenceKey($1)
            }
            if evidence.count > provenanceLimit { truncated = true }
            fields["provenance"] = .array(try evidence.prefix(provenanceLimit).map { try json($0) })
            rows.append(try decode(ControlLogicalMission.self, .object(fields)))
        }
        rows.sort {
            if ($0.status == .active) != ($1.status == .active) { return $0.status == .active }
            let comparison = ($0.title ?? "").localizedStandardCompare($1.title ?? "")
            return comparison == .orderedSame ? $0.id < $1.id : comparison == .orderedAscending
        }
        let total = countKnown ? rows.count : nil
        if rows.count > rowLimit { truncated = true }
        var displayed: [ControlLogicalMission] = []
        var bytes = 2
        for row in rows.prefix(rowLimit) {
            let size = try JSONEncoder().encode(row).count + 1
            guard bytes + size <= byteLimit else { truncated = true; continue }
            bytes += size
            displayed.append(row)
        }
        let ids = Set(displayed.map(\.id))
        return Result(rows: displayed, total: total, truncated: truncated,
            conflicts: conflicts.intersection(ids), provisional: provisional.intersection(ids))
    }

    private static func evidenceKey(_ item: ControlMissionProvenance) -> String {
        [item.sourceHost.daemonId, item.sourceHost.lineageId, item.projectId, item.bindingId ?? "",
         String(item.sequence ?? -1), String(item.complete ?? false)].joined(separator: "\u{0}")
    }
    private static func provenance(kind: String, host: OperationHost, projectId: String,
        bindingId: String? = nil, sequence: Int? = nil, complete: Bool? = nil,
        syncedAt: Double? = nil, age: Double? = nil) throws -> ControlMissionProvenance {
        var value: [String: JSONValue] = ["kind": .string(kind), "sourceHost": try json(host), "projectId": .string(projectId)]
        value["bindingId"] = bindingId.map(JSONValue.string)
        value["sequence"] = sequence.map { .number(Double($0)) }
        value["complete"] = complete.map(JSONValue.bool)
        value["replicaSyncedAt"] = syncedAt.map(JSONValue.number)
        value["replicaAgeMs"] = age.map(JSONValue.number)
        return try decode(ControlMissionProvenance.self, .object(value))
    }
    private static func row(home: OperationHost, id: String, title: String? = nil, status: MissionStatus? = nil,
        done: Int? = nil, total: Int? = nil, coordinator: String? = nil,
        provenance: ControlMissionProvenance) throws -> ControlLogicalMission {
        var value: [String: JSONValue] = ["id": .string(identity(home: home, missionId: id)),
            "mission": .object(["home": try json(home), "missionId": .string(id)]),
            "provenance": .array([try json(provenance)])]
        value["title"] = title.map(JSONValue.string)
        value["status"] = status.map { .string($0.rawValue) }
        value["tasksDone"] = done.map { .number(Double($0)) }
        value["tasksTotal"] = total.map { .number(Double($0)) }
        value["coordinator"] = try coordinator.map { .object(["host": try json(home), "sessionId": .string($0)]) }
        return try decode(ControlLogicalMission.self, .object(value))
    }
    private static func json<T: Encodable>(_ value: T) throws -> JSONValue {
        try JSONValue.decode(JSONEncoder().encode(value))
    }
    private static func decode<T: Decodable>(_ type: T.Type, _ value: JSONValue) throws -> T {
        try JSONDecoder().decode(type, from: JSONEncoder().encode(value))
    }
}
