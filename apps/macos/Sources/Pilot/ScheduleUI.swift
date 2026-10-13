import PilotCore
import SwiftUI

/// Secondary composer action; the trigger and optional time are only shown after Send later is opened.
struct ScheduleChoice: View {
    @Binding var trigger: ScheduleTrigger
    @Binding var date: Date
    var disabled = false
    let action: () -> Void

    var body: some View {
        Menu {
            Button { trigger = .onBack } label: { triggerLabel("When I’m back", selected: trigger == .onBack) }
            Button { trigger = .onOnline } label: { triggerLabel("When online", selected: trigger == .onOnline) }
            Button { trigger = .at } label: { triggerLabel("At time…", selected: trigger == .at) }
            if trigger == .at {
                DatePicker("Send at", selection: $date, in: Date()..., displayedComponents: [.date, .hourAndMinute])
            }
            Divider()
            Button(action: action) { Label("Schedule", systemImage: "clock.badge.checkmark") }
                .disabled(disabled || (trigger == .at && date <= Date()))
        } label: {
            ChipLabel(title: "Send later", icon: "clock")
        }
        .chipMenuStyle()
        .fixedSize()
        .help("Schedule this work for later")
    }

    @ViewBuilder private func triggerLabel(_ title: String, selected: Bool) -> some View {
        if selected { Label(title, systemImage: "checkmark") }
        else { Text(title) }
    }
}

/// Home's scheduled section shares the same card frame and row treatment as its other dashboard sections.
struct ScheduledItemsCard: View {
    @ObservedObject private var client = AppModel.shared.client
    private var pending: [ScheduledItem] {
        client.schedules.filter { $0.state == .pending }.sorted { $0.createdAt > $1.createdAt }
    }

    var body: some View {
        DashboardCard(title: "Scheduled", icon: "clock", count: pending.count) {
            if pending.isEmpty {
                Text("Nothing scheduled.").font(.pilot(.body)).foregroundStyle(Theme.faintForeground)
            }
            ForEach(pending.prefix(5)) { item in
                if item.id != pending.first?.id { HairlineDivider(leading: 26) }
                ScheduledItemRow(item: item)
            }
        }
    }
}

/// Shared hairline-row treatment for the project page and Home, with accessible secondary actions.
struct ScheduledItemRow: View {
    @ObservedObject private var client = AppModel.shared.client
    let item: ScheduledItem
    var compact = false
    @State private var editing = false
    @State private var error: String?

    var body: some View {
        Group {
            if compact {
                Menu { actions } label: {
                    Label("Scheduled · \(triggerText)", systemImage: "clock")
                        .font(.pilot(.caption))
                        .foregroundStyle(Theme.mutedForeground)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(Capsule().fill(Theme.muted))
                }
                .chipMenuStyle()
            } else {
                HoverRow(verticalPadding: 7) { hovered in
                    HStack(spacing: 10) {
                        Image(systemName: "clock").foregroundStyle(Theme.mutedForeground).frame(width: 16)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(item.title).font(.pilot(.body)).foregroundStyle(Theme.foreground).lineLimit(1)
                            Text(detail).font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground).lineLimit(1)
                        }
                        Spacer(minLength: 8)
                        Text(triggerText).font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground).lineLimit(1)
                        Menu { actions } label: { Image(systemName: "ellipsis") }
                            .buttonStyle(QuietIconButtonStyle())
                            .menuStyle(.button).menuIndicator(.hidden)
                            .revealed(hovered)
                            .accessibilityLabel("Scheduled item actions")
                    }
                }
                .contextMenu { actions }
            }
        }
        .sheet(isPresented: $editing) { ScheduleEditSheet(item: item) }
        .alert("Couldn’t update schedule", isPresented: Binding(
            get: { error != nil }, set: { if !$0 { error = nil } }
        )) {
            Button("OK") { error = nil }
        } message: {
            Text(error ?? "")
        }
    }

    @ViewBuilder private var actions: some View {
        Button("Edit schedule…", systemImage: "pencil") { editing = true }
        Button("Cancel", systemImage: "xmark", role: .destructive) {
            Task {
                do { try await client.deleteSchedule(item.id) }
                catch { self.error = error.localizedDescription }
            }
        }
    }

    private var detail: String {
        switch item.target {
        case .chat: "New chat"
        case .message: "Follow-up message"
        }
    }

    private var triggerText: String {
        switch item.trigger {
        case .onBack, .onWake: "When I’m back"
        case .onOnline: "When online"
        case .at:
            item.at.map { Date(timeIntervalSince1970: $0 / 1000).formatted(date: .abbreviated, time: .shortened) } ?? "At time"
        }
    }
}

private struct ScheduleEditSheet: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject private var client = AppModel.shared.client
    let item: ScheduledItem
    @State private var trigger: ScheduleTrigger
    @State private var date: Date
    @State private var error: String?

    init(item: ScheduledItem) {
        self.item = item
        _trigger = State(initialValue: item.trigger)
        _date = State(initialValue: Date(timeIntervalSince1970: (item.at ?? Date().timeIntervalSince1970 * 1000) / 1000))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Edit schedule").font(.pilot(.headline))
            Picker("Send", selection: $trigger) {
                Text("When I’m back").tag(ScheduleTrigger.onBack)
                Text("When online").tag(ScheduleTrigger.onOnline)
                Text("At time…").tag(ScheduleTrigger.at)
            }
            if trigger == .at {
                DatePicker("Send at", selection: $date, in: Date()..., displayedComponents: [.date, .hourAndMinute])
            }
            if let error { Text(error).font(.pilot(.caption)).foregroundStyle(Theme.destructive) }
            HStack {
                Spacer()
                Button("Cancel", role: .cancel) { dismiss() }
                Button("Save", action: save).buttonStyle(.borderedProminent)
            }
        }
        .padding(24)
        .frame(maxWidth: Theme.column)
    }

    private func save() {
        Task {
            do {
                let at = trigger == .at ? date.timeIntervalSince1970 * 1000 : nil
                _ = try await client.updateSchedule(
                    item.id, SchedulePatch(trigger: trigger, at: at, expectedRevision: item.revision)
                )
                dismiss()
            } catch { self.error = error.localizedDescription }
        }
    }
}
