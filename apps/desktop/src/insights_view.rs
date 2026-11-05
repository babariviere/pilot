//! Insights report access: a compact settings sheet, setup, revocation and the explicit
//! finding decision opened from the mission's Tasks rows. Reads are passive GETs. Every
//! write is one durable native operation saved by the writer before it is sent; an
//! unconfirmed one is only ever Checked. A decision records the user's choice. It never
//! starts implementation work.
use crate::{
    LocalOptions,
    insights::{self as model, Lifecycle, Outcome, ReadReply, Request, Status},
    ui::{self, Action, Notice, Text, Tone},
};
use gpui_kit::{
    App, Context, Entity, EventEmitter, FocusHandle, InteractiveElement, IntoElement,
    ParentElement, Render, SharedString, StatefulInteractiveElement as _, Styled, Task,
    TestSupportExt, Window,
    component::{
        ActiveTheme, Disableable, StyledExt, WindowExt,
        menu::{DropdownMenu, PopupMenuItem},
    },
    div,
    prelude::FluentBuilder,
    px,
};
use std::sync::Arc;

#[path = "insights_enable_view.rs"]
mod enable;
#[path = "insights_replace_view.rs"]
mod replace;
#[path = "insights_settings_view.rs"]
mod review;

pub(crate) enum Event {
    Close,
    /// Send this explicit user action through the durable writer.
    Write {
        request: u64,
        action: model::Action,
    },
    /// Show the linked backlog's Tasks through ordinary mission navigation.
    OpenBacklog(String),
    /// Open the created report chat.
    OpenChat(String),
    /// A finding decision was accepted; its Tasks rows may re-read.
    Decided,
    /// Show the existing global Automations switch. Nothing is switched here.
    OpenAutomationSettings,
    /// Open the weekly enable confirmation for this report chat.
    EnableWeekly(String),
    /// Open the review settings editor for this report chat.
    EditReview(String),
}

/// What the panel is about. Identity is captured when it opens and never changes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Scope {
    /// An existing report chat's settings.
    Chat { session: String },
    /// Explicit setup of a report chat for this active mission.
    Setup {
        mission: String,
        mission_title: String,
        project: String,
        path: String,
    },
    /// One explicit lifecycle decision for one finding, chosen from its task row.
    Decide {
        session: String,
        key: String,
        number: u64,
        title: String,
        from: Lifecycle,
        to: Lifecycle,
        expected_revision: u64,
    },
    /// Weekly enable over report chats' exact bindings (project, mission, report chat).
    /// One backlog among them is used as is; otherwise the user chooses.
    Enable {
        reports: Vec<(String, String, String)>,
    },
    /// Desired review settings of one report chat, and their separate Apply.
    Review { session: String },
}

#[derive(Clone, Debug, Default)]
enum Load<T> {
    #[default]
    Loading,
    Ready(T),
    Failed(SharedString),
}

pub(crate) struct Panel {
    pub(crate) scope: Scope,
    options: LocalOptions,
    pub(crate) visible: bool,
    focus: FocusHandle,
    status: Load<Status>,
    reading: Option<Task<()>>,
    /// Scoped models: setup's explicit choice, or the report chat's display name.
    catalog: Load<Arc<crate::chat_models::Catalog>>,
    catalog_path: Option<String>,
    model: Option<String>,
    catalog_read: Option<Task<()>>,
    /// Revocation awaiting its explicit confirmation.
    confirm_revoke: bool,
    book: Option<Arc<crate::delivery_store::Book>>,
    reply: Option<model::Reply>,
    request: u64,
    /// The slot of this panel's latest command.
    slot: Option<String>,
    error: Option<&'static str>,
    /// An accepted create opens its chat once.
    opened: bool,
    /// The report chat's scope, disclosed on request (setup always shows it).
    scope_open: bool,
    /// Weekly enable state; only for `Scope::Enable`.
    enable: Option<enable::Flow>,
    /// Replacement of an unavailable report chat; only for `Scope::Enable`.
    replace: Option<replace::Swap>,
    /// Review settings state; only for `Scope::Review`.
    review: Option<review::Editor>,
}
impl EventEmitter<Event> for Panel {}

/// The decisions a finding offers from its current lifecycle; Verify only after Shipped.
pub(crate) fn lifecycle_choices(current: Lifecycle) -> Vec<Lifecycle> {
    Lifecycle::ALL
        .into_iter()
        .filter(|l| *l != current && (*l != Lifecycle::Verified || current == Lifecycle::Shipped))
        .collect()
}
pub(crate) fn decision_label(l: Lifecycle) -> &'static str {
    match l {
        Lifecycle::Proposed => "Back to proposed",
        Lifecycle::Approved => "Approve",
        Lifecycle::InProgress => "Mark in progress",
        Lifecycle::Shipped => "Mark shipped",
        Lifecycle::Verified => "Verify benefit",
        Lifecycle::Deferred => "Defer",
        Lifecycle::Dismissed => "Dismiss",
    }
}

impl Panel {
    /// `model` is the report chat's model ID; `catalog_path` reads its display name.
    pub(crate) fn new(
        scope: Scope,
        options: LocalOptions,
        model: Option<String>,
        catalog_path: Option<String>,
        cx: &mut Context<Self>,
    ) -> Self {
        let catalog_path = match &scope {
            Scope::Setup { path, .. } => Some(path.clone()),
            Scope::Chat { .. } => catalog_path,
            Scope::Decide { .. } | Scope::Enable { .. } | Scope::Review { .. } => None,
        };
        let enable = match &scope {
            Scope::Enable { reports } => Some(enable::Flow::new(reports.clone())),
            _ => None,
        };
        let replace = enable.as_ref().map(|_| replace::Swap::default());
        let review = match &scope {
            Scope::Review { session } => Some(review::Editor::new(session.clone())),
            _ => None,
        };
        let mut panel = Self {
            scope,
            options,
            visible: true,
            focus: cx.focus_handle(),
            status: Load::Loading,
            reading: None,
            catalog: Load::Loading,
            catalog_path,
            model,
            catalog_read: None,
            confirm_revoke: false,
            book: None,
            reply: None,
            request: 0,
            slot: None,
            error: None,
            opened: false,
            scope_open: false,
            enable,
            replace,
            review,
        };
        panel.refresh(cx);
        panel
    }
    pub(crate) fn matches(&self, scope: &Scope, options: &LocalOptions) -> bool {
        self.scope == *scope
            && self.options.host() == options.host()
            && self.options.loopback() == options.loopback()
    }
    pub(crate) fn owns_focus(&self, w: &Window, cx: &App) -> bool {
        self.focus.contains_focused(w, cx)
    }
    pub(crate) fn focus(&self, w: &mut Window, cx: &mut App) {
        self.focus.focus(w, cx);
    }
    fn title(&self) -> SharedString {
        match &self.scope {
            Scope::Chat { .. } => "Insights".into(),
            Scope::Setup { .. } => "Set up Insights".into(),
            Scope::Decide { number, to, .. } => {
                format!("{} #{number}?", decision_label(*to)).into()
            }
            Scope::Enable { .. } => "Weekly Insights".into(),
            Scope::Review { .. } => "Review settings".into(),
        }
    }
    /// Show the panel as a dialog; Close and Escape go through the owner.
    pub(crate) fn open(panel: Entity<Self>, w: &mut Window, cx: &mut App) {
        let title = panel.read(cx).title();
        let width = match panel.read(cx).scope {
            Scope::Decide { .. } => 400.,
            Scope::Review { .. } => 480.,
            _ => 440.,
        };
        w.open_dialog(cx, {
            let panel = panel.clone();
            move |d, _, cx| {
                ui::dialog(d, cx)
                    .title(title.clone())
                    .w(px(width))
                    .overlay_closable(false)
                    .close_button(false)
                    .keyboard(false)
                    .on_cancel(|_, _, _| false)
                    .child(panel.clone())
            }
        });
        panel.update(cx, |p, cx| p.focus(w, cx));
    }

    /// Re-read passive state. Never sends a write.
    pub(crate) fn refresh(&mut self, cx: &mut Context<Self>) {
        if matches!(self.scope, Scope::Enable { .. }) {
            self.enable_refresh(cx);
            return;
        }
        if matches!(self.scope, Scope::Review { .. }) {
            self.review_refresh(cx);
            return;
        }
        if let Scope::Chat { session } = self.scope.clone() {
            self.status = Load::Loading;
            let Some(rx) = model::read(self.options.clone(), model::Read::Status { session })
            else {
                self.status = Load::Failed("Couldn't read Insights.".into());
                return;
            };
            self.reading = Some(cx.spawn(async move |view, cx| {
                let reply = rx.recv().await;
                let _ = view.update(cx, |v, cx| {
                    v.status = match reply {
                        Ok(ReadReply::Status(Ok(status))) => Load::Ready(status),
                        Ok(ReadReply::Status(Err(e))) => Load::Failed(e.into()),
                        Ok(ReadReply::NotInsights) => {
                            Load::Failed("Not an Insights report chat.".into())
                        }
                        Ok(ReadReply::Unsupported) => {
                            Load::Failed("Update Pilot to use Insights.".into())
                        }
                        _ => Load::Failed("Couldn't read Insights. Try again.".into()),
                    };
                    cx.notify();
                });
            }));
        }
        self.read_catalog(cx);
    }
    fn read_catalog(&mut self, cx: &mut Context<Self>) {
        let Some(path) = self.catalog_path.clone() else {
            return;
        };
        if matches!(self.catalog, Load::Ready(_)) && !matches!(self.scope, Scope::Setup { .. }) {
            return;
        }
        self.catalog = Load::Loading;
        let options = self.options.clone();
        let (tx, rx) = async_channel::bounded(1);
        let spawned = std::thread::Builder::new()
            .name("local-insights-models".into())
            .spawn(move || {
                let reply = match (
                    tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build(),
                    crate::chat_settings::client(),
                ) {
                    (Ok(runtime), Ok(client)) => {
                        runtime.block_on(crate::chat_models::catalog(&client, &options, &path))
                    }
                    _ => Err("Couldn't load models."),
                };
                let _ = tx.send_blocking(reply);
            })
            .is_ok();
        if !spawned {
            self.catalog = Load::Failed("Couldn't load models.".into());
            return;
        }
        self.catalog_read = Some(cx.spawn(async move |view, cx| {
            let reply = rx.recv().await;
            let _ = view.update(cx, |v, cx| {
                v.catalog = match reply {
                    Ok(Ok(catalog)) => {
                        // Setup preselects the default; a report chat keeps its own model.
                        if matches!(v.scope, Scope::Setup { .. })
                            && v.model
                                .as_ref()
                                .is_none_or(|m| !catalog.models.iter().any(|c| &c.id == m))
                        {
                            v.model = catalog
                                .default_model
                                .clone()
                                .filter(|d| catalog.models.iter().any(|c| &c.id == d));
                        }
                        Load::Ready(Arc::new(catalog))
                    }
                    Ok(Err(e)) => Load::Failed(e.into()),
                    Err(_) => Load::Failed("Couldn't load models.".into()),
                };
                cx.notify();
            });
        }));
    }

    /// Adopt the writer's retained attempts and latest reply.
    pub(crate) fn accept(
        &mut self,
        book: Option<&Arc<crate::delivery_store::Book>>,
        reply: Option<&model::Reply>,
        cx: &mut Context<Self>,
    ) {
        let book_changed = match (&self.book, book) {
            (Some(old), Some(new)) => old.insights != new.insights,
            (None, None) => false,
            _ => true,
        };
        let reply_changed = self.reply.as_ref() != reply;
        if !book_changed && !reply_changed {
            return;
        }
        self.book = book.cloned();
        self.reply = reply.cloned();
        if let Some(Outcome::Accepted(result)) = self.latest().cloned() {
            self.settled(&result, cx);
        }
        if matches!(self.latest(), Some(Outcome::Rejected(_))) {
            self.review_refused(cx);
        }
        if matches!(self.scope, Scope::Enable { .. }) {
            self.enable_sync(cx);
            self.replace_sync(cx);
        }
        cx.notify();
    }
    /// The writer's reply to this panel's latest command.
    fn latest(&self) -> Option<&Outcome> {
        let slot = self.slot.as_ref()?;
        self.reply
            .as_ref()
            .filter(|r| &r.slot == slot && r.request == self.request && self.request > 0)
            .and_then(|r| r.outcome.as_ref())
    }
    fn waiting(&self) -> bool {
        let Some(slot) = &self.slot else {
            return false;
        };
        self.reply
            .as_ref()
            .is_some_and(|r| &r.slot == slot && r.request == self.request && r.outcome.is_none())
    }
    #[cfg(feature = "native-probes")]
    pub(crate) fn probe_waiting(&self) -> bool {
        self.waiting()
    }
    /// How many commands this panel has handed to the writer, and the latest one's outcome.
    #[cfg(feature = "native-probes")]
    pub(crate) fn probe_requests(&self) -> (u64, Option<Outcome>) {
        (self.request, self.latest().cloned())
    }
    fn attempt(&self, slot: &str) -> Option<&model::Attempt> {
        self.book.as_ref()?.insights.get(slot)
    }
    /// An accepted write: re-read, open a created chat once, or report a decision.
    fn settled(&mut self, result: &serde_json::Value, cx: &mut Context<Self>) {
        match &self.scope {
            Scope::Setup { .. } => {
                if let Some(id) = result["sessionId"].as_str()
                    && !self.opened
                {
                    self.opened = true;
                    cx.emit(Event::OpenChat(id.to_owned()));
                }
            }
            Scope::Chat { .. } => {
                self.confirm_revoke = false;
                self.refresh(cx);
            }
            Scope::Decide { .. } => {
                if !self.opened {
                    self.opened = true;
                    cx.emit(Event::Decided);
                }
            }
            // Success is the passive status of both resources, read on the book change.
            Scope::Enable { .. } => {}
            Scope::Review { .. } => self.review_settled(result, cx),
        }
    }
    fn send(&mut self, action: model::Action, cx: &mut Context<Self>) {
        if !self.visible || self.waiting() {
            return;
        }
        // A late preflight never replaces the confirmation that was just sent.
        if let (model::Action::Start(_), Some(flow)) = (&action, self.enable.as_mut()) {
            flow.freeze();
        }
        // A confirmation is consumed by its one explicit send, whatever the outcome.
        if let model::Action::Start(_) = &action {
            self.confirm_revoke = false;
        }
        let slot = match &action {
            model::Action::Start(request) => request.slot(),
            model::Action::Check { slot } => slot.clone(),
        };
        if let model::Action::Start(_) = &action
            && self.attempt(&slot).is_some_and(|a| a.open())
        {
            self.error = Some("Still unconfirmed. Check it first.");
            cx.notify();
            return;
        }
        self.request += 1;
        self.slot = Some(slot);
        self.error = None;
        cx.emit(Event::Write {
            request: self.request,
            action,
        });
        cx.notify();
    }
    /// The owner could not hand the command to the writer.
    pub(crate) fn not_sent(&mut self, cx: &mut Context<Self>) {
        self.slot = None;
        self.error = Some("Busy. Nothing was sent.");
        cx.notify();
    }

    fn setup_request(&self) -> Option<Request> {
        let Scope::Setup {
            mission, project, ..
        } = &self.scope
        else {
            return None;
        };
        let Load::Ready(catalog) = &self.catalog else {
            return None;
        };
        let model = self
            .model
            .as_ref()
            .and_then(|id| catalog.models.iter().find(|m| &m.id == id))?;
        Some(Request::Create {
            project_id: project.clone(),
            mission_id: mission.clone(),
            model: model.id.clone(),
            thinking: model.thinking.clone(),
        })
    }
    fn decide_request(&self) -> Option<Request> {
        let Scope::Decide {
            session,
            key,
            to,
            expected_revision,
            ..
        } = &self.scope
        else {
            return None;
        };
        Some(Request::Lifecycle {
            session_id: session.clone(),
            key: key.clone(),
            expected_revision: *expected_revision,
            lifecycle: *to,
        })
    }
    /// The chosen or the chat's model by display name, else its ID.
    fn model_name(&self) -> Option<String> {
        let id = self.model.as_ref()?;
        Some(match &self.catalog {
            Load::Ready(c) => c
                .models
                .iter()
                .find(|m| &m.id == id)
                .map_or_else(|| id.clone(), |m| m.name.clone()),
            _ => id.clone(),
        })
    }
    /// This panel's own operation slot.
    fn slot_for_scope(&self) -> Option<String> {
        match &self.scope {
            Scope::Chat { session } => Some(format!("revoke:{session}")),
            Scope::Setup { mission, .. } => Some(format!("create:{mission}")),
            Scope::Decide { session, key, .. } => Some(format!("lifecycle:{session}:{key}")),
            Scope::Enable { .. } => match self.shown() {
                enable::Shown::Enable(a) | enable::Shown::Replace(a) => Some(a.slot.clone()),
                enable::Shown::Step => None,
                enable::Shown::Confirm(_) => self.enable_attempt().map(|a| a.slot.clone()),
            },
            // An open Apply first: it fences Save as well.
            Scope::Review { session } => {
                let apply = crate::insights_settings::apply_slot(session);
                if self.attempt(&apply).is_some_and(|a| a.open()) {
                    Some(apply)
                } else {
                    Some(crate::insights_settings::settings_slot(session))
                }
            }
        }
    }
}

/// Plain statement of scope: always before setup, on request for a report chat.
fn disclosure(model: &str) -> impl IntoElement {
    let line = |id: &'static str, text: String| {
        div()
            .id(id)
            .test_support()
            .child(ui::text(Text::Caption, SharedString::from(text)))
    };
    div()
        .id("insights-scope")
        .test_support()
        .v_flex()
        .min_w_0()
        .gap_1()
        .child(line(
            "insights-scope-read",
            "Sanitized chat excerpts from all projects, incl. archived. Read-only.".into(),
        ))
        .child(line(
            "insights-scope-model",
            format!("Sent to {model}. Redaction isn't a guarantee."),
        ))
        .child(line(
            "insights-scope-write",
            "Writes only its reports and findings.".into(),
        ))
}

/// A short, final outcome. Unknown and Pending stay on the Check row instead.
fn outcome_notice(outcome: &Outcome, refused: &str) -> Option<Notice> {
    match outcome {
        Outcome::Rejected(reason) => {
            Some(Notice::new(format!("{refused}: {reason}")).tone(Tone::Error))
        }
        Outcome::Refused(e) => Some(Notice::new(*e).tone(Tone::Error)),
        Outcome::Accepted(_) | Outcome::Pending | Outcome::Unknown(_) => None,
    }
}

/// A pinned confirmation names the finding without letting a long title fill the panel.
fn brief(title: &str) -> String {
    shorten(title, 140)
}
fn shorten(title: &str, max: usize) -> String {
    if title.chars().count() <= max {
        return title.to_owned();
    }
    let mut short: String = title.chars().take(max - 1).collect();
    short.truncate(short.trim_end().len());
    short.push('…');
    short
}

fn field(
    id: &'static str,
    label: &'static str,
    value: impl IntoElement,
    cx: &App,
) -> impl IntoElement {
    div()
        .id(id)
        .test_support()
        .h_flex()
        .items_start()
        .gap_3()
        .min_w_0()
        .child(
            div()
                .w(px(56.))
                .flex_none()
                .child(ui::text(Text::Body, label).text_color(cx.theme().muted_foreground)),
        )
        .child(div().flex_1().min_w_0().child(value))
}

impl Panel {
    /// The saved attempt for this panel, when it still needs an explicit Check: one line.
    fn check_row(&self, cx: &mut Context<Self>) -> Option<gpui_kit::AnyElement> {
        let slot = self.slot_for_scope()?;
        let attempt = self.attempt(&slot)?;
        if !attempt.open() || self.waiting() {
            return None;
        }
        let label = if attempt.state == model::State::Pending {
            "Still applying."
        } else {
            "Not confirmed. Never resent."
        };
        Some(
            div()
                .id("insights-unconfirmed")
                .test_support()
                .h_flex()
                .items_center()
                .gap_2()
                .px_2()
                .py_1()
                .rounded(px(crate::appearance::Radius::CONTROL))
                .bg(cx.theme().warning.opacity(0.12))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .child(ui::text(Text::Caption, label).text_color(Tone::Warning.color(cx))),
                )
                .child(
                    ui::action("insights-check", "Check", Action::Quiet).on_click(cx.listener(
                        move |v, _, _, cx| v.send(model::Action::Check { slot: slot.clone() }, cx),
                    )),
                )
                .into_any_element(),
        )
    }
    /// Progress, the final outcome and local errors, in that order.
    fn notices(&self, tail: gpui_kit::Div, busy: &'static str) -> gpui_kit::Div {
        let mut tail = tail;
        if self.waiting() {
            tail = tail.child(
                div()
                    .id("insights-waiting")
                    .test_support()
                    .child(ui::text(Text::Caption, busy)),
            );
        } else if let Some(n) = self.latest().and_then(|o| {
            // A refused Save stored nothing; other refusals applied nothing.
            let saving = self
                .slot
                .as_deref()
                .is_some_and(|s| s.starts_with("settings:"));
            // A refused replacement names its host reason in words.
            let replacing = self
                .slot
                .as_deref()
                .is_some_and(|s| s.starts_with("replace:"));
            let o = match o {
                Outcome::Rejected(r) if replacing => {
                    Outcome::Rejected(crate::insights_replace::refusal_words(r))
                }
                o => o.clone(),
            };
            outcome_notice(&o, if saving { "Not saved" } else { "Not applied" })
        }) {
            tail = tail.child(div().id("insights-outcome").test_support().child(n));
        }
        if let Some(e) = self.error {
            tail = tail.child(
                div()
                    .id("insights-error")
                    .test_support()
                    .child(Notice::new(e).tone(Tone::Error)),
            );
        }
        tail
    }
    fn close_button(
        &self,
        label: &'static str,
        role: Action,
        cx: &mut Context<Self>,
    ) -> gpui_kit::component::button::Button {
        ui::action("insights-close", label, role).on_click(cx.listener(|v, _, _, cx| {
            if v.visible {
                cx.emit(Event::Close);
            }
        }))
    }

    fn render_setup(&mut self, cx: &mut Context<Self>) -> (gpui_kit::Div, gpui_kit::Div) {
        let Scope::Setup { mission_title, .. } = self.scope.clone() else {
            return (div(), div());
        };
        let model_name = self
            .model_name()
            .unwrap_or_else(|| "the selected model".into());
        let picker = match &self.catalog {
            Load::Loading => ui::text(Text::Caption, "Loading models…").into_any_element(),
            Load::Failed(e) => Notice::new(e.clone()).tone(Tone::Error).into_any_element(),
            Load::Ready(catalog) => {
                let weak = cx.weak_entity();
                let catalog = catalog.clone();
                ui::action(
                    "insights-model",
                    SharedString::from(shorten(&model_name, 40)),
                    Action::Secondary,
                )
                .accessibility_label(SharedString::from(format!("Model: {model_name}")))
                .tooltip(SharedString::from(model_name.clone()))
                .dropdown_caret(true)
                .disabled(self.waiting())
                .dropdown_menu(move |mut menu, _, _| {
                    for m in catalog.models.iter() {
                        let (weak, id) = (weak.clone(), m.id.clone());
                        menu = menu.item(
                            PopupMenuItem::new(SharedString::from(m.name.clone())).on_click(
                                move |_, _, cx| {
                                    let _ = weak.update(cx, |v, cx| {
                                        if !v.waiting() {
                                            v.model = Some(id.clone());
                                            cx.notify();
                                        }
                                    });
                                },
                            ),
                        );
                    }
                    menu
                })
                .into_any_element()
            }
        };
        let body = div()
            .v_flex()
            .gap_3()
            .min_w_0()
            .child(
                ui::text(
                    Text::Body,
                    SharedString::from(format!("Report chat for “{mission_title}”.")),
                )
                .text_color(cx.theme().muted_foreground),
            )
            .child(field(
                "insights-field-model",
                "Model",
                div().h_flex().child(picker),
                cx,
            ))
            .child(field(
                "insights-field-reads",
                "Reads",
                disclosure(&model_name),
                cx,
            ));
        let slot = self.slot_for_scope().unwrap_or_default();
        let done = self
            .attempt(&slot)
            .is_some_and(|a| a.state == model::State::Accepted);
        let request = self.setup_request();
        let mut tail = div().v_flex().gap_3().w_full().min_w_0();
        tail = tail.children(self.check_row(cx));
        tail = self.notices(tail, "Setting up… Closing doesn't cancel it.");
        let actions = div()
            .h_flex()
            .justify_end()
            .gap_2()
            .child(self.close_button(if done { "Close" } else { "Cancel" }, Action::Quiet, cx))
            .when(!done, |d| {
                d.child(
                    ui::action("insights-setup", "Set up", Action::Primary)
                        .disabled(
                            request.is_none()
                                || self.waiting()
                                || self.attempt(&slot).is_some_and(|a| a.open()),
                        )
                        .on_click(cx.listener(move |v, _, _, cx| {
                            if let Some(r) = v.setup_request() {
                                v.send(model::Action::Start(r), cx);
                            }
                        })),
                )
            });
        (body, tail.child(actions))
    }

    fn render_decide(&mut self, cx: &mut Context<Self>) -> (gpui_kit::Div, gpui_kit::Div) {
        let Scope::Decide { title, to, .. } = self.scope.clone() else {
            return (div(), div());
        };
        let body = div()
            .v_flex()
            .gap_2()
            .min_w_0()
            .child(
                div().id("insights-decide-title").test_support().child(
                    ui::text(Text::Body, SharedString::from(brief(&title)))
                        .text_color(cx.theme().muted_foreground),
                ),
            )
            .child(
                ui::text(Text::Caption, "Records your choice. No work starts.")
                    .text_color(cx.theme().muted_foreground),
            );
        let slot = self.slot_for_scope().unwrap_or_default();
        let open = self.attempt(&slot).is_some_and(|a| a.open());
        let mut tail = div().v_flex().gap_3().w_full().min_w_0();
        tail = tail.children(self.check_row(cx));
        tail = self.notices(tail, "Saving… Closing doesn't cancel it.");
        let actions = div()
            .h_flex()
            .justify_end()
            .gap_2()
            .child(self.close_button(if open { "Close" } else { "Cancel" }, Action::Quiet, cx))
            .when(!open, |d| {
                d.child(
                    ui::action(
                        "insights-decision-confirm",
                        decision_label(to),
                        Action::Primary,
                    )
                    .disabled(self.waiting())
                    .on_click(cx.listener(|v, _, _, cx| {
                        if let Some(r) = v.decide_request() {
                            v.send(model::Action::Start(r), cx);
                        }
                    })),
                )
            });
        (body, tail.child(actions))
    }

    fn render_chat(&mut self, cx: &mut Context<Self>) -> (gpui_kit::Div, gpui_kit::Div) {
        let Scope::Chat { session } = self.scope.clone() else {
            return (div(), div());
        };
        let model_name = self
            .model_name()
            .unwrap_or_else(|| "this chat's model".into());
        let body = div().v_flex().gap_3().min_w_0();
        let status = match &self.status {
            Load::Loading => {
                return (
                    body.child(ui::text(Text::Caption, "Reading…")),
                    self.footer(None, cx),
                );
            }
            Load::Failed(e) => {
                return (
                    body.child(Notice::new(e.clone()).tone(Tone::Error)),
                    self.footer(None, cx),
                );
            }
            Load::Ready(s) => s.clone(),
        };
        let (state, color) = if status.setup_pending {
            ("Setup unfinished", cx.theme().warning)
        } else if !status.enabled {
            ("Revoked", cx.theme().muted_foreground)
        } else if status.archived {
            ("Archived", cx.theme().muted_foreground)
        } else if !status.available {
            ("Unavailable", cx.theme().warning)
        } else {
            ("On", cx.theme().success)
        };
        let state_value = div()
            .id("insights-state")
            .test_support()
            .h_flex()
            .items_center()
            .gap_2()
            .child(div().size(px(7.)).rounded_full().bg(color))
            .child(ui::text(Text::Body, state));
        let reads = div()
            .id("insights-scope-toggle")
            .test_support()
            .h_flex()
            .items_center()
            .gap_1()
            .cursor_pointer()
            .child(ui::text(Text::Body, "Chat excerpts, all projects"))
            .child(ui::disclosure_chevron("insights-scope", self.scope_open))
            .on_click(cx.listener(|v, _, _, cx| {
                v.scope_open = !v.scope_open;
                cx.notify();
            }));
        let body = body
            .child(field("insights-field-status", "Status", state_value, cx))
            .child(field(
                "insights-field-model",
                "Model",
                ui::text(Text::Body, SharedString::from(model_name.clone())),
                cx,
            ))
            .child(field(
                "insights-field-reads",
                "Reads",
                div()
                    .v_flex()
                    .gap_1()
                    .min_w_0()
                    .child(reads)
                    .when(self.scope_open, |d| d.child(disclosure(&model_name))),
                cx,
            ));
        let weekly = self.weekly_field(&session, cx);
        let body = body.child(field("insights-field-weekly", "Weekly", weekly, cx));
        // Desired review settings: their own editor, Save and a separate Apply.
        let body = body.when(status.enabled && !status.setup_pending, |b| {
            let session = session.clone();
            b.child(field(
                "insights-field-review",
                "Review",
                div().h_flex().child(
                    ui::action("insights-review-edit", "Settings…", Action::Quiet)
                        .accessibility_label("Review settings")
                        .on_click(cx.listener(move |v, _, _, cx| {
                            if v.visible && !v.waiting() {
                                cx.emit(Event::EditReview(session.clone()));
                            }
                        })),
                ),
                cx,
            ))
        });
        let mut tail = div().v_flex().gap_3().w_full().min_w_0();
        tail = tail.children(self.check_row(cx));
        if self.confirm_revoke {
            let revision = status.revision;
            tail = tail.child(
                div()
                    .id("insights-confirm-revoke")
                    .test_support()
                    .h_flex()
                    .items_center()
                    .gap_2()
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .child(ui::text(Text::Body, "Revoke access? Reports stay.")),
                    )
                    .child(
                        ui::action("insights-revoke-cancel", "Cancel", Action::Quiet).on_click(
                            cx.listener(|v, _, _, cx| {
                                v.confirm_revoke = false;
                                cx.notify();
                            }),
                        ),
                    )
                    .child(
                        ui::action("insights-revoke-confirm", "Revoke", Action::Danger)
                            .disabled(self.waiting())
                            .on_click(cx.listener(move |v, _, _, cx| {
                                v.send(
                                    model::Action::Start(Request::Revoke {
                                        session_id: session.clone(),
                                        expected_revision: revision,
                                    }),
                                    cx,
                                );
                            })),
                    ),
            );
        }
        tail = self.notices(tail, "Saving… Closing doesn't cancel it.");
        (body, tail.child(self.footer(Some(status), cx)))
    }

    fn footer(&self, status: Option<Status>, cx: &mut Context<Self>) -> gpui_kit::Div {
        let revocable = status
            .as_ref()
            .is_some_and(|s| s.enabled && !s.setup_pending);
        let mission = status.as_ref().map(|s| s.mission_id.clone());
        div()
            .h_flex()
            .items_center()
            .gap_2()
            .child(div().flex_1().h_flex().when(revocable, |d| {
                d.child(
                    ui::action("insights-revoke", "Revoke…", Action::Quiet)
                        .text_color(cx.theme().danger)
                        .disabled(self.waiting() || self.confirm_revoke)
                        .on_click(cx.listener(|v, _, _, cx| {
                            v.confirm_revoke = true;
                            v.error = None;
                            cx.notify();
                        })),
                )
            }))
            .when_some(mission, |d, mission| {
                d.child(
                    ui::action("insights-backlog", "Open backlog", Action::Secondary).on_click(
                        cx.listener(move |v, _, _, cx| {
                            if v.visible {
                                cx.emit(Event::OpenBacklog(mission.clone()));
                            }
                        }),
                    ),
                )
            })
            .child(self.close_button("Done", Action::Primary, cx))
    }
}

impl Render for Panel {
    fn render(&mut self, w: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.review_seed(w, cx);
        self.render_panel(w, cx)
    }
}

/// Hidden probes drive the same state a click would; never compiled into production.
#[cfg(feature = "native-probes")]
impl Panel {
    pub(crate) fn probe_ready(&self) -> bool {
        let catalog = self.catalog_path.is_none() || !matches!(self.catalog, Load::Loading);
        match &self.scope {
            Scope::Chat { .. } => !matches!(self.status, Load::Loading) && catalog,
            Scope::Setup { .. } => catalog,
            Scope::Decide { .. } => true,
            Scope::Enable { .. } => self.enable_probe_ready(),
            Scope::Review { .. } => self.review_probe_ready(),
        }
    }
    pub(crate) fn probe_revoke(&mut self, cx: &mut Context<Self>) {
        self.confirm_revoke = true;
        cx.notify();
    }
    pub(crate) fn probe_scope(&mut self, cx: &mut Context<Self>) {
        self.scope_open = true;
        cx.notify();
    }
    pub(crate) fn probe_model_name(&self) -> Option<String> {
        self.model_name()
    }
}

impl Panel {
    fn render_panel(&mut self, w: &Window, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        let (body, tail) = match &self.scope {
            Scope::Chat { .. } => self.render_chat(cx),
            Scope::Setup { .. } => self.render_setup(cx),
            Scope::Decide { .. } => self.render_decide(cx),
            Scope::Enable { .. } => self.render_enable(cx),
            Scope::Review { .. } => self.render_review(cx),
        };
        // Only the content scrolls; confirmations, outcomes and actions stay in view.
        let height = (f32::from(w.viewport_size().height) * 0.45).clamp(160., 480.);
        div()
            .id("insights-panel")
            .test_support()
            .v_flex()
            .gap_4()
            .w_full()
            .min_w_0()
            .track_focus(&self.focus)
            // Input bindings run before key-down listeners: an open composition keeps Escape.
            .capture_action(cx.listener(|v, _: &gpui_kit::base::input::Escape, w, cx| {
                if v.review_marked(w, cx) {
                    cx.stop_propagation();
                }
            }))
            .on_key_down(cx.listener(|v, e: &gpui_kit::KeyDownEvent, w, cx| {
                if e.keystroke.key == "escape" && v.visible {
                    // An IME composition owns Escape; the panel stays.
                    if v.review_marked(w, cx) {
                        return;
                    }
                    cx.stop_propagation();
                    if std::mem::take(&mut v.confirm_revoke) {
                        cx.notify();
                    } else if v.replace_back(cx) {
                        // The replacement step closes first; nothing was sent.
                    } else {
                        cx.emit(Event::Close);
                    }
                }
            }))
            .child(
                div()
                    .id("insights-body")
                    .test_support()
                    .v_flex()
                    .w_full()
                    .min_w_0()
                    .max_h(px(height))
                    .overflow_y_scroll()
                    .child(body),
            )
            .child(tail)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn verify_is_offered_only_after_shipped() {
        assert!(!lifecycle_choices(Lifecycle::Approved).contains(&Lifecycle::Verified));
        assert!(lifecycle_choices(Lifecycle::Shipped).contains(&Lifecycle::Verified));
        assert!(!lifecycle_choices(Lifecycle::Shipped).contains(&Lifecycle::Shipped));
    }
    #[test]
    fn confirmation_titles_are_bounded_on_characters() {
        assert_eq!(brief("Short 日本語"), "Short 日本語");
        let long = "語 ".repeat(200);
        let short = brief(&long);
        assert_eq!(short.chars().count(), 140);
        assert!(short.ends_with('…'));
        assert_eq!(brief(&"x".repeat(140)), "x".repeat(140));
    }
    #[test]
    fn unknown_and_pending_have_no_second_notice() {
        assert!(outcome_notice(&Outcome::Pending, "Not applied").is_none());
        assert!(outcome_notice(&Outcome::Unknown("x"), "Not applied").is_none());
        assert!(outcome_notice(&Outcome::Rejected("stale".into()), "Not saved").is_some());
    }
}
