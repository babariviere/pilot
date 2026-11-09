//! The read models and intents of New, mission interviews and mission
//! planning, as the TSX screens see them. They mirror the daemon's
//! interview and planning records (`packages/protocol/src/mission-interview.ts`
//! and `mission-plan.ts`) for display. TSX names ids and the revisions it
//! showed; Rust adds operation IDs, owners and fences, and TSX never sees a
//! transport. Saving, submitting, approving, publishing and starting work
//! are separate states here, as they are in the daemon.

use nsh_core::prelude::*;

pub use crate::model::{Delivery, OutcomeStatus};

/// Which mock planning world the feed starts from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub enum PlanScenario {
    /// One mission interview, three of seven questions answered.
    #[default]
    Interview,
    /// No planning yet: only New.
    Fresh,
    /// A Wayfinder map: questions to grill and research, fog, a topic
    /// interview, and a second mission's interview.
    Wayfinder,
    /// A finished interview whose plan waits for the user's review.
    Review,
    /// A changed question, a removed option and a lost submission; a topic
    /// interview whose context changed; a plan that changes during review.
    Trouble,
    /// Planning is not connected. Nothing can be sent.
    Unavailable,
    /// One mission interview whose submission is kept, but Pilot cannot
    /// continue from it yet.
    Held,
    /// One mission interview with 40 questions, the most one round holds.
    Long,
}

/// Whether planning can be used at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub enum PlanAvailability {
    /// Mock data in this app. Nothing reaches a daemon.
    #[default]
    Mock,
    /// Connected to the selected daemon.
    Live,
    /// Not connected or not supported. Nothing can be sent.
    Unavailable,
}

/// The project and settings a new chat or mission would use, as shown on New.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub struct Setup {
    /// The project, as the user knows it.
    pub project: String,
    /// The model a new chat would use.
    pub model: String,
    /// What a new chat may do, in a few words.
    pub access: String,
    /// Changes whenever any of the above changes. New intents name it.
    pub digest: String,
}

/// Where a mission's planning is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub enum PlanStage {
    /// Questions wait for the user's answers.
    #[default]
    Questions,
    /// Pilot works on the plan. Nothing waits for the user.
    Planning,
    /// The plan waits for the user's review.
    Review,
    /// The user approved the plan; it is not published yet.
    Approved,
    /// The plan is published as tasks. No work started from it.
    Published,
    /// Submitted, but Pilot cannot continue from it yet. The answers are kept.
    Submitted,
    /// An outcome is not confirmed. Only a check settles it.
    Unknown,
}

/// One mission in planning, as a row.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub struct PlanRow {
    /// The mission.
    pub mission_id: String,
    /// The mission's title.
    pub title: String,
    /// Where its planning is.
    pub stage: PlanStage,
    /// One line, such as "3 of 7 answered".
    pub line: String,
    /// Whether it waits for the user.
    pub needs_you: bool,
}

/// One chat started directly from New, without a mission.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub struct StartedChat {
    /// Stable for the request's life.
    pub id: String,
    /// The text it started with, exactly.
    pub text: String,
    /// One line about where it is.
    pub line: String,
}

/// Everything New and Today show about planning.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub struct Planning {
    /// Changes with every change.
    pub revision: u32,
    /// Whether planning can be used.
    pub availability: PlanAvailability,
    /// Why not, when unavailable. Empty otherwise.
    pub reason: String,
    /// What a new chat or mission would use.
    pub setup: Setup,
    /// Whether New can start a mission or a chat here.
    pub can_create: bool,
    /// Why not, when it cannot. Empty otherwise.
    pub create_reason: String,
    /// Missions in planning, newest first.
    pub plans: Vec<PlanRow>,
    /// Chats started directly from New in this app.
    pub started: Vec<StartedChat>,
}

/// The part of the mission a question is about. The daemon's sections.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub enum QuestionSection {
    /// What the mission should achieve.
    #[default]
    Outcome,
    /// What it should not do.
    NonGoals,
    /// Limits it must respect.
    Constraints,
    /// How the user will know it is done.
    Acceptance,
    /// What Pilot may do on its own.
    Authority,
}

/// A suggested answer to a question.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub struct Choice {
    /// Stable within its question.
    pub id: String,
    /// What choosing it means, exactly as saved.
    pub meaning: String,
    /// Whether Pilot recommends it. A recommendation is not an answer.
    pub recommended: bool,
}

/// Whether a question has the user's answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub enum QuestionState {
    /// No answer yet, or only a draft with nothing in it.
    #[default]
    Open,
    /// Answered: a suggestion was chosen, or the user wrote an answer.
    Answered,
    /// The question or its chosen suggestion changed after the user
    /// answered. The earlier answer is kept but does not count.
    Changed,
}

/// One question of an interview, with the user's saved answer.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub struct Question {
    /// Stable within the interview.
    pub id: String,
    /// The part of the mission it is about.
    pub section: QuestionSection,
    /// The question, exactly as Pilot asked it.
    pub prompt: String,
    /// Changes when the question's meaning or suggestions change. Saves name it.
    pub digest: String,
    /// Suggested answers. Pilot may mark one as recommended.
    pub choices: Vec<Choice>,
    /// The chosen suggestion, as saved. Null when none was chosen.
    pub chosen: Option<String>,
    /// The user's own answer, or detail added to a suggestion, exactly as saved.
    pub text: String,
    /// Whether it has the user's answer.
    pub state: QuestionState,
    /// While changed: the earlier answer, in words. Empty otherwise.
    pub earlier: String,
    /// Whether this question arrived in the latest round.
    pub new: bool,
    /// Where the latest save of this question is.
    pub saving: Delivery,
}

/// What an interview is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub enum RoundKind {
    /// The mission's own interview.
    #[default]
    Mission,
    /// One topic of a Wayfinder map. It cannot answer another topic.
    Topic,
    /// The user's review of a proposed plan.
    Review,
}

/// Where an interview's one submission is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub enum SubmitState {
    /// Not submitted. Answers save as drafts.
    #[default]
    Open,
    /// Submitted; waiting for the service to confirm.
    Submitting,
    /// Submitted and confirmed. The answers are fixed.
    Submitted,
    /// Submitted, but no confirmation came back. Only a check settles it.
    Unknown,
    /// Reading whether the submission landed. Changes nothing.
    Checking,
}

/// A saved interview: the full current list of questions.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub struct Interview {
    /// Stable for the interview's life.
    pub id: String,
    /// What it is for.
    pub kind: RoundKind,
    /// For a topic interview: the topic it answers. Empty otherwise.
    pub topic: String,
    /// The round, from 1. A new round comes only from earlier answers.
    pub round: u32,
    /// The saved answers' revision. Submit names it.
    pub revision: u32,
    /// The question list's revision. Saves name it.
    pub question_set: u32,
    /// Whether the plan it was asked about is unchanged. A changed one
    /// keeps the answers but cannot be submitted.
    pub current: bool,
    /// Every question, in the order Pilot asked them.
    pub questions: Vec<Question>,
    /// How many questions are answered.
    pub answered: u32,
    /// Where its one submission is.
    pub submit: SubmitState,
    /// For a review: the plan it reviews. Submit names it. Empty otherwise.
    pub proposal: String,
    /// Whether an earlier save or submission was sent but not confirmed.
    /// Nothing more is sent until a check settles it.
    pub unconfirmed: bool,
    /// Room left for all answers together, in bytes. A save past it is refused.
    pub room: u32,
}

/// One earlier, submitted round.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub struct RoundLine {
    /// Stable.
    pub id: String,
    /// What it was, such as "Round 1".
    pub title: String,
    /// One line, such as "7 answers, submitted".
    pub line: String,
}

/// How a mission is planned.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub enum PlanRoute {
    /// One interview, then a plan.
    #[default]
    Interview,
    /// A map across sessions: questions, research and fog.
    Wayfinder,
}

/// What kind of exploration an item is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub enum ExploreKind {
    /// A choice only the user makes, through an interview.
    #[default]
    Grilling,
    /// Evidence an agent investigates.
    Research,
    /// A small, disposable experiment.
    Prototype,
}

/// Where an exploration item is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub enum ExploreState {
    /// It waits for other items first.
    #[default]
    Waiting,
    /// On the frontier: its prerequisites are resolved.
    Ready,
    /// An agent works on it.
    Running,
    /// Its interview waits for the user.
    Asking,
    /// Resolved, with a source.
    Resolved,
}

/// One precise question on the map.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub struct Exploration {
    /// Stable within the map.
    pub id: String,
    /// A short title.
    pub title: String,
    /// The precise question.
    pub question: String,
    /// Grilling, research or prototype.
    pub kind: ExploreKind,
    /// Where it is.
    pub state: ExploreState,
    /// Titles of the items it waits for.
    pub after: Vec<String>,
    /// Who works on it, while running.
    pub by: String,
    /// What resolved it, with its source, once resolved.
    pub result: String,
    /// Where it came from, such as a decision or Knowledge entry.
    pub sources: Vec<String>,
    /// The fog area it came from, if any.
    pub from_fog: String,
}

/// An area that is not understood well enough for precise questions yet.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub struct FogArea {
    /// Stable within the map.
    pub id: String,
    /// The area.
    pub area: String,
    /// Why it matters.
    pub why: String,
    /// What makes it ready to explore.
    pub ready_when: String,
    /// Titles of items it waits for. Fog never blocks work by itself.
    pub after: Vec<String>,
    /// Where it came from.
    pub sources: Vec<String>,
    /// Whether it is still fog. Promoted areas stay as history.
    pub active: bool,
    /// Titles of the precise questions it became.
    pub became: Vec<String>,
}

/// Whether prototypes can be made from this map.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub struct PrototypeSupport {
    /// Whether Pilot can make prototypes here.
    pub available: bool,
    /// One line about it.
    pub line: String,
}

/// One user story of a proposed spec.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub struct Story {
    /// Stable within the spec. Slices name it.
    pub id: String,
    /// The story.
    pub text: String,
}

/// A proposed spec, in full.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub struct Spec {
    /// The problem.
    pub problem: String,
    /// The solution.
    pub solution: String,
    /// User stories.
    pub stories: Vec<Story>,
    /// Implementation decisions.
    pub implementation: Vec<String>,
    /// Testing decisions.
    pub testing: Vec<String>,
    /// What is left out.
    pub exclusions: Vec<String>,
}

/// Who builds a slice.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub enum SliceOwner {
    /// The UI model.
    #[default]
    Ui,
    /// The backend model.
    Backend,
}

/// One proposed vertical slice, a future task.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub struct Slice {
    /// Stable within the proposal.
    pub id: String,
    /// A short title.
    pub title: String,
    /// What a user can see or check when it is done.
    pub outcome: String,
    /// Acceptance criteria.
    pub acceptance: Vec<String>,
    /// The stories it serves, by id.
    pub stories: Vec<String>,
    /// Titles of the slices it needs first.
    pub after: Vec<String>,
    /// Who builds it.
    pub owners: Vec<SliceOwner>,
}

/// A proposed plan: spec, slices and what is still unknown.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub struct Proposal {
    /// Changes whenever any part changes. A review names it.
    pub digest: String,
    /// The spec.
    pub spec: Spec,
    /// The slices, in order.
    pub slices: Vec<Slice>,
    /// Fog that is still unresolved, in words.
    pub open_fog: Vec<String>,
}

/// Where one step from answers to work is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub enum StepState {
    /// Not reached.
    #[default]
    Waiting,
    /// Happening now.
    Now,
    /// Done and confirmed.
    Done,
    /// Not confirmed. Only a check settles it.
    Unknown,
    /// This app cannot do it yet.
    Unavailable,
}

/// One step from answers to work. Each is separate: submitting is not
/// approval, approval is not publication, publication starts no work.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub struct Step {
    /// What it is, such as "Answers submitted".
    pub label: String,
    /// Where it is.
    pub state: StepState,
    /// One line, when there is more to say.
    pub line: String,
}

/// One mission's planning, in full.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub struct PlanPage {
    /// The mission.
    pub mission_id: String,
    /// The mission's title.
    pub title: String,
    /// Whether this mission's planning can be shown and answered here.
    pub available: bool,
    /// Why not, when unavailable. Empty otherwise.
    pub reason: String,
    /// Whether the read shown is the latest. An older read stays on screen.
    pub fresh: bool,
    /// The user's goal, as written on New.
    pub goal: String,
    /// How it is planned.
    pub route: PlanRoute,
    /// Where its planning is.
    pub stage: PlanStage,
    /// Where the mission should end up.
    pub destination: String,
    /// The interview that is open, if any.
    pub interview: Option<Interview>,
    /// Earlier, submitted rounds.
    pub rounds: Vec<RoundLine>,
    /// Precise questions, research and prototypes on the map.
    pub explorations: Vec<Exploration>,
    /// Whether prototypes can be made.
    pub prototypes: PrototypeSupport,
    /// Fog of war, active and promoted.
    pub fog: Vec<FogArea>,
    /// The proposed plan, once there is one.
    pub proposal: Option<Proposal>,
    /// From answers to work, each step separate.
    pub steps: Vec<Step>,
    /// One notice about a change, such as a plan that changed during review.
    pub note: String,
}

/// Start a mission interview, or a chat, from the user's words.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[prop(exact)]
pub struct NewIntent {
    /// What the user wants, exactly as written.
    pub goal: String,
    /// The setup's digest the screen showed.
    pub setup: String,
}

/// Save one answer as a draft. It never submits or starts anything.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[prop(exact)]
pub struct AnswerIntent {
    /// The interview.
    pub interview_id: String,
    /// The question list's revision the screen showed.
    pub question_set: u32,
    /// The question.
    pub question_id: String,
    /// The question's digest the screen showed.
    pub digest: String,
    /// The chosen suggestion, or null for none.
    pub choice_id: Option<String>,
    /// The user's own answer or added detail, exactly as written.
    pub text: String,
}

/// Submit an interview's saved answers, once.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[prop(exact)]
pub struct SubmitIntent {
    /// The interview.
    pub interview_id: String,
    /// The saved answers' revision the screen showed.
    pub revision: u32,
    /// For a review: the plan's digest the screen showed. Empty otherwise.
    pub proposal: String,
}

/// Name one interview.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[prop(exact)]
pub struct InterviewRef {
    /// The interview.
    pub interview_id: String,
}

/// What a planning intent did.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub struct PlanOutcome {
    /// Applied, stale, refused or unknown.
    pub status: OutcomeStatus,
    /// The planning read's revision after the intent.
    pub revision: u32,
    /// One sentence for the user. Empty when the read model says enough.
    pub message: String,
    /// The mission it made or changed, when there is one.
    pub mission_id: Option<String>,
}
