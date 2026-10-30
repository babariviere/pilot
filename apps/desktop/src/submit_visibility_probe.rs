//! Native submit visibility: real Return in the production root, then a synthetic
//! delivery and Local stream in each order. No Local action or daemon.
use super::*;
use crate::delivery_store::{Draft, Store};
use crate::interaction::{Interaction, WriteCommand, WriteState};
use crate::local_model::LiveTranscript;
use gpui_kit::{
    AnyWindowHandle, Bounds, EntityInputHandler, Focusable, HeadlessAppContext, ScrollDelta,
    WindowBounds, WindowOptions, point, size,
    test::{TestQueryExt, TestWindowExt},
};
use serde_json::{Value, json};

const FIRST: &str = "Ship it 👩‍💻 e\u{301} 日本語";

#[path = "submit_arrival_probe.rs"]
mod arrival;

fn settle(cx: &mut HeadlessAppContext, h: AnyWindowHandle) {
    for _ in 0..4 {
        cx.run_until_parked();
        cx.advance_clock(Duration::from_millis(16));
        cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
    }
}
fn capture(cx: &mut HeadlessAppContext, h: AnyWindowHandle, name: String) {
    if let Some(dir) = std::env::var_os("PILOT_NEXT_SUBMIT_VISIBILITY_DIR") {
        let dir = std::path::PathBuf::from(dir);
        std::fs::create_dir_all(&dir).unwrap();
        cx.capture_screenshot(h)
            .unwrap()
            .save(dir.join(name))
            .unwrap();
    }
}
fn user(id: u64, text: &str) -> Value {
    json!({"id":id,"kind":"pi.user","model":[{"role":"user","content":text}]})
}
fn reply(id: u64) -> Value {
    json!({"id":id,"kind":"pi.assistant","model":[{"role":"assistant","content":[{"type":"text","text":format!("Reply {id}\n\nA paragraph that keeps the conversation tall enough to scroll.")}]}]})
}
struct Probe {
    h: AnyWindowHandle,
    v: Entity<LocalViewer>,
    writes: async_channel::Receiver<WriteCommand>,
    model: LiveTranscript,
    store: Store,
}
impl Probe {
    fn publish(&mut self, cx: &mut HeadlessAppContext, event: Value) {
        self.publish_now(cx, event);
        settle(cx, self.h);
    }
    fn publish_now(&mut self, cx: &mut HeadlessAppContext, event: Value) {
        self.model.apply(&event);
        let rows = self.model.rows();
        let queue = self.model.user_queue.clone();
        let v = self.v.clone();
        cx.update_window(self.h, |_, w, cx| {
            v.update(cx, |v, cx| {
                let generation = v.generation;
                v.accept(
                    Presentation {
                        generation,
                        loaded: true,
                        rows,
                        chats: v.state.chats.clone(),
                        // As the Local reader: one snapshot per queue update.
                        user_queue: queue,
                        ..Default::default()
                    },
                    w,
                    cx,
                )
            })
        })
        .unwrap();
    }
    fn write(&mut self, cx: &mut HeadlessAppContext, handled: Option<u64>) {
        self.write_now(cx, handled);
        settle(cx, self.h);
    }
    fn write_now(&mut self, cx: &mut HeadlessAppContext, handled: Option<u64>) {
        let mut state = WriteState {
            book: Some(Arc::new(self.store.book.clone())),
            ..Default::default()
        };
        if let Some(request) = handled {
            state.handled.insert("chat:synthetic".into(), request);
        }
        let v = self.v.clone();
        cx.update_window(self.h, |_, w, cx| {
            let editor = v.read(cx).editor.clone();
            editor.update(cx, |e, cx| e.accept(state, w, cx));
        })
        .unwrap();
        cx.run_until_parked();
    }
    /// Real typing and Return in the production composer.
    fn send(&mut self, cx: &mut HeadlessAppContext, text: &str) -> (Draft, u64) {
        let sent = self.send_now(cx, text);
        settle(cx, self.h);
        sent
    }
    fn send_now(&mut self, cx: &mut HeadlessAppContext, text: &str) -> (Draft, u64) {
        let input = cx.update(|cx| self.v.read(cx).editor.read(cx).shell_probe().0);
        cx.update_window(self.h, |_, w, cx| {
            input.update(cx, |i, cx| {
                i.focus(w, cx);
                i.replace_text_in_range(None, text, w, cx);
            });
            w.render_frame(cx);
            w.press("enter", cx);
        })
        .unwrap();
        cx.run_until_parked();
        // Autosave retirement of the previous empty draft is not a send.
        let mut command = self.writes.try_recv();
        while matches!(command, Ok(WriteCommand::RetireEmpty { .. })) {
            command = self.writes.try_recv();
        }
        let Ok(WriteCommand::Submit {
            draft,
            request,
            stop: false,
            follow_up: false,
            ..
        }) = command
        else {
            panic!("Return must submit one ordinary steer");
        };
        assert_eq!(draft.text, text);
        assert_eq!(
            self.composer(cx),
            "",
            "the composer hands the message to the conversation"
        );
        (*draft, request)
    }
    fn composer(&self, cx: &mut HeadlessAppContext) -> String {
        cx.update(|cx| {
            self.v
                .read(cx)
                .editor
                .read(cx)
                .shell_probe()
                .0
                .read(cx)
                .value()
                .to_string()
        })
    }
    /// Sending, queueing and history never take focus from the composer.
    fn focused(&self, cx: &mut HeadlessAppContext) {
        cx.update_window(self.h, |_, w, cx| {
            let input = self.v.read(cx).editor.read(cx).shell_probe().0;
            assert!(
                input.focus_handle(cx).is_focused(w),
                "the composer keeps focus"
            );
        })
        .unwrap();
    }
    /// Rows with this exact text, and their delivery captions.
    fn shown(&self, cx: &mut HeadlessAppContext, text: &str) -> Vec<Option<&'static str>> {
        cx.update(|cx| {
            let v = self.v.read(cx);
            v.transcript
                .read(cx)
                .rows()
                .iter()
                .chain(v.sending_view.queued.iter())
                .chain(v.sending_view.pending_rows(v.selected.as_deref()))
                .filter(|r| r.source() == text)
                .map(|r| r.pending())
                .collect()
        })
    }
    /// A busy chat's unresolved sends share the queue rows' place above the
    /// editor, so a send never moves from the conversation to the queue. An idle
    /// chat's stay with the user's bubble. Returns the caption's y.
    fn caption(&self, cx: &mut HeadlessAppContext, status: &str) -> f32 {
        self.placed(cx, status, true)
    }
    fn placed(&self, cx: &mut HeadlessAppContext, status: &str, tray: bool) -> f32 {
        cx.update_window(self.h, |_, w, cx| {
            w.render_frame(cx);
            let caption = w.find_by_label(status).bounds();
            let input = w.find("composer-input").bounds();
            if tray {
                let tray = w.find("composer-queue").bounds();
                assert!(
                    tray.contains(&caption.center()),
                    "{status} outside the tray above the editor {tray:?}"
                );
                assert!(tray.bottom() <= input.top(), "{status} must precede editor");
            } else {
                let viewport = w.find("viewport").bounds();
                assert!(
                    viewport.contains(&caption.center()),
                    "{status} outside {viewport:?}"
                );
                assert!(
                    caption.right() > viewport.center().x,
                    "{status} is not with the user's bubble"
                );
            }
            f32::from(caption.center().y)
        })
        .unwrap()
    }
}

pub(crate) fn run(cx: &mut HeadlessAppContext) {
    let reduced_motion = cx.update(|cx| cx.reduce_motion());
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
            scenario(cx, width, if dark { "dark" } else { "light" });
        }
    }
    cx.update(|cx| cx.set_reduce_motion(reduced_motion));
}

fn scenario(cx: &mut HeadlessAppContext, width: f32, mode: &str) {
    // Static delivery/identity assertions sample final placement. Timed arrival
    // phases below use the real executor clock separately.
    cx.update(|cx| cx.set_reduce_motion(true));
    let (writer, writes) = Interaction::recording();
    let (client, _reads) = LocalClient::synthetic_commands();
    let (h, v) = cx
        .update(|cx| {
            gpui_kit::open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                        Default::default(),
                        size(px(width), px(760.)),
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
                        v.editor
                            .update(cx, |e, cx| e.shell_probe_setup(writer, w, cx));
                        v.selected = Some("synthetic".into());
                        let mut chat = v.state.chats[0].clone();
                        (chat.id, chat.writable, chat.busy) = ("synthetic".into(), true, true);
                        v.state.chats = Arc::new(vec![chat]);
                        v
                    })
                },
            )
        })
        .unwrap();
    let root = std::env::temp_dir().join(format!("submit-visibility-{}", uuid::Uuid::new_v4()));
    let host = crate::delivery_store::Book::shell_probe().host;
    let mut p = Probe {
        h,
        v,
        writes,
        model: LiveTranscript::default(),
        store: Store::open(root.clone(), host).unwrap(),
    };
    let entries: Vec<Value> = (1..=24)
        .map(|id| {
            if id % 2 == 1 {
                user(id, &format!("Question {id}"))
            } else {
                reply(id)
            }
        })
        .collect();
    p.publish(
        cx,
        json!({"type":"snapshot","entries":entries,"run":{"startedAt":1}}),
    );
    p.publish(cx, json!({"type":"queue_update","items":[],"automatic":[]}));

    // 1. Busy chat: Return shows the message at once, before any acknowledgment.
    let (draft, request) = p.send(cx, FIRST);
    assert_eq!(p.shown(cx, FIRST), [Some("Sending…")]);
    let sending_y = p.caption(cx, "Sending…");
    p.focused(cx);
    capture(cx, h, format!("{}-{mode}-sending.png", width as u32));
    let following = cx.update(|cx| p.v.read(cx).transcript.read(cx).reading_mark(cx).unwrap());
    assert!(following.following, "the user was at the latest message");
    // Local reserves the operation; still one row, still Sending.
    let first = p
        .store
        .prepare("chat:synthetic", &draft, false, false)
        .unwrap()
        .id;
    p.write(cx, None);
    assert_eq!(p.shown(cx, FIRST), [Some("Sending…")]);
    // Delayed consumption: the admitted queue row replaces it, before the ACK.
    p.publish(cx, json!({"type":"queue_update","items":[{"id":42,"mode":"steer","content":FIRST,"guardToken":"a".repeat(64)}]}));
    assert_eq!(p.shown(cx, FIRST), [Some("Queued to steer")]);
    let queued_y = p.caption(cx, "Queued to steer");
    assert!(
        (queued_y - sending_y).abs() <= 2.,
        "its queue row takes the sending row's place"
    );
    p.focused(cx);
    capture(cx, h, format!("{}-{mode}-queued.png", width as u32));
    p.store.finish(&first, "accepted", None).unwrap();
    p.write(cx, Some(request));
    assert_eq!(p.shown(cx, FIRST), [Some("Queued to steer")]);
    assert_eq!(p.composer(cx), "");
    // The queue and history streams race; neither order flickers or duplicates.
    p.publish(cx, json!({"type":"queue_update","items":[]}));
    assert_eq!(p.shown(cx, FIRST), [Some("Queued to steer")]);
    p.publish(cx, json!({"type":"message_end","entry":user(25, FIRST)}));
    assert_eq!(p.shown(cx, FIRST), [None]);
    p.focused(cx);

    // 1b. The ACK can beat the queue update: the message stays visible as Sent
    // (the queue event is held back here) until its queue row replaces it.
    let early = "ACK before queue";
    let (draft, request) = p.send(cx, early);
    let intent = p
        .store
        .prepare("chat:synthetic", &draft, false, false)
        .unwrap()
        .id;
    p.write(cx, None);
    p.store.finish(&intent, "accepted", None).unwrap();
    p.write(cx, Some(request));
    assert_eq!(
        p.shown(cx, early),
        [Some("Sent")],
        "accepted send vanished before its queue row"
    );
    p.caption(cx, "Sent");
    assert_eq!(p.composer(cx), "");
    // Unrelated republication keeps it, and so does an unrelated queue update.
    p.publish(cx, json!({"type":"jobs_update","jobs":[]}));
    assert_eq!(p.shown(cx, early), [Some("Sent")]);
    p.publish(cx, json!({"type":"queue_update","items":[{"id":44,"mode":"followUp","content":"Unrelated","guardToken":"e".repeat(64)}]}));
    assert_eq!(
        p.shown(cx, early),
        [Some("Sent")],
        "an unrelated queue update retired an accepted send"
    );
    p.caption(cx, "Sent");
    // Its own queue row, delayed, replaces it.
    p.publish(cx, json!({"type":"queue_update","items":[{"id":45,"mode":"steer","content":early,"guardToken":"d".repeat(64)}]}));
    assert_eq!(p.shown(cx, early), [Some("Queued to steer")]);
    p.publish(cx, json!({"type":"message_end","entry":user(30, early)}));
    p.publish(cx, json!({"type":"queue_update","items":[]}));
    assert_eq!(p.shown(cx, early), [None]);
    // Once replaced it never returns, even after the row leaves the conversation.
    let mut compacted = entries.clone();
    compacted.push(user(31, "Compacted"));
    p.publish(
        cx,
        json!({"type":"snapshot","entries":compacted,"run":{"startedAt":2}}),
    );
    p.publish(cx, json!({"type":"queue_update","items":[]}));
    assert_eq!(p.shown(cx, early), Vec::<Option<&str>>::new());

    // 2. Lost acknowledgment: uncertain, not Sent, and never duplicated by its echo.
    let second = "Also check the logs";
    let (draft, request) = p.send(cx, second);
    let intent = p
        .store
        .prepare("chat:synthetic", &draft, false, false)
        .unwrap()
        .id;
    p.write(cx, Some(request));
    assert_eq!(p.shown(cx, second), [Some("Not confirmed")]);
    p.caption(cx, "Not confirmed");
    // Reconnect: a fresh reader replays the same history and queue. The Unknown
    // send keeps exactly one row, in place, and no other row is added or lost.
    let counts = |p: &Probe, cx: &mut HeadlessAppContext| {
        cx.update(|cx| {
            let v = p.v.read(cx);
            (
                v.transcript.read(cx).rows().len(),
                v.sending_view.queued.len(),
                v.sending_view.pending_rows(v.selected.as_deref()).len(),
            )
        })
    };
    let before = counts(&p, cx);
    p.model = LiveTranscript::default();
    p.publish(
        cx,
        json!({"type":"snapshot","entries":compacted.clone(),"run":{"startedAt":2}}),
    );
    p.publish(cx, json!({"type":"queue_update","items":[]}));
    assert_eq!(counts(&p, cx), before);
    assert_eq!(p.shown(cx, second), [Some("Not confirmed")]);
    p.caption(cx, "Not confirmed");
    p.focused(cx);
    cx.update_window(h, |_, w, cx| {
        w.render_frame(cx);
        assert_eq!(
            w.find("delivery-recovery-status").label(),
            Some("Couldn't confirm this message was sent.")
        );
    })
    .unwrap();
    p.publish(cx, json!({"type":"queue_update","items":[{"id":43,"mode":"steer","content":second,"guardToken":"b".repeat(64)}]}));
    assert_eq!(p.shown(cx, second), [Some("Queued to steer")]);
    p.store.finish(&intent, "accepted", None).unwrap();
    p.write(cx, None);
    p.publish(cx, json!({"type":"message_end","entry":user(26, second)}));
    p.publish(cx, json!({"type":"queue_update","items":[]}));
    assert_eq!(p.shown(cx, second), [None]);

    // 3. Refusal before reservation returns the exact text to the composer.
    let third = "Refused 🦀";
    let (_, request) = p.send(cx, third);
    assert_eq!(p.shown(cx, third), [Some("Sending…")]);
    p.write(cx, Some(request));
    assert_eq!(p.shown(cx, third), Vec::<Option<&str>>::new());
    assert_eq!(p.composer(cx), third);
    cx.update_window(h, |_, w, cx| {
        let input = p.v.read(cx).editor.read(cx).shell_probe().0;
        input.update(cx, |i, cx| i.set_value("", w, cx));
    })
    .unwrap();
    settle(cx, h);

    // 4. Reading older history: a new queued row never moves the reader.
    // 3b. Stop is not a message: typed text stays in the composer, nothing is added.
    let kept = "Typed, then Stop";
    let before = cx.update(|cx| p.v.read(cx).transcript.read(cx).rows().len());
    cx.update_window(h, |_, w, cx| {
        let input = p.v.read(cx).editor.read(cx).shell_probe().0;
        input.update(cx, |i, cx| i.replace_text_in_range(None, kept, w, cx));
        w.render_frame(cx);
        w.click("local-stop", cx);
    })
    .unwrap();
    settle(cx, h);
    let mut command = p.writes.try_recv();
    while matches!(command, Ok(WriteCommand::RetireEmpty { .. })) {
        command = p.writes.try_recv();
    }
    let Ok(WriteCommand::Submit {
        stop: true,
        request,
        ..
    }) = command
    else {
        panic!("Stop must submit Stop only");
    };
    assert_eq!(p.composer(cx), kept);
    assert_eq!(
        cx.update(|cx| p.v.read(cx).transcript.read(cx).rows().len()),
        before
    );
    p.write(cx, Some(request));
    cx.update_window(h, |_, w, cx| {
        let input = p.v.read(cx).editor.read(cx).shell_probe().0;
        input.update(cx, |i, cx| i.set_value("", w, cx));
    })
    .unwrap();
    settle(cx, h);

    cx.update_window(h, |_, w, cx| {
        w.scroll(
            "viewport",
            ScrollDelta::Pixels(point(px(0.), px(100_000.))),
            cx,
        )
    })
    .unwrap();
    settle(cx, h);
    let reading = cx.update(|cx| p.v.read(cx).transcript.read(cx).reading_mark(cx).unwrap());
    assert!(!reading.following);
    let later = "Queued while reading";
    let (draft, request) = p.send(cx, later);
    let intent = p
        .store
        .prepare("chat:synthetic", &draft, true, false)
        .unwrap()
        .id;
    p.publish(cx, json!({"type":"queue_update","items":[{"id":44,"mode":"followUp","content":later,"guardToken":"c".repeat(64)}]}));
    p.store.finish(&intent, "accepted", None).unwrap();
    p.write(cx, Some(request));
    assert_eq!(p.shown(cx, later), [Some("Queued")]);
    let after = cx.update(|cx| p.v.read(cx).transcript.read(cx).reading_mark(cx).unwrap());
    assert_eq!(after.message, reading.message);
    assert!(!after.following);
    assert!((after.offset - reading.offset).abs() <= 2.);

    // 4b. Idle chat, same words as earlier history: shown at once in the
    // conversation as before, not taken for that older entry, the composer keeps
    // focus, and history is its echo.
    // The reader returns to the latest message first, with the existing control.
    cx.update_window(h, |_, w, cx| {
        w.render_frame(cx);
        w.click("latest", cx);
    })
    .unwrap();
    settle(cx, h);
    let latest = cx.update(|cx| p.v.read(cx).transcript.read(cx).reading_mark(cx).unwrap());
    assert!(latest.following, "Latest returns the reader to the end");
    cx.update(|cx| {
        p.v.update(cx, |v, _| {
            let mut chat = v.state.chats[0].clone();
            chat.busy = false;
            v.state.chats = Arc::new(vec![chat]);
        })
    });
    p.publish(cx, json!({"type":"queue_update","items":[]}));
    // The newest user entry in the compacted history above.
    let again = "Compacted";
    assert_eq!(p.shown(cx, again), [None]);
    let (draft, request) = p.send(cx, again);
    assert_eq!(p.shown(cx, again), [None, Some("Sending…")]);
    cx.update_window(h, |_, w, cx| {
        let id = p.v.read(cx).transcript.read(cx).rows().last().unwrap().id();
        assert!(
            w.try_find(("message-arrival", id)).is_some(),
            "an actual local send owns an arrival slot"
        );
    })
    .unwrap();
    p.placed(cx, "Sending…", false);
    p.focused(cx);
    let intent = p
        .store
        .prepare("chat:synthetic", &draft, false, false)
        .unwrap()
        .id;
    p.write(cx, None);
    p.store.finish(&intent, "accepted", None).unwrap();
    p.write(cx, Some(request));
    assert_eq!(p.shown(cx, again), [None, Some("Sent")]);
    p.placed(cx, "Sent", false);
    p.publish(cx, json!({"type":"message_end","entry":user(40, again)}));
    assert_eq!(p.shown(cx, again), [None, None]);

    arrival::run(cx, &mut p, width, mode);

    // 5. Navigation: another chat never shows this chat's pending input.
    let pending = "Still sending elsewhere";
    p.send(cx, pending);
    assert_eq!(p.shown(cx, pending), [Some("Sending…")]);
    cx.update_window(h, |_, w, cx| {
        p.v.update(cx, |v, cx| {
            v.selected = Some("other".into());
            v.editor.update(cx, |e, cx| {
                e.select("chat:other".into(), true, false, w, cx)
            });
        })
    })
    .unwrap();
    p.model = LiveTranscript::default();
    p.publish(
        cx,
        json!({"type":"snapshot","entries":[user(1, "Other chat")]}),
    );
    assert_eq!(p.shown(cx, pending), Vec::<Option<&str>>::new());
    assert_eq!(p.composer(cx), "");

    cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
    settle_drop(cx);
    let _ = std::fs::remove_dir_all(root);
}

fn settle_drop(cx: &mut HeadlessAppContext) {
    cx.run_until_parked();
}
