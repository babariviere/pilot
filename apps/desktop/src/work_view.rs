//! Presentation only. Hidden argument/output parsers are never built or updated.
use crate::{
    tool_presentation::{Status, Step, Work},
    transcript_view::TranscriptView,
};
use gpui_kit::{
    AppContext, ClipboardItem, Context, Entity, EventEmitter, InteractiveElement, IntoElement,
    ParentElement, Render, SharedString, StatefulInteractiveElement, Styled, Subscription,
    TestSupportExt, Window,
    component::{
        ActiveTheme, Icon, IconName, Sizable, StyledExt,
        button::{Button, ButtonVariants},
        text::{TextView, TextViewState},
    },
    div,
};
use std::{
    cell::RefCell,
    collections::{BTreeMap, BTreeSet},
    rc::Rc,
    sync::Arc,
};

#[derive(Clone)]
pub(crate) enum Change {
    Step(String),
    Group(u64),
    Disclosure(String),
}
#[derive(Default)]
struct Choices {
    sequence: u64,
    groups: BTreeMap<String, (u64, bool, bool)>,
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
    fn choice(&self, work: &Work) -> Option<(bool, bool)> {
        Self::members(work)
            .iter()
            .filter_map(|id| self.groups.get(id))
            .max_by_key(|(seq, _, _)| *seq)
            .map(|(_, open, all)| (*open, *all))
    }
    fn choose(&mut self, work: &Work, open: bool, all: bool) {
        self.sequence += 1;
        for id in Self::members(work) {
            self.groups.insert(id, (self.sequence, open, all));
        }
    }
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
fn disclosure(id: SharedString, title: String, open: bool) -> Button {
    Button::new(id)
        .ghost()
        .small()
        .w_full()
        .accessibility_label(title.clone())
        .child(
            div()
                .h_flex()
                .w_full()
                .min_w_0()
                .gap_1()
                .items_center()
                .child(
                    Icon::new(if open {
                        IconName::ChevronDown
                    } else {
                        IconName::ChevronRight
                    })
                    .small(),
                )
                .child(
                    div()
                        .id("disclosure-text")
                        .test_support()
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .child(SharedString::from(title)),
                ),
        )
}
impl WorkUi {
    pub(crate) fn parsers_ready(&self, cx: &gpui_kit::App) -> bool {
        self.steps.values().all(|step| {
            step.read(cx).bodies.values().all(|body| {
                body.state.read(cx).rendered_text().source()
                    == if body.plain {
                        format!(
                            "<pre>{}</pre>",
                            body.source
                                .replace('&', "&amp;")
                                .replace('<', "&lt;")
                                .replace('>', "&gt;")
                        )
                    } else {
                        body.source.as_ref().clone()
                    }
            })
        })
    }
    #[cfg(test)]
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
    #[cfg(test)]
    pub(crate) fn group_open(&self, id: u64, cx: &gpui_kit::App) -> bool {
        self.groups[&id].read(cx).open()
    }
    pub(crate) fn sync(
        &mut self,
        works: Vec<Arc<Work>>,
        reset: bool,
        adopted: &BTreeMap<u64, (Entity<TextViewState>, Arc<String>)>,
        cx: &mut Context<TranscriptView>,
    ) {
        if reset {
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
                    view.update(cx, |view, cx| view.set(step.clone(), cx));
                    view.clone()
                } else {
                    let view = cx.new(|_| StepView {
                        step: step.clone(),
                        open: false,
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
                self.choices.borrow_mut().choose(&work, true, true);
            }
            if let Some(view) = self.groups.get(&work.id) {
                view.update(cx, |view, cx| {
                    if view.data != work {
                        let shape = view.data.active != work.active
                            || view.data.failures != work.failures
                            || view.data.steps.len() != work.steps.len();
                        view.data = work;
                        view.children = children;
                        if shape {
                            cx.emit(Change::Group(view.data.id));
                        }
                        cx.notify();
                    }
                });
            } else {
                let id = work.id;
                let choices = self.choices.clone();
                let view = cx.new(|_| WorkView {
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
        self.choices.borrow_mut().groups.retain(|id, _| {
            step_ids.contains(id)
                || id
                    .strip_prefix("note:")
                    .and_then(|id| id.parse::<u64>().ok())
                    .is_some_and(|id| group_ids.contains(&id))
        });
    }
}
pub(crate) struct WorkView {
    data: Arc<Work>,
    children: Vec<Entity<StepView>>,
    choices: Rc<RefCell<Choices>>,
}
impl EventEmitter<Change> for WorkView {}
impl WorkView {
    fn open(&self) -> bool {
        self.choices.borrow().choice(&self.data).map_or(
            self.data.active || self.data.failures > 0 || self.data.uncertain > 0,
            |(open, _)| open,
        )
    }
}
impl Render for WorkView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let open = self.open();
        let choice = self.choices.borrow().choice(&self.data);
        let all = choice.is_some_and(|(_, all)| all);
        let limited = choice.is_none() && !all && self.children.len() > 4;
        let start = if limited { self.children.len() - 4 } else { 0 };
        let mut root = div().v_flex().gap_2().w_full().min_w_0().child(
            disclosure(
                SharedString::from(format!("work-toggle-{}", self.data.id)),
                format!(
                    "{}{}{}",
                    self.data.title,
                    if self.data.failures > 0 {
                        format!(" · {} failed", self.data.failures)
                    } else {
                        String::new()
                    },
                    if self.data.uncertain > 0 {
                        format!(" · {} status unknown", self.data.uncertain)
                    } else {
                        String::new()
                    }
                ),
                open,
            )
            .on_click(cx.listener(|view, _, _, cx| {
                let open = !view.open();
                view.choices.borrow_mut().choose(&view.data, open, true);
                cx.emit(Change::Disclosure(format!("group:{}", view.data.id)));
                cx.notify();
            })),
        );
        if open {
            let mut steps = div()
                .v_flex()
                .gap_2()
                .pl_4()
                .border_l_1()
                .border_color(cx.theme().border)
                .min_w_0();
            if limited {
                steps = steps.child(
                    Button::new(("work-earlier", self.data.id))
                        .ghost()
                        .small()
                        .self_start()
                        .label(format!("Show {start} earlier steps"))
                        .on_click(cx.listener(|view, _, _, cx| {
                            view.choices.borrow_mut().choose(&view.data, true, true);
                            cx.emit(Change::Disclosure(format!("group:{}", view.data.id)));
                            cx.notify();
                        })),
                );
            }
            for view in &self.children[start..] {
                steps = steps.child(view.clone());
            }
            root = root.child(steps);
        }
        root
    }
}
struct Body {
    source: Arc<String>,
    state: Entity<TextViewState>,
    plain: bool,
}
pub(crate) struct StepView {
    step: Step,
    open: bool,
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
    fn set(&mut self, step: Step, cx: &mut Context<Self>) {
        if self.step != step {
            let layout = self.open;
            self.step = step;
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
        let changed = self
            .bodies
            .get(label)
            .is_none_or(|body| body.source != source);
        if changed {
            let escaped = if plain {
                format!(
                    "<pre>{}</pre>",
                    source
                        .replace('&', "&amp;")
                        .replace('<', "&lt;")
                        .replace('>', "&gt;")
                )
            } else {
                source.as_ref().clone()
            };
            if let Some(body) = self.bodies.get_mut(label) {
                body.source = source.clone();
                body.state
                    .update(cx, |state, cx| state.set_text(&escaped, cx));
            } else {
                let state = cx.new(|cx| {
                    (if plain {
                        TextViewState::html(&escaped, cx)
                    } else {
                        TextViewState::markdown(&escaped, cx)
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
                        state,
                        plain,
                    },
                );
            }
        }
        let state = self.bodies[label].state.clone();
        let id = step_id(&self.step);
        div()
            .v_flex()
            .gap_1()
            .min_w_0()
            .child(
                div()
                    .h_flex()
                    .justify_between()
                    .child(
                        div()
                            .text_xs()
                            .text_color(cx.theme().muted_foreground)
                            .child(label),
                    )
                    .child(
                        Button::new(SharedString::from(format!("copy-{id}-{label}")))
                            .ghost()
                            .small()
                            .label("Copy shown text")
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
                    .max_h_64()
                    .overflow_y_scroll()
                    .min_w_0()
                    .child(
                        TextView::new(&state)
                            .selectable(true)
                            .scrollable(false)
                            .on_link_click(|_, _, _, _| {}),
                    ),
            )
    }
}
impl Render for StepView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let id = step_id(&self.step);
        let (title, error, limited) = match &self.step {
            Step::Tool(tool) => (
                format!(
                    "{} {}{}{}",
                    tool.title,
                    tool.subject,
                    if tool.additions + tool.deletions > 0 {
                        format!(
                            " · {}+{} −{}",
                            if tool.limited { "shown " } else { "" },
                            tool.additions,
                            tool.deletions
                        )
                    } else {
                        String::new()
                    },
                    if tool.status != Status::Done {
                        format!(" · {}", tool.status.label())
                    } else {
                        String::new()
                    }
                ),
                tool.status == Status::Error,
                tool.limited,
            ),
            Step::Note {
                thinking,
                streaming,
                ..
            } => (
                (if *thinking {
                    if *streaming { "Thinking…" } else { "Thought" }
                } else {
                    "Note"
                })
                .into(),
                false,
                false,
            ),
        };
        let mut root = div().v_flex().gap_2().min_w_0().w_full().child(
            disclosure(
                SharedString::from(format!("step-toggle-{id}")),
                title,
                self.open,
            )
            .text_color(if error {
                cx.theme().danger
            } else {
                cx.theme().muted_foreground
            })
            .on_click(cx.listener(|view, _, _, cx| {
                view.open = !view.open;
                cx.emit(Change::Disclosure(step_id(&view.step)));
                cx.notify();
            })),
        );
        if self.open {
            let step = self.step.clone();
            let mut details = div().v_flex().gap_2().pl_4().min_w_0();
            match step {
                Step::Tool(tool) => {
                    if !tool.diff.is_empty() {
                        details = details.child(self.body(
                            "Replacement / patch preview",
                            tool.diff.clone(),
                            true,
                            cx,
                        ));
                    }
                    if !tool.arguments.is_empty() {
                        details =
                            details.child(self.body("Arguments", tool.arguments.clone(), true, cx));
                    }
                    if !tool.output.is_empty() {
                        details = details.child(self.body("Output", tool.output.clone(), true, cx));
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
