//! Read-only mission page. Navigation and draft ownership remain with LocalViewer.
#[cfg(feature = "native-probes")]
#[path = "mission_activity_probe.rs"]
pub(crate) mod mission_activity_probe;
#[path = "mission_comments_view.rs"]
pub(crate) mod mission_comments_view;
#[path = "mission_decisions_view.rs"]
pub(crate) mod mission_decisions_view;
#[path = "mission_lifecycle_browser.rs"]
mod mission_lifecycle_browser;
#[path = "mission_metadata_browser.rs"]
mod mission_metadata_browser;
#[path = "mission_overview_view.rs"]
mod mission_overview_view;
#[path = "mission_motion.rs"]
pub(crate) mod motion;
#[cfg(test)]
#[path = "mission_browser_view_tests.rs"]
mod tests;
use crate::{
    LocalOptions,
    local_model::{Chat, Project},
    mission_browser::{Catalog, Detail, Home, Key, Members},
    mission_reader::{self, Data, Reader, Route},
    ui::{self, Action, Notice, ResourceLabel, Space, Text, Tone},
};
use gpui_kit::{
    App, AppContext, ClipboardItem, Context, EventEmitter, FocusHandle, InteractiveElement,
    IntoElement, ParentElement, Render, SharedString, StatefulInteractiveElement, Styled, Task,
    TestSupportExt, Window,
    base::SelectableText,
    component::{
        ActiveTheme, Disableable, Selectable, Sizable, StyledExt,
        button::{ButtonGroup, ButtonVariants},
        menu::{DropdownMenu, PopupMenuItem},
    },
    div,
    prelude::FluentBuilder,
    px,
};
use std::sync::Arc;

/// The mission page's sections, as in Swift's mission tab picker. Brief,
/// Activity and Comments open as their own pages.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum Tab {
    #[default]
    Overview,
    Tasks,
}

#[derive(Clone)]
pub(crate) enum Event {
    Open {
        key: Key,
        generation: u64,
    },
    List {
        generation: u64,
    },
    Chat {
        key: Key,
        id: String,
        generation: u64,
    },
}
/// The displayed mission's own coordinator chat, by its detail's exact
/// coordinatorSessionId; never a title or a chat's role flag.
#[derive(Clone, Debug)]
pub(crate) struct Coordinator {
    pub(crate) key: Key,
    pub(crate) id: String,
    /// The cached Local name, else the member list's.
    pub(crate) title: Option<String>,
    /// Opens through the same guarded member-chat link as the Chats rows.
    pub(crate) available: bool,
}
pub(crate) struct Input {
    pub(crate) route: Option<Route>,
    pub(crate) filter: Option<String>,
    pub(crate) projects: Arc<Vec<Project>>,
    pub(crate) chats: Arc<Vec<Chat>>,
    pub(crate) online: bool,
    pub(crate) loaded: bool,
}
pub(crate) struct Browser {
    motion: std::cell::RefCell<motion::Motion>,
    decisions: mission_decisions_view::Disclosure,
    comments: mission_comments_view::Comments,
    pub(crate) generation: u64,
    pub(crate) route: Option<Route>,
    options: Option<LocalOptions>,
    reader: Option<Reader>,
    reader_lane: u64,
    updates: Option<Task<()>>,
    pub(crate) catalog: Option<Arc<Catalog>>,
    pub(crate) detail: Option<Arc<Detail>>,
    members: Result<Arc<Members>, &'static str>,
    pub(crate) error: Option<&'static str>,
    pub(crate) busy: bool,
    catalog_current: bool,
    /// Sidebar names only: the retained Detail was accepted after the Catalog.
    detail_newer: bool,
    /// A chat's linked mission to open once the Catalog lists it.
    jump: Option<Key>,
    /// Why that mission couldn't be opened from the list.
    jump_note: Option<&'static str>,
    projects: Arc<Vec<Project>>,
    chats: Arc<Vec<Chat>>,
    online: bool,
    loaded: bool,
    filter: Option<String>,
    focus: FocusHandle,
    catalog_scroll: gpui_kit::ScrollHandle,
    detail_scroll: gpui_kit::ScrollHandle,
    pub(crate) tasks_browser: gpui_kit::Entity<crate::mission_tasks_view::Pane>,
    /// Overview or Tasks; a different mission opens on Overview.
    pub(crate) tab: Tab,
    pub(crate) activity_browser: Option<gpui_kit::Entity<crate::mission_activity_view::Activity>>,
    activity_open: bool,
    pub(crate) brief: Option<gpui_kit::Entity<crate::mission_brief_view::Workspace>>,
    brief_events: Option<gpui_kit::Subscription>,
    pub(crate) creation: Option<gpui_kit::Entity<crate::mission_create_view::Form>>,
    pub(crate) lifecycle: Vec<gpui_kit::Entity<crate::mission_lifecycle_view::Form>>,
    pub(crate) metadata: Vec<gpui_kit::Entity<crate::mission_metadata_view::Form>>,
}
impl EventEmitter<Event> for Browser {}
impl Browser {
    /// The Local mission's cached name and whether it is current (online),
    /// without reads. The later accepted snapshot wins; a newer complete
    /// catalog without the mission does not fall back to a retained detail's
    /// older name.
    pub(crate) fn sidebar_mission_name(&self, id: &str) -> Option<(&str, bool)> {
        let home = self.local_home();
        let local = |key: &Key| key.id == id && Some(&key.home) == home.as_ref();
        let detail = self
            .detail
            .as_ref()
            .filter(|d| local(&d.key))
            .map(|d| d.title.as_str());
        let row = self
            .catalog
            .as_ref()
            .and_then(|c| c.rows.iter().find(|r| local(&r.key)))
            .map(|r| r.title.as_str());
        let title = if self.detail_newer {
            detail.or(row)
        } else {
            row.or_else(|| detail.filter(|_| self.catalog.as_ref().is_none_or(|c| c.truncated)))
        };
        title.map(|title| (title, self.online))
    }
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    /// The first retained form with unsent input or an unanswered request. Forms are kept
    /// after closing so drafts survive; merely having opened one holds nothing.
    pub(crate) fn update_blocker(&self, cx: &App) -> Option<crate::update_hold::Blocker> {
        use crate::update_hold::Blocker;
        if let Some(hold) = self
            .creation
            .as_ref()
            .and_then(|f| f.read(cx).update_hold(cx))
        {
            return Some(Blocker::NewMission(hold));
        }
        let mission = |key: &Key, hold| Blocker::Mission {
            key: key.clone(),
            hold,
        };
        let lifecycle = self.lifecycle.iter().find_map(|f| {
            let f = f.read(cx);
            f.update_hold().map(|h| mission(&f.source.key, h))
        });
        let metadata = || {
            self.metadata.iter().find_map(|f| {
                let f = f.read(cx);
                f.update_hold(cx).map(|h| mission(&f.source.key, h))
            })
        };
        let brief = || {
            let (key, hold) = self.brief.as_ref()?.read(cx).update_hold()?;
            Some(mission(&key, hold))
        };
        let update = || {
            let activity = self.activity_browser.as_ref()?.read(cx);
            let (key, hold) = activity.update.read(cx).update_hold(cx)?;
            Some(mission(&key, hold))
        };
        lifecycle
            .or_else(metadata)
            .or_else(brief)
            .or_else(update)
            .or_else(|| self.tasks_browser.read(cx).update_blocker(cx))
    }
    pub(crate) fn new(cx: &mut Context<Self>) -> Self {
        let tasks_browser = cx.new(crate::mission_tasks_view::Pane::new);
        Self {
            motion: Default::default(),
            decisions: Default::default(),
            comments: Default::default(),
            tasks_browser,
            tab: Tab::Overview,
            generation: 0,
            route: None,
            options: None,
            reader: None,
            reader_lane: 0,
            updates: None,
            catalog: None,
            detail: None,
            members: Err("Member chats not loaded."),
            error: None,
            busy: false,
            catalog_current: false,
            detail_newer: false,
            jump: None,
            jump_note: None,
            projects: Arc::new(Vec::new()),
            chats: Arc::new(Vec::new()),
            online: false,
            loaded: false,
            filter: None,
            focus: cx.focus_handle(),
            catalog_scroll: gpui_kit::ScrollHandle::default(),
            detail_scroll: gpui_kit::ScrollHandle::default(),
            activity_browser: None,
            activity_open: false,
            brief: None,
            brief_events: None,
            creation: None,
            metadata: Vec::new(),
            lifecycle: Vec::new(),
        }
    }
    pub(crate) fn options(&mut self, options: LocalOptions) {
        self.options = Some(options);
    }
    /// Point the task pane at a mission (or none), reopening its list when the
    /// Tasks tab is showing.
    pub(crate) fn sync_tasks(&mut self, key: Option<Key>, w: &mut Window, cx: &mut Context<Self>) {
        let options = self.options.clone();
        let show = self.tab == Tab::Tasks;
        self.tasks_browser.update(cx, |p, cx| {
            p.sync(key, options, w, cx);
            if show {
                p.show(false, w, cx);
            }
        });
    }
    /// Switch tabs. Showing Tasks reads it once; leaving keeps its snapshot,
    /// selection and drafts. `focus` moves focus into the task list.
    pub(crate) fn choose_tab(
        &mut self,
        tab: Tab,
        focus: bool,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !matches!(self.route, Some(Route::Detail(_))) || self.brief_marked(w, cx) {
            return;
        }
        if tab == Tab::Overview && self.tasks_browser.read(cx).owns_focus(w, cx) {
            self.focus.focus(w, cx);
        }
        self.tab = tab;
        if tab == Tab::Tasks {
            self.tasks_browser.update(cx, |p, cx| p.show(focus, w, cx));
        }
        cx.notify();
    }
    fn open_creation(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if self.route != Some(Route::Catalog) || self.brief_marked(w, cx) {
            return;
        }
        let Some(options) = self.options.clone() else {
            return;
        };
        if self.creation.is_none() {
            if !self.online || !self.loaded {
                return;
            }
            let projects = self.projects.as_ref().clone();
            let form = cx.new(|cx| crate::mission_create_view::Form::new(projects, options, w, cx));
            cx.subscribe_in(
                &form,
                w,
                |v, _, _: &crate::mission_create_view::Close, w, cx| {
                    // Restore a mounted destination before hiding the input subtree.
                    v.focus.focus(w, cx);
                    if let Some(form) = &v.creation {
                        form.update(cx, |f, cx| {
                            f.visible = false;
                            cx.notify();
                        });
                    }
                    cx.notify();
                },
            )
            .detach();
            self.creation = Some(form);
        }
        self.creation.as_ref().unwrap().update(cx, |f, cx| {
            f.visible = true;
            f.focus(w, cx);
            cx.notify();
        });
        cx.notify();
    }
    pub(crate) fn local_home(&self) -> Option<Home> {
        self.options.as_ref().map(|o| Home::local(&o.host()))
    }
    pub(crate) fn contains(&self, key: &Key) -> bool {
        self.catalog
            .as_ref()
            .is_some_and(|c| c.rows.iter().any(|r| &r.key == key))
    }
    pub(crate) fn current(&self, generation: u64) -> bool {
        self.generation == generation && !self.busy && self.error.is_none() && self.route.is_some()
    }
    pub(crate) fn can_open(&self, key: &Key, generation: u64) -> bool {
        self.current(generation)
            && self.online
            && self.catalog_current
            && self.route == Some(Route::Catalog)
            && self.local_home().as_ref().is_some_and(|local| {
                self.catalog.as_ref().is_some_and(|c| {
                    c.rows
                        .iter()
                        .any(|r| &r.key == key && r.in_scope(local, self.filter.as_deref()))
                })
            })
    }
    /// Opens a chat's linked mission once the current Catalog lists it, or
    /// says why it can't. The Catalog route must already be showing.
    pub(crate) fn open_when_listed(&mut self, key: Key, cx: &mut Context<Self>) {
        self.jump = Some(key);
        self.jump_note = None;
        if !self.busy && self.catalog_current {
            self.resolve_jump(cx);
        }
        cx.notify();
    }
    fn resolve_jump(&mut self, cx: &mut Context<Self>) {
        let Some(key) = self.jump.take() else {
            return;
        };
        if self.can_open(&key, self.generation) {
            cx.emit(Event::Open {
                key,
                generation: self.generation,
            });
        } else if self.error.is_none() && self.route == Some(Route::Catalog) {
            self.jump_note = Some("This chat's mission isn't in this mission list.");
        }
    }
    pub(crate) fn can_link(&self, key: &Key, id: &str, generation: u64) -> bool {
        self.current(generation)
            && self.online
            && self.loaded
            && self.local_home().as_ref() == Some(&key.home)
            && self.route == Some(Route::Detail(key.clone()))
            && self.detail.as_ref().is_some_and(|d| {
                &d.key == key
                    && self.members.as_ref().is_ok_and(|m| m.ids.contains(id))
                    && self.chats.iter().any(|c| {
                        c.id == id && !c.local_draft && c.project_id.as_deref() == Some(&d.project)
                    })
            })
    }
    /// The coordinator of the mission on screen, while its detail is the route's.
    pub(crate) fn coordinator(&self) -> Option<Coordinator> {
        let d = self
            .detail
            .as_ref()
            .filter(|d| self.route == Some(Route::Detail(d.key.clone())))?;
        let id = d.coordinator.clone()?;
        let title = self
            .chats
            .iter()
            .find(|c| c.id == id && !c.local_draft)
            .map(|c| c.title.clone())
            .or_else(|| {
                let m = self.members.as_ref().ok()?;
                m.rows.iter().find(|r| r.id == id).map(|r| r.title.clone())
            });
        Some(Coordinator {
            available: self.can_link(&d.key, &id, self.generation),
            key: d.key.clone(),
            id,
            title,
        })
    }
    /// Asks LocalViewer to open the coordinator, only if it is still exactly
    /// the displayed mission's available coordinator for this generation.
    pub(crate) fn open_coordinator(
        &mut self,
        key: &Key,
        id: &str,
        generation: u64,
        cx: &mut Context<Self>,
    ) -> bool {
        let exact = self.coordinator().is_some_and(|c| {
            c.available && &c.key == key && c.id == id && self.generation == generation
        });
        if exact {
            cx.emit(Event::Chat {
                key: key.clone(),
                id: id.to_owned(),
                generation,
            });
        }
        exact
    }
    /// Beside the title, as in Swift: the coordinator is the chat people open
    /// most from a mission. Hidden when none is assigned (Chats says so);
    /// disabled, with the reason in its name, when it can't be opened here.
    fn coordinator_action(&self, cx: &Context<Self>) -> Option<gpui_kit::AnyElement> {
        let c = self.coordinator()?;
        let generation = self.generation;
        let (label, tooltip) = match (&c.title, c.available) {
            (Some(t), true) => ("Open coordinator", format!("Open coordinator · {t}")),
            (None, true) => ("Open coordinator", "Open coordinator".to_owned()),
            (Some(t), false) => (
                "Coordinator unavailable",
                format!("Coordinator unavailable · {t}"),
            ),
            (None, false) => (
                "Coordinator unavailable",
                "Coordinator unavailable".to_owned(),
            ),
        };
        let Coordinator { key, id, .. } = c;
        Some(
            ui::icon_action(
                "mission-open-coordinator",
                label,
                crate::app_icon::AppIcon::Coordinator,
                Action::Quiet,
            )
            .tooltip(SharedString::from(tooltip))
            .disabled(!c.available)
            .on_click(cx.listener(move |v, _, _, cx| {
                v.open_coordinator(&key, &id, generation, cx);
            }))
            .into_any_element(),
        )
    }
    pub(crate) fn focus(&self, w: &mut Window, cx: &mut App) {
        if let Some(f) = self.lifecycle.iter().find(|f| f.read(cx).visible) {
            let focus = f.read(cx).focus_handle();
            focus.focus(w, cx);
            return;
        }
        if let Some(form) = self.metadata.iter().find(|f| f.read(cx).visible) {
            let focus = form.read(cx).focus_handle(cx);
            focus.focus(w, cx);
            return;
        }
        if let Some(form) = self.creation.as_ref().filter(|f| f.read(cx).visible) {
            let focus = form.read(cx).focus_handle(cx);
            focus.focus(w, cx);
            return;
        }
        if self.activity_open
            && let Some(activity) = &self.activity_browser
        {
            let focus = activity.read(cx).focus_handle();
            focus.focus(w, cx);
            return;
        }
        self.focus.focus(w, cx);
    }
    pub(crate) fn sync(&mut self, input: Input, w: &mut Window, cx: &mut Context<Self>) {
        let Input {
            route,
            filter,
            projects,
            chats,
            online,
            loaded,
        } = input;
        let changed = self.filter != filter
            || !Arc::ptr_eq(&self.projects, &projects)
            || self.link_availability_changed(&chats)
            || self.online != online
            || self.loaded != loaded;
        if self.filter != filter {
            self.catalog_scroll
                .set_offset(gpui_kit::point(px(0.), px(0.)));
        }
        self.filter = filter;
        self.projects = projects;
        self.chats = chats;
        self.online = online;
        self.loaded = loaded;
        if let Some(activity) = &self.activity_browser
            && !Arc::ptr_eq(&activity.read(cx).chats, &self.chats)
        {
            let chats = self.chats.clone();
            activity.update(cx, |v, cx| {
                v.chats = chats;
                cx.notify();
            });
        }
        if self.activity_open && (!online || self.route != route) {
            self.hide_activity(w, cx);
            if self.route == route {
                self.focus(w, cx);
            }
        }
        if self.route != route {
            if self.decisions.opened && self.focus.contains_focused(w, cx) {
                self.focus.focus(w, cx);
            }
            self.decisions = Default::default();
            self.comments = Default::default();
            let owned = self
                .metadata
                .iter()
                .any(|f| f.read(cx).visible && f.read(cx).owns_focus(w, cx));
            self.hide_lifecycle(w, cx);
            self.hide_metadata(cx);
            if owned {
                self.focus.focus(w, cx);
            }
            if let Some(form) = &self.creation {
                form.update(cx, |v, cx| {
                    v.visible = false;
                    cx.notify();
                });
                self.focus.focus(w, cx);
            }
            self.route = route;
            self.tab = Tab::Overview;
            self.jump = None;
            self.read(w, cx);
        } else if changed {
            cx.notify();
        }
        let source = self.brief_source();
        for form in &self.lifecycle {
            let available = self.online
                && self.current(self.generation)
                && self.catalog_current
                && source.as_ref().is_some_and(|s| {
                    self.catalog.as_ref().is_some_and(|c| s.canonical(c))
                        && self
                            .options
                            .as_ref()
                            .is_some_and(|o| form.read(cx).matches(s, o))
                });
            form.update(cx, |f, cx| {
                if f.available != available {
                    f.available = available;
                    cx.notify();
                }
            });
        }
        if let Some(brief) = &self.brief {
            brief.update(cx, |v, cx| v.sync(source.as_ref(), self.online, cx));
        }
    }
    fn brief_source(&self) -> Option<crate::mission_brief::Source> {
        let Some(Route::Detail(key)) = &self.route else {
            return None;
        };
        let d = self.detail.as_ref().filter(|d| &d.key == key)?;
        if self.local_home().as_ref() != Some(&key.home) {
            return None;
        }
        Some(crate::mission_brief::Source {
            key: key.clone(),
            project: d.project.clone(),
        })
    }
    pub(crate) fn brief_marked(&mut self, w: &mut Window, cx: &mut Context<Self>) -> bool {
        self.metadata_marked(w, cx)
            || self
                .creation
                .as_ref()
                .is_some_and(|f| f.update(cx, |v, cx| v.marked(w, cx)))
            || self
                .brief
                .as_ref()
                .is_some_and(|brief| brief.update(cx, |v, cx| v.visible && v.marked(w, cx)))
            || self.tasks_browser.update(cx, |v, cx| v.marked(w, cx))
            || (self.activity_open
                && self
                    .activity_browser
                    .as_ref()
                    .is_some_and(|a| a.update(cx, |a, cx| a.marked(w, cx))))
    }
    pub(crate) fn open_brief(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if self.busy || self.error.is_some() || !self.online || self.brief_marked(w, cx) {
            return;
        }
        let (Some(options), Some(source)) = (self.options.clone(), self.brief_source()) else {
            return;
        };
        self.hide_lifecycle(w, cx);
        self.hide_metadata(cx);
        if let Some(brief) = &self.brief {
            if !brief.read(cx).matches_options(&options) {
                self.error = Some(
                    "This brief belongs to a different connection. Your drafts are kept; reopen the window to switch.",
                );
                cx.notify();
                return;
            }
        } else {
            let brief = cx.new(|cx| crate::mission_brief_view::Workspace::new(options, w, cx));
            self.brief_events = Some(cx.subscribe_in(
                &brief,
                w,
                |v, _, _: &crate::mission_brief_view::Event, w, cx| {
                    if let Some(brief) = &v.brief {
                        let owned = brief.read(cx).owns_focus(w, cx);
                        if brief.update(cx, |b, cx| b.marked(w, cx)) {
                            return;
                        }
                        brief.update(cx, |b, cx| b.hide(cx));
                        let key = v.brief_source().map(|s| s.key).filter(|key| {
                            v.catalog.as_ref().is_some_and(|c| {
                                c.rows
                                    .iter()
                                    .any(|r| r.key == *key && r.local_definition(&key.home))
                            })
                        });
                        v.sync_tasks(key, w, cx);
                        if owned {
                            v.focus(w, cx);
                        }
                    }
                    cx.notify();
                },
            ));
            self.brief = Some(brief);
        }
        let title: SharedString = self
            .detail
            .as_ref()
            .map(|d| d.title.clone())
            .unwrap_or_default()
            .into();
        if self.activity_open {
            self.hide_activity(w, cx);
        }
        if let Some(brief) = &self.brief
            && brief.update(cx, |v, cx| v.show(source, title, self.online, w, cx))
        {
            self.sync_tasks(None, w, cx);
        }
        cx.notify();
    }
    fn link_availability_changed(&self, chats: &[Chat]) -> bool {
        let (Some(d), Ok(m)) = (&self.detail, &self.members) else {
            return false;
        };
        // Link eligibility and live state (member rows, Needs you) of members only.
        fn view<'a>(
            rows: &'a [Chat],
            ids: &std::collections::HashSet<String>,
            project: &str,
        ) -> Vec<(&'a str, bool, Option<&'a str>, bool)> {
            rows.iter()
                .filter(|c| ids.contains(&c.id))
                .map(|c| {
                    (
                        c.id.as_str(),
                        !c.local_draft && c.project_id.as_deref() == Some(project),
                        c.row_reason(),
                        c.archived,
                    )
                })
                .collect()
        }
        view(&self.chats, &m.ids, &d.project) != view(chats, &m.ids, &d.project)
    }
    pub(crate) fn accept(&mut self, response: mission_reader::Response, cx: &mut Context<Self>) {
        if response.generation != self.generation || self.route.as_ref() != Some(&response.route) {
            return;
        }
        self.busy = false;
        match response.result {
            Err(e) => {
                self.error = Some(e);
                self.jump = None;
                if response.route == Route::Catalog {
                    self.catalog_current = false;
                }
            }
            Ok(Data::Catalog(c)) if response.route == Route::Catalog => {
                self.catalog = Some(c);
                self.catalog_current = true;
                self.detail_newer = false;
                self.error = None;
                self.resolve_jump(cx);
            }
            Ok(Data::Detail(d, m)) if response.route == Route::Detail(d.key.clone()) => {
                self.decisions.reconcile(&d);
                self.comments.reconcile(&d);
                self.detail = Some(d);
                self.detail_newer = true;
                self.members = m;
                self.error = None;
            }
            _ => self.error = Some("The mission changed. Refresh to see it."),
        }
        cx.notify();
    }
    fn read(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if self.activity_open {
            self.hide_activity(w, cx);
            self.focus(w, cx);
        }
        let tasks_key = match &self.route {
            Some(Route::Detail(key))
                if self.local_home().as_ref().is_some_and(|h| {
                    self.catalog.as_ref().is_some_and(|c| {
                        c.rows
                            .iter()
                            .any(|r| &r.key == key && r.local_definition(h))
                    })
                }) =>
            {
                Some(key.clone())
            }
            _ => None,
        };
        if self.tasks_browser.read(cx).state.key != tasks_key
            && self.tasks_browser.read(cx).owns_focus(w, cx)
        {
            self.focus.focus(w, cx);
        }
        self.sync_tasks(tasks_key, w, cx);
        self.generation = self.generation.saturating_add(1);
        self.error = None;
        self.jump_note = None;
        self.busy = false;
        if let Some(Route::Detail(key)) = &self.route {
            if self.detail.as_ref().is_some_and(|d| &d.key != key) {
                self.detail = None;
                self.detail_scroll
                    .set_offset(gpui_kit::point(px(0.), px(0.)));
                self.members = Err("Member chats not loaded.");
            }
            let local = self.local_home();
            if local.as_ref().is_none_or(|h| {
                !self.catalog.as_ref().is_some_and(|c| {
                    c.rows
                        .iter()
                        .any(|r| &r.key == key && r.local_definition(h))
                })
            }) {
                self.detail = None;
                self.members = Err("Member chats are unavailable.");
                self.error = Some("This mission lives elsewhere and can't be opened here.");
                if let Some(reader) = &self.reader {
                    reader.request(mission_reader::Request {
                        generation: self.generation,
                        route: None,
                    });
                }
                cx.notify();
                return;
            }
        }
        if self.route.is_none() {
            if let Some(r) = &self.reader {
                r.request(mission_reader::Request {
                    generation: self.generation,
                    route: None,
                });
            }
            cx.notify();
            return;
        }
        let Some(options) = self.options.clone() else {
            self.error = Some("Missions aren't available in this view.");
            cx.notify();
            return;
        };
        if self.reader.is_none() {
            match Reader::start(options) {
                Err(e) => {
                    self.error = Some(e);
                    cx.notify();
                    return;
                }
                Ok((reader, updates)) => {
                    self.reader_lane = self.reader_lane.saturating_add(1);
                    let lane = self.reader_lane;
                    self.reader = Some(reader);
                    self.updates = Some(cx.spawn_in(w, async move |view, cx| {
                        while let Ok(response) = updates.recv().await {
                            if view
                                .update(cx, |view, cx| view.accept(response, cx))
                                .is_err()
                            {
                                return;
                            }
                        }
                        let _ = view.update(cx, |view, cx| view.reader_stopped(lane, cx));
                    }));
                }
            }
        }
        if self.reader.as_ref().is_some_and(|r| {
            r.request(mission_reader::Request {
                generation: self.generation,
                route: self.route.clone(),
            })
        }) {
            self.busy = true;
        } else {
            self.error = Some("Couldn't request missions. Refresh to try again.");
        }
        cx.notify();
    }
    fn reader_stopped(&mut self, lane: u64, cx: &mut Context<Self>) {
        if lane != self.reader_lane {
            return;
        }
        self.reader = None;
        self.busy = false;
        if self.route.is_some() {
            self.error.get_or_insert(
                "Couldn't load the mission. What's shown may be out of date; refresh to try again.",
            );
            if self.route == Some(Route::Catalog) {
                self.catalog_current = false;
            }
        }
        cx.notify();
    }
    #[cfg(feature = "native-probes")]
    pub(crate) fn disconnect_probe(&self) {
        if let Some(reader) = &self.reader {
            reader.disconnect_fixture();
        }
    }
    fn project_name(&self, id: &str) -> String {
        self.projects
            .iter()
            .find(|p| p.id == id)
            .map(|p| format!("{} · {}", p.name, id))
            .unwrap_or_else(|| format!("Project unavailable · {id}"))
    }
    fn hide_activity(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        self.activity_open = false;
        if let Some(activity) = &self.activity_browser {
            activity.update(cx, |v, cx| v.hide(cx));
        }
        let key = self
            .detail
            .as_ref()
            .filter(|d| {
                self.route == Some(Route::Detail(d.key.clone()))
                    && self.local_home().as_ref() == Some(&d.key.home)
            })
            .map(|d| d.key.clone());
        self.sync_tasks(key, w, cx);
    }
    /// Secondary overview commands live in one … menu beside Refresh.
    fn overview_menu(&self, generation: u64, cx: &Context<Self>) -> Option<gpui_kit::AnyElement> {
        let d = self
            .detail
            .as_ref()
            .filter(|d| self.route == Some(Route::Detail(d.key.clone())))?;
        let weak = cx.weak_entity();
        let enabled = self.online && self.current(generation);
        let status = d.status.clone();
        let key = d.key.clone();
        let goal = (!d.goal.is_empty()).then(|| d.goal.clone());
        Some(
            ui::icon_action(
                "mission-more",
                "More",
                crate::app_icon::AppIcon::More,
                Action::Quiet,
            )
            .dropdown_menu(move |mut menu, _, _| {
                let edit = weak.clone();
                menu = menu.item(PopupMenuItem::new("Edit…").disabled(!enabled).on_click(
                    move |_, w, cx| {
                        let _ = edit.update(cx, |v, cx| {
                            if v.generation == generation {
                                v.open_metadata(w, cx);
                            }
                        });
                    },
                ));
                let activity = weak.clone();
                let activity_key = key.clone();
                menu = menu.item(PopupMenuItem::new("Activity").disabled(!enabled).on_click(
                    move |_, w, cx| {
                        let _ = activity.update(cx, |v, cx| {
                            v.open_activity(&activity_key, generation, w, cx)
                        });
                    },
                ));
                for (action, label) in [
                    (
                        crate::mission_lifecycle::Action::Archive,
                        "Archive mission…",
                    ),
                    (crate::mission_lifecycle::Action::Reopen, "Reopen mission…"),
                ] {
                    if action.allowed(&status) {
                        let lifecycle = weak.clone();
                        menu = menu.item(PopupMenuItem::new(label).disabled(!enabled).on_click(
                            move |_, w, cx| {
                                let _ = lifecycle.update(cx, |v, cx| {
                                    if v.generation == generation {
                                        v.open_lifecycle(action, w, cx);
                                    }
                                });
                            },
                        ));
                    }
                }
                if let Some(text) = goal.clone() {
                    let copy = weak.clone();
                    let copy_key = key.clone();
                    menu = menu.item(PopupMenuItem::new("Copy goal").on_click(move |_, _, cx| {
                        let _ = copy.update(cx, |v, cx| {
                            if v.generation == generation
                                && v.route == Some(Route::Detail(copy_key.clone()))
                            {
                                cx.write_to_clipboard(ClipboardItem::new_string(text.clone()));
                            }
                        });
                    }));
                }
                menu
            })
            .into_any_element(),
        )
    }
    fn open_activity(
        &mut self,
        key: &Key,
        generation: u64,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.current(generation)
            || self.brief_marked(w, cx)
            || !self.online
            || self.route != Some(Route::Detail(key.clone()))
            || self.local_home().as_ref() != Some(&key.home)
            || !self.detail.as_ref().is_some_and(|d| &d.key == key)
        {
            return;
        }
        let Some(options) = self.options.clone() else {
            return;
        };
        self.hide_lifecycle(w, cx);
        self.hide_metadata(cx);
        if let Some(brief) = &self.brief {
            brief.update(cx, |b, cx| b.hide(cx));
        }
        if self.activity_browser.is_none() {
            let activity = cx.new(crate::mission_activity_view::Activity::new);
            cx.subscribe_in(
                &activity,
                w,
                |v, _, _: &crate::mission_activity_view::Close, w, cx| {
                    v.hide_activity(w, cx);
                    v.focus(w, cx);
                    cx.notify();
                },
            )
            .detach();
            cx.subscribe_in(
                &activity,
                w,
                |v, activity, e: &crate::mission_activity_view::OpenChat, _, cx| {
                    let Some(key) = activity.read(cx).state.key.clone() else {
                        return;
                    };
                    let generation = v.generation;
                    if v.can_link(&key, &e.0, generation) {
                        cx.emit(Event::Chat {
                            key,
                            id: e.0.clone(),
                            generation,
                        });
                    }
                },
            )
            .detach();
            self.activity_browser = Some(activity);
        }
        self.activity_open = true;
        let chats = self.chats.clone();
        self.activity_browser
            .as_ref()
            .unwrap()
            .update(cx, |v, _| v.chats = chats);
        self.sync_tasks(None, w, cx);
        let title = self.detail.as_ref().unwrap().title.clone();
        self.activity_browser
            .as_ref()
            .unwrap()
            .update(cx, |v, cx| v.open(key.clone(), title, options, w, cx));
        cx.notify();
    }
    fn plain(&self, id: &'static str, text: String) -> impl IntoElement {
        let focus = self.focus.clone();
        div()
            .id(id)
            .test_support()
            .w_full()
            .min_w_0()
            .on_mouse_down(gpui_kit::MouseButton::Left, move |_, w, cx| {
                focus.focus(w, cx)
            })
            .child(SelectableText::new(
                SharedString::from(format!("{id}-{}", self.generation)),
                SharedString::from(text),
            ))
    }
    fn snapshot_note(&self) -> Option<&'static str> {
        if self.busy {
            Some("Loading…")
        } else if self.error.is_some() {
            Some("Couldn't refresh · may be out of date")
        } else if !self.online {
            Some("Offline · may be out of date")
        } else {
            None
        }
    }
}
impl Render for Browser {
    fn render(&mut self, w: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let key = match &self.route {
            Some(Route::Detail(key)) => Some(key),
            _ => None,
        };
        self.motion.borrow_mut().enter(key);
        let open = self.brief.as_ref().is_some_and(|b| b.read(cx).visible);
        let overview =
            self.tab == Tab::Overview && !open && !self.activity_open && !self.comments.open;
        let ids: Vec<_> = self
            .detail
            .as_ref()
            .filter(|d| overview && Some(&d.key) == key)
            .into_iter()
            .flat_map(|d| {
                d.summary
                    .blocked
                    .iter()
                    .take(mission_overview_view::SECTION_ROWS)
                    .chain(
                        d.summary
                            .working
                            .iter()
                            .take(mission_overview_view::SECTION_ROWS),
                    )
            })
            .map(|t| t.id.as_str())
            .collect();
        self.motion
            .borrow_mut()
            .retain_rows(&ids, &self.focus, w, cx);
        if !overview {
            self.motion.borrow_mut().hide_overview();
        }
        let child = self.render_page(w, cx);
        motion::Brief {
            reveal: self.motion.borrow().brief.clone(),
            open,
            child,
        }
    }
}
impl Browser {
    fn render_page(&mut self, w: &mut Window, cx: &mut Context<Self>) -> gpui_kit::AnyElement {
        if let Some(form) = self.lifecycle.iter().find(|f| f.read(cx).visible) {
            return div()
                .id("missions-page")
                .test_support()
                .track_focus(&self.focus)
                .size_full()
                .min_w_0()
                .min_h_0()
                .overflow_y_scroll()
                .child(ui::page().child(form.clone()))
                .into_any_element();
        }
        if let Some(form) = self.metadata.iter().find(|f| f.read(cx).visible) {
            return div()
                .id("missions-page")
                .test_support()
                .track_focus(&self.focus)
                .size_full()
                .min_w_0()
                .min_h_0()
                .overflow_y_scroll()
                .child(ui::page().child(form.clone()))
                .into_any_element();
        }
        if let Some(form) = self.creation.as_ref().filter(|f| f.read(cx).visible) {
            return div()
                .id("missions-page")
                .test_support()
                .track_focus(&self.focus)
                .size_full()
                .min_w_0()
                .min_h_0()
                .overflow_y_scroll()
                .child(ui::page().child(form.clone()))
                .into_any_element();
        }
        if self.activity_open
            && let Some(activity) = &self.activity_browser
        {
            return div().size_full().child(activity.clone()).into_any_element();
        }
        if self.comments.open {
            return self.comments_page(cx);
        }
        if let Some(brief) = self.brief.as_ref().filter(|b| b.read(cx).visible) {
            return div()
                .id("missions-page")
                .test_support()
                .track_focus(&self.focus)
                .size_full()
                .min_w_0()
                .min_h_0()
                .child(brief.clone())
                .into_any_element();
        }
        let generation = self.generation;
        let is_list = self.route == Some(Route::Catalog);
        let title = if is_list {
            "Missions".to_owned()
        } else {
            self.detail
                .as_ref()
                .filter(|d| self.route == Some(Route::Detail(d.key.clone())))
                .map(|d| d.title.clone())
                .or_else(|| {
                    self.catalog.as_ref().and_then(|c| {
                        c.rows
                            .iter()
                            .find(|r| self.route == Some(Route::Detail(r.key.clone())))
                            .map(|r| r.title.clone())
                    })
                })
                .unwrap_or_else(|| "Mission overview".into())
        };
        // A mission's back action and centred tabs share one full-width row,
        // so neither moves when the Tasks tab widens the page below it.
        let top = (!is_list).then(|| {
            div()
                .h_flex()
                .items_center()
                .w_full()
                .min_w_0()
                .flex_none()
                .px(px(Space::HOME))
                .pt(px(Space::HOME))
                .child(
                    div().flex_1().min_w_0().h_flex().child(
                        ui::action("missions-list", "Missions", Action::Quiet)
                            .icon(crate::app_icon::AppIcon::Back.asset())
                            .on_click(cx.listener(move |v, _, _, cx| {
                                if v.generation == generation {
                                    cx.emit(Event::List { generation });
                                }
                            })),
                    ),
                )
                .child(self.tab_bar(cx))
                .child(div().flex_1())
        });
        let mut content = ui::page()
            .gap(px(Space::CONTROL))
            .when(!is_list, |v| v.pt(px(Space::CONTROL)))
            .child(
                div()
                    .h_flex()
                    .items_center()
                    .gap_2()
                    .min_w_0()
                    .child(
                        div().flex_1().min_w_0().child(
                            ui::text(Text::Title, SharedString::from(title))
                                .id("missions-title")
                                .test_support(),
                        ),
                    )
                    .when(!is_list, |d| d.children(self.coordinator_action(cx)))
                    .when(is_list || self.tab != Tab::Tasks, |d| {
                        d.child(
                            ui::icon_action(
                                "missions-refresh",
                                "Refresh",
                                crate::app_icon::AppIcon::Retry,
                                Action::Quiet,
                            )
                            .disabled(self.options.is_none() || self.busy)
                            .on_click(cx.listener(
                                move |v, _, w, cx| {
                                    if v.generation == generation {
                                        v.read(w, cx);
                                    }
                                },
                            )),
                        )
                    })
                    .when(!is_list, |d| d.children(self.overview_menu(generation, cx)))
                    .when(is_list, |d| {
                        d.child(
                            ui::action("missions-new", "New mission…", Action::Secondary)
                                .disabled(
                                    self.options.is_none()
                                        || (!self.online && self.creation.is_none()),
                                )
                                .on_click(cx.listener(|v, _, w, cx| v.open_creation(w, cx))),
                        )
                    }),
            )
            .children(self.snapshot_note().map(|note| {
                ui::text(Text::Caption, note)
                    .id("missions-snapshot-note")
                    .test_support()
            }));
        if !self.online {
            content = content.child(
                Notice::new("Not connected. You can read this, but chat links need a connection.")
                    .tone(Tone::Warning),
            );
        }
        if let Some(note) = self.jump_note.filter(|_| is_list) {
            content = content.child(
                div()
                    .id("missions-jump-note")
                    .test_support()
                    .child(Notice::new(note).tone(Tone::Warning)),
            );
        }
        if let Some(error) = self.error {
            content = content.child(
                div()
                    .id("missions-error")
                    .test_support()
                    .child(Notice::new(error).tone(Tone::Error)),
            );
        }
        if !is_list && self.tab == Tab::Tasks {
            // The header keeps its reading column so the tabs stay put; the
            // task list and details below take the page's full width and height.
            return div()
                .id("missions-page")
                .test_support()
                .track_focus(&self.focus)
                .size_full()
                .min_w_0()
                .min_h_0()
                .v_flex()
                .on_action(cx.listener(Self::copy_selection))
                .children(top)
                .child(content.flex_none().max_w_full().pb(px(Space::CONTROL)))
                .child(
                    div()
                        .id("mission-tasks-tab")
                        .test_support()
                        .flex_1()
                        .min_h_0()
                        .w_full()
                        .min_w_0()
                        .px(px(Space::HOME))
                        .pb(px(Space::HOME))
                        .child(self.tasks_browser.clone()),
                )
                .into_any_element();
        }
        if is_list {
            let scope = self
                .filter
                .as_ref()
                .map(|id| self.project_name(id))
                .unwrap_or_else(|| "All projects".into());
            content = content.child(
                ui::text(Text::Caption, SharedString::from(scope))
                    .id("missions-scope")
                    .test_support(),
            );
            if let Some(catalog) = &self.catalog {
                let local = self.local_home();
                let rows: Vec<_> = catalog
                    .rows
                    .iter()
                    .filter(|r| {
                        local
                            .as_ref()
                            .is_some_and(|h| r.in_scope(h, self.filter.as_deref()))
                    })
                    .collect();
                if catalog.truncated {
                    content = content.child(
                        Notice::new(SharedString::from(format!(
                            "{} of {} missions received. Some project associations may be missing.",
                            catalog.rows.len(),
                            catalog.total
                        )))
                        .tone(Tone::Warning),
                    );
                }
                if rows.is_empty() {
                    content = content.child(Notice::new(if self.catalog_current {
                        "No missions yet."
                    } else {
                        "Couldn't load missions."
                    }));
                }
                for r in rows {
                    let key = r.key.clone();
                    let detail = format!(
                        "{}{}{}",
                        capitalized(&r.status),
                        if local.as_ref() == Some(&key.home) {
                            ""
                        } else {
                            " · Can't open here"
                        },
                        r.counts
                            .map(|(d, t)| format!(" · {d} of {t} tasks done"))
                            .unwrap_or_default()
                    );
                    content = content.child(
                        ui::action(
                            SharedString::from(format!("mission-row-{}", key.tag())),
                            "",
                            Action::Quiet,
                        )
                        .w_full()
                        .h(px(54.))
                        .justify_start()
                        .disabled(
                            !self.online || !self.current(generation) || !self.catalog_current,
                        )
                        .child(
                            ResourceLabel::new(SharedString::from(r.title.clone()))
                                .detail(SharedString::from(detail))
                                .icon(crate::app_icon::AppIcon::Mission),
                        )
                        .on_click(cx.listener(move |v, _, _, cx| {
                            if v.can_open(&key, generation) {
                                cx.emit(Event::Open {
                                    key: key.clone(),
                                    generation,
                                });
                            }
                        })),
                    );
                }
            } else if !self.busy && self.error.is_none() {
                content =
                    content.child(Notice::new("Missions aren't loaded. Refresh to load them."));
            }
        } else if let Some(d) = self
            .detail
            .as_ref()
            .filter(|d| self.route == Some(Route::Detail(d.key.clone())))
        {
            // Goal, one meta line and progress, then what needs the user and
            // what is working. Edit, Activity, Archive/Reopen and Copy goal
            // live in the title's … menu.
            content = content.child(
                div()
                    .v_flex()
                    .w_full()
                    .min_w_0()
                    .gap(px(Space::CONTROL))
                    .child(self.plain(
                        "mission-goal",
                        if d.goal.is_empty() {
                            "No goal saved.".into()
                        } else {
                            d.goal.clone()
                        },
                    ))
                    .child(
                        ui::text(Text::Caption, SharedString::from(self.meta_line(d)))
                            .id("mission-meta")
                            .test_support()
                            .text_color(cx.theme().muted_foreground),
                    )
                    .children(self.progress_view(d, w, cx)),
            );
            content = content
                .child(self.decisions_view(cx))
                .children(self.needs_you_view(d, cx))
                .children(self.working_view(&d.summary, cx));
            content = content.child(ui::heading(
                "mission-chats-heading",
                "Chats",
                Text::Headline,
            ));
            if d.coordinator.is_none() {
                content = content.child(
                    ui::text(Text::Caption, "No coordinator chat is assigned.")
                        .id("mission-no-coordinator")
                        .test_support(),
                );
            }
            match &self.members {
                Err(e) => content = content.child(Notice::new(*e).tone(Tone::Warning)),
                Ok(m) => {
                    if m.rows.len() < m.total {
                        content = content.child(ui::text(
                            Text::Caption,
                            SharedString::from(format!(
                                "{} of {} member chats shown",
                                m.rows.len(),
                                m.total
                            )),
                        ));
                    }
                    for member in &m.rows {
                        let key = d.key.clone();
                        let id = member.id.clone();
                        let enabled = self.can_link(&key, &id, generation);
                        let role = if d.coordinator.as_ref() == Some(&id) {
                            "Coordinator"
                        } else {
                            "Member"
                        };
                        // Live Local state, as on the chat's sidebar row.
                        let state = self
                            .chats
                            .iter()
                            .find(|c| c.id == id && !c.local_draft)
                            .and_then(|c| c.row_reason())
                            .map(|r| format!(" · {}", capitalized(r)))
                            .unwrap_or_default();
                        let label = format!(
                            "{role}{}{state}{}",
                            if member.archived { " · Archived" } else { "" },
                            if enabled {
                                ""
                            } else {
                                " · Not in the Local chat list"
                            }
                        );
                        content = content.child(
                            ui::action(
                                SharedString::from(format!("mission-chat-{id}")),
                                "",
                                Action::Quiet,
                            )
                            .w_full()
                            .h(px(54.))
                            .justify_start()
                            .disabled(!enabled)
                            .child(
                                ResourceLabel::new(SharedString::from(member.title.clone()))
                                    .detail(SharedString::from(label))
                                    .icon(crate::app_icon::AppIcon::Chats),
                            )
                            .on_click(cx.listener(
                                move |v, _, _, cx| {
                                    if v.can_link(&key, &id, generation) {
                                        cx.emit(Event::Chat {
                                            key: key.clone(),
                                            id: id.clone(),
                                            generation,
                                        });
                                    }
                                },
                            )),
                        );
                    }
                }
            }
            // The brief stays collapsed: its workspace renders and edits it in full.
            content = content.child(
                div()
                    .h_flex()
                    .items_center()
                    .gap_2()
                    .child(div().flex_1().min_w_0().child(ui::heading(
                        "mission-brief-heading",
                        "Brief",
                        Text::Headline,
                    )))
                    .when(d.brief.is_none(), |row| {
                        row.child(
                            ui::text(Text::Caption, "None saved")
                                .text_color(cx.theme().muted_foreground),
                        )
                    })
                    .child(
                        ui::action("mission-open-brief", "Open brief", Action::Secondary)
                            .disabled(!self.online || self.busy || self.error.is_some())
                            .on_click(cx.listener(move |v, _, w, cx| {
                                if v.generation == generation {
                                    v.open_brief(w, cx);
                                }
                            })),
                    ),
            );
            content = content.child(self.comments_line(d, cx));
            if d.clipped {
                content = content.child(
                    Notice::new(
                        "The goal is clipped for display; copy keeps only the visible text.",
                    )
                    .tone(Tone::Warning),
                );
            }
        }
        div()
            .id("missions-page")
            .test_support()
            .track_focus(&self.focus)
            .size_full()
            .min_w_0()
            .min_h_0()
            .overflow_y_scroll()
            .track_scroll(if is_list {
                &self.catalog_scroll
            } else {
                &self.detail_scroll
            })
            .on_action(cx.listener(Self::copy_selection))
            .children(top)
            .child(content)
            .into_any_element()
    }
}
impl Browser {
    fn copy_selection(
        &mut self,
        _: &gpui_kit::base::input::Copy,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let text = gpui_kit::base::TextSelection::selected_text(w, cx);
        if text.is_empty() {
            cx.propagate();
        } else {
            cx.write_to_clipboard(ClipboardItem::new_string(text));
        }
    }
    /// Overview and Tasks, as Swift's segmented mission picker. Tasks counts
    /// what is still open (not done, not dropped) in the received detail.
    fn tab_bar(&self, cx: &Context<Self>) -> impl IntoElement {
        let open = self
            .detail
            .as_ref()
            .filter(|d| self.route == Some(Route::Detail(d.key.clone())))
            .map(|d| d.summary.total() - d.summary.done())
            .filter(|n| *n > 0);
        let tasks = match open {
            Some(n) => format!("Tasks {n}"),
            None => "Tasks".to_owned(),
        };
        let available = self.tasks_browser.read(cx).state.key.is_some();
        ButtonGroup::new("mission-tabs")
            .small()
            .ghost()
            .flex_none()
            .child(
                ui::action("mission-tab-overview", "Overview", Action::Quiet)
                    .selected(self.tab == Tab::Overview)
                    .on_click(cx.listener(|v, _, w, cx| v.choose_tab(Tab::Overview, false, w, cx))),
            )
            .child(
                ui::action(
                    "mission-tab-tasks",
                    SharedString::from(tasks),
                    Action::Quiet,
                )
                .selected(self.tab == Tab::Tasks)
                .disabled(!available && self.tab != Tab::Tasks)
                .on_click(cx.listener(|v, _, w, cx| v.choose_tab(Tab::Tasks, false, w, cx))),
            )
    }
}
/// Wire statuses read as sentence case ("active" → "Active").
fn capitalized(s: &str) -> String {
    let mut chars = s.chars();
    chars
        .next()
        .map(|first| first.to_uppercase().chain(chars).collect())
        .unwrap_or_default()
}

/// Open the overview … menu and choose an item by its visible label, through
/// the real native menu. A disabled choice leaves the menu open; dismiss it.
#[cfg(feature = "native-probes")]
pub(crate) fn probe_menu_command(
    cx: &mut gpui_kit::HeadlessAppContext,
    h: gpui_kit::AnyWindowHandle,
    label: &str,
) {
    use gpui_kit::test::TestWindowExt;
    let settle = |cx: &mut gpui_kit::HeadlessAppContext| {
        for _ in 0..3 {
            cx.run_until_parked();
            cx.advance_clock(std::time::Duration::from_millis(16));
            cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
        }
    };
    cx.update_window(h, |_, w, cx| w.click("mission-more", cx))
        .unwrap();
    settle(cx);
    cx.update_window(h, |_, w, cx| {
        let item = (0..16usize)
            .find(|i| {
                w.within("popup-menu")
                    .try_find(*i)
                    .is_some_and(|e| e.label() == Some(label))
            })
            .unwrap_or_else(|| panic!("overview menu has no {label:?} item"));
        w.within("popup-menu").click(item, cx);
    })
    .unwrap();
    settle(cx);
    if cx
        .update_window(h, |_, w, _| w.try_find("popup-menu").is_some())
        .unwrap()
    {
        cx.update_window(h, |_, w, cx| w.press("escape", cx))
            .unwrap();
        settle(cx);
    }
}
