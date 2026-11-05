//! Diagnostic repair, mounted above a diagnostics chat's composer. The chat stays
//! read-only: Suggest sends one fixed request through the ordinary composer
//! delivery, Review reads pilotd's validated handoff, and only an explicit Start
//! saves and sends one immutable repair-create. Nothing here reads transcript text.
use super::*;
use crate::{
    chat_models::Catalog,
    diagnostic_repair::{
        self as repair, Action as RepairAction, Attempt, Draft, ModelChoice, Outcome, ProjectState,
        Proposal, Review, SUGGEST_MESSAGE, Specialist, State, Uncertainty,
    },
    ui::{self, Action as Role, Text},
};
use gpui_kit::{
    EntityInputHandler as _, StatefulInteractiveElement as _,
    component::{
        checkbox::Checkbox,
        input::{Input, InputEvent, InputState, Textarea, TextareaState},
        select::{SearchableVec, Select, SelectEvent, SelectItem, SelectState},
    },
};

/// One menu row. Non-searchable menus mount no text input.
#[derive(Clone)]
struct Item {
    id: String,
    label: SharedString,
}
impl SelectItem for Item {
    type Value = String;
    fn value(&self) -> &String {
        &self.id
    }
    fn title(&self) -> SharedString {
        self.label.clone()
    }
    fn render(&self, _: &mut Window, _: &mut App) -> impl IntoElement {
        div()
            .id(SharedString::from(format!("repair-option-{}", self.id)))
            .test_support()
            .min_w_0()
            .truncate()
            .child(self.label.clone())
    }
}
type Menu = Entity<SelectState<SearchableVec<Item>>>;
fn menu(items: Vec<Item>, selected: &str, w: &mut Window, cx: &mut Context<LocalViewer>) -> Menu {
    let selected = selected.to_owned();
    cx.new(|cx| {
        let mut state = SelectState::new(SearchableVec::new(items), None, w, cx);
        state.set_selected_value(&selected, w, cx);
        state
    })
}
/// The default row leads with the effective level when the catalog proves it.
fn thinking_items(
    catalog: &Catalog,
    project_model: Option<&str>,
    choice: &ModelChoice,
) -> Vec<Item> {
    let model = choice.resolve(catalog, project_model);
    let mut items = vec![Item {
        id: String::new(),
        // The repair chat is a fresh Build chat.
        label: crate::chat_models::inherited_thinking(model, crate::chat_models::Start::Fresh)
            .0
            .into(),
    }];
    items.extend(
        model
            .into_iter()
            .flat_map(|m| &m.thinking_levels)
            .map(|level| Item {
                id: level.clone(),
                label: crate::chat_models::thinking_title(level).into(),
            }),
    );
    items
}

/// The user's edit of the proposal. Dropped by Revert or when the proposal changes.
struct Edit {
    title: Entity<InputState>,
    findings: Entity<TextareaState>,
    suggestion: Entity<TextareaState>,
    regression: Entity<TextareaState>,
    uncertainty: Menu,
    level: Uncertainty,
    _subscriptions: Vec<Subscription>,
}
impl Edit {
    fn draft(&self, cx: &App) -> Draft {
        Draft {
            title: self.title.read(cx).value().to_string(),
            findings: self.findings.read(cx).value().to_string(),
            uncertainty: self.level,
            suggested_repair: self.suggestion.read(cx).value().to_string(),
            regression: self.regression.read(cx).value().to_string(),
        }
    }
    /// An open IME composition is never captured into a start.
    fn composing(&self, w: &mut Window, cx: &mut App) -> bool {
        self.title
            .update(cx, |i, cx| i.marked_text_range(w, cx).is_some())
            || [&self.findings, &self.suggestion, &self.regression]
                .into_iter()
                .any(|t| t.update(cx, |i, cx| i.marked_text_range(w, cx).is_some()))
    }
}

/// Model and thinking menus over the repair project's scoped catalog.
struct Pick {
    catalog: Arc<Catalog>,
    /// The repair project's Pilot model, which pilotd applies before pi's default.
    project_model: Option<String>,
    model: Menu,
    thinking: Menu,
    _subscriptions: Vec<Subscription>,
}

/// Panel state for the selected diagnostics chat. Reset when another chat opens.
pub(super) struct RepairPanel {
    chat: Option<String>,
    open: bool,
    review: Option<(String, Option<Review>)>,
    setup_error: Option<&'static str>,
    reading: Option<Task<()>>,
    epoch: u64,
    read_diagnostics: bool,
    requested: bool,
    error: Option<&'static str>,
    request: u64,
    reply: Option<repair::Reply>,
    book: Option<Arc<crate::delivery_store::Book>>,
    edit: Option<Edit>,
    pick: Option<Pick>,
    choice: ModelChoice,
    /// Edited text is being reviewed by Local; Start continues when it is accepted.
    start_after: bool,
    /// Hidden probes supply every review themselves.
    #[cfg(feature = "native-probes")]
    probe_reviews: bool,
}
impl Default for RepairPanel {
    fn default() -> Self {
        Self {
            chat: None,
            open: false,
            review: None,
            setup_error: None,
            reading: None,
            epoch: 0,
            read_diagnostics: true,
            requested: false,
            error: None,
            request: 0,
            reply: None,
            book: None,
            edit: None,
            pick: None,
            choice: ModelChoice::default(),
            start_after: false,
            #[cfg(feature = "native-probes")]
            probe_reviews: false,
        }
    }
}
impl RepairPanel {
    /// Adopt the writer's retained starts and latest reply. True when anything changed.
    pub(super) fn accept(&mut self, state: &crate::interaction::WriteState) -> bool {
        let book_changed = match (&self.book, &state.book) {
            (Some(old), Some(new)) => old.repairs != new.repairs,
            (None, None) => false,
            _ => true,
        };
        let changed = book_changed || self.reply != state.repair;
        self.book = state.book.clone();
        self.reply = state.repair.clone();
        changed
    }
    fn reset(&mut self, chat: &str) {
        if self.chat.as_deref() == Some(chat) {
            return;
        }
        let (request, reply, book) = (self.request, self.reply.take(), self.book.take());
        *self = Self {
            chat: Some(chat.into()),
            request,
            reply,
            book,
            ..Self::default()
        };
    }
    fn attempt(&self, chat: &str) -> Option<&Attempt> {
        self.book.as_ref()?.repairs.get(chat)
    }
    /// The writer's reply to this panel's latest command, if it is for this chat.
    fn latest(&self, chat: &str) -> Option<&Option<Outcome>> {
        self.reply
            .as_ref()
            .filter(|r| r.specialist == chat && r.request == self.request && self.request > 0)
            .map(|r| &r.outcome)
    }
    fn busy(&self, chat: &str) -> bool {
        matches!(self.latest(chat), Some(None))
    }
    #[cfg(feature = "native-probes")]
    pub(super) fn probe_book(&mut self, book: crate::delivery_store::Book) {
        self.book = Some(Arc::new(book));
    }
}

/// Words for a start's outcome, beside the action it describes.
fn outcome_words(outcome: &Outcome) -> (String, ui::Tone) {
    match outcome {
        Outcome::Accepted(_) => ("Repair chat started.".into(), ui::Tone::Success),
        Outcome::Pending => (
            "Local is still starting the repair. Check again later; it is never sent as a second repair.".into(),
            ui::Tone::Warning,
        ),
        Outcome::Rejected(reason) => (format!("Repair wasn't started: {reason}"), ui::Tone::Error),
        Outcome::Unknown(message) => ((*message).into(), ui::Tone::Warning),
        Outcome::Refused(message) => ((*message).into(), ui::Tone::Error),
    }
}

/// Problems that make any repair action unavailable, in plain words.
fn identity_problem(
    chat: &Chat,
    specialist: &Specialist,
    options: Option<&LocalOptions>,
) -> Option<&'static str> {
    if specialist.subject.is_none() {
        return Some(
            "This diagnosis predates repair identity. Start a new one from Help to suggest a repair.",
        );
    }
    if specialist.continued || !chat.writable {
        return Some(
            "This diagnostics chat is read-only here. Repairs start from its current chat.",
        );
    }
    if options.is_some_and(|o| !specialist.same_host(o)) {
        return Some(
            "This diagnosis belongs to another host identity. Repairs never switch hosts.",
        );
    }
    None
}

impl LocalViewer {
    fn repair_connected(&self) -> Option<LocalOptions> {
        let connected = self.client.as_ref().is_some_and(|c| {
            matches!(
                c.daemon(),
                crate::local_client::ConnectedDaemon::Connected(_)
            )
        });
        self.usage_options.clone().filter(|_| connected)
    }

    /// The selected diagnostics chat's repair row, or None for other chats.
    pub(super) fn repair_panel(
        &mut self,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<gpui_kit::AnyElement> {
        let chat = self
            .selected
            .as_deref()
            .and_then(|id| self.state.chats.iter().find(|c| c.id == id))
            .filter(|c| !c.archived && !c.local_draft && self.subagent.is_none())?
            .clone();
        let specialist = chat.diagnostic.clone()?;
        self.repair.reset(&chat.id);
        let options = self.repair_connected();
        let problem = identity_problem(&chat, &specialist, self.usage_options.as_ref());
        let attempt = self.repair.attempt(&chat.id).cloned();
        let busy = self.repair.busy(&chat.id);
        let proposal = specialist.proposal().cloned();
        let id = chat.id.clone();
        let row = div()
            .id("diagnostic-repair-row")
            .test_support()
            .h_flex()
            .w_full()
            .min_w_0()
            .items_center()
            .gap_2();
        let caption = |label: String, tone: ui::Tone, cx: &App| {
            ui::text(Text::Caption, label)
                .id("diagnostic-repair-caption")
                .test_support()
                .flex_1()
                .min_w_0()
                .text_color(tone.color(cx))
        };

        // An unconfirmed start outranks everything: it must be checked, never duplicated.
        let row = if let Some(attempt) = attempt.as_ref().filter(|a| a.open()) {
            let words = self
                .repair
                .latest(&id)
                .and_then(Option::as_ref)
                .map(outcome_words)
                .unwrap_or_else(|| outcome_words(&repair::outcome(attempt)));
            row.child(caption(words.0, words.1, cx)).child(
                ui::action(
                    "diagnostic-repair-check",
                    if busy { "Checking…" } else { "Check repair start" },
                    Role::Secondary,
                )
                .tooltip("Look up the saved start. If Local never received it, the same request is sent once. A second repair is never created.")
                .disabled(busy || options.is_none())
                .on_click(cx.listener(move |v, _, _, cx| v.repair_command(RepairAction::Check, cx))),
            )
        } else if let Some(attempt) = attempt.as_ref().filter(|a| {
            a.state == State::Accepted && proposal.as_ref().is_none_or(|p| p.id == a.proposal_id)
        }) {
            let url = format!("pilot://chat/{}", attempt.operation.target_id);
            row.child(caption("Repair chat started.".into(), ui::Tone::Quiet, cx))
                .child(
                    ui::action(
                        "diagnostic-repair-open",
                        "Open repair chat",
                        Role::Secondary,
                    )
                    .on_click(cx.listener(move |v, _, w, cx| v.open_chat_url(&url, w, cx))),
                )
        } else if let Some(proposal) = proposal.clone() {
            let open = self.repair.open;
            row.child(
                div()
                    .v_flex()
                    .flex_1()
                    .min_w_0()
                    // Open, the review shows the full title; the row keeps only its meta.
                    .when(!open, |row| {
                        row.child(
                            ui::text(Text::Body, proposal.title.clone())
                                .id("diagnostic-repair-title")
                                .test_support()
                                .font_semibold()
                                .truncate(),
                        )
                    })
                    .child(
                        ui::text(
                            Text::Caption,
                            problem.map_or_else(
                                || format!("Repair proposal · {}", proposal.uncertainty.label()),
                                str::to_owned,
                            ),
                        )
                        .truncate()
                        .text_color(if problem.is_some() {
                            cx.theme().danger
                        } else {
                            cx.theme().muted_foreground
                        }),
                    ),
            )
            .child(
                ui::action(
                    "diagnostic-repair-review",
                    if open { "Hide review" } else { "Review repair" },
                    if open { Role::Quiet } else { Role::Secondary },
                )
                .tooltip("Read the findings, evidence and repair project before any separate Build chat starts.")
                .disabled(problem.is_some() && !open)
                .on_click(cx.listener(move |v, _, w, cx| v.toggle_repair_review(w, cx))),
            )
        } else {
            let requested = self.repair.requested
                && (chat.busy || self.editor.read(cx).waiting_for(&format!("chat:{id}")));
            let send_problem = self
                .editor
                .read(cx)
                .fixed_send_problem(&format!("chat:{id}"), cx);
            let label = match (&specialist.proposal, problem, requested) {
                (_, Some(problem), _) => Some((problem.to_owned(), ui::Tone::Quiet)),
                (repair::ProposalState::Malformed, ..) => Some((
                    "This repair proposal can't be read. Ask for a new suggestion.".into(),
                    ui::Tone::Warning,
                )),
                (_, _, true) => Some(("Repair suggestion requested.".into(), ui::Tone::Quiet)),
                _ => self.repair.error.map(|e| (e.to_owned(), ui::Tone::Error)),
            };
            row.child(match label {
                Some((label, tone)) => caption(label, tone, cx).into_any_element(),
                None => div().flex_1().into_any_element(),
            })
            .when(problem.is_none() && !requested, |row| {
                row.child(
                    ui::action("diagnostic-repair-suggest", "Suggest a repair", Role::Quiet)
                        .tooltip(send_problem.unwrap_or(
                            "Ask this read-only specialist for a cited repair proposal. This can't start a repair.",
                        ))
                        .disabled(send_problem.is_some() || options.is_none())
                        .on_click(cx.listener(move |v, _, w, cx| v.suggest_repair(w, cx))),
                )
            })
        };
        let body = proposal
            .filter(|_| {
                self.repair.open && problem.is_none() && attempt.as_ref().is_none_or(|a| !a.open())
            })
            .map(|p| self.repair_review(&chat, &specialist, &p, w, cx));
        Some(
            div()
                .id("diagnostic-repair-panel")
                .test_support()
                .v_flex()
                .mx_3()
                .px(px(10.))
                .pb_1()
                .gap_2()
                .min_w_0()
                .aria_label("Diagnostic repair")
                .child(row)
                .children(body)
                .into_any_element(),
        )
    }

    fn suggest_repair(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        let Some(id) = self.repair.chat.clone() else {
            return;
        };
        let sent = self.editor.update(cx, |e, cx| {
            e.send_fixed(&format!("chat:{id}"), SUGGEST_MESSAGE, w, cx)
        });
        self.repair.requested = sent;
        self.repair.error =
            (!sent).then_some("The request wasn't sent. Check the composer and try again.");
        cx.notify();
    }

    fn toggle_repair_review(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        self.repair.open = !self.repair.open;
        if self.repair.open {
            self.repair.review = None;
            self.load_repair_review(None, w, cx);
        } else {
            self.repair.reading = None;
            self.repair.start_after = false;
        }
        cx.notify();
    }

    /// The selected chat's specialist, while it is still a live diagnostics chat.
    fn repair_specialist(&self) -> Option<(String, Arc<Specialist>)> {
        let id = self.repair.chat.clone()?;
        let specialist = self
            .state
            .chats
            .iter()
            .find(|c| c.id == id && !c.archived)?
            .diagnostic
            .clone()?;
        Some((id, specialist))
    }

    /// The reviewed repair project, as last listed.
    fn repair_project(&self) -> Option<&crate::local_model::Project> {
        let (_, Some(review)) = self.repair.review.as_ref()? else {
            return None;
        };
        let ProjectState::Available(b) = &review.project.as_ref().ok()?.state else {
            return None;
        };
        self.state.projects.iter().find(|p| p.id == b.project_id)
    }

    /// The reviewed repair project's Pilot model for new chats, as last listed.
    fn repair_project_model(&self) -> Option<String> {
        self.repair_project()?.model.clone()
    }

    /// pilotd applies the project's model when the repair chat starts, so the default
    /// rows follow a later project edit. An unlisted project or a failed list read
    /// keeps the menus as they are.
    pub(super) fn follow_repair_project_model(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if self.state.projects_error.is_some() {
            return;
        }
        let Some(project) = self.repair_project() else {
            return;
        };
        let project_model = project.model.clone();
        let Some(pick) = &self.repair.pick else {
            return;
        };
        if pick.project_model != project_model {
            let catalog = pick.catalog.clone();
            self.sync_repair_pick(Some(catalog), project_model, w, cx);
            cx.notify();
        }
    }

    /// The text a start would send: the user's edit, or the proposal as published.
    fn repair_draft(&self, proposal: &Proposal, cx: &App) -> Draft {
        self.repair
            .edit
            .as_ref()
            .map_or_else(|| Draft::of(proposal), |e| e.draft(cx))
    }

    /// Reads (and, for an explicit setup choice, first configures) the review material.
    fn load_repair_review(
        &mut self,
        configure: Option<(u64, crate::local_model::Project)>,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some((id, specialist)) = self.repair_specialist() else {
            return;
        };
        let (Some(proposal), Some(subject), Some(options)) = (
            specialist.proposal().cloned(),
            specialist.subject.clone(),
            self.repair_connected(),
        ) else {
            self.repair.setup_error = Some("Connect to Local to review this repair.");
            self.repair.start_after = false;
            return;
        };
        self.repair.epoch += 1;
        let epoch = self.repair.epoch;
        let proposal_id = proposal.id.clone();
        let draft = self.repair_draft(&proposal, cx);
        // Keep the shown review while edited text is checked again.
        if !self.repair.start_after {
            self.repair.review = Some((proposal_id.clone(), None));
        }
        self.repair.setup_error = None;
        #[cfg(feature = "native-probes")]
        if self.repair.probe_reviews {
            return;
        }
        let Some(reply) = repair::start(
            options,
            repair::Job {
                specialist: id,
                proposal,
                draft,
                subject,
                configure,
            },
        ) else {
            self.repair.setup_error = Some("Couldn't start the review. Try again.");
            self.repair.start_after = false;
            return;
        };
        self.repair.reading = Some(cx.spawn_in(w, async move |view, cx| {
            let Ok((review, error)) = reply.recv().await else {
                return;
            };
            let _ = view.update_in(cx, |v, w, cx| {
                if v.repair.epoch == epoch {
                    v.finish_repair_review(proposal_id, review, error, w, cx);
                }
            });
        }));
    }

    fn finish_repair_review(
        &mut self,
        proposal_id: String,
        review: Review,
        error: Option<&'static str>,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let catalog = review
            .models
            .as_ref()
            .and_then(|m| m.as_ref().ok())
            .cloned();
        self.repair.review = Some((proposal_id, Some(review)));
        self.repair.setup_error = error;
        self.repair.reading = None;
        let project_model = self.repair_project_model();
        self.sync_repair_pick(catalog, project_model, w, cx);
        if std::mem::take(&mut self.repair.start_after) {
            self.start_repair(true, w, cx);
        }
        cx.notify();
    }

    /// Hidden probes supply review material instead of reading Local.
    #[cfg(feature = "native-probes")]
    pub(super) fn probe_repair_review(
        &mut self,
        proposal: &str,
        review: Review,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.repair.probe_reviews = true;
        self.repair.epoch += 1;
        self.finish_repair_review(proposal.into(), review, None, w, cx);
    }
    #[cfg(feature = "native-probes")]
    pub(super) fn probe_repair_draft(&self, cx: &App) -> Option<Draft> {
        let (_, specialist) = self.repair_specialist()?;
        Some(self.repair_draft(specialist.proposal()?, cx))
    }
    #[cfg(feature = "native-probes")]
    pub(super) fn probe_repair_inputs(
        &self,
    ) -> Option<(Entity<InputState>, Entity<TextareaState>)> {
        let edit = self.repair.edit.as_ref()?;
        Some((edit.title.clone(), edit.findings.clone()))
    }
    #[cfg(feature = "native-probes")]
    pub(super) fn probe_repair_preparing(&self) -> bool {
        self.repair.start_after
    }

    /// Model menus follow the catalog. A choice it no longer offers falls back to the default.
    fn sync_repair_pick(
        &mut self,
        catalog: Option<Arc<Catalog>>,
        project_model: Option<String>,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(catalog) = catalog else {
            self.repair.pick = None;
            self.repair.choice = ModelChoice::default();
            return;
        };
        if self
            .repair
            .pick
            .as_ref()
            .is_some_and(|p| *p.catalog == *catalog && p.project_model == project_model)
        {
            return;
        }
        if self
            .repair
            .choice
            .problem(Some(&catalog), project_model.as_deref())
            .is_some()
        {
            self.repair.choice = ModelChoice::default();
        }
        // The effective model leads; where it comes from follows.
        let inherited = catalog.inherited(project_model.as_deref());
        let default = inherited
            .model
            .map_or(inherited.origin.label().to_owned(), |m| {
                format!("{} · {}", m.name, inherited.origin.label())
            });
        let mut models = vec![Item {
            id: String::new(),
            label: default.into(),
        }];
        models.extend(catalog.models.iter().map(|m| Item {
            id: m.id.clone(),
            label: m.name.clone().into(),
        }));
        let choice = self.repair.choice.clone();
        let model = menu(models, choice.model.as_deref().unwrap_or(""), w, cx);
        let thinking = menu(
            thinking_items(&catalog, project_model.as_deref(), &choice),
            choice.thinking.as_deref().unwrap_or(""),
            w,
            cx,
        );
        let subscriptions = vec![
            cx.subscribe_in(
                &model,
                w,
                |v, _, event: &SelectEvent<SearchableVec<Item>>, w, cx| {
                    let SelectEvent::Confirm(Some(id)) = event else {
                        return;
                    };
                    let next = (!id.is_empty()).then(|| id.clone());
                    if v.repair.choice.model == next {
                        return;
                    }
                    v.repair.choice = ModelChoice {
                        model: next,
                        thinking: None,
                    };
                    v.repair.error = None;
                    if let Some(pick) = &v.repair.pick {
                        let items = thinking_items(
                            &pick.catalog,
                            pick.project_model.as_deref(),
                            &v.repair.choice,
                        );
                        pick.thinking.update(cx, |s, cx| {
                            s.set_items(SearchableVec::new(items), w, cx);
                            s.set_selected_value(&String::new(), w, cx);
                        });
                    }
                    cx.notify();
                },
            ),
            cx.subscribe_in(
                &thinking,
                w,
                |v, _, event: &SelectEvent<SearchableVec<Item>>, _, cx| {
                    if let SelectEvent::Confirm(Some(level)) = event {
                        v.repair.choice.thinking = (!level.is_empty()).then(|| level.clone());
                        v.repair.error = None;
                        cx.notify();
                    }
                },
            ),
        ];
        self.repair.pick = Some(Pick {
            catalog,
            project_model,
            model,
            thinking,
            _subscriptions: subscriptions,
        });
    }

    /// Opens the proposal for editing. Revert returns to the specialist's text.
    fn edit_repair(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        let Some(proposal) = self
            .repair_specialist()
            .and_then(|(_, s)| s.proposal().cloned())
        else {
            return;
        };
        let draft = Draft::of(&proposal);
        let title = cx.new(|cx| {
            let mut i = InputState::new(w, cx).placeholder("Describe the diagnosed issue");
            i.set_value(draft.title.clone(), w, cx);
            i
        });
        let area =
            |value: &str, placeholder: &'static str, w: &mut Window, cx: &mut Context<Self>| {
                let value = value.to_owned();
                cx.new(|cx| {
                    let mut t = TextareaState::new(w, cx)
                        .placeholder(placeholder)
                        .auto_grow(2, 6);
                    t.set_submit_on_enter(false, cx);
                    t.set_value(value, w, cx);
                    t
                })
            };
        let findings = area(&draft.findings, "Plain-language findings", w, cx);
        let suggestion = area(&draft.suggested_repair, "Suggested repair", w, cx);
        let regression = area(&draft.regression, "Regression-test guidance", w, cx);
        let uncertainty = menu(
            Uncertainty::ALL
                .iter()
                .map(|u| Item {
                    id: u.wire().into(),
                    label: u.label().trim_end_matches(" uncertainty").into(),
                })
                .collect(),
            draft.uncertainty.wire(),
            w,
            cx,
        );
        let changed = |v: &mut Self, event: &InputEvent, cx: &mut Context<Self>| {
            if matches!(event, InputEvent::Change) {
                v.repair.error = None;
                cx.notify();
            }
        };
        let mut subscriptions = vec![
            cx.subscribe_in(&title, w, move |v, _, e, _, cx| changed(v, e, cx)),
            cx.subscribe_in(
                &uncertainty,
                w,
                |v, _, event: &SelectEvent<SearchableVec<Item>>, _, cx| {
                    if let (SelectEvent::Confirm(Some(id)), Some(edit)) =
                        (event, &mut v.repair.edit)
                        && let Some(level) = Uncertainty::parse(id)
                    {
                        edit.level = level;
                        v.repair.error = None;
                        cx.notify();
                    }
                },
            ),
        ];
        for area in [&findings, &suggestion, &regression] {
            subscriptions.push(cx.subscribe_in(area, w, move |v, _, e, _, cx| changed(v, e, cx)));
        }
        title.update(cx, |i, cx| i.focus(w, cx));
        self.repair.edit = Some(Edit {
            title,
            findings,
            suggestion,
            regression,
            uncertainty,
            level: draft.uncertainty,
            _subscriptions: subscriptions,
        });
        self.repair.error = None;
        cx.notify();
    }

    fn repair_command(&mut self, action: RepairAction, cx: &mut Context<Self>) {
        let Some(id) = self.repair.chat.clone() else {
            return;
        };
        if self.repair.busy(&id) {
            return;
        }
        self.repair.request += 1;
        let sent = self.writer.as_ref().is_some_and(|w| {
            w.command(WriteCommand::Repair {
                specialist: id,
                request: self.repair.request,
                action,
            })
        });
        self.repair.error = (!sent).then_some("Local writer is busy. Nothing was sent.");
        cx.notify();
    }

    /// The review: readable (or edited) proposal, cited evidence, destination, model and the one Start.
    fn repair_review(
        &mut self,
        chat: &Chat,
        specialist: &Specialist,
        proposal: &Arc<Proposal>,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) -> gpui_kit::AnyElement {
        if self
            .repair
            .review
            .as_ref()
            .is_some_and(|(id, _)| *id != proposal.id)
        {
            // The specialist replaced its proposal: review the new one from scratch.
            self.repair.review = None;
            self.repair.edit = None;
            self.repair.start_after = false;
            self.load_repair_review(None, w, cx);
        }
        let loaded = self
            .repair
            .review
            .as_ref()
            .filter(|(id, _)| *id == proposal.id)
            .and_then(|(_, r)| r.clone());
        let muted = cx.theme().muted_foreground;
        let section = |title: &'static str, body: gpui_kit::AnyElement| {
            div()
                .v_flex()
                .gap_1()
                .min_w_0()
                .child(ui::text(Text::Label, title).text_color(muted))
                .child(body)
        };
        let prose = |id: &'static str, value: &str| {
            ui::text(Text::Body, value.to_owned())
                .id(id)
                .test_support()
                .min_w_0()
                .into_any_element()
        };
        let quiet = |value: &str| {
            ui::text(Text::Caption, value.to_owned())
                .text_color(muted)
                .into_any_element()
        };
        let danger = cx.theme().danger;
        let error = |value: &str| {
            ui::text(Text::Caption, value.to_owned())
                .text_color(danger)
                .into_any_element()
        };

        let open_attempt = self.repair.attempt(&chat.id).is_some_and(Attempt::open);
        let busy = self.repair.busy(&chat.id);
        let preparing = self.repair.start_after;
        let locked = busy || preparing || open_attempt;
        let draft = self.repair_draft(proposal, cx);
        let edited = draft != Draft::of(proposal);
        // Edited text not yet reviewed by Local is reviewed again by Start.
        let stale = loaded.as_ref().is_some_and(|r| r.draft != draft);

        let evidence = match loaded.as_ref().map(|r| &r.handoff) {
            None => quiet("Checking cited evidence…"),
            Some(Err(e)) => error(e),
            Some(Ok(h)) => div()
                .id("diagnostic-repair-evidence")
                .test_support()
                .v_flex()
                .gap_1()
                .children(h.evidence.iter().map(|e| {
                    div()
                        .v_flex()
                        .min_w_0()
                        .child(ui::text(Text::Body, e.title.clone()).truncate())
                        .child(
                            ui::text(Text::Caption, e.detail.clone())
                                .truncate()
                                .text_color(muted),
                        )
                }))
                .into_any_element(),
        };
        let subject_host = specialist.subject.as_ref().map(|s| s["host"].clone());
        let binding = match loaded.as_ref().map(|r| &r.project) {
            Some(Ok(status)) => match &status.state {
                ProjectState::Available(b) if subject_host.as_ref() == Some(&b.host()) => {
                    Some(b.clone())
                }
                _ => None,
            },
            _ => None,
        };
        let project = match loaded.as_ref() {
            None => quiet("Checking the repair project…"),
            Some(review) => match (&review.project, &binding) {
                (Err(e), _) => error(e),
                (Ok(_), Some(b)) => {
                    let name = self
                        .state
                        .projects
                        .iter()
                        .find(|p| p.id == b.project_id)
                        .map_or("Pilot".to_owned(), |p| p.name.clone());
                    div()
                        .id("diagnostic-repair-project")
                        .test_support()
                        .v_flex()
                        .min_w_0()
                        .child(ui::text(Text::Body, name).truncate())
                        .child(
                            ui::text(Text::Caption, b.path.clone())
                                .truncate()
                                .text_color(muted),
                        )
                        .into_any_element()
                }
                (Ok(status), None) => self.repair_setup(status, review, cx),
            },
        };
        let catalog = self.repair.pick.as_ref().map(|p| p.catalog.clone());
        let project_model = self
            .repair
            .pick
            .as_ref()
            .and_then(|p| p.project_model.as_deref());
        let levels = catalog
            .as_ref()
            .and_then(|c| self.repair.choice.resolve(c, project_model))
            .map_or(0, |m| m.thinking_levels.len());
        let model = binding.as_ref().map(|_| {
            match (
                &self.repair.pick,
                loaded.as_ref().and_then(|r| r.models.as_ref()),
            ) {
                (Some(pick), _) => div()
                    .id("diagnostic-repair-models")
                    .test_support()
                    .h_flex()
                    .gap_2()
                    .min_w_0()
                    .child(
                        div().min_w_0().max_w_64().child(
                            Select::new(&pick.model)
                                .id("diagnostic-repair-model")
                                .small()
                                .disabled(locked)
                                .menu_width(px(320.))
                                .menu_max_h(px(260.))
                                .accessibility_label("Model for the repair chat"),
                        ),
                    )
                    .child(
                        div().min_w_0().max_w_40().child(
                            Select::new(&pick.thinking)
                                .id("diagnostic-repair-thinking")
                                .small()
                                .disabled(locked || levels == 0)
                                .menu_width(px(180.))
                                .menu_max_h(px(230.))
                                .accessibility_label("Thinking level for the repair chat"),
                        ),
                    )
                    .into_any_element(),
                (None, Some(Err(e))) => quiet(&format!("{e} The repair uses the project default.")),
                (None, _) => quiet("Checking models…"),
            }
        });
        let reviewed = loaded
            .as_ref()
            .and_then(|r| r.handoff.as_ref().ok())
            .cloned();
        let payload = match (&reviewed, &binding, &specialist.subject) {
            (Some(h), Some(b), Some(subject)) => Some(repair::start_payload(
                &chat.id,
                proposal,
                subject,
                h,
                b,
                self.repair.read_diagnostics,
                &self.repair.choice,
            )),
            _ => None,
        };
        let problem = draft.problem().or_else(|| {
            self.repair
                .choice
                .problem(catalog.as_deref(), project_model)
        });
        let ready = !locked
            && self.repair_connected().is_some()
            && binding.is_some()
            && problem.is_none()
            && (stale || matches!(payload, Some(Ok(_))));
        // A retained refusal for this proposal stays visible after restart.
        let refused = self
            .repair
            .attempt(&chat.id)
            .filter(|a| a.state == State::Rejected && a.proposal_id == proposal.id)
            .map(|a| outcome_words(&repair::outcome(a)));
        let status = self
            .repair
            .latest(&chat.id)
            .and_then(Option::as_ref)
            .map(outcome_words)
            .or_else(|| self.repair.error.map(|e| (e.to_owned(), ui::Tone::Error)))
            .or_else(|| problem.map(|e| (e.to_owned(), ui::Tone::Warning)))
            .or(refused)
            .or_else(|| {
                payload
                    .as_ref()
                    .and_then(|p| p.as_ref().err())
                    .filter(|_| !stale)
                    .map(|e| ((*e).to_owned(), ui::Tone::Error))
            })
            .or_else(|| {
                self.repair
                    .setup_error
                    .map(|e| (e.to_owned(), ui::Tone::Error))
            })
            .or_else(|| {
                (loaded.as_ref().is_some_and(|r| r.project.is_ok()) && binding.is_none()).then(
                    || {
                        (
                            "Choose a repair project to start.".to_owned(),
                            ui::Tone::Quiet,
                        )
                    },
                )
            });
        let text = |input: &Entity<TextareaState>, id: &'static str, label: &'static str| {
            div()
                .id(id)
                .test_support()
                .min_w_0()
                .child(Textarea::new(input).aria_label(label).disabled(locked))
                .into_any_element()
        };
        let content = match &self.repair.edit {
            Some(edit) => div()
                .id("diagnostic-repair-edit-fields")
                .test_support()
                .v_flex()
                .gap_3()
                .min_w_0()
                .child(section(
                    "Issue title",
                    div()
                        .id("diagnostic-repair-edit-title")
                        .test_support()
                        .min_w_0()
                        .child(Input::new(&edit.title).disabled(locked))
                        .into_any_element(),
                ))
                .child(section(
                    "Findings",
                    text(
                        &edit.findings,
                        "diagnostic-repair-edit-findings",
                        "Findings",
                    ),
                ))
                .child(section(
                    "Uncertainty",
                    div()
                        .max_w_40()
                        .child(
                            Select::new(&edit.uncertainty)
                                .id("diagnostic-repair-uncertainty")
                                .small()
                                .disabled(locked)
                                .accessibility_label("Uncertainty"),
                        )
                        .into_any_element(),
                ))
                .child(section(
                    "Suggested repair",
                    text(
                        &edit.suggestion,
                        "diagnostic-repair-edit-suggestion",
                        "Suggested repair",
                    ),
                ))
                .child(section(
                    "Regression test",
                    text(
                        &edit.regression,
                        "diagnostic-repair-edit-regression",
                        "Regression test",
                    ),
                ))
                .into_any_element(),
            None => div()
                .v_flex()
                .gap_3()
                .min_w_0()
                .child(section(
                    "Findings",
                    prose("diagnostic-repair-findings", &proposal.findings),
                ))
                .child(section(
                    "Suggested repair",
                    prose("diagnostic-repair-suggestion", &proposal.suggested_repair),
                ))
                .child(section(
                    "Regression test",
                    prose("diagnostic-repair-regression", &proposal.regression),
                ))
                .into_any_element(),
        };
        let header = div()
            .h_flex()
            .items_start()
            .gap_2()
            .min_w_0()
            .child(div().flex_1().min_w_0().child(match self.repair.edit {
                None => ui::text(Text::Headline, proposal.title.clone()).min_w_0(),
                Some(_) => ui::text(Text::Caption, "Your edit. The specialist's proposal is kept.")
                    .text_color(muted),
            }))
            .child(match self.repair.edit {
                Some(_) => ui::action("diagnostic-repair-revert", "Revert", Role::Quiet)
                    .tooltip("Discard your edits and use the specialist's proposal.")
                    .disabled(locked)
                    .on_click(cx.listener(|v, _, _, cx| {
                        v.repair.edit = None;
                        v.repair.error = None;
                        cx.notify();
                    })),
                None => ui::action("diagnostic-repair-edit", "Edit", Role::Quiet)
                    .tooltip("Adjust the title, findings or suggested repair before starting. The specialist's proposal is unchanged.")
                    .disabled(locked)
                    .on_click(cx.listener(|v, _, w, cx| v.edit_repair(w, cx))),
            });
        let proposal_id = proposal.id.clone();
        let copy = format!(
            "{}\n\nFindings\n{}\n\nSuggested repair\n{}\n\nRegression test\n{}",
            draft.title.trim(),
            draft.findings,
            draft.suggested_repair,
            draft.regression
        );
        let height = (f32::from(w.viewport_size().height) * 0.45).max(160.);
        div()
            .id("diagnostic-repair-review-body")
            .test_support()
            .v_flex()
            .gap_3()
            .p_3()
            .min_w_0()
            .rounded(px(appearance::Radius::TRAY))
            .bg(ui::Surface::Card.color(cx))
            .border_1()
            .border_color(cx.theme().border)
            .child(
                div()
                    .id("diagnostic-repair-review-scroll")
                    .test_support()
                    .v_flex()
                    .gap_3()
                    .min_w_0()
                    .max_h(px(height))
                    .overflow_y_scroll()
                    .child(header)
                    .child(content)
                    .child(section("Cited evidence", evidence))
                    .child(section("Repair project", project))
                    .children(model.map(|m| section("Model", m))),
            )
            .child(
                Checkbox::new("diagnostic-repair-read")
                    .label("Let the repair read fresh diagnostics for this subject")
                    .checked(self.repair.read_diagnostics)
                    .disabled(locked)
                    .on_change(cx.listener(|v, checked: &bool, _, cx| {
                        v.repair.read_diagnostics = *checked;
                        cx.notify();
                    })),
            )
            .child(quiet(if edited {
                "Start checks your edits with Local, then opens a separate Build chat in the repair project. This chat stays read-only."
            } else {
                "Start opens a separate Build chat in the repair project. This chat stays read-only."
            }))
            .children(status.map(|(label, tone)| {
                ui::text(Text::Caption, label)
                    .id("diagnostic-repair-status")
                    .test_support()
                    .text_color(tone.color(cx))
            }))
            .child(
                div()
                    .h_flex()
                    .justify_end()
                    .gap_2()
                    .child(
                        ui::action("diagnostic-repair-copy", "Copy proposal", Role::Quiet).on_click(
                            move |_, _, cx| {
                                cx.write_to_clipboard(gpui_kit::ClipboardItem::new_string(copy.clone()))
                            },
                        ),
                    )
                    .child(
                        ui::action(
                            "diagnostic-repair-start",
                            if busy {
                                "Starting…"
                            } else if preparing {
                                "Checking…"
                            } else {
                                "Start repair"
                            },
                            Role::Primary,
                        )
                        .disabled(!ready)
                        .on_click(cx.listener(move |v, _, w, cx| {
                            if v.repair_specialist()
                                .and_then(|(_, s)| s.proposal().map(|p| p.id == proposal_id))
                                == Some(true)
                            {
                                v.start_repair(false, w, cx);
                            }
                        })),
                    ),
            )
            .into_any_element()
    }

    /// Explicit one-time setup: choose a verified Pilot checkout. It starts nothing.
    fn repair_setup(
        &self,
        status: &repair::ProjectStatus,
        review: &Review,
        cx: &mut Context<Self>,
    ) -> gpui_kit::AnyElement {
        let muted = cx.theme().muted_foreground;
        let intro = match status.state {
            ProjectState::Invalid => {
                return ui::text(
                    Text::Caption,
                    "Repair project settings can't be read. They were kept, not reset.",
                )
                .text_color(cx.theme().danger)
                .into_any_element();
            }
            ProjectState::Unavailable(reason) => reason,
            ProjectState::Available(_) => {
                "The repair project was set up for another host identity. Choose it again."
            }
            ProjectState::Missing => {
                "Choose the Pilot source checkout repairs use. This only sets a destination."
            }
        };
        let revision = status.revision;
        let choices: gpui_kit::AnyElement = match &review.checkouts {
            None => div().into_any_element(),
            Some(Err(e)) => ui::text(Text::Caption, *e).text_color(cx.theme().danger).into_any_element(),
            Some(Ok(list)) if list.is_empty() => ui::text(
                Text::Caption,
                "No registered project is a Pilot source checkout. Add your Pilot checkout as a project first.",
            )
            .text_color(muted)
            .into_any_element(),
            Some(Ok(list)) => div()
                .v_flex()
                .gap_1()
                .children(list.iter().enumerate().map(|(ix, project)| {
                    let chosen = project.clone();
                    div()
                        .h_flex()
                        .gap_2()
                        .min_w_0()
                        .items_center()
                        .child(
                            div()
                                .v_flex()
                                .flex_1()
                                .min_w_0()
                                .child(ui::text(Text::Body, project.name.clone()).truncate())
                                .child(ui::text(Text::Caption, project.path.clone()).truncate().text_color(muted)),
                        )
                        .child(
                            ui::action(("diagnostic-repair-use", ix), "Use", Role::Secondary)
                                .tooltip("Use this checkout for diagnostic repairs on this host. Each repair still needs its own Start.")
                                .on_click(cx.listener(move |v, _, w, cx| {
                                    v.load_repair_review(Some((revision, chosen.clone())), w, cx);
                                    cx.notify();
                                })),
                        )
                }))
                .into_any_element(),
        };
        div()
            .id("diagnostic-repair-setup")
            .test_support()
            .v_flex()
            .gap_2()
            .min_w_0()
            .child(ui::text(Text::Caption, intro).text_color(muted))
            .child(choices)
            .into_any_element()
    }

    /// Start: the exact reviewed text, destination and model, saved then sent once.
    /// Edited text is first reviewed by Local; `auto` is that review's continuation.
    fn start_repair(&mut self, auto: bool, w: &mut Window, cx: &mut Context<Self>) {
        let Some((id, specialist)) = self.repair_specialist() else {
            return;
        };
        let (Some(proposal), Some(subject)) =
            (specialist.proposal().cloned(), specialist.subject.clone())
        else {
            return;
        };
        let fail = |v: &mut Self, error: &'static str, cx: &mut Context<Self>| {
            v.repair.error = Some(error);
            cx.notify();
        };
        if self
            .repair
            .edit
            .as_ref()
            .is_some_and(|e| e.composing(w, cx))
        {
            return fail(self, "Finish composing text before starting.", cx);
        }
        let draft = self.repair_draft(&proposal, cx);
        let catalog = self.repair.pick.as_ref().map(|p| p.catalog.clone());
        let project_model = self
            .repair
            .pick
            .as_ref()
            .and_then(|p| p.project_model.clone());
        if let Some(problem) = draft.problem().or_else(|| {
            self.repair
                .choice
                .problem(catalog.as_deref(), project_model.as_deref())
        }) {
            return fail(self, problem, cx);
        }
        let Some(review) = self
            .repair
            .review
            .as_ref()
            .filter(|(pid, _)| *pid == proposal.id)
            .and_then(|(_, r)| r.clone())
        else {
            return;
        };
        if review.draft != draft {
            if auto {
                return fail(
                    self,
                    "The text changed while Local checked it. Start again.",
                    cx,
                );
            }
            self.repair.start_after = true;
            self.repair.error = None;
            self.load_repair_review(None, w, cx);
            cx.notify();
            return;
        }
        let (
            Ok(handoff),
            Ok(repair::ProjectStatus {
                state: ProjectState::Available(binding),
                ..
            }),
        ) = (&review.handoff, &review.project)
        else {
            cx.notify();
            return;
        };
        match repair::start_payload(
            &id,
            &proposal,
            &subject,
            handoff,
            binding,
            self.repair.read_diagnostics,
            &self.repair.choice,
        ) {
            Ok(payload) => self.repair_command(
                RepairAction::Start {
                    proposal_id: proposal.id.clone(),
                    payload,
                },
                cx,
            ),
            Err(error) => fail(self, error, cx),
        }
    }
}
