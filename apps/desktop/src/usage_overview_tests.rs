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
    assert_eq!(a.tokens(), None);
    let mut a = a;
    a.metrics.insert(
        "input".into(),
        serde_json::from_value(f::metric(Some(120000))).unwrap(),
    );
    assert_eq!(
        a.tokens(),
        Some(144000),
        "cache read/write never counted as input+output"
    );
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
