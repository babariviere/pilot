//! Trusted native primitives over a finite normalized plan. No dynamic SVG or image-cache churn.
use crate::visual_chart::{Chart, Readout, Step};
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::{
    AnyElement, App, Bounds, Corners, DispatchPhase, FocusHandle, HitboxBehavior, Hsla,
    IntoElement, KeyDownEvent, MouseExitEvent, MouseMoveEvent, ParentElement, PathBuilder,
    RenderOnce, ScrollWheelEvent, SharedString, Styled, Subscription, Window, canvas,
    component::{ActiveTheme, StyledExt},
    div, fill, point, px, relative, size,
};
use std::{rc::Rc, sync::Arc};
/// Reports the readout's x entry, or `None` when the readout closes.
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
/// A chart whose plot is a tab stop. The pointer picks the readout entry; while
/// the plot has focus, Left/Right/Home/End also do, and the readout stays when
/// the pointer leaves. Escape or blur closes it. `epoch` scopes the plot's focus
/// to one presentation generation.
pub(crate) fn render_scaled(
    chart: Arc<Chart>,
    key: &str,
    epoch: u64,
    scale: f32,
    hover: Option<usize>,
    on_hover: OnHover,
) -> AnyElement {
    ChartPlot {
        chart,
        key: key.to_owned(),
        epoch,
        scale,
        hover,
        on_hover,
    }
    .into_any_element()
}
#[derive(IntoElement)]
struct ChartPlot {
    chart: Arc<Chart>,
    key: String,
    epoch: u64,
    scale: f32,
    hover: Option<usize>,
    on_hover: OnHover,
}
/// The plot's focus, and the latest readout facts its focus listeners act on.
/// Owns no work; it retires when the plot unmounts.
struct Keys {
    focus: FocusHandle,
    chart: Arc<Chart>,
    hover: Option<usize>,
    report: OnHover,
    _focus: [Subscription; 2],
}
impl RenderOnce for ChartPlot {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let (chart, hover, report) = (self.chart, self.hover, self.on_hover);
        let keys = window.use_keyed_state(
            SharedString::from(format!("{}:{}", self.key, self.epoch)),
            cx,
            |window, cx| {
                let focus = cx.focus_handle().tab_stop(true);
                // Focus shows a readout, so a focused plot is visible without a ring.
                let shown = cx.on_focus(&focus, window, |k: &mut Keys, window, cx| {
                    if k.hover.is_none()
                        && let Some(first) = k.chart.step(None, Step::First)
                    {
                        (k.report.clone())(Some(first), window, cx);
                    }
                });
                let hidden = cx.on_blur(&focus, window, |k: &mut Keys, window, cx| {
                    if k.hover.is_some() {
                        (k.report.clone())(None, window, cx);
                    }
                });
                Keys {
                    focus,
                    chart: chart.clone(),
                    hover,
                    report: report.clone(),
                    _focus: [shown, hidden],
                }
            },
        );
        let focus = keys.update(cx, |k, _| {
            k.chart = chart.clone();
            k.hover = hover;
            k.report = report.clone();
            k.focus.clone()
        });
        build(chart, &self.key, self.scale, hover, report, focus, cx)
    }
}
fn build(
    chart: Arc<Chart>,
    key: &str,
    scale: f32,
    hover: Option<usize>,
    on_hover: OnHover,
    focus: FocusHandle,
    cx: &App,
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
    // A separate lane keeps scale labels out of the data and readout.
    let ticks = chart.ticks();
    let gutter = (ticks
        .iter()
        .map(|(_, label)| label.len())
        .max()
        .unwrap_or(1) as f32
        * 7.
        + 8.)
        .max(48.)
        * scale;
    let vertical_inset = (7. * scale).max(8.);
    use gpui_kit::TestSupportExt;
    let axis = div()
        .relative()
        .flex_shrink_0()
        .w(px(gutter))
        .h(px(height))
        .children(ticks.iter().enumerate().map(|(i, (at, label))| {
            div()
                .id(("chart-y-tick", i))
                .test_support()
                .absolute()
                .top(px(vertical_inset
                    + (1. - at) * (height - 2. * vertical_inset)
                    - 7. * scale))
                .left_0()
                .right(px(4. * scale))
                .h(px(14. * scale))
                .text_size(px(11. * scale))
                .text_color(cx.theme().muted_foreground)
                .text_right()
                .child(SharedString::from(label.clone()))
        }));
    view = view.when(!chart.unit.is_empty(), |view| {
        view.child(
            div()
                .id("chart-y-label")
                .test_support()
                .text_xs()
                .text_color(cx.theme().muted_foreground)
                .child(SharedString::from(chart.unit.clone())),
        )
    });
    let labels = chart.labels.clone();
    let positions = chart.label_positions.clone();
    let x_label = chart.x_label.clone();
    let chart_label_count = labels.len();
    let readout = hover
        .filter(|&i| i < chart.positions.len())
        .and_then(|i| Some((i, chart.readout(i)?)));
    let hover = readout.as_ref().map(|(i, _)| *i);
    let rule = cx.theme().muted_foreground;
    // A short plot cannot contain twelve readout rows. Let a tall card flow
    // below it, rather than clipping values or adding an inner scroll region.
    let below = readout
        .as_ref()
        .is_some_and(|(_, r)| (r.rows.len() + 1) as f32 * 18. * scale + 20. * scale > height);
    let card = readout
        .map(|(i, readout)| readout_card(chart.positions[i], readout, &colors, scale, below, cx));
    let (overlay_card, below_card) = if below { (None, card) } else { (card, None) };
    let keyboard = {
        let (chart, report) = (chart.clone(), on_hover.clone());
        move |e: &KeyDownEvent, window: &mut Window, cx: &mut App| {
            let m = e.keystroke.modifiers;
            if m.control || m.alt || m.shift || m.platform {
                return;
            }
            let step = match e.keystroke.key.as_str() {
                "left" => Step::Previous,
                "right" => Step::Next,
                "home" => Step::First,
                "end" => Step::Last,
                // With no readout open, Escape belongs to the surrounding view.
                "escape" if hover.is_some() => {
                    cx.stop_propagation();
                    report(None, window, cx);
                    return;
                }
                _ => return,
            };
            if let Some(next) = chart.step(hover, step) {
                cx.stop_propagation();
                if Some(next) != hover {
                    report(Some(next), window, cx);
                }
            }
        }
    };
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
            .track_focus(&focus)
            .on_key_down(keyboard)
    };
    view.child(
        div().h_flex().w_full().min_w_0().child(axis).child(
            plot.flex_1()
                .min_w_0()
                .child(
                    canvas(
                        |bounds, window, _| window.insert_hitbox(bounds, HitboxBehavior::Normal),
                        move |bounds, hitbox, window, _| {
                            #[cfg(feature = "native-probes")]
                            let _timing =
                                crate::transcript_view::inline_visual::probe::scroll::work(
                                    "chart_paint",
                                );
                            if bounds.size.width <= px(30.) || bounds.size.height <= px(20.) {
                                return;
                            }
                            let origin = bounds.origin + point(px(12.), px(vertical_inset));
                            let w = f32::from(bounds.size.width - px(24.));
                            let h = f32::from(bounds.size.height - px(2. * vertical_inset));
                            let p =
                                |(x, y): (f32, f32)| origin + point(px(x * w), px((1. - y) * h));
                            for (at, _) in &ticks {
                                let y = p((0., *at)).y;
                                let mut grid = border;
                                grid.a *= 0.5;
                                window.paint_quad(fill(
                                    Bounds::new(point(origin.x, y), size(px(w), px(1.))),
                                    grid,
                                ));
                            }
                            let zero = p((0., chart.baseline)).y;
                            window.paint_quad(fill(
                                Bounds::new(point(origin.x, zero), size(px(w), px(1.))),
                                border,
                            ));
                            for x in &chart.label_positions {
                                let at = p((*x, 0.));
                                window.paint_quad(fill(
                                    Bounds::new(at, size(px(1.), px(4.))),
                                    border,
                                ));
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
                                            Bounds::new(
                                                at - point(px(3.), px(3.)),
                                                size(px(6.), px(6.)),
                                            )
                                        } else {
                                            let bw = (w / chart.categories.max(1) as f32 * 0.8
                                                / if chart.stacked {
                                                    1.
                                                } else {
                                                    chart.series.len() as f32
                                                })
                                            .max(0.25);
                                            let dx = if chart.stacked {
                                                0.
                                            } else {
                                                (i as f32 - (chart.series.len() - 1) as f32 / 2.)
                                                    * bw
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
                                    for outline in &s.fills {
                                        let mut path = PathBuilder::fill();
                                        path.move_to(p(outline[0]));
                                        for pt in &outline[1..] {
                                            path.line_to(p(*pt));
                                        }
                                        path.close();
                                        if let Ok(path) = path.build() {
                                            // Stacked bands are opaque, like Swift's
                                            // stacked AreaMark and stacked bars.
                                            let mut fill = c;
                                            if !chart.stacked {
                                                fill.a *= 0.18;
                                            }
                                            window.paint_path(path, fill);
                                        }
                                    }
                                    for stroke in &s.strokes {
                                        let points =
                                            stroke.iter().copied().map(p).collect::<Vec<_>>();
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
                                window
                                    .paint_quad(fill(Bounds::new(top, size(px(1.), px(h))), line));
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
                            // state, takes focus or changes selection. A focused plot keeps
                            // its readout when the pointer leaves or content scrolls.
                            // Observe in the capture phase, so an element that handles the
                            // move (or scroll) elsewhere cannot leave a stale readout.
                            let at = move |x: gpui_kit::Pixels| f32::from(x - origin.x) / w;
                            let plan = chart.clone();
                            let report = on_hover.clone();
                            let focused = focus.clone();
                            window.on_mouse_event(move |e: &MouseMoveEvent, phase, window, cx| {
                                if phase != DispatchPhase::Capture {
                                    return;
                                }
                                let next = if hitbox.is_hovered(window) {
                                    plan.nearest(at(e.position.x).clamp(0., 1.))
                                } else if focused.is_focused(window) {
                                    hover
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
                                let focused = focus.clone();
                                window.on_mouse_event(
                                    move |_: &ScrollWheelEvent, phase, window, cx| {
                                        if phase == DispatchPhase::Capture
                                            && !focused.is_focused(window)
                                        {
                                            report(None, window, cx);
                                        }
                                    },
                                );
                                let report = on_hover.clone();
                                let focused = focus.clone();
                                window.on_mouse_event(
                                    move |_: &MouseExitEvent, phase, window, cx| {
                                        if phase == DispatchPhase::Capture
                                            && !focused.is_focused(window)
                                        {
                                            report(None, window, cx);
                                        }
                                    },
                                );
                            }
                        },
                    )
                    .size_full(),
                )
                .children(overlay_card),
        ),
    )
    .child(
        div()
            .relative()
            .h(px(18. * scale))
            .ml(px(gutter + 12.))
            .mr(px(12.))
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
    .children(below_card)
    .into_any_element()
}
pub(crate) fn number(value: f64) -> String {
    crate::visual_chart::format_number(value)
}
/// Swift's readout card: the x label, then each series' colour, name and value.
/// It sits beside the rule on the side with more room, inside the plot.
fn readout_card(
    at: f32,
    readout: Readout,
    colors: &[Hsla],
    scale: f32,
    below: bool,
    cx: &App,
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
                .child(div().min_w_0().truncate().child(SharedString::from(value))),
        );
    }
    if below {
        return card.max_w_full().into_any_element();
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

#[cfg(test)]
mod tests {
    use super::*;
    use gpui_kit::test::{TestEventExt, TestWindowExt};
    use gpui_kit::{AppContext, Context, Render, TestAppContext, WindowBounds, WindowOptions};
    use serde_json::json;

    struct Plot {
        chart: Arc<Chart>,
        hover: Option<usize>,
    }
    impl Render for Plot {
        fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
            let weak = cx.entity().downgrade();
            render_scaled(
                self.chart.clone(),
                "test-chart",
                0,
                1.,
                self.hover,
                Rc::new(move |next, _, cx| {
                    let _ = weak.update(cx, |this, cx| {
                        this.hover = next;
                        cx.notify();
                    });
                }),
            )
        }
    }

    #[gpui_kit::test]
    fn axes_and_readouts_stay_inside_narrow_wide_light_dark_layouts(cx: &mut TestAppContext) {
        cx.update(|cx| {
            gpui_kit::init(cx);
            crate::init_appearance(cx);
        });
        for width in [320., 680., 1100.] {
            for dark in [false, true] {
                for count in [2, 12] {
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
                    let chart = Arc::new(Chart::parse(&json!({"kind":"bar","height":160,"x":["North","South"],"yLabel":"Latency (ms)","yMin":-10,"yMax":10,"series":(0..count).map(|i| json!({"name":format!("Long series 日本語 {i}"),"values":[-5,8]})).collect::<Vec<_>>()})).unwrap());
                    let (h, view) = cx.update(|cx| {
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
                            |_, cx| cx.new(|_| Plot { chart, hover: None }),
                        )
                        .unwrap()
                    });
                    cx.update_window(h, |_, w, cx| {
                        w.render_frame(cx);
                        let plot = w.find("chart-plot").bounds();
                        assert!(w.find("chart-y-label").bounds().bottom() <= plot.top());
                        for i in 0..5usize {
                            let tick = w.find(("chart-y-tick", i)).bounds();
                            assert!(tick.right() < plot.left());
                            assert!(tick.top() >= plot.top() && tick.bottom() <= plot.bottom());
                        }
                        let focus = w.focused(cx);
                        for at in [0.25, 0.75] {
                            let plot = w.find("chart-plot").bounds();
                            w.pointer_move(
                                point(
                                    plot.left() + px(12.) + (plot.size.width - px(24.)) * at,
                                    plot.center().y,
                                ),
                                None,
                                cx,
                            );
                            w.render_frame(cx);
                            let card = w.find("chart-readout").bounds();
                            assert!(
                                card.left() >= px(0.) && card.right() <= px(width),
                                "{card:?}"
                            );
                            if count == 12 {
                                assert!(card.top() >= plot.bottom(), "tall card flows below plot");
                            } else {
                                assert!(card.top() >= plot.top() && card.bottom() <= plot.bottom());
                            }
                            assert_eq!(w.focused(cx), focus);
                        }
                        w.pointer_move(point(px(0.), px(0.)), None, cx);
                        w.render_frame(cx);
                    })
                    .unwrap();
                    cx.update(|cx| assert_eq!(view.read(cx).hover, None));
                    cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
                }
            }
        }
    }
}
