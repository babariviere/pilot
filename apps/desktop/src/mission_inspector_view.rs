//! Retained adjacent mission snapshot; the conversation and delivery own their lifetimes.
use crate::{
    LocalOptions,
    local_model::Chat,
    mission_browser::{Detail, Home, Members},
    mission_inspector::{Metadata, Source},
    mission_reader::{self, Data, Reader, Route},
    ui::{self, Action, Notice, ResourceLabel, Text, Tone},
};
use gpui_kit::{
    Context, EventEmitter, FocusHandle, InteractiveElement, IntoElement, ParentElement, Render,
    SharedString, StatefulInteractiveElement, Styled, Task, TestSupportExt, Window,
    base::SelectableText,
    component::{ActiveTheme, Disableable, Selectable, StyledExt},
    div, px,
};
use std::sync::Arc;
#[cfg(test)]
#[path = "mission_inspector_view_tests.rs"]
mod tests;
gpui_kit::actions!(mission_inspector, [Close, Toggle]);

#[derive(Clone)]
pub(crate) enum Event {
    Close,
    Chat {
        source: Source,
        id: String,
        generation: u64,
    },
}
pub(crate) struct Input {
    pub(crate) source: Option<Source>,
    pub(crate) availability: &'static str,
    pub(crate) metadata: Arc<Metadata>,
    pub(crate) chats: Arc<Vec<Chat>>,
    pub(crate) online: bool,
    pub(crate) active: bool,
}
pub(crate) struct Pane {
    pub(crate) source: Option<Source>,
    pub(crate) visible: bool,
    pub(crate) busy: bool,
    pub(crate) error: Option<&'static str>,
    pub(crate) detail: Option<Arc<Detail>>,
    members: Result<Arc<Members>, &'static str>,
    pub(crate) generation: u64,
    route: Option<Route>,
    current: bool,
    online: bool,
    availability: &'static str,
    metadata: Arc<Metadata>,
    chats: Arc<Vec<Chat>>,
    options: Option<LocalOptions>,
    reader: Option<Reader>,
    updates: Option<Task<()>>,
    lane: u64,
    pub(crate) focus: FocusHandle,
    scroll: gpui_kit::ScrollHandle,
    tasks_open: bool,
    members_open: bool,
}
impl EventEmitter<Event> for Pane {}
impl Pane {
    pub(crate) fn new(cx: &mut Context<Self>) -> Self {
        Self {
            source: None,
            visible: false,
            busy: false,
            error: None,
            detail: None,
            members: Err("Member chats not loaded."),
            generation: 0,
            route: None,
            current: false,
            online: false,
            availability: "Mission membership is not available.",
            metadata: Arc::default(),
            chats: Arc::new(vec![]),
            options: None,
            reader: None,
            updates: None,
            lane: 0,
            focus: cx.focus_handle().tab_stop(true),
            scroll: Default::default(),
            tasks_open: false,
            members_open: false,
        }
    }
    pub(crate) fn options(&mut self, options: LocalOptions) {
        self.cancel();
        self.detail = None;
        self.options = Some(options);
    }
    pub(crate) fn home(&self) -> Option<Home> {
        self.options.as_ref().map(|o| Home::local(&o.host()))
    }
    fn cancel(&mut self) {
        self.generation = self.generation.saturating_add(1);
        self.lane = self.lane.saturating_add(1);
        self.route = None;
        self.busy = false;
        self.current = false;
        self.reader = None;
        self.updates = None;
    }
    pub(crate) fn hide(&mut self, cx: &mut Context<Self>) {
        if self.visible || self.reader.is_some() {
            self.cancel();
            self.visible = false;
            cx.notify();
        }
    }
    pub(crate) fn sync(&mut self, input: Input, cx: &mut Context<Self>) {
        let changed = self.source != input.source;
        let notify = changed
            || self.online != input.online
            || self.availability != input.availability
            || !Arc::ptr_eq(&self.metadata, &input.metadata)
            || !Arc::ptr_eq(&self.chats, &input.chats);
        if changed {
            self.cancel();
            self.detail = None;
            self.members = Err("Member chats not loaded.");
            self.error = None;
            self.scroll.set_offset(gpui_kit::point(px(0.), px(0.)));
            self.tasks_open = false;
            self.members_open = false;
        } else if self.online != input.online {
            self.cancel();
            if self.detail.is_some() {
                self.error =
                    Some("Retained snapshot is not current. Refresh when Local is available.");
            }
        }
        self.source = input.source;
        self.online = input.online;
        self.availability = input.availability;
        self.metadata = input.metadata;
        self.chats = input.chats;
        if !input.active {
            self.hide(cx);
        }
        if notify {
            cx.notify();
        }
    }
    pub(crate) fn show(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        self.visible = true;
        self.refresh(w, cx);
    }
    pub(crate) fn refresh(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if self.busy || !self.visible {
            return;
        }
        self.cancel();
        self.error = None;
        if self.source.is_none() || !self.online {
            self.error = Some(if !self.online {
                "Local is unavailable. Retained text is not a current snapshot."
            } else {
                self.availability
            });
            cx.notify();
            return;
        }
        let Some(options) = self.options.clone() else {
            self.error = Some("Mission reads are unavailable in this captured view.");
            cx.notify();
            return;
        };
        match Reader::start(options) {
            Err(e) => self.error = Some(e),
            Ok((reader, updates)) => {
                self.reader = Some(reader);
                let lane = self.lane;
                self.updates = Some(cx.spawn_in(w, async move |view, cx| {
                    while let Ok(response) = updates.recv().await {
                        if view
                            .update_in(cx, |v, _, cx| v.accept(response, cx))
                            .is_err()
                        {
                            return;
                        }
                    }
                    let _ = view.update(cx, |v, cx| v.stopped(lane, cx));
                }));
                self.queue(Route::Catalog);
            }
        }
        cx.notify();
    }
    fn queue(&mut self, route: Route) {
        self.route = Some(route.clone());
        self.busy = self.reader.as_ref().is_some_and(|r| {
            r.request(mission_reader::Request {
                generation: self.generation,
                route: Some(route),
            })
        });
        if !self.busy {
            self.error = Some("Mission read could not be queued. Refresh explicitly.");
        }
    }
    pub(crate) fn accept(&mut self, response: mission_reader::Response, cx: &mut Context<Self>) {
        if !self.visible
            || !self.online
            || response.generation != self.generation
            || self.route.as_ref() != Some(&response.route)
        {
            return;
        }
        let Some(source) = self.source.as_ref() else {
            return;
        };
        self.busy = false;
        match response.result {
            Err(e) => {
                self.current = false;
                self.error = Some(e);
            }
            Ok(Data::Catalog(c)) if response.route == Route::Catalog => {
                if source.canonical(&c) {
                    self.queue(Route::Detail(source.key()));
                } else {
                    self.current = false;
                    self.error = Some(if c.truncated {
                        "Mission is outside the received canonical catalog window. No guessed lookup was made."
                    } else {
                        "Canonical Local mission context is unavailable. No host or ID fallback was attempted."
                    });
                }
            }
            Ok(Data::Detail(d, m))
                if response.route == Route::Detail(source.key())
                    && d.key == source.key()
                    && d.project == source.project =>
            {
                self.detail = Some(d);
                self.members = m;
                self.current = true;
                self.error = None;
            }
            _ => {
                self.current = false;
                self.error = Some("Mission context identity differs. Refresh explicitly.");
            }
        }
        cx.notify();
    }
    fn stopped(&mut self, lane: u64, cx: &mut Context<Self>) {
        if lane != self.lane {
            return;
        }
        self.reader = None;
        self.busy = false;
        self.current = false;
        if self.visible {
            self.error.get_or_insert(
                "Mission reader stopped. Retained context is not current; Refresh to retry.",
            );
        }
        cx.notify();
    }
    pub(crate) fn link_ready(&self, source: &Source, id: &str, generation: u64) -> bool {
        self.visible
            && self.current
            && self.online
            && !self.busy
            && self.error.is_none()
            && self.generation == generation
            && self.source.as_ref() == Some(source)
            && source.matches(&self.metadata, &source.chat)
            && source.matches(&self.metadata, id)
            && self
                .members
                .as_ref()
                .is_ok_and(|m| m.rows.iter().any(|r| r.id == id))
            && self.chats.iter().any(|c| {
                c.id == id && !c.local_draft && c.project_id.as_ref() == Some(&source.project)
            })
    }
    #[cfg(feature = "native-probes")]
    pub(crate) fn disconnect_probe(&self) {
        if let Some(r) = &self.reader {
            r.disconnect_fixture();
        }
    }
    fn plain(&self, id: &'static str, text: String) -> impl IntoElement {
        div()
            .id(id)
            .test_support()
            .min_w_0()
            .w_full()
            .child(SelectableText::new(
                SharedString::from(format!("{id}-{}", self.generation)),
                SharedString::from(text),
            ))
    }
}
impl Render for Pane {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let note = if self.busy {
            if self.detail.is_some() {
                "Refreshing; showing the previous snapshot…"
            } else {
                "Loading mission context…"
            }
        } else if !self.online {
            "Offline · retained snapshot, not current"
        } else if self.error.is_some() || !self.current {
            "Snapshot is not current"
        } else {
            "Read-only snapshot · Refresh to update"
        };
        let mut content = div()
            .v_flex()
            .gap_3()
            .p_3()
            .min_w_0()
            .w_full()
            .child(
                div()
                    .h_flex()
                    .items_start()
                    .gap_2()
                    .child(ui::text(Text::Headline, "Mission").flex_1())
                    .child(
                        ui::icon_action(
                            "mission-context-refresh",
                            "Refresh mission context",
                            ui::IconRole::Retry,
                            Action::Quiet,
                        )
                        .disabled(!self.online || self.busy || self.source.is_none())
                        .on_click(cx.listener(|v, _, w, cx| v.refresh(w, cx))),
                    ),
            )
            .child(
                ui::text(Text::Small, note)
                    .id("mission-context-state")
                    .test_support()
                    .text_color(cx.theme().muted_foreground),
            );
        if let Some(error) = self.error {
            content = content.child(Notice::new(error).tone(Tone::Error));
        }
        if self.source.is_none() {
            content = content.child(Notice::new(self.availability));
        }
        if let Some(d) = &self.detail {
            content = content
                .child(self.plain("mission-context-title", d.title.clone()))
                .child(
                    ui::text(Text::Caption, SharedString::from(d.status.clone()))
                        .text_color(cx.theme().muted_foreground),
                )
                .child(self.plain("mission-context-goal", d.goal.clone()));
            if let Some((done, total)) = d.counts {
                content = content.child(ui::text(
                    Text::Caption,
                    SharedString::from(format!("{done} of {total} tasks done (mission total)")),
                ));
            }
            content = content.child(
                ui::action(
                    "mission-context-tasks",
                    SharedString::from(format!(
                        "Tasks · {} received, {} shown",
                        d.task_count,
                        d.tasks.len()
                    )),
                    Action::Quiet,
                )
                .w_full()
                .selected(self.tasks_open)
                .on_click(cx.listener(|v, _, _, cx| {
                    v.tasks_open = !v.tasks_open;
                    cx.notify();
                })),
            );
            if self.tasks_open {
                if d.tasks.is_empty() {
                    content = content.child(ui::text(Text::Caption, "No tasks in this snapshot"));
                }
                for t in &d.tasks {
                    content = content.child(
                        div()
                            .id(SharedString::from(format!("mission-context-task-{}", t.id)))
                            .min_w_0()
                            .v_flex()
                            .gap_1()
                            .child(ui::text(
                                Text::Body,
                                SharedString::from(format!("#{} {}", t.number, t.title)),
                            ))
                            .child(
                                ui::text(
                                    Text::Caption,
                                    SharedString::from(format!(
                                        "{}{}",
                                        t.status,
                                        if t.owner.as_ref() == self.source.as_ref().map(|s| &s.chat)
                                        {
                                            " · this chat"
                                        } else {
                                            ""
                                        }
                                    )),
                                )
                                .text_color(cx.theme().muted_foreground),
                            ),
                    );
                }
                if d.task_count > d.tasks.len() {
                    content = content.child(Notice::new("Task context is limited to the first 24 received tasks. This is not the full mission task list."));
                }
            }
            if d.clipped {
                content = content.child(Notice::new(
                    "Mission text is clipped to the bounded display limit.",
                ));
            }
            match &self.members {
                Err(e) => content = content.child(Notice::new(*e).tone(Tone::Error)),
                Ok(m) => {
                    content = content.child(
                        ui::action(
                            "mission-context-members",
                            SharedString::from(format!(
                                "Members · {} received, {} shown",
                                m.total,
                                m.rows.len()
                            )),
                            Action::Quiet,
                        )
                        .w_full()
                        .selected(self.members_open)
                        .on_click(cx.listener(|v, _, _, cx| {
                            v.members_open = !v.members_open;
                            cx.notify();
                        })),
                    );
                    if self.members_open {
                        if m.rows.is_empty() {
                            content = content
                                .child(ui::text(Text::Caption, "No member chats in this snapshot"));
                        }
                        for member in &m.rows {
                            let id = member.id.clone();
                            let source = self.source.clone();
                            let generation = self.generation;
                            let ready = source
                                .as_ref()
                                .is_some_and(|s| self.link_ready(s, &id, generation));
                            content = content.child(
                                ui::action(
                                    SharedString::from(format!("mission-context-chat-{id}")),
                                    "",
                                    Action::Quiet,
                                )
                                .w_full()
                                .h(px(54.))
                                .justify_start()
                                .accessibility_label(SharedString::from(format!(
                                    "Open chat {}",
                                    member.title
                                )))
                                .child(
                                    ResourceLabel::new(SharedString::from(member.title.clone()))
                                        .detail(if ready {
                                            "Open existing chat"
                                        } else {
                                            "Unavailable in current Local context"
                                        })
                                        .icon(ui::IconRole::Chats),
                                )
                                .disabled(!ready)
                                .on_click(cx.listener(
                                    move |v, _, _, cx| {
                                        if let Some(s) = &source
                                            && v.link_ready(s, &id, generation)
                                        {
                                            cx.emit(Event::Chat {
                                                source: s.clone(),
                                                id: id.clone(),
                                                generation,
                                            });
                                        }
                                    },
                                )),
                            );
                        }
                        if m.total > m.rows.len() {
                            content = content.child(Notice::new("Member context is limited to 16 received chats; received counts are not a canonical total."));
                        }
                    }
                }
            }
        }
        div()
            .id("mission-context-pane")
            .test_support()
            .track_focus(&self.focus)
            .key_context("MissionContext")
            .on_action(cx.listener(|_, _: &Close, _, cx| {
                cx.emit(Event::Close);
                cx.stop_propagation();
            }))
            .on_action(cx.listener(|_, _: &gpui_kit::base::input::Copy, w, cx| {
                let text = gpui_kit::base::TextSelection::selected_text(w, cx);
                if text.is_empty() {
                    cx.propagate();
                } else {
                    cx.write_to_clipboard(gpui_kit::ClipboardItem::new_string(text));
                }
            }))
            .v_flex()
            .size_full()
            .min_w_0()
            .min_h_0()
            .overflow_hidden()
            .bg(ui::Surface::Sidebar.color(cx))
            .child(
                div()
                    .id("mission-context-scroll")
                    .test_support()
                    .overflow_y_scroll()
                    .track_scroll(&self.scroll)
                    .flex_1()
                    .min_h_0()
                    .min_w_0()
                    .child(content),
            )
    }
}
