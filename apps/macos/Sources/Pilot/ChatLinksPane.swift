import AppKit
import Combine
import PilotCore
import SwiftUI

// The inspector's Links tab: every link mentioned in the chat's messages, the most recent first.

/// Rebuilds the link list from the chat's rows off the UI actor. Streaming updates are throttled, and only
/// new or changed messages are rescanned. Attached only while the tab is shown.
@MainActor
final class ChatLinksModel: ObservableObject {
    @Published private(set) var links: [ChatLink] = []
    @Published private(set) var ready = false
    /// Older messages hidden by compaction are not loaded, so their links are not listed yet.
    @Published private(set) var hasEarlier = false
    private var index = ChatLinkIndex()
    private var subscription: AnyCancellable?
    private var work: Task<Void, Never>?
    private var pending: [ChatRow]?

    /// How often streaming text may rebuild the list.
    static let throttle: DispatchQueue.SchedulerTimeType.Stride = .milliseconds(500)

    func attach(_ feed: SessionFeed) {
        subscription = feed.rows.$presentation
            .throttle(for: Self.throttle, scheduler: DispatchQueue.main, latest: true)
            .sink { [weak self] presentation in
                guard let self else { return }
                let earlier = presentation.earlierCursor != nil
                if hasEarlier != earlier { hasEarlier = earlier }
                rebuild(presentation.rows)
            }
    }

    func detach() {
        subscription = nil
        work?.cancel()
        work = nil
        pending = nil
    }

    /// One pass at a time; a newer snapshot waits for the running one and replaces any other waiting one.
    func rebuild(_ rows: [ChatRow]) {
        guard work == nil else {
            pending = rows
            return
        }
        let start = index
        work = Task { [weak self] in
            let (index, links) = await Task.detached(priority: .utility) {
                var index = start
                let links = index.links(in: rows)
                return (index, links)
            }.value
            guard let self, !Task.isCancelled else { return }
            self.index = index
            if self.links != links { self.links = links }
            if !ready { ready = true }
            work = nil
            if let next = pending {
                pending = nil
                rebuild(next)
            }
        }
    }
}

struct SessionLinksPane: View {
    let feed: SessionFeed
    @StateObject private var model = ChatLinksModel()
    @StateObject private var keyboardRows = KeyboardListState()

    var body: some View {
        VStack(spacing: 0) {
            InspectorPaneHeader("\(model.links.count) link\(model.links.count == 1 ? "" : "s")")
            if !model.ready {
                ProgressView().controlSize(.small).frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if model.links.isEmpty {
                EmptyStateView(icon: PilotIcon.link, title: "No links yet",
                               message: model.hasEarlier
                                   ? "Links mentioned in this chat appear here. Links in earlier messages appear once they are loaded in the chat."
                                   : "Links mentioned in this chat appear here.")
                    .padding(.horizontal, 16)
                    .frame(maxHeight: .infinity)
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(model.links) { link in
                            ChatLinkRow(link: link).equatable()
                                .keyboardListItem(link.id) { ChatLinkActions.open(link) }
                        }
                        if model.hasEarlier {
                            earlierNote.padding(.horizontal, 12).padding(.vertical, 10)
                        }
                    }
                    .padding(.horizontal, 4)
                    .padding(.vertical, 4)
                    .keyboardList(region: .inspector, state: keyboardRows, suppliesRows: true)
                    .onChange(of: model.links.map(\.id), initial: true) { _, _ in
                        keyboardRows.update(model.links.map { link in KeyboardListItem(id: link.id) { ChatLinkActions.open(link) } })
                    }
                }
            }
        }
        .background(Theme.background)
        .onAppear { model.attach(feed) }
        .onDisappear { model.detach() }
    }

    private var earlierNote: some View {
        Text("Links in earlier messages appear once they are loaded in the chat.")
            .font(.pilot(.caption)).foregroundStyle(Theme.faintForeground)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Icon, title and the URL. Click opens it; the context menu also copies it.
struct ChatLinkRow: View, Equatable {
    let link: ChatLink

    var body: some View {
        HoverRow(verticalPadding: 7) { _ in
            HStack(spacing: 10) {
                MissionLinkIcon(kind: link.kind, size: 12)
                VStack(alignment: .leading, spacing: 2) {
                    Text(link.title).font(.pilot(.body)).foregroundStyle(Theme.foreground).lineLimit(1)
                    if link.title != link.detail {
                        Text(link.detail).font(.pilot(.caption)).foregroundStyle(Theme.faintForeground)
                            .lineLimit(1).truncationMode(.middle)
                    }
                }
                Spacer(minLength: 8)
                if link.mentions > 1 {
                    Text("\(link.mentions)×").font(.pilot(.caption)).monospacedDigit()
                        .foregroundStyle(Theme.faintForeground).fixedSize()
                        .help("Mentioned \(link.mentions) times")
                }
            }
        }
        .onTapGesture { ChatLinkActions.open(link) }
        .contextMenu {
            Button("Open Link") { ChatLinkActions.open(link) }
            Button("Copy Link") { ChatLinkActions.copy(link) }
        }
        .help(link.url)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(ChatLinkActions.accessibilityLabel(link))
        .accessibilityAddTraits(.isLink)
        .accessibilityAction { ChatLinkActions.open(link) }
        .accessibilityAction(named: "Copy link") { ChatLinkActions.copy(link) }
    }
}

@MainActor
enum ChatLinkActions {
    static func open(_ link: ChatLink) {
        guard let url = URL(string: link.url), ["http", "https"].contains(url.scheme?.lowercased()) else { return }
        BrowserLinkOpener.shared.open(url)
    }

    static func copy(_ link: ChatLink) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(link.url, forType: .string)
    }

    static func accessibilityLabel(_ link: ChatLink) -> String {
        var parts = [link.kind.serviceLabel, link.title]
        if link.mentions > 1 { parts.append("mentioned \(link.mentions) times") }
        return parts.joined(separator: ", ")
    }
}
