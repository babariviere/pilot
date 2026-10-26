use super::*;
use serde_json::json;

#[test]
fn unknown_is_not_zero_and_wire_percent_is_not_authority() {
    let unknown = Usage::default().lines().join("\n");
    assert!(unknown.contains("Unknown / Unknown"));
    assert!(!unknown.contains("0%"));
    let value =
        Usage::read(&json!({"context":{"tokens":42600,"contextWindow":200000,"percent":99}}));
    assert!(value.lines()[0].contains("42,600 / 200,000 tokens (21.3%)"));
    assert!(value.lines()[1].contains("Freshness unknown"));
    assert!(
        Usage::read(&json!({"context":{"tokens":0,"contextWindow":100}})).lines()[0]
            .contains("(0.0%)")
    );
    assert!(
        !Usage::read(&json!({"context":{"tokens":1,"contextWindow":0}})).lines()[0].contains('%')
    );
}
#[test]
fn malformed_and_large_values_stay_unknown_and_overage_is_not_clamped() {
    for bad in [
        json!(-1),
        json!(1.5),
        json!("100"),
        json!(u64::MAX),
        Value::Null,
    ] {
        let usage = Usage::read(&json!({"context":{"tokens":bad,"contextWindow":bad}}));
        assert!(usage.lines()[0].contains("Unknown / Unknown"));
    }
    assert!(
        Usage::read(&json!({"context":{"tokens":150,"contextWindow":100}})).lines()[0]
            .contains("150.0%")
    );
}
#[test]
fn content_free_fixed_projection_separates_children_and_never_invents_billing() {
    let raw = json!({"context":{"tokens":10,"contextWindow":100},"ai":{
        "direct":{"tokens":{"input":12,"output":20,"reasoning":9,"cacheRead":0,"cacheWrite":4},"cost":{"estimatedUsdMicros":9999}},
        "child":{"tokens":{"input":77}}},"subscription":{"error":"private-error"},"private":"secret"});
    let usage = Usage::read(&raw);
    let lines = usage.lines();
    assert!(lines[2].contains("input 12 · output 20 · cache read 0 · cache write 4"));
    assert!(lines[3].contains("input 77 · output Unknown"));
    assert!(!format!("{usage:?}").contains("secret"));
    assert!(!lines.join("\n").contains("9999"));
    assert_eq!(std::mem::size_of::<Usage>(), 160);
}
#[test]
fn session_projection_replaces_usage_instead_of_retaining_an_old_worker() {
    let first = crate::local_model::chat(
        &json!({"id":"ExactID","usage":{"context":{"tokens":10,"contextWindow":100}}}),
    )
    .unwrap();
    let next = crate::local_model::chat(&json!({"id":"ExactID","usage":{}})).unwrap();
    assert!(first.context_usage.lines()[0].contains("10 / 100"));
    assert!(next.context_usage.lines()[0].contains("Unknown / Unknown"));
    assert_eq!(next.id, "ExactID");
}
