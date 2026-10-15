import Foundation

/// The one way to say when something happened or will happen. Archive rows, memory notes, schedules, the project
/// page and tracked items use it, so the same moment reads the same everywhere. Pair a relative time with
/// `exact(_:)` in its tooltip.
public enum RelativeDate {
    /// "3d ago", or "just now" within a minute. For rows and bylines.
    public static func ago(_ milliseconds: Double, now: Date = Date()) -> String {
        let compact = SessionTimeFormatting.relative(milliseconds, now: now)
        return compact == "now" ? "just now" : "\(compact) ago"
    }

    /// "3 minutes ago" or "yesterday", or "just now" within a minute. For sentences.
    public static func sentence(_ milliseconds: Double, now: Date = Date(), locale: Locale = .current) -> String {
        let date = Date(timeIntervalSince1970: milliseconds / 1000)
        guard now.timeIntervalSince(date) >= 60 else { return "just now" }
        let formatter = RelativeDateTimeFormatter()
        formatter.locale = locale
        formatter.unitsStyle = .full
        formatter.dateTimeStyle = .named
        return formatter.localizedString(for: date, relativeTo: now)
    }

    /// "Today 9:00 AM", "Tomorrow 9:00 AM", then "Fri, Oct 16, 9:00 AM". For upcoming times, such as schedules.
    public static func upcoming(_ date: Date, now: Date = Date(), calendar: Calendar = .current) -> String {
        let clock = date.formatted(date: .omitted, time: .shortened)
        if calendar.isDate(date, inSameDayAs: now) { return "Today \(clock)" }
        if let tomorrow = calendar.date(byAdding: .day, value: 1, to: now), calendar.isDate(date, inSameDayAs: tomorrow) {
            return "Tomorrow \(clock)"
        }
        return date.formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day().hour().minute())
    }

    /// "Oct 12, 2026 at 9:41 AM": the exact moment, for the tooltip beside a relative time.
    public static func exact(_ milliseconds: Double) -> String {
        Date(timeIntervalSince1970: milliseconds / 1000).formatted(date: .abbreviated, time: .shortened)
    }
}
