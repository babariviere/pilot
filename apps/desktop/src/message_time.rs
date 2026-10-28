//! A message's sent time: pi-ai's epoch-millisecond `timestamp` on the message
//! itself, never the time the viewer received or rendered it.
use serde_json::Value;

/// The Swift app's accepted range (DateFormatter's last supported instant).
const LATEST_MS: f64 = 253_402_300_799_999.;

/// The message's own sent time, or None when absent or malformed.
pub(crate) fn read(message: &Value) -> Option<u64> {
    message["timestamp"]
        .as_f64()
        .filter(|ms| (0. ..=LATEST_MS).contains(ms))
        .map(|ms| ms as u64)
}

/// Date and time in local time, with Today/Yesterday: the system's localized
/// formatter on macOS, else "Today at 14:05" or "27 Oct 2026 at 14:05".
pub(crate) fn label(ms: u64) -> String {
    #[cfg(target_os = "macos")]
    if let Some(text) = native::current(ms, false) {
        return text;
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64);
    label_with(ms, now, crate::subscription_pause::local_offset)
}

/// Full date, seconds and time zone, for the tooltip.
pub(crate) fn detail(ms: u64) -> String {
    #[cfg(target_os = "macos")]
    if let Some(text) = native::current(ms, true) {
        return text;
    }
    detail_with(ms, crate::subscription_pause::local_offset)
}

const MONTHS: [&str; 12] = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
];

fn label_with(ms: u64, now_ms: u64, offset: impl Fn(i64) -> i64) -> String {
    let (day, secs) = local(ms, &offset);
    let (today, _) = local(now_ms, &offset);
    let time = format!("{:02}:{:02}", secs / 3600, secs % 3600 / 60);
    match day - today {
        0 => format!("Today at {time}"),
        -1 => format!("Yesterday at {time}"),
        1 => format!("Tomorrow at {time}"),
        _ => {
            let (y, m, d) = civil(day);
            format!("{d} {} {y} at {time}", &MONTHS[m - 1][..3])
        }
    }
}

fn detail_with(ms: u64, offset: impl Fn(i64) -> i64) -> String {
    let (day, secs) = local(ms, &offset);
    let (y, m, d) = civil(day);
    let zone = offset((ms / 1000) as i64);
    let (sign, zone) = if zone < 0 { ('-', -zone) } else { ('+', zone) };
    let zone = match (zone / 3600, zone % 3600 / 60) {
        (0, 0) => "GMT".to_string(),
        (h, 0) => format!("GMT{sign}{h}"),
        (h, m) => format!("GMT{sign}{h}:{m:02}"),
    };
    format!(
        "{d} {} {y} at {:02}:{:02}:{:02} {zone}",
        MONTHS[m - 1],
        secs / 3600,
        secs % 3600 / 60,
        secs % 60
    )
}

/// Local day number since the epoch and seconds into that day.
fn local(ms: u64, offset: &impl Fn(i64) -> i64) -> (i64, i64) {
    let at = (ms / 1000) as i64;
    let local = at + offset(at);
    (local.div_euclid(86_400), local.rem_euclid(86_400))
}

/// Proleptic Gregorian (year, month, day) for a day number since 1970-01-01.
fn civil(day: i64) -> (i64, usize, i64) {
    let z = day + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(m <= 2), m as usize, d)
}

/// The system date formatter (CoreFoundation's CFDateFormatter, which backs the
/// Swift app's DateFormatter), so labels follow the user's locale settings.
#[cfg(target_os = "macos")]
mod native {
    use std::ffi::c_void;
    use std::ptr::null;

    type Ref = *const c_void;
    type Index = isize;
    const UTF8: u32 = 0x0800_0100;
    const SHORT: Index = 1;
    const MEDIUM: Index = 2;
    const LONG: Index = 3;
    /// CFAbsoluteTime counts seconds from 2001-01-01 UTC.
    const EPOCH_2001: f64 = 978_307_200.;

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        static kCFBooleanTrue: Ref;
        static kCFDateFormatterDoesRelativeDateFormattingKey: Ref;
        static kCFDateFormatterTimeZone: Ref;
        fn CFLocaleCopyCurrent() -> Ref;
        fn CFLocaleCreate(alloc: Ref, identifier: Ref) -> Ref;
        fn CFTimeZoneCreateWithTimeIntervalFromGMT(alloc: Ref, seconds: f64) -> Ref;
        fn CFDateFormatterCreate(alloc: Ref, locale: Ref, date: Index, time: Index) -> Ref;
        fn CFDateFormatterSetProperty(formatter: Ref, key: Ref, value: Ref);
        fn CFDateFormatterCreateStringWithAbsoluteTime(alloc: Ref, formatter: Ref, at: f64) -> Ref;
        fn CFStringCreateWithBytes(
            alloc: Ref,
            bytes: *const u8,
            len: Index,
            encoding: u32,
            external: u8,
        ) -> Ref;
        fn CFStringGetLength(string: Ref) -> Index;
        fn CFStringGetMaximumSizeForEncoding(len: Index, encoding: u32) -> Index;
        fn CFStringGetCString(string: Ref, buffer: *mut u8, size: Index, encoding: u32) -> u8;
        fn CFRelease(object: Ref);
    }

    /// An owned (+1) CoreFoundation object.
    struct Owned(Ref);
    impl Owned {
        fn new(object: Ref) -> Option<Self> {
            (!object.is_null()).then_some(Self(object))
        }
    }
    impl Drop for Owned {
        fn drop(&mut self) {
            // SAFETY: created by a CF Create/Copy call and released once.
            unsafe { CFRelease(self.0) }
        }
    }

    pub(super) struct Formatter(Owned);
    impl Formatter {
        /// The Swift app's label (medium date, short time, Today/Yesterday) or
        /// detail (long date and time). None uses the user's current locale and
        /// the system time zone.
        pub(super) fn new(
            exact: bool,
            locale: Option<&str>,
            gmt_offset: Option<f64>,
        ) -> Option<Self> {
            // SAFETY: plain CoreFoundation calls on owned, non-null objects.
            unsafe {
                let locale = match locale {
                    Some(id) => {
                        let id = Owned::new(CFStringCreateWithBytes(
                            null(),
                            id.as_ptr(),
                            id.len() as Index,
                            UTF8,
                            0,
                        ))?;
                        Owned::new(CFLocaleCreate(null(), id.0))?
                    }
                    None => Owned::new(CFLocaleCopyCurrent())?,
                };
                let (date, time) = if exact { (LONG, LONG) } else { (MEDIUM, SHORT) };
                let formatter = Owned::new(CFDateFormatterCreate(null(), locale.0, date, time))?;
                if !exact {
                    CFDateFormatterSetProperty(
                        formatter.0,
                        kCFDateFormatterDoesRelativeDateFormattingKey,
                        kCFBooleanTrue,
                    );
                }
                if let Some(seconds) = gmt_offset {
                    let zone =
                        Owned::new(CFTimeZoneCreateWithTimeIntervalFromGMT(null(), seconds))?;
                    CFDateFormatterSetProperty(formatter.0, kCFDateFormatterTimeZone, zone.0);
                }
                Some(Self(formatter))
            }
        }

        pub(super) fn format(&self, ms: u64) -> Option<String> {
            let at = ms as f64 / 1000. - EPOCH_2001;
            // SAFETY: the formatter is live; the returned string is owned and
            // copied out with a buffer sized for its UTF-8 encoding.
            unsafe {
                let text = Owned::new(CFDateFormatterCreateStringWithAbsoluteTime(
                    null(),
                    (self.0).0,
                    at,
                ))?;
                let size = CFStringGetMaximumSizeForEncoding(CFStringGetLength(text.0), UTF8) + 1;
                let mut buffer = vec![0u8; usize::try_from(size).ok()?];
                if CFStringGetCString(text.0, buffer.as_mut_ptr(), size, UTF8) == 0 {
                    return None;
                }
                let end = buffer.iter().position(|b| *b == 0)?;
                buffer.truncate(end);
                String::from_utf8(buffer).ok()
            }
        }
    }

    thread_local! {
        /// Created once per (UI) thread, like the Swift app's formatters.
        static CURRENT: [Option<Formatter>; 2] =
            [Formatter::new(false, None, None), Formatter::new(true, None, None)];
    }

    pub(super) fn current(ms: u64, exact: bool) -> Option<String> {
        CURRENT.with(|formatters| formatters[usize::from(exact)].as_ref()?.format(ms))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // 2026-10-28 09:05:07.250 UTC.
    const AT: u64 = 1_793_178_307_250;
    const DAY: u64 = 86_400_000;

    #[test]
    fn reads_only_the_messages_own_valid_timestamp() {
        assert_eq!(read(&json!({"timestamp": AT})), Some(AT));
        assert_eq!(read(&json!({"timestamp": 1.5e12})), Some(1_500_000_000_000));
        assert_eq!(read(&json!({"timestamp": 0})), Some(0));
        assert_eq!(
            read(&json!({"timestamp": 253_402_300_799_999u64})),
            Some(253_402_300_799_999)
        );
        for value in [
            json!({}),
            json!({"timestamp": null}),
            json!({"timestamp": -1}),
            json!({"timestamp": 253_402_300_800_000u64}),
            json!({"timestamp": "1793178307250"}),
            json!({"timestamp": {"ms": AT}}),
        ] {
            assert_eq!(read(&value), None, "{value}");
        }
    }

    #[test]
    fn label_is_relative_for_adjacent_local_days_and_dated_otherwise() {
        let utc = |_| 0;
        assert_eq!(label_with(AT, AT + 60_000, utc), "Today at 09:05");
        assert_eq!(label_with(AT, AT + DAY, utc), "Yesterday at 09:05");
        assert_eq!(label_with(AT, AT - DAY, utc), "Tomorrow at 09:05");
        assert_eq!(label_with(AT, AT + 2 * DAY, utc), "28 Oct 2026 at 09:05");
        assert_eq!(label_with(0, AT, utc), "1 Jan 1970 at 00:00");
        assert_eq!(
            label_with(951_782_400_000, AT, utc),
            "29 Feb 2000 at 00:00",
            "leap day"
        );
    }

    #[test]
    fn local_offset_decides_the_day_and_clock() {
        // 09:05 UTC is 23:05 the previous day at UTC-10 and 18:35 at UTC+9:30.
        let hawaii = |_| -10 * 3600;
        assert_eq!(label_with(AT, AT, hawaii), "Today at 23:05");
        assert_eq!(
            label_with(AT, AT + 2 * 3_600_000, hawaii),
            "Yesterday at 23:05"
        );
        assert_eq!(label_with(AT, AT, |_| 9 * 3600 + 1800), "Today at 18:35");
    }

    #[test]
    fn detail_has_full_date_seconds_and_offset() {
        assert_eq!(detail_with(AT, |_| 0), "28 October 2026 at 09:05:07 GMT");
        assert_eq!(
            detail_with(AT, |_| 3600),
            "28 October 2026 at 10:05:07 GMT+1"
        );
        assert_eq!(
            detail_with(AT, |_| -10 * 3600),
            "27 October 2026 at 23:05:07 GMT-10"
        );
        assert_eq!(
            detail_with(AT, |_| 5 * 3600 + 1800),
            "28 October 2026 at 14:35:07 GMT+5:30"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn native_formatter_follows_locale_and_time_zone() {
        use super::native::Formatter;
        let format = |exact, locale, offset, ms| {
            Formatter::new(exact, Some(locale), offset)
                .unwrap()
                .format(ms)
                .unwrap()
        };
        let en = format(true, "en_US", Some(0.), AT);
        assert!(
            en.contains("October 28, 2026") && en.contains("9:05:07"),
            "{en}"
        );
        let fr = format(true, "fr_FR", Some(3600.), AT);
        assert!(
            fr.contains("28 octobre 2026") && fr.contains("10:05:07"),
            "{fr}"
        );
        let de = format(false, "de_DE", Some(0.), AT - 400 * DAY);
        assert!(de.contains("2025") && de.contains("09:05"), "{de}");
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        let today = format(false, "en_US", None, now);
        assert!(today.starts_with("Today"), "{today}");
        let aujourdhui = format(false, "fr_FR", None, now).to_lowercase();
        assert!(aujourdhui.starts_with("aujourd"), "{aujourdhui}");
        // The production path uses the user's settings.
        assert!(super::native::current(AT, false).is_some());
        assert!(super::native::current(AT, true).is_some());
    }
}
