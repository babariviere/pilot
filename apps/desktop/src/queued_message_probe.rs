//! Real root inline queue editing: input, focus, IME, races and late ACK. Owned faux loopback only.
use super::*;
use crate::queued_message_fixture::Server;
use gpui_kit::{
    AnyWindowHandle, Bounds, Focusable, HeadlessAppContext, Pixels, WindowBounds, WindowOptions,
    size, test::TestWindowExt,
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
                    editing(view, cx).is_none(),
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
fn publish(
    cx: &mut HeadlessAppContext,
    h: AnyWindowHandle,
    view: &Entity<LocalViewer>,
    items: serde_json::Value,
) {
    cx.update(|cx| {
        view.update(cx, |v, cx| {
            let mut model = crate::local_model::LiveTranscript::default();
            model.apply(&json!({"type":"queue_update","items":items,"automatic":[]}));
            v.state.user_queue = model.user_queue.clone();
            v.with_sending(model.rows(), &model.user_queue, cx);
            v.sync_queue(cx);
            cx.notify();
        })
    });
    settle(cx, h);
}
fn root(
    cx: &mut HeadlessAppContext,
    server: &Server,
    width: f32,
    items: serde_json::Value,
) -> (
    AnyWindowHandle,
    Entity<LocalViewer>,
    async_channel::Receiver<crate::interaction::WriteCommand>,
    async_channel::Receiver<crate::local_client::Command>,
) {
    let (writer, writes) = Interaction::recording();
    let (client, commands) = LocalClient::synthetic_commands();
    let options = server.options();
    let (h, view) = cx
        .update(|cx| {
            gpui_kit::open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                        Default::default(),
                        size(px(width), px(840.)),
                    ))),
                    show: false,
                    focus: false,
                    ..Default::default()
                },
                cx,
                |w, cx| {
                    cx.new(|cx| {
                        let mut v = LocalViewer::preview(PreviewState::Conversation, w, cx);
                        v.client = Some(client);
                        v.usage_options = Some(options);
                        v.editor
                            .update(cx, |e, cx| e.shell_probe_setup(writer, w, cx));
                        // The composer edits the same chat as the queue, as in the app.
                        v.editor.update(cx, |e, cx| {
                            e.select("chat:source".into(), true, false, w, cx)
                        });
                        v.selected = Some("source".into());
                        v.state.chats = Arc::new(vec![crate::local_model::Chat {
                            id: "source".into(),
                            writable: true,
                            ..v.state.chats[0].clone()
                        }]);
                        v.transcript.update(cx, |t, cx| {
                            t.replace_readonly(
                                vec![crate::model::Message::live(
                                    1,
                                    "assistant".into(),
                                    "Underlying chat: WWW MMM ### 0123456789 high contrast text. "
                                        .repeat(120),
                                )],
                                true,
                                cx,
                            )
                        });
                        v
                    })
                },
            )
        })
        .unwrap();
    settle(cx, h);
    publish(cx, h, &view, items);
    (h, view, writes, commands)
}
fn row(id: u64, mode: &str, content: &str, token: char) -> serde_json::Value {
    json!({"id":id,"mode":mode,"content":content,"guardToken":token.to_string().repeat(64)})
}
/// Probe-only accessors, so the behavior checks do not depend on layout.
fn form(view: &Entity<LocalViewer>, cx: &App) -> Entity<Form> {
    view.read(cx).queue_form(cx).expect("queue form")
}
fn editing(view: &Entity<LocalViewer>, cx: &App) -> Option<u64> {
    view.read(cx)
        .queue_form(cx)
        .and_then(|f| f.read(cx).editing)
}
fn queue_input(
    view: &Entity<LocalViewer>,
    id: u64,
    cx: &App,
) -> Entity<gpui_kit::component::input::TextareaState> {
    form(view, cx).read(cx).drafts[&id].input.clone()
}
fn queue_outcome(view: &Entity<LocalViewer>, id: u64, cx: &App) -> Option<Outcome> {
    let f = view.read(cx).queue_form(cx)?;
    f.read(cx).drafts.get(&id)?.outcome().cloned()
}
fn set_queue_text(
    cx: &mut HeadlessAppContext,
    h: AnyWindowHandle,
    view: &Entity<LocalViewer>,
    id: u64,
    text: &str,
) {
    let input = cx.update(|cx| queue_input(view, id, cx));
    cx.update_window(h, |_, w, cx| {
        input.update(cx, |i, cx| i.set_value(text.to_owned(), w, cx))
    })
    .unwrap();
    settle(cx, h);
}
fn focused_on(
    cx: &mut HeadlessAppContext,
    h: AnyWindowHandle,
    input: &Entity<gpui_kit::component::input::TextareaState>,
) -> bool {
    cx.update_window(h, |_, w, cx| {
        w.focused(cx) == Some(input.read(cx).focus_handle(cx))
    })
    .unwrap()
}
fn exists(
    cx: &mut HeadlessAppContext,
    h: AnyWindowHandle,
    id: impl Into<gpui_kit::ElementId>,
) -> bool {
    let id = id.into();
    cx.update_window(h, |_, w, _| w.try_find(id).is_some())
        .unwrap()
}
#[track_caller]
fn wait_writes(cx: &mut HeadlessAppContext, h: AnyWindowHandle, server: &Server, n: usize) {
    let end = Instant::now() + Duration::from_secs(3);
    while server.writes.lock().unwrap().len() < n && Instant::now() < end {
        settle(cx, h);
        std::thread::yield_now();
    }
    settle(cx, h);
}
/// Reported regression: removing a row after its own acknowledged edit must use
/// the current capture, once, with its guard.
fn removal_after_edit(cx: &mut HeadlessAppContext) {
    let server = Server::new();
    let (h, view, _, _) = root(
        cx,
        &server,
        680.,
        json!([row(42, "followUp", "Original", 'a')]),
    );
    click(cx, h, "composer-queue-edit-42");
    set_queue_text(cx, h, &view, 42, "Edited once");
    click(cx, h, "queued-message-save");
    until(cx, h, |cx| {
        matches!(queue_outcome(&view, 42, cx), Some(Outcome::Acknowledged))
    });
    assert_eq!(server.writes.lock().unwrap()[0].0, "PATCH");
    // Local publishes the edited row with its new guard after the ACK.
    publish(
        cx,
        h,
        &view,
        json!([row(42, "followUp", "Edited once", 'c')]),
    );
    click(cx, h, "composer-queue-delete-42");
    click(cx, h, "queued-message-remove");
    wait_writes(cx, h, &server, 2);
    let writes = server.writes.lock().unwrap().clone();
    println!(
        "removal-after-edit: writes={:?} outcome={:?}",
        writes.iter().map(|w| &w.0).collect::<Vec<_>>(),
        cx.update(|cx| queue_outcome(&view, 42, cx))
    );
    assert_eq!(
        writes.len(),
        2,
        "Delete after an acknowledged edit dispatched nothing"
    );
    assert_eq!(writes[1].0, "DELETE");
    assert_eq!(
        writes[1].1["guard"]["token"],
        "c".repeat(64),
        "removal uses the current capture"
    );
    cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
}
/// ACK before republish, external change, rebased unsaved text, refusal and Unknown.
fn removal_races(cx: &mut HeadlessAppContext) {
    // Raced: the ACK lands before Local republishes the row.
    let server = Server::new();
    let (h, view, _, _) = root(
        cx,
        &server,
        680.,
        json!([row(42, "followUp", "Original", 'a')]),
    );
    click(cx, h, "composer-queue-edit-42");
    set_queue_text(cx, h, &view, 42, "Edited once");
    click(cx, h, "queued-message-save");
    until(cx, h, |cx| {
        matches!(queue_outcome(&view, 42, cx), Some(Outcome::Acknowledged))
    });
    assert_eq!(
        cx.update(|cx| editing(&view, cx)),
        None,
        "ACK closes the matching edit"
    );
    click(cx, h, "composer-queue-delete-42");
    assert_eq!(cx.update(|cx| editing(&view, cx)), Some(42));
    assert!(
        exists(cx, h, "queued-message-result"),
        "saved receipt stays visible"
    );
    click(cx, h, "queued-message-remove");
    click(cx, h, "queued-message-remove");
    settle(cx, h);
    assert_eq!(
        server.writes.lock().unwrap().len(),
        1,
        "acknowledged capture is not reused"
    );
    publish(
        cx,
        h,
        &view,
        json!([row(42, "followUp", "Edited once", 'c')]),
    );
    click(cx, h, "queued-message-cancel");
    click(cx, h, "composer-queue-delete-42");
    click(cx, h, "queued-message-remove");
    wait_writes(cx, h, &server, 2);
    assert_eq!(
        server.writes.lock().unwrap()[1].1["guard"]["token"],
        "c".repeat(64)
    );
    cx.update_window(h, |_, w, _| w.remove_window()).unwrap();

    // Another client changes an untouched open row: refuse, then use the new capture.
    let server = Server::new();
    let (h, view, _, _) = root(
        cx,
        &server,
        680.,
        json!([row(42, "followUp", "Original", 'a')]),
    );
    click(cx, h, "composer-queue-edit-42");
    publish(
        cx,
        h,
        &view,
        json!([row(42, "followUp", "Other client", 'd')]),
    );
    click(cx, h, "queued-message-remove");
    click(cx, h, "queued-message-remove");
    settle(cx, h);
    assert!(
        server.writes.lock().unwrap().is_empty(),
        "stale capture never dispatches"
    );
    click(cx, h, "queued-message-cancel");
    click(cx, h, "composer-queue-delete-42");
    click(cx, h, "queued-message-remove");
    wait_writes(cx, h, &server, 1);
    let writes = server.writes.lock().unwrap().clone();
    assert_eq!((writes.len(), writes[0].0.as_str()), (1, "DELETE"));
    assert_eq!(writes[0].1["guard"]["token"], "d".repeat(64));
    cx.update_window(h, |_, w, _| w.remove_window()).unwrap();

    // Unsaved text survives a changed row and is carried onto its new capture.
    let server = Server::new();
    let (h, view, _, _) = root(
        cx,
        &server,
        680.,
        json!([row(42, "followUp", "Original", 'a')]),
    );
    click(cx, h, "composer-queue-edit-42");
    set_queue_text(cx, h, &view, 42, "Mine 日本語");
    click(cx, h, "queued-message-cancel");
    publish(
        cx,
        h,
        &view,
        json!([row(42, "followUp", "Other client", 'e')]),
    );
    assert!(
        exists(cx, h, ("queue-unsaved", 42u64)),
        "unsaved edit is marked on its row"
    );
    click(cx, h, "composer-queue-42");
    cx.update(|cx| {
        let f = form(&view, cx);
        let d = &f.read(cx).drafts[&42];
        assert!(d.rebased && d.row.token == Some("e".repeat(64)));
        assert_eq!(d.input.read(cx).value().as_ref(), "Mine 日本語");
    });
    click(cx, h, "queued-message-save");
    wait_writes(cx, h, &server, 1);
    let writes = server.writes.lock().unwrap().clone();
    assert_eq!(writes[0].1["message"], "Mine 日本語");
    assert_eq!(writes[0].1["guard"]["token"], "e".repeat(64));
    cx.update_window(h, |_, w, _| w.remove_window()).unwrap();

    // Refused before dispatch (no guarded capability): nothing pinned, one later DELETE.
    let server = Server::new();
    server.capable.store(false, Ordering::SeqCst);
    let (h, view, _, _) = root(
        cx,
        &server,
        680.,
        json!([row(42, "followUp", "Original", 'a')]),
    );
    click(cx, h, "composer-queue-delete-42");
    click(cx, h, "queued-message-remove");
    until(cx, h, |cx| {
        matches!(queue_outcome(&view, 42, cx), Some(Outcome::NotSent(_)))
    });
    assert!(server.writes.lock().unwrap().is_empty());
    server.capable.store(true, Ordering::SeqCst);
    click(cx, h, "queued-message-remove");
    click(cx, h, "queued-message-remove");
    wait_writes(cx, h, &server, 1);
    until(cx, h, |cx| {
        matches!(queue_outcome(&view, 42, cx), Some(Outcome::Acknowledged))
    });
    assert_eq!(server.writes.lock().unwrap().len(), 1);
    cx.update_window(h, |_, w, _| w.remove_window()).unwrap();

    // Unknown: retained receipt, no repeat, no restore of its own payload.
    let server = Server::new();
    server.mismatch.store(true, Ordering::SeqCst);
    let (h, view, _, _) = root(
        cx,
        &server,
        680.,
        json!([row(42, "followUp", "Original", 'a')]),
    );
    click(cx, h, "composer-queue-edit-42");
    set_queue_text(cx, h, &view, 42, "Uncertain edit");
    click(cx, h, "queued-message-save");
    until(cx, h, |cx| {
        matches!(queue_outcome(&view, 42, cx), Some(Outcome::Unknown(_)))
    });
    assert_eq!(
        cx.update(|cx| editing(&view, cx)),
        Some(42),
        "Unknown keeps the editor open"
    );
    click(cx, h, "queued-message-save");
    click(cx, h, "queued-message-remove");
    click(cx, h, "queued-message-remove");
    cx.update_window(h, |_, w, cx| w.press("secondary-enter", cx))
        .unwrap();
    settle(cx, h);
    assert!(
        !exists(cx, h, "queued-message-discard"),
        "queued Unknown capture cannot be dropped"
    );
    click(cx, h, "queued-message-cancel");
    click(cx, h, "composer-queue-42");
    assert_eq!(
        cx.update(|cx| queue_input(&view, 42, cx).read(cx).value().to_string()),
        "Uncertain edit"
    );
    assert!(matches!(
        cx.update(|cx| queue_outcome(&view, 42, cx)),
        Some(Outcome::Unknown(_))
    ));
    click(cx, h, "queued-message-copy");
    cx.update(|cx| {
        assert_eq!(
            cx.read_from_clipboard().unwrap().text().unwrap(),
            "Uncertain edit"
        )
    });
    click(cx, h, "queued-message-cancel");
    // A changed row never recaptures an uncertain draft or settles its receipt.
    publish(
        cx,
        h,
        &view,
        json!([row(42, "followUp", "Other client", 'g')]),
    );
    click(cx, h, "composer-queue-42");
    cx.update(|cx| {
        let f = form(&view, cx);
        let d = &f.read(cx).drafts[&42];
        assert_eq!(
            d.row.token,
            Some("a".repeat(64)),
            "uncertain capture is kept"
        );
        assert!(matches!(d.outcome(), Some(Outcome::Unknown(_))));
        assert_eq!(d.input.read(cx).value().as_ref(), "Uncertain edit");
    });
    click(cx, h, "queued-message-remove");
    click(cx, h, "queued-message-remove");
    assert!(
        !exists(cx, h, "queued-message-discard"),
        "queued Unknown capture cannot be dropped"
    );
    click(cx, h, "queued-message-cancel");
    publish(cx, h, &view, json!([]));
    assert!(
        exists(cx, h, "composer-queue-retained-42"),
        "uncertain edit stays visible"
    );
    click(cx, h, "composer-queue-retained-42");
    assert!(
        !exists(cx, h, "queued-message-restore"),
        "submitted payload is not local text"
    );
    assert!(exists(cx, h, "queued-message-result"));
    click(cx, h, "queued-message-discard");
    assert!(cx.update(|cx| form(&view, cx).read(cx).drafts.is_empty()));
    assert_eq!(
        server.writes.lock().unwrap().len(),
        1,
        "Unknown is never replayed"
    );
    cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
    // Intent serial: text typed away and back while pending is a newer intent,
    // so its ACK keeps the editor open with that text.
    let server = Server::new();
    server.release.store(false, Ordering::SeqCst);
    let (h, view, _, _) = root(
        cx,
        &server,
        680.,
        json!([row(42, "followUp", "Original", 'a')]),
    );
    click(cx, h, "composer-queue-edit-42");
    set_queue_text(cx, h, &view, 42, "Sent text");
    click(cx, h, "queued-message-save");
    wait_writes(cx, h, &server, 1);
    let input = cx.update(|cx| queue_input(&view, 42, cx));
    cx.update_window(h, |_, w, cx| {
        input.update(cx, |i, cx| {
            for text in ["Other", "Sent text"] {
                let n = i.value().encode_utf16().count();
                i.replace_text_in_range(Some(0..n), text, w, cx);
            }
        })
    })
    .unwrap();
    settle(cx, h);
    server.release.store(true, Ordering::SeqCst);
    until(cx, h, |cx| {
        matches!(queue_outcome(&view, 42, cx), Some(Outcome::Acknowledged))
    });
    assert_eq!(
        cx.update(|cx| editing(&view, cx)),
        Some(42),
        "a newer intent is not closed by an older ACK"
    );
    assert_eq!(
        cx.update(|cx| input.read(cx).value().to_string()),
        "Sent text"
    );
    publish(cx, h, &view, json!([row(42, "followUp", "Sent text", 'h')]));
    click(cx, h, "queued-message-cancel");
    assert!(cx.update(|cx| form(&view, cx).read(cx).drafts.is_empty()));
    assert_eq!(server.writes.lock().unwrap().len(), 1);
    cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
    println!(
        "queued-message races: ACK-before-republish, external change, rebase, refusal, Unknown, intent serial PASS"
    );
}
/// Inline Save/Close/IME/focus, retained unsaved text and restore at one size/theme.
fn inline(cx: &mut HeadlessAppContext, width: f32, dark: bool, captures: Option<&std::path::Path>) {
    let server = Server::new();
    let (h, view, writes, commands) = root(
        cx,
        &server,
        width,
        json!([
            row(42, "followUp", "Original 日本語 🦀", 'a'),
            {"id":43,"mode":"steer","content":[{"type":"text","text":"With image"},{"type":"image","data":"preserved"}],"guardToken":"b".repeat(64)}
        ]),
    );
    tray_layout(cx, h, &view, width, dark, captures);
    let shot = |cx: &mut HeadlessAppContext, name: &str| {
        if let Some(dir) = captures {
            cx.capture_screenshot(h)
                .unwrap()
                .save(dir.join(format!("{name}-{width}-{dark}.png")))
                .unwrap();
        }
    };
    let input = cx.update(|cx| view.read(cx).editor.read(cx).shell_probe().0);
    // Composer preedit blocks entry before pointer blur.
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
    click(cx, h, "composer-queue-delete-42");
    assert_eq!(
        cx.update(|cx| editing(&view, cx)),
        None,
        "composer preedit blocks entry"
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
    // Keyboard reaches row Edit; Space opens the row inline with focus in its text.
    // Tab in the composer is its path completion, so traversal goes backwards from
    // the composer to the tray above it, as for the other tray disclosures.
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
        cx.update_window(h, |_, w, cx| w.press("shift-tab", cx))
            .unwrap();
        settle(cx, h);
    }
    assert!(reached, "Shift-Tab from the composer reaches row Edit");
    let bounds = row_action_bounds(cx, h);
    let focused = cx.capture_screenshot(h).unwrap();
    assert!(painted(&focused, bounds[0], width) && painted(&focused, bounds[1], width));
    assert!(
        !painted(&focused, bounds[2], width),
        "other rows stay quiet"
    );
    cx.update_window(h, |_, w, cx| w.press("space", cx))
        .unwrap();
    settle(cx, h);
    assert_eq!(cx.update(|cx| editing(&view, cx)), Some(42));
    let edit = cx.update(|cx| queue_input(&view, 42, cx));
    assert!(focused_on(cx, h, &edit), "inline text takes focus");
    cx.update_window(h, |_, w, _| {
        let tray = w.find("composer-tray").bounds();
        let composer = w.find("composer-input").bounds();
        let editor = w.find("queued-message-editor").bounds();
        let text = w.find("queued-message-input").bounds();
        let steer = w.find("composer-queue-43").bounds();
        assert!(tray.contains(&editor.origin) && tray.contains(&editor.bottom_right()));
        assert!(
            editor.bottom() <= composer.top(),
            "editor above the main composer"
        );
        assert!(
            steer.bottom() <= editor.top(),
            "steering stays first while editing"
        );
        assert!(text.size.width > px(200.), "readable text width {width}");
        for id in [
            "queued-message-mode",
            "queued-message-copy",
            "queued-message-remove",
            "queued-message-cancel",
            "queued-message-save",
        ] {
            let b = w.find(id).bounds();
            assert!(
                editor.contains(&b.origin) && editor.contains(&b.bottom_right()),
                "{id} inside editor at {width}"
            );
        }
        let cancel = w.find("queued-message-cancel").bounds();
        let save = w.find("queued-message-save").bounds();
        assert!(
            cancel.right() <= save.left(),
            "Save is the trailing primary action"
        );
        assert!(w.find("composer-queue-rows").bounds().size.height <= px(QUEUE_EDITING_HEIGHT));
    })
    .unwrap();
    shot(cx, "inline");
    // IME inside the inline editor: Escape, ⌘Enter and outside pointer keep composition.
    cx.update_window(h, |_, w, cx| {
        edit.update(cx, |i, cx| {
            i.set_value("Edited 日本語 🦀", w, cx);
            i.replace_and_mark_text_in_range(None, "にほん", Some(3..3), w, cx);
        })
    })
    .unwrap();
    settle(cx, h);
    for key in ["escape", "secondary-enter"] {
        cx.update_window(h, |_, w, cx| w.press(key, cx)).unwrap();
        settle(cx, h);
    }
    click(cx, h, "chat-header");
    click(cx, h, "queued-message-save");
    cx.update_window(h, |_, w, cx| {
        assert!(
            edit.update(cx, |i, cx| i.marked_text_range(w, cx))
                .is_some(),
            "preedit kept"
        );
    })
    .unwrap();
    assert_eq!(cx.update(|cx| editing(&view, cx)), Some(42));
    assert!(server.writes.lock().unwrap().is_empty());
    // Root navigation shortcuts and actions never blur an active composition.
    for key in [
        "secondary-1",
        "secondary-2",
        "secondary-k",
        "secondary-f",
        "tab",
    ] {
        cx.update_window(h, |_, w, cx| w.press(key, cx)).unwrap();
        settle(cx, h);
    }
    cx.update_window(h, |_, w, cx| {
        w.dispatch_action(Box::new(GoHome), cx);
        w.dispatch_action(Box::new(ShowAllChats), cx);
        w.dispatch_action(Box::new(ToggleJump), cx);
        w.dispatch_action(Box::new(crate::transcript_view::FocusComposer), cx);
    })
    .unwrap();
    settle(cx, h);
    // Menu Quit keeps an active composition, like the composer's.
    cx.update_window(h, |_, w, cx| {
        view.update(cx, |v, cx| v.request_menu_quit(w, cx))
    })
    .unwrap();
    settle(cx, h);
    cx.update_window(h, |_, w, cx| {
        let stayed = view.read(cx).page == Page::Chat && view.read(cx).jump.is_none();
        assert!(stayed, "navigation waits for the composition");
        assert!(
            edit.update(cx, |i, cx| i.marked_text_range(w, cx))
                .is_some(),
            "composition survives navigation"
        );
    })
    .unwrap();
    assert!(focused_on(cx, h, &edit), "focus stays in the inline editor");
    assert_eq!(cx.update(|cx| editing(&view, cx)), Some(42));
    shot(cx, "inline-ime");
    cx.update_window(h, |_, w, cx| {
        let r = edit.update(cx, |i, cx| i.marked_text_range(w, cx)).unwrap();
        edit.update(cx, |i, cx| i.replace_text_in_range(Some(r), "", w, cx));
    })
    .unwrap();
    settle(cx, h);
    // Without a composition the same action is not blocked; the draft stays open.
    cx.update_window(h, |_, w, cx| {
        w.dispatch_action(Box::new(crate::transcript_view::FocusComposer), cx)
    })
    .unwrap();
    settle(cx, h);
    assert!(focused_on(cx, h, &input), "unmarked navigation proceeds");
    assert_eq!(cx.update(|cx| editing(&view, cx)), Some(42));
    cx.update_window(h, |_, w, cx| edit.update(cx, |i, cx| i.focus(w, cx)))
        .unwrap();
    settle(cx, h);
    // Escape closes, keeps the edit and returns focus to the composer.
    cx.update_window(h, |_, w, cx| w.press("escape", cx))
        .unwrap();
    settle(cx, h);
    assert_eq!(cx.update(|cx| editing(&view, cx)), None);
    assert!(
        focused_on(cx, h, &input),
        "closing returns focus to the composer"
    );
    assert!(exists(cx, h, ("queue-unsaved", 42u64)));
    shot(cx, "unsaved");
    // Reopen restores the same native draft; switching rows retains it too.
    click(cx, h, "composer-queue-42");
    assert_eq!(cx.update(|cx| queue_input(&view, 42, cx)), edit);
    assert_eq!(
        cx.update(|cx| edit.read(cx).value().to_string()),
        "Edited 日本語 🦀"
    );
    click(cx, h, "composer-queue-43");
    assert_eq!(cx.update(|cx| editing(&view, cx)), Some(43));
    assert!(cx.update(|cx| form(&view, cx).read(cx).drafts[&43].row.text().is_none()));
    click(cx, h, "queued-message-copy");
    cx.update(|cx| {
        assert_eq!(
            cx.read_from_clipboard().unwrap().text().unwrap(),
            "With image\n\n[1 image attached]"
        )
    });
    click(cx, h, "queued-message-save");
    shot(cx, "structured");
    click(cx, h, "composer-queue-42");
    assert_eq!(
        cx.update(|cx| queue_input(&view, 42, cx)),
        edit,
        "switching rows retains the draft"
    );
    assert_eq!(
        server.writes.lock().unwrap().len(),
        0,
        "structured preview stays read-only"
    );
    // Explicit mode choice, ⌘Enter save, and a late ACK that does not steal focus.
    click(cx, h, "queued-message-mode");
    server.release.store(false, Ordering::SeqCst);
    cx.update_window(h, |_, w, cx| {
        edit.update(cx, |i, cx| i.focus(w, cx));
        w.press("secondary-enter", cx);
    })
    .unwrap();
    wait_writes(cx, h, &server, 1);
    {
        let writes = server.writes.lock().unwrap();
        assert_eq!(writes[0].1["message"], "Edited 日本語 🦀");
        assert_eq!(writes[0].1["mode"], "steer", "explicit mode choice is sent");
    }
    assert!(matches!(
        cx.update(|cx| queue_outcome(&view, 42, cx)),
        Some(Outcome::Pending)
    ));
    shot(cx, "pending");
    cx.update_window(h, |_, w, cx| input.update(cx, |i, cx| i.focus(w, cx)))
        .unwrap();
    server.release.store(true, Ordering::SeqCst);
    until(cx, h, |cx| {
        matches!(queue_outcome(&view, 42, cx), Some(Outcome::Acknowledged))
    });
    assert_eq!(
        cx.update(|cx| editing(&view, cx)),
        None,
        "ACK closes the matching edit"
    );
    assert!(
        focused_on(cx, h, &input),
        "late ACK keeps focus where it is"
    );
    assert_eq!(cx.update(|cx| input.read(cx).value().to_string()), main);
    // No replay of the acknowledged capture before Local republishes.
    click(cx, h, "composer-queue-edit-42");
    click(cx, h, "queued-message-save");
    click(cx, h, "queued-message-remove");
    click(cx, h, "queued-message-remove");
    assert_eq!(
        server.writes.lock().unwrap().len(),
        1,
        "no blind replay after ACK"
    );
    click(cx, h, "queued-message-cancel");
    // Saved and untouched drafts leave quietly with their rows.
    publish(cx, h, &view, json!([]));
    assert!(
        !exists(cx, h, "composer-queue"),
        "nothing local remains to show"
    );
    // A consumed row with unsaved local text: Move to composer, never a send.
    publish(
        cx,
        h,
        &view,
        json!([row(44, "followUp", "Restore me", 'f')]),
    );
    click(cx, h, "composer-queue-44");
    set_queue_text(cx, h, &view, 44, "Rescued 日本語 🦀");
    click(cx, h, "queued-message-cancel");
    publish(cx, h, &view, json!([]));
    assert!(exists(cx, h, "composer-queue-retained-44"));
    shot(cx, "retained");
    click(cx, h, "composer-queue-retained-44");
    assert_eq!(cx.update(|cx| editing(&view, cx)), Some(44));
    click(cx, h, "queued-message-restore");
    assert_eq!(
        cx.update(|cx| input.read(cx).value().to_string()),
        main,
        "never overwrites"
    );
    assert!(cx.update(|cx| form(&view, cx).read(cx).drafts[&44].error.is_some()));
    shot(cx, "restore-refused");
    cx.update_window(h, |_, w, cx| {
        input.update(cx, |i, cx| i.set_value("", w, cx))
    })
    .unwrap();
    settle(cx, h);
    click(cx, h, "queued-message-restore");
    assert_eq!(
        cx.update(|cx| input.read(cx).value().to_string()),
        "Rescued 日本語 🦀"
    );
    assert!(
        focused_on(cx, h, &input),
        "restored text is ready in the composer"
    );
    assert!(cx.update(|cx| form(&view, cx).read(cx).drafts.is_empty()));
    assert!(!exists(cx, h, "composer-queue"));
    assert_eq!(server.writes.lock().unwrap().len(), 1);
    assert!(
        writes.is_empty() && commands.is_empty(),
        "queue editing must not send, stop, page or steer the composer"
    );
    cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
}
pub fn run_queued_message_probe(cx: &mut HeadlessAppContext) {
    let reduced_motion = cx.update(|cx| {
        let previous = cx.reduce_motion();
        cx.set_reduce_motion(true);
        previous
    });
    removal_after_edit(cx);
    removal_races(cx);
    crate::local_view::submit_visibility_probe::run(cx);
    capacity(cx);
    let captures = std::env::var_os("PILOT_NEXT_QUEUED_MESSAGE_DIR").map(std::path::PathBuf::from);
    if let Some(p) = &captures {
        std::fs::create_dir_all(p).unwrap();
    }
    for width in [680., 1100.] {
        for dark in [false, true] {
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
            inline(cx, width, dark, captures.as_deref());
        }
    }
    cx.update(|cx| cx.set_reduce_motion(reduced_motion));
    println!(
        "queued-message native: 4 root layouts, inline IME/focus/Close/restore, late ACK and removal races passed"
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
            let rows = Arc::new(Snapshot::read(&json!((1..=20).map(|id| json!({
                "id":id,"mode":"followUp","content":format!("Original {id}"),"guardToken":"a".repeat(64)
            })).collect::<Vec<_>>())));
            for n in 0..20 {
                let id = format!("queue-{n}");
                let mut chat = v.state.chats[0].clone();
                chat.id = id.clone();
                chat.writable = true;
                Arc::make_mut(&mut v.state.chats).push(chat);
                v.selected = Some(id);
                let f = v.ensure_queue_form(w, cx).expect("queue beyond sixteen chats");
                if n == 0 {
                    assert!(v.queue_checkpoint_safe(cx), "an empty form is not user state");
                    f.update(cx, |f, cx| {
                        f.current = true;
                        f.snapshot = rows.clone();
                        f.open(1, false, w, cx);
                    });
                    assert!(!v.queue_checkpoint_safe(cx), "an open editor blocks the checkpoint");
                    f.update(cx, |f, cx| f.dismiss(w, cx));
                    assert!(v.queue_checkpoint_safe(cx), "an untouched draft is pruned");
                }
                f.update(cx, |f, cx| {
                    f.current = true;
                    f.snapshot = rows.clone();
                    for row in &rows.rows {
                        f.open(row.id, false, w, cx);
                        let d = &f.drafts[&row.id];
                        d.input.update(cx, |i, cx| i.set_value(format!("Unsent 日本語 {n} {}", row.id), w, cx));
                    }
                    assert_eq!(f.drafts.len(), 20);
                    let d = f.drafts.get_mut(&1).unwrap();
                    let op = d.state.begin(&f.source, &d.row, Change::Remove).unwrap();
                    if n % 2 == 1 {
                        assert!(d.state.finish(&op, Outcome::Unknown("lost")));
                    }
                    f.open(1, false, w, cx);
                    assert!(f.drafts[&1].state.blocked());
                    f.dismiss(w, cx);
                });
            }
            for (n, (f, _)) in v.queue_forms.iter().enumerate() {
                let f = f.read(cx);
                assert_eq!(f.source.chat, format!("queue-{n}"));
                assert_eq!(f.drafts.len(), 20);
                assert!(f.drafts[&1].state.blocked());
                assert_eq!(f.drafts[&1].input.read(cx).value().as_ref(), format!("Unsent 日本語 {n} 1"));
            }
            assert_eq!(v.queue_forms.len(), 20);
            assert!(
                !v.queue_checkpoint_safe(cx),
                "unsaved, pending and uncertain drafts block the checkpoint"
            );
        });
        w.remove_window();
    })
    .unwrap();
    cx.run_until_parked();
    assert!(server.writes.lock().unwrap().is_empty());
    assert!(commands.is_empty());
    println!("queue forms: twenty chats x twenty unsaved drafts, Pending/Unknown retained PASS");
}
