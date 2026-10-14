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

    var body: some View {
        if let context = state.display(usage: usage).context {
            HStack(spacing: 4) {
                UsageGauge(fraction: context.fraction, percent: context.percent)
                Text(context.label)
            }
            .font(.system(size: 11))
            .monospacedDigit()
            .foregroundStyle(Theme.mutedForeground)
            .fixedSize()
            .help(context.help)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(context.help)
        }
    }
}

/// Subscription usage is account-wide, so a chat mentions it only when it matters: one muted line with a warning
/// icon above the composer once a window passes 80% or is used up. Clicking it shows every window and reset time.
struct SubscriptionUsageNotice: View {
    let usage: SessionUsage
    @StateObject private var state = ComposerUsageState()

    var body: some View {
        if let notice = state.display(usage: usage).notice {
            Button { state.showingDetails.toggle() } label: {
                HStack(alignment: .firstTextBaseline, spacing: 5) {
                    Image(systemName: "exclamationmark.triangle")
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
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 10)
            .help(notice.help)
            .popover(isPresented: $state.showingDetails) {
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
