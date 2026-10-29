//! Presentation only. Hidden argument/output parsers are never built or updated.
//!
//! A work group is one effects-first line. While its run is live and the user
//! has not chosen, its latest steps show under the line; the chevron opens the
//! full quiet list. An opened call shows its output first, then its code.
use crate::{
    app_icon::AppIcon,
    tool_presentation::{Kind, Status, Step, Tone, Unit, Work},
    transcript_view::TranscriptView,
};
use gpui_kit::{
    App, AppContext, ClipboardItem, Context, Entity, EventEmitter, InteractiveElement, IntoElement,
    ParentElement, Render, SharedString, StatefulInteractiveElement, Styled, Subscription,
    TestSupportExt, WeakEntity, Window,
    component::{
        ActiveTheme, Icon, IconName, Sizable, StyledExt,
        button::{Button, ButtonVariants},
        text::{TextView, TextViewState},
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

/// Steps shown under a live line before "Show earlier" (D93; Swift shows 4).
pub(crate) const TAIL: usize = 5;

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
    /// The call opened from the folded first error, one per group.
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
    #[cfg(any(test, feature = "native-probes"))]
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
    disclosure_lead(
        id,
        caption,
        open,
        icon.map(|icon| icon.inline().into_any_element()),
        cx,
    )
}
/// Bounce period of the running dots.
const DOTS_PERIOD: std::time::Duration = std::time::Duration::from_millis(1200);
/// Three dots that bounce beside a call that is running now, in the glyph's
/// slot. The phase is None under reduced motion: the dots hold still.
fn dots(id: &str, phase: Option<f32>, cx: &gpui_kit::App) -> gpui_kit::AnyElement {
    let color = cx.theme().muted_foreground;
    div()
        .id(SharedString::from(format!("work-dots-{id}")))
        .test_support()
        .flex_shrink_0()
        .size(gpui_kit::rems(0.875))
        .h_flex()
        .items_center()
        .justify_center()
        .gap(px(1.5))
        .children((0..3usize).map(|index| {
            // Each dot rises and lands in the first 40% of its turn, a
            // little after the one before it.
            let lift = phase.map_or(0., |phase| {
                let at = (phase - index as f32 * 0.15).rem_euclid(1.) / 0.4;
                if at < 1. {
                    (at * std::f32::consts::PI).sin() * 2.5
                } else {
                    0.
                }
            });
            div()
                .id(("work-dot", index))
                .test_support()
                .relative()
                .top(px(-lift))
                .size(px(3.))
                .rounded_full()
                .bg(color)
        }))
        .into_any_element()
}
fn disclosure_lead(
    id: SharedString,
    caption: Caption,
    open: bool,
    lead: Option<gpui_kit::AnyElement>,
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
                        .when_some(lead, |this, lead| this.child(lead)),
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
            step.read(cx)
                .bodies
                .values()
                .all(|body| body.state.read(cx).rendered_text().source() == body.parsed)
        })
    }
    #[cfg(any(test, feature = "native-probes"))]
    pub(crate) fn step_info(&self, id: &str, cx: &gpui_kit::App) -> (bool, usize) {
        let step = self.steps[&format!("call:{id}")].read(cx);
        (step.open, step.bodies.len())
    }
    #[cfg(test)]
    pub(crate) fn step_pulse(&self, id: &str, cx: &gpui_kit::App) -> bool {
        self.steps[&format!("call:{id}")].read(cx).pulse.running()
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
    /// A section's inner scroll offset, negative once scrolled down.
    #[cfg(test)]
    pub(crate) fn body_offset(
        &self,
        id: &str,
        label: &str,
        cx: &gpui_kit::App,
    ) -> gpui_kit::Pixels {
        self.steps[&format!("call:{id}")].read(cx).bodies[label]
            .scroll
            .offset()
    }
    #[cfg(any(test, feature = "native-probes"))]
    pub(crate) fn group_open(&self, id: u64, cx: &gpui_kit::App) -> bool {
        self.groups[&id].read(cx).open()
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
                        bodies: BTreeMap::new(),
                        subscriptions: Vec::new(),
                        pulse: crate::transition::Pulse::default(),
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
                let view = cx.new(|_| WorkView {
                    owner,
                    data: work,
                    children,
                    choices,
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
/// What changes a group's height: its line and steps, not output text.
fn shape(work: &Work) -> (bool, String, Vec<Unit>, Option<String>) {
    (
        work.active,
        work.title.clone(),
        work.units(),
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
    #[cfg(any(test, feature = "native-probes"))]
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
    /// The call opened from the folded first error, shown alone under the line.
    fn selected(&self, cx: &App) -> Option<usize> {
        let choices = self.choices.borrow();
        (0..self.data.steps.len()).find(|index| {
            call_key(&self.data, *index).is_some_and(|key| choices.selected.contains(&key))
                && self
                    .children
                    .get(*index)
                    .is_some_and(|step| step.read(cx).open)
        })
    }
    /// Opens just this call under the line, or closes it when already open.
    fn toggle_call(&mut self, index: usize, cx: &mut Context<Self>) {
        let Some(key) = call_key(&self.data, index) else {
            return;
        };
        let prior = self.selected(cx);
        let open = prior != Some(index);
        self.hold(cx);
        if let Some(prior) = prior.filter(|prior| *prior != index) {
            self.children[prior].update(cx, |step, cx| step.set_open(false, cx));
        }
        {
            let mut choices = self.choices.borrow_mut();
            for other in (0..self.data.steps.len()).filter_map(|i| call_key(&self.data, i)) {
                choices.selected.remove(&other);
            }
            if open {
                choices.selected.insert(key);
            }
        }
        self.children[index].update(cx, |step, cx| step.set_open(open, cx));
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
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let mode = self.mode();
        let selected = self.selected(cx);
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
        let mut root = div()
            .v_flex()
            .gap_2()
            .w_full()
            .min_w_0()
            .child(div().w_full().min_w_0().child(self.line(mode, cx)));
        // A folded, finished group keeps its first error readable: one
        // clipped line that opens just that call.
        if mode == Mode::Folded
            && selected.is_none()
            && self.choices.borrow().choice(&self.data).is_none()
            && let Some((index, error)) = self.data.first_error()
        {
            root = root.child(
                div()
                    .id(("work-first-error", self.data.id))
                    .test_support()
                    .pl_4()
                    .w_full()
                    .min_w_0()
                    .overflow_hidden()
                    .truncate()
                    .text_xs()
                    .font_family(cx.theme().mono_font_family.clone())
                    .text_color(cx.theme().danger)
                    .cursor_pointer()
                    .child(error)
                    .on_click(cx.listener(move |view, _, _, cx| view.toggle_call(index, cx))),
            );
        }
        let extra: Vec<usize> = selected
            .filter(|index| !visible.contains(index))
            .into_iter()
            .collect();
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
/// What one panel section shows.
struct Block<'a> {
    label: &'static str,
    source: Arc<String>,
    /// Shown instead of the source, such as output without its header.
    shown: Option<&'a str>,
    /// Monospace panel text (HTML pre) rather than Markdown prose.
    plain: bool,
    detail: Option<String>,
    /// Outcome beside the label, and whether it is a failure.
    status: Option<(&'static str, bool)>,
    /// Wash the lines that read as failures.
    errors: bool,
}
impl Block<'_> {
    fn code(label: &'static str, source: Arc<String>) -> Self {
        Self {
            label,
            source,
            shown: None,
            plain: true,
            detail: None,
            status: None,
            errors: false,
        }
    }
}
/// A line that reads as a failure, for a presentational wash only.
fn failing(line: &str) -> bool {
    let line = line.to_ascii_lowercase();
    ["error", "fail", "panic"]
        .iter()
        .any(|word| line.contains(word))
}
fn escape_text(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}
/// Monospace text as HTML pre, washing failing lines when given a colour.
fn code_html(text: &str, wash: Option<&str>) -> String {
    let Some(wash) = wash else {
        return format!("<pre>{}</pre>", escape_text(text));
    };
    let lines: Vec<String> = text
        .split('\n')
        .map(|line| {
            if failing(line) && !line.trim().is_empty() {
                format!("<mark color=\"{wash}\">{}</mark>", escape_text(line))
            } else {
                escape_text(line)
            }
        })
        .collect();
    format!("<pre>{}</pre>", lines.join("\n"))
}
fn hex(color: gpui_kit::Hsla) -> String {
    let rgba = gpui_kit::Rgba::from(color);
    let byte = |v: f32| (v.clamp(0., 1.) * 255.).round() as u8;
    format!(
        "#{:02x}{:02x}{:02x}{:02x}",
        byte(rgba.r),
        byte(rgba.g),
        byte(rgba.b),
        byte(rgba.a)
    )
}
struct Body {
    /// The exact source, for copy.
    source: Arc<String>,
    /// What the parser holds.
    parsed: String,
    state: Entity<TextViewState>,
    /// Long text scrolls inside the section.
    scroll: crate::nested_scroll::NestedScroll,
}

pub(crate) struct StepView {
    preview: Entity<crate::tool_diff_preview::Preview>,
    step: Step,
    /// The group follows a live run, so live calls read as running.
    active: bool,
    open: bool,
    bodies: BTreeMap<&'static str, Body>,
    subscriptions: Vec<Subscription>,
    /// Clock of the running dots, while this call runs.
    pulse: crate::transition::Pulse,
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
                parsed: source.as_ref().clone(),
                source,
                state,
                scroll: Default::default(),
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
    /// One section of a call's panel: a caption (label, detail, status) with
    /// exact copy, then the text. Copy is always the exact source; the shown
    /// text can drop a matched header. Its parser exists only while the call
    /// is open; long text scrolls inside the section.
    fn body(&mut self, block: Block<'_>, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        let Block {
            label,
            source,
            shown,
            plain,
            detail,
            status,
            errors,
        } = block;
        let id = step_id(&self.step);
        let (state, scroll) = {
            let shown = shown.unwrap_or(source.as_str()).to_owned();
            let parsed = if plain {
                // Failing lines get a quiet danger wash; the text is unchanged.
                let wash = errors.then(|| hex(cx.theme().danger.opacity(0.16)));
                code_html(&shown, wash.as_deref())
            } else {
                shown.clone()
            };
            if let Some(body) = self.bodies.get_mut(label) {
                if body.source != source || body.parsed != parsed {
                    body.source = source.clone();
                    body.parsed = parsed.clone();
                    body.state
                        .update(cx, |state, cx| state.set_text(&parsed, cx));
                }
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
                        parsed,
                        state,
                        scroll: Default::default(),
                    },
                );
            }
            (
                self.bodies[label].state.clone(),
                self.bodies[label].scroll.clone(),
            )
        };
        let muted = cx.theme().muted_foreground;
        let danger = cx.theme().danger;
        let caption = div()
            .h_flex()
            .gap_2()
            .items_center()
            .child(crate::ui::text(crate::ui::Text::Caption, label).text_color(muted))
            .when_some(status, |this, (status, error)| {
                this.child(
                    crate::ui::text(crate::ui::Text::Caption, status).text_color(if error {
                        danger
                    } else {
                        muted
                    }),
                )
            })
            .when_some(detail, |this, detail| {
                this.child(
                    crate::ui::text(crate::ui::Text::Caption, detail)
                        .text_color(muted)
                        .opacity(0.75),
                )
            });
        let name = label.to_lowercase();
        let header = div()
            .h_flex()
            .gap_2()
            .items_center()
            .min_w_0()
            .child(caption)
            .child(div().flex_1())
            .child(
                Button::new(SharedString::from(format!("copy-{id}-{label}")))
                    .ghost()
                    .xsmall()
                    .icon(AppIcon::Copy.asset())
                    .accessibility_label(SharedString::from(format!("Copy {name}")))
                    .tooltip(SharedString::from(format!("Copy {name}")))
                    .on_click(move |_, _, cx| {
                        cx.write_to_clipboard(ClipboardItem::new_string(source.as_ref().clone()))
                    }),
            );
        div()
            .v_flex()
            .gap_1()
            .min_w_0()
            // Panel sections carry their own inset; a note reads as prose.
            .when(plain, |this| this.px(px(12.)).py(px(6.)))
            .child(header)
            .map(|this| {
                this.child(
                    scroll.area(
                        div()
                            .id(SharedString::from(format!("body-{id}-{label}")))
                            .test_support()
                            .max_h(px(260.))
                            .min_w_0()
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
                    ),
                )
            })
    }
}

impl Render for StepView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
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
        // Only a call running in a live run bounces; its outcome or a
        // stale run settles it.
        let running = !caption.error
            && self.active
            && matches!(&self.step, Step::Tool(tool) if tool.status.live());
        let lead = match &self.step {
            Step::Tool(_) if caption.error => Some(AppIcon::Error.inline().into_any_element()),
            Step::Tool(_) if running => {
                Some(dots(&id, self.pulse.phase(DOTS_PERIOD, window, cx), cx))
            }
            Step::Tool(tool) => Some(kind_icon(tool.kind).inline().into_any_element()),
            Step::Note { .. } => None,
        };
        if !running {
            self.pulse.stop();
        }
        let mut root = div().v_flex().gap_2().min_w_0().w_full().child(
            div()
                .h_flex()
                .min_w_0()
                .items_center()
                .child(
                    div().flex_1().min_w_0().child(
                        disclosure_lead(
                            SharedString::from(format!("step-toggle-{id}")),
                            caption,
                            self.open,
                            lead,
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
                    let script = (tool.name == "codemode")
                        .then(|| crate::tool_presentation::script_output(&tool.output))
                        .flatten();
                    let failed = tool.status == Status::Error;
                    let mut sections: Vec<gpui_kit::AnyElement> = Vec::new();
                    // The command or code, then what it printed.
                    if let Some((label, source)) = &tool.input {
                        let lines = source.lines().count();
                        let script = *label == "Code";
                        let language = if tool.name == "codemode" {
                            "JavaScript · "
                        } else if *label == "Command" {
                            "Shell · "
                        } else {
                            ""
                        };
                        sections.push(
                            self.body(
                                Block {
                                    detail: script.then(|| {
                                        format!(
                                            "{language}{lines} line{}",
                                            if lines == 1 { "" } else { "s" }
                                        )
                                    }),
                                    ..Block::code(label, source.clone())
                                },
                                cx,
                            )
                            .into_any_element(),
                        );
                    }
                    let shown = script.as_ref().map(|script| script.body);
                    let status = if failed {
                        Some(("Failed", true))
                    } else if stale {
                        Some((Status::Interrupted.label(), false))
                    } else if tool.status.live() {
                        Some((Status::Running.label(), false))
                    } else {
                        None
                    };
                    if !tool.output.is_empty() && shown.is_none_or(|shown| !shown.trim().is_empty())
                    {
                        sections.push(
                            self.body(
                                Block {
                                    shown: shown.or(Some(tool.output.as_str())),
                                    detail: script
                                        .as_ref()
                                        .map(|script| format!("{} s", script.wall)),
                                    status,
                                    errors: failed,
                                    ..Block::code("Output", tool.output.clone())
                                },
                                cx,
                            )
                            .into_any_element(),
                        );
                    }
                    if !tool.diff.is_empty() {
                        sections.push(
                            self.body(
                                Block::code("Replacement / patch preview", tool.diff.clone()),
                                cx,
                            )
                            .into_any_element(),
                        );
                    }
                    // A script's or command's arguments only repeat its source,
                    // and an edit's its preview: show them for other tools.
                    if tool.input.is_none() && tool.diff.is_empty() && !tool.arguments.is_empty() {
                        sections.push(
                            self.body(Block::code("Arguments", tool.arguments.clone()), cx)
                                .into_any_element(),
                        );
                    }
                    // One quiet panel; hairlines separate its sections.
                    let border = cx.theme().border;
                    details = details.child(
                        div()
                            .id(SharedString::from(format!("panel-{id}")))
                            .test_support()
                            .v_flex()
                            .min_w_0()
                            .py(px(2.))
                            .bg(crate::appearance::code(cx))
                            .border_1()
                            .border_color(border)
                            .rounded(px(crate::appearance::Radius::CONTROL))
                            .overflow_hidden()
                            .children(sections.into_iter().enumerate().map(|(index, section)| {
                                div()
                                    .min_w_0()
                                    .when(index > 0, |this| this.border_t_1().border_color(border))
                                    .child(section)
                            })),
                    );
                }
                Step::Note { text, .. } => {
                    details = details.child(self.body(
                        Block {
                            plain: false,
                            ..Block::code("Note", text)
                        },
                        cx,
                    ));
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
    #[test]
    fn failing_lines_get_a_wash_and_text_stays_exact() {
        assert_eq!(code_html("a < b\nok", None), "<pre>a &lt; b\nok</pre>");
        assert_eq!(
            code_html(
                "Running\nthread 'x' panicked\n\ntest result: FAILED",
                Some("#ff000029")
            ),
            "<pre>Running\n<mark color=\"#ff000029\">thread 'x' panicked</mark>\n\n<mark color=\"#ff000029\">test result: FAILED</mark></pre>"
        );
        assert_eq!(
            hex(gpui_kit::Hsla::from(gpui_kit::rgb(0xff0000)).opacity(0.5)),
            "#ff000080"
        );
    }
}
