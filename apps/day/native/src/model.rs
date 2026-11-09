//! The typed read models Rust gives the TSX Today screen, and the intents
//! the screen sends back. TSX sees these as TypeScript interfaces and string
//! unions generated from the Rust types; it never sees a transport, a
//! daemon client or storage.

use nsh_core::prelude::*;

/// Which mock world the feed starts from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub enum Scenario {
    /// Three short decisions wait; one mission is moving.
    #[default]
    Decisions,
    /// Nothing waits; two missions are moving.
    Quiet,
    /// A failure and an unconfirmed push wait; one mission is paused.
    Trouble,
    /// Many missions and results, for scrolling and memory checks.
    Large,
}

/// What a decision asks for. It decides which actions the card offers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub enum DecisionKind {
    /// A choice between options.
    #[default]
    Choice,
    /// Permission for one action outside the agreed scope.
    Approval,
    /// A finished change that waits for review.
    Review,
    /// Work that stopped on a failure.
    Failure,
    /// An outcome Pilot could not confirm. Only a check can settle it.
    Unknown,
}

/// Where the user's answer to a decision is. Only Rust changes it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub enum Delivery {
    /// Nothing sent yet.
    #[default]
    Idle,
    /// Sent; waiting for the coordinator to confirm.
    Sending,
    /// Sent, but no confirmation came back. Pilot never sends it again
    /// without a check.
    Unknown,
    /// Reading whether an earlier send or push landed. Changes nothing.
    Checking,
}

/// How strongly a piece of evidence asks for attention.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub enum Tone {
    /// Ordinary evidence.
    #[default]
    Neutral,
    /// Evidence that is not confirmed yet.
    Warn,
    /// Evidence of a failure.
    Bad,
}

/// Whether a mission is moving, and if not, why.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub enum MissionState {
    /// Agents are working on it.
    #[default]
    Moving,
    /// It waits for a decision from the user.
    Waiting,
    /// It stopped on a failure and needs a decision.
    Stuck,
    /// It waits until an earlier outcome is confirmed.
    Unconfirmed,
    /// It is paused until a set time or until the user resumes it.
    Paused,
    /// It starts later today.
    Later,
}

/// What an intent did.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub enum OutcomeStatus {
    /// Rust applied it, and the read model shows the result.
    #[default]
    Accepted,
    /// The decision changed since the screen read it. Nothing was done.
    Stale,
    /// Rust refused it. Nothing was done.
    Rejected,
    /// It was sent, but its result is not known. Nothing will resend it.
    Unknown,
}

/// One piece of evidence: a commit, a check, a chart.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub struct Evidence {
    /// What it is, in a few words.
    pub label: String,
    /// How strongly it asks for attention.
    pub tone: Tone,
}

/// One answer the user can give to a decision.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub struct DecisionOption {
    /// Stable within its decision.
    pub id: String,
    /// What choosing it means, in a few words.
    pub label: String,
    /// Its consequence, in one line.
    pub detail: String,
    /// Whether Pilot recommends it. At most one option per decision.
    pub recommended: bool,
}

/// A question the user asked about a decision, and Pilot's answer.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub struct Answer {
    /// The question, as the user wrote it.
    pub question: String,
    /// Pilot's answer.
    pub answer: String,
}

/// Something only the user can decide.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub struct Decision {
    /// Stable for the decision's life.
    pub id: String,
    /// Changes whenever the decision changes. Intents name the revision
    /// they acted on.
    pub revision: u32,
    /// What it asks for.
    pub kind: DecisionKind,
    /// The question, as a title.
    pub title: String,
    /// Why it stopped, in a few words.
    pub reason: String,
    /// The mission it belongs to.
    pub mission_id: String,
    /// The mission's title.
    pub mission_title: String,
    /// How long it takes to decide.
    pub effort: String,
    /// What the user needs to know.
    pub context: String,
    /// The same, in simpler words.
    pub simpler: String,
    /// More context, one point per line.
    pub more: Vec<String>,
    /// Why Pilot could not decide alone.
    pub boundary: String,
    /// What Pilot already tried.
    pub tried: Vec<String>,
    /// The answers the user can give. Empty for an unconfirmed outcome.
    pub options: Vec<DecisionOption>,
    /// What the evidence is.
    pub evidence: Vec<Evidence>,
    /// What was sent or pushed, when the user asks.
    pub details: Option<String>,
    /// Questions the user asked, with Pilot's answers.
    pub answers: Vec<Answer>,
    /// Where the user's answer is.
    pub delivery: Delivery,
    /// The option the user sent, while it is sending or unknown.
    pub sent_option: Option<String>,
}

/// How much of a mission is done, by task state.
#[derive(Debug, Clone, Copy, Default, PartialEq, JsObject)]
pub struct Progress {
    /// Tasks done.
    pub done: u32,
    /// Tasks in review.
    pub review: u32,
    /// Tasks being worked on.
    pub active: u32,
    /// Tasks that stopped.
    pub blocked: u32,
    /// Tasks not started.
    pub todo: u32,
}

/// One mission on Today.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub struct MissionRow {
    /// Stable for the mission's life.
    pub id: String,
    /// The mission's title.
    pub title: String,
    /// Whether it is moving, and if not, why.
    pub state: MissionState,
    /// What it does or waits for now, in one line.
    pub line: String,
    /// The decision it waits for, if any.
    pub decision_id: Option<String>,
    /// Its current stage, such as "Stage 2 of 5 · History and images".
    pub stage: String,
    /// Its tasks by state.
    pub progress: Progress,
}

/// One result since the user last looked.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub struct DoneEntry {
    /// Stable for the entry's life.
    pub id: String,
    /// What happened, in one sentence.
    pub text: String,
    /// The mission it came from.
    pub mission_title: String,
    /// What shows it happened.
    pub evidence: Vec<Evidence>,
}

/// Something scheduled to happen.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub struct Scheduled {
    /// Stable for the schedule's life.
    pub id: String,
    /// What will happen.
    pub text: String,
    /// When, as the user reads it.
    pub when: String,
    /// Who set it and why, when Pilot set it.
    pub note: Option<String>,
}

/// Everything the Today screen shows. Rust owns it; TSX keeps a mirror.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub struct Today {
    /// Changes whenever anything below changes.
    pub revision: u32,
    /// The date and time the screen was read, as the user reads it.
    pub date_line: String,
    /// The coordinators' one-line summary of the day.
    pub headline: String,
    /// Two or three sentences about what changed.
    pub summary: String,
    /// Where the user left off, if they did.
    pub left_off: Option<String>,
    /// Confirmed results of the user's own actions, newest last.
    pub notes: Vec<String>,
    /// What waits for the user, in order.
    pub decisions: Vec<Decision>,
    /// Missions that agents are working on.
    pub moving: Vec<MissionRow>,
    /// Missions that wait, are paused or start later.
    pub not_moving: Vec<MissionRow>,
    /// When the user last looked, such as "at 09:15".
    pub last_looked: String,
    /// Results since the user last looked. Limited to the newest 20.
    pub done: Vec<DoneEntry>,
    /// How many older results are not in `done`.
    pub done_hidden: u32,
    /// Missions that finished.
    pub finished: Vec<String>,
    /// What happens next, by time.
    pub coming_up: Vec<Scheduled>,
}

/// Answer a decision with one of its options.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[prop(exact)]
pub struct DecideIntent {
    /// The decision.
    pub decision_id: String,
    /// The decision's revision the screen showed.
    pub revision: u32,
    /// The chosen option.
    pub option_id: String,
}

/// Name one decision at the revision the screen showed.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[prop(exact)]
pub struct DecisionRef {
    /// The decision.
    pub decision_id: String,
    /// The decision's revision the screen showed.
    pub revision: u32,
}

/// Ask Pilot a question about a decision.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[prop(exact)]
pub struct AskIntent {
    /// The decision.
    pub decision_id: String,
    /// The question, as the user wrote it.
    pub question: String,
}

/// What an intent did.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub struct IntentOutcome {
    /// Applied, stale, refused or unknown.
    pub status: OutcomeStatus,
    /// The read model's revision after the intent.
    pub revision: u32,
    /// One sentence for the user. Empty when the read model says enough.
    pub message: String,
}
