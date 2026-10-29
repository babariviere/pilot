//! Opt-in genuine launchd fixture. Its random label and private tree never name
//! the installed service, app or user data. No test-only bypass is in production.
use super::*;
use std::{net::TcpListener, os::unix::fs::PermissionsExt};

const OWNER: &str = include_str!("../../../../packages/daemon/src/runtime-owner.ts");
const MAIN: &str = r#"
import { ownRuntime } from './runtime-owner.ts';
import { UpdateReservation } from './update-reservation.ts';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../../../',import.meta.url)).replace(/\/$/,'');
const stamp=root+'/runtime-build.json';
const build=existsSync(stamp)?JSON.parse(readFileSync(stamp,'utf8')):null;
const owner=await ownRuntime(process.env.PILOT_HOME,Number(process.env.PILOT_PORT),false,build,build?root:undefined);
writeFileSync(process.env.PILOT_HOME+'/daemon-id','fixture-daemon',{mode:0o600});
writeFileSync(process.env.PILOT_HOME+'/storage-lineage','fixture-lineage',{mode:0o600});
const resources={freezeAdmissions:()=>()=>{},blockers:async()=>existsSync(process.env.PILOT_HOME+'/blocker')?[{kind:readFileSync(process.env.PILOT_HOME+'/blocker','utf8'),id:'fixture'}]:[]};
const reservation=new UpdateReservation(resources,undefined,180000,resources);
owner.updates(async(action,value)=>{
 if(action==='prepare'){
   const exact=await reservation.prepare(value.operationId,value.purpose);
   if(existsSync(process.env.PILOT_HOME+'/lost-prepare')){
     writeFileSync(process.env.PILOT_HOME+'/fixture-receipt',JSON.stringify(exact),{mode:0o600});
     await new Promise(()=>{});
   }
   return exact;
 }
 if(action==='verify')return reservation.verify(value);
 if(action==='cancel'){reservation.cancel(value);return null}
 return null;
});
owner.install((req,res)=>{
  if(req.url==='/api/update/pause' && req.method==='POST') {
    res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({ready:true,processId:process.pid}));
  } else res.writeHead(404).end();
});
owner.ready({daemonId:'fixture-daemon',lineageId:'fixture-lineage',daemonVersion:'0.0.1',protocolVersion:1,minimumClientProtocolVersion:1,platform:process.platform,arch:process.arch,capabilities:{independentExecution:true}});
process.on('SIGTERM',async()=>{await owner.close();process.exit(0)});
"#;

fn bundle(root: &Path, name: &str, id: &str, build: &str, node: &Path, _new: bool) -> PathBuf {
    let app = root.join(name);
    let runtime = app.join(crate::layout::RUNTIME);
    fs::create_dir_all(runtime.join("node/bin")).unwrap();
    fs::create_dir_all(runtime.join("packages/daemon/src")).unwrap();
    fs::create_dir_all(app.join("Contents/MacOS")).unwrap();
    fs::copy("/usr/bin/true", app.join("Contents/MacOS/fixture")).unwrap();
    fs::copy(node, runtime.join("node/bin/node")).unwrap();
    fs::set_permissions(
        runtime.join("node/bin/node"),
        fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    fs::write(
        runtime.join("package.json"),
        b"{\"type\":\"module\",\"version\":\"0.0.1\"}",
    )
    .unwrap();
    fs::write(
        app.join(crate::layout::POLICY),
        b"{\"schema\":1,\"accepted_capsules\":[]}",
    )
    .unwrap();
    fs::write(runtime.join("packages/daemon/src/main.ts"), MAIN).unwrap();
    fs::write(runtime.join("packages/daemon/src/runtime-owner.ts"), OWNER).unwrap();
    fs::write(
        runtime.join("packages/daemon/src/update-reservation.ts"),
        include_str!("../../../../packages/daemon/src/update-reservation.ts"),
    )
    .unwrap();
    // Exercise the production Swift stamp producer, not a fixture-only tuple.
    let stamp = runtime.join("fixture-runtime-build.mjs");
    fs::write(
        &stamp,
        include_str!("../../../macos/scripts/runtime-build.mjs"),
    )
    .unwrap();
    command(
        node.to_str().unwrap(),
        &[
            stamp.as_os_str(),
            runtime.as_os_str(),
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".as_ref(),
        ],
    )
    .unwrap();
    fs::write(app.join("Contents/Info.plist"),format!(r#"<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>{id}</string><key>CFBundleExecutable</key><string>fixture</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>{build}</string><key>CFBundleShortVersionString</key><string>0.0.1</string></dict></plist>"#)).unwrap();
    command(
        "/usr/bin/codesign",
        &[
            "--force".as_ref(),
            "--sign".as_ref(),
            "-".as_ref(),
            runtime.join("node/bin/node").as_os_str(),
        ],
    )
    .unwrap();
    command(
        "/usr/bin/codesign",
        &[
            "--force".as_ref(),
            "--sign".as_ref(),
            "-".as_ref(),
            "--identifier".as_ref(),
            id.as_ref(),
            app.as_os_str(),
        ],
    )
    .unwrap();
    app
}
struct Service(String);
impl Drop for Service {
    fn drop(&mut self) {
        let _ = command("/bin/launchctl", &["bootout".as_ref(), self.0.as_ref()]);
    }
}

#[test]
#[ignore = "explicit private synthetic launchd registration; no login/global service"]
fn native_launchd_registration_offline_seed_and_singleton() {
    let node = PathBuf::from(
        std::env::var_os("PILOT_DAEMON_UPGRADE_FIXTURE_NODE").expect("explicit fixture Node"),
    );
    let temp = crate::owned_tests::Temp::new();
    let home = temp.path().join("home");
    fs::create_dir(&home).unwrap();
    let home = home.canonicalize().unwrap();
    let profile = home.join("profile");
    let seed = bundle(
        temp.path(),
        "Pilot Next.app",
        "com.example.synthetic.next",
        "101.1",
        &node,
        true,
    );
    let trust = Trust {
        application_id: "com.example.synthetic.next".into(),
        channel: "desktop-stable".into(),
        repository: "synthetic/fixture-only".into(),
        public_key: [42; 32],
        code_requirement: "identifier \"com.example.synthetic.next\"".into(),
        current_build: "101.1".into(),
        bundle_name: "Pilot Next.app".into(),
    };
    let store = temp.path().join(runtime::STORE_NAME);
    let current = runtime::publish(&seed, &store, &trust, &installer::MacPlatform).unwrap();
    fs::remove_dir_all(seed).unwrap();
    let label = format!(
        "com.example.pilot-next-registration-{}",
        coordination::random_hex().unwrap()
    );
    let service = format!("gui/{}/{label}", unsafe { libc::geteuid() });
    let _cleanup = Service(service.clone());
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let location = Location {
        home: profile.clone(),
        port,
        policy: Default::default(),
    };
    let cancel = AtomicBool::new(false);
    register_at(
        &home,
        &label,
        location.clone(),
        &current,
        &trust,
        &cancel,
        false,
    )
    .unwrap();
    let owner = super::super::native::running(&location, &current).unwrap();
    assert_eq!(
        register_at(
            &home,
            &label,
            location.clone(),
            &current,
            &trust,
            &cancel,
            false
        ),
        Err(Failure::Busy),
        "never start a second daemon"
    );
    assert_eq!(
        coordination::record(&location).unwrap()["boot"],
        owner["boot"]
    );
    let journal: Value = serde_json::from_slice(&fs::read(profile.join(JOURNAL)).unwrap()).unwrap();
    assert_eq!(journal["phase"], "complete");
    let file = home
        .join("Library/LaunchAgents")
        .join(format!("{label}.plist"));
    let definition = plist(&file).unwrap();
    assert_eq!(definition["PilotNextManaged"], true);
    assert_eq!(definition["ProgramArguments"].as_array().unwrap().len(), 2);
    assert!(file.with_extension("plist.next-owner").exists());
    command("/bin/launchctl", &["bootout".as_ref(), service.as_ref()]).unwrap();
    let end = Instant::now() + Duration::from_secs(10);
    while coordination::owner_live(&profile) {
        assert!(Instant::now() < end);
        std::thread::sleep(Duration::from_millis(100));
    }
    // A normal explicit start reuses the selected immutable version after GUI removal.
    register_at(&home, &label, location, &current, &trust, &cancel, false).unwrap();
}

#[test]
#[ignore = "explicit synthetic launchd GUI-domain fixture; no real service/profile"]
fn native_launchd_handoff_preserves_external_profile_and_service() {
    let node = PathBuf::from(
        std::env::var_os("PILOT_DAEMON_UPGRADE_FIXTURE_NODE")
            .expect("explicit Node24+ fixture executable"),
    );
    assert!(node.is_absolute());
    let temp = crate::owned_tests::Temp::new();
    fs::set_permissions(temp.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let home = temp.path().join("home");
    fs::create_dir_all(home.join("Library/LaunchAgents")).unwrap();
    fs::create_dir_all(home.join("Library/Logs/Pilot")).unwrap();
    let profile = home.join("profile");
    fs::create_dir(&profile).unwrap();
    fs::set_permissions(&profile, fs::Permissions::from_mode(0o700)).unwrap();
    let old = bundle(
        temp.path(),
        "Pilot.app",
        "com.babariviere.pilot",
        "100.1",
        &node,
        false,
    );
    let new = bundle(
        temp.path(),
        "Pilot Next.app",
        "com.example.synthetic.next",
        "101.1",
        &node,
        true,
    );
    let trust = Trust {
        application_id: "com.example.synthetic.next".into(),
        channel: "desktop-stable".into(),
        repository: "synthetic/fixture-only".into(),
        public_key: [42; 32],
        code_requirement: "identifier \"com.example.synthetic.next\"".into(),
        current_build: "101.1".into(),
        bundle_name: "Pilot Next.app".into(),
    };
    let current = runtime::publish(
        &new,
        &temp.path().join(runtime::STORE_NAME),
        &trust,
        &installer::MacPlatform,
    )
    .unwrap();
    let label = format!(
        "dev.pilot.synthetic.daemon-upgrade.{}",
        coordination::random_hex().unwrap()
    );
    assert_ne!(label, LABEL);
    let service = format!("gui/{}/{label}", unsafe { libc::geteuid() });
    let _cleanup = Service(service.clone());
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let plist_path = home
        .join("Library/LaunchAgents")
        .join(format!("{label}.plist"));
    let runtime = old.join(crate::layout::RUNTIME);
    let log = home.join("Library/Logs/Pilot/pilotd.log");
    let definition = json!({"Label":label,"ProgramArguments":[runtime.join("node/bin/node"),runtime.join("packages/daemon/src/main.ts")],"WorkingDirectory":home,"EnvironmentVariables":{"PATH":"/usr/bin:/bin","PILOT_PORT":port.to_string(),"PILOT_HOME":profile},"RunAtLoad":true,"KeepAlive":true,"ThrottleInterval":10,"ProcessType":"Interactive","StandardOutPath":log,"StandardErrorPath":log});
    installer::write_new(&plist_path, &serde_json::to_vec(&definition).unwrap()).unwrap();
    command(
        "/usr/bin/plutil",
        &["-convert".as_ref(), "xml1".as_ref(), plist_path.as_os_str()],
    )
    .unwrap();
    let domain = format!("gui/{}", unsafe { libc::geteuid() });
    command(
        "/bin/launchctl",
        &[
            "bootstrap".as_ref(),
            domain.as_ref(),
            plist_path.as_os_str(),
        ],
    )
    .expect("synthetic GUI-domain launch agent must bootstrap");
    let location = Location {
        home: profile.clone(),
        port,
        policy: Default::default(),
    };
    let end = Instant::now() + Duration::from_secs(15);
    loop {
        if let Ok(record) = coordination::record(&location)
            && prove(&location, &record, "fixture-daemon", "fixture-lineage").is_ok()
        {
            break;
        }
        assert!(
            Instant::now() < end,
            "fixture daemon must initialize: {}",
            fs::read_to_string(&log).unwrap_or_default()
        );
        std::thread::sleep(Duration::from_millis(100));
    }
    fs::write(profile.join("daemon-id"), "fixture-daemon").unwrap();
    fs::write(profile.join("storage-lineage"), "fixture-lineage").unwrap();
    fs::write(profile.join("preserved-draft"), "still here 🐦").unwrap();
    let cancel = AtomicBool::new(false);
    let mut host = LaunchAgent {
        location: location.clone(),
        current: current.clone(),
        trust: &trust,
        daemon: "fixture-daemon",
        lineage: "fixture-lineage",
        cancel: &cancel,
        service,
        label,
        home,
        plist: plist_path,
        original: Value::Null,
        replacement: Value::Null,
        owner: Value::Null,
        watch: None,
        lock: None,
        plist_stamp: None,
        reservation: None,
    };
    // Full daemon reservation refuses independent work, not merely tool pause.
    for kind in [
        "job", "terminal", "child", "transfer", "mutation", "unknown",
    ] {
        fs::write(profile.join("blocker"), kind).unwrap();
        assert_eq!(execute(&mut host, &cancel), Err(Failure::Busy), "{kind}");
        assert!(!profile.join(JOURNAL).exists(), "no stop intent on busy");
        host.lock.take();
    }
    fs::remove_file(profile.join("blocker")).unwrap();
    host.prepare().unwrap();
    assert!(host.drained().unwrap());
    host.reserve().unwrap();
    let exact = host.reservation.as_ref().unwrap().receipt.clone();
    host.cancel_reservation();
    assert!(
        coordination::signed_update(&host.location, &host.owner, &exact, "verify").is_err(),
        "exact cancellation releases hold"
    );
    host.lock.take();
    fs::write(profile.join("lost-prepare"), "1").unwrap();
    assert_eq!(execute(&mut host, &cancel), Err(Failure::Unverified));
    assert!(
        !profile.join(JOURNAL).exists(),
        "lost prepare ACK forbids stop"
    );
    assert_eq!(
        coordination::record(&location).unwrap()["boot"],
        host.owner["boot"]
    );
    host.lock.take();
    let lost: Value =
        serde_json::from_slice(&fs::read(profile.join("fixture-receipt")).unwrap()).unwrap();
    coordination::signed_update(&location, &host.owner, &lost, "cancel").unwrap();
    fs::remove_file(profile.join("lost-prepare")).unwrap();
    // Replacing/removing the bundled seed cannot affect retained execution.
    fs::remove_dir_all(&new).unwrap();
    execute(&mut host, &cancel).expect("verified synthetic launchd handoff");
    host.lock.take();
    host.prepare()
        .expect("prior Next service remains verifiable, not mistaken for Swift");
    host.lock.take();
    fs::remove_dir_all(&old).unwrap();
    let initial = coordination::record(&location).unwrap();
    command(
        "/bin/launchctl",
        &["kill".as_ref(), "SIGKILL".as_ref(), host.service.as_ref()],
    )
    .unwrap();
    let end = Instant::now() + Duration::from_secs(25);
    loop {
        if let Ok(record) = coordination::record(&location)
            && record["boot"] != initial["boot"]
            && prove(&location, &record, "fixture-daemon", "fixture-lineage").is_ok()
        {
            break;
        }
        assert!(
            Instant::now() < end,
            "launchd restarts selected retained runtime after crash without GUI/seed"
        );
        std::thread::sleep(Duration::from_millis(100));
    }
    assert!(host.plist.with_extension("plist.next-owner").exists());
    assert_eq!(
        fs::read_to_string(profile.join("preserved-draft")).unwrap(),
        "still here 🐦"
    );
    let journal: Value = serde_json::from_slice(&fs::read(profile.join(JOURNAL)).unwrap()).unwrap();
    assert_eq!(journal["phase"], "complete");
    assert_eq!(
        journal["nextDefinition"]["Label"],
        journal["previousDefinition"]["Label"]
    );
    assert_eq!(
        journal["nextDefinition"]["ProgramArguments"]
            .as_array()
            .unwrap()
            .len(),
        2,
        "never enroll via --bundled-runtime"
    );
    drop(host);
    drop(_cleanup);
    let result=command(node.to_str().unwrap(),&["--input-type=module".as_ref(),"-e".as_ref(),"import {DatabaseSync} from 'node:sqlite';console.log(new DatabaseSync(process.argv[1],{readOnly:true}).prepare('SELECT managed FROM runtime_owner').get().managed)".as_ref(),profile.join(".daemon-owner.sqlite").as_os_str()]).unwrap();
    assert_eq!(
        std::str::from_utf8(&result).unwrap().trim(),
        "0",
        "external managed flag preserved"
    );
}
