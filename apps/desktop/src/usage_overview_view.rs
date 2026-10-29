//! A passive Local page. Explicit refresh only, no accounting writes or fanout.
use crate::{
    LocalOptions,
    ui::{self, Action, Notice, Space, Text, Tone},
    usage_overview::{self as model, Day, Range, State},
    usage_overview_reader::{Reader, Request, Response},
};
use gpui_kit::{
    App, Context, FocusHandle, InteractiveElement, IntoElement, ParentElement, Render,
    SharedString, Styled, Task, TestSupportExt, Window,
    component::{ActiveTheme, Disableable, StyledExt, scroll::ScrollableElement},
    div, px,
};
pub(crate) struct Usage {
    pub(crate) state: State,
    options: Option<LocalOptions>,
    reader: Option<Reader>,
    updates: Option<Task<()>>,
    days: u64,
    details: bool,
    focus: FocusHandle,
}
impl Usage {
    pub(crate) fn new(options: Option<LocalOptions>, cx: &mut Context<Self>) -> Self {
        Self {
            state: State::default(),
            options,
            reader: None,
            updates: None,
            days: 7,
            details: false,
            focus: cx.focus_handle(),
        }
    }
    pub(crate) fn focus(&self, w: &mut Window, cx: &mut App) {
        self.focus.focus(w, cx);
    }
    pub(crate) fn close(&mut self, cx: &mut Context<Self>) {
        self.reader = None;
        self.updates = None;
        self.state.serial += 1;
        self.state.busy = false;
        cx.notify();
    }
    pub(crate) fn load(&mut self, days: u64, w: &mut Window, cx: &mut Context<Self>) {
        let Some(range) = Range::preset(days, model::now()) else {
            return;
        };
        self.days = days;
        self.request(range, w, cx);
    }
    pub(crate) fn request(&mut self, range: Range, w: &mut Window, cx: &mut Context<Self>) {
        let serial = self.state.begin(range);
        if self.reader.is_none() {
            let started = self
                .options
                .clone()
                .ok_or("Local usage is unavailable in fixture mode. No host was queried.")
                .and_then(Reader::start);
            match started {
                Err(e) => {
                    self.state.accept(serial, range, Err(e));
                    cx.notify();
                    return;
                }
                Ok((reader, output)) => {
                    self.reader = Some(reader);
                    self.updates=Some(cx.spawn_in(w,async move |view,cx|{
                        while let Ok(response)=output.recv().await {if view.update(cx,|v,cx|v.accept(response,cx)).is_err(){return;}}
                        let _=view.update(cx,|v,cx|{v.reader=None;v.state.serial+=1;v.state.busy=false;v.state.error=Some("Couldn't update usage. Showing the last values; refresh to try again.");cx.notify();});
                    }));
                }
            }
        }
        if !self.reader.as_ref().is_some_and(|r| {
            r.request(Request {
                generation: serial,
                target: Some(range),
            })
        }) {
            self.state.accept(
                serial,
                range,
                Err("Local usage request could not be queued. Refresh to retry."),
            );
        }
        cx.notify();
    }
    fn accept(&mut self, response: Response, cx: &mut Context<Self>) {
        if self
            .state
            .accept(response.generation, response.range, response.result)
        {
            cx.notify();
        }
    }
}
impl Render for Usage {
    fn render(&mut self, w: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let mut controls = div()
            .id("usage-controls")
            .test_support()
            .h_flex()
            .flex_wrap()
            .items_center()
            .gap(px(Space::CONTROL));
        for days in [7, 30, 90] {
            controls = controls.child(
                ui::action(
                    SharedString::from(format!("usage-range-{days}")),
                    SharedString::from(format!("{days} days")),
                    if self.days == days {
                        Action::Secondary
                    } else {
                        Action::Quiet
                    },
                )
                .accessibility_label(SharedString::from(format!("Usage range: {days} days UTC")))
                .on_click(cx.listener(move |v, _, w, cx| {
                    if v.days != days {
                        v.load(days, w, cx);
                    }
                })),
            );
        }
        controls = controls.child(
            ui::action("usage-refresh", "Refresh", Action::Quiet)
                .disabled(self.state.busy)
                .on_click(cx.listener(|v, _, w, cx| v.load(v.days, w, cx))),
        );
        let mut page = ui::page()
            .child(
                ui::header("usage-title", "Usage", Text::Title).child(
                    ui::text(Text::Body, "Local observation, not account-wide billing")
                        .text_color(cx.theme().muted_foreground),
                ),
            )
            .child(controls);
        if let Some(range) = self.state.range {
            page = page.child(
                ui::text(Text::Caption, range.label())
                    .id("usage-range-label")
                    .test_support(),
            );
        }
        if self.state.busy {
            page = page.child(
                div().id("usage-loading").test_support().child(
                    Notice::new(if self.state.snapshot.is_some() {
                        "Refreshing. Previous observation retained below."
                    } else {
                        "Reading Local usage…"
                    })
                    .tone(Tone::Quiet),
                ),
            );
        }
        if let Some(error) = self.state.error {
            page=page.child(div().id("usage-error").test_support().child(Notice::new(error).detail("Any retained values below are a previous observation, not current coverage.").tone(Tone::Error)));
        }
        if let Some(snapshot) = &self.state.snapshot {
            let report = &snapshot.summary;
            let status = &report.status;
            page=page.child(div().id("usage-coverage").test_support().v_flex().gap(px(Space::META))
                .child(ui::text(Text::Headline,"Partial retained history"))
                .child(ui::text(Text::Body,format!("Collected since {}. Local observation: {}.",model::date(status.coverage_started_at),model::stamp(report.queried_at))))
                .child(ui::text(Text::Caption,format!("Observed range: {}",snapshot.range.label())))
                .child(ui::text(Text::Caption,"Known subtotals only. Gaps and missing metrics prevent complete-account claims.").text_color(cx.theme().muted_foreground)));
            if report.total.records == 0 {
                page = page.child(
                    div().id("usage-empty").test_support().child(
                        Notice::new("No dated requests observed in this range.")
                            .detail("This does not mean no usage occurred. Unknown is not zero."),
                    ),
                );
            }
            let mut summaries = div()
                .id("usage-summaries")
                .test_support()
                .v_flex()
                .gap(px(Space::SIDEBAR));
            for (key, label, cost) in [
                ("input", "Input tokens", false),
                ("output", "Output tokens", false),
                ("cacheRead", "Cache read tokens", false),
                ("estimatedUsdMicros", "Estimated cost (not billed)", true),
            ] {
                let metric = report.total.metric(key);
                let value = metric
                    .map(|m| m.label(cost))
                    .unwrap_or_else(|| "Unknown".into());
                let coverage = metric
                    .map(|m| m.coverage())
                    .unwrap_or_else(|| "Metric unavailable".into());
                summaries = summaries.child(
                    div()
                        .id(SharedString::from(format!("usage-summary-{key}")))
                        .test_support()
                        .v_flex()
                        .gap(px(Space::META))
                        .child(
                            div()
                                .h_flex()
                                .flex_wrap()
                                .justify_between()
                                .gap(px(Space::CONTROL))
                                .child(ui::text(Text::Body, label))
                                .child(ui::text(Text::Headline, value)),
                        )
                        .child(
                            ui::text(Text::Caption, coverage)
                                .text_color(cx.theme().muted_foreground),
                        ),
                );
            }
            page = page.child(summaries).child(ui::rule(w, cx));
            let mut trend = div()
                .id("usage-trend")
                .test_support()
                .v_flex()
                .gap(px(Space::SIDEBAR))
                .child(
                    ui::header("usage-trend-title", "Daily input + output", Text::Headline).child(
                        ui::text(Text::Caption, "Tokens per UTC day, cache excluded")
                            .text_color(cx.theme().muted_foreground),
                    ),
                );
            match &snapshot.trend {
                Err(error) => {
                    trend = trend.child(
                        Notice::new(*error)
                            .detail("Daily trend unavailable. Summary is a separate dated query.")
                            .tone(Tone::Quiet),
                    );
                }
                Ok(buckets) => {
                    trend = trend.child(crate::usage_overview_chart::chart(
                        snapshot.range,
                        buckets,
                        w,
                        cx,
                    ));
                }
            }
            page = page.child(trend).child(
                ui::action(
                    "usage-details",
                    if self.details {
                        "Hide coverage details"
                    } else {
                        "Coverage details"
                    },
                    Action::Quiet,
                )
                .self_start()
                .on_click(cx.listener(|v, _, _, cx| {
                    v.details = !v.details;
                    cx.notify();
                })),
            );
            if self.details {
                let mut details=div().id("usage-details-body").test_support().v_flex().gap(px(Space::CONTROL))
                    .child(ui::text(Text::Body,format!("{} dated request records. {} unpriced, {} partially priced. Catalog estimates are not billed charges.",report.total.records,report.total.unpriced,report.total.partial_priced)))
                    .child(ui::text(Text::Body,format!("Capture floor: {}. Retention floor: {}.",model::stamp(status.capture_floor),model::stamp(status.retention_floor))))
                    .child(ui::text(Text::Body,format!("Rejected: {}. Conflicts: {}. Expired: {}. Queue overflows: {}.",status.rejected,status.conflicts,status.expired,status.queue_overflows)))
                    .child(ui::text(Text::Body,"Local only. No remote hosts queried. Checkpoints and historical context are not added to totals. Loopback identity pinning is not authentication."));
                if let Ok(buckets) = &snapshot.trend {
                    let days = buckets.days(snapshot.range);
                    let quiet = |kind: Day| days.iter().filter(|&&(_, d)| d == kind).count();
                    for &(at, day) in &days {
                        if matches!(day, Day::Known { .. } | Day::Unknown { .. }) {
                            details = details.child(ui::text(
                                Text::Caption,
                                format!("{} UTC: {}", model::day_name(at), day.describe()),
                            ));
                        }
                    }
                    details = details.child(ui::text(
                        Text::Caption,
                        format!(
                            "Days with no requests observed: {}. Days outside retained history: {}.",
                            quiet(Day::Empty),
                            quiet(Day::Outside)
                        ),
                    ));
                }
                page = page.child(details);
            }
        }
        crate::local_view::menu_routing::window_commands(div())
            .id("usage-page")
            .test_support()
            .track_focus(&self.focus)
            .size_full()
            .bg(cx.theme().background)
            .text_color(cx.theme().foreground)
            .overflow_y_scrollbar()
            .child(page)
    }
}
