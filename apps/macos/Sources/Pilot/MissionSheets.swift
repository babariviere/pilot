import PilotCore
import SwiftUI

@MainActor
final class MissionFormState: ObservableObject {
    @Published var title = ""
    @Published var goal = ""
    @Published var projectId: String?
    @Published var coordinator = true
    @Published var draft = true
    @Published var missionId: String?
    @Published var taskId: String?
    @Published var saving = false
    @Published var error: String?
    var prepared = false
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
        }
    }
}

/// "New mission…" and "Make a mission…". The source chat joins and, by default, coordinates and drafts.
struct CreateMissionSheet: View {
    let projectId: String?
    let sourceSessionId: String?
    @EnvironmentObject private var model: AppModel
    @ObservedObject private var client = AppModel.shared.client
    @StateObject private var form = MissionFormState()
    @Environment(\.dismiss) private var dismiss

    private var source: SessionSummary? { sourceSessionId.flatMap { client.session($0) } }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(source == nil ? "New mission" : "Make a mission").font(.headline)
            if let source {
                Text("“\(source.title)” joins the mission. Missions group chats of one project around a shared goal, brief and tasks.")
                    .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            Form {
                if source == nil {
                    Picker("Project", selection: $form.projectId) {
                        Text("Choose a project").tag(String?.none)
                        ForEach(client.projects) { Text($0.name).tag(Optional($0.id)) }
                    }
                }
                TextField("Title", text: $form.title)
                TextField(goalPrompt, text: $form.goal, axis: .vertical)
                    .lineLimit(3 ... 6)
                if source != nil {
                    Toggle("This chat coordinates the mission", isOn: $form.coordinator)
                        .help("The coordinator can start and message mission chats. Without one, you coordinate.")
                    Toggle("Ask this chat to draft the brief and tasks", isOn: $form.draft)
                        .help("Sends this chat a message asking it to draft the goal, brief and tasks from its conversation.")
                }
            }
            .formStyle(.grouped)
            if let error = form.error {
                Text(error).font(.callout).foregroundStyle(Theme.destructive).textSelection(.enabled)
            }
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
                Button(form.saving ? "Creating…" : "Create Mission") { create() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(!canCreate)
            }
        }
        .padding(20)
        .frame(width: 480)
        .onAppear(perform: prepare)
    }

    private var goalPrompt: String {
        source != nil && form.draft ? "Goal (optional, the chat can draft it)" : "Goal"
    }

    private var canCreate: Bool {
        guard !form.saving, !form.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        if source != nil { return source?.projectId != nil }
        return form.projectId != nil && !form.goal.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
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
            draft: source == nil ? nil : form.draft
        )
        Task {
            defer { form.saving = false }
            do {
                let detail = try await client.createMission(request)
                dismiss()
                // Make a mission keeps the chat in view; it is drafting there.
                if source == nil { model.openMission(detail.mission.id) }
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
    @StateObject private var form = MissionFormState()
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
    @StateObject private var form = MissionFormState()
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

