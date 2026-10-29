//! Retained per-exact-task confirmation. No editor, implicit submit or GET settlement.
use crate::{
    LocalOptions,
    task_status::{self as model, Outcome, State, Target},
    task_status_transport as wire,
    ui::{self, Action, Notice, Text, Tone},
};
use gpui_kit::{
    App, Context, Entity, EventEmitter, FocusHandle, InteractiveElement, IntoElement,
    ParentElement, Render, SharedString, Styled, Task, TestSupportExt, Window,
    component::{Disableable, Selectable, StyledExt, WindowExt},
    div, px,
};
pub(crate) enum Event {
    Close,
    NewIntent,
}
pub(crate) struct Form {
    pub(crate) target: Target,
    options: LocalOptions,
    pub(crate) visible: bool,
    pub(crate) chosen: String,
    pub(crate) state: State,
    error: Option<&'static str>,
    focus: FocusHandle,
    completion: Option<Task<()>>,
}
impl EventEmitter<Event> for Form {}
impl Form {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    /// A chosen, unsent status, or an unanswered change.
    pub(crate) fn update_hold(&self) -> Option<crate::update_hold::Hold> {
        crate::update_hold::Hold::of(
            matches!(self.state.attempt, Some((_, Outcome::Pending))),
            !self.state.blocked() && self.chosen != self.target.current,
        )
    }
    pub(crate) fn new(target: Target, options: LocalOptions, cx: &mut Context<Self>) -> Self {
        Self {
            chosen: target.current.clone(),
            target,
            options,
            visible: true,
            state: State::default(),
            error: None,
            focus: cx.focus_handle(),
            completion: None,
        }
    }
    pub(crate) fn matches(&self, target: &Target, options: &LocalOptions) -> bool {
        self.target.key == target.key
            && self.target.task == target.task
            && self.options.host() == options.host()
            && self.options.loopback() == options.loopback()
    }
    pub(crate) fn owns_focus(&self, w: &Window, cx: &App) -> bool {
        self.focus.contains_focused(w, cx)
    }
    pub(crate) fn focus(&self, w: &mut Window, cx: &mut App) {
        self.focus.focus(w, cx);
    }
    /// Show the form as a dialog; Close and Escape go through the form.
    pub(crate) fn open(form: Entity<Self>, w: &mut Window, cx: &mut App) {
        let title =
            SharedString::from(format!("Change status of #{}", form.read(cx).target.number));
        w.open_dialog(cx, {
            let form = form.clone();
            move |d, _, cx| {
                crate::ui::dialog(d, cx)
                    .title(title.clone())
                    .w(px(520.))
                    .overlay_closable(false)
                    .close_button(false)
                    .keyboard(false)
                    .on_cancel(|_, _, _| false)
                    .child(form.clone())
            }
        });
        form.update(cx, |f, cx| f.focus(w, cx));
    }
    pub(crate) fn new_intent(&mut self, target: Target, cx: &mut Context<Self>) {
        if !self.visible
            || self.target.key != target.key
            || self.target.task != target.task
            || !self
                .state
                .attempt
                .as_ref()
                .is_some_and(|(_, o)| matches!(o, Outcome::Acknowledged | Outcome::NotSent(_)))
        {
            return;
        }
        self.chosen = target.current.clone();
        self.target = target;
        self.state = State::default();
        self.error = None;
        cx.notify();
    }
    fn submit(&mut self, cx: &mut Context<Self>) {
        if !self.visible {
            return;
        }
        let s = match self.state.begin(&self.target, &self.chosen) {
            Ok(s) => s,
            Err(e) => {
                self.error = Some(e);
                cx.notify();
                return;
            }
        };
        self.error = None;
        match wire::start(self.options.clone(), s.clone()) {
            Err(e) => {
                self.state.finish(&s, Outcome::NotSent(e));
            }
            Ok(rx) => {
                self.completion = Some(cx.spawn(async move |view, cx| {
                    let reply = rx.recv().await;
                    let _ = view.update(cx, |v, cx| {
                        let (s, o) = match reply {
                            Ok(r) => (r.submission, r.outcome),
                            Err(_) => (
                                s,
                                Outcome::Unknown(
                                    "Couldn't confirm the change. It may have applied.",
                                ),
                            ),
                        };
                        v.state.finish(&s, o);
                        cx.notify();
                    });
                }));
            }
        }
        cx.notify();
    }
}
impl Render for Form {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let blocked = self.state.blocked();
        let mut root = div()
            .id("task-status-form")
            .test_support()
            .v_flex()
            .w_full()
            .min_w_0()
            .gap_2()
            .track_focus(&self.focus)
            .on_key_down(cx.listener(|v, e: &gpui_kit::KeyDownEvent, _, cx| {
                if e.keystroke.key == "escape" && v.visible {
                    cx.stop_propagation();
                    cx.emit(Event::Close);
                }
            }))
            .child(ui::text(
                Text::Body,
                SharedString::from(self.target.title.clone()),
            ))
            .child(ui::text(
                Text::Label,
                SharedString::from(format!(
                    "{} → {}",
                    model::label(&self.target.current),
                    model::label(&self.chosen)
                )),
            ));
        let mut choices = div().h_flex().flex_wrap().gap_2();
        for status in model::STATUSES {
            choices = choices.child(
                ui::action(
                    SharedString::from(format!("task-status-{status}")),
                    model::label(status),
                    Action::Secondary,
                )
                .selected(self.chosen == status)
                .disabled(blocked || status == self.target.current)
                .on_click(cx.listener(move |v, _, _, cx| {
                    if v.visible && !v.state.blocked() {
                        v.chosen = status.into();
                        cx.notify();
                    }
                })),
            );
        }
        root = root.child(choices);
        if model::backward(&self.target.current, &self.chosen) {
            root=root.child(Notice::new("Moving work backward permanently disables automatic linked-PR status sync, even for future links.").tone(Tone::Warning));
        }
        if let Some((_, o)) = &self.state.attempt {
            let (text, tone) = match o {
                Outcome::Pending => (
                    "Changing status… Closing does not cancel the request.",
                    Tone::Normal,
                ),
                Outcome::NotSent(e) => (*e, Tone::Error),
                Outcome::Unknown(e) => (*e, Tone::Error),
                Outcome::Acknowledged => (
                    "Status changed. Refresh tasks to see the current state.",
                    Tone::Normal,
                ),
            };
            root = root.child(
                div()
                    .id("task-status-result")
                    .test_support()
                    .child(Notice::new(text).tone(tone)),
            );
        }
        if let Some(e) = self.error {
            root = root.child(Notice::new(e).tone(Tone::Error));
        }
        if self
            .state
            .attempt
            .as_ref()
            .is_some_and(|(_, o)| matches!(o, Outcome::Acknowledged | Outcome::NotSent(_)))
        {
            root = root.child(
                ui::action(
                    "task-status-new-intent",
                    "Use refreshed task for a new change",
                    Action::Quiet,
                )
                .on_click(cx.listener(|v, _, _, cx| {
                    if v.visible {
                        cx.emit(Event::NewIntent);
                    }
                })),
            );
        }
        root.child(
            div()
                .h_flex()
                .justify_end()
                .gap_2()
                .child(
                    ui::action("task-status-close", "Close", Action::Quiet).on_click(cx.listener(
                        |v, _, _, cx| {
                            if v.visible {
                                cx.emit(Event::Close);
                            }
                        },
                    )),
                )
                .child(
                    ui::action("task-status-submit", "Change status", Action::Primary)
                        .disabled(blocked || self.chosen == self.target.current)
                        .on_click(cx.listener(|v, _, _, cx| v.submit(cx))),
                ),
        )
    }
}
