//! Immutable Local scope; only category-open and explicit Refresh issue a passive GET.
use crate::{
    LocalOptions,
    mcp_status::timestamp,
    scheduled_messages::{Item, State},
    scheduled_messages_reader::{Reader, Request},
    ui::{self, Action, Notice, ResourceLabel, Text, Tone},
};
use gpui_kit::{
    App, AppContext, Context, Entity, Focusable, InteractiveElement, IntoElement, ParentElement,
    Render, SharedString, Styled, Subscription, Task, TestSupportExt, Window,
    base::SelectableText,
    component::{
        ActiveTheme, Disableable, IndexPath, StyledExt,
        list::{List, ListDelegate, ListEvent, ListItem, ListState},
    },
    div, px,
};
struct Rows {
    items: Vec<Item>,
}
impl ListDelegate for Rows {
    type Item = ListItem;
    fn set_selected_index(
        &mut self,
        _: Option<IndexPath>,
        _: &mut Window,
        cx: &mut Context<ListState<Self>>,
    ) {
        cx.notify();
    }
    fn items_count(&self, _: usize, _: &App) -> usize {
        self.items.len()
    }
    fn section_header_height(&self, _: usize, _: &App) -> Option<gpui_kit::Pixels> {
        Some(px(0.))
    }
    fn render_section_header(
        &mut self,
        _: usize,
        _: &mut Window,
        _: &mut Context<ListState<Self>>,
    ) -> Option<impl IntoElement> {
        Some(div().h(px(0.)))
    }
    fn render_item(
        &mut self,
        ix: IndexPath,
        _: &mut Window,
        _: &mut Context<ListState<Self>>,
    ) -> Option<ListItem> {
        let item = self.items.get(ix.row)?;
        Some(
            ListItem::new(SharedString::from(format!("schedule-row-{}", item.id))).child(
                ResourceLabel::new(item.title.clone()).detail(format!(
                    "{} · {}",
                    item.status(),
                    item.target_label()
                )),
            ),
        )
    }
}
pub(crate) struct ScheduledMessages {
    pub(crate) state: State,
    options: LocalOptions,
    reader: Option<Reader>,
    updates: Option<Task<()>>,
    rows: Entity<ListState<Rows>>,
    _selection: Subscription,
    details: Option<String>,
}
impl ScheduledMessages {
    pub(crate) fn new(options: LocalOptions, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let rows =
            cx.new(|cx| ListState::new(Rows { items: Vec::new() }, window, cx).searchable(false));
        let _ = rows.read(cx).focus_handle(cx).tab_stop(true);
        let selection = cx.subscribe_in(&rows, window, |v, _, event, window, cx| {
            if let ListEvent::Confirm(ix) = event {
                v.details = v
                    .rows
                    .read(cx)
                    .delegate()
                    .items
                    .get(ix.row)
                    .map(|s| s.id.clone());
                v.rows.update(cx, |list, cx| list.focus(window, cx));
                cx.notify();
            }
        });
        Self {
            state: State::default(),
            options,
            reader: None,
            updates: None,
            rows,
            _selection: selection,
            details: None,
        }
    }
    pub(crate) fn close(&mut self, cx: &mut Context<Self>) {
        self.reader = None;
        self.updates = None;
        self.state.generation += 1;
        self.state.busy = false;
        cx.notify();
    }
    pub(crate) fn load(&mut self, cx: &mut Context<Self>) {
        let generation = self.state.begin();
        if self.reader.is_none() {
            match Reader::start(self.options.clone()) {
                Err(error) => {
                    self.state.accept(generation, Err(error), 0);
                    cx.notify();
                    return;
                }
                Ok((reader, output)) => {
                    self.reader = Some(reader);
                    self.updates = Some(cx.spawn(async move |view, cx| {
                        while let Ok(response) = output.recv().await {
                            if view
                                .update(cx, |v, cx| {
                                    let success = response.result.is_ok();
                                    if v.state.accept(
                                        response.generation,
                                        response.result,
                                        crate::usage_overview::now(),
                                    ) {
                                        if success {
                                            let items = &v.state.snapshot.as_ref().unwrap().items;
                                            if !items
                                                .iter()
                                                .any(|s| Some(&s.id) == v.details.as_ref())
                                            {
                                                v.details = None;
                                            }
                                            v.rows.update(cx, |list, cx| {
                                                list.delegate_mut().items = items.clone();
                                                cx.notify();
                                            });
                                        }
                                        cx.notify();
                                    }
                                })
                                .is_err()
                            {
                                return;
                            }
                        }
                        let _ = view.update(cx, |v, cx| {
                            v.reader = None;
                            v.state.busy = false;
                            v.state.error =
                                Some("Local schedule reader stopped. Refresh to retry.");
                            cx.notify();
                        });
                    }));
                }
            }
        }
        if !self
            .reader
            .as_ref()
            .is_some_and(|r| r.request(Request { generation }))
        {
            self.state.accept(
                generation,
                Err("Local schedule read could not be queued. Refresh to retry."),
                0,
            );
        }
        cx.notify();
    }
}
impl Render for ScheduledMessages {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let mut page = div().id("schedules-page").test_support().v_flex().w_full().min_w_0().gap_4()
            .child(ui::header("schedules-title", "Scheduled messages", Text::Title)
                .child(ui::text(Text::Body, "Local · all projects and chats · read-only")))
            .child(ui::text(Text::Caption, "One-shot records, including new chats. Times are UTC. Reading does not send anything.").text_color(cx.theme().muted_foreground))
            .child(ui::action("schedules-refresh", "Refresh", Action::Quiet).disabled(self.state.busy).self_start()
                .on_click(cx.listener(|v, _, _, cx| v.load(cx))));
        if self.state.busy {
            page = page.child(notice(
                "schedules-loading",
                "Reading scheduled items…",
                Tone::Quiet,
            ));
        }
        if let Some(error) = self.state.error {
            page = page.child(notice("schedules-error", error, Tone::Error));
        }
        if let Some(at) = self.state.read_at {
            page = page.child(
                ui::text(
                    Text::Caption,
                    SharedString::from(format!("Last read {}", timestamp(at))),
                )
                .text_color(cx.theme().muted_foreground),
            );
        }
        if let Some(snapshot) = &self.state.snapshot {
            if self.state.error.is_some() || self.state.busy {
                page = page.child(notice(
                    "schedules-stale",
                    "Stale · showing the previous Local report.",
                    Tone::Quiet,
                ));
            }
            if snapshot.items.is_empty() {
                page = page.child(notice(
                    "schedules-empty",
                    "No scheduled items reported.",
                    Tone::Quiet,
                ));
            } else {
                page = page
                    .child(ui::text(
                        Text::Caption,
                        "Select a record for its time, exact target and details.",
                    ))
                    .child(
                        div()
                            .id("schedules-list")
                            .test_support()
                            .h(px(240.))
                            .w_full()
                            .min_w_0()
                            .child(List::new(&self.rows)),
                    );
            }
            if let Some(item) = snapshot
                .items
                .iter()
                .find(|s| Some(&s.id) == self.details.as_ref())
            {
                page = page.child(
                    div()
                        .v_flex()
                        .min_w_0()
                        .gap_2()
                        .child(ui::text(Text::Headline, "Details"))
                        .child(
                            ui::action("schedules-hide-details", "Hide details", Action::Quiet)
                                .self_start()
                                .on_click(cx.listener(|v, _, window, cx| {
                                    v.details = None;
                                    v.rows.update(cx, |list, cx| list.focus(window, cx));
                                    cx.notify();
                                })),
                        )
                        .child(
                            div()
                                .id("schedules-detail-text")
                                .test_support()
                                .w_full()
                                .min_w_0()
                                .child(SelectableText::new(
                                    SharedString::from(format!(
                                        "schedule-detail-{}-{}",
                                        item.id, item.revision
                                    )),
                                    SharedString::from(
                                        item.details(self.state.read_at.unwrap_or(0)),
                                    ),
                                )),
                        ),
                );
                if let Some(error) = &item.error {
                    page = page.child(div().id("schedules-record-error").test_support().child(
                        SelectableText::new("schedule-error", SharedString::from(error.clone())),
                    ));
                }
            }
        } else if !self.state.busy && self.state.error.is_none() {
            page = page.child(notice(
                "schedules-unread",
                "Scheduled items have not been read.",
                Tone::Quiet,
            ));
        }
        page
    }
}
fn notice(id: &'static str, text: impl Into<SharedString>, tone: Tone) -> impl IntoElement {
    div()
        .id(id)
        .test_support()
        .child(Notice::new(text).tone(tone))
}
