import Combine
import PilotCore
import SwiftUI

/// The Inbox, the one place to act: what waits on the user across every project, most urgent first. Chats and
/// missions that need the user, pull requests ready to merge, my open Linear tickets and open Slack messages
/// outside hidden labels. A toolbar menu filters it to one project; it is preset to the focused project when the
/// Inbox opens and never saved. Rows keep their usual actions and name their project when listing every project.
struct InboxPage: View {
    @EnvironmentObject private var model: AppModel
    @EndpointClient private var client
    @ObservedObject private var hosts = AppModel.shared.hosts
    @StateObject private var inbox = InboxModel()
    @StateObject private var actions = TrackedItemActions()

    var body: some View {
        let scope = client.project(model.inboxProjectId)
        Group {
            if model.inboxHost == nil, model.inboxProjectId == nil, !hosts.offlineHosts.isEmpty {
                UnifiedInboxContent(hosts: hosts)
            } else { content(scope: scope) }
        }
            .navigationTitle("Inbox")
            .navigationSubtitle(InboxText.filterTitle(scope))
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    InboxProjectFilter(selection: $model.inboxProjectId, projects: client.projects, scope: scope)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Theme.background)
            .onAppear { inbox.start(client: client, projectId: scope?.id) }
            .onChange(of: scope?.id) { _, id in inbox.start(client: client, projectId: id) }
            .onChange(of: client.connectionGeneration) { _, _ in inbox.start(client: client, projectId: scope?.id) }
            .onDisappear { inbox.stop() }
    }

    @ViewBuilder private func content(scope: Project?) -> some View {
        if let value = inbox.inbox {
            ScrollView {
                TimelineView(.periodic(from: .now, by: 60)) { context in
                    InboxSections(inbox: value, scope: scope, actions: actions, error: inbox.error,
                                  now: context.date, reload: { inbox.reload() })
                        .padding(.horizontal, 32)
                        .padding(.vertical, 24)
                        .frame(maxWidth: Theme.column, alignment: .leading)
                        .frame(maxWidth: .infinity)
                        .keyboardList()
                }
            }
        } else if let error = inbox.error {
            EmptyStateView(icon: PilotIcon.warning, title: "Couldn't load the Inbox", message: error) {
                Button("Retry") { inbox.reload() }
            }
        } else {
            ProgressView("Loading inbox…")
        }
    }
}

/// "All projects" or one project, in sidebar order. Picking one reloads the Inbox for it.
private struct InboxProjectFilter: View {
    @Binding var selection: String?
    let projects: [Project]
    let scope: Project?

    var body: some View {
        Menu {
            Picker("Project", selection: $selection) {
                Text("All projects").tag(String?.none)
                if !projects.isEmpty { Divider() }
                ForEach(projects) { project in
                    Text(project.name).tag(Optional(project.id))
                }
            }
            .pickerStyle(.inline)
            .labelsHidden()
        } label: {
            Label(InboxText.filterTitle(scope), icon: PilotIcon.filter)
                .labelStyle(.titleAndIcon)
        }
        .menuIndicator(.visible)
        .fixedSize()
        .help("Show what waits on you in every project or in one")
        .accessibilityLabel("Project filter, \(InboxText.filterTitle(scope))")
    }
}

/// The populated page: Needs you and Ready to merge, then Linear and Slack when a project in scope tracks them.
private struct InboxSections: View {
    @EndpointClient private var endpoint
    let inbox: Inbox
    let scope: Project?
    @ObservedObject var actions: TrackedItemActions
    let error: String?
    let now: Date
    let reload: () -> Void
    @EnvironmentObject private var model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 28) {
            if let error {
                ProjectRefreshBanner(receivedAt: nil, error: error, retrying: false, retry: reload)
            }
            if inbox.isEmpty {
                InboxClearState(message: InboxText.clearMessage(projectName: scope?.name))
            } else {
                needsYou
                if inbox.readyToMerge.total > 0 { readyToMerge }
                if let linear = inbox.linear {
                    trackedSection(title: "Linear", kind: .linear, items: linear.items, total: linear.total,
                                   empty: "No open tickets are assigned to you.")
                }
                if let slack = inbox.slack {
                    trackedSection(title: "Slack", kind: .slack, items: slack.items, total: slack.total,
                                   empty: "No open Slack messages.", triage: triageProjects)
                }
            }
            if let hidden = InboxText.hiddenFooter(inbox.slack?.hidden ?? []) {
                Text(hidden).font(.pilot(.caption)).foregroundStyle(Theme.faintForeground)
                    .padding(.horizontal, 8)
                    .help("Labels marked Hide from Inbox in Linear and Slack settings")
            }
        }
    }

    private var needsYou: some View {
        let section = inbox.needsYou
        return VStack(alignment: .leading, spacing: 6) {
            PageSectionHeader(title: "Needs you", count: section.total, countStyle: .attention)
            if section.items.isEmpty {
                HStack(spacing: 8) {
                    PilotSymbol(PilotIcon.complete).foregroundStyle(Theme.success).frame(width: 16)
                    Text("Nothing is waiting on you.").foregroundStyle(Theme.mutedForeground)
                }
                .font(.pilot(.body))
                .padding(.horizontal, 8).padding(.vertical, 4)
            }
            ForEach(Array(section.items.enumerated()), id: \.element.id) { index, row in
                if index > 0 { HairlineDivider(leading: InboxRowLayout.dividerInset) }
                ProjectNeedsYouRow(item: row.item, now: now, context: projectName(row.projectId))
                    .inboxCorner(row.item.signal)
            }
            capNote(shown: section.items.count, total: section.total)
        }
    }

    /// Pull requests whose chats are done and that GitHub reports ready. Counted in the header, never badged.
    private var readyToMerge: some View {
        let section = inbox.readyToMerge
        return VStack(alignment: .leading, spacing: 6) {
            PageSectionHeader(title: "Ready to merge", count: section.total)
            ForEach(Array(section.items.enumerated()), id: \.element.id) { index, row in
                if index > 0 { HairlineDivider(leading: InboxRowLayout.dividerInset) }
                InboxReadyToMergeRow(pr: row.pullRequest, context: projectName(row.projectId))
                    .inboxCorner(.readyToMerge)
            }
            capNote(shown: section.items.count, total: section.total)
        }
    }

    private func trackedSection(title: String, kind: TrackedKind, items: [TrackedItem], total: Int,
                                empty: String, triage: [Project] = []) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            triageHeader(title: title, total: total, projects: triage)
            if let source = signInSource(kind) {
                TrackedSourceStatusLine(source: source, actions: actions, now: now)
            }
            if items.isEmpty {
                Text(empty).font(.pilot(.body)).foregroundStyle(Theme.mutedForeground)
                    .padding(.horizontal, 8).padding(.vertical, 4)
            }
            // Linear sub-issues follow their parent. Slack rows have none, so they stay in order.
            LinearIssueTreeRows(groups: LinearIssueTree.build(items)) { item, subIssues in
                TrackedItemRow(item: item, actions: actions, now: now, context: projectName(item.projectId),
                               subIssues: subIssues, changed: reload)
                    .inboxCorner(model.trackedItemSignal(item),
                                 background: model.trackedItemSession(item)?.isWaitingOnJobs == true)
            }
            capNote(shown: items.count, total: total)
        }
    }

    /// "Open triage" opens the one project's Slack triage, or a menu of projects when several track Slack.
    private func triageHeader(title: String, total: Int, projects: [Project]) -> some View {
        let open = { (id: String) in model.openSlackTriage(id) }
        return PageSectionHeader(
            title: title, count: total, linkTitle: projects.isEmpty ? nil : "Open triage",
            link: projects.count == 1 ? { open(projects[0].id) } : nil,
            linkChoices: projects.count < 2 ? [] : projects.map { project in
                PageSectionLinkChoice(id: project.id, title: project.name) { open(project.id) }
            }
        )
    }

    @ViewBuilder private func capNote(shown: Int, total: Int) -> some View {
        if let note = InboxText.capNote(shown: shown, total: total) {
            Text(note).font(.pilot(.caption)).foregroundStyle(Theme.faintForeground).padding(.leading, 34)
        }
    }

    /// Rows name their project only when the Inbox lists every project.
    private func projectName(_ id: String) -> String? {
        scope == nil ? endpoint.project(id)?.name : nil
    }

    /// Slack triage is per project: every project in scope that tracks Slack, in sidebar order.
    private var triageProjects: [Project] {
        InboxText.triageProjects(endpoint.projects, sources: endpoint.trackingSources, scope: scope?.id)
    }

    /// Sign-in is shared by every project, so one line per source kind is enough.
    private func signInSource(_ kind: TrackedKind) -> TrackingSource? {
        endpoint.trackingSources.first {
            $0.kind == kind && $0.configured && $0.status == .signInRequired && (scope == nil || $0.projectId == scope?.id)
        }
    }
}

/// Loads the Inbox for a scope and reloads, coalesced, when counts or tracked items change. No polling.
@MainActor
final class InboxModel: ObservableObject {
    @Published private(set) var inbox: Inbox?
    @Published private(set) var error: String?
    private(set) var projectId: String?
    private weak var client: PilotClient?
    private var observer: UUID?
    private var counts: AnyCancellable?
    private var readyPullRequests: AnyCancellable?
    private var pending: Task<Void, Never>?

    /// Starts watching, or switches scope. Rows already shown stay until the new scope arrives.
    func start(client: PilotClient, projectId: String?) {
        let changed = self.client !== client || projectId != self.projectId
        if self.client !== client { stop() }
        self.client = client
        self.projectId = projectId
        if observer == nil {
            observer = client.observeTrackedItems { [weak self] id in
                guard let self, self.projectId == nil || self.projectId == id else { return }
                self.reload(after: .milliseconds(300))
            }
        }
        if counts == nil {
            // Needs-you and tracked counts move whenever a row joins or leaves the Inbox.
            counts = client.$projectCounts.dropFirst().removeDuplicates().sink { [weak self] _ in
                self?.reload(after: .milliseconds(300))
            }
        }
        if readyPullRequests == nil {
            // Ready to merge is never counted, so watch the chats' ready PRs themselves.
            readyPullRequests = client.$sessions.map(InboxText.readyToMergeKey).removeDuplicates().dropFirst()
                .sink { [weak self] _ in self?.reload(after: .milliseconds(300)) }
        }
        if changed || inbox == nil { reload() }
    }

    func stop() {
        if let observer { client?.stopObservingTrackedItems(observer) }
        observer = nil
        counts = nil
        readyPullRequests = nil
        pending?.cancel()
    }

    /// Latest wins.
    func reload(after delay: Duration = .zero) {
        pending?.cancel()
        pending = Task { [weak self] in
            if delay > .zero { try? await Task.sleep(for: delay) }
            guard !Task.isCancelled, let self, let client = self.client else { return }
            let scope = self.projectId
            do {
                let next = try await client.inbox(projectId: scope)
                guard !Task.isCancelled, scope == self.projectId else { return }
                if self.inbox != next { self.inbox = next }
                self.error = nil
            } catch {
                guard !Task.isCancelled else { return }
                self.error = error.localizedDescription
            }
        }
    }
}

/// An empty Inbox: a wide dithered coast (`DitherScene`) dissolving into the page, with one quiet sentence at
/// its foot.
private struct InboxClearState: View {
    let message: String

    var body: some View {
        VStack(spacing: 6) {
            DitherScene()
                .frame(height: 260)
                .frame(maxWidth: .infinity)
                .clipShape(UnevenRoundedRectangle(topLeadingRadius: Theme.Radius.card, topTrailingRadius: Theme.Radius.card))
            Text("Nothing is waiting on you").font(.pilot(.headline, weight: .semibold))
                .foregroundStyle(Theme.foreground)
                .padding(.top, -28)
                .shadow(color: Theme.halo, radius: 6)
                .shadow(color: Theme.halo, radius: 14)
            Text(message).font(.pilot(.label)).foregroundStyle(Theme.mutedForeground)
                .multilineTextAlignment(.center).frame(maxWidth: 340)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .combine)
    }
}
