//! Passive, window-local inventory over the shared full Local session baseline.
use crate::{
    local_client::Presentation,
    local_model::{Chat, MissionAssociation},
    ui::{self, Action, Space, Text},
};
use gpui_kit::component::Disableable;
use gpui_kit::{
    App, AppContext, Context, Entity, EntityInputHandler, EventEmitter, InteractiveElement,
    IntoElement, ParentElement, Render, SharedString, StatefulInteractiveElement, Styled,
    Subscription, Task, TestSupportExt, Window,
    component::{
        ActiveTheme, IndexPath, Sizable, StyledExt,
        list::{List, ListDelegate, ListEvent, ListItem, ListState},
        menu::{DropdownMenu, PopupMenuItem},
    },
    div, px,
};
use std::{collections::BTreeSet, sync::Arc};

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) enum ProjectFilter {
    #[default]
    All,
    Projectless,
    Id(String),
}
impl ProjectFilter {
    fn matches(&self, chat: &Chat, metadata: &crate::mission_inspector::Metadata) -> bool {
        match self {
            Self::All => true,
            Self::Projectless => chat.project_id.is_none() && metadata.projectless(&chat.id),
            Self::Id(id) => chat.project_id.as_ref() == Some(id),
        }
    }
}
pub(crate) enum Event {
    Chat(String),
    Refresh,
}
pub(crate) struct Rows {
    metadata: Arc<crate::mission_inspector::Metadata>,
    all: Arc<Vec<Chat>>,
    projects: Arc<Vec<crate::local_model::Project>>,
    titles: Option<Arc<std::collections::HashMap<String, String>>>,
    rows: Vec<usize>,
    project: ProjectFilter,
    mission: Option<String>,
    query: String,
    selected: Option<IndexPath>,
    loaded: bool,
}
impl Rows {
    fn at(&self, ix: IndexPath) -> Option<&Chat> {
        self.rows.get(ix.row).and_then(|ix| self.all.get(*ix))
    }
    fn index(&self, id: &str) -> Option<IndexPath> {
        self.rows
            .iter()
            .position(|ix| self.all[*ix].id == id)
            .map(IndexPath::new)
    }
    fn mission_title(&self, id: &str) -> String {
        self.titles
            .as_ref()
            .and_then(|t| t.get(id))
            .cloned()
            .unwrap_or_else(|| format!("Mission {id}"))
    }
    fn project_title(&self, id: &str) -> String {
        self.projects
            .iter()
            .find(|p| p.id == id)
            .map(|p| p.name.clone())
            .unwrap_or_else(|| format!("Project {id}"))
    }
    fn detail(&self, c: &Chat) -> String {
        let mut parts = vec![
            c.project_id
                .as_ref()
                .map(|id| self.project_title(id))
                .unwrap_or_else(|| {
                    format!(
                        "{} · {}",
                        if self.metadata.projectless(&c.id) {
                            "No project"
                        } else {
                            "Project unavailable"
                        },
                        c.cwd
                    )
                }),
        ];
        if let MissionAssociation::Linked(id) = &c.mission {
            let title = self.mission_title(id);
            parts.push(if c.mission_coordinator {
                format!("{title} · Coordinator")
            } else {
                title
            });
        } else if c.mission == MissionAssociation::Unknown {
            parts.push("Mission unavailable".into());
        }
        if !c.cwd.is_empty() && c.project_id.is_some() {
            parts.push(c.cwd.clone());
        }
        parts.join(" · ")
    }
    fn filter(&mut self) {
        let query = self.query.trim().to_lowercase();
        self.rows = self
            .all
            .iter()
            .enumerate()
            .filter(|(_, c)| {
                c.archived
                    && !c.local_draft
                    && self.project.matches(c, &self.metadata)
                    && self
                        .mission
                        .as_ref()
                        .is_none_or(|id| c.mission == MissionAssociation::Linked(id.clone()))
                    && (query.is_empty()
                        || [c.title.clone(), c.cwd.clone(), self.detail(c)]
                            .iter()
                            .any(|v| v.to_lowercase().contains(&query)))
            })
            .map(|(ix, _)| ix)
            .collect();
        self.rows.sort_by(|a, b| {
            self.all[*b]
                .order
                .archived
                .cmp(&self.all[*a].order.archived)
                .then_with(|| self.all[*a].id.cmp(&self.all[*b].id))
        });
    }
}
impl ListDelegate for Rows {
    type Item = ListItem;
    fn items_count(&self, _: usize, _: &App) -> usize {
        self.rows.len()
    }
    fn set_selected_index(
        &mut self,
        ix: Option<IndexPath>,
        _: &mut Window,
        _: &mut Context<ListState<Self>>,
    ) {
        self.selected = ix;
    }
    fn perform_search(
        &mut self,
        query: &str,
        _: &mut Window,
        _: &mut Context<ListState<Self>>,
    ) -> Task<()> {
        self.query = query.into();
        self.filter();
        Task::ready(())
    }
    fn render_empty(
        &mut self,
        _: &mut Window,
        _: &mut Context<ListState<Self>>,
    ) -> impl IntoElement {
        ui::text(
            Text::Body,
            if self.loaded {
                "No matching archived chats"
            } else {
                "Loading archived chats…"
            },
        )
        .p_3()
    }
    fn render_item(
        &mut self,
        ix: IndexPath,
        _: &mut Window,
        cx: &mut Context<ListState<Self>>,
    ) -> Option<Self::Item> {
        let c = self.at(ix)?.clone();
        let detail = self.detail(&c);
        let id = c.id.clone();
        Some(
            ListItem::new(SharedString::from(format!("archive-row-{id}")))
                .accessibility_label(SharedString::from(format!("Read {}, {detail}", c.title)))
                .on_click(cx.listener(move |list, _, w, cx| {
                    cx.stop_propagation();
                    if let Some(ix) = list.delegate().index(&id) {
                        list.set_selected_index(Some(ix), w, cx);
                        cx.emit(ListEvent::Confirm(ix));
                    }
                }))
                .child(
                    div()
                        .id(SharedString::from(format!("archive-label-{}", c.id)))
                        .capture_any_mouse_down(cx.listener(|list, _, w, cx| {
                            if list
                                .query_input()
                                .update(cx, |q, cx| q.marked_text_range(w, cx).is_some())
                            {
                                cx.stop_propagation();
                            }
                        }))
                        .test_support()
                        .w_full()
                        .min_w_0()
                        .px_2()
                        .py_2()
                        .tooltip(move |w, cx| {
                            gpui_kit::component::tooltip::Tooltip::new(format!(
                                "{detail}\nChat {}",
                                c.id
                            ))
                            .build(w, cx)
                        })
                        .child(
                            ui::ResourceLabel::new(SharedString::from(c.title))
                                .detail(SharedString::from(self.detail(self.at(ix)?))),
                        ),
                ),
        )
    }
}
pub(crate) struct Archive {
    pub(super) list: Entity<ListState<Rows>>,
    fresh: bool,
    busy: bool,
    error: Option<&'static str>,
    chats: Arc<Vec<Chat>>,
    projects: Arc<Vec<crate::local_model::Project>>,
    titles: Option<Arc<std::collections::HashMap<String, String>>>,
    _events: Subscription,
}
impl EventEmitter<Event> for Archive {}
impl Archive {
    #[cfg(feature = "native-probes")]
    pub(crate) fn probe_ids(&self, cx: &App) -> Vec<String> {
        let d = self.list.read(cx).delegate();
        d.rows.iter().map(|ix| d.all[*ix].id.clone()).collect()
    }
    pub(crate) fn new(w: &mut Window, cx: &mut Context<Self>) -> Self {
        let list = cx.new(|cx| {
            ListState::new(
                Rows {
                    metadata: Arc::default(),
                    all: Arc::default(),
                    projects: Arc::default(),
                    titles: None,
                    rows: Vec::new(),
                    project: ProjectFilter::All,
                    mission: None,
                    query: String::new(),
                    selected: None,
                    loaded: false,
                },
                w,
                cx,
            )
            .searchable(true)
        });
        let events = cx.subscribe(&list, |v, _, event, cx| {
            if let ListEvent::Confirm(ix) = event
                && let Some(c) = v.list.read(cx).delegate().at(*ix)
            {
                cx.emit(Event::Chat(c.id.clone()));
            }
        });
        Self {
            list,
            fresh: false,
            busy: false,
            error: None,
            chats: Arc::default(),
            projects: Arc::default(),
            titles: None,
            _events: events,
        }
    }
    pub(crate) fn ready(&self, w: &mut Window, cx: &mut Context<Self>) -> bool {
        self.list
            .read(cx)
            .query_input()
            .update(cx, |q, cx| q.marked_text_range(w, cx).is_none())
    }
    pub(crate) fn focus(&self, w: &mut Window, cx: &mut Context<Self>) {
        self.list.update(cx, |l, cx| l.focus(w, cx));
    }
    pub(crate) fn sync(&mut self, state: &Presentation, w: &mut Window, cx: &mut Context<Self>) {
        let titles_changed = match (&self.titles, &state.mission_titles) {
            (Some(a), Some(b)) => !Arc::ptr_eq(a, b),
            (None, None) => false,
            _ => true,
        };
        let rows_changed = !Arc::ptr_eq(&self.chats, &state.chats)
            || !Arc::ptr_eq(
                &self.list.read(cx).delegate().metadata,
                &state.mission_metadata,
            )
            || !Arc::ptr_eq(&self.projects, &state.projects)
            || titles_changed
            || self.list.read(cx).delegate().loaded != state.list_loaded;
        let status_changed = self.fresh != state.summary_fresh
            || self.busy != state.inventory_refreshing
            || self.error != state.inventory_error;
        if !rows_changed && !status_changed {
            return;
        }
        self.fresh = state.summary_fresh;
        self.busy = state.inventory_refreshing;
        self.error = state.inventory_error;
        if rows_changed {
            self.chats = state.chats.clone();
            self.projects = state.projects.clone();
            self.titles = state.mission_titles.clone();
            self.list.update(cx, |l, cx| {
                let selected = l
                    .delegate()
                    .selected
                    .and_then(|ix| l.delegate().at(ix))
                    .map(|c| c.id.clone());
                let offset = l.scroll_handle().offset();
                let d = l.delegate_mut();
                d.metadata = state.mission_metadata.clone();
                d.all = state.chats.clone();
                d.projects = state.projects.clone();
                d.titles = state.mission_titles.clone();
                d.loaded = state.list_loaded;
                d.filter();
                let ix = selected.and_then(|id| d.index(&id));
                l.set_selected_index(ix, w, cx);
                l.scroll_handle().restore_offset(offset);
                cx.notify();
            });
        }
        cx.notify();
    }
    fn filter(
        &mut self,
        project: ProjectFilter,
        mission: Option<String>,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.ready(w, cx) {
            return;
        }
        self.list.update(cx, |l, cx| {
            let d = l.delegate_mut();
            d.project = project;
            d.mission = mission;
            d.filter();
            l.set_selected_index(None, w, cx);
            l.scroll_handle()
                .restore_offset(gpui_kit::point(px(0.), px(0.)));
            cx.notify();
        });
        cx.notify();
    }
}
impl Render for Archive {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let d = self.list.read(cx).delegate();
        let project = d.project.clone();
        let mission = d.mission.clone();
        let project_label = match &project {
            ProjectFilter::All => "All projects".into(),
            ProjectFilter::Projectless => "No project".into(),
            ProjectFilter::Id(id) => d.project_title(id),
        };
        let mission_label = mission
            .as_ref()
            .map(|id| d.mission_title(id))
            .unwrap_or_else(|| "All missions".into());
        let projects: BTreeSet<_> = d
            .all
            .iter()
            .filter(|c| c.archived)
            .filter_map(|c| c.project_id.clone())
            .collect();
        let missions: BTreeSet<_> = d
            .all
            .iter()
            .filter(|c| c.archived && project.matches(c, &d.metadata))
            .filter_map(|c| match &c.mission {
                MissionAssociation::Linked(id) => Some(id.clone()),
                _ => None,
            })
            .collect();
        let projects: Vec<_> = projects
            .into_iter()
            .map(|id| {
                let label = d.project_title(&id);
                (id, label)
            })
            .collect();
        let missions: Vec<_> = missions
            .into_iter()
            .map(|id| {
                let label = d.mission_title(&id);
                (id, label)
            })
            .collect();
        let owner = cx.weak_entity();
        let owner2 = owner.clone();
        let count = d.rows.len();
        let project_for_mission = project.clone();
        let coverage = if self.busy {
            "Refreshing · last reported chats"
        } else if self.error.is_some() {
            "Refresh failed · retained chats"
        } else if self.fresh {
            "All registered archived chats"
        } else if d.loaded {
            "Offline or stale · last reported chats"
        } else {
            "Waiting for Local inventory"
        };
        ui::page()
            .id("archive-page")
            .test_support()
            .h_full()
            .min_h_0()
            .gap(px(Space::CONTROL))
            .child(
                div()
                    .h_flex()
                    .items_center()
                    .justify_between()
                    .gap_2()
                    .capture_any_mouse_down(cx.listener(|v, _, w, cx| {
                        if !v.ready(w, cx) {
                            cx.stop_propagation();
                        }
                    }))
                    .child(ui::heading("archive-title", "Archive", Text::Title))
                    .child(
                        ui::action("archive-refresh", "Refresh", Action::Quiet)
                            .loading(self.busy)
                            .disabled(self.busy)
                            .on_click(cx.listener(|v, _, w, cx| {
                                if !v.busy && v.ready(w, cx) {
                                    cx.emit(Event::Refresh);
                                }
                            })),
                    ),
            )
            .child(
                ui::text(Text::Caption, "Read history without starting work.")
                    .text_color(cx.theme().muted_foreground),
            )
            .child(
                div().id("archive-coverage").test_support().child(
                    ui::text(Text::Caption, format!("{coverage} · {count} shown"))
                        .text_color(cx.theme().muted_foreground),
                ),
            )
            .children(self.error.map(|e| ui::Notice::new(e).tone(ui::Tone::Error)))
            .child(
                div()
                    .h_flex()
                    .min_w_0()
                    .gap_2()
                    .flex_wrap()
                    .capture_any_mouse_down(cx.listener(|v, _, w, cx| {
                        if !v.ready(w, cx) {
                            cx.stop_propagation();
                        }
                    }))
                    .child(
                        ui::action(
                            "archive-project",
                            SharedString::from(project_label),
                            Action::Secondary,
                        )
                        .small()
                        .dropdown_menu(move |menu, _, _| {
                            let mut menu = menu;
                            for (filter, label) in
                                [
                                    (ProjectFilter::All, "All projects".into()),
                                    (ProjectFilter::Projectless, "No project".into()),
                                ]
                                .into_iter()
                                .chain(projects.iter().map(
                                    |(id, label)| (ProjectFilter::Id(id.clone()), label.clone()),
                                ))
                            {
                                let owner = owner.clone();
                                let checked = filter == project;
                                menu =
                                    menu.item(PopupMenuItem::new(label).checked(checked).on_click(
                                        move |_, w, cx| {
                                            let _ = owner.update(cx, |v, cx| {
                                                v.filter(filter.clone(), None, w, cx)
                                            });
                                        },
                                    ));
                            }
                            menu
                        }),
                    )
                    .child(
                        ui::action(
                            "archive-mission",
                            SharedString::from(mission_label),
                            Action::Secondary,
                        )
                        .small()
                        .dropdown_menu(move |menu, _, _| {
                            let mut menu = menu;
                            for (id, label) in std::iter::once((None, "All missions".to_string()))
                                .chain(
                                    missions
                                        .iter()
                                        .map(|(id, label)| (Some(id.clone()), label.clone())),
                                )
                            {
                                let owner = owner2.clone();
                                let p = project_for_mission.clone();
                                let checked = id == mission;
                                menu =
                                    menu.item(PopupMenuItem::new(label).checked(checked).on_click(
                                        move |_, w, cx| {
                                            let _ = owner.update(cx, |v, cx| {
                                                v.filter(p.clone(), id.clone(), w, cx)
                                            });
                                        },
                                    ));
                            }
                            menu
                        }),
                    ),
            )
            .child(
                div()
                    .id("archive-list")
                    .test_support()
                    .flex_1()
                    .min_h_0()
                    .min_w_0()
                    .child(List::new(&self.list).search_placeholder("Search archived chats…")),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn archive_inventory_keeps_same_titles_projectless_and_exact_mission_membership() {
        let raw = json!([
            json!({"id":"a","title":"Same title","projectId":"p","missionId":"m","missionCoordinator":true,"archivedAt":1}),
            json!({"id":"b","title":"Same title","projectId":"p","missionId":"other","archivedAt":2}),
            json!({"id":"none","title":"Same title","archivedAt":3}),
            json!({"id":"member","title":"Other","projectId":"other-p","missionId":"m","archivedAt":4}),
            json!({"id":"open","title":"Same title","projectId":"p","missionId":"m"}),
            json!({"id":"unknown","missionId":false,"archivedAt":5}),
            json!({"id":"project-unknown","projectId":false,"archivedAt":6}),
        ]);
        let all = Arc::new(
            raw.as_array()
                .unwrap()
                .iter()
                .map(|v| crate::local_model::chat(v).unwrap())
                .collect(),
        );
        let mut metadata = Arc::default();
        crate::mission_inspector::Metadata::accept(
            &mut metadata,
            &json!({"type":"sessions","sessions":raw}),
        );
        let mut d = Rows {
            metadata,
            all,
            projects: Arc::default(),
            titles: None,
            rows: vec![],
            project: ProjectFilter::All,
            mission: None,
            query: String::new(),
            selected: None,
            loaded: true,
        };
        let ids = |d: &Rows| {
            d.rows
                .iter()
                .map(|ix| d.all[*ix].id.as_str())
                .collect::<Vec<_>>()
                .join(",")
        };
        d.filter();
        assert_eq!(ids(&d), "project-unknown,unknown,member,none,b,a");
        d.mission = Some("m".into());
        d.filter();
        assert_eq!(ids(&d), "member,a");
        d.project = ProjectFilter::Id("p".into());
        d.filter();
        assert_eq!(ids(&d), "a");
        d.project = ProjectFilter::Projectless;
        d.mission = None;
        d.filter();
        assert_eq!(ids(&d), "unknown,none");
        d.project = ProjectFilter::All;
        d.query = "sAmE tItLe".into();
        d.filter();
        assert_eq!(ids(&d), "none,b,a");
        Arc::make_mut(&mut d.all)[1].archived = false;
        d.filter();
        assert_eq!(ids(&d), "none,a");
        // No arbitrary display cap, including beyond the old Inbox's 1,000 rows.
        d.all = Arc::new(
            (0..1500)
                .map(|id| {
                    crate::local_model::chat(&json!({"id":format!("row-{id}"),"archivedAt":id}))
                        .unwrap()
                })
                .collect(),
        );
        d.query.clear();
        d.filter();
        assert_eq!(d.rows.len(), 1500);
    }
    #[test]
    fn passive_history_keeps_lazy_pages_beyond_legacy_window_and_exact_reader_ids() {
        let entry = |id| json!({"id":id,"kind":"pi.user","model":[{"role":"user","content":[{"type":"text","text":format!("history {id}")}]}]});
        let mut m = crate::local_model::LiveTranscript::default();
        m.archive_snapshot(&json!({"entries":[entry(1000)],"more":true}));
        for before in (2..=1000).rev() {
            assert!(m.page(
                before,
                &json!({"entries":[entry(before-1)],"more":before>2})
            ));
        }
        assert!(m.cursor.is_none());
        assert!(m.has_capacity());
        let rows = m.rows();
        assert_eq!(rows.len(), 1000);
        assert!(!m.limited);
        assert!(rows.iter().all(|r| r.reader_key().is_some()));
        assert!(rows.iter().any(|r| r.source() == "history 1"));
    }
}
