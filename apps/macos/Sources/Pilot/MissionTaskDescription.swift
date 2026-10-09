import PilotCore
import SwiftUI

/// A compact task description that can be read in full without leaving the task list.
struct MissionTaskDescription: View {
    let task: MissionTask
    let collapsedLineLimit: Int
    @StateObject private var expansion: ExpansionState

    init(task: MissionTask, collapsedLineLimit: Int = 2, expansion: ExpansionState? = nil) {
        self.task = task
        self.collapsedLineLimit = collapsedLineLimit
        _expansion = StateObject(wrappedValue: expansion ?? ExpansionState())
    }

    var body: some View {
        if let description = task.body, !description.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                Text(description)
                    .foregroundStyle(Theme.mutedForeground)
                    .lineLimit(expansion.expanded ? nil : collapsedLineLimit)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
                Button { expansion.expanded.toggle() } label: {
                    Label(expansion.expanded ? "Show less" : "Show more",
                          systemImage: expansion.expanded ? "chevron.up" : "chevron.down")
                }
                .buttonStyle(.link)
                .help(expansion.expanded ? "Collapse task description" : "Read the full task description")
                .accessibilityLabel("\(expansion.expanded ? "Collapse" : "Expand") description for task #\(task.number)")
                .accessibilityValue(expansion.expanded ? "Expanded" : "Collapsed")
            }
            .font(.caption)
        }
    }
}
