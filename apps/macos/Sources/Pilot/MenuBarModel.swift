import Combine
import Foundation
import PilotCore

/// The label only changes when activity crosses the idle/working boundary. Observing
/// PilotClient directly would invalidate it for every project, artifact and session update.
@MainActor
final class MenuBarIconModel: ObservableObject {
    @Published private(set) var isWorking: Bool
    private var observation: AnyCancellable?

    init(client: PilotClient) {
        isWorking = client.workingCount > 0
        observation = client.$sessions
            .map { $0.unarchivedSessions.contains(where: \.isWorking) }
            // One session update can remove, append and sort synchronously. Do not
            // expose its transient empty list as an idle/working icon flip.
            .debounce(for: .zero, scheduler: DispatchQueue.main)
            .removeDuplicates()
            .sink { [weak self] value in
                guard let self, self.isWorking != value else { return }
                self.isWorking = value
            }
    }
}

struct MenuBarSessionRow: Identifiable, Equatable {
    let session: SessionSummary
    let isUnread: Bool
    var id: String { session.id }

    static func == (lhs: Self, rhs: Self) -> Bool {
        // Include every field rendered by the row and PullRequestBadge, but ignore
        // transcript/usage/workspace metadata that does not appear in this menu.
        lhs.id == rhs.id && lhs.session.title == rhs.session.title
            && lhs.session.status == rhs.session.status && lhs.isUnread == rhs.isUnread
            && lhs.session.pullRequest == rhs.session.pullRequest
            && lhs.session.pullRequestError == rhs.session.pullRequestError
    }
}

struct MenuBarSnapshot: Equatable {
    let rows: [MenuBarSessionRow]
    let statusText: String
    let lifecycleBusy: Bool
    let waitingToInstall: Bool

    @MainActor
    init(sessions: [SessionSummary], isUnread: (SessionSummary) -> Bool,
         status: DaemonController.Status, lifecycleBusy: Bool, waitingToInstall: Bool) {
        let active = sessions.unarchivedSessions
        rows = active.prefix(8).map { MenuBarSessionRow(session: $0, isUnread: isUnread($0)) }
        self.lifecycleBusy = lifecycleBusy
        self.waitingToInstall = waitingToInstall
        switch status {
        case .running:
            let working = active.filter(\.isWorking).count
            let unread = active.filter(isUnread).count
            var activity: [String] = []
            if working > 0 { activity.append("\(working) working") }
            if unread > 0 { activity.append("\(unread) unread") }
            statusText = "pilotd running · \(activity.isEmpty ? "idle" : activity.joined(separator: " · "))"
        case .starting, .unknown: statusText = "pilotd starting…"
        case .stopped: statusText = "pilotd stopped"
        case .failed: statusText = "pilotd failed"
        }
    }
}

/// Coalesce synchronous mutations into one visible snapshot, and leave the source
/// publisher's update stack before notifying SwiftUI's native menu host.
@MainActor
final class MenuBarModel: ObservableObject {
    @Published private(set) var snapshot: MenuBarSnapshot
    private var observation: AnyCancellable?

    init(model: AppModel, updater: AppUpdater) {
        snapshot = MenuBarSnapshot(sessions: model.client.sessions, isUnread: model.isUnread,
                                   status: model.daemon.status, lifecycleBusy: model.daemon.lifecycleBusy,
                                   waitingToInstall: updater.waitingToInstall)
        observation = Publishers.CombineLatest4(model.client.$sessions, model.$reviewRevision,
                                                 model.daemon.$status, model.daemon.$lifecycleBusy)
            .combineLatest(updater.$waitingToInstall)
            .map { values, waiting in
                // @Published delivers before storing the new value. Use the emitted
                // sessions/status, rather than rereading potentially stale properties.
                MenuBarSnapshot(sessions: values.0, isUnread: model.isUnread,
                                status: values.2, lifecycleBusy: values.3, waitingToInstall: waiting)
            }
            .debounce(for: .zero, scheduler: DispatchQueue.main)
            .removeDuplicates()
            .sink { [weak self] value in
                guard let self, self.snapshot != value else { return }
                self.snapshot = value
            }
    }
}
