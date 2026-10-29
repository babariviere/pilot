//! Chat right-click menu: no repeated title, and Open mission for the row's
//! own linked mission. Actual LocalViewer rows and Kit menus, faux GET-only daemon.
use super::*;
use gpui_kit::{InputEvent, MouseButton, MouseDownEvent, MouseUpEvent, Pixels};

/// The user's overflowing title, and a wider Unicode/emoji one.
const LONG: &str = "Show confirmed branch pushes and PR creation in mission activity and chat";
const WIDE: &str = "長いタイトル 👩‍💻👨‍👩‍👧‍👦 é Show confirmed branch pushes and PR creation in mission activity and chat 🚀";
const DRAFT: &str = "Keep this draft 私 👩‍💻";

fn open_menu(cx: &mut HeadlessAppContext, h: AnyWindowHandle, row: &str) {
    let id = SharedString::from(format!("chat-row-{row}"));
    cx.update_window(h, |_, w, cx| w.right_click(id, cx))
        .unwrap();
    let end = Instant::now() + Duration::from_secs(6);
    while !cx
        .update_window(h, |_, w, _| w.try_find("popup-menu").is_some())
        .unwrap()
    {
        assert!(Instant::now() < end, "menu for {row} never opened");
        settle(cx, h);
    }
    settle(cx, h);
}
fn close_menu(cx: &mut HeadlessAppContext, h: AnyWindowHandle) {
    cx.update_window(h, |_, w, cx| w.press("escape", cx))
        .unwrap();
    settle(cx, h);
    cx.update_window(h, |_, w, _| assert!(w.try_find("popup-menu").is_none()))
        .unwrap();
}
fn has(w: &mut Window, label: &str) -> bool {
    w.within("popup-menu").try_find_by_label(label).is_some()
}
/// The open menu holds no title row, and all of it stays inside the menu and
/// the window. Returns the menu's width.
fn checked_menu(w: &mut Window, title: &str) -> Pixels {
    let menu = w.find("popup-menu").bounds();
    let root = w.find("desktop-root").bounds();
    assert!(!has(w, title), "the menu repeats the chat title");
    assert!(
        root.contains(&menu.origin)
            && menu.right() <= root.right()
            && menu.bottom() <= root.bottom(),
        "menu {menu:?} leaves the window {root:?}"
    );
    for e in w.within("popup-menu").elements() {
        let b = e.bounds();
        assert!(
            b.right() <= menu.right() + px(0.5) && b.left() >= menu.left() - px(0.5),
            "{:?} paints outside the menu: {b:?} vs {menu:?}",
            e.label()
        );
    }
    menu.size.width
}
fn click_label(w: &mut Window, label: &str, cx: &mut App) {
    let position = w
        .within("popup-menu")
        .find_by_label(label)
        .bounds()
        .center();
    w.dispatch_event(
        MouseDownEvent {
            button: MouseButton::Left,
            position,
            modifiers: Default::default(),
            click_count: 1,
            first_mouse: false,
        }
        .to_platform_input(),
        cx,
    );
    w.render_frame(cx);
    w.dispatch_event(
        MouseUpEvent {
            button: MouseButton::Left,
            position,
            modifiers: Default::default(),
            click_count: 1,
        }
        .to_platform_input(),
        cx,
    );
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
    // Kit's entrance uses wall time; keep menu geometry at rest.
    let motion = cx.update(|cx| {
        let previous = cx.reduce_motion();
        cx.set_reduce_motion(true);
        previous
    });
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            one(cx, width, mode);
        }
    }
    cx.update(|cx| cx.set_reduce_motion(motion));
}

fn one(cx: &mut HeadlessAppContext, width: f32, mode: ThemeMode) {
    let server = Server::start();
    let private = Private(
        std::env::temp_dir()
            .canonicalize()
            .unwrap()
            .join(format!("native-chat-menu-mission-{}", uuid::Uuid::new_v4())),
    );
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
                        let chat = |extra: serde_json::Value| {
                            let mut base = json!({"title":"Chat","projectId":"project-A","cwd":"/synthetic/A","mode":"ask","state":"idle"});
                            base.as_object_mut()
                                .unwrap()
                                .extend(extra.as_object().unwrap().clone());
                            crate::local_model::chat(&base).unwrap()
                        };
                        v.state.chats = Arc::new(vec![
                            chat(json!({"id":"chat-A","title":"Open chat"})),
                            chat(json!({"id":"chat-M","title":LONG,"missionId":"mission-A"})),
                            chat(json!({"id":"chat-W","title":WIDE})),
                            chat(json!({"id":"chat-U","title":"Unknown","missionId":true})),
                            chat(json!({"id":"chat-S","title":"Stale","missionId":"mission-Z"})),
                        ]);
                        v.selected = Some("chat-A".into());
                        v.title = "Open chat".into();
                        v.generation = 1;
                        v.state.generation = 1;
                        v.editor.update(cx, |e, cx| {
                            e.select("chat:chat-A".into(), true, false, w, cx)
                        });
                        // Quiet members fold under "+N finished"; show them.
                        v.chats.update(cx, |l, _| {
                            let d = l.delegate_mut();
                            d.show_finished.insert("mission-A".into());
                            d.show_finished.insert("mission-Z".into());
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
    let kept = |cx: &mut HeadlessAppContext| {
        cx.update(|cx| {
            let v = view.read(cx);
            assert_eq!(v.selected.as_deref(), Some("chat-A"), "the open chat stays");
            assert_eq!(
                v.editor.read(cx).shell_probe().0.read(cx).value().as_ref(),
                DRAFT
            );
        })
    };
    // Titles never size the menu: a short and a long Unicode title, same items.
    open_menu(cx, h, "chat-A");
    let short = cx
        .update_window(h, |_, w, _| {
            assert!(!has(w, "Open mission"), "no mission, no Open mission");
            checked_menu(w, "Open chat")
        })
        .unwrap();
    close_menu(cx, h);
    open_menu(cx, h, "chat-W");
    let wide = cx
        .update_window(h, |_, w, _| {
            assert!(!has(w, "Open mission"));
            checked_menu(w, WIDE)
        })
        .unwrap();
    close_menu(cx, h);
    assert_eq!(short, wide, "the title changed the menu width");
    // An unknown association offers nothing to open.
    open_menu(cx, h, "chat-U");
    cx.update_window(h, |_, w, _| assert!(!has(w, "Open mission")))
        .unwrap();
    close_menu(cx, h);
    kept(cx);
    // Pointer: the unselected row's own mission, before the list has loaded.
    assert!(cx.update(|cx| view.read(cx).missions.read(cx).catalog.is_none()));
    open_menu(cx, h, "chat-M");
    cx.update_window(h, |_, w, cx| {
        checked_menu(w, LONG);
        click_label(w, "Open mission", cx);
    })
    .unwrap();
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
    // Keyboard: Kit's first Down lands on the top (disabled) status row, the
    // next on Open mission, the first enabled item here; Enter opens it.
    open_menu(cx, h, "chat-M");
    for _ in 0..2 {
        cx.update_window(h, |_, w, cx| w.press("down", cx)).unwrap();
        settle(cx, h);
    }
    cx.update_window(h, |_, w, cx| w.press("enter", cx))
        .unwrap();
    until(cx, h, &view, |v, cx| {
        v.page == Page::Mission(f::key("mission-A")) && !v.missions.read(cx).busy
    });
    kept(cx);
    back_to_chat(cx, h, &view);
    kept(cx);
    // A mission the list doesn't have says so instead of guessing.
    open_menu(cx, h, "chat-S");
    cx.update_window(h, |_, w, cx| click_label(w, "Open mission", cx))
        .unwrap();
    until(cx, h, &view, |v, cx| {
        v.page == Page::Missions && !v.missions.read(cx).busy
    });
    cx.update_window(h, |_, w, _| assert!(w.find("missions-jump-note").visible()))
        .unwrap();
    kept(cx);
    assert!(commands.try_recv().is_err());
    assert!(server.all_gets());
    assert!(
        !server
            .state
            .lock()
            .unwrap()
            .seen
            .iter()
            .any(|(_, path)| path.contains("mission-Z")),
        "no request for an unlisted mission"
    );
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
        json!({"chat_menu":true,"width":width,"mode":mode.name(),"no_title_row":true,"title_independent_width":true,"open_mission_pointer":true,"open_mission_keyboard":true,"unknown_hidden":true,"unlisted_note":true,"draft_and_chat_kept":true})
    );
}
