use super::*;
use serde_json::json;
fn row(id: &str, status: &str, assigned: Option<&str>) -> Value {
    let mut value =
        json!({"id":id,"title":format!("Task {id}"),"status":status,"createdAt":"2026-10-26"});
    if let Some(assigned) = assigned {
        value["assignedToSession"] = json!(assigned);
    }
    value
}
fn feed() -> Feed {
    Feed::new(Source::new(LocalOptions::synthetic(123), "a".into(), 7))
}
#[test]
fn public_statuses_not_monocode_aliases() {
    let snapshot = Snapshot::read(
        &json!([
            row("a", "closed", None),
            row("b", "DONE", Some("a")),
            row("c", "completed", None),
            row("d", "cancelled", None),
            row("e", "in_progress", None),
            row("f", "unknown", None),
            row("g", "open", Some("a")),
            row("h", "open", Some("elsewhere")),
        ]),
        "a",
    )
    .unwrap();
    assert_eq!((snapshot.count, snapshot.done), (8, 2));
    assert_eq!(snapshot.rows[0].id, "g");
    assert!(snapshot.rows[0].working);
    assert!(!snapshot.rows.iter().find(|r| r.id == "e").unwrap().working);
    assert_eq!(
        snapshot.rows.iter().find(|r| r.id == "h").unwrap().label(),
        "Assigned elsewhere"
    );
    for id in ["c", "d", "e", "f"] {
        assert!(!snapshot.rows.iter().find(|r| r.id == id).unwrap().closed);
    }
}
#[test]
fn absent_loading_empty_unavailable_and_retained_are_distinct() {
    let mut f = feed();
    assert_eq!(f.phase, Phase::Loading);
    assert!(!f.visible(Some(&LocalOptions::synthetic(123)), Some("a"), 7));
    f.apply(&json!({"type":"snapshot","entries":[]}));
    assert_eq!(f.phase, Phase::Absent);
    f.stale();
    assert_eq!(f.phase, Phase::Unavailable);
    assert!(f.snapshot.is_none());
    assert!(!f.visible(Some(&LocalOptions::synthetic(123)), Some("a"), 7));
    f.apply(&json!({"type":"todos_update","items":[]}));
    assert_eq!(f.phase, Phase::Ready);
    assert_eq!(f.snapshot.as_ref().unwrap().summary(), "No tasks reported");
    assert!(!f.visible(Some(&LocalOptions::synthetic(123)), Some("a"), 7));
    f.stream();
    assert_eq!(f.phase, Phase::Retained);
    assert!(!f.visible(Some(&LocalOptions::synthetic(123)), Some("a"), 7));
    f.apply(&json!({"type":"snapshot","entries":[]}));
    assert_eq!(f.phase, Phase::Retained);
    f.apply(&json!({"type":"todos_update","items":[]}));
    assert_eq!(f.phase, Phase::Ready);
}
#[test]
fn bad_replacement_retains_exact_previous_snapshot_not_empty() {
    let mut f = feed();
    f.apply(&json!({"type":"todos_update","items":[row("a","open",None)]}));
    let before = f.snapshot.clone().unwrap();
    for items in [
        json!(null),
        json!({}),
        json!([{}]),
        json!([row("a", "open", None), row("a", "open", None)]),
        json!([{"id":"x","title":"x","status":6}]),
    ] {
        f.apply(&json!({"type":"todos_update","items":items}));
        assert!(Arc::ptr_eq(&before, f.snapshot.as_ref().unwrap()));
        assert_eq!(f.phase, Phase::Retained);
    }
}
#[test]
fn counts_rows_titles_are_bounded_and_partial_never_all_done() {
    let mut rows: Vec<_> = (0..COUNT_CAP + 10)
        .map(|i| row(&i.to_string(), "done", None))
        .collect();
    rows[250] = row("active", "open", Some("a"));
    rows[250]["title"] = json!("界".repeat(300));
    let s = Snapshot::read(&json!(rows), "a").unwrap();
    assert_eq!((s.count, s.done, s.rows.len()), (256, 255, ROW_CAP));
    assert_eq!(s.rows[0].id, "active");
    assert_eq!(s.rows[0].title.chars().count(), TITLE_CAP + 1);
    assert!(s.partial && s.clipped);
    assert!(s.summary().contains("256+"));
    assert!(s.coverage().unwrap().contains("partial count"));
}
#[test]
fn source_fences_chat_generation_port_home_and_reconnect() {
    let mut f = feed();
    f.apply(&json!({"type":"todos_update","items":[row("a","done",None)]}));
    let options = LocalOptions::synthetic(123);
    assert!(f.visible(Some(&options), Some("a"), 7));
    assert!(!f.visible(Some(&options), Some("a"), 8));
    assert!(!f.visible(Some(&options), Some("b"), 7));
    assert!(!f.visible(Some(&LocalOptions::synthetic(124)), Some("a"), 7));
    assert!(!f.visible(None, Some("a"), 7));
    let other = crate::local_client::LocalOptions::synthetic(125);
    assert!(!f.visible(Some(&other), Some("a"), 7));
    let replacement = Feed::new(Source::new(options, "b".into(), 8));
    assert!(replacement.snapshot.is_none());
}
#[test]
fn private_tools_and_mission_tasks_never_make_a_snapshot() {
    let mut f = feed();
    for event in [
        json!({"type":"tool_execution_end","toolName":"TodoWrite","input":{"todos":[{"content":"secret"}]}}),
        json!({"type":"mission","tasks":[row("a","done",None)]}),
    ] {
        f.apply(&event);
    }
    assert!(f.snapshot.is_none());
}

#[test]
fn visibility_follows_known_total_not_rows_completion_or_connection() {
    let mut f = feed();
    let visible = |f: &Feed| f.visible(Some(&LocalOptions::synthetic(123)), Some("a"), 7);
    f.apply(&json!({"type":"todos_update","items":null}));
    assert!(!visible(&f), "initial errors have no task evidence");
    f.apply(&json!({"type":"todos_update","items":[row("a","done",None)]}));
    assert!(visible(&f), "all completed is not zero tasks");
    f.stream();
    assert!(visible(&f), "reconnect retains known tasks");
    f.apply(&json!({"type":"todos_update","items":[{}]}));
    assert!(visible(&f), "malformed replacement cannot erase tasks");
    // Visibility uses the inspected total, independently of row capping.
    Arc::make_mut(f.snapshot.as_mut().unwrap()).rows.clear();
    assert!(visible(&f));
    f.apply(&json!({"type":"todos_update","items":[]}));
    assert!(
        !visible(&f),
        "authoritative zero retires the entire surface"
    );
    f.stream();
    f.stale();
    assert!(
        !visible(&f),
        "retained zero does not create error-only chrome"
    );
    f.apply(&json!({"type":"todos_update","items":[row("b","open",None)]}));
    assert!(visible(&f));
}
