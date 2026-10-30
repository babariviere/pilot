//! Actual hidden native Archive navigation. Every read/write is injected.
use super::*;
use gpui_kit::{
    Bounds, EntityInputHandler, HeadlessAppContext, WindowBounds, WindowOptions,
    component::{ActiveTheme, Theme, ThemeMode},
    size,
    test::{TestEventExt, TestWindowExt},
};
use serde_json::json;
fn settle(cx: &mut HeadlessAppContext, h: gpui_kit::AnyWindowHandle) {
    for _ in 0..16 {
        cx.run_until_parked();
        cx.advance_clock(Duration::from_millis(16));
        cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
    }
}
fn inventory() -> Vec<Chat> {
    let mut rows = vec![
        json!({"id":"synthetic","title":"Current draft owner","state":"idle","projectId":"p"}),
        json!({"id":"a","title":"Same title 日本語 👩‍💻","state":"parked","projectId":"p","missionId":"m","missionCoordinator":true,"archivedAt":90,"cwd":"/synthetic/p"}),
        json!({"id":"b","title":"Same title 日本語 👩‍💻","state":"parked","projectId":"other","missionId":"m","archivedAt":91,"cwd":"/synthetic/other"}),
        json!({"id":"none","title":"Outside every project","state":"parked","archivedAt":92,"cwd":"/synthetic/no-project"}),
    ];
    rows.extend((0..45).map(|i|json!({"id":format!("older-{i}"),"title":format!("Archived research {i}"),"projectId":"p","archivedAt":i+1,"state":"parked"})));
    rows.iter()
        .map(|v| crate::local_model::chat(v).unwrap())
        .collect()
}
fn menu(
    cx: &mut HeadlessAppContext,
    h: gpui_kit::AnyWindowHandle,
    button: &'static str,
    label: &str,
) {
    cx.update_window(h, |_, w, cx| w.click(button, cx)).unwrap();
    settle(cx, h);
    cx.update_window(h, |_, w, cx| {
        let p = w
            .within("popup-menu")
            .find_by_label(label)
            .bounds()
            .center();
        w.pointer_down(p, gpui_kit::MouseButton::Left, cx);
        w.pointer_up(p, gpui_kit::MouseButton::Left, cx);
    })
    .unwrap();
    settle(cx, h);
}
fn ids(cx: &mut HeadlessAppContext, v: &Entity<LocalViewer>) -> Vec<String> {
    cx.update(|cx| v.read(cx).archive.read(cx).probe_ids(cx))
}
pub fn run_archive_probe(cx: &mut HeadlessAppContext) {
    let dir = std::env::var_os("PILOT_NEXT_ARCHIVE_DIR").map(std::path::PathBuf::from);
    if let Some(d) = &dir {
        std::fs::create_dir_all(d).unwrap();
    }
    for width in [680., 1100.] {
        for dark in [false, true] {
            let (client, commands) = LocalClient::synthetic_commands();
            let (writer, writes) = Interaction::recording();
            let (h,v)=cx.update(|cx|gpui_kit::open_window(WindowOptions{window_bounds:Some(WindowBounds::Windowed(Bounds::new(Default::default(),size(px(width),px(840.))))),show:false,focus:false,..Default::default()},cx,|w,cx|cx.new(|cx|{
            w.activate_window();let mut v=LocalViewer::preview(PreviewState::Conversation,w,cx);v.client=Some(client);
            v.editor.update(cx,|e,cx|e.shell_probe_setup(writer,w,cx));
            v.state.chats=Arc::new(inventory());v.state.projects=Arc::new(crate::local_model::projects(&json!([{"id":"p","name":"Pilot research","path":"/synthetic/p"},{"id":"other","name":"Other project","path":"/synthetic/other"}])).unwrap());v.state.projects_loaded=true;
            v.state.mission_titles=Some(Arc::new(std::collections::HashMap::from([("m".into(),"Archived mission".into())])));
            v.state.summary_fresh=true;v.state.list_loaded=true;v.state.loaded=true;v.state.cursor=Some(100);
            crate::mission_inspector::Metadata::accept(&mut v.state.mission_metadata,&json!({"type":"session","session":{"id":"none","projectId":null}}));
            v.transcript.update(cx,|t,cx|t.replace_readonly((100..124).map(|id|Message::live(id,"assistant".into(),format!("Unrelated retained history {id} {}","readable ".repeat(60)))).collect(),true,cx));v.rebuild_nav(w,cx);v
        }))).unwrap();
            // The window's appearance observer runs on open. Pin the theme afterwards.
            cx.update(|cx| {
                Theme::change(
                    if dark {
                        ThemeMode::Dark
                    } else {
                        ThemeMode::Light
                    },
                    None,
                    cx,
                )
            });
            settle(cx, h);
            cx.update(|cx| assert_eq!(cx.theme().is_dark(), dark));
            let (editor, input, transcript) = cx.update(|cx| {
                let e = v.read(cx).editor.clone();
                (
                    e.clone(),
                    e.read(cx).shell_probe().0,
                    v.read(cx).transcript.clone(),
                )
            });
            cx.update_window(h, |_, w, cx| {
                input.update(cx, |i, cx| {
                    i.focus(w, cx);
                    i.replace_text_in_range(None, "Keep draft 👩‍💻 e\u{301}", w, cx);
                    i.replace_and_mark_text_in_range(None, "に", Some(1..1), w, cx);
                });
                v.update(cx, |v, cx| assert!(!v.show_archive(w, cx)));
                assert!(input.update(cx, |i, cx| i.marked_text_range(w, cx).is_some()));
                input.update(cx, |i, cx| i.unmark_text(w, cx));
                w.click("project-scope", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                input.update(cx, |i, cx| {
                    i.replace_and_mark_text_in_range(None, "か", Some(1..1), w, cx)
                });
                w.click("nav-archive", cx);
                assert_ne!(v.read(cx).page, Page::Archive);
                assert!(input.update(cx, |i, cx| i.marked_text_range(w, cx).is_some()));
                input.update(cx, |i, cx| i.unmark_text(w, cx));
            })
            .unwrap();
            let draft = cx.update(|cx| input.read(cx).value().to_string());
            let reader_entity = transcript.entity_id();
            cx.update_window(h, |_, w, cx| w.click("nav-archive", cx))
                .unwrap();
            settle(cx, h);
            assert_eq!(ids(cx, &v).len(), 48);
            // Long Archive inventory owns its scroll independently of the reader.
            cx.update_window(h, |_, w, cx| {
                w.scroll(
                    "archive-list",
                    gpui_kit::ScrollDelta::Pixels(gpui_kit::point(px(0.), px(-240.))),
                    cx,
                )
            })
            .unwrap();
            settle(cx, h);
            let archive_y = cx.update(|cx| {
                v.read(cx)
                    .archive
                    .read(cx)
                    .list
                    .read(cx)
                    .scroll_handle()
                    .offset()
                    .y
            });
            assert!(archive_y < px(-20.));
            cx.update_window(h, |_, w, cx| {
                v.update(cx, |v, cx| {
                    let mut state = v.state.clone();
                    state.rows = v.transcript.read(cx).rows().to_vec();
                    state.chats = Arc::new(state.chats.as_ref().clone());
                    v.accept(state, w, cx);
                })
            })
            .unwrap();
            settle(cx, h);
            assert_eq!(
                cx.update(|cx| v
                    .read(cx)
                    .archive
                    .read(cx)
                    .list
                    .read(cx)
                    .scroll_handle()
                    .offset()
                    .y),
                archive_y
            );
            cx.update_window(h, |_, w, cx| w.press("secondary-[", cx))
                .unwrap();
            settle(cx, h);
            assert_eq!(cx.update(|cx| v.read(cx).page.clone()), Page::Chat);
            assert!(
                commands.is_empty(),
                "return to the retained reader must not reopen it"
            );
            assert_eq!(cx.update(|cx| v.read(cx).state.cursor), Some(100));
            cx.update_window(h, |_, w, cx| w.press("secondary-]", cx))
                .unwrap();
            settle(cx, h);
            assert_eq!(
                cx.update(|cx| v
                    .read(cx)
                    .archive
                    .read(cx)
                    .list
                    .read(cx)
                    .scroll_handle()
                    .offset()
                    .y),
                archive_y
            );
            cx.update_window(h, |_, w, cx| {
                assert_eq!(v.read(cx).page, Page::Archive);
                assert_eq!(v.read(cx).selected.as_deref(), Some("synthetic"));
                assert!(w.try_find("composer-input").is_none());
                let page = w.find("archive-page").bounds();
                let list = w.find("archive-list").bounds();
                assert!(list.left() >= page.left() && list.right() <= page.right());
                let q = v.read(cx).archive.read(cx).list.read(cx).query_input();
                q.update(cx, |q, cx| {
                    q.focus(w, cx);
                    q.replace_text_in_range(None, "Same title", w, cx);
                });
            })
            .unwrap();
            settle(cx, h);
            assert_eq!(ids(cx, &v), ["b", "a"]);
            menu(cx, h, "archive-project", "Pilot research");
            assert_eq!(ids(cx, &v), ["a"]);
            menu(cx, h, "archive-mission", "Archived mission");
            assert_eq!(ids(cx, &v), ["a"]);
            menu(cx, h, "archive-project", "No project");
            assert!(ids(cx, &v).is_empty());
            menu(cx, h, "archive-project", "All projects");
            assert_eq!(ids(cx, &v), ["b", "a"]);
            // Escape dismisses a filter first, without leaving Archive.
            cx.update_window(h, |_, w, cx| {
                w.click("archive-project", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| w.press("escape", cx))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert_eq!(v.read(cx).page, Page::Archive);
                w.click("archive-refresh", cx);
            })
            .unwrap();
            settle(cx, h);
            assert!(matches!(commands.try_recv(), Ok(Command::RefreshSummaries)));
            cx.update_window(h, |_, w, cx| w.click("archive-refresh", cx))
                .unwrap();
            settle(cx, h);
            assert!(commands.is_empty());
            // A held shared refresh cannot move selection, reader or its lazy cursor.
            cx.update_window(h, |_, w, cx| {
                v.update(cx, |v, cx| {
                    assert_eq!(v.selected.as_deref(), Some("synthetic"));
                    assert_eq!(v.state.cursor, Some(100));
                    let mut state = v.state.clone();
                    state.inventory_refreshing = false;
                    state.inventory_error = Some("Synthetic refresh failed");
                    state.summary_fresh = false;
                    state.status = "Offline".into();
                    v.accept(state, w, cx);
                })
            })
            .unwrap();
            settle(cx, h);
            assert_eq!(ids(cx, &v), ["b", "a"]);
            if let Some(d) = &dir {
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(d.join(format!(
                        "{}-{}-stale.png",
                        width as u32,
                        if dark { "dark" } else { "light" }
                    )))
                    .unwrap();
            }
            // Pointer opens exactly b, never the same-title a. No writable command exists.
            cx.update_window(h, |_, w, cx| w.click("archive-label-b", cx))
                .unwrap();
            settle(cx, h);
            assert!(matches!(commands.try_recv(),Ok(Command::OpenArchive{id,..}) if id=="b"));
            cx.update_window(h, |_, w, cx| {
                v.update(cx, |v, cx| {
                    assert_eq!(v.selected.as_deref(), Some("b"));
                    let mut late = v.state.clone();
                    late.generation = v.generation - 1;
                    late.rows = vec![Message::live(1, "assistant".into(), "Wrong target".into())];
                    v.accept(late, w, cx);
                    assert!(
                        !v.transcript
                            .read(cx)
                            .rows()
                            .iter()
                            .any(|r| r.source() == "Wrong target")
                    );
                    let mut current = v.state.clone();
                    current.generation = v.generation;
                    current.loaded = true;
                    current.passive_history = true;
                    current.rows = vec![Message::live(
                        100,
                        "assistant".into(),
                        "Archived readable history".into(),
                    )];
                    current.cursor = Some(100);
                    v.accept(current, w, cx);
                })
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(w.try_find("archived-composer").is_some());
                assert!(w.try_find("composer-input").is_none());
                w.press("secondary-f", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(
                    w.try_find("transcript-find").is_some(),
                    "read-only Archive history retains native Find"
                );
                w.press("escape", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                w.press("secondary-[", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert_eq!(v.read(cx).page, Page::Archive);
                let q = v.read(cx).archive.read(cx).list.read(cx).query_input();
                q.update(cx, |q, cx| {
                    q.replace_and_mark_text_in_range(None, "に", Some(1..1), w, cx)
                });
                w.click("archive-label-a", cx);
                w.click("archive-refresh", cx);
                w.click("archive-project", cx);
                assert_eq!(v.read(cx).page, Page::Archive);
                assert!(w.try_find("popup-menu").is_none());
                assert!(commands.is_empty());
                v.update(cx, |v, cx| assert!(!v.show_archive(w, cx)));
                assert!(q.update(cx, |q, cx| q.marked_text_range(w, cx).is_some()));
                q.update(cx, |q, cx| q.unmark_text(w, cx));
                let list = v.read(cx).archive.read(cx).list.clone();
                list.update(cx, |l, cx| l.restore_query("Same title", w, cx));
            })
            .unwrap();
            settle(cx, h);
            // Restored summaries disappear by ID without adopting their sibling's title.
            cx.update_window(h, |_, w, cx| {
                v.update(cx, |v, cx| {
                    let mut state = v.state.clone();
                    let mut all = state.chats.as_ref().clone();
                    all.iter_mut().find(|c| c.id == "b").unwrap().archived = false;
                    state.chats = Arc::new(all);
                    v.accept(state, w, cx);
                })
            })
            .unwrap();
            settle(cx, h);
            assert_eq!(ids(cx, &v), ["a"]);
            // Real List keyboard confirmation uses the remaining exact identity.
            cx.update_window(h, |_, w, cx| {
                let archive = v.read(cx).archive.clone();
                archive.update(cx, |a, cx| a.focus(w, cx));
                w.press("down", cx);
                w.press("enter", cx);
            })
            .unwrap();
            settle(cx, h);
            assert!(matches!(commands.try_recv(),Ok(Command::OpenArchive{id,..}) if id=="a"));
            cx.update_window(h, |_, w, cx| w.press("secondary-[", cx))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                let archive = v.read(cx).archive.clone();
                archive.update(cx, |a, cx| a.focus(w, cx));
                w.press("escape", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert_eq!(v.read(cx).page, Page::Archive);
                w.press("escape", cx);
            })
            .unwrap();
            settle(cx, h);
            // Escape with empty search returns through ordinary guarded history.
            assert!(cx.update(|cx| v.read(cx).page != Page::Archive));
            assert_eq!(transcript.entity_id(), reader_entity);
            assert_eq!(
                editor.entity_id(),
                cx.update(|cx| v.read(cx).editor.entity_id())
            );
            // The original per-chat draft still exists, and no send/restore/archive was issued.
            cx.update_window(h, |_, w, cx| {
                v.update(cx, |v, cx| {
                    let chat = v
                        .state
                        .chats
                        .iter()
                        .find(|c| c.id == "synthetic")
                        .unwrap()
                        .clone();
                    v.open(chat, w, cx);
                })
            })
            .unwrap();
            settle(cx, h);
            assert_eq!(cx.update(|cx| input.read(cx).value().to_string()), draft);
            assert!(writes.is_empty());
            // Empty remains distinct from loading and offline retained inventory.
            cx.update_window(h, |_, w, cx| {
                v.update(cx, |v, cx| {
                    let mut state = v.state.clone();
                    state.chats = Arc::new(vec![]);
                    state.rows = vec![];
                    state.summary_fresh = true;
                    state.status = "Synthetic Local inventory".into();
                    state.inventory_error = None;
                    v.accept(state, w, cx);
                    v.show_archive(w, cx);
                })
            })
            .unwrap();
            settle(cx, h);
            assert!(ids(cx, &v).is_empty());
            if let Some(d) = &dir {
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(d.join(format!(
                        "{}-{}-empty.png",
                        width as u32,
                        if dark { "dark" } else { "light" }
                    )))
                    .unwrap();
            }
            cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
            cx.run_until_parked();
            println!(
                "archive native {width} dark={dark}: exact routing, filters, held refresh, stale, keyboard, preedit, draft passed"
            );
        }
    }
}
