use super::{Failure, Handoff, execute};
use crate::{
    coordination::{self, Location},
    helper, installer,
    manifest::Trust,
    runtime,
};
use ring::hmac;
use serde_json::{Value, json};
use std::{
    fs::{self, File, OpenOptions},
    io::Read,
    os::{
        fd::AsRawFd,
        unix::fs::{MetadataExt, OpenOptionsExt},
    },
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

const LABEL: &str = "com.babariviere.pilot.daemon";
const JOURNAL: &str = ".daemon-upgrade.json";
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
        pause_until: None,
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
    pause_until: Option<Instant>,
}

fn command(program: &str, args: &[&std::ffi::OsStr]) -> Result<Vec<u8>, Failure> {
    let mut child = io(Command::new(program)
        .args(args)
        .env_clear()
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn())?;
    let timeout = if program == "/bin/launchctl"
        && args
            .first()
            .is_some_and(|a| *a == std::ffi::OsStr::new("bootout"))
    {
        150
    } else {
        15
    };
    let end = Instant::now() + Duration::from_secs(timeout);
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => {
                let mut bytes = Vec::new();
                io(child
                    .stdout
                    .take()
                    .ok_or(Failure::Unverified)?
                    .take(65537)
                    .read_to_end(&mut bytes))?;
                return if bytes.len() <= 65536 {
                    Ok(bytes)
                } else {
                    Err(Failure::Unverified)
                };
            }
            Ok(None) if Instant::now() < end => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(Failure::Unverified);
            }
        }
    }
}
fn plist(path: &Path) -> Result<Value, Failure> {
    let data = command(
        "/usr/bin/plutil",
        &[
            "-convert".as_ref(),
            "json".as_ref(),
            "-o".as_ref(),
            "-".as_ref(),
            path.as_os_str(),
        ],
    )?;
    serde_json::from_slice(&data).map_err(|_| Failure::Unverified)
}
fn private_regular(path: &Path) -> Result<fs::Metadata, Failure> {
    let meta = io(fs::symlink_metadata(path))?;
    // SAFETY: current identity query only. No other user's service is admitted.
    if !meta.is_file()
        || meta.nlink() != 1
        || meta.uid() != unsafe { libc::geteuid() }
        || meta.mode() & 0o022 != 0
        || meta.len() > 65536
    {
        return Err(Failure::Unverified);
    }
    verified(installer::acl_policy(path, 2))?;
    Ok(meta)
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
// Ordinary runtime attestation binds the live boot/profile/hello, even for build:null.
// It is NOT retained-runtime proof and does not grant the private updater endpoint.
fn prove(
    location: &Location,
    expected: &Value,
    daemon: &str,
    lineage: &str,
) -> Result<(), Failure> {
    let fresh = verified(coordination::record(location))?;
    if &fresh != expected {
        return Err(Failure::Unverified);
    }
    let nonce = verified(coordination::random_hex())?;
    let secret = fresh["secret"].as_str().ok_or(Failure::Unverified)?;
    let key = (0..64)
        .step_by(2)
        .map(|ix| u8::from_str_radix(&secret[ix..ix + 2], 16).map_err(|_| Failure::Unverified))
        .collect::<Result<Vec<_>, _>>()?;
    let client = reqwest::blocking::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|_| Failure::Unverified)?;
    let mut response = client
        .get(format!(
            "http://127.0.0.1:{}/__pilot_runtime/v1?challenge={nonce}",
            location.port
        ))
        .send()
        .and_then(|r| r.error_for_status())
        .map_err(|_| Failure::Unverified)?;
    let mut bytes = Vec::new();
    io(response.by_ref().take(16385).read_to_end(&mut bytes))?;
    if bytes.len() > 16384 {
        return Err(Failure::Unverified);
    }
    let envelope: Value = serde_json::from_slice(&bytes).map_err(|_| Failure::Unverified)?;
    let body = envelope["body"].as_str().ok_or(Failure::Unverified)?;
    let mac = envelope["mac"]
        .as_str()
        .filter(|v| v.len() == 64 && v.is_ascii())
        .ok_or(Failure::Unverified)?;
    let signature = (0..64)
        .step_by(2)
        .map(|ix| u8::from_str_radix(&mac[ix..ix + 2], 16).map_err(|_| Failure::Unverified))
        .collect::<Result<Vec<_>, _>>()?;
    hmac::verify(
        &hmac::Key::new(hmac::HMAC_SHA256, &key),
        body.as_bytes(),
        &signature,
    )
    .map_err(|_| Failure::Unverified)?;
    let body: Value = serde_json::from_str(body).map_err(|_| Failure::Unverified)?;
    if body["schema"] != 1
        || body["challenge"] != nonce
        || body["ready"] != true
        || body["hello"]["daemonId"] != daemon
        || body["hello"]["lineageId"] != lineage
        || body["hello"]["capabilities"]["independentExecution"] != true
        || body["hello"]["protocolVersion"]
            .as_u64()
            .is_none_or(|v| v < 1)
        || body["hello"]["minimumClientProtocolVersion"]
            .as_u64()
            .is_none_or(|v| v != 1)
    {
        return Err(Failure::Unverified);
    }
    for field in ["boot", "home", "port", "pid", "build", "runtimeRoot"] {
        if body[field] != expected[field] {
            return Err(Failure::Unverified);
        }
    }
    if verified(coordination::record(location))? != fresh {
        return Err(Failure::Unverified);
    }
    Ok(())
}

impl LaunchAgent<'_> {
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
        let root = node.ancestors().nth(4).ok_or(Failure::Unsupported)?;
        if root.file_name().is_some_and(|n| n == "Resources") {
            // Swift's sole supported bundle layout. Source-checkout/custom services refuse.
            let app = root
                .parent()
                .and_then(Path::parent)
                .ok_or(Failure::Unsupported)?;
            if app.file_name().is_none_or(|n| n != "Pilot.app") {
                return Err(Failure::Unsupported);
            }
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
            let capsule = node.ancestors().nth(6).ok_or(Failure::Unsupported)?;
            let id = verified(runtime::identity(capsule))?;
            verified(coordination::validate_capsule(
                capsule,
                self.trust,
                &[],
                Some(&id),
            ))?;
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
            let requested = Instant::now();
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
                self.pause_until = Some(requested + Duration::from_secs(25));
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
        // Refresh after potentially slow code verification, not before it. The 25s
        // local deadline is shorter than the daemon's 30s lease, measured pre-request.
        if !self.drained()? {
            return Err(Failure::Busy);
        }
        Ok(())
    }
    fn journal(&mut self, phase: &str) -> Result<(), Failure> {
        let value = json!({"schema":1,"phase":phase,"boot":self.owner["boot"],"daemonId":self.daemon,"lineageId":self.lineage,"profile":self.location.home,"service":self.service,"capsule":self.current,"previousDefinition":self.original,"nextDefinition":self.replacement});
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
        if self.live_definition()? != self.pid()?
            || self.pause_until.is_none_or(|until| Instant::now() >= until)
        {
            return Err(Failure::Unverified);
        }
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
            || coordination::owner_live(&self.location.home)
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
        io(fs::rename(&temp, &self.plist))?;
        io(io(File::open(self.plist.parent().ok_or(Failure::Unverified)?))?.sync_all())
    }
    fn start(&mut self) -> Result<(), Failure> {
        self.verify_target()?;
        if coordination::owner_live(&self.location.home) {
            return Err(Failure::Unverified);
        }
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
    if object.len() != FIELDS.len()
        || object.keys().any(|k| !FIELDS.contains(&k.as_str()))
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
    if env
        .keys()
        .any(|k| !["PATH", "PILOT_HOME", "PILOT_PORT", "PILOT_AGENT_DIR"].contains(&k.as_str()))
        || env.values().any(|v| !v.is_string())
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

#[cfg(test)]
mod tests {
    use super::*;
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
