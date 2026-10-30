//! Native awaited ask: a live run waits inside `ask_user`, so its chat reads
//! Working. The production Local root must still admit the reply. Synthetic
//! stream and recording writer only; no Local action or daemon.
use super::*;
use crate::interaction::{Interaction, WriteCommand};
use crate::local_model::LiveTranscript;
use gpui_kit::{
    AnyWindowHandle, Bounds, HeadlessAppContext, WindowBounds, WindowOptions, size,
    test::{TestQueryExt, TestWindowExt},
};
use serde_json::{Value, json};

fn settle(cx: &mut HeadlessAppContext, h: AnyWindowHandle) {
    for _ in 0..4 {
        cx.run_until_parked();
        cx.advance_clock(Duration::from_millis(16));
        cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
    }
}
fn ask(id: u64, multi: bool, blocking: bool) -> Value {
    json!({"id":id,"kind":"pilot.question","model":[],"data":{
        "question":"Which layout should the sidebar use?",
        "options":[{"label":"Threads","suggested":true},{"label":"Flat"},{"label":"State groups"}],
        "multiSelect":multi,"blocking":blocking,
    }})
}
struct Probe {
    h: AnyWindowHandle,
    v: Entity<LocalViewer>,
    writes: async_channel::Receiver<WriteCommand>,
    model: LiveTranscript,
    chats: Arc<Vec<crate::local_model::Chat>>,
}
impl Probe {
    fn open(cx: &mut HeadlessAppContext, width: f32) -> Self {
        let (writer, writes) = Interaction::recording();
        let (client, _reads) = LocalClient::synthetic_commands();
        client.set_synthetic_daemon(crate::local_client::ConnectedDaemon::Connected(None));
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
                            chat.state = "working".into();
                            v.state.chats = Arc::new(vec![chat]);
                            // The fixture seeds a complete control list. Later chat
                            // snapshots must preserve, not manufacture, its freshness.
                            v.state.list_loaded = true;
                            v.state.summary_fresh = true;
                            v
                        })
                    },
                )
            })
            .unwrap();
        let chats = cx.update(|cx| v.read(cx).state.chats.clone());
        Self {
            h,
            v,
            writes,
            model: LiveTranscript::default(),
            chats,
        }
    }
    /// As the Local reader publishes a chat presentation.
    fn publish(&mut self, cx: &mut HeadlessAppContext, event: Value) {
        self.model.apply(&event);
        let (rows, queue) = (self.model.rows(), self.model.user_queue.clone());
        let (question, question_awaited) = (self.model.question(), self.model.question_awaited());
        let v = self.v.clone();
        cx.update_window(self.h, |_, w, cx| {
            v.update(cx, |v, cx| {
                let generation = v.generation;
                v.accept(
                    Presentation {
                        generation,
                        loaded: true,
                        list_loaded: v.state.list_loaded,
                        summary_fresh: v.state.summary_fresh,
                        rows,
                        chats: self.chats.clone(),
                        user_queue: queue,
                        question,
                        question_awaited,
                        ..Default::default()
                    }
                    .for_display(Some("synthetic")),
                    w,
                    cx,
                )
            })
        })
        .unwrap();
        settle(cx, self.h);
    }
    fn reply_disabled(&self, cx: &mut HeadlessAppContext) -> Option<bool> {
        cx.update_window(self.h, |_, w, cx| {
            w.render_frame(cx);
            w.try_find("answer-question")
                .map(|b| b.disabled() == Some(true))
        })
        .unwrap()
    }
    /// The next reply request, skipping routine draft bookkeeping.
    fn answer(&self) -> Option<(String, u64)> {
        while let Ok(command) = self.writes.try_recv() {
            match command {
                WriteCommand::Answer { key, question, .. } => {
                    return Some((key, question.identity.entry));
                }
                WriteCommand::RetireEmpty { .. } => {}
                _ => panic!("Only an explicit reply may be requested"),
            }
        }
        None
    }
    fn close(self, cx: &mut HeadlessAppContext) {
        cx.update_window(self.h, |_, w, _| w.remove_window())
            .unwrap();
        cx.run_until_parked();
    }
}

pub(crate) fn run(cx: &mut HeadlessAppContext) {
    hint_motion(cx);
    // Public summary reasons never invent a grant or a question target. The
    // wrapper remains outside the editor, preserving its retained draft/input.
    for width in [680., 1100.] {
        for mode in [
            gpui_kit::component::ThemeMode::Light,
            gpui_kit::component::ThemeMode::Dark,
        ] {
            cx.update(|cx| gpui_kit::component::Theme::change(mode, None, cx));
            let p = Probe::open(cx, width);
            cx.update_window(p.h, |_, w, cx| {
                p.v.update(cx, |v, cx| {
                    v.state.loaded = true;
                    v.state.summary_fresh = true;
                    v.state.generation = v.generation;
                    v.state.chats = Arc::new(vec![crate::local_model::chat(&json!({"id":"synthetic","state":"idle","outcome":"question"})).unwrap()]);
                    cx.notify();
                });
                w.render_frame(cx);
                let hint = w.find("chat-attention-hint").bounds();
                let editor = w.find("conversation-editor").bounds();
                assert!(hint.left() >= editor.left() && hint.right() <= editor.right());
                assert!(w.try_find("view-pending-question").is_none(), "No exact target, no invented action");
                assert!(w.try_find("question-composer").is_none());
                p.v.update(cx, |v, cx| {
                    v.client.as_ref().unwrap().set_synthetic_daemon(crate::local_client::ConnectedDaemon::NotConnected);
                    cx.notify();
                });
                w.render_frame(cx);
                assert!(w.try_find("chat-attention-hint").is_none(), "Control reconnect hides last-known reason");
                p.v.update(cx, |v, cx| {
                    v.client.as_ref().unwrap().set_synthetic_daemon(crate::local_client::ConnectedDaemon::Connected(None));
                    v.state.summary_fresh = false;
                    cx.notify();
                });
                w.render_frame(cx);
                assert!(w.try_find("chat-attention-hint").is_none(), "Hello alone cannot revive cached attention");
                p.v.update(cx, |v, cx| {
                    v.state.summary_fresh = true;
                    v.state.generation = v.generation.wrapping_add(1);
                    cx.notify();
                });
                w.render_frame(cx);
                assert!(w.try_find("chat-attention-hint").is_none(), "Old stream generation hides");
                p.v.update(cx, |v, cx| { v.state.generation = v.generation; cx.notify(); });
                w.render_frame(cx);
                assert!(w.try_find("chat-attention-hint").is_some(), "Fresh same-chat reason returns");
                p.v.update(cx, |v, cx| { v.state.chat_issue = true; cx.notify(); });
                w.render_frame(cx);
                assert!(w.try_find("chat-attention-hint").is_none(), "Disconnected reason hides");
                p.v.update(cx, |v, cx| {
                    v.state.chat_issue = false;
                    v.state.chats = Arc::new(vec![crate::local_model::chat(&json!({"id":"synthetic","state":"idle","subscriptionPause":{"forced":false}})).unwrap()]);
                    cx.notify();
                });
                w.render_frame(cx);
                assert!(w.try_find("chat-attention-hint").is_none(), "Paused has its own explanation");
                p.v.update(cx, |v, cx| {
                    v.state.chats = Arc::new(vec![crate::local_model::chat(&json!({"id":"synthetic","state":"idle","outcome":"question"})).unwrap()]);
                    v.selected = Some("other".into());
                    cx.notify();
                });
                w.render_frame(cx);
                assert!(w.try_find("chat-attention-hint").is_none(), "Switch never borrows the old reason");
            }).unwrap();
            assert!(p.answer().is_none(), "Reason rendering never sends");
            p.close(cx);
        }
    }
    // A chat-only snapshot cannot revive stale control-list authority.
    let mut stale = Probe::open(cx, 900.);
    cx.update(|cx| stale.v.update(cx, |v, _| v.state.summary_fresh = false));
    stale.publish(
        cx,
        json!({"type":"snapshot","entries":[ask(4,false,true)],"run":{"startedAt":1}}),
    );
    cx.update(|cx| {
        let v = stale.v.read(cx);
        assert!(!v.state.summary_fresh);
        assert_eq!(
            v.state.chats[0].signal,
            Some(crate::state_mark::Signal::Working)
        );
    });
    assert!(stale.answer().is_none());
    stale.close(cx);

    // 1. Single choice: pointer pick, then click Reply while the chat is Working.
    let mut p = Probe::open(cx, 900.);
    p.publish(
        cx,
        json!({"type":"snapshot","entries":[ask(4, false, true)],"run":{"startedAt":1}}),
    );
    p.publish(cx, json!({"type":"queue_update","items":[],"automatic":[]}));
    assert!(p.model.question_awaited());
    cx.update_window(p.h, |_, w, cx| {
        let v = p.v.read(cx);
        let chat = v.state.chats.iter().find(|c| c.id == "synthetic").unwrap();
        assert_eq!(chat.signal, Some(crate::state_mark::Signal::NeedsYou));
        assert_eq!(
            chat.attention.as_ref().unwrap().kind,
            crate::attention::Kind::Question
        );
        assert_eq!(
            crate::state_mark::Mark::of(chat),
            Some(crate::state_mark::Mark::Question)
        );
        assert!(
            chat.busy && chat.state == "working",
            "Stop/admission keeps actual run state"
        );
        assert_eq!(v.editor.read(cx).activity_label(), Some("Needs you"));
        assert_eq!(w.find("question-stop").disabled(), None);
    })
    .unwrap();
    assert_eq!(
        p.reply_disabled(cx),
        Some(true),
        "Reply waits for an answer"
    );
    cx.update_window(p.h, |_, w, cx| {
        let option = w.find_by_label("Threads").bounds();
        let panel = w.find("question-composer").bounds();
        w.click_at(
            "question-composer",
            gpui_kit::point(
                option.center().x - panel.left(),
                option.center().y - panel.top(),
            ),
            cx,
        );
    })
    .unwrap();
    settle(cx, p.h);
    assert!(p.answer().is_none(), "Choosing alone never sends");
    assert_eq!(
        p.reply_disabled(cx),
        Some(false),
        "An awaited ask accepts its reply while its run is Working"
    );
    cx.update_window(p.h, |_, w, cx| w.click("answer-question", cx))
        .unwrap();
    settle(cx, p.h);
    assert_eq!(p.answer(), Some(("chat:synthetic".into(), 4)));
    assert!(p.answer().is_none(), "One click requests one reply");
    p.close(cx);

    // 2. Multiple choice: typed words alone, then Return.
    let mut p = Probe::open(cx, 900.);
    p.publish(
        cx,
        json!({"type":"snapshot","entries":[ask(6, true, true)],"run":{"startedAt":1}}),
    );
    p.publish(cx, json!({"type":"queue_update","items":[],"automatic":[]}));
    cx.update_window(p.h, |_, w, cx| {
        let editor = p.v.read(cx).editor.clone();
        editor.update(cx, |e, cx| e.focus(w, cx));
        w.render_frame(cx);
        w.input("Threads, keep Pinned 日本語 👩‍💻", cx);
    })
    .unwrap();
    settle(cx, p.h);
    assert_eq!(p.reply_disabled(cx), Some(false));
    cx.update_window(p.h, |_, w, cx| w.press("enter", cx))
        .unwrap();
    settle(cx, p.h);
    assert_eq!(p.answer(), Some(("chat:synthetic".into(), 6)));
    p.close(cx);

    // 3. Negative fences: nothing is offered unless the live run awaits the ask.
    let mut p = Probe::open(cx, 900.);
    // A turn-ending ask never presents during a run.
    p.publish(
        cx,
        json!({"type":"snapshot","entries":[ask(4, false, false)],"run":{"startedAt":1}}),
    );
    p.publish(cx, json!({"type":"queue_update","items":[],"automatic":[]}));
    assert_eq!(
        p.reply_disabled(cx),
        None,
        "Legacy ask hidden while Working"
    );
    // The awaited ask's run ended (Stop) but the summary still says Working.
    p.publish(
        cx,
        json!({"type":"snapshot","entries":[ask(6, false, true)]}),
    );
    p.publish(cx, json!({"type":"queue_update","items":[],"automatic":[]}));
    assert!(!p.model.question_awaited());
    assert_eq!(
        p.reply_disabled(cx),
        Some(true),
        "A Working chat whose run no longer awaits the ask refuses replies"
    );
    // A later run never presents the released ask.
    p.publish(cx, json!({"type":"run_start"}));
    assert_eq!(p.reply_disabled(cx), None);
    cx.update_window(p.h, |_, w, _| {
        assert!(w.try_find("question-attention-hint").is_none())
    })
    .unwrap();
    // A queued reply hides the ask, even while its run awaits it.
    p.publish(
        cx,
        json!({"type":"snapshot","entries":[ask(8, false, true)],"run":{"startedAt":1}}),
    );
    p.publish(
        cx,
        json!({"type":"queue_update","items":[{"id":1,"mode":"steer","content":"Threads"}],"automatic":[]}),
    );
    assert_eq!(p.reply_disabled(cx), None, "A queued reply is not repeated");
    assert!(p.answer().is_none(), "No negative case sends");
    p.close(cx);
    println!(
        "awaited question passed: Working reply by click and Return, legacy/released/queued fences"
    );
}

fn hint_motion(cx: &mut HeadlessAppContext) {
    use gpui_kit::{EntityInputHandler, Focusable};
    let frame = |cx: &mut HeadlessAppContext, h, ms| {
        cx.advance_clock(Duration::from_millis(ms));
        cx.update_window(h, |_, w, cx| {
            w.simulate_next_frame(cx);
            w.render_frame(cx);
        })
        .unwrap();
        cx.run_until_parked();
    };
    let height = |cx: &mut HeadlessAppContext, h| {
        cx.update_window(h, |_, w, _| {
            w.try_find("attention-hint-slot")
                .map_or(0., |n| f32::from(n.bounds().size.height))
        })
        .unwrap()
    };
    for width in [680., 1100.] {
        for mode in [
            gpui_kit::component::ThemeMode::Light,
            gpui_kit::component::ThemeMode::Dark,
        ] {
            cx.update(|cx| gpui_kit::component::Theme::change(mode, None, cx));
            let p = Probe::open(cx, width);
            frame(cx, p.h, 0);
            frame(cx, p.h, 240);
            let input = cx.update(|cx| p.v.read(cx).editor.read(cx).shell_probe().0);
            cx.update_window(p.h, |_, w, cx| {
                input.update(cx, |i, cx| {
                    i.set_value("Keep selection 日本語", w, cx);
                    i.focus(w, cx);
                    i.replace_and_mark_text_in_range(None, "にほん", Some(1..2), w, cx);
                });
            })
            .unwrap();
            frame(cx, p.h, 0);
            let saved = cx
                .update_window(p.h, |_, w, cx| {
                    let marked = input.update(cx, |i, cx| i.marked_text_range(w, cx));
                    (
                        input.read(cx).value(),
                        input.read(cx).selected_range(),
                        marked,
                        w.focused(cx),
                    )
                })
                .unwrap();
            let reason = |cx: &mut HeadlessAppContext, on: bool| {
                cx.update(|cx|p.v.update(cx,|v,cx|{
                v.state.loaded=true; v.state.summary_fresh=true; v.state.generation=v.generation;
                v.state.chats=Arc::new(vec![crate::local_model::chat(&json!({"id":"synthetic","state":"idle","outcome":if on {"question"} else {"done"}})).unwrap()]);
                cx.notify();
            }))
            };
            reason(cx, true);
            frame(cx, p.h, 0);
            frame(cx, p.h, 0);
            assert!(height(cx, p.h) < 1., "reveal begins at zero");
            frame(cx, p.h, 64);
            let opening = height(cx, p.h);
            assert!(opening > 0.);
            reason(cx, false);
            frame(cx, p.h, 0);
            let reversed = height(cx, p.h);
            assert!((reversed - opening).abs() < 0.5);
            cx.update_window(p.h, |_, w, _| {
                assert!(
                    w.try_find("chat-attention-hint").is_none(),
                    "resolved content unmounts immediately"
                )
            })
            .unwrap();
            frame(cx, p.h, 32);
            let closing = height(cx, p.h);
            assert!(closing < opening);
            reason(cx, true);
            frame(cx, p.h, 0);
            frame(cx, p.h, 0);
            assert!(
                (height(cx, p.h) - closing).abs() < 0.5,
                "reopen from displayed space"
            );
            frame(cx, p.h, 64);
            if let Some(dir) = std::env::var_os("PILOT_NEXT_HINT_MOTION_DIR") {
                let dir = std::path::PathBuf::from(dir);
                std::fs::create_dir_all(&dir).unwrap();
                cx.capture_screenshot(p.h)
                    .unwrap()
                    .save(dir.join(format!("{width}-{}-hint-partial.png", mode.name())))
                    .unwrap();
            }
            frame(cx, p.h, 240);
            let natural = height(cx, p.h);
            assert!(natural > opening);
            cx.update_window(p.h, |_, w, cx| {
                let marked = input.update(cx, |i, cx| i.marked_text_range(w, cx));
                assert_eq!(
                    (
                        input.read(cx).value(),
                        input.read(cx).selected_range(),
                        marked,
                        w.focused(cx)
                    ),
                    saved,
                    "hint preserves draft, selection, simulated preedit and focus"
                );
                assert!(input.focus_handle(cx).is_focused(w));
            })
            .unwrap();
            // Resize cancels active easing, including the narrow wrapping path.
            reason(cx, false);
            frame(cx, p.h, 0);
            frame(cx, p.h, 32);
            reason(cx, true);
            frame(cx, p.h, 0);
            frame(cx, p.h, 0);
            cx.update_window(p.h, |_, w, cx| {
                w.resize(size(px(width - 40.), px(720.)));
                w.bounds_changed(cx);
            })
            .unwrap();
            frame(cx, p.h, 0);
            frame(cx, p.h, 0);
            assert!(height(cx, p.h) > 0.);
            let resized = height(cx, p.h);
            frame(cx, p.h, 64);
            assert_eq!(height(cx, p.h), resized);
            cx.update(|cx| cx.set_reduce_motion(true));
            reason(cx, false);
            frame(cx, p.h, 0);
            assert_eq!(height(cx, p.h), 0.);
            reason(cx, true);
            frame(cx, p.h, 0);
            frame(cx, p.h, 0);
            assert!(height(cx, p.h) > 0.);
            cx.update(|cx| cx.set_reduce_motion(false));
            // Reconnect, Unknown, switch, exact answer and Stop semantics run in
            // the existing production question journeys alongside these frames.
            assert!(p.answer().is_none());
            p.close(cx);
        }
    }
}
