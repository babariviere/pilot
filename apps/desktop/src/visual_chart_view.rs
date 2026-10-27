//! Trusted native primitives over a finite normalized plan. No dynamic SVG or image-cache churn.
use crate::visual_chart::{Chart, Readout};
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::{
    AnyElement, App, Bounds, Context, Corners, DispatchPhase, HitboxBehavior, Hsla, IntoElement,
    MouseExitEvent, MouseMoveEvent, ParentElement, PathBuilder, ScrollWheelEvent, SharedString,
    Styled, Window, canvas,
    component::{ActiveTheme, StyledExt},
    div, fill, point, px, relative, size,
};
use std::{rc::Rc, sync::Arc};
/// Reports the x entry under the pointer, or `None` when it leaves the plot.
pub(crate) type OnHover = Rc<dyn Fn(Option<usize>, &mut Window, &mut App)>;
pub(crate) fn color(name: &str, cx: &gpui_kit::App) -> Hsla {
    let t = cx.theme();
    match name {
        "muted" => t.muted_foreground,
        "accent" => t.chart_1,
        "success" => t.success,
        "warning" => t.warning,
        "danger" => t.danger,
        "border" => t.border,
        "chart1" => t.chart_1,
        "chart2" => t.chart_2,
        "chart3" => t.chart_3,
        "chart4" => t.chart_4,
        "chart5" => t.chart_5,
        "chart6" => gpui_kit::rgb(if t.is_dark() { 0x22d3ee } else { 0x0891b2 }).into(),
        _ => t.foreground,
    }
}
pub(crate) fn render_scaled<T: 'static>(
    chart: Arc<Chart>,
    key: &str,
    scale: f32,
    hover: Option<usize>,
    on_hover: OnHover,
    cx: &Context<T>,
) -> AnyElement {
    let colors = chart
        .series
        .iter()
        .map(|s| color(&s.color, cx))
        .collect::<Vec<_>>();
    let border = cx.theme().border;
    let height = chart.height * scale;
    use gpui_kit::InteractiveElement;
    let mut view = div()
        .id(SharedString::from(key.to_owned()))
        .v_flex()
        .w_full()
        .min_w_0()
        .gap_1();
    let mut legend = div().h_flex().flex_wrap().gap_3();
    for (i, s) in chart.series.iter().enumerate() {
        legend = legend.child(
            div()
                .text_size(px(11. * scale))
                .text_color(colors[i])
                .child(SharedString::from(s.name.clone())),
        );
    }
    view = view.child(legend);
    let (low, high) = chart.range;
    let caption = format!("{} to {} {}", number(low), number(high), chart.unit);
    let labels = chart.labels.clone();
    let positions = chart.label_positions.clone();
    let x_label = chart.x_label.clone();
    let chart_label_count = labels.len();
    let readout = hover
        .filter(|&i| i < chart.positions.len())
        .and_then(|i| Some((i, chart.readout(i)?)));
    let hover = readout.as_ref().map(|(i, _)| *i);
    let rule = cx.theme().muted_foreground;
    let card =
        readout.map(|(i, readout)| readout_card(chart.positions[i], readout, &colors, scale, cx));
    let plot = {
        use gpui_kit::InteractiveElement;
        use gpui_kit::TestSupportExt;
        div()
            .relative()
            .w_full()
            .h(px(height))
            .overflow_hidden()
            .id("chart-plot")
            .test_support()
    };
    view.child(
        plot.child(
            canvas(
                |bounds, window, _| window.insert_hitbox(bounds, HitboxBehavior::Normal),
                move |bounds, hitbox, window, _| {
                    #[cfg(feature = "native-probes")]
                    let _timing =
                        crate::transcript_view::inline_visual::probe::scroll::work("chart_paint");
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
                    for x in &chart.label_positions {
                        let at = p((*x, 0.));
                        window.paint_quad(fill(Bounds::new(at, size(px(1.), px(4.))), border));
                    }
                    for (i, s) in chart.series.iter().enumerate() {
                        let c = colors[i];
                        if chart.kind == "bar" || chart.kind == "scatter" {
                            for (j, value) in s.points.iter().enumerate() {
                                let Some((x, y)) = *value else { continue };
                                let at = p((x, y));
                                let zero = if chart.kind == "bar" {
                                    p((x, s.bases[j])).y
                                } else {
                                    zero
                                };
                                let r = if chart.kind == "scatter" {
                                    Bounds::new(at - point(px(3.), px(3.)), size(px(6.), px(6.)))
                                } else {
                                    let bw = (w / s.points.len().max(1) as f32 * 0.8
                                        / if chart.stacked {
                                            1.
                                        } else {
                                            chart.series.len() as f32
                                        })
                                    .max(0.25);
                                    let dx = if chart.stacked {
                                        0.
                                    } else {
                                        (i as f32 - (chart.series.len() - 1) as f32 / 2.) * bw
                                    };
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
                    if let Some(i) = hover {
                        let top = p((chart.positions[i], 1.));
                        let mut line = rule;
                        line.a *= 0.6;
                        window.paint_quad(fill(Bounds::new(top, size(px(1.), px(h))), line));
                        if chart.kind == "line" || chart.kind == "area" {
                            for (s, c) in chart.series.iter().zip(&colors) {
                                if let Some(at) = s.points[i] {
                                    let mut dot = fill(
                                        Bounds::new(
                                            p(at) - point(px(3.5), px(3.5)),
                                            size(px(7.), px(7.)),
                                        ),
                                        *c,
                                    );
                                    dot.corner_radii = Corners::all(px(3.5));
                                    window.paint_quad(dot);
                                }
                            }
                        }
                    }
                    // Hover is local presentation: it never reaches the visual's
                    // state, takes focus or changes selection.
                    // Observe in the capture phase, so an element that handles the
                    // move (or scroll) elsewhere cannot leave a stale readout.
                    let at = move |x: gpui_kit::Pixels| f32::from(x - origin.x) / w;
                    let plan = chart.clone();
                    let report = on_hover.clone();
                    window.on_mouse_event(move |e: &MouseMoveEvent, phase, window, cx| {
                        if phase != DispatchPhase::Capture {
                            return;
                        }
                        let next = if hitbox.is_hovered(window) {
                            plan.nearest(at(e.position.x).clamp(0., 1.))
                        } else {
                            None
                        };
                        if next != hover {
                            report(next, window, cx);
                        }
                    });
                    if hover.is_some() {
                        // Content moving under a still pointer, or the pointer
                        // leaving the window, hides the readout until it moves again.
                        let report = on_hover.clone();
                        window.on_mouse_event(move |_: &ScrollWheelEvent, phase, window, cx| {
                            if phase == DispatchPhase::Capture {
                                report(None, window, cx);
                            }
                        });
                        let report = on_hover.clone();
                        window.on_mouse_event(move |_: &MouseExitEvent, phase, window, cx| {
                            if phase == DispatchPhase::Capture {
                                report(None, window, cx);
                            }
                        });
                    }
                },
            )
            .size_full(),
        )
        .children(card),
    )
    .child(
        div()
            .relative()
            .h(px(18. * scale))
            .mx_3()
            .min_w_0()
            .text_xs()
            .text_color(cx.theme().muted_foreground)
            .children(labels.into_iter().zip(positions).map(|(label, position)| {
                let width = 1. / chart_label_count.max(1) as f32;
                let left = (position - width / 2.).clamp(0., 1. - width);
                let text = div()
                    .absolute()
                    .left(relative(left))
                    .w(relative(width))
                    .min_w_0()
                    .truncate()
                    .child(SharedString::from(label));
                if position < width / 2. {
                    text.text_left()
                } else if position > 1. - width / 2. {
                    text.text_right()
                } else {
                    text.text_center()
                }
            })),
    )
    .when(!x_label.is_empty(), |view| {
        view.child(
            div()
                .text_xs()
                .text_center()
                .text_color(cx.theme().muted_foreground)
                .child(SharedString::from(x_label)),
        )
    })
    .child(
        div()
            .text_xs()
            .text_color(cx.theme().muted_foreground)
            .child(SharedString::from(caption)),
    )
    .into_any_element()
}
pub(crate) fn number(value: f64) -> String {
    crate::visual_chart::format_number(value)
}
/// Swift's readout card: the x label, then each series' colour, name and value.
/// It sits beside the rule on the side with more room, inside the plot.
fn readout_card<T: 'static>(
    at: f32,
    readout: Readout,
    colors: &[Hsla],
    scale: f32,
    cx: &Context<T>,
) -> AnyElement {
    use gpui_kit::{InteractiveElement, TestSupportExt};
    let theme = cx.theme();
    let mut card = div()
        .id("chart-readout")
        .test_support()
        .v_flex()
        .gap(px(2. * scale))
        .px(px(8. * scale))
        .py(px(6. * scale))
        .min_w_0()
        .max_w(px(260. * scale))
        .rounded(px(crate::appearance::Radius::CONTROL * scale))
        .border_1()
        .border_color(theme.border)
        .bg(theme.popover)
        .shadow_sm()
        .text_size(px(11. * scale))
        .text_color(theme.popover_foreground)
        .child(
            div()
                .font_semibold()
                .truncate()
                .child(SharedString::from(readout.label)),
        );
    for (series, name, value) in readout.rows {
        card = card.child(
            div()
                .h_flex()
                .gap(px(4. * scale))
                .min_w_0()
                .child(
                    div()
                        .flex_shrink_0()
                        .size(px(6. * scale))
                        .rounded_full()
                        .bg(colors[series]),
                )
                .child(
                    div()
                        .min_w_0()
                        .truncate()
                        .text_color(theme.muted_foreground)
                        .child(SharedString::from(name)),
                )
                .child(div().flex_shrink_0().child(SharedString::from(value))),
        );
    }
    let side = div().absolute().top_0().h_flex().items_start();
    let side = if at <= 0.5 {
        side.left(relative(at)).right_0().pl(px(8. * scale))
    } else {
        side.left_0()
            .right(relative(1. - at))
            .pr(px(8. * scale))
            .justify_end()
    };
    div()
        .absolute()
        .top(px(6. * scale))
        .bottom_0()
        .left(px(12.))
        .right(px(12.))
        .child(side.child(card))
        .into_any_element()
}
