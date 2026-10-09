import AppKit
import PilotCore
import SwiftUI

/// Light design tokens, after Berth's palette: white surfaces, a neutral-50 sidebar, 8% black
/// hairlines, 4% black fills, neutral-800 text and dark primary buttons.
enum Theme {
    /// Readable line length for the transcript and composer.
    static let column: CGFloat = 760
    static let radius: CGFloat = 10

    static let background = Color.white
    static let sidebar = Color(hex: 0xFAFAFA)
    static let foreground = Color(hex: 0x262626)
    static let mutedForeground = Color(hex: 0x6B6B6B)
    static let faintForeground = Color(hex: 0xA3A3A3)
    static let border = Color.black.opacity(0.08)
    static let muted = Color.black.opacity(0.04)
    static let selected = Color.black.opacity(0.06)
    static let card = Color.white
    /// Opaque tray behind composers. Holds the editor card and its controls.
    static let tray = Color(hex: 0xF5F5F5)
    static let code = Color(hex: 0xFAFAFA)
    static let primary = Color(hex: 0x262626)

    static let info = Color(hex: 0x3B82F6)
    static let success = Color(hex: 0x10B981)
    static let warning = Color(hex: 0xF59E0B)
    static let destructive = Color(hex: 0xEF4444)

    /// Syntax colors with contrast against the light code surface.
    static func syntaxColor(_ kind: CodeSyntax.Kind?) -> Color {
        switch kind {
        case .keyword: Color(hex: 0x7C3AED)
        case .string: Color(hex: 0x166534)
        case .number, .literal: Color(hex: 0x9A3412)
        case .comment: mutedForeground
        case .function: Color(hex: 0x1D4ED8)
        case nil: foreground
        }
    }

    // Older names, kept so views read naturally.
    static var cardBackground: Color { card }
    static var codeBackground: Color { code }
    static var subtleFill: Color { muted }
    static var hairline: Color { border }

    /// Type scale for app chrome: sidebars, cards, panes, badges and metadata.
    ///
    /// Use `.font(.pilot(.caption))` instead of `.system(size:)` literals, and vary weight or design
    /// through the arguments rather than picking an in-between size. Chat and code content follow the
    /// user's font settings through `PilotFonts` instead; this scale is fixed.
    ///
    /// - `display`: one large figure per card, such as a total.
    /// - `title`: large decorative symbols, such as empty-state icons.
    /// - `body`: primary row text, titles and empty-state messages.
    /// - `label`: pane headers, controls and short supporting text.
    /// - `caption`: metadata, secondary row lines, paths and inline errors.
    /// - `small`: badges, counts, pills and uppercase section labels.
    /// - `micro`: chart axes and small inline symbols, such as disclosure chevrons.
    /// - `glyph`: the smallest inline symbols inside pills. Never use it for words.
    enum TextRole: CaseIterable {
        case display, title, body, label, caption, small, micro, glyph

        var size: CGFloat {
            switch self {
            case .display: 26
            case .title: 22
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
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255
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
    /// White card with a hairline border.
    func card(radius: CGFloat = Theme.radius, shadow: Bool = false) -> some View {
        background(
            RoundedRectangle(cornerRadius: radius)
                .fill(Theme.card)
                .shadow(color: .black.opacity(shadow ? 0.06 : 0), radius: 12, y: 4)
        )
        .overlay(RoundedRectangle(cornerRadius: radius).strokeBorder(Theme.border))
    }
}

/// Circular icon button used by composers. Dark by default, like Berth's primary buttons.
struct CircleIconButtonStyle: ButtonStyle {
    var tint: Color = Theme.primary

    func makeBody(configuration: Configuration) -> some View {
        CircleIconButton(configuration: configuration, tint: tint)
    }

    private struct CircleIconButton: View {
        let configuration: ButtonStyleConfiguration
        let tint: Color
        @Environment(\.isEnabled) private var isEnabled

        var body: some View {
            configuration.label
                .font(.system(size: 12, weight: .bold))
                .foregroundStyle(.white)
                .frame(width: 26, height: 26)
                .background(Circle().fill(isEnabled ? tint : Color.black.opacity(0.15)))
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
    var icon: String? = nil
    var dot: Color?
    var templateImage: NSImage?
    /// Long titles, such as model names, truncate in the middle beyond this width.
    var maxTitleWidth: CGFloat? = nil
    var loading = false

    var body: some View {
        HStack(spacing: 5) {
            if let dot {
                Circle().fill(dot).frame(width: 6, height: 6)
            } else if let templateImage {
                Image(nsImage: templateImage).resizable().frame(width: 12, height: 12)
            } else if let icon {
                Image(systemName: icon).font(.pilot(.caption))
            }
            Text(title)
                .foregroundStyle(Theme.foreground)
                .lineLimit(1)
                .truncationMode(.middle)
                .frame(maxWidth: maxTitleWidth, alignment: .leading)
            if loading {
                ProgressView().controlSize(.mini)
            } else {
                Image(systemName: "chevron.up.chevron.down").font(.pilot(.glyph, weight: .semibold)).opacity(0.6)
            }
        }
        .font(.pilot(.label))
        .foregroundStyle(Theme.mutedForeground)
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(RoundedRectangle(cornerRadius: 7).fill(Theme.muted))
        .contentShape(RoundedRectangle(cornerRadius: 7))
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
    var icon: String? = nil
    var count: Int? = nil

    var body: some View {
        HStack(spacing: 6) {
            if let icon { Image(systemName: icon).font(.pilot(.caption)) }
            Text(title).font(.pilot(.label, weight: .medium))
            if let count, count > 0 { CountBadge(count: count) }
        }
        .foregroundStyle(Theme.mutedForeground)
    }
}

/// Colored agent status symbol, with details available without adding row text.
struct SessionStatusIcon: View {
    let status: SessionStatus
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Group {
            if let symbolName = status.symbolName {
                Image(systemName: symbolName)
            } else if reduceMotion {
                Image(nsImage: BrailleProgress.images[0])
            } else {
                ClockedBrailleImage()
            }
        }
            .font(.system(size: 12, weight: .semibold))
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

private struct ClockedBrailleImage: View {
    @ObservedObject private var clock = BrailleProgressClock.shared
    @StateObject private var lifetime = BrailleClockLifetime()

    var body: some View {
        Image(nsImage: BrailleProgress.images[clock.frameIndex])
            .onAppear { lifetime.start() }
            .onDisappear { lifetime.stop() }
    }
}

@MainActor
private final class BrailleClockLifetime: ObservableObject {
    private let id = UUID()
    func start() { BrailleProgressClock.shared.subscribe(id) }
    func stop() { BrailleProgressClock.shared.unsubscribe(id) }
    deinit {
        let id = id
        Task { @MainActor in BrailleProgressClock.shared.unsubscribe(id) }
    }
}

extension SessionStatus {
    var symbolName: String? {
        switch self {
        case .working: nil
        case .done: "checkmark"
        case .failed: "exclamationmark.triangle.fill"
        case .stopped: "stop.circle.fill"
        case .idle: "moon.zzz.fill"
        }
    }

    var color: Color {
        switch self {
        case .working: Theme.foreground
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
