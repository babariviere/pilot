use super::*;
use serde_json::json;

#[test]
fn comparable_report_only_never_history_efficiency_or_wire_percent() {
    for value in [
        json!({}),
        json!({"context":{"tokens":1}}),
        json!({"context":{"contextWindow":100}}),
        json!({"context":{"tokens":1,"contextWindow":0}}),
        json!({"context":{"tokens":-1,"contextWindow":100}}),
        json!({"context":{"tokens":1.5,"contextWindow":100}}),
        json!({"context":{"tokens":"1","contextWindow":100}}),
        json!({"context":{"tokens":1,"contextWindow":u64::MAX}}),
        json!({"ai":{"efficiency":{"context":{"tokens":1,"contextWindow":100}}}}),
    ] {
        assert!(Meter::reported(&Usage::read(&value)).is_none(), "{value}");
    }
    let m = Meter::reported(&Usage::read(
        &json!({"context":{"tokens":42,"contextWindow":100,"percent":99}}),
    ))
    .unwrap();
    assert_eq!(m.ratio, 0.42);
    assert!(m.description.contains("42 / 100 tokens (42.0%)"));
    assert!(m.description.contains("Freshness unknown"));
}

#[test]
fn zero_is_reported_and_overage_keeps_raw_counts_and_percent() {
    for (used, ratio, percent) in [(0, 0., "0.0%"), (150, 1., "150.0%")] {
        let m = Meter::reported(&Usage::read(
            &json!({"context":{"tokens":used,"contextWindow":100}}),
        ))
        .unwrap();
        assert_eq!(m.ratio, ratio);
        assert!(m.description.contains(percent));
        assert_eq!(m.description.contains("gauge capped"), used > 100);
    }
    // No merge of one report's used value with another report's window.
    assert!(Meter::reported(&Usage::read(&json!({"context":{"tokens":10}}))).is_none());
    assert!(Meter::reported(&Usage::read(&json!({"context":{"contextWindow":100}}))).is_none());
}
