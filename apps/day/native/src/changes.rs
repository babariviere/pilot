//! The typed read model the Changes screens get, and the intents they send.
//! A kept change is one retained review snapshot: its exact bytes as Pilot
//! captured them, with the review, attention and landing history saved
//! for it. The snapshot is history; the attention state is current at the
//! read; a landing is the last time Pilot saw it on the default branch.
//! Reopening approves nothing, and Later is not approval.

use nsh_core::prelude::*;

use crate::model::Delivery;

/// Which mock world the Changes feed starts from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub enum ChangesScenario {
    /// Two changes wait for review, one is put off, others are kept, one
    /// landed and one kept change cannot be read.
    #[default]
    Review,
    /// The review world, but the first Later's answer is lost.
    Trouble,
    /// Kept changes can be read, and there are none yet.
    Empty,
    /// Pilot cannot read kept changes in this project.
    Unavailable,
    /// Many kept changes, read 20 at a time, and one very long diff.
    Large,
}

/// Whether the list of kept changes could be read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub enum ChangesAvailability {
    /// Read. An empty list means no change is kept yet.
    #[default]
    Available,
    /// Not readable here. This is never the same as no changes.
    Unavailable,
}

/// The review request on a kept change, as the latest read saw it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub enum ChangeAttention {
    /// No open review request.
    #[default]
    None,
    /// A review request waits for the user.
    Waiting,
    /// The user put the review off. It still waits.
    Later,
    /// The request was withdrawn, retired or replaced. History only.
    Closed,
    /// Pilot cannot tell the request's state. Nothing is assumed.
    Unknown,
}

/// The last landing check of a kept change.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub enum LandingState {
    /// Pilot has not checked. This does not mean it never landed.
    #[default]
    Unchecked,
    /// Pilot saw the exact commit on the default branch at that time.
    Seen,
    /// Not on the default branch when Pilot checked. Not proof it never landed.
    NotSeen,
    /// Pilot checked and could not tell.
    Unclear,
}

/// How much of a change Pilot kept.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub enum Completeness {
    /// Every file, as captured.
    #[default]
    Complete,
    /// Some files or bytes were not kept. The omissions say which.
    Partial,
    /// The bytes are not available.
    Unavailable,
}

/// What a review request intent asks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub enum AttentionAsk {
    /// Put the review off. It still waits; nothing is approved.
    #[default]
    Later,
    /// Bring a review the user put off back to waiting.
    BringBack,
}

/// One kept change in the list.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub struct ChangeRow {
    /// The kept snapshot. Exact; another snapshot of the same change has another id.
    pub snapshot_id: String,
    /// The review request's title, else the chat's title, else the change.
    pub title: String,
    /// The chat that made it, or empty when not known.
    pub chat: String,
    /// The change, shortened for reading.
    pub change: String,
    /// The captured head commit, shortened for reading.
    pub head: String,
    /// How long ago Pilot kept it, such as "2 h ago".
    pub captured: String,
    /// Whether Pilot kept all of it.
    pub completeness: Completeness,
    /// The review request now.
    pub attention: ChangeAttention,
    /// The last landing check.
    pub landing: LandingState,
    /// When Pilot saw it land, or last checked, such as "2 h ago". Empty when unchecked.
    pub landing_age: String,
    /// The branch Pilot checked, such as "main". Empty when unchecked.
    pub branch: String,
    /// Seen landed once, but a later check could not confirm it again.
    pub later_unclear: bool,
    /// Where the user's Later or Bring back is.
    pub delivery: Delivery,
}

/// Kept changes now, newest first within each group.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub struct ChangeList {
    /// Changes on every publish.
    pub revision: u32,
    /// Whether the list could be read.
    pub availability: ChangesAvailability,
    /// Why it could not be read. Empty when available.
    pub reason: String,
    /// Review requests that wait for the user.
    pub waiting: Vec<ChangeRow>,
    /// Reviews the user put off.
    pub later: Vec<ChangeRow>,
    /// Every other kept change: reviewed, landed or just kept.
    pub earlier: Vec<ChangeRow>,
    /// Kept changes in this read that could not be read. Kept as slots, never as empty.
    pub unreadable: u32,
    /// Changes still being captured.
    pub pending: u32,
    /// Captures that failed.
    pub failed: u32,
    /// More kept changes exist past this read.
    pub more: bool,
}

/// The exact identity of a kept snapshot. Every field is as captured.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub struct SnapshotIdentity {
    /// The snapshot.
    pub snapshot_id: String,
    /// Its place in the order Pilot kept snapshots.
    pub sequence: u32,
    /// The change, in full.
    pub change_id: String,
    /// The base commit, in full.
    pub base: String,
    /// The head commit, in full.
    pub head: String,
    /// "layer" for one change, "stack" for the change and those under it.
    pub scope: String,
    /// "committed" or "working copy".
    pub source: String,
    /// The kept patch's SHA-256, or empty when no patch was kept.
    pub diff: String,
    /// When Pilot kept it, as a date and time.
    pub captured_at: String,
}

/// How a file changed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub enum FileStatus {
    /// Changed in place.
    #[default]
    Modified,
    /// New.
    Added,
    /// Removed.
    Deleted,
    /// Moved, perhaps with changes.
    Renamed,
    /// Only its mode changed.
    Mode,
}

/// One changed file in a kept snapshot.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub struct ChangeFile {
    /// The file's name in the repository, after the change.
    pub name: String,
    /// Its name before a rename, or empty.
    pub old_name: String,
    /// How it changed.
    pub status: FileStatus,
    /// Lines added.
    pub added: u32,
    /// Lines removed.
    pub removed: u32,
    /// A binary file: no lines to show.
    pub binary: bool,
    /// Why the diff does not show its lines, or empty when it does.
    pub note: String,
}

/// What a review said, as saved. History: an approval here is not a current approval.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub enum Disposition {
    /// A comment.
    #[default]
    Comment,
    /// A request for changes.
    RequestChanges,
    /// An approval of this exact snapshot, at that time.
    Approve,
}

/// One saved review of a kept snapshot.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub struct ReviewLine {
    /// The saved review.
    pub id: String,
    /// What it said.
    pub disposition: Disposition,
    /// Its words, exactly as saved.
    pub body: String,
    /// How long ago, such as "yesterday".
    pub age: String,
}

/// One landing check, as saved. History, not a promise about today.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub struct LandingLine {
    /// The saved check.
    pub id: String,
    /// What it found.
    pub state: LandingState,
    /// How long ago, such as "2 h ago".
    pub age: String,
    /// The branch checked, or empty.
    pub branch: String,
    /// The branch's commit it was found in, shortened, or empty.
    pub commit: String,
    /// The pull request that carried it, as text, or empty for a direct push.
    pub pull_request: String,
    /// Why it could not tell, or empty.
    pub reason: String,
}

/// One review request on a kept snapshot, terminal ones included.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub struct RequestLine {
    /// The request.
    pub request_id: String,
    /// Its revision at the read.
    pub revision: u32,
    /// Its state at the read.
    pub attention: ChangeAttention,
    /// How long ago it last changed.
    pub age: String,
}

/// A completion an agent reported for this change. Its words, not landing proof.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub struct ReportedLine {
    /// The task it reported for.
    pub task: String,
    /// The commit it reported, shortened.
    pub commit: String,
    /// How long ago.
    pub age: String,
}

/// One kept change in full, reopened from its exact snapshot.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub struct ChangePage {
    /// Its row in the list.
    pub row: ChangeRow,
    /// The exact snapshot shown.
    pub identity: SnapshotIdentity,
    /// What was not kept, in words.
    pub omissions: Vec<String>,
    /// The changed files, as the manifest names them, with their line counts.
    pub files: Vec<ChangeFile>,
    /// The exact kept patch, checked against its saved digest, for a
    /// read-only diff. Empty when it is not shown; `diffNote` says why.
    pub patch: String,
    /// Why the diff is not shown, or empty when it is.
    pub diff_note: String,
    /// A newer kept snapshot of the same change, or null.
    pub newer: Option<String>,
    /// The open review request a Later or Bring back names, or null.
    pub request: Option<RequestLine>,
    /// Every review request on this snapshot, newest first.
    pub requests: Vec<RequestLine>,
    /// More requests exist than the read holds.
    pub requests_more: bool,
    /// Saved reviews, oldest first.
    pub reviews: Vec<ReviewLine>,
    /// More saved reviews exist past these.
    pub reviews_more: bool,
    /// Saved landing checks, oldest first.
    pub landings: Vec<LandingLine>,
    /// More landing checks exist past these.
    pub landings_more: bool,
    /// Completions agents reported, or empty.
    pub reported: Vec<ReportedLine>,
    /// Whether reported completions could be read.
    pub reported_known: bool,
    /// What the user's Later or Bring back asked.
    pub asked: Option<AttentionAsk>,
    /// How long ago Pilot read it.
    pub read: String,
}

/// Name one kept snapshot.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[prop(exact)]
pub struct ChangeRef {
    /// The kept snapshot.
    pub snapshot_id: String,
}

/// Put a review off, or bring it back, named as the screen showed it.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[prop(exact)]
pub struct AttentionIntent {
    /// The kept snapshot shown.
    pub snapshot_id: String,
    /// The review request shown.
    pub request_id: String,
    /// The request's revision shown.
    pub revision: u32,
}
