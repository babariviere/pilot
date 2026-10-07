import Foundation

public enum SessionTimeFormatting {
    /// Compact age of an epoch-millisecond activity timestamp.
    public static func relative(_ milliseconds: Double, now: Date = Date()) -> String {
        let seconds = max(0, now.timeIntervalSince1970 - milliseconds / 1_000)
        switch seconds {
        case ..<60: return "now"
        case ..<3_600: return "\(Int(seconds / 60))m"
        case ..<86_400: return "\(Int(seconds / 3_600))h"
        case ..<604_800: return "\(Int(seconds / 86_400))d"
        default: return "\(Int(seconds / 604_800))w"
        }
    }
}
