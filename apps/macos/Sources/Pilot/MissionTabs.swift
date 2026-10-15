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
    /// The brief reads as rendered Markdown until the user chooses Edit.
    @Published var editing = false
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

    /// Leaves edit mode without saving.
    func discard(latest: MissionBrief?) {
        text = loadedText
        editing = false
        conflict = nil
        error = nil
        sync(latest)
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
            editing = false
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
        guard let loaded = try? await client.missionBriefRevisions(missionId) else { return }
        revisions = loaded.sorted { $0.revision > $1.revision }
        Self.revisionCache[missionId] = revisions
    }

    /// Revision lists by mission, so reopening the tab does not refetch an unchanged history.
    private static var revisionCache: [String: [MissionBriefRevision]] = [:]

    /// Shows the cached history and fetches it only when it is missing or older than `latest`.
    func loadRevisionsIfNeeded(missionId: String, latest: Int, client: PilotClient) async {
        if let cached = Self.revisionCache[missionId], (cached.first?.revision ?? 0) >= latest {
            if revisions != cached { revisions = cached }
            return
        }
        await loadRevisions(missionId: missionId, client: client)
    }

    func view(_ revision: Int, missionId: String, client: PilotClient) async {
        do { viewing = try await client.missionBrief(missionId, revision: revision) }
        catch { self.error = error.localizedDescription }
    }
}

/// Decisions first (they override the brief), then the brief itself, read-first, then comments.
struct MissionBriefTab: View {
    let mission: Mission
    let detail: MissionDetail
    @EnvironmentObject private var model: AppModel
    @ObservedObject private var client = AppModel.shared.client
    @ObservedObject var editor: BriefEditorState
    @State private var decision = MissionInput()
    @State private var newDecisionAudience: MissionDecisionAudience = .reference
    @State private var editingDecisionAudience: MissionDecisionAudience = .reference
    @State private var comment = MissionInput()

    var body: some View {
        VStack(alignment: .leading, spacing: 28) {
            decisions
            briefSection
            comments
        }
        .onAppear { editor.sync(detail.brief) }
        .onChange(of: detail.brief?.revision) { _, _ in editor.sync(detail.brief) }
        .task(id: mission.briefRevision) {
            // History only fills the revision menu: fetch it after the tab is on screen, once per revision.
            try? await Task.sleep(for: .milliseconds(500))
            guard !Task.isCancelled else { return }
            await editor.loadRevisionsIfNeeded(missionId: mission.id, latest: mission.briefRevision, client: client)
        }
        .sheet(item: Binding(get: { editor.viewing.map(BriefRevisionItem.init) }, set: { if $0 == nil { editor.viewing = nil } })) { item in
            BriefRevisionViewer(brief: item.brief, editor: editor)
        }
    }

    // MARK: Decisions

    private var decisions: some View {
        VStack(alignment: .leading, spacing: 4) {
            PageSectionHeader(title: "Decisions", count: detail.decisions.count)
            Text("Binding. They override the brief.")
                .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                .padding(.bottom, 4)
            ForEach(detail.decisions) { item in
                decisionRow(item)
            }
            if decision.confirming {
                VStack(alignment: .leading, spacing: 8) {
                    TextField("Record a decision", text: $decision.text)
                        .textFieldStyle(.roundedBorder)
                        .onSubmit(addDecision)
                        .onExitCommand { decision.confirming = false }
                    HStack(spacing: 8) {
                        DecisionAudiencePicker(selection: $newDecisionAudience)
                        Spacer(minLength: 8)
                        Button("Cancel") { decision.confirming = false; decision.text = "" }
                        Button("Add", action: addDecision)
                            .disabled(decision.trimmed(decision.text).isEmpty)
                    }
                }
                .disabled(decision.busy)
                .padding(.leading, 8)
                .padding(.top, 4)
            } else {
                QuietAddButton(title: "Record a decision") {
                    newDecisionAudience = .reference
                    decision.confirming = true
                }
                    .padding(.leading, 8)
                    .padding(.top, 2)
            }
        }
    }

    private func decisionRow(_ item: MissionDecision) -> some View {
        HoverRow(verticalPadding: 5) { hovered in
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text("D\(item.number)").font(.pilot(.caption)).foregroundStyle(Theme.faintForeground)
                    .monospacedDigit().frame(minWidth: 26, alignment: .leading)
                if decision.editingId == item.id {
                    VStack(alignment: .leading, spacing: 8) {
                        TextField("Decision", text: $decision.secondary, axis: .vertical)
                            .textFieldStyle(.roundedBorder)
                            .onSubmit { saveDecision(item) }
                            .onExitCommand { decision.editingId = nil }
                        HStack(spacing: 8) {
                            DecisionAudiencePicker(selection: $editingDecisionAudience)
                            Spacer(minLength: 8)
                            Button("Cancel") { decision.editingId = nil }
                            Button("Save") { saveDecision(item) }
                                .disabled(decision.trimmed(decision.secondary).isEmpty)
                        }
                    }
                    .disabled(decision.busy)
                } else {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(item.text).font(.pilot(.body)).foregroundStyle(Theme.foreground)
                            .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                        DecisionAudienceTag(audience: item.audience)
                        if let proposal = detail.decisionProposals?.first(where: { $0.decisionId == item.id && $0.status == "pending" }) {
                            DecisionProposalView(proposal: proposal, oldText: item.text) { accept, text in
                                _ = try await client.resolveMissionDecisionProposal(mission.id, proposalId: proposal.id, accept: accept, text: text)
                            }
                            .id(proposal.id)
                        }
                    }
                    Spacer(minLength: 8)
                    ZStack(alignment: .trailing) {
                        Text(missionAuthorName(item.authorSessionId, client: client))
                            .font(.pilot(.caption)).foregroundStyle(Theme.faintForeground).lineLimit(1)
                            .opacity(hovered ? 0 : 1)
                        // Built only on hover, in a fixed slot so the row does not reflow; the context
                        // menu has the same actions.
                        if hovered {
                            HStack(spacing: 2) {
                                Button { editDecision(item) } label: { PilotSymbol(PilotIcon.edit, context: .toolbar) }
                                    .rowIconButtonStyle()
                                    .help("Edit decision").accessibilityLabel("Edit decision")
                                Button { removeDecision(item) } label: { PilotSymbol(PilotIcon.delete, context: .toolbar) }
                                    .rowIconButtonStyle(hoverTint: Theme.destructive)
                                    .help("Remove decision").accessibilityLabel("Remove decision")
                            }
                        } else {
                            Color.clear.frame(width: 42, height: 20)
                        }
                    }
                }
            }
        }
        .contextMenu {
            Button("Edit Decision") { editDecision(item) }
            Menu("Change Audience") {
                DecisionAudienceOptions(selection: Binding(
                    get: { item.audience },
                    set: { changeAudience(item, to: $0) }
                ))
            }
            Button("Remove Decision", role: .destructive) { removeDecision(item) }
        }
        .disabled(decision.busy)
    }

    // MARK: Brief

    private var briefSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Text("Brief").font(.pilot(.body, weight: .semibold)).foregroundStyle(Theme.foreground)
                    .accessibilityAddTraits(.isHeader)
                revisionMenu
                Spacer(minLength: 8)
                if editor.editing {
                    Button("Cancel") { editor.discard(latest: detail.brief) }
                        .keyboardShortcut(.cancelAction)
                    Button(editor.saving ? "Saving…" : "Save") {
                        Task { await editor.save(missionId: mission.id, client: client) }
                    }
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut("s", modifiers: .command)
                    .disabled(!editor.dirty || editor.saving)
                } else if !editor.text.isEmpty {
                    Button { editor.editing = true } label: { Label("Edit", icon: PilotIcon.edit) }
                        .help("Edit the brief. Saving creates a new revision.")
                }
            }
            HairlineDivider()
            notices
            if editor.editing {
                TextEditor(text: $editor.text)
                    .font(.system(size: 13, design: .monospaced))
                    .scrollContentBackground(.hidden)
                    .padding(10)
                    .frame(minHeight: 420)
                    .card(radius: Theme.Radius.control)
                    .accessibilityLabel("Brief Markdown")
            } else if editor.text.isEmpty {
                EmptyStateView(icon: PilotIcon.document, title: "No brief yet",
                               message: "The brief is the shared spec every mission chat reads.") {
                    Button { editor.editing = true } label: { Label("Write the Brief", icon: PilotIcon.edit) }
                        .buttonStyle(.borderedProminent)
                }
            } else {
                MarkdownView(text: editor.text, lazy: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, 4)
            }
        }
    }

    @ViewBuilder private var notices: some View {
        if let conflict = editor.conflict {
            VStack(alignment: .leading, spacing: 6) {
                InlineProblem("Revision \(conflict) was saved while you were editing, so your changes were not saved. "
                    + "Copy your text, reload the latest brief and reapply your edits.")
                HStack {
                    Button("Copy My Text") {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(editor.text, forType: .string)
                    }
                    Button("Reload Latest") { Task { await editor.reload(missionId: mission.id, client: client) } }
                }
                .controlSize(.small)
                .padding(.leading, 18)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        } else if editor.dirty, let latest = detail.brief?.revision, latest > editor.baseRevision {
            Text("Revision \(latest) arrived while you were editing. Saving will be rejected until you reload.")
                .font(.pilot(.caption)).foregroundStyle(Theme.warning)
        }
        if let error = editor.error {
            InlineProblem(error)
        }
    }

    private var revisionMenu: some View {
        Menu {
            ForEach(editor.revisions, id: \.revision) { revision in
                Button("Revision \(revision.revision) · \(missionAuthorName(revision.authorSessionId, client: client)) · \(missionRelativeTime(revision.createdAt))") {
                    Task { await editor.view(revision.revision, missionId: mission.id, client: client) }
                }
            }
            if editor.revisions.isEmpty { Text("No revisions yet") }
        } label: {
            ChipLabel(title: editor.baseRevision == 0 ? "No revisions" : "Revision \(editor.baseRevision)",
                      icon: PilotIcon.queued)
        }
        .chipMenuStyle()
        .fixedSize()
        .onHover { inside in
            guard inside else { return }
            Task { await editor.loadRevisionsIfNeeded(missionId: mission.id, latest: mission.briefRevision, client: client) }
        }
        .help("Revision history")
        .accessibilityLabel(editor.baseRevision == 0 ? "No revisions" : "Revision \(editor.baseRevision), history")
    }

    // MARK: Comments

    private var comments: some View {
        let open = detail.comments.filter(\.isOpen)
        let resolved = detail.comments.filter { !$0.isOpen }
        let members = model.members(of: mission).filter { !$0.isArchived }
        let recipient = comment.option.flatMap { id in members.first { $0.id == id }?.title }
            ?? (mission.coordinatorSessionId == nil ? "Anyone" : "Coordinator")
        return VStack(alignment: .leading, spacing: 8) {
            PageSectionHeader(title: "Comments", count: open.count)
            ForEach(open + resolved) { item in
                CommentRow(comment: item, missionId: mission.id)
            }
            ComposerTray {
                VStack(alignment: .leading, spacing: 6) {
                    if comment.confirming {
                        TextField("Quote from the brief", text: $comment.secondary)
                            .font(.pilot(.caption)).italic()
                            .padding(.leading, 8)
                            .overlay(alignment: .leading) { Rectangle().fill(Theme.border).frame(width: 2) }
                    }
                    TextField("Comment on the brief…", text: $comment.text, axis: .vertical)
                        .lineLimit(1 ... 5)
                        .onSubmit(addComment)
                        .accessibilityLabel("Comment")
                }
            } controls: {
                Button { comment.confirming.toggle() } label: { PilotSymbol(PilotIcon.quote) }
                    .buttonStyle(QuietIconButtonStyle())
                    .help(comment.confirming ? "Remove the quote" : "Quote a passage of the brief")
                    .accessibilityLabel(comment.confirming ? "Remove quote" : "Add quote")
                Menu {
                    Button(mission.coordinatorSessionId == nil ? "Anyone" : "Coordinator") { comment.option = nil }
                    if !members.isEmpty { Divider() }
                    ForEach(members) { session in Button(session.title) { comment.option = session.id } }
                } label: {
                    ChipLabel(title: "To \(recipient)", icon: PilotIcon.recipient, maxTitleWidth: 200)
                }
                .chipMenuStyle()
                .fixedSize()
                .help("Who should read this comment")
                Spacer()
                Button(action: addComment) { PilotSymbol(PilotIcon.send, context: .toolbar) }
                    .buttonStyle(CircleIconButtonStyle())
                    .disabled(comment.busy || comment.trimmed(comment.text).isEmpty)
                    .help("Post comment")
                    .accessibilityLabel("Post comment")
            }
        }
    }

    // MARK: Actions

    private func addDecision() {
        let text = decision.trimmed(decision.text)
        guard !text.isEmpty, !decision.busy else { return }
        let audience = newDecisionAudience
        decision.busy = true
        model.missionAction { [client, id = mission.id] in
            defer { decision.busy = false }
            try await client.addMissionDecision(id, text: text, audience: audience)
            decision.text = ""
            decision.confirming = false
        }
    }

    private func editDecision(_ item: MissionDecision) {
        decision.secondary = item.text
        editingDecisionAudience = item.audience
        decision.editingId = item.id
    }

    private func removeDecision(_ item: MissionDecision) {
        model.missionAction { [client, id = mission.id] in
            try await client.deleteMissionDecision(id, decisionId: item.id)
        }
    }

    private func saveDecision(_ item: MissionDecision) {
        let text = decision.trimmed(decision.secondary)
        guard !text.isEmpty, !decision.busy else { return }
        let audience = editingDecisionAudience
        decision.busy = true
        model.missionAction { [client, id = mission.id] in
            defer { decision.busy = false }
            try await client.updateMissionDecision(id, decisionId: item.id, text: text, audience: audience)
            decision.editingId = nil
        }
    }

    private func changeAudience(_ item: MissionDecision, to audience: MissionDecisionAudience) {
        guard audience != item.audience, !decision.busy else { return }
        decision.busy = true
        model.missionAction { [client, id = mission.id] in
            defer { decision.busy = false }
            // Do not resend text: it may have changed since this row was rendered.
            try await client.updateMissionDecision(id, decisionId: item.id, audience: audience)
            if decision.editingId == item.id { editingDecisionAudience = audience }
        }
    }

    private func addComment() {
        let text = comment.trimmed(comment.text)
        guard !text.isEmpty, !comment.busy else { return }
        let anchor = comment.confirming ? comment.trimmed(comment.secondary) : ""
        let target = comment.option
        comment.busy = true
        model.missionAction { [client, id = mission.id] in
            defer { comment.busy = false }
            try await client.addMissionComment(id, MissionCommentWrite(text: text, anchor: anchor.isEmpty ? nil : anchor,
                                                                       targetSessionId: target))
            comment.text = ""
            comment.secondary = ""
            comment.confirming = false
        }
    }
}

/// "+ Title" in muted text, for adding an item at the end of a list.
struct QuietAddButton: View {
    let title: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 4) {
                PilotSymbol(PilotIcon.add)
                Text(title)
            }
            .font(.pilot(.label))
            .foregroundStyle(Theme.mutedForeground)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
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
        SheetScaffold("Revision \(brief.revision)",
                      subtitle: "\(missionAuthorName(brief.authorSessionId, client: client)) · \(missionRelativeTime(brief.createdAt)) ago",
                      width: nil, fillsHeight: true, content: {
            ScrollView {
                MarkdownView(text: brief.markdown).frame(maxWidth: .infinity, alignment: .leading)
            }
        }, footerLeading: {
            Button("Copy into Editor") {
                editor.text = brief.markdown
                editor.editing = true
                dismiss()
            }
            .help("Replace the editor text with this revision. Saving creates a new revision.")
        })
        .frame(minWidth: 640, minHeight: 520)
    }
}

private struct CommentRow: View {
    let comment: MissionComment
    let missionId: String
    @EnvironmentObject private var model: AppModel
    @ObservedObject private var client = AppModel.shared.client

    var body: some View {
        HoverRow(verticalPadding: 7) { hovered in
            HStack(alignment: .top, spacing: 10) {
                PilotSymbol(comment.isOpen ? PilotIcon.update : PilotIcon.resolvedComment, context: .row)
                    .foregroundStyle(comment.isOpen ? Theme.mutedForeground : Theme.faintForeground).frame(width: 16)
                VStack(alignment: .leading, spacing: 4) {
                    if let anchor = comment.anchor, !anchor.isEmpty {
                        Text(anchor)
                            .font(.pilot(.caption)).italic().foregroundStyle(Theme.mutedForeground).lineLimit(3)
                            .padding(.leading, 8)
                            .overlay(alignment: .leading) { Rectangle().fill(Theme.border).frame(width: 2) }
                    }
                    Text(comment.text).font(.pilot(.body)).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                        .foregroundStyle(comment.isOpen ? Theme.foreground : Theme.mutedForeground)
                    Text(byline).font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                }
                Spacer(minLength: 8)
                HStack(spacing: 4) {
                    if comment.isOpen {
                        Button("Resolve", action: resolve).controlSize(.small)
                    }
                    Button(action: delete) { PilotSymbol(PilotIcon.delete, context: .toolbar) }
                        .rowIconButtonStyle(hoverTint: Theme.destructive)
                        .help("Delete comment").accessibilityLabel("Delete comment")
                }
                .revealed(hovered)
            }
        }
        .contextMenu {
            if comment.isOpen { Button("Resolve", action: resolve) }
            Button("Delete Comment", role: .destructive, action: delete)
        }
    }

    private func resolve() {
        model.missionAction { [client] in try await client.resolveMissionComment(missionId, commentId: comment.id) }
    }

    private func delete() {
        model.missionAction { [client] in try await client.deleteMissionComment(missionId, commentId: comment.id) }
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
    /// The page's scroll view, for "Show task".
    let scroll: ScrollViewProxy
    @EnvironmentObject private var model: AppModel
    @ObservedObject private var client = AppModel.shared.client
    @State private var input = MissionInput()
    /// Finished phases start folded; the user's choices hold across refreshes.
    @State private var folds = MissionPhaseFolds()
    /// Dropped tasks stay hidden behind one quiet toggle for the whole list.
    @State private var showDropped = false
    /// The task "Show task" just revealed, shown with a soft fill for a moment.
    @State private var highlighted: String?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let phases = MissionTaskPhases(detail.tasks, showDropped: showDropped)
        let counts = MissionTaskCounts(detail.tasks)
        // One id lookup, one dependents index, one link index and one member list per update, shared by
        // every row. The list is lazy: only rows on screen are created, so switching here stays fast.
        let dependencies = MissionTaskDependencyIndex(tasks: detail.tasks)
        let links = MissionTaskLinkIndex(detail)
        let members = model.members(of: mission).filter { !$0.isArchived }
        LazyVStack(alignment: .leading, spacing: 0) {
            if counts.total > 0 || phases.dropped > 0 {
                HStack(alignment: .top, spacing: 12) {
                    if counts.total > 0 {
                        MissionTaskProgress(counts: counts, barWidth: 360)
                    }
                    Spacer(minLength: 0)
                    if phases.dropped > 0 { droppedToggle(phases.dropped) }
                }
                .padding(.bottom, 12)
            }
            addField
            if detail.tasks.isEmpty {
                EmptyStateView(icon: PilotIcon.tasks, title: "No tasks yet",
                               message: "Add the first task above, or ask a mission chat to plan them.")
            } else if counts.total > 0, counts.done == counts.total, mission.status == .active {
                HStack(spacing: 8) {
                    PilotSymbol(PilotIcon.complete).foregroundStyle(Theme.success)
                    Text("Every task is done.").foregroundStyle(Theme.mutedForeground)
                    Button("Mark Mission as Done") {
                        model.missionAction { [client, id = mission.id] in
                            try await client.updateMission(id, UpdateMissionRequest(status: .done))
                        }
                    }
                    .controlSize(.small)
                }
                .font(.pilot(.body))
                .padding(.top, 16)
            }
            if phases.isFlat, !phases.groups.isEmpty { Color.clear.frame(height: 12) }
            ForEach(MissionTaskListItem.items(phases, folds: folds)) { item in
                switch item {
                case let .header(group, folded):
                    phaseHeader(group, folded: folded)
                case let .task(task, index, siblings):
                    VStack(alignment: .leading, spacing: 0) {
                        if index > 0 { HairlineDivider(leading: 58) }
                        MissionTaskRow(task: task, mission: mission, siblings: siblings,
                                       highlighted: highlighted == task.id,
                                       dependencies: dependencies.dependencies(of: task),
                                       resources: links.resources(of: task.id),
                                       artifactLinks: links.artifacts(of: task.id),
                                       members: members,
                                       onShowTask: { show($0, scroll) })
                    }
                }
            }
        }
        .onAppear { reveal(scroll) }
        .onChange(of: model.revealedMissionTaskId) { _, _ in reveal(scroll) }
    }

    /// Unfolds the phase of the task named by "Show task", scrolls to it and highlights it briefly.
    private func reveal(_ proxy: ScrollViewProxy) {
        guard let id = model.revealedMissionTaskId else { return }
        model.revealedMissionTaskId = nil
        show(id, proxy)
    }

    private func show(_ id: String, _ proxy: ScrollViewProxy) {
        guard let task = detail.tasks.first(where: { $0.id == id }) else { return }
        folds.unfold(MissionPhaseGroup.id(of: task))
        if task.status == .dropped { showDropped = true }
        highlighted = id
        Task { @MainActor in
            // Let the unfolded phase lay out before scrolling.
            try? await Task.sleep(for: .milliseconds(60))
            if reduceMotion {
                proxy.scrollTo(id, anchor: .center)
            } else {
                withAnimation(Theme.Motion.quick) { proxy.scrollTo(id, anchor: .center) }
            }
            try? await Task.sleep(for: .milliseconds(1_800))
            if highlighted == id { highlighted = nil }
        }
    }

    private var addField: some View {
        HStack(spacing: 8) {
            PilotSymbol(PilotIcon.add, context: .row).foregroundStyle(Theme.mutedForeground).frame(width: 16)
            TextField("Add a task", text: $input.text)
                .textFieldStyle(.plain)
                .font(.pilot(.body))
                .onSubmit(add)
                .disabled(input.busy)
                .accessibilityLabel("New task title")
            if !input.trimmed(input.text).isEmpty { KeyHint(key: "↩", label: "add") }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 8)
        .background(RoundedRectangle(cornerRadius: Theme.Radius.control).strokeBorder(Theme.border))
    }

    /// "Show dropped (3)": dropped tasks then appear last in their phases.
    private func droppedToggle(_ count: Int) -> some View {
        Button(showDropped ? "Hide dropped" : "Show dropped (\(count))") { showDropped.toggle() }
            .buttonStyle(.plain)
            .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
            .accessibilityHint("Tasks that were retired without being done")
    }

    /// "Phase 1 polish · 12/18 done", folding like a disclosure.
    private func phaseHeader(_ group: MissionPhaseGroup, folded: Bool) -> some View {
        Button {
            folds.toggle(group)
        } label: {
            HStack(spacing: 6) {
                DisclosureChevron(expanded: !folded).frame(width: 12)
                Text(group.title).font(.pilot(.label, weight: .semibold)).foregroundStyle(Theme.foreground)
                    .lineLimit(1)
                Text("·").font(.pilot(.label)).foregroundStyle(Theme.faintForeground)
                Text(group.progress).font(.pilot(.label)).monospacedDigit().foregroundStyle(Theme.faintForeground)
                    .fixedSize()
                Spacer()
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.top, 20)
        .padding(.bottom, 4)
        .accessibilityLabel("\(group.title), \(group.progress)")
        .accessibilityValue(folded ? "Collapsed" : "Expanded")
        .accessibilityAddTraits(.isHeader)
    }

    private func add() {
        let title = input.trimmed(input.text)
        guard !title.isEmpty, !input.busy else { return }
        input.busy = true
        let order = MissionTaskOrdering.nextOrder(after: detail.tasks)
        model.missionAction { [client, id = mission.id] in
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

/// One task: status, number, editable title, description and links. Start chat and the actions menu
/// appear on hover; the context menu has every action.
struct MissionTaskRow: View {
    let task: MissionTask
    let mission: Mission
    /// The displayed list this row reorders within.
    let siblings: [MissionTask]
    var highlighted = false
    /// Precomputed by the tab; rows never search the task list.
    var dependencies = MissionTaskDependencies.none
    /// The task's links and artifacts, and the mission's active chats, precomputed by the tab.
    var resources: [MissionResource] = []
    var artifactLinks: [MissionArtifactLink] = []
    var members: [SessionSummary] = []
    /// Scrolls to a task and highlights it.
    var onShowTask: (String) -> Void = { _ in }
    @EnvironmentObject private var model: AppModel
    @ObservedObject private var client = AppModel.shared.client
    @StateObject private var title: TaskTitleState
    @State private var addingLink = false
    @State private var choosingModel = false
    @StateObject private var artifacts = MissionArtifactsState()
    /// Rows built, so the tab-switch check can confirm the list stays lazy.
    static var bodyEvaluations = 0

    init(task: MissionTask, mission: Mission, siblings: [MissionTask], highlighted: Bool = false,
         dependencies: MissionTaskDependencies = .none, resources: [MissionResource] = [],
         artifactLinks: [MissionArtifactLink] = [], members: [SessionSummary] = [],
         onShowTask: @escaping (String) -> Void = { _ in }) {
        self.task = task
        self.mission = mission
        self.siblings = siblings
        self.highlighted = highlighted
        self.dependencies = dependencies
        self.resources = resources
        self.artifactLinks = artifactLinks
        self.members = members
        self.onShowTask = onShowTask
        _title = StateObject(wrappedValue: TaskTitleState(task.title))
    }

    var body: some View {
        let _ = Self.bodyEvaluations &+= 1
        HoverRow(verticalPadding: 7) { hovered in
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                // Menus are AppKit pop-up buttons and costly to create, so rows build them only on hover.
                // The context menu offers the same actions without hovering.
                MissionTaskStatusMenu(task: task, missionId: mission.id, subdued: dependencies.isWaiting, interactive: hovered)
                Text("#\(task.number)").font(.pilot(.caption)).monospacedDigit().foregroundStyle(Theme.faintForeground)
                    .frame(minWidth: 20, alignment: .leading)
                    .help(dependencies.helpText ?? "")
                VStack(alignment: .leading, spacing: 3) {
                    TextField("Title", text: $title.title)
                        .textFieldStyle(.plain)
                        .font(.pilot(.body))
                        .strikethrough(task.status.isClosed)
                        .foregroundStyle(task.status.isClosed || dependencies.isWaiting ? Theme.mutedForeground : Theme.foreground)
                        .onSubmit(saveTitle)
                        .accessibilityLabel("Task \(task.number) title")
                    if dependencies.isWaiting { waitingLine }
                    MissionTaskDelegationLabel(task: task, resources: resources)
                    if let preferred = task.preferredModel { modelLine(preferred) }
                    MissionTaskDescription(task: task, collapsedLineLimit: 2)
                    if !resources.isEmpty || !artifactLinks.isEmpty {
                        ResponsiveControlsLayout(horizontalSpacing: 10, verticalSpacing: 4) {
                            ForEach(resources) { item in
                                MissionLinkChip(resource: item, missionId: mission.id)
                            }
                            ForEach(artifactLinks) { item in
                                Button { open(item) } label: {
                                    Label("\(item.title) · \(item.revision.map { "r\($0)" } ?? "latest")",
                                          icon: item.kind == "image" ? PilotIcon.image : PilotIcon.artifact)
                                        .lineLimit(1)
                                        .font(.pilot(.caption))
                                        .foregroundStyle(Theme.mutedForeground)
                                }
                                .buttonStyle(.plain)
                                .help("Open \(item.title)")
                            }
                        }
                        .padding(.top, 1)
                    }
                }
                Spacer(minLength: 8)
                if let sessionId = task.sessionId {
                    let chat = client.session(sessionId)?.title
                    Button { model.selectedSessionId = sessionId } label: {
                        Label(MissionTaskOwnerLabel.text(task: task, chatTitle: chat), icon: PilotIcon.message)
                            .lineLimit(1).font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                    }
                    .buttonStyle(.plain)
                    .frame(maxWidth: 180, alignment: .trailing)
                    .help(MissionTaskOwnerLabel.help(chatTitle: chat))
                }
                HStack(spacing: 4) {
                    if task.sessionId == nil, task.status.canStart {
                        MissionTaskStartButton(status: mission.status) { model.startChat(for: task, missionId: mission.id) }
                    }
                    // The fixed slot sets the layout and baseline; the menu is an overlay so building it on
                    // hover cannot move the row.
                    Color.clear.frame(width: 20, height: 20)
                        .overlay {
                            if hovered {
                                Menu { menuItems } label: { PilotSymbol(PilotIcon.more, context: .toolbar) }
                                    .menuStyle(.button)
                                    .rowIconButtonStyle()
                                    .menuIndicator(.hidden)
                                    .fixedSize()
                                    .help("Task actions")
                                    .accessibilityLabel("Actions for task \(task.number)")
                            }
                        }
                }
                .revealed(hovered)
            }
        }
        .onChange(of: task.title) { _, value in title.title = value }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(accessibilitySummary)
        .background(RoundedRectangle(cornerRadius: Theme.Radius.row).fill(highlighted ? Theme.selected : .clear))
        .animation(Theme.Motion.quick, value: highlighted)
        .contextMenu { menuItems }
        .popover(isPresented: $addingLink, arrowEdge: .bottom) {
            MissionAddLinkForm(missionId: mission.id, taskId: task.id, title: "Link to task #\(task.number)") {
                addingLink = false
            }
        }
        .sheet(isPresented: $choosingModel) { MissionTaskModelSheet(task: task, mission: mission) }
        .sheet(item: $artifacts.selected) { selection in
            ArtifactViewer(reference: selection.reference, latest: selection.latest)
        }
    }

    /// Quiet preferred-model metadata; clicking it edits the preference.
    private func modelLine(_ preferred: String) -> some View {
        let text = TaskModelLabel.text(model: preferred, thinking: task.preferredThinking,
                                       list: client.cachedModels(projectId: mission.projectId, cwd: nil))
        return Button { choosingModel = true } label: {
            Label(text, icon: PilotIcon.model)
                .lineLimit(1)
                .font(.pilot(.caption))
                .foregroundStyle(Theme.mutedForeground)
        }
        .buttonStyle(.plain)
        .help(TaskModelLabel.help(task))
        .accessibilityLabel("Preferred model: \(text)")
    }

    /// "Waiting on #12, #14": each number scrolls to that task.
    private var waitingLine: some View {
        HStack(spacing: 4) {
            PilotSymbol(PilotIcon.privateChannel)
            Text("Waiting on")
            ForEach(Array(dependencies.waitingOn.enumerated()), id: \.element.id) { index, dependency in
                Button { onShowTask(dependency.id) } label: {
                    Text("#\(dependency.number)\(index < dependencies.waitingOn.count - 1 ? "," : "")")
                        .monospacedDigit()
                }
                .buttonStyle(.plain)
                .help("Show #\(dependency.number) \(dependency.title)")
                .accessibilityLabel("Show task \(dependency.number)")
            }
        }
        .font(.pilot(.caption))
        .foregroundStyle(Theme.mutedForeground)
        .lineLimit(1)
        .help(dependencies.helpText ?? "")
    }

    private var accessibilitySummary: String {
        var parts = ["Task \(task.number)", title.title, task.delegationLabel ?? task.status.label]
        if let waiting = dependencies.accessibilityText { parts.append(waiting) }
        return parts.joined(separator: ", ")
    }

    @ViewBuilder private var menuItems: some View {
        let index = siblings.firstIndex { $0.id == task.id } ?? 0
        if let sessionId = task.sessionId {
            Button("Open Chat") { model.selectedSessionId = sessionId }
        } else if task.status.canStart {
            Button("Start Chat") { model.startChat(for: task, missionId: mission.id) }
                .disabled(mission.status != .active)
        }
        Menu("Assign To") {
            ForEach(members) { session in
                Button(session.title) { assign(session.id) }.disabled(session.id == task.sessionId)
            }
            if members.isEmpty { Text("No mission chats") }
        }
        if task.sessionId != nil {
            Button("Release Claim") { assign(nil) }
        }
        Menu("Status") {
            ForEach(MissionTaskStatus.allCases, id: \.self) { status in
                Button { setStatus(status) } label: { Label(status.label, icon: status.icon) }
                    .disabled(status == task.status)
            }
        }
        Button(task.preferredModel == nil ? "Set Preferred Model…" : "Change Preferred Model…") { choosingModel = true }
        Divider()
        Button("Add Link…") { addingLink = true }
        if let needed = dependencies.neededByText {
            Text(needed)
        }
        Button("Copy Reference") {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString("#\(task.number) \(task.title)", forType: .string)
        }
        Divider()
        Button("Move Up") { move(-1) }.disabled(index == 0)
        Button("Move Down") { move(1) }.disabled(index >= siblings.count - 1)
        Divider()
        Button("Delete Task", role: .destructive) {
            model.missionAction { [client, id = mission.id] in try await client.deleteMissionTask(id, taskId: task.id) }
        }
    }

    private func open(_ item: MissionArtifactLink) {
        artifacts.selected = MissionArtifactSelection(
            reference: ArtifactReference(id: item.artifactId, sessionId: item.sessionId,
                                         title: item.title, revision: item.revision ?? 0),
            latest: item.revision == nil)
    }

    private func saveTitle() {
        let value = title.title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, value != task.title else { title.title = task.title; return }
        model.missionAction { [client, id = mission.id] in
            try await client.updateMissionTask(id, taskId: task.id, MissionTaskWrite(title: value))
        }
    }

    private func setStatus(_ status: MissionTaskStatus) {
        model.missionAction { [client, id = mission.id] in
            try await client.updateMissionTask(id, taskId: task.id, MissionTaskWrite(status: status))
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

struct MissionTaskStartButton: View {
    let status: MissionStatus
    let action: () -> Void

    var body: some View {
        Button("Start chat", action: action)
            .controlSize(.small)
            .disabled(status != .active)
            .help(status == .active
                  ? "Start a new chat in this project that joins the mission and claims this task"
                  : "Reopen the mission before starting a new chat")
    }
}

/// The task's status icon, in its colour, opening a status menu. A plain menu style keeps the colour
/// (borderless pop-ups redraw the label as a template image).
struct MissionTaskStatusMenu: View {
    let task: MissionTask
    let missionId: String
    /// Waiting on unfinished dependencies: a muted symbol. The stored status is unchanged.
    var subdued = false
    /// False draws only the icon, without creating the menu, for rows that are not hovered.
    var interactive = true
    @EnvironmentObject private var model: AppModel

    var body: some View {
        // The plain icon always sets the size and baseline. The menu, built only when interactive, sits in an
        // overlay so switching to it on hover does not shift the row.
        icon
            .opacity(interactive ? 0 : 1)
            .overlay {
                if interactive {
                    Menu {
                        ForEach(MissionTaskStatus.allCases, id: \.self) { status in
                            Button { set(status) } label: { Label(status.label, icon: status.icon) }
                                .disabled(status == task.status)
                        }
                    } label: {
                        icon
                    }
                    .chipMenuStyle()
                    .fixedSize()
                }
            }
            .fixedSize()
            .help("Status: \(task.delegationLabel ?? task.status.label)")
            .accessibilityLabel("Status \(task.delegationLabel ?? task.status.label)")
    }

    private var icon: some View {
        PilotSymbol(task.status.icon, context: .row)
            .foregroundStyle(subdued ? Theme.faintForeground : task.status.color)
            .frame(width: 16)
            .contentShape(Rectangle())
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
        let all = model.members(of: mission)
        let active = all.filter { !$0.isArchived }
        let archived = all.filter(\.isArchived)
        let members = switch state.filter {
        case .active: active
        case .archived: archived
        case .all: all
        }
        let tasksByChat = MissionTasksByChat.index(detail.tasks)
        VStack(alignment: .leading, spacing: 8) {
            if !all.isEmpty {
                Picker("Show", selection: $state.filter) {
                    Text(active.isEmpty ? "Active" : "Active \(active.count)").tag(MissionChatFilter.active)
                    Text(archived.isEmpty ? "Archived" : "Archived \(archived.count)").tag(MissionChatFilter.archived)
                    Text("All").tag(MissionChatFilter.all)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .fixedSize()
                .padding(.bottom, 6)
            }
            if all.isEmpty || (members.isEmpty && state.filter == .active) {
                EmptyStateView(icon: PilotIcon.chats, title: "No chats yet",
                               message: "Start a chat to work on the mission, or bring in a chat from this project.") {
                    Button { model.newSession(in: mission) } label: { Label("New Chat", icon: PilotIcon.compose) }
                        .buttonStyle(.borderedProminent)
                        .disabled(mission.status != .active)
                    Menu("Add Existing Chat") { MissionExistingChatItems(mission: mission) }
                        .fixedSize()
                }
            } else if members.isEmpty {
                Text("No archived chats").font(.pilot(.body)).foregroundStyle(Theme.faintForeground)
                    .padding(.horizontal, 8)
            }
            ForEach(Array(members.enumerated()), id: \.element.id) { index, session in
                if index > 0 { HairlineDivider(leading: 34) }
                MissionChatRow(session: session, mission: mission,
                               tasks: tasksByChat[session.id] ?? [])
            }
        }
    }
}

/// A member chat. The whole row opens it; actions sit in a menu shown on hover and in the context menu.
private struct MissionChatRow: View {
    let session: SessionSummary
    let mission: Mission
    let tasks: [MissionTask]
    @EnvironmentObject private var model: AppModel

    var body: some View {
        let coordinator = mission.coordinatorSessionId == session.id
        let unread = model.isUnread(session)
        HoverRow(verticalPadding: 7) { hovered in
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                // An active coordinator is never shown as done.
                SessionStatusIcon(status: session.isActiveMissionCoordinator && !session.isWorking ? .idle : session.status)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(session.title).font(.pilot(.body, weight: unread ? .semibold : .regular))
                            .foregroundStyle(Theme.foreground).lineLimit(1)
                        if coordinator { MissionCoordinatorIndicator(showsLabel: true) }
                        if session.isArchived {
                            Text("Archived").font(.pilot(.small)).foregroundStyle(Theme.faintForeground)
                        }
                    }
                    if !tasks.isEmpty {
                        Text(tasks.map { "#\($0.number) \($0.title)" }.joined(separator: ", "))
                            .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground).lineLimit(1)
                    }
                }
                Spacer(minLength: 8)
                if unread { UnreadBadge() }
                ZStack(alignment: .trailing) {
                    Text(SessionTimeFormatting.relative(session.listActivityAt))
                        .font(.pilot(.caption)).monospacedDigit().foregroundStyle(Theme.faintForeground)
                        .opacity(hovered ? 0 : 1)
                    Menu { actions(coordinator: coordinator) } label: { PilotSymbol(PilotIcon.more, context: .toolbar) }
                        .menuStyle(.button)
                        .rowIconButtonStyle()
                        .menuIndicator(.hidden)
                        .fixedSize()
                        .help("Chat actions")
                        .accessibilityLabel("Actions for \(session.title)")
                        .revealed(hovered)
                }
            }
        }
        .onTapGesture { model.selectedSessionId = session.id }
        .contextMenu { actions(coordinator: coordinator) }
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { model.selectedSessionId = session.id }
        .help("Open “\(session.title)”")
    }

    @ViewBuilder private func actions(coordinator: Bool) -> some View {
        Button("Open Chat") { model.selectedSessionId = session.id }
        if coordinator {
            Button("Coordinate It Yourself") { model.setCoordinator(nil, missionId: mission.id) }
        } else if !session.isArchived {
            Button("Make Coordinator") { model.setCoordinator(session.id, missionId: mission.id) }
        }
        Divider()
        Button("Remove from Mission", role: .destructive) { model.removeFromMission(session.id) }
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
        let taskNumbers = Dictionary(uniqueKeysWithValues: detail.tasks.map { ($0.id, $0.number) })
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text("Artifacts stay owned by their chat. Linking makes them part of the mission.")
                    .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                Spacer(minLength: 8)
                if !detail.artifacts.isEmpty { linkMenu(members: members) }
            }
            .padding(.bottom, 6)
            if detail.artifacts.isEmpty {
                EmptyStateView(icon: PilotIcon.artifact, title: "No linked artifacts",
                               message: "Link a chat's mockups, diagrams or reports so every mission chat can find them.") {
                    linkMenu(members: members)
                }
            }
            ForEach(Array(detail.artifacts.enumerated()), id: \.element.id) { index, link in
                if index > 0 { HairlineDivider(leading: 34) }
                HoverRow(verticalPadding: 7) { hovered in
                    HStack(spacing: 10) {
                        PilotSymbol(link.kind == "image" ? PilotIcon.image : PilotIcon.artifact)
                            .foregroundStyle(Theme.mutedForeground).frame(width: 16)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(link.title).font(.pilot(.body)).foregroundStyle(Theme.foreground).lineLimit(1)
                            Text([client.session(link.sessionId)?.title ?? "Chat",
                                  link.taskId.flatMap { taskNumbers[$0] }.map { "Task #\($0)" }]
                                .compactMap { $0 }.joined(separator: " · "))
                                .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground).lineLimit(1)
                        }
                        Spacer(minLength: 8)
                        Text("\(link.kind.uppercased()) · \(link.revision.map { "r\($0)" } ?? "latest")")
                            .font(.pilot(.caption, design: .monospaced)).foregroundStyle(Theme.faintForeground)
                        Button { unlink(link) } label: { PilotSymbol(PilotIcon.dismiss, context: .toolbar) }
                            .rowIconButtonStyle()
                            .help(link.taskId == nil ? "Unlink from mission" : "Unlink from task")
                            .accessibilityLabel("Unlink \(link.title)")
                            .revealed(hovered)
                    }
                }
                .onTapGesture { open(link) }
                .contextMenu {
                    Button("Open") { open(link) }
                    Button("Unlink", role: .destructive) { unlink(link) }
                }
                .accessibilityElement(children: .contain)
                .accessibilityAddTraits(.isButton)
                .accessibilityAction { open(link) }
                .help("Open \(link.title)")
            }
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

    private func linkMenu(members: [SessionSummary]) -> some View {
        let linked = Set(detail.artifacts.filter { $0.taskId == nil }.map(\.artifactId))
        let linkable = members.flatMap { client.artifacts[$0.id] ?? [] }.filter { !linked.contains($0.id) }
        return Menu {
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
            ChipLabel(title: "Link artifact", icon: PilotIcon.link)
        }
        .chipMenuStyle()
        .fixedSize()
    }

    private func open(_ link: MissionArtifactLink) {
        state.selected = MissionArtifactSelection(
            reference: ArtifactReference(id: link.artifactId, sessionId: link.sessionId,
                                         title: link.title, revision: link.revision ?? 0),
            latest: link.revision == nil)
    }

    private func unlink(_ link: MissionArtifactLink) {
        model.missionAction { [client, id = mission.id] in
            try await client.unlinkMissionArtifact(id, artifactId: link.artifactId, taskId: link.taskId)
        }
    }
}

// MARK: Activity

private struct MissionActivityState {
    var older: [MissionEvent] = []
    var exhausted = false
    var loading = false
    var kind: MissionEventWriteKind = .update
    var health: MissionHealth?
}

struct MissionActivityTab: View {
    let mission: Mission
    let detail: MissionDetail
    @EnvironmentObject private var model: AppModel
    @ObservedObject private var client = AppModel.shared.client
    @State private var input = MissionInput()
    @State private var state = MissionActivityState()

    var body: some View {
        let recentIds = Set(detail.events.map(\.id))
        let events = detail.events + state.older.filter { !recentIds.contains($0.id) }
        let days = MissionActivityDay.group(events)
        // Lazy: a long history creates only the entries on screen.
        LazyVStack(alignment: .leading, spacing: 0) {
            composer
                .padding(.bottom, 20)
            if events.isEmpty {
                EmptyStateView(icon: PilotIcon.pending, title: "No activity yet",
                               message: "Updates, handoffs, task changes and brief revisions appear here.")
            }
            ForEach(MissionActivityItem.items(days)) { item in
                switch item {
                case let .day(day, first):
                    Text(day.title).font(.pilot(.caption, weight: .semibold)).foregroundStyle(Theme.mutedForeground)
                        .accessibilityAddTraits(.isHeader)
                        .padding(.top, first ? 0 : 20)
                        .padding(.bottom, 10)
                case let .event(event, last):
                    MissionTimelineRow(event: event, last: last)
                }
            }
            if !events.isEmpty, !state.exhausted {
                Button(state.loading ? "Loading…" : "Load older activity") { loadOlder(before: events.last?.id) }
                    .buttonStyle(.plain)
                    .font(.pilot(.label))
                    .foregroundStyle(Theme.mutedForeground)
                    .disabled(state.loading)
                    .frame(maxWidth: .infinity)
                    .padding(.top, 20)
            }
        }
    }

    private var composer: some View {
        ComposerTray {
            TextField("Post an update or handoff for the mission chats…", text: $input.text, axis: .vertical)
                .lineLimit(2 ... 6)
                .accessibilityLabel("Update text")
        } controls: {
            Menu {
                Button { state.kind = .update } label: { Label("Update", icon: PilotIcon.update) }
                Button { state.kind = .handoff } label: { Label("Handoff", icon: PilotIcon.handoff) }
            } label: {
                ChipLabel(title: state.kind == .handoff ? "Handoff" : "Update",
                          icon: state.kind == .handoff ? PilotIcon.handoff : PilotIcon.update)
            }
            .chipMenuStyle()
            .fixedSize()
            .help("A status update, or a handoff note for whoever continues the work")
            Menu {
                Button("No Health") { state.health = nil }
                Divider()
                ForEach([MissionHealth.onTrack, .atRisk, .offTrack], id: \.self) { health in
                    Button(health.label) { state.health = health }
                }
            } label: {
                ChipLabel(title: state.health?.label ?? "Health", icon: state.health == nil ? PilotIcon.unset : nil,
                          dot: state.health?.color)
            }
            .chipMenuStyle()
            .fixedSize()
            .help("Optional mission health")
            Spacer()
            Button(action: post) { PilotSymbol(PilotIcon.send, context: .toolbar) }
                .buttonStyle(CircleIconButtonStyle())
                .keyboardShortcut(.return, modifiers: .command)
                .disabled(input.busy || input.trimmed(input.text).isEmpty)
                .help("Post (⌘↩)")
                .accessibilityLabel("Post")
        }
    }

    private func post() {
        let text = input.trimmed(input.text)
        guard !text.isEmpty, !input.busy else { return }
        input.busy = true
        let write = MissionEventWrite(text: text, kind: state.kind, health: state.health)
        model.missionAction { [client, id = mission.id] in
            defer { input.busy = false }
            try await client.postMissionEvent(id, write)
            input.text = ""
        }
    }

    private func loadOlder(before: Int?) {
        guard let before else { return }
        state.loading = true
        model.missionAction { [client, id = mission.id] in
            defer { state.loading = false }
            let page = try await client.missionEvents(id, before: before)
            if page.isEmpty { state.exhausted = true }
            state.older += page
        }
    }
}

/// Activity entries of one calendar day, newest first.
struct MissionActivityDay: Identifiable {
    let id: Date
    let title: String
    let events: [MissionEvent]

    static func group(_ events: [MissionEvent], now: Date = Date(), calendar: Calendar = .current) -> [MissionActivityDay] {
        var days: [(id: Date, events: [MissionEvent])] = []
        for event in events {
            let day = calendar.startOfDay(for: Date(timeIntervalSince1970: event.at / 1000))
            if days.last?.id == day {
                days[days.count - 1].events.append(event)
            } else {
                days.append((day, [event]))
            }
        }
        return days.map { MissionActivityDay(id: $0.id, title: title($0.id, now: now, calendar: calendar), events: $0.events) }
    }

    static func title(_ day: Date, now: Date, calendar: Calendar) -> String {
        if calendar.isDate(day, inSameDayAs: now) { return "Today" }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(day, inSameDayAs: yesterday) {
            return "Yesterday"
        }
        let sameYear = calendar.component(.year, from: day) == calendar.component(.year, from: now)
        return day.formatted(sameYear ? .dateTime.weekday(.wide).day().month(.wide)
                                      : .dateTime.day().month(.wide).year())
    }
}

/// One line of the activity timeline: a day title or an entry. A flat list keeps the timeline lazy.
private enum MissionActivityItem: Identifiable {
    case day(MissionActivityDay, first: Bool)
    case event(MissionEvent, last: Bool)

    var id: String {
        switch self {
        case let .day(day, _): "day-\(day.id.timeIntervalSince1970)"
        case let .event(event, _): "event-\(event.id)"
        }
    }

    static func items(_ days: [MissionActivityDay]) -> [MissionActivityItem] {
        var items: [MissionActivityItem] = []
        items.reserveCapacity(days.reduce(days.count) { $0 + $1.events.count })
        for (index, day) in days.enumerated() {
            items.append(.day(day, first: index == 0))
            for (position, event) in day.events.enumerated() {
                items.append(.event(event, last: position == day.events.count - 1))
            }
        }
        return items
    }
}

/// One activity entry on the timeline: an icon on a thread line, the text and its byline.
private struct MissionTimelineRow: View {
    let event: MissionEvent
    let last: Bool

    var body: some View {
        let handoff = event.kind == .handoff
        HStack(alignment: .top, spacing: 12) {
            PilotSymbol(event.kind.icon)
                .foregroundStyle(Theme.mutedForeground)
                .frame(width: 22, height: 22)
                .background(Circle().fill(Theme.muted))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                if handoff {
                    Text("Handoff").font(.pilot(.small, weight: .semibold)).foregroundStyle(Theme.mutedForeground)
                }
                Text(event.text).font(.pilot(.body)).foregroundStyle(Theme.foreground)
                    .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                TimelineView(.periodic(from: .now, by: 60)) { context in
                    MissionEventByline(event: event, time: missionRelativeTime(event.at, now: context.date))
                }
            }
            .padding(.top, 3)
            .padding(.bottom, last ? 0 : 16)
            Spacer(minLength: 0)
        }
        .background(alignment: .topLeading) {
            if !last {
                Rectangle().fill(Theme.border).frame(width: 1)
                    .padding(.leading, 10.5).padding(.top, 24).padding(.bottom, 2)
            }
        }
    }
}
