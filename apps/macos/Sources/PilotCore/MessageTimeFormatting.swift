import Foundation

public enum MessageTimeFormatting {
    public static func date(_ milliseconds: Double) -> Date? {
        // Keep malformed or absent metadata out of the UI and DateFormatter's supported range.
        guard milliseconds.isFinite, (0...253_402_300_799_999).contains(milliseconds) else { return nil }
        return Date(timeIntervalSince1970: milliseconds / 1_000)
    }

    /// Localized date and local time, with Today/Yesterday when appropriate.
    public static func label(_ milliseconds: Double, locale: Locale = .current,
                             timeZone: TimeZone = .current) -> String? {
        format(milliseconds, locale: locale, timeZone: timeZone, exact: false)
    }

    /// Full date, seconds and timezone for accessibility and the footer tooltip.
    public static func detail(_ milliseconds: Double, locale: Locale = .current,
                              timeZone: TimeZone = .current) -> String? {
        format(milliseconds, locale: locale, timeZone: timeZone, exact: true)
    }

    private static func format(_ milliseconds: Double, locale: Locale, timeZone: TimeZone, exact: Bool) -> String? {
        guard let date = date(milliseconds) else { return nil }
        let formatter = DateFormatter()
        formatter.locale = locale
        formatter.timeZone = timeZone
        formatter.dateStyle = exact ? .long : .medium
        formatter.timeStyle = exact ? .long : .short
        formatter.doesRelativeDateFormatting = !exact
        return formatter.string(from: date)
    }
}
