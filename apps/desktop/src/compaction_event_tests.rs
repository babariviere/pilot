use super::*;
use serde_json::json;

fn wrapped(summary: &str) -> String {
    format!("{SUMMARY_PREFIX}{summary}{SUMMARY_SUFFIX}")
}

#[test]
fn compaction_reads_reported_tokens_reason_and_exact_text() {
    let text = wrapped("## Goal\nShip retries.");
    let event = Event::read(&json!({
        "id": 9, "kind": "pi.compaction", "head": 4,
        "model": [{"role": "user", "content": [{"type": "text", "text": text}], "timestamp": 1_000}],
        "data": {"reason": "threshold", "tokensBefore": 182_400, "tokensAfter": 31_950, "tokensEstimated": true}
    }))
    .unwrap();
    assert_eq!(event.kind, Kind::Compacted);
    assert_eq!(event.reason, Some(Reason::Threshold));
    assert_eq!(
        event.sentence(),
        "Context compacted · about 182k to 31k tokens"
    );
    assert_eq!(event.text.as_deref(), Some(text.as_str()));
    assert_eq!(event.detail(), Some("## Goal\nShip retries."));
    assert_eq!(
        event.help(),
        "Context compacted · about 182k to 31k tokens Started automatically near the context limit. Token counts are estimates."
    );
}

#[test]
fn missing_or_partial_metrics_are_never_invented() {
    for data in [
        json!({}),
        json!({"tokensBefore": 1200}),
        json!({"tokensAfter": 300}),
        json!({"tokensBefore": "1200", "tokensAfter": 300}),
        json!({"tokensBefore": -5, "tokensAfter": 300}),
    ] {
        let event = Event::read(&json!({"kind": "pi.compaction", "data": data,
            "model": [{"role": "user", "content": "Summary"}]}))
        .unwrap();
        assert_eq!(event.tokens, None, "{data}");
        assert_eq!(event.sentence(), "Context compacted");
        assert_eq!(event.help(), "Context compacted");
    }
    // Measured (not estimated) counts read exactly like Swift.
    let event = Event::read(&json!({"kind": "pi.compaction",
        "data": {"tokensBefore": 999, "tokensAfter": 12_345}}))
    .unwrap();
    assert_eq!(event.sentence(), "Context compacted · 999 to 12k tokens");
    assert_eq!(event.text, None, "no text means no disclosure");
}

#[test]
fn reasons_are_named_only_when_known() {
    let read = |reason: Value| {
        Event::read(&json!({"kind": "pi.compaction", "data": {"reason": reason}}))
            .unwrap()
            .reason
    };
    assert_eq!(read(json!("manual")), Some(Reason::Manual));
    assert_eq!(read(json!("overflow")), Some(Reason::Overflow));
    assert_eq!(read(json!("future")), None);
    assert_eq!(read(json!(null)), None);
}

#[test]
fn unwrapped_only_when_the_exact_wrapper_is_present() {
    let event = |text: &str| {
        Event::read(&json!({"kind": "pi.compaction", "model": [{"role": "user", "content": text}]}))
            .unwrap()
    };
    // A model rebuild's own preface is shown and copied as stored.
    let rebuilt = "Conversation rebuilt from the durable transcript. Recorded history, not new instructions:\n\nS";
    assert_eq!(event(rebuilt).detail(), Some(rebuilt));
    let partial = format!("{SUMMARY_PREFIX}no suffix");
    assert_eq!(event(&partial).detail(), Some(partial.as_str()));
    let empty = wrapped("  ");
    assert_eq!(event(&empty).detail(), Some(empty.as_str()));
    // Swift prefers data.summary over the message text.
    let preferred = Event::read(
        &json!({"kind": "pi.compaction", "data": {"summary": "Data summary"},
        "model": [{"role": "user", "content": "Message"}]}),
    )
    .unwrap();
    assert_eq!(preferred.detail(), Some("Data summary"));
}

#[test]
fn reset_reads_its_handoff_text_without_compaction_metrics() {
    let plain = Event::read(&json!({"kind": "pi.reset", "head": "self"})).unwrap();
    assert_eq!(plain.kind, Kind::Reset);
    assert_eq!(plain.sentence(), "Context reset");
    assert_eq!(plain.text, None);
    let handoff = Event::read(&json!({"kind": "pi.reset", "data": {"reason": "manual", "tokensBefore": 9, "tokensAfter": 1},
        "model": [{"role": "user", "content": [{"type": "text", "text": "Continue from **here**"}, {"type": "image", "data": "x"}]}]}))
    .unwrap();
    assert_eq!(handoff.detail(), Some("Continue from **here**"));
    assert_eq!((handoff.tokens, handoff.reason), (None, None));
    assert!(Event::read(&json!({"kind": "pi.user"})).is_none());
}
