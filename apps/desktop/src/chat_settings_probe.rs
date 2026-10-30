//! Actual LocalViewer Settings window over an owned faux chat-settings daemon only.
use super::*;
use crate::{
    chat_settings::{Note, Phase},
    chat_settings_fixture::{Mode, Server},
    chat_settings_view::ChatSettings,
};
use gpui_kit::{
    AnyWindowHandle, Bounds, HeadlessAppContext, WindowBounds, WindowOptions,
    component::{ActiveTheme, ThemeMode},
    size,
    test::TestWindowExt,
};
use serde_json::json;
use std::{path::PathBuf, time::Instant};

const HEIGHT: f32 = 620.;

fn settle(cx: &mut HeadlessAppContext, h: AnyWindowHandle) {
    for _ in 0..4 {
        cx.run_until_parked();
        cx.advance_clock(Duration::from_millis(16));
        cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
    }
}
fn until(
    cx: &mut HeadlessAppContext,
    settings: AnyWindowHandle,
    chats: &Entity<ChatSettings>,
    f: impl Fn((Phase, Option<bool>, Option<Note>)) -> bool,
) {
    let end = Instant::now() + Duration::from_secs(8);
    while !cx.update(|cx| f(chats.read(cx).probe_state())) {
        assert!(Instant::now() < end, "bounded chat-settings reply");
        settle(cx, settings);
        std::thread::yield_now();
    }
    settle(cx, settings);
}
fn idle(state: (Phase, Option<bool>, Option<Note>)) -> bool {
    state.0 == Phase::Idle
}
fn capture(cx: &mut HeadlessAppContext, h: AnyWindowHandle, dir: &Option<PathBuf>, name: String) {
    if let Some(d) = dir {
        cx.capture_screenshot(h)
            .unwrap()
            .save(d.join(name))
            .unwrap();
    }
}
fn open_viewer(
    cx: &mut HeadlessAppContext,
    width: f32,
    source: Option<&Server>,
) -> (AnyWindowHandle, Entity<LocalViewer>) {
    let options = source.map(|s| s.options.clone());
    let (main, view) = cx.update(|cx| {
        gpui_kit::open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                    Default::default(),
                    size(px(width), px(HEIGHT)),
                ))),
                show: false,
                focus: false,
                ..Default::default()
            },
            cx,
            |w, cx| {
                cx.new(|cx| {
                    let mut v = LocalViewer::preview(PreviewState::Conversation, w, cx);
                    if let Some(options) = options {
                        let chats = cx.new(|cx| ChatSettings::new(Some(options), cx));
                        v.settings.update(cx, |p, _| p.chats = Some(chats));
                    }
                    v.settings_fixture_size = Some(size(px(width), px(HEIGHT)));
                    v
                })
            },
        )
        .unwrap()
    });
    settle(cx, main);
    (main, view)
}
fn open_settings(
    cx: &mut HeadlessAppContext,
    main: AnyWindowHandle,
    view: &Entity<LocalViewer>,
) -> AnyWindowHandle {
    cx.update_window(main, |_, w, cx| w.press("secondary-,", cx))
        .unwrap();
    settle(cx, main);
    let settings = cx.update(|cx| {
        view.read(cx)
            .settings_window
            .expect("Cmd-comma opens Settings")
    });
    settle(cx, settings);
    settings
}
fn tab_to(cx: &mut HeadlessAppContext, h: AnyWindowHandle, target: &'static str) {
    for _ in 0..12 {
        cx.update_window(h, |_, w, cx| w.press("tab", cx)).unwrap();
        settle(cx, h);
        if cx
            .update_window(h, |_, w, _| w.find(target).focused() == Some(true))
            .unwrap()
        {
            return;
        }
    }
    panic!("Tab never reached {target}");
}

pub fn run_chat_settings_probe(cx: &mut HeadlessAppContext) {
    let dir = std::env::var_os("PILOT_NEXT_CHAT_SETTINGS_DIR").map(PathBuf::from);
    if let Some(d) = &dir {
        std::fs::create_dir_all(d).unwrap();
    }
    // A synthetic window without daemon authority says so and never shows a value.
    {
        let (main, view) = open_viewer(cx, 1100., None);
        let settings = open_settings(cx, main, &view);
        cx.update_window(settings, |_, w, cx| w.click("settings-chats", cx))
            .unwrap();
        settle(cx, settings);
        cx.update_window(settings, |_, w, _| {
            assert!(w.try_find("chat-auto-handoff").is_none());
            assert!(w.try_find("chat-auto-handoff-unknown").is_none());
        })
        .unwrap();
        cx.update_window(settings, |_, w, _| w.remove_window())
            .unwrap();
        cx.update_window(main, |_, w, _| w.remove_window()).unwrap();
    }
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            let name = |state: &str| format!("{}-{}-{state}.png", width as u32, mode.name());
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
            let server = Server::start(Mode::Accept);
            let (main, view) = open_viewer(cx, width, Some(&server));
            let settings = open_settings(cx, main, &view);
            let (pane, chats) = cx.update(|cx| {
                let v = view.read(cx);
                (
                    v.settings_pane.as_ref().unwrap().upgrade().unwrap(),
                    v.settings.read(cx).chats.clone().unwrap(),
                )
            });
            assert_eq!(
                server.state.lock().unwrap().requests.len(),
                0,
                "opening Settings does not contact the daemon"
            );
            // Keyboard: Appearance, then Down and Return to Chats.
            cx.update_window(settings, |_, w, cx| {
                pane.update(cx, |p, cx| p.focus_categories(w, cx));
                w.press("down", cx);
                w.press("enter", cx);
            })
            .unwrap();
            until(cx, settings, &chats, |s| idle(s) && s.1.is_some());
            assert_eq!(cx.update(|cx| chats.read(cx).probe_state().1), Some(false));
            {
                let s = server.state.lock().unwrap();
                assert_eq!(
                    (s.count("GET"), s.count("PATCH")),
                    (1, 0),
                    "read once, no write on load"
                );
            }
            cx.update_window(settings, |_, w, _| {
                let root = w.find("settings-root").bounds();
                assert_eq!(root.size, size(px(width), px(HEIGHT)));
                let control = w.find("chat-auto-handoff");
                assert_eq!(control.checked(), Some(false), "{control:?}");
                assert_ne!(control.disabled(), Some(true));
                assert!(
                    control.bounds().right() <= root.right()
                        && control.bounds().bottom() <= root.bottom()
                );
                assert!(w.try_find("chat-settings-note").is_none());
            })
            .unwrap();
            capture(cx, settings, &dir, name("chats-off"));

            // Revisiting an acknowledged page rereads external changes without writing.
            {
                let mut state = server.state.lock().unwrap();
                state.auto_handoff = true;
                state.revision = 2;
            }
            cx.update_window(settings, |_, w, cx| {
                w.click("settings-appearance", cx);
                w.click("settings-chats", cx);
            })
            .unwrap();
            assert_eq!(
                cx.update(|cx| chats.read(cx).update_hold()),
                None,
                "GET never holds restart"
            );
            until(cx, settings, &chats, idle);
            assert_eq!(cx.update(|cx| chats.read(cx).probe_state().1), Some(true));
            assert_eq!(server.state.lock().unwrap().count("PATCH"), 0);
            {
                let mut state = server.state.lock().unwrap();
                state.auto_handoff = false;
                state.revision = 1;
            }
            cx.update_window(settings, |_, w, cx| {
                w.click("settings-appearance", cx);
                w.click("settings-chats", cx);
            })
            .unwrap();
            until(cx, settings, &chats, idle);
            assert_eq!(cx.update(|cx| chats.read(cx).probe_state().1), Some(false));
            // Keyboard toggle; the box stays at the acknowledged value until the exact ACK.
            server.state.lock().unwrap().hold = true;
            tab_to(cx, settings, "chat-auto-handoff");
            cx.update_window(settings, |_, w, cx| w.press("space", cx))
                .unwrap();
            settle(cx, settings);
            assert_eq!(
                cx.update(|cx| chats.read(cx).probe_state()),
                (Phase::Saving(true), Some(false), None)
            );
            cx.update_window(settings, |_, w, _| {
                let control = w.find("chat-auto-handoff");
                assert_eq!(control.checked(), Some(false), "no optimistic value");
                assert_eq!(control.disabled(), Some(true));
                assert!(w.find("chat-settings-status").visible());
                assert!(
                    w.try_find("chat-settings-note").is_none(),
                    "no Saved before ACK"
                );
            })
            .unwrap();
            cx.update_window(main, |_, w, cx| {
                view.update(cx, |v, cx| {
                    assert_eq!(
                        chats.read(cx).update_hold(),
                        Some(crate::update_hold::Hold::Sending)
                    );
                    assert_eq!(
                        v.update_blocker(w, cx),
                        Some(crate::update_hold::Blocker::ChatSettings)
                    );
                });
            })
            .unwrap();
            // Closing the window retains the owner and its pending PATCH.
            cx.update_window(settings, |_, w, cx| w.press("secondary-w", cx))
                .unwrap();
            settle(cx, main);
            let settings = open_settings(cx, main, &view);
            assert_eq!(
                cx.update(|cx| chats.read(cx).probe_state().0),
                Phase::Saving(true)
            );
            capture(cx, settings, &dir, name("chats-saving"));
            server.state.lock().unwrap().hold = false;
            until(cx, settings, &chats, idle);
            assert_eq!(
                cx.update(|cx| chats.read(cx).probe_state()),
                (Phase::Idle, Some(true), Some(Note::Saved(true)))
            );
            assert_eq!(
                server.state.lock().unwrap().patches(),
                [json!({"autoHandoff":true,"expectedRevision":"r1"})]
            );
            cx.update_window(settings, |_, w, _| {
                assert_eq!(w.find("chat-auto-handoff").checked(), Some(true));
            })
            .unwrap();
            capture(cx, settings, &dir, name("chats-saved"));

            // Changed elsewhere: 409, one read-back, nothing resent.
            server.state.lock().unwrap().mode = Mode::Conflict;
            cx.update_window(settings, |_, w, cx| w.click("chat-auto-handoff", cx))
                .unwrap();
            until(cx, settings, &chats, idle);
            assert_eq!(
                cx.update(|cx| chats.read(cx).probe_state()),
                (Phase::Idle, Some(true), Some(Note::Conflict))
            );
            capture(cx, settings, &dir, name("chats-conflict"));

            // Daemon could not confirm its write: Unknown, no box, read-only recovery.
            server.state.lock().unwrap().mode = Mode::Unavailable;
            cx.update_window(settings, |_, w, cx| w.click("chat-auto-handoff", cx))
                .unwrap();
            until(cx, settings, &chats, idle);
            assert_eq!(
                cx.update(|cx| chats.read(cx).probe_state()),
                (Phase::Idle, None, Some(Note::Unknown(false)))
            );
            cx.update_window(settings, |_, w, _| {
                assert!(w.try_find("chat-auto-handoff").is_none());
                assert!(w.find("chat-auto-handoff-unknown").visible());
                assert!(w.find("chat-settings-check").visible());
            })
            .unwrap();
            cx.update_window(main, |_, w, cx| {
                view.update(cx, |v, cx| {
                    assert_eq!(chats.read(cx).update_hold(), None);
                    assert_eq!(
                        v.update_blocker(w, cx),
                        None,
                        "retained Unknown is not pending"
                    );
                });
            })
            .unwrap();
            capture(cx, settings, &dir, name("chats-unknown"));
            {
                let s = server.state.lock().unwrap();
                assert_eq!((s.count("GET"), s.count("PATCH")), (4, 3));
            }
            // The checkbox disappeared; keyboard recovery remains reachable.
            tab_to(cx, settings, "chat-settings-check");
            // Cmd-S on this page never writes.
            cx.update_window(settings, |_, w, cx| w.press("secondary-s", cx))
                .unwrap();
            settle(cx, settings);
            assert_eq!(server.state.lock().unwrap().count("PATCH"), 3);

            // Close and reopen: the retained owner rereads the unknown value, nothing more.
            cx.update_window(settings, |_, w, cx| w.press("secondary-w", cx))
                .unwrap();
            settle(cx, main);
            assert!(cx.update(|cx| view.read(cx).settings_window.is_none()));
            server.state.lock().unwrap().mode = Mode::Accept;
            let settings = open_settings(cx, main, &view);
            until(cx, settings, &chats, |s| idle(s) && s.1.is_some());
            assert_eq!(
                cx.update(|cx| chats.read(cx).probe_state()),
                (Phase::Idle, Some(true), None)
            );
            {
                let s = server.state.lock().unwrap();
                assert_eq!((s.count("GET"), s.count("PATCH")), (5, 3));
            }

            // An older daemon without the route is Unavailable, never shown as off.
            let older = Server::start(Mode::Unsupported);
            let replaced =
                cx.update(|cx| cx.new(|cx| ChatSettings::new(Some(older.options.clone()), cx)));
            cx.update(|cx| {
                view.read(cx)
                    .settings
                    .clone()
                    .update(cx, |p, _| p.chats = Some(replaced.clone()))
            });
            cx.update_window(settings, |_, w, cx| {
                w.click("settings-appearance", cx);
                w.click("settings-chats", cx);
            })
            .unwrap();
            until(cx, settings, &replaced, |s| idle(s) && s.2.is_some());
            assert_eq!(
                cx.update(|cx| replaced.read(cx).probe_state()),
                (Phase::Idle, None, Some(Note::Unsupported))
            );
            cx.update_window(settings, |_, w, _| {
                assert!(w.try_find("chat-auto-handoff").is_none());
                assert!(w.find("chat-settings-note").visible());
            })
            .unwrap();
            assert_eq!(older.state.lock().unwrap().count("PATCH"), 0);
            capture(cx, settings, &dir, name("chats-unavailable"));
            cx.update(|cx| assert_eq!(cx.theme().is_dark(), mode == ThemeMode::Dark));

            // Settled page has no redraw clock.
            let pane = cx.update(|cx| {
                view.read(cx)
                    .settings_pane
                    .as_ref()
                    .unwrap()
                    .upgrade()
                    .unwrap()
            });
            cx.run_until_parked();
            let renders = cx.update(|cx| pane.read(cx).render_count);
            cx.advance_clock(Duration::from_secs(1));
            cx.run_until_parked();
            assert_eq!(renders, cx.update(|cx| pane.read(cx).render_count));

            cx.update_window(settings, |_, w, _| w.remove_window())
                .unwrap();
            cx.update_window(main, |_, w, _| w.remove_window()).unwrap();
            println!(
                "{}",
                json!({"width":width,"mode":mode.name(),"actual_settings_window":true,"read_once_on_open":true,"no_optimistic_value":true,"exact_ack_saved":true,"conflict_readback":true,"unknown_after_503":true,"older_daemon_unavailable":true,"keyboard_category_and_toggle":true,"close_reopen_retained":true})
            );
        }
    }
}
