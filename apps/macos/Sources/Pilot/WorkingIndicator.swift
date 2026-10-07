import SwiftUI

/// A stationary label with a soft left-to-right highlight, followed by a short pause.
struct WorkingIndicator: View {
    let retry: String?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var label: String { retry.map { "Retrying: \($0)" } ?? "Working…" }
    private static let muted = Color(hex: 0x989898)
    static let cycleDuration: TimeInterval = 2.2

    /// Use a shared clock so transcript updates don't restart the wave.
    static func highlightProgress(at time: TimeInterval) -> Double {
        let phase = time.truncatingRemainder(dividingBy: cycleDuration)
        return min(phase / (cycleDuration * 0.8), 1)
    }

    var body: some View {
        Text(label)
            .foregroundStyle(reduceMotion ? Self.muted : .clear)
            .overlay {
                if !reduceMotion {
                    GeometryReader { geometry in
                        TimelineView(.animation(minimumInterval: 1.0 / 30)) { context in
                            let progress = Self.highlightProgress(at: context.date.timeIntervalSinceReferenceDate)
                            LinearGradient(
                                stops: [
                                    .init(color: Self.muted, location: 0),
                                    .init(color: Self.muted, location: 0.40),
                                    .init(color: Color(hex: 0x555555), location: 0.46),
                                    .init(color: Theme.foreground, location: 0.50),
                                    .init(color: Color(hex: 0x555555), location: 0.54),
                                    .init(color: Self.muted, location: 0.60),
                                    .init(color: Self.muted, location: 1),
                                ],
                                startPoint: .leading,
                                endPoint: .trailing
                            )
                            .frame(width: geometry.size.width * 3, height: geometry.size.height)
                            .offset(x: geometry.size.width * (-2 + 2 * progress))
                            .frame(width: geometry.size.width, height: geometry.size.height, alignment: .leading)
                            .mask(Text(label).foregroundStyle(.white).frame(maxWidth: .infinity, alignment: .leading))
                        }
                    }
                    .accessibilityHidden(true)
                }
            }
            .font(.callout)
            .lineLimit(1)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(label)
    }
}
