//! Native submit visibility: real Return in the production root, then a synthetic
//! delivery and Local stream in each order. No Local action or daemon.
use super::*;
use crate::delivery_store::{Draft, Store};
use crate::interaction::{Interaction, WriteCommand, WriteState};
use crate::local_model::LiveTranscript;
use gpui_kit::{
    AnyWindowHandle, Bounds, EntityInputHandler, HeadlessAppContext, ScrollDelta, WindowBounds,
    WindowOptions, point, size,
    test::{TestQueryExt, TestWindowExt},
};
use serde_json::{Value, json};

const FIRST: &str = "Ship it 👩‍💻 e\u{301} 日本語";

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
        self.model.apply(&event);
        let rows = self.model.rows();
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
                        ..Default::default()
                    },
                    w,
                    cx,
                )
            })
        })
        .unwrap();
        settle(cx, self.h);
    }
    fn write(&mut self, cx: &mut HeadlessAppContext, handled: Option<u64>) {
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
        settle(cx, self.h);
    }
    /// Real typing and Return in the production composer.
    fn send(&mut self, cx: &mut HeadlessAppContext, text: &str) -> (Draft, u64) {
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
        settle(cx, self.h);
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
    /// Rows with this exact text, and their delivery captions.
    fn shown(&self, cx: &mut HeadlessAppContext, text: &str) -> Vec<Option<&'static str>> {
        cx.update(|cx| {
            self.v
                .read(cx)
                .transcript
                .read(cx)
                .rows()
                .iter()
                .filter(|r| r.source() == text)
                .map(|r| r.pending())
                .collect()
        })
    }
    /// The rendered caption sits under a right-aligned bubble inside the viewport.
    fn caption(&self, cx: &mut HeadlessAppContext, status: &str) {
        cx.update_window(self.h, |_, w, cx| {
            w.render_frame(cx);
            let caption = w.find_by_label(status).bounds();
            let viewport = w.find("viewport").bounds();
            assert!(
                viewport.contains(&caption.center()),
                "{status} outside {viewport:?}"
            );
            assert!(
                caption.right() > viewport.center().x,
                "{status} is not with the user's bubble"
            );
        })
        .unwrap();
    }
}

pub(crate) fn run(cx: &mut HeadlessAppContext) {
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
}

fn scenario(cx: &mut HeadlessAppContext, width: f32, mode: &str) {
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
    p.caption(cx, "Sending…");
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
    p.caption(cx, "Queued to steer");
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
