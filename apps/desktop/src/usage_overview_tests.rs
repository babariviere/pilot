use super::*;
use crate::usage_overview_fixture as f;
use serde_json::json;
fn range() -> Range {
    Range::preset(7, 1_730_000_000_000).unwrap()
}
#[test]
fn utc_ranges_are_bounded_and_do_not_claim_all_history() {
    for days in [7, 30, 90] {
        let r = Range::preset(days, 1_730_000_000_000).unwrap();
        assert!(r.valid());
        assert!(r.to - r.from <= days * DAY);
        assert!(r.from.is_multiple_of(DAY));
    }
    assert!(Range::preset(366, 100).is_none());
    assert!(Range::preset(7, SAFE).is_none());
    assert_eq!(date(0), "1970-01-01");
    assert_eq!(date(1_709_164_800_000), "2024-02-29");
    assert_eq!(stamp(3_661_000), "1970-01-01 01:01:01 UTC");
    assert_eq!(short_date(1_709_164_800_000), "Feb 29");
    assert_eq!(day_name(1_709_164_800_000), "Thu, Feb 29");
    assert_eq!(day_name(0), "Thu, Jan 1");
}
#[test]
fn axis_ticks_are_round_and_values_readable() {
    assert_eq!(scale(0), (1, 0), "no data, no invented gridlines");
    assert_eq!(scale(1), (1, 1));
    assert_eq!(scale(7), (2, 4));
    assert_eq!(scale(100), (25, 4));
    assert_eq!(scale(40_123_456), (20_000_000, 3));
    assert_eq!(scale(SAFE), (2_500_000_000_000_000, 4));
    for (n, s) in [
        (0, "0"),
        (950, "950"),
        (1_500, "1.5K"),
        (25_000_000, "25M"),
        (2_500_000_000, "2.5B"),
    ] {
        assert_eq!(compact(n), s);
    }
    for (n, s) in [
        (0, "0"),
        (999, "999"),
        (1_000, "1,000"),
        (111_086_038, "111,086,038"),
    ] {
        assert_eq!(grouped(n), s);
    }
    let mut m: Metric = serde_json::from_value(f::metric(Some(111_086_038))).unwrap();
    assert_eq!(m.label(false), "111,086,038");
    m.value = Some(1_353_198_350);
    assert_eq!(m.label(true), "≈ $1,353.1984");
}
#[test]
fn unknown_zero_partial_overflow_and_cache_are_not_conflated() {
    let mut m: Metric = serde_json::from_value(f::metric(None)).unwrap();
    assert_eq!(m.label(false), "Unknown");
    m = serde_json::from_value(f::metric(Some(0))).unwrap();
    assert_eq!(m.label(false), "0");
    m.unknown = 1;
    assert_eq!(m.label(true), "≈ $0.0000 · partial");
    m.value = Some(1);
    assert_eq!(m.label(true), "≈ $0.000001 · partial");
    m.overflow = true;
    m.value = None;
    assert_eq!(m.label(false), "Overflow");
    let a: Aggregate = serde_json::from_value(f::aggregate()).unwrap();
    assert_eq!(
        a.tokens(),
        Some((144000, [1, 0])),
        "known subtotal survives missing metrics; cache never counted as input+output"
    );
    let mut a = a;
    a.metrics.insert(
        "output".into(),
        serde_json::from_value(f::metric(None)).unwrap(),
    );
    assert_eq!(
        a.tokens(),
        Some((120000, [1, 1])),
        "input alone is still known"
    );
    a.metrics.insert(
        "input".into(),
        serde_json::from_value(f::metric(None)).unwrap(),
    );
    assert_eq!(a.tokens(), None, "no known count is unknown, not zero");
}
#[test]
fn partial_daily_subtotals_stay_visible_and_missing_days_are_not_zero() {
    let r = range();
    let report = Report::parse(f::report(r, true), r, true).unwrap();
    let days: Vec<Day> = report.days(r).into_iter().map(|(_, d)| d).collect();
    assert_eq!(days.len(), 7);
    assert_eq!(days[0], Day::Outside, "before collection began");
    assert_eq!(
        days[1],
        Day::Known {
            tokens: 48000,
            records: 1,
            uncounted: [0, 0]
        }
    );
    assert!(days[1].complete());
    // Regression: one record without metrics used to drop the whole day's known subtotal.
    assert_eq!(
        days[2],
        Day::Known {
            tokens: 60000,
            records: 2,
            uncounted: [1, 1]
        }
    );
    assert!(!days[2].complete());
    assert!(
        days[2]
            .describe()
            .starts_with("At least 60,000 input + output tokens")
    );
    assert_eq!(days[3], Day::Empty, "no bucket is not zero");
    assert_eq!(days[4].tokens(), Some(0));
    assert!(days[4].complete(), "true zero is a complete observation");
    assert_eq!(days[5], Day::Unknown { records: 2 });
    assert_eq!(days[6], Day::Empty);
    // Known daily subtotals reconcile with a summary built from the same records.
    let known: u64 = days.iter().filter_map(|d| d.tokens()).sum();
    assert_eq!(known, 48000 + 60000);
}
#[test]
fn response_bounds_versions_truncation_duplicates_and_generation_are_explicit() {
    let r = range();
    let mut valid = f::report(r, true);
    valid["next"] = json!(null);
    assert!(Report::parse(valid.clone(), r, true).is_ok());
    for (pointer, value) in [
        ("/version", json!(2)),
        ("/truncated", json!(true)),
        ("/next", json!("cursor")),
        ("/status/coverage", json!("complete")),
        ("/total/records", json!(50001)),
        ("/total/metrics/input/value", json!(SAFE + 1)),
        ("/groups/0/key", json!(r.to.to_string())),
    ] {
        let mut v = valid.clone();
        *v.pointer_mut(pointer)
            .unwrap_or_else(|| panic!("{pointer}")) = value;
        assert!(Report::parse(v, r, true).is_err(), "{pointer}");
    }
    let mut v = valid.clone();
    v["groups"] = json!([valid["groups"][0].clone(), valid["groups"][0].clone()]);
    assert!(Report::parse(v, r, true).is_err());
    assert!(Report::parse(valid, r, false).is_err());
}
#[test]
fn project_breakdowns_cannot_be_used_as_daily_or_summary_evidence() {
    let r = range();
    // The daemon's project breakdown uses JSON scalar keys, including null for
    // unattributed records. Neither is a UTC bucket or an unfiltered summary.
    for key in [
        json!("550e8400-e29b-41d4-a716-446655440000").to_string(),
        json!(null).to_string(),
    ] {
        let mut report = f::report(r, false);
        report["groups"] = json!([{"key": key, "aggregate": f::aggregate()}]);
        assert!(Report::parse(report.clone(), r, true).is_err());
        assert!(Report::parse(report, r, false).is_err());
    }
}

#[test]
fn daily_groups_do_not_partition_the_authoritative_summary_by_project() {
    let r = range();
    let mut wire = f::report(r, true);
    // No attribution is present in either total or daily aggregates. A day's
    // known subtotal cannot identify a project or an unattributed subtotal.
    wire["total"]["records"] = json!(9);
    wire["total"]["metrics"]["input"]["value"] = json!(900_000);
    let report = Report::parse(wire, r, true).unwrap();
    assert_eq!(report.total.records, 9);
    assert_eq!(report.total.metric("input").unwrap().value, Some(900_000));
    let daily: u64 = report.days(r).iter().filter_map(|(_, d)| d.tokens()).sum();
    assert_eq!(daily, 108_000);
    assert_eq!(report.coverage, "partial");
    assert_eq!(report.queried_at, r.to);
}

#[test]
fn stale_range_serials_are_fenced_and_failed_refresh_retains_dated_snapshot() {
    let r = range();
    let snapshot = Snapshot {
        range: r,
        summary: Report::parse(f::report(r, false), r, false).unwrap(),
        trend: Err("not available"),
    };
    let mut s = State::default();
    let a = s.begin(r);
    let b = s.begin(r);
    assert!(!s.accept(a, r, Ok(snapshot.clone())));
    assert!(s.accept(b, r, Ok(snapshot)));
    let newer = Range {
        to: r.to + 1000,
        ..r
    };
    let c = s.begin(newer);
    assert!(s.snapshot.is_some());
    assert!(s.accept(c, newer, Err("offline")));
    assert_eq!(s.snapshot.as_ref().unwrap().range, r);
    s.begin(Range::preset(30, r.to).unwrap());
    assert!(s.snapshot.is_none());
    assert!(!s.accept(c, newer, Err("late")));
}
