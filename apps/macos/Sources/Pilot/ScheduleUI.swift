import PilotCore
import SwiftUI

// Scheduled chats and follow-ups: the Send later control of the composers, the sheet that picks or edits
// a trigger, and the rows that list pending items on Home, the project page and in the target chat.
// State icons and colours come from the ScheduleState tokens in Theme.swift.

/// When a scheduled item starts: its trigger, plus epoch milliseconds for At a time or the chosen
/// network names for the Wi-Fi triggers.
struct ScheduleWhen: Equatable {
    var trigger: ScheduleTrigger
    var at: Double? = nil
    var networkNames: [String]? = nil
}

/// Labels, times and notification text for scheduled items, kept apart from views so they can be tested.
enum ScheduleText {
    /// Triggers offered when scheduling. onWake exists in the protocol but is not offered.
    static let choices: [ScheduleTrigger] = [.onBack, .onOnline, .onJoinNetwork, .onLeaveNetwork, .at]

    /// The most networks one item can watch, as pilotd enforces.
    static let maxNetworks = 32

    /// Wi-Fi triggers need network names, which need Location access for Pilot Wi-Fi.
    static func isNetwork(_ trigger: ScheduleTrigger) -> Bool {
        trigger == .onJoinNetwork || trigger == .onLeaveNetwork
    }

    static func label(_ trigger: ScheduleTrigger) -> String {
        switch trigger {
        case .onBack: "When I’m back"
        case .onOnline: "When online"
        case .onWake: "After wake"
        case .onJoinNetwork: "When I join a network"
        case .onLeaveNetwork: "When I leave a network"
        case .at: "At a time"
        }
    }

    /// One sentence under the trigger picker.
    static func explanation(_ trigger: ScheduleTrigger) -> String {
        switch trigger {
        case .onBack: "Starts after this Mac next wakes from sleep and is online."
        case .onOnline: "Starts the next time this Mac reconnects after being offline."
        case .onWake: "Starts after this Mac next wakes from sleep."
        case .onJoinNetwork: "Starts the next time this Mac joins a chosen Wi-Fi network."
        case .onLeaveNetwork: "Starts the next time this Mac leaves a chosen Wi-Fi network."
        case .at: "If this Mac is asleep or offline then, it starts when you’re back."
        }
    }

    /// Trailing row label: the trigger, the networks of a Wi-Fi item or the time of an "at" item.
    /// With full, long network names stay whole, for tooltips and VoiceOver.
    static func when(_ item: ScheduledItem, full: Bool = false, now: Date = Date(), calendar: Calendar = .current) -> String {
        if isNetwork(item.trigger), let names = item.networkNames, !names.isEmpty {
            return networkLabel(item.trigger, names: names, full: full)
        }
        guard item.trigger == .at, let at = item.at else { return label(item.trigger) }
        return time(Date(timeIntervalSince1970: at / 1000), now: now, calendar: calendar)
    }

    /// "When I join Office", "When I join Office or Home", "When I leave Office or 2 others". Names longer
    /// than 20 characters are shortened unless full, which also lists every name.
    static func networkLabel(_ trigger: ScheduleTrigger, names: [String], full: Bool = false) -> String {
        let verb = trigger == .onLeaveNetwork ? "When I leave" : "When I join"
        let shown = names.map { full || $0.count <= 20 ? $0 : String($0.prefix(19)) + "…" }
        guard let first = shown.first, let last = shown.last else { return label(trigger) }
        switch shown.count {
        case 1: return "\(verb) \(first)"
        case 2: return "\(verb) \(first) or \(last)"
        default:
            return full ? "\(verb) \(shown.dropLast().joined(separator: ", ")) or \(last)"
                : "\(verb) \(first) or \(shown.count - 1) others"
        }
    }

    /// Picker order: the connected network, then known networks alphabetically, then chosen names macOS
    /// no longer lists (an edited item keeps them visible).
    static func networkChoices(_ status: WiFiStatus, selected: [String] = []) -> [String] {
        let current = status.available ? status.currentNetwork : nil
        var seen = Set<String>()
        let known = status.knownNetworks.sorted { $0.localizedStandardCompare($1) == .orderedAscending }
        return ([current].compactMap { $0 } + known + selected).filter { seen.insert($0).inserted }
    }

    /// Said when a Wi-Fi trigger's condition already holds as the item is saved. pilotd takes the current
    /// network as a baseline and never fires at once, so the sheet says so and offers Send now.
    static func networkHint(_ trigger: ScheduleTrigger, selected: [String], status: WiFiStatus?) -> String? {
        guard let status, status.authorization == .authorized, !selected.isEmpty else { return nil }
        let current = status.available ? status.currentNetwork : nil
        switch trigger {
        case .onJoinNetwork:
            guard let current, selected.contains(current) else { return nil }
            return "This Mac is on \(current) now, so this waits until it leaves and joins again."
        case .onLeaveNetwork:
            if let current, selected.contains(current) { return nil }
            return selected.count == 1
                ? "This Mac isn’t on \(selected[0]) now, so this waits until it joins and then leaves it."
                : "This Mac isn’t on these networks now, so this waits until it joins one and then leaves it."
        case .at, .onWake, .onOnline, .onBack:
            return nil
        }
    }

    /// Why the network picker can't list networks yet, or nil once Location access is granted.
    static func wifiAccessMessage(_ status: WiFiStatus) -> String? {
        switch status.authorization {
        case .authorized: nil
        case .notDetermined: "Pilot reads Wi-Fi network names with Location Services. macOS asks once, for Pilot Wi-Fi."
        case .denied: "Location access for Pilot Wi-Fi is off. Turn it on in System Settings to choose a network."
        case .restricted: "Location access for Pilot Wi-Fi is restricted on this Mac."
        case .disabled: "Location Services are off. Turn them on in System Settings to choose a network."
        case .unavailable: "Wi-Fi details aren’t available right now."
        }
    }

    /// "Today 9:00 AM", "Tomorrow 9:00 AM", then "Fri, Oct 16, 9:00 AM".
    static func time(_ date: Date, now: Date = Date(), calendar: Calendar = .current) -> String {
        let clock = date.formatted(date: .omitted, time: .shortened)
        if calendar.isDate(date, inSameDayAs: now) { return "Today \(clock)" }
        if let tomorrow = calendar.date(byAdding: .day, value: 1, to: now), calendar.isDate(date, inSameDayAs: tomorrow) {
            return "Tomorrow \(clock)"
        }
        return date.formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day().hour().minute())
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
        Image(systemName: state.symbolName)
            .foregroundStyle(state.color)
            .accessibilityLabel(state.accessibilityLabel)
    }
}

/// Send later, beside a composer's send button: a quiet clock menu, so scheduling stays one step away
/// from the primary Send. When I’m back and When online schedule at once; When I join…, When I leave… and
/// At a time… open ScheduleSheet with that trigger chosen.
struct SendLaterMenu: View {
    var disabled = false
    /// Sends at once instead, offered when a Wi-Fi trigger's condition already holds. Nil hides it.
    var sendNow: (() -> Void)? = nil
    let schedule: (ScheduleWhen) -> Void
    @State private var choosing: ScheduleTrigger?

    var body: some View {
        Menu {
            Section("Send later") {
                Button(ScheduleText.label(.onBack)) { schedule(ScheduleWhen(trigger: .onBack)) }
                Button(ScheduleText.label(.onOnline)) { schedule(ScheduleWhen(trigger: .onOnline)) }
                Button("When I Join…") { choosing = .onJoinNetwork }
                Button("When I Leave…") { choosing = .onLeaveNetwork }
                Button("At a Time…") { choosing = .at }
            }
        } label: {
            Image(systemName: "clock").font(.pilot(.body, weight: .medium))
        }
        .menuStyle(.button)
        .buttonStyle(QuietIconButtonStyle(size: 26))
        .menuIndicator(.hidden)
        .fixedSize()
        .disabled(disabled)
        .help("Send later")
        .accessibilityLabel("Send later")
        .sheet(isPresented: Binding(get: { choosing != nil }, set: { if !$0 { choosing = nil } })) {
            ScheduleSheet(title: "Send later", confirmTitle: "Schedule", trigger: choosing ?? .at,
                          sendNow: sendNow) { when in schedule(when) }
        }
    }
}

/// Picks a trigger, a time for At a time and networks for the Wi-Fi triggers. Used to schedule from Send
/// later and to edit a pending item.
struct ScheduleSheet: View {
    let title: String
    let confirmTitle: String
    /// Throwing keeps the sheet open with the error, as other sheets do.
    let submit: (ScheduleWhen) async throws -> Void
    let sendNow: (() -> Void)?
    @State private var trigger: ScheduleTrigger
    @State private var date: Date
    @State private var networks: Set<String>
    /// Names of an edited item, kept in the picker even when macOS no longer lists them.
    private let initialNetworks: [String]
    @State private var preselectedCurrent = false
    @State private var saving = false
    @State private var error: String?
    @StateObject private var wifi = WiFiPickerModel()
    @Environment(\.dismiss) private var dismiss

    init(title: String, confirmTitle: String, trigger: ScheduleTrigger, at: Double? = nil, networkNames: [String]? = nil,
         sendNow: (() -> Void)? = nil, submit: @escaping (ScheduleWhen) async throws -> Void) {
        self.title = title
        self.confirmTitle = confirmTitle
        self.submit = submit
        self.sendNow = sendNow
        initialNetworks = networkNames ?? []
        _trigger = State(initialValue: trigger)
        _date = State(initialValue: at.map { Date(timeIntervalSince1970: $0 / 1000) } ?? ScheduleSheet.suggestedTime())
        _networks = State(initialValue: Set(networkNames ?? []))
    }

    private var choices: [ScheduleTrigger] {
        ScheduleText.choices.contains(trigger) ? ScheduleText.choices : [trigger] + ScheduleText.choices
    }

    private var isNetwork: Bool { ScheduleText.isNetwork(trigger) }

    /// Chosen names in picker order.
    private var chosenNetworks: [String] {
        guard let status = wifi.status else { return initialNetworks.filter(networks.contains) }
        return ScheduleText.networkChoices(status, selected: initialNetworks + networks.sorted()).filter(networks.contains)
    }

    private var canSave: Bool {
        guard !saving else { return false }
        if trigger == .at { return date > Date() }
        if isNetwork { return wifi.status?.authorization == .authorized && !networks.isEmpty }
        return true
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(title).font(.headline)
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
                if isNetwork { networkSection }
            }
            .formStyle(.grouped)
            if let error {
                Text(error).font(.callout).foregroundStyle(Theme.destructive).textSelection(.enabled)
            }
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
                Button(saving ? "Saving…" : confirmTitle, action: save)
                    .keyboardShortcut(.defaultAction)
                    .disabled(!canSave)
            }
        }
        .padding(20)
        .frame(width: 420)
        .onAppear { if isNetwork { wifi.refresh() } }
        .onChange(of: trigger) { _, next in
            if ScheduleText.isNetwork(next), wifi.status == nil, !wifi.reading { wifi.refresh() }
        }
        .onChange(of: wifi.status) { _, status in preselectCurrent(status) }
        // The answer to the macOS prompt, or a change in System Settings, shows up when Pilot is active again.
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            if isNetwork, wifi.status?.authorization != .authorized { wifi.refresh() }
        }
        .onDisappear { wifi.stop() }
    }

    @ViewBuilder private var networkSection: some View {
        let hint = ScheduleText.networkHint(trigger, selected: chosenNetworks, status: wifi.status)
        Section {
            if let status = wifi.status, status.authorization == .authorized {
                NetworkPicker(status: status, extra: initialNetworks, selected: $networks)
            } else if let status = wifi.status {
                WiFiAccessRow(message: ScheduleText.wifiAccessMessage(status) ?? "", authorization: status.authorization,
                              detail: status.error, waiting: wifi.waitingForAnswer,
                              request: wifi.requestAccess, retry: wifi.refresh)
            } else if let error = wifi.error {
                WiFiAccessRow(message: "Couldn’t read Wi-Fi details.", authorization: nil, detail: error,
                              waiting: false, request: {}, retry: wifi.refresh)
            } else {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Checking Wi-Fi…").font(.pilot(.label)).foregroundStyle(Theme.mutedForeground)
                }
            }
        } header: {
            Text("Networks")
        } footer: {
            if let hint {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Image(systemName: "info.circle").foregroundStyle(Theme.faintForeground)
                    Text(hint).fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 4)
                    if let sendNow {
                        Button("Send Now") {
                            sendNow()
                            dismiss()
                        }
                        .controlSize(.small)
                        .help("Send it now instead of waiting for the next change")
                    }
                }
                .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
            } else if wifi.status != nil, let error = wifi.error {
                Text(error).font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground).lineLimit(2)
            }
        }
    }

    /// "When I leave…" is usually about the network this Mac is on, so it starts chosen. Only once, and only
    /// for a new item with nothing chosen.
    private func preselectCurrent(_ status: WiFiStatus?) {
        guard !preselectedCurrent, trigger == .onLeaveNetwork, networks.isEmpty, initialNetworks.isEmpty,
              let status, status.authorization == .authorized, status.available,
              let current = status.currentNetwork else { return }
        preselectedCurrent = true
        networks = [current]
    }

    private func save() {
        guard canSave else { return }
        saving = true
        error = nil
        let when = ScheduleWhen(
            trigger: trigger,
            at: trigger == .at ? date.timeIntervalSince1970 * 1000 : nil,
            networkNames: isNetwork ? chosenNetworks : nil
        )
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
}

/// Known Wi-Fi networks as checkboxes, the connected one first. Long lists scroll inside a bounded frame so
/// the sheet keeps its size.
private struct NetworkPicker: View {
    let status: WiFiStatus
    /// Chosen names that macOS no longer lists.
    let extra: [String]
    @Binding var selected: Set<String>

    private static let rowHeight: CGFloat = 22
    private static let visibleRows = 7

    var body: some View {
        let names = ScheduleText.networkChoices(status, selected: extra)
        let current = status.available ? status.currentNetwork : nil
        VStack(alignment: .leading, spacing: 6) {
            if names.isEmpty {
                Text("This Mac hasn’t joined any Wi-Fi networks yet.")
                    .font(.pilot(.label)).foregroundStyle(Theme.mutedForeground)
            } else if names.count > Self.visibleRows {
                ScrollView { rows(names, current: current) }
                    .frame(height: CGFloat(Self.visibleRows) * Self.rowHeight)
            } else {
                rows(names, current: current)
            }
            if !status.available {
                Text("Wi-Fi is off. You can still choose a network this Mac has joined before.")
                    .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func rows(_ names: [String], current: String?) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(names, id: \.self) { name in
                Toggle(isOn: Binding(
                    get: { selected.contains(name) },
                    set: { on in if on { selected.insert(name) } else { selected.remove(name) } }
                )) {
                    HStack(spacing: 6) {
                        Text(name).lineLimit(1).truncationMode(.middle)
                        if name == current {
                            Text("Connected").font(.pilot(.caption)).foregroundStyle(Theme.faintForeground)
                        }
                    }
                }
                .toggleStyle(.checkbox)
                .frame(maxWidth: .infinity, minHeight: Self.rowHeight, alignment: .leading)
                .disabled(!selected.contains(name) && selected.count >= ScheduleText.maxNetworks)
                .accessibilityLabel(name == current ? "\(name), connected" : name)
            }
        }
    }
}

/// Why networks can't be listed, with the one action that helps: ask macOS, open System Settings or retry.
/// Denial is changed in System Settings, never re-asked.
private struct WiFiAccessRow: View {
    let message: String
    let authorization: WiFiStatus.Authorization?
    let detail: String?
    let waiting: Bool
    let request: () -> Void
    let retry: () -> Void

    /// Location Services privacy pane, where the Pilot Wi-Fi entry lives.
    static let settingsURL = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_LocationServices")!

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: authorization == .notDetermined ? "location" : "location.slash")
                    .foregroundStyle(Theme.mutedForeground)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(message).font(.pilot(.label)).foregroundStyle(Theme.foreground)
                        .fixedSize(horizontal: false, vertical: true)
                    if let detail, authorization != .notDetermined {
                        Text(detail).font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground).lineLimit(2)
                    }
                }
            }
            HStack(spacing: 8) {
                switch authorization {
                case .notDetermined:
                    Button(waiting ? "Waiting for macOS…" : "Allow Location Access", action: request).disabled(waiting)
                case .denied, .disabled:
                    Button("Open System Settings") { NSWorkspace.shared.open(Self.settingsURL) }
                case .restricted, .authorized:
                    EmptyView()
                case .unavailable, nil:
                    Button("Try Again", action: retry)
                }
            }
            .controlSize(.small)
            .padding(.leading, 22)
        }
    }
}

/// Wi-Fi state for the network picker. Read when the picker appears and when Pilot becomes active again,
/// such as after System Settings. Asking for access is always the user's explicit action; while macOS still
/// asks, a bounded number of reads picks up the answer. Nothing runs once the sheet closes.
@MainActor
final class WiFiPickerModel: ObservableObject {
    @Published private(set) var status: WiFiStatus?
    @Published private(set) var error: String?
    @Published private(set) var waitingForAnswer = false
    @Published private(set) var reading = false
    private var task: Task<Void, Never>?
    private var generation = 0

    func refresh() {
        guard !waitingForAnswer else { return }
        let id = begin()
        reading = true
        task = Task { [weak self] in
            do {
                let status = try await AppModel.shared.client.wifiStatus()
                self?.finish(id, status: status, error: nil)
            } catch {
                self?.finish(id, status: nil, error: error)
            }
        }
    }

    func requestAccess() {
        let id = begin()
        waitingForAnswer = true
        error = nil
        task = Task { [weak self] in
            do {
                var status = try await AppModel.shared.client.requestWiFiAuthorization()
                // macOS answers asynchronously; about a minute of reads covers the prompt being on screen.
                for _ in 0..<40 where status.authorization == .notDetermined {
                    guard let self, self.generation == id else { return }
                    self.status = status
                    try await Task.sleep(for: .milliseconds(1500))
                    status = try await AppModel.shared.client.wifiStatus()
                }
                self?.finish(id, status: status, error: nil)
            } catch {
                self?.finish(id, status: nil, error: error)
            }
        }
    }

    func stop() {
        generation += 1
        task?.cancel()
        task = nil
        reading = false
        waitingForAnswer = false
    }

    private func begin() -> Int {
        task?.cancel()
        generation += 1
        return generation
    }

    private func finish(_ id: Int, status: WiFiStatus?, error: Error?) {
        guard id == generation else { return }
        if let status { self.status = status }
        if let error, !(error is CancellationError) { self.error = error.localizedDescription } else if status != nil { self.error = nil }
        reading = false
        waitingForAnswer = false
        task = nil
    }
}

/// Edits the trigger of a pending item. Only pending items can change; pilotd rejects stale revisions.
struct EditScheduleSheet: View {
    let item: ScheduledItem

    var body: some View {
        ScheduleSheet(title: "Edit schedule", confirmTitle: "Save", trigger: item.trigger, at: item.at,
                      networkNames: item.networkNames) { when in
            _ = try await AppModel.shared.client.updateSchedule(
                item.id, SchedulePatch(trigger: when.trigger, at: when.at, networkNames: when.networkNames,
                                       expectedRevision: item.revision)
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
        let fullWhen = ScheduleText.when(item, full: true)
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
                        .help(fullWhen)
                }
                Button(action: remove) { Image(systemName: "xmark") }
                    .buttonStyle(QuietIconButtonStyle(hoverTint: Theme.destructive))
                    .revealed(hovered)
                    .help(pending ? "Cancel this scheduled item" : "Dismiss")
                    .accessibilityLabel(pending ? "Cancel schedule" : "Dismiss")
            }
        }
        .onTapGesture(perform: primary)
        .contextMenu { actions }
        .accessibilityElement(children: .combine)
        .accessibilityLabel([item.title, detail, pending ? fullWhen : nil].compactMap { $0 }.joined(separator: ", "))
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

/// Pending follow-ups for this chat, as one-line rows at the top of the composer tray like queued messages.
/// Reads schedules through a publisher, so schedule and session updates never re-render the composer.
struct ScheduledFollowUpsStrip: View {
    let sessionId: String
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var items: [ScheduledItem] = []

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(items) { item in
                ScheduledFollowUpRow(item: item)
                    .transition(Theme.Motion.insertion(reduceMotion: reduceMotion))
            }
        }
        .padding(.horizontal, 4)
        .padding(.top, items.isEmpty ? 0 : 4)
        .animation(Theme.Motion.standard(reduceMotion: reduceMotion), value: items.map(\.id))
        .onReceive(AppModel.shared.client.$schedules) { all in
            let next = ScheduleText.followUps(all, sessionId: sessionId)
            if next.map(\.id) != items.map(\.id) || next.map(\.revision) != items.map(\.revision) { items = next }
        }
    }
}

private struct ScheduledFollowUpRow: View {
    let item: ScheduledItem
    @Environment(\.pilotFonts) private var fonts
    @State private var hovered = false
    @State private var editing = false
    @State private var error: String?

    private var text: String {
        if case let .message(_, message) = item.target { return message.replacingOccurrences(of: "\n", with: " ") }
        return item.title
    }

    var body: some View {
        let when = ScheduleText.when(item)
        let fullWhen = ScheduleText.when(item, full: true)
        HStack(spacing: 8) {
            ScheduleStateIcon(state: item.state).font(.pilot(.caption, weight: .semibold)).frame(width: 14)
            Text(text).font(fonts.body)
                .foregroundStyle(hovered ? Theme.foreground : Theme.mutedForeground)
                .lineLimit(1).truncationMode(.tail)
            Spacer(minLength: 4)
            if hovered {
                HStack(spacing: 0) {
                    Button { editing = true } label: { Image(systemName: "pencil") }
                        .buttonStyle(QuietIconButtonStyle())
                        .help("Edit when this message is sent")
                        .accessibilityLabel("Edit schedule")
                    Button(action: cancel) { Image(systemName: "xmark") }
                        .buttonStyle(QuietIconButtonStyle(hoverTint: Theme.destructive))
                        .help("Cancel this scheduled message")
                        .accessibilityLabel("Cancel schedule")
                }
                .transition(.opacity)
            } else {
                Text(when).font(.pilot(.caption)).foregroundStyle(Theme.faintForeground).lineLimit(1).fixedSize()
            }
        }
        .padding(.horizontal, 8)
        .frame(maxWidth: .infinity, minHeight: QueuedMessagesStrip.rowHeight, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 6).fill(hovered ? Theme.selected : .clear))
        .contentShape(RoundedRectangle(cornerRadius: 6))
        .onTapGesture { editing = true }
        .onHover { hovered = $0 }
        .animation(Theme.Motion.quick, value: hovered)
        .help("Scheduled · \(fullWhen)")
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Scheduled, \(fullWhen): \(text)")
        .accessibilityAction(named: "Edit schedule") { editing = true }
        .accessibilityAction(named: "Cancel schedule", cancel)
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
