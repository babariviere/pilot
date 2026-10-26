//! Production Settings + transcript + expanded tool output, private synthetic storage.
use crate::{
    model::Message,
    settings_state::{AppearancePreference, Preferences, SettingsStore},
    settings_view::{SettingsPreferences, SettingsView},
    transcript_view::TranscriptView,
    typography,
};
use gpui_kit::{
    AnyWindowHandle, AppContext, Bounds, Entity, HeadlessAppContext, WindowBounds, WindowOptions,
    component::{ActiveTheme, Theme, ThemeMode},
    px, size,
    test::TestWindowExt,
};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    time::{Duration, Instant},
};

fn settle(cx: &mut HeadlessAppContext, h: AnyWindowHandle) {
    for _ in 0..8 {
        cx.run_until_parked();
        cx.advance_clock(Duration::from_millis(16));
        cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
    }
}
fn await_saved(
    cx: &mut HeadlessAppContext,
    h: AnyWindowHandle,
    owner: &Entity<SettingsPreferences>,
) {
    let until = Instant::now() + Duration::from_secs(5);
    while !cx.update(|cx| owner.read(cx).state.persisted() && typography::ready(cx)) {
        assert!(Instant::now() < until, "bounded preferences save");
        settle(cx, h);
        std::thread::yield_now();
    }
    settle(cx, h);
}
fn options(width: f32, height: f32) -> WindowOptions {
    WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(Bounds::new(
            Default::default(),
            size(px(width), px(height)),
        ))),
        show: false,
        focus: false,
        ..Default::default()
    }
}
fn capture(cx: &mut HeadlessAppContext, h: AnyWindowHandle, name: &str) {
    if let Some(root) = std::env::var_os("PILOT_NEXT_FONTS_DIR") {
        fs::create_dir_all(&root).unwrap();
        cx.capture_screenshot(h)
            .unwrap()
            .save(PathBuf::from(root).join(name))
            .unwrap();
    }
}
pub fn run_fonts_probe(cx: &mut HeadlessAppContext) {
    for (width, mode) in [(680., ThemeMode::Light), (1100., ThemeMode::Dark)] {
        cx.update(|cx| {
            typography::commit(Default::default(), cx);
            Theme::change(mode, None, cx);
        });
        let temp = std::env::temp_dir()
            .canonicalize()
            .unwrap()
            .join(format!("fonts-synthetic-{}-{width}", std::process::id()));
        fs::create_dir(&temp).unwrap();
        fs::set_permissions(&temp, fs::Permissions::from_mode(0o700)).unwrap();
        let root = temp.join("settings");
        let original = Preferences {
            appearance: if mode == ThemeMode::Dark {
                AppearancePreference::Dark
            } else {
                AppearancePreference::Light
            },
            ..Default::default()
        };
        let mut store = SettingsStore::new(root.clone());
        store.load().unwrap();
        store.save(original).unwrap();
        drop(store);
        let owner = cx.update(|cx| cx.new(|_| SettingsPreferences::new(Some(Ok(root.clone())))));
        cx.update(|cx| owner.update(cx, |o, cx| o.load(cx)));
        let (settings, _) = cx
            .update(|cx| {
                gpui_kit::open_window(options(width, 1180.), cx, |w, cx| {
                    cx.new(|cx| SettingsView::new(owner.clone(), w, cx))
                })
            })
            .unwrap();
        await_saved(cx, settings, &owner);
        cx.update(|cx| assert_eq!(cx.theme().mode, mode));
        let reduced_motion = cx.update(|cx| cx.reduce_motion());
        let mut tools = crate::tool_presentation::Tools::default();
        tools.call(
            "font-tool",
            900,
            "bash",
            &serde_json::json!({"command":"printf synthetic"}),
        );
        tools.result(
            "font-tool",
            900,
            "bash",
            &serde_json::json!({"content":"Tool output café 日本語"}),
        );
        let mut rows = vec![
            Message::live(
                1,
                "assistant".into(),
                "Conversation café 日本語 👩‍💻 with a few words to measure.".into(),
            ),
            Message::live(
                2,
                "assistant".into(),
                "```rust\nlet café = true;\n```".into(),
            ),
            Message::live(3, "You".into(), "User café 日本語 👩‍💻".into()),
        ];
        rows.extend(tools.project(vec![Message::tool_ref(900, "font-tool")]));
        let (chat, transcript) = cx
            .update(|cx| {
                gpui_kit::open_window(options(width, 1000.), cx, |w, cx| {
                    cx.new(|cx| {
                        let mut t = TranscriptView::readonly(w, cx);
                        t.replace_readonly(rows, true, cx);
                        t
                    })
                })
            })
            .unwrap();
        settle(cx, chat);
        cx.update_window(chat, |_, w, cx| {
            w.click("work-toggle-900", cx);
            w.click("step-toggle-call:font-tool", cx);
        })
        .unwrap();
        settle(cx, chat);
        let states: Vec<_> = cx.update(|cx| {
            (1..=3)
                .map(|id| transcript.read(cx).history_probe_row(id))
                .collect()
        });
        let initial: Vec<_> = cx.update(|cx| {
            states
                .iter()
                .map(|s| s.read(cx).bounds().size.height)
                .collect()
        });
        let tool_height = cx
            .update_window(chat, |_, w, _| {
                w.find("body-call:font-tool-Output").bounds().size.height
            })
            .unwrap();
        let initial_preview = cx
            .update_window(settings, |_, w, _| {
                w.find("settings-chat-preview").bounds().size.height
            })
            .unwrap();
        cx.update(|cx| states[0].update(cx, |s, cx| s.select_all(cx)));
        let selection = cx.update(|cx| states[0].read(cx).selected_text());
        assert!(selection.contains("👩‍💻"));
        // Actual native size controls stage only the preview. Existing renderers stay unchanged.
        for id in ["settings-chat-font", "settings-code-font"] {
            cx.update_window(settings, |_, w, cx| {
                w.click(id, cx);
                w.press("down", cx);
                w.press("down", cx);
                w.press("enter", cx);
            })
            .unwrap();
            settle(cx, settings);
        }
        cx.update(|cx| {
            let fonts = owner.read(cx).state.current().fonts;
            assert!(!fonts.chat_family.name().is_empty());
            assert!(!fonts.code_family.name().is_empty());
            assert!(typography::available(fonts.chat_family, cx));
            assert!(typography::available(fonts.code_family, cx));
        });
        cx.update_window(settings, |_, w, cx| {
            for _ in 0..16 {
                w.click("settings-chat-larger", cx);
            }
            for _ in 0..14 {
                w.click("settings-code-larger", cx);
            }
        })
        .unwrap();
        settle(cx, settings);
        settle(cx, chat);
        cx.update(|cx| {
            assert_eq!(typography::current(cx), Default::default());
            assert_eq!(owner.read(cx).state.current().fonts.chat_size, Some(44));
            assert_eq!(owner.read(cx).state.current().fonts.code_size, Some(40));
            assert_eq!(
                states
                    .iter()
                    .map(|s| s.read(cx).bounds().size.height)
                    .collect::<Vec<_>>(),
                initial
            );
        });
        assert!(
            cx.update_window(settings, |_, w, _| w
                .find("settings-chat-preview")
                .bounds()
                .size
                .height)
                .unwrap()
                > initial_preview
        );
        capture(
            cx,
            settings,
            &format!("{width}-{}-preview.png", mode.name()),
        );
        cx.update_window(settings, |_, w, cx| w.click("settings-save", cx))
            .unwrap();
        await_saved(cx, settings, &owner);
        settle(cx, chat);
        cx.update(|cx| {
            assert_eq!(cx.reduce_motion(), reduced_motion);
            let saved = owner.read(cx).state.current().fonts;
            assert_eq!(
                cx.theme().mono_font_family.as_ref(),
                saved.code_family.name()
            );
            let chrome = cx.theme().font_family.clone();
            Theme::change(
                if mode == ThemeMode::Dark {
                    ThemeMode::Light
                } else {
                    ThemeMode::Dark
                },
                None,
                cx,
            );
            assert_eq!(
                cx.theme().mono_font_family.as_ref(),
                saved.code_family.name(),
                "inline code family survives appearance changes"
            );
            assert_eq!(
                cx.theme().font_family,
                chrome,
                "chat fonts must not reset chrome/editor font"
            );
            Theme::change(mode, None, cx);
        });
        settle(cx, chat);
        cx.update(|cx| {
            for (state, old) in states.iter().zip(&initial) {
                assert!(
                    state.read(cx).bounds().size.height > *old,
                    "real prose/code/user metrics must adopt preferences"
                );
            }
            assert_eq!(
                states[0].read(cx).selected_text(),
                selection,
                "font remeasurement retains Unicode selection"
            );
        });
        assert!(
            cx.update_window(chat, |_, w, _| w
                .find("body-call:font-tool-Output")
                .bounds()
                .size
                .height)
                .unwrap()
                > tool_height,
            "expanded real tool output adopts code metrics"
        );
        cx.update_window(chat, |_, w, cx| w.click(("copy-source", 2u64), cx))
            .unwrap();
        cx.update(|cx| {
            assert_eq!(
                cx.read_from_clipboard().unwrap().text().unwrap(),
                "```rust\nlet café = true;\n```"
            )
        });
        capture(
            cx,
            chat,
            &format!("{width}-{}-conversation.png", mode.name()),
        );
        let saved = SettingsStore::new(root.clone()).load().unwrap().preferences;
        assert_eq!(saved.fonts.chat_size, Some(44));
        assert_eq!(saved.appearance, original.appearance);
        // Font-only reset is staged and does not reset the user's theme.
        cx.update_window(settings, |_, w, cx| w.click("settings-font-defaults", cx))
            .unwrap();
        cx.update(|cx| {
            assert_eq!(owner.read(cx).state.current(), original);
            assert_eq!(typography::current(cx), saved.fonts);
        });
        cx.update_window(settings, |_, w, cx| w.click("settings-save", cx))
            .unwrap();
        await_saved(cx, settings, &owner);
        settle(cx, chat);
        cx.update(|cx| {
            assert_eq!(
                states
                    .iter()
                    .map(|s| s.read(cx).bounds().size.height)
                    .collect::<Vec<_>>(),
                initial,
                "default geometry restored exactly"
            )
        });
        assert_eq!(
            SettingsStore::new(root.clone()).load().unwrap().preferences,
            original
        );
        if width > 1000. {
            // Real virtualized reading anchor, not an empty or fitting-list approximation.
            let rows = (0..64)
                .map(|ix| {
                    Message::live(
                        1000 + ix,
                        "assistant".into(),
                        format!(
                            "Paragraph {ix}: {}",
                            "Café 日本語 👩‍💻 bounded text and wrapping. ".repeat(8)
                        ),
                    )
                })
                .collect();
            cx.update(|cx| transcript.update(cx, |t, cx| t.replace_readonly(rows, true, cx)));
            settle(cx, chat);
            cx.update_window(chat, |_, w, cx| {
                w.scroll(
                    "viewport",
                    gpui_kit::ScrollDelta::Pixels(gpui_kit::point(px(0.), px(520.))),
                    cx,
                )
            })
            .unwrap();
            settle(cx, chat);
            let before = cx.update(|cx| transcript.read(cx).history_probe_anchor(cx));
            assert!(
                !before.2 && before.0 > 0,
                "must actually be reading a virtualized history row"
            );
            cx.update_window(settings, |_, w, cx| {
                for _ in 0..16 {
                    w.click("settings-chat-larger", cx);
                }
                w.click("settings-save", cx);
            })
            .unwrap();
            await_saved(cx, settings, &owner);
            settle(cx, chat);
            let after = cx.update(|cx| transcript.read(cx).history_probe_anchor(cx));
            assert_eq!(
                after.0, before.0,
                "font change retains the reading item anchor"
            );
            assert!(!after.2, "font change cannot resume tail-following");
            cx.update_window(settings, |_, w, cx| {
                w.click("settings-font-defaults", cx);
                w.click("settings-save", cx);
            })
            .unwrap();
            await_saved(cx, settings, &owner);
            settle(cx, chat);
        }
        cx.update_window(settings, |_, w, _| w.remove_window())
            .unwrap();
        // A valid persisted font may disappear between launches. Load, disclose and
        // render a fallback, without rewriting its choice or any unrelated preference.
        let missing =
            crate::settings_state::FontFamily::new("Synthetic Uninstalled Font 142").unwrap();
        let unavailable = Preferences {
            fonts: crate::settings_state::FontPreferences {
                chat_family: missing,
                code_family: missing,
                ..Default::default()
            },
            ..original
        };
        let mut store = SettingsStore::new(root.clone());
        store.load().unwrap();
        store.save(unavailable).unwrap();
        drop(store);
        let restarted =
            cx.update(|cx| cx.new(|_| SettingsPreferences::new(Some(Ok(root.clone())))));
        cx.update(|cx| restarted.update(cx, |o, cx| o.load(cx)));
        let (fallback, _) = cx
            .update(|cx| {
                gpui_kit::open_window(options(width, 1180.), cx, |w, cx| {
                    cx.new(|cx| SettingsView::new(restarted.clone(), w, cx))
                })
            })
            .unwrap();
        await_saved(cx, fallback, &restarted);
        settle(cx, chat);
        cx.update(|cx| {
            assert!(!typography::available(missing, cx));
            assert_eq!(restarted.read(cx).state.current(), unavailable);
            assert_eq!(
                typography::family(missing, false, cx),
                cx.theme().font_family
            );
            assert_eq!(
                typography::family(missing, true, cx),
                cx.theme().mono_font_family
            );
        });
        assert_eq!(
            SettingsStore::new(root).load().unwrap().preferences,
            unavailable
        );
        capture(
            cx,
            fallback,
            &format!("{width}-{}-unavailable.png", mode.name()),
        );
        cx.update_window(fallback, |_, w, _| w.remove_window())
            .unwrap();
        drop(restarted);
        cx.update_window(chat, |_, w, _| w.remove_window()).unwrap();
        drop(owner);
        cx.run_until_parked();
        fs::remove_dir_all(temp).unwrap();
        println!(
            "Fonts native {width} {}: staged preview, durable Save, real prose/code/user/tool adoption, Unicode selection/copy, exact font-only defaults",
            mode.name()
        );
    }
}
