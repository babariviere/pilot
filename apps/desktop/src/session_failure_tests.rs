use super::*;
use serde_json::json;

#[test]
fn public_projection_uses_failure_evidence_and_truthful_precedence() {
    let completion = json!({"id":"a", "state":"parked", "outcome":"failed", "outcomeAt":42,
        "outcomeReason":"Tool build: primary cause\nCaused by: réseau 日本語 👩🏽‍💻\nSecond cause",
        "error":"different input error", "attentionReason":{"kind":"mcp","detail":"not a run failure"},
        "privateWorker":{"exception":"never read"}});
    let f = crate::local_model::chat(&completion)
        .unwrap()
        .failure
        .unwrap();
    assert_eq!(f.reason, completion["outcomeReason"]);
    assert_eq!(f.source, "Completion reason");
    assert_eq!(f.at, Some(42));
    assert!(!f.historical);
    assert!(!format!("{f:?}").contains("never read"));
    let mut startup = completion.clone();
    startup["canRetryStartup"] = json!(true);
    assert_eq!(read(&startup).unwrap().reason, "different input error");
    for state in ["idle", "parked", "failed"] {
        assert!(read(&json!({"state":state,"outcome":"failed"})).is_some());
    }
    for v in [
        json!({"error":"load failed"}),
        json!({"outcome":"done","outcomeReason":"not failure"}),
        json!({"attentionReason":{"kind":"mcp","detail":"server failed"}}),
    ] {
        assert!(read(&v).is_none());
    }
    assert_eq!(
        read(&json!({"attentionReason":{"kind":"failed","detail":"full\nattention"}}))
            .unwrap()
            .reason,
        "full\nattention"
    );
}

#[test]
fn missing_unicode_multiline_and_long_reports_are_bounded_not_first_line_labels() {
    for reason in [
        json!(null),
        json!(" \n\t\u{feff}"),
        json!("\u{0000}\u{0007}"),
        json!(55),
        json!({"message":"do not serialize"}),
    ] {
        assert_eq!(
            read(&json!({"outcome":"failed","outcomeReason":reason}))
                .unwrap()
                .reason,
            MISSING
        );
    }
    let f = read(&json!({"outcome":"failed","outcomeReason":"日本語👩🏽‍💻\n".repeat(4000)})).unwrap();
    assert!(f.truncated && f.reason.len() <= DETAIL_CAP);
    assert!(f.reason.contains('\n'));
    assert!(f.reason.len() > 200);
    assert!(
        read(&json!({"state":"failed","outcomeAt":-1}))
            .unwrap()
            .at
            .is_none()
    );
    assert!(
        read(&json!({"state":"failed","outcomeAt":"today"}))
            .unwrap()
            .at
            .is_none()
    );
}

#[test]
fn run_start_summary_updates_reopen_and_attempts_do_not_relabel_old_failure_as_current() {
    let f = read(&json!({"outcome":"failed","outcomeAt":10,"outcomeReason":"old"})).unwrap();
    let mut fence = Fence::default();
    fence.observe("A", 1, 0, false, Some(&f));
    assert!(!fence.historical(&f));
    fence.observe("A", 1, 1, false, Some(&f)); // stream run_start beats summary update
    assert!(fence.historical(&f));
    fence.observe("A", 1, 1, true, None);
    fence.observe("A", 1, 1, false, Some(&f)); // late old summary after run_end
    assert!(fence.historical(&f));
    let new = read(&json!({"outcome":"failed","outcomeAt":11,"outcomeReason":"new"})).unwrap();
    fence.observe("A", 1, 1, false, Some(&new));
    assert!(!fence.historical(&new));
    fence.observe("B", 2, 0, false, Some(&f));
    assert!(!fence.historical(&f));
    fence.observe("A", 3, 0, false, Some(&f)); // reopen doesn't fabricate a new version
    assert_eq!(f.at, Some(10));
    assert!(!fence.historical(&f));
    for v in [
        json!({"archivedAt":99}),
        json!({"working":true}),
        json!({"state":"starting"}),
        json!({"attempts":[{"id":"next-attempt","active":true,"createdAt":20}]}),
    ] {
        let mut value = json!({"outcome":"failed","outcomeAt":10});
        value
            .as_object_mut()
            .unwrap()
            .extend(v.as_object().unwrap().clone());
        assert!(read(&value).unwrap().historical);
    }
}

#[test]
fn durable_reader_errors_are_not_promoted_to_session_failure_diagnostics() {
    let mut t = crate::local_model::LiveTranscript::default();
    t.apply(&json!({"type":"snapshot","entries":[{"id":1,"head":1,"kind":"pilot.error","data":{"message":"private data is not a summary reason"}}]}));
    t.apply(&json!({"type":"error","message":"private wire error"}));
    assert_eq!(t.failure_run_serial, 0);
    t.apply(&json!({"type":"run_start"}));
    t.apply(&json!({"type":"run_end"}));
    assert_eq!(t.failure_run_serial, 1);
    assert!(!t.rows().iter().any(|r| r.source().contains("private")));
}

fn failed_assistant(id: u64) -> serde_json::Value {
    json!({"id":id,"kind":"pi.assistant","model":[{"role":"assistant","stopReason":"error","errorMessage":"Synthetic provider error","content":[]}]})
}
#[test]
fn only_the_newest_settled_failed_assistant_turn_is_retryable() {
    use crate::local_model::LiveTranscript;
    let user =
        json!({"id":1,"kind":"pi.user","model":[{"role":"user","content":"Plan 日本語 👩🏽‍💻"}]});
    let mut t = LiveTranscript::default();
    assert_eq!(t.retry_entry(), None, "nothing loaded");
    t.apply(&json!({"type":"snapshot","entries":[user.clone(), failed_assistant(2)]}));
    assert_eq!(t.retry_entry(), Some(2));
    // A run, stream, queued input or newer entry ends the offer.
    t.apply(&json!({"type":"run_start"}));
    assert_eq!(t.retry_entry(), None);
    t.apply(&json!({"type":"run_error"}));
    assert_eq!(t.retry_entry(), Some(2));
    t.apply(
        &json!({"type":"message_start","message":{"role":"assistant","timestamp":5,"content":[]}}),
    );
    assert_eq!(t.retry_entry(), None);
    t.apply(&json!({"type":"message_end","entry":failed_assistant(3)}));
    assert_eq!(
        t.retry_entry(),
        Some(3),
        "Swift: the last row's committed error"
    );
    t.apply(
        &json!({"type":"queue_update","items":[{"id":1,"content":"queued","mode":"followUp"}]}),
    );
    assert_eq!(t.retry_entry(), None);
    t.apply(&json!({"type":"queue_update","items":[]}));
    t.settle_departed();
    assert_eq!(t.retry_entry(), Some(3));
    t.apply(&json!({"type":"entry_appended","entry":{"id":4,"kind":"pilot.activity","model":[],"data":{"text":"Later activity"}}}));
    assert_eq!(t.retry_entry(), None, "no longer the last row");
    // Older history arriving never re-targets the newest entry.
    let mut t = LiveTranscript::default();
    t.apply(&json!({"type":"snapshot","entries":[failed_assistant(2), {"id":3,"kind":"pi.assistant","model":[{"role":"assistant","stopReason":"stop","content":[{"type":"text","text":"Recovered"}]}]}]}));
    assert_eq!(t.retry_entry(), None, "a successful reply is not retried");
    // A new snapshot (another attempt) replaces the target.
    t.apply(&json!({"type":"snapshot","entries":[user.clone(), failed_assistant(9)]}));
    assert_eq!(t.retry_entry(), Some(9));
    t.apply(&json!({"type":"snapshot","entries":[user]}));
    assert_eq!(t.retry_entry(), None);
}
