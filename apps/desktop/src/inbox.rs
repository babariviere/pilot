//! Bounded, read-only loaded-summary Inbox. No transport, authority or timers.
use crate::{
    app_icon::AppIcon,
    attention::Kind,
    local_model::{Chat, Project},
};
use gpui_kit::{
    App, AppContext, Context, Entity, EventEmitter, InteractiveElement, IntoElement, ParentElement,
    Render, SharedString, StatefulInteractiveElement, Styled, Subscription, TestSupportExt,
    WeakEntity, Window,
    component::{
        ActiveTheme, FocusableExt, IndexPath, Sizable, StyledExt,
        list::{List, ListDelegate, ListEvent, ListItem, ListState},
        select::{SearchableVec, Select, SelectEvent, SelectItem, SelectState},
    },
    div, px,
};
use std::{collections::HashMap, sync::Arc};

const SUMMARY_CAP: usize = 1000;
pub(crate) struct InboxInput {
    pub(crate) chats: Arc<Vec<Chat>>,
    pub(crate) projects: Arc<Vec<Project>>,
    pub(crate) filter: Option<String>,
    pub(crate) loaded: bool,
    pub(crate) projects_error: bool,
}
pub(crate) enum InboxEvent {
    Chat(String),
    Filter(Option<String>),
}
#[derive(Clone)]
struct Choice {
    id: String,
    title: SharedString,
    unavailable: bool,
}
impl SelectItem for Choice {
    type Value = String;
    fn value(&self) -> &String {
        &self.id
    }
    fn title(&self) -> SharedString {
        self.title.clone()
    }
    fn disabled(&self) -> bool {
        self.unavailable
    }
}
#[derive(Default)]
struct Rows {
    needs: Vec<usize>,
    ready: Vec<usize>,
}
impl Rows {
    fn new(chats: &[Chat], filter: Option<&str>) -> Self {
        let mut rows = Self::default();
        for (ix, c) in chats.iter().take(SUMMARY_CAP).enumerate() {
            if c.archived
                || c.local_draft
                || filter.is_some_and(|p| c.project_id.as_deref() != Some(p))
            {
                continue;
            }
            if let Some(a) = &c.attention {
                if a.kind == Kind::Ready {
                    rows.ready.push(ix);
                } else {
                    rows.needs.push(ix);
                }
            }
        }
        // Stable within urgency, retaining the canonical summary order.
        rows.needs
            .sort_by_key(|ix| chats[*ix].attention.as_ref().unwrap().kind);
        rows
    }
    fn section(&self, section: usize) -> &[usize] {
        if section == 0 {
            &self.needs
        } else {
            &self.ready
        }
    }
}
pub(crate) struct InboxList {
    owner: WeakEntity<Inbox>,
    all: Arc<Vec<Chat>>,
    projects: Arc<Vec<Project>>,
    rows: Rows,
    selected: Option<IndexPath>,
    loaded: bool,
    corners: HashMap<String, Entity<crate::dither_view::CornerView>>,
}
impl InboxList {
    fn at(&self, ix: IndexPath) -> Option<&Chat> {
        self.rows
            .section(ix.section)
            .get(ix.row)
            .and_then(|ix| self.all.get(*ix))
    }
    fn index(&self, id: &str) -> Option<IndexPath> {
        (0..2).find_map(|section| {
            self.rows
                .section(section)
                .iter()
                .position(|ix| self.all[*ix].id == id)
                .map(|row| IndexPath::new(row).section(section))
        })
    }
}
impl ListDelegate for InboxList {
    type Item = ListItem;
    fn sections_count(&self, _: &App) -> usize {
        2
    }
    fn items_count(&self, section: usize, _: &App) -> usize {
        self.rows.section(section).len()
    }
    fn set_selected_index(
        &mut self,
        ix: Option<IndexPath>,
        _: &mut Window,
        _: &mut Context<ListState<Self>>,
    ) {
        self.selected = ix;
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
                .py_2()
                .text_sm()
                .font_semibold()
                .text_color(cx.theme().foreground)
                .child(SharedString::from(format!(
                    "{} · {} loaded",
                    if section == 0 {
                        "Needs you"
                    } else {
                        "Ready to merge"
                    },
                    self.rows.section(section).len()
                ))),
        )
    }
    fn render_empty(
        &mut self,
        _: &mut Window,
        cx: &mut Context<ListState<Self>>,
    ) -> impl IntoElement {
        div()
            .h_flex()
            .gap_2()
            .p_4()
            .text_sm()
            .text_color(cx.theme().muted_foreground)
            .child(AppIcon::Inbox.icon())
            .child(if self.loaded {
                "No supported chat attention in these loaded summaries."
            } else {
                "Loading Local summaries…"
            })
    }
    fn render_item(
        &mut self,
        ix: IndexPath,
        window: &mut Window,
        cx: &mut Context<ListState<Self>>,
    ) -> Option<ListItem> {
        let chat = self.at(ix)?.clone();
        let attention = chat.attention.as_ref()?;
        let project = chat
            .project_id
            .as_ref()
            .map(|id| {
                self.projects
                    .iter()
                    .find(|p| &p.id == id)
                    .map(|p| p.name.as_str())
                    .unwrap_or("Project unavailable")
            })
            .unwrap_or("No project");
        let context = format!("{project} · {}", attention.label);
        let tooltip = SharedString::from(format!("{}\n{context}", chat.title));
        let spec = crate::dither::Spec::row(Some(attention.kind.signal()), false);
        let corner = self
            .corners
            .entry(chat.id.clone())
            .or_insert_with(|| cx.new(|cx| crate::dither_view::CornerView::new(spec, window, cx)))
            .clone();
        corner.update(cx, |v, cx| v.configure(spec, cx));
        let owner = self.owner.clone();
        let id = chat.id.clone();
        Some(
            ListItem::new(SharedString::from(format!("inbox-{}", chat.id)))
                .accessibility_label(SharedString::from(format!("{}, {context}", chat.title)))
                .hover_fill(false)
                // Pin pointer activation to the rendered ID, never a live urgency index.
                .on_click(move |_, window, cx| {
                    cx.stop_propagation();
                    let _ = owner.update(cx, |v, cx| {
                        v.list.update(cx, |l, cx| {
                            let ix = l.delegate().index(&id);
                            l.set_selected_index(ix, window, cx);
                            l.focus(window, cx);
                        });
                        cx.emit(InboxEvent::Chat(id.clone()));
                    });
                })
                .child(
                    div()
                        .id(SharedString::from(format!("attention-{}", chat.id)))
                        .test_support()
                        .tooltip(move |window, cx| {
                            gpui_kit::component::tooltip::Tooltip::new(tooltip.clone())
                                .build(window, cx)
                        })
                        .v_flex()
                        .relative()
                        .overflow_hidden()
                        .rounded(px(crate::appearance::Radius::ROW))
                        .w_full()
                        .min_w_0()
                        .px_2()
                        .py_2()
                        .gap_1()
                        .child(crate::dither_view::layer(corner))
                        .child(
                            div()
                                .text_sm()
                                .truncate()
                                .child(SharedString::from(chat.title)),
                        )
                        .child(
                            div()
                                .text_xs()
                                .truncate()
                                .text_color(cx.theme().muted_foreground)
                                .child(SharedString::from(context)),
                        ),
                ),
        )
    }
}
pub(crate) struct Inbox {
    pub(super) list: Entity<ListState<InboxList>>,
    picker: Entity<SelectState<SearchableVec<Choice>>>,
    projects: Arc<Vec<Project>>,
    chats: Arc<Vec<Chat>>,
    filter: Option<String>,
    loaded: bool,
    projects_error: bool,
    _subscriptions: Vec<Subscription>,
    #[cfg(feature = "native-probes")]
    pub(crate) syncs: usize,
}
impl EventEmitter<InboxEvent> for Inbox {}
impl Inbox {
    pub(crate) fn prepare_jump(&self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        self.picker
            .update(cx, |p, cx| p.prepare_navigation(window, cx))
    }
    #[cfg(feature = "native-probes")]
    pub(crate) fn probe_picker_query(
        &self,
        cx: &App,
    ) -> Entity<gpui_kit::component::input::InputState> {
        self.picker.read(cx).query_input(cx)
    }
    #[cfg(feature = "native-probes")]
    pub(crate) fn probe_picker_value(&self, cx: &App) -> Option<String> {
        self.picker.read(cx).selected_value().cloned()
    }
    #[cfg(feature = "native-probes")]
    pub(crate) fn probe_selected(&self, cx: &App) -> Option<String> {
        let d = self.list.read(cx).delegate();
        d.selected.and_then(|ix| d.at(ix)).map(|c| c.id.clone())
    }
    #[cfg(feature = "native-probes")]
    pub(crate) fn probe(&self, cx: &App) -> (usize, usize, usize, usize) {
        let d = self.list.read(cx).delegate();
        (
            d.rows.needs.len(),
            d.rows.ready.len(),
            d.corners.len(),
            self.syncs,
        )
    }
    pub(crate) fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let owner = cx.weak_entity();
        let list = cx.new(|cx| {
            ListState::new(
                InboxList {
                    owner,
                    all: Arc::default(),
                    projects: Arc::default(),
                    rows: Rows::default(),
                    selected: None,
                    loaded: false,
                    corners: HashMap::new(),
                },
                window,
                cx,
            )
            .searchable(false)
        });
        let picker = cx.new(|cx| {
            SelectState::new(
                SearchableVec::new(vec![Choice {
                    id: String::new(),
                    title: "All projects".into(),
                    unavailable: false,
                }]),
                Some(IndexPath::new(0)),
                window,
                cx,
            )
            .searchable(true)
        });
        let rows = cx.subscribe(&list, |view, _, event, cx| {
            if let ListEvent::Confirm(ix) = event
                && let Some(c) = view.list.read(cx).delegate().at(*ix)
            {
                cx.emit(InboxEvent::Chat(c.id.clone()));
            }
        });
        let filter = cx.subscribe(
            &picker,
            |_, _, event: &SelectEvent<SearchableVec<Choice>>, cx| {
                if let SelectEvent::Confirm(Some(id)) = event {
                    cx.emit(InboxEvent::Filter((!id.is_empty()).then(|| id.clone())));
                }
            },
        );
        Self {
            list,
            picker,
            projects: Arc::default(),
            chats: Arc::default(),
            filter: None,
            loaded: false,
            projects_error: false,
            _subscriptions: vec![rows, filter],
            #[cfg(feature = "native-probes")]
            syncs: 0,
        }
    }
    pub(crate) fn restore_filter(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let value = self.filter.clone().unwrap_or_default();
        self.picker
            .update(cx, |v, cx| v.set_selected_value(&value, window, cx));
    }
    pub(crate) fn focus(&self, window: &mut Window, cx: &mut Context<Self>) {
        self.list.update(cx, |v, cx| v.focus(window, cx));
    }
    pub(crate) fn sync(&mut self, input: InboxInput, window: &mut Window, cx: &mut Context<Self>) {
        let InboxInput {
            chats,
            projects,
            filter,
            loaded,
            projects_error,
        } = input;
        if Arc::ptr_eq(&self.chats, &chats)
            && Arc::ptr_eq(&self.projects, &projects)
            && self.filter == filter
            && self.loaded == loaded
            && self.projects_error == projects_error
        {
            return;
        }
        #[cfg(feature = "native-probes")]
        {
            self.syncs += 1;
        }
        let filter_changed = self.filter != filter;
        let picker_changed = !Arc::ptr_eq(&self.projects, &projects) || filter_changed;
        self.chats = chats.clone();
        self.projects = projects.clone();
        self.filter = filter;
        self.loaded = loaded;
        self.projects_error = projects_error;
        if picker_changed {
            let mut choices = vec![Choice {
                id: String::new(),
                title: "All projects".into(),
                unavailable: false,
            }];
            choices.extend(projects.iter().map(|p| Choice {
                id: p.id.clone(),
                title: p.name.clone().into(),
                unavailable: false,
            }));
            if let Some(id) = &self.filter
                && !projects.iter().any(|p| &p.id == id)
            {
                choices.push(Choice {
                    id: id.clone(),
                    title: "Project unavailable".into(),
                    unavailable: true,
                });
            }
            self.picker.update(cx, |v, cx| {
                v.set_items(SearchableVec::new(choices), window, cx)
            });
            self.restore_filter(window, cx);
        }
        self.list.update(cx, |v, cx| {
            let selected = v
                .delegate()
                .selected
                .and_then(|ix| v.delegate().at(ix))
                .map(|c| c.id.clone());
            let d = v.delegate_mut();
            d.rows = Rows::new(&chats, self.filter.as_deref());
            d.all = chats;
            d.projects = projects;
            d.loaded = loaded;
            let eligible: std::collections::HashSet<_> = d
                .rows
                .needs
                .iter()
                .chain(&d.rows.ready)
                .map(|ix| d.all[*ix].id.as_str())
                .collect();
            d.corners.retain(|id, _| eligible.contains(id.as_str()));
            let ix = selected.and_then(|id| d.index(&id));
            v.set_selected_index(ix, window, cx);
            if filter_changed {
                v.scroll_handle()
                    .restore_offset(gpui_kit::point(px(0.), px(0.)));
            }
            cx.notify();
        });
        cx.notify();
    }
}
impl Render for Inbox {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let missing = self
            .filter
            .as_ref()
            .is_some_and(|id| !self.projects.iter().any(|p| &p.id == id));
        div().id("inbox-page").test_support().v_flex().size_full().min_w_0().min_h_0().p_4().gap_3()
            .child(div().h_flex().w_full().items_center().justify_between().gap_2()
                .child(div().text_xl().font_semibold().child("Inbox"))
                // Select's refinement sizes the inner input, not its Base wrapper.
                // Bound both so native hit testing matches the visible control.
                .child(div().w(px(220.)).min_w(px(220.)).max_w(px(220.)).child(Select::new(&self.picker).id("inbox-project-filter").small().w_full().focus_ring(false).menu_max_h(px(300.)).accessibility_label("Inbox project filter").search_placeholder("Find a project…"))))
            .child(div().text_xs().text_color(cx.theme().muted_foreground).child("Local · loaded summaries only. Opening a chat does not mark it reviewed."))
            .child(div().text_xs().text_color(cx.theme().muted_foreground).child(if missing { "Project unavailable. This exact filter is retained; choose another project." } else if self.projects_error { "Project list unavailable. Last received names and exact filters are retained." } else { "Supported chat reasons and ready primary PRs only. Full Inbox sources and actions remain in Swift." }))
            .child(div().id("inbox-list").test_support().flex_1().min_h_0().min_w_0().child(List::new(&self.list)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn exact_scope_stable_urgency_and_capacity() {
        let chats:Vec<_>=(0..1001).map(|i|crate::local_model::chat(&json!({"id":format!("chat-{i}"),"state":"idle","projectId":if i%2==0 {"a"} else {"ab"},"attentionReason":{"kind":match i%4 {0=>"mcp",1=>"asks",2=>"failed",_=>"not_reviewed"}}})).unwrap()).collect();
        let all = Rows::new(&chats, None);
        assert_eq!(all.needs.len(), 1000);
        assert_eq!(&all.needs[..3], &[2, 6, 10]);
        let a = Rows::new(&chats, Some("a"));
        assert_eq!(a.needs.len(), 500);
        assert!(a.needs.iter().all(|i| i % 2 == 0));
        assert!(Rows::new(&chats, Some("missing")).needs.is_empty());
        assert!(all.ready.is_empty());
    }
}
