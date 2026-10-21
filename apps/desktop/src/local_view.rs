//! Readonly Local browser. The transport is never given UI events capable of writing.
use crate::{
    LocalOptions, TranscriptView,
    appearance::{self, Corner},
    chat_editor::{ChatEditor, EditorEvent},
    delivery_store::Store,
    interaction::{Interaction, WriteCommand},
    local_client::{Command, LocalClient, Presentation},
    local_model::Chat,
    model::Message,
};
use gpui_kit::{
    App, AppContext, Context, Entity, InteractiveElement, IntoElement, KeyBinding, ParentElement,
    Render, SharedString, Styled, Subscription, Task, TestSupportExt, Window,
    component::{
        ActiveTheme, Disableable, IconName, IndexPath, Sizable, StyledExt,
        button::{Button, ButtonVariants},
        checkbox::Checkbox,
        list::{List, ListDelegate, ListEvent, ListItem, ListState},
    },
    div,
    prelude::FluentBuilder,
    px,
};
use std::{sync::Arc, time::Duration};

gpui_kit::actions!(desktop, [FocusChats]);
#[derive(Clone, Copy)]
pub enum PreviewState {
    Conversation,
    Empty,
    Loading,
    Unavailable,
}
struct ChatList {
    all: Arc<Vec<Chat>>,
    filtered: Vec<usize>,
    query: String,
    archived: bool,
    selected: Option<IndexPath>,
    opened: Option<String>,
    loaded: bool,
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
                .confirmed(self.opened.as_ref() == Some(&chat.id))
                .child(
                    div()
                        .v_flex()
                        .relative()
                        .overflow_hidden()
                        .rounded_md()
                        .px_2()
                        .py_1()
                        .bg(if self.opened.as_ref() == Some(&chat.id) {
                            appearance::selected(cx)
                        } else {
                            cx.theme().transparent
                        })
                        .min_w_0()
                        .w_full()
                        .gap_1()
                        .when(chat.busy, |this| {
                            this.child(appearance::corner(Corner::Working, cx))
                        })
                        .when(!chat.busy && chat.state == "failed", |this| {
                            this.child(appearance::corner(Corner::Failed, cx))
                        })
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
            .child(if !self.loaded {
                "Loading chats…"
            } else if self.all.is_empty() {
                "No Local chats yet."
            } else {
                "No matching chats."
            })
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
    refreshing: bool,
    details_open: bool,
    artifacts: Entity<crate::artifact_view::ArtifactPane>,
    artifacts_open: bool,
}

impl LocalViewer {
    pub fn bind_keys(cx: &mut App) {
        cx.bind_keys([KeyBinding::new("secondary-f", FocusChats, None)]);
    }
    pub fn new(options: LocalOptions, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let (writer, write_updates) = Interaction::start(options.clone(), Store::default_path());
        let (client, updates) = LocalClient::start(options.clone());
        let mut view = Self::build(Some(client), Some(writer), window, cx);
        view.artifacts.update(cx, |pane, _| pane.options(options));
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
            delegate.opened = view.selected.clone();
            delegate.loaded = true;
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
    /// Network/state-free native renderer corpus. Uses stored expected trees, never evaluates JS.
    pub fn visual_preview(index: usize, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let mut view = Self::preview(PreviewState::Conversation, window, cx);
        if index == 9 {
            let reference = crate::artifact_model::Reference {
                id: "synthetic-visual".into(),
                session: "synthetic".into(),
                revision: 1,
                title: "Static canvas (synthetic record)".into(),
                kind: "visual".into(),
            };
            view.state.artifacts = Arc::new(vec![reference.clone()]);
            view.artifacts_open = true;
            let width = (f32::from(window.viewport_size().width)
                - if window.viewport_size().width < px(800.) {
                    184.
                } else {
                    232.
                })
            .min(760.)
                - 24.;
            view.artifacts
                .update(cx, |p, cx| p.preview_canvas(reference, width as f64, cx));
            return view;
        }
        let corpus: serde_json::Value = serde_json::from_str(include_str!(
            "../../../packages/protocol/fixtures/visual/conformance.json"
        ))
        .expect("checked-in synthetic corpus");
        let cases = corpus["cases"].as_array().unwrap();
        let case = &cases[index % cases.len()];
        let reference = crate::artifact_model::Reference {
            id: "synthetic-visual".into(),
            session: "synthetic".into(),
            revision: 1,
            title: case["name"].as_str().unwrap().into(),
            kind: "visual".into(),
        };
        view.state.artifacts = Arc::new(vec![reference.clone()]);
        view.artifacts_open = true;
        let scene = crate::visual_scene::Scene::parse(case["steps"][0]["tree"].clone()).unwrap();
        view.artifacts.update(cx, |p, cx| {
            p.preview(
                reference,
                case["source"].as_str().unwrap().into(),
                scene,
                cx,
            )
        });
        view
    }
    /// Native fixture sizing only. Never used by a connected/captured viewer or canonical artifacts.
    pub fn resize_synthetic_canvas(&mut self, width: f64, cx: &mut Context<Self>) {
        if self.client.is_some()
            || self.writer.is_some()
            || !self.state.status.starts_with("Synthetic")
        {
            return;
        }
        if let Some(reference) = self.state.artifacts.first().cloned() {
            self.artifacts
                .update(cx, |p, cx| p.preview_canvas(reference, width, cx));
        }
    }
    /// Fixed synthetic states, no daemon/private draft store or mutation capability.
    pub fn preview(state: PreviewState, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let mut view = Self::synthetic(window, cx);
        let mut chats = view.state.chats.as_ref().clone();
        chats.push(Chat {
            id: "synthetic-failed".into(),
            title: "Review a failed check with a long title that stays on one line".into(),
            state: "failed".into(),
            archived: false,
            local_draft: false,
            writable: false,
            busy: false,
            cwd: String::new(),
        });
        view.state.chats = Arc::new(chats);
        let mut rows = vec![Message::live(
            1000,
            "You · entry 1".into(),
            "Keep the interface calm and the changes easy to review.".into(),
        )];
        rows.extend(crate::tool_presentation::fixture_work());
        rows.push(Message::live(1001,"assistant · entry 2".into(),"## A smaller, quieter interface\n\nThe navigation stays compact while the conversation has room to breathe.\n\n| Check | Result |\n|:--|:--|\n| Keyboard | Preserved |\n| Private drafts | Unchanged |\n\nNo backend actions are available in this synthetic scene.".into()));
        match state {
            PreviewState::Empty => {
                view.selected = None;
                view.state.chats = Arc::new(Vec::new());
                view.title = "Local chats".into();
                rows.clear();
            }
            PreviewState::Loading => {
                view.state.loaded = false;
                view.state.status = "Connecting to Local…".into();
                view.state.chat_status = "Loading history…".into();
                rows.clear();
            }
            PreviewState::Unavailable => {
                view.state.status =
                    "Local connection unavailable. Last loaded data is retained.".into();
                view.state.chat_status = "Disconnected".into();
            }
            PreviewState::Conversation => {}
        }
        view.transcript
            .update(cx, |view, cx| view.replace_readonly(rows, true, cx));
        if view.selected.is_some() {
            view.editor.update(cx, |editor, cx| {
                editor.select("chat:synthetic".into(), false, true, window, cx)
            });
        }
        view.rebuild_nav(window, cx);
        view
    }
    /// Same production view, frozen read-only input, no writer/draft store or live transport.
    pub fn captured(
        capture: crate::local_client::LocalCapture,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let mut view = Self::build(None, None, window, cx);
        view.selected = Some(capture.chat.id.clone());
        view.title = capture.chat.title.clone();
        view.generation = capture.state.generation;
        view.accept(capture.state, window, cx);
        view.editor.update(cx, |editor, cx| {
            editor.select(
                format!("chat:{}", capture.chat.id),
                false,
                capture.chat.busy,
                window,
                cx,
            )
        });
        view.state.status = "Read-only captured snapshot · no live controls".into();
        view
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
                    opened: None,
                    loaded: false,
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
            refreshing: false,
            details_open: false,
            artifacts: cx.new(|_| crate::artifact_view::ArtifactPane::new()),
            artifacts_open: false,
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
        self.refreshing = false;
        let key = format!("chat:{}", chat.id);
        self.editor.update(cx, |editor, cx| {
            editor.select(key, chat.writable, chat.busy, window, cx)
        });
        self.selected = Some(chat.id);
        self.artifacts_open = false;
        self.state.artifacts = Arc::new(Vec::new());
        self.artifacts.update(cx, |pane, cx| {
            pane.context(self.selected.clone(), self.state.artifacts.clone(), cx)
        });
        self.title = chat.title;
        self.state.cursor = None;
        self.state.page_busy = false;
        self.state.chat_status = "Loading chat…".into();
        self.state.queued = 0;
        self.rebuild_nav(window, cx);
        self.transcript
            .update(cx, |view, cx| view.replace_readonly(Vec::new(), true, cx));
        cx.notify();
    }

    fn accept(&mut self, mut state: Presentation, window: &mut Window, cx: &mut Context<Self>) {
        if self.refreshing && state.generation == self.generation && !state.loaded {
            self.state.chats = state.chats;
            self.state.status = state.status;
            self.state.chat_status = state.chat_status;
        } else if state.generation == self.generation {
            let rows = std::mem::take(&mut state.rows);
            let reset = self.refreshing;
            self.refreshing = false;
            self.transcript.update(cx, |view, cx| {
                view.replace_readonly(rows, reset, cx);
                if reset {
                    view.latest(cx);
                }
            });
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
        self.artifacts.update(cx, |pane, cx| {
            pane.context(self.selected.clone(), self.state.artifacts.clone(), cx)
        });
        cx.notify();
    }

    fn clear_chat(&mut self, cx: &mut Context<Self>) {
        self.artifacts_open = false;
        self.state.artifacts = Arc::new(Vec::new());
        self.artifacts.update(cx, |pane, cx| {
            pane.context(None, self.state.artifacts.clone(), cx)
        });
        self.refreshing = false;
        self.generation += 1;
        self.selected = None;
        self.chats.update(cx, |list, cx| {
            list.delegate_mut().opened = None;
            cx.notify();
        });
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
    fn latest(&mut self, cx: &mut Context<Self>) {
        if self.state.limited
            && let (Some(client), Some(id)) = (&self.client, &self.selected)
        {
            let generation = self.generation + 1;
            if client.command(Command::Open {
                id: id.clone(),
                generation,
            }) {
                self.generation = generation;
                self.refreshing = true;
                self.state.page_busy = true;
                self.state.chat_status = "Loading newest bounded window…".into();
                cx.notify();
                return;
            }
        }
        self.transcript.update(cx, |view, cx| view.latest(cx));
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
        if Arc::ptr_eq(&self.nav_chats, &self.state.chats)
            && drafts == self.nav_drafts
            && self.chats.read(cx).delegate().opened == self.selected
            && self.chats.read(cx).delegate().loaded == self.state.list_loaded
        {
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
            delegate.opened = self.selected.clone();
            delegate.loaded = self.state.list_loaded;
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
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let archived = self.chats.read(cx).delegate().archived;
        let count = self.chats.read(cx).delegate().filtered.len();
        let sidebar_width = px(if window.viewport_size().width < px(800.) {
            184.
        } else {
            232.
        });
        let healthy = self.state.status.starts_with("Connected")
            || self.state.status.starts_with("Synthetic")
            || self.state.status.starts_with("Read-only captured");
        let cwd = self
            .selected
            .as_ref()
            .and_then(|id| self.state.chats.iter().find(|c| &c.id == id))
            .map(|c| c.cwd.clone())
            .unwrap_or_default();
        let footer = if self.state.limited {
            "Bounded history window. Refresh latest for newer messages. Full history remains available in Swift."
        } else {
            "Images and links are disabled. Some structured content remains unsupported. Swift remains available."
        };
        div().id("desktop-root").test_support().h_flex().items_stretch().size_full().min_w_0()
            .bg(cx.theme().background).text_color(cx.theme().foreground)
            .on_action(cx.listener(|view,_:&crate::transcript_view::Quit,_,cx|{
                if view.editor.update(cx,|editor,cx|editor.request_close(cx)){cx.quit();}
                cx.stop_propagation();
            }))
            .on_action(cx.listener(|view,_:&crate::transcript_view::FocusComposer,window,cx|{
                view.editor.update(cx,|editor,cx|editor.focus(window,cx));
            }))
            .on_action(cx.listener(|view,_:&FocusChats,window,cx|view.chats.update(cx,|list,cx|list.focus(window,cx))))
            .child(
                div().id("chat-sidebar").test_support().v_flex().w(sidebar_width).min_w(sidebar_width).max_w(sidebar_width).h_full()
                    .bg(cx.theme().sidebar).border_r_1().border_color(cx.theme().border)
                    .child(div().v_flex().p_3().gap_2()
                        .child(div().h_flex().items_center().justify_between().gap_1()
                            .child(div().text_sm().font_semibold().child("Pilot Next"))
                            .child(Button::new("new-local-chat").ghost().small().icon(IconName::Plus).label("New chat")
                                .disabled(!self.editor.read(cx).ready()).on_click(cx.listener(|view,_,window,cx|view.new_chat(window,cx)))))
                        .child(div().text_xs().text_color(cx.theme().muted_foreground).child(SharedString::from(format!("{count} Local chats"))))
                        .child(Checkbox::new("archives").label("Include archived").checked(archived)
                            .on_change(cx.listener(|view,checked,_,cx|{
                                view.chats.update(cx,|list,cx|{let d=list.delegate_mut();d.archived = *checked;d.filter();cx.notify();});
                            }))))
                    .child(div().flex_1().min_h_0().min_w_0().child(List::new(&self.chats).search_placeholder("Find a chat…")))
                    .children((!healthy).then(||div().v_flex().p_3().gap_2().border_t_1().border_color(cx.theme().border)
                        .child(div().text_xs().text_color(cx.theme().danger).child(SharedString::from(self.state.status.clone())))
                        .child(Button::new("reconnect").ghost().small().label("Reconnect").disabled(self.client.is_none())
                            .on_click(cx.listener(|view,_,_,_|{if let Some(client)=&view.client{client.command(Command::Reconnect);}})))))
            )
            .child(
                div().id("conversation").test_support().v_flex().flex_1().min_w_0().min_h_0().h_full()
                    .child(div().v_flex().px_3().py_2().gap_1().border_b_1().border_color(cx.theme().border)
                        .child(div().text_base().font_semibold().truncate().child(SharedString::from(self.title.clone())))
                        .when(!cwd.is_empty(),|this|this.child(div().text_xs().truncate().text_color(cx.theme().muted_foreground).child(SharedString::from(cwd))))
                        .child(div().h_flex().items_center().gap_2().min_w_0()
                            .child(Button::new("earlier").ghost().small().label("Earlier").disabled(self.state.cursor.is_none()||self.state.page_busy)
                                .on_click(cx.listener(|view,_,_,cx|{
                                    if let(Some(client),Some(before))=(&view.client,view.state.cursor)
                                        &&client.command(Command::Earlier{before,generation:view.generation}){view.state.page_busy=true;cx.notify();}
                                })))
                            .child(Button::new("latest").ghost().small().label(if self.refreshing{"Retry latest"}else if self.state.limited{"Refresh latest"}else{"Latest"})
                                .on_click(cx.listener(|view,_,_,cx|view.latest(cx))))
                            .when(!self.state.artifacts.is_empty()||self.artifacts_open,|this|this.child(Button::new("artifact-gallery").ghost().small().label(if self.artifacts_open{"Back to chat"}else{"Artifacts"})
                                .on_click(cx.listener(|view,_,_,cx|{view.artifacts_open = !view.artifacts_open;if !view.artifacts_open{view.artifacts.update(cx,|p,_|p.close());}cx.notify();}))))
                            .child(div().flex_1().min_w_0().text_xs().truncate().text_color(cx.theme().muted_foreground)
                                .child(SharedString::from(format!("{}{}",self.state.chat_status,if self.state.queued>0{format!(" · {} queued",self.state.queued)}else{String::new()}))))))
                    .child(div().v_flex().flex_1().min_h_0().min_w_0().w_full().max_w(px(760.)).mx_auto()
                        .when(self.selected.is_some()&&!self.state.loaded,|this|this.child(div().p_3().text_sm().text_color(cx.theme().muted_foreground).child("Loading history…")))
                        .when(self.selected.is_none(),|this|this.child(div().v_flex().flex_1().justify_center().p_6().gap_2()
                            .child(div().font_semibold().child("Choose a chat"))
                            .child(div().text_sm().text_color(cx.theme().muted_foreground).child("Open a Local conversation from the sidebar, or start a new chat."))))
                        .when(self.selected.is_some()&&!self.artifacts_open,|this|this.child(self.transcript.clone()))
                        .when(self.artifacts_open,|this|this.child(self.artifacts.clone())))
                    .child(div().w_full().max_w(px(760.)).mx_auto().child(self.editor.clone()))
                    .child(div().v_flex().px_3().py_1().gap_1().border_t_1().border_color(cx.theme().border).text_xs().text_color(cx.theme().muted_foreground)
                        .child(Button::new("view-details").ghost().small().self_start().label(if self.details_open{"Hide details"}else{"Details"})
                            .on_click(cx.listener(|view,_,_,cx|{view.details_open = !view.details_open;cx.notify();})))
                        .when(self.state.limited&&!self.details_open,|this|this.child("History window full. Refresh latest to see newer messages."))
                        .when(self.details_open,|this|this.child(SharedString::from(format!("{footer} {}",if self.state.omitted>0{"Some structured entries are shown as placeholders."}else{""})))))
            )
    }
}
#[cfg(test)]
mod refresh_tests {
    use super::*;
    use gpui_kit::{TestAppContext, WindowOptions};
    #[gpui_kit::test]
    fn compact_chrome_keeps_open_chat_and_keyboard_search_separate(cx: &mut TestAppContext) {
        use gpui_kit::test::TestWindowExt;
        cx.update(|cx| {
            gpui_kit::init(cx);
            crate::init_appearance(cx);
            LocalViewer::bind_keys(cx);
        });
        let (handle, view) = cx.update(|cx| {
            gpui_kit::open_window(
                WindowOptions {
                    show: false,
                    ..Default::default()
                },
                cx,
                |window, cx| {
                    cx.new(|cx| LocalViewer::preview(PreviewState::Conversation, window, cx))
                },
            )
            .unwrap()
        });
        cx.run_until_parked();
        cx.update_window(handle, |_, window, cx| {
            window.render_frame(cx);
            window.click("view-details", cx);
            assert!(view.read(cx).details_open);
            window.press("secondary-f", cx);
            window.input("review", cx);
        })
        .unwrap();
        cx.executor().advance_clock(Duration::from_millis(400));
        cx.run_until_parked();
        cx.update(|cx| {
            let view = view.read(cx);
            assert_eq!(view.selected.as_deref(), Some("synthetic"));
            let nav = view.chats.read(cx).delegate();
            assert_eq!(nav.opened, view.selected);
            assert_eq!(nav.query, "review");
            assert!(!nav.filtered.is_empty());
            assert!(view.writer.is_none());
        });
    }
    #[gpui_kit::test]
    fn refresh_retains_old_window_allows_retry_fences_late_results_and_clears_on_navigation(
        cx: &mut TestAppContext,
    ) {
        cx.update(gpui_kit::init);
        let (client, commands) = LocalClient::synthetic_commands();
        let (handle, view) = cx.update(|cx| {
            gpui_kit::open_window(
                WindowOptions {
                    show: false,
                    ..Default::default()
                },
                cx,
                |window, cx| {
                    cx.new(|cx| {
                        let mut view = LocalViewer::synthetic(window, cx);
                        view.client = Some(client);
                        view.state.limited = true;
                        view.state.queued = 7;
                        view
                    })
                },
            )
            .unwrap()
        });
        cx.update_window(handle,|_,window,cx|view.update(cx,|view,cx|{
            view.latest(cx);assert!(view.refreshing);let first=view.generation;
            assert!(matches!(commands.try_recv().unwrap(),Command::Open{generation,..}if generation==first));
            view.accept(Presentation{generation:first,chat_status:"Unavailable; retry explicitly".into(),..Default::default()},window,cx);
            assert!(view.state.loaded);assert_eq!(view.state.queued,7);assert!(view.state.chat_status.contains("Unavailable"));
            view.latest(cx);let second=view.generation;assert!(second>first);
            assert!(matches!(commands.try_recv().unwrap(),Command::Open{generation,..}if generation==second));
            view.accept(Presentation{generation:first,loaded:true,queued:99,..Default::default()},window,cx);
            assert!(view.refreshing);assert_eq!(view.state.queued,7);
            view.accept(Presentation{generation:second,loaded:true,queued:3,rows:vec![Message::live(999,"assistant".into(),"Fresh bounded window".into())],..Default::default()},window,cx);
            assert!(!view.refreshing);assert_eq!(view.state.queued,3);
            view.refreshing=true;view.clear_chat(cx);assert!(!view.refreshing);assert!(view.selected.is_none());assert!(view.writer.is_none());
        })).unwrap();
        cx.run_until_parked();
    }
}
