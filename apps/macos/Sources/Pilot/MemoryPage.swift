import PilotCore
import SwiftUI

struct MemoryCompactionLine: View {
    let compaction: MemoryCompaction

    var body: some View {
        HStack(spacing: 7) {
            if compaction.state == .running || compaction.state == .pending {
                PilotSymbol(PilotIcon.working, context: .row).frame(width: 16)
            } else {
                PilotSymbol(compaction.state == .backoff ? PilotIcon.warning : PilotIcon.complete)
                    .foregroundStyle(compaction.state == .backoff ? Theme.error : Theme.faintForeground)
                    .frame(width: 16)
            }
            Text(message).font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                .lineLimit(2)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 8).padding(.vertical, 3)
        .accessibilityElement(children: .combine)
    }

    private var message: String {
        if compaction.state == .backoff { return "Compaction paused: \(compaction.error ?? "will retry automatically")" }
        if compaction.state == .running { return "Updating memory summaries…" }
        if compaction.state == .pending { return "\(compaction.pending) summaries waiting to build" }
        return "Memory summaries are up to date"
    }
}

/// A project's memory as a tree: top-level summaries with their ranges, nested summaries, then notes, newest first,
/// with guide lines so the shape reads at a glance. Search shows matching notes in place with their summaries. Opened
/// from the Overview's Memory section, the project's … menu and ⌘K. Wide windows add a detail column.
struct MemoryPage: View {
    let projectId: String
    @EnvironmentObject private var model: AppModel
    @ObservedObject private var client = AppModel.shared.client
    @StateObject private var state: MemoryPageModel
    @FocusState private var treeFocused: Bool
    @FocusState private var searchFocused: Bool

    /// Width from which the selected node's detail column shows beside the tree.
    static let detailBreakpoint: CGFloat = 980

    init(projectId: String) {
        self.projectId = projectId
        _state = StateObject(wrappedValue: MemoryPageModel(projectId: projectId, client: AppModel.shared.client))
    }

    var body: some View {
        Group {
            if let project = client.project(projectId) {
                GeometryReader { proxy in
                    content(wide: proxy.size.width >= Self.detailBreakpoint)
                }
                .navigationTitle("Memory")
                .navigationSubtitle(project.name)
                .toolbar {
                    ToolbarItem(placement: .navigation) {
                        Button { model.openProject(project.id) } label: { PilotSymbol(PilotIcon.back) }
                            .help("Back to \(project.name)")
                            .accessibilityLabel("Back to \(project.name)")
                    }
                }
            } else {
                EmptyStateView(icon: PilotIcon.project, title: "This project no longer exists",
                               message: "It was removed from Pilot. Its folder is unchanged.")
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.background)
        .dashboardSubscription(projectId, client: client)
        .task { await state.load() }
        .task(id: state.query) {
            guard !state.query.trimmingCharacters(in: .whitespaces).isEmpty else {
                state.clearSearch()
                return
            }
            try? await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled else { return }
            await state.search()
        }
        .onChange(of: memoryRevision) { state.scheduleRefresh() }
        .onDisappear { state.stop() }
        .confirmationDialog("Forget this summary?", isPresented: Binding(
            get: { state.forgetting != nil }, set: { if !$0 { state.cancelForget() } }
        ), titleVisibility: .visible) {
            Button("Forget summary", role: .destructive) { Task { await state.confirmForget() } }
            Button("Cancel", role: .cancel) { state.cancelForget() }
        } message: {
            Text("The original memory notes stay unchanged. This summary and summaries built from it will be rebuilt.")
        }
    }

    private var memory: ProjectMemorySummary? { client.projectDashboards[projectId]?.memory }

    /// Changes when notes are added or summaries rebuild, to refresh the tree in place.
    private var memoryRevision: MemoryRevision {
        MemoryRevision(count: memory?.count, state: memory?.compaction.state, pending: memory?.compaction.pending)
    }

    private func content(wide: Bool) -> some View {
        HStack(spacing: 0) {
            ScrollViewReader { scroller in
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        header
                        searchField.padding(.top, 16)
                        statusLine.padding(.top, 6)
                        if let error = state.error {
                            InlineProblem(error, retrying: state.busy) { Task { await state.refresh() } }
                                .padding(.horizontal, 8).padding(.vertical, 4)
                        }
                        tree.padding(.top, 4)
                    }
                    .padding(.horizontal, 32)
                    .padding(.vertical, 24)
                    .frame(maxWidth: Theme.column, alignment: .leading)
                    .frame(maxWidth: .infinity)
                }
                .onChange(of: state.selection) {
                    guard let key = state.selection, treeFocused else { return }
                    withAnimation(Theme.Motion.quick) { scroller.scrollTo(key) }
                }
            }
            if wide {
                Rectangle().fill(Theme.border).frame(width: 1)
                MemoryNodeDetail(state: state)
                    .frame(width: 320)
            }
        }
    }

    private var header: some View {
        let count = memory?.count ?? state.count
        return PageHeader("Memory", subtitle: "\(count) \(count == 1 ? "note" : "notes") from agents in this project, summarised as they grow.") {
            HStack(spacing: 2) {
                quietButton("Expand all") { Task { await state.expandAll() } }
                quietButton("Collapse all") { state.collapseAll() }
            }
            .disabled(state.rows.isEmpty)
        }
    }

    private func quietButton(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title).font(.pilot(.label)).foregroundStyle(Theme.mutedForeground)
                .padding(.horizontal, 8).padding(.vertical, 4)
                .contentShape(Rectangle())
        }
        .rowButtonStyle()
    }

    private var searchField: some View {
        HStack(spacing: 7) {
            PilotSymbol(PilotIcon.search).foregroundStyle(Theme.faintForeground)
            TextField("Search memories (regular expression)", text: $state.query)
                .textFieldStyle(.plain)
                .font(.pilot(.body))
                .focused($searchFocused)
                .onExitCommand { state.query = "" }
                .accessibilityLabel("Search project memories")
            if !state.query.isEmpty {
                Button { state.query = "" } label: {
                    PilotSymbol(PilotIcon.clearField, context: .toolbar).foregroundStyle(Theme.faintForeground)
                }
                .buttonStyle(.plain)
                .help("Clear search (Esc)")
                .accessibilityLabel("Clear search")
            }
        }
        .padding(.horizontal, 8)
        .frame(height: 28)
        .background(RoundedRectangle(cornerRadius: Theme.Radius.control).fill(Theme.card))
        .overlay(RoundedRectangle(cornerRadius: Theme.Radius.control).strokeBorder(Theme.border))
    }

    @ViewBuilder private var statusLine: some View {
        if let matches = state.matchCount, matches > 0 {
            Text("\(matches) matching \(matches == 1 ? "note" : "notes"), shown in the tree · Esc clears")
                .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                .padding(.horizontal, 8).padding(.vertical, 3)
        } else if let compaction = memory?.compaction {
            MemoryCompactionLine(compaction: compaction)
        }
        if let notice = state.notice {
            Text(notice).font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                .padding(.horizontal, 8).padding(.vertical, 3)
        }
    }

    @ViewBuilder private var tree: some View {
        if state.loading {
            ProgressView("Loading memory…").frame(maxWidth: .infinity, alignment: .leading).padding(8)
        } else if state.searching, state.rows.isEmpty {
            Text("No matching memories.").font(.pilot(.body)).foregroundStyle(Theme.mutedForeground)
                .padding(.horizontal, 8).padding(.vertical, 6)
        } else if state.rows.isEmpty, state.error == nil {
            EmptyStateView(icon: PilotIcon.memory, title: "No memories yet",
                           message: "Lasting project notes from agents will appear here.")
        } else {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(state.rows) { row in
                    if row.startsGroup { HairlineDivider() }
                    MemoryTreeRowView(row: row, selected: state.selection == row.id, focused: treeFocused,
                                      matches: state.matches?[row.id],
                                      toggle: { Task { await state.toggle(row.id) } },
                                      select: {
                                          state.selection = row.id
                                          treeFocused = true
                                      },
                                      forget: { state.requestForget(row.node) })
                        .id(row.id)
                }
            }
            .focusable()
            .focused($treeFocused)
            .focusEffectDisabled()
            .onKeyPress(keys: [.upArrow, .downArrow, .leftArrow, .rightArrow]) { press in
                guard press.modifiers.isDisjoint(with: [.command, .control, .option]) else { return .ignored }
                switch press.key {
                case .upArrow: state.moveSelection(by: -1)
                case .downArrow: state.moveSelection(by: 1)
                case .leftArrow: state.moveLeft()
                default: Task { await state.moveRight() }
                }
                return .handled
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Memory tree")
        }
    }
}

private struct MemoryRevision: Equatable {
    let count: Int?
    let state: MemoryCompaction.State?
    let pending: Int?
}

/// One row of the tree: guide lines, a chevron (summaries) or a dot (notes), the text clamped to two lines and its
/// metadata. Forget waits under the pointer and in the context menu.
private struct MemoryTreeRowView: View {
    let row: MemoryTreeRow
    let selected: Bool
    let focused: Bool
    let matches: Int?
    let toggle: () -> Void
    let select: () -> Void
    let forget: () -> Void
    @State private var hovered = false

    static let indent: CGFloat = 18
    /// Where the chevron's centre sits in its 16 pt column, and the first line's centre below the row's top.
    static let guideX: CGFloat = 8
    static let elbowY: CGFloat = 16

    var body: some View {
        let node = row.node
        HStack(alignment: .top, spacing: 6) {
            if row.expandable {
                Button(action: toggle) {
                    DisclosureChevron(expanded: row.expanded)
                        .frame(width: 16, height: 18)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(row.expanded ? "Collapse notes \(node.lo) through \(node.hi)"
                                                 : "Expand notes \(node.lo) through \(node.hi)")
            } else {
                PilotSymbol(PilotIcon.memoryEntry, filled: !node.isReplaced, context: .disclosure)
                    .foregroundStyle(Theme.faintForeground)
                    .frame(width: 16, height: 18)
                    .accessibilityHidden(true)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(node.title)
                    .font(.pilot(.body, weight: node.entry == nil && node.pending != true ? .medium : .regular))
                    .italic(node.pending == true)
                    .foregroundStyle(node.isReplaced || node.pending == true ? Theme.mutedForeground : Theme.foreground)
                    .lineLimit(2)
                    .lineSpacing(1)
                MemoryNodeMeta(node: node, matches: matches)
            }
            Spacer(minLength: 4)
            if node.canForget {
                Button(action: forget) { PilotSymbol(PilotIcon.delete, context: .toolbar) }
                    .rowIconButtonStyle(hoverTint: Theme.destructive)
                    .help("Forget this summary")
                    .accessibilityLabel("Forget summary for notes \(node.lo) through \(node.hi)")
                    .revealed(hovered || selected)
            }
        }
        .padding(.leading, CGFloat(row.depth) * Self.indent)
        .padding(.trailing, 6)
        .padding(.vertical, 7)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background {
            ZStack(alignment: .leading) {
                RoundedRectangle(cornerRadius: Theme.Radius.row).fill(selected ? Theme.selected : .clear)
                if selected, focused {
                    RoundedRectangle(cornerRadius: Theme.Radius.row).strokeBorder(Theme.focusRing.opacity(0.5), lineWidth: 2)
                }
                MemoryTreeGuides(row: row)
            }
        }
        .contentShape(Rectangle())
        .onTapGesture(perform: select)
        .onHover { hovered = $0 }
        .contextMenu {
            if node.canForget { Button("Forget Summary…", role: .destructive, action: forget) }
        }
        .help(node.pending == true ? "Summary is being built" : node.title)
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

/// The tree's indentation guides: a hairline under each open ancestor that continues below, and an elbow into this row.
private struct MemoryTreeGuides: View {
    let row: MemoryTreeRow

    var body: some View {
        Canvas { context, size in
            guard row.depth > 0 else { return }
            var path = Path()
            for (level, continues) in row.guides.enumerated() where continues {
                let x = CGFloat(level) * MemoryTreeRowView.indent + MemoryTreeRowView.guideX + 0.5
                path.move(to: CGPoint(x: x, y: 0))
                path.addLine(to: CGPoint(x: x, y: size.height))
            }
            let x = CGFloat(row.depth - 1) * MemoryTreeRowView.indent + MemoryTreeRowView.guideX + 0.5
            let y = MemoryTreeRowView.elbowY + 0.5
            path.move(to: CGPoint(x: x, y: 0))
            path.addLine(to: CGPoint(x: x, y: row.isLast ? y : size.height))
            path.move(to: CGPoint(x: x, y: y))
            path.addLine(to: CGPoint(x: x + 7, y: y))
            context.stroke(path, with: .color(Theme.border), lineWidth: 1)
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// "#128–159 · 32 notes" for summaries, "#7 · 3d ago · Replaced by #9" for notes, and "· 2 matches" while searching.
/// The exact date is in the tooltip.
private struct MemoryNodeMeta: View {
    let node: MemoryNode
    var matches: Int?

    var body: some View {
        HStack(spacing: 0) {
            if let entry = node.entry {
                Text("#\(entry.index) · \(RelativeDate.ago(entry.at))").foregroundStyle(Theme.faintForeground)
                if let label = entry.replacedLabel {
                    Text(" · \(label)").foregroundStyle(Theme.mutedForeground)
                }
            } else {
                Text(node.rangeLabel).foregroundStyle(Theme.faintForeground)
            }
            if let matches, node.entry == nil {
                Text(" · \(matches) \(matches == 1 ? "match" : "matches")").foregroundStyle(Theme.mutedForeground)
            }
        }
        .font(.pilot(.caption)).lineLimit(1)
        .help(node.entry.map { RelativeDate.exact($0.at) } ?? "")
        .accessibilityElement(children: .combine)
    }
}

/// The selected node in full: its text, range and children (the halves a summary was built from, or its notes).
private struct MemoryNodeDetail: View {
    @ObservedObject var state: MemoryPageModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                if let key = state.selection, let node = state.node(key) {
                    detail(node)
                        .task(id: key) { await state.ensureChildren(key) }
                } else {
                    Text("Select a summary or note.")
                        .font(.pilot(.caption)).foregroundStyle(Theme.faintForeground)
                }
            }
            .padding(.horizontal, 22).padding(.vertical, 26)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    @ViewBuilder private func detail(_ node: MemoryNode) -> some View {
        Text(node.entry.map { "Note · #\($0.index) · \(RelativeDate.ago($0.at))" } ?? "Summary · \(node.rangeLabel)")
            .font(.pilot(.caption)).foregroundStyle(Theme.faintForeground)
        Text(node.title)
            .font(.pilot(.body))
            .italic(node.pending == true)
            .foregroundStyle(node.pending == true ? Theme.mutedForeground : Theme.foreground)
            .lineSpacing(2)
            .textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.top, 8)
        if let replacedBy = node.entry?.replacedBy {
            Button { Task { await state.reveal(note: replacedBy) } } label: {
                Text("Replaced by #\(replacedBy)").underline()
            }
            .buttonStyle(.plain)
            .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
            .padding(.top, 6)
        }
        if node.entry == nil {
            let kids = state.children(of: node.key)
            Text(node.hi - node.lo + 1 > MemoryTreeShape.leafGroup ? "BUILT FROM" : "NOTES")
                .font(.pilot(.small, weight: .semibold)).foregroundStyle(Theme.faintForeground)
                .padding(.top, 18).padding(.bottom, 4)
                .accessibilityAddTraits(.isHeader)
            if let kids {
                ForEach(Array(kids.enumerated()), id: \.element.key) { index, kid in
                    if index > 0 { HairlineDivider() }
                    Button { state.select(kid.key) } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(kid.title).font(.pilot(.label))
                                .italic(kid.pending == true)
                                .foregroundStyle(kid.isReplaced || kid.pending == true ? Theme.mutedForeground : Theme.foreground)
                                .multilineTextAlignment(.leading)
                                .fixedSize(horizontal: false, vertical: true)
                            MemoryNodeMeta(node: kid)
                        }
                        .padding(.vertical, 7)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                    }
                    .rowButtonStyle()
                }
            } else {
                ProgressView().controlSize(.small)
            }
            if node.canForget {
                Button("Forget summary…") { state.requestForget(node) }
                    .destructiveOutlineButtonStyle()
                    .padding(.top, 20)
            }
        }
    }
}

extension MemoryNode {
    var key: String { "\(lo)-\(hi)" }

    /// "#128–159 · 32 notes"
    var rangeLabel: String {
        let count = hi - lo + 1
        return "#\(lo)–\(hi) · \(count) \(count == 1 ? "note" : "notes")"
    }

    /// A replaced note, or a summary whose notes were all replaced by later corrections.
    var isReplaced: Bool { replaced == true || entry?.replacedBy != nil }

    /// Only built summaries can be forgotten. Single-note leaves also carry text, but forgetting their
    /// one-entry range would drop the covering summaries rather than the note.
    var canForget: Bool { entry == nil && text != nil }

    /// Primary line: the note or summary text, otherwise a plain description of the range.
    var title: String {
        if let text = entry?.text ?? text { return text }
        if replaced == true { return "All notes here were replaced by later corrections" }
        if pending == true { return "Summary is being built…" }
        return "Memory range"
    }
}

extension MemoryEntry {
    var replacedLabel: String? { replacedBy.map { "Replaced by #\($0)" } }
}
