//! Real Settings window project pages over a synthetic project daemon. No real profile or data.
use super::*;
use crate::{
    project_settings::Status,
    project_settings_fixture::{Reply, Server, project},
    project_settings_view::ProjectSettings,
    settings_view::{Category, SettingsPreferences},
};
use gpui_kit::{
    AnyWindowHandle, Bounds, EntityInputHandler, Focusable, HeadlessAppContext, WindowBounds,
    WindowOptions,
    component::{Theme, ThemeMode},
    size,
    test::TestWindowExt,
};
use std::{path::PathBuf, time::Instant};

fn settle(cx: &mut HeadlessAppContext, handle: AnyWindowHandle) {
    for _ in 0..6 {
        cx.advance_clock(Duration::from_millis(16));
        cx.run_until_parked();
        cx.update_window(handle, |_, window, cx| window.render_frame(cx))
            .unwrap();
    }
}
fn await_until(
    cx: &mut HeadlessAppContext,
    handle: AnyWindowHandle,
    what: &str,
    predicate: impl Fn(&mut gpui_kit::App) -> bool,
) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !cx.update(|cx| predicate(cx)) {
        assert!(Instant::now() < deadline, "bounded wait: {what}");
        cx.run_until_parked();
        cx.advance_clock(Duration::from_millis(16));
        std::thread::sleep(Duration::from_millis(2));
    }
    settle(cx, handle);
}
fn capture(
    cx: &mut HeadlessAppContext,
    handle: AnyWindowHandle,
    dir: &Option<PathBuf>,
    name: String,
) {
    if let Some(dir) = dir {
        cx.capture_screenshot(handle)
            .unwrap()
            .save(dir.join(name))
            .unwrap();
    }
}
/// What the daemon would broadcast after a change: its current project list.
fn broadcast(
    cx: &mut HeadlessAppContext,
    main: AnyWindowHandle,
    viewer: &Entity<LocalViewer>,
    server: &Server,
) {
    let list: Vec<_> = server
        .state
        .lock()
        .unwrap()
        .projects
        .values()
        .cloned()
        .collect();
    let rows = crate::local_model::projects(&serde_json::Value::Array(list)).unwrap();
    cx.update_window(main, |_, window, cx| {
        viewer.update(cx, |view, cx| {
            view.state.projects = Arc::new(rows);
            view.rebuild_nav(window, cx);
        })
    })
    .unwrap();
}
fn status(cx: &mut HeadlessAppContext, owner: &Entity<ProjectSettings>, id: &str) -> Status {
    cx.update(|cx| owner.read(cx).editor(id).unwrap().status().clone())
}
fn inside(window: &Window, id: &'static str, height: f32) {
    let detail = window.find("settings-detail").bounds();
    let b = window.find(id).bounds();
    assert!(
        b.left() >= detail.left()
            && b.right() <= detail.right()
            && b.top() >= px(0.)
            && b.bottom() <= px(height),
        "{id} inside the Settings detail"
    );
}

pub fn run_project_settings_probe(cx: &mut HeadlessAppContext) {
    // Tall enough that every control is on screen at 680pt; scrolling is the existing page's.
    const HEIGHT: f32 = 980.;
    let captures = std::env::var_os("PILOT_NEXT_PROJECT_SETTINGS_DIR").map(PathBuf::from);
    if let Some(dir) = &captures {
        std::fs::create_dir_all(dir).unwrap();
    }
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            let shot = |state: &str| format!("{}-{}-{state}.png", width as u32, mode.name());
            let long = "Atlas 日本語 👩‍💻 e\u{301} with a deliberately long project name";
            let server = Server::start(&[project("proj-a", long), project("proj-b", "Boreal")]);
            cx.update(|cx| Theme::change(mode, None, cx));
            let owner =
                cx.update(|cx| cx.new(|_| ProjectSettings::new(Some(server.options.clone()))));
            let (main, viewer) = cx
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
                        |window, cx| {
                            let owner = owner.clone();
                            cx.new(|cx| {
                                let mut view =
                                    LocalViewer::preview(PreviewState::Conversation, window, cx);
                                view.settings = cx.new(|_| SettingsPreferences::new(None));
                                view.settings.update(cx, |o, cx| {
                                    o.projects = Some(owner);
                                    o.load(cx);
                                });
                                // Preview preferences follow the OS; pin the captured theme.
                                crate::appearance::commit_appearance(
                                    if mode == ThemeMode::Dark {
                                        crate::settings_state::AppearancePreference::Dark
                                    } else {
                                        crate::settings_state::AppearancePreference::Light
                                    },
                                    cx,
                                );
                                view.settings_fixture_size = Some(size(px(width), px(HEIGHT)));
                                view.state.projects_loaded = true;
                                view
                            })
                        },
                    )
                })
                .unwrap();
            broadcast(cx, main, &viewer, &server);
            let (reader, selected, page) = cx.update(|cx| {
                let v = viewer.read(cx);
                (v.transcript.entity_id(), v.selected.clone(), v.page.clone())
            });
            cx.update_window(main, |_, window, cx| {
                viewer.update(cx, |v, cx| {
                    v.open_project_settings("proj-a".into(), window, cx)
                })
            })
            .unwrap();
            settle(cx, main);
            let handle = cx.update(|cx| {
                viewer
                    .read(cx)
                    .settings_window
                    .expect("Settings opens on the project")
            });
            settle(cx, handle);
            let prefs = cx.update(|cx| viewer.read(cx).settings.clone());
            cx.update(|cx| {
                assert_eq!(prefs.read(cx).category, Category::Project);
                assert_eq!(owner.read(cx).selected.as_deref(), Some("proj-a"));
            });
            cx.update_window(handle, |_, window, _| {
                for id in [
                    "project-settings-name",
                    "project-settings-folder",
                    "project-settings-branch",
                    "project-settings-isolated",
                    "project-settings-pull-request",
                    "settings-project-proj-a",
                    "settings-projects-heading",
                ] {
                    assert!(window.find(id).visible(), "{id}");
                }
                for id in [
                    "project-settings-name",
                    "project-settings-path",
                    "project-settings-isolated",
                ] {
                    inside(window, id, HEIGHT);
                }
                assert!(
                    window.try_find("project-settings-save").is_none(),
                    "Save appears only once dirty"
                );
                assert!(window.try_find("project-settings-revert").is_none());
            })
            .unwrap();
            capture(cx, handle, &captures, shot("clean"));

            // Pointer toggle, then Revert restores the daemon value without a request.
            cx.update_window(handle, |_, window, cx| {
                window.click("project-settings-isolated", cx)
            })
            .unwrap();
            settle(cx, handle);
            cx.update_window(handle, |_, window, _| {
                assert!(window.find("project-settings-save").visible());
                assert!(window.find("project-settings-status").visible());
            })
            .unwrap();
            capture(cx, handle, &captures, shot("dirty"));
            cx.update_window(handle, |_, window, cx| {
                window.click("project-settings-revert", cx)
            })
            .unwrap();
            settle(cx, handle);
            cx.update(|cx| assert!(!owner.read(cx).editor("proj-a").unwrap().dirty()));

            // IME: marked text blocks Cmd-S; committed Unicode saves exactly once.
            let name = cx.update(|cx| owner.read(cx).name_for_probe("proj-a").unwrap());
            cx.update_window(handle, |_, window, cx| {
                name.focus_handle(cx).focus(window, cx);
                name.update(cx, |i, cx| {
                    i.set_value("", window, cx);
                    i.replace_and_mark_text_in_range(None, "にほん", Some(3..3), window, cx);
                });
                window.press("secondary-s", cx);
            })
            .unwrap();
            settle(cx, handle);
            assert!(
                server.state.lock().unwrap().patches().is_empty(),
                "no save during composition"
            );
            cx.update_window(handle, |_, window, cx| {
                name.update(cx, |i, cx| {
                    assert!(
                        i.marked_text_range(window, cx).is_some(),
                        "preedit retained"
                    );
                    i.replace_text_in_range(None, "日本 Renamed 👩‍💻", window, cx);
                });
            })
            .unwrap();
            settle(cx, handle);
            cx.update_window(handle, |_, window, cx| {
                window.click("project-settings-pull-request", cx)
            })
            .unwrap();
            settle(cx, handle);
            cx.update(|cx| {
                let e = owner.read(cx).editor("proj-a").unwrap();
                assert_eq!(e.draft().name, "日本 Renamed 👩‍💻");
                assert!(!e.draft().require_pull_request);
            });
            capture(cx, handle, &captures, shot("widening"));
            cx.update_window(handle, |_, window, cx| window.press("secondary-s", cx))
                .unwrap();
            await_until(cx, handle, "save acknowledged", |cx| {
                owner.read(cx).editor("proj-a").is_some_and(|e| !e.saving())
            });
            assert_eq!(status(cx, &owner, "proj-a"), Status::Idle);
            {
                let state = server.state.lock().unwrap();
                assert_eq!(
                    state.patches(),
                    [serde_json::json!({"name":"日本 Renamed 👩‍💻","requirePullRequest":false})]
                );
                assert_eq!(
                    state.projects["proj-a"]["tracking"],
                    serde_json::json!({"slackChannels":["C1"]})
                );
            }
            broadcast(cx, main, &viewer, &server);
            settle(cx, handle);
            cx.update_window(handle, |_, window, _| {
                assert!(
                    window.try_find("project-settings-save").is_none(),
                    "clean after ACK"
                );
            })
            .unwrap();

            // Lost reply: Unknown, edits kept, never repeated; the daemon's record later settles it.
            server.reply("PATCH", "/api/projects/proj-a", Reply::status(None, true));
            cx.update_window(handle, |_, window, cx| {
                window.click("project-settings-isolated", cx);
                window.click("project-settings-save", cx);
            })
            .unwrap();
            await_until(cx, handle, "unknown", |cx| {
                matches!(
                    owner.read(cx).editor("proj-a").unwrap().status(),
                    Status::Unknown(_)
                )
            });
            cx.update(|cx| assert!(owner.read(cx).editor("proj-a").unwrap().dirty()));
            capture(cx, handle, &captures, shot("unknown"));
            cx.advance_clock(Duration::from_secs(5));
            settle(cx, handle);
            assert_eq!(
                server.state.lock().unwrap().patches().len(),
                2,
                "no automatic retry"
            );
            broadcast(cx, main, &viewer, &server);
            settle(cx, handle);
            assert_eq!(status(cx, &owner, "proj-a"), Status::Idle);
            server.state.lock().unwrap().replies.clear();

            // Changed elsewhere while dirty: kept visible; Revert loads theirs.
            cx.update_window(handle, |_, window, cx| {
                window.click("project-settings-isolated", cx)
            })
            .unwrap();
            let mut theirs = server.state.lock().unwrap().projects["proj-a"].clone();
            theirs["name"] = "Theirs".into();
            server.set(theirs);
            broadcast(cx, main, &viewer, &server);
            settle(cx, handle);
            cx.update(|cx| assert!(owner.read(cx).editor("proj-a").unwrap().updated_elsewhere()));
            capture(cx, handle, &captures, shot("elsewhere"));
            cx.update_window(handle, |_, window, cx| {
                window.click("project-settings-revert", cx)
            })
            .unwrap();
            settle(cx, handle);
            cx.update(|cx| {
                assert_eq!(
                    owner.read(cx).editor("proj-a").unwrap().draft().name,
                    "Theirs"
                );
                assert_eq!(
                    name.read(cx).value().as_ref(),
                    "Theirs",
                    "field follows Revert"
                );
            });

            // Keyboard into the Projects section (Boreal sorts first), then B's draft survives switching.
            let pane = cx.update(|cx| {
                viewer
                    .read(cx)
                    .settings_pane
                    .as_ref()
                    .unwrap()
                    .upgrade()
                    .unwrap()
            });
            cx.update_window(handle, |_, window, cx| {
                window.click("settings-diagnostics", cx);
                pane.update(cx, |p, cx| p.focus_categories(window, cx));
                window.press("down", cx);
                window.press("enter", cx);
            })
            .unwrap();
            settle(cx, handle);
            cx.update(|cx| {
                assert_eq!(prefs.read(cx).category, Category::Project);
                assert_eq!(
                    owner.read(cx).selected.as_deref(),
                    Some("proj-b"),
                    "keyboard reaches projects"
                );
            });
            cx.update_window(handle, |_, window, cx| {
                window.click("project-settings-isolated", cx);
                window.click("settings-project-proj-a", cx);
            })
            .unwrap();
            settle(cx, handle);
            cx.update(|cx| {
                assert_eq!(owner.read(cx).selected.as_deref(), Some("proj-a"));
                assert!(owner.read(cx).editor("proj-b").unwrap().dirty());
            });
            cx.update_window(handle, |_, window, cx| {
                window.click("settings-project-proj-b", cx)
            })
            .unwrap();
            settle(cx, handle);

            // Removal keeps the page on B, read-only, with its draft; nothing retargets.
            server.remove("proj-b");
            broadcast(cx, main, &viewer, &server);
            settle(cx, handle);
            cx.update(|cx| {
                let e = owner.read(cx).editor("proj-b").unwrap();
                assert!(e.removed() && e.dirty());
                assert_eq!(owner.read(cx).selected.as_deref(), Some("proj-b"));
            });
            cx.update_window(handle, |_, window, cx| {
                assert!(window.try_find("settings-project-proj-b").is_none());
                assert_eq!(window.find("project-settings-save").disabled(), Some(true));
                assert_eq!(
                    window.find("project-settings-isolated").disabled(),
                    Some(true)
                );
                window.press("secondary-w", cx);
            })
            .unwrap();
            settle(cx, handle);
            capture(cx, handle, &captures, shot("removed"));
            assert!(
                cx.update(|cx| viewer.read(cx).settings_window.is_some()),
                "dirty close refused"
            );
            let patches = server.state.lock().unwrap().patches().len();
            cx.update_window(handle, |_, window, cx| {
                window.click("project-settings-revert", cx);
            })
            .unwrap();
            settle(cx, handle);
            cx.update_window(handle, |_, window, cx| window.press("secondary-w", cx))
                .unwrap();
            drop(pane);
            settle(cx, main);
            assert_eq!(server.state.lock().unwrap().patches().len(), patches);
            cx.update(|cx| {
                let v = viewer.read(cx);
                assert!(v.settings_window.is_none());
                assert_eq!(v.transcript.entity_id(), reader);
                assert_eq!(v.selected, selected);
                assert_eq!(v.page, page);
            });
            cx.update_window(main, |_, window, _| window.remove_window())
                .unwrap();
            cx.run_until_parked();
            drop(viewer);
            drop(server);
            println!(
                "Project settings native {width} {}: exact page, pointer/keyboard/IME, ACK/Unknown/elsewhere/removed, 0 retries",
                mode.name()
            );
        }
    }
}
