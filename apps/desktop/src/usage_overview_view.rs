//! A passive Local page. Explicit refresh only, no accounting writes or fanout.
use crate::{
    LocalOptions,
    ui::{self, Action, Notice, Space, Text, Tone},
    usage_overview::{self as model, Day, Filter, Range, State},
    usage_overview_reader::{Reader, Request, Response},
    usage_overview_records as records,
};
use gpui_kit::{
    App, AppContext, Context, DismissEvent, Entity, FocusHandle, Focusable, InteractiveElement,
    IntoElement, ParentElement, Render, SharedString, Styled, Subscription, Task, TestSupportExt,
    Window,
    component::{
        ActiveTheme, Disableable, StyledExt,
        scroll::ScrollableElement,
        select::{SearchableVec, Select, SelectEvent, SelectItem, SelectState},
    },
    div, px,
};
#[derive(Clone)]
struct Item {
    filter: Filter,
    label: SharedString,
}
impl SelectItem for Item {
    type Value = Filter;
    fn value(&self) -> &Filter {
        &self.filter
    }
    fn title(&self) -> SharedString {
        self.label.clone()
    }
    fn render(&self, _: &mut Window, _: &mut App) -> impl IntoElement {
        div().truncate().child(self.title())
    }
}
type Picker = SelectState<SearchableVec<Item>>;
pub(crate) struct Usage {
    pub(crate) state: State,
    options: Option<LocalOptions>,
    reader: Option<Reader>,
    updates: Option<Task<()>>,
    pub(crate) records: records::State,
    records_reader: Option<records::Reader>,
    records_updates: Option<Task<()>>,
    days: u64,
    details: bool,
    focus: FocusHandle,
    picker: Option<Entity<Picker>>,
    subscriptions: Vec<Subscription>,
    pub(crate) project_names: std::collections::BTreeMap<String, String>,
    pub(crate) limits: Option<gpui_kit::Entity<crate::provider_refresh_view::Limits>>,
}
impl Usage {
    pub(crate) fn new(options: Option<LocalOptions>, cx: &mut Context<Self>) -> Self {
        Self {
            state: State::default(),
            options,
            reader: None,
            updates: None,
            records: records::State::default(),
            records_reader: None,
            records_updates: None,
            days: 7,
            details: false,
            focus: cx.focus_handle(),
            picker: None,
            subscriptions: vec![],
            project_names: Default::default(),
            limits: None,
        }
    }
    pub(crate) fn focus(&self, w: &mut Window, cx: &mut App) {
        self.focus.focus(w, cx);
    }
    pub(crate) fn close(&mut self, cx: &mut Context<Self>) {
        self.clear_records();
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
        self.request_filter(range, self.state.filter.clone(), w, cx);
    }
    fn request_filter(
        &mut self,
        range: Range,
        filter: Filter,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.clear_records();
        self.init_picker(w, cx);
        let previous_generation = self
            .state
            .snapshot
            .as_ref()
            .map(|s| s.summary.status.generation.clone())
            .or_else(|| self.state.catalogue.as_ref().map(|c| c.generation.clone()));
        let serial = self.state.begin(range, filter);
        self.sync_picker(w, cx);
        if self.reader.is_none() {
            let started = self
                .options
                .clone()
                .ok_or("Local usage is unavailable in fixture mode. No host was queried.")
                .and_then(Reader::start);
            match started {
                Err(e) => {
                    self.state
                        .accept(serial, range, &self.state.filter.clone(), Err(e));
                    cx.notify();
                    return;
                }
                Ok((reader, output)) => {
                    self.reader = Some(reader);
                    self.updates=Some(cx.spawn_in(w,async move |view,cx|{
                        while let Ok(response)=output.recv().await {if view.update_in(cx,|v,w,cx|v.accept(response,w,cx)).is_err(){return;}}
                        let _=view.update(cx,|v,cx|{v.reader=None;v.state.serial+=1;v.state.busy=false;v.state.error=Some("Couldn't update usage. Showing the last values; refresh to try again.");cx.notify();});
                    }));
                }
            }
        }
        if !self.reader.as_ref().is_some_and(|r| {
            r.request(Request {
                generation: serial,
                target: Some(range),
                previous_generation,
                filter: self.state.filter.clone(),
            })
        }) {
            self.state.accept(
                serial,
                range,
                &self.state.filter.clone(),
                Err("Local usage request could not be queued. Refresh to retry."),
            );
        }
        cx.notify();
    }
    fn init_picker(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if self.picker.is_some() {
            return;
        }
        let picker =
            cx.new(|cx| Picker::new(SearchableVec::new(vec![]), None, w, cx).searchable(true));
        self.subscriptions.push(cx.subscribe_in(
            &picker,
            w,
            |v, p, event: &SelectEvent<SearchableVec<Item>>, w, cx| {
                if let SelectEvent::Confirm(Some(filter)) = event
                    && p.read(cx).selected_value() == Some(filter)
                    && &v.state.filter != filter
                {
                    // Selection is an explicit passive read, never a provider refresh.
                    if let Some(range) = v.state.range {
                        v.request_filter(range, filter.clone(), w, cx);
                    }
                }
            },
        ));
        self.subscriptions.push(
            cx.subscribe_in(&picker, w, |v, _, _: &DismissEvent, w, cx| {
                v.sync_picker(w, cx)
            }),
        );
        self.picker = Some(picker);
    }
    #[cfg(feature = "native-probes")]
    pub(crate) fn probe_filter_focused(&self, w: &Window, cx: &App) -> bool {
        self.picker
            .as_ref()
            .is_some_and(|p| p.focus_handle(cx).is_focused(w))
    }
    #[cfg(feature = "native-probes")]
    pub(crate) fn probe_query(&self, cx: &App) -> Entity<gpui_kit::component::input::InputState> {
        self.picker
            .as_ref()
            .expect("mounted project selector")
            .read(cx)
            .query_input(cx)
    }
    fn sync_picker(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if self
            .picker
            .as_ref()
            .is_some_and(|p| p.read(cx).query_input(cx).focus_handle(cx).is_focused(w))
        {
            // A completed history read must not reset an active search/IME.
            // Dismissal applies the newest catalogue to this same retained picker.
            return;
        }
        let mut filters = vec![Filter::All];
        if let Some(c) = &self.state.catalogue {
            filters.extend(c.filters.clone());
        }
        // Preserve an exact selected ID even when absent from this limited page.
        if !filters.contains(&self.state.filter) {
            filters.push(self.state.filter.clone());
        }
        if let Some(picker) = &self.picker {
            let items: Vec<Item> = filters
                .into_iter()
                .map(|filter| {
                    let label = match &filter {
                        Filter::Project(id) => self
                            .project_names
                            .get(id)
                            .map(|name| format!("{name} · {id}")),
                        _ => None,
                    }
                    .unwrap_or_else(|| filter.label())
                    .into();
                    Item { filter, label }
                })
                .collect();
            picker.update(cx, |p, cx| {
                p.set_items(SearchableVec::new(items), w, cx);
                p.set_selected_value(&self.state.filter, w, cx);
            });
        }
    }
    fn accept(&mut self, response: Response, w: &mut Window, cx: &mut Context<Self>) {
        if self.state.accept(
            response.generation,
            response.range,
            &response.filter,
            response.result,
        ) {
            self.sync_picker(w, cx);
            cx.notify();
        }
    }
    fn clear_records(&mut self) {
        self.records_reader = None;
        self.records_updates = None;
        self.records.clear();
    }
    fn read_records(&mut self, next: bool, w: &mut Window, cx: &mut Context<Self>) {
        if self.state.busy || self.state.error.is_some() || self.records.busy {
            return;
        }
        let Some(snapshot) = &self.state.snapshot else {
            return;
        };
        let after = if next {
            self.records.page.as_ref().and_then(|p| p.next.clone())
        } else {
            None
        };
        if next && after.is_none() {
            return;
        }
        let boundary = if next {
            self.records
                .page
                .as_ref()
                .and_then(|p| p.rows.last().map(|r| r.key.clone()))
        } else {
            None
        };
        let request = records::Request {
            range: snapshot.range,
            filter: snapshot.filter.clone(),
            generation: snapshot.summary.status.generation.clone(),
            serial: self.records.begin(),
            after,
            boundary,
        };
        self.records.open = true;
        if self.records_reader.is_none() {
            match self
                .options
                .clone()
                .ok_or("Local records unavailable.")
                .and_then(records::Reader::start)
            {
                Ok((reader, output)) => {
                    self.records_reader = Some(reader);
                    self.records_updates = Some(cx.spawn_in(w, async move |view, cx| {
                        while let Ok(response) = output.recv().await {
                            if view.update_in(cx, |v, w, cx| v.accept_records(response, w, cx)).is_err() { return; }
                        }
                        let _ = view.update(cx, |v, cx| {
                            v.records_reader = None;
                            if v.records.busy { v.records.busy = false; v.records.error = Some("Records reader stopped. Reopen records to retry; any page below is a previous observation."); }
                            cx.notify();
                        });
                    }));
                }
                Err(error) => {
                    self.records.accept(request.serial, Err(error));
                    cx.notify();
                    return;
                }
            }
        }
        if !self
            .records_reader
            .as_ref()
            .is_some_and(|r| r.request(request.clone()))
        {
            self.records.accept(
                request.serial,
                Err("Records read could not be queued. Reopen records to retry."),
            );
        }
        cx.notify();
    }
    fn accept_records(
        &mut self,
        response: records::Response,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let request = response.request;
        if self.state.busy
            || self.state.range != Some(request.range)
            || self.state.filter != request.filter
            || !self
                .state
                .snapshot
                .as_ref()
                .is_some_and(|s| s.summary.status.generation == request.generation)
        {
            return;
        }
        let reset = matches!(response.result, Err(model::ERASED | records::RESET));
        if self.records.accept(request.serial, response.result) {
            if reset {
                self.state.snapshot = None;
                self.state.catalogue = None;
                self.state.error = self.records.error;
                self.sync_picker(w, cx);
            }
            cx.notify();
        }
    }
    fn records_section(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let mut section = div()
            .id("usage-records")
            .test_support()
            .v_flex()
            .min_w_0()
            .w_full()
            .gap(px(Space::CONTROL))
            .child(
                ui::action(
                    "usage-records-toggle",
                    if self.records.open {
                        "Hide records"
                    } else {
                        "Retained request records"
                    },
                    Action::Quiet,
                )
                .self_start()
                .disabled(self.state.busy || self.state.error.is_some())
                .on_click(cx.listener(|v, _, w, cx| {
                    if v.records.open {
                        v.clear_records();
                        cx.notify();
                    } else {
                        v.read_records(false, w, cx);
                    }
                })),
            );
        if !self.records.open {
            return section;
        }
        section = section.child(ui::text(Text::Caption, "25 records per page, oldest first. Pages replace, never add to totals. Independent observations, not a complete or frozen history. Checkpoints excluded."));
        if self.records.busy {
            section = section.child(
                div().id("usage-records-loading").test_support().child(
                    Notice::new("Reading records… Any page below is a previous observation.")
                        .tone(Tone::Quiet),
                ),
            );
        }
        if let Some(error) = self.records.error {
            section = section.child(div().id("usage-records-error").test_support().child(Notice::new(error).detail("Any retained page below is a previous observation. First page starts again; Next reads from the retained page’s cursor.").tone(Tone::Error)));
        }
        if let Some(page) = &self.records.page {
            section = section.child(ui::text(Text::Caption, format!("{} rows displayed, not the matching total. Page received {} (client time).", page.rows.len(), model::stamp(page.received_at))))
                .child(ui::text(Text::Caption, format!("Partial coverage. Capture floor {}. Retention floor {}.", model::stamp(page.status.capture_floor), model::stamp(page.status.retention_floor))));
            if page.rows.is_empty() {
                section = section.child(
                    div().id("usage-records-empty").test_support().child(
                        Notice::new("No retained request records on this page.")
                            .detail("This does not prove no usage occurred."),
                    ),
                );
            }
            for row in &page.rows {
                let id = row.id();
                let expanded = self.records.expanded.as_ref() == Some(&id);
                let serial = self.records.serial;
                let clicked_id = id.clone();
                let physical = &row.value["physicalModel"];
                let serving = match (physical["provider"].as_str(), physical["model"].as_str()) {
                    (Some(p), Some(m)) => format!("{p}/{m}"),
                    _ => "Physical model unknown".into(),
                };
                let mut item = div()
                    .id(SharedString::from(format!("usage-record-{id}")))
                    .test_support()
                    .v_flex()
                    .min_w_0()
                    .w_full()
                    .gap(px(Space::META))
                    .child(ui::text(
                        Text::Body,
                        format!(
                            "{} · request · {}",
                            model::stamp(row.key.0),
                            row.value["purpose"].as_str().unwrap_or("unknown")
                        ),
                    ))
                    .child(ui::text(
                        Text::Caption,
                        format!(
                            "{serving} · {}",
                            row.value["coverage"].as_str().unwrap_or("unknown")
                        ),
                    ))
                    .child(
                        ui::action(
                            SharedString::from(format!("usage-record-details-{id}")),
                            if expanded {
                                "Hide record details"
                            } else {
                                "Record details"
                            },
                            Action::Quiet,
                        )
                        .self_start()
                        .accessibility_label(SharedString::from(format!(
                            "Record details: {} / {}",
                            row.key.1, row.key.2
                        )))
                        .on_click(cx.listener(move |v, _, _, cx| {
                            if v.records.serial == serial {
                                v.records.expanded = if expanded {
                                    None
                                } else {
                                    Some(clicked_id.clone())
                                };
                                cx.notify();
                            }
                        })),
                    );
                if expanded {
                    let json = row.json();
                    item = item.child(div().id("usage-record-detail").test_support().v_flex().min_w_0().w_full().gap(px(Space::CONTROL))
                        .child(ui::text(Text::Body, row.counts()))
                        .child(ui::text(Text::Body, row.costs()))
                        .child(ui::text(Text::Caption, "Exact recorded fields. Missing fields are unknown; IDs are plain text."))
                        .child(ui::action("usage-record-copy", "Copy record JSON", Action::Quiet).self_start()
                            .on_click(cx.listener(move |v, _, _, cx| {
                                if v.records.serial == serial && v.records.expanded.as_ref() == Some(&id) { cx.write_to_clipboard(gpui_kit::ClipboardItem::new_string(json.clone())); }
                            })))
                        .child(div().id("usage-record-data").test_support().w_full().min_w_0().font_family(crate::appearance::CODE_FONT).text_size(px(Text::Caption.size())).child(gpui_kit::base::SelectableText::new(SharedString::from(format!("usage-record-json-{}", row.id())), SharedString::from(row.json())))));
                }
                section = section.child(item);
            }
            section = section.child(
                div()
                    .h_flex()
                    .gap(px(Space::CONTROL))
                    .child(
                        ui::action("usage-records-first", "First page", Action::Quiet)
                            .disabled(self.records.busy)
                            .on_click(cx.listener(|v, _, w, cx| v.read_records(false, w, cx))),
                    )
                    .child(
                        ui::action("usage-records-next", "Next records", Action::Quiet)
                            .disabled(self.records.busy || page.next.is_none())
                            .on_click(cx.listener(|v, _, w, cx| v.read_records(true, w, cx))),
                    ),
            );
        } else if !self.records.busy {
            section = section.child(
                ui::action("usage-records-retry", "Read first page", Action::Quiet)
                    .self_start()
                    .on_click(cx.listener(|v, _, w, cx| v.read_records(false, w, cx))),
            );
        }
        section
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
            ui::action("usage-refresh", "Refresh history", Action::Quiet)
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
        if let Some(picker) = &self.picker {
            page = page.child(
                div()
                    .id("usage-project-filter")
                    .test_support()
                    .w_full()
                    .max_w(px(440.))
                    .min_w_0()
                    .child(
                        Select::new(picker)
                            .accessibility_label("Historical usage project")
                            .menu_max_h(px(260.)),
                    ),
            );
        }
        if self.state.catalogue.as_ref().is_some_and(|c| c.limited) {
            page = page.child(
                div()
                    .id("usage-project-limited")
                    .test_support()
                    .child(ui::text(
                        Text::Caption,
                        "Project list limited to the first 100 ledger groups in this range.",
                    )),
            );
        }
        if self.state.error.is_some() && self.state.catalogue.is_some() {
            page = page.child(ui::text(
                Text::Caption,
                "Project choices retained from a previous read.",
            ));
        }
        if let Some(Err(error)) = self.state.snapshot.as_ref().map(|s| &s.projects) {
            page = page.child(
                div().id("usage-project-error").test_support().child(
                    Notice::new(
                        "Project list unavailable. Any retained choices are from a previous read.",
                    )
                    .detail(*error)
                    .tone(Tone::Quiet),
                ),
            );
        }
        if let Some(limits) = &self.limits {
            page = page
                .child(ui::text(
                    Text::Caption,
                    "Subscription limits · all projects, independent of history filters",
                ))
                .child(limits.clone());
        }
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
                .child(ui::text(Text::Caption,format!("{} · {}",snapshot.filter.label(),snapshot.range.label())))
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
            page = page
                .child(summaries)
                .child(self.records_section(cx))
                .child(ui::rule(w, cx));
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
        let content = crate::local_view::menu_routing::window_commands(div())
            .track_focus(&self.focus)
            .size_full()
            .bg(cx.theme().background)
            .text_color(cx.theme().foreground)
            .overflow_y_scrollbar()
            .child(page);
        div()
            .id("usage-page")
            .test_support()
            .size_full()
            .child(content)
    }
}
