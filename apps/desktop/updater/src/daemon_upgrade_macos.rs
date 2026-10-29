use super::native::{command, plist, private_regular, prove};
use super::{Failure, Handoff, execute};
use crate::{
    coordination::{self, Location},
    helper, installer,
    manifest::Trust,
    runtime,
};
use serde_json::{Value, json};
use std::{
    fs::{self, File, OpenOptions},
    io::Read,
    os::{
        fd::AsRawFd,
        unix::fs::{MetadataExt, OpenOptionsExt},
    },
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

const LABEL: &str = "com.babariviere.pilot.daemon";
const JOURNAL: &str = ".daemon-upgrade.json";
#[path = "daemon_migrate_stopped.rs"]
mod stopped;
pub use stopped::migrate_stopped;
fn verified<T>(result: Result<T, crate::Error>) -> Result<T, Failure> {
    result.map_err(|_| Failure::Unverified)
}
fn io<T>(result: std::io::Result<T>) -> Result<T, Failure> {
    result.map_err(|_| Failure::Unverified)
}

/// Upgrade only the verified existing launch agent. Never modifies the profile's managed flag.
/// `current` must be a fully verified immutable capsule of this app's compiled release.
pub fn upgrade(
    location: Location,
    current: &Path,
    trust: &Trust,
    daemon: &str,
    lineage: &str,
    cancel: &AtomicBool,
) -> Result<(), Failure> {
    let home = PathBuf::from(std::env::var_os("HOME").ok_or(Failure::Unverified)?);
    let service = format!("gui/{}/{LABEL}", unsafe { libc::geteuid() });
    let mut host = LaunchAgent {
        plist: home
            .join("Library/LaunchAgents")
            .join(format!("{LABEL}.plist")),
        location,
        current: current.to_owned(),
        trust,
        daemon,
        lineage,
        cancel,
        service,
        label: LABEL.into(),
        home,
        original: Value::Null,
        replacement: Value::Null,
        owner: Value::Null,
        watch: None,
        lock: None,
        plist_stamp: None,
        reservation: None,
        original_backup: None,
    };
    execute(&mut host, cancel)
}
struct LaunchAgent<'a> {
    location: Location,
    current: PathBuf,
    trust: &'a Trust,
    daemon: &'a str,
    lineage: &'a str,
    cancel: &'a AtomicBool,
    service: String,
    label: String,
    home: PathBuf,
    plist: PathBuf,
    original: Value,
    replacement: Value,
    owner: Value,
    watch: Option<helper::ParentWatch>,
    lock: Option<File>,
    plist_stamp: Option<(u64, u64)>,
    reservation: Option<super::reservation::Reservation>,
    original_backup: Option<PathBuf>,
}

fn service_pid(text: &str, path: &Path, arguments: &[Value]) -> Result<i32, Failure> {
    let mut pid = None;
    let mut actual = Vec::new();
    let mut in_arguments = false;
    let mut definition = None;
    for line in text.lines().map(str::trim) {
        if line == "arguments = {" {
            in_arguments = true;
            continue;
        }
        if in_arguments {
            if line == "}" {
                in_arguments = false;
            } else {
                actual.push(line);
            }
            continue;
        }
        if let Some(value) = line.strip_prefix("pid = ") {
            pid = value.parse::<i32>().ok();
        }
        if let Some(value) = line.strip_prefix("path = ") {
            definition = Some(value);
        }
    }
    if definition != path.to_str()
        || actual
            != arguments
                .iter()
                .map(|v| v.as_str().ok_or(Failure::Unverified))
                .collect::<Result<Vec<_>, _>>()?
    {
        return Err(Failure::Unsupported);
    }
    pid.filter(|pid| *pid > 1).ok_or(Failure::Unverified)
}
impl LaunchAgent<'_> {
    fn bootstrap(&self) -> Result<(), Failure> {
        let domain = format!("gui/{}", unsafe { libc::geteuid() });
        command(
            "/bin/launchctl",
            &[
                "bootstrap".as_ref(),
                domain.as_ref(),
                self.plist.as_os_str(),
            ],
        )?;
        Ok(())
    }
    fn verify_target(&self) -> Result<(), Failure> {
        let id = verified(runtime::identity(&self.current))?;
        let (_, build) = verified(coordination::validate_capsule(
            &self.current,
            self.trust,
            &[],
            Some(&id),
        ))?;
        if build != self.trust.current_build {
            return Err(Failure::Unverified);
        }
        Ok(())
    }
    fn pid(&self) -> Result<i32, Failure> {
        self.owner["pid"]
            .as_i64()
            .and_then(|v| i32::try_from(v).ok())
            .filter(|v| *v > 1)
            .ok_or(Failure::Unverified)
    }
    fn live_definition(&self) -> Result<i32, Failure> {
        let output = command("/bin/launchctl", &["print".as_ref(), self.service.as_ref()])?;
        service_pid(
            std::str::from_utf8(&output).map_err(|_| Failure::Unverified)?,
            &self.plist,
            self.original["ProgramArguments"]
                .as_array()
                .ok_or(Failure::Unverified)?,
        )
    }
    fn verify_old_payload(&self) -> Result<(), Failure> {
        let node = Path::new(
            self.original["ProgramArguments"][0]
                .as_str()
                .ok_or(Failure::Unsupported)?,
        );
        let app = node.ancestors().nth(6).ok_or(Failure::Unsupported)?;
        if app.file_name().is_some_and(|n| n == "Pilot.app") {
            // Swift's sole supported bundle layout. Source-checkout/custom services refuse.
            command(
                "/usr/bin/codesign",
                &[
                    "--verify".as_ref(),
                    "--strict".as_ref(),
                    "--deep".as_ref(),
                    "-R".as_ref(),
                    "=identifier \"com.babariviere.pilot\"".as_ref(),
                    app.as_os_str(),
                ],
            )?;
        } else {
            // A prior explicit handoff may already use a Next capsule, still launchd-owned.
            let id = verified(runtime::identity(&self.current))?;
            let (accepted, _) = verified(coordination::policy(&self.current))?;
            verified(coordination::validate_capsule(
                app,
                self.trust,
                &accepted,
                Some(&id),
            ))?;
        }
        if super::native::running(&self.location, app)? != self.owner {
            return Err(Failure::Unverified);
        }
        if verified(helper::process_executable(self.pid()?))? != io(node.canonicalize())? {
            return Err(Failure::Unverified);
        }
        let expected = node
            .parent()
            .and_then(Path::parent)
            .and_then(Path::parent)
            .ok_or(Failure::Unsupported)?
            .join("packages/daemon/src/main.ts");
        if self.original["ProgramArguments"][1].as_str() != expected.to_str() {
            return Err(Failure::Unsupported);
        }
        Ok(())
    }
}
impl Handoff for LaunchAgent<'_> {
    fn reserve(&mut self) -> Result<(), Failure> {
        self.reservation = Some(super::reservation::Reservation::prepare(
            &self.location,
            &self.owner,
        )?);
        Ok(())
    }
    fn verify_reservation(&mut self) -> Result<(), Failure> {
        self.reservation
            .as_ref()
            .ok_or(Failure::Unverified)?
            .verify(&self.location, &self.owner)
    }
    fn cancel_reservation(&mut self) {
        if let Some(reservation) = self.reservation.take() {
            reservation.cancel(&self.location, &self.owner);
        }
    }
    fn prepare(&mut self) -> Result<(), Failure> {
        // Canonical private profile and its HMAC owner record, not merely /api/hello.
        self.owner = verified(coordination::record(&self.location))?;
        verified(installer::validate_parents(
            self.plist.parent().ok_or(Failure::Unverified)?,
        ))?;
        let meta = private_regular(&self.plist)?;
        self.plist_stamp = Some((meta.dev(), meta.ino()));
        self.original = plist(&self.plist)?;
        validate_definition(&self.original, &self.home, &self.location, &self.label)?;
        if self.live_definition()? != self.pid()? {
            return Err(Failure::Unverified);
        }
        self.verify_old_payload()?;
        prove(&self.location, &self.owner, self.daemon, self.lineage)?;
        self.watch = Some(verified(helper::ParentWatch::new(self.pid()?))?);
        // A permanent per-profile inode serializes all explicit handoffs, never unlinked.
        let lock = io(OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(self.location.home.join(".daemon-upgrade.lock")))?;
        let meta = io(lock.metadata())?;
        if !meta.is_file()
            || meta.nlink() != 1
            || meta.uid() != unsafe { libc::geteuid() }
            || meta.mode() & 0o077 != 0
        {
            return Err(Failure::Unverified);
        }
        // SAFETY: owned descriptor, nonblocking exclusive lock; close releases, never unlink.
        if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err(Failure::Busy);
        }
        self.lock = Some(lock);
        let journal = self.location.home.join(JOURNAL);
        if journal.try_exists().map_err(|_| Failure::Unverified)?
            && verified(coordination::private_json(&journal, 65536))?["phase"] != "complete"
        {
            return Err(Failure::Unknown);
        }
        self.verify_target()?;
        self.replacement = self.original.clone();
        self.replacement["PilotNextManaged"] = json!(true);
        let runtime = self.current.join(crate::layout::RUNTIME);
        self.replacement["ProgramArguments"] = json!([
            runtime.join("node/bin/node"),
            runtime.join("packages/daemon/src/main.ts")
        ]);
        // Pin the unchanged profile explicitly. Do not add --bundled-runtime/enroll it.
        self.replacement["EnvironmentVariables"]["PILOT_HOME"] = json!(self.location.home);
        let path = self.original["EnvironmentVariables"]["PATH"]
            .as_str()
            .ok_or(Failure::Unverified)?;
        self.replacement["EnvironmentVariables"]["PATH"] =
            json!(format!("{}:{path}", runtime.join("node/bin").display()));
        Ok(())
    }
    fn drained(&mut self) -> Result<bool, Failure> {
        let client = reqwest::blocking::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(5))
            .build()
            .map_err(|_| Failure::Unverified)?;
        let until = Instant::now() + Duration::from_secs(30);
        loop {
            if self.cancel.load(Ordering::Acquire) {
                return Err(Failure::Cancelled);
            }
            prove(&self.location, &self.owner, self.daemon, self.lineage)?;
            let mut response = client
                .post(format!(
                    "http://127.0.0.1:{}/api/update/pause",
                    self.location.port
                ))
                .header("content-type", "application/json")
                .body("{}")
                .send()
                .and_then(|r| r.error_for_status())
                .map_err(|_| Failure::Unverified)?;
            let mut bytes = Vec::new();
            io(response.by_ref().take(4097).read_to_end(&mut bytes))?;
            if bytes.len() > 4096 {
                return Err(Failure::Unverified);
            }
            let value: Value = serde_json::from_slice(&bytes).map_err(|_| Failure::Unverified)?;
            if value["processId"] != self.owner["pid"] {
                return Err(Failure::Unverified);
            }
            if value["ready"] == true {
                return Ok(true);
            }
            if Instant::now() >= until {
                return Ok(false);
            }
            std::thread::sleep(Duration::from_millis(500));
        }
    }
    fn revalidate(&mut self) -> Result<(), Failure> {
        let meta = private_regular(&self.plist)?;
        if Some((meta.dev(), meta.ino())) != self.plist_stamp
            || plist(&self.plist)? != self.original
            || self.live_definition()? != self.pid()?
        {
            return Err(Failure::Unverified);
        }
        self.verify_old_payload()?;
        prove(&self.location, &self.owner, self.daemon, self.lineage)?;
        Ok(())
    }
    fn journal(&mut self, phase: &str) -> Result<(), Failure> {
        if phase == "stopping" {
            claim(&self.plist, &self.location)?;
        }
        let value = json!({"schema":1,"phase":phase,"boot":self.owner["boot"],"daemonId":self.daemon,"lineageId":self.lineage,"profile":self.location.home,"service":self.service,"capsule":self.current,"previousDefinition":self.original,"nextDefinition":self.replacement,"originalPlistBackup":self.original_backup,"receipt":self.reservation.as_ref().map(|r|&r.receipt)});
        let temp = self.location.home.join(format!(
            ".daemon-upgrade-{}.pending",
            verified(coordination::random_hex())?
        ));
        verified(installer::write_new(
            &temp,
            &serde_json::to_vec(&value).map_err(|_| Failure::Unverified)?,
        ))?;
        io(fs::rename(&temp, self.location.home.join(JOURNAL)))?;
        io(io(File::open(&self.location.home))?.sync_all())
    }
    fn stop(&mut self) -> Result<(), Failure> {
        prove(&self.location, &self.owner, self.daemon, self.lineage)?;
        if self.live_definition()? != self.pid()? {
            return Err(Failure::Unverified);
        }
        self.reservation
            .as_ref()
            .ok_or(Failure::Unverified)?
            .fresh()?;
        command(
            "/bin/launchctl",
            &["bootout".as_ref(), self.service.as_ref()],
        )?;
        Ok(())
    }
    fn exited(&mut self) -> Result<(), Failure> {
        verified(
            self.watch
                .take()
                .ok_or(Failure::Unverified)?
                .wait(Duration::from_secs(120)),
        )?;
        if coordination::owner_live(&self.location.home) {
            return Err(Failure::Unverified);
        }
        Ok(())
    }
    fn replace_definition(&mut self) -> Result<(), Failure> {
        let meta = private_regular(&self.plist)?;
        if Some((meta.dev(), meta.ino())) != self.plist_stamp
            || plist(&self.plist)? != self.original
            || (self.original_backup.is_none() && coordination::owner_live(&self.location.home))
        {
            return Err(Failure::Unverified);
        }
        let temp = self
            .plist
            .parent()
            .ok_or(Failure::Unverified)?
            .join(format!(
                ".pilot-daemon-{}.plist",
                verified(coordination::random_hex())?
            ));
        verified(installer::write_new(
            &temp,
            &serde_json::to_vec(&self.replacement).map_err(|_| Failure::Unverified)?,
        ))?;
        command(
            "/usr/bin/plutil",
            &["-convert".as_ref(), "xml1".as_ref(), temp.as_os_str()],
        )?;
        io(io(File::open(&temp))?.sync_all())?;
        if let Some(backup) = &self.original_backup {
            let meta = private_regular(&self.plist)?;
            if Some((meta.dev(), meta.ino())) != self.plist_stamp
                || io(fs::read(&self.plist))? != io(fs::read(backup))?
            {
                return Err(Failure::Unverified);
            }
        }
        io(fs::rename(&temp, &self.plist))?;
        io(io(File::open(self.plist.parent().ok_or(Failure::Unverified)?))?.sync_all())
    }
    fn start(&mut self) -> Result<(), Failure> {
        self.verify_target()?;
        if coordination::owner_live(&self.location.home) {
            return Err(Failure::Unverified);
        }
        self.bootstrap()
    }
    fn verify_started(&mut self) -> Result<(), Failure> {
        let until = Instant::now() + Duration::from_secs(30);
        loop {
            let record = verified(coordination::record(&self.location))?;
            if record["boot"] != self.owner["boot"]
                && record["runtimeRoot"].as_str()
                    == self.current.join(crate::layout::RUNTIME).to_str()
            {
                // The new owner publishes its record before graph initialization.
                // No extra start or replay while its ready proof is unavailable.
                if prove(&self.location, &record, self.daemon, self.lineage).is_err() {
                    if Instant::now() >= until {
                        return Err(Failure::Unknown);
                    }
                    std::thread::sleep(Duration::from_millis(250));
                    continue;
                }
                let args = self.replacement["ProgramArguments"]
                    .as_array()
                    .ok_or(Failure::Unverified)?;
                let output = command("/bin/launchctl", &["print".as_ref(), self.service.as_ref()])?;
                let pid = service_pid(
                    std::str::from_utf8(&output).map_err(|_| Failure::Unverified)?,
                    &self.plist,
                    args,
                )?;
                if record["pid"] != pid
                    || !coordination::owner_live(&self.location.home)
                    || verified(helper::process_executable(pid))?
                        != io(self
                            .current
                            .join(crate::layout::RUNTIME)
                            .join("node/bin/node")
                            .canonicalize())?
                {
                    return Err(Failure::Unverified);
                }
                let expected: Value = serde_json::from_slice(&io(fs::read(
                    self.current
                        .join(crate::layout::RUNTIME)
                        .join("runtime-build.json"),
                ))?)
                .map_err(|_| Failure::Unverified)?;
                if record["build"] != expected {
                    return Err(Failure::Unverified);
                }
                return Ok(());
            }
            if Instant::now() >= until {
                return Err(Failure::Unknown);
            }
            std::thread::sleep(Duration::from_millis(250));
        }
    }
}
fn validate_definition(
    value: &Value,
    home: &Path,
    location: &Location,
    label: &str,
) -> Result<(), Failure> {
    const FIELDS: &[&str] = &[
        "Label",
        "ProgramArguments",
        "WorkingDirectory",
        "EnvironmentVariables",
        "RunAtLoad",
        "KeepAlive",
        "ThrottleInterval",
        "ProcessType",
        "StandardOutPath",
        "StandardErrorPath",
    ];
    let object = value.as_object().ok_or(Failure::Unsupported)?;
    if object.len() < FIELDS.len()
        || object
            .keys()
            .any(|k| !FIELDS.contains(&k.as_str()) && k != "PilotNextManaged")
        || object.get("PilotNextManaged").is_some_and(|v| v != true)
        || value["Label"] != label
        || value["ProgramArguments"].as_array().is_none_or(|a| {
            a.len() != 2
                || a.iter().any(|v| {
                    v.as_str()
                        .is_none_or(|v| v.contains(['\n', '\r']) || !Path::new(v).is_absolute())
                })
        })
        || value["WorkingDirectory"].as_str() != home.to_str()
        || value["KeepAlive"] != true
        || value["RunAtLoad"] != true
        || value["ProcessType"] != "Interactive"
        || value["ThrottleInterval"] != 10
    {
        return Err(Failure::Unsupported);
    }
    let env = value["EnvironmentVariables"]
        .as_object()
        .ok_or(Failure::Unsupported)?;
    if env.keys().any(|k| {
        !["PATH", "PILOT_HOME", "PILOT_PORT"].contains(&k.as_str())
            && !coordination::POLICY_NAMES.contains(&k.as_str())
    }) || env.values().any(|v| !v.is_string())
        || env.get("PILOT_PORT").and_then(Value::as_str) != Some(location.port.to_string().as_str())
    {
        return Err(Failure::Unsupported);
    }
    let data = env
        .get("PILOT_HOME")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".local/share/pilot"));
    if io(data.canonicalize())? != location.home {
        return Err(Failure::Unverified);
    }
    let log = home.join("Library/Logs/Pilot/pilotd.log");
    if value["StandardOutPath"].as_str() != log.to_str()
        || value["StandardErrorPath"].as_str() != log.to_str()
    {
        return Err(Failure::Unsupported);
    }
    Ok(())
}

// Retained Swift builds consult this claim before every lifecycle mutation.
// Publish before stop intent. An incomplete claim is deliberately inspect-only.
fn claim(path: &Path, location: &Location) -> Result<(), Failure> {
    let file = path.with_extension("plist.next-owner");
    let expected = json!({"schema":1,"profile":location.home,"port":location.port});
    if file.try_exists().map_err(|_| Failure::Unverified)? {
        if verified(coordination::private_json(&file, 4096))? != expected {
            return Err(Failure::Unverified);
        }
        return Ok(());
    }
    verified(installer::write_new(
        &file,
        &serde_json::to_vec(&expected).map_err(|_| Failure::Unverified)?,
    ))?;
    io(io(File::open(path.parent().ok_or(Failure::Unverified)?))?.sync_all())
}

/// Explicit first registration, or start the already selected Next runtime.
/// No existing Swift/custom definition is rewritten here: that requires safe upgrade.
pub(super) fn register(
    location: Location,
    current: &Path,
    trust: &Trust,
    cancel: &AtomicBool,
) -> Result<(), Failure> {
    let home = PathBuf::from(std::env::var_os("HOME").ok_or(Failure::Unverified)?);
    register_at(&home, LABEL, location, current, trust, cancel, true)
}
fn register_at(
    home: &Path,
    label: &str,
    location: Location,
    current: &Path,
    trust: &Trust,
    cancel: &AtomicBool,
    enable_login: bool,
) -> Result<(), Failure> {
    let file = home
        .join("Library/LaunchAgents")
        .join(format!("{label}.plist"));
    let _lock = super::native::lock(&location)?;
    if coordination::owner_live(&location.home) {
        return Err(Failure::Busy);
    }
    super::native::no_incomplete_handoff(&location)?;
    let root = if file.try_exists().map_err(|_| Failure::Unverified)? {
        private_regular(&file)?;
        let value = plist(&file)?;
        validate_definition(&value, home, &location, label)?;
        if value["PilotNextManaged"] != true {
            return Err(Failure::Unsupported);
        }
        let node = value["ProgramArguments"][0]
            .as_str()
            .ok_or(Failure::Unverified)?;
        let root = Path::new(node)
            .ancestors()
            .nth(6)
            .ok_or(Failure::Unverified)?
            .to_owned();
        if value["ProgramArguments"]
            != json!([
                root.join(crate::layout::RUNTIME).join("node/bin/node"),
                root.join(crate::layout::RUNTIME)
                    .join("packages/daemon/src/main.ts")
            ])
        {
            return Err(Failure::Unsupported);
        }
        let (accepted, _) = verified(coordination::policy(current))?;
        let id = verified(runtime::identity(current))?;
        verified(coordination::validate_capsule(
            &root,
            trust,
            &accepted,
            Some(&id),
        ))?;
        root
    } else {
        super::native::fresh_profile(&location)?;
        let id = verified(runtime::identity(current))?;
        verified(coordination::validate_capsule(
            current,
            trust,
            &[],
            Some(&id),
        ))?;
        current.to_owned()
    };
    let service = format!("gui/{}/{label}", unsafe { libc::geteuid() });
    if command("/bin/launchctl", &["print".as_ref(), service.as_ref()]).is_ok() {
        return Err(Failure::Busy);
    }
    if cancel.load(Ordering::Acquire) {
        return Err(Failure::Cancelled);
    }
    let log = home.join("Library/Logs/Pilot/pilotd.log");
    if !file.try_exists().map_err(|_| Failure::Unverified)? {
        for directory in [
            file.parent().ok_or(Failure::Unverified)?,
            log.parent().ok_or(Failure::Unverified)?,
        ] {
            io(fs::create_dir_all(directory))?;
            verified(installer::validate_parents(directory))?;
        }
        let runtime = root.join(crate::layout::RUNTIME);
        let mut env = json!({"PATH":format!("{}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",runtime.join("node/bin").display()),"PILOT_HOME":location.home,"PILOT_PORT":location.port.to_string()});
        for (name, value) in &location.policy {
            env[name] = json!(value);
        }
        let value = json!({"Label":label,"PilotNextManaged":true,"ProgramArguments":[runtime.join("node/bin/node"),runtime.join("packages/daemon/src/main.ts")],"WorkingDirectory":home,"EnvironmentVariables":env,"RunAtLoad":true,"KeepAlive":true,"ThrottleInterval":10,"ProcessType":"Interactive","StandardOutPath":log,"StandardErrorPath":log});
        claim(&file, &location)?;
        verified(installer::write_new(
            &file,
            &serde_json::to_vec(&value).map_err(|_| Failure::Unverified)?,
        ))?;
        command(
            "/usr/bin/plutil",
            &["-convert".as_ref(), "xml1".as_ref(), file.as_os_str()],
        )?;
        io(io(File::open(&file))?.sync_all())?;
    }
    claim(&file, &location)?;
    // From here any failed/lost acknowledgement is inspect-only, never re-bootstrap.
    super::native::registration_intent(&location, &root)?;
    let domain = format!("gui/{}", unsafe { libc::geteuid() });
    // Isolated fixtures never touch the login-domain disabled-service database.
    if enable_login {
        command("/bin/launchctl", &["enable".as_ref(), service.as_ref()])
            .map_err(|_| Failure::Unknown)?;
    }
    command(
        "/bin/launchctl",
        &["bootstrap".as_ref(), domain.as_ref(), file.as_os_str()],
    )
    .map_err(|_| Failure::Unknown)?;
    let owner = super::native::wait_registered(&location, &root).map_err(|_| Failure::Unknown)?;
    let output = command("/bin/launchctl", &["print".as_ref(), service.as_ref()])
        .map_err(|_| Failure::Unknown)?;
    let definition = plist(&file).map_err(|_| Failure::Unknown)?;
    let pid = service_pid(
        std::str::from_utf8(&output).map_err(|_| Failure::Unknown)?,
        &file,
        definition["ProgramArguments"]
            .as_array()
            .ok_or(Failure::Unknown)?,
    )
    .map_err(|_| Failure::Unknown)?;
    if owner["pid"] != pid {
        return Err(Failure::Unknown);
    }
    super::native::registration_complete(&location).map_err(|_| Failure::Unknown)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::hmac;
    use std::io::Read;
    use std::{net::TcpListener, os::unix::fs::PermissionsExt};
    #[test]
    fn loaded_service_must_match_definition_and_exact_pid() {
        let args = json!(["/node", "/main.ts"]);
        let text = "gui/1/service = {\n path = /agent.plist\n arguments = {\n /node\n /main.ts\n }\n pid = 77\n}";
        assert_eq!(
            service_pid(text, Path::new("/agent.plist"), args.as_array().unwrap()),
            Ok(77)
        );
        assert_eq!(
            service_pid(text, Path::new("/other.plist"), args.as_array().unwrap()),
            Err(Failure::Unsupported)
        );
        assert!(
            service_pid(
                &text.replace("/main.ts", "/evil.ts"),
                Path::new("/agent.plist"),
                args.as_array().unwrap()
            )
            .is_err()
        );
    }
    #[test]
    fn null_build_boot_proof_does_not_require_or_invent_retained_authority() {
        use sha2::{Digest, Sha256};
        for fault in ["none", "identity", "signature", "boot-change"] {
            let home = std::env::temp_dir().join(format!(
                "daemon-upgrade-proof-{}",
                coordination::random_hex().unwrap()
            ));
            fs::create_dir(&home).unwrap();
            fs::set_permissions(&home, fs::Permissions::from_mode(0o700)).unwrap();
            let home = home.canonicalize().unwrap();
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            let record = json!({"schema":1,"boot":"a".repeat(64),"secret":"b".repeat(64),"home":crate::transport::hex(&Sha256::digest(home.to_str().unwrap().as_bytes())),"port":port,"pid":std::process::id(),"build":null});
            let record_path = home.join(".daemon-owner.json");
            installer::write_new(&record_path, &serde_json::to_vec(&record).unwrap()).unwrap();
            let expected = record.clone();
            let worker = std::thread::spawn(move || {
                let (mut socket, _) = listener.accept().unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut request = vec![0; 4096];
                let count = socket.read(&mut request).unwrap();
                let request = std::str::from_utf8(&request[..count]).unwrap();
                let challenge = request
                    .split("?challenge=")
                    .nth(1)
                    .unwrap()
                    .split(' ')
                    .next()
                    .unwrap();
                let mut body = record.clone();
                body.as_object_mut().unwrap().remove("secret");
                body["ready"] = json!(true);
                body["challenge"] = json!(challenge);
                body["hello"] = json!({"daemonId":if fault=="identity"{"other"}else{"daemon"},"lineageId":"lineage","protocolVersion":1,"minimumClientProtocolVersion":1,"capabilities":{"independentExecution":true}});
                let body = serde_json::to_string(&body).unwrap();
                let key = hmac::Key::new(hmac::HMAC_SHA256, &[0xbb; 32]);
                let signature = if fault == "signature" {
                    "0".repeat(64)
                } else {
                    crate::transport::hex(hmac::sign(&key, body.as_bytes()).as_ref())
                };
                if fault == "boot-change" {
                    let mut changed = record;
                    changed["boot"] = json!("c".repeat(64));
                    fs::write(record_path, serde_json::to_vec(&changed).unwrap()).unwrap();
                }
                let response = serde_json::to_vec(&json!({"body":body,"mac":signature})).unwrap();
                use std::io::Write;
                write!(
                    socket,
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    response.len()
                )
                .unwrap();
                socket.write_all(&response).unwrap();
            });
            let location = Location {
                home: home.clone(),
                port,
                policy: Default::default(),
            };
            let result = prove(&location, &expected, "daemon", "lineage");
            worker.join().unwrap();
            assert_eq!(result.is_ok(), fault == "none", "{fault}");
            fs::remove_dir_all(home).unwrap();
        }
    }
    #[test]
    fn custom_service_profile_and_enrollment_arguments_are_refused() {
        let home = std::env::temp_dir().join(format!(
            "daemon-upgrade-definition-{}",
            coordination::random_hex().unwrap()
        ));
        fs::create_dir(&home).unwrap();
        let home = home.canonicalize().unwrap();
        let location = Location {
            home: home.clone(),
            port: 4319,
            policy: Default::default(),
        };
        let log = home.join("Library/Logs/Pilot/pilotd.log");
        let value = json!({"Label":LABEL,"ProgramArguments":["/node","/main.ts"],"WorkingDirectory":home,"EnvironmentVariables":{"PATH":"/usr/bin","PILOT_PORT":"4319","PILOT_HOME":home},"KeepAlive":true,"RunAtLoad":true,"ThrottleInterval":10,"ProcessType":"Interactive","StandardOutPath":log,"StandardErrorPath":log});
        assert_eq!(validate_definition(&value, &home, &location, LABEL), Ok(()));
        for (field, other) in [
            ("Label", json!("other.service")),
            (
                "ProgramArguments",
                json!(["/node", "/main.ts", "--bundled-runtime"]),
            ),
            (
                "EnvironmentVariables",
                json!({"PATH":"/usr/bin","PILOT_PORT":"4319","PILOT_HOME":"/other"}),
            ),
            ("Program", json!("/arbitrary")),
        ] {
            let mut changed = value.clone();
            changed[field] = other;
            assert!(
                validate_definition(&changed, &home, &location, LABEL).is_err(),
                "{field}"
            );
        }
        fs::remove_dir_all(home).unwrap();
    }
}

#[cfg(test)]
#[path = "daemon_upgrade_native_tests.rs"]
mod native_tests;
