//! Ephemeral bounded search UI. Dropping it cancels work and releases metadata.
use crate::app_icon::AppIcon;
use crate::jump::{Catalog, Destination, Entry, Group, Kind, Matches, Query, Snapshot};
use crate::slack_triage::{LinkLookup, MessageLink};
use gpui_kit::{
    App, AppContext, Context, Entity, EntityInputHandler, EventEmitter, InteractiveElement,
    IntoElement, ParentElement, Render, SharedString, Styled, Subscription, Task, TestSupportExt,
    WeakEntity, Window,
    base::FocusTrapElement,
    component::{
        ActiveTheme, IndexPath, StyledExt,
        list::{List, ListDelegate, ListEvent, ListItem, ListState},
    },
    div, px,
};
use std::sync::Arc;

pub(crate) enum JumpEvent {
    Activate(Destination),
    Close,
}
pub(crate) struct JumpList {
    owner: WeakEntity<JumpPalette>,
    catalog: Option<Arc<Catalog>>,
    /// Rows for a pasted Slack link, which the catalog never holds.
    slack: Arc<Vec<Entry>>,
    /// What the Slack lookup says when it has no rows to show.
    note: Option<&'static str>,
    matches: Matches,
    selected: Option<String>,
    epoch: u64,
}
impl JumpList {
    fn entry(&self, ix: IndexPath) -> Option<&Entry> {
        let group = self.matches.groups.get(ix.section)?;
        let row = *group.rows.get(ix.row)?;
        if group.kind == Kind::Slack {
            self.slack.get(row)
        } else {
            self.catalog.as_ref()?.entries.get(row)
        }
    }
    fn index(&self, id: &str) -> Option<IndexPath> {
        self.matches
            .groups
            .iter()
            .enumerate()
            .find_map(|(section, g)| {
                (0..g.rows.len())
                    .map(|row| IndexPath::new(row).section(section))
                    .find(|ix| self.entry(*ix).is_some_and(|e| e.id == id))
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
        // Kit may measure section zero before the async catalog exists, and
        // cached section geometry may outlive a filtered result set.
        let group = self.matches.groups.get(section)?;
        Some(
            div()
                .id(SharedString::from(format!("jump-section-{:?}", group.kind)))
                .test_support()
                .px_2()
                .py_1()
                .text_xs()
                .font_semibold()
                .text_color(cx.theme().muted_foreground)
                .child(group.kind.title(self.matches.suggested)),
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
                    .or(self.note)
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
        let detail = self
            .catalog
            .as_ref()?
            .detail(e, &self.owner.upgrade()?.read(cx).query);
        let owner = self.owner.clone();
        let destination = e.destination.clone();
        let glyph = match &destination {
            Destination::Home => AppIcon::Home,
            Destination::Inbox => AppIcon::Inbox,
            Destination::Chats | Destination::Chat(_) => AppIcon::Chats,
            Destination::Overview(_) => AppIcon::Overview,
            Destination::Project(_) => AppIcon::Project,
            Destination::ArchiveChat(_) => AppIcon::Chats,
            Destination::OpenLink { .. } if e.is_pr => AppIcon::PullRequest,
            Destination::OpenLink { .. } => AppIcon::OpenLink,
            Destination::SlackOpen(_) | Destination::SlackAdd { .. } => AppIcon::Inbox,
        };
        let icon = match &destination {
            Destination::SlackOpen(_) => crate::app_icon::BrandMark::Slack.icon().size_4(),
            _ => glyph.icon(),
        };
        let epoch = self.epoch;
        Some(
            ListItem::new(SharedString::from(format!("jump-{}", e.id)))
                .accessibility_label(SharedString::from(format!("{} · {}", e.title, detail)))
                .on_click(move |_, w, cx| {
                    cx.stop_propagation();
                    let _ = owner.update(cx, |v, cx| v.activate(destination.clone(), epoch, w, cx));
                })
                .child(
                    div()
                        .id(SharedString::from(format!("jump-row-{}", e.id)))
                        .test_support()
                        .h_flex()
                        .gap_2()
                        .w_full()
                        .min_w_0()
                        .px_2()
                        .py_1()
                        .child(icon)
                        .child(
                            div()
                                .v_flex()
                                .flex_1()
                                .min_w_0()
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
                                        .child(SharedString::from(detail)),
                                ),
                        ),
                ),
        )
    }
}
pub(crate) struct JumpPalette {
    height: crate::composer_height::State,
    list_chrome: gpui_kit::Pixels,
    focus: gpui_kit::FocusHandle,
    pub(crate) list: Entity<ListState<JumpList>>,
    pub(crate) source: Snapshot,
    catalog: Option<Arc<Catalog>>,
    query: Query,
    applied_query: Option<Query>,
    epoch: u64,
    ready: bool,
    task: Option<Task<()>>,
    _subscription: Subscription,
    rows: Arc<Vec<crate::model::Message>>,
    /// The Slack board's pinned connection, for passive link lookups only.
    options: Option<crate::LocalOptions>,
    slack: Option<SlackLookup>,
    slack_task: Option<Task<()>>,
    slack_generation: u64,
}
/// The lookup for the link the query holds. Replaced, never reused, when the link changes.
struct SlackLookup {
    link: MessageLink,
    state: SlackState,
}
enum SlackState {
    Pending,
    Ready(LinkLookup),
    Failed(&'static str),
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
    pub(crate) fn new(
        source: Snapshot,
        rows: Vec<crate::model::Message>,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let owner = cx.weak_entity();
        let list = cx.new(|cx| {
            ListState::new(
                JumpList {
                    owner,
                    catalog: None,
                    slack: Arc::default(),
                    note: None,
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
            height: Default::default(),
            list_chrome: px(0.),
            focus: cx.focus_handle().tab_stop(false),
            list,
            source,
            catalog: None,
            query: Query::new(""),
            applied_query: None,
            epoch: 0,
            ready: false,
            task: None,
            _subscription: subscription,
            rows: Arc::new(rows),
            options: None,
            slack: None,
            slack_task: None,
            slack_generation: 0,
        };
        v.request(Query::new(""), w, cx);
        v
    }
    /// Lets a pasted Slack link be looked up in triage through this connection.
    pub(crate) fn slack_options(&mut self, options: Option<crate::LocalOptions>) {
        self.options = options;
    }
    #[cfg(feature = "native-probes")]
    pub(crate) fn probe_slack(&self, cx: &App) -> Vec<String> {
        self.list
            .read(cx)
            .delegate()
            .slack
            .iter()
            .map(|e| e.id.clone())
            .collect()
    }
    /// Starts one passive lookup when the query becomes a different Slack message link.
    /// Typing, pasting and searching never add anything.
    fn lookup_slack(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        let link = MessageLink::parse(&self.query.text);
        if link.as_ref() == self.slack.as_ref().map(|s| &s.link) {
            return;
        }
        self.slack_task = None;
        self.slack_generation += 1;
        let Some(link) = link else {
            self.slack = None;
            return;
        };
        let Some(options) = self.options.clone() else {
            self.slack = Some(SlackLookup {
                link,
                state: SlackState::Failed("Slack triage needs a connection to Pilot."),
            });
            return;
        };
        let generation = self.slack_generation;
        let read = link.clone();
        let started = crate::slack_triage_transport::spawn(
            "local-slack-link-lookup",
            std::time::Duration::from_secs(10),
            move |client| async move {
                crate::slack_triage_transport::lookup(&client, &options, &read).await
            },
        );
        let state = match started {
            Err(error) => SlackState::Failed(error),
            Ok(rx) => {
                self.slack_task = Some(cx.spawn_in(w, async move |v, cx| {
                    let result = rx
                        .recv()
                        .await
                        .unwrap_or(Err("Couldn't check Slack triage."));
                    let _ = v.update_in(cx, |v, w, cx| {
                        if v.slack_generation != generation {
                            return;
                        }
                        if let Some(s) = &mut v.slack {
                            s.state = match result {
                                Ok(lookup) => SlackState::Ready(lookup),
                                Err(error) => SlackState::Failed(error),
                            };
                        }
                        v.request(v.query.clone(), w, cx);
                    });
                }));
                SlackState::Pending
            }
        };
        self.slack = Some(SlackLookup { link, state });
    }
    /// Rows and the status line for the current link, if the query is one.
    fn slack_rows(&self) -> (Vec<Entry>, Option<&'static str>) {
        let Some(s) = &self.slack else {
            return (Vec::new(), None);
        };
        match &s.state {
            SlackState::Pending => (Vec::new(), Some("Checking Slack triage…")),
            SlackState::Failed(error) => (Vec::new(), Some(error)),
            SlackState::Ready(lookup) => {
                let rows =
                    crate::jump::slack::entries(&s.link, lookup, self.source.scope.as_deref());
                let note = rows.is_empty().then_some("No project tracks Slack");
                (rows, note)
            }
        }
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
        if self.source.reader != source.reader {
            // Never scan the previous chat after a reader switch. Reopen to
            // capture the new reader; linked metadata remains independently valid.
            self.rows = Arc::new(Vec::new());
        }
        self.source = source;
        self.request(self.query.clone(), w, cx);
    }
    fn request(&mut self, query: Query, w: &mut Window, cx: &mut Context<Self>) {
        self.query = query.clone();
        self.lookup_slack(w, cx);
        self.epoch += 1;
        let epoch = self.epoch;
        self.ready = false;
        let source = self.source.clone();
        let existing = self.catalog.clone().filter(|c| c.same(&source));
        let rows = self.rows.clone();
        self.task = Some(cx.spawn_in(w, async move |v, cx| {
            let (catalog, matches) = cx
                .background_executor()
                .spawn(async move {
                    let catalog = existing.unwrap_or_else(|| {
                        Arc::new(Catalog::with_links(&source, rows.as_ref().clone()))
                    });
                    let matches = catalog.search(&query);
                    (catalog, matches)
                })
                .await;
            let _ = v.update_in(cx, |v, w, cx| {
                if epoch != v.epoch {
                    return;
                }
                // Repeated input notifications can replace an in-flight task
                // before its first results land. Compare with the accepted
                // query, not the last requested query, to retain reset intent.
                let changed = v.applied_query.as_ref() != Some(&v.query);
                v.applied_query = Some(v.query.clone());
                v.catalog = Some(catalog.clone());
                v.ready = true;
                let (slack, note) = v.slack_rows();
                v.list.update(cx, |l, cx| {
                    let old = l.delegate().selected.clone();
                    let old_ix = old.as_deref().and_then(|id| l.delegate().index(id));
                    let had_slack = !l.delegate().slack.is_empty();
                    let d = l.delegate_mut();
                    d.catalog = Some(catalog);
                    d.matches = matches;
                    // A pasted link names one message: its rows lead.
                    if !slack.is_empty() {
                        d.matches.groups.insert(
                            0,
                            Group {
                                kind: Kind::Slack,
                                rows: (0..slack.len()).collect(),
                            },
                        );
                    }
                    d.slack = Arc::new(slack);
                    d.note = note;
                    d.epoch = epoch;
                    let first = d
                        .matches
                        .groups
                        .first()
                        .filter(|g| !g.rows.is_empty())
                        .map(|_| IndexPath::new(0));
                    // Slack rows arrive after the lookup; they take the selection unless
                    // the user already moved it.
                    let arrived = !had_slack
                        && !d.slack.is_empty()
                        && old_ix.is_none_or(|ix| ix == IndexPath::new(0));
                    let index = if changed || epoch == 1 || arrived {
                        first
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
        let listed = |entries: &[Entry]| entries.iter().any(|e| e.destination == destination);
        if self.catalog.as_ref().is_some_and(|c| listed(&c.entries))
            || listed(&self.list.read(cx).delegate().slack)
        {
            cx.emit(JumpEvent::Activate(destination));
        }
    }
    fn guard_preedit(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if self.marked(w, cx) {
            cx.stop_propagation();
        } else {
            cx.propagate();
        }
    }
}
impl Render for JumpPalette {
    fn render(&mut self, w: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let maximum = (f32::from(w.viewport_size().height) - 32.).clamp(160., 480.);
        let owner = cx.weak_entity();
        let list = self.list.clone();
        let content = div()
            // Keybindings dispatch actions before raw key listeners. Capture
            // Escape before the input clears preedit, not after List::Cancel.
            .capture_action(
                cx.listener(|v, _: &gpui_kit::base::input::Escape, w, cx| v.guard_preedit(w, cx)),
            )
            .capture_action(
                cx.listener(|v, _: &gpui_kit::base::input::Enter, w, cx| v.guard_preedit(w, cx)),
            )
            .capture_action(
                cx.listener(|v, _: &gpui_kit::base::actions::Cancel, w, cx| v.guard_preedit(w, cx)),
            )
            .capture_action(
                cx.listener(|v, _: &gpui_kit::base::actions::Confirm, w, cx| {
                    v.guard_preedit(w, cx)
                }),
            )
            .capture_action(
                cx.listener(|v, _: &gpui_kit::base::input::IndentInline, w, cx| {
                    v.focus(w, cx);
                    cx.stop_propagation();
                }),
            )
            .capture_action(
                cx.listener(|v, _: &gpui_kit::base::input::OutdentInline, w, cx| {
                    v.focus(w, cx);
                    cx.stop_propagation();
                }),
            )
            .v_flex()
            .w_full()
            .min_h_0()
            .min_w_0()
            // The shell's two border points sit outside this measured content.
            .max_h(px(maximum - 2.))
            .gap_2()
            .p_3()
            .child(
                div()
                    .id("jump-results")
                    .test_support()
                    .v_flex()
                    .flex_1()
                    .min_h_0()
                    .min_w_0()
                    .overflow_hidden()
                    .child(
                        List::new(&self.list)
                            .min_h_0()
                            // Kit applies max_h to the result viewport, not
                            // the whole List (which also owns its query).
                            .max_h((px(maximum) - self.list_chrome).max(px(0.)))
                            .search_placeholder("Pages, projects, chats, links or PR #…"),
                    ),
            )
            .child(
                div()
                    .id("jump-footer")
                    .test_support()
                    .flex_none()
                    .text_xs()
                    .text_color(cx.theme().muted_foreground)
                    .child(if !self.ready {
                        "Updating matches…"
                    } else if let Some(note) = self.list.read(cx).delegate().note
                        && self
                            .list
                            .read(cx)
                            .delegate()
                            .matches
                            .groups
                            .iter()
                            .any(|g| !g.rows.is_empty())
                    {
                        note
                    } else if self.catalog.as_ref().is_some_and(|c| c.links_limited) {
                        "Scan limit reached · more loaded links may be omitted"
                    } else if self.source.projects_error {
                        "Couldn't refresh projects · showing the last list"
                    } else if !self.source.loaded {
                        "Loading chats…"
                    } else {
                        "↑↓ to move · Return to open · Esc to close"
                    }),
            )
            .on_children_prepainted(move |bounds, w, cx| {
                let [results, footer] = bounds.as_slice() else {
                    return;
                };
                let viewport = list.read(cx).scroll_handle().base_handle().bounds();
                if viewport.size.height <= px(0.) {
                    return;
                }
                let query = viewport.top() - results.top();
                // Existing p_3 + gap_2, both rem-scaled, and shell borders.
                let chrome = query + footer.size.height + w.rem_size() * 2. + px(2.);
                let _ = owner.update(cx, |p, cx| {
                    if p.list_chrome != chrome {
                        p.list_chrome = chrome;
                        cx.notify();
                    }
                });
            })
            .id("jump-palette")
            .test_support()
            .focus_trap("jump-palette", &self.focus);
        div()
            .id("jump-shell")
            .test_support()
            .w_full()
            .occlude()
            .overflow_hidden()
            .rounded(px(crate::appearance::Radius::TRAY))
            .bg(cx.theme().popover)
            .border_1()
            .border_color(cx.theme().border)
            .child(crate::composer_height::top_slot(
                "jump-height-slot",
                &self.height,
                content.into_any_element(),
                w,
                cx,
            ))
    }
}
