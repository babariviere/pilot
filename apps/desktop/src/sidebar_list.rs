//! The chat sidebar list: rows from `sidebar_tree`, drawn in the shared Kit
//! list (search, keyboard selection, menus). Mission threads indent one level
//! under their parent; state is a still trailing mark plus words, never dither.
use super::{
    LocalViewer, mission_link, mission_link_focus, mission_mark, mission_segment,
    sidebar_mission_title,
};
use crate::{
    app_icon::AppIcon,
    appearance::{self, Space, TextRole},
    chat_order::{self, SECTIONS, Section},
    local_model::{Chat, MissionAssociation, Project},
    sidebar_memory::Memory,
    sidebar_tree::{self, Row, Tree},
    state_mark::{self, Fade, Mark},
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
const HEADER_HEIGHT: f32 = 26.;
/// A header-less first section keeps a little air above its first row.
const HEADER_GAP: f32 = 4.;
/// Inside a row: the disclosure, a 2pt gap, the Compass, a 6pt gap. Member
/// titles align with their parent's mission name.
const DISCLOSURE: f32 = 12.;
const THREAD_INDENT: f32 = DISCLOSURE + 2. + 12. + 6.;
/// Titles align with the navigation glyph column.
const ROW_INSET: f32 = 7.;
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
    /// Collapsed threads and threads showing their finished members, by mission.
    pub(crate) collapsed: HashSet<String>,
    pub(crate) show_finished: HashSet<String>,
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
            collapsed: HashSet::new(),
            show_finished: HashSet::new(),
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
        let keep = move |c: &Chat| {
            (archived || !c.archived)
                && project
                    .as_ref()
                    .is_none_or(|id| c.project_id.as_ref() == Some(id))
        };
        self.tree = sidebar_tree::build(&sidebar_tree::Input {
            chats: &self.all,
            keep: &keep,
            query: &self.query,
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
            Row::Fold(_) => None,
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
            Row::Chat(_) => None,
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
    /// Opening a member expands its thread.
    pub(crate) fn reveal(&mut self, id: &str) -> bool {
        let Some(chat) = self.all.iter().find(|c| c.id == id) else {
            return false;
        };
        match &chat.mission {
            MissionAssociation::Linked(mission) if !chat.mission_coordinator => {
                self.collapsed.remove(mission.as_str())
            }
            _ => false,
        }
    }
    /// Left/Right on the selected row: collapse or expand a parent, or move
    /// between a member and its parent. None when the key does nothing here.
    pub(crate) fn arrow(&mut self, right: bool) -> Option<IndexPath> {
        let ix = self.selected?;
        let row = self.row(ix)?;
        let thread = self.thread_of(row)?;
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
    fn project_name(&self, chat: Option<&Chat>) -> Option<String> {
        self.project.is_none().then_some(())?;
        let id = chat?.project_id.as_ref()?;
        self.projects
            .iter()
            .find(|p| &p.id == id)
            .map(|p| p.name.clone())
    }
    /// Whether a standalone row has a caption: project, state or mission.
    fn chat_caption(&self, chat: &Chat) -> bool {
        self.project_name(Some(chat)).is_some()
            || !chat_order::row_state(chat).is_empty()
            || mission_mark(chat, |_| None).is_some()
    }
    fn parent_caption(&self, thread: usize) -> bool {
        let t = &self.tree.threads[thread];
        let lead = t.coordinator.or(t.members.first().copied());
        self.project_name(lead.and_then(|c| self.all.get(c)))
            .is_some()
            || (t.collapsed && !t.rollup.counts().is_empty())
    }
    fn fade(
        &mut self,
        key: &str,
        mark: Option<Mark>,
        window: &mut Window,
        cx: &App,
    ) -> (Option<Mark>, Option<Mark>, f32) {
        self.marks
            .entry(key.to_owned())
            .or_default()
            .show(mark, window, cx)
    }
    /// The trailing slot: the mark, swapped for the row's … menu on hover or
    /// keyboard selection. The right-click menu reaches the same actions.
    #[allow(clippy::too_many_arguments)]
    fn trailing(
        &mut self,
        ix: IndexPath,
        key: &str,
        chat: Option<&Chat>,
        mark: Option<Mark>,
        narrow: bool,
        window: &mut Window,
        cx: &mut Context<ListState<Self>>,
    ) -> Observed {
        let (shown, previous, t) = self.fade(key, mark, window, cx);
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
            // overhangs into their state word, which hides with it.
            .map(|d| if narrow { d.w_5() } else { d.w_8() })
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
    fn render_chat(
        &mut self,
        ix: IndexPath,
        chat: Chat,
        window: &mut Window,
        cx: &mut Context<ListState<Self>>,
    ) -> ListItem {
        let mark_state = Mark::of(&chat);
        let unread = self.memory.unread(&chat);
        // RowLine: project (only across all projects), then the state reason.
        // Quiet chats say nothing rather than a raw "idle".
        let project = self.project_name(Some(&chat));
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
            project
                .iter()
                .cloned()
                .chain((!state.is_empty()).then(|| state.clone()))
                .chain(mark.as_ref().map(|m| m.label.clone())),
            unread,
        );
        let state_color = mark_state
            .filter(|m| m.bucket() != Mark::Working)
            .map_or(cx.theme().muted_foreground, |m| m.color(cx));
        let trailing = self.trailing(ix, &chat.id, Some(&chat), mark_state, false, window, cx);
        let height = if self.chat_caption(&chat) {
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
                        unread.then(|| reply(&chat.id, cx)),
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
        item(&chat.id, spoken, self.opened.as_ref() == Some(&chat.id))
            .child(self.menu(row, Some(&chat)))
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
        let unread = coordinator.as_ref().is_some_and(|c| self.memory.unread(c))
            || (t.collapsed && t.rollup.unread);
        let project = self.project_name(lead.as_ref());
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
        spoken.extend(project.clone());
        if expandable {
            spoken.push(format!(
                "{} · {} member{}",
                if t.collapsed { "Collapsed" } else { "Expanded" },
                t.members.len(),
                if t.members.len() == 1 { "" } else { "s" }
            ));
        }
        if t.collapsed && !t.rollup.words().is_empty() {
            spoken.push(t.rollup.words());
        }
        let spoken = label(&title, spoken.into_iter(), unread);
        let word = mark.map(|m| (m.word(), m));
        let accent_color = appearance::accent_mark(cx);
        let trailing = self.trailing(ix, &key, coordinator.as_ref(), mark, true, window, cx);
        let menu = coordinator.is_some().then(|| self.menu_shown(ix, window));
        let caption = project.is_some() || !counts.is_empty();
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
                            .id(SharedString::from(format!(
                                "mission-disclosure-{}",
                                t.mission
                            )))
                            .test_support()
                            .flex_none()
                            .size(px(DISCLOSURE))
                            .mr(px(2.))
                            .flex()
                            .items_center()
                            .justify_center()
                            .text_color(cx.theme().muted_foreground)
                            .when(expandable, |d| {
                                d.cursor_pointer()
                                    .child(
                                        gpui_kit::component::Icon::new(if t.collapsed {
                                            IconName::ChevronRight
                                        } else {
                                            IconName::ChevronDown
                                        })
                                        .size_3(),
                                    )
                                    // The disclosure toggles; it never opens the chat.
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
                                    })
                            }),
                    )
                    .child(
                        div()
                            .id("sidebar-mission-glyph")
                            .test_support()
                            .flex_none()
                            .mr(px(6.))
                            .text_color(accent_color)
                            .child(AppIcon::Coordinator.inline().size_3()),
                    )
                    .child(lane(
                        div()
                            .id("sidebar-mission-title")
                            .test_support()
                            .min_w_0()
                            .truncate()
                            .text_size(px(TextRole::BODY))
                            .font_medium()
                            .when(accent, |d| d.text_color(accent_color))
                            .child(SharedString::from(title)),
                        unread.then(|| reply(&key, cx)),
                    ))
                    .children(word.map(|(word, mark)| state_word(word, mark, menu, cx)))
                    .child(trailing),
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
                        .children(project.map(|p| {
                            div()
                                .min_w_0()
                                .flex_shrink(16.)
                                .truncate()
                                .child(SharedString::from(p))
                        }))
                        .children(counts.into_iter().map(|(mark, n)| {
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
                                .child(state_mark::slot(Some(mark), None, 1., cx))
                                .child(n.to_string())
                        })),
                )
            });
        item(&key, spoken, open).child(self.menu(row, coordinator.as_ref()))
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
        let unread = self.memory.unread(&chat);
        let state = chat_order::row_state(&chat);
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
                .chain([mission]),
            unread,
        );
        let quiet = mark.is_none();
        let trailing = self.trailing(ix, &chat.id, Some(&chat), mark, true, window, cx);
        let menu = Some(self.menu_shown(ix, window));
        let frame = self.frame(ix, &chat.id, Some(&chat), MEMBER_HEIGHT, cx);
        let row = frame
            .h_flex()
            .items_center()
            .child(guide(cx))
            .child(div().flex_none().w(px(THREAD_INDENT)))
            .child(lane(
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
                unread.then(|| reply(&chat.id, cx)),
            ))
            .children(mark.map(|m| state_word(m.word(), m, menu, cx)))
            .child(trailing);
        item(&chat.id, spoken, self.opened.as_ref() == Some(&chat.id))
            .child(self.menu(row, Some(&chat)))
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
                .child(guide(cx))
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
fn state_word(word: &'static str, mark: Mark, menu: Option<bool>, cx: &App) -> Div {
    div()
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
/// The title lane: the title, then the "new reply" dot right after it.
fn lane(title: impl IntoElement, dot: Option<Observed>) -> Div {
    div()
        .flex_1()
        .min_w_0()
        .h_flex()
        .items_center()
        .gap_1p5()
        .child(title)
        .children(dot)
}
/// The small neutral "replied since you looked" dot.
fn reply(key: &str, cx: &App) -> Observed {
    div()
        .id(SharedString::from(format!("chat-reply-{key}")))
        .test_support()
        .flex_none()
        .child(state_mark::reply_dot(cx))
}
/// The thread guide under the parent's Compass.
fn guide(cx: &App) -> Div {
    div()
        .absolute()
        .top_0()
        .bottom_0()
        .left(px(ROW_INSET + DISCLOSURE + 2. + 5.5))
        .w(px(1.))
        .bg(cx.theme().border)
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
        Some(px(match self.row(ix)? {
            Row::Chat(chat) if self.chat_caption(self.all.get(chat)?) => TWO_LINE_HEIGHT,
            Row::Chat(_) => ONE_LINE_HEIGHT,
            Row::Parent(t) if self.parent_caption(t) => TWO_LINE_HEIGHT,
            Row::Parent(_) => PARENT_HEIGHT,
            Row::Member { .. } => MEMBER_HEIGHT,
            Row::Fold(_) => FOLD_HEIGHT,
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
    /// when something sits above it.
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
                .when(shown, |d| d.child(kind.title())),
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
        SECTIONS[section] != Section::Chats || self.tree.bounds[section] > 0
    }
}
