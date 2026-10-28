//! One current question, one retained input entity. Selection never sends.
//! The ordinary editor and immutable courier continue to own their own draft.
use super::*;
use crate::{
    question::{AnswerDraft, Identity, Kind, Projection, Question},
    ui::{self, Action, Text},
};
use gpui_kit::component::{checkbox::Checkbox, radio::Radio};
use gpui_kit::{FocusHandle, Focusable, StatefulInteractiveElement};
use std::sync::Arc;

pub(super) struct Questions {
    pub(super) input: Entity<TextareaState>,
    pub(super) current: Option<Arc<Question>>,
    owner: Option<String>,
    selected: BTreeSet<usize>,
    fresh: bool,
    confirmed: bool,
    issue: Option<&'static str>,
    next: Option<(Option<String>, Projection, bool)>,
    focus: FocusHandle,
    choices_focus: FocusHandle,
    retiring: Option<(String, u64)>,
}
impl Questions {
    pub(super) fn new(window: &mut Window, cx: &mut Context<ChatEditor>) -> Self {
        let input = cx.new(|cx| {
            let mut s = TextareaState::new(window, cx)
                .placeholder("Add your own words…")
                .auto_grow(1, 4);
            s.set_submit_on_enter(true, cx);
            s
        });
        Self {
            input,
            current: None,
            owner: None,
            selected: BTreeSet::new(),
            fresh: false,
            confirmed: false,
            issue: None,
            next: None,
            focus: cx.focus_handle().tab_stop(false),
            choices_focus: cx.focus_handle(),
            retiring: None,
        }
    }
    pub(super) fn reset(&mut self) {
        self.current = None;
        self.owner = None;
        self.selected.clear();
        self.fresh = false;
        self.confirmed = false;
        self.issue = None;
        self.next = None;
        self.retiring = None;
    }
}
impl ChatEditor {
    pub(super) fn question_blocks_discard(&self, cx: &gpui_kit::App) -> bool {
        let Some(key) = self.selected.as_ref() else {
            return false;
        };
        self.cache
            .get(key)
            .is_some_and(|draft| draft.answer.is_some())
            || self.state.book.as_ref().is_some_and(|book| {
                book.drafts
                    .get(key)
                    .is_some_and(|draft| draft.answer.is_some())
                    || book
                        .pending
                        .values()
                        .any(|intent| &intent.key == key && intent.answer.is_some())
            })
            || (self.questions.owner.as_ref() == Some(key)
                && self.questions.current.is_some()
                && (!self.questions.input.read(cx).value().is_empty()
                    || !self.questions.selected.is_empty()))
    }
    pub(crate) fn question_context(
        &mut self,
        target: Option<&str>,
        projection: Projection,
        fresh: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let owner = target.map(|id| format!("chat:{id}"));
        let fresh = fresh && owner == self.selected;
        if self.marked(window, cx)
            || self
                .selected
                .as_ref()
                .is_some_and(|key| self.unsaved_local.contains(key))
            || self.state.error.is_some()
        {
            self.questions.fresh = false;
            self.questions.confirmed = false;
            self.questions.next = Some((owner, projection, fresh));
            cx.notify();
            return;
        }
        self.apply_question_context(owner, projection, fresh, window, cx);
    }
    fn apply_question_context(
        &mut self,
        owner: Option<String>,
        projection: Projection,
        fresh: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.changed(cx);
        let focused = self.questions.focus.contains_focused(window, cx)
            || self.text.read(cx).focus_handle(cx).is_focused(window);
        self.questions.confirmed =
            fresh && matches!(&projection, Projection::None | Projection::Pending(_));
        self.questions.issue = match &projection {
            Projection::Invalid(e) => Some(*e),
            _ => None,
        };
        let next = match projection {
            Projection::Pending(q) if owner == self.selected => Some(q),
            _ => None,
        };
        let changed = self.questions.fresh != fresh
            || self.questions.owner != owner
            || self.questions.current.as_ref().map(|q| &q.identity)
                != next.as_ref().map(|q| &q.identity);
        self.questions.owner = owner;
        self.questions.current = next;
        self.questions.fresh = fresh;
        self.questions.next = None;
        self.load_question_input(window, cx);
        if changed && focused {
            if self.questions.current.is_some() {
                self.questions.input.update(cx, |s, cx| s.focus(window, cx));
            } else {
                self.text.update(cx, |s, cx| s.focus(window, cx));
            }
        }
        self.retire_settled_question(cx);
        if changed {
            cx.notify();
        }
    }
    pub(super) fn resume_question_context(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.marked(window, cx)
            || self
                .selected
                .as_ref()
                .is_some_and(|key| self.unsaved_local.contains(key))
        {
            return;
        }
        if let Some((owner, projection, fresh)) = self.questions.next.take() {
            self.apply_question_context(owner, projection, fresh, window, cx);
        }
    }
    pub(super) fn question_marked(&self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        self.questions
            .input
            .update(cx, |s, cx| s.marked_text_range(window, cx).is_some())
    }
    fn question_previous(&self) -> bool {
        self.draft().is_some_and(|d| {
            d.answer.as_ref().is_some_and(|a| {
                a.has_content()
                    && !crate::delivery_store::reply_accepted(d, &a.identity)
                    && self
                        .questions
                        .current
                        .as_ref()
                        .is_none_or(|q| a.identity.question != q.identity)
            })
        })
    }
    fn question_accepted(&self) -> bool {
        self.questions.current.as_ref().is_some_and(|q| {
            self.draft()
                .and_then(|d| d.last.as_ref())
                .is_some_and(|last| {
                    last.state == "accepted"
                        && last
                            .answer
                            .as_ref()
                            .is_some_and(|a| a.question == q.identity)
                })
        })
    }
    fn question_editable(&self) -> bool {
        self.ready()
            && self.writable
            && self.questions.fresh
            && self.questions.owner == self.selected
            && !self.waiting()
            && !self.models_block_send()
            && !self.question_previous()
            && !self.question_accepted()
            && self
                .questions
                .current
                .as_ref()
                .is_some_and(|q| q.content.kind == Kind::Message)
    }
    pub(super) fn load_question_input(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(question) = &self.questions.current else {
            return;
        };
        let saved = self
            .draft()
            .and_then(|d| d.answer.as_ref())
            .filter(|a| a.identity.question == question.identity);
        let (text, selected) = saved
            .map(|a| (a.text.clone(), a.selected.clone()))
            .unwrap_or_default();
        self.questions.selected = selected;
        if self.questions.input.read(cx).value().as_ref() != text {
            self.questions
                .input
                .update(cx, |s, cx| s.set_value(text, window, cx));
        }
    }
    pub(super) fn record_question_edit(&mut self, force: bool, cx: &mut Context<Self>) {
        let (Some(key), Some(question)) = (self.selected.clone(), self.questions.current.clone())
        else {
            return;
        };
        if self.questions.owner.as_ref() != Some(&key)
            || self.question_previous()
            || question.content.kind != Kind::Message
        {
            return;
        }
        let text = self.questions.input.read(cx).value().to_string();
        let Some(draft) = self.cache.get_mut(&key) else {
            return;
        };
        if !force
            && draft.answer.as_ref().map_or(
                text.is_empty() && self.questions.selected.is_empty(),
                |a| {
                    a.identity.question == question.identity
                        && a.text == text
                        && a.selected == self.questions.selected
                },
            )
        {
            return;
        }
        let revision = draft.revision + 1;
        let ordinary_settled = draft
            .settled_revision
            .is_some_and(|revision| draft.revision <= revision);
        let answer = match AnswerDraft::capture(
            &question,
            revision,
            self.questions.selected.clone(),
            text,
        ) {
            Ok(answer) => answer,
            Err(error) => {
                self.error = Some(error);
                self.unsaved_local.insert(key);
                cx.notify();
                return;
            }
        };
        draft.revision = revision;
        if ordinary_settled {
            draft.settled_revision = Some(revision);
        }
        draft.answer = Some(answer);
        self.error = if draft.text.len() > TEXT_CAP {
            Some("Ordinary draft exceeds 32 KiB. Keep or reduce it before replying.")
        } else if self
            .client
            .as_ref()
            .is_some_and(|c| c.edit(key.clone(), draft.clone()))
        {
            None
        } else {
            Some("Question reply save could not be queued. Copy it before closing.")
        };
        if self.error.is_some() {
            self.unsaved_local.insert(key);
        } else {
            self.unsaved_local.remove(&key);
        }
        cx.emit(EditorEvent::DraftsChanged);
        cx.notify();
    }
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    pub(super) fn question_checkpoint_matches(&self, cx: &gpui_kit::App) -> bool {
        let Some(question) = &self.questions.current else {
            return true;
        };
        let Some(answer) = self
            .selected
            .as_ref()
            .and_then(|key| self.cache.get(key))
            .and_then(|d| d.answer.as_ref())
        else {
            return false;
        };
        answer.identity.question == question.identity
            && answer.text == self.questions.input.read(cx).value().as_ref()
            && answer.selected == self.questions.selected
    }
    fn pick_question(
        &mut self,
        identity: &Identity,
        ix: usize,
        next: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.question_editable() || self.marked(window, cx) {
            return;
        }
        let Some(q) = &self.questions.current else {
            return;
        };
        if q.identity != *identity || ix >= q.content.options.len() {
            return;
        }
        let previous = self.questions.selected.clone();
        if q.content.multi {
            if next {
                self.questions.selected.insert(ix);
            } else {
                self.questions.selected.remove(&ix);
            }
        } else {
            self.questions.selected.clear();
            self.questions.selected.insert(ix);
        }
        if self.questions.selected != previous {
            self.record_question_edit(true, cx);
        }
    }
    fn pick_radio(
        &mut self,
        identity: &Identity,
        ix: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.question_editable()
            || self.marked(window, cx)
            || self
                .questions
                .current
                .as_ref()
                .is_none_or(|q| q.identity != *identity)
        {
            return;
        }
        self.pick_question(identity, ix, true, window, cx);
        window.focus(&self.questions.choices_focus, cx);
    }
    fn radio_key(
        &mut self,
        identity: &Identity,
        event: &gpui_kit::KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let modifiers = event.keystroke.modifiers;
        if modifiers.control
            || modifiers.alt
            || modifiers.platform
            || !self.question_editable()
            || self.marked(window, cx)
        {
            return;
        }
        let Some(q) = &self.questions.current else {
            return;
        };
        if q.identity != *identity || q.content.multi || q.content.options.is_empty() {
            return;
        }
        let count = q.content.options.len();
        let selected = self.questions.selected.first().copied();
        let ix = match event.keystroke.key.as_str() {
            "down" | "right" => selected.map_or(0, |ix| (ix + 1) % count),
            "up" | "left" => selected.map_or(count - 1, |ix| (ix + count - 1) % count),
            "space" | " " | "enter" => selected.unwrap_or(0),
            _ => return,
        };
        self.pick_question(identity, ix, true, window, cx);
        window.prevent_default();
        cx.stop_propagation();
    }
    pub(super) fn answer_question(
        &mut self,
        expected: Option<&Identity>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.marked(window, cx) {
            return;
        }
        self.resume_question_context(window, cx);
        self.changed(cx);
        if !self.question_editable() || self.error.is_some() {
            return;
        }
        let (Some(key), Some(question), Some(draft)) = (
            self.selected.clone(),
            self.questions.current.clone(),
            self.draft().cloned(),
        ) else {
            return;
        };
        if expected.is_some_and(|expected| *expected != question.identity) {
            return;
        }
        let Some(answer) = &draft.answer else {
            return;
        };
        match answer.reply(&question) {
            Ok(Some(_)) => {}
            Ok(None) => return,
            Err(e) => {
                self.error = Some(e);
                cx.notify();
                return;
            }
        }
        self.next_request += 1;
        let request = self.next_request;
        if self.client.as_ref().is_some_and(|client| {
            client.command(WriteCommand::Answer {
                key: key.clone(),
                draft: Box::new(draft),
                question,
                request,
            })
        }) {
            self.pending.insert(key, request);
            self.error = None;
        } else {
            self.error = Some("Local action queue is busy. Nothing new was submitted.");
        }
        cx.notify();
    }
    pub(super) fn retire_settled_question(&mut self, cx: &mut Context<Self>) {
        if self.waiting() {
            return;
        }
        let Some(draft) = self.draft() else {
            return;
        };
        let Some(answer) = &draft.answer else {
            return;
        };
        let same = self
            .questions
            .current
            .as_ref()
            .is_some_and(|q| q.identity == answer.identity.question);
        let accepted = crate::delivery_store::reply_accepted(draft, &answer.identity);
        // An exactly acknowledged reply is in the conversation: it settles as
        // soon as its question leaves, even while the run hides projections.
        if !same && (accepted || (self.questions.confirmed && !answer.has_content())) {
            self.retire_question(!accepted, cx);
        }
    }
    fn retire_question(&mut self, recover: bool, cx: &mut Context<Self>) {
        let (Some(key), Some(draft)) = (self.selected.clone(), self.draft()) else {
            return;
        };
        let Some(answer) = &draft.answer else {
            return;
        };
        let revision = draft.revision;
        let identity = answer.identity.clone();
        if self.questions.retiring.as_ref() == Some(&(key.clone(), revision)) {
            return;
        }
        if self.client.as_ref().is_some_and(|client| {
            client.command(WriteCommand::RetireAnswer {
                key: key.clone(),
                revision,
                identity,
                recover,
            })
        }) {
            self.questions.retiring = Some((key, revision));
        } else {
            self.error = Some("Reply recovery could not be queued. Original input retained.");
        }
        cx.notify();
    }
    pub(super) fn question_recovery(&self, cx: &mut Context<Self>) -> Option<gpui_kit::AnyElement> {
        let deferred = self.questions.next.is_some();
        let previous = self.question_previous();
        let issue = self.questions.issue;
        if !deferred && !previous && issue.is_none() {
            return None;
        }
        let mut row = div().v_flex().gap_1().min_w_0();
        if let Some(issue) = issue {
            row = row.child(ui::text(Text::Caption, issue));
        }
        if deferred {
            row = row.child(
                ui::action(
                    "show-current-question",
                    "Show current question",
                    Action::Quiet,
                )
                .on_click(cx.listener(|v, _, w, cx| v.resume_question_context(w, cx))),
            );
        }
        if previous {
            row = row
                .child(ui::text(
                    Text::Caption,
                    "A reply to an earlier question is kept separately.",
                ))
                .child(
                    ui::action(
                        "keep-question-reply",
                        "Keep reply in recovery",
                        Action::Secondary,
                    )
                    .disabled(self.waiting() || !self.ready())
                    .on_click(cx.listener(|v, _, w, cx| {
                        if !v.marked(w, cx) {
                            v.changed(cx);
                            v.questions.retiring = None;
                            v.retire_question(true, cx);
                        }
                    })),
                );
        }
        Some(row.into_any_element())
    }
    pub(super) fn question_panel(&self, cx: &mut Context<Self>) -> Option<gpui_kit::AnyElement> {
        let q = self.questions.current.clone()?;
        let editable = self.question_editable();
        let mut content = div()
            .id("question-content")
            .v_flex()
            .gap_2()
            .min_w_0()
            .max_h(px(280.))
            .overflow_y_scroll()
            .child(ui::text(Text::Headline, q.content.question.clone()));
        if let Some(context) = &q.content.context {
            content = content.child(
                ui::text(Text::Caption, context.clone()).text_color(cx.theme().muted_foreground),
            );
        }
        if q.content.kind == Kind::AccessUnavailable {
            content=content.child(ui::text(Text::Body,"Access decisions are not supported here. Use the current macOS app; a message cannot grant access."));
        } else {
            let mut radios = Vec::new();
            for (ix, choice) in q.content.options.iter().enumerate() {
                let id = SharedString::from(format!(
                    "question-{}-{}-{ix}",
                    q.identity.entry, q.identity.fingerprint
                ));
                let identity = q.identity.clone();
                let mut label = div()
                    .v_flex()
                    .min_w_0()
                    .gap_1()
                    .child(ui::text(Text::Body, choice.label.clone()));
                if let Some(detail) = &choice.detail {
                    label = label.child(
                        ui::text(Text::Caption, detail.clone())
                            .text_color(cx.theme().muted_foreground),
                    );
                }
                if choice.suggested {
                    label = label.child(
                        ui::text(Text::Caption, "Suggested")
                            .text_color(cx.theme().muted_foreground),
                    );
                }
                let checked = self.questions.selected.contains(&ix);
                if q.content.multi {
                    content = content.child(
                        Checkbox::new(id)
                            .accessibility_label(choice.label.clone())
                            .checked(checked)
                            .disabled(!editable)
                            .w_full()
                            .min_w_0()
                            .child(label)
                            .on_change(cx.listener(move |v, next, w, cx| {
                                v.pick_question(&identity, ix, *next, w, cx)
                            })),
                    );
                } else {
                    radios.push(
                        Radio::new(id)
                            .accessibility_label(choice.label.clone())
                            .checked(checked)
                            .disabled(!editable)
                            .tab_stop(false)
                            .w_full()
                            .min_w_0()
                            .child(label),
                    );
                }
            }
            if !q.content.multi && !radios.is_empty() {
                let identity = q.identity.clone();
                let keyboard_identity = identity.clone();
                let group = RadioGroup::new(SharedString::from(format!(
                    "question-group-{}-{}",
                    q.identity.entry, q.identity.fingerprint
                )))
                .children(radios)
                .selected_index(self.questions.selected.first().copied())
                .disabled(!editable)
                .on_change(cx.listener(move |v, ix, w, cx| v.pick_radio(&identity, *ix, w, cx)));
                // Kit supplies group semantics, not arrow navigation.
                let choices = div()
                    .id(SharedString::from(format!(
                        "question-choices-{}-{}",
                        q.identity.entry, q.identity.fingerprint
                    )))
                    .min_w_0()
                    .aria_label(q.content.question.clone())
                    .on_key_down(cx.listener(move |v, event, w, cx| {
                        v.radio_key(&keyboard_identity, event, w, cx)
                    }))
                    .child(group);
                #[cfg(any(test, feature = "native-probes"))]
                let choices = choices.test_support();
                let choices =
                    choices.track_focus(&self.questions.choices_focus.clone().tab_stop(editable));
                content = content.child(choices);
            }
        }
        #[cfg(any(test, feature = "native-probes"))]
        let content = content.test_support();
        let mut panel = div()
            .id("question-composer")
            .track_focus(&self.questions.focus)
            .v_flex()
            .min_w_0()
            .gap_2()
            .p_2()
            .child(content);
        if q.content.kind == Kind::Message {
            let input_editable = self.writable
                && self.state.book.is_some()
                && !self.closing
                && !self.waiting()
                && !self.question_previous()
                && !self.question_accepted();
            panel = panel.child(
                div()
                    .bg(crate::appearance::card(cx))
                    .rounded(px(crate::appearance::Radius::CARD))
                    .child(
                        Textarea::new(&self.questions.input)
                            .appearance(false)
                            .bordered(false)
                            .readonly(!input_editable)
                            .aria_label("Your question reply"),
                    ),
            );
            let reply = self
                .draft()
                .and_then(|d| d.answer.as_ref())
                .map(|a| a.reply(&q));
            let sendable = matches!(&reply, Some(Ok(Some(_))));
            if let Some(Err(error)) = reply {
                panel = panel.child(ui::text(Text::Caption, error).text_color(cx.theme().danger));
            }
            let identity = q.identity.clone();
            panel = panel.child(
                div()
                    .h_flex()
                    .justify_between()
                    .gap_2()
                    .child(
                        // Routine draft handling stays silent; only a sent reply speaks.
                        div()
                            .flex_1()
                            .min_w_0()
                            .children(self.question_accepted().then(|| {
                                ui::text(Text::Caption, "Reply sent. Waiting for the agent.")
                                    .text_color(cx.theme().muted_foreground)
                            })),
                    )
                    .child(
                        ui::action("answer-question", "Reply", Action::Primary)
                            .disabled(!editable || !sendable || self.error.is_some())
                            .on_click(cx.listener(move |v, _, w, cx| {
                                v.answer_question(Some(&identity), w, cx)
                            })),
                    ),
            );
        }
        if self.busy {
            panel = panel.child(self.stop_button("question-stop", cx));
        }
        #[cfg(any(test, feature = "native-probes"))]
        let panel = panel.test_support();
        Some(panel.into_any_element())
    }
}
