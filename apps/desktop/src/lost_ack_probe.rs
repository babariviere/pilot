//! Integrated native Send, reader reconnect/paging/Find, exact recovery and Close.
use super::*;
use crate::{
    delivery_store::{Book, Draft, Store},
    interaction::WriteState,
    lost_ack_fixture::{self as faux, Receipt, Server},
};
use gpui_kit::{
    AnyWindowHandle, Bounds, EntityInputHandler, HeadlessAppContext, WindowBounds, WindowOptions,
    component::{ActiveTheme, Theme, ThemeMode},
    point, size,
    test::{TestQueryExt, TestWindowExt},
};
use serde_json::json;
use std::{path::PathBuf, time::Instant};

struct Private(PathBuf);
impl Private {
    fn book(&self) -> Book {
        serde_json::from_slice(&std::fs::read(self.0.join("state-v1.json")).unwrap()).unwrap()
    }
}
fn retained(book: &Book, original: &crate::delivery_store::Intent) {
    let mut current = book.pending[&original.id].clone();
    // Lookup/execute diagnostics are mutable observations, not operation bytes.
    current.diagnostic = original.diagnostic;
    assert!(current == *original, "immutable captured intent changed");
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
    view: Entity<LocalViewer>,
    reads: async_channel::Receiver<Presentation>,
    writes: async_channel::Receiver<WriteState>,
    last: WriteState,
}
impl Journey {
    fn pump(&mut self, cx: &mut HeadlessAppContext) {
        while let Ok(state) = self.writes.try_recv() {
            self.last = state.clone();
            // Flushed normally exits the app. Observe the exact native Close ACK
            // without quitting the shared hidden-test process.
            if !state.flushed {
                cx.update_window(self.h, |_, w, cx| {
                    self.view
                        .read(cx)
                        .editor
                        .clone()
                        .update(cx, |e, cx| e.accept(state, w, cx))
                })
                .unwrap();
            }
        }
        while let Ok(state) = self.reads.try_recv() {
            cx.update_window(self.h, |_, w, cx| {
                self.view.update(cx, |v, cx| v.accept(state, w, cx))
            })
            .unwrap();
        }
        cx.run_until_parked();
        cx.advance_clock(Duration::from_millis(16));
        cx.update_window(self.h, |_, w, cx| w.render_frame(cx))
            .unwrap();
    }
    fn until(
        &mut self,
        cx: &mut HeadlessAppContext,
        what: &str,
        condition: impl Fn(&Self, &App) -> bool,
    ) {
        let deadline = Instant::now() + Duration::from_secs(8);
        loop {
            self.pump(cx);
            if cx.update(|cx| condition(self, cx)) {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "{what}; writer={:?}; reader={}",
                self.last.error,
                cx.update(|cx| self.view.read(cx).state.status.clone())
            );
            std::thread::yield_now();
        }
        for _ in 0..4 {
            self.pump(cx);
        }
    }
    fn click(&mut self, cx: &mut HeadlessAppContext, id: &'static str) {
        cx.update_window(self.h, |_, w, cx| w.click(id, cx))
            .unwrap();
        for _ in 0..4 {
            self.pump(cx);
        }
    }
    fn open(&mut self, cx: &mut HeadlessAppContext, id: &str) {
        cx.update_window(self.h, |_, w, cx| {
            self.view.update(cx, |v, cx| {
                let chat = v.state.chats.iter().find(|c| c.id == id).unwrap().clone();
                assert!(v.open(chat, w, cx));
            })
        })
        .unwrap();
        self.until(cx, "exact selected chat snapshot", |j, cx| {
            j.view.read(cx).selected.as_deref() == Some(id)
                && j.view.read(cx).state.loaded
                && j.view.read(cx).state.generation == j.view.read(cx).generation
        });
    }
}
pub fn run_lost_ack_probe(cx: &mut HeadlessAppContext) {
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            for (receipt, identity) in [
                (Receipt::Exact, 0),
                (Receipt::Absent, 0),
                (Receipt::Error, 0),
                (Receipt::Ambiguous, 0),
                (Receipt::Operation, 0),
                (Receipt::Hash, 0),
                (Receipt::Destination, 0),
                (Receipt::Target, 0),
                (Receipt::Result, 0),
                (Receipt::Pending, 0),
                (Receipt::Exact, 1),
                (Receipt::Exact, 2),
            ] {
                let server = Server::start();
                let private = Private(
                    std::env::temp_dir().join(format!("native-lost-ack-{}", uuid::Uuid::new_v4())),
                );
                let question = crate::question::Question::parse(
                    17,
                    &json!({"question":"Retained separate answer?","options":[{"label":"Keep"}]}),
                )
                .unwrap();
                let captured = Draft {
                    revision: 4,
                    text: faux::ORIGINAL.into(),
                    cwd: "/synthetic".into(),
                    model_choice: Some(crate::chat_models::DraftChoice {
                        project_id: "p".into(),
                        cwd: "/synthetic".into(),
                        choice: crate::chat_models::Choice {
                            model: "synthetic/model".into(),
                            thinking: Some("high".into()),
                        },
                    }),
                    answer: Some(
                        crate::question::AnswerDraft::capture(
                            &question,
                            4,
                            std::collections::BTreeSet::from([0]),
                            "Keep answer".into(),
                        )
                        .unwrap(),
                    ),
                    ..Default::default()
                };
                Store::open(private.0.clone(), server.options.host())
                    .unwrap()
                    .save_edits(std::collections::BTreeMap::from([(
                        "chat:a".into(),
                        captured.clone(),
                    )]))
                    .unwrap();
                let (writer, writes) =
                    Interaction::start(server.options.clone(), Ok(private.0.clone()));
                let (client, reads) = LocalClient::start(server.options.clone());
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
                                w.activate_window();
                                w.set_rem_size(px(14.));
                                cx.new(|cx| {
                                    LocalViewer::build(Some(client), Some(writer.clone()), w, cx)
                                })
                            },
                        )
                    })
                    .unwrap();
                cx.update(|cx| Theme::change(mode, None, cx));
                let mut j = Journey {
                    h,
                    view,
                    reads,
                    writes,
                    last: WriteState::default(),
                };
                server
                    .control
                    .send_blocking(Some(faux::baseline()))
                    .unwrap();
                j.until(cx, "full baseline and Store", |j, cx| {
                    j.last.book.is_some() && j.view.read(cx).state.summary_fresh
                });
                cx.update(|cx| assert_eq!(cx.theme().mode, mode));
                j.open(cx, "a");
                let (editor, input, transcript) = cx.update(|cx| {
                    let v = j.view.read(cx);
                    let e = v.editor.clone();
                    let input = e.read(cx).shell_probe().0;
                    (e, input, v.transcript.clone())
                });
                let reader_entity = transcript.entity_id();
                // Explicit production button, not an injected Submit command.
                j.click(cx, "local-send");
                j.until(cx, "held execute", |_, _| !server.entered.is_empty());
                server.entered.recv_blocking().unwrap();
                let original = private.book().pending.values().next().unwrap().clone();
                let op = original.operation.as_ref().unwrap();
                assert_eq!(original.key, "chat:a");
                assert_eq!(original.revision, 4);
                assert_eq!(
                    serde_json::to_value(op).unwrap(),
                    server.seen.lock().unwrap().envelope.clone().unwrap()
                );
                assert_eq!(op.target_id, "a");
                assert_eq!(op.kind, "chat-send");
                assert!(!op.operation_id.is_empty());
                // While the exact Send effect owns HTTP, native edits still autosave.
                cx.update_window(h, |_, w, cx| {
                    w.click("composer-input", cx);
                    w.input(faux::NEWER, cx);
                })
                .unwrap();
                j.until(cx, "new text durable during Send wait", |j, _| {
                    j.last
                        .book
                        .as_ref()
                        .is_some_and(|b| b.drafts["chat:a"].text == faux::NEWER)
                });
                assert!(j.last.handled.is_empty());
                let saved = private.book();
                assert!(saved.pending[&original.id] == original);
                assert!(saved.drafts["chat:a"].answer == captured.answer);
                assert_eq!(saved.drafts["chat:a"].cwd, captured.cwd);
                assert!(saved.drafts["chat:a"].model_choice == captured.model_choice);
                // Simulated preedit and focused textarea survive socket loss and autosave.
                cx.update_window(h, |_, w, cx| {
                    input.update(cx, |i, cx| {
                        i.replace_and_mark_text_in_range(None, "に", Some(1..1), w, cx)
                    })
                })
                .unwrap();
                let composition = cx
                    .update_window(h, |_, w, cx| {
                        input.update(cx, |i, cx| {
                            (
                                i.marked_text_range(w, cx),
                                i.selected_text_range(false, w, cx).unwrap().range,
                            )
                        })
                    })
                    .unwrap();
                server.control.send_blocking(None).unwrap();
                server.chat.send_blocking(None).unwrap();
                j.until(cx, "lost control/chat sockets", |j, cx| {
                    !j.view.read(cx).state.summary_fresh && j.view.read(cx).state.chat_issue
                });
                server.release.send_blocking(()).unwrap();
                j.until(cx, "lost ACK remains Unknown", |j, _| {
                    j.last.handled.get("chat:a") == Some(&1)
                });
                cx.update_window(h, |_, w, cx| {
                    assert_eq!(
                        input.update(cx, |i, cx| (
                            i.marked_text_range(w, cx),
                            i.selected_text_range(false, w, cx).unwrap().range
                        )),
                        composition
                    );
                    assert_eq!(w.find_by_label("Message to Pilot").focused(), Some(true));
                    assert_eq!(
                        input.read(cx).value().as_str(),
                        format!("{}に", faux::NEWER)
                    );
                    input.update(cx, |i, cx| i.unmark_text(w, cx));
                })
                .unwrap();
                retained(&private.book(), &original);
                // Explicit reconnect must await a full valid baseline; hello/deltas do not suffice.
                cx.update(|cx| {
                    j.view
                        .read(cx)
                        .client
                        .as_ref()
                        .unwrap()
                        .command(Command::Reconnect)
                });
                j.until(cx, "replacement paged snapshot", |j, cx| {
                    j.view.read(cx).state.loaded
                        && !j.view.read(cx).state.chat_issue
                        && j.view.read(cx).state.cursor == Some(25)
                });
                assert!(!cx.update(|cx| j.view.read(cx).state.summary_fresh));
                server
                    .control
                    .send_blocking(Some(json!({"type":"session","session":faux::summary("a")})))
                    .unwrap();
                // An invalid full replacement also cannot certify freshness.
                server.control.send_blocking(Some(json!({"type":"sessions","sessions":[faux::summary("a"),faux::summary("a")]}))).unwrap();
                j.until(cx, "duplicate-ID baseline rejected", |j, cx| {
                    j.view.read(cx).state.status.contains("unavailable")
                });
                assert!(!cx.update(|cx| j.view.read(cx).state.summary_fresh));
                server
                    .control
                    .send_blocking(Some(faux::baseline()))
                    .unwrap();
                j.until(cx, "fresh exact full baseline", |j, cx| {
                    j.view.read(cx).state.summary_fresh
                });
                retained(&private.book(), &original);
                assert_eq!(
                    server.seen.lock().unwrap().lookups,
                    1,
                    "no automatic recovery lookup"
                );

                // Reject foreign-owner and duplicate-sequence events before a
                // following valid frame establishes that the socket consumed them.
                server.chat.send_blocking(Some(json!({"type":"events","sessionId":"b","seq":99,"events":[{"type":"entry_appended","entry":faux::entry(999,"stale foreign event")}]}))).unwrap();
                server.chat.send_blocking(Some(json!({"type":"events","sessionId":"a","seq":1,"events":[{"type":"entry_appended","entry":faux::entry(998,"stale duplicate event")}]}))).unwrap();
                server.chat.send_blocking(Some(json!({"type":"events","sessionId":"a","seq":2,"events":[{"type":"entry_appended","entry":faux::entry(85,"valid live continuation")}]}))).unwrap();
                j.until(cx, "valid frame after stale events", |_, cx| {
                    transcript
                        .read(cx)
                        .rows()
                        .iter()
                        .any(|r| r.source() == "valid live continuation")
                });
                assert!(!cx.update(|cx| {
                    transcript
                        .read(cx)
                        .rows()
                        .iter()
                        .any(|r| r.source().starts_with("stale "))
                }));
                // Sparse virtual heights may need several actual wheel packets.
                for _ in 0..32 {
                    cx.update_window(h, |_, w, cx| {
                        w.scroll(
                            "viewport",
                            gpui_kit::ScrollDelta::Pixels(point(px(0.), px(100_000.))),
                            cx,
                        )
                    })
                    .unwrap();
                    j.pump(cx);
                    if cx.update(|cx| j.view.read(cx).state.page_busy) {
                        break;
                    }
                }
                j.until(cx, "top-scroll older page", |j, cx| {
                    j.view.read(cx).state.page_busy
                });
                let tail_key = cx.update(|cx| {
                    transcript
                        .read(cx)
                        .rows()
                        .iter()
                        .find(|r| r.reader_key().is_some())
                        .unwrap()
                        .reader_key()
                        .unwrap()
                });
                let anchor = cx.update(|cx| transcript.read(cx).reading_mark(cx));
                cx.update_window(h, |_, w, cx| w.press("secondary-f", cx))
                    .unwrap();
                j.pump(cx);
                let query = cx.update(|cx| transcript.read(cx).find_probe_input());
                server.pages.send_blocking(()).unwrap();
                j.until(cx, "committed older page and Find", |j, cx| {
                    j.view.read(cx).state.cursor.is_none()
                        && !j.view.read(cx).state.page_busy
                        && transcript
                            .read(cx)
                            .rows()
                            .iter()
                            .any(|r| r.source() == faux::OLDER)
                });
                assert_eq!(
                    query.entity_id(),
                    cx.update(|cx| transcript.read(cx).find_probe_input().entity_id())
                );
                assert_eq!(reader_entity, transcript.entity_id());
                assert!(cx.update(|cx| {
                    transcript
                        .read(cx)
                        .rows()
                        .iter()
                        .any(|r| r.matches_reader(&tail_key))
                }));
                let anchor = anchor.unwrap();
                let after = cx.update(|cx| transcript.read(cx).reading_mark(cx).unwrap());
                assert_eq!(
                    anchor.message, after.message,
                    "prepend preserves canonical reading anchor"
                );
                assert!(
                    (anchor.offset - after.offset).abs() < 1.,
                    "prepend preserves pixel offset"
                );
                let older_id = cx.update(|cx| {
                    transcript
                        .read(cx)
                        .rows()
                        .iter()
                        .find(|r| r.source() == faux::OLDER)
                        .unwrap()
                        .id()
                });
                cx.update_window(h, |_, w, cx| w.input(faux::OLDER, cx))
                    .unwrap();
                j.until(cx, "Find resolves actual older match", |_, cx| {
                    !transcript
                        .read(cx)
                        .find_probe_highlights(older_id)
                        .is_empty()
                });
                cx.update_window(h, |_, w, _| {
                    assert_eq!(w.find("find-status").label(), Some("1 of 1"))
                })
                .unwrap();
                cx.update_window(h, |_, w, cx| w.press("escape", cx))
                    .unwrap();
                j.pump(cx);
                let return_mark = cx.update(|cx| transcript.read(cx).reading_mark(cx).unwrap());
                // Same-title B has identical body text. Native target switching must not adopt A.
                j.click(cx, "chat-row-b");
                j.until(cx, "same-title B", |j, cx| {
                    let v = j.view.read(cx);
                    v.selected.as_deref() == Some("b")
                        && v.state.loaded
                        && v.state.generation == v.generation
                });
                cx.update_window(h, |_, w, cx| {
                    w.click("composer-input", cx);
                    w.input("Other chat draft 👩‍💻", cx);
                })
                .unwrap();
                j.until(cx, "B draft durable", |j, _| {
                    j.last.book.as_ref().is_some_and(|b| {
                        b.drafts
                            .get("chat:b")
                            .is_some_and(|d| d.text == "Other chat draft 👩‍💻")
                    })
                });
                retained(&private.book(), &original);
                // The shared passive route is a negative control while Send is
                // unresolved. It must not subscribe, restore or settle A.
                server.pages.send_blocking(()).unwrap();
                j.open(cx, "archive");
                assert!(cx.update(|cx| j.view.read(cx).state.passive_history));
                retained(&private.book(), &original);
                j.click(cx, "chat-row-a");
                j.until(cx, "return A", |j, cx| {
                    let v = j.view.read(cx);
                    v.selected.as_deref() == Some("a")
                        && v.state.loaded
                        && v.state.generation == v.generation
                        && !v.state.passive_history
                });
                assert_eq!(
                    cx.update(|cx| input.read(cx).value().to_string()),
                    format!("{}に", faux::NEWER)
                );
                // Return restoration may request its old page. Let that exact page finish.
                server.pages.send_blocking(()).unwrap();
                j.until(cx, "exact return reading anchor restored", |j, cx| {
                    j.view.read(cx).pending_reader.is_none()
                });
                let restored = cx.update(|cx| transcript.read(cx).reading_mark(cx).unwrap());
                assert_eq!(
                    restored.message, return_mark.message,
                    "navigation keeps canonical history identity"
                );
                assert!(
                    (restored.offset - return_mark.offset).abs() < 1.,
                    "navigation keeps history offset"
                );
                {
                    let mut s = server.seen.lock().unwrap();
                    s.receipt = receipt;
                    s.wrong_daemon = identity == 1;
                    s.wrong_lineage = identity == 2;
                }
                if identity != 0 {
                    cx.update(|cx| {
                        j.view
                            .read(cx)
                            .client
                            .as_ref()
                            .unwrap()
                            .command(Command::Reconnect)
                    });
                    j.until(cx, "fatal identity fence", |j, cx| {
                        j.view.read(cx).state.status.contains("identity")
                    });
                    server
                        .control
                        .send_blocking(Some(faux::baseline()))
                        .unwrap();
                    server.chat.send_blocking(Some(json!({"type":"events","sessionId":"b","seq":99,"events":[{"type":"entry_appended","entry":faux::entry(999,"stale foreign event")}]}))).unwrap();
                    for _ in 0..8 {
                        j.pump(cx);
                    }
                    assert!(!cx.update(|cx| j.view.read(cx).state.summary_fresh));
                    assert!(!cx.update(|cx| {
                        transcript
                            .read(cx)
                            .rows()
                            .iter()
                            .any(|r| r.source() == "stale foreign event")
                    }));
                }
                let before = j.last.delivery_reports.get(&original.id).cloned();
                j.click(cx, "composer-recovery");
                j.click(cx, "check-delivery");
                j.until(cx, "explicit exact Check completes", |j, _| {
                    j.last.delivery_reports.get(&original.id).is_some_and(|r| {
                        before
                            .as_ref()
                            .is_none_or(|b| r.delivery.diagnostic != b.delivery.diagnostic)
                    })
                });
                let known = identity == 0 && matches!(receipt, Receipt::Exact);
                let b = private.book();
                if known {
                    assert!(b.pending.is_empty());
                    assert_eq!(b.drafts["chat:a"].last.as_ref().unwrap().id, original.id);
                    assert_eq!(b.drafts["chat:a"].last.as_ref().unwrap().state, "accepted");
                } else {
                    let retained = &b.pending[&original.id];
                    assert_eq!(retained.id, original.id);
                    assert_eq!(retained.revision, 4);
                    assert!(retained.operation == original.operation);
                    assert_eq!(
                        retained.state,
                        if matches!(receipt, Receipt::Pending) && identity == 0 {
                            "pending"
                        } else {
                            "unknown"
                        }
                    );
                }
                assert_eq!(b.drafts["chat:a"].text, format!("{}に", faux::NEWER));
                assert_eq!(b.drafts["chat:b"].text, "Other chat draft 👩‍💻");
                assert!(b.drafts["chat:a"].answer == captured.answer);
                assert!(b.drafts["chat:a"].model_choice == captured.model_choice);
                server.assert_no_replay();
                assert_eq!(
                    server.seen.lock().unwrap().lookups,
                    if identity == 0 { 2 } else { 1 }
                );
                cx.update_window(h, |_, w, cx| {
                    w.press("escape", cx);
                    editor.update(cx, |e, cx| assert!(!e.request_close(cx)));
                })
                .unwrap();
                j.until(cx, "native owner Close flush", |j, _| j.last.flushed);
                writer.disconnect_fixture();
                let deadline = Instant::now() + Duration::from_secs(5);
                while !j.writes.is_closed() {
                    j.pump(cx);
                    assert!(
                        Instant::now() < deadline,
                        "writer releases Store before closing its lane"
                    );
                    std::thread::yield_now();
                }
                // No sleep, settling frames, lock unlink or reopen retry after
                // observing the closed lane. The native owner has released it.
                let reopened = Store::open(private.0.clone(), server.options.host()).unwrap();
                assert!(reopened.book == *j.last.book.as_ref().unwrap().as_ref());
                drop(reopened);
                cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
                cx.run_until_parked();
                println!(
                    "lost_ack {width} {} {receipt:?} identity={identity}: exact capture, held autosave, socket baseline, paged Find, target return, Check, Close/reopen passed",
                    mode.name()
                );
            }
        }
    }
}
