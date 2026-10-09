import PilotCore
import SwiftUI

final class UsageFooterState: ObservableObject {
    @Published var showingDetails = false
    private var key: Key?
    private var cached = Display()

    private struct Key: Equatable {
        let usage: SessionUsage
        let model: String?
        let locale: String
        let timeZone: String
    }

    struct Indicator {
        let fraction: Double?
        let percent: Double?
        let label: String
        let help: String
    }

    struct Display {
        var context: Indicator?
        var windows: [Indicator] = []
        var hasSubscription = false
        var subscriptionHelp = ""
        var availability: String?
        var hasError = false
        /// No snapshot has arrived for a subscription model. Shown as a single info symbol whose
        /// help explains why, rather than a "Usage unavailable" label in every such chat.
        var missingSnapshot = false
    }

    /// One snapshot per input change, not per layout probe, hover, or popover update.
    func display(usage: SessionUsage, model: String?) -> Display {
        let next = Key(usage: usage, model: model, locale: Locale.current.identifier,
                       timeZone: TimeZone.current.identifier)
        if next == key { return cached }
        let fallback = usage.fallbackSubscriptionProvider(model: model)
        var display = Display()
        if let context = usage.context {
            display.context = Indicator(fraction: context.gaugeFraction, percent: context.displayedPercent,
                                        label: "Context \(context.percentLabel)", help: context.helpText)
        }
        display.windows = (usage.subscription?.windows ?? []).map {
            Indicator(fraction: $0.gaugeFraction, percent: $0.usedPercent,
                      label: "\($0.label) \($0.percentLabel)", help: $0.helpText)
        }
        display.hasSubscription = usage.subscription?.hasDisplayData == true || fallback != nil
        display.subscriptionHelp = usage.subscription?.helpText ?? fallback?.unavailableHelpText ?? ""
        display.availability = usage.subscription?.availabilityLabel
        display.missingSnapshot = usage.subscription == nil && fallback != nil
        display.hasError = usage.subscription?.error != nil
        key = next
        cached = display
        return display
    }
}

/// Compact usage indicators in the controls row below the chat box.
struct UsageFooter: View {
    let usage: SessionUsage
    var model: String? = nil
    @StateObject private var state = UsageFooterState()

    var body: some View {
        let display = state.display(usage: usage, model: model)
        ResponsiveControlsLayout {
            if let context = display.context { indicator(context) }
            subscription(display)
        }
        .font(.system(size: 11))
        .monospacedDigit()
        .foregroundStyle(Theme.mutedForeground)
    }

    private func indicator(_ value: UsageFooterState.Indicator) -> some View {
        HStack(spacing: 5) {
            UsageGauge(fraction: value.fraction, percent: value.percent)
            Text(value.label)
        }
        .fixedSize()
        .help(value.help)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(value.help)
    }

    @ViewBuilder private func subscription(_ display: UsageFooterState.Display) -> some View {
        if display.hasSubscription {
            Button { state.showingDetails.toggle() } label: {
                ResponsiveControlsLayout {
                    subscriptionWindows(display)
                }
            }
            .buttonStyle(.plain)
            .help(display.subscriptionHelp)
            .popover(isPresented: $state.showingDetails) {
                Text(display.subscriptionHelp)
                    .font(.callout)
                    .textSelection(.enabled)
                    .padding(16)
                    .frame(width: 340, alignment: .leading)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(display.subscriptionHelp)
            .accessibilityHint("Show subscription usage and reset times")
        }
    }

    @ViewBuilder private func subscriptionWindows(_ display: UsageFooterState.Display) -> some View {
        ForEach(display.windows.indices, id: \.self) { index in
            indicator(display.windows[index])
        }
        if let availability = display.availability {
            HStack(spacing: 5) {
                Image(systemName: display.hasError ? "exclamationmark.triangle" : "info.circle")
                Text(availability)
            }
            .fixedSize()
            .foregroundStyle(display.hasError ? Theme.warning : Theme.mutedForeground)
        } else if display.missingSnapshot {
            Image(systemName: "info.circle")
                .foregroundStyle(Theme.faintForeground)
                .fixedSize()
        }
    }
}

private struct UsageGauge: View {
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
