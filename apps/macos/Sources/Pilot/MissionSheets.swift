import PilotCore
import SwiftUI

struct MissionForm {
    var title = ""
    var goal = ""
    var projectId: String?
    var coordinator = true
    var draft = true
    var missionId: String?
    var taskId: String?
    var phaseGating = false
    var saving = false
    var error: String?
    var prepared = false
    var chat = CoordinatorChatForm()
}

/// The single entry point for mission sheets.
struct MissionSheetView: View {
    let sheet: MissionSheet

    var body: some View {
        switch sheet {
        case let .create(projectId): CreateMissionSheet(projectId: projectId, sourceSessionId: nil)
        case let .fromSource(draft): CreateMissionSheet(projectId: draft.projectId, sourceSessionId: nil, prefill: draft)
        case let .make(sessionId): CreateMissionSheet(projectId: nil, sourceSessionId: sessionId)
        case let .add(sessionId): AddToMissionSheet(sessionId: sessionId)
        case let .edit(missionId): EditMissionSheet(missionId: missionId)
        case let .startCoordinator(missionId): StartCoordinatorSheet(missionId: missionId)
        }
    }
}

/// "New mission…" and "Make a mission…". The source chat joins and, by default, coordinates and drafts.
struct CreateMissionSheet: View {
    @Environment(\.hostViewContext) private var hostContext
    let projectId: String?
    let sourceSessionId: String?
    /// Prefill from a Linear issue or Slack message. The project is fixed and the mission is linked to it once created.
    var prefill: SourceMissionDraft? = nil
    @EnvironmentObject private var model: AppModel
    @EndpointClient private var client
    @State private var form = MissionForm()
    @Environment(\.dismiss) private var dismiss

    private var source: SessionSummary? { sourceSessionId.flatMap { client.session($0) } }

    var body: some View {
        SheetScaffold(source == nil ? "New mission" : "Make a mission", error: form.error,
                      primary: SheetPrimaryAction(title: createTitle, key: .commandReturn, enabled: canCreate, action: create),
                      width: 500, accessory: {
            if source == nil {
                projectMenu
                    .disabled(prefill != nil)
            } else if let name = client.project(source?.projectId)?.name {
                Label(name, icon: PilotIcon.project).font(.pilot(.label)).foregroundStyle(Theme.mutedForeground)
            }
        }) {
            if let source {
                Text("“\(source.title)” joins the mission. Missions group chats of one project around a shared goal, brief and tasks.")
                    .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground).fixedSize(horizontal: false, vertical: true)
            }
            if let prefill {
                Label(prefill.itemId == nil
                    ? "Prefilled from the common case “\(prefill.label)”. Its summaries are quoted as external content. Its messages stay unlinked, and nothing changes in Slack."
                    : "Prefilled from \(prefill.label). Its text is quoted as external content, and the mission is linked to it once created. Pilot never changes the ticket.",
                      icon: PilotIcon.link)
                    .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground).fixedSize(horizontal: false, vertical: true)
            }
            VStack(alignment: .leading, spacing: 6) {
                TextField("Mission title", text: $form.title)
                    .font(.pilot(.headline, weight: .semibold))
                    .onSubmit { if canCreate { create() } }
                    .accessibilityLabel("Title")
                MissionTextArea(prompt: goalPrompt, text: $form.goal, minLines: 1, maxLines: 6, label: "Goal") {
                    if canCreate { create() }
                }
            }
            .textFieldStyle(.plain)
            HairlineDivider()
            if source != nil {
                MissionToggleRow(title: "This chat coordinates the mission",
                                 detail: "The coordinator can start and message mission chats. Without one, you coordinate.",
                                 isOn: $form.coordinator)
                MissionToggleRow(title: "Ask this chat to draft the brief and tasks",
                                 detail: "Sends this chat a message asking it to draft the goal, brief and tasks from its conversation.",
                                 isOn: $form.draft)
            } else {
                MissionToggleRow(title: "Start a coordinator chat",
                                 detail: "It drafts the brief and tasks for your review. It does not implement them.",
                                 isOn: $form.coordinator)
                if form.coordinator {
                    CoordinatorChatFields(projectId: form.projectId, form: $form.chat) { if canCreate { create() } }
                }
            }
        }
        .disabled(form.saving)
        .onAppear(perform: prepare)
    }

    private var createTitle: String {
        if form.saving { return "Creating…" }
        return source == nil && form.coordinator ? "Create and Start Coordinator" : "Create Mission"
    }

    private var projectMenu: some View {
        Menu {
            ForEach(client.projects) { project in
                Button {
                    form.projectId = project.id
                } label: {
                    if project.id == form.projectId { Label(project.name, icon: PilotIcon.selectedOption) } else { Text(project.name) }
                }
            }
        } label: {
            ChipLabel(title: client.project(form.projectId)?.name ?? "Choose project", icon: PilotIcon.project)
        }
        .chipMenuStyle()
        .fixedSize()
        .help("The project whose chats join this mission")
        .accessibilityLabel("Project: \(client.project(form.projectId)?.name ?? "none")")
    }

    private var goalPrompt: String {
        if source != nil { return form.draft ? "Goal (optional, the chat can draft it)" : "Goal" }
        return form.coordinator ? "Goal (optional, the coordinator can draft it)" : "Goal"
    }

    private var canCreate: Bool {
        guard !form.saving, !form.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        if source != nil { return source?.projectId != nil }
        let ready = form.coordinator ? form.chat.canStart : !form.goal.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        return form.projectId != nil && ready
    }

    private func prepare() {
        guard !form.prepared else { return }
        form.prepared = true
        if let source {
            form.title = source.title
            form.projectId = source.projectId
        } else if let prefill {
            form.projectId = prefill.projectId
            form.title = prefill.title
            form.goal = prefill.goal
            form.chat.message = prefill.message
        } else {
            form.projectId = projectId ?? model.selectedSession?.projectId ?? model.draftProjectId ?? client.projects.first?.id
        }
    }

    private func create() {
        guard let projectId = source?.projectId ?? form.projectId else { return }
        form.saving = true
        form.error = nil
        let request = CreateMissionRequest(
            projectId: projectId,
            title: form.title.trimmingCharacters(in: .whitespacesAndNewlines),
            goal: form.goal.trimmingCharacters(in: .whitespacesAndNewlines),
            fromSessionId: source?.id,
            coordinator: source == nil ? nil : form.coordinator,
            draft: source == nil ? nil : form.draft,
            startCoordinator: source == nil ? form.coordinator : nil,
            model: source == nil && form.coordinator ? form.chat.selectedModel : nil,
            thinking: source == nil && form.coordinator ? form.chat.selectedThinking : nil,
            message: source == nil && form.coordinator ? form.chat.message : nil
        )
        Task {
            defer { form.saving = false }
            do {
                let detail = try await client.createMission(request)
                if let prefill, let itemId = prefill.itemId {
                    await model.bindTrackedItem(itemId, label: prefill.label, missionId: detail.mission.id)
                }
                dismiss()
                // Make a mission keeps the chat in view; it is drafting there.
                if source == nil {
                    if let id = detail.mission.coordinatorSessionId { model.navigate(.session, id: id, context: hostContext) }
                    else { model.openMission(detail.mission.id, context: hostContext) }
                }
            } catch {
                form.error = error.localizedDescription
            }
        }
    }
}

/// Joins a chat to an active mission of its project, optionally claiming a task.
struct AddToMissionSheet: View {
    let sessionId: String
    @EndpointClient private var client
    @State private var form = MissionForm()
    @Environment(\.dismiss) private var dismiss

    private var session: SessionSummary? { client.session(sessionId) }

    private var candidates: [Mission] {
        client.missions.filter { $0.status == .active && $0.projectId == session?.projectId }.sidebarOrder
    }

    private var openTasks: [MissionTask] {
        guard let id = form.missionId, let detail = client.missionDetails[id] else { return [] }
        return MissionTaskOrdering.sorted(detail.tasks).filter { $0.status.canStart && $0.sessionId == nil }
    }

    var body: some View {
        SheetScaffold("Add to mission", error: form.error,
                      primary: SheetPrimaryAction(title: form.saving ? "Adding…" : "Add",
                                                  enabled: !form.saving && form.missionId != nil, action: add),
                      width: 440) {
            if candidates.isEmpty {
                Text("There are no active missions in this chat's project. Use Make a mission… to start one.")
                    .font(.pilot(.body)).foregroundStyle(Theme.mutedForeground)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                Form {
                    Picker("Mission", selection: $form.missionId) {
                        ForEach(candidates) { Text($0.title).tag(Optional($0.id)) }
                    }
                    Picker("Claim task", selection: $form.taskId) {
                        Text("None").tag(String?.none)
                        ForEach(openTasks) { Text("#\($0.number) \($0.title)").tag(Optional($0.id)) }
                    }
                    .disabled(openTasks.isEmpty)
                }
                .formStyle(.grouped)
            }
        }
        .onAppear { if form.missionId == nil { form.missionId = candidates.first?.id } }
        .onChange(of: form.missionId) { _, _ in form.taskId = nil }
        .missionSubscription(form.missionId, client: client)
    }

    private func add() {
        guard let missionId = form.missionId else { return }
        form.saving = true
        form.error = nil
        Task {
            defer { form.saving = false }
            do {
                try await client.joinMission(sessionId, JoinMissionRequest(missionId: missionId, taskId: form.taskId))
                dismiss()
            } catch {
                form.error = error.localizedDescription
            }
        }
    }
}

struct EditMissionSheet: View {
    let missionId: String
    @EndpointClient private var client
    @State private var form = MissionForm()
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        SheetScaffold("Edit mission", error: form.error,
                      primary: SheetPrimaryAction(title: form.saving ? "Saving…" : "Save", key: .commandReturn,
                                                  enabled: canSave, action: save),
                      width: 480) {
            Form {
                TextField("Title", text: $form.title).onSubmit { if canSave { save() } }
                MissionTextArea(prompt: "Goal", text: $form.goal, minLines: 3, maxLines: 8, label: "Goal") {
                    if canSave { save() }
                }
                MissionToggleRow(title: "Later phases wait for earlier ones",
                                 detail: "Tasks in a phase cannot be claimed or started until every earlier phase is done.",
                                 isOn: $form.phaseGating)
            }
            .formStyle(.grouped)
        }
        .onAppear {
            guard !form.prepared, let mission = client.mission(missionId) else { return }
            form.prepared = true
            form.title = mission.title
            form.goal = mission.goal
            form.phaseGating = mission.isPhaseGatingEnabled
        }
    }

    private var canSave: Bool { !form.saving && !form.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    private func save() {
        form.saving = true
        form.error = nil
        let gating = client.mission(missionId)?.isPhaseGatingEnabled == form.phaseGating ? nil : form.phaseGating
        Task {
            defer { form.saving = false }
            do {
                try await client.updateMission(missionId, UpdateMissionRequest(
                    title: form.title.trimmingCharacters(in: .whitespacesAndNewlines),
                    goal: form.goal.trimmingCharacters(in: .whitespacesAndNewlines), phaseGating: gating))
                dismiss()
            } catch {
                form.error = error.localizedDescription
            }
        }
    }
}

/// A switch with a title and one line of explanation, for mission sheets.
struct MissionToggleRow: View {
    let title: String
    let detail: String
    @Binding var isOn: Bool

    var body: some View {
        Toggle(isOn: $isOn) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.pilot(.body)).foregroundStyle(Theme.foreground)
                Text(detail).font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .toggleStyle(.switch)
        .controlSize(.small)
        .help(detail)
    }
}
