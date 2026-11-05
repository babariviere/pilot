//! One native Slack draft journey with the real courier and private Store across cold reopen.
//! The HTTP fixture preserves simulated durable rows, not a production daemon database.
use super::*;
use crate::{
    delivery_store::{Book, Intent, Store},
    interaction::WriteState,
};
use gpui_kit::{ClipboardItem, EntityInputHandler, Image, ImageFormat};
use std::path::{Path, PathBuf};

struct Private(PathBuf);
impl Private {
    fn book(&self) -> Book {
        serde_json::from_slice(&std::fs::read(self.0.join("state-v1.json")).unwrap()).unwrap()
    }
}
impl Drop for Private {
    fn drop(&mut self) {
        if !std::thread::panicking() {
            std::fs::remove_dir_all(&self.0).unwrap();
        }
    }
}
struct Journey {
    h: AnyWindowHandle,
    v: Entity<LocalViewer>,
    writer: Interaction,
    updates: async_channel::Receiver<WriteState>,
    last: WriteState,
}
impl Journey {
    fn open(
        cx: &mut HeadlessAppContext,
        s: &Server,
        root: &Path,
        width: f32,
        mode: ThemeMode,
    ) -> Self {
        let (mut writer, updates) = Interaction::start(s.options.clone(), Ok(root.to_owned()));
        writer.pasted_attachment_directory = Some(root.join("pasted"));
        let (client, _) = LocalClient::synthetic_commands();
        let (h, v) = cx.update(|cx| {
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
                        let mut v = LocalViewer::build(Some(client), Some(writer.clone()), w, cx);
                        v.state.projects = Arc::new(
                            crate::local_model::projects(&json!([
                                project("p1", "Atlas", &["C1"]),
                                project("p2", "Boreal", &["C9"])
                            ]))
                            .unwrap(),
                        );
                        v.state.projects_loaded = true;
                        v.state.loaded = true;
                        v.state.list_loaded = true;
                        v.state.generation = v.generation;
                        v.inbox.update(cx, |i, cx| i.options(s.options.clone(), cx));
                        v.rebuild_nav(w, cx);
                        v
                    })
                },
            )
            .unwrap()
        });
        cx.update_window(h, |_, w, cx| {
            Theme::change(mode, Some(w), cx);
            w.activate_window();
        })
        .unwrap();
        let mut j = Self {
            h,
            v,
            writer,
            updates,
            last: WriteState::default(),
        };
        j.until(cx, "Store ready", |j, cx| {
            j.v.read(cx).editor.read(cx).ready()
        });
        j
    }
    fn pump(&mut self, cx: &mut HeadlessAppContext) {
        while let Ok(state) = self.updates.try_recv() {
            self.last = state.clone();
            // Observe Close without exiting the entire native test process.
            if !state.flushed {
                cx.update_window(self.h, |_, w, cx| {
                    self.v
                        .read(cx)
                        .editor
                        .clone()
                        .update(cx, |e, cx| e.accept(state, w, cx));
                })
                .unwrap();
            }
        }
        settle(cx, self.h);
    }
    fn until(
        &mut self,
        cx: &mut HeadlessAppContext,
        what: &str,
        done: impl Fn(&Self, &App) -> bool,
    ) {
        let end = Instant::now() + Duration::from_secs(12);
        loop {
            self.pump(cx);
            if cx.update(|cx| done(self, cx)) {
                return;
            }
            assert!(
                Instant::now() < end,
                "{what}; courier={:?}",
                self.last.error
            );
            std::thread::yield_now();
        }
    }
    fn start(&mut self, cx: &mut HeadlessAppContext, width: f32) {
        click(cx, self.h, "nav-inbox");
        click(cx, self.h, "inbox-tab-slack");
        self.until(cx, "Slack board", |j, cx| {
            slack(&j.v, cx).read(cx).board.is_some()
        });
        if width < 960. && present(cx, self.h, "slack-back") {
            click(cx, self.h, "slack-back");
        }
        click(
            cx,
            self.h,
            if width >= 960. {
                "slack-card-ticket"
            } else {
                "slack-row-ticket"
            },
        );
        click(cx, self.h, "slack-start-chat");
        self.pump(cx);
    }
    fn draft(&self, cx: &App) -> (String, crate::delivery_store::Draft) {
        let e = self.v.read(cx).editor.read(cx);
        (
            e.navigation_key().unwrap().to_owned(),
            e.shell_probe().2.unwrap(),
        )
    }
    fn close(
        mut self,
        cx: &mut HeadlessAppContext,
        root: &Path,
        host: crate::delivery_store::Host,
    ) {
        cx.update_window(self.h, |_, _, cx| {
            self.v
                .read(cx)
                .editor
                .clone()
                .update(cx, |e, cx| assert!(!e.request_close(cx)));
        })
        .unwrap();
        self.until(cx, "Close Flushed", |j, _| j.last.flushed);
        self.writer.disconnect_fixture();
        self.until(cx, "Store released before closed lane", |j, _| {
            j.updates.is_closed()
        });
        let reopened = Store::open(root.to_owned(), host).unwrap();
        assert!(reopened.book == **self.last.book.as_ref().unwrap());
        drop(reopened);
        cx.update_window(self.h, |_, w, _| w.remove_window())
            .unwrap();
        cx.run_until_parked();
    }
}
fn same_capture(book: &Book, original: &Intent) {
    let mut current = book.pending[&original.id].clone();
    current.diagnostic = original.diagnostic;
    assert!(current == *original, "cold reopen changed immutable intent");
}
fn creates(s: &Server) -> Vec<Value> {
    writes(s)
        .into_iter()
        .filter(|(_, p, _)| p == "/api/operations")
        .map(|(_, _, b)| b)
        .collect()
}
fn patches(s: &Server) -> Vec<Value> {
    writes(s)
        .into_iter()
        .filter(|(m, _, _)| m == "PATCH")
        .map(|(_, _, b)| b)
        .collect()
}
pub(super) fn run(cx: &mut HeadlessAppContext) {
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            for committed in [false, true] {
                let private = Private(
                    std::env::temp_dir()
                        .join(format!("native-slack-recovery-{}", uuid::Uuid::new_v4())),
                );
                let mut s = Server::start(
                    vec![
                        project("p1", "Atlas", &["C1"]),
                        project("p2", "Boreal", &["C9"]),
                    ],
                    vec![source("p1", "ok")],
                    vec![crate::slack_triage_fixture::message(
                        "ticket",
                        "p1",
                        "Exact ticket 日本語 👩‍💻",
                        "open",
                        1_791_892_800,
                    )],
                );
                let mut lost = Reply::status(None, Value::Null);
                lost.apply = committed;
                s.reply("POST", "/api/operations", lost);
                s.state.lock().unwrap().fail_lookup_after_create = true;
                let mut j = Journey::open(cx, &s, &private.0, width, mode);
                j.start(cx, width);
                let (key, initial) = cx.update(|cx| j.draft(cx));
                assert_eq!(initial.project_id.as_deref(), Some("p1"));
                assert_eq!(initial.cwd, "/synthetic/p1");
                assert_eq!(initial.tracked.as_ref().unwrap().item_id, "ticket");
                assert!(
                    initial
                        .text
                        .contains("https://acme.slack.com/archives/C1/p1791892800000100?team=T1")
                );
                assert!(!present(cx, j.h, "new-chat-project"), "project locked");
                assert!(writes(&s).is_empty(), "selection/Start chat never sends");
                cx.update_window(j.h, |_, w, cx| {
                    w.input(" Edited e\u{301} 日本語", cx);
                    let mut bytes = std::io::Cursor::new(Vec::new());
                    image::DynamicImage::new_rgba8(8, 8)
                        .write_to(&mut bytes, image::ImageFormat::Png)
                        .unwrap();
                    cx.write_to_clipboard(ClipboardItem::new_image(&Image::from_bytes(
                        ImageFormat::Png,
                        bytes.into_inner(),
                    )));
                    w.press("secondary-v", cx);
                })
                .unwrap();
                j.until(cx, "attachment and exact draft saved", |j, cx| {
                    let (_, d) = j.draft(cx);
                    d.attachments.len() == 1 && j.v.read(cx).editor.read(cx).saved_probe(cx)
                });
                let sent = cx.update(|cx| j.draft(cx).1);
                sent.attachments[0].verify().unwrap();
                // Repeated activation returns to the editable slot, never another intent.
                j.start(cx, width);
                cx.update(|cx| assert_eq!(j.draft(cx).0, key));
                assert!(creates(&s).is_empty());
                click(cx, j.h, "local-send");
                j.until(cx, "lost creation reply recorded", |j, _| {
                    creates(&s).len() == 1
                        && j.last
                            .book
                            .as_ref()
                            .is_some_and(|b| b.pending.values().any(|i| i.state == "unknown"))
                });
                let original = private.book().pending.values().next().unwrap().clone();
                let envelope = creates(&s)[0].clone();
                let payload: Value =
                    serde_json::from_str(envelope["payload"].as_str().unwrap()).unwrap();
                assert_eq!(payload["projectId"], "p1");
                assert_eq!(
                    payload["message"],
                    crate::image_attachments::message(&sent.text, &sent.attachments)
                );
                assert_eq!(
                    s.state.lock().unwrap().receipts.len(),
                    usize::from(committed)
                );
                assert!(
                    patches(&s).is_empty(),
                    "no linkage from unconfirmed creation"
                );
                // Newer input/IME cannot be overwritten by late delivery observations.
                let input = cx.update(|cx| j.v.read(cx).editor.read(cx).shell_probe().0);
                cx.update_window(j.h, |_, w, cx| {
                    w.input(" Newer unsent 🦀", cx);
                    input.update(cx, |i, cx| {
                        i.replace_and_mark_text_in_range(None, "にほん", Some(3..3), w, cx)
                    });
                })
                .unwrap();
                j.pump(cx);
                cx.update_window(j.h, |_, w, cx| {
                    assert!(
                        input
                            .update(cx, |i, cx| i.marked_text_range(w, cx))
                            .is_some()
                    );
                    assert!(
                        !j.v.update(cx, |v, cx| v.prepare_navigation(w, cx)),
                        "IME blocks navigation, not discarded"
                    );
                    input.update(cx, |i, cx| i.unmark_text(w, cx));
                })
                .unwrap();
                j.until(cx, "newer input durable", |j, cx| {
                    j.v.read(cx).editor.read(cx).saved_probe(cx)
                });
                let newer = cx.update(|cx| j.draft(cx).1);
                assert!(newer.text.ends_with("にほん"));
                same_capture(&private.book(), &original);
                j.close(cx, &private.0, s.options.host());
                same_capture(&private.book(), &original);
                s.restart();
                s.clear("POST", "/api/operations");
                s.state.lock().unwrap().fail_lookup_after_create = false;
                let mut lost = Reply::status(None, Value::Null);
                lost.apply = true;
                s.reply("PATCH", "/api/tracked-items/ticket", lost);
                let mut j = Journey::open(cx, &s, &private.0, width, mode);
                j.until(
                    cx,
                    "accepted creation, applied link with lost ACK",
                    |j, _| {
                        !patches(&s).is_empty()
                            && j.last
                                .book
                                .as_ref()
                                .is_some_and(|b| b.pending.is_empty() && b.links.len() == 1)
                    },
                );
                let chat = envelope["targetId"].as_str().unwrap().to_owned();
                assert!(
                    creates(&s).iter().all(|e| e == &envelope),
                    "retries reuse exact bytes and operation"
                );
                assert_eq!(
                    s.state.lock().unwrap().receipts.len(),
                    1,
                    "one chat/message effect"
                );
                assert_eq!(s.state.lock().unwrap().link_starts, 1);
                assert_eq!(private.book().drafts[&key].text, newer.text);
                assert_eq!(private.book().drafts[&key].attachments, newer.attachments);
                j.close(cx, &private.0, s.options.host());
                s.restart();
                s.clear("PATCH", "/api/tracked-items/ticket");
                let mut j = Journey::open(cx, &s, &private.0, width, mode);
                j.until(cx, "cold reopen settles same tracked link", |j, _| {
                    j.last.linked.get("ticket") == Some(&chat)
                });
                assert!(private.book().links.is_empty());
                assert!(
                    patches(&s)
                        .iter()
                        .all(|b| b == &json!({"sessionId":chat,"start":true}))
                );
                assert_eq!(
                    s.state.lock().unwrap().link_starts,
                    1,
                    "retry never repeats start effects"
                );
                assert_eq!(
                    s.state.lock().unwrap().items[0]["sessionIds"],
                    json!([chat])
                );
                assert_eq!(private.book().drafts[&key].text, newer.text);
                assert_eq!(private.book().drafts[&key].attachments, newer.attachments);
                j.close(cx, &private.0, s.options.host());
                assert!(private.book().pending.is_empty());
                println!(
                    "slack_recovery {width} {} create_committed={committed}: native draft/edit/paste/Send, lost create/link ACK, cold courier/HTTP restart, newer IME input, exact dedupe, Close/reopen passed",
                    mode.name()
                );
            }
        }
    }
}
