//! Whole sealed runtime capsules. Publication never renames or deletes a published
//! root. No GC: exhaustion refuses publication, including orphan/unknown roots.
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
        fd::AsRawFd,
        unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    },
    path::{Path, PathBuf},
    process::Command,
    time::{Duration, Instant},
};

pub const STORE_NAME: &str = "Pilot Next Runtimes";
const MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;
unsafe extern "C" {
    fn pnu_publish_capsule(
        stage: *const libc::c_char,
        destination: *const libc::c_char,
    ) -> libc::c_int;
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
    installer::validate_target(source, trust)?;
    platform.verify(source, trust, &trust.current_build, None)?;
    if !store.is_absolute()
        || store.starts_with(source)
        || store.file_name().is_none_or(|n| n != STORE_NAME)
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
    let id = identity_checked(source, deadline, cancel)?;
    let destination = store.join(&id).join(&trust.bundle_name);
    if destination.try_exists().map_err(|_| Error::Filesystem)? {
        installer::validate_target(&destination, trust)?;
        platform.verify(&destination, trust, &trust.current_build, None)?;
        if identity_checked(&destination, deadline, cancel)? != id {
            return Err(Error::Identity);
        }
        return Ok(destination);
    }
    // At most four full 2GiB closures, including failed publication evidence.
    // Never delete/reuse an unknown root or orphan as a shortcut to admission.
    let mut count = 0;
    let mut retained = 0_u64;
    for entry in fs::read_dir(store).map_err(|_| Error::Filesystem)? {
        check(deadline)?;
        cancel()?;
        let entry = entry.map_err(|_| Error::Filesystem)?;
        if entry.file_name() != ".store.lock" {
            let name = entry.file_name();
            let name = name.to_str().ok_or(Error::RecoveryRequired)?;
            let valid = if let Some(id) = name.strip_prefix(".stage-") {
                id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit())
            } else {
                name.len() == 64 && name.bytes().all(|b| b.is_ascii_hexdigit())
            };
            if !valid {
                return Err(Error::RecoveryRequired);
            }
            retained = retained
                .checked_add(retained_size(&entry.path(), deadline, cancel)?)
                .ok_or(Error::Exhausted)?;
            if retained > MAX_BYTES * 3 {
                return Err(Error::Exhausted);
            }
            count += 1;
        }
        if count >= 4 {
            return Err(Error::Exhausted);
        }
    }
    let stage = store.join(format!(".stage-{}", crate::transport::hex(&ring_random()?)));
    fs::DirBuilder::new()
        .mode(0o700)
        .create(&stage)
        .map_err(|_| Error::Filesystem)?;
    installer::acl_policy(&stage, 1)?;
    let app = stage.join(&trust.bundle_name);
    run_command_checked(
        Command::new("/usr/bin/ditto")
            .args(["--noqtn", "--noacl"])
            .arg(source)
            .arg(&app),
        deadline.saturating_duration_since(Instant::now()),
        || {
            check(deadline)?;
            cancel()
        },
    )?;
    installer::validate_target(&app, trust)?;
    platform.verify(&app, trust, &trust.current_build, None)?;
    if identity_checked(&app, deadline, cancel)? != id
        || identity_checked(source, deadline, cancel)? != id
    {
        return Err(Error::Identity);
    }
    sync_tree(&app, deadline, cancel)?;
    File::open(&stage)
        .and_then(|f| f.sync_all())
        .map_err(|_| Error::Filesystem)?;
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    let from = CString::new(stage.as_os_str().as_bytes()).map_err(|_| Error::Identity)?;
    let to = CString::new(store.join(&id).as_os_str().as_bytes()).map_err(|_| Error::Identity)?;
    // SAFETY: bounded owned C strings, exclusive namespace publication. An
    // existing/unknown root is never replaced, even if not using our lock.
    if unsafe { pnu_publish_capsule(from.as_ptr(), to.as_ptr()) } != 0 {
        return Err(Error::RecoveryRequired);
    }
    File::open(store)
        .and_then(|f| f.sync_all())
        .map_err(|_| Error::RecoveryRequired)?;
    Ok(destination)
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
fn sync_tree(
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
