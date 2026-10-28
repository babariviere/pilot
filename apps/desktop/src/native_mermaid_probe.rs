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
/// Two ranks wide, edge labels, a word-wrapped Unicode label and a diamond.
pub(crate) fn direction_source(direction: &str) -> String {
    format!(
        "graph {direction}\nA[Receive 👩🏽‍💻 request] -->|ok| B{{Is it valid now?}}\nB -->|yes, store it| C(Store)\nA --> D[Reject]"
    )
}
/// The drawing is the plan at this scale. Node boxes (centred on their label
/// boxes) and the edge labels' reserved boxes lie inside it with at most one
/// scaled margin past the furthest of them, each rendered edge label fits its
/// reserved box, and the Source/Copy actions cover no node or label.
pub(crate) fn check_direction(
    w: &mut Window,
    key: &dyn Fn(&str) -> SharedString,
    plan: &crate::native_mermaid::Diagram,
    scale: f32,
    strict: bool,
    line: &str,
) {
    let drawing = w.find(key("drawing")).bounds();
    let mut drawn = Vec::new();
    for id in ["A", "B", "C", "D"] {
        let label = w.find(key(&format!("label-{id}")));
        let c = label.bounds().center();
        let half = point(px(120. * scale), px(44. * scale));
        drawn.push(Bounds::from_corners(c - half, c + half));
    }
    let mut content = drawn.clone();
    let mut fits = true;
    for ix in [0, 1] {
        let label = w.find(key(&format!("edge-label-{ix}"))).bounds();
        let route = &plan.routes[ix];
        let at = |p: [f32; 2]| drawing.origin + point(px(p[0] * scale), px(p[1] * scale));
        let reserved = Bounds::from_corners(
            at(route.label_at),
            at([
                route.label_at[0] + route.label_size[0],
                route.label_at[1] + route.label_size[1],
            ]),
        );
        fits &= label.right() <= reserved.right() + px(0.5)
            && label.bottom() <= reserved.bottom() + px(0.5);
        drawn.push(label);
        content.push(reserved);
    }
    let source = w.find(key("source")).bounds();
    let copy = w.find(key("copy")).bounds();
    let actions = Bounds::from_corners(source.origin, copy.bottom_right());
    let right = content
        .iter()
        .map(|b| b.right())
        .fold(px(0.), |a, b| a.max(b));
    let bottom = content
        .iter()
        .map(|b| b.bottom())
        .fold(px(0.), |a, b| a.max(b));
    let slack = (
        f32::from(drawing.right() - right),
        f32::from(drawing.bottom() - bottom),
    );
    let overlap = drawn.iter().any(|b| b.intersects(&actions));
    println!(
        "{line}: scale {scale:.3} drawing {:.0}x{:.0} slack {:.0}/{:.0} actions {actions:?} overlap {overlap} fits {fits}",
        f32::from(drawing.size.width),
        f32::from(drawing.size.height),
        slack.0,
        slack.1,
    );
    if !strict {
        return;
    }
    assert!((f32::from(drawing.size.width) - plan.width * scale).abs() < 0.5);
    assert!((f32::from(drawing.size.height) - plan.height * scale).abs() < 0.5);
    assert!(fits, "{line}: an edge label outgrew its reserved box");
    for b in &content {
        assert!(
            b.left() >= drawing.left() - px(0.5)
                && b.top() >= drawing.top() - px(0.5)
                && b.right() <= drawing.right() + px(0.5)
                && b.bottom() <= drawing.bottom() + px(0.5),
            "{line}: {b:?} clipped by {drawing:?}"
        );
    }
    let margin = 24. * scale + 0.5;
    assert!(
        slack.0 <= margin && slack.1 <= margin,
        "{line}: slack {slack:?}"
    );
    assert!(!overlap, "{line}: actions {actions:?} cover the diagram");
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
            // Every direction: the drawing is the measured extent of its nodes
            // and edge labels plus one margin, never a fixed empty band, and the
            // revealed actions stay clear of the diagram.
            for d in ["LR", "RL", "TB", "BT"] {
                let source = direction_source(d);
                let plan = crate::native_mermaid::prepare(&source).unwrap();
                cx.update_window(h, |_, _, cx| {
                    let r = pane.read(cx).reference.clone().unwrap();
                    pane.update(cx, |p, cx| {
                        p.preview(r, "Direction".into(), scene(&source), cx)
                    });
                })
                .unwrap();
                frame(cx, h);
                frame(cx, h);
                cx.update_window(h, |_, w, cx| {
                    let scale = pane.read(cx).reader_scale();
                    let line = format!("native Mermaid {width} {} {d}", mode.name());
                    check_direction(w, &key, &plan, scale, !baseline, &line);
                })
                .unwrap();
                if let Some(dir) = &captures {
                    cx.capture_screenshot(h)
                        .unwrap()
                        .save(dir.join(format!(
                            "{}-{}-{d}-{}.png",
                            width as u32,
                            mode.name(),
                            if baseline { "before" } else { "after" }
                        )))
                        .unwrap();
                }
            }
            if baseline {
                cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
                println!("native Mermaid baseline {width} {}", mode.name());
                continue;
            }
            cx.update_window(h, |_, _, cx| {
                let r = pane.read(cx).reference.clone().unwrap();
                pane.update(cx, |p, cx| {
                    p.preview(r, "Routing".into(), scene(SOURCE), cx)
                });
            })
            .unwrap();
            frame(cx, h);
            frame(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert_eq!(cx.theme().mode, mode);
                let viewport = w.find(key("viewport")).bounds();
                let drawing = w.find(key("drawing")).bounds();
                assert!(viewport.size.width > px(400.) && viewport.size.width <= px(width));
                let band = crate::native_mermaid_view::actions_band(pane.read(cx).reader_scale());
                assert!((drawing.size.height + px(band) - viewport.size.height).abs() < px(0.5));
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
