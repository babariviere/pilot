//! Ephemeral macOS payloads. Only receipts, authenticated archives and rollback
//! entries belong to the durable installation transaction.
use super::*;
use std::{
    ffi::CString,
    os::unix::ffi::OsStrExt,
    process::Command,
    time::{Duration, Instant},
};

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Workspace {
    path: PathBuf,
    device: u64,
    inode: u64,
}

const RECORD: &str = "temporary.json";
const PREFIX: &str = "pilot-next-updater-";

pub(super) fn create(root: &Path) -> Result<(), Error> {
    let parent = std::env::temp_dir()
        .canonicalize()
        .map_err(|_| Error::Filesystem)?;
    create_in(root, &parent)
}

fn create_in(root: &Path, parent: &Path) -> Result<(), Error> {
    // A caller's TMPDIR must never put preview apps back in the install tree.
    if parent.starts_with("/Applications")
        || parent.starts_with(root.parent().ok_or(Error::Filesystem)?)
    {
        return Err(Error::Filesystem);
    }
    let template = parent.join(format!("{PREFIX}XXXXXX"));
    let mut bytes = CString::new(template.as_os_str().as_bytes())
        .map_err(|_| Error::Filesystem)?
        .into_bytes_with_nul();
    // SAFETY: writable NUL-terminated template. mkdtemp creates exclusively, mode0700.
    if unsafe { libc::mkdtemp(bytes.as_mut_ptr().cast()) }.is_null() {
        return Err(Error::Filesystem);
    }
    let path = PathBuf::from(std::ffi::OsStr::from_bytes(&bytes[..bytes.len() - 1]));
    let result = (|| {
        acl_policy(&path, 1)?;
        private_directory(&path)?;
        validate_parents(&path)?;
        let metadata = fs::symlink_metadata(&path).map_err(|_| Error::Filesystem)?;
        let record = Workspace {
            path: path.clone(),
            device: metadata.dev(),
            inode: metadata.ino(),
        };
        write_new(
            &root.join(RECORD),
            &serde_json::to_vec(&record).map_err(|_| Error::Filesystem)?,
        )?;
        sync_directory(root)
    })();
    if result.is_err() {
        let _ = fs::remove_dir(&path);
    }
    result
}

pub(super) fn workspace(root: &Path) -> Result<PathBuf, Error> {
    let record: Workspace = serde_json::from_slice(&read_small(&root.join(RECORD), 8192)?)
        .map_err(|_| Error::Filesystem)?;
    let path = record.path;
    if !path.is_absolute()
        || !path
            .file_name()
            .and_then(|s| s.to_str())
            .is_some_and(|name| name.starts_with(PREFIX) && name.len() == PREFIX.len() + 6)
        || path.starts_with("/Applications")
        || path.starts_with(root.parent().ok_or(Error::Filesystem)?)
        || path.canonicalize().map_err(|_| Error::Filesystem)? != path
    {
        return Err(Error::Filesystem);
    }
    private_directory(&path)?;
    validate_parents(&path)?;
    let metadata = fs::symlink_metadata(&path).map_err(|_| Error::Filesystem)?;
    if (metadata.dev(), metadata.ino()) != (record.device, record.inode) {
        return Err(Error::Filesystem);
    }
    Ok(path)
}

pub(super) fn archive(root: &Path) -> Result<PathBuf, Error> {
    Ok(workspace(root)?.join("archive.zip"))
}

pub(super) fn retain_archive(
    root: &Path,
    verified: &VerifiedManifest,
    cancel: &Cancellation,
) -> Result<(), Error> {
    let source = archive(root)?;
    verify_archive(&source, verified, cancel)?;
    let mut input = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&source)
        .map_err(|_| Error::Filesystem)?;
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(root.join("archive.zip"))
        .map_err(|_| Error::Filesystem)?;
    let mut buffer = [0; 65536];
    let mut remaining = verified.manifest().archive_size;
    while remaining > 0 {
        cancel.check()?;
        let count = input
            .read(&mut buffer[..remaining.min(65536) as usize])
            .map_err(|_| Error::Filesystem)?;
        if count == 0 {
            return Err(Error::Archive);
        }
        output
            .write_all(&buffer[..count])
            .map_err(|_| Error::Filesystem)?;
        remaining -= count as u64;
    }
    output.sync_all().map_err(|_| Error::Filesystem)?;
    verify_archive(&root.join("archive.zip"), verified, cancel)
}

/// No rename from temporary storage: its volume need not be the install volume.
/// The only commit candidate has no .app suffix and is private and short-lived.
pub(super) fn commit_copy(
    staged: &Staged,
    source: &Path,
    identity: &str,
    trust: &Trust,
    platform: &impl Platform,
) -> Result<PathBuf, Error> {
    let directory = staged.root.join("install-payload");
    fs::DirBuilder::new()
        .mode(0o700)
        .create(&directory)
        .map_err(|_| Error::RecoveryRequired)?;
    acl_policy(&directory, 1)?;
    let candidate = directory.join("bundle");
    let mut copy = Command::new("/usr/bin/ditto");
    copy.args(["--noqtn", "--noacl"])
        .arg(source)
        .arg(&candidate);
    // Surviving copy children must keep the permanent target lock after a crash.
    // SAFETY: duplicate this live lock descriptor for the owned copier only.
    let inherited = unsafe { libc::fcntl(staged.lock.as_raw_fd(), libc::F_DUPFD, 64) };
    if inherited < 0 {
        return Err(Error::Filesystem);
    }
    use std::os::fd::FromRawFd;
    // SAFETY: fcntl returned a new owned descriptor, deliberately inherited by ditto.
    let inherited = unsafe { File::from_raw_fd(inherited) };
    crate::helper::run_command(&mut copy, Duration::from_secs(120))?;
    drop(inherited);
    validate_bundle_tree(&candidate)?;
    if crate::runtime::identity(&candidate)? != identity {
        return Err(Error::Identity);
    }
    platform.verify_candidate(&candidate, trust, staged.verified.manifest())?;
    crate::runtime::sync_tree(
        &candidate,
        Instant::now() + Duration::from_secs(120),
        &|| Ok(()),
    )?;
    sync_directory(&directory)?;
    sync_directory(&staged.root)?;
    Ok(candidate)
}

/// Called only by the owner of an incomplete/Ready transaction or after a proven
/// swap. Missing purgeable storage is fine; changed identity is never deleted.
pub(super) fn discard(root: &Path) -> Result<(), Error> {
    if !root
        .join(RECORD)
        .try_exists()
        .map_err(|_| Error::Filesystem)?
    {
        return Ok(());
    }
    let record: Workspace = serde_json::from_slice(&read_small(&root.join(RECORD), 8192)?)
        .map_err(|_| Error::Filesystem)?;
    match fs::symlink_metadata(&record.path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(Error::Filesystem),
        Ok(_) => {
            let path = workspace(root)?;
            fs::remove_dir_all(path).map_err(|_| Error::Filesystem)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_tmp_and_temporary_parents_with_spaces_keep_exact_private_identity() {
        let durable = crate::owned_tests::Temp::new();
        let temporary = crate::owned_tests::Temp::new();
        let spaces = temporary.path().join("OS temporary storage with spaces");
        fs::DirBuilder::new().mode(0o700).create(&spaces).unwrap();
        for (index, parent) in [Path::new("/tmp").canonicalize().unwrap(), spaces]
            .iter()
            .enumerate()
        {
            let root = durable.path().join(format!("transaction-{index}"));
            fs::create_dir(&root).unwrap();
            create_in(&root, parent).unwrap();
            let path = workspace(&root).unwrap();
            assert_eq!(path.parent(), Some(parent.as_path()));
            assert_eq!(fs::metadata(&path).unwrap().mode() & 0o777, 0o700);
            discard(&root).unwrap();
            assert!(!path.exists());
        }
    }

    #[test]
    fn replaced_private_directory_is_not_adopted_or_deleted() {
        let durable = crate::owned_tests::Temp::new();
        let root = durable.path().join("transaction");
        fs::create_dir(&root).unwrap();
        create(&root).unwrap();
        let path = workspace(&root).unwrap();
        let saved = path.with_extension("owned-original");
        fs::rename(&path, &saved).unwrap();
        fs::DirBuilder::new().mode(0o700).create(&path).unwrap();
        assert!(workspace(&root).is_err());
        assert!(discard(&root).is_err());
        assert!(path.exists());
        fs::remove_dir(&path).unwrap();
        fs::rename(&saved, &path).unwrap();
        discard(&root).unwrap();
    }
}
