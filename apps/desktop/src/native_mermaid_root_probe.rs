//! Real workbench/composer mounted alongside the production artifact pane.
use super::*;
use gpui_kit::{
    Bounds, EntityInputHandler, Focusable, HeadlessAppContext, WindowBounds, WindowOptions, size,
    test::TestWindowExt,
};
fn frame(cx: &mut HeadlessAppContext, h: gpui_kit::AnyWindowHandle) {
    for _ in 0..4 {
        cx.advance_clock(Duration::from_millis(16));
        cx.run_until_parked();
        cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
    }
}
pub fn run_native_mermaid_root_probe(cx: &mut HeadlessAppContext) {
    let (h, viewer) = cx.update(|cx| {
        gpui_kit::open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                    Default::default(),
                    size(px(1100.), px(900.)),
                ))),
                show: false,
                focus: false,
                ..Default::default()
            },
            cx,
            |w, cx| {
                cx.new(|cx| {
                    let v = LocalViewer::visual_preview(0, w, cx);
                    let (writer, _) = crate::interaction::Interaction::recording();
                    v.editor
                        .update(cx, |e, cx| e.shell_probe_setup(writer, w, cx));
                    v
                })
            },
        )
        .unwrap()
    });
    frame(cx, h);
    let (pane, input) = cx.update(|cx| {
        let v = viewer.read(cx);
        (v.artifacts.clone(), v.editor.read(cx).shell_probe().0)
    });
    cx.update_window(h, |_, w, cx| {
        input.update(cx, |i, cx| {
            i.focus(w, cx);
            i.replace_text_in_range(None, "Keep 👩🏽‍💻 draft", w, cx);
            i.replace_and_mark_text_in_range(None, "にほん", Some(3..3), w, cx);
        })
    })
    .unwrap();
    frame(cx, h);
    cx.update_window(h, |_, w, cx| {
        input.update(cx, |i, cx| {
            assert!(
                i.marked_text_range(w, cx).is_some(),
                "fixture must actually enter preedit before replacement"
            )
        })
    })
    .unwrap();
    let exact = cx.update(|cx| input.read(cx).value());
    for source in [
        "graph TD\nA[Arrives late] --> B[Done]",
        "graph LR\nX[Changed] --> Y[Later]",
        "sequenceDiagram\nA->>B: unsupported",
        "graph TD\nA -->",
    ] {
        let scene = crate::visual_scene::Scene::parse(
            serde_json::json!({"api":1,"root":{"type":"mermaid","source":source}}),
        )
        .unwrap();
        cx.update_window(h, |_, _, cx| {
            pane.update(cx, |p, cx| {
                p.preview(
                    crate::artifact_model::Reference {
                        id: "late".into(),
                        session: "synthetic".into(),
                        title: "Late diagram".into(),
                        kind: "visual".into(),
                        revision: 2,
                    },
                    "Inert synthetic source".into(),
                    scene,
                    cx,
                )
            })
        })
        .unwrap();
        frame(cx, h);
        cx.update_window(h, |_, w, cx| {
            input.update(cx, |i, cx| {
                assert_eq!(i.value(), exact);
                assert!(i.marked_text_range(w, cx).is_some());
                assert!(i.focus_handle(cx).is_focused(w));
            })
        })
        .unwrap();
    }
    cx.update_window(h, |_, w, cx| input.update(cx, |i, cx| i.unmark_text(w, cx)))
        .unwrap();
    frame(cx, h);
    let key = SharedString::from(format!("mermaid-{}-0-copy", pane.entity_id()));
    cx.update_window(h, |_, w, cx| w.click(key, cx)).unwrap();
    frame(cx, h);
    cx.update_window(h, |_, _, cx| {
        assert_eq!(
            cx.read_from_clipboard().unwrap().text().unwrap(),
            "graph TD\nA -->"
        );
        assert_eq!(input.read(cx).value(), exact);
    })
    .unwrap();
    cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
    println!(
        "native Mermaid workbench: late/source/unsupported replacements preserve composer focus, draft and marked preedit; exact local copy after unmark"
    );
}
