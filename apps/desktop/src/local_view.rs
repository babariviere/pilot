//! Readonly Local browser. The transport is never given UI events capable of writing.
#[path = "chat_actions_navigation.rs"]
mod chat_actions_navigation;
#[cfg(feature = "native-probes")]
#[path = "chat_actions_probe.rs"]
pub(crate) mod chat_actions_probe;
#[cfg(feature = "native-probes")]
#[path = "chat_model_probe.rs"]
pub(crate) mod chat_model_probe;
#[cfg(feature = "native-probes")]
#[path = "chat_rename_probe.rs"]
pub(crate) mod chat_rename_probe;
#[cfg(feature = "native-probes")]
#[path = "context_usage_probe.rs"]
pub(crate) mod context_usage_probe;
#[path = "context_usage_view.rs"]
mod context_usage_view;
#[path = "contextual_navigation.rs"]
mod contextual_navigation;
#[cfg(feature = "native-probes")]
#[path = "conversation_links_probe.rs"]
pub(crate) mod conversation_links_probe;
#[path = "conversation_links_view.rs"]
mod conversation_links_view;
#[cfg(feature = "native-probes")]
#[path = "disclosure_probe.rs"]
pub(crate) mod disclosure_probe;
#[cfg(feature = "native-probes")]
#[path = "history_probe.rs"]
pub(crate) mod history_probe;
#[cfg(feature = "native-probes")]
#[path = "inbox_probe.rs"]
pub(crate) mod inbox_probe;
#[path = "jump_navigation.rs"]
mod jump_navigation;
#[cfg(feature = "native-probes")]
#[path = "jump_probe.rs"]
pub(crate) mod jump_probe;
#[cfg(feature = "native-probes")]
#[path = "mission_browser_probe.rs"]
pub(crate) mod mission_browser_probe;
#[cfg(feature = "native-probes")]
#[path = "mission_decisions_root_probe.rs"]
pub(crate) mod mission_decisions_root_probe;
#[path = "mission_inspector_navigation.rs"]
mod mission_inspector_navigation;
#[cfg(feature = "native-probes")]
#[path = "mission_inspector_probe.rs"]
pub(crate) mod mission_inspector_probe;
#[path = "mission_navigation.rs"]
mod mission_navigation;
#[cfg(feature = "native-probes")]
#[path = "mission_probe.rs"]
pub(crate) mod mission_probe;
#[cfg(feature = "native-probes")]
#[path = "motion_probe.rs"]
pub(crate) mod motion_probe;
#[cfg(feature = "native-probes")]
#[path = "navigation_probe.rs"]
pub(crate) mod navigation_probe;
#[path = "navigation_view.rs"]
mod navigation_view;
#[path = "project_add_navigation.rs"]
mod project_add_navigation;
#[cfg(feature = "native-probes")]
#[path = "project_add_probe.rs"]
pub(crate) mod project_add_probe;
#[path = "queued_message_view.rs"]
pub(crate) mod queued_message_view;
#[cfg(feature = "native-probes")]
#[path = "scoped_models_probe.rs"]
pub(crate) mod scoped_models_probe;
#[cfg(feature = "native-probes")]
#[path = "session_failure_probe.rs"]
pub(crate) mod session_failure_probe;
#[path = "session_failure_view.rs"]
mod session_failure_view;
#[cfg(feature = "native-probes")]
#[path = "session_todos_probe.rs"]
pub(crate) mod session_todos_probe;
#[path = "session_todos_tray.rs"]
mod session_todos_tray;
#[cfg(feature = "native-probes")]
#[path = "settings_probe.rs"]
pub(crate) mod settings_probe;
#[cfg(feature = "native-probes")]
#[path = "shell_probe.rs"]
pub(crate) mod shell_probe;
#[cfg(feature = "native-probes")]
#[path = "style_probe.rs"]
pub(crate) mod style_probe;
#[cfg(feature = "native-probes")]
#[path = "transcript_find_probe.rs"]
pub(crate) mod transcript_find_probe;
#[cfg(feature = "native-probes")]
#[path = "workbench_probe.rs"]
pub(crate) mod workbench_probe;
#[path = "workbench_view.rs"]
mod workbench_view;
#[cfg(feature = "native-probes")]
#[path = "workspace_changes_probe.rs"]
pub(crate) mod workspace_changes_probe;
#[path = "workspace_changes_view.rs"]
mod workspace_changes_view;
use crate::{
    LocalOptions, TranscriptView,
    app_icon::AppIcon,
    app_shell::{Overview, OverviewInput, Page, ProjectList, ShellEvent},
    appearance::{self},
    chat_editor::{ChatEditor, EditorEvent},
    delivery_store::Store,
    dither::{Signal, Spec},
    dither_view::CornerView,
    interaction::{Interaction, WriteCommand},
    local_client::{Command, LocalClient, Presentation},
    local_model::Chat,
    model::Message,
};
use gpui_kit::component::menu::{ContextMenuExt, DropdownMenu};
use gpui_kit::{
    App, AppContext, Context, Entity, InteractiveElement, IntoElement, KeyBinding, ParentElement,
    Render, SharedString, Styled, Subscription, Task, TestSupportExt, Window,
    base::Selectable,
    component::{
        ActiveTheme, Disableable, IconName, IndexPath, Sizable, StyledExt,
        button::{Button, ButtonVariants},
        list::{List, ListDelegate, ListEvent, ListItem, ListState},
    },
    div,
    prelude::FluentBuilder,
    px,
};
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
    time::Duration,
};
#[cfg(feature = "native-probes")]
pub use workspace_changes_view::session_file_view_probe::run_session_file_view_probe;

gpui_kit::actions!(
    desktop,
    [
        FocusChats,
        GoHome,
        ShowAllChats,
        ShowMissions,
        NavigateBack,
        NavigateForward,
        ToggleJump
    ]
);
#[derive(Clone, Copy)]
pub enum PreviewState {
    Conversation,
    Empty,
    Loading,
    Unavailable,
}
struct ChatList {
    action_owner: gpui_kit::WeakEntity<LocalViewer>,
    all: Arc<Vec<Chat>>,
    filtered: Vec<usize>,
    query: String,
    archived: bool,
    selected: Option<IndexPath>,
    opened: Option<String>,
    loaded: bool,
    project: Option<String>,
    corners: HashMap<String, Entity<CornerView>>,
}
impl ChatList {
    fn filter(&mut self) {
        let ids: HashSet<_> = self.all.iter().map(|chat| chat.id.as_str()).collect();
        self.corners.retain(|id, _| ids.contains(id.as_str()));
        self.filtered = self
            .all
            .iter()
            .enumerate()
            .filter(|(_, c)| {
                (self.archived || !c.archived)
                    && (self.query.is_empty() || c.title.to_lowercase().contains(&self.query))
                    && self
                        .project
                        .as_ref()
                        .is_none_or(|id| c.project_id.as_ref() == Some(id))
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
        window: &mut Window,
        cx: &mut Context<ListState<Self>>,
    ) -> Option<ListItem> {
        let chat = self.at(ix)?.clone();
        let spec = Spec::row(chat.signal, chat.background_work);
        let corner = self
            .corners
            .entry(chat.id.clone())
            .or_insert_with(|| cx.new(|cx| CornerView::new(spec, window, cx)))
            .clone();
        corner.update(cx, |view, cx| view.configure(spec, cx));
        let has_corner = corner.read(cx).has_corner(cx);
        let owner = self.action_owner.clone();
        let menu_owner = owner.clone();
        let button_owner = owner.clone();
        let menu_chat = chat.clone();
        let button_chat = chat.clone();
        Some(
            ListItem::new(SharedString::from(chat.id.clone()))
                .hover_fill(!has_corner)
                .confirmed(self.opened.as_ref() == Some(&chat.id))
                .child(
                    div()
                        .id(SharedString::from(format!("chat-row-{}", chat.id)))
                        .test_support()
                        .capture_any_mouse_down(move |_, w, cx| {
                            if !owner
                                .update(cx, |v, cx| v.chat_row_guard(w, cx))
                                .unwrap_or(false)
                            {
                                cx.stop_propagation();
                            }
                        })
                        .v_flex()
                        .relative()
                        .overflow_hidden()
                        .rounded(px(appearance::Radius::ROW))
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
                        .child(crate::dither_view::layer(corner))
                        .child(
                            div()
                                .h_flex()
                                .items_center()
                                .gap_1()
                                .child(
                                    div()
                                        .flex_1()
                                        .min_w_0()
                                        .truncate()
                                        .text_size(px(appearance::TextRole::BODY))
                                        .child(SharedString::from(chat.title.clone())),
                                )
                                .child(
                                    crate::ui::icon_action(
                                        SharedString::from(format!("chat-menu-{}", chat.id)),
                                        "Chat actions",
                                        AppIcon::More,
                                        crate::ui::Action::Quiet,
                                    )
                                    .disabled(chat.local_draft)
                                    .dropdown_menu(
                                        move |menu, w, cx| {
                                            LocalViewer::chat_actions_menu(
                                                button_owner.clone(),
                                                button_chat.clone(),
                                                menu,
                                                w,
                                                cx,
                                            )
                                        },
                                    ),
                                ),
                        )
                        .child(
                            div()
                                .text_size(px(appearance::TextRole::CAPTION))
                                .text_color(cx.theme().muted_foreground)
                                .child(SharedString::from(format!(
                                    "{}{}",
                                    chat.signal_label(),
                                    if chat.archived { " · Archived" } else { "" }
                                ))),
                        )
                        .context_menu(move |menu, w, cx| {
                            LocalViewer::chat_actions_menu(
                                menu_owner.clone(),
                                menu_chat.clone(),
                                menu,
                                w,
                                cx,
                            )
                        }),
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
    session_failure_fence: crate::session_failure::Fence,
    session_failure_focus: gpui_kit::FocusHandle,
    queue_forms: Vec<(Entity<queued_message_view::Popup>, Subscription)>,
    queue_open: Option<Entity<queued_message_view::Popup>>,
    conversation_links: Option<Entity<conversation_links_view::Pane>>,
    workspace_changes: Option<Entity<workspace_changes_view::Pane>>,
    chat_actions: Entity<crate::chat_actions_view::Actions>,
    settings: Entity<crate::settings_view::SettingsPreferences>,
    settings_window: Option<gpui_kit::AnyWindowHandle>,
    usage_options: Option<LocalOptions>,
    usage_window: Option<gpui_kit::AnyWindowHandle>,
    usage_events: Option<Subscription>,
    settings_pane: Option<gpui_kit::WeakEntity<crate::settings_view::SettingsView>>,
    settings_return: Option<gpui_kit::FocusHandle>,
    settings_events: Vec<Subscription>,
    #[cfg(feature = "native-probes")]
    settings_fixture_size: Option<gpui_kit::Size<gpui_kit::Pixels>>,
    projects_open: bool,
    jump: Option<Entity<crate::jump_view::JumpPalette>>,
    jump_subscription: Option<Subscription>,
    jump_return: Option<gpui_kit::FocusHandle>,
    mission: Entity<crate::mission_view::MissionForm>,
    mission_open: bool,
    mission_return: Option<gpui_kit::FocusHandle>,
    add_project: Entity<crate::project_add_view::ProjectAdd>,
    add_project_open: bool,
    add_project_return: Option<gpui_kit::FocusHandle>,
    project_catalog_reply: Option<String>,
    navigation: crate::navigation::History,
    navigation_seeded: bool,
    restoring_navigation: bool,
    scope_states: crate::navigation::Cache<Option<String>, crate::navigation::ScopeState>,
    reader_marks: crate::navigation::Cache<String, crate::navigation::ReadingMark>,
    pending_reader: Option<(u64, String, crate::navigation::ReadingMark)>,
    page: Page,
    project_scope: Option<String>,
    projects: Entity<ListState<ProjectList>>,
    overview: Entity<Overview>,
    inbox: Entity<crate::inbox::Inbox>,
    missions: Entity<crate::mission_browser_view::Browser>,
    mission_context: Entity<crate::mission_inspector_view::Pane>,
    nav_projects: Arc<Vec<crate::local_model::Project>>,
    pending_transcript: Option<(Vec<Message>, bool)>,
    nav_error: Option<&'static str>,
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
    earlier_attempt: Option<(u64, u64)>,
    earlier_request: Option<(u64, u64, u64)>,
    details_open: bool,
    artifacts: Entity<crate::artifact_view::ArtifactPane>,
    artifacts_open: bool,
    #[cfg(feature = "native-probes")]
    render_count: u64,
}

impl LocalViewer {
    pub fn bind_keys(cx: &mut App) {
        cx.bind_keys([
            KeyBinding::new(
                "secondary-enter",
                crate::project_add_view::ConfirmProject,
                Some("AddProject"),
            ),
            KeyBinding::new(
                "escape",
                crate::project_add_view::CancelProject,
                Some("AddProject"),
            ),
            KeyBinding::new(
                "secondary-enter",
                crate::mission_view::ConfirmMission,
                Some("MissionConversion"),
            ),
            KeyBinding::new(
                "escape",
                crate::mission_view::CancelMission,
                Some("MissionConversion"),
            ),
            KeyBinding::new(
                "escape",
                conversation_links_view::Close,
                Some("ConversationLinks"),
            ),
            KeyBinding::new(
                "escape",
                workspace_changes_view::Close,
                Some("WorkspaceChanges"),
            ),
            KeyBinding::new("secondary-alt-d", workspace_changes_view::Toggle, None),
            KeyBinding::new("secondary-alt-l", conversation_links_view::Toggle, None),
            KeyBinding::new(
                "escape",
                queued_message_view::CloseQueue,
                Some("QueuedMessage"),
            ),
            KeyBinding::new(
                "secondary-enter",
                queued_message_view::SaveQueue,
                Some("QueuedMessage"),
            ),
            KeyBinding::new("secondary-k", ToggleJump, None),
            KeyBinding::new("secondary-f", FocusChats, None),
            KeyBinding::new("secondary-1", GoHome, None),
            KeyBinding::new("secondary-2", ShowAllChats, None),
            KeyBinding::new("secondary-3", ShowMissions, None),
            KeyBinding::new(
                "escape",
                crate::mission_inspector_view::Close,
                Some("MissionContext"),
            ),
            KeyBinding::new(
                "secondary-alt-m",
                crate::mission_inspector_view::Toggle,
                None,
            ),
            KeyBinding::new("secondary-[", NavigateBack, None),
            KeyBinding::new("secondary-]", NavigateForward, None),
            KeyBinding::new("secondary-,", crate::settings_view::OpenSettings, None),
            KeyBinding::new(
                "secondary-w",
                crate::settings_view::CloseSettings,
                Some("Settings"),
            ),
            KeyBinding::new(
                "secondary-s",
                crate::settings_view::SaveSettings,
                Some("Settings"),
            ),
            KeyBinding::new(
                "escape",
                crate::settings_view::CloseSettings,
                Some("Settings"),
            ),
        ]);
    }
    pub fn new(options: LocalOptions, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let (writer, write_updates) = Interaction::start(options.clone(), Store::default_path());
        let (client, updates) = LocalClient::start(options.clone());
        let mut view = Self::build(Some(client), Some(writer), window, cx);
        view.usage_options = Some(options.clone());
        view.chat_actions
            .update(cx, |a, cx| a.connect(options.clone(), cx));
        let root = Store::default_path()
            .map(|root| root.join("settings"))
            .map_err(|_| crate::settings_state::SettingsError::UnsafePath);
        view.settings = cx.new(|_| crate::settings_view::SettingsPreferences::new(Some(root)));
        view.connect_model_controls(options.clone(), window, cx);
        view.settings.update(cx, |owner, cx| owner.load(cx));
        view.page = Page::Home;
        view.navigation = crate::navigation::History::new(crate::navigation::Location::home());
        view.navigation_seeded = true;
        view.missions
            .update(cx, |pane, _| pane.options(options.clone()));
        view.mission_context
            .update(cx, |pane, _| pane.options(options.clone()));
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
        view.listen_writes(write_updates, window, cx);
        let weak = cx.weak_entity();
        window.on_window_should_close(cx, move |_, cx| {
            weak.update(cx, |view, cx| {
                if !view
                    .settings
                    .update(cx, |owner, cx| owner.request_close(cx))
                {
                    return false;
                }
                view.editor
                    .update(cx, |editor, cx| editor.request_close(cx))
            })
            .unwrap_or(true)
        });
        view
    }

    fn listen_writes(
        &mut self,
        write_updates: async_channel::Receiver<crate::interaction::WriteState>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.writes = Some(cx.spawn_in(window, async move |view, cx| {
            while let Ok(state) = write_updates.recv().await {
                if view
                    .update_in(cx, |view, window, cx| {
                        view.add_project
                            .update(cx, |form, cx| form.accept(&state, cx));
                        if let Some(reply) = &state.project
                            && let Some(catalog) = &reply.catalog
                            && view.project_catalog_reply.as_ref() != Some(&reply.id)
                        {
                            view.project_catalog_reply = Some(reply.id.clone());
                            match catalog {
                                Ok(rows) => {
                                    view.state.projects = Arc::new(rows.clone());
                                    view.state.projects_loaded = true;
                                    view.state.projects_error = None;
                                }
                                Err(error) => view.state.projects_error = Some(error),
                            }
                            view.rebuild_nav(window, cx);
                            cx.notify();
                        }
                        let had_attempt = view
                            .selected
                            .as_ref()
                            .is_some_and(|id| view.mission.read(cx).has_attempt(id));
                        view.mission
                            .update(cx, |form, cx| form.accept(&state, window, cx));
                        if had_attempt
                            != view
                                .selected
                                .as_ref()
                                .is_some_and(|id| view.mission.read(cx).has_attempt(id))
                        {
                            cx.notify();
                        }
                        view.editor
                            .update(cx, |editor, cx| editor.accept(state, window, cx))
                    })
                    .is_err()
                {
                    break;
                }
            }
        }));
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
                failure: None,
                context_usage: Default::default(),
                id: "synthetic".into(),
                title: "Synthetic Local chat".into(),
                state: "working".into(),
                archived: false,
                local_draft: false,
                writable: false,
                busy: true,
                signal: Some(Signal::Working),
                background_work: false,
                cwd: String::new(),
                project_id: None,
                model_configuration: None,
                attention: None,
            },
            Chat {
                failure: None,
                context_usage: Default::default(),
                id: "synthetic-two".into(),
                title: "Transcript review".into(),
                state: "idle".into(),
                archived: false,
                local_draft: false,
                writable: false,
                busy: false,
                signal: None,
                background_work: false,
                cwd: String::new(),
                project_id: None,
                model_configuration: None,
                attention: None,
            },
            Chat {
                failure: None,
                context_usage: Default::default(),
                id: "synthetic-archive".into(),
                title: "Earlier conversation".into(),
                state: "parked".into(),
                archived: true,
                local_draft: false,
                writable: false,
                busy: false,
                signal: None,
                background_work: false,
                cwd: String::new(),
                project_id: None,
                model_configuration: None,
                attention: None,
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
        rows.push(Message::artifact(
            99_999,
            crate::artifact_model::Reference {
                id: "synthetic-artifact".into(),
                session: "synthetic".into(),
                revision: 3,
                title: "Latency by region".into(),
                kind: "visual".into(),
            },
        ));
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
        if index >= 10 {
            let (title, tree) = crate::visual_chart::synthetic_fixture(index);
            let reference = crate::artifact_model::Reference {
                id: "synthetic-visual".into(),
                session: "synthetic".into(),
                revision: 1,
                title: title.into(),
                kind: "visual".into(),
            };
            view.state.artifacts = Arc::new(vec![reference.clone()]);
            view.artifacts_open = true;
            let scene = crate::visual_scene::Scene::parse(tree.clone()).unwrap();
            let mut props = tree["root"].clone();
            props.as_object_mut().unwrap().remove("type");
            let source = if index == 13 {
                let children = props["children"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| {
                        let mut p = v.clone();
                        p.as_object_mut().unwrap().remove("type");
                        format!("ui.chart({p})")
                    })
                    .collect::<Vec<_>>()
                    .join(",");
                format!("({{ui}})=>ui.column([{children}])")
            } else {
                format!("({{ui}})=>ui.chart({props})")
            };
            view.artifacts
                .update(cx, |p, cx| p.preview(reference, source, scene, cx));
            return view;
        }
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
    #[cfg(feature = "native-probes")]
    pub(crate) fn probe_artifact_pane(&self) -> Entity<crate::artifact_view::ArtifactPane> {
        self.artifacts.clone()
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
            failure: None,
            context_usage: Default::default(),
            id: "synthetic-failed".into(),
            title: "Review a failed check with a long title that stays on one line".into(),
            state: "failed".into(),
            archived: false,
            local_draft: false,
            writable: false,
            busy: false,
            signal: Some(Signal::Failed),
            background_work: false,
            cwd: String::new(),
            project_id: None,
            model_configuration: None,
            attention: None,
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
        let action_owner = cx.weak_entity();
        let chats = cx.new(|cx| {
            ListState::new(
                ChatList {
                    action_owner,
                    all: Arc::new(Vec::new()),
                    filtered: Vec::new(),
                    query: String::new(),
                    archived: false,
                    selected: None,
                    opened: None,
                    loaded: false,
                    project: None,
                    corners: HashMap::new(),
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
        let projects =
            cx.new(|cx| ListState::new(ProjectList::new(), window, cx).searchable(false));
        let overview = cx.new(|_| Overview::new());
        let inbox = cx.new(|cx| crate::inbox::Inbox::new(window, cx));
        let inbox_events = cx.subscribe_in(
            &inbox,
            window,
            |view, _, event: &crate::inbox::InboxEvent, window, cx| {
                if !matches!(view.page, Page::Inbox(_)) {
                    return;
                }
                match event {
                    crate::inbox::InboxEvent::Chat(id) => {
                        if let Some(chat) = view.state.chats.iter().find(|c| &c.id == id).cloned() {
                            view.open(chat, window, cx);
                        }
                    }
                    crate::inbox::InboxEvent::Filter(filter) => {
                        if filter
                            .as_ref()
                            .is_some_and(|id| !view.state.projects.iter().any(|p| &p.id == id))
                        {
                            view.inbox.update(cx, |v, cx| v.restore_filter(window, cx));
                            view.nav_error = Some("That project is no longer available.");
                            cx.notify();
                            return;
                        }
                        view.show_inbox(filter.clone(), window, cx);
                    }
                }
            },
        );
        let project_events = cx.subscribe_in(&projects, window, |view, list, event, window, cx| {
            if !view.projects_open || !view.project_choices_ready(window, cx) {
                return;
            }
            if let ListEvent::Confirm(ix) = event
                && let Some(id) = list.read(cx).delegate().at(*ix).map(|p| p.id.clone())
            {
                view.focus_scope(id.clone(), window, cx);
                if view.project_scope.as_ref() == Some(&id) {
                    view.projects_open = false;
                    view.chats.update(cx, |l, cx| l.focus(window, cx));
                    cx.notify();
                }
            } else if matches!(event, ListEvent::Cancel) {
                view.projects_open = false;
                view.chats.update(cx, |l, cx| l.focus(window, cx));
                cx.notify();
            }
        });
        let shell_events =
            cx.subscribe_in(
                &overview,
                window,
                |view, _, event, window, cx| match event {
                    ShellEvent::Project(id) => view.show_project(id.clone(), window, cx),
                    ShellEvent::AllChats => view.show_chats(window, cx),
                    ShellEvent::Chat(id) => {
                        if let Some(chat) = view.state.chats.iter().find(|c| &c.id == id).cloned() {
                            view.open(chat, window, cx);
                        }
                    }
                },
            );
        let transcript = cx.new(|cx| TranscriptView::readonly(window, cx));
        let history_owner = cx.weak_entity();
        transcript.update(cx, |view, _| {
            view.set_history_guard(move |w, cx| {
                history_owner
                    .update(cx, |owner, cx| owner.project_choices_ready(w, cx))
                    .unwrap_or(false)
            })
        });
        let editor = cx.new(|cx| ChatEditor::new(writer.clone(), window, cx));
        let context_entry = context_usage_view::entry(cx);
        let todos_entry = session_todos_tray::entry(window, cx);
        editor.update(cx, |editor, _| {
            editor.set_context_entry(context_entry.into());
            editor.set_todos_entry(todos_entry.into());
        });
        let mission =
            cx.new(|cx| crate::mission_view::MissionForm::new(writer.clone(), window, cx));
        let missions = cx.new(crate::mission_browser_view::Browser::new);
        let (mission_context, mission_context_events) = Self::mission_context_parts(window, cx);
        let missions_events = cx.subscribe_in(
            &missions,
            window,
            |view, _, event: &crate::mission_browser_view::Event, window, cx| {
                use crate::mission_browser_view::Event;
                if !matches!(view.page, Page::Missions | Page::Mission(_)) {
                    return;
                }
                match event {
                    Event::Open { key, generation }
                        if view.page == Page::Missions
                            && view.missions.read(cx).can_open(key, *generation) =>
                    {
                        view.show_mission_overview(key.clone(), window, cx);
                    }
                    Event::List { generation }
                        if view.missions.read(cx).generation == *generation =>
                    {
                        view.show_missions(window, cx);
                    }
                    Event::Chat {
                        key,
                        id,
                        generation,
                    } if view.page == Page::Mission(key.clone())
                        && view.missions.read(cx).can_link(key, id, *generation) =>
                    {
                        if !view.mission_navigation_ready(window, cx) {
                            return;
                        }
                        if let Some(chat) = view
                            .state
                            .chats
                            .iter()
                            .find(|c| &c.id == id && !c.local_draft)
                            .cloned()
                        {
                            view.open(chat, window, cx);
                        }
                    }
                    _ => {}
                }
            },
        );
        let add_project = cx.new(|cx| crate::project_add_view::ProjectAdd::new(writer.clone(), cx));
        let add_project_events = cx.subscribe_in(&add_project, window, |v, _, _, w, cx| {
            v.add_project_open = false;
            if let Some(f) = v.add_project_return.take() {
                f.focus(w, cx);
            }
            cx.notify();
        });
        let mission_events = cx.subscribe_in(&mission, window, |view, _, _, window, cx| {
            view.mission_open = false;
            if let Some(focus) = view.mission_return.take() {
                focus.focus(window, cx);
            }
            cx.notify();
        });
        let editor_events =
            cx.subscribe_in(&editor, window, |view, _, event, window, cx| match event {
                EditorEvent::AddProject => view.open_add_project(window, cx),
                EditorEvent::DraftsChanged => view.rebuild_nav(window, cx),
                EditorEvent::Flushed => cx.quit(),
                EditorEvent::StopRequested { key } => {
                    if view
                        .selected
                        .as_deref()
                        .is_some_and(|id| key.strip_prefix("chat:") == Some(id))
                    {
                        view.state.thinking = false;
                        if let Some(client) = &view.client {
                            client.command(Command::StopThinking {
                                generation: view.generation,
                            });
                        }
                        cx.notify();
                    }
                }
                EditorEvent::OpenCreated {
                    key,
                    revision,
                    target,
                } => {
                    if view.jump.is_some()
                        || view.page != Page::Chat
                        || !view.editor.update(cx, |editor, cx| {
                            editor.can_adopt_creation(key, *revision, target, window, cx)
                        })
                    {
                        return;
                    }
                    view.open(
                        Chat {
                            failure: None,
                            context_usage: Default::default(),
                            id: target.clone(),
                            title: "Local chat".into(),
                            state: "starting".into(),
                            archived: false,
                            local_draft: false,
                            writable: true,
                            busy: true,
                            signal: Some(Signal::Working),
                            background_work: false,
                            cwd: String::new(),
                            project_id: None,
                            model_configuration: None,
                            attention: None,
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
        let artifact_events = cx.subscribe_in(
            &transcript,
            window,
            |view, _, event: &crate::transcript_view::ArtifactOpen, window, cx| {
                if view.client.is_none() {
                    return;
                }
                if view.selected.as_deref() != Some(&event.0.session) {
                    view.state.chat_status = "Artifact owner mismatch; no lookup performed.".into();
                    cx.notify();
                    return;
                }
                if !view.prepare_navigation(window, cx) {
                    return;
                }
                view.artifacts_open = true;
                view.artifacts.update(cx, |pane, cx| {
                    pane.context(view.selected.clone(), view.state.artifacts.clone(), cx);
                    pane.artifact_metadata(view.state.artifact_metadata.clone(), cx);
                    pane.open(event.0.clone(), window, cx);
                });
                cx.notify();
            },
        );
        let history_events = cx.subscribe(
            &transcript,
            |view, _, event: &crate::transcript_view::HistoryTop, cx| {
                if event.0 == view.generation {
                    view.earlier(false, cx);
                }
            },
        );
        let latest_events = cx.subscribe_in(
            &transcript,
            window,
            |view, _, event: &crate::transcript_view::LatestRequested, w, cx| {
                if event.0 == view.generation
                    && view.selected.is_some()
                    && view.page == Page::Chat
                    && !view.artifacts_open
                    && view.project_choices_ready(w, cx)
                {
                    view.latest(cx);
                }
            },
        );
        let (navigation, scope_states, reader_marks) = Self::navigation_state();
        let settings = cx.new(|_| crate::settings_view::SettingsPreferences::new(None));
        let chat_actions = cx.new(crate::chat_actions_view::Actions::new);
        let chat_action_events = cx.subscribe_in(
            &chat_actions,
            window,
            |v, _, _: &crate::chat_actions_view::Changed, _, cx| {
                v.sync_chat_action_permission(cx);
                cx.notify();
            },
        );
        settings.update(cx, |owner, cx| owner.load(cx));
        Self {
            chat_actions,
            settings,
            settings_window: None,
            usage_options: None,
            usage_window: None,
            usage_events: None,
            settings_pane: None,
            settings_return: None,
            settings_events: Vec::new(),
            #[cfg(feature = "native-probes")]
            settings_fixture_size: None,
            navigation,
            navigation_seeded: false,
            restoring_navigation: false,
            scope_states,
            reader_marks,
            pending_reader: None,
            page: Page::Chat,
            project_scope: None,
            projects,
            overview,
            inbox,
            missions,
            mission_context,
            queue_forms: Vec::new(),
            queue_open: None,
            conversation_links: None,
            workspace_changes: None,
            session_failure_fence: Default::default(),
            session_failure_focus: cx.focus_handle().tab_stop(true),
            projects_open: false,
            jump: None,
            jump_subscription: None,
            jump_return: None,
            mission,
            mission_open: false,
            mission_return: None,
            add_project,
            add_project_open: false,
            add_project_return: None,
            project_catalog_reply: None,
            nav_projects: Arc::new(Vec::new()),
            pending_transcript: None,
            nav_error: None,
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
            _subscriptions: vec![
                chat_action_events,
                subscription,
                mission_events,
                missions_events,
                mission_context_events,
                add_project_events,
                editor_events,
                artifact_events,
                history_events,
                latest_events,
                project_events,
                shell_events,
                inbox_events,
            ],
            updates: None,
            writes: None,
            editor,
            writer,
            nav_chats: Arc::new(Vec::new()),
            nav_drafts: Vec::new(),
            refreshing: false,
            earlier_attempt: None,
            earlier_request: None,
            details_open: false,
            artifacts: cx.new(|_| crate::artifact_view::ArtifactPane::new()),
            artifacts_open: false,
            #[cfg(feature = "native-probes")]
            render_count: 0,
        }
    }

    fn connect_model_controls(
        &mut self,
        options: LocalOptions,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.editor
            .update(cx, |e, cx| e.enable_models(options.clone(), window, cx));
        let models =
            cx.new(|cx| crate::scoped_models_view::ScopedModels::new(Some(options), window, cx));
        self.settings
            .update(cx, |owner, _| owner.models = Some(models.clone()));
        self._subscriptions.push(cx.subscribe_in(
            &models,
            window,
            |view, _, _: &crate::scoped_models_view::ScopeChanged, w, cx| {
                view.editor.update(cx, |e, cx| e.invalidate_models(w, cx))
            },
        ));
    }
    fn open(&mut self, chat: Chat, window: &mut Window, cx: &mut Context<Self>) -> bool {
        if !self.prepare_navigation(window, cx) {
            return false;
        }
        let leaving_missions = matches!(self.page, Page::Missions | Page::Mission(_));
        if chat.local_draft {
            self.page = Page::Chat;
            self.nav_error = None;
            self.clear_chat(cx);
            self.title = "New Local chat draft".into();
            self.editor.update(cx, |editor, cx| {
                editor.select(chat.id, true, false, window, cx)
            });
            self.rebuild_nav(window, cx);
            self.did_navigate(cx);
            if leaving_missions {
                self.focus_mission_chat_destination(window, cx);
            }
            return true;
        }
        if self.selected.as_ref() == Some(&chat.id) {
            self.page = Page::Chat;
            self.nav_error = None;
            self.resume_transcript(cx);
            self.rebuild_nav(window, cx);
            self.did_navigate(cx);
            if leaving_missions {
                self.focus_mission_chat_destination(window, cx);
            }
            return true;
        }
        let generation = self.generation + 1;
        if !self.client.as_ref().is_some_and(|client| {
            client.command(Command::Open {
                id: chat.id.clone(),
                generation,
            })
        }) {
            self.nav_error = Some(if self.client.is_some() {
                "Chat could not be opened. Try again."
            } else {
                "This captured view cannot open another chat."
            });
            cx.notify();
            return false;
        }
        self.generation = generation;
        self.page = Page::Chat;
        self.nav_error = None;
        self.pending_transcript = None;
        self.earlier_attempt = None;
        self.earlier_request = None;
        self.refreshing = false;
        let key = format!("chat:{}", chat.id);
        self.editor.update(cx, |editor, cx| {
            editor.select(key, chat.writable, chat.busy, window, cx)
        });
        self.selected = Some(chat.id);
        self.pending_reader = self.selected.as_ref().and_then(|id| {
            self.reader_marks
                .get(id)
                .cloned()
                .map(|mark| (generation, id.clone(), mark))
        });
        self.artifacts_open = false;
        self.state.artifacts = Arc::new(Vec::new());
        self.state.artifact_metadata = Default::default();
        self.artifacts.update(cx, |pane, cx| {
            pane.context(self.selected.clone(), self.state.artifacts.clone(), cx);
            pane.artifact_metadata(self.state.artifact_metadata.clone(), cx);
        });
        self.title = chat.title;
        self.state.cursor = None;
        self.state.page_busy = false;
        self.state.chat_status = "Loading chat…".into();
        self.state.queued = 0;
        self.state.thinking = false;
        self.rebuild_nav(window, cx);
        let fold_scope = self
            .usage_options
            .clone()
            .zip(self.selected.clone())
            .map(|(o, id)| crate::session_todos::Source::new(o, id, generation));
        self.transcript.update(cx, |view, cx| {
            view.history_scope(generation);
            view.fold_scope(fold_scope);
            view.set_history_controls(Default::default(), cx);
            view.replace_readonly(Vec::new(), true, cx);
        });
        self.did_navigate(cx);
        if leaving_missions {
            self.focus_mission_chat_destination(window, cx);
        }
        true
    }

    fn accept(&mut self, mut state: Presentation, window: &mut Window, cx: &mut Context<Self>) {
        if self.refreshing && state.generation == self.generation && !state.loaded {
            self.state.projects = state.projects;
            self.state.projects_loaded = state.projects_loaded;
            self.state.projects_error = state.projects_error;
            self.state.chats = state.chats;
            self.state.mission_metadata = state.mission_metadata;
            self.state.status = state.status;
            self.state.chat_status = state.chat_status;
            self.state.thinking = state.thinking;
            self.state.todos = state.todos;
        } else if state.generation == self.generation {
            if self
                .earlier_request
                .is_some_and(|(generation, before, revision)| {
                    generation != state.generation
                        || state.cursor != Some(before)
                        || state.page_revision > revision
                        || !state.loaded
                })
            {
                self.earlier_request = None;
            }
            // A coalesced publication from before the request is not completion.
            state.page_busy |= self.earlier_request.is_some();
            let rows = std::mem::take(&mut state.rows);
            let reset = self.refreshing;
            self.refreshing = false;
            if self.page == Page::Chat {
                self.transcript.update(cx, |view, cx| {
                    view.history_scope(self.generation);
                    view.replace_readonly(rows, reset, cx);
                    if reset {
                        view.latest(cx);
                    }
                });
                self.pending_transcript = None;
            } else {
                let reset = reset
                    || self
                        .pending_transcript
                        .as_ref()
                        .is_some_and(|(_, reset)| *reset);
                self.pending_transcript = Some((rows, reset));
            }
            self.state = state;
        } else {
            // An old chat never replaces the selected chat, even while switching quickly.
            self.state.chats = state.chats;
            self.state.mission_metadata = state.mission_metadata;
            self.state.status = state.status;
            self.state.projects = state.projects;
            self.state.projects_loaded = state.projects_loaded;
            self.state.projects_error = state.projects_error;
        }
        if let Some(chat) = self
            .selected
            .as_ref()
            .and_then(|id| self.state.chats.iter().find(|c| &c.id == id))
        {
            let (writable, busy) = (chat.writable, chat.busy || self.state.queued > 0);
            self.editor.update(cx, |editor, cx| {
                editor.permission(writable, busy, cx);
                editor.background(chat.background_work, cx);
                if let Some(configuration) = &chat.model_configuration {
                    editor.model_context(&chat.id, &chat.cwd, configuration.clone(), window, cx);
                }
            });
        }
        self.editor.update(cx, |editor, cx| {
            editor.activity(self.state.thinking && self.selected.is_some(), cx)
        });
        let question_fresh = self.state.generation == self.generation
            && self.state.loaded
            && !self.state.page_busy
            && self.selected.as_ref().is_some_and(|id| {
                self.state.chats.iter().any(|chat| {
                    &chat.id == id && matches!(chat.state.as_str(), "idle" | "parked" | "failed")
                })
            });
        self.editor.update(cx, |editor, cx| {
            editor.question_context(
                self.selected.as_deref(),
                self.state.question.clone(),
                question_fresh,
                window,
                cx,
            )
        });
        self.sync_session_failure(window, cx);
        self.restore_reader(cx);
        self.sync_history_controls(cx);
        self.rebuild_nav(window, cx);
        self.artifacts.update(cx, |pane, cx| {
            pane.context(self.selected.clone(), self.state.artifacts.clone(), cx);
            pane.artifact_metadata(self.state.artifact_metadata.clone(), cx);
        });
        self.sync_chat_action_permission(cx);
        self.sync_queue(cx);
        cx.notify();
    }

    fn clear_chat(&mut self, cx: &mut Context<Self>) {
        self.pending_reader = None;
        self.pending_transcript = None;
        self.editor
            .update(cx, |editor, cx| editor.activity(false, cx));
        self.artifacts_open = false;
        self.state.artifacts = Arc::new(Vec::new());
        self.state.artifact_metadata = Default::default();
        self.artifacts.update(cx, |pane, cx| {
            pane.context(None, self.state.artifacts.clone(), cx);
            pane.artifact_metadata(self.state.artifact_metadata.clone(), cx);
        });
        self.refreshing = false;
        self.generation += 1;
        self.earlier_attempt = None;
        self.earlier_request = None;
        self.selected = None;
        self.sync_mission_context(cx);
        self.chats.update(cx, |list, cx| {
            list.delegate_mut().opened = None;
            cx.notify();
        });
        self.state.cursor = None;
        self.state.chat_status.clear();
        self.state.queued = 0;
        self.state.thinking = false;
        self.transcript
            .update(cx, |v, cx| v.set_history_controls(Default::default(), cx));
        if let Some(client) = &self.client {
            client.command(Command::Clear {
                generation: self.generation,
            });
        }
        self.transcript.update(cx, |view, cx| {
            view.history_scope(self.generation);
            view.replace_readonly(Vec::new(), true, cx);
        });
    }
    fn earlier(&mut self, manual: bool, cx: &mut Context<Self>) {
        if self.page != Page::Chat {
            return;
        }
        if self.earlier_request.is_some() && !manual {
            // A fitting list's bounce may re-arm Tail during another upward
            // wheel packet. Preserve that explicit reader intent while paging.
            self.transcript
                .update(cx, |view, cx| view.hold_for_history(cx));
            return;
        }
        let Some(before) = self.state.cursor else {
            return;
        };
        let key = (self.generation, before);
        if self.selected.is_none()
            || self.artifacts_open
            || self.refreshing
            || !self.state.loaded
            || self.state.generation != self.generation
            || self.state.page_busy
            || self.earlier_request.is_some()
            || (!manual && self.earlier_attempt == Some(key))
        {
            return;
        }
        if self.client.as_ref().is_some_and(|client| {
            client.command(Command::Earlier {
                before,
                generation: self.generation,
            })
        }) {
            self.earlier_attempt = Some(key);
            self.earlier_request = Some((self.generation, before, self.state.page_revision));
            self.state.page_busy = true;
            self.sync_history_controls(cx);
            self.transcript
                .update(cx, |view, cx| view.hold_for_history(cx));
            cx.notify();
        }
    }
    fn latest(&mut self, cx: &mut Context<Self>) {
        self.pending_reader = None;
        self.nav_error = None;
        if self.state.limited
            && let (Some(client), Some(id)) = (&self.client, &self.selected)
        {
            let generation = self.generation + 1;
            if client.command(Command::Open {
                id: id.clone(),
                generation,
            }) {
                self.generation = generation;
                self.earlier_attempt = None;
                self.earlier_request = None;
                self.transcript
                    .update(cx, |view, _| view.history_scope(generation));
                self.refreshing = true;
                self.state.thinking = false;
                self.editor
                    .update(cx, |editor, cx| editor.activity(false, cx));
                self.state.page_busy = true;
                self.state.chat_status = "Loading newest bounded window…".into();
                self.sync_history_controls(cx);
                cx.notify();
                return;
            }
        }
        self.transcript.update(cx, |view, cx| view.latest(cx));
        self.sync_history_controls(cx);
    }
    fn new_chat(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.editor.read(cx).ready() {
            return;
        }
        if !self.prepare_navigation(window, cx) {
            return;
        }
        self.page = Page::Chat;
        self.change_scope(None, window, cx);
        self.chats.update(cx, |list, cx| {
            // This remains an explicitly global creation flow, not project authority.
            list.delegate_mut().project = None;
            list.delegate_mut().filter();
            cx.notify();
        });
        // Do not inherit another agent's isolated working copy as a Build destination.
        let cwd = String::new();
        self.nav_error = None;
        self.clear_chat(cx);
        self.title = "New Local chat".into();
        self.editor
            .update(cx, |editor, cx| editor.new_draft(cwd, window, cx));
        self.did_navigate(cx);
    }
    fn resume_transcript(&mut self, cx: &mut Context<Self>) {
        if let Some((rows, reset)) = self.pending_transcript.take() {
            self.transcript.update(cx, |view, cx| {
                view.history_scope(self.generation);
                view.replace_readonly(rows, reset, cx);
                if reset {
                    view.latest(cx);
                }
            });
        }
        self.restore_reader(cx);
        self.sync_history_controls(cx);
    }
    fn leave_artifacts(&mut self, cx: &mut Context<Self>) {
        if self.artifacts_open {
            self.artifacts_open = false;
            self.artifacts.update(cx, |p, cx| p.hide_gallery(cx));
        }
    }
    fn show_home(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.prepare_navigation(window, cx) {
            return;
        }
        self.leave_artifacts(cx);
        self.page = Page::Home;
        self.nav_error = None;
        self.change_scope(None, window, cx);
        self.rebuild_nav(window, cx);
        self.chats.update(cx, |list, cx| list.focus(window, cx));
        self.did_navigate(cx);
    }
    fn show_project(&mut self, id: String, window: &mut Window, cx: &mut Context<Self>) {
        if !crate::local_model::valid_id(&id) || !self.prepare_navigation(window, cx) {
            return;
        }
        self.leave_artifacts(cx);
        self.page = Page::Project(id.clone());
        self.change_scope(Some(id), window, cx);
        self.nav_error = None;
        self.rebuild_nav(window, cx);
        self.chats.update(cx, |list, cx| list.focus(window, cx));
        self.did_navigate(cx);
    }
    fn show_chats(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.prepare_navigation(window, cx) {
            return;
        }
        self.leave_artifacts(cx);
        self.page = Page::Chat;
        self.change_scope(None, window, cx);
        self.nav_error = None;
        self.resume_transcript(cx);
        self.rebuild_nav(window, cx);
        self.chats.update(cx, |list, cx| list.focus(window, cx));
        self.did_navigate(cx);
    }
    fn show_inbox(&mut self, filter: Option<String>, window: &mut Window, cx: &mut Context<Self>) {
        if filter
            .as_ref()
            .is_some_and(|id| !crate::local_model::valid_id(id))
        {
            return;
        }
        if !self.prepare_navigation(window, cx) {
            self.inbox.update(cx, |v, cx| v.restore_filter(window, cx));
            return;
        }
        self.leave_artifacts(cx);
        self.page = Page::Inbox(filter);
        self.nav_error = None;
        self.rebuild_nav(window, cx);
        self.inbox.update(cx, |v, cx| v.focus(window, cx));
        self.did_navigate(cx);
    }
    fn rebuild_nav(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.sync_missions(window, cx);
        self.sync_mission_context(cx);
        self.editor.update(cx, |editor, cx| {
            editor.projects(
                self.state.projects.clone(),
                self.state.projects_loaded,
                self.state.projects_error,
                window,
                cx,
            )
        });
        if let Some(palette) = &self.jump {
            let source = self.jump_source();
            palette.update(cx, |v, cx| v.sync(source, window, cx));
        }
        if let Page::Inbox(filter) = &self.page {
            self.inbox.update(cx, |view, cx| {
                view.sync(
                    crate::inbox::InboxInput {
                        chats: self.state.chats.clone(),
                        projects: self.state.projects.clone(),
                        filter: filter.clone(),
                        loaded: self.state.list_loaded,
                        projects_error: self.state.projects_error.is_some(),
                    },
                    window,
                    cx,
                )
            });
        }
        if matches!(self.page, Page::Home | Page::Project(_)) {
            self.overview.update(cx, |view, cx| {
                view.sync(
                    OverviewInput {
                        projects: self.state.projects.clone(),
                        chats: self.state.chats.clone(),
                        project: self.project_scope.clone(),
                        projects_loaded: self.state.projects_loaded,
                        chats_loaded: self.state.list_loaded,
                        error: self.state.projects_error,
                    },
                    cx,
                )
            });
        }
        let empty_label = if self.state.projects_error.is_some() {
            "Project list unavailable"
        } else if !self.state.projects_loaded {
            "Loading Local projects…"
        } else {
            "No configured projects"
        };
        let projects_changed = !Arc::ptr_eq(&self.nav_projects, &self.state.projects)
            || self.projects.read(cx).delegate().selected != self.project_scope;
        if projects_changed || self.projects.read(cx).delegate().empty_label != empty_label {
            self.nav_projects = self.state.projects.clone();
            self.projects.update(cx, |list, cx| {
                let d = list.delegate_mut();
                d.all = self.state.projects.clone();
                d.empty_label = empty_label;
                d.selected = self.project_scope.clone();
                if projects_changed {
                    let index = self
                        .project_scope
                        .as_ref()
                        .and_then(|id| self.state.projects.iter().position(|p| &p.id == id))
                        .map(IndexPath::new);
                    list.set_selected_index(index, window, cx);
                }
                cx.notify();
            });
        }
        let drafts = self.editor.read(cx).new_drafts();
        let opened = if self.page == Page::Chat {
            self.selected.clone()
        } else {
            None
        };
        if Arc::ptr_eq(&self.nav_chats, &self.state.chats)
            && drafts == self.nav_drafts
            && self.chats.read(cx).delegate().opened == opened
            && self.chats.read(cx).delegate().loaded == self.state.list_loaded
            && self.chats.read(cx).delegate().project == self.project_scope
        {
            return;
        }
        let metadata_changed =
            !Arc::ptr_eq(&self.nav_chats, &self.state.chats) || drafts != self.nav_drafts;
        self.nav_chats = self.state.chats.clone();
        self.nav_drafts = drafts.clone();
        let all = if !metadata_changed {
            self.chats.read(cx).delegate().all.clone()
        } else if drafts.is_empty() {
            self.state.chats.clone()
        } else {
            let mut all: Vec<_> = drafts
                .into_iter()
                .map(|(key, title)| Chat {
                    failure: None,
                    context_usage: Default::default(),
                    model_configuration: None,
                    id: key,
                    title,
                    state: "Draft".into(),
                    archived: false,
                    local_draft: true,
                    writable: false,
                    busy: false,
                    signal: None,
                    background_work: false,
                    cwd: String::new(),
                    project_id: None,
                    attention: None,
                })
                .collect();
            all.extend(self.state.chats.iter().cloned());
            Arc::new(all)
        };
        self.chats.update(cx, |list, cx| {
            let selected = list
                .delegate()
                .selected
                .and_then(|ix| list.delegate().at(ix))
                .map(|c| c.id.clone());
            let delegate = list.delegate_mut();
            delegate.all = all;
            delegate.opened = opened;
            delegate.loaded = self.state.list_loaded;
            delegate.project = self.project_scope.clone();
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
        #[cfg(feature = "native-probes")]
        {
            self.render_count += 1;
        }
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
        let history_status = if self.earlier_request.is_some() {
            "Loading earlier messages…"
        } else {
            self.state.chat_status.as_str()
        };
        div().id("desktop-root").test_support().relative().h_flex().items_stretch().size_full().min_w_0()
            .bg(cx.theme().background).text_color(cx.theme().foreground)
            .capture_key_down(cx.listener(|v,e:&gpui_kit::KeyDownEvent,w,cx|{
                if let Some(form)=&v.queue_open {
                    let marked=form.update(cx,|f,cx|f.marked(w,cx));
                    let key=e.keystroke.key.as_str(); let modified=e.keystroke.modifiers.platform||e.keystroke.modifiers.control;
                    if (marked && matches!(key,"enter"|"escape"|"tab")) || (modified && !matches!(key,"c"|"v"|"x"|"a"|"z"|"q"|"enter")) {cx.stop_propagation();}
                }
                if v.add_project_open {
                    let modified=e.keystroke.modifiers.platform||e.keystroke.modifiers.control;
                    if modified && !matches!(e.keystroke.key.as_str(),"c"|"q"|"enter") {cx.stop_propagation();}
                }
                if v.mission_open {
                    let marked=v.mission.update(cx,|f,cx|f.marked(w,cx));
                    let key=e.keystroke.key.as_str();let modified=e.keystroke.modifiers.platform||e.keystroke.modifiers.control;
                    if (marked && matches!(key,"enter"|"escape"|"tab")) || (modified && !matches!(key,"c"|"v"|"x"|"a"|"q"|"enter")) {cx.stop_propagation();}
                }
                if let Some(palette)=v.jump.clone() {
                    let marked=palette.update(cx,|p,cx|p.marked(w,cx));
                    let key=e.keystroke.key.as_str();
                    let modified=e.keystroke.modifiers.platform||e.keystroke.modifiers.control;
                    if key=="tab" || (marked && (matches!(key,"enter"|"escape") || (modified && key=="k"))) || (modified && !matches!(key,"c"|"v"|"x"|"a"|"k"|"q")) {cx.stop_propagation();}
                }
            }))
            .on_action(cx.listener(|v,_:&ToggleJump,w,cx|{v.toggle_jump(w,cx);cx.stop_propagation();}))
            // Capture above the transcript so releasing a dragged thumb in the
            // header/sidebar still completes top-of-history navigation.
            .capture_any_mouse_up(cx.listener(|view,_,_,cx|{
                if view.jump.is_none() && !view.mission_open && !view.add_project_open && view.page==Page::Chat && !view.artifacts_open && view.selected.is_some() {
                    view.transcript.update(cx,|v,cx|v.history_scrollbar_released(cx));
                }
            }))
            .on_action(cx.listener(|view,_:&crate::transcript_view::Quit,_,cx|{
                cx.stop_propagation();
                if !view.settings.update(cx,|owner,cx|owner.request_close(cx)){return;}
                if view.editor.update(cx,|editor,cx|editor.request_close(cx)){cx.quit();}
            }))
            .on_action(cx.listener(|view,_:&crate::transcript_view::FocusComposer,window,cx|{
                if view.jump.is_some()||view.mission_open||view.add_project_open{return;}
                if view.page!=Page::Chat {view.show_chats(window,cx);}
                view.editor.update(cx,|editor,cx|editor.focus(window,cx));
            }))
            .on_action(cx.listener(|view,_:&GoHome,window,cx|view.show_home(window,cx)))
            .on_action(cx.listener(|view,_:&crate::settings_view::OpenSettings,window,cx|{view.open_settings(window,cx);cx.stop_propagation();}))
            .on_action(cx.listener(|view,_:&ShowAllChats,window,cx|view.show_chats(window,cx)))
            .on_action(cx.listener(|view,_:&ShowMissions,window,cx|{view.show_missions(window,cx);} ))
            .on_action(cx.listener(|v,_:&workspace_changes_view::Toggle,w,cx|{v.toggle_workspace_changes(w,cx);cx.stop_propagation();}))
            .on_action(cx.listener(|v,_:&conversation_links_view::Toggle,w,cx|{v.toggle_conversation_links(w,cx);cx.stop_propagation();}))
            .on_action(cx.listener(|v,_:&crate::mission_inspector_view::Toggle,w,cx|{v.mission_context_toggle(w,cx);cx.stop_propagation();}))
            .on_action(cx.listener(|view,_:&NavigateBack,window,cx|view.move_navigation(false,window,cx)))
            .on_action(cx.listener(|view,_:&NavigateForward,window,cx|view.move_navigation(true,window,cx)))
            .on_action(cx.listener(|view,_:&FocusChats,window,cx|{
                use gpui_kit::component::WindowExt;
                if window.has_active_dialog(cx) || window.has_active_sheet(cx) || !view.project_choices_ready(window,cx) { return; }
                // Preserve the existing sidebar Find shortcut outside the active
                // conversation and its ordinary composer.
                if view.page==Page::Chat && view.selected.is_some() && view.state.loaded && !view.artifacts_open
                    && (view.editor.update(cx,|e,cx|e.conversation_find_ready(window,cx)) || view.transcript.read(cx).find_focused(window,cx)) {
                    view.transcript.update(cx,|t,cx|t.open_find(window,cx));
                } else { view.chats.update(cx,|list,cx|list.focus(window,cx)); }
                cx.stop_propagation();
            }))
            .child(self.sidebar(window,cx))
            .child(
                if matches!(self.page,Page::Missions|Page::Mission(_)) {
                    div().id("missions").test_support().v_flex().flex_1().min_w_0().min_h_0().h_full().child(self.missions.clone().cached(gpui_kit::StyleRefinement::default().size_full().min_h_0().min_w_0())).into_any_element()
                } else if matches!(self.page,Page::Inbox(_)) {
                    div().id("inbox").test_support().v_flex().flex_1().min_w_0().min_h_0().h_full()
                        .child(self.inbox.clone().cached(gpui_kit::StyleRefinement::default().size_full().min_h_0().min_w_0())).into_any_element()
                } else if self.page!=Page::Chat {
                    div().id("overview").test_support().v_flex().flex_1().min_w_0().min_h_0().h_full()
                        .child(self.overview.clone().cached(gpui_kit::StyleRefinement::default().size_full().min_h_0().min_w_0())).into_any_element()
                } else {
                let new_draft = self.editor.read(cx).navigation_key().is_some_and(|key| key.starts_with("new:"));
                if new_draft {
                    use gpui_kit::component::scroll::ScrollableElement;
                    let content = div().v_flex().w_full().min_h_full().justify_center()
                        .py(px(crate::ui::Space::HOME)).px_3()
                        .child(div().id("conversation-editor").test_support().w_full().min_w_0()
                            .max_w(px(760.)).mx_auto().child(self.editor.clone()));
                    div().id("new-chat-page").test_support().v_flex().flex_1().min_w_0().min_h_0().h_full()
                        .child(div().size_full().min_w_0().child(content).overflow_y_scrollbar())
                        .into_any_element()
                } else {
                let conversation = div().id("conversation").test_support().v_flex().flex_1().min_w_0().min_h_0().h_full()
                    .child(div().v_flex().px_3().py_2().gap_1().border_b_1().border_color(cx.theme().border)
                        .child(div().text_base().font_semibold().truncate().child(SharedString::from(self.title.clone())))
                        .when(!cwd.is_empty(),|this|this.child(div().text_xs().truncate().text_color(cx.theme().muted_foreground).child(SharedString::from(cwd))))
                        .child(div().h_flex().items_center().gap_2().min_w_0()
                            .when(self.selected.is_some()&&!self.artifacts_open,|this|this.child(self.history_menu(cx)))
                            .child(self.conversation_links_action(cx))
                            .child(self.workspace_changes_action(cx))
                            .child(self.queued_message_action(cx))
                            .child(self.mission_context_action(cx))
                            .child(crate::ui::action("make-mission",if self.selected.as_ref().is_some_and(|id|self.mission.read(cx).has_attempt(id)){"Mission…"}else{"Make a mission…"},crate::ui::Action::Quiet)
                                .disabled(!self.can_make_mission(cx)).on_click(cx.listener(|view,_,w,cx|view.open_mission(w,cx))))
                            .when(!self.state.artifacts.is_empty()||self.artifacts_open,|this|this.child(Button::new("artifact-gallery").ghost().small().icon(if self.artifacts_open{AppIcon::Back.asset()}else{AppIcon::Artifacts.asset()}).label(if self.artifacts_open{"Back to chat"}else{"Artifacts"})
                                .on_click(cx.listener(|view,_,window,cx|{if !view.prepare_navigation(window,cx){return;}view.artifacts_open = !view.artifacts_open;view.sync_mission_context(cx);if view.artifacts_open{view.artifacts.update(cx,|p,cx|p.show_gallery(window,cx));}else{view.artifacts.update(cx,|p,cx|p.hide_gallery(cx));view.editor.update(cx,|editor,cx|editor.focus(window,cx));}cx.notify();}))))
                            .child(div().flex_1().min_w_0().text_xs().truncate().text_color(cx.theme().muted_foreground)
                                .child(SharedString::from(format!("{}{}",history_status,if self.state.queued>0{format!(" · {} queued",self.state.queued)}else{String::new()}))))))
                    .when_some(self.session_failure_banner(cx), |d, banner| d.child(banner))
                    .child(div().v_flex().flex_1().min_h_0().min_w_0().w_full().max_w(px(if self.artifacts_open {760.} else {crate::ui::CONVERSATION_MAX_WIDTH})).mx_auto()
                        .when(self.selected.is_some()&&!self.state.loaded,|this|this.child(div().p_3().text_sm().text_color(cx.theme().muted_foreground).child("Loading history…")))
                        .when(self.selected.is_none(),|this|this.child(div().v_flex().flex_1().justify_center().p_6().gap_2()
                            .child(div().font_semibold().child("Choose a chat"))
                            .child(div().text_sm().text_color(cx.theme().muted_foreground).child("Open a Local conversation from the sidebar, or start a new chat."))))
                        .when(self.selected.is_some()&&!self.artifacts_open,|this|this.child(self.transcript.clone().cached(gpui_kit::StyleRefinement::default().size_full().min_h_0().min_w_0())))
                        .when(self.artifacts_open,|this|this.child(self.artifacts.clone().cached(gpui_kit::StyleRefinement::default().size_full().min_h_0().min_w_0()))))
                    .child(div().id("conversation-editor").test_support().w_full().min_w_0().max_w(px(if self.artifacts_open {760.} else {crate::ui::CONVERSATION_MAX_WIDTH})).mx_auto().child(self.editor.clone()))
                    .child(div().v_flex().px_3().py_1().gap_1().border_t_1().border_color(cx.theme().border).text_xs().text_color(cx.theme().muted_foreground)
                        .child(Button::new("view-details").ghost().small().self_start().icon(AppIcon::Info.asset()).label(if self.details_open{"Hide details"}else{"Details"})
                            .on_click(cx.listener(|view,_,_,cx|{view.details_open = !view.details_open;cx.notify();})))
                        .when(self.state.limited&&!self.details_open,|this|this.child("History window full. Refresh latest to see newer messages."))
                        .when(self.details_open,|this|this.child(SharedString::from(format!("{footer} {}",if self.state.omitted>0{"Some structured entries are shown as placeholders."}else{""})))))
                        .into_any_element();
                let conversation = self.mission_companion(conversation, window, cx);
                let conversation = self.conversation_links_companion(conversation, window, cx);
                self.workspace_changes_companion(conversation, window, cx)
                }
                }
            )
            .when_some(self.jump.clone(),|this,palette|this.child(self.jump_overlay(palette,window,cx)))
            .when(self.mission_open,|this|this.child(self.mission_overlay(window,cx)))
            .when(self.add_project_open,|this|this.child(self.add_project_overlay(window,cx)))
    }
}
#[cfg(test)]
mod refresh_tests {
    use super::*;
    use gpui_kit::{TestAppContext, WindowOptions};
    #[gpui_kit::test]
    fn top_history_admission_fences_busy_stale_failure_retry_and_exhaustion(
        cx: &mut TestAppContext,
    ) {
        cx.update(|cx| {
            gpui_kit::init(cx);
            crate::init_appearance(cx);
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
        let (client, commands) = LocalClient::synthetic_commands();
        view.update(cx, |v, _| {
            v.client = Some(client);
            v.generation = 7;
            v.state.generation = 7;
            v.state.loaded = true;
            v.state.cursor = Some(100);
        });
        let signal = |cx: &mut TestAppContext, generation| {
            view.update(cx, |v, cx| {
                v.transcript.update(cx, |_, cx| {
                    cx.emit(crate::transcript_view::HistoryTop(generation))
                })
            });
            cx.run_until_parked();
        };
        signal(cx, 6);
        assert!(commands.try_recv().is_err());
        for _ in 0..32 {
            signal(cx, 7);
        }
        assert!(matches!(
            commands.try_recv(),
            Ok(Command::Earlier {
                before: 100,
                generation: 7
            })
        ));
        assert!(commands.try_recv().is_err());
        cx.update_window(handle, |_, window, cx| {
            view.update(cx, |v, cx| {
                let mut stale = v.state.clone();
                stale.page_busy = false;
                v.accept(stale, window, cx);
                assert!(v.state.page_busy);
                v.earlier(true, cx);
            })
        })
        .unwrap();
        signal(cx, 7);
        assert!(
            commands.try_recv().is_err(),
            "stale idle projection is not page completion"
        );
        cx.update_window(handle, |_, window, cx| {
            view.update(cx, |v, cx| {
                let mut error = v.state.clone();
                error.page_busy = false;
                error.page_revision += 1;
                error.chat_status = "Synthetic read failure".into();
                v.accept(error, window, cx);
                assert!(!v.state.page_busy);
            })
        })
        .unwrap();
        for _ in 0..32 {
            signal(cx, 7);
        }
        assert!(
            commands.try_recv().is_err(),
            "same-cursor failure cannot create retry storm"
        );
        view.update(cx, |v, cx| v.earlier(true, cx));
        assert!(matches!(
            commands.try_recv(),
            Ok(Command::Earlier {
                before: 100,
                generation: 7
            })
        ));
        cx.update_window(handle, |_, window, cx| {
            view.update(cx, |v, cx| {
                let mut done = v.state.clone();
                done.page_busy = false;
                done.page_revision += 1;
                done.cursor = Some(76);
                v.accept(done, window, cx);
            })
        })
        .unwrap();
        signal(cx, 7);
        assert!(matches!(
            commands.try_recv(),
            Ok(Command::Earlier {
                before: 76,
                generation: 7
            })
        ));
        cx.update_window(handle, |_, window, cx| {
            view.update(cx, |v, cx| {
                let mut done = v.state.clone();
                done.page_busy = false;
                done.page_revision += 1;
                done.cursor = None;
                v.accept(done, window, cx);
            })
        })
        .unwrap();
        signal(cx, 7);
        view.update(cx, |v, cx| v.earlier(true, cx));
        assert!(commands.try_recv().is_err());
        cx.update_window(handle, |_, window, cx| {
            view.update(cx, |v, cx| {
                v.open(
                    Chat {
                        failure: None,
                        context_usage: Default::default(),
                        model_configuration: None,
                        id: "other".into(),
                        title: "Other".into(),
                        state: "idle".into(),
                        archived: false,
                        local_draft: false,
                        writable: false,
                        busy: false,
                        signal: None,
                        background_work: false,
                        cwd: String::new(),
                        project_id: None,
                        attention: None,
                    },
                    window,
                    cx,
                );
            })
        })
        .unwrap();
        assert!(matches!(
            commands.try_recv(),
            Ok(Command::Open { generation: 8, .. })
        ));
        signal(cx, 7);
        signal(cx, 8);
        assert!(
            commands.try_recv().is_err(),
            "no request while new chat is loading"
        );
        cx.update_window(handle, |_, window, cx| {
            view.update(cx, |v, cx| {
                let mut fresh = v.state.clone();
                fresh.generation = 8;
                fresh.loaded = true;
                fresh.page_busy = false;
                fresh.cursor = Some(100);
                v.accept(fresh, window, cx);
            })
        })
        .unwrap();
        signal(cx, 7);
        assert!(commands.try_recv().is_err());
        signal(cx, 8);
        assert!(matches!(
            commands.try_recv(),
            Ok(Command::Earlier {
                before: 100,
                generation: 8
            })
        ));
        assert!(commands.try_recv().is_err());
    }
    #[gpui_kit::test]
    fn publication_navigation_fences_other_owners_without_transport_fallback(
        cx: &mut TestAppContext,
    ) {
        cx.update(|cx| {
            gpui_kit::init(cx);
            crate::init_appearance(cx);
        });
        let (_, view) = cx.update(|cx| {
            gpui_kit::open_window(
                WindowOptions {
                    show: false,
                    ..Default::default()
                },
                cx,
                |window, cx| cx.new(|cx| LocalViewer::synthetic(window, cx)),
            )
            .unwrap()
        });
        let (client, commands) = LocalClient::synthetic_commands();
        let wrong = crate::artifact_model::Reference {
            id: "synthetic-art".into(),
            session: "other".into(),
            revision: 3,
            title: "Synthetic".into(),
            kind: "unknown".into(),
        };
        view.update(cx, |v, cx| {
            v.client = Some(client);
            v.selected = Some("owner".into());
            v.transcript.update(cx, |_, cx| {
                cx.emit(crate::transcript_view::ArtifactOpen(wrong.clone()))
            });
        });
        cx.run_until_parked();
        view.read_with(cx, |v, _| {
            assert!(!v.artifacts_open);
            assert_eq!(v.selected.as_deref(), Some("owner"));
            assert!(v.state.chat_status.contains("owner mismatch"));
        });
        assert!(commands.try_recv().is_err());
        let mut expected = wrong;
        expected.session = "owner".into();
        view.update(cx, |v, cx| {
            v.transcript.update(cx, |_, cx| {
                cx.emit(crate::transcript_view::ArtifactOpen(expected))
            })
        });
        cx.run_until_parked();
        assert!(view.read_with(cx, |v, _| v.artifacts_open));
        assert!(commands.try_recv().is_err());
    }
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
    fn deferred_stop_activity_is_fenced_to_its_originating_chat(cx: &mut TestAppContext) {
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
                        view.state.thinking = true;
                        view
                    })
                },
            )
            .unwrap()
        });
        for (key, matches) in [("chat:other", false), ("chat:synthetic", true)] {
            cx.update_window(handle, |_, _, cx| {
                let editor = view.read(cx).editor.clone();
                editor.update(cx, |_, cx| {
                    cx.emit(EditorEvent::StopRequested { key: key.into() })
                })
            })
            .unwrap();
            cx.run_until_parked();
            cx.update(|cx| assert_eq!(view.read(cx).state.thinking, !matches));
            if matches {
                assert!(matches!(
                    commands.try_recv().unwrap(),
                    Command::StopThinking { generation: 0 }
                ));
            } else {
                assert!(commands.try_recv().is_err());
            }
        }
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
            view.state.thinking=true;
            view.latest(cx);assert!(view.refreshing);assert!(!view.state.thinking);let first=view.generation;
            assert!(matches!(commands.try_recv().unwrap(),Command::Open{generation,..}if generation==first));
            view.state.thinking=true;
            view.accept(Presentation{generation:first,chat_status:"Unavailable; retry explicitly".into(),..Default::default()},window,cx);
            assert!(!view.state.thinking,"loading/reconnect must clear the cached activity");
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
#[cfg(feature = "native-probes")]
#[path = "tool_diff_preview_probe.rs"]
pub(crate) mod tool_diff_preview_probe;

#[cfg(feature = "native-probes")]
#[path = "message_fold_probe.rs"]
pub(crate) mod message_fold_probe;

#[cfg(feature = "native-probes")]
#[path = "new_chat_view_probe.rs"]
pub(crate) mod new_chat_view_probe;
