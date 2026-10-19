import Combine
import Foundation
import PilotCore

/// One chat in the menu bar: its title, status icon and the urgency group it sits in.
struct MenuBarSessionRow: Identifiable, Equatable {
    let session: SessionSummary
    var reference: HostResourceRef? = nil
    var available = true
    /// The sidebar state the row is grouped by, for help and VoiceOver. nil for quiet chats.
    let signal: SessionSignal?
    var id: String { reference?.storageKey ?? session.id }

    static func == (lhs: Self, rhs: Self) -> Bool {
        // Include every field the row renders, but ignore transcript, usage, PR and workspace metadata that does not
        // appear in this menu.
        lhs.id == rhs.id && lhs.session.title == rhs.session.title
            && lhs.session.status == rhs.session.status && lhs.signal == rhs.signal && lhs.available == rhs.available
    }

    /// "Fix login, Needs you", or the agent status for quiet chats.
    var accessibilityLabel: String {
        "\(session.title), \(available ? signal?.label ?? session.status.rawValue : "Disconnected. Current state unknown.")"
    }
}

/// One urgency group of the menu, titled like the sidebar's.
struct MenuBarSection: Identifiable, Equatable {
    let title: String
    let rows: [MenuBarSessionRow]
    var id: String { title }
}

struct MenuBarSnapshot: Equatable {
    /// Chats in the sidebar's urgency order (Needs you, Ready to merge, Working, Recent), at most `limit` in all.
    let sections: [MenuBarSection]
    /// "1 needs you · 2 working", or the daemon's state while it is not running.
    let statusText: String
    /// pilotd's state, at the top of its submenu.
    let daemonText: String
    let lifecycleBusy: Bool
    let waitingToInstall: Bool

    static let limit = 8

    var rows: [MenuBarSessionRow] { sections.flatMap(\.rows) }

    @MainActor
    init(sessions: [SessionSummary], isUnread: (SessionSummary) -> Bool,
         status: DaemonController.Status, lifecycleBusy: Bool, waitingToInstall: Bool,
         hosted: [Hosted<SessionSummary>] = [], availableHosts: Set<HostRef> = [],
         isUnreadHost: ((Hosted<SessionSummary>) -> Bool)? = nil) {
        // Sessions arrive in list order. Like pilotd's counts, pinned chats count by their state.
        let groups = SidebarUrgency.groups(sessions.unarchivedSessions, unread: isUnread, separatingPinned: false)
        var remaining = Self.limit
        var sections: [MenuBarSection] = []
        for (title, chats) in [("Needs you", groups.needsYou), ("Ready to merge", groups.readyToMerge),
                               ("Working", groups.working), ("Recent", groups.recent)] {
            guard remaining > 0 else { continue }
            var rows = chats.prefix(remaining).map { MenuBarSessionRow(session: $0, signal: $0.signal(unread: isUnread($0))) }
            let remote = hosted.filter { item in
                guard !item.value.isArchived else { return false }
                let signal = item.value.signal(unread: isUnreadHost?(item) ?? false)
                switch signal {
                case .failed, .needsYou: return title == "Needs you"
                case .working: return title == "Working"
                case .readyToMerge: return title == "Ready to merge"
                case nil: return title == "Recent"
                }
            }
            rows += remote.prefix(max(0, remaining - rows.count)).map {
                MenuBarSessionRow(session: $0.value, reference: $0.ref, available: availableHosts.contains($0.ref.host),
                                  signal: $0.value.signal(unread: isUnreadHost?($0) ?? false))
            }
            guard !rows.isEmpty else { continue }
            remaining -= rows.count
            sections.append(MenuBarSection(title: title, rows: rows))
        }
        self.sections = sections
        self.lifecycleBusy = lifecycleBusy
        self.waitingToInstall = waitingToInstall
        switch status {
        case .running:
            daemonText = "pilotd running"
            statusText = MenuBarText.heading(needsYou: groups.needsYou.count + hosted.filter { $0.value.signal(unread: isUnreadHost?($0) ?? false)?.needsUser == true }.count,
                                            working: groups.working.count + hosted.filter { availableHosts.contains($0.ref.host) && $0.value.isWorking }.count)
        case .starting, .unknown:
            daemonText = "pilotd starting…"
            statusText = hosted.isEmpty ? daemonText : "Remote chats available"
        case .stopped:
            daemonText = "pilotd stopped"
            statusText = hosted.isEmpty ? daemonText : "Remote chats available"
        case .failed:
            daemonText = "pilotd failed"
            statusText = hosted.isEmpty ? daemonText : "Remote chats available"
        }
    }
}

enum MenuBarText {
    /// "1 needs you · 2 working", leaving out zeros, or "Nothing needs you".
    static func heading(needsYou: Int, working: Int) -> String {
        var parts: [String] = []
        if needsYou > 0 { parts.append(SidebarScopeCounts.needsYou(needsYou)) }
        if working > 0 { parts.append("\(working) working") }
        return parts.isEmpty ? "Nothing needs you" : parts.joined(separator: " · ")
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
                                   waitingToInstall: updater.waitingToInstall, hosted: model.hosts.sessions.filter { $0.ref.host != model.localHost && !$0.value.isControl }, availableHosts: model.hosts.available, isUnreadHost: { model.isUnread($0.value, on: $0.ref.host) })
        observation = Publishers.CombineLatest4(model.client.$sessions, model.$reviewRevision,
                                                 model.daemon.$status, model.daemon.$lifecycleBusy)
            .combineLatest(updater.$waitingToInstall)
            .combineLatest(model.hosts.$sessions, model.hosts.$available)
            .map { combined, hosted, available in
                let (values, waiting) = combined
                // @Published delivers before storing the new value. Use the emitted
                // sessions/status, rather than rereading potentially stale properties.
                return MenuBarSnapshot(sessions: values.0, isUnread: model.isUnread,
                                status: values.2, lifecycleBusy: values.3, waitingToInstall: waiting,
                                hosted: hosted.filter { $0.ref.host != model.localHost }, availableHosts: available,
                                isUnreadHost: { model.isUnread($0.value, on: $0.ref.host) })
            }
            .debounce(for: .zero, scheduler: DispatchQueue.main)
            .removeDuplicates()
            .sink { [weak self] value in
                guard let self, self.snapshot != value else { return }
                self.snapshot = value
            }
    }
}
