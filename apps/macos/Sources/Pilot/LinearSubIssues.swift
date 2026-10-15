import PilotCore
import SwiftUI

/// Linear rows with sub-issues attached under their parent. One nesting level: a grandchild joins the group of its
/// nearest ancestor in the list, or the read-only header of the nearest parent outside it. Groups keep the list's
/// order by their lead (a parent's own place, or a header's first child); children keep their order.
struct LinearIssueTree {
    enum Lead: Equatable {
        /// A row of the list, which may lead sub-issues.
        case item(TrackedItem)
        /// A parent outside the list: identifier, title and link only, never actions.
        case header(LinearParentHeader, projectId: String)
    }

    struct Group: Identifiable, Equatable {
        let lead: Lead
        let children: [TrackedItem]

        var id: String {
            switch lead {
            case let .item(item): item.id
            case let .header(header, projectId): "parent:\(projectId):\(header.id)"
            }
        }

        /// The tracked issues of the group, lead first.
        var items: [TrackedItem] {
            if case let .item(item) = lead { return [item] + children }
            return children
        }

        /// Status grouping applies to the lead; a header takes its first child's.
        var status: TrackedItemText.LinearGroup {
            items.first.map(TrackedItemText.linearGroup) ?? .todo
        }
    }

    static func build(_ items: [TrackedItem]) -> [Group] {
        func key(_ projectId: String, _ externalId: String) -> String { "\(projectId)\u{0}\(externalId)" }
        var index: [String: Int] = [:]
        for (position, item) in items.enumerated() where item.kind == .linear {
            index[key(item.projectId, item.externalId)] = index[key(item.projectId, item.externalId)] ?? position
        }
        enum Resolved { case root, item(Int), header(LinearParentHeader, String) }
        var resolved: [Int: Resolved] = [:]
        var resolving: Set<Int> = []
        // Memoized, so a (malformed) cycle still yields one consistent root.
        func resolve(_ position: Int) -> Resolved {
            if let done = resolved[position] { return done }
            let item = items[position]
            guard let parentId = item.linearParentId else { resolved[position] = .root; return .root }
            resolving.insert(position)
            defer { resolving.remove(position) }
            let result: Resolved
            if let parent = index[key(item.projectId, parentId)], parent != position, !resolving.contains(parent) {
                switch resolve(parent) {
                case .root: result = .item(parent)
                case let ancestor: result = ancestor
                }
            } else if let parent = index[key(item.projectId, parentId)], parent != position {
                result = .root
            } else if let header = item.linearParent, header.id == parentId {
                result = .header(header, item.projectId)
            } else {
                result = .root
            }
            resolved[position] = result
            return result
        }

        var groups: [String: (position: Int, lead: Lead, children: [TrackedItem])] = [:]
        for (position, item) in items.enumerated() {
            switch resolve(position) {
            case .root:
                let id = item.id
                let children = groups[id]?.children ?? []
                groups[id] = (position, .item(item), children)
            case let .item(parent):
                let lead = items[parent]
                groups[lead.id, default: (parent, .item(lead), [])].children.append(item)
            case let .header(header, projectId):
                let id = "parent:\(projectId):\(header.id)"
                groups[id, default: (position, .header(header, projectId: projectId), [])].children.append(item)
            }
        }
        return groups.values.sorted { $0.position < $1.position }.map { Group(lead: $0.lead, children: $0.children) }
    }
}

/// A parent's quiet "N sub-issues" and whether its children show.
struct SubIssueDisclosure {
    let count: Int
    let expanded: Bool
    let toggle: () -> Void

    var title: String { count == 1 ? "1 sub-issue" : "\(count) sub-issues" }
}

/// Layout shared by sub-issue rows and their connector.
enum SubIssueLayout {
    /// Children start one icon column further in.
    static let indent: CGFloat = 20
    /// The centre of a row icon: the row's padding plus half the 16 pt icon column.
    static let connectorX: CGFloat = 16
    /// Half an icon, so the parent's line starts below its glyph.
    static let iconGap: CGFloat = 9
}

/// Rows of a Linear list with sub-issues attached under their parent: indented, joined by a hairline through the
/// parent's icon column, and collapsible from the parent's count. `row` draws a tracked issue, given the disclosure
/// it should show when it leads sub-issues.
struct LinearIssueTreeRows<Row: View>: View {
    let groups: [LinearIssueTree.Group]
    @ViewBuilder let row: (TrackedItem, SubIssueDisclosure?) -> Row
    @State private var collapsed: Set<String> = []

    var body: some View {
        ForEach(Array(groups.enumerated()), id: \.element.id) { index, group in
            if index > 0 { HairlineDivider(leading: 34) }
            let expanded = !collapsed.contains(group.id)
            let disclosure = group.children.isEmpty ? nil : SubIssueDisclosure(
                count: group.children.count, expanded: expanded, toggle: { toggle(group.id) })
            VStack(alignment: .leading, spacing: 0) {
                lead(group, disclosure: disclosure)
                    .overlay {
                        if expanded, !group.children.isEmpty {
                            SubIssueConnector(part: .parent).stroke(Theme.border, lineWidth: 1)
                                .allowsHitTesting(false).accessibilityHidden(true)
                        }
                    }
                if expanded {
                    ForEach(Array(group.children.enumerated()), id: \.element.id) { position, child in
                        row(child, nil)
                            .padding(.leading, SubIssueLayout.indent)
                            .overlay {
                                SubIssueConnector(part: .child(last: position == group.children.count - 1))
                                    .stroke(Theme.border, lineWidth: 1)
                                    .allowsHitTesting(false).accessibilityHidden(true)
                            }
                    }
                }
            }
        }
    }

    @ViewBuilder private func lead(_ group: LinearIssueTree.Group, disclosure: SubIssueDisclosure?) -> some View {
        switch group.lead {
        case let .item(item): row(item, disclosure)
        case let .header(header, _): LinearParentHeaderRow(header: header, disclosure: disclosure)
        }
    }

    private func toggle(_ id: String) {
        withAnimation(Theme.Motion.quick) {
            if collapsed.contains(id) { collapsed.remove(id) } else { collapsed.insert(id) }
        }
    }
}

/// A parent issue that is not one of my tracked issues: identifier, title and a link to Linear (desktop app, else
/// the browser). Read-only: no start, link or dismiss actions, and nothing else about the issue.
struct LinearParentHeaderRow: View {
    let header: LinearParentHeader
    let disclosure: SubIssueDisclosure?

    var body: some View {
        HoverRow(verticalPadding: 6) { _ in
            HStack(spacing: 10) {
                Button(action: open) {
                    HStack(spacing: 10) {
                        PilotSymbol(PilotIcon.linearIssue, context: .row).foregroundStyle(Theme.faintForeground)
                            .frame(width: 16)
                        Text(header.identifier).font(.pilot(.caption)).monospacedDigit()
                            .foregroundStyle(Theme.faintForeground).fixedSize()
                        Text(header.title).font(.pilot(.body)).foregroundStyle(Theme.mutedForeground).lineLimit(1)
                        Spacer(minLength: 8)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help("Parent issue, not assigned to you. Opens in Linear.")
                .accessibilityLabel("Parent issue \(header.identifier), \(header.title)")
                .accessibilityHint("Opens in Linear")
                if let disclosure { SubIssueToggle(disclosure: disclosure, parent: header.identifier) }
            }
        }
    }

    private func open() {
        if let url = trackedBrowserURL(header.url) { BrowserLinkOpener.shared.open(url) }
    }
}

/// "N sub-issues" with a chevron, quiet, on a parent row. Shows or hides the children.
struct SubIssueToggle: View {
    let disclosure: SubIssueDisclosure
    /// The parent's identifier, for VoiceOver.
    let parent: String

    var body: some View {
        Button(action: disclosure.toggle) {
            HStack(spacing: 4) {
                Text(disclosure.title).font(.pilot(.caption)).monospacedDigit()
                DisclosureChevron(expanded: disclosure.expanded, tint: Theme.faintForeground)
            }
            .foregroundStyle(Theme.faintForeground)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .fixedSize()
        .help(disclosure.expanded ? "Hide sub-issues" : "Show sub-issues")
        .accessibilityLabel("\(disclosure.title) of \(parent)")
        .accessibilityValue(disclosure.expanded ? "Shown" : "Hidden")
    }
}

/// The hairline joining sub-issues to their parent, drawn in the parent's icon column. The parent's part runs from
/// below its icon to its bottom edge; each child's runs down its row with a short tick to its icon, and the last
/// child's stops at the tick.
struct SubIssueConnector: Shape {
    enum Part: Equatable {
        case parent
        case child(last: Bool)
    }

    let part: Part

    func path(in rect: CGRect) -> Path {
        var path = Path()
        let x = rect.minX + SubIssueLayout.connectorX + 0.5
        switch part {
        case .parent:
            path.move(to: CGPoint(x: x, y: rect.midY + SubIssueLayout.iconGap))
            path.addLine(to: CGPoint(x: x, y: rect.maxY))
        case let .child(last):
            path.move(to: CGPoint(x: x, y: rect.minY))
            path.addLine(to: CGPoint(x: x, y: last ? rect.midY : rect.maxY))
            path.move(to: CGPoint(x: x, y: rect.midY))
            path.addLine(to: CGPoint(x: x + SubIssueLayout.indent - 6, y: rect.midY))
        }
        return path
    }
}
