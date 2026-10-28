//! Overview at a glance: progress, what needs the user and what is working.
//! Rows open an exact member chat or reveal an exact task in the Tasks pane.
use super::*;
use crate::{
    app_icon::AppIcon,
    mission_browser::{Detail, Summary, Task as Row},
};
use gpui_kit::AnyElement;

/// Rows a section shows before its Show all action, as in Swift's Overview.
pub(crate) const SECTION_ROWS: usize = 5;

impl Browser {
    pub(super) fn project_label(&self, id: &str) -> String {
        self.projects
            .iter()
            .find(|p| p.id == id)
            .map(|p| p.name.clone())
            .unwrap_or_else(|| "Project unavailable".into())
    }
    /// "Active · Project · 3 of 8 done · 2 working now", IDs left to copy.
    pub(crate) fn meta_line(&self, d: &Detail) -> String {
        let s = &d.summary;
        let progress = if s.total() == 0 {
            "No tasks yet".to_owned()
        } else if s.working.is_empty() {
            format!("{} of {} done", s.done(), s.total())
        } else {
            format!(
                "{} of {} done · {} working now",
                s.done(),
                s.total(),
                s.working.len()
            )
        };
        format!(
            "{} · {} · {progress}",
            capitalized(&d.status),
            self.project_label(&d.project)
        )
    }
    /// Member chats in the Local list that need the user, in list order.
    pub(super) fn needy_chats(&self, d: &Detail) -> Vec<&Chat> {
        let Ok(m) = &self.members else {
            return Vec::new();
        };
        self.chats
            .iter()
            .filter(|c| {
                m.ids.contains(&c.id)
                    && !c.archived
                    && !c.local_draft
                    && c.project_id.as_deref() == Some(d.project.as_str())
                    && (c
                        .attention
                        .as_ref()
                        .is_some_and(|a| a.kind != crate::attention::Kind::Ready)
                        || matches!(
                            c.signal,
                            Some(crate::dither::Signal::NeedsYou | crate::dither::Signal::Failed)
                        ))
            })
            .collect()
    }
    fn can_reveal(&self, generation: u64, cx: &App) -> bool {
        self.current(generation) && self.tasks_browser.read(cx).state.key.is_some()
    }
    pub(super) fn reveal_task(
        &mut self,
        id: Option<String>,
        generation: u64,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.can_reveal(generation, cx) || self.brief_marked(w, cx) {
            return;
        }
        self.tasks_browser.update(cx, |p, cx| p.reveal(id, w, cx));
        cx.notify();
    }
    pub(super) fn summary_view(&self, s: &Summary, cx: &Context<Self>) -> Option<AnyElement> {
        if s.total() == 0 {
            return None;
        }
        let mut track = cx.theme().muted_foreground;
        track.a *= 0.25;
        let entries: Vec<_> = s
            .counts
            .iter()
            .map(|(status, n)| {
                let (label, fill, color) = ui::task_status(status, cx);
                (label, fill, color, *n, *status)
            })
            .collect();
        // To do and delegated leave the track showing, as in the Tasks list.
        let bar: Vec<_> = entries
            .iter()
            .filter(|e| (e.1 > 0. && e.4 != "delegated") || e.4 == "blocked")
            .map(|e| (e.3, e.2))
            .collect();
        Some(
            div()
                .id("mission-progress")
                .test_support()
                .v_flex()
                .gap_2()
                .w_full()
                .max_w(px(360.))
                .child(ui::progress_bar(&bar, s.total(), track))
                .child(
                    div()
                        .h_flex()
                        .flex_wrap()
                        .gap_3()
                        .text_size(px(crate::appearance::TextRole::CAPTION))
                        .text_color(cx.theme().muted_foreground)
                        .children(entries.iter().map(|(label, _, color, n, _)| {
                            div()
                                .h_flex()
                                .items_center()
                                .gap_1()
                                .child(div().size(px(6.)).rounded_full().bg(*color))
                                .child(SharedString::from(format!("{n} {}", label.to_lowercase())))
                        })),
                )
                .into_any_element(),
        )
    }
    fn section_header(
        &self,
        id: &'static str,
        title: &'static str,
        all: bool,
        cx: &Context<Self>,
    ) -> impl IntoElement {
        let generation = self.generation;
        div()
            .h_flex()
            .items_center()
            .gap_2()
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .child(ui::heading(id, title, Text::Headline)),
            )
            .when(all, |row| {
                row.child(
                    ui::action(
                        SharedString::from(format!("{id}-all")),
                        "All tasks",
                        Action::Quiet,
                    )
                    .disabled(!self.can_reveal(generation, cx))
                    .on_click(
                        cx.listener(move |v, _, w, cx| v.reveal_task(None, generation, w, cx)),
                    ),
                )
            })
    }
    /// One line: status pie, number and title. The owner chat stays a sibling
    /// action, never nested inside the row's own button.
    fn task_row(&self, section: &str, t: &Row, cx: &Context<Self>) -> AnyElement {
        let generation = self.generation;
        let (label, fill, color) = ui::task_status(&t.work_status, cx);
        let id = t.id.clone();
        let mut row = div()
            .h_flex()
            .w_full()
            .min_w_0()
            .items_center()
            .gap_1()
            .child(
                ui::action(
                    SharedString::from(format!("mission-{section}-{}", t.id)),
                    "",
                    Action::Quiet,
                )
                .flex_1()
                .min_w_0()
                .justify_start()
                .accessibility_label(SharedString::from(format!(
                    "#{} {}, {}. Show in Tasks",
                    t.number, t.title, label
                )))
                .disabled(!self.can_reveal(generation, cx))
                .child(
                    div()
                        .h_flex()
                        .w_full()
                        .min_w_0()
                        .items_center()
                        .gap(px(Space::CONTROL))
                        .child(ui::status_pie(fill, color))
                        .child(
                            ui::text(Text::Caption, SharedString::from(format!("#{}", t.number)))
                                .flex_none()
                                .text_color(cx.theme().muted_foreground),
                        )
                        .child(
                            ui::text(Text::Body, SharedString::from(t.title.clone()))
                                .flex_1()
                                .min_w_0()
                                .text_left()
                                .truncate(),
                        ),
                )
                .on_click(cx.listener(move |v, _, w, cx| {
                    v.reveal_task(Some(id.clone()), generation, w, cx)
                })),
            );
        if let Some(owner) = &t.owner
            && let Some(title) = self.chat_title(owner)
        {
            row = row.child(self.chat_link(
                SharedString::from(format!("mission-owner-{section}-{}", t.id)),
                owner,
                title,
                cx,
            ));
        }
        row.into_any_element()
    }
    fn chat_title(&self, id: &str) -> Option<String> {
        self.chats
            .iter()
            .find(|c| c.id == id && !c.local_draft)
            .map(|c| c.title.clone())
            .or_else(|| {
                self.members
                    .as_ref()
                    .ok()?
                    .rows
                    .iter()
                    .find(|m| m.id == id)
                    .map(|m| m.title.clone())
            })
    }
    /// Quiet trailing link to an exact member chat through the existing guard.
    fn chat_link(
        &self,
        element: SharedString,
        id: &str,
        title: String,
        cx: &Context<Self>,
    ) -> AnyElement {
        let generation = self.generation;
        let Some(key) = self.detail.as_ref().map(|d| d.key.clone()) else {
            return div().into_any_element();
        };
        let enabled = self.can_link(&key, id, generation);
        let chat = id.to_owned();
        ui::action(element, "", Action::Quiet)
            .flex_none()
            .max_w(gpui_kit::relative(0.4))
            .disabled(!enabled)
            .accessibility_label(SharedString::from(format!("Open chat {title}")))
            .tooltip(SharedString::from(if enabled {
                format!("Open {title}")
            } else {
                format!("{title} isn't available here")
            }))
            .child(
                div()
                    .h_flex()
                    .min_w_0()
                    .items_center()
                    .gap_1()
                    .text_color(cx.theme().muted_foreground)
                    .child(AppIcon::Chats.inline())
                    .child(
                        ui::text(Text::Caption, SharedString::from(title))
                            .min_w_0()
                            .truncate(),
                    ),
            )
            .on_click(cx.listener(move |v, _, _, cx| {
                if v.can_link(&key, &chat, generation) {
                    cx.emit(Event::Chat {
                        key: key.clone(),
                        id: chat.clone(),
                        generation,
                    });
                }
            }))
            .into_any_element()
    }
    fn more(&self, id: &'static str, label: String, cx: &Context<Self>) -> impl IntoElement {
        let generation = self.generation;
        ui::action(id, label, Action::Quiet)
            .self_start()
            .disabled(!self.can_reveal(generation, cx))
            .on_click(cx.listener(move |v, _, w, cx| v.reveal_task(None, generation, w, cx)))
    }
    /// Needs you, only when something does: member chats, then blocked tasks.
    pub(super) fn needs_you_view(&self, d: &Detail, cx: &Context<Self>) -> Option<AnyElement> {
        let chats = self.needy_chats(d);
        let blocked = &d.summary.blocked;
        if chats.is_empty() && blocked.is_empty() {
            return None;
        }
        let mut section = div()
            .id("mission-needs-you")
            .test_support()
            .v_flex()
            .w_full()
            .min_w_0()
            .gap_1()
            .child(self.section_header("mission-needs-heading", "Needs you", false, cx));
        for c in chats.iter().take(SECTION_ROWS) {
            section = section.child(self.needy_chat_row(d, c, cx));
        }
        for t in blocked.iter().take(SECTION_ROWS) {
            section = section.child(self.task_row("needs-task", t, cx));
        }
        if blocked.len() > SECTION_ROWS {
            section = section.child(self.more(
                "mission-needs-more",
                format!("Show all {} blocked", blocked.len()),
                cx,
            ));
        }
        Some(section.into_any_element())
    }
    fn needy_chat_row(&self, d: &Detail, c: &Chat, cx: &Context<Self>) -> AnyElement {
        let generation = self.generation;
        let key = d.key.clone();
        let id = c.id.clone();
        let reason = c.row_reason().map(capitalized).unwrap_or_default();
        ui::action(
            SharedString::from(format!("mission-needs-chat-{}", c.id)),
            "",
            Action::Quiet,
        )
        .w_full()
        .justify_start()
        .disabled(!self.can_link(&key, &id, generation))
        .accessibility_label(SharedString::from(format!(
            "{}, {reason}. Open chat",
            c.title
        )))
        .child(
            div()
                .h_flex()
                .w_full()
                .min_w_0()
                .items_center()
                .gap(px(Space::CONTROL))
                .child(AppIcon::Chats.inline())
                .child(
                    ui::text(Text::Body, SharedString::from(c.title.clone()))
                        .flex_1()
                        .min_w_0()
                        .text_left()
                        .truncate(),
                )
                .child(
                    ui::text(Text::Caption, SharedString::from(reason))
                        .flex_none()
                        .text_color(cx.theme().muted_foreground),
                ),
        )
        .on_click(cx.listener(move |v, _, _, cx| {
            if v.can_link(&key, &id, generation) {
                cx.emit(Event::Chat {
                    key: key.clone(),
                    id: id.clone(),
                    generation,
                });
            }
        }))
        .into_any_element()
    }
    /// Working now: in progress, then in review, each with its owner chat.
    pub(super) fn working_view(&self, s: &Summary, cx: &Context<Self>) -> Option<AnyElement> {
        if s.working.is_empty() {
            return None;
        }
        let mut section = div()
            .id("mission-working-now")
            .test_support()
            .v_flex()
            .w_full()
            .min_w_0()
            .gap_1()
            .child(self.section_header("mission-working-heading", "Working now", true, cx));
        for t in s.working.iter().take(SECTION_ROWS) {
            section = section.child(self.task_row("working-task", t, cx));
        }
        if s.working.len() > SECTION_ROWS {
            section = section.child(self.more(
                "mission-working-more",
                format!("Show all {} working now", s.working.len()),
                cx,
            ));
        }
        Some(section.into_any_element())
    }
}
