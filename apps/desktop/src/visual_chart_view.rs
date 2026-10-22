//! Trusted native primitives over a finite normalized plan. No dynamic SVG or image-cache churn.
use crate::visual_chart::Chart;
use gpui_kit::{
    AnyElement, Bounds, Context, Corners, Hsla, IntoElement, ParentElement, PathBuilder,
    SharedString, Styled, canvas,
    component::{ActiveTheme, StyledExt},
    div, fill, point, px, size,
};
use std::sync::Arc;
pub(crate) fn color(name: &str, cx: &gpui_kit::App) -> Hsla {
    let t = cx.theme();
    match name {
        "muted" => t.muted_foreground,
        "accent" => t.primary,
        "success" => t.success,
        "warning" => t.warning,
        "danger" => t.danger,
        "border" => t.border,
        "chart1" => t.chart_1,
        "chart2" => t.chart_2,
        "chart3" => t.chart_3,
        "chart4" => t.chart_4,
        "chart5" => t.chart_5,
        "chart6" => t.link,
        _ => t.foreground,
    }
}
pub(crate) fn render<T: 'static>(chart: Arc<Chart>, cx: &Context<T>) -> AnyElement {
    let colors = chart
        .series
        .iter()
        .map(|s| color(&s.color, cx))
        .collect::<Vec<_>>();
    let border = cx.theme().border;
    let height = chart.height;
    let mut view = div().v_flex().w_full().min_w_0().gap_1();
    let mut legend = div().h_flex().flex_wrap().gap_3();
    for (i, s) in chart.series.iter().enumerate() {
        legend = legend.child(
            div()
                .text_xs()
                .text_color(colors[i])
                .child(SharedString::from(s.name.clone())),
        );
    }
    view = view.child(legend);
    let (low, high) = chart.range;
    let caption = format!("{} to {} {}", number(low), number(high), chart.unit);
    let labels = chart.labels.clone();
    let band = labels.len() == 1
        || (chart.kind == "bar"
            && chart
                .series
                .first()
                .is_some_and(|s| s.points.len() == labels.len()));
    view.child(
        div().w_full().h(px(height)).overflow_hidden().child(
            canvas(
                |_, _, _| {},
                move |bounds, _, window, _| {
                    if bounds.size.width <= px(30.) || bounds.size.height <= px(20.) {
                        return;
                    }
                    let origin = bounds.origin + point(px(12.), px(8.));
                    let w = f32::from(bounds.size.width - px(24.));
                    let h = f32::from(bounds.size.height - px(16.));
                    let p = |(x, y): (f32, f32)| origin + point(px(x * w), px((1. - y) * h));
                    let zero = p((0., chart.baseline)).y;
                    window.paint_quad(fill(
                        Bounds::new(point(origin.x, zero), size(px(w), px(1.))),
                        border,
                    ));
                    for (i, s) in chart.series.iter().enumerate() {
                        let c = colors[i];
                        if chart.kind == "bar" || chart.kind == "scatter" {
                            for (x, y) in s.points.iter().flatten().copied() {
                                let at = p((x, y));
                                let r = if chart.kind == "scatter" {
                                    Bounds::new(at - point(px(3.), px(3.)), size(px(6.), px(6.)))
                                } else {
                                    let bw = (w / s.points.len().max(1) as f32 * 0.8
                                        / chart.series.len() as f32)
                                        .max(0.25);
                                    let dx = (i as f32 - (chart.series.len() - 1) as f32 / 2.) * bw;
                                    Bounds::new(
                                        point(at.x + px(dx - bw / 2.), at.y.min(zero)),
                                        size(px(bw), at.y.max(zero) - at.y.min(zero)),
                                    )
                                };
                                let mut q = fill(r, c);
                                if chart.kind == "scatter" {
                                    q.corner_radii = Corners::all(px(3.));
                                }
                                window.paint_quad(q);
                            }
                        } else {
                            for run in s.points.split(Option::is_none).filter(|r| !r.is_empty()) {
                                let points =
                                    run.iter().flatten().copied().map(p).collect::<Vec<_>>();
                                if chart.kind == "area" {
                                    let mut path = PathBuilder::fill();
                                    path.move_to(point(points[0].x, zero));
                                    for pt in &points {
                                        path.line_to(*pt);
                                    }
                                    path.line_to(point(points.last().unwrap().x, zero));
                                    path.close();
                                    if let Ok(path) = path.build() {
                                        let mut fill = c;
                                        fill.a *= 0.18;
                                        window.paint_path(path, fill);
                                    }
                                }
                                if points.len() == 1 {
                                    let mut dot = fill(
                                        Bounds::new(
                                            points[0] - point(px(2.), px(2.)),
                                            size(px(4.), px(4.)),
                                        ),
                                        c,
                                    );
                                    dot.corner_radii = Corners::all(px(2.));
                                    window.paint_quad(dot);
                                } else {
                                    let mut path = PathBuilder::stroke(px(1.8));
                                    path.move_to(points[0]);
                                    for pt in &points[1..] {
                                        path.line_to(*pt);
                                    }
                                    if let Ok(path) = path.build() {
                                        window.paint_path(path, c);
                                    }
                                }
                            }
                        }
                    }
                },
            )
            .size_full(),
        ),
    )
    .child(
        div()
            .h_flex()
            .justify_between()
            .gap_2()
            .px_3()
            .min_w_0()
            .text_xs()
            .text_color(cx.theme().muted_foreground)
            .children(labels.into_iter().map(|label| {
                let text = div().min_w_0().truncate().child(SharedString::from(label));
                if band {
                    text.flex_1().text_center()
                } else {
                    text
                }
            })),
    )
    .child(
        div()
            .text_xs()
            .text_color(cx.theme().muted_foreground)
            .child(SharedString::from(caption)),
    )
    .into_any_element()
}
pub(crate) fn number(value: f64) -> String {
    if value.abs() > 1e6 || (value != 0. && value.abs() < 0.001) {
        format!("{value:.3e}")
    } else {
        value.to_string()
    }
}
