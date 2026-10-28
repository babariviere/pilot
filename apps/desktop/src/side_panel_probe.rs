//! Chat side-panel open/close motion on the real mounted shell. Synthetic
//! read-only rows, no live actions. Geometry phases and render counts only:
//! offscreen frames are not visible smoothness or OS presentation evidence.
use super::*;
use gpui_kit::{
    AnyWindowHandle, Bounds, EntityInputHandler, Focusable, HeadlessAppContext, Pixels,
    WindowBounds, WindowOptions, size, test::TestWindowExt,
};
use std::time::Instant;

fn settle(cx: &mut HeadlessAppContext, h: AnyWindowHandle) {
    for _ in 0..20 {
        cx.run_until_parked();
        cx.advance_clock(Duration::from_millis(16));
        cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
    }
}

/// One production-shaped animation frame: the view's own animation-frame
/// notify (headless windows never fire next-frame callbacks), then an ordinary
/// draw that reuses cached children whose bounds did not change.
fn frame(cx: &mut HeadlessAppContext, h: AnyWindowHandle, v: &Entity<LocalViewer>, ms: u64) {
    cx.advance_clock(Duration::from_millis(ms));
    cx.run_until_parked();
    cx.update_window(h, |_, w, cx| {
        v.update(cx, |_, cx| cx.notify());
        w.draw(cx).clear(cx);
    })
    .unwrap();
}

#[derive(Debug, Clone, Copy)]
struct Shot {
    slot: f32,
    region: Option<f32>,
    conversation: f32,
    edge_aligned: bool,
}

/// Viewer and transcript renders over idle draws, with no animation notify.
fn idle_renders(
    cx: &mut HeadlessAppContext,
    h: AnyWindowHandle,
    v: &Entity<LocalViewer>,
) -> (u64, u64) {
    let count = |cx: &mut HeadlessAppContext| {
        cx.update(|cx| {
            let v = v.read(cx);
            (v.render_count, v.transcript.read(cx).probe_render_count())
        })
    };
    let before = count(cx);
    for _ in 0..6 {
        cx.advance_clock(Duration::from_millis(100));
        cx.run_until_parked();
        cx.update_window(h, |_, w, cx| w.draw(cx).clear(cx))
            .unwrap();
    }
    let after = count(cx);
    (after.0 - before.0, after.1 - before.1)
}

fn shot(cx: &mut HeadlessAppContext, h: AnyWindowHandle, side: bool, region: &'static str) -> Shot {
    cx.update_window(h, |_, w, _| {
        let extent = |b: Bounds<Pixels>| f32::from(if side { b.size.width } else { b.size.height });
        let conversation = extent(w.find("mission-context-conversation").bounds());
        let Some(slot) = w.try_find("side-panel-slot").map(|s| s.bounds()) else {
            return Shot {
                slot: 0.,
                region: None,
                conversation,
                edge_aligned: true,
            };
        };
        let r = w.try_find(region).map(|r| r.bounds());
        Shot {
            slot: extent(slot),
            region: r.map(extent),
            conversation,
            // Content rides the moving edge instead of reflowing in place.
            edge_aligned: r.is_none_or(|r| {
                if side {
                    r.left() == slot.left()
                } else {
                    r.top() == slot.top()
                }
            }),
        }
    })
    .unwrap()
}

pub fn run_side_panel_probe(cx: &mut HeadlessAppContext) {
    // Optional review frames (opening at 32/80/240ms). Saving adds wall time.
    let captures = std::env::var_os("PILOT_NEXT_SIDE_PANEL_DIR").map(std::path::PathBuf::from);
    if let Some(d) = &captures {
        std::fs::create_dir_all(d).unwrap();
    }
    for width in [680., 1100.] {
        for dark in [false, true] {
            cx.update(|cx| {
                cx.set_reduce_motion(false);
                crate::appearance::commit_appearance(
                    if dark {
                        crate::settings_state::AppearancePreference::Dark
                    } else {
                        crate::settings_state::AppearancePreference::Light
                    },
                    cx,
                )
            });
            let side = width >= 1100.;
            let (links_extent, changes_extent) = if side { (320., 360.) } else { (280., 300.) };
            let (writer, writes) = Interaction::recording();
            let (client, _commands) = LocalClient::synthetic_commands();
            let (h, view) = cx
                .update(|cx| {
                    gpui_kit::open_window(
                        WindowOptions {
                            window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                                Default::default(),
                                size(px(width), px(840.)),
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
                                v.editor.update(cx, |e, cx| e.shell_probe_setup(writer, w, cx));
                                let rows = (1..=40)
                                    .map(|id| {
                                        Message::live(
                                            id,
                                            "Assistant".into(),
                                            format!("Synthetic message {id}: a wrapped paragraph long enough to reflow as the conversation narrows. 日本語 text stays put. See https://example.org/{id}."),
                                        )
                                        .anchored(crate::model::ReaderKey::model(id, 0, Some(0)))
                                    })
                                    .collect();
                                v.transcript.update(cx, |t, cx| t.replace_readonly(rows, true, cx));
                                v
                            })
                        },
                    )
                })
                .unwrap();
            cx.update_window(h, |_, w, _| w.activate_window()).unwrap();
            settle(cx, h);
            let input = cx.update(|cx| view.read(cx).editor.read(cx).shell_probe().0);
            let transcript = cx.update(|cx| view.read(cx).transcript.clone());
            cx.update_window(h, |_, w, cx| {
                input.update(cx, |i, cx| {
                    i.focus(w, cx);
                    i.replace_text_in_range(None, "Retained draft 日本語", w, cx);
                })
            })
            .unwrap();
            cx.update(|cx| {
                transcript.update(cx, |t, cx| {
                    assert!(t.restore_reading(
                        crate::navigation::ReadingMark {
                            message: Some(crate::model::ReaderKey::model(12, 0, Some(0))),
                            offset: 0.,
                            following: false,
                        },
                        cx
                    ));
                })
            });
            settle(cx, h);
            let closed = shot(cx, h, side, "conversation-links-region");
            assert_eq!(closed.slot, 0.);
            let full = closed.conversation;
            let baseline = idle_renders(cx, h, &view);
            // Same notify+draw with nothing moving: the per-frame floor.
            let mut still_draws = Vec::new();
            for _ in 0..8 {
                let t = Instant::now();
                frame(cx, h, &view, 16);
                still_draws.push(t.elapsed().as_secs_f64() * 1000.);
            }
            let mark = cx.update(|cx| transcript.read(cx).reading_mark(cx).unwrap().message);
            let draft = cx.update(|cx| input.read(cx).value().to_string());

            // An active composition refuses the toggle; nothing starts moving.
            cx.update_window(h, |_, w, cx| {
                input.update(cx, |i, cx| {
                    i.replace_and_mark_text_in_range(None, "にほん", Some(3..3), w, cx)
                });
                w.press("secondary-alt-l", cx);
            })
            .unwrap();
            frame(cx, h, &view, 16);
            assert_eq!(shot(cx, h, side, "conversation-links-region").slot, 0.);
            assert!(!cx.update(|cx| view.read(cx).side_panel.running()));
            cx.update_window(h, |_, w, cx| {
                let marked = input
                    .update(cx, |i, cx| i.marked_text_range(w, cx))
                    .unwrap();
                input.update(cx, |i, cx| i.replace_text_in_range(Some(marked), "", w, cx));
            })
            .unwrap();
            settle(cx, h);

            // Open: the slot eases out from zero while the panel keeps its
            // full extent and rides the edge; the conversation yields exactly.
            let renders = cx.update(|cx| {
                (
                    view.read(cx).render_count,
                    transcript.read(cx).probe_render_count(),
                )
            });
            cx.update_window(h, |_, w, cx| w.press("secondary-alt-l", cx))
                .unwrap();
            frame(cx, h, &view, 0);
            let mut opening = vec![shot(cx, h, side, "conversation-links-region")];
            let started = Instant::now();
            let mut draws = Vec::new();
            for i in 1..=15 {
                let t = Instant::now();
                frame(cx, h, &view, 16);
                draws.push(t.elapsed().as_secs_f64() * 1000.);
                opening.push(shot(cx, h, side, "conversation-links-region"));
                if let Some(d) = captures.as_ref().filter(|_| [2, 5, 15].contains(&i)) {
                    let image = cx
                        .update_window(h, |_, w, _| w.render_to_image().unwrap())
                        .unwrap();
                    let mode = if dark { "dark" } else { "light" };
                    image
                        .save(d.join(format!("{width}-{mode}-{}ms.png", i * 16)))
                        .unwrap();
                }
            }
            let open_wall = started.elapsed();
            let after = cx.update(|cx| {
                (
                    view.read(cx).render_count,
                    transcript.read(cx).probe_render_count(),
                )
            });
            assert!(
                opening[0].slot < 1.,
                "no pop-in on the first frame: {opening:?}"
            );
            assert!(
                opening.windows(2).all(|p| p[1].slot >= p[0].slot),
                "{opening:?}"
            );
            let intermediate = opening
                .iter()
                .filter(|s| s.slot > 1. && s.slot < links_extent - 1.)
                .count();
            assert!(
                intermediate >= 4,
                "visible intermediate geometry: {opening:?}"
            );
            for s in &opening {
                assert_eq!(
                    s.region,
                    Some(links_extent),
                    "panel content must not reflow"
                );
                assert!(s.edge_aligned);
                assert!(
                    (s.conversation + s.slot - full).abs() < 0.5,
                    "{s:?} vs {full}"
                );
            }
            let last = *opening.last().unwrap();
            assert_eq!(last.slot, links_extent);
            assert!(!cx.update(|cx| view.read(cx).side_panel.running()));
            cx.update_window(h, |_, w, cx| {
                assert!(w.find("conversation-links-pane").visible());
                // The opened panel takes focus from the composer.
                assert!(!input.focus_handle(cx).is_focused(w));
            })
            .unwrap();
            // Settled: the reveal requests no frames (asserted above). Idle
            // renders are reported beside the closed baseline; other owners'
            // one-shot timers make their exact counts vary run to run.
            let settled = idle_renders(cx, h, &view);

            // Switching panels eases between their extents with the new content.
            cx.update_window(h, |_, w, cx| w.press("secondary-alt-d", cx))
                .unwrap();
            frame(cx, h, &view, 0);
            let mut switching = vec![shot(cx, h, side, "workspace-changes-region")];
            for _ in 0..15 {
                frame(cx, h, &view, 16);
                switching.push(shot(cx, h, side, "workspace-changes-region"));
            }
            assert!(
                (switching[0].slot - links_extent).abs() < 0.5,
                "{switching:?}"
            );
            assert!(
                switching
                    .iter()
                    .any(|s| s.slot > links_extent + 1. && s.slot < changes_extent - 1.)
            );
            assert!(
                switching
                    .iter()
                    .all(|s| s.region == Some(changes_extent) && s.edge_aligned)
            );
            assert_eq!(switching.last().unwrap().slot, changes_extent);
            cx.update_window(h, |_, w, cx| w.press("secondary-alt-d", cx))
                .unwrap();
            settle(cx, h);
            assert_eq!(shot(cx, h, side, "workspace-changes-region").slot, 0.);
            cx.update_window(h, |_, w, cx| w.press("secondary-alt-l", cx))
                .unwrap();
            settle(cx, h);

            // Close: the panel leaves at once (focus returns, nothing stays
            // interactive); only an empty edge collapses back to the conversation.
            cx.update_window(h, |_, w, cx| w.press("secondary-alt-l", cx))
                .unwrap();
            frame(cx, h, &view, 0);
            let mut closing = vec![shot(cx, h, side, "conversation-links-region")];
            cx.update_window(h, |_, w, cx| {
                assert!(w.try_find("conversation-links-pane").is_none());
                assert!(w.try_find(("conversation-link-copy", 0usize)).is_none());
                assert!(w.find("side-panel-closing").visible());
                assert!(view.read(cx).conversation_links.is_none());
                assert!(input.focus_handle(cx).is_focused(w));
            })
            .unwrap();
            for _ in 0..15 {
                frame(cx, h, &view, 16);
                closing.push(shot(cx, h, side, "conversation-links-region"));
            }
            assert!((closing[0].slot - links_extent).abs() < 0.5, "{closing:?}");
            assert!(
                closing.windows(2).all(|p| p[1].slot <= p[0].slot),
                "{closing:?}"
            );
            assert!(
                closing
                    .iter()
                    .filter(|s| s.slot > 1. && s.slot < links_extent - 1.)
                    .count()
                    >= 4
            );
            assert!(
                closing
                    .iter()
                    .all(|s| s.region.is_none() && (s.conversation + s.slot - full).abs() < 0.5)
            );
            assert_eq!(closing.last().unwrap().slot, 0.);
            cx.update_window(h, |_, w, _| {
                assert!(w.try_find("side-panel-slot").is_none())
            })
            .unwrap();

            // Rapid reversal continues from the extent shown, never jumping.
            cx.update_window(h, |_, w, cx| w.press("secondary-alt-l", cx))
                .unwrap();
            frame(cx, h, &view, 0);
            for _ in 0..3 {
                frame(cx, h, &view, 16);
            }
            let a = shot(cx, h, side, "conversation-links-region").slot;
            assert!(a > 1. && a < links_extent - 1.);
            cx.update_window(h, |_, w, cx| w.press("secondary-alt-l", cx))
                .unwrap();
            frame(cx, h, &view, 0);
            assert!((shot(cx, h, side, "conversation-links-region").slot - a).abs() < 0.5);
            frame(cx, h, &view, 16);
            frame(cx, h, &view, 16);
            let b = shot(cx, h, side, "conversation-links-region").slot;
            assert!(b > 0. && b < a, "{b} after {a}");
            cx.update_window(h, |_, w, cx| w.press("secondary-alt-l", cx))
                .unwrap();
            frame(cx, h, &view, 0);
            assert!((shot(cx, h, side, "conversation-links-region").slot - b).abs() < 0.5);
            settle(cx, h);
            assert_eq!(
                shot(cx, h, side, "conversation-links-region").slot,
                links_extent
            );

            // Reduced motion: both directions land on the end state in one frame.
            cx.update(|cx| cx.set_reduce_motion(true));
            cx.update_window(h, |_, w, cx| w.press("secondary-alt-l", cx))
                .unwrap();
            frame(cx, h, &view, 0);
            assert!(!cx.update(|cx| view.read(cx).side_panel.running()));
            cx.update_window(h, |_, w, _| {
                assert!(w.try_find("side-panel-slot").is_none())
            })
            .unwrap();
            cx.update_window(h, |_, w, cx| w.press("secondary-alt-l", cx))
                .unwrap();
            frame(cx, h, &view, 0);
            assert!(!cx.update(|cx| view.read(cx).side_panel.running()));
            assert_eq!(
                shot(cx, h, side, "conversation-links-region").slot,
                links_extent
            );
            cx.update(|cx| cx.set_reduce_motion(false));

            // Reader position and draft survive every open/close.
            cx.update(|cx| {
                assert_eq!(transcript.read(cx).reading_mark(cx).unwrap().message, mark);
                assert_eq!(input.read(cx).value().to_string(), draft);
            });
            assert!(writes.try_recv().is_err(), "side panels never write");
            println!(
                "{}",
                serde_json::json!({
                    "width": width,
                    "mode": if dark { "dark" } else { "light" },
                    "opening_extents": opening.iter().map(|s| s.slot.round()).collect::<Vec<_>>(),
                    "closing_extents": closing.iter().map(|s| s.slot.round()).collect::<Vec<_>>(),
                    "open_viewer_renders": after.0 - renders.0,
                    "open_transcript_renders": after.1 - renders.1,
                    "open_frame_draw_ms": draws.iter().map(|d| (d * 10.).round() / 10.).collect::<Vec<_>>(),
                    "still_frame_draw_ms": still_draws.iter().map(|d| (d * 10.).round() / 10.).collect::<Vec<_>>(),
                    "open_wall_ms": open_wall.as_millis(),
                    "idle_renders_closed_vs_open": [baseline, settled],
                    "visible_smoothness_proof": false,
                })
            );
            cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
            cx.run_until_parked();
        }
    }
    println!("side_panel: open/close/switch/reversal/reduced-motion geometry passed");
}
