//! Real popup/root input, focus, races and late ACK. Owned faux loopback only.
use super::*;
use crate::queued_message_fixture::Server;
use gpui_kit::{
    AnyWindowHandle, Bounds, HeadlessAppContext, Pixels, WindowBounds, WindowOptions, size,
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
    cx.update_window(h, |_, w, cx| {
        if let Some(row) = id
            .strip_prefix("composer-queue-edit-")
            .or_else(|| id.strip_prefix("composer-queue-delete-"))
        {
            w.hover(SharedString::from(format!("composer-queue-row-{row}")), cx);
        }
        w.click(id, cx);
    })
    .unwrap();
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
fn painted(image: &image::RgbaImage, bounds: Bounds<Pixels>, width: f32) -> bool {
    let scale = image.width() as f32 / width;
    let x0 = (f32::from(bounds.left()) * scale) as u32;
    let y0 = (f32::from(bounds.top()) * scale) as u32;
    let background = image.get_pixel(x0, y0);
    (y0..(f32::from(bounds.bottom()) * scale) as u32).any(|y| {
        (x0..(f32::from(bounds.right()) * scale) as u32)
            .any(|x| image.get_pixel(x, y) != background)
    })
}
fn row_action_bounds(cx: &mut HeadlessAppContext, h: AnyWindowHandle) -> [Bounds<Pixels>; 3] {
    cx.update_window(h, |_, w, _| {
        [
            w.find("composer-queue-edit-42").bounds(),
            w.find("composer-queue-delete-42").bounds(),
            w.find("composer-queue-edit-43").bounds(),
        ]
    })
    .unwrap()
}
fn tray_layout(
    cx: &mut HeadlessAppContext,
    h: AnyWindowHandle,
    view: &Entity<LocalViewer>,
    width: f32,
    dark: bool,
    captures: Option<&std::path::Path>,
) {
    let original = cx.update(|cx| view.read(cx).state.user_queue.clone());
    let original_rows = cx.update(|cx| view.read(cx).sending_view.queued.clone());
    let mut empty_height = px(0.);
    for count in [0, 1, 2, 8] {
        let items: Vec<_> = (0..count)
            .map(|i| {
                json!({
                    "id":42+i,"mode":if i%2==0 {"followUp"} else {"steer"},
                    "content":if count == 1 { "Short preview".to_owned() } else { format!("Message {i}: 日本語 👩‍💻 {}", "long preview ".repeat(80)) },
                    "guardToken":"a".repeat(64)
                })
            })
            .collect();
        cx.update(|cx| {
            view.update(cx, |v, cx| {
                let mut model = crate::local_model::LiveTranscript::default();
                model.apply(&json!({"type":"queue_update","items":items,"automatic":[]}));
                v.state.user_queue = model.user_queue.clone();
                v.with_sending(model.rows(), &model.user_queue, cx);
                cx.notify();
            })
        });
        settle(cx, h);
        cx.update_window(h, |_, w, cx| {
            let tray = w.find("composer-tray").bounds();
            let input = w.find("composer-input").bounds();
            let header = w.find("chat-header").bounds();
            assert!(
                view.read(cx)
                    .transcript
                    .read(cx)
                    .rows()
                    .iter()
                    .all(|r| crate::local_model::queued_submission(r).is_none())
            );
            if count == 0 {
                assert!(w.try_find("composer-queue").is_none());
                assert!(w.try_find("queued-message-open").is_none());
                empty_height = tray.size.height;
                assert!(
                    input.top() - tray.top() < px(8.),
                    "empty queue leaves no spacer"
                );
            } else {
                let queue = w.find("composer-queue").bounds();
                let list = w.find("composer-queue-rows").bounds();
                assert!(
                    w.try_find("queued-message-open").is_none(),
                    "no Manage queue control"
                );
                assert!(tray.contains(&queue.origin) && tray.contains(&queue.bottom_right()));
                assert!(
                    queue.bottom() < input.top(),
                    "queue above editor at {width}/{dark}"
                );
                assert!(input.top() - queue.bottom() <= px(8.));
                let edit = w.find("composer-queue-edit-42").bounds();
                let delete = w.find("composer-queue-delete-42").bounds();
                let row = w.find("composer-queue-row-42").bounds();
                assert!(edit.right() <= delete.left());
                assert!(row.contains(&delete.center()) && row.contains(&edit.center()));
                assert!(edit.left() >= row.center().x, "row actions on the right");
                assert!(!header.intersects(&edit));
                let mode = w.find(("queue-pending", 42u64)).bounds();
                let preview = w.find(("queue-preview", 42u64)).bounds();
                assert!(
                    mode.left() >= input.left() + px(8.) && mode.left() <= input.left() + px(12.),
                    "queue icon shares editor text inset: {mode:?}/{input:?}"
                );
                assert!(
                    preview.left() - mode.right() >= px(6.),
                    "readable icon/text gap"
                );
                assert!(
                    row.top() - tray.top() >= px(8.),
                    "breathing room above first row"
                );
                assert!(
                    tray.right() - delete.right() >= px(8.),
                    "actions inset from tray edge"
                );
                assert!(list.size.height <= px(140.));
                assert!(tray.size.height > empty_height);
                let first = w.find("composer-queue-42").bounds();
                assert!(list.contains(&first.center()));
                if count > 1 {
                    assert!(
                        w.find("composer-queue-43").bounds().top() < first.top(),
                        "steering precedes follow-up"
                    );
                }
                if count == 8 {
                    let last = w.find("composer-queue-48").bounds();
                    let ids = [43, 45, 47, 49, 42, 44, 46, 48];
                    for pair in ids.windows(2) {
                        assert!(
                            w.find(SharedString::from(format!("composer-queue-{}", pair[0])))
                                .bounds()
                                .top()
                                < w.find(SharedString::from(format!("composer-queue-{}", pair[1])))
                                    .bounds()
                                    .top(),
                            "stable within-mode order"
                        );
                    }
                    assert!(
                        last.bottom() > list.bottom(),
                        "extra rows scroll, not disappear"
                    );
                }
                assert!(
                    view.read(cx).queue_open.is_none(),
                    "layout must not open an editor"
                );
            }
        })
        .unwrap();
        if count == 2 {
            let bounds = row_action_bounds(cx, h);
            let hidden = cx.capture_screenshot(h).unwrap();
            assert!(
                bounds.iter().all(|b| !painted(&hidden, *b, width)),
                "row actions hidden at rest"
            );
            cx.update_window(h, |_, w, cx| w.hover("composer-queue-row-42", cx))
                .unwrap();
            settle(cx, h);
            let hovered = cx.capture_screenshot(h).unwrap();
            assert!(
                painted(&hovered, bounds[0], width) && painted(&hovered, bounds[1], width),
                "hover reveals both row actions"
            );
            assert!(
                !painted(&hovered, bounds[2], width),
                "other rows stay quiet"
            );
            assert_eq!(row_action_bounds(cx, h), bounds, "hover does not reflow");
            if let Some(dir) = captures {
                hovered
                    .save(dir.join(format!("tray-hover-{width}-{dark}.png")))
                    .unwrap();
            }
            cx.update_window(h, |_, w, cx| w.hover("chat-header", cx))
                .unwrap();
            settle(cx, h);
        }
        if let Some(dir) = captures {
            cx.capture_screenshot(h)
                .unwrap()
                .save(dir.join(format!("tray-{width}-{dark}-{count}.png")))
                .unwrap();
        }
    }
    cx.update(|cx| {
        view.update(cx, |v, cx| {
            v.state.user_queue = original;
            v.sending_view.queued = original_rows;
            cx.notify();
        })
    });
    settle(cx, h);
}
pub fn run_queued_message_probe(cx: &mut HeadlessAppContext) {
    let reduced_motion = cx.update(|cx| {
        let previous = cx.reduce_motion();
        cx.set_reduce_motion(true);
        previous
    });
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
            let items = json!([
                {"id":42,"mode":"followUp","content":"Original 日本語 🦀","guardToken":"a".repeat(64)},
                {"id":43,"mode":"steer","content":[{"type":"text","text":"With image"},{"type":"image","data":"preserved"}],"guardToken":"b".repeat(64)}
            ]);
            let mut model = crate::local_model::LiveTranscript::default();
            model.apply(&json!({"type":"queue_update","items":items,"automatic":[]}));
            v.state.user_queue = model.user_queue.clone();
            v.with_sending(model.rows(), &model.user_queue, cx);
            v.transcript.update(cx, |t, cx| t.replace_readonly(vec![crate::model::Message::live(
                1, "assistant".into(),
                "Underlying chat: WWW MMM ### 0123456789 high contrast text. ".repeat(120),
            )], true, cx));
            v
        }))).unwrap();
            settle(cx, h);
            tray_layout(cx, h, &view, width, dark, captures.as_deref());
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
            click(cx, h, "composer-queue-edit-42");
            assert!(
                cx.update(|cx| view.read(cx).queue_open.is_none()),
                "composer preedit before pointer blur must block entry"
            );
            click(cx, h, "composer-queue-delete-42");
            assert!(cx.update(|cx| view.read(cx).queue_open.is_none()));
            cx.update_window(h, |_, w, cx| {
                let r = input
                    .update(cx, |i, cx| i.marked_text_range(w, cx))
                    .unwrap();
                input.update(cx, |i, cx| i.replace_text_in_range(Some(r), "", w, cx));
            })
            .unwrap();
            settle(cx, h);
            let main = cx.update(|cx| input.read(cx).value().to_string());
            click(cx, h, "composer-queue-delete-43");
            cx.advance_clock(Duration::from_millis(300));
            settle(cx, h);
            let remove_form = cx.update(|cx| view.read(cx).queue_open.clone().unwrap());
            assert_eq!(cx.update(|cx| remove_form.read(cx).selected), Some(43));
            assert!(cx.update(|cx| remove_form.read(cx).drafts[&43].confirm_remove));
            assert!(
                server.writes.lock().unwrap().is_empty(),
                "row Delete only opens confirmation"
            );
            click(cx, h, "queued-message-close");
            click(cx, h, "composer-queue-delete-43");
            assert!(
                server.writes.lock().unwrap().is_empty(),
                "reopening Delete cannot reuse confirmation to dispatch"
            );
            click(cx, h, "queued-message-close");
            // Native Kit row actions remain reachable without the pointer.
            cx.update_window(h, |_, w, cx| {
                w.activate_window();
                w.hover("chat-header", cx);
            })
            .unwrap();
            let mut reached = false;
            for _ in 0..80 {
                reached = cx
                    .update_window(h, |_, w, _| {
                        w.find("composer-queue-edit-42").focused() == Some(true)
                    })
                    .unwrap();
                if reached {
                    break;
                }
                cx.update_window(h, |_, w, cx| w.press("tab", cx)).unwrap();
                settle(cx, h);
            }
            assert!(reached, "Tab reaches row Edit");
            let bounds = row_action_bounds(cx, h);
            let focused = cx.capture_screenshot(h).unwrap();
            assert!(
                painted(&focused, bounds[0], width) && painted(&focused, bounds[1], width),
                "keyboard focus reveals sibling actions"
            );
            assert!(
                !painted(&focused, bounds[2], width),
                "other rows remain hidden with keyboard focus"
            );
            cx.update_window(h, |_, w, cx| w.press("space", cx))
                .unwrap();
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
            assert_eq!(
                cx.update(|cx| form.read(cx).selected),
                Some(42),
                "tray preview selects exact row"
            );
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
            click(cx, h, "queued-message-copy");
            cx.update(|cx| {
                assert_eq!(
                    cx.read_from_clipboard().unwrap().text().unwrap(),
                    "Edited 日本語 🦀"
                )
            });
            let snapshot = cx.update(|cx| view.read(cx).state.user_queue.clone());
            cx.update(|cx| {
                view.update(cx, |v, cx| {
                    v.state.user_queue = Arc::new(Snapshot {
                        rows: v
                            .state
                            .user_queue
                            .rows
                            .iter()
                            .filter(|r| r.id == 43)
                            .cloned()
                            .collect(),
                        unavailable: false,
                    });
                    v.sync_queue(cx);
                })
            });
            settle(cx, h);
            // Removing Manage queue must not strand an older draft while another message waits.
            click(cx, h, "queued-message-row-43");
            click(cx, h, "queued-message-row-42");
            assert_eq!(
                cx.update(|cx| form.read(cx).drafts[&42].input.clone()),
                edit
            );
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
            click(cx, h, "composer-queue-edit-42");
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
            assert_eq!(
                cx.update(|cx| form.read(cx).drafts[&43].input.read(cx).value().to_string()),
                "With image\n\n[1 image attached]"
            );
            click(cx, h, "queued-message-copy");
            cx.update(|cx| {
                assert_eq!(
                    cx.read_from_clipboard().unwrap().text().unwrap(),
                    "With image\n\n[1 image attached]"
                )
            });
            click(cx, h, "queued-message-save");
            assert_eq!(
                server.writes.lock().unwrap().len(),
                1,
                "structured preview stays read-only"
            );
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
    cx.update(|cx| cx.set_reduce_motion(reduced_motion));
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
