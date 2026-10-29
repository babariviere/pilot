use super::*;
use crate::mission_browser_fixture as f;
fn source() -> Source {
    Source {
        key: f::key("mission-A"),
        project: "project-A".into(),
    }
}
#[test]
fn transition_matrix_and_response_identity() {
    for status in ["active", "done", "archived"] {
        assert_eq!(Action::Archive.allowed(status), status != "archived");
        assert_eq!(Action::Reopen.allowed(status), status != "active");
        assert_eq!(Action::Complete.allowed(status), status == "active");
    }
    assert!(!Action::Archive.allowed("unknown"));
    assert!(!Action::Reopen.allowed("unknown"));
    assert!(parse(&source(), &f::detail("mission-A")["mission"]).is_ok());
    assert!(parse(&source(), &f::detail("mission-B")["mission"]).is_err());
    let mut legacy = f::detail("mission-A")["mission"].clone();
    legacy["title"] = " Legacy 😀 ".repeat(201).into();
    assert_eq!(parse(&source(), &legacy).unwrap().title, legacy["title"]);
}
#[test]
fn completion_requires_the_whole_finished_catalog_not_summary_or_visible_rows() {
    let mut v = f::detail("mission-A");
    assert!(finished(&v).is_none());
    for status in [
        "todo",
        "in_progress",
        "blocked",
        "in_review",
        "delegated",
        "unknown",
    ] {
        v["tasks"][0]["status"] = status.into();
        assert!(finished(&v).is_none(), "unfinished {status}");
    }
    v["tasks"][0]["status"] = "done".into();
    v["mission"]["tasksDone"] = 2.into();
    assert_eq!(
        finished(&v),
        Some(Finished {
            done: 2,
            dropped: 0
        })
    );
    let snapshot = detail(&source(), &v).unwrap();
    assert!(
        State::default()
            .begin(&source(), &snapshot, Action::Complete)
            .is_ok()
    );
    v["tasks"][0]["status"] = "dropped".into();
    v["mission"]["tasksTotal"] = 1.into();
    v["mission"]["tasksDone"] = 1.into();
    assert_eq!(
        finished(&v),
        Some(Finished {
            done: 1,
            dropped: 1
        })
    );
    let mut visibility = crate::mission_tasks::Visibility::default();
    visibility.hide_finished = true;
    let catalog = crate::mission_tasks::parse(&source().key, &v).unwrap();
    visibility.collapsed.insert("flat".into());
    assert!(visibility.rows(&catalog).iter().all(Vec::is_empty));
    assert!(
        finished(&v).is_some(),
        "filtering and folding are not eligibility"
    );
    for field in ["tasksTotal", "tasksDone"] {
        let mut missing = v.clone();
        missing["mission"][field] = Value::Null;
        assert!(finished(&missing).is_none());
    }
    let mut truncated = v.clone();
    truncated["truncated"] = true.into();
    assert!(finished(&truncated).is_none());
    let mut incomplete = v.clone();
    incomplete["tasks"] = serde_json::json!([]);
    assert!(finished(&incomplete).is_none());
    for empty in [
        serde_json::json!([]),
        serde_json::json!([v["tasks"][0].clone()]),
    ] {
        let mut zero = v.clone();
        zero["tasks"] = empty;
        zero["mission"]["tasksDone"] = 0.into();
        zero["mission"]["tasksTotal"] = 0.into();
        assert!(finished(&zero).is_none(), "empty/all dropped follows Swift");
    }
    let mut many = f::many("mission-A", 300);
    for t in many["tasks"].as_array_mut().unwrap() {
        t["status"] = "done".into();
    }
    many["mission"]["tasksDone"] = 302.into();
    many["mission"]["tasksTotal"] = 302.into();
    assert_eq!(finished(&many).unwrap().done, 302);
    many["tasks"][301]["status"] = "todo".into();
    assert!(
        finished(&many).is_none(),
        "a task beyond the preview still blocks"
    );
}
#[test]
fn exact_capture_fences_late_results_and_all_replays() {
    let mut state = State::default();
    let before = Snapshot {
        title: "Same 日本語".into(),
        status: "active".into(),
        finished: None,
    };
    let send = state.begin(&source(), &before, Action::Archive).unwrap();
    let mut wrong = send.clone();
    wrong.source.key = f::key("mission-B");
    assert!(!state.finish(&wrong, Outcome::Ack));
    assert!(state.finish(&send, Outcome::Unknown("lost")));
    assert!(!state.finish(&send, Outcome::Ack));
    assert!(state.begin(&source(), &before, Action::Archive).is_err());
}
