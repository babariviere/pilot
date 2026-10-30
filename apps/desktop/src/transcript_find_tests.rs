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
    assert!(!r.limited);
    assert!(r.hits.is_empty());
    let r = run(
        vec![row(1, "You", &format!("{}needle", "日".repeat(800_000)))],
        "needle",
    );
    assert!(!r.limited);
    assert_eq!(r.hits.len(), 1);
    assert!(
        scan(vec![row(1, "You", "x")], "x", &AtomicBool::new(true))
            .hits
            .is_empty()
    );
}

#[gpui_kit::test]
fn plain_ranges_preserve_literal_text_and_selection(cx: &mut gpui_kit::TestAppContext) {
    use gpui_kit::{
        AppContext,
        component::text::{RangeHighlight, TextViewState},
    };
    cx.update(gpui_kit::init);
    let source = "\n👩‍💻 e\u{301} **literal** <tag>&\r\nnext";
    let state = cx.update(|cx| cx.new(|cx| TextViewState::plain(source, cx)));
    cx.run_until_parked();
    state.update(cx, |state, cx| {
        let text = state.rendered_text();
        assert_eq!(text.source(), source);
        assert_eq!(text.as_str(), format!("{source}\n"));
        let ranges: Vec<_> = ["👩‍💻", "e\u{301}", "**literal**", "<tag>&\r\nnext"]
            .into_iter()
            .map(|q| {
                let start = source.find(q).unwrap();
                let range = text.range_for_source(start..start + q.len()).unwrap();
                assert_eq!(&text.as_str()[range.clone()], q);
                RangeHighlight::new(range, gpui_kit::hsla(0.6, 0.5, 0.5, 0.3))
            })
            .collect();
        state.select_all(cx);
        let copied = state.selected_text();
        state.set_range_highlights(ranges, cx).unwrap();
        assert_eq!(state.selected_source_range(), Some(0..source.len()));
        assert_eq!(state.selected_text(), copied);
        state.clear_range_highlights(cx);
        assert_eq!(state.selected_text(), copied);
        state.push_str(" tail 👩‍💻", cx);
    });
    cx.run_until_parked();
    state.update(cx, |state, cx| {
        let text = state.rendered_text();
        assert_eq!(text.source(), format!("{source} tail 👩‍💻"));
        let start = text.source().rfind("👩‍💻").unwrap();
        let range = text.range_for_source(start..text.source().len()).unwrap();
        assert_eq!(&text.as_str()[range], "👩‍💻");
        state.set_text("replaced 日本", cx);
    });
    cx.run_until_parked();
    state.read_with(cx, |state, _| {
        let text = state.rendered_text();
        assert_eq!(text.source(), "replaced 日本");
        assert!(
            text.range_for_source(source.len()..source.len() + 1)
                .is_none()
        );
    });
}

#[gpui_kit::test]
fn markdown_source_ranges_cover_code_multiline_and_unicode(cx: &mut gpui_kit::TestAppContext) {
    use gpui_kit::{
        AppContext,
        component::text::{RangeHighlight, TextViewState},
    };
    cx.update(gpui_kit::init);
    let source = "👩‍💻 **日本** `e\u{301}`\n\n```txt\nfirst 日本\nsecond 日本\n```\n\n[日本](https://example.com/hidden)";
    let state = cx.update(|cx| cx.new(|cx| TextViewState::markdown(source, cx)));
    cx.run_until_parked();
    state.update(cx, |state, cx| {
        let text = state.rendered_text();
        for q in ["日本", "e\u{301}", "👩‍💻", "first 日本\nsecond 日本"] {
            for (start, _) in source.match_indices(q) {
                let range = text.range_for_source(start..start + q.len()).unwrap();
                assert_eq!(&text.as_str()[range.clone()], q);
                state
                    .set_range_highlights(
                        [RangeHighlight::new(
                            range,
                            gpui_kit::hsla(0.6, 0.5, 0.5, 0.3),
                        )],
                        cx,
                    )
                    .unwrap();
            }
        }
        let start = source.find("https://").unwrap();
        assert!(
            text.range_for_source(start..start + 5).is_none(),
            "hidden destinations aren't painted"
        );
    });
}
