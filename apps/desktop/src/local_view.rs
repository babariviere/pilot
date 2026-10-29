//! Readonly Local browser. The transport is never given UI events capable of writing.
#[path = "archived_composer.rs"]
mod archived_composer;
#[path = "chat_actions_navigation.rs"]
mod chat_actions_navigation;
#[cfg(feature = "native-probes")]
#[path = "chat_actions_probe.rs"]
pub(crate) mod chat_actions_probe;
#[path = "chat_link_navigation.rs"]
mod chat_link_navigation;
#[cfg(feature = "native-probes")]
#[path = "chat_links_probe.rs"]
pub(crate) mod chat_links_probe;
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
#[path = "draft_discard_probe.rs"]
mod draft_discard_probe;
#[cfg(feature = "native-probes")]
#[path = "glass_probe.rs"]
pub(crate) mod glass_probe;
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
#[path = "menu_routing.rs"]
pub(crate) mod menu_routing;
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
#[path = "native_mermaid_root_probe.rs"]
pub(crate) mod native_mermaid_root_probe;
#[cfg(feature = "native-probes")]
#[path = "navigation_probe.rs"]
pub(crate) mod navigation_probe;
#[path = "navigation_view.rs"]
mod navigation_view;
#[cfg(feature = "native-probes")]
#[path = "path_completion_probe.rs"]
pub(crate) mod path_completion_probe;
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
#[path = "session_jobs_probe.rs"]
pub(crate) mod session_jobs_probe;
#[path = "session_jobs_tray.rs"]
mod session_jobs_tray;
#[path = "session_jobs_log_view.rs"]
mod session_jobs_log_view;
#[cfg(feature = "native-probes")]
#[path = "settings_probe.rs"]
pub(crate) mod settings_probe;
#[cfg(feature = "native-probes")]
#[path = "shell_probe.rs"]
pub(crate) mod shell_probe;
#[path = "side_panel.rs"]
mod side_panel;
#[cfg(feature = "native-probes")]
#[path = "side_panel_probe.rs"]
pub(crate) mod side_panel_probe;
#[cfg(feature = "native-probes")]
#[path = "sidebar_scroll_native.rs"]
pub(crate) mod sidebar_scroll_native;
#[cfg(feature = "native-probes")]
#[path = "style_probe.rs"]
pub(crate) mod style_probe;
#[path = "submit_visibility.rs"]
mod submit_visibility;
#[cfg(feature = "native-probes")]
#[path = "submit_visibility_probe.rs"]
pub(crate) mod submit_visibility_probe;
#[cfg(feature = "native-probes")]
#[path = "subscription_limit_probe.rs"]
pub(crate) mod subscription_limit_probe;
#[cfg(feature = "native-probes")]
#[path = "transcript_find_probe.rs"]
pub(crate) mod transcript_find_probe;
#[cfg(any(target_os = "macos", target_os = "linux"))]
#[path = "update_lifecycle.rs"]
mod update_lifecycle;
#[cfg(any(target_os = "macos", target_os = "linux"))]
#[path = "daemon_upgrade_lifecycle.rs"]
mod daemon_upgrade_lifecycle;
#[cfg(all(feature = "native-probes", any(target_os = "macos", target_os = "linux")))]
#[path = "daemon_upgrade_lifecycle_probe.rs"]
pub(crate) mod daemon_upgrade_lifecycle_probe;
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
    chat_order::{self, SECTIONS},
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
        ToggleJump,
        NewChat
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
    /// Visible indices of `all` in display order, grouped by `chat_order::SECTIONS`.
    filtered: Vec<usize>,
    /// Start of each section in `filtered`, plus its end.
    bounds: [usize; SECTIONS.len() + 1],
    query: String,
    archived: bool,
    selected: Option<IndexPath>,
    opened: Option<String>,
    loaded: bool,
    project: Option<String>,
    projects: Arc<Vec<crate::local_model::Project>>,
    corners: HashMap<String, Entity<CornerView>>,
    /// The list's keyboard focus (its search field), for revealing row actions.
    focus: Option<gpui_kit::FocusHandle>,
    /// Rows that build their action menu button: the hovered row, the selected
    /// row and the row whose menu opened last. Other rows leave the slot empty,
    /// so a scroll frame doesn't lay out and paint a menu button per row.
    hovered: Option<String>,
    menu_row: Option<String>,
}
impl ChatList {
    fn filter(&mut self) {
        let ids: HashSet<_> = self.all.iter().map(|chat| chat.id.as_str()).collect();
        self.corners.retain(|id, _| ids.contains(id.as_str()));
        let sections = chat_order::sections(&self.all, |c| {
            (self.archived || !c.archived)
                && (self.query.is_empty() || c.title.to_lowercase().contains(&self.query))
                && self
                    .project
                    .as_ref()
                    .is_none_or(|id| c.project_id.as_ref() == Some(id))
        });
        self.filtered.clear();
        for (section, rows) in sections.iter().enumerate() {
            self.bounds[section] = self.filtered.len();
            self.filtered.extend(rows);
        }
        self.bounds[SECTIONS.len()] = self.filtered.len();
    }
    fn at(&self, ix: IndexPath) -> Option<&Chat> {
        let start = *self.bounds.get(ix.section)?;
        let end = *self.bounds.get(ix.section + 1)?;
        (start + ix.row < end)
            .then(|| self.filtered.get(start + ix.row))
            .flatten()
            .and_then(|ix| self.all.get(*ix))
    }
    /// Where a chat appears, by canonical id.
    fn index(&self, id: &str) -> Option<IndexPath> {
        let position = self.filtered.iter().position(|ix| self.all[*ix].id == id)?;
        let section = self.bounds.iter().rposition(|start| *start <= position)?;
        Some(IndexPath::new(position - self.bounds[section]).section(section))
    }
    fn first(&self) -> Option<IndexPath> {
        let id = self.all.get(*self.filtered.first()?)?.id.clone();
        self.index(&id)
    }
}
impl ListDelegate for ChatList {
    type Item = ListItem;
    fn sections_count(&self, _: &App) -> usize {
        SECTIONS.len()
    }
    fn items_count(&self, section: usize, _: &App) -> usize {
        self.bounds[section + 1] - self.bounds[section]
    }
    /// Swift's sidebar section header: caption title, with a count for Needs
    /// you and Working. Always rendered so the list measures one header height.
    fn render_section_header(
        &mut self,
        section: usize,
        _: &mut Window,
        cx: &mut Context<ListState<Self>>,
    ) -> Option<impl IntoElement> {
        let kind = SECTIONS[section];
        let count = self.items_count(section, cx);
        Some(
            div()
                .id(SharedString::from(format!(
                    "sidebar-section-{}",
                    kind.key()
                )))
                .test_support()
                .h_flex()
                .items_center()
                .gap_1()
                .pl_2()
                .pt_2()
                .pb_1()
                .text_size(px(appearance::TextRole::CAPTION))
                .font_semibold()
                .text_color(cx.theme().muted_foreground)
                .child(kind.title())
                .when(kind.counted() && count > 0, |d| d.child(count.to_string())),
        )
    }
    fn render_item(
        &mut self,
        ix: IndexPath,
        window: &mut Window,
        cx: &mut Context<ListState<Self>>,
    ) -> Option<ListItem> {
        use gpui_kit::StatefulInteractiveElement as _;
        let chat = self.at(ix)?.clone();
        let section = SECTIONS[ix.section];
        let spec = Spec::row(chat.signal, chat.background_work);
        let corner = self
            .corners
            .entry(chat.id.clone())
            .or_insert_with(|| cx.new(|cx| CornerView::new(spec, window, cx)))
            .clone();
        corner.update(cx, |view, cx| view.configure(spec, cx));
        let has_corner = corner.read(cx).has_corner(cx);
        // RowLine: project (only across all projects), then the state reason.
        // Quiet chats say nothing rather than a raw "idle", and a row never
        // repeats its section heading ("Working" under Working).
        let project = self
            .project
            .is_none()
            .then_some(chat.project_id.as_ref())
            .flatten()
            .and_then(|id| self.projects.iter().find(|p| &p.id == id))
            .map(|p| p.name.clone());
        let (state, full_state) = chat_order::row_state(&chat, section);
        // Named from the session socket's mission list, else the cached
        // catalog; no row reads.
        let mark = mission_mark(&chat, |id| {
            let owner = self.action_owner.upgrade()?;
            let owner = owner.read(cx);
            sidebar_mission_title(
                owner.state.mission_titles.as_deref(),
                owner.local_online(),
                id,
                || {
                    owner
                        .missions
                        .read(cx)
                        .sidebar_mission_name(id)
                        .map(|(title, current)| (title.to_owned(), current))
                },
            )
        });
        let link = mission_link_focus(&chat, window, cx).map(|(mission, focus)| {
            let (chat, owner) = (chat.id.clone(), self.action_owner.clone());
            let tab_stop = self.selected == Some(ix);
            let focused = window.last_input_was_keyboard() && focus.is_focused(window);
            let link = move |segment| mission_link(chat, mission, focus, tab_stop, owner, segment);
            (focused, link)
        });
        let has_project = project.is_some();
        let detail = project
            .iter()
            .cloned()
            .chain((!state.is_empty()).then(|| state.clone()))
            .collect::<Vec<_>>()
            .join(" · ");
        // The accessible name keeps the complete state.
        let spoken = project
            .iter()
            .cloned()
            .chain((!full_state.is_empty()).then_some(full_state))
            .chain(mark.as_ref().map(|m| m.label.clone()))
            .collect::<Vec<_>>()
            .join(" · ");
        // Row actions appear on hover, or on the keyboard-selected row while
        // the list has keyboard focus. The right-click menu reaches them always.
        let menu_shown = self.selected == Some(ix)
            && window.last_input_was_keyboard()
            && self.focus.as_ref().is_some_and(|f| f.is_focused(window));
        // The selected row keeps its button for Tab; the last opened menu's row
        // keeps it so Escape can return focus to the trigger.
        let menu_built = self.selected == Some(ix)
            || self.hovered.as_ref() == Some(&chat.id)
            || self.menu_row.as_ref() == Some(&chat.id);
        let list = cx.entity().downgrade();
        let open_list = list.clone();
        let hover_id = chat.id.clone();
        let open_id = chat.id.clone();
        let owner = self.action_owner.clone();
        let menu_owner = owner.clone();
        let button_owner = owner.clone();
        let menu_chat = chat.clone();
        let button_chat = chat.clone();
        Some(
            ListItem::new(SharedString::from(chat.id.clone()))
                .pl_2()
                .pr_0()
                .py_0()
                .rounded(px(appearance::Radius::ROW))
                .accessibility_label(SharedString::from(if spoken.is_empty() {
                    chat.title.clone()
                } else {
                    format!("{} · {spoken}", chat.title)
                }))
                .hover_fill(!has_corner)
                .confirmed(self.opened.as_ref() == Some(&chat.id))
                .child(
                    div()
                        .id(SharedString::from(format!("chat-row-{}", chat.id)))
                        // Keys don't end the pointer's hover: the button under it stays.
                        .hover_listener_mode(gpui_kit::HoverListenerMode::InputModalityIndependent)
                        .on_hover(move |hovered, _, cx| {
                            let _ = list.update(cx, |list, cx| {
                                let row = &mut list.delegate_mut().hovered;
                                if *hovered && row.as_ref() != Some(&hover_id) {
                                    *row = Some(hover_id.clone());
                                    cx.notify();
                                } else if !*hovered && row.as_ref() == Some(&hover_id) {
                                    *row = None;
                                    cx.notify();
                                }
                            });
                        })
                        .test_support()
                        .group("chat-row")
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
                        .px_0()
                        .py_1()
                        .min_h(px(appearance::Space::ROW))
                        .justify_center()
                        .bg(
                            if self.opened.as_ref() == Some(&chat.id) && self.selected != Some(ix) {
                                appearance::selected(cx)
                            } else {
                                cx.theme().transparent
                            },
                        )
                        .min_w_0()
                        .w_full()
                        .gap_0p5()
                        .child(crate::dither_view::layer(corner))
                        .child(
                            div()
                                .h_flex()
                                .items_center()
                                .gap_1()
                                .child(
                                    div()
                                        .id("sidebar-chat-title")
                                        .test_support()
                                        .flex_1()
                                        .min_w_0()
                                        .truncate()
                                        .text_size(px(appearance::TextRole::BODY))
                                        .child(SharedString::from(chat.title.clone())),
                                )
                                .child(
                                    // Built and revealed on hover or keyboard selection;
                                    // the right-click menu reaches the same actions.
                                    // A text-height slot: the 2rem target overhangs it rather
                                    // than pushing the metadata line away from the title.
                                    div()
                                        .id(SharedString::from(format!(
                                            "chat-menu-slot-{}",
                                            chat.id
                                        )))
                                        .flex_none()
                                        .w_8()
                                        .h(px(appearance::TextRole::BODY))
                                        .flex()
                                        .items_center()
                                        .opacity(if menu_shown { 1. } else { 0. })
                                        .group_hover("chat-row", |s| s.opacity(1.))
                                        .when(menu_built, |d| {
                                            d.child(
                                                crate::ui::icon_action(
                                                    SharedString::from(format!(
                                                        "chat-menu-{}",
                                                        chat.id
                                                    )),
                                                    "Chat actions",
                                                    AppIcon::More,
                                                    crate::ui::Action::Quiet,
                                                )
                                                .size_8()
                                                .dropdown_menu(move |menu, w, cx| {
                                                    LocalViewer::chat_actions_menu(
                                                        button_owner.clone(),
                                                        button_chat.clone(),
                                                        menu,
                                                        w,
                                                        cx,
                                                    )
                                                })
                                                .on_open_change(move |open, _, cx| {
                                                    if *open {
                                                        let _ = open_list.update(cx, |list, cx| {
                                                            list.delegate_mut().menu_row =
                                                                Some(open_id.clone());
                                                            cx.notify();
                                                        });
                                                    }
                                                }),
                                            )
                                        })
                                        .test_support(),
                                ),
                        )
                        .when(!detail.is_empty() || mark.is_some(), |row| {
                            row.child(
                                div()
                                    .id("sidebar-chat-detail")
                                    .test_support()
                                    .h_flex()
                                    .items_center()
                                    .min_w_0()
                                    // Text lane: the line fades out before the state corner.
                                    .when(has_corner, |d| d.pr(px(appearance::Space::SECTION)))
                                    .text_size(px(appearance::TextRole::CAPTION))
                                    .text_color(cx.theme().muted_foreground)
                                    // A long project name yields before the state reason.
                                    // Beside a mission it keeps a readable start and
                                    // its own separator, so all three stay on the line.
                                    .children(project.map(|p| {
                                        let split = mark.is_some() && !state.is_empty();
                                        div()
                                            .id("sidebar-chat-project")
                                            .test_support()
                                            .min_w_0()
                                            .when(mark.is_some(), |d| {
                                                d.min_w(px(appearance::Space::SECTION))
                                            })
                                            .flex_shrink(16.)
                                            .truncate()
                                            .child(SharedString::from(
                                                if state.is_empty() || split {
                                                    p
                                                } else {
                                                    format!("{p} · ")
                                                },
                                            ))
                                    }))
                                    .when(mark.is_some() && has_project && !state.is_empty(), |d| {
                                        d.child(div().flex_none().child(" · "))
                                    })
                                    .when(!state.is_empty(), |d| {
                                        d.child(
                                            div()
                                                .id("sidebar-chat-state")
                                                .test_support()
                                                // Beside a mission it shares the line instead.
                                                .when(mark.is_none(), |d| d.flex_shrink_0())
                                                .when(mark.is_some(), |d| d.min_w_0())
                                                .max_w(gpui_kit::relative(0.7))
                                                .truncate()
                                                .child(SharedString::from(state.clone())),
                                        )
                                    })
                                    .when_some(mark, |d, mark| {
                                        let segment = mission_segment(
                                            mark,
                                            !detail.is_empty(),
                                            appearance::accent_mark(cx),
                                            link.as_ref().is_some_and(|(focused, _)| *focused),
                                        );
                                        match link {
                                            Some((_, link)) => d.child(link(segment)),
                                            None => d.child(segment),
                                        }
                                    }),
                            )
                        })
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
            .px_2()
            .py_3()
            .text_size(px(appearance::TextRole::BODY))
            .text_color(cx.theme().muted_foreground)
            .child(
                div()
                    .id("sidebar-empty-message")
                    .test_support()
                    .child(if !self.loaded {
                        "Loading chats…"
                    } else if self.all.is_empty() {
                        "No chats yet."
                    } else {
                        "No matching chats."
                    }),
            )
    }
}

pub struct LocalViewer {
    session_failure_fence: crate::session_failure::Fence,
    session_failure_focus: gpui_kit::FocusHandle,
    queue_forms: Vec<(Entity<queued_message_view::Form>, Subscription)>,
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
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    update_events: Vec<Subscription>,
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    restart_generation: u64,
    pub(super) restart_pending: bool,
    pub(super) daemon_upgrade_pending: bool,
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    restart_timeout: Option<Task<()>>,
    #[cfg(feature = "native-probes")]
    settings_fixture_size: Option<gpui_kit::Size<gpui_kit::Pixels>>,
    projects_open: bool,
    jump: Option<Entity<crate::jump_view::JumpPalette>>,
    jump_subscription: Option<Subscription>,
    jump_return: Option<gpui_kit::FocusHandle>,
    /// Window-level fallback focus. Without it, Cmd-K and other window shortcuts
    /// dispatch only to GPUI's root node and never reach this view's handlers.
    root_focus: gpui_kit::FocusHandle,
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
    sending_view: submit_visibility::SendingView,
    nav_error: Option<&'static str>,
    client: Option<LocalClient>,
    chats: Entity<ListState<ChatList>>,
    transcript: Entity<TranscriptView>,
    selected: Option<String>,
    /// Calm entrance when the destination changes; never on the first frame.
    page_transition: crate::transition::Transition,
    page_key: String,
    /// Open/close easing of the chat side-panel slot, and its last axis.
    side_panel: crate::transition::Reveal<&'static str>,
    side_panel_beside: bool,
    title: String,
    generation: u64,
    state: Presentation,
    link_epoch: u64,
    link_read: Option<Task<()>>,
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
    artifacts: Entity<crate::artifact_view::ArtifactPane>,
    artifacts_open: bool,
    #[cfg(feature = "native-probes")]
    render_count: u64,
}

impl LocalViewer {
    #[cfg(feature = "native-probes")]
    pub(crate) fn inline_probe_enable(&mut self, options: LocalOptions, cx: &mut Context<Self>) {
        self.usage_options = Some(options);
        cx.notify();
    }
    #[cfg(feature = "native-probes")]
    pub(crate) fn inline_probe_transcript(&self) -> Entity<TranscriptView> {
        self.transcript.clone()
    }
    #[cfg(feature = "native-probes")]
    pub(crate) fn inline_probe_input(
        &self,
        cx: &App,
    ) -> Entity<gpui_kit::component::input::TextareaState> {
        self.editor.read(cx).shell_probe().0
    }
    #[cfg(feature = "native-probes")]
    pub(crate) fn inline_visual_fixture(
        options: LocalOptions,
        rows: Vec<Message>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let (client, _) = LocalClient::synthetic_commands();
        let mut view = Self::build(Some(client), None, window, cx);
        view.usage_options = None;
        view.selected = Some("owner".into());
        view.title = "Native visual study".into();
        view.page = Page::Chat;
        view.state.loaded = true;
        view.artifacts.update(cx, |p, cx| {
            p.options(options);
            p.context(Some("owner".into()), Arc::new(Vec::new()), cx);
        });
        view.transcript
            .update(cx, |t, cx| t.replace_readonly(rows, true, cx));
        view
    }
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
            KeyBinding::new("secondary-n", NewChat, None),
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
        view.settings.update(cx, |owner, cx| {
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            {
                owner.update_location = options.update_location();
                owner.update_connection = options.external_update_connection();
                owner.daemon_options = Some(options.clone());
            }
            owner.load(cx);
        });
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        view.connect_updates(window, cx);
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
                    .update_in(cx, |view, window, cx| {
                        view.accept(update, window, cx);
                        // Projects and chats may finish loading after drafts.
                        #[cfg(any(target_os = "macos", target_os = "linux"))]
                        view.restore_update_navigation(window, cx);
                    })
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
        menu_routing::register_quit_owner(window, cx);
        let weak = cx.weak_entity();
        window.on_window_should_close(cx, move |_, cx| {
            weak.update(cx, |view, cx| {
                if !view
                    .settings
                    .update(cx, |owner, cx| owner.request_close(cx))
                {
                    return false;
                }
                if view.restart_pending {
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
                            .update(cx, |editor, cx| editor.accept(state, window, cx));
                        #[cfg(any(target_os = "macos", target_os = "linux"))]
                        view.acknowledge_update_startup(cx);
                        #[cfg(any(target_os = "macos", target_os = "linux"))]
                        view.restore_update_navigation(window, cx);
                        #[cfg(feature = "native-probes")]
                        view.advance_update_restart(window, cx);
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
                mission: Default::default(),
                mission_coordinator: false,
                failure: None,
                pull_requests: Vec::new(),
                context_usage: Default::default(),
                subscription_usage: None,
                id: "synthetic".into(),
                title: "Synthetic Local chat".into(),
                state: "working".into(),
                archived: false,
                local_draft: false,
                session_path: None,
                writable: false,
                busy: true,
                signal: Some(Signal::Working),
                background_work: false,
                order: Default::default(),
                running_jobs: Default::default(),
                cwd: String::new(),
                project_id: None,
                model_configuration: None,
                attention: None,
            },
            Chat {
                mission: Default::default(),
                mission_coordinator: false,
                failure: None,
                pull_requests: Vec::new(),
                context_usage: Default::default(),
                subscription_usage: None,
                id: "synthetic-two".into(),
                title: "Transcript review".into(),
                state: "idle".into(),
                archived: false,
                local_draft: false,
                session_path: None,
                writable: false,
                busy: false,
                signal: None,
                background_work: false,
                order: Default::default(),
                running_jobs: Default::default(),
                cwd: String::new(),
                project_id: None,
                model_configuration: None,
                attention: None,
            },
            Chat {
                mission: Default::default(),
                mission_coordinator: false,
                failure: None,
                pull_requests: Vec::new(),
                context_usage: Default::default(),
                subscription_usage: None,
                id: "synthetic-archive".into(),
                title: "Earlier conversation".into(),
                state: "parked".into(),
                archived: true,
                local_draft: false,
                session_path: None,
                writable: false,
                busy: false,
                signal: None,
                background_work: false,
                order: Default::default(),
                running_jobs: Default::default(),
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
            let first = delegate.first();
            list.set_selected_index(first, window, cx);
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
        if index == 14 {
            let tree: serde_json::Value =
                serde_json::from_str(include_str!("../fixtures/stat.json")).unwrap();
            let scene = crate::visual_scene::Scene::parse(tree.clone()).unwrap();
            let source = format!(
                "({{ui}})=>ui.column([{}])",
                tree["root"]["children"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|node| {
                        let mut props = node.clone();
                        props.as_object_mut().unwrap().remove("type");
                        format!("ui.stat({props})")
                    })
                    .collect::<Vec<_>>()
                    .join(",")
            );
            let reference = crate::artifact_model::Reference {
                id: "synthetic-visual".into(),
                session: "synthetic".into(),
                revision: 1,
                title: "Stat fields".into(),
                kind: "visual".into(),
            };
            view.state.artifacts = Arc::new(vec![reference.clone()]);
            view.artifacts_open = true;
            view.artifacts
                .update(cx, |p, cx| p.preview(reference, source, scene, cx));
            return view;
        }
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
            let source = if tree["root"]["type"] == "column" {
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
            mission: Default::default(),
            mission_coordinator: false,
            failure: None,
            pull_requests: Vec::new(),
            context_usage: Default::default(),
            subscription_usage: None,
            id: "synthetic-failed".into(),
            title: "Review a failed check with a long title that stays on one line".into(),
            state: "failed".into(),
            archived: false,
            local_draft: false,
            session_path: None,
            writable: false,
            busy: false,
            signal: Some(Signal::Failed),
            background_work: false,
            order: Default::default(),
            running_jobs: Default::default(),
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
                    bounds: Default::default(),
                    query: String::new(),
                    archived: false,
                    selected: None,
                    opened: None,
                    loaded: false,
                    project: None,
                    projects: Arc::new(Vec::new()),
                    corners: HashMap::new(),
                    focus: None,
                    hovered: None,
                    menu_row: None,
                },
                window,
                cx,
            )
            .searchable(true)
        });
        chats.update(cx, |list, cx| {
            list.delegate_mut().focus = Some(gpui_kit::Focusable::focus_handle(list, cx))
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
                    ShellEvent::NewChat => view.new_chat(window, cx),
                    ShellEvent::AddProject => {
                        if view.writer.is_some() {
                            view.open_add_project(window, cx);
                        }
                    }
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
        let path_owner = cx.weak_entity();
        editor.update(cx, |editor, cx| editor.enable_paths(path_owner, window, cx));
        let context_entry = context_usage_view::entry(cx);
        let todos_entry = session_todos_tray::entry(window, cx);
        let jobs_entry = session_jobs_tray::entry(window, cx);
        let queue_entry = queued_message_view::entry(window, cx);
        editor.update(cx, |editor, _| {
            editor.set_context_entry(context_entry.into());
            editor.set_todos_entry(todos_entry.into());
            editor.set_jobs_entry(jobs_entry.into());
            editor.set_queue_entry(queue_entry.into());
        });
        let mission =
            cx.new(|cx| crate::mission_view::MissionForm::new(writer.clone(), window, cx));
        let missions = cx.new(crate::mission_browser_view::Browser::new);
        let mission_rows = cx.observe(&missions, |view, _, cx| {
            view.chats.update(cx, |_, cx| cx.notify());
        });
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
                EditorEvent::DraftDiscarded { selected } => {
                    let focus = gpui_kit::Focusable::focus_handle(view.chats.read(cx), cx);
                    let restore = focus.contains_focused(window, cx);
                    view.sync_sending(cx);
                    view.rebuild_nav(window, cx);
                    if *selected && view.page == Page::Chat {
                        view.show_home(window, cx);
                        if view.page == Page::Chat {
                            // An overlay, popup or search preedit refused navigation. The
                            // deleted destination still leaves; its focus and query stay put.
                            view.leave_artifacts(cx);
                            view.page =
                                view.project_scope.clone().map_or(Page::Home, Page::Project);
                            view.rebuild_nav(window, cx);
                            cx.notify();
                        }
                    } else if restore {
                        view.chats.update(cx, |list, cx| list.focus(window, cx));
                    }
                }
                EditorEvent::DraftDiscardFailed { key, error } => {
                    if view.editor.read(cx).has_navigation_draft(key) {
                        view.nav_error = Some(*error);
                        cx.notify();
                    }
                }
                EditorEvent::DraftsChanged => {
                    view.sync_sending(cx);
                    view.rebuild_nav(window, cx)
                }
                EditorEvent::Flushed => menu_routing::exit(cx),
                EditorEvent::OpenContinued(chat) => {
                    if view.jump.is_none() && view.page == Page::Chat {
                        view.open((**chat).clone(), window, cx);
                    }
                }
                EditorEvent::UpdateCheckpoint => {
                    #[cfg(any(target_os = "macos", target_os = "linux"))]
                    view.advance_update_restart(window, cx);
                }
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
                            mission: Default::default(),
                            mission_coordinator: false,
                            failure: None,
                            pull_requests: Vec::new(),
                            context_usage: Default::default(),
                            subscription_usage: None,
                            id: target.clone(),
                            title: "Local chat".into(),
                            state: "starting".into(),
                            archived: false,
                            local_draft: false,
                            session_path: None,
                            writable: true,
                            busy: true,
                            signal: Some(Signal::Working),
                            background_work: false,
                            order: Default::default(),
                            running_jobs: Default::default(),
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
        let link_events = cx.subscribe_in(
            &transcript,
            window,
            |v, _, event: &crate::transcript_view::LinkOpen, w, cx| {
                if event.generation == v.generation && v.page == Page::Chat {
                    v.open_chat_url(&event.url, w, cx);
                }
            },
        );
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
                if let Some(pane) = view
                    .transcript
                    .update(cx, |t, cx| t.inline_expand(&event.0, cx))
                    && view.artifacts != pane
                {
                    view.artifacts.update(cx, |p, cx| p.hide_gallery(cx));
                    view.artifacts = pane;
                }
                view.artifacts.update(cx, |pane, cx| {
                    pane.inline_mode(false, cx);
                    pane.context(view.selected.clone(), view.state.artifacts.clone(), cx);
                    pane.artifact_metadata(view.state.artifact_metadata.clone(), cx);
                    if !pane.inline_matches(&event.0) {
                        pane.open(event.0.clone(), window, cx);
                    } else {
                        pane.focus_reader(window, cx);
                    }
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
        let following_events = cx.subscribe(
            &transcript,
            |view, _, event: &crate::transcript_view::Following, _| {
                if event.0 == view.generation
                    && let Some(client) = &view.client
                {
                    client.follow(event.0, event.1);
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
        let root_focus = cx.focus_handle();
        if window.focused(cx).is_none() {
            root_focus.focus(window, cx);
        }
        // GPUI calls this only when no rendered element in this window holds
        // focus (e.g. the focused element was removed); keep shortcuts reachable.
        let focus_lost = cx.on_focus_lost(window, |v, w, cx| v.root_focus.focus(w, cx));
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
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            update_events: Vec::new(),
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            restart_generation: 0,
            restart_pending: false,
            daemon_upgrade_pending: false,
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            restart_timeout: None,
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
            conversation_links: None,
            workspace_changes: None,
            session_failure_fence: Default::default(),
            session_failure_focus: cx.focus_handle().tab_stop(true),
            projects_open: false,
            jump: None,
            jump_subscription: None,
            jump_return: None,
            root_focus,
            mission,
            mission_open: false,
            mission_return: None,
            add_project,
            add_project_open: false,
            add_project_return: None,
            project_catalog_reply: None,
            nav_projects: Arc::new(Vec::new()),
            pending_transcript: None,
            sending_view: Default::default(),
            nav_error: None,
            client,
            chats,
            transcript,
            selected: None,
            page_transition: Default::default(),
            page_key: String::new(),
            side_panel: Default::default(),
            side_panel_beside: true,
            title: "Choose a Local chat".into(),
            generation: 0,
            state: Presentation {
                status: "Connecting to Local…".into(),
                ..Default::default()
            },
            link_epoch: 0,
            link_read: None,
            _subscriptions: vec![
                link_events,
                chat_action_events,
                subscription,
                mission_events,
                missions_events,
                mission_rows,
                mission_context_events,
                add_project_events,
                editor_events,
                artifact_events,
                history_events,
                latest_events,
                following_events,
                project_events,
                shell_events,
                inbox_events,
                focus_lost,
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

    pub(crate) fn path_completion_source(&self) -> Option<crate::chat_editor::paths::Source> {
        if self.page != Page::Chat
            || self.state.generation != self.generation
            || !self.state.loaded
            || self.state.page_busy
            || self.refreshing
            || self.artifacts_open
        {
            return None;
        }
        let id = self.selected.as_ref()?;
        let chat = self
            .state
            .chats
            .iter()
            .find(|c| &c.id == id && !c.local_draft && c.writable && !c.archived)?;
        Some(crate::chat_editor::paths::Source {
            options: self.usage_options.clone()?,
            target: crate::path_completion::Target {
                chat: id.clone(),
                cwd: chat.cwd.clone(),
                generation: self.generation,
            },
        })
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
            self.title = "New chat".into();
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
        self.sending_view.queued.clear();
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
            self.state.mission_titles = state.mission_titles;
            self.state.status = state.status;
            self.state.chat_status = state.chat_status;
            self.state.thinking = state.thinking;
            self.state.todos = state.todos;
            self.state.chat_issue = state.chat_issue;
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
            let rows = self.with_sending(rows, &state.user_queue, cx);
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
            self.state.mission_titles = state.mission_titles;
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
                // Only jobs run: their strip above the composer says so instead.
                editor.jobs_only(chat.background_work && !chat.running_jobs.is_empty(), cx);
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
        self.sending_view.queued.clear();
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
        // Only a window that omitted newer entries needs the newest one reread.
        if self.state.behind
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
                self.state.chat_issue = false;
                self.editor
                    .update(cx, |editor, cx| editor.activity(false, cx));
                self.state.page_busy = true;
                self.state.chat_status = "Loading newest bounded window…".into();
                self.sync_history_controls(cx);
                cx.notify();
                return;
            }
            self.nav_error = Some("Newer messages could not be loaded. Try Latest again.");
        }
        self.transcript.update(cx, |view, cx| view.latest(cx));
        self.sync_history_controls(cx);
        cx.notify();
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
        self.sync_visible_draft(window, cx);
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
        self.sync_visible_draft(window, cx);
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
            "Couldn't load projects"
        } else if !self.state.projects_loaded {
            "Loading projects…"
        } else {
            "No projects yet"
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
                    mission: Default::default(),
                    mission_coordinator: false,
                    failure: None,
                    pull_requests: Vec::new(),
                    context_usage: Default::default(),
                    subscription_usage: None,
                    model_configuration: None,
                    id: key,
                    title,
                    state: "Draft".into(),
                    archived: false,
                    local_draft: true,
                    session_path: None,
                    writable: false,
                    busy: false,
                    signal: None,
                    background_work: false,
                    order: Default::default(),
                    running_jobs: Default::default(),
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
            delegate.projects = self.state.projects.clone();
            delegate.filter();
            let selected = selected.and_then(|id| delegate.index(&id));
            list.set_selected_index(selected, window, cx);
            cx.notify();
        });
    }
}

impl Render for LocalViewer {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let menu_ready = self.menu_navigation_ready(window, cx);
        let menu_jump = self.menu_jump_ready(window, cx);
        let menu_new_chat = menu_ready && self.editor.read(cx).ready();
        let menu_back = menu_ready
            && self
                .navigation
                .has_destination(false, |l| self.can_restore(l, cx));
        let menu_forward = menu_ready
            && self
                .navigation
                .has_destination(true, |l| self.can_restore(l, cx));
        self.transcript.update(cx, |t, cx| {
            t.inline_context(
                self.usage_options.clone(),
                self.selected.clone(),
                self.page == Page::Chat
                    && !self.artifacts_open
                    && !self.mission_open
                    && !self.add_project_open,
                &self.artifacts,
                cx,
            )
        });
        #[cfg(feature = "native-probes")]
        {
            self.render_count += 1;
        }
        let page_key = match &self.page {
            Page::Home => "home".to_owned(),
            Page::Missions | Page::Mission(_) => "missions".to_owned(),
            Page::Inbox(_) => "inbox".to_owned(),
            Page::Project(id) => format!("project:{id}"),
            Page::Chat => format!("chat:{:?}", self.selected),
        };
        if page_key != self.page_key {
            if !self.page_key.is_empty() {
                self.page_transition.start(cx);
            }
            self.page_key = page_key;
        }
        let entrance = crate::transition::ease_out(self.page_transition.progress(
            std::time::Duration::from_millis(200),
            window,
            cx,
        ));
        let glass = crate::appearance::glass(cx);
        let cwd = self
            .selected
            .as_ref()
            .and_then(|id| self.state.chats.iter().find(|c| &c.id == id))
            .map(|c| c.cwd.clone())
            .unwrap_or_default();
        let history_status = if self.earlier_request.is_some() {
            "Loading earlier messages…"
        } else {
            self.state.chat_status.as_str()
        };
        // One quiet subtitle line: project, then only non-routine transport status.
        let project = self
            .selected
            .as_ref()
            .and_then(|id| self.state.chats.iter().find(|c| &c.id == id))
            .and_then(|c| c.project_id.as_ref())
            .and_then(|id| self.state.projects.iter().find(|p| &p.id == id))
            .map(|p| p.name.clone());
        let header_meta = project
            .into_iter()
            .chain(
                (!history_status.is_empty() && history_status != "Connected · Local")
                    .then(|| history_status.to_owned()),
            )
            .collect::<Vec<_>>()
            .join(" · ");
        div().map(menu_routing::window_commands).id("desktop-root").track_focus(&self.root_focus).test_support().relative().h_flex().items_stretch().size_full().min_w_0()
            // Over glass the sidebar and page are separate tints, never stacked.
            .when(!glass,|this|this.bg(cx.theme().background)).text_color(cx.theme().foreground)
            .capture_key_down(cx.listener(|v,e:&gpui_kit::KeyDownEvent,w,cx|{
                if v.restart_pending {cx.stop_propagation();return;}
                // An inline queue composition keeps its keys; nothing else is fenced.
                if v.queue_marked(w,cx) {
                    let key=e.keystroke.key.as_str(); let modified=e.keystroke.modifiers.platform||e.keystroke.modifiers.control;
                    if matches!(key,"enter"|"escape"|"tab") || (modified && !matches!(key,"c"|"v"|"x"|"a"|"z"|"q")) {cx.stop_propagation();}
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
            .capture_any_mouse_down(cx.listener(|v,_,_,cx|{if v.restart_pending {cx.stop_propagation();}}))
            .when(menu_jump, |el| el.on_action(cx.listener(|v,_:&ToggleJump,w,cx|{v.toggle_jump(w,cx);cx.stop_propagation();})))
            .when(menu_new_chat, |el| el.on_action(cx.listener(|v,_:&NewChat,w,cx|{v.new_chat(w,cx);cx.stop_propagation();})))
            // Capture above the transcript so releasing a dragged thumb in the
            // header/sidebar still completes top-of-history navigation.
            .capture_any_mouse_up(cx.listener(|view,_,_,cx|{
                if view.jump.is_none() && !view.mission_open && !view.add_project_open && view.page==Page::Chat && !view.artifacts_open && view.selected.is_some() {
                    view.transcript.update(cx,|v,cx|v.history_scrollbar_released(cx));
                }
            }))
            .on_action(cx.listener(|view,_:&crate::transcript_view::Quit,w,cx|{
                cx.stop_propagation();
                view.request_menu_quit(w,cx);
            }))
            .on_action(cx.listener(|view,_:&crate::transcript_view::FocusComposer,window,cx|{
                if view.jump.is_some()||view.mission_open||view.add_project_open||view.queue_marked(window,cx){return;}
                if view.page!=Page::Chat {view.show_chats(window,cx);}
                view.editor.update(cx,|editor,cx|editor.focus(window,cx));
            }))
            .when(menu_ready, |el| el
                .on_action(cx.listener(|view,_:&GoHome,window,cx|view.show_home(window,cx)))
                .on_action(cx.listener(|view,_:&crate::settings_view::OpenSettings,window,cx|{view.open_settings(window,cx);cx.stop_propagation();}))
                .on_action(cx.listener(|view,_:&ShowAllChats,window,cx|view.show_chats(window,cx)))
                .on_action(cx.listener(|view,_:&ShowMissions,window,cx|{view.show_missions(window,cx);} )))
            .on_action(cx.listener(|v,_:&workspace_changes_view::Toggle,w,cx|{v.toggle_workspace_changes(w,cx);cx.stop_propagation();}))
            .on_action(cx.listener(|v,_:&conversation_links_view::Toggle,w,cx|{v.toggle_conversation_links(w,cx);cx.stop_propagation();}))
            .on_action(cx.listener(|v,_:&crate::mission_inspector_view::Toggle,w,cx|{v.mission_context_toggle(w,cx);cx.stop_propagation();}))
            .when(menu_back, |el| el.on_action(cx.listener(|view,_:&NavigateBack,window,cx|view.move_navigation(false,window,cx))))
            .when(menu_forward, |el| el.on_action(cx.listener(|view,_:&NavigateForward,window,cx|view.move_navigation(true,window,cx))))
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
            .child(div().id("main-pane").h_flex().items_stretch().flex_1().min_w_0().min_h_0().h_full()
                .when(glass,|this|this.bg(cx.theme().background))
                // Paint-only entrance: a short fade and 6pt rise, no layout change.
                .child(div().relative().top(px(6.*(1.-entrance))).opacity(0.4+0.6*entrance)
                    .h_flex().items_stretch().flex_1().min_w_0().min_h_0().h_full().child(
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
                    // One 48pt row: title over a quiet project subtitle, then named icon actions and the … menu.
                    .child(div().id("chat-header").test_support().h_flex().items_center().gap_2().h(px(48.)).px_3().flex_shrink_0().border_b_1().border_color(cx.theme().border)
                        .child(div().v_flex().items_start().justify_center().flex_1().min_w_0()
                            .child(div().id("chat-title").max_w_full().truncate().text_size(px(crate::ui::TextRole::HEADLINE)).line_height(px(crate::ui::TextRole::HEADLINE*1.3)).font_semibold()
                                .when(!cwd.is_empty(),|d|{let cwd=SharedString::from(cwd.clone());gpui_kit::StatefulInteractiveElement::tooltip(d,move|w,cx|gpui_kit::component::tooltip::Tooltip::new(cwd.clone()).build(w,cx))})
                                .child(SharedString::from(self.title.clone())).test_support())
                            .when(!header_meta.is_empty(),|this|this.child(div().id("chat-header-meta").test_support().max_w_full().truncate().text_size(px(crate::ui::TextRole::CAPTION)).line_height(px(crate::ui::TextRole::CAPTION*1.3)).text_color(cx.theme().muted_foreground).child(SharedString::from(header_meta)))))
                        .child(div().h_flex().items_center().gap_0p5().flex_none()
                            .children(self.conversation_links_action(cx))
                            .children(self.workspace_changes_action(cx))
                            .when(!self.state.artifacts.is_empty()||self.artifacts_open,|this|this.child({
                                let b=Button::new("artifact-gallery").ghost().small();
                                if self.artifacts_open {b.icon(AppIcon::Back.asset()).label("Back to chat")} else {b.icon(AppIcon::Artifacts.asset()).accessibility_label("Artifacts").tooltip("Artifacts")}
                                .on_click(cx.listener(|view,_,window,cx|{if !view.prepare_navigation(window,cx){return;}view.artifacts_open = !view.artifacts_open;view.sync_mission_context(cx);if view.artifacts_open{view.artifacts.update(cx,|p,cx|p.show_gallery(window,cx));}else{view.artifacts.update(cx,|p,cx|p.hide_gallery(cx));view.editor.update(cx,|editor,cx|editor.focus(window,cx));}cx.notify();}))}))
                            .children(self.mission_context_action(cx))
                            .when(self.selected.is_some()&&!self.artifacts_open,|this|this.child(self.history_menu(cx)))))
                    .when_some(self.session_failure_banner(cx), |d, banner| d.child(banner))
                    .child(div().v_flex().flex_1().min_h_0().min_w_0().w_full().when(self.artifacts_open, |d| d.max_w(px(760.)).mx_auto())
                        // Placeholders keep the readable column; only the transcript scroller spans the pane.
                        .when(self.selected.is_some()&&!self.state.loaded,|this|this.child(div().w_full().max_w(px(crate::ui::CONVERSATION_MAX_WIDTH)).mx_auto().p_3().text_sm().text_color(cx.theme().muted_foreground).child("Loading history…")))
                        .when(self.selected.is_none(),|this|this.child(div().v_flex().flex_1().w_full().max_w(px(crate::ui::CONVERSATION_MAX_WIDTH)).mx_auto().justify_center().p_6().gap_2()
                            .child(div().font_semibold().child("Choose a chat"))
                            .child(div().text_sm().text_color(cx.theme().muted_foreground).child("Open a Local conversation from the sidebar, or start a new chat."))))
                        .when(self.selected.is_some()&&!self.artifacts_open,|this|this.child(self.transcript.clone().cached(gpui_kit::StyleRefinement::default().size_full().min_h_0().min_w_0())))
                        .when(self.artifacts_open,|this|this.child(self.artifacts.clone().cached(gpui_kit::StyleRefinement::default().size_full().min_h_0().min_w_0()))))
                    .child(div().id("conversation-editor").test_support().w_full().min_w_0().max_w(px(if self.artifacts_open {760.} else {crate::ui::CONVERSATION_MAX_WIDTH})).mx_auto().child(self.composer_slot(window, cx)))
                        .into_any_element();
                self.side_panel_shell(conversation, window, cx)
                }
                }
            )))
            .when_some(self.jump.clone(),|this,palette|this.child(self.jump_overlay(palette,window,cx)))
            .when(self.mission_open,|this|this.child(self.mission_overlay(window,cx)))
            .when(self.add_project_open,|this|this.child(self.add_project_overlay(window,cx)))
    }
}
/// A chat row's mission segment, from the summary's association and its
/// passive coordinator role. Only the cached Local name is shown, never an ID.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct MissionMark {
    pub(crate) icon: AppIcon,
    /// Shown on the metadata line.
    pub(crate) text: String,
    /// The tooltip and the row's accessible name.
    pub(crate) label: String,
    /// `text` is the mission's cached name, not a placeholder.
    pub(crate) named: bool,
}
impl MissionMark {
    /// Whether the glyph and the name take the accent: only a coordinator's
    /// Compass and its mission's name do. Members, placeholders and errors stay quiet.
    pub(crate) fn accents(&self) -> (bool, bool) {
        let coordinator = self.icon == AppIcon::Coordinator;
        (coordinator, coordinator && self.named)
    }
}
/// A linked mission's name and whether it is current. The daemon's mission
/// list (`titles`, sent on connection and after every change) is
/// authoritative once it arrives: a mission it doesn't list has no name.
/// Until then, or from a daemon that never sends it, `catalog` supplies the
/// lazily read catalog's name.
pub(crate) fn sidebar_mission_title(
    titles: Option<&std::collections::HashMap<String, String>>,
    online: bool,
    id: &str,
    catalog: impl FnOnce() -> Option<(String, bool)>,
) -> Option<(String, bool)> {
    match titles {
        Some(titles) => titles.get(id).map(|title| (title.clone(), online)),
        None => catalog(),
    }
}
/// `name` resolves a linked mission's cached name and whether it is current.
pub(crate) fn mission_mark(
    chat: &Chat,
    name: impl FnOnce(&str) -> Option<(String, bool)>,
) -> Option<MissionMark> {
    use crate::local_model::MissionAssociation;
    let role = if chat.mission_coordinator {
        AppIcon::Coordinator
    } else {
        AppIcon::Mission
    };
    let (icon, text, label, named) = match &chat.mission {
        MissionAssociation::Unlinked if !chat.mission_coordinator => return None,
        MissionAssociation::Unlinked => {
            return Some(MissionMark {
                icon: role,
                text: "Coordinator".into(),
                label: "Mission coordinator".into(),
                named: false,
            });
        }
        MissionAssociation::Unknown => (
            AppIcon::Info,
            "Mission unavailable".to_owned(),
            "Mission association unavailable".to_owned(),
            false,
        ),
        MissionAssociation::Linked(id) => {
            match name(id).filter(|(title, _)| !title.trim().is_empty()) {
                Some((title, true)) => (role, title.clone(), format!("Mission: {title}"), true),
                Some((title, false)) => (
                    role,
                    title.clone(),
                    format!("Mission (last known): {title}"),
                    true,
                ),
                None => (
                    role,
                    "Name unavailable".to_owned(),
                    "Mission linked · name unavailable".to_owned(),
                    false,
                ),
            }
        }
    };
    let label = if chat.mission_coordinator {
        format!("Coordinator · {label}")
    } else {
        label
    };
    Some(MissionMark {
        icon,
        text,
        label,
        named,
    })
}
/// Makes a linked chat's mission segment open that mission: one click, or
/// Enter/Space once Tab reaches it on the selected row. Only the summary's own
/// mission ID is used; unavailable or unlinked marks stay plain text.
/// The whole segment is the target; only the name underlines (see
/// `mission_segment`).
fn mission_link(
    chat: String,
    mission: String,
    focus: gpui_kit::FocusHandle,
    tab_stop: bool,
    owner: gpui_kit::WeakEntity<LocalViewer>,
    segment: impl IntoElement,
) -> impl IntoElement {
    use gpui_kit::StatefulInteractiveElement as _;
    let open = std::rc::Rc::new(move |w: &mut Window, cx: &mut App| {
        let _ = owner.update(cx, |v, cx| v.show_chat_mission(&mission, w, cx));
    });
    let confirm = open.clone();
    div()
        .id(SharedString::from(format!("chat-mission-link-{chat}")))
        .test_support()
        .track_focus(&focus.tab_stop(tab_stop))
        .h_flex()
        .min_w(px(appearance::Space::SECTION * 2.))
        .cursor_pointer()
        .group(MISSION_LINK_GROUP)
        // Pointer use neither focuses the link nor selects the row.
        .on_mouse_down(gpui_kit::MouseButton::Left, |_, w, _| w.prevent_default())
        .on_click(move |_, w, cx| {
            cx.stop_propagation();
            open(w, cx);
        })
        // Enter is the list's Confirm (open the row's chat); here it opens the mission.
        .on_action(move |_: &gpui_kit::base::actions::Confirm, w, cx| confirm(w, cx))
        .child(segment)
}
/// The mission link's hover group: its name underlines while it is hovered.
const MISSION_LINK_GROUP: &str = "chat-mission-link";
/// The summary's linked mission ID and the row link's focus handle.
fn mission_link_focus(
    chat: &Chat,
    window: &mut Window,
    cx: &mut App,
) -> Option<(String, gpui_kit::FocusHandle)> {
    let crate::local_model::MissionAssociation::Linked(mission) = &chat.mission else {
        return None;
    };
    let key = SharedString::from(format!("chat-mission-link-focus-{}", chat.id));
    let focus = window
        .use_keyed_state(key, cx, |_, cx| cx.focus_handle())
        .read(cx)
        .clone();
    Some((mission.clone(), focus))
}
/// Map (member) or Compass (coordinator) and the mission name, after the
/// project and state. A minimum width keeps a long project or state from
/// hiding it; the full wording stays in the tooltip and the row's label.
/// A coordinator's Compass and mission name take `accent`; nothing else does.
/// Inside a mission link only the name underlines, on pointer hover or when
/// the link has keyboard focus (`focused`), never the separator or glyph.
fn mission_segment(
    mark: MissionMark,
    separated: bool,
    accent: gpui_kit::Hsla,
    focused: bool,
) -> impl IntoElement {
    use gpui_kit::StatefulInteractiveElement as _;
    let (glyph_accent, name_accent) = mark.accents();
    let label = SharedString::from(mark.label);
    div()
        .id("chat-mission-mark")
        .test_support()
        .h_flex()
        .items_center()
        .gap_0p5()
        .min_w(px(appearance::Space::SECTION * 2.))
        .aria_label(label.clone())
        .tooltip(move |w, cx| {
            gpui_kit::component::tooltip::Tooltip::element({
                let label = label.clone();
                move |_, _| {
                    div()
                        .id("chat-mission-tooltip")
                        .test_support()
                        .aria_label(label.clone())
                        .child(label.clone())
                }
            })
            .build(w, cx)
        })
        .when(separated, |d| d.child(div().flex_none().child(" · ")))
        .child(
            div()
                .id(SharedString::from(format!(
                    "chat-mission-glyph-{:?}",
                    mark.icon
                )))
                .test_support()
                .flex_none()
                .when(glyph_accent, |d| d.text_color(accent))
                .child(mark.icon.inline()),
        )
        .child(
            div()
                .id("chat-mission-name")
                .test_support()
                .min_w_0()
                .truncate()
                .when(name_accent, |d| d.text_color(accent))
                .when(focused, |d| d.text_decoration_1())
                .group_hover(MISSION_LINK_GROUP, |s| s.text_decoration_1())
                .child(SharedString::from(mark.text)),
        )
}
#[cfg(test)]
mod mission_association_mark_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn sidebar_names_come_from_the_session_socket_mission_list() {
        let titles: std::collections::HashMap<String, String> = (0..5000)
            .map(|i| (format!("m-{i}"), format!("Mission {i}")))
            .collect();
        let catalog = || Some(("Catalog name".to_owned(), true));
        let unread = || -> Option<(String, bool)> { panic!("the socket list is authoritative") };
        // Listed: current while connected, last known while offline.
        assert_eq!(
            sidebar_mission_title(Some(&titles), true, "m-4999", unread),
            Some(("Mission 4999".to_owned(), true))
        );
        assert_eq!(
            sidebar_mission_title(Some(&titles), false, "m-0", unread),
            Some(("Mission 0".to_owned(), false))
        );
        // A mission the daemon doesn't list is really unavailable; an older
        // lazily read catalog never revives it.
        assert_eq!(
            sidebar_mission_title(Some(&titles), true, "m-gone", unread),
            None
        );
        // Before the list arrives (or from a daemon that never sends it), the
        // existing cached catalog still names the mission.
        assert_eq!(
            sidebar_mission_title(None, true, "m-0", catalog),
            Some(("Catalog name".to_owned(), true))
        );
        assert_eq!(sidebar_mission_title(None, true, "m-0", || None), None);
    }

    #[test]
    fn mission_association_mark_uses_role_glyphs_and_honest_names() {
        let chat = |v: serde_json::Value| crate::local_model::chat(&v).unwrap();
        let named = |_: &str| Some(("Launch 日本語 👩‍💻".to_owned(), true));
        let unread = |_: &str| -> Option<(String, bool)> { panic!("no lookup") };
        let mark = |icon, text: &str, label: &str| {
            let named = !["Coordinator", "Mission unavailable", "Name unavailable"].contains(&text);
            Some(MissionMark {
                icon,
                text: text.into(),
                label: label.into(),
                named,
            })
        };
        // Titles and projects never imply a mission or a role.
        assert_eq!(
            mission_mark(
                &chat(json!({"id":"c","title":"Mission coordinator","projectId":"mission-A"})),
                unread
            ),
            None
        );
        assert_eq!(
            mission_mark(&chat(json!({"id":"m","missionId":"mission-A"})), named),
            mark(
                AppIcon::Mission,
                "Launch 日本語 👩‍💻",
                "Mission: Launch 日本語 👩‍💻"
            )
        );
        assert_eq!(
            mission_mark(
                &chat(json!({"id":"c","missionId":"mission-A","missionCoordinator":true})),
                |_| Some(("Launch".to_owned(), false))
            ),
            mark(
                AppIcon::Coordinator,
                "Launch",
                "Coordinator · Mission (last known): Launch"
            )
        );
        assert_eq!(
            mission_mark(
                &chat(json!({"id":"c","activeMissionCoordinator":true})),
                unread
            ),
            mark(AppIcon::Coordinator, "Coordinator", "Mission coordinator")
        );
        assert_eq!(
            mission_mark(
                &chat(json!({"id":"c","missionId":true,"missionCoordinator":true})),
                unread
            ),
            mark(
                AppIcon::Info,
                "Mission unavailable",
                "Coordinator · Mission association unavailable"
            )
        );
        // A linked mission without a cached name never shows its ID.
        for name in [None, Some(("  ".to_owned(), true))] {
            assert_eq!(
                mission_mark(&chat(json!({"id":"m","missionId":"mission-A"})), |_| name),
                mark(
                    AppIcon::Mission,
                    "Name unavailable",
                    "Mission linked · name unavailable"
                )
            );
        }
    }

    #[test]
    fn only_coordinator_compass_and_mission_name_take_the_accent() {
        let chat = |v: serde_json::Value| crate::local_model::chat(&v).unwrap();
        let accents = |v: serde_json::Value, name: Option<(&str, bool)>| {
            mission_mark(&chat(v), |_| name.map(|(n, c)| (n.to_owned(), c))).map(|m| m.accents())
        };
        let named = Some(("Launch", true));
        // Ordinary chats have no mark at all.
        assert_eq!(
            accents(json!({"id":"o","title":"Coordinator"}), named),
            None
        );
        // Members keep the quiet Map and name, current or last known.
        for name in [named, Some(("Launch", false)), None] {
            assert_eq!(
                accents(json!({"id":"m","missionId":"mission-A"}), name),
                Some((false, false))
            );
        }
        // Coordinators accent the Compass, and the name only when it is a real
        // (current or last known) mission name rather than a placeholder.
        for name in [named, Some(("Launch", false))] {
            assert_eq!(
                accents(
                    json!({"id":"c","missionId":"mission-A","missionCoordinator":true}),
                    name
                ),
                Some((true, true))
            );
        }
        assert_eq!(
            accents(
                json!({"id":"c","missionId":"mission-A","missionCoordinator":true}),
                None
            ),
            Some((true, false))
        );
        assert_eq!(
            accents(json!({"id":"c","activeMissionCoordinator":true}), None),
            Some((true, false))
        );
        // Malformed association shows Info, never an accented guess.
        assert_eq!(
            accents(
                json!({"id":"c","missionId":true,"missionCoordinator":true}),
                None
            ),
            Some((false, false))
        );
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
                        mission: Default::default(),
                        mission_coordinator: false,
                        failure: None,
                        pull_requests: Vec::new(),
                        context_usage: Default::default(),
                        subscription_usage: None,
                        model_configuration: None,
                        id: "other".into(),
                        title: "Other".into(),
                        state: "idle".into(),
                        archived: false,
                        local_draft: false,
                        session_path: None,
                        writable: false,
                        busy: false,
                        signal: None,
                        background_work: false,
                        order: Default::default(),
                        running_jobs: Default::default(),
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
            assert!(window.try_find("view-details").is_none());
            let conversation = window.find("conversation").bounds();
            let editor = window.find("conversation-editor").bounds();
            assert_eq!(editor.bottom(), conversation.bottom(), "No footer gap");
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
                        view.state.behind = true;
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
#[path = "message_footer_probe.rs"]
pub(crate) mod message_footer_probe;

#[cfg(feature = "native-probes")]
#[path = "markdown_mermaid_probe.rs"]
pub(crate) mod markdown_mermaid_probe;

#[cfg(feature = "native-probes")]
#[path = "new_chat_view_probe.rs"]
pub(crate) mod new_chat_view_probe;
