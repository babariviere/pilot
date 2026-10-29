//! Durable, same-volume staging. Ordinary quit never arms installation.
#[cfg(test)]
#[path = "installer_retention_tests.rs"]
mod retention_tests;
use crate::{
    Error, archive,
    manifest::{Trust, VerifiedManifest},
    transport::{Cancellation, verify_archive},
};
use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::{
        fd::AsRawFd,
        unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt},
    },
    path::{Path, PathBuf},
};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub enum Phase {
    Ready,
    Committed,
    Swapped,
    RelaunchRequested,
    StartupAcknowledged,
    Aborted,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Journal {
    schema: u32,
    phase: Phase,
    original_device: u64,
    original_inode: u64,
}

/// Only the worker owns this capability. UI gets a build label, not writable paths.
pub struct Staged {
    pub(crate) root: PathBuf,
    pub(crate) target: PathBuf,
    pub(crate) verified: VerifiedManifest,
    pub(crate) lock: File,
}

/// Helper-local proof of a freshly extracted payload. Never serialized or recovered.
#[cfg(all(target_os = "macos", feature = "native-macos"))]
pub(crate) struct PreparedPayload<'a> {
    staged: &'a Staged,
    bundle: PathBuf,
    identity: String,
}
#[cfg(all(target_os = "macos", feature = "native-macos"))]
impl PreparedPayload<'_> {
    /// Only a helper that never received COMMIT may remove its fresh preparation.
    pub(crate) fn discard(self) -> Result<(), Error> {
        let _guard = journal_guard(&self.staged.root)?;
        if read_journal(&self.staged.root)?.phase != Phase::Ready {
            return Err(Error::RecoveryRequired);
        }
        fs::remove_dir_all(self.bundle.parent().ok_or(Error::Filesystem)?)
            .map_err(|_| Error::Filesystem)?;
        sync_directory(&self.staged.root)
    }

    pub(crate) fn apply_after_exit(
        self,
        trust: &Trust,
        platform: &impl Platform,
        parent_exited: crate::helper::ExitedParent,
        check: impl FnOnce(&Path) -> Result<(), Error>,
    ) -> Result<(), Error> {
        self.staged.apply_with_payload_after_exit_checked(
            trust,
            platform,
            parent_exited,
            || {
                let phase = crate::timing::Phase::start();
                // Include every path, mode, byte and relative link, including resources
                // outside the native seal. Never adopt a digest from a writable journal.
                validate_target(&self.bundle, trust)?;
                if crate::runtime::identity(&self.bundle)? != self.identity {
                    return Err(Error::Identity);
                }
                phase.finish("exited_closure_hash");
                Ok(self.bundle)
            },
            check,
        )
    }
}

fn verify_source(bundle: &Path, manifest: &crate::manifest::Manifest) -> Result<(), Error> {
    let Some(source) = manifest.source.as_deref() else {
        return Ok(());
    };
    if cfg!(target_os = "linux") {
        return Ok(());
    } // Linux platform verifies its signed full inventory.
    if source.len() != 40
        || !source
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(Error::Identity);
    }
    for name in [
        "rust-inputs.json",
        "native-inputs.json",
        "updater-inputs.json",
    ] {
        let value: serde_json::Value = serde_json::from_slice(&read_small(
            &bundle.join("Contents/Resources").join(name),
            128 * 1024,
        )?)
        .map_err(|_| Error::Identity)?;
        if value["source"] != source {
            return Err(Error::Identity);
        }
    }
    let value: serde_json::Value = serde_json::from_slice(&read_small(
        &bundle.join("Contents/Resources/bundled-runtime.json"),
        8 * 1024 * 1024,
    )?)
    .map_err(|_| Error::Identity)?;
    if value["build"]["source"] != source {
        return Err(Error::Identity);
    }
    Ok(())
}

pub trait Platform {
    fn verify(
        &self,
        bundle: &Path,
        trust: &Trust,
        build: &str,
        short: Option<&str>,
    ) -> Result<(), Error>;
    fn verify_candidate(
        &self,
        bundle: &Path,
        trust: &Trust,
        manifest: &crate::manifest::Manifest,
    ) -> Result<(), Error> {
        self.verify(
            bundle,
            trust,
            &manifest.build,
            Some(&manifest.short_version),
        )?;
        verify_source(bundle, manifest)
    }
    fn swap(&self, parent: &File, staged_relative: &Path, target_name: &Path) -> Result<(), Error>;
    fn relaunch(&self, app: &Path, transaction: &Path) -> Result<(), Error>;
}

pub fn lock_target(target: &Path) -> Result<File, Error> {
    let parent = target.parent().ok_or(Error::Filesystem)?;
    let path = parent.join(".pilot-next-updater.lock");
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
        .map_err(|_| Error::Filesystem)?;
    let metadata = file.metadata().map_err(|_| Error::Filesystem)?;
    // SAFETY: geteuid has no pointer arguments or effects.
    if !metadata.is_file()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o077 != 0
    {
        return Err(Error::Filesystem);
    }
    // SAFETY: valid owned descriptor; never unlink/replace this permanent lock file.
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err(Error::Busy);
    }
    Ok(file)
}

pub fn new_stage(
    target: &Path,
    trust: &Trust,
    platform: &impl Platform,
) -> Result<(PathBuf, File), Error> {
    trust.validate()?;
    validate_target(target, trust)?;
    platform.verify(target, trust, &trust.current_build, None)?;
    let lock = lock_target(target)?;
    // Keep the two-transaction active bound. Completed history is moved intact,
    // never deleted; uncertain transactions and the current receipt stay put.
    let mut retained = Vec::new();
    for (scanned, entry) in fs::read_dir(target.parent().ok_or(Error::Filesystem)?)
        .map_err(|_| Error::Filesystem)?
        .enumerate()
    {
        if scanned >= 4096 {
            return Err(Error::StagingCapacity);
        }
        let entry = entry.map_err(|_| Error::Filesystem)?;
        if entry
            .file_name()
            .to_str()
            .is_some_and(|name| name.starts_with(".pilot-next-update-"))
        {
            retained.push(entry.path());
        }
    }
    let mut remaining = retained.len();
    for root in &retained {
        if remaining < 2 {
            break;
        }
        if archive_acknowledged(root, target, trust)? {
            remaining -= 1;
        }
    }
    if remaining >= 2 {
        return Err(Error::StagingCapacity);
    }
    new_stage_locked(target, lock)
}

fn new_stage_locked(target: &Path, lock: File) -> Result<(PathBuf, File), Error> {
    let mut random = [0; 16];
    SystemRandom::new()
        .fill(&mut random)
        .map_err(|_| Error::Native)?;
    let root = target.parent().ok_or(Error::Filesystem)?.join(format!(
        ".pilot-next-update-{}",
        crate::transport::hex(&random)
    ));
    fs::create_dir(&root).map_err(|_| Error::Filesystem)?;
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).map_err(|_| Error::Filesystem)?;
    acl_policy(&root, 1)?; // owned newly-created stage only; never repair existing ACLs
    Ok((root, lock))
}

const HISTORY: &str = ".pilot-next-updater-history";

fn transaction_name(root: &Path) -> bool {
    root.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| {
            name.strip_prefix(".pilot-next-update-")
                .is_some_and(|suffix| {
                    suffix.len() == 32 && suffix.bytes().all(|b| b.is_ascii_hexdigit())
                })
        })
}

fn private_directory(path: &Path) -> Result<(), Error> {
    let meta = fs::symlink_metadata(path).map_err(|_| Error::Filesystem)?;
    // SAFETY: current identity query only.
    if !meta.is_dir()
        || meta.file_type().is_symlink()
        || meta.uid() != unsafe { libc::geteuid() }
        || meta.mode() & 0o077 != 0
    {
        return Err(Error::Filesystem);
    }
    acl_policy(path, 2)
}

fn signed_manifest(root: &Path, trust: &Trust) -> Result<VerifiedManifest, Error> {
    use base64::Engine as _;
    let bytes = read_small(&root.join("manifest.json"), crate::manifest::MAX_MANIFEST)?;
    let envelope: crate::manifest::Envelope =
        serde_json::from_slice(&bytes).map_err(|_| Error::InvalidResponse)?;
    let signed = base64::engine::general_purpose::STANDARD
        .decode(envelope.signed)
        .map_err(|_| Error::Signature)?;
    let untrusted: crate::manifest::Manifest =
        serde_json::from_slice(&signed).map_err(|_| Error::InvalidResponse)?;
    VerifiedManifest::parse(&bytes, trust, untrusted.archive_asset_id)
}

// Caller holds the permanent target lock. Journal locking also excludes a late
// startup ACK/helper writer. A pending write or incomplete rollback stays active.
fn archive_acknowledged(root: &Path, target: &Path, trust: &Trust) -> Result<bool, Error> {
    if validate_root(root, target).is_err() {
        return Ok(false);
    }
    let Ok(_guard) = journal_guard(root) else {
        return Ok(false);
    };
    let Ok(journal) = read_journal(root) else {
        return Ok(false);
    };
    if journal.phase != Phase::StartupAcknowledged {
        return Ok(false);
    }
    let Ok(manifest) = signed_manifest(root, trust) else {
        return Ok(false);
    };
    // The running app's receipt stays at its original path, including reconnect
    // and UI checkpoint data. Only older completed history leaves active scans.
    if crate::manifest::Build::parse(&manifest.manifest().build)?
        >= crate::manifest::Build::parse(&trust.current_build)?
    {
        return Ok(false);
    }
    let rollback = root.join("install-payload").join(&trust.bundle_name);
    let Ok(old) = fs::symlink_metadata(&rollback) else {
        return Ok(false);
    };
    if !old.is_dir()
        || old.file_type().is_symlink()
        || rollback.canonicalize().ok().as_deref() != Some(rollback.as_path())
        || (old.dev(), old.ino()) != (journal.original_device, journal.original_inode)
        || verify_archive(
            &root.join("archive.zip"),
            &manifest,
            &Cancellation::default(),
        )
        .is_err()
    {
        return Ok(false);
    }
    let parent = target.parent().ok_or(Error::Filesystem)?;
    let history = parent.join(HISTORY);
    (|| {
        match fs::DirBuilder::new().mode(0o700).create(&history) {
            Ok(()) => acl_policy(&history, 1)?,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(_) => return Err(Error::Filesystem),
        }
        private_directory(&history)?;
        sync_directory(parent)?;
        archive_move(
            root,
            &history.join(root.file_name().ok_or(Error::Identity)?),
            sync_directory,
        )
    })()
    .map_err(|_| Error::StagingArchiveFailed)?;
    Ok(true)
}

fn archive_move(
    root: &Path,
    destination: &Path,
    sync: impl Fn(&Path) -> Result<(), Error>,
) -> Result<(), Error> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    let original = fs::symlink_metadata(root).map_err(|_| Error::Filesystem)?;
    let from = CString::new(root.as_os_str().as_bytes()).map_err(|_| Error::Filesystem)?;
    let to = CString::new(destination.as_os_str().as_bytes()).map_err(|_| Error::Filesystem)?;
    // SAFETY: live NUL-terminated names. Exclusive rename never overwrites history.
    #[cfg(target_os = "macos")]
    let result = unsafe { libc::renamex_np(from.as_ptr(), to.as_ptr(), libc::RENAME_EXCL) };
    #[cfg(target_os = "linux")]
    let result = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            from.as_ptr(),
            libc::AT_FDCWD,
            to.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if result != 0 {
        return Err(Error::Filesystem);
    }
    let moved = fs::symlink_metadata(destination).map_err(|_| Error::Filesystem)?;
    if (moved.dev(), moved.ino()) != (original.dev(), original.ino()) {
        return Err(Error::Identity);
    }
    sync(destination.parent().ok_or(Error::Filesystem)?)?;
    sync(root.parent().ok_or(Error::Filesystem)?)
}

/// Locate retained evidence by its original receipt path, without replaying it.
/// Archived entries must be acknowledged and have no pending journal write.
pub fn transaction_path(root: &Path) -> Result<PathBuf, Error> {
    match fs::symlink_metadata(root) {
        Ok(_) => return Ok(root.to_owned()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(Error::Filesystem),
    }
    if !root.is_absolute() || !transaction_name(root) {
        return Err(Error::Identity);
    }
    let parent = root.parent().ok_or(Error::Identity)?;
    validate_parents(parent)?;
    let history = parent.join(HISTORY);
    private_directory(&history)?;
    let archived = history.join(root.file_name().ok_or(Error::Identity)?);
    private_directory(&archived)?;
    if read_journal(&archived)?.phase != Phase::StartupAcknowledged {
        return Err(Error::RecoveryRequired);
    }
    Ok(archived)
}

pub fn finish_stage(
    root: PathBuf,
    target: PathBuf,
    lock: File,
    verified: VerifiedManifest,
    trust: &Trust,
    platform: &impl Platform,
    cancel: &Cancellation,
) -> Result<Staged, Error> {
    let archive = root.join("archive.zip");
    verify_archive(&archive, &verified, cancel)?;
    if !verified.is_newer(trust)? {
        return Err(Error::Version);
    }
    let bundle = archive::extract(&archive, &root.join("payload"), &trust.bundle_name, cancel)?;
    platform.verify_candidate(&bundle, trust, verified.manifest())?;
    cancel.check()?;
    write_new(&root.join("manifest.json"), verified.envelope())?;
    let original = fs::symlink_metadata(&target).map_err(|_| Error::Filesystem)?;
    write_journal(
        &root,
        &Journal {
            schema: 1,
            phase: Phase::Ready,
            original_device: original.dev(),
            original_inode: original.ino(),
        },
    )?;
    sync_directory(&root)?;
    sync_directory(root.parent().ok_or(Error::Filesystem)?)?;
    Ok(Staged {
        root,
        target,
        verified,
        lock,
    })
}

/// Read-only installation filesystem preflight, shared by startup and updates.
/// Does not authenticate a release; callers must also verify its native signature.
///
/// # Errors
/// Rejects unsafe paths, ownership, permissions, ACLs and bundle trees.
pub fn validate_target(target: &Path, trust: &Trust) -> Result<(), Error> {
    if !target.is_absolute()
        || target.file_name().is_none_or(|name| {
            // Linux installs may be renamed; the signed inventory identifies them.
            !cfg!(target_os = "linux") && name != trust.bundle_name.as_str()
        })
        || target.canonicalize().map_err(|_| Error::Filesystem)? != target
    {
        return Err(Error::Identity);
    }
    let metadata = fs::symlink_metadata(target).map_err(|_| Error::Filesystem)?;
    acl_policy(target, 0)?;
    validate_parents(target.parent().ok_or(Error::Filesystem)?)?;
    // Deliberately no privilege escalation or administrator-owned installation support.
    // SAFETY: geteuid is a pure process identity query.
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o022 != 0
    {
        return Err(Error::Filesystem);
    }
    validate_bundle_tree(target)?;
    Ok(())
}

fn validate_bundle_tree(root: &Path) -> Result<(), Error> {
    let mut pending = vec![(root.to_owned(), 0_usize)];
    let mut count = 0;
    // SAFETY: current identity query, no side effects.
    let uid = unsafe { libc::geteuid() };
    while let Some((path, depth)) = pending.pop() {
        count += 1;
        if count > 30_000 || depth > 128 {
            return Err(Error::Filesystem);
        }
        let metadata = fs::symlink_metadata(&path).map_err(|_| Error::Filesystem)?;
        if metadata.file_type().is_symlink() {
            if !path
                .canonicalize()
                .map_err(|_| Error::Filesystem)?
                .starts_with(root)
            {
                return Err(Error::Filesystem);
            }
            continue;
        }
        if (!metadata.is_dir() && !metadata.is_file())
            || (metadata.uid() != uid && metadata.uid() != 0)
            || metadata.mode() & 0o022 != 0
        {
            return Err(Error::Filesystem);
        }
        acl_policy(&path, 0)?;
        if metadata.is_dir() {
            for entry in fs::read_dir(&path).map_err(|_| Error::Filesystem)? {
                if pending.len() + count >= 30_000 {
                    return Err(Error::Filesystem);
                }
                pending.push((entry.map_err(|_| Error::Filesystem)?.path(), depth + 1));
            }
        }
    }
    Ok(())
}

pub(crate) fn validate_parents(parent: &Path) -> Result<(), Error> {
    // A root-owned sticky ancestor (e.g. /private/tmp) protects our owned entry;
    // an immediately writable/sticky parent is refused except standard macOS
    // /Applications, whose administrator write permission is intentional.
    // SAFETY: geteuid is a process identity query.
    let uid = unsafe { libc::geteuid() };
    for (index, ancestor) in parent.ancestors().enumerate() {
        acl_policy(ancestor, 0)?;
        let metadata = fs::symlink_metadata(ancestor).map_err(|_| Error::Filesystem)?;
        let safe_sticky = index > 0 && metadata.uid() == 0 && metadata.mode() & 0o1000 != 0;
        let system_applications =
            is_system_applications(ancestor, metadata.uid(), metadata.gid(), metadata.mode());
        if !metadata.is_dir()
            || metadata.file_type().is_symlink()
            || (metadata.uid() != uid && metadata.uid() != 0)
            || (metadata.mode() & 0o022 != 0 && !safe_sticky && !system_applications)
        {
            return Err(Error::Filesystem);
        }
    }
    Ok(())
}

fn is_system_applications(path: &Path, uid: u32, gid: u32, mode: u32) -> bool {
    // macOS administrators can already replace applications here. Trust only the
    // standard root:admin directory, not arbitrary group-writable ancestors.
    // Symlinks, non-directories and write-capable ACLs are still rejected above;
    // the app itself must remain user-owned, non-writable by others and sealed.
    cfg!(target_os = "macos")
        && path == Path::new("/Applications")
        && uid == 0
        && gid == 80 // macOS's system admin group
        && mode & 0o7777 == 0o775
}

fn entry_identity(parent: &File, relative: &Path) -> Result<(u64, u64), Error> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    let name = CString::new(relative.as_os_str().as_bytes()).map_err(|_| Error::Filesystem)?;
    let mut metadata = std::mem::MaybeUninit::<libc::stat>::uninit();
    // SAFETY: valid owned directory fd, NUL-terminated relative name and output allocation.
    if unsafe {
        libc::fstatat(
            parent.as_raw_fd(),
            name.as_ptr(),
            metadata.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    } != 0
    {
        return Err(Error::RecoveryRequired);
    }
    // SAFETY: successful fstatat initialized the stat object.
    let metadata = unsafe { metadata.assume_init() };
    if metadata.st_mode & libc::S_IFMT != libc::S_IFDIR {
        return Err(Error::RecoveryRequired);
    }
    // Darwin's dev_t is signed 32-bit; Linux already reports a u64.
    #[cfg(target_os = "macos")]
    let device = metadata.st_dev as u64;
    #[cfg(not(target_os = "macos"))]
    let device = metadata.st_dev;
    Ok((device, metadata.st_ino))
}

impl Staged {
    pub fn root(&self) -> &Path {
        &self.root
    }
    pub fn build(&self) -> &str {
        &self.verified.manifest().build
    }
    pub fn short_version(&self) -> &str {
        &self.verified.manifest().short_version
    }

    /// Helper-only reconstruction. Re-authenticate immutable bytes with the helper's
    /// compiled trust root, never a key supplied by the journal or command line.
    pub fn reopen(root: &Path, target: &Path, trust: &Trust, lock: File) -> Result<Self, Error> {
        validate_target(target, trust)?;
        validate_root(root, target)?;
        let parent = target.parent().ok_or(Error::Filesystem)?;
        if root.parent() != Some(parent)
            || !root.file_name().is_some_and(|name| {
                name.to_str().is_some_and(|name| {
                    name.strip_prefix(".pilot-next-update-")
                        .is_some_and(|suffix| {
                            suffix.len() == 32 && suffix.bytes().all(|b| b.is_ascii_hexdigit())
                        })
                })
            })
        {
            return Err(Error::Identity);
        }
        let metadata = fs::symlink_metadata(root).map_err(|_| Error::Filesystem)?;
        // SAFETY: no pointer inputs; expected owner is the current process user.
        if !metadata.is_dir()
            || metadata.file_type().is_symlink()
            || metadata.mode() & 0o077 != 0
            || metadata.uid() != unsafe { libc::geteuid() }
        {
            return Err(Error::Filesystem);
        }
        let bytes = read_small(&root.join("manifest.json"), crate::manifest::MAX_MANIFEST)?;
        // Asset id is signed. Parse it only to select the verification constraint, never trust it unsigned.
        let envelope: crate::manifest::Envelope =
            serde_json::from_slice(&bytes).map_err(|_| Error::InvalidResponse)?;
        use base64::Engine as _;
        let signed = base64::engine::general_purpose::STANDARD
            .decode(envelope.signed)
            .map_err(|_| Error::Signature)?;
        let untrusted: crate::manifest::Manifest =
            serde_json::from_slice(&signed).map_err(|_| Error::InvalidResponse)?;
        let verified = VerifiedManifest::parse(&bytes, trust, untrusted.archive_asset_id)?;
        if !verified.is_newer(trust)? {
            return Err(Error::Version);
        }
        Ok(Self {
            root: root.to_owned(),
            target: target.to_owned(),
            verified,
            lock,
        })
    }

    fn extract_install_payload(&self, trust: &Trust) -> Result<PathBuf, Error> {
        archive::extract(
            &self.root.join("archive.zip"),
            &self.root.join("install-payload"),
            &trust.bundle_name,
            &Cancellation::default(),
        )
    }

    /// Fresh helper-owned extraction while the GUI is still alive. Readiness does
    /// not commit intent; every security/owner gate runs again after actual exit.
    #[cfg(all(target_os = "macos", feature = "native-macos"))]
    pub(crate) fn prepare_payload(
        &self,
        trust: &Trust,
        platform: &impl Platform,
    ) -> Result<PreparedPayload<'_>, Error> {
        if read_journal(&self.root)?.phase != Phase::Ready {
            return Err(Error::RecoveryRequired);
        }
        let phase = crate::timing::Phase::start();
        verify_archive(
            &self.root.join("archive.zip"),
            &self.verified,
            &Cancellation::default(),
        )?;
        phase.finish("prepared_archive_verify");
        let phase = crate::timing::Phase::start();
        let bundle = self.extract_install_payload(trust)?;
        phase.finish("prepared_extract_sync");
        let phase = crate::timing::Phase::start();
        platform.verify_candidate(&bundle, trust, self.verified.manifest())?;
        validate_target(&bundle, trust)?;
        let identity = crate::runtime::identity(&bundle)?;
        phase.finish("prepared_candidate_closure_verify");
        Ok(PreparedPayload {
            staged: self,
            bundle,
            identity,
        })
    }

    /// Invoked ONLY after COMMIT and OS-observed parent exit. No on-quit observer.
    /// The old bundle is retained, not deleted, at payload/<bundle_name> after swap.
    pub fn apply_after_exit(
        &self,
        trust: &Trust,
        platform: &impl Platform,
        parent_exited: crate::helper::ExitedParent,
    ) -> Result<(), Error> {
        self.apply_after_exit_checked(trust, platform, parent_exited, |_| Ok(()))
    }

    pub(crate) fn apply_after_exit_checked(
        &self,
        trust: &Trust,
        platform: &impl Platform,
        parent_exited: crate::helper::ExitedParent,
        check: impl FnOnce(&Path) -> Result<(), Error>,
    ) -> Result<(), Error> {
        self.apply_with_payload_after_exit_checked(
            trust,
            platform,
            parent_exited,
            || {
                let phase = crate::timing::Phase::start();
                let candidate = self.extract_install_payload(trust)?;
                phase.finish("exited_extract_sync");
                Ok(candidate)
            },
            check,
        )
    }

    fn apply_with_payload_after_exit_checked(
        &self,
        trust: &Trust,
        platform: &impl Platform,
        parent_exited: crate::helper::ExitedParent,
        payload: impl FnOnce() -> Result<PathBuf, Error>,
        check: impl FnOnce(&Path) -> Result<(), Error>,
    ) -> Result<(), Error> {
        parent_exited.consume();
        let mut journal = read_journal(&self.root)?;
        if journal.phase != Phase::Committed {
            return Err(Error::RecoveryRequired);
        }
        let original = fs::symlink_metadata(&self.target).map_err(|_| Error::Filesystem)?;
        if original.dev() != journal.original_device || original.ino() != journal.original_inode {
            return Err(Error::RecoveryRequired);
        }
        let phase = crate::timing::Phase::start();
        platform.verify(&self.target, trust, &trust.current_build, None)?;
        phase.finish("exited_target_verify");
        let parent_path = self.target.parent().ok_or(Error::Filesystem)?;
        validate_parents(parent_path)?;
        let parent = open_directory(parent_path)?;
        let held_parent = parent.metadata().map_err(|_| Error::Filesystem)?;
        // Archive authentication remains fresh after exit even when extraction
        // was prepared before quit. Prepared payloads require an exact closure match.
        let cancel = Cancellation::default();
        let phase = crate::timing::Phase::start();
        verify_archive(&self.root.join("archive.zip"), &self.verified, &cancel)?;
        phase.finish("exited_archive_verify");
        let candidate = payload()?;
        let phase = crate::timing::Phase::start();
        platform.verify_candidate(&candidate, trust, self.verified.manifest())?;
        phase.finish("exited_candidate_verify");
        let phase = crate::timing::Phase::start();
        check(&candidate)?;
        phase.finish("exited_guard_verify");
        let phase = crate::timing::Phase::start();
        // Keep the old app in the same directory as the actually swapped candidate.
        let relative = candidate
            .strip_prefix(self.target.parent().ok_or(Error::Filesystem)?)
            .map_err(|_| Error::Filesystem)?;
        let target_name = Path::new(self.target.file_name().ok_or(Error::Filesystem)?);
        let candidate_identity = entry_identity(&parent, relative)?;
        let journal_guard = journal_guard(&self.root)?;
        journal = read_journal(&self.root)?;
        if journal.phase != Phase::Committed {
            return Err(Error::RecoveryRequired);
        }
        validate_parents(parent_path)?;
        let named_parent = fs::symlink_metadata(parent_path).map_err(|_| Error::Filesystem)?;
        if (held_parent.dev(), held_parent.ino()) != (named_parent.dev(), named_parent.ino())
            || entry_identity(&parent, target_name)?
                != (journal.original_device, journal.original_inode)
        {
            return Err(Error::RecoveryRequired);
        }
        platform.swap(&parent, relative, target_name)?;
        if entry_identity(&parent, target_name)? != candidate_identity
            || entry_identity(&parent, relative)?
                != (journal.original_device, journal.original_inode)
        {
            return Err(Error::RecoveryRequired);
        }
        parent.sync_all().map_err(|_| Error::RecoveryRequired)?;
        // The exchange crosses directory entries, even on one volume. Persist
        // both parents before recording the durable Swapped phase.
        sync_directory(candidate.parent().ok_or(Error::Filesystem)?)
            .map_err(|_| Error::RecoveryRequired)?;
        journal.phase = Phase::Swapped;
        write_journal(&self.root, &journal)?;
        // Persist intent BEFORE launching. A fast new app may acknowledge startup
        // while open is returning; never overwrite its newer journal phase afterwards.
        journal.phase = Phase::RelaunchRequested;
        write_journal(&self.root, &journal)?;
        drop(journal_guard);
        phase.finish("swap_journal_sync");
        let phase = crate::timing::Phase::start();
        // open success is NOT startup acknowledgement or a promise of rollback.
        if platform.relaunch(&self.target, &self.root).is_err() {
            return Err(Error::RecoveryRequired);
        }
        phase.finish("relaunch_command");
        Ok(())
    }

    #[cfg(any(
        test,
        any(
            all(target_os = "macos", feature = "native-macos"),
            all(target_os = "linux", feature = "native-linux")
        )
    ))]
    pub(crate) fn mark_committed(&self) -> Result<(), Error> {
        let _guard = journal_guard(&self.root)?;
        let mut journal = read_journal(&self.root)?;
        if journal.phase != Phase::Ready {
            return Err(Error::RecoveryRequired);
        }
        journal.phase = Phase::Committed;
        write_journal(&self.root, &journal)
    }
}

/// Read-only recovery inspection. No automatic retry, deletion or rollback.
pub fn recovery_phase(root: &Path) -> Result<Phase, Error> {
    Ok(read_journal(&transaction_path(root)?)?.phase)
}
/// Startup cleanup of downloads that were verified but never committed (phase Ready),
/// so a previous session's staged update does not block the next check as "recovery".
/// Nothing was installed: COMMIT is the only path past Ready. A live prepared helper
/// holds the target lock, so a busy lock leaves everything in place. Other phases,
/// unreadable journals and unexpected names are left for `recoveries` to report.
/// Returns how many stages were removed.
pub fn discard_uncommitted(target: &Path, trust: &Trust) -> Result<usize, Error> {
    validate_target(target, trust)?;
    let lock = match lock_target(target) {
        Ok(lock) => lock,
        Err(Error::Busy) => return Ok(0),
        Err(error) => return Err(error),
    };
    let parent = target.parent().ok_or(Error::Identity)?;
    let mut stale = Vec::new();
    for (count, entry) in fs::read_dir(parent)
        .map_err(|_| Error::Filesystem)?
        .enumerate()
    {
        if count >= 4096 {
            break;
        }
        let Ok(entry) = entry else { continue };
        let root = entry.path();
        if validate_root(&root, target).is_ok() && matches!(recovery_phase(&root), Ok(Phase::Ready))
        {
            stale.push(root);
        }
    }
    for root in &stale {
        fs::remove_dir_all(root).map_err(|_| Error::Filesystem)?;
    }
    if !stale.is_empty() {
        sync_directory(parent)?;
    }
    drop(lock);
    Ok(stale.len())
}

/// Read-only bounded startup inspection. Unknown/corrupt transactions are never
/// retried, deleted, adopted or treated as successful installation.
pub fn recoveries(target: &Path, trust: &Trust) -> Result<Vec<(PathBuf, Phase)>, Error> {
    validate_target(target, trust)?;
    let parent = target.parent().ok_or(Error::Identity)?;
    let mut result = Vec::new();
    for (count, entry) in fs::read_dir(parent)
        .map_err(|_| Error::Filesystem)?
        .enumerate()
    {
        if count >= 4096 {
            return Err(Error::RecoveryRequired);
        }
        let entry = entry.map_err(|_| Error::Filesystem)?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        let Some(suffix) = name.strip_prefix(".pilot-next-update-") else {
            continue;
        };
        if suffix.len() != 32 || !suffix.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(Error::RecoveryRequired);
        }
        let root = entry.path();
        validate_root(&root, target)?;
        let phase = recovery_phase(&root)?;
        if phase != Phase::StartupAcknowledged {
            result.push((root, phase));
        }
        if result.len() > 2 {
            return Err(Error::RecoveryRequired);
        }
    }
    Ok(result)
}

/// Integration calls this only AFTER the new app has durably loaded its state.
/// Acknowledgement does not erase the retained old app; cleanup is a separate action.
pub fn acknowledge_startup(
    root: &Path,
    active_build: &str,
    trust: &Trust,
    platform: &impl Platform,
    target: &Path,
) -> Result<(), Error> {
    validate_target(target, trust)?;
    let located = transaction_path(root)?;
    let root = located.as_path();
    validate_root(root, target)?;
    let _guard = journal_guard(root)?;
    let bytes = read_small(&root.join("manifest.json"), crate::manifest::MAX_MANIFEST)?;
    use base64::Engine as _;
    let envelope: crate::manifest::Envelope =
        serde_json::from_slice(&bytes).map_err(|_| Error::InvalidResponse)?;
    let untrusted: crate::manifest::Manifest = serde_json::from_slice(
        &base64::engine::general_purpose::STANDARD
            .decode(envelope.signed)
            .map_err(|_| Error::Signature)?,
    )
    .map_err(|_| Error::InvalidResponse)?;
    let manifest = VerifiedManifest::parse(&bytes, trust, untrusted.archive_asset_id)?;
    if manifest.manifest().build != active_build {
        return Err(Error::Version);
    }
    platform.verify_candidate(target, trust, manifest.manifest())?;
    let mut journal = read_journal(root)?;
    if journal.phase == Phase::StartupAcknowledged {
        return Ok(());
    }
    if !matches!(journal.phase, Phase::Swapped | Phase::RelaunchRequested) {
        return Err(Error::RecoveryRequired);
    }
    journal.phase = Phase::StartupAcknowledged;
    write_journal(root, &journal)
}

fn read_journal(root: &Path) -> Result<Journal, Error> {
    // A durable old phase does not settle an interrupted newer write.
    match fs::symlink_metadata(root.join("journal.pending")) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        _ => return Err(Error::RecoveryRequired),
    }
    let journal: Journal = serde_json::from_slice(&read_small(&root.join("journal.json"), 1024)?)
        .map_err(|_| Error::RecoveryRequired)?;
    if journal.schema != 1 {
        return Err(Error::RecoveryRequired);
    }
    Ok(journal)
}
fn write_journal(root: &Path, journal: &Journal) -> Result<(), Error> {
    let bytes = serde_json::to_vec(journal).map_err(|_| Error::Filesystem)?;
    let temporary = root.join("journal.pending");
    write_new(&temporary, &bytes)?;
    fs::rename(temporary, root.join("journal.json")).map_err(|_| Error::Filesystem)?;
    sync_directory(root)
}
pub(crate) fn write_new(path: &Path, bytes: &[u8]) -> Result<(), Error> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(|_| Error::Filesystem)?;
    file.write_all(bytes)
        .and_then(|()| file.sync_all())
        .map_err(|_| Error::Filesystem)
}
fn read_small(path: &Path, maximum: usize) -> Result<Vec<u8>, Error> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(|_| Error::Filesystem)?;
    let metadata = file.metadata().map_err(|_| Error::Filesystem)?;
    if !metadata.is_file() || metadata.len() > maximum as u64 {
        return Err(Error::Filesystem);
    }
    let mut result = Vec::new();
    file.take(maximum as u64 + 1)
        .read_to_end(&mut result)
        .map_err(|_| Error::Filesystem)?;
    if result.len() > maximum {
        return Err(Error::Filesystem);
    }
    Ok(result)
}
pub(crate) fn open_directory(path: &Path) -> Result<File, Error> {
    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
        .map_err(|_| Error::Filesystem)
}

fn sync_directory(path: &Path) -> Result<(), Error> {
    open_directory(path)?
        .sync_all()
        .map_err(|_| Error::Filesystem)
}

fn journal_guard(root: &Path) -> Result<File, Error> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(root.join("journal.lock"))
        .map_err(|_| Error::Filesystem)?;
    // SAFETY: flock holds only this private transaction's journal serialization lock.
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err(Error::Busy);
    }
    Ok(file)
}

fn validate_root(root: &Path, target: &Path) -> Result<(), Error> {
    acl_policy(root, 2)?;
    let history = target.parent().ok_or(Error::Identity)?.join(HISTORY);
    let archived = root.parent() == Some(history.as_path());
    if (root.parent() != target.parent() && !archived) || !transaction_name(root) {
        return Err(Error::Identity);
    }
    if archived {
        private_directory(&history)?;
        if read_journal(root)?.phase != Phase::StartupAcknowledged {
            return Err(Error::RecoveryRequired);
        }
    }
    let metadata = fs::symlink_metadata(root).map_err(|_| Error::Filesystem)?;
    // SAFETY: identity query, no pointer arguments.
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || metadata.mode() & 0o077 != 0
        || metadata.uid() != unsafe { libc::geteuid() }
    {
        return Err(Error::Filesystem);
    }
    Ok(())
}

pub(crate) fn acl_policy(path: &Path, policy: i32) -> Result<(), Error> {
    #[cfg(all(target_os = "macos", feature = "native-macos"))]
    {
        use std::{ffi::CString, os::unix::ffi::OsStrExt};
        let path = CString::new(path.as_os_str().as_bytes()).map_err(|_| Error::Filesystem)?;
        // SAFETY: live NUL-terminated path; policy1 is used only immediately after mkdir.
        if unsafe { pnu_acl_policy(path.as_ptr(), policy) } {
            Ok(())
        } else {
            Err(Error::Filesystem)
        }
    }
    #[cfg(all(target_os = "linux", feature = "native-linux"))]
    {
        crate::linux::acl_policy(path, policy)
    }
    #[cfg(not(any(
        all(target_os = "macos", feature = "native-macos"),
        all(target_os = "linux", feature = "native-linux")
    )))]
    {
        let _ = (path, policy);
        Ok(())
    } // portable fixture checks, no native installer enabled
}

/// Only a freshly created, still-unpublished failed preparation may be discarded.
/// Durable ready/pending/committed transactions are always retained for explicit recovery.
#[cfg(any(
    test,
    any(
        all(target_os = "macos", feature = "native-macos"),
        all(target_os = "linux", feature = "native-linux")
    )
))]
pub(crate) fn discard_incomplete(root: &Path, target: &Path) -> Result<(), Error> {
    validate_root(root, target)?;
    if root
        .join("journal.json")
        .try_exists()
        .map_err(|_| Error::Filesystem)?
        || root
            .join("journal.pending")
            .try_exists()
            .map_err(|_| Error::Filesystem)?
    {
        return Err(Error::RecoveryRequired);
    }
    fs::remove_dir_all(root).map_err(|_| Error::Filesystem)?;
    sync_directory(root.parent().ok_or(Error::Filesystem)?)
}

#[cfg(all(target_os = "macos", feature = "native-macos"))]
pub struct MacPlatform;
#[cfg(all(target_os = "macos", feature = "native-macos"))]
unsafe extern "C" {
    fn pnu_acl_policy(path: *const libc::c_char, policy: libc::c_int) -> bool;
    fn pnu_verify_bundle(
        path: *const libc::c_char,
        identifier: *const libc::c_char,
        build: *const libc::c_char,
        short: *const libc::c_char,
        requirement: *const libc::c_char,
    ) -> bool;
    fn pnu_swap(
        parent: libc::c_int,
        staged: *const libc::c_char,
        installed: *const libc::c_char,
    ) -> libc::c_int;
}
#[cfg(all(target_os = "macos", feature = "native-macos"))]
impl Platform for MacPlatform {
    fn verify(
        &self,
        bundle: &Path,
        trust: &Trust,
        build: &str,
        short: Option<&str>,
    ) -> Result<(), Error> {
        use std::{ffi::CString, os::unix::ffi::OsStrExt};
        let path = CString::new(bundle.as_os_str().as_bytes()).map_err(|_| Error::Filesystem)?;
        let id = CString::new(trust.application_id.as_str()).map_err(|_| Error::Identity)?;
        let build = CString::new(build).map_err(|_| Error::Version)?;
        let short = short
            .map(CString::new)
            .transpose()
            .map_err(|_| Error::Version)?;
        let requirement =
            CString::new(trust.code_requirement.as_str()).map_err(|_| Error::Identity)?;
        // SAFETY: valid strings for the duration of the synchronous worker-only API.
        if unsafe {
            pnu_verify_bundle(
                path.as_ptr(),
                id.as_ptr(),
                build.as_ptr(),
                short.as_ref().map_or(std::ptr::null(), |s| s.as_ptr()),
                requirement.as_ptr(),
            )
        } {
            Ok(())
        } else {
            Err(Error::Signature)
        }
    }
    fn swap(&self, parent: &File, staged: &Path, target: &Path) -> Result<(), Error> {
        use std::{ffi::CString, os::unix::ffi::OsStrExt};
        let staged = CString::new(staged.as_os_str().as_bytes()).map_err(|_| Error::Filesystem)?;
        let target = CString::new(target.as_os_str().as_bytes()).map_err(|_| Error::Filesystem)?;
        // SAFETY: valid directory descriptor, relative paths from validated private staging.
        if unsafe { pnu_swap(parent.as_raw_fd(), staged.as_ptr(), target.as_ptr()) } == 0 {
            Ok(())
        } else {
            Err(Error::InstallFailed)
        }
    }
    fn relaunch(&self, app: &Path, transaction: &Path) -> Result<(), Error> {
        crate::helper::run_command(
            std::process::Command::new("/usr/bin/open")
                .arg("-n")
                .arg(app)
                .arg("--args")
                .arg("--updater-receipt")
                .arg(transaction),
            std::time::Duration::from_secs(15),
        )
    }
}
#[cfg(all(target_os = "macos", feature = "native-macos"))]
pub use MacPlatform as NativePlatform;

#[cfg(all(target_os = "linux", feature = "native-linux"))]
pub use crate::linux::LinuxPlatform as NativePlatform;
#[cfg(test)]
mod identity_tests {
    use super::*;

    #[test]
    fn system_applications_exception_is_exact() {
        assert_eq!(
            is_system_applications(Path::new("/Applications"), 0, 80, 0o40775),
            cfg!(target_os = "macos")
        );
        for (path, uid, gid, mode) in [
            ("/other/Applications", 0, 80, 0o40775),
            ("/Applications/other", 0, 80, 0o40775),
            ("/Applications", 501, 80, 0o40775),
            ("/Applications", 0, 20, 0o40775),
            ("/Applications", 0, 80, 0o40777),
            ("/Applications", 0, 80, 0o41775),
        ] {
            assert!(!is_system_applications(Path::new(path), uid, gid, mode));
        }
    }

    #[cfg(all(target_os = "macos", feature = "native-macos"))]
    #[test]
    fn native_system_applications_parent_preflight() {
        // Read-only: no fixture app or administrator-owned path is created.
        validate_parents(Path::new("/Applications")).unwrap();
    }

    #[test]
    fn relative_directory_identity_matches_metadata() {
        let directory = std::env::temp_dir().canonicalize().unwrap();
        let metadata = fs::symlink_metadata(&directory).unwrap();
        let parent = File::open(&directory).unwrap();
        assert_eq!(
            entry_identity(&parent, Path::new(".")).unwrap(),
            (metadata.dev(), metadata.ino())
        );
    }
}
