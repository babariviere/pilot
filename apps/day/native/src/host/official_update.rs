//! Official tagged NSH app installation after exact native capture and close.
//! No exit hook, app-swap implementation, service manager or VM export lives here.
use super::{Error, journal::Journal, updates::Record, window::SavedWindow};
use crate::macos_host::ClosedWindow;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use nsh_updater::{Available, Config, Download, install::Installation};
use pilot_desktop_updater::{
    archive,
    coordination::{self, GlobalUpdateAction, Location},
    installer::{NativePlatform, Platform},
    manifest::{Build, Manifest, Trust},
    transport::Cancellation,
};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};

const MAX_ARCHIVE: u64 = 1024 * 1024 * 1024;

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct PilotTarget {
    source: String,
    build: String,
}

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn read(path: &Path, limit: u64) -> Result<Vec<u8>, Error> {
    let f = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
        .open(path)
        .map_err(|_| Error::Storage)?;
    let m = f.metadata().map_err(|_| Error::Storage)?;
    if !m.is_file() || m.len() > limit {
        return Err(Error::Invalid);
    }
    let mut bytes = Vec::new();
    f.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| Error::Storage)?;
    if bytes.len() as u64 > limit {
        return Err(Error::Invalid);
    }
    Ok(bytes)
}
fn signed_target(
    config: &Config,
    trust: &Trust,
    manifest: &[u8],
    signature: &[u8],
) -> Result<(Available, PilotTarget), Error> {
    if manifest.len() > 128 * 1024
        || signature.len() > 4096
        || config
            .public_key
            .as_ref()
            .and_then(|key| STANDARD.decode(key).ok())
            .as_deref()
            != Some(&trust.public_key)
    {
        return Err(Error::Identity);
    }
    let available = config
        .check(manifest, Some(signature), &nsh_updater::platform())
        .map_err(|_| Error::Identity)?
        .ok_or(Error::Unavailable)?;
    let body: Value = serde_json::from_slice(manifest).map_err(|_| Error::Invalid)?;
    // Signed extension pins exact Pilot source/build, which NSH's semver alone
    // cannot express. It remains inside the official manifest's signed bytes.
    let target: PilotTarget =
        serde_json::from_value(body["pilot"].clone()).map_err(|_| Error::Identity)?;
    if target.source.len() != 40
        || !target
            .source
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        || Build::parse(&target.build).map_err(|_| Error::Identity)?
            <= Build::parse(&trust.current_build).map_err(|_| Error::Identity)?
        || available.sha256.is_none()
        || available.size.is_none_or(|n| n == 0 || n > MAX_ARCHIVE)
    {
        return Err(Error::Identity);
    }
    Ok((available, target))
}

struct Scratch(PathBuf);
impl Scratch {
    fn new() -> Result<Self, Error> {
        let path = std::env::temp_dir().join(format!("nsh-app-update-{}", uuid::Uuid::new_v4()));
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&path)
            .map_err(|_| Error::Storage)?;
        Ok(Self(path))
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn copy_download(input: &Path, output: &Path, available: &Available) -> Result<(), Error> {
    let mut input = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(input)
        .map_err(|_| Error::Storage)?;
    if !input.metadata().map_err(|_| Error::Storage)?.is_file() {
        return Err(Error::Invalid);
    }
    let mut out = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(output)
        .map_err(|_| Error::Storage)?;
    let mut download = Download::new(
        available.sha256.as_deref().ok_or(Error::Identity)?,
        available.size,
    );
    let mut buffer = [0_u8; 64 * 1024];
    let mut total = 0_u64;
    loop {
        let n = input.read(&mut buffer).map_err(|_| Error::Storage)?;
        if n == 0 {
            break;
        }
        total = total.checked_add(n as u64).ok_or(Error::Capacity)?;
        if total > MAX_ARCHIVE {
            return Err(Error::Capacity);
        }
        download.update(&buffer[..n]).map_err(|_| Error::Identity)?;
        out.write_all(&buffer[..n]).map_err(|_| Error::Storage)?;
    }
    download.finish().map_err(|_| Error::Identity)?;
    out.sync_all().map_err(|_| Error::Storage)
}

/// Verified immutable app inputs. Constructed only from the running code-sealed
/// bundle's own updater config, compiled trust, signed NSH manifest and exact
/// archive. This is not a VM class or a runtime/service replacement grant.
pub struct VerifiedApp {
    installation: Installation,
    installed: PathBuf,
    trust: Trust,
    manifest: Manifest,
    journal: PathBuf,
    archive: PathBuf,
    target: Value,
    _scratch: Scratch,
}

/// The exact already-running signed release, checked independently before an
/// upgrade. No production install is admitted without a recoverable old payload.
/// This type is neither deserialized nor exposed to TSX.
pub struct VerifiedRollback {
    installed: PathBuf,
    key: [u8; 32],
    requirement: String,
    manifest: Manifest,
    available: Available,
    archive: PathBuf,
    config: Vec<u8>,
    signed: Vec<u8>,
    signature: Vec<u8>,
    _scratch: Scratch,
}
impl VerifiedRollback {
    /// Worker-only verification of the original immutable NSH release archive.
    /// Its signed version/build/source must equal the actual running app.
    pub fn prepare(
        trust: &Trust,
        manifest: &[u8],
        signature: &[u8],
        archive: &Path,
    ) -> Result<Self, Error> {
        if nsh_platform_macos::objc2::MainThreadMarker::new().is_some() {
            return Err(Error::Invalid);
        }
        trust.validate().map_err(|_| Error::Identity)?;
        let installed =
            pilot_desktop_updater::layout::running_root().map_err(|_| Error::Identity)?;
        NativePlatform
            .verify(&installed, trust, &trust.current_build, None)
            .map_err(|_| Error::Identity)?;
        let config_bytes = read(
            &installed.join("Contents/Resources/nsh/assets/nsh-updater.json"),
            64 * 1024,
        )?;
        let config = Config::parse(&config_bytes).map_err(|_| Error::Identity)?;
        if manifest.len() > 128 * 1024
            || signature.len() > 4096
            || config
                .public_key
                .as_ref()
                .and_then(|key| STANDARD.decode(key).ok())
                .as_deref()
                != Some(&trust.public_key)
        {
            return Err(Error::Identity);
        }
        nsh_updater::verify(
            config.public_key.as_ref().ok_or(Error::Identity)?,
            manifest,
            signature,
        )
        .map_err(|_| Error::Identity)?;
        let released: nsh_updater::Manifest =
            serde_json::from_slice(manifest).map_err(|_| Error::Identity)?;
        let body: Value = serde_json::from_slice(manifest).map_err(|_| Error::Identity)?;
        let pilot: PilotTarget =
            serde_json::from_value(body["pilot"].clone()).map_err(|_| Error::Identity)?;
        if released.id != config.id
            || released.version != config.version
            || pilot.build != trust.current_build
            || pilot.source.len() != 40
            || !pilot
                .source
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        {
            return Err(Error::Identity);
        }
        let asset = released
            .platforms
            .get(&nsh_updater::platform())
            .ok_or(Error::Identity)?;
        let mut available = Available::default();
        available.version = released.version;
        available.sha256.clone_from(&asset.sha256);
        available.size = asset.size;
        if available.sha256.is_none() || available.size.is_none_or(|n| n == 0 || n > MAX_ARCHIVE) {
            return Err(Error::Identity);
        }
        let scratch = Scratch::new()?;
        let copied = scratch.0.join("rollback.zip");
        copy_download(archive, &copied, &available)?;
        let bundle = archive::extract(
            &copied,
            &scratch.0.join("preflight"),
            &trust.bundle_name,
            &Cancellation::default(),
        )
        .map_err(|_| Error::Identity)?;
        let native = Manifest {
            schema: 1,
            source: Some(pilot.source),
            application_id: trust.application_id.clone(),
            channel: trust.channel.clone(),
            platform: "macos".into(),
            architecture: "aarch64".into(),
            build: pilot.build,
            short_version: config.version,
            bundle_name: trust.bundle_name.clone(),
            archive_name: "rollback.zip".into(),
            archive_asset_id: 0,
            archive_size: available.size.ok_or(Error::Identity)?,
            archive_sha256: available.sha256.clone().ok_or(Error::Identity)?,
        };
        NativePlatform
            .verify_candidate(&installed, trust, &native)
            .map_err(|_| Error::Identity)?;
        NativePlatform
            .verify_candidate(&bundle, trust, &native)
            .map_err(|_| Error::Identity)?;
        if read(
            &bundle.join("Contents/Resources/nsh/assets/nsh-updater.json"),
            64 * 1024,
        )? != config_bytes
        {
            return Err(Error::Identity);
        }
        Ok(Self {
            installed,
            key: trust.public_key,
            requirement: trust.code_requirement.clone(),
            manifest: native,
            available,
            archive: copied,
            config: config_bytes,
            signed: manifest.to_vec(),
            signature: signature.to_vec(),
            _scratch: scratch,
        })
    }

    fn persist(&self, journal: &Path, operation: &str) -> Result<PathBuf, Error> {
        let parent = journal.parent().ok_or(Error::Invalid)?;
        let root = parent.join("official-app-backups");
        match fs::DirBuilder::new().mode(0o700).create(&root) {
            Ok(()) => (),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => (),
            Err(_) => return Err(Error::Storage),
        }
        let meta = fs::symlink_metadata(&root).map_err(|_| Error::Storage)?;
        // SAFETY: geteuid has no preconditions.
        let uid = unsafe { libc::geteuid() };
        if !meta.is_dir() || meta.mode() & 0o077 != 0 || meta.uid() != uid {
            return Err(Error::Identity);
        }
        let directory = root.join(operation);
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&directory)
            .map_err(|_| Error::Unknown)?;
        let archive = directory.join("rollback.zip");
        copy_download(&self.archive, &archive, &self.available)?;
        for (name, bytes) in [
            ("latest.json", &self.signed),
            ("latest.json.sig", &self.signature),
            ("nsh-updater.json", &self.config),
        ] {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(directory.join(name))
                .map_err(|_| Error::Storage)?;
            file.write_all(bytes).map_err(|_| Error::Storage)?;
            file.sync_all().map_err(|_| Error::Storage)?;
        }
        for path in [directory.as_path(), root.as_path(), parent] {
            std::fs::File::open(path)
                .and_then(|f| f.sync_all())
                .map_err(|_| Error::Storage)?;
        }
        Ok(archive)
    }
}

impl VerifiedApp {
    /// Native worker-thread preflight. Initial distribution uses ZIP, allowing
    /// reuse of the existing bounded, link-safe archive verifier. NSH performs
    /// the actual install; no local code swaps the app. No global CLI is used.
    pub fn prepare(
        trust: Trust,
        journal: PathBuf,
        manifest: &[u8],
        signature: &[u8],
        archive: &Path,
    ) -> Result<Self, Error> {
        if nsh_platform_macos::objc2::MainThreadMarker::new().is_some() {
            return Err(Error::Invalid);
        }
        trust.validate().map_err(|_| Error::Identity)?;
        if !journal.is_absolute() {
            return Err(Error::Invalid);
        }
        let installed =
            pilot_desktop_updater::layout::running_root().map_err(|_| Error::Identity)?;
        let journal_parent = journal
            .parent()
            .ok_or(Error::Invalid)?
            .canonicalize()
            .map_err(|_| Error::Storage)?;
        if journal_parent.starts_with(&installed) {
            return Err(Error::Identity);
        }
        NativePlatform
            .verify(&installed, &trust, &trust.current_build, None)
            .map_err(|_| Error::Identity)?;
        let config_bytes = read(
            &installed.join("Contents/Resources/nsh/assets/nsh-updater.json"),
            64 * 1024,
        )?;
        let config = Config::parse(&config_bytes).map_err(|_| Error::Identity)?;
        NativePlatform
            .verify(
                &installed,
                &trust,
                &trust.current_build,
                Some(&config.version),
            )
            .map_err(|_| Error::Identity)?;
        let installation =
            Installation::current(&config.id, &config_bytes).ok_or(Error::Unavailable)?;
        let (available, pilot) = signed_target(&config, &trust, manifest, signature)?;
        let scratch = Scratch::new()?;
        let copied = scratch.0.join("verified.zip");
        copy_download(archive, &copied, &available)?;
        let bundle = archive::extract(
            &copied,
            &scratch.0.join("preflight"),
            &trust.bundle_name,
            &Cancellation::default(),
        )
        .map_err(|_| Error::Identity)?;
        let native = Manifest {
            schema: 1,
            source: Some(pilot.source.clone()),
            application_id: trust.application_id.clone(),
            channel: trust.channel.clone(),
            platform: "macos".into(),
            architecture: "aarch64".into(),
            build: pilot.build.clone(),
            short_version: available.version.clone(),
            bundle_name: trust.bundle_name.clone(),
            archive_name: "official-app.zip".into(),
            archive_asset_id: 0,
            archive_size: available.size.ok_or(Error::Identity)?,
            archive_sha256: available.sha256.clone().ok_or(Error::Identity)?,
        };
        NativePlatform
            .verify_candidate(&bundle, &trust, &native)
            .map_err(|_| Error::Identity)?;
        let next = Config::parse(&read(
            &bundle.join("Contents/Resources/nsh/assets/nsh-updater.json"),
            64 * 1024,
        )?)
        .map_err(|_| Error::Identity)?;
        if next.id != config.id
            || next.public_key != config.public_key
            || next.github != config.github
            || next.url != config.url
            || next.version != available.version
        {
            return Err(Error::Identity);
        }
        let target = json!({"source":pilot.source,"build":pilot.build,"version":available.version,
            "sha256":available.sha256,"size":available.size,"configHash":hash(&config_bytes)});
        Ok(Self {
            installation,
            installed,
            trust,
            manifest: native,
            journal,
            archive: copied,
            target,
            _scratch: scratch,
        })
    }

    /// Consumes exact native capture+seal+join+disposal before the first global
    /// pause or install entry. Never call from an NSH quit callback.
    /// The native owner must supply independently qualified process safety for
    /// this exact fresh observation. Empty blockers, root/group exit, a VM
    /// value or a pause ACK cannot implement that verifier. An unqualified
    /// owner must return Unavailable, not enable this entry.
    pub fn install(
        self,
        closed: ClosedWindow,
        rollback: VerifiedRollback,
        operation_id: String,
        verify_processes: impl FnOnce(&Value) -> Result<(), Error>,
    ) -> Result<InstalledApp, Error> {
        if nsh_platform_macos::objc2::MainThreadMarker::new().is_some() {
            return Err(Error::Invalid);
        }
        if rollback.installed != self.installed
            || rollback.key != self.trust.public_key
            || rollback.requirement != self.trust.code_requirement
            || rollback.manifest.build != self.trust.current_build
        {
            return Err(Error::Identity);
        }
        let capture = closed.capture();
        capture.validate()?;
        if !super::valid_id(&operation_id) || uuid::Uuid::parse_str(&operation_id).is_err() {
            return Err(Error::Invalid);
        }
        let mut journal = Journal::open(self.journal.clone())?;
        let key = SavedWindow::key(&capture.source)?;
        if journal.windows.get(&key) != Some(capture)
            || journal.updates.contains_key(&operation_id)
            || journal.updates.values().any(|r| {
                r.source == capture.source && !["done", "stopped"].contains(&r.state.as_str())
            })
        {
            return Err(Error::Unknown);
        }
        // Keep the signed old archive outside the app and OS-temp preflight.
        // NSH removes the old .app after swap; this survives startup failure.
        let backup = rollback.persist(&self.journal, &operation_id)?;
        let payload =
            json!({"captureHash":hash(&serde_json::to_vec(capture).map_err(|_| Error::Storage)?),
            "app":{"source":self.manifest.source,"build":self.manifest.build}})
            .to_string();
        let destination = json!({"hostId":"daemon","daemonId":capture.source.home.daemon_id,"lineageId":capture.source.home.lineage_id});
        let operation = json!({"schemaVersion":1,"operationId":operation_id,"producerId":operation_id,"sequence":1,
            "origin":destination,"destination":destination,"targetId":"global-update","kind":"global-update-prepare",
            "payloadHash":hash(payload.as_bytes()),"payload":payload});
        let root = json!({"officialNsh":self.target,"preparation":operation,
            "rollback":{"archive":backup,"sha256":rollback.manifest.archive_sha256,"size":rollback.manifest.archive_size,
                "source":rollback.manifest.source,"build":rollback.manifest.build,"version":rollback.manifest.short_version,
                "key":self.trust.public_key.to_vec(),"requirement":self.trust.code_requirement}});
        let mut record = Record {
            order: journal.updates.values().map(|r| r.order).max().unwrap_or(0) + 1,
            update_version: 1,
            id: operation_id,
            source: capture.source.clone(),
            root: root.clone(),
            window: capture.window.clone(),
            kind: "app".into(),
            target: self.manifest.build.clone(),
            view: capture.view.clone(),
            auth: hash(&serde_json::to_vec(&root).map_err(|_| Error::Storage)?),
            revision: 1,
            state: "capture".into(),
            flush: Some((capture.generation, capture.save_sequence)),
            message: "Exact native capture and close saved before global preparation.".into(),
            restored: false,
            manifest: Some(json!({"phase":"pause-entered"})),
        };
        journal.save_update(record.clone())?;
        record.state = "entered".into();
        record.revision += 1;
        record.manifest = Some(json!({"phase":"pause-entered"}));
        journal.save_update(record.clone())?;
        let location = Location {
            home: capture.source.profile.clone(),
            port: capture.source.port,
            policy: Default::default(),
        };
        let entered = (|| {
            let receipt =
                coordination::global_update(&location, &operation, GlobalUpdateAction::Prepare)
                    .map_err(|_| Error::Unknown)?;
            exact_receipt(&receipt, &operation)?;
            record.manifest = Some(json!({"phase":"paused","receipt":receipt}));
            record.revision += 1;
            journal.save_update(record.clone())?;
            let fresh =
                coordination::global_update(&location, &operation, GlobalUpdateAction::Verify)
                    .map_err(|_| Error::Unknown)?;
            if fresh["receipt"] != receipt
                || fresh["blockers"].as_array().is_none_or(|b| !b.is_empty())
            {
                return Err(Error::Busy);
            }
            verify_processes(&fresh)?;
            record.manifest = Some(json!({"phase":"install-entered","receipt":receipt}));
            record.revision += 1;
            journal.save_update(record.clone())?;
            // Both are unmodified public NSH APIs. Remember before its swap
            // removes the path std::env::current_exe would otherwise report.
            nsh_core::restart::remember_program();
            self.installation
                .install(&self.archive)
                .map_err(|_| Error::Unknown)?;
            NativePlatform
                .verify_candidate(&self.installed, &self.trust, &self.manifest)
                .map_err(|_| Error::Unknown)?;
            record.manifest = Some(json!({"phase":"installed","receipt":receipt}));
            record.revision += 1;
            record.message =
                "App installed and verified. Startup and selective release are not acknowledged."
                    .into();
            journal.save_update(record.clone())?;
            Ok(())
        })();
        if let Err(error) = entered {
            record.state = "unknown".into();
            record.revision += 1;
            record.message = "Original operation needs lookup. No install, pause or canceled work will be replayed.".into();
            let _ = journal.save_update(record);
            return Err(error);
        }
        Ok(InstalledApp {
            journal,
            record,
            backup,
            rollback,
            inputs: self,
        })
    }
}

fn exact_receipt(receipt: &Value, operation: &Value) -> Result<(), Error> {
    if receipt["state"] != "accepted"
        || ["operationId", "payloadHash", "destination", "targetId"]
            .iter()
            .any(|field| receipt[*field] != operation[*field])
    {
        return Err(Error::Unknown);
    }
    let payload: Value =
        serde_json::from_str(operation["payload"].as_str().ok_or(Error::Identity)?)
            .map_err(|_| Error::Identity)?;
    if receipt["result"]["target"] != payload {
        return Err(Error::Identity);
    }
    Ok(())
}

/// A fresh install result, not a startup receipt or resume grant. It cannot be
/// reconstructed from saved JSON, and scheduling restart consumes it once.
pub struct InstalledApp {
    journal: Journal,
    record: Record,
    backup: PathBuf,
    rollback: VerifiedRollback,
    inputs: VerifiedApp,
}
impl InstalledApp {
    /// Schedules the official NSH restart after this process exits. The native
    /// application owner must then finish its normal exit. No exit-hook saving.
    /// NSH's bounded restart wait is not proof of old-process/daemon exit.
    pub fn restart(mut self) -> Result<(), Error> {
        if nsh_platform_macos::objc2::MainThreadMarker::new().is_some() {
            return Err(Error::Invalid);
        }
        self.record.manifest.as_mut().ok_or(Error::Unknown)?["phase"] = "restart-entered".into();
        self.record.revision += 1;
        self.journal.save_update(self.record.clone())?;
        nsh_core::restart::spawn_after_exit().map_err(|_| Error::Unknown)?;
        self.record.state = "prepared".into();
        self.record.revision += 1;
        self.record.message = "Official NSH restart requested. Successor startup and selective release remain unconfirmed.".into();
        self.journal.save_update(self.record)
    }

    /// Fresh, one-use rollback before this native owner exits, using the same
    /// official installer and verified old archive. Cold recovery is lookup-only,
    /// not authority to reconstruct this handle or replay an uncertain step.
    pub fn rollback_and_restart(mut self) -> Result<(), Error> {
        if nsh_platform_macos::objc2::MainThreadMarker::new().is_some() {
            return Err(Error::Invalid);
        }
        self.record.manifest.as_mut().ok_or(Error::Unknown)?["phase"] = "rollback-entered".into();
        self.record.revision += 1;
        self.journal.save_update(self.record.clone())?;
        self.inputs
            .installation
            .install(&self.backup)
            .map_err(|_| Error::Unknown)?;
        NativePlatform
            .verify_candidate(
                &self.inputs.installed,
                &self.inputs.trust,
                &self.rollback.manifest,
            )
            .map_err(|_| Error::Unknown)?;
        self.record.manifest.as_mut().ok_or(Error::Unknown)?["phase"] =
            "rollback-restart-entered".into();
        self.record.revision += 1;
        self.journal.save_update(self.record.clone())?;
        nsh_core::restart::spawn_after_exit().map_err(|_| Error::Unknown)?;
        self.record.state = "stopped".into();
        self.record.revision += 1;
        self.record.message = "Original signed app restored and official restart requested. Startup and global release remain unconfirmed.".into();
        self.journal.save_update(self.record)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::SigningKey;
    use std::os::unix::fs::PermissionsExt;

    fn signed(body: &Value) -> (Config, Trust, Vec<u8>, String) {
        // Disposable fixture key only, never a production trust configuration.
        let secret = [19_u8; 32];
        let key = SigningKey::from_bytes(&secret).verifying_key().to_bytes();
        let mut config = Config::default();
        config.id = "dev.pilot.day".into();
        config.version = "1.0.0".into();
        config.github = Some("example/app".into());
        config.public_key = Some(STANDARD.encode(key));
        let trust = Trust {
            repository: "example/app".into(),
            application_id: "com.example.next".into(),
            channel: "desktop-stable".into(),
            current_build: "1.0".into(),
            bundle_name: "Pilot Next.app".into(),
            public_key: key,
            code_requirement: "identifier com.example.next".into(),
        };
        let bytes = serde_json::to_vec(body).unwrap();
        let signature = nsh_updater::sign(&STANDARD.encode(secret), &bytes).unwrap();
        (config, trust, bytes, signature)
    }

    fn manifest() -> Value {
        json!({"id":"dev.pilot.day","version":"2.0.0","platforms":{
            nsh_updater::platform():{"url":"https://example.invalid/app.zip","sha256":hash(b"archive"),"size":7}},
            "pilot":{"source":"a".repeat(40),"build":"2.0"}})
    }

    #[test]
    fn official_signed_manifest_also_pins_exact_source_build_and_compiled_key() {
        let (config, trust, bytes, signature) = signed(&manifest());
        let (available, target) =
            signed_target(&config, &trust, &bytes, signature.as_bytes()).unwrap();
        assert_eq!(available.version, "2.0.0");
        assert_eq!(target.source, "a".repeat(40));
        assert_eq!(target.build, "2.0");
        assert!(signed_target(&config, &trust, &bytes, b"not a signature").is_err());
        let mut changed = config.clone();
        changed.public_key = None;
        assert!(
            signed_target(&changed, &trust, &bytes, signature.as_bytes()).is_err(),
            "GitHub's optional unsigned policy is never enough for this app"
        );
        let mut changed = trust.clone();
        changed.public_key = [0; 32];
        assert!(signed_target(&config, &changed, &bytes, signature.as_bytes()).is_err());
        for (field, value) in [
            ("source", json!("A".repeat(40))),
            ("source", json!("short")),
            ("build", json!("1.0")),
            ("extra", json!(true)),
        ] {
            let mut body = manifest();
            body["pilot"][field] = value;
            let (config, trust, bytes, signature) = signed(&body);
            assert!(
                signed_target(&config, &trust, &bytes, signature.as_bytes()).is_err(),
                "{field}"
            );
        }
        for field in ["pilot", "id", "version"] {
            let mut body = manifest();
            body[field] = Value::Null;
            let (config, trust, bytes, signature) = signed(&body);
            assert!(signed_target(&config, &trust, &bytes, signature.as_bytes()).is_err());
        }
    }

    #[test]
    fn official_download_checks_exact_bytes_size_and_no_follow_private_copy() {
        let scratch = Scratch::new().unwrap();
        let input = scratch.0.join("input");
        fs::write(&input, b"archive").unwrap();
        let mut available = Available::default();
        available.sha256 = Some(hash(b"archive"));
        available.size = Some(7);
        copy_download(&input, &scratch.0.join("copied"), &available).unwrap();
        assert_eq!(fs::read(scratch.0.join("copied")).unwrap(), b"archive");
        fs::write(&input, b"changed").unwrap();
        assert!(copy_download(&input, &scratch.0.join("wrong"), &available).is_err());
        fs::write(&input, b"archive plus").unwrap();
        assert!(copy_download(&input, &scratch.0.join("oversize"), &available).is_err());
        let link = scratch.0.join("link");
        std::os::unix::fs::symlink(&input, &link).unwrap();
        assert!(copy_download(&link, &scratch.0.join("linked"), &available).is_err());
    }

    fn zip(path: &Path, executable: &str, bytes: &[u8]) {
        let mut zip = zip::ZipWriter::new(std::fs::File::create(path).unwrap());
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored)
            .unix_permissions(0o755);
        zip.start_file(format!("next/{executable}"), options)
            .unwrap();
        zip.write_all(bytes).unwrap();
        zip.finish().unwrap();
    }

    #[test]
    fn real_unmodified_official_installer_swaps_an_isolated_directory_and_refuses_bad_candidate() {
        // The upstream directory mode is ONLY a harmless test boundary. The
        // production constructor above requires a code-sealed actual .app.
        let scratch = Scratch::new().unwrap();
        let root = scratch.0.join("installed");
        fs::create_dir(&root).unwrap();
        let executable = root.join("app");
        fs::write(&executable, b"version one").unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
        let installation = Installation::directory(&root, &executable).unwrap();
        let archive = scratch.0.join("app.zip");
        zip(&archive, "app", b"version two");
        installation.install(&archive).unwrap();
        assert_eq!(fs::read(&executable).unwrap(), b"version two");
        let invalid = scratch.0.join("invalid.zip");
        zip(&invalid, "other", b"not an app");
        assert!(installation.install(&invalid).is_err());
        assert_eq!(fs::read(&executable).unwrap(), b"version two");
        let rollback = scratch.0.join("rollback.zip");
        zip(&rollback, "app", b"version one");
        installation.install(&rollback).unwrap();
        assert_eq!(
            fs::read(&executable).unwrap(),
            b"version one",
            "same official primitive restores an independently verified old payload"
        );
    }

    #[test]
    fn rollback_archive_and_signed_inputs_survive_preflight_drop_without_overwrite() {
        // Exercises durable backup I/O only. Production can construct this
        // capability solely through the code-sealed/signed prepare method.
        let source = Scratch::new().unwrap();
        let bytes = b"original signed archive";
        let archive = source.0.join("old.zip");
        fs::write(&archive, bytes).unwrap();
        let mut available = Available::default();
        available.sha256 = Some(hash(bytes));
        available.size = Some(bytes.len() as u64);
        let old = Manifest {
            schema: 1,
            source: Some("a".repeat(40)),
            application_id: "com.example.next".into(),
            channel: "desktop-stable".into(),
            platform: "macos".into(),
            architecture: "aarch64".into(),
            build: "1.0".into(),
            short_version: "1.0.0".into(),
            bundle_name: "Pilot Next.app".into(),
            archive_name: "old.zip".into(),
            archive_asset_id: 0,
            archive_size: bytes.len() as u64,
            archive_sha256: hash(bytes),
        };
        let rollback = VerifiedRollback {
            installed: source.0.join("not-live.app"),
            key: [19; 32],
            requirement: "fixture".into(),
            manifest: old,
            available,
            archive,
            config: b"config".to_vec(),
            signed: b"manifest".to_vec(),
            signature: b"signature".to_vec(),
            _scratch: source,
        };
        let durable = Scratch::new().unwrap();
        let op = uuid::Uuid::new_v4().to_string();
        let saved = rollback.persist(&durable.0.join("journal"), &op).unwrap();
        assert!(
            rollback.persist(&durable.0.join("journal"), &op).is_err(),
            "never overwrite/replay a retained backup intent"
        );
        drop(rollback);
        assert_eq!(fs::read(&saved).unwrap(), bytes);
        for (name, expected) in [
            ("latest.json", b"manifest".as_slice()),
            ("latest.json.sig", b"signature".as_slice()),
            ("nsh-updater.json", b"config".as_slice()),
        ] {
            assert_eq!(
                fs::read(saved.parent().unwrap().join(name)).unwrap(),
                expected
            );
        }
    }

    #[test]
    fn signed_pause_receipt_is_bound_to_original_operation_and_exact_target() {
        let payload =
            json!({"app":{"source":"a".repeat(40),"build":"2.0"},"captureHash":"c".repeat(64)});
        let op = json!({"operationId":"operation","payload":payload.to_string(),"payloadHash":"hash","destination":{"daemonId":"d","lineageId":"l"},"targetId":"global-update"});
        let receipt = json!({"state":"accepted","operationId":"operation","payloadHash":"hash","destination":op["destination"],"targetId":"global-update","result":{"target":payload}});
        exact_receipt(&receipt, &op).unwrap();
        for field in [
            "state",
            "operationId",
            "payloadHash",
            "destination",
            "targetId",
            "result",
        ] {
            let mut changed = receipt.clone();
            changed[field] = Value::Null;
            assert!(exact_receipt(&changed, &op).is_err(), "{field}");
        }
    }
}
