//! Isolated Settings foundation. No UI, environment lookup, global effects or Swift import.
//! `SettingsState` is pure. Run `SettingsStore` I/O on one background owner, never in render.
use serde::{Deserialize, Serialize};
use std::{
    ffi::CString,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    },
    path::{Component, PathBuf},
};

pub const PREFERENCES_FILE: &str = "preferences-v1.json";
pub const PREFERENCES_LIMIT: usize = 1024;
const LOCK_FILE: &str = "settings-owner.lock";
const PENDING_FILE: &str = ".preferences-v1.pending";

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AppearancePreference {
    #[default]
    System,
    Light,
    Dark,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Preferences {
    pub appearance: AppearancePreference,
    #[serde(default)]
    pub fonts: FontPreferences,
    #[serde(default)]
    pub automatic_update_checks: bool,
}

/// A bounded UTF-8 installed font name. Empty keeps the existing app default.
/// Value snapshots remain Copy, including in-flight persistence requests.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FontFamily([u8; 96]);
impl Default for FontFamily {
    fn default() -> Self {
        Self([0; 96])
    }
}
impl FontFamily {
    pub fn new(name: &str) -> Option<Self> {
        if name.len() > 96 || name.chars().any(char::is_control) {
            return None;
        }
        let mut bytes = [0; 96];
        bytes[..name.len()].copy_from_slice(name.as_bytes());
        Some(Self(bytes))
    }
    pub fn name(&self) -> &str {
        std::str::from_utf8(&self.0[..self.0.iter().position(|b| *b == 0).unwrap_or(96)])
            .expect("validated UTF-8")
    }
}
impl Serialize for FontFamily {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.name())
    }
}
impl<'de> Deserialize<'de> for FontFamily {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        Self::new(&value).ok_or_else(|| serde::de::Error::custom("invalid font name"))
    }
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FontPreferences {
    pub chat_family: FontFamily,
    pub code_family: FontFamily,
    /// Half points. None preserves the renderer's original inherited metrics.
    pub chat_size: Option<u8>,
    pub code_size: Option<u8>,
}
impl FontPreferences {
    pub fn valid(self) -> bool {
        self.chat_size.is_none_or(|s| (22..=44).contains(&s))
            && self.code_size.is_none_or(|s| (18..=40).contains(&s))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SettingsError {
    NotLoaded,
    UnsafePath,
    TooLarge,
    InvalidData,
    UnsupportedVersion,
    Busy,
    RecoveryRequired,
    Conflict,
    Io,
    /// Rename happened, but durability was not acknowledged. Retry confirms before writing.
    DurabilityUnknown,
}
impl SettingsError {
    /// Content-free, stable UI text. Never includes a path, raw OS error or stored bytes.
    pub fn message(self) -> &'static str {
        match self {
            Self::NotLoaded => "Load preferences before saving.",
            Self::UnsafePath => "Preferences storage is not a private owned directory or file.",
            Self::TooLarge => "Preferences exceed the supported size. Original data is preserved.",
            Self::InvalidData => {
                "Preferences are invalid or unsupported. Original data is preserved."
            }
            Self::UnsupportedVersion => {
                "Preferences use an unsupported version. Original data is preserved."
            }
            Self::Busy => "Preferences storage is busy. Retry after the other operation finishes.",
            Self::RecoveryRequired => {
                "An interrupted preferences save needs inspection. Its data is preserved."
            }
            Self::Conflict => "Preferences changed elsewhere. Reopen and review before saving.",
            Self::Io => {
                "Preferences could not be read or saved. Retry without discarding your changes."
            }
            Self::DurabilityUnknown => {
                "Save durability is unconfirmed. Retry to confirm the saved data."
            }
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LoadedPreferences {
    pub preferences: Preferences,
    /// False for a missing file: defaults are usable, not claimed durable.
    pub persisted: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SaveRequest {
    id: u64,
    preferences: Preferences,
}
impl SaveRequest {
    pub fn preferences(self) -> Preferences {
        self.preferences
    }
}

/// Explicit-save semantics. One in-flight operation, no timers/tasks or implicit writes.
#[derive(Debug, Default)]
pub struct SettingsState {
    current: Preferences,
    committed: Option<Preferences>,
    loaded: bool,
    loading: bool,
    pending: Option<SaveRequest>,
    unconfirmed: Option<Preferences>,
    next_id: u64,
    error: Option<SettingsError>,
}
impl SettingsState {
    pub fn current(&self) -> Preferences {
        self.current
    }
    pub fn committed(&self) -> Option<Preferences> {
        self.committed
    }
    pub fn loaded(&self) -> bool {
        self.loaded
    }
    pub fn loading(&self) -> bool {
        self.loading
    }
    pub fn saving(&self) -> bool {
        self.pending.is_some()
    }
    pub fn dirty(&self) -> bool {
        self.loaded
            && (self.unconfirmed.is_some() || self.current != self.committed.unwrap_or_default())
    }
    pub fn persisted(&self) -> bool {
        !self.saving() && self.unconfirmed.is_none() && self.committed == Some(self.current)
    }
    /// Loaded durable baseline (1), or one plus the latest exact SaveRequest ID.
    /// Never valid for dirty, pending or unconfirmed current preferences.
    #[cfg(any(test, target_os = "macos"))]
    pub(crate) fn durability_token(&self) -> Option<u64> {
        self.persisted()
            .then(|| self.next_id.checked_add(1))
            .flatten()
    }
    pub fn unconfirmed(&self) -> bool {
        self.unconfirmed.is_some()
    }
    pub fn error(&self) -> Option<SettingsError> {
        self.error
    }
    /// Initial load or explicit retry after a failed load. Never discards loaded edits.
    pub fn begin_load(&mut self) -> bool {
        if self.loaded || self.loading {
            return false;
        }
        self.loading = true;
        self.error = None;
        true
    }
    pub fn finish_load(&mut self, result: Result<LoadedPreferences, SettingsError>) -> bool {
        if !self.loading {
            return false;
        }
        self.loading = false;
        match result {
            Ok(value) => {
                self.loaded = true;
                self.current = value.preferences;
                self.committed = value.persisted.then_some(value.preferences);
                self.error = None;
            }
            Err(error) => self.error = Some(error),
        }
        true
    }
    pub fn set_appearance(&mut self, appearance: AppearancePreference) -> bool {
        if !self.loaded || self.current.appearance == appearance {
            return false;
        }
        self.current.appearance = appearance;
        true
    }
    pub fn set_fonts(&mut self, fonts: FontPreferences) -> bool {
        if !self.loaded || !fonts.valid() || self.current.fonts == fonts {
            return false;
        }
        self.current.fonts = fonts;
        true
    }
    pub fn set_automatic_update_checks(&mut self, value: bool) -> bool {
        if !self.loaded || self.current.automatic_update_checks == value {
            return false;
        }
        self.current.automatic_update_checks = value;
        true
    }
    pub fn revert(&mut self) -> bool {
        // An unconfirmed write must be reconciled, not hidden by Revert.
        if !self.loaded || self.saving() || self.unconfirmed.is_some() {
            return false;
        }
        self.current = self.committed.unwrap_or_default();
        self.error = None;
        true
    }
    /// Returns None for clean/unloaded/pending state. Retry calls this same method.
    pub fn begin_save(&mut self) -> Option<SaveRequest> {
        if !self.loaded || self.saving() || (!self.dirty() && self.unconfirmed.is_none()) {
            return None;
        }
        self.next_id = self.next_id.checked_add(1)?;
        let request = SaveRequest {
            id: self.next_id,
            preferences: self.unconfirmed.unwrap_or(self.current),
        };
        self.pending = Some(request);
        self.error = None;
        Some(request)
    }
    /// Explicit install-only checkpoint for usable but never-persisted defaults.
    /// Ordinary Save keeps its existing clean-state no-op contract.
    #[cfg(any(test, target_os = "macos"))]
    pub(crate) fn begin_durability_checkpoint(&mut self) -> Option<SaveRequest> {
        if !self.loaded
            || self.saving()
            || self.dirty()
            || self.unconfirmed.is_some()
            || self.committed.is_some()
        {
            return None;
        }
        self.next_id = self.next_id.checked_add(1)?;
        let request = SaveRequest {
            id: self.next_id,
            preferences: self.current,
        };
        self.pending = Some(request);
        self.error = None;
        Some(request)
    }
    pub fn finish_save(&mut self, request: SaveRequest, result: Result<(), SettingsError>) -> bool {
        if self.pending != Some(request) {
            return false;
        }
        self.pending = None;
        match result {
            Ok(()) => {
                self.committed = Some(request.preferences);
                self.unconfirmed = None;
                self.error = None;
            }
            Err(error) => {
                if error == SettingsError::DurabilityUnknown {
                    self.unconfirmed = Some(request.preferences);
                }
                self.error = Some(error);
            }
        }
        // Never replace current: the user may have edited while the worker was saving.
        true
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Document {
    version: u32,
    preferences: Preferences,
}
fn decode(bytes: &[u8]) -> Result<Preferences, SettingsError> {
    if bytes.len() > PREFERENCES_LIMIT {
        return Err(SettingsError::TooLarge);
    }
    let document: Document =
        serde_json::from_slice(bytes).map_err(|_| SettingsError::InvalidData)?;
    if document.version != 1 {
        return Err(SettingsError::UnsupportedVersion);
    }
    if !document.preferences.fonts.valid() {
        return Err(SettingsError::InvalidData);
    }
    Ok(document.preferences)
}

/// Blocking, bounded, explicit-path adapter, independent from draft-store ownership.
/// Constructing or loading never creates a directory, lock, snapshot or temporary file.
pub struct SettingsStore {
    root: PathBuf,
    // None = not successfully loaded; Some(None) = loaded missing/default state.
    baseline: Option<Option<Vec<u8>>>,
    uncertain: Option<Vec<u8>>,
    root_identity: Option<(u64, u64)>,
    #[cfg(test)]
    pub fail_at: Option<TestFault>,
}
#[cfg(test)]
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum TestFault {
    BeforeRename,
    AfterRename,
}
impl SettingsStore {
    /// Caller supplies a dedicated Next-owned root. No default-path discovery or I/O here.
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            baseline: None,
            uncertain: None,
            root_identity: None,
            #[cfg(test)]
            fail_at: None,
        }
    }
    pub fn load(&mut self) -> Result<LoadedPreferences, SettingsError> {
        // A failed/repeated load cannot leave stale write authority behind.
        if self.uncertain.is_some() {
            return Err(SettingsError::DurabilityUnknown);
        }
        self.baseline = None;
        let bytes = match self.directory(false)? {
            Some(directory) => {
                self.root_identity = Some(identity(&directory)?);
                read_snapshot(&directory)?
            }
            None => {
                self.root_identity = None;
                None
            }
        };
        let preferences = bytes
            .as_deref()
            .map(decode)
            .transpose()?
            .unwrap_or_default();
        let persisted = bytes.is_some();
        self.baseline = Some(bytes);
        Ok(LoadedPreferences {
            preferences,
            persisted,
        })
    }
    pub fn save(&mut self, preferences: Preferences) -> Result<(), SettingsError> {
        if !preferences.fonts.valid() {
            return Err(SettingsError::InvalidData);
        }
        let baseline = self
            .baseline
            .as_ref()
            .ok_or(SettingsError::NotLoaded)?
            .clone();
        let directory = match self.directory(false)? {
            Some(directory) => directory,
            None if self.root_identity.is_some() => return Err(SettingsError::Conflict),
            None => self.directory(true)?.ok_or(SettingsError::Io)?,
        };
        let identity = identity(&directory)?;
        if self
            .root_identity
            .is_some_and(|expected| expected != identity)
        {
            return Err(SettingsError::Conflict);
        }
        self.root_identity = Some(identity);
        File::open(self.root.parent().ok_or(SettingsError::UnsafePath)?)
            .and_then(|parent| parent.sync_all())
            .map_err(|_| SettingsError::Io)?;
        let lock = open_at(&directory, LOCK_FILE, libc::O_RDWR | libc::O_CREAT)?;
        private_file(&lock, 0)?;
        // Never unlink this inode. Per-operation ownership permits another instance to load,
        // but all saves re-read/compare the exact baseline while holding the same lock.
        if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err(SettingsError::Busy);
        }
        let current = read_snapshot(&directory)?;
        if let Some(attempted) = &self.uncertain {
            // Confirm the exact unacknowledged request first. A newer selection is a
            // separate save, so model and disk never disagree about the commit receipt.
            if decode(attempted)? != preferences {
                return Err(SettingsError::DurabilityUnknown);
            }
            if current.as_ref() != Some(attempted) {
                return Err(SettingsError::Conflict);
            }
            open_at(&directory, PREFERENCES_FILE, libc::O_RDONLY)?
                .sync_all()
                .map_err(|_| SettingsError::DurabilityUnknown)?;
            directory
                .sync_all()
                .map_err(|_| SettingsError::DurabilityUnknown)?;
            self.baseline = Some(current.clone());
            self.uncertain = None;
        } else if current != baseline {
            return Err(SettingsError::Conflict);
        }
        let bytes = serde_json::to_vec(&Document {
            version: 1,
            preferences,
        })
        .map_err(|_| SettingsError::InvalidData)?;
        if bytes.len() > PREFERENCES_LIMIT {
            return Err(SettingsError::TooLarge);
        }
        if current.as_ref() == Some(&bytes) {
            return Ok(());
        }
        let mut pending = open_at(
            &directory,
            PENDING_FILE,
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
        )?;
        let prepared = (|| {
            pending.write_all(&bytes).map_err(|_| SettingsError::Io)?;
            pending.sync_all().map_err(|_| SettingsError::Io)?;
            #[cfg(test)]
            if self.fail_at == Some(TestFault::BeforeRename) {
                return Err(SettingsError::Io);
            }
            Ok(())
        })();
        if let Err(error) = prepared {
            unlink_at(&directory, PENDING_FILE);
            return Err(error);
        }
        // Preserve externally changed/unsupported bytes, even after preparing the temp file.
        match read_snapshot(&directory) {
            Ok(value) if value == current => (),
            result => {
                unlink_at(&directory, PENDING_FILE);
                return Err(result.err().unwrap_or(SettingsError::Conflict));
            }
        }
        let from = CString::new(PENDING_FILE).unwrap();
        let to = CString::new(PREFERENCES_FILE).unwrap();
        if unsafe {
            libc::renameat(
                directory.as_raw_fd(),
                from.as_ptr(),
                directory.as_raw_fd(),
                to.as_ptr(),
            )
        } != 0
        {
            unlink_at(&directory, PENDING_FILE);
            return Err(SettingsError::Io);
        }
        self.uncertain = Some(bytes.clone());
        #[cfg(test)]
        if self.fail_at == Some(TestFault::AfterRename) {
            return Err(SettingsError::DurabilityUnknown);
        }
        directory
            .sync_all()
            .map_err(|_| SettingsError::DurabilityUnknown)?;
        self.baseline = Some(Some(bytes));
        self.uncertain = None;
        Ok(())
    }
    fn directory(&self, create: bool) -> Result<Option<File>, SettingsError> {
        // Reject relative/traversal/symlink paths, including symlink ancestors. A private
        // dedicated root is required; do not chmod an existing user-selected directory.
        if !self.root.is_absolute() || self.root.parent().is_none() {
            return Err(SettingsError::UnsafePath);
        }
        let mut path = PathBuf::new();
        for component in self.root.components() {
            if !matches!(component, Component::RootDir | Component::Normal(_)) {
                return Err(SettingsError::UnsafePath);
            }
            path.push(component);
            match fs::symlink_metadata(&path) {
                Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => (),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound && path == self.root => {
                    if !create {
                        return Ok(None);
                    }
                    fs::DirBuilder::new()
                        .mode(0o700)
                        .create(&path)
                        .map_err(|_| SettingsError::Io)?;
                }
                _ => return Err(SettingsError::UnsafePath),
            }
        }
        let directory = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_DIRECTORY)
            .open(&self.root)
            .map_err(|_| SettingsError::UnsafePath)?;
        let meta = directory.metadata().map_err(|_| SettingsError::Io)?;
        if meta.uid() != unsafe { libc::geteuid() } || meta.mode() & 0o077 != 0 {
            return Err(SettingsError::UnsafePath);
        }
        Ok(Some(directory))
    }
}

fn open_at(directory: &File, name: &str, flags: i32) -> Result<File, SettingsError> {
    let name = CString::new(name).map_err(|_| SettingsError::UnsafePath)?;
    let fd = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            name.as_ptr(),
            flags | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
            0o600,
        )
    };
    if fd < 0 {
        if name.as_bytes() == PENDING_FILE.as_bytes()
            && std::io::Error::last_os_error().kind() == std::io::ErrorKind::AlreadyExists
        {
            return Err(SettingsError::RecoveryRequired);
        }
        return Err(SettingsError::Io);
    }
    Ok(unsafe { File::from_raw_fd(fd) })
}
fn identity(file: &File) -> Result<(u64, u64), SettingsError> {
    let meta = file.metadata().map_err(|_| SettingsError::Io)?;
    Ok((meta.dev(), meta.ino()))
}
fn private_file(file: &File, cap: usize) -> Result<(), SettingsError> {
    let meta = file.metadata().map_err(|_| SettingsError::Io)?;
    if !meta.is_file()
        || meta.nlink() != 1
        || meta.uid() != unsafe { libc::geteuid() }
        || meta.mode() & 0o077 != 0
    {
        return Err(SettingsError::UnsafePath);
    }
    if meta.len() > cap as u64 {
        return Err(SettingsError::TooLarge);
    }
    Ok(())
}
fn read_snapshot(directory: &File) -> Result<Option<Vec<u8>>, SettingsError> {
    // Inspect without following links before opening; openat also refuses the final link
    // and NONBLOCK prevents a replaced FIFO from hanging the worker.
    let name = CString::new(PREFERENCES_FILE).unwrap();
    let mut meta = std::mem::MaybeUninit::<libc::stat>::uninit();
    if unsafe {
        libc::fstatat(
            directory.as_raw_fd(),
            name.as_ptr(),
            meta.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    } != 0
    {
        return if std::io::Error::last_os_error().kind() == std::io::ErrorKind::NotFound {
            Ok(None)
        } else {
            Err(SettingsError::Io)
        };
    }
    let meta = unsafe { meta.assume_init() };
    if meta.st_mode & libc::S_IFMT != libc::S_IFREG {
        return Err(SettingsError::UnsafePath);
    }
    let file = open_at(directory, PREFERENCES_FILE, libc::O_RDONLY)?;
    private_file(&file, PREFERENCES_LIMIT)?;
    let mut bytes = Vec::new();
    file.take(PREFERENCES_LIMIT as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| SettingsError::Io)?;
    decode(&bytes)?;
    Ok(Some(bytes))
}
fn unlink_at(directory: &File, name: &str) {
    let name = CString::new(name).unwrap();
    let _ = unsafe { libc::unlinkat(directory.as_raw_fd(), name.as_ptr(), 0) };
}
