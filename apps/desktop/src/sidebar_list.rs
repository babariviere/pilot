//! The chat sidebar list: rows from `sidebar_tree`, drawn in the shared Kit
//! list (search, keyboard selection, menus). Mission threads indent one level
//! under their parent; state is a still trailing mark plus words, never dither.
//!
//! Two edges and a column: section and project labels, chat titles and a
//! mission's Compass share the leading text edge (the navigation glyph's);
//! mission names, members and "+N finished" share the second; every mark and
//! collapsed count sits in one trailing column.
use super::{
    LocalViewer, mission_link, mission_link_focus, mission_mark, mission_segment,
    session_subagents_view, sidebar_mission_title,
};
use crate::{
    app_icon::AppIcon,
    appearance::{self, Space, TextRole},
    chat_order::{self, SECTIONS, Section},
    local_model::{Chat, MissionAssociation, Project},
    sidebar_memory::Memory,
    sidebar_tree::{self, Row, Tree, group_key},
    state_mark::{self, Fade, Glyph, Mark},
};
use gpui_kit::component::menu::{ContextMenuExt, DropdownMenu};
use gpui_kit::{
    App, Context, Div, FocusHandle, InteractiveElement, IntoElement, ParentElement, Pixels,
    SharedString, Styled, Task, TestSupportExt, WeakEntity, Window,
    component::{
        ActiveTheme, IconName, IndexPath, StyledExt,
        list::{ListDelegate, ListItem, ListState},
    },
    div,
    prelude::FluentBuilder,
    px,
};
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};

type Observed = gpui_kit::base::ObservedElement<gpui_kit::Stateful<Div>>;

/// Row heights. Two-line chat and parent rows keep the shared row height.
pub(crate) const MEMBER_HEIGHT: f32 = 28.;
pub(crate) const PARENT_HEIGHT: f32 = 32.;
pub(crate) const FOLD_HEIGHT: f32 = 24.;
/// A project section label, with a little air above its text.
pub(crate) const GROUP_HEIGHT: f32 = 30.;
const GROUP_AIR: f32 = 6.;
const HEADER_HEIGHT: f32 = 26.;
/// A header-less first section keeps a little air above its first row.
const HEADER_GAP: f32 = 4.;
/// A mission's Compass then a 6pt gap: member titles align with its name.
const GLYPH: f32 = 12.;
const THREAD_INDENT: f32 = GLYPH + 6.;
/// Titles align with the navigation glyph column.
const ROW_INSET: f32 = 7.;
/// The thread's tree: a stem down from the Compass's center, and a short
/// rounded branch to each member, stopping short of its title.
const STEM_X: f32 = ROW_INSET + GLYPH / 2.;
const BRANCH_END: f32 = ROW_INSET + THREAD_INDENT - 4.;
const BRANCH_RADIUS: f32 = 4.;
/// The fold chevron sits in the row's leading gutter, before the Compass.
const CHEVRON: f32 = 9.;
/// A two-line row (title and caption); a row without a caption is one line.
/// 48pt keeps the 2rem … button, centered on the title line, inside the row.
pub(crate) const TWO_LINE_HEIGHT: f32 = 48.;
pub(crate) const ONE_LINE_HEIGHT: f32 = PARENT_HEIGHT;

pub(crate) struct ChatList {
    pub(crate) action_owner: WeakEntity<LocalViewer>,
    pub(crate) all: Arc<Vec<Chat>>,
    pub(crate) tree: Tree,
    pub(crate) query: String,
    pub(crate) archived: bool,
    pub(crate) selected: Option<IndexPath>,
    pub(crate) opened: Option<String>,
    pub(crate) loaded: bool,
    pub(crate) project: Option<String>,
    pub(crate) projects: Arc<Vec<Project>>,
    /// A folder scope from the project picker (across all projects only).
    pub(crate) folder: Option<String>,
    /// Collapsed threads and threads showing their finished members, by mission.
    pub(crate) collapsed: HashSet<String>,
    pub(crate) show_finished: HashSet<String>,
    pub(crate) collapsed_subagents: HashSet<String>,
    /// Last looked and your own activity order, private to this machine.
    pub(crate) memory: Memory,
    /// Each row's mark fade, by row key.
    pub(crate) marks: HashMap<String, Fade>,
    /// The list's keyboard focus (its search field), for revealing row actions.
    pub(crate) focus: Option<FocusHandle>,
    /// Rows that build their action menu button: the hovered row, the selected
    /// row and the row whose menu opened last. Other rows leave the slot empty,
    /// so a scroll frame doesn't lay out and paint a menu button per row.
    pub(crate) hovered: Option<String>,
    pub(crate) menu_row: Option<String>,
}
impl ChatList {
    pub(crate) fn new(action_owner: WeakEntity<LocalViewer>, memory: Memory) -> Self {
        Self {
            action_owner,
            all: Arc::new(Vec::new()),
            tree: Tree::default(),
            query: String::new(),
            archived: false,
            selected: None,
            opened: None,
            loaded: false,
            project: None,
            projects: Arc::new(Vec::new()),
            folder: None,
            collapsed: HashSet::new(),
            show_finished: HashSet::new(),
            collapsed_subagents: HashSet::new(),
            memory,
            marks: HashMap::new(),
            focus: None,
            hovered: None,
            menu_row: None,
        }
    }
    pub(crate) fn filter(&mut self) {
        let archived = self.archived;
        let project = self.project.clone();
        // A folder keeps its projects' chats; pinned chats always show.
        let folder = self.folder.clone().filter(|_| project.is_none());
        let folders = self.memory.folders();
        let keep = move |c: &Chat| {
            (archived || !c.archived)
                && project
                    .as_ref()
                    .is_none_or(|id| c.project_id.as_ref() == Some(id))
                && folder.as_ref().is_none_or(|f| {
                    Section::of(c) == Section::Pinned || folders.holds(f, c.project_id.as_deref())
                })
        };
        self.tree = sidebar_tree::build(&sidebar_tree::Input {
            chats: &self.all,
            keep: &keep,
            query: &self.query,
            grouped: self.project.is_none(),
            collapsed: &self.collapsed,
            show_finished: &self.show_finished,
            opened: self.opened.as_deref(),
            memory: &self.memory,
        });
        let keys: HashSet<String> = self
            .tree
            .rows
            .iter()
            .map(|row| self.tree.key(*row, &self.all))
            .collect();
        self.marks.retain(|key, _| keys.contains(key));
    }
    fn position(&self, ix: IndexPath) -> Option<usize> {
        let start = *self.tree.bounds.get(ix.section)?;
        let end = *self.tree.bounds.get(ix.section + 1)?;
        (start + ix.row < end).then_some(start + ix.row)
    }
    fn path(&self, position: usize) -> Option<IndexPath> {
        (position < self.tree.rows.len()).then_some(())?;
        let section = self
            .tree
            .bounds
            .iter()
            .rposition(|start| *start <= position)?;
        Some(IndexPath::new(position - self.tree.bounds[section]).section(section))
    }
    pub(crate) fn row(&self, ix: IndexPath) -> Option<Row> {
        self.tree.rows.get(self.position(ix)?).copied()
    }
    /// The chat a row opens: its own, or a parent's coordinator.
    pub(crate) fn at(&self, ix: IndexPath) -> Option<&Chat> {
        match self.row(ix)? {
            Row::Chat(chat) | Row::Member { chat, .. } => self.all.get(chat),
            Row::Parent(thread) => self.all.get(self.tree.threads[thread].coordinator?),
            Row::Fold(_) | Row::Group(_) => None,
        }
    }
    /// Where a row appears, by key: a chat's canonical id or `mission:<id>`.
    pub(crate) fn index(&self, key: &str) -> Option<IndexPath> {
        self.path(self.tree.find(key, &self.all)?)
    }
    pub(crate) fn key_at(&self, ix: IndexPath) -> Option<String> {
        Some(self.tree.key(self.row(ix)?, &self.all))
    }
    pub(crate) fn first(&self) -> Option<IndexPath> {
        self.path(0)
    }
    /// The mission of a thread row (parent, member or fold).
    pub(crate) fn thread_of(&self, row: Row) -> Option<usize> {
        match row {
            Row::Parent(t) | Row::Member { thread: t, .. } | Row::Fold(t) => Some(t),
            Row::Chat(_) | Row::Group(_) => None,
        }
    }
    pub(crate) fn set_collapsed(&mut self, mission: &str, collapsed: bool) {
        if collapsed {
            self.collapsed.insert(mission.to_owned());
        } else {
            self.collapsed.remove(mission);
        }
        self.filter();
    }
    pub(crate) fn toggle_finished(&mut self, mission: &str) {
        if !self.show_finished.remove(mission) {
            self.show_finished.insert(mission.to_owned());
        }
        self.filter();
    }
    /// Collapse or expand a project section (saved with the sidebar memory).
    pub(crate) fn set_group_collapsed(&mut self, key: &str, collapsed: bool) {
        self.memory.set_group_collapsed(key, collapsed);
        self.filter();
    }
    /// Opening a member expands its thread, and a chat its project section.
    pub(crate) fn reveal(&mut self, id: &str) -> bool {
        let Some(chat) = self.all.iter().find(|c| c.id == id) else {
            return false;
        };
        let mut sections = vec![group_key(chat)];
        if let MissionAssociation::Linked(mission) = &chat.mission {
            sections.extend(
                self.all
                    .iter()
                    .filter(|c| {
                        c.mission_coordinator
                            && matches!(&c.mission, MissionAssociation::Linked(m) if m == mission)
                    })
                    .map(group_key),
            );
        }
        let thread = match &chat.mission {
            MissionAssociation::Linked(mission) if !chat.mission_coordinator => {
                self.collapsed.remove(mission.as_str())
            }
            _ => false,
        };
        let mut changed = thread;
        for key in sections {
            if self.memory.group_collapsed(&key) {
                self.memory.set_group_collapsed(&key, false);
                changed = true;
            }
        }
        changed
    }
    /// Left/Right on the selected row: collapse or expand a project section or
    /// a parent, or move between a row and its parent or section label. None
    /// when the key does nothing here.
    pub(crate) fn arrow(&mut self, right: bool) -> Option<IndexPath> {
        let ix = self.selected?;
        let row = self.row(ix)?;
        let position = self.position(ix)?;
        if let Row::Group(g) = row {
            let group = self.tree.groups[g].clone();
            let label = self.tree.key(row, &self.all);
            return match (right, group.collapsed) {
                (false, false) | (true, true) => {
                    self.set_group_collapsed(&group.key, !right);
                    self.index(&label)
                }
                (true, false) => (!matches!(self.tree.rows.get(position + 1), Some(Row::Group(_))))
                    .then(|| self.path(position + 1))
                    .flatten()
                    .filter(|next| next.section == ix.section),
                (false, true) => None,
            };
        }
        if let Some(thread) = self.thread_of(row)
            && let Some(next) = self.thread_arrow(ix, row, thread, right)
        {
            return Some(next);
        }
        // Left from any other row in a section moves to its label.
        if right || SECTIONS[ix.section] != Section::Chats {
            return None;
        }
        let start = self.tree.bounds[ix.section];
        let label = (start..position)
            .rev()
            .find(|p| matches!(self.tree.rows[*p], Row::Group(_)))?;
        self.path(label)
    }
    fn thread_arrow(
        &mut self,
        ix: IndexPath,
        row: Row,
        thread: usize,
        right: bool,
    ) -> Option<IndexPath> {
        let mission = self.tree.threads[thread].mission.clone();
        let parent_key = self.tree.key(Row::Parent(thread), &self.all);
        match (row, right) {
            (Row::Parent(t), false) if !self.tree.threads[t].collapsed => {
                self.set_collapsed(&mission, true);
                self.index(&parent_key)
            }
            (Row::Parent(t), true) if self.tree.threads[t].collapsed => {
                self.set_collapsed(&mission, false);
                self.index(&parent_key)
            }
            (Row::Parent(_), true) => {
                let next = self.position(ix)? + 1;
                matches!(
                    self.tree.rows.get(next),
                    Some(Row::Member { .. } | Row::Fold(_))
                )
                .then(|| self.path(next))
                .flatten()
            }
            (Row::Member { .. } | Row::Fold(_), false) => self.index(&parent_key),
            _ => None,
        }
    }
    fn mission_name(&self, mission: &str, cx: &App) -> Option<(String, bool)> {
        let owner = self.action_owner.upgrade()?;
        let owner = owner.read(cx);
        sidebar_mission_title(
            owner.state.mission_titles.as_deref(),
            owner.local_online(),
            mission,
            || {
                owner
                    .missions
                    .read(cx)
                    .sidebar_mission_name(mission)
                    .map(|(title, current)| (title.to_owned(), current))
            },
        )
        .filter(|(title, _)| !title.trim().is_empty())
    }
    /// Rows inside project sections don't repeat their project.
    fn in_groups(&self, section: usize) -> bool {
        !self.tree.groups.is_empty() && SECTIONS[section] == Section::Chats
    }
    /// A row's project caption: across all projects, outside project sections.
    fn project_name(&self, chat: Option<&Chat>, section: usize) -> Option<String> {
        (self.project.is_none() && !self.in_groups(section)).then_some(())?;
        let id = chat?.project_id.as_ref()?;
        self.projects
            .iter()
            .find(|p| &p.id == id)
            .map(|p| p.name.clone())
    }
    /// A project section's label: the project's name, else its folder as ~/path.
    pub(crate) fn group_name(&self, key: &str) -> (String, bool) {
        if let Some(id) = key.strip_prefix("project:") {
            let name = self
                .projects
                .iter()
                .find(|p| p.id == id)
                .map_or_else(|| "Project unavailable".to_owned(), |p| p.name.clone());
            return (name, false);
        }
        let path = key.strip_prefix("dir:").unwrap_or(key);
        (
            if path.is_empty() {
                "No folder".to_owned()
            } else {
                tilde(path)
            },
            true,
        )
    }
    /// Whether a standalone row has a caption: project, state or mission.
    fn chat_caption(&self, chat: &Chat, section: usize) -> bool {
        self.project_name(Some(chat), section).is_some()
            || !chat_order::row_state(chat).is_empty()
            || mission_mark(chat, |_| None).is_some()
    }
    fn parent_caption(&self, thread: usize, section: usize) -> bool {
        let t = &self.tree.threads[thread];
        let lead = t.coordinator.or(t.members.first().copied());
        self.project_name(lead.and_then(|c| self.all.get(c)), section)
            .is_some()
    }
    fn fade(
        &mut self,
        key: &str,
        glyph: Option<Glyph>,
        window: &mut Window,
        cx: &App,
    ) -> (Option<Glyph>, Option<Glyph>, f32) {
        self.marks
            .entry(key.to_owned())
            .or_default()
            .show(glyph, window, cx)
    }
    /// The trailing slot: the mark or circle (filled for a new reply), swapped
    /// for the row's … menu on hover or keyboard selection. The right-click
    /// menu reaches the same actions.
    #[allow(clippy::too_many_arguments)]
    fn trailing(
        &mut self,
        ix: IndexPath,
        key: &str,
        chat: Option<&Chat>,
        glyph: Option<Glyph>,
        narrow: bool,
        window: &mut Window,
        cx: &mut Context<ListState<Self>>,
    ) -> Observed {
        let (shown, previous, t) = self.fade(key, glyph, window, cx);
        let menu_shown = self.menu_shown(ix, window);
        // The selected row keeps its button for Tab; the last opened menu's row
        // keeps it so Escape can return focus to the trigger.
        let menu_built = chat.is_some()
            && (self.selected == Some(ix)
                || self.hovered.as_deref() == Some(key)
                || self.menu_row.as_deref() == Some(key));
        let list = cx.entity().downgrade();
        let open_id = key.to_owned();
        let owner = self.action_owner.clone();
        let menu_chat = chat.cloned();
        div()
            .id(SharedString::from(format!("chat-menu-slot-{key}")))
            .relative()
            .flex_none()
            // One-line thread rows keep a narrower slot; the 2rem button
            // overhangs into their state word, which hides with it. Its margin
            // keeps the mark centered in the same column as wide slots'.
            .map(|d| {
                if narrow {
                    d.w_5().mr(gpui_kit::rems(0.375))
                } else {
                    d.w_8()
                }
            })
            .h(px(TextRole::BODY))
            .flex()
            .items_center()
            .justify_center()
            .child(
                div()
                    .id(SharedString::from(format!("chat-mark-{key}")))
                    .test_support()
                    .absolute()
                    .inset_0()
                    .flex()
                    .items_center()
                    .justify_center()
                    .when(menu_shown, |d| d.opacity(0.))
                    .when(chat.is_some(), |d| {
                        d.group_hover("chat-row", |s| s.opacity(0.))
                    })
                    .child(state_mark::slot(shown, previous, t, cx)),
            )
            .child(
                // A text-height slot: the 2rem target overhangs it rather than
                // pushing the metadata line away from the title.
                div()
                    .absolute()
                    .inset_0()
                    .flex()
                    .items_center()
                    .justify_center()
                    .opacity(if menu_shown { 1. } else { 0. })
                    .group_hover("chat-row", |s| s.opacity(1.))
                    .when_some(menu_chat.filter(|_| menu_built), |d, menu_chat| {
                        d.child(
                            crate::ui::icon_action(
                                SharedString::from(format!("chat-menu-{}", menu_chat.id)),
                                "Chat actions",
                                AppIcon::More,
                                crate::ui::Action::Quiet,
                            )
                            .size_8()
                            .dropdown_menu(move |menu, w, cx| {
                                LocalViewer::chat_actions_menu(
                                    owner.clone(),
                                    menu_chat.clone(),
                                    menu,
                                    w,
                                    cx,
                                )
                            })
                            .on_open_change(move |open, _, cx| {
                                if *open {
                                    let _ = list.update(cx, |list, cx| {
                                        list.delegate_mut().menu_row = Some(open_id.clone());
                                        cx.notify();
                                    });
                                }
                            }),
                        )
                    }),
            )
            .test_support()
    }
    /// Row actions show on hover, or on the keyboard-selected row while the
    /// list has keyboard focus.
    fn menu_shown(&self, ix: IndexPath, window: &Window) -> bool {
        self.selected == Some(ix)
            && window.last_input_was_keyboard()
            && self.focus.as_ref().is_some_and(|f| f.is_focused(window))
    }
    /// The row frame every kind shares: hover tracking for the menu, the
    /// row guard, the open-chat fill and the context menu.
    fn frame(
        &self,
        ix: IndexPath,
        key: &str,
        chat: Option<&Chat>,
        height: f32,
        cx: &mut Context<ListState<Self>>,
    ) -> Observed {
        use gpui_kit::StatefulInteractiveElement as _;
        let list = cx.entity().downgrade();
        let hover_id = key.to_owned();
        let owner = self.action_owner.clone();
        let open =
            self.opened.is_some() && chat.is_some_and(|c| self.opened.as_ref() == Some(&c.id));
        div()
            .id(SharedString::from(format!("chat-row-{key}")))
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
            .relative()
            .overflow_hidden()
            .rounded(px(appearance::Radius::ROW))
            .pl(px(ROW_INSET))
            .min_w_0()
            .w_full()
            .h(px(height))
            .bg(if open && self.selected != Some(ix) {
                appearance::selected(cx)
            } else {
                cx.theme().transparent
            })
    }
    /// The right-click menu reaches a chat's row actions even when the … is hidden.
    fn menu(&self, row: Observed, chat: Option<&Chat>) -> gpui_kit::AnyElement {
        let Some(chat) = chat.cloned() else {
            return row.into_any_element();
        };
        let owner = self.action_owner.clone();
        row.context_menu(move |menu, w, cx| {
            LocalViewer::chat_actions_menu(owner.clone(), chat.clone(), menu, w, cx)
        })
        .into_any_element()
    }
    /// A coordinator row's Open mission button: the row itself opens the
    /// coordinator's chat. Built and shown like the … (hover or keyboard
    /// selection), and while Tab has focused it.
    fn open_mission(
        &self,
        ix: IndexPath,
        key: &str,
        mission: &str,
        keyboard: bool,
        window: &mut Window,
        cx: &mut Context<ListState<Self>>,
    ) -> OpenMission {
        let focus = window
            .use_keyed_state(
                SharedString::from(format!("sidebar-open-mission-focus-{key}")),
                cx,
                |_, cx| cx.focus_handle(),
            )
            .read(cx)
            .clone();
        let hovered = self.hovered.as_deref() == Some(key);
        let focused = focus.contains_focused(window, cx);
        OpenMission {
            mission: mission.to_owned(),
            owner: self.action_owner.clone(),
            built: hovered || self.selected == Some(ix),
            shown: hovered || keyboard || focused,
            focused,
            focus,
        }
    }
    fn render_chat(
        &mut self,
        ix: IndexPath,
        chat: Chat,
        window: &mut Window,
        cx: &mut Context<ListState<Self>>,
    ) -> ListItem {
        let mark_state = Mark::of(&chat);
        let unread = self.memory.unread(&chat) && !asks_for_look(mark_state);
        // RowLine: project (only across all projects), then the state reason.
        // Quiet chats say nothing rather than a raw "idle".
        let project = self.project_name(Some(&chat), ix.section);
        let state = chat_order::row_state(&chat);
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
        let spoken = label(
            &chat.title,
            // Inside a project section the project is still spoken.
            self.project_name(Some(&chat), Section::Pinned as usize)
                .into_iter()
                .chain((!state.is_empty()).then(|| state.clone()))
                .chain(mark.as_ref().map(|m| m.label.clone())),
            unread,
        );
        let state_color = mark_state
            .filter(|m| m.bucket() != Mark::Working)
            .map_or(cx.theme().muted_foreground, |m| m.color(cx));
        let trailing = self.trailing(
            ix,
            &chat.id,
            Some(&chat),
            Glyph::of(mark_state, unread),
            false,
            window,
            cx,
        );
        let height = if self.chat_caption(&chat, ix.section) {
            TWO_LINE_HEIGHT
        } else {
            ONE_LINE_HEIGHT
        };
        let frame = self.frame(ix, &chat.id, Some(&chat), height, cx);
        let row = frame
            .v_flex()
            .justify_center()
            .when(height == TWO_LINE_HEIGHT, |d| d.py_1())
            .child(
                div()
                    .relative()
                    .h_flex()
                    .items_center()
                    .gap_1()
                    .child(lane(
                        div()
                            .id("sidebar-chat-title")
                            .test_support()
                            .min_w_0()
                            .truncate()
                            .text_size(px(TextRole::BODY))
                            .child(SharedString::from(chat.title.clone())),
                    ))
                    .child(trailing),
            )
            .when(!detail.is_empty() || mark.is_some(), |row| {
                row.child(
                    div()
                        .id("sidebar-chat-detail")
                        .test_support()
                        .h_flex()
                        .items_center()
                        .min_w_0()
                        .pr_2()
                        .text_size(px(TextRole::CAPTION))
                        .text_color(cx.theme().muted_foreground)
                        // A long project name yields before the state reason.
                        // Beside a mission it keeps a readable start and
                        // its own separator, so all three stay on the line.
                        .children(project.map(|p| {
                            div()
                                .id("sidebar-chat-project")
                                .test_support()
                                .min_w_0()
                                .when(mark.is_some(), |d| d.min_w(px(Space::SECTION)))
                                .flex_shrink(16.)
                                .truncate()
                                .child(SharedString::from(p))
                        }))
                        .when(has_project && !state.is_empty(), |d| {
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
                                    .text_color(state_color)
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
            });
        item(&chat.id, spoken, self.opened.as_ref() == Some(&chat.id)).child(self.with_subagents(
            self.menu(row, Some(&chat)),
            Some(&chat),
            false,
            cx,
        ))
    }
    fn render_parent(
        &mut self,
        ix: IndexPath,
        thread: usize,
        window: &mut Window,
        cx: &mut Context<ListState<Self>>,
    ) -> ListItem {
        use gpui_kit::StatefulInteractiveElement as _;
        let t = self.tree.threads[thread].clone();
        let key = self.tree.key(Row::Parent(thread), &self.all);
        let coordinator = t.coordinator.and_then(|c| self.all.get(c)).cloned();
        let lead = coordinator
            .clone()
            .or_else(|| t.members.first().and_then(|m| self.all.get(*m)).cloned());
        let named = self.mission_name(&t.mission, cx);
        let (title, accent) = match (&named, &coordinator) {
            (Some((title, _)), _) => (title.clone(), true),
            (None, Some(chat)) => (chat.title.clone(), false),
            (None, None) => ("Mission name unavailable".to_owned(), false),
        };
        let mark = coordinator.as_ref().and_then(Mark::of);
        // Its own coloured mark, or Needs you rolled up, already asks for a look.
        let needs = asks_for_look(mark) || (t.collapsed && t.rollup.needs > 0);
        let unread = !needs
            && (coordinator.as_ref().is_some_and(|c| self.memory.unread(c))
                || (t.collapsed && t.rollup.unread));
        let project = self.project_name(lead.as_ref(), ix.section);
        let counts = if t.collapsed {
            t.rollup.counts()
        } else {
            Vec::new()
        };
        let expandable = !t.members.is_empty();
        let mut spoken: Vec<String> = vec!["Mission".into()];
        spoken.extend(
            named
                .as_ref()
                .filter(|(_, current)| !current)
                .map(|_| "last known name".to_owned()),
        );
        spoken.extend(
            coordinator
                .as_ref()
                .map(chat_order::row_state)
                .filter(|s| !s.is_empty()),
        );
        if coordinator.is_none() {
            spoken.push("No coordinator chat; opens the mission".into());
        }
        spoken.extend(self.project_name(lead.as_ref(), Section::Pinned as usize));
        if expandable {
            spoken.push(format!(
                "{} · {} member{}",
                if t.collapsed { "Collapsed" } else { "Expanded" },
                t.members.len(),
                if t.members.len() == 1 { "" } else { "s" }
            ));
        }
        // Spoken like the dots: Needs you stands in for new replies.
        let rollup = sidebar_tree::Rollup {
            unread: t.rollup.unread && !needs,
            ..t.rollup
        };
        if t.collapsed && !rollup.words().is_empty() {
            spoken.push(rollup.words());
        }
        let spoken = label(&title, spoken.into_iter(), unread);
        let word = mark.map(|m| (m.word(), m));
        let accent_color = appearance::accent_mark(cx);
        // The stem runs down to the members when they show.
        let stem = !t.collapsed
            && self
                .position(ix)
                .and_then(|p| self.tree.rows.get(p + 1))
                .is_some_and(|row| matches!(row, Row::Member { thread: m, .. } if *m == thread));
        let trailing = self.trailing(
            ix,
            &key,
            coordinator.as_ref(),
            Glyph::of(mark, unread),
            true,
            window,
            cx,
        );
        let keyboard = self.menu_shown(ix, window);
        // A collapsed thread's roll-up follows the title; only the project
        // takes a second line. The title truncates first, down to a few
        // letters; then counts that no longer fit wrap onto a hidden second
        // line, so a count shows whole or not at all. The accessible name
        // keeps every count, and the state word and mark stay put.
        let caption = project.is_some();
        let keep_title = title.chars().count() > 4;
        let tally = (!counts.is_empty()).then(|| {
            div()
                .id("sidebar-mission-rollup")
                .test_support()
                .min_w_0()
                .h(px(state_mark::SLOT))
                .line_height(px(state_mark::SLOT))
                .overflow_hidden()
                .h_flex()
                .flex_wrap()
                .items_center()
                .gap_x_1()
                .text_size(px(TextRole::CAPTION))
                .text_color(cx.theme().muted_foreground)
                .children(counts.iter().map(|&(mark, n)| {
                    // Glyph and count; Working is a neutral hollow ring. The
                    // accessible name keeps the words.
                    div()
                        .id(SharedString::from(format!("mission-rollup-{:?}", mark)))
                        .test_support()
                        .flex_none()
                        .h_flex()
                        .items_center()
                        .gap_0p5()
                        .text_color(if mark == Mark::Working {
                            cx.theme().muted_foreground
                        } else {
                            mark.color(cx)
                        })
                        .child(state_mark::slot(Some(mark.into()), None, 1., cx))
                        .child(n.to_string())
                }))
        });
        let open_mission = coordinator
            .is_some()
            .then(|| self.open_mission(ix, &key, &t.mission, keyboard, window, cx));
        let menu = coordinator
            .is_some()
            .then(|| keyboard || open_mission.as_ref().is_some_and(|o| o.focused));
        let height = if caption {
            TWO_LINE_HEIGHT
        } else {
            PARENT_HEIGHT
        };
        let frame = self.frame(ix, &key, coordinator.as_ref(), height, cx);
        let list = cx.entity().downgrade();
        let mission = t.mission.clone();
        let open = coordinator
            .as_ref()
            .is_some_and(|c| self.opened.as_ref() == Some(&c.id));
        let row = frame
            .v_flex()
            .justify_center()
            .when(caption, |d| d.py_1())
            .child(
                div()
                    .relative()
                    .h_flex()
                    .items_center()
                    .child(
                        div()
                            .id("sidebar-mission-glyph")
                            .test_support()
                            .relative()
                            .flex_none()
                            .w(px(GLYPH))
                            .mr(px(THREAD_INDENT - GLYPH))
                            .flex()
                            .justify_center()
                            .text_color(accent_color)
                            .child(AppIcon::Coordinator.inline().size_3())
                            // The row clips the stem at its bottom edge.
                            .when(stem, |d| {
                                d.child(
                                    div()
                                        .id("sidebar-thread-stem")
                                        .test_support()
                                        .absolute()
                                        .top(px(GLYPH + 3.))
                                        .left(px(GLYPH / 2. - 0.5))
                                        .w(px(1.))
                                        .h(px(TWO_LINE_HEIGHT))
                                        .bg(cx.theme().border),
                                )
                            }),
                    )
                    // The title truncates first; the roll-up after it stays
                    // whole.
                    .child(
                        lane(
                            div()
                                .id("sidebar-mission-title")
                                .test_support()
                                .min_w_0()
                                .when(keep_title, |d| d.min_w(gpui_kit::rems(2.5)))
                                // Shrinks well ahead of the roll-up after it.
                                .flex_shrink(100.)
                                .truncate()
                                .text_size(px(TextRole::BODY))
                                .font_medium()
                                .when(accent, |d| d.text_color(accent_color))
                                .child(SharedString::from(title)),
                        )
                        .children(tally),
                    )
                    .map(|line| {
                        let word = word.map(|(word, mark)| state_word(word, mark, menu, cx));
                        match open_mission {
                            Some(open) => line.child(open.place(word)),
                            None => line.children(word),
                        }
                    })
                    .child(trailing)
                    // The chevron sits in the leading gutter before the
                    // Compass: always while collapsed, else on hover or
                    // keyboard selection. Its target spans the gutter and the
                    // Compass and toggles the thread; the rest of the row
                    // opens the chat.
                    .when(expandable, |line| {
                        line.child(
                            div()
                                .id(SharedString::from(format!(
                                    "mission-disclosure-{}",
                                    t.mission
                                )))
                                .test_support()
                                .absolute()
                                .left(px(-ROW_INSET))
                                .top(px(-8.))
                                .bottom(px(-8.))
                                .w(px(ROW_INSET + GLYPH))
                                .cursor_pointer()
                                .child(
                                    div()
                                        .id("sidebar-mission-chevron")
                                        .test_support()
                                        .absolute()
                                        .top_0()
                                        .bottom_0()
                                        .left_0()
                                        .w(px(ROW_INSET))
                                        .flex()
                                        .items_center()
                                        .justify_center()
                                        .text_color(cx.theme().muted_foreground)
                                        .when(!t.collapsed && !keyboard, |d| {
                                            d.opacity(0.).group_hover("chat-row", |s| s.opacity(1.))
                                        })
                                        .child(
                                            gpui_kit::component::Icon::new(if t.collapsed {
                                                IconName::ChevronRight
                                            } else {
                                                IconName::ChevronDown
                                            })
                                            .flex_none()
                                            .size(px(CHEVRON)),
                                        ),
                                )
                                .on_mouse_down(gpui_kit::MouseButton::Left, |_, w, cx| {
                                    w.prevent_default();
                                    cx.stop_propagation();
                                })
                                .on_click(move |_, _, cx| {
                                    cx.stop_propagation();
                                    let _ = list.update(cx, |list, cx| {
                                        let collapsed =
                                            !list.delegate().collapsed.contains(&mission);
                                        list.delegate_mut().set_collapsed(&mission, collapsed);
                                        cx.notify();
                                    });
                                }),
                        )
                    }),
            )
            .when(caption, |d| {
                d.child(
                    div()
                        .id("sidebar-mission-detail")
                        .test_support()
                        .h_flex()
                        .items_center()
                        .gap_1()
                        .min_w_0()
                        .pl(px(THREAD_INDENT))
                        .pr_2()
                        .text_size(px(TextRole::CAPTION))
                        .text_color(cx.theme().muted_foreground)
                        .children(
                            project
                                .map(|p| div().min_w_0().truncate().child(SharedString::from(p))),
                        ),
                )
            });
        item(&key, spoken, open).child(self.with_subagents(
            self.menu(row, coordinator.as_ref()),
            coordinator.as_ref(),
            stem,
            cx,
        ))
    }
    fn render_member(
        &mut self,
        ix: IndexPath,
        chat: Chat,
        thread: usize,
        window: &mut Window,
        cx: &mut Context<ListState<Self>>,
    ) -> ListItem {
        let mark = Mark::of(&chat);
        let unread = self.memory.unread(&chat) && !asks_for_look(mark);
        let state = chat_order::row_state(&chat);
        // A member from another project than its thread's section names it.
        let elsewhere = (!self.tree.groups.is_empty()
            && self.tree.thread_group(thread, &self.all).as_deref() != Some(&group_key(&chat)))
        .then(|| self.group_name(&group_key(&chat)).0);
        let mission = self.tree.threads[thread].mission.clone();
        let mission = self
            .mission_name(&mission, cx)
            .map_or("Member of a mission".to_owned(), |(name, _)| {
                format!("Member of {name}")
            });
        let spoken = label(
            &chat.title,
            (!state.is_empty())
                .then_some(state)
                .into_iter()
                .chain(elsewhere.clone())
                .chain([mission]),
            unread,
        );
        let quiet = mark.is_none();
        // The last shown member ends the stem with its branch.
        let last = !self
            .position(ix)
            .and_then(|p| self.tree.rows.get(p + 1))
            .is_some_and(|row| matches!(row, Row::Member { thread: t, .. } if *t == thread));
        let trailing = self.trailing(
            ix,
            &chat.id,
            Some(&chat),
            Glyph::of(mark, unread),
            true,
            window,
            cx,
        );
        let menu = Some(self.menu_shown(ix, window));
        let frame = self.frame(ix, &chat.id, Some(&chat), MEMBER_HEIGHT, cx);
        let row = frame
            .h_flex()
            .items_center()
            .child(branch(last, cx))
            .child(div().flex_none().w(px(THREAD_INDENT)))
            .child(
                lane(
                    div()
                        .id("sidebar-chat-title")
                        .test_support()
                        .min_w_0()
                        .truncate()
                        .text_size(px(TextRole::BODY))
                        .when(quiet && !unread, |d| {
                            d.text_color(cx.theme().muted_foreground)
                        })
                        .child(SharedString::from(chat.title.clone())),
                )
                // The title keeps its room; another project's name yields first.
                .flex_auto(),
            )
            .children(elsewhere.map(|project| {
                div()
                    .id("sidebar-member-project")
                    .test_support()
                    .min_w(px(36.))
                    .max_w(gpui_kit::relative(0.35))
                    .flex_shrink(16.)
                    .pl_1()
                    .truncate()
                    .text_size(px(TextRole::CAPTION))
                    .text_color(cx.theme().muted_foreground)
                    .child(SharedString::from(project))
            }))
            .children(mark.map(|m| state_word(m.word(), m, menu, cx)))
            .child(trailing);
        item(&chat.id, spoken, self.opened.as_ref() == Some(&chat.id)).child(self.with_subagents(
            self.menu(row, Some(&chat)),
            Some(&chat),
            !last,
            cx,
        ))
    }
    fn with_subagents(
        &self,
        row: gpui_kit::AnyElement,
        chat: Option<&Chat>,
        stem: bool,
        cx: &mut Context<ListState<Self>>,
    ) -> gpui_kit::AnyElement {
        let Some(chat) = chat.filter(|c| c.subagents.visible()) else {
            return row;
        };
        div()
            .v_flex()
            .w_full()
            .min_w_0()
            .child(row)
            .child(
                div()
                    .relative()
                    .w_full()
                    .min_w_0()
                    .when(stem, |d| {
                        d.child(
                            div()
                                .absolute()
                                .left(px(STEM_X - 0.5))
                                .top_0()
                                .bottom_0()
                                .w(px(1.))
                                .bg(cx.theme().border),
                        )
                    })
                    .child(session_subagents_view::sidebar(
                        self.action_owner.clone(),
                        chat,
                        self.collapsed_subagents.contains(&chat.id),
                        cx.entity().downgrade(),
                        cx,
                    )),
            )
            .into_any_element()
    }
    fn render_fold(
        &mut self,
        ix: IndexPath,
        thread: usize,
        cx: &mut Context<ListState<Self>>,
    ) -> ListItem {
        let t = &self.tree.threads[thread];
        let key = self.tree.key(Row::Fold(thread), &self.all);
        let (text, spoken) = if t.show_finished {
            ("Hide finished".to_owned(), "Hide finished chats".to_owned())
        } else {
            (
                format!("+{} finished", t.finished),
                format!(
                    "Show {} finished chat{}",
                    t.finished,
                    if t.finished == 1 { "" } else { "s" }
                ),
            )
        };
        let frame = self.frame(ix, &key, None, FOLD_HEIGHT, cx);
        item(&key, spoken, false).child(
            frame
                .h_flex()
                .items_center()
                .child(div().flex_none().w(px(THREAD_INDENT)))
                .child(
                    div()
                        .id(SharedString::from(format!("mission-fold-{}", t.mission)))
                        .test_support()
                        .text_size(px(TextRole::CAPTION))
                        .text_color(cx.theme().muted_foreground)
                        .child(SharedString::from(text)),
                ),
        )
    }
}

/// The shared Kit row, named in full for accessibility.
fn item(key: &str, spoken: String, open: bool) -> ListItem {
    ListItem::new(SharedString::from(key.to_owned()))
        .px_0()
        .py_0()
        .rounded(px(appearance::Radius::ROW))
        .accessibility_label(SharedString::from(spoken))
        .confirmed(open)
}
fn label(title: &str, parts: impl Iterator<Item = String>, unread: bool) -> String {
    std::iter::once(title.to_owned())
        .chain(parts.filter(|p| !p.is_empty()))
        .chain(unread.then(|| "new reply".to_owned()))
        .collect::<Vec<_>>()
        .join(" · ")
}
/// A one-line row's state word. With row actions (`menu`), it gives way to
/// the … button on hover or keyboard selection (`Some(true)`).
fn state_word(word: &'static str, mark: Mark, menu: Option<bool>, cx: &App) -> Observed {
    div()
        .id("sidebar-state-word")
        .test_support()
        .flex_none()
        .pl_1()
        .when(menu == Some(true), |d| d.opacity(0.))
        .when(menu.is_some(), |d| {
            d.group_hover("chat-row", |s| s.opacity(0.))
        })
        .text_size(px(TextRole::CAPTION))
        .text_color(if mark.bucket() == Mark::Working {
            cx.theme().muted_foreground
        } else {
            mark.color(cx)
        })
        .child(word)
}
/// A coordinator row's Open mission button, from `ChatList::open_mission`.
struct OpenMission {
    mission: String,
    owner: WeakEntity<LocalViewer>,
    focus: FocusHandle,
    /// The hovered or selected row builds it, so Tab can reach it.
    built: bool,
    /// Hover, keyboard selection or its own focus shows it.
    shown: bool,
    focused: bool,
}
impl OpenMission {
    /// The button sits over the state word, right before the …, which
    /// overhangs its narrow slot by 0.375rem. The row makes room for it only
    /// while it shows, so titles keep their width at rest.
    fn place(self, word: Option<Observed>) -> Observed {
        let Self {
            mission,
            owner,
            focus,
            built,
            shown,
            ..
        } = self;
        div()
            .id("sidebar-mission-actions")
            .test_support()
            .relative()
            .flex_none()
            .h_flex()
            .items_center()
            .justify_end()
            .when(shown, |d| d.min_w(gpui_kit::rems(2.375)))
            .children(word)
            .when(built, |d| {
                let id = SharedString::from(format!("sidebar-open-mission-{mission}"));
                let open = std::rc::Rc::new(move |w: &mut Window, cx: &mut App| {
                    let _ = owner.update(cx, |v, cx| v.show_chat_mission(&mission, w, cx));
                });
                let confirm = open.clone();
                d.child(
                    div()
                        .id("sidebar-open-mission-slot")
                        .track_focus(&focus)
                        .absolute()
                        .top_0()
                        .bottom_0()
                        .right(gpui_kit::rems(0.375))
                        .flex()
                        .items_center()
                        .opacity(if shown { 1. } else { 0. })
                        .group_hover("chat-row", |s| s.opacity(1.))
                        // Enter is the list's Confirm (open the row's chat);
                        // on the focused button it opens the mission.
                        .on_action(move |_: &gpui_kit::base::actions::Confirm, w, cx| {
                            confirm(w, cx)
                        })
                        .child(
                            crate::ui::icon_action(
                                id,
                                "Open mission",
                                AppIcon::Mission,
                                crate::ui::Action::Quiet,
                            )
                            .size_8()
                            // Neither selects nor clicks the row, which opens
                            // the coordinator's chat.
                            .on_mouse_down(gpui_kit::MouseButton::Left, |_, w, cx| {
                                w.prevent_default();
                                cx.stop_propagation();
                            })
                            .on_click(move |_, w, cx| {
                                cx.stop_propagation();
                                open(w, cx);
                            }),
                        ),
                )
            })
    }
}
/// The title lane: the title takes the row's free width.
fn lane(title: impl IntoElement) -> Div {
    div()
        .flex_1()
        .min_w_0()
        .h_flex()
        .items_center()
        .gap_1p5()
        .child(title)
}
/// A Needs you, Failed or Ready mark already asks for a look, so its row
/// shows no "new reply" state; the circle fills only for Working, Background
/// and quiet rows.
fn asks_for_look(mark: Option<Mark>) -> bool {
    mark.is_some_and(Mark::asks_for_look)
}
/// A member's part of the thread tree: the stem from the parent's Compass and
/// a short rounded branch to the title. The last member's branch ends the stem.
/// Pieces only touch at the fork, so the translucent hairline stays even.
fn branch(last: bool, cx: &App) -> Observed {
    let color = cx.theme().border;
    let middle = MEMBER_HEIGHT / 2.;
    let curve = middle - 2. * BRANCH_RADIUS;
    let line = |top: f32, height: f32| {
        div()
            .absolute()
            .left(px(STEM_X - 0.5))
            .top(px(top))
            .w(px(1.))
            .h(px(height))
            .bg(color)
    };
    div()
        .id("sidebar-thread-branch")
        .test_support()
        .absolute()
        .inset_0()
        .child(line(0., curve))
        .child(
            div()
                .id("sidebar-thread-elbow")
                .test_support()
                .absolute()
                .left(px(STEM_X - 0.5))
                .top(px(curve))
                .w(px(BRANCH_END - STEM_X + 0.5))
                .h(px(2. * BRANCH_RADIUS + 0.5))
                .border_l_1()
                .border_b_1()
                .border_color(color)
                .rounded_bl(px(BRANCH_RADIUS)),
        )
        // Below the curve's start, the stem carries on to the next member.
        .when(!last, |d| {
            d.child(
                line(
                    middle - BRANCH_RADIUS + 2.,
                    MEMBER_HEIGHT - (middle - BRANCH_RADIUS + 2.),
                )
                .id("sidebar-thread-continues")
                .test_support(),
            )
        })
}

impl ListDelegate for ChatList {
    type Item = ListItem;
    fn sections_count(&self, _: &App) -> usize {
        SECTIONS.len()
    }
    fn items_count(&self, section: usize, _: &App) -> usize {
        self.tree.bounds[section + 1] - self.tree.bounds[section]
    }
    fn item_height(&self, ix: IndexPath, _: &App) -> Option<Pixels> {
        let subagents = self.at(ix).is_some_and(|c| c.subagents.visible());
        Some(px((match self.row(ix)? {
            Row::Chat(chat) if self.chat_caption(self.all.get(chat)?, ix.section) => {
                TWO_LINE_HEIGHT
            }
            Row::Chat(_) => ONE_LINE_HEIGHT,
            Row::Parent(t) if self.parent_caption(t, ix.section) => TWO_LINE_HEIGHT,
            Row::Parent(_) => PARENT_HEIGHT,
            Row::Member { .. } => MEMBER_HEIGHT,
            Row::Fold(_) => FOLD_HEIGHT,
            Row::Group(_) => GROUP_HEIGHT,
        }) + if subagents {
            self.at(ix).map_or(0., |chat| {
                session_subagents_view::sidebar_height(
                    &chat.subagents,
                    self.collapsed_subagents.contains(&chat.id),
                )
            })
        } else {
            0.
        }))
    }
    fn section_header_height(&self, section: usize, _: &App) -> Option<Pixels> {
        Some(px(if self.header_shown(section) {
            HEADER_HEIGHT
        } else {
            HEADER_GAP
        }))
    }
    /// Caption headings for Drafts, Pinned and Archived; Chats is named only
    /// when something sits above it and it has no project sections.
    fn render_section_header(
        &mut self,
        section: usize,
        _: &mut Window,
        cx: &mut Context<ListState<Self>>,
    ) -> Option<impl IntoElement> {
        let kind = SECTIONS[section];
        let shown = self.header_shown(section);
        Some(
            div()
                .id(SharedString::from(format!(
                    "sidebar-section-{}",
                    kind.key()
                )))
                .test_support()
                .h_flex()
                .items_end()
                .h(px(if shown { HEADER_HEIGHT } else { HEADER_GAP }))
                .pl_2()
                .pb_1()
                .text_size(px(TextRole::CAPTION))
                .font_semibold()
                .text_color(cx.theme().muted_foreground)
                .when(shown, |d| {
                    d.child(
                        div()
                            .id(SharedString::from(format!(
                                "sidebar-section-title-{}",
                                kind.key()
                            )))
                            .test_support()
                            .child(kind.title()),
                    )
                }),
        )
    }
    fn render_item(
        &mut self,
        ix: IndexPath,
        window: &mut Window,
        cx: &mut Context<ListState<Self>>,
    ) -> Option<ListItem> {
        Some(match self.row(ix)? {
            Row::Chat(chat) => {
                let chat = self.all.get(chat)?.clone();
                self.render_chat(ix, chat, window, cx)
            }
            Row::Parent(thread) => self.render_parent(ix, thread, window, cx),
            Row::Member { chat, thread } => {
                let chat = self.all.get(chat)?.clone();
                self.render_member(ix, chat, thread, window, cx)
            }
            Row::Fold(thread) => self.render_fold(ix, thread, cx),
            Row::Group(group) => self.render_group(ix, group, window, cx),
        })
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
            .text_size(px(TextRole::BODY))
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
impl ChatList {
    fn header_shown(&self, section: usize) -> bool {
        SECTIONS[section] != Section::Chats
            || (self.tree.bounds[section] > 0 && self.tree.groups.is_empty())
    }
    /// A project section's label: the name with its chevron right after it,
    /// then, while collapsed, its chat count and most urgent mark in the
    /// trailing column. Enter or a click toggles it; its … and right-click
    /// menus reach collapse and the project's folder.
    fn render_group(
        &mut self,
        ix: IndexPath,
        g: usize,
        window: &mut Window,
        cx: &mut Context<ListState<Self>>,
    ) -> ListItem {
        let group = self.tree.groups[g].clone();
        let key = self.tree.key(Row::Group(g), &self.all);
        let (name, folder) = self.group_name(&group.key);
        let mark = group.collapsed.then(|| group.mark()).flatten();
        let mut spoken = vec![
            if folder { "Folder" } else { "Project" }.to_owned(),
            format!(
                "{} · {} chat{}",
                if group.collapsed {
                    "Collapsed"
                } else {
                    "Expanded"
                },
                group.chats,
                if group.chats == 1 { "" } else { "s" }
            ),
        ];
        if group.collapsed {
            spoken.push(group.rollup.words());
        }
        let spoken = label(&name, spoken.into_iter(), false);
        // A collapsed section's circle fills for its chats' new replies.
        let unread = group.collapsed && group.rollup.unread && !asks_for_look(mark);
        let (shown, previous, t) = self.fade(&key, Glyph::of(mark, unread), window, cx);
        let menu_shown = self.menu_shown(ix, window);
        let menu_built = self.selected == Some(ix)
            || self.hovered.as_deref() == Some(key.as_str())
            || self.menu_row.as_deref() == Some(key.as_str());
        let owner = self.action_owner.clone();
        let list = cx.entity().downgrade();
        let open_id = key.clone();
        let section = group.key.clone();
        let collapsed = group.collapsed;
        let muted = cx.theme().muted_foreground;
        let frame = self.frame(ix, &key, None, GROUP_HEIGHT, cx);
        let row = frame
            .h_flex()
            .items_center()
            .pt(px(GROUP_AIR))
            .child(
                div()
                    .id("sidebar-group-label")
                    .test_support()
                    .flex_1()
                    .min_w_0()
                    .h_flex()
                    .items_center()
                    .gap_1()
                    .text_size(px(TextRole::CAPTION))
                    .font_semibold()
                    .text_color(muted)
                    .when(folder, |d| {
                        d.child(
                            div()
                                .id("sidebar-group-folder")
                                .test_support()
                                .flex_none()
                                .child(AppIcon::Project.inline().size_3()),
                        )
                    })
                    .child(
                        div()
                            .id("sidebar-group-name")
                            .test_support()
                            .min_w_0()
                            .truncate()
                            .child(SharedString::from(name)),
                    )
                    .child(
                        div()
                            .id(SharedString::from(format!("sidebar-group-chevron-{key}")))
                            .test_support()
                            .flex_none()
                            .child(
                                gpui_kit::component::Icon::new(if collapsed {
                                    IconName::ChevronRight
                                } else {
                                    IconName::ChevronDown
                                })
                                .size_3(),
                            ),
                    ),
            )
            .when(collapsed, |d| {
                d.child(
                    div()
                        .id(SharedString::from(format!("sidebar-group-count-{key}")))
                        .test_support()
                        .flex_none()
                        .pl_1()
                        .text_size(px(TextRole::CAPTION))
                        .text_color(muted)
                        .child(SharedString::from(group.chats.to_string())),
                )
            })
            .child(
                div()
                    .id(SharedString::from(format!("chat-menu-slot-{key}")))
                    .relative()
                    .flex_none()
                    .w_8()
                    .h(px(TextRole::BODY))
                    .child(
                        div()
                            .id(SharedString::from(format!("chat-mark-{key}")))
                            .test_support()
                            .absolute()
                            .inset_0()
                            .flex()
                            .items_center()
                            .justify_center()
                            .when(menu_shown, |d| d.opacity(0.))
                            .group_hover("chat-row", |s| s.opacity(0.))
                            .child(state_mark::slot(shown, previous, t, cx)),
                    )
                    .child(
                        div()
                            .absolute()
                            .inset_0()
                            .flex()
                            .items_center()
                            .justify_center()
                            .opacity(if menu_shown { 1. } else { 0. })
                            .group_hover("chat-row", |s| s.opacity(1.))
                            .when(menu_built, |d| {
                                let (owner, section) = (owner.clone(), section.clone());
                                d.child(
                                    crate::ui::icon_action(
                                        SharedString::from(format!("group-menu-{key}")),
                                        "Section actions",
                                        AppIcon::More,
                                        crate::ui::Action::Quiet,
                                    )
                                    .size_8()
                                    .dropdown_menu(move |menu, _, cx| {
                                        group_menu(owner.clone(), &section, collapsed, menu, cx)
                                    })
                                    .on_open_change(
                                        move |open, _, cx| {
                                            if *open {
                                                let _ = list.update(cx, |list, cx| {
                                                    list.delegate_mut().menu_row =
                                                        Some(open_id.clone());
                                                    cx.notify();
                                                });
                                            }
                                        },
                                    ),
                                )
                            }),
                    ),
            );
        let (owner, section) = (self.action_owner.clone(), group.key.clone());
        item(&key, spoken, false).child(
            row.context_menu(move |menu, _, cx| {
                group_menu(owner.clone(), &section, collapsed, menu, cx)
            })
            .into_any_element(),
        )
    }
}

/// A project section's actions: collapse or expand it, and file its project
/// in one of your folders.
fn group_menu(
    owner: WeakEntity<LocalViewer>,
    section: &str,
    collapsed: bool,
    menu: gpui_kit::component::menu::PopupMenu,
    cx: &mut App,
) -> gpui_kit::component::menu::PopupMenu {
    use gpui_kit::component::menu::PopupMenuItem;
    let toggle = {
        let (owner, section) = (owner.clone(), section.to_owned());
        move |_: &gpui_kit::ClickEvent, w: &mut Window, cx: &mut App| {
            let _ = owner.update(cx, |v, cx| v.toggle_sidebar_group(&section, w, cx));
        }
    };
    let menu = menu
        .item(PopupMenuItem::new(if collapsed { "Expand" } else { "Collapse" }).on_click(toggle));
    let Some(project) = section.strip_prefix("project:").map(str::to_owned) else {
        return menu;
    };
    let Some(viewer) = owner.upgrade() else {
        return menu;
    };
    let folders = viewer
        .read(cx)
        .chats
        .read(cx)
        .delegate()
        .memory
        .folders()
        .clone();
    let current = folders.folder_of(&project).map(str::to_owned);
    let file = |folder: Option<String>| {
        let (owner, project) = (owner.clone(), project.clone());
        move |_: &gpui_kit::ClickEvent, w: &mut Window, cx: &mut App| {
            let _ = owner.update(cx, |v, cx| v.file_project(&project, folder.clone(), w, cx));
        }
    };
    let mut menu = menu.separator().label("Folder");
    for name in &folders.names {
        menu = menu.item(
            PopupMenuItem::new(SharedString::from(name.clone()))
                .checked(current.as_deref() == Some(name.as_str()))
                .on_click(file(Some(name.clone()))),
        );
    }
    let (edit, settings) = (owner.clone(), owner.clone());
    // Folders only organize this sidebar; the project's own settings (name,
    // path, workspace) are a separate group that opens Settings.
    menu.item(
        PopupMenuItem::new("No folder")
            .checked(current.is_none())
            .on_click(file(None)),
    )
    .separator()
    .item(
        PopupMenuItem::new("Edit folders…").on_click(move |_, w, cx| {
            let _ = edit.update(cx, |v, cx| v.open_folder_editor(w, cx));
        }),
    )
    .separator()
    .item(
        PopupMenuItem::new("Project settings…").on_click(move |_, w, cx| {
            let _ = settings.update(cx, |v, cx| v.open_project_settings(project.clone(), w, cx));
        }),
    )
}

/// A folder as ~/path when it is under your home folder.
fn tilde(path: &str) -> String {
    static HOME: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    let home = HOME.get_or_init(|| {
        std::env::var("HOME")
            .ok()
            .filter(|h| h.len() > 1)
            .map(|h| h.trim_end_matches('/').to_owned())
    });
    match home.as_deref().and_then(|h| path.strip_prefix(h)) {
        Some("") => "~".to_owned(),
        Some(rest) if rest.starts_with('/') => format!("~{rest}"),
        _ => path.to_owned(),
    }
}
