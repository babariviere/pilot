//! Bounded ZIP extraction into a private, empty staging directory. Never the live app.
use crate::{Error, transport::Cancellation};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{OpenOptionsExt, PermissionsExt, symlink},
    path::{Component, Path, PathBuf},
};

pub const MAX_EXPANDED: u64 = 2 * 1024 * 1024 * 1024;
mod admission;

pub fn extract(
    archive: &Path,
    destination: &Path,
    bundle_name: &str,
    cancel: &Cancellation,
) -> Result<PathBuf, Error> {
    extract_with_sync(archive, destination, bundle_name, cancel, Some(sync_file))
}

/// Purgeable preview/preparation only. Never a final candidate or rollback entry.
#[cfg(all(target_os = "macos", feature = "native-macos"))]
pub(crate) fn extract_temporary(
    archive: &Path,
    destination: &Path,
    bundle_name: &str,
    cancel: &Cancellation,
) -> Result<PathBuf, Error> {
    extract_with_sync(archive, destination, bundle_name, cancel, None)
}

type SyncFile = fn(&File) -> Result<(), Error>;

fn sync_file(file: &File) -> Result<(), Error> {
    file.sync_all().map_err(|_| Error::Filesystem)
}

fn extract_with_sync(
    archive: &Path,
    destination: &Path,
    bundle_name: &str,
    cancel: &Cancellation,
    sync: Option<SyncFile>,
) -> Result<PathBuf, Error> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(archive)
        .map_err(|_| Error::Filesystem)?;
    let mut zip = admission::index(file, cancel)?;
    fs::create_dir(destination).map_err(|_| Error::Filesystem)?;
    fs::set_permissions(destination, fs::Permissions::from_mode(0o700))
        .map_err(|_| Error::Filesystem)?;
    let mut expanded = 0_u64;
    let mut links = Vec::new();
    for index in 0..zip.len() {
        cancel.check()?;
        let mut entry = zip.by_index(index).map_err(|_| Error::Archive)?;
        let name = std::str::from_utf8(entry.name_raw())
            .map_err(|_| Error::Archive)?
            .to_owned();
        let relative = safe_name(&name, bundle_name)?;
        let path = destination.join(&relative);
        if entry.is_dir() {
            real_directories(destination, &relative)?;
            continue;
        }
        let parent = relative.parent().ok_or(Error::Archive)?;
        real_directories(destination, parent)?;
        if entry.size() > MAX_EXPANDED
            || expanded
                .checked_add(entry.size())
                .is_none_or(|size| size > MAX_EXPANDED)
        {
            return Err(Error::Archive);
        }
        let declared = entry.size();
        let mode = entry.unix_mode().unwrap_or(0o100644);
        if entry.is_symlink() {
            if declared > 1024 {
                return Err(Error::Archive);
            }
            let mut target = String::new();
            entry
                .by_ref()
                .take(1025)
                .read_to_string(&mut target)
                .map_err(|_| Error::Archive)?;
            if target.len() as u64 != declared
                || target.contains('\0')
                || Path::new(&target).is_absolute()
                || target.contains('\\')
            {
                return Err(Error::Archive);
            }
            links.push((path, target));
            expanded += declared;
            continue;
        }
        if mode & 0o170000 != 0 && mode & 0o170000 != 0o100000 {
            return Err(Error::Archive);
        }
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(if mode & 0o111 == 0 { 0o644 } else { 0o755 })
            .custom_flags(libc::O_NOFOLLOW)
            .open(&path)
            .map_err(|_| Error::Archive)?;
        let mut count = 0_u64;
        let mut buffer = [0; 65536];
        loop {
            cancel.check()?;
            let n = entry.read(&mut buffer).map_err(|_| Error::Archive)?;
            if n == 0 {
                break;
            }
            count += n as u64;
            if count > declared {
                return Err(Error::Archive);
            }
            output
                .write_all(&buffer[..n])
                .map_err(|_| Error::Filesystem)?;
        }
        if count != declared {
            return Err(Error::Archive);
        }
        expanded += count;
        if let Some(sync) = sync {
            sync(&output)?;
        }
    }
    // No symlink can influence extraction writes; links are materialized only afterwards.
    for (path, target) in &links {
        symlink(target, path).map_err(|_| Error::Archive)?;
    }
    let bundle = destination
        .join(bundle_name)
        .canonicalize()
        .map_err(|_| Error::Archive)?;
    for (path, _) in &links {
        if !path
            .canonicalize()
            .map_err(|_| Error::Archive)?
            .starts_with(&bundle)
        {
            return Err(Error::Archive);
        }
    }
    if let Some(sync) = sync {
        sync_directories(destination, sync)?;
    }
    Ok(bundle)
}

fn safe_name(name: &str, bundle: &str) -> Result<PathBuf, Error> {
    if name.len() > 1024 || name.contains(['\\', '\0', ':']) || name.bytes().any(|b| b < 0x20) {
        return Err(Error::Archive);
    }
    let trimmed = name.strip_suffix('/').unwrap_or(name);
    if trimmed
        .split('/')
        .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(Error::Archive);
    }
    let path = Path::new(trimmed);
    if path
        .components()
        .any(|part| !matches!(part, Component::Normal(_)))
        || path
            .components()
            .next()
            .is_none_or(|part| part.as_os_str() != bundle)
    {
        return Err(Error::Archive);
    }
    Ok(path.to_owned())
}

fn real_directories(root: &Path, relative: &Path) -> Result<(), Error> {
    let mut current = root.to_owned();
    for component in relative.components() {
        if !matches!(component, Component::Normal(_)) {
            return Err(Error::Archive);
        }
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => (),
            Ok(_) => return Err(Error::Archive),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir(&current).map_err(|_| Error::Filesystem)?;
                fs::set_permissions(&current, fs::Permissions::from_mode(0o755))
                    .map_err(|_| Error::Filesystem)?;
            }
            Err(_) => return Err(Error::Filesystem),
        }
    }
    Ok(())
}

fn sync_directories(path: &Path, sync: SyncFile) -> Result<(), Error> {
    for entry in fs::read_dir(path).map_err(|_| Error::Filesystem)? {
        let entry = entry.map_err(|_| Error::Filesystem)?;
        if entry.file_type().map_err(|_| Error::Filesystem)?.is_dir() {
            sync_directories(&entry.path(), sync)?;
        }
    }
    sync(&File::open(path).map_err(|_| Error::Filesystem)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::owned_tests::{Temp, archive};
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn durable_extraction_syncs_files_and_directories_and_propagates_failure() {
        static FILES: AtomicUsize = AtomicUsize::new(0);
        static DIRECTORIES: AtomicUsize = AtomicUsize::new(0);
        fn observe(file: &File) -> Result<(), Error> {
            if file.metadata().unwrap().is_dir() {
                DIRECTORIES.fetch_add(1, Ordering::Relaxed);
            } else {
                FILES.fetch_add(1, Ordering::Relaxed);
            }
            sync_file(file)
        }
        let temp = Temp::new();
        let input = temp.path().join("archive.zip");
        fs::write(&input, archive()).unwrap();
        extract_with_sync(
            &input,
            &temp.path().join("durable"),
            "Pilot Next.app",
            &Cancellation::default(),
            Some(observe),
        )
        .unwrap();
        assert_eq!(FILES.load(Ordering::Relaxed), 2);
        assert_eq!(DIRECTORIES.load(Ordering::Relaxed), 3);
        assert_eq!(
            extract_with_sync(
                &input,
                &temp.path().join("failed-sync"),
                "Pilot Next.app",
                &Cancellation::default(),
                Some(|_| Err(Error::Filesystem))
            ),
            Err(Error::Filesystem)
        );
    }

    #[cfg(all(target_os = "macos", feature = "native-macos"))]
    #[test]
    fn disposable_extraction_preserves_content_validation_cancellation_and_purgeability() {
        let temp = Temp::new();
        let input = temp.path().join("archive.zip");
        fs::write(&input, archive()).unwrap();
        let durable = extract(
            &input,
            &temp.path().join("durable"),
            "Pilot Next.app",
            &Cancellation::default(),
        )
        .unwrap();
        let disposable = extract_temporary(
            &input,
            &temp.path().join("temporary"),
            "Pilot Next.app",
            &Cancellation::default(),
        )
        .unwrap();
        assert_eq!(
            crate::runtime::identity(&durable).unwrap(),
            crate::runtime::identity(&disposable).unwrap()
        );
        let cancel = Cancellation::default();
        cancel.cancel();
        assert_eq!(
            extract_temporary(
                &input,
                &temp.path().join("cancelled"),
                "Pilot Next.app",
                &cancel
            ),
            Err(Error::Cancelled)
        );
        assert_eq!(
            extract_temporary(
                &input,
                &temp.path().join("wrong-root"),
                "Other.app",
                &Cancellation::default()
            ),
            Err(Error::Archive)
        );
        fs::remove_dir_all(disposable.parent().unwrap()).unwrap();
        assert!(
            input.is_file(),
            "purging disposable data never loses the recovery archive"
        );
        let regenerated = extract_temporary(
            &input,
            &temp.path().join("regenerated"),
            "Pilot Next.app",
            &Cancellation::default(),
        )
        .unwrap();
        assert_eq!(
            crate::runtime::identity(&durable).unwrap(),
            crate::runtime::identity(&regenerated).unwrap()
        );
    }
}
