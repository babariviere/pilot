//! Bounded window navigation against production views, never a live daemon or writer.
use super::*;
use crate::navigation::{Location, Target};
use gpui_kit::{
    Bounds, EntityInputHandler, HeadlessAppContext, ScrollDelta, WindowBounds, WindowOptions,
    component::{ActiveTheme, ThemeMode},
    point, size,
    test::TestWindowExt,
};
use serde_json::json;
fn rows(first: u64) -> Vec<Message> {
    (first..first + 20)
        .map(|id| {
            Message::live(
                id,
                "assistant".into(),
                format!(
                    "Synthetic read marker {id} 👩‍💻 e\u{301}.\n\n{}",
                    "Keep the bounded source and a stable reading position. ".repeat(10)
                ),
            )
            .anchored(crate::model::ReaderKey::model(id, 0, None))
        })
        .collect()
}
fn settle(cx: &mut HeadlessAppContext, h: gpui_kit::AnyWindowHandle) {
    for _ in 0..32 {
        cx.advance_clock(Duration::from_millis(16));
        cx.run_until_parked();
        cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
    }
}
fn publish(
    cx: &mut HeadlessAppContext,
    h: gpui_kit::AnyWindowHandle,
    v: &Entity<LocalViewer>,
    generation: u64,
    first: u64,
) {
    cx.update_window(h, |_, w, cx| {
        v.update(cx, |v, cx| {
            let mut s = v.state.clone();
            s.generation = generation;
            s.rows = rows(first);
            s.loaded = true;
            s.chat_status = "Synthetic loaded projection".into();
            s.cursor = Some(first);
            v.accept(s, w, cx);
        })
    })
    .unwrap();
    settle(cx, h);
}
pub fn run_navigation_probe(cx: &mut HeadlessAppContext) {
    if std::env::var_os("PILOT_NEXT_CANONICAL_READER_ONLY").is_some() {
        canonical_reader_navigation(cx);
        return;
    }
    let captures = std::env::var_os("PILOT_NEXT_NAVIGATION_DIR").map(std::path::PathBuf::from);
    if let Some(d) = &captures {
        std::fs::create_dir_all(d).unwrap();
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
            let catalog=crate::local_model::projects(&json!([{"id":"a","name":"Synthetic Atlas","path":"/synthetic/shared"},{"id":"b","name":"Synthetic Boreal","path":"/synthetic/shared"}])).unwrap();
            let mut chats=vec![crate::local_model::chat(&json!({"id":"synthetic","title":"Atlas conversation","projectId":"a","cwd":"/synthetic/shared","state":"idle"})).unwrap(),crate::local_model::chat(&json!({"id":"other","title":"Boreal conversation","projectId":"b","cwd":"/synthetic/shared","state":"idle"})).unwrap(),crate::local_model::chat(&json!({"id":"archived","title":"Atlas archived","projectId":"a","archivedAt":1,"state":"idle"})).unwrap()];
            for ix in 0..80 {
                chats.push(crate::local_model::chat(&json!({"id":format!("chat{ix}"),"title":format!("{} row {ix}",if ix%2==0{"Atlas"}else{"Boreal"}),"projectId":if ix%2==0{"a"}else{"b"},"state":"idle"})).unwrap());
            }
            let (h, v) = cx.update(|cx| {
                gpui_kit::open_window(
                    WindowOptions {
                        window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                            Default::default(),
                            size(px(width), px(600.)),
                        ))),
                        show: false,
                        focus: false,
                        ..Default::default()
                    },
                    cx,
                    |w, cx| {
                        cx.new(|cx| {
                            let mut v = LocalViewer::preview(PreviewState::Conversation, w, cx);
                            v.client = Some(client);
                            v.writer = Some(writer.clone());
                            v.editor
                                .update(cx, |e, cx| e.shell_probe_setup(writer, w, cx));
                            v.generation = 10;
                            v.state.generation = 10;
                            v.state.loaded = true;
                            v.state.projects = Arc::new(catalog);
                            v.state.projects_loaded = true;
                            v.state.chats = Arc::new(chats);
                            v.transcript.update(cx, |t, cx| {
                                t.history_scope(10);
                                t.replace_readonly(rows(100), true, cx);
                            });
                            v.rebuild_nav(w, cx);
                            v
                        })
                    },
                )
                .unwrap()
            });
            settle(cx, h);
            for _ in 0..24 {
                cx.update_window(h, |_, w, cx| {
                    w.scroll(
                        "viewport",
                        ScrollDelta::Pixels(point(px(0.), px(100_000.))),
                        cx,
                    )
                })
                .unwrap();
                settle(cx, h);
                if cx
                    .update_window(h, |_, w, _| w.try_find(("copy-source", 100u64)).is_some())
                    .unwrap()
                {
                    break;
                }
            }
            cx.update_window(h, |_, w, cx| {
                v.update(cx, |v, cx| {
                    v.state.cursor = Some(100);
                    v.show_project("a".into(), w, cx);
                    let chat = v.state.chats[0].clone();
                    assert!(v.open(chat, w, cx));
                })
            })
            .unwrap();
            settle(cx, h);
            let retained = cx.update(|cx| v.read(cx).transcript.read(cx).history_probe_row(100));
            cx.update_window(h, |_, w, cx| {
                let text = v.read(cx).editor.read(cx).shell_probe().0;
                text.update(cx, |t, cx| {
                    t.replace_and_mark_text_in_range(None, "にほん", Some(3..3), w, cx)
                });
                let old = v.read(cx).location(cx);
                for id in ["nav-back", "chat-filters", "history-menu", "latest"] {
                    w.click(id, cx);
                }
                assert!(
                    text.update(cx, |t, cx| t.marked_text_range(w, cx).is_some()),
                    "pointer chrome must not commit/discard composition"
                );
                assert!(w.try_find("popup-menu").is_none());
                assert_eq!(v.read(cx).location(cx), old);
                w.press("secondary-[", cx);
                assert_eq!(v.read(cx).location(cx), old);
                text.update(cx, |t, cx| {
                    t.unmark_text(w, cx);
                    t.set_value("Native draft 👩‍💻 e\u{301}", w, cx);
                });
                w.press("secondary-[", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert_eq!(v.read(cx).page, Page::Project("a".into()));
                w.press("secondary-]", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert_eq!(v.read(cx).page, Page::Chat);
                assert_eq!(
                    v.read(cx)
                        .transcript
                        .read(cx)
                        .history_probe_row(100)
                        .entity_id(),
                    retained.entity_id()
                );
                let list = v.read(cx).chats.clone();
                list.update(cx, |l, cx| l.set_query("Atlas", w, cx));
            })
            .unwrap();
            super::contextual_navigation::probe_menu_choice(
                cx,
                h,
                "chat-filters",
                0,
                mode == ThemeMode::Dark,
            );
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                w.scroll(
                    "chat-list-pane",
                    ScrollDelta::Pixels(point(px(0.), px(-220.))),
                    cx,
                )
            })
            .unwrap();
            settle(cx, h);
            let sidebar_y =
                cx.update(|cx| f32::from(v.read(cx).chats.read(cx).scroll_handle().offset().y));
            assert!(sidebar_y < -50.);
            cx.update_window(h, |_, w, cx| w.click("project-scope", cx))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                let query = v.read(cx).chats.read(cx).query_input();
                query.update(cx, |q, cx| q.set_value(" AtLaS ", w, cx));
                w.click("project-b", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert_eq!(v.read(cx).page, Page::Project("b".into()));
                assert!(!v.read(cx).chats.read(cx).delegate().archived);
                let list = v.read(cx).chats.clone();
                list.update(cx, |l, cx| l.set_query("Boreal", w, cx));
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                w.scroll("overview", ScrollDelta::Pixels(point(px(0.), px(-70.))), cx)
            })
            .unwrap();
            settle(cx, h);
            let overview_b_y = cx.update(|cx| v.read(cx).overview.read(cx).scroll_position());
            assert!(overview_b_y < -10.);
            cx.update_window(h, |_, w, cx| w.click("project-scope", cx))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| w.click("project-a", cx))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                let view = v.read(cx);
                assert_eq!(view.page, Page::Chat);
                assert_eq!(view.selected.as_deref(), Some("synthetic"));
                assert_eq!(view.state.cursor, Some(100));
                let l = view.chats.read(cx);
                assert!(l.delegate().archived);
                assert_eq!(l.query_input().read(cx).value().as_ref(), " AtLaS ");
                assert!((f32::from(l.scroll_handle().offset().y) - sidebar_y).abs() <= 1.);
                assert!(w.try_find(("copy-source", 100u64)).is_some());
                assert_eq!(
                    view.transcript.read(cx).history_probe_row(100).entity_id(),
                    retained.entity_id()
                );
                let q = l.query_input();
                q.update(cx, |q, cx| {
                    q.replace_and_mark_text_in_range(None, "にほん", Some(3..3), w, cx)
                });
                let old = v.read(cx).location(cx);
                w.press("secondary-[", cx);
                assert_eq!(v.read(cx).location(cx), old);
                q.update(cx, |q, cx| q.unmark_text(w, cx));
                let list = v.read(cx).chats.clone();
                list.update(cx, |l, cx| l.restore_query(" AtLaS ", w, cx));
            })
            .unwrap();
            settle(cx, h);
            assert!(
                reads.try_recv().is_err(),
                "same current owner/scope navigation must not reconnect or fetch history"
            );
            cx.update_window(h, |_, w, cx| w.click("project-scope", cx))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| w.click("project-b", cx))
                .unwrap();
            settle(cx, h);
            cx.update(|cx| {
                assert!((v.read(cx).overview.read(cx).scroll_position() - overview_b_y).abs() <= 1.)
            });
            cx.update_window(h, |_, _w, cx| {
                v.update(cx, |v, cx| {
                    v.overview.update(cx, |o, cx| o.restore_scroll(0., cx))
                })
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| w.click("home-chat-other", cx))
                .unwrap();
            settle(cx, h);
            assert!(matches!(reads.try_recv(),Ok(Command::Open{id,generation:11})if id=="other"));
            publish(cx, h, &v, 11, 300);
            cx.update_window(h, |_, w, cx| w.press("secondary-[", cx))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| w.press("secondary-[", cx))
                .unwrap();
            settle(cx, h);
            assert!(
                matches!(reads.try_recv(),Ok(Command::Open{id,generation:12})if id=="synthetic")
            );
            cx.update_window(h, |_, w, cx| {
                v.update(cx, |v, cx| {
                    let mut stale = v.state.clone();
                    stale.generation = 11;
                    stale.rows = rows(300);
                    v.accept(stale, w, cx);
                    assert!(v.pending_reader.is_some());
                })
            })
            .unwrap();
            publish(cx, h, &v, 12, 100);
            cx.update_window(h, |_, w, cx| {
                let index = v.read(cx).projects.read(cx).selected_index().unwrap();
                assert_eq!(
                    v.read(cx)
                        .projects
                        .read(cx)
                        .delegate()
                        .at(index)
                        .unwrap()
                        .id,
                    "a",
                    "project highlight must match the restored scope, not the prior click"
                );
                assert!(w.try_find(("copy-source", 100u64)).is_some());
                assert!(!v.read(cx).transcript.read(cx).history_probe_anchor(cx).2);
                assert!(v.read(cx).pending_reader.is_none());
            })
            .unwrap();
            assert!(
                reads.try_recv().is_err(),
                "restoring a loaded marker cannot manufacture Earlier requests"
            );
            assert!(writes.try_recv().is_err());
            if let Some(d) = &captures {
                cx.update(|cx| assert_eq!(cx.theme().is_dark(), mode == ThemeMode::Dark));
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(d.join(format!("{}-{}-restored.png", width as u32, mode.name())))
                    .unwrap();
            }
            // Forward admission is transactional when the reader queue is full.
            cx.update_window(h, |_, w, cx| w.press("secondary-]", cx))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                for _ in 0..4 {
                    assert!(
                        v.read(cx)
                            .client
                            .as_ref()
                            .unwrap()
                            .command(Command::Reconnect)
                    );
                }
                let before = v.read(cx).location(cx);
                w.press("secondary-]", cx);
                assert_eq!(v.read(cx).location(cx), before);
            })
            .unwrap();
            settle(cx, h);
            for _ in 0..4 {
                assert!(matches!(reads.try_recv(), Ok(Command::Reconnect)));
            }
            cx.update_window(h, |_, _, cx| {
                v.update(cx, |v, _| {
                    v.reader_marks.put(
                        "other".into(),
                        crate::navigation::ReadingMark {
                            message: Some(crate::model::ReaderKey::model(999_999, 0, None)),
                            offset: 0.,
                            following: false,
                        },
                    )
                })
            })
            .unwrap();
            cx.update_window(h, |_, w, cx| w.press("secondary-]", cx))
                .unwrap();
            settle(cx, h);
            assert!(matches!(reads.try_recv(),Ok(Command::Open{id,generation:13})if id=="other"));
            publish(cx, h, &v, 13, 300);
            cx.update_window(h, |_, w, cx| {
                assert!(
                    v.read(cx).nav_error.is_some(),
                    "an unloaded older marker needs an honest notice, not auto paging"
                );
                assert!(v.read(cx).pending_reader.is_none());
                assert!(reads.try_recv().is_err());
                w.click("latest", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update(|cx| {
                assert!(v.read(cx).nav_error.is_none());
                assert!(v.read(cx).transcript.read(cx).history_probe_anchor(cx).2);
            });
            cx.update_window(h, |_, w, cx| {
                w.press("secondary-[", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| w.click("nav-home", cx))
                .unwrap();
            settle(cx, h);
            cx.update(|cx| {
                assert!(
                    !v.read(cx).navigation.can_move(true),
                    "new navigation truncates only the local forward suffix"
                )
            });
            // A draft history entry reopens the same slot, not a new-chat action.
            cx.update_window(h, |_, w, cx| w.click("new-local-chat", cx))
                .unwrap();
            settle(cx, h);
            assert!(matches!(reads.try_recv(), Ok(Command::Clear { .. })));
            let draft_key = cx.update(|cx| {
                v.read(cx)
                    .editor
                    .read(cx)
                    .navigation_key()
                    .unwrap()
                    .to_owned()
            });
            cx.update_window(h, |_, w, cx| {
                let text = v.read(cx).editor.read(cx).shell_probe().0;
                text.update(cx, |t, cx| t.set_value("Keep this exact draft 👩‍💻", w, cx));
                w.click("nav-home", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| w.press("secondary-[", cx))
                .unwrap();
            settle(cx, h);
            assert!(matches!(reads.try_recv(), Ok(Command::Clear { .. })));
            cx.update(|cx| {
                let e = v.read(cx).editor.read(cx);
                assert_eq!(e.navigation_key(), Some(draft_key.as_str()));
                assert_eq!(e.shell_probe().2.unwrap().text, "Keep this exact draft 👩‍💻");
                assert_eq!(e.new_drafts().len(), 1);
            });
            assert!(reads.try_recv().is_err());
            assert!(
                writes.try_recv().is_err(),
                "history cannot create/send/Stop/approve"
            );
            cx.update_window(h, |_, w, cx| {
                v.update(cx, |v, cx| {
                    let scoped = Location {
                        scope: Some("a".into()),
                        target: Target::Chat("synthetic".into()),
                    };
                    assert!(v.can_restore(&scoped, cx));
                    let mut moved = v.state.chats.as_ref().clone();
                    moved[0].project_id = Some("b".into());
                    v.state.chats = Arc::new(moved);
                    assert!(
                        !v.can_restore(&scoped, cx),
                        "membership change cannot reinterpret a saved scoped chat"
                    );
                    v.focus_scope("a".into(), w, cx);
                    assert_eq!(
                        v.page,
                        Page::Project("a".into()),
                        "invalid last chat falls back to the same project's overview"
                    );
                    v.state.projects = Arc::new(vec![v.state.projects[1].clone()]);
                    assert!(!v.can_restore(
                        &Location {
                            scope: Some("a".into()),
                            target: Target::Project("a".into())
                        },
                        cx
                    ));
                    v.rebuild_nav(w, cx);
                })
            })
            .unwrap();
            settle(cx, h);
            assert!(reads.try_recv().is_err());
            assert!(writes.try_recv().is_err());
            println!(
                "{}",
                json!({"width":width,"mode":mode.name(),"bounded_navigation":true,"native_back_forward_keys":true,"scope_query_case_archive_scroll_and_last_chat":true,"textarea_and_search_preedit_fences":true,"same_owner_transcript_cursor_entity_retained":true,"cross_owner_reader_mark_generation_fenced":true,"no_restoration_history_fetch":true,"full_queue_cursor_transaction":true,"new_navigation_truncates_forward":true,"draft_slot_reused_no_submit":true,"canonical_write_commands":0,"native_offscreen":true})
            );
            cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
            cx.run_until_parked();
        }
    }
    sidebar_scrollbar_hidden(cx, captures.as_deref());
    canonical_reader_navigation(cx);
}

/// An overflowing sidebar paints no scrollbar in any Kit mode, while wheel
/// input scrolls it and keyboard selection keeps the selected row in view.
fn sidebar_scrollbar_hidden(cx: &mut HeadlessAppContext, captures: Option<&std::path::Path>) {
    use gpui_kit::component::{Theme, scroll::ScrollbarMode};
    let width = 1100.;
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
        let chats = (0..80)
            .map(|ix| {
                crate::local_model::chat(&json!({"id":format!("chat{ix}"),"title":format!("Sidebar row {ix}"),"projectId":"a","state":"idle"})).unwrap()
            })
            .collect::<Vec<_>>();
        let (h, v) = cx.update(|cx| {
            gpui_kit::open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                        Default::default(),
                        size(px(width), px(600.)),
                    ))),
                    show: false,
                    focus: false,
                    ..Default::default()
                },
                cx,
                |w, cx| {
                    cx.new(|cx| {
                        let mut v = LocalViewer::preview(PreviewState::Conversation, w, cx);
                        v.state.loaded = true;
                        v.state.chats = Arc::new(chats);
                        v.rebuild_nav(w, cx);
                        v
                    })
                },
            )
            .unwrap()
        });
        settle(cx, h);
        let offset = |cx: &mut HeadlessAppContext| {
            cx.update(|cx| f32::from(v.read(cx).chats.read(cx).scroll_handle().offset().y))
        };
        cx.update_window(h, |_, w, cx| {
            w.scroll(
                "chat-list-pane",
                ScrollDelta::Pixels(point(px(0.), px(-300.))),
                cx,
            )
        })
        .unwrap();
        settle(cx, h);
        let scrolled = offset(cx);
        assert!(scrolled < -100., "wheel input still scrolls the sidebar");
        let previous = cx.update(|cx| cx.theme().scrollbar_mode);
        let mut shots = Vec::new();
        for scrollbar in [
            ScrollbarMode::Hover,
            ScrollbarMode::Scrolling,
            ScrollbarMode::Always,
        ] {
            cx.update(|cx| Theme::set_scrollbar_mode(scrollbar, cx));
            if scrollbar == ScrollbarMode::Scrolling {
                // Fresh wheel input that returns to the same offset.
                for delta in [-40., 40.] {
                    cx.update_window(h, |_, w, cx| {
                        w.scroll(
                            "chat-list-pane",
                            ScrollDelta::Pixels(point(px(0.), px(delta))),
                            cx,
                        )
                    })
                    .unwrap();
                    settle(cx, h);
                }
                assert!((offset(cx) - scrolled).abs() <= 1.);
            }
            // Keep the pointer off the rows; Base fades use wall time.
            cx.update_window(h, |_, w, cx| w.hover("conversation", cx))
                .unwrap();
            settle(cx, h);
            std::thread::sleep(Duration::from_millis(
                if scrollbar == ScrollbarMode::Hover {
                    2400
                } else {
                    150
                },
            ));
            settle(cx, h);
            shots.push(cx.capture_screenshot(h).unwrap());
        }
        cx.update(|cx| Theme::set_scrollbar_mode(previous, cx));
        let pane = cx
            .update_window(h, |_, w, _| w.find("chat-list-pane").bounds())
            .unwrap();
        let scale = shots[0].width() as f32 / width;
        let (x0, x1) = (
            (f32::from(pane.left()) * scale) as u32,
            (f32::from(pane.right()) * scale) as u32,
        );
        let (y0, y1) = (
            (f32::from(pane.top()) * scale) as u32,
            (f32::from(pane.bottom()) * scale) as u32,
        );
        for (shot, name) in shots[1..].iter().zip(["scrolling", "always"]) {
            let changed = (y0..y1)
                .flat_map(|y| (x0..x1).map(move |x| (x, y)))
                .filter(|&(x, y)| shot.get_pixel(x, y) != shots[0].get_pixel(x, y))
                .count();
            assert_eq!(changed, 0, "{name} mode must not paint a sidebar scrollbar");
        }
        // Keyboard selection past the viewport scrolls the selected row into view.
        cx.update_window(h, |_, w, cx| {
            let list = v.read(cx).chats.clone();
            list.update(cx, |l, cx| l.focus(w, cx));
        })
        .unwrap();
        settle(cx, h);
        for _ in 0..60 {
            cx.update_window(h, |_, w, cx| w.press("down", cx)).unwrap();
        }
        settle(cx, h);
        cx.update_window(h, |_, w, cx| {
            let list = v.read(cx).chats.read(cx);
            let ix = list.selected_index().expect("keyboard selection");
            let id = list.delegate().at(ix).unwrap().id.clone();
            let row = w
                .find(SharedString::from(format!("chat-row-{id}")))
                .bounds();
            assert!(row.top() >= pane.top() - px(1.) && row.bottom() <= pane.bottom() + px(1.));
        })
        .unwrap();
        assert!(offset(cx) < scrolled, "selection scrolled further down");
        if let Some(d) = captures {
            shots[2]
                .save(d.join(format!("sidebar-scrollbar-always-{}.png", mode.name())))
                .unwrap();
        }
        println!(
            "{}",
            json!({"mode":mode.name(),"sidebar_scrollbar_hidden":["hover","scrolling","always"],"wheel_scrolls":true,"keyboard_selection_visible":true})
        );
        cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
        cx.run_until_parked();
    }
}

/// Actual reducer -> fresh Open, including allocation collision and missing key.
fn canonical_reader_navigation(cx: &mut HeadlessAppContext) {
    use crate::{local_model::LiveTranscript, model::ReaderKey};
    fn entry(id: u64, label: &str) -> serde_json::Value {
        // Exercise canonical reader identity, not ordinary-message folding.
        // Bounded headings stay unfolded but make a genuinely scrollable row.
        let text = format!(
            "{label}\n\n{}",
            "## A stable canonical reader position, not a render allocation.\n".repeat(12)
        );
        assert!(!crate::message_fold::preview(&text).long);
        json!({"id":id,"head":id,"kind":"pi.assistant","model":[{"role":"assistant","content":[{"type":"thinking","thinking":"hidden synthetic"},{"type":"text","text":text}]}]})
    }
    fn snapshot(values: Vec<serde_json::Value>) -> Vec<Message> {
        let mut r = LiveTranscript::default();
        r.apply(&json!({"type":"snapshot","entries":values}));
        r.rows()
    }
    fn publish(
        cx: &mut HeadlessAppContext,
        h: gpui_kit::AnyWindowHandle,
        v: &Entity<LocalViewer>,
        generation: u64,
        rows: Vec<Message>,
    ) {
        cx.update_window(h, |_, w, cx| {
            v.update(cx, |v, cx| {
                let mut s = v.state.clone();
                s.rows = rows;
                s.loaded = true;
                s.generation = generation;
                s.cursor = None;
                s.limited = false;
                s.chat_status = "Synthetic fresh reducer".into();
                v.accept(s, w, cx);
            })
        })
        .unwrap();
        settle(cx, h);
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
            let initial = snapshot(vec![entry(20, "OLD canonical entry20")]);
            let old_render = initial[0].id();
            let canonical = ReaderKey::model(20, 0, Some(1));
            let (h, v) = cx.update(|cx| {
                gpui_kit::open_window(
                    WindowOptions {
                        window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                            Default::default(),
                            size(px(width), px(600.)),
                        ))),
                        show: false,
                        focus: false,
                        ..Default::default()
                    },
                    cx,
                    |w, cx| {
                        cx.new(|cx| {
                            let mut v = LocalViewer::preview(PreviewState::Conversation, w, cx);
                            v.client = Some(client);
                            v.writer = Some(writer.clone());
                            v.editor
                                .update(cx, |e, cx| e.shell_probe_setup(writer, w, cx));
                            v.generation = 10;
                            v.state.generation = 10;
                            v.state.loaded = true;
                            v.state.cursor = None;
                            v.state.chats = Arc::new(
                                ["synthetic", "other"]
                                    .into_iter()
                                    .map(|id| {
                                        crate::local_model::chat(
                                            &json!({"id":id,"title":id,"state":"idle"}),
                                        )
                                        .unwrap()
                                    })
                                    .collect(),
                            );
                            v.transcript.update(cx, |t, cx| {
                                t.history_scope(10);
                                t.replace_readonly(initial, true, cx);
                            });
                            v.rebuild_nav(w, cx);
                            v
                        })
                    },
                )
                .unwrap()
            });
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                w.scroll(
                    "viewport",
                    ScrollDelta::Pixels(point(px(0.), px(100_000.))),
                    cx,
                )
            })
            .unwrap();
            settle(cx, h);
            let saved = cx.update(|cx| v.read(cx).transcript.read(cx).reading_mark(cx).unwrap());
            assert_eq!(saved.message, Some(canonical.clone()));
            assert!(!saved.following);
            cx.update_window(h, |_, w, cx| {
                v.update(cx, |v, cx| {
                    let other = v
                        .state
                        .chats
                        .iter()
                        .find(|c| c.id == "other")
                        .unwrap()
                        .clone();
                    assert!(v.open(other, w, cx));
                })
            })
            .unwrap();
            settle(cx, h);
            assert!(matches!(reads.try_recv(),Ok(Command::Open{id,generation:11}) if id=="other"));
            publish(cx, h, &v, 11, snapshot(vec![entry(90, "OTHER owner")]));
            cx.update_window(h, |_, w, cx| w.click("nav-back", cx))
                .unwrap();
            settle(cx, h);
            assert!(
                matches!(reads.try_recv(),Ok(Command::Open{id,generation:12}) if id=="synthetic")
            );
            let fresh = snapshot(vec![
                entry(20, "OLD canonical entry20"),
                entry(30, "NEW appended entry30"),
            ]);
            let correct = fresh
                .iter()
                .find(|m| m.matches_reader(&canonical))
                .unwrap()
                .id();
            assert_ne!(correct, old_render);
            assert_eq!(
                fresh
                    .iter()
                    .find(|m| m.source().starts_with("NEW"))
                    .unwrap()
                    .id(),
                old_render
            );
            publish(cx, h, &v, 12, fresh);
            cx.update_window(h, |_, w, cx| {
                let mark = v.read(cx).transcript.read(cx).reading_mark(cx).unwrap();
                assert_eq!(mark.message, saved.message);
                assert!(!mark.following);
                assert!((mark.offset - saved.offset).abs() <= 2.);
                assert!(v.read(cx).nav_error.is_none());
                assert!(w.try_find(("copy-source", correct)).is_some());
                w.click(("copy-source", correct), cx);
                assert!(
                    cx.read_from_clipboard()
                        .unwrap()
                        .text()
                        .unwrap()
                        .starts_with("OLD canonical entry20"),
                    "actual rendered old source, never the new colliding allocation"
                );
            })
            .unwrap();
            assert!(reads.try_recv().is_err());
            assert!(writes.try_recv().is_err());
            cx.update_window(h, |_, w, cx| {
                v.update(cx, |v, cx| {
                    let other = v
                        .state
                        .chats
                        .iter()
                        .find(|c| c.id == "other")
                        .unwrap()
                        .clone();
                    assert!(v.open(other, w, cx));
                })
            })
            .unwrap();
            settle(cx, h);
            assert!(matches!(
                reads.try_recv(),
                Ok(Command::Open { generation: 13, .. })
            ));
            publish(cx, h, &v, 13, snapshot(vec![entry(90, "OTHER owner")]));
            cx.update_window(h, |_, w, cx| w.click("nav-back", cx))
                .unwrap();
            settle(cx, h);
            assert!(matches!(
                reads.try_recv(),
                Ok(Command::Open { generation: 14, .. })
            ));
            let missing = snapshot(vec![entry(30, "NEW appended entry30")]);
            assert_eq!(missing[0].id(), old_render);
            publish(cx, h, &v, 14, missing);
            cx.update(|cx| {
                assert!(v.read(cx).nav_error.is_some());
                assert!(v.read(cx).pending_reader.is_none());
                assert_ne!(
                    v.read(cx)
                        .transcript
                        .read(cx)
                        .reading_mark(cx)
                        .unwrap()
                        .message,
                    Some(canonical)
                );
            });
            assert!(reads.try_recv().is_err(), "no restoration paging/draining");
            assert!(writes.try_recv().is_err());
            // One contextual control still owns bounded-window refresh and retry,
            // not merely a jump to the bottom of the old loaded rows.
            let retained = cx
                .update_window(h, |_, _, cx| {
                    v.update(cx, |v, cx| {
                        assert!(v.nav_error.is_some());
                        let retained = v.transcript.read(cx).history_probe_row(old_render);
                        v.state.limited = true;
                        v.sync_history_controls(cx);
                        retained
                    })
                })
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert_eq!(cx.theme().is_dark(), mode == ThemeMode::Dark);
                assert_eq!(w.find("latest").label(), Some("Refresh latest"));
                w.click("latest", cx);
            })
            .unwrap();
            settle(cx, h);
            assert!(
                matches!(reads.try_recv(),Ok(Command::Open{id,generation:15}) if id=="synthetic")
            );
            cx.update_window(h, |_, w, cx| {
                v.update(cx, |v, cx| {
                    let mut failed = v.state.clone();
                    failed.generation = 15;
                    failed.loaded = false;
                    failed.page_busy = false;
                    failed.chat_status =
                        "Synthetic latest read failed. Last loaded page retained.".into();
                    v.accept(failed, w, cx);
                    assert_eq!(
                        v.transcript
                            .read(cx)
                            .history_probe_row(old_render)
                            .entity_id(),
                        retained.entity_id()
                    );
                })
            })
            .unwrap();
            settle(cx, h);
            if let Some(dir) = std::env::var_os("PILOT_NEXT_CONTEXTUAL_DIR") {
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(std::path::PathBuf::from(dir).join(format!(
                        "{}-{}-retry-latest.png",
                        width as u32,
                        mode.name()
                    )))
                    .unwrap();
            }
            cx.update_window(h, |_, w, cx| {
                assert_eq!(w.find("latest").label(), Some("Retry latest"));
                w.click("latest", cx);
            })
            .unwrap();
            settle(cx, h);
            assert!(
                matches!(reads.try_recv(),Ok(Command::Open{id,generation:16}) if id=="synthetic")
            );
            publish(
                cx,
                h,
                &v,
                15,
                snapshot(vec![entry(50, "STALE latest completion")]),
            );
            cx.update(|cx| {
                assert!(v.read(cx).refreshing);
                assert_eq!(
                    v.read(cx)
                        .transcript
                        .read(cx)
                        .history_probe_row(old_render)
                        .entity_id(),
                    retained.entity_id()
                );
            });
            publish(
                cx,
                h,
                &v,
                16,
                snapshot(vec![entry(40, "CURRENT latest completion")]),
            );
            cx.update_window(h, |_, w, cx| {
                assert!(v.read(cx).transcript.read(cx).history_probe_anchor(cx).2);
                assert!(w.try_find("latest").is_none());
            })
            .unwrap();
            assert!(reads.try_recv().is_err() && writes.try_recv().is_err());
            println!(
                "{}",
                json!({"width":width,"mode":mode.name(),"canonical_reader_fresh_open":true,"actual_reducer":true,"thinking_text_allocation_collision":true,"native_copy_proves_old_source":true,"missing_canonical_marker_no_numeric_fallback":true,"owner_generation_fences":true,"contextual_bounded_latest_retry_stale_completion":true,"transcript_cache":false,"automatic_history_reads":0,"canonical_writes":0})
            );
            cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
            cx.run_until_parked();
        }
    }
}
