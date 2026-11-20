//! Linux full-payload signatures and native user-owned directory exchange.
//! Inventory signatures replace macOS code signing, not the outer signed archive.
use crate::{Error, manifest::Trust};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use ring::signature::{ED25519, UnparsedPublicKey};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::Read,
    os::unix::fs::MetadataExt,
    path::{Component, Path},
};

pub const INVENTORY: &str = "linux-gui-package.json";
pub const SIGNATURE: &str = "linux-gui-package.sig";
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Package {
    schema: u8,
    kind: String,
    pub source: String,
    target: String,
    build: serde_json::Value,
    pub bundle_build: String,
    application_id: String,
    short_version: String,
    bundled_launch: bool,
    installer: bool,
    updater: bool,
    native_visual_execution: bool,
    files: Vec<Entry>,
}
#[derive(Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
enum Entry {
    Directory {
        path: String,
        mode: u32,
    },
    File {
        path: String,
        mode: u32,
        bytes: u64,
        sha256: String,
    },
    Link {
        path: String,
        target: String,
    },
}
impl Entry {
    fn path(&self) -> &str {
        match self {
            Self::Directory { path, .. } | Self::File { path, .. } | Self::Link { path, .. } => {
                path
            }
        }
    }
}
fn read(path: &Path, maximum: usize) -> Result<Vec<u8>, Error> {
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(|_| Error::Filesystem)?;
    let meta = file.metadata().map_err(|_| Error::Filesystem)?;
    if !meta.is_file() || meta.nlink() != 1 || meta.len() > maximum as u64 {
        return Err(Error::Filesystem);
    }
    let mut bytes = Vec::new();
    file.by_ref()
        .take(maximum as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| Error::Filesystem)?;
    if bytes.len() > maximum {
        return Err(Error::Filesystem);
    }
    Ok(bytes)
}
pub fn verify(
    bundle: &Path,
    trust: &Trust,
    build: &str,
    short: Option<&str>,
) -> Result<Package, Error> {
    let raw = read(&bundle.join(INVENTORY), 8 * 1024 * 1024)?;
    let signature = STANDARD
        .decode(read(&bundle.join(SIGNATURE), 128)?.trim_ascii())
        .map_err(|_| Error::Signature)?;
    UnparsedPublicKey::new(&ED25519, trust.public_key)
        .verify(&raw, &signature)
        .map_err(|_| Error::Signature)?;
    let package: Package = serde_json::from_slice(&raw).map_err(|_| Error::Identity)?;
    if trust.code_requirement != "signed-linux-inventory-v1"
        || package.schema != 1
        || package.kind != "linux-gui-distribution"
        || package.target != "x86_64-unknown-linux-gnu"
        || package.application_id != trust.application_id
        || package.bundle_build != build
        || short.is_some_and(|v| v != package.short_version)
        || package.build["version"] != package.short_version
        || package.source.len() != 40
        || !package
            .source
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        || package.build["source"] != package.source
        || package.build["platform"] != "linux"
        || package.build["arch"] != "x64"
        || !package.bundled_launch
        || !package.installer
        || !package.updater
        || package.native_visual_execution
    {
        return Err(Error::Identity);
    }
    crate::manifest::Build::parse(build)?;
    let mut expected = BTreeMap::new();
    for entry in &package.files {
        let name = entry.path();
        if name.is_empty()
            || Path::new(name)
                .components()
                .any(|p| !matches!(p, Component::Normal(_)))
            || name == INVENTORY
            || name == SIGNATURE
            || expected.insert(name, entry).is_some()
        {
            return Err(Error::Identity);
        }
    }
    let mut pending = vec![bundle.to_owned()];
    let mut actual = BTreeMap::new();
    let mut expanded = 0_u64;
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(directory).map_err(|_| Error::Filesystem)? {
            let path = entry.map_err(|_| Error::Filesystem)?.path();
            let name = path
                .strip_prefix(bundle)
                .map_err(|_| Error::Identity)?
                .to_str()
                .ok_or(Error::Identity)?
                .to_owned();
            if name == INVENTORY || name == SIGNATURE {
                continue;
            }
            let meta = fs::symlink_metadata(&path).map_err(|_| Error::Filesystem)?;
            let mode = meta.mode() & 0o7777;
            let item = if meta.file_type().is_symlink() {
                let target = fs::read_link(&path).map_err(|_| Error::Filesystem)?;
                if target.is_absolute()
                    || !path
                        .canonicalize()
                        .map_err(|_| Error::Filesystem)?
                        .starts_with(bundle)
                {
                    return Err(Error::Identity);
                }
                Entry::Link {
                    path: name.clone(),
                    target: target.to_str().ok_or(Error::Identity)?.into(),
                }
            } else if meta.is_dir() && mode & 0o7022 == 0 {
                pending.push(path);
                Entry::Directory {
                    path: name.clone(),
                    mode,
                }
            } else if meta.is_file() && meta.nlink() == 1 && mode & 0o7022 == 0 {
                expanded = expanded.checked_add(meta.len()).ok_or(Error::Archive)?;
                if expanded > crate::archive::MAX_EXPANDED {
                    return Err(Error::Archive);
                }
                let mut file = fs::File::open(path).map_err(|_| Error::Filesystem)?;
                let mut hash = Sha256::new();
                let mut buffer = [0; 65_536];
                loop {
                    let n = file.read(&mut buffer).map_err(|_| Error::Filesystem)?;
                    if n == 0 {
                        break;
                    }
                    hash.update(&buffer[..n]);
                }
                Entry::File {
                    path: name.clone(),
                    mode,
                    bytes: meta.len(),
                    sha256: crate::transport::hex(&hash.finalize()),
                }
            } else {
                return Err(Error::Filesystem);
            };
            actual.insert(name, item);
            if actual.len() + pending.len() > 30_000 {
                return Err(Error::Archive);
            }
        }
    }
    if expected.len() != actual.len()
        || actual.iter().any(|(name, value)| {
            expected
                .get(name.as_str())
                .is_none_or(|item| *item != value)
        })
    {
        return Err(Error::Identity);
    }
    for required in [
        crate::layout::GUI,
        crate::layout::HELPER,
        "libexec/pilot-visual-worker",
        "bin/pilot-next",
        "runtime/node/bin/node",
        "runtime/packages/daemon/src/main.ts",
        "runtime/packages/kernel/src/worker-entry.ts",
        "runtime-inputs.json",
        "rust-inputs.json",
        "updater-inputs.json",
        crate::layout::POLICY,
    ] {
        if !matches!(actual.get(required), Some(Entry::File { .. })) {
            return Err(Error::Identity);
        }
    }
    let runtime: serde_json::Value =
        serde_json::from_slice(&read(&bundle.join("runtime/runtime-build.json"), 4096)?)
            .map_err(|_| Error::Identity)?;
    let rust: serde_json::Value =
        serde_json::from_slice(&read(&bundle.join("rust-inputs.json"), 8 * 1024 * 1024)?)
            .map_err(|_| Error::Identity)?;
    let runtime_inputs: serde_json::Value =
        serde_json::from_slice(&read(&bundle.join("runtime-inputs.json"), 8 * 1024 * 1024)?)
            .map_err(|_| Error::Identity)?;
    let updater: serde_json::Value =
        serde_json::from_slice(&read(&bundle.join("updater-inputs.json"), 8 * 1024 * 1024)?)
            .map_err(|_| Error::Identity)?;
    let configuration = serde_json::json!({"schema":1,"mode":"configured","public_key":STANDARD.encode(trust.public_key),"repository":trust.repository,"application_id":trust.application_id,"build":build,"code_requirement":trust.code_requirement});
    if runtime != package.build
        || rust["tested_sha"] != package.source
        || rust["target"] != package.target
        || runtime_inputs["source"] != package.source
        || runtime_inputs["target"] != package.target
        || updater["tested_sha"] != package.source
        || updater["target"] != package.target
        || rust["updater_configuration"] != configuration
        || updater["updater_configuration"] != configuration
    {
        return Err(Error::Identity);
    }
    Ok(package)
}

#[cfg(all(target_os = "linux", feature = "native-linux"))]
pub struct LinuxPlatform;
#[cfg(all(target_os = "linux", feature = "native-linux"))]
impl crate::installer::Platform for LinuxPlatform {
    fn verify(
        &self,
        bundle: &Path,
        trust: &Trust,
        build: &str,
        short: Option<&str>,
    ) -> Result<(), Error> {
        verify(bundle, trust, build, short).map(|_| ())
    }
    fn verify_candidate(
        &self,
        bundle: &Path,
        trust: &Trust,
        manifest: &crate::manifest::Manifest,
    ) -> Result<(), Error> {
        let package = verify(
            bundle,
            trust,
            &manifest.build,
            Some(&manifest.short_version),
        )?;
        if manifest.source.as_deref() != Some(package.source.as_str()) {
            return Err(Error::Identity);
        }
        Ok(())
    }
    fn swap(&self, parent: &fs::File, staged: &Path, target: &Path) -> Result<(), Error> {
        use std::{
            ffi::CString,
            os::{fd::AsRawFd, unix::ffi::OsStrExt},
        };
        let staged = CString::new(staged.as_os_str().as_bytes()).map_err(|_| Error::Filesystem)?;
        let target = CString::new(target.as_os_str().as_bytes()).map_err(|_| Error::Filesystem)?;
        // SAFETY: held same-volume directory descriptor, validated relative entries.
        if unsafe {
            libc::renameat2(
                parent.as_raw_fd(),
                staged.as_ptr(),
                parent.as_raw_fd(),
                target.as_ptr(),
                libc::RENAME_EXCHANGE,
            )
        } != 0
        {
            return Err(Error::InstallFailed);
        }
        Ok(())
    }
    fn relaunch(&self, app: &Path, transaction: &Path) -> Result<(), Error> {
        use std::process::{Command, Stdio};
        // Preserve the invoking desktop session, never credentials/profile overrides
        // from an update response. No shell, sudo or service-manager restart.
        let mut command = Command::new(app.join(crate::layout::GUI));
        command
            .arg("--updater-receipt")
            .arg(transaction)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(feature = "fixture")]
        if crate::fixture::enabled() {
            command
                .env("WAYLAND_DEBUG", "1")
                .stderr(crate::fixture::Fixture::relaunch_output(app)?);
        }
        let mut child = command.spawn().map_err(|_| Error::Native)?;
        std::thread::spawn(move || {
            let _ = child.wait();
        });
        Ok(()) // only the GUI's durable startup ACK establishes success
    }
}

/// Linux mode bits include the effective POSIX ACL mask. Private proof files
/// additionally reject named/default ACLs because read grants matter there too.
#[cfg(all(target_os = "linux", feature = "native-linux"))]
pub(crate) fn acl_policy(path: &Path, policy: i32) -> Result<(), Error> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    let path = CString::new(path.as_os_str().as_bytes()).map_err(|_| Error::Filesystem)?;
    for name in [c"system.posix_acl_access", c"system.posix_acl_default"] {
        // SAFETY: valid NUL-terminated names, size-only query follows no symlink.
        let size =
            unsafe { libc::lgetxattr(path.as_ptr(), name.as_ptr(), std::ptr::null_mut(), 0) };
        if size < 0 {
            let errno = std::io::Error::last_os_error().raw_os_error();
            if matches!(errno, Some(libc::ENODATA | libc::EOPNOTSUPP)) {
                continue;
            }
            return Err(Error::Filesystem);
        }
        if size > 0 {
            if policy == 1 {
                // Fresh unpublished private directories only, never repair user paths.
                if unsafe { libc::lremovexattr(path.as_ptr(), name.as_ptr()) } != 0 {
                    return Err(Error::Filesystem);
                }
            } else if policy == 2 || name == c"system.posix_acl_default" {
                return Err(Error::Filesystem);
            }
        }
    }
    Ok(())
}

#[cfg(all(test, target_os = "linux", feature = "native-linux"))]
mod tests {
    use super::*;
    use crate::installer::{NativePlatform, Platform};
    use ring::signature::{Ed25519KeyPair, KeyPair};
    use std::{os::unix::fs::PermissionsExt, process::Command, time::Duration};
    #[test]
    fn pidfd_exit_is_actual_owned_exit_not_timeout_or_pid_polling() {
        let mut child = Command::new("/bin/sh")
            .args(["-c", "read ignored"])
            .stdin(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let watch = crate::helper::ParentWatch::new(child.id() as _).unwrap();
        assert!(matches!(
            watch.wait(Duration::ZERO),
            Err(Error::ParentStillRunning)
        ));
        let watch = crate::helper::ParentWatch::new(child.id() as _).unwrap();
        drop(child.stdin.take());
        child.wait().unwrap();
        assert!(watch.wait(Duration::from_secs(1)).is_ok());
    }
    #[test]
    fn atomic_exchange_retains_old_directory_with_spaces() {
        let root = crate::owned_tests::Temp::new();
        let parent = root.path();
        for (name, bytes) in [("Installed GUI", b"old"), ("Staged GUI", b"new")] {
            fs::create_dir(parent.join(name)).unwrap();
            fs::write(parent.join(name).join("payload"), bytes).unwrap();
        }
        NativePlatform
            .swap(
                &fs::File::open(parent).unwrap(),
                Path::new("Staged GUI"),
                Path::new("Installed GUI"),
            )
            .unwrap();
        assert_eq!(
            fs::read(parent.join("Installed GUI/payload")).unwrap(),
            b"new"
        );
        assert_eq!(fs::read(parent.join("Staged GUI/payload")).unwrap(), b"old");
    }
    #[test]
    fn private_read_acl_and_default_acl_refuse_without_repair() {
        let root = crate::owned_tests::Temp::new();
        let path = root.path().join("proof");
        fs::write(&path, b"private").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(acl_policy(&path, 2).is_ok());
        assert!(
            Command::new("setfacl")
                .args(["-m", "u:65534:r", "--"])
                .arg(&path)
                .status()
                .unwrap()
                .success()
        );
        assert_eq!(acl_policy(&path, 2), Err(Error::Filesystem));
        assert_eq!(acl_policy(&path, 2), Err(Error::Filesystem));
    }
    fn fixture(root: &Path) -> (Trust, serde_json::Value, Ed25519KeyPair) {
        use serde_json::json;
        let key = Ed25519KeyPair::from_seed_unchecked(&[42; 32]).unwrap();
        let trust = Trust {
            repository: "synthetic/test".into(),
            application_id: "com.example.synthetic.next".into(),
            channel: "desktop-stable".into(),
            current_build: "100.1".into(),
            bundle_name: "Pilot Next".into(),
            public_key: key.public_key().as_ref().try_into().unwrap(),
            code_requirement: "signed-linux-inventory-v1".into(),
        };
        let build =
            json!({"source":"a".repeat(40),"version":"0.1.0","platform":"linux","arch":"x64"});
        let mut files = BTreeMap::new();
        for name in [
            "libexec/pilot-desktop",
            "libexec/pilot-desktop-update-helper",
            "libexec/pilot-visual-worker",
            "bin/pilot-next",
            "runtime/node/bin/node",
            "runtime/packages/daemon/src/main.ts",
            "runtime/packages/kernel/src/worker-entry.ts",
            "update-runtime-policy.json",
            "runtime-inputs.json",
            "rust-inputs.json",
            "updater-inputs.json",
            "runtime/runtime-build.json",
        ] {
            let path = root.join(name);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            let bytes = match name {
                "runtime/runtime-build.json" => serde_json::to_vec(&build).unwrap(),
                "runtime-inputs.json" => serde_json::to_vec(
                    &json!({"source":"a".repeat(40),"target":"x86_64-unknown-linux-gnu"}),
                )
                .unwrap(),
                "rust-inputs.json" | "updater-inputs.json" => serde_json::to_vec(
                    &json!({"tested_sha":"a".repeat(40),"target":"x86_64-unknown-linux-gnu","updater_configuration":{"schema":1,"mode":"configured","public_key":STANDARD.encode(trust.public_key),"repository":trust.repository,"application_id":trust.application_id,"build":"100.1","code_requirement":trust.code_requirement}}),
                )
                .unwrap(),
                _ => b"owned fixture bytes".to_vec(),
            };
            fs::write(&path, &bytes).unwrap();
            files.insert(name.to_owned(), json!({"kind":"file","path":name,"mode":420,"bytes":bytes.len(),"sha256":crate::transport::hex(&Sha256::digest(&bytes))}));
            for directory in Path::new(name)
                .parent()
                .unwrap()
                .ancestors()
                .filter(|p| !p.as_os_str().is_empty())
            {
                let name = directory.to_str().unwrap();
                files.insert(
                    name.into(),
                    json!({"kind":"directory","path":name,"mode":493}),
                );
            }
        }
        let value = json!({"schema":1,"kind":"linux-gui-distribution","source":"a".repeat(40),"target":"x86_64-unknown-linux-gnu","build":build,"bundle_build":"100.1","application_id":trust.application_id,"short_version":"0.1.0","bundled_launch":true,"installer":true,"updater":true,"native_visual_execution":false,"files":files.into_values().collect::<Vec<_>>()});
        seal(root, &value, &key);
        (trust, value, key)
    }
    fn seal(root: &Path, value: &serde_json::Value, key: &Ed25519KeyPair) {
        let bytes = serde_json::to_vec(value).unwrap();
        fs::write(root.join(INVENTORY), &bytes).unwrap();
        fs::write(
            root.join(SIGNATURE),
            STANDARD.encode(key.sign(&bytes).as_ref()),
        )
        .unwrap();
    }
    #[test]
    fn full_payload_signature_source_platform_modes_and_extra_files_fail_closed() {
        let root = crate::owned_tests::Temp::new();
        let (trust, value, key) = fixture(root.path());
        assert!(verify(root.path(), &trust, "100.1", Some("0.1.0")).is_ok());
        let mut wrong = trust.clone();
        wrong.public_key = [1; 32];
        assert!(matches!(
            verify(root.path(), &wrong, "100.1", None),
            Err(Error::Signature)
        ));
        for (field, bad) in [
            ("source", "b".repeat(40)),
            ("target", "aarch64-apple-darwin".into()),
            ("bundle_build", "99".into()),
        ] {
            let mut changed = value.clone();
            changed[field] = bad.into();
            seal(root.path(), &changed, &key);
            assert!(verify(root.path(), &trust, "100.1", None).is_err());
        }
        seal(root.path(), &value, &key);
        let file = root.path().join("libexec/pilot-desktop");
        fs::set_permissions(&file, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(verify(root.path(), &trust, "100.1", None).is_err());
        fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap();
        fs::write(root.path().join("unexpected"), b"extra").unwrap();
        assert!(verify(root.path(), &trust, "100.1", None).is_err());
        fs::remove_file(root.path().join("unexpected")).unwrap();
        fs::write(&file, b"wrong content").unwrap();
        assert!(verify(root.path(), &trust, "100.1", None).is_err());
    }
}
