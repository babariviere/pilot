import PilotCore
import SwiftUI

/// Rows under a composer-tray summary line (`TasksStrip`, `SubagentsStrip`), sized to their content up to
/// `maxRows`. Longer lists scroll, with half a row peeking out so the overflow is visible.
struct TrayRowList<Content: View>: View {
    let count: Int
    var maxRows = 4
    @ViewBuilder let content: () -> Content

    static var rowPitch: CGFloat { QueuedMessagesStrip.rowHeight + 2 }

    var body: some View {
        let rows = VStack(alignment: .leading, spacing: 2) { content() }
        if count > maxRows {
            ScrollView { rows }
                .frame(height: Self.rowPitch * (CGFloat(maxRows) + 0.5))
        } else {
            rows
        }
    }
}

/// The agent's todo list at the top of the composer tray: "Tasks 1 of 3" with a progress bar, then the tasks with the
/// one in progress first. The list opens while tasks remain and folds to the summary line once all are done.
struct TasksStrip: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let todos: [SessionTodo]
    let sessionId: String
    @State private var expanded: Bool

    init(todos: [SessionTodo], sessionId: String) {
        self.todos = todos
        self.sessionId = sessionId
        _expanded = State(initialValue: todos.contains { !$0.isClosed })
    }

    var body: some View {
        let ordered = todos.inDisplayOrder(for: sessionId)
        let done = todos.filter(\.isClosed).count
        let allDone = done == todos.count
        VStack(alignment: .leading, spacing: 2) {
            summary(ordered: ordered, done: done)
            if expanded {
                TrayRowList(count: ordered.count) {
                    ForEach(ordered) { todo in TaskRow(todo: todo, sessionId: sessionId) }
                }
                .transition(Theme.Motion.insertion(reduceMotion: reduceMotion))
            }
        }
        .onChange(of: allDone) { _, value in
            withAnimation(Theme.Motion.standard(reduceMotion: reduceMotion)) { expanded = !value }
        }
    }

    private func summary(ordered: [SessionTodo], done: Int) -> some View {
        let allDone = done == todos.count
        let active = ordered.first { $0.isWorking(in: sessionId) }
        return Button(action: toggle) {
            HStack(spacing: 8) {
                PilotSymbol(allDone ? PilotIcon.complete : PilotIcon.tasks)
                    .foregroundStyle(allDone ? Theme.success : Theme.faintForeground)
                    .frame(width: 14)
                Text(allDone ? "All tasks done" : "Tasks \(done) of \(todos.count)")
                    .font(.pilot(.label, weight: .medium))
                    .monospacedDigit()
                    .foregroundStyle(Theme.mutedForeground)
                    .lineLimit(1)
                    .fixedSize()
                SegmentedProgressBar(segments: [
                    .init(id: "done", value: done, color: allDone ? Theme.success : Theme.mutedForeground),
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
        .accessibilityValue(expanded ? "Expanded" : "Collapsed")
    }

    private func toggle() {
        withAnimation(Theme.Motion.standard(reduceMotion: reduceMotion)) { expanded.toggle() }
    }
}

/// One task: its state mark, title and any status other than open or done. The task in progress reads strongest,
/// open tasks muted and finished ones faint and struck through. Read-only.
private struct TaskRow: View {
    let todo: SessionTodo
    let sessionId: String

    var body: some View {
        let working = todo.isWorking(in: sessionId)
        HStack(spacing: 8) {
            mark(working: working).frame(width: 14)
            Text(todo.title.isEmpty ? "(untitled)" : todo.title)
                .font(.pilot(.label, weight: working ? .medium : .regular))
                .foregroundStyle(working ? Theme.foreground : todo.isClosed ? Theme.faintForeground : Theme.mutedForeground)
                .strikethrough(todo.isClosed, color: Theme.faintForeground)
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: 4)
            if let status = status(working: working) {
                Text(status)
                    .font(.pilot(.caption))
                    .foregroundStyle(Theme.faintForeground)
                    .lineLimit(1)
                    .fixedSize()
            }
        }
        // Marks line up with the summary's icon, so the list reads as the summary's checklist.
        .padding(.horizontal, 8)
        .frame(maxWidth: .infinity, minHeight: QueuedMessagesStrip.rowHeight, alignment: .leading)
        .textSelection(.enabled)
        .help("\(todo.id) · \(todo.title) · \(working ? "Working" : todo.status)")
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(todo.title), \(working ? "Working" : todo.isClosed ? "Completed" : status(working: false) ?? "Open")")
    }

    private func status(working: Bool) -> String? {
        if working { return "Working" }
        if todo.assignedToSession != nil, !todo.isClosed { return "Assigned elsewhere" }
        if !["open", "closed", "done"].contains(todo.status.lowercased()) { return todo.status }
        return nil
    }

    @ViewBuilder
    private func mark(working: Bool) -> some View {
        if working {
            PilotSymbol(PilotIcon.working)
        } else if todo.isClosed {
            PilotSymbol(PilotIcon.complete).foregroundStyle(Theme.success)
        } else {
            PilotSymbol(PilotIcon.todo).foregroundStyle(Theme.faintForeground)
        }
    }
}

