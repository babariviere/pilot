//! Same fixed synthetic production-root fixture before and after shell styling.
//! Baseline mode relaxes only new-layout assertions, never route/write fences.
use super::*;
use gpui_kit::{
    Bounds, EntityInputHandler, Focusable, HeadlessAppContext, WindowBounds, WindowOptions,
    component::{Theme, ThemeMode},
    size,
    test::TestWindowExt,
};
use serde_json::json;
fn settle(cx: &mut HeadlessAppContext, h: gpui_kit::AnyWindowHandle) {
    for _ in 0..24 {
        cx.advance_clock(Duration::from_millis(16));
        cx.run_until_parked();
        cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
    }
}
fn capture(
    cx: &mut HeadlessAppContext,
    h: gpui_kit::AnyWindowHandle,
    dir: &Option<std::path::PathBuf>,
    name: String,
) {
    if let Some(dir) = dir {
        cx.capture_screenshot(h)
            .unwrap()
            .save(dir.join(name))
            .unwrap();
    }
}
pub fn run_workbench_probe(cx: &mut HeadlessAppContext) {
    let baseline = std::env::var_os("PILOT_NEXT_WORKBENCH_BASELINE").is_some();
    let captures = std::env::var_os("PILOT_NEXT_WORKBENCH_DIR").map(std::path::PathBuf::from);
    if let Some(d) = &captures {
        std::fs::create_dir_all(d).unwrap();
    }
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            cx.update(|cx| Theme::change(mode, None, cx));
            let (client, reads) = LocalClient::synthetic_commands();
            let (writer, writes) = Interaction::recording();
            let(h,v)=cx.update(|cx|gpui_kit::open_window(WindowOptions{window_bounds:Some(WindowBounds::Windowed(Bounds::new(Default::default(),size(px(width),px(760.))))),show:false,focus:false,..Default::default()},cx,|w,cx|cx.new(|cx|{
            let mut v=LocalViewer::preview(PreviewState::Conversation,w,cx);
            v.client=Some(client);v.writer=Some(writer.clone());v.editor.update(cx,|e,cx|e.shell_probe_setup(writer,w,cx));
            v.generation=20;v.state.generation=20;v.state.loaded=true;v.state.list_loaded=true;v.state.projects_loaded=true;
            v.state.projects=Arc::new(crate::local_model::projects(&json!([
                {"id":"a","name":format!("Atlas {}","long project name 👩‍💻 ".repeat(4)),"path":"/synthetic/shared"},
                {"id":"b","name":"Boreal","path":"/synthetic/shared"}
            ])).unwrap());
            v.state.chats=Arc::new([
                json!({"id":"synthetic","title":format!("Current {}","long conversation title ".repeat(4)),"projectId":"a","state":"working"}),
                json!({"id":"other","title":"Review package","projectId":"b","state":"idle"}),
                json!({"id":"failed","title":"Check failed build","projectId":"a","state":"failed"}),
                json!({"id":"archive","title":"Retained archived note","projectId":"b","state":"idle","archivedAt":1})
            ].iter().map(|x|crate::local_model::chat(x).unwrap()).collect());
            v.title="Synthetic workbench conversation".into();v.rebuild_nav(w,cx);v
        }))).unwrap();
            let fixture = cx.update(|cx| {
                (
                    v.read(cx).state.projects.clone(),
                    v.read(cx).state.chats.clone(),
                )
            });
            settle(cx, h);
            if !baseline {
                let glyphs = cx
                    .update_window(h, |_, w, _| {
                        [
                            "nav-home-title-icon",
                            "nav-inbox-title-icon",
                            "nav-all-chats-title-icon",
                            "open-usage-title-icon",
                            "open-settings-title-icon",
                        ]
                        .map(|id| (id, w.find(id).bounds()))
                    })
                    .unwrap();
                let image = cx.capture_screenshot(h).unwrap();
                let scale = image.width() as f32 / width;
                for (id, bounds) in glyphs {
                    crate::icon_probe::assert_painted(bounds, scale, id, |x, y| {
                        image.get_pixel(x, y).0
                    });
                }
            }
            capture(
                cx,
                h,
                &captures,
                format!("{}-{}-chat.png", width as u32, mode.name()),
            );
            cx.update_window(h, |_, w, cx| {
                for id in [
                    "new-local-chat",
                    "chat-filters",
                    "nav-home",
                    "nav-inbox",
                    "nav-all-chats",
                ] {
                    let b = w.find(id).bounds();
                    assert!(
                        b.left() >= px(0.)
                            && b.right() <= px(if width < 800. { 184. } else { 232. }),
                        "sidebar target {id} stays in bounds"
                    );
                }
                if !baseline {
                    sidebar_alignment(w, width);
                    assert!(w.try_find("add-project").is_none(), "management is disclosed, not permanent");
                    for id in ["nav-home", "nav-inbox", "nav-all-chats"] {
                        let button = w.find(id).bounds();
                        let label = w.find(format!("{id}-title")).bounds();
                        let icon = w.find(format!("{id}-title-icon")).bounds();
                        assert!(
                            icon.left() >= button.left()
                                && icon.left() - button.left() < px(12.)
                                && icon.size == size(w.rem_size(), w.rem_size())
                                && (label.left() - icon.right() - w.rem_size() * 0.5).abs() < px(0.5)
                                && label.right() <= button.right(),
                            "{id} uses a painted-size leading slot and left-aligned label, not centered content"
                        );
                    }
                }
                w.click("nav-home", cx);
            })
            .unwrap();
            settle(cx, h);
            capture(
                cx,
                h,
                &captures,
                format!("{}-{}-home.png", width as u32, mode.name()),
            );
            cx.update_window(h, |_, w, cx| {
                let row = w.find("home-project-a").bounds();
                let title = w.within("home-project-a").find("resource-title").bounds();
                assert!(title.left() >= row.left() && title.right() <= row.right());
                if !baseline {
                    assert!(
                        w.find("home-projects-heading").bounds().top()
                            < w.find("home-working-heading").bounds().top()
                    );
                    assert!(
                        w.find("home-working-heading").bounds().top()
                            < w.find("home-recent-heading").bounds().top()
                    );
                    assert!(w.try_find("home-loaded-qualifier").is_some());
                }
                if w.try_find("project-scope").is_some() {
                    w.click("project-scope", cx);
                } else {
                    assert!(baseline);
                }
            })
            .unwrap();
            settle(cx, h);
            capture(
                cx,
                h,
                &captures,
                format!("{}-{}-scope.png", width as u32, mode.name()),
            );
            if !baseline {
                let icon = cx
                    .update_window(h, |_, w, _| {
                        let leading = w.find("nav-home-title-icon").bounds().left();
                        let text = w.find("nav-home-title").bounds().left();
                        for id in ["project-a", "project-b"] {
                            let row = w.find(id).bounds();
                            let glyph = w.within(id).find("scope-project-icon").bounds();
                            let label = w.within(id).find("scope-project-title").bounds();
                            assert!(
                                (glyph.left() - leading).abs() < px(0.5),
                                "{id} leading column"
                            );
                            assert!((label.left() - text).abs() < px(0.5), "{id} text column");
                            assert!(
                                label.right() <= row.right()
                                    && row.size.height >= w.rem_size() * 2.
                            );
                        }
                        let add = w.find("add-project").bounds();
                        assert!(
                            add.left() >= px(12.)
                                && add.right() <= px(if width < 800. { 172. } else { 220. })
                        );
                        assert_eq!(add.size.height, w.rem_size() * 2.);
                        assert!(
                            (w.find("add-project-title").bounds().left() - text).abs() < px(0.5)
                        );
                        w.find("add-project-title-icon").bounds()
                    })
                    .unwrap();
                let image = cx.capture_screenshot(h).unwrap();
                crate::icon_probe::assert_painted(
                    icon,
                    image.width() as f32 / width,
                    "Add project glyph",
                    |x, y| image.get_pixel(x, y).0,
                );
            }
            cx.update_window(h, |_, w, cx| {
                let b = w.find("project-b").bounds();
                assert!(b.right() <= px(if width < 800. { 184. } else { 232. }));
                w.click("project-b", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update(|cx| assert_eq!(v.read(cx).project_scope.as_deref(), Some("b")));
            assert!(reads.try_recv().is_err() && writes.try_recv().is_err());
            cx.update_window(h, |_, w, cx| {
                if !baseline {
                    let button = w.find("project-overview").bounds();
                    let label = w.find("project-overview-title").bounds();
                    let icon = w.find("project-overview-title-icon").bounds();
                    assert!(
                        icon.left() >= button.left()
                            && icon.left() - button.left() < px(12.)
                            && (label.left() - icon.right() - w.rem_size() * 0.5).abs() < px(0.5)
                            && label.right() <= button.right()
                    );
                }
                w.click("project-overview", cx);
                v.update(cx, |v, cx| {
                    v.state.projects = Arc::new(vec![v.state.projects[0].clone()]);
                    v.state.projects_error =
                        Some("Synthetic catalog unavailable; last valid chats remain.");
                    v.rebuild_nav(w, cx);
                });
            })
            .unwrap();
            settle(cx, h);
            capture(
                cx,
                h,
                &captures,
                format!("{}-{}-removed-project.png", width as u32, mode.name()),
            );
            cx.update(|cx| {
                assert_eq!(v.read(cx).page, Page::Project("b".into()));
                assert_eq!(v.read(cx).project_scope.as_deref(), Some("b"));
            });
            cx.update_window(h, |_, w, cx| w.press("secondary-2", cx))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                w.press("secondary-k", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(w.try_find("jump-palette").is_some());
                w.press("escape", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                w.press("secondary-1", cx);
                v.update(cx, |v, cx| {
                    v.state.chats = Arc::new(vec![]);
                    v.state.projects = Arc::new(vec![]);
                    v.state.projects_loaded = false;
                    v.state.list_loaded = false;
                    v.state.projects_error = None;
                    v.rebuild_nav(w, cx);
                });
            })
            .unwrap();
            settle(cx, h);
            capture(
                cx,
                h,
                &captures,
                format!("{}-{}-loading.png", width as u32, mode.name()),
            );
            cx.update_window(h, |_, w, _| {
                assert_eq!(
                    w.find("sidebar-empty-message").bounds().left(),
                    w.find("nav-home-title-icon").bounds().left(),
                    "loading message keeps the common leading column"
                );
            })
            .unwrap();
            cx.update_window(h, |_, w, cx| {
                v.update(cx, |v, cx| {
                    v.state.projects_loaded = true;
                    v.state.list_loaded = true;
                    v.rebuild_nav(w, cx);
                })
            })
            .unwrap();
            settle(cx, h);
            capture(
                cx,
                h,
                &captures,
                format!("{}-{}-empty.png", width as u32, mode.name()),
            );
            cx.update_window(h, |_, w, _| {
                assert_eq!(
                    w.find("sidebar-empty-message").bounds().left(),
                    w.find("nav-home-title-icon").bounds().left(),
                    "empty message keeps the common leading column"
                );
            })
            .unwrap();
            assert!(reads.try_recv().is_err() && writes.try_recv().is_err());
            if !baseline {
                chooser_checks(cx, h, &v, fixture);
                assert!(reads.try_recv().is_err() && writes.try_recv().is_err());
                cx.update_window(h, |_, w, cx| {
                    v.update(cx, |v, cx| {
                        v.state.status = "Unavailable · synthetic Local connection refused".into();
                        v.state.projects_error = Some("Synthetic catalog unavailable");
                        let mut chats = v.state.chats.as_ref().clone();
                        chats[0].title = "資料 👩‍💻 e\u{301} Ελληνικά ".repeat(30);
                        v.state.chats = Arc::new(chats);
                        v.rebuild_nav(w, cx);
                    });
                })
                .unwrap();
                settle(cx, h);
                cx.update_window(h, |_, w, _| {
                    assert!(w.try_find("sidebar-connection").is_some());
                    sidebar_alignment(w, width);
                    let footer = w.find("sidebar-footer").bounds();
                    let connection = w.find("sidebar-connection").bounds();
                    assert!(
                        footer.bottom() <= connection.top()
                            && connection.bottom() <= w.viewport_size().height
                    );
                })
                .unwrap();
                capture(
                    cx,
                    h,
                    &captures,
                    format!("{}-{}-unavailable-unicode.png", width as u32, mode.name()),
                );
            }
            println!(
                "{}",
                json!({"width":width,"mode":mode.name(),"baseline":baseline,"same_synthetic_fixture":"workbench-v1","exact_scope_and_removed_no_fallback":true,"long_label_bounds":true,"global_navigation_and_palette_reachable":true,"canonical_write_commands":0,"implicit_reads":0,"native_offscreen":true})
            );
            cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
            cx.run_until_parked();
        }
    }
}

// Assert measured columns, not arbitrary wider allowances after adding glyphs.
fn sidebar_alignment(w: &mut Window, width: f32) {
    let leading = w.find("nav-home-title-icon").bounds().left();
    let text = w.find("nav-home-title").bounds().left();
    let right = px(if width < 800. { 172. } else { 220. });
    for id in [
        "nav-home",
        "nav-inbox",
        "nav-missions",
        "nav-all-chats",
        "open-usage",
        "open-settings",
        "sidebar-jump",
    ] {
        let row = w.find(id).bounds();
        let glyph = w.find(format!("{id}-title-icon")).bounds();
        let label = w.find(format!("{id}-title")).bounds();
        assert_eq!(row.left(), px(12.), "{id} common inset");
        assert_eq!(
            row.size.height,
            w.rem_size() * 2.,
            "{id} usable native row height"
        );
        assert!(
            (glyph.left() - leading).abs() < px(0.5),
            "{id} leading slot"
        );
        assert!((label.left() - text).abs() < px(0.5), "{id} text column");
        assert!(
            (glyph.center().y - label.center().y).abs() < px(0.5),
            "{id} centered baseline"
        );
        assert!(
            label.right() <= row.right() && row.right() <= right,
            "{id} bounded label and target"
        );
    }
    let scope = w.find("project-scope-title").bounds();
    assert!((scope.left() - text).abs() < px(0.5));
    let count = w.find("sidebar-chat-count").bounds();
    assert!((count.left() - leading).abs() < px(0.5));
    let row = w.find("chat-row-synthetic").bounds();
    let title = w
        .within("chat-row-synthetic")
        .find("sidebar-chat-title")
        .bounds();
    let detail = w
        .within("chat-row-synthetic")
        .find("sidebar-chat-detail")
        .bounds();
    let menu = w.find("chat-menu-synthetic").bounds();
    let compose = w.find("new-local-chat").bounds();
    let filter = w.find("chat-filters").bounds();
    assert!(
        (title.left() - leading).abs() < px(0.5) && title.left() == detail.left(),
        "chat text has no phantom icon column"
    );
    assert!(
        title.right() <= menu.left()
            && menu.right() <= right
            && row.size.height >= px(crate::appearance::Space::ROW)
    );
    assert!(
        (menu.center().x - compose.center().x).abs() < px(0.5)
            && (filter.center().x - compose.center().x).abs() < px(0.5),
        "common trailing action column"
    );
    for bounds in [compose, filter, menu] {
        assert_eq!(bounds.size, size(w.rem_size() * 2., w.rem_size() * 2.));
    }
    println!(
        "{}",
        json!({"sidebar_columns":true,"width":width,"leading":f32::from(leading),"text":f32::from(text),"trailing_action_center":f32::from(compose.center().x),"row_height":f32::from(compose.size.height)})
    );
}

// Runs after all matched captures: extra interaction state never changes their fixture.
fn chooser_checks(
    cx: &mut HeadlessAppContext,
    h: gpui_kit::AnyWindowHandle,
    v: &Entity<LocalViewer>,
    fixture: (Arc<Vec<crate::local_model::Project>>, Arc<Vec<Chat>>),
) {
    for (loaded, error, label) in [
        (false, None, "Loading Local projects…"),
        (true, None, "No configured projects"),
        (
            true,
            Some("Synthetic project error"),
            "Project list unavailable",
        ),
    ] {
        cx.update_window(h, |_, w, cx| {
            v.update(cx, |v, cx| {
                v.state.projects_loaded = loaded;
                v.state.projects_error = error;
                v.rebuild_nav(w, cx);
            });
            w.click("project-scope", cx);
        })
        .unwrap();
        settle(cx, h);
        cx.update_window(h, |_, w, cx| {
            assert!(v.read(cx).projects_open);
            assert_eq!(v.read(cx).projects.read(cx).delegate().empty_label, label);
            assert!(
                v.read(cx).projects.focus_handle(cx).is_focused(w),
                "empty chooser has a mounted keyboard owner"
            );
            w.press("escape", cx);
        })
        .unwrap();
        settle(cx, h);
        cx.update_window(h, |_, w, cx| {
            assert!(!v.read(cx).projects_open);
            assert!(
                v.read(cx)
                    .chats
                    .read(cx)
                    .query_input()
                    .focus_handle(cx)
                    .is_focused(w)
            );
        })
        .unwrap();
    }
    cx.update_window(h, |_, w, cx| {
        v.update(cx, |v, cx| {
            v.state.projects = fixture.0;
            v.state.chats = fixture.1;
            v.state.projects_loaded = true;
            v.state.list_loaded = true;
            v.state.projects_error = None;
            v.rebuild_nav(w, cx);
        });
        w.press("secondary-2", cx);
    })
    .unwrap();
    settle(cx, h);
    let (reader, cursor) =
        cx.update(|cx| (v.read(cx).transcript.entity_id(), v.read(cx).state.cursor));
    let text = cx.update(|cx| v.read(cx).editor.read(cx).shell_probe().0);
    let (mark, focus) = cx
        .update_window(h, |_, w, cx| {
            assert_eq!(v.read(cx).page, Page::Chat);
            text.focus_handle(cx).focus(w, cx);
            assert!(text.focus_handle(cx).is_focused(w));
            let mark = text.update(cx, |t, cx| {
                t.replace_and_mark_text_in_range(None, "にほん", Some(3..3), w, cx);
                t.marked_text_range(w, cx)
            });
            assert!(mark.is_some());
            let focus = w.focused(cx);
            w.click("project-scope", cx);
            assert!(
                !v.read(cx).projects_open,
                "chooser respects composer preedit"
            );
            (mark, focus)
        })
        .unwrap();
    settle(cx, h);
    cx.update_window(h, |_, w, cx| {
        assert_eq!(w.focused(cx), focus);
        text.update(cx, |t, cx| {
            assert_eq!(t.marked_text_range(w, cx), mark);
            assert_eq!(t.value().to_string(), "にほん");
            // Marking/unmarking is transient and emits no Change. Commit the
            // candidate through insertText's real handler before asserting
            // the app-owned saved draft later in this interaction sequence.
            t.replace_text_in_range(None, "にほん", w, cx);
        });
        // Conversation Cmd-F now belongs to loaded-conversation find.
        // Focus the actual sidebar search owner for its separate IME contract.
        v.read(cx).chats.clone().update(cx, |l, cx| l.focus(w, cx));
    })
    .unwrap();
    settle(cx, h);
    let query = cx.update(|cx| v.read(cx).chats.read(cx).query_input());
    let (mark, focus) = cx
        .update_window(h, |_, w, cx| {
            assert!(query.focus_handle(cx).is_focused(w));
            let mark = query.update(cx, |q, cx| {
                q.replace_and_mark_text_in_range(None, "にほん", Some(3..3), w, cx);
                q.marked_text_range(w, cx)
            });
            assert!(mark.is_some());
            let focus = w.focused(cx);
            w.click("project-scope", cx);
            assert!(
                !v.read(cx).projects_open,
                "chooser respects sidebar preedit"
            );
            (mark, focus)
        })
        .unwrap();
    settle(cx, h);
    cx.update_window(h, |_, w, cx| {
        assert_eq!(w.focused(cx), focus);
        query.update(cx, |q, cx| {
            assert_eq!(q.marked_text_range(w, cx), mark);
            assert_eq!(q.value().as_ref(), "にほん");
            q.unmark_text(w, cx);
        });
        w.press("secondary-a", cx);
        w.press("backspace", cx);
        w.click("project-scope", cx);
    })
    .unwrap();
    settle(cx, h);
    cx.update_window(h, |_, w, cx| {
        assert!(v.read(cx).projects_open);
        w.press("down", cx);
        w.press("down", cx);
        let index = v.read(cx).projects.read(cx).selected_index();
        assert!(index.is_some());
        v.update(cx, |v, cx| {
            v.state.projects_error = Some("Synthetic catalog error; retained choices");
            v.rebuild_nav(w, cx);
        });
        assert_eq!(
            v.read(cx).projects.read(cx).selected_index(),
            index,
            "status-only refresh preserves keyboard choice"
        );
        w.press("escape", cx);
    })
    .unwrap();
    settle(cx, h);
    cx.update_window(h, |_, _, cx| {
        assert!(!v.read(cx).projects_open);
        let projects = v.read(cx).projects.clone();
        projects.update(cx, |_, cx| cx.emit(ListEvent::Confirm(IndexPath::new(0))));
    })
    .unwrap();
    settle(cx, h);
    cx.update_window(h, |_, w, cx| {
        assert_eq!(
            v.read(cx).project_scope,
            None,
            "hidden queued choice cannot navigate"
        );
        w.click("project-scope", cx);
        w.press("secondary-k", cx);
    })
    .unwrap();
    settle(cx, h);
    cx.update_window(h, |_, _, cx| {
        assert!(v.read(cx).jump.is_some());
        let projects = v.read(cx).projects.clone();
        projects.update(cx, |_, cx| cx.emit(ListEvent::Confirm(IndexPath::new(0))));
    })
    .unwrap();
    settle(cx, h);
    cx.update_window(h, |_, w, cx| {
        assert_eq!(
            v.read(cx).project_scope,
            None,
            "palette is newer than underlying queued choice"
        );
        assert_eq!(v.read(cx).transcript.entity_id(), reader);
        assert_eq!(v.read(cx).state.cursor, cursor);
        assert_eq!(
            v.read(cx).editor.read(cx).shell_probe().2.unwrap().text,
            "にほん"
        );
        w.press("escape", cx);
    })
    .unwrap();
    settle(cx, h);
    cx.update_window(h, |_, w, cx| w.press("escape", cx))
        .unwrap();
    settle(cx, h);
    cx.update(|cx| assert!(!v.read(cx).projects_open));
}
