//! The Automations page: what Pilot will do on its own, across all projects.
//! Sections hide when empty: Needs attention and One-time now; Recurring and Hooks join later.
//! Opening the page and Refresh issue the passive GET; Cancel and Dismiss are the only writes.
use crate::{
    LocalOptions,
    local_model::{Chat, Project},
    mcp_status::timestamp,
    scheduled_messages::{Item, RowAction, Section, State, Status, Target},
    scheduled_messages_reader::{Outcome, Reader, Request, perform},
    ui::{self, Action, IconRole, Notice, Radius, Text, Tone},
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
    /// Self-contained Hooks section with its own reads and writes.
    pub(crate) hooks: gpui_kit::Entity<crate::automation_hooks_view::Hooks>,
}
impl Automations {
    pub(crate) fn new(cx: &mut Context<Self>) -> Self {
        let hooks = gpui_kit::AppContext::new(cx, crate::automation_hooks_view::Hooks::new);
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
            hooks,
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
        self.hooks.update(cx, |h, cx| h.sync(chats, projects, cx));
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
        self.hooks.update(cx, |h, cx| h.close(cx));
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
        let options = self.options.clone();
        self.hooks.update(cx, |h, cx| {
            if let Some(options) = options {
                h.connect(options);
            }
            h.load(cx);
        });
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
                .unwrap_or_else(|| "Unlisted chat".into()),
            Target::Chat { .. } => match item
                .new_chat_project()
                .and_then(|id| self.projects.iter().find(|p| p.id == id))
            {
                Some(project) => format!("New chat in {}", project.name),
                None => "New chat".into(),
            },
        }
    }
    fn row(
        &self,
        item: &Item,
        now: u64,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let key = item.id.clone();
        let id = |part: &str| SharedString::from(format!("automation-{part}-{key}"));
        let expanded = self.expanded.as_ref() == Some(&item.id);
        let theme = cx.theme();
        let (muted, hover, danger) = (theme.muted_foreground, theme.list_hover, theme.danger);
        let dark = theme.is_dark();
        let read_at = self.state.read_at.unwrap_or(now);
        let status = item.status(read_at);
        let failed = status == Some(Status::Failed);
        let when = item.when(now);
        let target = self.target(item);
        let line_text = format!("{when} → {target}");
        let preview = item
            .message()
            .lines()
            .map(str::trim)
            .find(|l| !l.is_empty())
            .unwrap_or("No message")
            .to_owned();
        let group = SharedString::from(format!("automation-hover-{key}"));
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
        // The glyph names what will happen: a follow-up in a chat, or a new chat.
        let (glyph, tint, ink) = if failed {
            (IconRole::Error, danger.opacity(0.12), danger)
        } else {
            let glyph = match item.target {
                Target::Message { .. } => IconRole::Chats,
                Target::Chat { .. } => IconRole::NewChat,
            };
            (glyph, tile(dark, cx), muted)
        };
        let mut meta = div().v_flex().flex_none().items_end().gap(px(2.)).child(
            ui::text(Text::Caption, SharedString::from(when))
                .whitespace_nowrap()
                .text_color(muted),
        );
        if let Some(status) = status {
            let tone = match status {
                Status::Failed => Tone::Error,
                Status::Overdue => Tone::Warning,
                Status::Sending => Tone::Quiet,
            };
            meta = meta.child(
                ui::text(Text::Caption, status.label())
                    .id(id("status"))
                    .test_support()
                    .whitespace_nowrap()
                    .font_medium()
                    .text_color(tone.color(cx)),
            );
        }
        let main = {
            let toggle = toggle.clone();
            div()
                .id(id("text"))
                .test_support()
                .h_flex()
                .flex_1()
                .min_w_0()
                .items_center()
                .gap_3()
                .cursor_pointer()
                .child(
                    div()
                        .flex_none()
                        .size(px(TILE))
                        .rounded(px(Radius::ROW))
                        .bg(tint)
                        .flex()
                        .items_center()
                        .justify_center()
                        .child(glyph.icon().text_color(ink)),
                )
                .child(
                    div()
                        .v_flex()
                        .flex_1()
                        .min_w_0()
                        .gap(px(1.))
                        .child(ui::text(Text::Body, SharedString::from(target)).truncate())
                        .child(
                            ui::text(Text::Caption, SharedString::from(preview))
                                .truncate()
                                .text_color(muted),
                        ),
                )
                .child(meta)
                .on_click(cx.listener(move |v, _, _, cx| toggle(v, cx)))
        };
        let note = self
            .note
            .as_ref()
            .filter(|n| n.id.as_ref() == Some(&item.id));
        let mut line = div()
            .h_flex()
            .items_center()
            .w_full()
            .min_w_0()
            .gap_2()
            .px(px(INSET))
            .py(px(8.))
            .child(main);
        // A fixed slot keeps times aligned whether or not a row has an action.
        let mut slot = div().flex_none().w(px(ACTION)).h_flex().justify_end();
        if let Some(action) = item.action() {
            let mine = self.pending.as_ref() == Some(&item.id);
            // Cancel waits on hover or keyboard focus; Dismiss is why the row is here.
            let quiet = action == RowAction::Cancel && !expanded && !mine && note.is_none();
            let target = key.clone();
            slot = slot.child(
                ui::action(id("action"), action.label(), Action::Quiet)
                    .small()
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
                    .when(quiet, |b| {
                        b.opacity(0.)
                            .group_hover(group.clone(), |s| s.opacity(1.))
                            .focus_visible(|s| s.opacity(1.))
                    })
                    .on_click(cx.listener(move |v, _, _, cx| v.run(target.clone(), cx))),
            );
        }
        line = line.child(slot).child(
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
            .small()
            .flex_none()
            .on_click(cx.listener(move |v, _, _, cx| toggle(v, cx))),
        );
        let extra = expanded || note.is_some();
        let mut more = div()
            .v_flex()
            .min_w_0()
            .gap_2()
            .pl(px(INSET + TILE + 12.))
            .pr(px(INSET))
            .pb(px(12.))
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
                        .w_full()
                        .min_w_0()
                        .px_3()
                        .py_2()
                        .rounded(px(Radius::CONTROL))
                        .bg(crate::appearance::card(cx))
                        .border(crate::appearance::hairline(window))
                        .border_color(cx.theme().border)
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
                        ),
                );
            if let Some(error) = &item.error {
                more = more.child(
                    div()
                        .id(id("error"))
                        .test_support()
                        .text_color(danger)
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
            .group(group)
            .v_flex()
            .w_full()
            .min_w_0()
            .rounded(px(Radius::ROW))
            .when(expanded, |d| d.bg(hover))
            .hover(move |s| s.bg(hover))
            .child(line)
            .when(extra, |d| d.child(more))
    }
    fn group(
        &self,
        id: &'static str,
        label: &'static str,
        rows: &[&Item],
        now: u64,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let muted = cx.theme().muted_foreground;
        let dark = cx.theme().is_dark();
        let mut list = div()
            .v_flex()
            .w_full()
            .min_w_0()
            .gap(px(2.))
            .p(px(4.))
            .rounded(px(Radius::CARD))
            .border(crate::appearance::hairline(window))
            .border_color(cx.theme().border)
            .bg(container(dark, cx));
        for item in rows.iter().take(ROW_CAP) {
            list = list.child(self.row(item, now, window, cx));
        }
        let mut group = div()
            .id(id)
            .test_support()
            .v_flex()
            .w_full()
            .min_w_0()
            .gap_2()
            .child(
                div()
                    .h_flex()
                    .items_baseline()
                    .gap_1p5()
                    .child(
                        ui::text(Text::Label, label)
                            .font_semibold()
                            .text_color(cx.theme().foreground),
                    )
                    .child(
                        ui::text(Text::Caption, SharedString::from(rows.len().to_string()))
                            .text_color(muted),
                    ),
            )
            .child(list);
        if rows.len() > ROW_CAP {
            group = group.child(
                ui::text(
                    Text::Caption,
                    SharedString::from(format!("Showing the first {ROW_CAP} of {}", rows.len())),
                )
                .text_color(muted),
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
        let needs = |a: usize| format!("{a} {} attention", if a == 1 { "needs" } else { "need" });
        let meta = match (one_time.len(), attention.len()) {
            (0, 0) => "Across all projects".to_owned(),
            (n, 0) => format!("{n} scheduled across all projects"),
            (0, a) => needs(a),
            (n, a) => format!("{n} scheduled · {}", needs(a)),
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
                    "Needs attention",
                    &attention,
                    now,
                    window,
                    cx,
                ));
            }
            if !one_time.is_empty() {
                page = page.child(self.group(
                    "automations-one-time",
                    "One-time",
                    &one_time,
                    now,
                    window,
                    cx,
                ));
            }
            // Sent and cancelled records are history, not shown here.
            if attention.is_empty() && one_time.is_empty() {
                page = page.child(empty(muted, cx));
            }
        }
        page = page.child(self.hooks.clone());
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
/// Row glyph tile and group geometry, in points.
const TILE: f32 = 28.;
const INSET: f32 = 10.;
/// Wide enough for Cancel or Dismiss at the small control size.
const ACTION: f32 = 64.;
/// The grouped list: white on the light page, a lifted tray on the dark one.
fn container(dark: bool, cx: &gpui_kit::App) -> gpui_kit::Hsla {
    if dark {
        crate::appearance::tray(cx)
    } else {
        crate::appearance::card(cx)
    }
}
/// The glyph tile contrasts with the group it sits in.
fn tile(dark: bool, cx: &gpui_kit::App) -> gpui_kit::Hsla {
    if dark {
        crate::appearance::card(cx)
    } else {
        crate::appearance::tray(cx)
    }
}
fn empty(muted: gpui_kit::Hsla, cx: &gpui_kit::App) -> impl IntoElement {
    div()
        .id("automations-empty")
        .test_support()
        .v_flex()
        .items_center()
        .gap_1()
        .w_full()
        .pt(px(56.))
        .child(
            div()
                .size(px(44.))
                .mb_2()
                .rounded(px(Radius::CARD))
                .bg(crate::appearance::tray(cx))
                .flex()
                .items_center()
                .justify_center()
                .child(IconRole::Automations.icon().size_5().text_color(muted)),
        )
        .child(ui::text(Text::Body, "Nothing scheduled").font_semibold())
        .child(
            ui::text(
                Text::Caption,
                "Scheduled messages and new chats appear here.",
            )
            .text_color(muted),
        )
}
