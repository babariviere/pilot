//! Daily input + output bars on a round token axis. Presentation only: the
//! caller owns the validated report, and missing days are never drawn as zero.
use crate::{
    ui::{self, Space, Surface, Text},
    usage_overview::{self as model, DAY, Day, Range, Report},
};
use gpui_kit::{
    App, Div, Hsla, InteractiveElement, IntoElement, ParentElement, SharedString,
    StatefulInteractiveElement, Styled, TestSupportExt, Window,
    component::{ActiveTheme, StyledExt, tooltip::Tooltip},
    div, px, relative,
};
/// Plot height and axis gutter: data geometry, not chrome spacing.
const PLOT: f32 = 160.;
const AXIS: f32 = 40.;

struct Marks {
    bar: Hsla,
    muted: Hsla,
    outside: Hsla,
}
impl Marks {
    fn new(cx: &App) -> Self {
        Self {
            bar: cx.theme().muted_foreground,
            muted: cx.theme().muted_foreground,
            outside: Surface::Tray.color(cx),
        }
    }
    /// Known subtotal bar. A partial day's top edge floats free of the bar:
    /// the value is a floor, more requests happened than were counted.
    fn bar(&self, fraction: f32, complete: bool) -> Div {
        let bar = div().w_full().h(relative(fraction));
        if complete {
            bar.min_h(px(2.)).bg(self.bar)
        } else {
            self.partial(bar.min_h(px(6.)))
        }
    }
    fn partial(&self, bar: Div) -> Div {
        bar.v_flex()
            .child(div().flex_none().h(px(2.)).bg(self.bar))
            .child(div().flex_none().h(px(2.)))
            .child(div().flex_1().bg(self.bar))
    }
    fn glyph(&self, label: impl Into<SharedString>) -> Div {
        ui::text(Text::Small, label).text_color(self.muted)
    }
}

pub(crate) fn chart(range: Range, report: &Report, w: &Window, cx: &App) -> Div {
    let days = report.days(range);
    let max = days
        .iter()
        .filter_map(|(_, d)| d.tokens())
        .max()
        .unwrap_or(0);
    let (step, steps) = model::scale(max);
    let top = (step * steps).max(1) as f32;
    let marks = Marks::new(cx);
    let hairline = crate::appearance::hairline(w);
    let gap = px(match days.len() {
        0..=7 => 6.,
        8..=31 => 3.,
        _ => 1.,
    });
    let today = report.queried_at / DAY * DAY;

    let mut axis = div()
        .id("usage-axis")
        .test_support()
        .relative()
        .flex_none()
        .w(px(AXIS))
        .h(px(PLOT));
    let mut grid = div().absolute().top_0().left_0().size_full();
    // Days before retained history form one leading band, not per-day stripes.
    let outside = days.iter().take_while(|(_, d)| *d == Day::Outside).count();
    if outside > 0 {
        grid = grid.child(
            div()
                .absolute()
                .top_0()
                .left_0()
                .h_full()
                .w(relative(outside as f32 / days.len() as f32))
                .bg(marks.outside),
        );
    }
    for i in 0..=steps {
        let at = relative(i as f32 / steps.max(1) as f32);
        grid = grid.child(
            div()
                .absolute()
                .left_0()
                .w_full()
                .bottom(at)
                .h(hairline)
                .bg(cx.theme().border),
        );
        axis = axis.child(
            div()
                .id(SharedString::from(format!("usage-tick-{i}")))
                .test_support()
                .absolute()
                .right_0()
                .bottom(at)
                .mb(px(-6.))
                .child(marks.glyph(model::compact(step * i))),
        );
    }

    let mut bars = div()
        .id("usage-bars")
        .test_support()
        .absolute()
        .top_0()
        .left_0()
        .size_full()
        .h_flex()
        .items_end()
        .gap(gap);
    let mut labels = div()
        .id("usage-days")
        .test_support()
        .h_flex()
        .w_full()
        .gap(gap);
    let every = match days.len() {
        0..=7 => 1,
        8..=31 => 7,
        _ => 14,
    };
    let last = days.len().saturating_sub(1);
    for (i, &(at, day)) in days.iter().enumerate() {
        let tip = format!(
            "{} UTC{}: {}",
            model::day_name(at),
            if at == today { ", so far" } else { "" },
            day.describe()
        );
        let slot = div()
            .id(SharedString::from(format!("usage-day-{at}")))
            .test_support()
            .flex_1()
            .min_w_0()
            .h_full()
            .v_flex()
            .justify_end()
            .items_center();
        let slot = match day {
            Day::Known { tokens: 0, .. } if day.complete() => slot.child(marks.glyph("0")),
            // Zero counted while other requests lack counts says nothing about the day.
            Day::Known { tokens: 0, .. } | Day::Unknown { .. } => slot.child(marks.glyph("?")),
            Day::Known { tokens, .. } => slot.child(
                marks
                    .bar(tokens as f32 / top, day.complete())
                    .id(SharedString::from(format!("usage-bar-{at}")))
                    .test_support(),
            ),
            Day::Empty | Day::Outside => slot,
        };
        bars = bars.child(slot.tooltip(move |w, cx| Tooltip::new(tip.clone()).build(w, cx)));
        let label = div().flex_1().min_w_0().h_flex();
        let label = if i == last && i > 0 {
            label.justify_end()
        } else {
            label.justify_center()
        };
        labels = labels.child(if (last - i).is_multiple_of(every) {
            label.child(
                marks
                    .glyph(model::short_date(at))
                    .flex_none()
                    .whitespace_nowrap(),
            )
        } else {
            label
        });
    }

    let plot = div()
        .v_flex()
        .flex_1()
        .min_w_0()
        .gap(px(Space::META))
        .child(
            div()
                .relative()
                .w_full()
                .h(px(PLOT))
                .child(grid)
                .child(bars),
        )
        .child(labels);
    div()
        .v_flex()
        .w_full()
        .gap(px(Space::SIDEBAR))
        .child(
            div()
                .h_flex()
                .w_full()
                .items_start()
                .gap(px(Space::CONTROL))
                .child(axis)
                .child(plot),
        )
        .child(legend(&days, &marks, hairline, cx))
}

/// Explains only the marks present. A fully counted range needs no key.
fn legend(
    days: &[(u64, Day)],
    marks: &Marks,
    hairline: gpui_kit::Pixels,
    cx: &App,
) -> impl IntoElement {
    let has = |f: fn(Day) -> bool| days.iter().any(|&(_, d)| f(d));
    let counted = |d: Day| d.complete() && d.tokens() != Some(0);
    let row = div()
        .id("usage-legend")
        .test_support()
        .h_flex()
        .flex_wrap()
        .gap_x(px(Space::SIDEBAR))
        .gap_y(px(Space::META));
    if days.iter().all(|&(_, d)| counted(d)) {
        return row;
    }
    let swatch = || div().size(px(10.)).flex_none();
    let entries: [(bool, Div, &str); 6] = [
        (has(counted), swatch().bg(marks.bar), "All requests counted"),
        (
            has(|d| !d.complete() && d.tokens().is_some_and(|n| n > 0)),
            marks.partial(swatch()),
            "Some requests uncounted",
        ),
        (
            has(|d| d.complete() && d.tokens() == Some(0)),
            marks.glyph("0"),
            "Zero",
        ),
        (
            has(|d| matches!(d, Day::Unknown { .. }) || (!d.complete() && d.tokens() == Some(0))),
            marks.glyph("?"),
            "Counts unavailable",
        ),
        (
            has(|d| d == Day::Empty),
            swatch()
                .v_flex()
                .justify_end()
                .child(div().w_full().h(hairline).bg(cx.theme().border)),
            "No requests",
        ),
        (
            has(|d| d == Day::Outside),
            swatch().bg(marks.outside),
            "Outside retained history",
        ),
    ];
    entries
        .into_iter()
        .filter(|(present, ..)| *present)
        .fold(row, |row, (_, mark, label)| {
            row.child(
                div()
                    .h_flex()
                    .items_center()
                    .gap(px(Space::META))
                    .child(mark)
                    .child(ui::text(Text::Caption, label).text_color(marks.muted)),
            )
        })
}
