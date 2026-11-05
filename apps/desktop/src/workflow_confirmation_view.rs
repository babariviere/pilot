//! Compact native sheet for one workflow confirmation: plan approval, reviewer consent or
//! their revocation. Opening is a passive package read. Confirm captures the package the
//! sheet shows and hands it to the durable writer, which saves it before its one POST.
//! An unconfirmed result is only Checked by exact receipt lookup, never resent.
use crate::{
    LocalOptions,
    delivery_store::Book,
    ui::{self, Action, Notice, Text, Tone},
    workflow_confirmation::{self as model, Decision, Gate, Outcome, Prepared, Purpose, State},
};
use gpui_kit::base::TestTextExt as _;
use gpui_kit::{
    App, Context, Entity, EventEmitter, FocusHandle, InteractiveElement, IntoElement,
    ParentElement, Render, SharedString, StatefulInteractiveElement as _, Styled, Task,
    TestSupportExt, Window,
    component::{ActiveTheme, Disableable, StyledExt, WindowExt},
    div,
    prelude::FluentBuilder,
    px,
};
use std::sync::Arc;

gpui_kit::actions!(workflow_confirmation, [ConfirmWorkflow]);
struct Keys;
impl gpui_kit::Global for Keys {}

pub(crate) enum Event {
    Close,
    /// Send this explicit user action through the durable writer.
    Write {
        request: u64,
        action: model::Action,
    },
}

/// The mission this sheet is about, captured when it opens. It never changes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Target {
    pub(crate) mission: String,
    pub(crate) project: String,
    pub(crate) title: String,
    /// The coordinator chat the overview showed, for its title only.
    pub(crate) coordinator: Option<(String, String)>,
}

enum Load {
    Loading,
    Ready(Box<Prepared>),
    Unavailable(SharedString),
    Failed(&'static str),
}

pub(crate) struct Sheet {
    pub(crate) target: Target,
    pub(crate) purpose: Purpose,
    options: LocalOptions,
    pub(crate) visible: bool,
    focus: FocusHandle,
    load: Load,
    reading: Option<Task<()>>,
    /// A read applies only while it is the latest one and nothing was confirmed since.
    read_generation: u64,
    book: Option<Arc<Book>>,
    reply: Option<model::Reply>,
    request: u64,
    error: Option<&'static str>,
    brief_open: bool,
    decisions_open: bool,
    disclosure_open: bool,
}
impl EventEmitter<Event> for Sheet {}

impl Sheet {
    pub(crate) fn new(
        target: Target,
        purpose: Purpose,
        options: LocalOptions,
        cx: &mut Context<Self>,
    ) -> Self {
        if !cx.has_global::<Keys>() {
            let confirm = ui::shortcut(
                "secondary-enter",
                ConfirmWorkflow,
                Some("WorkflowConfirmation"),
                cx,
            );
            cx.bind_keys([confirm]);
            cx.set_global(Keys);
        }
        Self {
            target,
            purpose,
            options,
            visible: true,
            focus: cx.focus_handle(),
            load: Load::Loading,
            reading: None,
            read_generation: 0,
            book: None,
            reply: None,
            request: 0,
            error: None,
            brief_open: false,
            decisions_open: false,
            disclosure_open: false,
        }
    }
    pub(crate) fn matches(
        &self,
        target: &Target,
        purpose: Purpose,
        options: &LocalOptions,
    ) -> bool {
        self.target.mission == target.mission
            && self.target.project == target.project
            && self.purpose == purpose
            && self.options.host() == options.host()
            && self.options.loopback() == options.loopback()
    }
    pub(crate) fn owns_focus(&self, w: &Window, cx: &App) -> bool {
        self.focus.contains_focused(w, cx)
    }
    pub(crate) fn focus(&self, w: &mut Window, cx: &mut App) {
        self.focus.focus(w, cx);
    }
    pub(crate) fn open(sheet: Entity<Self>, w: &mut Window, cx: &mut App) {
        let title = SharedString::from(sheet.read(cx).purpose.title());
        w.open_dialog(cx, {
            let sheet = sheet.clone();
            move |d, _, cx| {
                ui::dialog(d, cx)
                    .title(title.clone())
                    .w(px(440.))
                    .overlay_closable(false)
                    .close_button(false)
                    .keyboard(false)
                    .on_cancel(|_, _, _| false)
                    .child(sheet.clone())
            }
        });
        sheet.update(cx, |s, cx| s.focus(w, cx));
    }
    fn slot(&self) -> String {
        model::slot(self.purpose, &self.target.mission)
    }
    fn attempt(&self) -> Option<&model::Attempt> {
        self.book.as_ref()?.workflow.get(&self.slot())
    }
    fn open_attempt(&self) -> bool {
        self.attempt().is_some_and(|a| a.open())
    }
    /// The writer's reply to this sheet's latest command.
    fn latest(&self) -> Option<&Outcome> {
        let slot = self.slot();
        self.reply
            .as_ref()
            .filter(|r| r.slot == slot && r.request == self.request && self.request > 0)
            .and_then(|r| r.outcome.as_ref())
    }
    /// Sent and not yet answered, including before the writer's first status arrives.
    pub(crate) fn waiting(&self) -> bool {
        self.request > 0 && self.latest().is_none()
    }
    /// The package on screen: a saved open confirmation's own bytes, else the prepared one.
    fn shown(&self) -> Option<Prepared> {
        if let Some(a) = self
            .attempt()
            .filter(|a| a.open() || self.latest().is_some())
        {
            return saved(a, &self.target);
        }
        match &self.load {
            Load::Ready(p) => Some((**p).clone()),
            _ => None,
        }
    }
    /// Re-read the package passively. Never while a confirmation is in flight or open.
    pub(crate) fn refresh(&mut self, cx: &mut Context<Self>) {
        if self.waiting() || self.open_attempt() {
            return;
        }
        self.read_generation += 1;
        let generation = self.read_generation;
        self.load = Load::Loading;
        self.error = None;
        self.request = 0;
        let Some(output) = model::prepare(
            self.options.clone(),
            self.purpose,
            self.target.mission.clone(),
            self.target.project.clone(),
        ) else {
            self.load = Load::Failed("Couldn't start the confirmation read.");
            cx.notify();
            return;
        };
        self.reading = Some(cx.spawn(async move |view, cx| {
            let reply = output
                .recv()
                .await
                .unwrap_or(Err("Couldn't read the confirmation package."));
            let _ = view.update(cx, |v, cx| {
                // A late read never replaces what was confirmed or a newer read.
                if v.read_generation != generation {
                    return;
                }
                v.reading = None;
                v.load = match reply {
                    Ok(Gate::Ready(p)) => Load::Ready(p),
                    Ok(Gate::Unavailable(reason)) => Load::Unavailable(reason.into()),
                    Err(e) => Load::Failed(e),
                };
                cx.notify();
            });
        }));
        cx.notify();
    }
    /// Adopt the writer's retained attempts and latest reply.
    pub(crate) fn accept(
        &mut self,
        book: Option<&Arc<Book>>,
        reply: Option<&model::Reply>,
        cx: &mut Context<Self>,
    ) {
        let slot = self.slot();
        let changed = self.book.as_ref().map(|b| b.workflow.get(&slot))
            != book.map(|b| b.workflow.get(&slot))
            || self.reply.as_ref() != reply;
        if !changed {
            return;
        }
        self.book = book.cloned();
        self.reply = reply.cloned();
        cx.notify();
    }
    /// Confirm exactly the package on screen. A later read can't retarget it.
    fn confirm(&mut self, cx: &mut Context<Self>) {
        if !self.visible || self.waiting() || self.reading.is_some() || self.open_attempt() {
            return;
        }
        let Load::Ready(p) = &self.load else {
            return;
        };
        if matches!(self.latest(), Some(Outcome::Accepted)) || nothing_to_revoke(p) {
            return;
        }
        let request = p.request();
        self.read_generation += 1;
        self.send(model::Action::Start(request), cx);
    }
    fn check(&mut self, cx: &mut Context<Self>) {
        if self.visible && !self.waiting() && self.open_attempt() {
            self.send(model::Action::Check { slot: self.slot() }, cx);
        }
    }
    fn send(&mut self, action: model::Action, cx: &mut Context<Self>) {
        self.request += 1;
        self.error = None;
        cx.emit(Event::Write {
            request: self.request,
            action,
        });
        cx.notify();
    }
    /// The owner could not hand the command to the writer.
    pub(crate) fn not_sent(&mut self, cx: &mut Context<Self>) {
        self.request = 0;
        self.error = Some("Busy. Nothing was sent.");
        cx.notify();
    }
    fn close(&mut self, cx: &mut Context<Self>) {
        if self.visible {
            cx.emit(Event::Close);
        }
    }
}

/// A saved envelope's own package, for display. Nothing is re-read or rebuilt.
fn saved(a: &model::Attempt, t: &Target) -> Option<Prepared> {
    let purpose = Purpose::from_kind(&a.operation.kind)?;
    let p: serde_json::Value = serde_json::from_str(&a.operation.payload).ok()?;
    let value = serde_json::json!({"package": p["package"], "expectedPriorOperationId": p["expectedPriorOperationId"]});
    model::prepared(&value, purpose, &t.mission, &t.project).ok()
}

/// A revocation with no earlier confirmation record has nothing to end.
fn nothing_to_revoke(p: &Prepared) -> bool {
    p.purpose.revoke() && p.prior.is_none()
}
fn short(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_owned();
    }
    let mut s: String = text.chars().take(max - 1).collect();
    s.truncate(s.trim_end().len());
    s.push('…');
    s
}
fn row(
    id: &'static str,
    label: &'static str,
    value: impl Into<SharedString>,
    cx: &App,
) -> impl IntoElement {
    let value: SharedString = value.into();
    labelled(
        id,
        label,
        ui::text(Text::Body, value.clone()).test_text(value),
        cx,
    )
}
/// Complete package text in a limited scroll box. The test record is the painted string.
fn full_text(id: &'static str, text: &str, cx: &App) -> impl IntoElement {
    let text = SharedString::from(text.to_owned());
    div()
        .id(id)
        .test_support()
        .max_h(px(220.))
        .overflow_y_scroll()
        .px_2()
        .py_1()
        .rounded(px(crate::appearance::Radius::CONTROL))
        .bg(cx.theme().muted)
        .child(ui::text(Text::Caption, text.clone()).test_text(text))
}
/// A Kit button that discloses or hides one part of the package.
fn toggle(
    id: &'static str,
    open: bool,
    show: String,
    hide: &'static str,
) -> gpui_kit::component::button::Button {
    ui::action(
        id,
        if open {
            SharedString::from(hide)
        } else {
            SharedString::from(show)
        },
        Action::Quiet,
    )
}
fn labelled(
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
                .w(px(76.))
                .flex_none()
                .child(ui::text(Text::Body, label).text_color(cx.theme().muted_foreground)),
        )
        .child(div().flex_1().min_w_0().child(value))
}
fn decisions(decisions: &[Decision]) -> String {
    let numbers: Vec<u64> = decisions.iter().map(|d| d.number).collect();
    match (numbers.len(), numbers.iter().min(), numbers.iter().max()) {
        (0, ..) => "no active decisions".into(),
        (1, Some(n), _) => format!("decision D{n}"),
        // A range only when it has no gaps; otherwise just the count.
        (k, Some(a), Some(b)) if b - a + 1 == k as u64 => format!("{k} decisions (D{a}–D{b})"),
        (k, ..) => format!("{k} decisions"),
    }
}

impl Sheet {
    /// The plan's exact revision. The complete saved brief and active decision texts of
    /// this same package are disclosed on request, never re-read.
    fn plan(&self, p: &Prepared, cx: &mut Context<Self>) -> gpui_kit::Div {
        let mut plan = div().v_flex().gap_1().min_w_0().child(ui::text(
            Text::Body,
            SharedString::from(format!(
                "Brief revision {} · {}",
                p.brief_revision,
                decisions(&p.decisions)
            )),
        ));
        let mut toggles = div().h_flex().flex_wrap().gap_1().child(
            toggle(
                "workflow-brief-toggle",
                self.brief_open,
                "Show brief".into(),
                "Hide brief",
            )
            .on_click(cx.listener(|v, _, _, cx| {
                v.brief_open = !v.brief_open;
                cx.notify();
            })),
        );
        if !p.decisions.is_empty() {
            toggles = toggles.child(
                toggle(
                    "workflow-decisions-toggle",
                    self.decisions_open,
                    format!("Show decisions ({})", p.decisions.len()),
                    "Hide decisions",
                )
                .on_click(cx.listener(|v, _, _, cx| {
                    v.decisions_open = !v.decisions_open;
                    cx.notify();
                })),
            );
        }
        plan = plan.child(toggles);
        if self.brief_open {
            plan = plan.child(full_text("workflow-brief", &p.brief, cx));
        }
        if self.decisions_open {
            let text = p
                .decisions
                .iter()
                .map(|d| format!("D{}  {}", d.number, d.text))
                .collect::<Vec<_>>()
                .join("\n\n");
            plan = plan.child(full_text("workflow-decisions", &text, cx));
        }
        plan
    }
    fn body(&self, p: &Prepared, cx: &mut Context<Self>) -> gpui_kit::Div {
        let coordinator = match &self.target.coordinator {
            Some((id, title)) if *id == p.coordinator => title.clone(),
            _ => p.coordinator.clone(),
        };
        let mut body = div()
            .v_flex()
            .gap_2()
            .min_w_0()
            .child(
                ui::text(
                    Text::Body,
                    SharedString::from(short(&self.target.title, 140)),
                )
                .text_color(cx.theme().muted_foreground),
            )
            .child(labelled("workflow-plan", "Plan", self.plan(p, cx), cx))
            .child(row(
                "workflow-coordinator",
                "Coordinator",
                if coordinator == p.coordinator {
                    coordinator
                } else {
                    format!("{coordinator} ({})", p.coordinator)
                },
                cx,
            ));
        body = match p.purpose {
            Purpose::Approve => body
                .child(row(
                    "workflow-may",
                    "May",
                    "Plan, classify, assign, assess and accept outcomes.",
                    cx,
                ))
                .child(row(
                    "workflow-excludes",
                    "Excludes",
                    "Reviewer spend, human review, merging, cleanup or handing authority on.",
                    cx,
                ))
                .child(row(
                    "workflow-limits",
                    "Limits",
                    "Balanced review; required checks must pass. Ends with the mission or when you revoke it. More scope, risk or budget needs a new confirmation. Protected decisions stay yours.",
                    cx,
                )),
            Purpose::Revoke => body.child(row(
                "workflow-effect",
                "Effect",
                "Ends the coordinator's approved authority now. History is kept.",
                cx,
            )),
            Purpose::ConsentRevoke => body.child(row(
                "workflow-effect",
                "Effect",
                "Ends reviewer use for this mission now. Recorded spend and history are kept.",
                cx,
            )),
            Purpose::Consent => body,
        };
        if let Some(d) = p
            .disclosure
            .as_ref()
            .filter(|_| p.purpose == Purpose::Consent)
        {
            let expires = crate::scheduled_messages::words(
                d.expires_at,
                crate::usage_overview::now(),
                crate::subscription_pause::local_offset,
            );
            // Compact by default; every clipped value has a complete form in this package.
            let full = self.disclosure_open;
            let value = |text: &str, max: usize| {
                if full {
                    text.to_owned()
                } else {
                    short(text, max)
                }
            };
            let clipped = [
                (&d.provider, 120),
                (&d.model, 120),
                (&d.account, 120),
                (&d.terms, 240),
            ]
            .iter()
            .any(|(t, max)| t.chars().count() > *max);
            body = body
                .child(row("workflow-data", "Data", "Exact local brief and artifact revisions of this mission.", cx))
                .child(row("workflow-provider", "Provider", value(&d.provider, 120), cx))
                .child(row("workflow-model", "Model", value(&d.model, 120), cx))
                .child(row("workflow-account", "Account", value(&d.account, 120), cx))
                .child(row("workflow-terms", "Terms", value(&d.terms, 240), cx))
                .when(clipped, |b| {
                    b.child(div().pl(px(88.)).child(
                        toggle("workflow-disclosure-toggle", full, "Show full disclosure".into(), "Show shorter")
                            .on_click(cx.listener(|v, _, _, cx| {
                                v.disclosure_open = !v.disclosure_open;
                                cx.notify();
                            })),
                    ))
                })
                .child(row(
                    "workflow-allowance",
                    "Allowance",
                    "$20 per mission and $4 per task, counted across revisions and rechecks. Shared limits still apply.",
                    cx,
                ))
                .child(row(
                    "workflow-retention",
                    "Kept",
                    "Raw review data 30 days, records 90 days, unless pinned.",
                    cx,
                ))
                .child(row(
                    "workflow-expiry",
                    "Ends",
                    format!("{expires}, at mission end, or when you revoke it."),
                    cx,
                ))
                .child(row(
                    "workflow-no-fallback",
                    "Never",
                    "Switches account or model, uses a paid fallback, or refills the allowance.",
                    cx,
                ));
        }
        body.child(
            div().id("workflow-package").test_support().child(
                ui::text(
                    Text::Caption,
                    SharedString::from(format!("Package {}", &p.digest[..12])),
                )
                .text_color(cx.theme().muted_foreground),
            ),
        )
    }
    fn check_row(&self, cx: &mut Context<Self>) -> Option<gpui_kit::AnyElement> {
        let attempt = self.attempt()?;
        if !attempt.open() || self.waiting() {
            return None;
        }
        let label = match (attempt.state, self.latest()) {
            (State::Pending, _) => "Still applying. Check again later.",
            (_, Some(Outcome::Unknown(e))) => e,
            _ => "Not confirmed. Never resent.",
        };
        Some(
            div()
                .id("workflow-unconfirmed")
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
                    ui::action("workflow-check", "Check", Action::Quiet).on_click(cx.listener(
                        |v, _, w, cx| {
                            v.check(cx);
                            v.focus.focus(w, cx);
                        },
                    )),
                )
                .into_any_element(),
        )
    }
    fn outcome(&self) -> Option<Notice> {
        let done = match self.purpose {
            Purpose::Approve => "Approved. Nothing starts automatically.",
            Purpose::Revoke => "Plan approval revoked.",
            Purpose::Consent => "Consent saved. No review starts automatically.",
            Purpose::ConsentRevoke => "Reviewer consent revoked.",
        };
        Some(match self.latest()? {
            Outcome::Accepted => Notice::new(done).tone(Tone::Success),
            Outcome::Rejected(reason) => {
                Notice::new(format!("Not applied: {reason}")).tone(Tone::Error)
            }
            Outcome::Refused(e) => Notice::new(*e).tone(Tone::Error),
            Outcome::Pending | Outcome::Unknown(_) => return None,
        })
    }
}

impl Render for Sheet {
    fn render(&mut self, w: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let shown = self.shown();
        let body = match (&shown, &self.load) {
            (Some(p), _) => self.body(p, cx).into_any_element(),
            (None, Load::Loading) => {
                ui::text(Text::Caption, "Reading the package…").into_any_element()
            }
            (None, Load::Unavailable(reason)) => div()
                .id("workflow-unavailable")
                .test_support()
                .child(Notice::new(reason.clone()).tone(Tone::Warning))
                .into_any_element(),
            (None, Load::Failed(e)) => div()
                .id("workflow-failed")
                .test_support()
                .child(Notice::new(*e).tone(Tone::Error))
                .into_any_element(),
            (None, Load::Ready(_)) => div().into_any_element(),
        };
        let open = self.open_attempt();
        let settled = matches!(
            self.latest(),
            Some(Outcome::Accepted | Outcome::Rejected(_))
        );
        let accepted = matches!(self.latest(), Some(Outcome::Accepted));
        let nothing =
            !open && self.latest().is_none() && shown.as_ref().is_some_and(nothing_to_revoke);
        let ready = matches!(self.load, Load::Ready(_)) && self.reading.is_none();
        let review_again =
            !open && !self.waiting() && matches!(self.latest(), Some(Outcome::Rejected(_)));
        let retry = !open
            && !self.waiting()
            && !review_again
            && matches!(self.load, Load::Failed(_) | Load::Unavailable(_));
        let mut tail = div().v_flex().gap_3().w_full().min_w_0().when(shown.is_some(), |t| {
            t.child(
                div().id("workflow-assurance").test_support().child(
                    ui::text(
                        Text::Caption,
                        "Confirmed in Pilot. This doesn't verify who confirmed or guard against other apps you run.",
                    )
                    .text_color(cx.theme().muted_foreground),
                ),
            )
        });
        tail = tail.children(self.check_row(cx));
        if nothing {
            tail = tail.child(
                div()
                    .id("workflow-nothing")
                    .test_support()
                    .child(Notice::new(if self.purpose.consent() {
                        "There's no reviewer consent to revoke."
                    } else {
                        "There's no plan approval to revoke."
                    })),
            );
        }
        if self.waiting() {
            tail = tail.child(div().id("workflow-waiting").test_support().child(ui::text(
                Text::Caption,
                "Confirming… Closing doesn't cancel it.",
            )));
        } else if let Some(n) = self.outcome() {
            tail = tail.child(div().id("workflow-outcome").test_support().child(n));
        }
        if let Some(e) = self.error {
            tail = tail.child(
                div()
                    .id("workflow-error")
                    .test_support()
                    .child(Notice::new(e).tone(Tone::Error)),
            );
        }
        let confirm = !open
            && !settled
            && !self.waiting()
            && !matches!(self.load, Load::Unavailable(_) | Load::Failed(_));
        let actions = div()
            .h_flex()
            .justify_end()
            .gap_2()
            .child(
                ui::action(
                    "workflow-close",
                    if open || settled || self.waiting() {
                        "Close"
                    } else {
                        "Cancel"
                    },
                    Action::Quiet,
                )
                .on_click(cx.listener(|v, _, _, cx| v.close(cx))),
            )
            .when(review_again || retry, |d| {
                d.child(
                    ui::action(
                        "workflow-review",
                        if retry { "Try again" } else { "Review again" },
                        Action::Secondary,
                    )
                    .on_click(cx.listener(|v, _, w, cx| {
                        v.refresh(cx);
                        v.focus.focus(w, cx);
                    })),
                )
            })
            .when(confirm && !accepted && !nothing, |d| {
                d.child(
                    ui::action("workflow-confirm", self.purpose.confirm(), Action::Primary)
                        .disabled(!ready)
                        .tooltip("Confirm (⌘Enter)")
                        .on_click(cx.listener(|v, _, _, cx| v.confirm(cx))),
                )
            });
        let height = (f32::from(w.viewport_size().height) * 0.5).clamp(180., 520.);
        div()
            .id("workflow-sheet")
            .test_support()
            .key_context("WorkflowConfirmation")
            .track_focus(&self.focus)
            .v_flex()
            .gap_4()
            .w_full()
            .min_w_0()
            .on_action(cx.listener(|v, _: &ConfirmWorkflow, _, cx| v.confirm(cx)))
            .on_key_down(cx.listener(|v, e: &gpui_kit::KeyDownEvent, _, cx| {
                if e.keystroke.key == "escape" && v.visible {
                    cx.stop_propagation();
                    v.close(cx);
                }
            }))
            .child(
                div()
                    .id("workflow-body")
                    .test_support()
                    .w_full()
                    .min_w_0()
                    .max_h(px(height))
                    .overflow_y_scroll()
                    .child(body),
            )
            .child(tail.child(actions))
    }
}

#[cfg(feature = "native-probes")]
impl Sheet {
    pub(crate) fn probe_ready(&self) -> bool {
        self.reading.is_none() && (self.shown().is_some() || !matches!(self.load, Load::Loading))
    }
    pub(crate) fn probe_shown(&self) -> Option<Prepared> {
        self.shown()
    }
    pub(crate) fn probe_latest(&self) -> Option<Outcome> {
        self.latest().cloned()
    }
}
