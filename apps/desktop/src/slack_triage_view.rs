//! The Inbox's Slack tab: a kanban board of the projects' Slack messages by status, or a list
//! with one tab per status, plus an inspector with the full thread and direct triage controls.
//! Reads happen on opening, scope or filter changes, pilotd's change signals and explicit
//! retries; every write is an explicit user action on one message.
use crate::{
    LocalOptions,
    app_icon::AppIcon,
    local_model::Chat,
    slack_triage::{
        self as model, Board, Change, Filter, Item, Kind, Save, Severity, Status, ThreadState,
        Threads,
    },
    slack_triage_transport::{self as transport, Outcome, PollOutcome},
    ui::{self, Action, Notice, ResourceLabel, Space, Surface, Text, Tone},
};
use gpui_kit::{
    AnyElement, App, AppContext, ClipboardItem, Context, Div, Entity, EventEmitter, FocusHandle,
    InteractiveElement, IntoElement, ParentElement, Render, ScrollHandle, SharedString,
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

gpui_kit::actions!(slack_triage, [Up, Down, Left, Right, Open, CloseDetail]);

/// Below this window width the board's columns do not fit: the list shows, and the inspector
/// replaces it instead of sitting beside it.
const WIDE: f32 = 960.;
/// Sized so a 1100 pt window shows all four status columns, or two beside the inspector.
const INSPECTOR_WIDTH: f32 = 372.;
const COLUMN_MIN: f32 = 172.;
/// Moving through messages with the arrow keys reads only the thread the selection settles on.
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

/// A card being dragged to another column, which changes the message's status on drop.
#[derive(Clone)]
pub(crate) struct DraggedCard {
    id: String,
    title: SharedString,
}
impl Render for DraggedCard {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .w(px(COLUMN_MIN))
            .p(px(Space::CONTROL))
            .rounded(px(crate::appearance::Radius::CONTROL))
            .bg(Surface::Card.color(cx))
            .border_1()
            .border_color(cx.theme().border)
            .shadow_md()
            .child(ui::text(Text::Body, self.title.clone()).truncate())
    }
}

/// The list layout: the selected status tab's messages.
pub(crate) struct Rows {
    owner: WeakEntity<SlackBoard>,
    items: Arc<Vec<Item>>,
    rows: Vec<usize>,
    names: Arc<HashMap<String, String>>,
    now: u64,
}
impl Rows {
    fn at(&self, ix: IndexPath) -> Option<&Item> {
        self.rows.get(ix.row).and_then(|i| self.items.get(*i))
    }
    fn index(&self, id: &str) -> Option<IndexPath> {
        self.rows
            .iter()
            .position(|i| self.items[*i].id == id)
            .map(IndexPath::new)
    }
}
impl ListDelegate for Rows {
    type Item = ListItem;
    fn items_count(&self, _: usize, _: &App) -> usize {
        self.rows.len()
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
        Some(px(0.))
    }
    fn render_section_header(
        &mut self,
        _: usize,
        _: &mut Window,
        _: &mut Context<ListState<Self>>,
    ) -> Option<impl IntoElement> {
        Some(div().h(px(0.)))
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

/// Only critical and high take a signal colour; words always name the severity.
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

/// A project label as a quiet hairline tag.
fn label_tag(name: &str, cx: &App) -> Div {
    div()
        .flex_none()
        .px(px(6.))
        .rounded(px(crate::appearance::Radius::SMALL))
        .border_1()
        .border_color(cx.theme().border)
        .child(ui::text(Text::Caption, SharedString::from(name.to_owned())))
}

fn caption(text: impl Into<SharedString>, cx: &App) -> Div {
    ui::text(Text::Caption, text).text_color(cx.theme().muted_foreground)
}

fn empty_column_copy(status: Status) -> &'static str {
    match status {
        Status::Open => "No open messages",
        Status::InProgress => "Nothing in progress",
        Status::Waiting => "Nothing waiting",
        Status::Done => "Nothing done yet",
        Status::Dismissed => "Nothing dismissed",
    }
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
    pub(crate) layout: Layout,
    /// The list layout's status tab.
    pub(crate) tab: Status,
    pub(crate) selected: Option<String>,
    /// The inspector shows the selected message.
    pub(crate) open: bool,
    wide: bool,
    visible: Arc<Vec<Item>>,
    columns: Vec<(Status, Vec<usize>)>,
    names: Arc<HashMap<String, String>>,
    list: Entity<ListState<Rows>>,
    board_focus: FocusHandle,
    detail_focus: FocusHandle,
    /// One per status column, in `Status::ALL` order, to keep the selected card in view.
    scrolls: Vec<ScrollHandle>,
    threads: Threads,
    thread_task: Option<Task<()>>,
    reload: Option<Task<()>>,
    pub(crate) saves: HashMap<String, Save>,
    polls: HashMap<String, Poll>,
    _subscriptions: Vec<Subscription>,
}
impl EventEmitter<BoardEvent> for SlackBoard {}
impl SlackBoard {
    pub(crate) fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let owner = cx.weak_entity();
        let list = cx.new(|cx| {
            ListState::new(
                Rows {
                    owner,
                    items: Arc::default(),
                    rows: Vec::new(),
                    names: Arc::default(),
                    now: 0,
                },
                window,
                cx,
            )
            .searchable(false)
        });
        let rows = cx.subscribe_in(&list, window, |v, list, event: &ListEvent, window, cx| {
            let id = |ix: &IndexPath| list.read(cx).delegate().at(*ix).map(|i| i.id.clone());
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
        });
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
            layout: Layout::Board,
            tab: Status::Open,
            selected: None,
            open: false,
            wide: false,
            visible: Arc::default(),
            columns: Vec::new(),
            names: Arc::default(),
            list,
            board_focus: cx.focus_handle(),
            detail_focus: cx.focus_handle(),
            scrolls: Status::ALL.iter().map(|_| ScrollHandle::new()).collect(),
            threads: Threads::default(),
            thread_task: None,
            reload: None,
            saves: HashMap::new(),
            polls: HashMap::new(),
            _subscriptions: vec![rows],
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
            self.open = false;
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
    fn layout(&self) -> Layout {
        if self.wide { self.layout } else { Layout::List }
    }
    /// The inspector sits beside the list or board; narrow windows show it instead of them.
    fn beside(&self) -> bool {
        self.wide
    }
    fn column(&self, status: Status) -> &[usize] {
        self.columns
            .iter()
            .find(|(s, _)| *s == status)
            .map_or(&[], |(_, rows)| rows.as_slice())
    }
    /// IDs in keyboard order: one column per status on the board, the current tab in the list.
    fn key_columns(&self) -> Vec<Vec<String>> {
        let ids = model::ids(&self.visible, &self.columns);
        if self.layout() == Layout::Board {
            return ids;
        }
        self.columns
            .iter()
            .zip(ids)
            .filter(|((s, _), _)| *s == self.tab)
            .map(|(_, ids)| ids)
            .collect()
    }
    /// Recomputes rows from the board and filters. The selection follows its message; one that
    /// left the view gives way to its neighbour unless the inspector holds it.
    fn rebuild(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let before = self.key_columns();
        let visible = self
            .board
            .as_ref()
            .map(|b| b.visible(&self.filter))
            .unwrap_or_default();
        let statuses = self.filter.statuses(&visible);
        if !statuses.contains(&self.tab) {
            self.tab = Status::Open;
        }
        self.columns = model::columns(&visible, &statuses);
        self.visible = Arc::new(visible);
        self.names = Arc::new(self.board.as_ref().map(|b| b.names()).unwrap_or_default());
        let after = self.key_columns();
        let listed = |id: &str| after.iter().any(|c| c.iter().any(|x| x == id));
        if let Some(selected) = self.selected.clone()
            && !listed(&selected)
        {
            let kept = self.open
                && self
                    .board
                    .as_ref()
                    .is_some_and(|b| b.item(&selected).is_some());
            if !kept {
                self.selected = model::successor(&before, &selected).filter(|s| listed(s));
                self.open = self.open && self.selected.is_some();
            }
        }
        let (items, names) = (self.visible.clone(), self.names.clone());
        let rows = self.column(self.tab).to_vec();
        let selected = self.selected.clone();
        let now = crate::usage_overview::now();
        self.list.update(cx, |l, cx| {
            let d = l.delegate_mut();
            d.items = items;
            d.rows = rows;
            d.names = names;
            d.now = now;
            let ix = selected.as_deref().and_then(|id| d.index(id));
            l.set_selected_index(ix, window, cx);
            cx.notify();
        });
        cx.notify();
    }
    fn select(&mut self, id: Option<String>, window: &mut Window, cx: &mut Context<Self>) {
        if self.selected == id {
            return;
        }
        self.selected = id;
        let id = self.selected.clone();
        self.list.update(cx, |l, cx| {
            let ix = id.as_deref().and_then(|id| l.delegate().index(id));
            l.set_selected_index(ix, window, cx);
        });
        self.reveal_card();
        self.read_thread(SETTLE, window, cx);
        cx.notify();
    }
    /// Keeps the selected card in view in its column.
    fn reveal_card(&self) {
        let Some(id) = self.selected.as_deref() else {
            return;
        };
        for (status, rows) in &self.columns {
            if let Some(row) = rows.iter().position(|i| self.visible[*i].id == id) {
                let ix = Status::ALL.iter().position(|s| s == status).unwrap_or(0);
                self.scrolls[ix].scroll_to_item(row);
            }
        }
    }
    /// Click or Return: select the message and open the inspector. In a narrow window the
    /// inspector takes the list's place and keyboard focus.
    fn activate(&mut self, id: &str, keyboard: bool, window: &mut Window, cx: &mut Context<Self>) {
        self.select(Some(id.to_owned()), window, cx);
        self.open = true;
        if !self.beside() || keyboard && self.layout() == Layout::List {
            self.detail_focus.focus(window, cx);
        }
        self.read_thread(Duration::ZERO, window, cx);
        cx.notify();
    }
    fn close_detail(&mut self, _: &CloseDetail, window: &mut Window, cx: &mut Context<Self>) {
        self.open = false;
        self.thread_task = None;
        self.focus(window, cx);
        cx.notify();
    }
    pub(crate) fn focus(&self, window: &mut Window, cx: &mut Context<Self>) {
        if self.open && !self.beside() {
            self.detail_focus.focus(window, cx);
        } else if self.layout() == Layout::Board {
            self.board_focus.focus(window, cx);
        } else {
            self.list.update(cx, |l, cx| l.focus(window, cx));
        }
    }
    /// Board keys: up and down within a column, left and right to the nearest card of the
    /// next non-empty column. With nothing selected, any move selects the first card.
    fn step(&mut self, dx: isize, dy: isize, window: &mut Window, cx: &mut Context<Self>) {
        let columns = self.key_columns();
        let next = match self.selected.as_deref() {
            None => columns.iter().find_map(|c| c.first().cloned()),
            Some(selected) if dx != 0 => {
                model::sideways(&columns, selected, dx).map(|(c, r)| columns[c][r].clone())
            }
            Some(selected) => columns.iter().find_map(|c| {
                let row = c.iter().position(|id| id == selected)?;
                let next = (row as isize + dy).clamp(0, c.len() as isize - 1) as usize;
                Some(c[next].clone())
            }),
        };
        if next.is_some() {
            self.select(next, window, cx);
        }
    }
    fn up(&mut self, _: &Up, window: &mut Window, cx: &mut Context<Self>) {
        self.step(0, -1, window, cx);
    }
    fn down(&mut self, _: &Down, window: &mut Window, cx: &mut Context<Self>) {
        self.step(0, 1, window, cx);
    }
    fn left(&mut self, _: &Left, window: &mut Window, cx: &mut Context<Self>) {
        self.step(-1, 0, window, cx);
    }
    fn right(&mut self, _: &Right, window: &mut Window, cx: &mut Context<Self>) {
        self.step(1, 0, window, cx);
    }
    fn open_selected(&mut self, _: &Open, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(id) = self.selected.clone() {
            self.activate(&id, true, window, cx);
        }
    }
    /// Reads the selected thread once the selection settles, only while the inspector shows it.
    fn read_thread(&mut self, settle: Duration, window: &mut Window, cx: &mut Context<Self>) {
        self.thread_task = None;
        let Some(id) = self.selected.clone() else {
            return;
        };
        if !self.open || !self.threads.needs_read(&id) {
            return;
        }
        let Some(options) = self.options.clone() else {
            return;
        };
        self.thread_task = Some(cx.spawn_in(window, async move |this, cx| {
            if !settle.is_zero() {
                cx.background_executor().timer(settle).await;
            }
            let read = id.clone();
            let Ok(started) = this.update(cx, |v, cx| {
                v.threads.set(&id, ThreadState::Loading);
                cx.notify();
                transport::spawn(
                    "local-slack-triage-thread",
                    Duration::from_secs(35),
                    move |client| async move { transport::thread(&client, &options, &read).await },
                )
            }) else {
                return;
            };
            let state = match started {
                Ok(rx) => match rx.recv().await {
                    Ok(Ok(thread)) => ThreadState::Loaded(thread),
                    Ok(Err(reason)) => ThreadState::Unavailable(reason),
                    Err(_) => ThreadState::Unavailable("Couldn't load this thread.".into()),
                },
                Err(reason) => ThreadState::Unavailable(reason.into()),
            };
            let _ = this.update(cx, |v, cx| {
                v.threads.set(&id, state);
                cx.notify();
            });
        }));
    }
    fn retry_thread(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(id) = self.selected.clone() {
            self.threads
                .set(&id, ThreadState::Unavailable(String::new()));
            self.read_thread(Duration::ZERO, window, cx);
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
        self.rebuild(window, cx);
        self.focus(window, cx);
    }
    fn set_tab(&mut self, tab: Status, window: &mut Window, cx: &mut Context<Self>) {
        self.tab = tab;
        self.rebuild(window, cx);
        self.list.update(cx, |l, cx| {
            l.scroll_handle()
                .restore_offset(gpui_kit::point(px(0.), px(0.)));
            l.focus(window, cx);
        });
    }

    #[cfg(feature = "native-probes")]
    pub(crate) fn probe_rows(&self) -> Vec<String> {
        self.visible.iter().map(|i| i.id.clone()).collect()
    }
    #[cfg(feature = "native-probes")]
    pub(crate) fn probe_column(&self, status: Status) -> Vec<String> {
        self.column(status)
            .iter()
            .map(|i| self.visible[*i].id.clone())
            .collect()
    }
    #[cfg(feature = "native-probes")]
    pub(crate) fn probe_thread(&self, id: &str) -> Option<ThreadState> {
        self.threads.get(id).cloned()
    }
}

impl SlackBoard {
    /// Status tabs (list) or the message count (board), then layout, filters and Sync.
    fn toolbar(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let filter = self.filter;
        let hidden = self
            .board
            .as_ref()
            .map_or(0, |b| b.hidden_count(filter.show_dismissed));
        let owner = cx.weak_entity();
        let filters = ui::icon_action(
            "slack-filter",
            if filter.show_hidden || filter.show_dismissed {
                "Filters (on)"
            } else {
                "Filters"
            },
            AppIcon::Filter,
            Action::Quiet,
        )
        .selected(filter.show_hidden || filter.show_dismissed)
        .dropdown_menu(move |mut menu, _, _| {
            let choose = |next: Filter| {
                let owner = owner.clone();
                move |_: &gpui_kit::ClickEvent, w: &mut Window, cx: &mut App| {
                    let _ = owner.update(cx, |v, cx| v.set_filter(next, w, cx));
                }
            };
            menu = menu.item(
                PopupMenuItem::new(SharedString::from(format!("Show hidden ({hidden})")))
                    .checked(filter.show_hidden)
                    .disabled(hidden == 0 && !filter.show_hidden)
                    .on_click(choose(Filter {
                        show_hidden: !filter.show_hidden,
                        ..filter
                    })),
            );
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
                .outline()
                .flex_none()
                .child(
                    Button::new("slack-layout-board")
                        .label("Board")
                        .selected(layout == Layout::Board)
                        .on_click(cx.listener(|v, _, w, cx| v.set_layout(Layout::Board, w, cx))),
                )
                .child(
                    Button::new("slack-layout-list")
                        .label("List")
                        .selected(layout == Layout::List)
                        .on_click(cx.listener(|v, _, w, cx| v.set_layout(Layout::List, w, cx))),
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
        let lead = if self.layout() == Layout::List && self.board.is_some() {
            self.status_tabs(cx).into_any_element()
        } else {
            let n = self.visible.len();
            caption(
                if self.board.is_none() {
                    String::new()
                } else if n == 1 {
                    "1 message".to_owned()
                } else {
                    format!("{n} messages")
                },
                cx,
            )
            .id("slack-count")
            .test_support()
            .into_any_element()
        };
        div()
            .id("slack-toolbar")
            .test_support()
            .h_flex()
            .w_full()
            .min_w_0()
            .items_center()
            .gap_2()
            .child(div().flex_1().min_w_0().child(lead))
            .children(switcher)
            .child(filters)
            .children(sync)
    }
    /// One tab per status: real buttons, so Tab and Return reach them, with an underline on
    /// the current one.
    fn status_tabs(&self, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .id("slack-status-tabs")
            .test_support()
            .h_flex()
            .items_end()
            .gap_1()
            .children(self.columns.iter().map(|(status, rows)| {
                let status = *status;
                let current = status == self.tab;
                div()
                    .v_flex()
                    .child(
                        Button::new(SharedString::from(format!("slack-tab-{}", status.wire())))
                            .ghost()
                            .small()
                            .label(SharedString::from(format!(
                                "{} {}",
                                status.title(),
                                rows.len()
                            )))
                            .accessibility_label(SharedString::from(format!(
                                "{}, {} messages{}",
                                status.title(),
                                rows.len(),
                                if current { ", selected" } else { "" }
                            )))
                            .on_click(cx.listener(move |v, _, w, cx| v.set_tab(status, w, cx))),
                    )
                    .child(
                        div()
                            .h(px(2.))
                            .mx(px(Space::CONTROL))
                            .rounded_full()
                            .when(current, |d| d.bg(cx.theme().foreground)),
                    )
            }))
    }
    fn notices(&self, cx: &App) -> Vec<AnyElement> {
        let mut out = Vec::new();
        if let Some(error) = self.error
            && self.board.is_some()
        {
            out.push(
                div()
                    .id("slack-stale")
                    .test_support()
                    .child(
                        Notice::new("Couldn't refresh Slack messages. Showing the last report.")
                            .detail(error)
                            .tone(Tone::Error),
                    )
                    .into_any_element(),
            );
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
                    caption(
                        named(
                            p,
                            format!(
                                "Showing the latest {} of {} messages.",
                                model::PROJECT_ITEMS,
                                p.active_total
                            ),
                        ),
                        cx,
                    )
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
        let item = self
            .selected
            .as_deref()
            .filter(|_| self.open)
            .and_then(|id| board.item(id));
        if let Some(item) = item
            && !self.beside()
        {
            return self.inspector(item, true, cx).into_any_element();
        }
        let main = match self.layout() {
            Layout::Board => self.board_view(cx).into_any_element(),
            Layout::List => self.list_view(),
        };
        let Some(item) = item else {
            return main;
        };
        div()
            .h_flex()
            .size_full()
            .min_h_0()
            .items_start()
            .child(div().flex_1().min_w_0().h_full().min_h_0().child(main))
            .child(
                div()
                    .id("slack-inspector")
                    .test_support()
                    .flex_none()
                    .w(px(INSPECTOR_WIDTH))
                    .h_full()
                    .min_h_0()
                    .ml(px(Space::SIDEBAR))
                    .pl(px(Space::SIDEBAR + Space::META))
                    .border_l_1()
                    .border_color(cx.theme().border)
                    .child(self.inspector(item, false, cx)),
            )
            .into_any_element()
    }
    fn list_view(&self) -> AnyElement {
        if self.column(self.tab).is_empty() {
            return div()
                .id("slack-empty")
                .test_support()
                .pt(px(Space::CONTROL))
                .child(
                    Notice::new(empty_column_copy(self.tab))
                        .detail("Messages from your Slack channels appear here after each sync.")
                        .tone(Tone::Quiet),
                )
                .into_any_element();
        }
        div()
            .id("slack-list")
            .test_support()
            .size_full()
            .min_w_0()
            .min_h_0()
            .child(List::new(&self.list))
            .into_any_element()
    }
    /// Columns of cards, Swift's board. Dragging a card to another column changes its status.
    fn board_view(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let many = self.names.len() > 1;
        let now = crate::usage_overview::now();
        div()
            .id("slack-board")
            .test_support()
            .track_focus(&self.board_focus)
            .key_context("SlackBoard")
            .on_action(cx.listener(Self::up))
            .on_action(cx.listener(Self::down))
            .on_action(cx.listener(Self::left))
            .on_action(cx.listener(Self::right))
            .on_action(cx.listener(Self::open_selected))
            .on_action(cx.listener(Self::close_detail))
            .h_flex()
            .size_full()
            .min_h_0()
            .items_start()
            .gap(px(Space::SIDEBAR))
            .overflow_x_scroll()
            .children(self.columns.iter().map(|(status, rows)| {
                let status = *status;
                let scroll =
                    &self.scrolls[Status::ALL.iter().position(|s| *s == status).unwrap_or(0)];
                div()
                    .id(SharedString::from(format!(
                        "slack-column-{}",
                        status.wire()
                    )))
                    .test_support()
                    .v_flex()
                    .flex_1()
                    .min_w(px(COLUMN_MIN))
                    .h_full()
                    .min_h_0()
                    .rounded(px(crate::appearance::Radius::CARD))
                    .bg(Surface::Tray.color(cx))
                    .drag_over::<DraggedCard>(|style, _, _, cx| style.bg(cx.theme().list_active))
                    .on_drop(cx.listener(move |v, card: &DraggedCard, w, cx| {
                        v.change(&card.id, Change::Status(status), w, cx)
                    }))
                    .child(
                        div()
                            .h_flex()
                            .items_center()
                            .gap(px(Space::CONTROL))
                            .px(px(Space::SIDEBAR))
                            .pt(px(Space::SIDEBAR))
                            .pb(px(Space::CONTROL))
                            .child(
                                ui::text(Text::Label, status.title())
                                    .font_medium()
                                    .text_color(cx.theme().foreground),
                            )
                            .child(caption(rows.len().to_string(), cx)),
                    )
                    .child(
                        div()
                            .id(SharedString::from(format!("slack-cards-{}", status.wire())))
                            .track_scroll(scroll)
                            .overflow_y_scroll()
                            .flex_1()
                            .min_h_0()
                            .v_flex()
                            .gap(px(Space::CONTROL))
                            .px(px(Space::CONTROL))
                            .pb(px(Space::CONTROL))
                            .when(rows.is_empty(), |d| {
                                d.child(
                                    div()
                                        .px(px(Space::META))
                                        .child(caption(empty_column_copy(status), cx)),
                                )
                            })
                            .children(rows.iter().map(|i| {
                                let item = &self.visible[*i];
                                self.card(item, many, now, cx)
                            })),
                    )
            }))
    }
    fn card(
        &self,
        item: &Item,
        many: bool,
        now: u64,
        cx: &mut Context<Self>,
    ) -> impl IntoElement + use<> {
        let selected = self.selected.as_deref() == Some(item.id.as_str());
        let t = &item.triage;
        let mut meta = Vec::new();
        if many && let Some(name) = self.names.get(&item.project_id) {
            meta.push(name.clone());
        }
        meta.push(item.channel());
        meta.push(model::ago(item.updated_at, now));
        match item.replies {
            Some(1) => meta.push("1 reply".into()),
            Some(n) if n > 1 => meta.push(format!("{n} replies")),
            _ => {}
        }
        let reason = (t.status_title() != t.status.title()).then(|| t.status_title());
        let id = item.id.clone();
        let hover = cx.theme().muted_foreground.opacity(0.4);
        let drag = DraggedCard {
            id: item.id.clone(),
            title: SharedString::from(item.title.clone()),
        };
        div()
            .id(SharedString::from(format!("slack-card-{}", item.id)))
            .test_support()
            .v_flex()
            .gap(px(Space::META))
            .w_full()
            .p(px(Space::SIDEBAR))
            .rounded(px(crate::appearance::Radius::CONTROL))
            .bg(if selected {
                ui::selected_fill(cx)
            } else {
                Surface::Card.color(cx)
            })
            .border_1()
            .border_color(if selected {
                cx.theme().muted_foreground.opacity(0.6)
            } else {
                cx.theme().border
            })
            .cursor_pointer()
            .hover(move |s| s.border_color(hover))
            .on_click(cx.listener(move |v, _, w, cx| {
                v.board_focus.focus(w, cx);
                v.activate(&id, false, w, cx);
            }))
            .on_drag(drag, |card, _, _, cx| cx.new(|_| card.clone()))
            .child(
                div()
                    .h_flex()
                    .items_center()
                    .gap(px(Space::CONTROL))
                    .child(severity_mark(t.severity, cx))
                    .child(caption(
                        format!("{} · {}", t.kind.title(), t.severity.title()),
                        cx,
                    ))
                    .when_some(t.label.as_deref(), |d, l| d.child(label_tag(l, cx))),
            )
            .child(
                ui::text(Text::Body, SharedString::from(item.title.clone()))
                    .line_clamp(2)
                    .text_color(cx.theme().foreground),
            )
            .child(caption(meta.join(" · "), cx).truncate())
            .when_some(reason, |d, r| d.child(caption(r, cx).truncate()))
    }
    /// One message: what it is, direct triage controls and the full thread.
    fn inspector(
        &self,
        item: &Item,
        back: bool,
        cx: &mut Context<Self>,
    ) -> impl IntoElement + use<> {
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
        let now = crate::usage_overview::now();
        let mut context = vec![item.channel()];
        if let Some(name) = self.names.get(&item.project_id) {
            context.insert(0, name.clone());
        }
        context.push(model::ago(item.updated_at, now));
        let chat = item
            .session_id
            .clone()
            .filter(|sid| self.chats.iter().any(|c| &c.id == sid));
        let url = crate::external_links::web(&item.url);
        let link = item.url.clone();
        // Quiet label/value rows: plain text that opens a checked menu on click.
        let owner = cx.weak_entity();
        let property = |key: &'static str,
                        title: &'static str,
                        value: String,
                        mark: Option<Severity>,
                        choices: Vec<(String, Change, bool)>| {
            let (owner, id) = (owner.clone(), id.clone());
            let group = SharedString::from(format!("slack-property-{key}"));
            let trigger = Button::new(SharedString::from(format!("slack-field-{key}")))
                .ghost()
                .small()
                .w_full()
                .disabled(pending)
                .accessibility_label(SharedString::from(format!("{title}: {value}")))
                .child(
                    div()
                        .h_flex()
                        .w_full()
                        .min_w_0()
                        .items_center()
                        .gap(px(Space::CONTROL))
                        .when_some(mark, |d, s| d.child(severity_mark(s, cx)))
                        .child(
                            ui::text(Text::Body, SharedString::from(value.clone()))
                                .flex_1()
                                .min_w_0()
                                .truncate(),
                        )
                        .child(
                            div()
                                .flex_none()
                                .opacity(0.)
                                .group_hover(group.clone(), |s| s.opacity(1.))
                                .text_color(cx.theme().muted_foreground)
                                .child(AppIcon::Expand.inline()),
                        ),
                )
                .dropdown_menu(move |mut menu, _, _| {
                    for (label, change, checked) in &choices {
                        let (owner, id, change) = (owner.clone(), id.clone(), change.clone());
                        menu = menu.item(
                            PopupMenuItem::new(SharedString::from(label.clone()))
                                .checked(*checked)
                                .on_click(move |_, w, cx| {
                                    let _ = owner
                                        .update(cx, |v, cx| v.change(&id, change.clone(), w, cx));
                                }),
                        );
                    }
                    menu
                });
            div()
                .group(group)
                .h_flex()
                .items_center()
                .gap(px(Space::CONTROL))
                .child(caption(title, cx).w(px(72.)).flex_none())
                .child(div().flex_1().min_w_0().child(trigger))
        };
        let status = property(
            "status",
            "Status",
            t.status.title().to_owned(),
            None,
            [
                Status::Open,
                Status::InProgress,
                Status::Waiting,
                Status::Done,
            ]
            .into_iter()
            .map(|s| (s.title().to_owned(), Change::Status(s), t.status == s))
            .collect(),
        );
        let severity = property(
            "severity",
            "Severity",
            t.severity.title().to_owned(),
            // Only signal severities carry a dot, so quiet values stay aligned.
            matches!(t.severity, Severity::Critical | Severity::High).then_some(t.severity),
            Severity::ALL
                .into_iter()
                .map(|s| (s.title().to_owned(), Change::Severity(s), t.severity == s))
                .collect(),
        );
        let kind = property(
            "type",
            "Type",
            t.kind.title().to_owned(),
            None,
            Kind::ALL
                .into_iter()
                .map(|k| (k.title().to_owned(), Change::Kind(k), t.kind == k))
                .collect(),
        );
        // A label's effect is named in the menu, since choosing it can hide or close the message.
        let mut label_choices = vec![(
            "No label".to_owned(),
            Change::Label(None),
            t.label.is_none(),
        )];
        label_choices.extend(labels.iter().map(|l| {
            let name = match l.effect {
                model::Effect::Hide => format!("{} (hidden from Inbox)", l.name),
                model::Effect::Close => format!("{} (closes it)", l.name),
                model::Effect::None => l.name.clone(),
            };
            (
                name,
                Change::Label(Some(l.name.clone())),
                t.label.as_deref() == Some(l.name.as_str()),
            )
        }));
        if let Some(current) = &t.label
            && !labels.iter().any(|l| &l.name == current)
        {
            label_choices.push((current.clone(), Change::Label(Some(current.clone())), true));
        }
        let label = property(
            "label",
            "Label",
            t.label.clone().unwrap_or_else(|| "None".into()),
            None,
            label_choices,
        );
        let mut notes: Vec<String> = Vec::new();
        if t.status_title() != t.status.title() {
            notes.push(t.status_title());
        }
        if item.started && t.status != Status::Done {
            notes.push("Marking it Done adds a done reaction in Slack.".into());
        }
        if let Some(note) = t.overridden_note() {
            notes.push(note);
        }
        let dismissed = t.status == Status::Dismissed;
        let next = if dismissed {
            Status::Open
        } else {
            Status::Dismissed
        };
        let dismiss_id = id.clone();
        let header = div()
            .h_flex()
            .items_center()
            .gap_1()
            .when(back, |d| {
                d.child(
                    ui::icon_action(
                        "slack-back",
                        "Back to messages",
                        AppIcon::Back,
                        Action::Quiet,
                    )
                    .on_click(cx.listener(|v, _, w, cx| v.close_detail(&CloseDetail, w, cx))),
                )
            })
            .child(
                div()
                    .h_flex()
                    .flex_1()
                    .min_w_0()
                    .items_center()
                    .gap(px(Space::CONTROL))
                    .child(severity_mark(t.severity, cx))
                    .child(caption(context.join(" · "), cx).truncate()),
            )
            .when_some(url, |d, url| {
                d.child(
                    ui::icon_action(
                        "slack-open",
                        "Open in Slack",
                        AppIcon::OpenLink,
                        Action::Quiet,
                    )
                    .on_click(move |_, _, cx| crate::external_links::open(&url, cx)),
                )
            })
            .child(
                ui::icon_action("slack-copy", "Copy link", AppIcon::Copy, Action::Quiet).on_click(
                    move |_, _, cx| cx.write_to_clipboard(ClipboardItem::new_string(link.clone())),
                ),
            )
            .when_some(chat, |d, sid| {
                d.child(
                    ui::icon_action(
                        "slack-open-chat",
                        "Open chat",
                        AppIcon::Chats,
                        Action::Quiet,
                    )
                    .on_click(
                        cx.listener(move |_, _, _, cx| cx.emit(BoardEvent::OpenChat(sid.clone()))),
                    ),
                )
            })
            .child({
                let (owner, id) = (cx.weak_entity(), dismiss_id.clone());
                ui::icon_action("slack-more", "More actions", AppIcon::More, Action::Quiet)
                    .dropdown_menu(move |menu, _, _| {
                        let (owner, id) = (owner.clone(), id.clone());
                        menu.item(
                            PopupMenuItem::new(if dismissed { "Restore" } else { "Dismiss" })
                                .disabled(pending)
                                .on_click(move |_, w, cx| {
                                    let _ = owner.update(cx, |v, cx| {
                                        v.change(&id, Change::Status(next), w, cx)
                                    });
                                }),
                        )
                    })
            })
            .when(!back, |d| {
                d.child(
                    ui::icon_action("slack-close", "Close", AppIcon::Close, Action::Quiet)
                        .on_click(cx.listener(|v, _, w, cx| v.close_detail(&CloseDetail, w, cx))),
                )
            });
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
            .gap(px(Space::CONTROL))
            .child(header)
            .child(
                div()
                    .id("slack-detail-body")
                    .test_support()
                    .v_flex()
                    .flex_1()
                    .min_h_0()
                    .gap(px(Space::SIDEBAR + Space::META))
                    .overflow_y_scroll()
                    .pb(px(Space::SECTION))
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
                        div()
                            .id("slack-properties")
                            .test_support()
                            .v_flex()
                            .gap(px(Space::META))
                            .child(status)
                            .child(severity)
                            .child(kind)
                            .child(label)
                            .when(!notes.is_empty(), |d| {
                                d.child(
                                    div()
                                        .v_flex()
                                        .gap(px(Space::META))
                                        .children(notes.into_iter().map(|n| caption(n, cx))),
                                )
                            })
                            .when_some(save.cloned(), |d, save| {
                                let (text, tone) = match save {
                                    Save::Pending(_) => ("Saving…".to_owned(), Tone::Quiet),
                                    Save::NotSent(r) | Save::Unknown(r) => (r, Tone::Error),
                                };
                                d.child(
                                    div()
                                        .id("slack-save")
                                        .test_support()
                                        .child(Notice::new(SharedString::from(text)).tone(tone)),
                                )
                            }),
                    )
                    .child(self.thread_view(item, cx)),
            )
    }
    /// The thread, parent first: who wrote each message, when, and its selectable text.
    fn thread_view(&self, item: &Item, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        let now = crate::usage_overview::now();
        let body = match self.threads.get(&item.id) {
            Some(ThreadState::Loaded(thread)) => (
                div()
                    .v_flex()
                    .gap(px(Space::SIDEBAR + Space::META))
                    .children(thread.messages.iter().enumerate().map(|(ix, m)| {
                        let when = m.at().map(|at| model::ago(at, now)).unwrap_or_default();
                        div()
                            .id(SharedString::from(format!("slack-message-{ix}")))
                            .test_support()
                            .v_flex()
                            .gap(px(Space::META))
                            .child(
                                div()
                                    .h_flex()
                                    .gap(px(Space::CONTROL))
                                    .items_center()
                                    .child(
                                        ui::text(
                                            Text::Label,
                                            SharedString::from(
                                                m.author
                                                    .clone()
                                                    .unwrap_or_else(|| "Someone".into()),
                                            ),
                                        )
                                        .font_medium(),
                                    )
                                    .child(caption(when, cx)),
                            )
                            .child(if m.text.is_empty() {
                                caption("No text, only attachments.", cx).into_any_element()
                            } else {
                                div()
                                    .w_full()
                                    .min_w_0()
                                    .text_size(px(Text::Body.size()))
                                    .child(SelectableText::new(
                                        SharedString::from(format!(
                                            "slack-text-{}-{}",
                                            item.id, m.ts
                                        )),
                                        SharedString::from(m.text.clone()),
                                    ))
                                    .into_any_element()
                            })
                            .when(m.truncated, |d| {
                                d.child(caption("The message continues in Slack.", cx))
                            })
                    }))
                    .when(thread.more, |d| {
                        d.child(caption("More replies are in Slack.", cx))
                    })
                    .into_any_element(),
                Some(thread.messages.len()),
            ),
            Some(ThreadState::Unavailable(reason)) if !reason.is_empty() => (
                div()
                    .v_flex()
                    .gap(px(Space::META))
                    .child(caption(reason.clone(), cx))
                    .child(
                        ui::action("slack-thread-retry", "Try again", Action::Quiet)
                            .self_start()
                            .on_click(cx.listener(|v, _, w, cx| v.retry_thread(w, cx))),
                    )
                    .into_any_element(),
                None,
            ),
            _ => (caption("Reading the thread…", cx).into_any_element(), None),
        };
        let (body, count) = body;
        div()
            .id("slack-thread")
            .test_support()
            .v_flex()
            .gap(px(Space::CONTROL))
            .pt(px(Space::SIDEBAR))
            .border_t_1()
            .border_color(cx.theme().border)
            .child(
                div()
                    .h_flex()
                    .items_center()
                    .gap(px(Space::CONTROL))
                    .child(
                        ui::text(Text::Label, "Thread")
                            .font_medium()
                            .text_color(cx.theme().foreground),
                    )
                    .children(count.map(|n| {
                        caption(
                            if n == 1 {
                                "1 message".to_owned()
                            } else {
                                format!("{n} messages")
                            },
                            cx,
                        )
                    })),
            )
            .child(body)
    }
}

impl Render for SlackBoard {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let wide = f32::from(window.viewport_size().width) >= WIDE;
        if wide != self.wide {
            self.wide = wide;
            self.rebuild(window, cx);
        }
        let notices = self.notices(cx);
        div()
            .id("slack-pane")
            .test_support()
            .v_flex()
            .size_full()
            .min_h_0()
            .min_w_0()
            .gap(px(Space::SIDEBAR))
            .child(self.toolbar(cx))
            .children(notices)
            .child(div().flex_1().min_h_0().min_w_0().child(self.body(cx)))
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn board_columns_fit_beside_the_inspector_only_in_wide_windows() {
        assert!(super::INSPECTOR_WIDTH + 2. * super::COLUMN_MIN < super::WIDE);
    }
}
