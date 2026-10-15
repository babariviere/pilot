import PilotCore
import SwiftUI

/// Shared presentation for automatic timeline items, not conversational messages.
struct ChatEventRow: View {
    let event: ChatEvent
    @State private var hovering = false
    @StateObject private var expansion: ExpansionState

    init(event: ChatEvent, expansion: ExpansionState? = nil) {
        self.event = event
        _expansion = StateObject(wrappedValue: expansion ?? ExpansionState())
    }

    private var icon: PilotIcon {
        switch event.kind {
        case "push": PilotIcon.push
        case "pr_opened", "pr_ready", "pr_draft", "pr_edited", "pr_reopened": PilotIcon.pullRequest
        case "pi.compaction": PilotIcon.compaction
        case "pi.reset": PilotIcon.reset
        case "stopped": PilotIcon.stopped
        case "mission_updated", "mission_decisions_changed", "mission_task_done", "mission_member_finished": PilotIcon.mission
        default: PilotIcon.unset
        }
    }

    private func timeLabel(_ timestamp: Double) -> String {
        let start = Date(timeIntervalSince1970: timestamp / 1000).formatted(date: .omitted, time: .shortened)
        guard let end = event.endTimestamp else { return start }
        return start + " to " + Date(timeIntervalSince1970: end / 1000).formatted(date: .omitted, time: .shortened)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 7) {
                PilotSymbol(icon).accessibilityHidden(true)
                Text(event.sentence).lineLimit(1)
                if let branch = event.branch {
                    Text(branch)
                        .font(.pilot(.caption, design: .monospaced))
                        .lineLimit(1).truncationMode(.middle)
                        .padding(.horizontal, 5).padding(.vertical, 2)
                        .background(Theme.muted, in: RoundedRectangle(cornerRadius: Theme.Radius.card))
                }
                if let title = event.title { Text(title).lineLimit(1).foregroundStyle(Theme.faintForeground) }
                if event.detail != nil {
                    Button(expansion.expanded ? "Hide" : "Show") { expansion.expanded.toggle() }
                        .buttonStyle(.plain).foregroundStyle(Theme.info)
                        .accessibilityLabel(expansion.expanded ? "Hide event details" : "Show event details")
                }
                Spacer(minLength: 0)
                if let timestamp = event.timestamp {
                    Text(timeLabel(timestamp))
                        .font(.pilot(.caption)).foregroundStyle(Theme.faintForeground)
                        .opacity(hovering ? 1 : 0).accessibilityHidden(true)
                }
            }
            .font(.pilot(.label))
            .foregroundStyle(event.destructive ? Theme.destructive : Theme.mutedForeground)
            .help([event.sentence, event.branch, event.title, event.uncertainty].compactMap { $0 }.joined(separator: " "))
            .onHover { hovering = $0 }
            if expansion.expanded, let detail = event.detail {
                MarkdownView(text: detail).padding(.leading, 19)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
