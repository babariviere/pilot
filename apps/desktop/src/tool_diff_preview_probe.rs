//! Mounted production work/chip, private synthetic conversation and composer.
use super::*;
use gpui_kit::{
    AnyWindowHandle, Bounds, EntityInputHandler, HeadlessAppContext, WindowBounds, WindowOptions,
    size, test::TestWindowExt,
};
fn settle(cx: &mut HeadlessAppContext, h: AnyWindowHandle) {
    for _ in 0..8 {
        cx.run_until_parked();
        cx.advance_clock(Duration::from_millis(16));
        cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
    }
}
fn model(status: &str, new: &str) -> crate::local_model::LiveTranscript {
    let mut m = crate::local_model::LiveTranscript::default();
    m.apply(&serde_json::json!({"type":"entry_appended","entry":{"id":20,"kind":"pi.assistant","model":[{"role":"assistant","content":[{"type":"toolCall","id":"chip-call","name":"edit","arguments":{"path":"src/日本👩‍💻é/very-long-component-name.rs","oldText":"  before <&>\nkeep","newText":new}}]}]}}));
    if status == "running" {
        m.apply(&serde_json::json!({"type":"tool_execution_start","toolCallId":"chip-call","toolName":"edit"}));
    } else if status == "unknown" {
        m.apply(&serde_json::json!({"type":"run_end"}));
    } else if status != "pending" {
        m.apply(&serde_json::json!({"type":"entry_appended","entry":{"id":21,"kind":"pi.tool","model":[{"role":"toolResult","toolCallId":"chip-call","toolName":"edit","content":[{"type":"text","text":"Tool result, NOT a preview source"}],"isError":status=="failed"}]}}));
    }
    m
}
pub fn run_tool_diff_preview_probe(cx: &mut HeadlessAppContext) {
    let captures = std::env::var_os("PILOT_NEXT_TOOL_DIFF_DIR").map(std::path::PathBuf::from);
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
            let (writer, writes) = Interaction::recording();
            let mut m = model("pending", "  after 日本 <&>\nkeep");
            let rows = m.rows();
            let work = rows[0].id();
            let (h, v) = cx
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
                                let v = LocalViewer::preview(PreviewState::Conversation, w, cx);
                                v.editor
                                    .update(cx, |e, cx| e.shell_probe_setup(writer, w, cx));
                                v.transcript
                                    .update(cx, |t, cx| t.replace_readonly(rows, true, cx));
                                v
                            })
                        },
                    )
                })
                .unwrap();
            settle(cx, h);
            let (t, input) = cx.update(|cx| {
                (
                    v.read(cx).transcript.clone(),
                    v.read(cx).editor.read(cx).shell_probe().0,
                )
            });
            cx.update_window(h, |_, w, cx| {
                assert!(
                    w.try_find("tool-diff-chip").is_none(),
                    "No silent Working expansion"
                );
                w.click(SharedString::from(format!("work-toggle-{work}")), cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                input.update(cx, |i, cx| {
                    i.focus(w, cx);
                    i.replace_text_in_range(None, "Kept draft", w, cx);
                    i.replace_and_mark_text_in_range(None, "に", Some(1..1), w, cx);
                });
                w.click("tool-diff-chip", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(
                    w.try_find("tool-diff-preview").is_none(),
                    "Sibling preedit guards chip before blur"
                );
                input.update(cx, |i, cx| {
                    let range = i.marked_text_range(w, cx).unwrap();
                    i.replace_text_in_range(Some(range), "", w, cx);
                });
            })
            .unwrap();
            settle(cx, h);
            let draft = cx.update(|cx| input.read(cx).value().to_string());
            let anchor = cx.update(|cx| t.read(cx).history_probe_anchor(cx));
            cx.update_window(h, |_, w, cx| w.click("tool-diff-chip", cx))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                let panel = w.find("tool-diff-preview").bounds();
                let chip = w.find("tool-diff-chip").bounds();
                assert!(panel.size.width <= px(460.));
                assert!(panel.size.height < px(420.));
                assert!(panel.left() >= px(0.) && panel.right() <= px(width));
                assert!(
                    (panel.top() - chip.bottom()).abs() < px(430.),
                    "Anchored popup"
                );
                assert_eq!(
                    w.find("tool-diff-status").label(),
                    Some("Proposed changes · tool pending")
                );
                w.click("tool-diff-copy", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update(|cx| {
                let copy = cx.read_from_clipboard().unwrap().text().unwrap();
                assert_eq!(copy,"--- src/日本👩‍💻é/very-long-component-name.rs\n+++ src/日本👩‍💻é/very-long-component-name.rs\n@@ replacement hunk @@\n-  before <&>\n+  after 日本 <&>\n");
                assert_eq!(t.read(cx).history_probe_anchor(cx), anchor);
                assert_eq!(
                    t.read(cx).disclosure_probe_step("chip-call", cx),
                    (false, 0)
                );
            });
            let source_bounds = cx
                .update_window(h, |_, w, _| w.find("tool-diff-source").bounds())
                .unwrap();
            let shot = cx.capture_screenshot(h).unwrap();
            let scale = shot.width() as f32 / width;
            let (panel, color) = cx
                .update_window(h, |_, w, cx| {
                    let c: gpui_kit::Rgba = cx.theme().popover.into();
                    (
                        w.find("tool-diff-preview").bounds(),
                        [c.r, c.g, c.b].map(|v| (v * 255.).round() as u8),
                    )
                })
                .unwrap();
            for dy in 4..60 {
                let pixel = shot
                    .get_pixel(
                        ((f32::from(panel.left()) - 4.) * scale) as u32,
                        ((f32::from(panel.top()) + dy as f32) * scale) as u32,
                    )
                    .0;
                assert_eq!(
                    [pixel[0], pixel[1], pixel[2]],
                    color,
                    "opaque shared popover padding"
                );
            }
            let mut added = 0;
            let mut removed = 0;
            for y in (f32::from(source_bounds.top()) * scale) as u32
                ..(f32::from(source_bounds.bottom()) * scale) as u32
            {
                for x in (f32::from(source_bounds.left()) * scale) as u32
                    ..(f32::from(source_bounds.right()) * scale) as u32
                {
                    let [r, g, b, _] = shot.get_pixel(x, y).0.map(u16::from);
                    added += usize::from(g > r + 20 && g * 10 > b * 12);
                    removed += usize::from(r * 10 > g * 15 && r * 10 > b * 15);
                }
            }
            assert!(
                added > 10 && removed > 10,
                "Native diff glyph colors: add={added}, remove={removed}"
            );
            if let Some(p) = &captures {
                shot.save(p.join(format!(
                    "diff-{width}-{}.png",
                    if dark { "dark" } else { "light" }
                )))
                .unwrap();
            }
            cx.update_window(h, |_, w, cx| w.press("escape", cx))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, _| {
                assert!(w.try_find("tool-diff-preview").is_none());
                assert_eq!(w.find("tool-diff-trigger-focus").focused(), Some(true));
            })
            .unwrap();
            // Real keyboard activation and close. Enter must not reach the composer.
            cx.update_window(h, |_, w, cx| w.press("enter", cx))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(w.find("tool-diff-preview").visible());
                w.click("tool-diff-close", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, _| {
                assert_eq!(w.find("tool-diff-trigger-focus").focused(), Some(true))
            })
            .unwrap();
            // Output-only streaming retains the captured tool-local source and
            // reading intent. It may not replace it with a result-shaped diff.
            let mut streaming = model("running", "stream source");
            let rows = streaming.rows();
            cx.update(|cx| t.update(cx, |t, cx| t.replace_readonly(rows, false, cx)));
            settle(cx, h);
            cx.update_window(h, |_, w, cx| w.click("tool-diff-chip", cx))
                .unwrap();
            settle(cx, h);
            let mark = cx.update(|cx| t.read(cx).history_probe_anchor(cx));
            streaming.apply(&serde_json::json!({"type":"tool_execution_update","toolCallId":"chip-call","output":{"set":"--- fake\n+++ fake\n+NOT THE SOURCE"}}));
            let mut rows = streaming.rows();
            rows.extend((500..530).map(|id| {
                Message::live(
                    id,
                    "assistant".into(),
                    "Unrelated streaming publication below the reading anchor. ".repeat(12),
                )
            }));
            cx.update(|cx| t.update(cx, |t, cx| t.replace_readonly(rows, false, cx)));
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(w.find("tool-diff-preview").visible());
                w.press("enter", cx);
                w.click("tool-diff-copy", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update(|cx| {
                assert_eq!(t.read(cx).history_probe_anchor(cx), mark);
                let copy = cx.read_from_clipboard().unwrap().text().unwrap();
                assert!(copy.contains("+stream source"));
                assert!(!copy.contains("fake"));
            });
            // Sibling editor preedit protects Close before blur. Its Input
            // Escape action must not accidentally close the preview either.
            cx.update_window(h, |_, w, cx| {
                input.update(cx, |i, cx| {
                    i.focus(w, cx);
                    i.replace_and_mark_text_in_range(None, "に", Some(1..1), w, cx);
                });
                w.click("tool-diff-close", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(w.find("tool-diff-preview").visible());
                w.press("escape", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(w.find("tool-diff-preview").visible());
                input.update(cx, |i, cx| {
                    let end = i.value().encode_utf16().count();
                    i.replace_text_in_range(Some(0..end), &draft, w, cx);
                });
                w.click("tool-diff-close", cx);
            })
            .unwrap();
            settle(cx, h);
            for (status, new) in [
                ("failed", "+failed attempt".into()),
                ("unknown", "interrupted attempt".into()),
                ("complete", "日本".repeat(1800)),
            ] {
                let mut next = model(status, &new);
                let rows = next.rows();
                cx.update(|cx| t.update(cx, |t, cx| t.replace_readonly(rows, false, cx)));
                settle(cx, h);
                cx.update_window(h, |_, w, cx| w.click("tool-diff-chip", cx))
                    .unwrap();
                settle(cx, h);
                cx.update_window(h, |_, w, cx| {
                    assert_eq!(
                        w.find("tool-diff-status").label(),
                        Some(if status == "failed" {
                            "Attempted changes · tool failed"
                        } else if status == "unknown" {
                            "Attempted changes · completion unknown"
                        } else {
                            "Tool completed · argument preview"
                        })
                    );
                    assert_eq!(
                        w.try_find("tool-diff-coverage").is_some(),
                        status == "complete"
                    );
                    w.click("tool-diff-copy", cx);
                })
                .unwrap();
                settle(cx, h);
                cx.update(|cx| {
                    let copy = cx.read_from_clipboard().unwrap().text().unwrap();
                    assert!(copy.len() <= 6144);
                    assert!(!copy.contains("Tool result"));
                });
                // Changed source must invalidate open content and old copy callbacks.
                let mut next = model("pending", "different source");
                let rows = next.rows();
                cx.update(|cx| t.update(cx, |t, cx| t.replace_readonly(rows, false, cx)));
                settle(cx, h);
                cx.update_window(h, |_, w, _| {
                    assert!(w.try_find("tool-diff-preview").is_none())
                })
                .unwrap();
            }
            // Explicit group collapse retires the preview, never reopens it.
            cx.update_window(h, |_, w, cx| w.click("tool-diff-chip", cx))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                w.click(SharedString::from(format!("work-toggle-{work}")), cx)
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(w.try_find("tool-diff-preview").is_none());
                w.click(SharedString::from(format!("work-toggle-{work}")), cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(w.try_find("tool-diff-preview").is_none());
                w.click("tool-diff-chip", cx);
            })
            .unwrap();
            settle(cx, h);
            // Same numeric/call keys in a new session scope cannot adopt the
            // old popup or old clipboard action. Restore mounted reader focus.
            let mut replacement = model("pending", "NEW SESSION SOURCE");
            let rows = replacement.rows();
            cx.update(|cx| t.update(cx, |t, cx| t.replace_readonly(rows, true, cx)));
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(w.try_find("tool-diff-preview").is_none());
                assert!(w.try_find("tool-diff-chip").is_none());
                assert!(
                    t.read(cx).find_focused(w, cx),
                    "Reset restored mounted reader focus"
                );
            })
            .unwrap();
            cx.update(|cx| {
                assert_eq!(input.read(cx).value().as_ref(), draft);
                assert!(writes.try_recv().is_err(), "No sends or writes");
            });
            cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
            println!(
                "tool-diff-preview {width} dark={dark}: passed pointer/keyboard/status/copy/source/focus/preedit/anchor"
            );
        }
    }
}
