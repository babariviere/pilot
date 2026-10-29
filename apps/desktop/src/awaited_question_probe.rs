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
}
impl Probe {
    fn open(cx: &mut HeadlessAppContext) -> Self {
        let (writer, writes) = Interaction::recording();
        let (client, _reads) = LocalClient::synthetic_commands();
        let (h, v) = cx
            .update(|cx| {
                gpui_kit::open_window(
                    WindowOptions {
                        window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                            Default::default(),
                            size(px(900.), px(760.)),
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
                            v
                        })
                    },
                )
            })
            .unwrap();
        Self {
            h,
            v,
            writes,
            model: LiveTranscript::default(),
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
                        rows,
                        chats: v.state.chats.clone(),
                        user_queue: queue,
                        question,
                        question_awaited,
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
    // 1. Single choice: pointer pick, then click Reply while the chat is Working.
    let mut p = Probe::open(cx);
    p.publish(
        cx,
        json!({"type":"snapshot","entries":[ask(4, false, true)],"run":{"startedAt":1}}),
    );
    p.publish(cx, json!({"type":"queue_update","items":[],"automatic":[]}));
    assert!(p.model.question_awaited());
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
    let mut p = Probe::open(cx);
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
    let mut p = Probe::open(cx);
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
