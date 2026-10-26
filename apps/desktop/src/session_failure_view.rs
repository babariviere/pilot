//! Contextual, read-only report. No retry, log reads or changes to composer authority.
use super::*;
use crate::{
    session_failure::Failure,
    ui::{self, Action, Text},
};
use gpui_kit::{AnyElement, ClipboardItem, StatefulInteractiveElement, base::SelectableText};
use std::hash::{Hash, Hasher};

impl LocalViewer {
    pub(super) fn selected_failure(&self) -> Option<&Failure> {
        if self.page != Page::Chat
            || self.artifacts_open
            || self.state.generation != self.generation
        {
            return None;
        }
        self.selected
            .as_ref()
            .and_then(|id| {
                self.state
                    .chats
                    .iter()
                    .find(|c| &c.id == id && !c.local_draft)
            })
            .and_then(|c| c.failure.as_ref())
    }
    pub(super) fn sync_session_failure(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if let Some(chat) = self
            .selected
            .as_ref()
            .and_then(|id| self.state.chats.iter().find(|c| &c.id == id))
            && self.state.generation == self.generation
        {
            self.session_failure_fence.observe(
                &chat.id,
                self.generation,
                self.state.failure_run_serial,
                chat.busy,
                chat.failure.as_ref(),
            );
        }
        if self.selected_failure().is_none() && self.session_failure_focus.contains_focused(w, cx) {
            self.focus_mission_chat_destination(w, cx);
        }
    }
    pub(super) fn session_failure_banner(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let failure = self.selected_failure()?.clone();
        let historical = self.session_failure_fence.historical(&failure);
        let disconnected =
            self.state.status != "Connected · Local" && !self.state.status.starts_with("Synthetic");
        let title = if historical {
            "Previously reported failure"
        } else if failure.startup {
            "Chat could not start"
        } else {
            "Last reported failure"
        };
        let provenance = format!(
            "{}{}{}",
            failure.source,
            if failure.at.is_none() {
                " · completion time not reported"
            } else {
                " · reported completion"
            },
            if disconnected {
                " · disconnected, retained report"
            } else if historical {
                " · not a current-run error"
            } else {
                ""
            }
        );
        let metadata = SharedString::from(format!(
            "Completion version (epoch ms): {}\nActive attempt from summary: {}. This is not a run ID.",
            failure
                .at
                .map(|n| n.to_string())
                .unwrap_or_else(|| "not reported".into()),
            failure.attempt.as_deref().unwrap_or("not reported")
        ));
        let mut hash = std::collections::hash_map::DefaultHasher::new();
        self.selected.hash(&mut hash);
        self.generation.hash(&mut hash);
        failure.hash(&mut hash);
        let tag = hash.finish();
        let chat = self.selected.clone();
        let generation = self.generation;
        let copy = failure.clone();
        Some(div().id("session-failure").test_support().v_flex().flex_none().min_w_0().w_full()
            .track_focus(&self.session_failure_focus).px_3().py_2().gap_1().border_b_1().border_color(cx.theme().border)
            // Capture before a sibling pointer can blur/commit composer IME preedit.
            .capture_any_mouse_down(cx.listener(|v, _, w, cx| {
                if !v.project_choices_ready(w, cx) { cx.stop_propagation(); }
            }))
            .child(div().h_flex().items_center().gap_2()
                .child(ui::text(Text::Label, title).text_color(if historical {cx.theme().muted_foreground} else {cx.theme().danger}).flex_1().min_w_0())
                .child(ui::action("session-failure-copy", "Copy reason", Action::Quiet).icon(AppIcon::Copy.asset())
                    .accessibility_label("Copy reported failure reason")
                    .on_click(cx.listener(move |v, _, w, cx| {
                        if v.project_choices_ready(w, cx) && v.selected == chat && v.generation == generation && v.selected_failure() == Some(&copy) {
                            let text = if copy.truncated { format!("{}\n[Display limit reached. Remaining reported text omitted.]", copy.reason) } else { copy.reason.clone() };
                            cx.write_to_clipboard(ClipboardItem::new_string(text));
                        }
                    }))))
            .child(ui::text(Text::Caption, SharedString::from(provenance)).id("session-failure-provenance").test_support().text_color(cx.theme().muted_foreground).tooltip(move |w, cx| {
                gpui_kit::component::tooltip::Tooltip::new(metadata.clone()).build(w, cx)
            }))
            .child(div().id(("session-failure-scroll", tag)).test_support().overflow_y_scroll().max_h_32().min_w_0().w_full()
                .on_mouse_down(gpui_kit::MouseButton::Left, cx.listener(|v, _, w, cx| v.session_failure_focus.focus(w, cx)))
                .child(div().id("session-failure-reason").test_support().w_full().min_w_0().text_size(px(appearance::TextRole::BODY))
                    .child(SelectableText::new(SharedString::from(format!("session-failure-text-{tag}")), SharedString::from(failure.reason.clone())))))
            .when(failure.reason.len() > 400 || failure.reason.lines().count() > 4, |d| d.child(ui::text(Text::Caption, "Scroll details to read more, or Copy reason.")))
            .when(failure.truncated, |d| d.child(ui::text(Text::Caption, "Display limit reached (8 KiB). Remaining reported text omitted; Copy includes this notice.")))
            .into_any_element())
    }
}
