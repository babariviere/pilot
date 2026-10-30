//! Terminal GUI transaction disposal after verified daemon handoff, never on GUI ACK alone.
use super::*;
use std::os::unix::ffi::OsStrExt;
use std::time::{Duration, Instant};

// Includes the next stage. Keep retention bounded when macOS cannot inspect
// unrelated protected processes; never move or delete their possible resources.
const MAX_RETAINED_TRANSACTIONS: usize = 4;

pub(super) fn require_capacity(target: &Path, trust: &Trust) -> Result<(), Error> {
    let mut retained = 0;
    for (count, entry) in fs::read_dir(target.parent().ok_or(Error::Filesystem)?)
        .map_err(|_| Error::Filesystem)?
        .enumerate()
    {
        if count >= 4096 {
            return Err(Error::StagingCapacity);
        }
        let entry = entry.map_err(|_| Error::Filesystem)?;
        if entry
            .file_name()
            .as_bytes()
            .starts_with(b".pilot-next-update-")
        {
            retained += 1;
            if retained >= MAX_RETAINED_TRANSACTIONS {
                return Err(Error::StagingCapacity);
            }
            let root = entry.path();
            if root.canonicalize().ok().as_deref() != Some(root.as_path())
                || validate_root(&root, target).is_err()
            {
                return Err(Error::StagingCapacity);
            }
            let _guard = journal_guard(&root).map_err(|_| Error::StagingCapacity)?;
            if !terminal_proof(&root, trust) {
                return Err(Error::StagingCapacity);
            }
        }
    }
    Ok(())
}

/// Remove proven terminal GUI transactions after the daemon uses the current target.
///
/// The caller must first verify successful daemon handoff (or a verified already-current
/// daemon). GUI startup ACK alone is insufficient: the old daemon may still load files
/// from the exchanged bundle. Run off the UI thread. Never removes runtime capsules or
/// the permanent target lock. Uncertain evidence is retained, never replayed.
pub fn cleanup_completed(target: &Path, trust: &Trust) -> Result<usize, Error> {
    cleanup_checked(target, trust, &NativePlatform, &native_unused)
}

#[cfg(test)]
pub(super) fn cleanup_with(
    target: &Path,
    trust: &Trust,
    platform: &impl Platform,
) -> Result<usize, Error> {
    cleanup_checked(target, trust, platform, &|_, _| true)
}

pub(super) fn cleanup_checked(
    target: &Path,
    trust: &Trust,
    platform: &impl Platform,
    unused: &impl Fn(&Path, Instant) -> bool,
) -> Result<usize, Error> {
    validate_target(target, trust)?;
    platform.verify(target, trust, &trust.current_build, None)?;
    let _lock = lock_target(target)?;
    cleanup_locked(target, trust, unused)
}

// Caller holds the permanent target lock and has verified the installed target.
pub(super) fn cleanup_locked(
    target: &Path,
    trust: &Trust,
    unused: &impl Fn(&Path, Instant) -> bool,
) -> Result<usize, Error> {
    let parent = target.parent().ok_or(Error::Filesystem)?;
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut removed = purge(parent, target, trust, deadline, unused)?;
    let history = parent.join(HISTORY);
    match fs::symlink_metadata(&history) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(Error::Filesystem),
        Ok(_) => {
            private_directory(&history)?;
            removed += purge(&history, target, trust, deadline, unused)?;
            // Unknown entries are preserved. Only an empty, validated history is removed.
            if fs::read_dir(&history)
                .map_err(|_| Error::Filesystem)?
                .next()
                .is_none()
            {
                fs::remove_dir(&history).map_err(|_| Error::Filesystem)?;
                sync_directory(parent)?;
            }
        }
    }
    Ok(removed)
}

fn purge(
    directory: &Path,
    target: &Path,
    trust: &Trust,
    deadline: Instant,
    unused: &impl Fn(&Path, Instant) -> bool,
) -> Result<usize, Error> {
    // Snapshot before unlinking: mutating a live directory iterator can skip siblings.
    let mut candidates = Vec::new();
    for (count, entry) in fs::read_dir(directory)
        .map_err(|_| Error::Filesystem)?
        .enumerate()
    {
        if Instant::now() >= deadline {
            break;
        }
        if count >= 4096 {
            return Err(Error::RecoveryRequired);
        }
        let root = entry.map_err(|_| Error::Filesystem)?.path();
        if transaction_name(&root) {
            candidates.push(root);
        }
    }
    let mut removed = 0;
    for root in candidates {
        if Instant::now() >= deadline {
            break;
        }
        if root.canonicalize().ok().as_deref() != Some(root.as_path())
            || validate_root(&root, target).is_err()
        {
            continue;
        }
        let Ok(_guard) = journal_guard(&root) else {
            continue;
        };
        if !terminal_proof(&root, trust) {
            continue;
        }
        // Other profiles and foreground daemons may still use this exchanged app.
        // The selected service's handoff alone does not establish global absence.
        let rollback = rollback_bundle(&root, trust);
        match fs::symlink_metadata(&rollback) {
            Ok(meta) => {
                if !meta.is_dir()
                    || meta.file_type().is_symlink()
                    || rollback.canonicalize().ok().as_deref() != Some(rollback.as_path())
                    || !unused(&rollback, deadline)
                {
                    continue;
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => continue,
        }
        temporary::discard(&root)?;
        fs::remove_dir_all(&root).map_err(|_| Error::Filesystem)?;
        sync_directory(directory)?;
        removed += 1;
    }
    Ok(removed)
}

pub(super) fn native_unused(root: &Path, deadline: Instant) -> bool {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    unsafe extern "C" {
        fn pnu_stage_unused(
            root: *const libc::c_char,
            ignored_fd: libc::c_int,
            timeout_ms: u32,
        ) -> bool;
    }
    let milliseconds = deadline
        .saturating_duration_since(Instant::now())
        .as_millis()
        .min(2000) as u32;
    if milliseconds == 0 {
        return false;
    }
    let Ok(path) = CString::new(root.as_os_str().as_bytes()) else {
        return false;
    };
    // SAFETY: live NUL-terminated path, no ignored descriptor, bounded native census.
    unsafe { pnu_stage_unused(path.as_ptr(), -1, milliseconds) }
}

fn terminal_proof(root: &Path, trust: &Trust) -> bool {
    let Ok(journal) = read_journal(root) else {
        return false;
    };
    if !matches!(journal.phase, Phase::StartupAcknowledged | Phase::Aborted) {
        return false;
    }
    let Ok(manifest) = signed_manifest(root, trust) else {
        return false;
    };
    let Ok(build) = crate::manifest::Build::parse(&manifest.manifest().build) else {
        return false;
    };
    let Ok(current) = crate::manifest::Build::parse(&trust.current_build) else {
        return false;
    };
    if build > current && journal.phase != Phase::Aborted {
        return false;
    }
    if journal.phase == Phase::StartupAcknowledged {
        let rollback = rollback_bundle(root, trust);
        let old = match fs::symlink_metadata(&rollback) {
            Ok(old) => old,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return true,
            Err(_) => return false,
        };
        if !old.is_dir()
            || old.file_type().is_symlink()
            || rollback.canonicalize().ok().as_deref() != Some(rollback.as_path())
            || (old.dev(), old.ino()) != (journal.original_device, journal.original_inode)
        {
            return false;
        }
    }
    // Disposal grants no execution authority. Obsolete ZIP bytes need not survive
    // an acknowledged update, and rollback contents are not revalidated.
    true
}
