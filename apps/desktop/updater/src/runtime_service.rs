//! Bounded immutable service execution roots, independent of legacy evidence.
use super::*;

const SERVICE_STAGE: &str = ".service-stage-v1";

/// Publish an immutable service app, retaining at most active plus candidate.
///
/// `store` must end in [`SERVICE_STORE_NAME`]. No allowlist or history is used.
/// Other roots require native positive no-use proof before removal. Uncertain
/// execution roots consume capacity; unknown names are preserved but are not
/// execution slots. Unrelated legacy stores are never inspected here.
///
/// # Errors
/// Refuses unsafe stores, busy leases, uncertain two-root capacity, or failed
/// verification/copy. Runs only on a worker, with bounded work and a 45-second
/// admission budget. Already-started bounded deletion finishes without cancellation.
pub fn publish_service(
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
        &native_stage_unused,
    )
}

// The injected census is fixture-only; production always uses the native proof.
fn publish_checked(
    source: &Path,
    store: &Path,
    trust: &Trust,
    platform: &impl Platform,
    deadline: Instant,
    cancel: &impl Fn() -> Result<(), Error>,
    unused: &impl Fn(&Path, &File, Instant) -> bool,
) -> Result<PathBuf, Error> {
    check(deadline)?;
    cancel()?;
    trust.validate()?;
    if store
        .file_name()
        .is_none_or(|name| name != SERVICE_STORE_NAME)
        || trust.bundle_name != "Pilot Next.app"
    {
        return Err(Error::Identity);
    }
    installer::validate_target(source, trust)?;
    platform.verify(source, trust, &trust.current_build, None)?;
    let _lock = prepare_store(source, store)?;
    if store.canonicalize().map_err(|_| Error::Filesystem)? != store {
        return Err(Error::Identity);
    }
    let id = identity_checked(source, deadline, cancel)?;
    let destination = store.join(&id).join(&trust.bundle_name);
    // A legacy/missing selected root is outside this namespace and requires no
    // filesystem or process proof to admit the new candidate.
    let executable = std::env::current_exe()
        .and_then(fs::canonicalize)
        .map_err(|_| Error::Filesystem)?;
    let mut entries = Vec::new();
    for entry in fs::read_dir(store).map_err(|_| Error::Filesystem)? {
        check(deadline)?;
        cancel()?;
        if entries.len() >= 64 {
            return Err(Error::StagingCapacity);
        }
        entries.push(entry.map_err(|_| Error::Filesystem)?);
    }
    let mut retained = 0;
    let mut stage_retained = false;
    for entry in entries {
        check(deadline)?;
        cancel()?;
        let name = entry.file_name();
        if name == ".store.lock" {
            continue;
        }
        let root = entry.path();
        let app = root.join(&trust.bundle_name);
        let protected = app == destination || executable.starts_with(&root);
        let recognized = name.to_str().is_some_and(|name| hex_id(name, 64));
        if recognized
            && !protected
            && retire_root(&root, trust, &executable, deadline, unused).is_ok()
        {
            continue;
        }
        if name == SERVICE_STAGE {
            // This fixed stage is never an execution root. An inherited directory
            // lease excludes a surviving ditto child after its publisher crashes.
            if let Ok(lease) = stage_lease(&root)
                && cleanup::remove_leased_tree(&root, &lease, deadline, &|_, _, _| true).is_ok()
            {
                continue;
            }
            stage_retained = true;
        }
        if recognized || name == SERVICE_STAGE {
            retained += 1;
        }
    }
    if destination.try_exists().map_err(|_| Error::Filesystem)? {
        verify_published(&destination, trust, platform, deadline, cancel)?;
        return Ok(destination);
    }
    if retained >= 2 || stage_retained {
        return Err(Error::StagingCapacity);
    }
    copy_publish(
        source,
        &destination,
        &store.join(SERVICE_STAGE),
        trust,
        platform,
        deadline,
        cancel,
    )
}

// Caller holds the permanent service store lock. This namespace is exclusively
// owned by this publisher: disposal authenticates the container and absence of
// users, not obsolete bytes. Interrupted deletion may leave a damaged/empty app.
pub(super) fn retire_root(
    root: &Path,
    trust: &Trust,
    executable: &Path,
    deadline: Instant,
    unused: &impl Fn(&Path, &File, Instant) -> bool,
) -> Result<(), Error> {
    check(deadline)?;
    if root
        .parent()
        .and_then(Path::file_name)
        .is_none_or(|name| name != SERVICE_STORE_NAME)
        || root
            .file_name()
            .and_then(|name| name.to_str())
            .is_none_or(|name| !hex_id(name, 64))
        || root.canonicalize().map_err(|_| Error::Filesystem)? != root
        || executable.starts_with(root)
    {
        return Err(Error::Identity);
    }
    let lease = stage_lease(root)?;
    let entries = fs::read_dir(root)
        .map_err(|_| Error::Filesystem)?
        .take(2)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| Error::Filesystem)?;
    if entries.len() > 1
        || entries
            .first()
            .is_some_and(|entry| entry.file_name() != trust.bundle_name.as_str())
    {
        return Err(Error::Identity);
    }
    cleanup::remove_leased_tree(root, &lease, deadline, unused)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{os::unix::fs::PermissionsExt, sync::atomic::AtomicBool};

    struct FixturePlatform {
        reject_stage: bool,
    }
    impl Platform for FixturePlatform {
        fn verify(&self, app: &Path, _: &Trust, _: &str, _: Option<&str>) -> Result<(), Error> {
            if self.reject_stage && app.parent().unwrap().file_name().unwrap() == SERVICE_STAGE {
                Err(Error::Signature)
            } else {
                Ok(())
            }
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
        let source = temp.path().join(&trust.bundle_name);
        fs::create_dir_all(source.join("Contents")).unwrap();
        fs::write(source.join("Contents/Info.plist"), br#"<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleVersion</key><string>100.1</string></dict></plist>"#).unwrap();
        fs::write(source.join("resource"), b"A").unwrap();
        let store = temp.path().join(SERVICE_STORE_NAME);
        (temp, source, store, trust)
    }
    fn publish(
        source: &Path,
        store: &Path,
        trust: &Trust,
        unused: &impl Fn(&Path, &File, Instant) -> bool,
    ) -> Result<PathBuf, Error> {
        publish_checked(
            source,
            store,
            trust,
            &FixturePlatform {
                reject_stage: false,
            },
            Instant::now() + Duration::from_secs(45),
            &|| Ok(()),
            unused,
        )
    }
    #[test]
    fn legacy_evidence_does_not_consume_service_capacity() {
        let (temp, source, store, trust) = fixture();
        let legacy = temp.path().join(STORE_NAME);
        fs::DirBuilder::new().mode(0o700).create(&legacy).unwrap();
        for value in 0..7 {
            fs::write(legacy.join(format!("unknown-{value}")), b"legacy evidence").unwrap();
        }
        fs::DirBuilder::new().mode(0o700).create(&store).unwrap();
        fs::write(store.join(".DS_Store"), b"Finder metadata").unwrap();
        let app = publish(&source, &store, &trust, &|_, _, _| false).unwrap();
        assert_eq!(identity(&app).unwrap(), identity(&source).unwrap());
        assert_eq!(fs::read_dir(&legacy).unwrap().count(), 7);
        assert!(!store.join(HISTORY).exists());
        assert_eq!(fs::read_dir(&store).unwrap().count(), 3);
        assert_eq!(
            fs::read(store.join(".DS_Store")).unwrap(),
            b"Finder metadata"
        );
    }
    #[test]
    fn two_roots_defer_third_until_positive_no_use_proof() {
        let (_temp, source, store, trust) = fixture();
        let first = publish(&source, &store, &trust, &|_, _, _| false).unwrap();
        fs::write(source.join("resource"), b"B").unwrap();
        let second = publish(&source, &store, &trust, &|_, _, _| false).unwrap();
        fs::write(source.join("resource"), b"C").unwrap();
        assert_eq!(
            publish(&source, &store, &trust, &|_, _, _| false),
            Err(Error::StagingCapacity)
        );
        assert_eq!(fs::read_dir(&store).unwrap().count(), 3);
        let third = publish(&source, &store, &trust, &|root, _, _| {
            root == second.parent().unwrap()
        })
        .unwrap();
        assert!(first.exists());
        assert!(!second.exists());
        assert!(third.exists());
        assert_eq!(fs::read(first.join("resource")).unwrap(), b"A");
        assert_eq!(fs::read_dir(&store).unwrap().count(), 3);
        fs::write(source.join("resource"), b"A").unwrap();
        assert_eq!(
            publish(&source, &store, &trust, &|_, _, _| false).unwrap(),
            first
        );
    }
    #[test]
    fn repeated_failed_copy_verification_reclaims_one_stage_without_history() {
        let (_temp, source, store, trust) = fixture();
        for _ in 0..5 {
            assert_eq!(
                publish_checked(
                    &source,
                    &store,
                    &trust,
                    &FixturePlatform { reject_stage: true },
                    Instant::now() + Duration::from_secs(45),
                    &|| Ok(()),
                    &|_, _, _| false
                ),
                Err(Error::Signature)
            );
            assert_eq!(fs::read_dir(&store).unwrap().count(), 2);
            assert!(store.join(SERVICE_STAGE).exists());
            assert!(!store.join(HISTORY).exists());
        }
        assert!(
            publish(&source, &store, &trust, &|_, _, _| false)
                .unwrap()
                .exists()
        );
        assert!(!store.join(SERVICE_STAGE).exists());
    }
    #[test]
    fn live_stage_is_preserved_and_unknown_names_do_not_consume_slots() {
        let (_temp, source, store, trust) = fixture();
        fs::DirBuilder::new().mode(0o700).create(&store).unwrap();
        let stage = store.join(SERVICE_STAGE);
        fs::DirBuilder::new().mode(0o700).create(&stage).unwrap();
        fs::write(stage.join("unfinished"), b"keep").unwrap();
        let lease = stage_lease(&stage).unwrap();
        assert_eq!(
            publish(&source, &store, &trust, &|_, _, _| false),
            Err(Error::StagingCapacity)
        );
        assert_eq!(fs::read(stage.join("unfinished")).unwrap(), b"keep");
        drop(lease);
        fs::write(store.join("unknown-one"), b"keep").unwrap();
        fs::write(store.join("unknown-two"), b"keep").unwrap();
        assert!(
            publish(&source, &store, &trust, &|_, _, _| false)
                .unwrap()
                .exists()
        );
        assert!(!stage.exists());
        assert_eq!(fs::read(store.join("unknown-one")).unwrap(), b"keep");
    }
    #[test]
    fn damaged_unused_root_is_reclaimed_but_active_damaged_root_blocks_third() {
        let (_temp, source, store, trust) = fixture();
        let old = publish(&source, &store, &trust, &|_, _, _| false).unwrap();
        fs::write(source.join("resource"), b"B").unwrap();
        let active = publish(&source, &store, &trust, &|_, _, _| false).unwrap();
        // Simulate a prior interrupted deletion: no signed app remains.
        fs::remove_dir_all(&old).unwrap();
        fs::write(source.join("resource"), b"C").unwrap();
        assert_eq!(
            publish(&source, &store, &trust, &|_, _, _| false),
            Err(Error::StagingCapacity)
        );
        assert!(old.parent().unwrap().exists());
        let candidate = publish(&source, &store, &trust, &|root, _, _| {
            root == old.parent().unwrap()
        })
        .unwrap();
        assert!(!old.parent().unwrap().exists());
        assert!(active.exists());
        assert!(candidate.exists());
        assert_eq!(fs::read_dir(&store).unwrap().count(), 3);
    }
    #[test]
    fn cancellation_and_deadline_precede_store_creation() {
        let (_temp, source, store, trust) = fixture();
        let platform = FixturePlatform {
            reject_stage: false,
        };
        assert_eq!(
            publish_service(
                &source,
                &store,
                &trust,
                &platform,
                Instant::now() + Duration::from_secs(45),
                &AtomicBool::new(true)
            ),
            Err(Error::Cancelled)
        );
        assert_eq!(
            publish_service(
                &source,
                &store,
                &trust,
                &platform,
                Instant::now(),
                &AtomicBool::new(false)
            ),
            Err(Error::Cancelled)
        );
        assert!(!store.exists());
    }
}
