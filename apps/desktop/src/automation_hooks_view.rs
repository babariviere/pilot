//! The Automations page's Hooks section (D41): each project's hooks with their on/off state,
//! when they run and their last result, plus a dialog to add, edit or delete one.
//! Opening the page and Refresh read passively; the switch, Save and Delete are the only writes,
//! each one PUT at the revision shown. Results are never retried; Local's next read is the truth.
use crate::{
    LocalOptions,
    app_icon::AppIcon,
    automation_hooks::{self as model, Draft, Hook, Kind, ProjectHooks},
    automation_hooks_transport::{self as wire, Job, Reply, Saved, Snapshot},
    local_model::{Chat, Project},
    state_mark::{self, Glyph, Mark},
    ui::{self, Action, IconRole, Notice, Space, Text, Tone},
};
use gpui_kit::{
    App, AppContext, Context, Entity, EntityInputHandler, FocusHandle, Focusable,
    InteractiveElement, IntoElement, ParentElement, Render, SharedString,
    StatefulInteractiveElement, Styled, Subscription, Task, TestSupportExt, WeakEntity, Window,
    base::SelectableText,
    component::{
        ActiveTheme, Disableable, Sizable, StyledExt, WindowExt,
        button::{Button, ButtonVariants},
        checkbox::Checkbox,
        input::{Textarea, TextareaState},
        menu::{DropdownMenu, PopupMenuItem},
        switch::Switch,
    },
    div,
    prelude::FluentBuilder,
    px,
};
use serde_json::Value;
use std::sync::Arc;

/// A row: project ID and hook ID.
type Key = (String, String);

/// Where a save came from, so its result lands beside it.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Origin {
    Row(Key),
    Editor,
}
struct Note {
    /// The row it belongs to; None for the section.
    at: Option<Key>,
    text: SharedString,
    tone: Tone,
}

pub(crate) struct Hooks {
    options: Option<LocalOptions>,
    pub(crate) snapshot: Option<Snapshot>,
    pub(crate) error: Option<&'static str>,
    pub(crate) busy: bool,
    generation: u64,
    /// The page is showing. Results land only while open.
    open: bool,
    session: u64,
    read: Option<Task<()>>,
    /// The project whose save is in flight. One save at a time.
    pub(crate) pending: Option<String>,
    save: Option<Task<()>>,
    note: Option<Note>,
    expanded: Option<Key>,
    technical: Option<Key>,
    chats: Arc<Vec<Chat>>,
    projects: Arc<Vec<Project>>,
    pub(crate) editor: Option<Entity<Editor>>,
}
impl Hooks {
    pub(crate) fn new(_: &mut Context<Self>) -> Self {
        Self {
            options: None,
            snapshot: None,
            error: None,
            busy: false,
            generation: 0,
            open: false,
            session: 0,
            read: None,
            pending: None,
            save: None,
            note: None,
            expanded: None,
            technical: None,
            chats: Arc::new(Vec::new()),
            projects: Arc::new(Vec::new()),
            editor: None,
        }
    }
    pub(crate) fn connect(&mut self, options: LocalOptions) {
        self.options = Some(options);
    }
    /// A save in flight, or editor fields that differ from what it opened with, hold an app
    /// update. A save whose answer was lost holds nothing: it is never resent.
    pub(crate) fn update_hold(&self, cx: &App) -> Option<crate::update_hold::Hold> {
        let unsaved = self.editor.as_ref().is_some_and(|e| e.read(cx).changed(cx));
        crate::update_hold::Hold::of(self.pending.is_some(), unsaved)
    }
    pub(crate) fn sync(
        &mut self,
        chats: &Arc<Vec<Chat>>,
        projects: &Arc<Vec<Project>>,
        cx: &mut Context<Self>,
    ) {
        if !Arc::ptr_eq(&self.chats, chats) || !Arc::ptr_eq(&self.projects, projects) {
            self.chats = chats.clone();
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
        self.generation += 1;
        self.read = None;
        self.busy = false;
        // A dispatched save still reaches Local; its answer is simply not shown.
        self.save = None;
        self.pending = None;
        self.note = None;
        cx.notify();
    }
    /// The passive read: on opening the page and Refresh.
    pub(crate) fn load(&mut self, cx: &mut Context<Self>) {
        self.open = true;
        self.generation += 1;
        let generation = self.generation;
        let Some(options) = self.options.clone() else {
            return;
        };
        let job = Job::Read;
        let lost = job.lost();
        match wire::start(options, job) {
            Err(Reply::Read(result)) => self.accept(generation, result, cx),
            Err(_) => {}
            Ok(rx) => {
                self.busy = true;
                self.read = Some(cx.spawn(async move |v, cx| {
                    let reply = rx.recv().await.unwrap_or(lost);
                    let _ = v.update(cx, |v, cx| {
                        if let Reply::Read(result) = reply {
                            v.accept(generation, result, cx);
                        }
                    });
                }));
            }
        }
        cx.notify();
    }
    fn accept(
        &mut self,
        generation: u64,
        result: Result<Snapshot, &'static str>,
        cx: &mut Context<Self>,
    ) {
        if generation != self.generation {
            return;
        }
        self.busy = false;
        self.read = None;
        match result {
            Ok(snapshot) => {
                self.error = None;
                self.snapshot = Some(snapshot);
                let shown =
                    |v: &Self, key: &Option<Key>| key.as_ref().is_some_and(|k| v.hook(k).is_some());
                if !shown(self, &self.expanded) {
                    self.expanded = None;
                }
                if !shown(self, &self.technical) {
                    self.technical = None;
                }
            }
            // The last report stays, marked stale by the error.
            Err(error) => self.error = Some(error),
        }
        cx.notify();
    }
    fn project(&self, id: &str) -> ProjectHooks {
        self.snapshot
            .as_ref()
            .and_then(|s| s.projects.iter().find(|p| p.project_id == id))
            .cloned()
            .unwrap_or_else(|| ProjectHooks::empty(id))
    }
    fn hook(&self, (project, id): &Key) -> Option<&Hook> {
        self.snapshot
            .as_ref()?
            .projects
            .iter()
            .find(|p| &p.project_id == project)?
            .items
            .iter()
            .find(|h| &h.id == id)
    }
    /// Writes need a current read, an idle section and a host that hasn't switched hooks off.
    fn writable(&self) -> bool {
        self.open
            && self.pending.is_none()
            && self.options.is_some()
            && self
                .snapshot
                .as_ref()
                .is_some_and(|s| s.enabled != Some(false))
    }
    fn project_name(&self, id: &str) -> String {
        self.projects
            .iter()
            .find(|p| p.id == id)
            .map(|p| p.name.clone())
            .unwrap_or_else(|| "A project not listed here".into())
    }
    pub(crate) fn toggle(
        &mut self,
        key: Key,
        enabled: bool,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.writable() {
            return;
        }
        let base = self.project(&key.0);
        if let Some(items) = model::toggled(&base, &key.1, enabled) {
            self.save(key.0.clone(), base.revision, items, Origin::Row(key), w, cx);
        }
    }
    /// Opens the editor for a new hook in `project`, or for an existing one.
    pub(crate) fn edit(
        &mut self,
        project: String,
        hook: Option<String>,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.writable() || self.editor.is_some() {
            return;
        }
        let existing = hook
            .as_ref()
            .and_then(|id| self.hook(&(project.clone(), id.clone())).cloned());
        if hook.is_some() && existing.as_ref().is_none_or(|h| h.kind.is_none()) {
            return;
        }
        let draft = existing.as_ref().map(Draft::of).unwrap_or_default();
        let owner = cx.weak_entity();
        let name = self.project_name(&project);
        let editor = cx.new(|cx| Editor::new(owner, project, name, hook, draft, w, cx));
        self.editor = Some(editor.clone());
        Editor::open(editor, w, cx);
        cx.notify();
    }
    fn submit(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        let Some(editor) = self.editor.clone() else {
            return;
        };
        if !self.writable() {
            return;
        }
        let (project, editing, draft) = {
            let e = editor.read(cx);
            (e.project_id.clone(), e.editing.clone(), e.draft(cx))
        };
        let base = self.project(&project);
        match model::build(&base, editing.as_deref(), &draft) {
            Err(error) => editor.update(cx, |e, cx| e.show(error.into(), Tone::Error, cx)),
            Ok(items) => self.save(project, base.revision, items, Origin::Editor, w, cx),
        }
    }
    fn delete(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        let Some(editor) = self.editor.clone() else {
            return;
        };
        if !self.writable() {
            return;
        }
        let (project, editing) = {
            let e = editor.read(cx);
            (e.project_id.clone(), e.editing.clone())
        };
        let base = self.project(&project);
        if let Some(items) = editing.and_then(|id| model::removed(&base, &id)) {
            self.save(project, base.revision, items, Origin::Editor, w, cx);
        }
    }
    fn dismiss_editor(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if let Some(editor) = self.editor.clone() {
            if editor.update(cx, |e, cx| e.marked(w, cx)) {
                return;
            }
            self.editor = None;
            w.close_dialog(cx);
            cx.notify();
        }
    }
    fn save(
        &mut self,
        project_id: String,
        expected_revision: u64,
        items: Vec<Value>,
        origin: Origin,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(options) = self.options.clone() else {
            return;
        };
        let job = Job::Save {
            project_id: project_id.clone(),
            expected_revision,
            items,
        };
        let lost = job.lost();
        self.note = None;
        if let Some(editor) = &self.editor {
            editor.update(cx, |e, cx| e.clear(cx));
        }
        let session = self.session;
        match wire::start(options, job) {
            Err(Reply::Save(saved)) => self.finish(session, &project_id, origin, saved, w, cx),
            Err(_) => {}
            Ok(rx) => {
                self.pending = Some(project_id.clone());
                if let Some(editor) = &self.editor {
                    editor.update(cx, |_, cx| cx.notify());
                }
                self.save = Some(cx.spawn_in(w, async move |v, cx| {
                    let reply = rx.recv().await.unwrap_or(lost);
                    let _ = v.update_in(cx, |v, w, cx| {
                        if let Reply::Save(saved) = reply {
                            v.finish(session, &project_id, origin, saved, w, cx);
                        }
                    });
                }));
            }
        }
        cx.notify();
    }
    fn finish(
        &mut self,
        session: u64,
        project_id: &str,
        origin: Origin,
        saved: Saved,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if session != self.session {
            return;
        }
        self.pending = None;
        self.save = None;
        let replace = |v: &mut Self, hooks: ProjectHooks| {
            if let Some(s) = v.snapshot.as_mut() {
                match s.projects.iter_mut().find(|p| p.project_id == project_id) {
                    Some(p) => *p = hooks,
                    None => s.projects.push(hooks),
                }
            }
        };
        let (text, tone, reread): (SharedString, Tone, bool) = match saved {
            Saved::Ack(hooks) => {
                replace(self, hooks);
                if origin == Origin::Editor {
                    self.editor = None;
                    w.close_dialog(cx);
                }
                ("Saved.".into(), Tone::Quiet, false)
            }
            Saved::Conflict(current) => {
                let known = current.is_some();
                if let Some(current) = current {
                    replace(self, current);
                }
                (
                    "These hooks changed elsewhere. Review the latest version and try again.".into(),
                    Tone::Warning,
                    !known,
                )
            }
            Saved::Rejected(error) => (error.into(), Tone::Error, false),
            Saved::Refused(error) => (error.into(), Tone::Warning, false),
            Saved::Unknown => (
                "Pilot couldn't confirm this change. Showing what Local reports now; nothing was retried.".into(),
                Tone::Warning,
                true,
            ),
        };
        match (&origin, &self.editor) {
            (Origin::Editor, Some(editor)) => editor.update(cx, |e, cx| e.show(text, tone, cx)),
            (Origin::Row(key), _) => {
                self.note = (tone != Tone::Quiet).then(|| Note {
                    at: Some(key.clone()),
                    text,
                    tone,
                })
            }
            (Origin::Editor, None) => {
                self.note = Some(Note {
                    at: None,
                    text,
                    tone,
                });
            }
        }
        if reread {
            self.load(cx);
        }
        cx.notify();
    }
    fn row(
        &self,
        project: &str,
        hook: &Hook,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement + use<> {
        let key: Key = (project.to_owned(), hook.id.clone());
        let tag = format!("{}-{}", project, hook.id);
        let id = |part: &str| SharedString::from(format!("hook-{part}-{tag}"));
        let expanded = self.expanded.as_ref() == Some(&key);
        let muted = cx.theme().muted_foreground;
        let last = model::last_run(&self.chats, project, &hook.id);
        let status = last.map(|(run, _)| model::status(run));
        let failed = matches!(status, Some((_, model::Tone::Error)));
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
        let when = hook.when();
        let label = format!("{} · {when}", hook.name);
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
                    .when(failed, |d| {
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
                    .h_flex()
                    .gap_1()
                    .cursor_pointer()
                    .on_click(cx.listener(move |v, _, _, cx| toggle(v, cx)))
                    .child(
                        ui::text(Text::Body, SharedString::from(hook.name.clone()))
                            .flex_shrink(1.)
                            .min_w_0()
                            .truncate()
                            .when(!hook.enabled, |d| d.text_color(muted)),
                    )
                    .child(
                        ui::text(Text::Body, SharedString::from(format!("· {when}")))
                            .flex_shrink(1.)
                            .min_w(px(48.))
                            .truncate()
                            .text_color(muted),
                    )
            });
        if let Some((text, tone)) = &status {
            let color = match tone {
                model::Tone::Quiet => muted,
                model::Tone::Warning => Tone::Warning.color(cx),
                model::Tone::Error => Tone::Error.color(cx),
            };
            line = line.child(
                ui::text(Text::Caption, SharedString::from(text.clone()))
                    .id(id("status"))
                    .test_support()
                    .flex_none()
                    .max_w(px(200.))
                    .truncate()
                    .text_color(color),
            );
        }
        let switch_key = key.clone();
        let editable = self.writable();
        line = line
            .child(
                div().id(id("switch")).test_support().flex_none().child(
                    Switch::new(id("switch-control"))
                        .small()
                        .checked(hook.enabled)
                        .disabled(!editable)
                        .accessibility_label(SharedString::from(format!(
                            "{}: {}",
                            hook.name,
                            if hook.enabled { "on" } else { "off" }
                        )))
                        .tooltip(if hook.enabled { "Turn off" } else { "Turn on" })
                        .on_click(cx.listener(move |v, checked: &bool, w, cx| {
                            v.toggle(switch_key.clone(), *checked, w, cx)
                        })),
                ),
            )
            .child(
                ui::icon_action(
                    id("details"),
                    SharedString::from(if expanded {
                        format!("Hide {label}")
                    } else {
                        format!("Show {label}")
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
        let note = self.note.as_ref().filter(|n| n.at.as_ref() == Some(&key));
        let extra = expanded || note.is_some();
        let mut more = div()
            .v_flex()
            .min_w_0()
            .gap_1()
            .pl(px(state_mark::SLOT + Space::CONTROL))
            .text_size(px(Text::Caption.size()));
        if let Some(note) = note {
            more = more.child(
                ui::text(Text::Caption, note.text.clone())
                    .id(id("note"))
                    .test_support()
                    .text_color(note.tone.color(cx)),
            );
        }
        if expanded {
            if let Some(command) = hook.command() {
                more = more.child(
                    div()
                        .id(id("command"))
                        .test_support()
                        .w_full()
                        .min_w_0()
                        .font_family(cx.theme().mono_font_family.clone())
                        .text_size(px(Text::Caption.size()))
                        .child(SelectableText::new(
                            id("command-text"),
                            SharedString::from(command),
                        )),
                );
            }
            let mut facts = Vec::new();
            match hook.kind {
                Some(Kind::Setup) => facts
                    .push("Runs in new and restored workspaces before the first turn.".to_owned()),
                Some(Kind::Check) if hook.sends_failures() => {
                    facts.push("Failures go back to the agent, up to 3 times.".to_owned())
                }
                Some(Kind::Check) => {
                    facts.push("Failures are reported, not sent to the agent.".to_owned())
                }
                Some(Kind::Continue) => {
                    facts.push("Asks the agent to continue, up to 3 times.".to_owned());
                    if let Some(message) = hook.message() {
                        facts.push(format!("Adds: {message}"));
                    }
                }
                None => facts.push("Pilot can't edit this hook's settings here.".to_owned()),
            }
            if let Some((run, chat)) = last {
                facts.push(format!(
                    "Last ran {} in {}",
                    crate::message_time::label(run.at),
                    chat.title
                ));
            }
            for (i, fact) in facts.into_iter().enumerate() {
                more = more.child(
                    ui::text(Text::Caption, SharedString::from(fact))
                        .id(SharedString::from(format!("hook-fact-{i}-{tag}")))
                        .text_color(muted),
                );
            }
            let technical = self.technical.as_ref() == Some(&key);
            let (edit_key, tech_key) = (key.clone(), key.clone());
            more = more.child(
                div()
                    .h_flex()
                    .gap_1()
                    .when(hook.kind.is_some(), |d| {
                        d.child(
                            ui::action(id("edit"), "Edit", Action::Quiet)
                                .small()
                                .disabled(!editable || self.editor.is_some())
                                .accessibility_label(SharedString::from(format!(
                                    "Edit {}",
                                    hook.name
                                )))
                                .on_click(cx.listener(move |v, _, w, cx| {
                                    v.edit(edit_key.0.clone(), Some(edit_key.1.clone()), w, cx)
                                })),
                        )
                    })
                    .child(
                        ui::action(id("technical"), "Details", Action::Quiet)
                            .small()
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
                                v.technical = if v.technical.as_ref() == Some(&tech_key) {
                                    None
                                } else {
                                    Some(tech_key.clone())
                                };
                                cx.notify();
                            })),
                    ),
            );
            if technical {
                let revision = self.project(project).revision;
                let raw = serde_json::to_string_pretty(&hook.raw).unwrap_or_default();
                more = more.child(
                    div()
                        .id(id("technical-text"))
                        .test_support()
                        .w_full()
                        .min_w_0()
                        .text_color(muted)
                        .font_family(cx.theme().mono_font_family.clone())
                        .child(SelectableText::new(
                            id("technical-content"),
                            SharedString::from(format!(
                                "ID: {}\nProject: {project}\nRevision: {revision}\n{raw}",
                                hook.id
                            )),
                        )),
                );
            }
        }
        let _ = window;
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
    /// The section, or nothing: hidden when no project has hooks and none can be added.
    pub(crate) fn section(
        &self,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> Option<gpui_kit::AnyElement> {
        let snapshot = self.snapshot.as_ref()?;
        let total: usize = snapshot.projects.iter().map(|p| p.items.len()).sum();
        let invalid = snapshot.projects.iter().any(|p| p.error.is_some());
        let off = snapshot.enabled == Some(false);
        if total == 0 && !invalid && (off || snapshot.enabled.is_none()) {
            return None;
        }
        let muted = cx.theme().muted_foreground;
        let editable = self.writable() && self.editor.is_none();
        let projects = self.projects.clone();
        let owner = cx.weak_entity();
        let new = Button::new("hooks-new")
            .ghost()
            .small()
            .label("New hook")
            .disabled(!editable || projects.is_empty())
            .accessibility_label("New hook: choose a project")
            .dropdown_menu(move |mut menu, _, _| {
                for project in projects.iter() {
                    let (owner, id) = (owner.clone(), project.id.clone());
                    menu = menu.item(
                        PopupMenuItem::new(SharedString::from(project.name.clone())).on_click(
                            move |_, w, cx| {
                                let _ = owner.update(cx, |v, cx| v.edit(id.clone(), None, w, cx));
                            },
                        ),
                    );
                }
                menu
            });
        let mut group = div()
            .id("automations-hooks")
            .test_support()
            .v_flex()
            .w_full()
            .min_w_0()
            .child(
                div()
                    .h_flex()
                    .items_center()
                    .justify_between()
                    .gap_2()
                    .pb_1()
                    .child(
                        ui::text(
                            Text::Caption,
                            SharedString::from(if total == 0 {
                                "Hooks".to_owned()
                            } else {
                                format!("Hooks · {total}")
                            }),
                        )
                        .id("hooks-title")
                        .font_semibold()
                        .text_color(muted),
                    )
                    .when(!off, |d| d.child(new)),
            );
        if off {
            group = group.child(notice(
                "hooks-off",
                "Automations are off, so these hooks don't run. Turn them on in Settings → Chats.",
                Tone::Quiet,
            ));
        }
        if let Some(note) = self.note.as_ref().filter(|n| n.at.is_none()) {
            group = group.child(notice("hooks-note", note.text.clone(), note.tone));
        }
        if total == 0 && !invalid {
            group = group.child(
                ui::text(Text::Caption, "No hooks yet. Hooks run setup commands in new workspaces, or checks after a run.")
                    .id("hooks-empty")
                    .test_support()
                    .text_color(muted),
            );
        }
        let mut shown: Vec<&ProjectHooks> = snapshot
            .projects
            .iter()
            .filter(|p| !p.items.is_empty() || p.error.is_some())
            .collect();
        shown.sort_by_cached_key(|p| {
            (
                self.project_name(&p.project_id).to_lowercase(),
                p.project_id.clone(),
            )
        });
        for project in shown {
            group = group.child(
                ui::text(
                    Text::Label,
                    SharedString::from(self.project_name(&project.project_id)),
                )
                .id(SharedString::from(format!(
                    "hooks-project-{}",
                    project.project_id
                )))
                .test_support()
                .pt_2()
                .truncate()
                .text_color(muted),
            );
            if let Some(error) = &project.error {
                group = group.child(
                    div()
                        .id(SharedString::from(format!("hooks-invalid-{}", project.project_id)))
                        .test_support()
                        .py_1()
                        .child(Notice::new(SharedString::from(format!(
                            "Saved hooks for this project are invalid and won't run. Saving a new hook replaces them. {error}"
                        )))
                        .tone(Tone::Error)),
                );
            }
            for (i, hook) in project.items.iter().enumerate() {
                if i > 0 {
                    group = group.child(ui::rule(window, cx));
                }
                group = group.child(self.row(&project.project_id, hook, window, cx));
            }
        }
        Some(group.into_any_element())
    }
}
impl Render for Hooks {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .id("hooks-section")
            .w_full()
            .min_w_0()
            .when_some(self.section(window, cx), |d, s| d.child(s))
    }
}
fn notice(id: &'static str, text: impl Into<SharedString>, tone: Tone) -> impl IntoElement {
    div()
        .id(id)
        .test_support()
        .py_1()
        .child(Notice::new(text).tone(tone))
}

/// The add/edit dialog. Holds only the fields; the section owns the write.
pub(crate) struct Editor {
    owner: WeakEntity<Hooks>,
    pub(crate) project_id: String,
    project_name: String,
    /// The hook being edited; None for a new one.
    pub(crate) editing: Option<String>,
    pub(crate) kind: Kind,
    pub(crate) name: Entity<TextareaState>,
    pub(crate) command: Entity<TextareaState>,
    pub(crate) paths: Entity<TextareaState>,
    pub(crate) message: Entity<TextareaState>,
    pub(crate) send_failures: bool,
    confirm_delete: bool,
    note: Option<(SharedString, Tone)>,
    /// The fields as opened, so an untouched dialog holds nothing.
    opened: Draft,
    focus: FocusHandle,
    _inputs: Vec<Subscription>,
}
impl Editor {
    fn new(
        owner: WeakEntity<Hooks>,
        project_id: String,
        project_name: String,
        editing: Option<String>,
        draft: Draft,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let area = |text: String,
                    placeholder: &'static str,
                    rows: (usize, usize),
                    w: &mut Window,
                    cx: &mut Context<Self>| {
            cx.new(|cx| {
                let mut t = TextareaState::new(w, cx)
                    .placeholder(placeholder)
                    .auto_grow(rows.0, rows.1);
                t.set_submit_on_enter(false, cx);
                t.set_value(text, w, cx);
                t
            })
        };
        let name = area(draft.name.clone(), "Install dependencies", (1, 2), w, cx);
        let command = area(
            draft.command.clone(),
            "pnpm install --frozen-lockfile",
            (1, 6),
            w,
            cx,
        );
        let paths = area(
            draft.paths.clone(),
            "Any file. Or globs such as packages/**, one per line",
            (1, 4),
            w,
            cx,
        );
        let message = area(
            draft.message.clone(),
            "Optional extra instruction for the agent",
            (2, 6),
            w,
            cx,
        );
        let inputs = vec![
            cx.observe(&name, |_, _, cx| cx.notify()),
            cx.observe(&command, |_, _, cx| cx.notify()),
        ];
        Self {
            owner,
            project_id,
            project_name,
            editing,
            kind: draft.kind,
            name,
            command,
            paths,
            message,
            send_failures: draft.send_failures,
            confirm_delete: false,
            note: None,
            opened: draft,
            focus: cx.focus_handle(),
            _inputs: inputs,
        }
    }
    fn open(form: Entity<Self>, w: &mut Window, cx: &mut App) {
        let title = if form.read(cx).editing.is_some() {
            "Edit hook"
        } else {
            "New hook"
        };
        w.open_dialog(cx, {
            let form = form.clone();
            move |dialog, _, cx| {
                ui::dialog(dialog, cx)
                    .title(title)
                    .w(px(520.))
                    .overlay_closable(false)
                    .close_button(false)
                    .keyboard(false)
                    .on_cancel(|_, _, _| false)
                    .child(form.clone())
            }
        });
        let name = form.read(cx).name.clone();
        name.read(cx).focus_handle(cx).focus(w, cx);
    }
    /// Values at intent time, not queued change events.
    pub(crate) fn draft(&self, cx: &App) -> Draft {
        Draft {
            kind: self.kind,
            name: self.name.read(cx).value().to_string(),
            command: self.command.read(cx).value().to_string(),
            paths: self.paths.read(cx).value().to_string(),
            send_failures: self.send_failures,
            message: self.message.read(cx).value().to_string(),
        }
    }
    fn changed(&self, cx: &App) -> bool {
        self.draft(cx) != self.opened
    }
    pub(crate) fn marked(&mut self, w: &mut Window, cx: &mut Context<Self>) -> bool {
        [
            self.name.clone(),
            self.command.clone(),
            self.paths.clone(),
            self.message.clone(),
        ]
        .iter()
        .any(|i| i.update(cx, |i, cx| i.marked_text_range(w, cx).is_some()))
    }
    fn show(&mut self, text: SharedString, tone: Tone, cx: &mut Context<Self>) {
        self.note = Some((text, tone));
        self.confirm_delete = false;
        cx.notify();
    }
    fn clear(&mut self, cx: &mut Context<Self>) {
        self.note = None;
        cx.notify();
    }
    pub(crate) fn set_kind(&mut self, kind: Kind, cx: &mut Context<Self>) {
        self.kind = kind;
        self.note = None;
        cx.notify();
    }
    fn pending(&self, cx: &App) -> bool {
        self.owner
            .upgrade()
            .is_none_or(|o| o.read(cx).pending.is_some())
    }
    fn act(
        &mut self,
        w: &mut Window,
        cx: &mut Context<Self>,
        run: fn(&mut Hooks, &mut Window, &mut Context<Hooks>),
    ) {
        if self.marked(w, cx) || self.pending(cx) {
            return;
        }
        let owner = self.owner.clone();
        // Leave this entity's update before the owner reads it.
        w.defer(cx, move |w, cx| {
            let _ = owner.update(cx, |v, cx| run(v, w, cx));
        });
    }
}
impl Render for Editor {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let pending = self.pending(cx);
        let muted = cx.theme().muted_foreground;
        let me = cx.weak_entity();
        let kind_menu = Button::new("hook-editor-kind")
            .ghost()
            .small()
            .w_full()
            .disabled(pending)
            .accessibility_label(SharedString::from(format!("Runs: {}", self.kind.title())))
            .child(
                div()
                    .h_flex()
                    .w_full()
                    .min_w_0()
                    .items_center()
                    .gap(px(Space::CONTROL))
                    .child(
                        ui::text(Text::Body, self.kind.title())
                            .flex_1()
                            .min_w_0()
                            .truncate(),
                    )
                    .child(
                        div()
                            .flex_none()
                            .text_color(muted)
                            .child(AppIcon::Expand.inline()),
                    ),
            )
            .dropdown_menu({
                let current = self.kind;
                move |mut menu, _, _| {
                    for kind in Kind::ALL {
                        let me = me.clone();
                        menu = menu.item(
                            PopupMenuItem::new(kind.title())
                                .checked(kind == current)
                                .on_click(move |_, _, cx| {
                                    let _ = me.update(cx, |e, cx| e.set_kind(kind, cx));
                                }),
                        );
                    }
                    menu
                }
            });
        let field = |label: &'static str, child: gpui_kit::AnyElement| {
            div()
                .v_flex()
                .gap_1()
                .min_w_0()
                .child(ui::text(Text::Label, label))
                .child(child)
        };
        let mut form = div()
            .id("hook-editor")
            .test_support()
            .track_focus(&self.focus)
            .v_flex()
            .gap_3()
            .min_w_0()
            .capture_action(cx.listener(|v, _: &gpui_kit::base::input::Escape, w, cx| {
                cx.stop_propagation();
                v.act(w, cx, Hooks::dismiss_editor);
            }))
            .child(
                ui::text(Text::Caption, SharedString::from(self.project_name.clone()))
                    .id("hook-editor-project")
                    .test_support()
                    .truncate()
                    .text_color(muted),
            )
            .child(field(
                "Name",
                div()
                    .id("hook-editor-name")
                    .test_support()
                    .child(
                        Textarea::new(&self.name)
                            .aria_label("Hook name")
                            .disabled(pending),
                    )
                    .into_any_element(),
            ))
            .child(field(
                "Runs",
                div()
                    .id("hook-editor-kind-row")
                    .test_support()
                    .child(kind_menu)
                    .into_any_element(),
            ));
        match self.kind {
            Kind::Setup | Kind::Check => {
                form = form.child(field(
                    "Command",
                    div()
                        .id("hook-editor-command")
                        .test_support()
                        .child(
                            Textarea::new(&self.command)
                                .aria_label("Command")
                                .disabled(pending),
                        )
                        .into_any_element(),
                ));
            }
            Kind::Continue => {
                form = form.child(field(
                    "Message",
                    div()
                        .id("hook-editor-message")
                        .test_support()
                        .child(
                            Textarea::new(&self.message)
                                .aria_label("Message to the agent")
                                .disabled(pending),
                        )
                        .into_any_element(),
                ));
            }
        }
        if self.kind == Kind::Check {
            form = form
                .child(field(
                    "Only when these files change",
                    div()
                        .id("hook-editor-paths")
                        .test_support()
                        .child(
                            Textarea::new(&self.paths)
                                .aria_label("Changed file paths")
                                .disabled(pending),
                        )
                        .into_any_element(),
                ))
                .child(
                    Checkbox::new("hook-editor-failures")
                        .label("Send failures to the agent")
                        .checked(self.send_failures)
                        .disabled(pending)
                        .on_change(cx.listener(|v, checked: &bool, _, cx| {
                            v.send_failures = *checked;
                            cx.notify();
                        })),
                );
        }
        let help = match self.kind {
            Kind::Setup => {
                "Runs in this project's new and restored chat workspaces. The first turn waits up to 10 minutes."
            }
            Kind::Check => {
                "Runs after a chat's run changes files. Failures can go back to the agent, up to 3 times."
            }
            Kind::Continue => {
                "Asks the agent to continue when its run ends with open todos, up to 3 times."
            }
        };
        form = form.child(ui::text(Text::Caption, help).text_color(muted));
        if let Some((text, tone)) = &self.note {
            form = form.child(
                div()
                    .id("hook-editor-note")
                    .test_support()
                    .child(Notice::new(text.clone()).tone(*tone)),
            );
        }
        let can_save = !pending && !self.name.read(cx).value().trim().is_empty();
        form.child(
            div()
                .h_flex()
                .items_center()
                .gap_2()
                .when(self.editing.is_some(), |d| {
                    d.child(
                        ui::action(
                            "hook-editor-delete",
                            if self.confirm_delete {
                                "Delete hook"
                            } else {
                                "Delete…"
                            },
                            if self.confirm_delete {
                                Action::Danger
                            } else {
                                Action::Quiet
                            },
                        )
                        .disabled(pending)
                        .on_click(cx.listener(|v, _, w, cx| {
                            if v.confirm_delete {
                                v.act(w, cx, Hooks::delete);
                            } else {
                                v.confirm_delete = true;
                                v.note = Some((
                                    "Deleting stops it for new runs. Running commands finish."
                                        .into(),
                                    Tone::Quiet,
                                ));
                                cx.notify();
                            }
                        })),
                    )
                })
                .child(div().flex_1())
                .child(
                    ui::action("hook-editor-cancel", "Cancel", Action::Secondary)
                        .on_click(cx.listener(|v, _, w, cx| v.act(w, cx, Hooks::dismiss_editor))),
                )
                .child(
                    ui::action(
                        "hook-editor-save",
                        if self.editing.is_some() {
                            "Save"
                        } else {
                            "Add hook"
                        },
                        Action::Primary,
                    )
                    .disabled(!can_save)
                    .loading(pending)
                    .on_click(cx.listener(|v, _, w, cx| v.act(w, cx, Hooks::submit))),
                ),
        )
    }
}
