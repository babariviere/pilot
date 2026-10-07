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

/// Small rounded chip used for pickers in composers.
struct ChipLabel: View {
    let title: String
    let icon: String
    var dot: Color?

    var body: some View {
        HStack(spacing: 5) {
            if let dot {
                Circle().fill(dot).frame(width: 6, height: 6)
            } else {
                Image(systemName: icon).font(.system(size: 11))
            }
            Text(title).lineLimit(1)
            Image(systemName: "chevron.up.chevron.down").font(.system(size: 8, weight: .semibold)).opacity(0.6)
        }
        .font(.system(size: 12))
        .foregroundStyle(Theme.mutedForeground)
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(RoundedRectangle(cornerRadius: 7).fill(Theme.muted))
    }
}

/// Colored agent status symbol, with details available without adding row text.
struct SessionStatusIcon: View {
    let status: SessionStatus

    var body: some View {
        Image(systemName: status.symbolName)
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

extension SessionStatus {
    var symbolName: String {
        switch self {
        case .working: "arrow.triangle.2.circlepath"
        case .done: "checkmark"
        case .needsInput: "hand.raised.fill"
        case .failed: "exclamationmark.triangle.fill"
        case .stopped: "stop.circle.fill"
        case .idle: "moon.zzz.fill"
        }
    }

    var color: Color {
        switch self {
        case .working: Theme.info
        case .done: Theme.success
        case .needsInput: Theme.warning
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
