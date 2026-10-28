//! Real mounted LocalViewer/inspector; owned faux HTTP and private draft state only.
use super::*;
use crate::{
    mission_browser_fixture::{self as f, Reply, Server},
    mission_inspector::Metadata,
};
use gpui_kit::{
    AnyWindowHandle, Bounds, EntityInputHandler, Focusable, HeadlessAppContext, ScrollDelta,
    WindowBounds, WindowOptions, component::ThemeMode, point, size, test::TestWindowExt,
};
use serde_json::json;
use std::{path::PathBuf, time::Instant};
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
    v: &Entity<LocalViewer>,
    check: impl Fn(&LocalViewer, &App) -> bool,
) {
    let end = Instant::now() + Duration::from_secs(7);
    while !cx.update(|cx| check(v.read(cx), cx)) {
        assert!(
            Instant::now() < end,
            "bounded inspector publication at {}",
            std::panic::Location::caller()
        );
        settle(cx, h);
        std::thread::yield_now();
    }
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
pub fn run_mission_inspector_probe(cx: &mut HeadlessAppContext) {
    let dir = std::env::var_os("PILOT_NEXT_MISSION_CONTEXT_DIR").map(PathBuf::from);
    if let Some(d) = &dir {
        std::fs::create_dir_all(d).unwrap();
    }
    let selected_case = std::env::var_os("PILOT_NEXT_MISSION_CONTEXT_CASE")
        .map(|v| v.into_string().expect("fixture case must be UTF-8"));
    assert!(
        selected_case
            .as_deref()
            .is_none_or(|v| v == "shortcut-close"),
        "unknown mission context fixture case"
    );
    let mut ran = 0;
    // Final layout checks; the side_panel target covers open/close motion.
    cx.update(|cx| cx.set_reduce_motion(true));
    for (width, height, pending) in [
        (680., 840., false),
        (680., 520., false),
        (1100., 840., false),
        (1100., 840., true),
    ] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            if pending && mode == ThemeMode::Dark {
                continue;
            }
            if selected_case.is_some() && (width != 1100. || mode != ThemeMode::Light) {
                continue;
            }
            ran += 1;
            let case_name = format!("{}{}", mode.name(), if pending { "-pending" } else { "" });
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
            let server = Server::start();
            let root = std::env::temp_dir()
                .canonicalize()
                .unwrap()
                .join(format!("native-mission-context-{}", uuid::Uuid::new_v4()));
            // Seed a real private immutable unknown envelope before the writer
            // acquires its lease. No courier/retry is invoked by this fixture.
            let pending_before = {
                let mut store = Store::open(root.clone(), server.options.host()).unwrap();
                let key = if pending {
                    "chat:chat-A"
                } else {
                    "chat:pending-other"
                };
                store
                    .prepare(
                        key,
                        &crate::delivery_store::Draft {
                            revision: 1,
                            text: "Owned immutable pending 日本語 👩‍💻".into(),
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
            let mut reducer = crate::local_model::LiveTranscript::default();
            reducer.apply(&json!({"type":"snapshot","entries":(100..120).map(|id|json!({"id":id,"head":id,"kind":"pi.assistant","model":[{"role":"assistant","content":[{"type":"text","text":format!("Reader {id} 日本語 👩‍💻 {}","Keep this synthetic reading anchor. ".repeat(30))}]}]})).collect::<Vec<_>>()}));
            let rows = reducer.rows();
            let (h,view)=cx.update(|cx|gpui_kit::open_window(WindowOptions{window_bounds:Some(WindowBounds::Windowed(Bounds::new(Default::default(),size(px(width),px(height))))),show:false,focus:false,..Default::default()},cx,|w,cx|cx.new(|cx|{
                let mut v=LocalViewer::build(Some(client),Some(writer.clone()),w,cx);
                v.mission_context.update(cx,|p,_|p.options(server.options.clone()));
                v.state.status="Synthetic Local fixture".into();v.state.loaded=true;v.state.list_loaded=true;v.state.generation=1;v.generation=1;
                let sessions=json!([{"id":"chat-A","title":"Active chat 日本語","projectId":"project-A","missionId":"mission-A","cwd":"/synthetic/A","mode":"ask","state":"idle"},
                    {"id":"chat-B","title":"Other chat 日本語","projectId":"project-A","missionId":"mission-A","cwd":"/synthetic/A","mode":"ask","state":"idle"}]);
                v.state.chats=Arc::new(sessions.as_array().unwrap().iter().map(|s|crate::local_model::chat(s).unwrap()).collect());
                Metadata::accept(&mut v.state.mission_metadata,&json!({"type":"sessions","sessions":sessions}));
                v.state.projects=Arc::new(crate::local_model::projects(&json!([{"id":"project-A","name":"Synthetic","path":"/synthetic/A"}])).unwrap());v.state.projects_loaded=true;
                v.selected=Some("chat-A".into());v.title="Active chat 日本語".into();
                v.transcript.update(cx,|t,cx|t.replace_readonly(rows.clone(),true,cx));
                v.editor.update(cx,|e,cx|e.select("chat:chat-A".into(),true,false,w,cx));v.rebuild_nav(w,cx);v.listen_writes(updates,w,cx);v
            }))).unwrap();
            until(cx, h, &view, |v, cx| v.editor.read(cx).ready());
            let (editor, transcript) = cx.update(|cx| {
                (
                    view.read(cx).editor.clone(),
                    view.read(cx).transcript.clone(),
                )
            });
            if !pending {
                cx.update_window(h, |_, w, cx| {
                    let input = editor.read(cx).shell_probe().0;
                    input.update(cx, |i, cx| i.focus(w, cx));
                    w.input("Unsent 私 👩‍💻", cx);
                    input.update(cx, |i, cx| {
                        i.replace_and_mark_text_in_range(None, "に", Some(1..1), w, cx)
                    });
                    w.press("secondary-alt-m", cx);
                    assert!(!view.read(cx).mission_context.read(cx).visible);
                    input.update(cx, |i, cx| {
                        i.unmark_text(w, cx);
                        i.replace_text_in_range(None, "本", w, cx);
                    });
                })
                .unwrap();
            }
            until(cx, h, &view, |v, cx| v.editor.read(cx).saved_probe(cx));
            let text = cx.update(|cx| editor.read(cx).shell_probe().0.read(cx).value().to_string());
            for _ in 0..2 {
                cx.update_window(h, |_, w, cx| {
                    w.scroll(
                        "viewport",
                        ScrollDelta::Pixels(point(px(0.), px(100000.))),
                        cx,
                    )
                })
                .unwrap();
                settle(cx, h);
            }
            let (selected, range, anchor) = cx
                .update_window(h, |_, w, cx| {
                    let viewport = w.find("viewport").bounds();
                    let (text, b) = rows
                        .iter()
                        .map(Message::id)
                        .find_map(|id| {
                            w.try_find(("copy-source", id))?;
                            let text = transcript.read(cx).history_probe_row(id);
                            let b = text.read(cx).bounds();
                            (b.size.width > px(240.)
                                && b.bottom() > viewport.top() + px(24.)
                                && b.top() + px(12.) < viewport.bottom())
                            .then_some((text, b))
                        })
                        .expect("mounted actual reader row");
                    let y = b.top().max(viewport.top()) + px(8.);
                    let from = point(b.left() + px(2.), y);
                    let to = point(b.left() + px(170.), y);
                    assert!(viewport.contains(&from) && viewport.contains(&to));
                    w.drag(from, to, cx);
                    let range = text
                        .read(cx)
                        .selected_source_range()
                        .expect("real drag selection");
                    (text, range, transcript.read(cx).history_probe_anchor(cx))
                })
                .unwrap();
            cx.update_window(h, |_, w, cx| w.press("secondary-alt-m", cx))
                .unwrap();
            until(cx, h, &view, |v, cx| {
                v.mission_context.read(cx).detail.is_some() && !v.mission_context.read(cx).busy
            });
            // A real current-generation streaming publication, not old pixels.
            let mut live_rows = rows.clone();
            live_rows.push(Message::live(
                900,
                "assistant".into(),
                "Synthetic live continuation while mission context is open.".into(),
            ));
            cx.update_window(h, |_, w, cx| {
                view.update(cx, |v, cx| {
                    let mut next = v.state.clone();
                    next.rows = live_rows.clone();
                    next.page_revision += 1;
                    let mut chats = (*next.chats).clone();
                    chats[0].busy = true;
                    chats[0].state = "working".into();
                    next.chats = Arc::new(chats);
                    v.accept(next, w, cx);
                })
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert_eq!(cx.theme().is_dark(), mode == ThemeMode::Dark);
                let root = w.find("desktop-root").bounds();
                let pane = w.find("mission-context-region").bounds();
                let conversation = w.find("mission-context-conversation").bounds();
                let viewport = w.find("viewport").bounds();
                assert_eq!(root.size, size(px(width), px(height)));
                assert!(
                    root.contains(&pane.origin)
                        && pane.right() <= root.right()
                        && pane.bottom() <= root.bottom()
                );
                assert!(
                    viewport.size.height > px(100.),
                    "useful mounted transcript viewport {viewport:?}"
                );
                if width >= 1000. {
                    assert!((280. ..=320.).contains(&f32::from(pane.size.width)));
                    assert!(conversation.size.width >= px(420.));
                    assert!(conversation.right() <= pane.left());
                } else {
                    assert!(conversation.bottom() <= pane.top());
                    assert!(pane.size.height <= px(height / 3.));
                }
                assert_eq!(
                    selected.read(cx).selected_source_range(),
                    Some(range.clone())
                );
                assert_eq!(view.read(cx).editor, editor);
                assert_eq!(view.read(cx).transcript, transcript);
                assert_eq!(
                    editor.read(cx).shell_probe().0.read(cx).value().as_ref(),
                    text
                );
                assert_eq!(transcript.read(cx).history_probe_anchor(cx).0, anchor.0);
                assert!((transcript.read(cx).history_probe_anchor(cx).1 - anchor.1).abs() < 1.);
                assert_eq!(w.find("local-stop").disabled() == Some(true), pending);
                if pending {
                    assert!(editor.read(cx).shell_probe().2.unwrap().pending.is_some());
                }
            })
            .unwrap();
            assert!(
                commands.try_recv().is_err(),
                "inspector does not open or reload a chat"
            );
            assert!(server.all_gets());
            capture(
                cx,
                h,
                &dir,
                format!(
                    "{}x{}-{}-overview.png",
                    width as u32, height as u32, case_name
                ),
            );
            let reads = server.state.lock().unwrap().seen.len();
            settle(cx, h);
            assert_eq!(
                reads,
                server.state.lock().unwrap().seen.len(),
                "no idle polling"
            );
            // Refresh is explicit and keeps usable content on an actual HTTP refusal.
            server.reply("/api/mission-catalog", Reply::json(503, json!({})));
            cx.update_window(h, |_, w, cx| w.click("mission-context-refresh", cx))
                .unwrap();
            until(cx, h, &view, |v, cx| {
                v.mission_context.read(cx).error.is_some() && !v.mission_context.read(cx).busy
            });
            cx.update(|cx| assert!(view.read(cx).mission_context.read(cx).detail.is_some()));
            capture(
                cx,
                h,
                &dir,
                format!("{}x{}-{}-stale.png", width as u32, height as u32, case_name),
            );
            server.reply("/api/mission-catalog", Reply::json(200, f::catalog()));
            cx.update_window(h, |_, w, cx| w.click("mission-context-refresh", cx))
                .unwrap();
            until(cx, h, &view, |v, cx| {
                v.mission_context.read(cx).error.is_none() && !v.mission_context.read(cx).busy
            });
            let member_checks = width == 1100. && mode == ThemeMode::Light && !pending;
            if member_checks {
                cx.update_window(h, |_, w, cx| w.click("mission-context-tasks", cx))
                    .unwrap();
                settle(cx, h);
                cx.update_window(h, |_, w, cx| w.click("mission-context-members", cx))
                    .unwrap();
                settle(cx, h);
                cx.update_window(h, |_, w, cx| {
                    assert_eq!(
                        w.find("mission-context-chat-not-loaded").disabled(),
                        Some(true)
                    );
                    for id in ["mission-context-chat-chat-A", "mission-context-chat-chat-B", "mission-context-chat-not-loaded"] {
                        let row = w.find(id).bounds();
                        let title = w.within(id).find("resource-title").bounds();
                        let detail = w.within(id).find("resource-detail").bounds();
                        assert!(title.left() >= row.left() && title.right() <= row.right());
                        assert!(title.top() >= row.top() && title.bottom() <= detail.top());
                        assert!(detail.bottom() <= row.bottom(), "both ResourceLabel lines must fit their actual member button: {row:?} / {detail:?}");
                    }
                    let input = editor.read(cx).shell_probe().0;
                    input.update(cx, |i, cx| {
                        i.focus(w, cx);
                        i.replace_and_mark_text_in_range(None, "ガ", Some(1..1), w, cx);
                    });
                })
                .unwrap();
                settle(cx, h);
                cx.update_window(h, |_, w, cx| {
                    let input = editor.read(cx).shell_probe().0;
                    let marked = input
                        .update(cx, |i, cx| i.marked_text_range(w, cx))
                        .unwrap();
                    w.click("mission-context-chat-chat-B", cx);
                    assert_eq!(view.read(cx).selected.as_deref(), Some("chat-A"));
                    assert!(commands.try_recv().is_err());
                    assert_eq!(
                        input.update(cx, |i, cx| i.marked_text_range(w, cx)),
                        Some(marked.clone()),
                        "pane mouse-down cannot blur/commit preedit before navigation guard"
                    );
                    input.update(cx, |i, cx| i.replace_text_in_range(Some(marked), "", w, cx));
                    assert_eq!(input.read(cx).value().as_ref(), text);
                })
                .unwrap();
                until(cx, h, &view, |v, cx| v.editor.read(cx).saved_probe(cx));
                capture(cx, h, &dir, "1100x840-light-disclosures.png".into());
                // The actual global toggle must not retire its focused key scope
                // without returning to a mounted original conversation input.
                cx.update_window(h, |_, w, cx| {
                    let focus = view.read(cx).mission_context.read(cx).focus.clone();
                    focus.focus(w, cx);
                })
                .unwrap();
                settle(cx, h);
                cx.update_window(h, |_, w, cx| {
                    assert!(view.read(cx).mission_context.read(cx).focus.is_focused(w));
                    w.press("secondary-alt-m", cx);
                })
                .unwrap();
                settle(cx, h);
                cx.update_window(h, |_, w, cx| {
                    assert!(!view.read(cx).mission_context.read(cx).visible);
                    assert!(w.try_find("mission-context-pane").is_none());
                    assert_eq!(view.read(cx).editor, editor);
                    assert_eq!(view.read(cx).transcript, transcript);
                    let input = editor.read(cx).shell_probe().0;
                    assert!(
                        input.read(cx).focus_handle(cx).is_focused(w),
                        "shortcut close must restore original mounted composer focus"
                    );
                    w.input(" shortcut focus 🧪", cx);
                    assert_eq!(
                        input.read(cx).value().as_ref(),
                        format!("{text} shortcut focus 🧪")
                    );
                    let len = input.read(cx).value().encode_utf16().count();
                    input.update(cx, |i, cx| {
                        i.replace_text_in_range(Some(0..len), &text, w, cx)
                    });
                    assert_eq!(input.read(cx).value().as_ref(), text);
                    assert_eq!(transcript.read(cx).history_probe_anchor(cx).0, anchor.0);
                })
                .unwrap();
                until(cx, h, &view, |v, cx| v.editor.read(cx).saved_probe(cx));
                cx.update_window(h, |_, w, cx| w.press("secondary-alt-m", cx))
                    .unwrap();
                until(cx, h, &view, |v, cx| {
                    v.mission_context.read(cx).detail.is_some() && !v.mission_context.read(cx).busy
                });
            }
            // Actual background-lane exit is not an apparently successful read.
            cx.update(|cx| view.read(cx).mission_context.read(cx).disconnect_probe());
            until(cx, h, &view, |v, cx| {
                v.mission_context
                    .read(cx)
                    .error
                    .is_some_and(|e| e.contains("Couldn't load the mission"))
            });
            let reads = server.state.lock().unwrap().seen.len();
            settle(cx, h);
            assert_eq!(reads, server.state.lock().unwrap().seen.len());
            cx.update_window(h, |_, w, cx| {
                let focus = view.read(cx).mission_context.read(cx).focus.clone();
                focus.focus(w, cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(view.read(cx).mission_context.read(cx).focus.is_focused(w));
                assert!(!editor.update(cx, |e, cx| e.marked(w, cx)));
                w.press(if pending { "secondary-alt-m" } else { "escape" }, cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update(|cx| {
                assert!(!view.read(cx).mission_context.read(cx).visible);
            });
            if pending {
                cx.update_window(h, |_, w, cx| {
                    let v = view.read(cx);
                    assert!(!v.mission_context.read(cx).focus.contains_focused(w, cx));
                    assert!(
                        v.chats.read(cx).focus_handle(cx).contains_focused(w, cx)
                            || editor
                                .read(cx)
                                .shell_probe()
                                .0
                                .read(cx)
                                .focus_handle(cx)
                                .is_focused(w),
                        "pending close must retain a mounted navigation or editor scope"
                    );
                    assert!(editor.read(cx).shell_probe().2.unwrap().pending.is_some());
                })
                .unwrap();
            }
            // Both pointer and keyboard entrypoints open the retained conversation.
            cx.update_window(h, |_, w, cx| w.click("mission-context-toggle", cx))
                .unwrap();
            until(cx, h, &view, |v, cx| {
                v.mission_context.read(cx).detail.is_some() && !v.mission_context.read(cx).busy
            });
            cx.update_window(h, |_, w, cx| {
                view.update(cx, |v, cx| {
                    let mut s = v.state.clone();
                    s.rows = live_rows.clone();
                    s.status = "Local disconnected".into();
                    v.accept(s, w, cx);
                    assert!(v.mission_context.read(cx).detail.is_some());
                    assert!(!v.mission_context.read(cx).busy);
                });
            })
            .unwrap();
            let reads = server.state.lock().unwrap().seen.len();
            settle(cx, h);
            assert_eq!(reads, server.state.lock().unwrap().seen.len());
            cx.update_window(h,|_,w,cx|{
                view.update(cx,|v,cx|{
                    let mut s=v.state.clone();s.rows=live_rows.clone();s.status="Synthetic Local fixture".into();Metadata::accept(&mut s.mission_metadata,&json!({"type":"session","session":{"id":"chat-A","projectId":"project-A","missionId":"mission-B"}}));
                    v.accept(s,w,cx);assert!(v.mission_context.read(cx).detail.is_none());
                    assert_eq!(v.selected.as_deref(),Some("chat-A"));assert_eq!(v.generation,1);assert_eq!(v.editor,editor);assert_eq!(v.transcript,transcript);
                    assert_eq!(editor.read(cx).shell_probe().0.read(cx).value().as_ref(),text);
                    v.mission_context.update(cx,|p,cx|p.hide(cx));
                });
            }).unwrap();
            assert!(commands.try_recv().is_err());
            assert!(server.all_gets());
            if member_checks {
                // Only this explicit member choice may issue the ordinary Open.
                cx.update_window(h, |_, w, cx| view.update(cx, |v, cx| {
                    let mut s = v.state.clone(); s.rows = live_rows.clone();
                    Metadata::accept(&mut s.mission_metadata, &json!({"type":"session","session":{"id":"chat-A","projectId":"project-A","missionId":"mission-A"}}));
                    v.accept(s, w, cx);
                })).unwrap();
                cx.update_window(h, |_, w, cx| w.click("mission-context-toggle", cx))
                    .unwrap();
                until(cx, h, &view, |v, cx| {
                    v.mission_context.read(cx).detail.is_some() && !v.mission_context.read(cx).busy
                });
                cx.update_window(h, |_, w, cx| w.click("mission-context-members", cx))
                    .unwrap();
                settle(cx, h);
                cx.update_window(h, |_, w, cx| w.click("mission-context-chat-chat-B", cx))
                    .unwrap();
                settle(cx, h);
                assert!(
                    matches!(commands.try_recv().unwrap(), Command::Open { id, generation: 2 } if id == "chat-B")
                );
                assert!(commands.try_recv().is_err());
                cx.update(|cx| {
                    let v = view.read(cx);
                    assert_eq!(v.selected.as_deref(), Some("chat-B"));
                    assert_eq!(v.editor, editor);
                    assert_eq!(v.transcript, transcript);
                    assert!(v.mission_context.read(cx).detail.is_none());
                    assert!(!v.mission_context.read(cx).busy);
                });
            }
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
            assert_eq!(store.book.drafts["chat:chat-A"].text, text);
            assert_eq!(
                serde_json::to_vec(&store.book.pending).unwrap(),
                pending_before,
                "every immutable operation field survives open/refresh/error/offline/close/flush"
            );
            drop(store);
            std::fs::remove_dir_all(root).unwrap();
            println!(
                "{}",
                json!({"width":width,"height":height,"mode":mode.name(),"active_pending":pending,"immutable_envelope":true,"mission_context":true,"same_conversation_entities":true,"native_selection_and_draft":true,"marked_input_fenced":!pending,"streaming_anchor_and_stop_availability":true,"no_implicit_chat_open":true,"member_pointer_preedit_and_explicit_navigation":member_checks,"stale_error_retained":true,"reader_exit_explicit_retry":true,"offline_no_poll":true,"metadata_retarget_cancels":true,"private_flush":true})
            );
        }
    }
    assert_eq!(
        ran,
        if selected_case.is_some() { 2 } else { 7 },
        "must execute the explicit selected native case set"
    );
}
