//! The rules for New, interviews and planning on mock data. Rust owns every
//! saved answer and every state change; the screens send intents and show
//! what this publishes. The mock coordinator ([`PlanDesk::advance`]) only
//! moves after a confirmed submission: a saved draft never wakes it.
//!
//! These are mock rules for the screens and their tests. The daemon's
//! interview and planning services are the authority in production; a
//! trusted native host binds them behind the same read model.

use crate::plan::{
    AnswerIntent, Choice, Delivery, Exploration, FogArea, Interview, InterviewRef, NewIntent,
    OutcomeStatus, PlanAvailability, PlanOutcome, PlanPage, PlanRoute, PlanRow, PlanScenario,
    PlanStage, Planning, Proposal, PrototypeSupport, Question, QuestionSection, QuestionState,
    RoundAnswer, RoundKind, RoundLine, RoundState, Setup, StartedChat, Step, StepState,
    SubmitIntent, SubmitState,
};
use crate::plan_world;

/// The longest answer or goal Day saves, in characters.
pub const MAX_TEXT: usize = 4000;

/// The most all answers of one interview may take together, in bytes of
/// their saved form. The daemon refuses more.
pub const ANSWER_ROOM: usize = 12 * 1024;

/// The words of every refusal of an unavailable planning service.
const UNAVAILABLE: &str = "Planning is not connected here. Nothing was sent.";

/// A saved answer: the question's meaning it was given for, the chosen
/// suggestion with its exact meaning, and the text exactly as written.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Saved {
    pub digest: String,
    pub choice: Option<Choice>,
    pub text: String,
}

/// One question as the desk keeps it.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Ask {
    pub id: String,
    pub section: QuestionSection,
    pub prompt: String,
    pub choices: Vec<Choice>,
    pub new: bool,
    pub saved: Option<Saved>,
    pub saving: Delivery,
}

impl Ask {
    pub(crate) fn new(
        id: &str,
        section: QuestionSection,
        prompt: &str,
        choices: &[(&str, &str, bool)],
    ) -> Self {
        Ask {
            id: id.into(),
            section,
            prompt: prompt.into(),
            choices: choices
                .iter()
                .map(|(id, meaning, recommended)| Choice {
                    id: (*id).into(),
                    meaning: (*meaning).into(),
                    recommended: *recommended,
                })
                .collect(),
            new: false,
            saved: None,
            saving: Delivery::Idle,
        }
    }

    /// The question's meaning: its section, prompt and suggestions.
    pub(crate) fn digest(&self) -> String {
        let mut text = format!("{:?}\u{1f}{}", self.section, self.prompt);
        for c in &self.choices {
            text.push('\u{1f}');
            text.push_str(&c.id);
            text.push('\u{1e}');
            text.push_str(&c.meaning);
        }
        digest(&text)
    }

    /// Saves an answer for the question as it is now.
    pub(crate) fn answer(mut self, choice: Option<&str>, text: &str) -> Self {
        let choice = choice.and_then(|id| self.choices.iter().find(|c| c.id == id).cloned());
        self.saved = Some(Saved {
            digest: self.digest(),
            choice,
            text: text.into(),
        });
        self
    }

    /// The chosen suggestion, if it is still offered with the same meaning.
    fn offered(&self, saved: &Saved) -> Option<&Choice> {
        let choice = saved.choice.as_ref()?;
        self.choices
            .iter()
            .find(|c| c.id == choice.id && c.meaning == choice.meaning)
    }

    pub(crate) fn state(&self) -> QuestionState {
        let Some(saved) = &self.saved else {
            return QuestionState::Open;
        };
        let written = !saved.text.trim().is_empty();
        if saved.choice.is_none() && !written {
            return QuestionState::Open;
        }
        let offered = self.offered(saved).is_some();
        if saved.digest != self.digest() || (saved.choice.is_some() && !offered) {
            return QuestionState::Changed;
        }
        QuestionState::Answered
    }

    fn view(&self) -> Question {
        let state = self.state();
        let saved = self.saved.as_ref();
        let earlier = match (state, saved) {
            (QuestionState::Changed, Some(saved)) => {
                let mut words = saved
                    .choice
                    .as_ref()
                    .map(|c| c.meaning.clone())
                    .unwrap_or_default();
                if !saved.text.trim().is_empty() {
                    if !words.is_empty() {
                        words.push_str(". ");
                    }
                    words.push_str(saved.text.trim());
                }
                words
            }
            _ => String::new(),
        };
        Question {
            id: self.id.clone(),
            section: self.section,
            prompt: self.prompt.clone(),
            digest: self.digest(),
            choices: self.choices.clone(),
            chosen: match state {
                QuestionState::Changed => None,
                _ => saved.and_then(|s| self.offered(s)).map(|c| c.id.clone()),
            },
            text: saved.map(|s| s.text.clone()).unwrap_or_default(),
            state,
            earlier,
            new: self.new,
            saving: self.saving,
        }
    }
}

/// How the mock service answers a submission.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SubmitAck {
    /// It confirms.
    #[default]
    Confirm,
    /// The submission lands, but its answer is lost.
    Lose,
}

/// One open interview round.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Round {
    pub id: String,
    pub kind: RoundKind,
    pub topic: String,
    /// For a topic round: the exploration it answers.
    pub topic_item: String,
    pub round: u32,
    pub revision: u32,
    pub question_set: u32,
    pub current: bool,
    pub asks: Vec<Ask>,
    pub submit: SubmitState,
    pub proposal: String,
    pub ack: SubmitAck,
    /// Whether a lost submission actually landed.
    pub landed: bool,
}

impl Round {
    pub(crate) fn new(id: &str, kind: RoundKind, round: u32, asks: Vec<Ask>) -> Self {
        Round {
            id: id.into(),
            kind,
            topic: String::new(),
            topic_item: String::new(),
            round,
            revision: 1,
            question_set: 1,
            current: true,
            asks,
            submit: SubmitState::Open,
            proposal: String::new(),
            ack: SubmitAck::Confirm,
            landed: false,
        }
    }

    fn answered(&self) -> u32 {
        self.asks
            .iter()
            .filter(|a| a.state() == QuestionState::Answered)
            .count() as u32
    }

    /// The size of the saved answers in their saved form, with question
    /// §replace§'s answer replaced when given.
    fn answer_bytes(&self, replace: Option<(&str, Option<&Choice>, &str)>) -> usize {
        let answers: Vec<serde_json::Value> = self
            .asks
            .iter()
            .filter_map(|a| {
                let (choice, text) = match replace {
                    Some((id, choice, text)) if id == a.id => (choice.cloned(), text.to_owned()),
                    _ => {
                        let saved = a.saved.as_ref()?;
                        (saved.choice.clone(), saved.text.clone())
                    }
                };
                Some(serde_json::json!({
                    "questionId": a.id,
                    "questionDigest": a.digest(),
                    "selectedOption": choice.map(|c| serde_json::json!({"id": c.id, "meaning": c.meaning})),
                    "text": text,
                }))
            })
            .collect();
        serde_json::to_string(&answers).map_or(usize::MAX, |s| s.len())
    }

    fn view(&self) -> Interview {
        Interview {
            id: self.id.clone(),
            kind: self.kind,
            topic: self.topic.clone(),
            round: self.round,
            revision: self.revision,
            question_set: self.question_set,
            current: self.current,
            questions: self.asks.iter().map(Ask::view).collect(),
            answered: self.answered(),
            submit: self.submit,
            proposal: self.proposal.clone(),
            unconfirmed: false,
            room: ANSWER_ROOM.saturating_sub(self.answer_bytes(None)) as u32,
            accepting: true,
        }
    }

    /// The chosen suggestion of question `id`, if it still counts.
    pub(crate) fn chosen(&self, id: &str) -> Option<String> {
        let ask = self.asks.iter().find(|a| a.id == id)?;
        let saved = ask.saved.as_ref()?;
        ask.offered(saved).map(|c| c.id.clone())
    }

    /// The saved text of question `id`, trimmed.
    pub(crate) fn text(&self, id: &str) -> String {
        self.asks
            .iter()
            .find(|a| a.id == id)
            .and_then(|a| a.saved.as_ref())
            .map(|s| s.text.trim().to_owned())
            .unwrap_or_default()
    }

    /// Every answer in words, as submitted: the chosen suggestion's exact
    /// meaning, then the user's text.
    pub(crate) fn answers(&self) -> Vec<RoundAnswer> {
        self.asks
            .iter()
            .map(|a| {
                let saved = a.saved.as_ref();
                let meaning = saved
                    .and_then(|s| s.choice.as_ref())
                    .map(|c| c.meaning.as_str())
                    .unwrap_or_default();
                let text = saved.map(|s| s.text.trim()).unwrap_or_default();
                RoundAnswer {
                    prompt: a.prompt.clone(),
                    answer: [meaning, text]
                        .into_iter()
                        .filter(|p| !p.is_empty())
                        .collect::<Vec<_>>()
                        .join(". "),
                }
            })
            .collect()
    }
}

/// What the mock coordinator does after a submission.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Script {
    /// It goes on planning; nothing more happens here.
    #[default]
    Plan,
    /// The chat export mission: a dependent round when tool results are
    /// exported, then a plan for review.
    Export,
    /// The Linux topic: its answers resolve the topic.
    LinuxTopic,
}

/// One mission in planning.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Plan {
    pub mission_id: String,
    pub title: String,
    pub goal: String,
    pub route: PlanRoute,
    pub destination: String,
    pub round: Option<Round>,
    pub rounds: Vec<RoundLine>,
    pub explorations: Vec<Exploration>,
    pub prototypes: PrototypeSupport,
    pub fog: Vec<FogArea>,
    pub proposal: Option<Proposal>,
    pub submitted: StepState,
    pub continued: StepState,
    pub approved: StepState,
    pub published: StepState,
    pub published_line: String,
    pub note: String,
    pub script: Script,
    /// Whether the mock coordinator changes the plan on the first save of
    /// its review.
    pub amend_on_review: bool,
    /// Continuations admitted, one per confirmed submission.
    pub continuations: u32,
    pub next_round: u32,
    /// Whether Pilot can continue from a submission. When it cannot, the
    /// submission is kept and nothing more happens.
    pub continuation: bool,
}

impl Plan {
    pub(crate) fn new(
        mission_id: &str,
        title: &str,
        goal: &str,
        route: PlanRoute,
        destination: &str,
    ) -> Self {
        Plan {
            mission_id: mission_id.into(),
            title: title.into(),
            goal: goal.into(),
            route,
            destination: destination.into(),
            round: None,
            rounds: Vec::new(),
            explorations: Vec::new(),
            prototypes: PrototypeSupport {
                available: false,
                line: "Prototypes are not available yet. Pilot does not make or guess one.".into(),
            },
            fog: Vec::new(),
            proposal: None,
            submitted: StepState::Waiting,
            continued: StepState::Waiting,
            approved: StepState::Waiting,
            published: StepState::Waiting,
            published_line: String::new(),
            note: String::new(),
            script: Script::Plan,
            amend_on_review: false,
            continuations: 0,
            next_round: 2,
            continuation: true,
        }
    }

    fn stage(&self) -> PlanStage {
        if let Some(round) = &self.round {
            match round.submit {
                SubmitState::Unknown | SubmitState::Checking => return PlanStage::Unknown,
                SubmitState::Open | SubmitState::Submitting => {
                    return if round.kind == RoundKind::Review {
                        PlanStage::Review
                    } else {
                        PlanStage::Questions
                    };
                }
                SubmitState::Submitted => {}
            }
        }
        if self.published == StepState::Done {
            PlanStage::Published
        } else if self.approved == StepState::Done {
            PlanStage::Approved
        } else if self.continued == StepState::Unavailable && self.submitted == StepState::Done {
            PlanStage::Submitted
        } else {
            PlanStage::Planning
        }
    }

    fn row(&self) -> PlanRow {
        let stage = self.stage();
        let line = match (stage, &self.round) {
            (PlanStage::Questions, Some(round)) => {
                format!("{} of {} answered", round.answered(), round.asks.len())
            }
            (PlanStage::Review, _) => "The plan is ready for your review".into(),
            (PlanStage::Unknown, _) => "Submission not confirmed".into(),
            (PlanStage::Approved, _) => "Approved. Not published yet".into(),
            (PlanStage::Published, _) => self.published_line.clone(),
            (PlanStage::Submitted, _) => "Submitted. Pilot cannot continue from it here yet".into(),
            _ => "Pilot is working on the plan".into(),
        };
        PlanRow {
            mission_id: self.mission_id.clone(),
            title: self.title.clone(),
            stage,
            line,
            needs_you: matches!(
                stage,
                PlanStage::Questions | PlanStage::Review | PlanStage::Unknown
            ),
            identity: None,
        }
    }

    fn steps(&self) -> Vec<Step> {
        let step = |label: &str, state: StepState, line: &str| Step {
            label: label.into(),
            state,
            line: line.into(),
        };
        vec![
            step(
                "Pilot continues planning",
                self.continued,
                if self.continued == StepState::Unavailable {
                    "Not connected here yet. Your submitted answers are kept."
                } else {
                    "Planning only. It starts no build work."
                },
            ),
            step(
                "Plan approved",
                self.approved,
                "Only your answer to the review approves it.",
            ),
            step(
                "Published as tasks",
                self.published,
                if self.published == StepState::Done {
                    &self.published_line
                } else {
                    "Publishing adds tasks and starts nothing."
                },
            ),
            step(
                "Work started",
                StepState::Unavailable,
                "Starting work needs its own confirmation. Nothing here starts it.",
            ),
        ]
    }

    fn page(&self) -> PlanPage {
        PlanPage {
            mission_id: self.mission_id.clone(),
            title: self.title.clone(),
            available: true,
            reason: String::new(),
            fresh: true,
            goal: self.goal.clone(),
            route: self.route,
            stage: self.stage(),
            destination: self.destination.clone(),
            interview: self.round.as_ref().map(Round::view),
            rounds: self.rounds.clone(),
            explorations: self.explorations.clone(),
            prototypes: self.prototypes.clone(),
            fog: self.fog.clone(),
            proposal: self.proposal.clone(),
            steps: self.steps(),
            work: None,
            note: self.note.clone(),
        }
    }
}

/// A mock world for the planning screens.
#[derive(Debug, Clone)]
pub struct PlanWorld {
    pub(crate) availability: PlanAvailability,
    pub(crate) reason: String,
    pub(crate) setup: Setup,
    pub(crate) plans: Vec<Plan>,
}

/// A save that waits for the service.
#[derive(Debug, Clone, PartialEq)]
pub struct SaveTicket {
    intent: AnswerIntent,
}

/// A submission that waits for the service.
#[derive(Debug, Clone, PartialEq)]
pub struct SubmitTicket {
    /// The mission whose interview was submitted.
    pub mission_id: String,
    interview_id: String,
}

/// Planning's state and every rule for changing it.
#[derive(Debug, Clone)]
pub struct PlanDesk {
    planning: Planning,
    plans: Vec<Plan>,
    next_id: u32,
}

impl PlanDesk {
    /// The desk for `scenario`.
    pub fn new(scenario: PlanScenario) -> Self {
        Self::from_world(plan_world::world(scenario))
    }

    /// The desk for a world built elsewhere.
    pub fn from_world(world: PlanWorld) -> Self {
        let mut desk = PlanDesk {
            planning: Planning {
                revision: 0,
                can_create: world.availability != PlanAvailability::Unavailable,
                can_start: world.availability != PlanAvailability::Unavailable,
                start_reason: if world.availability == PlanAvailability::Unavailable {
                    world.reason.clone()
                } else {
                    String::new()
                },
                create_reason: if world.availability == PlanAvailability::Unavailable {
                    world.reason.clone()
                } else {
                    String::new()
                },
                availability: world.availability,
                reason: world.reason,
                setup: world.setup,
                plans: Vec::new(),
                started: Vec::new(),
            },
            plans: world.plans,
            next_id: 1,
        };
        desk.changed();
        desk
    }

    /// Planning now.
    pub fn planning(&self) -> &Planning {
        &self.planning
    }

    /// One mission's planning, or none when it is not in planning.
    pub fn page(&self, mission_id: &str) -> Option<PlanPage> {
        self.plans
            .iter()
            .find(|p| p.mission_id == mission_id)
            .map(Plan::page)
    }

    /// How many continuations the mock coordinator admitted for `mission_id`.
    pub fn continuations(&self, mission_id: &str) -> u32 {
        self.plans
            .iter()
            .find(|p| p.mission_id == mission_id)
            .map_or(0, |p| p.continuations)
    }

    fn changed(&mut self) {
        self.planning.revision += 1;
        self.planning.plans = self.plans.iter().rev().map(Plan::row).collect();
    }

    fn outcome(&self, status: OutcomeStatus, message: &str) -> PlanOutcome {
        PlanOutcome {
            status,
            revision: self.planning.revision,
            message: message.into(),
            mission_id: None,
        }
    }

    fn refuse<T>(&self, status: OutcomeStatus, message: &str) -> Result<T, PlanOutcome> {
        Err(self.outcome(status, message))
    }

    fn usable(&self, setup: Option<&str>) -> Result<(), PlanOutcome> {
        if self.planning.availability == PlanAvailability::Unavailable {
            return self.refuse(OutcomeStatus::Rejected, UNAVAILABLE);
        }
        if let Some(setup) = setup
            && setup != self.planning.setup.digest
        {
            return self.refuse(
                OutcomeStatus::Stale,
                "The project or its settings changed. Read them again; nothing was sent.",
            );
        }
        Ok(())
    }

    fn goal(&self, intent: &NewIntent) -> Result<(), PlanOutcome> {
        self.usable(Some(&intent.setup))?;
        if intent.goal.trim().is_empty() {
            return self.refuse(OutcomeStatus::Rejected, "Say what you want first.");
        }
        if intent.goal.chars().count() > MAX_TEXT {
            return self.refuse(
                OutcomeStatus::Rejected,
                "That is too long. Keep it under 4,000 characters.",
            );
        }
        Ok(())
    }

    /// Starts a mission interview from the user's goal. The mission shows at
    /// once while Pilot writes the first questions; nothing else starts.
    pub fn begin_plan(&mut self, intent: &NewIntent) -> Result<String, PlanOutcome> {
        self.goal(intent)?;
        let id = format!("new-{}", self.next_id);
        self.next_id += 1;
        let mut plan = Plan::new(
            &id,
            &title(&intent.goal),
            &intent.goal,
            PlanRoute::Interview,
            "",
        );
        plan.note = "Pilot is writing the first questions.".into();
        self.plans.push(plan);
        self.changed();
        Ok(id)
    }

    /// The first questions arrive, as the full list.
    pub fn settle_plan(&mut self, mission_id: &str) -> PlanOutcome {
        let Some(plan) = self.plans.iter_mut().find(|p| p.mission_id == mission_id) else {
            return self.outcome(OutcomeStatus::Rejected, "That mission is gone.");
        };
        plan.note.clear();
        plan.round = Some(plan_world::first_round(mission_id));
        self.changed();
        PlanOutcome {
            mission_id: Some(mission_id.into()),
            ..self.outcome(OutcomeStatus::Accepted, "")
        }
    }

    /// Checks a direct start: one new chat with exactly this text, not a
    /// mission.
    pub fn begin_start(&mut self, intent: &NewIntent) -> Result<String, PlanOutcome> {
        self.goal(intent)?;
        let id = format!("chat-{}", self.next_id);
        self.next_id += 1;
        self.planning.started.insert(
            0,
            StartedChat {
                id: id.clone(),
                text: intent.goal.clone(),
                line: "Starting a new Build chat…".into(),
            },
        );
        self.changed();
        Ok(id)
    }

    /// The new chat started.
    pub fn settle_start(&mut self, id: &str) -> PlanOutcome {
        if let Some(chat) = self.planning.started.iter_mut().find(|c| c.id == id) {
            chat.line = "Started. It works on its own and is not part of a mission.".into();
        }
        self.changed();
        self.outcome(
            OutcomeStatus::Accepted,
            "Started a new Build chat with your words.",
        )
    }

    fn find_round(&self, interview_id: &str) -> Option<(usize, &Round)> {
        self.plans.iter().enumerate().find_map(|(at, p)| {
            p.round
                .as_ref()
                .filter(|r| r.id == interview_id)
                .map(|r| (at, r))
        })
    }

    fn round_mut(&mut self, at: usize) -> &mut Round {
        self.plans[at].round.as_mut().expect("a round found before")
    }

    /// Checks a save against the interview as shown and marks the question
    /// as saving. A save never submits and never wakes the coordinator.
    pub fn begin_save(&mut self, intent: &AnswerIntent) -> Result<SaveTicket, PlanOutcome> {
        self.usable(None)?;
        let Some((at, round)) = self.find_round(&intent.interview_id) else {
            return self.refuse(
                OutcomeStatus::Rejected,
                "This interview is not open any more.",
            );
        };
        if round.submit != SubmitState::Open {
            return self.refuse(
                OutcomeStatus::Rejected,
                "These answers were submitted and are fixed.",
            );
        }
        if round.question_set != intent.question_set {
            return self.refuse(
                OutcomeStatus::Stale,
                "Pilot changed the questions. Your text is kept here; read them again.",
            );
        }
        let Some(ask) = round.asks.iter().find(|a| a.id == intent.question_id) else {
            return self.refuse(
                OutcomeStatus::Rejected,
                "That question is not part of this interview. Each interview answers only its own topic.",
            );
        };
        if ask.digest() != intent.digest {
            return self.refuse(
                OutcomeStatus::Stale,
                "This question changed. Your text is kept here; read it again.",
            );
        }
        if let Some(choice) = &intent.choice_id
            && !ask.choices.iter().any(|c| &c.id == choice)
        {
            return self.refuse(
                OutcomeStatus::Stale,
                "That suggestion is no longer offered.",
            );
        }
        if intent.text.chars().count() > MAX_TEXT {
            return self.refuse(
                OutcomeStatus::Rejected,
                "That is too long. Keep it under 4,000 characters.",
            );
        }
        let choice = intent
            .choice_id
            .as_ref()
            .and_then(|id| ask.choices.iter().find(|c| &c.id == id));
        if round.answer_bytes(Some((&intent.question_id, choice, &intent.text))) > ANSWER_ROOM {
            return self.refuse(
                OutcomeStatus::Rejected,
                "Your answers together are too long to save. Shorten one; your text is kept here.",
            );
        }
        let ask = self
            .round_mut(at)
            .asks
            .iter_mut()
            .find(|a| a.id == intent.question_id)
            .expect("found above");
        ask.saving = Delivery::Sending;
        self.changed();
        Ok(SaveTicket {
            intent: intent.clone(),
        })
    }

    /// Saves the answer as a draft, unless the questions changed meanwhile.
    pub fn settle_save(&mut self, ticket: &SaveTicket) -> PlanOutcome {
        let intent = &ticket.intent;
        let Some((at, _)) = self.find_round(&intent.interview_id) else {
            return self.outcome(
                OutcomeStatus::Stale,
                "This interview closed before your answer was saved.",
            );
        };
        let plan = &mut self.plans[at];
        let round = plan.round.as_mut().expect("found above");
        let fits = round.question_set == intent.question_set && round.submit == SubmitState::Open;
        let kind = round.kind;
        let Some(ask) = round.asks.iter_mut().find(|a| a.id == intent.question_id) else {
            return self.outcome(OutcomeStatus::Stale, "This question is gone.");
        };
        ask.saving = Delivery::Idle;
        if !fits || ask.digest() != intent.digest {
            self.changed();
            return self.outcome(
                OutcomeStatus::Stale,
                "Pilot changed the questions before your answer was saved. Your text is kept here.",
            );
        }
        let choice = intent
            .choice_id
            .as_ref()
            .and_then(|id| ask.choices.iter().find(|c| &c.id == id).cloned());
        ask.saved = Some(Saved {
            digest: ask.digest(),
            choice,
            text: intent.text.clone(),
        });
        round.revision += 1;
        if kind == RoundKind::Review && plan.amend_on_review {
            plan.amend_on_review = false;
            plan_world::amend_during_review(plan);
        }
        self.changed();
        self.outcome(OutcomeStatus::Accepted, "")
    }

    /// Checks the one submission of an interview against the saved answers
    /// shown. Every question needs an answer; a recommendation is not one.
    pub fn begin_submit(&mut self, intent: &SubmitIntent) -> Result<SubmitTicket, PlanOutcome> {
        self.usable(None)?;
        let Some((at, round)) = self.find_round(&intent.interview_id) else {
            return self.refuse(
                OutcomeStatus::Rejected,
                "This interview is not open any more.",
            );
        };
        match round.submit {
            SubmitState::Open => {}
            SubmitState::Unknown | SubmitState::Checking => {
                return self.refuse(
                    OutcomeStatus::Rejected,
                    "Pilot has not heard whether your answers arrived. Check first; it never sends them twice.",
                );
            }
            _ => {
                return self.refuse(
                    OutcomeStatus::Rejected,
                    "These answers were already submitted.",
                );
            }
        }
        if round.revision != intent.revision {
            return self.refuse(
                OutcomeStatus::Stale,
                "Your saved answers changed since this was shown. Read them and submit again.",
            );
        }
        if !round.current {
            return self.refuse(
                OutcomeStatus::Rejected,
                "The plan changed since these questions were asked. Your answers are kept, but they cannot be submitted.",
            );
        }
        if round.asks.iter().any(|a| a.saving != Delivery::Idle) {
            return self.refuse(OutcomeStatus::Rejected, "Wait until every answer is saved.");
        }
        if round.kind == RoundKind::Review {
            let shown = self.plans[at].proposal.as_ref().map(|p| p.digest.as_str());
            if shown != Some(intent.proposal.as_str()) || round.proposal != intent.proposal {
                return self.refuse(
                    OutcomeStatus::Stale,
                    "The plan changed. Read it again before you answer.",
                );
            }
        } else if !intent.proposal.is_empty() {
            return self.refuse(OutcomeStatus::Rejected, "This interview reviews no plan.");
        }
        let left = round.asks.len() as u32 - round.answered();
        if left > 0 {
            let message = if left == 1 {
                "Answer every question first. One is left.".to_owned()
            } else {
                format!("Answer every question first. {left} are left.")
            };
            return self.refuse(OutcomeStatus::Rejected, &message);
        }
        let mission_id = self.plans[at].mission_id.clone();
        self.round_mut(at).submit = SubmitState::Submitting;
        self.changed();
        Ok(SubmitTicket {
            mission_id,
            interview_id: intent.interview_id.clone(),
        })
    }

    /// The service answers the submission: confirmed, or lost.
    pub fn settle_submit(&mut self, ticket: &SubmitTicket) -> PlanOutcome {
        let Some((at, round)) = self.find_round(&ticket.interview_id) else {
            return self.outcome(
                OutcomeStatus::Unknown,
                "The interview closed while it was submitted.",
            );
        };
        if round.ack == SubmitAck::Lose {
            let round = self.round_mut(at);
            round.submit = SubmitState::Unknown;
            round.landed = true;
            self.changed();
            return self.outcome(
                OutcomeStatus::Unknown,
                "Pilot sent your answers but heard nothing back. It will not send them again until it checks.",
            );
        }
        self.submitted(at);
        PlanOutcome {
            mission_id: Some(ticket.mission_id.clone()),
            ..self.outcome(
                OutcomeStatus::Accepted,
                "Submitted. Pilot continues from your answers.",
            )
        }
    }

    /// Marks a confirmed submission and admits its one continuation.
    fn submitted(&mut self, at: usize) {
        let plan = &mut self.plans[at];
        let round = plan.round.as_mut().expect("a submitted round");
        round.submit = SubmitState::Submitted;
        let review = round.kind == RoundKind::Review;
        let approve = review && round.chosen("review").as_deref() == Some("approve");
        let title = match round.kind {
            RoundKind::Review => format!("Review, round {}", round.round),
            RoundKind::Topic => format!("{}, round {}", round.topic, round.round),
            RoundKind::Mission => format!("Round {}", round.round),
        };
        let line = if !review {
            format!("{} answers, submitted", round.asks.len())
        } else if approve {
            "You approved the plan".to_owned()
        } else {
            "You asked for changes".to_owned()
        };
        plan.rounds.push(RoundLine {
            id: round.id.clone(),
            title,
            line,
            state: RoundState::Submitted,
            answers: round.answers(),
        });
        plan.submitted = StepState::Done;
        if plan.continuation {
            plan.continued = StepState::Done;
            plan.continuations += 1;
        } else {
            plan.continued = StepState::Unavailable;
        }
        if approve {
            plan.approved = StepState::Done;
            plan.published = StepState::Now;
        }
        plan.note.clear();
        self.changed();
    }

    /// Starts a read of whether a lost submission landed. Never resends.
    pub fn begin_check(&mut self, intent: &InterviewRef) -> Result<(), PlanOutcome> {
        self.usable(None)?;
        let Some((at, round)) = self.find_round(&intent.interview_id) else {
            return self.refuse(
                OutcomeStatus::Rejected,
                "This interview is not open any more.",
            );
        };
        if round.submit != SubmitState::Unknown {
            return self.refuse(OutcomeStatus::Rejected, "There is nothing to check.");
        }
        self.round_mut(at).submit = SubmitState::Checking;
        self.changed();
        Ok(())
    }

    /// The read's result: landed, or not.
    pub fn settle_check(&mut self, intent: &InterviewRef) -> PlanOutcome {
        let Some((at, round)) = self.find_round(&intent.interview_id) else {
            return self.outcome(
                OutcomeStatus::Rejected,
                "This interview is not open any more.",
            );
        };
        if round.submit != SubmitState::Checking {
            return self.outcome(OutcomeStatus::Rejected, "There is nothing to check.");
        }
        if round.landed {
            self.submitted(at);
            let mission_id = self.plans[at].mission_id.clone();
            return PlanOutcome {
                mission_id: Some(mission_id),
                ..self.outcome(
                    OutcomeStatus::Accepted,
                    "Your answers arrived. Pilot continues from them.",
                )
            };
        }
        self.round_mut(at).submit = SubmitState::Open;
        self.changed();
        self.outcome(
            OutcomeStatus::Accepted,
            "Your answers did not arrive. Nothing was submitted; you can submit them now.",
        )
    }

    /// The mock coordinator's next step after an admitted continuation.
    /// Only a confirmed submission leads here.
    pub fn advance(&mut self, mission_id: &str) {
        let Some(plan) = self.plans.iter_mut().find(|p| p.mission_id == mission_id) else {
            return;
        };
        if !plan.continuation {
            return;
        }
        let Some(round) = plan.round.take_if(|r| r.submit == SubmitState::Submitted) else {
            return;
        };
        plan_world::advance(plan, round);
        self.changed();
    }
}

/// A short title from the user's goal: its first words.
fn title(goal: &str) -> String {
    let words: Vec<&str> = goal.split_whitespace().take(7).collect();
    let mut title = words.join(" ");
    if goal.split_whitespace().count() > 7 {
        title.push('…');
    }
    title
}

/// A short, stable digest of `text` (FNV-1a), for mock fences.
pub(crate) fn digest(text: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in text.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{hash:016x}")
}
