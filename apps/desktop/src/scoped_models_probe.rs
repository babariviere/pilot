//! Actual LocalViewer Settings window with injected owned loopback/auth only.
use super::*;
use crate::{
    scoped_models_fixture::{Mode, Server},
    scoped_models_view::ScopedModels,
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
    for _ in 0..4 {
        cx.run_until_parked();
        cx.advance_clock(Duration::from_millis(16));
        cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
    }
}
fn until(
    cx: &mut HeadlessAppContext,
    main: AnyWindowHandle,
    settings: AnyWindowHandle,
    scope: &Entity<ScopedModels>,
    f: impl Fn(&ScopedModels) -> bool,
) {
    let end = Instant::now() + Duration::from_secs(8);
    while !cx.update(|cx| f(scope.read(cx))) {
        assert!(Instant::now() < end, "bounded scoped-model publication");
        settle(cx, main);
        settle(cx, settings);
        std::thread::yield_now();
    }
    settle(cx, main);
    settle(cx, settings);
}
fn click(cx: &mut HeadlessAppContext, h: AnyWindowHandle, id: &'static str) {
    for _ in 0..12 {
        let visible = cx
            .update_window(h, |_, w, cx| {
                let target = w.find(id).bounds();
                let viewport = w.find("settings-scroll").bounds();
                if viewport.contains(&target.center()) {
                    w.click(id, cx);
                    true
                } else {
                    w.scroll(
                        "settings-scroll",
                        ScrollDelta::Pixels(point(
                            px(0.),
                            px(if target.center().y > viewport.bottom() {
                                -180.
                            } else {
                                180.
                            }),
                        )),
                        cx,
                    );
                    false
                }
            })
            .unwrap();
        settle(cx, h);
        if visible {
            return;
        }
    }
    panic!("scoped settings control must be reachable by its actual scroll region: {id}");
}
pub fn run_scoped_models_probe(cx: &mut HeadlessAppContext) {
    let dir = std::env::var_os("PILOT_NEXT_SCOPE_DIR").map(PathBuf::from);
    if let Some(d) = &dir {
        std::fs::create_dir_all(d).unwrap();
    }
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            let server = Server::start(Mode::Accept);
            server.seen.lock().unwrap().patterns = Some(vec![]);
            // New windows follow the committed appearance policy. Merely changing
            // Kit tokens would be reset by the native System appearance hook.
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
            let (main, view) = cx.update(|cx| {
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
                            let models =
                                cx.new(|cx| ScopedModels::new(Some(server.options.clone()), w, cx));
                            v.settings.update(cx, |p, _| p.models = Some(models));
                            v.settings_fixture_size = Some(size(px(width), px(760.)));
                            v
                        })
                    },
                )
                .unwrap()
            });
            settle(cx, main);
            let transcript = cx.update(|cx| view.read(cx).transcript.clone());
            let editor = cx.update(|cx| view.read(cx).editor.clone());
            let unsent = cx.update(|cx| editor.read(cx).shell_probe().0);
            cx.update_window(main, |_, w, cx| {
                unsent.update(cx, |t, cx| t.set_value("Retained unsent 日本語 👩‍💻", w, cx))
            })
            .unwrap();
            settle(cx, main);
            cx.update_window(main, |_, w, cx| w.click("open-settings", cx))
                .unwrap();
            settle(cx, main);
            let (settings, scope) = cx.update(|cx| {
                let v = view.read(cx);
                (
                    v.settings_window.unwrap(),
                    v.settings.read(cx).models.clone().unwrap(),
                )
            });
            settle(cx, settings);
            cx.update_window(settings, |_, w, cx| w.click("settings-models", cx))
                .unwrap();
            until(cx, main, settings, &scope, |m| {
                m.probe_state().0 && !m.probe_state().1
            });
            assert_eq!(server.puts(), 0);
            crate::scoped_models_view::groups_probe::run(cx, settings, &scope, width, mode);
            assert_eq!(server.puts(), 0);
            cx.update_window(settings, |_, w, cx| {
                let root = w.find("settings-root").bounds();
                assert_eq!(root.size.width, px(width));
                assert_eq!(root.size, w.viewport_size());
                let button = w.find("scope-save").bounds();
                assert!(
                    button.left() >= root.left()
                        && button.right() <= root.right()
                        && button.bottom() <= root.bottom()
                );
                assert_eq!(w.find("scope-save").disabled(), Some(true));
                w.click("scope-all", cx);
            })
            .unwrap();
            settle(cx, settings);
            cx.update_window(settings, |_, w, cx| w.click("scope-model-p/one", cx))
                .unwrap();
            settle(cx, settings);
            cx.update_window(settings, |_, w, cx| w.press("secondary-w", cx))
                .unwrap();
            settle(cx, settings);
            assert!(
                cx.update(|cx| view.read(cx).settings_window.is_some()),
                "dirty model list refuses managed close"
            );
            assert_eq!(server.puts(), 0);
            cx.update_window(settings, |_, w, cx| w.click("scope-save", cx))
                .unwrap();
            until(cx, main, settings, &scope, |m| {
                !m.probe_state().1 && m.probe_state().4 == Some(vec!["p/one".into()])
            });
            assert_eq!(server.puts(), 1);
            cx.update(|cx| assert_eq!(cx.theme().is_dark(), mode == ThemeMode::Dark));
            if let Some(d) = &dir {
                cx.capture_screenshot(settings)
                    .unwrap()
                    .save(d.join(format!("{}-{}-scope-saved.png", width as u32, mode.name())))
                    .unwrap();
            }
            cx.update_window(settings, |_, w, cx| w.press("secondary-w", cx))
                .unwrap();
            settle(cx, main);
            assert!(cx.update(|cx| view.read(cx).settings_window.is_none()));
            cx.update_window(main, |_, w, cx| w.press("secondary-,", cx))
                .unwrap();
            settle(cx, main);
            let settings = cx.update(|cx| view.read(cx).settings_window.unwrap());
            settle(cx, settings);
            // Replies use the retained main owner, not the now-closed old Settings window.
            cx.update_window(settings, |_, w, cx| w.click("scope-check", cx))
                .unwrap();
            until(cx, main, settings, &scope, |m| !m.probe_state().1);
            cx.update_window(settings, |_, w, cx| w.click("scope-all", cx))
                .unwrap();
            settle(cx, settings);
            cx.update_window(settings, |_, w, cx| w.press("secondary-s", cx))
                .unwrap();
            until(cx, main, settings, &scope, |m| {
                !m.probe_state().1 && m.probe_state().4.is_none()
            });
            assert_eq!(server.puts(), 2);
            server.seen.lock().unwrap().mode = Mode::Conflict;
            cx.update_window(settings, |_, w, cx| w.click("scope-all", cx))
                .unwrap();
            settle(cx, settings);
            cx.update_window(settings, |_, w, cx| w.click("scope-model-p/two", cx))
                .unwrap();
            settle(cx, settings);
            cx.update_window(settings, |_, w, cx| w.click("scope-save", cx))
                .unwrap();
            until(cx, main, settings, &scope, |m| {
                !m.probe_state().1 && m.probe_state().2
            });
            assert_eq!(server.puts(), 3);
            cx.update(|cx| assert_eq!(cx.theme().is_dark(), mode == ThemeMode::Dark));
            if let Some(d) = &dir {
                cx.capture_screenshot(settings)
                    .unwrap()
                    .save(d.join(format!(
                        "{}-{}-scope-conflict.png",
                        width as u32,
                        mode.name()
                    )))
                    .unwrap();
            }
            cx.update_window(settings, |_, w, cx| {
                assert_eq!(w.find("scope-save").disabled(), Some(true));
                w.click("scope-check", cx);
            })
            .unwrap();
            until(cx, main, settings, &scope, |m| !m.probe_state().1);
            assert_eq!(server.puts(), 3);
            cx.update_window(settings, |_, w, cx| w.click("scope-revert", cx))
                .unwrap();
            settle(cx, settings);
            cx.update_window(settings, |_, w, cx| w.click("scope-revert", cx))
                .unwrap();
            settle(cx, main);
            settle(cx, settings);
            assert_eq!(
                cx.update(|cx| scope.read(cx).probe_state().4),
                Some(vec!["p/elsewhere".into()])
            );
            assert_eq!(server.puts(), 3);
            click(cx, settings, "scope-advanced");
            cx.update_window(settings, |_, w, cx| {
                let patterns = scope.read(cx).patterns.clone();
                patterns.update(cx, |t, cx| {
                    t.focus(w, cx);
                    t.replace_and_mark_text_in_range(None, "にほん", Some(3..3), w, cx);
                });
                let before = patterns.read(cx).value();
                w.press("secondary-s", cx);
                w.press("secondary-w", cx);
                w.click("scope-check", cx);
                assert_eq!(patterns.read(cx).value(), before);
                assert!(patterns.update(cx, |t, cx| t.marked_text_range(w, cx).is_some()));
                patterns.update(cx, |t, cx| t.unmark_text(w, cx));
                w.press("secondary-a", cx);
                w.input("p/*:high\np/未提供\np/未提供", cx);
                assert_eq!(
                    patterns.read(cx).value().as_ref(),
                    "p/*:high\np/未提供\np/未提供"
                );
            })
            .unwrap();
            settle(cx, settings);
            assert_eq!(server.puts(), 3);
            server.seen.lock().unwrap().mode = Mode::ReadbackFailure;
            click(cx, settings, "scope-save");
            until(cx, main, settings, &scope, |m| {
                !m.probe_state().1 && m.probe_state().2
            });
            assert_eq!(server.puts(), 4);
            cx.update(|cx| assert_eq!(cx.theme().is_dark(), mode == ThemeMode::Dark));
            cx.update_window(settings, |_, w, cx| w.press("secondary-w", cx))
                .unwrap();
            settle(cx, settings);
            assert!(
                cx.update(|cx| view.read(cx).settings_window.is_some()),
                "unconfirmed save refuses close"
            );
            if let Some(d) = &dir {
                cx.capture_screenshot(settings)
                    .unwrap()
                    .save(d.join(format!(
                        "{}-{}-scope-unconfirmed.png",
                        width as u32,
                        mode.name()
                    )))
                    .unwrap();
            }
            click(cx, settings, "scope-check");
            until(cx, main, settings, &scope, |m| !m.probe_state().1);
            assert_eq!(server.puts(), 4);
            server.seen.lock().unwrap().mode = Mode::Accept;
            click(cx, settings, "scope-check");
            until(cx, main, settings, &scope, |m| {
                !m.probe_state().1 && !m.probe_state().2
            });
            let desired = Some(vec![
                "p/*:high".into(),
                "p/未提供".into(),
                "p/未提供".into(),
            ]);
            assert_eq!(cx.update(|cx| scope.read(cx).probe_state().4), desired);
            assert_eq!(server.seen.lock().unwrap().patterns, desired);
            assert_eq!(server.puts(), 4);
            if let Some(d) = &dir {
                cx.capture_screenshot(settings)
                    .unwrap()
                    .save(d.join(format!(
                        "{}-{}-scope-literal.png",
                        width as u32,
                        mode.name()
                    )))
                    .unwrap();
            }
            server.seen.lock().unwrap().mode = Mode::Lost;
            click(cx, settings, "scope-all");
            click(cx, settings, "scope-save");
            until(cx, main, settings, &scope, |m| {
                !m.probe_state().1 && m.probe_state().4.is_none()
            });
            assert_eq!(server.puts(), 5);
            cx.update(|cx| {
                let v = view.read(cx);
                assert!(v.editor == editor && v.transcript == transcript);
                assert_eq!(
                    unsent.read(cx).value().as_ref(),
                    "Retained unsent 日本語 👩‍💻"
                );
                scope.read(cx).disconnect_fixture();
            });
            until(cx, main, settings, &scope, |m| m.probe_state().3);
            cx.update_window(settings, |_, w, _| w.remove_window())
                .unwrap();
            cx.update_window(main, |_, w, _| w.remove_window()).unwrap();
            println!(
                "{}",
                serde_json::json!({"width":width,"mode":mode.name(),"actual_settings_window":true,"read_only_open":true,"explicit_scope_puts":server.puts(),"mandatory_readback":true,"close_reopen_worker":true,"conflict_check_zero_retry":true,"native_preedit_guards":true,"literal_order_duplicates_suffix":true,"unconfirmed_get_only_recovery":true,"lost_put_readback":true,"no_chat_mutations":true,"retained_editor_reader_unsent_text":true})
            );
        }
    }
}
