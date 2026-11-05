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
/// Abandoned operation ids are a durable record, not a working set.
pub(crate) const ABANDONED_CAP: usize = 64;
pub(crate) const STATE_CAP: usize = 16 * 1024 * 1024;
pub(crate) const RECOVER_CAP: usize = 4 * 1024 * 1024;
pub(crate) type Failure = &'static str;

#[path = "delivery_diagnostic.rs"]
pub(crate) mod diagnostic;
use diagnostic::Diagnostic;

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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) diagnostic: Option<Diagnostic>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) answer: Option<crate::question::ReplyIdentity>,
}

/// The tracked item (a Slack message) a new chat starts from. pilotd links them with the
/// existing tracked-item PATCH only once the chat exists; the create request never carries it.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Tracked {
    pub(crate) item_id: String,
    pub(crate) project_id: String,
    /// What the draft shows, such as "#support".
    pub(crate) label: String,
}
impl Tracked {
    fn valid(&self) -> bool {
        token(&self.item_id)
            && token(&self.project_id)
            && !self.label.is_empty()
            && self.label.len() <= 256
    }
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Draft {
    pub(crate) revision: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) input_generation: Option<u64>,
    /// Explicit read-only specialist creation, never an ordinary Build draft.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub(crate) diagnostics: bool,
    pub(crate) text: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) attachments: Vec<crate::image_attachments::Attachment>,
    pub(crate) cwd: String,
    /// Canonical project chosen for a new draft, never inferred from cwd.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) project_id: Option<String>,
    /// Explicit choice is scoped to this exact draft project/path, never a default mutation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) model_choice: Option<crate::chat_models::DraftChoice>,
    pub(crate) mode: String,
    pub(crate) pending: Option<String>,
    pub(crate) last: Option<Delivery>,
    pub(crate) created: Option<String>,
    pub(crate) recovered: Arc<Vec<String>>,
    #[serde(default)]
    pub(crate) recovery_revision: u64,
    #[serde(default)]
    pub(crate) settled_revision: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) answer: Option<crate::question::AnswerDraft>,
    /// A new chat started from a tracked item. Its project is that item's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) tracked: Option<Tracked>,
}
impl Default for Draft {
    fn default() -> Self {
        Self {
            revision: 0,
            input_generation: None,
            diagnostics: false,
            text: String::new(),
            attachments: Vec::new(),
            cwd: String::new(),
            project_id: None,
            model_choice: None,
            mode: "build".into(),
            pending: None,
            last: None,
            created: None,
            recovered: Arc::new(Vec::new()),
            recovery_revision: 0,
            settled_revision: None,
            answer: None,
            tracked: None,
        }
    }
}
impl Draft {
    pub(crate) fn editable(&self) -> bool {
        self.pending.is_none() && self.created.is_none()
    }
}

// Question-only metadata edits must not count as editing an already-settled
// ordinary message. Actual ordinary text/config changes keep legacy semantics.
fn question_settled_guard(old: &Draft, next: &Draft) -> Option<u64> {
    let guard = old.settled_revision;
    if guard.is_some_and(|revision| old.revision <= revision)
        && old.answer != next.answer
        && old.text == next.text
        && old.attachments == next.attachments
        && old.cwd == next.cwd
        && old.project_id == next.project_id
        && old.model_choice == next.model_choice
        && old.mode == next.mode
        && old.diagnostics == next.diagnostics
        && old.tracked == next.tracked
    {
        guard.map(|revision| revision.max(next.revision))
    } else {
        guard
    }
}

fn retain_answer_draft(old: &Draft, next: &mut Draft) -> Result<(), Failure> {
    if next.answer.is_none() || !old.editable() {
        next.answer = old.answer.clone();
    }
    if let (Some(before), Some(after)) = (&old.answer, &next.answer)
        && before.identity.question != after.identity.question
        && !reply_accepted(old, &before.identity)
    {
        let text = before.recovery();
        if !text.is_empty() {
            if next.recovered.len() >= 8 {
                return Err("Question reply recovery is full; copy previous input first");
            }
            Arc::make_mut(&mut next.recovered).push(text);
            next.recovery_revision += 1;
        }
    }
    Ok(())
}

/// The exact reply has Local's accepted receipt, so it is in the conversation
/// and never becomes recovered text.
pub(crate) fn reply_accepted(draft: &Draft, identity: &crate::question::ReplyIdentity) -> bool {
    draft
        .last
        .as_ref()
        .is_some_and(|last| last.state == "accepted" && last.answer.as_ref() == Some(identity))
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) diagnostic: Option<Diagnostic>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) answer: Option<crate::question::ReplyIdentity>,
    /// Only newly captured sends opt in. Historical Unknown operations stay manual.
    /// Retain validation inputs, never rebuild the immutable envelope from live edits.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) automatic: Option<Box<Draft>>,
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
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub(crate) missions: BTreeMap<String, crate::mission_conversion::Attempt>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub(crate) project_registrations: BTreeMap<String, crate::project_registration::Attempt>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub(crate) model_changes: BTreeMap<String, crate::chat_models::Attempt>,
    /// One retained diagnostic repair start per diagnostics chat. Open ones are never replaced.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub(crate) repairs: BTreeMap<String, crate::diagnostic_repair::Attempt>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub(crate) insights: BTreeMap<String, crate::insights::Attempt>,
    /// Operation ids the user explicitly abandoned. They are never retried or executed again.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) abandoned: Vec<String>,
    /// Created chats, by session id, still to be linked to the tracked item they started from.
    /// Saved with the accepted creation, so a crash or lost reply never loses the link.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub(crate) links: BTreeMap<String, Tracked>,
}
impl Book {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    pub(crate) fn restart_settled(&self) -> bool {
        self.pending.is_empty() && self.gui_restart_safe()
    }
    /// The writer must still acknowledge a fresh checkpoint. Unknown immutable messages
    /// survive cold open unchanged; opening the store never checks or executes them.
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    pub(crate) fn gui_restart_safe(&self) -> bool {
        // An unconfirmed project registration is durable and never resent, so it survives a
        // restart unchanged. In-flight registration is fenced by the add-project sheet.
        // A dismissed Stop keeps an "unknown" summary, but Stop is never retried, so it
        // has nothing left to settle.
        self.pending.values().all(|intent| {
            matches!(intent.state.as_str(), "unknown" | "pending") && intent.operation.is_some()
        }) && self.model_changes.is_empty()
            && self
                .missions
                .values()
                .all(|a| !matches!(a.outcome, crate::mission_conversion::Outcome::Unknown))
            && self.drafts.values().all(|draft| {
                draft.last.as_ref().is_none_or(|d| {
                    d.kind == "stop" || !matches!(d.state.as_str(), "pending" | "unknown")
                })
            })
    }
}

impl Delivery {
    pub(crate) fn from_intent(intent: &Intent) -> Self {
        Self {
            id: intent.id.clone(),
            state: intent.state.clone(),
            target: intent.target.clone(),
            kind: intent
                .operation
                .as_ref()
                .map_or("stop", |op| op.kind.as_str())
                .into(),
            revision: intent.revision,
            diagnostic: intent.diagnostic,
            answer: intent.answer.clone(),
        }
    }
    pub(crate) fn same_operation(&self, other: &Self) -> bool {
        self.id == other.id
            && self.target == other.target
            && self.kind == other.kind
            && self.revision == other.revision
            && self.answer == other.answer
    }
    pub(crate) fn matches(&self, intent: &Intent, key: &str) -> bool {
        intent.key == key && self.same_operation(&Self::from_intent(intent))
    }
}

pub(crate) fn token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}
pub(crate) fn valid_key(key: &str) -> bool {
    crate::session_subagents::Target::from_key(key).is_some()
        || key
            .strip_prefix("chat:")
            .or_else(|| key.strip_prefix("new:"))
            .is_some_and(token)
}
pub(crate) fn hash(value: &str) -> String {
    hash_bytes(value.as_bytes())
}
pub(crate) fn hash_bytes(value: &[u8]) -> String {
    Sha256::digest(value)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()
}

fn validate_draft(key: &str, draft: &Draft) -> Result<(), Failure> {
    if draft
        .input_generation
        .is_some_and(|generation| generation > 9_007_199_254_740_990)
    {
        return Err("Invalid input generation");
    }
    if draft.diagnostics
        && (!key.starts_with("new:")
            || draft.mode != "ask"
            || draft.project_id.is_some()
            || !draft.cwd.is_empty()
            || draft.model_choice.is_some()
            || !draft.attachments.is_empty())
    {
        return Err("Diagnostic drafts cannot carry Build, project or attachment authority");
    }
    if let Some(answer) = &draft.answer {
        answer.validate()?;
        if !key.starts_with("chat:") || answer.identity.revision > draft.revision {
            return Err("Question reply draft owner differs");
        }
    }
    if let Some(choice) = &draft.model_choice {
        choice.validate()?;
    }
    if let Some(tracked) = &draft.tracked
        && (!key.starts_with("new:") || draft.diagnostics || !tracked.valid())
    {
        return Err("Draft is too large or invalid");
    }
    if !valid_key(key)
        || draft.revision > 9_007_199_254_740_990
        || draft.text.len() > TEXT_CAP
        || draft.attachments.iter().any(|a| !a.validate())
        || draft.cwd.len() > 4096
        || draft.project_id.as_deref().is_some_and(|id| !token(id))
        || !matches!(draft.mode.as_str(), "ask" | "build")
        || draft.recovered.len() > 8
        || draft.recovered.iter().any(|s| s.len() > RECOVER_CAP)
        || draft.recovery_revision >= 9_007_199_254_740_990
        || draft
            .settled_revision
            .is_some_and(|revision| revision > draft.revision)
        || draft.created.as_deref().is_some_and(|s| !token(s))
    {
        return Err("Draft is too large or invalid");
    }
    Ok(())
}

impl Book {
    #[cfg(any(test, feature = "native-probes"))]
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
            missions: BTreeMap::new(),
            project_registrations: BTreeMap::new(),
            model_changes: BTreeMap::new(),
            repairs: BTreeMap::new(),
            insights: BTreeMap::new(),
            abandoned: Vec::new(),
            links: BTreeMap::new(),
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
            || self.missions.len() > 32
            || self.project_registrations.len() > 32
            || self.model_changes.len() > 32
            || self.repairs.len() > 32
            || self.insights.len() > 64
            || self.abandoned.len() > ABANDONED_CAP
            || self.links.len() > DRAFT_CAP
            || self
                .links
                .iter()
                .any(|(session, tracked)| !token(session) || !tracked.valid())
        {
            return Err(
                "Saved drafts don't match this app or Local. Saving is off; the original file is kept.",
            );
        }
        for (source, attempt) in &self.missions {
            attempt.validate(source)?;
        }
        for (source, attempt) in &self.model_changes {
            attempt.validate(source)?;
        }
        for (id, attempt) in &self.project_registrations {
            attempt.validate(id)?;
        }
        for (specialist, attempt) in &self.repairs {
            attempt.validate(specialist)?;
            let op = &attempt.operation;
            if op.schema_version != 1
                || !token(&op.operation_id)
                || !token(&op.target_id)
                || op.producer_id != self.producer_id
                || op.sequence == 0
                || op.sequence >= self.next_sequence
                || op.origin != self.host
                || op.destination != self.host
                || op.payload.len() > 64 * 1024
                || hash(&op.payload) != op.payload_hash
            {
                return Err("Stored repair start is corrupt.");
            }
        }
        for (slot, attempt) in &self.insights {
            attempt.validate(slot)?;
            let op = &attempt.operation;
            if op.schema_version != 1
                || !token(&op.operation_id)
                || !token(&op.target_id)
                || op.producer_id != self.producer_id
                || op.sequence == 0
                || op.sequence >= self.next_sequence
                || op.origin != self.host
                || op.destination != self.host
                || hash(&op.payload) != op.payload_hash
            {
                return Err("Stored Insights action is corrupt.");
            }
        }
        for (index, id) in self.abandoned.iter().enumerate() {
            if !token(id) || self.abandoned[..index].contains(id) {
                return Err("Stored abandoned operation record is corrupt");
            }
        }
        for (key, draft) in &self.drafts {
            validate_draft(key, draft)?;
            if let Some(answer) = draft.last.as_ref().and_then(|last| last.answer.as_ref()) {
                answer.validate()?;
                if !key.starts_with("chat:")
                    || draft.last.as_ref().is_none_or(|last| {
                        last.kind != "chat-send" || answer.revision > last.revision
                    })
                {
                    return Err("Stored question delivery owner differs");
                }
            }
            if let Some(diagnostic) = draft.last.as_ref().and_then(|last| last.diagnostic) {
                diagnostic.validate()?;
            }
            if let Some(last) = &draft.last
                && (!token(&last.id)
                    || !token(&last.target)
                    || !matches!(
                        last.kind.as_str(),
                        "chat-create"
                            | "diagnostics-create"
                            | "chat-send"
                            | "subagent-send"
                            | "stop"
                    )
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
            if let Some(captured) = &intent.automatic {
                validate_draft(&intent.key, captured)?;
                if captured.revision != intent.revision
                    || intent.operation.as_ref().is_none_or(|op| {
                        !matches!(
                            op.kind.as_str(),
                            "chat-send" | "chat-create" | "diagnostics-create"
                        )
                    })
                {
                    return Err("Automatic delivery capture differs");
                }
            }
            if let Some(answer) = &intent.answer {
                answer.validate()?;
                if !intent.key.starts_with("chat:")
                    || answer.revision > intent.revision
                    || intent
                        .operation
                        .as_ref()
                        .is_none_or(|op| op.kind != "chat-send")
                    || self
                        .drafts
                        .get(&intent.key)
                        .and_then(|d| d.answer.as_ref())
                        .is_none_or(|d| d.identity != *answer)
                {
                    return Err("Pending question reply ownership differs");
                }
            }
            if let Some(diagnostic) = intent.diagnostic {
                diagnostic.validate()?;
            }
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
                    if self.drafts[&intent.key].diagnostics {
                        "diagnostics-create"
                    } else {
                        "chat-create"
                    }
                } else if intent.key.starts_with("subagent:") {
                    "subagent-send"
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
                if let Some(child) = crate::session_subagents::Target::from_key(&intent.key)
                    && (child.parent != op.target_id
                        || payload["name"] != child.name
                        || payload["createdAt"] != child.created_at)
                {
                    return Err("Subagent message target ownership differs");
                }
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
            fs::create_dir_all(&root).map_err(|_| "Couldn't create the draft folder")?;
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700))
                .map_err(|_| "Cannot protect private state")?;
        }
        let metadata = fs::symlink_metadata(&root).map_err(|_| "Cannot inspect private state")?;
        if !metadata.is_dir()
            || metadata.file_type().is_symlink()
            || metadata.mode() & 0o077 != 0
            || metadata.uid() != unsafe { libc::geteuid() }
        {
            return Err("The draft folder must be yours, private and not a symlink");
        }
        let mut files = 0;
        let mut bytes = 0u64;
        for entry in fs::read_dir(&root).map_err(|_| "Couldn't inspect the draft folder")? {
            files += 1;
            if files > 64 {
                return Err(
                    "The draft folder has too many files. Keep and inspect it before retrying",
                );
            }
            bytes = bytes.saturating_add(
                entry
                    .map_err(|_| "Couldn't inspect a draft folder entry")?
                    .metadata()
                    .map_err(|_| "Couldn't inspect the draft folder size")?
                    .len(),
            );
            if bytes > 4 * STATE_CAP as u64 {
                return Err("The draft folder exceeds 64 MiB. Keep and inspect it before retrying");
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
            return Err("The draft lock file is unsafe");
        }
        // Never unlink this inode: a second process must not acquire a different lock.
        if unsafe {
            libc::flock(
                std::os::fd::AsRawFd::as_raw_fd(&lock),
                libc::LOCK_EX | libc::LOCK_NB,
            )
        } != 0
        {
            return Err("Another Pilot Next is using the drafts. This one is read-only.");
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
            Err(_) => return Err("Couldn't load saved drafts. Nothing was overwritten"),
            Ok(file) => {
                let meta = file
                    .metadata()
                    .map_err(|_| "Cannot inspect state snapshot")?;
                if !meta.is_file()
                    || meta.len() > STATE_CAP as u64
                    || meta.mode() & 0o077 != 0
                    || meta.uid() != unsafe { libc::geteuid() }
                {
                    return Err("The draft file is unsafe or too large");
                }
                let mut bytes = Vec::new();
                file.take(STATE_CAP as u64 + 1)
                    .read_to_end(&mut bytes)
                    .map_err(|_| "Cannot read private state")?;
                if bytes.len() > STATE_CAP {
                    return Err("The draft file is too large");
                }
                serde_json::from_slice(&bytes)
                    .map_err(|_| "The draft file is damaged. It was kept as is; saving is off.")?
            }
        };
        book.validate(&host)?;
        if initialized.is_empty() {
            let bytes = serde_json::to_vec(&book).map_err(|_| "Couldn't set up draft storage")?;
            atomic_write(&root, &bytes).map_err(|_| "Couldn't save new draft storage")?;
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
            return Err("Draft saving stopped after a write error");
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
            return Err("Draft storage is full. Nothing was discarded.");
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
                    retain_answer_draft(old, &mut draft)?;
                    draft.settled_revision = question_settled_guard(old, &draft);
                    if !old.editable() {
                        draft.model_choice = old.model_choice.clone();
                        draft.project_id = old.project_id.clone();
                        draft.cwd = old.cwd.clone();
                        draft.tracked = old.tracked.clone();
                    }
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
        self.prepare_delivery(key, captured, follow_up, stop, None, false)
    }
    pub(crate) fn prepare_automatic(
        &mut self,
        key: &str,
        captured: &Draft,
        follow_up: bool,
    ) -> Result<Intent, Failure> {
        self.prepare_delivery(key, captured, follow_up, false, None, true)
    }
    pub(crate) fn prepare_answer(
        &mut self,
        key: &str,
        captured: &Draft,
        question: &crate::question::Question,
        answer: &crate::question::AnswerDraft,
    ) -> Result<Intent, Failure> {
        if !key.starts_with("chat:") || captured.answer.as_ref() != Some(answer) {
            return Err("Question reply capture does not match its owning draft");
        }
        let message = answer
            .reply(question)?
            .ok_or("Choose an answer or write a reply")?;
        self.prepare_delivery(
            key,
            captured,
            false,
            false,
            Some((answer.identity.clone(), message)),
            false,
        )
    }
    pub(crate) fn prepare_automatic_answer(
        &mut self,
        key: &str,
        captured: &Draft,
        question: &crate::question::Question,
    ) -> Result<Intent, Failure> {
        let answer = captured
            .answer
            .as_ref()
            .ok_or("Question reply capture is missing")?;
        let message = answer
            .reply(question)?
            .ok_or("Choose an answer or write a reply")?;
        self.prepare_delivery(
            key,
            captured,
            false,
            false,
            Some((answer.identity.clone(), message)),
            true,
        )
    }
    fn prepare_delivery(
        &mut self,
        key: &str,
        captured: &Draft,
        follow_up: bool,
        stop: bool,
        answer: Option<(crate::question::ReplyIdentity, String)>,
        automatic: bool,
    ) -> Result<Intent, Failure> {
        validate_draft(key, captured)?;
        if stop && crate::session_subagents::Target::from_key(key).is_some() {
            return Err("Subagent Stop is not supported here");
        }
        self.change(|book| {
            if stop&&serde_json::to_vec(book).map_err(|_|"Cannot budget Stop recovery")?.len()>STATE_CAP-RECOVER_CAP-1024*1024 {return Err("No room to keep withdrawn text for Stop. Copy or remove recovered text first.");}
            let existing=book.drafts.get(key).cloned().unwrap_or_else(||captured.clone());
            if stop&&existing.recovered.len()>=8{return Err("Recovered text storage is full. Copy and remove recovered text before Stop.");}
            if let Some(id)=&existing.pending {
                let intent=book.pending.get(id).cloned().ok_or("Missing pending intent")?;
                if answer.as_ref().map(|(a,_)|a)!=intent.answer.as_ref() {return Err("Another message is unconfirmed; the original was kept");}
                return Ok(intent);
            }
            if let Some((identity,_))=&answer {
                if existing.revision>captured.revision {return Err("The question reply changed; your input was kept");}
                if let Some(last)=&existing.last && let Some(previous)=&last.answer
                    && previous.question==identity.question && (last.state=="accepted" || previous.revision>=identity.revision) {
                    return Err("This question reply already settled; wait for the transcript or edit a rejected reply");
                }
            }
            if answer.is_none()&&!stop&&question_settled_guard(&existing,captured).is_some_and(|revision|captured.revision<=revision) {return Err("This draft revision already settled. Edit before starting a new delivery.");}
            if book.pending.len()>=32 {return Err("Pending delivery capacity reached");}
            if existing.created.is_some() {return Err("This new-chat draft already created a chat. Open it or start a separate draft.");}
            if existing.revision<captured.revision {
                let mut newer=captured.clone();newer.last=existing.last.clone();newer.created=existing.created.clone();newer.recovered=existing.recovered.clone();newer.recovery_revision=existing.recovery_revision;newer.settled_revision=existing.settled_revision;
                retain_answer_draft(&existing,&mut newer)?;
                newer.settled_revision=question_settled_guard(&existing,&newer);
                book.drafts.insert(key.into(),newer);
            }
            else if !book.drafts.contains_key(key) {book.drafts.insert(key.into(),existing.clone());}
            let id=Uuid::new_v4().to_string();
            let child=crate::session_subagents::Target::from_key(key);
            let target=if let Some(child)=&child {child.parent.clone()} else if let Some(id)=key.strip_prefix("chat:") {id.into()} else if !stop {Uuid::new_v4().to_string()} else {return Err("Stop requires an existing Local chat");};
            let operation=if stop {None} else {
                let ordinary=crate::image_attachments::message(&captured.text,&captured.attachments);
                let message=answer.as_ref().map_or(ordinary.as_str(),|(_,message)|message.as_str());
                if message.trim().is_empty() {return Err("Message is empty");}
                let create=key.starts_with("new:");
                if create&&!captured.diagnostics&&(captured.project_id.is_none()||!Path::new(&captured.cwd).is_absolute()) {return Err("Choose a configured Local project before creating this chat");}
                if create&&captured.tracked.as_ref().is_some_and(|t|captured.project_id.as_deref()!=Some(t.project_id.as_str())) {return Err("This chat's project differs from its Slack message's. Nothing was sent.");}
                // Project ID is the supported SpawnRequest contract. No cwd
                // override: the daemon owns project/workspace resolution.
                let mut payload=if create {serde_json::json!({"message":message,"projectId":captured.project_id,"mode":"build"})} else {serde_json::json!({"message":message,"mode":if follow_up {"followUp"} else {"steer"}})};
                if create&&captured.diagnostics {payload=serde_json::json!({"message":message,"mode":"ask","role":"diagnostics","diagnosticScope":"app","diagnosticHost":book.host});}
                if let Some(child)=&child {payload["name"]=child.name.clone().into();payload["createdAt"]=child.created_at.into();}
                if automatic && let Some((identity, _)) = &answer {payload["questionReplyId"] = identity.question.entry.into();}
                if automatic && !create {payload["inputGeneration"] = captured.input_generation.unwrap_or(0).into();}
                if create&&let Some(choice)=&captured.model_choice{
                    if captured.project_id.as_deref()!=Some(choice.project_id.as_str())||captured.cwd!=choice.cwd{return Err("Model choice belongs to another project directory. Choose it again explicitly.");}
                    payload["model"]=choice.choice.model.clone().into();
                    if let Some(level)=&choice.choice.thinking{payload["thinking"]=level.clone().into();}
                }
                let payload=payload.to_string();
                if payload.len()>64*1024 {return Err("Encoded message exceeds the daemon's 64 KiB operation limit");}
                let sequence=book.next_sequence;book.next_sequence+=1;
                Some(Operation {schema_version:1,operation_id:id.clone(),producer_id:book.producer_id.clone(),sequence,origin:book.host.clone(),destination:book.host.clone(),kind:if create {if captured.diagnostics {"diagnostics-create"} else {"chat-create"}} else if child.is_some() {"subagent-send"} else {"chat-send"}.into(),target_id:target.clone(),payload_hash:hash(&payload),payload})
            };
            let intent=Intent {id:id.clone(),key:key.into(),revision:captured.revision,target,operation,state:"unknown".into(),diagnostic:None,answer:answer.as_ref().map(|(a,_)|a.clone()),automatic:automatic.then(||Box::new(captured.clone()))};
            book.drafts.get_mut(key).ok_or("Missing owning draft")?.pending=Some(id.clone());
            book.pending.insert(id,intent.clone());Ok(intent)
        })
    }

    pub(crate) fn prepare_model_change(
        &mut self,
        attempt: crate::chat_models::Attempt,
    ) -> Result<(), Failure> {
        attempt.validate(&attempt.target.session)?;
        self.change(|book|{
            if book.model_changes.len()>=32||book.model_changes.contains_key(&attempt.target.session){return Err("A model change is already unconfirmed, or recovery storage is full. Nothing was sent again.");}
            if book.pending.values().any(|i|i.target==attempt.target.session){return Err("Chat delivery is pending. Model selection was not admitted.");}
            book.model_changes.insert(attempt.target.session.clone(),attempt);Ok(())
        })
    }
    pub(crate) fn finish_model_change(&mut self, session: &str, id: &str) -> Result<(), Failure> {
        self.change(|book| {
            if !book.model_changes.get(session).is_some_and(|a| a.id == id) {
                return Err("The model change record no longer matches.");
            }
            book.model_changes.remove(session);
            Ok(())
        })
    }

    pub(crate) fn prepare_project(&mut self, id: &str, path: &str) -> Result<(), Failure> {
        let attempt = crate::project_registration::Attempt {
            id: id.into(),
            path: path.into(),
            created: None,
        };
        attempt.validate(id)?;
        self.change(|book| {
            if book.project_registrations.contains_key(id) || book.project_registrations.values().any(|a| a.path == path) {
                return Err("This folder is already being added. Check projects; it won't be sent again.");
            }
            if book.project_registrations.len() >= 32 {
                // Only acknowledged receipts may retire; Unknown never does.
                let old = book.project_registrations.iter().find(|(_, a)| a.created.is_some()).map(|(id, _)| id.clone());
                if let Some(old) = old { book.project_registrations.remove(&old); }
                else { return Err("Unconfirmed project registration storage is full. Nothing was discarded or resent."); }
            }
            book.project_registrations.insert(id.into(), attempt);
            Ok(())
        })
    }
    pub(crate) fn finish_project(&mut self, id: &str, created: &str) -> Result<(), Failure> {
        self.change(|book| {
            let attempt = book
                .project_registrations
                .get_mut(id)
                .ok_or("Missing project registration attempt.")?;
            if attempt.created.as_deref().is_some_and(|old| old != created) {
                return Err("Project receipt cannot be replaced.");
            }
            attempt.created = Some(created.into());
            Ok(())
        })
    }

    /// Called on the existing writer worker BEFORE the one non-idempotent POST.
    /// Returning an existing attempt would incorrectly authorize retransmission.
    pub(crate) fn prepare_mission(
        &mut self,
        id: &str,
        request: crate::mission_conversion::Request,
    ) -> Result<crate::mission_conversion::Attempt, Failure> {
        use crate::mission_conversion::{Attempt, Outcome};
        // Retained records permit the legacy blank-classification edge only for
        // loading. Every new admission must pass the current daemon semantics.
        request.validate()?;
        let attempt = Attempt {
            id: id.into(),
            request,
            outcome: Outcome::Unknown,
        };
        let source = attempt.request.from_session_id.clone();
        attempt.validate(&source)?;
        self.change(|book| {
            if let Some(old) = book.missions.get(&source) {
                if old.id == attempt.id || old.outcome != Outcome::Rejected {
                    return Err("This chat already has a mission attempt. Check its outcome; do not resend.");
                }
            } else if book.missions.len() >= 32 {
                return Err("Mission attempt storage is full; nothing was discarded");
            }
            book.missions.insert(source, attempt.clone());
            Ok(attempt)
        })
    }

    pub(crate) fn finish_mission(
        &mut self,
        source: &str,
        id: &str,
        outcome: crate::mission_conversion::Outcome,
    ) -> Result<(), Failure> {
        use crate::mission_conversion::Outcome;
        self.change(|book| {
            let attempt = book
                .missions
                .get_mut(source)
                .ok_or("Missing mission attempt")?;
            if attempt.id != id {
                return Err("Mission attempt identity differs");
            }
            if attempt.outcome != Outcome::Unknown && attempt.outcome != outcome {
                return Err("A settled mission receipt cannot be replaced");
            }
            attempt.outcome = outcome;
            Ok(())
        })
    }

    /// Saves one immutable repair-create before its POST. An open start is never replaced.
    pub(crate) fn prepare_repair(
        &mut self,
        specialist: &str,
        proposal_id: &str,
        payload: String,
    ) -> Result<Operation, Failure> {
        use crate::diagnostic_repair::{Attempt, State};
        if payload.len() > 64 * 1024 {
            return Err("The reviewed repair exceeds the 64 KiB start limit.");
        }
        self.change(|book| {
            if let Some(old) = book.repairs.get(specialist) {
                if old.open() {
                    return Err("A repair start is still unconfirmed. Check it; nothing new was sent.");
                }
                if old.proposal_id == proposal_id && old.state == State::Accepted {
                    return Err("This proposal already started a repair chat.");
                }
            } else if book.repairs.len() >= 32 {
                // Only settled starts retire; an unconfirmed one is never discarded.
                let old = book.repairs.iter().find(|(_, a)| !a.open()).map(|(id, _)| id.clone());
                match old {
                    Some(old) => {
                        book.repairs.remove(&old);
                    }
                    None => return Err("Unconfirmed repair start storage is full. Nothing was discarded or sent."),
                }
            }
            let sequence = book.next_sequence;
            book.next_sequence += 1;
            let operation = Operation {
                schema_version: 1,
                operation_id: Uuid::new_v4().to_string(),
                producer_id: book.producer_id.clone(),
                sequence,
                origin: book.host.clone(),
                destination: book.host.clone(),
                kind: "repair-create".into(),
                target_id: Uuid::new_v4().to_string(),
                payload_hash: hash(&payload),
                payload,
            };
            book.repairs.insert(
                specialist.into(),
                Attempt {
                    proposal_id: proposal_id.into(),
                    operation: operation.clone(),
                    state: State::Unknown,
                    reason: None,
                },
            );
            Ok(operation)
        })
    }
    /// Records an exact receipt. A settled receipt is never replaced by another state.
    pub(crate) fn finish_repair(
        &mut self,
        specialist: &str,
        operation_id: &str,
        state: crate::diagnostic_repair::State,
        reason: Option<String>,
    ) -> Result<(), Failure> {
        self.change(|book| {
            let attempt = book
                .repairs
                .get_mut(specialist)
                .filter(|a| a.operation.operation_id == operation_id)
                .ok_or("The repair start changed. Its original record was kept.")?;
            if !attempt.open() && attempt.state != state {
                return Err("A settled repair receipt cannot be replaced.");
            }
            attempt.state = state;
            attempt.reason = reason.map(|r| r.chars().take(512).collect());
            Ok(())
        })
    }

    /// Persist exact Insights bytes before any POST. Open slots cannot be replaced.
    pub(crate) fn prepare_insights(
        &mut self,
        request: &crate::insights::Request,
    ) -> Result<Operation, Failure> {
        use crate::insights::{Attempt, State};
        request.validate()?;
        let slot = request.slot();
        if let crate::insights::Request::Enable { payload, .. }
        | crate::insights::Request::Settings { payload, .. }
        | crate::insights::Request::Apply { payload, .. }
        | crate::insights::Request::Replace { payload, .. } = request
        {
            // The confirmed home must still be this writer's Local; nothing is retargeted.
            let home = serde_json::from_str::<serde_json::Value>(payload)
                .map(|p| p["expectedHome"].clone())
                .unwrap_or_default();
            if home["daemonId"] != self.book.host.daemon_id.as_str()
                || home["lineageId"] != self.book.host.lineage_id.as_str()
            {
                return Err("Local changed since this confirmation. Nothing was sent.");
            }
        }
        self.change(|book| {
            if book.insights.get(&slot).is_some_and(Attempt::open) {
                return Err("An Insights action is still unconfirmed. Check it; nothing new was sent.");
            }
            if !book.insights.contains_key(&slot) && book.insights.len() >= 64 {
                let retired = book.insights.iter().find(|(_, a)| !a.open()).map(|(slot, _)| slot.clone());
                let Some(retired) = retired else {
                    return Err("Unconfirmed Insights action storage is full. Nothing was discarded or sent.");
                };
                book.insights.remove(&retired);
            }
            let sequence = book.next_sequence;
            book.next_sequence += 1;
            let payload = request.payload();
            let operation = Operation {
                schema_version: 1,
                operation_id: Uuid::new_v4().to_string(),
                producer_id: book.producer_id.clone(),
                sequence,
                origin: book.host.clone(),
                destination: book.host.clone(),
                kind: request.kind().into(),
                target_id: request.target().unwrap_or_else(|| Uuid::new_v4().to_string()),
                payload_hash: hash(&payload),
                payload,
            };
            book.insights.insert(slot.clone(), Attempt {
                slot, operation: operation.clone(), state: State::Unknown, reason: None, result: None,
            });
            Ok(operation)
        })
    }

    pub(crate) fn finish_insights(
        &mut self,
        slot: &str,
        operation_id: &str,
        state: crate::insights::State,
        reason: Option<String>,
        result: Option<serde_json::Value>,
    ) -> Result<(), Failure> {
        self.change(|book| {
            let attempt = book
                .insights
                .get_mut(slot)
                .filter(|a| a.operation.operation_id == operation_id)
                .ok_or("The Insights action changed. Its original record was kept.")?;
            let reason = reason.map(|r| r.chars().take(512).collect());
            if !attempt.open()
                && (attempt.state != state || attempt.reason != reason || attempt.result != result)
            {
                return Err("A settled Insights receipt cannot be replaced.");
            }
            attempt.state = state;
            attempt.reason = reason;
            attempt.result = result;
            Ok(())
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
            if kind != "stop" && intent.answer.is_none() {
                draft.settled_revision = Some(
                    draft
                        .settled_revision
                        .map_or(intent.revision, |old| old.max(intent.revision)),
                );
            }
            if accepted && kind != "stop" && intent.answer.is_none() {
                if draft.revision == intent.revision {
                    draft.text.clear();
                    draft.attachments.clear();
                }
                if matches!(kind.as_str(), "chat-create" | "diagnostics-create") {
                    draft.created = Some(intent.target.clone());
                }
                if kind == "chat-create"
                    && let Some(tracked) = draft.tracked.clone()
                {
                    book.links.insert(intent.target.clone(), tracked);
                }
            }
            if state == "rejected"
                && intent.answer.is_none()
                && draft.revision != intent.revision
                && let Some(operation) = &intent.operation
            {
                let value: serde_json::Value = serde_json::from_str(&operation.payload)
                    .map_err(|_| "Corrupt outgoing message")?;
                if let Some(original) = value["message"].as_str().filter(|text| *text != draft.text)
                {
                    if draft.recovered.len() >= 8 {
                        return Err(
                            "Recovered text storage is full; the original message was kept",
                        );
                    }
                    Arc::make_mut(&mut draft.recovered).push(original.into());
                    draft.recovery_revision += 1;
                }
            }
            if let Some(text) = withdrawn.filter(|s| !s.is_empty()) {
                if draft.recovered.len() >= 8 || text.len() > RECOVER_CAP {
                    return Err("Recovered Stop text is too large");
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
                // The old lookup diagnostic is not this settlement's outcome.
                // Install the new observation separately; details must never
                // make an otherwise valid settlement exceed the snapshot cap.
                diagnostic: None,
                answer: intent.answer,
            });
            Ok(())
        })
    }

    pub(crate) fn record_diagnostic(
        &mut self,
        key: &str,
        delivery: &Delivery,
    ) -> Result<(), Failure> {
        self.change(|book| {
            let diagnostic = delivery.diagnostic.ok_or("Missing delivery observation")?;
            diagnostic.validate()?;
            if let Some(intent) = book.pending.get_mut(&delivery.id) {
                if !delivery.matches(intent, key) {
                    return Err("Delivery observation owner differs");
                }
                intent.diagnostic = Some(diagnostic);
            } else {
                let last = book
                    .drafts
                    .get_mut(key)
                    .and_then(|d| d.last.as_mut())
                    .ok_or("Delivery observation owner disappeared")?;
                if !last.same_operation(delivery) {
                    return Err("Delivery observation operation differs");
                }
                last.diagnostic = Some(diagnostic);
            }
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
                        && draft.answer.is_none()
                        && draft.text.is_empty()
                        && draft.attachments.is_empty()
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
    /// Only local, never-submitted slots use ordinary draft deletion.
    pub(crate) fn discard_new_draft(&mut self, key: &str, revision: u64) -> Result<(), Failure> {
        if !key.starts_with("new:")
            || !self.book.drafts.get(key).is_some_and(|draft| {
                draft.editable() && draft.last.is_none() && draft.answer.is_none()
            })
        {
            return Err("Only an unsent new-chat draft can be deleted here.");
        }
        self.discard_draft(key, revision)
    }

    /// Discards a draft the user no longer wants. The caller copies its text out first.
    /// An unresolved operation is abandoned, never retried, and its id is retained so the
    /// same delivery is never prepared or executed again.
    pub(crate) fn discard_draft(&mut self, key: &str, revision: u64) -> Result<(), Failure> {
        self.change(|book| {
            let Some(draft) = book.drafts.get(key) else {
                return Err("Unknown draft");
            };
            if draft.revision != revision {
                return Err("Draft changed. Review it before discarding.");
            }
            if draft.answer.is_some() || draft.pending.as_ref().and_then(|id|book.pending.get(id)).is_some_and(|intent|intent.answer.is_some()) {
                return Err("Discard applies to the ordinary message draft; the separate question reply is retained");
            }
            if let Some(id) = draft.pending.clone() {
                let Some(intent) = book.pending.remove(&id) else {
                    return Err("Pending delivery ownership is corrupt");
                };
                if intent.key != key {
                    return Err("Pending delivery ownership is corrupt");
                }
                if !book.abandoned.contains(&id) {
                    if book.abandoned.len() >= ABANDONED_CAP {
                        book.abandoned.remove(0);
                    }
                    book.abandoned.push(id);
                }
            }
            book.drafts.remove(key);
            Ok(())
        })
    }
    pub(crate) fn retire_answer(
        &mut self,
        key: &str,
        revision: u64,
        identity: &crate::question::ReplyIdentity,
        recover: bool,
    ) -> Result<(), Failure> {
        self.change(|book| {
            let draft = book
                .drafts
                .get_mut(key)
                .ok_or("Question reply draft is missing")?;
            if draft.revision != revision
                || draft.pending.is_some()
                || draft
                    .answer
                    .as_ref()
                    .is_none_or(|a| a.identity != *identity)
            {
                return Err("The question reply changed; your input was kept");
            }
            let accepted = reply_accepted(draft, identity);
            if !recover && !accepted {
                return Err("Only a confirmed accepted reply may be cleared automatically");
            }
            if recover && !accepted {
                let text = draft.answer.as_ref().unwrap().recovery();
                if !text.is_empty() {
                    if draft.recovered.len() >= 8 {
                        return Err(
                            "Recovery is full; copy and remove previous recovered text first",
                        );
                    }
                    Arc::make_mut(&mut draft.recovered).push(text);
                    draft.recovery_revision += 1;
                }
            }
            draft.answer = None;
            let ordinary_settled = draft
                .settled_revision
                .is_some_and(|revision| draft.revision <= revision);
            draft.revision += 1;
            if ordinary_settled {
                draft.settled_revision = Some(draft.revision);
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

    /// Forgets a created chat's pending link once pilotd confirmed it, or the item is gone.
    pub(crate) fn linked(&mut self, session: &str, tracked: &Tracked) -> Result<(), Failure> {
        self.change(|book| {
            if book.links.get(session) == Some(tracked) {
                book.links.remove(session);
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
