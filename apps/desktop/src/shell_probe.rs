//! Actual headless production view with faux reader/writer channels and public summaries.
//! Never connects, creates, sends, stops, approves or reads private state.
use super::*;
use gpui_kit::{
    Bounds, EntityInputHandler, HeadlessAppContext, ScrollDelta, WindowBounds, WindowOptions,
    component::{ActiveTheme, Theme, ThemeMode},
    point, size,
    test::TestWindowExt,
};
use serde_json::json;

fn settle(cx: &mut HeadlessAppContext, handle: gpui_kit::AnyWindowHandle) {
    for _ in 0..32 {
        cx.advance_clock(Duration::from_millis(16));
        cx.run_until_parked();
        cx.update_window(handle, |_, w, cx| w.render_frame(cx))
            .unwrap();
    }
}
pub fn run_shell_probe(cx: &mut HeadlessAppContext) {
    if std::env::var_os("PILOT_NEXT_PROJECT_ROWS_DIR").is_some() {
        run_project_rows_probe(cx);
        return;
    }
    if std::env::var_os("PILOT_NEXT_HOME_CONTEXT_DIR").is_some() {
        run_home_context_probe(cx);
        return;
    }
    let captures = std::env::var_os("PILOT_NEXT_SHELL_DIR").map(std::path::PathBuf::from);
    if let Some(dir) = &captures {
        std::fs::create_dir_all(dir).unwrap();
    }
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
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
            let (client, reads) = LocalClient::synthetic_commands();
            let (writer, writes) = Interaction::recording();
            let initial:Vec<_>=(100..120).map(|id|Message::live(id,"assistant".into(),format!("Synthetic message {id}: retain this 👩‍💻 e\u{301} selection while browsing projects.\n\n{}","A calm synthetic paragraph. ".repeat(16)))).collect();
            let projects = crate::local_model::projects(&json!([
                {"id":"project-a","name":"Synthetic Atlas","path":"/synthetic/shared-name"},
                {"id":"project-b","name":"Synthetic Boreal","path":"/synthetic/shared-name"}
            ]))
            .unwrap();
            let chats=Arc::new(vec![
            crate::local_model::chat(&json!({"id":"synthetic","title":"Synthetic active chat","cwd":"/synthetic/shared-name","projectId":"project-a","state":"working"})).unwrap(),
            crate::local_model::chat(&json!({"id":"other","title":"Synthetic other chat","cwd":"/synthetic/shared-name","projectId":"project-b","state":"idle"})).unwrap(),
            crate::local_model::chat(&json!({"id":"unassigned","title":"Synthetic unassigned","cwd":"/synthetic/shared-name","state":"idle"})).unwrap(),
            crate::local_model::chat(&json!({"id":"archived","title":"Synthetic archived","projectId":"project-a","archivedAt":1,"state":"idle"})).unwrap(),
        ]);
            let (handle, view) = cx.update(|cx| {
                gpui_kit::open_window(
                    WindowOptions {
                        window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                            Default::default(),
                            size(px(width), px(760.)),
                        ))),
                        show: false,
                        focus: false,
                        ..Default::default()
                    },
                    cx,
                    |window, cx| {
                        cx.new(|cx| {
                            let mut view =
                                LocalViewer::preview(PreviewState::Conversation, window, cx);
                            view.client = Some(client);
                            view.writer = Some(writer.clone());
                            view.state.projects = Arc::new(projects);
                            view.state.projects_loaded = true;
                            view.state.chats = chats;
                            view.editor
                                .update(cx, |v, cx| v.shell_probe_setup(writer, window, cx));
                            view.transcript
                                .update(cx, |v, cx| v.replace_readonly(initial.clone(), true, cx));
                            view.rebuild_nav(window, cx);
                            view
                        })
                    },
                )
                .unwrap()
            });
            settle(cx, handle);
            cx.update_window(handle, |_, w, cx| {
                assert_eq!(cx.theme().is_dark(), mode == ThemeMode::Dark);
                assert!(
                    w.try_find("nav-back").is_none() && w.try_find("nav-forward").is_none(),
                    "no empty navigation history chrome"
                );
                assert!(
                    w.try_find("archives").is_none()
                        && w.try_find("earlier").is_none()
                        && w.try_find("latest").is_none(),
                    "secondary history/filter actions are contextual"
                );
                assert!(w.try_find("chat-filters").is_some());
            })
            .unwrap();
            assert!(reads.try_recv().is_err());
            assert!(writes.try_recv().is_err());
            for _ in 0..20 {
                cx.update_window(handle, |_, window, cx| {
                    window.scroll(
                        "viewport",
                        ScrollDelta::Pixels(point(px(0.), px(100_000.))),
                        cx,
                    )
                })
                .unwrap();
                settle(cx, handle);
                if cx
                    .update_window(handle, |_, window, _| {
                        window.try_find(("copy-source", 100u64)).is_some()
                    })
                    .unwrap()
                {
                    break;
                }
            }
            let (selected_text, selected_range, anchor_y, anchor_before) = cx
                .update_window(handle, |_, window, cx| {
                    let t = view.read(cx).transcript.read(cx).history_probe_row(100);
                    let b = t.read(cx).bounds();
                    window.drag(
                        b.origin + point(px(2.), px(8.)),
                        b.origin + point(px(180.), px(8.)),
                        cx,
                    );
                    let range = t
                        .read(cx)
                        .selected_source_range()
                        .expect("native drag selects real text");
                    (
                        t,
                        range,
                        f32::from(b.top()),
                        view.read(cx).transcript.read(cx).history_probe_anchor(cx),
                    )
                })
                .unwrap();
            // A live editor change and immediate navigation, before deferred Change, must capture now.
            cx.update_window(handle, |_, window, cx| {
                let text = view.read(cx).editor.read(cx).shell_probe().0;
                text.update(cx, |v, cx| {
                    v.set_value("Private synthetic draft 👩‍💻 e\u{301}", window, cx)
                });
                view.update(cx, |v, cx| v.show_home(window, cx));
                assert_eq!(
                    view.read(cx).editor.read(cx).shell_probe().2.unwrap().text,
                    "Private synthetic draft 👩‍💻 e\u{301}"
                );
            })
            .unwrap();
            settle(cx, handle);
            cx.update_window(handle, |_, window, cx| {
                window.render_frame(cx);
                let main = window.find("overview").bounds();
                let sidebar = window.find("chat-sidebar").bounds();
                assert!(main.left() >= sidebar.right() && f32::from(main.size.width) > 350.);
                assert_eq!(view.read(cx).page, Page::Home);
                // Three chats under their three project labels.
                assert_eq!(view.read(cx).chats.read(cx).delegate().tree.rows.len(), 3 + 3);
                assert!(window.try_find("home-project-project-a").is_some());
                assert!(window.try_find("home-project-project-b").is_some());
                let button = window.find("home-project-project-a").bounds();
                let label = window
                    .within("home-project-project-a")
                    .find("resource-title")
                    .bounds();
                let icon = window
                    .within("home-project-project-a")
                    .find("resource-icon")
                    .bounds();
                assert!(
                    label.left() >= button.left()
                        && label.right() <= button.right()
                        && label.right() <= main.right()
                );
                assert!(
                    icon.left() >= button.left()
                        && f32::from(icon.left() - button.left()) < 12.
                        && icon.size.width == window.rem_size()
                        && (label.left() - icon.right() - px(crate::appearance::Space::CONTROL))
                            .abs()
                            < px(0.1),
                    "project icon must lead at the original inset with the exact shared Control gap"
                );
                window.click("home-project-project-a", cx);
            })
            .unwrap();
            settle(cx, handle);
            cx.update_window(handle, |_, _, cx| {
                assert_eq!(view.read(cx).page, Page::Project("project-a".into()));
                let v = view.read(cx);
                let d = v.chats.read(cx).delegate();
                assert_eq!(d.tree.rows.len(), 1);
                assert_eq!(d.at(d.first().unwrap()).unwrap().id, "synthetic");
                assert!(
                    Arc::ptr_eq(&d.all, &v.state.chats),
                    "scope changes must share, not deep-clone, the loaded chat metadata"
                );
            })
            .unwrap();
            super::contextual_navigation::probe_menu_choice(
                cx,
                handle,
                "chat-filters",
                0,
                mode == ThemeMode::Dark,
            );
            settle(cx, handle);
            cx.update_window(handle, |_, window, cx| {
                let chats = view.read(cx).chats.clone();
                chats.update(cx, |l, cx| l.set_query("other", window, cx))
            })
            .unwrap();
            settle(cx, handle);
            cx.update(|cx| {
                assert!(
                    view.read(cx).chats.read(cx).delegate().tree.rows.is_empty(),
                    "search must stay within project scope"
                )
            });
            cx.update_window(handle, |_, window, cx| {
                let chats = view.read(cx).chats.clone();
                chats.update(cx, |l, cx| l.set_query("", window, cx))
            })
            .unwrap();
            settle(cx, handle);
            cx.update_window(handle, |_, _, cx| {
                assert_eq!(view.read(cx).chats.read(cx).delegate().tree.rows.len(), 2);
            })
            .unwrap();
            super::contextual_navigation::probe_menu_choice(
                cx,
                handle,
                "chat-filters",
                0,
                mode == ThemeMode::Dark,
            );
            cx.update_window(handle, |_, w, cx| w.click("nav-home", cx))
                .unwrap();
            settle(cx, handle);
            if let Some(dir) = &captures {
                cx.capture_screenshot(handle)
                    .unwrap()
                    .save(dir.join(format!("{}-{}-home.png", width as u32, mode.name())))
                    .unwrap();
            }
            cx.update_window(handle, |_, w, cx| w.click("project-scope", cx))
                .unwrap();
            settle(cx, handle);
            cx.update_window(handle, |_, window, cx| {
                window.click("project-project-b", cx)
            })
            .unwrap();
            settle(cx, handle);
            cx.update_window(handle, |_, window, cx| {
                assert_eq!(view.read(cx).page, Page::Project("project-b".into()));
                assert_eq!(view.read(cx).chats.read(cx).delegate().tree.rows.len(), 1);
                let d = view.read(cx).chats.read(cx).delegate();
                assert_eq!(d.at(d.first().unwrap()).unwrap().id, "other");
                window.click("nav-home", cx);
            })
            .unwrap();
            settle(cx, handle);
            // Coalesce many hidden canonical updates without mounting/parsing transcript rows.
            let render_count =
                cx.update(|cx| view.read(cx).transcript.read(cx).probe_render_count());
            for n in 0..32 {
                cx.update_window(handle, |_, window, cx| {
                    view.update(cx, |v, cx| {
                        let mut state = v.state.clone();
                        state.rows = initial.clone();
                        state.rows.push(Message::live(
                            999,
                            "assistant".into(),
                            format!(
                                "Latest hidden publication {n}. {}",
                                "Synthetic source. ".repeat(512)
                            ),
                        ));
                        v.accept(state, window, cx);
                    })
                })
                .unwrap();
                cx.run_until_parked();
                cx.update_window(handle, |_, window, cx| {
                    window.draw(cx).clear(cx);
                })
                .unwrap();
            }
            cx.update(|cx| {
                let v = view.read(cx);
                assert_eq!(v.transcript.read(cx).probe_render_count(), render_count);
                let pending = &v.pending_transcript.as_ref().unwrap().0;
                assert_eq!(pending.len(), initial.len() + 1);
                assert!(
                    pending
                        .last()
                        .unwrap()
                        .source()
                        .starts_with("Latest hidden publication 31.")
                );
            });
            // Removing a selected project must not silently broaden to All or borrow the other cwd.
            cx.update_window(handle, |_, window, cx| {
                window.click("home-project-project-a", cx);
            })
            .unwrap();
            settle(cx, handle);
            cx.update_window(handle, |_, window, cx| {
                view.update(cx, |v, cx| {
                    let mut state = v.state.clone();
                    state.projects = Arc::new(vec![state.projects[1].clone()]);
                    // Worker publications are complete canonical projections. The
                    // UI intentionally drains state.rows, so do not clone that
                    // empty UI buffer as a fake canonical history replacement.
                    state.rows = v.pending_transcript.as_ref().unwrap().0.clone();
                    v.accept(state, window, cx);
                })
            })
            .unwrap();
            settle(cx, handle);
            cx.update_window(handle, |_, window, cx| {
                assert_eq!(view.read(cx).page, Page::Project("project-a".into()));
                assert_eq!(view.read(cx).project_scope.as_deref(), Some("project-a"));
                assert_eq!(view.read(cx).chats.read(cx).delegate().tree.rows.len(), 1);
                window.click("nav-all-chats", cx);
            })
            .unwrap();
            settle(cx, handle);
            cx.update_window(handle, |_, window, cx| {
                assert_eq!(view.read(cx).page, Page::Chat);
                assert!(view.read(cx).pending_transcript.is_none());
                assert!(window.try_find(("copy-source",100u64)).is_some(),"the read message must really be mounted after return");
                let retained = view.read(cx).transcript.read(cx).history_probe_row(100);
                assert_eq!(retained.entity_id(), selected_text.entity_id());
                // Native UI clicks/search intentionally dismiss a text selection,
                // as before this shell. Never resurrect a hidden stale selection.
                assert!(retained.read(cx).selected_source_range().is_none());
                assert!(
                    initial[0].source().is_char_boundary(selected_range.start)
                        && initial[0].source().is_char_boundary(selected_range.end)
                );
                assert!(
                    (f32::from(retained.read(cx).bounds().top()) - anchor_y).abs() <= 1.,
                    "Home/project round trip plus hidden append must retain read position: before_y={anchor_y}, after_y={}, before={anchor_before:?}, after={:?}",f32::from(retained.read(cx).bounds().top()),view.read(cx).transcript.read(cx).history_probe_anchor(cx)
                );
                let b = retained.read(cx).bounds();
                window.drag(
                    b.origin + point(px(2.), px(8.)),
                    b.origin + point(px(180.), px(8.)),
                    cx,
                );
                assert!(retained.read(cx).selected_source_range().is_some());
                let copied = gpui_kit::base::TextSelection::selected_text(window, cx);
                assert!(!copied.is_empty());
                let copied_range=retained.read(cx).selected_source_range().unwrap();
                window.press("secondary-c", cx);
                assert_eq!(cx.read_from_clipboard().unwrap().text().unwrap(), &initial[0].source()[copied_range]);
                assert_eq!(
                    view.read(cx)
                        .editor
                        .read(cx)
                        .shell_probe()
                        .0
                        .read(cx)
                        .value()
                        .as_ref(),
                    "Private synthetic draft 👩‍💻 e\u{301}"
                );
                window.press("secondary-l", cx);
                let text = view.read(cx).editor.read(cx).shell_probe().0;
                text.update(cx, |v, cx| {
                    v.replace_and_mark_text_in_range(None, "にほん", Some(3..3), window, cx)
                });
                view.update(cx, |v, cx| v.show_home(window, cx));
                assert_eq!(
                    view.read(cx).page,
                    Page::Chat,
                    "preedit must prevent hiding the composer"
                );
                text.update(cx, |v, cx| v.unmark_text(window, cx));
                view.update(cx, |v, cx| v.show_home(window, cx));
            })
            .unwrap();
            settle(cx, handle);
            // Real Home-chat click routes through the existing reader only, with exact ID/generation.
            cx.update_window(handle, |_, window, cx| window.click("home-chat-other", cx))
                .unwrap();
            settle(cx, handle);
            assert!(matches!(reads.try_recv(),Ok(Command::Open{id,..}) if id=="other"));
            assert!(reads.try_recv().is_err());
            assert!(
                writes.try_recv().is_err(),
                "navigation must not create/send/Stop or approve"
            );
            cx.update(|cx| assert_eq!(view.read(cx).selected.as_deref(), Some("other")));
            // Project-search preedit fences navigation; no hidden cwd input is used.
            cx.update_window(handle, |_, window, cx| {
                view.update(cx, |v, cx| v.new_chat(window, cx));
            })
            .unwrap();
            settle(cx, handle);
            assert!(matches!(reads.try_recv(), Ok(Command::Clear { .. })));
            cx.update_window(handle, |_, window, cx| {
                let editor = view.read(cx).editor.clone();
                let query = editor
                    .read(cx)
                    .project_query(cx)
                    .expect("new draft project picker");
                query.update(cx, |q, cx| {
                    q.replace_and_mark_text_in_range(None, "にほん", Some(3..3), window, cx)
                });
                view.update(cx, |v, cx| v.show_home(window, cx));
                assert_eq!(view.read(cx).page, Page::Chat);
                query.update(cx, |q, cx| q.unmark_text(window, cx));
                // Submitted and awaiting its creation receipt, so leaving keeps the slot.
                let key = editor.read(cx).navigation_key().unwrap().to_owned();
                let mut sent = editor.read(cx).shell_probe().2.unwrap();
                sent.pending = Some("synthetic-operation".into());
                let mut book = crate::delivery_store::Book::shell_probe();
                book.drafts.insert(key, sent);
                editor.update(cx, |e, cx| {
                    e.accept(
                        crate::interaction::WriteState {
                            book: Some(Arc::new(book)),
                            ..Default::default()
                        },
                        window,
                        cx,
                    )
                });
                view.update(cx, |v, cx| v.show_home(window, cx));
                let draft = editor.read(cx).shell_probe().2.unwrap();
                assert!(
                    draft.project_id.is_none(),
                    "no association is guessed from browsing scope or old cwd"
                );
            })
            .unwrap();
            settle(cx, handle);
            // A durable creation receipt arriving after navigation is retained, not adopted over Home.
            cx.update_window(handle, |_, window, cx| {
                let editor = view.read(cx).editor.clone();
                let draft = editor.read(cx).shell_probe().2.unwrap();
                let key = view
                    .read(cx)
                    .nav_drafts
                    .iter()
                    .find(|(key, _)| key.starts_with("new:"))
                    .unwrap()
                    .0
                    .clone();
                let mut book = crate::delivery_store::Book::shell_probe();
                let mut done = draft;
                done.pending = None;
                done.created = Some("synthetic-created".into());
                book.drafts.insert(key, done);
                editor.update(cx, |e, cx| {
                    e.accept(
                        crate::interaction::WriteState {
                            book: Some(Arc::new(book)),
                            ..Default::default()
                        },
                        window,
                        cx,
                    )
                });
            })
            .unwrap();
            settle(cx, handle);
            cx.update(|cx| {
                assert_eq!(view.read(cx).page, Page::Home);
                assert_eq!(
                    view.read(cx)
                        .editor
                        .read(cx)
                        .shell_probe()
                        .2
                        .unwrap()
                        .created
                        .as_deref(),
                    Some("synthetic-created")
                );
            });
            assert!(reads.try_recv().is_err());
            assert!(
                writes.try_recv().is_err(),
                "late creation receipt must not adopt/retire after newer shell navigation"
            );
            cx.update_window(handle, |_, window, cx| {
                view.update(cx, |v, cx| v.show_chats(window, cx));
                let editor = view.read(cx).editor.clone();
                let (text, _, draft) = editor.read(cx).shell_probe();
                let revision = draft.unwrap().revision;
                let key = view
                    .read(cx)
                    .nav_drafts
                    .iter()
                    .find(|(key, _)| key.starts_with("new:"))
                    .unwrap()
                    .0
                    .clone();
                text.update(cx, |t, cx| {
                    t.set_value(
                        "A newer synthetic draft before receipt adoption",
                        window,
                        cx,
                    )
                });
                editor.update(cx, |_, cx| {
                    cx.emit(EditorEvent::OpenCreated {
                        key,
                        revision,
                        target: "synthetic-created".into(),
                    })
                });
            })
            .unwrap();
            settle(cx, handle);
            cx.update(|cx| {
                let v = view.read(cx);
                assert!(v.selected.is_none());
                assert_eq!(
                    v.editor.read(cx).shell_probe().2.unwrap().text,
                    "A newer synthetic draft before receipt adoption"
                );
            });
            assert!(reads.try_recv().is_err());
            assert!(
                writes.try_recv().is_err(),
                "deferred creation receipt must not navigate/retire a newer input revision"
            );
            cx.update_window(handle, |_, window, cx| window.press("secondary-1", cx))
                .unwrap();
            settle(cx, handle);
            cx.update_window(handle,|_,window,cx|{
                assert_eq!(view.read(cx).page,Page::Home);
                for _ in 0..4{assert!(view.read(cx).client.as_ref().unwrap().command(Command::Reconnect));}
                let chat=view.read(cx).state.chats.iter().find(|c|c.id=="other").unwrap().clone();
                view.update(cx,|v,cx|v.open(chat,window,cx));
                assert_eq!(view.read(cx).page,Page::Home,"reader backpressure must not display the previous chat as the requested destination");
                assert!(view.read(cx).nav_error.is_some());assert!(view.read(cx).selected.is_none());
            }).unwrap();
            settle(cx, handle);
            for _ in 0..4 {
                assert!(matches!(reads.try_recv(), Ok(Command::Reconnect)));
            }
            assert!(reads.try_recv().is_err());
            cx.update_window(handle, |_, window, cx| window.press("secondary-2", cx))
                .unwrap();
            settle(cx, handle);
            cx.update(|cx| {
                assert_eq!(view.read(cx).page, Page::Chat);
                assert!(view.read(cx).nav_error.is_none());
            });
            if width == 1100. && mode == ThemeMode::Dark {
                let catalog=crate::local_model::projects(&json!((0..256).map(|ix|json!({"id":format!("p{ix:03}"),"name":format!("Project {ix:03} {}","name ".repeat(60)),"path":format!("/synthetic/{}","x".repeat(4085))})).collect::<Vec<_>>())).unwrap();
                let large=Arc::new((0..1000).map(|ix|crate::local_model::chat(&json!({"id":format!("c{ix:04}"),"title":format!("Chat {ix:04} {}","title ".repeat(60)),"projectId":format!("p{:03}",ix%256),"cwd":format!("/synthetic/{}","x".repeat(4085)),"state":"idle"})).unwrap()).collect::<Vec<_>>());
                let string_bytes = large
                    .iter()
                    .map(|c| {
                        c.title.len()
                            + c.cwd.len()
                            + c.id.len()
                            + c.state.len()
                            + c.project_id.as_ref().map_or(0, String::len)
                    })
                    .sum::<usize>();
                cx.update_window(handle, |_, window, cx| {
                    view.update(cx, |v, cx| {
                        let mut state = v.state.clone();
                        state.projects = Arc::new(catalog);
                        state.chats = large;
                        state.rows = Vec::new();
                        v.accept(state, window, cx);
                        v.show_home(window, cx);
                    })
                })
                .unwrap();
                settle(cx, handle);
                let shared = cx.update(|cx| view.read(cx).chats.read(cx).delegate().all.clone());
                for ix in 0..32 {
                    cx.update_window(handle, |_, window, cx| {
                        view.update(cx, |v, cx| v.show_project(format!("p{ix:03}"), window, cx))
                    })
                    .unwrap();
                    cx.update(|cx| {
                        assert!(Arc::ptr_eq(
                            &shared,
                            &view.read(cx).chats.read(cx).delegate().all
                        ))
                    });
                }
                settle(cx, handle);
                cx.update_window(handle, |_, window, cx| {
                    view.update(cx, |v, cx| v.show_home(window, cx))
                })
                .unwrap();
                settle(cx, handle);
                cx.update_window(handle, |_, window, cx| {
                    assert_eq!(view.read(cx).state.projects.len(), 256);
                    assert_eq!(view.read(cx).state.chats.len(), 1000);
                    assert_eq!(
                        view.read(cx).chats.read(cx).delegate().tree.rows.len(),
                        // Every chat plus one label per project section.
                        1001 + 256
                    );
                    let title = window
                        .within("home-project-p000")
                        .find("resource-title")
                        .bounds();
                    let b = window.find("home-project-p000").bounds();
                    assert!(title.left() >= b.left() && title.right() <= b.right());
                })
                .unwrap();
                assert!(reads.try_recv().is_err());
                assert!(writes.try_recv().is_err());
                println!(
                    "{}",
                    json!({"capacity_scene":true,"projects":256,"canonical_chats":1000,"private_drafts":1,"metadata_string_payload_bytes":string_bytes,"scope_changes_without_metadata_deep_clone":32,"ordinary_overview_max_rows":12,"project_previews_max_rows":8,"actual_native_long_label_containment":true,"timing_or_rss_claim":false})
                );
                if let Some(dir) = &captures {
                    cx.capture_screenshot(handle)
                        .unwrap()
                        .save(dir.join("capacity-home.png"))
                        .unwrap();
                }
            }
            println!(
                "{}",
                json!({"width":width,"mode":mode.name(),"home_projects_exact_scope":true,"same_cwd_not_membership":true,"archived_and_search_scope":true,"scope_shares_metadata":true,"draft_capture_unicode":true,"text_and_project_search_preedit_block_navigation":true,"late_receipt_and_newer_input_fenced":true,"removed_project_no_fallback":true,"text_entity_and_pixel_anchor_retained":true,"pointer_dismiss_and_reselect_copy":true,"home_all_chats_shortcuts":true,"reader_backpressure_keeps_destination_and_draft":true,"injected_faux_queue_controls":4,"hidden_publications_coalesced":32,"hidden_transcript_renders":0,"explicit_chat_open_read_commands":1,"clear_read_subscription":1,"write_commands":0,"native_offscreen_production_root":true})
            );
            cx.update_window(handle, |_, window, _| window.remove_window())
                .unwrap();
            cx.run_until_parked();
        }
    }
}

// Same frozen, public-summary fixture before/after. The selector above is only
// this bounded capture check, never a pass of the original full shell matrix.
fn run_home_context_probe(cx: &mut HeadlessAppContext) {
    let captures = std::env::var_os("PILOT_NEXT_HOME_CONTEXT_DIR").map(std::path::PathBuf::from);
    if let Some(dir) = &captures {
        std::fs::create_dir_all(dir).unwrap();
    }
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            cx.update(|cx| Theme::change(mode, None, cx));
            let projects = Arc::new(
                crate::local_model::projects(&json!([
                    {"id":"a","name":"Synthetic Atlas","path":"/synthetic/shared"},
                    {"id":"ab","name":"Synthetic Boreal","path":"/synthetic/shared"}
                ]))
                .unwrap(),
            );
            let chats=Arc::new([
                json!({"id":"busy-a","title":"Prepare the synthetic native resource bundle 日本語","state":"working","projectId":"a","cwd":"/synthetic/shared"}),
                json!({"id":"question-b","title":"Choose a canary region for the synthetic release and retained project resources 日本語","state":"idle","outcome":"question","projectId":"ab","cwd":"/synthetic/shared","attentionReason":{"kind":"asks","detail":"Which region should receive the canary? Keep this public reason attached to its exact project."}}),
                json!({"id":"unassigned","title":"Inspect synthetic unassigned notes","state":"idle","cwd":"/synthetic/shared"}),
                json!({"id":"missing","title":"Check synthetic missing-project result","state":"failed","projectId":"absent","cwd":"/synthetic/shared","attentionReason":{"kind":"failed","detail":"Synthetic verification failed; the unavailable project must not resolve by shared folder."}}),
            ].iter().map(|v|crate::local_model::chat(v).unwrap()).collect::<Vec<_>>());
            assert_ne!(chats[0].project_id, chats[1].project_id);
            assert_eq!(chats[0].cwd, chats[1].cwd);
            assert!(
                chats[1]
                    .attention
                    .as_ref()
                    .unwrap()
                    .label
                    .contains("canary")
            );
            let (h, v) = cx.update(|cx| {
                gpui_kit::open_window(
                    WindowOptions {
                        window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                            Default::default(),
                            size(px(width), px(1000.)),
                        ))),
                        show: false,
                        focus: false,
                        ..Default::default()
                    },
                    cx,
                    |w, cx| {
                        cx.new(|cx| {
                            let mut v = LocalViewer::synthetic(w, cx);
                            v.state.projects = projects.clone();
                            v.state.chats = chats.clone();
                            v.state.projects_loaded = true;
                            v.state.list_loaded = true;
                            v.rebuild_nav(w, cx);
                            v
                        })
                    },
                )
                .unwrap()
            });
            for phase in [
                "global",
                "focused",
                "global-again",
                "missing-catalog-entry",
                "loading",
                "empty",
            ] {
                cx.update_window(h, |_, w, cx| {
                    v.update(cx, |v, cx| match phase {
                        "focused" => v.show_project("a".into(), w, cx),
                        "missing-catalog-entry" => {
                            v.state.projects = Arc::new(vec![projects[0].clone()]);
                            v.rebuild_nav(w, cx);
                        }
                        "loading" | "empty" => {
                            v.state.chats = Arc::default();
                            v.state.projects = Arc::default();
                            v.state.projects_loaded = phase == "empty";
                            v.state.list_loaded = phase == "empty";
                            v.rebuild_nav(w, cx);
                        }
                        _ => v.show_home(w, cx),
                    })
                })
                .unwrap();
                settle(cx, h);
                cx.update_window(h,|_,w,cx| {
                    w.draw(cx).clear(cx);
                    let view=v.read(cx);
                    assert!(view.client.is_none() && view.writer.is_none(),"fixture cannot transport or persist");
                    assert_eq!(view.page,if phase=="focused"{Page::Project("a".into())}else{Page::Home});
                    if matches!(phase,"global"|"focused"|"global-again"|"missing-catalog-entry") {
                        let row=w.find("home-working-busy-a").bounds();
                        assert_eq!(row.size.height,px(crate::appearance::Space::ROW));
                        assert!(row.left()>=w.find("chat-sidebar").bounds().right() && row.right()<=px(width));
                    }
                    if phase=="focused" {
                        assert!(w.try_find("home-chat-question-b").is_none(),"exact project scope, not shared-folder inference");
                    }
                    println!("{}",json!({"fixture":"home-context-v1","width":width,"mode":mode.name(),"phase":phase,"production_root":true,"no_transport_or_writer":true}));
                }).unwrap();
                if let Some(dir) = &captures {
                    cx.capture_screenshot(h)
                        .unwrap()
                        .save(dir.join(format!("{}-{}-{phase}.png", width as u32, mode.name())))
                        .unwrap();
                }
            }
            cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
            cx.run_until_parked();
        }
    }
}

// One byte-identical synthetic fixture across project-row label adoption.
// The selector runs only this capture matrix, not the original full shell test.
fn run_project_rows_probe(cx: &mut HeadlessAppContext) {
    let captures =
        std::path::PathBuf::from(std::env::var_os("PILOT_NEXT_PROJECT_ROWS_DIR").unwrap());
    std::fs::create_dir_all(&captures).unwrap();
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            cx.update(|cx| Theme::change(mode, None, cx));
            let projects = Arc::new(crate::local_model::projects(&json!([
                {"id":"a","name":"Synthetic Atlas 日本語 👩‍💻 e\u{301} with a deliberately long project name to test narrow truncation and retained context","path":"/synthetic/shared"},
                {"id":"ab","name":"Synthetic Boreal 日本語 👩‍💻 e\u{301} with a deliberately long project name to test narrow truncation and retained context","path":"/synthetic/shared"}
            ])).unwrap());
            let chats = Arc::new([
                json!({"id":"work-ab","title":"Synthetic work","projectId":"ab","cwd":"/synthetic/shared","state":"working"}),
                json!({"id":"ask-ab","title":"Synthetic question","projectId":"ab","cwd":"/synthetic/shared","state":"idle","outcome":"question","attentionReason":{"kind":"asks","detail":"Choose a synthetic region"}}),
                json!({"id":"archived-a","title":"Synthetic archived","projectId":"a","cwd":"/synthetic/shared","state":"failed","archivedAt":1}),
            ].iter().map(|v| crate::local_model::chat(v).unwrap()).collect::<Vec<_>>());
            assert_eq!(projects[0].path, projects[1].path);
            let (h, v) = cx.update(|cx| {
                gpui_kit::open_window(
                    WindowOptions {
                        window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                            Default::default(),
                            size(px(width), px(1000.)),
                        ))),
                        show: false,
                        focus: false,
                        ..Default::default()
                    },
                    cx,
                    |w, cx| {
                        cx.new(|cx| {
                            let mut v = LocalViewer::synthetic(w, cx);
                            v.state.projects = projects.clone();
                            v.state.projects_loaded = true;
                            v.state.chats = Arc::default();
                            v.state.list_loaded = false;
                            v.rebuild_nav(w, cx);
                            v
                        })
                    },
                )
                .unwrap()
            });
            for phase in ["loading", "loaded", "refresh-failed", "empty"] {
                cx.update_window(h, |_, w, cx| {
                    v.update(cx, |v, cx| {
                        v.state.chats = if phase == "loading" || phase == "empty" {
                            Arc::default()
                        } else {
                            chats.clone()
                        };
                        v.state.projects = if phase == "empty" {
                            Arc::default()
                        } else {
                            projects.clone()
                        };
                        v.state.list_loaded = phase != "loading";
                        v.state.projects_error =
                            (phase == "refresh-failed").then_some("Couldn't refresh projects");
                        v.rebuild_nav(w, cx);
                        v.show_home(w, cx);
                    })
                })
                .unwrap();
                settle(cx, h);
                cx.update_window(h, |_,w,cx| {
                    w.draw(cx).clear(cx);
                    let view = v.read(cx);
                    assert!(view.client.is_none() && view.writer.is_none());
                    assert_eq!(view.page,Page::Home);
                    assert_eq!(view.state.projects.len(),if phase=="empty" {0} else {2});
                    if phase != "empty" {
                        for id in ["a", "ab"] {
                            let row_id = format!("home-project-{id}");
                            let row = w.find(row_id.clone()).bounds();
                            let shared = w.within(row_id.clone()).try_find("resource-title").is_some();
                            let title = if shared {
                                w.within(row_id.clone()).find("resource-title").bounds()
                            } else { w.find(format!("overview-project-title-{id}")).bounds() };
                            let icon = if shared {
                                w.within(row_id).find("resource-icon").bounds()
                            } else { w.find(format!("overview-project-icon-{id}")).bounds() };
                            let gap = if shared { px(crate::appearance::Space::CONTROL) } else { w.rem_size()*0.5 };
                            assert_eq!(row.size.height,px(crate::appearance::Space::ROW));
                            assert_eq!(icon.size,size(w.rem_size(),w.rem_size()));
                            assert!(icon.left()>=row.left() && icon.left()-row.left()<px(12.));
                            assert!((title.left()-icon.right()-gap).abs()<px(0.1));
                            assert!(title.right()<=row.right() && row.right()<=px(width));
                            assert!(row.left()>=w.find("chat-sidebar").bounds().right());
                            println!("{}",json!({"fixture":"project-rows-v1","width":width,"mode":mode.name(),"phase":phase,"project":id,"shared_resource_parts":shared,"no_transport_or_writer":true}));
                        }
                    }
                }).unwrap();
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(captures.join(format!("{}-{}-{phase}.png", width as u32, mode.name())))
                    .unwrap();
                if phase == "loaded" {
                    cx.update_window(h, |_, w, cx| w.click("home-project-ab", cx))
                        .unwrap();
                    settle(cx, h);
                    cx.update(|cx| {
                        let view = v.read(cx);
                        assert_eq!(view.page, Page::Project("ab".into()));
                        assert_eq!(view.project_scope.as_deref(), Some("ab"));
                        let list = view.chats.read(cx).delegate();
                        assert_eq!(
                            list.tree.rows.len(),
                            2,
                            "exact ID membership, not shared cwd or archived chats"
                        );
                        assert!(Arc::ptr_eq(&list.all, &view.state.chats));
                        assert!(view.client.is_none() && view.writer.is_none());
                    });
                }
            }
            cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
            cx.run_until_parked();
        }
    }
}
