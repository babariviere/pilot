//! Passive project knowledge reading window, scoped to one immutable Local project.
//! Readable content first; sources, history and IDs stay one step away.
use crate::{
    LocalOptions,
    knowledge::{Data, Detail, History, Kind, Page, Query, Route, source},
    knowledge_reader::{Reader, Request, Response},
    local_model::Project,
    ui::{self, Action, Notice, Space, Text, Tone},
};
use gpui_kit::{
    App, AppContext, Context, Entity, FocusHandle, InteractiveElement, IntoElement, ParentElement,
    Render, SharedString, Styled, Subscription, Task, TestSupportExt, Window,
    base::SelectableText,
    component::{
        ActiveTheme, Disableable, Selectable, StyledExt,
        input::{Input, InputEvent, InputState},
        scroll::ScrollableElement,
        text::{TextView, TextViewState},
    },
    div,
    prelude::FluentBuilder,
    px,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Screen {
    List,
    Entry { id: String, revision: Option<u64> },
    History { id: String },
}

pub(crate) struct Knowledge {
    project: Project,
    options: Option<LocalOptions>,
    reader: Option<Reader>,
    updates: Option<Task<()>>,
    pub(crate) generation: u64,
    pub(crate) busy: bool,
    pub(crate) error: Option<&'static str>,
    pending: Option<Route>,
    pub(crate) screen: Screen,
    back: Vec<Screen>,
    /// Applied filters; the search field is only a draft until Enter.
    pub(crate) query: Query,
    pub(crate) list: Option<Page>,
    pub(crate) detail: Option<Detail>,
    pub(crate) history: Option<(String, History)>,
    pub(crate) selected: Option<String>,
    sources_open: bool,
    details_open: bool,
    body: Option<(String, u64, Entity<TextViewState>)>,
    focus: FocusHandle,
    pub(crate) search: Entity<InputState>,
    _subscriptions: Vec<Subscription>,
}

impl Knowledge {
    pub(crate) fn new(
        options: Option<LocalOptions>,
        project: Project,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let search = cx.new(|cx| InputState::new(w, cx).placeholder("Filter titles and summaries"));
        // Typing is a draft. Enter applies it as one explicit read.
        let search_events = cx.subscribe_in(&search, w, |v, _, event, w, cx| match event {
            InputEvent::PressEnter { .. } => v.apply_filter(w, cx),
            InputEvent::Change => cx.notify(),
            _ => {}
        });
        Self {
            project,
            options,
            reader: None,
            updates: None,
            generation: 0,
            busy: false,
            error: None,
            pending: None,
            screen: Screen::List,
            back: Vec::new(),
            query: Query::default(),
            list: None,
            detail: None,
            history: None,
            selected: None,
            sources_open: false,
            details_open: false,
            body: None,
            focus: cx.focus_handle().tab_stop(true),
            search,
            _subscriptions: vec![search_events],
        }
    }
    pub(crate) fn focus(&self, w: &mut Window, cx: &mut App) {
        self.focus.focus(w, cx);
    }
    pub(crate) fn close(&mut self, cx: &mut Context<Self>) {
        self.reader = None;
        self.updates = None;
        self.generation += 1;
        self.pending = None;
        self.busy = false;
        cx.notify();
    }
    fn request(&mut self, route: Route, w: &mut Window, cx: &mut Context<Self>) {
        self.generation += 1;
        let generation = self.generation;
        self.pending = Some(route.clone());
        self.busy = true;
        self.error = None;
        if self.reader.is_none() {
            match self
                .options
                .clone()
                .ok_or("Knowledge is available only through Local. No host was queried.")
                .and_then(|o| Reader::start(o, self.project.id.clone()))
            {
                Err(e) => {
                    self.fail(generation, e, cx);
                    return;
                }
                Ok((reader, output)) => {
                    self.reader = Some(reader);
                    self.updates = Some(cx.spawn_in(w, async move |v, cx| {
                        while let Ok(r) = output.recv().await {
                            if v.update(cx, |v, cx| v.accept(r, cx)).is_err() {
                                return;
                            }
                        }
                        let _ = v.update(cx, |v, cx| {
                            v.reader = None;
                            v.busy = false;
                            v.pending = None;
                            v.error = Some("Local knowledge reader stopped. Refresh to retry.");
                            cx.notify();
                        });
                    }));
                }
            }
        }
        if !self
            .reader
            .as_ref()
            .is_some_and(|r| r.request(Request { generation, route }))
        {
            self.fail(
                generation,
                "Knowledge request could not be queued. Refresh to retry.",
                cx,
            );
        }
        cx.notify();
    }
    fn fail(&mut self, generation: u64, e: &'static str, cx: &mut Context<Self>) {
        if self.generation == generation {
            self.busy = false;
            self.pending = None;
            self.error = Some(e);
            cx.notify();
        }
    }
    /// Only the latest request's exact route may change what is shown.
    pub(crate) fn accept(&mut self, r: Response, cx: &mut Context<Self>) {
        if r.generation != self.generation || self.pending.as_ref() != Some(&r.route) {
            return;
        }
        self.busy = false;
        self.pending = None;
        match (r.result, r.route) {
            (Err(e), _) => self.error = Some(e),
            (Ok(Data::Page(page)), Route::List(q)) => match (&mut self.list, q.cursor) {
                (Some(list), Some(_)) => {
                    let known: std::collections::HashSet<_> =
                        list.entries.iter().map(|e| e.id.clone()).collect();
                    list.entries
                        .extend(page.entries.into_iter().filter(|e| !known.contains(&e.id)));
                    list.more = page.more;
                    list.cursor = page.cursor;
                }
                _ => self.list = Some(page),
            },
            (Ok(Data::Detail(d)), Route::Detail { .. }) => {
                let (id, revision) = (d.entry.id.clone(), d.revision.summary.revision);
                if !self
                    .body
                    .as_ref()
                    .is_some_and(|(i, r, _)| *i == id && *r == revision)
                {
                    let body = d.revision.body.clone();
                    let state = cx.new(|cx| {
                        TextViewState::markdown(&body, cx)
                            .images_enabled(false)
                            .retain_selection_on_unmount(true, cx)
                    });
                    self._subscriptions.truncate(1);
                    self._subscriptions
                        .push(cx.observe(&state, |_, _, cx| cx.notify()));
                    self.body = Some((id, revision, state));
                }
                self.detail = Some(*d);
            }
            (Ok(Data::History(h)), Route::History { id, cursor }) => {
                match (&mut self.history, cursor) {
                    (Some((hid, history)), Some(_)) if *hid == id => {
                        history.revisions.extend(h.revisions);
                        history.more = h.more;
                        history.cursor = h.cursor;
                    }
                    _ => self.history = Some((id, h)),
                }
            }
            _ => self.error = Some("Local returned an unexpected knowledge response."),
        }
        cx.notify();
    }

    pub(crate) fn load_list(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        self.screen = Screen::List;
        self.back.clear();
        self.request(Route::List(self.query.clone()), w, cx);
    }
    fn load_more(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        let Some(cursor) = self.list.as_ref().and_then(|l| l.cursor.clone()) else {
            return;
        };
        self.request(
            Route::List(Query {
                cursor: Some(cursor),
                ..self.query.clone()
            }),
            w,
            cx,
        );
    }
    fn set_query(&mut self, query: Query, w: &mut Window, cx: &mut Context<Self>) {
        if query == self.query && self.list.is_some() {
            return;
        }
        self.query = query;
        // A different filter is a different set: never show old rows as its result.
        self.list = None;
        self.load_list(w, cx);
    }
    fn apply_filter(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        let q = self.search.read(cx).value().trim().to_owned();
        self.set_query(
            Query {
                q,
                ..self.query.clone()
            },
            w,
            cx,
        );
    }
    /// Opens an exact entry (current when revision is None) from outside the window.
    pub(crate) fn reveal(
        &mut self,
        id: String,
        revision: Option<u64>,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.back = vec![Screen::List];
        self.show_entry(id, revision, w, cx);
    }
    fn open_entry(
        &mut self,
        id: String,
        revision: Option<u64>,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.back.push(self.screen.clone());
        self.show_entry(id, revision, w, cx);
        self.focus(w, cx);
    }
    fn show_entry(
        &mut self,
        id: String,
        revision: Option<u64>,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.detail.as_ref().is_some_and(|d| d.entry.id == id) {
            self.sources_open = false;
            self.details_open = false;
        }
        self.selected = Some(id.clone());
        self.screen = Screen::Entry {
            id: id.clone(),
            revision,
        };
        self.request(Route::Detail { id, revision }, w, cx);
    }
    fn open_history(&mut self, id: String, w: &mut Window, cx: &mut Context<Self>) {
        self.back.push(self.screen.clone());
        self.screen = Screen::History { id: id.clone() };
        self.history = None;
        self.request(Route::History { id, cursor: None }, w, cx);
        self.focus(w, cx);
    }
    pub(crate) fn go_back(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        let Some(screen) = self.back.pop() else {
            return;
        };
        self.screen = screen.clone();
        match screen {
            // Retained rows keep scroll position and selection; Refresh rereads.
            Screen::List if self.list.is_some() => {
                self.generation += 1;
                self.pending = None;
                self.busy = false;
                self.error = None;
                cx.notify();
            }
            Screen::List => self.request(Route::List(self.query.clone()), w, cx),
            Screen::Entry { id, revision } => self.request(Route::Detail { id, revision }, w, cx),
            Screen::History { id } if self.history.as_ref().is_some_and(|(h, _)| *h == id) => {
                self.generation += 1;
                self.pending = None;
                self.busy = false;
                self.error = None;
                cx.notify();
            }
            Screen::History { id } => self.request(Route::History { id, cursor: None }, w, cx),
        }
        self.focus(w, cx);
    }
    fn refresh(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        match self.screen.clone() {
            Screen::List => self.request(Route::List(self.query.clone()), w, cx),
            Screen::Entry { id, revision } => self.request(Route::Detail { id, revision }, w, cx),
            Screen::History { id } => self.request(Route::History { id, cursor: None }, w, cx),
        }
    }

    fn list_view(&self, page: gpui_kit::Div, cx: &mut Context<Self>) -> gpui_kit::Div {
        let mut page = page;
        let kind = self.query.kind;
        let filter = |id: &'static str, label: &'static str, value: Option<Kind>| {
            ui::action(id, label, Action::Quiet)
                .selected(kind == value)
                .toggled(kind == value)
                .on_click(cx.listener(move |v, _, w, cx| {
                    let query = Query {
                        kind: value,
                        ..v.query.clone()
                    };
                    v.set_query(query, w, cx);
                }))
        };
        let needs = self.query.needs_check;
        page = page.child(
            div()
                .id("knowledge-filters")
                .test_support()
                .h_flex()
                .flex_wrap()
                .gap(px(Space::CONTROL))
                .child(filter("knowledge-all", "All", None))
                .child(filter(
                    "knowledge-components",
                    "Components",
                    Some(Kind::Component),
                ))
                .child(filter(
                    "knowledge-investigations",
                    "Investigations",
                    Some(Kind::Investigation),
                ))
                .child(
                    ui::action("knowledge-needs-check", "Needs a check", Action::Quiet)
                        .selected(needs)
                        .toggled(needs)
                        .on_click(cx.listener(move |v, _, w, cx| {
                            let query = Query {
                                needs_check: !needs,
                                ..v.query.clone()
                            };
                            v.set_query(query, w, cx);
                        })),
                ),
        );
        let applied = !self.query.q.is_empty();
        page = page.child(
            div()
                .v_flex()
                .gap(px(Space::CONTROL))
                .child(
                    Input::new(&self.search).id("knowledge-search").aria_label(
                        "Filter knowledge titles and summaries. Press Return to apply.",
                    ),
                )
                .child(
                    div()
                        .h_flex()
                        .flex_wrap()
                        .items_center()
                        .gap(px(Space::CONTROL))
                        .child(
                            ui::text(
                                Text::Caption,
                                if applied {
                                    SharedString::from(format!("Matching “{}”", self.query.q))
                                } else {
                                    "Press Return to filter titles and summaries.".into()
                                },
                            )
                            .id("knowledge-search-scope")
                            .test_support()
                            .text_color(cx.theme().muted_foreground),
                        )
                        .when(applied, |d| {
                            d.child(
                                ui::action("knowledge-search-clear", "Clear filter", Action::Quiet)
                                    .on_click(cx.listener(|v, _, w, cx| {
                                        v.search.update(cx, |i, cx| {
                                            i.set_value("", w, cx);
                                            i.focus(w, cx);
                                        });
                                        v.apply_filter(w, cx);
                                    })),
                            )
                        }),
                ),
        );
        page = self.status(page, self.list.is_some(), cx);
        let Some(list) = &self.list else {
            return page;
        };
        if list.entries.is_empty() && !self.busy && self.error.is_none() {
            let filtered = applied || needs || kind.is_some();
            page = page.child(notice(
                "knowledge-empty",
                if filtered {
                    "No entries match these filters."
                } else {
                    "No knowledge yet."
                },
                Tone::Quiet,
            ));
        }
        for entry in &list.entries {
            let id = entry.id.clone();
            let open = ui::action(
                SharedString::from(format!("knowledge-open-{}", entry.id)),
                "",
                Action::Quiet,
            )
            .disabled(self.busy)
            .on_click(cx.listener(move |v, _, w, cx| v.open_entry(id.clone(), None, w, cx)));
            page = page.child(entry_row(
                "knowledge-row",
                entry,
                self.selected.as_deref() == Some(entry.id.as_str()),
                open,
                cx,
            ));
        }
        if list.more {
            page = page.child(
                ui::action("knowledge-more", "Show more", Action::Quiet)
                    .self_start()
                    .disabled(self.busy)
                    .on_click(cx.listener(|v, _, w, cx| v.load_more(w, cx))),
            );
        }
        page
    }

    /// Loading, error and retained-observation notices, in that order.
    fn status(&self, mut page: gpui_kit::Div, retained: bool, cx: &App) -> gpui_kit::Div {
        let _ = cx;
        if self.busy {
            page = page.child(notice(
                "knowledge-loading",
                "Loading knowledge…",
                Tone::Quiet,
            ));
        }
        if let Some(e) = self.error {
            page = page.child(notice("knowledge-error", e, Tone::Error));
        }
        if retained && (self.busy || self.error.is_some()) {
            page = page.child(notice(
                "knowledge-retained",
                "Showing the earlier read.",
                Tone::Quiet,
            ));
        }
        page
    }

    fn entry_view(
        &self,
        mut page: gpui_kit::Div,
        id: &str,
        revision: Option<u64>,
        cx: &mut Context<Self>,
    ) -> gpui_kit::Div {
        let shown = self.detail.as_ref().filter(|d| {
            d.entry.id == id && revision.is_none_or(|r| r == d.revision.summary.revision)
        });
        page = self.status(page, shown.is_some(), cx);
        let Some(d) = shown else {
            return page;
        };
        let r = &d.revision.summary;
        page = page.child(
            ui::header(
                "knowledge-entry-title",
                SharedString::from(r.title.clone()),
                Text::Title,
            )
            .child(
                ui::text(
                    Text::Caption,
                    SharedString::from(format!(
                        "{} · revision {} of {} · recorded {} by {}",
                        d.entry.kind.label(),
                        r.revision,
                        d.entry.revision,
                        crate::usage_overview::date(r.recorded_at),
                        r.author.label()
                    )),
                )
                .id("knowledge-entry-meta")
                .test_support()
                .text_color(cx.theme().muted_foreground),
            ),
        );
        if d.historical() {
            let current = d.entry.id.clone();
            page = page.child(
                div()
                    .id("knowledge-historical")
                    .test_support()
                    .h_flex()
                    .flex_wrap()
                    .items_center()
                    .gap(px(Space::CONTROL))
                    .child(Notice::new(SharedString::from(format!(
                        "Earlier revision {}, kept as written.",
                        r.revision
                    ))))
                    .child(
                        ui::action("knowledge-open-current", "Open current", Action::Quiet)
                            .on_click(cx.listener(move |v, _, w, cx| {
                                v.open_entry(current.clone(), None, w, cx)
                            })),
                    ),
            );
        }
        page = page.child(
            div().id("knowledge-freshness").test_support().child(
                Notice::new(d.freshness.label())
                    .detail(d.freshness.detail())
                    .tone(if d.freshness.needs_check() {
                        Tone::Warning
                    } else {
                        Tone::Quiet
                    }),
            ),
        );
        if let Some(reason) = &r.reason {
            page = page.child(
                ui::text(
                    Text::Caption,
                    SharedString::from(format!("Why this revision: {reason}")),
                )
                .id("knowledge-reason")
                .test_support()
                .text_color(cx.theme().muted_foreground),
            );
        }
        if let Some((_, _, state)) = self
            .body
            .as_ref()
            .filter(|(i, rev, _)| *i == d.entry.id && *rev == r.revision)
        {
            page = page.child(
                div()
                    .id("knowledge-body")
                    .test_support()
                    .w_full()
                    .min_w_0()
                    .child(crate::typography::rich(
                        TextView::new(state),
                        crate::typography::current(cx),
                        crate::typography::Content::Chat,
                        cx,
                    )),
            );
        }
        let (entry, sources) = (d.entry.id.clone(), d.revision.sources.len());
        let (sources_open, details_open) = (self.sources_open, self.details_open);
        page = page.child(
            div()
                .id("knowledge-entry-actions")
                .test_support()
                .h_flex()
                .flex_wrap()
                .gap(px(Space::CONTROL))
                .child(
                    ui::action(
                        "knowledge-sources",
                        SharedString::from(format!("Sources ({sources})")),
                        Action::Quiet,
                    )
                    .selected(sources_open)
                    .toggled(sources_open)
                    .on_click(cx.listener(|v, _, _, cx| {
                        v.sources_open = !v.sources_open;
                        cx.notify();
                    })),
                )
                .child(
                    ui::action("knowledge-history", "History", Action::Quiet)
                        .disabled(self.busy)
                        .on_click(
                            cx.listener(move |v, _, w, cx| v.open_history(entry.clone(), w, cx)),
                        ),
                )
                .child(
                    ui::action("knowledge-details", "Details", Action::Quiet)
                        .selected(details_open)
                        .toggled(details_open)
                        .on_click(cx.listener(|v, _, _, cx| {
                            v.details_open = !v.details_open;
                            cx.notify();
                        })),
                ),
        );
        if sources_open {
            if d.revision.sources.is_empty() {
                page = page.child(notice(
                    "knowledge-no-sources",
                    "No sources cited.",
                    Tone::Quiet,
                ));
            }
            for (ix, raw) in d.revision.sources.iter().enumerate() {
                let s = source(raw);
                let mut row = div()
                    .id(("knowledge-source", ix))
                    .test_support()
                    .v_flex()
                    .min_w_0()
                    .gap(px(Space::META))
                    .child(ui::text(Text::Body, SharedString::from(s.title.clone())))
                    .child(
                        div()
                            .text_size(px(ui::TextRole::CAPTION))
                            .text_color(cx.theme().muted_foreground)
                            .child(SelectableText::new(
                                ("knowledge-source-locator", ix),
                                SharedString::from(s.locator.clone()),
                            )),
                    );
                row = match s.web.and_then(|u| crate::external_links::web(&u)) {
                    Some(url) => row.child(
                        ui::action(("knowledge-source-open", ix), "Open link", Action::Quiet)
                            .self_start()
                            .accessibility_label(SharedString::from(format!("Open {}", s.title)))
                            .on_click(move |_, _, cx| crate::external_links::open(&url, cx)),
                    ),
                    None => row.child(
                        ui::text(Text::Caption, "Opening this source here isn't available.")
                            .text_color(cx.theme().muted_foreground),
                    ),
                };
                page = page.child(row);
            }
        }
        if details_open {
            let o = &d.entry.origin;
            let or = |v: &Option<String>| v.clone().unwrap_or_else(|| "not recorded".into());
            let text = format!(
                "Entry {}\nProject {}\nRevision {} of {}, recorded {} by {}\nOrigin mission {}, task {}, chat {} (provenance, not ownership)",
                d.entry.id,
                d.entry.project_id,
                r.revision,
                d.entry.revision,
                crate::usage_overview::date(r.recorded_at),
                r.author.label(),
                or(&o.mission_id),
                or(&o.task_id),
                or(&o.session_id),
            );
            page = page.child(
                div()
                    .id("knowledge-provenance")
                    .test_support()
                    .text_size(px(ui::TextRole::CAPTION))
                    .child(SelectableText::new(
                        "knowledge-provenance-text",
                        SharedString::from(text),
                    )),
            );
        }
        page
    }

    fn history_view(
        &self,
        mut page: gpui_kit::Div,
        id: &str,
        cx: &mut Context<Self>,
    ) -> gpui_kit::Div {
        let title = self
            .detail
            .as_ref()
            .filter(|d| d.entry.id == id)
            .map_or("History".to_owned(), |d| {
                format!("History · {}", d.entry.title)
            });
        page = page.child(ui::heading(
            "knowledge-history-title",
            SharedString::from(title),
            Text::Headline,
        ));
        let shown = self
            .history
            .as_ref()
            .filter(|(h, _)| h == id)
            .map(|(_, h)| h);
        page = self.status(page, shown.is_some(), cx);
        let Some(h) = shown else {
            return page;
        };
        for r in &h.revisions {
            let (entry, revision) = (id.to_owned(), r.revision);
            page = page.child(
                div()
                    .id(("knowledge-revision", r.revision))
                    .test_support()
                    .v_flex()
                    .min_w_0()
                    .gap(px(Space::META))
                    .child(
                        ui::action(
                            ("knowledge-open-revision", r.revision),
                            SharedString::from(format!("Revision {} · {}", r.revision, r.title)),
                            Action::Quiet,
                        )
                        .self_start()
                        .disabled(self.busy)
                        .on_click(cx.listener(move |v, _, w, cx| {
                            v.open_entry(entry.clone(), Some(revision), w, cx)
                        })),
                    )
                    .child(
                        ui::text(
                            Text::Caption,
                            SharedString::from(format!(
                                "{} · {}{}",
                                crate::usage_overview::date(r.recorded_at),
                                r.author.label(),
                                r.reason
                                    .as_ref()
                                    .map_or(String::new(), |why| format!(" · {why}"))
                            )),
                        )
                        .px(px(10.))
                        .text_color(cx.theme().muted_foreground),
                    ),
            );
        }
        if h.more {
            let (entry, cursor) = (id.to_owned(), h.cursor.clone());
            page = page.child(
                ui::action(
                    "knowledge-history-more",
                    "Show older revisions",
                    Action::Quiet,
                )
                .self_start()
                .disabled(self.busy)
                .on_click(cx.listener(move |v, _, w, cx| {
                    v.request(
                        Route::History {
                            id: entry.clone(),
                            cursor: cursor.clone(),
                        },
                        w,
                        cx,
                    )
                })),
            );
        }
        page
    }
}

/// The caller's quiet Kit button opens the entry by its title; summary and state read
/// as plain text beneath it, never nested inside another interactive element.
pub(crate) fn entry_row(
    prefix: &str,
    entry: &crate::knowledge::Summary,
    selected: bool,
    open: gpui_kit::component::button::Button,
    cx: &App,
) -> gpui_kit::AnyElement {
    let muted = cx.theme().muted_foreground;
    div()
        .id(SharedString::from(format!("{prefix}-{}", entry.id)))
        .test_support()
        .v_flex()
        .w_full()
        .min_w_0()
        .gap(px(2.))
        .pb(px(Space::CONTROL))
        .rounded(px(ui::Radius::CONTROL))
        .when(selected, |d| d.bg(ui::selected_fill(cx)))
        .child(
            open.w_full()
                .justify_start()
                .accessibility_label(SharedString::from(format!(
                    "Open {}, {}",
                    entry.title,
                    entry.meta()
                )))
                .child(
                    ui::text(Text::Body, SharedString::from(entry.title.clone()))
                        .flex_1()
                        .min_w_0()
                        .text_left()
                        .truncate(),
                ),
        )
        .child(
            ui::text(Text::Caption, SharedString::from(entry.synopsis.clone()))
                .px(px(10.))
                .min_w_0(),
        )
        .child(
            ui::text(Text::Caption, SharedString::from(entry.meta()))
                .px(px(10.))
                .min_w_0()
                .truncate()
                .text_color(if entry.freshness.needs_check() {
                    cx.theme().warning
                } else {
                    muted
                }),
        )
        .into_any_element()
}

impl Render for Knowledge {
    fn render(&mut self, _w: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let mut page = ui::page().child(
            ui::header("knowledge-title", "Knowledge", Text::Title).child(
                ui::text(
                    Text::Body,
                    SharedString::from(format!("{} · Local", self.project.name)),
                )
                .text_color(cx.theme().muted_foreground),
            ),
        );
        let mut controls = div()
            .id("knowledge-controls")
            .test_support()
            .h_flex()
            .flex_wrap()
            .gap(px(Space::CONTROL));
        if !self.back.is_empty() {
            controls = controls.child(
                ui::action("knowledge-back", "Back", Action::Quiet)
                    .on_click(cx.listener(|v, _, w, cx| v.go_back(w, cx))),
            );
        }
        controls = controls.child(
            ui::action("knowledge-refresh", "Refresh", Action::Quiet)
                .accessibility_label("Refresh this knowledge view")
                .disabled(self.busy)
                .on_click(cx.listener(|v, _, w, cx| v.refresh(w, cx))),
        );
        page = page.child(controls);
        page = match self.screen.clone() {
            Screen::List => self.list_view(page, cx),
            Screen::Entry { id, revision } => self.entry_view(page, &id, revision, cx),
            Screen::History { id } => self.history_view(page, &id, cx),
        };
        div()
            .id("knowledge-page")
            .test_support()
            .track_focus(&self.focus)
            .size_full()
            .min_w_0()
            .bg(cx.theme().background)
            .text_color(cx.theme().foreground)
            .child(page)
            .overflow_y_scrollbar()
    }
}

fn notice(id: &'static str, text: impl Into<SharedString>, tone: Tone) -> impl IntoElement {
    div()
        .id(id)
        .test_support()
        .child(Notice::new(text).tone(tone))
}
