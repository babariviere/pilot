//! Local composer UI. Durable ownership lives in the private interaction worker.
use crate::{
    app_icon::AppIcon,
    delivery_store::{DRAFT_CAP, Draft, TEXT_CAP},
    interaction::{Interaction, WriteCommand, WriteState},
};
#[cfg(any(test, feature = "native-probes"))]
use gpui_kit::TestSupportExt;
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::{
    AppContext, Context, Entity, EntityInputHandler, EventEmitter, InteractiveElement, IntoElement,
    ParentElement, Render, SharedString, StatefulInteractiveElement, Styled, Subscription, Window,
    component::{
        ActiveTheme, Disableable, Sizable, StyledExt,
        button::{Button, ButtonVariants},
        input::{InputEvent, InputState, Textarea, TextareaState},
        radio::RadioGroup,
    },
    div, px,
};
use std::collections::{BTreeMap, BTreeSet};

#[path = "path_completion_view.rs"]
pub(crate) mod paths;

#[cfg(feature = "native-probes")]
#[path = "composer_probe.rs"]
pub(crate) mod composer_probe;
#[cfg(feature = "native-probes")]
#[path = "delivery_probe.rs"]
pub(crate) mod delivery_probe;
#[path = "chat_draft_discard.rs"]
mod draft_discard;
#[path = "chat_model_picker.rs"]
mod model_picker;
#[path = "new_chat_view.rs"]
mod new_chat_view;
#[cfg(feature = "native-probes")]
#[path = "project_creation_probe.rs"]
pub(crate) mod project_creation_probe;
#[path = "chat_projects.rs"]
mod projects;
#[cfg(feature = "native-probes")]
#[path = "question_probe.rs"]
pub(crate) mod question_probe;
#[path = "chat_questions.rs"]
mod questions;
#[path = "chat_recovery.rs"]
mod recovery;
#[path = "chat_sending.rs"]
pub(crate) mod sending;

pub(crate) enum EditorEvent {
    UpdateCheckpoint,
    AddProject,
    DraftsChanged,
    DraftDiscardFailed {
        key: String,
        error: &'static str,
    },
    DraftDiscarded {
        selected: bool,
    },
    OpenCreated {
        key: String,
        revision: u64,
        target: String,
    },
    Flushed,
    StopRequested {
        key: String,
    },
    /// Continue with another model moved this chat's work to a new chat.
    OpenContinued(Box<crate::local_model::Chat>),
}

pub(crate) struct ChatEditor {
    paths: paths::Paths,
    context_entry: Option<gpui_kit::AnyView>,
    todos_entry: Option<gpui_kit::AnyView>,
    queue_entry: Option<gpui_kit::AnyView>,
    questions: questions::Questions,
    models: Option<model_picker::Models>,
    client: Option<Interaction>,
    text: Entity<TextareaState>,
    cwd: Entity<InputState>,
    project_catalog: projects::Catalog,
    project_picker: Option<projects::Picker>,
    cache: BTreeMap<String, Draft>,
    selected: Option<String>,
    writable: bool,
    busy: bool,
    thinking: bool,
    thinking_held: bool,
    background_work: bool,
    pending: BTreeMap<String, u64>,
    /// Ordinary chat sends in flight, by captured draft revision.
    sending: BTreeMap<String, u64>,
    /// Accepted sends (operation, revision, text) until the conversation shows them.
    delivered: BTreeMap<String, (String, u64, String)>,
    unsaved_local: BTreeSet<String>,
    retiring: BTreeMap<String, u64>,
    discarding: Option<(String, u64, u64)>,
    next_request: u64,
    /// Send's arrow lifts away and lands again once a submit is admitted.
    takeoff: crate::transition::Transition,
    state: WriteState,
    error: Option<&'static str>,
    closing: bool,
    update_checkpoint: Option<u64>,
    /// The editor's current placeholder, so render updates it only on change.
    placeholder: &'static str,
    _subscriptions: Vec<Subscription>,
}
impl EventEmitter<EditorEvent> for ChatEditor {}

impl ChatEditor {
    pub(crate) fn new(
        client: Option<Interaction>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let text = cx.new(|cx| {
            let mut state = TextareaState::new(window, cx)
                .placeholder("Reply to Pilot…")
                .auto_grow(1, 6);
            state.set_submit_on_enter(true, cx);
            state
        });
        let cwd =
            cx.new(|cx| InputState::new(window, cx).placeholder("Absolute Local working folder"));
        let questions = questions::Questions::new(window, cx);
        let question_events = cx.subscribe_in(
            &questions.input,
            window,
            |view, _, event, window, cx| match event {
                InputEvent::Change => {
                    view.record_question_edit(false, cx);
                    view.resume_question_context(window, cx);
                }
                InputEvent::PressEnter { shift: false, .. } => {
                    view.answer_question(None, window, cx)
                }
                _ => {}
            },
        );
        let text_events =
            cx.subscribe_in(&text, window, |view, _, event, window, cx| match event {
                InputEvent::Change => {
                    view.changed(cx);
                    view.path_input_changed(window, cx, true);
                }
                InputEvent::Blur => view.close_paths(cx),
                InputEvent::PressEnter { shift: false, .. } => view.submit(false, window, cx),
                _ => {}
            });
        let cwd_events = cx.subscribe(&cwd, |view, _, event, cx| {
            if matches!(event, InputEvent::Change) {
                view.changed(cx);
            }
        });
        let path_watch = cx.observe_in(&text, window, |v, _, w, cx| {
            v.path_input_changed(w, cx, false)
        });
        Self {
            paths: Default::default(),
            context_entry: None,
            todos_entry: None,
            queue_entry: None,
            questions,
            models: None,
            client,
            text,
            cwd,
            project_catalog: Default::default(),
            project_picker: None,
            cache: BTreeMap::new(),
            selected: None,
            writable: false,
            busy: false,
            thinking: false,
            thinking_held: false,
            background_work: false,
            pending: BTreeMap::new(),
            sending: BTreeMap::new(),
            delivered: BTreeMap::new(),
            unsaved_local: BTreeSet::new(),
            retiring: BTreeMap::new(),
            discarding: None,
            next_request: 0,
            takeoff: Default::default(),
            state: WriteState::default(),
            error: None,
            closing: false,
            update_checkpoint: None,
            placeholder: "Reply to Pilot…",
            _subscriptions: vec![text_events, cwd_events, question_events, path_watch],
        }
    }

    pub(crate) fn set_context_entry(&mut self, entry: gpui_kit::AnyView) {
        self.context_entry = Some(entry);
    }
    pub(crate) fn set_queue_entry(&mut self, entry: gpui_kit::AnyView) {
        self.queue_entry = Some(entry);
    }
    pub(crate) fn set_todos_entry(&mut self, entry: gpui_kit::AnyView) {
        self.todos_entry = Some(entry);
    }
    fn prune_cache(&mut self) {
        self.cache.retain(|key, draft| {
            self.state
                .book
                .as_ref()
                .is_some_and(|book| book.drafts.contains_key(key))
                || key.starts_with("new:")
                || !draft.text.is_empty()
                || !draft.recovered.is_empty()
                || draft.answer.is_some()
                || self.pending.contains_key(key)
                || self.unsaved_local.contains(key)
        });
    }
    pub(crate) fn ready(&self) -> bool {
        self.client.is_some()
            && self.state.book.is_some()
            && self.state.error.is_none()
            && !self.closing
            && self.update_checkpoint.is_none()
    }
    #[cfg(feature = "native-probes")]
    pub(crate) fn update_fixture_draft(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        if !self.ready() {
            return false;
        }
        let key = "new:update-fixture";
        if !self.cache.contains_key(key) {
            self.select(key.into(), true, false, window, cx);
            self.text.update(cx, |input, cx| {
                input.set_value("Owned update draft 👩‍💻 e\u{301} 日本語", window, cx)
            });
            self.record_edit(true, cx);
            return false;
        }
        self.unsaved_local.is_empty()
            && self.pending.is_empty()
            && self
                .state
                .book
                .as_ref()
                .is_some_and(|book| book.drafts.get(key) == self.cache.get(key))
    }
    pub(crate) fn navigation_key(&self) -> Option<&str> {
        self.selected.as_deref()
    }
    pub(crate) fn browse_empty(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.update_checkpoint.is_some() {
            return;
        }
        self.close_paths(cx);
        self.changed(cx);
        self.questions.reset();
        self.selected = None;
        self.project_picker = None;
        self.writable = false;
        self.busy = false;
        self.background_work = false;
        self.thinking = false;
        self.text.update(cx, |v, cx| v.set_value("", window, cx));
        self.cwd.update(cx, |v, cx| v.set_value("", window, cx));
        cx.notify();
    }
    pub(crate) fn has_navigation_draft(&self, key: &str) -> bool {
        key.starts_with("new:") && self.cache.contains_key(key)
    }
    pub(crate) fn new_drafts(&self) -> Vec<(String, String)> {
        self.cache
            .iter()
            .filter(|(key, _)| key.starts_with("new:"))
            .map(|(key, draft)| {
                let preview = draft
                    .text
                    .lines()
                    .next()
                    .unwrap_or("")
                    .chars()
                    .take(60)
                    .collect::<String>();
                (
                    key.clone(),
                    if draft.created.is_some() {
                        "Created chat, draft kept".into()
                    } else if preview.is_empty() {
                        "New chat".into()
                    } else {
                        preview
                    },
                )
            })
            .collect()
    }

    pub(crate) fn new_draft(&mut self, cwd: String, window: &mut Window, cx: &mut Context<Self>) {
        self.changed(cx);
        self.prune_cache();
        if !self.ready() {
            return;
        }
        if let Some(key) = self
            .cache
            .iter()
            .find(|(key, draft)| {
                key.starts_with("new:")
                    && !self
                        .discarding
                        .as_ref()
                        .is_some_and(|(discarding, ..)| discarding == *key)
                    && draft.text.is_empty()
                    && draft.pending.is_none()
                    && draft.created.is_none()
                    && draft.recovered.is_empty()
                    && !self.pending.contains_key(*key)
            })
            .map(|(key, _)| key.clone())
        {
            self.select(key, true, false, window, cx);
            return;
        }
        if self.cache.len() >= DRAFT_CAP {
            self.error = Some("Draft capacity reached. Existing drafts are retained.");
            cx.notify();
            return;
        }
        let key = format!("new:{}", uuid::Uuid::new_v4());
        let draft = Draft {
            revision: 1,
            cwd,
            ..Default::default()
        };
        self.cache.insert(key.clone(), draft.clone());
        if let Some(client) = &self.client {
            client.edit(key.clone(), draft);
        }
        self.select(key, true, false, window, cx);
        cx.emit(EditorEvent::DraftsChanged);
    }

    pub(crate) fn select(
        &mut self,
        key: String,
        writable: bool,
        busy: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.update_checkpoint.is_some() {
            return;
        }
        self.close_paths(cx);
        self.changed(cx);
        self.questions.reset();
        self.prune_cache();
        if self.cache.len() >= DRAFT_CAP && !self.cache.contains_key(&key) {
            self.selected = None;
            self.error = Some("Draft capacity reached. Browse remains available.");
            cx.notify();
            return;
        }
        self.cache.entry(key.clone()).or_default();
        self.selected = Some(key);
        self.writable = writable;
        self.busy = busy;
        self.thinking = false;
        self.thinking_held = false;
        self.background_work = false;
        self.error = None;
        self.load_input(window, cx);
        self.open_completed(cx);
        cx.notify();
    }
    pub(crate) fn permission(&mut self, writable: bool, busy: bool, cx: &mut Context<Self>) {
        if self.writable == writable && self.busy == busy {
            return;
        }
        self.writable = writable;
        self.busy = busy;
        cx.notify();
    }

    pub(crate) fn activity(&mut self, active: bool, cx: &mut Context<Self>) {
        if !active {
            self.thinking_held = false;
        }
        let next = active && !self.thinking_held;
        if next != self.thinking {
            self.thinking = next;
            cx.notify();
        }
    }

    pub(crate) fn activity_label(&self) -> Option<&'static str> {
        if self.thinking {
            Some("Thinking...")
        } else if self.busy || self.background_work {
            Some("Working...")
        } else {
            None
        }
    }

    pub(crate) fn marked(&self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        self.question_marked(window, cx)
            || self.text.update(cx, |state, cx| {
                state.marked_text_range(window, cx).is_some()
            })
            || self.cwd.update(cx, |state, cx| {
                state.marked_text_range(window, cx).is_some()
            })
            || self.project_query_marked(window, cx)
            || self.model_query_marked(window, cx)
    }
    #[cfg(feature = "native-probes")]
    pub(crate) fn shell_probe_setup(
        &mut self,
        writer: Interaction,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.client = Some(writer);
        self.state.book = Some(std::sync::Arc::new(
            crate::delivery_store::Book::shell_probe(),
        ));
        self.select("chat:synthetic".into(), true, false, window, cx);
    }
    #[cfg(any(test, feature = "native-probes"))]
    pub(crate) fn shell_probe(&self) -> (Entity<TextareaState>, Entity<InputState>, Option<Draft>) {
        (self.text.clone(), self.cwd.clone(), self.draft().cloned())
    }
    #[cfg(feature = "native-probes")]
    pub(crate) fn saved_probe(&self, cx: &gpui_kit::App) -> bool {
        self.error.is_none()
            && self.state.error.is_none()
            && self.selected.as_ref().is_some_and(|key| {
                self.cache.get(key).is_some_and(|draft| {
                    draft.text == self.text.read(cx).value().as_ref()
                        && self
                            .state
                            .book
                            .as_ref()
                            .and_then(|b| b.drafts.get(key))
                            .is_some_and(|saved| saved == draft)
                })
            })
    }
    pub(crate) fn background(&mut self, active: bool, cx: &mut Context<Self>) {
        if self.background_work != active {
            self.background_work = active;
            cx.notify();
        }
    }
    fn load_input(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some((key, draft)) = self
            .selected
            .as_ref()
            .and_then(|key| self.cache.get(key).map(|draft| (key, draft)))
        else {
            return;
        };
        let (text, cwd) = (self.shown_text(key, draft).to_owned(), draft.cwd.clone());
        if self.text.read(cx).value().as_ref() != text {
            self.text
                .update(cx, |state, cx| state.set_value(text, window, cx));
        }
        if self.cwd.read(cx).value().as_ref() != cwd {
            self.cwd
                .update(cx, |state, cx| state.set_value(cwd, window, cx));
        }
        self.sync_project_picker(window, cx);
        self.sync_models(window, cx);
        self.load_question_input(window, cx);
    }

    fn changed(&mut self, cx: &mut Context<Self>) {
        if self.update_checkpoint.is_some() {
            return;
        }
        self.record_edit(false, cx);
        self.record_question_edit(false, cx);
    }
    fn record_edit(&mut self, force: bool, cx: &mut Context<Self>) {
        let Some(key) = self.selected.clone() else {
            return;
        };
        if self
            .discarding
            .as_ref()
            .is_some_and(|(discarding, ..)| discarding == &key)
        {
            return;
        }
        let Some(draft) = self.cache.get(&key) else {
            return;
        };
        if !force
            && self.shown_text(&key, draft) == self.text.read(cx).value().as_ref()
            && draft.cwd == self.cwd.read(cx).value().as_ref()
        {
            return;
        }
        let Some(draft) = self.cache.get_mut(&key) else {
            return;
        };
        draft.revision += 1;
        draft.text = self.text.read(cx).value().to_string();
        draft.cwd = self.cwd.read(cx).value().to_string();
        self.error = if draft.text.len() > TEXT_CAP {
            Some("Draft exceeds 32 KiB. Reduce it or copy it; it cannot be sent or saved yet.")
        } else if self
            .client
            .as_ref()
            .is_some_and(|client| client.edit(key.clone(), draft.clone()))
        {
            None
        } else {
            Some(
                "Draft save could not be queued. Text stays in this window; copy it before closing.",
            )
        };
        if self.error.is_some() {
            self.unsaved_local.insert(key);
        } else {
            self.unsaved_local.remove(&key);
        }
        cx.emit(EditorEvent::DraftsChanged);
        cx.notify();
    }

    /// Removes the selected draft. Its text is copied out first, and the store abandons any
    /// unresolved delivery, so the same operation is never sent again.
    fn discard_draft(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.question_blocks_discard(cx) || self.question_marked(window, cx) {
            cx.notify();
            return;
        }
        let Some(key) = self.selected.clone() else {
            return;
        };
        let Some(draft) = self.cache.get(&key).cloned() else {
            return;
        };
        let mut copied = draft.text.clone();
        if copied.trim().is_empty() {
            copied = draft.recovered.join("\n\n");
        }
        if !copied.is_empty() {
            cx.write_to_clipboard(gpui_kit::ClipboardItem::new_string(copied));
        }
        let queued = self.client.as_ref().is_some_and(|client| {
            client.command(WriteCommand::Discard {
                key: key.clone(),
                revision: draft.revision,
            })
        });
        if !queued {
            self.error = Some(
                "The draft could not be discarded now. It stays retained; copy its text before retrying.",
            );
            cx.notify();
            return;
        }
        self.cache.remove(&key);
        self.error = None;
        self.browse_empty(window, cx);
        cx.emit(EditorEvent::DraftsChanged);
        cx.notify();
    }

    pub(crate) fn accept(
        &mut self,
        state: WriteState,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.changed(cx);
        let shown = self.visible_sends();
        let marked = self.marked(window, cx);
        if let Some(book) = &state.book {
            for (key, saved) in &book.drafts {
                match self.cache.get_mut(key) {
                    Some(local)
                        if local.revision > saved.revision
                            || (marked && self.selected.as_ref() == Some(key)) =>
                    {
                        local.pending = saved.pending.clone();
                        local.last = saved.last.clone();
                        local.created = saved.created.clone();
                        local.recovered = saved.recovered.clone();
                        local.recovery_revision = saved.recovery_revision;
                        local.settled_revision = saved.settled_revision;
                    }
                    _ => {
                        self.cache.insert(key.clone(), saved.clone());
                    }
                }
            }
            // Only empty acknowledged creation slots may disappear from the store.
            self.cache.retain(|key, draft| {
                !key.starts_with("new:")
                    || book.drafts.contains_key(key)
                    || draft.created.is_none()
                    || !draft.text.is_empty()
            });
        }
        self.pending.retain(|key, request| {
            state
                .handled
                .get(key)
                .is_none_or(|handled| handled < request)
        });
        self.sending.retain(|key, _| self.pending.contains_key(key));
        self.state = state;
        self.accept_draft_discard(window, cx);
        self.note_delivered(shown);
        if self.update_checkpoint.is_some() {
            cx.emit(EditorEvent::UpdateCheckpoint);
            cx.notify();
            return;
        }
        self.accept_model_action(window, cx);
        if self.state.error.is_some() {
            self.retiring.clear();
            if !self.state.flushed {
                self.closing = false;
            }
        }
        if let Some(book) = &self.state.book {
            for (key, saved) in &book.drafts {
                if key.starts_with("chat:")
                    && saved.text.is_empty()
                    && saved.pending.is_none()
                    && saved.recovered.is_empty()
                    && saved.answer.is_none()
                    && (saved.last.is_some() || saved.revision > 0)
                    && self.cache.get(key).is_some_and(|local| {
                        local.revision == saved.revision && local.text.is_empty()
                    })
                    && self.retiring.get(key) != Some(&saved.revision)
                    && let Some(client) = &self.client
                    && client.command(WriteCommand::RetireEmpty {
                        key: key.clone(),
                        revision: saved.revision,
                    })
                {
                    self.retiring.insert(key.clone(), saved.revision);
                }
            }
            self.retiring.retain(|key, _| book.drafts.contains_key(key));
            self.cache.retain(|key, draft| {
                book.drafts.contains_key(key)
                    || self
                        .discarding
                        .as_ref()
                        .is_some_and(|(discarding, ..)| discarding == key)
                    || self.selected.as_ref() == Some(key)
                    || !draft.text.is_empty()
                    || !draft.recovered.is_empty()
                    || self.pending.contains_key(key)
                    || self.unsaved_local.contains(key)
            });
        }
        if !marked {
            self.load_input(window, cx);
            self.retire_settled_question(cx);
        }
        self.open_completed(cx);
        if self.state.flushed {
            cx.emit(EditorEvent::Flushed);
        }
        cx.emit(EditorEvent::DraftsChanged);
        cx.notify();
    }

    fn open_completed(&mut self, cx: &mut Context<Self>) {
        if self.closing {
            return;
        }
        if let Some((key, draft)) = self
            .selected
            .as_ref()
            .and_then(|key| self.cache.get(key).map(|d| (key, d)))
            && key.starts_with("new:")
            && draft.text.is_empty()
            && let Some(target) = &draft.created
        {
            cx.emit(EditorEvent::OpenCreated {
                key: key.clone(),
                revision: draft.revision,
                target: target.clone(),
            });
        }
    }

    fn draft(&self) -> Option<&Draft> {
        self.selected.as_ref().and_then(|key| self.cache.get(key))
    }
    fn waiting(&self) -> bool {
        self.discarding
            .as_ref()
            .is_some_and(|(key, ..)| self.selected.as_ref() == Some(key))
            || self
                .selected
                .as_ref()
                .is_some_and(|key| self.pending.contains_key(key))
            || self.draft().is_some_and(|d| d.pending.is_some())
    }
    fn stop_button(&self, id: &'static str, cx: &mut Context<Self>) -> Button {
        let selected = self.selected.clone();
        crate::ui::icon_action(
            id,
            "Stop current work",
            AppIcon::Stop,
            crate::ui::Action::Secondary,
        )
        .rounded_full()
        .size_6()
        .tooltip(if self.waiting() {
            "Waiting for the last action to finish. Stop is unavailable until then."
        } else {
            "Stop current work. Withdrawn queued text is kept for recovery."
        })
        .disabled(!self.ready() || !self.writable || self.waiting() || self.error.is_some())
        .on_click(cx.listener(move |view, _, window, cx| {
            if view.selected == selected {
                view.submit(true, window, cx);
            }
        }))
    }
    fn submit(&mut self, stop: bool, window: &mut Window, cx: &mut Context<Self>) {
        self.submit_mode(stop, false, window, cx);
    }

    // Swift: Return/button steers (or starts); Option-Return explicitly queues.
    // This choice is captured once in the existing immutable delivery envelope.
    fn submit_mode(
        &mut self,
        stop: bool,
        follow_up: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !stop && self.questions.current.is_some() {
            self.answer_question(None, window, cx);
            return;
        }
        self.changed(cx);
        if !self.ready()
            || !self.writable
            || self.waiting()
            || self.marked(window, cx)
            || self.error.is_some()
            || (!stop && self.models_block_send())
        {
            return;
        }
        let (Some(key), Some(draft)) = (self.selected.clone(), self.draft().cloned()) else {
            return;
        };
        if !draft.editable()
            || (!stop && draft.text.trim().is_empty())
            || draft.text.len() > TEXT_CAP
        {
            return;
        }
        if !stop
            && key.starts_with("new:")
            && (self.project_problem(&draft).is_some() || self.new_model_problem(&draft).is_some())
        {
            // Catalog validation is derived and already shown beside the picker.
            // Do not latch it into the unrelated save/write error fence.
            cx.notify();
            return;
        }
        if stop && (!key.starts_with("chat:") || !self.busy) {
            return;
        }
        self.next_request += 1;
        let request = self.next_request;
        let draft_revision = draft.revision;
        if self.client.as_ref().is_some_and(|client| {
            client.command(WriteCommand::Submit {
                key: key.clone(),
                draft: Box::new(draft),
                follow_up,
                stop,
                request,
            })
        }) {
            self.pending.insert(key.clone(), request);
            self.error = None;
            if !stop && key.starts_with("chat:") {
                // The message moves to the conversation; the draft keeps it until accepted.
                self.sending.insert(key.clone(), draft_revision);
                self.delivered.remove(&key);
                self.load_input(window, cx);
                cx.emit(EditorEvent::DraftsChanged);
            }
            if stop {
                self.thinking = false;
                self.thinking_held = true;
                cx.emit(EditorEvent::StopRequested { key });
            } else {
                self.takeoff.start(cx);
            }
        } else {
            self.error = Some("Local action queue is busy. Nothing new was submitted.");
        }
        cx.notify();
    }

    pub(crate) fn request_close(&mut self, cx: &mut Context<Self>) -> bool {
        if self.update_checkpoint.is_some() {
            return false;
        }
        self.changed(cx);
        if self.client.is_none() {
            return true;
        }
        if !self.unsaved_local.is_empty() {
            self.error = Some(
                "Some text could not be saved. Return to those drafts and reduce/copy it before closing.",
            );
            cx.notify();
            return false;
        }
        if !self.closing
            && let Some(client) = &self.client
        {
            self.closing = client.command(WriteCommand::Close);
        }
        cx.notify();
        false
    }
    /// Find must not steal keys from question fields or model/project editors.
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    pub(crate) fn begin_update_checkpoint(
        &mut self,
        generation: u64,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        if !self.ready()
            || self.discarding.is_some()
            || self.marked(window, cx)
            || !self.unsaved_local.is_empty()
            || !self.pending.is_empty()
            || self
                .state
                .book
                .as_ref()
                .is_none_or(|b| !b.restart_settled())
        {
            return false;
        }
        self.close_paths(cx);
        self.record_edit(true, cx);
        self.record_question_edit(true, cx);
        self.update_checkpoint = Some(generation);
        if !self
            .client
            .as_ref()
            .is_some_and(|client| client.command(WriteCommand::Checkpoint(generation)))
        {
            self.update_checkpoint = None;
            return false;
        }
        cx.notify();
        true
    }
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    pub(crate) fn update_receipt(
        &self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<u64> {
        let generation = self.update_checkpoint?;
        if self.state.checkpoint != Some(generation)
            || self.state.error.is_some()
            || !self.unsaved_local.is_empty()
            || self.marked(window, cx)
        {
            return None;
        }
        let book = self.state.book.as_ref()?;
        if let Some(key) = &self.selected {
            let draft = self.cache.get(key)?;
            if draft.text != self.text.read(cx).value().as_ref()
                || draft.cwd != self.cwd.read(cx).value().as_ref()
            {
                return None;
            }
            if !self.question_checkpoint_matches(cx) {
                return None;
            }
        }
        if !book.restart_settled()
            || !self.cache.iter().all(|(key, draft)| {
                book.drafts.get(key) == Some(draft)
                    || (self.selected.as_ref() != Some(key) && draft == &Draft::default())
            })
        {
            return None;
        }
        Some(generation)
    }
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    pub(crate) fn end_update_checkpoint(&mut self, cx: &mut Context<Self>) {
        self.update_checkpoint = None;
        cx.notify();
    }

    /// Find must not steal keys from question fields or model/project editors.
    pub(crate) fn conversation_find_ready(
        &self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        use gpui_kit::Focusable;
        self.questions.current.is_none()
            && self.text.read(cx).focus_handle(cx).is_focused(window)
            && !self.marked(window, cx)
    }
    pub(crate) fn focus(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.ready() && self.selected.is_some() {
            if self.questions.current.is_some() {
                self.questions
                    .input
                    .update(cx, |state, cx| state.focus(window, cx));
            } else {
                self.text.update(cx, |state, cx| state.focus(window, cx));
            }
        }
    }
    /// The retained observation of this draft's exact operation, never another tuple's.
    fn delivery_observation(
        &self,
        key: &str,
        draft: &Draft,
    ) -> Option<(
        String,
        crate::delivery_store::diagnostic::Diagnostic,
        Option<&crate::interaction::DeliveryReport>,
    )> {
        let book = self.state.book.as_ref()?;
        let summary = if let Some(id) = &draft.pending {
            let intent = book.pending.get(id).filter(|i| i.key == key)?;
            crate::delivery_store::Delivery::from_intent(intent)
        } else {
            draft.last.clone()?
        };
        let report = self
            .state
            .delivery_reports
            .get(&summary.id)
            .filter(|r| r.key == key && r.delivery.same_operation(&summary));
        let diagnostic = report
            .and_then(|r| r.delivery.diagnostic)
            .or(summary.diagnostic)?;
        Some((summary.id, diagnostic, report))
    }
    fn delivery_detail(&self, key: &str, draft: &Draft) -> Option<(String, String)> {
        let (id, diagnostic, report) = self.delivery_observation(key, draft)?;
        let mut caption = diagnostic.caption();
        if let Some(report) = report
            && !report.saved
        {
            use crate::delivery_store::diagnostic::Category;
            caption.push_str(
                match report
                    .save_error
                    .filter(|error| *error != diagnostic.category)
                {
                    Some(Category::PrivateCapacity) => {
                        " Details not durably confirmed for restart: storage full."
                    }
                    Some(Category::PrivateWrite) => {
                        " Details not durably confirmed for restart: private write failed."
                    }
                    _ => " Details not durably confirmed for restart.",
                },
            );
        }
        Some((id, caption))
    }
    pub(crate) fn resource_navigation_issue(&self) -> Option<&'static str> {
        self.state
            .error
            .or(self.error)
            .or(self.closing.then_some("Private drafts are closing."))
    }
    pub(crate) fn capture_navigation(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        if self.marked(window, cx) {
            return false;
        }
        if !self.retire_project_picker(window, cx) {
            return false;
        }
        self.changed(cx);
        true
    }
    /// Puts a retained, never-sent queue edit into this chat's empty composer,
    /// like typing. Never sends and never overwrites; false leaves it with the queue.
    pub(crate) fn restore_queued_text(
        &mut self,
        chat: &str,
        text: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let key = format!("chat:{chat}");
        if self.selected.as_deref() != Some(key.as_str())
            || !self.ready()
            || !self.writable
            || self.error.is_some()
            || self.questions.current.is_some()
            || self.waiting()
            || self.sending.contains_key(&key)
            || self.sending(chat).is_some()
            || self.marked(window, cx)
            || text.len() > TEXT_CAP
            || !self.text.read(cx).value().is_empty()
        {
            return false;
        }
        self.text.update(cx, |state, cx| {
            state.set_value(text.to_owned(), window, cx);
            state.focus(window, cx);
        });
        self.changed(cx);
        true
    }
    pub(crate) fn can_adopt_creation(
        &mut self,
        key: &str,
        revision: u64,
        target: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        self.capture_navigation(window, cx)
            && self.selected.as_deref() == Some(key)
            && self.draft().is_some_and(|d| {
                d.revision == revision && d.text.is_empty() && d.created.as_deref() == Some(target)
            })
    }
}

/// Send's arrow: lifts and fades out, then lands from just below. Paint-only.
fn takeoff_icon(t: f32) -> gpui_kit::component::Icon {
    use crate::transition::ease_out;
    let icon = gpui_kit::component::Icon::new(AppIcon::Send.asset());
    if t >= 1. {
        return icon;
    }
    let (dy, alpha) = if t < 0.5 {
        let p = ease_out(t * 2.);
        (-10. * p, 1. - p)
    } else {
        let q = ease_out((t - 0.5) * 2.);
        (6. * (1. - q), q)
    };
    icon.transform(gpui_kit::Transformation::translate(gpui_kit::point(
        px(0.),
        px(dy),
    )))
    .opacity(alpha)
}
impl Render for ChatEditor {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let takeoff = self
            .takeoff
            .progress(std::time::Duration::from_millis(360), window, cx);
        let Some(key) = self.selected.clone() else {
            let mut empty = div()
                .px_3()
                .text_xs()
                .text_color(cx.theme().muted_foreground);
            if let Some(error) = self.state.error {
                empty = empty.text_color(cx.theme().danger).child(error);
            }
            if !self.state.notice.is_empty() {
                empty = empty.child(div().child(self.state.notice));
            }
            return empty.into_any_element();
        };
        let is_new = key.starts_with("new:");
        // The placeholder states what typing does here, including read-only.
        let placeholder = if !self.writable {
            "This chat is read-only."
        } else if is_new {
            "Describe the task…"
        } else if self.busy {
            "Steer the agent…"
        } else {
            "Reply to Pilot…"
        };
        if self.placeholder != placeholder {
            self.placeholder = placeholder;
            self.text
                .update(cx, |text, cx| text.set_placeholder(placeholder, window, cx));
        }
        let blank = Draft::default();
        let draft = self.draft().unwrap_or(&blank);
        let can_edit = self.writable
            && self.state.book.is_some()
            && !self.closing
            && !self
                .discarding
                .as_ref()
                .is_some_and(|(discarding, ..)| discarding == &key);
        let blocked = !self.ready() || !self.writable || self.waiting() || self.error.is_some();
        let submitting = self.pending.contains_key(&key);
        let settled = draft
            .settled_revision
            .is_some_and(|revision| draft.revision <= revision);
        let send_key = key.clone();
        let pending = draft
            .pending
            .as_ref()
            .and_then(|id| self.state.book.as_ref().and_then(|b| b.pending.get(id)));
        // A settled empty chat draft disappears on its own. A new-chat slot and an
        // unresolved delivery never retire by themselves, so they can be discarded.
        // No dither here: list rows carry state, and the working line says the rest.
        let footer = div()
            .id("composer-tray")
            .v_flex()
            .relative()
            .overflow_hidden()
            .bg(crate::appearance::tray(cx))
            .p_1()
            .gap_2()
            .rounded(px(crate::appearance::Radius::TRAY))
            .shadow(vec![gpui_kit::BoxShadow {
                inset: false,
                color: gpui_kit::hsla(0., 0., 0., 0.06),
                offset: gpui_kit::point(px(0.), px(4.)),
                blur_radius: px(12.),
                spread_radius: px(0.),
            }])
            .border_1()
            .border_color(cx.theme().border);
        #[cfg(any(test, feature = "native-probes"))]
        let footer = footer.test_support();
        let mut footer = footer;
        // Kit owns the editor's text padding. Keep its opaque card on the tray
        // without adding a second padded wrapper or outline; dither stays behind text.
        let input = div()
            .id("composer-input")
            .w_full()
            .min_w_0()
            .rounded(px(crate::appearance::Radius::CARD))
            .bg(crate::appearance::card(cx))
            .capture_action(
                cx.listener(|v, _: &gpui_kit::base::input::IndentInline, w, cx| {
                    if v.marked(w, cx) {
                        cx.stop_propagation();
                        return;
                    }
                    if v.path_tab(w, cx) {
                        cx.stop_propagation();
                    }
                }),
            )
            .capture_action(cx.listener(|v, e: &gpui_kit::base::input::Enter, w, cx| {
                if v.path_open() && !e.shift {
                    cx.stop_propagation();
                    v.path_accept_selected(w, cx);
                }
            }))
            .capture_action(cx.listener(|v, _: &gpui_kit::base::input::Escape, w, cx| {
                if v.path_open() {
                    cx.stop_propagation();
                    if !v.marked(w, cx) {
                        v.close_paths(cx);
                    }
                }
            }))
            .capture_action(cx.listener(|v, _: &gpui_kit::base::input::MoveUp, w, cx| {
                if v.path_open() {
                    cx.stop_propagation();
                    if !v.marked(w, cx) {
                        v.path_move(-1, cx);
                    }
                }
            }))
            .capture_action(
                cx.listener(|v, _: &gpui_kit::base::input::MoveDown, w, cx| {
                    if v.path_open() {
                        cx.stop_propagation();
                        if !v.marked(w, cx) {
                            v.path_move(1, cx);
                        }
                    }
                }),
            )
            .capture_key_down(
                cx.listener(|view, event: &gpui_kit::KeyDownEvent, window, cx| {
                    let key = &event.keystroke;
                    if view.path_open() && key.key == "enter" && !key.modifiers.shift {
                        cx.stop_propagation();
                        view.path_accept_selected(window, cx);
                        return;
                    }
                    if key.key == "enter"
                        && key.modifiers.alt
                        && !key.modifiers.shift
                        && !key.modifiers.control
                        && !key.modifiers.platform
                    {
                        // Scoped to the ordinary textarea, never question choices or
                        // model/project fields. Consume even when guarded by preedit.
                        cx.stop_propagation();
                        view.submit_mode(false, true, window, cx);
                    }
                }),
            )
            .child(
                Textarea::new(&self.text)
                    .appearance(false)
                    .bordered(false)
                    .readonly(!can_edit)
                    .aria_label("Message to Pilot"),
            );
        #[cfg(any(test, feature = "native-probes"))]
        let input = input.test_support();
        let stop_slot = div()
            .id("composer-stop-slot")
            .size_6()
            .flex_shrink_0()
            .when(!is_new && self.busy, |slot| {
                slot.child(self.stop_button("local-stop", cx))
            });
        #[cfg(any(test, feature = "native-probes"))]
        let stop_slot = stop_slot.test_support();
        let controls = div()
            .id("composer-controls")
            .h_flex()
            .w_full()
            .min_w_0()
            .justify_between()
            .gap_2()
            .px(px(6.))
            .py(px(6.))
            .child(
                div()
                    .h_flex()
                    .gap_2()
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .text_xs()
                    .text_color(cx.theme().muted_foreground)
                    .when(self.models.is_some(), |v| v.child(self.model_controls(cx)))
                    // Routine autosave is silent; only states that block sending speak.
                    // Read-only is said by the placeholder, not repeated here.
                    // A chat message being sent says so in the conversation instead.
                    .children(((submitting && !self.sending.contains_key(&key)) || (self.models.is_none() && self.closing)).then_some(if submitting {
                        "Sending…"
                    } else {
                        "Saving before closing…"
                    })),
            )
            .child(
                div()
                    .h_flex()
                    .flex_shrink_0()
                    .gap_2()
                    // Reserve the same small slot while idle. Work transitions
                    // neither move Send nor mount an irrelevant disabled action.
                    .children((!is_new).then(|| self.context_entry.clone()).flatten())
                    .child(stop_slot)
                    .child({
                        let label = if settled && !draft.text.is_empty() {
                            "Edit to resend"
                        } else if is_new {
                            "Create chat"
                        } else {
                            "Send"
                        };
                        // Ordinary Send is a familiar arrow; other states keep their words.
                        Button::new("local-send")
                            .primary()
                            .small()
                            .icon(takeoff_icon(takeoff))
                            .when(label != "Send", |b| b.label(label))
                            .accessibility_label(label)
                            .tooltip(if self.busy {
                                "Steer current work (Enter). Queue a follow-up with Option-Enter. Never stops the current run."
                            } else {
                                "Send (Enter). Option-Enter sends as a follow-up; Shift-Enter inserts a new line."
                            })
                            .disabled(
                                blocked
                                    || settled
                                    || !draft.editable()
                                    || draft.text.trim().is_empty()
                                    || (is_new && self.project_problem(draft).is_some())
                                    || self.models_block_send()
                                    || (is_new && self.new_model_problem(draft).is_some()),
                            )
                            .on_click(cx.listener(move |view, _, window, cx| {
                                if view.selected.as_ref() == Some(&send_key) {
                                    view.submit(false, window, cx);
                                }
                            }))
                    }),
            );
        #[cfg(any(test, feature = "native-probes"))]
        let controls = controls.test_support();
        // Recovery belongs to the conversation, above the editor, never inside
        // its tray. Keep every existing notice/Unknown guard and action owner.
        let mut recovery = Vec::new();
        recovery.extend(self.question_recovery(cx));
        if !is_new {
            recovery.extend(self.subscription_row(cx));
        }
        if self.models.is_some() && self.has_model_notice() {
            recovery.push(self.model_notices(cx).into_any_element());
        }
        if let Some(error) = self.error.or(self.state.error) {
            recovery.push(
                div()
                    .text_xs()
                    .text_color(cx.theme().danger)
                    .child(error)
                    .into_any_element(),
            );
        }
        // While the request runs, Sending… in the controls row is the whole story.
        let delivery_status = if submitting {
            None
        } else if let Some(intent) = pending {
            use crate::delivery_store::diagnostic::Acknowledgment;
            // Local's answer is known; only Pilot's own receipt save failed.
            let acknowledged = self
                .delivery_observation(&key, draft)
                .map(|(_, d, _)| d.acknowledgment);
            Some(if intent.operation.is_none() {
                "Couldn't confirm that Stop reached the agent."
            } else if intent.state == "pending" {
                "Sending…"
            } else {
                match acknowledged {
                    Some(Acknowledgment::Accepted) => "Sent. Pilot couldn't save the receipt.",
                    Some(Acknowledgment::Pending) => "Sending. Pilot couldn't save the receipt.",
                    Some(Acknowledgment::Rejected) => "Not sent. Pilot couldn't save the receipt.",
                    _ => "Couldn't confirm this message was sent.",
                }
            })
        } else if draft
            .last
            .as_ref()
            .is_some_and(|last| last.state == "rejected")
        {
            Some("This message wasn't sent. Edit it and send again.")
        } else {
            None
        };
        // The message and its Resolve menu share one row, so the action reads
        // as belonging to the message rather than as a separate toolbar.
        let status = delivery_status.map(|message| {
            let status = div()
                .id("delivery-recovery-status")
                .min_w_0()
                .aria_label(message)
                .child(crate::ui::text(crate::ui::Text::Caption, message));
            #[cfg(any(test, feature = "native-probes"))]
            let status = status.test_support();
            status
        });
        // Reports remain retained; transport and receipt detail is available
        // only inside contextual Recovery, never as successful-send chatter.
        let delivery_id = draft
            .pending
            .as_ref()
            .or_else(|| draft.last.as_ref().map(|last| &last.id));
        if !self.state.notice.is_empty()
            && !matches!(self.state.notice, "Draft saved." | "Drafts saved.")
            && pending.is_none()
            && !delivery_id.is_some_and(|id| self.state.delivery_notice.as_ref() == Some(id))
            && self
                .state
                .notice_key
                .as_ref()
                .is_none_or(|notice_key| notice_key == &key)
        {
            recovery.push(
                div()
                    .text_xs()
                    .text_color(cx.theme().muted_foreground)
                    .child(self.state.notice)
                    .into_any_element(),
            );
        }
        let show_menu = (draft.pending.is_some() && !submitting)
            || draft.created.is_some()
            || !draft.recovered.is_empty()
            || draft
                .last
                .as_ref()
                .is_some_and(|last| last.state == "rejected");
        let menu = if show_menu {
            Some(self.recovery_menu(&key, window, cx).into_any_element())
        } else {
            None
        };
        if status.is_some() || menu.is_some() {
            recovery.push(
                div()
                    .h_flex()
                    .flex_wrap()
                    .items_center()
                    .gap_2()
                    .min_w_0()
                    .children(status)
                    .children(menu)
                    .into_any_element(),
            );
        }
        let mut shell = div().v_flex().min_w_0().gap_1().mx_3().mb_3().mt(px(6.));
        if is_new {
            shell = shell
                .gap(px(crate::ui::Space::SIDEBAR))
                .child(self.new_chat_setup(draft, blocked, window, cx));
        }
        if let Some(label) = self.activity_label() {
            let indicator = div()
                .id("activity-indicator")
                .px(px(10.))
                .text_xs()
                .text_color(cx.theme().muted_foreground)
                .child(label);
            #[cfg(any(test, feature = "native-probes"))]
            let indicator = indicator.test_support();
            shell = shell.child(indicator);
        }
        if !is_new {
            footer = footer.children(self.queue_entry.clone());
        }
        if let Some(question) = self.question_panel(cx) {
            footer = footer.child(question);
        } else {
            footer = footer.child(div().v_flex().min_w_0().child(input).child(controls));
        }
        shell
            .when(!recovery.is_empty(), |shell| {
                let region = div()
                    .id("composer-recovery-region")
                    .v_flex()
                    .min_w_0()
                    // Same inset as the working line, so recovery reads as one column.
                    // New chat has no working line: align with its setup text instead.
                    .px(px(if is_new { 0. } else { 10. }))
                    .gap_2()
                    .children(recovery);
                #[cfg(any(test, feature = "native-probes"))]
                let region = region.test_support();
                shell.child(region)
            })
            .children((!is_new).then(|| self.todos_entry.clone()).flatten())
            .relative()
            .children(self.path_suggestions(cx))
            .child(footer)
            .into_any_element()
    }
}

#[cfg(test)]
#[path = "chat_editor_tests.rs"]
mod tests;
