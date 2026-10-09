import AppKit
import PilotCore
import SwiftUI

// MARK: Brief

@MainActor
final class BriefEditorState: ObservableObject {
    @Published var text = ""
    /// Content and revision the edits are based on.
    @Published private(set) var loadedText = ""
    @Published private(set) var baseRevision = 0
    @Published var saving = false
    @Published var error: String?
    /// Latest revision known when a save was rejected as stale.
    @Published var conflict: Int?
    @Published var preview = false
    @Published var revisions: [MissionBriefRevision] = []
    @Published var viewing: MissionBrief?
    private var loaded = false

    var dirty: Bool { text != loadedText }

    func sync(_ brief: MissionBrief?, force: Bool = false) {
        guard force || !loaded || !dirty else { return }
        loaded = true
        text = brief?.markdown ?? ""
        loadedText = text
        baseRevision = brief?.revision ?? 0
        conflict = nil
    }

    func save(missionId: String, client: PilotClient) async {
        saving = true
        error = nil
        defer { saving = false }
        let markdown = text
        do {
            let brief = try await client.saveMissionBrief(missionId, MissionBriefWrite(markdown: markdown, expectedRevision: baseRevision))
            loadedText = markdown
            baseRevision = brief.revision
            conflict = nil
            await loadRevisions(missionId: missionId, client: client)
        } catch let failure as ClientError where failure.status == 409 {
            conflict = client.mission(missionId)?.briefRevision ?? baseRevision + 1
        } catch {
            self.error = error.localizedDescription
        }
    }

    func reload(missionId: String, client: PilotClient) async {
        do { sync(try await client.missionBrief(missionId), force: true) }
        catch { self.error = error.localizedDescription }
    }

    func loadRevisions(missionId: String, client: PilotClient) async {
        revisions = (try? await client.missionBriefRevisions(missionId))?.sorted { $0.revision > $1.revision } ?? revisions
    }

    func view(_ revision: Int, missionId: String, client: PilotClient) async {
        do { viewing = try await client.missionBrief(missionId, revision: revision) }
        catch { self.error = error.localizedDescription }
    }
}

struct MissionBriefTab: View {
    let mission: Mission
    let detail: MissionDetail
    @EnvironmentObject private var model: AppModel
    @ObservedObject private var client = AppModel.shared.client
    @StateObject private var editor = BriefEditorState()
    @StateObject private var decision = MissionInput()
    @StateObject private var comment = MissionInput()

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                decisions
                briefEditor
                comments
                revisions
            }
            .padding(24)
            .frame(maxWidth: 900, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .onAppear { editor.sync(detail.brief) }
        .onChange(of: detail.brief?.revision) { _, _ in editor.sync(detail.brief) }
        .task(id: mission.briefRevision) { await editor.loadRevisions(missionId: mission.id, client: client) }
        .sheet(item: Binding(get: { editor.viewing.map(BriefRevisionItem.init) }, set: { if $0 == nil { editor.viewing = nil } })) { item in
            BriefRevisionViewer(brief: item.brief, editor: editor)
        }
    }

    // Decisions are binding and shown above the brief.
    private var decisions: some View {
        MissionSection("Decisions") {
            ForEach(detail.decisions) { item in
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: "checkmark.seal").foregroundStyle(Theme.success).frame(width: 16)
                    if decision.editingId == item.id {
                        TextField("Decision", text: $decision.secondary, axis: .vertical)
                            .textFieldStyle(.roundedBorder)
                            .onSubmit { saveDecision(item) }
                        Button("Save") { saveDecision(item) }
                        Button("Cancel") { decision.editingId = nil }
                    } else {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(item.text).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                            Text(missionAuthorName(item.authorSessionId, client: client))
                                .font(.caption).foregroundStyle(Theme.mutedForeground)
                        }
                        Spacer()
                        Button { decision.secondary = item.text; decision.editingId = item.id } label: { Image(systemName: "pencil") }
                            .buttonStyle(.borderless).help("Edit decision")
                        Button {
                            model.missionAction { [client, id = mission.id] in
                                try await client.deleteMissionDecision(id, decisionId: item.id)
                            }
                        } label: { Image(systemName: "trash") }
                            .buttonStyle(.borderless).help("Remove decision")
                    }
                }
                .font(.callout)
                .padding(10)
                MissionRowDivider()
            }
            HStack(spacing: 8) {
                TextField("Record a decision", text: $decision.text).textFieldStyle(.roundedBorder).onSubmit(addDecision)
                Button("Add", action: addDecision).disabled(decision.busy || decision.trimmed(decision.text).isEmpty)
            }
            .padding(10)
        }
    }

    private var briefEditor: some View {
        MissionSection("Brief", accessory: {
            HStack(spacing: 8) {
                Text(editor.baseRevision == 0 ? "No revisions yet" : "Revision \(editor.baseRevision)")
                    .font(.caption).foregroundStyle(Theme.faintForeground)
                Picker("", selection: $editor.preview) {
                    Text("Edit").tag(false)
                    Text("Preview").tag(true)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .fixedSize()
                Button(editor.saving ? "Saving…" : "Save") {
                    Task { await editor.save(missionId: mission.id, client: client) }
                }
                .keyboardShortcut("s", modifiers: .command)
                .disabled(!editor.dirty || editor.saving)
            }
        }) {
            if let conflict = editor.conflict {
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Theme.warning)
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Revision \(conflict) was saved while you were editing, so your changes were not saved.")
                            .font(.callout.weight(.medium))
                        Text("Copy your text, reload the latest brief and reapply your edits.")
                            .font(.caption).foregroundStyle(Theme.mutedForeground)
                        HStack {
                            Button("Copy my text") {
                                NSPasteboard.general.clearContents()
                                NSPasteboard.general.setString(editor.text, forType: .string)
                            }
                            Button("Reload latest") { Task { await editor.reload(missionId: mission.id, client: client) } }
                        }
                        .controlSize(.small)
                    }
                }
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Theme.warning.opacity(0.08))
                MissionRowDivider()
            } else if editor.dirty, let latest = detail.brief?.revision, latest > editor.baseRevision {
                Text("Revision \(latest) arrived while you were editing. Saving will be rejected until you reload.")
                    .font(.caption).foregroundStyle(Theme.warning).padding(10)
                MissionRowDivider()
            }
            if let error = editor.error {
                Text(error).font(.caption).foregroundStyle(Theme.destructive).padding(10)
                MissionRowDivider()
            }
            if editor.preview {
                ScrollView {
                    MarkdownView(text: editor.text.isEmpty ? "_The brief is empty._" : editor.text)
                        .padding(14)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(minHeight: 360)
            } else {
                TextEditor(text: $editor.text)
                    .font(.system(size: 13, design: .monospaced))
                    .scrollContentBackground(.hidden)
                    .padding(10)
                    .frame(minHeight: 360)
            }
        }
    }

    private var comments: some View {
        let open = detail.comments.filter(\.isOpen)
        let resolved = detail.comments.filter { !$0.isOpen }
        return MissionSection("Comments") {
            ForEach(open + resolved) { item in
                CommentRow(comment: item, missionId: mission.id)
                MissionRowDivider()
            }
            VStack(alignment: .leading, spacing: 6) {
                TextField("Quote from the brief (optional)", text: $comment.secondary).textFieldStyle(.roundedBorder)
                HStack(spacing: 8) {
                    TextField("Add a comment", text: $comment.text).textFieldStyle(.roundedBorder).onSubmit(addComment)
                    Picker("To", selection: $comment.option) {
                        Text(mission.coordinatorSessionId == nil ? "Anyone" : "Coordinator").tag(String?.none)
                        ForEach(model.members(of: mission).filter { !$0.isArchived }) { Text($0.title).tag(Optional($0.id)) }
                    }
                    .frame(maxWidth: 200)
                    Button("Comment", action: addComment).disabled(comment.busy || comment.trimmed(comment.text).isEmpty)
                }
            }
            .padding(10)
        }
    }

    private var revisions: some View {
        MissionSection("Revision history") {
            if editor.revisions.isEmpty {
                Text("No revisions yet").font(.callout).foregroundStyle(Theme.faintForeground).padding(12)
            }
            ForEach(Array(editor.revisions.enumerated()), id: \.element.revision) { index, revision in
                if index > 0 { MissionRowDivider() }
                Button {
                    Task { await editor.view(revision.revision, missionId: mission.id, client: client) }
                } label: {
                    HStack {
                        Text("Revision \(revision.revision)").monospacedDigit()
                        Text(missionAuthorName(revision.authorSessionId, client: client))
                            .foregroundStyle(Theme.mutedForeground).lineLimit(1)
                        Spacer()
                        Text(missionRelativeTime(revision.createdAt)).foregroundStyle(Theme.faintForeground)
                    }
                    .font(.callout)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 7)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help("Show revision \(revision.revision)")
            }
        }
    }

    private func addDecision() {
        let text = decision.trimmed(decision.text)
        guard !text.isEmpty, !decision.busy else { return }
        decision.busy = true
        model.missionAction { [client, decision, id = mission.id] in
            defer { decision.busy = false }
            try await client.addMissionDecision(id, text: text)
            decision.text = ""
        }
    }

    private func saveDecision(_ item: MissionDecision) {
        let text = decision.trimmed(decision.secondary)
        guard !text.isEmpty else { return }
        model.missionAction { [client, decision, id = mission.id] in
            try await client.updateMissionDecision(id, decisionId: item.id, text: text)
            decision.editingId = nil
        }
    }

    private func addComment() {
        let text = comment.trimmed(comment.text)
        guard !text.isEmpty, !comment.busy else { return }
        let anchor = comment.trimmed(comment.secondary)
        let target = comment.option
        comment.busy = true
        model.missionAction { [client, comment, id = mission.id] in
            defer { comment.busy = false }
            try await client.addMissionComment(id, MissionCommentWrite(text: text, anchor: anchor.isEmpty ? nil : anchor,
                                                                       targetSessionId: target))
            comment.text = ""
            comment.secondary = ""
        }
    }
}

private struct BriefRevisionItem: Identifiable {
    let brief: MissionBrief
    var id: Int { brief.revision }
}

private struct BriefRevisionViewer: View {
    let brief: MissionBrief
    @ObservedObject var editor: BriefEditorState
    @ObservedObject private var client = AppModel.shared.client
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Revision \(brief.revision)").font(.headline)
                    Text("\(missionAuthorName(brief.authorSessionId, client: client)) · \(missionRelativeTime(brief.createdAt)) ago")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Button("Copy into editor") {
                    editor.text = brief.markdown
                    editor.preview = false
                    dismiss()
                }
                .help("Replace the editor text with this revision. Saving creates a new revision.")
                Button("Done") { dismiss() }.keyboardShortcut(.cancelAction)
            }
            .padding()
            Divider()
            ScrollView {
                MarkdownView(text: brief.markdown).padding(20).frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .frame(minWidth: 640, minHeight: 520)
    }
}

private struct CommentRow: View {
    let comment: MissionComment
    let missionId: String
    @EnvironmentObject private var model: AppModel
    @ObservedObject private var client = AppModel.shared.client

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: comment.isOpen ? "text.bubble" : "checkmark.bubble")
                .foregroundStyle(comment.isOpen ? Theme.info : Theme.faintForeground).frame(width: 16)
            VStack(alignment: .leading, spacing: 4) {
                if let anchor = comment.anchor, !anchor.isEmpty {
                    Text(anchor)
                        .font(.caption).italic().foregroundStyle(Theme.mutedForeground).lineLimit(3)
                        .padding(.leading, 8)
                        .overlay(alignment: .leading) { Rectangle().fill(Theme.border).frame(width: 2) }
                }
                Text(comment.text).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                    .foregroundStyle(comment.isOpen ? Theme.foreground : Theme.mutedForeground)
                Text(byline).font(.caption).foregroundStyle(Theme.mutedForeground)
            }
            Spacer()
            if comment.isOpen {
                Button("Resolve") {
                    model.missionAction { [client] in try await client.resolveMissionComment(missionId, commentId: comment.id) }
                }
                .controlSize(.small)
            }
            Button {
                model.missionAction { [client] in try await client.deleteMissionComment(missionId, commentId: comment.id) }
            } label: { Image(systemName: "trash") }
                .buttonStyle(.borderless).help("Delete comment")
        }
        .font(.callout)
        .padding(10)
    }

    private var byline: String {
        var parts = [missionAuthorName(comment.authorSessionId, client: client)]
        if let target = comment.targetSessionId { parts.append("to \(client.session(target)?.title ?? "a chat")") }
        if let revision = comment.revision { parts.append("revision \(revision)") }
        parts.append(missionRelativeTime(comment.createdAt))
        if !comment.isOpen { parts.append("resolved") }
        return parts.joined(separator: " · ")
    }
}

// MARK: Tasks

struct MissionTasksTab: View {
    let mission: Mission
    let detail: MissionDetail
    @EnvironmentObject private var model: AppModel
    @ObservedObject private var client = AppModel.shared.client
    @StateObject private var input = MissionInput()

    var body: some View {
        let groups = MissionTaskOrdering.groups(detail.tasks)
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                MissionProgressBar(done: detail.progress.done, total: detail.progress.total)
                HStack(spacing: 8) {
                    TextField("New task", text: $input.text).textFieldStyle(.roundedBorder).onSubmit(add)
                    Button("Add task", action: add).disabled(input.busy || input.trimmed(input.text).isEmpty)
                }
                if groups.isEmpty {
                    Text("No tasks yet. Add one, or ask a mission chat to plan them.")
                        .font(.callout).foregroundStyle(Theme.faintForeground)
                }
                ForEach(groups) { group in
                    MissionSection("\(group.status.label) · \(group.tasks.count)") {
                        ForEach(Array(group.tasks.enumerated()), id: \.element.id) { index, task in
                            if index > 0 { MissionRowDivider() }
                            MissionTaskRow(task: task, mission: mission, siblings: group.tasks)
                        }
                    }
                }
            }
            .padding(24)
            .frame(maxWidth: 900, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
    }

    private func add() {
        let title = input.trimmed(input.text)
        guard !title.isEmpty, !input.busy else { return }
        input.busy = true
        let order = MissionTaskOrdering.nextOrder(after: detail.tasks)
        model.missionAction { [client, input, id = mission.id] in
            defer { input.busy = false }
            try await client.createMissionTask(id, MissionTaskWrite(title: title, order: order))
            input.text = ""
        }
    }
}

@MainActor
private final class TaskTitleState: ObservableObject {
    @Published var title: String
    init(_ title: String) { self.title = title }
}

struct MissionTaskRow: View {
    let task: MissionTask
    let mission: Mission
    /// The displayed list this row reorders within.
    let siblings: [MissionTask]
    @EnvironmentObject private var model: AppModel
    @ObservedObject private var client = AppModel.shared.client
    @StateObject private var title: TaskTitleState
    @StateObject private var resource = MissionInput()

    init(task: MissionTask, mission: Mission, siblings: [MissionTask]) {
        self.task = task
        self.mission = mission
        self.siblings = siblings
        _title = StateObject(wrappedValue: TaskTitleState(task.title))
    }

    var body: some View {
        let index = siblings.firstIndex { $0.id == task.id } ?? 0
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            MissionTaskStatusMenu(task: task, missionId: mission.id)
            Text("#\(task.number)").font(.caption.monospacedDigit()).foregroundStyle(Theme.faintForeground)
            VStack(alignment: .leading, spacing: 2) {
                TextField("Title", text: $title.title)
                    .textFieldStyle(.plain)
                    .onSubmit(saveTitle)
                MissionTaskDescription(task: task)
                ForEach(client.missionDetails[mission.id]?.resources.filter { $0.taskId == task.id } ?? []) { item in
                    ResourceRow(resource: item, missionId: mission.id, compact: true)
                }
                Button("Add link…") { resource.editingId = task.id }
                    .buttonStyle(.link).font(.caption)
                    .popover(isPresented: Binding(get: { resource.editingId != nil }, set: { if !$0 { resource.editingId = nil } })) {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Link to task #\(task.number)").font(.headline)
                            TextField("URL", text: $resource.text).textFieldStyle(.roundedBorder).onSubmit(addResource)
                            TextField("Title (optional)", text: $resource.secondary).textFieldStyle(.roundedBorder).onSubmit(addResource)
                            Button("Add", action: addResource).disabled(resource.busy || URL(string: resource.text)?.scheme == nil)
                        }.padding(14).frame(width: 340)
                    }
            }
            Spacer(minLength: 8)
            owner
            if task.sessionId == nil, !task.status.isClosed {
                Button("Start chat") { model.startChat(for: task, missionId: mission.id) }
                    .controlSize(.small)
                    .help("Start a new chat in this project that joins the mission and claims this task")
            }
            Button { move(-1) } label: { Image(systemName: "chevron.up") }
                .buttonStyle(.borderless).disabled(index == 0).help("Move up")
            Button { move(1) } label: { Image(systemName: "chevron.down") }
                .buttonStyle(.borderless).disabled(index == siblings.count - 1).help("Move down")
        }
        .font(.callout)
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .onChange(of: task.title) { _, value in title.title = value }
        .contextMenu {
            Button("Delete task", role: .destructive) {
                model.missionAction { [client, id = mission.id] in try await client.deleteMissionTask(id, taskId: task.id) }
            }
        }
    }

    private var owner: some View {
        let members = model.members(of: mission).filter { !$0.isArchived }
        return Menu {
            if let sessionId = task.sessionId {
                Button("Open chat") { model.selectedSessionId = sessionId }
                Button("Release") { assign(nil) }
                Divider()
            }
            ForEach(members) { session in
                Button(session.title) { assign(session.id) }.disabled(session.id == task.sessionId)
            }
            if members.isEmpty { Text("No mission chats") }
        } label: {
            Label(task.sessionId.map { MissionTaskOwnerLabel.text(task: task, chatTitle: client.session($0)?.title) }
                    ?? "Unassigned",
                  systemImage: task.sessionId == nil ? "person.crop.circle.dashed" : "bubble.left")
                .lineLimit(1)
                .font(.caption)
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .frame(maxWidth: 200, alignment: .trailing)
        .foregroundStyle(Theme.mutedForeground)
        .help(task.sessionId.map { "Assigned to “\(client.session($0)?.title ?? "a chat")”. Click to reassign." }
              ?? "Assign this task to a mission chat")
    }

    private func addResource() {
        let url = resource.trimmed(resource.text)
        guard !resource.busy, URL(string: url)?.scheme != nil else { return }
        let value = resource.trimmed(resource.secondary)
        resource.busy = true
        model.missionAction { [client, resource, id = mission.id, taskId = task.id] in
            defer { resource.busy = false }
            try await client.addMissionResource(id, MissionResourceWrite(url: url, title: value.isEmpty ? nil : value, taskId: taskId))
            resource.text = ""
            resource.secondary = ""
            resource.editingId = nil
        }
    }

    private func saveTitle() {
        let value = title.title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, value != task.title else { title.title = task.title; return }
        model.missionAction { [client, id = mission.id] in
            try await client.updateMissionTask(id, taskId: task.id, MissionTaskWrite(title: value))
        }
    }

    private func assign(_ sessionId: String?) {
        model.missionAction { [client, id = mission.id] in
            try await client.updateMissionTask(id, taskId: task.id,
                                               MissionTaskWrite(sessionId: sessionId.map { .set($0) } ?? .clear))
        }
    }

    private func move(_ offset: Int) {
        let updates = MissionTaskOrdering.move(task.id, by: offset, in: siblings)
        model.missionAction { [client, id = mission.id] in
            for update in updates {
                try await client.updateMissionTask(id, taskId: update.taskId, MissionTaskWrite(order: update.order))
            }
        }
    }
}

struct MissionTaskStatusMenu: View {
    let task: MissionTask
    let missionId: String
    @EnvironmentObject private var model: AppModel

    var body: some View {
        Menu {
            ForEach(MissionTaskStatus.allCases, id: \.self) { status in
                Button { set(status) } label: { Label(status.label, systemImage: status.symbol) }
                    .disabled(status == task.status)
            }
        } label: {
            Image(systemName: task.status.symbol)
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .foregroundStyle(task.status.color)
        .help("Status: \(task.status.label)")
        .accessibilityLabel("Status \(task.status.label)")
    }

    private func set(_ status: MissionTaskStatus) {
        model.missionAction { [client = model.client] in
            try await client.updateMissionTask(missionId, taskId: task.id, MissionTaskWrite(status: status))
        }
    }
}

// MARK: Chats

enum MissionChatFilter: String, CaseIterable {
    case active = "Active"
    case archived = "Archived"
    case all = "All"
}

@MainActor
private final class MissionChatsState: ObservableObject {
    @Published var filter: MissionChatFilter = .active
}

struct MissionChatsTab: View {
    let mission: Mission
    let detail: MissionDetail
    @EnvironmentObject private var model: AppModel
    @ObservedObject private var client = AppModel.shared.client
    @StateObject private var state = MissionChatsState()

    var body: some View {
        let members = model.members(of: mission).filter { session in
            switch state.filter {
            case .active: !session.isArchived
            case .archived: session.isArchived
            case .all: true
            }
        }
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack {
                    Picker("", selection: $state.filter) {
                        ForEach(MissionChatFilter.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                    }
                    .pickerStyle(.segmented).labelsHidden().fixedSize()
                    Spacer()
                    Button { model.newSession(in: mission) } label: {
                        Label("New chat", systemImage: "plus")
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(mission.status != .active)
                    .help("Open a new chat in this mission, with no task attached")
                    Menu {
                        Menu("Add existing chat…") { MissionExistingChatItems(mission: mission) }
                    } label: {
                        Image(systemName: "ellipsis")
                    }
                    .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
                    .help("More chat actions")
                }
                VStack(alignment: .leading, spacing: 0) {
                    if members.isEmpty {
                        Text(state.filter == .archived ? "No archived chats" : "No chats in this mission yet")
                            .font(.callout).foregroundStyle(Theme.faintForeground).padding(12)
                    }
                    ForEach(Array(members.enumerated()), id: \.element.id) { index, session in
                        if index > 0 { MissionRowDivider() }
                        MissionChatRow(session: session, mission: mission,
                                       tasks: detail.tasks.filter { $0.sessionId == session.id })
                    }
                }
                .card()
            }
            .padding(24)
            .frame(maxWidth: 900, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
    }
}

private struct MissionChatRow: View {
    let session: SessionSummary
    let mission: Mission
    let tasks: [MissionTask]
    @EnvironmentObject private var model: AppModel

    var body: some View {
        let coordinator = mission.coordinatorSessionId == session.id
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            SessionStatusIcon(status: session.status)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(session.title).lineLimit(1)
                    if model.isUnread(session) { UnreadBadge() }
                    if coordinator {
                        MissionCoordinatorIndicator(showsLabel: true)
                    }
                    if session.isArchived {
                        Text("Archived").font(.caption2).foregroundStyle(Theme.faintForeground)
                    }
                }
                if !tasks.isEmpty {
                    Text(tasks.map { "#\($0.number) \($0.title)" }.joined(separator: ", "))
                        .font(.caption).foregroundStyle(Theme.mutedForeground).lineLimit(1)
                }
            }
            Spacer(minLength: 8)
            Text(SessionTimeFormatting.relative(session.listActivityAt))
                .font(.caption).monospacedDigit().foregroundStyle(Theme.faintForeground)
            Button("Open") { model.selectedSessionId = session.id }.controlSize(.small)
            Menu {
                if coordinator {
                    Button("Coordinate it yourself") { model.setCoordinator(nil, missionId: mission.id) }
                } else {
                    Button("Make coordinator") { model.setCoordinator(session.id, missionId: mission.id) }
                }
                Divider()
                Button("Remove from mission", role: .destructive) { model.removeFromMission(session.id) }
            } label: {
                Image(systemName: "ellipsis")
            }
            .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
            .help("Chat actions")
        }
        .font(.callout)
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .contextMenu {
            Button("Open") { model.selectedSessionId = session.id }
            if !coordinator { Button("Make coordinator") { model.setCoordinator(session.id, missionId: mission.id) } }
            Button("Remove from mission") { model.removeFromMission(session.id) }
        }
    }
}

// MARK: Artifacts

@MainActor
private final class MissionArtifactsState: ObservableObject {
    @Published var selected: MissionArtifactSelection?
}

private struct MissionArtifactSelection: Identifiable {
    let reference: ArtifactReference
    let latest: Bool
    var id: String { "\(reference.sessionId)/\(reference.id)/\(latest ? "latest" : String(reference.revision))" }
}

struct MissionArtifactsTab: View {
    let mission: Mission
    let detail: MissionDetail
    @EnvironmentObject private var model: AppModel
    @ObservedObject private var client = AppModel.shared.client
    @StateObject private var state = MissionArtifactsState()

    var body: some View {
        let members = model.members(of: mission).filter { !$0.isArchived }
        let linked = Set(detail.artifacts.map(\.artifactId))
        let linkable = members.flatMap { client.artifacts[$0.id] ?? [] }.filter { !linked.contains($0.id) }
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack {
                    Text("Artifacts stay owned by their chat. Linking makes them part of the mission.")
                        .font(.caption).foregroundStyle(Theme.mutedForeground)
                    Spacer()
                    Menu {
                        ForEach(linkable) { artifact in
                            Button("\(artifact.title) · \(client.session(artifact.sessionId)?.title ?? "chat")") {
                                model.missionAction { [client, id = mission.id] in
                                    try await client.linkMissionArtifact(id, MissionArtifactLinkWrite(
                                        sessionId: artifact.sessionId, artifactId: artifact.id))
                                }
                            }
                        }
                        if linkable.isEmpty { Text("No unlinked artifacts in mission chats") }
                    } label: {
                        Label("Link artifact", systemImage: "link")
                    }
                    .fixedSize()
                }
                VStack(alignment: .leading, spacing: 0) {
                    if detail.artifacts.isEmpty {
                        Text("No linked artifacts yet").font(.callout).foregroundStyle(Theme.faintForeground).padding(12)
                    }
                    ForEach(Array(detail.artifacts.enumerated()), id: \.element.id) { index, link in
                        if index > 0 { MissionRowDivider() }
                        HStack(spacing: 10) {
                            Button {
                                state.selected = MissionArtifactSelection(
                                    reference: ArtifactReference(id: link.artifactId, sessionId: link.sessionId,
                                                                 title: link.title, revision: link.revision ?? 0),
                                    latest: link.revision == nil)
                            } label: {
                                HStack(spacing: 10) {
                                    Image(systemName: link.kind == "image" ? "photo" : "cube.transparent")
                                        .foregroundStyle(Theme.mutedForeground)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(link.title).lineLimit(1)
                                        Text(client.session(link.sessionId)?.title ?? "Chat")
                                            .font(.caption).foregroundStyle(Theme.mutedForeground).lineLimit(1)
                                    }
                                    Spacer()
                                    Text("\(link.kind.uppercased()) · \(link.revision.map { "r\($0)" } ?? "latest")")
                                        .font(.caption.monospaced()).foregroundStyle(Theme.mutedForeground)
                                }
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .help("Open \(link.title)")
                            Button {
                                model.missionAction { [client, id = mission.id] in
                                    try await client.unlinkMissionArtifact(id, artifactId: link.artifactId)
                                }
                            } label: { Image(systemName: "xmark") }
                                .buttonStyle(.borderless).help("Unlink from mission")
                        }
                        .font(.callout)
                        .padding(12)
                    }
                }
                .card()
            }
            .padding(24)
            .frame(maxWidth: 900, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .task(id: mission.id) {
            for member in members where client.artifacts[member.id] == nil {
                _ = try? await client.sessionArtifacts(member.id)
            }
        }
        .sheet(item: $state.selected) { selection in
            ArtifactViewer(reference: selection.reference, latest: selection.latest)
        }
    }
}

// MARK: Activity

@MainActor
private final class MissionActivityState: ObservableObject {
    @Published var older: [MissionEvent] = []
    @Published var exhausted = false
    @Published var loading = false
    @Published var kind: MissionEventWriteKind = .update
    @Published var health: MissionHealth?
}

struct MissionActivityTab: View {
    let mission: Mission
    let detail: MissionDetail
    @EnvironmentObject private var model: AppModel
    @ObservedObject private var client = AppModel.shared.client
    @StateObject private var input = MissionInput()
    @StateObject private var state = MissionActivityState()

    var body: some View {
        let recentIds = Set(detail.events.map(\.id))
        let events = detail.events + state.older.filter { !recentIds.contains($0.id) }
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                VStack(alignment: .leading, spacing: 8) {
                    TextField("Post an update or handoff", text: $input.text, axis: .vertical)
                        .textFieldStyle(.roundedBorder).lineLimit(2 ... 6)
                    HStack(spacing: 10) {
                        Picker("", selection: $state.kind) {
                            Text("Update").tag(MissionEventWriteKind.update)
                            Text("Handoff").tag(MissionEventWriteKind.handoff)
                        }
                        .pickerStyle(.segmented).labelsHidden().fixedSize()
                        Picker("Health", selection: $state.health) {
                            Text("No health").tag(MissionHealth?.none)
                            ForEach([MissionHealth.onTrack, .atRisk, .offTrack], id: \.self) {
                                Text($0.label).tag(Optional($0))
                            }
                        }
                        .fixedSize()
                        Spacer()
                        Button("Post", action: post).disabled(input.busy || input.trimmed(input.text).isEmpty)
                    }
                }
                .padding(12)
                .card()
                VStack(alignment: .leading, spacing: 0) {
                    if events.isEmpty {
                        Text("No activity yet").font(.callout).foregroundStyle(Theme.faintForeground).padding(12)
                    }
                    ForEach(Array(events.enumerated()), id: \.element.id) { index, event in
                        if index > 0 { MissionRowDivider() }
                        MissionEventRow(event: event)
                    }
                }
                .card()
                if !events.isEmpty, !state.exhausted {
                    Button(state.loading ? "Loading…" : "Load older activity") { loadOlder(before: events.last?.id) }
                        .disabled(state.loading)
                }
            }
            .padding(24)
            .frame(maxWidth: 900, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
    }

    private func post() {
        let text = input.trimmed(input.text)
        guard !text.isEmpty, !input.busy else { return }
        input.busy = true
        let write = MissionEventWrite(text: text, kind: state.kind, health: state.health)
        model.missionAction { [client, input, id = mission.id] in
            defer { input.busy = false }
            try await client.postMissionEvent(id, write)
            input.text = ""
        }
    }

    private func loadOlder(before: Int?) {
        guard let before else { return }
        state.loading = true
        model.missionAction { [client, state, id = mission.id] in
            defer { state.loading = false }
            let page = try await client.missionEvents(id, before: before)
            if page.isEmpty { state.exhausted = true }
            state.older += page
        }
    }
}
