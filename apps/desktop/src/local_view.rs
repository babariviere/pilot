//! Readonly Local browser. The transport is never given UI events capable of writing.
use crate::{
    LocalOptions, TranscriptView,
    local_client::{Command, LocalClient, Presentation},
    local_model::Chat,
    model::Message,
};
use gpui_kit::{
    App, AppContext, Context, Entity, IntoElement, ParentElement, Render, SharedString, Styled,
    Subscription, Task, Window,
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
}

impl LocalViewer {
    pub fn new(options: LocalOptions, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let (client, updates) = LocalClient::start(options);
        let mut view = Self::build(Some(client), window, cx);
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
        view
    }

    /// Network-free production-view fixture for native rendering/interaction checks.
    pub fn synthetic(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let mut view = Self::build(None, window, cx);
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
            },
            Chat {
                id: "synthetic-two".into(),
                title: "Transcript review".into(),
                state: "idle".into(),
                archived: false,
            },
            Chat {
                id: "synthetic-archive".into(),
                title: "Earlier conversation".into(),
                state: "parked".into(),
                archived: true,
            },
        ]);
        view.chats.update(cx, |list, cx| {
            let delegate = list.delegate_mut();
            delegate.all = view.state.chats.clone();
            delegate.filter();
            list.set_selected_index(Some(IndexPath::new(0)), window, cx);
            cx.notify();
        });
        let rows = (1..=48)
            .map(|id| {
                Message::live(
                    id,
                    format!("assistant · entry {id}"),
                    crate::model::REPLY.into(),
                )
            })
            .collect();
        view.transcript
            .update(cx, |view, cx| view.replace_readonly(rows, true, cx));
        view
    }

    fn build(client: Option<LocalClient>, window: &mut Window, cx: &mut Context<Self>) -> Self {
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
        let subscription = cx.subscribe_in(&chats, window, |view, list, event, _, cx| {
            if let ListEvent::Confirm(ix) = event {
                let chat = list.read(cx).delegate().at(*ix).cloned();
                if let Some(chat) = chat {
                    view.open(chat, cx);
                }
            }
        });
        chats.update(cx, |list, cx| list.focus(window, cx));
        let transcript = cx.new(|cx| TranscriptView::readonly(window, cx));
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
            _subscriptions: vec![subscription],
            updates: None,
        }
    }

    fn open(&mut self, chat: Chat, cx: &mut Context<Self>) {
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
        self.selected = Some(chat.id);
        self.title = chat.title;
        self.state.cursor = None;
        self.state.page_busy = false;
        self.state.chat_status = "Loading chat…".into();
        self.transcript
            .update(cx, |view, cx| view.replace_readonly(Vec::new(), true, cx));
        cx.notify();
    }

    fn accept(&mut self, mut state: Presentation, window: &mut Window, cx: &mut Context<Self>) {
        if !Arc::ptr_eq(&state.chats, &self.state.chats) {
            self.chats.update(cx, |list, cx| {
                let selected = list
                    .delegate()
                    .selected
                    .and_then(|ix| list.delegate().at(ix))
                    .map(|chat| chat.id.clone());
                let delegate = list.delegate_mut();
                delegate.all = state.chats.clone();
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
        cx.notify();
    }
}

impl Render for LocalViewer {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let archived = self.chats.read(cx).delegate().archived;
        let count = self.chats.read(cx).delegate().filtered.len();
        let footer = if self.state.limited {
            "Viewer capacity reached. New entries and further history are omitted. Open Swift for the full chat."
        } else {
            "Readonly. Composer and actions are unavailable. Images and links are disabled. Use Swift to respond."
        };
        div()
            .h_flex()
            .items_stretch()
            .size_full()
            .min_w_0()
            .bg(cx.theme().background)
            .text_color(cx.theme().foreground)
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
                                            .child(SharedString::from(
                                                self.state.chat_status.clone(),
                                            )),
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
