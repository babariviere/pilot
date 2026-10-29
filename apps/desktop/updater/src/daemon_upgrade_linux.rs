//! Narrow systemd --user adapter. No shell, sudo, linger or foreground fallback.
use super::{Failure, Handoff, execute, native, reservation::Reservation};
use crate::{
    coordination::{self, Location},
    helper, installer,
    manifest::Trust,
};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs::{self, File},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

const UNIT: &str = "pilotd.service";
fn verified<T>(value: Result<T, crate::Error>) -> Result<T, Failure> {
    value.map_err(|_| Failure::Unverified)
}
fn io<T>(value: std::io::Result<T>) -> Result<T, Failure> {
    value.map_err(|_| Failure::Unverified)
}
fn systemctl(args: &[&std::ffi::OsStr]) -> Result<String, Failure> {
    let mut all = vec!["--user".as_ref()];
    all.extend_from_slice(args);
    String::from_utf8(native::command("/usr/bin/systemctl", &all)?).map_err(|_| Failure::Unverified)
}
fn manager() -> Result<(), Failure> {
    // Reachable user manager/D-Bus is required, independent of logout/linger policy.
    systemctl(&["show-environment".as_ref()])
        .map(|_| ())
        .map_err(|_| Failure::Unsupported)
}
fn unit_path(home: &Path) -> Result<PathBuf, Failure> {
    let config = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".config"));
    if !config.is_absolute() {
        return Err(Failure::Unsupported);
    }
    Ok(config.join("systemd/user").join(UNIT))
}
fn properties() -> Result<BTreeMap<String, String>, Failure> {
    let text = systemctl(&["show".as_ref(),UNIT.as_ref(),"--property=FragmentPath,DropInPaths,MainPID,NeedDaemonReload,ControlGroup,UnitFileState,LoadState".as_ref()])?;
    text.lines()
        .map(|line| {
            line.split_once('=')
                .map(|(k, v)| (k.to_owned(), v.to_owned()))
                .ok_or(Failure::Unverified)
        })
        .collect()
}
fn definition(root: &Path, home: &Path, location: &Location) -> Result<String, Failure> {
    let runtime = root.join(crate::layout::RUNTIME);
    // The generator is part of the already verified complete runtime closure.
    let script = "import {serviceUnit} from './service.mjs'; const [root,home,config]=process.argv.slice(1); process.stdout.write(serviceUnit(root,home,JSON.parse(config)))";
    let config =
        json!({"profile":location.home,"port":location.port,"policy":location.policy}).to_string();
    let output = native::command(
        runtime
            .join("node/bin/node")
            .to_str()
            .ok_or(Failure::Unverified)?,
        &[
            "--input-type=module".as_ref(),
            "-e".as_ref(),
            // Absolute module URL avoids cwd inside the immutable capsule.
            script
                .replace(
                    "'./service.mjs'",
                    &serde_json::to_string(
                        url::Url::from_file_path(runtime.join("service.mjs"))
                            .map_err(|_| Failure::Unverified)?
                            .as_str(),
                    )
                    .map_err(|_| Failure::Unverified)?,
                )
                .as_ref(),
            runtime.as_os_str(),
            home.as_os_str(),
            config.as_ref(),
        ],
    )?;
    String::from_utf8(output).map_err(|_| Failure::Unverified)
}
fn capsule(current: &Path, root: &Path, trust: &Trust) -> Result<(), Failure> {
    use sha2::{Digest, Sha256};
    let (accepted, _) = verified(coordination::policy(current))?;
    let id = crate::transport::hex(&Sha256::digest(io(fs::read(
        current.join(crate::linux::INVENTORY),
    ))?));
    verified(coordination::validate_capsule(
        root,
        trust,
        &accepted,
        Some(&id),
    ))?;
    Ok(())
}
pub fn upgrade(
    location: Location,
    current: &Path,
    trust: &Trust,
    daemon: &str,
    lineage: &str,
    cancel: &AtomicBool,
) -> Result<(), Failure> {
    let home = PathBuf::from(std::env::var_os("HOME").ok_or(Failure::Unverified)?);
    let mut host = UserService {
        file: unit_path(&home)?,
        home,
        location,
        current: current.to_owned(),
        trust,
        daemon,
        lineage,
        cancel,
        owner: Value::Null,
        old: String::new(),
        next: String::new(),
        watch: None,
        lock: None,
        reservation: None,
    };
    execute(&mut host, cancel)
}
struct UserService<'a> {
    file: PathBuf,
    home: PathBuf,
    location: Location,
    current: PathBuf,
    trust: &'a Trust,
    daemon: &'a str,
    lineage: &'a str,
    cancel: &'a AtomicBool,
    owner: Value,
    old: String,
    next: String,
    watch: Option<helper::ParentWatch>,
    lock: Option<File>,
    reservation: Option<Reservation>,
}
impl UserService<'_> {
    fn pid(&self) -> Result<i32, Failure> {
        self.owner["pid"]
            .as_i64()
            .and_then(|p| i32::try_from(p).ok())
            .filter(|p| *p > 1)
            .ok_or(Failure::Unverified)
    }
    fn old_root(&self) -> Result<PathBuf, Failure> {
        Path::new(
            self.owner["runtimeRoot"]
                .as_str()
                .ok_or(Failure::Unverified)?,
        )
        .parent()
        .map(Path::to_owned)
        .ok_or(Failure::Unverified)
    }
    fn live(&self) -> Result<(), Failure> {
        let p = properties()?;
        let get = |k: &str| p.get(k).map(String::as_str).unwrap_or("");
        let pid = self.pid()?;
        if get("FragmentPath") != self.file.to_str().ok_or(Failure::Unverified)?
            || !get("DropInPaths").is_empty()
            || get("NeedDaemonReload") != "no"
            || get("LoadState") != "loaded"
            || get("MainPID") != pid.to_string()
            || !["enabled", "enabled-runtime"].contains(&get("UnitFileState"))
        {
            return Err(Failure::Unsupported);
        }
        let group = get("ControlGroup");
        let proc_group = io(fs::read_to_string(format!("/proc/{pid}/cgroup")))?;
        let own_group = io(fs::read_to_string("/proc/self/cgroup"))?;
        if group.is_empty()
            || !group.ends_with(&format!("/{UNIT}"))
            || !proc_group.lines().any(|line| line == format!("0::{group}"))
            || proc_group == own_group
        {
            return Err(Failure::Unverified);
        }
        let root = self.old_root()?;
        let runtime = root.join(crate::layout::RUNTIME);
        let args = io(fs::read(format!("/proc/{pid}/cmdline")))?;
        let expected = format!(
            "{}\0{}\0",
            runtime.join("node/bin/node").display(),
            runtime.join("packages/daemon/src/main.ts").display()
        );
        if args != expected.as_bytes()
            || verified(helper::process_executable(pid))?
                != io(runtime.join("node/bin/node").canonicalize())?
        {
            return Err(Failure::Unverified);
        }
        native::prove(&self.location, &self.owner, self.daemon, self.lineage)
    }
}
impl Handoff for UserService<'_> {
    fn prepare(&mut self) -> Result<(), Failure> {
        manager()?;
        self.lock = Some(native::lock(&self.location)?);
        native::no_incomplete_handoff(&self.location)?;
        self.owner = verified(coordination::record(&self.location))?;
        native::private_regular(&self.file)?;
        self.old = io(fs::read_to_string(&self.file))?;
        let root = self.old_root()?;
        capsule(&self.current, &root, self.trust)?;
        if native::running(&self.location, &root)? != self.owner {
            return Err(Failure::Unverified);
        }
        if self.old != definition(&root, &self.home, &self.location)? {
            return Err(Failure::Unsupported);
        }
        self.live()?;
        self.watch = Some(verified(helper::ParentWatch::new(self.pid()?))?);
        capsule(&self.current, &self.current, self.trust)?;
        self.next = definition(&self.current, &self.home, &self.location)?;
        Ok(())
    }
    fn drained(&mut self) -> Result<bool, Failure> {
        let end = Instant::now() + Duration::from_secs(30);
        loop {
            if self.cancel.load(Ordering::Acquire) {
                return Err(Failure::Cancelled);
            }
            native::prove(&self.location, &self.owner, self.daemon, self.lineage)?;
            if verified(coordination::request_pause(&self.location, self.pid()?))? {
                return Ok(true);
            }
            if Instant::now() >= end {
                return Ok(false);
            }
            std::thread::sleep(Duration::from_millis(500));
        }
    }
    fn reserve(&mut self) -> Result<(), Failure> {
        self.reservation = Some(Reservation::prepare(&self.location, &self.owner)?);
        Ok(())
    }
    fn revalidate(&mut self) -> Result<(), Failure> {
        native::private_regular(&self.file)?;
        if io(fs::read_to_string(&self.file))? != self.old {
            return Err(Failure::Unverified);
        }
        capsule(&self.current, &self.old_root()?, self.trust)?;
        self.live()
    }
    fn verify_reservation(&mut self) -> Result<(), Failure> {
        self.reservation
            .as_ref()
            .ok_or(Failure::Unverified)?
            .verify(&self.location, &self.owner)
    }
    fn cancel_reservation(&mut self) {
        if let Some(r) = self.reservation.take() {
            r.cancel(&self.location, &self.owner);
        }
    }
    fn journal(&mut self, phase: &str) -> Result<(), Failure> {
        native::journal(
            &self.location,
            &json!({"schema":1,"phase":phase,"boot":self.owner["boot"],"daemonId":self.daemon,"lineageId":self.lineage,"profile":self.location.home,"service":UNIT,"capsule":self.current,"previousDefinition":self.old,"nextDefinition":self.next,"receipt":self.reservation.as_ref().map(|r|&r.receipt)}),
        )
    }
    fn stop(&mut self) -> Result<(), Failure> {
        self.live()?;
        self.reservation
            .as_ref()
            .ok_or(Failure::Unverified)?
            .fresh()?;
        systemctl(&["stop".as_ref(), UNIT.as_ref()]).map(|_| ())
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
        native::private_regular(&self.file)?;
        if io(fs::read_to_string(&self.file))? != self.old
            || coordination::owner_live(&self.location.home)
        {
            return Err(Failure::Unverified);
        }
        let temp = self
            .file
            .with_extension(format!("{}.pending", verified(coordination::random_hex())?));
        verified(installer::write_new(&temp, self.next.as_bytes()))?;
        io(fs::rename(temp, &self.file))?;
        io(io(File::open(self.file.parent().ok_or(Failure::Unverified)?))?.sync_all())?;
        save_selected(&self.location, &self.current)?;
        systemctl(&["daemon-reload".as_ref()]).map(|_| ())
    }
    fn start(&mut self) -> Result<(), Failure> {
        capsule(&self.current, &self.current, self.trust)?;
        if coordination::owner_live(&self.location.home) {
            return Err(Failure::Unverified);
        }
        systemctl(&["start".as_ref(), UNIT.as_ref()]).map(|_| ())
    }
    fn verify_started(&mut self) -> Result<(), Failure> {
        let record = native::wait_registered(&self.location, &self.current)?;
        if record["boot"] == self.owner["boot"] {
            return Err(Failure::Unverified);
        }
        self.owner = record;
        self.live()
    }
}

pub fn register(
    location: Location,
    current: &Path,
    trust: &Trust,
    cancel: &AtomicBool,
) -> Result<(), Failure> {
    manager()?;
    let home = PathBuf::from(std::env::var_os("HOME").ok_or(Failure::Unverified)?);
    let file = unit_path(&home)?;
    let _lock = native::lock(&location)?;
    native::no_incomplete_handoff(&location)?;
    if coordination::owner_live(&location.home) {
        return Err(Failure::Busy);
    }
    let props = properties()?;
    if props.get("MainPID").is_some_and(|p| p != "0")
        || props.get("DropInPaths").is_some_and(|p| !p.is_empty())
    {
        return Err(Failure::Unsupported);
    }
    if props
        .get("FragmentPath")
        .is_some_and(|p| !p.is_empty() && p != file.to_str().unwrap_or(""))
    {
        return Err(Failure::Unsupported);
    }
    // Restart the selected version, not whatever runtime the latest GUI bundled.
    let root = if file.try_exists().map_err(|_| Failure::Unverified)? {
        native::private_regular(&file)?;
        let saved = verified(coordination::private_json(
            &location.home.join(".daemon-service.json"),
            4096,
        ))?;
        if saved["profile"].as_str() != location.home.to_str() || saved["port"] != location.port {
            return Err(Failure::Unsupported);
        }
        PathBuf::from(saved["capsule"].as_str().ok_or(Failure::Unverified)?)
    } else {
        native::fresh_profile(&location)?;
        current.to_owned()
    };
    capsule(current, &root, trust)?;
    let expected = definition(&root, &home, &location)?;
    if cancel.load(Ordering::Acquire) {
        return Err(Failure::Cancelled);
    }
    io(fs::create_dir_all(
        file.parent().ok_or(Failure::Unverified)?,
    ))?;
    verified(installer::validate_parents(
        file.parent().ok_or(Failure::Unverified)?,
    ))?;
    if file.try_exists().map_err(|_| Failure::Unverified)? {
        if io(fs::read_to_string(&file))? != expected {
            return Err(Failure::Unsupported);
        }
    } else {
        verified(installer::write_new(&file, expected.as_bytes()))?;
    }
    save_selected(&location, &root)?;
    native::registration_intent(&location, &root)?;
    for args in [
        vec!["daemon-reload"],
        vec!["enable", UNIT],
        vec!["start", UNIT],
    ] {
        systemctl(&args.iter().map(|a| a.as_ref()).collect::<Vec<_>>())
            .map_err(|_| Failure::Unknown)?;
    }
    let owner = native::wait_registered(&location, &root).map_err(|_| Failure::Unknown)?;
    let daemon =
        fs::read_to_string(location.home.join("daemon-id")).map_err(|_| Failure::Unknown)?;
    let lineage =
        fs::read_to_string(location.home.join("storage-lineage")).map_err(|_| Failure::Unknown)?;
    let host = UserService {
        file,
        home,
        location: location.clone(),
        current: root.clone(),
        trust,
        daemon: daemon.trim(),
        lineage: lineage.trim(),
        cancel,
        owner,
        old: expected,
        next: String::new(),
        watch: None,
        lock: None,
        reservation: None,
    };
    host.live().map_err(|_| Failure::Unknown)?;
    native::registration_complete(&location).map_err(|_| Failure::Unknown)
}
fn save_selected(location: &Location, root: &Path) -> Result<(), Failure> {
    let temp = location.home.join(format!(
        ".daemon-service-{}.pending",
        verified(coordination::random_hex())?
    ));
    verified(installer::write_new(
        &temp,
        &serde_json::to_vec(
            &json!({"schema":1,"profile":location.home,"port":location.port,"capsule":root}),
        )
        .map_err(|_| Failure::Unverified)?,
    ))?;
    io(fs::rename(temp, location.home.join(".daemon-service.json")))?;
    io(io(File::open(&location.home))?.sync_all())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "isolated environment without a systemd user manager; no service operations"]
    fn absent_user_manager_refuses_before_profile_or_service_changes() {
        assert_eq!(manager(), Err(Failure::Unsupported));
        let temp = crate::owned_tests::Temp::new();
        let profile = temp.path().join("unused-profile");
        let location = Location {
            home: profile.clone(),
            port: 4319,
            policy: Default::default(),
        };
        let trust = Trust {
            application_id: "synthetic".into(),
            channel: "fixture".into(),
            repository: "synthetic/fixture".into(),
            public_key: [0; 32],
            code_requirement: String::new(),
            current_build: "1.1".into(),
            bundle_name: "payload".into(),
        };
        assert_eq!(
            register(location, temp.path(), &trust, &AtomicBool::new(false)),
            Err(Failure::Unsupported)
        );
        assert!(
            !profile.exists(),
            "no fallback daemon, profile or service definition"
        );
    }
}
