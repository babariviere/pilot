//! Actual mounted composer/info/navigation, synthetic summaries, no Local actions.
use super::*;
use gpui_kit::{
    AnyWindowHandle, Bounds, EntityInputHandler, Focusable, HeadlessAppContext, WindowBounds,
    WindowOptions, size, test::TestWindowExt,
};
use serde_json::json;
#[path = "context_meter_probe.rs"]
mod meter;
fn settle(cx: &mut HeadlessAppContext, h: AnyWindowHandle) {
    // Closing dialogs remain mounted during Kit's default SlideDown exit.
    // Start that transition, then finish it before inspecting the next interaction.
    cx.run_until_parked();
    cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
    cx.advance_clock(*gpui_kit::component::dialog::ANIMATION_DURATION);
    for _ in 0..4 {
        cx.run_until_parked();
        cx.advance_clock(Duration::from_millis(16));
        cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
    }
}
pub fn run_context_usage_probe(cx: &mut HeadlessAppContext) {
    // Longest exact count, plus children that reported only zeros.
    fn fixture() -> crate::context_usage::Usage {
        crate::context_usage::Usage::read(
            &json!({"context":{"tokens":42600,"contextWindow":200000},"ai":{
            "direct":{"tokens":{"input":9_007_199_254_740_991u64,"output":1200,"cacheRead":9_733_376,"cacheWrite":0}},
            "child":{"tokens":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0}}}}),
        )
    }
    let captures = std::env::var_os("PILOT_NEXT_CONTEXT_USAGE_DIR").map(std::path::PathBuf::from);
    if let Some(p) = &captures {
        std::fs::create_dir_all(p).unwrap();
    }
    for width in [680., 1100.] {
        for dark in [false, true] {
            cx.update(|cx| {
                crate::appearance::commit_appearance(
                    if dark {
                        crate::settings_state::AppearancePreference::Dark
                    } else {
                        crate::settings_state::AppearancePreference::Light
                    },
                    cx,
                )
            });
            let (client, commands) = LocalClient::synthetic_commands();
            let (writer, writes) = Interaction::recording();
            let (h, view) = cx.update(|cx| gpui_kit::open_window(WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(Bounds::new(Default::default(), size(px(width), px(840.))))),
                show: false, focus: false, ..Default::default()
            }, cx, |w, cx| cx.new(|cx| {
                let mut v = LocalViewer::preview(PreviewState::Conversation, w, cx);
                v.client = Some(client);
                v.editor.update(cx, |e, cx| e.shell_probe_setup(writer, w, cx));
                v.state.status = "Connected · Local".into();
                v.state.list_loaded = true;
                Arc::make_mut(&mut v.state.chats)[0].context_usage = fixture();
                // The popup omits the chat title, so a long one cannot crowd it.
                v.title = "Make app updates save drafts and settle pending saves automatically, with a very long Unicode title: 日本語のタイトル".repeat(3);
                v
            }))).unwrap();
            settle(cx, h);
            meter::states(cx, h, &view, captures.as_deref(), width, dark);
            cx.update_window(h, |_, _, cx| {
                view.update(cx, |v, cx| {
                    Arc::make_mut(&mut v.state.chats)[0].context_usage = fixture();
                    cx.notify();
                })
            })
            .unwrap();
            settle(cx, h);
            // The disclosure must not steal or commit active composer preedit.
            let input = cx.update(|cx| view.read(cx).editor.read(cx).shell_probe().0);
            cx.update_window(h, |_, w, cx| {
                assert!(
                    w.try_find("context-usage-info").is_none(),
                    "previous disclosure finished closing"
                );
                input.update(cx, |i, cx| {
                    i.focus(w, cx);
                    i.replace_and_mark_text_in_range(None, "にほん", Some(3..3), w, cx)
                });
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(
                    input
                        .update(cx, |i, cx| i.marked_text_range(w, cx))
                        .is_some(),
                    "preedit exists before click"
                );
                w.click("context-usage", cx)
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(w.try_find("context-usage-info").is_none());
                let marked = input
                    .update(cx, |i, cx| i.marked_text_range(w, cx))
                    .expect("preedit retained");
                input.update(cx, |i, cx| i.replace_text_in_range(Some(marked), "", w, cx));
            })
            .unwrap();
            settle(cx, h);
            let before = cx
                .update_window(h, |_, w, cx| {
                    let b = w.find("conversation-editor").bounds();
                    w.click("context-usage", cx);
                    b
                })
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, _| {
                let pane = w.find("context-usage-info").bounds();
                assert!(pane.size.width > px(200.));
                for id in [
                    "context-usage-percent",
                    "context-usage-amount",
                    "context-usage-meter",
                    "context-usage-status",
                ] {
                    let b = w.find(id).bounds();
                    assert!(w.find(id).visible(), "{id}");
                    assert!(
                        b.left() >= pane.left() && b.right() <= pane.right(),
                        "{id} fits"
                    );
                }
                assert!(
                    pane.size.height < px(160.),
                    "Folded summary stays compact: {:?}",
                    pane.size
                );
                assert!(
                    w.try_find("context-usage-accounting").is_none(),
                    "Details start folded"
                );
                assert!(
                    w.find("context-usage-details")
                        .label()
                        .unwrap()
                        .contains("Show")
                );
                assert_eq!(
                    w.find("conversation-editor").bounds(),
                    before,
                    "Disclosure must not resize composer or transcript"
                );
            })
            .unwrap();
            crate::icon_probe::assert_disclosure_chevron(cx, h, "context-usage-details", false);
            // Keyboard: reach Details, open it, and close the popup with Escape.
            let mut reached = false;
            for _ in 0..12 {
                reached = cx
                    .update_window(h, |_, w, cx| {
                        if w.find("context-usage-details").focused() == Some(true) {
                            return true;
                        }
                        w.focus_next(cx);
                        w.render_frame(cx);
                        w.find("context-usage-details").focused() == Some(true)
                    })
                    .unwrap();
                if reached {
                    break;
                }
            }
            assert!(reached, "Details is keyboard reachable");
            // Enter is the dialog's own Confirm binding; Space activates the focused button.
            cx.update_window(h, |_, w, cx| w.press("space", cx))
                .unwrap();
            settle(cx, h);
            if let Some(p) = &captures {
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(p.join(format!(
                        "context-details-{width}-{}.png",
                        if dark { "dark" } else { "light" }
                    )))
                    .unwrap();
            }
            crate::icon_probe::assert_disclosure_chevron(cx, h, "context-usage-details", true);
            cx.update_window(h, |_, w, _| {
                let pane = w.find("context-usage-info").bounds();
                let table = w.find("context-usage-accounting").bounds();
                assert!(table.bottom() < w.viewport_size().height);
                assert!(table.left() >= pane.left() && table.right() <= pane.right());
                assert!(
                    w.find("context-usage-details")
                        .label()
                        .unwrap()
                        .contains("Hide")
                );
                // Numbers share one right edge, including the longest exact count.
                let edge = w.find(("context-usage-cell", 0usize)).bounds().right();
                for row in 1..6usize {
                    let cell = w.find(("context-usage-cell", row * 2)).bounds();
                    assert_eq!(cell.right(), edge, "row {row} aligned");
                    assert!(cell.left() >= pane.left(), "row {row} fits");
                }
                // All-zero children are hidden, not shown as a column of zeros.
                assert!(w.try_find(("context-usage-cell", 3usize)).is_none());
                assert!(w.find("context-usage-note").visible());
            })
            .unwrap();
            if let Some(p) = &captures {
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(p.join(format!(
                        "context-{width}-{}.png",
                        if dark { "dark" } else { "light" }
                    )))
                    .unwrap();
            }
            cx.update_window(h, |_, w, cx| w.press("escape", cx))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(w.try_find("context-usage-info").is_none());
                assert!(
                    input.focus_handle(cx).is_focused(w),
                    "Dialog restores input focus"
                );
                w.click("chat-row-synthetic-two", cx);
            })
            .unwrap();
            settle(cx, h);
            assert!(
                matches!(commands.try_recv(), Ok(Command::Open { id, .. }) if id == "synthetic-two")
            );
            cx.update_window(h, |_, w, cx| w.click("context-usage", cx))
                .unwrap();
            settle(cx, h);
            // An old-generation summary may update global metadata, never the panel's pinned chat.
            cx.update_window(h, |_, w, cx| {
                view.update(cx, |v, cx| {
                    assert_eq!(v.selected.as_deref(), Some("synthetic-two"));
                    let mut late = v.state.clone();
                    late.generation = v.generation.saturating_sub(1);
                    Arc::make_mut(&mut late.chats)[0].context_usage =
                        crate::context_usage::Usage::read(
                            &json!({"context":{"tokens":199999,"contextWindow":200000}}),
                        );
                    v.accept(late, w, cx);
                    assert!(
                        v.state
                            .chats
                            .iter()
                            .find(|c| c.id == "synthetic-two")
                            .unwrap()
                            .context_usage
                            .exact()
                            == "Unknown / Unknown"
                    );
                    v.selected = Some("synthetic".into());
                    cx.notify();
                })
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(w.find("context-usage-changed").visible());
                assert!(w.try_find("context-usage-percent").is_none());
                w.click("context-usage-done", cx);
            })
            .unwrap();
            settle(cx, h);
            assert!(
                commands.try_recv().is_err(),
                "Information never dispatches commands"
            );
            assert!(
                writes.try_recv().is_err(),
                "Information never sends, starts, stops or changes settings"
            );
            cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
            cx.run_until_parked();
            println!(
                "context usage mounted {width} dark={dark}: bounds, disclosure, navigation, unknown coverage and late identity fence passed"
            );
        }
    }
}
