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
        case let .make(sessionId): CreateMissionSheet(projectId: nil, sourceSessionId: sessionId)
        case let .add(sessionId): AddToMissionSheet(sessionId: sessionId)
        case let .edit(missionId): EditMissionSheet(missionId: missionId)
        case let .startCoordinator(missionId): StartCoordinatorSheet(missionId: missionId)
        }
    }
}

/// "New mission…" and "Make a mission…". The source chat joins and, by default, coordinates and drafts.
struct CreateMissionSheet: View {
    let projectId: String?
    let sourceSessionId: String?
    @EnvironmentObject private var model: AppModel
    @ObservedObject private var client = AppModel.shared.client
    @State private var form = MissionForm()
    @Environment(\.dismiss) private var dismiss

    private var source: SessionSummary? { sourceSessionId.flatMap { client.session($0) } }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 8) {
                Text(source == nil ? "New mission" : "Make a mission").font(.pilot(.body, weight: .semibold))
                Spacer(minLength: 8)
                if source == nil {
                    projectMenu
                } else if let name = client.project(source?.projectId)?.name {
                    Label(name, systemImage: "folder").font(.pilot(.label)).foregroundStyle(Theme.mutedForeground)
                }
            }
            if let source {
                Text("“\(source.title)” joins the mission. Missions group chats of one project around a shared goal, brief and tasks.")
                    .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground).fixedSize(horizontal: false, vertical: true)
            }
            VStack(alignment: .leading, spacing: 6) {
                TextField("Mission title", text: $form.title)
                    .font(.pilot(.headline, weight: .semibold))
                    .accessibilityLabel("Title")
                TextField(goalPrompt, text: $form.goal, axis: .vertical)
                    .font(.pilot(.body))
                    .lineLimit(1 ... 6)
                    .accessibilityLabel("Goal")
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
                    CoordinatorChatFields(projectId: form.projectId, form: $form.chat)
                }
            }
            if let error = form.error {
                Text(error).font(.pilot(.caption)).foregroundStyle(Theme.destructive).textSelection(.enabled)
            }
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
                Button(createTitle) { create() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(!canCreate)
            }
        }
        .disabled(form.saving)
        .padding(20)
        .frame(width: 500)
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
                    if project.id == form.projectId { Label(project.name, systemImage: "checkmark") } else { Text(project.name) }
                }
            }
        } label: {
            ChipLabel(title: client.project(form.projectId)?.name ?? "Choose project", icon: "folder")
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
                dismiss()
                // Make a mission keeps the chat in view; it is drafting there.
                if source == nil {
                    if let id = detail.mission.coordinatorSessionId { model.selectedSessionId = id }
                    else { model.openMission(detail.mission.id) }
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
    @ObservedObject private var client = AppModel.shared.client
    @State private var form = MissionForm()
    @Environment(\.dismiss) private var dismiss

    private var session: SessionSummary? { client.session(sessionId) }

    private var candidates: [Mission] {
        client.missions.filter { $0.status == .active && $0.projectId == session?.projectId }.sidebarOrder
    }

    private var openTasks: [MissionTask] {
        guard let id = form.missionId, let detail = client.missionDetails[id] else { return [] }
        return MissionTaskOrdering.sorted(detail.tasks).filter { !$0.status.isClosed && $0.sessionId == nil }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Add to mission").font(.headline)
            if candidates.isEmpty {
                Text("There are no active missions in this chat's project. Use Make a mission… to start one.")
                    .font(.callout).foregroundStyle(.secondary)
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
            if let error = form.error {
                Text(error).font(.callout).foregroundStyle(Theme.destructive).textSelection(.enabled)
            }
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
                Button(form.saving ? "Adding…" : "Add") { add() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(form.saving || form.missionId == nil)
            }
        }
        .padding(20)
        .frame(width: 440)
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
    @ObservedObject private var client = AppModel.shared.client
    @State private var form = MissionForm()
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Edit mission").font(.headline)
            Form {
                TextField("Title", text: $form.title)
                TextField("Goal", text: $form.goal, axis: .vertical).lineLimit(3 ... 8)
            }
            .formStyle(.grouped)
            if let error = form.error {
                Text(error).font(.callout).foregroundStyle(Theme.destructive).textSelection(.enabled)
            }
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
                Button(form.saving ? "Saving…" : "Save") { save() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(form.saving || form.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(20)
        .frame(width: 480)
        .onAppear {
            guard !form.prepared, let mission = client.mission(missionId) else { return }
            form.prepared = true
            form.title = mission.title
            form.goal = mission.goal
        }
    }

    private func save() {
        form.saving = true
        form.error = nil
        Task {
            defer { form.saving = false }
            do {
                try await client.updateMission(missionId, UpdateMissionRequest(
                    title: form.title.trimmingCharacters(in: .whitespacesAndNewlines),
                    goal: form.goal.trimmingCharacters(in: .whitespacesAndNewlines)))
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
