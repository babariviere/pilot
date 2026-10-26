//! Production ui.mermaid arm mounted in ArtifactPane, never a mock drawing.
use super::*;
use gpui_kit::{
    AnyWindowHandle, Bounds, HeadlessAppContext, ScrollDelta, WindowBounds, WindowOptions,
    component::ThemeMode, point, size, test::TestWindowExt,
};
use std::time::Duration;
const SOURCE: &str = "flowchart TD\nA[Receive request] --> B{Valid?}\nB -->|yes| C(Store)\nB -->|no| D[Reject]\nC --> E[Done]\nD --> E";
fn frame(cx: &mut HeadlessAppContext, h: AnyWindowHandle) {
    cx.advance_clock(Duration::from_millis(16));
    cx.run_until_parked();
    cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
}
fn scene(source: &str) -> crate::visual_scene::Scene {
    crate::visual_scene::Scene::parse(json!({"api":1,"root":{"type":"column","gap":12,"children":[
        {"type":"text","runs":[{"text":"Request routing"}],"weight":600},
        {"type":"mermaid","source":source},
        {"type":"toggle","id":"0.2","label":"Preserved sibling control","value":true}
    ]}}))
    .unwrap()
}
pub fn run_native_mermaid_probe(cx: &mut HeadlessAppContext) {
    let captures = std::env::var_os("PILOT_NEXT_IMAGE_DIR").map(std::path::PathBuf::from);
    if let Some(dir) = &captures {
        std::fs::create_dir_all(dir).unwrap();
    }
    let baseline = std::env::var_os("PILOT_MERMAID_BASELINE").is_some();
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
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
            let prepared = scene(SOURCE);
            let (h, pane) = cx.update(|cx| {
                gpui_kit::open_window(
                    WindowOptions {
                        window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                            Default::default(),
                            size(px(width), px(900.)),
                        ))),
                        show: false,
                        focus: false,
                        ..Default::default()
                    },
                    cx,
                    |_, cx| {
                        cx.new(|cx| {
                            let mut pane = ArtifactPane::new();
                            pane.preview(
                                Reference {
                                    id: "diagram".into(),
                                    session: "synthetic".into(),
                                    title: "Routing".into(),
                                    kind: "visual".into(),
                                    revision: 1,
                                },
                                "Synthetic source, never executed".into(),
                                prepared,
                                cx,
                            );
                            pane
                        })
                    },
                )
                .unwrap()
            });
            let h: AnyWindowHandle = h;
            frame(cx, h);
            frame(cx, h);
            let prefix = cx.update(|_| format!("mermaid-{}-0.1", pane.entity_id()));
            let key = |suffix: &str| SharedString::from(format!("{prefix}-{suffix}"));
            if let Some(dir) = &captures {
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(dir.join(format!(
                        "{}-{}-{}.png",
                        width as u32,
                        mode.name(),
                        if baseline { "before" } else { "after" }
                    )))
                    .unwrap();
            }
            if baseline {
                cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
                println!("native Mermaid baseline {width} {}", mode.name());
                continue;
            }
            cx.update_window(h, |_, w, cx| {
                assert_eq!(cx.theme().mode, mode);
                let viewport = w.find(key("viewport")).bounds();
                let drawing = w.find(key("drawing")).bounds();
                assert!(viewport.size.width > px(400.) && viewport.size.width <= px(width));
                assert_eq!(drawing.size.height, viewport.size.height);
                let label = w.find(key("label-A"));
                assert!(label.visible());
                assert_eq!(label.label(), Some("Receive request"));
                let fitted = 208. * pane.read(cx).reader_scale();
                assert!((f32::from(label.bounds().size.width) - fitted).abs() < 1.);
                cx.write_to_clipboard(ClipboardItem::new_string("sentinel".into()));
                w.click(key("copy"), cx);
            })
            .unwrap();
            frame(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert_eq!(cx.read_from_clipboard().unwrap().text().unwrap(), SOURCE);
                w.click(key("source"), cx);
            })
            .unwrap();
            frame(cx, h);
            // Local diagram disclosure cannot toggle artifact JS source or reader state.
            cx.update_window(h, |_, w, cx| {
                assert!(w.find(key("source-viewport")).visible());
                assert!(!pane.read(cx).source);
                w.click(key("source"), cx);
            })
            .unwrap();
            frame(cx, h);
            // Reader zoom scales native paths AND selectable label geometry.
            cx.update_window(h, |_, w, cx| {
                w.click("reader-actual", cx);
                w.click("reader-in", cx);
            })
            .unwrap();
            for _ in 0..4 {
                frame(cx, h);
            }
            cx.update_window(h, |_, w, cx| {
                let b = w.find(key("label-A")).bounds();
                assert!(
                    (f32::from(b.size.width) - 260.).abs() < 1.,
                    "native label zoom geometry"
                );
                w.drag(
                    point(b.left() + px(1.), b.center().y),
                    point(b.right() - px(1.), b.center().y),
                    cx,
                );
                assert_eq!(
                    gpui_kit::base::TextSelection::selected_text(w, cx),
                    "Receive request"
                );
            })
            .unwrap();
            cx.update_window(h, |_, w, cx| {
                w.click("reader-in", cx);
                w.click("reader-in", cx);
            })
            .unwrap();
            for _ in 0..4 {
                frame(cx, h);
            }
            let old = cx
                .update_window(h, |_, w, cx| {
                    let old = w.find(key("drawing")).bounds().origin;
                    w.scroll(
                        "reader-viewport",
                        ScrollDelta::Pixels(point(px(0.), px(-180.))),
                        cx,
                    );
                    old
                })
                .unwrap();
            frame(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(w.find(key("drawing")).bounds().origin.y < old.y);
                w.press("secondary-0", cx);
            })
            .unwrap();
            for _ in 0..4 {
                frame(cx, h);
            }
            assert!(cx.update(|cx| pane.read(cx).zoom.scale.is_none()));
            cx.update_window(h, |_, w, cx| {
                w.click("reader-actual", cx);
            })
            .unwrap();
            frame(cx, h);
            // Replacing exact source/revision cannot retain old graph or copy payload.
            let (old_generation, old_reference, mut late) = cx.update(|cx| {
                let p = pane.read(cx);
                (
                    p.generation,
                    p.reference.clone().unwrap(),
                    p.snapshot.clone(),
                )
            });
            late.version = 999;
            cx.update_window(h, |_, _, cx| {
                let p = pane.read(cx);
                let mut r = p.reference.clone().unwrap();
                r.revision = 2;
                pane.update(cx, |p, cx| {
                    p.preview(
                        r,
                        "Synthetic replacement".into(),
                        scene("graph LR\nX[中文 👩🏽‍💻] --> Y[Done]"),
                        cx,
                    )
                });
            })
            .unwrap();
            frame(cx, h);
            frame(cx, h);
            cx.update_window(h, |_, _, cx| {
                pane.update(cx, |p, cx| {
                    p.accept(old_generation, &old_reference, late, cx);
                    assert_eq!(p.reference.as_ref().unwrap().revision, 2);
                    assert_eq!(
                        p.snapshot.scene.as_ref().unwrap().mermaids["0.1"]
                            .source
                            .as_ref(),
                        "graph LR\nX[中文 👩🏽‍💻] --> Y[Done]"
                    );
                })
            })
            .unwrap();
            cx.update_window(h, |_, w, cx| {
                assert_eq!(w.find(key("label-X")).label(), Some("中文 👩🏽‍💻"));
                w.click(key("copy"), cx);
            })
            .unwrap();
            frame(cx, h);
            cx.update_window(h, |_, _, cx| {
                assert_eq!(
                    cx.read_from_clipboard().unwrap().text().unwrap(),
                    "graph LR\nX[中文 👩🏽‍💻] --> Y[Done]"
                )
            })
            .unwrap();
            let long_label = "日本語の長い説明 👩🏽‍💻 é 中文 日本語の長い説明 👩🏽‍💻 é 中文";
            let long_source =
                format!("graph TD\nX[\"{long_label}\"] -->|long Unicode label 中文| Y[Done]");
            cx.update_window(h, |_, _, cx| {
                let r = pane.read(cx).reference.clone().unwrap();
                pane.update(cx, |p, cx| {
                    p.preview(r, "Long label fixture".into(), scene(&long_source), cx)
                });
            })
            .unwrap();
            frame(cx, h);
            frame(cx, h);
            cx.update_window(h, |_, w, cx| {
                let b = w.find(key("label-X"));
                assert!(b.visible());
                assert_eq!(b.label(), Some(long_label));
                assert!(b.bounds().size.height <= px(crate::native_mermaid::NODE_H));
                w.click(key("copy"), cx);
            })
            .unwrap();
            frame(cx, h);
            cx.update_window(h, |_, _, cx| {
                assert_eq!(
                    cx.read_from_clipboard().unwrap().text().unwrap(),
                    long_source
                )
            })
            .unwrap();
            if let Some(dir) = &captures {
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(dir.join(format!("{}-{}-long-labels.png", width as u32, mode.name())))
                    .unwrap();
            }
            cx.update_window(h, |_, _, cx| {
                let r = pane.read(cx).reference.clone().unwrap();
                pane.update(cx, |p, cx| {
                    p.preview(
                        r,
                        "Unsupported".into(),
                        scene("sequenceDiagram\nA->>B: Hello"),
                        cx,
                    )
                });
            })
            .unwrap();
            frame(cx, h);
            frame(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(w.find(key("source-viewport")).visible());
                assert_eq!(w.find(key("error")).label(), Some("Unsupported Mermaid"));
                w.click(key("copy"), cx);
            })
            .unwrap();
            frame(cx, h);
            cx.update_window(h, |_, _, cx| {
                assert_eq!(
                    cx.read_from_clipboard().unwrap().text().unwrap(),
                    "sequenceDiagram\nA->>B: Hello"
                )
            })
            .unwrap();
            if let Some(dir) = &captures {
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(dir.join(format!("{}-{}-unsupported.png", width as u32, mode.name())))
                    .unwrap();
            }
            cx.update_window(h, |_, _, cx| {
                let r = pane.read(cx).reference.clone().unwrap();
                pane.update(cx, |p, cx| {
                    p.preview(
                        r,
                        "Invalid legacy Mermaid".into(),
                        scene("graph TD\nA -->"),
                        cx,
                    )
                });
            })
            .unwrap();
            frame(cx, h);
            frame(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert_eq!(w.find(key("error")).label(), Some("Invalid Mermaid"));
                assert!(w.find(key("source-viewport")).visible());
                assert!(
                    w.try_find(key("drawing")).is_none(),
                    "invalid syntax must not paint a partial graph"
                );
                w.click(key("copy"), cx);
            })
            .unwrap();
            frame(cx, h);
            cx.update_window(h, |_, _, cx| {
                assert_eq!(
                    cx.read_from_clipboard().unwrap().text().unwrap(),
                    "graph TD\nA -->"
                )
            })
            .unwrap();
            if let Some(dir) = &captures {
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(dir.join(format!("{}-{}-invalid.png", width as u32, mode.name())))
                    .unwrap();
            }
            cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
            println!(
                "native Mermaid {width} {}: bounds/paint/source/copy/keyboard/expand/pan/replacement/unsupported",
                mode.name()
            );
        }
    }
}
