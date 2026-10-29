//! Browser-owned confirmation retained while hidden. Closing does not cancel an admitted operation.
use crate::{
    LocalOptions,
    mission_brief::Source,
    mission_lifecycle::{Action as Lifecycle, Outcome, Snapshot, State},
    mission_lifecycle_transport as wire,
    ui::{self, Action, Notice, Text, Tone},
};
use gpui_kit::{
    App, Context, EventEmitter, FocusHandle, InteractiveElement, IntoElement, ParentElement,
    Render, SharedString, Styled, Task, TestSupportExt, Window,
    component::{Disableable, StyledExt},
    div,
};
gpui_kit::actions!(mission_lifecycle, [ConfirmLifecycle, CloseLifecycle]);
struct Keys;
impl gpui_kit::Global for Keys {}
pub(crate) struct Close;
pub(crate) struct Form {
    pub(crate) source: Source,
    options: LocalOptions,
    pub(crate) visible: bool,
    pub(crate) available: bool,
    pub(crate) state: State,
    pub(crate) snapshot: Option<Snapshot>,
    action: Lifecycle,
    error: Option<&'static str>,
    focus: FocusHandle,
    read: Option<Task<()>>,
    completion: Option<Task<()>>,
}
impl EventEmitter<Close> for Form {}
impl Form {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    /// Only an unanswered request is held; this form has no typed input.
    pub(crate) fn update_hold(&self) -> Option<crate::update_hold::Hold> {
        crate::update_hold::Hold::of(
            matches!(self.state.attempt, Some((_, Outcome::Pending))),
            false,
        )
    }
    pub(crate) fn new(
        source: Source,
        options: LocalOptions,
        action: Lifecycle,
        cx: &mut Context<Self>,
    ) -> Self {
        if !cx.has_global::<Keys>() {
            cx.bind_keys([
                gpui_kit::KeyBinding::new("enter", ConfirmLifecycle, Some("MissionLifecycle")),
                gpui_kit::KeyBinding::new(
                    "secondary-enter",
                    ConfirmLifecycle,
                    Some("MissionLifecycle"),
                ),
                gpui_kit::KeyBinding::new("escape", CloseLifecycle, Some("MissionLifecycle")),
            ]);
            cx.set_global(Keys);
        }
        Self {
            source,
            options,
            visible: true,
            available: true,
            state: State::default(),
            snapshot: None,
            action,
            error: None,
            focus: cx.focus_handle(),
            read: None,
            completion: None,
        }
    }
    pub(crate) fn prepare(&mut self, action: Lifecycle) {
        if matches!(
            self.state.attempt.as_ref(),
            Some((_, Outcome::Pending | Outcome::Unknown(_)))
        ) {
            return;
        }
        if self.action != action {
            self.state = State::default();
            self.snapshot = None;
            self.action = action;
        }
    }
    pub(crate) fn matches(&self, s: &Source, o: &LocalOptions) -> bool {
        self.source == *s
            && self.options.host() == o.host()
            && self.options.loopback() == o.loopback()
    }
    pub(crate) fn focus_handle(&self) -> FocusHandle {
        self.focus.clone()
    }
    pub(crate) fn focus(&self, w: &mut Window, cx: &mut App) {
        self.focus.focus(w, cx);
    }
    pub(crate) fn owns_focus(&self, w: &Window, cx: &App) -> bool {
        self.focus.contains_focused(w, cx)
    }
    pub(crate) fn load(&mut self, cx: &mut Context<Self>) {
        if self.snapshot.is_some() || self.read.is_some() || self.state.attempt.is_some() {
            return;
        }
        let output = match wire::read(self.options.clone(), self.source.clone(), self.action) {
            Ok(o) => o,
            Err(e) => {
                self.error = Some(e);
                cx.notify();
                return;
            }
        };
        self.error = None;
        self.read = Some(cx.spawn(async move |view, cx| {
            let reply = output
                .recv()
                .await
                .unwrap_or(Err("Couldn't load the mission. Nothing was sent."));
            let _ = view.update(cx, |v, cx| {
                v.read = None;
                match reply {
                    Ok(s) => v.snapshot = Some(s),
                    Err(e) => v.error = Some(e),
                }
                cx.notify();
            });
        }));
    }
    fn submit(&mut self, cx: &mut Context<Self>) {
        if !self.visible || !self.available || self.read.is_some() {
            return;
        }
        let Some(before) = &self.snapshot else {
            return;
        };
        let send = match self.state.begin(&self.source, before, self.action) {
            Ok(s) => s,
            Err(e) => {
                self.error = Some(e);
                cx.notify();
                return;
            }
        };
        self.error = None;
        match wire::start(self.options.clone(), send.clone()) {
            Err(e) => {
                self.state.finish(&send, Outcome::NotSent(e));
            }
            Ok(output) => {
                self.completion = Some(cx.spawn(async move |view, cx| {
                    let outcome = output.recv().await.unwrap_or(Outcome::Unknown(
                        "Couldn't confirm the change. It may have applied; don't repeat it.",
                    ));
                    let _ = view.update(cx, |v, cx| {
                        v.state.finish(&send, outcome);
                        cx.notify();
                    });
                }))
            }
        }
        cx.notify();
    }
    fn close(&self, cx: &mut Context<Self>) {
        if self.visible {
            cx.emit(Close);
        }
    }
}
impl Render for Form {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let blocked = !self.available
            || self
                .snapshot
                .as_ref()
                .is_none_or(|s| !self.action.eligible(s))
            || self.state.attempt.is_some()
            || self.read.is_some();
        let mut form=div().id("mission-lifecycle").test_support().track_focus(&self.focus).key_context("MissionLifecycle").w_full().min_w_0().v_flex().gap_3()
            .on_action(cx.listener(|v,_:&ConfirmLifecycle,_,cx|v.submit(cx)))
            .on_action(cx.listener(|v,_:&CloseLifecycle,_,cx|v.close(cx)))
            .child(ui::heading("lifecycle-heading",self.action.label(),Text::Headline))
            .child(ui::text(Text::Body,SharedString::from(self.snapshot.as_ref().map_or("Reading mission…".into(),|s|s.title.clone()))))
            .child(ui::text(Text::Caption,SharedString::from(format!("Local mission {} · Home {} / {}",self.source.key.id,self.source.key.home.daemon,self.source.key.home.lineage))))
            .child(Notice::new("Marking done or archiving also archives the coordinator after its current work finishes. Member chats, tasks, brief and history are kept. No work is started or stopped."))
            .child(Notice::new("Automatic coordinator notices stay paused for this mission, including after restart. Use its chats explicitly. Reopening does not restore an already archived chat."));
        if let Some(s) = &self.snapshot {
            if self.action == Lifecycle::Complete
                && let Some(f) = &s.finished
            {
                form = form.child(ui::text(
                    Text::Body,
                    SharedString::from(if f.dropped == 0 {
                        format!("{} tasks done", f.done)
                    } else {
                        format!("{} done · {} dropped", f.done, f.dropped)
                    }),
                ));
            }
            form = form.child(ui::text(
                Text::Caption,
                SharedString::from(format!("{} → {}", s.status, self.action.status())),
            ));
        }
        if let Some((_, outcome)) = &self.state.attempt {
            let (text, tone) = match outcome {
                Outcome::Pending => (
                    "Updating mission… Closing or navigating away does not cancel this action."
                        .into(),
                    Tone::Normal,
                ),
                Outcome::Ack => (
                    format!(
                        "Done: {}. Refresh the overview to see it.",
                        self.action.status()
                    ),
                    Tone::Normal,
                ),
                Outcome::NotSent(e) => (format!("Not sent. {e}"), Tone::Error),
                Outcome::Unknown(e) => (format!("Delivery unknown. {e}"), Tone::Error),
            };
            form = form.child(
                div()
                    .id("lifecycle-result")
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
                    ui::action("lifecycle-submit", self.action.label(), Action::Primary)
                        .disabled(blocked)
                        .tooltip("Confirm (⌘Enter)")
                        .on_click(cx.listener(|v, _, _, cx| v.submit(cx))),
                )
                .child(
                    ui::action(
                        "lifecycle-close",
                        if self.state.attempt.is_none() {
                            "Cancel"
                        } else {
                            "Close"
                        },
                        Action::Quiet,
                    )
                    .on_click(cx.listener(|v, _, _, cx| v.close(cx))),
                )
                .children(
                    (self.error.is_some()
                        || matches!(
                            self.state.attempt.as_ref(),
                            Some((_, Outcome::NotSent(_) | Outcome::Ack))
                        ))
                    .then(|| {
                        ui::action("lifecycle-review", "Review again", Action::Quiet)
                            .disabled(
                                self.read.is_some()
                                    || matches!(
                                        self.state.attempt.as_ref(),
                                        Some((_, Outcome::Pending | Outcome::Unknown(_)))
                                    ),
                            )
                            .on_click(cx.listener(|v, _, _, cx| {
                                if v.read.is_some()
                                    || matches!(
                                        v.state.attempt.as_ref(),
                                        Some((_, Outcome::Pending | Outcome::Unknown(_)))
                                    )
                                {
                                    return;
                                }
                                v.state = State::default();
                                v.snapshot = None;
                                v.load(cx);
                            }))
                    }),
                ),
        )
    }
}
