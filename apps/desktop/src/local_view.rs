//! Readonly Local browser. The transport is never given UI events capable of writing.
use crate::{
    LocalOptions, TranscriptView,
    chat_editor::{ChatEditor, EditorEvent},
    delivery_store::Store,
    interaction::{Interaction, WriteCommand},
    local_client::{Command, LocalClient, Presentation},
    local_model::Chat,
    model::Message,
};
use gpui_kit::{
    App, AppContext, Context, Entity, InteractiveElement, IntoElement, ParentElement, Render,
    SharedString, Styled, Subscription, Task, Window,
    component::{
        ActiveTheme, Disableable, IndexPath, Sizable, StyledExt,
        button::Button,
        checkbox::Checkbox,
        list::{List, ListDelegate, ListEvent, ListItem, ListState},
    },
    div,
};
use std::{sync::Arc, time::Duration};

struct ChatList {
    all: Arc<Vec<Chat>>,
    filtered: Vec<usize>,
    query: String,
    archived: bool,
    selected: Option<IndexPath>,
}
impl ChatList {
    fn filter(&mut self) {
        self.filtered = self
            .all
            .iter()
            .enumerate()
            .filter(|(_, c)| {
                (self.archived || !c.archived) && c.title.to_lowercase().contains(&self.query)
            })
            .map(|(ix, _)| ix)
            .collect();
    }
    fn at(&self, ix: IndexPath) -> Option<&Chat> {
        self.filtered.get(ix.row).and_then(|ix| self.all.get(*ix))
    }
}
impl ListDelegate for ChatList {
    type Item = ListItem;
    fn items_count(&self, _: usize, _: &App) -> usize {
        self.filtered.len()
    }
    fn render_item(
        &mut self,
        ix: IndexPath,
        _: &mut Window,
        cx: &mut Context<ListState<Self>>,
    ) -> Option<ListItem> {
        let chat = self.at(ix)?;
        Some(
            ListItem::new(SharedString::from(chat.id.clone()))
                .selected(self.selected == Some(ix))
                .child(
                    div()
                        .v_flex()
                        .min_w_0()
                        .w_full()
                        .gap_1()
                        .child(
                            div()
                                .truncate()
                                .child(SharedString::from(chat.title.clone())),
                        )
                        .child(
                            div()
                                .text_xs()
                                .text_color(cx.theme().muted_foreground)
                                .child(SharedString::from(format!(
                                    "{}{}",
                                    chat.state,
                                    if chat.archived { " · Archived" } else { "" }
                                ))),
                        ),
                ),
        )
    }
    fn set_selected_index(
        &mut self,
        ix: Option<IndexPath>,
        _: &mut Window,
        cx: &mut Context<ListState<Self>>,
    ) {
        self.selected = ix;
        cx.notify();
    }
    fn perform_search(
        &mut self,
        query: &str,
        _: &mut Window,
        _: &mut Context<ListState<Self>>,
    ) -> Task<()> {
        self.query = query.chars().take(240).collect::<String>().to_lowercase();
        self.filter();
        Task::ready(())
    }
    fn render_empty(
        &mut self,
        _: &mut Window,
        cx: &mut Context<ListState<Self>>,
    ) -> impl IntoElement {
        div()
            .p_4()
            .text_sm()
            .text_color(cx.theme().muted_foreground)
            .child("No matching chats.")
    }
}

pub struct LocalViewer {
    client: Option<LocalClient>,
    chats: Entity<ListState<ChatList>>,
    transcript: Entity<TranscriptView>,
    selected: Option<String>,
    title: String,
    generation: u64,
    state: Presentation,
    _subscriptions: Vec<Subscription>,
    updates: Option<Task<()>>,
    writes: Option<Task<()>>,
    editor: Entity<ChatEditor>,
    writer: Option<Interaction>,
    nav_chats: Arc<Vec<Chat>>,
    nav_drafts: Vec<(String, String)>,
}

impl LocalViewer {
    pub fn new(options: LocalOptions, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let (writer, write_updates) = Interaction::start(options.clone(), Store::default_path());
        let (client, updates) = LocalClient::start(options);
        let mut view = Self::build(Some(client), Some(writer), window, cx);
        view.updates = Some(cx.spawn_in(window, async move |view, cx| {
            while let Ok(update) = updates.recv().await {
                if view
                    .update_in(cx, |view, window, cx| view.accept(update, window, cx))
                    .is_err()
                {
                    break;
                }
                // Coalesce complete projections, not deltas, while respecting a busy UI.
                cx.background_executor()
                    .timer(Duration::from_millis(32))
                    .await;
            }
        }));
        view.writes = Some(cx.spawn_in(window, async move |view, cx| {
            while let Ok(state) = write_updates.recv().await {
                if view
                    .update_in(cx, |view, window, cx| {
                        view.editor
                            .update(cx, |editor, cx| editor.accept(state, window, cx))
                    })
                    .is_err()
                {
                    break;
                }
            }
        }));
        let weak = cx.weak_entity();
        window.on_window_should_close(cx, move |_, cx| {
            weak.update(cx, |view, cx| {
                view.editor
                    .update(cx, |editor, cx| editor.request_close(cx))
            })
            .unwrap_or(true)
        });
        view
    }

    /// Network-free production-view fixture for native rendering/interaction checks.
    pub fn synthetic(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let mut view = Self::build(None, None, window, cx);
        view.title = "Synthetic Local chat".into();
        view.selected = Some("synthetic".into());
        view.state.status = "Synthetic projection · no network".into();
        view.state.loaded = true;
        view.state.list_loaded = true;
        view.state.chats = Arc::new(vec![
            Chat {
                id: "synthetic".into(),
                title: "Synthetic Local chat".into(),
                state: "working".into(),
                archived: false,
                local_draft: false,
                writable: false,
                busy: true,
                cwd: String::new(),
            },
            Chat {
                id: "synthetic-two".into(),
                title: "Transcript review".into(),
                state: "idle".into(),
                archived: false,
                local_draft: false,
                writable: false,
                busy: false,
                cwd: String::new(),
            },
            Chat {
                id: "synthetic-archive".into(),
                title: "Earlier conversation".into(),
                state: "parked".into(),
                archived: true,
                local_draft: false,
                writable: false,
                busy: false,
                cwd: String::new(),
            },
        ]);
        view.chats.update(cx, |list, cx| {
            let delegate = list.delegate_mut();
            delegate.all = view.state.chats.clone();
            delegate.filter();
            list.set_selected_index(Some(IndexPath::new(0)), window, cx);
            cx.notify();
        });
        let mut rows: Vec<_> = (1..=48)
            .map(|id| {
                Message::live(
                    id,
                    format!("assistant · entry {id}"),
                    crate::model::REPLY.into(),
                )
            })
            .collect();
        rows.extend(crate::tool_presentation::fixture_work());
        view.transcript
            .update(cx, |view, cx| view.replace_readonly(rows, true, cx));
        view
    }

    /// Offscreen harness readiness, not a render-time gate.
    pub fn text_parsers_ready(&self, cx: &App) -> bool {
        self.transcript.read(cx).text_parsers_ready(cx)
    }
    fn build(
        client: Option<LocalClient>,
        writer: Option<Interaction>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let chats = cx.new(|cx| {
            ListState::new(
                ChatList {
                    all: Arc::new(Vec::new()),
                    filtered: Vec::new(),
                    query: String::new(),
                    archived: false,
                    selected: None,
                },
                window,
                cx,
            )
            .searchable(true)
        });
        let subscription = cx.subscribe_in(&chats, window, |view, list, event, window, cx| {
            if let ListEvent::Confirm(ix) = event {
                let chat = list.read(cx).delegate().at(*ix).cloned();
                if let Some(chat) = chat {
                    view.open(chat, window, cx);
                }
            }
        });
        chats.update(cx, |list, cx| list.focus(window, cx));
        let transcript = cx.new(|cx| TranscriptView::readonly(window, cx));
        let editor = cx.new(|cx| ChatEditor::new(writer.clone(), window, cx));
        let editor_events =
            cx.subscribe_in(&editor, window, |view, _, event, window, cx| match event {
                EditorEvent::DraftsChanged => view.rebuild_nav(window, cx),
                EditorEvent::Flushed => cx.quit(),
                EditorEvent::OpenCreated {
                    key,
                    revision,
                    target,
                } => {
                    view.open(
                        Chat {
                            id: target.clone(),
                            title: "Local chat".into(),
                            state: "starting".into(),
                            archived: false,
                            local_draft: false,
                            writable: true,
                            busy: true,
                            cwd: String::new(),
                        },
                        window,
                        cx,
                    );
                    if view.selected.as_ref() == Some(target)
                        && let Some(writer) = &view.writer
                    {
                        writer.command(WriteCommand::RetireCreated {
                            key: key.clone(),
                            revision: *revision,
                            target: target.clone(),
                        });
                    }
                }
            });
        Self {
            client,
            chats,
            transcript,
            selected: None,
            title: "Choose a Local chat".into(),
            generation: 0,
            state: Presentation {
                status: "Connecting to Local…".into(),
                ..Default::default()
            },
            _subscriptions: vec![subscription, editor_events],
            updates: None,
            writes: None,
            editor,
            writer,
            nav_chats: Arc::new(Vec::new()),
            nav_drafts: Vec::new(),
        }
    }

    fn open(&mut self, chat: Chat, window: &mut Window, cx: &mut Context<Self>) {
        if chat.local_draft {
            self.clear_chat(cx);
            self.title = "New Local chat draft".into();
            self.editor.update(cx, |editor, cx| {
                editor.select(chat.id, true, false, window, cx)
            });
            return;
        }
        if self.selected.as_ref() == Some(&chat.id) {
            return;
        }
        let generation = self.generation + 1;
        if !self.client.as_ref().is_some_and(|client| {
            client.command(Command::Open {
                id: chat.id.clone(),
                generation,
            })
        }) {
            return;
        }
        self.generation = generation;
        let key = format!("chat:{}", chat.id);
        self.editor.update(cx, |editor, cx| {
            editor.select(key, chat.writable, chat.busy, window, cx)
        });
        self.selected = Some(chat.id);
        self.title = chat.title;
        self.state.cursor = None;
        self.state.page_busy = false;
        self.state.chat_status = "Loading chat…".into();
        self.state.queued = 0;
        self.transcript
            .update(cx, |view, cx| view.replace_readonly(Vec::new(), true, cx));
        cx.notify();
    }

    fn accept(&mut self, mut state: Presentation, window: &mut Window, cx: &mut Context<Self>) {
        if state.generation == self.generation {
            let rows = std::mem::take(&mut state.rows);
            self.transcript
                .update(cx, |view, cx| view.replace_readonly(rows, false, cx));
            self.state = state;
        } else {
            // An old chat never replaces the selected chat, even while switching quickly.
            self.state.chats = state.chats;
            self.state.status = state.status;
        }
        if let Some(chat) = self
            .selected
            .as_ref()
            .and_then(|id| self.state.chats.iter().find(|c| &c.id == id))
        {
            let (writable, busy) = (chat.writable, chat.busy || self.state.queued > 0);
            self.editor
                .update(cx, |editor, cx| editor.permission(writable, busy, cx));
        }
        self.rebuild_nav(window, cx);
        cx.notify();
    }

    fn clear_chat(&mut self, cx: &mut Context<Self>) {
        self.generation += 1;
        self.selected = None;
        self.state.cursor = None;
        self.state.chat_status.clear();
        self.state.queued = 0;
        if let Some(client) = &self.client {
            client.command(Command::Clear {
                generation: self.generation,
            });
        }
        self.transcript
            .update(cx, |view, cx| view.replace_readonly(Vec::new(), true, cx));
    }
    fn new_chat(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.editor.read(cx).ready() {
            return;
        }
        // Do not inherit another agent's isolated working copy as a Build destination.
        let cwd = String::new();
        self.clear_chat(cx);
        self.title = "New Local chat".into();
        self.editor
            .update(cx, |editor, cx| editor.new_draft(cwd, window, cx));
    }
    fn rebuild_nav(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let drafts = self.editor.read(cx).new_drafts();
        if Arc::ptr_eq(&self.nav_chats, &self.state.chats) && drafts == self.nav_drafts {
            return;
        }
        self.nav_chats = self.state.chats.clone();
        self.nav_drafts = drafts.clone();
        let mut all: Vec<_> = drafts
            .into_iter()
            .map(|(key, title)| Chat {
                id: key,
                title,
                state: "Draft".into(),
                archived: false,
                local_draft: true,
                writable: false,
                busy: false,
                cwd: String::new(),
            })
            .collect();
        all.extend(self.state.chats.iter().cloned());
        self.chats.update(cx, |list, cx| {
            let selected = list
                .delegate()
                .selected
                .and_then(|ix| list.delegate().at(ix))
                .map(|c| c.id.clone());
            let delegate = list.delegate_mut();
            delegate.all = Arc::new(all);
            delegate.filter();
            let selected = selected
                .and_then(|id| {
                    delegate
                        .filtered
                        .iter()
                        .position(|ix| delegate.all[*ix].id == id)
                })
                .map(IndexPath::new);
            list.set_selected_index(selected, window, cx);
            cx.notify();
        });
    }
}

impl Render for LocalViewer {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let archived = self.chats.read(cx).delegate().archived;
        let count = self.chats.read(cx).delegate().filtered.len();
        let footer = if self.state.limited {
            "Viewer capacity reached. New entries and further history are omitted. Open Swift for the full chat."
        } else {
            "Images and links are disabled. Some structured content remains a placeholder. Swift stays available."
        };
        div()
            .h_flex()
            .items_stretch()
            .size_full()
            .min_w_0()
            .bg(cx.theme().background)
            .text_color(cx.theme().foreground)
            .on_action(
                cx.listener(|view, _: &crate::transcript_view::Quit, _, cx| {
                    if view
                        .editor
                        .update(cx, |editor, cx| editor.request_close(cx))
                    {
                        cx.quit();
                    }
                    cx.stop_propagation();
                }),
            )
            .on_action(cx.listener(
                |view, _: &crate::transcript_view::FocusComposer, window, cx| {
                    view.editor
                        .update(cx, |editor, cx| editor.focus(window, cx))
                },
            ))
            .child(
                div()
                    .v_flex()
                    .w_72()
                    .min_w_64()
                    .max_w_80()
                    .h_full()
                    .border_r_1()
                    .border_color(cx.theme().border)
                    .child(
                        div()
                            .v_flex()
                            .p_4()
                            .gap_2()
                            .child(div().font_semibold().child("Pilot Next"))
                            .child(
                                Button::new("new-local-chat")
                                    .small()
                                    .label("New chat")
                                    .disabled(!self.editor.read(cx).ready())
                                    .on_click(
                                        cx.listener(|view, _, window, cx| {
                                            view.new_chat(window, cx)
                                        }),
                                    ),
                            )
                            .child(
                                div()
                                    .text_sm()
                                    .text_color(cx.theme().muted_foreground)
                                    .child(SharedString::from(format!(
                                        "Local · {count} chats (up to 1,000)"
                                    ))),
                            )
                            .child(
                                Checkbox::new("archives")
                                    .label("Include archived")
                                    .checked(archived)
                                    .on_change(cx.listener(|view, checked, _, cx| {
                                        view.chats.update(cx, |list, cx| {
                                            let delegate = list.delegate_mut();
                                            delegate.archived = *checked;
                                            delegate.filter();
                                            cx.notify();
                                        });
                                    })),
                            ),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_h_0()
                            .child(List::new(&self.chats).search_placeholder("Find a chat…")),
                    )
                    .child(
                        div()
                            .v_flex()
                            .p_4()
                            .gap_2()
                            .border_t_1()
                            .border_color(cx.theme().border)
                            .child(
                                div()
                                    .text_xs()
                                    .text_color(cx.theme().muted_foreground)
                                    .child(SharedString::from(self.state.status.clone())),
                            )
                            .child(
                                Button::new("reconnect")
                                    .small()
                                    .label("Reconnect")
                                    .on_click(cx.listener(|view, _, _, _| {
                                        if let Some(client) = &view.client {
                                            client.command(Command::Reconnect);
                                        }
                                    })),
                            ),
                    ),
            )
            .child(
                div()
                    .v_flex()
                    .flex_1()
                    .min_w_0()
                    .min_h_0()
                    .h_full()
                    .child(
                        div()
                            .v_flex()
                            .p_4()
                            .gap_2()
                            .border_b_1()
                            .border_color(cx.theme().border)
                            .child(
                                div()
                                    .font_semibold()
                                    .truncate()
                                    .child(SharedString::from(self.title.clone())),
                            )
                            .child(
                                div()
                                    .text_xs()
                                    .truncate()
                                    .text_color(cx.theme().muted_foreground)
                                    .child(SharedString::from(
                                        self.selected
                                            .as_ref()
                                            .and_then(|id| {
                                                self.state.chats.iter().find(|chat| &chat.id == id)
                                            })
                                            .map(|chat| chat.cwd.clone())
                                            .unwrap_or_default(),
                                    )),
                            )
                            .child(
                                div()
                                    .h_flex()
                                    .gap_2()
                                    .child(
                                        Button::new("earlier")
                                            .small()
                                            .label("Earlier (+24)")
                                            .disabled(
                                                self.state.cursor.is_none() || self.state.page_busy,
                                            )
                                            .on_click(cx.listener(|view, _, _, cx| {
                                                if let (Some(client), Some(before)) =
                                                    (&view.client, view.state.cursor)
                                                    && client.command(Command::Earlier {
                                                        before,
                                                        generation: view.generation,
                                                    })
                                                {
                                                    view.state.page_busy = true;
                                                    cx.notify();
                                                }
                                            })),
                                    )
                                    .child(Button::new("latest").small().label("Latest").on_click(
                                        cx.listener(|view, _, _, cx| {
                                            view.transcript.update(cx, |view, cx| view.latest(cx))
                                        }),
                                    ))
                                    .child(
                                        div()
                                            .text_xs()
                                            .text_color(cx.theme().muted_foreground)
                                            .child(SharedString::from(format!(
                                                "{} · {} queued",
                                                self.state.chat_status, self.state.queued
                                            ))),
                                    ),
                            ),
                    )
                    .child(
                        div()
                            .v_flex()
                            .flex_1()
                            .min_h_0()
                            .min_w_0()
                            .child(self.transcript.clone()),
                    )
                    .child(self.editor.clone())
                    .child(
                        div()
                            .p_4()
                            .border_t_1()
                            .border_color(cx.theme().border)
                            .text_xs()
                            .text_color(cx.theme().muted_foreground)
                            .child(SharedString::from(format!(
                                "{footer} {}",
                                if self.state.omitted > 0 {
                                    "Some structured entries are shown as placeholders."
                                } else {
                                    ""
                                }
                            ))),
                    ),
            )
    }
}
