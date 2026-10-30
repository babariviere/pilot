//! An archived chat shows a quiet notice with Restore in place of its composer.
//! The transcript stays readable. The editor entity, its drafts and queue are
//! kept unmounted, and return only once the chat list shows the chat open.
use super::*;
use crate::{chat_actions::Action, chat_actions_view::RestoreView};
use gpui_kit::StatefulInteractiveElement as _;

impl LocalViewer {
    /// The selected conversation's composer slot: its editor, or the archived notice.
    pub(super) fn composer_slot(
        &mut self,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) -> gpui_kit::AnyElement {
        let archived = self
            .selected
            .as_ref()
            .and_then(|id| self.state.chats.iter().find(|c| &c.id == id))
            .filter(|c| c.archived && !c.local_draft)
            .map(|c| c.id.clone());
        if self
            .chat_actions
            .update(cx, |a, _| a.show_inline(archived.as_deref()))
        {
            self.chat_actions.update(cx, |_, cx| cx.notify());
        }
        match archived {
            Some(id) => {
                self.editor.update(cx, |e, cx| e.end_composition(w, cx));
                self.archived_notice(id, cx)
            }
            None => {
                self.focus_restored_composer(w, cx);
                self.attention_composer(w, cx)
            }
        }
    }
    /// After a confirmed restore, the returning composer takes focus, unless the
    /// user already moved it somewhere other than the notice.
    fn focus_restored_composer(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        let Some(id) = self.selected.clone() else {
            return;
        };
        if !self
            .chat_actions
            .update(cx, |a, _| a.take_restore_focus(&id))
        {
            return;
        }
        let notice = self.chat_actions.read(cx).restore.notice_focus.clone();
        let unclaimed = w.focused(cx).is_none_or(|f| f == self.root_focus)
            || notice.is_some_and(|n| n.contains_focused(w, cx));
        if unclaimed {
            cx.defer_in(w, move |v, w, cx| {
                if v.selected.as_ref() == Some(&id) {
                    v.editor.update(cx, |e, cx| e.focus(w, cx));
                }
            });
        }
    }
    fn archived_notice(&mut self, id: String, cx: &mut Context<Self>) -> gpui_kit::AnyElement {
        use crate::ui::{Space, Text, Tone, text};
        let view = self.chat_actions.read(cx).restore_view(&id);
        let focus = self.chat_actions.update(cx, |a, cx| {
            a.restore
                .notice_focus
                .get_or_insert_with(|| cx.focus_handle())
                .clone()
        });
        let (detail, tone) = match view {
            RestoreView::Ready => (
                "Restore it to send messages. History and workspace are kept.",
                Tone::Quiet,
            ),
            RestoreView::Busy => ("Waiting for Local.", Tone::Quiet),
            RestoreView::Restored => ("Restored. Waiting for this chat to update.", Tone::Quiet),
            RestoreView::Failed(crate::chat_actions::CHANGED | crate::chat_actions::INELIGIBLE) => {
                (
                    "This chat changed elsewhere. Nothing was submitted.",
                    Tone::Error,
                )
            }
            RestoreView::Failed(error) => (error, Tone::Error),
            RestoreView::Blocked(reason) => (reason, Tone::Warning),
        };
        let label = match view {
            RestoreView::Busy => "Restoring…",
            RestoreView::Restored => "Restored",
            _ => "Restore",
        };
        let offered = matches!(view, RestoreView::Ready | RestoreView::Failed(_));
        let restore = crate::ui::action("archived-restore", label, crate::ui::Action::Secondary)
            .flex_none()
            .loading(view == RestoreView::Busy)
            .disabled(!offered)
            .tooltip("Restore this chat to send messages again")
            .on_click(cx.listener(move |v, _, w, cx| v.restore_archived(&id, w, cx)));
        // The composer's shell inset and tray surface, at notice height.
        div()
            .id("archived-composer")
            .test_support()
            .track_focus(&focus)
            .mx_3()
            .mb_3()
            .mt(px(6.))
            .child(
                div()
                    .h_flex()
                    .items_center()
                    .gap(px(Space::SIDEBAR))
                    .min_w_0()
                    .px_3()
                    .py_2()
                    .bg(crate::appearance::tray(cx))
                    .rounded(px(crate::appearance::Radius::TRAY))
                    .border_1()
                    .border_color(cx.theme().border)
                    .child(
                        div()
                            .v_flex()
                            .flex_1()
                            .min_w_0()
                            .gap(px(Space::META))
                            .child(
                                text(Text::Body, "This chat is archived")
                                    .id("archived-title")
                                    .test_support()
                                    .aria_label("This chat is archived")
                                    .font_medium(),
                            )
                            .child(
                                text(Text::Caption, detail)
                                    .id("archived-detail")
                                    .test_support()
                                    .aria_label(detail)
                                    .text_color(tone.color(cx)),
                            ),
                    )
                    .child(restore),
            )
            .into_any_element()
    }
    /// Restores exactly the archived chat this notice shows: one eligibility read,
    /// then the shared non-replayable request. Never automatic, never repeated.
    fn restore_archived(&mut self, id: &str, w: &mut Window, cx: &mut Context<Self>) {
        let Some(chat) = self
            .selected
            .as_deref()
            .filter(|selected| *selected == id)
            .and_then(|id| self.state.chats.iter().find(|c| c.id == id))
            .filter(|c| c.archived && !c.local_draft)
            .cloned()
        else {
            return;
        };
        let Some(target) = self.chat_actions.read(cx).target(chat) else {
            return self.restore_failed(id, "Chat actions aren't available right now.", cx);
        };
        if !self.chat_action_ready(&target, w, cx) {
            return self.restore_failed(
                id,
                "This chat changed or Local is unavailable. Nothing was submitted.",
                cx,
            );
        }
        // Typed text is captured first; an unfinished composition refuses.
        if !self.editor.update(cx, |e, cx| e.capture_navigation(w, cx)) {
            return self.restore_failed(id, "Finish typing first. Nothing was submitted.", cx);
        }
        let Some(token) = self
            .chat_actions
            .update(cx, |a, _| a.begin_restore_check(id))
        else {
            return;
        };
        let known_ack = self.chat_actions.read(cx).inspection_ack(id);
        let rx = self
            .chat_actions
            .read(cx)
            .worker
            .as_ref()
            .ok_or("Chat actions aren't available right now.")
            .and_then(|worker| worker.inspect(target));
        let rx = match rx {
            Ok(rx) => rx,
            Err(error) => {
                self.chat_actions
                    .update(cx, |a, _| a.end_restore_check(token, id));
                return self.restore_failed(id, error, cx);
            }
        };
        self.chat_actions.update(cx, |_, cx| cx.notify());
        cx.notify();
        let id = id.to_owned();
        cx.spawn_in(w, async move |v, cx| {
            let result = rx
                .recv()
                .await
                .unwrap_or(Err("Chat actions aren't available right now."));
            let _ = v.update_in(cx, |v, w, cx| {
                v.restore_inspected(token, &id, known_ack, result, w, cx)
            });
        })
        .detach();
    }
    fn restore_inspected(
        &mut self,
        token: u64,
        id: &str,
        known_ack: Option<u64>,
        result: Result<crate::chat_actions::Evidence, crate::chat_actions::Failure>,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self
            .chat_actions
            .update(cx, |a, _| a.end_restore_check(token, id))
        {
            return;
        }
        cx.notify();
        let evidence = match result {
            Ok(evidence) => evidence,
            Err(error) => return self.restore_failed(id, error, cx),
        };
        self.chat_actions
            .update(cx, |a, _| a.inspected(&evidence, known_ack));
        // Navigating away abandons the request before anything was submitted.
        if self.selected.as_deref() != Some(id) {
            return;
        }
        let refused = if evidence.archive {
            Some("This chat isn't archived anymore. Nothing was submitted.")
        } else if !evidence.can_archive {
            Some("This chat's retained history is read-only and can't be restored.")
        } else if !self.chat_action_ready(&evidence.target, w, cx) {
            Some("This chat changed or Local is unavailable. Nothing was submitted.")
        } else {
            None
        };
        if let Some(error) = refused {
            return self.restore_failed(id, error, cx);
        }
        self.chat_actions
            .update(cx, |a, cx| a.submit(evidence, Action::Archive, w, cx));
        self.sync_chat_action_permission(cx);
    }
    fn restore_failed(
        &mut self,
        id: &str,
        error: crate::chat_actions::Failure,
        cx: &mut Context<Self>,
    ) {
        self.chat_actions.update(cx, |a, cx| {
            a.restore_failed(id, error);
            cx.notify();
        });
        cx.notify();
    }
}
