//! The mission's Tasks tab: every received task, grouped by phase, with the
//! row actions in a "…" menu and the right-click menu. Status, edit and model
//! forms open as dialogs. The parent owns mission navigation and tabs.
use crate::{
    LocalOptions,
    mission_browser::Key,
    mission_tasks::{Snapshot, State},
    mission_tasks_reader::{Reader, Request, Route},
    ui::{self, Action, Notice, ResourceLabel, Space, Text, Tone},
};
use gpui_kit::{
    App, AppContext, ClipboardItem, Context, Entity, FocusHandle, Focusable, InteractiveElement,
    IntoElement, ParentElement, Render, ScrollStrategy, SharedString, StatefulInteractiveElement,
    Styled, Subscription, Task, TestSupportExt, WeakEntity, Window,
    component::{
        ActiveTheme, Disableable, IndexPath, StyledExt, WindowExt,
        list::{List, ListDelegate, ListEvent, ListItem, ListState},
        menu::{ContextMenuExt, DropdownMenu, PopupMenu, PopupMenuItem},
    },
    div,
    prelude::FluentBuilder,
    px,
};
use std::sync::Arc;
#[path = "task_edit_pane.rs"]
mod task_edit_pane;
#[path = "task_model_pane.rs"]
mod task_model_pane;

pub(crate) struct Rows {
    owner: WeakEntity<Pane>,
    snapshot: Arc<Snapshot>,
    generation: u64,
    /// The list's highlighted row, which shows its "…" button.
    current: Option<IndexPath>,
}
fn index_path((section, row): (usize, usize)) -> IndexPath {
    IndexPath::new(row).section(section)
}
impl ListDelegate for Rows {
    type Item = ListItem;
    fn set_selected_index(
        &mut self,
        ix: Option<IndexPath>,
        _: &mut Window,
        cx: &mut Context<ListState<Self>>,
    ) {
        self.current = ix;
        cx.notify();
    }
    fn sections_count(&self, _: &App) -> usize {
        self.snapshot.sections.len().max(1)
    }
    fn items_count(&self, section: usize, _: &App) -> usize {
        self.snapshot
            .sections
            .get(section)
            .map_or(0, |s| s.tasks.len())
    }
    /// "Build  3/8 done", as in Swift's Tasks tab. Every header has one line,
    /// so Kit's single measured header height holds for all of them.
    fn render_section_header(
        &mut self,
        section: usize,
        _: &mut Window,
        cx: &mut Context<ListState<Self>>,
    ) -> Option<impl IntoElement> {
        let s = self.snapshot.sections.get(section)?;
        let title = s.title.clone()?;
        Some(
            div()
                .id(SharedString::from(format!("mission-tasks-phase-{section}")))
                .test_support()
                .h_flex()
                .w_full()
                .min_w_0()
                .items_center()
                .gap_2()
                .px_3()
                .pt_3()
                .pb_1()
                .child(
                    ui::text(Text::Body, SharedString::from(title))
                        .min_w_0()
                        .truncate()
                        .font_semibold(),
                )
                .child(
                    ui::text(Text::Caption, SharedString::from(s.progress.clone()))
                        .flex_none()
                        .text_color(cx.theme().muted_foreground),
                ),
        )
    }
    fn render_item(
        &mut self,
        ix: IndexPath,
        _: &mut Window,
        cx: &mut Context<ListState<Self>>,
    ) -> Option<ListItem> {
        let t = self.snapshot.at(ix.section, ix.row)?;
        let id = t.id.clone();
        let owner = self.owner.clone();
        let generation = self.generation;
        let (label, fill, color) = ui::task_status(&t.status, cx);
        let current = self.current == Some(ix);
        let (menu_owner, menu_id) = (self.owner.clone(), t.id.clone());
        let (button_owner, button_id) = (self.owner.clone(), t.id.clone());
        // Status, then the description's first line, as Swift's collapsed row.
        let detail = match t.body.lines().map(str::trim).find(|l| !l.is_empty()) {
            Some(line) => format!("{label} · {line}"),
            None => label.to_string(),
        };
        Some(
            ListItem::new(SharedString::from(format!("mission-tasks-row-{}", t.id)))
                .accessibility_label(SharedString::from(format!(
                    "#{} {}, {}",
                    t.number, t.title, label
                )))
                .on_click(move |_, w, cx| {
                    cx.stop_propagation();
                    let _ = owner.update(cx, |v, cx| v.select(&id, generation, w, cx));
                })
                .child(
                    div()
                        .id(SharedString::from(format!("mission-tasks-menu-{}", t.id)))
                        .group("mission-task-row")
                        .w_full()
                        .min_w_0()
                        .h_flex()
                        .items_center()
                        .gap_2()
                        .child(
                            div()
                                .id(SharedString::from(format!("mission-tasks-item-{}", t.id)))
                                .test_support()
                                .flex_1()
                                .min_w_0()
                                .py_1()
                                .h_flex()
                                .items_center()
                                .gap(px(Space::CONTROL))
                                .child(ui::status_pie(fill, color))
                                .child(
                                    ResourceLabel::new(SharedString::from(format!(
                                        "#{} {}",
                                        t.number, t.title
                                    )))
                                    .detail(detail),
                                ),
                        )
                        // Shown on hover and on the highlighted row, which keeps
                        // it as a Tab stop; the right-click menu is the same.
                        .child(
                            div()
                                .flex_none()
                                .opacity(if current { 1. } else { 0. })
                                .group_hover("mission-task-row", |s| s.opacity(1.))
                                .child(
                                    ui::icon_action(
                                        SharedString::from(format!("mission-task-menu-{}", t.id)),
                                        SharedString::from(format!(
                                            "Actions for task #{}",
                                            t.number
                                        )),
                                        crate::app_icon::AppIcon::More,
                                        Action::Quiet,
                                    )
                                    .tab_stop(current)
                                    .dropdown_menu(
                                        move |menu, _, _| {
                                            row_menu(menu, &button_owner, &button_id, generation)
                                        },
                                    ),
                                ),
                        )
                        .context_menu(move |menu, _, _| {
                            row_menu(menu, &menu_owner, &menu_id, generation)
                        }),
                ),
        )
    }
}
/// A row's commands, each run on that exact task.
fn row_menu(mut menu: PopupMenu, owner: &WeakEntity<Pane>, id: &str, generation: u64) -> PopupMenu {
    for (label, action) in [
        ("Change status…", RowAction::Status),
        ("Edit title and description…", RowAction::Edit),
        ("Preferred model…", RowAction::Model),
        ("Copy task", RowAction::Copy),
    ] {
        let (owner, id) = (owner.clone(), id.to_string());
        menu = menu.item(PopupMenuItem::new(label).on_click(move |_, w, cx| {
            let _ = owner.update(cx, |v, cx| v.row_action(&id, generation, action, w, cx));
        }));
    }
    menu
}
#[derive(Clone, Copy)]
enum RowAction {
    Status,
    Edit,
    Model,
    Copy,
}
fn copy_text(t: &crate::mission_tasks::Task) -> String {
    format!(
        "#{} {}\n{}\n{}\n\n{}",
        t.number, t.title, t.status, t.context, t.body
    )
}
pub(crate) struct Pane {
    pub(crate) state: State,
    options: Option<LocalOptions>,
    pub(crate) opened: bool,
    reader: Option<Reader>,
    updates: Option<Task<()>>,
    lane: u64,
    list: Option<Entity<ListState<Rows>>>,
    subscription: Option<Subscription>,
    trigger: FocusHandle,
    /// A reveal awaiting its snapshot; the exact task to select, if any.
    reveal: Option<Option<String>>,
    pub(crate) creation: Option<Entity<crate::mission_task_create_view::Form>>,
    creations: Vec<(Entity<crate::mission_task_create_view::Form>, Subscription)>,
    create_error: Option<&'static str>,
    pub(crate) status_form: Option<Entity<crate::task_status_view::Form>>,
    statuses: Vec<(Entity<crate::task_status_view::Form>, Subscription)>,
    pub(crate) edit_form: Option<Entity<crate::task_edit_view::Form>>,
    edits: Vec<(Entity<crate::task_edit_view::Form>, Subscription)>,
    pub(crate) model_form: Option<Entity<crate::task_model_view::Form>>,
    models: Vec<(Entity<crate::task_model_view::Form>, Subscription)>,
}
impl Pane {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    /// The first retained task form with unsent input or an unanswered request.
    pub(crate) fn update_blocker(&self, cx: &gpui_kit::App) -> Option<crate::update_hold::Blocker> {
        let mission =
            |key: &crate::mission_browser::Key, hold| crate::update_hold::Blocker::Mission {
                key: key.clone(),
                hold,
            };
        let created = self.creations.iter().find_map(|(f, _)| {
            let f = f.read(cx);
            f.update_hold(cx).map(|h| mission(&f.key, h))
        });
        created
            .or_else(|| {
                self.statuses.iter().find_map(|(f, _)| {
                    let f = f.read(cx);
                    f.update_hold().map(|h| mission(&f.target.key, h))
                })
            })
            .or_else(|| {
                self.edits.iter().find_map(|(f, _)| {
                    let f = f.read(cx);
                    f.update_hold(cx).map(|h| mission(&f.source.key, h))
                })
            })
            .or_else(|| {
                self.models.iter().find_map(|(f, _)| {
                    let f = f.read(cx);
                    f.update_hold().map(|h| mission(&f.target.key, h))
                })
            })
    }
    pub(crate) fn new(cx: &mut Context<Self>) -> Self {
        Self {
            state: State::default(),
            options: None,
            opened: false,
            reader: None,
            updates: None,
            lane: 0,
            list: None,
            subscription: None,
            trigger: cx.focus_handle(),
            reveal: None,
            creation: None,
            creations: Vec::new(),
            create_error: None,
            status_form: None,
            statuses: Vec::new(),
            edit_form: None,
            edits: Vec::new(),
            model_form: None,
            models: Vec::new(),
        }
    }
    pub(crate) fn owns_focus(&self, w: &Window, cx: &App) -> bool {
        self.model_form
            .as_ref()
            .is_some_and(|f| f.read(cx).owns_focus(w, cx))
            || self
                .edit_form
                .as_ref()
                .is_some_and(|f| f.read(cx).owns_focus(w, cx))
            || self
                .status_form
                .as_ref()
                .is_some_and(|f| f.read(cx).owns_focus(w, cx))
            || self
                .creation
                .as_ref()
                .is_some_and(|f| f.read(cx).owns_focus(w, cx))
            || self.trigger.contains_focused(w, cx)
            || self
                .list
                .as_ref()
                .is_some_and(|l| l.read(cx).focus_handle(cx).contains_focused(w, cx))
    }
    pub(crate) fn sync(
        &mut self,
        key: Option<Key>,
        options: Option<LocalOptions>,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.marked(w, cx) {
            return;
        }
        self.options = options;
        if self.state.target(key) {
            self.hide_status(w, cx);
            if let Some(form) = self.creation.take() {
                form.update(cx, |f, _| f.visible = false);
            }
            self.create_error = None;
            self.opened = false;
            self.reveal = None;
            self.reader = None;
            self.updates = None;
            self.list = None;
            self.subscription = None;
            cx.notify();
        }
    }
    pub(crate) fn marked(&mut self, w: &mut Window, cx: &mut Context<Self>) -> bool {
        self.edit_form
            .as_ref()
            .is_some_and(|f| f.update(cx, |f, cx| f.marked(w, cx)))
            || self
                .creation
                .as_ref()
                .is_some_and(|f| f.update(cx, |f, cx| f.marked(w, cx)))
    }
    /// Open the list and, given an exact task ID, select it once a current
    /// snapshot contains it. A missing ID or failed read selects nothing.
    pub(crate) fn reveal(&mut self, id: Option<String>, w: &mut Window, cx: &mut Context<Self>) {
        if self.state.key.is_none() || self.marked(w, cx) {
            return;
        }
        let current = !self.state.busy && self.state.error.is_none();
        let shown = match &id {
            Some(id) => self
                .state
                .snapshot
                .as_ref()
                .is_some_and(|s| s.task(id).is_some()),
            None => self.list.is_some(),
        };
        self.reveal = Some(id);
        if self.opened && current && shown {
            self.settle_reveal(w, cx);
            return;
        }
        // Open, or refresh a snapshot that may predate the task; an in-flight
        // read settles it instead.
        self.opened = true;
        self.read(w, cx);
        if !self.state.busy {
            // Nothing was requested: never select on a later, unrelated read.
            self.reveal = None;
        }
    }
    fn settle_reveal(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        let Some(target) = self.reveal.take() else {
            return;
        };
        match target {
            Some(id)
                if self.state.error.is_none()
                    && self
                        .state
                        .snapshot
                        .as_ref()
                        .is_some_and(|s| s.task(&id).is_some()) =>
            {
                self.select(&id, self.state.generation, w, cx);
                // The revealed task may be any received row: centre it in the list.
                if let Some(list) = &self.list {
                    list.update(cx, |l, cx| {
                        if let Some(ix) = l.selected_index() {
                            l.scroll_to_item(ix, ScrollStrategy::Center, w, cx);
                        }
                    });
                }
            }
            _ => self.back(w, cx),
        }
    }
    /// Open the list when its tab shows, reading once; later shows keep the
    /// snapshot, selection and forms. `focus` moves focus into the list.
    pub(crate) fn show(&mut self, focus: bool, w: &mut Window, cx: &mut Context<Self>) {
        if self.state.key.is_none() || self.marked(w, cx) {
            return;
        }
        if !self.opened {
            self.opened = true;
            self.read(w, cx);
        }
        if focus {
            match &self.list {
                Some(l) => l.update(cx, |l, cx| l.focus(w, cx)),
                None => self.trigger.focus(w, cx),
            }
        }
    }
    fn new_task(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if self.marked(w, cx) {
            return;
        }
        self.hide_status(w, cx);
        let (Some(key), Some(options)) = (self.state.key.clone(), self.options.clone()) else {
            return;
        };
        if key.home != crate::mission_browser::Home::local(&options.host()) {
            return;
        }
        let prior = self
            .creations
            .iter()
            .find(|(f, _)| f.read(cx).matches(&key, &options))
            .map(|(f, _)| f.clone());
        let form = if let Some(f) = prior {
            f
        } else {
            let f = cx.new(|cx| crate::mission_task_create_view::Form::new(key, options, w, cx));
            let sub = cx.subscribe_in(
                &f,
                w,
                |v, source, _: &crate::mission_task_create_view::Close, w, cx| {
                    if v.creation.as_ref() != Some(source) {
                        return;
                    }
                    if let Some(form) = v.creation.take() {
                        form.update(cx, |f, _| f.visible = false);
                    }
                    v.trigger.focus(w, cx);
                    cx.notify();
                },
            );
            self.creations.push((f.clone(), sub));
            f
        };
        if let Some(previous) = self.creation.take() {
            previous.update(cx, |f, _| f.visible = false);
        }
        form.update(cx, |f, cx| {
            f.visible = true;
            f.focus(w, cx);
            cx.notify();
        });
        self.creation = Some(form);
        self.opened = true;
        cx.notify();
    }
    fn hide_status(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        self.hide_model(w, cx);
        self.hide_edit(w, cx);
        if let Some(f) = self.status_form.take() {
            let owned = f.read(cx).owns_focus(w, cx);
            let moved = w.focused(cx);
            w.close_dialog(cx);
            if owned {
                self.focus_list(w, cx);
            } else if let Some(focus) = moved {
                focus.focus(w, cx);
            }
            f.update(cx, |f, cx| {
                f.visible = false;
                cx.notify();
            });
        }
    }
    /// Focus the list, or the tab before it has one.
    pub(super) fn focus_list(&self, w: &mut Window, cx: &mut Context<Self>) {
        match &self.list {
            Some(l) => l.update(cx, |l, cx| l.focus(w, cx)),
            None => self.trigger.focus(w, cx),
        }
    }
    fn change_status(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if self.marked(w, cx) {
            return;
        }
        let (Some(snapshot), Some(id), Some(options)) = (
            &self.state.snapshot,
            &self.state.selected,
            self.options.clone(),
        ) else {
            return;
        };
        let Some(t) = snapshot.task(id) else {
            return;
        };
        let target = crate::task_status::Target {
            key: snapshot.key.clone(),
            task: t.id.clone(),
            number: t.number,
            title: t.title.clone(),
            current: t.work_status.clone(),
        };
        if target.key.home != crate::mission_browser::Home::local(&options.host()) {
            return;
        }
        let prior = self
            .statuses
            .iter()
            .find(|(f, _)| f.read(cx).matches(&target, &options))
            .map(|(f, _)| f.clone());
        let form = if let Some(f) = prior {
            f
        } else {
            let f = cx.new(|cx| crate::task_status_view::Form::new(target, options, cx));
            let sub = cx.subscribe_in(
                &f,
                w,
                |v, source, event: &crate::task_status_view::Event, w, cx| {
                    if v.status_form.as_ref() == Some(source) {
                        match event {
                            crate::task_status_view::Event::Close => {
                                v.hide_status(w, cx);
                            }
                            crate::task_status_view::Event::NewIntent => {
                                if !v.state.busy
                                    && v.state.error.is_none()
                                    && let Some(s) = &v.state.snapshot
                                    && s.key == source.read(cx).target.key
                                    && let Some(t) = s.task(&source.read(cx).target.task)
                                {
                                    let target = crate::task_status::Target {
                                        key: s.key.clone(),
                                        task: t.id.clone(),
                                        number: t.number,
                                        title: t.title.clone(),
                                        current: t.work_status.clone(),
                                    };
                                    source.update(cx, |f, cx| f.new_intent(target, cx));
                                }
                            }
                        }
                        cx.notify();
                    }
                },
            );
            self.statuses.push((f.clone(), sub));
            f
        };
        self.hide_status(w, cx);
        form.update(cx, |f, cx| {
            f.visible = true;
            cx.notify();
        });
        self.status_form = Some(form.clone());
        crate::task_status_view::Form::open(form, w, cx);
        cx.notify();
    }
    fn read(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if self.state.busy || !self.opened || self.marked(w, cx) {
            return;
        }
        let (Some(key), Some(options)) = (self.state.key.clone(), self.options.clone()) else {
            return;
        };
        let generation = self.state.begin();
        if self.reader.is_none() {
            match Reader::start(options) {
                Err(e) => {
                    self.state.busy = false;
                    self.state.error = Some(e);
                    cx.notify();
                    return;
                }
                Ok((reader, output)) => {
                    self.lane = self.lane.saturating_add(1);
                    let lane = self.lane;
                    self.reader = Some(reader);
                    self.updates=Some(cx.spawn_in(w, async move |view,cx| {
                        while let Ok(r)=output.recv().await {
                            if view.update_in(cx, |v,w,cx| { if v.opened && v.state.accept(r.generation, &r.route.0, r.result) { v.rebuild(w,cx); v.settle_reveal(w,cx); cx.notify(); } }).is_err() { return; }
                        }
                        let _=view.update(cx,|v,cx| { if v.lane==lane { v.reader=None; v.state.busy=false; if v.opened { v.state.error.get_or_insert("Couldn't load tasks. What's shown may be out of date; refresh to try again."); } cx.notify(); } });
                    }));
                }
            }
        }
        if !self.reader.as_ref().is_some_and(|r| {
            r.request(Request {
                generation,
                route: Some(Route(key)),
            })
        }) {
            self.state.busy = false;
            self.state.error = Some("Couldn't request tasks. Refresh to try again.");
        }
        cx.notify();
    }
    fn rebuild(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        let Some(snapshot) = self.state.snapshot.clone() else {
            return;
        };
        let generation = self.state.generation;
        if let Some(list) = &self.list {
            list.update(cx, |l, cx| {
                l.delegate_mut().snapshot = snapshot.clone();
                l.delegate_mut().generation = generation;
                let ix = self
                    .state
                    .selected
                    .as_ref()
                    .and_then(|id| snapshot.position(id))
                    .map(index_path);
                l.set_selected_index(ix, w, cx);
                cx.notify();
            });
        } else {
            let owner = cx.weak_entity();
            let list = cx.new(|cx| {
                ListState::new(
                    Rows {
                        owner,
                        snapshot,
                        generation,
                        current: None,
                    },
                    w,
                    cx,
                )
                .searchable(false)
            });
            self.subscription = Some(cx.subscribe_in(&list, w, |v, l, event, w, cx| match event {
                ListEvent::Confirm(ix) => {
                    let choice = l
                        .read(cx)
                        .delegate()
                        .snapshot
                        .at(ix.section, ix.row)
                        .map(|t| t.id.clone());
                    if let Some(id) = choice {
                        v.select(&id, v.state.generation, w, cx);
                    }
                }
                ListEvent::Cancel => v.back(w, cx),
                _ => {}
            }));
            self.list = Some(list);
            self.list
                .as_ref()
                .unwrap()
                .update(cx, |l, cx| l.focus(w, cx));
        }
    }
    fn select(&mut self, id: &str, generation: u64, w: &mut Window, cx: &mut Context<Self>) {
        if self.marked(w, cx) {
            return;
        }
        if !self.opened
            || self.state.generation != generation
            || !self
                .state
                .snapshot
                .as_ref()
                .is_some_and(|s| s.task(id).is_some())
        {
            return;
        }
        self.hide_status(w, cx);
        self.state.selected = Some(id.into());
        if let Some(list) = &self.list {
            list.update(cx, |l, cx| {
                let ix = l.delegate().snapshot.position(id).map(index_path);
                l.set_selected_index(ix, w, cx);
            });
        }
        self.focus_list(w, cx);
        cx.notify();
    }
    /// A row's context menu: select that exact task, then run the same
    /// command as its details button.
    fn row_action(
        &mut self,
        id: &str,
        generation: u64,
        action: RowAction,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.select(id, generation, w, cx);
        if self.state.selected.as_deref() != Some(id) {
            return;
        }
        match action {
            RowAction::Status => self.change_status(w, cx),
            RowAction::Edit => self.edit_task(w, cx),
            RowAction::Model => self.task_model(w, cx),
            RowAction::Copy => {
                if let Some(t) = self.state.snapshot.as_ref().and_then(|s| s.task(id)) {
                    cx.write_to_clipboard(ClipboardItem::new_string(copy_text(t)));
                }
            }
        }
    }
    fn back(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if self.marked(w, cx) {
            return;
        }
        self.hide_status(w, cx);
        self.state.selected = None;
        self.focus_list(w, cx);
        cx.notify();
    }
}
impl Pane {
    /// Progress bar and legend as in the overview: bar order, work status, no dropped.
    fn coverage(s: &Snapshot, cx: &App) -> gpui_kit::Div {
        let counts: Vec<_> = s
            .progress
            .iter()
            .map(|(status, n)| {
                let (label, fill, color) = ui::task_status(status, cx);
                (label, fill, color, *n, *status)
            })
            .collect();
        let mut track = cx.theme().muted_foreground;
        track.a *= 0.25;
        // To do and delegated leave the track showing.
        let bar: Vec<_> = counts
            .iter()
            .filter(|c| (c.1 > 0. && c.4 != "delegated") || c.4 == "blocked")
            .map(|c| (c.3, c.2))
            .collect();
        let total = counts.iter().map(|c| c.3).sum();
        div()
            .v_flex()
            .gap_2()
            .w_full()
            .max_w(px(360.))
            .child(ui::progress_bar(&bar, total, track))
            .child(
                div()
                    .h_flex()
                    .flex_wrap()
                    .gap_3()
                    .text_size(px(crate::appearance::TextRole::CAPTION))
                    .text_color(cx.theme().muted_foreground)
                    .children(counts.iter().map(|(label, _, color, n, status)| {
                        div()
                            .id(SharedString::from(format!("mission-tasks-legend-{status}")))
                            .test_support()
                            .h_flex()
                            .items_center()
                            .gap_1()
                            .child(div().size(px(6.)).rounded_full().bg(*color))
                            .child(SharedString::from(format!("{n} {}", label.to_lowercase())))
                    })),
            )
    }
}
impl Render for Pane {
    fn render(&mut self, w: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let snapshot = self.state.snapshot.clone();
        // Progress, then Refresh and New task: the tab's one toolbar.
        let toolbar = div()
            .h_flex()
            .items_start()
            .gap_2()
            .w_full()
            .min_w_0()
            .child(
                div()
                    .id("mission-tasks-coverage")
                    .test_support()
                    .flex_1()
                    .min_w_0()
                    .children(snapshot.as_ref().map(|s| Self::coverage(s, cx))),
            )
            .child(
                ui::icon_action(
                    "mission-tasks-refresh",
                    "Refresh tasks",
                    crate::app_icon::AppIcon::Retry,
                    Action::Quiet,
                )
                .disabled(self.state.busy || !self.opened)
                .on_click(cx.listener(|v, _, w, cx| v.read(w, cx))),
            )
            .child(
                ui::action("mission-task-new", "New task…", Action::Secondary)
                    .disabled(self.state.key.is_none())
                    .on_click(cx.listener(|v, _, w, cx| v.new_task(w, cx))),
            );
        let mut root = div()
            .id("mission-tasks-browser")
            .test_support()
            .track_focus(&self.trigger)
            .v_flex()
            .size_full()
            .min_w_0()
            .min_h_0()
            .gap(px(Space::CONTROL))
            .child(toolbar);
        if let Some(e) = self.create_error {
            root = root.child(Notice::new(e).tone(Tone::Error));
        }
        // Only states that change what the list means are narrated.
        if self.opened && (self.state.busy || self.state.error.is_some()) {
            root = root.child(ui::text(
                Text::Caption,
                if self.state.busy {
                    "Loading tasks…"
                } else {
                    "Couldn't refresh tasks. What's shown may be out of date."
                },
            ));
        }
        if let Some(e) = self.state.error {
            root = root.child(
                div()
                    .id("mission-tasks-error")
                    .test_support()
                    .child(Notice::new(e).tone(Tone::Error)),
            );
        }
        let empty = snapshot.as_ref().is_some_and(|s| s.tasks.is_empty());
        if empty {
            root = root.child(Notice::new("No tasks yet."));
        }
        let list = self.list.clone().filter(|_| !empty);
        if let Some(l) = &list {
            root = root.child(
                div()
                    .id("mission-tasks-list")
                    .test_support()
                    .w_full()
                    .flex_1()
                    .min_h(px(120.))
                    .child(List::new(l)),
            );
        }
        // New task opens below the list, scrolling on its own so the list
        // keeps its place.
        if self.creation.is_some() {
            root = root.child(
                div()
                    .id("mission-tasks-details")
                    .test_support()
                    .overflow_y_scroll()
                    .v_flex()
                    .w_full()
                    .min_w_0()
                    .min_h_0()
                    .flex_shrink_1()
                    .when(list.is_some(), |d| d.max_h(gpui_kit::relative(0.55)))
                    .gap(px(Space::CONTROL))
                    .child(ui::rule(w, cx))
                    .children(self.creation.clone()),
            );
        }
        root
    }
}

#[cfg(feature = "native-probes")]
#[path = "mission_forms_capacity_probe.rs"]
pub(crate) mod capacity_probe;
