//! User-confirmed existing-chat conversion. Inputs and IME stay owned here;
//! the existing private writer owns durability, transport and unknown outcomes.
use crate::{
    delivery_store::Book,
    interaction::{Interaction, WriteCommand, WriteState},
    mission_conversion::{Action as Command, Inspection, Outcome, Request, Target, trim_text},
    ui::{self, Action, FieldRow, Notice, Text, Tone},
};
#[cfg(test)]
use gpui_kit::px;
use gpui_kit::{
    App, AppContext, Context, Entity, EntityInputHandler, EventEmitter, FocusHandle,
    InteractiveElement, IntoElement, ParentElement, Render, SharedString,
    StatefulInteractiveElement, Styled, Subscription, TestSupportExt, Window,
    base::FocusTrapElement,
    component::{
        ActiveTheme, Disableable, StyledExt,
        checkbox::Checkbox,
        input::{Input, InputEvent, InputState, Textarea, TextareaState},
    },
    div,
    prelude::FluentBuilder,
};
use std::sync::Arc;

gpui_kit::actions!(mission_form, [ConfirmMission, CancelMission]);
pub(crate) enum Event {
    Close,
}

pub(crate) struct MissionForm {
    client: Option<Interaction>,
    book: Option<Arc<Book>>,
    receipts: Arc<std::collections::BTreeMap<String, crate::mission_conversion::Receipt>>,
    target: Option<Target>,
    pub(crate) title: Entity<InputState>,
    pub(crate) goal: Entity<TextareaState>,
    focus: FocusHandle,
    coordinator: bool,
    draft: bool,
    request: u64,
    applied_request: u64,
    applied_result: Option<Result<Inspection, &'static str>>,
    attempt: String,
    pending: bool,
    ready: bool,
    open: bool,
    result: Option<Result<Inspection, &'static str>>,
    state_error: Option<&'static str>,
    _subscriptions: Vec<Subscription>,
}
impl EventEmitter<Event> for MissionForm {}

impl MissionForm {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    pub(crate) fn restart_safe(&self, cx: &gpui_kit::App) -> bool {
        !self.pending
            && !self.open
            && self.title.read(cx).value().is_empty()
            && self.goal.read(cx).value().is_empty()
    }
    pub(crate) fn new(
        client: Option<Interaction>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let title = cx.new(|cx| InputState::new(window, cx).placeholder("Mission title"));
        let goal = cx.new(|cx| {
            let mut state = TextareaState::new(window, cx)
                .placeholder("What should this mission accomplish?")
                .auto_grow(3, 5);
            state.set_submit_on_enter(false, cx);
            state
        });
        let changed = cx.subscribe(&title, |_, _, event, cx| {
            if matches!(event, InputEvent::Change) {
                cx.notify();
            }
        });
        let goal_changed = cx.subscribe(&goal, |_, _, event, cx| {
            if matches!(event, InputEvent::Change) {
                cx.notify();
            }
        });
        Self {
            client,
            book: None,
            receipts: Default::default(),
            target: None,
            title,
            goal,
            focus: cx.focus_handle(),
            coordinator: true,
            draft: true,
            request: 0,
            applied_request: 0,
            applied_result: None,
            attempt: String::new(),
            pending: false,
            ready: false,
            open: false,
            result: None,
            state_error: None,
            _subscriptions: vec![changed, goal_changed],
        }
    }
    pub(crate) fn has_attempt(&self, source: &str) -> bool {
        self.book
            .as_ref()
            .is_some_and(|book| book.missions.contains_key(source))
    }
    pub(crate) fn pending(&self) -> bool {
        self.pending
    }
    pub(crate) fn receipt_access(&self, source: &str, project: &str) -> bool {
        self.book
            .as_ref()
            .and_then(|b| b.missions.get(source))
            .is_some_and(|a| a.request.project_id == project && a.outcome != Outcome::Rejected)
    }
    fn created_id(&self) -> Option<&str> {
        let target = self.target.as_ref()?;
        let attempt = self.attempt()?;
        if attempt.request.project_id != target.project {
            return None;
        }
        if let Outcome::Created { mission_id } = &attempt.outcome {
            return Some(mission_id);
        }
        self.receipts
            .get(&target.source)
            .filter(|r| r.matches(attempt))
            .map(|r| r.mission_id.as_str())
    }
    #[cfg(feature = "native-probes")]
    pub(crate) fn probe_state(&self) -> (bool, bool, Option<Outcome>, bool) {
        (
            self.ready,
            self.pending,
            self.attempt().map(|a| a.outcome.clone()),
            matches!(self.result, Some(Err(_))),
        )
    }
    fn attempt(&self) -> Option<&crate::mission_conversion::Attempt> {
        self.book
            .as_ref()?
            .missions
            .get(&self.target.as_ref()?.source)
    }
    pub(crate) fn marked(&self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        self.title
            .update(cx, |v, cx| v.marked_text_range(window, cx).is_some())
            || self
                .goal
                .update(cx, |v, cx| v.marked_text_range(window, cx).is_some())
    }
    pub(crate) fn open(
        &mut self,
        target: Target,
        title: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.target = Some(target);
        self.attempt = uuid::Uuid::new_v4().to_string();
        self.ready = false;
        self.pending = false;
        self.open = true;
        self.result = None;
        let request = self.attempt().map(|attempt| attempt.request.clone());
        let (title, goal, coordinator, draft) = match request {
            Some(r) => (r.title, r.goal, r.coordinator, r.draft),
            None => (bounded_title(title), String::new(), true, true),
        };
        self.title
            .update(cx, |v, cx| v.set_value(title, window, cx));
        self.goal.update(cx, |v, cx| v.set_value(goal, window, cx));
        self.coordinator = coordinator;
        self.draft = draft;
        self.focus.focus(window, cx);
        if self.state_error.is_none() {
            self.command(Command::Inspect, cx);
        }
        cx.notify();
    }
    pub(crate) fn close(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.open || self.marked(window, cx) {
            return;
        }
        self.open = false;
        cx.emit(Event::Close);
        cx.notify();
    }
    fn command(&mut self, action: Command, cx: &mut Context<Self>) {
        let Some(target) = self.target.clone() else {
            return;
        };
        self.request = self
            .request
            .checked_add(1)
            .expect("mission form request exhausted");
        self.pending = self.client.as_ref().is_some_and(|client| {
            client.command(WriteCommand::Mission {
                target,
                request: self.request,
                action,
            })
        });
        if !self.pending {
            self.result = Some(Err(
                "Local writer unavailable or busy. Nothing new was submitted.",
            ));
        }
        cx.notify();
    }
    fn captured(&self, cx: &App) -> Option<Request> {
        let target = self.target.as_ref()?;
        Some(Request {
            project_id: target.project.clone(),
            from_session_id: target.source.clone(),
            title: trim_text(self.title.read(cx).value().as_ref()).to_string(),
            goal: trim_text(self.goal.read(cx).value().as_ref()).to_string(),
            coordinator: self.coordinator,
            draft: self.draft,
        })
    }
    fn editable(&self) -> bool {
        self.ready
            && !self.pending
            && self.state_error.is_none()
            && self
                .attempt()
                .is_none_or(|attempt| attempt.outcome == Outcome::Rejected)
    }
    pub(crate) fn confirm(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.open || !self.editable() || self.marked(window, cx) {
            return;
        }
        let Some(request) = self.captured(cx) else {
            return;
        };
        if let Err(error) = request.validate() {
            self.result = Some(Err(error));
            cx.notify();
            return;
        }
        self.ready = false;
        self.command(
            Command::Submit {
                id: self.attempt.clone(),
                request,
            },
            cx,
        );
        self.focus.focus(window, cx);
    }
    fn check(&mut self, cx: &mut Context<Self>) {
        if self.pending {
            return;
        }
        self.command(
            if self.attempt().is_some() {
                Command::Check
            } else {
                Command::Inspect
            },
            cx,
        );
    }
    pub(crate) fn accept(
        &mut self,
        state: &WriteState,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.book = state.book.clone();
        self.receipts = state.mission_receipts.clone();
        self.state_error = state.error;
        if let Some(reply) = &state.mission
            && self.target.as_ref() == Some(&reply.target)
            && self.request == reply.request
            && (self.applied_request != reply.request
                || self.applied_result.as_ref() != Some(&reply.result))
        {
            self.applied_request = reply.request;
            self.applied_result = Some(reply.result.clone());
            self.pending = matches!(reply.result, Ok(Inspection::Pending));
            self.ready = matches!(reply.result, Ok(Inspection::Ready { .. }));
            if self.open
                && let Ok(Inspection::Ready { title }) = &reply.result
            {
                if trim_text(self.title.read(cx).value().as_ref()).is_empty()
                    && !self.marked(window, cx)
                {
                    self.title
                        .update(cx, |v, cx| v.set_value(bounded_title(title), window, cx));
                }
                if self.focus.is_focused(window) {
                    self.title.update(cx, |v, cx| v.focus(window, cx));
                }
            }
            self.result = Some(reply.result.clone());
        }
        if self.open {
            cx.notify();
        }
    }
    fn status(&self) -> Notice {
        if let Some(error) = self.state_error {
            return if let Some(mission_id) = self.created_id() {
                Notice::new(error).detail(SharedString::from(format!("Known created mission: {mission_id}. Its private receipt could not be confirmed. Do not resubmit."))).tone(Tone::Error)
            } else {
                Notice::new(error).tone(Tone::Error)
            };
        }
        if self.pending {
            return Notice::new(if self.attempt().is_some() {
                "Waiting for Local…"
            } else {
                "Checking this chat…"
            })
            .detail("Closing this sheet does not cancel a submitted request. It is never resent automatically.")
            .tone(Tone::Quiet);
        }
        if let Some(Err(error)) = &self.result {
            return Notice::new(*error).tone(Tone::Error);
        }
        let created = self.created_id();
        if let Some(id) = created {
            let membership = match &self.result {
                Some(Ok(Inspection::Membership {
                    mission_id: Some(current),
                })) => format!(" Latest observed membership: {current}."),
                Some(Ok(Inspection::Membership { mission_id: None })) => {
                    " No current mission membership was found.".into()
                }
                _ => String::new(),
            };
            return Notice::new("Mission created.")
                .detail(SharedString::from(format!(
                    "Mission {id}.{membership} Drafting delivery is not independently confirmed."
                )))
                .tone(Tone::Success);
        }
        if let Some(Ok(Inspection::Membership { mission_id })) = &self.result {
            return Notice::new(if mission_id.is_some(){"Current mission membership confirmed."}else{"No current mission membership found."})
                .detail(SharedString::from(mission_id.as_ref().map_or_else(||"The earlier request remains unconfirmed. It will not be resent.".into(),|id|format!("Mission {id}. This confirms current association, not whether this request created it. It will not be resent."))));
        }
        if self.attempt().is_some() || matches!(self.result, Some(Ok(Inspection::Uncertain))) {
            return Notice::new("Conversion is unconfirmed. Do not submit it again.")
                .detail(
                    "Check current membership. Closing or restarting never resends this request.",
                )
                .tone(Tone::Warning);
        }
        Notice::new("Keep the same conversation, drafts and chat permissions.").tone(Tone::Quiet)
    }
}

fn bounded_title(value: &str) -> String {
    let mut units = 0;
    trim_text(value)
        .chars()
        .take_while(|ch| {
            units += ch.len_utf16();
            units <= 200
        })
        .collect()
}

impl Render for MissionForm {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let editable = self.editable();
        let validation = self
            .captured(cx)
            .and_then(|request| request.validate().err());
        let valid = self.target.is_some() && validation.is_none();
        let notice = if editable && let Some(error) = validation {
            Notice::new(error).tone(Tone::Error)
        } else {
            self.status()
        };
        let has_attempt = self.attempt().is_some();
        let known_id = self
            .created_id()
            .map(str::to_owned)
            .or_else(|| match &self.result {
                Some(Ok(Inspection::Membership { mission_id })) => mission_id.clone(),
                _ => None,
            });
        let context = self
            .target
            .as_ref()
            .map(|target| format!("Local chat {} · Project {}", target.source, target.project))
            .unwrap_or_default();
        div().id("mission-form").test_support().track_focus(&self.focus).key_context("MissionConversion")
            .size_full().v_flex().min_h_0().gap_3()
            .capture_any_mouse_down(cx.listener(|v,_,w,cx|{if v.marked(w,cx){cx.stop_propagation();}}))
            .capture_action(cx.listener(|v,_:&gpui_kit::base::input::Escape,w,cx|{v.close(w,cx);cx.stop_propagation();}))
            .capture_action(cx.listener(|v,_:&gpui_kit::base::input::Enter,w,cx|{if v.marked(w,cx){cx.stop_propagation();}}))
            .on_action(cx.listener(|v,_:&CancelMission,w,cx|{v.close(w,cx);cx.stop_propagation();}))
            .on_action(cx.listener(|v,_:&ConfirmMission,w,cx|{v.confirm(w,cx);cx.stop_propagation();}))
            .child(ui::header("mission-form-title","Make a mission",Text::Title)
                .child(ui::text(Text::Caption,SharedString::from(context)).text_color(cx.theme().muted_foreground)))
            .child(div().id("mission-form-body").test_support().v_flex().gap_3().flex_1().min_h_0().overflow_y_scroll()
                .child(FieldRow::new("mission-title-row","Title",Input::new(&self.title).aria_label("Mission title").disabled(!editable)))
                .child(FieldRow::new("mission-goal-row","Goal",Textarea::new(&self.goal).aria_label("Mission goal").readonly(!editable)).description("Optional. You can ask this chat to draft it below."))
                .child(FieldRow::new("mission-coordinator-row","Coordination",Checkbox::new("mission-coordinator").label("Use this chat as coordinator").checked(self.coordinator).disabled(!editable)
                    .on_change(cx.listener(|v,checked,w,cx|{if v.editable()&&!v.marked(w,cx){v.coordinator = *checked;cx.notify();}})))
                    .description("Give this chat the mission’s coordinator role. Chat permissions stay unchanged."))
                .child(FieldRow::new("mission-draft-row","Drafting",Checkbox::new("mission-draft").label("Ask this chat to draft the mission").checked(self.draft).disabled(!editable)
                    .on_change(cx.listener(|v,checked,w,cx|{if v.editable()&&!v.marked(w,cx){v.draft = *checked;cx.notify();}})))
                    .description("Sends a follow-up in this chat and may start a reply. Creating the mission does not confirm message delivery."))
                )
            .child(div().id("mission-status").test_support().child(notice))
            .child(ui::rule(window,cx))
            .child(div().h_flex().items_center().justify_end().gap_2()
                .child(ui::action("mission-cancel",if has_attempt||self.pending{"Close"}else{"Cancel"},Action::Secondary).on_click(cx.listener(|v,_,w,cx|v.close(w,cx))))
                .when_some(known_id,|this,id|this.child(ui::action("mission-copy-id","Copy mission ID",Action::Quiet)
                    .on_click(move|_,_,cx|cx.write_to_clipboard(gpui_kit::ClipboardItem::new_string(id.clone())))))
                .when(!self.ready||has_attempt,|this|this.child(ui::action("mission-check","Check Local",Action::Quiet).disabled(self.pending||self.state_error.is_some())
                    .on_click(cx.listener(|v,_,w,cx|{if !v.marked(w,cx){v.check(cx);}}))))
                .when(!has_attempt,|this|this.child(ui::action("mission-confirm","Make a mission ⌘↩",Action::Primary).disabled(!editable||!valid).on_click(cx.listener(|v,_,w,cx|v.confirm(w,cx))))))
            .focus_trap("mission-form",&self.focus)
    }
}

#[cfg(test)]
#[path = "mission_view_tests.rs"]
mod tests;
