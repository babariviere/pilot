//! A passive projection of Day's existing chat outcomes, not review or evidence.
use super::ritual::LocalDay;
use crate::{contract::DayOverview, model::FinishedToday};

#[cfg(target_os = "macos")]
use {
    super::{Error, native_clock::in_calendar, valid_id},
    crate::model::{FinishedChat, FinishedTodayStatus},
    objc2_foundation::{NSCalendar, NSCalendarUnit, NSDate},
    std::{collections::HashSet, ops::Range},
};

#[cfg(target_os = "macos")]
fn timestamp(at: u64) -> nsh_platform_macos::objc2::rc::Retained<NSDate> {
    NSDate::dateWithTimeIntervalSince1970(at as f64 / 1000.0)
}

#[cfg(target_os = "macos")]
fn day_bounds(calendar: &NSCalendar, day: &LocalDay) -> Result<Range<u64>, Error> {
    let date = timestamp(day.unix_ms);
    let parts = calendar.components_fromDate(
        NSCalendarUnit::Year | NSCalendarUnit::Month | NSCalendarUnit::Day,
        &date,
    );
    if day.date
        != format!(
            "{:04}-{:02}-{:02}",
            parts.year(),
            parts.month(),
            parts.day()
        )
    {
        return Err(Error::Unavailable);
    }
    let mut start = None;
    let mut span = 0.0;
    // SAFETY: valid writable storage for the returned date and time interval.
    if !unsafe {
        calendar.rangeOfUnit_startDate_interval_forDate(
            NSCalendarUnit::Day,
            Some(&mut start),
            &mut span,
            &date,
        )
    } {
        return Err(Error::Unavailable);
    }
    let start = start.ok_or(Error::Unavailable)?.timeIntervalSince1970();
    let bounds = (start * 1000.0).round() as u64..((start + span) * 1000.0).round() as u64;
    if start < 0.0 || !bounds.contains(&day.unix_ms) {
        return Err(Error::Unavailable);
    }
    Ok(bounds)
}

#[cfg(target_os = "macos")]
pub(crate) fn project(
    overview: Option<&DayOverview>,
    day: Option<&LocalDay>,
    live: bool,
) -> FinishedToday {
    let Some((overview, day)) = overview.zip(day) else {
        return FinishedToday::default();
    };
    let Some(section) = overview
        .recent_done
        .as_ref()
        .or(overview.dashboard.recent.as_ref())
    else {
        return FinishedToday::default();
    };
    in_calendar(&day.time_zone, |calendar| -> Result<FinishedToday, Error> {
        let bounds = day_bounds(calendar, day)?;
        let sorted = section
            .items
            .windows(2)
            .all(|rows| rows[0].outcome_at >= rows[1].outcome_at);
        let fully_read = section.total as usize == section.items.len()
            || (sorted
                && section.total as usize > section.items.len()
                && section
                    .items
                    .last()
                    .is_some_and(|last| last.outcome_at < bounds.start));
        let mut complete = overview.recent_done.is_some()
            && overview.complete
            && live
            && bounds.contains(&overview.observed_at)
            && fully_read;
        let mut seen = HashSet::new();
        let mut items = Vec::new();
        for row in &section.items {
            if row.outcome != "done" {
                complete &= overview.recent_done.is_none();
                continue;
            }
            if !bounds.contains(&row.outcome_at) {
                continue;
            }
            if !valid_id(&row.session_id)
                || row.mission_id.as_deref().is_some_and(|id| !valid_id(id))
                || !seen.insert(&row.session_id)
            {
                complete = false;
                continue;
            }
            let parts = calendar.components_fromDate(
                NSCalendarUnit::Hour | NSCalendarUnit::Minute,
                &timestamp(row.outcome_at),
            );
            items.push(FinishedChat {
                session_id: row.session_id.clone(),
                title: row.title.clone(),
                mission_id: row.mission_id.clone(),
                outcome_at: row.outcome_at,
                local_time: format!("{:02}:{:02}", parts.hour(), parts.minute()),
            });
        }
        items.sort_by(|a, b| {
            b.outcome_at
                .cmp(&a.outcome_at)
                .then(a.session_id.cmp(&b.session_id))
        });
        Ok(FinishedToday {
            status: if complete {
                FinishedTodayStatus::Complete
            } else {
                FinishedTodayStatus::Partial
            },
            date: Some(day.date.clone()),
            items,
        })
    })
    .unwrap_or_default()
}

// No supported OS calendar or clock source on other platforms.
#[cfg(not(target_os = "macos"))]
pub(crate) fn project(_: Option<&DayOverview>, _: Option<&LocalDay>, _: bool) -> FinishedToday {
    FinishedToday::default()
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use crate::contract::{RecentChat, Section, read_overview};
    use serde_json::json;

    fn day(date: &str, unix_ms: u64) -> LocalDay {
        LocalDay {
            date: date.into(),
            time_zone: "Europe/Paris".into(),
            hour: 12,
            unix_ms,
        }
    }

    fn overview(observed_at: u64) -> DayOverview {
        read_overview(&json!({
            "version": 1, "projectId": "p", "observedAt": observed_at, "complete": true,
            "dashboard": { "working": { "total": 0, "items": [] }, "missions": { "total": 0, "items": [] } },
            "controls": [], "reports": []
        }).to_string()).unwrap()
    }

    fn chat(id: &str, outcome_at: u64) -> RecentChat {
        RecentChat {
            session_id: id.into(),
            title: id.into(),
            mission_id: None,
            outcome: "done".into(),
            outcome_at,
        }
    }

    #[test]
    fn finished_today_uses_half_open_days_on_both_dst_transitions() {
        for (day, expected) in [
            (
                day("2026-03-29", 1_774_785_600_000),
                1_774_738_800_000..1_774_821_600_000,
            ),
            (
                day("2026-10-25", 1_792_929_600_000),
                1_792_879_200_000..1_792_969_200_000,
            ),
        ] {
            assert_eq!(
                in_calendar(&day.time_zone, |cal| day_bounds(cal, &day)).unwrap(),
                expected
            );
            let mut read = overview(day.unix_ms);
            read.recent_done = Some(Section {
                total: 4,
                items: vec![
                    chat("tomorrow", expected.end),
                    chat("last-ms", expected.end - 1),
                    chat("midnight", expected.start),
                    chat("yesterday", expected.start - 1),
                ],
            });
            let finished = project(Some(&read), Some(&day), true);
            assert_eq!(finished.status, FinishedTodayStatus::Complete);
            assert_eq!(finished.date.as_deref(), Some(day.date.as_str()));
            assert_eq!(
                finished
                    .items
                    .iter()
                    .map(|c| (c.session_id.as_str(), c.local_time.as_str()))
                    .collect::<Vec<_>>(),
                [("last-ms", "23:59"), ("midnight", "00:00")]
            );
        }
    }

    #[test]
    fn finished_today_distinguishes_missing_stale_legacy_and_truncated_reads() {
        use FinishedTodayStatus::*;
        const START: u64 = 1_792_879_200_000;
        let day = day("2026-10-25", 1_792_929_600_000);
        let mut read = overview(day.unix_ms);
        let project_read = |read: &DayOverview| project(Some(read), Some(&day), true);
        assert_eq!(project_read(&read).status, Unavailable);
        read.dashboard.recent = Some(Section {
            total: 2,
            items: vec![
                chat("done", START),
                RecentChat {
                    outcome: "failed".into(),
                    ..chat("failed", START)
                },
            ],
        });
        let legacy = project_read(&read);
        assert_eq!(legacy.status, Partial);
        assert_eq!(
            legacy
                .items
                .iter()
                .map(|c| c.session_id.as_str())
                .collect::<Vec<_>>(),
            ["done"]
        );

        read.recent_done = Some(Section::default());
        assert_eq!(project_read(&read).status, Complete);
        assert!(project_read(&read).items.is_empty());
        assert_eq!(project(Some(&read), None, true).status, Unavailable);
        assert_eq!(project(Some(&read), Some(&day), false).status, Partial);
        read.observed_at = START - 1;
        assert_eq!(
            project_read(&read).status,
            Partial,
            "prior day's read cannot prove today's emptiness"
        );
        read.observed_at = day.unix_ms;
        read.recent_done = Some(Section {
            total: 3,
            items: vec![chat("new", START + 1), chat("old", START)],
        });
        assert_eq!(
            project_read(&read).status,
            Partial,
            "an omitted row may share the midnight boundary"
        );
        read.recent_done.as_mut().unwrap().items[1].outcome_at = START - 1;
        assert_eq!(
            project_read(&read).status,
            Complete,
            "a newest-first page extends beyond today"
        );
    }
}
