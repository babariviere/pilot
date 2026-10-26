//! Full mounted chat -> Decisions -> chat journey, with no fixed Tab counts.
use super::*;
use crate::mission_browser_fixture::{self as f, Reply, Server};
use gpui_kit::{
    AnyWindowHandle, Bounds, EntityInputHandler, HeadlessAppContext, ScrollDelta, WindowBounds,
    WindowOptions, point, size, test::TestWindowExt,
};
use serde_json::json;
use std::time::Instant;
fn settle(cx: &mut HeadlessAppContext, h: AnyWindowHandle) {
    for _ in 0..4 {
        cx.run_until_parked();
        cx.advance_clock(Duration::from_millis(16));
        cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
    }
}
#[track_caller]
fn until(cx: &mut HeadlessAppContext, h: AnyWindowHandle, condition: impl Fn(&App) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !cx.update(|cx| condition(cx)) {
        assert!(
            Instant::now() < deadline,
            "bounded Decisions shell wait at {}",
            std::panic::Location::caller()
        );
        settle(cx, h);
        std::thread::yield_now();
    }
    settle(cx, h);
}
fn activate(cx: &mut HeadlessAppContext, h: AnyWindowHandle, id: String) {
    cx.update_window(h, |_, w, cx| {
        // Native pointer presses intentionally clear window text selection.
        // This journey proves the keyboard round-trip retains the real range.
        let mut reached = false;
        for _ in 0..80 {
            w.press("tab", cx);
            if w.find(id.clone()).focused() == Some(true) {
                reached = true;
                break;
            }
        }
        assert!(reached, "keyboard must reach exact canonical control {id}");
        w.press("enter", cx);
    })
    .unwrap();
    settle(cx, h);
}
pub(crate) fn run(cx: &mut HeadlessAppContext) {
    let server = Server::start();
    let mut detail = f::detail("mission-A");
    detail["decisions"] =
        json!([{"id":"d1","number":1,"audience":"all","text":"Current binding wording 私 👩‍💻"}]);
    detail["decisionProposals"] = json!([]);
    server.reply("/api/missions/mission-A", Reply::json(200, detail));
    let private = std::env::temp_dir().join(format!("decisions-root-{}", uuid::Uuid::new_v4()));
    let (writer, updates) = Interaction::start(server.options.clone(), Ok(private.clone()));
    let drain = updates.clone();
    let (client, commands) = LocalClient::synthetic_commands();
    let mut reducer = crate::local_model::LiveTranscript::default();
    reducer.apply(&json!({"type":"snapshot","entries":(100..120).map(|id|json!({"id":id,"head":id,"kind":"pi.assistant","model":[{"role":"assistant","content":[{"type":"text","text":format!("Reader {id}: Unicode 私 👩‍💻. {}","Retained synthetic paragraph. ".repeat(20))}]}]})).collect::<Vec<_>>()}));
    let rows = reducer.rows();
    let (h, view) = cx.update(|cx| gpui_kit::open_window(WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(Bounds::new(Default::default(), size(px(1100.), px(840.))))),
        show:false, focus:false, ..Default::default()
    }, cx, |w,cx| cx.new(|cx| {
        let mut v=LocalViewer::build(Some(client),Some(writer.clone()),w,cx);
        v.missions.update(cx,|b,_| b.options(server.options.clone()));
        v.state.projects=Arc::new(crate::local_model::projects(&json!([{"id":"project-A","name":"Synthetic project","path":"/synthetic/A"}])).unwrap());
        v.state.projects_loaded=true;v.state.list_loaded=true;v.state.loaded=true;v.state.status="Synthetic Decisions shell".into();
        v.state.chats=Arc::new(vec![crate::local_model::chat(&json!({"id":"chat-A","title":"Retained chat","projectId":"project-A","mode":"ask","state":"idle"})).unwrap()]);
        v.selected=Some("chat-A".into());v.generation=1;v.state.generation=1;
        v.transcript.update(cx,|t,cx| t.replace_readonly(rows.clone(),true,cx));
        v.editor.update(cx,|e,cx| e.select("chat:chat-A".into(),true,false,w,cx));
        v.rebuild_nav(w,cx);v.listen_writes(updates,w,cx);v
    }))).unwrap();
    until(cx, h, |cx| view.read(cx).editor.read(cx).ready());
    cx.update_window(h, |_, w, cx| {
        let input = view.read(cx).editor.read(cx).shell_probe().0;
        input.update(cx, |i, cx| {
            i.focus(w, cx);
            i.replace_text_in_range(None, "Retained chat draft 私 👩‍💻", w, cx);
            i.replace_and_mark_text_in_range(None, "に", Some(1..1), w, cx);
        });
        w.press("secondary-3", cx);
        assert_eq!(
            view.read(cx).page,
            Page::Chat,
            "marked chat input fences navigation"
        );
        input.update(cx, |i, cx| i.unmark_text(w, cx));
    })
    .unwrap();
    settle(cx, h);
    let (editor, transcript, draft) = cx.update(|cx| {
        let v = view.read(cx);
        (
            v.editor.clone(),
            v.transcript.clone(),
            v.editor
                .read(cx)
                .shell_probe()
                .0
                .read(cx)
                .value()
                .to_string(),
        )
    });
    until(cx, h, |cx| editor.read(cx).saved_probe(cx));
    for _ in 0..3 {
        cx.update_window(h, |_, w, cx| {
            w.scroll(
                "viewport",
                ScrollDelta::Pixels(point(px(0.), px(100_000.))),
                cx,
            )
        })
        .unwrap();
        settle(cx, h);
    }
    let (row_id, selected, range, anchor) = cx
        .update_window(h, |_, w, cx| {
            let viewport = w.find("viewport").bounds();
            let (id, text, bounds) = rows
                .iter()
                .map(Message::id)
                .find_map(|id| {
                    w.try_find(("copy-source", id))?;
                    let text = transcript.read(cx).history_probe_row(id);
                    let bounds = text.read(cx).bounds();
                    (bounds.size.width > px(240.)
                        && bounds.bottom() > viewport.top() + px(24.)
                        && bounds.top() + px(12.) < viewport.bottom())
                    .then_some((id, text, bounds))
                })
                .unwrap();
            let y = bounds.top().max(viewport.top()) + px(8.);
            w.drag(
                point(bounds.left() + px(2.), y),
                point(bounds.left() + px(170.), y),
                cx,
            );
            let range = text.read(cx).selected_source_range().unwrap();
            (
                id,
                text,
                range,
                transcript.read(cx).history_probe_anchor(cx),
            )
        })
        .unwrap();
    assert!(!anchor.2);
    cx.update_window(h, |_, w, cx| w.press("secondary-3", cx))
        .unwrap();
    until(cx, h, |cx| {
        view.read(cx).missions.read(cx).catalog.is_some() && !view.read(cx).missions.read(cx).busy
    });
    activate(cx, h, format!("mission-row-{}", f::key("mission-A").tag()));
    until(cx, h, |cx| {
        view.read(cx).missions.read(cx).detail.is_some() && !view.read(cx).missions.read(cx).busy
    });
    activate(cx, h, "mission-decisions-open".into());
    activate(cx, h, "decisions-toggle-current-d1".into());
    cx.update_window(h, |_, w, cx| {
        assert!(w.try_find("decisions-text-d1").is_some());
        let v = view.read(cx);
        assert_eq!(v.editor, editor);
        assert_eq!(v.transcript, transcript);
        assert_eq!(
            editor.read(cx).shell_probe().0.read(cx).value().as_ref(),
            draft
        );
        assert_eq!(
            selected.read(cx).selected_source_range(),
            Some(range.clone())
        );
        w.press("secondary-[", cx);
        w.press("secondary-[", cx);
    })
    .unwrap();
    settle(cx, h);
    cx.update(|cx| {
        assert_eq!(view.read(cx).page, Page::Chat);
        assert_eq!(transcript.read(cx).history_probe_row(row_id), selected);
        assert_eq!(selected.read(cx).selected_source_range(), Some(range));
        let after = transcript.read(cx).history_probe_anchor(cx);
        assert_eq!(after.0, anchor.0);
        assert!((after.1 - anchor.1).abs() <= 1.);
        assert!(!after.2);
        assert_eq!(
            editor.read(cx).shell_probe().0.read(cx).value().as_ref(),
            draft
        );
    });
    assert!(commands.try_recv().is_err());
    assert!(server.all_gets());
    cx.update_window(h, |_, w, cx| {
        view.update(cx, |v, _| v.writes = None);
        w.remove_window();
    })
    .unwrap();
    drop(view);
    drop(editor);
    drop(transcript);
    drop(selected);
    cx.run_until_parked();
    assert!(writer.command(WriteCommand::Close));
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            tokio::time::timeout(Duration::from_secs(3), async {
                let mut flushed = false;
                while let Ok(s) = drain.recv().await {
                    flushed |= s.flushed;
                }
                assert!(flushed);
            })
            .await
            .unwrap();
        });
    let store = Store::open(private.clone(), server.options.host()).unwrap();
    assert_eq!(store.book.drafts["chat:chat-A"].text, draft);
    assert!(store.book.pending.is_empty());
    drop(store);
    std::fs::remove_dir_all(private).unwrap();
    println!(
        "PASS Decisions production shell: retained editor/transcript identity, Unicode draft/preedit, genuine selection/scroll anchor, private flush, GET-only"
    );
}
