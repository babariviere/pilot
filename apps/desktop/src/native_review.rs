//! Exact retained identity and bounded wire decoding, independent of view state.
use gpui_kit::component::diff::{DiffFile, DiffFileStatus};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

pub(crate) const WIRE_CAP: usize = 24 * 1024 * 1024;
pub(crate) const INVALID: &str =
    "Malformed or partial retained comparison. No live fallback was attempted.";

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct Revision {
    pub change_id: String,
    pub commit_id: String,
}
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct Scope {
    pub kind: String,
}
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct Capture {
    pub request_id: String,
    pub repository_id: String,
    pub change_id: String,
    pub operation_id: String,
    pub base: Revision,
    pub head: Revision,
    pub scope: Scope,
    pub source: String,
}
impl Capture {
    pub fn valid(&self) -> bool {
        crate::local_model::valid_id(&self.request_id)
            && hex(&self.repository_id, 64)
            && change(&self.change_id)
            && hex(&self.operation_id, 128)
            && change(&self.base.change_id)
            && hex(&self.base.commit_id, 40)
            && self.head.change_id == self.change_id
            && hex(&self.head.commit_id, 40)
            && matches!(self.scope.kind.as_str(), "layer" | "stack")
            && matches!(self.source.as_str(), "committed" | "working-copy")
    }
}
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct Comparison {
    pub snapshot_id: String,
    pub sequence: u64,
    pub captured_at: u64,
    pub request: Capture,
    pub status: String,
}
impl Comparison {
    pub fn label(&self) -> String {
        format!(
            "{} · Saved revision {}",
            if self.request.scope.kind == "layer" {
                "This change"
            } else {
                "Stack"
            },
            self.sequence
        )
    }
    pub fn valid(&self) -> bool {
        hex(&self.snapshot_id, 64)
            && self.sequence > 0
            && self.request.valid()
            && status(&self.status)
    }
}
/// One explicit request to review an exact saved revision. The chat and project are
/// custody for exact reads and context for people, never the owner of the review.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct ReviewRequest {
    pub request_id: String,
    /// The request's own sequence, for the list cursor; not the revision's.
    pub sequence: u64,
    pub state: String,
    /// Whether required checks and agent reviews allow human approval yet.
    pub actionability: String,
    pub project_id: String,
    pub session_id: String,
    pub title: String,
    pub comparison: Comparison,
}
impl ReviewRequest {
    pub fn valid(&self) -> bool {
        crate::local_model::valid_id(&self.request_id)
            && self.sequence > 0
            && !self.state.is_empty()
            && self.state.len() <= 64
            && matches!(self.actionability.as_str(), "waiting" | "ready" | "unknown")
            && crate::local_model::valid_id(&self.project_id)
            && crate::local_model::valid_id(&self.session_id)
            && self.title.len() <= 8192
            && self.comparison.valid()
    }
    /// The request's exact state, and for a pending request whether approval is actionable
    /// yet. Pending never implies ready; history is never waiting or ready.
    pub fn status(&self) -> &'static str {
        match (self.state.as_str(), self.actionability.as_str()) {
            ("pending", "ready") => "Ready for review",
            ("pending", "waiting") => "Waiting on checks and agent review",
            ("pending", _) => "Pending · readiness unknown",
            ("snoozed", _) => "Snoozed · still open",
            ("withdrawn", _) => "Withdrawn · history",
            ("retired", _) => "Retired · history",
            ("replaced", _) => "Replaced by another request · history",
            _ => "Status unknown",
        }
    }
}
/// A request the host lists but whose source it couldn't read at this read point. It keeps
/// its place in the list; no title, chat, project, revision or readiness is disclosed.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct UnavailableRequest {
    pub request_id: String,
    pub sequence: u64,
    pub state: String,
    pub unavailable: bool,
}
/// One listed request slot: readable, or unavailable with only its identity and state.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(untagged)]
pub(crate) enum Row {
    Request(Box<ReviewRequest>),
    Unavailable(UnavailableRequest),
}
impl Row {
    pub fn request_id(&self) -> &str {
        match self {
            Self::Request(r) => &r.request_id,
            Self::Unavailable(r) => &r.request_id,
        }
    }
    pub fn sequence(&self) -> u64 {
        match self {
            Self::Request(r) => r.sequence,
            Self::Unavailable(r) => r.sequence,
        }
    }
    pub fn state(&self) -> &str {
        match self {
            Self::Request(r) => &r.state,
            Self::Unavailable(r) => &r.state,
        }
    }
    pub fn request(&self) -> Option<&ReviewRequest> {
        match self {
            Self::Request(r) => Some(r.as_ref()),
            Self::Unavailable(_) => None,
        }
    }
    pub fn valid(&self) -> bool {
        match self {
            Self::Request(r) => r.valid(),
            Self::Unavailable(r) => {
                crate::local_model::valid_id(&r.request_id)
                    && r.sequence > 0
                    && !r.state.is_empty()
                    && r.state.len() <= 64
                    && r.unavailable
            }
        }
    }
    /// The row's status line. An unavailable row names only its state.
    pub fn status(&self) -> String {
        match self {
            Self::Request(r) => r.status().into(),
            Self::Unavailable(r) => format!(
                "Unavailable · {}",
                state_name(&r.state).unwrap_or("status unknown")
            ),
        }
    }
    /// Open (pending or snoozed), history (withdrawn, retired or replaced), or unknown.
    pub fn open(&self) -> Option<bool> {
        state_name(self.state()).map(|_| is_open(self.state()))
    }
}
fn state_name(state: &str) -> Option<&'static str> {
    Some(match state {
        "pending" => "Pending",
        "snoozed" => "Snoozed",
        "withdrawn" => "Withdrawn",
        "retired" => "Retired",
        "replaced" => "Replaced",
        _ => return None,
    })
}
fn is_open(state: &str) -> bool {
    matches!(state, "pending" | "snoozed")
}
impl Comparison {
    /// `other` is a later saved revision of the same change and scope.
    pub fn superseded_by(&self, other: &Self) -> bool {
        self.request.repository_id == other.request.repository_id
            && self.request.change_id == other.request.change_id
            && self.request.scope == other.request.scope
            && other.sequence > self.sequence
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Comparisons {
    pub comparisons: Vec<Comparison>,
    pub next: Option<u64>,
    pub unavailable: Option<String>,
    pub capture: Option<CaptureStatus>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CaptureStatus {
    pub pending: u64,
    pub failed: u64,
    pub unavailable: Option<String>,
    pub unsupported: Option<Vec<String>>,
}
impl CaptureStatus {
    pub fn valid(&self) -> bool {
        self.pending.saturating_add(self.failed) <= 10_000
            && self
                .unavailable
                .as_deref()
                .is_none_or(|s| matches!(s, "not-enabled" | "observation-failed"))
            && self.unsupported.as_ref().is_none_or(|reasons| {
                reasons.len() <= 7
                    && reasons.iter().all(|s| {
                        matches!(
                            s.as_str(),
                            "divergent"
                                | "multiple-parents"
                                | "root-base"
                                | "missing"
                                | "unknown-custody"
                                | "unknown-discovery"
                                | "conflicted"
                        )
                    })
            })
    }
    pub fn notice(&self) -> Option<&'static str> {
        match self.unavailable.as_deref() {
            Some("not-enabled") => {
                return Some(
                    "Automatic capture isn't enabled for this existing workspace. Reading Review doesn't enroll or migrate it.",
                );
            }
            Some("observation-failed") => {
                return Some(
                    "Worker ownership couldn't be observed. No new revision was saved; existing saved revisions are unchanged.",
                );
            }
            _ => {}
        }
        let reasons = self.unsupported.as_deref().unwrap_or_default();
        if reasons.iter().any(|s| s == "conflicted") {
            return Some(
                "Conflicted revisions couldn't be saved for Review. No conflict-free or newer content was substituted.",
            );
        }
        if self.failed > 0 {
            return Some(
                "Saving some committed revisions couldn't be confirmed. They remain queued for exact recovery at the next worker checkpoint; existing saved revisions are unchanged.",
            );
        }
        if !reasons.is_empty() {
            return Some(
                "Some revisions aren't supported by this checkpoint. Details explains what couldn't be proven or saved; existing saved revisions are unchanged.",
            );
        }
        if self.pending > 0 {
            return Some(
                "Committed revisions are waiting to be saved at a worker checkpoint. Refresh later to read saved revisions.",
            );
        }
        None
    }
    pub fn limitations(&self) -> Vec<&'static str> {
        self.unsupported.as_deref().unwrap_or_default().iter().map(|s| match s.as_str() {
            "divergent" => "Divergent change revisions aren't captured. No revision was chosen as a winner.",
            "multiple-parents" => "Multi-parent revisions aren't supported by the single-layer checkpoint.",
            "root-base" => "Comparisons against the virtual root aren't supported.",
            "missing" => "Some previously owned changes are absent at the observed operation.",
            "unknown-custody" => "Some creation claims have unknown or colliding custody and weren't captured.",
            "unknown-discovery" => "Ownership discovery skipped an unprovable interval. Missing changes aren't inferred.",
            "conflicted" => "Conflicted revisions aren't supported for retained capture.",
            _ => "Unsupported capture status.",
        }).collect()
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Requests {
    pub requests: Vec<Row>,
    pub next: Option<u64>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct Source {
    pub path: String,
    pub mode: String,
    pub git_oid: String,
    pub state: String,
    pub sha256: Option<String>,
    pub bytes: Option<u64>,
    pub reason: Option<String>,
}
impl Source {
    fn valid(&self) -> bool {
        path(&self.path)
            && hex(&self.git_oid, 40)
            && matches!(
                self.mode.as_str(),
                "100644" | "100755" | "120000" | "160000"
            )
            && match self.state.as_str() {
                "text" | "binary" => {
                    self.sha256.as_deref().is_some_and(|s| hex(s, 64))
                        && self.bytes.is_some_and(|b| b <= 2 * 1024 * 1024)
                        && self.reason.is_none()
                        && self.mode.starts_with("100")
                }
                "unavailable" => {
                    self.sha256.is_none()
                        && self.reason.as_deref().is_some_and(|s| {
                            matches!(
                                s,
                                "blob-limit"
                                    | "total-limit"
                                    | "object-unavailable"
                                    | "symlink"
                                    | "submodule"
                            )
                        })
                }
                _ => false,
            }
    }
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct Change {
    pub status: String,
    pub before_path: Option<String>,
    pub after_path: Option<String>,
    pub before_mode: String,
    pub after_mode: String,
    pub before_oid: String,
    pub after_oid: String,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct Creation {
    pub change_id: String,
    pub commit_id: String,
    pub operation_id: String,
    pub kind: String,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Patch {
    pub sha256: String,
    pub bytes: usize,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct Snapshot {
    pub snapshot_id: String,
    pub request: Capture,
    pub worker_id: String,
    pub status: String,
    pub captured_at: u64,
    pub enrollment_task_ids: Vec<String>,
    /// Set only by project-owned (v2) captures, which have no task scope.
    #[serde(default)]
    pub enrollment_project_id: Option<String>,
    pub creation: Creation,
    pub omissions: Vec<String>,
    pub before: Vec<Source>,
    pub after: Vec<Source>,
    pub changes: Vec<Change>,
    pub diff: Option<Patch>,
}
impl Snapshot {
    /// `project` is the current project of the reviewed change's chat. A project-owned
    /// capture must name exactly that project and carry no task scope; a mission capture
    /// keeps a nonempty task scope and no project marker. Anything else is refused.
    pub fn validate(
        &self,
        worker: &str,
        project: &str,
        selected: &Comparison,
    ) -> Result<(), &'static str> {
        let enrollment = match &self.enrollment_project_id {
            Some(p) => {
                crate::local_model::valid_id(p)
                    && p == project
                    && self.enrollment_task_ids.is_empty()
            }
            None => !self.enrollment_task_ids.is_empty(),
        };
        if self.snapshot_id != selected.snapshot_id
            || self.worker_id != worker
            || self.request != selected.request
            || self.captured_at != selected.captured_at
            || self.status != selected.status
            || !self.request.valid()
            || !status(&self.status)
            || !enrollment
            || self.enrollment_task_ids.len() > 100
            || self
                .enrollment_task_ids
                .iter()
                .any(|s| !crate::local_model::valid_id(s))
            || self.creation.change_id != self.request.change_id
            || !hex(&self.creation.commit_id, 40)
            || !hex(&self.creation.operation_id, 128)
            || !matches!(
                self.creation.kind.as_str(),
                "workspace-created" | "workspace-operation"
            )
            || self.omissions.len() > 100
            || self.omissions.iter().any(|s| s.len() > 8000)
            || self.changes.len() > 8192
        {
            return Err(INVALID);
        }
        for entries in [&self.before, &self.after] {
            let mut paths = BTreeSet::new();
            if entries.len() > 4096 || entries.iter().any(|e| !e.valid() || !paths.insert(&e.path))
            {
                return Err(INVALID);
            }
        }
        for c in &self.changes {
            if (c.status == "A") != c.before_path.is_none()
                || (c.status == "D") != c.after_path.is_none()
            {
                return Err(INVALID);
            }
            if !matches!(c.status.as_str(), "A" | "D" | "M" | "T")
                && !(c.status.starts_with('R')
                    && c.status[1..].parse::<u8>().is_ok_and(|n| n <= 100))
            {
                return Err(INVALID);
            }
            for (p, mode, oid, entries) in [
                (&c.before_path, &c.before_mode, &c.before_oid, &self.before),
                (&c.after_path, &c.after_mode, &c.after_oid, &self.after),
            ] {
                if !hex(oid, 40) {
                    return Err(INVALID);
                }
                if let Some(p) = p {
                    if !path(p) {
                        return Err(INVALID);
                    }
                    let entry = entries.iter().find(|e| &e.path == p);
                    if entry.is_none() && self.status == "complete"
                        || entry.is_some_and(|e| &e.mode != mode || &e.git_oid != oid)
                    {
                        return Err(INVALID);
                    }
                } else if mode != "000000" || oid != &"0".repeat(40) {
                    return Err(INVALID);
                }
            }
        }
        if self
            .diff
            .as_ref()
            .is_some_and(|p| !hex(&p.sha256, 64) || p.bytes > 4 * 1024 * 1024)
            || self.status == "complete"
                && (self.diff.is_none()
                    || !self.omissions.is_empty()
                    || self
                        .before
                        .iter()
                        .chain(&self.after)
                        .any(|s| s.state == "unavailable"))
        {
            return Err(INVALID);
        }
        Ok(())
    }
    /// Who the capture was enrolled for, for Revision details. Task scope is assignment
    /// scope only; a project-owned capture has none and none is inferred.
    pub fn enrollment(&self) -> String {
        if self.enrollment_project_id.is_some() {
            "project-owned chat capture · no task scope".into()
        } else {
            format!(
                "enrollment task scope {} (not task-purpose proof)",
                self.enrollment_task_ids.join(", ")
            )
        }
    }
    pub fn parse_patch(&self, patch: &str) -> Result<Vec<DiffFile>, &'static str> {
        let p = self.diff.as_ref().ok_or("Retained patch unavailable.")?;
        if patch.len() != p.bytes || hash(patch.as_bytes()) != p.sha256 {
            return Err("Retained patch hash or length failed.");
        }
        let files = DiffFile::parse(patch)
            .map_err(|_| "Retained patch is malformed, truncated or unsupported by Kit.")?;
        if files
            .iter()
            .any(|f| f.is_truncated() || f.status() == DiffFileStatus::Conflicted)
        {
            return Err("Truncated or conflicted retained patch is unsupported.");
        }
        // Parser output must cover precisely the immutable inventory, including rename sides.
        let paths: BTreeSet<_> = files
            .iter()
            .map(|f| {
                (
                    f.original_path().map(|p| p.to_string()),
                    f.modified_path().map(|p| p.to_string()),
                )
            })
            .collect();
        let expected: BTreeSet<_> = self
            .changes
            .iter()
            .map(|c| (c.before_path.clone(), c.after_path.clone()))
            .collect();
        if paths != expected || paths.len() != files.len() || files.len() != self.changes.len() {
            return Err(
                "Kit patch paths do not match the retained inventory. Content is unavailable.",
            );
        }
        Ok(files)
    }
    pub fn notes(&self) -> String {
        let binaries = self
            .before
            .iter()
            .chain(&self.after)
            .filter(|s| s.state == "binary")
            .count();
        format!(
            "{} retained · intent/task purpose Unknown{}",
            self.status,
            if binaries > 0 {
                format!(" · {binaries} binary sides")
            } else {
                String::new()
            }
        )
    }
}
pub(crate) fn hash(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
pub(crate) fn hex(s: &str, n: usize) -> bool {
    s.len() == n
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn change(s: &str) -> bool {
    s.len() == 32 && s.bytes().all(|b| (b'k'..=b'z').contains(&b))
}
fn status(s: &str) -> bool {
    matches!(s, "complete" | "partial" | "unavailable")
}
fn path(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 400
        && !s.chars().any(|c| c.is_control() || c == '\\' || c == ':')
        && s.split('/').count() <= 64
        && s.split('/').all(|p| {
            !matches!(p, "" | "." | "..")
                && !p.eq_ignore_ascii_case(".git")
                && !p.eq_ignore_ascii_case(".jj")
        })
}
