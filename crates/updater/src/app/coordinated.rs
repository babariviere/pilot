//! Proposal-only continuation. Ordinary GUI updates never create this evidence.
#[cfg(all(target_os = "macos", feature = "native-macos"))]
use crate::installer::Platform;
use crate::{Error, installer, iteration::ExpectedTarget, manifest::Trust};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
#[cfg(all(target_os = "macos", feature = "native-macos"))]
use std::{
    sync::atomic::AtomicBool,
    time::{Duration, Instant},
};

#[cfg(all(target_os = "macos", feature = "native-macos"))]
const FILE: &str = "coordinated-update.json";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Target {
    pub source: String,
    pub gui_build: String,
    pub build: Value,
    pub runtime_root: PathBuf,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Receipt {
    schema: u32,
    pub id: String,
    pub target: Target,
    transaction: PathBuf,
    installed: PathBuf,
    configuration: String,
}
impl Receipt {
    pub fn transaction(&self) -> &Path {
        &self.transaction
    }
}

/// Passive, coordinated-only recovery after a lost launch argument or GUI crash.
/// Ordinary installer recovery/ACK discovery is deliberately unchanged.
#[cfg(all(target_os = "macos", feature = "native-macos"))]
pub fn discover(installed: &Path, trust: &Trust, id: &str) -> Result<Option<PathBuf>, Error> {
    discover_checked(installed, id, |transaction| {
        startup(transaction, installed, trust)
    })
}

#[cfg(all(target_os = "macos", feature = "native-macos"))]
fn discover_checked(
    installed: &Path,
    id: &str,
    verify: impl Fn(&Path) -> Result<Option<Receipt>, Error>,
) -> Result<Option<PathBuf>, Error> {
    let parent = installed.parent().ok_or(Error::Identity)?;
    let mut count = 0;
    let mut found = None;
    for directory in [parent.to_path_buf(), parent.join(installer::HISTORY)] {
        let entries = match std::fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return Err(Error::Filesystem),
        };
        for entry in entries {
            count += 1;
            if count > 4096 {
                return Err(Error::RecoveryRequired);
            }
            let root = entry.map_err(|_| Error::Filesystem)?.path();
            let recognized = root
                .file_name()
                .and_then(|v| v.to_str())
                .is_some_and(|name| {
                    name.strip_prefix(".pilot-next-update-")
                        .is_some_and(|suffix| {
                            suffix.len() == 32 && suffix.bytes().all(|b| b.is_ascii_hexdigit())
                        })
                });
            if !recognized
                || !root
                    .join(FILE)
                    .try_exists()
                    .map_err(|_| Error::Filesystem)?
            {
                continue;
            }
            installer::validate_root(&root, installed)?;
            if root.canonicalize().map_err(|_| Error::Filesystem)? != root {
                return Err(Error::Identity);
            }
            let receipt: Receipt =
                serde_json::from_value(crate::coordination::private_json(&root.join(FILE), 16384)?)
                    .map_err(|_| Error::Identity)?;
            if receipt.id != id {
                continue;
            }
            if installer::transaction_path(&receipt.transaction)? != root {
                return Err(Error::Identity);
            }
            if installer::recovery_phase(&root)? != installer::Phase::StartupAcknowledged {
                continue;
            }
            let verified = verify(&receipt.transaction)?.ok_or(Error::Identity)?;
            if verified.id != id || found.replace(receipt.transaction).is_some() {
                return Err(Error::RecoveryRequired);
            }
        }
    }
    Ok(found)
}

pub(crate) fn prepare(
    stage: &installer::Staged,
    id: String,
    expected: &ExpectedTarget,
    trust: &Trust,
) -> Result<Receipt, Error> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
    {
        return Err(Error::Identity);
    }
    expected.verify(stage.verified.manifest())?;
    #[cfg(all(target_os = "macos", feature = "native-macos"))]
    {
        let preview = installer::preview_bundle(&stage.root, trust)?;
        let mut candidate_trust = trust.clone();
        // Only the expected native build changes; the compiled publisher/key/policy do not.
        candidate_trust.current_build = expected.build().into();
        let store = PathBuf::from(std::env::var_os("HOME").ok_or(Error::Filesystem)?)
            .join("Library/Application Support")
            .join(crate::runtime::SERVICE_STORE_NAME);
        let capsule = crate::runtime::publish_service(
            &preview,
            &store,
            &candidate_trust,
            &installer::NativePlatform,
            Instant::now() + Duration::from_secs(45),
            &AtomicBool::new(false),
        )?;
        installer::NativePlatform.verify_candidate(&capsule, trust, stage.verified.manifest())?;
        let build: Value = serde_json::from_slice(&crate::iteration::read(
            &capsule
                .join(crate::layout::RUNTIME)
                .join("runtime-build.json"),
            16384,
        )?)
        .map_err(|_| Error::Identity)?;
        if build["source"] != expected.source() {
            return Err(Error::Identity);
        }
        let receipt = Receipt {
            schema: 1,
            id,
            target: Target {
                source: expected.source().into(),
                gui_build: expected.build().into(),
                build,
                runtime_root: capsule.join(crate::layout::RUNTIME),
            },
            transaction: stage.root.clone(),
            installed: stage.target.clone(),
            configuration: crate::coordination::configuration(trust),
        };
        installer::write_new(
            &stage.root.join(FILE),
            &serde_json::to_vec(&receipt).map_err(|_| Error::Identity)?,
        )?;
        std::fs::File::open(&stage.root)
            .and_then(|f| f.sync_all())
            .map_err(|_| Error::Filesystem)?;
        Ok(receipt)
    }
    #[cfg(not(all(target_os = "macos", feature = "native-macos")))]
    {
        let _ = (stage, id, expected, trust);
        Err(Error::Unconfigured)
    }
}

/// Reads only existing evidence; never swaps, launches, publishes or acknowledges.
pub fn startup(
    transaction: &Path,
    installed: &Path,
    trust: &Trust,
) -> Result<Option<Receipt>, Error> {
    #[cfg(all(target_os = "macos", feature = "native-macos"))]
    {
        startup_checked(
            transaction,
            installed,
            trust,
            &installer::NativePlatform,
            |receipt, manifest| {
                verify_capsule(
                    receipt,
                    installed,
                    trust,
                    manifest,
                    &installer::NativePlatform,
                    &PathBuf::from(std::env::var_os("HOME").ok_or(Error::Filesystem)?)
                        .join("Library/Application Support")
                        .join(crate::runtime::SERVICE_STORE_NAME),
                )
            },
        )
    }
    #[cfg(not(all(target_os = "macos", feature = "native-macos")))]
    {
        let _ = (transaction, installed, trust);
        Err(Error::Unconfigured)
    }
}

#[cfg(all(target_os = "macos", feature = "native-macos"))]
fn startup_checked(
    transaction: &Path,
    installed: &Path,
    trust: &Trust,
    platform: &impl Platform,
    check_capsule: impl FnOnce(&Receipt, &crate::manifest::Manifest) -> Result<(), Error>,
) -> Result<Option<Receipt>, Error> {
    let located = installer::transaction_path(transaction)?;
    if !located
        .join(FILE)
        .try_exists()
        .map_err(|_| Error::Filesystem)?
    {
        return Ok(None);
    }
    installer::validate_root(&located, installed)?;
    let receipt: Receipt = serde_json::from_value(crate::coordination::private_json(
        &located.join(FILE),
        16384,
    )?)
    .map_err(|_| Error::Identity)?;
    if receipt.schema != 1
        || receipt.transaction != transaction
        || receipt.installed != installed
        || receipt.configuration != crate::coordination::configuration(trust)
        || !matches!(
            installer::recovery_phase(&located)?,
            installer::Phase::Swapped
                | installer::Phase::RelaunchRequested
                | installer::Phase::StartupAcknowledged
        )
    {
        return Err(Error::Identity);
    }
    let manifest = installer::signed_manifest(&located, trust)?;
    ExpectedTarget::new(
        receipt.target.source.clone(),
        receipt.target.gui_build.clone(),
    )?
    .verify(manifest.manifest())?;
    if receipt.target.gui_build != trust.current_build {
        return Err(Error::Version);
    }
    platform.verify_candidate(installed, trust, manifest.manifest())?;
    check_capsule(&receipt, manifest.manifest())?;
    Ok(Some(receipt))
}

#[cfg(all(target_os = "macos", feature = "native-macos"))]
fn verify_capsule(
    receipt: &Receipt,
    installed: &Path,
    trust: &Trust,
    manifest: &crate::manifest::Manifest,
    platform: &impl Platform,
    store: &Path,
) -> Result<(), Error> {
    #[cfg(all(target_os = "macos", feature = "native-macos"))]
    {
        let capsule = receipt
            .target
            .runtime_root
            .ancestors()
            .nth(3)
            .ok_or(Error::Identity)?;
        if capsule.parent().and_then(Path::parent) != Some(store)
            || capsule.canonicalize().map_err(|_| Error::Filesystem)? != capsule
        {
            return Err(Error::Identity);
        }
        platform.verify_candidate(capsule, trust, manifest)?;
        let stamp: Value = serde_json::from_slice(&crate::iteration::read(
            &receipt.target.runtime_root.join("runtime-build.json"),
            16384,
        )?)
        .map_err(|_| Error::Identity)?;
        if stamp != receipt.target.build || stamp["source"] != receipt.target.source {
            return Err(Error::Identity);
        }
        if crate::runtime::identity(capsule)? != crate::runtime::identity(installed)? {
            return Err(Error::Identity);
        }
    }
    Ok(())
}

#[cfg(all(test, target_os = "macos", feature = "native-macos"))]
mod tests {
    use super::*;
    use crate::owned_tests;
    use serde_json::json;
    use std::{fs, os::unix::fs::PermissionsExt};
    struct FixturePlatform;
    impl Platform for FixturePlatform {
        fn verify(
            &self,
            root: &Path,
            trust: &Trust,
            build: &str,
            _: Option<&str>,
        ) -> Result<(), Error> {
            if fs::read_to_string(root.join("Contents/build"))
                .ok()
                .as_deref()
                == Some(build)
                && fs::read_to_string(root.join("Contents/id")).ok().as_deref()
                    == Some(trust.application_id.as_str())
            {
                Ok(())
            } else {
                Err(Error::Signature)
            }
        }
        fn swap(&self, _: &fs::File, _: &Path, _: &Path) -> Result<(), Error> {
            panic!("read-only continuation must never swap")
        }
        fn relaunch(&self, _: &Path, _: &Path) -> Result<(), Error> {
            panic!("read-only continuation must never relaunch")
        }
    }
    struct Fixture {
        _temp: owned_tests::Temp,
        installed: PathBuf,
        transaction: PathBuf,
        store: PathBuf,
        trust: Trust,
        receipt: Receipt,
    }
    impl Fixture {
        fn new() -> Self {
            let temp = owned_tests::Temp::new();
            let installed = temp.path().join("Pilot Next.app");
            let transaction = temp
                .path()
                .join(format!(".pilot-next-update-{}", "a".repeat(32)));
            fs::create_dir(&transaction).unwrap();
            fs::set_permissions(&transaction, fs::Permissions::from_mode(0o700)).unwrap();
            let store = temp.path().join(crate::runtime::SERVICE_STORE_NAME);
            let capsule = store.join("b".repeat(64)).join("Pilot Next.app");
            let mut trust = owned_tests::trust();
            trust.current_build = "101.1".into();
            let build = json!({"schema":1,"source":"a".repeat(40),"version":"0.1.1","protocol":1,"platform":"darwin","arch":"arm64","node":"24.1.0"});
            for root in [&installed, &capsule] {
                fs::create_dir_all(root.join(crate::layout::RUNTIME)).unwrap();
                fs::write(root.join("Contents/build"), "101.1").unwrap();
                fs::write(root.join("Contents/id"), &trust.application_id).unwrap();
                for name in [
                    "rust-inputs.json",
                    "native-inputs.json",
                    "updater-inputs.json",
                ] {
                    fs::write(
                        root.join("Contents/Resources").join(name),
                        json!({"source":"a".repeat(40)}).to_string(),
                    )
                    .unwrap();
                }
                fs::write(
                    root.join("Contents/Resources/bundled-runtime.json"),
                    json!({"build":build}).to_string(),
                )
                .unwrap();
                fs::write(
                    root.join(crate::layout::RUNTIME).join("runtime-build.json"),
                    build.to_string(),
                )
                .unwrap();
            }
            let mut manifest = owned_tests::metadata(b"synthetic signed archive");
            manifest.source = Some("a".repeat(40));
            installer::write_new(
                &transaction.join("manifest.json"),
                &owned_tests::envelope(&manifest),
            )
            .unwrap();
            installer::write_new(&transaction.join("journal.json"),json!({"schema":1,"phase":"RelaunchRequested","original_device":1,"original_inode":1}).to_string().as_bytes()).unwrap();
            let receipt = Receipt {
                schema: 1,
                id: "proposal".into(),
                target: Target {
                    source: "a".repeat(40),
                    gui_build: "101.1".into(),
                    build,
                    runtime_root: capsule.join(crate::layout::RUNTIME),
                },
                transaction: transaction.clone(),
                installed: installed.clone(),
                configuration: crate::coordination::configuration(&trust),
            };
            installer::write_new(
                &transaction.join(FILE),
                &serde_json::to_vec(&receipt).unwrap(),
            )
            .unwrap();
            Self {
                _temp: temp,
                installed,
                transaction,
                store,
                trust,
                receipt,
            }
        }
        fn inspect(&self) -> Result<Option<Receipt>, Error> {
            startup_checked(
                &self.transaction,
                &self.installed,
                &self.trust,
                &FixturePlatform,
                |receipt, manifest| {
                    verify_capsule(
                        receipt,
                        &self.installed,
                        &self.trust,
                        manifest,
                        &FixturePlatform,
                        &self.store,
                    )
                },
            )
        }
    }
    #[test]
    fn coordinated_continuation_verifies_exact_receipt_without_replay_or_ack() {
        let f = Fixture::new();
        let before = fs::read(f.transaction.join("journal.json")).unwrap();
        assert_eq!(f.inspect().unwrap().unwrap().target, f.receipt.target);
        assert_eq!(
            fs::read(f.transaction.join("journal.json")).unwrap(),
            before
        );
        assert_eq!(
            installer::recovery_phase(&f.transaction),
            Ok(installer::Phase::RelaunchRequested)
        );
    }
    #[test]
    fn coordinated_continuation_refuses_wrong_runtime_stamp_and_old_gui() {
        let mut f = Fixture::new();
        f.trust.current_build = "100.1".into();
        assert!(matches!(f.inspect(), Err(Error::Version)));
        f.trust.current_build = "101.1".into();
        fs::write(
            f.receipt.target.runtime_root.join("runtime-build.json"),
            json!({"source":"b".repeat(40)}).to_string(),
        )
        .unwrap();
        assert!(matches!(f.inspect(), Err(Error::Identity)));
    }
    #[test]
    fn coordinated_unknown_phase_and_interrupted_journal_never_replay() {
        let f = Fixture::new();
        fs::write(
            f.transaction.join("journal.json"),
            json!({"schema":1,"phase":"Committed","original_device":1,"original_inode":1})
                .to_string(),
        )
        .unwrap();
        assert!(matches!(f.inspect(), Err(Error::Identity)));
        installer::write_new(&f.transaction.join("journal.pending"), b"unknown").unwrap();
        assert!(matches!(f.inspect(), Err(Error::RecoveryRequired)));
        assert!(f.transaction.join("journal.pending").exists());
    }
    #[test]
    fn coordinated_acknowledged_discovery_survives_manual_launch_and_archive() {
        let f = Fixture::new();
        fs::write(f.transaction.join("journal.json"),json!({"schema":1,"phase":"StartupAcknowledged","original_device":1,"original_inode":1}).to_string()).unwrap();
        let inspect = |path: &Path| {
            startup_checked(
                path,
                &f.installed,
                &f.trust,
                &FixturePlatform,
                |receipt, manifest| {
                    verify_capsule(
                        receipt,
                        &f.installed,
                        &f.trust,
                        manifest,
                        &FixturePlatform,
                        &f.store,
                    )
                },
            )
        };
        assert_eq!(
            discover_checked(&f.installed, "proposal", inspect).unwrap(),
            Some(f.transaction.clone())
        );
        assert_eq!(
            discover_checked(&f.installed, "another-proposal", inspect).unwrap(),
            None
        );
        let history = f.installed.parent().unwrap().join(installer::HISTORY);
        fs::create_dir(&history).unwrap();
        fs::set_permissions(&history, fs::Permissions::from_mode(0o700)).unwrap();
        fs::rename(
            &f.transaction,
            history.join(f.transaction.file_name().unwrap()),
        )
        .unwrap();
        assert_eq!(
            discover_checked(&f.installed, "proposal", inspect).unwrap(),
            Some(f.transaction.clone())
        );
        assert!(
            !f.transaction.exists(),
            "discovery never restores or replays an archived transaction"
        );
    }
    #[test]
    fn coordinated_discovery_refuses_duplicate_or_wrong_signed_gui() {
        let mut f = Fixture::new();
        fs::write(f.transaction.join("journal.json"),json!({"schema":1,"phase":"StartupAcknowledged","original_device":1,"original_inode":1}).to_string()).unwrap();
        f.trust.current_build = "100.1".into();
        assert!(discover_checked(&f.installed, "proposal", |_| f.inspect()).is_err());
        f.trust.current_build = "101.1".into();
        let duplicate = f
            .installed
            .parent()
            .unwrap()
            .join(format!(".pilot-next-update-{}", "c".repeat(32)));
        fs::create_dir(&duplicate).unwrap();
        fs::set_permissions(&duplicate, fs::Permissions::from_mode(0o700)).unwrap();
        for name in ["manifest.json", "journal.json"] {
            fs::copy(f.transaction.join(name), duplicate.join(name)).unwrap();
        }
        let mut receipt = f.receipt.clone();
        receipt.transaction = duplicate;
        installer::write_new(
            &receipt.transaction.join(FILE),
            &serde_json::to_vec(&receipt).unwrap(),
        )
        .unwrap();
        assert!(matches!(
            discover_checked(&f.installed, "proposal", |path| startup_checked(
                path,
                &f.installed,
                &f.trust,
                &FixturePlatform,
                |receipt, manifest| verify_capsule(
                    receipt,
                    &f.installed,
                    &f.trust,
                    manifest,
                    &FixturePlatform,
                    &f.store
                )
            )),
            Err(Error::RecoveryRequired)
        ));
    }
}
