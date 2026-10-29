//! Bounded retained forms, pinned by canonical home and mission. No disk state.
use crate::{
    LocalOptions,
    mission_browser::Key,
    mission_update::{self as model, Outcome, State},
    mission_update_transport as wire,
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
gpui_kit::actions!(mission_update, [SubmitUpdate, CloseUpdate]);
struct Keys;
impl gpui_kit::Global for Keys {}
pub(crate) struct Close;
pub(crate) struct Form {
    pub(crate) key: Key,
    options: LocalOptions,
    pub(crate) visible: bool,
    pub(crate) state: State,
    pub(crate) text: Entity<TextareaState>,
    draft: String,
    error: Option<&'static str>,
    focus: FocusHandle,
    bounds: Rc<Cell<Option<gpui_kit::Bounds<gpui_kit::Pixels>>>>,
    _input: Subscription,
    completion: Option<Task<()>>,
}
impl EventEmitter<Close> for Form {}
impl Form {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    /// A typed, unposted update, or an unanswered post.
    pub(crate) fn update_hold(&self, cx: &gpui_kit::App) -> Option<crate::update_hold::Hold> {
        crate::update_hold::Hold::of(
            matches!(self.state.attempt, Some((_, Outcome::Pending))),
            !self.state.blocked() && !self.text.read(cx).value().trim().is_empty(),
        )
    }
    fn new(key: Key, options: LocalOptions, w: &mut Window, cx: &mut Context<Self>) -> Self {
        if !cx.has_global::<Keys>() {
            cx.bind_keys([
                gpui_kit::KeyBinding::new("secondary-enter", SubmitUpdate, Some("MissionUpdate")),
                gpui_kit::KeyBinding::new("escape", CloseUpdate, Some("MissionUpdate")),
            ]);
            cx.set_global(Keys);
        }
        let text = cx.new(|cx| {
            let mut t = TextareaState::new(w, cx)
                .placeholder("Write a mission update")
                .auto_grow(4, 8);
            t.set_submit_on_enter(false, cx);
            t
        });
        let input = cx.subscribe_in(&text, w, |v, _, event, w, cx| {
            if matches!(event, InputEvent::Change) {
                let value = v.text.read(cx).value();
                if value.encode_utf16().count() > model::TEXT_UNITS {
                    let previous = v.draft.clone();
                    v.text.update(cx, |i, cx| i.set_value(previous, w, cx));
                    v.error = Some("Edit exceeds 8,000 UTF-16 units and was rejected in full. Previous text is retained; undo history was reset.");
                } else { v.draft = value.to_string(); v.error = None; }
                cx.notify();
            }
        });
        Self {
            key,
            options,
            visible: true,
            state: State::default(),
            text,
            draft: String::new(),
            error: None,
            focus: cx.focus_handle(),
            bounds: Default::default(),
            _input: input,
            completion: None,
        }
    }
    pub(crate) fn marked(&mut self, w: &mut Window, cx: &mut Context<Self>) -> bool {
        self.visible
            && self
                .text
                .update(cx, |i, cx| i.marked_text_range(w, cx).is_some())
    }
    fn focus(&self, w: &mut Window, cx: &mut App) {
        if self.state.blocked() {
            self.focus.focus(w, cx);
        } else {
            self.text.read(cx).focus_handle(cx).focus(w, cx);
        }
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
        if self.state.blocked() {
            return;
        }
        let text = self.text.read(cx).value().to_string();
        let s = match self.state.begin(&self.key, &text) {
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
            Ok(output) => {
                self.completion = Some(cx.spawn(async move |view, cx| {
                    let reply = output.recv().await;
                    let _ = view.update(cx, |v, cx| {
                        let (s, outcome) = match reply {
                            Ok(r) => (r.submission, r.outcome),
                            Err(_) => (s, Outcome::Unknown("Worker stopped without a receipt. The update may exist. Do not resubmit.")),
                        };
                        // Hidden exact completions update delivery, never text, focus or visibility.
                        v.state.finish(&s, outcome); cx.notify();
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
                                v.marked(w, cx)
                                    && v.bounds.get().is_none_or(|b| !b.contains(&event.position))
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
        self.bounds.set(None);
        let bounds = self.bounds.clone();
        let mut form = div().id("mission-update-form").test_support().relative().w_full().min_w_0().v_flex().gap_2().track_focus(&self.focus).key_context("MissionUpdate")
            .capture_action(cx.listener(|v, e: &gpui_kit::base::input::Enter, w, cx| {
                if e.secondary && !e.shift { cx.stop_propagation(); v.submit(w, cx); }
            }))
            .capture_action(cx.listener(|v, _: &gpui_kit::base::input::Escape, w, cx| { cx.stop_propagation(); v.close(w, cx); }))
            .on_action(cx.listener(|v, _: &SubmitUpdate, w, cx| v.submit(w, cx)))
            .on_action(cx.listener(|v, _: &CloseUpdate, w, cx| v.close(w, cx)))
            .child(ui::heading("mission-update-heading", "Post an update", Text::Headline))
            .child(ui::text(Text::Caption, SharedString::from(format!("Mission: {}", self.key.id))))
            .child(ui::text(Text::Caption, "Posted as your update, without starting a chat. Text and delivery state stay here through navigation, not app restart."))
            .child(ui::FieldRow::new("mission-update-field", "Update",
                div().id("mission-update-text").test_support().relative().w_full().min_w_0()
                    .child(Textarea::new(&self.text).aria_label("Mission update").disabled(blocked))
                    .child(gpui_kit::canvas(|_, _, _| (), move |b, (), _, _| bounds.set(Some(b))).absolute().inset_0().size_full())));
        if let Some((_, outcome)) = &self.state.attempt {
            let (text, tone) = match outcome {
                Outcome::Pending => (
                    "Posting update… Closing does not cancel this submission.".into(),
                    Tone::Normal,
                ),
                Outcome::NotSent(e) => (e.to_string(), Tone::Error),
                Outcome::Unknown(e) => (format!("Delivery unknown. {e}"), Tone::Error),
                Outcome::Acknowledged(id) => (
                    format!(
                        "Update acknowledged (event #{id}). Refresh activity separately. HTTP ACK received; no independent fsync receipt is exposed."
                    ),
                    Tone::Normal,
                ),
            };
            form = form.child(
                div()
                    .id("mission-update-result")
                    .test_support()
                    .child(Notice::new(SharedString::from(text)).tone(tone)),
            );
        }
        if let Some(e) = self.error {
            form = form.child(Notice::new(e).tone(Tone::Error));
        }
        form.child(div().h_flex().flex_wrap().gap_2()
            .child(ui::action("mission-update-submit", "Submit", Action::Primary).disabled(blocked)
                .tooltip("Post this user-authored update to the captured Local mission (⌘Enter).")
                .on_click(cx.listener(|v, _, w, cx| v.submit(w, cx))))
            .child(ui::action("mission-update-close", "Close", Action::Quiet).on_click(cx.listener(|v, _, w, cx| v.close(w, cx))))
            .when(self.state.attempt.is_some(), |d| d.child(ui::action("mission-update-copy", "Copy text", Action::Quiet).on_click(cx.listener(|v, _, _, cx| {
                cx.write_to_clipboard(ClipboardItem::new_string(v.text.read(cx).value().to_string()));
            }))))
            .when(matches!(self.state.attempt.as_ref(), Some((_, Outcome::Acknowledged(_)))), |d| d.child(
                ui::action("mission-update-another", "New update", Action::Secondary).on_click(cx.listener(|v, _, w, cx| {
                    if !v.visible || v.marked(w, cx) || !matches!(v.state.attempt.as_ref(), Some((_, Outcome::Acknowledged(_)))) { return; }
                    v.state = State::default(); v.draft.clear(); v.error = None;
                    v.text.update(cx, |i, cx| i.set_value("", w, cx));
                    v.focus(w, cx); cx.notify();
                }))
            )))
            .child(fence)
    }
}

/// No eviction of drafts or Unknown attempts to make room for another mission.
pub(crate) struct Shelf {
    forms: Vec<Entity<Form>>,
    pub(crate) current: Option<Entity<Form>>,
    subscriptions: Vec<Subscription>,
}
impl Shelf {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    pub(crate) fn update_hold(&self, cx: &App) -> Option<(Key, crate::update_hold::Hold)> {
        self.forms.iter().find_map(|f| {
            let f = f.read(cx);
            f.update_hold(cx).map(|h| (f.key.clone(), h))
        })
    }
    pub(crate) fn new(_: &mut Context<Self>) -> Self {
        Self {
            forms: Vec::new(),
            current: None,
            subscriptions: Vec::new(),
        }
    }
    pub(crate) fn marked(&mut self, w: &mut Window, cx: &mut Context<Self>) -> bool {
        self.current
            .as_ref()
            .is_some_and(|f| f.update(cx, |f, cx| f.marked(w, cx)))
    }
    pub(crate) fn hide(&mut self, cx: &mut Context<Self>) {
        if let Some(f) = self.current.take() {
            f.update(cx, |f, cx| {
                f.visible = false;
                cx.notify();
            });
        }
        cx.notify();
    }
    pub(crate) fn show(
        &mut self,
        key: Key,
        options: LocalOptions,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) -> Result<(), &'static str> {
        if self.marked(w, cx) {
            return Err("Finish composing before changing the update form.");
        }
        let form = if let Some(f) = self.forms.iter().find(|f| {
            let f = f.read(cx);
            f.key == key
                && f.options.host() == options.host()
                && f.options.loopback() == options.loopback()
        }) {
            f.clone()
        } else {
            let f = cx.new(|cx| Form::new(key, options, w, cx));
            self.subscriptions
                .push(cx.subscribe_in(&f, w, |v, form, _: &Close, _, cx| {
                    if v.current.as_ref() == Some(form) {
                        cx.emit(Close); // Parent restores mounted activity focus before unmount.
                    }
                }));
            self.forms.push(f.clone());
            f
        };
        self.hide(cx);
        form.update(cx, |f, cx| {
            f.visible = true;
            f.focus(w, cx);
            cx.notify();
        });
        self.current = Some(form);
        cx.notify();
        Ok(())
    }
}
impl EventEmitter<Close> for Shelf {}
impl Render for Shelf {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div().w_full().min_w_0().children(self.current.clone())
    }
}
