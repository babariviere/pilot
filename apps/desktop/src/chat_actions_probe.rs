//! Actual production rows/Kit menus, synthetic HTTP/private drafts, offscreen only.
#[path = "chat_actions_selected_probe.rs"]
mod selected;
#[path = "chat_actions_capacity_probe.rs"]
mod capacity;
use super::*;
use crate::chat_actions_fixture::{self as f, Behavior, Daemon, Seen};
use gpui_kit::{
    AnyWindowHandle, Bounds, EntityInputHandler, HeadlessAppContext, InputEvent, MouseButton,
    MouseDownEvent, MouseUpEvent, WindowBounds, WindowOptions, component::ThemeMode, point, size,
    test::TestWindowExt,
};
use serde_json::json;
use std::{path::PathBuf, sync::Mutex, time::Instant};

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
fn capture(cx: &mut HeadlessAppContext, h: AnyWindowHandle, dir: &Option<PathBuf>, name: String) {
    if let Some(dir) = dir {
        cx.capture_screenshot(h)
            .unwrap()
            .save(dir.join(name))
            .unwrap();
    }
}
pub fn run_chat_actions_probe(cx: &mut HeadlessAppContext) {
    capacity::run(cx);
    let case = std::env::var("PILOT_NEXT_CHAT_ACTIONS_CASE").ok();
    assert!(
        case.as_deref()
            .is_none_or(|s| matches!(s, "review" | "selected-archive")),
        "unknown chat-actions native case"
    );
    if case.as_deref() == Some("selected-archive") {
        selected::run(cx);
        return;
    }
    let dir = std::env::var_os("PILOT_NEXT_CHAT_ACTIONS_DIR").map(PathBuf::from);
    if let Some(d) = &dir {
        std::fs::create_dir_all(d).unwrap();
    }
    let mut ran = 0;
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            if case.is_some() && (width != 1100. || mode != ThemeMode::Light) {
                continue;
            }
            ran += 1;
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
            let server = Server::start(Behavior::Accept);
            let root = std::env::temp_dir()
                .canonicalize()
                .unwrap()
                .join(format!("native-chat-actions-{}", uuid::Uuid::new_v4()));
            let (writer, updates) = Interaction::start(server.options.clone(), Ok(root.clone()));
            let drain = updates.clone();
            let (client, commands) = LocalClient::synthetic_commands();
            let mut reducer = crate::local_model::LiveTranscript::default();
            reducer.apply(&json!({"type":"snapshot","entries":(100..116).map(|id|json!({"id":id,"head":id,"kind":"pi.assistant","model":[{"role":"assistant","content":[{"type":"text","text":format!("Reader {id} 私 👩‍💻 {}","Keep this synthetic paragraph. ".repeat(24))}]}]})).collect::<Vec<_>>()}));
            let rows = reducer.rows();
            let (h,view)=cx.update(|cx|gpui_kit::open_window(WindowOptions{window_bounds:Some(WindowBounds::Windowed(Bounds::new(Default::default(),size(px(width),px(840.))))),show:false,focus:false,..Default::default()},cx,|w,cx|cx.new(|cx|{
            let mut v=LocalViewer::build(Some(client),Some(writer.clone()),w,cx);
            v.chat_actions.update(cx,|a,cx|a.connect(server.options.clone(),cx));
            v.state.status="Synthetic Local fixture".into();v.state.loaded=true;v.state.list_loaded=true;v.state.generation=1;v.generation=1;
            v.state.chats=Arc::new(vec![crate::local_model::chat(&f::source()).unwrap(),crate::local_model::chat(&json!({"id":"other","title":"Selected working conversation","projectId":"project","cwd":"/synthetic/project","mode":"ask","state":"working","working":true})).unwrap()]);
            v.state.projects=Arc::new(crate::local_model::projects(&json!([{"id":"project","name":"Synthetic","path":"/synthetic/project"}])).unwrap());v.state.projects_loaded=true;
            v.selected=Some("other".into());v.title="Selected working conversation".into();
            v.transcript.update(cx,|t,cx|t.replace_readonly(rows.clone(),true,cx));v.editor.update(cx,|e,cx|e.select("chat:other".into(),true,true,w,cx));
            v.rebuild_nav(w,cx);v.listen_writes(updates,w,cx);v
        }))).unwrap();
            until(cx, h, |_, cx| view.read(cx).editor.read(cx).ready());
            let (editor, transcript) = cx.update(|cx| {
                (
                    view.read(cx).editor.clone(),
                    view.read(cx).transcript.clone(),
                )
            });
            let input = cx.update(|cx| editor.read(cx).shell_probe().0);
            cx.update_window(h, |_, w, cx| {
                assert_eq!(w.viewport_size(), size(px(width), px(840.)));
                assert_eq!(cx.theme().is_dark(), mode == ThemeMode::Dark);
                input.update(cx, |i, cx| i.focus(w, cx));
                w.input("Unsent 私の下書き 👩‍💻", cx);
                input.update(cx, |i, cx| {
                    i.replace_and_mark_text_in_range(None, "ガ", Some(1..1), w, cx)
                });
            })
            .unwrap();
            settle(cx, h);
            let reads = server.seen.lock().unwrap().requests.len();
            cx.update_window(h, |_, w, cx| {
                let marked = input
                    .update(cx, |i, cx| i.marked_text_range(w, cx))
                    .unwrap();
                w.right_click("chat-row-source", cx);
                assert_eq!(
                    input.update(cx, |i, cx| i.marked_text_range(w, cx)),
                    Some(marked.clone())
                );
                assert!(w.try_find("popup-menu").is_none());
                input.update(cx, |i, cx| i.replace_text_in_range(Some(marked), "", w, cx));
            })
            .unwrap();
            settle(cx, h);
            assert_eq!(server.seen.lock().unwrap().requests.len(), reads);
            assert_eq!(server.posts(), 0);
            until(cx, h, |_, cx| editor.read(cx).saved_probe(cx));
            let text = cx.update(|cx| input.read(cx).value().to_string());
            cx.update_window(h, |_, w, cx| {
                w.scroll(
                    "viewport",
                    gpui_kit::ScrollDelta::Pixels(point(px(0.), px(100000.))),
                    cx,
                )
            })
            .unwrap();
            settle(cx, h);
            let anchor = cx.update(|cx| transcript.read(cx).history_probe_anchor(cx));
            menu(cx, h, "Archive");
            cx.update_window(h, |_, w, _| {
                let root = w.find("desktop-root").bounds();
                let b = w.find("popup-menu").bounds();
                assert!(
                    root.contains(&b.origin)
                        && b.right() <= root.right()
                        && b.bottom() <= root.bottom()
                );
                assert_ne!(
                    w.within("popup-menu").find_by_label("Archive").disabled(),
                    Some(true)
                );
            })
            .unwrap();
            capture(
                cx,
                h,
                &dir,
                format!("{}-{}-menu.png", width as u32, mode.name()),
            );
            cx.update_window(h, |_, w, cx| w.press("escape", cx))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(w.try_find("popup-menu").is_none());
                assert!(w.focused(cx).is_some());
                assert_eq!(view.read(cx).selected.as_deref(), Some("other"));
                assert_eq!(input.read(cx).value().as_ref(), text);
            })
            .unwrap();
            assert_eq!(server.posts(), 0);
            assert!(commands.try_recv().is_err());
            // Native dropdown is the keyboard equivalent. Escape restores the
            // mounted menu-trigger scope; Tab reaches the actual Kit Button.
            cx.update_window(h, |_, w, cx| w.click("chat-menu-source", cx))
                .unwrap();
            until(cx, h, |w, _| menu_has(w, "Archive"));
            cx.update_window(h, |_, w, cx| w.press("escape", cx))
                .unwrap();
            settle(cx, h);
            for _ in 0..40 {
                let focused = cx
                    .update_window(h, |_, w, cx| {
                        if w.find("chat-menu-source").focused() == Some(true) {
                            true
                        } else {
                            w.press("tab", cx);
                            false
                        }
                    })
                    .unwrap();
                settle(cx, h);
                if focused {
                    break;
                }
            }
            cx.update_window(h, |_, w, _| {
                assert_eq!(w.find("chat-menu-source").focused(), Some(true))
            })
            .unwrap();
            cx.update_window(h, |_, w, cx| w.press("enter", cx))
                .unwrap();
            until(cx, h, |w, _| menu_has(w, "Archive"));
            cx.update_window(h, |_, w, cx| w.press("escape", cx))
                .unwrap();
            settle(cx, h);
            assert_eq!(server.posts(), 0);
            menu(cx, h, "Archive");
            // A menu already on screen cannot authorize a later offline action.
            cx.update_window(h, |_, _, cx| {
                view.update(cx, |v, _| v.state.status = "Disconnected".into())
            })
            .unwrap();
            cx.update_window(h, |_, w, cx| click_label(w, "Archive", cx))
                .unwrap();
            settle(cx, h);
            assert_eq!(server.posts(), 0);
            cx.update_window(h, |_, _, cx| {
                view.update(cx, |v, _| v.state.status = "Synthetic Local fixture".into())
            })
            .unwrap();
            menu(cx, h, "Archive");
            // Canonical target survives recycling/reorder, or closes fail-closed.
            cx.update_window(h, |_, w, cx| {
                view.update(cx, |v, cx| {
                    let mut chats = (*v.state.chats).clone();
                    chats.reverse();
                    v.state.chats = Arc::new(chats);
                    v.rebuild_nav(w, cx);
                })
            })
            .unwrap();
            settle(cx, h);
            let open = cx
                .update_window(h, |_, w, _| menu_has(w, "Archive"))
                .unwrap();
            if !open {
                menu(cx, h, "Archive");
            }
            cx.update_window(h, |_, w, cx| click_label(w, "Archive", cx))
                .unwrap();
            until(cx, h, |_, cx| {
                view.read(cx).chat_actions.read(cx).outcome("source")
                    == Some(&crate::chat_actions::Outcome::Acknowledged)
            });
            assert_eq!(server.posts(), 1);
            // Stream observations may update archive presentation, but do not settle ACKs.
            let raw = server.seen.lock().unwrap().source.clone();
            cx.update_window(h, |_, w, cx| {
                view.update(cx, |v, cx| {
                    let mut state = v.state.clone();
                    state.rows = rows.clone();
                    let mut chats = (*state.chats).clone();
                    let c = chats.iter_mut().find(|c| c.id == "source").unwrap();
                    *c = crate::local_model::chat(&raw).unwrap();
                    state.chats = Arc::new(chats);
                    v.chats
                        .update(cx, |list, _| list.delegate_mut().archived = true);
                    v.accept(state, w, cx);
                })
            })
            .unwrap();
            settle(cx, h);
            menu(cx, h, "Restore");
            cx.update_window(h, |_, w, cx| click_label(w, "Restore", cx))
                .unwrap();
            until(cx, h, |_, cx| {
                server.posts() == 2
                    && view.read(cx).chat_actions.read(cx).outcome("source")
                        == Some(&crate::chat_actions::Outcome::Acknowledged)
            });
            let raw = server.seen.lock().unwrap().source.clone();
            assert!(raw["archivedAt"].is_null());
            cx.update_window(h, |_, w, cx| {
                view.update(cx, |v, cx| {
                    let mut chats = (*v.state.chats).clone();
                    *chats.iter_mut().find(|c| c.id == "source").unwrap() =
                        crate::local_model::chat(&raw).unwrap();
                    v.state.chats = Arc::new(chats);
                    v.rebuild_nav(w, cx);
                })
            })
            .unwrap();
            settle(cx, h);
            menu(cx, h, "Make a mission…");
            cx.update_window(h, |_, w, cx| click_label(w, "Make a mission…", cx))
                .unwrap();
            until(cx, h, |_, cx| {
                view.read(cx).mission.read(cx).probe_state().0
            });
            cx.update_window(h, |_, w, cx| {
                assert_eq!(view.read(cx).selected.as_deref(), Some("other"));
                w.click("mission-cancel", cx);
            })
            .unwrap();
            settle(cx, h);
            assert_eq!(server.posts(), 2);
            menu(cx, h, "Make a mission…");
            cx.update_window(h, |_, w, cx| click_label(w, "Make a mission…", cx))
                .unwrap();
            until(cx, h, |_, cx| {
                view.read(cx).mission.read(cx).probe_state().0
            });
            cx.update_window(h, |_, w, cx| {
                let f = view.read(cx).mission.clone();
                let title = f.read(cx).title.clone();
                title.update(cx, |i, cx| i.focus(w, cx));
                w.press("secondary-a", cx);
                w.input("A confirmed exact-row mission 私", cx);
                let goal = f.read(cx).goal.clone();
                goal.update(cx, |i, cx| i.focus(w, cx));
                w.input("Keep the original conversation", cx);
                w.click("mission-coordinator", cx);
                w.click("mission-draft", cx);
            })
            .unwrap();
            settle(cx, h);
            capture(
                cx,
                h,
                &dir,
                format!("{}-{}-confirm.png", width as u32, mode.name()),
            );
            if width == 1100. && mode == ThemeMode::Light {
                server.seen.lock().unwrap().behavior = Behavior::Slow;
            }
            cx.update_window(h, |_, w, cx| {
                w.click("mission-confirm", cx);
                w.click("mission-confirm", cx);
            })
            .unwrap();
            if width == 1100. && mode == ThemeMode::Light {
                until(cx, h, |_, cx| {
                    server.posts() == 3 && view.read(cx).mission.read(cx).pending()
                });
                cx.update_window(h, |_, w, cx| w.click("mission-cancel", cx))
                    .unwrap();
                settle(cx, h);
                cx.update_window(h, |_, w, cx| {
                    assert!(!view.read(cx).mission_open);
                    assert!(view.read(cx).mission.read(cx).pending());
                    w.click("make-mission", cx); // Selected OTHER chat cannot replace pending SOURCE.
                    assert!(!view.read(cx).mission_open);
                    w.right_click("chat-row-source", cx);
                })
                .unwrap();
                settle(cx, h);
                cx.update_window(h, |_, w, cx| {
                    assert!(!menu_has(w, "Archive"));
                    assert!(!view.read(cx).mission_open);
                    assert!(view.read(cx).mission.read(cx).pending());
                    w.press("escape", cx);
                })
                .unwrap();
                assert_eq!(server.posts(), 3);
                server.released.notify_one();
            }
            until(cx, h, |_, cx| {
                matches!(
                    view.read(cx).mission.read(cx).probe_state().2,
                    Some(crate::mission_conversion::Outcome::Created { .. })
                )
            });
            assert!(
                !cx.update(|cx| view.read(cx).mission.read(cx).pending()),
                "closed original completion must release only its busy owner"
            );
            if cx.update(|cx| view.read(cx).mission_open) {
                cx.update_window(h, |_, w, cx| w.click("mission-cancel", cx))
                    .unwrap();
            }
            settle(cx, h);
            assert_eq!(server.posts(), 3);
            cx.update_window(h, |_, w, cx| {
                let v = view.read(cx);
                assert_eq!(v.selected.as_deref(), Some("other"));
                assert_eq!(v.editor, editor);
                assert_eq!(v.transcript, transcript);
                assert_eq!(input.read(cx).value().as_ref(), text);
                assert_ne!(w.find("local-stop").disabled(), Some(true));
                let now = transcript.read(cx).history_probe_anchor(cx);
                assert_eq!(now.0, anchor.0);
                assert!((now.1 - anchor.1).abs() < 1.);
            })
            .unwrap();
            assert!(commands.try_recv().is_err());
            {
                let seen = server.seen.lock().unwrap();
                let posts: Vec<_> = seen.requests.iter().filter(|r| r.0 == "POST").collect();
                assert_eq!(posts[2].1, "/api/missions");
                assert_eq!(posts[2].2["fromSessionId"], "source");
                assert_eq!(posts[2].2["draft"], false);
                assert_eq!(posts[2].2["coordinator"], false);
            }
            if width == 1100. && mode == ThemeMode::Dark {
                menu(cx, h, "Archive");
                cx.update_window(h, |_, w, cx| {
                    // Kit MenuItemElement does not expose aria_disabled. Prove
                    // its real disabled pointer behavior, not an absent AX bit.
                    click_label(w, "Make a mission…", cx);
                    assert!(!view.read(cx).mission_open);
                })
                .unwrap();
                assert_eq!(server.posts(), 3);
                server.seen.lock().unwrap().behavior = Behavior::Lost;
                cx.update_window(h, |_, w, cx| click_label(w, "Archive", cx))
                    .unwrap();
                until(cx, h, |_, cx| {
                    view.read(cx).chat_actions.read(cx).outcome("source")
                        == Some(&crate::chat_actions::Outcome::Unknown)
                });
                let raw = server.seen.lock().unwrap().source.clone();
                cx.update_window(h, |_, w, cx| {
                    view.update(cx, |v, cx| {
                        let mut chats = (*v.state.chats).clone();
                        *chats.iter_mut().find(|c| c.id == "source").unwrap() =
                            crate::local_model::chat(&raw).unwrap();
                        v.state.chats = Arc::new(chats);
                        v.rebuild_nav(w, cx);
                    })
                })
                .unwrap();
                settle(cx, h);
                menu(cx, h, "Restore");
                cx.update_window(h, |_, w, cx| {
                    click_label(w, "Restore", cx);
                    w.press("down", cx);
                    w.press("enter", cx);
                    w.press("escape", cx);
                })
                .unwrap();
                settle(cx, h);
                assert_eq!(server.posts(), 4);
                cx.update(|cx| {
                    assert!(
                        view.read(cx).chat_actions.read(cx).outcome("source")
                            == Some(&crate::chat_actions::Outcome::Unknown)
                    )
                });
                capture(cx, h, &dir, "1100-dark-unknown.png".into());
            }
            cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
            drop(view);
            drop(input);
            drop(editor);
            drop(transcript);
            cx.run_until_parked();
            assert!(writer.command(WriteCommand::Close));
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
                        assert!(flushed);
                    })
                    .await
                    .unwrap();
                });
            let store = Store::open(root.clone(), server.options.host()).unwrap();
            assert_eq!(store.book.drafts["chat:other"].text, text);
            drop(store);
            std::fs::remove_dir_all(root).unwrap();
            println!(
                "{}",
                json!({"width":width,"mode":mode.name(),"actual_production_rows":true,"unselected_exact_target":true,"right_click_and_keyboard":true,"opening_dismiss_no_mutation":true,"marked_input_fenced":true,"reorder":true,"nonselected_archive_restore":true,"conversion_cancel_then_explicit_confirm":true,"same_draft_reader_stream_stop":true,"private_flush":true})
            );
        }
    }
    assert_eq!(ran, if case.is_some() { 1 } else { 4 });
    if case.is_none() {
        pending_delivery(cx);
    }
    selected::run(cx);
}

fn pending_delivery(cx: &mut HeadlessAppContext) {
    let server = Server::start(Behavior::Accept);
    let root = std::env::temp_dir().canonicalize().unwrap().join(format!(
        "native-chat-actions-pending-{}",
        uuid::Uuid::new_v4()
    ));
    let pending = {
        let mut store = Store::open(root.clone(), server.options.host()).unwrap();
        store
            .prepare(
                "chat:other",
                &crate::delivery_store::Draft {
                    text: "Original pending 私 👩‍💻".into(),
                    ..Default::default()
                },
                true,
                false,
            )
            .unwrap();
        serde_json::to_vec(&store.book.pending).unwrap()
    };
    let (writer, updates) = Interaction::start(server.options.clone(), Ok(root.clone()));
    let drain = updates.clone();
    let (client, commands) = LocalClient::synthetic_commands();
    let (h,view)=cx.update(|cx|gpui_kit::open_window(WindowOptions{window_bounds:Some(WindowBounds::Windowed(Bounds::new(Default::default(),size(px(1100.),px(840.))))),show:false,focus:false,..Default::default()},cx,|w,cx|cx.new(|cx|{
        let mut v=LocalViewer::build(Some(client),Some(writer.clone()),w,cx);
        v.chat_actions.update(cx,|a,cx|a.connect(server.options.clone(),cx));
        v.state.status="Synthetic Local fixture".into();v.state.loaded=true;v.state.list_loaded=true;v.state.generation=1;v.generation=1;
        v.state.chats=Arc::new(vec![crate::local_model::chat(&f::source()).unwrap(),crate::local_model::chat(&json!({"id":"other","title":"Original pending conversation","projectId":"project","cwd":"/synthetic/project","mode":"ask","state":"idle"})).unwrap()]);
        v.state.projects=Arc::new(crate::local_model::projects(&json!([{"id":"project","name":"Synthetic","path":"/synthetic/project"}])).unwrap());v.state.projects_loaded=true;
        v.selected=Some("other".into());v.title="Original pending conversation".into();v.editor.update(cx,|e,cx|e.select("chat:other".into(),true,false,w,cx));v.rebuild_nav(w,cx);v.listen_writes(updates,w,cx);v
    }))).unwrap();
    until(cx, h, |_, cx| view.read(cx).editor.read(cx).ready());
    let editor = cx.update(|cx| view.read(cx).editor.clone());
    let input = cx.update(|cx| editor.read(cx).shell_probe().0);
    let text = cx.update(|cx| input.read(cx).value().to_string());
    menu(cx, h, "Archive");
    cx.update_window(h, |_, w, cx| click_label(w, "Archive", cx))
        .unwrap();
    until(cx, h, |_, cx| {
        view.read(cx).chat_actions.read(cx).outcome("source")
            == Some(&crate::chat_actions::Outcome::Acknowledged)
    });
    let raw = server.seen.lock().unwrap().source.clone();
    cx.update_window(h, |_, w, cx| {
        view.update(cx, |v, cx| {
            let mut chats = (*v.state.chats).clone();
            *chats.iter_mut().find(|c| c.id == "source").unwrap() =
                crate::local_model::chat(&raw).unwrap();
            v.state.chats = Arc::new(chats);
            v.chats
                .update(cx, |list, _| list.delegate_mut().archived = true);
            v.rebuild_nav(w, cx);
        })
    })
    .unwrap();
    settle(cx, h);
    menu(cx, h, "Restore");
    cx.update_window(h, |_, w, cx| click_label(w, "Restore", cx))
        .unwrap();
    until(cx, h, |_, cx| {
        server.posts() == 2
            && view.read(cx).chat_actions.read(cx).outcome("source")
                == Some(&crate::chat_actions::Outcome::Acknowledged)
    });
    let raw = server.seen.lock().unwrap().source.clone();
    cx.update_window(h, |_, w, cx| {
        view.update(cx, |v, cx| {
            let mut chats = (*v.state.chats).clone();
            *chats.iter_mut().find(|c| c.id == "source").unwrap() =
                crate::local_model::chat(&raw).unwrap();
            v.state.chats = Arc::new(chats);
            v.rebuild_nav(w, cx);
        })
    })
    .unwrap();
    settle(cx, h);
    menu(cx, h, "Make a mission…");
    cx.update_window(h, |_, w, cx| click_label(w, "Make a mission…", cx))
        .unwrap();
    until(cx, h, |_, cx| {
        view.read(cx).mission.read(cx).probe_state().0
    });
    cx.update_window(h, |_, w, cx| w.click("mission-cancel", cx))
        .unwrap();
    settle(cx, h);
    cx.update_window(h, |_, w, cx| {
        assert_eq!(view.read(cx).selected.as_deref(), Some("other"));
        assert_eq!(view.read(cx).editor, editor);
        assert_eq!(input.read(cx).value().as_ref(), text);
        assert!(editor.read(cx).shell_probe().2.unwrap().pending.is_some());
        assert!(
            w.try_find("local-stop").is_none(),
            "Idle pending chat has no Stop action"
        );
    })
    .unwrap();
    assert!(commands.try_recv().is_err());
    assert_eq!(server.posts(), 2);
    cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
    drop(view);
    drop(input);
    drop(editor);
    cx.run_until_parked();
    assert!(writer.command(WriteCommand::Close));
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
                assert!(flushed);
            })
            .await
            .unwrap();
        });
    let store = Store::open(root.clone(), server.options.host()).unwrap();
    assert_eq!(serde_json::to_vec(&store.book.pending).unwrap(), pending);
    drop(store);
    std::fs::remove_dir_all(root).unwrap();
    println!(
        "{}",
        json!({"width":1100,"active_pending":true,"nonselected_archive_restore_conversion_cancel":true,"immutable_envelope":true,"no_send_stop_or_open":true,"private_flush":true})
    );
}
