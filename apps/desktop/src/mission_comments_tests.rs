use super::*;
use serde_json::json;

#[test]
fn projects_every_received_comment_exactly_in_order() {
    let long = format!("{}\n終わり 👩‍💻", "Line with Unicode 日本語 é ".repeat(900));
    let mut rows: Vec<_> = (0..300)
        .map(|i| json!({"id":format!("c{i}"),"text":format!("Comment {i}"),"authorSessionId":"chat-B","createdAt":i}))
        .collect();
    rows[7] = json!({"id":"quoted","text":long,"anchor":"> the brief\nsays 私","revision":4,"targetSessionId":"chat-A","createdAt":7.5});
    rows.push(json!({"id":"done","text":"","authorSessionId":"chat-A","createdAt":1,"resolvedAt":9,"resolvedBySessionId":"chat-B"}));
    let c = project(&json!({ "comments": rows })).unwrap().unwrap();
    assert_eq!(c.len(), 301, "no visibility cap");
    assert_eq!(c[0].id, "c0");
    assert_eq!(c[299].id, "c299");
    let q = &c[7];
    assert_eq!(q.text, long, "exact text, never clipped");
    assert_eq!(q.anchor.as_deref(), Some("> the brief\nsays 私"));
    assert_eq!((q.revision, q.author.as_deref()), (Some(4), None));
    assert_eq!(q.target.as_deref(), Some("chat-A"));
    assert!(q.open() && c[0].open());
    let done = &c[300];
    assert!(!done.open());
    assert_eq!(done.text, "");
    assert_eq!(done.resolved_by.as_deref(), Some("chat-B"));
}

#[test]
fn absent_is_unknown_and_malformed_is_an_error() {
    assert_eq!(project(&json!({})), Ok(None));
    assert_eq!(project(&json!({ "comments": [] })), Ok(Some(vec![])));
    let ok = json!({"id":"a","text":"x","createdAt":1});
    for bad in [
        json!({}),
        json!([{"text":"x","createdAt":1}]),
        json!([ok.clone(), ok.clone()]),
        json!([{"id":"a","text":7,"createdAt":1}]),
        json!([{"id":"a","text":"x"}]),
        json!([{"id":"a","text":"x","createdAt":1,"resolvedAt":"soon"}]),
        json!([{"id":"a","text":"x","createdAt":1,"authorSessionId":""}]),
        json!([{"id":"a","text":"x","createdAt":1,"anchor":3}]),
        json!([{"id":"a","text":"x","createdAt":1,"revision":-1}]),
    ] {
        assert!(project(&json!({ "comments": bad })).is_err(), "{bad}");
    }
}
