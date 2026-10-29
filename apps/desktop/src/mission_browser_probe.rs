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
#[path = "chat_menu_mission_probe.rs"]
mod chat_menu;
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
/// Wheel the page until the whole element is in view; the overview's height
/// depends on how much needs the user.
fn into_view(cx: &mut HeadlessAppContext, h: AnyWindowHandle, id: &'static str) {
    let below = cx
        .update_window(h, |_, w, _| {
            w.find(id).bounds().bottom() - w.find("missions-page").bounds().bottom()
        })
        .unwrap();
    if below > px(0.) {
        cx.update_window(h, |_, w, cx| {
            w.scroll(
                "missions-page",
                ScrollDelta::Pixels(point(px(0.), -below - px(8.))),
                cx,
            )
        })
        .unwrap();
        settle(cx, h);
    }
}
pub fn run_mission_browser_probe(cx: &mut HeadlessAppContext) {
    let case = std::env::var("PILOT_NEXT_MISSIONS_CASE").ok();
    assert!(
        case.as_deref().is_none_or(|c| c == "chat-menu"),
        "unknown missions native case"
    );
    chat_menu::run(cx);
    if case.is_some() {
        return;
    }
    let dir = std::env::var_os("PILOT_NEXT_MISSIONS_DIR").map(PathBuf::from);
    if let Some(d) = &dir {
        std::fs::create_dir_all(d).unwrap();
    }
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            let server = Server::start();
            server.reply(
                "/api/missions/mission-A",
                Reply::json(200, overview_detail()),
            );
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
            let mut chats:Vec<_>=["chat-A","chat-B"].iter().map(|id|crate::local_model::chat(&json!({"id":id,"title":"Same chat title","projectId":"project-A","cwd":"/synthetic/A","mode":"ask","state":"idle"})).unwrap()).collect();
            chats[1].signal=Some(crate::state_mark::Signal::NeedsYou);
            v.state.chats=Arc::new(chats);
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
                    .is_some_and(|e| e.contains("Couldn't load the mission"))
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
            into_view(cx, h, "mission-chat-chat-A");
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
            overview_at_a_glance(cx, h, &view, &dir, width, mode);
            needs_you_attention(cx, h, &view, &dir, width, mode, &server);
            into_view(cx, h, "mission-chat-chat-B");
            cx.update_window(h, |_, w, cx| w.click("mission-chat-chat-B", cx))
                .unwrap();
            settle(cx, h);
            assert!(matches!(commands.try_recv().unwrap(),Command::Open{id,..} if id=="chat-B"));
            assert!(commands.try_recv().is_err());
            // The Working now owner is the same exact-ID guarded chat link.
            cx.update_window(h, |_, w, cx| w.press("secondary-[", cx))
                .unwrap();
            until(cx, h, &view, |v, cx| {
                matches!(v.page, Page::Mission(_)) && !v.missions.read(cx).busy
            });
            cx.update_window(h, |_, w, cx| {
                assert_eq!(
                    w.find("mission-owner-working-task-task-D").disabled(),
                    Some(true)
                );
                w.click("mission-owner-working-task-task-C", cx)
            })
            .unwrap();
            settle(cx, h);
            // chat-B is already open, so this returns to it without a new Open.
            cx.update(|cx| {
                assert_eq!(view.read(cx).page, Page::Chat);
                assert_eq!(view.read(cx).selected.as_deref(), Some("chat-B"));
            });
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
    run_chat_mission_jump(cx);
    run_coordinator_jump(cx);
}
/// The overview's title row opens the displayed mission's exact coordinator:
/// pointer and keyboard, Back returns through the overview to the open chat
/// with its draft, an unavailable coordinator is disabled, none assigned shows
/// no header action, and a mission switch never reuses the old coordinator.
fn run_coordinator_jump(cx: &mut HeadlessAppContext) {
    let dir = std::env::var_os("PILOT_NEXT_MISSIONS_DIR").map(PathBuf::from);
    let member = |id: &str, title: &str, mission: &str, project: &str| json!({"id":id,"title":title,"missionId":mission,"projectId":project,"state":"idle"});
    let coordinator_title = "Plan and coordinate the mission 日本語 👩‍💻 with a long name";
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            let server = Server::start();
            let mut a = f::detail("mission-A");
            a["mission"]["coordinatorSessionId"] = json!("chat-C");
            server.reply("/api/missions/mission-A", Reply::json(200, a.clone()));
            server.reply(
                "/api/sessions?archived=all&missionId=mission-A",
                Reply::json(
                    200,
                    json!([
                        member("chat-M", "Member work", "mission-A", "project-A"),
                        member("chat-C", coordinator_title, "mission-A", "project-A"),
                    ]),
                ),
            );
            let mut b = f::detail("mission-B");
            b["mission"]["coordinatorSessionId"] = json!("chat-D");
            let mut slow = Reply::json(200, b);
            slow.delay_ms = 200;
            server.reply("/api/missions/mission-B", slow);
            server.reply(
                "/api/sessions?archived=all&missionId=mission-B",
                Reply::json(
                    200,
                    json!([member(
                        "chat-D",
                        "Other coordinator",
                        "mission-B",
                        "project-B"
                    )]),
                ),
            );
            let private = Private(
                std::env::temp_dir()
                    .canonicalize()
                    .unwrap()
                    .join(format!("native-coordinator-jump-{}", uuid::Uuid::new_v4())),
            );
            let (writer, updates) =
                Interaction::start(server.options.clone(), Ok(private.0.clone()));
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
                                let mut v =
                                    LocalViewer::build(Some(client), Some(writer.clone()), w, cx);
                                v.missions
                                    .update(cx, |b, _| b.options(server.options.clone()));
                                v.state.projects = Arc::new(
                                    crate::local_model::projects(&json!([
                                        {"id":"project-A","name":"Same project","path":"/synthetic/A"},
                                        {"id":"project-B","name":"Other project","path":"/synthetic/B"}
                                    ]))
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
                                    chat(json!({"id":"chat-M","title":"Member work","missionId":"mission-A"})),
                                    chat(json!({"id":"chat-C","title":coordinator_title,"missionId":"mission-A","missionCoordinator":true})),
                                    // A role-like decoy outside the mission.
                                    chat(json!({"id":"chat-X","title":"Mission coordinator","missionCoordinator":true})),
                                    chat(json!({"id":"chat-D","title":"Other coordinator","projectId":"project-B","cwd":"/synthetic/B","missionId":"mission-B","missionCoordinator":true})),
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
            let draft = "Keep this draft 私 👩‍💻";
            cx.update_window(h, |_, w, cx| {
                let input = view.read(cx).editor.read(cx).shell_probe().0;
                input.update(cx, |i, cx| i.focus(w, cx));
                w.input(draft, cx);
            })
            .unwrap();
            settle(cx, h);
            let opened = |cx: &mut HeadlessAppContext, id: &str| {
                let mut seen = Vec::new();
                while let Ok(c) = commands.try_recv() {
                    if let Command::Open { id, .. } = c {
                        seen.push(id);
                    }
                }
                cx.update(|cx| {
                    assert_eq!(view.read(cx).page, Page::Chat);
                    assert_eq!(view.read(cx).selected.as_deref(), Some(id));
                });
                assert_eq!(seen, vec![id.to_owned()], "exactly one Open of {id}");
            };
            let open_mission = |cx: &mut HeadlessAppContext, key: crate::mission_browser::Key| {
                cx.update_window(h, |_, w, cx| w.press("secondary-3", cx))
                    .unwrap();
                until(cx, h, &view, |v, cx| {
                    v.page == Page::Missions
                        && v.missions.read(cx).catalog.is_some()
                        && !v.missions.read(cx).busy
                });
                cx.update_window(h, |_, w, cx| {
                    w.click(format!("mission-row-{}", key.tag()), cx)
                })
                .unwrap();
            };
            let shown = |v: &LocalViewer, cx: &App, id: &str| {
                let b = v.missions.read(cx);
                v.page == Page::Mission(f::key(id))
                    && b.detail.as_ref().is_some_and(|d| d.key == f::key(id))
                    && !b.busy
            };
            open_mission(cx, f::key("mission-A"));
            until(cx, h, &view, |v, cx| shown(v, cx, "mission-A"));
            cx.update_window(h, |_, w, _| {
                let page = w.find("missions-page").bounds();
                let title = w.find("missions-title").bounds();
                let refresh = w.find("missions-refresh").bounds();
                let jump = w.find("mission-open-coordinator");
                assert_ne!(jump.disabled(), Some(true));
                assert_eq!(jump.label(), Some("Open coordinator"));
                let jump = jump.bounds();
                // One title row: title, coordinator, Refresh, … inside the page.
                assert!(jump.left() >= title.right() - px(1.), "{title:?} {jump:?}");
                assert!(
                    jump.right() <= refresh.left() + px(1.),
                    "{jump:?} {refresh:?}"
                );
                assert!((jump.center().y - refresh.center().y).abs() < px(1.));
                assert!(jump.left() >= page.left() && jump.right() <= page.right());
                assert!(jump.size.width >= px(20.) && jump.size.height >= px(20.));
                assert!(w.try_find("mission-no-coordinator").is_none());
            })
            .unwrap();
            capture(
                cx,
                h,
                &dir,
                format!("{}-{}-coordinator.png", width as u32, mode.name()),
            );
            // Pointer: the exact coordinator, not the member or the decoy.
            cx.update_window(h, |_, w, cx| w.click("mission-open-coordinator", cx))
                .unwrap();
            settle(cx, h);
            opened(cx, "chat-C");
            // Back returns to the overview, then through the list to the open
            // chat with its draft.
            cx.update_window(h, |_, w, cx| w.press("secondary-[", cx))
                .unwrap();
            until(cx, h, &view, |v, cx| shown(v, cx, "mission-A"));
            cx.update_window(h, |_, w, _| {
                assert!(w.find("mission-open-coordinator").visible())
            })
            .unwrap();
            for _ in 0..2 {
                cx.update_window(h, |_, w, cx| w.press("secondary-[", cx))
                    .unwrap();
                settle(cx, h);
            }
            until(cx, h, &view, |v, cx| {
                v.page == Page::Chat
                    && v.selected.as_deref() == Some("chat-A")
                    && v.editor.read(cx).shell_probe().0.read(cx).value().as_ref() == draft
            });
            while commands.try_recv().is_ok() {}
            // Keyboard: Tab reaches the title-row action; Enter opens it.
            open_mission(cx, f::key("mission-A"));
            until(cx, h, &view, |v, cx| shown(v, cx, "mission-A"));
            cx.update_window(h, |_, w, cx| {
                view.update(cx, |v, cx| v.missions.update(cx, |b, cx| b.focus(w, cx)));
                for _ in 0..80 {
                    w.press("tab", cx);
                    if w.find("mission-open-coordinator").focused() == Some(true) {
                        break;
                    }
                }
                assert_eq!(w.find("mission-open-coordinator").focused(), Some(true));
                w.press("enter", cx);
            })
            .unwrap();
            settle(cx, h);
            opened(cx, "chat-C");
            cx.update_window(h, |_, w, cx| w.press("secondary-[", cx))
                .unwrap();
            until(cx, h, &view, |v, cx| shown(v, cx, "mission-A"));
            // Outside the Local chat list: disabled with its reason, no Open.
            let all = cx.update(|cx| view.read(cx).state.chats.clone());
            cx.update_window(h, |_, w, cx| {
                view.update(cx, |v, cx| {
                    v.state.chats =
                        Arc::new(all.iter().filter(|c| c.id != "chat-C").cloned().collect());
                    v.rebuild_nav(w, cx);
                })
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                let jump = w.find("mission-open-coordinator");
                assert_eq!(jump.disabled(), Some(true));
                assert_eq!(jump.label(), Some("Coordinator unavailable"));
                w.click("mission-open-coordinator", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update(|cx| assert!(shown(view.read(cx), cx, "mission-A")));
            assert!(commands.try_recv().is_err());
            capture(
                cx,
                h,
                &dir,
                format!(
                    "{}-{}-coordinator-unavailable.png",
                    width as u32,
                    mode.name()
                ),
            );
            cx.update_window(h, |_, w, cx| {
                view.update(cx, |v, cx| {
                    v.state.chats = all.clone();
                    v.rebuild_nav(w, cx);
                })
            })
            .unwrap();
            settle(cx, h);
            // None assigned: no header action; Chats says so.
            let mut none = a.clone();
            none["mission"]["coordinatorSessionId"] = json!(null);
            server.reply("/api/missions/mission-A", Reply::json(200, none));
            cx.update_window(h, |_, w, cx| w.click("missions-refresh", cx))
                .unwrap();
            until(cx, h, &view, |v, cx| {
                shown(v, cx, "mission-A")
                    && v.missions
                        .read(cx)
                        .detail
                        .as_ref()
                        .unwrap()
                        .coordinator
                        .is_none()
            });
            cx.update_window(h, |_, w, _| {
                assert!(w.try_find("mission-open-coordinator").is_none());
                assert!(w.try_find("mission-no-coordinator").is_some());
            })
            .unwrap();
            // Switching missions: the old coordinator never shows for the next
            // mission while it loads; then that mission's own coordinator opens.
            server.reply("/api/missions/mission-A", Reply::json(200, a.clone()));
            cx.update_window(h, |_, w, cx| w.click("missions-refresh", cx))
                .unwrap();
            until(cx, h, &view, |v, cx| {
                shown(v, cx, "mission-A") && v.missions.read(cx).coordinator().is_some()
            });
            cx.update_window(h, |_, w, cx| w.click("missions-list", cx))
                .unwrap();
            until(cx, h, &view, |v, cx| {
                v.page == Page::Missions && !v.missions.read(cx).busy
            });
            cx.update_window(h, |_, w, cx| {
                w.click(format!("mission-row-{}", f::key("mission-B").tag()), cx)
            })
            .unwrap();
            cx.run_until_parked();
            cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
            cx.update(|cx| {
                let v = view.read(cx);
                assert_eq!(v.page, Page::Mission(f::key("mission-B")));
                assert!(
                    v.missions.read(cx).busy,
                    "mission-B detail is still loading"
                );
                assert!(v.missions.read(cx).coordinator().is_none());
            });
            cx.update_window(h, |_, w, _| {
                assert!(w.try_find("mission-open-coordinator").is_none())
            })
            .unwrap();
            until(cx, h, &view, |v, cx| shown(v, cx, "mission-B"));
            cx.update_window(h, |_, w, cx| w.click("mission-open-coordinator", cx))
                .unwrap();
            settle(cx, h);
            opened(cx, "chat-D");
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
                json!({"coordinator_jump":true,"width":width,"mode":mode.name(),"pointer":"chat-C","keyboard_enter":"chat-C","back_draft_kept":true,"unavailable_disabled":true,"none_hidden":true,"switch_no_stale":"chat-D","mutation_http":0})
            );
        }
    }
}

/// Tab from the sidebar list until `target` has focus, never passing `other`.
fn tab_to(
    cx: &mut HeadlessAppContext,
    h: AnyWindowHandle,
    target: &'static str,
    other: &'static str,
) {
    for _ in 0..12 {
        cx.update_window(h, |_, w, cx| w.press("tab", cx)).unwrap();
        settle(cx, h);
        let (hit, passed) = cx
            .update_window(h, |_, w, _| {
                (
                    w.find(target).focused() == Some(true),
                    w.find(other).focused() == Some(true),
                )
            })
            .unwrap();
        assert!(!passed, "{other} is not a Tab stop");
        if hit {
            return;
        }
    }
    panic!("Tab never reached {target}");
}
/// Sidebar mission names open their exact linked mission: pointer before the
/// list is loaded, Enter on the selected row's link once it is, and a truthful
/// note for a link the list doesn't have. The open chat and its draft stay.
fn run_chat_mission_jump(cx: &mut HeadlessAppContext) {
    let server = Server::start();
    let private = Private(
        std::env::temp_dir()
            .canonicalize()
            .unwrap()
            .join(format!("native-chat-mission-jump-{}", uuid::Uuid::new_v4())),
    );
    let (writer, updates) = Interaction::start(server.options.clone(), Ok(private.0.clone()));
    let (client, commands) = LocalClient::synthetic_commands();
    cx.update(|cx| Theme::change(ThemeMode::Light, None, cx));
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
                            chat(json!({"id":"chat-M","missionId":"mission-A"})),
                            chat(json!({"id":"chat-C","missionId":"mission-A","missionCoordinator":true})),
                            chat(json!({"id":"chat-U","missionId":true})),
                            chat(json!({"id":"chat-S","missionId":"mission-Z"})),
                        ]);
                        v.selected = Some("chat-A".into());
                        v.title = "Open chat".into();
                        v.generation = 1;
                        v.state.generation = 1;
                        v.editor.update(cx, |e, cx| {
                            e.select("chat:chat-A".into(), true, false, w, cx)
                        });
                        v.rebuild_nav(w, cx);
                        // Mission links live on flat rows (search, Pinned,
                        // Archived); thread rows drop the caption. Every
                        // fixture title contains "chat".
                        v.chats.update(cx, |l, cx| l.set_query("chat", w, cx));
                        v.listen_writes(updates, w, cx);
                        v
                    })
                },
            )
        })
        .unwrap();
    until(cx, h, &view, |v, cx| v.editor.read(cx).ready());
    let draft = "Keep this draft 私 👩‍💻";
    cx.update_window(h, |_, w, cx| {
        let input = view.read(cx).editor.read(cx).shell_probe().0;
        input.update(cx, |i, cx| i.focus(w, cx));
        w.input(draft, cx);
    })
    .unwrap();
    settle(cx, h);
    let kept = |cx: &mut HeadlessAppContext| {
        cx.update(|cx| {
            let v = view.read(cx);
            assert_eq!(v.selected.as_deref(), Some("chat-A"), "the open chat stays");
            assert_eq!(
                v.editor.read(cx).shell_probe().0.read(cx).value().as_ref(),
                draft
            );
        })
    };
    // Only linked associations are links; unknown and plain rows stay text.
    cx.update_window(h, |_, w, _| {
        for id in ["chat-M", "chat-C", "chat-S"] {
            assert!(
                w.try_find(format!("chat-mission-link-{id}")).is_some(),
                "{id}"
            );
        }
        for id in ["chat-A", "chat-U"] {
            assert!(
                w.try_find(format!("chat-mission-link-{id}")).is_none(),
                "{id}"
            );
        }
        assert!(
            w.within("chat-row-chat-U")
                .try_find("chat-mission-mark")
                .is_some()
        );
    })
    .unwrap();
    // Pointer, before the mission list is loaded: it opens once listed.
    assert!(cx.update(|cx| view.read(cx).missions.read(cx).catalog.is_none()));
    cx.update_window(h, |_, w, cx| w.click("chat-mission-link-chat-M", cx))
        .unwrap();
    until(cx, h, &view, |v, cx| {
        v.page == Page::Mission(f::key("mission-A"))
            && v.missions.read(cx).detail.is_some()
            && !v.missions.read(cx).busy
    });
    kept(cx);
    cx.update(|cx| {
        assert_eq!(
            view.read(cx).missions.read(cx).detail.as_ref().unwrap().key,
            f::key("mission-A")
        )
    });
    // Back returns through the list to the same chat.
    for _ in 0..2 {
        cx.update_window(h, |_, w, cx| w.press("secondary-[", cx))
            .unwrap();
        settle(cx, h);
    }
    cx.update(|cx| assert_eq!(view.read(cx).page, Page::Chat));
    kept(cx);
    // Keyboard: select the coordinator row, Tab to its mission, Enter. Enter
    // opens the mission directly, not the row's chat.
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
    // Unselected rows' links are not Tab stops.
    tab_to(
        cx,
        h,
        "chat-mission-link-chat-C",
        "chat-mission-link-chat-M",
    );
    cx.update_window(h, |_, w, cx| w.press("enter", cx))
        .unwrap();
    until(cx, h, &view, |v, cx| {
        v.page == Page::Mission(f::key("mission-A")) && !v.missions.read(cx).busy
    });
    kept(cx);
    cx.update_window(h, |_, w, cx| w.press("secondary-[", cx))
        .unwrap();
    settle(cx, h);
    cx.update(|cx| assert_eq!(view.read(cx).page, Page::Chat));
    kept(cx);
    // Space also opens a member's link.
    let member = cx.update(|cx| {
        view.read(cx)
            .chats
            .read(cx)
            .delegate()
            .index("chat-M")
            .unwrap()
    });
    cx.update_window(h, |_, w, cx| {
        view.update(cx, |v, cx| v.chats.update(cx, |l, cx| l.focus(w, cx)));
    })
    .unwrap();
    settle(cx, h);
    for _ in 0..8 {
        if cx.update(|cx| view.read(cx).chats.read(cx).delegate().selected == Some(member)) {
            break;
        }
        cx.update_window(h, |_, w, cx| w.press("up", cx)).unwrap();
        settle(cx, h);
    }
    tab_to(
        cx,
        h,
        "chat-mission-link-chat-M",
        "chat-mission-link-chat-C",
    );
    cx.update_window(h, |_, w, cx| w.press("space", cx))
        .unwrap();
    until(cx, h, &view, |v, cx| {
        v.page == Page::Mission(f::key("mission-A")) && !v.missions.read(cx).busy
    });
    kept(cx);
    cx.update_window(h, |_, w, cx| w.press("secondary-[", cx))
        .unwrap();
    settle(cx, h);
    cx.update(|cx| assert_eq!(view.read(cx).page, Page::Chat));
    // A link the mission list doesn't have says so instead of guessing.
    cx.update_window(h, |_, w, cx| w.click("chat-mission-link-chat-S", cx))
        .unwrap();
    until(cx, h, &view, |v, cx| {
        v.page == Page::Missions && !v.missions.read(cx).busy
    });
    cx.update_window(h, |_, w, _| {
        assert!(w.find("missions-jump-note").visible());
    })
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
        json!({"chat_mission_jump":true,"pointer_before_list":true,"keyboard_enter":true,"unlisted_note":true,"draft_and_chat_kept":true})
    );
}

/// mission-A with one task per status and exact-ID owners: chat-B (loaded,
/// needs you), not-loaded (received member outside the Local list).
fn overview_detail() -> serde_json::Value {
    let mut v = f::detail("mission-A");
    v["tasks"] = json!([
        {"id":"task-A","number":1,"title":"Keep the draft","status":"done","order":1,"sessionId":"chat-A"},
        {"id":"task-B","number":2,"title":"Preserve the reader","status":"todo","order":2},
        {"id":"task-C","number":3,"title":"Wire the overview 日本語 with a long title that has to truncate in narrow windows 👩‍💻","status":"in_progress","order":3,"sessionId":"chat-B"},
        {"id":"task-D","number":4,"title":"Review exact links","status":"in_review","order":4,"sessionId":"not-loaded"},
        {"id":"task-E","number":5,"title":"Waiting on a decision","status":"blocked","order":5},
    ]);
    // The user coordinates: open agent comments addressed to nobody need them.
    v["mission"]["coordinatorSessionId"] = json!(null);
    let comment = |i: usize| json!({"id":format!("comment-{i}"),"text":format!("Agent question {i}: which region should the canary use? 日本語 👩‍💻"),"authorSessionId":"chat-B","createdAt":i});
    let mut comments: Vec<_> = (1..=6).map(comment).collect();
    comments.push(json!({"id":"comment-mine","text":"My own note","createdAt":7}));
    comments.push(json!({"id":"comment-coordinator","text":"For chat-A","authorSessionId":"chat-B","targetSessionId":"chat-A","createdAt":8}));
    v["comments"] = json!(comments);
    let ticket = |id: &str, state: &str, at: u64| json!({"id":id,"kind":"linear.issue","linearRole":"managed","relationship":"reference","url":format!("https://linear.app/acme/issue/{id}"),"externalId":id,"title":"Ship the overview","createdAt":at,"linearSync":{"state":state,"reason":"Its status was changed in Linear. Review the ticket before resuming.","error":"Linear returned HTTP 500","updatedAt":at}});
    v["resources"] = json!([
        ticket("ENG-2", "error", 2),
        ticket("ENG-1", "paused", 1),
        ticket("ENG-3", "synced", 0)
    ]);
    v["decisions"] =
        json!([{"id":"decision-3","number":3,"audience":"all","text":"Keep the overview calm."}]);
    v["decisionProposals"] = json!([
        {"id":"proposal-A","decisionId":"decision-3","kind":"edit","status":"pending","reason":"Show comments in Needs you.\nThe user coordinates this mission.","text":"Keep the overview calm and complete."},
        {"id":"proposal-gone","decisionId":"decision-removed","kind":"remove","status":"pending","reason":"Target is gone"},
    ]);
    v
}
/// Tickets, comments and proposals follow chats and blocked tasks, five per
/// kind with the full count; a proposal opens its expanded Decisions row.
fn needs_you_attention(
    cx: &mut HeadlessAppContext,
    h: AnyWindowHandle,
    view: &Entity<LocalViewer>,
    dir: &Option<PathBuf>,
    width: f32,
    mode: ThemeMode,
    server: &Server,
) {
    let requests = server.state.lock().unwrap().seen.len();
    cx.update_window(h, |_, w, _| {
        let order = [
            "mission-needs-chat-chat-B",
            "mission-needs-task-task-E",
            "mission-needs-ticket-ENG-1",
            "mission-needs-ticket-ENG-2",
            "mission-needs-comment-comment-1",
            "mission-needs-comment-comment-5",
            "mission-needs-comments-more",
            "mission-needs-proposal-proposal-A",
        ];
        for pair in order.windows(2) {
            assert!(
                w.find(pair[0]).bounds().top() < w.find(pair[1]).bounds().top(),
                "{pair:?}"
            );
        }
        for absent in [
            "mission-needs-ticket-ENG-3",
            "mission-needs-comment-comment-6",
            "mission-needs-comment-comment-mine",
            "mission-needs-comment-comment-coordinator",
            "mission-needs-proposal-proposal-gone",
            "mission-needs-tickets-more",
            "mission-needs-proposals-more",
            "mission-needs-error",
        ] {
            assert!(w.try_find(absent).is_none(), "{absent}");
        }
        // Static rows keep their whole reason inside the reading column.
        let page = w.find("missions-page").bounds();
        let ticket = w.find("mission-needs-ticket-ENG-1").bounds();
        assert!(ticket.left() >= page.left() && ticket.right() <= page.right());
        assert!(ticket.size.height > px(30.), "title and reason: {ticket:?}");
        assert!(w.try_find("decisions-proposal-proposal-A").is_none());
    })
    .unwrap();
    capture(
        cx,
        h,
        dir,
        format!("{}-{}-overview-needs-you.png", width as u32, mode.name()),
    );
    // Keyboard: the proposal row opens Decisions on that proposal, expanded
    // and scrolled to the top of the page.
    cx.update_window(h, |_, w, cx| {
        let row = "mission-needs-proposal-proposal-A";
        for _ in 0..80 {
            w.press("tab", cx);
            if w.find(row).focused() == Some(true) {
                break;
            }
        }
        assert_eq!(w.find(row).focused(), Some(true));
        w.press("enter", cx);
    })
    .unwrap();
    settle(cx, h);
    cx.update_window(h, |_, w, _| {
        let page = w.find("missions-page").bounds();
        let proposal = w.find("decisions-proposal-proposal-A").bounds();
        assert!(
            proposal.top() >= page.top() - px(1.) && proposal.top() < page.top() + px(40.),
            "proposal at the top: {proposal:?} in {page:?}"
        );
        assert!(w.find("proposal-reason-proposal-A").visible());
    })
    .unwrap();
    capture(
        cx,
        h,
        dir,
        format!("{}-{}-overview-proposal.png", width as u32, mode.name()),
    );
    assert_eq!(
        server.state.lock().unwrap().seen.len(),
        requests,
        "Needs you reads the retained detail, no request"
    );
    // Close Decisions again and return to the top for the remaining checks.
    let to_top = |cx: &mut HeadlessAppContext| {
        cx.update_window(h, |_, w, cx| {
            w.scroll(
                "decisions-proposal-proposal-A",
                ScrollDelta::Pixels(point(px(0.), px(100_000.))),
                cx,
            );
        })
        .unwrap();
        settle(cx, h);
    };
    to_top(cx);
    cx.update_window(h, |_, w, cx| w.click("mission-decisions-open", cx))
        .unwrap();
    settle(cx, h);
    cx.update_window(h, |_, w, _| {
        assert!(w.try_find("decisions-proposal-proposal-A").is_none());
        assert!(w.find("mission-needs-proposal-proposal-A").visible());
    })
    .unwrap();
    cx.update(|cx| assert!(view.read(cx).missions.read(cx).detail.is_some()));
}
fn overview_at_a_glance(
    cx: &mut HeadlessAppContext,
    h: AnyWindowHandle,
    view: &Entity<LocalViewer>,
    dir: &Option<PathBuf>,
    width: f32,
    mode: ThemeMode,
) {
    cx.update(|cx| {
        let b = view.read(cx).missions.read(cx);
        let d = b.detail.as_ref().unwrap();
        assert_eq!(
            b.meta_line(d),
            "Active · Same project · 1 of 5 done · 2 working now",
            "one meta line, no raw IDs"
        );
    });
    cx.update_window(h, |_, w, _| {
        let page = w.find("missions-page").bounds();
        assert!(w.find("mission-progress").visible());
        assert!(w.try_find("mission-needs-chat-chat-A").is_none());
        assert_ne!(w.find("mission-needs-chat-chat-B").disabled(), Some(true));
        assert_ne!(w.find("mission-needs-task-task-E").disabled(), Some(true));
        assert!(w.try_find("mission-working-task-task-B").is_none());
        assert!(w.try_find("mission-working-task-task-E").is_none());
        assert_ne!(
            w.find("mission-owner-working-task-task-C").disabled(),
            Some(true)
        );
        assert_eq!(
            w.find("mission-owner-working-task-task-D").disabled(),
            Some(true)
        );
        // The owner link sits beside its row, inside the reading column.
        let row = w.find("mission-working-task-task-C").bounds();
        let owner = w.find("mission-owner-working-task-task-C").bounds();
        assert!(owner.left() >= row.right() - px(1.), "{row:?} {owner:?}");
        assert!(owner.right() <= page.right() && row.left() >= page.left());
        assert!((owner.center().y - row.center().y).abs() < px(2.));
    })
    .unwrap();
    capture(
        cx,
        h,
        dir,
        format!("{}-{}-overview-glance.png", width as u32, mode.name()),
    );
    // Keyboard: reach the exact Working now row and reveal its task.
    cx.update_window(h, |_, w, cx| {
        let row = "mission-working-task-task-C";
        for _ in 0..80 {
            w.press("tab", cx);
            if w.find(row).focused() == Some(true) {
                break;
            }
        }
        assert_eq!(w.find(row).focused(), Some(true));
        w.press("enter", cx);
    })
    .unwrap();
    until(cx, h, view, |v, cx| {
        let p = v.missions.read(cx).tasks_browser.read(cx);
        p.state.selected.as_deref() == Some("task-C") && !p.state.busy
    });
    cx.update_window(h, |_, w, cx| {
        let page = w.find("missions-page").bounds();
        // The row opens the Tasks tab with its exact task selected in view.
        let list = w.find("mission-tasks-list").bounds();
        let row = w.find("mission-tasks-item-task-C").bounds();
        assert!(
            list.top() >= page.top() && row.top() >= list.top() && row.bottom() <= list.bottom(),
            "Tasks in view: {list:?} {row:?} in {page:?}"
        );
        assert!(
            w.try_find("mission-working-now").is_none(),
            "Overview is hidden"
        );
        assert!(
            w.try_find("mission-tasks-details").is_none(),
            "no details panel"
        );
        assert!(
            view.read(cx)
                .missions
                .read(cx)
                .tasks_browser
                .read(cx)
                .owns_focus(w, cx)
        );
    })
    .unwrap();
    cx.update(|cx| {
        assert_eq!(
            view.read(cx).missions.read(cx).tab,
            crate::mission_browser_view::Tab::Tasks
        )
    });
    capture(
        cx,
        h,
        dir,
        format!("{}-{}-overview-reveal.png", width as u32, mode.name()),
    );
    // Back on Overview, a blocked task in Needs you reveals its own exact ID.
    cx.update_window(h, |_, w, cx| w.click("mission-tab-overview", cx))
        .unwrap();
    settle(cx, h);
    // Wheel over page content outside the inner task list.
    let to_top = |cx: &mut HeadlessAppContext| {
        cx.update_window(h, |_, w, cx| {
            w.scroll(
                "mission-chats-heading",
                ScrollDelta::Pixels(point(px(0.), px(100_000.))),
                cx,
            );
        })
        .unwrap();
        settle(cx, h);
    };
    to_top(cx);
    cx.update_window(h, |_, w, cx| {
        assert!(w.find("mission-needs-task-task-E").bounds().top() >= px(0.));
        w.click("mission-needs-task-task-E", cx)
    })
    .unwrap();
    until(cx, h, view, |v, cx| {
        let p = v.missions.read(cx).tasks_browser.read(cx);
        p.state.selected.as_deref() == Some("task-E") && !p.state.busy
    });
    cx.update_window(h, |_, w, cx| w.click("mission-tab-overview", cx))
        .unwrap();
    settle(cx, h);
    to_top(cx);
}
