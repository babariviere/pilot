//! One existing launch agent, executing the verified NSH app's own runtime.
//! Global preparation belongs to the native app owner. No capsule publication,
//! registration, model acknowledgement, reservation or Drop-time effects.
use super::*;
use crate::{app_update::Connection, installer::Platform};

/// Sealed app-relative runtime inputs. Never deserialized from retained intent.
#[derive(Clone)]
pub struct Runtime {
    bundle: PathBuf,
    installed: PathBuf,
    trust: Trust,
    source: String,
    build: Value,
    identity: String,
}
impl Runtime {
    /// Resolve only the already installed signed app's own runtime. Called on
    /// an update worker, not ordinary read-only GUI startup. No capsule/JSON
    /// launch flag or retained installing intent supplies this authority.
    pub fn installed(app: &Path, trust: &Trust) -> Result<Self, Failure> {
        verified(trust.validate())?;
        verified(installer::validate_target(app, trust))?;
        verified(installer::MacPlatform.verify(app, trust, &trust.current_build, None))?;
        let stamp = super::super::native::runtime_stamp(app)?;
        let source = stamp["source"].as_str().ok_or(Failure::Unverified)?;
        Self::verify(app, app, trust, source, &trust.current_build)
    }

    /// Worker-only. `bundle` is a verified preflight app, `installed` its final
    /// GUI location. The code seal and exact source/build are checked here too.
    pub fn verify(
        bundle: &Path,
        installed: &Path,
        trust: &Trust,
        source: &str,
        build: &str,
    ) -> Result<Self, Failure> {
        Self::verify_with(
            bundle,
            installed,
            trust,
            source,
            build,
            &installer::MacPlatform,
        )
    }
    fn verify_with(
        bundle: &Path,
        installed: &Path,
        trust: &Trust,
        source: &str,
        build: &str,
        platform: &impl Platform,
    ) -> Result<Self, Failure> {
        verified(trust.validate())?;
        verified(crate::manifest::Build::parse(build))?;
        if source.len() != 40
            || !source
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(Failure::Unverified);
        }
        verified(installer::validate_target(bundle, trust))?;
        verified(installer::validate_target(installed, trust))?;
        verified(platform.verify(bundle, trust, build, None))?;
        let stamp = runtime_inputs(bundle, source)?;
        let identity = verified(runtime::identity(bundle))?;
        let mut selected = trust.clone();
        selected.current_build = build.into();
        Ok(Self {
            bundle: bundle.into(),
            installed: installed.into(),
            trust: selected,
            source: source.into(),
            build: stamp,
            identity,
        })
    }
    /// Exact native preparation replacement. No paths are supplied by TSX.
    pub fn replacement(&self) -> Value {
        json!({"runtimeRoot":self.installed.join(crate::layout::RUNTIME),"build":self.build})
    }
    fn pin(&self) -> Value {
        json!({"app":self.installed,"source":self.source,"guiBuild":self.trust.current_build,
            "identity":self.identity,"replacement":self.replacement()})
    }
    fn recheck(&self, path: &Path) -> Result<(), Failure> {
        self.recheck_with(path, &installer::MacPlatform)
    }
    fn recheck_with(&self, path: &Path, platform: &impl Platform) -> Result<(), Failure> {
        verified(installer::validate_target(path, &self.trust))?;
        verified(platform.verify(path, &self.trust, &self.trust.current_build, None))?;
        if runtime_inputs(path, &self.source)? != self.build
            || verified(runtime::identity(path))? != self.identity
        {
            return Err(Failure::Unverified);
        }
        Ok(())
    }
}

fn runtime_inputs(bundle: &Path, source: &str) -> Result<Value, Failure> {
    let runtime = bundle.join(crate::layout::RUNTIME);
    for relative in [crate::layout::GUI, "Contents/Resources/nsh/bundle.nshc"] {
        let path = bundle.join(relative);
        if !io(fs::symlink_metadata(&path))?.is_file() || io(path.canonicalize())? != path {
            return Err(Failure::Unverified);
        }
    }
    for (name, executable) in [
        ("node/bin/node", true),
        ("packages/daemon/src/main.ts", false),
    ] {
        let path = runtime.join(name);
        let meta = io(fs::symlink_metadata(&path))?;
        if !meta.is_file()
            || io(path.canonicalize())? != path
            || executable && meta.mode() & 0o111 == 0
        {
            return Err(Failure::Unverified);
        }
    }
    let stamp = super::super::native::runtime_stamp(bundle)?;
    super::super::runtime_version(&stamp)?;
    let object = stamp.as_object().ok_or(Failure::Unverified)?;
    if object.len() != 7
        || stamp["source"] != source
        || stamp["node"]
            .as_str()
            .is_none_or(|s| s.is_empty() || s.len() > 128)
    {
        return Err(Failure::Unverified);
    }
    Ok(stamp)
}

// Retain the actual lease inode across shutdown. Missing/replaced files do not
// prove release. This is exact root/lease proof, never descendant-exit proof.
struct Lease(File);
impl Lease {
    fn open(location: &Location, pid: i32) -> Result<Self, Failure> {
        verify_process_owner(pid, &location.home)?;
        let path = location.home.join(".daemon-owner.sqlite");
        let file = io(OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK)
            .open(&path))?;
        let meta = io(file.metadata())?;
        if !meta.is_file() || meta.nlink() != 1 || meta.uid() != unsafe { libc::geteuid() } {
            return Err(Failure::Unverified);
        }
        let lease = Self(file);
        lease.same(location)?;
        verified(coordination::lease_owned_by(&location.home, pid))?;
        Ok(lease)
    }
    fn same(&self, location: &Location) -> Result<(), Failure> {
        let before = io(self.0.metadata())?;
        let now = io(fs::symlink_metadata(
            location.home.join(".daemon-owner.sqlite"),
        ))?;
        if !now.is_file() || (now.dev(), now.ino()) != (before.dev(), before.ino()) {
            return Err(Failure::Unverified);
        }
        Ok(())
    }
    fn released(&self, location: &Location) -> Result<(), Failure> {
        self.same(location)?;
        // SAFETY: valid retained descriptor and initialized F_GETLK query.
        let mut lock: libc::flock = unsafe { std::mem::zeroed() };
        lock.l_type = libc::F_WRLCK;
        lock.l_whence = libc::SEEK_SET as _;
        if unsafe { libc::fcntl(self.0.as_raw_fd(), libc::F_GETLK, &mut lock) } != 0
            || lock.l_type != libc::F_UNLCK
        {
            return Err(Failure::Busy);
        }
        Ok(())
    }
}

fn preparation(operation: &Value, receipt: &Value, target: &Runtime) -> Result<(), Failure> {
    use sha2::{Digest, Sha256};
    let payload = operation["payload"].as_str().ok_or(Failure::Unverified)?;
    let decoded: Value = serde_json::from_str(payload).map_err(|_| Failure::Unverified)?;
    let digest = crate::transport::hex(&Sha256::digest(payload.as_bytes()));
    if operation["schemaVersion"] != 1
        || operation["kind"] != "global-update-prepare"
        || operation["targetId"] != "global-update"
        || operation["payloadHash"] != digest
        || operation["operationId"]
            .as_str()
            .is_none_or(|s| s.is_empty() || s.len() > 128)
        || decoded["replacement"] != target.replacement()
        || decoded["app"] != json!({"source":target.source,"build":target.trust.current_build})
        || receipt["state"] != "accepted"
        || receipt["result"]["target"] != decoded
        || ["operationId", "payloadHash", "destination", "targetId"]
            .iter()
            .any(|key| receipt[*key] != operation[*key])
    {
        return Err(Failure::Unverified);
    }
    Ok(())
}

// Consent and state-loss policy belong to the native update owner. This gate
// deliberately does not require healthy chat phases or cooperative close ACKs.
// Its blockers are independent process/resource evidence, which Force cannot waive.
fn prepared(operation: &Value, fresh: &Value, target: &Runtime) -> Result<(), Failure> {
    preparation(operation, &fresh["receipt"], target)?;
    if fresh["blockers"].as_array().is_none_or(|b| !b.is_empty()) {
        return Err(Failure::Busy);
    }
    Ok(())
}

/// Fresh stop capability. Only the original native dispatch can create one.
/// Dropping it leaves durable evidence and the daemon stopped, never restarts.
pub struct Stopped<'a> {
    host: LaunchAgent<'a>,
    lease: Lease,
    operation: Value,
    target: &'a Runtime,
    original_build: Value,
}

/// Stop the existing selected service after host-owned global preparation.
/// This never sends prepare/cancel, creates a service, or consumes saved intent.
pub fn stop<'a>(
    connection: &'a Connection,
    target: &'a Runtime,
    operation: &Value,
    cancel: &'a AtomicBool,
) -> Result<Stopped<'a>, Failure> {
    stop_owned(connection, target, operation, cancel, None)
}

fn stop_owned<'a>(
    connection: &'a Connection,
    target: &'a Runtime,
    operation: &Value,
    cancel: &'a AtomicBool,
    rollback: Option<&Value>,
) -> Result<Stopped<'a>, Failure> {
    target.recheck(&target.bundle)?;
    let mut host = launch_agent(
        connection.location().clone(),
        &target.installed,
        &target.trust,
        connection.daemon(),
        connection.lineage(),
        cancel,
    )?;
    host.lock = Some(super::super::native::lock(&host.location)?);
    super::super::native::no_incomplete_handoff(&host.location)?;
    // Even a completed original operation is lookup-only. A fresh native call
    // cannot reuse a still-accepted global preparation to stop twice.
    let prior = host.location.home.join(JOURNAL);
    if prior.try_exists().map_err(|_| Failure::Unverified)? {
        let retained = verified(coordination::private_json(&prior, 65536))?;
        fresh_handoff(&retained, operation, target, rollback)?;
    } else if rollback.is_some() {
        return Err(Failure::Unknown);
    }
    host.owner = verified(coordination::record(&host.location))?;
    if rollback.is_some_and(|r| host.owner["boot"] != r["boot"] || host.owner["pid"] != r["pid"]) {
        return Err(Failure::Unknown);
    }
    if super::super::runtime_version(&target.build)?
        < super::super::runtime_version(&host.owner["build"])?
    {
        return Err(Failure::Unverified);
    }
    let meta = private_regular(&host.plist)?;
    host.plist_stamp = Some((meta.dev(), meta.ino()));
    host.original = plist(&host.plist)?;
    validate_definition(&host.original, &host.home, &host.location, &host.label)?;
    // Existing service/profile ownership only. No legacy adoption on this path.
    if host.original["PilotNextManaged"] != true
        || verified(coordination::private_json(
            &host.plist.with_extension("plist.next-owner"),
            4096,
        ))? != json!({"schema":1,"profile":host.location.home,"port":host.location.port})
    {
        return Err(Failure::Unsupported);
    }
    host.revalidate()?;
    verify_original(&host)?;
    let lease = Lease::open(&host.location, host.pid()?)?;
    host.watch = Some(verified(helper::ParentWatch::new(host.pid()?))?);
    let fresh = verified(coordination::global_update(
        &host.location,
        operation,
        coordination::GlobalUpdateAction::Verify,
    ))?;
    prepared(operation, &fresh, target)?;
    host.revalidate()?;
    host.check_cancel()?;
    let original_build = rollback.map_or_else(
        || host.owner["build"].clone(),
        |r| r["originalBuild"].clone(),
    );
    let mut stopped = Stopped {
        host,
        lease,
        operation: operation.clone(),
        target,
        original_build,
    };
    stop_steps(&mut stopped)?;
    Ok(stopped)
}

fn fresh_handoff(
    retained: &Value,
    operation: &Value,
    target: &Runtime,
    rollback: Option<&Value>,
) -> Result<(), Failure> {
    if let Some(completed) = rollback {
        if completed["role"] != "successor"
            || retained["operation"] != *operation
            || retained["phase"] != "complete"
            || retained["completion"] != *completed
            || completed["runtime"] != target.replacement()
            || completed["app"] != target.pin()
        {
            return Err(Failure::Unknown);
        }
    } else if retained["operation"]["operationId"] == operation["operationId"] {
        return Err(Failure::Unknown);
    }
    Ok(())
}

fn verify_original(host: &LaunchAgent<'_>) -> Result<(), Failure> {
    let root = definition_root(&host.original)?;
    let build = verified(coordination::code_build(&root))?;
    verified(installer::validate_target(&root, host.trust))?;
    verified(installer::MacPlatform.verify(&root, host.trust, &build, None))?;
    if super::super::native::runtime_stamp(&root)? != host.owner["build"]
        || verified(helper::process_executable(host.pid()?))?
            != io(root
                .join(crate::layout::RUNTIME)
                .join("node/bin/node")
                .canonicalize())?
    {
        return Err(Failure::Unverified);
    }
    Ok(())
}

impl<'a> Stopped<'a> {
    fn journal(&self, phase: &str, completion: Option<Value>) -> Result<(), Failure> {
        super::super::native::journal(&self.host.location, &json!({"schema":2,"phase":phase,
            "purpose":"bundled-service","operation":self.operation,"target":self.target.pin(),
            "daemonId":self.host.daemon,"lineageId":self.host.lineage,"profile":self.host.location.home,
            "port":self.host.location.port,"boot":self.host.owner["boot"],"pid":self.host.owner["pid"],
            "previousDefinition":self.host.original,"completion":completion})).map_err(|_| Failure::Unknown)
    }
    /// One successor start, only after the official installer verified the swap.
    /// Failure consumes this capability and remains lookup-only.
    pub fn start(self) -> Result<Completed, Failure> {
        self.start_as("successor")
    }

    /// One rollback start while still stopped, after the original signed app
    /// was restored. A failed/uncertain successor start never yields this handle.
    pub fn rollback(mut self, original: &'a Runtime) -> Result<Completed, Failure> {
        if original.build != self.original_build || original.installed != self.target.installed {
            return Err(Failure::Unknown);
        }
        self.target = original;
        self.host.trust = &original.trust;
        self.start_as("rollback")
    }
    fn start_as(mut self, role: &str) -> Result<Completed, Failure> {
        (|| {
            self.target.recheck(&self.target.installed)?;
            self.lease.released(&self.host.location)?;
            self.host.replacement = self.host.original.clone();
            let runtime = self.target.installed.join(crate::layout::RUNTIME);
            self.host.replacement["ProgramArguments"] = json!([
                runtime.join("node/bin/node"),
                runtime.join("packages/daemon/src/main.ts")
            ]);
            self.host.replacement["EnvironmentVariables"]["PILOT_HOME"] =
                json!(self.host.location.home);
            let path = self.host.original["EnvironmentVariables"]["PATH"]
                .as_str()
                .ok_or(Failure::Unverified)?;
            self.host.replacement["EnvironmentVariables"]["PATH"] =
                json!(runtime_path(&runtime, path));
            start_steps(&mut self)?;
            let owner = verified(coordination::record(&self.host.location))?;
            if owner["boot"] == self.host.owner["boot"]
                || owner["build"] != self.target.build
                || owner["runtimeRoot"] != self.target.replacement()["runtimeRoot"]
            {
                return Err(Failure::Unverified);
            }
            let pid = owner["pid"]
                .as_i64()
                .and_then(|p| i32::try_from(p).ok())
                .ok_or(Failure::Unverified)?;
            verify_process_owner(pid, &self.host.location.home)?;
            prove(
                &self.host.location,
                &owner,
                self.host.daemon,
                self.host.lineage,
            )?;
            let completion = json!({"role":role,"boot":owner["boot"],"pid":owner["pid"],"originalBuild":self.original_build,
                "runtime":self.target.replacement(),"app":self.target.pin()});
            self.journal("complete", Some(completion.clone()))?;
            Ok(Completed(completion))
        })()
        .map_err(|_| Failure::Unknown)
    }
}

// The same ordered mutations are used by the native adapter and fault tests.
// No method retries a step or converts a group/cancel ACK into exit evidence.
trait Transition {
    fn phase(&mut self, phase: &str) -> Result<(), Failure>;
    fn stop(&mut self) -> Result<(), Failure>;
    fn exit(&mut self) -> Result<(), Failure>;
    fn lease(&mut self) -> Result<(), Failure>;
    fn replace(&mut self) -> Result<(), Failure>;
    fn start(&mut self) -> Result<(), Failure>;
    fn verify(&mut self) -> Result<(), Failure>;
}
fn stop_steps(host: &mut impl Transition) -> Result<(), Failure> {
    (|| {
        host.phase("stopping")?;
        host.stop()?;
        host.exit()?;
        host.lease()?;
        host.phase("stopped")
    })()
    .map_err(|_| Failure::Unknown)
}
fn start_steps(host: &mut impl Transition) -> Result<(), Failure> {
    (|| {
        host.lease()?;
        host.phase("starting")?;
        host.replace()?;
        host.start()?;
        host.verify()
    })()
    .map_err(|_| Failure::Unknown)
}
impl Transition for Stopped<'_> {
    fn phase(&mut self, phase: &str) -> Result<(), Failure> {
        self.journal(phase, None)
    }
    fn stop(&mut self) -> Result<(), Failure> {
        self.host.revalidate()?;
        verify_original(&self.host)?;
        self.lease.same(&self.host.location)?;
        self.target.recheck(&self.target.bundle)?;
        command(
            "/bin/launchctl",
            &["bootout".as_ref(), self.host.service.as_ref()],
        )
        .map(|_| ())
    }
    fn exit(&mut self) -> Result<(), Failure> {
        self.host.exited()
    }
    fn lease(&mut self) -> Result<(), Failure> {
        self.lease.released(&self.host.location)
    }
    fn replace(&mut self) -> Result<(), Failure> {
        self.host.replace_definition()
    }
    fn start(&mut self) -> Result<(), Failure> {
        self.host.start()
    }
    fn verify(&mut self) -> Result<(), Failure> {
        self.host.verify_started()?;
        let owner = verified(coordination::record(&self.host.location))?;
        let pid = owner["pid"]
            .as_i64()
            .and_then(|p| i32::try_from(p).ok())
            .ok_or(Failure::Unverified)?;
        self.lease.same(&self.host.location)?;
        verify_process_owner(pid, &self.host.location.home)?;
        self.target.recheck(&self.target.installed)
    }
}
/// Exact observed completion, not agent-resume authority.
pub struct Completed(Value);
impl Completed {
    pub fn evidence(&self) -> &Value {
        &self.0
    }

    /// Fresh explicit rollback after a confirmed successor. This consumes the
    /// completion capability, stops that exact successor, runs the official
    /// restore once, then starts the verified original runtime once. Retained
    /// evidence or an uncertain start cannot reconstruct this capability.
    pub fn rollback<'a>(
        self,
        connection: &'a Connection,
        current: &'a Runtime,
        original: &'a Runtime,
        operation: &Value,
        cancel: &'a AtomicBool,
        restore: impl FnOnce() -> Result<(), Failure>,
    ) -> Result<Completed, Failure> {
        if original.build != self.0["originalBuild"] || original.installed != current.installed {
            return Err(Failure::Unverified);
        }
        let stopped = stop_owned(connection, current, operation, cancel, Some(&self.0))?;
        restore().map_err(|_| Failure::Unknown)?;
        stopped.rollback(original)
    }
}

/// Original-operation lookup only. No stop, start, retarget or reconstruction.
pub fn lookup(connection: &Connection, operation: &Value) -> Result<Value, Failure> {
    let value = verified(coordination::private_json(
        &connection.location().home.join(JOURNAL),
        65536,
    ))?;
    if value["schema"] != 2
        || value["purpose"] != "bundled-service"
        || value["operation"] != *operation
        || value["profile"] != json!(connection.location().home)
        || value["port"] != connection.location().port
        || value["daemonId"] != connection.daemon()
        || value["lineageId"] != connection.lineage()
    {
        return Err(Failure::Unverified);
    }
    Ok(value)
}

#[cfg(test)]
#[path = "bundled_service_tests.rs"]
mod tests;
