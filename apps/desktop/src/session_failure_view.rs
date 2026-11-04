//! Contextual report with one explicit Retry (`session_failure_retry.rs`).
//! No log reads, repairs or changes to composer authority.
use super::session_failure_retry::RetryOffer;
use super::*;
use crate::{
    chat_actions_view::RetryView,
    session_failure::Failure,
    ui::{self, Action, Text},
};
use gpui_kit::{AnyElement, ClipboardItem, StatefulInteractiveElement, base::SelectableText};
use std::hash::{Hash, Hasher};

/// Run setup again, as asked from the setup failure banner.
pub(super) struct SetupRerun {
    /// The chat and the failure detail it answers; a newer failure starts fresh.
    chat: String,
    detail: String,
    /// The eligibility read is in flight.
    checking: bool,
    /// A refusal before anything was submitted.
    error: Option<crate::chat_actions::Failure>,
}
const SETUP_HELP: &str = "Run this project's setup hooks again in this chat's workspace";

impl LocalViewer {
    pub(super) fn workspace_setup_banner(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        if self.page != Page::Chat
            || self.artifacts_open
            || self.state.generation != self.generation
        {
            return None;
        }
        let chat = self.selected.as_ref().and_then(|id| {
            self.state
                .chats
                .iter()
                .find(|chat| &chat.id == id && !chat.local_draft)
        })?;
        let detail = chat.setup_failure.as_ref()?;
        let actions = self.chat_actions.read(cx);
        let mine = self
            .setup_rerun
            .as_ref()
            .filter(|r| r.chat == chat.id && &r.detail == detail);
        let report = mine.and_then(|_| actions.setup_rerun(&chat.id));
        use crate::chat_actions::Outcome;
        let (busy, done, note) = match (mine, report) {
            (Some(r), _) if r.checking => (true, false, None),
            (Some(SetupRerun { error: Some(e), .. }), None) => {
                (false, false, Some((*e, ui::Tone::Error)))
            }
            (_, Some(None)) => (true, false, None),
            (_, Some(Some(Outcome::Rejected(e)))) => (false, false, Some((e, ui::Tone::Error))),
            // Never offered again for this failure: it may be running already.
            (_, Some(Some(Outcome::Unknown))) => (
                false,
                true,
                Some((crate::chat_actions_view::SETUP_UNKNOWN, ui::Tone::Warning)),
            ),
            (_, Some(Some(Outcome::Acknowledged))) => {
                (false, true, Some(("Setup started.", ui::Tone::Quiet)))
            }
            _ => (false, false, None),
        };
        let available = chat.writable && actions.options.is_some() && !actions.blocked(&chat.id);
        let rerun = ui::action(
            "workspace-setup-rerun",
            "Run setup again",
            Action::Secondary,
        )
        .icon(AppIcon::Retry.asset())
        .flex_none()
        .loading(busy)
        .disabled(busy || done || !available)
        .tooltip(SETUP_HELP)
        .on_click(cx.listener(|v, _, w, cx| {
            if v.project_choices_ready(w, cx) {
                v.rerun_setup(w, cx);
            }
        }));
        Some(
            div()
                .id("workspace-setup-failure")
                .test_support()
                .flex_none()
                .v_flex()
                .gap_1()
                .min_w_0()
                .w_full()
                .px_3()
                .py_2()
                .child(
                    div()
                        .h_flex()
                        .items_center()
                        .gap_2()
                        .min_w_0()
                        .child(
                            div().flex_1().min_w_0().child(
                                ui::Notice::new(SharedString::from(detail.clone()))
                                    .tone(ui::Tone::Error),
                            ),
                        )
                        .child(rerun),
                )
                .children(note.map(|(text, tone)| {
                    ui::text(Text::Caption, text)
                        .id("workspace-setup-rerun-note")
                        .test_support()
                        .text_color(tone.color(cx))
                }))
                .into_any_element(),
        )
    }
    /// One eligibility read, then the shared non-replayable chat action.
    fn rerun_setup(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        let Some(chat) = self
            .selected
            .as_ref()
            .and_then(|id| {
                self.state
                    .chats
                    .iter()
                    .find(|c| &c.id == id && !c.local_draft)
            })
            .cloned()
        else {
            return;
        };
        let Some(detail) = chat.setup_failure.clone() else {
            return;
        };
        if self.setup_rerun.as_ref().is_some_and(|r| r.checking)
            || self.chat_actions.read(cx).blocked(&chat.id)
        {
            return;
        }
        let id = chat.id.clone();
        let refuse = |v: &mut Self, error, cx: &mut Context<Self>| {
            v.setup_rerun = Some(SetupRerun {
                chat: id.clone(),
                detail: detail.clone(),
                checking: false,
                error: Some(error),
            });
            cx.notify();
        };
        let Some(target) = self.chat_actions.read(cx).target(chat) else {
            return refuse(self, "Chat actions aren't available right now.", cx);
        };
        if !self.chat_action_ready(&target, w, cx) {
            return refuse(
                self,
                "This chat changed or Local is unavailable. Nothing was started.",
                cx,
            );
        }
        let known_ack = self.chat_actions.read(cx).inspection_ack(&id);
        let rx = self
            .chat_actions
            .read(cx)
            .worker
            .as_ref()
            .ok_or("Chat actions aren't available right now.")
            .and_then(|worker| worker.inspect(target));
        let rx = match rx {
            Ok(rx) => rx,
            Err(error) => return refuse(self, error, cx),
        };
        self.setup_rerun = Some(SetupRerun {
            chat: id.clone(),
            detail: detail.clone(),
            checking: true,
            error: None,
        });
        cx.notify();
        let generation = self.generation;
        cx.spawn_in(w, async move |v, cx| {
            let result = rx
                .recv()
                .await
                .unwrap_or(Err("Chat actions aren't available right now."));
            let _ = v.update_in(cx, |v, w, cx| {
                let Some(r) = v
                    .setup_rerun
                    .as_mut()
                    .filter(|r| r.chat == id && r.detail == detail && r.checking)
                else {
                    return;
                };
                r.checking = false;
                cx.notify();
                let evidence = match result {
                    Ok(evidence) => evidence,
                    Err(error) => {
                        r.error = Some(error);
                        return;
                    }
                };
                v.chat_actions
                    .update(cx, |a, _| a.inspected(&evidence, known_ack));
                // Navigating away abandons the request before anything was submitted.
                if v.selected.as_deref() != Some(id.as_str()) || v.generation != generation {
                    return;
                }
                if !evidence.can_rerun_setup {
                    if let Some(r) = v.setup_rerun.as_mut() {
                        r.error = Some(
                            "Setup can run again only while this chat is idle. Nothing was started.",
                        );
                    }
                    return;
                }
                v.chat_row_action(evidence, crate::chat_actions::Action::RerunSetup, w, cx);
            });
        })
        .detach();
    }

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
        let failure = self.selected_failure().cloned();
        // This banner shows the selected chat's own retry status, not the sidebar.
        let inline = failure.as_ref().and(self.selected.as_deref());
        self.chat_actions.update(cx, |a, cx| {
            if a.show_retry_inline(inline) {
                cx.notify();
            }
        });
        let failure = failure?;
        let historical = self.session_failure_fence.historical(&failure);
        let disconnected =
            self.state.status != "Connected · Local" && !self.state.status.starts_with("Synthetic");
        let title = if historical {
            "Earlier failure"
        } else if failure.startup {
            "This chat couldn't start"
        } else {
            "This chat failed"
        };
        // Only say where the report came from when it may not be current.
        let provenance = if disconnected {
            Some("Last report before the connection dropped")
        } else if historical {
            Some("From an earlier run")
        } else {
            None
        };
        let metadata = SharedString::from(format!(
            "Source: {}\nReported at (epoch ms): {}\nAttempt: {}",
            failure.source,
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
        let retry = self.failure_retry(&failure, cx).map(|offer| {
            let (label, busy, offered, note) = match offer {
                RetryOffer::View(RetryView::Ready) => ("Retry", false, true, None),
                RetryOffer::View(RetryView::Busy) => ("Retrying…", true, false, None),
                RetryOffer::View(RetryView::Sent) => ("Retry sent", false, false, None),
                RetryOffer::View(RetryView::Failed(e)) => {
                    ("Retry", false, true, Some((e, ui::Tone::Error)))
                }
                RetryOffer::View(RetryView::Blocked(e)) => {
                    ("Retry", false, false, Some((e, ui::Tone::Warning)))
                }
                RetryOffer::Unavailable(e) => ("Retry", false, false, Some((e, ui::Tone::Quiet))),
            };
            let help = if failure.startup {
                "Start this chat again with its queued messages"
            } else {
                "Run the failed turn again in a new attempt"
            };
            let button = ui::action("session-failure-retry", label, Action::Secondary)
                .icon(AppIcon::Retry.asset())
                .flex_none()
                .loading(busy)
                .disabled(!offered)
                .tooltip(help)
                .on_click(cx.listener(|v, _, w, cx| {
                    if v.project_choices_ready(w, cx) {
                        v.retry_failure(w, cx);
                    }
                }));
            (button, note)
        });
        let (retry, note) = match retry {
            Some((button, note)) => (Some(button), note),
            None => (None, None),
        };
        Some(div().id("session-failure").test_support().v_flex().flex_none().min_w_0().w_full()
            .track_focus(&self.session_failure_focus).px_3().py_2().gap_1().border_b_1().border_color(cx.theme().border)
            // Capture before a sibling pointer can blur/commit composer IME preedit.
            .capture_any_mouse_down(cx.listener(|v, _, w, cx| {
                if !v.project_choices_ready(w, cx) { cx.stop_propagation(); }
            }))
            .child(div().h_flex().items_center().gap_2()
                .child(div().id("session-failure-title").flex_1().min_w_0()
                    .tooltip(move |w, cx| gpui_kit::component::tooltip::Tooltip::new(metadata.clone()).build(w, cx))
                    .child(ui::text(Text::Label, title).text_color(if historical {cx.theme().muted_foreground} else {cx.theme().danger})))
                .children(retry)
                .child(ui::action("session-failure-copy", "Copy reason", Action::Quiet).icon(AppIcon::Copy.asset())
                    .accessibility_label("Copy reported failure reason")
                    .on_click(cx.listener(move |v, _, w, cx| {
                        if v.project_choices_ready(w, cx) && v.selected == chat && v.generation == generation && v.selected_failure() == Some(&copy) {
                            let text = if copy.truncated { format!("{}\n[Display limit reached. Remaining reported text omitted.]", copy.reason) } else { copy.reason.clone() };
                            cx.write_to_clipboard(ClipboardItem::new_string(text));
                        }
                    }))))
            .children(provenance.map(|text| ui::text(Text::Caption, text).id("session-failure-provenance").test_support().text_color(cx.theme().muted_foreground)))
            .children(note.map(|(text, tone)| ui::text(Text::Caption, text).id("session-failure-retry-note").test_support()
                .aria_label(text).text_color(tone.color(cx))))
            .child(div().id(("session-failure-scroll", tag)).test_support().overflow_y_scroll().max_h_32().min_w_0().w_full()
                .on_mouse_down(gpui_kit::MouseButton::Left, cx.listener(|v, _, w, cx| v.session_failure_focus.focus(w, cx)))
                .child(div().id("session-failure-reason").test_support().w_full().min_w_0().text_size(px(appearance::TextRole::BODY))
                    .child(SelectableText::new(SharedString::from(format!("session-failure-text-{tag}")), SharedString::from(failure.reason.clone())))))
            .when(failure.truncated, |d| d.child(ui::text(Text::Caption, "Only the start of this long report is available.")))
            .into_any_element())
    }
}
