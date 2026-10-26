//! Explicit, read-only activity page. No timers, transcript reads or mutations.
use crate::{
    LocalOptions,
    mission_activity::{ROW_CAP, Timeline},
    mission_activity_reader::{Reader, Request, Response},
    mission_browser::Key,
    ui::{self, Action, Notice, Space, Text, Tone},
};
use gpui_kit::{
    App, ClipboardItem, Context, EventEmitter, FocusHandle, InteractiveElement, IntoElement,
    ParentElement, Render, SharedString, StatefulInteractiveElement, Styled, Task, TestSupportExt,
    Window,
    base::SelectableText,
    component::{ActiveTheme, Disableable, StyledExt},
    div, px,
};
use std::collections::HashSet;

pub(crate) struct Close;
pub(crate) struct Activity {
    pub(crate) state: Timeline,
    options: Option<LocalOptions>,
    reader: Option<Reader>,
    updates: Option<Task<()>>,
    expanded: HashSet<u64>,
    pub(crate) scroll: gpui_kit::ScrollHandle,
    focus: FocusHandle,
    scope_open: bool,
    title: String,
}
impl EventEmitter<Close> for Activity {}
fn relative_time(at: u64) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    if u128::from(at) > now {
        return "Future timestamp".into();
    }
    let seconds = (now - u128::from(at)) / 1000;
    match seconds {
        0..60 => "Just now".into(),
        60..3600 => format!("{}m ago", seconds / 60),
        3600..86400 => format!("{}h ago", seconds / 3600),
        _ => format!("{}d ago", seconds / 86400),
    }
}
impl Activity {
    pub(crate) fn new(cx: &mut Context<Self>) -> Self {
        Self {
            state: Timeline::default(),
            options: None,
            reader: None,
            updates: None,
            expanded: HashSet::new(),
            scroll: Default::default(),
            focus: cx.focus_handle(),
            scope_open: false,
            title: String::new(),
        }
    }
    pub(crate) fn focus(&self, w: &mut Window, cx: &mut App) {
        self.focus.focus(w, cx);
    }
    pub(crate) fn focus_handle(&self) -> FocusHandle {
        self.focus.clone()
    }
    pub(crate) fn hide(&mut self, cx: &mut Context<Self>) {
        self.reader = None;
        self.updates = None;
        self.state.select(None);
        self.expanded.clear();
        cx.notify();
    }
    pub(crate) fn open(
        &mut self,
        key: Key,
        title: String,
        options: LocalOptions,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.hide(cx);
        self.options = Some(options);
        self.title = title;
        self.scope_open = false;
        self.state.select(Some(key));
        self.scroll.set_offset(gpui_kit::point(px(0.), px(0.)));
        self.focus(w, cx);
        self.load(false, w, cx);
    }
    fn load(&mut self, earlier: bool, w: &mut Window, cx: &mut Context<Self>) {
        let Some((generation, key, before)) = self.state.begin(earlier) else {
            return;
        };
        if self.reader.is_none() {
            let started = self
                .options
                .clone()
                .ok_or("Local activity source unavailable.")
                .and_then(Reader::start);
            match started {
                Err(e) => {
                    self.state.accept(generation, &key, before, Err(e));
                    cx.notify();
                    return;
                }
                Ok((reader, output)) => {
                    self.reader = Some(reader);
                    self.updates = Some(cx.spawn_in(w, async move |view, cx| {
                        while let Ok(response) = output.recv().await {
                            if view.update(cx, |v, cx| v.accept(response, cx)).is_err() { return; }
                        }
                        let _ = view.update(cx, |v, cx| {
                            v.reader = None;
                            v.state.pending = None;
                            v.state.error = Some("Activity reader stopped. Retained events are a snapshot; Refresh to retry.");
                            v.state.stale = v.state.loaded;
                            cx.notify();
                        });
                    }));
                }
            }
        }
        if !self.reader.as_ref().is_some_and(|r| {
            r.request(Request {
                generation,
                target: Some((key.clone(), before)),
            })
        }) {
            self.state.accept(
                generation,
                &key,
                before,
                Err("Activity request could not be queued. Refresh to retry."),
            );
        }
        cx.notify();
    }
    pub(crate) fn accept(&mut self, response: Response, cx: &mut Context<Self>) {
        if self.state.accept(
            response.generation,
            &response.key,
            response.before,
            response.result,
        ) {
            self.expanded
                .retain(|id| self.state.rows.iter().any(|e| e.id == *id));
            cx.notify();
        }
    }
}
impl Render for Activity {
    fn render(&mut self, w: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let busy = self.state.pending.is_some();
        let generation = self.state.generation;
        let mut content = ui::page()
            .gap(px(Space::SIDEBAR))
            .child(
                div()
                    .h_flex()
                    .w_full()
                    .justify_between()
                    .items_center()
                    .child(
                        ui::action("activity-overview", "Back to mission", Action::Quiet)
                            .on_click(cx.listener(|_, _, _, cx| cx.emit(Close))),
                    )
                    .child(
                        ui::action("activity-refresh", "Refresh", Action::Secondary)
                            .disabled(busy)
                            .on_click(cx.listener(|v, _, w, cx| v.load(false, w, cx))),
                    ),
            )
            .child(
                div()
                    .v_flex()
                    .gap(px(Space::META))
                    .child(ui::heading("activity-heading", "Activity", Text::Title))
                    .child(
                        ui::text(Text::Body, SharedString::from(self.title.clone()))
                            .text_color(cx.theme().muted_foreground),
                    ),
            )
            .child(
                div()
                    .v_flex()
                    .gap(px(Space::META))
                    .child(
                        ui::text(
                            Text::Caption,
                            SharedString::from(format!(
                                "{} events loaded · Local snapshot, newest first",
                                self.state.rows.len()
                            )),
                        )
                        .text_color(cx.theme().muted_foreground),
                    )
                    .child(
                        ui::action(
                            "activity-scope",
                            if self.scope_open {
                                "Hide source and limits"
                            } else {
                                "Source and viewing limits"
                            },
                            Action::Quiet,
                        )
                        .self_start()
                        .on_click(cx.listener(|v, _, _, cx| {
                            v.scope_open = !v.scope_open;
                            cx.notify();
                        })),
                    ),
            );
        if self.scope_open {
            if let Some(key) = &self.state.key {
                content = content.child(ui::text(
                    Text::Caption,
                    SharedString::from(format!(
                        "Mission {} · Local home {} / {}",
                        key.id, key.home.daemon, key.home.lineage
                    )),
                ));
            }
            content = content.child(ui::text(Text::Caption, "Up to 250 events per view, 50 per request, 2 MiB per response, 32 KiB per event text. Refresh replaces this window. No automatic updates."))
            .child(ui::text(Text::Caption, "Source is recorded chat ID, not proof of authorship. Without a chat ID, the API cannot distinguish user from system. No conversation or reasoning is loaded."));
        }
        if busy {
            content = content.child(Notice::new(if self.state.pending == Some(None) {
                "Loading newest activity…"
            } else {
                "Loading earlier activity…"
            }));
        }
        if let Some(error) = self.state.error {
            content = content.child(Notice::new(error).tone(Tone::Error)).child(
                ui::action("activity-retry", "Retry read", Action::Secondary)
                    .self_start()
                    .disabled(busy)
                    .on_click(
                        cx.listener(|v, _, w, cx| v.load(v.state.loaded && !v.state.stale, w, cx)),
                    ),
            );
        }
        if self.state.stale {
            content = content.child(
                Notice::new("Retained activity is not a fresh snapshot. Refresh explicitly.")
                    .tone(Tone::Warning),
            );
        }
        if self.state.loaded && self.state.rows.is_empty() && !busy && self.state.error.is_none() {
            content = content.child(Notice::new("No activity in the received snapshot."));
        }
        content = content.child(ui::rule(w, cx));
        for e in &self.state.rows {
            let id = e.id;
            let expanded = self.expanded.contains(&id);
            let focus = self.focus.clone();
            let hover_group = SharedString::from(format!("activity-card-{id}"));
            let mut row = div()
                .id(SharedString::from(format!("activity-event-{id}")))
                .test_support()
                .group(hover_group.clone())
                .v_flex()
                .w_full()
                .min_w_0()
                .gap(px(Space::CONTROL))
                .p(px(Space::SIDEBAR))
                .rounded(px(ui::Radius::ROW))
                .bg(ui::Surface::Tray.color(cx))
                .border_1()
                .border_color(cx.theme().border)
                .child(
                    div()
                        .h_flex()
                        .justify_between()
                        .gap(px(Space::CONTROL))
                        .child(ui::text(Text::Body, e.heading()).font_semibold())
                        .child(
                            div()
                                .h_flex()
                                .items_center()
                                .gap(px(Space::CONTROL))
                                .child(
                                    ui::text(
                                        Text::Caption,
                                        SharedString::from(relative_time(e.at)),
                                    )
                                    .text_color(cx.theme().muted_foreground),
                                )
                                .child(
                                    ui::icon_action(
                                        SharedString::from(format!("activity-copy-{id}")),
                                        "Copy event text",
                                        ui::IconRole::Copy,
                                        Action::Quiet,
                                    )
                                    .opacity(0.)
                                    .group_hover(hover_group, |style| style.opacity(1.))
                                    .focus_visible(|style| style.opacity(1.))
                                    .on_click(cx.listener(
                                        move |v, _, _, cx| {
                                            if v.state.generation == generation
                                                && let Some(e) =
                                                    v.state.rows.iter().find(|e| e.id == id)
                                            {
                                                cx.write_to_clipboard(ClipboardItem::new_string(
                                                    e.text.clone(),
                                                ));
                                            }
                                        },
                                    )),
                                ),
                        ),
                )
                .child(
                    ui::text(Text::Caption, SharedString::from(e.source()))
                        .text_color(cx.theme().muted_foreground),
                )
                .children(
                    (!expanded)
                        .then(|| ui::text(Text::Body, SharedString::from(e.preview.clone()))),
                )
                .child(
                    ui::action(
                        SharedString::from(format!("activity-expand-{id}")),
                        if expanded {
                            "Hide details"
                        } else {
                            "Show details"
                        },
                        Action::Secondary,
                    )
                    .self_start()
                    .on_click(cx.listener(move |v, _, _, cx| {
                        if v.state.generation != generation {
                            return;
                        }
                        if !v.expanded.remove(&id) {
                            v.expanded.insert(id);
                        }
                        cx.notify();
                    })),
                );
            if expanded {
                row = row
                    .child(ui::rule(w, cx))
                    .child(
                        ui::text(
                            Text::Caption,
                            SharedString::from(format!(
                                "Event {} · kind {} · {} ms since Unix epoch{}{}",
                                e.id,
                                e.kind,
                                e.at,
                                e.task
                                    .as_ref()
                                    .map(|t| format!(" · task {t}"))
                                    .unwrap_or_default(),
                                e.health
                                    .as_ref()
                                    .map(|h| format!(" · health {h}"))
                                    .unwrap_or_default()
                            )),
                        )
                        .text_color(cx.theme().muted_foreground),
                    )
                    .child(
                        div()
                            .id(SharedString::from(format!("activity-detail-{id}")))
                            .test_support()
                            .w_full()
                            .min_w_0()
                            .on_mouse_down(gpui_kit::MouseButton::Left, move |_, w, cx| {
                                focus.focus(w, cx)
                            })
                            .child(SelectableText::new(
                                SharedString::from(format!(
                                    "activity-text-{}-{id}",
                                    self.state.key.as_ref().unwrap().tag()
                                )),
                                SharedString::from(e.text.clone()),
                            )),
                    );
            }
            content = content.child(row);
        }
        if self.state.rows.len() >= ROW_CAP {
            content = content.child(Notice::new("250-event viewing limit reached. Earlier events may exist; Refresh returns to the newest window."));
        } else if self.state.exhausted {
            content = content.child(Notice::new("No earlier events returned at this snapshot. This is not a live completeness guarantee."));
        } else if self.state.loaded && !self.state.rows.is_empty() {
            content = content.child(
                ui::action(
                    "activity-earlier",
                    "Load earlier activity",
                    Action::Secondary,
                )
                .self_start()
                .disabled(busy || self.state.stale)
                .on_click(cx.listener(|v, _, w, cx| v.load(true, w, cx))),
            );
        }
        div()
            .id("mission-activity-page")
            .test_support()
            .track_focus(&self.focus)
            .size_full()
            .min_h_0()
            .min_w_0()
            .overflow_y_scroll()
            .track_scroll(&self.scroll)
            .on_action(cx.listener(|_, _: &gpui_kit::base::input::Copy, w, cx| {
                let text = gpui_kit::base::TextSelection::selected_text(w, cx);
                if text.is_empty() {
                    cx.propagate();
                } else {
                    cx.write_to_clipboard(ClipboardItem::new_string(text));
                }
            }))
            .child(content)
    }
}
