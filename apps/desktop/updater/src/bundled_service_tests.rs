use super::*;
use crate::{
    Error,
    owned_tests::{Temp, trust},
};
use std::os::unix::fs::{PermissionsExt, symlink};

struct Seal;
impl Platform for Seal {
    fn verify(&self, path: &Path, _: &Trust, build: &str, _: Option<&str>) -> Result<(), Error> {
        if fs::read(path.join("seal")).ok().as_deref() == Some(build.as_bytes()) {
            Ok(())
        } else {
            Err(Error::Signature)
        }
    }
    fn swap(&self, _: &File, _: &Path, _: &Path) -> Result<(), Error> {
        unreachable!()
    }
    fn relaunch(&self, _: &Path, _: &Path) -> Result<(), Error> {
        unreachable!()
    }
}
fn fixture() -> (Temp, PathBuf, Runtime) {
    let temp = Temp::new();
    fs::set_permissions(temp.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let app = temp.path().join("Pilot Next.app");
    let runtime = app.join(crate::layout::RUNTIME);
    for path in [
        runtime.join("node/bin"),
        runtime.join("packages/daemon/src"),
        app.join("Contents/MacOS"),
        app.join("Contents/Resources/nsh"),
    ] {
        fs::create_dir_all(path).unwrap();
    }
    for (path, bytes) in [
        (app.join(crate::layout::GUI), b"gui".as_slice()),
        (app.join("Contents/Resources/nsh/bundle.nshc"), b"tsx"),
        (runtime.join("node/bin/node"), b"node"),
        (runtime.join("packages/daemon/src/main.ts"), b"daemon"),
        (app.join("seal"), b"100.1"),
    ] {
        fs::write(path, bytes).unwrap();
    }
    fs::set_permissions(
        runtime.join("node/bin/node"),
        fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    fs::write(runtime.join("runtime-build.json"), serde_json::to_vec(&json!({"schema":1,"protocol":1,
        "platform":"darwin","arch":"arm64","source":"a".repeat(40),"version":"1.2.3","node":"v24.0.0"})).unwrap()).unwrap();
    let selected =
        Runtime::verify_with(&app, &app, &trust(), &"a".repeat(40), "100.1", &Seal).unwrap();
    (temp, app, selected)
}

#[test]
#[ignore = "explicit signed legacy rename fixture; private Node child, no launchd service"]
fn native_legacy_app_rename_verifies_only_the_existing_service() {
    let node = PathBuf::from(
        std::env::var_os("PILOT_DAEMON_UPGRADE_FIXTURE_NODE").expect("explicit Node 24+ fixture"),
    );
    let temp = Temp::new();
    fs::set_permissions(temp.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let app = super::super::native_tests::bundle(
        temp.path(),
        "Pilot Next.app",
        "com.example.synthetic.next",
        "197",
        &node,
        false,
    );
    let mut trust = trust();
    trust.application_id = "com.example.synthetic.next".into();
    trust.code_requirement = "identifier \"com.example.synthetic.next\"".into();
    trust.current_build = "201".into();
    trust.bundle_name = "Pilot.app".into();
    let current = super::super::native_tests::bundle(
        temp.path(),
        "Pilot.app",
        &trust.application_id,
        "201",
        &node,
        true,
    );
    let profile = temp.path().join("profile");
    fs::create_dir(&profile).unwrap();
    fs::set_permissions(&profile, fs::Permissions::from_mode(0o700)).unwrap();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let location = Location {
        home: profile,
        port: listener.local_addr().unwrap().port(),
        policy: Default::default(),
    };
    drop(listener);
    struct Child(std::process::Child);
    impl Drop for Child {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let runtime = app.join(crate::layout::RUNTIME);
    let _child = Child(
        std::process::Command::new(runtime.join("node/bin/node"))
            .arg(runtime.join("packages/daemon/src/main.ts"))
            .env("PILOT_HOME", &location.home)
            .env("PILOT_PORT", location.port.to_string())
            .stdin(std::process::Stdio::null())
            .spawn()
            .unwrap(),
    );
    let owner = super::super::super::native::wait_registered(&location, &app).unwrap();
    let cancel = AtomicBool::new(false);
    let mut host = launch_agent(
        location,
        &current,
        &trust,
        "fixture-daemon",
        "fixture-lineage",
        &cancel,
    )
    .unwrap();
    host.owner = owner.clone();
    host.original = json!({"ProgramArguments":[runtime.join("node/bin/node"), runtime.join("packages/daemon/src/main.ts")]});
    assert_eq!(
        host.verify_target(),
        Ok(()),
        "new Pilot.app remains verified"
    );
    for managed in [false, true] {
        host.original["PilotNextManaged"] = json!(managed);
        assert_eq!(
            host.verify_running_payload(),
            Ok(()),
            "legacy managed={managed}"
        );
        assert_eq!(
            verify_original(&host),
            Ok(()),
            "legacy original managed={managed}"
        );
    }
    assert!(
        installer::validate_target(&app, &trust).is_err(),
        "new targets still require Pilot.app"
    );
    assert!(Runtime::verify(&app, &app, &trust, &"a".repeat(40), "197").is_err());
    host.current = app.clone();
    assert!(
        host.verify_target().is_err(),
        "historical name never authorizes a new target"
    );
    let mut wrong_identity = trust.clone();
    wrong_identity.application_id = "com.example.other".into();
    assert!(verify_original_bundle(&app, &wrong_identity).is_err());
    let mut wrong_requirement = trust.clone();
    wrong_requirement.code_requirement = "identifier \"com.example.other\"".into();
    assert!(verify_original_bundle(&app, &wrong_requirement).is_err());
    fs::set_permissions(&app, fs::Permissions::from_mode(0o777)).unwrap();
    assert!(
        verify_original_bundle(&app, &trust).is_err(),
        "unsafe original permissions"
    );
    fs::set_permissions(&app, fs::Permissions::from_mode(0o755)).unwrap();
    let renamed = temp.path().join("Other.app");
    fs::rename(&app, &renamed).unwrap();
    assert!(
        verify_original_bundle(&renamed, &trust).is_err(),
        "no arbitrary old names"
    );
    symlink(&renamed, &app).unwrap();
    assert!(
        verify_original_bundle(&app, &trust).is_err(),
        "no original symlink"
    );
    fs::remove_file(&app).unwrap();
    fs::rename(&renamed, &app).unwrap();
    for field in ["build", "runtimeRoot", "pid"] {
        host.owner[field] = Value::Null;
        assert!(
            host.verify_running_payload().is_err(),
            "substituted {field}"
        );
        if field != "runtimeRoot" {
            assert!(
                verify_original(&host).is_err(),
                "substituted original {field}"
            );
        }
        host.owner = owner.clone();
    }
    let stamp_path = runtime.join("runtime-build.json");
    let stamp = fs::read(&stamp_path).unwrap();
    let mut changed: Value = serde_json::from_slice(&stamp).unwrap();
    changed["source"] = json!("b".repeat(40));
    fs::write(&stamp_path, serde_json::to_vec(&changed).unwrap()).unwrap();
    command(
        "/usr/bin/codesign",
        &[
            "--force".as_ref(),
            "--sign".as_ref(),
            "-".as_ref(),
            app.as_os_str(),
        ],
    )
    .unwrap();
    assert_eq!(
        verify_original_bundle(&app, &trust),
        Ok(()),
        "changed source is genuinely signed"
    );
    assert!(
        host.verify_running_payload().is_err(),
        "signed source must still match the live boot"
    );
    assert!(
        verify_original(&host).is_err(),
        "original source must match the live boot"
    );
    fs::write(&stamp_path, stamp).unwrap();
    command(
        "/usr/bin/codesign",
        &[
            "--force".as_ref(),
            "--sign".as_ref(),
            "-".as_ref(),
            app.as_os_str(),
        ],
    )
    .unwrap();
    assert_eq!(host.verify_running_payload(), Ok(()));
    assert_eq!(verify_original(&host), Ok(()));
    fs::write(runtime.join("packages/daemon/src/main.ts"), b"tampered").unwrap();
    assert!(
        host.verify_running_payload().is_err(),
        "legacy name does not bypass signature"
    );
    assert!(
        verify_original(&host).is_err(),
        "original signature stays required"
    );
}

#[test]
fn preflight_captures_the_private_definition_inode_before_revalidation() {
    let (temp, app, runtime) = fixture();
    let cancel = AtomicBool::new(false);
    let mut host = launch_agent(
        Location {
            home: temp.path().into(),
            port: 1234,
            policy: Default::default(),
        },
        &app,
        &runtime.trust,
        "daemon",
        "lineage",
        &cancel,
    )
    .unwrap();
    host.plist = temp.path().join("service.plist");
    // plutil accepts JSON input. This fixture does not register a service.
    fs::write(&host.plist, br#"{"Label":"fixture"}"#).unwrap();
    fs::set_permissions(&host.plist, fs::Permissions::from_mode(0o600)).unwrap();
    let meta = fs::symlink_metadata(&host.plist).unwrap();
    capture_definition(&mut host).unwrap();
    assert_eq!(host.original, json!({"Label":"fixture"}));
    assert_eq!(host.plist_stamp, Some((meta.dev(), meta.ino())));

    // A replaced inode still fails before any live service lookup.
    fs::rename(&host.plist, host.plist.with_extension("previous")).unwrap();
    fs::write(&host.plist, br#"{"Label":"fixture"}"#).unwrap();
    fs::set_permissions(&host.plist, fs::Permissions::from_mode(0o600)).unwrap();
    assert_eq!(host.revalidate(), Err(Failure::Unverified));
    fs::set_permissions(&host.plist, fs::Permissions::from_mode(0o666)).unwrap();
    assert_eq!(capture_definition(&mut host), Err(Failure::Unverified));
}

#[test]
fn app_relative_inputs_relocate_only_with_exact_verified_bytes() {
    let (temp, app, selected) = fixture();
    assert_eq!(
        selected.replacement()["runtimeRoot"],
        json!(app.join(crate::layout::RUNTIME))
    );
    assert_eq!(selected.recheck_with(&app, &Seal), Ok(()));
    let parent = temp.path().join("relocated");
    fs::create_dir(&parent).unwrap();
    let moved = parent.join("Pilot Next.app");
    fs::rename(&app, &moved).unwrap();
    assert_eq!(selected.recheck_with(&moved, &Seal), Ok(()));
    fs::write(
        moved
            .join(crate::layout::RUNTIME)
            .join("packages/daemon/src/main.ts"),
        b"tampered",
    )
    .unwrap();
    assert_eq!(
        selected.recheck_with(&moved, &Seal),
        Err(Failure::Unverified)
    );
}

#[test]
fn wrong_source_build_signature_paths_and_runtime_stamp_refuse() {
    let (_temp, app, selected) = fixture();
    for (source, build) in [
        ("b".repeat(40), "100.1"),
        ("a".repeat(40), "101.1"),
        ("a".repeat(39), "100.1"),
    ] {
        assert!(Runtime::verify_with(&app, &app, &trust(), &source, build, &Seal).is_err());
    }
    assert!(
        Runtime::verify(&app, &app, &trust(), &"a".repeat(40), "100.1").is_err(),
        "path/faux seal grants no native signing trust"
    );
    let node = app.join(crate::layout::RUNTIME).join("node/bin/node");
    let real = node.with_extension("real");
    fs::rename(&node, &real).unwrap();
    symlink("node.real", &node).unwrap();
    assert!(
        runtime_inputs(&app, &selected.source).is_err(),
        "even internal executable indirection is not selected"
    );
    fs::remove_file(&node).unwrap();
    fs::rename(&real, &node).unwrap();
    fs::write(
        app.join(crate::layout::RUNTIME).join("runtime-build.json"),
        b"{}",
    )
    .unwrap();
    assert!(runtime_inputs(&app, &selected.source).is_err());
}

fn op(target: &Runtime) -> (Value, Value) {
    use sha2::{Digest, Sha256};
    let payload = json!({"captureHash":"b".repeat(64),"app":{"source":target.source,"build":target.trust.current_build},
        "replacement":target.replacement()}).to_string();
    let operation = json!({"schemaVersion":1,"operationId":"original","kind":"global-update-prepare","targetId":"global-update",
        "payloadHash":crate::transport::hex(&Sha256::digest(payload.as_bytes())),"payload":payload,"destination":{"daemonId":"daemon","lineageId":"lineage"}});
    let receipt = json!({"state":"accepted","operationId":operation["operationId"],"payloadHash":operation["payloadHash"],
        "targetId":operation["targetId"],"destination":operation["destination"],"result":{"target":serde_json::from_str::<Value>(&payload).unwrap(),
        "sessions":[{"sessionId":"healthy","phase":"checkpointed","hostExited":true},{"sessionId":"broken","phase":"unknown","hostExited":true,"interrupted":true}]}});
    (operation, receipt)
}
#[test]
fn exact_preparation_accepts_interrupted_peers_not_changed_operation_or_target() {
    let (_temp, _app, runtime) = fixture();
    let (operation, receipt) = op(&runtime);
    assert_eq!(
        preparation(&operation, &receipt, &runtime),
        Ok(()),
        "broken chats are not model-ACK vetoes"
    );
    for (field, value) in [
        ("operationId", json!("other")),
        ("payloadHash", json!("c".repeat(64))),
        ("destination", Value::Null),
    ] {
        let mut changed = receipt.clone();
        changed[field] = value;
        assert_eq!(
            preparation(&operation, &changed, &runtime),
            Err(Failure::Unverified)
        );
    }
    let mut changed = operation.clone();
    changed["payload"] = json!("{}");
    assert_eq!(
        preparation(&changed, &receipt, &runtime),
        Err(Failure::Unverified)
    );
    let mut pending = receipt.clone();
    pending["state"] = json!("pending");
    assert_eq!(
        preparation(&operation, &pending, &runtime),
        Err(Failure::Unverified)
    );
}

#[test]
fn interrupted_state_is_not_a_veto_but_process_safety_is_mandatory() {
    let (_temp, _app, runtime) = fixture();
    let (operation, receipt) = op(&runtime);
    assert_eq!(
        prepared(
            &operation,
            &json!({"receipt":receipt,"blockers":[]}),
            &runtime
        ),
        Ok(())
    );
    for blockers in [
        Value::Null,
        json!([{"kind":"process","id":"owned-descendant"}]),
        json!([{"kind":"unknown","id":"exit-not-proven"}]),
    ] {
        assert!(
            prepared(
                &operation,
                &json!({"receipt":receipt,"blockers":blockers}),
                &runtime
            )
            .is_err()
        );
    }
}

#[test]
fn dogfood_accepts_only_exited_kernel_descendant_uncertainty() {
    let (_temp, _app, runtime) = fixture();
    let (operation, receipt) = op(&runtime);
    let uncertainty =
        json!({"kind":"unknown-process","id":"lifecycle:broken","sessionId":"broken"});
    let fresh = json!({"receipt":receipt,"blockers":[uncertainty]});
    assert_eq!(prepared(&operation, &fresh, &runtime), Ok(()));
    assert_eq!(dogfood_uncertainty(&fresh).unwrap(), vec![uncertainty]);
    for blocker in [
        json!({"kind":"job","id":"owned","sessionId":"broken"}),
        json!({"kind":"unknown-process","id":"broken","sessionId":"broken"}),
        json!({"kind":"unknown-process","id":"lifecycle:other","sessionId":"other"}),
        json!({"kind":"admission","id":"sessions"}),
    ] {
        let mut changed = fresh.clone();
        changed["blockers"] = json!([blocker]);
        assert!(dogfood_uncertainty(&changed).is_err());
    }
    let mut live = fresh;
    live["receipt"]["result"]["sessions"][1]["hostExited"] = json!(false);
    assert_eq!(dogfood_uncertainty(&live), Err(Failure::Busy));
}

#[derive(Default)]
struct Native {
    calls: Vec<String>,
    fail: Option<&'static str>,
}
impl Native {
    fn step(&mut self, name: &str) -> Result<(), Failure> {
        self.calls.push(name.into());
        if self.fail == Some(name) {
            Err(Failure::Unverified)
        } else {
            Ok(())
        }
    }
}
impl Transition for Native {
    fn phase(&mut self, phase: &str) -> Result<(), Failure> {
        self.step(phase)
    }
    fn stop(&mut self) -> Result<(), Failure> {
        self.step("stop")
    }
    fn exit(&mut self) -> Result<(), Failure> {
        self.step("exit")
    }
    fn lease(&mut self) -> Result<(), Failure> {
        self.step("lease")
    }
    fn replace(&mut self) -> Result<(), Failure> {
        self.step("replace")
    }
    fn start(&mut self) -> Result<(), Failure> {
        self.step("start")
    }
    fn verify(&mut self) -> Result<(), Failure> {
        self.step("verify")
    }
}
#[test]
fn native_entry_requires_durable_stop_exact_exit_and_lease_before_one_start() {
    let mut native = Native::default();
    stop_steps(&mut native).unwrap();
    start_steps(&mut native).unwrap();
    assert_eq!(
        native.calls,
        [
            "stopping", "stop", "exit", "lease", "stopped", "lease", "starting", "replace",
            "start", "verify"
        ]
    );
}

#[test]
fn only_fresh_exact_successor_completion_can_enter_a_single_rollback() {
    let (_temp, _app, runtime) = fixture();
    let (operation, _) = op(&runtime);
    let completion = json!({"role":"successor","boot":"new-boot","pid":1234,
        "runtime":runtime.replacement(),"app":runtime.pin(),"originalBuild":runtime.build});
    let retained = json!({"phase":"complete","operation":operation,"completion":completion});
    assert_eq!(
        fresh_handoff(&retained, &operation, &runtime, Some(&completion)),
        Ok(())
    );
    assert_eq!(
        fresh_handoff(&retained, &operation, &runtime, None),
        Err(Failure::Unknown),
        "ordinary entry never reuses completed intent"
    );
    for field in ["phase", "operation", "completion"] {
        let mut changed = retained.clone();
        changed[field] = Value::Null;
        assert_eq!(
            fresh_handoff(&changed, &operation, &runtime, Some(&completion)),
            Err(Failure::Unknown)
        );
    }
    let mut rolled = completion.clone();
    rolled["role"] = "rollback".into();
    assert_eq!(
        fresh_handoff(&retained, &operation, &runtime, Some(&rolled)),
        Err(Failure::Unknown),
        "a rollback completion cannot create another attempt"
    );
}
#[test]
fn lost_interrupted_or_failed_native_steps_are_unknown_and_never_retried() {
    for fail in ["stopping", "stop", "exit", "lease", "stopped"] {
        let mut native = Native {
            fail: Some(fail),
            ..Default::default()
        };
        assert_eq!(stop_steps(&mut native), Err(Failure::Unknown));
        assert!(!native.calls.iter().any(|s| s == "start"));
        assert_eq!(native.calls.last().unwrap(), fail);
    }
    for fail in ["lease", "starting", "replace", "start", "verify"] {
        let mut native = Native {
            fail: Some(fail),
            ..Default::default()
        };
        assert_eq!(start_steps(&mut native), Err(Failure::Unknown));
        assert_eq!(
            native
                .calls
                .iter()
                .filter(|s| s.as_str() == "start")
                .count(),
            usize::from(["start", "verify"].contains(&fail))
        );
        assert_eq!(native.calls.last().unwrap(), fail);
    }
}

#[test]
fn retained_original_lookup_never_reconstructs_an_execution_handle() {
    let (temp, _app, runtime) = fixture();
    let profile = temp.path().join("profile");
    fs::create_dir(&profile).unwrap();
    let connection = Connection::new(
        Location {
            home: profile.clone(),
            port: 1234,
            policy: Default::default(),
        },
        "daemon".into(),
        "lineage".into(),
    );
    let (operation, _) = op(&runtime);
    let value = json!({"schema":2,"purpose":"bundled-service","operation":operation,"profile":profile,"port":1234,
        "daemonId":"daemon","lineageId":"lineage","phase":"starting"});
    super::super::super::native::journal(connection.location(), &value).unwrap();
    assert_eq!(lookup(&connection, &operation), Ok(value));
    let mut changed = operation.clone();
    changed["operationId"] = "other".into();
    assert_eq!(lookup(&connection, &changed), Err(Failure::Unverified));
}

#[test]
fn actual_owned_process_exit_does_not_substitute_for_the_exact_lease_inode() {
    use std::{
        io::{BufRead, BufReader, Write},
        process::{Command, Stdio},
    };
    struct Child(std::process::Child);
    impl Drop for Child {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let temp = Temp::new();
    let location = Location {
        home: temp.path().into(),
        port: 1234,
        policy: Default::default(),
    };
    let path = temp.path().join(".daemon-owner.sqlite");
    let mut child = Child(Command::new("/usr/bin/python3").args(["-c",
        "import os,fcntl,sys; f=os.open(sys.argv[1],os.O_CREAT|os.O_RDWR,0o600); fcntl.lockf(f,fcntl.LOCK_EX); print('ready',flush=True); sys.stdin.read(1)"])
        .arg(&path).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().unwrap());
    let mut ready = String::new();
    BufReader::new(child.0.stdout.take().unwrap())
        .read_line(&mut ready)
        .unwrap();
    assert_eq!(ready, "ready\n");
    let pid = child.0.id() as i32;
    let lease = Lease::open(&location, pid).unwrap();
    let watch = helper::ParentWatch::new(pid).unwrap();
    assert_eq!(lease.released(&location), Err(Failure::Busy));
    child.0.stdin.take().unwrap().write_all(b"x").unwrap();
    watch.wait(Duration::from_secs(5)).unwrap();
    assert!(child.0.wait().unwrap().success());
    assert_eq!(lease.released(&location), Ok(()));
    fs::rename(&path, path.with_extension("previous")).unwrap();
    fs::write(&path, b"different inode").unwrap();
    assert_eq!(
        lease.released(&location),
        Err(Failure::Unverified),
        "a new unlocked file is not release evidence"
    );
    fs::remove_file(&path).unwrap();
    assert_eq!(
        lease.released(&location),
        Err(Failure::Unverified),
        "missing lease is not release evidence"
    );
}
