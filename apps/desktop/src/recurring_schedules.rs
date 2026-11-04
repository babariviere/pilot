//! Recurring rules in words, for the Automations page, its editor and the Inbox.
//! The daemon computes due times in the rule's own zone; these helpers only present them.
use crate::scheduled_messages::{Item, Recurrence, Run, Target};

const SHORT: [&str; 7] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const LONG: [&str; 7] = [
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
];
const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
const DAY: i64 = 86_400;

/// The computer's IANA zone ("Europe/Paris"), or UTC when it can't be read.
pub(crate) fn local_zone() -> &'static str {
    static ZONE: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    ZONE.get_or_init(|| {
        std::env::var("TZ")
            .ok()
            .map(|tz| tz.trim_start_matches(':').to_owned())
            .filter(|tz| zone_name(tz))
            .or_else(|| {
                let link = std::fs::read_link("/etc/localtime").ok()?;
                let link = link.to_string_lossy();
                let (_, zone) = link.split_once("zoneinfo/")?;
                zone_name(zone).then(|| zone.to_owned())
            })
            .unwrap_or_else(|| "UTC".into())
    })
}
/// Shape check only; Local validates the zone itself.
pub(crate) fn zone_name(zone: &str) -> bool {
    !zone.is_empty()
        && zone.len() <= 100
        && !zone.starts_with('/')
        && !zone.contains("..")
        && zone
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"/_-+".contains(&b))
}
fn ordinal(n: u8) -> String {
    let suffix = match (n % 10, n % 100) {
        (_, 11..=13) => "th",
        (1, _) => "st",
        (2, _) => "nd",
        (3, _) => "rd",
        _ => "th",
    };
    format!("{n}{suffix}")
}
fn day(n: u8) -> Option<usize> {
    (1..=7).contains(&n).then(|| usize::from(n - 1))
}
/// "Mondays at 09:00", "Weekdays at 08:30", "Monthly on the 1st at 09:00".
/// The zone follows only when it differs from `local`.
pub(crate) fn schedule(r: &Recurrence, local: &str) -> String {
    let days = match r.every.as_str() {
        "week" => r
            .weekday
            .and_then(day)
            .map_or_else(|| "Weekly".into(), |d| format!("{}s", LONG[d])),
        "month" => r.day_of_month.map_or_else(
            || "Monthly".into(),
            |d| format!("Monthly on the {}", ordinal(d)),
        ),
        _ => match r.weekdays.as_deref() {
            None => "Every day".into(),
            Some(w) if w.len() == 7 => "Every day".into(),
            Some([1, 2, 3, 4, 5]) => "Weekdays".into(),
            Some([6, 7]) => "Weekends".into(),
            Some([d]) => day(*d).map_or_else(|| "Every day".into(), |d| format!("{}s", LONG[d])),
            Some(w) => w
                .iter()
                .filter_map(|d| day(*d).map(|d| SHORT[d]))
                .collect::<Vec<_>>()
                .join(", "),
        },
    };
    let mut text = format!("{days} at {}", r.time);
    if r.time_zone != local {
        text.push_str(&format!(" ({})", r.time_zone));
    }
    text
}
/// A past time, short: "Today 09:12", "Yesterday 09:12", "Mon 09:12", "3 Nov".
pub(crate) fn past(at: u64, now: u64, offset: impl Fn(i64) -> i64) -> String {
    let (at, now) = ((at / 1000) as i64, (now / 1000) as i64);
    let local = at + offset(at);
    let day = local.div_euclid(DAY);
    let secs = local.rem_euclid(DAY);
    let time = format!("{:02}:{:02}", secs / 3600, secs % 3600 / 60);
    match (now + offset(now)).div_euclid(DAY) - day {
        0 => format!("Today {time}"),
        1 => format!("Yesterday {time}"),
        // Day 0 of the epoch was a Thursday.
        2..=6 => format!("{} {time}", SHORT[(day + 3).rem_euclid(7) as usize]),
        _ => {
            let (m, d) = civil(day);
            format!("{d} {}", MONTHS[(m - 1) as usize])
        }
    }
}
/// Gregorian (year, month, day) from epoch days.
fn ymd(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (
        yoe + era * 400 + i64::from(m <= 2),
        m,
        doy - (153 * mp + 2) / 5 + 1,
    )
}
fn civil(z: i64) -> (i64, i64) {
    let (_, m, d) = ymd(z);
    (m, d)
}
/// This computer's local calendar date, `days` after `now`.
pub(crate) fn local_date(now: u64, days: i64) -> (i32, u32, u32) {
    let secs = (now / 1000) as i64;
    let (y, m, d) =
        ymd((secs + crate::subscription_pause::local_offset(secs)).div_euclid(DAY) + days);
    (y as i32, m as u32, d as u32)
}
/// The last run, short: "✓ Mon 09:12, late", "Skipped Mon 09:00", "Missed 2 runs".
pub(crate) fn last_result(run: &Run, now: u64, offset: impl Fn(i64) -> i64 + Copy) -> String {
    match run.outcome.as_str() {
        "started" | "sent" if run.late => format!("✓ {}, late", past(run.at, now, offset)),
        "started" | "sent" => format!("✓ {}", past(run.at, now, offset)),
        "skipped_running" => format!("Skipped {}", past(run.due, now, offset)),
        "missed" => match run.count.unwrap_or(1) {
            1 => format!("Missed {}", past(run.due, now, offset)),
            n => format!("Missed {n} runs"),
        },
        "failed" => format!("Failed {}", past(run.at, now, offset)),
        _ => "Unknown result".into(),
    }
}
fn first_line(text: &str, cap: usize) -> String {
    let line = text
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("");
    let mut chars = line.chars();
    let short: String = chars.by_ref().take(cap).collect();
    if chars.next().is_some() {
        format!("{short}…")
    } else {
        short
    }
}
/// Why a notice needs a look, the same words as the Inbox row.
pub(crate) fn reason(
    run: &Run,
    message: bool,
    now: u64,
    offset: impl Fn(i64) -> i64 + Copy,
) -> String {
    match run.outcome.as_str() {
        "skipped_running" => "Skipped: the previous run is still working".into(),
        "missed" => match run.count.unwrap_or(1) {
            1 => "Missed a run: Pilot was off, asleep or offline".into(),
            n => format!("Missed {n} runs: Pilot was off, asleep or offline"),
        },
        "failed" => format!(
            "Failed to {}: {}",
            if message { "send" } else { "start" },
            run.error
                .as_deref()
                .map(|e| first_line(e, 160))
                .filter(|e| !e.is_empty())
                .unwrap_or_else(|| "check the rule and its chat".into())
        ),
        _ if run.late => {
            let secs = ((run.at / 1000) as i64 + offset((run.at / 1000) as i64)).rem_euclid(DAY);
            format!(
                "Ran late · due {}, started {:02}:{:02}",
                past(run.due, now, offset),
                secs / 3600,
                secs % 3600 / 60
            )
        }
        _ => "Ran".into(),
    }
}
/// "New chat: <first prompt line>" or "Message to <chat>".
pub(crate) fn action(item: &Item, chat_title: impl Fn(&str) -> Option<String>) -> String {
    match &item.target {
        Target::Chat { .. } => format!("New chat: {}", first_line(item.message(), 80)),
        Target::Message { session_id, .. } => format!(
            "Message to {}",
            chat_title(session_id).unwrap_or_else(|| "a chat not listed here".into())
        ),
    }
}
/// Epoch ms for a local wall time on this computer, or None for an invalid date.
pub(crate) fn local_instant(
    year: i32,
    month: u32,
    day: u32,
    hour: u32,
    minute: u32,
) -> Option<u64> {
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 23 || minute > 59 {
        return None;
    }
    // SAFETY: mktime reads and normalizes only the struct it is given.
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    tm.tm_year = year - 1900;
    tm.tm_mon = month as i32 - 1;
    tm.tm_mday = day as i32;
    tm.tm_hour = hour as i32;
    tm.tm_min = minute as i32;
    tm.tm_isdst = -1;
    let t = unsafe { libc::mktime(&mut tm) };
    // Normalization moved the date: it didn't exist (31 Feb).
    (t >= 0 && tm.tm_mday == day as i32 && tm.tm_mon == month as i32 - 1).then(|| t as u64 * 1000)
}
fn days_in_month(year: i32, month: u32) -> u32 {
    match month {
        2 if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}
/// The next occurrence after `now`, computed in the rule's zone. A zone this computer's
/// tzdb doesn't know has no preview. Local computes the real one; this is the editor's preview.
pub(crate) fn preview_next(r: &Recurrence, now: u64) -> Option<u64> {
    let (h, m) = r.time.split_once(':')?;
    let (h, m): (u32, u32) = (h.parse().ok()?, m.parse().ok()?);
    if h > 23 || m > 59 {
        return None;
    }
    let secs = (now / 1000) as i64;
    // Today's date in the rule's zone, and a wall time there as an instant.
    let zone = if r.time_zone == local_zone() {
        None
    } else {
        Some(jiff::tz::TimeZone::get(&r.time_zone).ok()?)
    };
    let offset = match &zone {
        None => crate::subscription_pause::local_offset(secs),
        Some(zone) => {
            let at = jiff::Timestamp::from_second(secs).ok()?;
            i64::from(zone.to_offset(at).seconds())
        }
    };
    let instant = |year: i32, month: u32, date: u32| match &zone {
        None => local_instant(year, month, date, h, m),
        Some(zone) => {
            let date = jiff::civil::Date::new(
                i16::try_from(year).ok()?,
                i8::try_from(month).ok()?,
                i8::try_from(date).ok()?,
            )
            .ok()?;
            let at = zone.to_timestamp(date.at(h as i8, m as i8, 0, 0)).ok()?;
            u64::try_from(at.as_millisecond()).ok()
        }
    };
    let today = (secs + offset).div_euclid(DAY);
    for ahead in 0..=62 {
        let day = today + ahead;
        let weekday = ((day + 3).rem_euclid(7) + 1) as u8;
        let (year, month, date) = ymd(day);
        let year = year as i32;
        let matches = match r.every.as_str() {
            "week" => r.weekday == Some(weekday),
            "month" => r.day_of_month.is_some_and(|d| {
                u32::from(d).min(days_in_month(year, month as u32)) == date as u32
            }),
            _ => r.weekdays.as_ref().is_none_or(|w| w.contains(&weekday)),
        };
        if matches
            && let Some(at) = instant(year, month as u32, date as u32)
            && at > now
        {
            return Some(at);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scheduled_messages_tests::TUESDAY;
    fn rule(every: &str) -> Recurrence {
        Recurrence {
            every: every.into(),
            time: "09:00".into(),
            time_zone: "Europe/Paris".into(),
            weekdays: None,
            weekday: None,
            day_of_month: None,
        }
    }
    fn run(outcome: &str, due: u64, at: u64) -> Run {
        Run {
            due,
            at,
            outcome: outcome.into(),
            late: false,
            session_id: None,
            count: None,
            error: None,
        }
    }
    #[test]
    fn schedules_in_words_show_the_zone_only_when_it_differs() {
        let mut r = rule("week");
        r.weekday = Some(1);
        assert_eq!(schedule(&r, "Europe/Paris"), "Mondays at 09:00");
        assert_eq!(schedule(&r, "UTC"), "Mondays at 09:00 (Europe/Paris)");
        let mut r = rule("day");
        assert_eq!(schedule(&r, "Europe/Paris"), "Every day at 09:00");
        r.weekdays = Some(vec![1, 2, 3, 4, 5]);
        assert_eq!(schedule(&r, "Europe/Paris"), "Weekdays at 09:00");
        r.weekdays = Some(vec![6, 7]);
        assert_eq!(schedule(&r, "Europe/Paris"), "Weekends at 09:00");
        r.weekdays = Some(vec![1, 3, 5]);
        assert_eq!(schedule(&r, "Europe/Paris"), "Mon, Wed, Fri at 09:00");
        r.weekdays = Some(vec![3]);
        assert_eq!(schedule(&r, "Europe/Paris"), "Wednesdays at 09:00");
        let mut r = rule("month");
        for (d, words) in [
            (1, "1st"),
            (2, "2nd"),
            (3, "3rd"),
            (11, "11th"),
            (22, "22nd"),
            (31, "31st"),
        ] {
            r.day_of_month = Some(d);
            assert_eq!(
                schedule(&r, "Europe/Paris"),
                format!("Monthly on the {words} at 09:00")
            );
        }
    }
    #[test]
    fn last_results_and_reasons() {
        let utc = |_| 0;
        let h = 3_600_000;
        let now = TUESDAY + 15 * h;
        let mut started = run("started", TUESDAY + 9 * h, TUESDAY + 9 * h + 12 * 60_000);
        assert_eq!(last_result(&started, now, utc), "✓ Today 09:12");
        started.late = true;
        assert_eq!(last_result(&started, now, utc), "✓ Today 09:12, late");
        // 2 November 2026 was a Monday.
        let mut late = run("sent", TUESDAY - 15 * h, TUESDAY - 10 * h);
        late.late = true;
        assert_eq!(
            reason(&late, true, now, utc),
            "Ran late · due Yesterday 09:00, started 14:00"
        );
        let earlier = TUESDAY - 6 * 24 * h + 9 * h;
        assert_eq!(past(earlier, now, utc), "Wed 09:00");
        assert_eq!(past(TUESDAY - 20 * 24 * h, now, utc), "14 Oct");
        assert_eq!(
            last_result(
                &run("skipped_running", TUESDAY + 9 * h, TUESDAY + 9 * h),
                now,
                utc
            ),
            "Skipped Today 09:00"
        );
        let mut missed = run("missed", TUESDAY + 9 * h, TUESDAY + 10 * h);
        assert_eq!(last_result(&missed, now, utc), "Missed Today 09:00");
        missed.count = Some(2);
        assert_eq!(last_result(&missed, now, utc), "Missed 2 runs");
        assert_eq!(
            reason(&missed, false, now, utc),
            "Missed 2 runs: Pilot was off, asleep or offline"
        );
        let mut failed = run("failed", TUESDAY + 9 * h, TUESDAY + 9 * h);
        failed.error = Some("Project removed\nstack".into());
        assert_eq!(
            reason(&failed, false, now, utc),
            "Failed to start: Project removed"
        );
        assert_eq!(
            reason(&failed, true, now, utc),
            "Failed to send: Project removed"
        );
        assert!(failed.needs_attention() && missed.needs_attention() && !late.needs_attention());
    }
    #[test]
    fn zone_names_and_local_instants() {
        for good in [
            "Europe/Paris",
            "UTC",
            "America/Argentina/Buenos_Aires",
            "Etc/GMT+5",
        ] {
            assert!(zone_name(good), "{good}");
        }
        for bad in ["", "/etc/passwd", "../x", "Europe/Paris\n", "a b"] {
            assert!(!zone_name(bad), "{bad:?}");
        }
        assert!(local_instant(2026, 2, 31, 9, 0).is_none());
        assert!(local_instant(2026, 13, 1, 9, 0).is_none());
        let at = local_instant(2026, 11, 3, 9, 30).unwrap();
        let secs = (at / 1000) as i64;
        let local = secs + crate::subscription_pause::local_offset(secs);
        assert_eq!(local.rem_euclid(DAY), 9 * 3600 + 30 * 60);
    }
    #[test]
    fn preview_matches_the_rule_in_this_zone() {
        let mut r = rule("week");
        r.time_zone = local_zone().into();
        r.weekday = Some(1);
        let now = TUESDAY + 12 * 3_600_000;
        let next = preview_next(&r, now).unwrap();
        assert!(next > now && next - now <= 7 * 86_400_000);
        let secs = (next / 1000) as i64;
        let local = secs + crate::subscription_pause::local_offset(secs);
        assert_eq!(
            ((local.div_euclid(DAY) + 3).rem_euclid(7)) + 1,
            1,
            "a Monday"
        );
        let mut m = rule("month");
        m.time_zone = local_zone().into();
        m.day_of_month = Some(31);
        // November has 30 days: the 31st runs on the 30th.
        let next = preview_next(&m, now).unwrap();
        let secs = (next / 1000) as i64;
        let day = (secs + crate::subscription_pause::local_offset(secs)).div_euclid(DAY);
        assert_eq!(civil(day), (11, 30));
        // Another zone: Monday 09:00 there, as an instant (Tokyo has no DST).
        let (zone, offset) = if local_zone() == "UTC" {
            ("Asia/Tokyo", 9 * 3_600)
        } else {
            ("UTC", 0)
        };
        r.time_zone = zone.into();
        let next = preview_next(&r, now).unwrap();
        assert!(next > now && next - now <= 7 * 86_400_000);
        let there = (next / 1000) as i64 + offset;
        assert_eq!(
            ((there.div_euclid(DAY) + 3).rem_euclid(7)) + 1,
            1,
            "a Monday"
        );
        assert_eq!(there.rem_euclid(DAY), 9 * 3_600, "09:00 there");
        r.time_zone = "Mars/Olympus_Mons".into();
        assert_eq!(
            preview_next(&r, now),
            None,
            "an unknown zone has no preview"
        );
    }
}
