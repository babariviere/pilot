//! Retained, source-immutable task form. Parent keeps one per canonical mission.
use crate::{
    LocalOptions,
    mission_browser::Key,
    mission_task_create::{self as model, Outcome, State},
    mission_task_create_transport as wire,
    ui::{self, Action, Notice, Text, Tone},
};
use gpui_kit::{
    App, AppContext, ClipboardItem, Context, Entity, EntityInputHandler, EventEmitter, FocusHandle,
    Focusable, InteractiveElement, IntoElement, ParentElement, Render, SharedString, Styled,
    Subscription, Task, TestSupportExt, Window,
    component::{
        Disableable, StyledExt,
        input::{InputEvent, Textarea, TextareaState},
    },
    div,
    prelude::FluentBuilder,
};
use std::{cell::Cell, rc::Rc};
gpui_kit::actions!(mission_task_create, [SubmitTask, CloseTask]);
struct Keys;
impl gpui_kit::Global for Keys {}
pub(crate) struct Close;
pub(crate) struct Form {
    pub(crate) key: Key,
    options: LocalOptions,
    pub(crate) visible: bool,
    pub(crate) state: State,
    pub(crate) title: Entity<TextareaState>,
    pub(crate) body: Entity<TextareaState>,
    draft: [String; 2],
    error: Option<&'static str>,
    focus: FocusHandle,
    bounds: [Rc<Cell<Option<gpui_kit::Bounds<gpui_kit::Pixels>>>>; 2],
    _inputs: Vec<Subscription>,
    completion: Option<Task<()>>,
}
impl EventEmitter<Close> for Form {}
impl Form {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    /// A typed, unsent task draft, or an unanswered create.
    pub(crate) fn update_hold(&self, cx: &gpui_kit::App) -> Option<crate::update_hold::Hold> {
        let typed = !self.title.read(cx).value().trim().is_empty()
            || !self.body.read(cx).value().trim().is_empty();
        crate::update_hold::Hold::of(
            matches!(self.state.attempt, Some((_, Outcome::Pending))),
            !self.state.blocked() && typed,
        )
    }
    pub(crate) fn new(
        key: Key,
        options: LocalOptions,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        if !cx.has_global::<Keys>() {
            let bindings = [
                crate::ui::shortcut("secondary-enter", SubmitTask, Some("MissionTaskCreate"), cx),
                gpui_kit::KeyBinding::new("escape", CloseTask, Some("MissionTaskCreate")),
            ];
            cx.bind_keys(bindings);
            cx.set_global(Keys);
        }
        let title = cx.new(|cx| {
            let mut t = TextareaState::new(w, cx)
                .placeholder("Task title")
                .auto_grow(1, 2);
            t.set_submit_on_enter(false, cx);
            t
        });
        let body = cx.new(|cx| {
            let mut t = TextareaState::new(w, cx)
                .placeholder("Description (optional)")
                .auto_grow(3, 6);
            t.set_submit_on_enter(false, cx);
            t
        });
        let mut subscriptions = Vec::new();
        for (ix, input) in [title.clone(), body.clone()].into_iter().enumerate() {
            subscriptions.push(cx.subscribe_in(&input,w,move |v,_,event,w,cx| {
                if matches!(event,InputEvent::Change) {
                    let input = if ix==0 {v.title.clone()} else {v.body.clone()};
                    let value=input.read(cx).value();
                    let cap=if ix==0 {model::TITLE_UNITS} else {model::BODY_UNITS};
                    if value.encode_utf16().count()>cap {
                        let previous=v.draft[ix].clone();
                        input.update(cx,|i,cx| i.set_value(previous,w,cx));
                        v.error=Some("Edit exceeds the field limit and was rejected in full. Previous text is retained; undo history was reset.");
                    } else {v.draft[ix]=value.to_string();}
                    cx.notify();
                }
            }));
        }
        Self {
            key,
            options,
            visible: true,
            state: State::default(),
            title,
            body,
            draft: Default::default(),
            error: None,
            focus: cx.focus_handle(),
            bounds: Default::default(),
            _inputs: subscriptions,
            completion: None,
        }
    }
    pub(crate) fn matches(&self, key: &Key, options: &LocalOptions) -> bool {
        self.key == *key
            && self.options.host() == options.host()
            && self.options.loopback() == options.loopback()
    }
    pub(crate) fn owns_focus(&self, w: &Window, cx: &App) -> bool {
        self.focus.contains_focused(w, cx)
    }
    pub(crate) fn marked(&mut self, w: &mut Window, cx: &mut Context<Self>) -> bool {
        self.visible
            && [self.title.clone(), self.body.clone()]
                .iter()
                .any(|i| i.update(cx, |i, cx| i.marked_text_range(w, cx).is_some()))
    }
    pub(crate) fn focus(&self, w: &mut Window, cx: &mut App) {
        self.title.read(cx).focus_handle(cx).focus(w, cx);
    }
    fn close(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if self.visible && !self.marked(w, cx) {
            cx.emit(Close);
        }
    }
    fn submit(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if !self.visible || self.marked(w, cx) {
            return;
        }
        // Read native values at intent time, not queued Change delivery.
        let title = self.title.read(cx).value().to_string();
        let body = self.body.read(cx).value().to_string();
        let submission = match self.state.begin(&self.key, &title, &body) {
            Ok(s) => s,
            Err(e) => {
                self.error = Some(e);
                cx.notify();
                return;
            }
        };
        self.error = None;
        match wire::start(self.options.clone(), submission.clone()) {
            Err(e) => {
                self.state.finish(&submission, Outcome::NotSent(e));
            }
            Ok(output) => {
                self.completion=Some(cx.spawn(async move |view,cx| {
                    let reply=output.recv().await;
                    let _=view.update(cx,|v,cx| {
                        let (s,outcome)=match reply {Ok(r)=>(r.submission,r.outcome),Err(_)=>(submission,Outcome::Unknown("Couldn't confirm the task was created. It may exist already; don't create it again."))};
                        v.state.finish(&s,outcome);cx.notify();
                    });
                }));
            }
        }
        cx.notify();
    }
}
impl Render for Form {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let weak = cx.weak_entity();
        let fence = gpui_kit::canvas(
            |_, _, _| (),
            move |_, (), w, _| {
                w.on_mouse_event(move |event: &gpui_kit::MouseDownEvent, phase, w, cx| {
                    if phase == gpui_kit::DispatchPhase::Capture
                        && weak
                            .update(cx, |v, cx| {
                                // During composition only the marked editor may take input.
                                let marked =
                                    [v.title.clone(), v.body.clone()].iter().position(|i| {
                                        i.update(cx, |i, cx| i.marked_text_range(w, cx).is_some())
                                    });
                                v.visible
                                    && marked.is_some_and(|ix| {
                                        v.bounds[ix]
                                            .get()
                                            .is_none_or(|b| !b.contains(&event.position))
                                    })
                            })
                            .unwrap_or(false)
                    {
                        cx.stop_propagation();
                    }
                });
            },
        )
        .absolute()
        .inset_0()
        .size_full();
        let blocked = self.state.blocked();
        let mut form = div()
            .id("mission-task-create")
            .test_support()
            .relative()
            .w_full()
            .min_w_0()
            .v_flex()
            .gap_2()
            .track_focus(&self.focus)
            .key_context("MissionTaskCreate")
            // Kit resolves textarea Enter before raw key-down dispatch. Capture
            // that real action, not a competing outer key binding/subscription.
            .capture_action(
                cx.listener(|v, event: &gpui_kit::base::input::Enter, w, cx| {
                    if event.secondary && !event.shift {
                        cx.stop_propagation();
                        v.submit(w, cx);
                    }
                }),
            )
            .capture_action(cx.listener(|v, _: &gpui_kit::base::input::Escape, w, cx| {
                cx.stop_propagation();
                v.close(w, cx);
            }))
            .on_action(cx.listener(|v, _: &SubmitTask, w, cx| v.submit(w, cx)))
            .on_action(cx.listener(|v, _: &CloseTask, w, cx| v.close(w, cx)))
            .child(ui::heading(
                "task-create-heading",
                "New task",
                Text::Headline,
            ))
            .child(ui::text(
                Text::Caption,
                SharedString::from(format!("Mission: {}", self.key.id)),
            ))
            .child(ui::text(
                Text::Caption,
                "Creating a task doesn't assign it or start a chat.",
            ));
        for (ix, (label, input, id)) in [
            ("Title", self.title.clone(), "task-create-title"),
            ("Description", self.body.clone(), "task-create-body"),
        ]
        .into_iter()
        .enumerate()
        {
            self.bounds[ix].set(None);
            let bounds = self.bounds[ix].clone();
            form = form.child(ui::text(Text::Label, label)).child(
                div()
                    .id(id)
                    .test_support()
                    .relative()
                    .w_full()
                    .min_w_0()
                    .child(Textarea::new(&input).aria_label(label).disabled(blocked))
                    .child(
                        gpui_kit::canvas(|_, _, _| (), move |b, (), _, _| bounds.set(Some(b)))
                            .absolute()
                            .inset_0()
                            .size_full(),
                    ),
            );
        }
        if let Some((_, outcome)) = &self.state.attempt {
            let (text, tone) = match outcome {
                Outcome::Pending => (
                    "Creating task… Navigating away does not cancel this submission.".to_string(),
                    Tone::Normal,
                ),
                Outcome::NotSent(e) => (e.to_string(), Tone::Error),
                Outcome::Unknown(e) => (format!("Creation unconfirmed. {e}"), Tone::Error),
                Outcome::Created(t) => (
                    format!(
                        "Created task #{} · {}. Refresh tasks to see it.",
                        t.number, t.id
                    ),
                    Tone::Normal,
                ),
            };
            form = form.child(
                div()
                    .id("task-create-result")
                    .test_support()
                    .child(Notice::new(SharedString::from(text)).tone(tone)),
            );
        }
        if let Some(e) = self.error {
            form = form.child(Notice::new(e).tone(Tone::Error));
        }
        form.child(
            div()
                .h_flex()
                .flex_wrap()
                .gap_2()
                .child(
                    ui::action("task-create-submit", "Create task", Action::Primary)
                        .disabled(blocked)
                        .tooltip("Create this task (⌘Enter)")
                        .on_click(cx.listener(|v, _, w, cx| v.submit(w, cx))),
                )
                .child(
                    ui::action("task-create-close", "Close", Action::Quiet)
                        .on_click(cx.listener(|v, _, w, cx| v.close(w, cx))),
                )
                .when(
                    matches!(self.state.attempt.as_ref(), Some((_, Outcome::Created(_)))),
                    |d| {
                        d.child(
                            ui::action("task-create-another", "Another task", Action::Secondary)
                                .on_click(cx.listener(|v, _, w, cx| {
                                    if v.marked(w, cx)
                                        || !matches!(
                                            v.state.attempt.as_ref(),
                                            Some((_, Outcome::Created(_)))
                                        )
                                    {
                                        return;
                                    }
                                    v.state = State::default();
                                    v.draft = Default::default();
                                    v.error = None;
                                    for input in [&v.title, &v.body] {
                                        input.update(cx, |i, cx| i.set_value("", w, cx));
                                    }
                                    v.focus(w, cx);
                                    cx.notify();
                                })),
                        )
                    },
                )
                .when(self.state.attempt.is_some(), |d| {
                    d.child(
                        ui::action("task-create-copy", "Copy text", Action::Quiet).on_click(
                            cx.listener(|v, _, _, cx| {
                                cx.write_to_clipboard(ClipboardItem::new_string(format!(
                                    "{}\n\n{}",
                                    v.title.read(cx).value(),
                                    v.body.read(cx).value()
                                )));
                            }),
                        ),
                    )
                }),
        )
        .child(fence)
    }
}
