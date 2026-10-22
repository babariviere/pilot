//! Actual offscreen production view/scroll/selection, synthetic pages and read channel.
//! No transport, private data, real actions or visible window.
use super::*;
use gpui_kit::{
    Bounds, HeadlessAppContext, ScrollDelta, WindowBounds, WindowOptions,
    component::{Theme, ThemeMode},
    point, size,
    test::TestWindowExt,
};
use serde_json::json;

fn rows(start: u64, end: u64) -> Vec<Message> {
    (start..end).map(|id| Message::live(id, "assistant".into(),
        format!("Page boundary 👩‍💻 e\u{301} message {id}.\n\nA quiet synthetic paragraph to exercise measured history anchors.\n\n{}", "Retained selection and history. ".repeat(5)))).collect()
}
fn settle(cx: &mut HeadlessAppContext, handle: gpui_kit::AnyWindowHandle) {
    for _ in 0..32 {
        cx.advance_clock(Duration::from_millis(16));
        cx.run_until_parked();
        cx.update_window(handle, |_, window, cx| window.render_frame(cx))
            .unwrap();
    }
}
fn up(cx: &mut HeadlessAppContext, handle: gpui_kit::AnyWindowHandle, view: &Entity<LocalViewer>) {
    // Sparse virtual-list heights become known through leading overdraw.
    // Several real wheel packets, not one huge packet or a programmatic jump,
    // may be needed to traverse the loaded page all the way to its first row.
    for _ in 0..32 {
        cx.update_window(handle, |_, window, cx| {
            window.scroll(
                "viewport",
                ScrollDelta::Pixels(point(px(0.), px(100_000.))),
                cx,
            )
        })
        .unwrap();
        cx.run_until_parked();
        let at_top = cx
            .update_window(handle, |_, window, cx| {
                window.render_frame(cx);
                let anchor = view.read(cx).transcript.read(cx).history_probe_anchor(cx);
                anchor.0 == 0 && anchor.1 <= 1.
            })
            .unwrap();
        if at_top {
            break;
        }
    }
}
fn page(
    cx: &mut HeadlessAppContext,
    handle: gpui_kit::AnyWindowHandle,
    view: &Entity<LocalViewer>,
    rows: Vec<Message>,
    cursor: Option<u64>,
    revision: u64,
) {
    cx.update_window(handle, |_, window, cx| {
        view.update(cx, |view, cx| {
            let mut state = view.state.clone();
            state.rows = rows;
            state.cursor = cursor;
            state.page_busy = false;
            state.page_revision = revision;
            view.accept(state, window, cx);
        })
    })
    .unwrap();
    settle(cx, handle);
    assert!(cx.update(|cx| view.read(cx).text_parsers_ready(cx)));
}
pub fn run_history_probe(cx: &mut HeadlessAppContext) {
    let captures = std::env::var_os("PILOT_NEXT_HISTORY_DIR").map(std::path::PathBuf::from);
    if let Some(dir) = &captures {
        std::fs::create_dir_all(dir).unwrap();
    }
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            for fitting in [false, true] {
                cx.update(|cx| Theme::change(mode, None, cx));
                let (client, commands) = LocalClient::synthetic_commands();
                let initial = rows(100, if fitting { 101 } else { 120 });
                let original = initial.clone();
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
                                view.generation = 10;
                                view.title = "Scroll to load earlier messages".into();
                                view.state.generation = 10;
                                view.state.loaded = true;
                                view.state.cursor = Some(100);
                                view.state.rows = initial.clone();
                                view.transcript.update(cx, |v, cx| {
                                    v.history_scope(10);
                                    v.replace_readonly(initial, true, cx);
                                });
                                view
                            })
                        },
                    )
                    .unwrap()
                });
                settle(cx, handle);
                assert!(
                    commands.try_recv().is_err(),
                    "initial layout/remeasure must not fetch history"
                );
                if fitting {
                    cx.update_window(handle, |_, window, cx| {
                        window.scroll(
                            "viewport",
                            ScrollDelta::Pixels(point(px(0.), px(-100.))),
                            cx,
                        )
                    })
                    .unwrap();
                    settle(cx, handle);
                    assert!(
                        commands.try_recv().is_err(),
                        "downward wheel on fitting content must not fetch older messages"
                    );
                }
                up(cx, handle, &view);
                settle(cx, handle);
                println!("{}",cx.update(|cx| {let v=view.read(cx);json!({"debug_top":v.transcript.read(cx).history_probe_anchor(cx),"width":width,"fitting":fitting,"cursor":v.state.cursor,"loaded":v.state.loaded,"generation":v.generation,"state_generation":v.state.generation,"busy":v.state.page_busy,"attempt":v.earlier_attempt})}));
                assert!(
                    matches!(
                        commands.try_recv(),
                        Ok(Command::Earlier {
                            before: 100,
                            generation: 10
                        })
                    ),
                    "real top scroll must request earlier page"
                );
                for _ in 0..8 {
                    up(cx, handle, &view);
                }
                settle(cx, handle);
                assert!(
                    commands.try_recv().is_err(),
                    "one in-flight page despite repeated overscroll"
                );
                let (text, old_y, selected) = cx
                    .update_window(handle, |_, window, cx| {
                        window.render_frame(cx);
                        let transcript = view.read(cx).transcript.clone();
                        assert!(
                            !transcript.read(cx).history_probe_anchor(cx).2,
                            "paging must hold reading, including fitting content"
                        );
                        assert!(window.try_find(("copy-source", 100u64)).is_some());
                        let text = transcript.read(cx).history_probe_row(100);
                        let bounds = text.read(cx).bounds();
                        window.drag(
                            bounds.origin + point(px(2.), px(8.)),
                            bounds.origin + point(px(220.), px(8.)),
                            cx,
                        );
                        let selected = text
                            .read(cx)
                            .selected_source_range()
                            .expect("native text drag selects a real range");
                        assert!(
                            original[0].source().is_char_boundary(selected.start)
                                && original[0].source().is_char_boundary(selected.end)
                        );
                        println!(
                            "history anchor before prepend fitting={fitting} {:?}",
                            transcript.read(cx).history_probe_anchor(cx)
                        );
                        (text, f32::from(bounds.top()), selected)
                    })
                    .unwrap();
                let mut expanded = rows(76, 100);
                expanded.extend(original.clone());
                page(cx, handle, &view, expanded.clone(), Some(76), 1);
                let new_y = cx
                    .update_window(handle, |_, window, cx| {
                        window.render_frame(cx);
                        assert!(
                            window.try_find(("copy-source", 100u64)).is_some(),
                            "reading anchor remains mounted"
                        );
                        let transcript = view.read(cx).transcript.read(cx);
                        let retained = transcript.history_probe_row(100);
                        assert_eq!(retained.entity_id(), text.entity_id());
                        assert_eq!(retained.read(cx).selected_source_range(), Some(selected));
                        assert!(!transcript.history_probe_anchor(cx).2);
                        println!(
                            "history anchor after prepend fitting={fitting} {:?}",
                            transcript.history_probe_anchor(cx)
                        );
                        f32::from(retained.read(cx).bounds().top())
                    })
                    .unwrap();
                assert!(
                    (new_y - old_y).abs() <= 1.,
                    "prepend must preserve pixel anchor: {old_y} -> {new_y}"
                );
                assert!(
                    commands.try_recv().is_err(),
                    "prepend/remeasure must not auto-chain a request"
                );
                up(cx, handle, &view);
                settle(cx, handle);
                assert!(matches!(
                    commands.try_recv(),
                    Ok(Command::Earlier {
                        before: 76,
                        generation: 10
                    })
                ));
                // An unchanged cursor models a failed read: no retry storm.
                page(cx, handle, &view, expanded.clone(), Some(76), 2);
                for _ in 0..8 {
                    up(cx, handle, &view);
                }
                settle(cx, handle);
                assert!(commands.try_recv().is_err());
                cx.update_window(handle, |_, window, cx| window.click("earlier", cx))
                    .unwrap();
                cx.run_until_parked();
                assert!(
                    matches!(
                        commands.try_recv(),
                        Ok(Command::Earlier {
                            before: 76,
                            generation: 10
                        })
                    ),
                    "explicit Earlier remains a retry"
                );
                page(cx, handle, &view, expanded.clone(), None, 3);
                up(cx, handle, &view);
                settle(cx, handle);
                assert!(
                    commands.try_recv().is_err(),
                    "exhausted cursor cannot fetch"
                );
                cx.update_window(handle, |_, window, cx| {
                    window.scroll(
                        "viewport",
                        ScrollDelta::Pixels(point(px(0.), px(-100_000.))),
                        cx,
                    )
                })
                .unwrap();
                settle(cx, handle);
                cx.update(|cx| {
                    let a = view.read(cx).transcript.read(cx).history_probe_anchor(cx);
                    assert!(
                        a.2 && a.3 == 0.,
                        "genuine bottom wheel releases short-history slack: {a:?}"
                    );
                });
                up(cx, handle, &view);
                settle(cx, handle);
                assert!(commands.try_recv().is_err());
                cx.update_window(handle, |_, window, cx| window.click("latest", cx))
                    .unwrap();
                settle(cx, handle);
                assert!(
                    cx.update(|cx| view.read(cx).transcript.read(cx).history_probe_anchor(cx).2)
                );
                assert!(
                    commands.try_recv().is_err(),
                    "ordinary Latest does not request another page"
                );
                // A fresh available cursor exercises actual scrollbar release,
                // which does not use the list/bounce wheel callback.
                page(cx, handle, &view, expanded, Some(70), 4);
                if let Some(dir) = &captures {
                    cx.capture_screenshot(handle)
                        .unwrap()
                        .save(dir.join("before-scrollbar.png"))
                        .unwrap();
                }
                cx.update_window(handle, |_, window, cx| {
                    let b = window.find("viewport").bounds();
                    window.drag(
                        point(b.right() - px(9.), b.bottom() - px(20.)),
                        point(b.right() - px(9.), b.top() - px(20.)),
                        cx,
                    );
                })
                .unwrap();
                settle(cx, handle);
                assert!(
                    matches!(
                        commands.try_recv(),
                        Ok(Command::Earlier {
                            before: 70,
                            generation: 10
                        })
                    ),
                    "actual scrollbar release at top must request history"
                );
                assert!(commands.try_recv().is_err());
                println!(
                    "{}",
                    json!({"width":width,"mode":mode.name(),"fitting":fitting,"native_top_scroll":true,"scrollbar_release_top":true,"page_commands":4,"anchor_before":old_y,"anchor_after":new_y,"selection_entity_retained":true,"no_layout_fetch_or_retry_storm":true,"latest_restores_tail":true,"faux_read_channel":true})
                );
                if let Some(dir) = &captures {
                    cx.capture_screenshot(handle)
                        .unwrap()
                        .save(dir.join(format!(
                            "{}-{}-{}-history.png",
                            width as u32,
                            mode.name(),
                            if fitting { "fitting" } else { "long" }
                        )))
                        .unwrap();
                }
                cx.update_window(handle, |_, window, _| window.remove_window())
                    .unwrap();
                cx.run_until_parked();
            }
        }
    }
}
