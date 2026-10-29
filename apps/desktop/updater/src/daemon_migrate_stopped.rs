//! Offline adoption is deliberately separate from the live reservation handoff.
use super::*;
use std::net::{Ipv4Addr, TcpListener};

/// Explicitly adopt the stopped, known Swift launch agent without enrolling its profile.
/// `app` is either the installed signed Next app or its verified immutable capsule.
/// Trust must come from the caller's compiled release configuration, never CLI input.
///
/// # Errors
/// Refuses loaded services (even without a PID), listeners, held owner leases,
/// unknown definitions and incomplete journals. After durable migration intent,
/// every failure is `Unknown` and must be inspected, never automatically replayed.
pub fn migrate_stopped(app: &Path, trust: &Trust, cancel: &AtomicBool) -> Result<(), Failure> {
    verified(trust.validate())?;
    let home =
        io(PathBuf::from(std::env::var_os("HOME").ok_or(Failure::Unverified)?).canonicalize())?;
    migrate_at(&home, LABEL, app, trust, cancel)
}

pub(super) fn migrate_at(
    home: &Path,
    label: &str,
    app: &Path,
    trust: &Trust,
    cancel: &AtomicBool,
) -> Result<(), Failure> {
    let home = io(home.canonicalize())?;
    let path = home
        .join("Library/LaunchAgents")
        .join(format!("{label}.plist"));
    verified(installer::validate_parents(
        path.parent().ok_or(Failure::Unverified)?,
    ))?;
    let stamp = private_regular(&path)?;
    let original_bytes = io(fs::read(&path))?;
    let original = plist(&path)?;
    let env = original["EnvironmentVariables"]
        .as_object()
        .ok_or(Failure::Unsupported)?;
    let profile = env
        .get("PILOT_HOME")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".local/share/pilot"));
    let port = env
        .get("PILOT_PORT")
        .and_then(Value::as_str)
        .and_then(|s| s.parse::<u16>().ok())
        .filter(|n| *n != 0)
        .ok_or(Failure::Unsupported)?;
    let location = Location {
        home: io(profile.canonicalize())?,
        port,
        policy: coordination::POLICY_NAMES
            .iter()
            .filter_map(|name| {
                env.get(*name)
                    .and_then(Value::as_str)
                    .map(|v| ((*name).to_owned(), v.to_owned()))
            })
            .collect(),
    };
    let _lock = super::super::native::lock(&location)?;
    super::super::native::no_incomplete_handoff(&location)?;
    // Pending writes are retained evidence too, not permission to create new intent.
    for (index, entry) in io(fs::read_dir(&location.home))?.take(4097).enumerate() {
        if index == 4096 {
            return Err(Failure::Unverified);
        }
        let name = io(entry)?.file_name();
        let name = name.to_str().ok_or(Failure::Unverified)?;
        if name.starts_with(".daemon-upgrade-") && name.ends_with(".pending") {
            return Err(Failure::Unknown);
        }
    }
    validate_legacy(&original, &home, &location, label)?;
    if path
        .with_extension("plist.next-owner")
        .try_exists()
        .map_err(|_| Failure::Unverified)?
    {
        return Err(Failure::Unknown);
    }
    let service = format!("gui/{}/{label}", unsafe { libc::geteuid() });
    stopped(&location, &service)?;
    let daemon = identity(&location.home.join("daemon-id"))?;
    let lineage = identity(&location.home.join("storage-lineage"))?;
    let owner = if location
        .home
        .join(".daemon-owner.json")
        .try_exists()
        .map_err(|_| Failure::Unverified)?
    {
        verified(coordination::record(&location))?
    } else {
        Value::Null
    };
    // Existence is mandatory: normal main.ts must preserve the existing managed row.
    private_regular(&location.home.join(".daemon-owner.sqlite"))?;
    let lease = Lease::acquire(&location.home.join(".daemon-owner.sqlite"))?;
    let app = io(app.canonicalize())?;
    let current = if app
        .parent()
        .and_then(Path::parent)
        .and_then(Path::file_name)
        .is_some_and(|n| n == runtime::STORE_NAME)
    {
        app
    } else {
        verified(runtime::publish_cancellable(
            &app,
            &home
                .join("Library/Application Support")
                .join(runtime::STORE_NAME),
            trust,
            &installer::NativePlatform,
            Instant::now() + Duration::from_secs(45),
            cancel,
        ))?
    };
    let mut host = LaunchAgent {
        location,
        current,
        trust,
        daemon: daemon.trim(),
        lineage: lineage.trim(),
        cancel,
        service,
        label: label.into(),
        home,
        plist: path,
        original,
        replacement: Value::Null,
        owner,
        watch: None,
        lock: None,
        plist_stamp: Some((stamp.dev(), stamp.ino())),
        reservation: None,
        original_backup: None,
    };
    host.verify_target()?;
    host.replacement = replacement(&host.original, &host.location, &host.current)?;
    revalidate(&host, &original_bytes, &daemon, &lineage, &lease)?;
    if cancel.load(Ordering::Acquire) {
        return Err(Failure::Cancelled);
    }
    // Back up the exact bytes, not a JSON/plutil reserialization. Sync before intent.
    let backup = host.location.home.join(format!(
        ".daemon-upgrade-original-{}.plist",
        verified(coordination::random_hex())?
    ));
    verified(installer::write_new(&backup, &original_bytes))?;
    io(io(File::open(&host.location.home))?.sync_all())?;
    host.original_backup = Some(backup);
    revalidate(&host, &original_bytes, &daemon, &lineage, &lease)?;
    if cancel.load(Ordering::Acquire) {
        return Err(Failure::Cancelled);
    }
    let mut lease = Some(lease);
    // No close/open of the owner DB after BEGIN EXCLUSIVE: POSIX locks are process-wide.
    commit(|step| match step {
        Step::Intent => host.journal("migrating-stopped"),
        Step::Claim => claim(&host.plist, &host.location),
        Step::Replace => {
            revalidate(
                &host,
                &original_bytes,
                &daemon,
                &lineage,
                lease.as_ref().ok_or(Failure::Unverified)?,
            )?;
            host.replace_definition()
        }
        Step::Starting => host.journal("starting"),
        Step::Start => {
            host.verify_target()?;
            unloaded(&host.service)?;
            no_listener(&host.location)?;
            lease
                .as_ref()
                .ok_or(Failure::Unverified)?
                .verify(&host.location.home.join(".daemon-owner.sqlite"))?;
            drop(lease.take()); // Only immediately before the one explicit bootstrap.
            host.bootstrap()
        }
        Step::Verify => {
            super::super::native::wait_registered(&host.location, &host.current)?;
            host.verify_started()?;
            let output = command("/bin/launchctl", &["print".as_ref(), host.service.as_ref()])?;
            loaded_environment(
                std::str::from_utf8(&output).map_err(|_| Failure::Unverified)?,
                &host.replacement,
            )?;
            if identity(&host.location.home.join("daemon-id"))? != daemon
                || identity(&host.location.home.join("storage-lineage"))? != lineage
            {
                return Err(Failure::Unverified);
            }
            Ok(())
        }
        Step::Complete => host.journal("complete"),
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Step {
    Intent,
    Claim,
    Replace,
    Starting,
    Start,
    Verify,
    Complete,
}
fn commit(mut step: impl FnMut(Step) -> Result<(), Failure>) -> Result<(), Failure> {
    for next in [
        Step::Intent,
        Step::Claim,
        Step::Replace,
        Step::Starting,
        Step::Start,
        Step::Verify,
        Step::Complete,
    ] {
        step(next).map_err(|_| Failure::Unknown)?;
    }
    Ok(())
}

fn stopped(location: &Location, service: &str) -> Result<(), Failure> {
    unloaded(service)?;
    if coordination::owner_live(&location.home) {
        return Err(Failure::Busy);
    }
    no_listener(location)
}
fn unloaded(service: &str) -> Result<(), Failure> {
    // launchctl's documented ESRCH exit is distinct from timeout/permission/spawn errors.
    let (status, out, error) = super::super::native::command_capture(
        "/bin/launchctl",
        &["print".as_ref(), service.as_ref()],
        true,
    )?;
    let (domain, label) = service.rsplit_once('/').ok_or(Failure::Unverified)?;
    let uid = domain.strip_prefix("gui/").ok_or(Failure::Unverified)?;
    let expected =
        format!("Bad request.\nCould not find service \"{label}\" in domain for user gui: {uid}\n");
    absent(status.code(), &out, &error, expected.as_bytes())
}
fn absent(code: Option<i32>, out: &[u8], error: &[u8], expected: &[u8]) -> Result<(), Failure> {
    match code {
        Some(113) if out.is_empty() && error == expected => {}
        Some(0) => return Err(Failure::Busy),
        _ => return Err(Failure::Unverified),
    }
    Ok(())
}
fn loaded_environment(text: &str, definition: &Value) -> Result<(), Failure> {
    let mut environment = serde_json::Map::new();
    let mut in_environment = false;
    let mut seen = false;
    let mut fields = std::collections::BTreeMap::new();
    for line in text.lines().map(str::trim) {
        if line == "environment = {" {
            if seen {
                return Err(Failure::Unverified);
            }
            seen = true;
            in_environment = true;
        } else if in_environment {
            if line == "}" {
                in_environment = false;
                continue;
            }
            let (key, value) = line.split_once(" => ").ok_or(Failure::Unverified)?;
            if environment.insert(key.to_owned(), json!(value)).is_some() {
                return Err(Failure::Unverified);
            }
        } else if let Some((key, value)) = line.split_once(" = ")
            && ["program", "working directory", "stdout path", "stderr path"].contains(&key)
            && fields.insert(key, value).is_some()
        {
            return Err(Failure::Unverified);
        }
    }
    if in_environment || !seen {
        return Err(Failure::Unverified);
    }
    for (name, value) in definition["EnvironmentVariables"]
        .as_object()
        .ok_or(Failure::Unverified)?
    {
        if environment.get(name) != Some(value) {
            return Err(Failure::Unverified);
        }
    }
    for (native, field) in [
        ("working directory", "WorkingDirectory"),
        ("stdout path", "StandardOutPath"),
        ("stderr path", "StandardErrorPath"),
    ] {
        if fields.get(native).copied() != definition[field].as_str() {
            return Err(Failure::Unverified);
        }
    }
    if fields.get("program").copied() != definition["ProgramArguments"][0].as_str() {
        return Err(Failure::Unverified);
    }
    Ok(())
}
fn no_listener(location: &Location) -> Result<(), Failure> {
    // Bind, rather than HTTP probe: any listener or wildcard conflict must refuse.
    let _listener =
        TcpListener::bind((Ipv4Addr::LOCALHOST, location.port)).map_err(|_| Failure::Busy)?;
    Ok(())
}

fn revalidate(
    host: &LaunchAgent<'_>,
    bytes: &[u8],
    daemon: &str,
    lineage: &str,
    lease: &Lease,
) -> Result<(), Failure> {
    lease.verify(&host.location.home.join(".daemon-owner.sqlite"))?;
    let meta = private_regular(&host.plist)?;
    if Some((meta.dev(), meta.ino())) != host.plist_stamp
        || io(fs::read(&host.plist))? != bytes
        || plist(&host.plist)? != host.original
        || identity(&host.location.home.join("daemon-id"))? != daemon
        || identity(&host.location.home.join("storage-lineage"))? != lineage
    {
        return Err(Failure::Unverified);
    }
    unloaded(&host.service)?;
    no_listener(&host.location)
}

// Use the same SQLite locking protocol as Node, not flock and not a lock query.
// No CREATE flag, schema changes, managed-row writes or busy wait are permitted.
#[link(name = "sqlite3")]
unsafe extern "C" {
    fn sqlite3_open_v2(
        path: *const libc::c_char,
        db: *mut *mut libc::c_void,
        flags: libc::c_int,
        vfs: *const libc::c_char,
    ) -> libc::c_int;
    fn sqlite3_exec(
        db: *mut libc::c_void,
        sql: *const libc::c_char,
        callback: Option<
            unsafe extern "C" fn(
                *mut libc::c_void,
                libc::c_int,
                *mut *mut libc::c_char,
                *mut *mut libc::c_char,
            ) -> libc::c_int,
        >,
        arg: *mut libc::c_void,
        error: *mut *mut libc::c_char,
    ) -> libc::c_int;
    fn sqlite3_close(db: *mut libc::c_void) -> libc::c_int;
}
// SAFETY: sqlite3_exec is synchronous and supplies our unique live u32 pointer.
unsafe extern "C" fn count_row(
    arg: *mut libc::c_void,
    _: libc::c_int,
    _: *mut *mut libc::c_char,
    _: *mut *mut libc::c_char,
) -> libc::c_int {
    unsafe {
        *arg.cast::<u32>() += 1;
    }
    0
}
struct Lease(*mut libc::c_void, (u64, u64));
impl Lease {
    fn acquire(path: &Path) -> Result<Self, Failure> {
        use std::os::unix::ffi::OsStrExt;
        let before = private_regular(path)?;
        if before.mode() & 0o077 != 0 {
            return Err(Failure::Unverified);
        }
        let path_c =
            std::ffi::CString::new(path.as_os_str().as_bytes()).map_err(|_| Failure::Unverified)?;
        let mut handle = std::ptr::null_mut();
        // SAFETY: NUL-terminated path and valid output pointer; RW without CREATE, NOFOLLOW.
        let result = unsafe {
            sqlite3_open_v2(
                path_c.as_ptr(),
                &mut handle,
                2 | 0x01000000,
                std::ptr::null(),
            )
        };
        let lease = Self(handle, (before.dev(), before.ino()));
        if result != 0 || handle.is_null() {
            return Err(Failure::Unverified);
        }
        lease.exec(c"BEGIN EXCLUSIVE")?;
        // Metadata only. ACL validation opens/closes a descriptor and would release
        // this process's POSIX record locks on the owner's SQLite inode.
        let after = io(fs::symlink_metadata(path))?;
        if (before.dev(), before.ino()) != (after.dev(), after.ino()) {
            return Err(Failure::Unverified);
        }
        // Validate the existing singleton without modifying it. Both managed values are preserved.
        let mut rows = 0_u32;
        // SAFETY: callback receives only the live stack counter, no retained pointers.
        let result = unsafe {
            sqlite3_exec(handle,
            c"SELECT managed FROM runtime_owner WHERE singleton=1 AND managed IN (0,1) AND (SELECT count(*) FROM runtime_owner)=1 AND (SELECT user_version FROM pragma_user_version)=1".as_ptr(),
            Some(count_row), (&mut rows as *mut u32).cast(), std::ptr::null_mut())
        };
        if result != 0 || rows != 1 {
            return Err(Failure::Unverified);
        }
        Ok(lease)
    }
    fn verify(&self, path: &Path) -> Result<(), Failure> {
        let meta = io(fs::symlink_metadata(path))?;
        if (meta.dev(), meta.ino()) != self.1
            || !meta.is_file()
            || meta.nlink() != 1
            || meta.uid() != unsafe { libc::geteuid() }
            || meta.mode() & 0o077 != 0
        {
            return Err(Failure::Unverified);
        }
        Ok(())
    }
    fn exec(&self, sql: &std::ffi::CStr) -> Result<(), Failure> {
        // SAFETY: live owned connection; static SQL, no callback/error allocation.
        match unsafe {
            sqlite3_exec(
                self.0,
                sql.as_ptr(),
                None,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        } {
            0 => Ok(()),
            5 | 6 => Err(Failure::Busy),
            _ => Err(Failure::Unverified),
        }
    }
}
impl Drop for Lease {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: exclusively owned connection; close rolls back the read-only transaction.
            unsafe {
                sqlite3_close(self.0);
            }
        }
    }
}

fn identity(path: &Path) -> Result<String, Failure> {
    private_regular(path)?;
    let value = io(fs::read_to_string(path))?;
    let id = value.trim();
    if id.len() != 36
        || !id.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
            }
        })
        || id.as_bytes()[14] != b'4'
        || !b"89ab".contains(&id.as_bytes()[19])
    {
        return Err(Failure::Unverified);
    }
    Ok(value)
}

fn validate_legacy(
    value: &Value,
    home: &Path,
    location: &Location,
    label: &str,
) -> Result<(), Failure> {
    validate_definition(value, home, location, label)?;
    if value.get("PilotNextManaged").is_some() {
        return Err(Failure::Unsupported);
    }
    let node = Path::new(
        value["ProgramArguments"][0]
            .as_str()
            .ok_or(Failure::Unsupported)?,
    );
    let app = node.ancestors().nth(6).ok_or(Failure::Unsupported)?;
    // The old app may have been removed. Its path is evidence of layout, not executable trust.
    if app.file_name().is_none_or(|n| n != "Pilot.app")
        || app.components().any(|c| {
            matches!(
                c,
                std::path::Component::ParentDir | std::path::Component::CurDir
            )
        })
        || value["ProgramArguments"]
            != json!([
                app.join(crate::layout::RUNTIME).join("node/bin/node"),
                app.join(crate::layout::RUNTIME)
                    .join("packages/daemon/src/main.ts")
            ])
    {
        return Err(Failure::Unsupported);
    }
    let path = value["EnvironmentVariables"]["PATH"]
        .as_str()
        .ok_or(Failure::Unsupported)?;
    if path.is_empty() || path.contains(['\n', '\r']) {
        return Err(Failure::Unsupported);
    }
    Ok(())
}

fn replacement(original: &Value, location: &Location, current: &Path) -> Result<Value, Failure> {
    let mut value = original.clone();
    let runtime = current.join(crate::layout::RUNTIME);
    value["PilotNextManaged"] = json!(true);
    value["ProgramArguments"] = json!([
        runtime.join("node/bin/node"),
        runtime.join("packages/daemon/src/main.ts")
    ]);
    value["EnvironmentVariables"]["PILOT_HOME"] = json!(location.home);
    let path = original["EnvironmentVariables"]["PATH"]
        .as_str()
        .ok_or(Failure::Unsupported)?;
    value["EnvironmentVariables"]["PATH"] =
        json!(format!("{}:{path}", runtime.join("node/bin").display()));
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "pilot-offline-migration-{}",
                coordination::random_hex().unwrap()
            ));
            fs::create_dir(&path).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
            Self(path.canonicalize().unwrap())
        }
        fn location(&self) -> Location {
            Location {
                home: self.0.clone(),
                port: 4319,
                policy: Default::default(),
            }
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    fn definition(home: &Path) -> Value {
        let log = home.join("Library/Logs/Pilot/pilotd.log");
        json!({"Label":LABEL,"ProgramArguments":["/Applications/Pilot.app/Contents/Resources/runtime/node/bin/node","/Applications/Pilot.app/Contents/Resources/runtime/packages/daemon/src/main.ts"],"WorkingDirectory":home,"EnvironmentVariables":{"PATH":"/legacy/node/bin:/usr/bin","PILOT_HOME":home,"PILOT_PORT":"4319","PILOT_AGENT_DIR":"/private/agent"},"RunAtLoad":true,"KeepAlive":true,"ThrottleInterval":10,"ProcessType":"Interactive","StandardOutPath":log,"StandardErrorPath":log})
    }
    #[test]
    fn offline_known_missing_swift_bundle_preserves_service_and_profile() {
        let temp = Temp::new();
        let original = definition(&temp.0);
        let location = temp.location();
        assert_eq!(
            validate_legacy(&original, &temp.0, &location, LABEL),
            Ok(())
        );
        let next = replacement(&original, &location, Path::new("/capsule/Pilot Next.app")).unwrap();
        let mut preserved = next.clone();
        preserved
            .as_object_mut()
            .unwrap()
            .remove("PilotNextManaged");
        preserved["ProgramArguments"] = original["ProgramArguments"].clone();
        preserved["EnvironmentVariables"]["PATH"] =
            original["EnvironmentVariables"]["PATH"].clone();
        assert_eq!(preserved, original);
        assert_eq!(next["ProgramArguments"].as_array().unwrap().len(), 2);
        for (key, value) in [
            (
                "ProgramArguments",
                json!(["/usr/bin/node", "/checkout/packages/daemon/src/main.ts"]),
            ),
            (
                "ProgramArguments",
                json!([
                    "/Applications/Other.app/Contents/Resources/runtime/node/bin/node",
                    "/Applications/Other.app/Contents/Resources/runtime/packages/daemon/src/main.ts"
                ]),
            ),
            (
                "ProgramArguments",
                json!([
                    "/Applications/Pilot.app/Contents/Resources/runtime/node/bin/node",
                    "/other/main.ts"
                ]),
            ),
            (
                "ProgramArguments",
                json!([
                    "/Applications/Pilot.app/Contents/Resources/runtime/node/bin/node",
                    "/Applications/Pilot.app/Contents/Resources/runtime/packages/daemon/src/main.ts",
                    "--bundled-runtime"
                ]),
            ),
            ("PilotNextManaged", json!(true)),
            ("KeepAlive", json!({"SuccessfulExit":false})),
            (
                "EnvironmentVariables",
                json!({"PATH":"/usr/bin","PILOT_HOME":temp.0,"PILOT_PORT":"4319","NODE_OPTIONS":"--import /other"}),
            ),
        ] {
            let mut changed = original.clone();
            changed[key] = value;
            assert!(
                validate_legacy(&changed, &temp.0, &location, LABEL).is_err(),
                "{key}"
            );
        }
    }
    #[test]
    fn absence_requires_exact_launchctl_evidence_not_just_failure() {
        let expected = b"Bad request.\nCould not find service \"com.babariviere.pilot.daemon\" in domain for user gui: 501\n";
        assert_eq!(absent(Some(113), b"", expected, expected), Ok(()));
        assert_eq!(
            absent(Some(0), b"spawn scheduled", b"", expected),
            Err(Failure::Busy)
        );
        for (code, out, error) in [
            (None, b"".as_slice(), expected.as_slice()),
            (Some(1), b"", expected),
            (Some(113), b"", b"domain unavailable"),
            (Some(113), b"unexpected output", expected),
        ] {
            assert_eq!(absent(code, out, error, expected), Err(Failure::Unverified));
        }
    }
    #[test]
    fn loaded_native_environment_and_paths_must_match_preserved_definition() {
        let temp = Temp::new();
        let next = replacement(
            &definition(&temp.0),
            &temp.location(),
            Path::new("/capsule/Pilot Next.app"),
        )
        .unwrap();
        let mut text = format!(
            "program = {}\nworking directory = {}\nstdout path = {}\nstderr path = {}\nenvironment = {{\n",
            next["ProgramArguments"][0].as_str().unwrap(),
            temp.0.display(),
            next["StandardOutPath"].as_str().unwrap(),
            next["StandardErrorPath"].as_str().unwrap()
        );
        for (key, value) in next["EnvironmentVariables"].as_object().unwrap() {
            text.push_str(&format!("{key} => {}\n", value.as_str().unwrap()));
        }
        text.push_str("XPC_SERVICE_NAME => com.babariviere.pilot.daemon\n}\n");
        assert_eq!(loaded_environment(&text, &next), Ok(()));
        for changed in [
            text.replace("PILOT_PORT => 4319", "PILOT_PORT => 1"),
            text.replace(
                "PILOT_AGENT_DIR => /private/agent",
                "PILOT_AGENT_DIR => /other",
            ),
            text.replace("working directory =", "other directory ="),
            text.replace("program =", "other ="),
        ] {
            assert_eq!(
                loaded_environment(&changed, &next),
                Err(Failure::Unverified)
            );
        }
    }
    #[test]
    fn exact_original_backup_is_private_exclusive_and_not_reserialized() {
        let temp = Temp::new();
        let backup = temp.0.join("original.plist");
        let bytes = b"<?xml version=\"1.0\"?>\n<!-- original formatting -->\n<plist/>\n";
        installer::write_new(&backup, bytes).unwrap();
        File::open(&temp.0).unwrap().sync_all().unwrap();
        assert_eq!(fs::read(&backup).unwrap(), bytes);
        assert_eq!(fs::metadata(&backup).unwrap().mode() & 0o777, 0o600);
        assert!(installer::write_new(&backup, b"replacement").is_err());
        assert_eq!(fs::read(&backup).unwrap(), bytes);
    }
    #[test]
    fn offline_intent_failure_is_unknown_and_never_replayed_or_stopped() {
        let steps = [
            Step::Intent,
            Step::Claim,
            Step::Replace,
            Step::Starting,
            Step::Start,
            Step::Verify,
            Step::Complete,
        ];
        for failure in steps {
            let mut calls = Vec::new();
            assert_eq!(
                commit(|step| {
                    calls.push(step);
                    if step == failure {
                        Err(Failure::Unverified)
                    } else {
                        Ok(())
                    }
                }),
                Err(Failure::Unknown)
            );
            assert_eq!(calls.last(), Some(&failure));
            assert!(calls.iter().filter(|s| **s == Step::Start).count() <= 1);
        }
        let mut calls = Vec::new();
        commit(|step| {
            calls.push(step);
            Ok(())
        })
        .unwrap();
        assert_eq!(calls, steps);
    }
    #[test]
    fn listeners_and_corrupt_existing_identity_refuse() {
        let temp = Temp::new();
        let mut location = temp.location();
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        location.port = listener.local_addr().unwrap().port();
        assert_eq!(no_listener(&location), Err(Failure::Busy));
        drop(listener);
        assert_eq!(no_listener(&location), Ok(()));
        let path = temp.0.join("daemon-id");
        for id in ["", "damaged", "00000000-0000-0000-0000-000000000000", "🦀"] {
            fs::write(&path, id).unwrap();
            assert!(identity(&path).is_err());
        }
        fs::write(&path, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\n").unwrap();
        assert_eq!(
            identity(&path).unwrap(),
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\n"
        );
    }
    #[test]
    fn actual_sqlite_lease_excludes_other_process_and_preserves_managed_inode_bytes() {
        for managed in [0, 1] {
            let temp = Temp::new();
            let path = temp.0.join(".daemon-owner.sqlite");
            let sql = format!(
                "CREATE TABLE runtime_owner(singleton INTEGER PRIMARY KEY CHECK(singleton=1),managed INTEGER NOT NULL); INSERT INTO runtime_owner VALUES(1,{managed}); PRAGMA user_version=1;"
            );
            assert!(
                std::process::Command::new("/usr/bin/sqlite3")
                    .arg(&path)
                    .arg(sql)
                    .status()
                    .unwrap()
                    .success()
            );
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
            let before = fs::metadata(&path).unwrap();
            let bytes = fs::read(&path).unwrap();
            let lease = Lease::acquire(&path).unwrap();
            let attempt = || {
                std::process::Command::new("/usr/bin/sqlite3")
                    .arg(&path)
                    .arg("BEGIN EXCLUSIVE; SELECT managed FROM runtime_owner; ROLLBACK;")
                    .output()
                    .unwrap()
            };
            let blocked = attempt();
            assert!(!blocked.status.success());
            assert!(String::from_utf8_lossy(&blocked.stderr).contains("locked"));
            lease.verify(&path).unwrap();
            drop(lease);
            let result = attempt();
            assert!(result.status.success());
            assert_eq!(
                String::from_utf8(result.stdout).unwrap(),
                format!("{managed}\n")
            );
            assert_eq!(fs::metadata(&path).unwrap().ino(), before.ino());
            assert_eq!(fs::read(&path).unwrap(), bytes);
        }
    }
    fn owner_db(temp: &Temp) -> PathBuf {
        let path = temp.0.join(".daemon-owner.sqlite");
        assert!(std::process::Command::new("/usr/bin/sqlite3").arg(&path).arg("CREATE TABLE runtime_owner(singleton INTEGER PRIMARY KEY CHECK(singleton=1),managed INTEGER NOT NULL); INSERT INTO runtime_owner VALUES(1,0); PRAGMA user_version=1;").status().unwrap().success());
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        path
    }
    #[test]
    fn public_readable_owner_database_refuses_before_intent() {
        let temp = Temp::new();
        let path = owner_db(&temp);
        let bytes = fs::read(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(matches!(Lease::acquire(&path), Err(Failure::Unverified)));
        assert!(!temp.0.join(JOURNAL).exists());
        assert_eq!(fs::read(&path).unwrap(), bytes);
    }
    #[test]
    fn replaced_owner_inode_refuses_before_intent_and_before_replacement() {
        for after_intent in [false, true] {
            let temp = Temp::new();
            let path = owner_db(&temp);
            let lease = Lease::acquire(&path).unwrap();
            let trust = crate::owned_tests::trust();
            let cancel = AtomicBool::new(false);
            let original = definition(&temp.0);
            let plist_path = temp.0.join("fixture.plist");
            let bytes = serde_json::to_vec(&original).unwrap();
            installer::write_new(&plist_path, &bytes).unwrap();
            let stamp = fs::metadata(&plist_path).unwrap();
            let mut host = LaunchAgent {
                location: temp.location(),
                current: temp.0.join("Pilot Next.app"),
                trust: &trust,
                daemon: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                lineage: "bbbbbbbb-bbbb-4bbb-9bbb-bbbbbbbbbbbb",
                cancel: &cancel,
                service: "gui/0/com.example.unused-offline-test".into(),
                label: "com.example.unused-offline-test".into(),
                home: temp.0.clone(),
                plist: plist_path.clone(),
                original: original.clone(),
                replacement: original,
                owner: Value::Null,
                watch: None,
                lock: None,
                plist_stamp: Some((stamp.dev(), stamp.ino())),
                reservation: None,
                original_backup: None,
            };
            let replace_inode = || {
                fs::rename(&path, temp.0.join("retained-owner.sqlite")).unwrap();
                installer::write_new(&path, b"replacement inode").unwrap();
            };
            if after_intent {
                let mut calls = Vec::new();
                assert_eq!(
                    commit(|step| {
                        calls.push(step);
                        match step {
                            Step::Intent => host.journal("migrating-stopped"),
                            Step::Claim => Ok(()),
                            Step::Replace => {
                                replace_inode();
                                revalidate(&host, &bytes, host.daemon, host.lineage, &lease)
                            }
                            _ => panic!("must not replace or bootstrap a changed owner inode"),
                        }
                    }),
                    Err(Failure::Unknown)
                );
                assert_eq!(calls, [Step::Intent, Step::Claim, Step::Replace]);
                assert_eq!(
                    super::super::super::native::no_incomplete_handoff(&host.location),
                    Err(Failure::Unknown)
                );
            } else {
                replace_inode();
                assert_eq!(
                    revalidate(&host, &bytes, host.daemon, host.lineage, &lease),
                    Err(Failure::Unverified)
                );
                assert!(!temp.0.join(JOURNAL).exists());
            }
            assert_eq!(fs::read(&plist_path).unwrap(), bytes);
            assert!(!plist_path.with_extension("plist.next-owner").exists());
        }
    }
    #[test]
    fn existing_incomplete_journal_refuses_without_rewriting_evidence() {
        let temp = Temp::new();
        let location = temp.location();
        for phase in ["migrating-stopped", "starting", "stopping", "registering"] {
            let bytes = serde_json::to_vec(&json!({"schema":1,"phase":phase})).unwrap();
            let path = temp.0.join(JOURNAL);
            fs::write(&path, &bytes).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
            assert_eq!(
                super::super::super::native::no_incomplete_handoff(&location),
                Err(Failure::Unknown)
            );
            assert_eq!(fs::read(path).unwrap(), bytes);
        }
    }
}
