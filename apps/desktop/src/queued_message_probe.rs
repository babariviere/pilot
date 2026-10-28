//! Real popup/root input, focus, races and late ACK. Owned faux loopback only.
use super::*;
use crate::queued_message_fixture::Server;
use gpui_kit::{
    AnyWindowHandle, Bounds, HeadlessAppContext, WindowBounds, WindowOptions, size,
    test::TestWindowExt,
};
use serde_json::json;
use std::{sync::atomic::Ordering, time::Instant};
fn settle(cx: &mut HeadlessAppContext, h: AnyWindowHandle) {
    for _ in 0..4 {
        cx.run_until_parked();
        cx.advance_clock(Duration::from_millis(16));
        cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
    }
}
#[track_caller]
fn until(cx: &mut HeadlessAppContext, h: AnyWindowHandle, f: impl Fn(&App) -> bool) {
    let end = Instant::now() + Duration::from_secs(7);
    while !cx.update(|cx| f(cx)) {
        assert!(
            Instant::now() < end,
            "bounded popup timeout at {}",
            std::panic::Location::caller()
        );
        settle(cx, h);
        std::thread::yield_now();
    }
    settle(cx, h);
}
fn click(cx: &mut HeadlessAppContext, h: AnyWindowHandle, id: &'static str) {
    cx.update_window(h, |_, w, cx| w.click(id, cx)).unwrap();
    settle(cx, h);
}
fn assert_opaque(
    cx: &mut HeadlessAppContext,
    h: AnyWindowHandle,
    width: f32,
    dark: bool,
    captures: Option<&std::path::Path>,
    state: &str,
) {
    let (bounds, color) = cx
        .update_window(h, |_, w, cx| {
            let c: gpui_kit::Rgba = cx.theme().popover.into();
            (
                w.find("queued-message-popup").bounds(),
                [c.r, c.g, c.b].map(|v| (v * 255.).round() as u8),
            )
        })
        .unwrap();
    let shot = cx.capture_screenshot(h).unwrap();
    if let Some(dir) = captures {
        shot.save(dir.join(format!("surface-{width}-{dark}-{state}.png")))
            .unwrap();
    }
    let scale = shot.width() as f32 / width;
    // The dialog's content padding is above dense, high-contrast transcript text.
    // Inspect the actual parent surface, not the editor's own opaque background.
    for x in [
        f32::from(bounds.left()) - 8.,
        f32::from(bounds.right()) + 8.,
    ] {
        for dy in 4..60 {
            let pixel = shot
                .get_pixel(
                    (x * scale) as u32,
                    ((f32::from(bounds.top()) + dy as f32) * scale) as u32,
                )
                .0;
            assert_eq!(
                [pixel[0], pixel[1], pixel[2]],
                color,
                "opaque queue {state} padding width={width} dark={dark} y={dy}"
            );
        }
    }
}
pub fn run_queued_message_probe(cx: &mut HeadlessAppContext) {
    crate::local_view::submit_visibility_probe::run(cx);
    capacity(cx);
    let captures = std::env::var_os("PILOT_NEXT_QUEUED_MESSAGE_DIR").map(std::path::PathBuf::from);
    if let Some(p) = &captures {
        std::fs::create_dir_all(p).unwrap();
    }
    for width in [680., 1100.] {
        for dark in [false, true] {
            let server = Server::new();
            server.release.store(false, Ordering::SeqCst);
            cx.update(|cx| {
                crate::appearance::commit_appearance(
                    if dark {
                        crate::settings_state::AppearancePreference::Dark
                    } else {
                        crate::settings_state::AppearancePreference::Light
                    },
                    cx,
                )
            });
            let (writer, writes) = Interaction::recording();
            let (client, commands) = LocalClient::synthetic_commands();
            let (h,view)=cx.update(|cx|gpui_kit::open_window(WindowOptions{window_bounds:Some(WindowBounds::Windowed(Bounds::new(Default::default(),size(px(width),px(840.))))),show:false,focus:false,..Default::default()},cx,|w,cx|cx.new(|cx|{
            let mut v=LocalViewer::preview(PreviewState::Conversation,w,cx);v.client=Some(client);v.usage_options=Some(server.options());
            v.editor.update(cx,|e,cx|e.shell_probe_setup(writer,w,cx));
            v.selected=Some("source".into());v.state.chats=Arc::new(vec![crate::local_model::Chat{id:"source".into(),writable:true,..v.state.chats[0].clone()}]);
            v.state.user_queue=Arc::new(Snapshot::read(&json!([
                {"id":42,"mode":"followUp","content":"Original 日本語 🦀","guardToken":"a".repeat(64)},
                {"id":43,"mode":"steer","content":[{"type":"text","text":"With image"},{"type":"image","data":"preserved"}],"guardToken":"b".repeat(64)}
            ])));
            v.transcript.update(cx, |t, cx| t.replace_readonly(vec![crate::model::Message::live(
                1, "assistant".into(),
                "Underlying chat: WWW MMM ### 0123456789 high contrast text. ".repeat(120),
            )], true, cx));
            v
        }))).unwrap();
            settle(cx, h);
            let input = cx.update(|cx| view.read(cx).editor.read(cx).shell_probe().0);
            cx.update_window(h, |_, w, cx| {
                input.update(cx, |i, cx| {
                    i.focus(w, cx);
                    i.replace_text_in_range(None, "Main draft untouched 🦀", w, cx);
                    i.replace_and_mark_text_in_range(None, "にほん", Some(3..3), w, cx);
                })
            })
            .unwrap();
            settle(cx, h);
            click(cx, h, "queued-message-open");
            assert!(
                cx.update(|cx| view.read(cx).queue_open.is_none()),
                "composer preedit before pointer blur must block entry"
            );
            cx.update_window(h, |_, w, cx| {
                let r = input
                    .update(cx, |i, cx| i.marked_text_range(w, cx))
                    .unwrap();
                input.update(cx, |i, cx| i.replace_text_in_range(Some(r), "", w, cx));
            })
            .unwrap();
            settle(cx, h);
            let main = cx.update(|cx| input.read(cx).value().to_string());
            click(cx, h, "queued-message-open");
            // Root's real dialog entrance must settle before pointer admission.
            // PNG capture previously happened to provide this drain; keep the
            // interaction proof independent of screenshots.
            cx.advance_clock(Duration::from_millis(300));
            settle(cx, h);
            let form = cx.update(|cx| view.read(cx).queue_open.clone().unwrap());
            assert_opaque(cx, h, width, dark, captures.as_deref(), "inspect");
            cx.update_window(h, |_, w, cx| {
                assert!(form.read(cx).current);
                assert!(form.read(cx).visible);
                let row = w.find("queued-message-row-42").bounds();
                let list = w.find("queued-message-list").bounds();
                assert!(list.contains(&row.center()));
            })
            .unwrap();
            click(cx, h, "queued-message-row-42");
            assert!(
                cx.update(|cx| form.read(cx).drafts.contains_key(&42)),
                "native row click did not select exact queued row"
            );
            let edit = cx.update(|cx| form.read(cx).drafts[&42].input.clone());
            cx.update_window(h, |_, w, cx| {
                edit.update(cx, |i, cx| {
                    i.replace_text_in_range(None, "Edited 日本語 🦀", w, cx);
                    i.replace_and_mark_text_in_range(None, "にほん", Some(3..3), w, cx);
                });
            })
            .unwrap();
            settle(cx, h);
            assert_opaque(cx, h, width, dark, captures.as_deref(), "edit");
            click(cx, h, "queued-message-save");
            click(cx, h, "queued-message-close");
            click(cx, h, "queued-message-follow-up");
            cx.update_window(h, |_, w, cx| w.press("secondary-enter", cx))
                .unwrap();
            settle(cx, h);
            assert!(server.writes.lock().unwrap().is_empty());
            assert!(cx.update(|cx| form.read(cx).visible));
            cx.update_window(h, |_, w, cx| {
                assert!(
                    edit.update(cx, |i, cx| i.marked_text_range(w, cx))
                        .is_some(),
                    "internal pointer must not blur preedit"
                );
                let r = edit.update(cx, |i, cx| i.marked_text_range(w, cx)).unwrap();
                edit.update(cx, |i, cx| i.replace_text_in_range(Some(r), "", w, cx));
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                edit.update(cx, |i, cx| {
                    i.focus(w, cx);
                    i.set_value("Edited 日本語 🦀", w, cx);
                });
            })
            .unwrap();
            settle(cx, h);
            let snapshot = cx.update(|cx| view.read(cx).state.user_queue.clone());
            cx.update(|cx| {
                view.update(cx, |v, cx| {
                    v.state.user_queue = Arc::default();
                    v.sync_queue(cx);
                })
            });
            settle(cx, h);
            cx.update_window(h, |_, w, cx| w.press("secondary-enter", cx))
                .unwrap();
            settle(cx, h);
            assert!(server.writes.lock().unwrap().is_empty());
            assert!(cx.update(|cx| form.read(cx).drafts[&42].state.attempt.is_none()));
            assert_eq!(
                cx.update(|cx| edit.read(cx).value().to_string()),
                "Edited 日本語 🦀"
            );
            cx.update(|cx| {
                view.update(cx, |v, cx| {
                    v.state.user_queue = snapshot;
                    v.sync_queue(cx);
                })
            });
            settle(cx, h);
            if let Some(p) = &captures {
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(p.join(format!("queued-{width}-{dark}.png")))
                    .unwrap();
            }
            cx.update_window(h, |_, w, cx| {
                let editor = w.find("queued-message-editor").bounds();
                let popup = w.find("queued-message-popup").bounds();
                assert!(popup.contains(&editor.origin));
                assert!(editor.size.width > px(200.));
                assert!(form.update(cx,|f,cx|!f.marked(w,cx)),"committed popup input unexpectedly retained preedit");
                assert!(form.read(cx).available(42));
                println!("queue submit width={width} dark={dark} editor-focused={} popup-focused={} state={:?}",w.focused(cx)==Some(edit.read(cx).focus_handle(cx)),form.read(cx).focus.contains_focused(w,cx),form.read(cx).drafts[&42].state.attempt.as_ref().map(|(_,o)|o));
                w.press("secondary-enter", cx);
            })
            .unwrap();
            until(cx, h, |cx| {
                if let Some((_, o)) = &form.read(cx).drafts[&42].state.attempt {
                    assert!(
                        matches!(o, Outcome::Pending),
                        "unexpected queue result before wire: {o:?}"
                    );
                }
                !server.writes.lock().unwrap().is_empty()
            });
            assert_eq!(
                server.writes.lock().unwrap()[0].1["message"],
                "Edited 日本語 🦀"
            );
            assert!(
                server.writes.lock().unwrap()[0].1.get("mode").is_none(),
                "default Save must preserve original delivery mode"
            );
            click(cx, h, "queued-message-close");
            assert!(cx.update(|cx| view.read(cx).queue_open.is_none()));
            let focused = cx.update_window(h, |_, w, cx| w.focused(cx)).unwrap();
            server.release.store(true, Ordering::SeqCst);
            until(cx, h, |cx| {
                matches!(
                    form.read(cx).drafts[&42].state.attempt.as_ref(),
                    Some((_, Outcome::Acknowledged))
                )
            });
            cx.update_window(h, |_, w, cx| {
                assert_eq!(w.focused(cx), focused, "late ACK must not steal focus");
                assert!(view.read(cx).queue_open.is_none());
                assert_eq!(input.read(cx).value().as_ref(), main);
            })
            .unwrap();
            click(cx, h, "queued-message-open");
            assert_eq!(
                cx.update(|cx| form.read(cx).drafts[&42].input.read(cx).value().to_string()),
                "Edited 日本語 🦀"
            );
            click(cx, h, "queued-message-save");
            assert_eq!(
                server.writes.lock().unwrap().len(),
                1,
                "no blind replay after ACK"
            );
            click(cx, h, "queued-message-row-43");
            assert!(cx.update(|cx| form.read(cx).drafts[&43].row.text().is_none()));
            // Missing/changed capture retains draft and refuses both operations.
            cx.update(|cx| {
                view.update(cx, |v, cx| {
                    v.state.user_queue = Arc::new(Snapshot::default());
                    v.sync_queue(cx);
                })
            });
            settle(cx, h);
            click(cx, h, "queued-message-remove");
            assert_eq!(server.writes.lock().unwrap().len(), 1);
            click(cx, h, "queued-message-close");
            assert!(
                writes.is_empty() && commands.is_empty(),
                "popup must not send/stop/page or steer the composer"
            );
            cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
        }
    }
    // Explicit removal has a separate confirmation and exact receipt.
    let s = Server::new();
    let (h,form)=cx.update(|cx|gpui_kit::open_window(WindowOptions{show:false,..Default::default()},cx,|w,cx|cx.new(|cx|{
        let mut f=Popup::new(s.options(),Source{home:s.options().host(),chat:"source".into()},cx);f.visible=true;f.current=true;
        f.snapshot=Arc::new(Snapshot::read(&json!([{"id":42,"mode":"followUp","content":"Remove exactly","guardToken":"a".repeat(64)}])));let row=f.snapshot.rows[0].clone();f.select(row,w,cx);f
    }))).unwrap();
    settle(cx, h);
    click(cx, h, "queued-message-remove");
    assert!(s.writes.lock().unwrap().is_empty());
    click(cx, h, "queued-message-remove");
    until(cx, h, |cx| {
        matches!(
            form.read(cx).drafts[&42].state.attempt.as_ref(),
            Some((_, Outcome::Acknowledged))
        )
    });
    assert_eq!(s.writes.lock().unwrap()[0].0, "DELETE");
    cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
    // Capability refusal is pre-dispatch; a mismatched ACK is terminal Unknown.
    let s = Server::new();
    s.capable.store(false, Ordering::SeqCst);
    let (h,form)=cx.update(|cx|gpui_kit::open_window(WindowOptions{show:false,..Default::default()},cx,|w,cx|cx.new(|cx|{
        let mut f=Popup::new(s.options(),Source{home:s.options().host(),chat:"source".into()},cx);f.visible=true;f.current=true;
        f.snapshot=Arc::new(Snapshot::read(&json!([{"id":42,"mode":"followUp","content":"Original","guardToken":"a".repeat(64)}])));let row=f.snapshot.rows[0].clone();f.select(row,w,cx);
        f.drafts[&42].input.update(cx,|i,cx|i.set_value("Retained uncertain edit",w,cx));f
    }))).unwrap();
    settle(cx, h);
    click(cx, h, "queued-message-save");
    until(cx, h, |cx| {
        matches!(
            form.read(cx).drafts[&42].state.attempt.as_ref(),
            Some((_, Outcome::NotSent(_)))
        )
    });
    assert!(s.writes.lock().unwrap().is_empty());
    s.capable.store(true, Ordering::SeqCst);
    s.mismatch.store(true, Ordering::SeqCst);
    click(cx, h, "queued-message-steer");
    click(cx, h, "queued-message-save");
    until(cx, h, |cx| {
        matches!(
            form.read(cx).drafts[&42].state.attempt.as_ref(),
            Some((_, Outcome::Unknown(_)))
        )
    });
    assert_eq!(s.writes.lock().unwrap()[0].1["mode"], "steer");
    click(cx, h, "queued-message-save");
    click(cx, h, "queued-message-remove");
    cx.update_window(h, |_, w, cx| w.press("secondary-enter", cx))
        .unwrap();
    settle(cx, h);
    assert_eq!(s.writes.lock().unwrap().len(), 1);
    assert_eq!(
        cx.update(|cx| form.read(cx).drafts[&42].input.read(cx).value().to_string()),
        "Retained uncertain edit"
    );
    cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
    println!(
        "queued-message native: 4 actual root layouts/IME/capture/late-ACK cases plus confirmed removal/capability/Unknown passed"
    );
}

fn capacity(cx: &mut HeadlessAppContext) {
    let server = Server::new();
    let (client, commands) = LocalClient::synthetic_commands();
    let (h, view) = cx.update(|cx| {
        gpui_kit::open_window(
            WindowOptions {
                show: false,
                ..Default::default()
            },
            cx,
            |w, cx| {
                cx.new(|cx| {
                    let mut v = LocalViewer::preview(PreviewState::Conversation, w, cx);
                    v.client = Some(client);
                    v.usage_options = Some(server.options());
                    v
                })
            },
        )
        .unwrap()
    });
    settle(cx, h);
    cx.update_window(h, |_, w, cx| {
        view.update(cx, |v, cx| {
            let mut retained = Vec::new();
            for n in 0..20 {
                let id = format!("queue-{n}");
                let mut chat = v.state.chats[0].clone();
                chat.id = id.clone(); chat.writable = true;
                Arc::make_mut(&mut v.state.chats).push(chat);
                v.selected = Some(id);
                v.open_queue(w, cx);
                let f = v.queue_open.clone().expect("queue beyond sixteen chats");
                f.update(cx, |f,cx| {
                    f.current = true;
                    let rows = Snapshot::read(&json!((1..=20).map(|id| json!({
                        "id":id,"mode":"followUp","content":format!("Original {id}"),"guardToken":"a".repeat(64)
                    })).collect::<Vec<_>>()));
                    for row in &rows.rows { f.select(row.clone(),w,cx); }
                    assert_eq!(f.drafts.len(), 20);
                    let d = f.drafts.get_mut(&1).unwrap();
                    d.input.update(cx, |i,cx| i.set_value(format!("Unsent 日本語 {n}"),w,cx));
                    let op = d.state.begin(&f.source, &d.row, Change::Remove).unwrap();
                    if n % 2 == 1 { assert!(d.state.finish(&op, Outcome::Unknown("lost"))); }
                    f.select(rows.rows[0].clone(), w, cx);
                    assert_eq!(f.selected, Some(1));
                    assert!(f.drafts[&1].state.blocked());
                    assert_eq!(f.drafts[&1].input.read(cx).value().as_ref(), format!("Unsent 日本語 {n}"));
                });
                f.update(cx, |f,cx| f.close(w,cx));
                w.close_dialog(cx);
                v.queue_open = None;
                retained.push(f);
            }
            for (n,f) in retained.iter().enumerate() {
                v.selected = Some(format!("queue-{n}"));
                v.open_queue(w,cx);
                assert_eq!(v.queue_open.as_ref(), Some(f));
                assert_eq!(f.read(cx).drafts[&1].input.read(cx).value().as_ref(), format!("Unsent 日本語 {n}"));
                assert!(f.read(cx).drafts[&1].state.blocked());
                f.update(cx, |f,cx| f.close(w,cx));
                w.close_dialog(cx);
                v.queue_open = None;
            }
            assert_eq!(v.queue_forms.len(),20);
        });
        w.remove_window();
    }).unwrap();
    cx.run_until_parked();
    assert!(server.writes.lock().unwrap().is_empty());
    assert!(commands.is_empty());
    println!(
        "queue forms: twenty chats x twenty edit drafts, same-target text and Pending/Unknown retained PASS"
    );
}
