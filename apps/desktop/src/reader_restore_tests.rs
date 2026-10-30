//! Synthetic page admissions through the production reader owner.
use super::*;
use crate::{local_model::LiveTranscript, model::ReaderKey};
use gpui_kit::{AnyWindowHandle, TestAppContext, WindowOptions};
use serde_json::json;

fn entry(id: u64) -> serde_json::Value {
    json!({"id":id,"kind":"pi.user","model":[{"role":"user","content":format!("Message {id}")} ]})
}
fn setup(
    cx: &mut TestAppContext,
) -> (
    AnyWindowHandle,
    Entity<LocalViewer>,
    async_channel::Receiver<Command>,
    LiveTranscript,
) {
    cx.update(|cx| {
        gpui_kit::init(cx);
        crate::init_appearance(cx);
    });
    let (h, v) = cx.update(|cx| {
        gpui_kit::open_window(
            WindowOptions {
                show: false,
                ..Default::default()
            },
            cx,
            |w, cx| cx.new(|cx| LocalViewer::preview(PreviewState::Conversation, w, cx)),
        )
        .unwrap()
    });
    let (client, commands) = LocalClient::synthetic_commands();
    v.update(cx, |v, cx| {
        v.client = Some(client);
        v.generation = 7;
        v.state.generation = 7;
        v.selected = Some("synthetic".into());
        v.transcript
            .update(cx, |t, cx| t.replace_readonly(Vec::new(), true, cx));
        v.pending_reader = Some(crate::navigation::ReaderRestoration {
            generation: 7,
            owner: "synthetic".into(),
            mark: crate::navigation::ReadingMark {
                message: Some(ReaderKey::model(20, 0, None)),
                offset: 0.,
                following: false,
            },
            revision: None,
        });
    });
    let mut model = LiveTranscript::default();
    model.apply(&json!({"type":"snapshot","entries":[entry(80),entry(100)],"history":{"context":{"conversationId":0,"tail":100},"more":true,"before":80}}));
    (h, v, commands, model)
}
fn publish(
    cx: &mut TestAppContext,
    h: AnyWindowHandle,
    v: &Entity<LocalViewer>,
    model: &mut LiveTranscript,
    revision: u64,
    error: bool,
) {
    let rows = model.rows();
    cx.update_window(h, |_, w, cx| {
        v.update(cx, |v, cx| {
            let mut s = v.state.clone();
            s.rows = rows;
            s.loaded = true;
            s.cursor = model.cursor;
            s.page_busy = false;
            s.page_revision = revision;
            s.page_error = error;
            v.accept(s, w, cx);
        })
    })
    .unwrap();
    cx.run_until_parked();
}
fn page(model: &mut LiveTranscript, before: u64, ids: &[u64], next: Option<u64>) {
    assert!(model.page(before,&json!({"before":before,"context":{"conversationId":0,"tail":100},"entries":ids.iter().map(|&id|entry(id)).collect::<Vec<_>>(),"more":next.is_some(),"nextBefore":next})));
}
fn earlier(commands: &async_channel::Receiver<Command>, before: u64) {
    assert!(
        matches!(commands.try_recv(),Ok(Command::Earlier {before:b,generation:7}) if b==before),
        "restore must request page {before}"
    );
    assert!(commands.is_empty(), "one bounded page at a time");
}
#[gpui_kit::test]
fn unloaded_anchor_pages_until_found_without_error_or_full_drain(cx: &mut TestAppContext) {
    let (h, v, commands, mut model) = setup(cx);
    publish(cx, h, &v, &mut model, 0, false);
    earlier(&commands, 80);
    v.read_with(cx, |v, _| {
        assert!(v.pending_reader.is_some());
        assert!(v.nav_error.is_none());
    });
    // A pre-request publication is not completion and must not start another page.
    publish(cx, h, &v, &mut model, 0, false);
    assert!(commands.is_empty());
    page(&mut model, 80, &[50, 60], Some(50));
    publish(cx, h, &v, &mut model, 1, false);
    earlier(&commands, 50);
    page(&mut model, 50, &[20, 30], Some(20));
    publish(cx, h, &v, &mut model, 2, false);
    v.read_with(cx, |v, cx| {
        assert!(v.pending_reader.is_none());
        assert!(v.nav_error.is_none());
        let mark = v.transcript.read(cx).reading_mark(cx).unwrap();
        assert_eq!(mark.message, Some(ReaderKey::model(20, 0, None)));
        assert!(!mark.following);
        assert_eq!(v.state.cursor, Some(20), "older pages remain lazy");
    });
    assert!(commands.is_empty());
}
#[gpui_kit::test]
fn failed_page_waits_for_retry_then_resumes_restoration(cx: &mut TestAppContext) {
    let (h, v, commands, mut model) = setup(cx);
    publish(cx, h, &v, &mut model, 0, false);
    earlier(&commands, 80);
    publish(cx, h, &v, &mut model, 1, true);
    publish(cx, h, &v, &mut model, 1, true);
    assert!(commands.is_empty(), "no automatic failure retry loop");
    v.read_with(cx, |v, _| assert!(v.pending_reader.is_some()));
    v.update(cx, |v, cx| v.earlier(true, cx));
    earlier(&commands, 80);
    page(&mut model, 80, &[20, 30], Some(20));
    publish(cx, h, &v, &mut model, 2, false);
    v.read_with(cx, |v, _| {
        assert!(v.pending_reader.is_none());
        assert!(v.nav_error.is_none());
    });
}

#[gpui_kit::test]
fn live_growth_keeps_restore_cursor_and_canonical_rows(cx: &mut TestAppContext) {
    let (h, v, commands, mut model) = setup(cx);
    publish(cx, h, &v, &mut model, 0, false);
    earlier(&commands, 80);
    model.apply(&json!({"type":"entry_appended","entry":entry(101)}));
    publish(cx, h, &v, &mut model, 0, false);
    assert!(commands.is_empty());
    page(&mut model, 80, &[20, 30], Some(20));
    publish(cx, h, &v, &mut model, 1, false);
    v.read_with(cx, |v, cx| {
        let rows = v.transcript.read(cx).link_snapshot_rows();
        assert!(
            rows.iter()
                .any(|m| m.matches_reader(&ReaderKey::model(101, 0, None)))
        );
        assert_eq!(
            v.transcript.read(cx).reading_mark(cx).unwrap().message,
            Some(ReaderKey::model(20, 0, None))
        );
        assert!(v.nav_error.is_none());
    });
    assert!(commands.is_empty());
}

#[gpui_kit::test]
fn covered_removed_entry_or_missing_projection_stops_without_draining(cx: &mut TestAppContext) {
    for missing in [ReaderKey::model(20, 0, None), ReaderKey::model(30, 9, None)] {
        let (h, v, commands, mut model) = setup(cx);
        v.update(cx, |v, _| {
            v.pending_reader.as_mut().unwrap().mark.message = Some(missing.clone())
        });
        publish(cx, h, &v, &mut model, 0, false);
        earlier(&commands, 80);
        page(&mut model, 80, &[19, 30], Some(19));
        publish(cx, h, &v, &mut model, 1, false);
        v.read_with(cx, |v, cx| {
            assert!(v.nav_error.unwrap().contains("no longer available"));
            assert_eq!(
                v.pending_reader.as_ref().unwrap().mark.message,
                Some(missing)
            );
            assert!(
                !v.transcript.read(cx).history_position(cx).2,
                "never silently jump Latest"
            );
        });
        assert!(commands.is_empty());
    }
}

#[gpui_kit::test]
fn stale_snapshot_or_reconnect_revision_cancels_chain_but_retains_token(cx: &mut TestAppContext) {
    let (h, v, commands, mut model) = setup(cx);
    publish(cx, h, &v, &mut model, 0, false);
    earlier(&commands, 80);
    v.update(cx, |v, _| {
        v.state.reader_revision += 1;
        v.state.loaded = false;
    });
    v.update(cx, |v, cx| {
        v.transcript.update(cx, |t, cx| {
            assert!(t.restore_reading(
                crate::navigation::ReadingMark {
                    message: Some(ReaderKey::model(100, 0, None)),
                    offset: 0.,
                    following: false,
                },
                cx
            ));
        });
    });
    // Reconnect/new stream first reports unloaded, then its replacement snapshot.
    v.update(cx, |v, cx| v.restore_reader(cx));
    page(&mut model, 80, &[20, 30], Some(20));
    publish(cx, h, &v, &mut model, 1, false);
    v.read_with(cx, |v, _| {
        assert_eq!(
            v.pending_reader.as_ref().unwrap().mark.message,
            Some(ReaderKey::model(20, 0, None))
        );
        assert_eq!(v.pending_reader.as_ref().unwrap().revision, Some(0));
        assert_eq!(v.state.reader_revision, 1);
        assert!(
            v.earlier_request.is_none(),
            "no continuation of stale chain"
        );
    });
    assert!(commands.is_empty());
}

#[gpui_kit::test]
fn navigation_does_not_cache_temporary_tail_or_resume_hidden_restoration(cx: &mut TestAppContext) {
    let (h, v, commands, mut model) = setup(cx);
    publish(cx, h, &v, &mut model, 0, false);
    earlier(&commands, 80);
    cx.update_window(h, |_, w, cx| {
        v.update(cx, |v, cx| {
            let original = v.pending_reader.as_ref().unwrap().mark.clone();
            v.reader_marks.put("synthetic".into(), original);
            v.show_home(w, cx);
            assert!(v.pending_reader.is_none());
            assert_eq!(
                v.reader_marks.get(&"synthetic".into()).unwrap().message,
                Some(ReaderKey::model(20, 0, None))
            );
        })
    })
    .unwrap();
    page(&mut model, 80, &[50, 60], Some(50));
    publish(cx, h, &v, &mut model, 1, false);
    assert!(commands.is_empty());
}

#[gpui_kit::test]
fn fresh_initial_tail_and_following_mark_never_request_older_pages(cx: &mut TestAppContext) {
    for retained_tail in [false, true] {
        let (h, v, commands, mut model) = setup(cx);
        v.update(cx, |v, _| {
            if retained_tail {
                v.pending_reader.as_mut().unwrap().mark.following = true;
            } else {
                v.pending_reader = None;
            }
        });
        publish(cx, h, &v, &mut model, 0, false);
        assert!(commands.is_empty());
        v.read_with(cx, |v, cx| {
            assert!(v.pending_reader.is_none());
            assert!(v.nav_error.is_none());
            assert!(v.transcript.read(cx).history_position(cx).2);
        });
    }
}

#[gpui_kit::test]
fn wrong_page_context_remains_retryable_not_absence(cx: &mut TestAppContext) {
    let (h, v, commands, mut model) = setup(cx);
    publish(cx, h, &v, &mut model, 0, false);
    earlier(&commands, 80);
    assert!(!model.page(80,&json!({"before":80,"context":{"conversationId":1,"tail":100},"entries":[entry(20)],"more":false,"nextBefore":null})));
    publish(cx, h, &v, &mut model, 1, true);
    v.read_with(cx, |v, _| {
        assert!(v.state.page_error);
        assert!(v.nav_error.is_none());
        assert!(v.pending_reader.is_some());
    });
    assert!(commands.is_empty());
}

#[gpui_kit::test]
fn sequential_restore_stops_at_target_in_large_history(cx: &mut TestAppContext) {
    let (h, v, commands, _) = setup(cx);
    v.update(cx, |v, _| {
        v.pending_reader.as_mut().unwrap().mark.message = Some(ReaderKey::model(5500, 0, None))
    });
    let mut model = LiveTranscript::default();
    let context = json!({"conversationId":0,"tail":6000});
    model.apply(&json!({"type":"snapshot","entries":(5941..=6000).map(entry).collect::<Vec<_>>(),"history":{"context":context,"more":true,"before":5941}}));
    let started = std::time::Instant::now();
    publish(cx, h, &v, &mut model, 0, false);
    let mut pages = 0;
    let mut longest = Duration::ZERO;
    while v.read_with(cx, |v, _| v.pending_reader.is_some()) {
        let before = model.cursor.unwrap();
        earlier(&commands, before);
        let start = before - 24;
        let at = std::time::Instant::now();
        assert!(model.page(before,&json!({"before":before,"context":context,"entries":(start..before).map(entry).collect::<Vec<_>>(),"more":true,"nextBefore":start})));
        pages += 1;
        publish(cx, h, &v, &mut model, pages, false);
        longest = longest.max(at.elapsed());
    }
    assert_eq!(pages, 19);
    assert_eq!(model.cursor, Some(5485));
    assert!(commands.is_empty());
    println!(
        "synthetic restore6000: initial60 + {pages} pages x24; total={:?}, max page reducer/projection/admission={longest:?}; no network/draw timing",
        started.elapsed()
    );
}
