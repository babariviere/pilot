//! Actual production Settings/LocalViewer, synthetic private paths and recording clients only.
use super::*;
use crate::{
    settings_state::{
        AppearancePreference, LoadedPreferences, Preferences, SettingsError, SettingsState,
        SettingsStore,
    },
    settings_view::SettingsPreferences,
};
use gpui_kit::{
    AnyWindowHandle, Bounds, EntityInputHandler, Focusable, HeadlessAppContext, WindowBounds,
    WindowOptions,
    component::{Theme, ThemeMode},
    size,
    test::TestWindowExt,
};
use std::{fs, os::unix::fs::PermissionsExt, path::PathBuf, time::Instant};

fn settle(cx: &mut HeadlessAppContext, handle: AnyWindowHandle) {
    for _ in 0..8 {
        cx.advance_clock(Duration::from_millis(16));
        cx.run_until_parked();
        cx.update_window(handle, |_, window, cx| window.render_frame(cx))
            .unwrap();
    }
}
fn await_state(
    cx: &mut HeadlessAppContext,
    handle: AnyWindowHandle,
    owner: &Entity<SettingsPreferences>,
    predicate: impl Fn(&SettingsState) -> bool,
) {
    let deadline = Instant::now() + Duration::from_secs(4);
    while !cx.update(|cx| predicate(&owner.read(cx).state)) {
        assert!(
            Instant::now() < deadline,
            "bounded background Settings completion"
        );
        cx.run_until_parked();
        cx.advance_clock(Duration::from_millis(16));
        std::thread::yield_now();
    }
    settle(cx, handle);
}
fn capture(
    cx: &mut HeadlessAppContext,
    handle: AnyWindowHandle,
    directory: &Option<PathBuf>,
    name: &str,
) {
    if let Some(directory) = directory {
        cx.capture_screenshot(handle)
            .unwrap()
            .save(directory.join(name))
            .unwrap();
    }
}
struct Private(PathBuf);
impl Private {
    fn new(width: u32, mode: ThemeMode) -> Self {
        let path = std::env::temp_dir().canonicalize().unwrap().join(format!(
            "settings-ui-synthetic-{}-{width}-{}",
            std::process::id(),
            mode.name()
        ));
        fs::create_dir(&path).expect("unique private Settings fixture");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        Self(path)
    }
    fn root(&self) -> PathBuf {
        self.0.join("settings")
    }
}
impl Drop for Private {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn screenshot_name(width: f32, mode: ThemeMode, state: &str) -> String {
    format!("{}-{}-{state}.png", width as u32, mode.name())
}
fn loaded(preferences: Preferences) -> SettingsState {
    let mut state = SettingsState::default();
    state.begin_load();
    state.finish_load(Ok(LoadedPreferences {
        preferences,
        persisted: true,
    }));
    state
}

pub fn run_settings_probe(cx: &mut HeadlessAppContext) {
    let captures = std::env::var_os("PILOT_NEXT_SETTINGS_DIR").map(PathBuf::from);
    if let Some(directory) = &captures {
        fs::create_dir_all(directory).unwrap();
    }
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            let temp = Private::new(width as u32, mode);
            let original = Preferences {
                appearance: if mode == ThemeMode::Dark {
                    AppearancePreference::Dark
                } else {
                    AppearancePreference::Light
                },
                ..Default::default()
            };
            let next = if mode == ThemeMode::Dark {
                AppearancePreference::Light
            } else {
                AppearancePreference::Dark
            };
            let mut store = SettingsStore::new(temp.root());
            store.load().unwrap();
            store.save(original).unwrap();
            let original_bytes =
                fs::read(temp.root().join(crate::settings_state::PREFERENCES_FILE)).unwrap();
            cx.update(|cx| Theme::change(mode, None, cx));
            let (writer, writes) = Interaction::recording();
            let (client, reads) = LocalClient::synthetic_commands();
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
                            cx.new(|cx| {
                                let mut view =
                                    LocalViewer::preview(PreviewState::Conversation, window, cx);
                                view.client = Some(client);
                                view.writer = Some(writer.clone());
                                view.editor.update(cx, |editor, cx| {
                                    editor.shell_probe_setup(writer, window, cx)
                                });
                                view.settings =
                                    cx.new(|_| SettingsPreferences::new(Some(Ok(temp.root()))));
                                view.settings_fixture_size = Some(size(px(width), px(620.)));
                                view.project_scope = Some("settings-scope-a".into());
                                view.state.projects_loaded = true;
                                view.state.projects = Arc::new(crate::local_model::projects(&serde_json::json!([
                                    {"id":"settings-scope-a","name":"Atlas","path":"/synthetic/shared-path"},
                                    {"id":"settings-scope-b","name":"Boreal","path":"/synthetic/shared-path"}
                                ])).unwrap());
                                let mut chats = view.state.chats.as_ref().clone();
                                for chat in &mut chats { chat.project_id = Some("settings-scope-a".into()); }
                                view.state.chats = Arc::new(chats);
                                view.rebuild_nav(window, cx);
                                view.settings.update(cx, |owner, cx| owner.load(cx));
                                view
                            })
                        },
                    )
                })
                .unwrap();
            let owner = cx.update(|cx| viewer.read(cx).settings.clone());
            await_state(cx, main, &owner, SettingsState::loaded);
            capture(
                cx,
                main,
                &captures,
                &screenshot_name(width, mode, "before-open"),
            );
            let (editor, reader, selected, generation, page, project) = cx.update(|cx| {
                let view = viewer.read(cx);
                (
                    view.editor.read(cx).shell_probe().0,
                    view.transcript.entity_id(),
                    view.selected.clone(),
                    view.generation,
                    view.page.clone(),
                    view.project_scope.clone(),
                )
            });
            // Native marked-text guard: both pointer and Cmd-comma leave preedit intact.
            let marked = cx
                .update_window(main, |_, window, cx| {
                    editor.focus_handle(cx).focus(window, cx);
                    editor.update(cx, |input, cx| {
                        input.replace_and_mark_text_in_range(None, "にほん", Some(3..3), window, cx)
                    });
                    let marked = editor.update(cx, |input, cx| input.marked_text_range(window, cx));
                    window.click("open-settings", cx);
                    window.press("secondary-,", cx);
                    marked
                })
                .unwrap();
            settle(cx, main);
            cx.update_window(main, |_, window, cx| {
                assert!(viewer.read(cx).settings_window.is_none());
                editor.update(cx, |input, cx| {
                    assert_eq!(input.marked_text_range(window, cx), marked);
                    input.replace_text_in_range(None, "kept draft 👩‍💻", window, cx);
                });
                window.press("secondary-,", cx);
            })
            .unwrap();
            settle(cx, main);
            let (handle, pane) = cx.update(|cx| {
                let view = viewer.read(cx);
                (
                    view.settings_window.expect("Cmd-comma opens real Settings"),
                    view.settings_pane.as_ref().unwrap().upgrade().unwrap(),
                )
            });
            settle(cx, handle);
            cx.update_window(handle, |_, window, _| {
                assert_eq!(window.viewport_size(), size(px(width), px(620.)));
                assert_eq!(window.find("settings-root").bounds().size, size(px(width), px(620.)), "mounted root must match the requested fixture, not only the platform framebuffer");
            }).unwrap();
            capture(
                cx,
                handle,
                &captures,
                &screenshot_name(width, mode, "appearance"),
            );
            // A removed project with a same-path neighbor must not retarget this global form.
            cx.update_window(main, |_, window, cx| {
                viewer.update(cx, |view, cx| {
                    view.state.projects = Arc::new(vec![view.state.projects[1].clone()]);
                    view.rebuild_nav(window, cx);
                    assert_eq!(view.project_scope.as_deref(), Some("settings-scope-a"));
                    cx.notify();
                });
            })
            .unwrap();
            cx.update_window(handle, |_, window, cx| {
                let detail = window.find("settings-detail").bounds();
                for id in [
                    "settings-system",
                    "settings-light",
                    "settings-dark",
                    "settings-save",
                    "settings-revert",
                ] {
                    let bounds = window.find(id).bounds();
                    assert!(
                        bounds.left() >= detail.left()
                            && bounds.right() <= detail.right()
                            && bounds.top() >= px(0.)
                            && bounds.bottom() <= px(620.),
                        "{id} mounted inside Settings detail"
                    );
                }
                assert_eq!(window.find("settings-save").disabled(), Some(true));
                window.click(
                    if next == AppearancePreference::Dark {
                        "settings-dark"
                    } else {
                        "settings-light"
                    },
                    cx,
                );
            })
            .unwrap();
            settle(cx, handle);
            cx.update(|cx| {
                assert!(owner.read(cx).state.dirty());
                assert_eq!(
                    cx.theme().is_dark(),
                    mode == ThemeMode::Dark,
                    "unsaved selection does not apply theme"
                );
                assert_eq!(owner.read(cx).state.current().appearance, next);
            });
            assert_eq!(
                fs::read(temp.root().join(crate::settings_state::PREFERENCES_FILE)).unwrap(),
                original_bytes
            );
            cx.update_window(handle, |_, window, cx| {
                window.press("secondary-w", cx);
            })
            .unwrap();
            settle(cx, handle);
            assert!(
                cx.update(|cx| viewer.read(cx).settings_window.is_some()),
                "dirty close is refused, not silently discarded"
            );
            // Real save failure followed by real Retry. Never alter a production path.
            let obstacle = temp.root().join(".preferences-v1.pending");
            fs::write(&obstacle, b"synthetic recovery obstacle").unwrap();
            cx.update_window(handle, |_, window, cx| window.click("settings-save", cx))
                .unwrap();
            await_state(cx, handle, &owner, |state| {
                !state.saving() && state.error().is_some()
            });
            assert_eq!(
                cx.update(|cx| owner.read(cx).state.error()),
                Some(SettingsError::RecoveryRequired)
            );
            assert_eq!(
                fs::read(temp.root().join(crate::settings_state::PREFERENCES_FILE)).unwrap(),
                original_bytes
            );
            capture(
                cx,
                handle,
                &captures,
                &screenshot_name(width, mode, "save-error"),
            );
            fs::remove_file(&obstacle).unwrap();
            cx.update_window(handle, |_, window, cx| window.click("settings-save", cx))
                .unwrap();
            await_state(cx, handle, &owner, |state| {
                state.persisted() && !state.saving()
            });
            cx.update(|cx| assert_eq!(cx.theme().is_dark(), next == AppearancePreference::Dark));
            assert_eq!(
                SettingsStore::new(temp.root())
                    .load()
                    .unwrap()
                    .preferences
                    .appearance,
                next
            );
            // Return to the declared capture mode through the real durable UI path.
            cx.update_window(handle, |_, window, cx| {
                window.click(
                    if original.appearance == AppearancePreference::Dark {
                        "settings-dark"
                    } else {
                        "settings-light"
                    },
                    cx,
                );
                window.press("secondary-s", cx);
            })
            .unwrap();
            await_state(cx, handle, &owner, |state| {
                state.persisted() && !state.saving()
            });
            cx.update(|cx| assert_eq!(cx.theme().is_dark(), mode == ThemeMode::Dark));
            cx.update_window(handle, |_, window, cx| {
                window.click("settings-system", cx);
                window.click("settings-revert", cx);
            })
            .unwrap();
            settle(cx, handle);
            assert_eq!(
                cx.update(|cx| owner.read(cx).state.current().appearance),
                original.appearance
            );
            // Actual category pointer+keyboard navigation; unavailable is not fake controls.
            cx.update_window(handle, |_, window, cx| window.click("settings-updates", cx))
                .unwrap();
            settle(cx, handle);
            cx.update_window(handle, |_, window, _| {
                assert!(window.try_find("settings-save").is_none());
                assert!(window.try_find("settings-theme-field").is_none());
                assert!(window.find("settings-page-title").visible());
            })
            .unwrap();
            cx.update_window(handle, |_, window, cx| {
                assert!(window.find("updates-automatic").visible());
                assert!(window.find("updates-check").visible());
                assert!(window.try_find("updates-install").is_none());
                window.click("updates-automatic", cx);
            })
            .unwrap();
            settle(cx, handle);
            cx.update(|cx| {
                assert!(owner.read(cx).state.dirty());
                assert!(owner.read(cx).state.current().automatic_update_checks);
            });
            cx.update_window(handle, |_, window, cx| window.click("settings-save", cx))
                .unwrap();
            await_state(cx, handle, &owner, |state| {
                state.persisted() && state.current().automatic_update_checks
            });
            cx.update_window(handle, |_, window, cx| {
                window.click("updates-automatic", cx)
            })
            .unwrap();
            settle(cx, handle);
            cx.update_window(handle, |_, window, cx| window.click("settings-save", cx))
                .unwrap();
            await_state(cx, handle, &owner, |state| {
                state.persisted() && !state.current().automatic_update_checks
            });
            capture(
                cx,
                handle,
                &captures,
                &screenshot_name(width, mode, "updates-unavailable"),
            );
            cx.update_window(handle, |_, window, cx| {
                pane.update(cx, |pane, cx| pane.focus_categories(window, cx));
                window.press("down", cx);
                window.press("enter", cx);
            })
            .unwrap();
            settle(cx, handle);
            cx.update(|cx| {
                assert_eq!(
                    owner.read(cx).category,
                    crate::settings_view::Category::Availability
                )
            });
            cx.update_window(handle, |_, window, cx| {
                window.click("settings-appearance", cx);
            })
            .unwrap();
            settle(cx, handle);
            pane.update(cx, |pane, cx| {
                pane.long_labels = true;
                cx.notify();
            });
            settle(cx, handle);
            capture(
                cx,
                handle,
                &captures,
                &screenshot_name(width, mode, "long-label"),
            );
            pane.update(cx, |pane, cx| {
                pane.long_labels = false;
                cx.notify();
            });
            state_scenes(
                cx,
                handle,
                &owner,
                &captures,
                width,
                mode,
                original.appearance,
            );
            // Restore a valid loaded controller only after no real I/O remains in flight.
            owner.update(cx, |owner, cx| {
                owner.state = loaded(original);
                cx.notify();
            });
            settle(cx, handle);
            cx.run_until_parked();
            let idle = cx.update(|cx| pane.read(cx).render_count);
            cx.advance_clock(Duration::from_secs(1));
            cx.run_until_parked();
            assert_eq!(
                idle,
                cx.update(|cx| pane.read(cx).render_count),
                "settled Settings has no redraw clock"
            );
            cx.update_window(handle, |_, window, cx| window.press("secondary-w", cx))
                .unwrap();
            drop(pane);
            settle(cx, main);
            cx.update_window(main, |_, window, cx| {
                let view = viewer.read(cx);
                assert!(view.settings_window.is_none());
                assert_eq!(view.transcript.entity_id(), reader);
                assert_eq!(view.selected, selected);
                assert_eq!(view.generation, generation);
                assert_eq!(view.page, page);
                assert_eq!(view.project_scope, project);
                assert!(
                    editor.focus_handle(cx).is_focused(window),
                    "return focus restored to original composer"
                );
                assert!(editor.read(cx).value().contains("kept draft 👩‍💻"));
                window.click("open-settings", cx);
            })
            .unwrap();
            settle(cx, main);
            let reopened = cx.update(|cx| viewer.read(cx).settings_window.unwrap());
            settle(cx, reopened);
            assert_eq!(
                cx.update(|cx| owner.read(cx).state.current().appearance),
                original.appearance
            );
            assert!(
                reads.try_recv().is_err() && writes.try_recv().is_err(),
                "Settings navigation never sends canonical chat actions"
            );
            cx.update_window(reopened, |_, window, _| window.remove_window())
                .unwrap();
            cx.update_window(main, |_, window, _| window.remove_window())
                .unwrap();
            cx.run_until_parked();
            drop(viewer);
            drop(owner);
            cx.run_until_parked();
            println!(
                "Settings native {width} {}: real pointer/keyboard/IME guards, durable retry/restart, exact reader/draft/focus, states/bounds/idle, 0 canonical commands",
                mode.name()
            );
        }
    }
}

fn state_scenes(
    cx: &mut HeadlessAppContext,
    handle: AnyWindowHandle,
    owner: &Entity<SettingsPreferences>,
    captures: &Option<PathBuf>,
    width: f32,
    mode: ThemeMode,
    appearance: AppearancePreference,
) {
    owner.update(cx, |owner, cx| {
        owner.state = SettingsState::default();
        owner.state.begin_load();
        cx.notify();
    });
    settle(cx, handle);
    cx.update_window(handle, |_, window, cx| {
        assert_eq!(window.find("settings-dark").disabled(), Some(true));
        window.click("settings-dark", cx);
    })
    .unwrap();
    assert!(!cx.update(|cx| owner.read(cx).state.loaded()));
    capture(
        cx,
        handle,
        captures,
        &screenshot_name(width, mode, "loading-disabled"),
    );
    owner.update(cx, |owner, cx| {
        owner.state = loaded(Preferences {
            appearance,
            ..Default::default()
        });
        owner.state.set_appearance(AppearancePreference::System);
        owner.state.begin_save();
        cx.notify();
    });
    settle(cx, handle);
    cx.update_window(handle, |_, window, _| {
        assert_eq!(window.find("settings-save").disabled(), Some(true))
    })
    .unwrap();
    capture(
        cx,
        handle,
        captures,
        &screenshot_name(width, mode, "saving-disabled"),
    );
    owner.update(cx, |owner, cx| {
        owner.state = SettingsState::default();
        owner.state.begin_load();
        owner.state.finish_load(Ok(LoadedPreferences {
            preferences: Preferences::default(),
            persisted: false,
        }));
        cx.notify();
    });
    settle(cx, handle);
    capture(
        cx,
        handle,
        captures,
        &screenshot_name(width, mode, "missing-default"),
    );
}
