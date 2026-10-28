//! Visual text spans, text alignment/line clamps and table column alignment.
use super::*;
use gpui_kit::{
    Bounds, FontStyle, FontWeight, HighlightStyle, TestAppContext, WindowBounds, WindowOptions,
    base::TextSelection,
    component::{Theme, ThemeMode},
    point, size,
    test::TestWindowExt,
};

fn reference() -> Reference {
    Reference {
        id: "text".into(),
        session: "owner".into(),
        revision: 1,
        title: "Text".into(),
        kind: "visual".into(),
    }
}

fn open(
    cx: &mut TestAppContext,
    width: f32,
    mode: ThemeMode,
    root: Value,
) -> gpui_kit::AnyWindowHandle {
    cx.update(|cx| {
        gpui_kit::init(cx);
        crate::init_appearance(cx);
        Theme::change(mode, None, cx);
    });
    let scene = crate::visual_scene::Scene::parse(json!({"api":1,"root":root})).unwrap();
    cx.update(|cx| {
        gpui_kit::open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                    Default::default(),
                    size(px(width), px(800.)),
                ))),
                show: false,
                focus: false,
                ..Default::default()
            },
            cx,
            |_, cx| {
                cx.new(|cx| {
                    let mut pane = ArtifactPane::new();
                    pane.preview(reference(), "Exact synthetic source".into(), scene, cx);
                    pane.inline_mode(true, cx);
                    pane
                })
            },
        )
        .unwrap()
        .0
    })
}

#[gpui_kit::test]
fn runs_keep_exact_text_and_override_node_style(cx: &mut TestAppContext) {
    cx.update(|cx| {
        gpui_kit::init(cx);
        crate::init_appearance(cx);
    });
    let value = json!({"type":"text","mono":true,"runs":[
        {"text":"Bold ","weight":700},
        {"text":"","italic":true},
        {"text":"prose","mono":false,"italic":true,"color":"danger"},
        {"text":" 日本語 👩🏽‍💻","strike":true,"mono":true},
        {"text":" plain"}
    ]});
    cx.update(|cx| {
        let (text, highlights, families) = text_runs(&value, cx);
        assert_eq!(text, "Bold prose 日本語 👩🏽‍💻 plain");
        let theme = cx.theme();
        let bold = 0.."Bold ".len();
        let prose = bold.end..bold.end + "prose".len();
        let strike = prose.end..prose.end + " 日本語 👩🏽‍💻".len();
        let plain = strike.end..text.len();
        assert_eq!(
            highlights,
            vec![
                (
                    bold,
                    HighlightStyle {
                        font_weight: Some(FontWeight(700.)),
                        ..Default::default()
                    }
                ),
                (
                    prose.clone(),
                    HighlightStyle {
                        color: Some(theme.danger),
                        font_style: Some(FontStyle::Italic),
                        ..Default::default()
                    }
                ),
                (
                    strike,
                    HighlightStyle {
                        strikethrough: Some(gpui_kit::StrikethroughStyle {
                            thickness: px(1.),
                            color: None,
                        }),
                        ..Default::default()
                    }
                ),
                (plain, HighlightStyle::default()),
            ],
            "empty runs are skipped; plain runs keep their own boundary"
        );
        // Only a run that differs from the node's mono switches family.
        assert_eq!(families, vec![(prose, theme.font_family.clone())]);
    });
}

#[test]
fn numeric_columns_default_to_end() {
    let columns = [
        json!({"label":"Name"}),
        json!({"label":"Count"}),
        json!({"label":"Gaps"}),
        json!({"label":"Mixed"}),
        json!({"label":"Forced","align":"start"}),
        json!({"label":"Empty"}),
        json!({"label":"Centered","align":"center"}),
    ];
    let rows = [
        json!(["a", 1, null, 1, 2, null, "x"]),
        json!(["b", 2.5, 3, "two", 4, null, "y"]),
    ];
    assert_eq!(
        column_aligns(&columns, &rows),
        ["start", "end", "end", "start", "start", "start", "center"]
    );
}

#[gpui_kit::test]
fn aligned_text_and_table_cells_stay_selectable_and_exact(cx: &mut TestAppContext) {
    let long = "Wrapped 日本語 résumé 👩🏽‍💻 text ".repeat(12);
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            let root = json!({"type":"column","children":[
                {"type":"text","align":"end","runs":[{"text":"Total ","weight":600},{"text":"42 €","mono":true}]},
                {"type":"text","align":"center","runs":[{"text":"Centered"}]},
                {"type":"text","align":"end","runs":[{"text":long}]},
                {"type":"table","columns":[{"label":"Item"},{"label":"Qty"},{"label":"Note","align":"center"}],
                 "rows":[["Apples",12,"ok"],["Pears",null,"résumé"],["Figs",3.5,"x"]]}
            ]});
            let h = open(cx, width, mode, root);
            cx.update_window(h, |_, w, cx| {
                w.render_frame(cx);
                let end = w.find("0.0").bounds();
                let total = w.find("0.0-text").bounds();
                assert!(
                    (total.right() - end.right()).abs() < px(1.),
                    "end hugs the trailing edge"
                );
                assert!(
                    total.left() > end.left() + px(100.),
                    "short end text does not fill"
                );
                let center = w.find("0.1").bounds();
                let centered = w.find("0.1-text").bounds();
                assert!((centered.center().x - center.center().x).abs() < px(1.));
                // Long aligned text still wraps inside its column.
                let wrapped = w.find("0.2-text").bounds();
                let column = w.find("0.2").bounds();
                assert!(wrapped.size.height > total.size.height * 2.);
                assert!(
                    wrapped.left() >= column.left() - px(1.)
                        && wrapped.right() <= column.right() + px(1.)
                );
                // Numeric column ends; text column starts; explicit center centers.
                for row in 0..3 {
                    let qty = w.find(format!("0.3-{row}-1")).bounds();
                    let figure = w.find(format!("0.3-{row}-1-text")).bounds();
                    assert!((figure.right() - qty.right()).abs() < px(1.));
                    let note = w.find(format!("0.3-{row}-2")).bounds();
                    let noted = w.find(format!("0.3-{row}-2-text")).bounds();
                    assert!((noted.center().x - note.center().x).abs() < px(1.));
                }
                assert!(
                    w.try_find("0.3-0-0-text").is_none(),
                    "start cells keep the plain structure"
                );
                // Selection and copy stay the exact source for styled, aligned text.
                w.drag(
                    point(total.left() + px(1.), total.center().y),
                    point(total.right() - px(1.), total.center().y),
                    cx,
                );
                assert_eq!(TextSelection::selected_text(w, cx), "Total 42 €");
                let figure = w.find("0.3-0-1-text").bounds();
                w.drag(
                    point(figure.left() + px(1.), figure.center().y),
                    point(figure.right() - px(1.), figure.center().y),
                    cx,
                );
                assert_eq!(TextSelection::selected_text(w, cx), "12");
                w.drag(
                    point(wrapped.left() + px(1.), wrapped.top() + px(2.)),
                    point(wrapped.right() - px(1.), wrapped.bottom() - px(2.)),
                    cx,
                );
                assert_eq!(TextSelection::selected_text(w, cx), long);
                w.remove_window();
            })
            .unwrap();
        }
    }
}

#[gpui_kit::test]
fn line_clamp_clips_whole_lines_and_keeps_exact_source(cx: &mut TestAppContext) {
    let long = "Clamped 日本語 résumé 👩🏽‍💻 words ".repeat(20);
    let root = json!({"type":"column","children":[
        {"type":"text","lines":2,"italic":true,"runs":[{"text":long.clone()},{"text":" tail","weight":700}]},
        {"type":"text","runs":[{"text":long.clone()}]}
    ]});
    let h = open(cx, 680., ThemeMode::Light, root);
    cx.update_window(h, |_, w, cx| {
        w.render_frame(cx);
        let clamped = w.find("0.0").bounds();
        let free = w.find("0.1").bounds();
        let line = px((15. * LINE_HEIGHT).round());
        // The text box keeps its full layout; the clamping parent shows two lines.
        let shown = free.top() - clamped.top() - px(12.);
        assert!(
            (shown - line * 2.).abs() < px(1.),
            "two full lines: {shown:?}"
        );
        assert!(
            free.size.height > line * 3.,
            "the unclamped copy wraps further"
        );
        // The first visible line selects an exact prefix of the source.
        w.drag(
            point(clamped.left() + px(1.), clamped.top() + line / 2.),
            point(clamped.right() - px(1.), clamped.top() + line / 2.),
            cx,
        );
        let selected = TextSelection::selected_text(w, cx);
        assert!(
            !selected.is_empty() && long.starts_with(&selected),
            "{selected:?}"
        );
        w.remove_window();
    })
    .unwrap();
}
