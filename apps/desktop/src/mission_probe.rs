//! Actual production viewer/form/courier over owned faux HTTP and private state.
//! Offscreen native pixels are not visible smoothness, OS IME or AX acceptance.
use super::*;
use crate::{
    interaction::WriteState,
    mission_conversion::Outcome,
    mission_fixture::{Behavior, Daemon, Seen},
};
use gpui_kit::{
    AnyWindowHandle, Bounds, HeadlessAppContext, ScrollDelta, WindowBounds, WindowOptions,
    component::{Theme, ThemeMode},
    point, size,
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
    fn start(behavior: Behavior, old: bool) -> Self {
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        let (stop, shutdown) = tokio::sync::oneshot::channel();
        let thread = std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            runtime.block_on(async move {
                let daemon = Daemon::start(behavior).await;
                if old {
                    daemon.seen.lock().unwrap().hello["capabilities"]
                        .as_object_mut()
                        .unwrap()
                        .remove("guardedMissionConversion");
                }
                tx.send((
                    daemon.options.clone(),
                    daemon.seen.clone(),
                    daemon.released.clone(),
                ))
                .unwrap();
                let _ = shutdown.await;
                drop(daemon);
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
}
impl Drop for Server {
    fn drop(&mut self) {
        if let Some(tx) = self.stop.take() {
            let _ = tx.send(());
        }
        if let Some(thread) = self.thread.take() {
            thread.join().unwrap();
        }
    }
}
struct Private(PathBuf);
impl Private {
    fn new() -> Self {
        Self(
            std::env::temp_dir()
                .canonicalize()
                .unwrap()
                .join(format!("native-mission-private-{}", uuid::Uuid::new_v4())),
        )
    }
}
impl Drop for Private {
    fn drop(&mut self) {
        // Failure unwinding may precede the UI's last writer owner dropping.
        // Preserve this private synthetic fixture rather than race its final flush.
        if !std::thread::panicking() {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}
fn settle(cx: &mut HeadlessAppContext, handle: AnyWindowHandle) {
    for _ in 0..8 {
        cx.run_until_parked();
        cx.advance_clock(Duration::from_millis(16));
        cx.update_window(handle, |_, w, cx| w.render_frame(cx))
            .unwrap();
    }
}
fn until(
    cx: &mut HeadlessAppContext,
    handle: AnyWindowHandle,
    view: &Entity<LocalViewer>,
    condition: impl Fn(&LocalViewer, &App) -> bool,
) {
    let deadline = Instant::now() + Duration::from_secs(6);
    while !cx.update(|cx| condition(view.read(cx), cx)) {
        assert!(
            Instant::now() < deadline,
            "bounded native mission publication"
        );
        settle(cx, handle);
        std::thread::yield_now();
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
fn drain(writer: &Interaction, updates: &async_channel::Receiver<WriteState>) {
    assert!(writer.command(WriteCommand::Close));
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        tokio::time::timeout(Duration::from_secs(3), async {
            let mut flushed = false;
            while let Ok(state) = updates.recv().await {
                flushed |= state.flushed;
            }
            assert!(
                flushed,
                "private writer drained before deleting fixture state"
            );
        })
        .await
        .unwrap();
    });
}

pub fn run_mission_probe(cx: &mut HeadlessAppContext) {
    let dir = std::env::var_os("PILOT_NEXT_MISSION_DIR").map(PathBuf::from);
    if let Some(dir) = &dir {
        std::fs::create_dir_all(dir).unwrap();
    }
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            for (name, behavior, old) in [
                ("created", Behavior::Slow, false),
                ("receipt-write-fault", Behavior::Slow, false),
                ("unknown", Behavior::LostAfter, false),
                ("not-admitted", Behavior::LostBefore, false),
                ("old-daemon", Behavior::Accept, true),
            ] {
                let server = Server::start(behavior, old);
                let private = Private::new();
                let (writer, updates) =
                    Interaction::start(server.options.clone(), Ok(private.0.clone()));
                let drain_updates = updates.clone();
                let rows:Vec<_>=(100..120).map(|id|Message::live(id,"assistant".into(),format!("Synthetic conversation {id}. Keep this reader and Unicode 👩‍💻 é intact.\n\n{}","A retained synthetic paragraph. ".repeat(16)))).collect();
                cx.update(|cx| Theme::change(mode, None, cx));
                let (handle,view)=cx.update(|cx|gpui_kit::open_window(WindowOptions {
                window_bounds:Some(WindowBounds::Windowed(Bounds::new(Default::default(),size(px(width),px(760.))))),show:false,focus:false,..Default::default()
            },cx,|w,cx|cx.new(|cx|{
                let mut view=LocalViewer::build(None,Some(writer.clone()),w,cx);
                view.state.projects=Arc::new(crate::local_model::projects(&json!([{"id":"project","name":"Exact project","path":"/synthetic/project"}])).unwrap());
                view.state.projects_loaded=true;view.state.list_loaded=true;view.state.loaded=true;view.state.status="Synthetic Local fixture".into();
                view.state.chats=Arc::new(vec![crate::local_model::chat(&json!({"id":"source","projectId":"project","title":"Source title","cwd":"/synthetic/project","mode":"ask","state":"working"})).unwrap(),
                    crate::local_model::chat(&json!({"id":"other","projectId":"project","title":"Other chat","cwd":"/synthetic/project","mode":"ask","state":"idle"})).unwrap()]);
                view.selected=Some("source".into());view.title="Source title".into();view.generation=1;view.state.generation=1;
                view.transcript.update(cx,|t,cx|t.replace_readonly(rows.clone(),true,cx));
                view.editor.update(cx,|e,cx|e.select("chat:source".into(),true,true,w,cx));
                view.rebuild_nav(w,cx);view.listen_writes(updates,w,cx);view
            }))).unwrap();
                until(cx, handle, &view, |v, cx| v.editor.read(cx).ready());
                cx.update_window(handle, |_, w, cx| {
                    w.render_frame(cx);
                    let root = w.find("desktop-root").bounds();
                    assert_eq!(root.size.width, px(width));
                    assert_eq!(root.size.height, px(760.));
                    assert_eq!(w.viewport_size(), root.size);
                    let input = view.read(cx).editor.read(cx).shell_probe().0;
                    input.update(cx, |v, cx| v.set_value("Unsent draft 私の下書き 👩‍💻", w, cx));
                })
                .unwrap();
                // Read away from the tail before opening a modal. It must never reset.
                for _ in 0..3 {
                    cx.update_window(handle, |_, w, cx| {
                        w.scroll(
                            "viewport",
                            ScrollDelta::Pixels(point(px(0.), px(100_000.))),
                            cx,
                        )
                    })
                    .unwrap();
                    settle(cx, handle);
                }
                let (editor, transcript, anchor) = cx.update(|cx| {
                    let v = view.read(cx);
                    (
                        v.editor.clone(),
                        v.transcript.clone(),
                        v.transcript.read(cx).history_probe_anchor(cx),
                    )
                });
                cx.update_window(handle, |_, w, cx| w.click("make-mission", cx))
                    .unwrap();
                until(cx, handle, &view, |v, cx| {
                    let s = v.mission.read(cx).probe_state();
                    s.0 || s.3
                });
                cx.update_window(handle, |_, w, cx| {
                    let modal = w.find("mission-sheet").bounds();
                    let root = w.find("desktop-root").bounds();
                    assert!(
                        modal.left() >= root.left()
                            && modal.right() <= root.right()
                            && modal.bottom() <= root.bottom()
                    );
                    view.update(cx, |v, cx| {
                        assert!(!v.prepare_navigation(w, cx));
                        v.show_home(w, cx);
                        v.toggle_jump(w, cx);
                        v.open_settings(w, cx);
                        assert_eq!(v.selected.as_deref(), Some("source"));
                        assert_eq!(v.page, Page::Chat);
                        assert!(v.jump.is_none() && v.settings_window.is_none());
                    });
                })
                .unwrap();
                capture(
                    cx,
                    handle,
                    &dir,
                    format!("{}-{}-{name}-ready.png", width as u32, mode.name()),
                );
                if old {
                    cx.update_window(handle, |_, w, cx| {
                        assert_eq!(w.find("mission-confirm").disabled(), Some(true));
                        w.click("mission-cancel", cx);
                    })
                    .unwrap();
                    assert!(server.seen.lock().unwrap().posts.is_empty());
                } else {
                    cx.update_window(handle, |_, w, cx| {
                        let pane = view.read(cx).mission.clone();
                        let title = pane.read(cx).title.clone();
                        title.update(cx, |t, cx| t.focus(w, cx));
                        w.press("secondary-a", cx);
                        w.input(" \u{feff} ", cx);
                        assert_eq!(title.read(cx).value().as_ref(), " \u{feff} ");
                        w.press("secondary-enter", cx);
                        pane.update(cx, |form, cx| form.confirm(w, cx));
                        assert!(
                            pane.read(cx).probe_state().2.is_none(),
                            "invalid title cannot reserve an attempt"
                        );
                        assert!(
                            server.seen.lock().unwrap().posts.is_empty(),
                            "invalid title cannot POST"
                        );
                        title.update(cx, |t, cx| t.focus(w, cx));
                        w.press("secondary-a", cx);
                        w.input(
                            if mode == ThemeMode::Dark {
                                "\u{feff} \u{0085} \u{feff}"
                            } else {
                                "\u{feff} Native mission 日本語 \u{feff}"
                            },
                            cx,
                        );
                        let goal = pane.read(cx).goal.clone();
                        goal.update(cx, |t, cx| t.focus(w, cx));
                        w.input(
                            "\u{feff} A goal captured from the live native editor. \u{feff}",
                            cx,
                        );
                        w.press("enter", cx);
                        if mode == ThemeMode::Dark {
                            w.click("mission-coordinator", cx);
                            w.click("mission-draft", cx);
                        }
                        w.press("secondary-enter", cx);
                        w.press("secondary-enter", cx);
                        w.click("mission-confirm", cx);
                    })
                    .unwrap();
                    until(cx, handle, &view, |v, cx| {
                        v.mission.read(cx).probe_state().2.is_some()
                            && server.seen.lock().unwrap().posts.len() == 1
                    });
                    if behavior == Behavior::Slow {
                        capture(
                            cx,
                            handle,
                            &dir,
                            format!("{}-{}-pending.png", width as u32, mode.name()),
                        );
                        cx.update_window(handle, |_, w, cx| w.click("mission-cancel", cx))
                            .unwrap();
                        settle(cx, handle);
                        // Leave the sheet CLOSED until the actual 201 arrives.
                        // For the fault case, refuse just the private atomic rename.
                        if name == "receipt-write-fault" {
                            std::fs::rename(
                                private.0.join("state-v1.json"),
                                private.0.join("preserved-unknown.json"),
                            )
                            .unwrap();
                            std::fs::create_dir(private.0.join("state-v1.json")).unwrap();
                        }
                        server.released.notify_one();
                        until(cx, handle, &view, |v, cx| {
                            if name == "receipt-write-fault" {
                                !v.editor.read(cx).ready()
                            } else {
                                matches!(
                                    v.mission.read(cx).probe_state().2,
                                    Some(Outcome::Created { .. })
                                )
                            }
                        });
                        cx.update_window(handle, |_, w, cx| {
                            assert_ne!(w.find("make-mission").disabled(), Some(true));
                            w.click("make-mission", cx);
                        })
                        .unwrap();
                        settle(cx, handle);
                        assert_eq!(
                            server.seen.lock().unwrap().posts.len(),
                            1,
                            "closed/reopen never reposts"
                        );
                        cx.update_window(handle, |_, w, cx| {
                            w.click("mission-copy-id", cx);
                            assert_eq!(
                                cx.read_from_clipboard().unwrap().text().as_deref(),
                                Some("mission-exact")
                            );
                        })
                        .unwrap();
                        if name == "receipt-write-fault" {
                            capture(
                                cx,
                                handle,
                                &dir,
                                format!("{}-{}-fault-receipt.png", width as u32, mode.name()),
                            );
                            cx.update_window(handle, |_, w, cx| w.click("mission-cancel", cx))
                                .unwrap();
                            settle(cx, handle);
                            cx.update_window(handle, |_, w, cx| w.click("make-mission", cx))
                                .unwrap();
                            settle(cx, handle);
                            cx.update_window(handle, |_, w, cx| {
                                w.click("mission-copy-id", cx);
                                assert_eq!(
                                    cx.read_from_clipboard().unwrap().text().as_deref(),
                                    Some("mission-exact")
                                );
                            })
                            .unwrap();
                            assert_eq!(server.seen.lock().unwrap().posts.len(), 1);
                        }
                    } else {
                        until(cx, handle, &view, |v, cx| {
                            !v.mission.read(cx).probe_state().1
                        });
                        cx.update_window(handle, |_, w, cx| w.click("mission-check", cx))
                            .unwrap();
                        until(cx, handle, &view, |v, cx| {
                            !v.mission.read(cx).probe_state().1
                        });
                        assert!(cx.update(|cx| matches!(
                            view.read(cx).mission.read(cx).probe_state().2,
                            Some(Outcome::Unknown)
                        )));
                    }
                    capture(
                        cx,
                        handle,
                        &dir,
                        format!("{}-{}-{name}-outcome.png", width as u32, mode.name()),
                    );
                    cx.update_window(handle, |_, w, cx| w.click("mission-cancel", cx))
                        .unwrap();
                    settle(cx, handle);
                    let s = server.seen.lock().unwrap();
                    assert_eq!(s.posts.len(), 1);
                    assert_eq!(s.posts[0]["fromSessionId"], "source");
                    assert_eq!(s.posts[0]["projectId"], "project");
                    assert_eq!(
                        s.posts[0]["title"],
                        if mode == ThemeMode::Dark {
                            "\u{0085}"
                        } else {
                            "Native mission 日本語"
                        }
                    );
                    assert_eq!(
                        s.posts[0]["goal"],
                        "A goal captured from the live native editor."
                    );
                    assert_eq!(s.posts[0]["coordinator"], mode != ThemeMode::Dark);
                    assert_eq!(s.posts[0]["draft"], mode != ThemeMode::Dark);
                }
                settle(cx, handle);
                cx.update_window(handle, |_, w, cx| {
                    let v = view.read(cx);
                    assert_eq!(v.selected.as_deref(), Some("source"));
                    assert_eq!(v.generation, 1);
                    assert!(v.editor == editor && v.transcript == transcript);
                    let (input, _, draft) = v.editor.read(cx).shell_probe();
                    assert_eq!(
                        input.read(cx).value().as_ref(),
                        "Unsent draft 私の下書き 👩‍💻"
                    );
                    assert_eq!(draft.unwrap().text, "Unsent draft 私の下書き 👩‍💻");
                    let after = v.transcript.read(cx).history_probe_anchor(cx);
                    assert_eq!(anchor.0, after.0);
                    assert!((anchor.1 - after.1).abs() < 1.0);
                    assert_eq!(anchor.2, after.2);
                    // Kit records disabled=true only; None is the enabled default.
                    if name != "receipt-write-fault" {
                        assert_ne!(w.find("local-stop").disabled(), Some(true));
                        w.click("local-stop", cx);
                    }
                })
                .unwrap();
                let (selected_id, selected, range) = cx
                    .update_window(handle, |_, w, cx| {
                        let viewport = w.find("viewport").bounds();
                        let (id, text, bounds) = (100..120)
                            .find_map(|id| {
                                w.try_find(("copy-source", id))?;
                                let text = view.read(cx).transcript.read(cx).history_probe_row(id);
                                let bounds = text.read(cx).bounds();
                                (bounds.size.width > px(240.)
                                    && bounds.bottom() > viewport.top() + px(24.)
                                    && bounds.top() + px(12.) < viewport.bottom())
                                .then_some((id, text, bounds))
                            })
                            .expect("mounted selectable text intersects transcript viewport");
                        let y = bounds.top().max(viewport.top()) + px(8.);
                        let from = point(bounds.left() + px(2.), y);
                        let to = point(bounds.left() + px(180.), y);
                        assert!(
                            viewport.contains(&from) && viewport.contains(&to),
                            "real drag is inside viewport: {bounds:?} / {viewport:?}"
                        );
                        w.drag(from, to, cx);
                        let range = text
                            .read(cx)
                            .selected_source_range()
                            .expect("real native selection after conversion");
                        assert!(
                            rows[(id - 100) as usize]
                                .source()
                                .is_char_boundary(range.start)
                                && rows[(id - 100) as usize]
                                    .source()
                                    .is_char_boundary(range.end)
                        );
                        (id, text, range)
                    })
                    .unwrap();
                // A new projection after conversion must preserve the same native
                // selected message and reader, not merely leave the old pixels up.
                cx.update_window(handle, |_, w, cx| {
                    view.update(cx, |v, cx| {
                        let mut next = v.state.clone();
                        next.rows = rows.clone();
                        next.rows.push(Message::live(
                            120,
                            "assistant".into(),
                            "Synthetic streaming continuation after conversion.".into(),
                        ));
                        next.page_revision += 1;
                        v.accept(next, w, cx);
                    });
                })
                .unwrap();
                settle(cx, handle);
                cx.update(|cx| {
                    assert!(
                        view.read(cx)
                            .transcript
                            .read(cx)
                            .history_probe_row(selected_id)
                            == selected
                    );
                    assert_eq!(selected.read(cx).selected_source_range(), Some(range));
                    let after = view.read(cx).transcript.read(cx).history_probe_anchor(cx);
                    assert_eq!(anchor.0, after.0);
                    assert!((anchor.1 - after.1).abs() < 1.0);
                });
                if name != "receipt-write-fault" {
                    until(cx, handle, &view, |v, cx| {
                        server.seen.lock().unwrap().stops == 1
                            && v.editor.read(cx).shell_probe().2.is_some_and(|draft| {
                                draft.pending.is_none()
                                    && draft.last.is_some_and(|last| {
                                        last.kind == "stop" && last.state == "accepted"
                                    })
                            })
                    });
                }
                cx.update(|cx| {
                    assert_eq!(
                        view.read(cx).editor.read(cx).shell_probe().2.unwrap().text,
                        "Unsent draft 私の下書き 👩‍💻"
                    )
                });
                // Stop consuming UI updates before explicitly draining this fixture worker.
                cx.update_window(handle, |_, w, cx| {
                    view.update(cx, |v, _| {
                        v.writes = None;
                    });
                    w.remove_window();
                })
                .unwrap();
                drop(view);
                drop(editor);
                drop(transcript);
                cx.run_until_parked();
                if name == "receipt-write-fault" {
                    // A fenced writer must NOT claim a durable flush on Close.
                    // Withdraw fixture senders (including GPUI-retained entities),
                    // join publication close, and retain the explicit write failure.
                    assert!(writer.command(WriteCommand::Close));
                    writer.disconnect_fixture();
                    drop(writer);
                    let runtime = tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build()
                        .unwrap();
                    runtime.block_on(async {
                        tokio::time::timeout(Duration::from_secs(3), async {
                            let mut failed = false;
                            while let Ok(state) = drain_updates.recv().await {
                                assert!(
                                    !state.flushed,
                                    "fault is never a successful durability acknowledgement"
                                );
                                failed |= state.error.is_some();
                            }
                            assert!(failed);
                        })
                        .await
                        .unwrap();
                    });
                } else {
                    drain(&writer, &drain_updates);
                    drop(writer);
                }
                println!(
                    "{}",
                    json!({"width":width,"mode":mode.name(),"case":name,"actual_native_root":true,"faux_http_only":true,"same_chat_draft_reader":true,"duplicate_posts":0,"guarded_runtime":!old})
                );
            }
        }
    }
}
