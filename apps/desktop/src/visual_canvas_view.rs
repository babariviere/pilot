//! Trusted bounded path/text painting, never source interpretation or dynamic SVG.
use crate::visual_canvas_plan::{Plan, Primitive};
use gpui_kit::{
    App, Bounds, FontWeight, Hsla, PathBuilder, Pixels, SharedString, TextAlign, TextRun, Window,
    point, px,
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
    for primitive in &plan.primitives {
        match primitive {
            Primitive::Path {
                points,
                closed,
                paint,
            } => {
                if points.is_empty() || paint.opacity == 0. || (paint.stroke && paint.width == 0.) {
                    continue;
                }
                let mut builder = if paint.stroke {
                    PathBuilder::stroke(px(paint.width * scale))
                } else {
                    PathBuilder::fill()
                };
                builder.move_to(
                    bounds.origin + point(px(points[0][0] * scale), px(points[0][1] * scale)),
                );
                for p in &points[1..] {
                    builder.line_to(bounds.origin + point(px(p[0] * scale), px(p[1] * scale)));
                }
                if *closed || !paint.stroke {
                    builder.close();
                }
                if let Ok(path) = builder.build() {
                    let mut color = colors[paint.color];
                    color.a *= paint.opacity;
                    window.paint_path(path, color);
                }
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
