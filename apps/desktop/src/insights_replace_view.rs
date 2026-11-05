//! Replace an unavailable report chat, from the Weekly Insights blocker. One compact
//! confirmation over Local's exact passive preview names the old chat, the automations
//! it stops and the fresh weekly settings of a new report chat. The click sends that
//! preview's payload verbatim through the durable writer; Check reads status and never
//! replays effects. Deleted content is never restored; old records stay.
use super::{
    enable::{caption, next_words, value},
    *,
};
use crate::{
    insights_enable::{Backlog, Model},
    insights_replace::{self as swap, Current, Disposition, Gate, Phase, Receipt, State},
};

/// Replacement state of the Weekly Insights panel.
#[derive(Default)]
pub(crate) struct Swap {
    /// The step the user opened over the unavailable-report blocker.
    step: Option<Step>,
    /// Status of the retained command, keyed by its operation ID and saved state.
    status: Option<(String, model::State, Load<swap::Status>)>,
    status_read: Option<Task<()>>,
    /// Bumped by every status read; only the newest read's reply lands.
    status_seq: u64,
    /// The panel request whose settled reply last forced a fresh status read.
    refreshed: u64,
    /// Exact completed links adopted after the successor's own settings re-read.
    adopted: Vec<Adopted>,
    /// Panel-wide preview counter: a reply for an earlier step or read never lands.
    reads: u64,
}
struct Step {
    /// The exact backlog; \`report\` is the one unavailable old identity.
    backlog: Backlog,
    explicit: Option<String>,
    /// Only the newest preview lands.
    generation: u64,
    gate: Load<Gate>,
    reading: Option<Task<()>>,
    /// Re-read of the successor named by a completed link: Ready once it validates.
    successor: Option<Load<String>>,
    successor_read: Option<Task<()>>,
    /// The confirmation was sent; the step yields to its own retained command.
    sent: bool,
    /// The sequence of a settled command already in this slot when the step opened.
    prior: Option<u64>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
struct Adopted {
    project_id: String,
    mission_id: String,
    old: String,
    successor: String,
}

fn identities_backlog(a: &model::Attempt) -> Option<Backlog> {
    swap::identities(&a.operation).map(|i| Backlog {
        project_id: i.project_id,
        mission_id: i.mission_id,
        title: None,
        report: None,
    })
}
/// The short form of a report identity, for reading; the full one is in the details.
fn short_id(id: &str) -> String {
    format!("Report chat {}", id.chars().take(8).collect::<String>())
}
fn rule_line(r: &swap::Rule) -> String {
    let title = if r.title.trim().is_empty() {
        "Untitled automation".to_owned()
    } else {
        shorten(&r.title, 60)
    };
    let when = r
        .recurrence
        .as_ref()
        .map(|c| format!(" · {}", crate::recurring_schedules::schedule(c, "")))
        .unwrap_or_default();
    format!("{title}{when}{}", if r.paused { " (paused)" } else { "" })
}

impl Panel {
    fn step(&self) -> Option<&Step> {
        self.replace.as_ref()?.step.as_ref()
    }
    fn step_mut(&mut self) -> Option<&mut Step> {
        self.replace.as_mut()?.step.as_mut()
    }
    /// The replacement step is what the panel shows, until its own command is retained.
    pub(super) fn replace_stepping(&self) -> bool {
        let Some(step) = self.step() else {
            return false;
        };
        if !step.sent {
            return true;
        }
        let old = step.backlog.report.as_deref().unwrap_or_default();
        match self.attempt(&swap::slot(old)) {
            Some(a) if Some(a.operation.sequence) != step.prior => {
                a.state == model::State::Rejected
            }
            // Not stored yet, or refused before storage: the confirmation keeps its words.
            _ => true,
        }
    }
    /// The retained replacement this panel follows: an unconfirmed one first, else the
    /// latest for the chosen backlog, else the latest one.
    pub(super) fn replace_attempt(&self) -> Option<&model::Attempt> {
        let book = self.book.as_ref()?;
        let all = || {
            book.insights
                .values()
                .filter(|a| a.operation.kind == swap::KIND)
        };
        if let Some(open) = all()
            .filter(|a| a.open())
            .max_by_key(|a| a.operation.sequence)
        {
            return Some(open);
        }
        let chosen = self.enable.as_ref()?.chosen.clone();
        all()
            .filter(|a| {
                chosen
                    .as_ref()
                    .is_none_or(|b| identities_backlog(a).is_some_and(|ab| ab.same(b)))
            })
            .max_by_key(|a| a.operation.sequence)
    }
    /// Exact old → successor pairs for this backlog: accepted replacement receipts naming
    /// both frozen identities, and completed links adopted after their successor re-read.
    pub(super) fn supersessions(&self, b: &Backlog) -> Vec<(String, String)> {
        let mut links: Vec<(String, String)> = Vec::new();
        for a in self.book.iter().flat_map(|book| book.insights.values()) {
            if a.operation.kind != swap::KIND || a.state != model::State::Accepted {
                continue;
            }
            let Some(i) = swap::identities(&a.operation) else {
                continue;
            };
            if i.project_id == b.project_id
                && i.mission_id == b.mission_id
                && i.successor == a.operation.target_id
                && a.result
                    .as_ref()
                    .is_some_and(|r| swap::valid_result(&a.operation, r))
            {
                links.push((i.old, i.successor));
            }
        }
        for ad in self.replace.iter().flat_map(|s| s.adopted.iter()) {
            if ad.project_id == b.project_id && ad.mission_id == b.mission_id {
                links.push((ad.old.clone(), ad.successor.clone()));
            }
        }
        links.sort();
        links.dedup();
        links
    }

    /// Open the step for one exact unavailable report. Opening is a passive read.
    pub(super) fn replace_open(&mut self, backlog: Backlog, cx: &mut Context<Self>) {
        if self.waiting() || backlog.report.is_none() {
            return;
        }
        let old = backlog.report.clone().unwrap_or_default();
        let prior = self
            .attempt(&swap::slot(&old))
            .map(|a| a.operation.sequence);
        let Some(swap) = self.replace.as_mut() else {
            return;
        };
        swap.step = Some(Step {
            backlog,
            explicit: None,
            generation: 0,
            gate: Load::Loading,
            reading: None,
            successor: None,
            successor_read: None,
            sent: false,
            prior,
        });
        self.error = None;
        self.replace_preview(cx);
    }
    /// Leave the step; nothing was sent. False when there is no step to leave.
    pub(super) fn replace_back(&mut self, cx: &mut Context<Self>) -> bool {
        if !self.replace_stepping() || self.waiting() {
            return false;
        }
        if let Some(s) = self.replace.as_mut() {
            s.step = None;
        }
        cx.notify();
        true
    }
    pub(super) fn replace_choose_model(&mut self, id: String, cx: &mut Context<Self>) {
        if let Some(step) = self.step_mut() {
            step.explicit = Some(id);
        }
        self.replace_preview(cx);
    }
    /// Reopening re-reads an unsent step's preview, and the retained command's status.
    pub(super) fn replace_refresh(&mut self, cx: &mut Context<Self>) {
        if self.step().is_some_and(|s| !s.sent) {
            self.replace_preview(cx);
        }
        self.replace_sync(cx);
    }

    fn replace_preview(&mut self, cx: &mut Context<Self>) {
        if self.waiting() {
            return;
        }
        let options = self.options.clone();
        let Some(swap) = self.replace.as_mut() else {
            return;
        };
        swap.reads += 1;
        let generation = swap.reads;
        let Some(step) = swap.step.as_mut() else {
            return;
        };
        step.generation = generation;
        step.gate = Load::Loading;
        step.successor = None;
        step.successor_read = None;
        let b = step.backlog.clone();
        let Some(rx) = swap::read_preview(
            options,
            b.project_id.clone(),
            b.mission_id.clone(),
            b.report.clone().unwrap_or_default(),
            step.explicit.clone(),
        ) else {
            step.gate = Load::Failed("Couldn't check the replacement.".into());
            return;
        };
        step.reading = Some(cx.spawn(async move |view, cx| {
            let reply = rx.recv().await;
            let _ = view.update(cx, |v, cx| {
                let Some(step) = v.step_mut() else {
                    return;
                };
                // Late: a newer read or a sent confirmation owns the step.
                if step.generation != generation || step.sent {
                    return;
                }
                step.reading = None;
                step.gate = match reply {
                    Ok(Ok(gate)) => Load::Ready(gate),
                    Ok(Err(e)) => Load::Failed(e.into()),
                    Err(_) => Load::Failed("Couldn't check the replacement.".into()),
                };
                let (link, model) = match &step.gate {
                    Load::Ready(Gate::Checked(pf)) => (
                        pf.supersession
                            .clone()
                            .filter(|_| pf.state == State::Replaced),
                        pf.frozen.as_ref().map(|f| f.enable.model.clone()),
                    ),
                    _ => (None, None),
                };
                if model.is_some() {
                    v.display_models(&b.project_id, model, cx);
                }
                if let Some(link) = link {
                    v.replace_successor(link, generation, cx);
                }
                cx.notify();
            });
        }));
        cx.notify();
    }
    /// A completed link is adopted only after the successor's own admitted settings name
    /// the same report chat, backlog and context on the pinned home.
    fn replace_successor(&mut self, link: swap::Link, generation: u64, cx: &mut Context<Self>) {
        let options = self.options.clone();
        let Some(step) = self.step_mut() else {
            return;
        };
        step.successor = Some(Load::Loading);
        let Some(rx) = crate::insights_settings::read_snapshot(options, link.successor.clone())
        else {
            step.successor = Some(Load::Failed("Couldn't confirm the new report chat.".into()));
            return;
        };
        step.successor_read = Some(cx.spawn(async move |view, cx| {
            let reply = rx.recv().await;
            let _ = view.update(cx, |v, cx| {
                let Some(step) = v.step_mut() else {
                    return;
                };
                if step.generation != generation {
                    return;
                }
                step.successor_read = None;
                let adopted = match reply {
                    Ok(Ok(crate::insights_settings::Gate::Ready(s)))
                        if swap::adoptable(&link, &s) =>
                    {
                        step.successor = Some(Load::Ready(link.successor.clone()));
                        true
                    }
                    Ok(Ok(crate::insights_settings::Gate::Ready(_))) => {
                        step.successor = Some(Load::Failed(
                            "The new report chat doesn't match this backlog. Nothing was adopted."
                                .into(),
                        ));
                        false
                    }
                    Ok(Ok(crate::insights_settings::Gate::Unsupported)) => {
                        step.successor = Some(Load::Failed(
                            "Update Pilot to confirm the new report chat.".into(),
                        ));
                        false
                    }
                    _ => {
                        step.successor = Some(Load::Failed(
                            "The new report chat couldn't be confirmed. Nothing was adopted."
                                .into(),
                        ));
                        false
                    }
                };
                if adopted && let Some(s) = v.replace.as_mut() {
                    let ad = Adopted {
                        project_id: link.project_id.clone(),
                        mission_id: link.mission_id.clone(),
                        old: link.old.clone(),
                        successor: link.successor.clone(),
                    };
                    if !s.adopted.contains(&ad) {
                        s.adopted.push(ad);
                    }
                    // Pins move to the successor; a fresh passive check follows them.
                    v.enable_sync(cx);
                }
                cx.notify();
            });
        }));
    }

    /// Passive status for the retained replacement: once per saved state, and again after
    /// each settled Check or send, since a pending receipt can stay pending while state moves.
    pub(super) fn replace_sync(&mut self, cx: &mut Context<Self>) {
        // A refused confirmation needs a fresh preview before another one.
        if let Some(step) = self.step()
            && step.sent
        {
            let old = step.backlog.report.clone().unwrap_or_default();
            let refused = self
                .attempt(&swap::slot(&old))
                .filter(|a| Some(a.operation.sequence) != step.prior)
                .filter(|a| a.state == model::State::Rejected)
                .map(|a| a.operation.sequence);
            if let Some(seq) = refused
                && let Some(step) = self.step_mut()
            {
                step.sent = false;
                step.prior = Some(seq);
                self.replace_preview(cx);
            }
        }
        let Some(attempt) = self.replace_attempt().cloned() else {
            return;
        };
        let settled =
            if self.latest().is_some() && self.slot.as_deref() == Some(attempt.slot.as_str()) {
                self.request
            } else {
                0
            };
        let Some(swap) = self.replace.as_mut() else {
            return;
        };
        let key = (attempt.operation.operation_id.clone(), attempt.state);
        let cached = swap
            .status
            .as_ref()
            .is_some_and(|(id, state, _)| (id, *state) == (&key.0, key.1));
        let force = settled > swap.refreshed;
        if force {
            swap.refreshed = settled;
        }
        if cached && !force {
            return;
        }
        if attempt.state == model::State::Rejected {
            if !cached {
                swap.status = Some((key.0, key.1, Load::Failed("Not replaced.".into())));
            }
            return;
        }
        self.replace_status(attempt, cx);
    }
    fn replace_status(&mut self, attempt: model::Attempt, cx: &mut Context<Self>) {
        let options = self.options.clone();
        let Some(swap) = self.replace.as_mut() else {
            return;
        };
        let (id, state) = (attempt.operation.operation_id.clone(), attempt.state);
        swap.status_seq += 1;
        let seq = swap.status_seq;
        swap.status = Some((id.clone(), state, Load::Loading));
        let Some(rx) = swap::read_status(options, attempt.operation) else {
            swap.status = Some((id, state, Load::Failed("Couldn't read status.".into())));
            return;
        };
        swap.status_read = Some(cx.spawn(async move |view, cx| {
            let reply = rx.recv().await;
            let _ = view.update(cx, |v, cx| {
                let Some(swap) = v.replace.as_mut() else {
                    return;
                };
                if swap.status_seq != seq
                    || swap
                        .status
                        .as_ref()
                        .is_none_or(|(i, s, _)| (i, *s) != (&id, state))
                {
                    return;
                }
                swap.status_read = None;
                swap.status = Some((
                    id,
                    state,
                    match reply {
                        Ok(Ok(s)) => Load::Ready(s),
                        Ok(Err(e)) => Load::Failed(e.into()),
                        Err(_) => Load::Failed("Couldn't read status.".into()),
                    },
                ));
                cx.notify();
            });
        }));
    }
    fn replace_status_again(&mut self, cx: &mut Context<Self>) {
        if let Some(a) = self.replace_attempt().cloned() {
            self.replace_status(a, cx);
        }
    }

    pub(super) fn replace_probe_ready(&self) -> bool {
        let Some(swap) = &self.replace else {
            return true;
        };
        let status = swap
            .status
            .as_ref()
            .is_none_or(|(_, _, s)| !matches!(s, Load::Loading));
        let step = swap.step.as_ref().is_none_or(|s| {
            !matches!(s.gate, Load::Loading) && !matches!(s.successor, Some(Load::Loading))
        });
        status && step
    }

    /// The step: Local's exact preview as one compact confirmation, or what blocks it.
    pub(super) fn render_replace(
        &mut self,
        cx: &mut Context<Self>,
    ) -> (gpui_kit::Div, gpui_kit::Div) {
        let Some(step) = self.step() else {
            return (div(), div());
        };
        let (gate, backlog, successor, explicit) = (
            step.gate.clone(),
            step.backlog.clone(),
            step.successor.clone(),
            step.explicit.clone(),
        );
        let old = backlog.report.clone().unwrap_or_default();
        let title = self.enable.as_ref().map_or_else(
            || "Linked mission".into(),
            |f| shorten(&f.title(&backlog), 80),
        );
        let mut body = div().v_flex().gap_3().min_w_0();
        let mut tail = div().v_flex().gap_3().w_full().min_w_0();
        let mut confirm: Option<model::Request> = None;
        let mut retry = false;
        let mut open_chat: Option<String> = None;
        let backlog_field = |cx: &App| {
            field(
                "insights-field-backlog",
                "Backlog",
                value(title.clone(), None, cx),
                cx,
            )
            .into_any_element()
        };
        let old_field = |note: Option<&str>, cx: &App| {
            field(
                "insights-replace-old",
                "Old",
                value(
                    short_id(&old),
                    note.map(|n| ("insights-replace-old-note", n.to_owned())),
                    cx,
                ),
                cx,
            )
            .into_any_element()
        };
        match gate {
            Load::Loading => {
                body = body.child(backlog_field(cx)).child(caption(
                    "insights-replace-checking",
                    "Checking…",
                    cx,
                ));
            }
            Load::Failed(e) => {
                retry = true;
                body = body.child(backlog_field(cx));
                tail = tail.child(
                    div()
                        .id("insights-replace-blocked")
                        .test_support()
                        .child(Notice::new(e).tone(Tone::Error)),
                );
            }
            Load::Ready(Gate::Unsupported) => {
                body = body.child(backlog_field(cx));
                tail = tail.child(
                    div()
                        .id("insights-replace-blocked")
                        .test_support()
                        .child(Notice::new("Update Pilot to replace the report chat.")),
                );
            }
            Load::Ready(Gate::AutomationsOff) => {
                retry = true;
                body = body.child(backlog_field(cx));
                tail = tail.child(
                    div().id("insights-replace-blocked").test_support().child(
                        Notice::new("Automations are off. Weekly Insights needs them.")
                            .tone(Tone::Warning),
                    ),
                );
            }
            Load::Ready(Gate::Checked(pf)) => match (pf.state, &pf.frozen) {
                (State::Ready, Some(f)) => {
                    body = body
                        .child(
                            div().id("insights-replace-lead").test_support().child(
                                ui::text(
                                    Text::Body,
                                    "A new report chat takes over this backlog. The old chat's history isn't restored.",
                                )
                                .text_color(cx.theme().muted_foreground),
                            ),
                        )
                        .child(backlog_field(cx))
                        .child(old_field(Some("Kept as a record. Never reused."), cx))
                        .child(self.rules_field(&pf.rules, false, cx))
                        .child(field(
                            "insights-replace-new",
                            "New",
                            value(
                                "New report chat",
                                Some((
                                    "insights-replace-new-note",
                                    "Starts empty. Old access isn't copied.".into(),
                                )),
                                cx,
                            ),
                            cx,
                        ));
                    let when_note = pf.next_at.map(|at| {
                        (
                            "insights-when-note",
                            format!(
                                "First report {} at the earliest. Nothing runs before.",
                                next_words(at)
                            ),
                        )
                    });
                    let thinking = f.enable.thinking.as_ref().map_or_else(
                        || "Default thinking".to_owned(),
                        |t| format!("Thinking: {t}"),
                    );
                    let extra = vec![
                        ("insights-replace-old-id", format!("Old chat ID: {}", f.old)),
                        (
                            "insights-replace-new-id",
                            format!("New chat ID: {}", f.successor),
                        ),
                    ];
                    body = self.confirm_fields(
                        when_note,
                        Some(("insights-model-note", thinking)),
                        extra,
                        &f.enable,
                        body,
                        cx,
                    );
                    confirm = pf.request();
                }
                (State::Replaced, _) => {
                    let (words, tone, on): (String, Tone, bool) = match &successor {
                        None | Some(Load::Loading) => {
                            ("Confirming the new report chat…".into(), Tone::Quiet, false)
                        }
                        Some(Load::Ready(s)) => {
                            open_chat = Some(s.clone());
                            ("Already replaced".into(), Tone::Success, true)
                        }
                        Some(Load::Failed(e)) => {
                            retry = true;
                            (e.to_string(), Tone::Error, false)
                        }
                    };
                    let new = pf
                        .supersession
                        .as_ref()
                        .map(|l| short_id(&l.successor))
                        .unwrap_or_default();
                    body = body
                        .child(field(
                            "insights-field-status",
                            "Status",
                            self.state_value("insights-replace-state", words, tone, on, cx),
                            cx,
                        ))
                        .child(backlog_field(cx))
                        .child(old_field(Some("Kept as a record."), cx))
                        .child(field(
                            "insights-replace-new",
                            "New",
                            value(new, None, cx),
                            cx,
                        ));
                }
                _ => {
                    retry = true;
                    body = body.child(backlog_field(cx)).child(old_field(None, cx));
                    if pf
                        .rules
                        .iter()
                        .any(|r| r.disposition == Disposition::Blocked)
                    {
                        body = body.child(self.rules_field(&pf.rules, true, cx));
                    }
                    let code = pf.reason.clone().unwrap_or_default();
                    if let Model::Ambiguous(ids) = &pf.model {
                        body = body.child(self.model_choice(ids, explicit.clone(), cx));
                    }
                    if !(matches!(pf.model, Model::Ambiguous(_)) && code == "model_ambiguous") {
                        tail = tail.child(
                            div()
                                .id("insights-replace-blocked")
                                .test_support()
                                .child(Notice::new(swap::reason_text(&code)).tone(Tone::Warning)),
                        );
                    }
                }
            },
        }
        if let Some(a) = self
            .attempt(&swap::slot(&old))
            .filter(|a| a.state == model::State::Rejected)
            .filter(|_| self.latest().is_none())
        {
            let reason = a
                .reason
                .as_deref()
                .map_or_else(|| "Local refused it.".into(), swap::refusal_words);
            tail = tail.child(div().id("insights-outcome").test_support().child(
                Notice::new(format!("Last replacement not applied: {reason}")).tone(Tone::Warning),
            ));
        }
        tail = self.notices(tail, "Replacing… Closing doesn't cancel it.");
        let waiting = self.waiting();
        let actions = div()
            .h_flex()
            .items_center()
            .gap_2()
            .child(div().flex_1().h_flex().when(retry, |d| {
                d.child(
                    ui::action("insights-replace-retry", "Check again", Action::Quiet)
                        .disabled(waiting)
                        .on_click(cx.listener(|v, _, _, cx| v.replace_preview(cx))),
                )
            }))
            .child(
                ui::action("insights-replace-back", "Back", Action::Quiet)
                    .disabled(waiting)
                    .on_click(cx.listener(|v, _, _, cx| {
                        v.replace_back(cx);
                    })),
            );
        let actions = match open_chat {
            Some(session) => actions.child(
                ui::action(
                    "insights-replace-open-chat",
                    "Open report chat",
                    Action::Primary,
                )
                .on_click(cx.listener(move |v, _, _, cx| {
                    if v.visible {
                        cx.emit(Event::OpenChat(session.clone()));
                    }
                })),
            ),
            None => actions.child(
                ui::action(
                    "insights-replace-confirm",
                    "Replace report chat",
                    Action::Primary,
                )
                .disabled(confirm.is_none() || waiting)
                .on_click(cx.listener(move |v, _, _, cx| {
                    let Some(r) = confirm.clone() else {
                        return;
                    };
                    let before = v.request;
                    v.send(model::Action::Start(r), cx);
                    if v.request != before {
                        // Consumed by its one explicit send; no late preview replaces it.
                        if let Some(f) = v.enable.as_mut() {
                            f.fresh = false;
                        }
                        if let Some(swap) = v.replace.as_mut() {
                            swap.reads += 1;
                            if let Some(step) = swap.step.as_mut() {
                                step.sent = true;
                                step.generation = swap.reads;
                            }
                        }
                    }
                })),
            ),
        };
        (body, tail.child(actions))
    }

    /// The automations the replacement stops, or the ones that block it.
    fn rules_field(&self, rules: &[swap::Rule], blocked: bool, cx: &App) -> gpui_kit::AnyElement {
        let wanted = if blocked {
            Disposition::Blocked
        } else {
            Disposition::Cancel
        };
        let shown: Vec<&swap::Rule> = rules.iter().filter(|r| r.disposition == wanted).collect();
        let kept = rules
            .iter()
            .filter(|r| r.disposition == Disposition::Keep)
            .count();
        let note = if blocked {
            Some("Running, manual or unverified. Nothing was changed.".to_owned())
        } else if shown.is_empty() && kept == 0 {
            Some("No automation sends to the old chat.".to_owned())
        } else if shown.is_empty() {
            Some(format!(
                "{} {} stopped already and stay{} as history.",
                kept,
                if kept == 1 {
                    "automation"
                } else {
                    "automations"
                },
                if kept == 1 { "s" } else { "" },
            ))
        } else if kept > 0 {
            Some(format!(
                "Cancelled first. {kept} already stopped {} as history.",
                if kept == 1 { "stays" } else { "stay" },
            ))
        } else {
            Some("Cancelled first. Their history stays.".to_owned())
        };
        let lines = div()
            .v_flex()
            .gap_0p5()
            .min_w_0()
            .children(shown.iter().enumerate().map(|(i, r)| {
                div()
                    .id(("insights-replace-rule", i))
                    .test_support()
                    .child(ui::text(Text::Body, SharedString::from(rule_line(r))))
            }));
        let lines = if shown.is_empty() {
            lines.child(ui::text(Text::Body, "Nothing"))
        } else {
            lines
        };
        field(
            "insights-replace-rules",
            if blocked { "Blocks" } else { "Stops" },
            lines.children(note.map(|n| caption("insights-replace-rules-note", n, cx))),
            cx,
        )
        .into_any_element()
    }

    fn state_value(
        &self,
        id: &'static str,
        words: String,
        tone: Tone,
        on: bool,
        cx: &App,
    ) -> impl IntoElement + use<> {
        div()
            .id(id)
            .test_support()
            .h_flex()
            .items_center()
            .gap_2()
            .min_w_0()
            .when(on, |d| {
                d.child(div().size(px(7.)).rounded_full().bg(cx.theme().success))
            })
            .child(
                ui::text(Text::Body, SharedString::from(words)).text_color(if on {
                    cx.theme().foreground
                } else {
                    tone.color(cx)
                }),
            )
    }

    /// What the passive status says about a retained replacement, in words.
    fn replace_words(&self, a: &model::Attempt) -> (String, Tone, bool, bool, Option<u64>) {
        let status = self
            .replace
            .as_ref()
            .and_then(|s| s.status.clone())
            .filter(|(id, state, _)| id == &a.operation.operation_id && *state == a.state)
            .map(|(_, _, s)| s);
        let accepted = a.state == model::State::Accepted;
        let step_words = |p: &Phase| match p {
            Phase::FencePending | Phase::Fenced => "Retiring the old report chat…",
            Phase::CancelPending | Phase::RulesFenced => "Stopping old automations…",
            Phase::ChatPending => "Creating the new report chat…",
            Phase::ChatReady | Phase::SchedulePending | Phase::Replaced => {
                "New report chat ready. Scheduling…"
            }
        };
        match &status {
            None | Some(Load::Loading) => ("Checking…".into(), Tone::Quiet, false, false, None),
            Some(Load::Failed(e)) => (e.to_string(), Tone::Error, false, false, None),
            // What Local sees now outranks the receipt's last step marker.
            Some(Load::Ready(s)) => match (s.current, &s.receipt) {
                (Current::Replaced, _) => {
                    ("Replaced".into(), Tone::Success, true, false, s.next_at)
                }
                (Current::NotFound, _) => (
                    "Local has no record of it yet.".into(),
                    Tone::Warning,
                    false,
                    false,
                    None,
                ),
                (Current::Blocked, _) => (
                    swap::reason_text(s.reason.as_deref().unwrap_or_default()).into(),
                    Tone::Warning,
                    false,
                    accepted,
                    None,
                ),
                (Current::Unknown, _) if s.reason.is_some() => (
                    swap::reason_text(s.reason.as_deref().unwrap_or_default()).into(),
                    Tone::Warning,
                    false,
                    false,
                    None,
                ),
                (_, Receipt::Pending(Some(p))) => {
                    (step_words(p).into(), Tone::Quiet, false, false, None)
                }
                (_, Receipt::Pending(None)) => {
                    ("Still applying.".into(), Tone::Quiet, false, false, None)
                }
                (Current::Partial, _) => (
                    swap::reason_text(
                        s.reason
                            .as_deref()
                            .unwrap_or("replacement_incomplete_use_retained_receipt"),
                    )
                    .into(),
                    Tone::Warning,
                    false,
                    accepted,
                    None,
                ),
                _ => ("Not confirmed.".into(), Tone::Warning, false, false, None),
            },
        }
    }
    /// A retained replacement: unconfirmed, applying or settled, from its passive status.
    pub(super) fn render_replace_progress(
        &mut self,
        a: &model::Attempt,
        cx: &mut Context<Self>,
    ) -> (gpui_kit::Div, gpui_kit::Div) {
        let ids = swap::identities(&a.operation);
        let (model_id, _, recurrence) = swap::frozen_enable(&a.operation).unwrap_or_default();
        let model_name = self
            .model_name()
            .filter(|_| self.model.as_deref() == Some(model_id.as_str()));
        let accepted = a.state == model::State::Accepted;
        let (text, tone, on, again, next) = self.replace_words(a);
        let title = match (&self.enable, identities_backlog(a)) {
            (Some(f), Some(b)) => shorten(&f.title(&b), 80),
            _ => "Linked mission".into(),
        };
        let when = recurrence.map(|r| crate::recurring_schedules::schedule(&r, ""));
        let body = div()
            .v_flex()
            .gap_3()
            .min_w_0()
            .child(field(
                "insights-field-status",
                "Status",
                self.state_value("insights-replace-state", text, tone, on, cx),
                cx,
            ))
            .child(field(
                "insights-field-backlog",
                "Backlog",
                value(title, None, cx),
                cx,
            ))
            .children(ids.as_ref().map(|i| {
                field(
                    "insights-replace-old",
                    "Old",
                    value(short_id(&i.old), None, cx),
                    cx,
                )
            }))
            .child(field(
                "insights-replace-new",
                "New",
                value(short_id(&a.operation.target_id), None, cx),
                cx,
            ))
            .children(when.map(|w| {
                field(
                    "insights-field-when",
                    "When",
                    value(
                        w,
                        next.map(|at| ("insights-when-note", format!("Next {}", next_words(at)))),
                        cx,
                    ),
                    cx,
                )
            }))
            .child(field(
                "insights-field-model",
                "Model",
                value(shorten(&model_name.unwrap_or(model_id), 60), None, cx),
                cx,
            ));
        let mut tail = div().v_flex().gap_3().w_full().min_w_0();
        tail = tail.children(self.check_row(cx));
        tail = self.notices(tail, "Replacing… Closing doesn't cancel it.");
        let session = a.operation.target_id.clone();
        let actions = div()
            .h_flex()
            .items_center()
            .gap_2()
            .child(
                div()
                    .flex_1()
                    .h_flex()
                    .gap_2()
                    .when(again, |d| {
                        d.child(
                            ui::action("insights-enable-again", "Set up again…", Action::Quiet)
                                .disabled(self.waiting())
                                .on_click(cx.listener(|v, _, _, cx| v.set_up_again(cx))),
                        )
                    })
                    .when(accepted && !on && !again, |d| {
                        d.child(
                            ui::action("insights-enable-recheck", "Check again", Action::Quiet)
                                .on_click(cx.listener(|v, _, _, cx| v.replace_status_again(cx))),
                        )
                    }),
            )
            .child(self.close_button(
                "Close",
                if accepted && on {
                    Action::Quiet
                } else {
                    Action::Primary
                },
                cx,
            ))
            .when(accepted && on, |d| {
                d.child(
                    ui::action(
                        "insights-replace-open-chat",
                        "Open report chat",
                        Action::Primary,
                    )
                    .on_click(cx.listener(move |v, _, _, cx| {
                        if v.visible {
                            cx.emit(Event::OpenChat(session.clone()));
                        }
                    })),
                )
            });
        (body, tail.child(actions))
    }
}

/// Hidden probes read the same state the view draws; never compiled into production.
#[cfg(feature = "native-probes")]
impl Panel {
    /// "step", "progress", "settled" or "none", and the words for what is shown.
    pub(crate) fn probe_replace(&self) -> (&'static str, Option<String>) {
        use super::enable::Shown;
        match self.shown() {
            Shown::Step => ("step", None),
            Shown::Replace(a) if a.open() => ("progress", Some(self.replace_words(a).0)),
            Shown::Replace(a) => ("settled", Some(self.replace_words(a).0)),
            Shown::Enable(_) | Shown::Confirm(_) => ("none", None),
        }
    }
    pub(crate) fn probe_replace_preview(&self) -> Option<swap::Preview> {
        match &self.step()?.gate {
            Load::Ready(Gate::Checked(pf)) => Some((**pf).clone()),
            _ => None,
        }
    }
    pub(crate) fn probe_replace_gate(&self) -> Option<&'static str> {
        Some(match &self.step()?.gate {
            Load::Loading => "loading",
            Load::Failed(_) => "failed",
            Load::Ready(Gate::Unsupported) => "unsupported",
            Load::Ready(Gate::AutomationsOff) => "automations-off",
            Load::Ready(Gate::Checked(_)) => "checked",
        })
    }
    /// The report identities a fresh enable check pins for this exact backlog.
    pub(crate) fn probe_known(&self, project: &str, mission: &str) -> Vec<String> {
        self.known_reports(&Backlog {
            project_id: project.into(),
            mission_id: mission.into(),
            title: None,
            report: None,
        })
    }
    pub(crate) fn probe_adopted(&self) -> bool {
        self.step()
            .is_some_and(|s| matches!(s.successor, Some(Load::Ready(_))))
    }
    /// Why a completed link's successor was not adopted, if it was re-read and refused.
    pub(crate) fn probe_successor_refusal(&self) -> Option<String> {
        match &self.step()?.successor {
            Some(Load::Failed(e)) => Some(e.to_string()),
            _ => None,
        }
    }
}
