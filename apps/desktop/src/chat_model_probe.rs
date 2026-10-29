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
                                    ..Default::default()
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
                assert!(
                    model.size.width > px(70.),
                    "readable model trigger: {model:?}"
                );
                assert!(
                    model.size.width < px(150.),
                    "model hugs short label: {model:?}"
                );
                assert!(
                    thinking.size.width > px(35.),
                    "usable thinking trigger: {thinking:?}"
                );
                assert!(
                    thinking.size.width < px(85.),
                    "thinking hugs short label: {thinking:?}"
                );
                assert_eq!(model.top(), thinking.top(), "aligned control baseline");
                assert_eq!(model.size.height, px(21.), "retain Kit small hit target");
                assert_eq!(thinking.size.height, model.size.height);
                assert!(
                    thinking.left() - model.right() <= px(4.),
                    "compact selector gap"
                );
                // The fixture session starts at catalog value "high"; only the title is cased.
                assert_eq!(w.find("chat-thinking").value(), Some("High"));
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
            // Long Unicode labels stay compact: titles truncate inside the field caps and never
            // overlap each other, Send or the measured tray. The full title stays the AX value.
            let short = cx
                .update_window(h, |_, w, _| {
                    (
                        w.find("chat-model").bounds(),
                        w.find("chat-thinking").bounds(),
                    )
                })
                .unwrap();
            let long_model =
                "p/Aurora 日本語 extended reasoning preview 👩‍💻 with a long synthetic name";
            cx.update_window(h, |_, w, cx| {
                let mut raw = server.seen.lock().unwrap().session();
                raw["model"] = serde_json::json!(long_model);
                raw["thinking"] = serde_json::json!("xhigh");
                editor.update(cx, |e, cx| {
                    e.model_context(
                        "source",
                        "/synthetic/project",
                        crate::chat_models::SessionModel::read(&raw),
                        w,
                        cx,
                    )
                });
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, _| {
                let tray = w.find("composer-tray").bounds();
                let model = w.find("chat-model").bounds();
                let thinking = w.find("chat-thinking").bounds();
                let send = w.find("local-send").bounds();
                assert!(
                    w.find("chat-model")
                        .value()
                        .is_some_and(|v| v.starts_with(long_model)),
                    "full long model title remains the accessible value"
                );
                assert_eq!(
                    w.find("chat-thinking").value(),
                    Some("Xhigh (not in catalog)")
                );
                assert!(
                    model.size.width > short.0.size.width && model.size.width <= px(160.),
                    "long model title truncates at its cap: {model:?}"
                );
                assert!(
                    thinking.size.width > short.1.size.width && thinking.size.width <= px(128.),
                    "long thinking title truncates at its cap: {thinking:?}"
                );
                assert!(thinking.left() >= model.right(), "selectors never overlap");
                assert!(
                    thinking.left() - model.right() <= px(4.),
                    "compact selector gap"
                );
                assert!(thinking.right() <= send.left(), "Send stays reachable");
                assert_eq!(model.top(), thinking.top(), "aligned control baseline");
                assert_eq!(model.size.height, px(21.), "retain Kit small hit target");
                assert_eq!(thinking.size.height, model.size.height);
                assert_eq!(tray.size.height, px(76.));
                assert!(
                    model.left() >= tray.left() && thinking.right() <= tray.right(),
                    "long labels stay in the measured tray"
                );
            })
            .unwrap();
            if let Some(d) = &dir {
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(d.join(format!(
                        "{}-{}-model-long-label.png",
                        width as u32,
                        mode.name()
                    )))
                    .unwrap();
            }
            cx.update_window(h, |_, w, cx| {
                let raw = server.seen.lock().unwrap().session();
                editor.update(cx, |e, cx| {
                    e.model_context(
                        "source",
                        "/synthetic/project",
                        crate::chat_models::SessionModel::read(&raw),
                        w,
                        cx,
                    )
                });
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, _| {
                assert_eq!(w.find("chat-thinking").value(), Some("High"));
                assert_eq!(
                    w.find("chat-model").bounds(),
                    short.0,
                    "selector hugs again"
                );
                assert_eq!(w.find("chat-thinking").bounds(), short.1);
            })
            .unwrap();
            assert_eq!(server.posts(), 0);
            cx.update(|cx| assert_eq!(text.read(cx).selected_range(), selection));
            // Mounted inspection is safe in blocked states. No model, start,
            // continuation or send request is made; the main input is untouched.
            for (state, writable, working, extra, reason) in [
                ("failed", true, false, None, "failure"),
                ("working", true, true, None, "work and queued"),
                ("idle", false, false, None, "read-only"),
                (
                    "working",
                    true,
                    false,
                    Some("subscriptionPause"),
                    "subscription limit",
                ),
                ("idle", true, false, Some("pending"), "pending chat action"),
            ] {
                cx.update_window(h, |_, w, cx| {
                    let mut raw = server.seen.lock().unwrap().session();
                    raw["state"] = serde_json::json!(state);
                    raw["working"] = serde_json::json!(working);
                    if extra == Some("subscriptionPause") {
                        raw["subscriptionPause"] = serde_json::json!({"forced": false});
                    }
                    editor.update(cx, |e, cx| {
                        e.permission(writable, working, cx);
                        if extra == Some("pending") {
                            e.model_probe_pending(true);
                        }
                        e.model_context(
                            "source",
                            "/synthetic/project",
                            crate::chat_models::SessionModel::read(&raw),
                            w,
                            cx,
                        );
                        assert!(e.model_probe_restriction().unwrap().contains(reason));
                    });
                })
                .unwrap();
                settle(cx, h);
                if matches!(state, "failed" | "working")
                    && extra.is_none()
                    && writable
                    && let Some(d) = &dir
                {
                    cx.capture_screenshot(h)
                        .unwrap()
                        .save(d.join(format!(
                            "{}-{}-model-{}.png",
                            width as u32,
                            mode.name(),
                            if state == "failed" { "failure" } else { "busy" }
                        )))
                        .unwrap();
                }
                cx.update_window(h, |_, w, cx| {
                    // A held chat is explained by its subscription row, which owns its recovery.
                    // A working chat is routine: no persistent notice, only contextual help.
                    match (state, extra) {
                        ("working", None) => {
                            assert!(w.try_find("chat-model-restriction").is_none());
                            assert!(w.try_find("chat-model-busy-help").is_none());
                            w.hover("chat-model-field", cx);
                        }
                        (_, Some("subscriptionPause")) => {
                            assert!(w.find("subscription-limit").bounds().size.height > px(0.))
                        }
                        _ => {
                            assert!(w.find("chat-model-restriction").bounds().size.height > px(0.))
                        }
                    }
                })
                .unwrap();
                if (state, extra) == ("working", None) {
                    cx.advance_clock(Duration::from_secs(1));
                    settle(cx, h);
                    if let Some(d) = &dir {
                        cx.capture_screenshot(h)
                            .unwrap()
                            .save(d.join(format!(
                                "{}-{}-model-busy-help.png",
                                width as u32,
                                mode.name()
                            )))
                            .unwrap();
                    }
                    cx.update_window(h, |_, w, cx| {
                        assert!(w.find("chat-model-busy-help").bounds().size.height > px(0.));
                        w.hover("composer-input", cx);
                    })
                    .unwrap();
                    settle(cx, h);
                }
                cx.update_window(h, |_, w, cx| {
                    w.click("chat-model", cx);
                })
                .unwrap();
                settle(cx, h);
                if state == "working"
                    && extra.is_none()
                    && let Some(d) = &dir
                {
                    cx.capture_screenshot(h)
                        .unwrap()
                        .save(d.join(format!(
                            "{}-{}-model-busy-menu.png",
                            width as u32,
                            mode.name()
                        )))
                        .unwrap();
                }
                if (state, extra) == ("working", None) {
                    // Keyboard/menu path: the open menu names why choices are disabled.
                    cx.update_window(h, |_, w, _| {
                        let hint = w.find("model-option-:busy");
                        assert!(hint.bounds().size.height > px(0.));
                    })
                    .unwrap();
                }
                cx.update_window(h, |_, w, cx| {
                    w.click("model-option-p/b", cx);
                    w.press("escape", cx);
                })
                .unwrap();
                settle(cx, h);
                assert_eq!(server.posts(), 0);
                cx.update(|cx| {
                    assert_eq!(
                        editor
                            .read(cx)
                            .model_probe_state()
                            .2
                            .as_ref()
                            .unwrap()
                            .model,
                        "p/a"
                    );
                    assert_eq!(text.read(cx).selected_range(), selection);
                    assert_eq!(
                        text.read(cx).value().as_ref(),
                        "Retained model draft 日本語 👩‍💻"
                    );
                });
                if (state, extra) == ("working", None) {
                    // Escape returned focus to the Model trigger; Down reopens it by keyboard.
                    cx.update_window(h, |_, w, cx| w.press("down", cx)).unwrap();
                    settle(cx, h);
                    cx.update_window(h, |_, w, cx| {
                        assert!(w.find("model-option-:busy").bounds().size.height > px(0.));
                        w.press("escape", cx);
                    })
                    .unwrap();
                    settle(cx, h);
                    assert_eq!(server.posts(), 0);
                    cx.update(|cx| assert_eq!(text.read(cx).selected_range(), selection));
                }
            }
            // A failed chat becoming healthy/parked must not keep a stale UI lock.
            server.seen.lock().unwrap().mode = Mode::Parked;
            cx.update_window(h, |_, w, cx| {
                let raw = server.seen.lock().unwrap().session();
                editor.update(cx, |e, cx| {
                    e.model_probe_pending(false);
                    e.permission(true, false, cx);
                    e.model_context(
                        "source",
                        "/synthetic/project",
                        crate::chat_models::SessionModel::read(&raw),
                        w,
                        cx,
                    );
                    assert!(e.model_probe_restriction().is_none());
                });
            })
            .unwrap();
            settle(cx, h);
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
            cx.update_window(h, |_, w, _| {
                assert_eq!(w.find("chat-thinking").value(), Some("Low"));
            })
            .unwrap();
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
            cx.update_window(h, |_, w, _| {
                assert_eq!(w.find("chat-thinking").value(), Some("High"));
            })
            .unwrap();
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
            // A single catalog level is still title-cased and marked fixed.
            cx.update_window(h, |_, w, _| {
                assert_eq!(w.find("chat-thinking").value(), Some("Off (fixed)"));
            })
            .unwrap();
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
            // Failed configuration is a separate passive route, with honest next-attempt semantics.
            server.seen.lock().unwrap().mode = Mode::FailedPassive;
            cx.update_window(h, |_, w, cx| {
                let raw = server.seen.lock().unwrap().session();
                v.update(cx, |v, cx| {
                    v.state.chats = Arc::new(vec![crate::local_model::chat(&raw).unwrap()]);
                    cx.notify();
                });
                editor.update(cx, |e, cx| {
                    e.model_context(
                        "source",
                        "/synthetic/project",
                        crate::chat_models::SessionModel::read(&raw),
                        w,
                        cx,
                    );
                });
            })
            .unwrap();
            cx.update(|cx| {
                let scope = v.read(cx).settings.read(cx).models.clone().unwrap();
                scope.update(cx, |_, cx| cx.emit(crate::scoped_models_view::ScopeChanged));
            });
            until(cx, h, &editor, |e| {
                e.model_probe_state().0 && e.model_probe_restriction().is_none()
            });
            cx.update_window(h, |_, w, cx| {
                assert!(w.find("chat-model-next-attempt").bounds().size.height > px(0.));
                text.update(cx, |t, cx| {
                    t.focus(w, cx);
                    t.replace_and_mark_text_in_range(None, "未確定", Some(3..3), w, cx);
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
            assert_eq!(server.posts(), 3);
            select_model(cx, h, "p/b", mode == ThemeMode::Light);
            until(cx, h, &editor, |e| {
                !e.model_probe_state().1
                    && e.model_probe_state()
                        .2
                        .as_ref()
                        .is_some_and(|c| c.model == "p/b")
            });
            assert_eq!(server.posts(), 4);
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
            assert_eq!(server.posts(), 5);
            cx.update_window(h, |_, w, cx| w.click("chat-thinking", cx))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| w.click("model-option-", cx))
                .unwrap();
            until(cx, h, &editor, |e| {
                !e.model_probe_state().1
                    && e.model_probe_state()
                        .2
                        .as_ref()
                        .is_some_and(|c| c.thinking.is_none())
            });
            assert_eq!(server.posts(), 6);
            {
                let seen = server.seen.lock().unwrap();
                assert_eq!(seen.model, "q/c"); // old effective model is untouched
                assert_eq!(seen.session()["outcomeAt"], 100);
                assert_eq!(seen.session()["outcomeReason"], "Original failure 日本語");
            }
            if let Some(d) = &dir {
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(d.join(format!(
                        "{}-{}-failed-next-attempt.png",
                        width as u32,
                        mode.name()
                    )))
                    .unwrap();
            }
            server.seen.lock().unwrap().mode = Mode::FailedLost;
            select_model(cx, h, "q/c", true);
            until(cx, h, &editor, |e| {
                !e.model_probe_state().1 && e.model_probe_state().3
            });
            assert_eq!(server.posts(), 7);
            cx.update_window(h, |_, w, cx| w.click("inspect-chat-model", cx))
                .unwrap();
            until(cx, h, &editor, |e| {
                !e.model_probe_state().1
                    && e.model_probe_state()
                        .2
                        .as_ref()
                        .is_some_and(|c| c.model == "q/c")
            });
            assert!(
                cx.update(|cx| editor.read(cx).model_probe_state().3),
                "GET equality retains Unknown"
            );
            cx.update_window(h, |_, w, cx| w.click("ack-chat-model", cx))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| w.click("ack-chat-model", cx))
                .unwrap();
            until(cx, h, &editor, |e| {
                !e.model_probe_state().1 && !e.model_probe_state().3
            });
            server.seen.lock().unwrap().mode = Mode::FailedDelayed;
            select_model(cx, h, "p/a", true);
            until(cx, h, &editor, |e| {
                e.model_probe_state().1 && server.posts() == 8
            });
            cx.update_window(h, |_, w, cx| w.click("new-local-chat", cx))
                .unwrap();
            settle(cx, h);
            let new_key = cx.update(|cx| editor.read(cx).navigation_key().unwrap().to_owned());
            let new_value = cx.update(|cx| text.read(cx).value());
            let new_selection = cx.update(|cx| text.read(cx).selected_range());
            let new_focus = cx.update_window(h, |_, w, cx| w.focused(cx)).unwrap();
            server.release_ack();
            until(cx, h, &editor, |e| !e.model_probe_state().1);
            cx.update(|cx| {
                assert_eq!(editor.read(cx).navigation_key(), Some(new_key.as_str()));
                assert_eq!(text.read(cx).value(), new_value);
                assert_eq!(text.read(cx).selected_range(), new_selection);
            });
            cx.update_window(h, |_, w, cx| {
                assert_eq!(
                    w.focused(cx),
                    new_focus,
                    "late failed-model ACK cannot steal focus"
                )
            })
            .unwrap();
            assert_eq!(server.posts(), 8);
            // New choices are local to the exact project draft and never POST a model change/create.
            server.seen.lock().unwrap().mode = Mode::Accept;
            cx.update_window(h, |_, w, cx| w.click("new-local-chat", cx))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                let query = editor.read(cx).project_query(cx).unwrap();
                query.update(cx, |q, cx| q.focus(w, cx));
            })
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
            assert_eq!(server.posts(), 8);
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
            assert_eq!(server.posts(), 8);
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
                serde_json::json!({"probe":"chat-model","width":width,"mode":mode.name(),"actual_composer":true,"tray":76,"input":34,"explicit_model_posts":server.posts(),"model_only_scoped_default":true,"thinking":true,"pointer_keyboard":true,"preedit_guard":true,"settings_invalidation_read_only":true,"unknown_no_retry":true,"failed_next_attempt_no_retry":true,"failed_default_thinking":true,"failed_late_ack_navigation":true,"retained_reader_draft":true,"new_draft_project_model_thinking":true,"scope_recovery_no_choice_loss":true,"private_restart":true})
            );
        }
    }
}
