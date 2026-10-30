//! Whole sealed runtime capsules. Publication never renames or deletes a published
//! root. Only lease-qualified unpublished stages can move to evidence history.
use crate::{
    Error,
    helper::run_command_checked,
    installer::{self, Platform},
    manifest::Trust,
};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::Read,
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd},
        unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    },
    path::{Path, PathBuf},
    process::Command,
    time::{Duration, Instant},
};

pub const STORE_NAME: &str = "Pilot Next Runtimes";
/// Private immutable execution roots, bounded to active plus candidate.
pub const SERVICE_STORE_NAME: &str = "Pilot Next Service Runtime";
#[path = "runtime_cleanup.rs"]
mod cleanup;
pub use cleanup::{CleanupSummary, cleanup_obsolete};
#[path = "runtime_service.rs"]
mod service;
pub use service::publish_service;
const STAGE_PREFIX: &str = ".stage-v1-";
const HISTORY: &str = ".abandoned-stages";
const MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;
unsafe extern "C" {
    fn pnu_publish_capsule(
        stage: *const libc::c_char,
        destination: *const libc::c_char,
    ) -> libc::c_int;
    fn pnu_stage_unused(
        stage: *const libc::c_char,
        ignored_fd: libc::c_int,
        timeout_ms: u32,
    ) -> bool;
    fn pnu_bundle_build(
        path: *const libc::c_char,
        output: *mut libc::c_char,
        capacity: usize,
    ) -> bool;
}

fn check(deadline: Instant) -> Result<(), Error> {
    if Instant::now() >= deadline {
        Err(Error::Cancelled)
    } else {
        Ok(())
    }
}

/// Hash the exact closed tree, including relative links, modes and executable
/// signatures. Bounded and worker-only; a source SHA alone is not a capsule ID.
pub fn identity(root: &Path) -> Result<String, Error> {
    let deadline = Instant::now() + Duration::from_secs(45);
    identity_checked(root, deadline, &|| Ok(()))
}
fn identity_checked(
    root: &Path,
    deadline: Instant,
    cancel: &impl Fn() -> Result<(), Error>,
) -> Result<String, Error> {
    let mut pending = vec![root.to_path_buf()];
    let mut paths = Vec::new();
    while let Some(path) = pending.pop() {
        check(deadline)?;
        cancel()?;
        if paths.len() + pending.len() >= 30_000 {
            return Err(Error::Archive);
        }
        let meta = fs::symlink_metadata(&path).map_err(|_| Error::Filesystem)?;
        let relative = path
            .strip_prefix(root)
            .map_err(|_| Error::Identity)?
            .to_path_buf();
        if relative.components().count() > 128 {
            return Err(Error::Archive);
        }
        if meta.is_dir() {
            for entry in fs::read_dir(&path).map_err(|_| Error::Filesystem)? {
                pending.push(entry.map_err(|_| Error::Filesystem)?.path());
                if pending.len() + paths.len() >= 30_000 {
                    return Err(Error::Archive);
                }
            }
        }
        paths.push(relative);
    }
    paths.sort();
    let mut hash = Sha256::new();
    let mut bytes = 0_u64;
    for relative in paths {
        check(deadline)?;
        cancel()?;
        let path = root.join(&relative);
        let meta = fs::symlink_metadata(&path).map_err(|_| Error::Filesystem)?;
        let name = relative.to_str().ok_or(Error::Identity)?;
        hash.update((name.len() as u64).to_le_bytes());
        hash.update(name.as_bytes());
        if meta.file_type().is_symlink() {
            let link = fs::read_link(&path).map_err(|_| Error::Filesystem)?;
            if link.is_absolute()
                || !path
                    .canonicalize()
                    .map_err(|_| Error::Filesystem)?
                    .starts_with(root)
            {
                return Err(Error::Identity);
            }
            let link = link.to_str().ok_or(Error::Identity)?;
            hash.update(b"link");
            hash.update((link.len() as u64).to_le_bytes());
            hash.update(link.as_bytes());
        } else {
            if meta.mode() & 0o6022 != 0 {
                return Err(Error::Filesystem);
            }
            installer::acl_policy(&path, 0)?;
            hash.update((meta.mode() & 0o777).to_le_bytes());
            if meta.is_dir() {
                hash.update(b"directory");
                continue;
            }
            if !meta.is_file() || meta.nlink() != 1 || meta.len() > 256 * 1024 * 1024 {
                return Err(Error::Archive);
            }
            bytes = bytes.checked_add(meta.len()).ok_or(Error::Archive)?;
            if bytes > MAX_BYTES {
                return Err(Error::Archive);
            }
            hash.update(b"file");
            hash.update(meta.len().to_le_bytes());
            let mut file = OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
                .open(&path)
                .map_err(|_| Error::Filesystem)?;
            let opened = file.metadata().map_err(|_| Error::Filesystem)?;
            if (opened.dev(), opened.ino(), opened.len()) != (meta.dev(), meta.ino(), meta.len()) {
                return Err(Error::Identity);
            }
            let mut buffer = [0_u8; 64 * 1024];
            let mut read = 0_u64;
            loop {
                check(deadline)?;
                cancel()?;
                let n = file.read(&mut buffer).map_err(|_| Error::Filesystem)?;
                if n == 0 {
                    break;
                }
                read += n as u64;
                if read > meta.len() {
                    return Err(Error::Identity);
                }
                hash.update(&buffer[..n]);
            }
            if read != meta.len() {
                return Err(Error::Identity);
            }
        }
    }
    Ok(crate::transport::hex(&hash.finalize()))
}

pub fn validate_store(store: &Path) -> Result<(), Error> {
    installer::validate_parents(store)?;
    let meta = fs::symlink_metadata(store).map_err(|_| Error::Filesystem)?;
    // SAFETY: current user identity query only.
    if meta.uid() != unsafe { libc::geteuid() } || meta.mode() & 0o077 != 0 {
        return Err(Error::Filesystem);
    }
    installer::acl_policy(store, 2)
}

/// The caller uses a dedicated absolute Next support path. Never infer a Swift
/// path, daemon data-home migration or an existing process's runtime relocation.
pub fn publish(
    source: &Path,
    store: &Path,
    trust: &Trust,
    platform: &impl Platform,
) -> Result<PathBuf, Error> {
    publish_checked(
        source,
        store,
        trust,
        platform,
        Instant::now() + Duration::from_secs(45),
        &|| Ok(()),
    )
}
pub fn publish_cancellable(
    source: &Path,
    store: &Path,
    trust: &Trust,
    platform: &impl Platform,
    deadline: Instant,
    cancel: &std::sync::atomic::AtomicBool,
) -> Result<PathBuf, Error> {
    let check = || {
        if cancel.load(std::sync::atomic::Ordering::Acquire) {
            Err(Error::Cancelled)
        } else {
            Ok(())
        }
    };
    publish_checked(
        source,
        store,
        trust,
        platform,
        deadline.min(Instant::now() + Duration::from_secs(45)),
        &check,
    )
}
fn publish_checked(
    source: &Path,
    store: &Path,
    trust: &Trust,
    platform: &impl Platform,
    deadline: Instant,
    cancel: &impl Fn() -> Result<(), Error>,
) -> Result<PathBuf, Error> {
    check(deadline)?;
    cancel()?;
    if store.file_name().is_none_or(|name| name != STORE_NAME) {
        return Err(Error::Identity);
    }
    installer::validate_target(source, trust)?;
    platform.verify(source, trust, &trust.current_build, None)?;
    let _lock = prepare_store(source, store)?;
    let id = identity_checked(source, deadline, cancel)?;
    let destination = store.join(&id).join(&trust.bundle_name);
    if destination.try_exists().map_err(|_| Error::Filesystem)? {
        verify_published(&destination, trust, platform, deadline, cancel)?;
        return Ok(destination);
    }
    legacy_admission(store, trust, platform, deadline, cancel)?;
    let stage = store.join(format!(
        "{STAGE_PREFIX}{}",
        crate::transport::hex(&ring_random()?)
    ));
    copy_publish(
        source,
        &destination,
        &stage,
        trust,
        platform,
        deadline,
        cancel,
    )
}

fn prepare_store(source: &Path, store: &Path) -> Result<File, Error> {
    if !store.is_absolute()
        || store.starts_with(source)
        || store
            .file_name()
            .is_none_or(|n| n != STORE_NAME && n != SERVICE_STORE_NAME)
    {
        return Err(Error::Identity);
    }
    installer::validate_parents(store.parent().ok_or(Error::Filesystem)?)?;
    match fs::DirBuilder::new().mode(0o700).create(store) {
        Ok(()) => installer::acl_policy(store, 1)?,
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(_) => return Err(Error::Filesystem),
    }
    validate_store(store)?;
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(store.join(".store.lock"))
        .map_err(|_| Error::Filesystem)?;
    let meta = lock.metadata().map_err(|_| Error::Filesystem)?;
    // SAFETY: nonblocking lock on our owned permanent descriptor.
    if !meta.is_file()
        || meta.nlink() != 1
        || meta.mode() & 0o077 != 0
        || meta.uid() != unsafe { libc::geteuid() }
        || unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0
    {
        return Err(Error::Busy);
    }
    Ok(lock)
}

fn verify_published(
    destination: &Path,
    trust: &Trust,
    platform: &impl Platform,
    deadline: Instant,
    cancel: &impl Fn() -> Result<(), Error>,
) -> Result<(), Error> {
    installer::validate_target(destination, trust)?;
    platform.verify(destination, trust, &trust.current_build, None)?;
    if identity_checked(destination, deadline, cancel)?
        != destination
            .parent()
            .and_then(Path::file_name)
            .and_then(|id| id.to_str())
            .ok_or(Error::Identity)?
    {
        return Err(Error::Identity);
    }
    Ok(())
}

fn legacy_admission(
    store: &Path,
    trust: &Trust,
    platform: &impl Platform,
    deadline: Instant,
    cancel: &impl Fn() -> Result<(), Error>,
) -> Result<(), Error> {
    // Published and legacy/unknown roots retain their original count/byte bounds.
    // Versioned stages were never execution roots: validate_capsule requires a
    // 64-hex parent. Their inherited lease also excludes surviving copy children.
    let mut count = 0;
    let mut retained = 0_u64;
    // Snapshot names before moving any entry. Mutating a directory during
    // readdir may skip retained roots and incorrectly admit beyond the cap.
    let mut entries = Vec::new();
    for entry in fs::read_dir(store).map_err(|_| Error::Filesystem)? {
        check(deadline)?;
        cancel()?;
        if entries.len() >= 4096 {
            return Err(Error::StagingCapacity);
        }
        entries.push(entry.map_err(|_| Error::Filesystem)?);
    }
    for entry in entries {
        check(deadline)?;
        cancel()?;
        if entry.file_name() == HISTORY {
            validate_history(&entry.path())?;
            continue;
        }
        if entry.file_name() != ".store.lock" {
            let name = entry.file_name();
            let name = name.to_str().ok_or(Error::RecoveryRequired)?;
            if let Some(id) = name.strip_prefix(STAGE_PREFIX) {
                if !hex_id(id, 32) {
                    return Err(Error::RecoveryRequired);
                }
                archive_stage(&entry.path(), deadline, cancel)?;
                continue;
            }
            let valid = if let Some(id) = name.strip_prefix(".stage-") {
                // Legacy publishers did not lease their copy children. Never
                // infer absence of live users from names, age or the store lock.
                if hex_id(id, 32)
                    && archive_legacy_duplicate(
                        &entry.path(),
                        store,
                        trust,
                        platform,
                        deadline,
                        cancel,
                        &|stage, lease| native_stage_unused(stage, lease, deadline),
                    )?
                {
                    continue;
                }
                hex_id(id, 32)
            } else {
                hex_id(name, 64)
            };
            if !valid {
                return Err(Error::RecoveryRequired);
            }
            retained = retained
                .checked_add(
                    retained_size(&entry.path(), deadline, cancel).map_err(|error| {
                        if error == Error::Exhausted {
                            Error::StagingCapacity
                        } else {
                            error
                        }
                    })?,
                )
                .ok_or(Error::StagingCapacity)?;
            if retained > MAX_BYTES * 3 {
                return Err(Error::StagingCapacity);
            }
            count += 1;
        }
        if count >= 4 {
            return Err(Error::StagingCapacity);
        }
    }
    Ok(())
}

fn copy_publish(
    source: &Path,
    destination: &Path,
    stage: &Path,
    trust: &Trust,
    platform: &impl Platform,
    deadline: Instant,
    cancel: &impl Fn() -> Result<(), Error>,
) -> Result<PathBuf, Error> {
    let root = destination.parent().ok_or(Error::Identity)?;
    let store = root.parent().ok_or(Error::Identity)?;
    let id = root
        .file_name()
        .and_then(|id| id.to_str())
        .ok_or(Error::Identity)?;
    fs::DirBuilder::new()
        .mode(0o700)
        .create(stage)
        .map_err(|_| Error::Filesystem)?;
    installer::acl_policy(stage, 1)?;
    // Admission already succeeded. Failure to lease our new private directory
    // is a filesystem failure, not a claim that retained capacity is exhausted.
    let stage_lease = stage_lease(stage).map_err(|_| Error::Filesystem)?;
    let app = stage.join(&trust.bundle_name);
    let mut copy = Command::new("/usr/bin/ditto");
    copy.args(["--noqtn", "--noacl"]).arg(source).arg(&app);
    inherit_stage_lease(&mut copy, &stage_lease)?;
    run_command_checked(
        &mut copy,
        deadline.saturating_duration_since(Instant::now()),
        || {
            check(deadline)?;
            cancel()
        },
    )?;
    drop(copy);
    installer::validate_target(&app, trust)?;
    platform.verify(&app, trust, &trust.current_build, None)?;
    if identity_checked(&app, deadline, cancel)? != id
        || identity_checked(source, deadline, cancel)? != id
    {
        return Err(Error::Identity);
    }
    sync_tree(&app, deadline, cancel)?;
    File::open(stage)
        .and_then(|f| f.sync_all())
        .map_err(|_| Error::Filesystem)?;
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    let from = CString::new(stage.as_os_str().as_bytes()).map_err(|_| Error::Identity)?;
    let to = CString::new(root.as_os_str().as_bytes()).map_err(|_| Error::Identity)?;
    // SAFETY: bounded owned C strings, exclusive namespace publication. An
    // existing/unknown root is never replaced, even if not using our lock.
    if unsafe { pnu_publish_capsule(from.as_ptr(), to.as_ptr()) } != 0 {
        return Err(Error::RecoveryRequired);
    }
    File::open(store)
        .and_then(|f| f.sync_all())
        .map_err(|_| Error::RecoveryRequired)?;
    Ok(destination.to_owned())
}

fn hex_id(value: &str, length: usize) -> bool {
    value.len() == length && value.bytes().all(|b| b.is_ascii_hexdigit())
}

fn stage_lease(stage: &Path) -> Result<File, Error> {
    let lease = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK)
        .open(stage)
        .map_err(|_| Error::StagingCapacity)?;
    let meta = lease.metadata().map_err(|_| Error::StagingCapacity)?;
    let named = fs::symlink_metadata(stage).map_err(|_| Error::StagingCapacity)?;
    // SAFETY: identity query and nonblocking lock on an owned directory fd.
    if !meta.is_dir()
        || meta.uid() != unsafe { libc::geteuid() }
        || meta.mode() & 0o077 != 0
        || (meta.dev(), meta.ino()) != (named.dev(), named.ino())
        || unsafe { libc::flock(lease.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0
    {
        return Err(Error::StagingCapacity);
    }
    installer::acl_policy(stage, 2).map_err(|_| Error::StagingCapacity)?;
    Ok(lease)
}

fn inherit_stage_lease(command: &mut Command, lease: &File) -> Result<(), Error> {
    use std::os::unix::process::CommandExt;
    // SAFETY: duplicate our owned fd above stdio, preserving its shared flock.
    let fd = unsafe { libc::fcntl(lease.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 10) };
    if fd < 0 {
        return Err(Error::Native);
    }
    // SAFETY: fcntl returned a new owned descriptor.
    let fd = unsafe { OwnedFd::from_raw_fd(fd) };
    // SAFETY: only async-signal-safe fcntl after fork. No dup2/stdio collisions.
    unsafe {
        command.pre_exec(move || {
            if libc::fcntl(fd.as_raw_fd(), libc::F_SETFD, 0) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    Ok(())
}

fn validate_history(history: &Path) -> Result<(), Error> {
    let meta = fs::symlink_metadata(history).map_err(|_| Error::StagingArchiveFailed)?;
    // SAFETY: pure current-user identity query.
    if !meta.is_dir() || meta.uid() != unsafe { libc::geteuid() } || meta.mode() & 0o077 != 0 {
        return Err(Error::StagingArchiveFailed);
    }
    installer::acl_policy(history, 2).map_err(|_| Error::StagingArchiveFailed)
}

// Caller holds the permanent store lock. Never called for published roots.
fn archive_stage(
    stage: &Path,
    deadline: Instant,
    cancel: &impl Fn() -> Result<(), Error>,
) -> Result<(), Error> {
    check(deadline)?;
    cancel()?;
    let lease = stage_lease(stage)?;
    archive_stage_leased(stage, &lease, deadline, cancel, &|| Ok(()))
}

fn archive_stage_leased(
    stage: &Path,
    lease: &File,
    deadline: Instant,
    cancel: &impl Fn() -> Result<(), Error>,
    before_move: &impl Fn() -> Result<(), Error>,
) -> Result<(), Error> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    let original = lease.metadata().map_err(|_| Error::StagingArchiveFailed)?;
    let store = stage.parent().ok_or(Error::StagingArchiveFailed)?;
    let history = store.join(HISTORY);
    match fs::DirBuilder::new().mode(0o700).create(&history) {
        Ok(()) => installer::acl_policy(&history, 1).map_err(|_| Error::StagingArchiveFailed)?,
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(_) => return Err(Error::StagingArchiveFailed),
    }
    validate_history(&history)?;
    let destination = history.join(stage.file_name().ok_or(Error::StagingArchiveFailed)?);
    let named = fs::symlink_metadata(stage).map_err(|_| Error::StagingArchiveFailed)?;
    if (original.dev(), original.ino()) != (named.dev(), named.ino()) {
        return Err(Error::StagingArchiveFailed);
    }
    let from =
        CString::new(stage.as_os_str().as_bytes()).map_err(|_| Error::StagingArchiveFailed)?;
    let to = CString::new(destination.as_os_str().as_bytes())
        .map_err(|_| Error::StagingArchiveFailed)?;
    check(deadline)?;
    cancel()?;
    before_move()?;
    let named = fs::symlink_metadata(stage).map_err(|_| Error::StagingArchiveFailed)?;
    if (original.dev(), original.ino()) != (named.dev(), named.ino()) {
        return Err(Error::StagingArchiveFailed);
    }
    // SAFETY: validated private stage under its exclusive lease and store lock;
    // exclusive rename preserves both roots on collision, never replaces evidence.
    if unsafe { pnu_publish_capsule(from.as_ptr(), to.as_ptr()) } != 0 {
        return Err(Error::StagingArchiveFailed);
    }
    for directory in [&history, store] {
        File::open(directory)
            .and_then(|f| f.sync_all())
            .map_err(|_| Error::StagingArchiveFailed)?;
    }
    Ok(())
}

fn native_stage_unused(stage: &Path, lease: &File, deadline: Instant) -> bool {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    let Ok(path) = CString::new(stage.as_os_str().as_bytes()) else {
        return false;
    };
    let milliseconds = deadline
        .saturating_duration_since(Instant::now())
        .as_millis()
        .min(2000) as u32;
    // SAFETY: owned NUL-terminated path, controlled directory fd, bounded read-only census.
    unsafe { pnu_stage_unused(path.as_ptr(), lease.as_raw_fd(), milliseconds) }
}

fn sealed_build(app: &Path) -> Result<String, Error> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    let plist =
        fs::symlink_metadata(app.join("Contents/Info.plist")).map_err(|_| Error::Identity)?;
    if !plist.is_file() || plist.len() > 65_536 {
        return Err(Error::Identity);
    }
    let path = CString::new(app.as_os_str().as_bytes()).map_err(|_| Error::Identity)?;
    let mut buffer = [0_u8; 64];
    // SAFETY: valid owned path and bounded output, always on the updater worker.
    if !unsafe { pnu_bundle_build(path.as_ptr(), buffer.as_mut_ptr().cast(), buffer.len()) } {
        return Err(Error::Identity);
    }
    let end = buffer.iter().position(|b| *b == 0).ok_or(Error::Identity)?;
    let build = std::str::from_utf8(&buffer[..end])
        .map_err(|_| Error::Identity)?
        .to_owned();
    crate::manifest::Build::parse(&build)?;
    Ok(build)
}

// Legacy recovery is deliberately narrower than ordinary staged evidence:
// one exact sealed duplicate, already published, plus positive native no-use
// proof. Missing/inaccessible/changing evidence stays in place and counts.
fn archive_legacy_duplicate(
    stage: &Path,
    store: &Path,
    trust: &Trust,
    platform: &impl Platform,
    deadline: Instant,
    cancel: &impl Fn() -> Result<(), Error>,
    unused: &impl Fn(&Path, &File) -> bool,
) -> Result<bool, Error> {
    let verify = || -> Result<(File, PathBuf, String), Error> {
        let lease = stage_lease(stage)?;
        let entries = fs::read_dir(stage)
            .map_err(|_| Error::Filesystem)?
            .take(2)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| Error::Filesystem)?;
        if entries.len() != 1 || entries[0].file_name() != trust.bundle_name.as_str() {
            return Err(Error::Identity);
        }
        let app = stage.join(&trust.bundle_name);
        installer::validate_target(&app, trust)?;
        let build = sealed_build(&app)?;
        platform.verify(&app, trust, &build, None)?;
        let id = identity_checked(&app, deadline, cancel)?;
        let published = store.join(&id).join(&trust.bundle_name);
        installer::validate_target(&published, trust)?;
        platform.verify(&published, trust, &build, None)?;
        if identity_checked(&published, deadline, cancel)? != id {
            return Err(Error::Identity);
        }
        Ok((lease, published, id))
    };
    let (lease, published, id) = match verify() {
        Ok(value) => value,
        Err(Error::Cancelled) => return Err(Error::Cancelled),
        Err(_) => return Ok(false),
    };
    if !unused(stage, &lease) {
        return Ok(false);
    }
    archive_stage_leased(stage, &lease, deadline, cancel, &|| {
        if identity_checked(&stage.join(&trust.bundle_name), deadline, cancel)? != id
            || identity_checked(&published, deadline, cancel)? != id
            || !unused(stage, &lease)
        {
            return Err(Error::StagingCapacity);
        }
        Ok(())
    })?;
    Ok(true)
}
fn retained_size(
    root: &Path,
    deadline: Instant,
    cancel: &impl Fn() -> Result<(), Error>,
) -> Result<u64, Error> {
    let mut pending = vec![(root.to_path_buf(), 0)];
    let mut count = 0;
    let mut bytes = 0_u64;
    while let Some((path, depth)) = pending.pop() {
        check(deadline)?;
        cancel()?;
        count += 1;
        if count > 30_001 || depth > 129 {
            return Err(Error::RecoveryRequired);
        }
        let meta = fs::symlink_metadata(&path).map_err(|_| Error::RecoveryRequired)?;
        if meta.is_dir() {
            for entry in fs::read_dir(path).map_err(|_| Error::RecoveryRequired)? {
                pending.push((
                    entry.map_err(|_| Error::RecoveryRequired)?.path(),
                    depth + 1,
                ));
                if pending.len() + count > 30_001 {
                    return Err(Error::RecoveryRequired);
                }
            }
        } else if meta.file_type().is_symlink() {
            if !path
                .canonicalize()
                .map_err(|_| Error::RecoveryRequired)?
                .starts_with(root)
            {
                return Err(Error::RecoveryRequired);
            }
        } else if meta.is_file() && meta.nlink() == 1 {
            bytes = bytes.checked_add(meta.len()).ok_or(Error::Exhausted)?;
            if bytes > MAX_BYTES {
                return Err(Error::Exhausted);
            }
        } else {
            return Err(Error::RecoveryRequired);
        }
    }
    Ok(bytes)
}
fn ring_random() -> Result<[u8; 16], Error> {
    use ring::rand::SecureRandom;
    let mut bytes = [0; 16];
    ring::rand::SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| Error::Native)?;
    Ok(bytes)
}
pub(crate) fn sync_tree(
    root: &Path,
    deadline: Instant,
    cancel: &impl Fn() -> Result<(), Error>,
) -> Result<(), Error> {
    let mut directories = vec![root.to_path_buf()];
    let mut cursor = 0;
    while cursor < directories.len() {
        check(deadline)?;
        cancel()?;
        for entry in fs::read_dir(&directories[cursor]).map_err(|_| Error::Filesystem)? {
            check(deadline)?;
            cancel()?;
            let path = entry.map_err(|_| Error::Filesystem)?.path();
            let meta = fs::symlink_metadata(&path).map_err(|_| Error::Filesystem)?;
            if meta.is_dir() {
                directories.push(path);
            } else if meta.is_file() {
                File::open(path)
                    .and_then(|f| f.sync_all())
                    .map_err(|_| Error::Filesystem)?;
            }
            if directories.len() > 30_000 {
                return Err(Error::Archive);
            }
        }
        cursor += 1;
    }
    for directory in directories.iter().rev() {
        check(deadline)?;
        cancel()?;
        File::open(directory)
            .and_then(|f| f.sync_all())
            .map_err(|_| Error::Filesystem)?;
    }
    Ok(())
}

#[cfg(test)]
#[path = "runtime_staging_tests.rs"]
mod staging_tests;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn closure_cancellation_precedes_io() {
        let dir = crate::owned_tests::Temp::new();
        assert_eq!(
            identity_checked(
                dir.path(),
                Instant::now() + Duration::from_secs(45),
                &|| Err(Error::Cancelled)
            ),
            Err(Error::Cancelled)
        );
    }
    #[test]
    fn retained_size_refuses_oversized_unknown_evidence_without_reading_it() {
        let dir = crate::owned_tests::Temp::new();
        File::create(dir.path().join("sparse-evidence"))
            .unwrap()
            .set_len(MAX_BYTES + 1)
            .unwrap();
        assert_eq!(
            retained_size(
                dir.path(),
                Instant::now() + Duration::from_secs(45),
                &|| Ok(())
            ),
            Err(Error::Exhausted)
        );
    }
    #[test]
    fn closure_identity_survives_relocation_but_not_escape_links() {
        let dir = crate::owned_tests::Temp::new();
        let root = dir.path().join("first");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("resource"), b"sealed resource").unwrap();
        std::os::unix::fs::symlink("resource", root.join("link")).unwrap();
        let id = identity(&root).unwrap();
        let moved = dir.path().join("moved");
        fs::rename(&root, &moved).unwrap();
        assert_eq!(identity(&moved).unwrap(), id);
        fs::write(dir.path().join("outside"), b"not retained").unwrap();
        fs::remove_file(moved.join("link")).unwrap();
        std::os::unix::fs::symlink("../outside", moved.join("link")).unwrap();
        assert_eq!(identity(&moved), Err(Error::Identity));
    }
}
