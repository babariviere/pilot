//! Sidebar coordinator rows: the Open mission button opens the exact linked
//! mission, never the coordinator's chat or the thread's fold. Actual
//! LocalViewer rows and Kit buttons, faux GET-only daemon, hidden windows.
use super::*;
use gpui_kit::Pixels;

/// Long enough to truncate beside the button at 680pt.
const NAME: &str = "GPUI Rewrite — 迁移 👩‍💻 with a very long mission name that truncates";
const DRAFT: &str = "Keep this draft 私 👩‍💻";
const BUTTON: &str = "sidebar-open-mission-mission-A";

/// Pixels in `bounds` that differ from its top-left corner: the icon's ink.
fn painted(
    cx: &mut HeadlessAppContext,
    h: AnyWindowHandle,
    width: f32,
    bounds: Bounds<Pixels>,
) -> usize {
    let image = cx.capture_screenshot(h).expect("native renderer required");
    let scale = image.width() as f32 / width;
    let (x0, y0) = (
        (f32::from(bounds.left()) * scale).ceil() as u32,
        (f32::from(bounds.top()) * scale).ceil() as u32,
    );
    let (x1, y1) = (
        (f32::from(bounds.right()) * scale).floor() as u32,
        (f32::from(bounds.bottom()) * scale).floor() as u32,
    );
    let base = image.get_pixel(x0, y0).0;
    (y0..y1)
        .flat_map(|y| (x0..x1).map(move |x| (x, y)))
        .filter(|&(x, y)| {
            let p = image.get_pixel(x, y).0;
            (0..3).map(|c| p[c].abs_diff(base[c]) as u32).sum::<u32>() > 48
        })
        .count()
}
fn back_to_chat(cx: &mut HeadlessAppContext, h: AnyWindowHandle, view: &Entity<LocalViewer>) {
    for _ in 0..3 {
        if cx.update(|cx| view.read(cx).page == Page::Chat) {
            return;
        }
        cx.update_window(h, |_, w, cx| w.press("secondary-[", cx))
            .unwrap();
        settle(cx, h);
    }
    cx.update(|cx| assert_eq!(view.read(cx).page, Page::Chat));
}

pub(super) fn run(cx: &mut HeadlessAppContext) {
    let dir = std::env::var_os("PILOT_NEXT_MISSIONS_DIR").map(PathBuf::from);
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            one(cx, width, mode, &dir);
        }
    }
}

fn one(cx: &mut HeadlessAppContext, width: f32, mode: ThemeMode, dir: &Option<PathBuf>) {
    let server = Server::start();
    let private = Private(std::env::temp_dir().canonicalize().unwrap().join(format!(
        "native-sidebar-open-mission-{}",
        uuid::Uuid::new_v4()
    )));
    let (writer, updates) = Interaction::start(server.options.clone(), Ok(private.0.clone()));
    let (client, commands) = LocalClient::synthetic_commands();
    cx.update(|cx| Theme::change(mode, None, cx));
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
                    cx.new(|cx| {
                        let mut v = LocalViewer::build(Some(client), Some(writer.clone()), w, cx);
                        v.missions
                            .update(cx, |b, _| b.options(server.options.clone()));
                        v.state.projects = Arc::new(
                            crate::local_model::projects(&json!([{"id":"project-A","name":"Same project","path":"/synthetic/A"}]))
                                .unwrap(),
                        );
                        v.state.projects_loaded = true;
                        v.state.list_loaded = true;
                        v.state.loaded = true;
                        v.state.status = "Synthetic Local fixture".into();
                        v.state.mission_titles = Some(Arc::new(
                            [("mission-A".to_owned(), NAME.to_owned())].into_iter().collect(),
                        ));
                        let chat = |extra: serde_json::Value| {
                            let mut base = json!({"title":"Chat","projectId":"project-A","cwd":"/synthetic/A","mode":"ask","state":"idle"});
                            base.as_object_mut()
                                .unwrap()
                                .extend(extra.as_object().unwrap().clone());
                            crate::local_model::chat(&base).unwrap()
                        };
                        v.state.chats = Arc::new(vec![
                            chat(json!({"id":"chat-A","title":"Open chat"})),
                            chat(json!({"id":"chat-C","title":"Coordinator","missionId":"mission-A","missionCoordinator":true})),
                            chat(json!({"id":"chat-M","title":"Member","missionId":"mission-A"})),
                            // A thread without a coordinator: its row opens the mission.
                            chat(json!({"id":"chat-Z","title":"Orphan member","missionId":"mission-Z"})),
                            // A coordinator whose mission is unknown has nothing to open.
                            chat(json!({"id":"chat-U","title":"Unknown","missionId":true,"missionCoordinator":true})),
                        ]);
                        v.selected = Some("chat-A".into());
                        v.title = "Open chat".into();
                        v.generation = 1;
                        v.state.generation = 1;
                        v.editor.update(cx, |e, cx| {
                            e.select("chat:chat-A".into(), true, false, w, cx)
                        });
                        v.rebuild_nav(w, cx);
                        v.listen_writes(updates, w, cx);
                        v
                    })
                },
            )
        })
        .unwrap();
    until(cx, h, &view, |v, cx| v.editor.read(cx).ready());
    cx.update_window(h, |_, w, cx| {
        let input = view.read(cx).editor.read(cx).shell_probe().0;
        input.update(cx, |i, cx| i.focus(w, cx));
        w.input(DRAFT, cx);
    })
    .unwrap();
    settle(cx, h);
    let name = |what: &str| {
        format!(
            "{}-{}-sidebar-open-mission-{what}.png",
            width as u32,
            mode.name()
        )
    };
    let fold = |cx: &mut HeadlessAppContext| {
        cx.update(|cx| {
            let list = view.read(cx).chats.read(cx).delegate();
            (
                list.collapsed.contains("mission-A"),
                list.show_finished.contains("mission-A"),
            )
        })
    };
    let folded = fold(cx);
    // The open chat, its draft and the thread's fold stay.
    let kept = |cx: &mut HeadlessAppContext| {
        cx.update(|cx| {
            let v = view.read(cx);
            assert_eq!(
                v.selected.as_deref(),
                Some("chat-A"),
                "the coordinator never opens"
            );
            assert_eq!(
                v.editor.read(cx).shell_probe().0.read(cx).value().as_ref(),
                DRAFT
            );
        });
        assert_eq!(fold(cx), folded, "the thread never folds");
    };
    // At rest the row builds no button.
    cx.update_window(h, |_, w, _| assert!(w.try_find(BUTTON).is_none()))
        .unwrap();
    // Hover reveals it beside the …, clear of the truncated mission name.
    cx.update_window(h, |_, w, cx| w.hover("chat-row-chat-C", cx))
        .unwrap();
    settle(cx, h);
    let button = cx
        .update_window(h, |_, w, _| {
            let open = w.find(BUTTON);
            assert_eq!(open.label(), Some("Open mission"));
            let b = open.bounds();
            let row = w.find("chat-row-chat-C").bounds();
            let title = w
                .within("chat-row-chat-C")
                .find("sidebar-mission-title")
                .bounds();
            let menu = w.find("chat-menu-chat-C").bounds();
            assert!(title.right() <= b.left() + px(0.5), "{title:?} under {b:?}");
            assert!(
                b.right() <= menu.left() + px(0.5),
                "{b:?} over the … {menu:?}"
            );
            assert!(b.left() >= row.left() && b.top() >= row.top() - px(0.5));
            assert!(b.bottom() <= row.bottom() + px(0.5));
            b
        })
        .unwrap();
    assert!(painted(cx, h, width, button) > 0, "shown on hover");
    capture(cx, h, dir, name("hover"));
    // Pointer: the mission's overview, before the mission list has loaded.
    assert!(cx.update(|cx| view.read(cx).missions.read(cx).catalog.is_none()));
    cx.update_window(h, |_, w, cx| w.click(BUTTON, cx)).unwrap();
    until(cx, h, &view, |v, cx| {
        v.page == Page::Mission(f::key("mission-A"))
            && v.missions.read(cx).detail.is_some()
            && !v.missions.read(cx).busy
    });
    cx.update(|cx| {
        assert_eq!(
            view.read(cx).missions.read(cx).detail.as_ref().unwrap().key,
            f::key("mission-A")
        )
    });
    kept(cx);
    back_to_chat(cx, h, &view);
    kept(cx);
    // The pointer leaves: nothing built on unselected rows.
    cx.update_window(h, |_, w, cx| w.hover("nav-missions", cx))
        .unwrap();
    settle(cx, h);
    cx.update_window(h, |_, w, _| assert!(w.try_find(BUTTON).is_none()))
        .unwrap();
    // Keyboard: select the coordinator row, Tab to the button (before the …),
    // which shows while focused; Enter opens the mission, not the chat.
    let coordinator = cx.update(|cx| {
        view.read(cx)
            .chats
            .read(cx)
            .delegate()
            .index("chat-C")
            .unwrap()
    });
    cx.update_window(h, |_, w, cx| {
        view.update(cx, |v, cx| v.chats.update(cx, |l, cx| l.focus(w, cx)));
    })
    .unwrap();
    settle(cx, h);
    for _ in 0..8 {
        if cx.update(|cx| view.read(cx).chats.read(cx).delegate().selected == Some(coordinator)) {
            break;
        }
        cx.update_window(h, |_, w, cx| w.press("down", cx)).unwrap();
        settle(cx, h);
    }
    cx.update(|cx| {
        assert_eq!(
            view.read(cx).chats.read(cx).delegate().selected,
            Some(coordinator)
        )
    });
    tab_to(cx, h, BUTTON, "chat-menu-chat-C");
    let button = cx
        .update_window(h, |_, w, _| w.find(BUTTON).bounds())
        .unwrap();
    assert!(painted(cx, h, width, button) > 0, "shown while focused");
    capture(cx, h, dir, name("focus"));
    cx.update_window(h, |_, w, cx| w.press("enter", cx))
        .unwrap();
    until(cx, h, &view, |v, cx| {
        v.page == Page::Mission(f::key("mission-A")) && !v.missions.read(cx).busy
    });
    kept(cx);
    back_to_chat(cx, h, &view);
    kept(cx);
    // No button where the row already opens the mission, or where the
    // mission is unknown.
    for row in ["chat-row-mission:mission-Z", "chat-row-chat-U"] {
        cx.update_window(h, |_, w, cx| w.hover(row, cx)).unwrap();
        settle(cx, h);
        cx.update_window(h, |_, w, _| {
            assert!(
                w.within(row).try_find_by_label("Open mission").is_none(),
                "{row}"
            );
        })
        .unwrap();
    }
    kept(cx);
    assert!(commands.try_recv().is_err());
    assert!(server.all_gets());
    cx.update_window(h, |_, w, cx| {
        view.update(cx, |v, _| v.writes = None);
        w.remove_window();
    })
    .unwrap();
    drop(view);
    cx.run_until_parked();
    assert!(writer.command(WriteCommand::Close));
    println!(
        "{}",
        json!({"sidebar_open_mission":true,"width":width,"mode":mode.name(),"hover_reveal":true,"pointer_overview":true,"keyboard_tab_enter":true,"no_chat_or_fold":true,"unavailable_hidden":true})
    );
}
