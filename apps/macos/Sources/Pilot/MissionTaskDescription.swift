import PilotCore
import SwiftUI

/// A compact task description that can be read in full without leaving the task list.
/// The Show more toggle appears only when the collapsed text is cut off.
struct MissionTaskDescription: View {
    let task: MissionTask
    let collapsedLineLimit: Int
    @StateObject private var expansion: ExpansionState
    @State private var collapsedHeight: CGFloat = 0
    @State private var fullHeight: CGFloat = 0

    init(task: MissionTask, collapsedLineLimit: Int = 2, expansion: ExpansionState? = nil) {
        self.task = task
        self.collapsedLineLimit = collapsedLineLimit
        _expansion = StateObject(wrappedValue: expansion ?? ExpansionState())
    }

    private var truncated: Bool { fullHeight > collapsedHeight + 1 }

    var body: some View {
        if let description = task.body, !description.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                Text(description)
                    .foregroundStyle(Theme.mutedForeground)
                    .lineLimit(expansion.expanded ? nil : collapsedLineLimit)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
                    .background(alignment: .topLeading) {
                        // Measure the collapsed and full heights at the row's width, without drawing them.
                        ZStack(alignment: .topLeading) {
                            Text(description).lineLimit(collapsedLineLimit)
                                .fixedSize(horizontal: false, vertical: true)
                                .background(GeometryReader { geometry in
                                    Color.clear
                                        .onAppear { collapsedHeight = geometry.size.height }
                                        .onChange(of: geometry.size.height) { _, value in collapsedHeight = value }
                                })
                            Text(description)
                                .fixedSize(horizontal: false, vertical: true)
                                .background(GeometryReader { geometry in
                                    Color.clear
                                        .onAppear { fullHeight = geometry.size.height }
                                        .onChange(of: geometry.size.height) { _, value in fullHeight = value }
                                })
                        }
                        .hidden()
                        .accessibilityHidden(true)
                    }
                if expansion.expanded || truncated {
                    Button { expansion.expanded.toggle() } label: {
                        Label(expansion.expanded ? "Show less" : "Show more",
                              icon: expansion.expanded ? PilotIcon.collapse : PilotIcon.disclosureOpen)
                    }
                    .buttonStyle(.link)
                    .help(expansion.expanded ? "Collapse task description" : "Read the full task description")
                    .accessibilityLabel("\(expansion.expanded ? "Collapse" : "Expand") description for task #\(task.number)")
                    .accessibilityValue(expansion.expanded ? "Expanded" : "Collapsed")
                }
            }
            .font(.caption)
        }
    }
}
