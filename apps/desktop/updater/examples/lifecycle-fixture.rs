//! Real macOS helper/OS-exit/swap/startup qualification with synthetic identity,
//! temporary signed bundles and an owned Node using the actual proof/reservation
//! source. Not a GUI, production bundle or OS acceptance test.
use base64::{Engine as _, engine::general_purpose::STANDARD};
use pilot_desktop_updater::{
    coordination::{Guard, Location},
    helper,
    installer::{self, MacPlatform, Platform},
    manifest::{self, Trust, VerifiedManifest},
    runtime,
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
import {realpath,writeFile,readFile} from 'node:fs/promises';
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
const gate=new UpdateReservation({freezeAdmissions(){if(frozen)throw Error('busy');frozen=true;return()=>{frozen=false;};},async blockers(){return [];}},clock);
owner.updates(async(action,receipt)=>{if(action==='inspect')return receipt;if(action==='prepare')return gate.prepare(receipt.operationId);if(action==='cancel'){gate.cancel(receipt);return receipt;}return gate.verify(receipt);});
owner.ready({daemonId,lineageId,daemonVersion:build.version,protocolVersion:1,minimumClientProtocolVersion:1,platform:build.platform,arch:build.arch,capabilities:{independentExecution:true}});
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
fn run(args: Vec<String>) -> Result<()> {
    let trust = trust()?;
    if args.len() == 2 && args[0] == "--updater-receipt" {
        let executable = std::env::current_exe()?;
        let target = executable
            .ancestors()
            .nth(3)
            .ok_or("app root")?
            .canonicalize()?;
        let root = safe_root(
            target
                .parent()
                .and_then(Path::parent)
                .ok_or("fixture parent")?,
        )?;
        let transaction = PathBuf::from(&args[1]);
        if !transaction.starts_with(&root) {
            return Err("receipt escaped fixture".into());
        }
        Guard::acknowledge_startup(&transaction, &target, &trust).map_err(err)?;
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
            .nth(3)
            .ok_or("parent bundle")?
            .canonicalize()?;
        if !target.starts_with(&root) {
            return Err("parent escaped fixture".into());
        }
        let manifest: VerifiedManifest =
            VerifiedManifest::parse(&fs::read(root.join("envelope.json"))?, &trust, 12)
                .map_err(err)?;
        let (stage, lock) = installer::new_stage(&target, &trust, &MacPlatform).map_err(err)?;
        fs::copy(root.join("archive.zip"), stage.join("archive.zip"))?;
        let staged = installer::finish_stage(
            stage.clone(),
            target.clone(),
            lock,
            manifest,
            &trust,
            &MacPlatform,
            &Cancellation::default(),
        )
        .map_err(err)?;
        let guard = Guard::prepare(
            location,
            &stage.join("payload/Pilot Next.app"),
            &stage,
            staged.build(),
            &trust,
        )
        .map_err(err)?;
        guard.save().map_err(err)?;
        fs::write(
            root.join("transaction"),
            stage.as_os_str().as_encoded_bytes(),
        )?;
        let mut prepared = helper::PreparedExit::launch(&staged, |_| {}).map_err(err)?;
        if args[2] == "cancel" {
            drop(prepared);
            guard.cancel();
            return Ok(());
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
        // Actual process exit, not a forged ExitedParent fixture token.
        std::process::exit(0);
    }
    if args.len() != 4
        || !matches!(
            args[0].as_str(),
            "--verify" | "--verify-cancel" | "--verify-expired"
        )
        || trust.current_build != "100.1"
    {
        return Err("Use --verify TEMP_ROOT INPUTS NODE with synthetic old-build trust".into());
    }
    let mode = match args[0].as_str() {
        "--verify-cancel" => "cancel",
        "--verify-expired" => "expired",
        _ => "success",
    };
    let root = safe_root(Path::new(&args[1]))?;
    let inputs = Path::new(&args[2]).canonicalize()?;
    let node = Path::new(&args[3]).canonicalize()?;
    let installed = root.join("Installed");
    fs::create_dir(&installed)?;
    let old = installed.join("Pilot Next.app");
    bundle(
        &old,
        &inputs.join("old"),
        &node,
        "100.1",
        "0.1.0",
        &[],
        &trust,
    )?;
    let capsule = runtime::publish(&old, &root.join(runtime::STORE_NAME), &trust, &MacPlatform)
        .map_err(err)?;
    let id = runtime::identity(&capsule).map_err(err)?;
    let new_parent = root.join("Candidate");
    fs::create_dir(&new_parent)?;
    let candidate = new_parent.join("Pilot Next.app");
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
    let mut process = Command::new(capsule.join("Contents/Resources/runtime/node/bin/node"));
    process
        .arg(capsule.join("Contents/Resources/runtime/packages/daemon/src/fixture-owner.ts"))
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
    let original = fs::read(location.home.join(".daemon-owner.json"))?;
    let mut parent = Owned(
        Command::new(old.join("Contents/MacOS/pilot-desktop"))
            .arg("--owned-parent")
            .arg(&root)
            .arg(mode)
            .env_clear()
            .env("HOME", &root)
            .env("PATH", "/usr/bin:/bin")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()?,
    );
    wait_exit(&mut parent.0, Duration::from_secs(90))?;
    if mode != "success" {
        let transaction = PathBuf::from(String::from_utf8(fs::read(root.join("transaction"))?)?);
        std::thread::sleep(Duration::from_secs(2));
        MacPlatform
            .verify(&old, &trust, "100.1", Some("0.1.0"))
            .map_err(err)?;
        let expected = if mode == "cancel" {
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
            || runtime::identity(&capsule).map_err(err)? != id
        {
            return Err("fixture refusal changed runtime".into());
        }
        println!(
            "PASS real native helper {mode} preserves installed app, existing daemon and truthful journal"
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
    if runtime::identity(&capsule).map_err(err)? != id {
        return Err("active capsule changed".into());
    }
    if !transaction.join("install-payload/Pilot Next.app").is_dir() {
        return Err("old app not retained".into());
    }
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
    MacPlatform
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
            "Pilot Next.app/{}",
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
        application_id: trust.application_id.clone(),
        channel: trust.channel.clone(),
        platform: "macos".into(),
        architecture: "aarch64".into(),
        build: "101.1".into(),
        short_version: "0.1.1".into(),
        bundle_name: trust.bundle_name.clone(),
        archive_name: manifest::ARCHIVE_ASSET.into(),
        archive_asset_id: 12,
        archive_size: fs::metadata(archive)?.len(),
        archive_sha256: format!("{:x}", hash.finalize()),
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
impl Write for HashWriter<'_> {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        self.0.update(b);
        Ok(b.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
