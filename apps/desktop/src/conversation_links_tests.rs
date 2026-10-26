use super::*;
use serde_json::json;
fn row(id: u64, text: &str) -> Message {
    Message::live(id, "Assistant".into(), text.into()).anchored(ReaderKey::model(id, 0, Some(0)))
}
#[test]
fn provenance_and_exact_copy_spelling_survive_conservative_dedup() {
    let snapshot = scan(vec![
        row(
            1,
            "[Doc](https://Example.org/a_(b)) https://example.org/a_(b)",
        ),
        row(2, "https://EXAMPLE.org/a_(b)"),
    ]);
    assert_eq!(snapshot.links.len(), 1);
    assert_eq!(snapshot.links[0].url, "https://EXAMPLE.org/a_(b)");
    assert_eq!(snapshot.links[0].mentions, 3);
    assert_eq!(snapshot.links[0].sources.len(), 2);
    assert_eq!(
        snapshot.links[0].sources[0].key,
        ReaderKey::model(2, 0, Some(0))
    );
}
#[test]
fn unsafe_schemes_controls_credentials_and_non_word_schemes_are_rejected() {
    let snapshot = scan(vec![row(
        1,
        "javascript:https://bad.io file:///tmp/x slack://abc artifact://id xhttps://bad.io éhttps://bad.io https://user:password@host.io https://host.io/\u{1}bad https://host.io/%0Abad https://host.io/\\x https://host.io/\u{202e}bad https://safe.io/path?q=1#part",
    )]);
    assert_eq!(snapshot.links.len(), 1);
    assert_eq!(snapshot.links[0].url, "https://safe.io/path?q=1#part");
}
#[test]
fn scan_caps_and_utf8_boundary_are_honest() {
    let text = format!("{}https://not-scanned.io", "日".repeat(ROW_BYTES));
    let snapshot = scan(vec![row(1, &text)]);
    assert!(snapshot.links.is_empty());
    assert!(snapshot.limited);
    let text = (0..100)
        .map(|n| format!("https://h{n}.io "))
        .collect::<String>();
    let snapshot = scan(vec![row(1, &text)]);
    assert_eq!(snapshot.links.len(), LINKS);
    assert!(snapshot.limited);
    let snapshot = scan((0..600).map(|n| row(n, "https://same.io")).collect());
    assert_eq!(snapshot.links[0].sources.len(), MENTIONS);
    // Hitting the mention budget is itself an explicit truncation.
    assert!(snapshot.limited);
}
#[test]
fn actual_reader_excludes_reasoning_and_preserves_entry_model_block_identity() {
    let mut model = crate::local_model::LiveTranscript::default();
    model.apply(&json!({"type":"snapshot","entries":[{"id":17,"kind":"pi.assistant","model":[{"role":"assistant","content":[{"type":"thinking","thinking":"https://private.io"},{"type":"text","text":"[Read](https://received.io/doc)"}]}]}]}));
    let snapshot = scan(model.rows());
    assert_eq!(snapshot.links.len(), 1);
    assert_eq!(
        snapshot.links[0].sources[0].key,
        ReaderKey::model(17, 0, Some(1))
    );
    assert_eq!(snapshot.links[0].url, "https://received.io/doc");
}
