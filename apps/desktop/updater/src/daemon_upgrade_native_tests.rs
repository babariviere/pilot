//! Opt-in genuine launchd fixture. Its random label and private tree never name
//! the installed service, app or user data. No test-only bypass is in production.
use super::*;
use std::{net::TcpListener, os::unix::fs::PermissionsExt};

const OWNER: &str = include_str!("../../../../packages/daemon/src/runtime-owner.ts");
const MAIN: &str = r#"
import { ownRuntime } from './runtime-owner.ts';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../../../',import.meta.url)).replace(/\/$/,'');
const stamp=root+'/runtime-build.json';
const build=existsSync(stamp)?JSON.parse(readFileSync(stamp,'utf8')):null;
const owner=await ownRuntime(process.env.PILOT_HOME,Number(process.env.PILOT_PORT),false,build,build?root:undefined);
owner.install((req,res)=>{
  if(req.url==='/api/update/pause' && req.method==='POST') {
    res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({ready:true,processId:process.pid}));
  } else res.writeHead(404).end();
});
owner.ready({daemonId:'fixture-daemon',lineageId:'fixture-lineage',daemonVersion:'0.0.1',protocolVersion:1,minimumClientProtocolVersion:1,platform:process.platform,arch:process.arch,capabilities:{independentExecution:true}});
process.on('SIGTERM',async()=>{await owner.close();process.exit(0)});
"#;

fn bundle(root: &Path, name: &str, id: &str, build: &str, node: &Path, new: bool) -> PathBuf {
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
    fs::write(runtime.join("package.json"), b"{\"type\":\"module\"}").unwrap();
    fs::write(runtime.join("packages/daemon/src/main.ts"), MAIN).unwrap();
    fs::write(runtime.join("packages/daemon/src/runtime-owner.ts"), OWNER).unwrap();
    if new {
        let version = command(
            node.to_str().unwrap(),
            &["-p".as_ref(), "process.versions.node".as_ref()],
        )
        .unwrap();
        fs::write(runtime.join("runtime-build.json"),serde_json::to_vec(&json!({"schema":1,"source":"a".repeat(40),"version":"0.0.1","protocol":1,"platform":"darwin","arch":"arm64","node":std::str::from_utf8(&version).unwrap().trim()})).unwrap()).unwrap();
    }
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
        pause_until: None,
    };
    execute(&mut host, &cancel).expect("verified synthetic launchd handoff");
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
