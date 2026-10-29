//! Trusted bounded path/text painting, never source interpretation or dynamic SVG.
use crate::visual_canvas_plan::{Plan, Primitive};
use gpui_kit::{
    App, Bounds, ContentMask, FontWeight, Hsla, Path, PathVertex, Pixels, SharedString, TextAlign,
    TextRun, Window, point, px,
};
pub(crate) fn palette(cx: &App) -> [Hsla; 13] {
    [
        "text", "muted", "accent", "success", "warning", "danger", "border", "chart1", "chart2",
        "chart3", "chart4", "chart5", "chart6",
    ]
    .map(|n| crate::visual_chart_view::color(n, cx))
}
pub(crate) fn paint_scaled(
    plan: &Plan,
    bounds: Bounds<Pixels>,
    colors: &[Hsla; 13],
    mono: &SharedString,
    scale: f32,
    window: &mut Window,
    cx: &mut App,
) {
    if (f32::from(bounds.size.width) / scale - plan.width).abs() > 0.75
        || (f32::from(bounds.size.height) / scale - plan.height).abs() > 0.75
    {
        return;
    }
    // Shapes may extend past the canvas; clip them to it like any 2D canvas.
    window.with_content_mask(Some(ContentMask { bounds }), |window| {
        paint_primitives(plan, bounds, colors, mono, scale, window, cx)
    });
}
fn paint_primitives(
    plan: &Plan,
    bounds: Bounds<Pixels>,
    colors: &[Hsla; 13],
    mono: &SharedString,
    scale: f32,
    window: &mut Window,
    cx: &mut App,
) {
    let at = |p: [f32; 2]| bounds.origin + point(px(p[0] * scale), px(p[1] * scale));
    for primitive in &plan.primitives {
        match primitive {
            // Tessellated off the UI thread; painting only places the vertices.
            Primitive::Triangles {
                vertices,
                bounds: [lo, hi],
                color,
                opacity,
            } => {
                if vertices.is_empty() {
                    continue;
                }
                let mut path = Path::new(at(*lo));
                path.bounds = Bounds::from_corners(at(*lo), at(*hi));
                path.vertices = vertices
                    .iter()
                    .map(|&p| PathVertex {
                        xy_position: at(p),
                        st_position: point(0., 1.),
                        content_mask: Default::default(),
                    })
                    .collect();
                let mut color = colors[*color];
                color.a *= *opacity;
                window.paint_path(path, color);
            }
            Primitive::Text {
                text,
                at,
                color,
                opacity,
                size,
                weight,
                align,
                baseline,
                mono: fixed,
            } => {
                if text.is_empty() || *opacity == 0. {
                    continue;
                }
                let mut font = window.text_style().font();
                font.weight = FontWeight(*weight);
                if *fixed {
                    font.family = mono.clone();
                }
                let mut color = colors[*color];
                color.a *= *opacity;
                let run = TextRun {
                    len: text.len(),
                    font,
                    color,
                    background_color: None,
                    underline: None,
                    strikethrough: None,
                };
                let line = window.text_system().shape_line(
                    SharedString::from(text.clone()),
                    px(*size * scale),
                    &[run],
                    None,
                );
                let x = match align {
                    1 => line.width() / 2.,
                    2 => line.width(),
                    _ => px(0.),
                };
                let y = match baseline {
                    1 => px(*size * scale / 2.),
                    2 => px(*size * scale),
                    _ => px(0.),
                };
                let origin = bounds.origin + point(px(at[0] * scale) - x, px(at[1] * scale) - y);
                let _ = line.paint(origin, px(*size * scale), TextAlign::Left, None, window, cx);
            }
        }
    }
}
