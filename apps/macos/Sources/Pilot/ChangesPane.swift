import Combine
import PilotCore
import SwiftUI

@MainActor
final class ChangesModel: ObservableObject {
    @Published private(set) var changes: SessionChanges?
    @Published private(set) var diffs: [String: FileDiff] = [:]
    @Published private(set) var error: String?
    @Published private(set) var loading = false
    @Published var expanded: Set<String> = []
    let sessionId: String

    init(sessionId: String) { self.sessionId = sessionId }

    func load(client: PilotClient) async {
        guard !Task.isCancelled else { return }
        guard !loading else { return }
        loading = true
        defer { loading = false }
        do {
            let changes = try await client.changes(sessionId)
            try Task.checkCancellation()
            if changes != self.changes {
                let diffs = await Task.detached(priority: .userInitiated) {
                    Dictionary(Diff.parseUnified(changes.diff).map { ($0.path, $0) }, uniquingKeysWith: { first, _ in first })
                }.value
                try Task.checkCancellation()
                let firstLoad = self.changes == nil
                self.changes = changes
                self.diffs = diffs
                // Small change sets open fully: that is the review.
                if firstLoad, changes.files.reduce(0, { $0 + $1.additions + $1.deletions }) <= 400 {
                    expanded = Set(changes.files.map(\.path))
                }
            }
            if error != nil { error = nil }
        } catch {
            guard !Task.isCancelled else { return }
            self.error = error.localizedDescription
        }
    }
}

/// What the session changed in its working copy: committed and uncommitted, since it branched.
struct ChangesPane: View {
    @Environment(\.hostViewContext) private var hostContext
    @EndpointClient private var endpoint
    let session: SessionSummary
    var isVisible = true
    @Environment(\.repositoryPollingVisible) private var windowVisible
    @State private var viewingFile: String?
    @StateObject private var model: ChangesModel
    init(session: SessionSummary, isVisible: Bool = true) {
        self.session = session
        self.isVisible = isVisible
        _model = StateObject(wrappedValue: ChangesModel(sessionId: session.id))
    }

    private var pollingKey: RepositoryPollingKey {
        RepositoryPollingKey(visible: isVisible && windowVisible, state: session.state, updatedAt: session.updatedAt)
    }

    var body: some View {
        VStack(spacing: 0) {
            ChangesRepositoryContext(session: session, changes: model.changes)
            Rectangle().fill(Theme.border).frame(height: 1)
            header
            content
        }
        .background(Theme.background)
        .sheet(isPresented: Binding(get: { viewingFile != nil }, set: { if !$0 { viewingFile = nil } })) {
            if let path = viewingFile, let context = hostContext {
                SessionFileViewer(session: context.ref(.session, session.id), path: path, hosts: context.hosts)
            }
        }
        .task(id: pollingKey) {
            guard pollingKey.enabled else { return }
            while !Task.isCancelled {
                await model.load(client: endpoint)
                do { try await Task.sleep(for: .seconds(RepositoryPolling.interval(working: session.isWorking, fullDiff: true))) }
                catch { return }
            }
        }
    }

    private var header: some View {
        let title = model.changes.map { changes in
            changes.files.isEmpty ? "No changes" : "\(changes.files.count) file\(changes.files.count == 1 ? "" : "s")"
        } ?? "Changes"
        return InspectorPaneHeader(title, detail: {
            if let changes = model.changes {
                DiffStat(
                    additions: changes.files.reduce(0) { $0 + $1.additions },
                    deletions: changes.files.reduce(0) { $0 + $1.deletions }
                )
                Text("since \(changes.base)").font(.pilot(.small)).foregroundStyle(Theme.faintForeground)
                    .lineLimit(1).truncationMode(.middle).help("Changes since \(changes.base)")
            }
        }, trailing: {
            if model.loading { ProgressView().controlSize(.mini) }
            Button { Task { await model.load(client: endpoint) } } label: { PilotSymbol(PilotIcon.refresh, context: .toolbar) }
                .buttonStyle(QuietIconButtonStyle())
                .help("Refresh")
                .accessibilityLabel("Refresh changes")
        })
    }

    @ViewBuilder private var content: some View {
        if session.state == "starting", model.changes == nil {
            ProgressView("Preparing task…").frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let error = model.error, model.changes == nil {
            EmptyStateView(icon: PilotIcon.warning, title: "Couldn't load changes", message: error) {
                Button("Retry") { Task { await model.load(client: endpoint) } }
            }
            .frame(maxHeight: .infinity)
        } else if let changes = model.changes, changes.files.isEmpty {
            EmptyStateView(icon: PilotIcon.complete, title: "No changes", message: "The working copy matches \(changes.base).")
                .frame(maxHeight: .infinity)
        } else if let changes = model.changes {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(changes.files) { file in
                        FileRow(file: file, expanded: model.expanded.contains(file.path)) {
                            if model.expanded.contains(file.path) { model.expanded.remove(file.path) } else { model.expanded.insert(file.path) }
                        }
                        .contextMenu { Button("View file") { viewingFile = file.path } }
                        if model.expanded.contains(file.path), let diff = model.diffs[file.path] {
                            DiffView(file: diff)
                                .padding(.vertical, 4)
                                .background(Theme.code)
                        }
                        Rectangle().fill(Theme.border).frame(height: 1)
                    }
                    if changes.truncated {
                        Text("Diff truncated at 1 MiB.").font(.pilot(.small)).foregroundStyle(Theme.mutedForeground).padding(12)
                    }
                }
            }
        } else {
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}

/// Repository context remains available while diffs are loading, empty, or unavailable.
struct ChangesRepositoryContext: View {
    @EndpointClient private var endpoint
    let session: SessionSummary
    var changes: SessionChanges?
    @State private var detachConfirmation: DetachConfirmation?
    @State private var detaching: Set<String> = []
    @State private var detachError: String?

    var branch: String? {
        if session.isActiveMissionCoordinator { return nil }
        if let changes { return changes.branch }
        return session.branch
    }

    var body: some View {
        let links = session.branchLinks(current: branch)
        let pending = session.pendingBoundPullRequests
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                if !links.isEmpty || !pending.isEmpty {
                    SectionLabel(title: "Branches", count: links.count + pending.count)
                    Spacer(minLength: 8)
                }
                Label(session.workspaceLabel, icon: workspaceIcon)
                    .font(.pilot(.small))
                    .foregroundStyle(Theme.mutedForeground)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .help(session.workspaceHelp)
            }
            .padding(.horizontal, 8)
            if session.isActiveMissionCoordinator, session.workspaceBase != nil {
                TimelineView(.periodic(from: .now, by: 60)) { context in
                    Text(session.workspaceBaseLabel(now: context.date) ?? "")
                        .font(.pilot(.small))
                        .foregroundStyle(Theme.mutedForeground)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                        .help(session.workspaceBehind ?? "Current workspace base. Updates happen between turns, never during work.")
                }
                .padding(.horizontal, 8)
            }
            if !links.isEmpty || !pending.isEmpty {
                VStack(spacing: 2) {
                    ForEach(links) { link in
                        let branchKey = link.name.map { "branch:\($0)" }
                        BranchLinkRow(
                            link: link, current: link.name != nil && link.name == branch, stale: session.pullRequestIsStale,
                            attached: link.pullRequest.map { session.showsAttachedHint($0, current: branch) } ?? false,
                            busy: (link.pullRequest?.url ?? branchKey).map { detaching.contains($0) } ?? false,
                            detach: link.pullRequest.map { pr in { requestDetach(url: pr.url, number: pr.number) } },
                            detachBranch: link.pullRequest == nil
                                ? link.name.flatMap { name in session.canDetachBranch(name) ? { detachBranch(name) } : nil }
                                : nil
                        )
                    }
                    ForEach(pending, id: \.self) { url in
                        PendingAttachedRow(url: url, busy: detaching.contains(url)) {
                            requestDetach(url: url, number: PullRequestURL.number(of: url))
                        }
                    }
                }
            }
            if let detachError {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(detachError)
                        .font(.pilot(.caption))
                        .foregroundStyle(Theme.destructive)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                    Spacer(minLength: 0)
                    Button { self.detachError = nil } label: { PilotSymbol(PilotIcon.dismiss, context: .toolbar) }
                        .rowIconButtonStyle()
                        .help("Dismiss")
                        .accessibilityLabel("Dismiss error")
                }
                .padding(.horizontal, 8)
            }
            if session.canAttachPullRequests {
                AttachPullRequestButton(session: session)
                    .padding(.horizontal, 8)
            }
            if session.linkedPullRequests.isEmpty, session.pullRequestError != nil {
                // Lookup failures without a cached PR.
                PullRequestBadge(session: session, presentation: .details)
                    .padding(.horizontal, 8)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 4)
        .padding(.vertical, 10)
        .confirmationDialog(
            detachConfirmation?.prompt ?? "",
            isPresented: Binding(get: { detachConfirmation != nil }, set: { if !$0 { detachConfirmation = nil } }),
            titleVisibility: .visible,
            presenting: detachConfirmation
        ) { item in
            Button("Detach", role: .destructive) { detach(url: item.url) }
            Button("Cancel", role: .cancel) {}
        } message: { _ in
            Text("This chat stops tracking it and gets no CI or review follow-ups for it. The branch and the pull request stay unchanged.")
        }
    }

    /// Outside a mission, detaching is one click and undone by attaching again. In a mission it also unlinks
    /// the PR from its task, so the user confirms after seeing which one.
    private func requestDetach(url: String, number: Int?) {
        detachError = nil
        guard let missionId = session.missionId, let number else { return detach(url: url) }
        let sessionId = session.id
        let client = endpoint
        detaching.insert(url)
        Task { @MainActor in
            let detail: MissionDetail?
            if let cached = client.missionDetails[missionId] { detail = cached }
            else { detail = try? await client.missionDetail(missionId) }
            detaching.remove(url)
            let tasks = detail.map { PullRequestAttachment.linkedTasks(of: url, sessionId: sessionId, in: $0) } ?? []
            // Nothing to unlink: no confirmation needed. An unknown answer still asks.
            if detail != nil, tasks.isEmpty { return detach(url: url) }
            detachConfirmation = DetachConfirmation(url: url, prompt: PullRequestAttachment.detachPrompt(number: number, tasks: tasks))
        }
    }

    private func detach(url: String) {
        let sessionId = session.id
        detaching.insert(url)
        Task { @MainActor in
            defer { detaching.remove(url) }
            do { try await endpoint.unbindPullRequest(sessionId, url: url) }
            catch { detachError = "Couldn't detach the pull request. \(error.localizedDescription)" }
        }
    }

    /// One click, like detaching a PR outside a mission. The branch stays in the repository.
    private func detachBranch(_ name: String) {
        let sessionId = session.id
        let key = "branch:\(name)"
        detachError = nil
        detaching.insert(key)
        Task { @MainActor in
            defer { detaching.remove(key) }
            do { try await AppModel.shared.client.detachBranch(sessionId, branch: name) }
            catch { detachError = "Couldn't detach the branch. \(error.localizedDescription)" }
        }
    }

    private var workspaceIcon: PilotIcon {
        if session.isAsk { return PilotIcon.askMode }
        if session.workspaceStorage == .shared { return PilotIcon.sharedWorkspace }
        return session.workspace == .direct ? PilotIcon.project : PilotIcon.isolatedWorkspace
    }
}

private struct DetachConfirmation: Equatable {
    let url: String
    let prompt: String
}

/// A session branch and the PR opened from it or attached to the chat. Long names wrap so the full branch
/// stays readable. PR rows, and branch rows the chat can detach, reveal a ⋯ menu on hover, mirrored in the
/// context menu.
private struct BranchLinkRow: View {
    let link: SessionBranchLink
    let current: Bool
    let stale: Bool
    /// Bound by hand and not on the chat's current branch.
    var attached = false
    var busy = false
    var detach: (() -> Void)?
    /// Stops tracking a branch without a PR.
    var detachBranch: (() -> Void)?
    @State private var hovered = false

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            PilotMarkIcon(mark: .gitBranch)
                .foregroundStyle(current ? Theme.foreground : Theme.faintForeground)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    name
                    if attached { AttachedHint() }
                }
                HStack(spacing: 6) {
                    if let pr = link.pullRequest {
                        PullRequestPill(pullRequest: pr, stale: stale)
                        Text(pr.title)
                            .font(.pilot(.caption))
                            .foregroundStyle(Theme.mutedForeground)
                            .lineLimit(1)
                            .truncationMode(.tail)
                            .help(pr.title)
                    } else {
                        Text("No pull request")
                            .font(.pilot(.caption))
                            .foregroundStyle(Theme.faintForeground)
                    }
                }
            }
            .accessibilityElement(children: .combine)
            Spacer(minLength: 0)
            if let pr = link.pullRequest, let detach {
                PullRequestRowMenu(url: pr.url, number: pr.number, busy: busy, visible: hovered, detach: detach)
            } else if let name = link.name, let detachBranch {
                BranchRowMenu(name: name, busy: busy, visible: hovered, detach: detachBranch)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 7)
        .background(RoundedRectangle(cornerRadius: Theme.Radius.row).fill(current || hovered ? Theme.muted : .clear))
        .contentShape(Rectangle())
        .onHover { hovered = $0 }
        .animation(Theme.Motion.quick, value: hovered)
        .contextMenu {
            if let pr = link.pullRequest, let detach {
                PullRequestRowActions(url: pr.url, detach: detach)
            } else if let name = link.name, let detachBranch {
                BranchRowActions(name: name, detach: detachBranch)
            }
        }
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder private var name: some View {
        if let name = link.name {
            Text(name)
                .font(.pilot(.caption, weight: current ? .semibold : .regular, design: .monospaced))
                .foregroundStyle(Theme.foreground)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
                .help(current ? "Current branch: \(name)" : "Branch: \(name)")
                .accessibilityLabel(current ? "Current branch \(name)" : "Branch \(name)")
        } else {
            Text("Unknown branch")
                .font(.pilot(.caption))
                .italic()
                .foregroundStyle(Theme.faintForeground)
        }
    }
}

/// A PR bound to the chat whose GitHub details are still loading. Binding returns before pilotd checks GitHub.
private struct PendingAttachedRow: View {
    let url: String
    let busy: Bool
    let detach: () -> Void
    @State private var hovered = false

    var body: some View {
        let number = PullRequestURL.number(of: url)
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            PilotMarkIcon(mark: .gitBranch)
                .foregroundStyle(Theme.faintForeground)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(number.map { "PR #\(String($0))" } ?? url)
                        .font(.pilot(.caption, design: .monospaced))
                        .foregroundStyle(Theme.foreground)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    AttachedHint()
                }
                Text("Checking GitHub…")
                    .font(.pilot(.caption))
                    .foregroundStyle(Theme.faintForeground)
            }
            .accessibilityElement(children: .combine)
            .help(url)
            Spacer(minLength: 0)
            PullRequestRowMenu(url: url, number: number, busy: busy, visible: hovered, detach: detach)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 7)
        .background(RoundedRectangle(cornerRadius: Theme.Radius.row).fill(hovered ? Theme.muted : .clear))
        .contentShape(Rectangle())
        .onHover { hovered = $0 }
        .animation(Theme.Motion.quick, value: hovered)
        .contextMenu { PullRequestRowActions(url: url, detach: detach) }
        .accessibilityElement(children: .contain)
    }
}

/// Says why a PR appears although the chat never used its branch.
private struct AttachedHint: View {
    var body: some View {
        Text("attached")
            .font(.pilot(.small))
            .foregroundStyle(Theme.faintForeground)
            .fixedSize()
            .help("Attached to this chat by hand. Its head branch is not this chat's branch.")
            .accessibilityLabel("attached by hand")
    }
}

/// The hover ⋯ menu of a PR row, or a spinner while it is being detached.
private struct PullRequestRowMenu: View {
    let url: String
    let number: Int?
    let busy: Bool
    let visible: Bool
    let detach: () -> Void

    var body: some View {
        if busy {
            ProgressView().controlSize(.mini).frame(width: 20, height: 20)
        } else {
            Menu { PullRequestRowActions(url: url, detach: detach) } label: { PilotSymbol(PilotIcon.more, context: .toolbar) }
                .menuStyle(.button)
                .rowIconButtonStyle()
                .menuIndicator(.hidden)
                .fixedSize()
                .help("Pull request actions")
                .accessibilityLabel(number.map { "Actions for pull request \($0)" } ?? "Pull request actions")
                .revealed(visible)
        }
    }
}

private struct PullRequestRowActions: View {
    let url: String
    let detach: () -> Void

    var body: some View {
        if let link = URL(string: url), ["http", "https"].contains(link.scheme?.lowercased() ?? "") {
            Button("Open Pull Request") { BrowserLinkOpener.shared.open(link) }
        }
        Button("Copy Link") {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(url, forType: .string)
        }
        Divider()
        Button("Detach from This Chat", role: .destructive, action: detach)
    }
}

/// The hover ⋯ menu of a branch row without a PR, or a spinner while it is being detached.
private struct BranchRowMenu: View {
    let name: String
    let busy: Bool
    let visible: Bool
    let detach: () -> Void

    var body: some View {
        if busy {
            ProgressView().controlSize(.mini).frame(width: 20, height: 20)
        } else {
            Menu { BranchRowActions(name: name, detach: detach) } label: { PilotSymbol(PilotIcon.more, context: .toolbar) }
                .menuStyle(.button)
                .rowIconButtonStyle()
                .menuIndicator(.hidden)
                .fixedSize()
                .help("Branch actions")
                .accessibilityLabel("Actions for branch \(name)")
                .revealed(visible)
        }
    }
}

private struct BranchRowActions: View {
    let name: String
    let detach: () -> Void

    var body: some View {
        Button("Copy Branch Name") {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(name, forType: .string)
        }
        Divider()
        Button("Detach from This Chat", role: .destructive, action: detach)
            .help("This chat stops tracking the branch. The branch itself stays unchanged.")
    }
}

/// "+ Attach pull request…", a quiet secondary control under the branches, like the mission "+ Add link".
private struct AttachPullRequestButton: View {
    let session: SessionSummary
    @State private var presented = false

    var body: some View {
        Button { presented = true } label: {
            HStack(spacing: 4) {
                PilotSymbol(PilotIcon.add)
                Text("Attach pull request…")
            }
            .font(.pilot(.caption))
            .foregroundStyle(Theme.mutedForeground)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help("Attach a GitHub pull request to this chat. A pull request another chat has moves here.")
        .popover(isPresented: $presented, arrowEdge: .bottom) {
            AttachPullRequestForm(session: session) { presented = false }
        }
    }
}

/// The attach popover: a PR link validated by pilotd, open PRs of other chats as suggestions, the chat a PR
/// would move from and, in a mission, the task to link. Styled like MissionAddLinkForm.
struct AttachPullRequestForm: View {
    let session: SessionSummary
    let dismiss: () -> Void
    @EndpointClient private var client
    @State private var draft = PullRequestAttachDraft()
    @State private var mission: MissionDetail?
    @FocusState private var focused: Bool

    init(session: SessionSummary, draft: PullRequestAttachDraft = PullRequestAttachDraft(), mission: MissionDetail? = nil,
         dismiss: @escaping () -> Void) {
        self.session = session
        self.dismiss = dismiss
        _draft = State(initialValue: draft)
        _mission = State(initialValue: mission)
    }

    private var current: SessionSummary { client.session(session.id) ?? session }

    var body: some View {
        let current = current
        let owner = draft.owner(for: current, in: client.sessions)
        let suggestions = draft.text.isEmpty ? PullRequestAttachment.suggestions(for: current, in: client.sessions) : []
        VStack(alignment: .leading, spacing: 8) {
            Text("Attach a pull request").font(.pilot(.body, weight: .semibold))
            Text("This chat tracks it, follows up on CI and reviews, and may push to its branch.")
                .font(.pilot(.caption))
                .foregroundStyle(Theme.mutedForeground)
                .fixedSize(horizontal: false, vertical: true)
            TextField("#123 or a pull request link", text: $draft.text)
                .textFieldStyle(.roundedBorder)
                .focused($focused)
                .onSubmit(attach)
                .onChange(of: draft.text) { draft.error = nil }
            if let error = draft.error {
                Text(error)
                    .font(.pilot(.caption))
                    .foregroundStyle(Theme.destructive)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            } else if let hint = draft.hint(for: current) {
                Text(hint)
                    .font(.pilot(.caption))
                    .foregroundStyle(Theme.mutedForeground)
                    .fixedSize(horizontal: false, vertical: true)
            } else if let owner {
                Label("Moves from “\(owner.title)”", icon: PilotIcon.steer)
                    .font(.pilot(.caption))
                    .foregroundStyle(Theme.mutedForeground)
                    .lineLimit(2)
                    .help("That chat stops tracking it and gets no more follow-ups for it.")
            }
            if !suggestions.isEmpty { suggestionList(suggestions) }
            if let mission { taskPicker(mission, sessionId: current.id) }
            HStack(spacing: 8) {
                if draft.busy { ProgressView().controlSize(.small) }
                Spacer()
                Button("Cancel", action: dismiss).keyboardShortcut(.cancelAction)
                Button(owner == nil ? "Attach" : "Move Here", action: attach)
                    .keyboardShortcut(.defaultAction)
                    .disabled(!draft.canSubmit(for: current))
            }
        }
        .padding(14)
        .frame(width: 360)
        .onAppear { focused = true }
        .task(id: current.missionId) { await loadMission(current.missionId) }
    }

    private func suggestionList(_ suggestions: [PullRequestAttachment.Suggestion]) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("Open in other chats")
                .font(.pilot(.small, weight: .medium))
                .foregroundStyle(Theme.faintForeground)
                .padding(.top, 2)
            ForEach(suggestions) { suggestion in
                let pr = suggestion.pullRequest
                Button { draft.text = pr.url } label: {
                    HoverRow(horizontalPadding: 6, verticalPadding: 4) { _ in
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            pr.state.icon.foregroundStyle(pr.state.color)
                            Text("#\(String(pr.number))")
                                .font(.pilot(.caption, weight: .semibold))
                                .monospacedDigit()
                                .foregroundStyle(Theme.foreground)
                            Text(pr.title)
                                .font(.pilot(.caption))
                                .foregroundStyle(Theme.foreground)
                                .lineLimit(1)
                                .truncationMode(.tail)
                            Spacer(minLength: 6)
                            Text(suggestion.sessionTitle)
                                .font(.pilot(.caption))
                                .foregroundStyle(Theme.faintForeground)
                                .lineLimit(1)
                                .truncationMode(.tail)
                                .frame(maxWidth: 120, alignment: .trailing)
                        }
                    }
                }
                .rowButtonStyle()
                .help("\(pr.label): \(pr.title)\nIn “\(suggestion.sessionTitle)”")
                .accessibilityLabel("Pull request \(pr.number), \(pr.title), in \(suggestion.sessionTitle)")
            }
        }
    }

    @ViewBuilder private func taskPicker(_ mission: MissionDetail, sessionId: String) -> some View {
        let choices = PullRequestAttachment.taskChoices(for: sessionId, in: mission)
        if !choices.isEmpty {
            Picker("Link to task", selection: $draft.taskId) {
                if PullRequestAttachment.allowsNoTask(for: sessionId, in: mission) {
                    Text("No task").tag(String?.none)
                }
                ForEach(choices) { task in
                    Text("#\(task.number) \(task.title)").tag(Optional(task.id))
                }
            }
            .pickerStyle(.menu)
            .font(.pilot(.label))
            .help("The mission task this pull request is linked to. Detaching it later removes the link.")
        }
    }

    private func loadMission(_ missionId: String?) async {
        guard let missionId, mission?.mission.id != missionId else { return }
        let detail: MissionDetail?
        if let cached = client.missionDetails[missionId] { detail = cached }
        else { detail = try? await client.missionDetail(missionId) }
        guard let detail, !Task.isCancelled else { return }
        mission = detail
        if draft.taskId == nil { draft.taskId = PullRequestAttachment.defaultTask(for: session.id, in: detail) }
    }

    private func attach() {
        let current = current
        guard draft.canSubmit(for: current), let url = draft.url else { return }
        draft.busy = true
        draft.error = nil
        let taskId = mission == nil ? nil : draft.taskId
        Task { @MainActor in
            do {
                try await client.bindPullRequest(current.id, url: url, taskId: taskId)
                draft = PullRequestAttachDraft()
                dismiss()
            } catch {
                draft.busy = false
                draft.error = error.localizedDescription
            }
        }
    }
}

/// A PR state and number, tinted by state, opening the PR in the browser.
private struct PullRequestPill: View {
    let pullRequest: SessionPullRequest
    let stale: Bool

    var body: some View {
        if let url = pullRequest.browserURL {
            Link(destination: url) { pill }
                .buttonStyle(.plain)
                .help("\(stale ? "Last known: " : "")\(pullRequest.label)\n\(pullRequest.url)")
        } else {
            pill.help("Invalid pull request link. Cannot open in browser.")
        }
    }

    private var pill: some View {
        let pr = pullRequest
        return HStack(spacing: 3) {
            pr.state.icon
            Text("\(pr.state.compactLabel) #\(String(pr.number))")
            if stale || pr.browserURL == nil {
                PilotSymbol(PilotIcon.warning)
            } else {
                PilotSymbol(PilotIcon.openExternal)
            }
        }
        .font(.pilot(.small, weight: .semibold))
        .foregroundStyle(pr.state.color)
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .background(Capsule().fill(pr.state.color.opacity(0.1)))
        .fixedSize()
        .accessibilityLabel("Pull request \(pr.number), \(stale ? "last known " : "")\(pr.state.label)\(pr.browserURL == nil ? ", invalid link" : "")")
    }
}

private struct FileRow: View {
    let file: ChangedFile
    let expanded: Bool
    let toggle: () -> Void

    var body: some View {
        Button(action: toggle) {
            HStack(spacing: 8) {
                DisclosureChevron(expanded: expanded)
                Text(letter)
                    .font(.pilot(.small, weight: .bold, design: .monospaced))
                    .foregroundStyle(color)
                    .frame(width: 14)
                HStack(spacing: 0) {
                    Text(directory).foregroundStyle(Theme.mutedForeground)
                    Text(name).foregroundStyle(Theme.foreground)
                }
                .font(.pilot(.label))
                .lineLimit(1)
                .truncationMode(.head)
                Spacer(minLength: 6)
                DiffStat(additions: file.additions, deletions: file.deletions)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(file.previousPath.map { "\($0) → \(file.path)" } ?? file.path)
    }

    private var name: String { URL(filePath: file.path).lastPathComponent }
    private var directory: String {
        let dir = (file.path as NSString).deletingLastPathComponent
        return dir.isEmpty ? "" : dir + "/"
    }

    private var letter: String {
        switch file.status {
        case "added": "A"
        case "deleted": "D"
        case "renamed": "R"
        case "untracked": "U"
        default: "M"
        }
    }

    private var color: Color {
        switch file.status {
        case "added", "untracked": Theme.success
        case "deleted": Theme.destructive
        // Modified and renamed files are the normal case, so they stay muted; colour marks added and deleted.
        default: Theme.mutedForeground
        }
    }
}
