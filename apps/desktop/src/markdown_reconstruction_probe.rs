//! Small streamed Markdown and older-page reconstruction, sharing the native root.
use super::*;
use gpui_kit::{EntityInputHandler, Focusable};

pub(super) fn run(
    cx: &mut HeadlessAppContext,
    h: AnyWindowHandle,
    v: &Entity<LocalViewer>,
    source: &str,
    expected: &str,
) {
    let context = json!({"conversationId":0,"tail":30});
    let mut model = LiveTranscript::default();
    model.apply(&json!({"type":"snapshot","entries":[entry(20,"Recent context")],"history":{"context":context,"more":true,"before":20,"question":null}}));
    model.apply(&json!({"type":"run_start"}));
    let first = source.find("\n\t").unwrap();
    model.apply(&json!({"type":"message_start","message":{"role":"assistant","timestamp":30,"content":[{"type":"text","text":&source[..first]}]}}));
    publish(cx, h, v, &mut model, true);
    let id = cx.update(|cx| v.read(cx).transcript.read(cx).rows().last().unwrap().id());
    let text = text_state(cx, v, id);
    cx.update_window(h, |_, w, cx| {
        // The leaves have no observable IDs. Target the first code line after
        // the intro/native block spacing. Exact range/indentation assertions
        // below prove the hit, not bounds alone.
        let b = text.read(cx).bounds();
        w.drag(
            b.origin + point(px(16.), px(72.)),
            b.origin + point(px(240.), px(72.)),
            cx,
        );
    })
    .unwrap();
    settle(cx, h);
    let copied = copy(cx, h);
    assert!(
        copied.starts_with("  <b"),
        "streamed code indentation really selected: {copied:?}"
    );
    let range = cx.update(|cx| text.read(cx).selected_source_range().unwrap());
    assert_eq!(copied, source[range.clone()]);
    let mut end = first;
    for next in [
        source.find(LIST).unwrap(),
        source.find(TABLE).unwrap(),
        source.len(),
    ] {
        model.apply(&json!({"type":"message_update","changes":[{"type":"text_delta","contentIndex":0,"delta":&source[end..next]}]}));
        end = next;
        publish(cx, h, v, &mut model, false);
        assert_eq!(
            text_state(cx, v, id),
            text,
            "stream retains parser identity"
        );
        assert_eq!(
            cx.update(|cx| text.read(cx).selected_source_range()),
            Some(range.clone())
        );
        assert_eq!(
            copy(cx, h),
            copied,
            "fence/list/table append retains selection"
        );
        cx.update(|cx| assert_eq!(text.read(cx).rendered_text().source(), &source[..next]));
    }
    model.apply(&json!({"type":"message_end","entry":entry(30,source)}));
    publish(cx, h, v, &mut model, false);
    assert_eq!(
        text_state(cx, v, id),
        text,
        "commit keeps canonical row and parser"
    );
    assert_eq!(copy(cx, h), copied);
    cx.update(|cx| assert_eq!(text.read(cx).rendered_text().as_str(), expected));
    let transcript = cx.update(|cx| v.read(cx).transcript.clone());
    // Use the real page-request/response owner, including its fitting-history
    // slack. A bare row prepend is not the lazy-history admission contract.
    cx.update(|cx| {
        v.update(cx, |v, cx| {
            v.state.cursor = model.cursor;
            v.state.generation = v.generation;
            Arc::make_mut(&mut v.state.chats)
                .iter_mut()
                .find(|c| c.id == "synthetic")
                .unwrap()
                .writable = true;
            v.earlier(true, cx);
            assert!(
                v.earlier_request.is_some(),
                "synthetic Earlier request admitted"
            );
        })
    });
    settle(cx, h);
    let mark = cx.update(|cx| transcript.read(cx).reading_mark(cx).unwrap());
    // Simulated native preedit is retained, not OS IME qualification.
    let input = cx.update(|cx| v.read(cx).editor.read(cx).shell_probe().0);
    cx.update_window(h, |_, w, cx| {
        input.update(cx, |i, cx| {
            i.focus(w, cx);
            i.replace_text_in_range(None, "Keep 👩🏽‍💻 draft", w, cx);
            i.replace_and_mark_text_in_range(None, "にほん", Some(3..3), w, cx);
        })
    })
    .unwrap();
    settle(cx, h);
    let draft = cx.update(|cx| input.read(cx).value());
    assert!(model.page(20,&json!({"context":context,"before":20,"entries":[entry(10,"```text\n  <old>&amp;\n```\n"),entry(11,LIST),entry(12,TABLE)],"more":false,"nextBefore":null})));
    let rows = model.rows();
    cx.update_window(h, |_, w, cx| {
        v.update(cx, |v, cx| {
            let mut state = v.state.clone();
            state.rows = rows;
            state.cursor = model.cursor;
            state.page_busy = false;
            state.page_revision += 1;
            v.accept(state, w, cx);
        })
    })
    .unwrap();
    settle(cx, h);
    cx.update_window(h, |_, w, cx| {
        let now = transcript.read(cx).reading_mark(cx).unwrap();
        assert_eq!(now.message, mark.message, "older page keeps reading anchor");
        assert_eq!(now.following, mark.following);
        assert!((now.offset - mark.offset).abs() < 2.);
        assert_eq!(transcript.read(cx).history_probe_row(id), text);
        assert_eq!(text.read(cx).selected_source_range(), Some(range.clone()));
        input.update(cx, |i, cx| {
            assert_eq!(i.value(), draft);
            assert!(i.marked_text_range(w, cx).is_some());
            assert!(i.focus_handle(cx).is_focused(w));
            i.unmark_text(w, cx);
        });
        let focus = text.read(cx).focus_handle().clone();
        focus.focus(w, cx);
    })
    .unwrap();
    settle(cx, h);
    assert_eq!(
        copy(cx, h),
        copied,
        "older page preserves literal selection copy"
    );
    // Mount the reconstructed older code/list/table, rather than only reading
    // reducer strings. Source Copy remains tied to each exact canonical row.
    let older = cx.update(|cx| transcript.read(cx).rows()[0..3].to_vec());
    cx.update(|cx| {
        transcript.update(cx, |t, cx| {
            t.restore_reading(
                crate::navigation::ReadingMark {
                    message: older[0].reader_key(),
                    offset: 0.,
                    following: false,
                },
                cx,
            )
        })
    });
    settle(cx, h);
    for row in older {
        let parsed = text_state(cx, v, row.id());
        cx.update_window(h, |_, w, cx| {
            assert_eq!(parsed.read(cx).rendered_text().source(), row.source());
            crate::transcript_view::click_copy(w, row.id(), cx);
            assert_eq!(
                cx.read_from_clipboard().unwrap().text().unwrap(),
                row.source()
            );
        })
        .unwrap();
    }
    println!(
        "Markdown reconstruction: open fence → list/table stream → canonical commit → three-entry older page, retained selection/anchor/draft/preedit"
    );
}
