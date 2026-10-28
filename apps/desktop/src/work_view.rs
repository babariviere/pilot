//! Presentation only. Hidden argument/output parsers are never built or updated.
//!
//! A work group is one effects-first line with a ribbon of its top-level calls
//! on the right. While its run is live and the user has not chosen, its latest
//! steps show under the line. A ribbon cell opens just its call; the chevron
//! opens the full quiet list.
use crate::{
    app_icon::AppIcon,
    tool_presentation::{Cell, Kind, Mark, Status, Step, Tone, Unit, Work, sentence},
    transcript_view::TranscriptView,
};
use gpui_kit::{
    App, AppContext, ClipboardItem, Context, Entity, EventEmitter, FocusHandle, InteractiveElement,
    IntoElement, KeyBinding, ParentElement, Render, SharedString, StatefulInteractiveElement,
    Styled, Subscription, TestSupportExt, WeakEntity, Window,
    component::{
        ActiveTheme, Icon, IconName, Sizable, StyledExt,
        button::{Button, ButtonVariants},
        text::{TextView, TextViewState},
        tooltip::Tooltip,
    },
    div,
    prelude::FluentBuilder,
    px,
};
use std::{
    cell::RefCell,
    collections::{BTreeMap, BTreeSet},
    rc::Rc,
    sync::Arc,
};

gpui_kit::actions!(
    work_ribbon,
    [
        PreviousCall,
        NextCall,
        FirstCall,
        LastCall,
        OpenCall,
        CloseCall
    ]
);

/// Steps shown under a live line before "Show earlier" (D93; Swift shows 4).
pub(crate) const TAIL: usize = 5;
/// Executable source shows this many lines before "Show all".
const CODE_LINES: usize = 5;

pub(crate) fn bind_keys(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("left", PreviousCall, Some("WorkRibbon")),
        KeyBinding::new("right", NextCall, Some("WorkRibbon")),
        KeyBinding::new("home", FirstCall, Some("WorkRibbon")),
        KeyBinding::new("end", LastCall, Some("WorkRibbon")),
        KeyBinding::new("enter", OpenCall, Some("WorkRibbon")),
        KeyBinding::new("space", OpenCall, Some("WorkRibbon")),
        KeyBinding::new("escape", CloseCall, Some("WorkRibbon")),
        KeyBinding::new("escape", CloseCall, Some("WorkCall")),
    ]);
}

#[derive(Clone)]
pub(crate) enum Change {
    Step(String),
    Group(u64),
    Disclosure(String),
}
/// Explicit user intent, keyed by canonical calls rather than render IDs, so
/// it follows calls through merges, splits and virtualization.
#[derive(Default)]
struct Choices {
    sequence: u64,
    groups: BTreeMap<String, (u64, bool)>,
    /// Calls opened from the ribbon: one cell per group.
    selected: BTreeSet<String>,
    /// Calls of merged read steps the user opened.
    reads: BTreeSet<String>,
}
impl Choices {
    fn members(work: &Work) -> Vec<String> {
        let tools: Vec<_> = work
            .calls()
            .map(|tool| format!("call:{}", tool.id))
            .collect();
        if tools.is_empty() {
            vec![format!("note:{}", work.id)]
        } else {
            tools
        }
    }
    fn choice(&self, work: &Work) -> Option<bool> {
        Self::members(work)
            .iter()
            .filter_map(|id| self.groups.get(id))
            .max_by_key(|(seq, _)| *seq)
            .map(|(_, open)| *open)
    }
    fn open(&self, work: &Work) -> bool {
        // Activity/results update the line, never disclosure intent.
        self.choice(work).unwrap_or(false)
    }
    fn choose(&mut self, work: &Work, open: bool) {
        self.sequence += 1;
        for id in Self::members(work) {
            self.groups.insert(id, (self.sequence, open));
        }
    }
}
/// What shows under the line.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Mode {
    /// Only the line (plus a selected call or the first error).
    Folded,
    /// The latest steps of a live run, without a user choice.
    Tail,
    /// Every step, chosen by the user.
    List,
}
pub(crate) struct WorkUi {
    choices: Rc<RefCell<Choices>>,
    steps: BTreeMap<String, Entity<StepView>>,
    pub(crate) groups: BTreeMap<u64, Entity<WorkView>>,
    subscriptions: BTreeMap<String, Subscription>,
}
impl Default for WorkUi {
    fn default() -> Self {
        Self {
            choices: Rc::new(RefCell::new(Choices::default())),
            steps: BTreeMap::new(),
            groups: BTreeMap::new(),
            subscriptions: BTreeMap::new(),
        }
    }
}
fn step_id(step: &Step) -> String {
    match step {
        Step::Tool(tool) => format!("call:{}", tool.id),
        Step::Note { id, .. } => format!("note:{id}"),
    }
}
#[derive(Default)]
pub(crate) struct Caption {
    pub(crate) verb: String,
    pub(crate) subject: String,
    pub(crate) meta: String,
    pub(crate) status: String,
    pub(crate) error: bool,
    pub(crate) mono: bool,
}
/// The transcript's one-line disclosure: chevron, glyph, muted verb and subject.
pub(crate) fn disclosure(
    id: SharedString,
    caption: Caption,
    open: bool,
    icon: Option<AppIcon>,
    cx: &gpui_kit::App,
) -> Button {
    let title = [
        &caption.verb,
        &caption.subject,
        &caption.meta,
        &caption.status,
    ]
    .into_iter()
    .filter(|part| !part.is_empty())
    .cloned()
    .collect::<Vec<_>>()
    .join(" · ");
    Button::new(id)
        .ghost()
        .small()
        .w_full()
        .accessibility_label(title.clone())
        .tooltip(title)
        .child(
            div()
                .h_flex()
                .w_full()
                .min_w_0()
                .gap_1()
                .items_center()
                .child(
                    div()
                        .id("disclosure-leading")
                        .test_support()
                        .h_flex()
                        .flex_shrink_0()
                        .gap_1()
                        .items_center()
                        .child(chevron(open))
                        .when_some(icon, |this, icon| this.child(icon.inline())),
                )
                .child(
                    div()
                        .id("disclosure-text")
                        .test_support()
                        .flex_1()
                        .min_w_0()
                        .h_flex()
                        .gap_1()
                        .items_center()
                        .child(
                            crate::ui::text(crate::ui::Text::Label, caption.verb)
                                .flex_shrink_0()
                                .max_w(gpui_kit::relative(0.45))
                                .truncate()
                                .text_color(cx.theme().muted_foreground),
                        )
                        .child(
                            crate::ui::text(crate::ui::Text::Body, caption.subject)
                                .flex_1()
                                .min_w_0()
                                .truncate()
                                .text_color(cx.theme().foreground)
                                .when(caption.mono, |this| {
                                    this.font_family(cx.theme().mono_font_family.clone())
                                }),
                        ),
                )
                // Counts/status are separate nonshrinking slots: truncating a
                // long target or group summary must never erase a failure.
                .when(!caption.meta.is_empty(), |this| {
                    this.child(
                        crate::ui::text(crate::ui::Text::Label, caption.meta)
                            .flex_shrink_0()
                            .text_color(cx.theme().muted_foreground),
                    )
                })
                .when(!caption.status.is_empty(), |this| {
                    this.child(
                        crate::ui::text(crate::ui::Text::Label, caption.status)
                            .id("disclosure-status")
                            .test_support()
                            .flex_shrink_0()
                            .text_color(if caption.error {
                                cx.theme().danger
                            } else {
                                cx.theme().muted_foreground
                            }),
                    )
                }),
        )
}
fn chevron(open: bool) -> Icon {
    Icon::new(if open {
        IconName::ChevronDown
    } else {
        IconName::ChevronRight
    })
    .small()
}
fn kind_icon(kind: Kind) -> AppIcon {
    match kind {
        Kind::Read => AppIcon::Read,
        Kind::Edit => AppIcon::Edit,
        Kind::Command => AppIcon::Command,
        Kind::Script => AppIcon::Script,
        Kind::Search => AppIcon::Search,
        Kind::Fetch => AppIcon::Fetch,
        Kind::Other => AppIcon::Tool,
    }
}
impl WorkUi {
    pub(crate) fn parsers_ready(&self, cx: &gpui_kit::App) -> bool {
        self.steps.values().all(|step| {
            step.read(cx).bodies.values().all(|body| {
                body.state.read(cx).rendered_text().source()
                    == if body.plain {
                        escape(&body.shown)
                    } else {
                        body.shown.clone()
                    }
            })
        })
    }
    #[cfg(any(test, feature = "native-probes"))]
    pub(crate) fn step_info(&self, id: &str, cx: &gpui_kit::App) -> (bool, usize) {
        let step = self.steps[&format!("call:{id}")].read(cx);
        (step.open, step.bodies.len())
    }
    #[cfg(test)]
    pub(crate) fn body_state(
        &self,
        id: &str,
        label: &str,
        cx: &gpui_kit::App,
    ) -> Entity<TextViewState> {
        self.steps[&format!("call:{id}")].read(cx).bodies[label]
            .state
            .clone()
    }
    #[cfg(any(test, feature = "native-probes"))]
    pub(crate) fn group_open(&self, id: u64, cx: &gpui_kit::App) -> bool {
        self.groups[&id].read(cx).open()
    }
    #[cfg(test)]
    pub(crate) fn ribbon_focus(&self, id: u64, cx: &gpui_kit::App) -> FocusHandle {
        self.groups[&id].read(cx).focus.clone()
    }
    /// The group's mode and the step indices of its visible units.
    #[cfg(any(test, feature = "native-probes"))]
    pub(crate) fn group_shape(&self, id: u64, cx: &gpui_kit::App) -> (Mode, Vec<Vec<usize>>) {
        let view = self.groups[&id].read(cx);
        let mode = view.mode();
        let (units, _) = view.shown(mode);
        (
            mode,
            units.iter().map(|unit| unit.steps().to_vec()).collect(),
        )
    }
    pub(crate) fn sync(
        &mut self,
        works: Vec<Arc<Work>>,
        reset: bool,
        adopted: &BTreeMap<u64, (Entity<TextViewState>, Arc<String>)>,
        cx: &mut Context<TranscriptView>,
    ) {
        if reset {
            for step in self.steps.values() {
                let preview = step.read(cx).preview.clone();
                preview.update(cx, |v, cx| v.retire(cx));
            }
            *self = Self::default();
        }
        let mut step_ids = BTreeSet::new();
        let mut group_ids = BTreeSet::new();
        for work in works {
            group_ids.insert(work.id);
            let mut children = Vec::new();
            let mut selected_note = false;
            for step in &work.steps {
                let id = step_id(step);
                step_ids.insert(id.clone());
                let view = if let Some(view) = self.steps.get(&id) {
                    view.update(cx, |view, cx| view.set(step.clone(), work.active, cx));
                    view.clone()
                } else {
                    let owner = cx.weak_entity();
                    let preview = cx.new(|cx| crate::tool_diff_preview::Preview::new(owner, cx));
                    preview.update(cx, |v, cx| v.set(step, cx));
                    let view = cx.new(|_| StepView {
                        preview,
                        step: step.clone(),
                        active: work.active,
                        open: false,
                        full: BTreeSet::new(),
                        bodies: BTreeMap::new(),
                        subscriptions: Vec::new(),
                    });
                    let subscription = cx.subscribe(&view, |view, _, change: &Change, cx| {
                        view.work_changed(change, cx)
                    });
                    self.subscriptions
                        .insert(format!("step:{id}"), subscription);
                    self.steps.insert(id, view.clone());
                    view
                };
                if let Step::Note { id, .. } = step
                    && let Some((state, source)) = adopted.get(id)
                {
                    selected_note = true;
                    view.update(cx, |view, cx| {
                        view.adopt_note(state.clone(), source.clone(), cx)
                    });
                }
                children.push(view);
            }
            if selected_note {
                self.choices.borrow_mut().choose(&work, true);
            }
            if let Some(view) = self.groups.get(&work.id) {
                view.update(cx, |view, cx| {
                    if view.data != work {
                        let changed = shape(&view.data) != shape(&work);
                        view.data = work;
                        view.children = children;
                        if changed {
                            cx.emit(Change::Group(view.data.id));
                        }
                        cx.notify();
                    }
                });
            } else {
                let id = work.id;
                let choices = self.choices.clone();
                let owner = cx.weak_entity();
                let view = cx.new(|cx| WorkView {
                    owner,
                    data: work,
                    children,
                    choices,
                    focus: cx.focus_handle().tab_stop(true),
                    cursor: None,
                });
                self.subscriptions.insert(
                    format!("group:{id}"),
                    cx.subscribe(&view, |view, _, change: &Change, cx| {
                        view.work_changed(change, cx)
                    }),
                );
                self.groups.insert(id, view);
            }
        }
        self.steps.retain(|id, _| step_ids.contains(id));
        self.groups.retain(|id, _| group_ids.contains(id));
        self.subscriptions.retain(|key, _| {
            key.strip_prefix("step:")
                .is_some_and(|id| step_ids.contains(id))
                || key
                    .strip_prefix("group:")
                    .and_then(|id| id.parse::<u64>().ok())
                    .is_some_and(|id| group_ids.contains(&id))
        });
        let mut choices = self.choices.borrow_mut();
        choices.groups.retain(|id, _| {
            step_ids.contains(id)
                || id
                    .strip_prefix("note:")
                    .and_then(|id| id.parse::<u64>().ok())
                    .is_some_and(|id| group_ids.contains(&id))
        });
        choices.selected.retain(|id| step_ids.contains(id));
        choices.reads.retain(|id| step_ids.contains(id));
    }
}
/// What changes a group's height: its line, steps and ribbon, not output text.
fn shape(work: &Work) -> (bool, String, Vec<Unit>, Vec<Cell>, Option<String>) {
    (
        work.active,
        work.title.clone(),
        work.units(),
        work.cells(),
        work.first_error().map(|(_, text)| text),
    )
}
fn call_key(work: &Work, index: usize) -> Option<String> {
    match work.steps.get(index) {
        Some(Step::Tool(tool)) => Some(format!("call:{}", tool.id)),
        _ => None,
    }
}
pub(crate) struct WorkView {
    owner: WeakEntity<TranscriptView>,
    data: Arc<Work>,
    children: Vec<Entity<StepView>>,
    choices: Rc<RefCell<Choices>>,
    /// The ribbon's single tab stop; arrows move the cursor between cells.
    focus: FocusHandle,
    /// The keyboard cursor's cell, by its first call.
    cursor: Option<String>,
}
impl EventEmitter<Change> for WorkView {}
impl WorkView {
    /// Stop tail following before the first changed frame can measure the
    /// group. An emitted event is delivered after that frame in native pointer
    /// dispatch, too late to retain the clicked line's anchor.
    fn hold(&self, cx: &mut Context<Self>) {
        let change = Change::Disclosure(format!("group:{}", self.data.id));
        let _ = self
            .owner
            .update(cx, |owner, cx| owner.work_changed(&change, cx));
    }
    fn choose(&mut self, open: bool, cx: &mut Context<Self>) {
        if !open {
            for step in &self.children {
                let preview = step.read(cx).preview.clone();
                preview.update(cx, |v, cx| v.retire(cx));
            }
        }
        self.hold(cx);
        self.choices.borrow_mut().choose(&self.data, open);
        cx.notify();
    }
    fn open(&self) -> bool {
        self.choices.borrow().open(&self.data)
    }
    pub(crate) fn mode(&self) -> Mode {
        match self.choices.borrow().choice(&self.data) {
            Some(true) => Mode::List,
            Some(false) => Mode::Folded,
            None if self.data.active => Mode::Tail,
            None => Mode::Folded,
        }
    }
    /// Units under the line, oldest first, and how many earlier ones are hidden.
    /// The chosen full list shows every step on its own: completing reads
    /// never restructure what the user opened and is reading.
    fn shown(&self, mode: Mode) -> (Vec<Unit>, usize) {
        match mode {
            Mode::Folded => (Vec::new(), 0),
            Mode::List => ((0..self.data.steps.len()).map(Unit::Step).collect(), 0),
            Mode::Tail => {
                let mut units = self.data.units();
                let hidden = units.len().saturating_sub(TAIL);
                (units.split_off(hidden), hidden)
            }
        }
    }
    fn selected_cell(&self, cells: &[Cell]) -> Option<usize> {
        let choices = self.choices.borrow();
        cells.iter().position(|cell| {
            cell.steps.iter().any(|index| {
                call_key(&self.data, *index).is_some_and(|key| choices.selected.contains(&key))
            })
        })
    }
    fn cell_of(&self, cells: &[Cell], key: &str) -> Option<usize> {
        cells.iter().position(|cell| {
            cell.steps
                .iter()
                .any(|index| call_key(&self.data, *index).as_deref() == Some(key))
        })
    }
    /// Opens just this cell's calls, or closes them when already open.
    fn toggle_cell(&mut self, key: String, cx: &mut Context<Self>) {
        let cells = self.data.cells();
        let target = self.cell_of(&cells, &key);
        let selected = self.selected_cell(&cells);
        self.select(if target == selected { None } else { target }, cx);
    }
    fn select(&mut self, target: Option<usize>, cx: &mut Context<Self>) {
        let cells = self.data.cells();
        let prior = self.selected_cell(&cells);
        if prior == target {
            return;
        }
        self.hold(cx);
        let keys = |cell: &Cell| -> Vec<String> {
            cell.steps
                .iter()
                .filter_map(|index| call_key(&self.data, *index))
                .collect()
        };
        if let Some(prior) = prior {
            let cell = &cells[prior];
            let mut choices = self.choices.borrow_mut();
            for key in keys(cell) {
                choices.selected.remove(&key);
            }
            drop(choices);
            if let [index] = cell.steps[..] {
                self.children[index].update(cx, |step, cx| step.set_open(false, cx));
            }
        }
        if let Some(target) = target {
            let cell = &cells[target];
            let mut choices = self.choices.borrow_mut();
            choices.selected.extend(keys(cell));
            // A call inside merged reads opens its sentence too.
            for unit in self.data.units() {
                if let Unit::Reads(items) = &unit
                    && cell.steps.iter().any(|index| items.contains(index))
                {
                    choices
                        .reads
                        .extend(items.iter().filter_map(|i| call_key(&self.data, *i)));
                }
            }
            drop(choices);
            if let [index] = cell.steps[..] {
                self.children[index].update(cx, |step, cx| step.set_open(true, cx));
            }
            self.cursor = keys(cell).into_iter().next();
        }
        cx.notify();
    }
    /// Open when chosen, or while one of its calls is open, so an opened call
    /// never disappears into a sentence when its read completes and merges.
    fn reads_open(&self, items: &[usize], cx: &App) -> bool {
        let choices = self.choices.borrow();
        items.iter().any(|index| {
            call_key(&self.data, *index).is_some_and(|key| choices.reads.contains(&key))
                || self
                    .children
                    .get(*index)
                    .is_some_and(|step| step.read(cx).open)
        })
    }
    fn toggle_reads(&mut self, items: Vec<usize>, cx: &mut Context<Self>) {
        let open = !self.reads_open(&items, cx);
        self.hold(cx);
        let mut choices = self.choices.borrow_mut();
        for key in items
            .iter()
            .filter_map(|index| call_key(&self.data, *index))
        {
            if open {
                choices.reads.insert(key);
            } else {
                choices.reads.remove(&key);
            }
        }
        drop(choices);
        if !open {
            for index in &items {
                self.children[*index].update(cx, |step, cx| step.set_open(false, cx));
            }
        }
        cx.notify();
    }
    fn cursor_index(&self, cells: &[Cell]) -> usize {
        self.cursor
            .as_deref()
            .and_then(|key| self.cell_of(cells, key))
            .or_else(|| self.selected_cell(cells))
            .unwrap_or(cells.len().saturating_sub(1))
    }
    fn move_cursor(&mut self, to: impl FnOnce(usize, usize) -> usize, cx: &mut Context<Self>) {
        let cells = self.data.cells();
        if cells.is_empty() {
            return;
        }
        let next = to(self.cursor_index(&cells), cells.len()).min(cells.len() - 1);
        self.cursor = call_key(&self.data, cells[next].steps[0]);
        cx.notify();
    }
    fn open_cursor(&mut self, cx: &mut Context<Self>) {
        let cells = self.data.cells();
        if cells.is_empty() {
            return;
        }
        let index = self.cursor_index(&cells);
        self.select(Some(index), cx);
    }
    /// Escape closes the opened call and returns focus to its ribbon cell.
    fn close_call(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let cells = self.data.cells();
        let Some(selected) = self.selected_cell(&cells) else {
            cx.propagate();
            return;
        };
        self.cursor = call_key(&self.data, cells[selected].steps[0]);
        self.select(None, cx);
        window.focus(&self.focus, cx);
    }
    fn line(&self, mode: Mode, cx: &mut Context<Self>) -> Button {
        let segments = self.data.line();
        let mut text = div()
            .id("disclosure-text")
            .test_support()
            .flex_1()
            .min_w_0()
            .h_flex()
            .gap_1()
            .items_center()
            .overflow_hidden();
        for (index, segment) in segments.into_iter().enumerate() {
            // The faint counts and the live sentence give way first; edited
            // names keep at least half the line; diff counts and failures never
            // truncate, so a failure stays readable at any width.
            let shrink = segment.tone == Tone::Faint
                || (segment.tone == Tone::Muted && index > 0 && !segment.text.starts_with('+'));
            let label = if index == 0 {
                segment.text
            } else {
                format!("· {}", segment.text)
            };
            let part = crate::ui::text(crate::ui::Text::Label, label)
                .text_color(match segment.tone {
                    Tone::Strong => cx.theme().foreground,
                    Tone::Danger => cx.theme().danger,
                    Tone::Muted | Tone::Faint => cx.theme().muted_foreground,
                })
                .when(segment.tone == Tone::Faint, |this| this.opacity(0.75))
                .map(|this| {
                    if segment.tone == Tone::Strong {
                        this.flex_shrink_0()
                            .max_w(gpui_kit::relative(0.5))
                            .truncate()
                    } else if shrink {
                        this.min_w_0().truncate()
                    } else {
                        this.flex_shrink_0()
                    }
                });
            text = text.child(if segment.tone == Tone::Danger {
                part.id("disclosure-status")
                    .test_support()
                    .into_any_element()
            } else {
                part.into_any_element()
            });
        }
        let title = SharedString::from(self.data.title.clone());
        Button::new(SharedString::from(format!("work-toggle-{}", self.data.id)))
            .ghost()
            .small()
            .w_full()
            .accessibility_label(title.clone())
            .tooltip(title)
            .child(
                div()
                    .h_flex()
                    .w_full()
                    .min_w_0()
                    .gap_1()
                    .items_center()
                    .child(chevron(mode != Mode::Folded))
                    .child(text),
            )
            .on_click(cx.listener(|view, _, _, cx| {
                let open = view.mode() == Mode::Folded;
                view.choose(open, cx);
            }))
    }
    fn ribbon(&self, cells: &[Cell], window: &Window, cx: &mut Context<Self>) -> impl IntoElement {
        let selected = self.selected_cell(cells);
        let cursor = self
            .focus
            .is_focused(window)
            .then(|| self.cursor_index(cells));
        let mut ribbon = div()
            .id(("work-ribbon", self.data.id))
            .test_support()
            .track_focus(&self.focus)
            .key_context("WorkRibbon")
            .on_action(cx.listener(|view, _: &PreviousCall, _, cx| {
                view.move_cursor(|at, _| at.saturating_sub(1), cx)
            }))
            .on_action(
                cx.listener(|view, _: &NextCall, _, cx| view.move_cursor(|at, _| at + 1, cx)),
            )
            .on_action(cx.listener(|view, _: &FirstCall, _, cx| view.move_cursor(|_, _| 0, cx)))
            .on_action(
                cx.listener(|view, _: &LastCall, _, cx| view.move_cursor(|_, len| len - 1, cx)),
            )
            .on_action(cx.listener(|view, _: &OpenCall, _, cx| view.open_cursor(cx)))
            .on_action(cx.listener(|view, _: &CloseCall, window, cx| view.close_call(window, cx)))
            .flex_shrink_0()
            .max_w(gpui_kit::relative(0.5))
            .h_flex()
            .flex_wrap()
            .justify_end()
            .items_center()
            .gap(px(4.));
        for (index, cell) in cells.iter().enumerate() {
            ribbon =
                ribbon.child(self.cell(cell, selected == Some(index), cursor == Some(index), cx));
        }
        ribbon
    }
    fn cell(
        &self,
        cell: &Cell,
        selected: bool,
        cursor: bool,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let key = call_key(&self.data, cell.steps[0]).unwrap_or_default();
        let theme = cx.theme();
        let (icon, color, wash) = match cell.mark {
            Mark::Failed => (AppIcon::Error, theme.danger, theme.danger.opacity(0.12)),
            Mark::Live => (
                AppIcon::Working,
                theme.foreground,
                theme.muted_foreground.opacity(0.08),
            ),
            Mark::Unknown => (
                AppIcon::Info,
                theme.muted_foreground,
                theme.muted_foreground.opacity(0.08),
            ),
            Mark::Done => (
                kind_icon(cell.kind),
                theme.muted_foreground,
                theme.muted_foreground.opacity(0.08),
            ),
        };
        let wash = if selected || cursor {
            match cell.mark {
                Mark::Failed => theme.danger.opacity(0.2),
                _ => theme.muted_foreground.opacity(0.2),
            }
        } else {
            wash
        };
        let tip = cell
            .steps
            .iter()
            .filter_map(|index| match self.data.steps.get(*index) {
                Some(Step::Tool(tool)) => Some(tool),
                _ => None,
            })
            .take(8)
            .map(|tool| {
                let status = match self.data.mark(tool) {
                    Mark::Failed => " · Failed",
                    Mark::Unknown => " · Status unknown",
                    Mark::Live => " · Running…",
                    Mark::Done => "",
                };
                format!("{}{status}", sentence(tool))
            })
            .chain((cell.steps.len() > 8).then(|| format!("{} more", cell.steps.len() - 8)))
            .collect::<Vec<_>>()
            .join("\n");
        let count = cell.steps.len();
        div()
            .id(SharedString::from(format!("work-cell-{key}")))
            .test_support()
            .relative()
            .h(px(20.))
            .min_w(px(22.))
            .px(px(4.))
            .h_flex()
            .items_center()
            .justify_center()
            .gap(px(2.))
            .rounded(px(5.))
            .border_1()
            .border_color(if cursor {
                theme.muted_foreground
            } else {
                gpui_kit::transparent_black()
            })
            .bg(wash)
            .text_color(color)
            .cursor_pointer()
            .child(icon.inline())
            .when(count > 1, |this| {
                this.child(crate::ui::text(crate::ui::Text::Caption, count.to_string()))
            })
            .when(selected, |this| {
                this.child(
                    div()
                        .absolute()
                        .left(px(4.))
                        .right(px(4.))
                        .bottom(px(-4.))
                        .h(px(2.))
                        .rounded(px(1.))
                        .bg(theme.foreground),
                )
            })
            .tooltip(move |window, cx| Tooltip::new(tip.clone()).build(window, cx))
            .on_click(cx.listener(move |view, _, _, cx| {
                view.cursor = Some(key.clone());
                view.toggle_cell(key.clone(), cx);
            }))
    }
    fn reads_row(&self, items: &[usize], cx: &mut Context<Self>) -> impl IntoElement + use<> {
        let open = self.reads_open(items, cx);
        let first = call_key(&self.data, items[0]).unwrap_or_default();
        let mut names: Vec<&str> = Vec::new();
        for index in items {
            if let Some(Step::Tool(tool)) = self.data.steps.get(*index) {
                for name in tool.subject.split(", ").filter(|name| !name.is_empty()) {
                    if !names.contains(&name) {
                        names.push(name);
                    }
                }
            }
        }
        let shown = names.len().min(2);
        let mut row = div().v_flex().gap_2().min_w_0().child(
            disclosure(
                SharedString::from(format!("reads-toggle-{first}")),
                Caption {
                    verb: "Read".into(),
                    subject: names[..shown].join(", "),
                    meta: if names.len() > shown {
                        format!("+{} more", names.len() - shown)
                    } else {
                        String::new()
                    },
                    mono: true,
                    ..Default::default()
                },
                open,
                Some(AppIcon::Read),
                cx,
            )
            .on_click(cx.listener({
                let items = items.to_vec();
                move |view, _, _, cx| view.toggle_reads(items.clone(), cx)
            })),
        );
        if open {
            let mut list = div().v_flex().gap_2().pl_4().min_w_0();
            for index in items {
                list = list.child(self.children[*index].clone());
            }
            row = row.child(list);
        }
        row
    }
}
impl Render for WorkView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let mode = self.mode();
        let cells = self.data.cells();
        let selected = self.selected_cell(&cells);
        let (units, hidden) = self.shown(mode);
        let mut visible = BTreeSet::new();
        for unit in &units {
            match unit {
                Unit::Step(index) => {
                    visible.insert(*index);
                }
                Unit::Reads(items) if self.reads_open(items, cx) => {
                    visible.extend(items.iter().copied())
                }
                Unit::Reads(_) => {}
            }
        }
        let mut header = div()
            .h_flex()
            .w_full()
            .min_w_0()
            .items_center()
            .gap_2()
            .child(div().flex_1().min_w_0().child(self.line(mode, cx)));
        if !cells.is_empty() {
            header = header.child(self.ribbon(&cells, window, cx));
        }
        let mut root = div().v_flex().gap_2().w_full().min_w_0().child(header);
        // A folded, finished group keeps its first error readable.
        if mode == Mode::Folded
            && selected.is_none()
            && self.choices.borrow().choice(&self.data).is_none()
            && let Some((index, error)) = self.data.first_error()
        {
            let key = call_key(&self.data, index).unwrap_or_default();
            root = root.child(
                div()
                    .id(("work-first-error", self.data.id))
                    .test_support()
                    .pl_4()
                    .min_w_0()
                    .truncate()
                    .text_xs()
                    .font_family(cx.theme().mono_font_family.clone())
                    .text_color(cx.theme().danger)
                    .cursor_pointer()
                    .child(error)
                    .on_click(cx.listener(move |view, _, _, cx| {
                        view.cursor = Some(key.clone());
                        view.toggle_cell(key.clone(), cx);
                    })),
            );
        }
        let extra: Vec<usize> = selected
            .map(|cell| {
                cells[cell]
                    .steps
                    .iter()
                    .copied()
                    .filter(|index| !visible.contains(index))
                    .collect()
            })
            .unwrap_or_default();
        if units.is_empty() && extra.is_empty() {
            return root;
        }
        let mut steps = div()
            .v_flex()
            .gap_2()
            .pl_4()
            .border_l_1()
            .border_color(cx.theme().border)
            .min_w_0();
        if selected.is_some() {
            steps = steps.key_context("WorkCall").on_action(
                cx.listener(|view, _: &CloseCall, window, cx| view.close_call(window, cx)),
            );
        }
        if hidden > 0 {
            steps = steps.child(
                Button::new(("work-earlier", self.data.id))
                    .ghost()
                    .small()
                    .self_start()
                    .child(
                        crate::ui::text(
                            crate::ui::Text::Label,
                            format!(
                                "Show {hidden} earlier step{}",
                                if hidden == 1 { "" } else { "s" }
                            ),
                        )
                        .text_color(cx.theme().muted_foreground),
                    )
                    .on_click(cx.listener(|view, _, _, cx| view.choose(true, cx))),
            );
        }
        for unit in &units {
            steps = match unit {
                Unit::Step(index) => steps.child(self.children[*index].clone()),
                Unit::Reads(items) => steps.child(self.reads_row(items, cx)),
            };
        }
        for index in extra {
            steps = steps.child(self.children[index].clone());
        }
        root.child(steps)
    }
}
fn escape(text: &str) -> String {
    format!(
        "<pre>{}</pre>",
        text.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
    )
}
struct Body {
    /// The exact source, for copy.
    source: Arc<String>,
    /// What the parser holds: the source, or its first lines while folded.
    shown: String,
    state: Entity<TextViewState>,
    plain: bool,
}

pub(crate) struct StepView {
    preview: Entity<crate::tool_diff_preview::Preview>,
    step: Step,
    /// The group follows a live run, so live calls read as running.
    active: bool,
    open: bool,
    /// Executable sources the user unfolded past their first lines.
    full: BTreeSet<&'static str>,
    bodies: BTreeMap<&'static str, Body>,
    subscriptions: Vec<Subscription>,
}
impl EventEmitter<Change> for StepView {}
impl StepView {
    fn adopt_note(
        &mut self,
        state: Entity<TextViewState>,
        source: Arc<String>,
        cx: &mut Context<Self>,
    ) {
        if self.bodies.contains_key("Note") {
            return;
        }
        self.subscriptions.push(cx.observe(&state, |view, _, cx| {
            view.changed(cx);
            cx.notify();
        }));
        self.bodies.insert(
            "Note",
            Body {
                shown: source.as_ref().clone(),
                source,
                state,
                plain: false,
            },
        );
        self.open = true;
        cx.notify();
    }
    fn changed(&self, cx: &mut Context<Self>) {
        cx.emit(Change::Step(step_id(&self.step)));
    }
    fn set_open(&mut self, open: bool, cx: &mut Context<Self>) {
        if self.open != open {
            self.open = open;
            cx.notify();
        }
    }
    fn set(&mut self, step: Step, active: bool, cx: &mut Context<Self>) {
        if self.step != step || self.active != active {
            if self.step != step {
                self.preview.update(cx, |v, cx| v.set(&step, cx));
            }
            let layout = self.open;
            self.step = step;
            self.active = active;
            if layout {
                self.changed(cx);
            }
            cx.notify();
        }
    }
    fn body(
        &mut self,
        label: &'static str,
        source: Arc<String>,
        plain: bool,
        cx: &mut Context<Self>,
    ) -> impl IntoElement + use<> {
        let lines = source.lines().count();
        let folded =
            matches!(label, "Code" | "Command") && lines > CODE_LINES && !self.full.contains(label);
        let shown = if folded {
            source
                .lines()
                .take(CODE_LINES)
                .collect::<Vec<_>>()
                .join("\n")
        } else {
            source.as_ref().clone()
        };
        let changed = self
            .bodies
            .get(label)
            .is_none_or(|body| body.source != source || body.shown != shown);
        if changed {
            let parsed = if plain { escape(&shown) } else { shown.clone() };
            if let Some(body) = self.bodies.get_mut(label) {
                body.source = source.clone();
                body.shown = shown;
                body.state
                    .update(cx, |state, cx| state.set_text(&parsed, cx));
            } else {
                let state = cx.new(|cx| {
                    (if plain {
                        TextViewState::html(&parsed, cx)
                    } else {
                        TextViewState::markdown(&parsed, cx)
                    })
                    .images_enabled(false)
                    .retain_selection_on_unmount(true, cx)
                });
                self.subscriptions.push(cx.observe(&state, |view, _, cx| {
                    view.changed(cx);
                    cx.notify();
                }));
                self.bodies.insert(
                    label,
                    Body {
                        source: source.clone(),
                        shown,
                        state,
                        plain,
                    },
                );
            }
        }
        let state = self.bodies[label].state.clone();
        let id = step_id(&self.step);
        let language = match (&self.step, label) {
            (Step::Tool(tool), "Code") if tool.name == "codemode" => "JavaScript · ",
            (_, "Command") => "Shell · ",
            _ => "",
        };
        let detail = matches!(label, "Code" | "Command").then(|| {
            format!(
                "{language}{lines} line{}",
                if lines == 1 { "" } else { "s" }
            )
        });
        div()
            .v_flex()
            .gap_1()
            .min_w_0()
            .child(
                div()
                    .h_flex()
                    .gap_2()
                    .items_center()
                    .child(
                        div()
                            .text_xs()
                            .text_color(cx.theme().muted_foreground)
                            .child(label),
                    )
                    .when_some(detail, |this, detail| {
                        this.child(
                            div()
                                .text_xs()
                                .text_color(cx.theme().muted_foreground)
                                .opacity(0.75)
                                .child(detail),
                        )
                    })
                    .child(div().flex_1())
                    .child(
                        Button::new(SharedString::from(format!("copy-{id}-{label}")))
                            .ghost()
                            .small()
                            .icon(AppIcon::Copy.asset())
                            .accessibility_label(SharedString::from(format!(
                                "Copy {}",
                                label.to_lowercase()
                            )))
                            .tooltip(SharedString::from(format!("Copy {}", label.to_lowercase())))
                            .on_click(move |_, _, cx| {
                                cx.write_to_clipboard(ClipboardItem::new_string(
                                    source.as_ref().clone(),
                                ))
                            }),
                    ),
            )
            .child(
                div()
                    .id(SharedString::from(format!("body-{id}-{label}")))
                    .test_support()
                    .max_h(px(260.))
                    .overflow_y_scroll()
                    .min_w_0()
                    .when(plain, |this| {
                        this.p(px(10.))
                            .bg(crate::appearance::code(cx))
                            .rounded(px(crate::appearance::Radius::CONTROL))
                            .border_1()
                            .border_color(cx.theme().border)
                    })
                    .child(
                        crate::typography::rich(
                            TextView::new(&state),
                            crate::typography::current(cx),
                            if plain {
                                crate::typography::Content::Code
                            } else {
                                crate::typography::Content::Chat
                            },
                            cx,
                        )
                        .selectable(true)
                        .scrollable(false)
                        .on_link_click(|_, _, _, _| {}),
                    ),
            )
            .when(folded, |this| {
                this.child(
                    Button::new(SharedString::from(format!("show-all-{id}-{label}")))
                        .ghost()
                        .small()
                        .self_start()
                        .label(format!("Show all {lines} lines"))
                        .on_click(cx.listener(move |view, _, _, cx| {
                            view.full.insert(label);
                            cx.emit(Change::Disclosure(step_id(&view.step)));
                            cx.notify();
                        })),
                )
            })
    }
}
impl Render for StepView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let id = step_id(&self.step);
        // A live call outside a live run has an unknown outcome.
        let stale = matches!(&self.step, Step::Tool(tool) if tool.status.live()) && !self.active;
        let (caption, limited) = match &self.step {
            Step::Tool(tool) => (
                Caption {
                    verb: tool.title.clone(),
                    subject: if tool.diff.is_empty() || tool.name == "codemode" {
                        tool.subject.clone()
                    } else {
                        String::new()
                    },
                    meta: [
                        tool.meta.clone(),
                        if tool.additions + tool.deletions > 0 {
                            format!(
                                "{}+{} −{}",
                                if tool.limited { "shown " } else { "" },
                                tool.additions,
                                tool.deletions
                            )
                        } else {
                            String::new()
                        },
                    ]
                    .into_iter()
                    .filter(|part| !part.is_empty())
                    .collect::<Vec<_>>()
                    .join(" · "),
                    status: if stale {
                        Status::Interrupted.label().into()
                    } else {
                        tool.status.label().into()
                    },
                    error: tool.status == Status::Error,
                    mono: matches!(
                        tool.kind,
                        Kind::Read | Kind::Edit | Kind::Command | Kind::Script | Kind::Search
                    ) && !(tool.name == "codemode" && tool.subject.is_empty()),
                },
                tool.limited,
            ),
            Step::Note {
                thinking,
                streaming,
                ..
            } => (
                Caption {
                    verb: (if *thinking {
                        if *streaming { "Thinking…" } else { "Thought" }
                    } else {
                        "Note"
                    })
                    .into(),
                    ..Default::default()
                },
                false,
            ),
        };
        let icon = match &self.step {
            Step::Tool(_) if caption.error => Some(AppIcon::Error),
            Step::Tool(tool) if tool.status.live() && self.active => Some(AppIcon::Working),
            Step::Tool(tool) => Some(kind_icon(tool.kind)),
            Step::Note { .. } => None,
        };
        let mut root = div().v_flex().gap_2().min_w_0().w_full().child(
            div()
                .h_flex()
                .min_w_0()
                .items_center()
                .child(
                    div().flex_1().min_w_0().child(
                        disclosure(
                            SharedString::from(format!("step-toggle-{id}")),
                            caption,
                            self.open,
                            icon,
                            cx,
                        )
                        .on_click(cx.listener(|view, _, _, cx| {
                            view.open = !view.open;
                            cx.emit(Change::Disclosure(step_id(&view.step)));
                            cx.notify();
                        })),
                    ),
                )
                .child(self.preview.clone()),
        );
        if self.open {
            let step = self.step.clone();
            let mut details = div().v_flex().gap_2().pl_4().min_w_0();
            match step {
                Step::Tool(tool) => {
                    if let Some((label, source)) = &tool.input {
                        details = details.child(self.body(label, source.clone(), true, cx));
                    }
                    if !tool.diff.is_empty() {
                        details = details.child(self.body(
                            "Replacement / patch preview",
                            tool.diff.clone(),
                            true,
                            cx,
                        ));
                    }
                    if !tool.output.is_empty() {
                        details = details.child(self.body("Output", tool.output.clone(), true, cx));
                    }
                    if !tool.arguments.is_empty() {
                        if tool.input.is_some() {
                            // For executable source, the JSON envelope is
                            // metadata, not a reading surface: copy only.
                            let arguments = tool.arguments.clone();
                            details = details.child(
                                Button::new(SharedString::from(format!("copy-{id}-Arguments")))
                                    .ghost()
                                    .small()
                                    .self_start()
                                    .icon(AppIcon::Copy.asset())
                                    .label("Copy arguments")
                                    .tooltip("Copy the call's JSON arguments")
                                    .on_click(move |_, _, cx| {
                                        cx.write_to_clipboard(ClipboardItem::new_string(
                                            arguments.as_ref().clone(),
                                        ))
                                    }),
                            );
                        } else {
                            details = details.child(self.body(
                                "Arguments",
                                tool.arguments.clone(),
                                true,
                                cx,
                            ));
                        }
                    }
                }
                Step::Note { text, .. } => {
                    details = details.child(self.body("Note", text, false, cx));
                }
            }
            if limited {
                details = details.child(
                    div()
                        .text_xs()
                        .text_color(cx.theme().muted_foreground)
                        .child(
                            "Details are bounded. Some content was not retained by this viewer.",
                        ),
                );
            }
            root = root.child(details);
        }
        root
    }
}

#[cfg(test)]
mod preview_tests {
    use super::*;
    use crate::local_model::LiveTranscript;
    use serde_json::json;

    #[test]
    fn activity_and_results_never_choose_group_disclosure() {
        let mut model = LiveTranscript::default();
        model.apply(&json!({"type":"entry_appended","entry":{"id":20,"kind":"pi.assistant","model":[{"role":"assistant","content":[{"type":"toolCall","id":"stable","name":"read","arguments":{"path":"synthetic.rs"}}]}]}}));
        let mut work = model.rows()[0].work_data().unwrap().as_ref().clone();
        let mut choices = Choices::default();
        for choice in [None, Some(true), Some(false)] {
            if let Some(open) = choice {
                choices.choose(&work, open);
            }
            for (active, failures, uncertain) in
                [(true, 0, 0), (false, 0, 0), (true, 1, 1), (false, 1, 1)]
            {
                work.active = active;
                work.failures = failures;
                work.uncertain = uncertain;
                assert_eq!(
                    choices.open(&work),
                    choice.unwrap_or(false),
                    "activity/results must not choose disclosure"
                );
            }
        }
    }

    #[test]
    fn choices_follow_canonical_calls_through_merge_split_and_new_render_ids() {
        let mut model = LiveTranscript::default();
        model.apply(&json!({"type":"entry_appended","entry":{"id":20,"kind":"pi.assistant","model":[{"role":"assistant","content":[{"type":"toolCall","id":"a","name":"read","arguments":{}},{"type":"toolCall","id":"b","name":"read","arguments":{}}]}]}}));
        let mut merged = model.rows()[0].work_data().unwrap().as_ref().clone();
        let mut a = merged.clone();
        a.steps.truncate(1);
        let mut b = merged.clone();
        b.steps.remove(0);
        let mut choices = Choices::default();
        assert_eq!(choices.choice(&merged), None);
        choices.choose(&a, true);
        assert_eq!(choices.choice(&merged), Some(true));
        // Most recent explicit intent wins when separately chosen groups merge.
        choices.choose(&b, false);
        merged.id += 100;
        assert_eq!(choices.choice(&merged), Some(false));
        choices.choose(&merged, true);
        a.id += 200;
        b.id += 300;
        assert_eq!(choices.choice(&a), Some(true));
        assert_eq!(choices.choice(&b), Some(true));
        choices.choose(&merged, false);
        assert_eq!(choices.choice(&a), Some(false));
        assert_eq!(choices.choice(&b), Some(false));
        assert_eq!(choices.groups.len(), 2, "no render-ID or event-key growth");
    }
}
