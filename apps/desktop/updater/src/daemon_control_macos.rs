//! Explicit controls for an already Next-managed launch agent. No registration,
//! definition replacement, login enablement, runtime publication or automatic retry.
use super::*;
use crate::installer::Platform;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Command {
    Start,
    Stop,
    Restart,
}
impl Command {
    fn purpose(self) -> &'static str {
        match self {
            Self::Start => "daemon-start",
            Self::Stop => "daemon-stop",
            Self::Restart => "daemon-restart",
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum State {
    Running,
    Stopped,
}

/// Native inspection snapshot, not authority to act later. Kept opaque so callers
/// cannot substitute a boot, service, definition or runtime after confirmation.
#[derive(Clone)]
pub struct Target {
    location: Location,
    home: PathBuf,
    label: String,
    definition: Value,
    stamp: (u64, u64),
    owner: Value,
    daemon: String,
    lineage: String,
    root: PathBuf,
    state: State,
}
impl Target {
    pub fn state(&self) -> State {
        self.state
    }
    pub fn permits(&self, command: Command) -> bool {
        matches!(
            (self.state, command),
            (State::Stopped, Command::Start) | (State::Running, Command::Stop | Command::Restart)
        )
    }
}

/// Inspect only the established Local label/profile. No service or file writes.
pub fn inspect(location: Location, trust: &Trust) -> Result<Target, Failure> {
    let home = PathBuf::from(std::env::var_os("HOME").ok_or(Failure::Unverified)?);
    inspect_at(location, &home, LABEL, trust)
}
pub(super) fn inspect_at(
    location: Location,
    home: &Path,
    label: &str,
    trust: &Trust,
) -> Result<Target, Failure> {
    super::super::native::no_incomplete_handoff(&location)?;
    let file = home
        .join("Library/LaunchAgents")
        .join(format!("{label}.plist"));
    verified(installer::validate_parents(
        file.parent().ok_or(Failure::Unverified)?,
    ))?;
    let meta = private_regular(&file)?;
    let definition = plist(&file)?;
    validate_definition(&definition, home, &location, label)?;
    if definition["PilotNextManaged"] != true {
        return Err(Failure::Unsupported);
    }
    // A pre-existing ownership claim is required. Controls never silently adopt.
    let claim = verified(coordination::private_json(
        &file.with_extension("plist.next-owner"),
        4096,
    ))?;
    if claim != json!({"schema":1,"profile":location.home,"port":location.port}) {
        return Err(Failure::Unverified);
    }
    let root = definition_root(&definition)?;
    if !prior_capsule(&root, trust, home) {
        return Err(Failure::Unsupported);
    }
    let owner = verified(coordination::record(&location))?;
    let identity = |name: &str| -> Result<String, Failure> {
        String::from_utf8(super::super::native::read_file(
            &location.home.join(name),
            4096,
        )?)
        .map(|v| v.trim().to_owned())
        .map_err(|_| Failure::Unverified)
    };
    let daemon = identity("daemon-id")?;
    let lineage = identity("storage-lineage")?;
    if daemon.is_empty()
        || lineage.is_empty()
        || owner["runtimeRoot"].as_str() != root.join(crate::layout::RUNTIME).to_str()
    {
        return Err(Failure::Unverified);
    }
    let cancel = AtomicBool::new(false);
    let mut host = launch_agent(location.clone(), &root, trust, &daemon, &lineage, &cancel)?;
    // The cancellation flag must outlive the host.
    host.original = definition.clone();
    host.owner = owner.clone();
    host.home = home.to_owned();
    host.label = label.into();
    host.plist = file;
    host.service = format!("gui/{}/{label}", unsafe { libc::geteuid() });
    let state = match loaded(&host)? {
        true => {
            if host.live_definition()? != host.pid()? {
                return Err(Failure::Unverified);
            }
            host.verify_running_payload()?;
            State::Running
        }
        false => {
            stopped(&host)?;
            verify_runtime(&host)?;
            State::Stopped
        }
    };
    Ok(Target {
        location,
        home: home.to_owned(),
        label: label.into(),
        definition,
        stamp: (meta.dev(), meta.ino()),
        owner,
        daemon,
        lineage,
        root,
        state,
    })
}

fn loaded(host: &LaunchAgent<'_>) -> Result<bool, Failure> {
    let (status, _) = super::super::native::command_status(
        "/bin/launchctl",
        &["print".as_ref(), host.service.as_ref()],
    )?;
    match status.code() {
        Some(0) => Ok(true),
        // launchctl's specific 'service not found in domain' result. Other
        // command/manager failures are Unknown inspection, never stopped.
        Some(113) => Ok(false),
        _ => Err(Failure::Unverified),
    }
}
fn stopped(host: &LaunchAgent<'_>) -> Result<(), Failure> {
    if loaded(host)? || coordination::owner_live(&host.location.home) {
        return Err(Failure::Busy);
    }
    let socket = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, host.location.port))
        .map_err(|_| Failure::Busy)?;
    drop(socket);
    Ok(())
}
fn verify_runtime(host: &LaunchAgent<'_>) -> Result<(), Failure> {
    verified(installer::validate_target(&host.current, host.trust))?;
    let build = verified(coordination::code_build(&host.current))?;
    // Verify the selected runtime's own sealed build, not the GUI's version.
    verified(installer::MacPlatform.verify(&host.current, host.trust, &build, None))?;
    if super::super::native::runtime_stamp(&host.current)? != host.owner["build"] {
        return Err(Failure::Unverified);
    }
    Ok(())
}

// The existing idle admission refuses whole unfinished runs before asking them
// to pause. The signed control reservation rechecks idle under the full freeze.
fn idle_before_pause(host: &LaunchAgent<'_>) -> Result<(), Failure> {
    prove(&host.location, &host.owner, host.daemon, host.lineage)?;
    let client = reqwest::blocking::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|_| Failure::Unverified)?;
    let mut response = client
        .post(format!(
            "http://127.0.0.1:{}/api/update/prepare",
            host.location.port
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
    prove(&host.location, &host.owner, host.daemon, host.lineage)?;
    if value["ready"] != true {
        return Err(Failure::Busy);
    }
    host.check_cancel()
}

/// One explicit action against an exact inspected snapshot. After durable intent,
/// every error is inspect-only. No Drop handler, GUI exit or transport loss replays it.
pub fn execute(
    target: &Target,
    command: Command,
    trust: &Trust,
    cancel: &AtomicBool,
) -> Result<State, Failure> {
    if !target.permits(command) {
        return Err(Failure::Unsupported);
    }
    let _lock = super::super::native::lock(&target.location)?;
    let current = inspect_at(target.location.clone(), &target.home, &target.label, trust)?;
    if current.state != target.state
        || current.definition != target.definition
        || current.stamp != target.stamp
        || current.owner != target.owner
        || current.daemon != target.daemon
        || current.lineage != target.lineage
    {
        return Err(Failure::Unverified);
    }
    let mut host = launch_agent(
        target.location.clone(),
        &target.root,
        trust,
        &target.daemon,
        &target.lineage,
        cancel,
    )?;
    host.home = target.home.clone();
    host.label = target.label.clone();
    host.service = format!("gui/{}/{}", unsafe { libc::geteuid() }, target.label);
    host.plist = target
        .home
        .join("Library/LaunchAgents")
        .join(format!("{}.plist", target.label));
    host.original = target.definition.clone();
    host.replacement = target.definition.clone();
    host.owner = target.owner.clone();
    host.plist_stamp = Some(target.stamp);
    let preflight = (|| {
        host.check_cancel()?;
        if command != Command::Stop {
            verify_runtime(&host)?;
        }
        if command != Command::Start {
            idle_before_pause(&host)?;
            host.watch = Some(verified(helper::ParentWatch::new(host.pid()?))?);
            if !host.drained()? {
                return Err(Failure::Busy);
            }
            host.reservation = Some(super::super::reservation::Reservation::prepare_for(
                &host.location,
                &host.owner,
                command.purpose(),
            )?);
            host.revalidate()?;
            host.verify_reservation()?;
        } else {
            stopped(&host)?;
        }
        host.check_cancel()
    })();
    if let Err(error) = preflight {
        host.cancel_reservation();
        return Err(error);
    }
    let journal = |phase: &str, host: &LaunchAgent<'_>, completion: Option<Value>| {
        super::super::native::journal(
            &host.location,
            &json!({"schema":1,"phase":phase,
            "purpose":command.purpose(),"profile":host.location.home,"port":host.location.port,
            "service":host.service,"runtime":host.current,"boot":host.owner["boot"],"pid":host.owner["pid"],"build":host.owner["build"],
            "daemonId":target.daemon,"lineageId":target.lineage,"definition":target.definition,
            "receipt":host.reservation.as_ref().map(|r| &r.receipt),"completion":completion}),
        )
    };
    // Journal persistence can itself be uncertain. Do not clear/rollback/retry.
    journal(
        if command == Command::Start {
            "starting"
        } else {
            "stopping"
        },
        &host,
        None,
    )
    .map_err(|_| Failure::Unknown)?;
    let committed = (|| {
        let mut completion = json!({"state":"stopped"});
        if command != Command::Start {
            // Existing reserved service handoff stop, not PID kill/force-stop.
            host.stop()?;
            host.exited()?;
            stopped(&host)?;
        }
        if command != Command::Stop {
            journal("starting", &host, None)?;
            // Preserve the exact definition and selected runtime. No enable,
            // replacement, registration or cancellation once shutdown began.
            verify_runtime(&host)?;
            if plist(&host.plist)? != target.definition {
                return Err(Failure::Unverified);
            }
            stopped(&host)?;
            host.bootstrap()?;
            host.verify_started()?;
            let owner = verified(coordination::record(&host.location))?;
            let pid = owner["pid"]
                .as_i64()
                .and_then(|p| i32::try_from(p).ok())
                .ok_or(Failure::Unverified)?;
            verify_process_owner(pid, &host.location.home)?;
            prove(&host.location, &owner, &target.daemon, &target.lineage)?;
            if host.live_definition()? != pid
                || owner["boot"] == target.owner["boot"]
                || owner["runtimeRoot"] != target.owner["runtimeRoot"]
                || owner["build"] != target.owner["build"]
            {
                return Err(Failure::Unverified);
            }
            completion = json!({"state":"running","boot":owner["boot"],"pid":pid,"runtimeRoot":owner["runtimeRoot"],"build":owner["build"]});
        }
        if plist(&host.plist)? != target.definition {
            return Err(Failure::Unverified);
        }
        journal("complete", &host, Some(completion))?;
        Ok(if command == Command::Stop {
            State::Stopped
        } else {
            State::Running
        })
    })();
    committed.map_err(|_: Failure| Failure::Unknown)
}
