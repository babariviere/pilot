//! Retained exact-source task-edit form. Close does not cancel admitted saves.
use crate::{
    LocalOptions,
    task_edit::Target,
    task_edit::{self as model, Content, Outcome, State},
    task_edit_transport as wire,
    ui::{self, Action, Notice, Text, Tone},
};
use gpui_kit::{
    App, AppContext, ClipboardItem, Context, Entity, EntityInputHandler, EventEmitter, FocusHandle,
    Focusable, InteractiveElement, IntoElement, ParentElement, Render, SharedString, Styled,
    Subscription, Task, TestSupportExt, Window,
    component::{
        Disableable, StyledExt, WindowExt,
        input::{InputEvent, Textarea, TextareaState},
    },
    div,
    prelude::FluentBuilder,
};
use std::{cell::Cell, rc::Rc};
gpui_kit::actions!(task_edit, [SaveTaskEdit, CloseTaskEdit]);
struct Keys;
impl gpui_kit::Global for Keys {}
pub(crate) struct Close;
pub(crate) struct Form {
    pub(crate) source: Target,
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
    read: Option<Task<()>>,
    pub(crate) loaded: bool,
    base: Option<Content>,
}
impl EventEmitter<Close> for Form {}
impl Form {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    /// Edits differing from the loaded task that were never sent, or an unanswered save.
    pub(crate) fn update_hold(&self, cx: &gpui_kit::App) -> Option<crate::update_hold::Hold> {
        let edited = self.loaded
            && model::Content::capture(&self.title.read(cx).value(), &self.body.read(cx).value())
                .ok()
                .as_ref()
                != self.base.as_ref();
        crate::update_hold::Hold::of(
            matches!(self.state.attempt, Some((_, Outcome::Pending))),
            !self.state.blocked() && edited,
        )
    }
    pub(crate) fn new(
        source: Target,
        options: LocalOptions,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        if !cx.has_global::<Keys>() {
            cx.bind_keys([
                gpui_kit::KeyBinding::new("secondary-enter", SaveTaskEdit, Some("TaskEdit")),
                gpui_kit::KeyBinding::new("escape", CloseTaskEdit, Some("TaskEdit")),
            ]);
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
                .placeholder("Task body (optional)")
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
                    } else if v.draft[ix]!=value.as_ref() {v.draft[ix]=value.to_string();v.error=None;}
                    cx.notify();
                }
            }));
        }
        Self {
            source,
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
            read: None,
            loaded: false,
            base: None,
        }
    }
    pub(crate) fn matches(&self, source: &Target, options: &LocalOptions) -> bool {
        self.source == *source
            && self.options.host() == options.host()
            && self.options.loopback() == options.loopback()
    }
    pub(crate) fn load(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if self.loaded || self.read.is_some() {
            return;
        }
        let output = match wire::read(self.options.clone(), self.source.clone()) {
            Ok(output) => output,
            Err(e) => {
                self.error = Some(e);
                cx.notify();
                return;
            }
        };
        self.error = None;
        self.read = Some(cx.spawn_in(w, async move |view, cx| {
            let result = output
                .recv()
                .await
                .unwrap_or(Err("Task text reader stopped. No save sent."));
            let _ = view.update_in(cx, |v, w, cx| {
                v.read = None;
                match result {
                    Ok(m) => {
                        v.draft = [m.title.clone(), m.body.clone()];
                        v.title
                            .update(cx, |i, cx| i.set_value(m.title.clone(), w, cx));
                        v.body
                            .update(cx, |i, cx| i.set_value(m.body.clone(), w, cx));
                        v.base = Some(m);
                        v.loaded = true;
                    }
                    Err(e) => v.error = Some(e),
                }
                cx.notify();
            });
        }));
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
    pub(crate) fn open(form: Entity<Self>, w: &mut Window, cx: &mut App) {
        w.open_dialog(cx, {
            let form = form.clone();
            move |dialog, _, cx| {
                crate::ui::dialog(dialog, cx)
                    .title("Edit task")
                    .w(gpui_kit::px(520.))
                    .overlay_closable(false)
                    .close_button(false)
                    .keyboard(false)
                    // All dismissal goes through the retained form's IME guard.
                    .on_cancel(|_, _, _| false)
                    .child(form.clone())
            }
        });
        form.update(cx, |f, cx| f.focus(w, cx));
    }
    fn close(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if self.visible && !self.marked(w, cx) {
            cx.emit(Close);
        }
    }
    fn submit(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if !self.visible || !self.loaded || self.marked(w, cx) {
            return;
        }
        // Read native values at intent time, not queued Change delivery.
        let title = self.title.read(cx).value().to_string();
        let body = self.body.read(cx).value().to_string();
        if model::Content::capture(&title, &body).ok().as_ref() == self.base.as_ref() {
            return;
        }
        let submission = match self.state.begin(&self.source, &title, &body) {
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
                        let outcome=reply.unwrap_or(Outcome::Unknown("Task text worker stopped without a receipt. It may have committed. Do not replay."));
                        v.state.finish(&submission,outcome);cx.notify();
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
        let blocked = !self.loaded || self.state.blocked();
        let value = model::Content::capture(
            self.title.read(cx).value().as_ref(),
            self.body.read(cx).value().as_ref(),
        );
        let unchanged = value.as_ref().ok() == self.base.as_ref();
        let mut form = div()
            .id("task-edit-form")
            .test_support()
            .relative()
            .w_full()
            .min_w_0()
            .v_flex()
            .gap_2()
            .track_focus(&self.focus)
            .key_context("TaskEdit")
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
            .on_action(cx.listener(|v, _: &SaveTaskEdit, w, cx| v.submit(w, cx)))
            .on_action(cx.listener(|v, _: &CloseTaskEdit, w, cx| v.close(w, cx)))
            .child(ui::text(
                Text::Caption,
                SharedString::from(format!(
                    "Local mission {} · task #{}",
                    self.source.key.id, self.source.number
                )),
            ))
            .child(ui::text(
                Text::Caption,
                "Only title and body change. Draft retained through navigation, not app restart.",
            ));
        for (ix, (label, input, id)) in [
            ("Title", self.title.clone(), "task-edit-title"),
            ("Body", self.body.clone(), "task-edit-body"),
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
                    "Saving… Closing or navigating away does not cancel this captured save.".to_string(),
                    Tone::Normal,
                ),
                Outcome::NotSent(e) => (e.to_string(), Tone::Error),
                Outcome::Unknown(e) => (format!("Save unconfirmed. {e}"), Tone::Error),
                Outcome::Saved(_) => ("Saved. Local acknowledged this exact task title and body. Refresh tasks for current state.".to_string(),Tone::Normal),
            };
            form = form.child(
                div()
                    .id("task-edit-result")
                    .test_support()
                    .child(Notice::new(SharedString::from(text)).tone(tone)),
            );
        }
        if let Some(e) = self.error {
            form = form.child(Notice::new(e).tone(Tone::Error));
        }
        if !self.loaded {
            form = form.child(Notice::new(if self.read.is_some() {
                "Reading full title and body…"
            } else {
                "Task text unavailable. Close and reopen to read again."
            }));
        }
        form=form.child(Notice::new("No version check: concurrent edits may be overwritten. Only title and body are sent. Local records rename activity and reconciles phase/linked-ticket progress; existing coordinator notices may follow. No chat-start request is sent."));
        form.child(
            div()
                .h_flex()
                .flex_wrap()
                .gap_2()
                .child(
                    ui::action("task-edit-submit", "Save", Action::Primary)
                        .disabled(blocked || unchanged || value.is_err())
                        .tooltip("Save title and body in this exact Local mission (⌘Enter).")
                        .on_click(cx.listener(|v, _, w, cx| v.submit(w, cx))),
                )
                .child(
                    ui::action("task-edit-close", "Close", Action::Quiet)
                        .on_click(cx.listener(|v, _, w, cx| v.close(w, cx))),
                )
                .when(true, |d| {
                    d.child(
                        ui::action("task-edit-copy", "Copy text", Action::Quiet).on_click(
                            cx.listener(|v, _, _, cx| {
                                cx.write_to_clipboard(ClipboardItem::new_string(format!(
                                    "{}\n\n{}",
                                    v.title.read(cx).value(),
                                    v.body.read(cx).value()
                                )));
                            }),
                        ),
                    )
                })
                .when(
                    matches!(self.state.attempt.as_ref(), Some((_, Outcome::Saved(_)))),
                    |d| {
                        d.child(
                            ui::action("task-edit-edit-again", "Edit again", Action::Secondary)
                                .on_click(cx.listener(|v, _, w, cx| {
                                    if v.marked(w, cx)
                                        || !matches!(
                                            v.state.attempt.as_ref(),
                                            Some((_, Outcome::Saved(_)))
                                        )
                                    {
                                        return;
                                    }
                                    v.state = State::default();
                                    v.loaded = false;
                                    v.load(w, cx);
                                    cx.notify();
                                })),
                        )
                    },
                ),
        )
        .child(fence)
    }
}
