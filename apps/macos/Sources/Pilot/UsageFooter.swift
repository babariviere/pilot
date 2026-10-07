import PilotCore
import SwiftUI

/// Session estimates and the latest subscription snapshot, independent of transcript token totals.
struct UsageFooter: View {
    let usage: SessionUsage

    var body: some View {
        if usage.hasDisplayData {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 14) {
                    context
                    Spacer(minLength: 8)
                    subscription
                }
                VStack(alignment: .leading, spacing: 6) {
                    context
                    subscription
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .font(.system(size: 11))
            .monospacedDigit()
            .foregroundStyle(Theme.mutedForeground)
            .padding(.horizontal, 14)
            .frame(maxWidth: Theme.column)
            .padding(.horizontal, 24)
            .padding(.top, 8)
            .padding(.bottom, 2)
            .frame(maxWidth: .infinity)
            .background(Theme.background)
        }
    }

    @ViewBuilder private var context: some View {
        if let context = usage.context {
            HStack(spacing: 6) {
                ZStack {
                    Circle().stroke(Theme.border, lineWidth: 3)
                    if let fraction = context.gaugeFraction {
                        Circle().trim(from: 0, to: fraction)
                            .stroke(contextColor(context), style: StrokeStyle(lineWidth: 3, lineCap: .round))
                            .rotationEffect(.degrees(-90))
                    } else {
                        Text("?").font(.system(size: 9, weight: .medium))
                    }
                }
                .frame(width: 16, height: 16)
                .accessibilityHidden(true)
                Text("Context \(context.percentLabel)")
                Text(context.tokenLabel).foregroundStyle(Theme.faintForeground)
            }
            .fixedSize()
            .help(context.helpText)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(context.helpText)
        }
    }

    @ViewBuilder private var subscription: some View {
        if let subscription = usage.subscription, subscription.hasDisplayData {
            HStack(spacing: 8) {
                HStack(spacing: 4) {
                    Circle().fill(providerColor(subscription.provider)).frame(width: 5, height: 5)
                    Text(subscription.providerLabel).foregroundStyle(providerColor(subscription.provider))
                }
                ForEach(Array(subscription.windows.enumerated()), id: \.offset) { _, window in
                    Text("\(window.label) \(window.percentLabel)")
                        .help(window.helpText)
                }
                if let availability = subscription.availabilityLabel {
                    Text(availability)
                        .foregroundStyle(subscription.error == nil ? Theme.mutedForeground : Theme.warning)
                }
                Image(systemName: subscription.error == nil ? "info.circle" : "exclamationmark.triangle")
                    .foregroundStyle(subscription.error == nil ? Theme.faintForeground : Theme.warning)
            }
            .fixedSize()
            .help(subscription.helpText)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(subscription.helpText)
        }
    }

    private func contextColor(_ context: ContextUsage) -> Color {
        guard let percent = context.displayedPercent else { return Theme.mutedForeground }
        if percent >= 90 { return Theme.destructive }
        if percent >= 75 { return Theme.warning }
        return Theme.info
    }

    private func providerColor(_ provider: SubscriptionProvider?) -> Color {
        switch provider {
        case .anthropic: Color(hex: 0xD97757)
        case .openai: Color(hex: 0x3B82F6)
        case nil: Theme.mutedForeground
        }
    }
}
