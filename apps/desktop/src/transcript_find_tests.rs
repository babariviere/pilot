use super::*;
fn row(id: u64, label: &str, source: &str) -> Message {
    Message::live(id, label.into(), source.into()).anchored(ReaderKey::model(id, 0, None))
}
fn run(rows: Vec<Message>, q: &str) -> Results {
    scan(rows, q, &AtomicBool::new(false))
}
#[test]
fn literal_unicode_repeated_and_stable_identity() {
    let text = "Éé 👨‍👩‍👧 e\u{301} 日本 日本 .*";
    let r = run(vec![row(9, "You", text)], "日本");
    assert_eq!(r.hits.len(), 2);
    assert_ne!(r.hits[0].range, r.hits[1].range);
    for h in &r.hits {
        assert_eq!(&text[h.range.clone()], "日本");
    }
    assert_eq!(run(vec![row(9, "assistant", text)], ".*").hits.len(), 1);
    assert_eq!(run(vec![row(9, "assistant", text)], "é").hits.len(), 1);
    assert_eq!(
        run(vec![row(9, "assistant", text)], "e\u{301}").hits.len(),
        1
    );
    let p = run(vec![row(1, "You", "earlier"), row(9, "You", text)], "日本");
    assert!(p.hits == r.hits);
    assert_eq!(step(0, 2, true), 1);
    assert_eq!(step(1, 2, false), 0);
    assert_eq!(step(0, 0, true), 0);
}
#[test]
fn committed_visible_source_only() {
    let rows = vec![
        row(1, "toolResult", "secret"),
        row(2, "Thinking", "secret"),
        Message::live(3, "Assistant · streaming".into(), "secret".into()),
        row(4, "assistant", "[No text content]"),
        row(5, "You", "secret"),
    ];
    let r = run(rows, "secret");
    assert_eq!(r.hits.len(), 1);
    assert_eq!(r.hits[0].key, ReaderKey::model(5, 0, None));
    assert!(
        run(vec![row(1, "You", "same"), row(1, "You", "same")], "same")
            .hits
            .is_empty()
    );
}
#[test]
fn limits_empty_query_and_cancellation_are_honest() {
    let r = run(vec![row(1, "You", &"a".repeat(1002))], "a");
    assert_eq!(r.hits.len(), 1000);
    assert!(r.limited);
    assert!(run(vec![row(1, "You", "a")], "").hits.is_empty());
    assert!(
        run(vec![row(1, "You", "a")], &"a".repeat(1025))
            .hits
            .is_empty()
    );
    let r = run((0..513).map(|i| row(i, "You", "x")).collect(), "absent");
    assert!(r.limited);
    assert!(r.hits.is_empty());
    let r = run(vec![row(1, "You", &"日".repeat(BYTES / 3 + 10))], "absent");
    assert!(r.limited);
    assert!(
        scan(vec![row(1, "You", "x")], "x", &AtomicBool::new(true))
            .hits
            .is_empty()
    );
}
