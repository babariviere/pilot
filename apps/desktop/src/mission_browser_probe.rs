//! Actual LocalViewer, existing private writer and owned read-only faux daemon.
use super::*;
use crate::mission_browser_fixture::{self as f, Reply, Server};
use gpui_kit::{
    AnyWindowHandle, Bounds, EntityInputHandler, HeadlessAppContext, ScrollDelta, WindowBounds,
    WindowOptions,
    component::{Theme, ThemeMode},
    point, size,
    test::TestWindowExt,
};
use serde_json::json;
use std::{path::PathBuf, time::Instant};
struct Private(PathBuf);
impl Drop for Private {
    fn drop(&mut self) {
        if !std::thread::panicking() {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}
fn settle(cx: &mut HeadlessAppContext, h: AnyWindowHandle) {
    for _ in 0..4 {
        cx.run_until_parked();
        cx.advance_clock(Duration::from_millis(16));
        cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
    }
}
#[track_caller]
fn until(
    cx: &mut HeadlessAppContext,
    h: AnyWindowHandle,
    view: &Entity<LocalViewer>,
    predicate: impl Fn(&LocalViewer, &App) -> bool,
) {
    let end = Instant::now() + Duration::from_secs(6);
    let caller = std::panic::Location::caller();
    while !cx.update(|cx| predicate(view.read(cx), cx)) {
        if Instant::now() >= end {
            let state = cx.update(|cx| {
                let v = view.read(cx);
                let b = v.missions.read(cx);
                format!(
                    "page={:?} selected={:?} route={:?} busy={} error={:?} saved={} nav_error={:?}",
                    v.page,
                    v.selected,
                    b.route,
                    b.busy,
                    b.error,
                    v.editor.read(cx).saved_probe(cx),
                    v.nav_error
                )
            });
            panic!("bounded mission browser publication at {caller}: {state}");
        }
        settle(cx, h);
        std::thread::yield_now();
    }
    settle(cx, h);
}
fn capture(cx: &mut HeadlessAppContext, h: AnyWindowHandle, dir: &Option<PathBuf>, name: String) {
    if let Some(dir) = dir {
        cx.capture_screenshot(h)
            .unwrap()
            .save(dir.join(name))
            .unwrap();
    }
}
pub fn run_mission_browser_probe(cx: &mut HeadlessAppContext) {
    let dir = std::env::var_os("PILOT_NEXT_MISSIONS_DIR").map(PathBuf::from);
    if let Some(d) = &dir {
        std::fs::create_dir_all(d).unwrap();
    }
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            let server = Server::start();
            let private = Private(
                std::env::temp_dir()
                    .canonicalize()
                    .unwrap()
                    .join(format!("native-mission-browser-{}", uuid::Uuid::new_v4())),
            );
            let (writer, updates) =
                Interaction::start(server.options.clone(), Ok(private.0.clone()));
            let drain = updates.clone();
            let (client, commands) = LocalClient::synthetic_commands();
            let mut reducer = crate::local_model::LiveTranscript::default();
            reducer.apply(&json!({"type":"snapshot","entries":(100..120).map(|id|json!({"id":id,"head":id,"kind":"pi.assistant","model":[{"role":"assistant","content":[{"type":"text","text":format!("Reader {id}: preserve Unicode 👩‍💻 é. {}","A retained synthetic paragraph. ".repeat(20))}]}]})).collect::<Vec<_>>()}));
            let rows = reducer.rows();
            cx.update(|cx| Theme::change(mode, None, cx));
            let (h,view)=cx.update(|cx|gpui_kit::open_window(WindowOptions{window_bounds:Some(WindowBounds::Windowed(Bounds::new(Default::default(),size(px(width),px(840.))))),show:false,focus:false,..Default::default()},cx,|w,cx|cx.new(|cx|{
            let mut v=LocalViewer::build(Some(client),Some(writer.clone()),w,cx);
            v.missions.update(cx,|b,_|b.options(server.options.clone()));
            v.state.projects=Arc::new(crate::local_model::projects(&json!([{"id":"project-A","name":"Same project","path":"/synthetic/A"},{"id":"project-B","name":"Same project","path":"/synthetic/B"}])).unwrap());
            v.state.projects_loaded=true;v.state.list_loaded=true;v.state.loaded=true;v.state.status="Synthetic Local fixture".into();
            v.state.chats=Arc::new(["chat-A","chat-B"].iter().map(|id|crate::local_model::chat(&json!({"id":id,"title":"Same chat title","projectId":"project-A","cwd":"/synthetic/A","mode":"ask","state":"idle"})).unwrap()).collect());
            v.selected=Some("chat-A".into());v.title="Same chat title".into();v.generation=1;v.state.generation=1;
            v.transcript.update(cx,|t,cx|t.replace_readonly(rows.clone(),true,cx));v.editor.update(cx,|e,cx|e.select("chat:chat-A".into(),true,false,w,cx));
            v.rebuild_nav(w,cx);v.listen_writes(updates,w,cx);v
        }))).unwrap();
            until(cx, h, &view, |v, cx| v.editor.read(cx).ready());
            cx.update_window(h, |_, w, cx| {
                let input = view.read(cx).editor.read(cx).shell_probe().0;
                input.update(cx, |i, cx| i.focus(w, cx));
                w.input("Unsent mission draft 私 👩‍💻", cx);
                input.update(cx, |i, cx| {
                    i.replace_and_mark_text_in_range(None, "に", Some(1..1), w, cx)
                });
                w.press("secondary-3", cx);
                assert_eq!(view.read(cx).page, Page::Chat);
                input.update(cx, |i, cx| {
                    i.unmark_text(w, cx);
                    i.replace_text_in_range(None, "本", w, cx);
                });
            })
            .unwrap();
            settle(cx, h);
            let (editor, transcript, text) = cx.update(|cx| {
                let v = view.read(cx);
                (
                    v.editor.clone(),
                    v.transcript.clone(),
                    v.editor
                        .read(cx)
                        .shell_probe()
                        .0
                        .read(cx)
                        .value()
                        .to_string(),
                )
            });
            until(cx, h, &view, |v, cx| v.editor.read(cx).saved_probe(cx));
            // Baseline is a settled, genuinely reading-away position, not a
            // tail-follow offset that may legitimately change with viewport height.
            for _ in 0..3 {
                cx.update_window(h, |_, w, cx| {
                    w.scroll(
                        "viewport",
                        ScrollDelta::Pixels(point(px(0.), px(100_000.))),
                        cx,
                    )
                })
                .unwrap();
                settle(cx, h);
            }
            cx.update(|cx| assert!(!transcript.read(cx).history_probe_anchor(cx).2));
            let (row_id, selected, range, anchor) = cx
                .update_window(h, |_, w, cx| {
                    let viewport = w.find("viewport").bounds();
                    let (id, text, bounds) = rows
                        .iter()
                        .map(Message::id)
                        .find_map(|id| {
                            w.try_find(("copy-source", id))?;
                            let text = transcript.read(cx).history_probe_row(id);
                            let b = text.read(cx).bounds();
                            (b.size.width > px(240.)
                                && b.bottom() > viewport.top() + px(24.)
                                && b.top() + px(12.) < viewport.bottom())
                            .then_some((id, text, b))
                        })
                        .expect("mounted selectable row");
                    let y = bounds.top().max(viewport.top()) + px(8.);
                    let from = point(bounds.left() + px(2.), y);
                    let to = point(bounds.left() + px(170.), y);
                    assert!(viewport.contains(&from) && viewport.contains(&to));
                    w.drag(from, to, cx);
                    let range = text
                        .read(cx)
                        .selected_source_range()
                        .expect("real native selection");
                    (
                        id,
                        text,
                        range,
                        transcript.read(cx).history_probe_anchor(cx),
                    )
                })
                .unwrap();
            cx.update_window(h, |_, w, cx| w.press("secondary-3", cx))
                .unwrap();
            until(cx, h, &view, |v, cx| {
                v.missions.read(cx).catalog.is_some() && !v.missions.read(cx).busy
            });
            assert!(commands.try_recv().is_err());
            cx.update_window(h, |_, w, _| {
                assert!(
                    w.try_find("missions-snapshot-note").is_none(),
                    "current snapshots need no routine narration"
                );
                assert!(
                    w.find("missions-scope").visible(),
                    "project scope remains explicit"
                );
                assert!(w.find("missions-refresh").visible());
            })
            .unwrap();
            capture(
                cx,
                h,
                &dir,
                format!("{}-{}-list.png", width as u32, mode.name()),
            );
            cx.update_window(h, |_, w, cx| {
                assert_eq!(view.read(cx).page, Page::Missions);
                // Traverse the mounted controls, not a header-dependent Tab ordinal.
                // Match the full home + mission key: the foreign row shares its raw ID.
                // Keep this keyboard-only so the genuine reader selection survives.
                let local_row = format!("mission-row-{}", f::key("mission-A").tag());
                for _ in 0..80 {
                    w.press("tab", cx);
                    if w.find(local_row.clone()).focused() == Some(true) {
                        break;
                    }
                }
                assert_eq!(
                    w.find(local_row).focused(),
                    Some(true),
                    "keyboard must reach the exact canonical Local mission row"
                );
                assert_eq!(view.read(cx).page, Page::Missions);
                w.press("enter", cx);
            })
            .unwrap();
            until(cx, h, &view, |v, cx| {
                v.page == Page::Mission(f::key("mission-A"))
                    && v.missions.read(cx).detail.is_some()
                    && !v.missions.read(cx).busy
            });
            cx.update(|cx| {
                let v = view.read(cx);
                assert_eq!(
                    v.missions.read(cx).detail.as_ref().unwrap().key,
                    f::key("mission-A")
                );
                assert_eq!(
                    selected.read(cx).selected_source_range(),
                    Some(range.clone())
                );
                assert!(v.editor == editor && v.transcript == transcript);
                assert_eq!(
                    editor.read(cx).shell_probe().0.read(cx).value().as_ref(),
                    text
                );
            });
            capture(
                cx,
                h,
                &dir,
                format!("{}-{}-overview.png", width as u32, mode.name()),
            );
            // Keyboard-only round trip retains the genuine reader selection.
            cx.update_window(h, |_, w, cx| {
                w.press("secondary-[", cx);
                w.press("secondary-[", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update(|cx| {
                let v = view.read(cx);
                assert_eq!(v.page, Page::Chat);
                assert_eq!(v.selected.as_deref(), Some("chat-A"));
                assert!(v.transcript == transcript && v.editor == editor);
                assert_eq!(transcript.read(cx).history_probe_row(row_id), selected);
                assert_eq!(
                    selected.read(cx).selected_source_range(),
                    Some(range.clone())
                );
                let after = transcript.read(cx).history_probe_anchor(cx);
                assert_eq!(anchor.0, after.0);
                assert!(
                    (anchor.1 - after.1).abs() < 1.,
                    "reader anchor changed {anchor:?} -> {after:?}"
                );
                assert_eq!(editor.read(cx).shell_probe().2.unwrap().text, text);
            });
            // Same raw ID at a foreign home is never a Local detail request.
            cx.update_window(h, |_, w, cx| w.click("nav-missions", cx))
                .unwrap();
            until(cx, h, &view, |v, cx| !v.missions.read(cx).busy);
            // After the keyboard-only selection round trip, exercise pointer
            // Refresh. Ordinary outside clicks intentionally retire selection.
            view.update(cx, |v, cx| {
                v.missions.update(cx, |b, _| b.disconnect_probe())
            });
            until(cx, h, &view, |v, cx| {
                v.missions
                    .read(cx)
                    .error
                    .is_some_and(|e| e.contains("reader stopped"))
                    && !v.missions.read(cx).busy
            });
            let stopped_requests = server.state.lock().unwrap().seen.len();
            settle(cx, h);
            assert_eq!(
                stopped_requests,
                server.state.lock().unwrap().seen.len(),
                "reader exit never auto-retries"
            );
            cx.update_window(h, |_, w, cx| w.click("missions-refresh", cx))
                .unwrap();
            until(cx, h, &view, |v, cx| {
                v.missions.read(cx).catalog.is_some()
                    && v.missions.read(cx).error.is_none()
                    && !v.missions.read(cx).busy
            });
            let mut foreign = f::key("mission-A");
            foreign.home.daemon = "foreign-daemon".into();
            let before = server.state.lock().unwrap().seen.len();
            cx.update_window(h, |_, w, cx| {
                w.click(format!("mission-row-{}", foreign.tag()), cx)
            })
            .unwrap();
            settle(cx, h);
            cx.update(|cx| {
                assert_eq!(view.read(cx).page, Page::Mission(foreign));
                assert!(view.read(cx).missions.read(cx).error.is_some());
            });
            assert_eq!(before, server.state.lock().unwrap().seen.len());
            cx.update_window(h, |_, w, cx| w.click("missions-list", cx))
                .unwrap();
            until(cx, h, &view, |v, cx| !v.missions.read(cx).busy);
            // Real error/loading + explicit retry, never a false empty catalog.
            let mut unavailable = Reply::json(503, json!({}));
            unavailable.delay_ms = 80;
            server.reply("/api/mission-catalog", unavailable);
            cx.update_window(h, |_, w, cx| w.click("missions-refresh", cx))
                .unwrap();
            until(cx, h, &view, |v, cx| {
                v.missions.read(cx).error.is_some() && !v.missions.read(cx).busy
            });
            cx.update_window(h, |_, w, cx| {
                let _ = cx;
                assert!(w.try_find("missions-error").is_some());
                assert!(
                    w.find("missions-snapshot-note").visible(),
                    "stale snapshot warning stays visible"
                );
                assert_eq!(
                    w.find(format!("mission-row-{}", f::key("mission-A").tag()))
                        .disabled(),
                    Some(true)
                );
            })
            .unwrap();
            capture(
                cx,
                h,
                &dir,
                format!("{}-{}-read-error.png", width as u32, mode.name()),
            );
            server.reply("/api/mission-catalog", Reply::json(200, f::catalog()));
            cx.update_window(h, |_, w, cx| w.click("missions-refresh", cx))
                .unwrap();
            until(cx, h, &view, |v, cx| {
                v.missions.read(cx).error.is_none() && !v.missions.read(cx).busy
            });
            cx.update_window(h, |_, w, cx| {
                w.click(format!("mission-row-{}", f::key("mission-A").tag()), cx)
            })
            .unwrap();
            until(cx, h, &view, |v, cx| {
                v.missions.read(cx).detail.is_some() && !v.missions.read(cx).busy
            });
            let offline_requests = server.state.lock().unwrap().seen.len();
            cx.update_window(h, |_, w, cx| {
                view.update(cx, |v, cx| {
                    v.state.status = "Offline synthetic fixture".into();
                    v.rebuild_nav(w, cx);
                })
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, _| {
                assert!(w.try_find("mission-goal").is_some());
                assert!(
                    w.find("missions-snapshot-note").visible(),
                    "offline warning stays visible"
                );
                assert_eq!(w.find("mission-chat-chat-A").disabled(), Some(true));
            })
            .unwrap();
            // Copy goal stays available offline, from the overview … menu.
            crate::mission_browser_view::probe_menu_command(cx, h, "Copy goal");
            cx.update_window(h, |_, w, cx| {
                assert_eq!(
                    cx.read_from_clipboard().unwrap().text().unwrap(),
                    f::detail("mission-A")["mission"]["goal"].as_str().unwrap()
                );
                view.update(cx, |v, cx| {
                    v.state.status = "Synthetic Local fixture".into();
                    v.rebuild_nav(w, cx);
                });
            })
            .unwrap();
            settle(cx, h);
            assert_eq!(
                offline_requests,
                server.state.lock().unwrap().seen.len(),
                "offline/online presentation never polls or reloads"
            );
            cx.update_window(h, |_, w, _| {
                assert_eq!(w.find("mission-chat-not-loaded").disabled(), Some(true));
            })
            .unwrap();
            crate::mission_browser_view::probe_menu_command(cx, h, "Copy goal");
            cx.update_window(h, |_, w, cx| {
                assert_eq!(
                    cx.read_from_clipboard().unwrap().text().unwrap(),
                    f::detail("mission-A")["mission"]["goal"].as_str().unwrap()
                );
                w.click("mission-chat-chat-A", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update(|cx| {
                assert_eq!(view.read(cx).page, Page::Chat);
                assert_eq!(view.read(cx).selected.as_deref(), Some("chat-A"));
                assert_eq!(editor.read(cx).shell_probe().2.unwrap().text, text);
            });
            assert!(commands.try_recv().is_err());
            cx.update_window(h, |_, w, cx| w.press("secondary-[", cx))
                .unwrap();
            until(cx, h, &view, |v, cx| {
                matches!(v.page, Page::Mission(_)) && !v.missions.read(cx).busy
            });
            cx.update_window(h, |_, w, cx| w.click("mission-chat-chat-B", cx))
                .unwrap();
            settle(cx, h);
            assert!(matches!(commands.try_recv().unwrap(),Command::Open{id,..} if id=="chat-B"));
            assert!(commands.try_recv().is_err());
            assert!(server.all_gets());
            cx.update_window(h, |_, w, cx| {
                view.update(cx, |v, _| v.writes = None);
                w.remove_window();
            })
            .unwrap();
            drop(view);
            drop(editor);
            drop(transcript);
            drop(selected);
            cx.run_until_parked();
            assert!(writer.command(WriteCommand::Close));
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            rt.block_on(async {
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
            let store = Store::open(private.0.clone(), server.options.host()).unwrap();
            assert_eq!(store.book.drafts["chat:chat-A"].text, text);
            assert!(store.book.pending.is_empty());
            drop(store);
            println!(
                "{}",
                json!({"width":width,"mode":mode.name(),"actual_local_viewer":true,"global_home_id":true,"foreign_no_fallback":true,"marked_input_fenced":true,"draft_reader_selection_keyboard_roundtrip":true,"copy_unicode":true,"offline_safe_no_poll":true,"reader_exit_explicit_retry":true,"error_explicit_retry":true,"exact_chat_open":"chat-B","mutation_http":0,"private_autosave_and_flush":true})
            );
        }
    }
}
