import PilotCore
import SwiftUI

private final class UsageFooterState: ObservableObject {
    @Published var showingDetails = false
}

/// Compact usage indicators in the controls row below the chat box.
struct UsageFooter: View {
    let usage: SessionUsage
    var model: String? = nil
    @StateObject private var state = UsageFooterState()

    private var fallbackProvider: SubscriptionProvider? { usage.fallbackSubscriptionProvider(model: model) }
    private var subscriptionHelp: String {
        usage.subscription?.helpText ?? fallbackProvider?.unavailableHelpText ?? ""
    }

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 12) {
                context
                subscription
            }
            VStack(alignment: .leading, spacing: 6) {
                context
                subscription
            }
        }
        .font(.system(size: 11))
        .monospacedDigit()
        .foregroundStyle(Theme.mutedForeground)
    }

    @ViewBuilder private var context: some View {
        if let context = usage.context {
            HStack(spacing: 5) {
                UsageGauge(fraction: context.gaugeFraction, percent: context.displayedPercent)
                Text("Context \(context.percentLabel)")
            }
            .fixedSize()
            .help(context.helpText)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(context.helpText)
        }
    }

    @ViewBuilder private var subscription: some View {
        if usage.subscription?.hasDisplayData == true || fallbackProvider != nil {
            Button { state.showingDetails.toggle() } label: {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 12) { subscriptionWindows }
                    VStack(alignment: .leading, spacing: 6) { subscriptionWindows }
                }
            }
            .buttonStyle(.plain)
            .help(subscriptionHelp)
            .popover(isPresented: $state.showingDetails) {
                Text(subscriptionHelp)
                    .font(.callout)
                    .textSelection(.enabled)
                    .padding(16)
                    .frame(width: 340, alignment: .leading)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(subscriptionHelp)
            .accessibilityHint("Show subscription usage and reset times")
        }
    }

    @ViewBuilder private var subscriptionWindows: some View {
        ForEach(Array((usage.subscription?.windows ?? []).enumerated()), id: \.offset) { _, window in
            HStack(spacing: 5) {
                UsageGauge(fraction: window.gaugeFraction, percent: window.usedPercent)
                Text("\(window.label) \(window.percentLabel)")
            }
            .fixedSize()
            .help(window.helpText)
        }
        if let availability = usage.subscription?.availabilityLabel ?? (fallbackProvider == nil ? nil : "Usage unavailable") {
            HStack(spacing: 5) {
                Image(systemName: usage.subscription?.error == nil ? "info.circle" : "exclamationmark.triangle")
                Text(availability)
            }
            .fixedSize()
            .foregroundStyle(usage.subscription?.error == nil ? Theme.mutedForeground : Theme.warning)
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
