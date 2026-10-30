//! Real native helper/OS-exit/swap/startup qualification with synthetic identity,
//! temporary signed bundles and an owned Node using the actual proof/reservation
//! source. Not a GUI, production bundle or OS acceptance test.
use base64::{Engine as _, engine::general_purpose::STANDARD};
#[cfg(target_os = "macos")]
use pilot_desktop_updater::runtime;
use pilot_desktop_updater::{
    app_update::{Connection, ExitGuard},
    coordination::{Guard, Location},
    helper,
    installer::{self, NativePlatform, Platform},
    manifest::{self, Trust, VerifiedManifest},
    transport::Cancellation,
};
use ring::signature::{Ed25519KeyPair, KeyPair};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{BufRead, Read, Write},
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

const OWNER: &str = include_str!("../../../../packages/daemon/src/runtime-owner.ts");
const RESERVATION: &str = include_str!("../../../../packages/daemon/src/update-reservation.ts");
const NODE: &str = r#"
import {realpath,writeFile,readFile,appendFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {existsSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import {randomUUID} from 'node:crypto';
import {ownRuntime} from './runtime-owner.ts';
import {UpdateReservation} from './update-reservation.ts';
const root=await realpath(fileURLToPath(new URL('../../../',import.meta.url)));
const home=process.argv[2],port=Number(process.argv[3]);
const build=JSON.parse(await readFile(join(root,'runtime-build.json'),'utf8'));
const owner=await ownRuntime(home,port,true,build,root);
const daemonId=randomUUID(),lineageId=randomUUID();
await writeFile(join(home,'daemon-id'),daemonId,{mode:0o600});
await writeFile(join(home,'storage-lineage'),lineageId,{mode:0o600});
let frozen=false;
const clock=()=>existsSync(join(home,'../expire-reservation'))?Number.MAX_SAFE_INTEGER:performance.now();
const gate=new UpdateReservation({freezeAdmissions(){if(existsSync(join(home,'../no-management')))throw Error('GUI update froze active agents');if(frozen)throw Error('busy');frozen=true;return()=>{frozen=false;};},async blockers(){return existsSync(join(home,'../no-management'))?['active-agent']:[];}},clock);
owner.updates(async(action,receipt)=>{await appendFile(join(home,'../update-actions'),action+'\n',{mode:0o600});if(action==='inspect')return receipt;if(existsSync(join(home,'../no-management')))throw Error('management forbidden during UI-only reload');if(action==='prepare')return gate.prepare(receipt.operationId);if(action==='cancel'){gate.cancel(receipt);return receipt;}return gate.verify(receipt);});
const hello={daemonId,lineageId,daemonVersion:build.version,protocolVersion:1,minimumClientProtocolVersion:1,platform:build.platform,arch:build.arch,capabilities:{independentExecution:true}};
owner.install((req,res)=>{if(req.url==='/api/update/pause'){writeFile(join(home,'../pause-requested'),'unexpected',{mode:0o600});}if(req.method==='GET'&&req.url==='/api/hello'){res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify(hello));}else{res.writeHead(403).end();}});
owner.ready(hello);
console.log('READY');
"#;

fn main() {
    let args: Vec<_> = std::env::args().skip(1).collect();
    let result = std::thread::spawn(move || run(args))
        .join()
        .expect("fixture thread");
    if let Err(error) = result {
        eprintln!("Fixture lifecycle failed: {error}");
        std::process::exit(1);
    }
}
type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
fn err(error: pilot_desktop_updater::Error) -> Box<dyn std::error::Error + Send + Sync> {
    format!("{error:?}").into()
}
fn trust() -> Result<Trust> {
    let trust = helper::compiled_trust().map_err(err)?;
    let key = Ed25519KeyPair::from_seed_unchecked(&[42; 32]).map_err(|_| "fixture key")?;
    if trust.application_id != "com.example.synthetic.next"
        || trust.public_key.as_slice() != key.public_key().as_ref()
    {
        return Err("Synthetic compiled trust required".into());
    }
    Ok(trust)
}
fn safe_root(path: &Path) -> Result<PathBuf> {
    let path = path.canonicalize()?;
    let temporary = std::env::temp_dir().canonicalize()?;
    let m = fs::symlink_metadata(&path)?;
    if !path.starts_with(temporary)
        || !m.is_dir()
        || m.mode() & 0o077 != 0
        || m.uid() != unsafe { libc::geteuid() }
    {
        return Err("Private owned temporary fixture root required".into());
    }
    Ok(path)
}
// Cross-process monotonic timestamps, stored only in the owned temporary fixture.
fn event(root: &Path, name: &str) -> Result<()> {
    let mut clock = std::mem::MaybeUninit::<libc::timespec>::uninit();
    // SAFETY: valid output slot for the system monotonic clock.
    if unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, clock.as_mut_ptr()) } != 0 {
        return Err("monotonic fixture clock unavailable".into());
    }
    // SAFETY: successful clock_gettime initialized the output.
    let clock = unsafe { clock.assume_init() };
    let seconds = clock.tv_sec as f64 + clock.tv_nsec as f64 / 1e9;
    fs::write(
        root.join(format!("timing-{name}.json")),
        serde_json::to_vec(&seconds)?,
    )?;
    Ok(())
}
fn run(args: Vec<String>) -> Result<()> {
    let trust = trust()?;
    if args.len() == 2 && args[0] == "--updater-receipt" {
        let executable = std::env::current_exe()?;
        let target = executable
            .ancestors()
            .nth(pilot_desktop_updater::layout::GUI.split('/').count())
            .ok_or("app root")?
            .canonicalize()?;
        let root = safe_root(
            target
                .parent()
                .and_then(Path::parent)
                .ok_or("fixture parent")?,
        )?;
        #[cfg(target_os = "linux")]
        if std::env::var_os("XDG_STATE_HOME").as_deref()
            != Some(root.join("state with spaces").as_os_str())
        {
            return Err("GUI state root was not preserved".into());
        }
        let transaction = PathBuf::from(&args[1]);
        if !transaction.starts_with(&root) {
            return Err("receipt escaped fixture".into());
        }
        event(&root, "startup_entered")?;
        if root.join("fail-startup").exists() {
            return Err("owned startup failure injection".into());
        }
        if !root.join("external-mode").exists() {
            // Startup must reconnect to the original exact runtime, not acquire
            // launch authority or substitute the newly installed app's payload.
            let (capsule, location, reconnect_only) =
                Guard::startup_connection(&transaction, &target, &trust).map_err(err)?;
            let original: Location =
                serde_json::from_slice(&fs::read(root.join("location.json"))?)?;
            let owner: serde_json::Value =
                serde_json::from_slice(&fs::read(original.home.join(".daemon-owner.json"))?)?;
            let ui_only = root.join("no-management").exists();
            // macOS UI-only startup reconnects by exact app target/hello identity;
            // it deliberately does not return or admit a retained daemon runtime.
            let root_matches = if cfg!(target_os = "macos") && ui_only {
                capsule == target
            } else {
                owner["runtimeRoot"].as_str()
                    == capsule
                        .join(pilot_desktop_updater::layout::RUNTIME)
                        .to_str()
            };
            if !root_matches
                || location.home != original.home
                || location.port != original.port
                || reconnect_only != ui_only
                || !capsule.is_dir()
            {
                return Err("startup receipt changed reconnect authority".into());
            }
        }
        ExitGuard::acknowledge_startup(&transaction, &target, &trust).map_err(err)?;
        event(&root, "startup_ack")?;
        fs::write(
            root.join("startup-acknowledged"),
            b"actual native startup acknowledgement",
        )?;
        return Ok(());
    }
    if args.len() == 3 && args[0] == "--owned-parent" {
        let root = safe_root(Path::new(&args[1]))?;
        let location: Location = serde_json::from_slice(&fs::read(root.join("location.json"))?)?;
        let target = std::env::current_exe()?
            .ancestors()
            .nth(pilot_desktop_updater::layout::GUI.split('/').count())
            .ok_or("parent bundle")?
            .canonicalize()?;
        if !target.starts_with(&root) {
            return Err("parent escaped fixture".into());
        }
        let manifest: VerifiedManifest =
            VerifiedManifest::parse(&fs::read(root.join("envelope.json"))?, &trust, 12)
                .map_err(err)?;
        event(&root, "preparation_started")?;
        let (stage, lock) = installer::new_stage(&target, &trust, &NativePlatform).map_err(err)?;
        fs::copy(
            root.join("archive.zip"),
            installer::download_path(&stage).map_err(err)?,
        )?;
        let staged = installer::finish_stage(
            stage.clone(),
            target.clone(),
            lock,
            manifest,
            &trust,
            &NativePlatform,
            &Cancellation::default(),
        )
        .map_err(err)?;
        let guard = if args[2] == "external" {
            let daemon = fs::read_to_string(location.home.join("daemon-id"))?
                .trim()
                .to_owned();
            let lineage = fs::read_to_string(location.home.join("storage-lineage"))?
                .trim()
                .to_owned();
            ExitGuard::prepare_external(
                Connection::new(location, daemon, lineage),
                &target,
                &stage,
                staged.build(),
                &trust,
            )
            .map_err(err)?
        } else {
            let candidate = installer::preview_bundle(&stage, &trust).map_err(err)?;
            let guard = if args[2] == "ui-only" {
                Guard::prepare_ui(
                    location,
                    &candidate,
                    &target,
                    &stage,
                    staged.build(),
                    &trust,
                )
            } else {
                Guard::prepare(location, &candidate, &stage, staged.build(), &trust)
            }
            .map_err(err)?;
            guard.save().map_err(err)?;
            ExitGuard::Retained(guard)
        };
        fs::write(
            root.join("transaction"),
            stage.as_os_str().as_encoded_bytes(),
        )?;
        let mut prepared = helper::PreparedExit::launch(&staged, |_| {}).map_err(err)?;
        if args[2] == "interrupt" {
            fs::write(root.join("parent-prepared"), b"no COMMIT")?;
            std::thread::sleep(Duration::from_secs(60));
            return Err("owned parent interruption did not arrive".into());
        }
        if args[2] == "cancel" {
            drop(prepared);
            guard.cancel();
            return Ok(());
        }
        if args[2] == "tamper" {
            fs::write(
                installer::preview_bundle(&stage, &trust)
                    .map_err(err)?
                    .parent()
                    .unwrap()
                    .parent()
                    .unwrap()
                    .join("install-payload")
                    .join(&trust.bundle_name)
                    .join("Contents/Resources/unsealed-extra"),
                b"must refuse even outside sealed resources",
            )?;
        }
        if args[2] == "expired" {
            // Fault injection bypasses the GUI worker's own pre-COMMIT check.
            // The real helper must still refuse after OS-observed exit.
            fs::write(
                root.join("expire-reservation"),
                b"fixture monotonic deadline fault injection",
            )?;
        } else {
            guard.verify().map_err(err)?;
        }
        prepared.commit().map_err(err)?;
        fs::write(root.join("committed"), b"explicit acknowledged COMMIT")?;
        event(&root, "exiting")?;
        // Actual process exit, not a forged ExitedParent fixture token.
        std::process::exit(0);
    }
    if args.len() != 4
        || !matches!(
            args[0].as_str(),
            "--verify"
                | "--verify-timings"
                | "--verify-external"
                | "--verify-ui-only"
                | "--verify-cancel"
                | "--verify-expired"
                | "--verify-interrupted"
                | "--verify-startup-fails"
                | "--verify-prepared-tamper"
        )
        || trust.current_build != "100.1"
    {
        return Err("Use --verify TEMP_ROOT INPUTS NODE with synthetic old-build trust".into());
    }
    let timings = args[0] == "--verify-timings";
    let mode = match args[0].as_str() {
        "--verify-external" | "--verify-timings" => "external",
        "--verify-ui-only" => "ui-only",
        "--verify-cancel" => "cancel",
        "--verify-expired" => "expired",
        "--verify-interrupted" => "interrupt",
        "--verify-startup-fails" => "launch-fails",
        "--verify-prepared-tamper" => "tamper",
        _ => "success",
    };
    let root = safe_root(Path::new(&args[1]))?;
    if mode == "launch-fails" {
        fs::write(root.join("fail-startup"), b"owned failure injection")?;
    }
    let inputs = Path::new(&args[2]).canonicalize()?;
    let node = Path::new(&args[3]).canonicalize()?;
    if timings {
        fs::write(root.join("many-files"), b"4096 synthetic small resources")?;
    }
    let installed = root.join("Installed");
    fs::create_dir(&installed)?;
    let old = installed.join(trust.bundle_name.as_str());
    bundle(
        &old,
        &inputs.join("old"),
        &node,
        "100.1",
        "0.1.0",
        &[],
        &trust,
    )?;
    #[cfg(target_os = "macos")]
    let capsule = runtime::publish(
        &old,
        &root.join(runtime::STORE_NAME),
        &trust,
        &NativePlatform,
    )
    .map_err(err)?;
    #[cfg(target_os = "linux")]
    let capsule = publish_linux(&old, &root)?;
    let id = capsule_id(&capsule)?;
    let new_parent = root.join("Candidate");
    fs::create_dir(&new_parent)?;
    let candidate = new_parent.join(trust.bundle_name.as_str());
    bundle(
        &candidate,
        &inputs.join("new"),
        &node,
        "101.1",
        "0.1.1",
        std::slice::from_ref(&id),
        &trust,
    )?;
    zip_bundle(&candidate, &root.join("archive.zip"))?;
    envelope(
        &root.join("archive.zip"),
        &root.join("envelope.json"),
        &trust,
    )?;
    let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))?;
    let port = listener.local_addr()?.port();
    drop(listener);
    let location = Location {
        home: root.join("profile"),
        port,
        policy: Default::default(),
    };
    fs::write(root.join("location.json"), serde_json::to_vec(&location)?)?;
    let mut process = Command::new(capsule.join(format!(
        "{}/node/bin/node",
        pilot_desktop_updater::layout::RUNTIME
    )));
    process
        .arg(capsule.join(format!(
            "{}/packages/daemon/src/fixture-owner.ts",
            pilot_desktop_updater::layout::RUNTIME
        )))
        .arg(&location.home)
        .arg(port.to_string())
        .env_clear()
        .env("HOME", &root)
        .env("PATH", "/usr/bin:/bin")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    let mut daemon = Owned(process.spawn()?);
    let stdout = daemon.0.stdout.take().ok_or("node stdout")?;
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let mut line = String::new();
        let _ = std::io::BufReader::new(stdout)
            .take(4097)
            .read_line(&mut line);
        let _ = tx.send(line);
    });
    if rx.recv_timeout(Duration::from_secs(10))? != "READY\n" {
        return Err("owned daemon did not become ready".into());
    }
    if matches!(mode, "external" | "ui-only") {
        fs::write(
            root.join("no-management"),
            b"UI-only restart must not acquire daemon authority",
        )?;
    }
    if mode == "external" {
        fs::write(root.join("external-mode"), b"external GET-only proof")?;
        let path = location.home.join(".daemon-owner.json");
        let mut record: serde_json::Value = serde_json::from_slice(&fs::read(&path)?)?;
        record["build"] = serde_json::Value::Null;
        record
            .as_object_mut()
            .ok_or("owner record")?
            .remove("runtimeRoot");
        fs::write(path, serde_json::to_vec(&record)?)?;
    }
    let original = fs::read(location.home.join(".daemon-owner.json"))?;
    let mut parent = Owned(
        Command::new(old.join(pilot_desktop_updater::layout::GUI))
            .arg("--owned-parent")
            .arg(&root)
            .arg(mode)
            .env_clear()
            .env("XDG_STATE_HOME", root.join("state with spaces"))
            .env("HOME", &root)
            .env("PATH", "/usr/bin:/bin")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()?,
    );
    if mode == "interrupt" {
        let deadline = Instant::now() + Duration::from_secs(30);
        while !root.join("parent-prepared").exists() {
            if Instant::now() >= deadline || parent.0.try_wait()?.is_some() {
                return Err("owned preparation failed".into());
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        parent.0.kill()?;
        parent.0.wait()?;
    } else {
        wait_exit(&mut parent.0, Duration::from_secs(90))?;
    }
    event(&root, "exit_observed")?;
    if !matches!(mode, "success" | "external" | "ui-only") {
        let transaction = PathBuf::from(String::from_utf8(fs::read(root.join("transaction"))?)?);
        // The parent has actually exited. Acquiring its permanent inherited target
        // lock proves the helper has also released ownership, not merely that two
        // seconds elapsed while it was still verifying. Keep the faux daemon alive
        // until refusal is settled, so owner death cannot mask a lease-expiry bug.
        let deadline = Instant::now() + Duration::from_secs(120);
        let _settled = loop {
            match installer::lock_target(&old) {
                Ok(lock) => break lock,
                Err(pilot_desktop_updater::Error::Busy) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(10));
                }
                _ => return Err("owned helper did not release target ownership".into()),
            }
        };
        NativePlatform
            .verify(
                &old,
                &trust,
                if mode == "launch-fails" {
                    "101.1"
                } else {
                    "100.1"
                },
                Some(if mode == "launch-fails" {
                    "0.1.1"
                } else {
                    "0.1.0"
                }),
            )
            .map_err(err)?;
        let expected = if mode == "launch-fails" {
            installer::Phase::RelaunchRequested
        } else if matches!(mode, "cancel" | "interrupt") {
            installer::Phase::Ready
        } else {
            installer::Phase::Committed
        };
        if installer::recovery_phase(&transaction).map_err(err)? != expected
            || root.join("startup-acknowledged").exists()
        {
            return Err("cancelled/expired fixture installed or lost recovery evidence".into());
        }
        if fs::read(location.home.join(".daemon-owner.json"))? != original
            || capsule_id(&capsule)? != id
        {
            return Err("fixture refusal changed runtime".into());
        }
        println!(
            "PASS real native helper {mode} preserves daemon, retained payloads and truthful recovery journal"
        );
        return Ok(());
    }
    let deadline = Instant::now() + Duration::from_secs(90);
    while !root.join("startup-acknowledged").exists() {
        if Instant::now() >= deadline {
            return Err("native startup ACK timed out; retained evidence preserved".into());
        }
        if daemon.0.try_wait()?.is_some() {
            return Err("owned daemon exited during app update".into());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let transaction = PathBuf::from(String::from_utf8(fs::read(root.join("transaction"))?)?);
    if installer::recovery_phase(&transaction).map_err(err)?
        != installer::Phase::StartupAcknowledged
    {
        return Err("startup journal not acknowledged".into());
    }
    if fs::read(location.home.join(".daemon-owner.json"))? != original {
        return Err("daemon identity changed".into());
    }
    if capsule_id(&capsule)? != id {
        return Err("active capsule changed".into());
    }
    if matches!(mode, "external" | "ui-only") {
        if root.join("pause-requested").exists() {
            return Err("app update requested agent pause".into());
        }
        let actions = fs::read_to_string(root.join("update-actions")).unwrap_or_default();
        if actions.lines().any(|action| action != "inspect")
            || (cfg!(target_os = "linux") && mode == "ui-only" && actions.lines().count() < 3)
        {
            return Err("app update acquired management authority or skipped proof".into());
        }
    }
    if !installer::rollback_bundle(&transaction, &trust).is_dir() {
        return Err("old app not retained".into());
    }
    let read_event = |name: &str| -> Result<f64> {
        Ok(serde_json::from_slice(&fs::read(
            root.join(format!("timing-{name}.json")),
        )?)?)
    };
    let exiting = read_event("exiting")?;
    // Exiting is recorded immediately before exit. The observer's polling interval
    // brackets actual OS exit, rather than calling the pre-exit marker exact exit.
    println!(
        "lifecycle-phase preparation {:.6}",
        exiting - read_event("preparation_started")?
    );
    println!(
        "lifecycle-phase exit_observation_bound {:.6}",
        read_event("exit_observed")? - exiting
    );
    println!(
        "lifecycle-phase blackout_upper_bound {:.6}",
        read_event("startup_entered")? - exiting
    );
    println!(
        "lifecycle-phase blackout_through_ack_upper_bound {:.6}",
        read_event("startup_ack")? - exiting
    );
    println!(
        "PASS real native helper COMMIT -> OS parent exit -> verified whole-app swap -> actual startup ACK; daemon boot and immutable paths unchanged"
    );
    Ok(())
}
struct Owned(Child);
impl Drop for Owned {
    fn drop(&mut self) {
        if self.0.try_wait().ok().flatten().is_none() {
            let _ = self.0.kill();
        }
        let _ = self.0.wait();
    }
}
fn wait_exit(child: &mut Child, timeout: Duration) -> Result<()> {
    let until = Instant::now() + timeout;
    loop {
        if let Some(status) = child.try_wait()? {
            if status.success() {
                return Ok(());
            }
            return Err("owned fixture parent failed".into());
        }
        if Instant::now() >= until {
            return Err("owned parent timeout".into());
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}
#[cfg(target_os = "macos")]
fn command(c: &mut Command) -> Result<()> {
    if !c
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .status()?
        .success()
    {
        return Err("native fixture command failed".into());
    }
    Ok(())
}
#[cfg(target_os = "macos")]
fn bundle(
    app: &Path,
    inputs: &Path,
    node: &Path,
    build: &str,
    short: &str,
    accepted: &[String],
    trust: &Trust,
) -> Result<()> {
    let contents = app.join("Contents");
    let runtime = contents.join("Resources/runtime");
    fs::create_dir_all(contents.join("MacOS"))?;
    fs::create_dir_all(contents.join("Helpers"))?;
    fs::create_dir_all(runtime.join("node/bin"))?;
    fs::create_dir_all(runtime.join("packages/daemon/src"))?;
    fs::copy(
        inputs.join("lifecycle-fixture"),
        contents.join("MacOS/pilot-desktop"),
    )?;
    fs::copy(
        inputs.join("pilot-desktop-update-helper"),
        contents.join("Helpers/pilot-desktop-update-helper"),
    )?;
    fs::copy(node, runtime.join("node/bin/node"))?;
    for file in [
        contents.join("MacOS/pilot-desktop"),
        contents.join("Helpers/pilot-desktop-update-helper"),
        runtime.join("node/bin/node"),
    ] {
        fs::set_permissions(&file, fs::Permissions::from_mode(0o755))?;
        command(
            Command::new("/usr/bin/codesign")
                .args(["--force", "--sign", "-"])
                .arg(file),
        )?;
    }
    if app
        .parent()
        .and_then(Path::parent)
        .is_some_and(|root| root.join("many-files").exists())
    {
        let resources = contents.join("Resources/synthetic-small-files");
        fs::create_dir(&resources)?;
        for index in 0..4096 {
            fs::write(resources.join(format!("{index:04}.txt")), [b'x'; 128])?;
        }
    }
    fs::write(runtime.join("packages/daemon/src/runtime-owner.ts"), OWNER)?;
    fs::write(
        runtime.join("packages/daemon/src/update-reservation.ts"),
        RESERVATION,
    )?;
    fs::write(runtime.join("packages/daemon/src/fixture-owner.ts"), NODE)?;
    let stamp = serde_json::json!({"schema":1,"source":"a".repeat(40),"version":"0.1.0","protocol":1,"platform":"darwin","arch":"arm64","node":"24.21.0"});
    fs::write(
        runtime.join("runtime-build.json"),
        serde_json::to_vec(&stamp)?,
    )?;
    fs::write(
        contents.join("Resources/update-runtime-policy.json"),
        serde_json::to_vec(&serde_json::json!({"schema":1,"accepted_capsules":accepted}))?,
    )?;
    fs::write(
        contents.join("Info.plist"),
        format!(
            r#"<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>{}</string><key>CFBundleName</key><string>Pilot Next Fixture</string><key>CFBundleExecutable</key><string>pilot-desktop</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>{build}</string><key>CFBundleShortVersionString</key><string>{short}</string><key>LSMinimumSystemVersion</key><string>15.0</string><key>LSUIElement</key><true/></dict></plist>"#,
            trust.application_id
        ),
    )?;
    command(
        Command::new("/usr/bin/codesign")
            .args(["--force", "--sign", "-"])
            .arg(app),
    )?;
    NativePlatform
        .verify(app, trust, build, Some(short))
        .map_err(err)?;
    Ok(())
}
fn zip_bundle(app: &Path, output: &Path) -> Result<()> {
    let mut zip = zip::ZipWriter::new(File::create(output)?);
    let mut paths = vec![app.to_path_buf()];
    while let Some(path) = paths.pop() {
        let meta = fs::symlink_metadata(&path)?;
        let name = format!(
            "{}/{}",
            pilot_desktop_updater::layout::BUNDLE,
            path.strip_prefix(app)?.to_str().ok_or("fixture path")?
        );
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored)
            .unix_permissions(meta.mode() & 0o777);
        if meta.is_dir() {
            zip.add_directory(
                if name.ends_with('/') {
                    name
                } else {
                    format!("{name}/")
                },
                options,
            )?;
            let mut children = fs::read_dir(path)?
                .map(|e| e.map(|e| e.path()))
                .collect::<std::result::Result<Vec<_>, _>>()?;
            children.sort();
            paths.extend(children.into_iter().rev());
        } else {
            zip.start_file(name, options)?;
            std::io::copy(&mut File::open(path)?, &mut zip)?;
        }
    }
    zip.finish()?.sync_all()?;
    Ok(())
}
fn envelope(archive: &Path, output: &Path, trust: &Trust) -> Result<()> {
    let mut hash = Sha256::new();
    std::io::copy(&mut File::open(archive)?, &mut HashWriter(&mut hash))?;
    let value = manifest::Manifest {
        schema: 1,
        source: if cfg!(target_os = "linux") {
            Some("a".repeat(40))
        } else {
            None
        },
        application_id: trust.application_id.clone(),
        channel: trust.channel.clone(),
        platform: manifest::PLATFORM.into(),
        architecture: manifest::ARCHITECTURE.into(),
        build: "101.1".into(),
        short_version: "0.1.1".into(),
        bundle_name: trust.bundle_name.clone(),
        archive_name: manifest::ARCHIVE_ASSET.into(),
        archive_asset_id: 12,
        archive_size: fs::metadata(archive)?.len(),
        archive_sha256: hash
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>(),
    };
    let bytes = serde_json::to_vec(&value)?;
    let key = Ed25519KeyPair::from_seed_unchecked(&[42; 32]).map_err(|_| "fixture key")?;
    fs::write(
        output,
        serde_json::to_vec(&manifest::Envelope {
            signed: STANDARD.encode(&bytes),
            signature: STANDARD.encode(key.sign(&bytes).as_ref()),
        })?,
    )?;
    Ok(())
}
struct HashWriter<'a>(&'a mut Sha256);
#[cfg(target_os = "macos")]
fn capsule_id(root: &Path) -> Result<String> {
    runtime::identity(root).map_err(err)
}
#[cfg(target_os = "linux")]
fn capsule_id(root: &Path) -> Result<String> {
    Ok(
        Sha256::digest(fs::read(root.join("linux-gui-package.json"))?)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>(),
    )
}
#[cfg(target_os = "linux")]
fn publish_linux(old: &Path, root: &Path) -> Result<PathBuf> {
    let id = capsule_id(old)?;
    let store = root.join("runtimes");
    fs::create_dir(&store)?;
    fs::set_permissions(&store, fs::Permissions::from_mode(0o700))?;
    let destination = store.join(id).join("payload");
    copy_tree(old, &destination)?;
    Ok(destination)
}
#[cfg(target_os = "linux")]
fn copy_tree(from: &Path, to: &Path) -> Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let path = entry?.path();
        let target = to.join(path.file_name().ok_or("path")?);
        if path.is_dir() {
            copy_tree(&path, &target)?;
        } else {
            fs::copy(path, target)?;
        }
    }
    Ok(())
}
#[cfg(target_os = "linux")]
fn bundle(
    app: &Path,
    inputs: &Path,
    node: &Path,
    build: &str,
    short: &str,
    accepted: &[String],
    trust: &Trust,
) -> Result<()> {
    use serde_json::json;
    for directory in [
        "libexec",
        "bin",
        "runtime/node/bin",
        "runtime/packages/daemon/src",
        "runtime/packages/kernel/src",
    ] {
        fs::create_dir_all(app.join(directory))?;
    }
    fs::copy(
        inputs.join("lifecycle-fixture"),
        app.join("libexec/pilot-desktop"),
    )?;
    fs::copy(
        inputs.join("pilot-desktop-update-helper"),
        app.join("libexec/pilot-desktop-update-helper"),
    )?;
    fs::copy(node, app.join("runtime/node/bin/node"))?;
    fs::write(
        app.join("libexec/pilot-visual-worker"),
        b"inert fixture resource",
    )?;
    fs::write(app.join("bin/pilot-next"), b"inert fixture launcher")?;
    fs::write(
        app.join("runtime/packages/daemon/src/main.ts"),
        b"inert fixture main",
    )?;
    fs::write(
        app.join("runtime/packages/kernel/src/worker-entry.ts"),
        b"inert fixture kernel",
    )?;
    for name in [
        "libexec/pilot-desktop",
        "libexec/pilot-desktop-update-helper",
        "runtime/node/bin/node",
    ] {
        fs::set_permissions(app.join(name), fs::Permissions::from_mode(0o755))?;
    }
    fs::write(
        app.join("runtime/packages/daemon/src/runtime-owner.ts"),
        OWNER,
    )?;
    fs::write(
        app.join("runtime/packages/daemon/src/update-reservation.ts"),
        RESERVATION,
    )?;
    fs::write(
        app.join("runtime/packages/daemon/src/fixture-owner.ts"),
        NODE,
    )?;
    let stamp = json!({"schema":1,"source":"a".repeat(40),"version":short,"protocol":1,"platform":"linux","arch":"x64","node":"24.21.0"});
    fs::write(
        app.join("runtime/runtime-build.json"),
        serde_json::to_vec(&stamp)?,
    )?;
    fs::write(
        app.join("update-runtime-policy.json"),
        serde_json::to_vec(&json!({"schema":1,"accepted_capsules":accepted}))?,
    )?;
    for name in ["rust-inputs.json", "updater-inputs.json"] {
        fs::write(
            app.join(name),
            serde_json::to_vec(
                &json!({"tested_sha":"a".repeat(40),"target":"x86_64-unknown-linux-gnu","updater_configuration":{"schema":1,"mode":"configured","public_key":STANDARD.encode(trust.public_key),"repository":trust.repository,"application_id":trust.application_id,"build":build,"code_requirement":trust.code_requirement}}),
            )?,
        )?;
    }
    fs::write(
        app.join("runtime-inputs.json"),
        serde_json::to_vec(&json!({"source":"a".repeat(40),"target":"x86_64-unknown-linux-gnu"}))?,
    )?;
    let mut files = Vec::new();
    let mut pending = vec![app.to_owned()];
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(directory)? {
            let path = entry?.path();
            let name = path.strip_prefix(app)?.to_str().ok_or("path")?.to_owned();
            let meta = fs::metadata(&path)?;
            if meta.is_dir() {
                files.push(json!({"path":name,"kind":"directory","mode":meta.mode() & 0o7777}));
                pending.push(path);
            } else {
                files.push(json!({"path":name,"kind":"file","mode":meta.mode() & 0o7777,"bytes":meta.len(),"sha256":Sha256::digest(fs::read(path)?).iter().map(|byte| format!("{byte:02x}")).collect::<String>()}));
            }
        }
    }
    files.sort_by(|a, b| a["path"].as_str().cmp(&b["path"].as_str()));
    let raw = serde_json::to_vec(
        &json!({"schema":1,"kind":"linux-gui-distribution","source":"a".repeat(40),"target":"x86_64-unknown-linux-gnu","build":stamp,"bundle_build":build,"short_version":short,"application_id":trust.application_id,"bundled_launch":true,"installer":true,"updater":true,"native_visual_execution":false,"files":files}),
    )?;
    let key = Ed25519KeyPair::from_seed_unchecked(&[42; 32]).map_err(|_| "fixture key")?;
    fs::write(app.join("linux-gui-package.json"), &raw)?;
    fs::write(
        app.join("linux-gui-package.sig"),
        STANDARD.encode(key.sign(&raw).as_ref()),
    )?;
    NativePlatform
        .verify(app, trust, build, Some(short))
        .map_err(err)
}
impl Write for HashWriter<'_> {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        self.0.update(b);
        Ok(b.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
