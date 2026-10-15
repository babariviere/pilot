import PilotCore
import SwiftUI

/// One workflow lookup at a time, on demand, even when a parent includes many sub-teams.
struct LinearStartStateSettings: View {
    let root: TrackedTeamRef
    let teams: [LinearTeamOption]
    @Binding var selections: [String: LinearWorkflowState]
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
            Picker("Workflow team", selection: Binding(get: { team }, set: { selectedTeam = $0 })) {
                ForEach(scopedTeams, id: \.id) { team in
                    Text(team.name ?? team.id).tag(team.id)
                }
            }
            .help("Each sub-team has its own Linear workflow and start state.")
        }
        LinearStartStatePicker(team: team, selections: $selections).id(team)
    }
}

private struct LinearStartStatePicker: View {
    let team: String
    @Binding var selections: [String: LinearWorkflowState]
    @ObservedObject private var client = AppModel.shared.client
    @State private var lookup: TrackingLookup<LinearWorkflowState>?
    @State private var loading = false
    @State private var problem: String?

    private var states: [LinearWorkflowState] { lookup?.items ?? [] }

    var body: some View {
        LabeledContent {
            HStack(spacing: 6) {
                if loading { ProgressView().controlSize(.small) }
                Picker("When work starts", selection: binding) {
                    Text("Automatic (In progress)").tag("")
                    if let saved = selections[team], !states.contains(where: { $0.id == saved.id }) {
                        Text(lookup?.status == .ok ? "\(saved.name) (unavailable)" : saved.name).tag(saved.id)
                    }
                    ForEach(states) { state in Text(state.name).tag(state.id) }
                }
                .labelsHidden()
                .frame(maxWidth: 280, alignment: .trailing)
            }
        } label: {
            Text("When work starts")
            Text("Choose a started state for this team. Automatic uses In progress, never workflow order.")
                .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
        }
        .task { await load() }
        if let problem {
            InlineProblem(problem) { Task { await load() } }
        } else if lookup?.status == .ok && states.isEmpty {
            Text("This team has no started states. Starting work will leave the ticket unchanged.")
                .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
        }
    }

    private var binding: Binding<String> {
        Binding(get: { selections[team]?.id ?? "" }, set: { id in
            selections[team] = states.first { $0.id == id }
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
                : result.status == .signInRequired ? "Sign in to Linear above to choose a start state."
                : result.error ?? "Couldn't load workflow states."
        } catch {
            guard !Task.isCancelled else { return }
            problem = "Couldn't load workflow states."
        }
    }
}
