//! Bounded, read-only loaded-summary Inbox. No transport, authority or timers.
use crate::{
    app_icon::AppIcon,
    attention::Kind,
    local_model::{Chat, Project},
    ui::{self, Notice, ResourceLabel, Space, Text, Tone},
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
    div,
    prelude::FluentBuilder,
    px,
};
use std::{collections::HashMap, sync::Arc};

const SUMMARY_CAP: usize = 1000;
fn empty_copy(loaded: bool) -> (&'static str, &'static str) {
    if loaded {
        (
            "Nothing needs you",
            "Chats that fail, ask a question or are ready to merge show up here.",
        )
    } else {
        ("Loading chats…", "")
    }
}
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
        let count = self.rows.section(section).len();
        if count == 0 {
            return None;
        }
        Some(
            div()
                .h_flex()
                .items_center()
                .gap(px(Space::CONTROL))
                .px(px(Space::CONTROL))
                .py(px(Space::CONTROL))
                .child(
                    ui::text(
                        Text::Label,
                        if section == 0 {
                            "Needs you"
                        } else {
                            "Ready to merge"
                        },
                    )
                    .font_medium()
                    .text_color(cx.theme().foreground),
                )
                .child(
                    ui::text(Text::Caption, count.to_string())
                        .text_color(cx.theme().muted_foreground),
                ),
        )
    }
    fn render_empty(
        &mut self,
        _: &mut Window,
        cx: &mut Context<ListState<Self>>,
    ) -> impl IntoElement {
        let (title, detail) = empty_copy(self.loaded);
        let mut notice = Notice::new(title).tone(Tone::Quiet);
        if !detail.is_empty() {
            notice = notice.detail(detail);
        }
        div()
            .id("inbox-empty-state")
            .test_support()
            .h_flex()
            .items_start()
            .gap(px(Space::CONTROL))
            .p(px(Space::SIDEBAR))
            .text_color(cx.theme().muted_foreground)
            .child(AppIcon::Inbox.icon())
            .child(notice)
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
                        // Keep the existing full corner bounds; reserve a shared
                        // spacing gutter in the text lane, not a hole in its paint.
                        .pr(px(Space::SECTION))
                        .child(crate::dither_view::layer(corner))
                        .child(
                            ResourceLabel::new(SharedString::from(chat.title))
                                .detail(SharedString::from(context)),
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
        ui::page().id("inbox-page").test_support().h_full().min_h_0()
            .gap(px(Space::SIDEBAR))
            .child(div().v_flex().gap(px(Space::META))
                .child(div().h_flex().w_full().min_w_0().items_center().justify_between().gap_2()
                // Coverage caveat lives in the title tooltip, not as permanent copy.
                .child(div().id("inbox-scope-note").test_support().flex_1().min_w_0()
                    .tooltip(|w, cx| gpui_kit::component::tooltip::Tooltip::new("Chats that need you and pull requests ready to merge. Opening a chat doesn't mark it reviewed.").build(w, cx))
                    .child(ui::heading("inbox-title", "Inbox", Text::Title)))
                // Select's refinement sizes the inner input, not its Base wrapper.
                // Bound both so native hit testing matches the visible control.
                .child(div().w(px(220.)).min_w(px(220.)).max_w(px(220.)).child(Select::new(&self.picker).id("inbox-project-filter").small().w_full().focus_ring(false).menu_max_h(px(300.)).accessibility_label("Inbox project filter").search_placeholder("Find a project…")))))
            // A failed project refresh is reported once, beside the sidebar's
            // project chooser. Only a filter whose project vanished is page-specific.
            .when(missing, |this| this.child(
                div().id("inbox-project-notice").test_support().h_flex().items_start().gap(px(Space::CONTROL))
                    .child(AppIcon::Error.inline().text_color(cx.theme().danger))
                    .child(div().v_flex().min_w_0().gap(px(Space::META))
                        .child(Notice::new("This project is no longer available").tone(Tone::Error))
                        .child(ui::text(Text::Caption, "Choose another project to see its chats.").text_color(cx.theme().muted_foreground)))))
            .child(div().id("inbox-list").test_support().flex_1().min_h_0().min_w_0().child(List::new(&self.list)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn empty_and_loading_copy_keep_the_loaded_scope_boundary() {
        assert_ne!(empty_copy(true), empty_copy(false));
        assert!(empty_copy(true).0.contains("Nothing needs you"));
        assert!(empty_copy(false).0.contains("Loading"));
        assert!(!empty_copy(true).0.contains("caught up"));
    }
    #[gpui_kit::test]
    fn shared_rows_keep_glyph_free_text_lane_and_scope_guidance_mounted(
        cx: &mut gpui_kit::TestAppContext,
    ) {
        use gpui_kit::{Bounds, WindowBounds, WindowOptions, size, test::TestWindowExt};
        cx.update(|cx| {
            gpui_kit::init(cx);
            crate::init_appearance(cx);
        });
        for width in [496., 868.] {
            let chats = Arc::new(vec![crate::local_model::chat(&json!({
                "id":"bounded", "title":"A very long synthetic attention title 日本語 ".repeat(8),
                "state":"failed", "attentionReason":{"kind":"failed","detail":"synthetic reason ".repeat(20)}
            })).unwrap()]);
            let (h, _) = cx.update(|cx| {
                gpui_kit::open_window(
                    WindowOptions {
                        window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                            Default::default(),
                            size(px(width), px(600.)),
                        ))),
                        show: false,
                        focus: false,
                        ..Default::default()
                    },
                    cx,
                    |w, cx| {
                        cx.new(|cx| {
                            let mut inbox = Inbox::new(w, cx);
                            inbox.sync(
                                InboxInput {
                                    chats,
                                    projects: Arc::default(),
                                    filter: None,
                                    loaded: true,
                                    projects_error: false,
                                },
                                w,
                                cx,
                            );
                            inbox
                        })
                    },
                )
                .unwrap()
            });
            cx.run_until_parked();
            cx.update_window(h, |_, w, cx| {
                w.draw(cx).clear(cx);
                let row = w.find("attention-bounded").bounds();
                let title = w
                    .within("attention-bounded")
                    .find("resource-title")
                    .bounds();
                let detail = w
                    .within("attention-bounded")
                    .find("resource-detail")
                    .bounds();
                assert!(title.size.width > px(0.) && detail.size.width > px(0.));
                assert!(
                    title.left() >= row.left() && title.left() - row.left() < px(Space::SIDEBAR)
                );
                assert!(title.right() <= row.right() - px(Space::SECTION));
                assert_eq!(title.left(), detail.left());
                assert!(
                    w.within("attention-bounded")
                        .try_find("resource-icon")
                        .is_none(),
                    "no new status column"
                );
                let pane = w.find("inbox-page").bounds();
                let filter = w.find("inbox-project-filter").bounds();
                let note = w.find("inbox-scope-note").bounds();
                assert_eq!(filter.size.width, px(220.));
                assert!(
                    w.try_find("inbox-availability-note").is_none(),
                    "no permanent coverage footer"
                );
                for bounds in [filter, note] {
                    assert!(bounds.left() >= pane.left() && bounds.right() <= pane.right());
                    assert!(bounds.bottom() <= pane.bottom());
                }
                w.remove_window();
            })
            .unwrap();
            cx.run_until_parked();
        }
    }
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
