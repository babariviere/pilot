use super::*;
use serde_json::json;

fn usage(value: Value) -> Usage {
    Usage::read(&value)
}

#[test]
fn unknown_is_not_zero_and_wire_percent_is_not_authority() {
    let unknown = Usage::default();
    assert_eq!(unknown.percent(), None);
    assert_eq!(unknown.amount(), "Not reported");
    assert_eq!(unknown.exact(), "Unknown / Unknown");
    assert_eq!(unknown.accounting(), None);
    let value = usage(json!({"context":{"tokens":42600,"contextWindow":200000,"percent":99}}));
    assert_eq!(value.percent().as_deref(), Some("21%"));
    assert_eq!(value.amount(), "42.6K / 200K tokens");
    assert_eq!(value.exact(), "42,600 / 200,000");
    let zero = usage(json!({"context":{"tokens":0,"contextWindow":100}}));
    assert_eq!(zero.percent().as_deref(), Some("0%"));
    assert_eq!(zero.amount(), "0 / 100 tokens");
    // A zero window is not a limit; the used side stays visible, the share unknown.
    let no_window = usage(json!({"context":{"tokens":1,"contextWindow":0}}));
    assert_eq!(no_window.percent(), None);
    assert_eq!(no_window.amount(), "1 / Unknown tokens");
}
#[test]
fn percent_floors_and_never_hides_small_or_over_limit_reports() {
    for (used, window, expected) in [
        (1, 1_000_000, "<1%"),
        (240_282, 500_000, "48%"),
        (199_999, 200_000, "99%"),
        (200_000, 200_000, "100%"),
        (150, 100, "150%"),
    ] {
        let value = usage(json!({"context":{"tokens":used,"contextWindow":window}}));
        assert_eq!(
            value.percent().as_deref(),
            Some(expected),
            "{used}/{window}"
        );
    }
}
#[test]
fn compact_counts_stay_short_and_round_into_the_next_unit() {
    for (value, expected) in [
        (0, "0"),
        (999, "999"),
        (1_000, "1K"),
        (4_260, "4.3K"),
        (42_600, "42.6K"),
        (99_960, "100K"),
        (240_282, "240K"),
        (999_999, "1M"),
        (1_234_567, "1.2M"),
        (9_733_376, "9.7M"),
        (9_007_199_254_740_991, "9007T"),
    ] {
        assert_eq!(compact(Some(value)), expected, "{value}");
    }
    assert_eq!(compact(None), "Unknown");
    assert_eq!(number(Some(9_733_376)), "9,733,376");
}
#[test]
fn malformed_and_large_values_stay_unknown() {
    for bad in [
        json!(-1),
        json!(1.5),
        json!("100"),
        json!(u64::MAX),
        Value::Null,
    ] {
        let value = usage(json!({"context":{"tokens":bad,"contextWindow":bad}}));
        assert_eq!(value.percent(), None);
        assert_eq!(value.amount(), "Not reported");
        assert_eq!(value.exact(), "Unknown / Unknown");
    }
}
#[test]
fn accounting_separates_children_hides_all_zero_and_never_invents_billing() {
    let raw = json!({"context":{"tokens":10,"contextWindow":100},"ai":{
        "direct":{"tokens":{"input":12,"output":20,"reasoning":9,"cacheRead":0,"cacheWrite":4},"cost":{"estimatedUsdMicros":9999}},
        "child":{"tokens":{"input":77}}},"subscription":{"error":"private-error"},"private":"secret"});
    let value = usage(raw);
    let (rows, child) = value.accounting().unwrap();
    assert!(child, "partial child report stays visible");
    assert_eq!(
        rows,
        [
            ("Input", "12", "77"),
            ("Output", "20", "Unknown"),
            ("Cache read", "0", "Unknown"),
            ("Cache write", "4", "Unknown"),
        ]
        .map(|(label, direct, child)| Row {
            label,
            direct: direct.into(),
            child: child.into()
        })
    );
    let text = format!("{value:?} {rows:?}");
    assert!(!text.contains("secret") && !text.contains("9999") && !text.contains("private"));
    assert_eq!(std::mem::size_of::<Usage>(), 160);
    // All-zero children are hidden; a direct-only partial report keeps unknown cells.
    let zero = usage(json!({"ai":{
        "direct":{"tokens":{"input":288846,"output":25762,"cacheRead":9733376,"cacheWrite":0}},
        "child":{"tokens":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0}}}}));
    let (rows, child) = zero.accounting().unwrap();
    assert!(!child);
    assert_eq!(rows[2].direct, "9,733,376");
    assert_eq!(rows[3].direct, "0");
    let direct_only = usage(json!({"ai":{"direct":{"tokens":{"input":5}}}}));
    let (rows, child) = direct_only.accounting().unwrap();
    assert!(child, "missing children are unknown, not zero");
    assert_eq!(
        (rows[0].child.as_str(), rows[1].direct.as_str()),
        ("Unknown", "Unknown")
    );
}
#[test]
fn session_projection_replaces_usage_instead_of_retaining_an_old_worker() {
    let first = crate::local_model::chat(
        &json!({"id":"ExactID","usage":{"context":{"tokens":10,"contextWindow":100}}}),
    )
    .unwrap();
    let next = crate::local_model::chat(&json!({"id":"ExactID","usage":{}})).unwrap();
    assert_eq!(first.context_usage.exact(), "10 / 100");
    assert_eq!(next.context_usage.exact(), "Unknown / Unknown");
    assert_eq!(next.id, "ExactID");
}
