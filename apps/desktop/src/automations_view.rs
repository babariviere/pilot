//! The Automations page: what Pilot will do on its own, across all projects.
//! Sections hide when empty: Needs attention and One-time now; Recurring and Hooks join later.
//! Opening the page and Refresh issue the passive GET; Cancel and Dismiss are the only writes.
use crate::{
    LocalOptions,
    local_model::{Chat, Project},
    mcp_status::timestamp,
    scheduled_messages::{Item, RowAction, Section, State, Status, Target},
    scheduled_messages_reader::{Outcome, Reader, Request, perform},
    state_mark::{self, Glyph, Mark},
    ui::{self, Action, IconRole, Notice, Space, Text, Tone},
};
use gpui_kit::{
    Context, FocusHandle, InteractiveElement, IntoElement, ParentElement, Render, SharedString,
    StatefulInteractiveElement, Styled, Task, TestSupportExt, Window,
    base::SelectableText,
    component::{ActiveTheme, Disableable, Sizable, StyledExt, scroll::ScrollableElement},
    div,
    prelude::FluentBuilder,
    px,
};
use std::{collections::HashMap, sync::Arc};

/// Rows drawn per section. The store retains at most 1000 records.
const ROW_CAP: usize = 200;

struct Note {
    id: Option<String>,
    text: &'static str,
    tone: Tone,
}

pub(crate) struct Automations {
    pub(crate) state: State,
    options: Option<LocalOptions>,
    reader: Option<Reader>,
    updates: Option<Task<()>>,
    focus: FocusHandle,
    /// The row showing its message and actions.
    expanded: Option<String>,
    /// The row whose technical details are open.
    technical: Option<String>,
    /// Cancel or Dismiss in flight, by record ID.
    pub(crate) pending: Option<String>,
    action: Option<Task<()>>,
    note: Option<Note>,
    /// The page is showing. Action results only land while open.
    open: bool,
    session: u64,
    chats: Arc<Vec<Chat>>,
    titles: HashMap<String, String>,
    projects: Arc<Vec<Project>>,
}
impl Automations {
    pub(crate) fn new(cx: &mut Context<Self>) -> Self {
        Self {
            state: State::default(),
            options: None,
            reader: None,
            updates: None,
            focus: cx.focus_handle(),
            expanded: None,
            technical: None,
            pending: None,
            action: None,
            note: None,
            open: false,
            session: 0,
            chats: Arc::new(Vec::new()),
            titles: HashMap::new(),
            projects: Arc::new(Vec::new()),
        }
    }
    pub(crate) fn connect(&mut self, options: LocalOptions) {
        self.options = Some(options);
    }
    pub(crate) fn focus(&self, window: &mut Window, cx: &mut Context<Self>) {
        self.focus.focus(window, cx);
    }
    /// Names for targets. Only the shell's current chats and projects, never a title match.
    pub(crate) fn sync(
        &mut self,
        chats: &Arc<Vec<Chat>>,
        projects: &Arc<Vec<Project>>,
        cx: &mut Context<Self>,
    ) {
        if !Arc::ptr_eq(&self.chats, chats) {
            self.chats = chats.clone();
            self.titles = chats
                .iter()
                .map(|c| (c.id.clone(), c.title.clone()))
                .collect();
            cx.notify();
        }
        if !Arc::ptr_eq(&self.projects, projects) {
            self.projects = projects.clone();
            cx.notify();
        }
    }
    pub(crate) fn close(&mut self, cx: &mut Context<Self>) {
        if !self.open {
            return;
        }
        self.open = false;
        self.session += 1;
        self.reader = None;
        self.updates = None;
        self.pending = None;
        self.action = None;
        self.note = None;
        self.state.generation += 1;
        self.state.busy = false;
        cx.notify();
    }
    pub(crate) fn load(&mut self, cx: &mut Context<Self>) {
        self.open = true;
        let generation = self.state.begin();
        let Some(options) = self.options.clone() else {
            self.state.accept(
                generation,
                Err("Automations need the Local viewer. No host was queried."),
                0,
            );
            cx.notify();
            return;
        };
        if self.reader.is_none() {
            match Reader::start(options) {
                Err(error) => {
                    self.state.accept(generation, Err(error), 0);
                    cx.notify();
                    return;
                }
                Ok((reader, output)) => {
                    self.reader = Some(reader);
                    self.updates = Some(cx.spawn(async move |view, cx| {
                        while let Ok(response) = output.recv().await {
                            if view.update(cx, |v, cx| v.accept(response, cx)).is_err() {
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
    fn accept(
        &mut self,
        response: crate::scheduled_messages_reader::Response,
        cx: &mut Context<Self>,
    ) {
        if self.state.accept(
            response.generation,
            response.result,
            crate::usage_overview::now(),
        ) {
            if let Some(snapshot) = &self.state.snapshot {
                let shown = |id: &Option<String>| {
                    id.as_ref().is_some_and(|id| {
                        snapshot
                            .items
                            .iter()
                            .any(|s| &s.id == id && s.section().is_some())
                    })
                };
                if !shown(&self.expanded) {
                    self.expanded = None;
                }
                if !shown(&self.technical) {
                    self.technical = None;
                }
            }
            cx.notify();
        }
    }
    pub(crate) fn run(&mut self, id: String, cx: &mut Context<Self>) {
        let Some(options) = self.options.clone() else {
            return;
        };
        let Some((revision, action)) = self
            .state
            .snapshot
            .as_ref()
            .and_then(|s| s.items.iter().find(|s| s.id == id))
            .and_then(|s| Some((s.revision, s.action()?)))
        else {
            return;
        };
        if !self.open || self.pending.is_some() {
            return;
        }
        self.note = None;
        self.pending = Some(id.clone());
        let session = self.session;
        let outcome = perform(options, id.clone(), revision, action);
        self.action = Some(cx.spawn(async move |view, cx| {
            let outcome = outcome.recv().await.unwrap_or(Outcome::Refused(
                "Pilot couldn’t start the request. Nothing was changed.",
            ));
            let _ = view.update(cx, |v, cx| v.finish(session, id, action, outcome, cx));
        }));
        cx.notify();
    }
    fn finish(
        &mut self,
        session: u64,
        id: String,
        action: RowAction,
        outcome: Outcome,
        cx: &mut Context<Self>,
    ) {
        if session != self.session {
            return;
        }
        self.pending = None;
        self.action = None;
        self.note = match outcome {
            Outcome::Done => Some(Note {
                id: None,
                text: match action {
                    RowAction::Cancel => "Cancelled. It won’t be sent.",
                    RowAction::Dismiss => "Dismissed.",
                },
                tone: Tone::Quiet,
            }),
            Outcome::Refused(text) => Some(Note {
                id: Some(id),
                text,
                tone: Tone::Warning,
            }),
            Outcome::Unconfirmed(text) => Some(Note {
                id: Some(id),
                text,
                tone: Tone::Warning,
            }),
        };
        // A passive re-read shows what happened. The request is never repeated.
        self.load(cx);
    }
    fn target(&self, item: &Item) -> String {
        match &item.target {
            Target::Message { session_id, .. } => self
                .titles
                .get(session_id)
                .cloned()
                .unwrap_or_else(|| "a chat not listed here".into()),
            Target::Chat { .. } => match item
                .new_chat_project()
                .and_then(|id| self.projects.iter().find(|p| p.id == id))
            {
                Some(project) => format!("New chat in {}", project.name),
                None => "New chat".into(),
            },
        }
    }
    fn row(&self, item: &Item, now: u64, cx: &mut Context<Self>) -> impl IntoElement {
        let key = item.id.clone();
        let id = |part: &str| SharedString::from(format!("automation-{part}-{key}"));
        let expanded = self.expanded.as_ref() == Some(&item.id);
        let muted = cx.theme().muted_foreground;
        let read_at = self.state.read_at.unwrap_or(now);
        let status = item.status(read_at);
        let line_text = format!("{} → {}", item.when(now), self.target(item));
        let toggle = {
            let key = key.clone();
            move |v: &mut Self, cx: &mut Context<Self>| {
                v.expanded = if v.expanded.as_ref() == Some(&key) {
                    None
                } else {
                    Some(key.clone())
                };
                cx.notify();
            }
        };
        let mut line = div()
            .h_flex()
            .items_center()
            .w_full()
            .min_w_0()
            .gap_2()
            .min_h(px(36.))
            .child(
                div()
                    .flex_none()
                    .w(px(state_mark::SLOT))
                    .flex()
                    .justify_center()
                    .when(status == Some(Status::Failed), |d| {
                        d.child(state_mark::glyph(Glyph::Mark(Mark::Failed), cx))
                    }),
            )
            .child({
                let toggle = toggle.clone();
                div()
                    .id(id("text"))
                    .test_support()
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .cursor_pointer()
                    .text_size(px(Text::Body.size()))
                    .child(SharedString::from(line_text.clone()))
                    .on_click(cx.listener(move |v, _, _, cx| toggle(v, cx)))
            });
        if let Some(status) = status {
            let tone = match status {
                Status::Failed => Tone::Error,
                Status::Overdue => Tone::Warning,
                Status::Sending => Tone::Quiet,
            };
            line = line.child(
                ui::text(Text::Caption, status.label())
                    .id(id("status"))
                    .test_support()
                    .flex_none()
                    .text_color(tone.color(cx)),
            );
        }
        if let Some(action) = item.action() {
            let mine = self.pending.as_ref() == Some(&item.id);
            let target = key.clone();
            line = line.child(
                ui::action(id("action"), action.label(), Action::Quiet)
                    .flex_none()
                    .tooltip(match action {
                        RowAction::Cancel => "Stops this message from being sent",
                        RowAction::Dismiss => "Removes this failed message from the list",
                    })
                    .accessibility_label(SharedString::from(format!(
                        "{}: {line_text}",
                        action.label()
                    )))
                    .disabled(self.pending.is_some() || !self.open)
                    .loading(mine)
                    .on_click(cx.listener(move |v, _, _, cx| v.run(target.clone(), cx))),
            );
        }
        line = line.child(
            ui::icon_action(
                id("details"),
                SharedString::from(if expanded {
                    format!("Hide {line_text}")
                } else {
                    format!("Show {line_text}")
                }),
                if expanded {
                    IconRole::Collapse
                } else {
                    IconRole::Expand
                },
                Action::Quiet,
            )
            .flex_none()
            .on_click(cx.listener(move |v, _, _, cx| toggle(v, cx))),
        );
        let note = self
            .note
            .as_ref()
            .filter(|n| n.id.as_ref() == Some(&item.id));
        let extra = expanded || note.is_some();
        let mut more = div()
            .v_flex()
            .min_w_0()
            .gap_1()
            .pl(px(state_mark::SLOT + Space::CONTROL))
            .text_size(px(Text::Caption.size()));
        if let Some(note) = note {
            more = more.child(
                ui::text(Text::Caption, note.text)
                    .id(id("note"))
                    .test_support()
                    .text_color(note.tone.color(cx)),
            );
        }
        if expanded {
            let when = item.at.map(crate::message_time::detail);
            let lead = match (&item.target, when) {
                (Target::Message { .. }, Some(at)) => format!("Sends {at}"),
                (Target::Chat { .. }, Some(at)) => format!("Starts a new chat {at}"),
                (_, None) => "No time reported".into(),
            };
            more = more
                .child(ui::text(Text::Caption, SharedString::from(lead)).text_color(muted))
                .child(
                    div()
                        .id(id("message"))
                        .test_support()
                        .w_full()
                        .min_w_0()
                        .text_size(px(Text::Body.size()))
                        .child(SelectableText::new(
                            id("message-text"),
                            SharedString::from(item.message().to_owned()),
                        )),
                );
            if let Some(error) = &item.error {
                more = more.child(
                    div()
                        .id(id("error"))
                        .test_support()
                        .text_color(cx.theme().danger)
                        .child(SelectableText::new(
                            id("error-text"),
                            SharedString::from(error.clone()),
                        )),
                );
            }
            let technical = self.technical.as_ref() == Some(&item.id);
            let target = key.clone();
            more = more.child(
                ui::action(id("technical"), "Details", Action::Quiet)
                    .small()
                    .self_start()
                    .icon(if technical {
                        IconRole::Collapse.icon()
                    } else {
                        IconRole::Expand.icon()
                    })
                    .accessibility_label(if technical {
                        "Hide details"
                    } else {
                        "Show details"
                    })
                    .on_click(cx.listener(move |v, _, _, cx| {
                        v.technical = if v.technical.as_ref() == Some(&target) {
                            None
                        } else {
                            Some(target.clone())
                        };
                        cx.notify();
                    })),
            );
            if technical {
                more = more.child(
                    div()
                        .id(id("technical-text"))
                        .test_support()
                        .w_full()
                        .min_w_0()
                        .text_color(muted)
                        .child(SelectableText::new(
                            id("technical-content"),
                            SharedString::from(item.technical()),
                        )),
                );
            }
        }
        div()
            .id(id("row"))
            .test_support()
            .v_flex()
            .w_full()
            .min_w_0()
            .pb(px(if extra { 8. } else { 0. }))
            .child(line)
            .when(extra, |d| d.child(more))
    }
    fn group(
        &self,
        id: &'static str,
        label: String,
        rows: &[&Item],
        now: u64,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let mut group = div()
            .id(id)
            .test_support()
            .v_flex()
            .w_full()
            .min_w_0()
            .child(
                ui::text(Text::Caption, SharedString::from(label))
                    .font_semibold()
                    .text_color(cx.theme().muted_foreground)
                    .pb_1(),
            );
        for (i, item) in rows.iter().take(ROW_CAP).enumerate() {
            if i > 0 {
                group = group.child(ui::rule(window, cx));
            }
            group = group.child(self.row(item, now, cx));
        }
        if rows.len() > ROW_CAP {
            group = group.child(
                ui::text(
                    Text::Caption,
                    SharedString::from(format!("Showing the first {ROW_CAP} of {}", rows.len())),
                )
                .text_color(cx.theme().muted_foreground)
                .pt_1(),
            );
        }
        group
    }
}
impl Render for Automations {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let muted = cx.theme().muted_foreground;
        let now = crate::usage_overview::now();
        let (attention, one_time) = self.state.snapshot.as_ref().map_or_else(
            || (Vec::new(), Vec::new()),
            |s| (s.section(Section::Attention), s.section(Section::OneTime)),
        );
        let meta = match (&self.state.snapshot, one_time.len(), attention.len()) {
            (None, ..) => "All projects".to_owned(),
            (Some(_), 0, 0) => "All projects · nothing scheduled".to_owned(),
            (Some(_), n, 0) => format!("All projects · {n} upcoming"),
            (Some(_), 0, a) => format!("All projects · {a} need attention"),
            (Some(_), n, a) => format!("All projects · {n} upcoming · {a} need attention"),
        };
        let refresh_help = match self.state.read_at {
            Some(at) => format!("Refresh · last read {}", timestamp(at)),
            None => "Refresh".to_owned(),
        };
        let header = div()
            .h_flex()
            .items_start()
            .justify_between()
            .w_full()
            .min_w_0()
            .gap_3()
            .child(
                ui::header("automations-title", "Automations", Text::Title)
                    .min_w_0()
                    .child(
                        ui::text(Text::Caption, SharedString::from(meta))
                            .id("automations-meta")
                            .test_support()
                            .text_color(muted),
                    ),
            )
            .child(
                div().h_flex().flex_none().items_center().gap_1().child(
                    ui::icon_action(
                        "automations-refresh",
                        "Refresh",
                        IconRole::Retry,
                        Action::Quiet,
                    )
                    .tooltip(SharedString::from(refresh_help))
                    .loading(self.state.busy)
                    .disabled(self.state.busy || self.options.is_none())
                    .on_click(cx.listener(|v, _, _, cx| v.load(cx))),
                ),
            );
        let mut page = ui::page()
            .id("automations-page")
            .test_support()
            .gap_5()
            .child(header);
        if self.state.busy && self.state.snapshot.is_none() {
            page = page.child(notice(
                "automations-loading",
                "Reading automations…",
                Tone::Quiet,
            ));
        }
        if let Some(error) = self.state.error {
            page = page.child(notice("automations-error", error, Tone::Error));
        }
        if let Some(note) = self.note.as_ref().filter(|n| n.id.is_none()) {
            page = page.child(notice("automations-note", note.text, note.tone));
        }
        if self.state.snapshot.is_some() {
            if self.state.error.is_some() {
                page = page.child(notice(
                    "automations-stale",
                    "Showing the last report from Local.",
                    Tone::Quiet,
                ));
            }
            if !attention.is_empty() {
                page = page.child(self.group(
                    "automations-attention",
                    "Needs attention".into(),
                    &attention,
                    now,
                    window,
                    cx,
                ));
            }
            if !one_time.is_empty() {
                page = page.child(self.group(
                    "automations-one-time",
                    format!("One-time · {}", one_time.len()),
                    &one_time,
                    now,
                    window,
                    cx,
                ));
            }
            // Sent and cancelled records are history, not shown here.
            if attention.is_empty() && one_time.is_empty() {
                page = page.child(notice(
                    "automations-empty",
                    "Nothing scheduled.",
                    Tone::Quiet,
                ));
            }
        }
        div()
            .id("automations-scroll")
            .track_focus(&self.focus)
            .v_flex()
            .size_full()
            .min_h_0()
            .min_w_0()
            .overflow_y_scrollbar()
            .child(page)
    }
}
fn notice(id: &'static str, text: impl Into<SharedString>, tone: Tone) -> impl IntoElement {
    div()
        .id(id)
        .test_support()
        .child(Notice::new(text).tone(tone))
}
