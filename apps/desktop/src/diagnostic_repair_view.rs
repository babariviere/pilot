//! Diagnostic repair, mounted above a diagnostics chat's composer. The chat stays
//! read-only: Suggest sends one fixed request through the ordinary composer
//! delivery, Review reads pilotd's validated handoff, and only an explicit Start
//! saves and sends one immutable repair-create. Nothing here reads transcript text.
use super::*;
use crate::{
    diagnostic_repair::{
        self as repair, Action as RepairAction, Attempt, Outcome, ProjectState, Proposal, Review,
        SUGGEST_MESSAGE, Specialist, State,
    },
    ui::{self, Action as Role, Text},
};
use gpui_kit::{StatefulInteractiveElement as _, component::checkbox::Checkbox};

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
    /// Hidden probes supply review material instead of reading Local.
    #[cfg(feature = "native-probes")]
    pub(super) fn probe_review(&mut self, proposal: &str, review: Review) {
        self.epoch += 1;
        self.reading = None;
        self.review = Some((proposal.into(), Some(review)));
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
                .on_click(cx.listener(move |v, _, _, cx| v.toggle_repair_review(cx))),
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

    fn toggle_repair_review(&mut self, cx: &mut Context<Self>) {
        self.repair.open = !self.repair.open;
        if self.repair.open {
            self.repair.review = None;
            self.load_repair_review(None, cx);
        } else {
            self.repair.reading = None;
        }
        cx.notify();
    }

    /// Reads (and, for an explicit setup choice, first configures) the review material.
    fn load_repair_review(
        &mut self,
        configure: Option<(u64, crate::local_model::Project)>,
        cx: &mut Context<Self>,
    ) {
        let Some((id, specialist)) = self.repair.chat.clone().and_then(|id| {
            let s = self
                .state
                .chats
                .iter()
                .find(|c| c.id == id)?
                .diagnostic
                .clone()?;
            Some((id, s))
        }) else {
            return;
        };
        let (Some(proposal), Some(subject), Some(options)) = (
            specialist.proposal().cloned(),
            specialist.subject.clone(),
            self.repair_connected(),
        ) else {
            self.repair.setup_error = Some("Connect to Local to review this repair.");
            return;
        };
        self.repair.epoch += 1;
        let epoch = self.repair.epoch;
        let proposal_id = proposal.id.clone();
        self.repair.review = Some((proposal_id.clone(), None));
        self.repair.setup_error = None;
        let Some(reply) = repair::start(
            options,
            repair::Job {
                specialist: id,
                proposal,
                subject,
                configure,
            },
        ) else {
            self.repair.setup_error = Some("Couldn't start the review. Try again.");
            return;
        };
        self.repair.reading = Some(cx.spawn(async move |view, cx| {
            let Ok((review, error)) = reply.recv().await else {
                return;
            };
            let _ = view.update(cx, |v, cx| {
                if v.repair.epoch == epoch {
                    v.repair.review = Some((proposal_id, Some(review)));
                    v.repair.setup_error = error;
                    cx.notify();
                }
            });
        }));
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

    /// The review: readable proposal, cited evidence, destination and the one Start.
    fn repair_review(
        &mut self,
        chat: &Chat,
        specialist: &Specialist,
        proposal: &Arc<Proposal>,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) -> gpui_kit::AnyElement {
        let loaded = self
            .repair
            .review
            .as_ref()
            .filter(|(id, _)| *id == proposal.id)
            .and_then(|(_, r)| r.clone());
        if self
            .repair
            .review
            .as_ref()
            .is_some_and(|(id, _)| *id != proposal.id)
        {
            // The specialist replaced its proposal: review the new one from scratch.
            self.repair.review = None;
            self.load_repair_review(None, cx);
        }
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
        let open_attempt = self.repair.attempt(&chat.id).is_some_and(Attempt::open);
        let busy = self.repair.busy(&chat.id);
        let handoff = loaded
            .as_ref()
            .and_then(|r| r.handoff.as_ref().ok())
            .cloned();
        let payload = match (&handoff, &binding, &specialist.subject) {
            (Some(h), Some(b), Some(subject)) => Some(repair::start_payload(
                &chat.id,
                proposal,
                subject,
                h,
                b,
                self.repair.read_diagnostics,
            )),
            _ => None,
        };
        let ready = !busy
            && !open_attempt
            && self.repair_connected().is_some()
            && matches!(payload, Some(Ok(_)));
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
            .or(refused)
            .or_else(|| {
                payload
                    .as_ref()
                    .and_then(|p| p.as_ref().err())
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
        let proposal_id = proposal.id.clone();
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
                    .child(ui::text(Text::Headline, proposal.title.clone()).min_w_0())
                    .child(section("Findings", prose("diagnostic-repair-findings", &proposal.findings)))
                    .child(section("Suggested repair", prose("diagnostic-repair-suggestion", &proposal.suggested_repair)))
                    .child(section("Regression test", prose("diagnostic-repair-regression", &proposal.regression)))
                    .child(section("Cited evidence", evidence))
                    .child(section("Repair project", project)),
            )
            .child(
                Checkbox::new("diagnostic-repair-read")
                    .label("Let the repair read fresh diagnostics for this subject")
                    .checked(self.repair.read_diagnostics)
                    .disabled(busy || open_attempt)
                    .on_change(cx.listener(|v, checked: &bool, _, cx| {
                        v.repair.read_diagnostics = *checked;
                        cx.notify();
                    })),
            )
            .child(quiet("Start opens a separate Build chat in the repair project with its default model. This chat stays read-only."))
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
                        ui::action("diagnostic-repair-copy", "Copy proposal", Role::Quiet).on_click({
                            let text = format!(
                                "{}\n\nFindings\n{}\n\nSuggested repair\n{}\n\nRegression test\n{}",
                                proposal.title, proposal.findings, proposal.suggested_repair, proposal.regression
                            );
                            move |_, _, cx| cx.write_to_clipboard(gpui_kit::ClipboardItem::new_string(text.clone()))
                        }),
                    )
                    .child(
                        ui::action(
                            "diagnostic-repair-start",
                            if busy { "Starting…" } else { "Start repair" },
                            Role::Primary,
                        )
                        .disabled(!ready)
                        .on_click(cx.listener(move |v, _, w, cx| v.start_repair(&proposal_id, w, cx))),
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
                                .on_click(cx.listener(move |v, _, _, cx| {
                                    v.load_repair_review(Some((revision, chosen.clone())), cx);
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

    fn start_repair(&mut self, proposal_id: &str, w: &mut Window, cx: &mut Context<Self>) {
        let _ = w;
        let Some(id) = self.repair.chat.clone() else {
            return;
        };
        let Some(specialist) = self
            .state
            .chats
            .iter()
            .find(|c| c.id == id && !c.archived)
            .and_then(|c| c.diagnostic.clone())
        else {
            return;
        };
        let (Some(proposal), Some(subject)) = (specialist.proposal(), specialist.subject.as_ref())
        else {
            return;
        };
        if proposal.id != proposal_id {
            return;
        }
        let Some(review) = self
            .repair
            .review
            .as_ref()
            .filter(|(pid, _)| pid == proposal_id)
            .and_then(|(_, r)| r.as_ref())
        else {
            return;
        };
        let (
            Ok(handoff),
            Ok(repair::ProjectStatus {
                state: ProjectState::Available(binding),
                ..
            }),
        ) = (&review.handoff, &review.project)
        else {
            return;
        };
        match repair::start_payload(
            &id,
            proposal,
            subject,
            handoff,
            binding,
            self.repair.read_diagnostics,
        ) {
            Ok(payload) => self.repair_command(
                RepairAction::Start {
                    proposal_id: proposal_id.into(),
                    payload,
                },
                cx,
            ),
            Err(error) => {
                self.repair.error = Some(error);
                cx.notify();
            }
        }
    }
}
