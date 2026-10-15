import PilotCore
import SwiftUI

/// The agent's todo list as one line at the top of the composer tray, shaped like `SystemMessagesStrip`:
/// "Tasks 1 of 3", a small progress bar and the task in progress. Click it to list every task read-only.
struct TasksStrip: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let todos: [SessionTodo]
    let sessionId: String
    @State private var expanded = false

    private static let visibleRows: CGFloat = 5

    var body: some View {
        let ordered = todos.inDisplayOrder(for: sessionId)
        let done = todos.filter(\.isClosed).count
        VStack(alignment: .leading, spacing: 2) {
            summary(ordered: ordered, done: done)
            if expanded {
                let height = (QueuedMessagesStrip.rowHeight + 2) * Self.visibleRows
                ViewThatFits(in: .vertical) {
                    rows(ordered)
                    ScrollView { rows(ordered) }.frame(height: height)
                }
                .transition(Theme.Motion.insertion(reduceMotion: reduceMotion))
            }
        }
    }

    private func summary(ordered: [SessionTodo], done: Int) -> some View {
        let allDone = done == todos.count
        let active = ordered.first { $0.isWorking(in: sessionId) }
        return Button(action: toggle) {
            HStack(spacing: 8) {
                PilotSymbol(PilotIcon.tasks)
                    .foregroundStyle(Theme.faintForeground)
                    .frame(width: 14)
                Text(allDone ? "All tasks done" : "Tasks \(done) of \(todos.count)")
                    .font(.pilot(.label))
                    .monospacedDigit()
                    .foregroundStyle(Theme.mutedForeground)
                    .lineLimit(1)
                    .fixedSize()
                SegmentedProgressBar(segments: [
                    .init(id: "done", value: done, color: Theme.mutedForeground),
                    .init(id: "open", value: todos.count - done, color: Theme.border),
                ], height: 4)
                .frame(width: 48)
                if !expanded, let active {
                    Text(active.title)
                        .font(.pilot(.label))
                        .foregroundStyle(Theme.faintForeground)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                Spacer(minLength: 4)
                PilotSymbol(PilotIcon.disclosure, context: .disclosure)
                    .rotationEffect(.degrees(expanded ? 90 : 0))
                    .foregroundStyle(Theme.faintForeground)
                    .frame(width: 16, height: 16)
            }
            .padding(.horizontal, 8)
            .frame(maxWidth: .infinity, minHeight: QueuedMessagesStrip.rowHeight, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(expanded ? "Hide tasks" : active.map { "Working on: \($0.title)" } ?? "Show tasks")
        .accessibilityLabel("Tasks, \(done) of \(todos.count) completed" + (active.map { ", working on \($0.title)" } ?? ""))
        .accessibilityHint(expanded ? "Hides the list" : "Shows the list")
    }

    private func rows(_ items: [SessionTodo]) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(items) { todo in TaskRow(todo: todo, sessionId: sessionId) }
        }
    }

    private func toggle() {
        withAnimation(Theme.Motion.standard(reduceMotion: reduceMotion)) { expanded.toggle() }
    }
}

/// One task: its state mark, title and any status other than open or done. Read-only.
private struct TaskRow: View {
    let todo: SessionTodo
    let sessionId: String

    var body: some View {
        let working = todo.isWorking(in: sessionId)
        HStack(spacing: 8) {
            mark(working: working).frame(width: 14)
            Text(todo.title.isEmpty ? "(untitled)" : todo.title)
                .font(.pilot(.label, weight: working ? .medium : .regular))
                .foregroundStyle(todo.isClosed ? Theme.faintForeground : Theme.mutedForeground)
                .strikethrough(todo.isClosed)
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: 4)
            if let status {
                Text(status)
                    .font(.pilot(.caption))
                    .foregroundStyle(Theme.faintForeground)
                    .lineLimit(1)
                    .fixedSize()
            }
        }
        // The marks sit under the summary's title, like waiting system messages.
        .padding(.leading, 30)
        .padding(.trailing, 8)
        .frame(maxWidth: .infinity, minHeight: QueuedMessagesStrip.rowHeight, alignment: .leading)
        .textSelection(.enabled)
        .help("\(todo.id) · \(todo.title) · \(working ? "Working" : todo.status)")
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(todo.title), \(working ? "Working" : todo.isClosed ? "Completed" : status ?? "Open")")
    }

    private var status: String? {
        if todo.assignedToSession != nil, !todo.isWorking(in: sessionId), !todo.isClosed { return "Assigned elsewhere" }
        if !["open", "closed", "done"].contains(todo.status.lowercased()) { return todo.status }
        return nil
    }

    @ViewBuilder
    private func mark(working: Bool) -> some View {
        if working {
            PilotSymbol(PilotIcon.working)
        } else if todo.isClosed {
            PilotSymbol(PilotIcon.complete).foregroundStyle(Theme.faintForeground)
        } else {
            PilotSymbol(PilotIcon.todo).foregroundStyle(Theme.faintForeground)
        }
    }
}

