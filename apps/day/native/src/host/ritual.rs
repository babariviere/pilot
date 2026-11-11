//! Local ritual records share the native host's single writer and close drain.
use super::{Error, NativeHost, Shared, Source, journal::Journal};
use crate::{
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
    selected: Option<(Identity, String, String)>,
    record: Option<Record>,
    baseline: Option<u64>,
    observed_at: u64,
    results_epoch: Option<u64>,
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
    let before = shared
        .ritual
        .lock()
        .expect("ritual state poisoned")
        .view
        .clone();
    let _ = apply(source, Some(day), journal, shared, Work::Read);
    let after = shared
        .ritual
        .lock()
        .expect("ritual state poisoned")
        .view
        .clone();
    if before != after {
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
    let read = super::changes::ritual_results(t, shared, epoch, after, through).await;
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
