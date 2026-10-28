//! Unsent local slots only. Delivery recovery keeps its separate semantics.
use super::*;
use gpui_kit::component::{
    WindowExt,
    dialog::{Cancel, Confirm, DialogFooter},
};

impl ChatEditor {
    /// A never-submitted new-chat slot, regardless of whether discard is admissible now.
    pub(crate) fn unsent_draft(&self, key: &str) -> bool {
        key.starts_with("new:")
            && self
                .cache
                .get(key)
                .is_some_and(|d| d.editable() && d.last.is_none() && d.answer.is_none())
    }

    pub(crate) fn draft_discard_ready(&self, key: &str) -> bool {
        self.ready()
            && self.discarding.is_none()
            && !self.pending.contains_key(key)
            && self.unsent_draft(key)
    }

    /// Why the row menu cannot discard this draft, or None when it can.
    pub(crate) fn draft_discard_blocked(&self, key: &str) -> Option<&'static str> {
        if self.draft_discard_ready(key) {
            return None;
        }
        let draft = self.cache.get(key);
        Some(
            if self.discarding.as_ref().is_some_and(|(k, ..)| k == key) {
                "Discarding…"
            } else if self.discarding.is_some() {
                "Another draft is being discarded."
            } else if draft.is_some_and(|d| d.created.is_some()) {
                "This draft already created a chat."
            } else if self.pending.contains_key(key)
                || draft.is_some_and(|d| d.pending.is_some() || d.last.is_some())
            {
                "Delivery started. Open the draft to recover it."
            } else if draft.is_some_and(|d| d.answer.is_some()) {
                "A question reply is kept with this draft."
            } else {
                "Drafts aren't available right now."
            },
        )
    }

    pub(crate) fn request_draft_discard(
        &mut self,
        key: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.capture_navigation(window, cx) || !self.draft_discard_ready(&key) {
            return;
        }
        let draft = &self.cache[&key];
        let revision = draft.revision;
        if draft.text.is_empty() && draft.recovered.is_empty() {
            self.confirm_draft_discard(&key, revision, window, cx);
            return;
        }
        // Identifies the draft when the dialog opens from a sidebar row.
        let preview = std::iter::once(draft.text.as_str())
            .chain(draft.recovered.iter().map(String::as_str))
            .flat_map(str::lines)
            .map(str::trim)
            .find(|line| !line.is_empty())
            .map(|line| {
                let mut short: String = line.chars().take(80).collect();
                if short.len() < line.len() {
                    short.push('…');
                }
                SharedString::from(short)
            });
        let owner = cx.weak_entity();
        window.open_dialog(cx, move |dialog, _, cx| {
            // Enter at the dialog root is inert. A focused footer button still takes
            // Enter (through its wrapper) and Space; Escape and Cancel close.
            let confirm = std::rc::Rc::new({
                let owner = owner.clone();
                let key = key.clone();
                move |w: &mut Window, cx: &mut gpui_kit::App| {
                    w.close_dialog(cx);
                    let _ =
                        owner.update(cx, |e, cx| e.confirm_draft_discard(&key, revision, w, cx));
                }
            });
            let on_enter = confirm.clone();
            crate::ui::dialog(dialog, cx)
                .title("Discard draft?")
                .close_button(false)
                .overlay_closable(false)
                .child(
                    div()
                        .v_flex()
                        .gap_2()
                        .min_w_0()
                        .when_some(preview.clone(), |d, preview| {
                            d.child(
                                crate::ui::text(crate::ui::Text::Caption, preview)
                                    .id("draft-discard-preview")
                                    .min_w_0()
                                    .truncate()
                                    .text_color(cx.theme().muted_foreground),
                            )
                        })
                        .child(crate::ui::text(
                            crate::ui::Text::Body,
                            "The unsent message will be deleted. This can't be undone.",
                        )),
                )
                .footer(
                    DialogFooter::new()
                        .child(
                            div()
                                .on_action(|_: &Confirm, w, cx| {
                                    w.dispatch_action(Box::new(Cancel), cx)
                                })
                                .child(
                                    crate::ui::action(
                                        "draft-discard-cancel",
                                        "Cancel",
                                        crate::ui::Action::Secondary,
                                    )
                                    .on_click(|_, w, cx| w.dispatch_action(Box::new(Cancel), cx)),
                                ),
                        )
                        .child(
                            div()
                                .on_action(move |_: &Confirm, w, cx| on_enter(w, cx))
                                .child(
                                    crate::ui::action(
                                        "draft-discard-confirm",
                                        "Discard draft",
                                        crate::ui::Action::Danger,
                                    )
                                    .on_click(move |_, w, cx| confirm(w, cx)),
                                ),
                        ),
                )
                .on_ok(|_, _, _| false)
        });
    }

    /// The open composer owns its own error; any other draft reports to navigation.
    fn report_draft_discard_error(
        &mut self,
        key: &str,
        error: &'static str,
        cx: &mut Context<Self>,
    ) {
        if self.selected.as_deref() == Some(key) {
            self.error = Some(error);
            cx.notify();
        } else {
            cx.emit(EditorEvent::DraftDiscardFailed {
                key: key.into(),
                error,
            });
        }
    }

    fn confirm_draft_discard(
        &mut self,
        key: &str,
        revision: u64,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        if !self.capture_navigation(window, cx) {
            return false;
        }
        if !self.draft_discard_ready(key) {
            self.report_draft_discard_error(key, "Draft can't be discarded right now.", cx);
            return false;
        }
        if self.cache[key].revision != revision {
            self.report_draft_discard_error(key, "Draft changed. Review it before discarding.", cx);
            return false;
        }
        self.next_request += 1;
        let request = self.next_request;
        if !self.client.as_ref().is_some_and(|c| {
            c.command(WriteCommand::DiscardNew {
                key: key.into(),
                revision,
                request,
            })
        }) {
            self.report_draft_discard_error(key, "Draft could not be discarded. Try again.", cx);
            return false;
        }
        if self.selected.as_deref() == Some(key) {
            self.error = None;
        }
        // Keep the row and payload until the existing durable transaction replies.
        // No more edits for this slot may enter the autosave mailbox meanwhile.
        self.discarding = Some((key.into(), revision, request));
        cx.notify();
        true
    }

    pub(super) fn accept_draft_discard(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some((key, revision, request)) = self.discarding.as_ref() else {
            return;
        };
        let Some((reply_key, reply_revision, reply_request, result)) = &self.state.discard else {
            return;
        };
        // Only this attempt's reply counts; a retained earlier refusal never does.
        if key != reply_key || revision != reply_revision || request != reply_request {
            return;
        }
        let result = *result;
        let key = key.clone();
        self.discarding = None;
        if let Err(error) = result {
            self.report_draft_discard_error(&key, error, cx);
            return;
        }
        self.cache.remove(&key);
        self.unsaved_local.remove(&key);
        let selected = self.selected.as_ref() == Some(&key);
        if selected {
            self.selected = None;
            self.browse_empty(window, cx);
        }
        cx.emit(EditorEvent::DraftDiscarded { selected });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui_kit::TestAppContext;
    use gpui_kit::test::TestWindowExt;

    #[gpui_kit::test]
    fn draft_discard_recovery_cannot_bypass_pending_or_failed_private_save(
        cx: &mut TestAppContext,
    ) {
        let (h, editor, commands) = crate::chat_editor::tests::setup(cx);
        cx.update_window(h, |_, w, cx| {
            editor.update(cx, |e, cx| {
                e.cache.insert(
                    "new:slot".into(),
                    Draft {
                        revision: 2,
                        text: "Keep unsent text".into(),
                        recovered: std::sync::Arc::new(vec!["Keep recovered text".into()]),
                        ..Default::default()
                    },
                );
                e.select("new:slot".into(), true, false, w, cx);
                assert!(e.confirm_draft_discard("new:slot", 2, w, cx));
                assert!(matches!(
                    commands.try_recv(),
                    Ok(WriteCommand::DiscardNew { .. })
                ));
            });
            w.render_frame(cx);
            w.click("composer-recovery", cx);
            w.render_frame(cx);
            assert_eq!(
                w.find("discard-draft").disabled(),
                Some(true),
                "recovery cannot fall back to legacy discard while deleting"
            );
            w.click("discard-draft", cx);
            assert!(commands.try_recv().is_err());
            editor.update(cx, |e, cx| {
                assert!(e.discarding.is_some());
                assert_eq!(e.cache["new:slot"].text, "Keep unsent text");
                assert_eq!(e.selected.as_deref(), Some("new:slot"));
                e.discarding = None;
                e.state.error = Some("Synthetic private-save failure");
                cx.notify();
            });
            w.render_frame(cx);
            assert_eq!(
                w.find("discard-draft").disabled(),
                Some(true),
                "failed storage never permits unconfirmed legacy removal"
            );
            w.click("discard-draft", cx);
            assert!(commands.try_recv().is_err());
            assert!(editor.read(cx).cache.contains_key("new:slot"));
        })
        .unwrap();
    }

    #[gpui_kit::test]
    fn draft_discard_fences_late_input_and_waits_for_exact_durable_reply(cx: &mut TestAppContext) {
        let (h, editor, commands) = crate::chat_editor::tests::setup(cx);
        cx.update_window(h, |_, w, cx| {
            editor.update(cx, |e, cx| {
                e.cache.insert("new:empty".into(), Draft { revision: 2, ..Default::default() });
                e.select("new:empty".into(), true, false, w, cx);
                e.request_draft_discard("new:empty".into(), w, cx);
                assert!(e.cache.contains_key("new:empty"), "queue admission is not durable removal");
                assert!(matches!(commands.try_recv(), Ok(WriteCommand::DiscardNew { key, revision: 2, .. }) if key == "new:empty"));
                let request = e.discarding.as_ref().unwrap().2;
                #[cfg(any(target_os = "macos", target_os = "linux"))]
                assert!(
                    !e.begin_update_checkpoint(1, w, cx),
                    "an update checkpoint never starts while a discard is in flight"
                );
                e.text.update(cx, |t, cx| t.set_value("late input callback", w, cx));
                e.changed(cx);
                assert_eq!(e.cache["new:empty"].revision, 2);
                assert!(e.cache["new:empty"].text.is_empty());
                // A pre-discard autosave snapshot is not an acknowledgment.
                let mut old = e.state.clone();
                let mut book = (**old.book.as_ref().unwrap()).clone();
                book.drafts.insert("new:empty".into(), e.cache["new:empty"].clone());
                old.book = Some(std::sync::Arc::new(book));
                e.accept(old.clone(), w, cx);
                assert!(e.cache.contains_key("new:empty"));
                old.discard = Some(("new:empty".into(), 1, request, Ok(())));
                e.accept(old.clone(), w, cx);
                assert!(e.discarding.is_some(), "wrong revision must not release fence");
                // Navigate away before the exact success. Another draft remains selected.
                e.new_draft(String::new(), w, cx);
                let other = e.selected.clone().unwrap();
                assert_ne!(other, "new:empty", "New chat never reuses a deleting slot");
                old.discard = Some(("new:empty".into(), 2, request, Ok(())));
                std::sync::Arc::make_mut(old.book.as_mut().unwrap()).drafts.remove("new:empty");
                e.accept(old, w, cx);
                assert!(!e.cache.contains_key("new:empty"));
                assert_eq!(e.selected.as_ref(), Some(&other));
                e.changed(cx);
                assert!(!e.cache.contains_key("new:empty"));
            });
        }).unwrap();
    }

    #[gpui_kit::test]
    fn draft_discard_failure_retains_payload_and_restores_editing(cx: &mut TestAppContext) {
        let (h, editor, commands) = crate::chat_editor::tests::setup(cx);
        cx.update_window(h, |_, w, cx| {
            editor.update(cx, |e, cx| {
                e.cache.insert(
                    "new:slot".into(),
                    Draft {
                        revision: 4,
                        text: "Keep content".into(),
                        ..Default::default()
                    },
                );
                e.select("new:slot".into(), true, false, w, cx);
                assert!(e.confirm_draft_discard("new:slot", 4, w, cx));
                assert!(matches!(
                    commands.try_recv(),
                    Ok(WriteCommand::DiscardNew { .. })
                ));
                let request = e.discarding.as_ref().unwrap().2;
                let mut state = e.state.clone();
                state.discard = Some((
                    "new:slot".into(),
                    4,
                    request,
                    Err("Synthetic durable write failure"),
                ));
                e.accept(state, w, cx);
                assert!(e.discarding.is_none());
                assert_eq!(e.cache["new:slot"].text, "Keep content");
                assert_eq!(e.error, Some("Synthetic durable write failure"));
                e.text
                    .update(cx, |t, cx| t.set_value("Edit after refusal", w, cx));
                e.changed(cx);
                assert_eq!(e.cache["new:slot"].text, "Edit after refusal");
            });
        })
        .unwrap();
    }

    #[gpui_kit::test]
    fn draft_discard_retry_ignores_retained_refusal_until_exact_success(cx: &mut TestAppContext) {
        let (h, editor, commands) = crate::chat_editor::tests::setup(cx);
        cx.update_window(h, |_, w, cx| {
            editor.update(cx, |e, cx| {
                e.cache.insert(
                    "new:slot".into(),
                    Draft {
                        revision: 4,
                        text: "Keep content".into(),
                        ..Default::default()
                    },
                );
                e.select("new:slot".into(), true, false, w, cx);
                assert!(e.confirm_draft_discard("new:slot", 4, w, cx));
                let first = e.discarding.as_ref().unwrap().2;
                assert!(matches!(commands.try_recv(), Ok(WriteCommand::DiscardNew { request, .. }) if request == first));
                let mut refused = e.state.clone();
                refused.discard = Some(("new:slot".into(), 4, first, Err("Synthetic refusal")));
                e.accept(refused.clone(), w, cx);
                assert!(e.discarding.is_none());
                assert_eq!(e.error, Some("Synthetic refusal"));
                // Retry the same key and revision before any edit.
                assert!(e.confirm_draft_discard("new:slot", 4, w, cx));
                let second = e.discarding.as_ref().unwrap().2;
                assert_ne!(first, second);
                assert!(matches!(commands.try_recv(), Ok(WriteCommand::DiscardNew { request, revision: 4, .. }) if request == second));
                assert_eq!(e.error, None, "a queued retry clears the earlier refusal");
                // The worker retains the earlier refusal; it must not release the new attempt.
                e.accept(refused.clone(), w, cx);
                assert_eq!(e.discarding.as_ref().map(|d| d.2), Some(second));
                assert_eq!(e.cache["new:slot"].text, "Keep content");
                assert_eq!(e.error, None);
                let mut done = refused;
                done.discard = Some(("new:slot".into(), 4, second, Ok(())));
                std::sync::Arc::make_mut(done.book.as_mut().unwrap())
                    .drafts
                    .remove("new:slot");
                e.accept(done, w, cx);
                assert!(e.discarding.is_none());
                assert!(!e.cache.contains_key("new:slot"));
                assert!(e.selected.is_none());
            });
        })
        .unwrap();
    }
}
