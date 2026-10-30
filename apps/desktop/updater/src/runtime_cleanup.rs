//! One-shot retirement of positively identified, unused published capsules.
use super::*;

/// Counts only this bounded cleanup attempt, not the entire store.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CleanupSummary {
    pub removed: usize,
    pub preserved: usize,
}

/// Best-effort, worker-only cleanup after a verified daemon handoff.
///
/// Never call from polling or ordinary startup. Unknown entries, stages and
/// history stay untouched; this operation never creates an archive. At most
/// four roots and 64 store entries are admitted within a ten-second budget.
/// Native signature verification is synchronous. Once deletion starts, finish
/// its prebounded snapshot (at most 30,001 nodes) without deadline cancellation;
/// filesystem errors can still leave remnants. Completion may exceed the budget.
/// Uncertain or live capsules are preserved, including the running application's
/// own capsule.
/// Legacy stores require signed bundle verification; the dedicated service store
/// permits damaged-root retirement using its private container and no-use proof.
///
/// # Errors
/// Rejects unsafe store paths and unavailable permanent locks. Entry failures
/// are counted as preserved and must not invalidate a successful handoff.
pub fn cleanup_obsolete(store: &Path, trust: &Trust) -> Result<CleanupSummary, Error> {
    let executable = std::env::current_exe()
        .and_then(fs::canonicalize)
        .map_err(|_| Error::Filesystem)?;
    cleanup_checked(
        store,
        trust,
        &installer::NativePlatform,
        &executable,
        Instant::now() + Duration::from_secs(10),
        &native_stage_unused,
    )
}

fn cleanup_checked(
    store: &Path,
    trust: &Trust,
    platform: &impl Platform,
    executable: &Path,
    deadline: Instant,
    unused: &impl Fn(&Path, &File, Instant) -> bool,
) -> Result<CleanupSummary, Error> {
    trust.validate()?;
    if !store.is_absolute()
        || store
            .file_name()
            .is_none_or(|name| name != STORE_NAME && name != SERVICE_STORE_NAME)
        || trust.bundle_name != "Pilot Next.app"
    {
        return Err(Error::Identity);
    }
    // Do not create an obsolete store merely to clean it.
    match fs::symlink_metadata(store) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(CleanupSummary::default());
        }
        Err(_) => return Err(Error::Filesystem),
        Ok(_) => {}
    }
    if store.canonicalize().map_err(|_| Error::Filesystem)? != store {
        return Err(Error::Identity);
    }
    validate_store(store)?;
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
        .open(store.join(".store.lock"))
        .map_err(|_| Error::Filesystem)?;
    let meta = lock.metadata().map_err(|_| Error::Filesystem)?;
    // SAFETY: identity query and nonblocking lock on our owned permanent fd.
    if !meta.is_file()
        || meta.nlink() != 1
        || meta.mode() & 0o077 != 0
        || meta.uid() != unsafe { libc::geteuid() }
        || unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0
    {
        return Err(Error::Busy);
    }
    installer::acl_policy(&store.join(".store.lock"), 2)?;
    // Snapshot before deletion so readdir cannot skip entries during mutation.
    let entries = fs::read_dir(store)
        .map_err(|_| Error::Filesystem)?
        .take(64)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| Error::Filesystem)?;
    let mut summary = CleanupSummary::default();
    let mut attempted = 0;
    for entry in entries {
        if entry.file_name() == ".store.lock" {
            continue;
        }
        let recognized = entry
            .file_name()
            .to_str()
            .is_some_and(|name| hex_id(name, 64));
        if !recognized || attempted >= 4 || check(deadline).is_err() {
            summary.preserved += 1;
            continue;
        }
        attempted += 1;
        let removed = if store
            .file_name()
            .is_some_and(|name| name == SERVICE_STORE_NAME)
        {
            service::retire_root(&entry.path(), trust, executable, deadline, unused)
        } else {
            remove_capsule(&entry.path(), trust, platform, executable, deadline, unused)
        };
        if removed.is_ok() {
            summary.removed += 1;
        } else {
            summary.preserved += 1;
        }
    }
    Ok(summary)
}

fn remove_capsule(
    root: &Path,
    trust: &Trust,
    platform: &impl Platform,
    executable: &Path,
    deadline: Instant,
    unused: &impl Fn(&Path, &File, Instant) -> bool,
) -> Result<(), Error> {
    check(deadline)?;
    if executable.starts_with(root) || root.canonicalize().map_err(|_| Error::Filesystem)? != root {
        return Err(Error::Identity);
    }
    let lease = stage_lease(root)?;
    let children = fs::read_dir(root)
        .map_err(|_| Error::Filesystem)?
        .take(2)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| Error::Filesystem)?;
    if children.len() != 1 || children[0].file_name() != trust.bundle_name.as_str() {
        return Err(Error::Identity);
    }
    let app = root.join(&trust.bundle_name);
    installer::validate_target(&app, trust)?;
    let build = sealed_build(&app)?;
    platform.verify(&app, trust, &build, None)?;
    remove_leased_tree(root, &lease, deadline, unused)
}

pub(super) fn remove_leased_tree(
    root: &Path,
    lease: &File,
    deadline: Instant,
    unused: &impl Fn(&Path, &File, Instant) -> bool,
) -> Result<(), Error> {
    // Bound deletion work without hashing capsule contents. Snapshot identities
    // and unlink links, never follow them during removal.
    let mut nodes = vec![(
        root.to_owned(),
        lease.metadata().map_err(|_| Error::Filesystem)?,
    )];
    let mut cursor = 0;
    while cursor < nodes.len() {
        check(deadline)?;
        let (path, meta) = &nodes[cursor];
        if path.components().count() - root.components().count() > 129 {
            return Err(Error::Exhausted);
        }
        if meta.is_dir() {
            let path = path.clone();
            for entry in fs::read_dir(path).map_err(|_| Error::Filesystem)? {
                check(deadline)?;
                if nodes.len() >= 30_001 {
                    return Err(Error::Exhausted);
                }
                let path = entry.map_err(|_| Error::Filesystem)?.path();
                let meta = fs::symlink_metadata(&path).map_err(|_| Error::Filesystem)?;
                nodes.push((path, meta));
            }
        }
        cursor += 1;
    }
    if !unused(root, lease, deadline) {
        return Err(Error::Busy);
    }
    check(deadline)?;
    // Deletion is irreversible. Cancel only before the first mutation, rather
    // than deliberately leaving a broken capsule when the budget expires.
    for (path, original) in nodes.iter().rev() {
        let named = fs::symlink_metadata(path).map_err(|_| Error::Filesystem)?;
        if (named.dev(), named.ino(), named.mode())
            != (original.dev(), original.ino(), original.mode())
        {
            return Err(Error::Identity);
        }
        if named.is_dir() {
            fs::remove_dir(path)
        } else {
            fs::remove_file(path)
        }
        .map_err(|_| Error::Filesystem)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    struct Verified;
    impl Platform for Verified {
        fn verify(&self, _: &Path, _: &Trust, _: &str, _: Option<&str>) -> Result<(), Error> {
            Ok(())
        }
        fn swap(&self, _: &File, _: &Path, _: &Path) -> Result<(), Error> {
            unreachable!()
        }
        fn relaunch(&self, _: &Path, _: &Path) -> Result<(), Error> {
            unreachable!()
        }
    }
    fn fixture() -> (crate::owned_tests::Temp, PathBuf, PathBuf, Trust) {
        let temp = crate::owned_tests::Temp::new();
        fs::set_permissions(temp.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let trust = crate::owned_tests::trust();
        let store = temp.path().join(STORE_NAME);
        let root = store.join("a".repeat(64));
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&root)
            .unwrap();
        let app = root.join(&trust.bundle_name);
        fs::create_dir_all(app.join("Contents")).unwrap();
        fs::write(app.join("Contents/Info.plist"), br#"<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleVersion</key><string>100.1</string></dict></plist>"#).unwrap();
        fs::write(app.join("resource"), b"fixture").unwrap();
        (temp, store, root, trust)
    }
    fn run(
        store: &Path,
        trust: &Trust,
        executable: &Path,
        unused: bool,
    ) -> Result<CleanupSummary, Error> {
        cleanup_checked(
            store,
            trust,
            &Verified,
            executable,
            Instant::now() + Duration::from_secs(10),
            &|_, _, _| unused,
        )
    }
    #[test]
    fn cleanup_removes_only_verified_unused_roots_without_archiving() {
        let (_temp, store, root, trust) = fixture();
        let unknown = store.join("unknown");
        fs::create_dir(&unknown).unwrap();
        fs::write(unknown.join("evidence"), b"keep").unwrap();
        fs::create_dir(store.join(HISTORY)).unwrap();
        let stage = store.join(format!("{STAGE_PREFIX}{}", "b".repeat(32)));
        fs::create_dir(&stage).unwrap();
        assert_eq!(
            run(&store, &trust, Path::new("/installed/app"), true).unwrap(),
            CleanupSummary {
                removed: 1,
                preserved: 3
            }
        );
        assert!(!root.exists());
        assert!(stage.exists());
        assert_eq!(fs::read(unknown.join("evidence")).unwrap(), b"keep");
        assert_eq!(fs::read_dir(store.join(HISTORY)).unwrap().count(), 0);
    }
    #[test]
    fn cleanup_preserves_live_current_extra_and_unverified_roots() {
        let (_temp, store, root, trust) = fixture();
        assert_eq!(
            run(&store, &trust, Path::new("/installed/app"), false)
                .unwrap()
                .removed,
            0
        );
        assert_eq!(
            run(
                &store,
                &trust,
                &root.join("Pilot Next.app/Contents/MacOS/Pilot"),
                true
            )
            .unwrap()
            .removed,
            0
        );
        // Real native verification refuses this unsigned fixture, regardless of
        // whether the native process census can establish global absence.
        assert_eq!(cleanup_obsolete(&store, &trust).unwrap().removed, 0);
        fs::write(root.join("unknown"), b"keep").unwrap();
        assert_eq!(
            run(&store, &trust, Path::new("/installed/app"), true)
                .unwrap()
                .removed,
            0
        );
        assert!(root.exists());
    }
    #[test]
    fn cleanup_attempts_at_most_four_roots_and_preserves_escape_links() {
        let (temp, store, root, trust) = fixture();
        for value in 1..=4 {
            let other = store.join(format!("{value:064x}"));
            fs::DirBuilder::new().mode(0o700).create(&other).unwrap();
            let app = other.join(&trust.bundle_name);
            fs::create_dir_all(app.join("Contents")).unwrap();
            fs::copy(
                root.join(&trust.bundle_name).join("Contents/Info.plist"),
                app.join("Contents/Info.plist"),
            )
            .unwrap();
        }
        let summary = run(&store, &trust, Path::new("/installed/app"), true).unwrap();
        assert_eq!(
            summary,
            CleanupSummary {
                removed: 4,
                preserved: 1
            }
        );
        let remaining = fs::read_dir(&store)
            .unwrap()
            .filter_map(Result::ok)
            .find(|entry| entry.file_name() != ".store.lock")
            .unwrap()
            .path();
        let outside = temp.path().join("outside");
        fs::write(&outside, b"keep").unwrap();
        std::os::unix::fs::symlink(&outside, remaining.join(&trust.bundle_name).join("escape"))
            .unwrap();
        assert_eq!(
            cleanup_checked(
                &store,
                &trust,
                &Verified,
                Path::new("/installed/app"),
                Instant::now() + Duration::from_secs(10),
                &|_, _, _| panic!("escape must be refused before process census")
            )
            .unwrap()
            .removed,
            0
        );
        assert_eq!(fs::read(outside).unwrap(), b"keep");
        assert!(remaining.exists());
    }
    #[test]
    fn cleanup_refuses_busy_store_unsafe_alias_and_expired_budget() {
        let (temp, store, root, trust) = fixture();
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(store.join(".store.lock"))
            .unwrap();
        // SAFETY: owned fixture descriptor.
        assert_eq!(
            unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
            0
        );
        assert_eq!(
            run(&store, &trust, Path::new("/installed/app"), true),
            Err(Error::Busy)
        );
        drop(lock);
        let alias_parent = temp.path().join("alias");
        std::os::unix::fs::symlink(temp.path(), &alias_parent).unwrap();
        assert_eq!(
            run(
                &alias_parent.join(STORE_NAME),
                &trust,
                Path::new("/installed/app"),
                true
            ),
            Err(Error::Identity)
        );
        let summary = cleanup_checked(
            &store,
            &trust,
            &Verified,
            Path::new("/installed/app"),
            Instant::now(),
            &|_, _, _| panic!("expired cleanup must not scan processes"),
        )
        .unwrap();
        assert_eq!(summary.removed, 0);
        assert!(root.exists());
    }
    #[test]
    fn native_cleanup_proof_preserves_a_directory_with_an_open_file() {
        let (_temp, _store, root, _trust) = fixture();
        let _held = File::open(root.join("Pilot Next.app/resource")).unwrap();
        let lease = stage_lease(&root).unwrap();
        assert!(!native_stage_unused(
            &root,
            &lease,
            Instant::now() + Duration::from_secs(2)
        ));
        assert!(root.exists());
    }
    #[test]
    fn service_cleanup_retires_damaged_roots_only_after_no_use_proof() {
        let (temp, legacy, root, trust) = fixture();
        let service = temp.path().join(SERVICE_STORE_NAME);
        fs::rename(&legacy, &service).unwrap();
        let root = service.join(root.file_name().unwrap());
        fs::remove_dir_all(root.join(&trust.bundle_name)).unwrap();
        let check = |unused| {
            cleanup_checked(
                &service,
                &trust,
                &Verified,
                Path::new("/installed/app"),
                Instant::now() + Duration::from_secs(10),
                &|_, _, _| unused,
            )
            .unwrap()
        };
        assert_eq!(check(false).removed, 0);
        assert!(root.exists());
        assert_eq!(check(true).removed, 1);
        assert!(!root.exists());
    }
    #[test]
    fn native_signature_requires_the_compiled_application_requirement() {
        let (_temp, store, root, mut trust) = fixture();
        let app = root.join(&trust.bundle_name);
        fs::remove_file(app.join("resource")).unwrap();
        fs::create_dir(app.join("Contents/MacOS")).unwrap();
        fs::copy("/usr/bin/true", app.join("Contents/MacOS/fixture")).unwrap();
        fs::write(app.join("Contents/Info.plist"), format!(r#"<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>{}</string><key>CFBundleExecutable</key><string>fixture</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>100.1</string></dict></plist>"#, trust.application_id)).unwrap();
        assert!(
            Command::new("/usr/bin/codesign")
                .args([
                    "--force",
                    "--sign",
                    "-",
                    "--identifier",
                    &trust.application_id
                ])
                .arg(&app)
                .status()
                .unwrap()
                .success()
        );
        let deadline = Instant::now() + Duration::from_secs(10);
        trust.code_requirement = "identifier \"org.example.not-pilot\"".into();
        assert_eq!(
            cleanup_checked(
                &store,
                &trust,
                &installer::NativePlatform,
                Path::new("/installed/app"),
                deadline,
                &|_, _, _| panic!("foreign signatures must not reach process census")
            )
            .unwrap()
            .removed,
            0
        );
        trust.code_requirement = format!("identifier \"{}\"", trust.application_id);
        // Native signature verification paired with an injected positive proof;
        // the real census is separately exercised with a held native reference.
        assert_eq!(
            cleanup_checked(
                &store,
                &trust,
                &installer::NativePlatform,
                Path::new("/installed/app"),
                deadline,
                &|_, _, _| true
            )
            .unwrap()
            .removed,
            1
        );
        assert!(!root.exists());
    }
}
