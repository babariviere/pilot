//! The Automations page: what Pilot will do on its own, across all projects.
//! Sections hide when empty: Needs attention, Recurring and One-time; Hooks join later.
//! Opening the page, Refresh and Local's schedule change signal issue the passive GET.
//! Writes are explicit: New automation and Edit (editor sheet), the pause switch,
//! Cancel, Dismiss and Delete. Each is sent once and never retried.
use crate::{
    LocalOptions,
    automation_editor::{Editor, EditorEvent},
    local_model::{Chat, Project},
    mcp_status::timestamp,
    recurring_schedules as words,
    scheduled_messages::{Item, RowAction, Section, State, Status, Target, clock_and_day},
    scheduled_messages_reader::{Outcome, Reader, Request, Write, perform},
    ui::{self, Action, IconRole, Notice, Radius, Text, Tone},
};
use gpui_kit::{
    AnyElement, AppContext, Context, Div, Entity, EventEmitter, FocusHandle, Hsla,
    InteractiveElement, IntoElement, ParentElement, Render, SharedString,
    StatefulInteractiveElement, Styled, Subscription, Task, TestSupportExt, Window,
    base::SelectableText,
    component::{
        ActiveTheme, Disableable, Sizable, StyledExt, WindowExt, scroll::ScrollableElement,
        switch::Switch,
    },
    div,
    prelude::FluentBuilder,
    px,
};
use std::{collections::HashMap, sync::Arc};

/// Rows drawn per section. The store retains at most 1000 records.
const ROW_CAP: usize = 200;
/// Runs listed in a rule's details, newest first. Local keeps ten.
const RUNS_SHOWN: usize = 5;
/// Page groups in order: section, element ID and label.
const GROUPS: [(Section, &str, &str); 3] = [
    (
        Section::Attention,
        "automations-attention",
        "Needs attention",
    ),
    (Section::Recurring, "automations-recurring", "Recurring"),
    (Section::OneTime, "automations-one-time", "One-time"),
];

struct Note {
    id: Option<String>,
    text: String,
    tone: Tone,
}
pub(crate) enum AutomationsEvent {
    OpenChat(String),
    /// The weekly Insights confirmation. Opening it is passive; it enables nothing.
    EnableInsights,
}

pub(crate) struct Automations {
    pub(crate) state: State,
    options: Option<LocalOptions>,
    reader: Option<Reader>,
    updates: Option<Task<()>>,
    focus: FocusHandle,
    /// The row showing its details, by section and record ID.
    expanded: Option<(Section, String)>,
    /// A write in flight, by record ID.
    pub(crate) pending: Option<String>,
    /// The rule whose Delete is waiting for its confirming second press.
    confirm_delete: Option<String>,
    action: Option<Task<()>>,
    note: Option<Note>,
    /// The page is showing. Action results only land while open.
    open: bool,
    session: u64,
    /// Local's schedule change signal last seen, so an open page rereads once per change.
    signal: u64,
    pub(crate) editor: Option<Entity<Editor>>,
    _editor: Option<Subscription>,
    chats: Arc<Vec<Chat>>,
    titles: HashMap<String, String>,
    projects: Arc<Vec<Project>>,
    /// Self-contained Hooks section with its own reads and writes.
    pub(crate) hooks: gpui_kit::Entity<crate::automation_hooks_view::Hooks>,
}
impl EventEmitter<AutomationsEvent> for Automations {}
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
            pending: None,
            confirm_delete: None,
            action: None,
            note: None,
            open: false,
            session: 0,
            signal: 0,
            editor: None,
            _editor: None,
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
    /// A new schedule change signal rereads the open page once.
    pub(crate) fn sync(
        &mut self,
        chats: &Arc<Vec<Chat>>,
        projects: &Arc<Vec<Project>>,
        signal: u64,
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
        if self.signal != signal {
            self.signal = signal;
            // A newer read replaces one in flight; a pending write rereads when it finishes.
            if self.open && self.pending.is_none() {
                self.load(cx);
            }
        }
    }
    /// Opens a rule's details, for the Inbox's notice rows.
    pub(crate) fn reveal(&mut self, id: String, cx: &mut Context<Self>) {
        self.expanded = Some((Section::Recurring, id));
        cx.notify();
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
        self.confirm_delete = None;
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
                let shown = |row: &Option<(Section, String)>| {
                    row.as_ref().is_some_and(|(section, id)| {
                        snapshot
                            .items
                            .iter()
                            .any(|s| &s.id == id && s.in_section(*section))
                    })
                };
                if !shown(&self.expanded) {
                    self.expanded = None;
                }
            }
            cx.notify();
        }
    }
    fn item(&self, id: &str) -> Option<&Item> {
        self.state
            .snapshot
            .as_ref()
            .and_then(|s| s.items.iter().find(|s| s.id == id))
    }
    pub(crate) fn run(&mut self, id: String, action: RowAction, cx: &mut Context<Self>) {
        let Some(options) = self.options.clone() else {
            return;
        };
        let Some(revision) = self.item(&id).map(|s| s.revision) else {
            return;
        };
        if !self.open || self.pending.is_some() {
            return;
        }
        self.note = None;
        self.pending = Some(id.clone());
        let session = self.session;
        let outcome = perform(
            options,
            Write::Row {
                id: id.clone(),
                revision,
                action,
            },
        );
        self.action = Some(cx.spawn(async move |view, cx| {
            let outcome = outcome.recv().await.unwrap_or(Outcome::Refused(
                "Pilot couldn’t start the request. Nothing was changed.".into(),
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
        self.confirm_delete = None;
        self.note = match outcome {
            Outcome::Done => Some(Note {
                id: None,
                text: match action {
                    RowAction::Cancel => "Cancelled. It won’t be sent.",
                    RowAction::Dismiss | RowAction::DismissNotice => "Dismissed.",
                    RowAction::Delete => "Deleted. It won’t run again.",
                    RowAction::Pause => "Paused. It won’t run until you resume it.",
                    RowAction::Resume => "Resumed. Times missed while paused won’t run.",
                }
                .into(),
                tone: Tone::Quiet,
            }),
            Outcome::Refused(text) | Outcome::Unconfirmed(text) => Some(Note {
                id: Some(id),
                text,
                tone: Tone::Warning,
            }),
        };
        // A passive re-read shows what happened. The request is never repeated.
        self.load(cx);
    }
    /// New automation (no source) or Edit of a recurring rule, as shown now.
    pub(crate) fn edit(&mut self, source: Option<String>, w: &mut Window, cx: &mut Context<Self>) {
        let Some(options) = self.options.clone() else {
            return;
        };
        if !self.open || self.pending.is_some() || w.has_active_dialog(cx) {
            return;
        }
        let source = match source {
            Some(id) => match self.item(&id).filter(|s| s.recurring()) {
                Some(item) => Some(item.clone()),
                None => return,
            },
            None => None,
        };
        let (chats, projects) = (self.chats.clone(), self.projects.clone());
        let now = crate::usage_overview::now();
        let editor = cx.new(|cx| Editor::new(options, source, chats, &projects, now, w, cx));
        self._editor = Some(cx.subscribe_in(&editor, w, |v, _, event, w, cx| {
            match event {
                EditorEvent::Close => {}
                EditorEvent::Saved => {
                    v.note = Some(Note {
                        id: None,
                        text: "Saved.".into(),
                        tone: Tone::Quiet,
                    });
                    v.load(cx);
                }
            }
            v.editor = None;
            w.close_dialog(cx);
            v.focus.focus(w, cx);
            cx.notify();
        }));
        self.editor = Some(editor.clone());
        Editor::open(editor, w, cx);
    }
    fn target(&self, item: &Item) -> String {
        match &item.target {
            Target::Message { session_id, .. } => self
                .titles
                .get(session_id)
                .cloned()
                .unwrap_or_else(|| "Unlisted chat".into()),
            Target::Chat { .. } => match self.project_name(item.new_chat_project()) {
                Some(project) => format!("New chat in {project}"),
                None => "New chat".into(),
            },
        }
    }
    fn project_name(&self, id: Option<&str>) -> Option<String> {
        let id = id?;
        self.projects
            .iter()
            .find(|p| p.id == id)
            .map(|p| p.name.clone())
    }
    fn toggle(&mut self, row: (Section, String), cx: &mut Context<Self>) {
        self.confirm_delete = None;
        self.expanded = if self.expanded.as_ref() == Some(&row) {
            None
        } else {
            Some(row)
        };
        cx.notify();
    }
    fn note_for(&self, id: &str) -> Option<&Note> {
        self.note.as_ref().filter(|n| n.id.as_deref() == Some(id))
    }

    fn details_toggle(
        &self,
        id: SharedString,
        line: &str,
        row: (Section, String),
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let expanded = self.expanded.as_ref() == Some(&row);
        ui::icon_action(
            id,
            SharedString::from(if expanded {
                format!("Hide {line}")
            } else {
                format!("Show {line}")
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
        .on_click(cx.listener(move |v, _, _, cx| v.toggle(row.clone(), cx)))
    }
    /// One grouped row: glyph tile, title over a muted line, a right-hand column, a fixed
    /// action slot and the details chevron, then its disclosure.
    fn shell(
        &self,
        row: Row,
        slot: Option<AnyElement>,
        more: Option<Div>,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let Row {
            prefix,
            key,
            section,
            glyph,
            tint,
            ink,
            title,
            line,
            clock,
            day,
            status,
            status_action,
            label,
            dim,
        } = row;
        let id = |part: &str| SharedString::from(format!("{prefix}-{part}-{key}"));
        let theme = cx.theme();
        let (muted, hover) = (theme.muted_foreground, theme.list_hover);
        let open = (section, key.clone());
        let expanded = self.expanded.as_ref() == Some(&open);
        // The clock leads; the day and any status sit quietly under it.
        let mut meta = div().v_flex().flex_none().items_end().gap(px(1.));
        if let Some(clock) = clock {
            meta = meta.child(
                ui::text(Text::Body, SharedString::from(clock))
                    .id(id("when"))
                    .test_support()
                    .whitespace_nowrap()
                    .font_medium()
                    .when(dim, |d| d.text_color(muted)),
            );
        }
        if day.is_some() || status.is_some() {
            let mut under = div().h_flex().gap_1().whitespace_nowrap();
            if let Some(day) = &day {
                under = under.child(
                    ui::text(Text::Caption, SharedString::from(day.clone()))
                        .id(id("day"))
                        .test_support()
                        .text_color(muted),
                );
            }
            if let Some((text, color)) = status {
                if day.is_some() {
                    under = under.child(ui::text(Text::Caption, "·").text_color(muted));
                }
                under = under.child(
                    ui::text(Text::Caption, SharedString::from(text))
                        .id(id("status"))
                        .test_support()
                        .font_medium()
                        .text_color(color),
                );
            }
            if let Some(action) = status_action {
                under = under.child(action);
            }
            meta = meta.child(under);
        }
        let main = {
            let open = open.clone();
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
                        .child(
                            ui::text(Text::Body, SharedString::from(title))
                                .truncate()
                                .when(dim, |d| d.text_color(muted)),
                        )
                        .child(
                            ui::text(Text::Caption, SharedString::from(line))
                                .id(id("meta"))
                                .test_support()
                                .truncate()
                                .text_color(muted),
                        ),
                )
                .child(meta)
                .on_click(cx.listener(move |v, _, _, cx| v.toggle(open.clone(), cx)))
        };
        // A fixed slot keeps times aligned whether or not a row has an action.
        let slot = div()
            .id(id("slot"))
            .test_support()
            .flex_none()
            .w(px(ACTION))
            .h_flex()
            .justify_end()
            .when_some(slot, |d, s| d.child(s));
        let head = div()
            .h_flex()
            .items_center()
            .w_full()
            .min_w_0()
            .gap_2()
            .px(px(INSET))
            .py(px(8.))
            .child(main)
            .child(slot)
            .child(self.details_toggle(id("details"), &label, open, cx));
        div()
            .id(id("row"))
            .test_support()
            .group(SharedString::from(format!("{prefix}-hover-{key}")))
            .v_flex()
            .w_full()
            .min_w_0()
            .rounded(px(Radius::ROW))
            .when(expanded, |d| d.bg(hover))
            .hover(move |s| s.bg(hover))
            .child(head)
            .when_some(more, |d, more| d.child(more))
    }
    /// The disclosure column under a row, with the row's note first.
    fn more(&self, id: &dyn Fn(&str) -> SharedString, item: &Item, cx: &mut Context<Self>) -> Div {
        let mut more = div()
            .v_flex()
            .min_w_0()
            .gap_2()
            .pl(px(INSET + TILE + 12.))
            .pr(px(INSET))
            .pb(px(12.))
            .text_size(px(Text::Caption.size()));
        if let Some(note) = self.note_for(&item.id) {
            more = more.child(
                ui::text(Text::Caption, SharedString::from(note.text.clone()))
                    .id(id("note"))
                    .test_support()
                    .text_color(note.tone.color(cx)),
            );
        }
        more
    }
    /// The exact message or prompt, selectable, in a bordered block.
    fn message(
        &self,
        id: &dyn Fn(&str) -> SharedString,
        item: &Item,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
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
            )
    }
    fn row_action(
        &self,
        id: SharedString,
        item: &Item,
        action: RowAction,
        line: &str,
        cx: &mut Context<Self>,
    ) -> gpui_kit::component::button::Button {
        let mine = self.pending.as_ref() == Some(&item.id);
        let target = item.id.clone();
        ui::action(id, action.label(), Action::Quiet)
            .small()
            .flex_none()
            .tooltip(match action {
                RowAction::Cancel => "Stops this message from being sent",
                RowAction::Dismiss => "Removes this failed message from the list",
                RowAction::DismissNotice => "Clears this notice. The rule keeps running",
                RowAction::Delete => "Stops this rule for good",
                RowAction::Pause | RowAction::Resume => "",
            })
            .accessibility_label(SharedString::from(format!("{}: {line}", action.label())))
            .disabled(self.pending.is_some() || !self.open)
            .loading(mine)
            .on_click(cx.listener(move |v, _, _, cx| v.run(target.clone(), action, cx)))
    }
    fn open_chat(
        &self,
        id: SharedString,
        chat: String,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let title = self.titles.get(&chat).cloned().unwrap_or_default();
        ui::action(
            id,
            SharedString::from(format!("Open {title}")),
            Action::Quiet,
        )
        .small()
        .self_start()
        .on_click(cx.listener(move |_, _, _, cx| cx.emit(AutomationsEvent::OpenChat(chat.clone()))))
    }
    /// One-time messages and failed one-time sends.
    fn row(
        &self,
        item: &Item,
        now: u64,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        // A one-time record is listed once: failed under Needs attention, else under One-time.
        let section = if item.in_section(Section::Attention) {
            Section::Attention
        } else {
            Section::OneTime
        };
        let key = item.id.clone();
        let id = |part: &str| SharedString::from(format!("automation-{part}-{key}"));
        let expanded = self.expanded.as_ref() == Some(&(section, item.id.clone()));
        let theme = cx.theme();
        let (muted, danger) = (theme.muted_foreground, theme.danger);
        let dark = theme.is_dark();
        let status = item.status(self.state.read_at.unwrap_or(now));
        let failed = status == Some(Status::Failed);
        let when = item.when(now);
        let target = self.target(item);
        let line_text = format!("{when} → {target}");
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
        let note = self.note_for(&item.id).is_some();
        let slot = item.action(section).map(|action| {
            let mine = self.pending.as_ref() == Some(&item.id);
            // Cancel waits on hover or keyboard focus; Dismiss is why the row is here.
            let quiet = action == RowAction::Cancel && !expanded && !mine && !note;
            let group = SharedString::from(format!("automation-hover-{key}"));
            self.row_action(id("action"), item, action, &line_text, cx)
                .when(quiet, |b| {
                    b.opacity(0.)
                        .group_hover(group, |s| s.opacity(1.))
                        .focus_visible(|s| s.opacity(1.))
                })
                .into_any_element()
        });
        let more = (expanded || note).then(|| {
            let mut more = self.more(&id, item, cx);
            if expanded {
                more = more.child(self.message(&id, item, window, cx));
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
            }
            more
        });
        let status = status.map(|status| {
            let tone = match status {
                Status::Failed => Tone::Error,
                Status::Overdue => Tone::Warning,
                Status::Sending => Tone::Quiet,
            };
            (status.label().to_owned(), tone.color(cx))
        });
        let (clock, day) = if item.at.is_some() {
            let (clock, day) = clock_and_day(&when);
            (Some(clock), Some(day))
        } else {
            (None, Some(when.clone()))
        };
        self.shell(
            Row {
                prefix: "automation",
                key: item.id.clone(),
                section,
                glyph,
                tint,
                ink,
                title: target,
                line: preview(item),
                clock,
                day,
                status,
                status_action: None,
                label: line_text,
                dim: false,
            },
            slot,
            more,
            cx,
        )
    }
    /// A recurring rule's skipped, missed or failed run, with Dismiss.
    fn notice_row(&self, item: &Item, now: u64, cx: &mut Context<Self>) -> AnyElement {
        let Some(run) = item.notice.as_ref() else {
            return div().into_any_element();
        };
        let key = item.id.clone();
        let id = |part: &str| SharedString::from(format!("automation-notice-{part}-{key}"));
        let row = (Section::Attention, item.id.clone());
        let expanded = self.expanded.as_ref() == Some(&row);
        let offset = crate::subscription_pause::local_offset;
        let failed = run.outcome == "failed";
        let message = matches!(item.target, Target::Message { .. });
        let reason = words::reason(run, message, now, offset);
        let tone = if failed { Tone::Error } else { Tone::Warning }.color(cx);
        let label = format!("{} · {reason}", item.title);
        let slot = item.action(Section::Attention).map(|a| {
            self.row_action(id("action"), item, a, &label, cx)
                .into_any_element()
        });
        let more = (expanded || self.note_for(&item.id).is_some()).then(|| {
            let mut more = self
                .more(&id, item, cx)
                .text_color(cx.theme().muted_foreground);
            if expanded {
                if let Some(error) = run.error.as_ref().filter(|_| failed) {
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
                more = more.child(ui::text(
                    Text::Caption,
                    SharedString::from(format!(
                        "Due {}. The rule keeps running; Dismiss only clears this notice.",
                        crate::message_time::detail(run.due)
                    )),
                ));
                if let Some(chat) = run
                    .session_id
                    .as_ref()
                    .filter(|c| self.titles.contains_key(*c))
                {
                    more = more.child(self.open_chat(id("open"), chat.clone(), cx));
                }
            }
            more
        });
        let outcome = match run.outcome.as_str() {
            "skipped_running" => "Skipped",
            "missed" => "Missed",
            _ => "Failed",
        };
        let (clock, day) = clock_and_day(&words::past(run.at.max(run.due), now, offset));
        self.shell(
            Row {
                prefix: "automation-notice",
                key: item.id.clone(),
                section: Section::Attention,
                glyph: if failed {
                    IconRole::Error
                } else {
                    IconRole::Automations
                },
                tint: tone.opacity(0.12),
                ink: tone,
                title: item.title.clone(),
                line: reason,
                clock: Some(clock),
                day: Some(day),
                status: Some((outcome.into(), tone)),
                status_action: None,
                label,
                dim: false,
            },
            slot,
            more,
            cx,
        )
        .into_any_element()
    }
    /// One recurring rule: name over its schedule, project and action; next run over the
    /// last result; a pause switch.
    fn rule_row(
        &self,
        item: &Item,
        now: u64,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let key = item.id.clone();
        let id = |part: &str| SharedString::from(format!("automation-rule-{part}-{key}"));
        let row = (Section::Recurring, item.id.clone());
        let expanded = self.expanded.as_ref() == Some(&row);
        let muted = cx.theme().muted_foreground;
        let dark = cx.theme().is_dark();
        let offset = crate::subscription_pause::local_offset;
        let schedule = item
            .recurrence
            .as_ref()
            .map_or_else(String::new, |r| words::schedule(r, words::local_zone()));
        // The next run as a clock over its day; paused and running rules say so instead.
        let (clock, day) = if item.paused {
            (None, "Paused".to_owned())
        } else if item.state == "dispatching" {
            (None, "Running now".to_owned())
        } else {
            match item.at {
                Some(at) => {
                    let (clock, day) =
                        clock_and_day(&crate::scheduled_messages::words(at, now, offset));
                    (Some(clock), day)
                }
                None => (None, "No next run".to_owned()),
            }
        };
        let project = self
            .project_name(item.project_id.as_deref())
            .unwrap_or_else(|| "Project unavailable".into());
        let action = words::action(item, |chat| self.titles.get(chat).cloned());
        let line = format!("{schedule} · {project} · {action}");
        let label = format!("{} · {line}", item.title);
        let view = cx.entity().downgrade();
        let target = item.id.clone();
        let pending = self.pending.as_ref() == Some(&item.id);
        let switch = Switch::new(id("switch"))
            .checked(!item.paused)
            .small()
            .disabled(self.pending.is_some() || !self.open || item.state != "pending")
            .accessibility_label(SharedString::from(format!(
                "{} {}",
                if item.paused { "Resume" } else { "Pause" },
                item.title
            )))
            .tooltip(if pending {
                "Saving…"
            } else if item.paused {
                "Paused. Turn on to resume; missed times won’t run"
            } else {
                "On. Turn off to pause"
            })
            .on_click(move |on, _, cx| {
                let action = if *on {
                    RowAction::Resume
                } else {
                    RowAction::Pause
                };
                let _ = view.update(cx, |v, cx| v.run(target.clone(), action, cx));
            });
        let more = (expanded || self.note_for(&item.id).is_some()).then(|| {
            let mut more = self.more(&id, item, cx);
            if !expanded {
                return more;
            }
            let lead = match &item.target {
                Target::Chat { .. } => format!("Starts a new chat in {project} with:"),
                Target::Message { session_id, .. } => format!(
                    "Sends to {}:",
                    self.titles
                        .get(session_id)
                        .map_or("an unlisted chat", String::as_str)
                ),
            };
            more = more
                .child(ui::text(Text::Caption, SharedString::from(lead)).text_color(muted))
                .child(self.message(&id, item, window, cx));
            if let Some(run) = item
                .notice
                .as_ref()
                .filter(|n| n.late && !n.needs_attention())
            {
                more = more.child(
                    div()
                        .h_flex()
                        .items_center()
                        .gap_2()
                        .child(
                            ui::text(
                                Text::Caption,
                                SharedString::from(words::reason(run, false, now, offset)),
                            )
                            .text_color(muted),
                        )
                        .child(self.row_action(
                            id("dismiss"),
                            item,
                            RowAction::DismissNotice,
                            &label,
                            cx,
                        )),
                );
            }
            if !item.runs.is_empty() {
                let mut runs = div()
                    .id(id("runs"))
                    .test_support()
                    .v_flex()
                    .gap_0p5()
                    .child(
                        ui::text(Text::Caption, "Recent runs")
                            .font_medium()
                            .text_color(muted),
                    );
                for (ix, run) in item.runs.iter().rev().take(RUNS_SHOWN).enumerate() {
                    let mut line =
                        div()
                            .h_flex()
                            .items_center()
                            .gap_2()
                            .min_h(px(24.))
                            .child(ui::text(
                                Text::Caption,
                                SharedString::from(words::last_result(run, now, offset)),
                            ));
                    if let Some(chat) = run
                        .session_id
                        .as_ref()
                        .filter(|c| self.titles.contains_key(*c))
                    {
                        line =
                            line.child(self.open_chat(id(&format!("run-{ix}")), chat.clone(), cx));
                    }
                    runs = runs.child(line);
                }
                more = more.child(runs);
            }
            let edit = item.id.clone();
            let confirming = self.confirm_delete.as_ref() == Some(&item.id);
            let mut actions = div().h_flex().items_center().gap_2().child(
                ui::action(id("edit"), "Edit", Action::Secondary)
                    .small()
                    .disabled(self.pending.is_some() || !self.open || item.state != "pending")
                    .on_click(cx.listener(move |v, _, w, cx| v.edit(Some(edit.clone()), w, cx))),
            );
            if confirming {
                // Keep takes the slot Delete… had, so a double press keeps the rule. Nothing is
                // sent until Delete rule.
                let keep = item.id.clone();
                let target = item.id.clone();
                actions = actions
                    .child(
                        ui::action(id("keep"), "Keep", Action::Quiet)
                            .small()
                            .on_click(cx.listener(move |v, _, _, cx| {
                                if v.confirm_delete.as_ref() == Some(&keep) {
                                    v.confirm_delete = None;
                                    cx.notify();
                                }
                            })),
                    )
                    .child(
                        ui::action(id("delete-rule"), "Delete rule", Action::Danger)
                            .small()
                            .accessibility_label(SharedString::from(format!(
                                "Delete rule: {label}"
                            )))
                            .disabled(self.pending.is_some() || !self.open)
                            .loading(self.pending.as_ref() == Some(&item.id))
                            .on_click(cx.listener(move |v, _, _, cx| {
                                v.run(target.clone(), RowAction::Delete, cx)
                            })),
                    );
                more = more.child(
                    ui::text(
                        Text::Caption,
                        "Delete stops this rule for good. Chats it already started stay.",
                    )
                    .id(id("delete-confirm"))
                    .test_support()
                    .text_color(muted),
                );
            } else {
                let ask = item.id.clone();
                actions = actions.child(
                    ui::action(id("delete"), "Delete…", Action::Quiet)
                        .small()
                        .tooltip("Asks before deleting this rule")
                        .accessibility_label(SharedString::from(format!("Delete…: {label}")))
                        .disabled(self.pending.is_some() || !self.open)
                        .on_click(cx.listener(move |v, _, _, cx| {
                            v.confirm_delete = Some(ask.clone());
                            cx.notify();
                        })),
                );
            }
            more.child(actions)
        });
        // A late success can be cleared from the list too, beside its hint.
        let late = item
            .notice
            .as_ref()
            .is_some_and(|n| n.late && !n.needs_attention());
        let status_action = late.then(|| {
            let target = item.id.clone();
            ui::icon_action(
                id("dismiss-late"),
                SharedString::from(format!("Dismiss: {label}")),
                IconRole::Close,
                Action::Quiet,
            )
            .xsmall()
            .tooltip("Clears this notice. The rule keeps running")
            .disabled(self.pending.is_some() || !self.open)
            .loading(self.pending.as_ref() == Some(&item.id))
            .on_click(cx.listener(move |v, _, _, cx| {
                // The row text toggles details; this press only dismisses.
                cx.stop_propagation();
                v.run(target.clone(), RowAction::DismissNotice, cx);
            }))
            .into_any_element()
        });
        self.shell(
            Row {
                prefix: "automation-rule",
                key: item.id.clone(),
                section: Section::Recurring,
                glyph: IconRole::Automations,
                tint: tile(dark, cx),
                ink: muted,
                title: item.title.clone(),
                line,
                clock,
                day: Some(day),
                // A late success isn't a problem; the row only hints at it, details explain.
                status: item
                    .notice
                    .as_ref()
                    .filter(|n| n.late && !n.needs_attention())
                    .map(|_| ("Ran late".to_owned(), muted)),
                status_action,
                label,
                dim: item.paused,
            },
            Some(
                div()
                    .id(id("switch-slot"))
                    .test_support()
                    .child(switch)
                    .into_any_element(),
            ),
            more,
            cx,
        )
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
        // A recurring rule can be listed twice, so its row kind follows the group.
        let section = GROUPS
            .iter()
            .find(|(_, group, _)| *group == id)
            .map_or(Section::OneTime, |(section, ..)| *section);
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
            list = match (section, item.recurring()) {
                (Section::Recurring, _) => {
                    list.child(self.rule_row(item, now, window, cx).into_any_element())
                }
                (Section::Attention, true) => list.child(self.notice_row(item, now, cx)),
                _ => list.child(self.row(item, now, window, cx).into_any_element()),
            };
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
/// What a grouped row shows; see `Automations::shell`.
struct Row {
    prefix: &'static str,
    key: String,
    section: Section,
    glyph: IconRole,
    tint: Hsla,
    ink: Hsla,
    title: String,
    line: String,
    /// The clock ("09:00") in medium weight, over the day and status.
    clock: Option<String>,
    day: Option<String>,
    status: Option<(String, Hsla)>,
    /// A small control after the status, such as clearing a late-run hint.
    status_action: Option<AnyElement>,
    /// The row's accessible summary, for its controls.
    label: String,
    dim: bool,
}
fn preview(item: &Item) -> String {
    item.message()
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("No message")
        .to_owned()
}
impl Render for Automations {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let muted = cx.theme().muted_foreground;
        let now = crate::usage_overview::now();
        let (attention, recurring, one_time) = self.state.snapshot.as_ref().map_or_else(
            || (Vec::new(), Vec::new(), Vec::new()),
            |s| {
                (
                    s.section(Section::Attention),
                    s.section(Section::Recurring),
                    s.section(Section::OneTime),
                )
            },
        );
        let mut parts = Vec::new();
        if !recurring.is_empty() {
            parts.push(format!("{} recurring", recurring.len()));
        }
        if !one_time.is_empty() {
            parts.push(format!("{} scheduled", one_time.len()));
        }
        if !attention.is_empty() {
            let a = attention.len();
            parts.push(format!(
                "{a} {} attention",
                if a == 1 { "needs" } else { "need" }
            ));
        }
        let meta = match parts.len() {
            0 => "Across all projects".to_owned(),
            1 if attention.is_empty() => format!("{} across all projects", parts[0]),
            _ => parts.join(" · "),
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
                div()
                    .h_flex()
                    .flex_none()
                    .items_center()
                    .gap_1()
                    .child(
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
                    )
                    .child(
                        ui::action(
                            "automations-insights",
                            "Weekly Insights…",
                            Action::Secondary,
                        )
                        .small()
                        .accessibility_label("Enable weekly Insights")
                        .tooltip("Enable weekly Insights or see its status")
                        .disabled(self.options.is_none())
                        .on_click(
                            cx.listener(|_, _, _, cx| cx.emit(AutomationsEvent::EnableInsights)),
                        ),
                    )
                    .child(
                        ui::action("automations-new", "New automation", Action::Primary)
                            .small()
                            .tooltip("A repeating chat or message, or a one-time message")
                            .disabled(self.options.is_none() || self.pending.is_some())
                            .on_click(cx.listener(|v, _, w, cx| v.edit(None, w, cx))),
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
            page = page.child(notice("automations-note", note.text.clone(), note.tone));
        }
        if self.state.snapshot.is_some() {
            if self.state.error.is_some() {
                page = page.child(notice(
                    "automations-stale",
                    "Showing the last report from Local.",
                    Tone::Quiet,
                ));
            }
            for ((_, id, label), rows) in
                GROUPS.into_iter().zip([&attention, &recurring, &one_time])
            {
                if !rows.is_empty() {
                    page = page.child(self.group(id, label, rows, now, window, cx));
                }
            }
            // Sent and cancelled records are history, not shown here.
            if attention.is_empty() && recurring.is_empty() && one_time.is_empty() {
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
/// Wide enough for Cancel or Dismiss at the small control size, or the pause switch.
const ACTION: f32 = 64.;
/// The grouped list: white on the light page, a lifted tray on the dark one.
fn container(dark: bool, cx: &gpui_kit::App) -> Hsla {
    if dark {
        crate::appearance::tray(cx)
    } else {
        crate::appearance::card(cx)
    }
}
/// The glyph tile contrasts with the group it sits in.
fn tile(dark: bool, cx: &gpui_kit::App) -> Hsla {
    if dark {
        crate::appearance::card(cx)
    } else {
        crate::appearance::tray(cx)
    }
}
fn empty(muted: Hsla, cx: &gpui_kit::App) -> impl IntoElement {
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
                "Repeating chats and scheduled messages appear here.",
            )
            .text_color(muted),
        )
}
