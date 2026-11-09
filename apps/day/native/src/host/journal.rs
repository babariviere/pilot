//! One private append-only, fsynced command ledger. Pending records never authorize POST.
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
    file: File,
    path: PathBuf,
    bytes: u64,
    failed: bool,
    pub records: BTreeMap<String, Record>,
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
        for line in body.split(|b| *b == b'\n').filter(|line| !line.is_empty()) {
            let record: Record = serde_json::from_slice(line).map_err(|_| Error::Storage)?;
            if record.version != 1
                || !super::valid_id(&record.mission)
                || record.command.version != 1
                || record.command.home != record.source.home
                || record.command.project_id != record.source.project_id
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
            if records.len() > MAX_OPERATIONS {
                return Err(Error::Storage);
            }
        }
        file.sync_all().map_err(|_| Error::Storage)?;
        sync_parent(&path)?;
        Ok(Self {
            file,
            path,
            bytes,
            failed: false,
            records,
        })
    }

    pub fn save(&mut self, record: Record) -> Result<(), Error> {
        if self.failed
            || (!self.records.contains_key(&record.command.operation_id)
                && self.records.len() >= MAX_OPERATIONS)
        {
            return Err(Error::Storage);
        }
        private(&self.file)?;
        let m = self.file.metadata().map_err(|_| Error::Storage)?;
        let p = std::fs::symlink_metadata(&self.path).map_err(|_| Error::Storage)?;
        if !p.is_file() || p.dev() != m.dev() || p.ino() != m.ino() || m.len() != self.bytes {
            self.failed = true;
            return Err(Error::Storage);
        }
        let mut bytes = serde_json::to_vec(&record).map_err(|_| Error::Storage)?;
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
        self.bytes += bytes.len() as u64;
        self.records
            .insert(record.command.operation_id.clone(), record);
        self.failed = false;
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
            && cache.overview.project_id == source.project_id
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
