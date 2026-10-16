import PilotCore
import SwiftUI

// Scheduled chats and follow-ups: the Send later control of the composers, the sheet that picks or edits
// a trigger, and the rows that list pending items on Home, the project page and in the target chat.
// State icons and colours come from the ScheduleState tokens in Theme.swift.

/// When a scheduled item starts: its trigger, plus epoch milliseconds for At a time.
struct ScheduleWhen: Equatable {
    var trigger: ScheduleTrigger
    var at: Double? = nil
}

/// Labels, times and notification text for scheduled items, kept apart from views so they can be tested.
enum ScheduleText {
    /// Triggers offered when scheduling. onWake exists in the protocol but is not offered, and removed only
    /// marks cancelled records of retired triggers.
    static let choices: [ScheduleTrigger] = [.onBack, .onOnline, .at]

    static func label(_ trigger: ScheduleTrigger) -> String {
        switch trigger {
        case .onBack: "When I’m back"
        case .onOnline: "When online"
        case .onWake: "After wake"
        case .removed: "Removed trigger"
        case .at: "At a time"
        }
    }

    /// One sentence under the trigger picker.
    static func explanation(_ trigger: ScheduleTrigger) -> String {
        switch trigger {
        case .onBack: "Starts after this Mac next wakes from sleep and is online."
        case .onOnline: "Starts the next time this Mac reconnects after being offline."
        case .onWake: "Starts after this Mac next wakes from sleep."
        case .removed: "This trigger is no longer supported."
        case .at: "If this Mac is asleep or offline then, it starts when you’re back."
        }
    }

    /// Trailing row label: the trigger, or the time of an "at" item.
    static func when(_ item: ScheduledItem, now: Date = Date(), calendar: Calendar = .current) -> String {
        guard item.trigger == .at, let at = item.at else { return label(item.trigger) }
        return RelativeDate.upcoming(Date(timeIntervalSince1970: at / 1000), now: now, calendar: calendar)
    }

    /// Secondary row line: what will happen, or why it could not.
    static func detail(_ item: ScheduledItem, chatTitle: String? = nil, projectName: String? = nil) -> String {
        if item.state == .failed {
            return firstLine(item.error).map { "Couldn’t start: \($0)" } ?? "Couldn’t start."
        }
        switch item.target {
        case let .chat(spawn, _):
            return ["New chat", projectName, spawn.mode == .ask ? "Ask" : nil].compactMap { $0 }.joined(separator: " · ")
        case .message:
            return chatTitle.map { "Follow-up in \($0)" } ?? "Follow-up message"
        }
    }

    /// A short title from the first non-empty line of a prompt.
    static func title(_ message: String, fallback: String) -> String {
        guard let line = firstLine(message) else { return fallback }
        return line.count > 80 ? String(line.prefix(79)) + "…" : line
    }

    /// Items worth listing: failed ones first (newest first), then pending ones in the order they will start.
    static func listed(_ items: [ScheduledItem], projectId: String? = nil, includeFailed: Bool) -> [ScheduledItem] {
        let scoped = items.filter { projectId == nil || $0.projectId == projectId }
        let failed = includeFailed ? scoped.filter { $0.state == .failed }.sorted { $0.updatedAt > $1.updatedAt } : []
        let pending = scoped.filter { $0.state == .pending }.sorted { ($0.at ?? $0.createdAt) < ($1.at ?? $1.createdAt) }
        return failed + pending
    }

    /// Pending follow-ups waiting for one chat.
    static func followUps(_ items: [ScheduledItem], sessionId: String) -> [ScheduledItem] {
        listed(items, includeFailed: false).filter {
            if case .message = $0.target { return chatId($0) == sessionId }
            return false
        }
    }

    /// The chat an item started, or the chat a follow-up targets.
    static func chatId(_ item: ScheduledItem) -> String? {
        if let sessionId = item.sessionId { return sessionId }
        if case let .message(sessionId, _) = item.target { return sessionId }
        return nil
    }

    /// Notification for an item that just started or failed, or nil when it did neither.
    static func notification(_ item: ScheduledItem, previous: ScheduleState?,
                             chatTitle: String?) -> (title: String, body: String)? {
        guard previous == .pending || previous == .dispatching, item.state != previous else { return nil }
        let isChat: Bool = if case .chat = item.target { true } else { false }
        let subject = isChat ? item.title : [chatTitle, item.title].compactMap { $0 }.joined(separator: ": ")
        switch item.state {
        case .fired:
            return (isChat ? "Scheduled chat started" : "Scheduled message sent", subject)
        case .failed:
            return (isChat ? "Scheduled chat couldn’t start" : "Scheduled message couldn’t be sent",
                    [subject, firstLine(item.error)].compactMap { $0 }.joined(separator: ". "))
        case .pending, .dispatching, .cancelled:
            return nil
        }
    }

    private static func firstLine(_ text: String?) -> String? {
        text?.split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .first { !$0.isEmpty }
    }
}

/// The state symbol of a scheduled item, from the ScheduleState tokens in Theme.swift.
struct ScheduleStateIcon: View {
    let state: ScheduleState

    var body: some View {
        PilotSymbol(state.icon)
            .foregroundStyle(state.color)
            .accessibilityLabel(state.accessibilityLabel)
    }
}

/// Send later, beside a composer's send button: a quiet clock menu, so scheduling stays one step away
/// from the primary Send. When I’m back and When online schedule at once; At a time… opens ScheduleSheet.
struct SendLaterMenu: View {
    var disabled = false
    let schedule: (ScheduleWhen) -> Void
    @State private var choosing: ScheduleTrigger?

    var body: some View {
        Menu {
            Section("Send later") {
                Button(ScheduleText.label(.onBack)) { schedule(ScheduleWhen(trigger: .onBack)) }
                Button(ScheduleText.label(.onOnline)) { schedule(ScheduleWhen(trigger: .onOnline)) }
                Button("At a Time…") { choosing = .at }
            }
        } label: {
            PilotSymbol(PilotIcon.pending)
        }
        .menuStyle(.button)
        .buttonStyle(QuietIconButtonStyle(size: 26))
        .menuIndicator(.hidden)
        .fixedSize()
        .disabled(disabled)
        .help("Send later")
        .accessibilityLabel("Send later")
        .sheet(isPresented: Binding(get: { choosing != nil }, set: { if !$0 { choosing = nil } })) {
            ScheduleSheet(title: "Send later", confirmTitle: "Schedule", trigger: choosing ?? .at) { when in schedule(when) }
        }
    }
}

/// Picks a trigger and a time for At a time. Used to schedule from Send later and to edit a pending item.
struct ScheduleSheet: View {
    let title: String
    let confirmTitle: String
    /// Throwing keeps the sheet open with the error, as other sheets do.
    let submit: (ScheduleWhen) async throws -> Void
    @State private var trigger: ScheduleTrigger
    @State private var date: Date
    @State private var saving = false
    @State private var error: String?
    @Environment(\.dismiss) private var dismiss

    init(title: String, confirmTitle: String, trigger: ScheduleTrigger, at: Double? = nil,
         submit: @escaping (ScheduleWhen) async throws -> Void) {
        self.title = title
        self.confirmTitle = confirmTitle
        self.submit = submit
        // Preserve a tombstone even if this sheet is opened for a cancelled record. Never convert it to live work.
        _trigger = State(initialValue: trigger)
        _date = State(initialValue: at.map { Date(timeIntervalSince1970: $0 / 1000) } ?? ScheduleSheet.suggestedTime())
    }

    private var choices: [ScheduleTrigger] {
        if trigger == .removed { return ScheduleText.choices }
        return ScheduleText.choices.contains(trigger) ? ScheduleText.choices : [trigger] + ScheduleText.choices
    }

    private var canSave: Bool {
        guard !saving, trigger != .removed else { return false }
        if trigger == .at { return date > Date() }
        return true
    }

    var body: some View {
        SheetScaffold(title, error: error,
                      primary: SheetPrimaryAction(title: saving ? "Saving…" : confirmTitle, enabled: canSave, action: save)) {
            Form {
                Section {
                    Picker("Start", selection: $trigger) {
                        ForEach(choices, id: \.self) { Text(ScheduleText.label($0)).tag($0) }
                    }
                    .pickerStyle(.radioGroup)
                    if trigger == .at {
                        DatePicker("Time", selection: $date, in: Date()..., displayedComponents: [.date, .hourAndMinute])
                    }
                } footer: {
                    Text(ScheduleText.explanation(trigger))
                        .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .formStyle(.grouped)
        }
    }

    private func save() {
        guard canSave else { return }
        saving = true
        error = nil
        let when = ScheduleWhen(trigger: trigger, at: trigger == .at ? ScheduleSheet.epochMilliseconds(date) : nil)
        Task {
            defer { saving = false }
            do {
                try await submit(when)
                dismiss()
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    /// The first whole hour at least 30 minutes away.
    static func suggestedTime(now: Date = Date(), calendar: Calendar = .current) -> Date {
        let soon = now.addingTimeInterval(30 * 60)
        return calendar.dateInterval(of: .hour, for: soon)?.end ?? soon
    }

    /// The picked time as whole epoch milliseconds, at the start of its minute (the picker shows no seconds).
    /// pilotd rejects fractional values, which Date arithmetic often produces.
    static func epochMilliseconds(_ date: Date, calendar: Calendar = .current) -> Double {
        let minute = calendar.dateInterval(of: .minute, for: date)?.start ?? date
        return (minute.timeIntervalSince1970 * 1000).rounded()
    }
}

/// Edits the trigger of a pending item. Only pending items can change; pilotd rejects stale revisions.
struct EditScheduleSheet: View {
    let item: ScheduledItem

    var body: some View {
        ScheduleSheet(title: "Edit schedule", confirmTitle: "Save", trigger: item.trigger, at: item.at) { when in
            _ = try await AppModel.shared.client.updateSchedule(
                item.id, SchedulePatch(trigger: when.trigger, at: when.at, expectedRevision: item.revision)
            )
        }
    }
}

/// One scheduled item as a hairline row on Home and the project page. Clicking edits a pending item or
/// opens the chat of a failed one; cancel or dismiss is revealed on hover, and every action is also in the
/// context menu and the accessibility actions.
struct ScheduledItemRow: View {
    let item: ScheduledItem
    let detail: String
    var verticalPadding: CGFloat = 7
    var spacing: CGFloat = 10
    let openChat: (String) -> Void
    @State private var editing = false
    @State private var error: String?

    private var pending: Bool { item.state == .pending }
    private var chatId: String? { ScheduleText.chatId(item) }

    var body: some View {
        let when = ScheduleText.when(item)
        HoverRow(verticalPadding: verticalPadding) { hovered in
            HStack(spacing: spacing) {
                ScheduleStateIcon(state: item.state).font(.pilot(.label)).frame(width: 16)
                VStack(alignment: .leading, spacing: 1) {
                    Text(item.title).font(.pilot(.body)).foregroundStyle(Theme.foreground).lineLimit(1)
                    Text(detail).font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                        .lineLimit(pending ? 1 : 2)
                }
                Spacer(minLength: 8)
                if pending {
                    Text(when).font(.pilot(.caption)).monospacedDigit().foregroundStyle(Theme.faintForeground)
                        .lineLimit(1).fixedSize()
                        .help(when)
                }
                Button(action: remove) { PilotSymbol(PilotIcon.dismiss) }
                    .rowIconButtonStyle(hoverTint: Theme.destructive)
                    .revealed(hovered)
                    .help(pending ? "Cancel this scheduled item" : "Dismiss")
                    .accessibilityLabel(pending ? "Cancel schedule" : "Dismiss")
            }
        }
        .onTapGesture(perform: primary)
        .contextMenu { actions }
        .accessibilityElement(children: .combine)
        .accessibilityLabel([item.title, detail, pending ? when : nil].compactMap { $0 }.joined(separator: ", "))
        .accessibilityAddTraits(.isButton)
        .accessibilityAction(named: pending ? "Edit schedule" : "Open chat", primary)
        .accessibilityAction(named: pending ? "Cancel schedule" : "Dismiss", remove)
        .sheet(isPresented: $editing) { EditScheduleSheet(item: item) }
        .alert(pending ? "Couldn’t cancel this schedule" : "Couldn’t dismiss this item", isPresented: Binding(
            get: { error != nil }, set: { if !$0 { error = nil } }
        )) {
            Button("OK") { error = nil }
        } message: {
            Text(error ?? "")
        }
    }

    @ViewBuilder private var actions: some View {
        if pending {
            Button("Edit Schedule…") { editing = true }
            if let chatId { Button("Open Chat") { openChat(chatId) } }
            Divider()
            Button("Cancel Schedule", role: .destructive, action: remove)
        } else {
            if let chatId { Button("Open Chat") { openChat(chatId) } }
            Button("Dismiss", action: remove)
        }
    }

    private func primary() {
        if pending { editing = true } else if let chatId { openChat(chatId) }
    }

    private func remove() {
        Task {
            do { try await AppModel.shared.client.deleteSchedule(item.id) }
            catch { self.error = error.localizedDescription }
        }
    }
}

/// Pending follow-ups for this chat, waiting at the end of the transcript as dashed outline bubbles with when they
/// send ("Scheduled · Tomorrow 9:00 AM"). Hover offers Edit and Cancel. Reads schedules through a publisher, so
/// schedule and session updates never re-render the transcript.
struct ScheduledMessages: View {
    let sessionId: String
    var topPadding: CGFloat = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var items: [ScheduledItem] = []

    var body: some View {
        VStack(alignment: .trailing, spacing: 12) {
            ForEach(items) { item in
                ScheduledMessageBubble(item: item)
                    .transition(Theme.Motion.insertion(reduceMotion: reduceMotion))
            }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .padding(.top, items.isEmpty ? 0 : topPadding)
        .animation(Theme.Motion.standard(reduceMotion: reduceMotion), value: items.map(\.id))
        .onReceive(AppModel.shared.client.$schedules) { all in
            let next = ScheduleText.followUps(all, sessionId: sessionId)
            if next.map(\.id) != items.map(\.id) || next.map(\.revision) != items.map(\.revision) { items = next }
        }
    }
}

/// One scheduled message: the user's bubble, outlined rather than filled because it has not been sent yet.
private struct ScheduledMessageBubble: View {
    let item: ScheduledItem
    @Environment(\.pilotFonts) private var fonts
    @State private var hovered = false
    @State private var editing = false
    @State private var error: String?

    private var text: String {
        if case let .message(_, message) = item.target { return message }
        return item.title
    }

    var body: some View {
        let when = ScheduleText.when(item)
        VStack(alignment: .trailing, spacing: 4) {
            HStack {
                Spacer(minLength: 72)
                Text(text)
                    .font(fonts.body)
                    .lineSpacing(3)
                    .foregroundStyle(Theme.mutedForeground)
                    .lineLimit(8)
                    .truncationMode(.tail)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .overlay(RoundedRectangle(cornerRadius: Theme.Radius.bubble)
                        .strokeBorder(Theme.border, style: StrokeStyle(lineWidth: 1, dash: [4, 3])))
                    .contentShape(RoundedRectangle(cornerRadius: Theme.Radius.bubble))
                    .onTapGesture { editing = true }
            }
            HStack(spacing: 2) {
                Button { editing = true } label: { PilotSymbol(PilotIcon.edit) }
                    .buttonStyle(QuietIconButtonStyle())
                    .help("Edit when this message is sent")
                    .accessibilityLabel("Edit schedule")
                    .revealed(hovered)
                Button(action: cancel) { PilotSymbol(PilotIcon.dismiss) }
                    .buttonStyle(QuietIconButtonStyle(hoverTint: Theme.destructive))
                    .help("Cancel this scheduled message")
                    .accessibilityLabel("Cancel schedule")
                    .revealed(hovered)
                HStack(spacing: 4) {
                    ScheduleStateIcon(state: item.state)
                    Text("Scheduled · \(when)").lineLimit(1)
                }
                .font(.pilot(.caption))
                .foregroundStyle(Theme.faintForeground)
                .padding(.leading, 6)
                .help("Sends \(when)")
            }
            .frame(height: 20)
        }
        .contentShape(Rectangle())
        .onHover { hovered = $0 }
        .animation(Theme.Motion.quick, value: hovered)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Scheduled, \(when): \(text)")
        .accessibilityAction(named: "Edit schedule") { editing = true }
        .accessibilityAction(named: "Cancel schedule", cancel)
        .contextMenu {
            Button("Edit Schedule…") { editing = true }
            Divider()
            Button("Cancel Schedule", role: .destructive, action: cancel)
        }
        .sheet(isPresented: $editing) { EditScheduleSheet(item: item) }
        .alert("Couldn’t cancel this schedule", isPresented: Binding(
            get: { error != nil }, set: { if !$0 { error = nil } }
        )) {
            Button("OK") { error = nil }
        } message: {
            Text(error ?? "")
        }
    }

    private func cancel() {
        Task {
            do { try await AppModel.shared.client.deleteSchedule(item.id) }
            catch { self.error = error.localizedDescription }
        }
    }
}
