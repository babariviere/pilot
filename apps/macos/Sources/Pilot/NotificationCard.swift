import PilotCore
import SwiftUI

/// Compact, left-aligned card for input the user did not type: subagent answers, mission messages, job results and
/// PR follow-ups. Use it for any automatic message so it never looks like a user bubble. Collapsed, it previews two
/// muted lines; expanded, it renders the full Markdown.
struct NotificationCard<Accessory: View>: View {
    let icon: String
    let title: String
    let text: String
    var tint: Color = Theme.mutedForeground
    @ObservedObject var expansion: ExpansionState
    @ViewBuilder var accessory: () -> Accessory

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: icon)
                    .font(.pilot(.caption))
                    .foregroundStyle(tint)
                Text(title)
                    .font(.pilot(.label, weight: .semibold))
                Spacer()
                accessory()
                Button {
                    withAnimation(.easeOut(duration: 0.15)) { expansion.expanded.toggle() }
                } label: {
                    Image(systemName: "chevron.right")
                        .font(.pilot(.micro, weight: .semibold))
                        .rotationEffect(.degrees(expansion.expanded ? 90 : 0))
                        .foregroundStyle(Theme.mutedForeground)
                        .frame(width: 16, height: 16)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(expansion.expanded ? "Collapse \(title)" : "Expand \(title)")
            }
            if expansion.expanded {
                MarkdownView(text: text)
            } else {
                Text(text)
                    .font(.pilot(.label))
                    .foregroundStyle(Theme.mutedForeground)
                    .lineLimit(2)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: Theme.radius).fill(Theme.card))
        .overlay(RoundedRectangle(cornerRadius: Theme.radius).strokeBorder(Theme.border))
    }
}

/// Automatic input delivered to the chat, labelled by where it came from.
struct AutomaticMessageRow: View {
    let text: String
    let origin: InputOrigin
    @StateObject private var expansion: ExpansionState

    init(text: String, origin: InputOrigin, expansion: ExpansionState? = nil) {
        self.text = text
        self.origin = origin
        _expansion = StateObject(wrappedValue: expansion ?? ExpansionState())
    }

    var body: some View {
        NotificationCard(icon: origin.icon, title: origin.title, text: text, expansion: expansion) { EmptyView() }
    }
}

extension InputOrigin {
    var title: String {
        switch self {
        case .job: "Background job"
        case .subagent: "Subagent"
        case .extension: "Automatic message"
        case .mission: "Mission"
        case .pullRequest: "PR follow-up"
        }
    }

    var icon: String {
        switch self {
        case .job: "terminal"
        case .subagent: "person.2"
        case .extension: "puzzlepiece.extension"
        case .mission: "flag"
        case .pullRequest: "arrow.triangle.pull"
        }
    }
}
