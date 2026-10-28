//! Same fixed synthetic production-root fixture before and after shell styling.
//! Baseline mode relaxes only new-layout assertions, never route/write fences.
use super::*;
use gpui_kit::{
    Bounds, EntityInputHandler, Focusable, HeadlessAppContext, Pixels, WindowBounds, WindowOptions,
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
            if !baseline {
                header_alignment(cx, h, &v, width, &captures, mode.name());
            }
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
                    let changes = w.find("workspace-changes-toggle").bounds();
                    let more = w.find("history-menu").bounds();
                    assert!(
                        (more.left() - changes.right() - w.rem_size() * 0.125).abs() < px(0.5),
                        "hidden header actions leave no phantom flex gap"
                    );
                    let header = w.find("chat-header").bounds();
                    assert_eq!(header.size.height, px(48.), "one quiet header row");
                    for id in ["chat-title", "conversation-links-toggle", "history-menu"] {
                        let b = w.find(id).bounds();
                        assert!(b.top() >= header.top() && b.bottom() <= header.bottom(), "{id} stays in the header row");
                    }
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
            if !baseline {
                sidebar_rows(cx, width, mode, &captures);
            }
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
    // Usage and Settings are footer icon actions in Jump to…'s row.
    let footer = w.find("sidebar-footer").bounds();
    for id in ["open-usage", "open-settings"] {
        let b = w.find(id).bounds();
        assert_eq!(
            b.size,
            size(w.rem_size() * 2., w.rem_size() * 2.),
            "{id} target"
        );
        assert!(b.top() >= footer.top() && b.bottom() <= footer.bottom() && b.right() <= right);
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
        (false, None, "Loading projects…"),
        (true, None, "No projects yet"),
        (
            true,
            Some("Synthetic project error"),
            "Couldn't load projects",
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

/// Lowest device row where most of a text run's ink ends: its baseline,
/// ignoring the few descender columns below it.
fn ink_baseline(
    pixel: &impl Fn(u32, u32) -> [u8; 4],
    b: Bounds<Pixels>,
    scale: f32,
    bg: [u8; 4],
) -> u32 {
    let device = |v: Pixels| (f32::from(v) * scale).round() as u32;
    let rows: Vec<(u32, u32)> = (device(b.top())..device(b.bottom()))
        .map(|y| {
            let ink = (device(b.left())..device(b.right()))
                .filter(|&x| {
                    let p = pixel(x, y);
                    (0..3).any(|c| p[c].abs_diff(bg[c]) > 96)
                })
                .count() as u32;
            (y, ink)
        })
        .collect();
    let most = rows.iter().map(|r| r.1).max().unwrap_or(0);
    assert!(most > 0, "text paints ink");
    rows.iter().rev().find(|r| r.1 * 10 >= most * 3).unwrap().0
}

/// Title and project meta share one baseline and stay inside the row,
/// including long Unicode titles and chats without a project.
fn header_alignment(
    cx: &mut HeadlessAppContext,
    h: gpui_kit::AnyWindowHandle,
    v: &gpui_kit::Entity<LocalViewer>,
    width: f32,
    captures: &Option<std::path::PathBuf>,
    mode: &str,
) {
    let found = |cx: &mut HeadlessAppContext| {
        cx.update_window(h, |_, w, _| {
            (
                w.find("chat-header").bounds(),
                w.find("chat-title").bounds(),
                w.try_find("chat-header-meta").map(|m| m.bounds()),
                w.find("conversation-links-toggle").bounds(),
            )
        })
        .unwrap()
    };
    let (header, title, meta, action) = found(cx);
    let meta = meta.expect("project meta is shown");
    let image = cx.capture_screenshot(h).unwrap();
    let scale = image.width() as f32 / width;
    let pixel = |x, y| image.get_pixel(x, y).0;
    let bg = pixel(
        (f32::from(header.left()) * scale) as u32 + 2,
        (f32::from(header.top()) * scale) as u32 + 2,
    );
    let (a, b) = (
        ink_baseline(&pixel, title, scale, bg),
        ink_baseline(&pixel, meta, scale, bg),
    );
    println!(
        "{}",
        json!({"header_baselines": [a, b], "width": width, "scale": scale})
    );
    assert!(
        a.abs_diff(b) <= 1,
        "title baseline {a} and meta baseline {b} (device rows) align at {width}"
    );
    for (id, bounds) in [("title", title), ("meta", meta)] {
        assert!(
            bounds.top() >= header.top() && bounds.bottom() <= header.bottom(),
            "{id} stays in the header row"
        );
    }
    assert!(title.right() <= meta.left() && meta.right() <= action.left());

    // Long Unicode title: both truncate inside the row and the project stays readable.
    let restore = cx.update(|cx| v.read(cx).title.clone());
    cx.update(|cx| {
        v.update(cx, |v, cx| {
            v.title = "資料 👩‍💻 e\u{301} Ελληνικά ".repeat(12);
            cx.notify();
        })
    });
    settle(cx, h);
    let (header, title, meta, action) = found(cx);
    capture(
        cx,
        h,
        captures,
        format!("{}-{mode}-header-unicode.png", width as u32),
    );
    let meta = meta.expect("project meta stays beside a long title");
    assert!(
        title.right() <= meta.left()
            && meta.right() <= action.left()
            && meta.size.width >= px(48.)
            && title.top() >= header.top()
            && meta.bottom() <= header.bottom(),
        "long title truncates and leaves project identity readable: {title:?} {meta:?}"
    );

    // No project: the title alone, still vertically centred in the row.
    let project = cx.update(|cx| {
        v.update(cx, |v, cx| {
            v.title = restore;
            let mut chats = v.state.chats.as_ref().clone();
            let project = chats[0].project_id.take();
            v.state.chats = Arc::new(chats);
            cx.notify();
            project
        })
    });
    settle(cx, h);
    let (header, title, meta, _) = found(cx);
    assert!(meta.is_none(), "no empty meta without a project");
    assert!((title.center().y - header.center().y).abs() <= px(1.));
    cx.update(|cx| {
        v.update(cx, |v, cx| {
            let mut chats = v.state.chats.as_ref().clone();
            chats[0].project_id = project;
            v.state.chats = Arc::new(chats);
            cx.notify();
        })
    });
    settle(cx, h);
}

/// Pixels in `bounds` that differ from its top-left pixel: zero when nothing
/// but the row background is painted there.
fn painted(image: &image::RgbaImage, bounds: Bounds<gpui_kit::Pixels>, scale: f32) -> usize {
    let (x0, y0) = (
        (f32::from(bounds.left()) * scale).ceil() as u32,
        (f32::from(bounds.top()) * scale).ceil() as u32,
    );
    let (x1, y1) = (
        (f32::from(bounds.right()) * scale).floor() as u32,
        (f32::from(bounds.bottom()) * scale).floor() as u32,
    );
    let base = image.get_pixel(x0, y0).0;
    let mut count = 0;
    for y in y0..y1 {
        for x in x0..x1 {
            let p = image.get_pixel(x, y).0;
            if (0..3).map(|c| p[c].abs_diff(base[c]) as u32).sum::<u32>() > 48 {
                count += 1;
            }
        }
    }
    count
}

/// Chat rows: one title line, at most one quiet metadata line that never
/// repeats its section, uniform rhythm, actions revealed on hover or keyboard
/// selection, and Missions as the sidebar's only mission entry.
fn sidebar_rows(
    cx: &mut HeadlessAppContext,
    width: f32,
    mode: ThemeMode,
    captures: &Option<std::path::PathBuf>,
) {
    cx.update(|cx| Theme::change(mode, None, cx));
    let (client, _) = LocalClient::synthetic_commands();
    let (writer, _writes) = Interaction::recording();
    let chats = [
        json!({"id":"synthetic","title":"Current conversation","projectId":"a","state":"working"}),
        json!({"id":"working2","title":format!("Refactor {}","長いタイトル 👩‍💻 ".repeat(4)),"projectId":"b","state":"working"}),
        json!({"id":"jobs","title":"Background build","projectId":"a","state":"idle","runningJobs":[{"id":"j"}]}),
        json!({"id":"stall","title":"Stalled tool","projectId":"b","state":"working","attentionReason":{"kind":"tool_stall"}}),
        json!({"id":"failed","title":"Check failed build","projectId":"a","state":"failed"}),
        json!({"id":"coord","title":"Mission coordinator chat","projectId":"a","state":"idle","missionCoordinator":true}),
        json!({"id":"member","title":"Mission member chat","projectId":"a","state":"idle","missionId":"m1"}),
        json!({"id":"idle1","title":"Review package","projectId":"b","state":"idle"}),
        json!({"id":"idle2","title":format!("Résumé {}","naïve café ".repeat(5)),"projectId":"a","state":"idle"}),
    ]
    .iter()
    .map(|x| crate::local_model::chat(x).unwrap())
    .collect::<Vec<_>>();
    let (h, v) = cx
        .update(|cx| {
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
                |w, cx| {
                    cx.new(|cx| {
                        let mut v = LocalViewer::preview(PreviewState::Conversation, w, cx);
                        v.client = Some(client);
                        v.writer = Some(writer.clone());
                        v.editor.update(cx, |e, cx| e.shell_probe_setup(writer, w, cx));
                        v.state.loaded = true;
                        v.state.list_loaded = true;
                        v.state.projects_loaded = true;
                        v.state.projects = Arc::new(
                            crate::local_model::projects(&json!([
                                {"id":"a","name":"Atlas","path":"/synthetic/a"},
                                {"id":"b","name":format!("Boreal {}","projet très long ".repeat(3)),"path":"/synthetic/b"}
                            ]))
                            .unwrap(),
                        );
                        v.state.chats = Arc::new(chats);
                        v.rebuild_nav(w, cx);
                        v
                    })
                },
            )
        })
        .unwrap();
    cx.update_window(h, |_, w, _| w.activate_window()).unwrap();
    settle(cx, h);
    let name = |suffix: &str| format!("{}-{}-rows{suffix}.png", width as u32, mode.name());
    capture(cx, h, captures, name(""));
    // Every chat stays listed, including mission chats; the sidebar has no
    // per-mission rows, only the Missions entry.
    cx.update_window(h, |_, w, _| {
        let rows = [
            "synthetic",
            "working2",
            "jobs",
            "stall",
            "failed",
            "coord",
            "member",
            "idle1",
            "idle2",
        ]
        .map(|id| w.find(format!("chat-row-{id}")).bounds());
        for row in &rows[1..] {
            assert_eq!(row.size.height, rows[0].size.height, "one row rhythm");
        }
        for id in ["synthetic", "stall", "idle1"] {
            let scope = SharedString::from(format!("chat-row-{id}"));
            let title = w.within(scope.clone()).find("sidebar-chat-title").bounds();
            let detail = w.within(scope.clone()).find("sidebar-chat-detail").bounds();
            assert!(
                detail.top() >= title.bottom() && detail.top() - title.bottom() <= px(3.),
                "{id}: metadata sits right under its title"
            );
        }
        let stray: Vec<String> = w
            .within("chat-sidebar")
            .elements()
            .iter()
            .flat_map(|e| {
                e.path()
                    .iter()
                    .map(|id| format!("{id:?}"))
                    .collect::<Vec<_>>()
            })
            .filter(|id| id.to_lowercase().contains("mission") && !id.contains("nav-missions"))
            .collect();
        assert!(stray.is_empty(), "no per-mission sidebar rows: {stray:?}");
        assert!(w.try_find("nav-missions").is_some());
    })
    .unwrap();
    // Row actions: hidden at rest, shown on hover, hidden again after.
    let menu = |cx: &mut HeadlessAppContext| {
        let bounds = cx
            .update_window(h, |_, w, _| w.find("chat-menu-idle1").bounds())
            .unwrap();
        let image = cx.capture_screenshot(h).unwrap();
        painted(&image, bounds, image.width() as f32 / width)
    };
    assert_eq!(menu(cx), 0, "row actions hidden at rest");
    cx.update_window(h, |_, w, cx| w.hover("chat-row-idle1", cx))
        .unwrap();
    settle(cx, h);
    assert!(menu(cx) > 0, "row actions revealed on hover");
    capture(cx, h, captures, name("-hover"));
    cx.update_window(h, |_, w, cx| w.hover("nav-home", cx))
        .unwrap();
    settle(cx, h);
    assert_eq!(menu(cx), 0, "row actions hide when the pointer leaves");
    // Keyboard: arrows through the focused list reveal the selected row's actions.
    let target = cx.update(|cx| v.read(cx).chats.read(cx).delegate().index("idle1").unwrap());
    cx.update_window(h, |_, w, cx| {
        v.update(cx, |v, cx| v.chats.update(cx, |l, cx| l.focus(w, cx)));
        for _ in 0..12 {
            if v.read(cx).chats.read(cx).delegate().selected == Some(target) {
                break;
            }
            w.press("down", cx);
        }
    })
    .unwrap();
    settle(cx, h);
    assert_eq!(
        cx.update(|cx| v.read(cx).chats.read(cx).delegate().selected),
        Some(target)
    );
    assert!(
        menu(cx) > 0,
        "row actions revealed for the keyboard selection"
    );
    capture(cx, h, captures, name("-keyboard"));
    // Reduced motion paints the same rows and corners without a clock.
    cx.update(|cx| cx.set_reduce_motion(true));
    cx.update_window(h, |_, w, cx| w.hover("nav-home", cx))
        .unwrap();
    settle(cx, h);
    capture(cx, h, captures, name("-reduced"));
    cx.update(|cx| cx.set_reduce_motion(false));
    // Missions by Command-3 and by pointer keeps the project scope and the draft.
    let draft = "Unsent sidebar draft 私 👩‍💻";
    cx.update_window(h, |_, w, cx| {
        let input = v.read(cx).editor.read(cx).shell_probe().0;
        input.update(cx, |i, cx| i.focus(w, cx));
        w.input(draft, cx);
        v.update(cx, |v, cx| v.show_project("a".into(), w, cx));
    })
    .unwrap();
    settle(cx, h);
    for route in ["keyboard", "pointer"] {
        cx.update_window(h, |_, w, cx| {
            if route == "keyboard" {
                w.press("secondary-3", cx);
            } else {
                w.click("nav-missions", cx);
            }
        })
        .unwrap();
        settle(cx, h);
        cx.update_window(h, |_, w, cx| {
            let view = v.read(cx);
            assert_eq!(view.page, Page::Missions, "{route} reaches the browser");
            assert_eq!(
                view.project_scope.as_deref(),
                Some("a"),
                "{route} keeps scope"
            );
            assert_eq!(view.chats.read(cx).delegate().project.as_deref(), Some("a"));
            assert_eq!(
                view.editor
                    .read(cx)
                    .shell_probe()
                    .0
                    .read(cx)
                    .value()
                    .as_ref(),
                draft,
                "{route} keeps the draft"
            );
            w.press("secondary-[", cx);
        })
        .unwrap();
        settle(cx, h);
        assert!(cx.update(|cx| matches!(&v.read(cx).page, Page::Project(id) if id == "a")));
    }
    println!(
        "{}",
        json!({"width":width,"mode":mode.name(),"sidebar_rows":true,"uniform_rows":true,"no_mission_enumeration":true,"hover_and_keyboard_reveal":true,"missions_keyboard_and_pointer_keep_scope_and_draft":true})
    );
    cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
    cx.run_until_parked();
}
