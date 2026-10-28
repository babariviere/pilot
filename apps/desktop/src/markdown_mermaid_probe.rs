//! Production transcript rows with ordinary Markdown Mermaid fences, synthetic sources only.
use super::*;
use gpui_kit::{
    AnyWindowHandle, Bounds, ClipboardItem, EntityInputHandler, Focusable, HeadlessAppContext,
    ScrollDelta, WindowBounds, WindowOptions, point, size,
    test::{TestQueryExt, TestWindowExt},
};

const DIAGRAM: &str = "flowchart LR\nA[Receive 👩🏽‍💻 request] -->|ok| B(Store)";
const REVISED: &str = "graph TD\nX[Revised] --> Y[Later]";
const UNSUPPORTED: &str = "sequenceDiagram\nA->>B: unsupported";
const STREAMING: &str = "graph TD\nS[Streaming] --> T[Tail]";

fn settle(cx: &mut HeadlessAppContext, h: AnyWindowHandle) {
    for _ in 0..8 {
        cx.run_until_parked();
        cx.advance_clock(Duration::from_millis(16));
        cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
    }
}
fn fenced(body: &str) -> String {
    format!("```mermaid\n{body}\n```")
}
fn first(body: &str) -> String {
    format!("Routing overview\n\n{}\n\nAfter the diagram.", fenced(body))
}
fn unsupported() -> String {
    format!("Unsupported grammar:\n\n{}", fenced(UNSUPPORTED))
}
fn streaming() -> String {
    format!("Still streaming:\n\n```mermaid\n{STREAMING}\n")
}
fn row(id: u64, text: String) -> Message {
    Message::live(id, "assistant".into(), text).anchored(crate::model::ReaderKey::model(
        id,
        0,
        Some(0),
    ))
}
fn rows(diagram: &str, stream: String) -> Vec<Message> {
    let mut rows = vec![
        row(1, first(diagram)),
        row(2, unsupported()),
        row(3, stream),
        row(4, "```rust\nfn main() {}\n```".into()),
    ];
    rows.extend((5..12).map(|id| row(id, format!("Filler {id}. {}", "Calm prose. ".repeat(60)))));
    rows
}
/// The renderer's own key: owner row plus the fence's source byte offset.
fn key(id: u64, source: &str, suffix: &str) -> SharedString {
    let start = source.find("```mermaid").unwrap();
    if suffix.is_empty() {
        format!("mermaid-fence-{id}-{start}").into()
    } else {
        format!("mermaid-fence-{id}-{start}-{suffix}").into()
    }
}
fn top_mark() -> crate::navigation::ReadingMark {
    crate::navigation::ReadingMark {
        message: Some(crate::model::ReaderKey::model(1, 0, Some(0))),
        offset: 0.,
        following: false,
    }
}

pub fn run_markdown_mermaid_probe(cx: &mut HeadlessAppContext) {
    let captures = std::env::var_os("PILOT_NEXT_MERMAID_FENCE_DIR").map(std::path::PathBuf::from);
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
            let (writer, _writes) = Interaction::recording();
            let (client, _commands) = LocalClient::synthetic_commands();
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
                                let mut v = LocalViewer::preview(PreviewState::Conversation, w, cx);
                                v.client = Some(client);
                                v.editor
                                    .update(cx, |e, cx| e.shell_probe_setup(writer, w, cx));
                                v.transcript.update(cx, |t, cx| {
                                    t.replace_readonly(rows(DIAGRAM, streaming()), true, cx);
                                    t.restore_reading(top_mark(), cx);
                                });
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
            let one = first(DIAGRAM);
            let two = unsupported();
            // Closed fence: native diagram at natural height, no inner cap.
            cx.update_window(h, |_, w, cx| {
                assert_eq!(cx.theme().mode.is_dark(), dark);
                let viewport = w.find(key(1, &one, "viewport")).bounds();
                let drawing = w.find(key(1, &one, "drawing")).bounds();
                assert!(viewport.size.width > px(200.) && viewport.right() <= px(width));
                let band = px(crate::native_mermaid_view::actions_band(1.));
                assert_eq!(
                    drawing.size.height + band,
                    viewport.size.height,
                    "natural height"
                );
                let label = w.find(key(1, &one, "label-A"));
                assert!(label.visible());
                assert_eq!(label.label(), Some("Receive 👩🏽‍💻 request"));
                let text = t.read(cx).history_probe_row(1).read(cx).bounds();
                assert!(
                    viewport.top() > text.top() + px(12.),
                    "intro paragraph first"
                );
                assert!(
                    text.bottom() > viewport.bottom() + px(12.),
                    "text continues after"
                );
                // Unsupported grammar: explicit native-only reason, exact source, no cap.
                let error = w.find(key(2, &two, "error"));
                assert_eq!(error.label(), Some("Unsupported Mermaid"));
                let source = w.find(key(2, &two, "source-viewport")).bounds();
                assert!(
                    source.size.height < px(240.),
                    "short source keeps its natural height"
                );
                assert!(w.try_find(key(2, &two, "viewport")).is_none());
                // Unclosed streaming fence and other languages stay ordinary code.
                let three = streaming();
                assert!(three.contains("```mermaid"));
                assert!(w.find_all(key(3, &three, "")).is_empty());
                assert!(
                    w.elements()
                        .iter()
                        .all(|e| !format!("{:?}", e.path()).contains("mermaid-fence-4-"))
                );
            })
            .unwrap();
            if let Some(p) = &captures {
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(p.join(format!("fence-{width}-{dark}.png")))
                    .unwrap();
            }
            // Exact copies: Mermaid body, unsupported body, full message source.
            for (target, expected) in [
                (key(1, &one, "copy"), DIAGRAM.to_string()),
                (key(2, &two, "copy"), UNSUPPORTED.to_string()),
            ] {
                cx.update_window(h, |_, w, cx| {
                    cx.write_to_clipboard(ClipboardItem::new_string("sentinel".into()));
                    w.click(target, cx);
                    assert_eq!(cx.read_from_clipboard().unwrap().text().unwrap(), expected);
                })
                .unwrap();
            }
            cx.update_window(h, |_, w, cx| {
                crate::transcript_view::click_copy(w, 1, cx);
                assert_eq!(cx.read_from_clipboard().unwrap().text().unwrap(), one);
            })
            .unwrap();
            // Selecting across the message takes the diagram as its exact source.
            cx.update_window(h, |_, w, cx| {
                let b = t.read(cx).history_probe_row(1).read(cx).bounds();
                w.drag(
                    point(b.left() + px(2.), b.top() + px(8.)),
                    point(b.left() + px(120.), b.bottom() - px(8.)),
                    cx,
                );
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                w.press("secondary-c", cx);
                let copied = cx.read_from_clipboard().unwrap().text().unwrap();
                assert!(copied.contains("Routing overview"), "{copied}");
                assert!(copied.contains(DIAGRAM), "{copied}");
                assert!(copied.contains("After the"), "{copied}");
            })
            .unwrap();
            // Source disclosure, then keyboard back to the diagram.
            cx.update_window(h, |_, w, cx| w.click(key(1, &one, "source"), cx))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, _| {
                let source = w.find(key(1, &one, "source-viewport"));
                assert!(source.visible());
                assert!(source.bounds().size.height < px(240.));
                assert_eq!(w.find(key(1, &one, "")).focused(), Some(true));
            })
            .unwrap();
            cx.update_window(h, |_, w, cx| w.press("tab", cx)).unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, _| {
                assert_eq!(w.find(key(1, &one, "source")).focused(), Some(true));
            })
            .unwrap();
            cx.update_window(h, |_, w, cx| w.press("space", cx))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, _| {
                assert!(w.find(key(1, &one, "viewport")).visible());
                assert!(w.try_find(key(1, &one, "source-viewport")).is_none());
            })
            .unwrap();
            // Vertical wheel over the diagram scrolls the conversation.
            let before = cx
                .update_window(h, |_, w, _| w.find(key(1, &one, "viewport")).bounds().top())
                .unwrap();
            cx.update_window(h, |_, w, cx| {
                w.scroll(
                    key(1, &one, "viewport"),
                    ScrollDelta::Pixels(point(px(0.), px(-120.))),
                    cx,
                )
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, _| {
                let after = w.find(key(1, &one, "viewport")).bounds().top();
                assert!(after < before - px(60.), "{before:?} -> {after:?}");
            })
            .unwrap();
            cx.update(|cx| t.update(cx, |t, cx| t.restore_reading(top_mark(), cx)));
            settle(cx, h);
            // Composer draft and marked preedit survive late revisions.
            cx.update_window(h, |_, w, cx| {
                input.update(cx, |i, cx| {
                    i.focus(w, cx);
                    i.replace_text_in_range(None, "Keep 👩🏽‍💻 draft", w, cx);
                    i.replace_and_mark_text_in_range(None, "にほん", Some(3..3), w, cx);
                })
            })
            .unwrap();
            settle(cx, h);
            let draft = cx.update(|cx| input.read(cx).value());
            // A prepend, a replaced diagram and the streaming fence closing.
            let mut late = rows(REVISED, streaming() + "```");
            late.insert(0, row(0, "Earlier".into()));
            cx.update(|cx| t.update(cx, |t, cx| t.replace_readonly(late, false, cx)));
            settle(cx, h);
            let revised = first(REVISED);
            let three = streaming() + "```";
            cx.update_window(h, |_, w, cx| {
                input.update(cx, |i, cx| {
                    assert_eq!(i.value(), draft);
                    assert!(i.marked_text_range(w, cx).is_some());
                    assert!(i.focus_handle(cx).is_focused(w));
                });
                assert_eq!(
                    t.read(cx).reading_mark(cx).unwrap().message,
                    Some(crate::model::ReaderKey::model(1, 0, Some(0))),
                    "prepend keeps the reading anchor"
                );
                assert_eq!(w.find(key(1, &revised, "label-X")).label(), Some("Revised"));
                assert!(w.try_find(key(1, &one, "label-A")).is_none());
                assert_eq!(w.find(key(3, &three, "label-S")).label(), Some("Streaming"));
            })
            .unwrap();
            cx.update_window(h, |_, w, cx| input.update(cx, |i, cx| i.unmark_text(w, cx)))
                .unwrap();
            // Following Latest stays at the tail while a fence completes.
            cx.update(|cx| {
                t.update(cx, |t, cx| {
                    t.replace_readonly(vec![row(20, streaming())], true, cx);
                    t.restore_reading(
                        crate::navigation::ReadingMark {
                            message: None,
                            offset: 0.,
                            following: true,
                        },
                        cx,
                    );
                })
            });
            settle(cx, h);
            cx.update(|cx| {
                t.update(cx, |t, cx| {
                    t.replace_readonly(vec![row(20, streaming() + "```\n\nDone.")], false, cx)
                })
            });
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(t.read(cx).reading_mark(cx).unwrap().following);
                let tail = streaming() + "```\n\nDone.";
                assert!(w.find(key(20, &tail, "label-S")).visible());
            })
            .unwrap();
            // Every direction at natural size: measured extent, one margin,
            // and bottom-corner actions clear of the diagram.
            let strict = std::env::var_os("PILOT_MERMAID_BASELINE").is_none();
            for d in ["LR", "RL", "TB", "BT"] {
                let body = crate::artifact_view::mermaid_probe::direction_source(d);
                let plan = crate::native_mermaid::prepare(&body).unwrap();
                let text = first(&body);
                cx.update(|cx| {
                    t.update(cx, |t, cx| {
                        t.replace_readonly(vec![row(30, text.clone())], true, cx);
                        t.restore_reading(
                            crate::navigation::ReadingMark {
                                message: Some(crate::model::ReaderKey::model(30, 0, Some(0))),
                                offset: 0.,
                                following: false,
                            },
                            cx,
                        );
                    })
                });
                settle(cx, h);
                cx.update_window(h, |_, w, _| {
                    let line = format!("Markdown Mermaid fence {width} dark={dark} {d}");
                    let key = |suffix: &str| key(30, &text, suffix);
                    crate::artifact_view::mermaid_probe::check_direction(
                        w, &key, &plan, 1., strict, &line,
                    );
                    let viewport = w.find(key("viewport")).bounds();
                    let drawing = w.find(key("drawing")).bounds();
                    let band = crate::native_mermaid_view::actions_band(1.);
                    assert_eq!(viewport.size.height, drawing.size.height + px(band));
                })
                .unwrap();
                if let Some(p) = &captures {
                    cx.capture_screenshot(h)
                        .unwrap()
                        .save(p.join(format!("fence-{width}-{dark}-{d}.png")))
                        .unwrap();
                }
            }
            cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
            println!(
                "Markdown Mermaid fence {width} dark={dark}: natural height/unsupported/streaming/copy/selection/keyboard/wheel/revision/preedit/follow"
            );
        }
    }
}
