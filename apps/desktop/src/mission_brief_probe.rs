//! Production Browser/Workspace and one real shell, only owned synthetic HTTP/state.
use crate::{
    LocalViewer,
    mission_brief::{self as model, Outcome, Source},
    mission_brief_fixture::{Reply, Server, brief},
    mission_brief_view::Workspace,
    mission_browser_fixture as f,
    mission_browser_view::{Browser, Input},
};
use gpui_kit::{
    AnyWindowHandle, App, AppContext, Bounds, Entity, EntityInputHandler, Focusable,
    HeadlessAppContext, InputEvent as _, WindowBounds, WindowOptions,
    component::{ActiveTheme, ThemeMode},
    px, size,
    test::TestWindowExt,
};
use serde_json::json;
use std::{
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};
fn settle(cx: &mut HeadlessAppContext, h: AnyWindowHandle) {
    for _ in 0..3 {
        cx.run_until_parked();
        cx.advance_clock(Duration::from_millis(16));
        cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
    }
}
#[track_caller]
fn until(cx: &mut HeadlessAppContext, h: AnyWindowHandle, condition: impl Fn(&App) -> bool) {
    let end = Instant::now() + Duration::from_secs(8);
    while !cx.update(|cx| condition(cx)) {
        assert!(
            Instant::now() < end,
            "brief fixture timed out at {}",
            std::panic::Location::caller()
        );
        settle(cx, h);
        std::thread::yield_now();
    }
    settle(cx, h);
}
fn click(cx: &mut HeadlessAppContext, h: AnyWindowHandle, id: &'static str) {
    cx.update_window(h, |_, w, cx| w.click(id, cx)).unwrap();
    settle(cx, h);
}
fn source() -> Source {
    Source {
        key: f::key("mission-A"),
        project: "project-A".into(),
    }
}
fn type_text(cx: &mut HeadlessAppContext, h: AnyWindowHandle, p: &Entity<Workspace>, text: &str) {
    cx.update_window(h, |_, w, cx| {
        let input = p.read(cx).input.clone();
        input.update(cx, |i, cx| i.focus(w, cx));
        w.press("secondary-a", cx);
        w.input(text, cx);
    })
    .unwrap();
    settle(cx, h);
}
fn capture(cx: &mut HeadlessAppContext, h: AnyWindowHandle, dir: &Option<PathBuf>, name: String) {
    if let Some(d) = dir {
        cx.capture_screenshot(h)
            .unwrap()
            .save(d.join(name))
            .unwrap();
    }
}
fn clipboard(cx: &mut HeadlessAppContext) -> String {
    cx.update(|cx| {
        cx.read_from_clipboard()
            .and_then(|v| v.text())
            .unwrap_or_default()
    })
}
fn input() -> Input {
    Input {
        route: Some(crate::mission_reader::Route::Detail(f::key("mission-A"))),
        filter: None,
        projects: Arc::new(
            crate::local_model::projects(
                &json!([{"id":"project-A","name":"Synthetic","path":"/synthetic/A"}]),
            )
            .unwrap(),
        ),
        chats: Arc::new(Vec::new()),
        online: true,
        loaded: true,
    }
}
fn appearance(mode: ThemeMode, cx: &mut HeadlessAppContext) {
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
}
fn tone(mode: ThemeMode) -> &'static str {
    if mode == ThemeMode::Dark {
        "dark"
    } else {
        "light"
    }
}
fn component(cx: &mut HeadlessAppContext, width: f32, mode: ThemeMode, dir: &Option<PathBuf>) {
    appearance(mode, cx);
    let server = Server::start(Some("# Original 日本語 👩‍💻"));
    let (h, browser) = cx
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
                    cx.new(|cx| {
                        let mut b = Browser::new(cx);
                        b.options(server.options.clone());
                        let mut catalog = input();
                        catalog.route = Some(crate::mission_reader::Route::Catalog);
                        b.sync(catalog, w, cx);
                        b
                    })
                },
            )
        })
        .unwrap();
    appearance(mode, cx);
    until(cx, h, |cx| {
        browser.read(cx).catalog.is_some() && !browser.read(cx).busy
    });
    cx.update_window(h, |_, w, cx| {
        browser.update(cx, |b, cx| b.sync(input(), w, cx))
    })
    .unwrap();
    until(cx, h, |cx| {
        browser.read(cx).detail.is_some() && !browser.read(cx).busy
    });
    assert_eq!(server.puts(), 0);
    click(cx, h, "mission-open-brief");
    let pane = cx.update(|cx| browser.read(cx).brief.clone().unwrap());
    until(cx, h, |cx| {
        pane.read(cx)
            .book
            .get(&source())
            .is_some_and(|e| e.current.is_some())
            && !pane.read(cx).busy
    });
    assert_eq!(server.puts(), 0);
    click(cx, h, "brief-edit");
    type_text(cx, h, &pane, "\u{feff} # Saved Unicode 日本語 👩‍💻 \n");
    cx.update_window(h, |_, w, cx| {
        let input = pane.read(cx).input.clone();
        input.update(cx, |i, cx| {
            i.replace_and_mark_text_in_range(None, "に", Some(1..1), w, cx)
        });
        w.press("secondary-s", cx);
        w.click("brief-save", cx);
        assert_eq!(
            server.puts(),
            0,
            "preedit blocks both action-first shortcut and pointer Save"
        );
        let marked = input
            .update(cx, |i, cx| i.marked_text_range(w, cx))
            .unwrap();
        input.update(cx, |i, cx| i.replace_text_in_range(Some(marked), "", w, cx));
    })
    .unwrap();
    settle(cx, h);
    click(cx, h, "brief-save");
    until(cx, h, |cx| {
        pane.read(cx)
            .book
            .get(&source())
            .and_then(|e| e.known.as_ref())
            .is_some_and(|a| matches!(&a.outcome,Outcome::Confirmed(b) if b.revision.number==2))
    });
    assert_eq!(server.puts(), 1);
    cx.update_window(h, |_, w, cx| {
        assert_eq!(cx.theme().is_dark(), mode == ThemeMode::Dark);
        let b = w.find("mission-brief-workspace").bounds();
        assert_eq!(b.size, size(px(width), px(840.)));
        for id in [
            "brief-overview",
            "brief-edit",
            "brief-refresh",
            "brief-history",
            "brief-copy-full",
        ] {
            let a = w.find(id).bounds();
            assert!(
                a.left() >= b.left()
                    && a.right() <= b.right()
                    && a.top() >= b.top()
                    && a.bottom() <= b.bottom(),
                "essential action {id} fits actual viewport"
            );
        }
    })
    .unwrap();
    capture(
        cx,
        h,
        dir,
        format!("{}-{}-current.png", width as u32, tone(mode)),
    );
    click(cx, h, "brief-copy-full");
    assert_eq!(clipboard(cx), "# Saved Unicode 日本語 👩‍💻");
    click(cx, h, "brief-history");
    until(cx, h, |cx| pane.read(cx).history.is_some());
    click(cx, h, "brief-revision-1");
    until(cx, h, |cx| {
        pane.read(cx)
            .viewing
            .as_ref()
            .is_some_and(|b| b.revision.number == 1)
    });
    click(cx, h, "brief-copy-full");
    assert_eq!(clipboard(cx), "# Original 日本語 👩‍💻");
    click(cx, h, "brief-edit");
    type_text(cx, h, &pane, "My conflict draft 🧪");
    {
        let mut s = server.state.lock().unwrap();
        s.current = 3;
        s.versions.insert(3, "Another user's revision".into());
    }
    click(cx, h, "brief-save");
    until(cx, h, |cx| {
        pane.read(cx)
            .book
            .get(&source())
            .and_then(|e| e.attempt.as_ref())
            .is_some_and(|a| matches!(a.outcome, Outcome::Conflict))
    });
    assert_eq!(server.puts(), 1, "stale preflight never dispatches a PUT");
    capture(
        cx,
        h,
        dir,
        format!("{}-{}-conflict.png", width as u32, tone(mode)),
    );
    click(cx, h, "brief-refresh");
    until(cx, h, |cx| {
        pane.read(cx)
            .book
            .get(&source())
            .and_then(|e| e.current.as_ref())
            .is_some_and(|c| c.number() == 3)
            && !pane.read(cx).busy
    });
    cx.update(|cx| {
        assert_eq!(
            pane.read(cx)
                .book
                .get(&source())
                .unwrap()
                .draft
                .as_ref()
                .unwrap()
                .text
                .as_ref(),
            "My conflict draft 🧪"
        )
    });
    click(cx, h, "brief-copy-draft");
    assert_eq!(clipboard(cx), "My conflict draft 🧪");
    click(cx, h, "brief-use-latest");
    click(cx, h, "brief-save");
    until(cx, h, |cx| {
        pane.read(cx)
            .book
            .get(&source())
            .and_then(|e| e.known.as_ref())
            .is_some_and(|a| matches!(&a.outcome,Outcome::Confirmed(b) if b.revision.number==4))
    });
    click(cx, h, "brief-edit");
    type_text(cx, h, &pane, "Captured before hidden save");
    server.reply(
        "PUT",
        "/api/missions/mission-A/brief",
        Reply {
            status: Some(200),
            bytes: serde_json::to_vec(&brief(5, "Captured before hidden save")).unwrap(),
            delay: 150,
            chunked: false,
            after_commit: true,
        },
    );
    click(cx, h, "brief-save");
    until(cx, h, |_| server.puts() == 3);
    type_text(cx, h, &pane, "Newer edit retained while hidden 👩‍💻");
    click(cx, h, "brief-overview");
    cx.update_window(h, |_, w, _| {
        assert_ne!(
            w.find("mission-tab-tasks").disabled(),
            Some(true),
            "task browser is rearmed after brief closes"
        )
    })
    .unwrap();
    until(cx, h, |cx| {
        pane.read(cx)
            .book
            .get(&source())
            .and_then(|e| e.known.as_ref())
            .is_some_and(|a| matches!(&a.outcome,Outcome::Confirmed(b) if b.revision.number==5))
    });
    crate::mission_browser_view::probe_menu_command(cx, h, "Activity");
    cx.update_window(h, |_, w, _| {
        assert!(w.try_find("mission-activity-page").is_some())
    })
    .unwrap();
    click(cx, h, "activity-overview");
    cx.update(|cx| {
        let p = pane.read(cx);
        assert!(!p.visible);
        let d = p.book.get(&source()).unwrap().draft.as_ref().unwrap();
        assert_eq!(d.text.as_ref(), "Newer edit retained while hidden 👩‍💻");
        assert_eq!(d.base, 4);
    });
    click(cx, h, "mission-open-brief");
    until(cx, h, |cx| !pane.read(cx).busy);
    click(cx, h, "brief-copy-draft");
    assert_eq!(clipboard(cx), "Newer edit retained while hidden 👩‍💻");
    click(cx, h, "brief-use-latest");
    let mut lost = Reply::json(400, json!({"error":"observer failed after commit"}));
    lost.after_commit = true;
    server.reply("PUT", "/api/missions/mission-A/brief", lost);
    click(cx, h, "brief-save");
    until(cx, h, |cx| {
        pane.read(cx)
            .book
            .get(&source())
            .and_then(|e| e.attempt.as_ref())
            .is_some_and(|a| matches!(a.outcome, Outcome::Unknown(_)))
    });
    click(cx, h, "brief-refresh");
    until(cx, h, |cx| {
        !pane.read(cx).busy
            && pane
                .read(cx)
                .book
                .get(&source())
                .and_then(|e| e.current.as_ref())
                .is_some_and(|c| c.number() == 6)
    });
    cx.update(|cx|{let p=pane.read(cx);let e=p.book.get(&source()).unwrap();assert!(matches!(e.attempt.as_ref().unwrap().outcome,Outcome::Unknown(_)));assert!(matches!(&e.known.as_ref().unwrap().outcome,Outcome::Confirmed(b) if b.revision.number==5));});
    assert_eq!(server.puts(), 4);
    capture(
        cx,
        h,
        dir,
        format!("{}-{}-unknown-after-read.png", width as u32, tone(mode)),
    );
    // An over-limit atomic edit is rejected whole, not truncated into a save.
    let previous = cx.update(|cx| pane.read(cx).input.read(cx).value().to_string());
    cx.update_window(h, |_, w, cx| {
        let input = pane.read(cx).input.clone();
        input.update(cx, |i, cx| i.focus(w, cx));
        w.press("secondary-a", cx);
        cx.write_to_clipboard(gpui_kit::ClipboardItem::new_string(
            "🧪".repeat(model::EDIT_BYTES / 4 + 1),
        ));
        w.press("secondary-v", cx);
    })
    .unwrap();
    settle(cx, h);
    // Deferred duplicate Change effects must not quietly clear the rejection.
    cx.update(|cx| {
        let input = pane.read(cx).input.clone();
        input.update(cx, |_, cx| {
            cx.emit(gpui_kit::component::input::InputEvent::Change);
            cx.emit(gpui_kit::component::input::InputEvent::Change);
        });
    });
    settle(cx, h);
    cx.update(|cx| {
        let p = pane.read(cx);
        assert_eq!(p.input.read(cx).value().as_ref(), previous);
        assert!(p.edit_error.is_some());
        let range = p.input.read(cx).selected_range();
        assert!(previous.is_char_boundary(range.start) && previous.is_char_boundary(range.end));
    });
    assert_eq!(server.puts(), 4);
    let previous = "A new valid draft after rejected paste 👩‍💻".to_owned();
    type_text(cx, h, &pane, &previous);
    cx.update(|cx| assert!(pane.read(cx).edit_error.is_none()));
    // A delayed no-op ACK must not close a newly reopened edit session.
    type_text(cx, h, &pane, "Newer edit retained while hidden 👩‍💻");
    click(cx, h, "brief-use-latest");
    server.reply(
        "PUT",
        "/api/missions/mission-A/brief",
        Reply {
            status: Some(200),
            bytes: serde_json::to_vec(&brief(6, "Newer edit retained while hidden 👩‍💻")).unwrap(),
            delay: 500,
            chunked: false,
            after_commit: true,
        },
    );
    click(cx, h, "brief-save");
    until(cx, h, |_| server.puts() == 5);
    click(cx, h, "brief-cancel");
    click(cx, h, "brief-edit");
    until(cx, h, |cx| {
        pane.read(cx)
            .book
            .get(&source())
            .and_then(|e| e.known.as_ref())
            .is_some_and(|a| matches!(&a.outcome,Outcome::Confirmed(b) if b.revision.number==6))
    });
    cx.update(|cx| {
        assert!(
            pane.read(cx).editing,
            "late no-op ACK preserves newer editing intent"
        );
        assert_eq!(
            pane.read(cx).input.read(cx).value().as_ref(),
            "Newer edit retained while hidden 👩‍💻"
        );
    });
    click(cx, h, "brief-use-latest");
    cx.update_window(h, |_, w, _| {
        assert_ne!(
            w.find("brief-save").disabled(),
            Some(true),
            "new edit remains explicitly recoverable after the no-op ACK"
        )
    })
    .unwrap();
    type_text(cx, h, &pane, &previous);
    click(cx, h, "brief-cancel");
    let large = "界".repeat(model::EDIT_BYTES / 3 + 1);
    {
        let mut s = server.state.lock().unwrap();
        s.current = 7;
        s.versions.insert(7, large.clone());
    }
    click(cx, h, "brief-refresh");
    until(cx, h, |cx| {
        !pane.read(cx).busy
            && pane
                .read(cx)
                .book
                .get(&source())
                .and_then(|e| e.current.as_ref())
                .is_some_and(|c| c.number() == 7)
    });
    click(cx, h, "brief-copy-full");
    assert_eq!(clipboard(cx), large);
    click(cx, h, "brief-copy-visible");
    let visible = clipboard(cx);
    assert!(
        visible.len() <= model::DISPLAY_BYTES
            && large.starts_with(&visible)
            && large.is_char_boundary(visible.len())
    );
    cx.update(|cx| {
        assert_eq!(
            pane.read(cx)
                .book
                .get(&source())
                .unwrap()
                .draft
                .as_ref()
                .unwrap()
                .text
                .as_ref(),
            previous
        )
    });
    cx.update(|cx| pane.read(cx).disconnect_fixture());
    until(cx, h, |cx| {
        pane.read(cx)
            .read_error
            .is_some_and(|e| e.contains("Couldn't confirm the last save"))
            && !pane.read(cx).busy
    });
    let requests = server.state.lock().unwrap().seen.len();
    settle(cx, h);
    assert_eq!(
        requests,
        server.state.lock().unwrap().seen.len(),
        "no automatic worker retry"
    );
    click(cx, h, "brief-refresh");
    until(cx, h, |cx| {
        !pane.read(cx).busy && pane.read(cx).read_error.is_none()
    });
    assert_eq!(server.puts(), 5);
    cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
    drop(browser);
    drop(pane);
    cx.run_until_parked();
    println!(
        "{}",
        json!({"brief_workspace":true,"width":width,"mode":tone(mode),"synthetic_puts":5,"history_immutable":true,"conflict_recovery_explicit":true,"hidden_ack_newer_edit_retained":true,"reopened_edit_survives_noop_ack":true,"unknown_not_settled_by_get":true,"oversize_atomic_rejection":true,"full_vs_visible_copy":true,"worker_exit_explicit_retry":true})
    );
}
fn root(cx: &mut HeadlessAppContext, dir: &Option<PathBuf>) {
    appearance(ThemeMode::Light, cx);
    let server = Server::start(Some("# Root brief"));
    let (h, view) = cx
        .update(|cx| {
            gpui_kit::open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                        Default::default(),
                        size(px(1100.), px(840.)),
                    ))),
                    show: false,
                    focus: false,
                    ..Default::default()
                },
                cx,
                |w, cx| cx.new(|cx| LocalViewer::synthetic(w, cx)),
            )
        })
        .unwrap();
    let browser = cx
        .update_window(h, |_, w, cx| {
            view.update(cx, |v, cx| {
                v.brief_fixture_setup(server.options.clone(), w, cx)
            })
        })
        .unwrap();
    until(cx, h, |cx| {
        browser.read(cx).catalog.is_some() && !browser.read(cx).busy
    });
    cx.update_window(h, |_, w, cx| {
        w.click(format!("mission-row-{}", f::key("mission-A").tag()), cx)
    })
    .unwrap();
    until(cx, h, |cx| {
        browser.read(cx).detail.is_some() && !browser.read(cx).busy
    });
    click(cx, h, "mission-open-brief");
    let pane = cx.update(|cx| browser.read(cx).brief.clone().unwrap());
    until(cx, h, |cx| {
        !pane.read(cx).busy
            && pane
                .read(cx)
                .book
                .get(&source())
                .and_then(|e| e.current.as_ref())
                .is_some()
    });
    click(cx, h, "brief-edit");
    type_text(cx, h, &pane, "Root retained draft 日本語 👩‍💻");
    cx.update_window(h, |_, w, cx| {
        assert_ne!(w.find("nav-back").disabled(), Some(true));
        let input = pane.read(cx).input.clone();
        input.update(cx, |i, cx| {
            i.replace_and_mark_text_in_range(None, "に", Some(1..1), w, cx)
        });
    })
    .unwrap();
    settle(cx, h);
    // A real inside-editor press while marked must reach Kit's caret handler.
    cx.update_window(h, |_, w, cx| {
        let input = pane.read(cx).input.clone();
        let bounds = w.find("brief-input").bounds();
        let before = input.read(cx).selected_range();
        let mut target = None;
        for y in 1..=8 {
            for x in 1..=8 {
                let point = bounds.origin
                    + gpui_kit::point(
                        bounds.size.width * (x as f32 / 64.),
                        bounds.size.height * (y as f32 / 32.),
                    );
                if input
                    .update(cx, |i, cx| i.character_index_for_point(point, w, cx))
                    .is_some_and(|n| n < 8)
                {
                    target = Some(point);
                    break;
                }
            }
            if target.is_some() {
                break;
            }
        }
        let position = target.expect("mounted first text row has a measured caret target");
        w.dispatch_event(
            gpui_kit::MouseDownEvent {
                button: gpui_kit::MouseButton::Left,
                position,
                modifiers: Default::default(),
                click_count: 1,
                first_mouse: false,
            }
            .to_platform_input(),
            cx,
        );
        assert_ne!(
            input.read(cx).selected_range(),
            before,
            "inside marked editor pointer must reach Kit, not the navigation fence"
        );
        w.dispatch_event(
            gpui_kit::MouseUpEvent {
                button: gpui_kit::MouseButton::Left,
                position,
                modifiers: Default::default(),
                click_count: 1,
            }
            .to_platform_input(),
            cx,
        );
        assert!(input.update(cx, |i, cx| i.marked_text_range(w, cx).is_some()));
        assert!(input.read(cx).focus_handle(cx).is_focused(w));
        let end = input.read(cx).value().len();
        input.update(cx, |i, cx| i.set_selected_range(end..end, cx));
        assert_eq!(server.puts(), 0);
    })
    .unwrap();
    settle(cx, h);
    cx.update_window(h, |_, w, cx| {
        assert!(!view.update(cx, |v, cx| v.brief_fixture_restoring_guard(w, cx)))
    })
    .unwrap();
    for key in [
        "secondary-1",
        "secondary-[",
        "secondary-k",
        "secondary-,",
        "secondary-s",
    ] {
        cx.update_window(h, |_, w, cx| {
            w.press(key, cx);
            assert_eq!(
                view.read(cx).brief_fixture_bits(),
                (true, false, false, false)
            );
            assert!(
                pane.read(cx)
                    .input
                    .clone()
                    .update(cx, |i, cx| i.marked_text_range(w, cx).is_some())
            );
        })
        .unwrap();
        settle(cx, h);
    }
    // These actual sibling pointer paths must refuse BEFORE native blur.
    for id in ["nav-home", "project-scope"] {
        cx.update_window(h, |_, w, cx| {
            w.click(id, cx);
            assert_eq!(
                view.read(cx).brief_fixture_bits(),
                (true, false, false, false)
            );
            assert!(
                pane.read(cx)
                    .input
                    .clone()
                    .update(cx, |i, cx| i.marked_text_range(w, cx).is_some())
            );
        })
        .unwrap();
        settle(cx, h);
    }
    assert_eq!(server.puts(), 0);
    cx.update_window(h, |_, w, cx| {
        let input = pane.read(cx).input.clone();
        input.update(cx, |i, cx| {
            i.unmark_text(w, cx);
            i.replace_text_in_range(None, "本", w, cx);
        });
    })
    .unwrap();
    settle(cx, h);
    let text = cx.update(|cx| pane.read(cx).input.read(cx).value().to_string());
    cx.update_window(h, |_, w, cx| {
        assert!(view.update(cx, |v, cx| v.brief_fixture_restoring_guard(w, cx)))
    })
    .unwrap();
    cx.update_window(h, |_, w, cx| w.press("secondary-k", cx))
        .unwrap();
    settle(cx, h);
    cx.update(|cx| assert!(view.read(cx).brief_fixture_bits().1));
    cx.update_window(h, |_, w, cx| w.press("escape", cx))
        .unwrap();
    settle(cx, h);
    cx.update_window(h, |_, w, cx| {
        assert!(pane.read(cx).input.read(cx).focus_handle(cx).is_focused(w))
    })
    .unwrap();
    click(cx, h, "project-scope");
    cx.update(|cx| assert!(view.read(cx).brief_fixture_bits().3));
    click(cx, h, "project-scope");
    cx.update_window(h, |_, w, cx| {
        let input = pane.read(cx).input.clone();
        input.update(cx, |i, cx| i.focus(w, cx));
        w.press("secondary-,", cx);
    })
    .unwrap();
    until(cx, h, |cx| view.read(cx).brief_fixture_bits().2);
    cx.update(|cx| view.update(cx, |v, cx| v.brief_fixture_close_settings(cx)));
    settle(cx, h);
    cx.update_window(h, |_, w, cx| {
        assert!(pane.read(cx).input.read(cx).focus_handle(cx).is_focused(w))
    })
    .unwrap();
    cx.update_window(h, |_, w, cx| w.press("secondary-1", cx))
        .unwrap();
    settle(cx, h);
    cx.update(|cx| assert!(!view.read(cx).brief_fixture_bits().0));
    cx.update_window(h, |_, w, cx| w.press("secondary-[", cx))
        .unwrap();
    until(cx, h, |cx| {
        view.read(cx).brief_fixture_bits().0 && !browser.read(cx).busy
    });
    click(cx, h, "mission-open-brief");
    until(cx, h, |cx| !pane.read(cx).busy);
    cx.update(|cx| assert_eq!(pane.read(cx).input.read(cx).value().as_ref(), text));
    click(cx, h, "brief-save");
    until(cx, h, |cx| {
        pane.read(cx)
            .book
            .get(&source())
            .is_some_and(|e| e.known.is_some())
    });
    assert_eq!(server.puts(), 1);
    capture(cx, h, dir, "root-ime-wide-light.png".into());
    cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
    drop(view);
    drop(browser);
    drop(pane);
    cx.run_until_parked();
    println!(
        "{}",
        json!({"brief_root":true,"keyboard_preedit_guards":true,"pointer_before_blur":true,"palette_settings_project_success_after_unmark":true,"navigation_retains_unsaved":true,"explicit_save_after_return":true})
    );
}
pub fn run_mission_brief_probe(cx: &mut HeadlessAppContext) {
    let dir = std::env::var_os("PILOT_NEXT_BRIEF_DIR").map(PathBuf::from);
    if let Some(d) = &dir {
        std::fs::create_dir_all(d).unwrap();
    }
    let selected = std::env::var_os("PILOT_NEXT_BRIEF_CASE").map(|v| {
        v.into_string()
            .expect("native brief selector must be UTF-8")
    });
    assert!(
        selected
            .as_deref()
            .is_none_or(|s| matches!(s, "root-ime" | "component-wide-light" | "integration")),
        "unknown native brief case"
    );
    let mut ran = 0;
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            if selected.as_deref() == Some("root-ime")
                || (selected.is_some() && (width != 1100. || mode != ThemeMode::Light))
            {
                continue;
            }
            component(cx, width, mode, &dir);
            ran += 1;
        }
    }
    if selected.as_deref() != Some("component-wide-light") {
        root(cx, &dir);
        ran += 1;
    }
    assert_eq!(
        ran,
        if selected.as_deref() == Some("integration") {
            2
        } else if selected.is_some() {
            1
        } else {
            5
        },
        "explicit native case set must execute"
    );
}
