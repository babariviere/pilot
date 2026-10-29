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
    v["tasks"][0]["id"] = json!("bad/id");
    assert!(parse(&key, &v).is_err());
    let mut v = value();
    v["tasks"] = json!([]);
    assert!(parse(&key, &v).unwrap().tasks.is_empty());
}
#[test]
fn every_received_task_is_admitted_in_order_at_and_beyond_256() {
    let key = f::key("mission-A");
    // 2, 256, 257 and 1002 received tasks: no row ceiling, exact order kept.
    for extra in [0, 254, 255, 1000] {
        let s = parse(&key, &f::many("mission-A", extra)).unwrap();
        assert_eq!(s.tasks.len(), extra + 2);
        assert_eq!(s.tasks[extra].id, "task-A");
        assert_eq!(s.tasks[extra + 1].id, "task-B");
        if extra > 0 {
            assert_eq!(s.tasks[0].id, "filler-0");
            assert_eq!(s.tasks[extra - 1].id, format!("filler-{}", extra - 1));
            assert_eq!(s.tasks[extra - 1].body.len(), 8000);
        }
    }
    let mut v = f::many("mission-A", 300);
    v["tasks"][0]["dependsOn"] = json!((1..300).map(|i| format!("filler-{i}")).collect::<Vec<_>>());
    let s = parse(&key, &v).unwrap();
    assert!(s.task("filler-0").unwrap().context.contains("filler-299"));
}
#[test]
fn progress_matches_overview_bar_order_without_dropped_and_with_work_status() {
    let key = f::key("mission-A");
    let mut v = f::detail("mission-A");
    // Fill-sorted legends put to do before blocked; the bar order does not.
    let statuses = [
        "todo",
        "dropped",
        "blocked",
        "done",
        "delegated",
        "in_review",
        "in_progress",
        "todo",
    ];
    v["tasks"] = json!(statuses
        .iter()
        .enumerate()
        .map(|(n, s)| json!({"id":format!("t-{n}"),"number":n+1,"title":"Same","status":s,"order":n}))
        .collect::<Vec<_>>());
    // Phase gating projects Blocked; its work status is the stored To do.
    v["tasks"][7]["status"] = json!("blocked");
    v["tasks"][7]["storedStatus"] = json!("todo");
    let s = parse(&key, &v).unwrap();
    assert_eq!(
        s.progress,
        [
            ("done", 1),
            ("in_review", 1),
            ("in_progress", 1),
            ("blocked", 1),
            ("todo", 2),
            ("delegated", 1),
        ]
    );
    let overview = crate::mission_browser::detail(&key, &v).unwrap();
    assert_eq!(s.progress, overview.summary.counts);
    v["tasks"] = json!([]);
    assert!(parse(&key, &v).unwrap().progress.is_empty());
}
#[test]
fn sections_group_every_task_by_phase_order_and_find_exact_positions() {
    let key = f::key("mission-A");
    let mut v = f::detail("mission-A");
    let task = |n: usize, status: &str, phase: Option<&str>| {
        let mut t =
            json!({"id":format!("t-{n}"),"number":n+1,"title":"Same","status":status,"order":n});
        if let Some(p) = phase {
            t["phaseId"] = json!(p);
        }
        t
    };
    v["tasks"] = json!([
        task(0, "todo", None),
        task(1, "done", Some("p-b")),
        task(2, "dropped", Some("p-a")),
        task(3, "in_progress", Some("p-a")),
        task(4, "done", Some("p-a")),
        task(5, "todo", Some("p-gone")),
    ]);
    v["phases"] = json!([
        {"id":"p-b","missionId":"mission-A","name":"Second","order":2},
        {"id":"p-a","missionId":"mission-A","name":"First 日本語","order":1},
        {"id":"p-empty","missionId":"mission-A","name":"Empty","order":3}
    ]);
    let s = parse(&key, &v).unwrap();
    let titles: Vec<_> = s.sections.iter().map(|s| s.title.as_deref()).collect();
    // Empty phases have no rows; dropped tasks stay listed; No phase is last.
    assert_eq!(
        titles,
        [Some("First 日本語"), Some("Second"), Some("No phase")]
    );
    let progress: Vec<_> = s.sections.iter().map(|s| s.progress.as_str()).collect();
    assert_eq!(progress, ["1/2 done", "1/1 done", "0/2 done"]);
    let ids = |section: usize| -> Vec<&str> {
        (0..s.sections[section].tasks.len())
            .map(|row| s.at(section, row).unwrap().id.as_str())
            .collect()
    };
    assert_eq!(ids(0), ["t-2", "t-3", "t-4"]);
    assert_eq!(ids(2), ["t-0", "t-5"]);
    assert_eq!(s.position("t-4"), Some((0, 2)));
    assert_eq!(s.position("t-5"), Some((2, 1)));
    assert_eq!(s.position("missing"), None);
    assert!(s.at(3, 0).is_none() && s.at(0, 3).is_none());
    assert!(
        s.task("t-3")
            .unwrap()
            .context
            .contains("Phase: First 日本語")
    );
    assert!(!s.task("t-5").unwrap().context.contains("Phase:"));
    assert_eq!(
        s.sections.iter().map(|s| s.tasks.len()).sum::<usize>(),
        s.tasks.len()
    );
    // Without phases the list is one untitled section in task order.
    v["phases"] = json!([]);
    let s = parse(&key, &v).unwrap();
    assert_eq!(s.sections.len(), 1);
    assert!(s.sections[0].title.is_none());
    assert_eq!(s.position("t-5"), Some((0, 5)));
    v["tasks"] = json!([]);
    let s = parse(&key, &v).unwrap();
    assert!(s.at(0, 0).is_none());
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
