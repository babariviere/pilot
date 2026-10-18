import PilotCore
import SwiftUI

/// Top of the control chat's transcript: its symbol, title and scope, then one sentence on what it can see and do.
/// Quiet type without a card, like a page header, so the conversation below stays the focus. The title is the
/// chat's own (pilotd names it), never a second copy here.
struct ControlChatHeader: View {
    let title: String
    /// Opens the Control screen (memory, log, watches and health).
    var openScreen: (() -> Void)? = nil

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            PilotSymbol(PilotIcon.controlChat)
                .foregroundStyle(Theme.mutedForeground)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(title)
                        .font(.pilot(.body, weight: .semibold))
                        .foregroundStyle(Theme.foreground)
                        .accessibilityAddTraits(.isHeader)
                    MetaText(ControlChatIdentity.scope)
                }
                Text(ControlChatIdentity.summary)
                    .font(.pilot(.label))
                    .foregroundStyle(Theme.mutedForeground)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let openScreen {
                Spacer(minLength: 8)
                Button(action: openScreen) {
                    Text("Open Control screen").font(.pilot(.label)).foregroundStyle(Theme.mutedForeground)
                        .padding(.horizontal, 8).padding(.vertical, 4).contentShape(Rectangle())
                }
                .rowButtonStyle()
                .help("Memory summaries, the message log, watches and health")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: openScreen == nil ? .combine : .contain)
    }
}


/// Loads and keeps the control chat's details: its active watches and its audited actions. Both are bounded pages
/// from pilotd, refetched on `watches.changed` / `control-audit.changed` (coalesced) and on reconnect. Older pages
/// load only on request and drop on the next refetch, so retained data stays bounded.
@MainActor
final class ControlDetailsModel: ObservableObject {
    @Published private(set) var watches: [Watch] = []
    @Published private(set) var watchesNext: String?
    @Published private(set) var watchesLoaded = false
    @Published private(set) var watchesError: String?
    /// Watches whose cancellation is in flight.
    @Published private(set) var cancelling: Set<String> = []
    @Published private(set) var cancelError: String?
    @Published private(set) var operations: [ControlAuditOperation] = []
    @Published private(set) var auditLoaded = false
    @Published private(set) var auditError: String?
    @Published private(set) var auditHasOlder = false
    @Published private(set) var loadingMore = false

    static let watchPage = 40
    static let auditPage = 50
    /// Most rows kept after "Show more"; the next refetch returns to the first page anyway.
    static let maxWatches = 400
    static let maxAuditEntries = 500
    /// Invalidations within this window share one refetch.
    static let coalesce: Duration = .milliseconds(150)

    private var auditEntries: [ControlAuditEntry] = []
    private weak var client: PilotClient?
    private var observer: UUID?
    private var watchTask: Task<Void, Never>?
    private var auditTask: Task<Void, Never>?

    func attach(_ client: PilotClient) {
        guard self.client !== client || observer == nil else { return }
        detach()
        self.client = client
        observer = client.observeControlDetails { [weak self] change in
            switch change {
            case .watches: self?.reloadWatches(coalescing: true)
            case .audit: self?.reloadAudit(coalescing: true)
            case .memory: break
            case .dashboard: break
            }
        }
        reload()
    }

    func detach() {
        if let observer { client?.stopObservingControlDetails(observer) }
        observer = nil
        watchTask?.cancel()
        auditTask?.cancel()
        watchTask = nil
        auditTask = nil
    }

    func reload() {
        reloadWatches(coalescing: false)
        reloadAudit(coalescing: false)
    }

    func reloadWatches(coalescing: Bool) {
        watchTask?.cancel()
        watchTask = Task { [weak self] in
            if coalescing { try? await Task.sleep(for: Self.coalesce) }
            guard !Task.isCancelled, let client = self?.client else { return }
            do {
                let page = try await client.controlWatches(limit: Self.watchPage)
                guard !Task.isCancelled, let self else { return }
                watches = page.watches
                watchesNext = page.next
                watchesError = nil
                watchesLoaded = true
            } catch {
                guard !Task.isCancelled, let self else { return }
                watchesError = error.localizedDescription
                watchesLoaded = true
            }
        }
    }

    func reloadAudit(coalescing: Bool) {
        auditTask?.cancel()
        auditTask = Task { [weak self] in
            if coalescing { try? await Task.sleep(for: Self.coalesce) }
            guard !Task.isCancelled, let client = self?.client else { return }
            do {
                let page = try await client.controlAudit(limit: Self.auditPage)
                guard !Task.isCancelled, let self else { return }
                setAudit(page, hasOlder: page.count == Self.auditPage)
                auditError = nil
                auditLoaded = true
            } catch {
                guard !Task.isCancelled, let self else { return }
                auditError = error.localizedDescription
                auditLoaded = true
            }
        }
    }

    func loadMoreWatches() {
        guard let next = watchesNext, !loadingMore, watches.count < Self.maxWatches, let client else { return }
        loadingMore = true
        Task {
            defer { loadingMore = false }
            do {
                let page = try await client.controlWatches(after: next, limit: Self.watchPage)
                // A refetch may have replaced the list meanwhile; only extend the list this page continues.
                guard watchesNext == next else { return }
                let known = Set(watches.map(\.id))
                watches += page.watches.filter { !known.contains($0.id) }
                watchesNext = watches.count < Self.maxWatches ? page.next : nil
            } catch { watchesError = error.localizedDescription }
        }
    }

    func loadOlderAudit() {
        guard auditHasOlder, !loadingMore, let oldest = auditEntries.map(\.seq).min(), let client else { return }
        loadingMore = true
        Task {
            defer { loadingMore = false }
            do {
                let page = try await client.controlAudit(before: oldest, limit: Self.auditPage)
                guard auditEntries.map(\.seq).min() == oldest else { return }
                setAudit(auditEntries + page, hasOlder: page.count == Self.auditPage)
            } catch { auditError = error.localizedDescription }
        }
    }

    func cancel(_ watch: Watch) {
        guard !cancelling.contains(watch.id), let client else { return }
        cancelling.insert(watch.id)
        cancelError = nil
        Task {
            defer { cancelling.remove(watch.id) }
            do {
                // False means it already fired or expired: gone either way.
                _ = try await client.cancelWatch(watch.id)
                watches.removeAll { $0.id == watch.id }
            } catch { cancelError = error.localizedDescription }
        }
    }

    private func setAudit(_ entries: [ControlAuditEntry], hasOlder: Bool) {
        auditEntries = Array(entries.prefix(Self.maxAuditEntries))
        auditHasOlder = hasOlder && entries.count < Self.maxAuditEntries
        operations = ControlAuditOperation.fold(auditEntries)
    }
}

/// The control chat's inspector pane: what it is watching, each with Cancel, then the actions it took that change
/// other chats, missions or memory (its audit), newest first. Watch notes and action text come from the agent and
/// stay plain, untrusted text.
struct ControlDetailsPane: View {
    @ObservedObject var client: PilotClient
    let context: HostViewContext?
    @StateObject private var details = ControlDetailsModel()

    var body: some View {
        VStack(spacing: 0) {
            InspectorPaneHeader("Watching", trailing: {
                if !details.watches.isEmpty { CountBadge(count: details.watches.count) }
            })
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ControlDetailsList(details: details, client: client, context: context)
                }
                .padding(.horizontal, 4)
                .padding(.vertical, 4)
            }
        }
        .background(Theme.background)
        .onAppear { details.attach(client) }
        .onDisappear { details.detach() }
        .onChange(of: client.connected) { _, connected in if connected { details.reload() } }
    }
}

/// The watches, each with Cancel, then the audited actions: the Watching pane's content, shared with the Control
/// screen. The owner attaches and detaches `details`.
struct ControlDetailsList: View {
    @ObservedObject var details: ControlDetailsModel
    @ObservedObject var client: PilotClient
    let context: HostViewContext?
    /// The Control screen labels the watches; the pane's header already does.
    var labelsWatches = false
    @EnvironmentObject private var model: AppModel

    var body: some View {
        if labelsWatches {
            SectionLabel(title: "Watching")
                .padding(.horizontal, 12)
                .padding(.bottom, 4)
        }
        watchingSection
        SectionLabel(title: "Actions")
            .padding(.horizontal, 12)
            .padding(.top, 18)
            .padding(.bottom, 4)
        actionsSection
    }

    @ViewBuilder private var watchingSection: some View {
        if !details.watchesLoaded {
            ProgressView().controlSize(.small).frame(maxWidth: .infinity).padding(.vertical, 12)
        } else if let error = details.watchesError, details.watches.isEmpty {
            InlineProblem(error) { details.reloadWatches(coalescing: false) }.padding(12)
        } else if details.watches.isEmpty {
            quiet("Nothing watched. Ask in this chat to watch a chat, pull request, Linear issue or mission.")
        } else {
            if let error = details.cancelError {
                InlineProblem(error).padding(.horizontal, 12).padding(.vertical, 6)
            }
            ForEach(details.watches) { watch in
                ControlWatchRow(watch: watch, target: target(watch.target), cancelling: details.cancelling.contains(watch.id)) {
                    details.cancel(watch)
                }
            }
            if details.watchesNext != nil {
                moreButton("Show more") { details.loadMoreWatches() }
            }
        }
    }

    @ViewBuilder private var actionsSection: some View {
        if !details.auditLoaded {
            ProgressView().controlSize(.small).frame(maxWidth: .infinity).padding(.vertical, 12)
        } else if let error = details.auditError, details.operations.isEmpty {
            InlineProblem(error) { details.reloadAudit(coalescing: false) }.padding(12)
        } else if details.operations.isEmpty {
            quiet("No actions yet. Chats it starts or messages, missions it creates and memory notes it adds appear here.")
        } else {
            TimelineView(.periodic(from: .now, by: 60)) { timeline in
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(details.operations) { operation in
                        ControlAuditRow(operation: operation, project: operation.projectId.flatMap { client.project($0)?.name },
                                        chatTitle: operation.chatId.flatMap { client.session($0)?.title },
                                        now: timeline.date) {
                            if let id = operation.chatId { model.navigate(.session, id: id, context: context) }
                        }
                    }
                }
            }
            if details.auditHasOlder {
                moreButton("Show older") { details.loadOlderAudit() }
            }
        }
    }

    private func target(_ target: WatchTarget) -> String {
        WatchPresentation.target(target, chat: { client.session($0)?.title }, project: { client.project($0)?.name },
                                 mission: { client.mission($0)?.title })
    }

    private func quiet(_ text: String) -> some View {
        Text(text)
            .font(.pilot(.caption))
            .foregroundStyle(Theme.faintForeground)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
    }

    private func moreButton(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title).font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(details.loadingMore)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }
}

/// One watch: what it looks at, when it fires and how often, then the saved instruction. Cancel shows under the
/// pointer and stays in the context menu and VoiceOver actions.
struct ControlWatchRow: View {
    let watch: Watch
    let target: String
    var cancelling = false
    let cancel: () -> Void

    var body: some View {
        HoverRow(verticalPadding: 7) { hovered in
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                PilotSymbol(PilotIcon.watch, context: .row)
                    .foregroundStyle(Theme.mutedForeground)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(target).font(.pilot(.body)).foregroundStyle(Theme.foreground).lineLimit(1)
                    // Wraps once, so an expiry is never cut off in the narrow inspector.
                    Text(when).font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                        .lineLimit(2).fixedSize(horizontal: false, vertical: true)
                    if let note = WatchPresentation.note(watch) {
                        Text(note).font(.pilot(.caption)).foregroundStyle(Theme.foreground)
                            .lineLimit(3).fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 6)
                Button(cancelling ? "Cancelling…" : "Cancel", action: cancel)
                    .controlSize(.small)
                    .disabled(cancelling)
                    .revealed(hovered || cancelling)
                    .help("Stop watching. The chat is not told.")
            }
        }
        .contextMenu { Button("Cancel Watch", action: cancel).disabled(cancelling) }
        .accessibilityElement(children: .combine)
        .accessibilityAction(named: "Cancel watch", cancel)
    }

    private var when: String {
        "When \(WatchPresentation.event(watch.event, filter: watch.filter).lowercasedFirst) · \(WatchPresentation.mode(watch))"
    }
}

/// One audited action: its outcome symbol, what happened, the text it carried and where. Clicking opens the chat it
/// started or messaged, when there is one.
struct ControlAuditRow: View {
    let operation: ControlAuditOperation
    let project: String?
    let chatTitle: String?
    let now: Date
    let open: () -> Void

    var body: some View {
        HoverRow(verticalPadding: 7) { _ in
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                PilotSymbol(symbol, context: .row)
                    .foregroundStyle(operation.phase == .failed ? Theme.error : Theme.mutedForeground)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(operation.title).font(.pilot(.body)).foregroundStyle(Theme.foreground).lineLimit(1)
                    if let detail = operation.detail {
                        Text(detail).font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                            .lineLimit(2).fixedSize(horizontal: false, vertical: true)
                    }
                    if let error = operation.error {
                        Text(error).font(.pilot(.caption)).foregroundStyle(Theme.error)
                            .lineLimit(2).fixedSize(horizontal: false, vertical: true)
                    }
                    Text(byline).font(.pilot(.caption)).foregroundStyle(Theme.faintForeground).lineLimit(1)
                }
                Spacer(minLength: 0)
            }
        }
        .onTapGesture { if operation.chatId != nil { open() } }
        .contextMenu {
            if operation.chatId != nil { Button("Open Chat", action: open) }
        }
        .help(operation.chatId != nil ? "Open \(chatTitle ?? "the chat")" : "")
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(operation.chatId != nil ? .isButton : [])
    }

    private var symbol: PilotIcon {
        switch operation.phase {
        case .succeeded: .done
        case .failed: .warning
        case .requested: .pending
        }
    }

    private var byline: String {
        // Requested alone: still running, or interrupted before pilotd recorded an outcome.
        let state = operation.phase == .requested ? "No outcome yet" : nil
        return [chatTitle, project, state, SessionTimeFormatting.relative(operation.at, now: now)]
            .compactMap { $0 }.joined(separator: " · ")
    }
}

private extension String {
    var lowercasedFirst: String { prefix(1).lowercased() + dropFirst() }
}
