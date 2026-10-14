import SwiftUI

// Shared building blocks for calm status pages (missions first): lists without boxes, hairline
// separators, controls revealed on hover, one empty-state shape and a composer-style input tray.
// Prefer these over cards: group with whitespace and section headers, not borders.

/// Header for a section of a status page: 13 pt semibold in the foreground colour, an optional count
/// and a quiet trailing link (such as "All tasks"). A link with several destinations (such as one Slack
/// triage per project) is the same quiet text opening a menu of them. Pane and sidebar groups keep
/// `SectionLabel`.
struct PageSectionHeader: View {
    let title: String
    var count: Int? = nil
    var countStyle: CountBadge.Style = .neutral
    var linkTitle: String? = nil
    var link: (() -> Void)? = nil
    /// When not empty, the link opens a menu of these instead of calling `link`.
    var linkChoices: [PageSectionLinkChoice] = []

    var body: some View {
        HStack(spacing: 6) {
            Text(title).font(.pilot(.body, weight: .semibold)).foregroundStyle(Theme.foreground)
                .accessibilityAddTraits(.isHeader)
            if let count, count > 0 { CountBadge(count: count, style: countStyle) }
            Spacer(minLength: 8)
            if let linkTitle, !linkChoices.isEmpty {
                Menu {
                    ForEach(linkChoices) { choice in Button(choice.title, action: choice.action) }
                } label: {
                    linkLabel(linkTitle, symbol: "chevron.down")
                }
                .chipMenuStyle()
                .fixedSize()
                .accessibilityLabel(linkTitle)
            } else if let linkTitle, let link {
                Button(action: link) {
                    linkLabel(linkTitle, symbol: "chevron.right")
                }
                .buttonStyle(.plain)
                .accessibilityLabel(linkTitle)
            }
        }
    }

    private func linkLabel(_ title: String, symbol: String) -> some View {
        HStack(spacing: 3) {
            Text(title)
            Image(systemName: symbol).font(.pilot(.glyph, weight: .semibold))
        }
        .font(.pilot(.caption))
        .foregroundStyle(Theme.mutedForeground)
        .contentShape(Rectangle())
    }
}

/// One destination of a section header link that leads to several places.
struct PageSectionLinkChoice: Identifiable {
    let id: String
    let title: String
    let action: () -> Void
}

/// A list row with a soft fill under the pointer. The content closure receives the hover state so rows
/// can reveal secondary controls with `revealed(_:)`. Put every revealed action in a context menu too,
/// so it stays reachable from the keyboard and VoiceOver.
struct HoverRow<Content: View>: View {
    var horizontalPadding: CGFloat = 8
    var verticalPadding: CGFloat = 6
    @ViewBuilder let content: (Bool) -> Content
    @State private var hovered = false

    var body: some View {
        content(hovered)
            .padding(.horizontal, horizontalPadding)
            .padding(.vertical, verticalPadding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 7).fill(hovered ? Theme.muted : .clear))
            .contentShape(Rectangle())
            .onHover { hovered = $0 }
            .animation(Theme.Motion.quick, value: hovered)
    }
}

extension View {
    /// Shows secondary row controls only while the row is hovered, keeping their space so rows do not jump.
    func revealed(_ visible: Bool) -> some View {
        opacity(visible ? 1 : 0).allowsHitTesting(visible)
    }
}

/// Hairline between list rows, inset to line up with the row text rather than its icon.
struct HairlineDivider: View {
    var leading: CGFloat = 0

    var body: some View {
        Rectangle().fill(Theme.border).frame(height: 1).padding(.leading, leading)
    }
}

/// A capsule bar split into coloured segments, such as tasks by status. Zero segments are skipped;
/// an empty bar shows the track. Describe the values in text next to it: the bar is hidden from VoiceOver.
struct SegmentedProgressBar: View {
    struct Segment: Identifiable {
        let id: String
        let value: Int
        let color: Color
    }

    let segments: [Segment]
    var height: CGFloat = 6

    var body: some View {
        let visible = segments.filter { $0.value > 0 }
        let total = visible.reduce(0) { $0 + $1.value }
        GeometryReader { geometry in
            let gaps = CGFloat(max(0, visible.count - 1)) * 2
            HStack(spacing: 2) {
                if total == 0 {
                    Capsule().fill(Theme.border)
                } else {
                    ForEach(visible) { segment in
                        Capsule().fill(segment.color)
                            .frame(width: max(0, (geometry.size.width - gaps) * CGFloat(segment.value) / CGFloat(total)))
                    }
                }
            }
        }
        .frame(height: height)
        .accessibilityHidden(true)
    }
}

/// Centered empty state: a faint symbol, a short title, one sentence and the obvious next actions.
/// Use it where a whole pane or section is empty; use a single quiet line inside busy pages.
struct EmptyStateView<Actions: View>: View {
    let icon: String
    let title: String
    let message: String
    @ViewBuilder var actions: () -> Actions

    init(icon: String, title: String, message: String, @ViewBuilder actions: @escaping () -> Actions = { EmptyView() }) {
        self.icon = icon
        self.title = title
        self.message = message
        self.actions = actions
    }

    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: icon).font(.pilot(.title)).foregroundStyle(Theme.faintForeground)
                .accessibilityHidden(true)
            Text(title).font(.pilot(.body, weight: .semibold)).foregroundStyle(Theme.foreground)
            Text(message).font(.pilot(.label)).foregroundStyle(Theme.mutedForeground)
                .multilineTextAlignment(.center).frame(maxWidth: 320)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 8) { actions() }.padding(.top, 4)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 28)
        .accessibilityElement(children: .contain)
    }
}

/// The composer look outside chats: a white editor card on the opaque tray, with a row of chips and a
/// send button below. Used for mission updates, brief comments and coordinator instructions.
struct ComposerTray<Editor: View, Controls: View>: View {
    @ViewBuilder var editor: () -> Editor
    @ViewBuilder var controls: () -> Controls

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            editor()
                .textFieldStyle(.plain)
                .font(.pilot(.body))
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .topLeading)
                .card(radius: 8)
            HStack(spacing: 6) { controls() }
        }
        .padding(6)
        .background(RoundedRectangle(cornerRadius: 12).fill(Theme.tray))
    }
}
