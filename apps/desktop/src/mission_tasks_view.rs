//! Retained readonly task disclosure. The parent owns mission navigation and its scroll.
use crate::{
    LocalOptions,
    mission_browser::Key,
    mission_tasks::{Snapshot, State},
    mission_tasks_reader::{Reader, Request, Route},
    ui::{self, Action, Notice, ResourceLabel, Space, Text, Tone},
};
use gpui_kit::{
    App, AppContext, ClipboardItem, Context, Entity, FocusHandle, Focusable, InteractiveElement,
    IntoElement, ParentElement, Render, SharedString, Styled, Subscription, Task, TestSupportExt,
    WeakEntity, Window,
    base::SelectableText,
    component::{
        Disableable, IndexPath, StyledExt,
        list::{List, ListDelegate, ListEvent, ListItem, ListState},
    },
    div, px,
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
}
impl ListDelegate for Rows {
    type Item = ListItem;
    // Kit ListState owns the keyboard index; description selection is separate.
    fn set_selected_index(
        &mut self,
        _: Option<IndexPath>,
        _: &mut Window,
        _: &mut Context<ListState<Self>>,
    ) {
    }
    fn items_count(&self, _: usize, _: &App) -> usize {
        self.snapshot.tasks.len()
    }
    fn render_item(
        &mut self,
        ix: IndexPath,
        _: &mut Window,
        _: &mut Context<ListState<Self>>,
    ) -> Option<ListItem> {
        let t = self.snapshot.tasks.get(ix.row)?;
        let id = t.id.clone();
        let owner = self.owner.clone();
        let generation = self.generation;
        Some(
            ListItem::new(SharedString::from(format!("mission-tasks-row-{}", t.id)))
                .accessibility_label(SharedString::from(format!(
                    "#{} {}, {}",
                    t.number, t.title, t.status
                )))
                .on_click(move |_, w, cx| {
                    cx.stop_propagation();
                    let _ = owner.update(cx, |v, cx| v.select(&id, generation, w, cx));
                })
                .child(
                    div()
                        .id(SharedString::from(format!("mission-tasks-item-{}", t.id)))
                        .test_support()
                        .w_full()
                        .min_w_0()
                        .py_1()
                        .child(
                            ResourceLabel::new(SharedString::from(format!(
                                "#{} {}",
                                t.number, t.title
                            )))
                            .detail(SharedString::from(t.status.clone())),
                        ),
                ),
        )
    }
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
    detail_focus: FocusHandle,
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
    #[cfg(target_os = "macos")]
    pub(crate) fn restart_safe(&self) -> bool {
        self.creation.is_none()
            && self.creations.is_empty()
            && self.status_form.is_none()
            && self.statuses.is_empty()
            && self.edit_form.is_none()
            && self.edits.is_empty()
            && self.model_form.is_none()
            && self.models.is_empty()
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
            detail_focus: cx.focus_handle(),
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
            || self.detail_focus.contains_focused(w, cx)
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
            if self.creations.len() >= 16 {
                self.create_error = Some(
                    "Task drafts reached this window's 16-mission limit. Existing text is retained; copy it before closing the app.",
                );
                cx.notify();
                return;
            }
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
            if f.read(cx).owns_focus(w, cx) {
                self.trigger.focus(w, cx);
            }
            f.update(cx, |f, cx| {
                f.visible = false;
                cx.notify();
            });
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
            if self.statuses.len() >= 32 {
                self.create_error = Some(
                    "Status drafts reached this window's 32-task limit. Existing choices and receipts are retained.",
                );
                cx.notify();
                return;
            }
            let f = cx.new(|cx| crate::task_status_view::Form::new(target, options, cx));
            let sub = cx.subscribe_in(
                &f,
                w,
                |v, source, event: &crate::task_status_view::Event, w, cx| {
                    if v.status_form.as_ref() == Some(source) {
                        match event {
                            crate::task_status_view::Event::Close => {
                                v.hide_status(w, cx);
                                if v.state.selected.as_ref().is_some_and(|id| {
                                    v.state
                                        .snapshot
                                        .as_ref()
                                        .is_some_and(|s| s.task(id).is_some())
                                }) {
                                    v.detail_focus.focus(w, cx);
                                }
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
            f.focus(w, cx);
            cx.notify();
        });
        if let Some(f) = self.creation.take() {
            f.update(cx, |f, _| f.visible = false);
        }
        self.status_form = Some(form);
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
                            if view.update_in(cx, |v,w,cx| { if v.opened && v.state.accept(r.generation, &r.route.0, r.result) { v.rebuild(w,cx); cx.notify(); } }).is_err() { return; }
                        }
                        let _=view.update(cx,|v,cx| { if v.lane==lane { v.reader=None; v.state.busy=false; if v.opened { v.state.error.get_or_insert("Task reader stopped. Retained tasks are stale; Refresh to retry."); } cx.notify(); } });
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
            self.state.error = Some("Task read could not be queued. Refresh to retry.");
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
                    .and_then(|id| snapshot.tasks.iter().position(|t| &t.id == id))
                    .map(IndexPath::new);
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
                        .tasks
                        .get(ix.row)
                        .map(|t| t.id.clone());
                    if let Some(id) = choice {
                        v.select(&id, v.state.generation, w, cx);
                    }
                }
                ListEvent::Cancel => v.close(w, cx),
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
                let ix = l
                    .delegate()
                    .snapshot
                    .tasks
                    .iter()
                    .position(|t| t.id == id)
                    .map(IndexPath::new);
                l.set_selected_index(ix, w, cx);
            });
        }
        self.detail_focus.focus(w, cx);
        cx.notify();
    }
    fn close(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if self.marked(w, cx) {
            return;
        }
        self.hide_status(w, cx);
        if let Some(form) = self.creation.take() {
            form.update(cx, |f, _| f.visible = false);
        }
        self.trigger.focus(w, cx);
        self.opened = false;
        self.state.generation = self.state.generation.saturating_add(1);
        self.state.busy = false;
        self.reader = None;
        self.updates = None;
        cx.notify();
    }
    fn back(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if self.marked(w, cx) {
            return;
        }
        self.hide_status(w, cx);
        self.state.selected = None;
        if let Some(l) = &self.list {
            l.update(cx, |l, cx| l.focus(w, cx));
        } else {
            self.trigger.focus(w, cx);
        }
        cx.notify();
    }
}
impl Render for Pane {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let mut root = div()
            .id("mission-tasks-browser")
            .test_support()
            .v_flex()
            .w_full()
            .min_w_0()
            .gap(px(Space::CONTROL))
            .child(
                div()
                    .h_flex()
                    .gap_2()
                    .child(ui::heading(
                        "mission-tasks-heading",
                        "Tasks",
                        Text::Headline,
                    ))
                    .child(
                        ui::action(
                            "mission-tasks-toggle",
                            if self.opened {
                                "Close tasks"
                            } else {
                                "Browse tasks"
                            },
                            Action::Quiet,
                        )
                        .track_focus(&self.trigger)
                        .disabled(self.state.key.is_none())
                        .on_click(cx.listener(|v, _, w, cx| {
                            if v.opened {
                                v.close(w, cx);
                            } else {
                                v.opened = true;
                                v.read(w, cx);
                            }
                        })),
                    ),
            );
        if self.state.key.is_some() {
            root = root.child(
                ui::action("mission-task-new", "New task…", Action::Quiet)
                    .self_start()
                    .on_click(cx.listener(|v, _, w, cx| v.new_task(w, cx))),
            );
        }
        if let Some(e) = self.create_error {
            root = root.child(Notice::new(e).tone(Tone::Error));
        }
        if let Some(form) = &self.creation {
            root = root.child(form.clone());
        }
        if !self.opened {
            return root;
        }
        root = root.child(
            div()
                .h_flex()
                .gap_2()
                .child(
                    ui::action("mission-tasks-refresh", "Refresh tasks", Action::Quiet)
                        .disabled(self.state.busy)
                        .on_click(cx.listener(|v, _, w, cx| v.read(w, cx))),
                )
                .child(ui::text(
                    Text::Caption,
                    if self.state.busy {
                        "Loading tasks… Retained tasks are not current."
                    } else if self.state.error.is_some() {
                        "Task read failed. Retained tasks are stale."
                    } else {
                        "Task snapshot. Refresh explicitly to update."
                    },
                )),
        );
        if let Some(e) = self.state.error {
            root = root.child(
                div()
                    .id("mission-tasks-error")
                    .test_support()
                    .child(Notice::new(e).tone(Tone::Error)),
            );
        }
        if let Some(s) = &self.state.snapshot {
            root=root.child(ui::text(Text::Caption,SharedString::from(format!("{} · {} · {} tasks received. Viewer limit: 256 tasks / 2 MiB response. This API has no task paging.",s.title,s.status,s.tasks.len()))).id("mission-tasks-coverage").test_support());
            if s.tasks.is_empty() {
                root = root.child(Notice::new("No tasks received in this snapshot."));
            }
            if let Some(l) = &self.list {
                root = root.child(
                    div()
                        .id("mission-tasks-list")
                        .test_support()
                        .w_full()
                        .h(px(220.))
                        .child(List::new(l)),
                );
            }
            if let Some(t) = self.state.selected.as_ref().and_then(|id| s.task(id)) {
                let copy = Arc::new(format!(
                    "#{} {}\n{}\n{}\n\n{}",
                    t.number, t.title, t.status, t.context, t.body
                ));
                let generation = self.state.generation;
                let id = t.id.clone();
                let focus = self.detail_focus.clone();
                root = root.child(
                    div()
                        .id("mission-tasks-detail")
                        .test_support()
                        .track_focus(&self.detail_focus)
                        .v_flex()
                        .gap(px(Space::CONTROL))
                        .w_full()
                        .min_w_0()
                        .on_key_down(cx.listener(|v, event: &gpui_kit::KeyDownEvent, w, cx| {
                            if event.keystroke.key == "escape" {
                                v.back(w, cx);
                                cx.stop_propagation();
                            }
                        }))
                        .child(
                            div()
                                .h_flex()
                                .flex_wrap()
                                .gap_2()
                                .child(
                                    ui::action(
                                        "mission-tasks-back",
                                        "Close details",
                                        Action::Quiet,
                                    )
                                    .on_click(cx.listener(|v, _, w, cx| v.back(w, cx))),
                                )
                                .child(
                                    ui::action(
                                        "mission-task-status",
                                        "Change status…",
                                        Action::Quiet,
                                    )
                                    .on_click(cx.listener(|v, _, w, cx| v.change_status(w, cx))),
                                )
                                .child(
                                    ui::action(
                                        "mission-task-edit",
                                        "Edit title and body…",
                                        Action::Quiet,
                                    )
                                    .on_click(cx.listener(|v, _, w, cx| v.edit_task(w, cx))),
                                )
                                .child(
                                    ui::action(
                                        "mission-task-model",
                                        "Preferred model…",
                                        Action::Quiet,
                                    )
                                    .on_click(cx.listener(|v, _, w, cx| v.task_model(w, cx))),
                                )
                                .child(
                                    ui::action("mission-tasks-copy", "Copy task", Action::Quiet)
                                        .on_click(cx.listener(move |v, _, _, cx| {
                                            if v.opened
                                                && v.state.generation == generation
                                                && v.state.selected.as_ref() == Some(&id)
                                            {
                                                cx.write_to_clipboard(ClipboardItem::new_string(
                                                    (*copy).clone(),
                                                ));
                                            }
                                        })),
                                ),
                        )
                        .child(
                            div()
                                .id("mission-tasks-description")
                                .test_support()
                                .w_full()
                                .min_w_0()
                                .on_mouse_down(gpui_kit::MouseButton::Left, move |_, w, cx| {
                                    focus.focus(w, cx)
                                })
                                .child(SelectableText::new(
                                    SharedString::from(format!(
                                        "mission-task-detail-{}-{}",
                                        t.id, generation
                                    )),
                                    SharedString::from(format!(
                                        "#{} {}\n{}\n{}\n\n{}",
                                        t.number,
                                        t.title,
                                        t.status,
                                        t.context,
                                        if t.body.is_empty() {
                                            "No description saved."
                                        } else {
                                            &t.body
                                        }
                                    )),
                                )),
                        ),
                );
            }
        }
        if let Some(form) = &self.status_form {
            root = root.child(form.clone());
        }
        root
    }
}
