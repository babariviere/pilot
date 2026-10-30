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
                header_layout(cx, h, &v, width, &captures, mode.name());
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
    if !baseline {
        sidebar_resize(cx, &captures);
    }
}

/// Drag the sidebar's edge: its limits, clamping to the window, focus left
/// alone, the double-click default and the private file across a restart.
/// Headless windows can't be resized in place, so each window size reopens on
/// the same file; the clamp is the same per-frame viewport computation.
fn sidebar_resize(cx: &mut HeadlessAppContext, captures: &Option<std::path::PathBuf>) {
    use gpui_kit::{InputEvent, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, point};
    cx.update(|cx| Theme::change(ThemeMode::Light, None, cx));
    let dir =
        std::env::temp_dir().join(format!("pilot-next-sidebar-width-{}", uuid::Uuid::new_v4()));
    let path = dir.join(crate::sidebar_memory::FILE);
    let open = |cx: &mut HeadlessAppContext, window: f32| {
        let path = path.clone();
        let (h, v) = cx.update(|cx| {
            gpui_kit::open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                        Default::default(),
                        size(px(window), px(760.)),
                    ))),
                    show: false,
                    focus: false,
                    ..Default::default()
                },
                cx,
                |w, cx| {
                    cx.new(|cx| {
                        let mut v = LocalViewer::preview(PreviewState::Conversation, w, cx);
                        v.load_sidebar_memory(path, w, cx);
                        v.rebuild_nav(w, cx);
                        v
                    })
                },
            )
            .unwrap()
        });
        settle(cx, h);
        (h, v)
    };
    let width = |cx: &mut HeadlessAppContext, h: gpui_kit::AnyWindowHandle| {
        cx.update_window(h, |_, w, cx| {
            w.render_frame(cx);
            let sidebar = w.find("chat-sidebar").bounds();
            let main = w.find("conversation").bounds();
            assert!(
                (main.left() - sidebar.right()).abs() < px(0.5),
                "the conversation starts at the edge"
            );
            assert!(
                w.find("nav-home").bounds().right() <= sidebar.right(),
                "rows follow the edge"
            );
            f32::from(sidebar.size.width)
        })
        .unwrap()
    };
    let send = |cx: &mut HeadlessAppContext,
                h: gpui_kit::AnyWindowHandle,
                event: gpui_kit::PlatformInput| {
        cx.update_window(h, |_, w, cx| {
            w.dispatch_event(event, cx);
            w.render_frame(cx);
        })
        .unwrap();
        cx.run_until_parked();
    };
    let y = px(400.);
    let press = |x: f32, click_count| {
        MouseDownEvent {
            button: MouseButton::Left,
            position: point(px(x), y),
            modifiers: Default::default(),
            click_count,
            first_mouse: false,
        }
        .to_platform_input()
    };
    let release = |x: f32, click_count| {
        MouseUpEvent {
            button: MouseButton::Left,
            position: point(px(x), y),
            modifiers: Default::default(),
            click_count,
        }
        .to_platform_input()
    };
    let hover = |x: f32, pressed| {
        MouseMoveEvent {
            position: point(px(x), y),
            pressed_button: pressed,
            modifiers: Default::default(),
        }
        .to_platform_input()
    };
    // Grab the band 2pt inside the edge, then move in steps, as a pointer would.
    let drag = |cx: &mut HeadlessAppContext, h, to: f32| {
        let edge = width(cx, h) - 2.;
        send(cx, h, hover(edge, None));
        send(cx, h, press(edge, 1));
        for step in 1..=4 {
            send(
                cx,
                h,
                hover(
                    edge + (to - edge) * step as f32 / 4.,
                    Some(MouseButton::Left),
                ),
            );
        }
        send(cx, h, release(to, 1));
    };
    let saved = |want: Option<f32>| {
        crate::sidebar_memory::read(&path).is_some_and(|s| s.sidebar_width == want)
    };
    let wait_for = |cx: &mut HeadlessAppContext, want: Option<f32>| {
        for _ in 0..200 {
            cx.advance_clock(Duration::from_millis(50));
            cx.run_until_parked();
            if saved(want) {
                return;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        panic!("the sidebar width {want:?} was not saved");
    };

    let close = |cx: &mut HeadlessAppContext, h: gpui_kit::AnyWindowHandle| {
        cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
        cx.run_until_parked();
    };

    let (h, v) = open(cx, 1100.);
    assert_eq!(width(cx, h), 232., "the responsive default until you drag");
    // Focus stays in the composer while the edge is dragged.
    let focused = cx
        .update_window(h, |_, w, cx| {
            v.update(cx, |v, cx| v.editor.update(cx, |e, cx| e.focus(w, cx)));
            w.focused(cx)
        })
        .unwrap();
    assert!(focused.is_some());
    drag(cx, h, 300.);
    assert_eq!(width(cx, h), 300.);
    cx.update_window(h, |_, w, cx| {
        assert_eq!(w.focused(cx), focused, "dragging never moves focus")
    })
    .unwrap();
    // Hovering the edge shows the indicator; capture it for review.
    send(cx, h, hover(298., None));
    settle(cx, h);
    capture(cx, h, captures, "1100-light-sidebar-resized.png".into());
    drag(cx, h, 2000.);
    assert_eq!(width(cx, h), 400., "the widest sidebar");
    drag(cx, h, 40.);
    assert_eq!(width(cx, h), 184., "the narrowest sidebar");
    drag(cx, h, 360.);
    assert_eq!(width(cx, h), 360.);
    wait_for(cx, Some(360.));
    close(cx, h);

    // A narrower window narrows the sidebar so the conversation keeps 480pt,
    // without rewriting your width.
    let (h, _) = open(cx, 700.);
    assert_eq!(width(cx, h), 220.);
    close(cx, h);
    let (h, _) = open(cx, 640.);
    assert_eq!(width(cx, h), 184., "never below the narrowest sidebar");
    close(cx, h);
    assert!(saved(Some(360.)), "a window size never rewrites your width");

    // A wide window after a restart brings it back from the same private file.
    let (h, _) = open(cx, 1100.);
    assert_eq!(width(cx, h), 360.);
    // Double-click restores the default.
    let edge = 358.;
    send(cx, h, hover(edge, None));
    for click_count in [1, 2] {
        send(cx, h, press(edge, click_count));
        send(cx, h, release(edge, click_count));
    }
    assert_eq!(width(cx, h), 232.);
    wait_for(cx, None);
    close(cx, h);
    // Dragging in a narrow window stops where the conversation keeps 480pt.
    let (h, _) = open(cx, 700.);
    assert_eq!(width(cx, h), 184.);
    drag(cx, h, 600.);
    assert_eq!(width(cx, h), 220.);
    close(cx, h);
    std::fs::remove_dir_all(&dir).unwrap();
    println!(
        "{}",
        json!({"sidebar_resize":{"default":232,"min":184,"max":400,"window_clamp":[220,184],"restored":360,"double_click_default":232}})
    );
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
    let pane = w.find("chat-list-pane").bounds();
    let first = ["synthetic", "other", "failed"]
        .into_iter()
        .filter_map(|id| {
            w.try_find(format!("chat-row-{id}"))
                .map(|row| row.bounds().top())
        })
        .min_by(|a, b| a.partial_cmp(b).unwrap())
        .unwrap();
    assert!(
        first - pane.top() < px(64.),
        "no reserved search field above chats"
    );
    let title = w
        .within("chat-row-synthetic")
        .find("sidebar-chat-title")
        .bounds();
    let detail = w
        .within("chat-row-synthetic")
        .find("sidebar-chat-detail")
        .bounds();
    // Row action buttons are built on hover or selection; their slot holds the column.
    let menu = w.find("chat-menu-slot-synthetic").bounds();
    let compose = w.find("new-local-chat").bounds();
    let filter = w.find("chat-filters").bounds();
    assert!(
        (title.left() - leading).abs() < px(0.5) && title.left() == detail.left(),
        "chat text has no phantom icon column"
    );
    assert!(
        title.right() <= menu.left()
            && menu.right() <= right
            && row.size.height >= px(super::sidebar_list::TWO_LINE_HEIGHT)
    );
    assert!(
        (menu.center().x - compose.center().x).abs() < px(0.5)
            && (filter.center().x - compose.center().x).abs() < px(0.5),
        "common trailing action column"
    );
    for bounds in [compose, filter] {
        assert_eq!(bounds.size, size(w.rem_size() * 2., w.rem_size() * 2.));
    }
    assert_eq!(menu.size.width, w.rem_size() * 2.);
    // Usage and Settings are footer icon actions in the Command Palette row.
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
            assert!(v.read(cx).chats.focus_handle(cx).is_focused(w));
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

/// Title sits over the project subtitle, the stack is centred in the row and
/// each line truncates on its own, including long Unicode titles and chats
/// without a project.
fn header_layout(
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
    let stacked = |header: Bounds<Pixels>,
                   title: Bounds<Pixels>,
                   meta: Bounds<Pixels>,
                   action: Bounds<Pixels>| {
        println!(
            "{}",
            json!({"header_stack": [f32::from(title.top()), f32::from(title.bottom()), f32::from(meta.top()), f32::from(meta.bottom())], "width": width})
        );
        assert!(
            title.bottom() <= meta.top() && (title.left() - meta.left()).abs() <= px(0.5),
            "project subtitle sits under the title: {title:?} {meta:?}"
        );
        assert!(
            title.top() >= header.top()
                && meta.bottom() <= header.bottom()
                && ((title.top() + meta.bottom()) / 2. - header.center().y).abs() <= px(1.),
            "title and subtitle are centred in the row: {header:?} {title:?} {meta:?}"
        );
        assert!(title.right() <= action.left() && meta.right() <= action.left());
    };
    let (header, title, meta, action) = found(cx);
    let meta = meta.expect("project subtitle is shown");
    stacked(header, title, meta, action);

    // Long Unicode title: it truncates before the actions, the project stays whole.
    let restore = cx.update(|cx| v.read(cx).title.clone());
    let meta_width = meta.size.width;
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
    let meta = meta.expect("project subtitle stays under a long title");
    stacked(header, title, meta, action);
    assert_eq!(
        meta.size.width, meta_width,
        "a long title never squeezes the project"
    );

    // No project: the title alone, vertically centred in the row.
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
    assert!(meta.is_none(), "no empty subtitle without a project");
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

/// Pixels that differ between two captures of the same window within bounds.
fn changed(
    a: &image::RgbaImage,
    b: &image::RgbaImage,
    bounds: Bounds<gpui_kit::Pixels>,
    scale: f32,
) -> usize {
    let (x0, y0) = (
        (f32::from(bounds.left()) * scale).ceil() as u32,
        (f32::from(bounds.top()) * scale).ceil() as u32,
    );
    let (x1, y1) = (
        (f32::from(bounds.right()) * scale).floor() as u32,
        (f32::from(bounds.bottom()) * scale).floor() as u32,
    );
    (y0..y1)
        .flat_map(|y| (x0..x1).map(move |x| (x, y)))
        .filter(|&(x, y)| {
            let (p, q) = (a.get_pixel(x, y).0, b.get_pixel(x, y).0);
            (0..3).map(|c| p[c].abs_diff(q[c]) as u32).sum::<u32>() > 24
        })
        .count()
}

/// Pixels in `bounds` with the sky accent's hue (blue well above red, green
/// between). Neutral metadata, titles and row washes have none in either mode.
fn sky(image: &image::RgbaImage, bounds: Bounds<gpui_kit::Pixels>, scale: f32) -> usize {
    let (x0, y0) = (
        (f32::from(bounds.left()) * scale).ceil() as u32,
        (f32::from(bounds.top()) * scale).ceil() as u32,
    );
    let (x1, y1) = (
        (f32::from(bounds.right()) * scale).floor() as u32,
        (f32::from(bounds.bottom()) * scale).floor() as u32,
    );
    (y0..y1)
        .flat_map(|y| (x0..x1).map(move |x| (x, y)))
        .filter(|&(x, y)| {
            let [r, g, b, _] = image.get_pixel(x, y).0.map(i32::from);
            b - r > 45 && r < g && g < b
        })
        .count()
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
        json!({"id":"stall","title":"Stalled tool","projectId":"b","state":"working","attentionReason":{"kind":"tool_stall"},"missionId":"mission-B"}),
        json!({"id":"failed","title":"Check failed build","projectId":"a","state":"failed","missionId":"missing"}),
        json!({"id":"coord","title":"Mission coordinator chat","projectId":"a","state":"idle","missionId":"mission-A","missionCoordinator":true}),
        json!({"id":"member","title":"Mission member chat","projectId":"a","state":"idle","missionId":"mission-A"}),
        json!({"id":"idle1","title":"Review package","projectId":"b","state":"idle"}),
        json!({"id":"idle2","title":format!("Résumé {}","naïve café ".repeat(5)),"projectId":"a","state":"idle","missionId":{}}),
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
    // The tree (mission threads) is covered by the style probe. These checks
    // read search results, which list every chat flat with its mission
    // caption: every fixture title contains "a".
    cx.update_window(h, |_, w, cx| {
        v.update(cx, |v, cx| {
            v.chats.update(cx, |l, cx| l.set_query("a", w, cx))
        });
    })
    .unwrap();
    settle(cx, h);
    capture(cx, h, captures, name("-search"));
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
            .filter(|id| {
                id.to_lowercase().contains("mission")
                    && !id.contains("nav-missions")
                    && !id.contains("chat-mission-")
            })
            .collect();
        assert!(stray.is_empty(), "no per-mission sidebar rows: {stray:?}");
        assert!(w.try_find("nav-missions").is_some());
    })
    .unwrap();
    // Association is summary-owned. Cache updates only enrich the name, never
    // create membership, and preserve the selected row and existing geometry.
    let association = |cx: &mut HeadlessAppContext, id: &str| {
        cx.update_window(h, |_, w, _| {
            w.within(SharedString::from(format!("chat-row-{id}")))
                .try_find("chat-mission-mark")
                .map(|m| (m.label().unwrap().to_owned(), m.bounds()))
        })
        .unwrap()
    };
    // Member Map, coordinator Compass, malformed metadata Info.
    let glyph = |cx: &mut HeadlessAppContext, id: &str, icon: crate::app_icon::AppIcon| {
        cx.update_window(h, |_, w, _| {
            w.within(SharedString::from(format!("chat-row-{id}")))
                .try_find(format!("chat-mission-glyph-{icon:?}"))
                .is_some()
        })
        .unwrap()
    };
    use crate::app_icon::AppIcon::{Coordinator, Info, Mission};
    // Sky-accent pixel counts on a row's mission glyph and name, its title and
    // its project. Only the coordinator's Compass and mission name are accented.
    let accents = |cx: &mut HeadlessAppContext, id: &str| {
        let bounds = cx
            .update_window(h, |_, w, _| {
                let scope = w.within(SharedString::from(format!("chat-row-{id}")));
                let glyph = [Coordinator, Mission, Info]
                    .iter()
                    .find_map(|i| scope.try_find(format!("chat-mission-glyph-{i:?}")))
                    .map(|g| g.bounds());
                [
                    glyph,
                    scope.try_find("chat-mission-name").map(|n| n.bounds()),
                    Some(scope.find("sidebar-chat-title").bounds()),
                    scope.try_find("sidebar-chat-project").map(|p| p.bounds()),
                ]
            })
            .unwrap();
        let image = cx.capture_screenshot(h).unwrap();
        let scale = image.width() as f32 / width;
        bounds.map(|b| b.map_or(0, |b| sky(&image, b, scale)))
    };
    assert!(association(cx, "idle1").is_none());
    assert_eq!(
        association(cx, "idle2").unwrap().0,
        "Mission association unavailable"
    );
    assert!(glyph(cx, "idle2", Info) && !glyph(cx, "idle2", Mission));
    assert_eq!(
        association(cx, "coord").unwrap().0,
        "Coordinator · Mission linked · name unavailable"
    );
    assert!(glyph(cx, "coord", Coordinator) && !glyph(cx, "coord", Mission));
    assert_eq!(
        association(cx, "failed").unwrap().0,
        "Mission linked · name unavailable"
    );
    assert!(glyph(cx, "failed", Mission) && glyph(cx, "member", Mission));
    // The name sits on the metadata line, after project and state; the title
    // and menu slot keep their places.
    // `named`: the cached catalog names the linked missions.
    let mission_line = |cx: &mut HeadlessAppContext, named: bool| {
        for id in ["member", "coord", "failed", "stall", "idle2"] {
            // The narrow window lists fewer rows than this: bring each target
            // into the sidebar viewport before reading its bounds and pixels.
            cx.update_window(h, |_, w, cx| {
                let ix = v.read(cx).chats.read(cx).delegate().index(id).unwrap();
                v.update(cx, |v, cx| {
                    v.chats.update(cx, |l, cx| {
                        l.scroll_to_item(ix, gpui_kit::ScrollStrategy::Center, w, cx)
                    })
                });
            })
            .unwrap();
            settle(cx, h);
            let (name, project) = cx
                .update_window(h, |_, w, _| {
                    let list = w.find("chat-list-pane").bounds();
                    let scope = w.within(SharedString::from(format!("chat-row-{id}")));
                    let title = scope.find("sidebar-chat-title").bounds();
                    let detail = scope.find("sidebar-chat-detail").bounds();
                    let mark = scope.find("chat-mission-mark").bounds();
                    let name = scope.find("chat-mission-name").bounds();
                    let menu = scope.find(format!("chat-menu-slot-{id}")).bounds();
                    assert!(title.right() <= menu.left(), "{id}: title before menu");
                    assert!(
                        mark.top() >= title.bottom()
                            && mark.left() >= detail.left()
                            && mark.right() <= detail.right() + px(0.5),
                        "{id}: mission on the metadata line"
                    );
                    // Linked rows keep their project and state beside the name.
                    let project = ["failed", "stall"].contains(&id).then(|| {
                        let project = scope.find("sidebar-chat-project").bounds();
                        let state = scope.find("sidebar-chat-state").bounds();
                        assert!(
                            project.size.width >= px(28.) - px(0.5),
                            "{id}: project start stays readable"
                        );
                        assert!(
                            state.size.width > px(0.)
                                && project.right() <= state.left()
                                && state.right() <= mark.left() + px(0.5),
                            "{id}: project, state, then mission"
                        );
                        project
                    });
                    assert!(name.size.width >= w.rem_size(), "{id}: name stays visible");
                    assert!(
                        name.top() >= list.top() && name.bottom() <= list.bottom(),
                        "{id}: sampled inside the sidebar viewport"
                    );
                    (name, project)
                })
                .unwrap();
            let image = cx.capture_screenshot(h).unwrap();
            assert!(
                painted(&image, name, image.width() as f32 / width) > 0,
                "{id}: mission name painted"
            );
            if let Some(project) = project {
                assert!(
                    painted(&image, project, image.width() as f32 / width) > 0,
                    "{id}: project painted"
                );
            }
            let [glyph, name, title, project] = accents(cx, id);
            assert_eq!(title, 0, "{id}: title stays neutral");
            assert_eq!(project, 0, "{id}: project stays neutral");
            if id == "coord" {
                assert!(glyph > 0, "{id}: Compass takes the accent");
                assert_eq!(
                    name > 0,
                    named,
                    "{id}: only a real mission name is accented"
                );
            } else {
                assert_eq!(glyph, 0, "{id}: member Map and Info stay neutral");
                // The long catalog name for stall carries a colour emoji.
                if !(named && id == "stall") {
                    assert_eq!(name, 0, "{id}: member name stays neutral");
                }
            }
        }
        // An ordinary row has no accent anywhere.
        cx.update_window(h, |_, w, cx| {
            let ix = v.read(cx).chats.read(cx).delegate().index("idle1").unwrap();
            v.update(cx, |v, cx| {
                v.chats.update(cx, |l, cx| {
                    l.scroll_to_item(ix, gpui_kit::ScrollStrategy::Center, w, cx)
                })
            });
        })
        .unwrap();
        settle(cx, h);
        assert_eq!(accents(cx, "idle1"), [0; 4], "ordinary row stays neutral");
        // Back to the top, where the following checks and captures start.
        cx.update_window(h, |_, w, cx| {
            v.update(cx, |v, cx| {
                v.chats.update(cx, |l, cx| {
                    l.scroll_to_item(
                        gpui_kit::component::IndexPath::new(0),
                        gpui_kit::ScrollStrategy::Top,
                        w,
                        cx,
                    )
                })
            });
        })
        .unwrap();
        settle(cx, h);
    };
    mission_line(cx, false);
    // Existing cached catalog, not a new per-row request. Same ID at another
    // home is not allowed to name a Local association.
    let long = format!("Release {}", "長いミッション名 👩‍💻 ".repeat(4));
    cx.update_window(h, |_, _, cx| {
        v.update(cx, |v, cx| {
            v.missions.update(cx, |b, cx| {
                b.options(crate::LocalOptions::synthetic(1));
                let mut catalog =
                    crate::mission_browser::catalog(&crate::mission_browser_fixture::catalog())
                        .unwrap();
                catalog
                    .rows
                    .iter_mut()
                    .filter(|r| r.key == crate::mission_browser_fixture::key("mission-B"))
                    .for_each(|r| r.title = long.clone());
                b.catalog = Some(Arc::new(catalog));
                cx.notify();
            });
        })
    })
    .unwrap();
    settle(cx, h);
    assert_eq!(
        association(cx, "member").unwrap().0,
        "Mission: Same mission 日本語"
    );
    assert_eq!(
        association(cx, "coord").unwrap().0,
        "Coordinator · Mission: Same mission 日本語"
    );
    // A long name beside a long project and state still shows its start.
    assert_eq!(
        association(cx, "stall").unwrap().0,
        format!("Mission: {long}")
    );
    mission_line(cx, true);
    capture(cx, h, captures, name("-mission-names"));
    cx.update_window(h, |_, _, cx| {
        v.update(cx, |v, cx| {
            v.missions.update(cx, |b, cx| {
                let mut catalog = b.catalog.as_ref().unwrap().as_ref().clone();
                catalog
                    .rows
                    .iter_mut()
                    .filter(|r| r.key == crate::mission_browser_fixture::key("mission-A"))
                    .for_each(|r| r.title = "Renamed mission".into());
                b.catalog = Some(Arc::new(catalog));
                cx.notify();
            });
        })
    })
    .unwrap();
    settle(cx, h);
    assert_eq!(
        association(cx, "member").unwrap().0,
        "Mission: Renamed mission"
    );
    // Pointer tooltip uses the same full name as the keyboard row label.
    cx.update_window(h, |_, w, cx| {
        w.within("chat-row-member").hover("chat-mission-mark", cx);
    })
    .unwrap();
    cx.advance_clock(Duration::from_secs(1));
    settle(cx, h);
    cx.update_window(h, |_, w, _| {
        assert_eq!(
            w.find("chat-mission-tooltip").label(),
            Some("Mission: Renamed mission")
        );
    })
    .unwrap();
    capture(cx, h, captures, name("-mission-tooltip"));
    let member = cx.update(|cx| {
        v.read(cx)
            .chats
            .read(cx)
            .delegate()
            .index("member")
            .unwrap()
    });
    cx.update_window(h, |_, w, cx| {
        w.hover("nav-home", cx);
        v.update(cx, |v, cx| v.chats.update(cx, |l, cx| l.focus(w, cx)));
        for _ in 0..12 {
            if v.read(cx).chats.read(cx).delegate().selected == Some(member) {
                break;
            }
            w.press("down", cx);
        }
        assert_eq!(v.read(cx).chats.read(cx).delegate().selected, Some(member));
        assert!(
            w.find("member")
                .label()
                .unwrap()
                .contains("Mission: Renamed mission")
        );
    })
    .unwrap();
    settle(cx, h);
    assert!(
        cx.update_window(h, |_, w, _| w.find("chat-menu-member").visible())
            .unwrap()
    );
    // A summary role change swaps Map and Compass on the same row.
    let set_role = |cx: &mut HeadlessAppContext, coordinator: bool| {
        cx.update_window(h, |_, w, cx| {
            v.update(cx, |v, cx| {
                let mut chats = v.state.chats.as_ref().clone();
                chats
                    .iter_mut()
                    .find(|c| c.id == "member")
                    .unwrap()
                    .mission_coordinator = coordinator;
                v.state.chats = Arc::new(chats);
                v.rebuild_nav(w, cx);
            })
        })
        .unwrap();
        settle(cx, h);
    };
    set_role(cx, true);
    assert_eq!(
        association(cx, "member").unwrap().0,
        "Coordinator · Mission: Renamed mission"
    );
    assert!(glyph(cx, "member", Coordinator) && !glyph(cx, "member", Mission));
    // On the keyboard-selected row the Compass and name keep the accent, and
    // the title stays neutral; the change of role takes the accent away again.
    let [compass, mission, title, _] = accents(cx, "member");
    assert!(
        compass > 0 && mission > 0 && title == 0,
        "selected coordinator mark"
    );
    capture(cx, h, captures, name("-coordinator-selected"));
    set_role(cx, false);
    assert_eq!(
        association(cx, "member").unwrap().0,
        "Mission: Renamed mission"
    );
    assert!(glyph(cx, "member", Mission) && !glyph(cx, "member", Coordinator));
    assert_eq!(
        accents(cx, "member")[..2],
        [0, 0],
        "member mark stays neutral"
    );
    // Disconnect retains the last known name; reconnect uses the new summary.
    cx.update_window(h, |_, w, cx| {
        v.update(cx, |v, cx| {
            v.state.status = "Disconnected".into();
            v.rebuild_nav(w, cx);
        })
    })
    .unwrap();
    settle(cx, h);
    assert_eq!(
        association(cx, "member").unwrap().0,
        "Mission (last known): Renamed mission"
    );
    assert_eq!(
        association(cx, "coord").unwrap().0,
        "Coordinator · Mission (last known): Renamed mission"
    );
    // Reconnected summary replaces the old membership. Preserve row identity.
    cx.update_window(h, |_, w, cx| {
        v.update(cx, |v, cx| {
            v.state.status = "Synthetic reconnected".into();
            let mut chats = v.state.chats.as_ref().clone();
            chats.iter_mut().find(|c| c.id == "member").unwrap().mission =
                crate::local_model::MissionAssociation::Unlinked;
            v.state.chats = Arc::new(chats);
            v.rebuild_nav(w, cx);
        })
    })
    .unwrap();
    settle(cx, h);
    assert!(association(cx, "member").is_none());
    assert_eq!(
        association(cx, "coord").unwrap().0,
        "Coordinator · Mission: Renamed mission"
    );
    assert!(glyph(cx, "coord", Coordinator));
    // The session socket's mission list names rows without opening Missions,
    // wins over the lazily read catalog, follows renames, and leaves a mission
    // it doesn't list honestly unavailable. Large lists are not capped.
    let set_titles = |cx: &mut HeadlessAppContext, renamed: &str, status: &str| {
        let mut titles: std::collections::HashMap<String, String> = (0..2000)
            .map(|i| (format!("listed-{i}"), format!("Listed {i}")))
            .collect();
        titles.insert("mission-A".into(), renamed.into());
        cx.update_window(h, |_, w, cx| {
            v.update(cx, |v, cx| {
                v.state.mission_titles = Some(Arc::new(titles));
                v.state.status = status.into();
                v.rebuild_nav(w, cx);
            })
        })
        .unwrap();
        settle(cx, h);
    };
    set_titles(cx, "Live mission 日本語", "Synthetic reconnected");
    assert_eq!(
        association(cx, "coord").unwrap().0,
        "Coordinator · Mission: Live mission 日本語"
    );
    for id in ["stall", "failed"] {
        assert_eq!(
            association(cx, id).unwrap().0,
            "Mission linked · name unavailable",
            "{id}: unlisted mission, even with a cached catalog name"
        );
    }
    set_titles(cx, "Renamed live", "Synthetic reconnected");
    assert_eq!(
        association(cx, "coord").unwrap().0,
        "Coordinator · Mission: Renamed live"
    );
    set_titles(cx, "Renamed live", "Disconnected");
    assert_eq!(
        association(cx, "coord").unwrap().0,
        "Coordinator · Mission (last known): Renamed live"
    );
    set_titles(cx, "Renamed live", "Synthetic reconnected");
    // Hovering the link underlines the name only: never the separator or the
    // Compass. Both captures hover the same row, so the row wash matches.
    cx.update_window(h, |_, w, cx| {
        let ix = v.read(cx).chats.read(cx).delegate().index("coord").unwrap();
        v.update(cx, |v, cx| {
            v.chats.update(cx, |l, cx| {
                l.scroll_to_item(ix, gpui_kit::ScrollStrategy::Center, w, cx)
            })
        });
    })
    .unwrap();
    settle(cx, h);
    let link_parts = |cx: &mut HeadlessAppContext| {
        cx.update_window(h, |_, w, _| {
            let scope = w.within("chat-row-coord");
            let mark = scope.find("chat-mission-mark").bounds();
            let glyph = scope.find("chat-mission-glyph-Coordinator").bounds();
            let name = scope.find("chat-mission-name").bounds();
            let separator =
                Bounds::from_corners(mark.origin, gpui_kit::point(glyph.left(), mark.bottom()));
            [separator, glyph, name]
        })
        .unwrap()
    };
    let parts = link_parts(cx);
    assert!(
        parts[0].size.width > px(2.),
        "segment starts with its separator"
    );
    cx.update_window(h, |_, w, cx| {
        w.within("chat-row-coord").hover("sidebar-chat-title", cx)
    })
    .unwrap();
    settle(cx, h);
    let rest = cx.capture_screenshot(h).unwrap();
    cx.update_window(h, |_, w, cx| {
        w.within("chat-row-coord").hover("chat-mission-name", cx)
    })
    .unwrap();
    settle(cx, h);
    let hovered = cx.capture_screenshot(h).unwrap();
    let scale = rest.width() as f32 / width;
    let [separator, compass, underline] = parts.map(|b| changed(&rest, &hovered, b, scale));
    assert!(underline > 0, "hovered mission name underlines");
    assert_eq!(
        (separator, compass),
        (0, 0),
        "separator and Compass never underline"
    );
    capture(cx, h, captures, name("-mission-link-hover"));
    // Keyboard focus on the link (Tab from its selected row) underlines the
    // same text only.
    let coord = cx.update(|cx| v.read(cx).chats.read(cx).delegate().index("coord").unwrap());
    cx.update_window(h, |_, w, cx| {
        w.hover("nav-home", cx);
        v.update(cx, |v, cx| v.chats.update(cx, |l, cx| l.focus(w, cx)));
        for _ in 0..12 {
            let selected = v.read(cx).chats.read(cx).delegate().selected;
            if selected == Some(coord) {
                break;
            }
            w.press(
                if selected.is_some_and(|s| (s.section, s.row) > (coord.section, coord.row)) {
                    "up"
                } else {
                    "down"
                },
                cx,
            );
        }
        assert_eq!(v.read(cx).chats.read(cx).delegate().selected, Some(coord));
    })
    .unwrap();
    settle(cx, h);
    let parts = link_parts(cx);
    let selected = cx.capture_screenshot(h).unwrap();
    let mut reached = false;
    for _ in 0..6 {
        cx.update_window(h, |_, w, cx| w.press("tab", cx)).unwrap();
        settle(cx, h);
        if cx
            .update_window(h, |_, w, _| {
                w.find("chat-mission-link-coord").focused() == Some(true)
            })
            .unwrap()
        {
            reached = true;
            break;
        }
    }
    assert!(reached, "Tab reaches the selected row's mission link");
    let focused = cx.capture_screenshot(h).unwrap();
    let [separator, compass, underline] = parts.map(|b| changed(&selected, &focused, b, scale));
    assert!(underline > 0, "keyboard-focused mission name underlines");
    assert_eq!(
        (separator, compass),
        (0, 0),
        "focus underline stays on the name"
    );
    capture(cx, h, captures, name("-mission-link-focus"));
    cx.update_window(h, |_, w, cx| {
        v.update(cx, |v, cx| {
            v.chats.update(cx, |l, cx| {
                l.focus(w, cx);
                l.scroll_to_item(
                    gpui_kit::component::IndexPath::new(0),
                    gpui_kit::ScrollStrategy::Top,
                    w,
                    cx,
                )
            })
        });
    })
    .unwrap();
    settle(cx, h);
    // Row actions: not built at rest, built and shown on hover, gone again after.
    let built = |cx: &mut HeadlessAppContext| {
        cx.update_window(h, |_, w, _| w.try_find("chat-menu-idle1").is_some())
            .unwrap()
    };
    let slot = cx
        .update_window(h, |_, w, _| w.find("chat-menu-slot-idle1").bounds())
        .unwrap();
    let menu = |cx: &mut HeadlessAppContext| {
        let bounds = cx
            .update_window(h, |_, w, _| {
                w.try_find("chat-menu-idle1").map_or(slot, |m| m.bounds())
            })
            .unwrap();
        let image = cx.capture_screenshot(h).unwrap();
        painted(&image, bounds, image.width() as f32 / width)
    };
    assert!(!built(cx) && menu(cx) == 0, "row actions absent at rest");
    cx.update_window(h, |_, w, cx| w.hover("chat-row-idle1", cx))
        .unwrap();
    settle(cx, h);
    assert!(built(cx) && menu(cx) > 0, "row actions revealed on hover");
    cx.update_window(h, |_, w, _| {
        let button = w.find("chat-menu-idle1").bounds();
        assert_eq!(button.size, size(w.rem_size() * 2., w.rem_size() * 2.));
        assert!((button.center().x - slot.center().x).abs() < px(0.5));
    })
    .unwrap();
    capture(cx, h, captures, name("-hover"));
    cx.update_window(h, |_, w, cx| w.hover("nav-home", cx))
        .unwrap();
    settle(cx, h);
    assert!(
        !built(cx) && menu(cx) == 0,
        "row actions go when the pointer leaves"
    );
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
        json!({"width":width,"mode":mode.name(),"sidebar_rows":true,"uniform_rows":true,"no_mission_enumeration":true,"mission_association":true,"hover_and_keyboard_reveal":true,"missions_keyboard_and_pointer_keep_scope_and_draft":true})
    );
    cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
    cx.run_until_parked();
}
