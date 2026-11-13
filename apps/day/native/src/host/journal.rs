//! One private append-only, fsynced command ledger. Pending records never authorize POST.
use super::attention::{Draft, Record as AttentionRecord};
use super::planning::PlanningRecord;
use super::{Error, Source};
use crate::contract::{ControlCommand, ControlOperation, DayOverview, MissionDetail};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs::{File, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};

const MAX_LEDGER: u64 = 64 * 1024 * 1024;
const MAX_OPERATIONS: usize = 16_384;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(super) struct Record {
    pub version: u32,
    pub source: Source,
    pub mission: String,
    pub command: ControlCommand,
    pub receipt: Option<ControlOperation>,
    /// Only a proven pre-send refusal can set this. Never set after entering POST.
    pub not_sent: bool,
}
impl Record {
    pub fn pending(&self) -> bool {
        !self.not_sent
            && self
                .receipt
                .as_ref()
                .is_none_or(|r| r.state != crate::contract::OperationState::Acknowledged)
    }
}

#[derive(Serialize, Deserialize)]
pub(super) struct Cache {
    pub version: u32,
    pub source: Source,
    pub overview: DayOverview,
    pub details: Vec<MissionDetail>,
}

pub(super) struct Journal {
    pub losses: BTreeMap<String, super::update_loss::Record>,
    pub windows: BTreeMap<String, super::window::SavedWindow>,
    pub updates: BTreeMap<String, super::updates::Record>,
    pub rituals: BTreeMap<String, super::ritual::Record>,
    pub changes: BTreeMap<String, super::changes::Record>,
    file: File,
    path: PathBuf,
    bytes: u64,
    failed: bool,
    #[cfg(test)]
    pub fail_after_sync: bool,
    pub records: BTreeMap<String, Record>,
    pub planning: BTreeMap<String, PlanningRecord>,
    pub attention: BTreeMap<String, AttentionRecord>,
    pub attention_drafts: BTreeMap<String, Draft>,
}

#[derive(Serialize, Deserialize)]
#[serde(untagged)]
enum Entry {
    Loss(Box<super::update_loss::Record>),
    Window(Box<super::window::SavedWindow>),
    Update(Box<super::updates::Record>),
    Ritual(Box<super::ritual::Record>),
    Attention(Box<AttentionRecord>),
    Draft(Box<Draft>),
    Changes(Box<super::changes::Record>),
    Control(Box<Record>),
    Planning(Box<PlanningRecord>),
}

fn private(file: &File) -> Result<(), Error> {
    let m = file.metadata().map_err(|_| Error::Storage)?;
    // SAFETY: geteuid has no preconditions.
    if !m.is_file()
        || m.uid() != unsafe { libc::geteuid() }
        || m.mode() & 0o077 != 0
        || m.nlink() != 1
    {
        return Err(Error::Storage);
    }
    Ok(())
}

impl Journal {
    pub(super) fn path(&self) -> &Path {
        &self.path
    }
    pub fn is_failed(&self) -> bool {
        self.failed
    }
    pub fn save_ritual(&mut self, record: super::ritual::Record) -> Result<(), Error> {
        record.validate()?;
        let id = record.id();
        if self
            .rituals
            .get(&id)
            .map_or(record.revision != 1, |prior| !record.follows(prior))
        {
            return Err(Error::Stale);
        }
        if !self.rituals.contains_key(&id)
            && (self.rituals.len() >= 4096 || self.count() >= MAX_OPERATIONS)
        {
            return Err(Error::Capacity);
        }
        self.append(&record)?;
        self.rituals.insert(id, record);
        Ok(())
    }
    pub fn poison(&mut self) {
        self.failed = true;
    }
    pub fn finish(&self) -> Result<(), Error> {
        if self.failed {
            return Err(Error::Storage);
        }
        self.file.sync_all().map_err(|_| Error::Storage)
    }
    pub fn open(path: PathBuf) -> Result<Self, Error> {
        let mut file = OpenOptions::new()
            .read(true)
            .append(true)
            .create(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
            .open(&path)
            .map_err(|_| Error::Storage)?;
        private(&file)?;
        // SAFETY: the live file descriptor is held until this single writer exits.
        if unsafe {
            libc::flock(
                std::os::fd::AsRawFd::as_raw_fd(&file),
                libc::LOCK_EX | libc::LOCK_NB,
            )
        } != 0
        {
            return Err(Error::Storage);
        }
        let bytes = file.metadata().map_err(|_| Error::Storage)?.len();
        if bytes > MAX_LEDGER {
            return Err(Error::Storage);
        }
        let mut body = Vec::new();
        (&mut file)
            .take(MAX_LEDGER + 1)
            .read_to_end(&mut body)
            .map_err(|_| Error::Storage)?;
        if body.len() as u64 > MAX_LEDGER || (!body.is_empty() && body.last() != Some(&b'\n')) {
            return Err(Error::Storage);
        }
        let mut records: BTreeMap<String, Record> = BTreeMap::new();
        let mut planning: BTreeMap<String, PlanningRecord> = BTreeMap::new();
        let mut attention: BTreeMap<String, AttentionRecord> = BTreeMap::new();
        let mut attention_drafts: BTreeMap<String, Draft> = BTreeMap::new();
        let mut changes: BTreeMap<String, super::changes::Record> = BTreeMap::new();
        let mut rituals: BTreeMap<String, super::ritual::Record> = BTreeMap::new();
        let mut updates: BTreeMap<String, super::updates::Record> = BTreeMap::new();
        let mut losses: BTreeMap<String, super::update_loss::Record> = BTreeMap::new();
        let mut windows: BTreeMap<String, super::window::SavedWindow> = BTreeMap::new();
        for line in body.split(|b| *b == b'\n').filter(|line| !line.is_empty()) {
            let entry: Entry = serde_json::from_slice(line).map_err(|_| Error::Storage)?;
            let record = match entry {
                Entry::Loss(record) => {
                    record.validate()?;
                    if losses
                        .get(&record.operation)
                        .map_or(record.closed, |prior| !record.follows(prior))
                    {
                        return Err(Error::Storage);
                    }
                    losses.insert(record.operation.clone(), *record);
                    if losses.len() > 256 {
                        return Err(Error::Storage);
                    }
                    continue;
                }
                Entry::Window(record) => {
                    record.validate()?;
                    let key = super::window::SavedWindow::key(&record.source)?;
                    if windows.get(&key).is_some_and(|old| !record.follows(old)) {
                        return Err(Error::Storage);
                    }
                    windows.insert(key, *record);
                    if windows.len() > 256 {
                        return Err(Error::Storage);
                    }
                    continue;
                }
                Entry::Update(record) => {
                    record.validate()?;
                    if let Some(loss) = record.loss()?
                        && losses.get(&loss.operation) != Some(&loss)
                    {
                        return Err(Error::Storage);
                    }
                    if updates
                        .get(&record.id)
                        .map_or(record.state != "capture", |old| !record.follows(old))
                    {
                        return Err(Error::Storage);
                    }
                    updates.insert(record.id.clone(), *record);
                    if updates.len() > 256
                        || updates.len()
                            + rituals.len()
                            + changes.len()
                            + records.len()
                            + planning.len()
                            + attention.len()
                            + attention_drafts.len()
                            > MAX_OPERATIONS
                    {
                        return Err(Error::Storage);
                    }
                    continue;
                }
                Entry::Ritual(record) => {
                    record.validate().map_err(|_| Error::Storage)?;
                    if rituals
                        .get(&record.id())
                        .map_or(record.revision != 1, |prior| !record.follows(prior))
                    {
                        return Err(Error::Storage);
                    }
                    rituals.insert(record.id(), *record);
                    if rituals.len() > 4096
                        || updates.len()
                            + rituals.len()
                            + changes.len()
                            + records.len()
                            + planning.len()
                            + attention.len()
                            + attention_drafts.len()
                            > MAX_OPERATIONS
                    {
                        return Err(Error::Storage);
                    }
                    continue;
                }
                Entry::Attention(record) => {
                    record.validate()?;
                    if let Some(prior) = attention.get(&record.id)
                        && (prior.source != record.source
                            || prior.request != record.request
                            || (prior.not_sent && !record.not_sent)
                            || (!prior.pending() && prior.receipt != record.receipt))
                    {
                        return Err(Error::Storage);
                    }
                    attention.insert(record.id.clone(), *record);
                    if attention.len() + attention_drafts.len() > 4096 {
                        return Err(Error::Storage);
                    }
                    if updates.len()
                        + rituals.len()
                        + changes.len()
                        + records.len()
                        + planning.len()
                        + attention.len()
                        + attention_drafts.len()
                        > MAX_OPERATIONS
                    {
                        return Err(Error::Storage);
                    }
                    continue;
                }
                Entry::Draft(draft) => {
                    draft.validate()?;
                    attention_drafts.insert(draft.id(), *draft);
                    if attention.len() + attention_drafts.len() > 4096 {
                        return Err(Error::Storage);
                    }
                    if updates.len()
                        + rituals.len()
                        + changes.len()
                        + records.len()
                        + planning.len()
                        + attention.len()
                        + attention_drafts.len()
                        > MAX_OPERATIONS
                    {
                        return Err(Error::Storage);
                    }
                    continue;
                }
                Entry::Changes(record) => {
                    let record = *record;
                    record.validate()?;
                    if let Some(prior) = changes.get(record.id())
                        && (prior.source != record.source
                            || prior.sequence != record.sequence
                            || prior.target != record.target
                            || prior.action != record.action
                            || prior.command != record.command
                            || (prior.not_sent && !record.not_sent)
                            || (prior.receipt.is_some() && prior.receipt != record.receipt))
                    {
                        return Err(Error::Storage);
                    }
                    changes.insert(record.id().to_owned(), record);
                    if updates.len()
                        + rituals.len()
                        + changes.len()
                        + planning.len()
                        + records.len()
                        + attention.len()
                        + attention_drafts.len()
                        > MAX_OPERATIONS
                    {
                        return Err(Error::Storage);
                    }
                    continue;
                }
                Entry::Control(record) => *record,
                Entry::Planning(record) => {
                    let record = *record;
                    record.validate()?;
                    if let Some(prior) = planning.get(record.id())
                        && (prior.source != record.source
                            || prior.operation != record.operation
                            || prior.setup_digest != record.setup_digest
                            || prior.verification_pin != record.verification_pin
                            || (prior.not_sent && !record.not_sent)
                            || (prior
                                .receipt
                                .as_ref()
                                .is_some_and(|r| r["state"] != "pending")
                                && prior.receipt != record.receipt))
                    {
                        return Err(Error::Storage);
                    }
                    planning.insert(record.id().to_owned(), record);
                    if updates.len()
                        + rituals.len()
                        + planning.len()
                        + changes.len()
                        + records.len()
                        + attention.len()
                        + attention_drafts.len()
                        > MAX_OPERATIONS
                    {
                        return Err(Error::Storage);
                    }
                    continue;
                }
            };
            if record.version != 1
                || !super::valid_id(&record.mission)
                || record.command.version != 1
                || record.command.home != record.source.home
                || record.command.project_id != record.source.project()?.project_id
            {
                return Err(Error::Storage);
            }
            if let Some(prior) = records.get(&record.command.operation_id)
                && (prior.source != record.source
                    || prior.mission != record.mission
                    || prior.command != record.command
                    || (prior.not_sent && !record.not_sent)
                    || (prior
                        .receipt
                        .as_ref()
                        .is_some_and(|r| r.state == crate::contract::OperationState::Acknowledged)
                        && prior.receipt != record.receipt))
            {
                return Err(Error::Storage);
            }
            if let Some(r) = &record.receipt {
                super::transport::exact(
                    serde_json::to_value(r).map_err(|_| Error::Storage)?,
                    &record.mission,
                    &record.command,
                )
                .map_err(|_| Error::Storage)?;
            }
            records.insert(record.command.operation_id.clone(), record);
            if updates.len()
                + rituals.len()
                + changes.len()
                + records.len()
                + planning.len()
                + attention.len()
                + attention_drafts.len()
                > MAX_OPERATIONS
            {
                return Err(Error::Storage);
            }
        }
        if windows.len()
            + updates.len()
            + losses.len()
            + rituals.len()
            + changes.len()
            + records.len()
            + planning.len()
            + attention.len()
            + attention_drafts.len()
            > MAX_OPERATIONS
        {
            return Err(Error::Storage);
        }
        file.sync_all().map_err(|_| Error::Storage)?;
        sync_parent(&path)?;
        Ok(Self {
            losses,
            windows,
            file,
            path,
            bytes,
            failed: false,
            #[cfg(test)]
            fail_after_sync: false,
            records,
            planning,
            attention,
            attention_drafts,
            changes,
            rituals,
            updates,
        })
    }

    pub fn save(&mut self, record: Record) -> Result<(), Error> {
        if self.failed
            || (!self.records.contains_key(&record.command.operation_id)
                && self.count() >= MAX_OPERATIONS)
        {
            return Err(Error::Storage);
        }
        self.append(&record)?;
        self.records
            .insert(record.command.operation_id.clone(), record);
        Ok(())
    }

    pub fn save_planning(&mut self, record: PlanningRecord) -> Result<(), Error> {
        record.validate()?;
        if !self.planning.contains_key(record.id()) && self.count() >= MAX_OPERATIONS {
            return Err(Error::Storage);
        }
        self.append(&record)?;
        self.planning.insert(record.id().to_owned(), record);
        Ok(())
    }

    fn append(&mut self, record: &impl Serialize) -> Result<(), Error> {
        if self.failed {
            return Err(Error::Storage);
        }
        private(&self.file)?;
        let m = self.file.metadata().map_err(|_| Error::Storage)?;
        let p = std::fs::symlink_metadata(&self.path).map_err(|_| Error::Storage)?;
        if !p.is_file() || p.dev() != m.dev() || p.ino() != m.ino() || m.len() != self.bytes {
            self.failed = true;
            return Err(Error::Storage);
        }
        let mut bytes = serde_json::to_vec(record).map_err(|_| Error::Storage)?;
        bytes.push(b'\n');
        if self.bytes + bytes.len() as u64 > MAX_LEDGER {
            return Err(Error::Storage);
        }
        // Poison this writer on partial write/fsync failure. Never send after it.
        self.failed = true;
        self.file
            .write_all(&bytes)
            .and_then(|_| self.file.sync_all())
            .map_err(|_| Error::Storage)?;
        #[cfg(test)]
        if self.fail_after_sync {
            return Err(Error::Storage);
        }
        self.bytes += bytes.len() as u64;
        self.failed = false;
        Ok(())
    }

    pub fn save_attention(&mut self, record: AttentionRecord) -> Result<(), Error> {
        record.validate()?;
        if !self.attention.contains_key(&record.id) && self.count() >= MAX_OPERATIONS {
            return Err(Error::Storage);
        }
        if !self.attention.contains_key(&record.id)
            && self.attention.len() + self.attention_drafts.len() >= 4096
        {
            return Err(Error::Capacity);
        }
        self.append(&record)?;
        self.attention.insert(record.id.clone(), record);
        Ok(())
    }
    pub fn save_attention_draft(&mut self, draft: Draft) -> Result<(), Error> {
        draft.validate()?;
        let id = draft.id();
        if !self.attention_drafts.contains_key(&id) && self.count() >= MAX_OPERATIONS {
            return Err(Error::Storage);
        }
        if !self.attention_drafts.contains_key(&id)
            && self.attention.len() + self.attention_drafts.len() >= 4096
        {
            return Err(Error::Capacity);
        }
        self.append(&draft)?;
        self.attention_drafts.insert(id, draft);
        Ok(())
    }

    fn count(&self) -> usize {
        self.losses.len()
            + self.windows.len()
            + self.updates.len()
            + self.rituals.len()
            + self.changes.len()
            + self.records.len()
            + self.planning.len()
            + self.attention.len()
            + self.attention_drafts.len()
    }

    pub fn save_loss(&mut self, record: super::update_loss::Record) -> Result<(), Error> {
        record.validate()?;
        if self
            .losses
            .get(&record.operation)
            .map_or(record.closed, |prior| !record.follows(prior))
        {
            return Err(Error::Stale);
        }
        if !self.losses.contains_key(&record.operation)
            && (self.losses.len() >= 256 || self.count() >= MAX_OPERATIONS)
        {
            return Err(Error::Capacity);
        }
        self.append(&record)?;
        self.losses.insert(record.operation.clone(), record);
        Ok(())
    }

    pub fn save_window(&mut self, record: super::window::SavedWindow) -> Result<(), Error> {
        record.validate()?;
        let key = super::window::SavedWindow::key(&record.source)?;
        if self
            .windows
            .get(&key)
            .is_some_and(|old| !record.follows(old))
        {
            return Err(Error::Stale);
        }
        if !self.windows.contains_key(&key)
            && (self.windows.len() >= 256 || self.count() >= MAX_OPERATIONS)
        {
            return Err(Error::Capacity);
        }
        self.append(&record)?;
        self.windows.insert(key, record);
        Ok(())
    }

    pub fn save_update(&mut self, record: super::updates::Record) -> Result<(), Error> {
        record.validate()?;
        if let Some(loss) = record.loss()?
            && self.losses.get(&loss.operation) != Some(&loss)
        {
            return Err(Error::Storage);
        }
        if self
            .updates
            .get(&record.id)
            .map_or(record.state != "capture", |old| !record.follows(old))
        {
            return Err(Error::Stale);
        }
        if !self.updates.contains_key(&record.id)
            && (self.updates.len() >= 256 || self.count() >= MAX_OPERATIONS)
        {
            return Err(Error::Capacity);
        }
        self.append(&record)?;
        self.updates.insert(record.id.clone(), record);
        Ok(())
    }

    pub fn save_changes(&mut self, record: super::changes::Record) -> Result<(), Error> {
        record.validate()?;
        if !self.changes.contains_key(record.id()) && self.count() >= MAX_OPERATIONS {
            return Err(Error::Storage);
        }
        self.append(&record)?;
        self.changes.insert(record.id().to_owned(), record);
        Ok(())
    }

    pub fn cached(&self, source: &Source) -> Option<Cache> {
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
            .open(self.path.with_extension("cache"))
            .ok()?;
        private(&file).ok()?;
        let mut bytes = Vec::new();
        file.take(super::transport::MAX_BODY as u64 + 1)
            .read_to_end(&mut bytes)
            .ok()?;
        if bytes.len() > super::transport::MAX_BODY {
            return None;
        }
        let cache: Cache = serde_json::from_slice(&bytes).ok()?;
        (cache.version == 1
            && cache.source == *source
            && cache.overview.project_id == source.project().ok()?.project_id
            && crate::contract::check_overview(&cache.overview).is_ok())
        .then_some(cache)
    }

    pub fn cache(&self, cache: Cache) -> Result<(), Error> {
        let path = self.path.with_extension("cache");
        let temp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
        let bytes = serde_json::to_vec(&cache).map_err(|_| Error::Storage)?;
        if bytes.len() > super::transport::MAX_BODY {
            return Err(Error::Storage);
        }
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(&temp)
            .map_err(|_| Error::Storage)?;
        let result = (|| {
            file.write_all(&bytes)
                .and_then(|_| file.sync_all())
                .map_err(|_| Error::Storage)?;
            std::fs::rename(&temp, &path).map_err(|_| Error::Storage)?;
            sync_parent(&path)
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&temp);
        }
        result
    }
}

fn sync_parent(path: &Path) -> Result<(), Error> {
    File::open(path.parent().ok_or(Error::Storage)?)
        .and_then(|f| f.sync_all())
        .map_err(|_| Error::Storage)
}
