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
        if !self.send_draft_discard(key, revision, cx) {
            self.report_draft_discard_error(key, "Draft could not be discarded. Try again.", cx);
            return false;
        }
        true
    }

    fn send_draft_discard(&mut self, key: &str, revision: u64, cx: &mut Context<Self>) -> bool {
        self.next_request += 1;
        let request = self.next_request;
        if !self.client.as_ref().is_some_and(|c| {
            c.command(WriteCommand::DiscardNew {
                key: key.into(),
                revision,
                request,
            })
        }) {
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

    /// Navigation reports the new-chat slot it shows. A slot left while still empty is
    /// deleted through the same durable transaction; typed or recovered text stays.
    pub(crate) fn show_draft(
        &mut self,
        key: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.visible_draft == key {
            return;
        }
        if let Some(left) = std::mem::replace(&mut self.visible_draft, key) {
            self.leaving.insert(left);
        }
        if let Some(shown) = &self.visible_draft {
            self.leaving.remove(shown);
        }
        self.discard_left(window, cx);
    }

    /// An automatic deletion in flight. Its row is hidden so it cannot be reopened meanwhile.
    pub(super) fn removing_left(&self, key: &str) -> bool {
        self.leaving.contains(key) && self.discarding.as_ref().is_some_and(|(k, ..)| k == key)
    }

    fn left_empty(&self, key: &str) -> bool {
        self.visible_draft.as_deref() != Some(key)
            && self.unsent_draft(key)
            && !self.pending.contains_key(key)
            && !self.unsaved_local.contains(key)
            && self
                .cache
                .get(key)
                .is_some_and(|d| d.text.is_empty() && d.recovered.is_empty())
    }

    /// One deletion at a time; the rest wait for its exact reply. A slot that gained
    /// content is no longer a candidate, even if it is emptied again without being shown.
    pub(super) fn discard_left(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.leaving.is_empty() || self.discarding.is_some() || !self.ready() {
            return;
        }
        if !self.marked(window, cx) {
            self.changed(cx);
        }
        let candidates = std::mem::take(&mut self.leaving);
        self.leaving = candidates
            .into_iter()
            .filter(|key| self.left_empty(key))
            .collect();
        let Some(key) = self.leaving.first().cloned() else {
            return;
        };
        let revision = self.cache[&key].revision;
        if !self.send_draft_discard(&key, revision, cx) {
            // Not queued: the slot stays listed and stored. Leaving it again retries.
            self.leaving.remove(&key);
        }
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
        let automatic = self.leaving.remove(&key);
        if let Err(error) = result {
            if !automatic {
                self.report_draft_discard_error(&key, error, cx);
            } else if self.left_empty(&key) {
                // The slot is listed again. A newer revision kept on purpose needs no notice.
                cx.emit(EditorEvent::DraftDiscardFailed {
                    key,
                    error: "An empty draft couldn't be removed, so it was kept.",
                });
            }
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

    fn seed(
        e: &mut ChatEditor,
        drafts: &[(&str, Draft)],
        w: &mut Window,
        cx: &mut Context<ChatEditor>,
    ) {
        let mut state = e.state.clone();
        let book = std::sync::Arc::make_mut(state.book.as_mut().unwrap());
        for (key, draft) in drafts {
            book.drafts.insert((*key).into(), draft.clone());
        }
        e.accept(state, w, cx);
    }

    /// The worker's exact reply for the attempt in flight, removing the row on success.
    fn reply(
        e: &mut ChatEditor,
        result: Result<(), &'static str>,
        w: &mut Window,
        cx: &mut Context<ChatEditor>,
    ) {
        let (key, revision, request) = e.discarding.clone().unwrap();
        let mut state = e.state.clone();
        if result.is_ok() {
            std::sync::Arc::make_mut(state.book.as_mut().unwrap())
                .drafts
                .remove(&key);
        }
        state.discard = Some((key, revision, request, result));
        e.accept(state, w, cx);
    }

    fn discarded(commands: &async_channel::Receiver<WriteCommand>) -> Vec<(String, u64)> {
        std::iter::from_fn(|| commands.try_recv().ok())
            .filter_map(|c| match c {
                WriteCommand::DiscardNew { key, revision, .. } => Some((key, revision)),
                _ => None,
            })
            .collect()
    }

    #[gpui_kit::test]
    fn draft_discard_on_leave_removes_only_empty_slots_after_exact_reply(cx: &mut TestAppContext) {
        let (h, editor, commands) = crate::chat_editor::tests::setup(cx);
        cx.update_window(h, |_, w, cx| {
            editor.update(cx, |e, cx| {
                let text = |t: &str| Draft {
                    revision: 3,
                    text: t.into(),
                    ..Default::default()
                };
                seed(
                    e,
                    &[
                        (
                            "new:empty",
                            Draft {
                                revision: 2,
                                ..Default::default()
                            },
                        ),
                        ("new:text", text("Keep typed text")),
                        (
                            "new:recovered",
                            Draft {
                                revision: 1,
                                recovered: std::sync::Arc::new(vec!["Recovered".into()]),
                                ..Default::default()
                            },
                        ),
                        (
                            "new:other",
                            Draft {
                                revision: 1,
                                ..Default::default()
                            },
                        ),
                    ],
                    w,
                    cx,
                );
                for key in ["new:text", "new:recovered"] {
                    e.select(key.into(), true, false, w, cx);
                    e.show_draft(Some(key.into()), w, cx);
                }
                e.show_draft(None, w, cx);
                assert!(
                    discarded(&commands).is_empty(),
                    "text or recovered text is kept"
                );
                e.select("new:empty".into(), true, false, w, cx);
                e.show_draft(Some("new:empty".into()), w, cx);
                e.accept(e.state.clone(), w, cx);
                assert!(
                    discarded(&commands).is_empty(),
                    "the slot in use is never pruned"
                );
                // Home: the composer keeps the slot selected but no longer shows it.
                e.show_draft(None, w, cx);
                assert_eq!(discarded(&commands), [("new:empty".to_owned(), 2)]);
                assert!(e.cache.contains_key("new:empty"), "queued is not durable");
                assert!(
                    !e.has_navigation_draft("new:empty"),
                    "cannot be reopened meanwhile"
                );
                assert!(e.new_drafts().iter().all(|(k, _)| k != "new:empty"));
                e.new_draft(String::new(), w, cx);
                assert_eq!(
                    e.selected.as_deref(),
                    Some("new:other"),
                    "New chat skips it"
                );
                e.show_draft(Some("new:other".into()), w, cx);
                reply(e, Ok(()), w, cx);
                assert!(!e.cache.contains_key("new:empty"));
                assert_eq!(e.selected.as_deref(), Some("new:other"));
                for key in ["new:text", "new:recovered", "new:other"] {
                    assert!(e.has_navigation_draft(key), "{key} retained");
                }
                assert!(discarded(&commands).is_empty());
            });
        })
        .unwrap();
    }

    #[gpui_kit::test]
    fn draft_discard_on_leave_captures_cleared_text_and_fences_late_typing(
        cx: &mut TestAppContext,
    ) {
        let (h, editor, commands) = crate::chat_editor::tests::setup(cx);
        let failures = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
        let seen = failures.clone();
        let _subscription = cx.update(|cx| {
            cx.subscribe(&editor, move |_, event, _| {
                if let EditorEvent::DraftDiscardFailed { key, .. } = event {
                    seen.borrow_mut().push(key.clone());
                }
            })
        });
        cx.update_window(h, |_, w, cx| {
            editor.update(cx, |e, cx| {
                seed(
                    e,
                    &[(
                        "new:slot",
                        Draft {
                            revision: 5,
                            text: "Draft".into(),
                            ..Default::default()
                        },
                    )],
                    w,
                    cx,
                );
                e.select("new:slot".into(), true, false, w, cx);
                e.show_draft(Some("new:slot".into()), w, cx);
                e.text.update(cx, |t, cx| t.set_value("", w, cx));
                // Leaving captures the cleared text before deciding.
                e.show_draft(None, w, cx);
                assert_eq!(discarded(&commands), [("new:slot".to_owned(), 6)]);
                e.text.update(cx, |t, cx| t.set_value("late typing", w, cx));
                e.changed(cx);
                assert_eq!(
                    e.cache["new:slot"].revision, 6,
                    "no edit enters the mailbox"
                );
                // A refused attempt lists the slot again and says so honestly.
                reply(e, Err("Synthetic durable write failure"), w, cx);
                assert!(e.discarding.is_none());
                assert!(e.has_navigation_draft("new:slot"));
                assert!(
                    discarded(&commands).is_empty(),
                    "a refusal is not retried by itself"
                );
            });
        })
        .unwrap();
        assert_eq!(*failures.borrow(), ["new:slot".to_owned()]);
        cx.update_window(h, |_, w, cx| {
            editor.update(cx, |e, cx| {
                // Typing after capture: the store refuses the older revision and the newer
                // content is kept without a failure notice.
                e.show_draft(Some("new:slot".into()), w, cx);
                e.show_draft(None, w, cx);
                assert_eq!(discarded(&commands), [("new:slot".to_owned(), 6)]);
                let mut state = e.state.clone();
                std::sync::Arc::make_mut(state.book.as_mut().unwrap())
                    .drafts
                    .insert(
                        "new:slot".into(),
                        Draft {
                            revision: 7,
                            text: "Typed after capture".into(),
                            ..Default::default()
                        },
                    );
                e.accept(state, w, cx);
                reply(e, Err("Draft changed. Review it before discarding."), w, cx);
                assert_eq!(e.cache["new:slot"].text, "Typed after capture");
                assert!(e.has_navigation_draft("new:slot"));
            });
        })
        .unwrap();
        assert_eq!(failures.borrow().len(), 1);
    }

    #[gpui_kit::test]
    fn draft_discard_on_leave_runs_one_at_a_time_and_spares_revisited_slots(
        cx: &mut TestAppContext,
    ) {
        let (h, editor, commands) = crate::chat_editor::tests::setup(cx);
        cx.update_window(h, |_, w, cx| {
            editor.update(cx, |e, cx| {
                seed(
                    e,
                    &[
                        (
                            "new:a",
                            Draft {
                                revision: 1,
                                ..Default::default()
                            },
                        ),
                        (
                            "new:b",
                            Draft {
                                revision: 1,
                                ..Default::default()
                            },
                        ),
                        (
                            "new:c",
                            Draft {
                                revision: 1,
                                ..Default::default()
                            },
                        ),
                    ],
                    w,
                    cx,
                );
                // a → b → c: a goes first, b waits for a's exact reply.
                for key in ["new:a", "new:b", "new:c"] {
                    e.select(key.into(), true, false, w, cx);
                    e.show_draft(Some(key.into()), w, cx);
                }
                assert_eq!(discarded(&commands), [("new:a".to_owned(), 1)]);
                assert!(
                    e.has_navigation_draft("new:b"),
                    "b is listed until its turn"
                );
                // Reopening b before its turn keeps it.
                e.select("new:b".into(), true, false, w, cx);
                e.show_draft(Some("new:b".into()), w, cx);
                // A retained earlier reply for another attempt releases nothing.
                let mut stale = e.state.clone();
                stale.discard = Some(("new:a".into(), 1, 0, Ok(())));
                e.accept(stale, w, cx);
                assert!(e.discarding.is_some());
                reply(e, Ok(()), w, cx);
                assert!(!e.cache.contains_key("new:a"));
                // c was left when b was opened; it follows now. b stays in use.
                assert_eq!(discarded(&commands), [("new:c".to_owned(), 1)]);
                reply(e, Ok(()), w, cx);
                assert!(discarded(&commands).is_empty());
                assert_eq!(e.selected.as_deref(), Some("new:b"));
                assert!(e.has_navigation_draft("new:b"));
                assert!(!e.cache.contains_key("new:c"));
            });
        })
        .unwrap();
    }

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
