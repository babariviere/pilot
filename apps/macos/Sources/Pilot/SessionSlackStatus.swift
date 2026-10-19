import PilotCore
import SwiftUI

// A chat started from a Slack message sets that message's triage status from its own toolbar, so finishing or
// parking the work never needs a trip to Slack triage. The agent can only move it between In progress and
// Waiting (slack_status); every status stays the user's here, as in triage.

/// The Slack messages whose latest chat is this one. Loaded while the chat is on screen and reloaded when the
/// project's tracked items change. Publishes only real changes, so the chat page rarely re-renders for it.
@MainActor
final class SessionSlackLinks: ObservableObject {
    /// What a chat page loads for; a change reloads.
    struct Key: Hashable {
        let client: ObjectIdentifier
        let sessionId: String
        let projectId: String?
    }

    @Published private(set) var items: [TrackedItem] = []

    /// The open chat's links, for the command palette's chat actions. One chat page shows at a time.
    private(set) static weak var onScreen: SessionSlackLinks?

    private(set) var sessionId: String?
    private var projectId: String?
    private weak var client: PilotClient?
    private var observer: UUID?
    private var loading: Task<Void, Never>?
    private var reloadAgain = false
    /// Statuses set here and not yet confirmed by pilotd, so a reload in between never shows the old one.
    private var pending: [String: SlackLocalStatus] = [:]

    func attach(client: PilotClient, sessionId: String, projectId: String?) {
        if self.client === client, self.sessionId == sessionId, self.projectId == projectId {
            Self.onScreen = self
            return
        }
        detach()
        Self.onScreen = self
        self.client = client
        self.sessionId = sessionId
        self.projectId = projectId
        guard projectId != nil else { return }
        observer = client.observeTrackedItems { [weak self] changed in
            guard let self, changed == self.projectId else { return }
            self.reload()
        }
        reload()
    }

    func detach() {
        if let observer, let client { client.stopObservingTrackedItems(observer) }
        observer = nil
        loading?.cancel()
        loading = nil
        reloadAgain = false
        pending = [:]
        client = nil
        sessionId = nil
        projectId = nil
        if Self.onScreen === self { Self.onScreen = nil }
        if !items.isEmpty { items = [] }
    }

    /// One load at a time; a change during a load runs it once more.
    private func reload() {
        guard loading == nil else {
            reloadAgain = true
            return
        }
        guard let client, let sessionId, let projectId else { return }
        loading = Task { [weak self] in
            let list = try? await client.trackedItems(projectId: projectId, kind: .slack, limit: 10, sessionId: sessionId)
            guard let self, !Task.isCancelled else { return }
            loading = nil
            if let list {
                let pending = self.pending
                let next = list.items.map { item in pending[item.id].map { Self.applying($0, to: item) } ?? item }
                if next != items { items = next }
            }
            if reloadAgain {
                reloadAgain = false
                reload()
            }
        }
    }

    /// Shows the new status at once, then asks pilotd. A failure reloads from pilotd and says why.
    func set(_ status: SlackLocalStatus, on item: TrackedItem, model: AppModel) {
        guard let client, SlackTriageText.triage(item).status != status else { return }
        pending[item.id] = status
        items = items.map { $0.id == item.id ? Self.applying(status, to: $0) : $0 }
        Task { [weak self] in
            do {
                let updated = try await client.updateTrackedItem(item.id, TrackedItemPatch(slack: SlackOverrides(status: status)))
                guard let self, self.client === client else { return }
                if pending[item.id] == status { pending[item.id] = nil }
                let next = items.map { $0.id == updated.id ? updated : $0 }
                if next != items { items = next }
            } catch {
                guard let self, self.client === client else { return }
                if pending[item.id] == status { pending[item.id] = nil }
                model.sessionActionError = "Couldn't mark the Slack message as \(status.title.lowercased()): \(error.localizedDescription)"
                reload()
            }
        }
    }

    static func applying(_ status: SlackLocalStatus, to item: TrackedItem) -> TrackedItem {
        let triage = SlackTriageText.applying(SlackOverrides(status: status), to: SlackTriageText.triage(item))
        return TrackedItem(id: item.id, projectId: item.projectId, kind: item.kind, externalId: item.externalId,
                           title: item.title, url: item.url, status: item.status, metadata: item.metadata,
                           dismissed: status == .dismissed, sessionId: item.sessionId, missionId: item.missionId,
                           sessionIds: item.sessionIds, missionIds: item.missionIds, slack: triage,
                           linearParent: item.linearParent, linearSize: item.linearSize,
                           linearSizeOverride: item.linearSizeOverride, caseId: item.caseId,
                           createdAt: item.createdAt, updatedAt: item.updatedAt)
    }
}

enum SessionSlackText {
    /// The statuses a chat offers: In progress, Waiting and Done. Reopening or dismissing a message belongs to
    /// triage; a message already Open or Dismissed still shows its status.
    static func choices(current: SlackLocalStatus) -> [SlackLocalStatus] {
        SlackLocalStatus.ordered.filter { [.inProgress, .waiting, .done].contains($0) || $0 == current }
    }

    /// "Slack message “Login fails”: Waiting · CSM to confirm" for the toolbar's help and accessibility.
    static func help(_ items: [TrackedItem]) -> String {
        guard items.count == 1, let item = items.first else { return "\(items.count) Slack messages" }
        return "Slack message “\(item.title)”: \(SlackTriageText.statusTitle(SlackTriageText.triage(item)))"
    }

    /// The toolbar's short status: the message's, or Mixed across several.
    static func label(_ items: [TrackedItem]) -> String {
        let statuses = Set(items.map { SlackTriageText.triage($0).status })
        return statuses.count == 1 ? statuses.first!.title : "Mixed"
    }
}

/// The toolbar's Slack menu: each linked message's status and Open in Slack, then Slack triage.
struct SessionSlackMenu: View {
    @ObservedObject var links: SessionSlackLinks
    let context: HostViewContext?
    @EnvironmentObject private var model: AppModel

    var body: some View {
        Menu {
            ForEach(links.items) { item in
                let triage = SlackTriageText.triage(item)
                Section(links.items.count == 1 ? "Slack message" : item.title) {
                    Picker("Status", selection: Binding(get: { triage.status },
                                                        set: { links.set($0, on: item, model: model) })) {
                        ForEach(SessionSlackText.choices(current: triage.status), id: \.self) { status in
                            Text(status == triage.status ? SlackTriageText.statusTitle(triage) : status.title).tag(status)
                        }
                    }
                    .pickerStyle(.inline)
                    if let url = trackedBrowserURL(item.url) {
                        Button { BrowserLinkOpener.shared.open(url) } label: {
                            Label("Open in Slack", icon: PilotIcon.openExternal)
                        }
                    }
                }
            }
            if let projectId = links.items.first?.projectId {
                Divider()
                Button { model.openSlackTriage(projectId, context: context) } label: {
                    Label("Open Slack triage", icon: PilotIcon.slackChannel)
                }
            }
        } label: {
            HStack(spacing: 5) {
                PilotMarkIcon(mark: .slack, context: .toolbar)
                Text(SessionSlackText.label(links.items)).font(.pilot(.label))
            }
        }
        .menuIndicator(.hidden)
        .help(SessionSlackText.help(links.items))
        .accessibilityLabel(SessionSlackText.help(links.items))
    }
}
