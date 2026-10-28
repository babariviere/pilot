use super::*;
use crate::chat_rename_fixture::{self as f, Behavior, Daemon, Seen};
use gpui_kit::{
    AnyWindowHandle, Bounds, EntityInputHandler, Focusable, HeadlessAppContext, InputEvent,
    MouseButton, MouseDownEvent, MouseUpEvent, WindowBounds, WindowOptions, component::ThemeMode,
    size, test::TestWindowExt,
};
use serde_json::json;
use std::{sync::Mutex, time::Instant};

struct Server {
    options: LocalOptions,
    seen: Arc<Mutex<Seen>>,
    released: Arc<tokio::sync::Notify>,
    stop: Option<tokio::sync::oneshot::Sender<()>>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl Server {
    fn start(behavior: Behavior) -> Self {
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        let (stop, shutdown) = tokio::sync::oneshot::channel();
        let thread = std::thread::spawn(move || {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap()
                .block_on(async move {
                    let d = Daemon::start(behavior).await;
                    tx.send((d.options.clone(), d.seen.clone(), d.released.clone()))
                        .unwrap();
                    let _ = shutdown.await;
                    drop(d);
                });
        });
        let (options, seen, released) = rx.recv_timeout(Duration::from_secs(3)).unwrap();
        Self {
            options,
            seen,
            released,
            stop: Some(stop),
            thread: Some(thread),
        }
    }
    fn posts(&self) -> usize {
        self.seen
            .lock()
            .unwrap()
            .requests
            .iter()
            .filter(|r| r.0 == "POST")
            .count()
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        if let Some(tx) = self.stop.take() {
            let _ = tx.send(());
        }
        if let Some(t) = self.thread.take() {
            t.join().unwrap();
        }
    }
}
fn settle(cx: &mut HeadlessAppContext, h: AnyWindowHandle) {
    for _ in 0..3 {
        cx.run_until_parked();
        cx.advance_clock(Duration::from_millis(16));
        cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
    }
}
#[track_caller]
fn until(
    cx: &mut HeadlessAppContext,
    h: AnyWindowHandle,
    check: impl Fn(&mut Window, &mut App) -> bool,
) {
    let end = Instant::now() + Duration::from_secs(7);
    while !cx.update_window(h, |_, w, cx| check(w, cx)).unwrap() {
        assert!(
            Instant::now() < end,
            "bounded row publication at {}",
            std::panic::Location::caller()
        );
        settle(cx, h);
        std::thread::yield_now();
    }
    settle(cx, h);
}
fn click_label(w: &mut Window, label: &str, cx: &mut App) {
    let b = w.within("popup-menu").find_by_label(label).bounds();
    let position = b.center();
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
fn menu_has(w: &mut Window, label: &str) -> bool {
    w.try_find("popup-menu").is_some() && w.within("popup-menu").try_find_by_label(label).is_some()
}
fn menu(cx: &mut HeadlessAppContext, h: AnyWindowHandle, label: &str) {
    cx.update_window(h, |_, w, cx| w.right_click("chat-row-source", cx))
        .unwrap();
    until(cx, h, |w, _| menu_has(w, label));
}
pub fn run_chat_rename_probe(cx: &mut HeadlessAppContext) {
    // Kit's entrance uses wall time, not advance_clock. Keep pointer geometry
    // stationary so this probe tests dismissal/focus rather than animation timing.
    let reduced_motion = cx.update(|cx| {
        let previous = cx.reduce_motion();
        cx.set_reduce_motion(true);
        previous
    });
    let case = std::env::var("PILOT_NEXT_CHAT_RENAME_CASE").ok();
    assert!(
        case.as_deref().is_none_or(|s| s == "routing"),
        "unknown rename native case"
    );
    let routing = case.is_some();
    let captures = std::env::var_os("PILOT_NEXT_CHAT_RENAME_DIR").map(std::path::PathBuf::from);
    if let Some(path) = &captures {
        std::fs::create_dir_all(path).unwrap();
    }
    let mut cases = 0;
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            for behavior in [Behavior::Accept, Behavior::Lost, Behavior::Slow] {
                if routing
                    && (width != 1100.
                        || mode != ThemeMode::Light
                        || !matches!(behavior, Behavior::Accept))
                {
                    continue;
                }
                if !matches!(behavior, Behavior::Accept)
                    && (width != 1100. || mode != ThemeMode::Light)
                {
                    continue;
                }
                cases += 1;
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
                let server = Server::start(behavior);
                let root = std::env::temp_dir()
                    .join(format!("native-chat-rename-{}", uuid::Uuid::new_v4()));
                let (writer, updates) =
                    Interaction::start(server.options.clone(), Ok(root.clone()));
                let drain = updates.clone();
                let (client, _commands) = LocalClient::synthetic_commands();
                let mut live = crate::local_model::LiveTranscript::default();
                let entry = |id, text: &str| json!({"id":id,"head":id,"kind":"pi.assistant","model":[{"role":"assistant","content":[{"type":"text","text":text}]}]});
                let first = entry(100, "Retained conversation 私 👩‍💻");
                live.apply(&json!({"type":"snapshot","entries":[first.clone()]}));
                let rows = live.rows();
                let first_id = rows[0].id();
                let (h,view)=cx.update(|cx|gpui_kit::open_window(WindowOptions {window_bounds:Some(WindowBounds::Windowed(Bounds::new(Default::default(),size(px(width),px(840.))))),show:false,focus:false,..Default::default()},cx,|w,cx|cx.new(|cx|{
                let mut v=LocalViewer::build(Some(client),Some(writer.clone()),w,cx);
                v.chat_actions.update(cx,|a,cx|a.connect(server.options.clone(),cx));
                v.state.status="Synthetic Local fixture".into();v.state.loaded=true;v.state.list_loaded=true;v.state.generation=1;v.generation=1;
                v.state.chats=Arc::new(vec![crate::local_model::chat(&f::source()).unwrap(),crate::local_model::chat(&json!({"id":"other","title":"Selected working conversation","projectId":"project","cwd":"/synthetic/project","mode":"ask","state":"working","working":true})).unwrap()]);
                v.state.projects=Arc::new(crate::local_model::projects(&json!([{"id":"project","name":"Synthetic","path":"/synthetic/project"}])).unwrap());v.state.projects_loaded=true;
                v.selected=Some("other".into());v.title="Selected working conversation".into();
                v.transcript.update(cx,|t,cx|t.replace_readonly(rows.clone(),true,cx));
                v.editor.update(cx,|e,cx|e.select("chat:other".into(),true,true,w,cx));
                v.rebuild_nav(w,cx);v.listen_writes(updates,w,cx);v
            }))).unwrap();
                until(cx, h, |_, cx| view.read(cx).editor.read(cx).ready());
                // This activates only TestPlatform's hidden window, never an OS window.
                cx.update_window(h, |_, w, _| w.activate_window()).unwrap();
                settle(cx, h);
                let input = cx.update(|cx| view.read(cx).editor.read(cx).shell_probe().0);
                cx.update_window(h, |_, w, cx| {
                    input.update(cx, |i, cx| i.focus(w, cx));
                    w.input("Unsent 私の下書き 👩‍💻", cx);
                })
                .unwrap();
                settle(cx, h);
                let draft = cx.update(|cx| input.read(cx).value());
                let retained = cx.update(|cx| {
                    view.read(cx)
                        .transcript
                        .read(cx)
                        .history_probe_row(first_id)
                });
                for escape in [false, true] {
                    // Actual unselected production row and native menu item.
                    menu(cx, h, "Rename…");
                    cx.update_window(h, |_, w, cx| click_label(w, "Rename…", cx))
                        .unwrap();
                    settle(cx, h);
                    cx.update_window(h, |_, w, cx| {
                        assert!(w.is_window_active());
                        assert_eq!(w.viewport_size(), size(px(width), px(840.)));
                        assert_eq!(cx.theme().is_dark(), mode == ThemeMode::Dark);
                        assert_eq!(
                            w.find("rename-title").value(),
                            Some(f::source()["title"].as_str().unwrap())
                        );
                        assert_eq!(w.find("rename-title").focused(), Some(true));
                        assert_eq!(w.find("rename-submit").disabled(), Some(true));
                        assert_eq!(view.read(cx).selected.as_deref(), Some("other"));
                        if escape {
                            w.press("escape", cx);
                        } else {
                            w.click("rename-cancel", cx);
                        }
                    })
                    .unwrap();
                    settle(cx, h);
                    assert_eq!(server.posts(), 0);
                    cx.update_window(h, |_, w, cx| {
                        assert!(
                            w.try_find("rename-title").is_none(),
                            "dismissal must close Rename"
                        );
                        assert!(
                            view.read(cx).chats.read(cx).focus_handle(cx).is_focused(w),
                            "Root must restore chat navigation focus"
                        );
                        assert_eq!(view.read(cx).selected.as_deref(), Some("other"));
                        assert_eq!(input.read(cx).value(), draft);
                    })
                    .unwrap();
                }
                menu(cx, h, "Rename…");
                cx.update_window(h, |_, w, cx| click_label(w, "Rename…", cx))
                    .unwrap();
                settle(cx, h);
                let form =
                    cx.update(|cx| view.read(cx).chat_actions.read(cx).renames["source"].clone());
                live.apply(&json!({"type":"snapshot","entries":[first,entry(101,"A streamed update while Rename is open.")]}));
                let streamed = live.rows();
                assert_eq!(streamed.len(), 2);
                let streamed_id = streamed[1].id();
                cx.update_window(h, |_, w, cx| {
                    view.update(cx, |v, cx| {
                        let mut state = v.state.clone();
                        state.rows = streamed.clone();
                        v.accept(state, w, cx);
                    })
                })
                .unwrap();
                settle(cx, h);
                cx.update(|cx| {
                    let t = view.read(cx).transcript.read(cx);
                    assert_eq!(
                        t.history_probe_row(first_id),
                        retained,
                        "Rename must not replace the retained conversation row"
                    );
                    let _ = t.history_probe_row(streamed_id);
                    assert_eq!(view.read(cx).selected.as_deref(), Some("other"));
                    assert_eq!(input.read(cx).value(), draft);
                });
                if let Some(path) = &captures {
                    cx.capture_screenshot(h)
                        .unwrap()
                        .save(path.join(format!(
                            "rename-{width}-{}.png",
                            if mode == ThemeMode::Dark {
                                "dark"
                            } else {
                                "light"
                            }
                        )))
                        .unwrap();
                }
                let title = cx.update(|cx| form.read(cx).input.clone());
                cx.update_window(h, |_, w, cx| {
                    w.click("rename-title", cx);
                    w.press("secondary-a", cx);
                    w.input(" New   title 👩‍💻 ", cx);
                    title.update(cx, |i, cx| {
                        i.replace_and_mark_text_in_range(None, "ガ", Some(1..1), w, cx)
                    });
                })
                .unwrap();
                settle(cx, h);
                cx.update_window(h, |_, w, cx| {
                    let marked = title
                        .update(cx, |i, cx| i.marked_text_range(w, cx))
                        .unwrap();
                    w.press("enter", cx);
                    w.click("rename-submit", cx);
                    w.click("rename-cancel", cx);
                    assert!(w.try_find("rename-title").is_some());
                    assert_eq!(
                        title.update(cx, |i, cx| i.marked_text_range(w, cx)),
                        Some(marked.clone())
                    );
                    title.update(cx, |i, cx| i.replace_text_in_range(Some(marked), "", w, cx));
                })
                .unwrap();
                settle(cx, h);
                assert_eq!(server.posts(), 0);
                // Atomic oversized paste must leave the complete prior draft intact.
                cx.update_window(h, |_, w, cx| {
                    w.click("rename-title", cx);
                    let before = title.read(cx).value();
                    cx.write_to_clipboard(gpui_kit::ClipboardItem::new_string("😀".repeat(101)));
                    w.press("secondary-a", cx);
                    w.press("secondary-v", cx);
                    assert_eq!(title.read(cx).value(), before);
                    if width == 680. {
                        w.press("enter", cx);
                    } else {
                        w.click("rename-submit", cx);
                    }
                })
                .unwrap();
                until(cx, h, |_, _| server.posts() == 1);
                if matches!(behavior, Behavior::Slow) {
                    assert!(cx.update(|cx| form.read(cx).pending));
                    cx.update_window(h, |_, w, cx| {
                        assert_eq!(w.find("rename-submit").disabled(), Some(true));
                        w.click("rename-cancel", cx);
                    })
                    .unwrap();
                    settle(cx, h);
                    assert!(cx.update(|cx| form.read(cx).pending));
                    server.released.notify_one();
                }
                until(cx, h, |_, cx| !form.read(cx).pending);
                cx.update(|cx| {
                    let expected = if matches!(behavior, Behavior::Lost) {
                        crate::chat_actions::Outcome::Unknown
                    } else {
                        crate::chat_actions::Outcome::Acknowledged
                    };
                    assert!(form.read(cx).outcome == Some(expected));
                    assert_eq!(view.read(cx).selected.as_deref(), Some("other"));
                    assert_eq!(input.read(cx).value(), draft);
                    assert_eq!(
                        view.read(cx).state.chats[0].title,
                        f::source()["title"].as_str().unwrap()
                    );
                });
                if matches!(behavior, Behavior::Lost)
                    && let Some(path) = &captures
                {
                    cx.capture_screenshot(h)
                        .unwrap()
                        .save(path.join("rename-unconfirmed.png"))
                        .unwrap();
                }
                if !matches!(behavior, Behavior::Slow) {
                    cx.update_window(h, |_, w, cx| w.click("rename-cancel", cx))
                        .unwrap();
                    settle(cx, h);
                }
                if matches!(behavior, Behavior::Lost) {
                    // A matching later GET/menu must not settle Unknown or issue another POST.
                    let changed = cx.update(|cx| {
                        let mut chat = view.read(cx).state.chats[0].clone();
                        chat.title = "New title 👩‍💻".into();
                        chat
                    });
                    cx.update_window(h, |_, w, cx| {
                        view.update(cx, |v, cx| {
                            Arc::make_mut(&mut v.state.chats)[0] = changed;
                            v.rebuild_nav(w, cx);
                        })
                    })
                    .unwrap();
                    settle(cx, h);
                    menu(cx, h, "Rename…");
                    cx.update_window(h, |_, w, cx| click_label(w, "Rename…", cx))
                        .unwrap();
                    settle(cx, h);
                    cx.update_window(h, |_, w, cx| {
                        assert_eq!(w.find("rename-submit").disabled(), Some(true));
                        assert!(
                            form.read(cx).outcome == Some(crate::chat_actions::Outcome::Unknown)
                        );
                        w.press("escape", cx);
                    })
                    .unwrap();
                    settle(cx, h);
                }
                assert_eq!(server.posts(), 1);
                let posts = server
                    .seen
                    .lock()
                    .unwrap()
                    .requests
                    .iter()
                    .filter(|r| r.0 == "POST")
                    .cloned()
                    .collect::<Vec<_>>();
                assert_eq!(posts[0].1, "/api/sessions/source/title");
                assert_eq!(posts[0].2, json!({"title":"New title 👩‍💻"}));
                if !routing && width == 1100. && mode == ThemeMode::Dark {
                    cx.update_window(h, |_, w, cx| {
                        view.update(cx, |v, cx| {
                            super::chat_actions_navigation::probe_rename_capacity(v, w, cx)
                        });
                    })
                    .unwrap();
                    settle(cx, h);
                }
                // Close/drain draft ownership before removing its private fixture directory.
                cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
                cx.run_until_parked();
                drop(view);
                drop(form);
                drop(title);
                drop(input);
                drop(retained);
                assert!(writer.command(WriteCommand::Close));
                tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .unwrap()
                    .block_on(async {
                        tokio::time::timeout(Duration::from_secs(3), async {
                            let mut flushed = false;
                            while let Ok(update) = drain.recv().await {
                                flushed |= update.flushed;
                            }
                            assert!(
                                flushed,
                                "private draft writer must acknowledge its final flush"
                            );
                        })
                        .await
                        .unwrap();
                    });
                let store = Store::open(root.clone(), server.options.host()).unwrap();
                assert_eq!(store.book.drafts["chat:other"].text, draft.as_ref());
                drop(store);
                drop(writer);
                let _ = std::fs::remove_dir_all(root);
            }
        }
    }
    assert_eq!(cases, if routing { 1 } else { 6 });
    cx.update(|cx| cx.set_reduce_motion(reduced_motion));
    println!("chat rename: {cases} mounted exact-row cases passed");
}
