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
    /// The decisions world, but the service stopped answering 6 minutes ago.
    Offline,
    /// Nothing could be read, and there is no earlier read.
    Unreadable,
    /// One decision and one action only the user can take: a Chrome Web
    /// Store upload whose file is replaced once and whose first report is
    /// lost.
    Actions,
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

/// What a mission row says about the mission, most pressing first: its
/// control, then a decision it waits for, then its agents' reports.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub enum MissionState {
    /// A current agent report says it is moving.
    #[default]
    Moving,
    /// A current agent report says it is not moving.
    NotMoving,
    /// No current agent report: none yet, only old ones, or unavailable.
    /// Never read as not moving.
    Unreported,
    /// It waits for a decision from the user.
    Waiting,
    /// It stopped on a failure and needs a decision.
    Stuck,
    /// An earlier outcome, or a Pause or Resume, is not confirmed.
    Unconfirmed,
    /// Its work is stopping at safe points. Not paused yet.
    Pausing,
    /// Paused: nothing in it runs until the user resumes it.
    Paused,
    /// Its paused work is starting again.
    Resuming,
}

/// Whether Today shows a fresh read of the project.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub enum FreshnessState {
    /// The latest read is current.
    #[default]
    Live,
    /// The service answers, but the read shown is older than expected.
    Stale,
    /// The service does not answer. The last read is kept and shown.
    Offline,
    /// Nothing could be read. There is no earlier read to show.
    Unreadable,
    /// Saved on disk; not yet checked against this selected daemon.
    Cached,
    /// The source, protocol, capability or authoritative read cannot be used.
    Unavailable,
}

/// How fresh Today's read is. Controls need a live read.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub struct Freshness {
    /// Live, stale, offline or unreadable.
    pub state: FreshnessState,
    /// How old the read shown is, such as "6 min ago". Empty when nothing was read.
    pub age: String,
    /// Why it is not live, in a few words. Empty while live.
    pub reason: String,
}

/// Whether a report still describes its task's current owner and source.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub enum Currentness {
    /// It describes the task as it is now.
    #[default]
    Current,
    /// The task changed or the report is over a day old. It may no longer hold.
    Stale,
    /// It could not be read or checked.
    Unavailable,
}

/// An agent's own assessment of whether its task moves.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub enum Movement {
    /// The agent reports the task moving.
    #[default]
    Moving,
    /// The agent reports the task not moving.
    NotMoving,
    /// The agent could not tell, or the value is unknown.
    Unknown,
}

/// An agent's latest report on one task. Agent words, not verified proof.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub struct ReportLine {
    /// The task it reports on.
    pub task_id: String,
    /// Whether it still describes the task.
    pub currentness: Currentness,
    /// What the agent says about movement.
    pub movement: Movement,
    /// Whether the mission's coordinator wrote it, rather than a worker.
    pub by_coordinator: bool,
    /// How long ago it was written, such as "12 min ago".
    pub age: String,
    /// The agent's summary, exactly as written.
    pub summary: String,
    /// The agent's next step, exactly as written.
    pub next_step: String,
    /// References the agent named. Reported, not checked by Pilot.
    pub evidence: Vec<String>,
}

/// A mission's control, as the service last reported it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub enum ControlState {
    /// Not paused.
    #[default]
    Running,
    /// Work is stopping at safe points. Not paused yet.
    Pausing,
    /// Paused and acknowledged.
    Paused,
    /// Paused work is starting again.
    Resuming,
    /// The service cannot say.
    Unknown,
}

/// What a control request asks for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub enum ControlAsk {
    /// Pause all of the mission's work.
    #[default]
    Pause,
    /// Resume the work one Pause paused.
    Resume,
}

/// Where one member chat is in the last Pause or Resume.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub enum MemberState {
    /// Not reached yet.
    #[default]
    Pending,
    /// Being paused or resumed now.
    Entered,
    /// Paused at a safe point.
    Paused,
    /// Started again.
    Resumed,
    /// Held: it had nothing running, or another hold keeps it.
    Held,
    /// Its outcome is not known. It needs a look.
    Unknown,
}

/// One member chat in the last Pause or Resume.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub struct MemberLine {
    /// The chat, as the user knows it.
    pub title: String,
    /// Where it is.
    pub state: MemberState,
    /// Why, when the service said.
    pub reason: Option<String>,
}

/// A mission's Pause control, with the user's own request.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub struct ControlView {
    /// The control as the service last reported it.
    pub state: ControlState,
    /// Changes whenever the control changes. Pause and Resume name it.
    pub revision: u32,
    /// Whether a Pause still holds the mission's work.
    pub held: bool,
    /// While paused: the Pause a Resume must name.
    pub pause_operation_id: Option<String>,
    /// Where the user's own request is.
    pub delivery: Delivery,
    /// What the user's request asks, while it is sending, unknown or checking.
    pub asked: Option<ControlAsk>,
    /// Member chats in the last Pause or Resume this app saw.
    pub members: Vec<MemberLine>,
    /// Problems the service reported, exactly as written.
    pub issues: Vec<String>,
    /// Whether the last Pause or Resume ended with work that needs a look.
    pub needs_look: bool,
    /// Whether Pause can be asked now: a live read, nothing in flight, running.
    pub can_pause: bool,
    /// Whether Resume can be asked now: a live read, nothing in flight, paused.
    pub can_resume: bool,
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

/// Where an answer to the user's question is. Help never answers the
/// decision itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub enum AnswerState {
    /// Pilot is writing the answer.
    #[default]
    Asking,
    /// The answer is here.
    Ready,
    /// The question was saved, but no answer came back. Only a check reads
    /// it; nothing asks again.
    Unknown,
    /// Reading whether an answer was saved. Changes nothing.
    Checking,
}

/// A question the user asked about a decision, and Pilot's answer.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub struct Answer {
    /// Stable for the question's life. A check names it.
    pub id: String,
    /// The question, as the user wrote it.
    pub question: String,
    /// Pilot's answer. Empty until it is ready.
    pub answer: String,
    /// Where the answer is.
    pub state: AnswerState,
    /// Whether the decision changed after the question was asked, so the
    /// answer may not fit it any more.
    pub earlier: bool,
}

/// One bar of a decision's chart.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub struct Bar {
    /// What it counts.
    pub label: String,
    /// The count. Bars of one chart share a scale.
    pub value: u32,
}

/// A picture of the facts behind a decision. It explains; it never
/// answers.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub struct Visual {
    /// What the picture shows, in one sentence.
    pub explanation: String,
    /// The chart's bars.
    pub bars: Vec<Bar>,
    /// Where it comes from: the artifact and the exact revision it pins.
    pub source: String,
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
    /// A picture of the facts, when Pilot has one for this decision.
    pub visual: Option<Visual>,
    /// Questions the user asked, with Pilot's answers.
    pub answers: Vec<Answer>,
    /// Where the user's answer is.
    pub delivery: Delivery,
    /// The option the user sent, while it is sending or unknown.
    pub sent_option: Option<String>,
}

/// A file the user needs for an action, pinned to exact bytes.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub struct ActionFile {
    /// The file's name, such as "pilot-helper-1.4.2.zip".
    pub name: String,
    /// The version it holds.
    pub version: String,
    /// The start and end of its SHA-256, to compare with what the user has.
    pub digest: String,
}

/// Where the user takes the action.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub struct Destination {
    /// The place, as the user knows it.
    pub label: String,
    /// Its address, shown so the user can open it. Opening it completes
    /// nothing.
    pub link: String,
    /// The item or version there that the action is about.
    pub target: String,
}

/// Who asked for an action.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub struct Origin {
    /// The chat that asked.
    pub chat_title: String,
    /// The chat's address.
    pub chat_link: String,
    /// Its mission's title. Empty outside a mission.
    pub mission_title: String,
}

/// Whether an action waits now or was put off.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub enum ActionState {
    /// It waits for the user.
    #[default]
    Pending,
    /// The user put it off. It still waits.
    Deferred,
}

/// What the user asked of an action, while it is sending, unknown or
/// checking.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub enum ActionAsk {
    /// Save progress.
    #[default]
    Progress,
    /// Put it off.
    Later,
    /// Report it done.
    Complete,
}

/// Something only the user can do outside Pilot, such as an upload. Not a
/// decision and not an approval: Pilot waits for the user's report.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub struct HumanAction {
    /// Stable for the action's life.
    pub id: String,
    /// Changes whenever the action changes. Intents name it.
    pub revision: u32,
    /// What to do, as a title.
    pub title: String,
    /// Why Pilot needs the user for it.
    pub why: String,
    /// The one next step, in a sentence.
    pub next_step: String,
    /// How long it takes.
    pub effort: String,
    /// The files to use, pinned to exact bytes.
    pub files: Vec<ActionFile>,
    /// Where to do it.
    pub destination: Destination,
    /// Who asked.
    pub origin: Origin,
    /// What the user reports back when done. Empty when a plain "done"
    /// is enough.
    pub needs: Vec<String>,
    /// The progress the user saved, exactly as written.
    pub progress: String,
    /// Waiting now, or put off.
    pub state: ActionState,
    /// Set when Pilot replaced the request since the user last saw it,
    /// saying what changed.
    pub replaced: Option<String>,
    /// Where the user's last request is.
    pub delivery: Delivery,
    /// What that request asks, while it is sending, unknown or checking.
    pub asked: Option<ActionAsk>,
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
    /// Its current stage, such as "History and images". Empty when unknown.
    pub stage: String,
    /// Its tasks by state.
    pub progress: Progress,
    /// The newest current report, else the newest report. None before any.
    pub report: Option<ReportLine>,
    /// Its Pause control.
    pub control: ControlView,
    /// Member chats working now. Activity, not progress.
    pub working: u32,
}

/// A task of a mission, with its agent's latest report.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub struct TaskLine {
    /// Stable for the task's life.
    pub id: String,
    /// The task's number in its mission.
    pub number: u32,
    /// The task's title.
    pub title: String,
    /// Its status, as the mission records it.
    pub status: TaskStatus,
    /// Its agent's latest report, if any.
    pub report: Option<ReportLine>,
}

/// A task's status, as the mission records it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub enum TaskStatus {
    /// Not started.
    #[default]
    Todo,
    /// Being worked on.
    InProgress,
    /// Stopped.
    Blocked,
    /// Waiting for review.
    InReview,
    /// Someone else owns it.
    Delegated,
    /// Done.
    Done,
    /// A status this build does not know.
    Unknown,
}

/// A chat working on a mission now. Supporting detail, not progress.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub struct ChatLine {
    /// Stable for the chat's life.
    pub id: String,
    /// The chat's title.
    pub title: String,
    /// When its current work started, such as "12 min ago".
    pub since: String,
}

/// One mission in full: its row, tasks, reports, control and chats.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub struct MissionPage {
    /// The same row Today shows.
    pub row: MissionRow,
    /// What the mission is for. Empty when unknown.
    pub goal: String,
    /// Whether the task list could be read.
    pub tasks_known: bool,
    /// Its tasks in order, dropped tasks left out.
    pub tasks: Vec<TaskLine>,
    /// Chats working on it now.
    pub chats: Vec<ChatLine>,
    /// How fresh the read is.
    pub freshness: Freshness,
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
    /// What only the user can do outside Pilot, in order. Shown with the
    /// decisions, but they are actions, not approvals.
    pub actions: Vec<HumanAction>,
    /// How fresh the read is. Everything below is from that read.
    pub freshness: Freshness,
    /// Missions a current agent report says are moving.
    pub moving: Vec<MissionRow>,
    /// Missions a current agent report says are not moving, and paused or
    /// pausing missions.
    pub not_moving: Vec<MissionRow>,
    /// Missions with no current report. Not the same as not moving.
    pub unreported: Vec<MissionRow>,
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
    /// The decision's revision the screen showed.
    pub revision: u32,
    /// The question, as the user wrote it.
    pub question: String,
}

/// Name one question about a decision.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[prop(exact)]
pub struct AnswerRef {
    /// The decision.
    pub decision_id: String,
    /// The question.
    pub answer_id: String,
}

/// Name one action at the revision the screen showed.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[prop(exact)]
pub struct ActionRef {
    /// The action.
    pub action_id: String,
    /// The action's revision the screen showed.
    pub revision: u32,
}

/// Save the user's progress on an action. It does not complete it.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[prop(exact)]
pub struct ProgressIntent {
    /// The action.
    pub action_id: String,
    /// The action's revision the screen showed.
    pub revision: u32,
    /// The progress, exactly as written.
    pub progress: String,
}

/// Report an action done. The user's report, not proof it worked.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[prop(exact)]
pub struct CompleteIntent {
    /// The action.
    pub action_id: String,
    /// The action's revision the screen showed.
    pub revision: u32,
    /// What the user did, exactly as written.
    pub report: String,
}

/// Name one action, to check its last request.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[prop(exact)]
pub struct ActionCheck {
    /// The action.
    pub action_id: String,
}

/// Pause all of a mission's work.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[prop(exact)]
pub struct PauseIntent {
    /// The mission.
    pub mission_id: String,
    /// The control's revision the screen showed.
    pub revision: u32,
}

/// Resume the work one Pause paused.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[prop(exact)]
pub struct ResumeIntent {
    /// The mission.
    pub mission_id: String,
    /// The control's revision the screen showed.
    pub revision: u32,
    /// The Pause the screen showed. Only its work resumes.
    pub pause_operation_id: String,
}

/// Name one mission.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[prop(exact)]
pub struct MissionRef {
    /// The mission.
    pub mission_id: String,
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
