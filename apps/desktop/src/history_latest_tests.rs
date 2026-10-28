//! Bottom scrolling reaches the newest bounded window without a persistent control.
use super::*;
use gpui_kit::{
    Bounds, ScrollDelta, TestAppContext, WindowBounds, WindowOptions, point, size,
    test::TestWindowExt,
};

fn rows(start: u64, end: u64) -> Vec<Message> {
    (start..end)
        .map(|id| {
            Message::live(
                id,
                "assistant".into(),
                format!(
                    "Bounded window message {id}.\n\n{}",
                    "Synthetic history paragraph. ".repeat(12)
                ),
            )
        })
        .collect()
}

fn setup(
    cx: &mut TestAppContext,
) -> (
    gpui_kit::AnyWindowHandle,
    Entity<LocalViewer>,
    async_channel::Receiver<Command>,
) {
    cx.update(|cx| {
        gpui_kit::init(cx);
        crate::init_appearance(cx);
        LocalViewer::bind_keys(cx);
    });
    let (client, commands) = LocalClient::synthetic_commands();
    let (h, v) = cx.update(|cx| {
        gpui_kit::open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                    Default::default(),
                    size(px(1100.), px(760.)),
                ))),
                show: false,
                ..Default::default()
            },
            cx,
            |w, cx| {
                cx.new(|cx| {
                    let mut v = LocalViewer::preview(PreviewState::Conversation, w, cx);
                    v.client = Some(client);
                    v.selected = Some("source".into());
                    v.generation = 10;
                    v.state.generation = 10;
                    v.state.loaded = true;
                    v.state.cursor = None;
                    // The newest bounded window: older entries were trimmed.
                    v.state.limited = true;
                    v
                })
            },
        )
        .unwrap()
    });
    publish(cx, h, &v, |s| s.rows = rows(100, 130));
    (h, v, commands)
}

fn settle(cx: &mut TestAppContext, h: gpui_kit::AnyWindowHandle) {
    for _ in 0..6 {
        cx.run_until_parked();
        cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
    }
}

/// Accept a publication for the current generation, as the read worker would.
fn publish(
    cx: &mut TestAppContext,
    h: gpui_kit::AnyWindowHandle,
    v: &Entity<LocalViewer>,
    change: impl FnOnce(&mut Presentation),
) {
    cx.update_window(h, |_, w, cx| {
        v.update(cx, |v, cx| {
            let mut state = v.state.clone();
            state.rows = v.transcript.read(cx).link_snapshot_rows();
            change(&mut state);
            v.accept(state, w, cx);
        })
    })
    .unwrap();
    settle(cx, h);
}

fn drain(commands: &async_channel::Receiver<Command>) -> Vec<Command> {
    std::iter::from_fn(|| commands.try_recv().ok()).collect()
}

fn opens(commands: &[Command]) -> Vec<u64> {
    commands
        .iter()
        .filter_map(|c| match c {
            Command::Open { id, generation } if id == "source" => Some(*generation),
            Command::Open { .. } => panic!("only the selected chat is reread"),
            _ => None,
        })
        .collect()
}

/// The reader position the read worker sees: (generation, holding older rows).
fn holding(cx: &mut TestAppContext, v: &Entity<LocalViewer>) -> (u64, bool) {
    cx.update(|cx| v.read(cx).client.as_ref().unwrap().holding())
}

fn control(cx: &mut TestAppContext, h: gpui_kit::AnyWindowHandle) -> Option<String> {
    cx.update_window(h, |_, w, _| {
        w.try_find("latest")
            .map(|c| c.label().unwrap_or_default().to_string())
    })
    .unwrap()
}

fn mark(cx: &mut TestAppContext, v: &Entity<LocalViewer>) -> (usize, f32, bool) {
    cx.update(|cx| v.read(cx).transcript.read(cx).history_position(cx))
}

fn wheel(cx: &mut TestAppContext, h: gpui_kit::AnyWindowHandle, dy: f32) {
    for _ in 0..4 {
        cx.update_window(h, |_, w, cx| {
            w.scroll("viewport", ScrollDelta::Pixels(point(px(0.), px(dy))), cx)
        })
        .unwrap();
        settle(cx, h);
    }
}

fn following(cx: &mut TestAppContext, v: &Entity<LocalViewer>) -> bool {
    cx.update(|cx| v.read(cx).transcript.read(cx).history_position(cx).2)
}

#[gpui_kit::test]
fn current_bounded_window_shows_no_latest_control(cx: &mut TestAppContext) {
    let (h, v, commands) = setup(cx);
    assert!(following(cx, &v));
    cx.update_window(h, |_, w, _| {
        assert!(
            w.try_find("latest").is_none(),
            "a trimmed-older but current window needs no Latest control"
        )
    })
    .unwrap();
    // Away from the bottom, the contextual jump appears; wheeling back to the
    // bottom of a current window resumes the tail without a reload.
    wheel(cx, h, 400.);
    assert!(!following(cx, &v));
    assert_eq!(
        holding(cx, &v),
        (10, true),
        "the worker keeps older rows while reading"
    );
    cx.update_window(h, |_, w, _| assert!(w.try_find("latest").is_some()))
        .unwrap();
    wheel(cx, h, -100_000.);
    assert!(following(cx, &v));
    assert_eq!(holding(cx, &v), (10, false));
    cx.update_window(h, |_, w, _| assert!(w.try_find("latest").is_none()))
        .unwrap();
    assert!(
        drain(&commands).is_empty(),
        "no reload for a current window"
    );
    // A sliding newest window (oldest rows dropped) keeps following, no reload.
    publish(cx, h, &v, |s| s.rows = rows(104, 134));
    assert!(following(cx, &v));
    assert_eq!(control(cx, h), None);
    assert!(drain(&commands).is_empty());
}

#[gpui_kit::test]
fn reading_older_keeps_anchor_and_bottom_requests_newest_window_once(cx: &mut TestAppContext) {
    let (h, v, commands) = setup(cx);
    wheel(cx, h, 1200.);
    assert!(!following(cx, &v));
    let before = mark(cx, &v);
    drain(&commands);
    // Newer entries were omitted while reading: the window is unchanged.
    publish(cx, h, &v, |s| s.behind = true);
    assert_eq!(mark(cx, &v), before, "reading anchor is preserved");
    assert!(
        drain(&commands).is_empty(),
        "no reload while reading older content"
    );
    assert_eq!(control(cx, h).as_deref(), Some("Latest"));

    // An ordinary wheel back to the bottom rereads the newest window once.
    wheel(cx, h, -100_000.);
    let sent = drain(&commands);
    assert_eq!(opens(&sent), [11]);
    assert!(cx.update(|cx| v.read(cx).refreshing));
    assert_eq!(
        control(cx, h),
        None,
        "routine loading is not a Retry control"
    );
    wheel(cx, h, -100_000.);
    wheel(cx, h, 200.);
    wheel(cx, h, -100_000.);
    assert!(
        opens(&drain(&commands)).is_empty(),
        "one read per need, no loop"
    );

    // A stale publication from the previous generation changes nothing.
    cx.update_window(h, |_, w, cx| {
        v.update(cx, |v, cx| {
            let state = Presentation {
                generation: 10,
                loaded: true,
                behind: true,
                ..Default::default()
            };
            v.accept(state, w, cx)
        })
    })
    .unwrap();
    settle(cx, h);
    assert!(cx.update(|cx| v.read(cx).refreshing));
    assert!(opens(&drain(&commands)).is_empty());

    // The newest window arrives and the reader follows its tail.
    cx.update_window(h, |_, w, cx| {
        v.update(cx, |v, cx| {
            let state = Presentation {
                generation: 11,
                loaded: true,
                limited: true,
                rows: rows(110, 140),
                ..Default::default()
            };
            v.accept(state, w, cx)
        })
    })
    .unwrap();
    settle(cx, h);
    assert!(following(cx, &v));
    assert_eq!(control(cx, h), None);
    assert!(opens(&drain(&commands)).is_empty());
}

#[gpui_kit::test]
fn omitted_newer_entries_while_following_reread_newest_window_once(cx: &mut TestAppContext) {
    let (h, v, commands) = setup(cx);
    drain(&commands);
    publish(cx, h, &v, |s| s.behind = true);
    assert_eq!(opens(&drain(&commands)), [11]);
    assert!(following(cx, &v));
    assert_eq!(control(cx, h), None);
}

#[gpui_kit::test]
fn failed_newest_read_offers_readable_keyboard_retry(cx: &mut TestAppContext) {
    let (h, v, commands) = setup(cx);
    publish(cx, h, &v, |s| s.behind = true);
    assert_eq!(opens(&drain(&commands)), [11]);
    let progress = |cx: &mut TestAppContext, issue: bool| {
        cx.update_window(h, |_, w, cx| {
            v.update(cx, |v, cx| {
                let state = Presentation {
                    generation: 11,
                    chat_issue: issue,
                    chat_status: if issue {
                        "Local disconnected. Reconnecting with identity validation…"
                    } else {
                        "Connected · Local"
                    }
                    .into(),
                    ..Default::default()
                };
                v.accept(state, w, cx)
            })
        })
        .unwrap();
        settle(cx, h);
    };
    progress(cx, false);
    assert_eq!(control(cx, h), None, "a connected, loading read is routine");
    progress(cx, true);
    assert_eq!(control(cx, h).as_deref(), Some("Retry latest"));
    // The previous window remains readable beside the contextual retry.
    assert!(cx.update(|cx| {
        !v.read(cx)
            .transcript
            .read(cx)
            .link_snapshot_rows()
            .is_empty()
    }));
    cx.update_window(h, |_, w, cx| {
        let viewport = w.find("viewport").bounds();
        let retry = w.find("latest").bounds();
        assert!(viewport.contains(&retry.origin) && retry.bottom() <= viewport.bottom());
        w.focus_next(cx);
    })
    .unwrap();
    for _ in 0..64 {
        let focused = cx
            .update_window(h, |_, w, cx| {
                w.render_frame(cx);
                if w.find("latest").focused() == Some(true) {
                    true
                } else {
                    w.press("tab", cx);
                    false
                }
            })
            .unwrap();
        cx.run_until_parked();
        if focused {
            break;
        }
    }
    cx.update_window(h, |_, w, cx| {
        assert_eq!(
            w.find("latest").focused(),
            Some(true),
            "Retry is keyboard reachable"
        );
        w.press("enter", cx);
    })
    .unwrap();
    settle(cx, h);
    assert_eq!(opens(&drain(&commands)), [12]);
    assert_eq!(control(cx, h), None, "the retry restarts a routine read");
}

#[gpui_kit::test]
fn stale_reader_position_never_reaches_another_generation(cx: &mut TestAppContext) {
    let (h, v, commands) = setup(cx);
    drain(&commands);
    cx.update(|cx| {
        v.update(cx, |v, cx| {
            v.transcript.update(cx, |_, cx| {
                cx.emit(crate::transcript_view::Following(9, false));
                cx.emit(crate::transcript_view::LatestRequested(9));
            })
        })
    });
    settle(cx, h);
    assert!(drain(&commands).is_empty());
    assert_eq!(
        holding(cx, &v),
        (0, false),
        "a stale scope never reports a position"
    );
}
