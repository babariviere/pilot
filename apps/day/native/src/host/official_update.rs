//! Official tagged NSH app installation after exact native capture and close.
//! No exit hook, app-swap implementation, service manager or VM export lives here.
use super::{Error, journal::Journal, updates::Record, window::SavedWindow};
use crate::macos_host::{ClosedWindow, ForcedClosedWindow};
use crate::update::{Confirmation, UpdateKind, UpdateMode};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use nsh_updater::{Available, Config, Download, install::Installation};
use pilot_desktop_updater::{
    app_update::Connection,
    archive,
    coordination::{self, GlobalUpdateAction, Location},
    daemon_upgrade::bundled_service::{self, Completed, Runtime},
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
    sync::atomic::AtomicBool,
};

const MAX_ARCHIVE: u64 = 1024 * 1024 * 1024;

/// Inspect one explicitly selected native input directory. Paths are hints, not
/// trust: both signed releases and their GUI-bundled runtimes use the existing
/// verifiers. No journal write, consent, pause, close or service effect occurs.
pub(crate) fn inspect_inputs(
    directory: &Path,
    trust: Trust,
    journal: PathBuf,
) -> Result<Value, Error> {
    if !directory.is_absolute() {
        return Err(Error::Invalid);
    }
    let current = directory.join("rollback");
    let rollback = VerifiedRollback::prepare(
        &trust,
        &read(&current.join("latest.json"), 128 * 1024)?,
        &read(&current.join("latest.json.sig"), 4096)?,
        &current.join("app.zip"),
    )?;
    let next = directory.join("target");
    let app = VerifiedApp::prepare(
        trust,
        journal,
        &read(&next.join("latest.json"), 128 * 1024)?,
        &read(&next.join("latest.json.sig"), 4096)?,
        &next.join("app.zip"),
    )?;
    app.verify_rollback(&rollback)?;
    // A diagnostic pin only. Deliberately drop the private immutable copies and
    // execution handles. A future qualified root must reverify before consent.
    Ok(app.target.clone())
}

enum ClosedUpdate {
    Preserved(ClosedWindow, NormalConsent),
    Forced(super::update_loss::Accepted),
}

/// A one-use normal confirmation from immutable verified official inputs.
/// It is not state-loss consent, capture evidence or permission to install.
#[derive(Debug)]
#[must_use]
pub struct NormalOffer {
    confirmation: Confirmation,
    source: super::Source,
    window: String,
    target: Value,
    journal: PathBuf,
}

/// Fresh normal consent. Only its exact owning window may begin capture.
/// Never serialized, cloned or reconstructed by retained-operation lookup.
#[derive(Debug)]
#[must_use]
pub struct NormalConsent {
    offer: NormalOffer,
    capture_started: bool,
    generation: Option<u32>,
}

impl NormalOffer {
    fn verified(
        source: super::Source,
        window: String,
        target: Value,
        journal: PathBuf,
        from: String,
    ) -> Result<Self, Error> {
        if uuid::Uuid::parse_str(&window).is_err() {
            return Err(Error::Invalid);
        }
        Ok(Self {
            confirmation: Confirmation {
                id: uuid::Uuid::new_v4().to_string(),
                mode: Some(UpdateMode::Normal),
                kind: UpdateKind::App,
                from,
                to: target["build"].as_str().ok_or(Error::Identity)?.into(),
                pauses: None,
                keeps: None,
                restarts: true,
            },
            source,
            window,
            target,
            journal,
        })
    }

    pub fn confirmation(&self) -> &Confirmation {
        &self.confirmation
    }

    fn accept(
        self,
        id: &str,
        target: &Value,
        source: &super::Source,
        journal: &Path,
    ) -> Result<NormalConsent, Error> {
        if self.confirmation.id != id || self.target != *target {
            return Err(Error::Stale);
        }
        if self.source != *source || self.journal != journal {
            return Err(Error::Identity);
        }
        Ok(NormalConsent {
            offer: self,
            capture_started: false,
            generation: None,
        })
    }
}

impl NormalConsent {
    /// Dispatch only to the confirmed native root. This starts preservation,
    /// not global pause, close, loss acceptance or installation. Canceling this
    /// capture consumes the attempt; a new attempt needs fresh confirmation.
    ///
    /// # Errors
    /// Refuses another window, a consumed attempt or a native capture failure.
    pub fn begin_capture(
        &mut self,
        owner: &mut crate::macos_host::WindowOwner,
        main: nsh_platform_macos::objc2::MainThreadMarker,
    ) -> Result<u32, Error> {
        self.capture_allowed(owner.identity())?;
        // Consume before native dispatch, including a failure with no returned
        // generation. Neither a lost reply nor cancel can replay this attempt.
        self.capture_started = true;
        let generation = owner.begin_close(main)?;
        self.generation = Some(generation);
        Ok(generation)
    }

    fn capture_allowed(&self, window: &str) -> Result<(), Error> {
        if self.capture_started {
            return Err(Error::Stale);
        }
        if self.offer.window != window {
            return Err(Error::Identity);
        }
        Ok(())
    }

    fn verify_capture(
        &self,
        target: &Value,
        journal: &Path,
        capture: &SavedWindow,
    ) -> Result<(), Error> {
        capture.validate()?;
        if self.offer.target != *target
            || self.offer.journal != journal
            || self.offer.source != capture.source
            || self.offer.window != capture.window
        {
            return Err(Error::Identity);
        }
        if !self.capture_started || self.generation != Some(capture.generation) {
            return Err(Error::Stale);
        }
        Ok(())
    }
}

struct InstallState {
    source: super::Source,
    window: String,
    operation_id: String,
    view: Value,
    flush: Option<(u32, u64)>,
    capture: Option<SavedWindow>,
    loss: Option<super::update_loss::Record>,
}

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
    runtime: Runtime,
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
    runtime: Runtime,
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
        let runtime = Runtime::installed(&installed, trust).map_err(|_| Error::Identity)?;
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
            runtime,
            _scratch: scratch,
        })
    }

    fn persist(&self, journal: &Path, operation: &str) -> Result<PathBuf, Error> {
        persist_backup(
            journal,
            operation,
            &self.archive,
            &self.available,
            [
                ("latest.json", &self.signed),
                ("latest.json.sig", &self.signature),
                ("nsh-updater.json", &self.config),
            ],
        )
    }
}

fn persist_backup(
    journal: &Path,
    operation: &str,
    source: &Path,
    available: &Available,
    files: [(&str, &[u8]); 3],
) -> Result<PathBuf, Error> {
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
    copy_download(source, &archive, available)?;
    for (name, bytes) in files {
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

impl VerifiedApp {
    fn verify_rollback(&self, rollback: &VerifiedRollback) -> Result<(), Error> {
        if rollback.installed != self.installed
            || rollback.key != self.trust.public_key
            || rollback.requirement != self.trust.code_requirement
            || rollback.manifest.build != self.trust.current_build
        {
            return Err(Error::Identity);
        }
        Ok(())
    }

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
        let runtime = Runtime::verify(&bundle, &installed, &trust, &pilot.source, &pilot.build)
            .map_err(|_| Error::Identity)?;
        Ok(Self {
            installation,
            installed,
            trust,
            manifest: native,
            journal,
            archive: copied,
            target,
            runtime,
            _scratch: scratch,
        })
    }

    /// Prepare normal preservation consent for one exact source and native root.
    /// A prepared choice has no capture, pause or install effects.
    ///
    /// # Errors
    /// Refuses an invalid window identity or incomplete verified target.
    pub fn normal_offer(
        &self,
        source: super::Source,
        window: String,
    ) -> Result<NormalOffer, Error> {
        NormalOffer::verified(
            source,
            window,
            self.target.clone(),
            self.journal.clone(),
            self.trust.current_build.clone(),
        )
    }

    /// Consume explicit normal confirmation against the same current native
    /// host and verified inputs. No durable/external effect has entered yet.
    ///
    /// # Errors
    /// Refuses a closed host, stale confirmation or different target/source/journal.
    pub fn accept_normal(
        &self,
        offer: NormalOffer,
        id: &str,
        host: &super::NativeHost,
    ) -> Result<NormalConsent, Error> {
        host.0.shared.open()?;
        offer.accept(id, &self.target, &host.0.source, &host.0.ledger)
    }

    /// Prepare a separate loss confirmation from this exact verified signed target.
    /// Acceptance rechecks the current verified target before any loss is recorded.
    pub fn force_offer(
        &self,
        source: super::Source,
        window: String,
    ) -> Result<super::update_loss::Offer, Error> {
        super::update_loss::Offer::verified(
            self.journal.clone(),
            source,
            window,
            self.target.clone(),
            self.trust.current_build.clone(),
        )
    }

    /// Accept only this current verified app's exact confirmation and journal.
    /// A stale target fails before granting any state-loss or close capability.
    pub async fn accept_force(
        &self,
        offer: super::update_loss::Offer,
        id: &str,
        host: &super::NativeHost,
    ) -> Result<super::update_loss::Accepted, Error> {
        offer.accept(id, host, &self.target, &self.journal).await
    }

    /// Dispatch accepted loss only while these exact verified inputs remain
    /// selected. The window also checks source, journal and native identity.
    ///
    /// # Errors
    /// Refuses another target/journal or a window which cannot enter joined close.
    pub fn begin_force_close(
        &self,
        owner: &mut crate::macos_host::WindowOwner,
        accepted: super::update_loss::Accepted,
    ) -> Result<crate::macos_host::ForcedClosing, Error> {
        accepted.matches_target(&self.target, &self.journal)?;
        owner.begin_force_close(accepted)
    }

    /// Consume exact accepted loss, joined host close and disposed engine. All
    /// signature, runtime, rollback and independent process checks stay mandatory.
    pub fn install_force(
        self,
        closed: ForcedClosedWindow,
        rollback: VerifiedRollback,
        verify_processes: impl FnOnce(&Value) -> Result<(), Error>,
    ) -> Result<InstalledApp, Error> {
        self.install_closed(
            ClosedUpdate::Forced(closed.into_accepted()),
            rollback,
            verify_processes,
        )
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
        consent: NormalConsent,
        verify_processes: impl FnOnce(&Value) -> Result<(), Error>,
    ) -> Result<InstalledApp, Error> {
        self.install_closed(
            ClosedUpdate::Preserved(closed, consent),
            rollback,
            verify_processes,
        )
    }

    fn install_closed(
        self,
        closed: ClosedUpdate,
        rollback: VerifiedRollback,
        verify_processes: impl FnOnce(&Value) -> Result<(), Error>,
    ) -> Result<InstalledApp, Error> {
        if nsh_platform_macos::objc2::MainThreadMarker::new().is_some() {
            return Err(Error::Invalid);
        }
        self.verify_rollback(&rollback)?;
        let state = match closed {
            ClosedUpdate::Preserved(closed, consent) => {
                let capture = closed.capture().clone();
                consent.verify_capture(&self.target, &self.journal, &capture)?;
                InstallState {
                    source: capture.source.clone(),
                    window: capture.window.clone(),
                    operation_id: consent.offer.confirmation.id,
                    view: capture.view.clone(),
                    flush: Some((capture.generation, capture.save_sequence)),
                    capture: Some(capture),
                    loss: None,
                }
            }
            ClosedUpdate::Forced(mut accepted) => {
                accepted.matches_target(&self.target, &self.journal)?;
                // Only ForcedClosedWindow reaches here: joined host and engine
                // disposal happened before this off-AppKit history write.
                accepted.closed()?;
                let loss = accepted.record().clone();
                InstallState {
                    source: loss.source.clone(),
                    window: loss.window.clone(),
                    operation_id: loss.operation.clone(),
                    view: Value::Null,
                    flush: None,
                    capture: None,
                    loss: Some(loss),
                }
            }
        };
        let operation_id = state.operation_id.clone();
        if !super::valid_id(&operation_id) || uuid::Uuid::parse_str(&operation_id).is_err() {
            return Err(Error::Invalid);
        }
        let mut journal = Journal::open(self.journal.clone())?;
        if let Some(capture) = &state.capture
            && journal.windows.get(&SavedWindow::key(&capture.source)?) != Some(capture)
        {
            return Err(Error::Identity);
        }
        if let Some(loss) = &state.loss
            && journal.losses.get(&loss.operation) != Some(loss)
        {
            return Err(Error::Identity);
        }
        if journal.updates.contains_key(&operation_id)
            || journal.updates.values().any(|r| {
                r.source == state.source
                    && (if r.update_version == 2 {
                        r.state != "done"
                    } else {
                        !["done", "stopped"].contains(&r.state.as_str())
                    })
            })
        {
            return Err(Error::Unknown);
        }
        // Keep the signed old archive outside the app and OS-temp preflight.
        // NSH removes the old .app after swap; this survives startup failure.
        let backup = rollback.persist(&self.journal, &operation_id)?;
        let mut payload = json!({"app":{"source":self.manifest.source,"build":self.manifest.build},
            "replacement":self.runtime.replacement()});
        if let Some(loss) = &state.loss {
            payload["acceptedLoss"] = loss.payload();
        } else {
            payload["captureHash"] = hash(
                &serde_json::to_vec(state.capture.as_ref().ok_or(Error::Identity)?)
                    .map_err(|_| Error::Storage)?,
            )
            .into();
        }
        let payload = payload.to_string();
        let destination = json!({"hostId":"daemon","daemonId":state.source.home.daemon_id,"lineageId":state.source.home.lineage_id});
        let operation = json!({"schemaVersion":1,"operationId":operation_id,"producerId":operation_id,"sequence":1,
            "origin":destination,"destination":destination,"targetId":"global-update","kind":"global-update-prepare",
            "payloadHash":hash(payload.as_bytes()),"payload":payload});
        let mut root = json!({"officialNsh":self.target,"preparation":operation,
            "rollback":{"archive":backup,"sha256":rollback.manifest.archive_sha256,"size":rollback.manifest.archive_size,
                "source":rollback.manifest.source,"build":rollback.manifest.build,"version":rollback.manifest.short_version,
                "key":self.trust.public_key.to_vec(),"requirement":self.trust.code_requirement}});
        if let Some(loss) = &state.loss {
            root["loss"] = serde_json::to_value(loss).map_err(|_| Error::Storage)?;
        }
        let mut record = Record {
            order: journal.updates.values().map(|r| r.order).max().unwrap_or(0) + 1,
            update_version: if state.loss.is_some() { 2 } else { 1 },
            id: operation_id,
            source: state.source.clone(),
            root: root.clone(),
            window: state.window,
            kind: "app".into(),
            target: self.manifest.build.clone(),
            view: state.view,
            auth: hash(&serde_json::to_vec(&root).map_err(|_| Error::Storage)?),
            revision: 1,
            state: "capture".into(),
            flush: state.flush,
            message: if state.loss.is_some() {
                "Force loss accepted and window closed. Global preparation is not yet acknowledged."
            } else {
                "Exact native capture and close saved before global preparation."
            }
            .into(),
            restored: false,
            manifest: Some(json!({"phase":"pause-entered"})),
        };
        journal.save_update(record.clone())?;
        record.state = "entered".into();
        record.revision += 1;
        record.manifest = Some(json!({"phase":"pause-entered"}));
        journal.save_update(record.clone())?;
        let location = Location {
            home: state.source.profile.clone(),
            port: state.source.port,
            policy: Default::default(),
        };
        let connection = Connection::new(
            location.clone(),
            state.source.home.daemon_id.clone(),
            state.source.home.lineage_id.clone(),
        );
        let cancel = AtomicBool::new(false);
        let mut service = None;
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
            if fresh["receipt"] != receipt {
                return Err(Error::Busy);
            }
            let uncertainty =
                bundled_service::dogfood_uncertainty(&fresh).map_err(|_| Error::Busy)?;
            verify_processes(&fresh)?;
            // The official installer must never replace a GUI bundle while
            // its own daemon is still executing from that bundle. The native
            // module owns exact service identity, durable stop and lease exit.
            let stopped = bundled_service::stop(&connection, &self.runtime, &operation, &cancel)
                .map_err(|_| Error::Unknown)?;
            record.manifest = Some(
                json!({"phase":"install-entered","receipt":receipt,"uncertainty":uncertainty}),
            );
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
            let completed = stopped.start().map_err(|_| Error::Unknown)?;
            record.manifest =
                Some(json!({"phase":"installed","receipt":receipt,"service":completed.evidence()}));
            service = Some(completed);
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
            connection,
            service: service.ok_or(Error::Unknown)?,
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
    connection: Connection,
    service: Completed,
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
    pub fn rollback_and_restart(
        mut self,
        verify_processes: impl FnOnce(&Value) -> Result<(), Error>,
    ) -> Result<(), Error> {
        if nsh_platform_macos::objc2::MainThreadMarker::new().is_some() {
            return Err(Error::Invalid);
        }
        self.record.manifest.as_mut().ok_or(Error::Unknown)?["phase"] = "rollback-entered".into();
        self.record.revision += 1;
        self.journal.save_update(self.record.clone())?;
        let operation = &self.record.root["preparation"];
        let fresh = coordination::global_update(
            self.connection.location(),
            operation,
            GlobalUpdateAction::Verify,
        )
        .map_err(|_| Error::Unknown)?;
        verify_processes(&fresh)?;
        let cancel = AtomicBool::new(false);
        let completed = self
            .service
            .rollback(
                &self.connection,
                &self.inputs.runtime,
                &self.rollback.runtime,
                operation,
                &cancel,
                || {
                    self.inputs
                        .installation
                        .install(&self.backup)
                        .map_err(|_| pilot_desktop_updater::daemon_upgrade::Failure::Unknown)?;
                    NativePlatform
                        .verify_candidate(
                            &self.inputs.installed,
                            &self.inputs.trust,
                            &self.rollback.manifest,
                        )
                        .map_err(|_| pilot_desktop_updater::daemon_upgrade::Failure::Unknown)
                },
            )
            .map_err(|_| Error::Unknown)?;
        self.record.manifest.as_mut().ok_or(Error::Unknown)?["service"] =
            completed.evidence().clone();
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

    fn normal_choice(journal: PathBuf) -> NormalOffer {
        NormalOffer::verified(
            super::super::Source {
                profile: journal.parent().unwrap().into(),
                port: 1,
                home: crate::contract::Home {
                    daemon_id: "daemon".into(),
                    lineage_id: "lineage".into(),
                },
                project_id: "project".into(),
                project_path: "/project".into(),
            },
            uuid::Uuid::new_v4().to_string(),
            json!({"source":"a".repeat(40),"build":"2.0","version":"2.0.0",
                "sha256":"b".repeat(64),"size":7,"configHash":"c".repeat(64)}),
            journal,
            "1.0".into(),
        )
        .unwrap()
    }

    #[test]
    fn official_consent_normal_is_exact_one_use_and_has_no_loss_or_journal_effect() {
        let scratch = Scratch::new().unwrap();
        let path = scratch.0.join("journal");
        let offer = normal_choice(path.clone());
        let id = offer.confirmation().id.clone();
        assert_eq!(offer.confirmation().mode, Some(UpdateMode::Normal));
        assert_eq!(offer.confirmation().pauses, None);
        let target = offer.target.clone();
        let source = offer.source.clone();
        let consent = offer.accept(&id, &target, &source, &path).unwrap();
        assert_eq!(consent.offer.confirmation.id, id);
        assert!(consent.generation.is_none(), "consent is not capture");
        assert!(
            !path.exists(),
            "normal consent is neither loss nor install entry"
        );
        drop(consent);
        let next = normal_choice(path.clone());
        let target = next.target.clone();
        assert!(matches!(
            next.accept(&id, &target, &source, &path),
            Err(Error::Stale)
        ));
        assert!(!path.exists(), "dropping/canceling cannot discard state");
    }

    #[test]
    fn official_consent_normal_refuses_retargeting_or_different_native_authority() {
        let scratch = Scratch::new().unwrap();
        let path = scratch.0.join("journal");
        for field in ["source", "build", "version", "sha256", "size", "configHash"] {
            let offer = normal_choice(path.clone());
            let id = offer.confirmation().id.clone();
            let source = offer.source.clone();
            let mut target = offer.target.clone();
            target[field] = Value::Null;
            assert!(
                matches!(
                    offer.accept(&id, &target, &source, &path),
                    Err(Error::Stale)
                ),
                "{field}: same build labels cannot substitute signed bytes"
            );
        }
        for field in [
            "profile", "port", "daemon", "lineage", "project", "path", "journal",
        ] {
            let offer = normal_choice(path.clone());
            let id = offer.confirmation().id.clone();
            let target = offer.target.clone();
            let mut source = offer.source.clone();
            let mut ledger = path.clone();
            match field {
                "profile" => source.profile = scratch.0.join("other-profile"),
                "port" => source.port += 1,
                "daemon" => source.home.daemon_id.push('2'),
                "lineage" => source.home.lineage_id.push('2'),
                "project" => source.project_id.push('2'),
                "path" => source.project_path.push('2'),
                _ => ledger = scratch.0.join("other-journal"),
            }
            assert!(
                matches!(
                    offer.accept(&id, &target, &source, &ledger),
                    Err(Error::Identity)
                ),
                "{field}"
            );
        }
        assert!(!path.exists());
    }

    #[test]
    fn official_consent_normal_capture_dispatch_and_install_bind_the_same_native_generation() {
        let scratch = Scratch::new().unwrap();
        let path = scratch.0.join("journal");
        let offer = normal_choice(path.clone());
        let id = offer.confirmation().id.clone();
        let target = offer.target.clone();
        let source = offer.source.clone();
        let window = offer.window.clone();
        let mut consent = offer.accept(&id, &target, &source, &path).unwrap();
        assert_eq!(
            consent.capture_allowed("another-window"),
            Err(Error::Identity)
        );
        assert_eq!(consent.capture_allowed(&window), Ok(()));
        let capture = SavedWindow {
            kind: "window-capture".into(),
            version: 1,
            source,
            window,
            generation: 7,
            save_sequence: 3,
            view: serde_json::to_value(crate::update::SavedView {
                goal: " exact unsent 👩🏽‍💻\n".into(),
                ..Default::default()
            })
            .unwrap(),
        };
        assert_eq!(
            consent.verify_capture(&target, &path, &capture),
            Err(Error::Stale)
        );
        // Pure binding seam only. This does NOT manufacture ClosedWindow or
        // claim AppKit capture/IME acceptance; only WindowOwner produces those.
        consent.capture_started = true;
        assert_eq!(consent.capture_allowed(&capture.window), Err(Error::Stale));
        assert_eq!(
            consent.verify_capture(&target, &path, &capture),
            Err(Error::Stale),
            "an entered attempt without a native generation stays unusable"
        );
        consent.generation = Some(7);
        assert_eq!(consent.capture_allowed(&capture.window), Err(Error::Stale));
        assert_eq!(consent.verify_capture(&target, &path, &capture), Ok(()));
        for field in ["source", "window", "generation", "invalid-view"] {
            let mut changed = capture.clone();
            match field {
                "source" => changed.source.project_id.push('2'),
                "window" => changed.window = uuid::Uuid::new_v4().to_string(),
                "generation" => changed.generation += 1,
                _ => changed.view = Value::Null,
            }
            assert!(
                consent.verify_capture(&target, &path, &changed).is_err(),
                "{field}"
            );
        }
        let mut changed = target.clone();
        changed["sha256"] = "d".repeat(64).into();
        assert_eq!(
            consent.verify_capture(&changed, &path, &capture),
            Err(Error::Identity)
        );
        assert_eq!(
            consent.verify_capture(&target, &scratch.0.join("other"), &capture),
            Err(Error::Identity)
        );
        assert!(!path.exists(), "binding checks cannot pause or install");
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
    fn native_input_hints_cannot_create_a_journal_or_bypass_signed_preflight() {
        let scratch = Scratch::new().unwrap();
        let (_, trust, _, _) = signed(&manifest());
        let journal = scratch.0.join("journal");
        assert_eq!(
            inspect_inputs(Path::new("relative"), trust.clone(), journal.clone()),
            Err(Error::Invalid)
        );
        assert_eq!(
            inspect_inputs(&scratch.0, trust, journal.clone()),
            Err(Error::Storage)
        );
        assert!(
            !journal.exists(),
            "preflight is not consent or update entry"
        );
        assert!(!scratch.0.join("official-app-backups").exists());
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
        // Exercises the durable backup I/O seam without manufacturing a signed
        // Runtime or an executable install capability from fixture JSON.
        let source = Scratch::new().unwrap();
        let bytes = b"original signed archive";
        let archive = source.0.join("old.zip");
        fs::write(&archive, bytes).unwrap();
        let mut available = Available::default();
        available.sha256 = Some(hash(bytes));
        available.size = Some(bytes.len() as u64);
        let files = [
            ("latest.json", b"manifest".as_slice()),
            ("latest.json.sig", b"signature".as_slice()),
            ("nsh-updater.json", b"config".as_slice()),
        ];
        let durable = Scratch::new().unwrap();
        let op = uuid::Uuid::new_v4().to_string();
        let saved =
            persist_backup(&durable.0.join("journal"), &op, &archive, &available, files).unwrap();
        assert!(
            persist_backup(&durable.0.join("journal"), &op, &archive, &available, files).is_err(),
            "never overwrite/replay a retained backup intent"
        );
        drop(source);
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
