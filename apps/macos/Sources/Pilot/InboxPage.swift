import Combine
import PilotCore
import SwiftUI

/// The Inbox: what waits on the user in the sidebar's scope (every project, or the focused one). Chats and
/// missions that need the user, my open Linear tickets and open Slack messages outside hidden labels. Rows
/// are the project page's rows with their usual actions, plus the project name when listing every project.
struct InboxPage: View {
    @EnvironmentObject private var model: AppModel
    @ObservedObject private var client = AppModel.shared.client
    @StateObject private var inbox = InboxModel()
    @StateObject private var actions = TrackedItemActions()

    var body: some View {
        let scope = model.focusedProject
        content(scope: scope)
            .navigationTitle("Inbox")
            .navigationSubtitle(scope?.name ?? "All projects")
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Theme.background)
            .onAppear { inbox.start(client: client, projectId: scope?.id) }
            .onChange(of: scope?.id) { _, id in inbox.start(client: client, projectId: id) }
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
                }
            }
        } else if let error = inbox.error {
            EmptyStateView(icon: "exclamationmark.triangle", title: "Couldn't load the Inbox", message: error) {
                Button("Retry") { inbox.reload() }
            }
        } else {
            ProgressView("Loading inbox…")
        }
    }
}

/// The populated page: Needs you, then Linear and Slack when a project in scope tracks them.
private struct InboxSections: View {
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
                InboxClearState(message: scope.map { "Chats that need you, your open tickets and Slack messages in \($0.name) appear here." }
                    ?? "Chats that need you, your open tickets and Slack messages from every project appear here.")
            } else {
                needsYou
                if let linear = inbox.linear {
                    trackedSection(title: "Linear", kind: .linear, items: linear.items, total: linear.total,
                                   empty: "No open tickets are assigned to you.")
                }
                if let slack = inbox.slack {
                    trackedSection(title: "Slack", kind: .slack, items: slack.items, total: slack.total,
                                   empty: "No open Slack messages.", triage: triageProjectId)
                }
            }
            if let hidden = InboxText.hiddenFooter(inbox.slack?.hidden ?? []) {
                Text(hidden).font(.pilot(.caption)).foregroundStyle(Theme.faintForeground)
                    .padding(.horizontal, 8)
                    .help("Labels marked Hide from Inbox in Tracking settings")
            }
        }
    }

    private var needsYou: some View {
        let section = inbox.needsYou
        return VStack(alignment: .leading, spacing: 6) {
            PageSectionHeader(title: "Needs you", count: section.total, countStyle: .attention)
            if section.items.isEmpty {
                HStack(spacing: 8) {
                    Image(systemName: "checkmark.circle").foregroundStyle(Theme.success).frame(width: 16)
                    Text("Nothing is waiting on you.").foregroundStyle(Theme.mutedForeground)
                }
                .font(.pilot(.body))
                .padding(.horizontal, 8).padding(.vertical, 4)
            }
            ForEach(Array(section.items.enumerated()), id: \.element.id) { index, row in
                if index > 0 { HairlineDivider(leading: 34) }
                ProjectNeedsYouRow(item: row.item, now: now, context: projectName(row.projectId))
                    .inboxCorner(row.item.signal)
            }
            capNote(shown: section.items.count, total: section.total)
        }
    }

    private func trackedSection(title: String, kind: TrackedKind, items: [TrackedItem], total: Int,
                                empty: String, triage: String? = nil) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            PageSectionHeader(title: title, count: total, linkTitle: triage == nil ? nil : "Open triage",
                              link: triage.map { id -> () -> Void in { model.openSlackTriage(id) } })
            if let source = signInSource(kind) {
                TrackedSourceStatusLine(source: source, actions: actions, now: now)
            }
            if items.isEmpty {
                Text(empty).font(.pilot(.body)).foregroundStyle(Theme.mutedForeground)
                    .padding(.horizontal, 8).padding(.vertical, 4)
            }
            ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                if index > 0 { HairlineDivider(leading: 34) }
                TrackedItemRow(item: item, actions: actions, now: now, context: projectName(item.projectId),
                               changed: reload)
                    .inboxCorner(linkedSignal(item))
            }
            capNote(shown: items.count, total: total)
        }
    }

    @ViewBuilder private func capNote(shown: Int, total: Int) -> some View {
        if let note = InboxText.capNote(shown: shown, total: total) {
            Text(note).font(.pilot(.caption)).foregroundStyle(Theme.faintForeground).padding(.leading, 34)
        }
    }

    /// Rows name their project only when the Inbox lists every project.
    private func projectName(_ id: String) -> String? {
        scope == nil ? model.client.project(id)?.name : nil
    }

    /// A ticket's corner follows the latest chat it started (working, failed, unread, ready to merge), like that
    /// chat's sidebar row. Tickets nothing has started yet stay quiet.
    private func linkedSignal(_ item: TrackedItem) -> SessionSignal? {
        guard let session = item.sessionId.flatMap({ model.client.session($0) }) else { return nil }
        return session.signal(unread: model.isUnread(session))
    }

    /// Slack triage is per project: offered when the scope has exactly one project tracking Slack.
    private var triageProjectId: String? {
        let projects = Set(model.client.trackingSources.filter {
            $0.kind == .slack && $0.configured && (scope == nil || $0.projectId == scope?.id)
        }.map(\.projectId))
        return projects.count == 1 ? projects.first : nil
    }

    /// Sign-in is shared by every project, so one line per source kind is enough.
    private func signInSource(_ kind: TrackedKind) -> TrackingSource? {
        model.client.trackingSources.first {
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
    private var pending: Task<Void, Never>?

    /// Starts watching, or switches scope. Rows already shown stay until the new scope arrives.
    func start(client: PilotClient, projectId: String?) {
        let changed = self.client !== client || projectId != self.projectId
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
        if changed || inbox == nil { reload() }
    }

    func stop() {
        if let observer { client?.stopObservingTrackedItems(observer) }
        observer = nil
        counts = nil
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

private extension View {
    /// The sidebar's dithered status corner on an Inbox row. The same trailing room on every row keeps actions
    /// aligned and off the corner's densest cells, so they stay readable and a state change never shifts them.
    func inboxCorner(_ signal: SessionSignal?) -> some View {
        padding(.trailing, 24).ditherCorner(signal)
    }
}

/// An empty Inbox: a short band of the Home sky, dissolving into the page, above one quiet sentence.
private struct InboxClearState: View {
    let message: String

    var body: some View {
        VStack(spacing: 6) {
            DitherSky(fade: 0.6)
                .frame(height: 96)
                .frame(maxWidth: 440)
                .clipShape(RoundedRectangle(cornerRadius: Theme.radius))
            Text("Nothing is waiting on you").font(.pilot(.body, weight: .semibold)).foregroundStyle(Theme.foreground)
            Text(message).font(.pilot(.label)).foregroundStyle(Theme.mutedForeground)
                .multilineTextAlignment(.center).frame(maxWidth: 320)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 12)
        .accessibilityElement(children: .combine)
    }
}
