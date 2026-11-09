//! Serde mirrors of the daemon's v1 kept-change contracts:
//! `LandedChangesPage` and `LandedChangeHistory`
//! (`packages/protocol/src/landed-changes.ts`), the review request page
//! (`review-requests.ts`), the retained comparison and snapshot
//! (`native-review.ts`) and the retained patch read. Only the fields the
//! Changes screens read are declared; unknown fields are ignored. Unknown
//! states read as unrecognized, never as a confident state.
//!
//! These types stay in Rust. TSX gets the projected read model in
//! [`crate::changes`].

use serde::{Deserialize, Serialize};

/// `NativeReviewComparison`: one retained comparison.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Comparison {
    pub snapshot_id: String,
    pub sequence: u64,
    pub captured_at: u64,
    pub request: ComparisonRequest,
    pub status: CaptureState,
}

/// The exact comparison a snapshot was captured for.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComparisonRequest {
    pub request_id: String,
    pub repository_id: String,
    pub change_id: String,
    pub operation_id: String,
    pub base: Revision,
    pub head: Revision,
    pub scope: Scope,
    pub source: String,
}

/// A change and its commit.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Revision {
    pub change_id: String,
    pub commit_id: String,
}

/// Layer or stack.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Scope {
    pub kind: String,
}

/// How much of a comparison was kept.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CaptureState {
    Complete,
    Partial,
    Unavailable,
    #[serde(other)]
    Unrecognized,
}

/// `ReviewDispositionTarget`: the exact feedback target of a snapshot.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub project_id: String,
    pub session_id: String,
    pub snapshot_id: String,
    pub repository_id: String,
    pub change_id: String,
    pub base_commit_id: String,
    pub head_commit_id: String,
    pub layer: String,
    pub diff_sha256: String,
    pub comparison_digest: String,
}

/// What a landing check found.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LandingStatus {
    Unknown,
    Stale,
    Observed,
    NotContained,
    #[serde(other)]
    Unrecognized,
}

/// `ChangeLandingResult`, flattened: observation fields are present only
/// for `observed` and `not-contained`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LandingResult {
    pub status: LandingStatus,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub observed_at: Option<u64>,
    #[serde(default)]
    pub default_ref: Option<String>,
    #[serde(default)]
    pub integrated_commit_id: Option<String>,
    #[serde(default)]
    pub producer: Option<Producer>,
}

/// Who observed the landing: default-branch containment or a pull request.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Producer {
    pub kind: String,
    #[serde(default)]
    pub url: Option<String>,
}

/// `ChangeLandingRecord`: one saved landing check.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LandingRecord {
    pub observation_id: String,
    pub sequence: u64,
    pub target: Target,
    pub recorded_at: u64,
    pub result: LandingResult,
}

/// `LandedChangeRow`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeRow {
    pub comparison: Comparison,
    pub target: Target,
    pub landing: Option<LandingRecord>,
    pub observed_landing: Option<LandingRecord>,
}

/// A slot for a kept change whose source could not be read.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnavailableSlot {
    pub snapshot_id: String,
    pub sequence: u64,
    pub unavailable: bool,
}

/// One entry of a page: a readable row, or a slot that keeps its place.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(untagged)]
pub enum PageEntry {
    Slot(UnavailableSlot),
    Row(Box<ChangeRow>),
}

/// `NativeReviewCaptureStatus`.
#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureStatus {
    pub pending: u32,
    pub failed: u32,
    #[serde(default)]
    pub unavailable: Option<String>,
    #[serde(default)]
    pub unsupported: Option<Vec<String>>,
}

/// `LandedChangesPage`: at most 20 retained comparisons.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangesPage {
    /// Only 1 is read. Another version is refused, not guessed.
    pub version: u32,
    /// Only `retained-comparisons-only` is read.
    pub scope: String,
    pub status: String,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub capture: Option<CaptureStatus>,
    pub changes: Vec<PageEntry>,
    pub next: Option<u64>,
}

/// `ReviewRequestState`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RequestState {
    Pending,
    Snoozed,
    Withdrawn,
    Retired,
    Replaced,
    #[serde(other)]
    Unrecognized,
}

/// `ReviewRequestRow`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestRow {
    pub project_id: String,
    pub request_id: String,
    pub sequence: u64,
    pub state: RequestState,
    pub session_id: String,
    pub title: String,
    pub comparison: Comparison,
}

/// `UnavailableReviewRequestRow`: no source details are disclosed.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnavailableRequest {
    pub request_id: String,
    pub sequence: u64,
    pub state: RequestState,
    pub unavailable: bool,
}

/// One entry of the review request page.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(untagged)]
pub enum RequestEntry {
    Unavailable(UnavailableRequest),
    Row(Box<RequestRow>),
}

/// `ReviewRequestPage`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct RequestPage {
    pub requests: Vec<RequestEntry>,
    pub next: Option<u64>,
}

/// `NativeReviewSource`: one file side as kept.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub path: String,
    pub state: String,
    #[serde(default)]
    pub reason: Option<String>,
}

/// One changed file in the snapshot manifest.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotChange {
    pub status: String,
    pub before_path: Option<String>,
    pub after_path: Option<String>,
}

/// The kept patch's digest and size.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct DiffRef {
    pub sha256: String,
    pub bytes: u64,
}

/// `NativeReviewSnapshot`: the exact manifest.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub snapshot_id: String,
    pub request: ComparisonRequest,
    pub status: CaptureState,
    pub captured_at: u64,
    pub omissions: Vec<String>,
    pub before: Vec<Source>,
    pub after: Vec<Source>,
    pub changes: Vec<SnapshotChange>,
    pub diff: Option<DiffRef>,
}

/// `ChangeReportedCommits`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Reported {
    pub status: String,
    #[serde(default)]
    pub claims: Vec<ReportedClaim>,
}

/// One reported completion claim.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportedClaim {
    pub task_id: String,
    pub commit: String,
    pub recorded_at: u64,
}

/// A page of history records with its own cursor.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Paged<T> {
    pub records: Vec<T>,
    pub next: Option<u64>,
}

/// What a saved review said.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Disposition {
    Comment,
    RequestChanges,
    Approve,
    #[serde(other)]
    Unrecognized,
}

/// The confirmed review package, as saved.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Confirmed {
    pub targets: Vec<Target>,
    pub disposition: Disposition,
    pub body: String,
}

/// `HumanReviewRecord`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewRecord {
    pub id: String,
    pub operation_id: String,
    pub created_at: u64,
    pub confirmed: Confirmed,
}

/// One review record with its sequence.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct ReviewEntry {
    pub sequence: u64,
    pub record: ReviewRecord,
}

/// `ChangeAttention`: one review request's exact current state.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attention {
    pub request_id: String,
    pub revision: u32,
    pub state: RequestState,
    pub operation_id: String,
    pub updated_at: u64,
}

/// Attention records with the 100-request bound flag.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct AttentionRecords {
    pub records: Vec<Attention>,
    pub complete: bool,
}

/// `LandedChangeHistory`: one snapshot reopened.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct History {
    pub version: u32,
    pub comparison: Comparison,
    pub snapshot: Snapshot,
    pub target: Target,
    pub reported: Reported,
    pub landing: Paged<LandingRecord>,
    pub reviews: Paged<ReviewEntry>,
    pub attention: AttentionRecords,
    /// Always `not-evaluated`: history never authorizes approval.
    pub approval: String,
}

/// The retained patch read: `{ snapshotId, patch }`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetainedPatch {
    pub snapshot_id: String,
    pub patch: String,
}
