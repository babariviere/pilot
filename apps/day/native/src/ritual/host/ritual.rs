//! Local ritual records share the native host's single writer and close drain.
use super::{Error, NativeHost, Shared, Source, journal::Journal};
use crate::{
    changes_contract as c,
    model::{DayPart, IntentOutcome, OutcomeStatus, Visit},
    ritual::{
        RitualAvailability, RitualKind, RitualMark, RitualProgress, RitualSnapshot, RitualVisit,
        RitualWrite,
    },
};
use async_channel::Receiver;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::Arc;

/// Current native wall-clock sample, supplied by the trusted root, never TSX.
/// The root must sample date/hour and IANA zone together, not daemon timestamps.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalDay {
    pub date: String,
    pub time_zone: String,
    pub hour: u8,
    pub unix_ms: u64,
}
impl LocalDay {
    pub(super) fn validate(&self) -> Result<(), Error> {
        let p: Vec<_> = self.date.split('-').collect();
        let valid_date = if self.date.bytes().enumerate().all(|(i, b)| {
            if i == 4 || i == 7 {
                b == b'-'
            } else {
                b.is_ascii_digit()
            }
        }) && p.len() == 3
            && p[0].len() == 4
            && p[1].len() == 2
            && p[2].len() == 2
        {
            match (
                p[0].parse::<u32>(),
                p[1].parse::<usize>(),
                p[2].parse::<u32>(),
            ) {
                (Ok(y), Ok(m @ 1..=12), Ok(d)) if y >= 1970 => {
                    let leap = y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
                    let days = [
                        31,
                        if leap { 29 } else { 28 },
                        31,
                        30,
                        31,
                        30,
                        31,
                        31,
                        30,
                        31,
                        30,
                        31,
                    ];
                    (1..=days[m - 1]).contains(&d)
                }
                _ => false,
            }
        } else {
            false
        };
        if !valid_date
            || self.hour > 23
            || self.unix_ms == 0
            || self.time_zone.is_empty()
            || self.time_zone.len() > 128
            || !self
                .time_zone
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"/_+-".contains(&b))
        {
            return Err(Error::Unavailable);
        }
        Ok(())
    }
    fn part(&self) -> DayPart {
        match self.hour {
            0..=11 => DayPart::Morning,
            12..=15 => DayPart::Afternoon,
            _ => DayPart::Evening,
        }
    }
}

/// Native-only root authority. No default clock, profile or user is guessed.
#[derive(Clone)]
pub struct DaySource {
    pub user_id: u32,
    pub clock: Arc<dyn Fn() -> Result<LocalDay, Error> + Send + Sync>,
}

impl DaySource {
    /// The OS user's current wall clock and system zone. No VM or environment
    /// date/zone is used. A missing system zone stays unavailable.
    #[cfg(target_os = "macos")]
    pub fn system() -> Self {
        Self {
            // SAFETY: geteuid has no preconditions.
            user_id: unsafe { libc::geteuid() },
            clock: Arc::new(super::native_clock::sample),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Identity {
    profile: String,
    user_id: u32,
    home: crate::contract::Home,
}
impl Identity {
    fn from_source(source: &Source, day: &DaySource) -> Self {
        Self {
            profile: source
                .profile
                .to_str()
                .expect("profile UTF-8 checked before identity")
                .into(),
            user_id: day.user_id,
            home: source.home.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Record {
    kind: String,
    version: u32,
    identity: Identity,
    date: String,
    zone: String,
    pub revision: u32,
    last_visit: Option<u64>,
    start: RitualProgress,
    end: RitualProgress,
}
impl Record {
    pub fn id(&self) -> String {
        // Exact path text stays distinct, including spelling. No lossy path aliases.
        let bytes = serde_json::to_vec(&(&self.identity, &self.date, &self.zone))
            .expect("validated ritual identity serializes");
        format!("{:x}", Sha256::digest(bytes))
    }
    pub fn validate(&self) -> Result<(), Error> {
        LocalDay {
            date: self.date.clone(),
            time_zone: self.zone.clone(),
            hour: 0,
            unix_ms: 1,
        }
        .validate()?;
        if self.kind != "ritual"
            || self.version != 1
            || self.revision == 0
            || !std::path::Path::new(&self.identity.profile).is_absolute()
            || !super::valid_id(&self.identity.home.daemon_id)
            || !super::valid_id(&self.identity.home.lineage_id)
            || self.start.step > 32
            || self.end.step > 32
            || self.last_visit == Some(0)
        {
            return Err(Error::Storage);
        }
        Ok(())
    }
    pub fn follows(&self, prior: &Self) -> bool {
        self.identity == prior.identity
            && self.date == prior.date
            && self.zone == prior.zone
            && prior.revision.checked_add(1) == Some(self.revision)
            && self.last_visit >= prior.last_visit
            && (prior.start.mark == RitualMark::Unmarked || prior.start == self.start)
            && (prior.end.mark == RitualMark::Unmarked || prior.end == self.end)
    }
}

#[derive(Default)]
pub(super) struct State {
    pub view: RitualSnapshot,
    day: Option<LocalDay>,
    selected: Option<(Identity, String, String)>,
    record: Option<Record>,
    baseline: Option<u64>,
    observed_at: u64,
    results_epoch: Option<u64>,
}

pub(super) fn local_day(shared: &Shared) -> Option<LocalDay> {
    shared
        .ritual
        .lock()
        .expect("ritual state poisoned")
        .day
        .clone()
}

fn same_date(a: Option<&LocalDay>, b: Option<&LocalDay>) -> bool {
    match (a, b) {
        (Some(a), Some(b)) => a.date == b.date && a.time_zone == b.time_zone,
        (None, None) => true,
        _ => false,
    }
}
pub(super) enum Work {
    Read,
    Visit(RitualVisit),
    Write(RitualWrite),
}

impl NativeHost {
    /// Read saved progress and sample the native clock. No visit or mark is written.
    pub fn read_ritual(&self) -> Receiver<Result<IntentOutcome, Error>> {
        self.request(super::Work::Ritual(Work::Read))
    }
    /// Record that the user saw Today. Opening the host or reading is not a visit.
    pub fn visit_day(&self, visit: RitualVisit) -> Receiver<Result<IntentOutcome, Error>> {
        self.request(super::Work::Ritual(Work::Visit(visit)))
    }
    /// Save one explicit choice or resume position. Never retries uncertain writes.
    pub fn save_ritual(&self, write: RitualWrite) -> Receiver<Result<IntentOutcome, Error>> {
        self.request(super::Work::Ritual(Work::Write(write)))
    }
    /// Last confirmed local read. This never performs I/O on the UI thread.
    pub fn ritual_snapshot(&self) -> RitualSnapshot {
        let state = self.0.shared.ritual.lock().expect("ritual state poisoned");
        let mut view = state.view.clone();
        let epoch = state.results_epoch;
        drop(state);
        if self.0.shared.open().is_err() {
            view.availability = RitualAvailability::Unavailable;
        }
        if epoch.is_none_or(|e| self.0.shared.current(e).is_err())
            || !self
                .0
                .shared
                .connected
                .load(std::sync::atomic::Ordering::SeqCst)
        {
            view.results_availability = RitualAvailability::Unavailable;
        }
        view
    }
    /// Read retained source evidence, bounded to the newest 20 kept snapshots.
    /// Never creates a capture or review, and never changes a ritual mark.
    pub fn read_ritual_results(&self) -> Receiver<Result<IntentOutcome, Error>> {
        self.request(super::Work::RitualResults)
    }
}

pub(super) fn handle(
    source: &Source,
    day: Option<&DaySource>,
    journal: &mut Journal,
    shared: &Shared,
    work: Work,
) -> Result<IntentOutcome, Error> {
    let result = apply(source, day, journal, shared, work);
    shared.change(|_| ());
    result
}

/// Refresh local time without writing or broadcasting unchanged snapshots.
/// The worker owns this timer, so close joins it with the journal writer.
pub(super) fn refresh_clock(
    source: &Source,
    day: &DaySource,
    journal: &mut Journal,
    shared: &Shared,
) {
    let snapshot = || {
        let state = shared.ritual.lock().expect("ritual state poisoned");
        (state.view.clone(), state.day.clone())
    };
    let (before, before_day) = snapshot();
    let _ = apply(source, Some(day), journal, shared, Work::Read);
    let (after, after_day) = snapshot();
    if before != after || !same_date(before_day.as_ref(), after_day.as_ref()) {
        shared.change(|_| ());
    }
}

fn apply(
    source: &Source,
    day: Option<&DaySource>,
    journal: &mut Journal,
    shared: &Shared,
    work: Work,
) -> Result<IntentOutcome, Error> {
    shared.open()?;
    let mut state = shared.ritual.lock().expect("ritual state poisoned");
    let sample = (|| {
        let day = day.ok_or(Error::Unavailable)?;
        // SAFETY: geteuid has no preconditions. Local records are OS-user scoped.
        if day.user_id != unsafe { libc::geteuid() } {
            return Err(Error::Identity);
        }
        let time = (day.clock)()?;
        time.validate()?;
        Ok((day, time))
    })();
    let day = sample.as_ref().ok().map(|(_, time)| time);
    if !same_date(state.day.as_ref(), day) {
        shared
            .desk
            .lock()
            .expect("native Desk poisoned")
            .project_finished_day(day);
    }
    state.day = day.cloned();
    let (day, time) = match sample {
        Ok(value) => value,
        Err(e) => {
            state.view = RitualSnapshot::default();
            state.selected = None;
            return Err(e);
        }
    };
    if journal.is_failed() {
        state.view.availability = RitualAvailability::Unknown;
        return Err(Error::Unknown);
    }
    if source.profile.to_str().is_none() {
        return Err(Error::Identity);
    }
    let identity = Identity::from_source(source, day);
    let selected = (identity.clone(), time.date.clone(), time.time_zone.clone());
    if state.selected.as_ref() != Some(&selected) {
        let empty = Record {
            kind: "ritual".into(),
            version: 1,
            identity: identity.clone(),
            date: time.date.clone(),
            zone: time.time_zone.clone(),
            revision: 0,
            last_visit: None,
            start: RitualProgress::default(),
            end: RitualProgress::default(),
        };
        let record = journal.rituals.get(&empty.id()).cloned().unwrap_or(empty);
        state.baseline = journal
            .rituals
            .values()
            .filter(|r| r.identity == identity)
            .filter_map(|r| r.last_visit)
            .max();
        state.view = RitualSnapshot {
            context: uuid::Uuid::new_v4().to_string(),
            ..RitualSnapshot::default()
        };
        state.selected = Some(selected);
        state.results_epoch = None;
        state.record = Some(record);
    }
    state.view.part = time.part();
    state.view.date = time.date.clone();
    state.view.time_zone = time.time_zone.clone();
    state.view.visit = match state.baseline {
        Some(at) if at <= time.unix_ms => Visit::Returning,
        None => Visit::Unknown,
        _ => Visit::Unknown,
    };
    state.view.last_looked_at = state
        .baseline
        .filter(|at| *at <= time.unix_ms)
        .map(|at| at.to_string())
        .unwrap_or_default();
    let mut record = state.record.clone().ok_or(Error::Unavailable)?;
    state.view.revision = record.revision;
    state.view.start = record.start.clone();
    state.view.end = record.end.clone();
    state.view.availability = RitualAvailability::Available;
    state.observed_at = time.unix_ms;
    let (context, revision) = match &work {
        Work::Read => {
            return Ok(shared.outcome(
                OutcomeStatus::Accepted,
                "Saved ritual progress read. No visit or mark was written.",
            ));
        }
        Work::Visit(v) => (&v.context, v.revision),
        Work::Write(w) => (&w.context, w.revision),
    };
    if context != &state.view.context || revision != record.revision {
        return Err(Error::Stale);
    }
    match work {
        Work::Read => unreachable!("read returned before mutation"),
        Work::Visit(_) => {
            record.last_visit = Some(record.last_visit.unwrap_or(0).max(time.unix_ms));
        }
        Work::Write(write) => {
            if write.step > 32 {
                return Err(Error::Invalid);
            }
            let progress = match write.ritual {
                RitualKind::Start => &mut record.start,
                RitualKind::End => &mut record.end,
            };
            if progress.mark != RitualMark::Unmarked {
                return Err(Error::Stale);
            }
            *progress = RitualProgress {
                mark: write.mark,
                step: write.step,
            };
        }
    }
    record.revision = record.revision.checked_add(1).ok_or(Error::Capacity)?;
    if let Err(e) = journal.save_ritual(record.clone()) {
        state.view.availability = if e == Error::Capacity {
            RitualAvailability::Available
        } else {
            RitualAvailability::Unknown
        };
        return Err(if e == Error::Capacity {
            e
        } else {
            Error::Unknown
        });
    }
    state.view.revision = record.revision;
    state.view.start = record.start.clone();
    state.view.end = record.end.clone();
    state.record = Some(record);
    Ok(shared.outcome(
        OutcomeStatus::Accepted,
        "Ritual progress saved locally. No work was started or accepted.",
    ))
}

pub(super) async fn read_results(
    t: &super::Transport,
    day: Option<&DaySource>,
    journal: &mut Journal,
    shared: &Shared,
    epoch: u64,
) -> Result<IntentOutcome, Error> {
    apply(&t.source, day, journal, shared, Work::Read)?;
    let (context, after, through) = {
        let mut state = shared.ritual.lock().expect("ritual state poisoned");
        state.view.results_availability = RitualAvailability::Unavailable;
        state.results_epoch = None;
        if state.view.availability != RitualAvailability::Available {
            return Err(Error::Unavailable);
        }
        if state.baseline.is_some_and(|at| at > state.observed_at) {
            return Err(Error::Unavailable);
        }
        (
            state.view.context.clone(),
            state.baseline.unwrap_or(0),
            state.observed_at,
        )
    };
    let read = kept_results(t, shared, epoch, after, through).await;
    apply(&t.source, day, journal, shared, Work::Read)?;
    let mut state = shared.ritual.lock().expect("ritual state poisoned");
    if state.view.context != context {
        return Err(Error::Stale);
    }
    let outcome = match read {
        Ok((entries, limited)) => {
            state.view.results = entries;
            state.view.results_limited = limited;
            state.view.results_availability = RitualAvailability::Available;
            state.results_epoch = Some(epoch);
            Ok(shared.outcome(
                OutcomeStatus::Accepted,
                "Qualified kept-change evidence read. This is not acceptance of other work.",
            ))
        }
        Err(e) => Err(e),
    };
    drop(state);
    shared.change(|_| ());
    outcome
}

// Daemon inventories cap at 100 chats; each feed page has at most 20 rows.
// Refuse an incomplete inventory rather than calling oldest-first partial data complete.
const MAX_CHATS: usize = 100;
const MAX_PAGES: usize = 100;
const MAX_ROWS: usize = 2000;
const MAX_METADATA: usize = 8 * 1024 * 1024;

#[derive(Debug, PartialEq, Deserialize)]
struct Chat {
    id: String,
}
#[derive(Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Inventory {
    project_id: String,
    chats: Vec<Chat>,
    more: bool,
}

async fn inventory(t: &super::Transport) -> Result<Inventory, Error> {
    let i: Inventory = serde_json::from_value(
        t.get(&format!(
            "/api/projects/{}/review",
            t.source.project()?.project_id
        ))
        .await?,
    )
    .map_err(|_| Error::Invalid)?;
    if i.project_id != t.source.project()?.project_id {
        return Err(Error::Identity);
    }
    if i.more || i.chats.len() > MAX_CHATS {
        return Err(Error::Busy);
    }
    let mut ids = std::collections::HashSet::new();
    if i.chats
        .iter()
        .any(|c| !super::valid_id(&c.id) || !ids.insert(&c.id))
    {
        return Err(Error::Invalid);
    }
    Ok(i)
}

async fn history(t: &super::Transport, row: &c::ChangeRow) -> Result<c::History, Error> {
    let raw = t
        .get(&format!(
            "/api/sessions/{}/review/{}/history?expectedProjectId={}",
            row.target.session_id,
            row.target.snapshot_id,
            t.source.project()?.project_id
        ))
        .await?;
    let snapshot = &raw["snapshot"];
    let digest = crate::changes_project::sha256(&crate::changes_project::canonical(
        &serde_json::json!({"snapshotId":snapshot["snapshotId"], "request":snapshot["request"], "diff":snapshot["diff"]}),
    ));
    if snapshot["workerId"] != row.target.session_id
        || snapshot["diff"]["sha256"] != row.target.diff_sha256
        || snapshot["request"]["scope"]["kind"] != row.target.layer
        || digest != row.target.comparison_digest
    {
        return Err(Error::Invalid);
    }
    let h: c::History = serde_json::from_value(raw).map_err(|_| Error::Invalid)?;
    // Projection validates full comparison identity; native scope adds project/session.
    if h.target != row.target || h.comparison != row.comparison {
        return Err(Error::Stale);
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64);
    crate::changes_project::page(
        &row.target.snapshot_id,
        &crate::changes_project::PageInputs {
            history: &h,
            patch: Err("Not read".into()),
            row: Some(row),
            request: None,
            newer: None,
            titles: &std::collections::HashMap::new(),
            local: None,
            now,
            read_at: now,
        },
    )
    .map_err(|_| Error::Invalid)?;
    Ok(h)
}

/// Every kept comparison row of the project, from a complete inventory read
/// twice. An unreadable slot makes the whole read unavailable.
async fn kept_rows(
    t: &super::Transport,
    shared: &Shared,
    epoch: u64,
) -> Result<Vec<c::ChangeRow>, Error> {
    let authority = t.local()?;
    t.gate(false).await?;
    let before = inventory(t).await?;
    let mut rows = std::collections::HashMap::new();
    let (mut pages, mut bytes) = (0, 0);
    for chat in &before.chats {
        let mut after = 0;
        loop {
            shared.current(epoch)?;
            if pages >= MAX_PAGES {
                return Err(Error::Busy);
            }
            let v = t
                .get(&format!(
                    "/api/sessions/{}/review?view=changes&expectedProjectId={}&after={after}",
                    chat.id,
                    t.source.project()?.project_id
                ))
                .await?;
            bytes += v.to_string().len();
            pages += 1;
            if bytes > MAX_METADATA || pages > MAX_PAGES {
                return Err(Error::Busy);
            }
            let page: c::ChangesPage = serde_json::from_value(v).map_err(|_| Error::Invalid)?;
            if page.version != 1
                || page.scope != "retained-comparisons-only"
                || page.status != "available"
            {
                return Err(Error::Unavailable);
            }
            if page.changes.len() > 20 {
                return Err(Error::Invalid);
            }
            for entry in page.changes {
                let c::PageEntry::Row(r) = entry else {
                    return Err(Error::Unavailable);
                };
                if r.target.project_id != t.source.project()?.project_id
                    || r.target.session_id != chat.id
                    || r.target.snapshot_id != r.comparison.snapshot_id
                    || !super::valid_id(&r.target.snapshot_id)
                    || rows.insert(r.target.snapshot_id.clone(), *r).is_some()
                {
                    return Err(Error::Invalid);
                }
            }
            if rows.len() > MAX_ROWS {
                return Err(Error::Busy);
            }
            match page.next {
                Some(n) if n <= after || n > 999_999_999_999_999 => return Err(Error::Invalid),
                Some(n) => after = n,
                None => break,
            }
        }
    }
    if inventory(t).await? != before {
        return Err(Error::Stale);
    }
    t.gate(false).await?;
    if t.local()? != authority {
        return Err(Error::Identity);
    }
    shared.current(epoch)?;
    Ok(rows.into_values().collect())
}

/// The recap's results: the newest 20 kept changes and whether there were
/// more. A limited recap is not a claim about every project result.
async fn kept_results(
    t: &super::Transport,
    shared: &Shared,
    epoch: u64,
    after: u64,
    through: u64,
) -> Result<(Vec<crate::model::DoneEntry>, bool), Error> {
    let mut rows = kept_rows(t, shared, epoch).await?;
    let limited = rows.len() > 20;
    rows.sort_by_key(|r| {
        std::cmp::Reverse((r.comparison.captured_at, r.target.snapshot_id.clone()))
    });
    rows.truncate(20);
    let authority = t.local()?;
    let mut entries = Vec::new();
    for row in rows {
        let h = history(t, &row).await?;
        // HTTP already bounds every body; record counts bound projection work as well.
        if h.landing.records.len() > 100
            || h.reviews.records.len() > 100
            || h.reported.claims.len() > 100
            || h.landing.next.is_some()
            || h.reviews.next.is_some()
        {
            return Err(Error::Unavailable);
        }
        if let Some(entry) = crate::ritual_results::result(&h, after, through) {
            entries.push(entry);
        }
    }
    t.gate(false).await?;
    if authority != t.local()? {
        return Err(Error::Identity);
    }
    shared.current(epoch)?;
    if !shared.connected.load(std::sync::atomic::Ordering::SeqCst) {
        return Err(Error::Stale);
    }
    entries.sort_by_key(|(at, entry)| std::cmp::Reverse((*at, entry.id.clone())));
    Ok((
        entries.into_iter().map(|(_, entry)| entry).collect(),
        limited,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_lost_fsync_ack_is_unknown_until_cold_disk_recovery() {
        let path = std::env::temp_dir().join(format!("ritual-ledger-{}", uuid::Uuid::new_v4()));
        let record = Record {
            kind: "ritual".into(),
            version: 1,
            identity: Identity {
                profile: "/isolated/profile".into(),
                user_id: 1,
                home: crate::contract::Home {
                    daemon_id: "daemon-a".into(),
                    lineage_id: "lineage-a".into(),
                },
            },
            date: "2026-11-10".into(),
            zone: "Europe/Paris".into(),
            revision: 1,
            last_visit: None,
            start: RitualProgress {
                mark: RitualMark::Done,
                step: 2,
            },
            end: RitualProgress::default(),
        };
        let mut journal = Journal::open(path.clone()).unwrap();
        journal.fail_after_sync = true;
        assert_eq!(journal.save_ritual(record.clone()), Err(Error::Storage));
        assert!(journal.is_failed());
        assert!(journal.rituals.is_empty(), "no optimistic RAM publication");
        assert_eq!(journal.finish(), Err(Error::Storage));
        drop(journal);
        let journal = Journal::open(path.clone()).unwrap();
        assert_eq!(
            journal.rituals.get(&record.id()),
            Some(&record),
            "recovery validates and syncs actual disk bytes, without replaying a write"
        );
        drop(journal);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn calendar_validation_fails_closed() {
        let mut day = LocalDay {
            date: "2026-02-29".into(),
            time_zone: "Europe/Paris".into(),
            hour: 9,
            unix_ms: 1,
        };
        assert_eq!(day.validate(), Err(Error::Unavailable));
        day.date = "2028-02-29".into();
        assert!(day.validate().is_ok());
        day.date = "2028-+2-29".into();
        assert_eq!(day.validate(), Err(Error::Unavailable));
        day.date = "2028-02-29".into();
        day.hour = 24;
        assert_eq!(day.validate(), Err(Error::Unavailable));
    }

    #[test]
    fn daily_key_capacity_refuses_without_eviction() {
        let path = std::env::temp_dir().join(format!("ritual-cap-{}", uuid::Uuid::new_v4()));
        let mut journal = Journal::open(path.clone()).unwrap();
        let mut record = Record {
            kind: "ritual".into(),
            version: 1,
            identity: Identity {
                profile: "/isolated/profile".into(),
                user_id: 1,
                home: crate::contract::Home {
                    daemon_id: "daemon-a".into(),
                    lineage_id: "lineage-a".into(),
                },
            },
            date: "2026-11-10".into(),
            zone: "Europe/Paris".into(),
            revision: 1,
            last_visit: None,
            start: RitualProgress::default(),
            end: RitualProgress::default(),
        };
        for index in 0..4096 {
            record.identity.profile = format!("/isolated/profile/{index}");
            journal.rituals.insert(record.id(), record.clone());
        }
        record.identity.profile = "/isolated/another-profile".into();
        assert_eq!(journal.save_ritual(record.clone()), Err(Error::Capacity));
        assert_eq!(journal.rituals.len(), 4096);
        assert_eq!(
            std::fs::metadata(&path).unwrap().len(),
            0,
            "refusal did not write"
        );
        record.identity.profile = "/isolated/profile/0".into();
        record.revision = 2;
        assert!(
            journal.save_ritual(record).is_ok(),
            "existing daily keys can still save"
        );
        drop(journal);
        std::fs::remove_file(path).unwrap();
    }
}
