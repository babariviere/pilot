use super::*;
use crate::mission_browser_fixture as f;
use serde_json::json;
fn value() -> Value {
    let mut v = f::detail("mission-A");
    for (ix, t) in v["tasks"].as_array_mut().unwrap().iter_mut().enumerate() {
        t["title"] = json!("Same title 日本語");
        t["body"] = json!(format!("Exact body {ix} 👩‍💻 é\n\n# Markdown stays literal"));
    }
    v
}
#[test]
fn same_title_tasks_keep_exact_identity_body_order_and_unicode() {
    let s = parse(&f::key("mission-A"), &value()).unwrap();
    assert_eq!(s.tasks.len(), 2);
    assert_eq!(s.tasks[0].id, "task-A");
    assert_eq!(s.tasks[0].title, s.tasks[1].title);
    assert_ne!(
        s.task("task-A").unwrap().body,
        s.task("task-B").unwrap().body
    );
    assert!(s.task("task-B").unwrap().body.contains("👩‍💻 é"));
    assert!(s.task("1").is_none());
}
#[test]
fn invalid_duplicate_foreign_overlimit_never_admit_partial_rows_or_bodies() {
    let key = f::key("mission-A");
    let mut v = value();
    v["mission"]["id"] = json!("mission-B");
    assert!(parse(&key, &v).is_err());
    let mut v = value();
    v["tasks"][1]["id"] = v["tasks"][0]["id"].clone();
    assert!(parse(&key, &v).is_err());
    let mut v = value();
    v["tasks"][1]["number"] = v["tasks"][0]["number"].clone();
    assert!(parse(&key, &v).is_err());
    let mut v = value();
    v["tasks"][0]["body"] = json!("語".repeat(BODY_BYTES / 3 + 1));
    assert!(parse(&key, &v).unwrap_err().contains("No partial"));
    let mut v = value();
    v["tasks"] = json!(vec![v["tasks"][0].clone(); ROW_LIMIT + 1]);
    assert!(parse(&key, &v).unwrap_err().contains("256"));
    let mut v = value();
    v["tasks"][0]["id"] = json!("bad/id");
    assert!(parse(&key, &v).is_err());
    let mut v = value();
    v["tasks"] = json!([]);
    assert!(parse(&key, &v).unwrap().tasks.is_empty());
}
#[test]
fn stale_generation_mission_switch_errors_and_removed_selection_are_fenced() {
    let a = f::key("mission-A");
    let b = f::key("mission-B");
    let s = Arc::new(parse(&a, &value()).unwrap());
    let mut state = State::default();
    assert!(state.target(Some(a.clone())));
    let g = state.begin();
    assert!(!state.accept(g - 1, &a, Ok(s.clone())));
    assert!(!state.accept(g, &b, Err("foreign")));
    assert!(state.busy);
    assert!(state.accept(g, &a, Ok(s.clone())));
    state.selected = Some("task-B".into());
    let g2 = state.begin();
    assert!(state.accept(g2, &a, Err("oversize")));
    assert!(Arc::ptr_eq(state.snapshot.as_ref().unwrap(), &s));
    assert_eq!(state.selected.as_deref(), Some("task-B"));
    assert_eq!(state.error, Some("oversize"));
    assert!(state.target(Some(b.clone())));
    assert!(state.snapshot.is_none() && state.selected.is_none() && !state.busy);
    assert!(!state.accept(g2, &a, Ok(s.clone())));
    state.target(Some(a.clone()));
    let g = state.begin();
    let mut changed = (*s).clone();
    changed.tasks.retain(|t| t.id != "task-B");
    state.selected = Some("task-B".into());
    state.accept(g, &a, Ok(Arc::new(changed)));
    assert!(state.selected.is_none());
    state.target(None);
    assert!(!state.accept(g, &a, Ok(s)));
    assert!(state.snapshot.is_none());
}
