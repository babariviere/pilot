import PilotCore
import SwiftUI

@MainActor
private final class TodosPanelState: ObservableObject {
    @Published var expanded: Bool

    init(expanded: Bool) { self.expanded = expanded }
}

/// Live checklist above the reply box, inspired by Berth's compact task card.
struct TodosPanel: View {
    let todos: [SessionTodo]
    let sessionId: String
    @StateObject private var expansion: TodosPanelState

    init(todos: [SessionTodo], sessionId: String) {
        self.todos = todos
        self.sessionId = sessionId
        _expansion = StateObject(wrappedValue: TodosPanelState(expanded: todos.contains { !$0.isClosed }))
    }

    var body: some View {
        let ordered = todos.inDisplayOrder(for: sessionId)
        let done = todos.filter(\.isClosed).count
        let allDone = done == todos.count
        let active = ordered.first { $0.isWorking(in: sessionId) }
        VStack(alignment: .leading, spacing: 0) {
            Button {
                expansion.expanded.toggle()
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "checklist")
                        .foregroundStyle(allDone ? Theme.success : Theme.mutedForeground)
                    Text(allDone ? "All tasks done" : "Tasks")
                    Text("\(done) of \(todos.count)")
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                    GeometryReader { geometry in
                        Capsule().fill(Theme.muted)
                            .overlay(alignment: .leading) {
                                Capsule().fill(allDone ? Theme.success : Theme.foreground.opacity(0.7))
                                    .frame(width: geometry.size.width * CGFloat(done) / CGFloat(max(1, todos.count)))
                            }
                    }
                    .frame(width: 48, height: 4)
                    .accessibilityHidden(true)
                    if !expansion.expanded, let active {
                        Text(active.title).foregroundStyle(.secondary).lineLimit(1)
                    }
                    Spacer()
                    Image(systemName: expansion.expanded ? "chevron.up" : "chevron.down")
                        .foregroundStyle(.secondary)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .font(.system(size: 13, weight: .medium))
            .accessibilityLabel("Tasks, \(done) of \(todos.count) completed")
            .accessibilityValue(expansion.expanded ? "Expanded" : "Collapsed")

            if expansion.expanded {
                Divider().opacity(0.5)
                ScrollView {
                    taskRows(ordered)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                }
                .frame(height: min(180, CGFloat(ordered.count) * 22 + 16))
            }
        }
        .background(RoundedRectangle(cornerRadius: 10).fill(Theme.card))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.hairline))
        .padding(.horizontal, 28)
        .padding(.vertical, 8)
        .frame(maxWidth: Theme.column + 56)
        .frame(maxWidth: .infinity)
        .onChange(of: allDone) { _, value in expansion.expanded = !value }
    }

    private func taskRows(_ items: [SessionTodo]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(items) { todo in
                let working = todo.isWorking(in: sessionId)
                HStack(alignment: .top, spacing: 8) {
                    taskGlyph(todo, working: working)
                        .frame(width: 16, height: 16)
                    Text(todo.title.isEmpty ? "(untitled)" : todo.title)
                        .strikethrough(todo.isClosed)
                        .foregroundStyle(todo.isClosed ? .secondary : .primary)
                        .fontWeight(working ? .medium : .regular)
                        .lineLimit(expansion.expanded ? nil : 1)
                    Spacer(minLength: 8)
                    if todo.assignedToSession != nil, !working, !todo.isClosed {
                        Text("Assigned elsewhere").foregroundStyle(.secondary)
                    } else if !["open", "closed", "done"].contains(todo.status.lowercased()) {
                        Text(todo.status).foregroundStyle(.secondary)
                    }
                }
                .font(.system(size: 13))
                .textSelection(.enabled)
                .help("\(todo.id) · \(todo.title) · \(working ? "Working" : todo.status)")
                .accessibilityElement(children: .combine)
                .accessibilityLabel("\(todo.title), \(working ? "Working" : todo.isClosed ? "Completed" : todo.status)")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func taskGlyph(_ todo: SessionTodo, working: Bool) -> some View {
        if todo.isClosed {
            Circle().fill(Theme.success.opacity(0.15))
                .overlay {
                    Image(systemName: "checkmark")
                        .font(.system(size: 9, weight: .bold))
                        .foregroundStyle(Theme.success)
                }
        } else if working {
            Circle().fill(Theme.foreground.opacity(0.7)).frame(width: 8, height: 8)
        } else {
            Circle().strokeBorder(Theme.mutedForeground.opacity(0.5), style: StrokeStyle(lineWidth: 1, dash: [2, 2]))
                .frame(width: 14, height: 14)
        }
    }
}
