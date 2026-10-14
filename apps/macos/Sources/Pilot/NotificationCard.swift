import PilotCore
import SwiftUI

/// Compact, left-aligned card for input the user did not type: subagent answers, mission messages, job results and
/// PR follow-ups. Use it for conversational automatic messages so it never looks like a user bubble. Collapsed, it previews two
/// muted lines; expanded, it renders the full Markdown.
struct NotificationCard<Accessory: View>: View {
    let icon: PilotIcon
    let title: String
    let text: String
    var tint: Color = Theme.mutedForeground
    @ObservedObject var expansion: ExpansionState
    @ViewBuilder var accessory: () -> Accessory

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                PilotSymbol(icon)
                    .foregroundStyle(tint)
                Text(title)
                    .font(.pilot(.label, weight: .semibold))
                Spacer()
                accessory()
                Button {
                    withAnimation(.easeOut(duration: 0.15)) { expansion.expanded.toggle() }
                } label: {
                    PilotSymbol(PilotIcon.disclosure, context: .disclosure)
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
        if origin == .mission {
            ChatEventRow(event: ChatEvent(id: "mission", kind: "mission_updated", text: "Mission updated", detail: text), expansion: expansion)
        } else {
            NotificationCard(icon: origin.icon, title: origin.title, text: text, expansion: expansion) { EmptyView() }
        }
    }
}

extension InputOrigin {
    var title: String {
        switch self {
        case .job: "Background job"
        case .subagent: "Subagent"
        case .extension: "Automatic message"
        case .coordinator: "Coordinator"
        case .mission: "Mission"
        case .pullRequest: "PR follow-up"
        }
    }

    var icon: PilotIcon {
        switch self {
        case .job: PilotIcon.terminal
        case .subagent: PilotIcon.subagents
        case .extension: PilotIcon.extensionTool
        case .coordinator: PilotIcon.coordinator
        case .mission: PilotIcon.mission
        case .pullRequest: PilotIcon.pullRequest
        }
    }
}
