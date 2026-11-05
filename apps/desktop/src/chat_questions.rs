//! One current question, one retained input entity. Selection never sends.
//! The ordinary editor and immutable courier continue to own their own draft.
use super::*;
use crate::{
    database_access::{Decision, Outcome as AccessOutcome},
    question::{Access, AccessMode, AnswerDraft, Identity, Kind, Projection, Question},
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
    hint_height: crate::composer_height::State,
    /// The latest explicit database-access decision. Kept across selection so
    /// returning to the chat still shows Pending/Accepted/Unknown for it.
    access: Option<AccessDecision>,
}
/// Volatile UI view of one submitted decision, matched to the worker's exact reply.
struct AccessDecision {
    owner: String,
    identity: Identity,
    allow: bool,
    request: u64,
    outcome: AccessOutcome,
}
fn access_title(access: &Access) -> String {
    let mode = match access.mode {
        AccessMode::Read => "read",
        AccessMode::Write => "write",
    };
    format!("Allow {mode} access to the {} database?", access.env)
}
/// What a grant permits, from the structured mode, never from prose.
fn access_scope(access: &Access) -> &'static str {
    match access.mode {
        AccessMode::Read => "Read-only, for the rest of this chat.",
        AccessMode::Write => "Reads and writes, for the rest of this chat.",
    }
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
            hint_height: Default::default(),
            access: None,
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
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    pub(crate) fn finish_question_composition(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.questions
            .input
            .update(cx, |input, cx| input.unmark_text(window, cx));
    }
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
            match self.questions.current.as_ref().map(|q| q.content.kind) {
                Some(Kind::Message) => self.questions.input.update(cx, |s, cx| s.focus(window, cx)),
                // Never focus Allow or Deny: no key press may decide by default.
                Some(_) => window.focus(&self.questions.focus, cx),
                None => self.text.update(cx, |s, cx| s.focus(window, cx)),
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
    pub(super) fn focus_question_panel(&self, window: &mut Window, cx: &mut Context<Self>) {
        window.focus(&self.questions.focus, cx);
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
    pub(super) fn question_needs_you(&self) -> bool {
        self.questions.fresh
            && self.questions.current.is_some()
            && !self.question_accepted()
            && !matches!(self.access_outcome(), Some(AccessOutcome::Accepted))
    }
    /// The decision submitted for exactly the projected request in this chat.
    fn access_outcome(&self) -> Option<&AccessOutcome> {
        let decision = self.questions.access.as_ref()?;
        let current = self.questions.current.as_ref()?;
        (self.questions.owner.as_ref() == Some(&decision.owner)
            && current.identity == decision.identity)
            .then_some(&decision.outcome)
    }
    fn access_decidable(&self) -> bool {
        self.ready()
            && self.writable
            && self.questions.fresh
            && self.questions.owner == self.selected
            && !self.waiting()
            && self.error.is_none()
            && self
                .questions
                .current
                .as_ref()
                .is_some_and(|q| q.content.kind == Kind::Access && q.content.access.is_some())
            && !matches!(
                self.access_outcome(),
                Some(AccessOutcome::Pending | AccessOutcome::Accepted)
            )
    }
    /// Only an explicit Allow/Deny activation for this exact pending request.
    /// A lost reply stays Unknown; nothing here resubmits automatically.
    pub(super) fn decide_access(
        &mut self,
        identity: &Identity,
        allow: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.marked(window, cx) {
            return;
        }
        self.resume_question_context(window, cx);
        if !self.access_decidable() {
            return;
        }
        let (Some(owner), Some(question)) =
            (self.questions.owner.clone(), self.questions.current.clone())
        else {
            return;
        };
        let (Some(session), Some(access)) =
            (owner.strip_prefix("chat:"), question.content.access.clone())
        else {
            return;
        };
        if question.identity != *identity {
            return;
        }
        self.next_request += 1;
        let request = self.next_request;
        let decision = Decision {
            session: session.to_owned(),
            question: question.identity.clone(),
            access,
            allow,
        };
        if self.client.as_ref().is_some_and(|client| {
            client.command(WriteCommand::DatabaseAccess { decision, request })
        }) {
            self.questions.access = Some(AccessDecision {
                owner,
                identity: question.identity.clone(),
                allow,
                request,
                outcome: AccessOutcome::Pending,
            });
        } else {
            self.error = Some("Local action queue is busy. Nothing was submitted.");
        }
        cx.notify();
    }
    /// Adopt only the worker's reply to this exact submitted request.
    pub(super) fn accept_access_decision(&mut self, cx: &mut Context<Self>) {
        let (Some(reply), Some(decision)) = (&self.state.access, &mut self.questions.access) else {
            return;
        };
        if reply.request == decision.request
            && reply.decision.question == decision.identity
            && reply.decision.allow == decision.allow
            && format!("chat:{}", reply.decision.session) == decision.owner
            && reply.outcome != decision.outcome
        {
            decision.outcome = reply.outcome.clone();
            cx.notify();
        }
    }
    pub(crate) fn question_hint_covered(&self) -> bool {
        self.questions.current.is_some() || self.draft().is_some_and(|d| d.answer.is_some())
    }
    pub(super) fn view_question(
        &mut self,
        identity: &Identity,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.question_needs_you()
            || self.questions.owner != self.selected
            || self
                .questions
                .current
                .as_ref()
                .is_none_or(|q| &q.identity != identity || q.content.kind != Kind::Message)
            || self.marked(window, cx)
        {
            return;
        }
        self.questions.input.update(cx, |s, cx| s.focus(window, cx));
    }
    /// Explicit Send again. An answer carries the fresh current question only
    /// when it still projects the reply's exact identity; otherwise the worker
    /// applies the ended-turn rule.
    pub(super) fn retry_command(&self, id: &str) -> WriteCommand {
        let answer = self
            .state
            .book
            .as_ref()
            .and_then(|book| book.pending.get(id))
            .and_then(|intent| intent.answer.as_ref().map(|a| (intent.key.clone(), a)));
        match (answer, &self.questions.current) {
            (Some((key, answer)), Some(q))
                if self.questions.fresh
                    && self.questions.owner.as_ref() == Some(&key)
                    && self.selected.as_ref() == Some(&key)
                    && q.identity == answer.question =>
            {
                WriteCommand::RetryAnswer {
                    id: id.into(),
                    question: q.clone(),
                }
            }
            _ => WriteCommand::Check {
                id: id.into(),
                retry: true,
            },
        }
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
        // Database approvals have no editable reply to checkpoint. They remain
        // pending in pilotd across GUI replacement, including unavailable requests.
        if question.content.kind != Kind::Message {
            return true;
        }
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
        let (Some(key), Some(question), Some(mut draft)) = (
            self.selected.clone(),
            self.questions.current.clone(),
            self.draft().cloned(),
        ) else {
            return;
        };
        self.capture_generation(&key, &mut draft);
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
            if let Some(chat) = key.strip_prefix("chat:") {
                cx.emit(EditorEvent::Sent {
                    chat: chat.to_owned(),
                    sending: None,
                });
            }
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
    pub(super) fn question_hint_slot(
        &self,
        hint: Option<gpui_kit::AnyElement>,
        gap: f32,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) -> gpui_kit::AnyElement {
        crate::composer_height::slot(
            "question-hint-slot",
            &self.questions.hint_height,
            self.selected.clone(),
            hint,
            gap,
            w,
            cx,
        )
    }
    pub(super) fn question_panel(
        &self,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<gpui_kit::AnyElement> {
        let q = self.questions.current.clone()?;
        let editable = self.question_editable();
        let access = q
            .content
            .access
            .as_ref()
            .filter(|_| q.content.kind == Kind::Access);
        // A database request's title states the structured privilege; prose
        // (including the agent's reason) never changes what is granted.
        let headline = access.map_or_else(|| q.content.question.clone(), access_title);
        let mut content = div()
            .id("question-content")
            .v_flex()
            .gap_2()
            .min_w_0()
            .max_h(px(280.))
            .overflow_y_scroll()
            .child(ui::text(Text::Headline, headline));
        if let Some(access) = access {
            content = content.child(ui::text(Text::Body, access_scope(access)));
        }
        if let Some(context) = &q.content.context {
            content = content.child(
                ui::text(Text::Caption, context.clone()).text_color(cx.theme().muted_foreground),
            );
        }
        if q.content.kind == Kind::AccessUnavailable {
            content = content.child(ui::text(
                Text::Body,
                "This access request is malformed or unsupported, so it can't be decided here. A message never grants access.",
            ));
        } else if q.content.kind == Kind::Message {
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
            .flex_none()
            .min_w_0()
            .gap_2()
            .p_2();
        let hint = if self.question_needs_you() {
            let identity = q.identity.clone();
            let hint = div()
                .id("question-attention-hint")
                .h_flex()
                .items_center()
                .flex_wrap()
                .min_w_0()
                .gap_2()
                .child(
                    ui::text(
                        Text::Caption,
                        if q.content.kind == Kind::Message {
                            "Waiting for your answer"
                        } else if q.content.kind == Kind::Access {
                            "Approval needed"
                        } else {
                            "Your input is needed to continue"
                        },
                    )
                    .text_color(crate::appearance::attention_text(cx)),
                )
                .when(q.content.kind == Kind::Message, |row| {
                    row.child(
                        ui::action("view-pending-question", "View question", Action::Quiet)
                            .on_click(
                                cx.listener(move |v, _, w, cx| v.view_question(&identity, w, cx)),
                            ),
                    )
                });
            #[cfg(any(test, feature = "native-probes"))]
            let hint = hint.test_support();
            Some(hint.into_any_element())
        } else {
            None
        };
        panel = panel
            .child(self.question_hint_slot(hint, 8., w, cx))
            .child(content);
        // One content-sized action row, never a second Stop-only footer.
        let mut actions = div()
            .id("question-actions")
            .h_flex()
            .flex_none()
            .gap_2()
            .when(self.busy, |row| {
                row.child(self.stop_button("question-stop", cx))
            })
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .children(self.question_accepted().then(|| {
                        ui::text(Text::Caption, "Reply sent. Waiting for the agent.")
                            .text_color(cx.theme().muted_foreground)
                    })),
            );
        if q.content.kind == Kind::Message {
            let input_editable = self.writable
                && self.state.book.is_some()
                && !self.closing
                && !self.waiting()
                && !self.question_previous()
                && !self.question_accepted();
            panel = panel.child(
                div()
                    .flex_none()
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
            actions = actions.child(
                ui::action("answer-question", "Reply", Action::Primary)
                    .disabled(!editable || !sendable || self.error.is_some())
                    .on_click(
                        cx.listener(move |v, _, w, cx| v.answer_question(Some(&identity), w, cx)),
                    ),
            );
        }
        if let Some(access) = access {
            let decidable = self.access_decidable();
            let (status, failed) = match self.access_outcome() {
                Some(AccessOutcome::Pending) => (Some("Sending decision…"), false),
                Some(AccessOutcome::Accepted) => {
                    (Some("Decision sent. Waiting for the agent."), false)
                }
                Some(AccessOutcome::Refused(e) | AccessOutcome::Unknown(e)) => (Some(*e), true),
                None => (None, false),
            };
            if let Some(status) = status {
                let status = div()
                    .id("database-access-status")
                    .min_w_0()
                    .aria_label(status)
                    .child(ui::text(Text::Caption, status).text_color(if failed {
                        cx.theme().danger
                    } else {
                        cx.theme().muted_foreground
                    }));
                #[cfg(any(test, feature = "native-probes"))]
                let status = status.test_support();
                panel = panel.child(status);
            }
            let mode = match access.mode {
                AccessMode::Read => "read",
                AccessMode::Write => "write",
            };
            let (deny, allow) = (q.identity.clone(), q.identity.clone());
            actions = actions
                .child(
                    ui::action("deny-database-access", "Deny", Action::Secondary)
                        .accessibility_label(format!(
                            "Deny {mode} access to the {} database",
                            access.env
                        ))
                        .disabled(!decidable)
                        .on_click(
                            cx.listener(move |v, _, w, cx| v.decide_access(&deny, false, w, cx)),
                        ),
                )
                .child(
                    ui::action(
                        "allow-database-access",
                        format!("Allow {mode} access"),
                        Action::Primary,
                    )
                    .accessibility_label(format!(
                        "Allow {mode} access to the {} database",
                        access.env
                    ))
                    .disabled(!decidable)
                    .on_click(cx.listener(move |v, _, w, cx| v.decide_access(&allow, true, w, cx))),
                );
        }
        if self.busy || q.content.kind != Kind::AccessUnavailable {
            #[cfg(any(test, feature = "native-probes"))]
            let actions = actions.test_support();
            panel = panel.child(actions);
        }
        #[cfg(any(test, feature = "native-probes"))]
        let panel = panel.test_support();
        Some(panel.into_any_element())
    }
}
