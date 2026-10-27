//! Linux package integrity and immutable runtime retention. Not update authentication.
//! Published roots are never replaced/deleted, including after GUI replacement.
use super::*;
use std::{
    io::Write,
    os::{fd::AsRawFd, unix::fs::DirBuilderExt},
};

const MANIFEST: &str = "linux-gui-package.json";
const REQUIRED: &[&str] = &[
    "runtime/node/bin/node",
    "runtime/runtime-build.json",
    "runtime/packages/daemon/src/runtime-launch.ts",
    "runtime/packages/daemon/src/main.ts",
    "libexec/pilot-desktop",
    "libexec/pilot-visual-worker",
    "rust-inputs.json",
    "runtime-inputs.json",
    "bin/pilot-next",
];

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Package {
    schema: u32,
    kind: String,
    source: String,
    target: String,
    build: Build,
    bundled_launch: bool,
    installer: bool,
    updater: bool,
    native_visual_execution: bool,
    #[serde(default)]
    bundle_build: Option<String>,
    #[serde(default)]
    application_id: Option<String>,
    #[serde(default)]
    short_version: Option<String>,
    files: Vec<Entry>,
}

fn read_package(root: &Path) -> Result<(Package, Vec<u8>), Failure> {
    let mut raw = Vec::new();
    file(&root.join(MANIFEST), CAP)?
        .take(CAP + 1)
        .read_to_end(&mut raw)
        .map_err(|_| "Cannot read Linux package inventory.")?;
    if raw.len() as u64 > CAP {
        return Err("Linux package inventory is too large.");
    }
    let value =
        serde_json::from_slice(&raw).map_err(|_| "Linux package inventory is malformed.")?;
    Ok((value, raw))
}

pub(super) fn validate(
    root: &Path,
    cancel: &AtomicBool,
    deadline: Instant,
) -> Result<String, Failure> {
    let root = root
        .canonicalize()
        .map_err(|_| "Cannot resolve Linux package.")?;
    let (package, raw) = read_package(&root)?;
    let build = &package.build;
    let signature = root.join("linux-gui-package.sig");
    if signature
        .try_exists()
        .map_err(|_| "Cannot inspect Linux inventory signature.")?
    {
        file(&signature, 4096)?;
    }
    let production = package.kind == "linux-gui-distribution";
    if package.schema != 1 || (!production && package.kind != "unqualified-linux-gui-candidate")
        || package.target != "x86_64-unknown-linux-gnu"
        || package.source.len() != 40
        || !package.source.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        || build.schema != 1 || build.source != package.source
        || build.platform != "linux" || build.arch != "x64" || build.protocol != 1
        || !build.node.starts_with("24.") || !version(&build.node) || !version(&build.version)
        || package.files.len() > FILES
        // These package producer flags are evidence, not permission to bypass the
        // native visual sandbox or enable an installer/updater.
        || package.bundled_launch != production || package.installer != production || package.updater != production
        || package.native_visual_execution
        || (production && (package.bundle_build.as_ref().is_none_or(|v| v.is_empty())
            || package.application_id.as_ref().is_none_or(|v| v.is_empty())
            || package.short_version.as_deref() != Some(build.version.as_str())))
    {
        return Err("Linux package platform/source/policy is incompatible.");
    }
    let mut stamp = Vec::new();
    file(&root.join("runtime/runtime-build.json"), 4096)?
        .take(4097)
        .read_to_end(&mut stamp)
        .map_err(|_| "Cannot read Linux runtime identity.")?;
    if serde_json::from_slice::<Build>(&stamp).ok().as_ref() != Some(build) {
        return Err("Linux runtime source does not match its package.");
    }
    validate_inventory(
        &root,
        package.files,
        &[MANIFEST, "linux-gui-package.sig"],
        REQUIRED,
        cancel,
        deadline,
    )?;
    let inputs: serde_json::Value =
        serde_json::from_reader(file(&root.join("rust-inputs.json"), CAP)?)
            .map_err(|_| "Linux executable source receipt is malformed.")?;
    if inputs["tested_sha"] != package.source || inputs["target"] != package.target {
        return Err("Linux executable source does not match its runtime.");
    }
    Ok(format!("{:x}", Sha256::digest(raw)))
}

fn private_directory(path: &Path) -> Result<(), Failure> {
    let m = fs::symlink_metadata(path).map_err(|_| "Cannot inspect retained runtime store.")?;
    // Linux POSIX ACL effective permissions are bounded by the group mode mask.
    // A private 0700 directory cannot grant another named user access.
    if !m.is_dir() || m.uid() != unsafe { libc::geteuid() } || m.mode() & 0o077 != 0 {
        return Err("Retained runtime store is not private and owned.");
    }
    Ok(())
}

/// One permanent lock serializes publication. Never unlink its inode, replace a
/// retained root, or infer that an unknown existing root is safe to overwrite.
pub(super) fn publish(
    root: &Path,
    store: &Path,
    cancel: &AtomicBool,
    deadline: Instant,
) -> Result<PathBuf, Failure> {
    let id = validate(root, cancel, deadline)?;
    if !store.is_absolute() || store.starts_with(root) {
        return Err("Invalid retained runtime store.");
    }
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(store)
        .map_err(|_| "Cannot create retained runtime store.")?;
    private_directory(store)?;
    let store = store
        .canonicalize()
        .map_err(|_| "Cannot resolve retained store.")?;
    for parent in store.ancestors().skip(1) {
        let m = fs::metadata(parent).map_err(|_| "Cannot inspect retained store parents.")?;
        let uid = unsafe { libc::geteuid() };
        if !m.is_dir()
            || (m.uid() != uid && m.uid() != 0)
            || (m.mode() & 0o022 != 0 && !(m.uid() == 0 && m.mode() & 0o1000 != 0))
        {
            return Err("Retained runtime store parent is writable by another user.");
        }
    }
    let lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(store.join(".store.lock"))
        .map_err(|_| "Cannot open retained runtime publication lease.")?;
    let m = lock
        .metadata()
        .map_err(|_| "Cannot inspect retained runtime lease.")?;
    if !m.is_file()
        || m.nlink() != 1
        || m.uid() != unsafe { libc::geteuid() }
        || m.mode() & 0o077 != 0
    {
        return Err("Retained runtime lease is unsafe.");
    }
    if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err("Retained runtime publication is busy.");
    }
    let destination = store.join(&id);
    if destination
        .try_exists()
        .map_err(|_| "Cannot inspect retained capsule.")?
    {
        private_directory(&destination)?;
        let payload = destination.join("payload");
        if fs::symlink_metadata(&payload)
            .map_err(|_| "Cannot inspect retained payload.")?
            .file_type()
            .is_symlink()
        {
            return Err("Retained payload is redirected.");
        }
        if validate(&payload, cancel, deadline)? != id {
            return Err("Retained runtime identity changed.");
        }
        return Ok(payload);
    }
    let stage = store.join(format!(".stage-{}", uuid::Uuid::new_v4()));
    fs::DirBuilder::new()
        .mode(0o700)
        .create(&stage)
        .map_err(|_| "Cannot stage retained runtime.")?;
    let result = (|| {
        let payload = stage.join("payload");
        fs::create_dir(&payload).map_err(|_| "Cannot stage runtime payload.")?;
        copy_tree(root, &payload, cancel, deadline)?;
        if validate(&payload, cancel, deadline)? != id {
            return Err("Runtime changed during retention.");
        }
        let directory = File::open(&stage).map_err(|_| "Cannot open staged runtime.")?;
        #[cfg(target_os = "linux")]
        // One Linux filesystem barrier persists the complete staged tree before
        // publication. Per-file fsync serialized 24k journal transactions and
        // prevented the real payload from completing its startup budget.
        if unsafe { libc::syncfs(directory.as_raw_fd()) } != 0 {
            return Err("Cannot persist retained runtime.");
        }
        #[cfg(not(target_os = "linux"))]
        directory
            .sync_all()
            .map_err(|_| "Cannot persist retained runtime.")?;
        check(cancel, deadline)?;
        // The private store's permanent exclusive lease excludes other publishers.
        fs::rename(&stage, &destination).map_err(|_| "Cannot publish retained runtime.")?;
        File::open(&store)
            .and_then(|f| f.sync_all())
            .map_err(|_| "Cannot persist runtime publication.")?;
        Ok(destination.join("payload"))
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&stage);
    }
    result
}

fn copy_tree(
    source: &Path,
    destination: &Path,
    cancel: &AtomicBool,
    deadline: Instant,
) -> Result<(), Failure> {
    for entry in fs::read_dir(source).map_err(|_| "Cannot read runtime directory.")? {
        check(cancel, deadline)?;
        let entry = entry.map_err(|_| "Cannot read runtime entry.")?;
        let from = entry.path();
        let to = destination.join(entry.file_name());
        let m = fs::symlink_metadata(&from).map_err(|_| "Cannot inspect runtime entry.")?;
        if m.is_dir() {
            fs::create_dir(&to).map_err(|_| "Cannot retain runtime directory.")?;
            copy_tree(&from, &to, cancel, deadline)?;
            fs::set_permissions(&to, m.permissions())
                .map_err(|_| "Cannot retain runtime permissions.")?;
        } else if m.file_type().is_symlink() {
            let target = fs::read_link(&from).map_err(|_| "Cannot read runtime link.")?;
            std::os::unix::fs::symlink(target, &to).map_err(|_| "Cannot retain runtime link.")?;
        } else {
            let mut input = file(&from, 256 * 1024 * 1024)?;
            let mut output = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(m.mode() & 0o777)
                .open(&to)
                .map_err(|_| "Cannot retain runtime file.")?;
            let mut buffer = [0_u8; 64 * 1024];
            let mut bytes = 0;
            loop {
                check(cancel, deadline)?;
                let n = input
                    .read(&mut buffer)
                    .map_err(|_| "Cannot read runtime file.")?;
                if n == 0 {
                    break;
                }
                bytes += n;
                if bytes > 256 * 1024 * 1024 {
                    return Err("Runtime file grew during retention.");
                }
                output
                    .write_all(&buffer[..n])
                    .map_err(|_| "Cannot retain runtime file.")?;
            }
            #[cfg(not(target_os = "linux"))]
            output
                .sync_all()
                .map_err(|_| "Cannot persist runtime file.")?;
        }
    }
    #[cfg(not(target_os = "linux"))]
    File::open(destination)
        .and_then(|f| f.sync_all())
        .map_err(|_| "Cannot persist runtime directory.")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
    #[cfg(target_os = "linux")]
    #[test]
    #[ignore = "requires an explicitly supplied owned Linux package/store"]
    fn linux_owned_full_payload_publication() {
        let source =
            PathBuf::from(std::env::var_os("PILOT_OWNED_LINUX_PACKAGE").expect("owned package"));
        let store =
            PathBuf::from(std::env::var_os("PILOT_OWNED_LINUX_STORE").expect("owned store"));
        let began = Instant::now();
        let deadline = began + Duration::from_secs(180);
        let cancel = AtomicBool::new(false);
        validate(&source, &cancel, deadline).unwrap();
        println!("owned package validation {:?}", began.elapsed());
        let copy = Instant::now();
        publish(&source, &store, &cancel, deadline).unwrap();
        println!("owned package publication {:?}", copy.elapsed());
    }
    struct Fixture {
        parent: PathBuf,
        package: PathBuf,
        store: PathBuf,
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.parent);
        }
    }
    impl Fixture {
        fn new() -> Self {
            // Canonicalize temp root on macOS too; /var is a system symlink there.
            let parent = std::env::temp_dir()
                .canonicalize()
                .unwrap()
                .join(format!("linux-retention-{}", uuid::Uuid::new_v4()));
            let package = parent.join("GUI with spaces");
            fs::create_dir_all(&package).unwrap();
            let f = Self {
                store: parent.join("private store"),
                parent,
                package,
            };
            for name in REQUIRED {
                let path = f.package.join(name);
                fs::create_dir_all(path.parent().unwrap()).unwrap();
                fs::write(path, b"fixture").unwrap();
            }
            fs::write(
                f.package.join("runtime/runtime-build.json"),
                serde_json::to_vec(&f.build()).unwrap(),
            )
            .unwrap();
            fs::write(
                f.package.join("rust-inputs.json"),
                serde_json::to_vec(
                    &json!({"tested_sha":"a".repeat(40),"target":"x86_64-unknown-linux-gnu"}),
                )
                .unwrap(),
            )
            .unwrap();
            f.seal();
            f
        }
        fn build(&self) -> Value {
            json!({"schema":1,"source":"a".repeat(40),"version":"1.70.0","protocol":1,"platform":"linux","arch":"x64","node":"24.21.0"})
        }
        fn seal(&self) {
            let mut entries = Vec::new();
            for name in enumerate(
                &self.package,
                &[MANIFEST],
                &AtomicBool::new(false),
                Instant::now() + Duration::from_secs(2),
            )
            .unwrap()
            {
                let path = self.package.join(&name);
                let m = fs::symlink_metadata(&path).unwrap();
                entries.push(if m.file_type().is_symlink() {
                    json!({"path":name,"kind":"link","target":fs::read_link(path).unwrap()})
                } else if m.is_dir() {
                    json!({"path":name,"kind":"directory","mode":m.mode() & 0o7777})
                } else {
                    json!({"path":name,"kind":"file","bytes":m.len(),"mode":m.mode() & 0o7777,"sha256":format!("{:x}",Sha256::digest(fs::read(path).unwrap()))})
                });
            }
            fs::write(self.package.join(MANIFEST), serde_json::to_vec(&json!({
                "schema":1,"kind":"unqualified-linux-gui-candidate","source":"a".repeat(40),
                "target":"x86_64-unknown-linux-gnu","build":self.build(),"files":entries,
                "bundled_launch":false,"installer":false,"updater":false,"native_visual_execution":false
            })).unwrap()).unwrap();
        }
        fn validate(&self) -> Result<String, Failure> {
            validate(
                &self.package,
                &AtomicBool::new(false),
                Instant::now() + Duration::from_secs(5),
            )
        }
        fn publish(&self) -> Result<PathBuf, Failure> {
            publish(
                &self.package,
                &self.store,
                &AtomicBool::new(false),
                Instant::now() + Duration::from_secs(5),
            )
        }
    }
    #[test]
    fn linux_capsule_survives_source_removal_and_reuses_exact_publication() {
        let f = Fixture::new();
        std::os::unix::fs::symlink("node/bin/node", f.package.join("runtime/node-link")).unwrap();
        f.seal();
        let id = f.validate().unwrap();
        let retained = f.publish().unwrap();
        assert_eq!(retained, f.store.join(&id).join("payload"));
        assert_eq!(f.publish().unwrap(), retained);
        fs::remove_dir_all(&f.package).unwrap();
        assert_eq!(
            validate(
                &retained,
                &AtomicBool::new(false),
                Instant::now() + Duration::from_secs(5)
            )
            .unwrap(),
            id
        );
        assert_eq!(
            fs::read(retained.join("runtime/node-link")).unwrap(),
            b"fixture"
        );
    }
    #[test]
    fn linux_package_refuses_source_platform_hash_extra_and_escaping_links() {
        for fault in [
            "source",
            "platform",
            "hash",
            "extra",
            "signature-extra",
            "escape",
            "receipt",
        ] {
            let f = Fixture::new();
            match fault {
                "source" | "platform" => {
                    let mut build = f.build();
                    build[fault] = json!(if fault == "source" {
                        "b".repeat(40)
                    } else {
                        "darwin".into()
                    });
                    fs::write(
                        f.package.join("runtime/runtime-build.json"),
                        serde_json::to_vec(&build).unwrap(),
                    )
                    .unwrap();
                    f.seal();
                }
                "hash" => fs::write(f.package.join("runtime/node/bin/node"), b"changed").unwrap(),
                "extra" => fs::write(f.package.join("surprise"), b"extra").unwrap(),
                "signature-extra" => {
                    fs::create_dir_all(f.package.join("Contents/_CodeSignature")).unwrap();
                    fs::write(
                        f.package.join("Contents/_CodeSignature/unrecorded"),
                        b"extra",
                    )
                    .unwrap();
                }
                "escape" => {
                    std::os::unix::fs::symlink("/etc/passwd", f.package.join("runtime/escape"))
                        .unwrap();
                    f.seal();
                }
                "receipt" => {
                    fs::write(f.package.join("rust-inputs.json"), b"{}").unwrap();
                    f.seal();
                }
                _ => unreachable!(),
            }
            assert!(f.validate().is_err(), "fault {fault}");
        }
    }
    #[test]
    fn linux_production_envelope_keeps_integrity_separate_from_update_authentication() {
        let f = Fixture::new();
        let path = f.package.join(MANIFEST);
        let mut value: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        value["kind"] = json!("linux-gui-distribution");
        value["bundle_build"] = json!("17000");
        value["application_id"] = json!("fixture.application");
        value["short_version"] = json!("1.70.0");
        for name in ["bundled_launch", "installer", "updater"] {
            value[name] = json!(true);
        }
        fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        fs::write(
            f.package.join("linux-gui-package.sig"),
            b"fixture, not an authenticated signature",
        )
        .unwrap();
        assert!(f.validate().is_ok());
        value["native_visual_execution"] = json!(true);
        fs::write(path, serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(f.validate().is_err());
    }
    #[test]
    fn linux_publication_refuses_contention_corruption_cancel_and_redirect_without_repair() {
        let f = Fixture::new();
        let retained = f.publish().unwrap();
        let lock = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(f.store.join(".store.lock"))
            .unwrap();
        assert_eq!(
            unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
            0
        );
        assert!(f.publish().unwrap_err().contains("busy"));
        drop(lock);
        assert!(
            publish(
                &f.package,
                &f.store,
                &AtomicBool::new(true),
                Instant::now() + Duration::from_secs(5)
            )
            .is_err()
        );
        fs::write(retained.join("runtime/node/bin/node"), b"corrupt").unwrap();
        assert!(f.publish().is_err());
        assert_eq!(
            fs::read(retained.join("runtime/node/bin/node")).unwrap(),
            b"corrupt"
        );
        let redirected = f.parent.join("redirected store");
        std::os::unix::fs::symlink(&f.store, &redirected).unwrap();
        assert!(
            publish(
                &f.package,
                &redirected,
                &AtomicBool::new(false),
                Instant::now() + Duration::from_secs(5)
            )
            .is_err()
        );
    }
}
