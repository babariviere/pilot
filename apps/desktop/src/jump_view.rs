//! Ephemeral bounded search UI. Dropping it cancels work and releases metadata.
use crate::jump::{Catalog, Destination, Matches, Query, Snapshot};
use gpui_kit::{
    App, AppContext, Context, Entity, EntityInputHandler, EventEmitter, InteractiveElement,
    IntoElement, ParentElement, Render, SharedString, Styled, Subscription, Task, TestSupportExt,
    WeakEntity, Window,
    component::{
        ActiveTheme, IndexPath, StyledExt,
        list::{List, ListDelegate, ListEvent, ListItem, ListState},
    },
    div,
};
use std::sync::Arc;

pub(crate) enum JumpEvent {
    Activate(Destination),
    Close,
}
pub(crate) struct JumpList {
    owner: WeakEntity<JumpPalette>,
    catalog: Option<Arc<Catalog>>,
    matches: Matches,
    selected: Option<String>,
    epoch: u64,
}
impl JumpList {
    fn entry(&self, ix: IndexPath) -> Option<&crate::jump::Entry> {
        self.catalog
            .as_ref()?
            .entries
            .get(*self.matches.groups.get(ix.section)?.rows.get(ix.row)?)
    }
    fn index(&self, id: &str) -> Option<IndexPath> {
        self.matches
            .groups
            .iter()
            .enumerate()
            .find_map(|(section, g)| {
                g.rows
                    .iter()
                    .position(|ix| self.catalog.as_ref().unwrap().entries[*ix].id == id)
                    .map(|row| IndexPath::new(row).section(section))
            })
    }
}
impl ListDelegate for JumpList {
    type Item = ListItem;
    fn sections_count(&self, _: &App) -> usize {
        self.matches.groups.len()
    }
    fn items_count(&self, section: usize, _: &App) -> usize {
        self.matches.groups.get(section).map_or(0, |g| g.rows.len())
    }
    fn set_selected_index(
        &mut self,
        ix: Option<IndexPath>,
        _: &mut Window,
        _: &mut Context<ListState<Self>>,
    ) {
        self.selected = ix.and_then(|ix| self.entry(ix)).map(|e| e.id.clone());
    }
    fn perform_search(
        &mut self,
        query: &str,
        w: &mut Window,
        cx: &mut Context<ListState<Self>>,
    ) -> Task<()> {
        let query = Query::new(query);
        let _ = self.owner.update(cx, |v, cx| v.request(query, w, cx));
        Task::ready(())
    }
    fn render_section_header(
        &mut self,
        section: usize,
        _: &mut Window,
        cx: &mut Context<ListState<Self>>,
    ) -> Option<impl IntoElement> {
        Some(
            div()
                .px_2()
                .py_1()
                .text_xs()
                .font_semibold()
                .text_color(cx.theme().muted_foreground)
                .child(
                    self.matches.groups[section]
                        .kind
                        .title(self.matches.suggested),
                ),
        )
    }
    fn render_empty(
        &mut self,
        _: &mut Window,
        cx: &mut Context<ListState<Self>>,
    ) -> impl IntoElement {
        div()
            .p_3()
            .text_sm()
            .text_color(cx.theme().muted_foreground)
            .child(
                self.matches
                    .error
                    .unwrap_or("No matching loaded resources."),
            )
    }
    fn render_item(
        &mut self,
        ix: IndexPath,
        _: &mut Window,
        cx: &mut Context<ListState<Self>>,
    ) -> Option<ListItem> {
        let e = self.entry(ix)?;
        let owner = self.owner.clone();
        let destination = e.destination.clone();
        let epoch = self.epoch;
        Some(
            ListItem::new(SharedString::from(format!("jump-{}", e.id)))
                .accessibility_label(SharedString::from(format!("{} · {}", e.title, e.detail)))
                .on_click(move |_, w, cx| {
                    cx.stop_propagation();
                    let _ = owner.update(cx, |v, cx| v.activate(destination.clone(), epoch, w, cx));
                })
                .child(
                    div()
                        .id(SharedString::from(format!("jump-row-{}", e.id)))
                        .test_support()
                        .v_flex()
                        .w_full()
                        .min_w_0()
                        .px_2()
                        .py_1()
                        .child(
                            div()
                                .truncate()
                                .text_sm()
                                .child(SharedString::from(e.title.clone())),
                        )
                        .child(
                            div()
                                .truncate()
                                .text_xs()
                                .text_color(cx.theme().muted_foreground)
                                .child(SharedString::from(e.detail.clone())),
                        ),
                ),
        )
    }
}
pub(crate) struct JumpPalette {
    pub(crate) list: Entity<ListState<JumpList>>,
    pub(crate) source: Snapshot,
    catalog: Option<Arc<Catalog>>,
    query: Query,
    epoch: u64,
    ready: bool,
    task: Option<Task<()>>,
    _subscription: Subscription,
}
impl EventEmitter<JumpEvent> for JumpPalette {}
impl JumpPalette {
    #[cfg(feature = "native-probes")]
    pub(crate) fn probe(&self, cx: &App) -> (usize, usize, bool, Option<String>) {
        let d = self.list.read(cx).delegate();
        (
            self.catalog.as_ref().map_or(0, |c| c.entries.len()),
            d.matches.groups.iter().map(|g| g.rows.len()).sum(),
            self.ready,
            d.selected.clone(),
        )
    }
    pub(crate) fn new(source: Snapshot, w: &mut Window, cx: &mut Context<Self>) -> Self {
        let owner = cx.weak_entity();
        let list = cx.new(|cx| {
            ListState::new(
                JumpList {
                    owner,
                    catalog: None,
                    matches: Matches {
                        groups: vec![],
                        suggested: true,
                        error: None,
                    },
                    selected: None,
                    epoch: 0,
                },
                w,
                cx,
            )
            .searchable(true)
        });
        let subscription = cx.subscribe_in(&list, w, |v, l, event, w, cx| match event {
            ListEvent::Confirm(ix) => {
                let destination = l
                    .read(cx)
                    .delegate()
                    .entry(*ix)
                    .map(|e| e.destination.clone());
                if let Some(d) = destination {
                    v.activate(d, v.epoch, w, cx);
                }
            }
            ListEvent::Cancel if !v.marked(w, cx) => cx.emit(JumpEvent::Close),
            _ => {}
        });
        let mut v = Self {
            list,
            source,
            catalog: None,
            query: Query::new(""),
            epoch: 0,
            ready: false,
            task: None,
            _subscription: subscription,
        };
        v.request(Query::new(""), w, cx);
        v
    }
    pub(crate) fn marked(&self, w: &mut Window, cx: &mut Context<Self>) -> bool {
        self.list
            .read(cx)
            .query_input()
            .update(cx, |q, cx| q.marked_text_range(w, cx).is_some())
    }
    pub(crate) fn focus(&self, w: &mut Window, cx: &mut Context<Self>) {
        self.list.update(cx, |l, cx| l.focus(w, cx));
    }
    pub(crate) fn sync(&mut self, source: Snapshot, w: &mut Window, cx: &mut Context<Self>) {
        if self.source.same(&source) {
            return;
        }
        self.source = source;
        self.request(self.query.clone(), w, cx);
    }
    fn request(&mut self, query: Query, w: &mut Window, cx: &mut Context<Self>) {
        let changed = query != self.query;
        self.query = query.clone();
        self.epoch += 1;
        let epoch = self.epoch;
        self.ready = false;
        let source = self.source.clone();
        let existing = self.catalog.clone().filter(|c| c.same(&source));
        self.task = Some(cx.spawn_in(w, async move |v, cx| {
            let (catalog, matches) = cx
                .background_executor()
                .spawn(async move {
                    let catalog = existing.unwrap_or_else(|| Arc::new(Catalog::new(&source)));
                    let matches = catalog.search(&query);
                    (catalog, matches)
                })
                .await;
            let _ = v.update_in(cx, |v, w, cx| {
                if epoch != v.epoch {
                    return;
                }
                v.catalog = Some(catalog.clone());
                v.ready = true;
                v.list.update(cx, |l, cx| {
                    let old = l.delegate().selected.clone();
                    let d = l.delegate_mut();
                    d.catalog = Some(catalog);
                    d.matches = matches;
                    d.epoch = epoch;
                    let index = if changed || epoch == 1 {
                        d.matches
                            .groups
                            .first()
                            .filter(|g| !g.rows.is_empty())
                            .map(|_| IndexPath::new(0))
                    } else {
                        old.as_deref().and_then(|id| d.index(id))
                    };
                    l.set_selected_index(index, w, cx);
                    cx.notify();
                });
                cx.notify();
            });
        }));
        cx.notify();
    }
    fn activate(
        &mut self,
        destination: Destination,
        epoch: u64,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let live = Query::new(self.list.read(cx).query_input().read(cx).value().trim());
        if !self.ready || epoch != self.epoch || live != self.query || self.marked(w, cx) {
            return;
        }
        if self
            .catalog
            .as_ref()
            .is_some_and(|c| c.entries.iter().any(|e| e.destination == destination))
        {
            cx.emit(JumpEvent::Activate(destination));
        }
    }
}
impl Render for JumpPalette {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .id("jump-palette")
            .test_support()
            .v_flex()
            .w_full()
            .h_full()
            .min_h_0()
            .min_w_0()
            .gap_2()
            .child(div().font_semibold().child("Jump to…"))
            .child(div().flex_1().min_h_0().min_w_0().child(
                List::new(&self.list).search_placeholder("Pages, projects and loaded chats…"),
            ))
            .child(
                div()
                    .text_xs()
                    .text_color(cx.theme().muted_foreground)
                    .child(if !self.ready {
                        "Updating matches…"
                    } else if self.source.projects_error {
                        "Project list unavailable · showing loaded resources"
                    } else if !self.source.loaded {
                        "Chat list loading · showing loaded resources"
                    } else {
                        "↑↓ choose · Enter open · Esc close · Loaded Local resources only"
                    }),
            )
    }
}
