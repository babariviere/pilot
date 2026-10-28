use super::*;
use crate::mission_browser_fixture as f;
use serde_json::json;

#[test]
fn global_case_preserving_identity_and_provenance_filter_never_collapse_by_name_or_id() {
    let c = catalog(&f::catalog()).unwrap();
    assert_eq!(c.rows.len(), 3);
    let local = f::home();
    let a: Vec<_> = c
        .rows
        .iter()
        .filter(|r| r.in_scope(&local, Some("project-A")))
        .collect();
    assert_eq!(a.len(), 2);
    assert_eq!(a.iter().filter(|r| r.local_definition(&local)).count(), 1);
    assert_ne!(a[0].key, a[1].key);
    assert!(c.rows.iter().any(|r| r.key == f::key("mission-A")));
    assert!(c.rows.iter().any(|r| r.key == f::key("mission-B")));
    let mut v = f::catalog();
    v["logicalMissions"][0]["mission"]["missionId"] = json!("mission-a");
    assert!(catalog(&v).is_err());
    let mut v = f::catalog();
    v["logicalMissions"][1] = v["logicalMissions"][0].clone();
    assert!(catalog(&v).is_err());
    let mut v = f::catalog();
    v["logicalMissions"][0]["provenance"][0]["sourceHost"]["daemonId"] = json!("other");
    assert!(catalog(&v).is_err());
}
#[test]
fn catalog_empty_partial_unsupported_and_malformed_are_not_interchangeable() {
    assert!(catalog(&json!([])).is_err());
    assert!(catalog(&json!({"logicalMissions":[]})).is_err());
    let c =
        catalog(&json!({"logicalMissions":[],"totals":{"logicalMissions":0},"truncated":false}))
            .unwrap();
    assert!(c.rows.is_empty() && !c.truncated);
    let c =
        catalog(&json!({"logicalMissions":[],"totals":{"logicalMissions":600},"truncated":true}))
            .unwrap();
    assert!(c.rows.is_empty() && c.truncated && c.total == 600);
    let mut v = f::catalog();
    v["logicalMissions"] = json!(vec![v["logicalMissions"][0].clone(); 51]);
    assert!(catalog(&v).is_err());
    let mut v = f::catalog();
    v["logicalMissions"][0]["tasksDone"] = json!(3);
    assert!(catalog(&v).is_err());
    let mut v = f::catalog();
    v["truncated"] = json!(false);
    v["totals"]["logicalMissions"] = json!(100);
    assert!(catalog(&v).is_err());
}
#[test]
fn detail_is_canonical_bounded_and_plain_text_never_a_program_or_image() {
    let key = f::key("mission-A");
    let mut v = f::detail(&key.id);
    let d = detail(&key, &v).unwrap();
    assert_eq!(d.tasks[0].number, 1);
    assert!(d.brief.as_ref().unwrap().contains("![Never fetch]"));
    assert!(
        d.brief
            .as_ref()
            .unwrap()
            .contains("<script>Never execute</script>")
    );
    v["mission"]["goal"] = json!("日本語👩‍💻".repeat(4000));
    v["brief"]["markdown"] = json!("私".repeat(40000));
    let d = detail(&key, &v).unwrap();
    assert!(d.clipped && d.goal.len() <= 8192 && d.brief.unwrap().len() <= 32768);
    v["mission"]["id"] = json!("mission-a");
    assert!(detail(&key, &v).is_err());
    let mut v = f::detail(&key.id);
    v["brief"]["missionId"] = json!("mission-B");
    assert!(detail(&key, &v).is_err());
    // 256, 257 and 1002 received tasks all count; only the overview preview is short.
    for extra in [254, 255, 1000] {
        let d = detail(&key, &f::many(&key.id, extra)).unwrap();
        assert_eq!(d.task_count, extra + 2);
        assert_eq!(d.summary.total(), extra + 2);
        assert_eq!(d.summary.done(), 1);
        assert_eq!(d.tasks.len(), DISPLAY_TASKS);
    }
}
#[test]
fn context_row_caps_do_not_invent_task_counts_or_replace_membership() {
    let key = f::key("mission-A");
    let mut v = f::detail(&key.id);
    v["tasks"]=json!((0..80).map(|i|json!({"id":format!("task-{i}"),"number":i+1,"title":"Task","status":"todo","order":i})).collect::<Vec<_>>());
    let d = detail(&key, &v).unwrap();
    assert_eq!(d.task_count, 80);
    assert_eq!(d.tasks.len(), DISPLAY_TASKS);
    assert_eq!(d.counts, Some((1, 2)));
    let mut v = f::members(&key.id);
    v[0]["missionId"] = json!("mission-B");
    assert!(members(&d, &v).is_err());
    let mut v = f::members(&key.id);
    v[1]["id"] = v[0]["id"].clone();
    assert!(members(&d, &v).is_err());
    let mut v = f::members(&key.id);
    v[0]["projectId"] = json!("project-B");
    assert!(members(&d, &v).is_err());
    let values:Vec<_>=(0..MEMBER_CAP).map(|i|json!({"id":format!("chat-{i}"),"missionId":key.id,"projectId":d.project,"title":"Same"})).collect();
    let m = members(&d, &json!(values)).unwrap();
    assert_eq!(m.total, MEMBER_CAP);
    assert_eq!(m.rows.len(), DISPLAY_MEMBERS);
    // Exact links reach every received member, not only the displayed rows.
    assert_eq!(m.ids.len(), MEMBER_CAP);
    assert!(m.ids.contains(&format!("chat-{}", MEMBER_CAP - 1)));
}
#[test]
fn overview_summary_covers_every_received_task_by_work_status() {
    let key = f::key("mission-A");
    let mut v = f::detail(&key.id);
    let task = |i: usize, status: &str, order: usize| json!({"id":format!("task-{i}"),"number":i+1,"title":format!("Task {i}"),"status":status,"order":order});
    let mut tasks: Vec<_> = (0..40).map(|i| task(i, "done", i)).collect();
    tasks.push(task(40, "in_review", 0));
    tasks.push(task(41, "in_progress", 50));
    tasks.push(task(42, "in_progress", 1));
    tasks.push(task(43, "blocked", 2));
    tasks.push(task(44, "dropped", 3));
    tasks.push(task(45, "todo", 4));
    // Phase gating projects Blocked; the task's own status counts.
    let mut gated = task(46, "blocked", 5);
    gated["storedStatus"] = json!("todo");
    gated["sessionId"] = json!("chat-A");
    tasks.push(gated);
    v["tasks"] = json!(tasks);
    let d = detail(&key, &v).unwrap();
    assert_eq!(d.tasks.len(), DISPLAY_TASKS);
    let s = &d.summary;
    assert_eq!(
        s.counts,
        vec![
            ("done", 40),
            ("in_review", 1),
            ("in_progress", 2),
            ("blocked", 1),
            ("todo", 2)
        ]
    );
    assert_eq!((s.done(), s.total()), (40, 46));
    let ids = |t: &[Task]| t.iter().map(|t| t.id.clone()).collect::<Vec<_>>();
    assert_eq!(ids(&s.working), ["task-42", "task-41", "task-40"]);
    assert_eq!(ids(&s.blocked), ["task-43"]);
    let gated = d.tasks.iter().find(|t| t.id == "task-46").unwrap();
    assert_eq!(
        (gated.status.as_str(), gated.work_status.as_str()),
        ("blocked", "todo")
    );
    assert_eq!(gated.owner.as_deref(), Some("chat-A"));
    let mut v = f::detail(&key.id);
    v["tasks"] = json!([]);
    let d = detail(&key, &v).unwrap();
    assert!(d.summary.counts.is_empty() && d.summary.total() == 0);
}
