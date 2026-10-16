import PilotCore
import SwiftUI

/// "#13 waits on": checkboxes for the mission's other tasks, open work first, with a filter. Tasks that already
/// wait on this one, directly or through others, are disabled because they would make a cycle. Saving replaces the
/// task's dependencies.
struct MissionTaskDependencyEditor: View {
    let task: MissionTask
    let missionId: String
    let dismiss: () -> Void
    @EndpointClient private var client
    @State private var selection: Set<String>
    @State private var query = ""
    @State private var saving = false
    @State private var error: String?

    /// Row height, so the list sizes to its rows up to a limit.
    private static let rowHeight: CGFloat = 24

    init(task: MissionTask, missionId: String, dismiss: @escaping () -> Void) {
        self.task = task
        self.missionId = missionId
        self.dismiss = dismiss
        _selection = State(initialValue: Set(task.dependsOn ?? []))
    }

    var body: some View {
        let tasks = client.missionDetails[missionId]?.tasks ?? []
        let excluded = MissionDependencyChoices.excluded(for: task, in: tasks)
        let candidates = MissionDependencyChoices.candidates(for: task, in: tasks, query: query)
        let chosen = MissionDependencyChoices.selection(selection, in: tasks)
        VStack(alignment: .leading, spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text("#\(task.number) waits on").font(.pilot(.body, weight: .semibold))
                Text("It is ready to start once these are done or dropped.")
                    .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
            }
            TextField("Filter by number or title", text: $query)
                .textFieldStyle(.roundedBorder)
                .accessibilityLabel("Filter tasks")
            if candidates.isEmpty {
                Text(tasks.count > 1 ? "No matching tasks" : "No other tasks yet")
                    .font(.pilot(.label)).foregroundStyle(Theme.faintForeground)
                    .frame(height: Self.rowHeight)
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(candidates) { other in
                            row(other, cycle: excluded.contains(other.id))
                        }
                    }
                }
                .frame(height: min(CGFloat(candidates.count) * Self.rowHeight, Self.rowHeight * 11))
            }
            if let error { InlineProblem(error) }
            HStack {
                Text(chosen.isEmpty ? "No dependencies" : "\(chosen.count) selected")
                    .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground).monospacedDigit()
                Spacer()
                Button("Cancel", action: dismiss).keyboardShortcut(.cancelAction)
                Button("Save") { save(chosen) }.keyboardShortcut(.defaultAction).disabled(saving)
            }
        }
        .disabled(saving)
        .padding(14)
        .frame(width: 380)
    }

    private func row(_ other: MissionTask, cycle: Bool) -> some View {
        let selected = selection.contains(other.id)
        return Toggle(isOn: Binding(get: { selection.contains(other.id) }, set: { on in
            if on { selection.insert(other.id) } else { selection.remove(other.id) }
        })) {
            HStack(spacing: 6) {
                PilotSymbol(other.workStatus.icon)
                    .foregroundStyle(other.workStatus.color)
                    .frame(width: 14)
                Text("#\(other.number)").font(.pilot(.caption)).monospacedDigit().foregroundStyle(Theme.faintForeground)
                    .frame(minWidth: 24, alignment: .leading)
                Text(other.title).font(.pilot(.label))
                    .foregroundStyle(other.workStatus.isClosed || cycle ? Theme.mutedForeground : Theme.foreground)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .toggleStyle(.checkbox)
        .frame(height: Self.rowHeight)
        // A dependency that would make a cycle can only be removed.
        .disabled(cycle && !selected)
        .help(cycle ? "#\(other.number) already waits on #\(task.number)" : "#\(other.number) \(other.title)")
    }

    private func save(_ chosen: [String]) {
        let known = Set((client.missionDetails[missionId]?.tasks ?? []).map(\.id))
        guard Set(chosen) != Set((task.dependsOn ?? []).filter(known.contains)) else { dismiss(); return }
        saving = true
        error = nil
        Task { @MainActor in
            defer { saving = false }
            do {
                try await client.updateMissionTask(missionId, taskId: task.id, MissionTaskWrite(dependsOn: chosen))
                dismiss()
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}

