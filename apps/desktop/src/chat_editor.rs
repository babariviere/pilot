//! Local composer UI. Durable ownership lives in the private interaction worker.
use crate::{
    delivery_store::{DRAFT_CAP, Draft, TEXT_CAP},
    interaction::{Interaction, WriteCommand, WriteState},
};
use gpui_kit::{
    AppContext, Context, Entity, EntityInputHandler, EventEmitter, IntoElement, ParentElement,
    Render, SharedString, Styled, Subscription, Window,
    component::{
        ActiveTheme, Disableable, Sizable, StyledExt,
        button::{Button, ButtonVariants},
        checkbox::Checkbox,
        input::{Input, InputEvent, InputState, Textarea, TextareaState},
        radio::RadioGroup,
    },
    div,
    prelude::FluentBuilder,
    px,
};
use std::collections::{BTreeMap, BTreeSet};

pub(crate) enum EditorEvent {
    DraftsChanged,
    OpenCreated {
        key: String,
        revision: u64,
        target: String,
    },
    Flushed,
}

pub(crate) struct ChatEditor {
    client: Option<Interaction>,
    text: Entity<TextareaState>,
    cwd: Entity<InputState>,
    cache: BTreeMap<String, Draft>,
    selected: Option<String>,
    writable: bool,
    busy: bool,
    follow_up: bool,
    pending: BTreeMap<String, u64>,
    unsaved_local: BTreeSet<String>,
    retiring: BTreeMap<String, u64>,
    next_request: u64,
    state: WriteState,
    error: Option<&'static str>,
    closing: bool,
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
                .placeholder("Message Local chat…")
                .auto_grow(2, 6);
            state.set_submit_on_enter(true, cx);
            state
        });
        let cwd =
            cx.new(|cx| InputState::new(window, cx).placeholder("Absolute Local working folder"));
        let text_events =
            cx.subscribe_in(&text, window, |view, _, event, window, cx| match event {
                InputEvent::Change => view.changed(cx),
                InputEvent::PressEnter { shift: false, .. } => view.submit(false, window, cx),
                _ => {}
            });
        let cwd_events = cx.subscribe(&cwd, |view, _, event, cx| {
            if matches!(event, InputEvent::Change) {
                view.changed(cx);
            }
        });
        Self {
            client,
            text,
            cwd,
            cache: BTreeMap::new(),
            selected: None,
            writable: false,
            busy: false,
            follow_up: true,
            pending: BTreeMap::new(),
            unsaved_local: BTreeSet::new(),
            retiring: BTreeMap::new(),
            next_request: 0,
            state: WriteState::default(),
            error: None,
            closing: false,
            _subscriptions: vec![text_events, cwd_events],
        }
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
                || self.pending.contains_key(key)
                || self.unsaved_local.contains(key)
        });
    }
    pub(crate) fn ready(&self) -> bool {
        self.client.is_some()
            && self.state.book.is_some()
            && self.state.error.is_none()
            && !self.closing
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
                        "New Local chat draft".into()
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
        self.changed(cx);
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

    fn marked(&self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        self.text.update(cx, |state, cx| {
            state.marked_text_range(window, cx).is_some()
        })
    }
    fn load_input(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(draft) = self.selected.as_ref().and_then(|key| self.cache.get(key)) else {
            return;
        };
        let (text, cwd) = (draft.text.clone(), draft.cwd.clone());
        if self.text.read(cx).value().as_ref() != text {
            self.text
                .update(cx, |state, cx| state.set_value(text, window, cx));
        }
        if self.cwd.read(cx).value().as_ref() != cwd {
            self.cwd
                .update(cx, |state, cx| state.set_value(cwd, window, cx));
        }
    }

    fn changed(&mut self, cx: &mut Context<Self>) {
        self.record_edit(false, cx);
    }
    fn record_edit(&mut self, force: bool, cx: &mut Context<Self>) {
        let Some(key) = self.selected.clone() else {
            return;
        };
        let Some(draft) = self.cache.get_mut(&key) else {
            return;
        };
        if !force
            && draft.text == self.text.read(cx).value().as_ref()
            && draft.cwd == self.cwd.read(cx).value().as_ref()
        {
            return;
        }
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

    pub(crate) fn accept(
        &mut self,
        state: WriteState,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.changed(cx);
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
        self.state = state;
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
                    || self.selected.as_ref() == Some(key)
                    || !draft.text.is_empty()
                    || !draft.recovered.is_empty()
                    || self.pending.contains_key(key)
                    || self.unsaved_local.contains(key)
            });
        }
        if !marked {
            self.load_input(window, cx);
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
        self.selected
            .as_ref()
            .is_some_and(|key| self.pending.contains_key(key))
            || self.draft().is_some_and(|d| d.pending.is_some())
    }
    fn submit(&mut self, stop: bool, window: &mut Window, cx: &mut Context<Self>) {
        self.changed(cx);
        if !self.ready()
            || !self.writable
            || self.waiting()
            || self.marked(window, cx)
            || self.error.is_some()
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
        if stop && (!key.starts_with("chat:") || !self.busy) {
            return;
        }
        self.next_request += 1;
        let request = self.next_request;
        if self.client.as_ref().is_some_and(|client| {
            client.command(WriteCommand::Submit {
                key: key.clone(),
                draft: Box::new(draft),
                follow_up: self.follow_up,
                stop,
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

    pub(crate) fn request_close(&mut self, cx: &mut Context<Self>) -> bool {
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
    pub(crate) fn focus(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.ready() && self.selected.is_some() {
            self.text.update(cx, |state, cx| state.focus(window, cx));
        }
    }
}

impl Render for ChatEditor {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let Some(key) = self.selected.clone() else {
            return div()
                .px_3()
                .text_xs()
                .text_color(cx.theme().muted_foreground)
                .text_color(cx.theme().danger)
                .children(self.state.error)
                .into_any_element();
        };
        let blank = Draft::default();
        let draft = self.draft().unwrap_or(&blank);
        let is_new = key.starts_with("new:");
        let can_edit = self.writable && self.state.book.is_some() && !self.closing;
        let blocked = !self.ready() || !self.writable || self.waiting() || self.error.is_some();
        let settled = draft
            .settled_revision
            .is_some_and(|revision| draft.revision <= revision);
        let stop_key = key.clone();
        let send_key = key.clone();
        let saved = self
            .state
            .book
            .as_ref()
            .and_then(|b| b.drafts.get(&key))
            .is_some_and(|d| d.revision >= draft.revision)
            || (!is_new
                && draft.text.is_empty()
                && draft.pending.is_none()
                && !self.unsaved_local.contains(&key)
                && self.state.book.is_some());
        let pending = draft
            .pending
            .as_ref()
            .and_then(|id| self.state.book.as_ref().and_then(|b| b.pending.get(id)));
        let mut footer = div()
            .v_flex()
            .relative()
            .overflow_hidden()
            .bg(cx.theme().muted)
            .p_3()
            .gap_2()
            .border_t_1()
            .border_color(cx.theme().border)
            .when(self.busy, |this| {
                this.child(
                    crate::appearance::corner(crate::appearance::Corner::Working, cx).opacity(0.15),
                )
            });
        if is_new {
            footer = footer.child(
                div()
                    .h_flex()
                    .gap_2()
                    .child(
                        div().flex_1().min_w_0().child(
                            Input::new(&self.cwd)
                                .readonly(!can_edit)
                                .aria_label("Local working folder"),
                        ),
                    )
                    .child(
                        RadioGroup::new("new-chat-mode")
                            .children(["Ask", "Build"])
                            .selected_index(Some(usize::from(draft.mode == "build")))
                            .on_change(cx.listener(|view, index, _, cx| {
                                if !view.ready() {
                                    return;
                                }
                                if let Some(key) = &view.selected
                                    && let Some(draft) = view.cache.get_mut(key)
                                {
                                    draft.mode = if *index == 0 { "ask" } else { "build" }.into();
                                }
                                view.record_edit(true, cx);
                            })),
                    ),
            );
        }
        if self.busy {
            footer = footer.child(
                div()
                    .text_xs()
                    .text_color(cx.theme().muted_foreground)
                    .child("Working"),
            );
        }
        footer = footer.child(
            Textarea::new(&self.text)
                .readonly(!can_edit)
                .aria_label("Local chat message"),
        );
        footer = footer.child(
            div()
                .h_flex()
                .when(window.viewport_size().width < px(800.), |this| {
                    this.flex_col().items_start()
                })
                .justify_between()
                .gap_2()
                .child(
                    div()
                        .text_xs()
                        .text_color(cx.theme().muted_foreground)
                        .child(if self.closing {
                            "Saving before closing…"
                        } else if !self.writable {
                            "This chat is read-only."
                        } else if saved {
                            "Saved privately · Enter to send"
                        } else {
                            "Saving draft…"
                        }),
                )
                .child(
                    div()
                        .h_flex()
                        .gap_2()
                        .child(
                            Checkbox::new("follow-up")
                                .label("Follow-up")
                                .checked(self.follow_up)
                                .on_change(cx.listener(|view, next, _, cx| {
                                    view.follow_up = *next;
                                    cx.notify();
                                })),
                        )
                        .child(
                            Button::new("local-stop")
                                .small()
                                .ghost()
                                .label("Stop")
                                .disabled(blocked || is_new || !self.busy)
                                .on_click(cx.listener(move |view, _, window, cx| {
                                    if view.selected.as_ref() == Some(&stop_key) {
                                        view.submit(true, window, cx);
                                    }
                                })),
                        )
                        .child(
                            Button::new("local-send")
                                .primary()
                                .label(if settled && !draft.text.is_empty() {
                                    "Edit to resend"
                                } else if is_new {
                                    "Create chat"
                                } else {
                                    "Send"
                                })
                                .disabled(
                                    blocked
                                        || settled
                                        || !draft.editable()
                                        || draft.text.trim().is_empty()
                                        || (is_new
                                            && !std::path::Path::new(&draft.cwd).is_absolute()),
                                )
                                .on_click(cx.listener(move |view, _, window, cx| {
                                    if view.selected.as_ref() == Some(&send_key) {
                                        view.submit(false, window, cx);
                                    }
                                })),
                        ),
                ),
        );
        if let Some(error) = self.error.or(self.state.error) {
            footer = footer.child(div().text_xs().text_color(cx.theme().danger).child(error));
        }
        if let Some(intent) = pending {
            let id = intent.id.clone();
            let retry_id = id.clone();
            let dismiss_id = id.clone();
            footer = footer.child(
                div()
                    .h_flex()
                    .gap_2()
                    .child(div().text_xs().child(SharedString::from(format!(
                        "Delivery {}. Original intent retained.",
                        intent.state
                    ))))
                    .child(
                        Button::new("check-delivery")
                            .small()
                            .label("Check")
                            .disabled(intent.operation.is_none())
                            .on_click(cx.listener(move |view, _, _, _| {
                                if let Some(client) = &view.client {
                                    client.command(WriteCommand::Check {
                                        id: id.clone(),
                                        retry: false,
                                    });
                                }
                            })),
                    )
                    .child(
                        Button::new("retry-delivery")
                            .small()
                            .label("Retry same intent")
                            .disabled(intent.operation.is_none() || intent.state == "pending")
                            .on_click(cx.listener(move |view, _, _, _| {
                                if let Some(client) = &view.client {
                                    client.command(WriteCommand::Check {
                                        id: retry_id.clone(),
                                        retry: true,
                                    });
                                }
                            })),
                    )
                    .child(
                        Button::new("dismiss-stop")
                            .small()
                            .label("Acknowledge Stop uncertainty")
                            .disabled(intent.operation.is_some())
                            .on_click(cx.listener(move |view, _, _, _| {
                                if let Some(client) = &view.client {
                                    client.command(WriteCommand::DismissStop {
                                        id: dismiss_id.clone(),
                                    });
                                }
                            })),
                    ),
            );
        } else if let Some(last) = &draft.last {
            footer = footer.child(
                div()
                    .text_xs()
                    .text_color(cx.theme().muted_foreground)
                    .child(SharedString::from(format!(
                        "{}: {}. {}",
                        last.kind,
                        last.state,
                        if last.state == "rejected" {
                            "Edit the draft before another attempt."
                        } else {
                            ""
                        }
                    ))),
            );
        }
        if !self.state.notice.is_empty()
            && self
                .state
                .notice_key
                .as_ref()
                .is_none_or(|notice_key| notice_key == &key)
        {
            footer = footer.child(
                div()
                    .text_xs()
                    .text_color(cx.theme().muted_foreground)
                    .child(self.state.notice),
            );
        }
        if let Some(target) = draft.created.clone() {
            let key = key.clone();
            let revision = draft.revision;
            footer = footer.child(
                Button::new("open-created")
                    .small()
                    .label("Open created chat (draft stays here)")
                    .on_click(cx.listener(move |_, _, _, cx| {
                        cx.emit(EditorEvent::OpenCreated {
                            key: key.clone(),
                            revision,
                            target: target.clone(),
                        })
                    })),
            );
        }
        if !draft.recovered.is_empty() {
            let revision = draft.recovery_revision;
            let recovery_key = key.clone();
            let copy_key = key.clone();
            footer = footer.child(
                div()
                    .h_flex()
                    .gap_2()
                    .child(
                        Button::new("copy-recovered")
                            .small()
                            .label("Copy recovered text")
                            .on_click(cx.listener(move |view, _, _, cx| {
                                if let Some(draft) = view.cache.get(&copy_key) {
                                    cx.write_to_clipboard(gpui_kit::ClipboardItem::new_string(
                                        draft.recovered.join("\n\n"),
                                    ));
                                }
                            })),
                    )
                    .child(
                        Button::new("remove-recovered")
                            .small()
                            .label("Remove recovered text")
                            .on_click(cx.listener(move |view, _, _, _| {
                                if let Some(client) = &view.client {
                                    client.command(WriteCommand::ClearRecovery {
                                        key: recovery_key.clone(),
                                        revision,
                                    });
                                }
                            })),
                    ),
            );
        }
        footer.into_any_element()
    }
}

#[cfg(test)]
#[path = "chat_editor_tests.rs"]
mod tests;
