import AppKit
import PilotCore
import SwiftUI

/// Opt-in until the release benchmark and native interaction gates pass. No daemon setting or wire change.
enum NativeTranscriptFlag {
    static var enabled: Bool {
        ProcessInfo.processInfo.environment["PILOT_APPKIT_TRANSCRIPT"] == "1"
            || UserDefaults.standard.bool(forKey: "appKitTranscript")
    }
}

struct NativeTranscriptResource: Hashable {
    let sessionID: String
    let host: HostRef?
}

/// The representable is a viewport, never the transcript's fitting height. Only this wrapper observes chunks.
struct NativeTranscriptSection: View {
    @ObservedObject var model: TranscriptRowsModel
    let resource: NativeTranscriptResource
    let scroll: TranscriptScrollState
    let toolExpansions: TranscriptExpansions
    let messageExpansions: TranscriptExpansions
    let header: NativeTranscriptHeader
    let footer: NativeTranscriptFooter
    /// Produced by ChatView, not by this chunk-observing subtree.
    let chromeRevision: UUID
    let loadEarlier: () -> Void
    var hasSnapshot = true
    var loadingEarlier = false
    var earlierError: String?
    @Environment(\.self) private var environment
    @StateObject private var presentation = NativeTranscriptPresentation()

    private var nativeEnvironment: EnvironmentValues {
        var values = environment
        let presentation = presentation
        values.nativeTranscriptPresent = { [weak presentation] in presentation?.request = $0 }
        return values
    }

    var body: some View {
        NativeTranscript(presentation: model.presentation, historyLimit: model.historyLimit,
                         resource: resource, scroll: scroll, toolExpansions: toolExpansions,
                         messageExpansions: messageExpansions, environment: nativeEnvironment,
                         header: header, footer: footer, loadEarlier: {
                             if !model.revealEarlier() { loadEarlier() }
                         }, hasSnapshot: hasSnapshot, loadingEarlier: loadingEarlier, earlierError: earlierError,
                         chromeRevision: chromeRevision)
            .sheet(item: $presentation.request) { NativeTranscriptPresentedContent(request: $0) }
    }
}

struct NativeTranscript: NSViewRepresentable {
    let presentation: TranscriptPresentation
    let historyLimit: Int
    let resource: NativeTranscriptResource
    let scroll: TranscriptScrollState
    let toolExpansions: TranscriptExpansions
    let messageExpansions: TranscriptExpansions
    let environment: EnvironmentValues
    let header: NativeTranscriptHeader
    let footer: NativeTranscriptFooter
    let loadEarlier: () -> Void
    var hasSnapshot = true
    var loadingEarlier = false
    var earlierError: String?
    var chromeRevision = UUID()

    func makeCoordinator() -> NativeTranscriptController { NativeTranscriptController() }

    func makeNSView(context: Context) -> NativeTranscriptScrollView {
        let view = context.coordinator.scrollView
        context.coordinator.update(self)
        return view
    }

    func updateNSView(_ nsView: NativeTranscriptScrollView, context: Context) {
        context.coordinator.update(self)
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView: NativeTranscriptScrollView, context: Context) -> CGSize? {
        CGSize(width: proposal.width ?? 760, height: proposal.height ?? 600)
    }

    static func dismantleNSView(_ nsView: NativeTranscriptScrollView, coordinator: NativeTranscriptController) {
        coordinator.stop()
    }
}

enum NativeTranscriptItem: Hashable {
    case header, earlier, row(String), footer
}

/// One latest measurement per logical row. Width/content changes replace, rather than multiply, entries.
/// No source strings in the keys, no history scan on a streamed chunk, and no unbounded width generations.
struct TranscriptHeightCache {
    struct Entry {
        let width: CGFloat
        let revision: Int
        let height: CGFloat
        var order: Int
    }
    private(set) var entries: [NativeTranscriptItem: Entry] = [:]
    private var order = 0
    let limit: Int

    init(limit: Int = 4096) { self.limit = max(1, limit) }

    mutating func height(for id: NativeTranscriptItem, width: CGFloat, revision: Int) -> CGFloat? {
        guard var entry = entries[id], entry.width == width, entry.revision == revision else { return nil }
        order += 1
        entry.order = order
        entries[id] = entry
        return entry.height
    }

    mutating func store(_ height: CGFloat, for id: NativeTranscriptItem, width: CGFloat, revision: Int) {
        order += 1
        entries[id] = Entry(width: width, revision: revision, height: height, order: order)
        if entries.count > limit, let oldest = entries.min(by: { $0.value.order < $1.value.order })?.key {
            entries[oldest] = nil
        }
    }

    mutating func remove(_ id: NativeTranscriptItem) { entries[id] = nil }
    mutating func clear() { entries.removeAll(keepingCapacity: true) }
}

@MainActor
final class NativeTranscriptController: NSObject, NSTableViewDataSource, NSTableViewDelegate {
    let scrollView = NativeTranscriptScrollView()
    let table = NativeTranscriptTable()
    private var configuration: NativeTranscript?
    private var historyRevision: UUID?
    private var historyLimit = 0
    private var history: [ChatRow] = []
    private var live: [ChatRow] = []
    private(set) var items: [NativeTranscriptItem] = []
    private var indices: [NativeTranscriptItem: Int] = [:]
    private var rows: [String: ChatRow] = [:]
    private var revisions: [NativeTranscriptItem: Int] = [:]
    private var heights = TranscriptHeightCache()
    /// The geometry handed to NSTableView, independent of evictable measurement entries. One scalar per row.
    private var installedHeights: [NativeTranscriptItem: CGFloat] = [:]
    private var pending = Set<NativeTranscriptItem>()
    private var heightWork: DispatchWorkItem?
    private var updating = false
    private var lastViewport = NSSize.zero
    private var metrics: PilotFonts?
    private var hasEarlier = false
    private var highlighted: String?
    private var selections: [NativeTranscriptItem: [String: MessageTextSelection]] = [:]
    private(set) var measurements = 0
    private(set) var membershipUpdates = 0
    private(set) var heightTransactions = 0
    private(set) var createdCells = 0
    private(set) var cellBindings = 0

    var diagnosticSummary: String {
        var mounted = 0
        table.enumerateAvailableRowViews { _, _ in mounted += 1 }
        return "native transcript: cells created=\(createdCells) mounted=\(mounted), bindings=\(cellBindings), "
            + "measurements=\(measurements) height transactions=\(heightTransactions) membership updates=\(membershipUpdates), "
            + "height cache entries=\(heights.entries.count), viewport top=\(Int(scrollView.contentView.bounds.minY)) "
            + "bottom=\(Int(scrollView.contentView.bounds.maxY)) document=\(Int(table.bounds.height))"
    }

    override init() {
        super.init()
        scrollView.controller = self
        scrollView.drawsBackground = false
        scrollView.hasVerticalScroller = true
        scrollView.autohidesScrollers = true
        scrollView.borderType = .noBorder
        table.controller = self
        table.headerView = nil
        table.backgroundColor = .clear
        table.focusRingType = .none
        table.selectionHighlightStyle = .none
        table.style = .plain
        table.rowSizeStyle = .custom
        table.usesAutomaticRowHeights = false
        table.intercellSpacing = NSSize(width: 0, height: 16)
        let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("transcript"))
        column.resizingMask = .autoresizingMask
        table.addTableColumn(column)
        table.columnAutoresizingStyle = .lastColumnOnlyAutoresizingStyle
        table.delegate = self
        table.dataSource = self
        scrollView.documentView = table
        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(scrollBegan), name: NSScrollView.willStartLiveScrollNotification, object: scrollView)
        center.addObserver(self, selector: #selector(scrolled), name: NSScrollView.didLiveScrollNotification, object: scrollView)
        center.addObserver(self, selector: #selector(scrollEnded), name: NSScrollView.didEndLiveScrollNotification, object: scrollView)
    }

    func stop() {
        heightWork?.cancel()
        heightWork = nil
        // The representable explicitly detaches before deinit, just like the existing scroll observer.
        // swiftlint:disable:next notification_center_detachment
        NotificationCenter.default.removeObserver(self)
        configuration?.scroll.pinBottom = nil
        configuration?.scroll.onMessageToggled = nil
        configuration?.scroll.focusTranscript = nil
        configuration = nil
        table.delegate = nil
        table.dataSource = nil
        table.enumerateAvailableRowViews { row, _ in
            (row.view(atColumn: 0) as? NativeTranscriptCell)?.unbind()
        }
        selections.removeAll()
    }

    func update(_ next: NativeTranscript) {
        let reset = configuration?.resource != next.resource
        let metricChange = metrics != next.environment.pilotFonts
        let old = configuration
        configuration = next
        next.scroll.pinBottom = { [weak self] in self?.pinBottom() }
        next.scroll.onMessageToggled = { [weak self] in self?.captureReadingAnchor(containing: true) }
        next.scroll.focusTranscript = { [weak self] in
            guard let self else { return false }
            return self.table.window?.makeFirstResponder(self.table) == true
        }
        metrics = next.environment.pilotFonts
        let anchor = readingAnchor()
        if reset {
            heightWork?.cancel(); heightWork = nil
            pending.removeAll()
            historyRevision = nil
            historyLimit = 0
            history = []; live = []; rows = [:]; revisions = [:]; selections = [:]
            heights.clear()
            installedHeights.removeAll(keepingCapacity: true)
            capturedAnchor = nil
        }
        var changed = Set<NativeTranscriptItem>()
        let historyChanged = historyRevision != next.presentation.historyRevision || historyLimit != next.historyLimit
        if historyChanged {
            let visible = Array(next.presentation.historyRows.suffix(next.historyLimit))
            for row in visible where rows[row.id] != row { changed.insert(.row(row.id)) }
            history = visible
            historyRevision = next.presentation.historyRevision
            historyLimit = next.historyLimit
        }
        for row in next.presentation.liveRows where rows[row.id] != row { changed.insert(.row(row.id)) }
        let liveMembershipChanged = live.map(\.id) != next.presentation.liveRows.map(\.id)
        live = next.presentation.liveRows
        if historyChanged || liveMembershipChanged || reset {
            rows = Dictionary(uniqueKeysWithValues: (history + live).map { ($0.id, $0) })
        } else {
            for row in live { rows[row.id] = row }
        }
        let earlier = next.hasSnapshot && (next.presentation.historyRowCount > next.historyLimit || next.presentation.earlierCursor != nil)
        let membershipChanged = reset || historyChanged || liveMembershipChanged || earlier != hasEarlier
        hasEarlier = earlier
        updating = true
        if membershipChanged {
            membershipUpdates += 1
            let previous = items
            items = [.header] + (hasEarlier ? [.earlier] : []) + (history + live).map { .row($0.id) } + [.footer]
            indices = Dictionary(uniqueKeysWithValues: items.enumerated().map { ($0.element, $0.offset) })
            // Structural changes only. A chunk with unchanged IDs never reaches the table's data source.
            if reset {
                table.reloadData()
            } else {
                let diff = items.difference(from: previous)
                table.beginUpdates()
                for change in diff {
                    if case let .remove(offset, _, _) = change { table.removeRows(at: IndexSet(integer: offset), withAnimation: []) }
                }
                for change in diff {
                    if case let .insert(offset, _, _) = change { table.insertRows(at: IndexSet(integer: offset), withAnimation: []) }
                }
                table.endUpdates()
            }
            let retained = Set(items)
            revisions = revisions.filter { retained.contains($0.key) }
            installedHeights = installedHeights.filter { retained.contains($0.key) }
            selections = selections.filter { retained.contains($0.key) }
        }
        // Header/footer closures are owned outside the streaming rows. Only their producer changes rebind them.
        if reset || old?.chromeRevision != next.chromeRevision {
            changed.formUnion([.header, .footer])
            let pendingIDs = Set(next.footer.pending.map(\.id))
            selections[.footer] = selections[.footer]?.filter { pendingIDs.contains($0.key) }
        }
        if reset || old?.hasSnapshot != next.hasSnapshot || old?.loadingEarlier != next.loadingEarlier
            || old?.earlierError != next.earlierError {
            changed.insert(.earlier)
        }
        if metricChange {
            heights.clear()
            table.enumerateAvailableRowViews { [self] _, index in
                if items.indices.contains(index) { changed.insert(items[index]) }
            }
        }
        let active = next.presentation.working ? live.last(where: \.isWork)?.id : nil
        let oldActive = old?.presentation.working == true ? old?.presentation.liveRows.last(where: \.isWork)?.id : nil
        if active != oldActive {
            if let active { changed.insert(.row(active)) }
            if let oldActive { changed.insert(.row(oldActive)) }
        }
        for item in changed {
            revisions[item, default: 0] += 1
            if let index = indices[item], let cell = table.view(atColumn: 0, row: index, makeIfNecessary: false) as? NativeTranscriptCell {
                bind(cell, to: item)
                pending.insert(item)
            }
        }
        updating = false
        flushHeights(anchor: anchor)
        resizeViewport()
        settle(anchor)
        if reset || old?.environment.keyboardCue != next.environment.keyboardCue
            || old?.environment.colorSchemeContrast != next.environment.colorSchemeContrast {
            refreshHighlights()
        }
    }

    func numberOfRows(in tableView: NSTableView) -> Int { items.count }
    func tableView(_ tableView: NSTableView, shouldSelectRow row: Int) -> Bool { false }
    func tableView(_ tableView: NSTableView, rowViewForRow row: Int) -> NSTableRowView? {
        let view = NSTableRowView()
        view.isEmphasized = false
        return view
    }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        guard items.indices.contains(row) else { return nil }
        let kind: String
        if case let .row(id) = items[row], let value = rows[id] {
            switch value {
            case .text: kind = "text"
            case let .user(_, text, _) where SubagentNotification(message: text) == nil: kind = "user"
            case .user, .automatic, .question, .notice, .event: kind = "event"
            case .work, .thinking, .tools: kind = "work"
            case .artifact: kind = "artifact"
            case .error: kind = "error"
            }
        } else { kind = "chrome" }
        let identifier = NSUserInterfaceItemIdentifier("native-transcript-" + kind)
        let reused = tableView.makeView(withIdentifier: identifier, owner: self) as? NativeTranscriptCell
        if reused == nil { createdCells += 1 }
        let cell = reused ?? NativeTranscriptCell()
        cell.identifier = identifier
        bind(cell, to: items[row])
        return cell
    }

    private func bind(_ cell: NativeTranscriptCell, to item: NativeTranscriptItem) {
        guard let configuration else { return }
        cellBindings += 1
        cell.bind(item: item, width: columnWidth, row: { if case let .row(id) = item { return rows[id] }; return nil }(),
                  configuration: configuration, selection: { [weak self] id in
                      guard let self else { return MessageTextSelection() }
                      if let state = self.selections[item]?[id] { return state }
                      let state = MessageTextSelection()
                      self.selections[item, default: [:]][id] = state
                      return state
                  }, changed: { [weak self, weak cell] in
                      guard let self, let cell, cell.item == item else { return }
                      self.invalidateHeight(item)
                  })
        styleHighlight(cell)
    }

    private func styleHighlight(_ cell: NativeTranscriptCell) {
        let target = highlighted.map { NativeTranscriptItem.row($0) }
        cell.setHighlighted(cell.item == target && configuration?.environment.keyboardCue == true
            && table.window?.firstResponder === table,
            increasedContrast: configuration?.environment.colorSchemeContrast == .increased)
    }

    func refreshHighlights() {
        table.enumerateAvailableRowViews { [weak self] row, _ in
            guard let cell = row.view(atColumn: 0) as? NativeTranscriptCell else { return }
            self?.styleHighlight(cell)
        }
    }

    func tableView(_ tableView: NSTableView, heightOfRow row: Int) -> CGFloat {
        guard items.indices.contains(row) else { return 1 }
        let item = items[row]
        let width = columnWidth
        let height = heights.height(for: item, width: width, revision: revisions[item, default: 0])
        // Only mounted rows are measured. An offscreen row gets a remembered height or estimate until realized.
            ?? heights.entries[item]?.height ?? 64
        installedHeights[item] = height
        return height
    }

    var columnWidth: CGFloat { max(1, min(Theme.column, scrollView.contentSize.width - 56)) }

    private func invalidateHeight(_ item: NativeTranscriptItem) {
        pending.insert(item)
        guard !updating, heightWork == nil else { return }
        let work = DispatchWorkItem { [weak self] in
            self?.heightWork = nil
            self?.flushHeights(anchor: self?.readingAnchor())
        }
        heightWork = work
        DispatchQueue.main.async(execute: work)
    }

    private func flushHeights(anchor: Anchor?) {
        guard !pending.isEmpty else { return }
        let changed = pending
        pending.removeAll()
        var indexes = IndexSet()
        for item in changed {
            guard let index = indices[item], let cell = table.view(atColumn: 0, row: index, makeIfNecessary: false) as? NativeTranscriptCell,
                  cell.item == item else { continue }
            let height = cell.measure(width: columnWidth)
            measurements += 1
            let old = installedHeights[item]
            heights.store(height, for: item, width: columnWidth, revision: revisions[item, default: 0])
            if old == nil || abs((old ?? 0) - height) > 0.5 { indexes.insert(index) }
        }
        if !indexes.isEmpty {
            heightTransactions += 1
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0
                table.noteHeightOfRows(withIndexesChanged: indexes)
                table.layoutSubtreeIfNeeded()
            }
        }
        settle(anchor)
    }

    func resizeViewport() {
        let viewport = scrollView.contentSize
        let width = viewport.width
        let widthChanged = abs(lastViewport.width - width) > 0.5
        guard width > 0, widthChanged || abs(lastViewport.height - viewport.height) > 0.5 else { return }
        let anchor = readingAnchor()
        lastViewport = viewport
        guard widthChanged else { settle(anchor); return }
        table.setFrameSize(NSSize(width: width, height: table.frame.height))
        table.tableColumns.first?.width = width
        table.enumerateAvailableRowViews { [self] row, index in
            if items.indices.contains(index), let cell = row.view(atColumn: 0) as? NativeTranscriptCell {
                cell.needsLayout = true
                pending.insert(items[index])
            }
        }
        flushHeights(anchor: anchor)
        settle(anchor)
    }

    struct Anchor {
        let item: NativeTranscriptItem
        let offset: CGFloat
        let bottom: Bool

        init(item: NativeTranscriptItem, rect: NSRect, viewportTop: CGFloat, containing: Bool) {
            self.item = item
            bottom = rect.minY < viewportTop - 0.5 && !containing
            offset = (bottom ? rect.maxY : rect.minY) - viewportTop
        }
    }
    private var capturedAnchor: Anchor?

    private func readingAnchor(containing: Bool = false) -> Anchor? {
        guard configuration?.scroll.follow.shouldScrollToBottom == false else { return nil }
        let y = scrollView.contentView.bounds.minY
        let index = table.row(at: NSPoint(x: 1, y: y))
        guard items.indices.contains(index) else { return nil }
        let rect = table.rect(ofRow: index)
        return Anchor(item: items[index], rect: rect, viewportTop: y, containing: containing)
    }

    private func captureReadingAnchor(containing: Bool) { capturedAnchor = readingAnchor(containing: containing) }

    private func settle(_ anchor: Anchor?) {
        if configuration?.scroll.follow.shouldScrollToBottom == true { pinBottom(); return }
        guard let anchor = capturedAnchor ?? anchor, let index = indices[anchor.item] else {
            capturedAnchor = nil
            return
        }
        let rect = table.rect(ofRow: index)
        scroll(to: (anchor.bottom ? rect.maxY : rect.minY) - anchor.offset)
    }

    func pinBottom() {
        guard configuration?.scroll.follow.shouldScrollToBottom == true else { return }
        table.layoutSubtreeIfNeeded()
        scroll(to: max(0, table.bounds.height - scrollView.contentSize.height))
    }

    private func scroll(to y: CGFloat) {
        let maximum = max(0, table.bounds.height - scrollView.contentSize.height)
        scrollView.contentView.scroll(to: NSPoint(x: 0, y: min(maximum, max(0, y))))
        scrollView.reflectScrolledClipView(scrollView.contentView)
    }

    private var distanceToBottom: Double {
        Double(max(0, table.bounds.height - scrollView.contentView.bounds.maxY))
    }
    @objc private func scrollBegan() {
        capturedAnchor = nil
        configuration?.scroll.follow.beginUserScroll()
    }
    @objc private func scrolled() {
        capturedAnchor = nil
        configuration?.scroll.follow.userScrolled(distanceToBottom: distanceToBottom)
    }
    @objc private func scrollEnded() { configuration?.scroll.follow.endUserScroll(distanceToBottom: distanceToBottom) }

    func handleKey(_ event: NSEvent) -> Bool {
        guard event.modifierFlags.intersection([.command, .control, .option]).isEmpty,
              let configuration else { return false }
        let ids = (history + live).map(\.id)
        var next: String?
        switch event.keyCode {
        case 126: next = TranscriptKeyboard.next(from: highlighted, by: -1, in: ids)
        case 125: next = TranscriptKeyboard.next(from: highlighted, by: 1, in: ids)
        case 115: next = ids.first
        case 119: next = ids.last
        case 53: return configuration.environment.keyboardFocus.focus(.composer)
        case 36:
            guard let highlighted, let index = indices[.row(highlighted)] else { return true }
            configuration.scroll.follow.pauseFollowing()
            let cell = table.view(atColumn: 0, row: index, makeIfNecessary: true) as? NativeTranscriptCell
            _ = cell?.activate()
            return true
        default: return false
        }
        if let next, let index = indices[.row(next)] {
            capturedAnchor = nil
            highlighted = next
            configuration.scroll.follow.pauseFollowing()
            table.scrollRowToVisible(index)
            refreshHighlights()
        } else if event.keyCode == 126 { configuration.loadEarlier() }
        return true
    }

    func copyHighlighted() {
        guard let highlighted, let row = rows[highlighted], let text = TranscriptKeyboard.copyText(row) else { return }
        MessageCopyButton.copy(text)
    }
}

final class NativeTranscriptClipView: NSClipView {
    override func scroll(to newOrigin: NSPoint) {
        var proposed = bounds
        proposed.origin = newOrigin
        // scroll(to:) alone does not constrain programmatic moves. Never expose a viewport past the document.
        super.scroll(to: constrainBoundsRect(proposed).origin)
    }
}

final class NativeTranscriptScrollView: NSScrollView {
    weak var controller: NativeTranscriptController?
    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        contentView = NativeTranscriptClipView(frame: contentView.frame)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func layout() {
        super.layout()
        controller?.resizeViewport()
    }
}

final class NativeTranscriptTable: NSTableView {
    weak var controller: NativeTranscriptController?
    override func becomeFirstResponder() -> Bool {
        let accepted = super.becomeFirstResponder()
        if accepted { DispatchQueue.main.async { [weak self] in self?.controller?.refreshHighlights() } }
        return accepted
    }
    override func resignFirstResponder() -> Bool {
        let accepted = super.resignFirstResponder()
        if accepted { DispatchQueue.main.async { [weak self] in self?.controller?.refreshHighlights() } }
        return accepted
    }
    override func keyDown(with event: NSEvent) {
        if controller?.handleKey(event) != true { super.keyDown(with: event) }
    }
    @objc func copy(_ sender: Any?) { controller?.copyHighlighted() }
}

/// A single logical message, not a Markdown block: its native regions share the existing selection owner.
final class NativeTranscriptCell: NSTableCellView {
    private(set) var item: NativeTranscriptItem?
    private var resource: NativeTranscriptResource?
    private var generation = UUID()
    private var text: NativeMarkdownMessage?
    private var content: (any NativeRowContent)?
    private var chrome: NativeTranscriptChrome?
    private let anchor = TranscriptRowAnchorView()
    private let highlight = NativeTranscriptHighlight()
    private var changed: (() -> Void)?
    override var isFlipped: Bool { true }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        highlight.isHidden = true
        addSubview(highlight)
        addSubview(anchor)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func unbind() {
        generation = UUID()
        text?.stop()
        text?.removeFromSuperview(); text = nil
        content?.stop(); content = nil
        chrome?.stop(); chrome = nil
        changed = nil
        item = nil
    }

    func bind(item: NativeTranscriptItem, width: CGFloat, row: ChatRow?, configuration: NativeTranscript,
              selection: @escaping (String) -> MessageTextSelection,
              changed: @escaping () -> Void) {
        if self.item != item || resource != configuration.resource {
            if resource == configuration.resource, case .text = row, let text {
                // Keep TextKit regions, never the previous message's work or state.
                generation = UUID()
                text.resetMessageBinding()
                self.changed = nil
            } else if resource == configuration.resource, content != nil {
                generation = UUID()
                self.changed = nil
            } else if resource == configuration.resource, chrome != nil {
                generation = UUID()
                self.changed = nil
            } else { unbind() }
        }
        self.item = item
        if case let .row(id) = item { anchor.rowID = id; anchor.isHidden = false }
        else { anchor.rowID = ""; anchor.isHidden = true }
        resource = configuration.resource
        let generation = generation
        let fenced: () -> Void = { [weak self] in
            guard self?.generation == generation else { return }
            changed()
        }
        self.changed = fenced
        let context = NativeRowContext(configuration: configuration, selection: selection,
            active: row?.id == configuration.presentation.liveRows.last(where: \.isWork)?.id && configuration.presentation.working,
            changed: fenced)
        if case let .text(id, source, timestamp) = row {
            content?.stop(); content = nil
            chrome?.stop(); chrome = nil
            if text == nil {
                let view = NativeMarkdownMessage()
                text = view; addSubview(view)
            }
            var environment = context.environment
            if let row { environment.nativeTranscriptMenu = nativeMessageMenu(row: row, environment: environment) }
            text?.update(source: source, timestamp: timestamp, streaming: id.hasPrefix("streaming-"),
                         selection: selection(id), environment: environment, changed: fenced)
            text?.setAccessibilityElement(true)
            text?.setAccessibilityRole(.group)
            text?.setAccessibilityLabel("Assistant message")
            var actions = [NSAccessibilityCustomAction(name: "Copy message", handler: {
                MessageCopyButton.copy(source); return true
            })]
            if let row, let entry = row.entryID, let rewind = environment.transcriptRewind {
                actions.append(NSAccessibilityCustomAction(name: "Restore to Here", handler: { [weak rewind] in
                    guard let rewind, !rewind.pending else { return false }
                    rewind.request(.restore, entryID: entry); return true
                }))
            }
            text?.setAccessibilityCustomActions(actions)
        } else if let row, let native = nativeContent(for: row) {
            text?.stop(); text = nil
            chrome?.stop(); chrome = nil
            if content?.nativeView !== native.nativeView {
                content?.stop()
                content = native
                addSubview(native.nativeView)
            }
            native.bind(row, context: context)
        } else {
            content?.stop(); content = nil
            text?.stop(); text?.removeFromSuperview(); text = nil
            let next: NativeTranscriptChrome
            switch item {
            case .header:
                let view = (chrome as? NativeHeaderChrome) ?? NativeHeaderChrome()
                view.update(configuration.header, context: context); next = view
            case .footer:
                let view = (chrome as? NativeFooterChrome) ?? NativeFooterChrome()
                view.update(configuration.footer, context: context); next = view
            case .earlier:
                let view = (chrome as? NativeEarlierChrome) ?? NativeEarlierChrome()
                view.update(loading: configuration.loadingEarlier, error: configuration.earlierError,
                            context: context, load: configuration.loadEarlier); next = view
            case .row:
                return // A removed row cannot mount stale content.
            }
            if chrome !== next {
                chrome?.stop(); chrome = next; addSubview(next)
            }
        }
        needsLayout = true
        fenced()
    }

    func measure(width: CGFloat) -> CGFloat {
        if let text { return max(1, text.measure(width: width)) }
        if let content { return max(1, content.measure(width: width)) }
        if let chrome { return max(1, chrome.measure(width: width)) }
        return 1
    }

    override func layout() {
        super.layout()
        let width = max(1, min(Theme.column, bounds.width - 56))
        let x = max(28, (bounds.width - width) / 2)
        let target = NSRect(x: x, y: 0, width: width, height: bounds.height)
        text?.frame = target
        content?.nativeView.frame = target
        chrome?.frame = target
        anchor.frame = target
        highlight.frame = target
    }

    func setHighlighted(_ shown: Bool, increasedContrast: Bool) {
        highlight.isHidden = !shown
        highlight.increasedContrast = increasedContrast
    }

    func activate() -> Bool { content?.activate() ?? chrome?.activate() ?? false }

    private func nativeContent(for row: ChatRow) -> (any NativeRowContent)? {
        switch row {
        case let .user(_, text, _) where SubagentNotification(message: text) == nil:
            return (content as? NativeUserMessage) ?? NativeUserMessage()
        case .user, .automatic, .question, .notice, .event:
            return (content as? NativeEventRow) ?? NativeEventRow()
        case .error:
            return (content as? NativeErrorRow) ?? NativeErrorRow()
        case .work, .tools, .thinking:
            return (content as? NativeWorkGroup) ?? NativeWorkGroup()
        case .artifact:
            return (content as? NativeArtifactRow) ?? NativeArtifactRow()
        case .text: return nil
        }
    }
}

private final class NativeTranscriptHighlight: NSView {
    var increasedContrast = false { didSet { if oldValue != increasedContrast { needsDisplay = true } } }
    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true; layer?.cornerRadius = Theme.Radius.row
        setAccessibilityElement(false)
    }
    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }
    override var wantsUpdateLayer: Bool { true }
    override func updateLayer() {
        effectiveAppearance.performAsCurrentDrawingAppearance {
            layer?.backgroundColor = NSColor(increasedContrast ? Theme.selected : Theme.keyboardHighlight).cgColor
        }
    }
    override func viewDidChangeEffectiveAppearance() { super.viewDidChangeEffectiveAppearance(); needsDisplay = true }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}
