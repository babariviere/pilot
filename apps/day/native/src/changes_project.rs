//! Projects the v1 kept-change contracts ([`crate::changes_contract`])
//! into the Changes read model ([`crate::changes`]), and a retained patch
//! into its files and line counts. Pure functions: the mock desk and a future native host
//! hand them the same contract values.
//!
//! The rules: a reopened page must name the exact snapshot asked for in
//! every part, or nothing is shown. An unreadable slot keeps its place and
//! is never read as empty. A landing seen once stays seen, with a note when
//! a later check could not confirm it. History never makes an approval
//! current.

use std::collections::HashMap;

use sha2::{Digest, Sha256};

use crate::{
    changes::{
        AttentionAsk, ChangeAttention, ChangeFile, ChangeList, ChangePage, ChangeRow,
        ChangesAvailability, Completeness, Disposition, FileStatus, LandingLine, LandingState,
        ReportedLine, RequestLine, ReviewLine, SnapshotIdentity,
    },
    changes_contract as c,
    model::Delivery,
    project::ago,
};

/// The largest kept patch the diff shows, in bytes. A larger one is
/// kept, but not shown here.
pub const MAX_PATCH: usize = 1024 * 1024;

/// The words when a read does not name the snapshot asked for.
pub const MISMATCH: &str =
    "What Pilot read does not match the snapshot asked for. Nothing from it is shown.";
/// The words when the contract's version or scope is not one Day reads.
pub const UNREADABLE: &str =
    "Pilot sent kept changes in a form Day cannot read. Nothing is guessed.";

/// What the app knows about a change beyond the read: the user's own Later
/// or Bring back.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ChangeLocal {
    /// Where the user's request is.
    pub delivery: Delivery,
    /// What it asks.
    pub asked: Option<AttentionAsk>,
    /// The request's operation, recorded before it is sent. Kept while
    /// its outcome is unknown, so a check can look it up. Never sent twice.
    pub operation: Option<String>,
}

/// Everything the list is projected from.
pub struct ListInputs<'a> {
    /// The pages read so far, from every source, in reading order.
    pub pages: &'a [c::ChangesPage],
    /// The review requests read with them.
    pub requests: &'a [c::RequestEntry],
    /// Chat titles, by session.
    pub titles: &'a HashMap<String, String>,
    /// The user's own requests, by snapshot.
    pub local: &'a HashMap<String, ChangeLocal>,
    /// Epoch ms now.
    pub now: u64,
}

/// Everything one reopened page is projected from.
pub struct PageInputs<'a> {
    /// The snapshot's history read.
    pub history: &'a c::History,
    /// The retained patch read, or why it could not be read.
    pub patch: Result<&'a c::RetainedPatch, String>,
    /// The snapshot's row in the list, when read.
    pub row: Option<&'a c::ChangeRow>,
    /// The review request row for the snapshot, for its title.
    pub request: Option<&'a c::RequestRow>,
    /// A newer kept snapshot of the same change.
    pub newer: Option<String>,
    /// Chat titles, by session.
    pub titles: &'a HashMap<String, String>,
    /// The user's own request for this snapshot.
    pub local: Option<&'a ChangeLocal>,
    /// Epoch ms now.
    pub now: u64,
    /// Epoch ms when the history was read.
    pub read_at: u64,
}

/// An id shortened for reading.
pub fn short(id: &str) -> String {
    id.chars().take(8).collect()
}

fn branch(reference: &str) -> String {
    reference
        .strip_prefix("refs/heads/")
        .unwrap_or(reference)
        .to_owned()
}

fn attention_of(state: c::RequestState) -> ChangeAttention {
    match state {
        c::RequestState::Pending => ChangeAttention::Waiting,
        c::RequestState::Snoozed => ChangeAttention::Later,
        c::RequestState::Withdrawn | c::RequestState::Retired | c::RequestState::Replaced => {
            ChangeAttention::Closed
        }
        c::RequestState::Unrecognized => ChangeAttention::Unknown,
    }
}

fn is_open(state: c::RequestState) -> bool {
    matches!(state, c::RequestState::Pending | c::RequestState::Snoozed)
}

fn completeness(state: c::CaptureState) -> Completeness {
    match state {
        c::CaptureState::Complete => Completeness::Complete,
        c::CaptureState::Partial => Completeness::Partial,
        c::CaptureState::Unavailable | c::CaptureState::Unrecognized => Completeness::Unavailable,
    }
}

/// The review request of exactly this comparison: the open one with the
/// highest sequence, else the latest closed one. A request for another
/// comparison of the same snapshot id is not this one.
pub fn request_for<'a>(
    requests: &'a [c::RequestEntry],
    comparison: &c::Comparison,
) -> Option<&'a c::RequestRow> {
    let mut mine: Vec<&c::RequestRow> = requests
        .iter()
        .filter_map(|entry| match entry {
            c::RequestEntry::Row(row) if row.comparison == *comparison => Some(row.as_ref()),
            _ => None,
        })
        .collect();
    mine.sort_by_key(|row| (is_open(row.state), row.sequence));
    mine.last().copied()
}

/// What the latest landing check and the last positive one say together.
#[derive(Debug, Clone, Default, PartialEq)]
struct Landed {
    state: LandingState,
    age: String,
    branch: String,
    later_unclear: bool,
}

fn landed(latest: Option<&c::LandingRecord>, seen: Option<&c::LandingRecord>, now: u64) -> Landed {
    let at = |r: &c::LandingRecord| ago(now, r.result.observed_at.unwrap_or(r.recorded_at));
    let on = |r: &c::LandingRecord| {
        r.result
            .default_ref
            .as_deref()
            .map(branch)
            .unwrap_or_default()
    };
    if let Some(seen) = seen.filter(|r| r.result.status == c::LandingStatus::Observed) {
        return Landed {
            state: LandingState::Seen,
            age: at(seen),
            branch: on(seen),
            later_unclear: latest.is_some_and(|l| {
                l.sequence > seen.sequence && l.result.status != c::LandingStatus::Observed
            }),
        };
    }
    let Some(latest) = latest else {
        return Landed::default();
    };
    let state = match latest.result.status {
        c::LandingStatus::Observed => LandingState::Seen,
        c::LandingStatus::NotContained => LandingState::NotSeen,
        _ => LandingState::Unclear,
    };
    Landed {
        state,
        age: at(latest),
        branch: on(latest),
        later_unclear: false,
    }
}

/// What a row shows beyond its comparison: names, the user's request and the time.
struct Facts<'a> {
    title: Option<&'a str>,
    titles: &'a HashMap<String, String>,
    local: Option<&'a ChangeLocal>,
    now: u64,
}

fn row_of(
    comparison: &c::Comparison,
    target: &c::Target,
    landing: Landed,
    attention: ChangeAttention,
    facts: &Facts<'_>,
) -> ChangeRow {
    let Facts {
        title,
        titles,
        local,
        now,
    } = *facts;
    let chat = titles.get(&target.session_id).cloned().unwrap_or_default();
    let title = title
        .filter(|t| !t.trim().is_empty())
        .map(str::to_owned)
        .or_else(|| (!chat.is_empty()).then(|| chat.clone()))
        .unwrap_or_else(|| format!("Change {}", short(&comparison.request.change_id)));
    ChangeRow {
        snapshot_id: comparison.snapshot_id.clone(),
        title,
        chat,
        change: short(&comparison.request.change_id),
        head: short(&comparison.request.head.commit_id),
        captured: ago(now, comparison.captured_at),
        completeness: completeness(comparison.status),
        attention,
        landing: landing.state,
        landing_age: landing.age,
        branch: landing.branch,
        later_unclear: landing.later_unclear,
        delivery: local.map(|l| l.delivery).unwrap_or_default(),
    }
}

fn unavailable(revision: u32, reason: &str) -> ChangeList {
    ChangeList {
        revision,
        availability: ChangesAvailability::Unavailable,
        reason: reason.to_owned(),
        ..ChangeList::default()
    }
}

/// The list of kept changes from every page read so far.
pub fn list(inputs: &ListInputs<'_>, revision: u32) -> ChangeList {
    let Some(last) = inputs.pages.last() else {
        return unavailable(revision, "Pilot has not read kept changes yet.");
    };
    if inputs
        .pages
        .iter()
        .any(|p| p.version != 1 || p.scope != "retained-comparisons-only")
    {
        return unavailable(revision, UNREADABLE);
    }
    if let Some(page) = inputs.pages.iter().find(|p| p.status != "available") {
        let reason = page
            .reason
            .clone()
            .filter(|r| !r.trim().is_empty())
            .unwrap_or_else(|| "Pilot cannot read kept changes here.".to_owned());
        return unavailable(revision, &reason);
    }
    let mut out = ChangeList {
        revision,
        more: last.next.is_some(),
        ..ChangeList::default()
    };
    if let Some(capture) = &last.capture {
        out.pending = capture.pending;
        out.failed = capture.failed;
    }
    let mut rows: Vec<(u64, ChangeRow)> = Vec::new();
    for entry in inputs.pages.iter().flat_map(|p| &p.changes) {
        match entry {
            c::PageEntry::Slot(_) => out.unreadable += 1,
            c::PageEntry::Row(row) => {
                let request = request_for(inputs.requests, &row.comparison);
                let attention = request.map_or(ChangeAttention::None, |r| attention_of(r.state));
                let landing = landed(
                    row.landing.as_ref(),
                    row.observed_landing.as_ref(),
                    inputs.now,
                );
                rows.push((
                    row.comparison.sequence,
                    row_of(
                        &row.comparison,
                        &row.target,
                        landing,
                        attention,
                        &Facts {
                            title: request.map(|r| r.title.as_str()),
                            titles: inputs.titles,
                            local: inputs.local.get(&row.comparison.snapshot_id),
                            now: inputs.now,
                        },
                    ),
                ));
            }
        }
    }
    rows.sort_by_key(|row| std::cmp::Reverse(row.0));
    for (_, row) in rows {
        match row.attention {
            ChangeAttention::Waiting => out.waiting.push(row),
            ChangeAttention::Later => out.later.push(row),
            _ => out.earlier.push(row),
        }
    }
    out
}

/// A newer kept snapshot of the same change in the pages read, if any.
pub fn newer(pages: &[c::ChangesPage], comparison: &c::Comparison) -> Option<String> {
    pages
        .iter()
        .flat_map(|p| &p.changes)
        .filter_map(|entry| match entry {
            c::PageEntry::Row(row)
                if row.comparison.request.repository_id == comparison.request.repository_id
                    && row.comparison.request.change_id == comparison.request.change_id
                    && row.comparison.sequence > comparison.sequence =>
            {
                Some(&row.comparison)
            }
            _ => None,
        })
        .max_by_key(|c| c.sequence)
        .map(|c| c.snapshot_id.clone())
}

/// Whether every part of a history read names the same exact snapshot.
pub(crate) fn exact(snapshot_id: &str, h: &c::History, row: Option<&c::ChangeRow>) -> bool {
    let s = &h.snapshot;
    let same_row = row.is_none_or(|r| r.comparison == h.comparison && r.target == h.target);
    h.version == 1
        && s.snapshot_id == snapshot_id
        && h.comparison.snapshot_id == snapshot_id
        && h.target.snapshot_id == snapshot_id
        && h.comparison.request == s.request
        && h.comparison.captured_at == s.captured_at
        && h.comparison.status == s.status
        && h.target.change_id == s.request.change_id
        && h.target.repository_id == s.request.repository_id
        && h.target.base_commit_id == s.request.base.commit_id
        && h.target.head_commit_id == s.request.head.commit_id
        && same_row
}

/// Hex SHA-256 of a text's UTF-8 bytes.
pub fn sha256(text: &str) -> String {
    Sha256::digest(text.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// The date and time of an epoch ms, in UTC, such as "9 Nov 2026, 09:12 UTC".
pub fn date_time(ms: u64) -> String {
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let secs = ms / 1000;
    let days = (secs / 86_400) as i64;
    let (hour, minute) = ((secs % 86_400) / 3600, (secs % 3600) / 60);
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{day} {} {year}, {hour:02}:{minute:02} UTC",
        MONTHS[(month - 1) as usize]
    )
}

fn manifest_status(status: &str) -> FileStatus {
    match status.chars().next() {
        Some('A') => FileStatus::Added,
        Some('D') => FileStatus::Deleted,
        Some('R') => FileStatus::Renamed,
        _ => FileStatus::Modified,
    }
}

/// The changed files the manifest names, with no lines.
fn manifest_files(snapshot: &c::Snapshot) -> Vec<ChangeFile> {
    snapshot
        .changes
        .iter()
        .map(|change| {
            let status = manifest_status(&change.status);
            let name = change
                .after_path
                .clone()
                .or_else(|| change.before_path.clone())
                .unwrap_or_default();
            ChangeFile {
                old_name: if status == FileStatus::Renamed {
                    change.before_path.clone().unwrap_or_default()
                } else {
                    String::new()
                },
                name,
                status,
                ..ChangeFile::default()
            }
        })
        .collect()
}

/// The manifest's files, each with its lines from the patch when it has
/// them. The manifest is the authority for which files changed.
fn merge(snapshot: &c::Snapshot, parsed: Vec<ChangeFile>) -> Vec<ChangeFile> {
    let manifest = manifest_files(snapshot);
    if manifest.is_empty() {
        return parsed;
    }
    let mut parsed: Vec<Option<ChangeFile>> = parsed.into_iter().map(Some).collect();
    let mut out = Vec::with_capacity(manifest.len());
    for file in manifest {
        let found = parsed.iter_mut().find(|p| {
            p.as_ref().is_some_and(|p| {
                p.name == file.name
                    || (file.status == FileStatus::Deleted && p.old_name == file.name)
            })
        });
        let mut shown = match found.and_then(Option::take) {
            Some(mut p) => {
                // The manifest has no letter for a mode-only change.
                if !(file.status == FileStatus::Modified && p.status == FileStatus::Mode) {
                    p.status = file.status;
                }
                p.old_name = file.old_name.clone();
                p.name = file.name.clone();
                p
            }
            None => ChangeFile {
                note: "No lines for this file in the kept patch.".into(),
                ..file
            },
        };
        let side = if shown.status == FileStatus::Deleted {
            &snapshot.before
        } else {
            &snapshot.after
        };
        if let Some(source) = side.iter().find(|s| s.path == shown.name) {
            match source.state.as_str() {
                "binary" => {
                    shown.binary = true;
                    shown.note = "Binary file. No lines to show.".into();
                }
                "unavailable" if shown.added + shown.removed == 0 => {
                    shown.note = source
                        .reason
                        .clone()
                        .filter(|r| !r.trim().is_empty())
                        .unwrap_or_else(|| "Pilot did not keep this file.".into());
                }
                _ => {}
            }
        }
        out.push(shown);
    }
    out.extend(parsed.into_iter().flatten());
    out
}

fn git_names(rest: &str) -> (String, String) {
    let clean = |s: &str| s.trim().trim_matches('"').to_owned();
    match rest.rfind(" b/") {
        Some(at) => (
            clean(rest[..at].trim_start_matches("a/")),
            clean(&rest[at + 3..]),
        ),
        None => (clean(rest), clean(rest)),
    }
}

fn side_name(rest: &str, prefix: &str) -> Option<String> {
    let rest = rest.trim().trim_matches('"');
    (rest != "/dev/null").then(|| rest.strip_prefix(prefix).unwrap_or(rest).to_owned())
}

/// Parses a git-format patch into its files and their line counts. The
/// diff itself shows the exact patch; this names what it holds.
pub fn parse_patch(patch: &str) -> Vec<ChangeFile> {
    let mut files: Vec<ChangeFile> = Vec::new();
    let mut in_hunk = false;
    for raw in patch.lines() {
        if let Some(rest) = raw.strip_prefix("diff --git ") {
            let (before, after) = git_names(rest);
            files.push(ChangeFile {
                old_name: before,
                name: after,
                ..ChangeFile::default()
            });
            in_hunk = false;
            continue;
        }
        let Some(file) = files.last_mut() else {
            continue;
        };
        if raw.starts_with("@@") {
            in_hunk = true;
        } else if in_hunk {
            match raw.chars().next() {
                Some('+') => file.added += 1,
                Some('-') => file.removed += 1,
                Some(' ' | '\\') | None => {}
                Some(_) => in_hunk = false,
            }
        } else if raw.starts_with("new file mode") {
            file.status = FileStatus::Added;
        } else if raw.starts_with("deleted file mode") {
            file.status = FileStatus::Deleted;
        } else if let Some(name) = raw.strip_prefix("rename from ") {
            file.status = FileStatus::Renamed;
            file.old_name = name.trim_matches('"').to_owned();
        } else if let Some(name) = raw.strip_prefix("rename to ") {
            file.status = FileStatus::Renamed;
            file.name = name.trim_matches('"').to_owned();
        } else if raw.starts_with("new mode") && file.status == FileStatus::Modified {
            file.status = FileStatus::Mode;
        } else if let Some(rest) = raw.strip_prefix("--- ") {
            if let Some(name) = side_name(rest, "a/") {
                file.old_name = name;
            }
        } else if let Some(rest) = raw.strip_prefix("+++ ") {
            if let Some(name) = side_name(rest, "b/") {
                file.name = name;
            }
            if file.status == FileStatus::Mode {
                file.status = FileStatus::Modified;
            }
        } else if raw.starts_with("Binary files ") || raw.starts_with("GIT binary patch") {
            file.binary = true;
        }
    }
    for file in &mut files {
        if file.status != FileStatus::Renamed {
            file.old_name.clear();
        }
        if file.binary {
            file.note = "Binary file. No lines to show.".into();
        }
    }
    files
}

fn disposition(value: c::Disposition) -> Disposition {
    match value {
        c::Disposition::Approve => Disposition::Approve,
        c::Disposition::RequestChanges => Disposition::RequestChanges,
        c::Disposition::Comment | c::Disposition::Unrecognized => Disposition::Comment,
    }
}

fn landing_line(record: &c::LandingRecord, now: u64) -> LandingLine {
    let r = &record.result;
    let state = match r.status {
        c::LandingStatus::Observed => LandingState::Seen,
        c::LandingStatus::NotContained => LandingState::NotSeen,
        _ => LandingState::Unclear,
    };
    LandingLine {
        id: record.observation_id.clone(),
        state,
        age: ago(now, r.observed_at.unwrap_or(record.recorded_at)),
        branch: r.default_ref.as_deref().map(branch).unwrap_or_default(),
        commit: r
            .integrated_commit_id
            .as_deref()
            .map(short)
            .unwrap_or_default(),
        pull_request: r
            .producer
            .as_ref()
            .filter(|p| p.kind == "pull-request")
            .and_then(|p| p.url.clone())
            .unwrap_or_default(),
        reason: if state == LandingState::Unclear {
            r.reason.clone().unwrap_or_default()
        } else {
            String::new()
        },
    }
}

/// One kept snapshot reopened, or why it cannot be shown. Every part must
/// name `snapshot_id` exactly.
pub fn page(snapshot_id: &str, i: &PageInputs<'_>) -> Result<ChangePage, String> {
    let h = i.history;
    if !exact(snapshot_id, h, i.row) {
        return Err(MISMATCH.into());
    }
    let s = &h.snapshot;
    let (files, patch, diff_note) = match (&s.diff, &i.patch) {
        _ if s.status == c::CaptureState::Unavailable
            || s.status == c::CaptureState::Unrecognized =>
        {
            (
                manifest_files(s),
                String::new(),
                "Pilot did not keep this change's bytes.".to_owned(),
            )
        }
        (None, _) => (
            manifest_files(s),
            String::new(),
            "Pilot did not keep a patch for this snapshot.".to_owned(),
        ),
        (Some(_), Ok(p)) if p.snapshot_id != snapshot_id => return Err(MISMATCH.into()),
        (Some(d), Ok(p)) if sha256(&p.patch) != d.sha256.to_lowercase() => (
            manifest_files(s),
            String::new(),
            "The kept patch does not match its saved digest. Nothing is shown from it.".to_owned(),
        ),
        (Some(_), Ok(p)) if p.patch.len() > MAX_PATCH => (
            merge(s, parse_patch(&p.patch)),
            String::new(),
            format!(
                "The kept patch is too large to show here ({} KiB). It stays kept.",
                p.patch.len() / 1024
            ),
        ),
        (Some(_), Ok(p)) => (
            merge(s, parse_patch(&p.patch)),
            p.patch.clone(),
            String::new(),
        ),
        (Some(_), Err(_)) => (
            manifest_files(s),
            String::new(),
            "The kept patch could not be read. Nothing is guessed.".to_owned(),
        ),
    };

    let mut attention = h.attention.records.clone();
    attention.sort_by_key(|a| std::cmp::Reverse(a.updated_at));
    let line = |a: &c::Attention| RequestLine {
        request_id: a.request_id.clone(),
        revision: a.revision,
        attention: attention_of(a.state),
        age: ago(i.now, a.updated_at),
    };
    let request = attention.iter().find(|a| is_open(a.state)).map(line);
    let state = request.as_ref().map(|r| r.attention).unwrap_or_else(|| {
        attention
            .first()
            .map_or(ChangeAttention::None, |a| attention_of(a.state))
    });

    let landing = match i.row {
        Some(row) => landed(row.landing.as_ref(), row.observed_landing.as_ref(), i.now),
        None => {
            let records = &h.landing.records;
            let latest = records.iter().max_by_key(|r| r.sequence);
            let seen = records
                .iter()
                .filter(|r| r.result.status == c::LandingStatus::Observed)
                .max_by_key(|r| r.sequence);
            landed(latest, seen, i.now)
        }
    };
    let row = row_of(
        &h.comparison,
        &h.target,
        landing,
        state,
        &Facts {
            title: i.request.map(|r| r.title.as_str()),
            titles: i.titles,
            local: i.local,
            now: i.now,
        },
    );
    let reported_known = h.reported.status == "reported";
    Ok(ChangePage {
        row,
        identity: SnapshotIdentity {
            snapshot_id: s.snapshot_id.clone(),
            sequence: u32::try_from(h.comparison.sequence).unwrap_or(u32::MAX),
            change_id: s.request.change_id.clone(),
            base: s.request.base.commit_id.clone(),
            head: s.request.head.commit_id.clone(),
            scope: s.request.scope.kind.clone(),
            source: if s.request.source == "working-copy" {
                "working copy".into()
            } else {
                s.request.source.clone()
            },
            diff: s
                .diff
                .as_ref()
                .map(|d| d.sha256.clone())
                .unwrap_or_default(),
            captured_at: date_time(s.captured_at),
        },
        omissions: s.omissions.clone(),
        files,
        patch,
        diff_note,
        newer: i.newer.clone(),
        request,
        requests: attention.iter().map(line).collect(),
        requests_more: !h.attention.complete,
        reviews: h
            .reviews
            .records
            .iter()
            .map(|e| ReviewLine {
                id: e.record.id.clone(),
                disposition: disposition(e.record.confirmed.disposition),
                body: e.record.confirmed.body.clone(),
                age: ago(i.now, e.record.created_at),
            })
            .collect(),
        reviews_more: h.reviews.next.is_some(),
        landings: h
            .landing
            .records
            .iter()
            .map(|r| landing_line(r, i.now))
            .collect(),
        landings_more: h.landing.next.is_some(),
        reported: if reported_known {
            h.reported
                .claims
                .iter()
                .map(|claim| ReportedLine {
                    task: claim.task_id.clone(),
                    commit: short(&claim.commit),
                    age: ago(i.now, claim.recorded_at),
                })
                .collect()
        } else {
            Vec::new()
        },
        reported_known,
        asked: i.local.and_then(|l| l.asked),
        read: ago(i.now, i.read_at),
    })
}
