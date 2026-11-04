//! Insights report access: scope disclosure, setup, revocation and explicit finding
//! decisions. Reads are passive GETs. Every write is one durable native operation
//! saved by the writer before it is sent; an unconfirmed one is only ever Checked.
//! A decision records the user's choice. It never starts implementation work.
use crate::{
    LocalOptions,
    insights::{self as model, Finding, Lifecycle, Outcome, ReadReply, Request, Status},
    ui::{self, Action, Notice, Text, Tone},
};
use gpui_kit::{
    App, Context, Entity, EventEmitter, FocusHandle, InteractiveElement, IntoElement,
    ParentElement, Render, SharedString, StatefulInteractiveElement as _, Styled, Task,
    TestSupportExt, Window,
    component::{
        Disableable, StyledExt, WindowExt,
        menu::{DropdownMenu, PopupMenuItem},
    },
    div,
    prelude::FluentBuilder,
    px,
};
use std::sync::Arc;

pub(crate) enum Event {
    Close,
    /// Send this explicit user action through the durable writer.
    Write {
        request: u64,
        action: model::Action,
    },
    /// Show the linked backlog mission through ordinary mission navigation.
    OpenBacklog(String),
    /// Open the created report chat.
    OpenChat(String),
}

/// What the panel is about. Identity is captured when it opens and never changes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Scope {
    /// An existing report chat.
    Chat { session: String },
    /// Explicit setup of a report chat for this active mission.
    Setup {
        mission: String,
        mission_title: String,
        project: String,
        path: String,
    },
}

#[derive(Clone, Debug, Default)]
enum Load<T> {
    #[default]
    Loading,
    Ready(T),
    Failed(SharedString),
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Confirm {
    Revoke,
    Decide {
        key: String,
        title: String,
        from: Lifecycle,
        to: Lifecycle,
        expected_revision: u64,
    },
}

pub(crate) struct Panel {
    pub(crate) scope: Scope,
    options: LocalOptions,
    pub(crate) visible: bool,
    /// Display name of the chat's model, when known.
    model_label: Option<String>,
    focus: FocusHandle,
    status: Load<Status>,
    findings: Load<Vec<Finding>>,
    next_cursor: Option<u64>,
    reading: Option<Task<()>>,
    finding_reads: Option<Task<()>>,
    /// Setup only: the project's scoped models and the explicit choice.
    catalog: Load<Arc<crate::chat_models::Catalog>>,
    model: Option<String>,
    catalog_read: Option<Task<()>>,
    confirm: Option<Confirm>,
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
}
impl EventEmitter<Event> for Panel {}

fn lifecycle_choices(current: Lifecycle) -> Vec<Lifecycle> {
    Lifecycle::ALL
        .into_iter()
        .filter(|l| *l != current && (*l != Lifecycle::Verified || current == Lifecycle::Shipped))
        .collect()
}
fn decision_label(l: Lifecycle) -> &'static str {
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
    pub(crate) fn new(
        scope: Scope,
        options: LocalOptions,
        model_label: Option<String>,
        cx: &mut Context<Self>,
    ) -> Self {
        let mut panel = Self {
            scope,
            options,
            visible: true,
            model_label,
            focus: cx.focus_handle(),
            status: Load::Loading,
            findings: Load::Loading,
            next_cursor: None,
            reading: None,
            finding_reads: None,
            catalog: Load::Loading,
            model: None,
            catalog_read: None,
            confirm: None,
            book: None,
            reply: None,
            request: 0,
            slot: None,
            error: None,
            opened: false,
            scope_open: false,
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
    /// Show the panel as a dialog; Close and Escape go through the owner.
    pub(crate) fn open(panel: Entity<Self>, w: &mut Window, cx: &mut App) {
        let title: SharedString = match &panel.read(cx).scope {
            Scope::Chat { .. } => "Insights access".into(),
            Scope::Setup { .. } => "Set up Insights chat".into(),
        };
        w.open_dialog(cx, {
            let panel = panel.clone();
            move |d, _, cx| {
                ui::dialog(d, cx)
                    .title(title.clone())
                    .w(px(560.))
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
        match self.scope.clone() {
            Scope::Chat { session } => {
                self.status = Load::Loading;
                let Some(rx) = model::read(
                    self.options.clone(),
                    model::Read::Status {
                        session: session.clone(),
                    },
                ) else {
                    self.status = Load::Failed("Couldn't start reading Insights access.".into());
                    return;
                };
                self.reading = Some(cx.spawn(async move |view, cx| {
                    let reply = rx.recv().await;
                    let _ = view.update(cx, |v, cx| {
                        v.status = match reply {
                            Ok(ReadReply::Status(Ok(status))) => Load::Ready(status),
                            Ok(ReadReply::Status(Err(e))) => Load::Failed(e.into()),
                            Ok(ReadReply::NotInsights) => {
                                Load::Failed("This chat isn't an Insights report chat.".into())
                            }
                            Ok(ReadReply::Unsupported) => Load::Failed(
                                "This Local doesn't support Insights yet. Update Pilot.".into(),
                            ),
                            _ => Load::Failed("Couldn't read Insights access. Try again.".into()),
                        };
                        if matches!(&v.status, Load::Ready(s) if s.enabled && s.available) {
                            v.read_findings(None, cx);
                        } else {
                            v.findings = Load::Ready(Vec::new());
                            v.next_cursor = None;
                        }
                        cx.notify();
                    });
                }));
            }
            Scope::Setup { path, .. } => {
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
                            (Ok(runtime), Ok(client)) => runtime
                                .block_on(crate::chat_models::catalog(&client, &options, &path)),
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
                                if v.model
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
        }
    }
    fn read_findings(&mut self, cursor: Option<u64>, cx: &mut Context<Self>) {
        let Scope::Chat { session } = &self.scope else {
            return;
        };
        if cursor.is_none() {
            self.findings = Load::Loading;
        }
        let Some(rx) = model::read(
            self.options.clone(),
            model::Read::Findings {
                session: session.clone(),
                cursor,
            },
        ) else {
            self.findings = Load::Failed("Couldn't start reading findings.".into());
            return;
        };
        self.finding_reads = Some(cx.spawn(async move |view, cx| {
            let reply = rx.recv().await;
            let _ = view.update(cx, |v, cx| {
                match reply {
                    Ok(ReadReply::Findings(Ok(page))) => {
                        let mut items = match (&v.findings, cursor) {
                            (Load::Ready(old), Some(_)) => old.clone(),
                            _ => Vec::new(),
                        };
                        for f in page.items {
                            if !items.iter().any(|o| o.key == f.key) {
                                items.push(f);
                            }
                        }
                        v.findings = Load::Ready(items);
                        v.next_cursor = page.next_cursor;
                    }
                    Ok(ReadReply::Findings(Err(e))) => v.findings = Load::Failed(e.into()),
                    Ok(ReadReply::Unavailable) => v.findings = Load::Failed(
                        "Findings can't be read while access is off. They remain mission tasks."
                            .into(),
                    ),
                    _ => v.findings = Load::Failed("Couldn't read findings. Try again.".into()),
                }
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
    fn attempt(&self, slot: &str) -> Option<&model::Attempt> {
        self.book.as_ref()?.insights.get(slot)
    }
    /// An accepted write: re-read, and open a created chat once.
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
                self.confirm = None;
                self.refresh(cx);
            }
        }
    }
    fn send(&mut self, action: model::Action, cx: &mut Context<Self>) {
        if !self.visible || self.waiting() {
            return;
        }
        let slot = match &action {
            model::Action::Start(request) => request.slot(),
            model::Action::Check { slot } => slot.clone(),
        };
        if let model::Action::Start(_) = &action
            && self.attempt(&slot).is_some_and(|a| a.open())
        {
            self.error =
                Some("An earlier action is still unconfirmed. Check it; nothing new was sent.");
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
        self.error = Some("Local writer is busy. Nothing was sent.");
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
    fn chosen_model_name(&self) -> Option<String> {
        let Load::Ready(catalog) = &self.catalog else {
            return None;
        };
        self.model
            .as_ref()
            .and_then(|id| catalog.models.iter().find(|m| &m.id == id))
            .map(|m| m.name.clone())
    }
}

/// Plain statement of scope, shown before setup and in the report chat.
fn disclosure(model: &str) -> impl IntoElement {
    let line = |id: &'static str, text: String| {
        div()
            .id(id)
            .test_support()
            .child(ui::text(Text::Body, SharedString::from(text)))
    };
    div()
        .id("insights-scope")
        .test_support()
        .v_flex()
        .gap_1()
        .child(line(
            "insights-scope-read",
            "Reads sanitized excerpts of chats in all projects on this Mac, including archived ones. Never changes them.".into(),
        ))
        .child(line(
            "insights-scope-model",
            format!("Sends them to {model}. Redaction isn't a privacy guarantee."),
        ))
        .child(line(
            "insights-scope-write",
            "Writes only its reports and findings. It can't approve or start work.".into(),
        ))
}

fn outcome_notice(outcome: &Outcome, accepted: &'static str) -> Option<Notice> {
    Some(match outcome {
        Outcome::Accepted(_) => Notice::new(accepted).tone(Tone::Success),
        Outcome::Pending => {
            Notice::new("Local is still applying this. Check again shortly.").tone(Tone::Normal)
        }
        Outcome::Rejected(reason) => {
            Notice::new(format!("Not applied: {reason}")).tone(Tone::Error)
        }
        Outcome::Unknown(e) => Notice::new(*e)
            .detail("It may have applied. Check it; it is never sent twice.")
            .tone(Tone::Warning),
        Outcome::Refused(e) => Notice::new(*e).tone(Tone::Error),
    })
}

impl Panel {
    /// The saved attempt for a slot, if it still needs an explicit Check.
    fn check_row(&self, slot: &str, cx: &mut Context<Self>) -> Option<gpui_kit::AnyElement> {
        let attempt = self.attempt(slot)?;
        if !attempt.open() || self.waiting() {
            return None;
        }
        let slot = slot.to_owned();
        Some(
            div()
                .id("insights-unconfirmed")
                .test_support()
                .h_flex()
                .items_center()
                .gap_2()
                .child(
                    div().flex_1().min_w_0().child(
                        Notice::new("An earlier action wasn't confirmed.")
                            .detail("Check sends it only if Local never received it.")
                            .tone(Tone::Warning),
                    ),
                )
                .child(
                    ui::action("insights-check", "Check", Action::Secondary).on_click(cx.listener(
                        move |v, _, _, cx| v.send(model::Action::Check { slot: slot.clone() }, cx),
                    )),
                )
                .into_any_element(),
        )
    }

    fn render_setup(&mut self, cx: &mut Context<Self>) -> gpui_kit::Div {
        let Scope::Setup {
            mission_title,
            mission,
            ..
        } = self.scope.clone()
        else {
            return div();
        };
        let slot = format!("create:{mission}");
        let model_name = self
            .chosen_model_name()
            .unwrap_or_else(|| "the selected model".into());
        let mut root = div()
            .v_flex()
            .gap_3()
            .child(ui::text(
                Text::Body,
                SharedString::from(format!(
                    "Creates a report chat for “{mission_title}”. Reviews run only when you ask."
                )),
            ))
            .child(disclosure(&model_name));
        let picker = match &self.catalog {
            Load::Loading => ui::text(Text::Caption, "Loading models…").into_any_element(),
            Load::Failed(e) => Notice::new(e.clone()).tone(Tone::Error).into_any_element(),
            Load::Ready(catalog) => {
                let weak = cx.weak_entity();
                let catalog = catalog.clone();
                ui::action(
                    "insights-model",
                    SharedString::from(format!("Model: {model_name}")),
                    Action::Secondary,
                )
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
        root = root.child(div().h_flex().child(picker));
        root = root.children(self.check_row(&slot, cx));
        if self.waiting() {
            root = root.child(Notice::new("Setting up… Closing doesn't cancel it."));
        } else if let Some(n) = self
            .latest()
            .and_then(|o| outcome_notice(o, "Insights chat created."))
        {
            root = root.child(n);
        }
        if let Some(e) = self.error {
            root = root.child(Notice::new(e).tone(Tone::Error));
        }
        let request = self.setup_request();
        let done = self
            .attempt(&slot)
            .is_some_and(|a| a.state == model::State::Accepted);
        root.child(
            div()
                .h_flex()
                .justify_end()
                .gap_2()
                .child(
                    ui::action(
                        "insights-close",
                        if done { "Close" } else { "Cancel" },
                        Action::Quiet,
                    )
                    .on_click(cx.listener(|v, _, _, cx| {
                        if v.visible {
                            cx.emit(Event::Close);
                        }
                    })),
                )
                .when(!done, |d| {
                    d.child(
                        ui::action("insights-setup", "Set up Insights chat", Action::Primary)
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
                }),
        )
    }

    fn finding_row(
        &self,
        f: &Finding,
        ix: usize,
        enabled: bool,
        cx: &mut Context<Self>,
    ) -> gpui_kit::AnyElement {
        let mut priority = f.priority.clone();
        if let Some(first) = priority.get_mut(..1) {
            first.make_ascii_uppercase();
        }
        let mut meta = vec![f.lifecycle.label().to_owned(), priority];
        if !f.targets.is_empty() {
            meta.push(
                f.targets
                    .iter()
                    .map(|t| t.label.as_str())
                    .collect::<Vec<_>>()
                    .join(", "),
            );
        }
        let meta = meta.join(" · ");
        let weak = cx.weak_entity();
        let finding = f.clone();
        let mut text = div()
            .v_flex()
            .flex_1()
            .min_w_0()
            .gap_0p5()
            .child(ui::text(Text::Body, SharedString::from(f.title.clone())))
            .child(
                ui::text(Text::Caption, SharedString::from(meta)).text_color(Tone::Quiet.color(cx)),
            );
        if let Some(cost) = &f.cost {
            // One line, always naming the estimate as unmeasured.
            let line = if cost.later_result.trim().is_empty() {
                format!("Est. {} (not measured)", cost.estimate)
            } else {
                format!("Est. {} · Measured: {}", cost.estimate, cost.later_result)
            };
            text = text.child(
                ui::text(Text::Caption, SharedString::from(line)).text_color(Tone::Quiet.color(cx)),
            );
        }
        div()
            .id(("insights-finding", ix))
            .test_support()
            .h_flex()
            .items_start()
            .gap_2()
            .py_1()
            .child(text)
            .child(
                ui::action(("insights-decide", ix), "Decide", Action::Quiet)
                    .disabled(!enabled)
                    .dropdown_menu(move |mut menu, _, _| {
                        for to in lifecycle_choices(finding.lifecycle) {
                            let (weak, f) = (weak.clone(), finding.clone());
                            menu = menu.item(PopupMenuItem::new(decision_label(to)).on_click(
                                move |_, _, cx| {
                                    let _ = weak.update(cx, |v, cx| {
                                        if v.visible && !v.waiting() {
                                            v.confirm = Some(Confirm::Decide {
                                                key: f.key.clone(),
                                                title: f.title.clone(),
                                                from: f.lifecycle,
                                                to,
                                                expected_revision: f.revision,
                                            });
                                            v.error = None;
                                            cx.notify();
                                        }
                                    });
                                },
                            ));
                        }
                        menu
                    }),
            )
            .into_any_element()
    }

    fn render_chat(&mut self, cx: &mut Context<Self>) -> gpui_kit::Div {
        let Scope::Chat { session } = self.scope.clone() else {
            return div();
        };
        let model_name = self
            .model_label
            .clone()
            .unwrap_or_else(|| "this chat's model".into());
        let mut root = div().v_flex().gap_3();
        let status = match &self.status {
            Load::Loading => {
                return root
                    .child(ui::text(Text::Caption, "Reading access…"))
                    .child(self.footer(None, cx));
            }
            Load::Failed(e) => {
                return root
                    .child(Notice::new(e.clone()).tone(Tone::Error))
                    .child(self.footer(None, cx));
            }
            Load::Ready(s) => s.clone(),
        };
        let (state, tone) = if status.setup_pending {
            ("Setup didn't finish. Access stays off.", Tone::Warning)
        } else if !status.enabled {
            ("Access revoked. History and reports are kept.", Tone::Quiet)
        } else if status.archived {
            (
                "Chat archived. Access stays off while archived.",
                Tone::Quiet,
            )
        } else if !status.available {
            (
                "Access unavailable: its project, mission or host changed.",
                Tone::Warning,
            )
        } else {
            ("Access on", Tone::Normal)
        };
        let state = if state == "Access on" {
            format!("Access on · {model_name}")
        } else {
            state.to_owned()
        };
        root = root
            .child(
                div()
                    .id("insights-state")
                    .test_support()
                    .h_flex()
                    .items_center()
                    .gap_2()
                    .child(div().flex_1().min_w_0().child(
                        ui::text(Text::Body, SharedString::from(state)).text_color(tone.color(cx)),
                    ))
                    .child(
                        ui::action(
                            "insights-scope-toggle",
                            if self.scope_open {
                                "Hide scope"
                            } else {
                                "What can it read?"
                            },
                            Action::Quiet,
                        )
                        .on_click(cx.listener(|v, _, _, cx| {
                            v.scope_open = !v.scope_open;
                            cx.notify();
                        })),
                    ),
            )
            .when(self.scope_open, |d| d.child(disclosure(&model_name)));
        let live = status.enabled && status.available && !status.archived && !status.setup_pending;
        if live {
            let mut list = div()
                .id("insights-findings")
                .test_support()
                .v_flex()
                .gap_1()
                .child(ui::text(Text::Label, "Findings"));
            match &self.findings {
                Load::Loading => list = list.child(ui::text(Text::Caption, "Loading findings…")),
                Load::Failed(e) => list = list.child(Notice::new(e.clone()).tone(Tone::Error)),
                Load::Ready(items) if items.is_empty() => {
                    list = list.child(ui::text(Text::Caption, "No findings yet."))
                }
                Load::Ready(items) => {
                    let enabled = !self.waiting() && self.confirm.is_none();
                    let items = items.clone();
                    for (ix, f) in items.iter().enumerate() {
                        list = list.child(self.finding_row(f, ix, enabled, cx));
                    }
                    if let Some(cursor) = self.next_cursor {
                        list = list.child(
                            ui::action("insights-more", "Show more findings", Action::Quiet)
                                .on_click(cx.listener(move |v, _, _, cx| {
                                    v.read_findings(Some(cursor), cx)
                                })),
                        );
                    }
                }
            }
            root = root.child(list);
        }
        // Unconfirmed actions for this chat: revocation, then any decision.
        let revoke_slot = format!("revoke:{session}");
        root = root.children(self.check_row(&revoke_slot, cx));
        if let Some(slot) = self.book.as_ref().and_then(|b| {
            b.insights
                .iter()
                .find(|(s, a)| s.starts_with(&format!("lifecycle:{session}:")) && a.open())
                .map(|(s, _)| s.clone())
        }) {
            root = root.children(self.check_row(&slot, cx));
        }
        match self.confirm.clone() {
            Some(Confirm::Decide {
                key,
                title,
                from,
                to,
                expected_revision,
            }) => {
                root = root.child(
                    div()
                        .id("insights-confirm-decision")
                        .test_support()
                        .v_flex()
                        .gap_2()
                        .child(
                            Notice::new(format!("{}: “{title}”?", decision_label(to))).detail(
                                format!(
                                    "{} → {}. This records your decision only. No work starts.",
                                    from.label(),
                                    to.label()
                                ),
                            ),
                        )
                        .child(
                            div()
                                .h_flex()
                                .justify_end()
                                .gap_2()
                                .child(
                                    ui::action("insights-decision-cancel", "Cancel", Action::Quiet)
                                        .on_click(cx.listener(|v, _, _, cx| {
                                            v.confirm = None;
                                            cx.notify();
                                        })),
                                )
                                .child(
                                    ui::action(
                                        "insights-decision-confirm",
                                        "Record decision",
                                        Action::Primary,
                                    )
                                    .disabled(self.waiting())
                                    .on_click(cx.listener(
                                        move |v, _, _, cx| {
                                            v.send(
                                                model::Action::Start(Request::Lifecycle {
                                                    session_id: session.clone(),
                                                    key: key.clone(),
                                                    expected_revision,
                                                    lifecycle: to,
                                                }),
                                                cx,
                                            );
                                        },
                                    )),
                                ),
                        ),
                );
            }
            Some(Confirm::Revoke) => {
                let session = session.clone();
                let revision = status.revision;
                root = root.child(
                    div()
                        .id("insights-confirm-revoke")
                        .test_support()
                        .v_flex()
                        .gap_2()
                        .child(
                            Notice::new("Revoke Insights access?")
                                .detail("The chat keeps its history and reports but can't read other chats or update the backlog. A new Insights chat is needed to restore access.")
                                .tone(Tone::Warning),
                        )
                        .child(
                            div()
                                .h_flex()
                                .justify_end()
                                .gap_2()
                                .child(
                                    ui::action("insights-revoke-cancel", "Cancel", Action::Quiet)
                                        .on_click(cx.listener(|v, _, _, cx| {
                                            v.confirm = None;
                                            cx.notify();
                                        })),
                                )
                                .child(
                                    ui::action("insights-revoke-confirm", "Revoke access", Action::Danger)
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
                        ),
                );
            }
            None => {}
        }
        if self.waiting() {
            root = root.child(Notice::new("Saving… Closing doesn't cancel it."));
        } else if let Some(n) = self.latest().and_then(|o| outcome_notice(o, "Done.")) {
            root = root.child(n);
        }
        if let Some(e) = self.error {
            root = root.child(Notice::new(e).tone(Tone::Error));
        }
        root.child(self.footer(Some(status), cx))
    }

    fn footer(&self, status: Option<Status>, cx: &mut Context<Self>) -> gpui_kit::Div {
        let revocable = status
            .as_ref()
            .is_some_and(|s| s.enabled && !s.setup_pending);
        let mission = status.as_ref().map(|s| s.mission_id.clone());
        div()
            .h_flex()
            .gap_2()
            .child(div().flex_1().h_flex().when(revocable, |d| {
                d.child(
                    ui::action("insights-revoke", "Revoke access…", Action::Quiet)
                        .disabled(self.waiting() || self.confirm.is_some())
                        .on_click(cx.listener(|v, _, _, cx| {
                            v.confirm = Some(Confirm::Revoke);
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
            .child(
                ui::action("insights-close", "Close", Action::Quiet).on_click(cx.listener(
                    |v, _, _, cx| {
                        if v.visible {
                            cx.emit(Event::Close);
                        }
                    },
                )),
            )
    }
}

impl Render for Panel {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.render_panel(cx)
    }
}

/// Hidden probes drive the same state a click would; never compiled into production.
#[cfg(feature = "native-probes")]
impl Panel {
    pub(crate) fn probe_ready(&self) -> bool {
        match &self.scope {
            Scope::Chat { .. } => {
                !matches!(self.status, Load::Loading) && !matches!(self.findings, Load::Loading)
            }
            Scope::Setup { .. } => !matches!(self.catalog, Load::Loading),
        }
    }
    pub(crate) fn probe_decide(&mut self, ix: usize, to: Lifecycle, cx: &mut Context<Self>) {
        if let Load::Ready(items) = &self.findings
            && let Some(f) = items.get(ix)
        {
            self.confirm = Some(Confirm::Decide {
                key: f.key.clone(),
                title: f.title.clone(),
                from: f.lifecycle,
                to,
                expected_revision: f.revision,
            });
            cx.notify();
        }
    }
    pub(crate) fn probe_revoke(&mut self, cx: &mut Context<Self>) {
        self.confirm = Some(Confirm::Revoke);
        cx.notify();
    }
    pub(crate) fn probe_scope(&mut self, cx: &mut Context<Self>) {
        self.scope_open = true;
        cx.notify();
    }
}

impl Panel {
    fn render_panel(&mut self, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        let body = match &self.scope {
            Scope::Chat { .. } => self.render_chat(cx),
            Scope::Setup { .. } => self.render_setup(cx),
        };
        div()
            .id("insights-panel")
            .test_support()
            .v_flex()
            .w_full()
            .min_w_0()
            .max_h(px(560.))
            .overflow_y_scroll()
            .track_focus(&self.focus)
            .on_key_down(cx.listener(|v, e: &gpui_kit::KeyDownEvent, _, cx| {
                if e.keystroke.key == "escape" && v.visible {
                    cx.stop_propagation();
                    if v.confirm.take().is_some() {
                        cx.notify();
                    } else {
                        cx.emit(Event::Close);
                    }
                }
            }))
            .child(body)
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
}
