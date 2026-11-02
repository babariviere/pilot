//! The Inbox's Slack tab: messages of the projects in scope as a status list or board, with
//! a progressive detail for one message. Reads only on opening, scope or filter changes,
//! pilotd's change signals and explicit Try again; every write is an explicit user action.
use crate::{
    LocalOptions,
    app_icon::AppIcon,
    local_model::Chat,
    slack_triage::{
        self as model, Board, Change, ExcerptState, Excerpts, Filter, Item, Kind, Save, Severity,
        Status,
    },
    slack_triage_transport::{self as transport, Outcome, PollOutcome},
    ui::{self, Action, Notice, ResourceLabel, Space, Text, Tone},
};
use gpui_kit::{
    AnyElement, App, AppContext, ClipboardItem, Context, Div, Entity, EventEmitter, FocusHandle,
    InteractiveElement, IntoElement, ParentElement, Render, ScrollStrategy, SharedString,
    StatefulInteractiveElement, Styled, Subscription, Task, TestSupportExt, WeakEntity, Window,
    base::SelectableText,
    component::{
        ActiveTheme, Disableable, IndexPath, Selectable, Sizable, StyledExt,
        button::{Button, ButtonGroup, ButtonVariants},
        list::{List, ListDelegate, ListEvent, ListItem, ListState},
        menu::{DropdownMenu, PopupMenuItem},
    },
    div,
    prelude::FluentBuilder,
    px,
};
use std::{collections::HashMap, sync::Arc, time::Duration};

gpui_kit::actions!(slack_triage, [Left, Right, CloseDetail]);

/// Board columns and a side-by-side detail need the wide window; narrower windows list
/// messages and open the detail in place.
const WIDE: f32 = 960.;
const DETAIL_WIDTH: f32 = 320.;
/// Moving through the list with the arrow keys reads only the message the selection settles on.
const SETTLE: Duration = Duration::from_millis(250);
/// pilotd's change signals arrive in bursts while a sync commits.
const COALESCE: Duration = Duration::from_millis(300);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Layout {
    List,
    Board,
}

pub(crate) enum BoardEvent {
    /// The exact chat started from or linked to a message.
    OpenChat(String),
}

/// What a read covers: the project scope, whether dismissed messages are read, and pilotd's
/// change-signal count.
#[derive(Clone, Debug, PartialEq, Eq)]
struct ReadKey {
    scope: Option<String>,
    dismissed: bool,
    signal: u64,
}

enum Poll {
    Running,
    Message(String),
}

pub(crate) struct Rows {
    owner: WeakEntity<SlackBoard>,
    items: Arc<Vec<Item>>,
    sections: Vec<(Status, Vec<usize>)>,
    /// One board column: a single status without section headers.
    column: bool,
    names: Arc<HashMap<String, String>>,
    now: u64,
}
impl Rows {
    fn new(owner: WeakEntity<SlackBoard>, column: bool) -> Self {
        Self {
            owner,
            items: Arc::default(),
            sections: Vec::new(),
            column,
            names: Arc::default(),
            now: 0,
        }
    }
    fn at(&self, ix: IndexPath) -> Option<&Item> {
        self.sections
            .get(ix.section)
            .and_then(|(_, rows)| rows.get(ix.row))
            .and_then(|i| self.items.get(*i))
    }
    fn index(&self, id: &str) -> Option<IndexPath> {
        self.sections.iter().enumerate().find_map(|(s, (_, rows))| {
            rows.iter()
                .position(|i| self.items[*i].id == id)
                .map(|row| IndexPath::new(row).section(s))
        })
    }
}
impl ListDelegate for Rows {
    type Item = ListItem;
    fn sections_count(&self, _: &App) -> usize {
        self.sections.len().max(1)
    }
    fn items_count(&self, section: usize, _: &App) -> usize {
        self.sections.get(section).map_or(0, |(_, rows)| rows.len())
    }
    fn set_selected_index(
        &mut self,
        _: Option<IndexPath>,
        _: &mut Window,
        cx: &mut Context<ListState<Self>>,
    ) {
        cx.notify();
    }
    fn section_header_height(&self, _: usize, _: &App) -> Option<gpui_kit::Pixels> {
        self.column.then_some(px(0.))
    }
    fn render_section_header(
        &mut self,
        section: usize,
        _: &mut Window,
        cx: &mut Context<ListState<Self>>,
    ) -> Option<impl IntoElement> {
        if self.column {
            return Some(div().h(px(0.)).into_any_element());
        }
        let (status, rows) = self
            .sections
            .get(section)
            .map_or((Status::Open, 0), |(s, rows)| (*s, rows.len()));
        Some(
            section_label(
                SharedString::from(format!("slack-section-{}", status.wire())),
                status.title(),
                rows,
                cx,
            )
            .into_any_element(),
        )
    }
    fn render_empty(
        &mut self,
        _: &mut Window,
        cx: &mut Context<ListState<Self>>,
    ) -> impl IntoElement {
        div()
            .p(px(Space::CONTROL))
            .child(ui::text(Text::Caption, "Nothing here").text_color(cx.theme().muted_foreground))
    }
    fn render_item(
        &mut self,
        ix: IndexPath,
        _: &mut Window,
        cx: &mut Context<ListState<Self>>,
    ) -> Option<ListItem> {
        let item = self.at(ix)?;
        let project = self.names.get(&item.project_id).map(String::as_str);
        let meta = item.meta(project, self.now);
        let label = format!("{}, {}, {meta}", item.title, item.triage.status_title());
        let owner = self.owner.clone();
        let id = item.id.clone();
        Some(
            ListItem::new(SharedString::from(format!("slack-row-{}", item.id)))
                .accessibility_label(SharedString::from(label))
                // Pin pointer activation to the rendered ID, never a live index.
                .on_click(move |_, window, cx| {
                    cx.stop_propagation();
                    let _ = owner.update(cx, |v, cx| v.activate(&id, false, window, cx));
                })
                .child(
                    div()
                        .id(SharedString::from(format!("slack-item-{}", item.id)))
                        .test_support()
                        .h_flex()
                        .items_center()
                        .gap_2()
                        .w_full()
                        .min_w_0()
                        .px_2()
                        .py_2()
                        .child(
                            div().flex_1().min_w_0().child(
                                ResourceLabel::new(SharedString::from(item.title.clone()))
                                    .detail(SharedString::from(meta)),
                            ),
                        )
                        .child(severity_mark(item.triage.severity, cx)),
                ),
        )
    }
}

fn section_label(
    id: SharedString,
    title: &'static str,
    count: usize,
    cx: &App,
) -> impl IntoElement {
    div()
        .id(id)
        .test_support()
        .h_flex()
        .items_center()
        .gap(px(Space::CONTROL))
        .px(px(Space::CONTROL))
        .py(px(Space::CONTROL))
        .child(
            ui::text(Text::Label, title)
                .font_medium()
                .text_color(cx.theme().foreground),
        )
        .child(ui::text(Text::Caption, count.to_string()).text_color(cx.theme().muted_foreground))
}

/// Only critical and high take a signal colour; the row's words always name the severity.
fn severity_mark(severity: Severity, cx: &App) -> Div {
    let color = match severity {
        Severity::Critical => Some(cx.theme().danger),
        Severity::High => Some(cx.theme().warning),
        _ => None,
    };
    div()
        .flex_none()
        .size(px(8.))
        .rounded_full()
        .when_some(color, |d, c| d.bg(c))
}

pub(crate) struct SlackBoard {
    options: Option<LocalOptions>,
    chats: Arc<Vec<Chat>>,
    want: Option<ReadKey>,
    generation: u64,
    pub(crate) busy: bool,
    again: bool,
    pub(crate) error: Option<&'static str>,
    pub(crate) board: Option<Arc<Board>>,
    filter: Filter,
    layout: Layout,
    pub(crate) selected: Option<String>,
    pub(crate) detail: bool,
    wide: bool,
    visible: Arc<Vec<Item>>,
    columns: Vec<(Status, Vec<usize>)>,
    list: Entity<ListState<Rows>>,
    /// One list per status, in `Status::ALL` order.
    lanes: Vec<Entity<ListState<Rows>>>,
    excerpts: Excerpts,
    excerpt_task: Option<Task<()>>,
    reload: Option<Task<()>>,
    pub(crate) saves: HashMap<String, Save>,
    polls: HashMap<String, Poll>,
    detail_focus: FocusHandle,
    _subscriptions: Vec<Subscription>,
}
impl EventEmitter<BoardEvent> for SlackBoard {}
impl SlackBoard {
    pub(crate) fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let owner = cx.weak_entity();
        let make = |column: bool, window: &mut Window, cx: &mut Context<Self>| {
            let owner = owner.clone();
            cx.new(|cx| ListState::new(Rows::new(owner, column), window, cx).searchable(false))
        };
        let list = make(false, window, cx);
        let lanes: Vec<_> = Status::ALL.iter().map(|_| make(true, window, cx)).collect();
        let subscriptions = std::iter::once(&list)
            .chain(&lanes)
            .map(|l| {
                cx.subscribe_in(l, window, |v, list, event: &ListEvent, window, cx| {
                    let id =
                        |ix: &IndexPath| list.read(cx).delegate().at(*ix).map(|i| i.id.clone());
                    match event {
                        ListEvent::Select(ix) => {
                            if let Some(id) = id(ix) {
                                v.select(Some(id), window, cx);
                            }
                        }
                        ListEvent::Confirm(ix) => {
                            if let Some(id) = id(ix) {
                                v.activate(&id, true, window, cx);
                            }
                        }
                        ListEvent::Cancel => {}
                    }
                })
            })
            .collect();
        Self {
            options: None,
            chats: Arc::default(),
            want: None,
            generation: 0,
            busy: false,
            again: false,
            error: None,
            board: None,
            filter: Filter::default(),
            layout: Layout::List,
            selected: None,
            detail: false,
            wide: false,
            visible: Arc::default(),
            columns: Vec::new(),
            list,
            lanes,
            excerpts: Excerpts::default(),
            excerpt_task: None,
            reload: None,
            saves: HashMap::new(),
            polls: HashMap::new(),
            detail_focus: cx.focus_handle(),
            _subscriptions: subscriptions,
        }
    }
    pub(crate) fn options(&mut self, options: LocalOptions) {
        self.options = Some(options);
    }
    /// Shows the board for `scope`. A new scope reads at once; pilotd's change signals
    /// are coalesced. An unchanged request reads nothing.
    pub(crate) fn show(
        &mut self,
        scope: Option<String>,
        signal: u64,
        chats: Arc<Vec<Chat>>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.chats = chats;
        let key = ReadKey {
            scope,
            dismissed: self.filter.show_dismissed,
            signal,
        };
        if self.want.as_ref() == Some(&key) {
            return;
        }
        let rescoped = self.want.as_ref().is_none_or(|w| w.scope != key.scope);
        if rescoped {
            // Another scope's messages are never shown as this one's.
            self.board = None;
            self.error = None;
            self.selected = None;
            self.detail = false;
            self.polls.clear();
            self.rebuild(window, cx);
        }
        self.want = Some(key);
        if rescoped {
            self.load(window, cx);
        } else {
            self.reload = Some(cx.spawn_in(window, async move |this, cx| {
                cx.background_executor().timer(COALESCE).await;
                let _ = this.update_in(cx, |v, w, cx| v.load(w, cx));
            }));
        }
    }
    pub(crate) fn load(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.reload = None;
        let Some(key) = self.want.clone() else {
            return;
        };
        let Some(options) = self.options.clone() else {
            self.error = Some("Slack triage needs a connection to Pilot.");
            cx.notify();
            return;
        };
        if self.busy {
            self.again = true;
            return;
        }
        self.busy = true;
        self.generation += 1;
        let generation = self.generation;
        let (scope, dismissed) = (key.scope.clone(), key.dismissed);
        let started = transport::spawn(
            "local-slack-triage-read",
            Duration::from_secs(10),
            move |client| async move {
                transport::read(&client, &options, scope.as_deref(), dismissed).await
            },
        );
        match started {
            Err(error) => {
                self.busy = false;
                self.error = Some(error);
            }
            Ok(rx) => cx
                .spawn_in(window, async move |this, cx| {
                    let result = rx
                        .recv()
                        .await
                        .unwrap_or(Err("Slack messages couldn't be read."));
                    let _ = this.update_in(cx, |v, w, cx| v.accept(generation, key, result, w, cx));
                })
                .detach(),
        }
        cx.notify();
    }
    fn accept(
        &mut self,
        generation: u64,
        key: ReadKey,
        result: Result<Board, &'static str>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if generation != self.generation {
            return;
        }
        self.busy = false;
        let current = self
            .want
            .as_ref()
            .is_some_and(|w| w.scope == key.scope && w.dismissed == key.dismissed);
        if current {
            match result {
                Ok(board) => {
                    self.board = Some(Arc::new(board));
                    self.error = None;
                    self.rebuild(window, cx);
                }
                // The last report stays, marked stale.
                Err(error) => self.error = Some(error),
            }
        }
        if self.again || !current {
            self.again = false;
            self.load(window, cx);
        }
        cx.notify();
    }
    fn split(&self) -> bool {
        self.wide && self.layout == Layout::List
    }
    fn layout(&self) -> Layout {
        if self.wide { self.layout } else { Layout::List }
    }
    /// Recomputes rows from the board and filters. The selection follows its message; one that
    /// left the list gives way to its neighbour unless its detail is open.
    fn rebuild(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let visible = self
            .board
            .as_ref()
            .map(|b| b.visible(&self.filter))
            .unwrap_or_default();
        let columns = model::columns(&visible, &self.filter.statuses(&visible));
        let before = model::ids(&self.visible, &self.columns);
        let after = model::ids(&visible, &columns);
        let listed = |id: &str| after.iter().any(|c| c.iter().any(|x| x == id));
        if let Some(selected) = self.selected.clone()
            && !listed(&selected)
        {
            let kept = self.detail
                && self
                    .board
                    .as_ref()
                    .is_some_and(|b| b.item(&selected).is_some());
            if !kept {
                self.selected = model::successor(&before, &selected).filter(|s| listed(s));
                self.detail = false;
            }
        }
        let names = Arc::new(self.board.as_ref().map(|b| b.names()).unwrap_or_default());
        let now = crate::usage_overview::now();
        let items = Arc::new(visible);
        self.visible = items.clone();
        self.columns = columns;
        let sections: Vec<_> = self
            .columns
            .iter()
            .filter(|(_, rows)| !rows.is_empty())
            .cloned()
            .collect();
        let selected = self.selected.clone();
        let fill = |l: &mut ListState<Rows>,
                    sections,
                    window: &mut Window,
                    cx: &mut Context<ListState<Rows>>| {
            let d = l.delegate_mut();
            d.items = items.clone();
            d.sections = sections;
            d.names = names.clone();
            d.now = now;
            let ix = selected.as_deref().and_then(|id| d.index(id));
            l.set_selected_index(ix, window, cx);
            cx.notify();
        };
        self.list.update(cx, |l, cx| fill(l, sections, window, cx));
        for (lane, status) in self.lanes.clone().iter().zip(Status::ALL) {
            let rows = self
                .columns
                .iter()
                .find(|(s, _)| *s == status)
                .map(|(_, rows)| rows.clone())
                .unwrap_or_default();
            lane.update(cx, |l, cx| fill(l, vec![(status, rows)], window, cx));
        }
        cx.notify();
    }
    fn select(&mut self, id: Option<String>, window: &mut Window, cx: &mut Context<Self>) {
        if self.selected == id {
            return;
        }
        self.selected = id;
        let id = self.selected.clone();
        for list in std::iter::once(&self.list).chain(&self.lanes) {
            list.update(cx, |l, cx| {
                let ix = id.as_deref().and_then(|id| l.delegate().index(id));
                l.set_selected_index(ix, window, cx);
            });
        }
        self.read_excerpt(SETTLE, window, cx);
        cx.notify();
    }
    /// Click or Return: select the message and show its detail. Return in the side-by-side
    /// layout moves focus into the detail for its controls.
    fn activate(&mut self, id: &str, keyboard: bool, window: &mut Window, cx: &mut Context<Self>) {
        self.select(Some(id.to_owned()), window, cx);
        if !self.split() {
            self.detail = true;
            self.detail_focus.focus(window, cx);
        } else if keyboard {
            self.detail_focus.focus(window, cx);
        }
        self.read_excerpt(Duration::ZERO, window, cx);
        cx.notify();
    }
    fn close_detail(&mut self, _: &CloseDetail, window: &mut Window, cx: &mut Context<Self>) {
        self.detail = false;
        self.focus(window, cx);
        cx.notify();
    }
    /// The list holding the selection, else the first with messages.
    fn current_list(&self) -> Entity<ListState<Rows>> {
        if self.layout() == Layout::List {
            return self.list.clone();
        }
        let column = self
            .columns
            .iter()
            .position(|(_, rows)| {
                rows.iter()
                    .any(|i| Some(&self.visible[*i].id) == self.selected.as_ref())
            })
            .or_else(|| self.columns.iter().position(|(_, rows)| !rows.is_empty()))
            .unwrap_or(0);
        let status = self.columns.get(column).map_or(Status::Open, |(s, _)| *s);
        self.lane(status)
    }
    fn lane(&self, status: Status) -> Entity<ListState<Rows>> {
        let ix = Status::ALL.iter().position(|s| *s == status).unwrap_or(0);
        self.lanes[ix].clone()
    }
    pub(crate) fn focus(&self, window: &mut Window, cx: &mut Context<Self>) {
        if self.detail && !self.split() {
            self.detail_focus.focus(window, cx);
        } else {
            self.current_list().update(cx, |l, cx| l.focus(window, cx));
        }
    }
    fn sideways(&mut self, dx: isize, window: &mut Window, cx: &mut Context<Self>) {
        let ids = model::ids(&self.visible, &self.columns);
        let Some(selected) = self.selected.clone() else {
            return;
        };
        if let Some((column, row)) = model::sideways(&ids, &selected, dx) {
            let id = ids[column][row].clone();
            self.select(Some(id), window, cx);
            let lane = self.lane(self.columns[column].0);
            lane.update(cx, |l, cx| {
                l.scroll_to_item(IndexPath::new(row), ScrollStrategy::Center, window, cx);
                l.focus(window, cx);
            });
        }
    }
    fn left(&mut self, _: &Left, window: &mut Window, cx: &mut Context<Self>) {
        self.sideways(-1, window, cx);
    }
    fn right(&mut self, _: &Right, window: &mut Window, cx: &mut Context<Self>) {
        self.sideways(1, window, cx);
    }
    fn detail_visible(&self) -> bool {
        self.split() || self.detail
    }
    /// Reads the selected message once its selection settles, only while its detail shows.
    fn read_excerpt(&mut self, settle: Duration, window: &mut Window, cx: &mut Context<Self>) {
        self.excerpt_task = None;
        let Some(id) = self.selected.clone() else {
            return;
        };
        if !self.detail_visible() || !self.excerpts.needs_read(&id) {
            return;
        }
        let Some(options) = self.options.clone() else {
            return;
        };
        self.excerpt_task = Some(cx.spawn_in(window, async move |this, cx| {
            if !settle.is_zero() {
                cx.background_executor().timer(settle).await;
            }
            let read = id.clone();
            let Ok(started) = this.update(cx, |v, cx| {
                v.excerpts.set(&id, ExcerptState::Loading);
                cx.notify();
                transport::spawn(
                    "local-slack-triage-excerpt",
                    Duration::from_secs(35),
                    move |client| async move { transport::excerpt(&client, &options, &read).await },
                )
            }) else {
                return;
            };
            let state = match started {
                Ok(rx) => match rx.recv().await {
                    Ok(Ok(excerpt)) => ExcerptState::Loaded(excerpt),
                    Ok(Err(reason)) => ExcerptState::Unavailable(reason),
                    Err(_) => ExcerptState::Unavailable("Couldn't load this message.".into()),
                },
                Err(reason) => ExcerptState::Unavailable(reason.into()),
            };
            let _ = this.update(cx, |v, cx| {
                v.excerpts.set(&id, state);
                cx.notify();
            });
        }));
    }
    fn retry_excerpt(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(id) = self.selected.clone() {
            self.excerpts
                .set(&id, ExcerptState::Unavailable(String::new()));
            self.read_excerpt(Duration::ZERO, window, cx);
        }
    }
    /// One explicit triage change. A no-op choice sends nothing; one change per message at a
    /// time; an unconfirmed change is never resent.
    fn change(&mut self, id: &str, change: Change, window: &mut Window, cx: &mut Context<Self>) {
        let Some(item) = self.board.as_ref().and_then(|b| b.item(id)) else {
            return;
        };
        if change.applied(&item.triage) || matches!(self.saves.get(id), Some(Save::Pending(_))) {
            return;
        }
        let Some(options) = self.options.clone() else {
            return;
        };
        let (id, project) = (id.to_owned(), item.project_id.clone());
        self.saves.insert(id.clone(), Save::Pending(change.clone()));
        let (item_id, sent) = (id.clone(), change.clone());
        let started = transport::spawn(
            "local-slack-triage-save",
            Duration::from_secs(10),
            move |client| async move {
                transport::patch(&client, &options, &item_id, &project, &sent).await
            },
        );
        match started {
            Err(error) => {
                self.saves
                    .insert(id, Save::NotSent(format!("{error} Nothing was changed.")));
            }
            Ok(rx) => cx
                .spawn_in(window, async move |this, cx| {
                    let outcome = rx.recv().await.unwrap_or(Outcome::Unknown(
                        "Pilot didn't confirm the change. It may have applied.".into(),
                    ));
                    let _ = this.update_in(cx, |v, w, cx| v.saved(&id, &change, outcome, w, cx));
                })
                .detach(),
        }
        cx.notify();
    }
    fn saved(
        &mut self,
        id: &str,
        change: &Change,
        outcome: Outcome,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.saves.get(id) != Some(&Save::Pending(change.clone())) {
            return;
        }
        match outcome {
            Outcome::Saved(item) => {
                self.saves.remove(id);
                if let Some(board) = &mut self.board {
                    Arc::make_mut(board).replace(*item);
                }
                self.rebuild(window, cx);
            }
            Outcome::NotSent(reason) => {
                self.saves.insert(id.to_owned(), Save::NotSent(reason));
            }
            Outcome::Unknown(reason) => {
                self.saves.insert(
                    id.to_owned(),
                    Save::Unknown(format!("{reason} It won't be resent.")),
                );
                self.load(window, cx);
            }
        }
        cx.notify();
    }
    /// One ordinary sync of a project's Slack source, within its hourly budget.
    fn sync(&mut self, project: String, window: &mut Window, cx: &mut Context<Self>) {
        if matches!(self.polls.get(&project), Some(Poll::Running)) {
            return;
        }
        let Some(options) = self.options.clone() else {
            return;
        };
        self.polls.insert(project.clone(), Poll::Running);
        let id = project.clone();
        let started = transport::spawn(
            "local-slack-triage-sync",
            Duration::from_secs(100),
            move |client| async move { transport::poll(&client, &options, &id).await },
        );
        match started {
            Err(error) => {
                self.polls.insert(project, Poll::Message(error.into()));
            }
            Ok(rx) => cx
                .spawn_in(window, async move |this, cx| {
                    let outcome = rx.recv().await.unwrap_or(PollOutcome::Unknown(
                        "Pilot didn't confirm the sync.".into(),
                    ));
                    let _ = this.update_in(cx, |v, w, cx| {
                        if !matches!(v.polls.get(&project), Some(Poll::Running)) {
                            return;
                        }
                        match outcome {
                            PollOutcome::Done => {
                                v.polls.remove(&project);
                                v.load(w, cx);
                            }
                            PollOutcome::Refused(m) | PollOutcome::Unknown(m) => {
                                v.polls.insert(project.clone(), Poll::Message(m));
                            }
                        }
                        cx.notify();
                    });
                })
                .detach(),
        }
        cx.notify();
    }
    fn set_filter(&mut self, filter: Filter, window: &mut Window, cx: &mut Context<Self>) {
        let dismissed = filter.show_dismissed != self.filter.show_dismissed;
        self.filter = filter;
        self.rebuild(window, cx);
        if dismissed && let Some(want) = &mut self.want {
            want.dismissed = filter.show_dismissed;
            self.load(window, cx);
        }
        self.focus(window, cx);
    }
    fn set_layout(&mut self, layout: Layout, window: &mut Window, cx: &mut Context<Self>) {
        self.layout = layout;
        self.detail = false;
        self.focus(window, cx);
        cx.notify();
    }

    #[cfg(feature = "native-probes")]
    pub(crate) fn probe_rows(&self) -> Vec<String> {
        self.visible.iter().map(|i| i.id.clone()).collect()
    }
    #[cfg(feature = "native-probes")]
    pub(crate) fn probe_excerpt(&self, id: &str) -> Option<ExcerptState> {
        self.excerpts.get(id).cloned()
    }
}

impl SlackBoard {
    fn toolbar(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let filter = self.filter;
        let hidden = self
            .board
            .as_ref()
            .map_or(0, |b| b.hidden_count(filter.show_dismissed));
        let owner = cx.weak_entity();
        let status = Button::new("slack-status-filter")
            .ghost()
            .small()
            .label(filter.title())
            .dropdown_caret(true)
            .accessibility_label(SharedString::from(format!(
                "Status filter: {}",
                filter.title()
            )))
            .dropdown_menu(move |mut menu, _, _| {
                let choose = |next: Filter| {
                    let owner = owner.clone();
                    move |_: &gpui_kit::ClickEvent, w: &mut Window, cx: &mut App| {
                        let _ = owner.update(cx, |v, cx| v.set_filter(next, w, cx));
                    }
                };
                menu = menu.item(
                    PopupMenuItem::new("All statuses")
                        .checked(filter.status.is_none())
                        .on_click(choose(Filter {
                            status: None,
                            ..filter
                        })),
                );
                for status in [
                    Status::Open,
                    Status::InProgress,
                    Status::Waiting,
                    Status::Done,
                ] {
                    menu = menu.item(
                        PopupMenuItem::new(status.title())
                            .checked(filter.status == Some(status))
                            .on_click(choose(Filter {
                                status: Some(status),
                                ..filter
                            })),
                    );
                }
                menu = menu.separator();
                if hidden > 0 || filter.show_hidden {
                    menu = menu.item(
                        PopupMenuItem::new(SharedString::from(format!("Show hidden ({hidden})")))
                            .checked(filter.show_hidden)
                            .on_click(choose(Filter {
                                show_hidden: !filter.show_hidden,
                                ..filter
                            })),
                    );
                }
                menu.item(
                    PopupMenuItem::new("Show dismissed")
                        .checked(filter.show_dismissed)
                        .on_click(choose(Filter {
                            show_dismissed: !filter.show_dismissed,
                            ..filter
                        })),
                )
            });
        let layout = self.layout;
        let switcher = self.wide.then(|| {
            ButtonGroup::new("slack-layout")
                .small()
                .ghost()
                .flex_none()
                .child(
                    ui::action("slack-layout-list", "List", Action::Quiet)
                        .selected(layout == Layout::List)
                        .on_click(cx.listener(|v, _, w, cx| v.set_layout(Layout::List, w, cx))),
                )
                .child(
                    ui::action("slack-layout-board", "Board", Action::Quiet)
                        .selected(layout == Layout::Board)
                        .on_click(cx.listener(|v, _, w, cx| v.set_layout(Layout::Board, w, cx))),
                )
        });
        // Sync names one project; with several in scope, choose a project first.
        let project = self.board.as_ref().and_then(|b| {
            let mut tracking = b.tracking();
            let first = tracking.next()?;
            tracking.next().is_none().then_some(first)
        });
        let sync = project.map(|p| {
            let running = matches!(self.polls.get(&p.project.id), Some(Poll::Running))
                || p.source.as_ref().is_some_and(|s| s.syncing());
            let id = p.project.id.clone();
            ui::icon_action(
                "slack-sync",
                if running {
                    "Syncing Slack…"
                } else {
                    "Sync Slack now"
                },
                AppIcon::Retry,
                Action::Quiet,
            )
            .loading(running)
            .on_click(cx.listener(move |v, _, w, cx| v.sync(id.clone(), w, cx)))
        });
        let count = self.board.as_ref().map(|_| {
            let n = self.visible.len();
            ui::text(
                Text::Caption,
                SharedString::from(if n == 1 {
                    "1 message".to_owned()
                } else {
                    format!("{n} messages")
                }),
            )
            .id("slack-count")
            .test_support()
            .flex_none()
            .text_color(cx.theme().muted_foreground)
        });
        div()
            .id("slack-toolbar")
            .test_support()
            .h_flex()
            .w_full()
            .min_w_0()
            .items_center()
            .gap_2()
            .child(status)
            .children(switcher)
            .child(div().flex_1())
            .children(count)
            .children(sync)
    }
    fn notices(&self, cx: &App) -> Vec<AnyElement> {
        let mut out = Vec::new();
        let notice =
            |id: &'static str, n: Notice| div().id(id).test_support().child(n).into_any_element();
        if let Some(error) = self.error
            && self.board.is_some()
        {
            out.push(notice(
                "slack-stale",
                Notice::new("Couldn't refresh Slack messages. Showing the last report.")
                    .detail(error)
                    .tone(Tone::Error),
            ));
        }
        let Some(board) = &self.board else {
            return out;
        };
        let many = board.tracking().count() > 1;
        let named = |p: &model::ProjectBoard, text: String| {
            if many {
                format!("{}: {text}", p.project.name)
            } else {
                text
            }
        };
        for (ix, p) in board.tracking().enumerate() {
            if let Some((text, problem)) = p.source.as_ref().and_then(|s| s.notice()) {
                out.push(
                    div()
                        .id(SharedString::from(format!("slack-source-{ix}")))
                        .test_support()
                        .child(
                            Notice::new(SharedString::from(named(p, text))).tone(if problem {
                                Tone::Error
                            } else {
                                Tone::Quiet
                            }),
                        )
                        .into_any_element(),
                );
            }
            if let Some(Poll::Message(text)) = self.polls.get(&p.project.id) {
                out.push(
                    div()
                        .id(SharedString::from(format!("slack-sync-message-{ix}")))
                        .test_support()
                        .child(
                            Notice::new(SharedString::from(named(p, text.clone())))
                                .tone(Tone::Quiet),
                        )
                        .into_any_element(),
                );
            }
            if p.truncated() {
                out.push(
                    ui::text(
                        Text::Caption,
                        SharedString::from(named(
                            p,
                            format!(
                                "Showing the latest {} of {} messages.",
                                model::PROJECT_ITEMS,
                                p.active_total
                            ),
                        )),
                    )
                    .text_color(cx.theme().muted_foreground)
                    .into_any_element(),
                );
            }
        }
        out
    }
    fn body(&self, cx: &mut Context<Self>) -> AnyElement {
        let notice = |id: &'static str, n: Notice| div().id(id).test_support().child(n);
        let Some(board) = &self.board else {
            return match (self.error, self.options.is_some()) {
                (_, false) => notice(
                    "slack-unavailable",
                    Notice::new("Slack triage needs a connection to Pilot.").tone(Tone::Quiet),
                )
                .into_any_element(),
                (Some(error), _) if !self.busy => div()
                    .v_flex()
                    .gap(px(Space::CONTROL))
                    .child(notice(
                        "slack-error",
                        Notice::new("Couldn't read Slack messages")
                            .detail(error)
                            .tone(Tone::Error),
                    ))
                    .child(
                        ui::action("slack-retry", "Try again", Action::Secondary)
                            .self_start()
                            .on_click(cx.listener(|v, _, w, cx| v.load(w, cx))),
                    )
                    .into_any_element(),
                _ => notice(
                    "slack-loading",
                    Notice::new("Reading Slack messages…").tone(Tone::Quiet),
                )
                .into_any_element(),
            };
        };
        if board.tracking().next().is_none() {
            let scoped = self.want.as_ref().is_some_and(|w| w.scope.is_some());
            return notice(
                "slack-not-configured",
                Notice::new(if scoped {
                    "This project doesn't track Slack"
                } else {
                    "No projects track Slack"
                })
                .detail("Add Slack channels in a project's settings to triage their messages here.")
                .tone(Tone::Quiet),
            )
            .into_any_element();
        }
        if self.detail
            && !self.split()
            && let Some(item) = self.selected.as_deref().and_then(|id| board.item(id))
        {
            return self.detail(item, true, cx).into_any_element();
        }
        if self.visible.is_empty() {
            let narrowed = self.filter.status.is_some();
            return div()
                .v_flex()
                .gap(px(Space::CONTROL))
                .child(notice(
                    "slack-empty",
                    if narrowed {
                        Notice::new("No messages match").detail("Try another status.")
                    } else {
                        Notice::new("Nothing to triage")
                            .detail("New messages from your Slack channels appear here after the next sync.")
                    }
                    .tone(Tone::Quiet),
                ))
                .when(narrowed, |d| {
                    let filter = Filter { status: None, ..self.filter };
                    d.child(
                        ui::action("slack-clear-filter", "Show all statuses", Action::Quiet)
                            .self_start()
                            .on_click(cx.listener(move |v, _, w, cx| v.set_filter(filter, w, cx))),
                    )
                })
                .into_any_element();
        }
        match self.layout() {
            Layout::List => {
                let list = div()
                    .id("slack-list")
                    .test_support()
                    .flex_1()
                    .min_w_0()
                    .min_h_0()
                    .h_full()
                    .child(List::new(&self.list));
                if !self.split() {
                    return list.into_any_element();
                }
                let detail = match self.selected.as_deref().and_then(|id| board.item(id)) {
                    Some(item) => self.detail(item, false, cx).into_any_element(),
                    None => div()
                        .id("slack-detail-empty")
                        .test_support()
                        .p(px(Space::CONTROL))
                        .child(
                            ui::text(Text::Caption, "Select a message to see it here.")
                                .text_color(cx.theme().muted_foreground),
                        )
                        .into_any_element(),
                };
                div()
                    .h_flex()
                    .size_full()
                    .min_h_0()
                    .items_start()
                    .gap(px(Space::SECTION))
                    .child(list)
                    .child(
                        div()
                            .flex_none()
                            .w(px(DETAIL_WIDTH))
                            .h_full()
                            .min_h_0()
                            .pl(px(Space::SECTION))
                            .border_l_1()
                            .border_color(cx.theme().border)
                            .child(detail),
                    )
                    .into_any_element()
            }
            Layout::Board => div()
                .id("slack-board-columns")
                .test_support()
                .key_context("SlackBoard")
                .on_action(cx.listener(Self::left))
                .on_action(cx.listener(Self::right))
                .h_flex()
                .size_full()
                .min_h_0()
                .items_start()
                .gap(px(Space::CONTROL))
                .children(self.columns.iter().map(|(status, rows)| {
                    div()
                        .id(SharedString::from(format!(
                            "slack-column-{}",
                            status.wire()
                        )))
                        .test_support()
                        .v_flex()
                        .flex_1()
                        .min_w_0()
                        .h_full()
                        .min_h_0()
                        .child(section_label(
                            SharedString::from(format!("slack-column-title-{}", status.wire())),
                            status.title(),
                            rows.len(),
                            cx,
                        ))
                        .child(
                            div()
                                .flex_1()
                                .min_h_0()
                                .child(List::new(&self.lane(*status))),
                        )
                }))
                .into_any_element(),
        }
    }
    /// One message: what it says, its triage values and the actions on it.
    fn detail(&self, item: &Item, back: bool, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        let id = item.id.clone();
        let t = &item.triage;
        let save = self.saves.get(&id);
        let pending = matches!(save, Some(Save::Pending(_)));
        let labels = self
            .board
            .as_ref()
            .and_then(|b| b.project(&item.project_id))
            .map(|p| p.project.labels.clone())
            .unwrap_or_default();
        let names = self.board.as_ref().map(|b| b.names()).unwrap_or_default();
        let meta = item.meta(
            names.get(&item.project_id).map(String::as_str),
            crate::usage_overview::now(),
        );
        let owner = cx.weak_entity();
        let field = |key: &'static str,
                     title: &'static str,
                     value: String,
                     choices: Vec<(String, Change, bool)>| {
            let owner = owner.clone();
            let id = id.clone();
            div()
                .h_flex()
                .items_center()
                .gap(px(Space::CONTROL))
                .child(
                    ui::text(Text::Caption, title)
                        .w(px(64.))
                        .flex_none()
                        .text_color(cx.theme().muted_foreground),
                )
                .child(
                    Button::new(SharedString::from(format!("slack-field-{key}")))
                        .ghost()
                        .small()
                        .label(SharedString::from(value.clone()))
                        .dropdown_caret(true)
                        .disabled(pending)
                        .accessibility_label(SharedString::from(format!("{title}: {value}")))
                        .dropdown_menu(move |mut menu, _, _| {
                            for (label, change, checked) in &choices {
                                let (owner, id, change) =
                                    (owner.clone(), id.clone(), change.clone());
                                menu = menu.item(
                                    PopupMenuItem::new(SharedString::from(label.clone()))
                                        .checked(*checked)
                                        .on_click(move |_, w, cx| {
                                            let _ = owner.update(cx, |v, cx| {
                                                v.change(&id, change.clone(), w, cx)
                                            });
                                        }),
                                );
                            }
                            menu
                        }),
                )
        };
        let statuses = [
            Status::Open,
            Status::InProgress,
            Status::Waiting,
            Status::Done,
            Status::Dismissed,
        ]
        .into_iter()
        .map(|s| (s.title().to_owned(), Change::Status(s), t.status == s))
        .collect();
        let kinds = Kind::ALL
            .into_iter()
            .map(|k| (k.title().to_owned(), Change::Kind(k), t.kind == k))
            .collect();
        let severities = Severity::ALL
            .into_iter()
            .map(|s| (s.title().to_owned(), Change::Severity(s), t.severity == s))
            .collect();
        let mut label_choices = vec![("None".to_owned(), Change::Label(None), t.label.is_none())];
        label_choices.extend(labels.iter().map(|l| {
            (
                l.name.clone(),
                Change::Label(Some(l.name.clone())),
                t.label.as_deref() == Some(l.name.as_str()),
            )
        }));
        let excerpt = match self.excerpts.get(&id) {
            Some(ExcerptState::Loaded(e)) => div()
                .v_flex()
                .gap(px(Space::META))
                .when_some(e.author.clone(), |d, a| {
                    d.child(
                        ui::text(Text::Caption, SharedString::from(a))
                            .font_medium()
                            .text_color(cx.theme().muted_foreground),
                    )
                })
                .child(if e.text.is_empty() {
                    ui::text(Text::Caption, "No text, only attachments.")
                        .text_color(cx.theme().muted_foreground)
                        .into_any_element()
                } else {
                    div()
                        .id("slack-excerpt-text")
                        .test_support()
                        .w_full()
                        .min_w_0()
                        .child(SelectableText::new(
                            SharedString::from(format!("slack-excerpt-{id}")),
                            SharedString::from(e.text.clone()),
                        ))
                        .into_any_element()
                })
                .when(e.truncated, |d| {
                    d.child(
                        ui::text(Text::Caption, "The message continues in Slack.")
                            .text_color(cx.theme().muted_foreground),
                    )
                }),
            Some(ExcerptState::Unavailable(reason)) if !reason.is_empty() => div()
                .v_flex()
                .gap(px(Space::META))
                .child(
                    ui::text(Text::Caption, SharedString::from(reason.clone()))
                        .text_color(cx.theme().muted_foreground),
                )
                .child(
                    ui::action("slack-excerpt-retry", "Try again", Action::Quiet)
                        .self_start()
                        .on_click(cx.listener(|v, _, w, cx| v.retry_excerpt(w, cx))),
                ),
            _ => div().child(
                ui::text(Text::Caption, "Reading the message…")
                    .text_color(cx.theme().muted_foreground),
            ),
        };
        let chat = item
            .session_id
            .clone()
            .filter(|sid| self.chats.iter().any(|c| &c.id == sid));
        let url = crate::external_links::web(&item.url);
        let dismissed = t.status == Status::Dismissed;
        let reason = (t.status_title() != t.status.title()).then(|| t.status_title());
        div()
            .id("slack-detail")
            .test_support()
            .track_focus(&self.detail_focus)
            .key_context("SlackDetail")
            .on_action(cx.listener(Self::close_detail))
            .v_flex()
            .size_full()
            .min_h_0()
            .min_w_0()
            .gap(px(Space::SECTION))
            .overflow_y_scroll()
            .when(back, |d| {
                d.child(
                    ui::icon_action(
                        "slack-back",
                        "Back to messages",
                        AppIcon::Back,
                        Action::Quiet,
                    )
                    .self_start()
                    .on_click(cx.listener(|v, _, w, cx| v.close_detail(&CloseDetail, w, cx))),
                )
            })
            .child(
                div()
                    .v_flex()
                    .gap(px(Space::META))
                    .child(
                        div()
                            .id("slack-detail-title")
                            .test_support()
                            .text_size(px(Text::Headline.size()))
                            .font_semibold()
                            .child(SelectableText::new(
                                SharedString::from(format!("slack-title-{id}")),
                                SharedString::from(item.title.clone()),
                            )),
                    )
                    .child(
                        ui::text(Text::Caption, SharedString::from(meta))
                            .id("slack-detail-meta")
                            .test_support()
                            .text_color(cx.theme().muted_foreground),
                    ),
            )
            .child(
                div()
                    .id("slack-excerpt")
                    .test_support()
                    .pl(px(Space::CONTROL))
                    .border_l_2()
                    .border_color(cx.theme().border)
                    .child(excerpt),
            )
            .child(
                div()
                    .v_flex()
                    .gap(px(Space::META))
                    .child(field(
                        "status",
                        "Status",
                        t.status.title().to_owned(),
                        statuses,
                    ))
                    .child(field("type", "Type", t.kind.title().to_owned(), kinds))
                    .child(field(
                        "severity",
                        "Severity",
                        t.severity.title().to_owned(),
                        severities,
                    ))
                    .child(field(
                        "label",
                        "Label",
                        t.label.clone().unwrap_or_else(|| "None".into()),
                        label_choices,
                    ))
                    .when_some(reason, |d, r| {
                        d.child(
                            ui::text(Text::Caption, SharedString::from(r))
                                .text_color(cx.theme().muted_foreground),
                        )
                    })
                    .when(item.started && t.status != Status::Done, |d| {
                        d.child(
                            ui::text(
                                Text::Caption,
                                "Marking it Done adds a done reaction in Slack.",
                            )
                            .text_color(cx.theme().muted_foreground),
                        )
                    })
                    .when_some(t.overridden_note(), |d, note| {
                        d.child(
                            ui::text(Text::Caption, SharedString::from(note))
                                .text_color(cx.theme().muted_foreground),
                        )
                    }),
            )
            .when_some(save.cloned(), |d, save| {
                let (text, tone) = match save {
                    Save::Pending(_) => ("Saving…".to_owned(), Tone::Quiet),
                    Save::NotSent(r) => (r, Tone::Error),
                    Save::Unknown(r) => (r, Tone::Error),
                };
                d.child(
                    div()
                        .id("slack-save")
                        .test_support()
                        .child(Notice::new(SharedString::from(text)).tone(tone)),
                )
            })
            .child(
                div()
                    .h_flex()
                    .flex_wrap()
                    .gap_2()
                    .when_some(url, |d, url| {
                        d.child(
                            ui::action("slack-open", "Open in Slack", Action::Secondary)
                                .icon(AppIcon::OpenLink.inline())
                                .on_click(move |_, _, cx| crate::external_links::open(&url, cx)),
                        )
                    })
                    .child({
                        let link = item.url.clone();
                        ui::action("slack-copy", "Copy link", Action::Quiet).on_click(
                            move |_, _, cx| {
                                cx.write_to_clipboard(ClipboardItem::new_string(link.clone()))
                            },
                        )
                    })
                    .when_some(chat, |d, sid| {
                        d.child(
                            ui::action("slack-open-chat", "Open chat", Action::Quiet).on_click(
                                cx.listener(move |_, _, _, cx| {
                                    cx.emit(BoardEvent::OpenChat(sid.clone()))
                                }),
                            ),
                        )
                    })
                    .child({
                        let id = id.clone();
                        let next = if dismissed {
                            Status::Open
                        } else {
                            Status::Dismissed
                        };
                        ui::action(
                            "slack-dismiss",
                            if dismissed { "Restore" } else { "Dismiss" },
                            Action::Quiet,
                        )
                        .disabled(pending)
                        .on_click(cx.listener(move |v, _, w, cx| {
                            v.change(&id, Change::Status(next), w, cx)
                        }))
                    }),
            )
    }
}

impl Render for SlackBoard {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let wide = f32::from(window.viewport_size().width) >= WIDE;
        if wide != self.wide {
            self.wide = wide;
            // The detail opened in place belongs to the narrow layout.
            if wide && self.layout == Layout::List {
                self.detail = false;
            }
        }
        let notices = self.notices(cx);
        div()
            .id("slack-pane")
            .test_support()
            .v_flex()
            .size_full()
            .min_h_0()
            .min_w_0()
            .gap(px(Space::CONTROL))
            .child(self.toolbar(cx))
            .children(notices)
            .child(div().flex_1().min_h_0().min_w_0().child(self.body(cx)))
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn layout_constants_keep_the_detail_inside_the_wide_page() {
        assert!(super::DETAIL_WIDTH * 2. < super::WIDE);
    }
}
