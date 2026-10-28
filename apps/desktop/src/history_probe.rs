//! Actual offscreen production view/scroll/selection, synthetic pages and read channel.
//! No transport, private data, real actions or visible window.
use super::*;
use gpui_kit::{
    Bounds, HeadlessAppContext, ScrollDelta, WindowBounds, WindowOptions,
    component::{ActiveTheme, ThemeMode},
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
// Real mounted bounds, shared by narrow, wide and explicitly sized cap cases.
fn layout(cx: &mut HeadlessAppContext, handle: gpui_kit::AnyWindowHandle, last: u64) {
    cx.update_window(handle, |_, w, _| {
        let conversation = w.find("conversation").bounds();
        let viewport = w.find("viewport").bounds();
        let editor = w.find("conversation-editor").bounds();
        // Kit's px_3 row inset, now on the capped column: 0.75rem, not a literal.
        let inset = w.rem_size() * 0.75;
        let expected = conversation
            .size
            .width
            .min(px(crate::ui::CONVERSATION_MAX_WIDTH));
        assert_eq!(viewport.left(), conversation.left());
        assert_eq!(viewport.right(), conversation.right());
        assert_eq!(editor.size.width, expected);
        assert_eq!(editor.center().x, viewport.center().x);
        let message = w.find(("message-actions", last)).bounds();
        assert_eq!(message.left(), editor.left() + inset);
        assert_eq!(message.right(), editor.right() - inset);
        assert!(editor.bottom() <= conversation.bottom());
        // Contextual Latest, when shown, trails the readable column.
        if let Some(latest) = w.try_find("latest") {
            assert!(latest.bounds().right() <= editor.right() - inset + px(0.5));
        }
    })
    .unwrap();
}

fn contextual_scrollbar(
    cx: &mut HeadlessAppContext,
    handle: gpui_kit::AnyWindowHandle,
    captures: Option<&std::path::Path>,
    key: &str,
    width: f32,
) {
    // Real wheel input reveals the thumb. Leave the pointer outside its track.
    for delta in [60., -1000.] {
        cx.update_window(handle, |_, w, cx| {
            w.scroll(
                "viewport",
                ScrollDelta::Pixels(point(px(0.), px(delta))),
                cx,
            );
            // Outside the track and away from trailing header tooltips.
            w.hover("chat-header", cx);
        })
        .unwrap();
        settle(cx, handle);
    }
    // Base uses wall time, so executor-only advances are not fade evidence.
    std::thread::sleep(Duration::from_millis(120));
    settle(cx, handle);
    let active = cx.capture_screenshot(handle).unwrap();
    std::thread::sleep(Duration::from_millis(2100));
    settle(cx, handle);
    std::thread::sleep(Duration::from_millis(300));
    settle(cx, handle);
    let idle = cx.capture_screenshot(handle).unwrap();
    let bounds = cx
        .update_window(handle, |_, w, _| w.find("viewport").bounds())
        .unwrap();
    let scale = idle.width() as f32 / width;
    let mut changed = 0;
    let mut idle_ink = 0;
    // The page background token, not a literal: the palette is tinted.
    let expected = cx.update(|cx| {
        let page: gpui_kit::Rgba = cx.theme().background.into();
        [page.r, page.g, page.b].map(|c| (c * 255.).round() as u8)
    });
    for y in (f32::from(bounds.top() + px(2.)) * scale) as u32
        ..(f32::from(bounds.bottom() - px(2.)) * scale) as u32
    {
        for x in (f32::from(bounds.right() - px(10.)) * scale) as u32
            ..(f32::from(bounds.right() - px(4.)) * scale) as u32
        {
            let pixel = idle.get_pixel(x, y);
            changed += usize::from(active.get_pixel(x, y) != pixel);
            idle_ink += usize::from(pixel.0[..3] != expected);
        }
    }
    assert!(changed > 0, "scrolling must paint a contextual thumb");
    assert_eq!(idle_ink, 0, "the idle scrollbar must fully disappear");
    if let Some(dir) = captures {
        active
            .save(dir.join(format!("{key}-scrolling.png")))
            .unwrap();
        idle.save(dir.join(format!("{key}-idle.png"))).unwrap();
    }
    println!("contextual scrollbar {key}: {changed} changed pixels; idle strip clean");
}

/// Newer entries omitted while reading older ones: an ordinary wheel back to
/// the bottom rereads the newest window once; a failed read offers a readable,
/// opaque retry over the retained text.
fn newest_window(
    cx: &mut HeadlessAppContext,
    handle: gpui_kit::AnyWindowHandle,
    view: &Entity<LocalViewer>,
    commands: &async_channel::Receiver<Command>,
    captures: Option<&std::path::Path>,
    key: &str,
) {
    let reads = |commands: &async_channel::Receiver<Command>| {
        std::iter::from_fn(|| commands.try_recv().ok()).collect::<Vec<_>>()
    };
    up(cx, handle, view);
    settle(cx, handle);
    reads(commands);
    cx.update_window(handle, |_, w, cx| {
        view.update(cx, |v, cx| {
            let mut state = v.state.clone();
            state.rows = v.transcript.read(cx).link_snapshot_rows();
            state.behind = true;
            v.accept(state, w, cx);
        })
    })
    .unwrap();
    settle(cx, handle);
    assert!(
        reads(commands).is_empty(),
        "no reread while reading older rows"
    );
    cx.update_window(handle, |_, w, cx| {
        w.scroll(
            "viewport",
            ScrollDelta::Pixels(point(px(0.), px(-100_000.))),
            cx,
        )
    })
    .unwrap();
    settle(cx, handle);
    let sent = reads(commands);
    assert!(
        matches!(sent.as_slice(), [Command::Open { generation: 11, .. }]),
        "bottom wheel rereads the newest window exactly once"
    );
    cx.update_window(handle, |_, w, _| {
        assert!(
            w.try_find("latest").is_none(),
            "routine loading is not Retry"
        )
    })
    .unwrap();
    cx.update_window(handle, |_, w, cx| {
        view.update(cx, |v, cx| {
            let mut state = v.state.clone();
            state.generation = 11;
            state.loaded = false;
            state.chat_issue = true;
            state.chat_status = "Local disconnected. Reconnecting with identity validation…".into();
            v.accept(state, w, cx);
        })
    })
    .unwrap();
    settle(cx, handle);
    let image = cx.capture_screenshot(handle).unwrap();
    let (bounds, label, width) = cx
        .update_window(handle, |_, w, _| {
            let control = w.find("latest");
            (
                control.bounds(),
                control.label().map(str::to_owned),
                f32::from(w.viewport_size().width),
            )
        })
        .unwrap();
    assert_eq!(label.as_deref(), Some("Retry latest"));
    // A row just inside the border, above the label glyphs, is one solid
    // surface: transcript text never shows through the control.
    let scale = image.width() as f32 / width;
    let y = (f32::from(bounds.top() + px(3.)) * scale) as u32;
    let xs = (f32::from(bounds.left() + px(8.)) * scale) as u32
        ..(f32::from(bounds.right() - px(8.)) * scale) as u32;
    let first = image.get_pixel(xs.start, y).0;
    assert!(first[3] == 255, "opaque control surface");
    assert!(
        xs.clone().all(|x| image.get_pixel(x, y).0 == first),
        "uniform control surface"
    );
    if let Some(dir) = captures {
        image
            .save(dir.join(format!("{key}-retry-latest.png")))
            .unwrap();
    }
    assert!(reads(commands).is_empty());
}

pub fn run_history_probe(cx: &mut HeadlessAppContext) {
    let only = std::env::var("PILOT_NEXT_HISTORY_CASE").ok();
    if let Some(case) = &only {
        assert!(
            [
                "680-light-long",
                "680-light-fitting",
                "680-dark-long",
                "680-dark-fitting",
                "1100-light-long",
                "1100-light-fitting",
                "1100-dark-long",
                "1100-dark-fitting",
                "1600-light-long",
                "1600-dark-long"
            ]
            .contains(&case.as_str()),
            "unknown history case"
        );
    }
    let mut cases = 0;
    let captures = std::env::var_os("PILOT_NEXT_HISTORY_DIR").map(std::path::PathBuf::from);
    if let Some(dir) = &captures {
        std::fs::create_dir_all(dir).unwrap();
    }
    for width in [680., 1100., 1600.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            for fitting in [false, true] {
                if width == 1600. && fitting {
                    continue;
                }
                let key = format!(
                    "{}-{}-{}",
                    width as u32,
                    mode.name(),
                    if fitting { "fitting" } else { "long" }
                );
                if only.as_ref().is_some_and(|only| only != &key) {
                    continue;
                }
                cases += 1;
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
                                // A newest window that trimmed older entries is
                                // current: it never needs a persistent control.
                                view.state.limited = true;
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
                cx.update(|cx| assert_eq!(cx.theme().mode, mode));
                layout(cx, handle, if fitting { 100 } else { 119 });
                if !fitting {
                    // The real detail split must never receive the chat's track.
                    // Reduced motion is not required: settle the shared transition.
                    cx.update_window(handle, |_, w, cx| w.click("conversation-links-toggle", cx))
                        .unwrap();
                    settle(cx, handle);
                    layout(cx, handle, 119);
                    cx.update_window(handle, |_, w, _| {
                        let slot = w.find("side-panel-slot").bounds();
                        let viewport = w.find("viewport").bounds();
                        assert!(viewport.right() <= slot.left() || viewport.bottom() <= slot.top());
                    })
                    .unwrap();
                    contextual_scrollbar(
                        cx,
                        handle,
                        captures.as_deref(),
                        &format!("{key}-split"),
                        width,
                    );
                    cx.update_window(handle, |_, w, cx| w.click("conversation-links-toggle", cx))
                        .unwrap();
                    settle(cx, handle);
                    // Restore the same tail before testing history admission.
                    cx.update(|cx| {
                        view.read(cx)
                            .transcript
                            .clone()
                            .update(cx, |t, cx| t.latest(cx))
                    });
                    settle(cx, handle);
                    layout(cx, handle, 119);
                }
                if width == 1600. {
                    cx.update_window(handle, |_, w, _| {
                        assert!(w.find("viewport").bounds().size.width > px(960.));
                    })
                    .unwrap();
                    // Find's tray spans the pane; its controls keep the readable column.
                    cx.update_window(handle, |_, w, cx| {
                        let transcript = view.read(cx).transcript.clone();
                        transcript.update(cx, |t, cx| t.open_find(w, cx));
                    })
                    .unwrap();
                    settle(cx, handle);
                    cx.update_window(handle, |_, w, _| {
                        let inset = w.rem_size() * 0.75;
                        let editor = w.find("conversation-editor").bounds();
                        let tray = w.find("transcript-find").bounds();
                        let column = w.find("transcript-find-column").bounds();
                        let close = w.find("find-close").bounds();
                        assert!(tray.size.width > px(960.), "tray spans the pane: {tray:?}");
                        // The controls' column is the composer's column; its px_3 is the row inset.
                        assert_eq!(column.left(), editor.left());
                        assert_eq!(column.right(), editor.right());
                        assert_eq!(close.right(), editor.right() - inset);
                    })
                    .unwrap();
                    if let Some(dir) = &captures {
                        cx.capture_screenshot(handle)
                            .unwrap()
                            .save(dir.join(format!("1600-{}-find.png", mode.name())))
                            .unwrap();
                    }
                    cx.update_window(handle, |_, w, cx| w.click("find-close", cx))
                        .unwrap();
                    settle(cx, handle);
                    cx.update_window(handle, |_, w, _| {
                        assert!(w.try_find("transcript-find").is_none())
                    })
                    .unwrap();
                    if let Some(dir) = &captures {
                        cx.capture_screenshot(handle)
                            .unwrap()
                            .save(dir.join(format!("1600-{}-layout.png", mode.name())))
                            .unwrap();
                    }
                    assert!(commands.try_recv().is_err());
                    println!(
                        "layout cap 1600 {}: full viewport, 960pt message column and editor",
                        mode.name()
                    );
                    cx.update_window(handle, |_, w, _| w.remove_window())
                        .unwrap();
                    cx.run_until_parked();
                    continue;
                }
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
                let mut streamed = original.clone();
                for phase in 0..2 {
                    streamed = original.clone();
                    streamed.push(Message::live(
                        if fitting { 101 } else { 120 },
                        "assistant".into(),
                        format!(
                            "Synthetic streamed reply 👩‍💻 e\u{301}. {}",
                            "A new tail update. ".repeat(4 + phase * 4)
                        ),
                    ));
                    // A stream publication at the same page revision is not a
                    // history completion, even if it predates the busy flag.
                    page(cx, handle, &view, streamed.clone(), Some(100), 0);
                    cx.update_window(handle, |_, window, cx| {
                        window.render_frame(cx);
                        let v = view.read(cx);
                        assert!(v.state.page_busy && v.earlier_request.is_some());
                        let transcript = v.transcript.read(cx);
                        let retained = transcript.history_probe_row(100);
                        assert_eq!(retained.entity_id(), text.entity_id());
                        assert_eq!(
                            retained.read(cx).selected_source_range(),
                            Some(selected.clone())
                        );
                        assert!(
                            (f32::from(retained.read(cx).bounds().top()) - old_y).abs() <= 1.,
                            "stream must preserve current read position"
                        );
                        assert!(!transcript.history_probe_anchor(cx).2);
                    })
                    .unwrap();
                    assert!(
                        commands.try_recv().is_err(),
                        "stream/remeasure cannot create another history read"
                    );
                }
                expanded.extend(streamed);
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
                super::contextual_navigation::probe_menu_choice(
                    cx,
                    handle,
                    "history-menu",
                    0,
                    mode == ThemeMode::Dark,
                );
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
                cx.update_window(handle, |_, w, _| {
                    assert!(
                        w.try_find("latest").is_none(),
                        "followed ordinary history needs no persistent Latest"
                    )
                })
                .unwrap();
                up(cx, handle, &view);
                settle(cx, handle);
                assert!(commands.try_recv().is_err());
                cx.update_window(handle, |_, w, _| {
                    let latest = w.find("latest").bounds();
                    let viewport = w.find("viewport").bounds();
                    assert!(
                        latest.left() >= viewport.left()
                            && latest.right() <= viewport.right()
                            && latest.top() >= viewport.top()
                            && latest.bottom() <= viewport.bottom(),
                        "contextual Latest stays inside transcript: {latest:?} / {viewport:?}"
                    );
                    // It trails the readable column (inside its 1pt border), not the scrollbar.
                    let edge = w.find("conversation-editor").bounds().right() - w.rem_size() * 0.75;
                    assert!(
                        latest.right() <= edge && latest.right() >= edge - px(1.5),
                        "Latest trails the message column: {latest:?} / {edge:?}"
                    );
                })
                .unwrap();
                super::contextual_navigation::probe_menu_choice(
                    cx,
                    handle,
                    "history-menu",
                    1,
                    mode == ThemeMode::Dark,
                );
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
                cx.update_window(handle, |_, window, cx| {
                    let b = window.find("viewport").bounds();
                    // The idle-hidden thumb fades on wall time and ignores clicks once
                    // invisible. A short wheel away from the top reveals it for the drag.
                    window.scroll("viewport", ScrollDelta::Pixels(point(px(0.), px(40.))), cx);
                    window.render_frame(cx);
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
                if !fitting {
                    // Keep fade observation separate from thumb interaction:
                    // invisible scrolling-mode chrome intentionally ignores clicks.
                    let previous = cx.update(|cx| cx.theme().scrollbar_mode);
                    cx.update(|cx| {
                        gpui_kit::component::Theme::set_scrollbar_mode(
                            gpui_kit::component::scroll::ScrollbarMode::Always,
                            cx,
                        )
                    });
                    contextual_scrollbar(cx, handle, captures.as_deref(), &key, width);
                    assert!(commands.try_recv().is_err());
                    cx.update(|cx| gpui_kit::component::Theme::set_scrollbar_mode(previous, cx));
                }
                newest_window(cx, handle, &view, &commands, captures.as_deref(), &key);
                println!(
                    "{}",
                    json!({"width":width,"mode":mode.name(),"fitting":fitting,"native_top_scroll":true,"scrollbar_release_top":true,"page_commands":4,"anchor_before":old_y,"anchor_after":new_y,"selection_entity_retained":true,"stream_append_and_update_while_paging":true,"no_layout_fetch_or_retry_storm":true,"latest_restores_tail":true,"faux_read_channel":true})
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
    assert_eq!(
        cases,
        if only.is_some() { 1 } else { 10 },
        "history selection must run its cases"
    );
}
