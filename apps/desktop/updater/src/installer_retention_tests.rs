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

#[cfg(not(all(target_os = "macos", feature = "native-macos")))]
#[test]
fn recovery_reconciles_unswapped_commit_without_install_or_replay() {
    let temp = Temp::new();
    let target = target(&temp);
    let root = transaction(&target, 1, Phase::Committed);
    let original = fs::metadata(&target).unwrap();
    let mut journal = read_journal(&root).unwrap();
    journal.original_device = original.dev();
    journal.original_inode = original.ino();
    write_journal(&root, &journal).unwrap();
    let archive = fs::read(root.join("archive.zip")).unwrap();
    let held = lock_target(&target).unwrap();
    assert_eq!(
        reconcile_recovery(&target, &trust(), &FixturePlatform).unwrap(),
        vec![(root.clone(), Phase::Committed)],
        "a live installer must not be settled"
    );
    drop(held);
    assert!(
        reconcile_recovery(&target, &trust(), &FixturePlatform)
            .unwrap()
            .is_empty()
    );
    assert_eq!(recovery_phase(&root).unwrap(), Phase::Aborted);
    assert_eq!(fs::read(root.join("archive.zip")).unwrap(), archive);
    assert!(
        reconcile_recovery(&target, &trust(), &FixturePlatform)
            .unwrap()
            .is_empty()
    );
    transaction(&target, 100, Phase::StartupAcknowledged);
    let (fresh, _lock) = new_stage(&target, &trust(), &FixturePlatform).unwrap();
    assert!(fresh.exists());
    assert_eq!(
        recovery_phase(&root).unwrap(),
        Phase::Aborted,
        "retained aborted evidence resolves from history"
    );
}

#[test]
fn recovery_never_settles_changed_target_or_pending_journal() {
    for phase in [Phase::Committed, Phase::Swapped, Phase::RelaunchRequested] {
        let temp = Temp::new();
        let target = target(&temp);
        let root = transaction(&target, 1, phase);
        let before = fs::read(root.join("journal.json")).unwrap();
        assert_eq!(
            reconcile_recovery(&target, &trust(), &FixturePlatform).unwrap(),
            vec![(root.clone(), phase)]
        );
        assert_eq!(fs::read(root.join("journal.json")).unwrap(), before);
        fs::write(root.join("journal.pending"), b"unconfirmed write").unwrap();
        assert!(reconcile_recovery(&target, &trust(), &FixturePlatform).is_err());
        assert_eq!(fs::read(root.join("journal.json")).unwrap(), before);
        assert!(root.join("journal.pending").exists());
    }
}

#[test]
fn recovery_startup_discovery_requires_one_exact_signed_running_payload() {
    let temp = Temp::new();
    let target = target(&temp);
    let old = transaction(&target, 1, Phase::RelaunchRequested);
    assert_eq!(
        startup_receipt(&target, &trust(), &FixturePlatform).unwrap(),
        None
    );
    let current = transaction(&target, 100, Phase::RelaunchRequested);
    assert_eq!(
        startup_receipt(&target, &trust(), &FixturePlatform).unwrap(),
        Some(current.clone())
    );
    assert_eq!(
        recovery_phase(&current).unwrap(),
        Phase::RelaunchRequested,
        "discovery never fabricates an ACK"
    );
    fs::write(current.join("journal.pending"), b"interrupted ACK").unwrap();
    assert!(startup_receipt(&target, &trust(), &FixturePlatform).is_err());
    assert_eq!(recovery_phase(&old).unwrap(), Phase::RelaunchRequested);
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

#[cfg(not(all(target_os = "macos", feature = "native-macos")))]
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
    ] {
        let temp = Temp::new();
        let target = target(&temp);
        let current = transaction(&target, 100, Phase::StartupAcknowledged);
        let _held =
            File::open(rollback_bundle(&current, &trust()).join("rollback-resource")).unwrap();
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

#[cfg(not(all(target_os = "macos", feature = "native-macos")))]
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

#[cfg(not(all(target_os = "macos", feature = "native-macos")))]
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

#[cfg(all(target_os = "macos", feature = "native-macos"))]
#[test]
fn repeated_gui_updates_preserve_busy_rollback_until_verified_daemon_handoff() {
    let temp = Temp::new();
    let target = target(&temp);
    for id in 1..=8 {
        let (stage, lock) = new_stage(&target, &trust(), &FixturePlatform).unwrap();
        discard_incomplete(&stage, &target).unwrap();
        let root = transaction(&target, id, Phase::StartupAcknowledged);
        drop(lock);
        let held = File::open(rollback_bundle(&root, &trust()).join("rollback-resource")).unwrap();
        let (next, next_lock) =
            new_stage_checked(&target, &trust(), &FixturePlatform, &|_, _| false).unwrap();
        assert!(
            root.join("install-payload/Pilot Next.app/rollback-resource")
                .exists()
        );
        discard_incomplete(&next, &target).unwrap();
        drop(next_lock);
        drop(held);
        assert_eq!(
            cleanup::cleanup_with(&target, &trust(), &FixturePlatform).unwrap(),
            1
        );
        assert!(!root.exists());
        assert!(!target.parent().unwrap().join(HISTORY).exists());
        assert!(
            target
                .parent()
                .unwrap()
                .join(".pilot-next-updater.lock")
                .exists()
        );
    }
}

#[cfg(all(target_os = "macos", feature = "native-macos"))]
#[test]
fn daemon_handoff_cleanup_preserves_interrupted_update_without_replay() {
    for phase in [
        Phase::Ready,
        Phase::Committed,
        Phase::Swapped,
        Phase::RelaunchRequested,
    ] {
        let temp = Temp::new();
        let target = target(&temp);
        let root = transaction(&target, 1, phase);
        let before = fs::read(root.join("journal.json")).unwrap();
        assert_eq!(
            cleanup::cleanup_with(&target, &trust(), &FixturePlatform).unwrap(),
            0
        );
        assert_eq!(recovery_phase(&root).unwrap(), phase);
        assert_eq!(fs::read(root.join("journal.json")).unwrap(), before);
        assert!(matches!(
            new_stage(&target, &trust(), &FixturePlatform),
            Err(Error::StagingCapacity)
        ));
    }
}

#[cfg(all(target_os = "macos", feature = "native-macos"))]
#[test]
fn legacy_terminal_history_requires_original_completion_proof() {
    let temp = Temp::new();
    let target = target(&temp);
    let root = transaction(&target, 1, Phase::StartupAcknowledged);
    let history = target.parent().unwrap().join(HISTORY);
    fs::DirBuilder::new().mode(0o700).create(&history).unwrap();
    let archived = history.join(root.file_name().unwrap());
    archive_move(&root, &archived, sync_directory).unwrap();
    fs::write(archived.join("journal.pending"), b"interrupted").unwrap();
    assert_eq!(
        cleanup::cleanup_with(&target, &trust(), &FixturePlatform).unwrap(),
        0
    );
    assert!(archived.exists());
    fs::remove_file(archived.join("journal.pending")).unwrap();
    assert_eq!(
        cleanup::cleanup_with(&target, &trust(), &FixturePlatform).unwrap(),
        1
    );
    assert!(!history.exists());
}

#[cfg(all(target_os = "macos", feature = "native-macos"))]
#[test]
fn daemon_handoff_cleanup_requires_complete_terminal_evidence_and_idle_writers() {
    for fault in 0..4 {
        let temp = Temp::new();
        let target = target(&temp);
        let root = transaction(&target, 100, Phase::StartupAcknowledged);
        let mut guard = None;
        match fault {
            0 => fs::write(root.join("journal.pending"), b"interrupted ACK").unwrap(),
            1 => {
                fs::rename(
                    root.join("install-payload/Pilot Next.app"),
                    root.join("other-old"),
                )
                .unwrap();
                fs::create_dir(root.join("install-payload/Pilot Next.app")).unwrap();
            }
            2 => guard = Some(journal_guard(&root).unwrap()),
            _ => guard = Some(lock_target(&target).unwrap()),
        }
        let result = cleanup::cleanup_with(&target, &trust(), &FixturePlatform);
        if fault == 3 {
            assert_eq!(result, Err(Error::Busy));
        } else {
            assert_eq!(result.unwrap(), 0);
        }
        assert!(
            root.join("journal.json").exists(),
            "fault {fault} must retain evidence"
        );
        drop(guard);
    }
}

#[cfg(all(target_os = "macos", feature = "native-macos"))]
#[test]
fn legacy_cleanup_unblocks_the_single_stage() {
    let temp = Temp::new();
    let target = target(&temp);
    let mut roots = Vec::new();
    for id in 1..=3 {
        roots.push(transaction(&target, id, Phase::StartupAcknowledged));
    }
    let history = target.parent().unwrap().join(HISTORY);
    fs::DirBuilder::new().mode(0o700).create(&history).unwrap();
    for id in 4..=6 {
        let root = transaction(&target, id, Phase::StartupAcknowledged);
        let archived = history.join(root.file_name().unwrap());
        archive_move(&root, &archived, sync_directory).unwrap();
        roots.push(archived);
    }
    assert_eq!(
        cleanup::cleanup_with(&target, &trust(), &FixturePlatform).unwrap(),
        6
    );
    assert!(roots.iter().all(|root| !root.exists()));
    assert!(!history.exists());
    let (stage, _lock) = new_stage(&target, &trust(), &FixturePlatform).unwrap();
    assert!(stage.exists());
}

#[cfg(all(target_os = "macos", feature = "native-macos"))]
#[test]
fn obsolete_missing_or_corrupt_payloads_do_not_block_future_updates() {
    for fault in 0..4 {
        let temp = Temp::new();
        let target = target(&temp);
        let root = transaction(&target, 100, Phase::StartupAcknowledged);
        match fault {
            0 => fs::remove_file(root.join("archive.zip")).unwrap(),
            1 => fs::write(root.join("archive.zip"), b"corrupt obsolete archive").unwrap(),
            2 => fs::remove_dir_all(root.join("install-payload/Pilot Next.app")).unwrap(),
            _ => fs::write(
                root.join("install-payload/Pilot Next.app/rollback-resource"),
                b"corrupt obsolete resource",
            )
            .unwrap(),
        }
        assert_eq!(
            cleanup::cleanup_with(&target, &trust(), &FixturePlatform).unwrap(),
            1
        );
        assert!(!root.exists());
        let (stage, _lock) = new_stage(&target, &trust(), &FixturePlatform).unwrap();
        assert!(stage.exists());
    }
}

#[cfg(all(target_os = "macos", feature = "native-macos"))]
#[test]
fn terminal_cleanup_preserves_rollback_in_use_or_uncertain_across_profiles() {
    for phase in [Phase::StartupAcknowledged, Phase::Aborted] {
        let temp = Temp::new();
        let target = target(&temp);
        let root = transaction(&target, 100, phase);
        let rollback = rollback_bundle(&root, &trust());
        let held = File::open(rollback.join("rollback-resource")).unwrap();
        assert_eq!(
            cleanup::cleanup_checked(&target, &trust(), &FixturePlatform, &cleanup::native_unused)
                .unwrap(),
            0
        );
        assert!(rollback.join("rollback-resource").exists());
        drop(held);
        assert_eq!(
            cleanup::cleanup_checked(&target, &trust(), &FixturePlatform, &|_, _| false).unwrap(),
            0,
            "uncertain census must preserve terminal rollback"
        );
        assert_eq!(
            cleanup::cleanup_with(&target, &trust(), &FixturePlatform).unwrap(),
            1
        );
        assert!(!root.exists());
    }
}

#[cfg(all(target_os = "macos", feature = "native-macos"))]
#[test]
fn missing_rollback_does_not_require_a_native_process_probe() {
    let temp = Temp::new();
    let target = target(&temp);
    let root = transaction(&target, 100, Phase::StartupAcknowledged);
    fs::remove_dir_all(rollback_bundle(&root, &trust())).unwrap();
    assert_eq!(
        cleanup::cleanup_checked(&target, &trust(), &FixturePlatform, &|_, _| {
            panic!("missing rollback must not scan processes")
        })
        .unwrap(),
        1
    );
}

#[cfg(all(target_os = "macos", feature = "native-macos"))]
#[test]
fn staging_retries_terminal_cleanup_after_a_busy_startup_without_polling() {
    let temp = Temp::new();
    let target = target(&temp);
    let root = transaction(&target, 100, Phase::StartupAcknowledged);
    let lock = lock_target(&target).unwrap();
    assert_eq!(
        cleanup::cleanup_with(&target, &trust(), &FixturePlatform),
        Err(Error::Busy)
    );
    drop(lock);
    let (deferred, lock) =
        new_stage_checked(&target, &trust(), &FixturePlatform, &|_, _| false).unwrap();
    assert!(root.exists());
    discard_incomplete(&deferred, &target).unwrap();
    drop(lock);
    let (stage, _lock) =
        new_stage_checked(&target, &trust(), &FixturePlatform, &|_, _| true).unwrap();
    assert!(!root.exists());
    assert!(stage.exists());
}

#[cfg(all(target_os = "macos", feature = "native-macos"))]
#[test]
fn staging_preserves_terminal_paths_and_bytes_when_no_use_is_uncertain() {
    let temp = Temp::new();
    let target = target(&temp);
    let roots = [
        transaction(&target, 1, Phase::StartupAcknowledged),
        transaction(&target, 2, Phase::Aborted),
    ];
    let files = [
        "journal.json",
        "manifest.json",
        "archive.zip",
        "ui-state.json",
        "install-payload/Pilot Next.app/rollback-resource",
    ];
    let snapshots: Vec<_> = roots
        .iter()
        .map(|root| {
            let rollback = fs::metadata(rollback_bundle(root, &trust())).unwrap();
            let bytes: Vec<_> = files
                .iter()
                .map(|file| fs::read(root.join(file)).unwrap())
                .collect();
            (rollback.dev(), rollback.ino(), bytes)
        })
        .collect();
    let (stage, _lock) =
        new_stage_checked(&target, &trust(), &FixturePlatform, &|_, _| false).unwrap();
    assert!(stage.exists());
    assert!(!target.parent().unwrap().join(HISTORY).exists());
    for (root, (device, inode, bytes)) in roots.iter().zip(snapshots) {
        assert_eq!(transaction_path(root).unwrap(), *root);
        let rollback = fs::metadata(rollback_bundle(root, &trust())).unwrap();
        assert_eq!((rollback.dev(), rollback.ino()), (device, inode));
        for (file, before) in files.iter().zip(bytes) {
            assert_eq!(
                fs::read(root.join(file)).unwrap(),
                before,
                "retained {file}"
            );
        }
    }
}

#[cfg(all(target_os = "macos", feature = "native-macos"))]
#[test]
fn staging_capacity_counts_retained_terminal_transactions_including_new_stage() {
    for count in [3, 4] {
        let temp = Temp::new();
        let target = target(&temp);
        let roots: Vec<_> = (1..=count)
            .map(|id| transaction(&target, id, Phase::StartupAcknowledged))
            .collect();
        let result = new_stage_checked(&target, &trust(), &FixturePlatform, &|_, _| false);
        if count == 3 {
            let (stage, _lock) = result.expect("three retained transactions permit a fourth");
            assert!(stage.exists());
        } else {
            assert!(matches!(result, Err(Error::StagingCapacity)));
        }
        assert!(roots.iter().all(|root| root.exists()));
        assert!(!target.parent().unwrap().join(HISTORY).exists());
    }
}

#[cfg(all(target_os = "macos", feature = "native-macos"))]
#[test]
fn staging_capacity_refuses_unfinished_or_unproven_transactions() {
    for phase in [
        Phase::Ready,
        Phase::Committed,
        Phase::Swapped,
        Phase::RelaunchRequested,
    ] {
        let temp = Temp::new();
        let target = target(&temp);
        let root = transaction(&target, 1, phase);
        let before = fs::read(root.join("journal.json")).unwrap();
        assert!(
            matches!(
                new_stage_checked(&target, &trust(), &FixturePlatform, &|_, _| false),
                Err(Error::StagingCapacity)
            ),
            "unfinished {phase:?} must block staging"
        );
        assert_eq!(fs::read(root.join("journal.json")).unwrap(), before);
    }
    for fault in [
        "pending",
        "manifest",
        "journal-lock",
        "inode",
        "future",
        "unknown",
        "symlink",
    ] {
        let temp = Temp::new();
        let target = target(&temp);
        let root = transaction(&target, 1, Phase::StartupAcknowledged);
        let mut guard = None;
        match fault {
            "pending" => fs::write(root.join("journal.pending"), b"uncertain ACK").unwrap(),
            "manifest" => fs::write(root.join("manifest.json"), b"invalid signature").unwrap(),
            "journal-lock" => guard = Some(journal_guard(&root).unwrap()),
            "inode" => {
                let rollback = rollback_bundle(&root, &trust());
                fs::rename(&rollback, root.join("other-old")).unwrap();
                fs::create_dir(&rollback).unwrap();
            }
            "future" => {
                let bytes = archive();
                let mut manifest = metadata(&bytes);
                manifest.build = "999.1".into();
                fs::write(root.join("manifest.json"), envelope(&manifest)).unwrap();
            }
            "unknown" => {
                fs::create_dir(target.parent().unwrap().join(".pilot-next-update-unknown"))
                    .unwrap();
            }
            "symlink" => {
                let moved = temp.path().join("redirected-transaction");
                fs::rename(&root, &moved).unwrap();
                std::os::unix::fs::symlink(&moved, &root).unwrap();
            }
            _ => unreachable!(),
        }
        let before = fs::read(root.join("journal.json")).unwrap();
        assert!(
            matches!(
                new_stage_checked(&target, &trust(), &FixturePlatform, &|_, _| false),
                Err(Error::StagingCapacity)
            ),
            "{fault} must block staging"
        );
        assert_eq!(
            fs::read(root.join("journal.json")).unwrap(),
            before,
            "{fault}"
        );
        assert!(root.exists(), "{fault} must retain its original path");
        drop(guard);
    }
}

#[cfg(all(target_os = "macos", feature = "native-macos"))]
#[test]
fn unsafe_legacy_history_is_preserved_without_blocking_fresh_staging() {
    let temp = Temp::new();
    let target = target(&temp);
    let history = temp.path().join(HISTORY);
    fs::write(&history, b"unrecognized history evidence").unwrap();
    let (stage, _lock) = new_stage(&target, &trust(), &FixturePlatform).unwrap();
    assert!(stage.exists());
    assert_eq!(fs::read(history).unwrap(), b"unrecognized history evidence");
}
