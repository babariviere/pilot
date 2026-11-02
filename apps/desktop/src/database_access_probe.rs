//! Actual offscreen production composer with synthetic database-access requests.
//! Isolated private state and command recorder: no LocalOptions, worker, HTTP,
//! real request, database, account or grant.
use super::*;
use crate::{
    database_access::{Decision, Outcome, Reply},
    delivery_store::{Host, Store},
    question::{Projection, Question},
    ui::{self, Text},
};
use gpui_kit::InputEvent as _;
use gpui_kit::{
    AnyWindowHandle, Bounds, ElementInputHandler, HeadlessAppContext, WindowBounds, WindowOptions,
    component::ThemeMode,
    size,
    test::{TestInput, TestQueryExt, TestWindowExt},
};
use std::{sync::Arc, time::Duration};

struct Fixture {
    editor: Entity<ChatEditor>,
}
impl Render for Fixture {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .v_flex()
            .size_full()
            .min_w_0()
            .bg(cx.theme().background)
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .p_4()
                    .child(ui::text(Text::Headline, "Synthetic database request"))
                    .child(ui::text(
                        Text::Body,
                        "Synthetic conversation. Nothing here reaches a database.",
                    )),
            )
            .child(self.editor.clone())
    }
}
fn frame(cx: &mut HeadlessAppContext, h: AnyWindowHandle) {
    cx.advance_clock(Duration::from_millis(16));
    cx.run_until_parked();
    cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
}
fn key(w: &mut Window, key: &'static str, cx: &mut gpui_kit::App) {
    let keystroke = gpui_kit::Keystroke::parse(key).unwrap();
    w.dispatch_event(
        gpui_kit::KeyDownEvent {
            keystroke: keystroke.clone(),
            is_held: false,
            prefer_character_input: false,
        }
        .to_platform_input(),
        cx,
    );
    w.dispatch_event(gpui_kit::KeyUpEvent { keystroke }.to_platform_input(), cx);
}
/// Prose claims read-only SELECT; the structured request is write.
fn access_request(id: &str, mode: &str) -> Arc<Question> {
    Arc::new(
        Question::parse(
            if id == "request-1" { 4 } else { 6 },
            &serde_json::json!({
                "question":"Allow read access to the prod database?",
                "context":"I only need a SELECT on invoices 日本語 👩‍💻 to check totals for the reconciliation report the user asked about earlier.",
                "options":[{"label":"Allow read access to prod","detail":"Read-only","suggested":true},{"label":"Deny"}],
                "databaseAccess":{"id":id,"env":"prod 日本語","mode":mode},
            }),
        )
        .unwrap(),
    )
}
fn decision(commands: &async_channel::Receiver<WriteCommand>) -> (Decision, u64) {
    match commands.try_recv() {
        Ok(WriteCommand::DatabaseAccess { decision, request }) => (decision, request),
        Ok(_) => panic!("Only an explicit database decision may be requested"),
        Err(_) => panic!("Expected one explicit database decision"),
    }
}
fn reply(
    editor: &Entity<ChatEditor>,
    store: &Store,
    decision: &Decision,
    request: u64,
    outcome: Outcome,
    w: &mut Window,
    cx: &mut gpui_kit::App,
) {
    editor.update(cx, |e, cx| {
        e.accept(
            WriteState {
                book: Some(Arc::new(store.book.clone())),
                access: Some(Reply {
                    decision: decision.clone(),
                    request,
                    outcome,
                }),
                ..Default::default()
            },
            w,
            cx,
        )
    });
}
fn enabled(w: &Window, id: &'static str) -> bool {
    w.find(id).disabled().is_none()
}

pub fn run_database_access_probe(cx: &mut HeadlessAppContext) {
    let captures = std::env::var_os("PILOT_NEXT_DATABASE_ACCESS_DIR").map(std::path::PathBuf::from);
    if let Some(dir) = &captures {
        std::fs::create_dir_all(dir).unwrap();
    }
    let mut cases = 0;
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            let root = std::env::temp_dir()
                .join(format!("native-database-access-{}", uuid::Uuid::new_v4()));
            let host = Host {
                host_id: "local".into(),
                daemon_id: "synthetic-daemon".into(),
                lineage_id: "synthetic-lineage".into(),
            };
            let mut store = Store::open(root.clone(), host).unwrap();
            let initial = Draft {
                revision: 1,
                text: "Keep ordinary draft 👩‍💻 日本語 e\u{301}".into(),
                ..Default::default()
            };
            store
                .save_edits(BTreeMap::from([("chat:a".into(), initial.clone())]))
                .unwrap();
            let state = WriteState {
                book: Some(Arc::new(store.book.clone())),
                ..Default::default()
            };
            let (writer, commands) = Interaction::recording();
            let q = access_request("request-1", "write");
            cx.update(|cx| {
                cx.set_reduce_motion(mode == ThemeMode::Dark);
                crate::appearance::commit_appearance(
                    if mode == ThemeMode::Dark {
                        crate::settings_state::AppearancePreference::Dark
                    } else {
                        crate::settings_state::AppearancePreference::Light
                    },
                    cx,
                )
            });
            let (h, editor) = cx.update(|cx| {
                let mut editor = None;
                let (h, _) = gpui_kit::open_window(
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
                        let e = cx.new(|cx| {
                            let mut e = ChatEditor::new(Some(writer.clone()), w, cx);
                            e.accept(state.clone(), w, cx);
                            e.select("chat:a".into(), true, false, w, cx);
                            e
                        });
                        editor = Some(e.clone());
                        cx.new(|_| Fixture { editor: e })
                    },
                )
                .unwrap();
                (h, editor.unwrap())
            });
            frame(cx, h);
            // Preedit in the ordinary editor defers the arriving request, so
            // composition is never lost and nothing can be decided mid-IME.
            cx.update_window(h, |_, w, cx| {
                editor.update(cx, |e, cx| e.focus(w, cx));
                w.render_frame(cx);
                let handler = ElementInputHandler::new(
                    w.find_by_label("Message to Pilot").bounds(),
                    editor.read(cx).text.clone(),
                );
                TestInput::new(handler, w).compose_text(None, "にほん", Some(3..3), cx);
                editor.update(cx, |e, cx| {
                    e.question_context(Some("a"), Projection::Pending(q.clone()), true, w, cx)
                });
            })
            .unwrap();
            frame(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(w.try_find("allow-database-access").is_none());
                assert!(w.try_find("show-current-question").is_some());
                editor.update(cx, |e, cx| {
                    assert!(e.marked(w, cx));
                    e.text.update(cx, |s, cx| {
                        s.unmark_text(w, cx);
                        s.set_value(initial.text.clone(), w, cx);
                    });
                });
                w.click("show-current-question", cx);
            })
            .unwrap();
            frame(cx, h);
            assert!(
                commands.try_recv().is_err(),
                "Showing the request decides nothing"
            );
            cx.update_window(h, |_, w, cx| {
                assert_eq!(cx.theme().mode, mode);
                let tray = w.find("composer-tray").bounds();
                let panel = w.find("question-composer").bounds();
                let content = w.find("question-content").bounds();
                let deny = w.find("deny-database-access");
                let allow = w.find("allow-database-access");
                assert!(deny.visible() && allow.visible());
                assert!(enabled(w, "deny-database-access") && enabled(w, "allow-database-access"));
                assert!(
                    w.try_find_by_label("Allow write access to the prod 日本語 database")
                        .is_some(),
                    "Structured write is named, whatever the prose says"
                );
                assert!(
                    w.try_find_by_label("Allow read access to the prod 日本語 database")
                        .is_none()
                );
                assert!(
                    w.try_find_by_label("Your question reply").is_none(),
                    "No message answer"
                );
                assert!(
                    w.try_find(format!("question-group-4-{}", q.identity.fingerprint))
                        .is_none(),
                    "Prose choices and the suggested answer are not decision controls"
                );
                assert_eq!(w.find_all("question-attention-hint").len(), 1);
                assert!(w.try_find("view-pending-question").is_none());
                assert!(w.try_find("question-stop").is_none());
                let (d, a) = (deny.bounds(), allow.bounds());
                assert!((d.center().y - a.center().y).abs() < px(1.));
                assert!(d.right() < a.left(), "Deny precedes Allow");
                for b in [d, a, content] {
                    assert!(b.left() >= panel.left() && b.right() <= panel.right());
                }
                assert!(content.bottom() <= d.top());
                assert!(panel.top() >= tray.top() && panel.bottom() <= tray.bottom());
                assert!(tray.bottom() <= w.viewport_size().height);
                assert_eq!(editor.read(cx).cache["chat:a"].text, initial.text);
            })
            .unwrap();
            if let Some(dir) = &captures {
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(dir.join(format!("{}-{}-request.png", width as u32, mode.name())))
                    .unwrap();
            }
            // No default: Enter/Space on the focused request decide nothing,
            // and keyboard traversal reaches Deny before Allow.
            cx.update_window(h, |_, w, cx| {
                editor.update(cx, |e, cx| e.focus(w, cx));
                w.render_frame(cx);
                assert_ne!(w.find("allow-database-access").focused(), Some(true));
                assert_ne!(w.find("deny-database-access").focused(), Some(true));
                key(w, "enter", cx);
                key(w, "space", cx);
                w.render_frame(cx);
            })
            .unwrap();
            frame(cx, h);
            assert!(
                commands.try_recv().is_err(),
                "No key press approves by default"
            );
            cx.update_window(h, |_, w, cx| {
                let mut first = None;
                for _ in 0..16 {
                    if w.find("deny-database-access").focused() == Some(true) {
                        first.get_or_insert("deny");
                        break;
                    }
                    if w.find("allow-database-access").focused() == Some(true) {
                        first.get_or_insert("allow");
                        break;
                    }
                    key(w, "tab", cx);
                    w.render_frame(cx);
                }
                assert_eq!(first, Some("deny"), "Keyboard reaches Deny before Allow");
                key(w, "space", cx);
            })
            .unwrap();
            frame(cx, h);
            let (denied, request) = decision(&commands);
            assert!(commands.try_recv().is_err());
            assert_eq!(
                denied,
                Decision {
                    session: "a".into(),
                    question: q.identity.clone(),
                    access: q.content.access.clone().unwrap(),
                    allow: false,
                }
            );
            assert_eq!(denied.access.id, "request-1");
            assert_eq!(denied.access.mode, crate::question::AccessMode::Write);
            // Pending fences duplicates, pointer or keyboard.
            cx.update_window(h, |_, w, cx| {
                assert!(
                    !enabled(w, "deny-database-access") && !enabled(w, "allow-database-access")
                );
                assert!(w.try_find_by_label("Sending decision…").is_some());
                w.click("allow-database-access", cx);
                w.click("deny-database-access", cx);
                editor.update(cx, |e, cx| e.decide_access(&q.identity, true, w, cx));
            })
            .unwrap();
            frame(cx, h);
            assert!(
                commands.try_recv().is_err(),
                "Pending decision cannot duplicate"
            );
            // A stale reply for another request is ignored.
            cx.update_window(h, |_, w, cx| {
                reply(
                    &editor,
                    &store,
                    &denied,
                    request + 100,
                    Outcome::Accepted,
                    w,
                    cx,
                );
            })
            .unwrap();
            frame(cx, h);
            cx.update_window(h, |_, w, _| {
                assert!(w.try_find_by_label("Sending decision…").is_some());
            })
            .unwrap();
            // A lost ACK is Unknown: nothing is resent; only another explicit
            // choice may post, and pilotd's exact request ID check decides it.
            cx.update_window(h, |_, w, cx| {
                reply(
                    &editor,
                    &store,
                    &denied,
                    request,
                    Outcome::Unknown(crate::database_access::UNKNOWN),
                    w,
                    cx,
                );
            })
            .unwrap();
            frame(cx, h);
            assert!(commands.try_recv().is_err(), "Unknown never resubmits");
            cx.update_window(h, |_, w, cx| {
                assert!(
                    w.try_find_by_label(crate::database_access::UNKNOWN)
                        .is_some()
                );
                assert!(enabled(w, "allow-database-access"));
                w.click("allow-database-access", cx);
            })
            .unwrap();
            frame(cx, h);
            let (allowed, request) = decision(&commands);
            assert!(commands.try_recv().is_err());
            assert_eq!(
                allowed,
                Decision {
                    allow: true,
                    ..denied.clone()
                }
            );
            cx.update_window(h, |_, w, cx| {
                reply(&editor, &store, &allowed, request, Outcome::Accepted, w, cx);
            })
            .unwrap();
            frame(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(
                    w.try_find_by_label("Decision sent. Waiting for the agent.")
                        .is_some()
                );
                assert!(
                    !enabled(w, "deny-database-access") && !enabled(w, "allow-database-access")
                );
                assert!(w.try_find("question-attention-hint").is_none());
                w.click("deny-database-access", cx);
            })
            .unwrap();
            frame(cx, h);
            assert!(
                commands.try_recv().is_err(),
                "Accepted decision cannot repeat"
            );
            if let Some(dir) = &captures {
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(dir.join(format!("{}-{}-sent.png", width as u32, mode.name())))
                    .unwrap();
            }
            // A changed request (new ID/mode) is a new decision; the old
            // identity cannot decide it.
            let next = access_request("request-2", "read");
            cx.update_window(h, |_, w, cx| {
                editor.update(cx, |e, cx| {
                    e.question_context(Some("a"), Projection::Pending(next.clone()), true, w, cx);
                });
                w.render_frame(cx);
                assert!(
                    w.try_find_by_label("Allow read access to the prod 日本語 database")
                        .is_some()
                );
                assert!(enabled(w, "allow-database-access"));
                assert!(w.try_find("database-access-status").is_none());
                editor.update(cx, |e, cx| e.decide_access(&q.identity, true, w, cx));
            })
            .unwrap();
            frame(cx, h);
            assert!(
                commands.try_recv().is_err(),
                "Old identity cannot decide a new request"
            );
            // Read-only chat: visible, never decidable.
            cx.update_window(h, |_, w, cx| {
                editor.update(cx, |e, cx| e.permission(false, false, cx));
                w.render_frame(cx);
                assert!(
                    !enabled(w, "allow-database-access") && !enabled(w, "deny-database-access")
                );
                w.click("allow-database-access", cx);
                editor.update(cx, |e, cx| e.permission(true, false, cx));
            })
            .unwrap();
            frame(cx, h);
            assert!(commands.try_recv().is_err());
            // Stale projection (not fresh) is read-only.
            cx.update_window(h, |_, w, cx| {
                editor.update(cx, |e, cx| {
                    e.question_context(Some("a"), Projection::Pending(next.clone()), false, w, cx);
                });
                w.render_frame(cx);
                assert!(!enabled(w, "allow-database-access"));
                w.click("allow-database-access", cx);
            })
            .unwrap();
            frame(cx, h);
            assert!(commands.try_recv().is_err(), "Stale request is read-only");
            // Another chat's request is not this chat's decision surface.
            cx.update_window(h, |_, w, cx| {
                editor.update(cx, |e, cx| {
                    e.question_context(Some("b"), Projection::Pending(next.clone()), true, w, cx);
                    e.decide_access(&next.identity, true, w, cx);
                });
                w.render_frame(cx);
                assert!(w.try_find("allow-database-access").is_none());
            })
            .unwrap();
            frame(cx, h);
            assert!(commands.try_recv().is_err(), "Replaced chat cannot decide");
            // Malformed metadata keeps an explicit refusal, never Allow/Deny.
            let malformed = Arc::new(
                Question::parse(
                    8,
                    &serde_json::json!({"question":"Allow write access?","options":[{"label":"Allow"},{"label":"Deny"}],
                        "databaseAccess":{"id":"request 3","env":"prod","mode":"write"}}),
                )
                .unwrap(),
            );
            cx.update_window(h, |_, w, cx| {
                editor.update(cx, |e, cx| {
                    e.question_context(
                        Some("a"),
                        Projection::Pending(malformed.clone()),
                        true,
                        w,
                        cx,
                    );
                    e.decide_access(&malformed.identity, true, w, cx);
                });
                w.render_frame(cx);
                assert!(w.try_find("question-composer").is_some());
                assert!(w.try_find("allow-database-access").is_none());
                assert!(w.try_find("deny-database-access").is_none());
                assert!(w.try_find_by_label("Your question reply").is_none());
            })
            .unwrap();
            frame(cx, h);
            assert!(
                commands.try_recv().is_err(),
                "Malformed requests cannot be decided"
            );
            // Resolved: history only, the ordinary editor and its exact text return.
            cx.update_window(h, |_, w, cx| {
                editor.update(cx, |e, cx| {
                    e.question_context(Some("a"), Projection::None, true, w, cx);
                    e.focus(w, cx);
                });
                w.render_frame(cx);
                assert!(w.try_find("question-composer").is_none());
                assert!(w.try_find("allow-database-access").is_none());
                let message = w.find_by_label("Message to Pilot");
                assert_eq!(message.focused(), Some(true));
                let e = editor.read(cx);
                assert_eq!(e.text.read(cx).value().as_ref(), initial.text);
                assert_eq!(e.cache["chat:a"].text, initial.text);
                assert!(e.cache["chat:a"].answer.is_none() && e.cache["chat:a"].pending.is_none());
            })
            .unwrap();
            assert!(commands.try_recv().is_err());
            cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
            cx.run_until_parked();
            drop(store);
            std::fs::remove_dir_all(root).unwrap();
            cases += 1;
            println!(
                "database access {} {} passed: structured scope/explicit Allow-Deny/no default/Unknown no-replay/stale/malformed/ordinary draft",
                width as u32,
                mode.name()
            );
        }
    }
    cx.update(|cx| cx.set_reduce_motion(false));
    assert_eq!(cases, 4, "Nonzero exact native matrix");
}
