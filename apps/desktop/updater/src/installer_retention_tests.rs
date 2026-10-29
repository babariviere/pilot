use super::*;
use crate::owned_tests::{Temp, archive, envelope, metadata, trust};

struct FixturePlatform;
impl Platform for FixturePlatform {
    fn verify(&self, _: &Path, _: &Trust, _: &str, _: Option<&str>) -> Result<(), Error> {
        Ok(())
    }
    fn swap(&self, _: &File, _: &Path, _: &Path) -> Result<(), Error> {
        panic!("capacity handling must not install")
    }
    fn relaunch(&self, _: &Path, _: &Path) -> Result<(), Error> {
        panic!("capacity handling must not relaunch")
    }
}

fn target(temp: &Temp) -> PathBuf {
    let target = temp.path().join("Pilot Next.app");
    fs::create_dir(&target).unwrap();
    target
}

fn transaction(target: &Path, id: u8, phase: Phase) -> PathBuf {
    let root = target
        .parent()
        .unwrap()
        .join(format!(".pilot-next-update-{id:032x}"));
    fs::create_dir(&root).unwrap();
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
    let old = root.join("install-payload/Pilot Next.app");
    fs::create_dir_all(&old).unwrap();
    fs::write(old.join("rollback-resource"), b"exact old payload").unwrap();
    let bytes = archive();
    let mut manifest = metadata(&bytes);
    manifest.build = format!("{id}.1");
    write_new(&root.join("archive.zip"), &bytes).unwrap();
    write_new(&root.join("manifest.json"), &envelope(&manifest)).unwrap();
    write_new(
        &root.join("ui-state.json"),
        br#"{"selected":"exact retained selection"}"#,
    )
    .unwrap();
    let meta = fs::metadata(old).unwrap();
    write_journal(
        &root,
        &Journal {
            schema: 1,
            phase,
            original_device: meta.dev(),
            original_inode: meta.ino(),
        },
    )
    .unwrap();
    root
}

#[test]
fn repeated_acknowledged_history_does_not_exhaust_staging() {
    let temp = Temp::new();
    let target = target(&temp);
    let mut receipts = Vec::new();
    for id in 1..=8 {
        let (root, lock) = new_stage(&target, &trust(), &FixturePlatform)
            .expect("acknowledged history must leave room beyond two upgrades");
        discard_incomplete(&root, &target).unwrap(); // fixture only, substitute acknowledged install
        let root = transaction(&target, id, Phase::StartupAcknowledged);
        let old = fs::metadata(root.join("install-payload/Pilot Next.app")).unwrap();
        receipts.push((root, old.dev(), old.ino()));
        drop(lock);
    }
    assert!(recoveries(&target, &trust()).unwrap().is_empty());
    for (root, device, inode) in receipts {
        let located = transaction_path(&root).unwrap();
        assert_eq!(recovery_phase(&root).unwrap(), Phase::StartupAcknowledged);
        let old = fs::metadata(located.join("install-payload/Pilot Next.app")).unwrap();
        assert_eq!((old.dev(), old.ino()), (device, inode));
        assert_eq!(
            fs::read(located.join("install-payload/Pilot Next.app/rollback-resource")).unwrap(),
            b"exact old payload"
        );
        assert_eq!(fs::read(located.join("archive.zip")).unwrap(), archive());
        let signed = signed_manifest(&located, &trust()).unwrap();
        assert_eq!(
            signed.envelope(),
            fs::read(located.join("manifest.json")).unwrap()
        );
        #[cfg(any(feature = "native-macos", feature = "native-linux"))]
        assert_eq!(
            crate::app_update::navigation(&root).unwrap()["selected"],
            "exact retained selection"
        );
    }
}

#[test]
fn uncertain_capacity_is_not_an_uncertain_new_install() {
    let temp = Temp::new();
    let target = target(&temp);
    let roots = [
        transaction(&target, 1, Phase::Committed),
        transaction(&target, 2, Phase::RelaunchRequested),
    ];
    assert!(matches!(
        new_stage(&target, &trust(), &FixturePlatform),
        Err(Error::StagingCapacity)
    ));
    for root in roots {
        assert!(root.join("archive.zip").exists());
        assert!(
            root.join("install-payload/Pilot Next.app/rollback-resource")
                .exists()
        );
    }
    assert_eq!(recoveries(&target, &trust()).unwrap().len(), 2);
}

#[test]
fn current_receipt_and_uncertain_phases_are_never_archived() {
    for phase in [
        Phase::Ready,
        Phase::Committed,
        Phase::Swapped,
        Phase::RelaunchRequested,
        Phase::Aborted,
    ] {
        let temp = Temp::new();
        let target = target(&temp);
        let current = transaction(&target, 100, Phase::StartupAcknowledged);
        let uncertain = transaction(&target, 1, phase);
        assert!(
            matches!(
                new_stage(&target, &trust(), &FixturePlatform),
                Err(Error::StagingCapacity)
            ),
            "phase {phase:?}"
        );
        assert!(current.exists());
        assert!(uncertain.exists());
        assert!(!target.parent().unwrap().join(HISTORY).exists());
    }
}

#[test]
fn pending_ack_rollback_mismatch_and_live_journal_lock_keep_evidence_active() {
    for fault in 0..3 {
        let temp = Temp::new();
        let target = target(&temp);
        transaction(&target, 100, Phase::StartupAcknowledged);
        let root = transaction(&target, 1, Phase::StartupAcknowledged);
        let mut guard = None;
        match fault {
            0 => fs::write(root.join("journal.pending"), b"interrupted write").unwrap(),
            1 => {
                fs::rename(
                    root.join("install-payload/Pilot Next.app"),
                    root.join("retained-other"),
                )
                .unwrap();
                fs::create_dir(root.join("install-payload/Pilot Next.app")).unwrap();
            }
            _ => guard = Some(journal_guard(&root).unwrap()),
        }
        assert!(matches!(
            new_stage(&target, &trust(), &FixturePlatform),
            Err(Error::StagingCapacity)
        ));
        assert!(root.exists());
        drop(guard);
    }
}

#[test]
fn live_target_lock_prevents_any_archive_or_new_stage() {
    let temp = Temp::new();
    let target = target(&temp);
    let root = transaction(&target, 1, Phase::StartupAcknowledged);
    transaction(&target, 100, Phase::StartupAcknowledged);
    let _lock = lock_target(&target).unwrap();
    assert!(matches!(
        new_stage(&target, &trust(), &FixturePlatform),
        Err(Error::Busy)
    ));
    assert!(root.exists());
    assert!(!target.parent().unwrap().join(HISTORY).exists());
}

#[test]
fn archive_failure_never_replaces_existing_history_or_admits_stage() {
    let temp = Temp::new();
    let target = target(&temp);
    let root = transaction(&target, 1, Phase::StartupAcknowledged);
    transaction(&target, 100, Phase::StartupAcknowledged);
    let history = target.parent().unwrap().join(HISTORY);
    fs::DirBuilder::new().mode(0o700).create(&history).unwrap();
    let collision = history.join(root.file_name().unwrap());
    fs::create_dir(&collision).unwrap();
    assert!(matches!(
        new_stage(&target, &trust(), &FixturePlatform),
        Err(Error::StagingArchiveFailed)
    ));
    assert!(root.exists());
    assert!(collision.exists());
    assert_eq!(
        fs::read_dir(target.parent().unwrap())
            .unwrap()
            .filter(|entry| transaction_name(&entry.as_ref().unwrap().path()))
            .count(),
        2
    );
}

#[test]
fn archive_sync_failure_keeps_complete_evidence_discoverable() {
    let temp = Temp::new();
    let target = target(&temp);
    let root = transaction(&target, 1, Phase::StartupAcknowledged);
    let history = target.parent().unwrap().join(HISTORY);
    fs::DirBuilder::new().mode(0o700).create(&history).unwrap();
    let moved = history.join(root.file_name().unwrap());
    assert_eq!(
        archive_move(&root, &moved, |_| Err(Error::Filesystem)),
        Err(Error::Filesystem)
    );
    assert_eq!(transaction_path(&root).unwrap(), moved);
    assert_eq!(recovery_phase(&root).unwrap(), Phase::StartupAcknowledged);
    assert_eq!(fs::read(moved.join("archive.zip")).unwrap(), archive());
    assert_eq!(
        fs::read(moved.join("install-payload/Pilot Next.app/rollback-resource")).unwrap(),
        b"exact old payload"
    );
}

#[test]
fn archived_lookup_refuses_uncertain_or_redirected_history() {
    let temp = Temp::new();
    let target = target(&temp);
    let root = transaction(&target, 1, Phase::StartupAcknowledged);
    transaction(&target, 100, Phase::StartupAcknowledged);
    let (fresh, _lock) = new_stage(&target, &trust(), &FixturePlatform).unwrap();
    let archived = transaction_path(&root).unwrap();
    fs::write(archived.join("journal.pending"), b"uncertain").unwrap();
    assert_eq!(transaction_path(&root), Err(Error::RecoveryRequired));
    assert_eq!(recovery_phase(&archived), Err(Error::RecoveryRequired));
    fs::remove_file(archived.join("journal.pending")).unwrap();
    let history = archived.parent().unwrap();
    let other = temp.path().join("redirected-history");
    fs::rename(history, &other).unwrap();
    std::os::unix::fs::symlink(&other, history).unwrap();
    assert_eq!(transaction_path(&root), Err(Error::Filesystem));
    assert!(fresh.exists());
}
