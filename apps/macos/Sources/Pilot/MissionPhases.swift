import AppKit
import PilotCore
import SwiftUI
import UniformTypeIdentifiers

// Phases in the mission page: Tasks tab headers with their actions, the Add phase form, the Overview's
// per-phase progress and the phase line of a task.

/// A Tasks tab phase header: "Build · 3/8 done", folding like a disclosure, with an optional goal under it. A
/// first-class phase has Edit, Move and Delete in a menu shown on hover and in the context menu. Dropping a task on
/// the header moves the task into the phase.
struct MissionPhaseHeader: View {
    let group: MissionPhaseGroup
    let folded: Bool
    let mission: Mission
    let phases: MissionPhaseIndex
    let onToggle: () -> Void
    /// Moves a dragged task into this phase. Nil when the header takes no drops.
    var onDropTask: ((String) -> Void)? = nil
    @EnvironmentObject private var model: AppModel
    @State private var hovered = false
    @State private var editing = false
    @State private var confirmingDelete = false
    @State private var targeted = false

    private var editable: MissionPhase? { phases.isEditable ? group.phase : nil }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Button(action: onToggle) {
                    HStack(spacing: 6) {
                        DisclosureChevron(expanded: !folded).frame(width: 12)
                        Text(group.title).font(.pilot(.label, weight: .semibold)).foregroundStyle(Theme.foreground)
                            .lineLimit(1)
                        Text("·").font(.pilot(.label)).foregroundStyle(Theme.faintForeground)
                        Text(group.progress).font(.pilot(.label)).monospacedDigit().foregroundStyle(Theme.faintForeground)
                            .fixedSize()
                        Spacer(minLength: 0)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help(group.phase?.goal ?? "")
                .accessibilityLabel("\(group.title), \(group.progress)")
                .accessibilityValue(folded ? "Collapsed" : "Expanded")
                .accessibilityAddTraits(.isHeader)
                if editable != nil {
                    // A fixed slot, so building the menu on hover does not move the header.
                    Color.clear.frame(width: 20, height: 20)
                        .overlay {
                            if hovered {
                                Menu { menuItems } label: { PilotSymbol(PilotIcon.more, context: .toolbar) }
                                    .menuStyle(.button)
                                    .rowIconButtonStyle()
                                    .menuIndicator(.hidden)
                                    .fixedSize()
                                    .help("Phase actions")
                                    .accessibilityLabel("Actions for phase \(group.title)")
                            }
                        }
                }
            }
            if !folded, let goal = group.phase?.goal?.trimmingCharacters(in: .whitespacesAndNewlines), !goal.isEmpty {
                Text(goal).font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                    .lineLimit(2).fixedSize(horizontal: false, vertical: true)
                    .padding(.leading, 18)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(RoundedRectangle(cornerRadius: Theme.Radius.row).fill(targeted ? Theme.selected : .clear))
        .padding(.top, 16)
        .onHover { hovered = $0 }
        .contextMenu { if editable != nil { menuItems } }
        .modifier(MissionTaskDropTarget(enabled: onDropTask != nil, targeted: $targeted) { onDropTask?($0) })
        .popover(isPresented: $editing, arrowEdge: .bottom) {
            if let phase = editable {
                MissionPhaseForm(title: "Edit phase", action: "Save", name: phase.name, goal: phase.goal ?? "") { name, goal in
                    try await model.client.updateMissionPhase(mission.id, phaseId: phase.id,
                                                              MissionPhaseWrite(name: name, goal: goal))
                } dismiss: { editing = false }
            }
        }
        .confirmationDialog("Delete phase “\(group.title)”?", isPresented: $confirmingDelete, titleVisibility: .visible) {
            Button("Delete Phase", role: .destructive, action: delete)
        } message: {
            let count = group.counts.total + group.dropped
            Text(count == 0 ? "The phase has no tasks." : "Its \(count) \(count == 1 ? "task moves" : "tasks move") to No phase.")
        }
    }

    @ViewBuilder private var menuItems: some View {
        let position = editable.flatMap { phases.position(of: $0.id) } ?? 0
        Button("Edit Phase…") { editing = true }
        Divider()
        Button("Move Phase Up") { move(-1) }.disabled(position == 0)
        Button("Move Phase Down") { move(1) }.disabled(position >= phases.phases.count - 1)
        Divider()
        Button("Delete Phase…", role: .destructive) { confirmingDelete = true }
    }

    private func move(_ offset: Int) {
        guard let phase = editable else { return }
        let updates = phases.move(phase.id, by: offset)
        model.missionAction { [client = model.client, id = mission.id] in
            for update in updates {
                try await client.updateMissionPhase(id, phaseId: update.id, MissionPhaseWrite(order: update.order))
            }
        }
    }

    private func delete() {
        guard let phase = editable else { return }
        model.missionAction { [client = model.client, id = mission.id] in
            try await client.deleteMissionPhase(id, phaseId: phase.id)
        }
    }
}

/// Name and optional goal of a phase, in a popover. An empty goal clears it.
struct MissionPhaseForm: View {
    let title: String
    let action: String
    let save: (String, String) async throws -> Void
    let dismiss: () -> Void
    @State private var name: String
    @State private var goal: String
    @State private var saving = false
    @State private var error: String?

    init(title: String, action: String, name: String = "", goal: String = "",
         save: @escaping (String, String) async throws -> Void, dismiss: @escaping () -> Void) {
        self.title = title
        self.action = action
        self.save = save
        self.dismiss = dismiss
        _name = State(initialValue: name)
        _goal = State(initialValue: goal)
    }

    private var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.pilot(.body, weight: .semibold))
            TextField("Phase name", text: $name)
                .textFieldStyle(.roundedBorder).onSubmit(submit)
                .accessibilityLabel("Phase name")
            TextField("Goal (optional)", text: $goal, axis: .vertical)
                .lineLimit(1 ... 3)
                .textFieldStyle(.roundedBorder).onSubmit(submit)
                .accessibilityLabel("Phase goal")
            if let error { InlineProblem(error) }
            HStack {
                Spacer()
                Button("Cancel", action: dismiss).keyboardShortcut(.cancelAction)
                Button(action, action: submit).keyboardShortcut(.defaultAction)
                    .disabled(saving || trimmedName.isEmpty)
            }
        }
        .disabled(saving)
        .padding(14)
        .frame(width: 320)
    }

    private func submit() {
        guard !saving, !trimmedName.isEmpty else { return }
        saving = true
        error = nil
        let values = (trimmedName, goal.trimmingCharacters(in: .whitespacesAndNewlines))
        Task { @MainActor in
            defer { saving = false }
            do {
                try await save(values.0, values.1)
                dismiss()
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}

/// "+ Add phase" under the task list, with a popover for its name and goal. New phases go last.
struct MissionAddPhaseButton: View {
    let mission: Mission
    let phases: MissionPhaseIndex
    @EnvironmentObject private var model: AppModel
    @State private var presented = false

    var body: some View {
        QuietAddButton(title: "Add phase") { presented = true }
            .help("Group tasks into an ordered phase")
            .popover(isPresented: $presented, arrowEdge: .bottom) {
                MissionPhaseForm(title: "Add a phase", action: "Add") { name, goal in
                    try await model.client.createMissionPhase(mission.id, MissionPhaseWrite(
                        name: name, goal: goal.isEmpty ? nil : goal, order: phases.nextOrder))
                } dismiss: { presented = false }
            }
    }
}

/// The Overview's progress: one compact row per phase ("Build 12/18") with its status bar, the current phase in the
/// text colour and the rest muted. Rows open Tasks.
struct MissionPhaseProgressList: View {
    let rows: [MissionPhaseGroup]
    let open: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            ForEach(rows) { row in
                Button(action: open) {
                    HStack(spacing: 12) {
                        Text(row.title)
                            .font(.pilot(.label, weight: row.isCurrent ? .semibold : .regular))
                            .foregroundStyle(row.isCurrent ? Theme.foreground : Theme.mutedForeground)
                            .lineLimit(1)
                            .frame(width: 150, alignment: .leading)
                        SegmentedProgressBar(segments: row.counts.segments)
                            .frame(maxWidth: 240)
                        Text("\(row.counts.done)/\(row.counts.total)")
                            .font(.pilot(.caption)).monospacedDigit()
                            .foregroundStyle(row.isCurrent ? Theme.foreground : Theme.mutedForeground)
                            .fixedSize()
                            .frame(minWidth: 36, alignment: .trailing)
                        Spacer(minLength: 0)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help("\(row.title): \(row.counts.summary)")
                .accessibilityLabel("\(row.title)\(row.isCurrent ? ", current phase" : ""): \(row.counts.summary)")
                .accessibilityHint("Opens Tasks")
            }
        }
    }
}

/// A quiet caption naming a task's phase and why phase gating holds it: "Release · Waits for phase Build".
struct MissionTaskPhaseLine: View {
    /// The task's phase name; nil hides it.
    var phase: String?
    /// `MissionPhaseGating.text` for a gated task.
    var gating: String?

    var body: some View {
        if phase != nil || gating != nil {
            HStack(spacing: 4) {
                if let phase {
                    PilotSymbol(PilotIcon.phase)
                    Text(phase)
                }
                if let gating {
                    if phase != nil { Text("·").foregroundStyle(Theme.faintForeground) }
                    PilotSymbol(PilotIcon.privateChannel)
                    Text(gating)
                }
            }
            .font(.pilot(.caption))
            .foregroundStyle(Theme.mutedForeground)
            .lineLimit(1)
            .accessibilityElement(children: .combine)
        }
    }
}

// MARK: Dragging tasks

/// Tasks drag as their id, as plain text visible only inside Pilot, so a drop elsewhere receives nothing.
enum MissionTaskDrag {
    static func provider(_ taskId: String) -> NSItemProvider {
        let provider = NSItemProvider()
        provider.registerDataRepresentation(forTypeIdentifier: UTType.utf8PlainText.identifier, visibility: .ownProcess) { done in
            done(Data(taskId.utf8), nil)
            return nil
        }
        return provider
    }

    /// Reads the dragged task id and hands it to `perform` on the main actor. False when nothing can be read.
    static func receive(_ providers: [NSItemProvider], perform: @escaping @MainActor (String) -> Void) -> Bool {
        guard let provider = providers.first(where: { $0.hasItemConformingToTypeIdentifier(UTType.utf8PlainText.identifier) })
        else { return false }
        _ = provider.loadDataRepresentation(forTypeIdentifier: UTType.utf8PlainText.identifier) { data, _ in
            guard let data, let id = String(data: data, encoding: .utf8), !id.isEmpty else { return }
            Task { @MainActor in perform(id) }
        }
        return true
    }
}

/// Accepts a dragged task, reporting hover through `targeted`.
struct MissionTaskDropTarget: ViewModifier {
    let enabled: Bool
    @Binding var targeted: Bool
    let perform: @MainActor (String) -> Void

    func body(content: Content) -> some View {
        if enabled {
            content.onDrop(of: [.utf8PlainText], isTargeted: $targeted) { providers in
                MissionTaskDrag.receive(providers, perform: perform)
            }
        } else {
            content
        }
    }
}
