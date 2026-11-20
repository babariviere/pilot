//! Signed preflight of the official NSH app update and rollback inputs. It
//! installs nothing: no root can close, capture and install an official update yet.
use super::Error;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use nsh_updater::{Available, Config, Download, install::Installation};
use pilot_desktop_updater::{
    archive,
    daemon_upgrade::bundled_service::Runtime,
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
    os::unix::fs::{DirBuilderExt, OpenOptionsExt},
    path::{Path, PathBuf},
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
    // A diagnostic pin only. A future qualified root must reverify before consent.
    Ok(app.target.clone())
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
    installed: PathBuf,
    trust: Trust,
    target: Value,
}

/// The exact already-running signed release, checked independently before an
/// upgrade. An install would need this recoverable old payload.
/// This type is neither deserialized nor exposed to TSX.
pub struct VerifiedRollback {
    installed: PathBuf,
    key: [u8; 32],
    requirement: String,
    build: String,
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
        Runtime::installed(&installed, trust).map_err(|_| Error::Identity)?;
        Ok(Self {
            installed,
            key: trust.public_key,
            requirement: trust.code_requirement.clone(),
            build: native.build,
        })
    }
}

impl VerifiedApp {
    fn verify_rollback(&self, rollback: &VerifiedRollback) -> Result<(), Error> {
        if rollback.installed != self.installed
            || rollback.key != self.trust.public_key
            || rollback.requirement != self.trust.code_requirement
            || rollback.build != self.trust.current_build
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
        Runtime::verify(&bundle, &installed, &trust, &pilot.source, &pilot.build)
            .map_err(|_| Error::Identity)?;
        Ok(Self {
            installed,
            trust,
            target,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::SigningKey;

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
}
