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
  if(req.url==='/fixture-runtime-build') {
    res.writeHead(200,{'Content-Type':'application/json'}).end(readFileSync(stamp));
  } else if(req.url==='/api/update/pause' && req.method==='POST') {
    const pending=existsSync(process.env.PILOT_HOME+'/tool-pending');
    if(pending){const count=process.env.PILOT_HOME+'/pause-count';writeFileSync(count,String(existsSync(count)?Number(readFileSync(count,'utf8'))+1:1),{mode:0o600});}
    res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({ready:!pending,processId:process.pid}));
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

struct FixtureDaemon(std::process::Child);
impl Drop for FixtureDaemon {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
#[ignore = "explicit Node 24 signed capsule fixture; private child/profile, no launchd service"]
fn native_read_only_connect_and_ui_guard_ignore_old_runtime_files() {
    let node = PathBuf::from(
        std::env::var_os("PILOT_DAEMON_UPGRADE_FIXTURE_NODE").expect("explicit fixture Node 24"),
    );
    let temp = crate::owned_tests::Temp::new();
    fs::set_permissions(temp.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let seed_parent = temp.path().join("seed");
    let installed_parent = temp.path().join("installed");
    fs::create_dir(&seed_parent).unwrap();
    fs::create_dir(&installed_parent).unwrap();
    let seed = bundle(
        &seed_parent,
        "Pilot Next.app",
        "com.example.synthetic.next",
        "100.1",
        &node,
        true,
    );
    let mut trust = Trust {
        application_id: "com.example.synthetic.next".into(),
        channel: "desktop-stable".into(),
        repository: "synthetic/fixture-only".into(),
        public_key: [42; 32],
        code_requirement: "identifier \"com.example.synthetic.next\"".into(),
        current_build: "100.1".into(),
        bundle_name: "Pilot Next.app".into(),
    };
    let store = temp.path().join(runtime::STORE_NAME);
    let retained = runtime::publish(&seed, &store, &trust, &installer::MacPlatform).unwrap();
    for value in 1..=3 {
        fs::write(
            seed.join("Contents/Resources/fixture-generation"),
            value.to_string(),
        )
        .unwrap();
        command(
            "/usr/bin/codesign",
            &[
                "--force".as_ref(),
                "--sign".as_ref(),
                "-".as_ref(),
                seed.as_os_str(),
            ],
        )
        .unwrap();
        runtime::publish(&seed, &store, &trust, &installer::MacPlatform).unwrap();
    }
    trust.current_build = "101.1".into();
    let installed = bundle(
        &installed_parent,
        "Pilot Next.app",
        &trust.application_id,
        "101.1",
        &node,
        true,
    );
    let profile = temp.path().join("profile");
    fs::create_dir(&profile).unwrap();
    fs::set_permissions(&profile, fs::Permissions::from_mode(0o700)).unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let location = Location {
        home: profile,
        port: listener.local_addr().unwrap().port(),
        policy: Default::default(),
    };
    drop(listener);
    let snapshot = || {
        use std::os::unix::fs::MetadataExt;
        let mut roots = fs::read_dir(&store)
            .unwrap()
            .map(|entry| {
                let entry = entry.unwrap();
                (
                    entry.file_name(),
                    fs::symlink_metadata(entry.path()).unwrap().ino(),
                )
            })
            .collect::<Vec<_>>();
        roots.sort();
        roots
    };
    let before = snapshot();
    assert_eq!(
        super::super::connect(&location, &installed, &trust),
        Err(Failure::Unverified),
        "missing owner never starts a daemon"
    );
    assert!(!location.home.join(".daemon-owner.json").exists());
    let runtime_root = retained.join(crate::layout::RUNTIME);
    let mut daemon = FixtureDaemon(
        std::process::Command::new(runtime_root.join("node/bin/node"))
            .arg(runtime_root.join("packages/daemon/src/main.ts"))
            .env("PILOT_HOME", &location.home)
            .env("PILOT_PORT", location.port.to_string())
            .stdin(std::process::Stdio::null())
            .spawn()
            .unwrap(),
    );
    let owner = super::super::native::wait_registered(&location, &retained).unwrap();
    assert_eq!(
        super::super::connect(&location, &installed, &trust),
        Ok(()),
        "GUI connection does not need an old-capsule allowlist"
    );
    let id = retained
        .parent()
        .unwrap()
        .file_name()
        .unwrap()
        .to_str()
        .unwrap();
    fs::write(
        installed.join(crate::layout::POLICY),
        serde_json::to_vec(&serde_json::json!({"schema":1,"accepted_capsules":[id]})).unwrap(),
    )
    .unwrap();
    command(
        "/usr/bin/codesign",
        &[
            "--force".as_ref(),
            "--sign".as_ref(),
            "-".as_ref(),
            installed.as_os_str(),
        ],
    )
    .unwrap();
    assert_eq!(
        runtime::publish(&installed, &store, &trust, &installer::MacPlatform),
        Err(crate::Error::StagingCapacity)
    );
    assert_eq!(
        coordination::selected(&location, &installed, &trust),
        Ok(retained.clone())
    );
    let started = Instant::now();
    for _ in 0..3 {
        assert_eq!(super::super::connect(&location, &installed, &trust), Ok(()));
    }
    println!(
        "three read-only installed-root connections: {:?}",
        started.elapsed()
    );
    assert_eq!(
        coordination::record(&location).unwrap()["boot"],
        owner["boot"],
        "connection preserves the existing daemon"
    );
    assert_eq!(snapshot(), before, "no publication, deletion or rename");
    assert!(!store.join(runtime::identity(&installed).unwrap()).exists());
    // GUI receipts survive the actual source of the old process disappearing.
    // The new GUI and exact transaction/configuration are still verified independently.
    let transaction = temp
        .path()
        .join(format!(".pilot-next-update-{}", "a".repeat(32)));
    fs::create_dir(&transaction).unwrap();
    fs::set_permissions(&transaction, fs::Permissions::from_mode(0o700)).unwrap();
    installer::write_new(
        &transaction.join("journal.json"),
        br#"{"schema":1,"phase":"Ready","original_device":0,"original_inode":0}"#,
    )
    .unwrap();
    let guard = coordination::Guard::prepare_ui(
        location.clone(),
        &installed,
        &installed,
        &transaction,
        "101.1",
        &trust,
    )
    .unwrap();
    guard.save().unwrap();
    fs::remove_dir_all(&retained).unwrap();
    assert!(!retained.exists());
    assert_eq!(guard.verify(), Ok(()));
    assert_eq!(super::super::connect(&location, &installed, &trust), Ok(()));
    coordination::Guard::load(&transaction, &installed, "101.1", &trust).unwrap();
    assert!(coordination::Guard::load(&transaction, &installed, "102.1", &trust).is_err());
    let mut other_trust = trust.clone();
    other_trust.repository = "synthetic/other".into();
    assert!(coordination::Guard::load(&transaction, &installed, "101.1", &other_trust).is_err());
    let (startup, _, reconnect_only) =
        coordination::Guard::startup_connection(&transaction, &installed, &trust).unwrap();
    assert_eq!(startup, installed);
    assert!(reconnect_only);
    // Read-only connect is allowed, but GUI swap authority must reject execution
    // rooted in the replaceable installed app, including a restart after prepare.
    daemon.0.kill().unwrap();
    daemon.0.wait().unwrap();
    let direct_root = installed.join(crate::layout::RUNTIME);
    let _direct = FixtureDaemon(
        std::process::Command::new(direct_root.join("node/bin/node"))
            .arg(direct_root.join("packages/daemon/src/main.ts"))
            .env("PILOT_HOME", &location.home)
            .env("PILOT_PORT", location.port.to_string())
            .stdin(std::process::Stdio::null())
            .spawn()
            .unwrap(),
    );
    super::super::native::wait_registered(&location, &installed).unwrap();
    assert_eq!(super::super::connect(&location, &installed, &trust), Ok(()));
    assert!(
        guard.verify().is_err(),
        "restart into replaceable GUI invalidates swap authority"
    );
    assert!(
        coordination::Guard::prepare_ui(
            location.clone(),
            &installed,
            &installed,
            &transaction,
            "101.1",
            &trust
        )
        .is_err(),
        "direct installed execution cannot prepare a GUI swap"
    );
    fs::write(
        installed.join(crate::layout::POLICY),
        serde_json::to_vec_pretty(&serde_json::json!({"schema":1,"accepted_capsules":[id]}))
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        super::super::connect(&location, &installed, &trust),
        Err(Failure::Unverified),
        "tampered installed policy is not trusted"
    );
    assert_eq!(snapshot(), before);
}

impl Drop for Service {
    fn drop(&mut self) {
        let _ = command("/bin/launchctl", &["bootout".as_ref(), self.0.as_ref()]);
    }
}

#[test]
#[ignore = "explicit private synthetic stopped migration; random service and temporary profile only"]
fn native_launchd_offline_migration_missing_swift_preserves_profile_and_starts_once() {
    let node = PathBuf::from(
        std::env::var_os("PILOT_DAEMON_UPGRADE_FIXTURE_NODE").expect("explicit fixture Node"),
    );
    let temp = crate::owned_tests::Temp::new();
    fs::set_permissions(temp.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let home = temp.path().join("home");
    fs::create_dir_all(home.join("Library/LaunchAgents")).unwrap();
    fs::create_dir_all(home.join("Library/Logs/Pilot")).unwrap();
    let home = home.canonicalize().unwrap();
    let profile = home.join("profile");
    fs::create_dir(&profile).unwrap();
    fs::set_permissions(&profile, fs::Permissions::from_mode(0o700)).unwrap();
    let daemon = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    let lineage = "bbbbbbbb-bbbb-4bbb-9bbb-bbbbbbbbbbbb";
    let daemon_bytes = format!("{daemon}\n");
    let lineage_bytes = format!("{lineage}\n");
    installer::write_new(&profile.join("daemon-id"), daemon_bytes.as_bytes()).unwrap();
    installer::write_new(&profile.join("storage-lineage"), lineage_bytes.as_bytes()).unwrap();
    installer::write_new(
        &profile.join("preserved-draft"),
        b"preserved offline draft\n",
    )
    .unwrap();
    let db = profile.join(".daemon-owner.sqlite");
    command("/usr/bin/sqlite3",&[db.as_os_str(),"CREATE TABLE runtime_owner(singleton INTEGER PRIMARY KEY CHECK(singleton=1),managed INTEGER NOT NULL); INSERT INTO runtime_owner VALUES(1,0); PRAGMA user_version=1;".as_ref()]).unwrap();
    fs::set_permissions(&db, fs::Permissions::from_mode(0o600)).unwrap();
    let db_inode = fs::metadata(&db).unwrap().ino();
    let profile_inode = fs::metadata(&profile).unwrap().ino();
    let seed = bundle(
        temp.path(),
        "Pilot Next.app",
        "com.example.synthetic.offline",
        "101.1",
        &node,
        true,
    );
    // Unlike older fixtures, existing UUID identities must not be rewritten at all.
    // Count process entries before admission, so a duplicate bootstrap cannot hide
    // behind a singleton failure or the same accepted owner boot.
    let main = MAIN
        .replace("writeFileSync(process.env.PILOT_HOME+'/daemon-id','fixture-daemon',{mode:0o600});", "")
        .replace("writeFileSync(process.env.PILOT_HOME+'/storage-lineage','fixture-lineage',{mode:0o600});", "")
        .replace("readFileSync, existsSync, writeFileSync", "readFileSync, existsSync, writeFileSync, appendFileSync")
        .replace("const root=", "appendFileSync(process.env.PILOT_HOME+'/fixture-starts','start\\n',{mode:0o600});\nconst root=")
        .replace("fixture-daemon",daemon).replace("fixture-lineage",lineage);
    fs::write(
        seed.join(crate::layout::RUNTIME)
            .join("packages/daemon/src/main.ts"),
        main,
    )
    .unwrap();
    command(
        "/usr/bin/codesign",
        &[
            "--force".as_ref(),
            "--sign".as_ref(),
            "-".as_ref(),
            "--identifier".as_ref(),
            "com.example.synthetic.offline".as_ref(),
            seed.as_os_str(),
        ],
    )
    .unwrap();
    let trust = Trust {
        application_id: "com.example.synthetic.offline".into(),
        channel: "desktop-stable".into(),
        repository: "synthetic/fixture-only".into(),
        public_key: [42; 32],
        code_requirement: "identifier \"com.example.synthetic.offline\"".into(),
        current_build: "101.1".into(),
        bundle_name: "Pilot Next.app".into(),
    };
    fs::create_dir_all(home.join("Library/Application Support")).unwrap();
    let current = runtime::publish_service(
        &seed,
        &home
            .join("Library/Application Support")
            .join(runtime::SERVICE_STORE_NAME),
        &trust,
        &installer::MacPlatform,
        Instant::now() + Duration::from_secs(45),
        &AtomicBool::new(false),
    )
    .unwrap();
    let label = format!(
        "com.example.pilot-offline-{}",
        coordination::random_hex().unwrap()
    );
    assert_ne!(label, LABEL);
    let service = format!("gui/{}/{label}", unsafe { libc::geteuid() });
    let cleanup = Service(service.clone());
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let file = home
        .join("Library/LaunchAgents")
        .join(format!("{label}.plist"));
    let missing = temp.path().join("Pilot.app");
    assert!(!missing.exists());
    let old_runtime = missing.join(crate::layout::RUNTIME);
    let log = home.join("Library/Logs/Pilot/pilotd.log");
    let definition = json!({"Label":label,"ProgramArguments":[old_runtime.join("node/bin/node"),old_runtime.join("packages/daemon/src/main.ts")],"WorkingDirectory":home,"EnvironmentVariables":{"PATH":"/usr/bin:/bin","PILOT_PORT":port.to_string(),"PILOT_HOME":profile},"RunAtLoad":true,"KeepAlive":true,"ThrottleInterval":10,"ProcessType":"Interactive","StandardOutPath":log,"StandardErrorPath":log});
    installer::write_new(&file, &serde_json::to_vec(&definition).unwrap()).unwrap();
    command(
        "/usr/bin/plutil",
        &["-convert".as_ref(), "xml1".as_ref(), file.as_os_str()],
    )
    .unwrap();
    let location = Location {
        home: profile.clone(),
        port,
        policy: Default::default(),
    };
    let cancel = AtomicBool::new(false);
    let result = super::stopped::migrate_at(&home, &label, &current, &trust, &cancel);
    assert_eq!(
        result,
        Ok(()),
        "isolated offline migration: {}; journal={}",
        fs::read_to_string(&log).unwrap_or_default(),
        fs::read_to_string(profile.join(JOURNAL)).unwrap_or_default()
    );
    let owner = super::super::native::running(&location, &current).unwrap();
    assert_eq!(
        fs::read_to_string(profile.join("fixture-starts")).unwrap(),
        "start\n"
    );
    assert_eq!(
        super::stopped::migrate_at(&home, &label, &current, &trust, &cancel),
        Err(Failure::Unsupported)
    );
    assert_eq!(
        coordination::record(&location).unwrap()["boot"],
        owner["boot"]
    );
    assert_eq!(
        fs::read_to_string(profile.join("fixture-starts")).unwrap(),
        "start\n"
    );
    assert_eq!(
        fs::read(profile.join("daemon-id")).unwrap(),
        daemon_bytes.as_bytes()
    );
    assert_eq!(
        fs::read(profile.join("storage-lineage")).unwrap(),
        lineage_bytes.as_bytes()
    );
    assert_eq!(
        fs::read(profile.join("preserved-draft")).unwrap(),
        b"preserved offline draft\n"
    );
    assert_eq!(fs::metadata(&db).unwrap().ino(), db_inode);
    assert_eq!(fs::metadata(&profile).unwrap().ino(), profile_inode);
    let journal: Value = serde_json::from_slice(&fs::read(profile.join(JOURNAL)).unwrap()).unwrap();
    assert_eq!(journal["phase"], "complete");
    let backup = profile.join(".daemon-upgrade-original.plist");
    assert!(
        !backup.exists(),
        "completed migration removes its single backup"
    );
    assert!(journal.get("previousDefinition").is_none());
    assert!(file.with_extension("plist.next-owner").exists());
    assert!(!missing.exists());
    drop(cleanup);
    let end = Instant::now() + Duration::from_secs(10);
    while coordination::owner_live(&profile) {
        assert!(Instant::now() < end);
        std::thread::sleep(Duration::from_millis(50));
    }
    let managed = command(
        "/usr/bin/sqlite3",
        &[
            db.as_os_str(),
            "SELECT managed FROM runtime_owner WHERE singleton=1".as_ref(),
        ],
    )
    .unwrap();
    assert_eq!(managed, b"0\n");
    assert_eq!(fs::metadata(&db).unwrap().ino(), db_inode);
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
    fs::create_dir_all(home.join("Library/Application Support")).unwrap();
    let current = runtime::publish_service(
        &seed,
        &home
            .join("Library/Application Support")
            .join(runtime::SERVICE_STORE_NAME),
        &trust,
        &installer::MacPlatform,
        Instant::now() + Duration::from_secs(45),
        &AtomicBool::new(false),
    )
    .unwrap();
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
    // Runtime version ordering is independent of the signed GUI build numbers.
    let stamp_path = new.join(crate::layout::RUNTIME).join("runtime-build.json");
    let mut stamp: Value = serde_json::from_slice(&fs::read(&stamp_path).unwrap()).unwrap();
    stamp["version"] = json!("0.0.2");
    fs::write(&stamp_path, serde_json::to_vec(&stamp).unwrap()).unwrap();
    command(
        "/usr/bin/codesign",
        &[
            "--force".as_ref(),
            "--sign".as_ref(),
            "-".as_ref(),
            new.as_os_str(),
        ],
    )
    .unwrap();
    let trust = Trust {
        application_id: "com.example.synthetic.next".into(),
        channel: "desktop-stable".into(),
        repository: "synthetic/fixture-only".into(),
        public_key: [42; 32],
        code_requirement: "identifier \"com.example.synthetic.next\"".into(),
        current_build: "101.1".into(),
        bundle_name: "Pilot Next.app".into(),
    };
    fs::create_dir_all(home.join("Library/Application Support")).unwrap();
    let current = runtime::publish_service(
        &new,
        &home
            .join("Library/Application Support")
            .join(runtime::SERVICE_STORE_NAME),
        &trust,
        &installer::MacPlatform,
        Instant::now() + Duration::from_secs(45),
        &AtomicBool::new(false),
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
        automatic: false,
        original_backup: None,
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
    assert_eq!(
        check_needed(&mut host),
        Err(Failure::Unsupported),
        "legacy ownership stays manual-only"
    );
    let mut managed = definition.clone();
    managed["PilotNextManaged"] = json!(true);
    fs::write(&host.plist, serde_json::to_vec(&managed).unwrap()).unwrap();
    assert_eq!(check_needed(&mut host), Ok(true));
    assert!(!profile.join(JOURNAL).exists());
    assert!(
        !profile.join(".daemon-upgrade.lock").exists(),
        "checker never locks or stages"
    );
    let mut changed = managed.clone();
    changed["ProgramArguments"][1] = json!("/custom/main.ts");
    fs::write(&host.plist, serde_json::to_vec(&changed).unwrap()).unwrap();
    assert_eq!(
        host.revalidate(),
        Err(Failure::Unverified),
        "modified service refuses at exact boundary"
    );
    fs::write(&host.plist, serde_json::to_vec(&managed).unwrap()).unwrap();
    assert_eq!(check_needed(&mut host), Ok(true));
    cancel.store(true, Ordering::Release);
    assert_eq!(check_needed(&mut host), Err(Failure::Cancelled));
    cancel.store(false, Ordering::Release);
    // Equal/newer owners need no accepted-capsule entry or spare runtime slot.
    host.current = new.clone();
    for version in ["0.0.1", "0.0.0"] {
        stamp["version"] = json!(version);
        fs::write(&stamp_path, serde_json::to_vec(&stamp).unwrap()).unwrap();
        command(
            "/usr/bin/codesign",
            &[
                "--force".as_ref(),
                "--sign".as_ref(),
                "-".as_ref(),
                new.as_os_str(),
            ],
        )
        .unwrap();
        assert_eq!(check_needed(&mut host), Ok(false), "{version}");
    }
    fs::write(&stamp_path, b"tampered").unwrap();
    assert_eq!(
        check_needed(&mut host),
        Err(Failure::Unverified),
        "package signature required"
    );
    host.current = current.clone();
    host.automatic = true;
    host.prepare().unwrap();
    let boot = host.owner["boot"].clone();
    fs::write(profile.join("tool-pending"), "1").unwrap();
    std::thread::scope(|scope| {
        scope.spawn(|| {
            std::thread::sleep(Duration::from_millis(1200));
            cancel.store(true, Ordering::Release);
        });
        assert_eq!(host.drained(), Err(Failure::Cancelled));
    });
    assert!(
        fs::read_to_string(profile.join("pause-count"))
            .unwrap()
            .parse::<u32>()
            .unwrap()
            >= 2,
        "pause lease renewed while tool runs"
    );
    assert_eq!(coordination::record(&location).unwrap()["boot"], boot);
    assert!(
        !profile.join(JOURNAL).exists(),
        "cancelled boundary never stops"
    );
    fs::remove_file(profile.join("tool-pending")).unwrap();
    cancel.store(false, Ordering::Release);
    host.automatic = false;
    host.lock.take();
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
    cancel.store(true, Ordering::Release);
    assert_eq!(
        host.verify_target(),
        Ok(()),
        "post-stop payload validation must not cancel bootstrap"
    );
    cancel.store(false, Ordering::Release);
    host.automatic = true;
    execute(&mut host, &cancel).expect("verified synthetic automatic launchd handoff");
    host.lock.take();
    assert_eq!(
        check_needed(&mut host),
        Ok(false),
        "automatic handoff is now current"
    );
    assert_eq!(
        execute(&mut host, &cancel),
        Err(Failure::Busy),
        "equal automatic target never stops twice"
    );
    host.lock.take();
    host.automatic = false;
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
    // No allowlist and no reads of obsolete files. Publish one verified candidate
    // even when the running retained capsule is entirely gone.
    let replacement = bundle(
        temp.path(),
        "Pilot Next.app",
        &trust.application_id,
        "101.1",
        &node,
        true,
    );
    let stamp_path = replacement
        .join(crate::layout::RUNTIME)
        .join("runtime-build.json");
    let mut stamp: Value = serde_json::from_slice(&fs::read(&stamp_path).unwrap()).unwrap();
    stamp["version"] = json!("0.0.3");
    fs::write(&stamp_path, serde_json::to_vec(&stamp).unwrap()).unwrap();
    command(
        "/usr/bin/codesign",
        &[
            "--force".as_ref(),
            "--sign".as_ref(),
            "-".as_ref(),
            replacement.as_os_str(),
        ],
    )
    .unwrap();
    let next = runtime::publish_service(
        &replacement,
        current.parent().unwrap().parent().unwrap(),
        &trust,
        &installer::MacPlatform,
        Instant::now() + Duration::from_secs(45),
        &AtomicBool::new(false),
    )
    .unwrap();
    host.current = next.clone();
    host.automatic = true;
    host.prepare().unwrap();
    host.lock.take();
    let original_build = host.owner["build"].clone();
    fs::remove_dir_all(current.parent().unwrap()).unwrap();
    assert_eq!(
        check_needed(&mut host),
        Ok(true),
        "startup accepts the live deleted old runtime"
    );
    assert_eq!(
        host.owner["build"], original_build,
        "original authenticated tuple retained"
    );
    let owner = host.owner.clone();
    for field in ["build", "runtimeRoot", "pid"] {
        host.owner[field] = Value::Null;
        assert!(
            host.verify_running_payload().is_err(),
            "substituted {field}"
        );
        host.owner = owner.clone();
    }
    assert_eq!(
        verify_process_owner(std::process::id() as i32, &profile),
        Err(Failure::Unverified),
        "a different process cannot borrow the daemon lease"
    );
    let journal_path = profile.join(JOURNAL);
    let completed = fs::read(&journal_path).unwrap();
    fs::write(&journal_path, b"{\"phase\":\"stopped\"}").unwrap();
    assert_eq!(host.prepare(), Err(Failure::Unknown));
    fs::write(&journal_path, &completed).unwrap();
    fs::write(profile.join("blocker"), "job").unwrap();
    assert_eq!(execute(&mut host, &cancel), Err(Failure::Busy));
    host.lock.take();
    assert_eq!(
        fs::read(&journal_path).unwrap(),
        completed,
        "busy missing boot never stops"
    );
    fs::remove_file(profile.join("blocker")).unwrap();
    execute(&mut host, &cancel).expect("automatic missing-capsule handoff to immutable candidate");
    host.lock.take();
    assert_ne!(
        coordination::record(&location).unwrap()["boot"],
        owner["boot"]
    );
    assert_eq!(
        super::super::native::running(&location, &next).unwrap()["build"],
        stamp
    );

    // GUI exchange never changes the running daemon's lexical module namespace.
    // Late file reads stay on its one active immutable copy while work defers.
    let rollback = temp.path().join("rollback.app");
    fs::rename(&replacement, &rollback).unwrap();
    let swapped = bundle(
        temp.path(),
        "Pilot Next.app",
        &trust.application_id,
        "101.1",
        &node,
        true,
    );
    stamp["source"] = json!("cccccccccccccccccccccccccccccccccccccccc");
    let stamp_path = swapped
        .join(crate::layout::RUNTIME)
        .join("runtime-build.json");
    fs::write(&stamp_path, serde_json::to_vec(&stamp).unwrap()).unwrap();
    command(
        "/usr/bin/codesign",
        &[
            "--force".as_ref(),
            "--sign".as_ref(),
            "-".as_ref(),
            swapped.as_os_str(),
        ],
    )
    .unwrap();
    host.current = swapped.clone();
    assert_eq!(
        check_needed(&mut host),
        Ok(true),
        "same-version changed build after GUI swap"
    );
    let old_pid = host.pid().unwrap();
    assert!(
        helper::process_executable(old_pid)
            .unwrap()
            .starts_with(&next)
    );
    let old_stamp: Value = serde_json::from_slice(
        &reqwest::blocking::get(format!(
            "http://127.0.0.1:{}/fixture-runtime-build",
            location.port
        ))
        .unwrap()
        .bytes()
        .unwrap(),
    )
    .unwrap();
    assert_ne!(
        old_stamp["source"], stamp["source"],
        "late reads do not cross into swapped GUI"
    );
    host.current = runtime::publish_service(
        &swapped,
        next.parent().unwrap().parent().unwrap(),
        &trust,
        &installer::MacPlatform,
        Instant::now() + Duration::from_secs(45),
        &AtomicBool::new(false),
    )
    .unwrap();
    fs::write(profile.join("blocker"), "job").unwrap();
    assert_eq!(execute(&mut host, &cancel), Err(Failure::Busy));
    host.lock.take();
    assert_eq!(coordination::record(&location).unwrap()["pid"], old_pid);
    fs::remove_file(profile.join("blocker")).unwrap();
    execute(&mut host, &cancel).expect("same-version immutable handoff after GUI exchange");
    host.lock.take();
    assert_eq!(check_needed(&mut host), Ok(false));
    fs::remove_dir_all(&rollback).unwrap();
    assert_eq!(
        super::super::native::running(&location, &host.current).unwrap()["build"],
        stamp
    );
    assert_eq!(
        fs::read_to_string(profile.join("preserved-draft")).unwrap(),
        "still here 🐦"
    );
    let journal: Value = serde_json::from_slice(&fs::read(profile.join(JOURNAL)).unwrap()).unwrap();
    assert_eq!(journal["phase"], "complete");
    assert_eq!(journal["runtime"], json!(host.current));
    assert!(journal.get("previousDefinition").is_none());
    assert_eq!(
        plist(&host.plist).unwrap()["ProgramArguments"]
            .as_array()
            .unwrap()
            .len(),
        2
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
