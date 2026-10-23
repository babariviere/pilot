use super::*;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use ring::signature::{Ed25519KeyPair, KeyPair};
use sha2::{Digest, Sha256};
use std::{
    collections::VecDeque,
    fs::{self, File},
    io::{Cursor, Write},
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        use ring::rand::SecureRandom;
        let mut id = [0; 16];
        ring::rand::SystemRandom::new().fill(&mut id).unwrap();
        let path = std::env::temp_dir().join(format!("next-updater-test-{}", transport::hex(&id)));
        fs::create_dir(&path).unwrap();
        Self(path.canonicalize().unwrap())
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn key() -> Ed25519KeyPair {
    Ed25519KeyPair::from_seed_unchecked(&[42; 32]).unwrap()
}
fn trust() -> manifest::Trust {
    manifest::Trust {
        repository: "owner/private-repo".into(),
        application_id: "com.example.synthetic.next".into(),
        channel: "desktop-stable".into(),
        current_build: "100.1".into(),
        bundle_name: "Pilot Next.app".into(),
        public_key: key().public_key().as_ref().try_into().unwrap(),
        code_requirement: "identifier \"com.example.synthetic.next\"".into(),
    }
}
fn metadata(bytes: &[u8]) -> manifest::Manifest {
    let trust = trust();
    manifest::Manifest {
        schema: 1,
        application_id: trust.application_id,
        channel: trust.channel,
        platform: "macos".into(),
        architecture: "aarch64".into(),
        build: "101.1".into(),
        short_version: "0.1.1".into(),
        bundle_name: trust.bundle_name,
        archive_name: manifest::ARCHIVE_ASSET.into(),
        archive_asset_id: 12,
        archive_size: bytes.len() as u64,
        archive_sha256: transport::hex(&Sha256::digest(bytes)),
    }
}
fn envelope(manifest: &manifest::Manifest) -> Vec<u8> {
    let bytes = serde_json::to_vec(manifest).unwrap();
    serde_json::to_vec(&manifest::Envelope {
        signed: STANDARD.encode(&bytes),
        signature: STANDARD.encode(key().sign(&bytes).as_ref()),
    })
    .unwrap()
}
fn verified(bytes: &[u8]) -> manifest::VerifiedManifest {
    manifest::VerifiedManifest::parse(&envelope(&metadata(bytes)), &trust(), 12).unwrap()
}
fn access() -> transport::Access {
    transport::Access::from_approved_provider("synthetic-token".into()).unwrap()
}
fn zip_files(files: &[(&str, &[u8])]) -> Vec<u8> {
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (name, bytes) in files {
        writer
            .start_file(
                *name,
                zip::write::SimpleFileOptions::default().unix_permissions(0o644),
            )
            .unwrap();
        writer.write_all(bytes).unwrap();
    }
    writer.finish().unwrap().into_inner()
}
fn archive() -> Vec<u8> {
    zip_files(&[
        ("Pilot Next.app/Contents/build", b"101.1"),
        ("Pilot Next.app/Contents/id", b"com.example.synthetic.next"),
    ])
}
fn fixture_target(temp: &Temp) -> PathBuf {
    let target = temp.0.join("Pilot Next.app");
    fs::create_dir_all(target.join("Contents")).unwrap();
    fs::write(target.join("Contents/build"), "100.1").unwrap();
    fs::write(target.join("Contents/id"), trust().application_id).unwrap();
    target
}
#[derive(Default)]
struct FakePlatform {
    fail_swap: bool,
    fail_launch: bool,
}
impl installer::Platform for FakePlatform {
    fn verify(
        &self,
        path: &Path,
        trust: &manifest::Trust,
        build: &str,
        _: Option<&str>,
    ) -> Result<(), Error> {
        if fs::read_to_string(path.join("Contents/build"))
            .ok()
            .as_deref()
            == Some(build)
            && fs::read_to_string(path.join("Contents/id")).ok().as_deref()
                == Some(trust.application_id.as_str())
        {
            Ok(())
        } else {
            Err(Error::Signature)
        }
    }
    fn swap(&self, parent: &File, relative: &Path, target_name: &Path) -> Result<(), Error> {
        if self.fail_swap {
            return Err(Error::InstallFailed);
        }
        #[cfg(all(target_os = "macos", feature = "native-macos"))]
        {
            installer::Platform::swap(&installer::MacPlatform, parent, relative, target_name)
        }
        #[cfg(not(all(target_os = "macos", feature = "native-macos")))]
        {
            let _ = (parent, relative, target_name);
            Err(Error::Unconfigured)
        }
    }
    fn relaunch(&self, _: &Path, _: &Path) -> Result<(), Error> {
        if self.fail_launch {
            Err(Error::Native)
        } else {
            Ok(())
        }
    }
}
fn fixture_stage(temp: &Temp) -> installer::Staged {
    let target = fixture_target(temp);
    let bytes = archive();
    let manifest = verified(&bytes);
    let (root, lock) = installer::new_stage(&target, &trust(), &FakePlatform::default()).unwrap();
    fs::write(root.join("archive.zip"), &bytes).unwrap();
    installer::finish_stage(
        root,
        target,
        lock,
        manifest,
        &trust(),
        &FakePlatform::default(),
        &transport::Cancellation::default(),
    )
    .unwrap()
}

#[test]
fn signature_verifies_exact_bytes_and_key_not_a_nearby_checksum() {
    let bytes = archive();
    let encoded = envelope(&metadata(&bytes));
    assert!(manifest::VerifiedManifest::parse(&encoded, &trust(), 12).is_ok());
    let mut wrong = trust();
    wrong.public_key = [1; 32];
    assert!(matches!(
        manifest::VerifiedManifest::parse(&encoded, &wrong, 12),
        Err(Error::Signature)
    ));
    let mut tampered: manifest::Envelope = serde_json::from_slice(&encoded).unwrap();
    let mut payload = metadata(&bytes);
    payload.build = "999.1".into();
    tampered.signed = STANDARD.encode(serde_json::to_vec(&payload).unwrap());
    assert!(matches!(
        manifest::VerifiedManifest::parse(&serde_json::to_vec(&tampered).unwrap(), &trust(), 12),
        Err(Error::Signature)
    ));
}
#[test]
fn signed_wrong_identity_channel_target_asset_are_rejected() {
    for field in 0..7 {
        let mut manifest = metadata(&archive());
        match field {
            0 => manifest.application_id = "com.babariviere.pilot".into(),
            1 => manifest.channel = "beta".into(),
            2 => manifest.platform = "linux".into(),
            3 => manifest.architecture = "x86_64".into(),
            4 => manifest.archive_asset_id = 99,
            5 => manifest.archive_name = "Pilot-arm64.zip".into(),
            _ => manifest.bundle_name = "Pilot.app".into(),
        }
        assert!(matches!(
            manifest::VerifiedManifest::parse(&envelope(&manifest), &trust(), 12),
            Err(Error::Identity)
        ));
    }
}
#[test]
fn invalid_and_ambiguous_versions_and_duplicate_json_fail() {
    for value in ["", "-1", "1..2", "01.2", "1.2.3.4.5", "9999999999", "1beta"] {
        assert!(manifest::Build::parse(value).is_err());
    }
    assert!(manifest::Build::parse("9.9").unwrap() < manifest::Build::parse("10.0").unwrap());
    let malformed = br#"{"signed":"x","signed":"y","signature":"z"}"#;
    assert!(matches!(
        manifest::VerifiedManifest::parse(malformed, &trust(), 12),
        Err(Error::InvalidResponse)
    ));
    let mut older = metadata(&archive());
    older.build = "99.1".into();
    assert!(
        !manifest::VerifiedManifest::parse(&envelope(&older), &trust(), 12)
            .unwrap()
            .is_newer(&trust())
            .unwrap()
    );
}
#[test]
fn unconfigured_and_swift_trust_never_enable_updates() {
    let mut config = trust();
    config.public_key = [0; 32];
    assert_eq!(config.validate(), Err(Error::Unconfigured));
    config = trust();
    config.application_id = "com.babariviere.pilot".into();
    assert_eq!(config.validate(), Err(Error::Unconfigured));
    config = trust();
    config.repository = "../other".into();
    assert_eq!(config.validate(), Err(Error::Unconfigured));
    // Build defaults contain no production key/identity. No auth/files/installation fallback.
    if option_env!("PILOT_NEXT_UPDATER_PUBLIC_KEY").is_none() {
        assert!(matches!(helper::compiled_trust(), Err(Error::Unconfigured)));
    }
}

type Requests = Arc<Mutex<Vec<(String, Option<String>)>>>;
struct Faux {
    replies: Mutex<VecDeque<Result<transport::Reply, Error>>>,
    requests: Requests,
}
impl transport::Network for Faux {
    fn get(&self, url: &url::Url, token: Option<&str>) -> Result<transport::Reply, Error> {
        self.requests
            .lock()
            .unwrap()
            .push((url.as_str().into(), token.map(str::to_owned)));
        self.replies
            .lock()
            .unwrap()
            .pop_front()
            .expect("unexpected network request")
    }
}
fn reply(status: u16, location: Option<&str>, bytes: Vec<u8>) -> Result<transport::Reply, Error> {
    Ok(transport::Reply {
        status,
        location: location.map(str::to_owned),
        length: Some(bytes.len() as u64),
        body: Box::new(Cursor::new(bytes)),
    })
}
fn network(replies: Vec<Result<transport::Reply, Error>>) -> (transport::Transport, Requests) {
    let requests = Arc::new(Mutex::new(Vec::new()));
    (
        transport::Transport::synthetic(Faux {
            replies: Mutex::new(replies.into()),
            requests: requests.clone(),
        }),
        requests,
    )
}
fn release() -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({"draft":false,"prerelease":false,"tag_name":"desktop-v0.1.1","assets":[
    {"id":11,"name":manifest::MANIFEST_ASSET,"state":"uploaded"},{"id":12,"name":manifest::ARCHIVE_ASSET,"state":"uploaded"}]})).unwrap()
}

#[test]
fn private_api_redirects_strip_credentials_before_every_cdn_hop() {
    let bytes = archive();
    let signed = envelope(&metadata(&bytes));
    let (transport, requests) = network(vec![
        reply(200, None, release()),
        reply(
            302,
            Some("https://release-assets.githubusercontent.com/a?synthetic=1"),
            vec![],
        ),
        reply(
            307,
            Some("https://release-assets.githubusercontent.com/b?synthetic=2"),
            vec![],
        ),
        reply(200, None, signed),
    ]);
    assert!(
        transport
            .discover(&trust(), &access(), &Default::default())
            .unwrap()
            .is_some()
    );
    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 4);
    assert!(
        requests[..2]
            .iter()
            .all(|(_, token)| token.as_deref() == Some("synthetic-token"))
    );
    assert!(requests[2..].iter().all(|(_, token)| token.is_none()));
}
#[test]
fn redirect_to_unapproved_host_or_back_to_credential_origin_is_refused_before_request() {
    for destination in [
        "https://evil.invalid/x",
        "http://release-assets.githubusercontent.com/x",
        "https://api.github.com/repos/owner/private-repo/releases/assets/12",
        "https://user:pass@release-assets.githubusercontent.com/x",
    ] {
        let (transport, requests) = network(vec![
            reply(200, None, release()),
            reply(302, Some(destination), vec![]),
        ]);
        assert!(matches!(
            transport.discover(&trust(), &access(), &Default::default()),
            Err(Error::RedirectDenied)
        ));
        assert_eq!(requests.lock().unwrap().len(), 2);
    }
}
#[test]
fn network_offline_auth_metadata_bounds_and_cancellation_are_typed() {
    for (response, expected) in [
        (Err(Error::Offline), Error::Offline),
        (reply(401, None, vec![]), Error::Authentication),
        (reply(403, None, vec![]), Error::Authentication),
        (reply(404, None, vec![]), Error::Authentication),
        (
            reply(200, None, vec![b'x'; 1024 * 1024 + 1]),
            Error::InvalidResponse,
        ),
    ] {
        let (transport, _) = network(vec![response]);
        assert!(
            matches!(transport.discover(&trust(), &access(), &Default::default()), Err(error) if error == expected)
        );
    }
    let (transport, requests) = network(vec![]);
    let cancel = transport::Cancellation::default();
    cancel.cancel();
    assert!(matches!(
        transport.discover(&trust(), &access(), &cancel),
        Err(Error::Cancelled)
    ));
    assert!(requests.lock().unwrap().is_empty());
}
#[test]
fn signed_current_build_is_no_update_and_downgrade_is_an_error() {
    for (build, expected) in [("100.1", None), ("99.1", Some(Error::Version))] {
        let mut manifest = metadata(&archive());
        manifest.build = build.into();
        let (transport, _) = network(vec![
            reply(200, None, release()),
            reply(200, None, envelope(&manifest)),
        ]);
        match expected {
            None => assert!(
                transport
                    .discover(&trust(), &access(), &Default::default())
                    .unwrap()
                    .is_none()
            ),
            Some(expected) => assert!(
                matches!(transport.discover(&trust(),&access(),&Default::default()),Err(error) if error == expected)
            ),
        }
    }
}
#[test]
fn downloaded_archive_must_match_signed_size_and_digest_and_never_overwrites() {
    let temp = Temp::new();
    let bytes = archive();
    let signed = verified(&bytes);
    let path = temp.0.join("archive.zip");
    let (transport, _) = network(vec![reply(200, None, bytes.clone())]);
    transport
        .download(&signed, &trust(), &access(), &path, &Default::default())
        .unwrap();
    assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    transport::verify_archive(&path, &signed, &Default::default()).unwrap();
    fs::write(&path, b"tampered").unwrap();
    assert_eq!(
        transport::verify_archive(&path, &signed, &Default::default()),
        Err(Error::Signature)
    );
    let (transport, _) = network(vec![reply(200, None, bytes)]);
    assert_eq!(
        transport.download(&signed, &trust(), &access(), &path, &Default::default()),
        Err(Error::Filesystem)
    );
    assert_eq!(fs::read(&path).unwrap(), b"tampered");
}
#[test]
fn corrupt_and_truncated_download_never_survive_as_a_verified_artifact() {
    let temp = Temp::new();
    let bytes = archive();
    let signed = verified(&bytes);
    for payload in [vec![0; bytes.len()], bytes[..bytes.len() - 1].to_vec()] {
        let (transport, _) = network(vec![reply(200, None, payload)]);
        let path = temp.0.join("bad.zip");
        assert!(
            transport
                .download(&signed, &trust(), &access(), &path, &Default::default())
                .is_err()
        );
        assert!(!path.exists());
    }
}
#[test]
fn archive_traversal_other_bundle_and_duplicate_file_are_rejected() {
    for name in [
        "../outside",
        "/absolute",
        "Pilot.app/Contents/build",
        "Pilot Next.app/../outside",
        "Pilot Next.app/Contents/../../outside",
        "Pilot Next.app/Contents/bad\\name",
    ] {
        let temp = Temp::new();
        let path = temp.0.join("archive.zip");
        fs::write(&path, zip_files(&[(name, b"x")])).unwrap();
        assert!(
            archive::extract(
                &path,
                &temp.0.join("payload"),
                "Pilot Next.app",
                &Default::default()
            )
            .is_err()
        );
        assert!(!temp.0.join("outside").exists());
    }
}
#[test]
fn archive_symlinks_cannot_escape_or_redirect_extraction_writes() {
    let temp = Temp::new();
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    writer
        .add_symlink(
            "Pilot Next.app/Contents/link",
            "../../..",
            zip::write::SimpleFileOptions::default(),
        )
        .unwrap();
    writer
        .start_file(
            "Pilot Next.app/Contents/file",
            zip::write::SimpleFileOptions::default(),
        )
        .unwrap();
    writer.write_all(b"safe").unwrap();
    let path = temp.0.join("archive.zip");
    fs::write(&path, writer.finish().unwrap().into_inner()).unwrap();
    assert!(
        archive::extract(
            &path,
            &temp.0.join("payload"),
            "Pilot Next.app",
            &Default::default()
        )
        .is_err()
    );
}
#[test]
fn staging_keeps_installed_app_unchanged_and_holds_permanent_target_lock() {
    let temp = Temp::new();
    let staged = fixture_stage(&temp);
    assert_eq!(
        fs::read_to_string(staged.target.join("Contents/build")).unwrap(),
        "100.1"
    );
    assert_eq!(
        installer::recovery_phase(staged.root()).unwrap(),
        installer::Phase::Ready
    );
    assert!(matches!(
        installer::lock_target(&staged.target),
        Err(Error::Busy)
    ));
    assert_eq!(
        fs::metadata(staged.root()).unwrap().permissions().mode() & 0o777,
        0o700
    );
}
#[test]
fn ordinary_quit_eof_never_commits_or_replaces_the_bundle() {
    let temp = Temp::new();
    let staged = fixture_stage(&temp);
    let mut stream = Cursor::new(Vec::<u8>::new());
    assert!(helper::await_commit(&mut stream, &staged).is_err());
    assert_eq!(
        installer::recovery_phase(staged.root()).unwrap(),
        installer::Phase::Ready
    );
    assert_eq!(
        fs::read_to_string(staged.target.join("Contents/build")).unwrap(),
        "100.1"
    );
}
fn commit(staged: &installer::Staged) {
    let (mut parent, mut child) = std::os::unix::net::UnixStream::pair().unwrap();
    std::thread::scope(|scope| {
        scope.spawn(|| helper::await_commit(&mut child, staged).unwrap());
        use std::io::Read;
        let mut ready = [0; 6];
        parent.read_exact(&mut ready).unwrap();
        assert_eq!(&ready, b"READY\n");
        parent.write_all(b"COMMIT\n").unwrap();
        let mut ack = [0; 10];
        parent.read_exact(&mut ack).unwrap();
        assert_eq!(&ack, b"COMMITTED\n");
    });
}
#[test]
fn explicit_commit_is_durable_but_does_not_replace_a_living_parent() {
    let temp = Temp::new();
    let staged = fixture_stage(&temp);
    commit(&staged);
    assert_eq!(
        installer::recovery_phase(staged.root()).unwrap(),
        installer::Phase::Committed
    );
    assert_eq!(
        fs::read_to_string(staged.target.join("Contents/build")).unwrap(),
        "100.1"
    );
}
#[cfg(all(target_os = "macos", feature = "native-macos"))]
#[test]
fn native_atomic_swap_retains_old_bundle_and_requires_startup_ack() {
    let temp = Temp::new();
    let staged = fixture_stage(&temp);
    commit(&staged);
    staged
        .apply_after_exit(
            &trust(),
            &FakePlatform::default(),
            helper::ExitedParent::synthetic(),
        )
        .unwrap();
    assert_eq!(
        fs::read_to_string(staged.target.join("Contents/build")).unwrap(),
        "101.1"
    );
    assert_eq!(
        fs::read_to_string(
            staged
                .root
                .join("install-payload/Pilot Next.app/Contents/build")
        )
        .unwrap(),
        "100.1"
    );
    assert_eq!(
        installer::recovery_phase(staged.root()).unwrap(),
        installer::Phase::RelaunchRequested
    );
    installer::acknowledge_startup(
        staged.root(),
        "101.1",
        &trust(),
        &FakePlatform::default(),
        &staged.target,
    )
    .unwrap();
    assert_eq!(
        installer::recovery_phase(staged.root()).unwrap(),
        installer::Phase::StartupAcknowledged
    );
}
#[cfg(all(target_os = "macos", feature = "native-macos"))]
#[test]
fn failed_launch_retains_both_bundles_and_refuses_blind_second_swap() {
    let temp = Temp::new();
    let staged = fixture_stage(&temp);
    commit(&staged);
    assert_eq!(
        staged.apply_after_exit(
            &trust(),
            &FakePlatform {
                fail_launch: true,
                ..Default::default()
            },
            helper::ExitedParent::synthetic()
        ),
        Err(Error::RecoveryRequired)
    );
    assert_eq!(
        installer::recovery_phase(staged.root()).unwrap(),
        installer::Phase::RelaunchRequested
    );
    assert_eq!(
        staged.apply_after_exit(
            &trust(),
            &FakePlatform::default(),
            helper::ExitedParent::synthetic()
        ),
        Err(Error::RecoveryRequired)
    );
    assert!(
        staged
            .root
            .join("install-payload/Pilot Next.app/Contents/build")
            .exists()
    );
}
#[test]
fn failed_swap_and_post_stage_tampering_leave_installed_bundle_unchanged() {
    let temp = Temp::new();
    let staged = fixture_stage(&temp);
    commit(&staged);
    assert_eq!(
        staged.apply_after_exit(
            &trust(),
            &FakePlatform {
                fail_swap: true,
                ..Default::default()
            },
            helper::ExitedParent::synthetic()
        ),
        Err(Error::InstallFailed)
    );
    assert_eq!(
        fs::read_to_string(staged.target.join("Contents/build")).unwrap(),
        "100.1"
    );
    let temp = Temp::new();
    let staged = fixture_stage(&temp);
    commit(&staged);
    fs::write(staged.root.join("archive.zip"), b"tampered").unwrap();
    assert_eq!(
        staged.apply_after_exit(
            &trust(),
            &FakePlatform::default(),
            helper::ExitedParent::synthetic()
        ),
        Err(Error::Signature)
    );
}
#[cfg(target_os = "macos")]
#[test]
fn os_exit_monitor_observes_only_real_owned_child_exit_and_never_kills_it() {
    use std::process::{Command, Stdio};
    let mut child = Command::new("/bin/sh")
        .args(["-c", "read value"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let watch = helper::ParentWatch::new(child.id() as _).unwrap();
    assert!(matches!(
        watch.wait(Duration::ZERO),
        Err(Error::ParentStillRunning)
    ));
    let watch = helper::ParentWatch::new(child.id() as _).unwrap();
    drop(child.stdin.take());
    watch.wait(Duration::from_secs(5)).unwrap();
    child.wait().unwrap();
}

#[derive(Default)]
struct FauxBackend {
    checks: usize,
    downloads: usize,
    prepares: usize,
    commits: usize,
    cancels: usize,
    stops: usize,
}
impl Backend for FauxBackend {
    fn check(&mut self, _: u64, _: Trigger) -> Result<(), Error> {
        self.checks += 1;
        Ok(())
    }
    fn download(&mut self, _: u64, _: &Candidate) -> Result<(), Error> {
        self.downloads += 1;
        Ok(())
    }
    fn prepare_exit(&mut self, _: u64, _: Safety) -> Result<(), Error> {
        self.prepares += 1;
        Ok(())
    }
    fn commit_exit(&mut self, _: u64, _: Safety) -> Result<(), Error> {
        self.commits += 1;
        Ok(())
    }
    fn cancel(&mut self, _: u64) {
        self.cancels += 1;
    }
    fn teardown(&mut self) {
        self.stops += 1;
    }
}
fn safe() -> Safety {
    let flush = Flush {
        requested: 7,
        acknowledged: Some(7),
        failed: false,
    };
    Safety {
        drafts: flush,
        deliveries: flush,
        settings: flush,
        has_preedit: false,
        active_work: false,
        runtime: Runtime::Independent,
        admissions_fenced: true,
    }
}
fn done(operation: u64, outcome: Outcome) -> Completion {
    Completion { operation, outcome }
}
fn candidate() -> Candidate {
    Candidate {
        version: "101.1".into(),
    }
}
fn ready() -> Updater<FauxBackend> {
    let mut updater = Updater::new(FauxBackend::default(), true, Duration::ZERO);
    updater.check(Trigger::Manual, Duration::ZERO).unwrap();
    updater.complete(done(1, Outcome::Available(candidate())), Duration::ZERO);
    updater.download(Duration::ZERO).unwrap();
    updater.complete(done(2, Outcome::Staged(candidate())), Duration::ZERO);
    updater
}
#[test]
fn scheduler_is_hourly_single_flight_manual_and_backoff_bounded() {
    let mut updater = Updater::new(FauxBackend::default(), true, Duration::ZERO);
    assert!(updater.tick(Duration::ZERO).unwrap());
    assert_eq!(
        updater.check(Trigger::Manual, Duration::ZERO),
        Err(Error::Busy)
    );
    updater.complete(done(1, Outcome::Current), Duration::from_secs(1));
    assert_eq!(updater.next_deadline(), Some(Duration::from_secs(3601)));
    for (id, delay) in [60, 120, 240, 480, 960, 1920, 3600, 3600]
        .into_iter()
        .enumerate()
    {
        updater.check(Trigger::Manual, Duration::ZERO).unwrap();
        updater.complete(
            done(id as u64 + 2, Outcome::Failed(Error::Offline)),
            Duration::ZERO,
        );
        assert_eq!(updater.next_deadline(), Some(Duration::from_secs(delay)));
    }
    updater.set_automatic(false);
    assert!(!updater.tick(Duration::from_secs(9999)).unwrap());
    updater.check(Trigger::Manual, Duration::ZERO).unwrap();
}
#[test]
fn cancel_is_idempotent_and_single_flight_until_quiescent_ack() {
    let mut updater = Updater::new(FauxBackend::default(), true, Duration::ZERO);
    updater.check(Trigger::Manual, Duration::ZERO).unwrap();
    updater.cancel(Duration::ZERO).unwrap();
    updater.cancel(Duration::ZERO).unwrap();
    assert_eq!(updater.backend_mut().cancels, 1);
    assert_eq!(
        updater.check(Trigger::Manual, Duration::ZERO),
        Err(Error::Busy)
    );
    updater.complete(done(1, Outcome::Available(candidate())), Duration::ZERO);
    assert_eq!(updater.state(), &State::Cancelled);
    updater.check(Trigger::Manual, Duration::ZERO).unwrap();
    assert!(!updater.complete(done(1, Outcome::Current), Duration::ZERO));
}
#[test]
fn every_persistence_owner_needs_exact_fresh_successful_ack() {
    for index in 0..3 {
        for failed in [false, true] {
            let mut updater = ready();
            let mut safety = safe();
            let receipt = match index {
                0 => &mut safety.drafts,
                1 => &mut safety.deliveries,
                _ => &mut safety.settings,
            };
            receipt.acknowledged = Some(6);
            receipt.failed = failed;
            assert_eq!(
                updater.request_install(safety, Duration::ZERO),
                Err(if failed {
                    Error::PersistenceFailed
                } else {
                    Error::PersistencePending
                })
            );
            assert_eq!(updater.backend_mut().prepares, 0);
            updater.request_install(safe(), Duration::ZERO).unwrap();
            updater.complete(done(3, Outcome::ExitPrepared), Duration::ZERO);
            assert_eq!(
                updater.commit_exit(safety, Duration::ZERO),
                Err(if failed {
                    Error::PersistenceFailed
                } else {
                    Error::PersistencePending
                })
            );
            assert_eq!(updater.backend_mut().commits, 0);
        }
    }
}
#[test]
fn active_work_preedit_unknown_runtime_or_unfenced_input_defers() {
    for reason in [
        Error::Preedit,
        Error::ActiveWork,
        Error::RuntimeUnverified,
        Error::AdmissionsNotFenced,
    ] {
        let mut updater = ready();
        let mut safety = safe();
        match reason {
            Error::Preedit => safety.has_preedit = true,
            Error::ActiveWork => safety.active_work = true,
            Error::RuntimeUnverified => safety.runtime = Runtime::Unknown,
            _ => safety.admissions_fenced = false,
        };
        assert_eq!(updater.request_install(safety, Duration::ZERO), Err(reason));
        assert_eq!(updater.backend_mut().prepares, 0);
    }
    let mut safety = safe();
    safety.runtime = Runtime::SharedStopped {
        expected: 7,
        observed: 8,
    };
    assert_eq!(safety.validate(), Err(Error::RuntimeUnverified));
}
#[test]
fn explicit_two_phase_restart_never_quits_or_installs_from_scheduler() {
    let mut updater = ready();
    assert_eq!(updater.state(), &State::ReadyToRestart(candidate()));
    assert!(!updater.tick(Duration::from_secs(9999)).unwrap());
    assert_eq!(updater.backend_mut().prepares, 0);
    updater.request_install(safe(), Duration::ZERO).unwrap();
    updater.complete(done(3, Outcome::ExitPrepared), Duration::ZERO);
    updater.commit_exit(safe(), Duration::ZERO).unwrap();
    assert_eq!(updater.cancel(Duration::ZERO), Err(Error::Busy));
    updater.complete(done(4, Outcome::ExitCommitted), Duration::ZERO);
    assert_eq!(updater.state(), &State::ExitAuthorized);
    assert_eq!(updater.next_deadline(), None);
}
#[test]
fn uncertain_commit_requires_recovery_not_new_checks_or_false_success() {
    let mut updater = ready();
    updater.request_install(safe(), Duration::ZERO).unwrap();
    updater.complete(done(3, Outcome::ExitPrepared), Duration::ZERO);
    updater.commit_exit(safe(), Duration::ZERO).unwrap();
    updater.complete(
        done(4, Outcome::Failed(Error::CommitUncertain)),
        Duration::ZERO,
    );
    assert_eq!(
        updater.state(),
        &State::RecoveryRequired(Error::CommitUncertain)
    );
    assert_eq!(
        updater.check(Trigger::Manual, Duration::ZERO),
        Err(Error::Busy)
    );
    assert_eq!(updater.next_deadline(), None);
}
#[test]
fn teardown_never_arms_installation_or_accepts_late_results() {
    let mut updater = ready();
    updater.stop();
    updater.stop();
    assert_eq!(updater.backend_mut().stops, 1);
    assert!(!updater.complete(done(2, Outcome::Staged(candidate())), Duration::ZERO));
    assert_eq!(updater.backend_mut().commits, 0);
}

#[test]
fn writable_installation_parent_is_rejected_without_touching_target() {
    let temp = Temp::new();
    let target = fixture_target(&temp);
    fs::set_permissions(&temp.0, fs::Permissions::from_mode(0o777)).unwrap();
    assert!(matches!(
        installer::new_stage(&target, &trust(), &FakePlatform::default()),
        Err(Error::Filesystem)
    ));
    assert_eq!(
        fs::read_to_string(target.join("Contents/build")).unwrap(),
        "100.1"
    );
    fs::set_permissions(&temp.0, fs::Permissions::from_mode(0o700)).unwrap();
}

#[test]
fn target_inode_is_rechecked_after_long_signature_and_extraction_work() {
    use std::sync::atomic::{AtomicBool, Ordering};
    struct Substitute {
        target: PathBuf,
        changed: AtomicBool,
    }
    impl installer::Platform for Substitute {
        fn verify(
            &self,
            bundle: &Path,
            trust: &manifest::Trust,
            build: &str,
            short: Option<&str>,
        ) -> Result<(), Error> {
            installer::Platform::verify(&FakePlatform::default(), bundle, trust, build, short)?;
            if bundle.to_string_lossy().contains("install-payload")
                && !self.changed.swap(true, Ordering::SeqCst)
            {
                fs::rename(
                    &self.target,
                    self.target.parent().unwrap().join("original-retained.app"),
                )
                .unwrap();
                fs::create_dir_all(self.target.join("Contents")).unwrap();
                fs::write(self.target.join("Contents/build"), "100.1").unwrap();
                fs::write(self.target.join("Contents/id"), &trust.application_id).unwrap();
            }
            Ok(())
        }
        fn swap(&self, _: &File, _: &Path, _: &Path) -> Result<(), Error> {
            panic!("must reject substitution before swap")
        }
        fn relaunch(&self, _: &Path, _: &Path) -> Result<(), Error> {
            panic!("must not relaunch")
        }
    }
    let temp = Temp::new();
    let stage = fixture_stage(&temp);
    commit(&stage);
    let platform = Substitute {
        target: stage.target.clone(),
        changed: AtomicBool::new(false),
    };
    assert_eq!(
        stage.apply_after_exit(&trust(), &platform, helper::ExitedParent::synthetic()),
        Err(Error::RecoveryRequired)
    );
    assert_eq!(
        fs::read_to_string(stage.target.join("Contents/build")).unwrap(),
        "100.1"
    );
    assert!(temp.0.join("original-retained.app").exists());
}

#[cfg(all(target_os = "macos", feature = "native-macos"))]
#[test]
fn fast_startup_acknowledgement_is_never_overwritten_by_helper() {
    struct FastStartup;
    impl installer::Platform for FastStartup {
        fn verify(
            &self,
            bundle: &Path,
            trust: &manifest::Trust,
            build: &str,
            short: Option<&str>,
        ) -> Result<(), Error> {
            installer::Platform::verify(&FakePlatform::default(), bundle, trust, build, short)
        }
        fn swap(&self, parent: &File, relative: &Path, name: &Path) -> Result<(), Error> {
            installer::Platform::swap(&installer::MacPlatform, parent, relative, name)
        }
        fn relaunch(&self, app: &Path, transaction: &Path) -> Result<(), Error> {
            installer::acknowledge_startup(transaction, "101.1", &trust(), self, app)
        }
    }
    let temp = Temp::new();
    let stage = fixture_stage(&temp);
    commit(&stage);
    stage
        .apply_after_exit(&trust(), &FastStartup, helper::ExitedParent::synthetic())
        .unwrap();
    assert_eq!(
        installer::recovery_phase(stage.root()).unwrap(),
        installer::Phase::StartupAcknowledged
    );
    installer::acknowledge_startup(stage.root(), "101.1", &trust(), &FastStartup, &stage.target)
        .unwrap();
}

#[test]
fn helper_status_monitor_reports_abort_and_lost_ack_without_polling() {
    use std::sync::mpsc;
    for bytes in [
        b"ABORTED\n".as_slice(),
        b"COMMITTED\nABORTED\n".as_slice(),
        b"".as_slice(),
    ] {
        let (ack, receipt) = mpsc::sync_channel(1);
        let errors = Mutex::new(Vec::new());
        helper::watch_control(Cursor::new(bytes), ack, |error| {
            errors.lock().unwrap().push(error)
        });
        assert!(!errors.lock().unwrap().is_empty());
        assert!(receipt.try_recv().is_ok());
    }
}

#[test]
fn lost_commit_ack_does_not_undo_durable_intent() {
    struct BrokenAck {
        input: Cursor<Vec<u8>>,
        writes: usize,
    }
    impl std::io::Read for BrokenAck {
        fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
            std::io::Read::read(&mut self.input, bytes)
        }
    }
    impl Write for BrokenAck {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.writes += 1;
            if self.writes > 1 {
                Err(std::io::ErrorKind::BrokenPipe.into())
            } else {
                Ok(bytes.len())
            }
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let temp = Temp::new();
    let stage = fixture_stage(&temp);
    helper::await_commit(
        &mut BrokenAck {
            input: Cursor::new(b"COMMIT\n".to_vec()),
            writes: 0,
        },
        &stage,
    )
    .unwrap();
    assert_eq!(
        installer::recovery_phase(stage.root()).unwrap(),
        installer::Phase::Committed
    );
    assert_eq!(
        fs::read_to_string(stage.target.join("Contents/build")).unwrap(),
        "100.1"
    );
}

#[test]
fn helper_expiry_and_death_cannot_leave_false_ready_or_authorized_status() {
    let mut updater = ready();
    updater.request_install(safe(), Duration::ZERO).unwrap();
    updater.complete(done(3, Outcome::ExitPrepared), Duration::ZERO);
    assert!(updater.complete(
        done(3, Outcome::HelperStopped(Error::Cancelled)),
        Duration::ZERO
    ));
    assert!(matches!(
        updater.state(),
        State::Deferred {
            reason: Error::Cancelled,
            ..
        }
    ));
    let mut updater = ready();
    updater.request_install(safe(), Duration::ZERO).unwrap();
    updater.complete(done(3, Outcome::ExitPrepared), Duration::ZERO);
    updater.commit_exit(safe(), Duration::ZERO).unwrap();
    updater.complete(done(4, Outcome::ExitCommitted), Duration::ZERO);
    assert!(!updater.complete(
        done(99, Outcome::HelperStopped(Error::Cancelled)),
        Duration::ZERO
    ));
    updater.complete(
        done(3, Outcome::HelperStopped(Error::Cancelled)),
        Duration::ZERO,
    );
    assert_eq!(updater.state(), &State::RecoveryRequired(Error::Cancelled));
}

#[test]
fn stopped_is_terminal_even_for_a_captured_helper_death_event() {
    let mut updater = ready();
    updater.request_install(safe(), Duration::ZERO).unwrap();
    updater.complete(done(3, Outcome::ExitPrepared), Duration::ZERO);
    updater.stop();
    assert!(!updater.complete(
        done(3, Outcome::HelperStopped(Error::Cancelled)),
        Duration::ZERO
    ));
    assert_eq!(updater.state(), &State::Stopped);
}

#[cfg(all(target_os = "macos", feature = "native-macos"))]
#[test]
fn macos_acl_write_grants_are_refused_even_with_safe_posix_mode() {
    let temp = Temp::new();
    let target = fixture_target(&temp);
    fs::set_permissions(&temp.0, fs::Permissions::from_mode(0o755)).unwrap();
    helper::run_command(
        std::process::Command::new("/bin/chmod")
            .args([
                "+a",
                "everyone allow add_file,delete_child,writeattr,writeextattr",
            ])
            .arg(&temp.0),
        Duration::from_secs(5),
    )
    .unwrap();
    assert_eq!(
        fs::metadata(&temp.0).unwrap().permissions().mode() & 0o777,
        0o755
    );
    assert!(matches!(
        installer::new_stage(&target, &trust(), &FakePlatform::default()),
        Err(Error::Filesystem)
    ));
    assert_eq!(
        fs::read_to_string(target.join("Contents/build")).unwrap(),
        "100.1"
    );
    helper::run_command(
        std::process::Command::new("/bin/chmod")
            .arg("-N")
            .arg(&temp.0),
        Duration::from_secs(5),
    )
    .unwrap();
}

#[cfg(all(target_os = "macos", feature = "native-macos"))]
#[test]
fn nested_installed_file_acl_cannot_race_verified_helper_or_bundle_contents() {
    let temp = Temp::new();
    let target = fixture_target(&temp);
    let nested = target.join("Contents/build");
    helper::run_command(
        std::process::Command::new("/bin/chmod")
            .args(["+a", "everyone allow write,writeattr,writeextattr"])
            .arg(&nested),
        Duration::from_secs(5),
    )
    .unwrap();
    assert!(matches!(
        installer::new_stage(&target, &trust(), &FakePlatform::default()),
        Err(Error::Filesystem)
    ));
    helper::run_command(
        std::process::Command::new("/bin/chmod")
            .arg("-N")
            .arg(nested),
        Duration::from_secs(5),
    )
    .unwrap();
}

#[cfg(all(target_os = "macos", feature = "native-macos"))]
#[test]
fn newly_created_private_stage_strips_inherited_acl_grants() {
    let temp = Temp::new();
    let target = fixture_target(&temp);
    helper::run_command(std::process::Command::new("/bin/chmod").args(["+a", "everyone allow read,readattr,readextattr,readsecurity,search,file_inherit,directory_inherit"]).arg(&temp.0), Duration::from_secs(5)).unwrap();
    let (root, _lock) = installer::new_stage(&target, &trust(), &FakePlatform::default()).unwrap();
    installer::acl_policy(&root, 2).unwrap();
    assert_eq!(
        fs::metadata(&root).unwrap().permissions().mode() & 0o777,
        0o700
    );
    helper::run_command(
        std::process::Command::new("/bin/chmod")
            .arg("-N")
            .arg(&temp.0),
        Duration::from_secs(5),
    )
    .unwrap();
}

#[cfg(all(target_os = "macos", feature = "native-macos"))]
#[test]
fn existing_object_without_extended_acl_is_not_a_missing_path() {
    let temp = Temp::new();
    installer::acl_policy(&temp.0, 0).unwrap();
    installer::acl_policy(&temp.0, 2).unwrap();
    assert_eq!(
        installer::acl_policy(&temp.0.join("missing"), 0),
        Err(Error::Filesystem)
    );
}

#[cfg(all(target_os = "macos", feature = "native-macos"))]
fn signed_bundle(root: &Path, build: &str) -> PathBuf {
    let app = root.join("Pilot Next.app");
    fs::create_dir_all(app.join("Contents/MacOS")).unwrap();
    fs::copy("/usr/bin/true", app.join("Contents/MacOS/updater-fixture")).unwrap();
    let info = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.example.synthetic.next</string><key>CFBundleExecutable</key><string>updater-fixture</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>{build}</string><key>CFBundleShortVersionString</key><string>0.1.1</string></dict></plist>"#
    );
    fs::write(app.join("Contents/Info.plist"), info).unwrap();
    helper::run_command(
        std::process::Command::new("/usr/bin/codesign")
            .args([
                "--force",
                "--sign",
                "-",
                "--identifier",
                "com.example.synthetic.next",
            ])
            .arg(&app),
        Duration::from_secs(15),
    )
    .unwrap();
    app
}
#[cfg(all(target_os = "macos", feature = "native-macos"))]
#[test]
fn actual_security_framework_validates_whole_temporary_bundle_identity_version_and_tampering() {
    use installer::Platform;
    let temp = Temp::new();
    let app = signed_bundle(&temp.0, "101.1");
    installer::MacPlatform
        .verify(&app, &trust(), "101.1", Some("0.1.1"))
        .unwrap();
    assert_eq!(
        installer::MacPlatform.verify(&app, &trust(), "999.1", Some("0.1.1")),
        Err(Error::Signature)
    );
    let mut other = trust();
    other.application_id = "com.example.other".into();
    assert_eq!(
        installer::MacPlatform.verify(&app, &other, "101.1", None),
        Err(Error::Signature)
    );
    let mut wrong_team = trust();
    wrong_team.code_requirement = "identifier \"com.example.synthetic.next\" and certificate leaf[subject.OU] = \"WRONGTEAM\"".into();
    assert_eq!(
        installer::MacPlatform.verify(&app, &wrong_team, "101.1", None),
        Err(Error::Signature)
    );
    fs::write(
        app.join("Contents/MacOS/updater-fixture"),
        b"tampered executable",
    )
    .unwrap();
    assert_eq!(
        installer::MacPlatform.verify(&app, &trust(), "101.1", Some("0.1.1")),
        Err(Error::Signature)
    );
}
