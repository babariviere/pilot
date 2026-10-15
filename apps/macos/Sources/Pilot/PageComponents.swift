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
                    linkLabel(linkTitle, symbol: PilotIcon.disclosureOpen)
                }
                .chipMenuStyle()
                .fixedSize()
                .accessibilityLabel(linkTitle)
            } else if let linkTitle, let link {
                Button(action: link) {
                    linkLabel(linkTitle, symbol: PilotIcon.disclosure)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(linkTitle)
            }
        }
    }

    private func linkLabel(_ title: String, symbol: PilotIcon) -> some View {
        HStack(spacing: 3) {
            Text(title)
            PilotSymbol(symbol)
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
/// so it stays reachable from the keyboard and VoiceOver. Inside a `ditherCorner` the row draws no fill: its
/// corner recedes under the pointer instead, and selection stays the only row fill.
struct HoverRow<Content: View>: View {
    var horizontalPadding: CGFloat = 8
    var verticalPadding: CGFloat = 6
    @ViewBuilder let content: (Bool) -> Content
    @Environment(\.rowHasDitherCorner) private var hasCorner
    @State private var hovered = false

    var body: some View {
        content(hovered)
            .padding(.horizontal, horizontalPadding)
            .padding(.vertical, verticalPadding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: Theme.Radius.row).fill(hovered && !hasCorner ? Theme.muted : .clear))
            .contentShape(Rectangle())
            .onHover { hovered = $0 }
            .animation(Theme.Motion.quick, value: hovered)
    }
}

extension View {
    /// Shows secondary row controls only while the row is hovered, keeping their space so rows do not jump. A
    /// control that takes keyboard focus shows too, so tabbing through a row never lands on an invisible button.
    func revealed(_ visible: Bool) -> some View {
        modifier(RevealedModifier(visible: visible))
    }
}

private struct RevealedModifier: ViewModifier {
    let visible: Bool
    @FocusState private var focused: Bool

    func body(content: Content) -> some View {
        let shown = visible || focused
        content
            .focused($focused)
            .opacity(shown ? 1 : 0)
            .allowsHitTesting(shown)
    }
}

/// Hairline between list rows, inset to line up with the row text rather than its icon.
struct HairlineDivider: View {
    var leading: CGFloat = 0

    var body: some View {
        Rectangle().fill(Theme.border).frame(height: 1).padding(.leading, leading)
    }
}

/// One plain capsule bar split into coloured segments, such as tasks by status: no gaps between segments, no dither
/// and no animation. Zero segments are skipped; an empty bar shows the faint track (`Theme.border`), which is also the
/// colour for work not started. Describe the values in text next to it: the bar is hidden from VoiceOver.
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
            HStack(spacing: 0) {
                if total == 0 {
                    Rectangle().fill(Theme.border)
                } else {
                    ForEach(visible) { segment in
                        Rectangle().fill(segment.color)
                            .frame(width: max(0, geometry.size.width * CGFloat(segment.value) / CGFloat(total)))
                    }
                }
            }
        }
        .frame(height: height)
        .clipShape(Capsule())
        .accessibilityHidden(true)
    }
}

/// The legend under a `SegmentedProgressBar`: each count with a 7 pt dot in its segment's colour, in a muted caption
/// with monospaced digits. Pass only non-zero entries. Wraps onto a second line when the row is too narrow.
/// Hidden from VoiceOver like the bar: the parent states the same counts in words.
struct ProgressLegend: View {
    struct Entry: Identifiable {
        let id: String
        let text: String
        let color: Color
    }

    let entries: [Entry]

    var body: some View {
        ViewThatFits(in: .horizontal) {
            row(entries)
            VStack(alignment: .leading, spacing: 4) {
                let split = (entries.count + 1) / 2
                row(Array(entries.prefix(split)))
                row(Array(entries.dropFirst(split)))
            }
        }
        .font(.pilot(.caption))
        .monospacedDigit()
        .foregroundStyle(Theme.mutedForeground)
        .accessibilityHidden(true)
    }

    private func row(_ entries: [Entry]) -> some View {
        HStack(spacing: 12) {
            ForEach(entries) { entry in
                HStack(spacing: 5) {
                    // The hairline keeps the track-coloured "to do" dot visible on white.
                    Circle().fill(entry.color).overlay(Circle().strokeBorder(Theme.border, lineWidth: 1))
                        .frame(width: 7, height: 7)
                    Text(entry.text).lineLimit(1)
                }
                .fixedSize()
            }
        }
    }
}

/// Quoted external text, such as the Slack message in the triage inspector: a thin rule beside short, muted
/// supporting content. Keep quotes bounded and link to the source for the rest. Chat Markdown quotes use the
/// user's font settings in `MarkdownView` instead.
struct QuoteBlock<Content: View>: View {
    @ViewBuilder var content: () -> Content

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            RoundedRectangle(cornerRadius: 1).fill(Theme.faintForeground.opacity(0.5)).frame(width: 3)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) { content() }
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .fixedSize(horizontal: false, vertical: true)
    }
}

/// Centered empty state: a faint symbol, a short title, one sentence and the obvious next actions.
/// Use it where a whole pane, page or section is empty or failed to load (the warning symbol, the error as the
/// message and a "Retry" action); use a single quiet line inside busy pages. Panes add `.frame(maxHeight: .infinity)`
/// to centre it. Never tint the symbol: the state is in the words.
struct EmptyStateView<Actions: View>: View {
    let icon: PilotIcon
    let title: String
    let message: String
    @ViewBuilder var actions: () -> Actions

    init(icon: PilotIcon, title: String, message: String, @ViewBuilder actions: @escaping () -> Actions = { EmptyView() }) {
        self.icon = icon
        self.title = title
        self.message = message
        self.actions = actions
    }

    var body: some View {
        VStack(spacing: 8) {
            PilotSymbol(icon, context: .emptyState).foregroundStyle(Theme.faintForeground)
                .accessibilityHidden(true)
            Text(title).font(.pilot(.body, weight: .semibold)).foregroundStyle(Theme.foreground)
            Text(message).font(.pilot(.label)).foregroundStyle(Theme.mutedForeground)
                .multilineTextAlignment(.center).frame(maxWidth: 320)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
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
                .card(radius: Theme.Radius.control)
            HStack(spacing: 6) { controls() }
        }
        .padding(6)
        .background(RoundedRectangle(cornerRadius: Theme.Radius.tray).fill(Theme.tray))
    }
}

// MARK: - Page and sheet chrome

/// Header of a page or sheet: a 15 pt semibold title, an optional muted subtitle and a trailing accessory (a
/// status, a menu or one quiet action). Settings pages, Archived chats and every `SheetScaffold` use it, so
/// titles share one style. Titles use sentence case ("Edit schedule", "Rename chat").
struct PageHeader<Accessory: View>: View {
    let title: String
    var subtitle: String?
    @ViewBuilder var accessory: () -> Accessory

    init(_ title: String, subtitle: String? = nil, @ViewBuilder accessory: @escaping () -> Accessory = { EmptyView() }) {
        self.title = title
        self.subtitle = subtitle
        self.accessory = accessory
    }

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.pilot(.headline, weight: .semibold))
                    .foregroundStyle(Theme.foreground)
                    .lineLimit(1)
                    .accessibilityAddTraits(.isHeader)
                if let subtitle, !subtitle.isEmpty {
                    Text(subtitle)
                        .font(.pilot(.label))
                        .foregroundStyle(Theme.mutedForeground)
                        .lineLimit(2)
                        .textSelection(.enabled)
                }
            }
            Spacer(minLength: 12)
            accessory()
        }
    }
}

/// How the keyboard confirms a sheet's primary button.
enum SheetConfirmKey {
    /// ↩, for forms made of single-line fields.
    case `return`
    /// ⌘↩, for forms with a multi-line editor, where ↩ inserts a newline. The button shows the shortcut.
    case commandReturn
}

/// The primary button of a `SheetScaffold`, on the right of the footer after Cancel.
struct SheetPrimaryAction {
    let title: String
    var key: SheetConfirmKey = .return
    var enabled = true
    let action: () -> Void
}

/// The one sheet layout: a `PageHeader` (sentence-case title, optional subtitle and accessory), the content, an
/// inline error slot (`InlineProblem`) and a footer pinned to the bottom with optional leading controls, then Cancel
/// and the primary action on the right. Esc cancels. The primary confirms with ↩ for single-line forms and ⌘↩ when
/// the form holds a multi-line editor (`SheetConfirmKey`). Without a primary action the footer has a single Done.
struct SheetScaffold<Accessory: View, Content: View, FooterLeading: View>: View {
    let title: String
    var subtitle: String?
    var error: String?
    var primary: SheetPrimaryAction?
    /// Defaults to "Cancel" beside a primary action and "Done" alone.
    var cancelTitle: String?
    /// Defaults to dismissing the sheet.
    var cancel: (() -> Void)?
    /// Fixed width for forms. Nil lets the caller size browsing sheets with min and ideal frames.
    var width: CGFloat?
    /// Browsing sheets with scrolling content fill their height, so the footer stays at the bottom.
    var fillsHeight = false
    @ViewBuilder var accessory: () -> Accessory
    @ViewBuilder var content: () -> Content
    @ViewBuilder var footerLeading: () -> FooterLeading
    @Environment(\.dismiss) private var dismiss

    init(_ title: String, subtitle: String? = nil, error: String? = nil, primary: SheetPrimaryAction? = nil,
         cancelTitle: String? = nil, cancel: (() -> Void)? = nil, width: CGFloat? = 420, fillsHeight: Bool = false,
         @ViewBuilder accessory: @escaping () -> Accessory = { EmptyView() },
         @ViewBuilder content: @escaping () -> Content,
         @ViewBuilder footerLeading: @escaping () -> FooterLeading = { EmptyView() }) {
        self.title = title
        self.subtitle = subtitle
        self.error = error
        self.primary = primary
        self.cancelTitle = cancelTitle
        self.cancel = cancel
        self.width = width
        self.fillsHeight = fillsHeight
        self.accessory = accessory
        self.content = content
        self.footerLeading = footerLeading
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            PageHeader(title, subtitle: subtitle, accessory: accessory)
                .padding(.horizontal, 20)
                .padding(.top, 20)
                .padding(.bottom, 14)
            VStack(alignment: .leading, spacing: 14) { content() }
                .padding(.horizontal, 20)
                .frame(maxWidth: .infinity, maxHeight: fillsHeight ? .infinity : nil, alignment: .topLeading)
            if let error, !error.isEmpty {
                InlineProblem(error)
                    .padding(.horizontal, 20)
                    .padding(.top, 10)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            HStack(spacing: 8) {
                footerLeading()
                Spacer(minLength: 8)
                Button(cancelTitle ?? (primary == nil ? "Done" : "Cancel")) { (cancel ?? { dismiss() })() }
                    .keyboardShortcut(.cancelAction)
                if let primary { primaryButton(primary) }
            }
            .padding(.horizontal, 20)
            .padding(.top, 16)
            .padding(.bottom, 20)
        }
        .frame(width: width)
        .background(Theme.background)
    }

    @ViewBuilder private func primaryButton(_ primary: SheetPrimaryAction) -> some View {
        switch primary.key {
        case .return:
            Button(primary.title, action: primary.action)
                .keyboardShortcut(.defaultAction)
                .disabled(!primary.enabled)
        case .commandReturn:
            Button(action: primary.action) { ShortcutLabel(title: primary.title) }
                .keyboardShortcut(.return, modifiers: .command)
                .buttonStyle(.borderedProminent)
                .help("\(primary.title) (⌘↩)")
                .disabled(!primary.enabled)
        }
    }
}

/// Button title with its Command-Return shortcut, for sheets where Return inserts a newline.
struct ShortcutLabel: View {
    let title: String
    var body: some View {
        HStack(spacing: 6) {
            Text(title)
            Text("⌘↩").font(.pilot(.caption)).opacity(0.7)
        }
    }
}

/// Header of an inspector pane (Changes, Terminal, Agents, Artifacts, Links): its title or count, optional quiet
/// detail, an optional trailing control (such as refresh, in `QuietIconButtonStyle`) and a hairline below. The
/// inspector's tab bar hides the whole inspector, so panes never add their own close button.
struct InspectorPaneHeader<Detail: View, Trailing: View>: View {
    let title: String
    @ViewBuilder var detail: () -> Detail
    @ViewBuilder var trailing: () -> Trailing

    init(_ title: String, @ViewBuilder detail: @escaping () -> Detail = { EmptyView() },
         @ViewBuilder trailing: @escaping () -> Trailing = { EmptyView() }) {
        self.title = title
        self.detail = detail
        self.trailing = trailing
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Text(title)
                    .font(.pilot(.label, weight: .medium))
                    .foregroundStyle(Theme.foreground)
                    .lineLimit(1)
                    .accessibilityAddTraits(.isHeader)
                detail()
                Spacer(minLength: 8)
                trailing()
            }
            .padding(.horizontal, 12)
            .frame(minHeight: 32)
            HairlineDivider()
        }
    }
}

/// A problem shown in place: an error triangle, the message in muted text and an optional Retry. Use it for failed
/// loads, saves and lookups beside what failed, keeping the last data visible. The triangle uses `Theme.error`,
/// never amber, and the action is always "Retry". A whole pane that failed uses `EmptyStateView` with the
/// warning symbol and the same Retry.
struct InlineProblem: View {
    let message: String
    var retrying = false
    var retry: (() -> Void)?

    init(_ message: String, retrying: Bool = false, retry: (() -> Void)? = nil) {
        self.message = message
        self.retrying = retrying
        self.retry = retry
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            PilotSymbol(PilotIcon.warning)
                .foregroundStyle(Theme.error)
                .accessibilityHidden(true)
            Text(message)
                .font(.pilot(.caption))
                .foregroundStyle(Theme.mutedForeground)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityLabel("Error: \(message)")
            if let retry {
                Button("Retry", action: retry)
                    .controlSize(.small)
                    .disabled(retrying)
            }
        }
        .accessibilityElement(children: .contain)
    }
}

/// The chevron of a disclosure: points right when closed and down when open. Callers animate the change
/// (`Theme.Motion.quick`) and label the button that holds it with what it shows or hides.
struct DisclosureChevron: View {
    let expanded: Bool
    var tint: Color = Theme.faintForeground

    var body: some View {
        PilotSymbol(PilotIcon.disclosure, context: .disclosure)
            .foregroundStyle(tint)
            .rotationEffect(.degrees(expanded ? 90 : 0))
            .accessibilityHidden(true)
    }
}

/// "Show all N" / "Show fewer" under a bounded list that expands in place. A line that opens a full list somewhere
/// else names where it goes instead.
struct ListToggle: View {
    let total: Int
    @Binding var expanded: Bool
    /// Optional noun after the count, such as "merged" in "Show all 12 merged".
    var noun: String? = nil

    var body: some View {
        Button { expanded.toggle() } label: {
            Text(expanded ? "Show fewer" : ["Show all \(total)", noun].compactMap { $0 }.joined(separator: " "))
                .font(.pilot(.caption))
                .foregroundStyle(Theme.mutedForeground)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// Quiet metadata in a byline or row, such as a decision's audience, "Draft" or "Suggested": muted caption text with
/// no capsule. Capsules and badges are reserved for signals and counts.
struct MetaText: View {
    let text: String

    init(_ text: String) {
        self.text = text
    }

    var body: some View {
        Text(text)
            .font(.pilot(.caption))
            .foregroundStyle(Theme.mutedForeground)
            .lineLimit(1)
            .fixedSize()
    }
}
