//! Weekly Insights: one compact confirmation over the host's preflight, then the
//! retained command's passive status. The Enable click sends the preflight payload
//! verbatim through the durable writer; Check reads status and never replays effects.
//! Opening, choosing a backlog and status reads are passive and enable nothing.
use super::*;
use crate::{
    insights_enable::{self as weekly, Backlog, Current, Gate, Model, Phase, Readiness, Receipt},
    local_model::Project,
};
use gpui_kit::component::Sizable as _;

/// What the Weekly Insights panel shows now.
pub(super) enum Shown<'a> {
    Enable(&'a model::Attempt),
    Replace(&'a model::Attempt),
    /// The replacement step opened over the unavailable-report blocker.
    Step,
    /// The enable confirmation, with the last rejected attempt if any.
    Confirm(Option<&'a model::Attempt>),
}

pub(crate) struct Flow {
    /// The trusted report chat's backlog. Fixed: no selector is offered over it.
    binding: Option<Backlog>,
    /// Active missions on this Local, for titles and the choice without a binding.
    choices: Load<Arc<Vec<Backlog>>>,
    choices_read: Option<Task<()>>,
    pub(super) chosen: Option<Backlog>,
    /// The user's exact model choice when the host found several Terra 6.1 IDs.
    explicit: Option<String>,
    /// Only the newest preflight lands; a send bumps it so nothing late replaces it.
    generation: u64,
    gate: Option<Load<Gate>>,
    checking: Option<Task<()>>,
    /// Status of the retained command, keyed by its operation ID and saved state.
    status: Option<(String, model::State, Load<weekly::Status>)>,
    status_read: Option<Task<()>>,
    /// Bumped by every status read; only the newest read's reply lands.
    status_seq: u64,
    /// The panel request whose settled reply last forced a fresh status read.
    refreshed: u64,
    /// The user chose to set up again over a settled, no longer enabled command.
    pub(super) fresh: bool,
    details: bool,
    projects: Arc<Vec<Project>>,
    models_for: Option<String>,
    /// Report chats' exact bindings: (project, mission, report chat).
    reports: Vec<(String, String, String)>,
    /// The known report identities the latest preflight was pinned with.
    known: Vec<String>,
}
impl Flow {
    pub(super) fn new(reports: Vec<(String, String, String)>) -> Self {
        let mut backlogs: Vec<(&str, &str)> = reports
            .iter()
            .map(|(p, m, _)| (p.as_str(), m.as_str()))
            .collect();
        backlogs.sort();
        backlogs.dedup();
        let binding = match backlogs.as_slice() {
            [(project, mission)] => Some(Backlog {
                project_id: (*project).to_owned(),
                mission_id: (*mission).to_owned(),
                title: None,
                report: None,
            }),
            _ => None,
        };
        let mut flow = Self {
            chosen: None,
            binding: None,
            choices: Load::Loading,
            choices_read: None,
            explicit: None,
            generation: 0,
            gate: None,
            checking: None,
            status: None,
            status_read: None,
            status_seq: 0,
            refreshed: 0,
            fresh: false,
            details: false,
            projects: Arc::new(Vec::new()),
            models_for: None,
            reports,
            known: Vec::new(),
        };
        flow.binding = binding;
        flow.chosen = flow.binding.clone();
        flow
    }
    pub(super) fn freeze(&mut self) {
        self.generation += 1;
        self.checking = None;
    }
    pub(super) fn title(&self, b: &Backlog) -> String {
        match &self.choices {
            Load::Ready(all) => all.iter().find(|c| c.same(b)).and_then(|c| c.title.clone()),
            _ => None,
        }
        .or_else(|| b.title.clone())
        .unwrap_or_else(|| "Linked mission".into())
    }
    fn project(&self, id: &str) -> Option<&Project> {
        self.projects.iter().find(|p| p.id == id)
    }
}

/// The retained command's backlog, from its own frozen bytes.
pub(super) fn attempt_backlog(a: &model::Attempt) -> Option<Backlog> {
    let p: serde_json::Value = serde_json::from_str(&a.operation.payload).ok()?;
    Some(Backlog {
        project_id: p["projectId"].as_str()?.to_owned(),
        mission_id: p["missionId"].as_str()?.to_owned(),
        title: None,
        report: None,
    })
}
fn attempt_frozen(
    a: &model::Attempt,
) -> Option<(String, Option<crate::scheduled_messages::Recurrence>)> {
    let p: serde_json::Value = serde_json::from_str(&a.operation.payload).ok()?;
    Some((
        p["model"].as_str()?.to_owned(),
        serde_json::from_value(p["recurrence"].clone()).ok(),
    ))
}
pub(super) fn next_words(at: u64) -> String {
    crate::scheduled_messages::words(
        at,
        crate::usage_overview::now(),
        crate::subscription_pause::local_offset,
    )
}
fn budget_words(usd: f64) -> String {
    if usd.fract() == 0. {
        format!("About ${usd:.0} per report")
    } else {
        format!("About ${usd:.2} per report")
    }
}
pub(super) fn caption<T: Into<SharedString>>(
    id: &'static str,
    text: T,
    cx: &App,
) -> impl IntoElement + use<T> {
    div()
        .id(id)
        .test_support()
        .child(ui::text(Text::Caption, text.into()).text_color(cx.theme().muted_foreground))
}
pub(super) fn value(
    text: impl Into<SharedString>,
    note: Option<(&'static str, String)>,
    cx: &App,
) -> gpui_kit::Div {
    div()
        .v_flex()
        .gap_0p5()
        .min_w_0()
        .child(ui::text(Text::Body, text.into()))
        .children(note.map(|(id, n)| caption(id, n, cx)))
}

impl Panel {
    /// Project names and paths for display; never a destination.
    pub(crate) fn enable_projects(&mut self, projects: Arc<Vec<Project>>, cx: &mut Context<Self>) {
        self.review_projects(projects.clone(), cx);
        let Some(flow) = self.enable.as_mut() else {
            return;
        };
        flow.projects = projects;
        self.enable_models(cx);
        cx.notify();
    }
    /// The mission whose backlog this panel shows, for navigation after success.
    pub(crate) fn enable_mission(&self) -> Option<String> {
        let shown = match self.shown() {
            Shown::Enable(a) => attempt_backlog(a),
            Shown::Replace(a) => {
                crate::insights_replace::identities(&a.operation).map(|i| Backlog {
                    project_id: i.project_id,
                    mission_id: i.mission_id,
                    title: None,
                    report: None,
                })
            }
            Shown::Step | Shown::Confirm(_) => None,
        };
        shown
            .or_else(|| self.enable_attempt().and_then(attempt_backlog))
            .or_else(|| self.enable.as_ref()?.chosen.clone())
            .map(|b| b.mission_id)
    }
    /// Which retained command or step the panel shows: the newest unconfirmed command, then
    /// the replacement step the user opened, then a settled command, else the confirmation.
    pub(super) fn shown(&self) -> Shown<'_> {
        let enable = self.enable_attempt();
        let replace = self.replace_attempt();
        let fresh = self.enable.as_ref().is_some_and(|f| f.fresh);
        let newer =
            |r: &model::Attempt| enable.is_none_or(|a| a.operation.sequence < r.operation.sequence);
        match (enable, replace) {
            (_, Some(r)) if r.open() && (newer(r) || enable.is_some_and(|a| !a.open())) => {
                return Shown::Replace(r);
            }
            (Some(a), _) if a.open() => return Shown::Enable(a),
            _ => {}
        }
        if self.replace_stepping() {
            return Shown::Step;
        }
        match (enable, replace) {
            (_, Some(r)) if r.state == model::State::Accepted && !fresh && newer(r) => {
                Shown::Replace(r)
            }
            (Some(a), _) if a.state == model::State::Accepted && !fresh => Shown::Enable(a),
            (a, _) => Shown::Confirm(a.filter(|a| a.state == model::State::Rejected)),
        }
    }
    /// The retained command this panel follows: an unconfirmed one first, else the
    /// latest for the chosen backlog, else the latest settled one.
    pub(super) fn enable_attempt(&self) -> Option<&model::Attempt> {
        let book = self.book.as_ref()?;
        let all = || {
            book.insights
                .values()
                .filter(|a| a.operation.kind == weekly::KIND)
        };
        if let Some(open) = all()
            .filter(|a| a.open())
            .max_by_key(|a| a.operation.sequence)
        {
            return Some(open);
        }
        let chosen = self.enable.as_ref()?.chosen.clone();
        match chosen {
            Some(b) => book.insights.get(&b.slot()),
            None => all().max_by_key(|a| a.operation.sequence),
        }
    }

    pub(super) fn enable_refresh(&mut self, cx: &mut Context<Self>) {
        let Some(flow) = self.enable.as_mut() else {
            return;
        };
        if !matches!(flow.choices, Load::Ready(_)) && flow.choices_read.is_none() {
            flow.choices = Load::Loading;
            match weekly::read_backlogs(self.options.clone()) {
                None => flow.choices = Load::Failed("Couldn't read missions.".into()),
                Some(rx) => {
                    flow.choices_read = Some(cx.spawn(async move |view, cx| {
                        let reply = rx.recv().await;
                        let _ = view.update(cx, |v, cx| {
                            let Some(flow) = v.enable.as_mut() else {
                                return;
                            };
                            flow.choices_read = None;
                            flow.choices = match reply {
                                Ok(Ok(all)) => Load::Ready(Arc::new(all)),
                                Ok(Err(e)) => Load::Failed(e.into()),
                                Err(_) => Load::Failed("Couldn't read missions.".into()),
                            };
                            cx.notify();
                        });
                    }));
                }
            }
        }
        if self.enable.as_ref().is_some_and(|f| f.chosen.is_some()) {
            self.enable_preflight(cx);
        }
        self.enable_sync(cx);
        self.replace_refresh(cx);
    }

    /// Every report identity already known for this exact backlog: report chats bound to
    /// it, and this app's non-rejected enable or accepted setup commands for it.
    pub(super) fn known_reports(&self, b: &Backlog) -> Vec<String> {
        let mut ids: Vec<String> = self
            .enable
            .iter()
            .flat_map(|f| f.reports.iter())
            .filter(|(p, m, _)| *p == b.project_id && *m == b.mission_id)
            .map(|(_, _, session)| session.clone())
            .collect();
        for a in self.book.iter().flat_map(|book| book.insights.values()) {
            let retained = match a.operation.kind.as_str() {
                weekly::KIND => a.state != model::State::Rejected,
                "insights-create" => a.state == model::State::Accepted,
                _ => false,
            };
            if retained && attempt_backlog(a).is_some_and(|ab| ab.same(b)) {
                ids.push(a.operation.target_id.clone());
            }
        }
        // A report replaced by exact receipt or adopted completion is pinned by its successor.
        let links = self.supersessions(b);
        for _ in 0..=links.len() {
            let mut moved = false;
            for (old, successor) in &links {
                if let Some(i) = ids.iter().position(|id| id == old) {
                    ids.remove(i);
                    ids.push(successor.clone());
                    moved = true;
                }
            }
            if !moved {
                break;
            }
        }
        ids.sort();
        ids.dedup();
        ids
    }

    fn enable_preflight(&mut self, cx: &mut Context<Self>) {
        if self.waiting() {
            return;
        }
        let options = self.options.clone();
        let Some(mut backlog) = self.enable.as_ref().and_then(|f| f.chosen.clone()) else {
            return;
        };
        let known = self.known_reports(&backlog);
        let Some(flow) = self.enable.as_mut() else {
            return;
        };
        flow.generation += 1;
        let generation = flow.generation;
        flow.checking = None;
        // A known report is pinned; several known reports are never resolved by a guess.
        if known.len() > 1 {
            flow.known = known;
            flow.gate = Some(Load::Failed(
                "More than one report chat is known for this backlog. Nothing new was set up."
                    .into(),
            ));
            cx.notify();
            return;
        }
        flow.known = known.clone();
        backlog.report = known.into_iter().next();
        flow.gate = Some(Load::Loading);
        let Some(rx) = weekly::read_preflight(options, backlog, flow.explicit.clone()) else {
            flow.gate = Some(Load::Failed("Couldn't check Insights setup.".into()));
            return;
        };
        flow.checking = Some(cx.spawn(async move |view, cx| {
            let reply = rx.recv().await;
            let _ = view.update(cx, |v, cx| {
                let Some(flow) = v.enable.as_mut() else {
                    return;
                };
                // Late: a newer choice, a newer check or a sent confirmation owns the view.
                if flow.generation != generation {
                    return;
                }
                flow.checking = None;
                flow.gate = Some(match reply {
                    Ok(Ok(gate)) => Load::Ready(gate),
                    Ok(Err(e)) => Load::Failed(e.into()),
                    Err(_) => Load::Failed("Couldn't check Insights setup.".into()),
                });
                v.enable_models(cx);
                cx.notify();
            });
        }));
        cx.notify();
    }
    /// Display names for the offered model, from its project's scoped catalog.
    fn enable_models(&mut self, cx: &mut Context<Self>) {
        let Some(flow) = self.enable.as_ref() else {
            return;
        };
        let Some(Load::Ready(Gate::Checked(pf))) = &flow.gate else {
            return;
        };
        let (project, model) = (
            pf.project_id.clone(),
            pf.frozen.as_ref().map(|f| f.model.clone()),
        );
        self.display_models(&project, model, cx);
    }
    /// The display name of a confirmed model ID, from its project's scoped catalog.
    pub(super) fn display_models(
        &mut self,
        project: &str,
        model: Option<String>,
        cx: &mut Context<Self>,
    ) {
        if let Some(m) = model {
            self.model = Some(m);
        }
        let Some(flow) = self.enable.as_mut() else {
            return;
        };
        let Some(path) = flow.project(project).map(|p| p.path.clone()) else {
            return;
        };
        if flow.models_for.as_deref() == Some(project) {
            return;
        }
        flow.models_for = Some(project.to_owned());
        self.catalog_path = Some(path);
        self.catalog = Load::Loading;
        self.read_catalog(cx);
    }

    /// Passive status for the retained command: once per saved state, and again after each
    /// settled Check or send, since a pending receipt can stay pending while the resources change.
    pub(super) fn enable_sync(&mut self, cx: &mut Context<Self>) {
        // Retained identities can arrive with the writer's book after the first read.
        if let Some(chosen) = self
            .enable
            .as_ref()
            .filter(|f| f.gate.is_some())
            .and_then(|f| f.chosen.clone())
            && self
                .enable
                .as_ref()
                .is_some_and(|f| f.known != self.known_reports(&chosen))
        {
            self.enable_preflight(cx);
        }
        let Some(attempt) = self.enable_attempt().cloned() else {
            return;
        };
        // This panel's latest command for this slot has a reply: re-read once for it.
        let settled =
            if self.latest().is_some() && self.slot.as_deref() == Some(attempt.slot.as_str()) {
                self.request
            } else {
                0
            };
        let Some(flow) = self.enable.as_mut() else {
            return;
        };
        let key = (attempt.operation.operation_id.clone(), attempt.state);
        let cached = flow
            .status
            .as_ref()
            .is_some_and(|(id, state, _)| (id, *state) == (&key.0, key.1));
        let force = settled > flow.refreshed;
        if force {
            flow.refreshed = settled;
        }
        if cached && !force {
            return;
        }
        if attempt.state == model::State::Rejected {
            // Final. A fresh confirmation needs a fresh offer; this read sends nothing.
            if !cached {
                flow.status = Some((key.0, key.1, Load::Failed("Not applied.".into())));
                self.enable_preflight(cx);
            }
            return;
        }
        self.enable_status(attempt, cx);
    }
    fn enable_status(&mut self, attempt: model::Attempt, cx: &mut Context<Self>) {
        let options = self.options.clone();
        let Some(flow) = self.enable.as_mut() else {
            return;
        };
        let (id, state) = (attempt.operation.operation_id.clone(), attempt.state);
        flow.status_seq += 1;
        let seq = flow.status_seq;
        flow.status = Some((id.clone(), state, Load::Loading));
        let Some(rx) = weekly::read_status(options, attempt.operation) else {
            flow.status = Some((id, state, Load::Failed("Couldn't read status.".into())));
            return;
        };
        flow.status_read = Some(cx.spawn(async move |view, cx| {
            let reply = rx.recv().await;
            let _ = view.update(cx, |v, cx| {
                let Some(flow) = v.enable.as_mut() else {
                    return;
                };
                // Late: a newer read, or another command or saved state, owns the view.
                if flow.status_seq != seq
                    || flow
                        .status
                        .as_ref()
                        .is_none_or(|(i, s, _)| (i, *s) != (&id, state))
                {
                    return;
                }
                flow.status_read = None;
                flow.status = Some((
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
    fn enable_status_again(&mut self, cx: &mut Context<Self>) {
        if let Some(a) = self.enable_attempt().cloned() {
            self.enable_status(a, cx);
        }
    }

    fn choose_backlog(&mut self, backlog: Backlog, cx: &mut Context<Self>) {
        let Some(flow) = self.enable.as_mut() else {
            return;
        };
        if self.slot.is_some() && self.reply.as_ref().is_some_and(|r| r.outcome.is_none()) {
            return;
        }
        if flow.binding.is_some() || flow.chosen.as_ref().is_some_and(|c| c.same(&backlog)) {
            return;
        }
        flow.chosen = Some(backlog);
        flow.explicit = None;
        flow.status = None;
        self.error = None;
        self.enable_preflight(cx);
        self.enable_sync(cx);
    }
    fn choose_model(&mut self, id: String, cx: &mut Context<Self>) {
        if self.replace_stepping() {
            self.replace_choose_model(id, cx);
            return;
        }
        let Some(flow) = self.enable.as_mut() else {
            return;
        };
        flow.explicit = Some(id);
        self.enable_preflight(cx);
    }
    pub(super) fn set_up_again(&mut self, cx: &mut Context<Self>) {
        let backlog = match self.shown() {
            Shown::Replace(a) => {
                crate::insights_replace::identities(&a.operation).map(|i| Backlog {
                    project_id: i.project_id,
                    mission_id: i.mission_id,
                    title: None,
                    report: None,
                })
            }
            _ => self.enable_attempt().and_then(attempt_backlog),
        };
        let Some(flow) = self.enable.as_mut() else {
            return;
        };
        flow.fresh = true;
        if flow.chosen.is_none() {
            flow.chosen = backlog;
        }
        self.enable_preflight(cx);
    }

    pub(super) fn enable_probe_ready(&self) -> bool {
        let Some(flow) = &self.enable else {
            return true;
        };
        let status = flow
            .status
            .as_ref()
            .is_none_or(|(_, _, s)| !matches!(s, Load::Loading));
        let models = self.catalog_path.is_none() || !matches!(self.catalog, Load::Loading);
        !matches!(flow.choices, Load::Loading)
            && !matches!(flow.gate, Some(Load::Loading))
            && status
            && models
            && self.replace_probe_ready()
    }

    /// The report chat's settings row: its weekly state from this app's retained command.
    pub(super) fn weekly_field(
        &self,
        session: &str,
        cx: &mut Context<Self>,
    ) -> impl IntoElement + use<> {
        let attempt = self.book.as_ref().and_then(|b| {
            b.insights
                .values()
                .filter(|a| {
                    matches!(
                        a.operation.kind.as_str(),
                        weekly::KIND | crate::insights_replace::KIND
                    ) && a.operation.target_id == session
                })
                .max_by_key(|a| a.operation.sequence)
        });
        let (state, label) = match attempt.map(|a| a.state) {
            Some(model::State::Accepted) => (Some("Scheduled"), "Details…"),
            Some(model::State::Unknown | model::State::Pending) => {
                (Some("Not confirmed"), "Check…")
            }
            _ => (None, "Set up…"),
        };
        let session = session.to_owned();
        div()
            .h_flex()
            .items_center()
            .gap_2()
            .min_w_0()
            .children(state.map(|s| {
                div()
                    .id("insights-weekly-state")
                    .test_support()
                    .child(ui::text(Text::Body, s))
            }))
            .child(
                ui::action("insights-weekly", label, Action::Quiet)
                    .small()
                    .accessibility_label("Weekly Insights")
                    .on_click(cx.listener(move |v, _, _, cx| {
                        if v.visible && !v.waiting() {
                            cx.emit(Event::EnableWeekly(session.clone()));
                        }
                    })),
            )
    }

    pub(super) fn render_enable(
        &mut self,
        cx: &mut Context<Self>,
    ) -> (gpui_kit::Div, gpui_kit::Div) {
        match self.shown() {
            Shown::Enable(a) => {
                let a = a.clone();
                self.render_progress(&a, cx)
            }
            Shown::Replace(a) => {
                let a = a.clone();
                self.render_replace_progress(&a, cx)
            }
            Shown::Step => self.render_replace(cx),
            Shown::Confirm(rejected) => {
                let rejected = rejected.cloned();
                self.render_confirm(rejected, cx)
            }
        }
    }

    fn backlog_field(&self, cx: &mut Context<Self>) -> gpui_kit::AnyElement {
        let Some(flow) = &self.enable else {
            return div().into_any_element();
        };
        // An offer that reuses the report chat says so beside its backlog.
        let reuses = matches!(&flow.gate, Some(Load::Ready(Gate::Checked(pf))) if pf.frozen.as_ref().is_some_and(|f| f.chat.is_some()));
        let note_id = if reuses {
            "insights-enable-reuse"
        } else {
            "insights-backlog-project"
        };
        let project_name = |b: &Backlog| {
            let name = flow
                .project(&b.project_id)
                .map_or_else(|| "Project unavailable".to_owned(), |p| p.name.clone());
            if reuses {
                format!("{name} · existing report chat")
            } else {
                name
            }
        };
        if flow.binding.is_some() || self.waiting() {
            let Some(b) = flow.chosen.as_ref() else {
                return div().into_any_element();
            };
            return field(
                "insights-field-backlog",
                "Backlog",
                value(
                    shorten(&flow.title(b), 80),
                    Some((note_id, project_name(b))),
                    cx,
                ),
                cx,
            )
            .into_any_element();
        }
        // No trusted report-chat binding: choose an exact active mission here.
        let picker = match &flow.choices {
            Load::Loading => ui::text(Text::Caption, "Reading missions…").into_any_element(),
            Load::Failed(e) => Notice::new(e.clone()).tone(Tone::Error).into_any_element(),
            Load::Ready(all) if all.is_empty() => div()
                .id("insights-backlog-none")
                .test_support()
                .child(
                    Notice::new("No active mission to hold findings. Create one first.")
                        .tone(Tone::Warning),
                )
                .into_any_element(),
            Load::Ready(all) => {
                let label = flow.chosen.as_ref().map_or_else(
                    || "Choose a mission".to_owned(),
                    |b| shorten(&flow.title(b), 40),
                );
                let weak = cx.weak_entity();
                let options: Vec<(Backlog, String)> = all
                    .iter()
                    .map(|b| {
                        (
                            b.clone(),
                            format!("{} · {}", shorten(&flow.title(b), 60), project_name(b)),
                        )
                    })
                    .collect();
                ui::action(
                    "insights-enable-backlog",
                    SharedString::from(label.clone()),
                    Action::Secondary,
                )
                .accessibility_label(SharedString::from(format!("Backlog: {label}")))
                .dropdown_caret(true)
                .dropdown_menu(move |mut menu, _, _| {
                    for (b, text) in options.iter() {
                        let (weak, b) = (weak.clone(), b.clone());
                        menu = menu.item(
                            PopupMenuItem::new(SharedString::from(text.clone())).on_click(
                                move |_, w, cx| {
                                    let _ = weak.update(cx, |v, cx| {
                                        v.choose_backlog(b.clone(), cx);
                                        // Keep Escape and Tab inside the dialog after the menu closes.
                                        v.focus.focus(w, cx);
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
        let note = flow.chosen.as_ref().map(|b| (note_id, project_name(b)));
        field(
            "insights-field-backlog",
            "Backlog",
            div()
                .v_flex()
                .gap_0p5()
                .min_w_0()
                .child(div().h_flex().child(picker))
                .children(note.map(|(id, n)| caption(id, n, cx))),
            cx,
        )
        .into_any_element()
    }

    fn render_confirm(
        &mut self,
        rejected: Option<model::Attempt>,
        cx: &mut Context<Self>,
    ) -> (gpui_kit::Div, gpui_kit::Div) {
        let mut body = div()
            .v_flex()
            .gap_3()
            .min_w_0()
            .child(self.backlog_field(cx));
        let mut tail = div().v_flex().gap_3().w_full().min_w_0();
        let gate = self.enable.as_ref().and_then(|f| f.gate.clone());
        let mut confirm: Option<model::Request> = None;
        let mut retry = false;
        // The exact backlog and its one pinned report, when Local refused it as unavailable.
        let mut replace: Option<Backlog> = None;
        match gate {
            None => {}
            Some(Load::Loading) => {
                body = body.child(caption("insights-enable-checking", "Checking…", cx));
            }
            Some(Load::Failed(e)) => {
                retry = true;
                tail = tail.child(
                    div()
                        .id("insights-enable-blocked")
                        .test_support()
                        .child(Notice::new(e).tone(Tone::Error)),
                );
            }
            Some(Load::Ready(Gate::Unsupported)) => {
                tail = tail.child(
                    div()
                        .id("insights-enable-blocked")
                        .test_support()
                        .child(Notice::new("Update Pilot to enable weekly Insights.")),
                );
            }
            Some(Load::Ready(Gate::AutomationsOff)) => {
                tail = tail.child(
                    div()
                        .id("insights-enable-blocked")
                        .test_support()
                        .h_flex()
                        .items_center()
                        .gap_2()
                        .px_2()
                        .py_1()
                        .rounded(px(crate::appearance::Radius::CONTROL))
                        .bg(cx.theme().warning.opacity(0.12))
                        .child(
                            div().flex_1().min_w_0().child(
                                ui::text(
                                    Text::Caption,
                                    "Automations are off. Weekly Insights needs them.",
                                )
                                .text_color(Tone::Warning.color(cx)),
                            ),
                        )
                        .child(
                            ui::action("insights-enable-settings", "Open Settings", Action::Quiet)
                                .on_click(cx.listener(|v, _, _, cx| {
                                    if v.visible {
                                        cx.emit(Event::OpenAutomationSettings);
                                    }
                                })),
                        ),
                );
                retry = true;
            }
            Some(Load::Ready(Gate::Checked(pf))) => {
                if let (Some(f), true) = (&pf.frozen, pf.readiness != Readiness::Blocked) {
                    let when_note = if f.reuses_schedule {
                        Some((
                            "insights-when-note",
                            "Keeps its existing weekly automation.".to_owned(),
                        ))
                    } else {
                        pf.next_at.map(|at| {
                            (
                                "insights-when-note",
                                format!("First report {}", next_words(at)),
                            )
                        })
                    };
                    let model_note = f
                        .chat
                        .as_ref()
                        .map(|_| ("insights-model-note", "The report chat's model.".to_owned()));
                    body = self.confirm_fields(when_note, model_note, Vec::new(), f, body, cx);
                    confirm = pf.request();
                } else {
                    if let Model::Ambiguous(ids) = &pf.model {
                        let chosen = self.enable.as_ref().and_then(|f| f.explicit.clone());
                        body = body.child(self.model_choice(ids, chosen, cx));
                    }
                    let code = pf.reason.clone().unwrap_or_default();
                    replace = self.replaceable(&pf);
                    if !(matches!(pf.model, Model::Ambiguous(_)) && code == "model_ambiguous") {
                        retry = true;
                        tail =
                            tail.child(div().id("insights-enable-blocked").test_support().child(
                                Notice::new(weekly::reason_text(&code)).tone(Tone::Warning),
                            ));
                    }
                }
            }
        }
        if let Some(a) = rejected.filter(|_| self.latest().is_none()) {
            let reason = a.reason.unwrap_or_else(|| "Local refused it.".into());
            tail = tail.child(div().id("insights-outcome").test_support().child(
                Notice::new(format!("Last attempt not applied: {reason}")).tone(Tone::Warning),
            ));
        }
        tail = self.notices(tail, "Enabling… Closing doesn't cancel it.");
        let enabled = confirm.is_some() && !self.waiting();
        let actions = div()
            .h_flex()
            .items_center()
            .gap_2()
            .child(div().flex_1().h_flex().when(retry, |d| {
                d.child(
                    ui::action("insights-enable-retry", "Check again", Action::Quiet)
                        .disabled(self.waiting())
                        .on_click(cx.listener(|v, _, _, cx| v.enable_preflight(cx))),
                )
            }))
            .child(self.close_button("Cancel", Action::Quiet, cx));
        // Replacement is the one way forward from an unavailable report; Enable stays inert.
        let actions = match replace {
            Some(backlog) => actions.child(
                ui::action(
                    "insights-replace-open",
                    "Replace report chat…",
                    Action::Primary,
                )
                .disabled(self.waiting())
                .on_click(cx.listener(move |v, _, _, cx| {
                    v.replace_open(backlog.clone(), cx);
                })),
            ),
            None => actions.child(
                ui::action("insights-enable-confirm", "Enable", Action::Primary)
                    .disabled(!enabled)
                    .on_click(cx.listener(move |v, _, _, cx| {
                        if let Some(r) = confirm.clone() {
                            v.send(model::Action::Start(r), cx);
                        }
                    })),
            ),
        };
        (body, tail.child(actions))
    }

    /// The unavailable or superseded pinned report this Local can replace: exactly one known
    /// identity for this backlog, in the host's report form. Never a guess or a substitute.
    fn replaceable(&self, pf: &weekly::Preflight) -> Option<Backlog> {
        let flow = self.enable.as_ref()?;
        let chosen = flow.chosen.as_ref()?;
        let [old] = flow.known.as_slice() else {
            return None;
        };
        let code = pf.reason.as_deref()?;
        (pf.replaceable
            && matches!(
                code,
                "report_identity_unavailable" | "report_superseded_use_replacement_status"
            )
            && chosen.project_id == pf.project_id
            && chosen.mission_id == pf.mission_id
            && pf.target_id == *old
            && crate::insights_replace::uuid(old))
        .then(|| Backlog {
            report: Some(old.clone()),
            ..chosen.clone()
        })
    }

    pub(super) fn model_choice(
        &self,
        ids: &[String],
        chosen: Option<String>,
        cx: &mut Context<Self>,
    ) -> gpui_kit::AnyElement {
        let weak = cx.weak_entity();
        let ids: Vec<String> = ids.to_vec();
        let label = chosen.clone().unwrap_or_else(|| "Choose Terra 6.1".into());
        field(
            "insights-field-model",
            "Model",
            div()
                .v_flex()
                .gap_0p5()
                .min_w_0()
                .child(
                    div().h_flex().child(
                        ui::action(
                            "insights-enable-model",
                            SharedString::from(shorten(&label, 40)),
                            Action::Secondary,
                        )
                        .accessibility_label(SharedString::from(format!("Model: {label}")))
                        .dropdown_caret(true)
                        .disabled(self.waiting())
                        .dropdown_menu(move |mut menu, _, _| {
                            for id in ids.iter() {
                                let (weak, id) = (weak.clone(), id.clone());
                                menu = menu.item(
                                    PopupMenuItem::new(SharedString::from(id.clone())).on_click(
                                        move |_, w, cx| {
                                            let _ = weak.update(cx, |v, cx| {
                                                v.choose_model(id.clone(), cx);
                                                v.focus.focus(w, cx);
                                            });
                                        },
                                    ),
                                );
                            }
                            menu
                        }),
                    ),
                )
                .child(caption(
                    "insights-model-ambiguous",
                    "Several models are named Terra 6.1.",
                    cx,
                )),
            cx,
        )
        .into_any_element()
    }

    /// When, Model, Reads and Budget of a frozen weekly command; `extra` adds detail lines.
    pub(super) fn confirm_fields(
        &mut self,
        when_note: Option<(&'static str, String)>,
        model_note: Option<(&'static str, String)>,
        extra: Vec<(&'static str, String)>,
        f: &weekly::Frozen,
        body: gpui_kit::Div,
        cx: &mut Context<Self>,
    ) -> gpui_kit::Div {
        let model_name = self.model_name().unwrap_or_else(|| f.model.clone());
        let details = self.enable.as_ref().is_some_and(|fl| fl.details);
        let reads_toggle = div()
            .id("insights-enable-details")
            .test_support()
            .h_flex()
            .items_center()
            .gap_1()
            .cursor_pointer()
            .child(ui::text(
                Text::Body,
                "Chat excerpts, all projects incl. archived",
            ))
            .child(ui::disclosure_chevron("insights-enable-details", details))
            .on_click(cx.listener(|v, _, _, cx| {
                if let Some(f) = v.enable.as_mut() {
                    f.details = !f.details;
                    cx.notify();
                }
            }));
        let (inventory, history, entries) = f.bounds;
        let reads = div()
            .v_flex()
            .gap_0p5()
            .min_w_0()
            .child(reads_toggle)
            .child(caption(
                "insights-enable-provider",
                format!("Sent to {model_name}'s provider. Redaction isn't a guarantee."),
                cx,
            ))
            .when(details, |d| {
                d.child(caption("insights-enable-readonly", "Read-only. Writes only its reports and findings.", cx))
                    .child(caption(
                        "insights-enable-sample",
                        format!(
                            "Partial sample: {inventory} chat list page, {history} history pages, {entries} entries each."
                        ),
                        cx,
                    ))
                    .child(caption("insights-enable-model-id", format!("Model ID: {}", f.model), cx))
                    .children(extra.into_iter().map(|(id, line)| caption(id, line, cx)))
            });
        body.child(field(
            "insights-field-when",
            "When",
            value(
                crate::recurring_schedules::schedule(&f.recurrence, ""),
                when_note,
                cx,
            ),
            cx,
        ))
        .child(field(
            "insights-field-model",
            "Model",
            value(shorten(&model_name, 60), model_note, cx),
            cx,
        ))
        .child(field("insights-field-reads", "Reads", reads, cx))
        .child(field(
            "insights-field-budget",
            "Budget",
            value(
                budget_words(f.budget_usd),
                Some((
                    "insights-budget-note",
                    "Advisory, not a cap. Spend isn't tracked yet.".into(),
                )),
                cx,
            ),
            cx,
        ))
    }

    /// What the passive status says about a retained command, in words.
    fn progress(&self, a: &model::Attempt) -> Progress {
        let status = self
            .enable
            .as_ref()
            .and_then(|f| f.status.clone())
            .filter(|(id, state, _)| id == &a.operation.operation_id && *state == a.state)
            .map(|(_, _, s)| s);
        let accepted = a.state == model::State::Accepted;
        let mut on = false;
        let mut again = false;
        let mut next = None;
        let (text, tone): (String, Tone) = match &status {
            None | Some(Load::Loading) => ("Checking…".into(), Tone::Quiet),
            Some(Load::Failed(e)) => (e.to_string(), Tone::Error),
            // What Local sees now outranks the receipt's last step marker, which only
            // says a step was entered.
            Some(Load::Ready(s)) => match (s.current, &s.receipt) {
                (Current::Enabled, _) => {
                    on = true;
                    next = s.next_at;
                    ("On".into(), Tone::Success)
                }
                (Current::NotFound, _) => ("Local has no record of it yet.".into(), Tone::Warning),
                (Current::Blocked, _) => {
                    again = accepted;
                    (
                        weekly::reason_text(s.reason.as_deref().unwrap_or_default()).into(),
                        Tone::Warning,
                    )
                }
                (Current::Partial, _) => {
                    again = accepted;
                    (
                        weekly::reason_text("schedule_unresolved").into(),
                        Tone::Warning,
                    )
                }
                // After deletion Local can't recheck the report at all, so it says Unknown.
                // Only that exact accepted shape leads to a fresh pinned check; other Unknown
                // states keep Check, and the old command is never resent.
                (Current::Unknown, _) if accepted && s.report_missing() => {
                    again = true;
                    (
                        weekly::reason_text("report_identity_unavailable").into(),
                        Tone::Warning,
                    )
                }
                (_, Receipt::Pending(Some(Phase::ChatPending))) => {
                    ("Creating the report chat…".into(), Tone::Quiet)
                }
                (_, Receipt::Pending(Some(Phase::ChatReady | Phase::SchedulePending))) => {
                    ("Report chat ready. Scheduling…".into(), Tone::Quiet)
                }
                (_, Receipt::Pending(_)) => ("Still applying.".into(), Tone::Quiet),
                _ => ("Not confirmed.".into(), Tone::Warning),
            },
        };
        Progress {
            text,
            tone,
            on,
            again,
            next,
        }
    }
    /// A retained command: unconfirmed, applying or settled, from its passive status.
    fn render_progress(
        &mut self,
        a: &model::Attempt,
        cx: &mut Context<Self>,
    ) -> (gpui_kit::Div, gpui_kit::Div) {
        let backlog = attempt_backlog(a);
        let (model_id, recurrence) = attempt_frozen(a).unwrap_or_default();
        let model_name = self
            .model_name()
            .filter(|_| self.model.as_deref() == Some(model_id.as_str()));
        let accepted = a.state == model::State::Accepted;
        let Progress {
            text,
            tone,
            on,
            again,
            next,
        } = self.progress(a);
        let title = match (&self.enable, &backlog) {
            (Some(f), Some(b)) => shorten(&f.title(b), 80),
            _ => "Linked mission".into(),
        };
        let state_value = div()
            .id("insights-enable-state")
            .test_support()
            .h_flex()
            .items_center()
            .gap_2()
            .min_w_0()
            .when(on, |d| {
                d.child(div().size(px(7.)).rounded_full().bg(cx.theme().success))
            })
            .child(
                ui::text(Text::Body, SharedString::from(text)).text_color(if on {
                    cx.theme().foreground
                } else {
                    tone.color(cx)
                }),
            );
        let when = recurrence.map(|r| crate::recurring_schedules::schedule(&r, ""));
        let body = div()
            .v_flex()
            .gap_3()
            .min_w_0()
            .child(field("insights-field-status", "Status", state_value, cx))
            .child(field(
                "insights-field-backlog",
                "Backlog",
                value(title, None, cx),
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
        tail = self.notices(tail, "Enabling… Closing doesn't cancel it.");
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
                                .on_click(cx.listener(|v, _, _, cx| v.enable_status_again(cx))),
                        )
                    })
                    .when(accepted && on, |d| {
                        let session = session.clone();
                        d.child(
                            ui::action("insights-enable-review", "Review settings…", Action::Quiet)
                                .on_click(cx.listener(move |v, _, _, cx| {
                                    if v.visible {
                                        cx.emit(Event::EditReview(session.clone()));
                                    }
                                })),
                        )
                    }),
            )
            .child(self.close_button(
                "Close",
                if accepted {
                    Action::Quiet
                } else {
                    Action::Primary
                },
                cx,
            ))
            .when(accepted, |d| {
                d.child(
                    ui::action("insights-enable-open", "Open report chat", Action::Primary)
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

struct Progress {
    text: String,
    tone: Tone,
    on: bool,
    again: bool,
    next: Option<u64>,
}

/// Hidden probes read the same state the view draws; never compiled into production.
#[cfg(feature = "native-probes")]
impl Panel {
    /// "confirm", "progress" or "settled", and the status words for a retained command.
    pub(crate) fn probe_enable(&self) -> (&'static str, Option<String>) {
        let fresh = self.enable.as_ref().is_some_and(|f| f.fresh);
        match self.enable_attempt() {
            Some(a) if a.open() => ("progress", Some(self.progress(a).text)),
            Some(a) if a.state == model::State::Accepted && !fresh => {
                ("settled", Some(self.progress(a).text))
            }
            _ => ("confirm", None),
        }
    }
    /// The next run the status field shows for the retained command.
    pub(crate) fn probe_enable_next(&self) -> Option<u64> {
        self.progress(self.enable_attempt()?).next
    }
    /// The landed passive status of the retained enable command, if read.
    pub(crate) fn probe_enable_status(&self) -> Option<weekly::Status> {
        let a = self.enable_attempt()?;
        match &self.enable.as_ref()?.status {
            Some((id, state, Load::Ready(s)))
                if id == &a.operation.operation_id && *state == a.state =>
            {
                Some(s.clone())
            }
            _ => None,
        }
    }
    pub(crate) fn probe_preflight(&self) -> Option<weekly::Preflight> {
        match self.enable.as_ref()?.gate.as_ref()? {
            Load::Ready(Gate::Checked(pf)) => Some((**pf).clone()),
            _ => None,
        }
    }
    pub(crate) fn probe_gate(&self) -> Option<&'static str> {
        Some(match self.enable.as_ref()?.gate.as_ref()? {
            Load::Loading => "loading",
            Load::Failed(_) => "failed",
            Load::Ready(Gate::Unsupported) => "unsupported",
            Load::Ready(Gate::AutomationsOff) => "automations-off",
            Load::Ready(Gate::Checked(_)) => "checked",
        })
    }
    pub(crate) fn probe_backlog(&self) -> Option<Backlog> {
        self.enable.as_ref()?.chosen.clone()
    }
}
