import PilotCore
import SwiftUI

/// One Control chat in the sidebar's fixed slot, with the key its selection uses (the sidebar list's tag).
struct SidebarControlRow: Identifiable, Equatable {
    let session: SessionSummary
    /// Set while devboxes are listed, so the row reads its own host.
    let reference: HostResourceRef?
    let key: String
    var id: String { key }

    /// The Control chats the slot shows, whatever the sidebar's scope or search: the local one, or with `hosted`
    /// (devboxes listed) every host's, the local one first.
    static func rows(sessions: [SessionSummary], hosted: [Hosted<SessionSummary>]?, localHost: HostRef?)
        -> [SidebarControlRow] {
        guard let hosted else {
            return sessions.first { $0.isControl && !$0.isArchived }
                .map { [SidebarControlRow(session: $0, reference: nil, key: $0.id)] } ?? []
        }
        let controls = hosted.filter { $0.value.isControl && !$0.value.isArchived }
        let ordered = controls.filter { $0.ref.host == localHost } + controls.filter { $0.ref.host != localHost }
        return ordered.map { item in
            SidebarControlRow(session: item.value, reference: item.ref,
                              key: item.ref.host == localHost ? item.ref.localId : item.ref.storageKey)
        }
    }
}

/// Arrow keys and J/K in the sidebar list treat the fixed Control rows as the list's first items.
enum SidebarStickyNavigation {
    enum Step: Equatable {
        /// Let the list move as usual.
        case native
        /// Already at the top: consume the key.
        case stay
        case select(String)
        /// Let the list move up; if it could not (its first row was selected), select this sticky row.
        case nativeOr(String)
    }

    /// `listHasSelection` is whether the native list shows a selected row; a selected Control row leaves it empty.
    static func step(down: Bool, sticky: [String], current: String?, listHasSelection: Bool) -> Step {
        guard let last = sticky.last else { return .native }
        if let current, let index = sticky.firstIndex(of: current) {
            if down { return index + 1 < sticky.count ? .select(sticky[index + 1]) : .native }
            return index > 0 ? .select(sticky[index - 1]) : .stay
        }
        if !listHasSelection { return down ? .select(sticky[0]) : .native }
        return down ? .native : .nativeOr(last)
    }
}

extension AppModel {
    /// The sidebar's fixed Control rows, as `SessionSidebar` shows them.
    var sidebarControlRows: [SidebarControlRow] {
        SidebarControlRow.rows(sessions: client.activeSessions,
                               hosted: hosts.offlineHosts.isEmpty ? nil : hosts.sessions, localHost: localHost)
    }
}

/// The Control chat's fixed slot under the scope header. It never scrolls and shows in every scope: like Home, it is
/// a place rather than one chat among others, and opening it keeps the scope. Rows look and act like the list's
/// `SessionRow`s (state corner, context menu), with the list's selection fill and insets.
struct SidebarControlSlot: View {
    let rows: [SidebarControlRow]
    @ObservedObject var model: AppModel
    @Environment(\.hostViewContext) private var hostContext

    var body: some View {
        VStack(spacing: 0) {
            ForEach(rows) { row in
                let selected = model.selectedSessionId == row.key
                SessionRow(session: row.session, reference: row.reference)
                    .environment(\.hostViewContext,
                                 row.reference.map { HostViewContext(host: $0.host, hosts: model.hosts) } ?? hostContext)
                    // The list's row insets: the dithered corner reaches the selection fill's edges.
                    .padding(EdgeInsets(top: 3, leading: 8, bottom: 3, trailing: 6))
                    .background(RoundedRectangle(cornerRadius: Theme.Radius.row).fill(selected ? Theme.selected : .clear))
                    .contentShape(Rectangle())
                    .onTapGesture { model.navigate(.session, id: row.key) }
                    .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
                    .accessibilityAction { model.navigate(.session, id: row.key) }
            }
        }
    }
}
