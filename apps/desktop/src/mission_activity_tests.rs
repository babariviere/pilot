use super::*;
use crate::mission_browser_fixture::key;
use serde_json::json;
fn entry(id: u64) -> Value {
    json!({"id":id,"kind":"update","text":"Same text 私 👩‍💻","at":1700000000000u64})
}
#[test]
fn canonical_ids_order_and_deduplicate_never_titles_or_timestamps() {
    let events = page(&json!([entry(2), entry(3), entry(2), entry(1)]), None).unwrap();
    assert_eq!(events.iter().map(|e| e.id).collect::<Vec<_>>(), [3, 2, 1]);
    let mut conflict = entry(2);
    conflict["text"] = json!("different");
    assert!(page(&json!([entry(2), conflict]), None).is_err());
    assert!(page(&json!([entry(3)]), Some(3)).is_err());
    assert!(page(&json!([entry(9_007_199_254_740_992)]), None).is_err());
}
#[test]
fn attribution_preserves_recorded_source_without_inventing_authorship() {
    let mut agent = entry(2);
    agent["kind"] = json!("handoff");
    agent["sessionId"] = json!("chat-A");
    agent["taskId"] = json!("task-A");
    let entries = page(&json!([agent, entry(1)]), None).unwrap();
    assert_eq!(entries[0].source(), "Chat chat-A");
    assert_eq!(entries[0].heading(), "Handoff");
    assert_eq!(entries[1].source(), "User or system (source unspecified)");
    assert_eq!(entries[0].task.as_deref(), Some("task-A"));
    let mut bad = entry(1);
    bad["sessionId"] = json!("../chat");
    assert!(page(&json!([bad]), None).is_err());
}
#[test]
fn bounds_reject_whole_page_and_ignore_unknown_private_fields() {
    assert!(
        page(
            &json!((0..51).map(|i| entry(i + 1)).collect::<Vec<_>>()),
            None
        )
        .is_err()
    );
    let mut large = entry(1);
    large["text"] = json!("a".repeat(TEXT_CAP + 1));
    assert!(page(&json!([large]), None).is_err());
    let mut unknown = entry(1);
    unknown["thinking"] = json!("never project this field");
    unknown["kind"] = json!("future");
    let e = page(&json!([unknown]), None).unwrap();
    assert_eq!(e[0].heading(), "Other event");
    assert!(!format!("{e:?}").contains("never project"));
}
#[test]
fn paging_empty_boundary_and_failed_retry_preserve_snapshot() {
    let mut t = Timeline::default();
    t.select(Some(key("mission-A")));
    let (g, k, b) = t.begin(false).unwrap();
    assert!(t.begin(false).is_none());
    t.accept(g, &k, b, page(&json!([entry(3), entry(2)]), b));
    assert!(!t.exhausted);
    let (g, k, b) = t.begin(true).unwrap();
    assert_eq!(b, Some(2));
    t.accept(g, &k, b, Err("offline"));
    assert_eq!(t.rows.len(), 2);
    assert_eq!(t.error, Some("offline"));
    let (g, k, b) = t.begin(true).unwrap();
    t.accept(g, &k, b, page(&json!([entry(1)]), b));
    assert_eq!(t.rows.len(), 3);
    let (g, k, b) = t.begin(true).unwrap();
    t.accept(g, &k, b, Ok(vec![]));
    assert!(t.exhausted);
    assert!(t.begin(true).is_none());
    let (g, k, b) = t.begin(false).unwrap();
    t.accept(g, &k, b, Err("refresh failed"));
    assert!(t.stale);
    assert_eq!(t.rows.len(), 3);
}
#[test]
fn switched_mission_cancelled_and_older_generation_cannot_leak() {
    let mut t = Timeline::default();
    t.select(Some(key("mission-A")));
    let (g, k, b) = t.begin(false).unwrap();
    t.select(Some(key("mission-B")));
    assert!(!t.accept(g, &k, b, page(&json!([entry(3)]), None)));
    assert!(t.rows.is_empty());
    let (g, k, b) = t.begin(false).unwrap();
    t.select(None);
    assert!(!t.accept(g, &k, b, Err("old error")));
    assert!(t.error.is_none());
    t.select(Some(key("mission-A")));
    let (g, k, b) = t.begin(false).unwrap();
    assert!(!t.accept(g - 1, &k, b, Ok(vec![])));
    assert!(t.pending.is_some());
    assert!(t.accept(g, &k, b, Ok(vec![])));
    assert!(t.loaded && t.exhausted);
}
#[test]
fn viewing_limit_is_not_a_completeness_claim() {
    let mut t = Timeline::default();
    t.select(Some(key("mission-A")));
    for n in (1..=5).rev() {
        let (g, k, b) = t.begin(n != 5).unwrap();
        let p = page(
            &json!(((n - 1) * 50 + 1..=n * 50).map(entry).collect::<Vec<_>>()),
            b,
        );
        assert!(t.accept(g, &k, b, p));
    }
    assert_eq!(t.rows.len(), ROW_CAP);
    assert!(!t.exhausted);
    assert!(t.begin(true).is_none());
}
