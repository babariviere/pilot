//! Actual LocalViewer/composer, owned faux model API and private writer only.
use super::*;
use crate::{
    chat_models::Choice,
    chat_models_fixture::{Mode, Server},
};
use gpui_kit::{
    AnyWindowHandle, Bounds, EntityInputHandler, HeadlessAppContext, ScrollDelta, WindowBounds,
    WindowOptions,
    component::{ActiveTheme, ThemeMode},
    point, size,
    test::TestWindowExt,
};
use std::{path::PathBuf, time::Instant};
fn settle(cx: &mut HeadlessAppContext, h: AnyWindowHandle) {
    for _ in 0..3 {
        cx.run_until_parked();
        cx.advance_clock(Duration::from_millis(16));
        cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
    }
}
fn until(
    cx: &mut HeadlessAppContext,
    h: AnyWindowHandle,
    e: &Entity<ChatEditor>,
    f: impl Fn(&ChatEditor) -> bool,
) {
    let end = Instant::now() + Duration::from_secs(8);
    while !cx.update(|cx| f(e.read(cx))) {
        assert!(Instant::now() < end, "bounded native model publication");
        settle(cx, h);
        std::thread::yield_now();
    }
    settle(cx, h);
}
fn select_model(cx: &mut HeadlessAppContext, h: AnyWindowHandle, id: &'static str, pointer: bool) {
    cx.update_window(h, |_, w, cx| w.click("chat-model", cx))
        .unwrap();
    settle(cx, h);
    cx.update_window(h, |_, w, cx| w.input(id, cx)).unwrap();
    settle(cx, h);
    cx.update_window(h, |_, w, cx| {
        let row = w
            .find(SharedString::from(format!("model-option-{id}")))
            .bounds();
        let root = w.find("desktop-root").bounds();
        assert!(
            row.left() >= root.left()
                && row.right() <= root.right()
                && row.top() >= root.top()
                && row.bottom() <= root.bottom(),
            "model menu must be contained"
        );
        if pointer {
            w.click(SharedString::from(format!("model-option-{id}")), cx);
        } else {
            w.press("down", cx);
            w.press("enter", cx);
        }
    })
    .unwrap();
    settle(cx, h);
}
pub fn run_chat_model_probe(cx: &mut HeadlessAppContext) {
    let dir = std::env::var_os("PILOT_NEXT_MODEL_DIR").map(PathBuf::from);
    if let Some(d) = &dir {
        std::fs::create_dir_all(d).unwrap();
    }
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            let server = Server::start(Mode::Accept);
            let (writer, updates) =
                Interaction::start(server.options.clone(), Ok(server.home.join("state")));
            let drain = updates.clone();
            cx.update(|cx| {
                crate::appearance::commit_appearance(
                    if mode == ThemeMode::Dark {
                        crate::settings_state::AppearancePreference::Dark
                    } else {
                        crate::settings_state::AppearancePreference::Light
                    },
                    cx,
                )
            });
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
                                let mut v = LocalViewer::build(None, Some(writer.clone()), w, cx);
                                v.page = Page::Chat;
                                v.selected = Some("source".into());
                                v.title = "A retained conversation".into();
                                v.generation = 1;
                                v.state.generation = 1;
                                v.state.loaded = true;
                                v.state.list_loaded = true;
                                v.state.projects_loaded = true;
                                v.state.status = "Synthetic Local fixture".into();
                                let raw = server.seen.lock().unwrap().session();
                                let chat = crate::local_model::chat(&raw).unwrap();
                                v.state.chats = Arc::new(vec![chat.clone()]);
                                v.state.projects = Arc::new(vec![crate::local_model::Project {
                                    id: "project-a".into(),
                                    name: "Atlas".into(),
                                    path: "/synthetic/project".into(),
                                }]);
                                v.transcript.update(cx, |t, cx| {
                                    t.replace_readonly(
                                        (1..70)
                                            .map(|id| {
                                                Message::live(
                                                    id,
                                                    "assistant".into(),
                                                    format!(
                                                        "Keep this reader stable {id}. {}",
                                                        "Synthetic 日本語 👩‍💻 paragraph. "
                                                            .repeat(12)
                                                    ),
                                                )
                                            })
                                            .collect(),
                                        true,
                                        cx,
                                    )
                                });
                                v.connect_model_controls(server.options.clone(), w, cx);
                                v.editor.update(cx, |e, cx| {
                                    e.select("chat:source".into(), true, false, w, cx);
                                    e.model_context(
                                        "source",
                                        "/synthetic/project",
                                        chat.model_configuration.clone().unwrap(),
                                        w,
                                        cx,
                                    );
                                });
                                v.rebuild_nav(w, cx);
                                v.listen_writes(updates, w, cx);
                                v
                            })
                        },
                    )
                })
                .unwrap();
            let editor = cx.update(|cx| v.read(cx).editor.clone());
            let transcript = cx.update(|cx| v.read(cx).transcript.clone());
            until(cx, h, &editor, |e| e.ready() && e.model_probe_state().0);
            let text = cx.update(|cx| editor.read(cx).shell_probe().0);
            cx.update_window(h, |_, w, cx| {
                assert_eq!(w.find("desktop-root").bounds().size, w.viewport_size());
                let tray = w.find("composer-tray").bounds();
                let input = w.find("composer-input").bounds();
                let model = w.find("chat-model").bounds();
                let thinking = w.find("chat-thinking").bounds();
                assert_eq!(tray.size.height, px(76.));
                assert_eq!(input.size.height, px(34.));
                for b in [
                    model,
                    thinking,
                    w.find("local-send").bounds(),
                    w.find("composer-stop-slot").bounds(),
                ] {
                    assert!(
                        b.left() >= tray.left()
                            && b.right() <= tray.right()
                            && b.bottom() <= tray.bottom(),
                        "composer controls must stay in the measured tray"
                    );
                }
                text.update(cx, |t, cx| t.focus(w, cx));
                w.input("Retained model draft 日本語 👩‍💻", cx);
                w.press("secondary-a", cx);
            })
            .unwrap();
            settle(cx, h);
            let selection = cx.update(|cx| text.read(cx).selected_range());
            cx.update_window(h, |_, w, cx| {
                w.scroll(
                    "viewport",
                    ScrollDelta::Pixels(point(px(0.), px(100_000.))),
                    cx,
                )
            })
            .unwrap();
            settle(cx, h);
            let anchor = cx.update(|cx| transcript.read(cx).history_probe_anchor(cx));
            assert_eq!(server.posts(), 0);
            select_model(cx, h, "p/b", mode == ThemeMode::Light);
            until(cx, h, &editor, |e| {
                !e.model_probe_state().1
                    && e.model_probe_state().2
                        == Some(Choice {
                            model: "p/b".into(),
                            thinking: Some("low".into()),
                        })
            });
            assert_eq!(server.posts(), 1);
            cx.update_window(h, |_, w, cx| w.click("chat-thinking", cx))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| w.click("model-option-high", cx))
                .unwrap();
            until(cx, h, &editor, |e| {
                !e.model_probe_state().1
                    && e.model_probe_state()
                        .2
                        .as_ref()
                        .is_some_and(|c| c.thinking.as_deref() == Some("high"))
            });
            assert_eq!(server.posts(), 2);
            cx.update(|cx| assert_eq!(text.read(cx).selected_range(), selection));
            cx.update_window(h, |_, w, cx| {
                text.update(cx, |t, cx| t.focus(w, cx));
                w.press("right", cx);
                text.update(cx, |t, cx| {
                    t.replace_and_mark_text_in_range(None, "にほん", Some(3..3), w, cx)
                });
                let before = text.read(cx).value();
                w.click("chat-model", cx);
                w.press("enter", cx);
                assert_eq!(text.read(cx).value(), before);
                assert!(text.update(cx, |t, cx| t.marked_text_range(w, cx).is_some()));
                text.update(cx, |t, cx| t.unmark_text(w, cx));
            })
            .unwrap();
            settle(cx, h);
            assert_eq!(server.posts(), 2);
            // Canonical scope invalidation follows the same owner subscription used by Settings saves.
            let reads = server.seen.lock().unwrap().requests.len();
            cx.update(|cx| {
                v.read(cx)
                    .settings
                    .read(cx)
                    .models
                    .clone()
                    .unwrap()
                    .update(cx, |_, cx| cx.emit(crate::scoped_models_view::ScopeChanged))
            });
            until(cx, h, &editor, |e| e.model_probe_state().0);
            assert!(server.seen.lock().unwrap().requests.len() > reads);
            assert_eq!(server.posts(), 2);
            if let Some(d) = &dir {
                cx.update(|cx| assert_eq!(cx.theme().is_dark(), mode == ThemeMode::Dark));
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(d.join(format!(
                        "{}-{}-model-controls.png",
                        width as u32,
                        mode.name()
                    )))
                    .unwrap();
            }
            server.seen.lock().unwrap().mode = Mode::Lost;
            select_model(cx, h, "q/c", mode == ThemeMode::Dark);
            until(cx, h, &editor, |e| {
                !e.model_probe_state().1 && e.model_probe_state().3
            });
            assert_eq!(server.posts(), 3);
            cx.update_window(h, |_, w, cx| {
                assert_eq!(w.find("local-send").disabled(), Some(true));
                w.click("inspect-chat-model", cx);
            })
            .unwrap();
            until(cx, h, &editor, |e| {
                !e.model_probe_state().1
                    && e.model_probe_state()
                        .2
                        .as_ref()
                        .is_some_and(|c| c.model == "q/c")
            });
            assert_eq!(server.posts(), 3);
            server.seen.lock().unwrap().mode = Mode::Empty;
            cx.update(|cx| {
                let scope = v.read(cx).settings.read(cx).models.clone().unwrap();
                scope.update(cx, |_, cx| cx.emit(crate::scoped_models_view::ScopeChanged));
            });
            until(cx, h, &editor, |e| {
                e.model_probe_state().0 && e.model_catalog_empty()
            });
            cx.update_window(h, |_, w, _| {
                assert_eq!(w.find("local-send").disabled(), Some(true))
            })
            .unwrap();
            if let Some(d) = &dir {
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(d.join(format!("{}-{}-empty-models.png", width as u32, mode.name())))
                    .unwrap();
            }
            server.seen.lock().unwrap().mode = Mode::Accept;
            cx.update(|cx| {
                let scope = v.read(cx).settings.read(cx).models.clone().unwrap();
                scope.update(cx, |_, cx| cx.emit(crate::scoped_models_view::ScopeChanged));
            });
            until(cx, h, &editor, |e| {
                e.model_probe_state().0 && !e.model_catalog_empty()
            });
            if let Some(d) = &dir {
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(d.join(format!(
                        "{}-{}-model-unknown.png",
                        width as u32,
                        mode.name()
                    )))
                    .unwrap();
            }
            cx.update_window(h, |_, w, cx| w.click("ack-chat-model", cx))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| w.click("ack-chat-model", cx))
                .unwrap();
            until(cx, h, &editor, |e| {
                !e.model_probe_state().1 && !e.model_probe_state().3
            });
            assert_eq!(server.posts(), 3);
            cx.update(|cx| {
                assert!(v.read(cx).editor == editor && v.read(cx).transcript == transcript);
                assert_eq!(transcript.read(cx).history_probe_anchor(cx), anchor);
                assert!(
                    text.read(cx)
                        .value()
                        .contains("Retained model draft 日本語 👩‍💻")
                );
                assert!(selection.end > selection.start);
            });
            // New choices are local to the exact project draft and never POST a model change/create.
            server.seen.lock().unwrap().mode = Mode::Accept;
            cx.update_window(h, |_, w, cx| w.click("new-local-chat", cx))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| w.click("new-chat-project", cx))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| w.input("project-a", cx))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| w.click("new-project-project-a", cx))
                .unwrap();
            until(cx, h, &editor, |e| e.model_probe_state().0);
            select_model(cx, h, "p/b", true);
            cx.update_window(h, |_, w, cx| w.click("chat-thinking", cx))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| w.click("model-option-high", cx))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                text.update(cx, |t, cx| t.focus(w, cx));
                w.input("New project model draft 日本語", cx);
            })
            .unwrap();
            settle(cx, h);
            let (key, chosen) = cx.update(|cx| {
                let e = editor.read(cx);
                (
                    e.navigation_key().unwrap().to_string(),
                    e.shell_probe().2.unwrap().model_choice.unwrap(),
                )
            });
            assert_eq!(chosen.project_id, "project-a");
            assert_eq!(chosen.cwd, "/synthetic/project");
            assert_eq!(chosen.choice.model, "p/b");
            assert_eq!(chosen.choice.thinking.as_deref(), Some("high"));
            assert_eq!(server.posts(), 3);
            // A scope removal refuses Create without replacing the choice/text; recovery is derived.
            server.seen.lock().unwrap().mode = Mode::ScopeChanged;
            cx.update(|cx| {
                let scope = v.read(cx).settings.read(cx).models.clone().unwrap();
                scope.update(cx, |_, cx| cx.emit(crate::scoped_models_view::ScopeChanged));
            });
            until(cx, h, &editor, |e| e.model_probe_state().0);
            cx.update_window(h, |_, w, _| {
                assert_eq!(w.find("local-send").disabled(), Some(true))
            })
            .unwrap();
            cx.update(|cx| {
                assert!(
                    editor
                        .read(cx)
                        .shell_probe()
                        .2
                        .unwrap()
                        .model_choice
                        .as_ref()
                        == Some(&chosen)
                )
            });
            server.seen.lock().unwrap().mode = Mode::Accept;
            cx.update(|cx| {
                let scope = v.read(cx).settings.read(cx).models.clone().unwrap();
                scope.update(cx, |_, cx| cx.emit(crate::scoped_models_view::ScopeChanged));
            });
            until(cx, h, &editor, |e| e.model_probe_state().0);
            cx.update_window(h, |_, w, _| {
                assert_ne!(w.find("local-send").disabled(), Some(true))
            })
            .unwrap();
            assert_eq!(server.posts(), 3);
            if let Some(d) = &dir {
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(d.join(format!(
                        "{}-{}-new-model-draft.png",
                        width as u32,
                        mode.name()
                    )))
                    .unwrap();
            }
            cx.update(|cx| editor.read(cx).disconnect_model_fixture());
            until(cx, h, &editor, |e| e.model_probe_state().4);
            cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
            assert!(writer.command(crate::interaction::WriteCommand::Close));
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap()
                .block_on(async {
                    tokio::time::timeout(Duration::from_secs(3), async {
                        let mut flushed = false;
                        while let Ok(s) = drain.recv().await {
                            flushed |= s.flushed;
                        }
                        assert!(
                            flushed,
                            "owned writer must flush and exit before private fixture removal"
                        );
                    })
                    .await
                    .unwrap();
                });
            drop(writer);
            let reopened = crate::delivery_store::Store::open(
                server.home.join("state"),
                server.options.host(),
            )
            .unwrap();
            assert!(reopened.book.drafts[&key].model_choice.as_ref() == Some(&chosen));
            assert!(
                reopened.book.drafts["chat:source"]
                    .text
                    .contains("Retained model draft 日本語 👩‍💻")
            );
            drop(reopened);
            println!(
                "{}",
                serde_json::json!({"probe":"chat-model","width":width,"mode":mode.name(),"actual_composer":true,"tray":76,"input":34,"explicit_model_posts":server.posts(),"model_only_scoped_default":true,"thinking":true,"pointer_keyboard":true,"preedit_guard":true,"settings_invalidation_read_only":true,"unknown_no_retry":true,"retained_reader_draft":true,"new_draft_project_model_thinking":true,"scope_recovery_no_choice_loss":true,"private_restart":true})
            );
        }
    }
}
