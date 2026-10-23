//! Private, bounded, single-owner draft/intent snapshot. No Swift state import.
//! Called only on the interaction worker, never from render or the UI thread.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::Arc,
};
use uuid::Uuid;

pub(crate) const DRAFT_CAP: usize = 128;
pub(crate) const TEXT_CAP: usize = 32 * 1024;
pub(crate) const STATE_CAP: usize = 16 * 1024 * 1024;
pub(crate) const RECOVER_CAP: usize = 4 * 1024 * 1024;
pub(crate) type Failure = &'static str;

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Host {
    pub(crate) host_id: String,
    pub(crate) daemon_id: String,
    pub(crate) lineage_id: String,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Operation {
    pub(crate) schema_version: u32,
    pub(crate) operation_id: String,
    pub(crate) producer_id: String,
    pub(crate) sequence: u64,
    pub(crate) origin: Host,
    pub(crate) destination: Host,
    pub(crate) kind: String,
    pub(crate) target_id: String,
    pub(crate) payload: String,
    pub(crate) payload_hash: String,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Delivery {
    pub(crate) id: String,
    pub(crate) state: String,
    pub(crate) target: String,
    pub(crate) kind: String,
    pub(crate) revision: u64,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Draft {
    pub(crate) revision: u64,
    pub(crate) text: String,
    pub(crate) cwd: String,
    pub(crate) mode: String,
    pub(crate) pending: Option<String>,
    pub(crate) last: Option<Delivery>,
    pub(crate) created: Option<String>,
    pub(crate) recovered: Arc<Vec<String>>,
    #[serde(default)]
    pub(crate) recovery_revision: u64,
    #[serde(default)]
    pub(crate) settled_revision: Option<u64>,
}
impl Default for Draft {
    fn default() -> Self {
        Self {
            revision: 0,
            text: String::new(),
            cwd: String::new(),
            mode: "ask".into(),
            pending: None,
            last: None,
            created: None,
            recovered: Arc::new(Vec::new()),
            recovery_revision: 0,
            settled_revision: None,
        }
    }
}
impl Draft {
    pub(crate) fn editable(&self) -> bool {
        self.pending.is_none() && self.created.is_none()
    }
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Intent {
    pub(crate) id: String,
    pub(crate) key: String,
    pub(crate) revision: u64,
    pub(crate) target: String,
    pub(crate) operation: Option<Operation>,
    pub(crate) state: String,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Book {
    schema_version: u32,
    pub(crate) host: Host,
    producer_id: String,
    next_sequence: u64,
    pub(crate) drafts: BTreeMap<String, Draft>,
    pub(crate) pending: BTreeMap<String, Intent>,
}

pub(crate) fn token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}
pub(crate) fn valid_key(key: &str) -> bool {
    key.strip_prefix("chat:")
        .or_else(|| key.strip_prefix("new:"))
        .is_some_and(token)
}
pub(crate) fn hash(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

fn validate_draft(key: &str, draft: &Draft) -> Result<(), Failure> {
    if !valid_key(key)
        || draft.revision > 9_007_199_254_740_990
        || draft.text.len() > TEXT_CAP
        || draft.cwd.len() > 4096
        || !matches!(draft.mode.as_str(), "ask" | "build")
        || draft.recovered.len() > 8
        || draft.recovered.iter().any(|s| s.len() > RECOVER_CAP)
        || draft.recovery_revision >= 9_007_199_254_740_990
        || draft
            .settled_revision
            .is_some_and(|revision| revision > draft.revision)
        || draft.created.as_deref().is_some_and(|s| !token(s))
    {
        return Err("Draft exceeds private state limits or is invalid");
    }
    Ok(())
}

impl Book {
    #[cfg(feature = "native-probes")]
    pub(crate) fn shell_probe() -> Self {
        Self::fresh(Host {
            host_id: "local".into(),
            daemon_id: "synthetic-daemon".into(),
            lineage_id: "synthetic-lineage".into(),
        })
    }
    fn fresh(host: Host) -> Self {
        Self {
            schema_version: 1,
            host,
            producer_id: Uuid::new_v4().to_string(),
            next_sequence: 1,
            drafts: BTreeMap::new(),
            pending: BTreeMap::new(),
        }
    }
    fn validate(&self, host: &Host) -> Result<(), Failure> {
        if self.schema_version != 1
            || &self.host != host
            || host.host_id != "local"
            || ![
                &host.host_id,
                &host.daemon_id,
                &host.lineage_id,
                &self.producer_id,
            ]
            .into_iter()
            .all(|s| token(s))
            || self.next_sequence == 0
            || self.next_sequence > 9_007_199_254_740_990
            || self.drafts.len() > DRAFT_CAP
            || self.pending.len() > 32
        {
            return Err(
                "Private state identity/version/limits differ. Writes are disabled; original state is preserved.",
            );
        }
        for (key, draft) in &self.drafts {
            validate_draft(key, draft)?;
            if let Some(last) = &draft.last
                && (!token(&last.id)
                    || !token(&last.target)
                    || !matches!(last.kind.as_str(), "chat-create" | "chat-send" | "stop")
                    || !matches!(last.state.as_str(), "accepted" | "rejected" | "unknown")
                    || last.revision > draft.revision)
            {
                return Err("Stored delivery summary is corrupt");
            }
            if let Some(id) = &draft.pending
                && self.pending.get(id).is_none_or(|i| &i.key != key)
            {
                return Err("Draft delivery ownership is corrupt");
            }
        }
        for (id, intent) in &self.pending {
            if id != &intent.id
                || !token(id)
                || !token(&intent.target)
                || !valid_key(&intent.key)
                || self
                    .drafts
                    .get(&intent.key)
                    .is_none_or(|d| d.pending.as_ref() != Some(id))
                || !matches!(intent.state.as_str(), "unknown" | "pending")
            {
                return Err("Pending intent ownership is corrupt");
            }
            if let Some(op) = &intent.operation {
                let expected_kind = if intent.key.starts_with("new:") {
                    "chat-create"
                } else {
                    "chat-send"
                };
                if op.schema_version != 1
                    || op.operation_id != *id
                    || op.target_id != intent.target
                    || op.producer_id != self.producer_id
                    || op.sequence == 0
                    || op.sequence >= self.next_sequence
                    || op.origin != self.host
                    || op.destination != self.host
                    || op.kind != expected_kind
                    || op.payload.len() > 64 * 1024
                    || hash(&op.payload) != op.payload_hash
                {
                    return Err("Immutable operation is corrupt");
                }
                if intent.key.starts_with("chat:")
                    && intent.key.strip_prefix("chat:") != Some(op.target_id.as_str())
                {
                    return Err("Operation target ownership differs");
                }
                let payload: serde_json::Value = serde_json::from_str(&op.payload)
                    .map_err(|_| "Operation payload is corrupt")?;
                if payload["message"]
                    .as_str()
                    .is_none_or(|s| s.trim().is_empty())
                {
                    return Err("Operation message is corrupt");
                }
            } else if intent.key.strip_prefix("chat:") != Some(intent.target.as_str()) {
                return Err("Stop target ownership differs");
            }
        }
        Ok(())
    }
}

pub(crate) struct Store {
    root: PathBuf,
    _lock: File,
    pub(crate) book: Book,
    fault: bool,
    #[cfg(test)]
    pub(crate) fail_write: bool,
}
impl Store {
    pub(crate) fn is_faulted(&self) -> bool {
        self.fault
    }
    pub(crate) fn default_path() -> Result<PathBuf, Failure> {
        let home = PathBuf::from(std::env::var_os("HOME").ok_or("HOME is unavailable")?);
        #[cfg(target_os = "macos")]
        let root = home.join("Library/Application Support/Pilot Next");
        #[cfg(target_os = "linux")]
        let root = std::env::var_os("XDG_STATE_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".local/state"))
            .join("pilot-next");
        Ok(root)
    }

    pub(crate) fn open(root: PathBuf, host: Host) -> Result<Self, Failure> {
        if !root.exists() {
            fs::create_dir_all(&root).map_err(|_| "Cannot create private Pilot Next state")?;
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700))
                .map_err(|_| "Cannot protect private state")?;
        }
        let metadata = fs::symlink_metadata(&root).map_err(|_| "Cannot inspect private state")?;
        if !metadata.is_dir()
            || metadata.file_type().is_symlink()
            || metadata.mode() & 0o077 != 0
            || metadata.uid() != unsafe { libc::geteuid() }
        {
            return Err("Private state directory must be owned, private and not a symlink");
        }
        let mut files = 0;
        let mut bytes = 0u64;
        for entry in fs::read_dir(&root).map_err(|_| "Cannot inspect private directory budget")? {
            files += 1;
            if files > 64 {
                return Err(
                    "Private directory contains too many files; preserve and inspect it before retrying",
                );
            }
            bytes = bytes.saturating_add(
                entry
                    .map_err(|_| "Cannot inspect private directory entry")?
                    .metadata()
                    .map_err(|_| "Cannot inspect private directory size")?
                    .len(),
            );
            if bytes > 4 * STATE_CAP as u64 {
                return Err(
                    "Private directory exceeds 64 MiB; preserve and inspect it before retrying",
                );
            }
        }
        let mut lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(root.join("owner.lock"))
            .map_err(|_| "Cannot lock private state")?;
        let lock_meta = lock.metadata().map_err(|_| "Cannot inspect private lock")?;
        if !lock_meta.is_file()
            || lock_meta.len() > 3
            || lock_meta.uid() != unsafe { libc::geteuid() }
            || lock_meta.mode() & 0o077 != 0
        {
            return Err("Private state lock is unsafe");
        }
        // Never unlink this inode: a second process must not acquire a different lock.
        if unsafe {
            libc::flock(
                std::os::fd::AsRawFd::as_raw_fd(&lock),
                libc::LOCK_EX | libc::LOCK_NB,
            )
        } != 0
        {
            return Err(
                "Another Pilot Next instance owns draft state. This instance stays readonly.",
            );
        }
        let mut initialized = String::new();
        (&mut lock)
            .take(4)
            .read_to_string(&mut initialized)
            .map_err(|_| "Cannot read state initialization fence")?;
        if !initialized.is_empty() && initialized != "v1\n" {
            return Err("State initialization fence is invalid");
        }
        let path = root.join("state-v1.json");
        let book = match OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(path)
        {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                if !initialized.is_empty() {
                    return Err(
                        "Initialized state snapshot is missing. Refusing an empty overwrite.",
                    );
                }
                Book::fresh(host.clone())
            }
            Err(_) => return Err("Cannot load private state; no empty overwrite is allowed"),
            Ok(file) => {
                let meta = file
                    .metadata()
                    .map_err(|_| "Cannot inspect state snapshot")?;
                if !meta.is_file()
                    || meta.len() > STATE_CAP as u64
                    || meta.mode() & 0o077 != 0
                    || meta.uid() != unsafe { libc::geteuid() }
                {
                    return Err("Private state snapshot is unsafe or too large");
                }
                let mut bytes = Vec::new();
                file.take(STATE_CAP as u64 + 1)
                    .read_to_end(&mut bytes)
                    .map_err(|_| "Cannot read private state")?;
                if bytes.len() > STATE_CAP {
                    return Err("Private state snapshot exceeds limit");
                }
                serde_json::from_slice(&bytes).map_err(|_|"Private state is corrupt. Original bytes are preserved; writes are disabled.")?
            }
        };
        book.validate(&host)?;
        if initialized.is_empty() {
            let bytes = serde_json::to_vec(&book).map_err(|_| "Cannot initialize private state")?;
            atomic_write(&root, &bytes).map_err(|_| "Cannot durably initialize private state")?;
            lock.seek(SeekFrom::Start(0))
                .and_then(|_| lock.write_all(b"v1\n"))
                .and_then(|_| lock.sync_all())
                .map_err(|_| "Cannot seal state initialization")?;
        }
        Ok(Self {
            root,
            _lock: lock,
            book,
            fault: false,
            #[cfg(test)]
            fail_write: false,
        })
    }

    fn change<R>(
        &mut self,
        apply: impl FnOnce(&mut Book) -> Result<R, Failure>,
    ) -> Result<R, Failure> {
        if self.fault {
            return Err("Private state needs recovery after a write failure");
        }
        let mut next = self.book.clone();
        let result = apply(&mut next)?;
        next.validate(&self.book.host)?;
        // Stale edits, duplicate receipts and fenced cleanup can be semantic
        // no-ops. The current book is already durable; do not encode/fsync it
        // again. Keep validation and the I/O fault fence above this fast path.
        if next == self.book {
            return Ok(result);
        }
        let bytes = serde_json::to_vec(&next).map_err(|_| "Cannot encode private state")?;
        if bytes.len() > STATE_CAP {
            return Err("Private state is full. Nothing was discarded.");
        }
        #[cfg(test)]
        if self.fail_write {
            self.fault = true;
            return Err("Injected state write failure");
        }
        if atomic_write(&self.root, &bytes).is_err() {
            self.fault = true;
            return Err("Draft write failed. Delivery is disabled; keep/copy unsaved text.");
        }
        self.book = next;
        Ok(result)
    }

    pub(crate) fn save_edits(&mut self, edits: BTreeMap<String, Draft>) -> Result<(), Failure> {
        self.change(|book| {
            for (key, mut draft) in edits {
                validate_draft(&key, &draft)?;
                if let Some(old) = book.drafts.get(&key) {
                    if draft.revision <= old.revision {
                        continue;
                    }
                    draft.pending = old.pending.clone();
                    draft.last = old.last.clone();
                    draft.created = old.created.clone();
                    draft.recovered = old.recovered.clone();
                    draft.recovery_revision = old.recovery_revision;
                    draft.settled_revision = old.settled_revision;
                } else if book.drafts.len() >= DRAFT_CAP {
                    return Err("Draft capacity reached; nothing was evicted");
                }
                book.drafts.insert(key, draft);
            }
            Ok(())
        })
    }

    pub(crate) fn prepare(
        &mut self,
        key: &str,
        captured: &Draft,
        follow_up: bool,
        stop: bool,
    ) -> Result<Intent, Failure> {
        validate_draft(key, captured)?;
        self.change(|book| {
            if stop&&serde_json::to_vec(book).map_err(|_|"Cannot budget Stop recovery")?.len()>STATE_CAP-RECOVER_CAP-1024*1024 {return Err("Private state has no room to retain withdrawn Stop text. Copy/review existing recovery first.");}
            let existing=book.drafts.get(key).cloned().unwrap_or_else(||captured.clone());
            if stop&&existing.recovered.len()>=8{return Err("Recovered text storage is full. Copy and remove recovered text before Stop.");}
            if let Some(id)=&existing.pending {return book.pending.get(id).cloned().ok_or("Missing pending intent");}
            if !stop&&existing.settled_revision.is_some_and(|revision|captured.revision<=revision) {return Err("This draft revision already settled. Edit before starting a new delivery.");}
            if book.pending.len()>=32 {return Err("Pending delivery capacity reached");}
            if existing.created.is_some() {return Err("This new-chat draft already created a chat. Open it or start a separate draft.");}
            if existing.revision<captured.revision {
                let mut newer=captured.clone();newer.last=existing.last.clone();newer.created=existing.created.clone();newer.recovered=existing.recovered.clone();newer.recovery_revision=existing.recovery_revision;newer.settled_revision=existing.settled_revision;
                book.drafts.insert(key.into(),newer);
            }
            else if !book.drafts.contains_key(key) {book.drafts.insert(key.into(),existing.clone());}
            let id=Uuid::new_v4().to_string();
            let target=if let Some(id)=key.strip_prefix("chat:") {id.into()} else if !stop {Uuid::new_v4().to_string()} else {return Err("Stop requires an existing Local chat");};
            let operation=if stop {None} else {
                if captured.text.trim().is_empty() {return Err("Message is empty");}
                let create=key.starts_with("new:");
                if create&&!Path::new(&captured.cwd).is_absolute() {return Err("Choose an absolute Local working folder");}
                let payload=if create {serde_json::json!({"message":captured.text,"cwd":captured.cwd,"mode":captured.mode})} else {serde_json::json!({"message":captured.text,"mode":if follow_up {"followUp"} else {"steer"}})}.to_string();
                if payload.len()>64*1024 {return Err("Encoded message exceeds the daemon's 64 KiB operation limit");}
                let sequence=book.next_sequence;book.next_sequence+=1;
                Some(Operation {schema_version:1,operation_id:id.clone(),producer_id:book.producer_id.clone(),sequence,origin:book.host.clone(),destination:book.host.clone(),kind:if create {"chat-create"} else {"chat-send"}.into(),target_id:target.clone(),payload_hash:hash(&payload),payload})
            };
            let intent=Intent {id:id.clone(),key:key.into(),revision:captured.revision,target,operation,state:"unknown".into()};
            book.drafts.get_mut(key).ok_or("Missing owning draft")?.pending=Some(id.clone());
            book.pending.insert(id,intent.clone());Ok(intent)
        })
    }

    pub(crate) fn pending(&mut self, id: &str) -> Result<(), Failure> {
        self.change(|book| {
            let intent = book.pending.get_mut(id).ok_or("Unknown intent")?;
            intent.state = "pending".into();
            Ok(())
        })
    }

    /// One durable adoption clears ownership and the matching revision atomically.
    /// Private acknowledgement is NOT a backend receipt-retirement request.
    pub(crate) fn finish(
        &mut self,
        id: &str,
        state: &str,
        withdrawn: Option<String>,
    ) -> Result<(), Failure> {
        self.change(|book| {
            let Some(intent) = book.pending.remove(id) else {
                return Ok(());
            };
            let draft = book
                .drafts
                .get_mut(&intent.key)
                .ok_or("Draft owner disappeared")?;
            if draft.pending.as_deref() != Some(id) {
                return Err("Draft operation owner differs");
            }
            let kind = intent
                .operation
                .as_ref()
                .map_or("stop", |op| op.kind.as_str())
                .to_string();
            let accepted = state == "accepted";
            if kind != "stop" {
                draft.settled_revision = Some(
                    draft
                        .settled_revision
                        .map_or(intent.revision, |old| old.max(intent.revision)),
                );
            }
            if accepted && kind != "stop" {
                if draft.revision == intent.revision {
                    draft.text.clear();
                }
                if kind == "chat-create" {
                    draft.created = Some(intent.target.clone());
                }
            }
            if state == "rejected"
                && draft.revision != intent.revision
                && let Some(operation) = &intent.operation
            {
                let value: serde_json::Value = serde_json::from_str(&operation.payload)
                    .map_err(|_| "Corrupt outgoing message")?;
                if let Some(original) = value["message"].as_str().filter(|text| *text != draft.text)
                {
                    if draft.recovered.len() >= 8 {
                        return Err(
                            "Recovered input storage is full; original operation is retained",
                        );
                    }
                    Arc::make_mut(&mut draft.recovered).push(original.into());
                    draft.recovery_revision += 1;
                }
            }
            if let Some(text) = withdrawn.filter(|s| !s.is_empty()) {
                if draft.recovered.len() >= 8 || text.len() > RECOVER_CAP {
                    return Err("Recovered Stop text exceeds private state limits");
                }
                Arc::make_mut(&mut draft.recovered).push(text);
                draft.recovery_revision += 1;
            }
            draft.pending = None;
            draft.last = Some(Delivery {
                id: id.into(),
                state: state.into(),
                target: intent.target,
                kind,
                revision: intent.revision,
            });
            Ok(())
        })
    }

    pub(crate) fn clear_recovery(&mut self, key: &str, revision: u64) -> Result<(), Failure> {
        self.change(|book| {
            if let Some(draft) = book.drafts.get_mut(key)
                && draft.recovery_revision == revision
            {
                draft.recovered = Arc::new(Vec::new());
                draft.recovery_revision += 1;
            }
            Ok(())
        })
    }
    pub(crate) fn retire_empty(&mut self, key: &str, revision: u64) -> Result<(), Failure> {
        self.change(|book| {
            if key.starts_with("chat:")
                && book.drafts.get(key).is_some_and(|draft| {
                    draft.revision == revision
                        && draft.text.is_empty()
                        && draft.pending.is_none()
                        && draft.created.is_none()
                        && draft.recovered.is_empty()
                })
            {
                book.drafts.remove(key);
            }
            Ok(())
        })
    }
    pub(crate) fn retire_created(
        &mut self,
        key: &str,
        revision: u64,
        target: &str,
    ) -> Result<(), Failure> {
        self.change(|book| {
            if book.drafts.get(key).is_some_and(|d| {
                d.revision == revision
                    && d.text.is_empty()
                    && d.pending.is_none()
                    && d.created.as_deref() == Some(target)
            }) {
                book.drafts.remove(key);
            }
            Ok(())
        })
    }
}

fn atomic_write(root: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let path = root.join(format!(".snapshot-{}.tmp", Uuid::new_v4()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&path)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&path, root.join("state-v1.json"))?;
        File::open(root)?.sync_all()
    })();
    let _ = fs::remove_file(path);
    result
}

#[cfg(test)]
#[path = "delivery_store_tests.rs"]
mod tests;
