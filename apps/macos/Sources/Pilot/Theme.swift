import AppKit
import PilotCore
import SwiftUI

/// Design tokens, after Berth's palette. Every colour follows the window's appearance (`Color(light:dark:)`):
///
/// - Light: white surfaces, a neutral-50 sidebar, 8% black hairlines, 4% black fills, neutral-800 text and dark
///   primary buttons.
/// - Dark: soft, low-contrast greys rather than near-black. A neutral-800 page over a slightly darker sidebar, lifted
///   grey cards and trays, 8% white hairlines, 5% white fills, neutral-300 text and light primary buttons.
///
/// Views use these tokens instead of literal or system colours, so both appearances stay consistent. Signal fills
/// (`info`, `success`, `warning`, `destructive`) keep one hue in both; text-weight colours lighten in dark.
enum Theme {
    /// Readable line length for the transcript and composer.
    static let column: CGFloat = 760
    /// Readable width of settings pages; wider settings windows center the page.
    static let settingsColumn: CGFloat = 680

    static let background = Color(light: 0xFFFFFF, dark: 0x262626)
    static let sidebar = Color(light: 0xFAFAFA, dark: 0x202020)
    static let foreground = Color(light: 0x262626, dark: 0xD4D4D4)
    static let mutedForeground = Color(light: 0x6B6B6B, dark: 0x9A9A9A)
    static let faintForeground = Color(light: 0xA3A3A3, dark: 0x6B6B6B)
    static let border = Color(light: .black.withAlphaComponent(0.08), dark: .white.withAlphaComponent(0.08))
    static let muted = Color(light: .black.withAlphaComponent(0.04), dark: .white.withAlphaComponent(0.05))
    static let selected = Color(light: .black.withAlphaComponent(0.06), dark: .white.withAlphaComponent(0.08))
    static let card = Color(light: 0xFFFFFF, dark: 0x303030)
    /// Opaque tray behind composers. Holds the editor card and its controls.
    static let tray = Color(light: 0xF5F5F5, dark: 0x2C2C2C)
    static let code = Color(light: 0xFAFAFA, dark: 0x2C2C2C)
    /// Fill of primary actions (the composers' send button, a ticked answer, a strong key cap).
    static let primary = Color(light: 0x262626, dark: 0xD4D4D4)
    /// Text and symbols drawn on `primary`.
    static let onPrimary = Color(light: 0xFFFFFF, dark: 0x262626)
    /// Fill of a disabled primary action.
    static let disabledFill = Color(light: .black.withAlphaComponent(0.15), dark: .white.withAlphaComponent(0.15))
    /// Symbols drawn on `disabledFill`.
    static let onDisabledFill = Color(light: 0xFFFFFF, dark: 0x8A8A8A)
    /// Soft halo behind text drawn over a dithered scene (Home's sky, the empty Inbox), so it stays readable.
    static let halo = background
    /// Behind inline artifacts, which are light documents with transparent pages: nothing in light, white in dark.
    static let artifactPaper = Color(light: .clear, dark: .white)
    /// Inline message links keep the text ink; only their title underline changes on hover.
    enum LinkUnderline {
        static let ink = Theme.foreground.opacity(0.18)
        static let thickness: CGFloat = 1
        static let baselineOffset: CGFloat = 5
    }
    /// Keyboard focus ring on rows and row buttons (`focusRing(_:radius:outset:)`). Follows the system accent.
    static let focusRing = Color(nsColor: .keyboardFocusIndicatorColor)
    /// The insertion line while a dragged row hovers over a list, such as tasks in a mission's Tasks tab. Follows the
    /// system accent like native list drops.
    static let dropIndicator = Color(nsColor: .controlAccentColor)

    static let info = Color(hex: 0x3B82F6)
    static let success = Color(hex: 0x10B981)
    static let warning = Color(hex: 0xF59E0B)
    static let destructive = Color(hex: 0xEF4444)
    /// Errors: failed loads, saves and lookups (`InlineProblem`'s triangle, an error's own text). Text-weight red,
    /// readable on the page. Errors never use `warning` or `blocked` amber, which stay for things the user can act on.
    static let error = Color(light: 0xDC2626, dark: 0xF87171)
    /// Soft indigo for live work in the sidebar's dithered corners (`DitherCorner`). Distinct from the attention
    /// colors, so working rows read as activity without asking for the user.
    static let working = Color(light: 0x6366F1, dark: 0x818CF8)
    /// Deeper indigo for live work drawn as small marks, such as the lit dot of `EllipsisSpinner`, where the
    /// softer `working` sits too close in lightness to the grey around it to read at a glance.
    static let workingInk = Color(light: 0x4F46E5, dark: 0xA5B4FC)
    /// Text-weight amber for blockers the user can act on, such as a PR blocked from merging or a
    /// scheduled item that could not start. Readable on the page, unlike `warning` in light.
    static let blocked = Color(light: 0xB45309, dark: 0xFBBF24)

    /// Pull request states, text-weight: open green, merged violet, closed red, like GitHub.
    static let pullRequestOpen = Color(light: 0x15803D, dark: 0x4ADE80)
    static let pullRequestMerged = Color(light: 0x7C3AED, dark: 0xA78BFA)
    static let pullRequestClosed = Color(light: 0xB91C1C, dark: 0xF87171)

    /// Syntax colors with contrast against the code surface in either appearance.
    static func syntaxColor(_ kind: CodeSyntax.Kind?) -> Color {
        switch kind {
        case .keyword: syntaxKeyword
        case .string: syntaxString
        case .number, .literal: syntaxNumber
        case .comment: mutedForeground
        case .function: syntaxFunction
        case nil: foreground
        }
    }

    private static let syntaxKeyword = Color(light: 0x7C3AED, dark: 0xC4B5FD)
    private static let syntaxString = Color(light: 0x166534, dark: 0x86EFAC)
    private static let syntaxNumber = Color(light: 0x9A3412, dark: 0xFDBA74)
    private static let syntaxFunction = Color(light: 0x1D4ED8, dark: 0x93C5FD)

    /// Corner radii. Pick by what the shape is, not by its size, and use `RoundedRectangle(cornerRadius:)` with one
    /// of these rather than a literal.
    ///
    /// - `small`: key caps, checkboxes and other tiny marks.
    /// - `row`: list, sidebar and menu rows (selection, hover and focus), tabs and icon buttons inside rows.
    /// - `control`: chips, inline controls, code blocks, images and cards nested in another surface.
    /// - `card`: cards and panels.
    /// - `bubble`: message bubbles, including scheduled ones.
    /// - `tray`: composer trays, popover panels and large standalone cards.
    enum Radius {
        static let small: CGFloat = 4
        static let row: CGFloat = 6
        static let control: CGFloat = 8
        static let card: CGFloat = 10
        static let bubble: CGFloat = 12
        static let tray: CGFloat = 14
    }

    /// Type scale for app chrome: sidebars, cards, panes, badges and metadata.
    ///
    /// Use `.font(.pilot(.caption))` instead of `.system(size:)` literals, and vary weight or design
    /// through the arguments rather than picking an in-between size. Chat and code content follow the
    /// user's font settings through `PilotFonts` instead; this scale is fixed.
    ///
    /// - `display`: one large figure per card, such as a total.
    /// - `title`: large decorative symbols, such as empty-state icons.
    /// - `headline`: the lead line of a status page, such as a mission goal.
    /// - `body`: primary row text, titles and empty-state messages.
    /// - `label`: pane headers, controls and short supporting text.
    /// - `caption`: metadata, secondary row lines, paths and inline errors.
    /// - `small`: badges, counts, pills and uppercase section labels.
    /// - `micro`: chart axes and small inline symbols, such as disclosure chevrons.
    /// - `glyph`: the smallest inline symbols inside pills. Never use it for words.
    enum TextRole: CaseIterable {
        case display, title, headline, body, label, caption, small, micro, glyph

        var size: CGFloat {
            switch self {
            case .display: 26
            case .title: 22
            case .headline: 15
            case .body: 13
            case .label: 12
            case .caption: 11
            case .small: 10
            case .micro: 9
            case .glyph: 8
            }
        }
    }
}

extension Font {
    /// A font from the chrome type scale. See `Theme.TextRole`.
    static func pilot(_ role: Theme.TextRole, weight: Font.Weight = .regular, design: Font.Design = .default) -> Font {
        .system(size: role.size, weight: weight, design: design)
    }
}

extension Color {
    init(hex: UInt32) {
        self.init(nsColor: NSColor(hex: hex))
    }

    /// A colour that follows the appearance it is drawn in, for SwiftUI and, through `NSColor(_:)`, AppKit text.
    init(light: NSColor, dark: NSColor) {
        self.init(nsColor: NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? dark : light
        })
    }

    init(light: UInt32, dark: UInt32) {
        self.init(light: NSColor(hex: light), dark: NSColor(hex: dark))
    }
}

extension NSColor {
    convenience init(hex: UInt32) {
        self.init(
            srgbRed: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: 1
        )
    }
}

extension String {
    /// `/Users/me/src/x` -> `~/src/x`
    var abbreviatingHome: String {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return hasPrefix(home) ? "~" + dropFirst(home.count) : self
    }
}

extension View {
    /// Card surface with a hairline border.
    func card(radius: CGFloat = Theme.Radius.card, shadow: Bool = false) -> some View {
        background(
            RoundedRectangle(cornerRadius: radius)
                .fill(Theme.card)
                .shadow(color: .black.opacity(shadow ? 0.06 : 0), radius: 12, y: 4)
        )
        .overlay(RoundedRectangle(cornerRadius: radius).strokeBorder(Theme.border))
    }

    /// Soft shadow below folded content, such as collapsed messages and clipped inline
    /// artifacts, signalling that there is more to read. Cast it from an opaque shape.
    func foldedShadow() -> some View {
        shadow(color: .black.opacity(0.065), radius: 8, x: 0, y: 6)
    }
}

/// Circular icon button used by composers. The primary fill by default, like Berth's primary buttons. Pass a
/// `foreground` with a signal `tint`, such as white on `destructive`.
struct CircleIconButtonStyle: ButtonStyle {
    var tint: Color = Theme.primary
    var foreground: Color = Theme.onPrimary

    func makeBody(configuration: Configuration) -> some View {
        CircleIconButton(configuration: configuration, tint: tint, foreground: foreground)
    }

    private struct CircleIconButton: View {
        let configuration: ButtonStyleConfiguration
        let tint: Color
        let foreground: Color
        @Environment(\.isEnabled) private var isEnabled

        var body: some View {
            configuration.label
                .font(.pilot(.label, weight: .bold))
                .foregroundStyle(isEnabled ? foreground : Theme.onDisabledFill)
                .frame(width: 26, height: 26)
                .background(Circle().fill(isEnabled ? tint : Theme.disabledFill))
                .opacity(configuration.isPressed ? 0.75 : 1)
                .contentShape(Circle())
        }
    }
}

/// Small rounded chip used for pickers in composers. Pair it with chipMenuStyle().
///
/// Every composer picker (project, branch, model, thinking, workspace) uses this label, so they
/// read as the same kind of control: a muted fill, a leading symbol and a trailing chevron.
struct ChipLabel: View {
    let title: String
    var icon: PilotIcon? = nil
    var dot: Color?
    var mark: PilotMark?
    /// Long titles, such as model names, truncate in the middle beyond this width.
    var maxTitleWidth: CGFloat? = nil
    var loading = false

    var body: some View {
        HStack(spacing: 5) {
            if let dot {
                Circle().fill(dot).frame(width: 6, height: 6)
            } else if let mark {
                PilotMarkIcon(mark: mark, context: .toolbar)
            } else if let icon {
                PilotSymbol(icon)
            }
            Text(title)
                .foregroundStyle(Theme.foreground)
                .lineLimit(1)
                .truncationMode(.middle)
                .frame(maxWidth: maxTitleWidth, alignment: .leading)
            if loading {
                ProgressView().controlSize(.mini)
            } else {
                PilotSymbol(PilotIcon.popUp, context: .disclosure).opacity(0.6)
            }
        }
        .font(.pilot(.label))
        .foregroundStyle(Theme.mutedForeground)
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(RoundedRectangle(cornerRadius: Theme.Radius.control).fill(Theme.muted))
        .contentShape(RoundedRectangle(cornerRadius: Theme.Radius.control))
    }
}

extension View {
    /// Menu style for menus labelled with ChipLabel.
    ///
    /// The borderless button menu style turns a SwiftUI label into an AppKit pop-up title with at most
    /// one image, which drops the chip's fill and chevron (or shows only the chevron). A plain
    /// button-style menu renders the label as written.
    func chipMenuStyle() -> some View {
        menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden)
    }
}

/// Small count next to a title, such as a section, card or project header.
///
/// - neutral: how many items a group holds or how many are working.
/// - attention: items that need the user, such as mission questions.
struct CountBadge: View {
    enum Style { case neutral, attention }

    let count: Int
    var style: Style = .neutral

    var body: some View {
        Text("\(count)")
            .font(.pilot(.small, weight: .semibold))
            .monospacedDigit()
            .foregroundStyle(style == .attention ? Color.white : Theme.mutedForeground)
            .padding(.horizontal, 5)
            .padding(.vertical, 1)
            .background(Capsule().fill(style == .attention ? Theme.warning : Theme.muted))
            .fixedSize()
    }
}

/// Title-case header for a group of rows in panes and cards, with an optional symbol and count.
/// Use it instead of uppercase labels so section headers read the same across the app.
struct SectionLabel: View {
    let title: String
    var icon: PilotIcon? = nil
    var count: Int? = nil

    var body: some View {
        HStack(spacing: 6) {
            if let icon { PilotSymbol(icon) }
            Text(title).font(.pilot(.label, weight: .medium))
            if let count, count > 0 { CountBadge(count: count) }
        }
        .foregroundStyle(Theme.mutedForeground)
    }
}

/// Colored agent status symbol, with details available without adding row text.
struct SessionStatusIcon: View {
    let status: SessionStatus

    var body: some View {
        PilotSymbol(status.icon, context: .row)
            .symbolRenderingMode(.monochrome)
            .foregroundStyle(status.color)
            .frame(width: 14, height: 14)
            // SF Symbols have different intrinsic baselines. Center every symbol on
            // the cap height of the 13-point session title, not on a subtitle row.
            .alignmentGuide(.firstTextBaseline) { dimensions in
                dimensions[VerticalAlignment.center] + NSFont.systemFont(ofSize: 13).capHeight / 2
            }
            .help(status.rawValue)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Agent status: \(status.rawValue)")
    }
}

extension SessionStatus {
    var icon: PilotIcon {
        switch self {
        case .working: PilotIcon.working
        case .question: PilotIcon.question
        case .done: PilotIcon.complete
        case .failed: PilotIcon.warning
        case .stopped: PilotIcon.stopped
        case .idle: PilotIcon.idle
        case .paused, .usagePaused, .offlinePaused: PilotIcon.paused
        }
    }

    var color: Color {
        switch self {
        case .working: Theme.working
        case .question: Theme.warning
        case .done: Theme.success
        case .failed: Theme.destructive
        default: Theme.mutedForeground
        }
    }
}

struct UnreadBadge: View {
    var body: some View {
        Circle().fill(Theme.info).frame(width: 7, height: 7)
            .accessibilityLabel("Unread result")
            .help("Unread result. Open this chat or mark it as reviewed.")
    }
}

/// Symbol and colour of each scheduled item state, used the same way on Home, the project page (including
/// its Needs you row) and in the target chat. Only an item that could not start takes a signal colour.
extension ScheduleState {
    var icon: PilotIcon {
        switch self {
        case .pending, .dispatching: PilotIcon.scheduled
        case .fired: PilotIcon.done
        case .failed: PilotIcon.scheduleFailed
        case .cancelled: PilotIcon.cancelled
        }
    }

    var color: Color {
        switch self {
        case .failed: Theme.blocked
        case .pending, .dispatching, .fired, .cancelled: Theme.mutedForeground
        }
    }

    var accessibilityLabel: String {
        switch self {
        case .pending: "Scheduled"
        case .dispatching: "Starting"
        case .fired: "Started"
        case .failed: "Couldn’t start"
        case .cancelled: "Cancelled"
        }
    }
}

/// Severity dot of a Slack message in triage, Inbox and tracked rows. Only critical and high take a signal
/// colour; always pair the dot with the severity in text or VoiceOver.
extension SlackSeverity {
    var color: Color {
        switch self {
        case .critical: Theme.destructive
        case .high: Theme.warning
        case .medium: Theme.mutedForeground
        case .low: Theme.faintForeground.opacity(0.6)
        }
    }
}

// MARK: - Motion

extension Theme {
    /// Shared animation timing. Pass the Reduce Motion environment value: movement then becomes a
    /// short crossfade instead.
    ///
    /// - quick: hover feedback and small disclosure toggles.
    /// - standard: items entering, leaving or reflowing a list, such as queued messages.
    enum Motion {
        static let quick = Animation.easeOut(duration: 0.15)
        /// Newly streamed text fades in over this long, ease-out (Core Animation, opacity only).
        static let streamedTextFade: CFTimeInterval = 0.24
        /// Running tool titles: one sweep of the shimmer band and its rest, and the background veil's opacity, which
        /// turns `foreground` text into `mutedForeground` outside the band in both appearances.
        static let shimmerLoop: CFTimeInterval = 1.8
        static let shimmerVeil = 0.33
        /// Content a disclosure opens is uncovered from the top over this long (Core Animation, no height animation).
        static let expandReveal: CFTimeInterval = 0.18

        static func standard(reduceMotion: Bool) -> Animation {
            reduceMotion ? .easeInOut(duration: 0.15) : .snappy(duration: 0.28, extraBounce: 0.04)
        }

        /// List rows that slide up into place and fade out when removed.
        static func insertion(reduceMotion: Bool) -> AnyTransition {
            reduceMotion
                ? .opacity
                : .asymmetric(
                    insertion: .move(edge: .bottom).combined(with: .opacity),
                    removal: .scale(scale: 0.97, anchor: .top).combined(with: .opacity)
                )
        }

        /// A tray replacing another in place, such as an agent question replacing the composer: the new tray grows
        /// up from the bottom edge while the old one fades.
        static func replacement(reduceMotion: Bool) -> AnyTransition {
            reduceMotion
                ? .opacity
                : .asymmetric(
                    insertion: .scale(scale: 0.96, anchor: .bottom).combined(with: .opacity),
                    removal: .opacity
                )
        }

        /// A message the user just sent: it rises from the composer into place at the end of the transcript.
        /// Removal is instant because the committed message replaces it in the same frame.
        static func sent(reduceMotion: Bool) -> AnyTransition {
            reduceMotion
                ? .asymmetric(insertion: .opacity, removal: .identity)
                : .asymmetric(
                    insertion: .offset(y: 24).combined(with: .scale(scale: 0.94, anchor: .bottomTrailing))
                        .combined(with: .opacity),
                    removal: .identity
                )
        }
    }
}

/// The one key cap: a key or chord on a soft fill, used by `KeyHint` and by numbered answer choices. `strong` marks
/// the active choice (primary fill and text); otherwise the cap takes the surrounding text colour.
struct KeyCap: View {
    let key: String
    var strong = false

    var body: some View {
        Text(key)
            .font(.pilot(.small, weight: .medium).monospacedDigit())
            .foregroundStyle(strong ? AnyShapeStyle(Theme.onPrimary) : AnyShapeStyle(ForegroundStyle()))
            .padding(.horizontal, 4)
            .frame(minWidth: 16, minHeight: 16)
            .background(RoundedRectangle(cornerRadius: Theme.Radius.small).fill(strong ? Theme.primary : Theme.muted))
            .fixedSize()
            .accessibilityHidden(true)
    }
}

/// Keyboard shortcut hint: a key cap followed by a short action, such as "⌥↩ follow up".
struct KeyHint: View {
    let key: String
    let label: String

    var body: some View {
        HStack(spacing: 4) {
            KeyCap(key: key)
            Text(label)
        }
        .font(.pilot(.caption))
        .foregroundStyle(Theme.faintForeground)
        .fixedSize()
    }
}

/// Borderless icon button for standalone toolbar and composer actions: muted, with a soft fill under the pointer
/// and an optional tint (for example destructive) that only appears on hover. Inside rows use
/// `rowIconButtonStyle(hoverTint:)` instead, so the row's selection stays its only fill. Always add an
/// accessibility label. The default 20 pt fits small toolbars; use 26 pt beside the composers' 26 pt circular send
/// button.
struct QuietIconButtonStyle: ButtonStyle {
    var hoverTint: Color = Theme.foreground
    var size: CGFloat = 20

    func makeBody(configuration: Configuration) -> some View {
        QuietIconButton(configuration: configuration, hoverTint: hoverTint, size: size)
    }

    private struct QuietIconButton: View {
        let configuration: ButtonStyleConfiguration
        let hoverTint: Color
        let size: CGFloat
        @Environment(\.isEnabled) private var isEnabled
        @State private var isHovered = false

        private var radius: CGFloat { size > 20 ? Theme.Radius.control : Theme.Radius.row }

        var body: some View {
            let active = isHovered && isEnabled
            configuration.label
                .font(.pilot(.caption, weight: .semibold))
                .foregroundStyle(active ? hoverTint : Theme.mutedForeground)
                .frame(width: size, height: size)
                .background(RoundedRectangle(cornerRadius: radius).fill(active ? Theme.selected : .clear))
                .opacity(isEnabled ? (configuration.isPressed ? 0.6 : 1) : 0.4)
                .contentShape(RoundedRectangle(cornerRadius: radius))
                .onHover { isHovered = $0 }
                .animation(Theme.Motion.quick, value: isHovered)
        }
    }
}

/// Fill-less icon button for actions inside rows, such as a revealed edit, remove or ⋯ menu. The glyph goes from
/// muted to `hoverTint` (for example destructive) under the pointer or keyboard focus and draws no background, so
/// the row's selection stays its only fill. Apply it with `rowIconButtonStyle(hoverTint:)`, which also replaces the
/// system focus effect with the row focus ring. Always add an accessibility label.
struct RowIconButtonStyle: ButtonStyle {
    var hoverTint: Color = Theme.foreground
    var size: CGFloat = 20

    func makeBody(configuration: Configuration) -> some View {
        RowIconButton(configuration: configuration, hoverTint: hoverTint, size: size)
    }

    private struct RowIconButton: View {
        let configuration: ButtonStyleConfiguration
        let hoverTint: Color
        let size: CGFloat
        @Environment(\.isEnabled) private var isEnabled
        @Environment(\.isFocused) private var isFocused
        @State private var isHovered = false

        var body: some View {
            let active = (isHovered || isFocused) && isEnabled
            configuration.label
                .font(.pilot(.caption, weight: .semibold))
                .foregroundStyle(active ? hoverTint : Theme.mutedForeground)
                .frame(width: size, height: size)
                .opacity(isEnabled ? (configuration.isPressed ? 0.6 : 1) : 0.4)
                .contentShape(Rectangle())
                .focusRing(isFocused)
                .onHover { isHovered = $0 }
                .animation(Theme.Motion.quick, value: isHovered)
        }
    }
}

/// Plain style for a button that is a whole row, or a row's main area, such as a sidebar or Inbox row. It adds
/// nothing at rest (the row draws its own hover and selection) and draws the focus ring around the label under
/// keyboard focus. Apply it with `rowButtonStyle(radius:outset:)`.
struct RowButtonStyle: ButtonStyle {
    var radius: CGFloat = Theme.Radius.row
    var outset: CGFloat = 0

    func makeBody(configuration: Configuration) -> some View {
        RowButton(configuration: configuration, radius: radius, outset: outset)
    }

    private struct RowButton: View {
        let configuration: ButtonStyleConfiguration
        let radius: CGFloat
        let outset: CGFloat
        @Environment(\.isFocused) private var isFocused

        var body: some View {
            configuration.label
                .opacity(configuration.isPressed ? 0.75 : 1)
                .focusRing(isFocused, radius: radius, outset: outset)
        }
    }
}

/// Outlined red button for a destructive action that ends a page, such as Remove Project in project settings: red
/// label (the text-weight `Theme.error`), a red hairline outline and no fill at rest, a soft red fill while pressed.
/// Keep it away from the page's primary action, beside one line saying what it does, and confirm before acting.
/// Apply it with `destructiveOutlineButtonStyle()`, which also draws the keyboard focus ring.
struct DestructiveOutlineButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        DestructiveOutlineButton(configuration: configuration)
    }

    private struct DestructiveOutlineButton: View {
        let configuration: ButtonStyleConfiguration
        @Environment(\.isEnabled) private var isEnabled
        @Environment(\.isFocused) private var isFocused

        var body: some View {
            let shape = RoundedRectangle(cornerRadius: Theme.Radius.row)
            configuration.label
                .font(.pilot(.label, weight: .medium))
                .foregroundStyle(Theme.error)
                .padding(.horizontal, 10)
                .padding(.vertical, 4)
                .background(shape.fill(Theme.destructive.opacity(configuration.isPressed ? 0.08 : 0)))
                .overlay(shape.strokeBorder(Theme.destructive.opacity(0.55), lineWidth: 1))
                .opacity(isEnabled ? 1 : 0.4)
                .contentShape(shape)
                .focusRing(isFocused, outset: 2)
        }
    }
}

extension View {
    /// Fill-less row action. See `RowIconButtonStyle`.
    func rowIconButtonStyle(hoverTint: Color = Theme.foreground, size: CGFloat = 20) -> some View {
        buttonStyle(RowIconButtonStyle(hoverTint: hoverTint, size: size)).focusEffectDisabled()
    }

    /// Red outline button for a destructive action at the end of a page. See `DestructiveOutlineButtonStyle`.
    func destructiveOutlineButtonStyle() -> some View {
        buttonStyle(DestructiveOutlineButtonStyle()).focusEffectDisabled()
    }

    /// A whole-row button with the row focus ring. See `RowButtonStyle`.
    func rowButtonStyle(radius: CGFloat = Theme.Radius.row, outset: CGFloat = 0) -> some View {
        buttonStyle(RowButtonStyle(radius: radius, outset: outset)).focusEffectDisabled()
    }

    /// Keyboard focus ring for rows and row buttons: a 2 pt ring in the system focus colour, `outset` points outside
    /// the view so it can follow a row's padding. Only shown while `focused`, so pointer use never sees it.
    func focusRing(_ focused: Bool, radius: CGFloat = Theme.Radius.row, outset: CGFloat = 0) -> some View {
        overlay {
            if focused {
                RoundedRectangle(cornerRadius: radius + outset)
                    .strokeBorder(Theme.focusRing, lineWidth: 2)
                    .padding(-outset)
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
            }
        }
    }
}
