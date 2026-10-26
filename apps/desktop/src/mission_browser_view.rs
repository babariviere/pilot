//! Read-only mission page. Navigation and draft ownership remain with LocalViewer.
#[cfg(feature = "native-probes")]
#[path = "mission_activity_probe.rs"]
pub(crate) mod mission_activity_probe;
#[path = "mission_decisions_view.rs"]
pub(crate) mod mission_decisions_view;
#[path = "mission_lifecycle_browser.rs"]
mod mission_lifecycle_browser;
#[path = "mission_metadata_browser.rs"]
mod mission_metadata_browser;
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
    component::{Disableable, StyledExt},
    div,
    prelude::FluentBuilder,
    px,
};
use std::sync::Arc;

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
pub(crate) struct Input {
    pub(crate) route: Option<Route>,
    pub(crate) filter: Option<String>,
    pub(crate) projects: Arc<Vec<Project>>,
    pub(crate) chats: Arc<Vec<Chat>>,
    pub(crate) online: bool,
    pub(crate) loaded: bool,
}
pub(crate) struct Browser {
    decisions: mission_decisions_view::Disclosure,
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
    projects: Arc<Vec<Project>>,
    chats: Arc<Vec<Chat>>,
    online: bool,
    loaded: bool,
    filter: Option<String>,
    focus: FocusHandle,
    catalog_scroll: gpui_kit::ScrollHandle,
    detail_scroll: gpui_kit::ScrollHandle,
    pub(crate) tasks_browser: gpui_kit::Entity<crate::mission_tasks_view::Pane>,
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
    #[cfg(target_os = "macos")]
    pub(crate) fn restart_safe(&self, cx: &App) -> bool {
        self.creation.is_none()
            && self.lifecycle.is_empty()
            && self.metadata.is_empty()
            && self.brief.is_none()
            && self.activity_browser.is_none()
            && self.tasks_browser.read(cx).restart_safe()
    }
    pub(crate) fn new(cx: &mut Context<Self>) -> Self {
        Self {
            decisions: Default::default(),
            tasks_browser: cx.new(crate::mission_tasks_view::Pane::new),
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
    pub(crate) fn can_link(&self, key: &Key, id: &str, generation: u64) -> bool {
        self.current(generation)
            && self.online
            && self.loaded
            && self.local_home().as_ref() == Some(&key.home)
            && self.route == Some(Route::Detail(key.clone()))
            && self.detail.as_ref().is_some_and(|d| {
                &d.key == key
                    && self
                        .members
                        .as_ref()
                        .is_ok_and(|m| m.rows.iter().any(|r| r.id == id))
                    && self.chats.iter().any(|c| {
                        c.id == id && !c.local_draft && c.project_id.as_deref() == Some(&d.project)
                    })
            })
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
            self.read(w, cx);
        } else if changed {
            cx.notify();
        }
        let source = self.brief_source();
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
                    "Brief workspace belongs to another Local connection. Existing drafts and save outcomes were retained; reopen this window to change profiles.",
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
                        v.tasks_browser
                            .update(cx, |p, cx| p.sync(key, v.options.clone(), w, cx));
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
            self.tasks_browser
                .update(cx, |p, cx| p.sync(None, self.options.clone(), w, cx));
        }
        cx.notify();
    }
    fn link_availability_changed(&self, chats: &[Chat]) -> bool {
        self.detail.as_ref().is_some_and(|d| {
            self.members.as_ref().is_ok_and(|m| {
                m.rows.iter().any(|m| {
                    let eligible = |rows: &[Chat]| {
                        rows.iter().any(|c| {
                            c.id == m.id
                                && !c.local_draft
                                && c.project_id.as_deref() == Some(d.project.as_str())
                        })
                    };
                    eligible(&self.chats) != eligible(chats)
                })
            })
        })
    }
    pub(crate) fn accept(&mut self, response: mission_reader::Response, cx: &mut Context<Self>) {
        if response.generation != self.generation || self.route.as_ref() != Some(&response.route) {
            return;
        }
        self.busy = false;
        match response.result {
            Err(e) => {
                self.error = Some(e);
                if response.route == Route::Catalog {
                    self.catalog_current = false;
                }
            }
            Ok(Data::Catalog(c)) if response.route == Route::Catalog => {
                self.catalog = Some(c);
                self.catalog_current = true;
                self.error = None;
            }
            Ok(Data::Detail(d, m)) if response.route == Route::Detail(d.key.clone()) => {
                self.decisions.reconcile(&d);
                self.detail = Some(d);
                self.members = m;
                self.error = None;
            }
            _ => self.error = Some("Mission response source differs; refresh explicitly."),
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
        self.tasks_browser.update(cx, |tasks, cx| {
            tasks.sync(tasks_key, self.options.clone(), w, cx)
        });
        self.generation = self.generation.saturating_add(1);
        self.error = None;
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
                self.error = Some(
                    "Mission home is unavailable in this Local-only viewer. Cached catalog context is not live detail.",
                );
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
            self.error = Some(
                "Mission reads are unavailable in this captured view. Open Local to browse missions.",
            );
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
            self.error = Some("Mission read could not be queued. Retry explicitly.");
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
                "Mission reader stopped. Retained context is not current; Refresh to retry.",
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
        self.tasks_browser
            .update(cx, |tasks, cx| tasks.sync(key, self.options.clone(), w, cx));
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
            self.activity_browser = Some(activity);
        }
        self.activity_open = true;
        self.tasks_browser.update(cx, |tasks, cx| {
            tasks.sync(None, self.options.clone(), w, cx)
        });
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
    fn snapshot_note(&self) -> &'static str {
        if self.busy {
            "Loading mission snapshot…"
        } else if self.error.is_some() {
            "Mission read unavailable. Any retained context is not a current snapshot."
        } else if !self.online {
            "Offline-safe view · Local is unavailable; chat links are disabled."
        } else {
            "Read-only snapshot · Refresh to update. No agents or tasks are started here."
        }
    }
}
impl Render for Browser {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
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
        let mut content = ui::page()
            .gap(px(Space::CONTROL))
            .child(
                div()
                    .h_flex()
                    .items_center()
                    .gap_2()
                    .min_w_0()
                    .when(!is_list, |v| {
                        v.child(
                            ui::action("missions-list", "All missions", Action::Quiet).on_click(
                                cx.listener(move |v, _, _, cx| {
                                    if v.generation == generation {
                                        cx.emit(Event::List { generation });
                                    }
                                }),
                            ),
                        )
                    })
                    .child(
                        div().flex_1().min_w_0().child(
                            ui::text(Text::Title, SharedString::from(title))
                                .id("missions-title")
                                .test_support(),
                        ),
                    )
                    .child(
                        ui::action("missions-refresh", "Refresh", Action::Secondary)
                            .disabled(self.options.is_none() || self.busy)
                            .on_click(cx.listener(move |v, _, w, cx| {
                                if v.generation == generation {
                                    v.read(w, cx);
                                }
                            })),
                    )
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
            .child(
                ui::text(Text::Caption, self.snapshot_note())
                    .id("missions-snapshot-note")
                    .test_support(),
            );
        if !self.online {
            content=content.child(Notice::new("Local is unavailable. Retained text is safe to read; chat links require a current Local connection.").tone(Tone::Warning));
        }
        if let Some(error) = self.error {
            content = content.child(
                div()
                    .id("missions-error")
                    .test_support()
                    .child(Notice::new(error).tone(Tone::Error)),
            );
        }
        if is_list {
            let scope = self
                .filter
                .as_ref()
                .map(|id| self.project_name(id))
                .unwrap_or_else(|| "All projects".into());
            content=content.child(ui::text(Text::Caption,SharedString::from(format!("Browse scope: {scope}. Project evidence filters presentation, never mission identity."))));
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
                content = content.child(ui::text(
                    Text::Caption,
                    SharedString::from(format!(
                        "{} shown in scope · {} received · {} known globally",
                        rows.len(),
                        catalog.rows.len(),
                        catalog.total
                    )),
                ));
                if catalog.truncated {
                    content=content.child(Notice::new("Catalog rows or provenance are partial (server limits: 50 rows, 16 sources per row, 24 KB). This API has no pagination; Refresh updates this window, not the full catalog.").tone(Tone::Warning));
                }
                if rows.is_empty() {
                    content = content.child(Notice::new(if self.catalog_current {
                        "No missions in this received scope."
                    } else {
                        "No retained rows in this scope; current missions are unknown."
                    }));
                }
                for r in rows {
                    let key = r.key.clone();
                    let detail = format!(
                        "{} · {} · {}{}",
                        r.status,
                        if local.as_ref() == Some(&key.home) {
                            "Local home"
                        } else {
                            "Home unavailable"
                        },
                        key.id,
                        r.counts
                            .map(|(d, t)| format!(" · {d}/{t} tasks done"))
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
                                .icon(crate::app_icon::AppIcon::Overview),
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
                content = content.child(Notice::new(
                    "Mission catalog not loaded. Refresh explicitly.",
                ));
            }
        } else if let Some(d) = self
            .detail
            .as_ref()
            .filter(|d| self.route == Some(Route::Detail(d.key.clone())))
        {
            content = content
                .child(ui::text(
                    Text::Caption,
                    SharedString::from(format!("{} · {}", d.status, self.project_name(&d.project))),
                ))
                .child(self.plain(
                    "mission-canonical",
                    format!(
                        "Mission {}\nHome {} / {}",
                        d.key.id, d.key.home.daemon, d.key.home.lineage
                    ),
                ));
            for (action, label, id) in [
                (
                    crate::mission_lifecycle::Action::Archive,
                    "Archive mission…",
                    "mission-archive",
                ),
                (
                    crate::mission_lifecycle::Action::Reopen,
                    "Reopen mission…",
                    "mission-reopen",
                ),
            ] {
                if action.allowed(&d.status) {
                    content = content.child(
                        ui::action(id, label, Action::Quiet)
                            .self_start()
                            .disabled(!self.online || !self.current(generation))
                            .on_click(cx.listener(move |v, _, w, cx| {
                                if v.generation == generation {
                                    v.open_lifecycle(action, w, cx);
                                }
                            })),
                    );
                }
            }
            let activity_key = d.key.clone();
            content = content.child(
                ui::action("mission-edit-metadata", "Edit mission", Action::Quiet)
                    .self_start()
                    .disabled(!self.online || !self.current(generation))
                    .on_click(cx.listener(move |v, _, w, cx| {
                        if v.generation == generation {
                            v.open_metadata(w, cx);
                        }
                    })),
            );
            content = content.child(
                ui::action("mission-open-activity", "Browse activity", Action::Quiet)
                    .self_start()
                    .disabled(!self.online || !self.current(generation))
                    .on_click(cx.listener(move |v, _, w, cx| {
                        v.open_activity(&activity_key, generation, w, cx)
                    })),
            );
            content = content
                .child(self.decisions_view(cx))
                .child(ui::heading("mission-goal-heading", "Goal", Text::Headline))
                .child(self.plain(
                    "mission-goal",
                    if d.goal.is_empty() {
                        "No goal saved.".into()
                    } else {
                        d.goal.clone()
                    },
                ));
            if !d.goal.is_empty() {
                let text = d.goal.clone();
                let key = d.key.clone();
                content = content.child(
                    ui::action("mission-copy-goal", "Copy goal", Action::Quiet)
                        .self_start()
                        .on_click(cx.listener(move |v, _, _, cx| {
                            if v.generation == generation
                                && v.route == Some(Route::Detail(key.clone()))
                            {
                                cx.write_to_clipboard(ClipboardItem::new_string(text.clone()));
                            }
                        })),
                );
            }
            content = content.child(ui::heading(
                "mission-chats-heading",
                "Chats",
                Text::Headline,
            ));
            if let Some(id) = &d.coordinator {
                content = content.child(ui::text(
                    Text::Caption,
                    SharedString::from(format!(
                        "Coordinator chat: {id} (opens only if available below)"
                    )),
                ));
            } else {
                content =
                    content.child(ui::text(Text::Caption, "No coordinator chat is assigned."));
            }
            match &self.members {
                Err(e) => content = content.child(Notice::new(*e).tone(Tone::Warning)),
                Ok(m) => {
                    content = content.child(ui::text(
                        Text::Caption,
                        SharedString::from(format!(
                            "{} of {} member chats shown",
                            m.rows.len(),
                            m.total
                        )),
                    ));
                    for member in &m.rows {
                        let key = d.key.clone();
                        let id = member.id.clone();
                        let enabled = self.can_link(&key, &id, generation);
                        let role = if d.coordinator.as_ref() == Some(&id) {
                            "Coordinator"
                        } else {
                            "Member"
                        };
                        let label = format!(
                            "{role} · {id}{}{}",
                            if member.archived { " · archived" } else { "" },
                            if enabled {
                                ""
                            } else {
                                " · unavailable in current Local chat list"
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
            content = content.child(self.tasks_browser.clone());
            content = content.child(ui::heading(
                "mission-brief-heading",
                "Brief",
                Text::Headline,
            ));
            content = content.child(
                ui::action(
                    "mission-open-brief",
                    "Open brief workspace",
                    Action::Secondary,
                )
                .self_start()
                .disabled(!self.online || self.busy || self.error.is_some())
                .on_click(cx.listener(move |v, _, w, cx| {
                    if v.generation == generation {
                        v.open_brief(w, cx);
                    }
                })),
            );
            if let Some(text) = &d.brief {
                let copy = text.clone();
                let key = d.key.clone();
                content = content
                    .child(self.plain("mission-brief", text.clone()))
                    .child(
                        ui::action("mission-copy-brief", "Copy visible brief", Action::Quiet)
                            .self_start()
                            .on_click(cx.listener(move |v, _, _, cx| {
                                if v.generation == generation
                                    && v.route == Some(Route::Detail(key.clone()))
                                {
                                    cx.write_to_clipboard(ClipboardItem::new_string(copy.clone()));
                                }
                            })),
                    );
            } else {
                content = content.child(Notice::new("No brief saved."));
            }
            if d.clipped {
                content=content.child(Notice::new("Text is clipped for display (goal 8 KiB, brief 32 KiB). Copy retains only the visible bounded text. Full content remains in Swift.").tone(Tone::Warning));
            }
        } else if let Some(Route::Detail(key)) = &self.route {
            content = content.child(self.plain(
                "mission-canonical",
                format!(
                    "Mission {}\nHome {} / {}",
                    key.id, key.home.daemon, key.home.lineage
                ),
            ));
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
            .on_action(cx.listener(|_, _: &gpui_kit::base::input::Copy, w, cx| {
                let text = gpui_kit::base::TextSelection::selected_text(w, cx);
                if text.is_empty() {
                    cx.propagate();
                } else {
                    cx.write_to_clipboard(ClipboardItem::new_string(text));
                }
            }))
            .child(content)
            .into_any_element()
    }
}
