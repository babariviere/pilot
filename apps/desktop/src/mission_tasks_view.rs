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
}
impl Pane {
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
        }
    }
    pub(crate) fn owns_focus(&self, w: &Window, cx: &App) -> bool {
        self.trigger.contains_focused(w, cx)
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
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.options = options;
        if self.state.target(key) {
            self.opened = false;
            self.reader = None;
            self.updates = None;
            self.list = None;
            self.subscription = None;
            cx.notify();
        }
    }
    fn read(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if self.state.busy || !self.opened {
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
        self.trigger.focus(w, cx);
        self.opened = false;
        self.state.generation = self.state.generation.saturating_add(1);
        self.state.busy = false;
        self.reader = None;
        self.updates = None;
        cx.notify();
    }
    fn back(&mut self, w: &mut Window, cx: &mut Context<Self>) {
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
                        "Read-only snapshot. Refresh explicitly to update."
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
        root
    }
}
