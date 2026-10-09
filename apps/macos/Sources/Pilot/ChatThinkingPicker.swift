import PilotCore
import SwiftUI

/// Separate from model selection, but shares its idle-only admission and pending request.
struct ChatThinkingPicker: View {
    let session: SessionSummary
    let working: Bool
    @ObservedObject var state: ChatModelPickerState

    private var levels: [String] { state.thinkingLevels(for: session) }
    /// Without a reported level there is nothing to show or choose, so the picker hides.
    private var hidden: Bool { session.thinking == nil && levels.isEmpty }
    private var levelLabel: String { session.thinking.map(label) ?? "Thinking" }

    private func label(_ level: String) -> String { level == "xhigh" ? "XHigh" : level.capitalized }

    private var helpText: String {
        if levels.isEmpty { return "This model has no reported thinking levels" }
        if levels.count < 2 { return "This model has a fixed thinking level: \(label(levels[0]))" }
        if working || session.isWorking { return "Thinking can be changed when idle with no queued messages" }
        return "Change the thinking level for this chat"
    }

    var body: some View {
        if !hidden { picker }
    }

    private var picker: some View {
        Menu {
            ForEach(levels, id: \.self) { level in
                Button { state.selectThinking(level, session: session, working: working) } label: {
                    if level == session.thinking {
                        Label(label(level), systemImage: "checkmark")
                    } else {
                        Text(label(level))
                    }
                }
            }
            if levels.isEmpty { Text("No thinking levels reported") }
        } label: {
            ChipLabel(title: levelLabel, icon: "brain")
        }
        .chipMenuStyle()
        .fixedSize(horizontal: true, vertical: false)
        .disabled(levels.count < 2 || !state.canChange(session: session, working: working))
        .help(helpText)
        .accessibilityLabel("Thinking: \(levelLabel)")
    }
}
