import PilotCore
import SwiftUI

/// System messages (coordinator, background jobs, PR follow-ups, subagents) waiting to join the chat, as one quiet
/// line at the top of the composer tray, above the user's own queue. Click it to list them read-only, with the same
/// steer and follow-up symbols as the queue strip. They leave the list as they join the run, then appear in the
/// transcript as automatic messages. Messages held by Stop get an amber line, with Send now and Discard when the
/// caller provides those actions.
struct SystemMessagesStrip: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// In delivery order.
    let inputs: [PendingAutomaticInput]
    var onSendHeld: (() -> Void)? = nil
    var onDiscardHeld: (() -> Void)? = nil
    var onDiscardRow: ((Int) -> Void)? = nil
    @State private var expanded: Bool

    init(inputs: [PendingAutomaticInput], expanded: Bool = false,
         onSendHeld: (() -> Void)? = nil, onDiscardHeld: (() -> Void)? = nil,
         onDiscardRow: ((Int) -> Void)? = nil) {
        self.inputs = inputs
        self.onSendHeld = onSendHeld
        self.onDiscardHeld = onDiscardHeld
        self.onDiscardRow = onDiscardRow
        _expanded = State(initialValue: expanded)
    }

    /// What the composer shows: held messages always, waiting ones only during a run. On an idle chat a system
    /// message starts a run straight away, so listing it would only flicker.
    static func visible(_ inputs: [PendingAutomaticInput], working: Bool) -> [PendingAutomaticInput] {
        PendingAutomaticInput.inDeliveryOrder(working ? inputs : inputs.filter(\.held))
    }

    var held: Bool { inputs.contains(where: \.held) }

    var title: String {
        let noun = inputs.count == 1 ? "system message" : "system messages"
        return held ? "\(inputs.count) \(noun) held" : "\(inputs.count) \(noun)"
    }

    /// Distinct origins, in delivery order.
    var origins: [InputOrigin] {
        inputs.reduce(into: []) { if !$0.contains($1.origin) { $0.append($1.origin) } }
    }

    /// Delivery modes present, steering first.
    var modes: [DeliveryMode] {
        [DeliveryMode.steer, .followUp].filter { mode in inputs.contains { $0.mode == mode } }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            summary
            if expanded {
                TimelineView(.periodic(from: .now, by: 60)) { context in
                    VStack(alignment: .leading, spacing: 2) {
                        ForEach(inputs) { input in
                            SystemMessageRow(input: input, now: context.date,
                                             onDiscard: input.held ? onDiscardRow.map { action in { action(input.id) } } : nil)
                                .transition(Theme.Motion.insertion(reduceMotion: reduceMotion))
                        }
                    }
                }
            }
        }
        .animation(Theme.Motion.standard(reduceMotion: reduceMotion), value: inputs.map(\.id))
    }

    private var summary: some View {
        HStack(spacing: 8) {
            Button(action: toggle) {
                HStack(spacing: 8) {
                    if held {
                        PilotSymbol(PilotIcon.paused)
                            .foregroundStyle(Theme.warning)
                            .frame(width: 14)
                    } else {
                        PilotSymbol(PilotIcon.proposal)
                            .foregroundStyle(Theme.faintForeground)
                            .frame(width: 14)
                    }
                    Text(title)
                        .font(.pilot(.label, weight: held ? .medium : .regular))
                        .foregroundStyle(held ? Theme.foreground : Theme.mutedForeground)
                        .lineLimit(1)
                    if held {
                        Text("You stopped the chat").font(.pilot(.caption)).foregroundStyle(Theme.faintForeground)
                            .lineLimit(1)
                    }
                    HStack(spacing: 5) {
                        ForEach(origins, id: \.self) { origin in
                            PilotSymbol(origin.icon).help(origin.title)
                        }
                    }
                    .font(.pilot(.small))
                    .foregroundStyle(Theme.faintForeground)
                    .accessibilityHidden(true)
                    Spacer(minLength: 4)
                    HStack(spacing: 2) {
                        ForEach(modes, id: \.self) { QueueModeSymbol(mode: $0) }
                    }
                    .accessibilityHidden(true)
                    if !held || (onSendHeld == nil && onDiscardHeld == nil) { chevron }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(expanded ? "Hide system messages" : "Show system messages")
            .accessibilityLabel(accessibilitySummary)
            .accessibilityHint(expanded ? "Hides the list" : "Shows the list")
            if held, onSendHeld != nil || onDiscardHeld != nil {
                HStack(spacing: 6) {
                    if let onDiscardHeld {
                        Button("Discard", action: onDiscardHeld).help("Discard the held system messages")
                    }
                    if let onSendHeld {
                        Button("Send now", action: onSendHeld)
                            .buttonStyle(.borderedProminent)
                            .help("Start a run with the held system messages")
                    }
                }
                .controlSize(.small)
                Button(action: toggle) { chevron }
                    .buttonStyle(.plain)
                    .accessibilityLabel(expanded ? "Hide system messages" : "Show system messages")
            }
        }
        .padding(.horizontal, 8)
        .frame(maxWidth: .infinity, minHeight: QueuedMessagesStrip.rowHeight, alignment: .leading)
    }

    private var chevron: some View {
        DisclosureChevron(expanded: expanded)
            .frame(width: 16, height: 16)
            .contentShape(Rectangle())
    }

    private var accessibilitySummary: String {
        let sources = origins.map(\.title).joined(separator: ", ")
        return sources.isEmpty ? title : "\(title): \(sources)"
    }

    private func toggle() {
        withAnimation(Theme.Motion.standard(reduceMotion: reduceMotion)) { expanded.toggle() }
    }
}

/// One waiting system message: delivery mode, origin, first line and age. Read-only.
private struct SystemMessageRow: View {
    let input: PendingAutomaticInput
    let now: Date
    let onDiscard: (() -> Void)?

    var body: some View {
        HStack(spacing: 8) {
            QueueModeSymbol(mode: input.mode)
            PilotSymbol(input.origin.icon)
                .foregroundStyle(Theme.faintForeground)
                .frame(width: 14)
            Text(input.origin.title)
                .font(.pilot(.label, weight: .medium))
                .foregroundStyle(Theme.mutedForeground)
                .lineLimit(1)
                .fixedSize()
            Text(input.preview)
                .font(.pilot(.label))
                .foregroundStyle(Theme.mutedForeground)
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: 4)
            if input.queuedAt > 0 {
                Text(SessionTimeFormatting.relative(input.queuedAt, now: now))
                    .font(.pilot(.caption))
                    .foregroundStyle(Theme.faintForeground)
                    .lineLimit(1)
                    .fixedSize()
            }
            if let onDiscard {
                Button(action: onDiscard) {
                    PilotSymbol(PilotIcon.dismiss, context: .toolbar)
                }
                .buttonStyle(.plain)
                .help("Discard this held system message")
                .accessibilityLabel("Discard held message: \(input.preview)")
            }
        }
        // The mode symbol sits under the summary's title.
        .padding(.leading, 30)
        .padding(.trailing, 8)
        .frame(maxWidth: .infinity, minHeight: QueuedMessagesStrip.rowHeight, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(input.mode == .steer ? "Steering" : "Follow-up"), \(input.origin.title): \(input.preview)")
    }
}
