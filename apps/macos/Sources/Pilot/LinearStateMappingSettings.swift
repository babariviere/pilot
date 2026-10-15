import PilotCore
import SwiftUI

/// One workflow lookup at a time, on demand, even when a parent includes many sub-teams.
struct LinearStateMappingSettings: View {
    let root: TrackedTeamRef
    let teams: [LinearTeamOption]
    @Binding var selections: [String: LinearStateMapping]
    @State private var selectedTeam = ""

    private var scopedTeams: [TrackedTeamRef] {
        var ids: Set<String> = [root.id]
        for _ in 0..<teams.count {
            let children = teams.filter { $0.parentId.map(ids.contains) == true }.map(\.id)
            let next = ids.union(children)
            if next == ids { break }
            ids = next
        }
        return [root] + teams.filter { $0.id != root.id && ids.contains($0.id) }
            .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
            .map { TrackedTeamRef(id: $0.id, name: $0.name) }
    }

    private var team: String { scopedTeams.contains { $0.id == selectedTeam } ? selectedTeam : root.id }

    var body: some View {
        if scopedTeams.count > 1 {
            SettingsRow("Workflow team") {
                Picker("Workflow team", selection: Binding(get: { team }, set: { selectedTeam = $0 })) {
                    ForEach(scopedTeams, id: \.id) { team in Text(team.name ?? team.id).tag(team.id) }
                }
                .labelsHidden()
                .fixedSize()
            }
            .help("Each sub-team has its own Linear workflow and state mappings.")
        }
        LinearStateMappingPickers(team: team, selections: $selections).id(team)
    }
}

private struct LinearStateMappingPickers: View {
    let team: String
    @Binding var selections: [String: LinearStateMapping]
    @ObservedObject private var client = AppModel.shared.client
    @State private var lookup: TrackingLookup<LinearWorkflowStateOption>?
    @State private var loading = false
    @State private var problem: String?

    var body: some View {
        ForEach(LinearWorkflowStage.allCases) { stage in
            SettingsRow(stage.title) {
                HStack(spacing: 6) {
                    if loading && stage == .todo { ProgressView().controlSize(.small) }
                    Picker(stage.title, selection: binding(stage)) {
                        Text(stage == .inProgress ? "Automatic (In progress)" : "Not mapped").tag("")
                        if let saved = selections[team]?[stage], !states(stage).contains(where: { $0.id == saved.id }) {
                            Text(lookup?.status == .ok ? "\(saved.name) (unavailable)" : saved.name).tag(saved.id)
                        }
                        ForEach(states(stage)) { state in Text(state.name).tag(state.id) }
                    }
                    .labelsHidden()
                    .frame(maxWidth: 280, alignment: .trailing)
                }
            }
        }
        .task { await load() }
        SettingsRow {
            VStack(alignment: .leading, spacing: 4) {
                SettingsNote("Only In progress is applied when work starts. Todo, In review, Merged and Deployed are saved for future use.")
                SettingsNote("In progress uses a started state. Automatic looks for In progress, never workflow order.")
                if let problem {
                    InlineProblem(problem) { Task { await load() } }
                } else if lookup?.status == .ok && lookup?.items.isEmpty == true {
                    SettingsNote("This team has no workflow states. Starting work will leave the ticket unchanged.")
                }
            }
        }
    }

    private func states(_ stage: LinearWorkflowStage) -> [LinearWorkflowStateOption] {
        (lookup?.items ?? []).filter { stage != .inProgress || $0.type == "started" }
    }

    private func binding(_ stage: LinearWorkflowStage) -> Binding<String> {
        Binding(get: { selections[team]?[stage]?.id ?? "" }, set: { id in
            selections[team, default: LinearStateMapping()][stage] = states(stage).first { $0.id == id }?.reference
        })
    }

    @MainActor private func load() async {
        guard !loading else { return }
        loading = true
        defer { loading = false }
        do {
            let result = try await client.linearStates(team: team)
            guard !Task.isCancelled else { return }
            if result.status == .ok { lookup = result }
            problem = result.status == .ok ? nil
                : result.status == .signInRequired ? "Sign in to Linear above to choose workflow states."
                : result.error ?? "Couldn't load workflow states."
        } catch {
            guard !Task.isCancelled else { return }
            problem = "Couldn't load workflow states."
        }
    }
}
