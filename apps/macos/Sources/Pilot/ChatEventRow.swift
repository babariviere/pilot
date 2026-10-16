import PilotCore
import SwiftUI

/// Shared presentation for automatic timeline items, not conversational messages: GitHub actions, mission updates,
/// context changes, job results, subagent answers, coordinator messages, PR follow-ups and question records. One
/// muted line that expands to the full text on Show. A failure gets a red mark; the sentence stays readable text.
struct ChatEventRow: View {
    /// A trailing link beside Show, such as Open for a subagent's answer.
    struct Action {
        let label: String
        let help: String
        let perform: () -> Void
    }

    let event: ChatEvent
    let action: Action?
    @State private var hovering = false
    @StateObject private var expansion: ExpansionState

    init(event: ChatEvent, expansion: ExpansionState? = nil, action: Action? = nil) {
        self.event = event
        self.action = action
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
        case "job_finished", "job_failed": PilotIcon.terminal
        case "subagent_answered", "subagent_failed", "subagent_message": PilotIcon.subagents
        case "coordinator_message": PilotIcon.coordinator
        case "pr_follow_up": PilotIcon.pullRequest
        case "automatic_message": PilotIcon.extensionTool
        case "slack_reply": PilotIcon.message
        case "question": PilotIcon.question
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
                if event.destructive {
                    PilotSymbol(PilotIcon.warning, filled: true)
                        .foregroundStyle(Theme.destructive)
                        .accessibilityLabel("Failed")
                } else {
                    PilotSymbol(icon).accessibilityHidden(true)
                }
                Text(event.sentence).lineLimit(1)
                    .foregroundStyle(event.destructive ? Theme.foreground : Theme.mutedForeground)
                    .layoutPriority(1)
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
                        .fixedSize()
                        .accessibilityLabel(expansion.expanded ? "Hide event details" : "Show event details")
                }
                if let action {
                    Button(action.label, action: action.perform)
                        .buttonStyle(.plain).foregroundStyle(Theme.info)
                        .fixedSize()
                        .help(action.help)
                }
                Spacer(minLength: 0)
                if let timestamp = event.timestamp {
                    Text(timeLabel(timestamp))
                        .font(.pilot(.caption)).foregroundStyle(Theme.faintForeground)
                        .opacity(hovering ? 1 : 0).accessibilityHidden(true)
                }
            }
            .font(.pilot(.label))
            .foregroundStyle(Theme.mutedForeground)
            .help([event.sentence, event.branch, event.title, event.uncertainty].compactMap { $0 }.joined(separator: " "))
            .onHover { hovering = $0 }
            if expansion.expanded, let detail = event.detail {
                MarkdownView(text: detail).padding(.leading, 19)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
