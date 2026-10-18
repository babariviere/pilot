import PilotCore
import SwiftUI

/// Caches the composer's usage presentation per input change, not per layout probe, hover or popover update.
final class ComposerUsageState: ObservableObject {
    @Published var showingDetails = false
    private var key: Key?
    private var cached = Display()

    private struct Key: Equatable {
        let usage: SessionUsage
        let locale: String
        let timeZone: String
        /// Resets and staleness change the line without new data, so the minute is part of the input.
        let minute: Int
    }

    struct Indicator: Equatable {
        let fraction: Double?
        let percent: Double?
        let label: String
        let help: String
    }

    struct Display: Equatable {
        /// The context gauge and its figure in the composer bar.
        var context: Indicator?
        /// One line above the composer, only past 80% of a subscription window or when limited.
        var notice: SubscriptionNotice?
    }

    func display(usage: SessionUsage, now: Date = Date()) -> Display {
        let next = Key(usage: usage, locale: Locale.current.identifier, timeZone: TimeZone.current.identifier,
                       minute: Int(now.timeIntervalSince1970 / 60))
        if next == key { return cached }
        var display = Display()
        if let context = usage.context {
            display.context = Indicator(fraction: context.gaugeFraction, percent: context.displayedPercent,
                                        label: context.percentLabel, help: context.helpText)
        }
        display.notice = usage.subscription?.notice(now: now)
        key = next
        cached = display
        return display
    }
}

/// The context gauge with its figure, in the composer bar beside the send controls.
struct ContextUsageIndicator: View {
    let usage: SessionUsage
    @StateObject private var state = ComposerUsageState()
    @State private var showingAIUsage = false

    var body: some View {
        HStack(spacing: 5) {
            if let context = state.display(usage: usage).context {
                HStack(spacing: 4) {
                    UsageGauge(fraction: context.fraction, percent: context.percent)
                    Text(context.label)
                }
                .help(context.help)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(context.help)
            }
            if let ai = usage.ai {
                if state.display(usage: usage).context != nil { Text("·").foregroundStyle(Theme.faintForeground) }
                Button(ai.totalTokenLabel) { showingAIUsage.toggle() }
                    .buttonStyle(.plain)
                    .help(ai.helpText)
                    .popover(isPresented: $showingAIUsage) {
                        Text(ai.helpText).font(.callout).textSelection(.enabled).padding(16)
                            .frame(width: 360, alignment: .leading)
                    }
                    .accessibilityLabel("AI usage: \(ai.totalTokenLabel)")
                    .accessibilityHint("Show token and cost accounting")
            }
        }
        .font(.system(size: 11)).monospacedDigit().foregroundStyle(Theme.mutedForeground).fixedSize()
    }
}

/// Subscription usage is account-wide, so a chat mentions it only when it matters: one muted line with a warning
/// icon above the composer once a window passes 80% or is used up. Clicking it shows every window and reset time.
/// Optional actions sit at the trailing end of the same line.
struct SubscriptionUsageNotice<Actions: View>: View {
    let usage: SessionUsage
    @ViewBuilder var actions: () -> Actions
    @StateObject private var state = ComposerUsageState()

    init(usage: SessionUsage, @ViewBuilder actions: @escaping () -> Actions) {
        self.usage = usage
        self.actions = actions
    }

    var body: some View {
        if let notice = state.display(usage: usage).notice {
            SubscriptionNoticeLine(notice: notice, icon: PilotIcon.warning, showingDetails: $state.showingDetails,
                                   actions: actions)
        }
    }
}

extension SubscriptionUsageNotice where Actions == EmptyView {
    init(usage: SessionUsage) {
        self.init(usage: usage) { EmptyView() }
    }
}

/// The line both notices share: an amber symbol, muted text that opens the details, then trailing actions. When the
/// full text and the actions do not fit on one line, the actions move to a second row instead of truncating the text
/// (and its reset time) or wrapping a button.
private struct SubscriptionNoticeLine<Actions: View>: View {
    let notice: SubscriptionNotice
    let icon: PilotIcon
    @Binding var showingDetails: Bool
    let actions: () -> Actions

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                // Measured at full width, so this row is chosen only when nothing truncates.
                details.fixedSize(horizontal: true, vertical: false)
                Spacer(minLength: 0)
                actions()
            }
            VStack(alignment: .leading, spacing: 4) {
                details.frame(maxWidth: .infinity, alignment: .leading)
                actions()
            }
        }
        .padding(.horizontal, 10)
    }

    private var details: some View {
        Button { showingDetails.toggle() } label: {
            HStack(alignment: .firstTextBaseline, spacing: 5) {
                PilotSymbol(icon)
                    .foregroundStyle(Theme.warning)
                Text(notice.text)
                    .foregroundStyle(Theme.mutedForeground)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            .font(.system(size: 11))
            .monospacedDigit()
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(notice.help)
        .popover(isPresented: $showingDetails) {
            Text(notice.help)
                .font(.callout)
                .textSelection(.enabled)
                .padding(16)
                .frame(width: 340, alignment: .leading)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(notice.text)
        .accessibilityHint("Show subscription usage and reset times")
    }
}

/// Held work at a usage limit, or work forced past it. Replaces the usage notice while pilotd reports a pause.
struct SubscriptionPauseNotice<Actions: View>: View {
    let pause: SubscriptionPause
    @ViewBuilder var actions: () -> Actions
    @State private var showingDetails = false

    var body: some View {
        // Resume times are relative ("tomorrow at 09:00"), so the line refreshes each minute while shown.
        TimelineView(.everyMinute) { context in
            SubscriptionNoticeLine(notice: pause.notice(now: context.date),
                                   icon: pause.isForced ? PilotIcon.warning : PilotIcon.paused,
                                   showingDetails: $showingDetails, actions: actions)
        }
    }
}

@MainActor
final class SubscriptionForceState: ObservableObject {
    @Published private(set) var busy = false
    private let setForce: (String, Bool) async throws -> Void

    init(setForce: @escaping (String, Bool) async throws -> Void = { id, force in
        try await AppModel.shared.client.forceSubscription(id, force: force)
    }) {
        self.setForce = setForce
    }

    /// Returns the failure to show, or nil. Ignored while a change is in flight.
    func toggle(session: SessionSummary, perform: ((String, Bool) async throws -> Void)? = nil) async -> String? {
        guard !busy, !session.isReadOnlyHistory else { return nil }
        busy = true
        defer { busy = false }
        do {
            try await (perform ?? setForce)(session.id, !session.isWorkingPastUsageLimit)
            return nil
        } catch {
            return error.localizedDescription
        }
    }
}

/// Only while pilotd reports a pause: "Continue with another model…" and "Force work", or just "Pause at limit"
/// once forced, as quiet links.
struct SubscriptionLimitActions: View {
    @EndpointClient private var endpoint
    let session: SessionSummary
    let working: Bool
    @ObservedObject var modelPicker: ChatModelPickerState
    /// Owned by the notice: the line measures two layouts, which must share one in-flight state.
    @ObservedObject var force: SubscriptionForceState
    let onError: (String) -> Void

    var body: some View {
        HStack(spacing: 12) {
            if !session.isWorkingPastUsageLimit {
                Button("Continue with another model…") {
                    modelPicker.beginContinuation(session: session, working: working)
                }
                .disabled(!modelPicker.canContinue(session: session, working: working))
                .help(ModelContinuation.pickerHelp)
            }
            Button(session.isWorkingPastUsageLimit ? "Pause at limit" : "Force work") {
                Task { if let error = await force.toggle(session: session, perform: { id, value in try await endpoint.forceSubscription(id, force: value) }) { onError(error) } }
            }
            .disabled(force.busy || modelPicker.continuing)
            .help(session.isWorkingPastUsageLimit
                ? "Hold new work again until usage resets below the limit"
                : "Keep working past the usage limit. Pilot stops holding work for this chat.")
        }
        .buttonStyle(.link)
        .font(.pilot(.caption))
        .lineLimit(1)
        .fixedSize()
    }
}

/// What a chat shows above its composer about subscription limits: the pause (or forced work) with its actions when
/// pilotd reports one, else the plain near-limit usage notice, which has nothing to act on yet.
struct SubscriptionLimitNotice: View {
    let session: SessionSummary
    let working: Bool
    @ObservedObject var modelPicker: ChatModelPickerState
    let onError: (String) -> Void
    @StateObject private var force = SubscriptionForceState()

    var body: some View {
        if let pause = session.subscriptionPause {
            SubscriptionPauseNotice(pause: pause) { actions }
        } else {
            SubscriptionUsageNotice(usage: session.usage ?? SessionUsage())
        }
    }

    private var actions: some View {
        SubscriptionLimitActions(session: session, working: working, modelPicker: modelPicker, force: force,
                                 onError: onError)
    }
}

/// A small ring for a share of a limit. Warning from 75%, destructive from 90%.
struct UsageGauge: View {
    let fraction: Double?
    let percent: Double?

    var body: some View {
        ZStack {
            Circle().stroke(Theme.border, lineWidth: 2)
            if let fraction {
                Circle().trim(from: 0, to: fraction)
                    .stroke(color, style: StrokeStyle(lineWidth: 2, lineCap: .round))
                    .rotationEffect(.degrees(-90))
            } else {
                Text("?").font(.system(size: 8))
            }
        }
        .frame(width: 13, height: 13)
        .accessibilityHidden(true)
    }

    private var color: Color {
        guard let percent else { return Theme.mutedForeground }
        if percent >= 90 { return Theme.destructive }
        if percent >= 75 { return Theme.warning }
        return Theme.mutedForeground
    }
}
