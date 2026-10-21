import Foundation
import PilotCore
import SwiftUI

enum LogicalMissionPresentation {
    @MainActor static func line(_ mission: LogicalMission, registry: MissionRegistry, available: Bool) -> String? {
        var parts: [String] = []
        if let done = mission.tasksDone, let total = mission.tasksTotal { parts.append("\(done) of \(total) tasks done") }
        if mission.status == .done { parts.append("Done") }
        if registry.conflicts.contains(mission.id) { parts.append("Conflicting source evidence") }
        if registry.provisional.contains(mission.id) { parts.append("Provisional changes") }
        if !mission.provenance.contains(where: { $0.kind == .canonical }) {
            let age = mission.provenance.compactMap(\.replicaAgeMs).min()
            parts.append(age.map { "Synced \(Int(max(0, $0) / 60000))m ago" } ?? "Sync age unknown")
        }
        if !available { parts.append("Disconnected") }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}

struct LogicalMissionSidebarRow: View {
    let mission: LogicalMission
    @ObservedObject var model: AppModel
    @ObservedObject var registry: MissionRegistry

    var body: some View {
        let reference = registry.destination(mission, model: model)
        let selected = model.selectedLogicalMission?.id == mission.id
        let line = LogicalMissionPresentation.line(mission, registry: registry, available: model.missionAvailable(reference))
        let definition = reference.host == model.localHost ? model.client.mission(reference.localId)
            : model.hosts.missions.first { $0.ref == reference }?.value
        if let definition, definition.title == mission.title, definition.status == mission.status,
           model.missionAvailable(reference), !registry.conflicts.contains(mission.id) {
            let context = HostViewContext(host: reference.host, hosts: model.hosts)
            let members = model.members(of: definition, context: context).filter { !$0.isArchived }
            VStack(alignment: .leading, spacing: 2) {
                MissionSidebarRow(mission: definition, needsYou: model.needsYouCount(definition, context: context),
                    working: members.filter(\.isWorking).count,
                    signal: MissionSidebarSummary.signal(mission: definition, members: members,
                        isUnread: { model.isUnread($0, on: reference.host) }),
                    waitingOnJobs: MissionSidebarSummary.waitingOnJobs(mission: definition, members: members), selected: selected)
            }.environment(\.hostViewContext, context).selectionDisabled(true)
        } else {
            Button { model.openLogicalMission(mission) } label: {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    PilotSymbol(PilotIcon.mission, context: .row).frame(width: 14)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(mission.title ?? "Mission").font(.pilot(.body, weight: .medium)).lineLimit(1)
                        if let line { Text(line).font(.pilot(.small)).foregroundStyle(Theme.mutedForeground).lineLimit(1) }
                    }
                    Spacer(minLength: 0)
                }
                .foregroundStyle(Theme.foreground)
                .padding(.vertical, 3).padding(.leading, 4)
                .contentShape(Rectangle())
            }
            .rowButtonStyle()
            .background(RoundedRectangle(cornerRadius: Theme.Radius.row).fill(selected ? Theme.selected : .clear))
            .accessibilityLabel([mission.title ?? "Mission", line].compactMap { $0 }.joined(separator: ", "))
            .accessibilityAddTraits(selected ? .isSelected : [])
            .selectionDisabled(true)
        }
    }
}

/// Home and the sidebar render the same canonical collection, never concatenate host sections.
struct LogicalMissionHomeSection: View {
    @ObservedObject var model: AppModel
    @ObservedObject var registry: MissionRegistry
    @Binding var expanded: Bool

    var body: some View {
        PageSectionHeader(title: "Missions", count: registry.total)
        if registry.rows.isEmpty {
            Text("No missions available yet.").font(.pilot(.body)).foregroundStyle(Theme.mutedForeground)
        }
        ForEach(expanded ? registry.rows : Array(registry.rows.prefix(5))) { mission in
            LogicalMissionSidebarRow(mission: mission, model: model, registry: registry)
                .keyboardListItem("mission:" + mission.id) { model.openLogicalMission(mission) }
        }
        if registry.rows.count > 5 { ListToggle(total: registry.rows.count, expanded: $expanded) }
        if registry.truncated {
            Text("More missions may be available").font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
        }
    }
}

/// Canonical details only. A replica is evidence, not permission to send writes to the executor.
struct LogicalMissionDestination: View {
    let reference: HostResourceRef
    @ObservedObject var model: AppModel
    @ObservedObject var registry: MissionRegistry

    var body: some View {
        let destination = registry.row(for: reference).map { registry.destination($0, model: model) } ?? reference
        let client = destination.host == model.localHost ? model.client : model.hosts.presentationClient(destination.host)
        if client.mission(destination.localId) != nil, model.missionAvailable(destination) {
            MissionPage(missionId: destination.localId)
                .environment(\.hostViewContext, HostViewContext(host: destination.host, hosts: model.hosts))
                .environment(\.openURL, HostViewContext(host: destination.host, hosts: model.hosts).openURL)
        } else if let mission = registry.row(for: reference) {
            VStack(alignment: .leading, spacing: 20) {
                Text(mission.title ?? "Mission").font(.pilot(.title, weight: .semibold)).foregroundStyle(Theme.foreground)
                if let line = LogicalMissionPresentation.line(mission, registry: registry, available: model.missionAvailable(reference)) {
                    Text(line).font(.pilot(.body)).foregroundStyle(Theme.mutedForeground)
                }
                Text("Read-only summary. Reconnect to the mission’s home to load its current details.")
                    .font(.pilot(.body)).foregroundStyle(Theme.mutedForeground)
                ForEach(Array(mission.provenance.enumerated()), id: \.offset) { _, evidence in
                    HStack {
                        Text(evidence.kind == .canonical ? "Committed definition" : "Synced evidence")
                        Spacer()
                        Text(evidence.replicaSyncedAt.map { Date(timeIntervalSince1970: $0 / 1000).formatted() } ?? "Sync time unknown")
                    }.font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                }
                Spacer()
            }.padding(28).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .background(Theme.background).navigationTitle(mission.title ?? "Mission")
        } else {
            EmptyStateView(icon: PilotIcon.mission, title: "Mission unavailable", message: "Reconnect to load this mission.")
        }
    }
}
