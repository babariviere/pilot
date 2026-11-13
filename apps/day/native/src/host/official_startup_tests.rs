use super::*;
use crate::{
    host::{Source, journal::Journal, updates::State},
    update::{SavedView, UpdatePhase},
};
use pilot_desktop_updater::{app_update::Connection, coordination::Location, manifest::Trust};
use std::{
    fs::File,
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};

#[derive(Clone, Default)]
struct Signature {
    calls: Arc<AtomicUsize>,
    reject: bool,
}
impl Platform for Signature {
    fn verify(
        &self,
        _: &Path,
        _: &Trust,
        _: &str,
        _: Option<&str>,
    ) -> Result<(), pilot_desktop_updater::Error> {
        unreachable!("the candidate including its exact source must be checked")
    }
    fn verify_candidate(
        &self,
        _: &Path,
        trust: &Trust,
        manifest: &Manifest,
    ) -> Result<(), pilot_desktop_updater::Error> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        assert_eq!(trust.current_build, manifest.build);
        assert_eq!(
            manifest.source.as_deref(),
            Some("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
        );
        if self.reject {
            Err(pilot_desktop_updater::Error::Identity)
        } else {
            Ok(())
        }
    }
    fn swap(&self, _: &File, _: &Path, _: &Path) -> Result<(), pilot_desktop_updater::Error> {
        panic!("startup must not install")
    }
    fn relaunch(&self, _: &Path, _: &Path) -> Result<(), pilot_desktop_updater::Error> {
        panic!("startup must not restart")
    }
}

struct Temp(std::path::PathBuf);
impl Temp {
    fn path(&self) -> &Path {
        &self.0
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

struct Fixture {
    selection: Selection,
    source: Source,
    record: Record,
    capture: SavedWindow,
    journal: Journal,
    _dir: Temp,
}
impl Fixture {
    fn new(force: bool) -> Self {
        let dir =
            Temp(std::env::temp_dir().join(format!("official-startup-{}", uuid::Uuid::new_v4())));
        std::fs::create_dir(dir.path()).unwrap();
        let app = dir.path().join("Pilot Next.app");
        std::fs::create_dir(&app).unwrap();
        std::fs::write(app.join("signed-image"), b"exact native image").unwrap();
        let source = Source {
            profile: dir.path().into(),
            port: 1,
            home: crate::contract::Home {
                daemon_id: "daemon".into(),
                lineage_id: "lineage".into(),
            },
            project_id: "project".into(),
            project_path: dir.path().to_str().unwrap().into(),
        };
        let selection = Selection {
            connection: Connection::new(
                Location {
                    home: source.profile.clone(),
                    port: 1,
                    policy: Default::default(),
                },
                "daemon".into(),
                "lineage".into(),
            ),
            trust: Trust {
                repository: "example/app".into(),
                application_id: "com.example.next".into(),
                channel: "desktop-stable".into(),
                current_build: "2.0".into(),
                bundle_name: "Pilot Next.app".into(),
                public_key: [19; 32],
                code_requirement: "identifier com.example.next".into(),
            },
            installed: app.clone(),
            capsule: None,
            binding: None,
            app: None,
            restore_transaction: None,
            official: None,
        };
        let id = uuid::Uuid::new_v4().to_string();
        let capture = SavedWindow {
            kind: "window-capture".into(),
            version: 1,
            source: source.clone(),
            window: uuid::Uuid::new_v4().to_string(),
            generation: 7,
            save_sequence: 3,
            view: serde_json::to_value(SavedView {
                goal: " exact unsent 👩🏽‍💻\n".into(),
                ..Default::default()
            })
            .unwrap(),
        };
        let target = json!({"source":"a".repeat(40),"build":"2.0","version":"2.0.0","sha256":"b".repeat(64),"size":100,"configHash":"c".repeat(64)});
        let replacement = json!({"runtimeRoot":app.join(pilot_desktop_updater::layout::RUNTIME),"build":{"source":"a".repeat(40)}});
        let loss = super::super::update_loss::Record {
            loss_version: 1,
            operation: id.clone(),
            confirmation: id.clone(),
            source: source.clone(),
            window: capture.window.clone(),
            target: target.clone(),
            closed: true,
        };
        let mut payload =
            json!({"app":{"source":"a".repeat(40),"build":"2.0"},"replacement":replacement});
        if force {
            payload["acceptedLoss"] = loss.payload();
        } else {
            payload["captureHash"] = digest(&serde_json::to_vec(&capture).unwrap()).into();
        }
        let raw = payload.to_string();
        let home = json!({"hostId":"daemon","daemonId":"daemon","lineageId":"lineage"});
        let operation = json!({"schemaVersion":1,"operationId":id,"producerId":id,"sequence":1,"kind":"global-update-prepare","targetId":"global-update","origin":home,"destination":home,"payloadHash":digest(raw.as_bytes()),"payload":raw});
        let mut root = json!({"officialNsh":target,"preparation":operation,"rollback":{"key":selection.trust.public_key.to_vec(),"requirement":selection.trust.code_requirement}});
        if force {
            root["loss"] = serde_json::to_value(&loss).unwrap();
        }
        let manifest = json!({"phase":"restart-entered","receipt":{"state":"accepted","operationId":id,"payloadHash":operation["payloadHash"],"destination":home,"targetId":"global-update","result":{"target":payload}},
            "service":{"role":"successor","runtime":replacement,"app":{"app":app,"source":"a".repeat(40),"guiBuild":"2.0","identity":pilot_desktop_updater::runtime::identity(&app).unwrap(),"replacement":replacement}}});
        let mut record = Record {
            order: 1,
            update_version: if force { 2 } else { 1 },
            id,
            source: source.clone(),
            root: root.clone(),
            window: capture.window.clone(),
            kind: "app".into(),
            target: "2.0".into(),
            view: if force {
                Value::Null
            } else {
                capture.view.clone()
            },
            auth: digest(&serde_json::to_vec(&root).unwrap()),
            revision: 1,
            state: "capture".into(),
            flush: if force { None } else { Some((7, 3)) },
            message: "Install and restart not yet acknowledged.".into(),
            restored: false,
            manifest: Some(manifest),
        };
        let mut journal = Journal::open(dir.path().join("journal")).unwrap();
        if force {
            let mut open = loss.clone();
            open.closed = false;
            journal.save_loss(open).unwrap();
            journal.save_loss(loss).unwrap();
        } else {
            journal.save_window(capture.clone()).unwrap();
        }
        journal.save_update(record.clone()).unwrap();
        record.state = "entered".into();
        record.revision += 1;
        journal.save_update(record.clone()).unwrap();
        record.state = "prepared".into();
        record.revision += 1;
        journal.save_update(record.clone()).unwrap();
        Self {
            _dir: dir,
            selection,
            source,
            record,
            capture,
            journal,
        }
    }
    fn restore(&self, signature: Signature) -> State {
        let mut state = State::new(Some(self.selection.clone()));
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(state.restore_with(&self.journal, &self.source, signature));
        state
    }
}

#[test]
fn official_normal_restart_restores_exact_window_without_legacy_transaction_or_execution() {
    let mut f = Fixture::new(false);
    f.selection.official = Some(Default::default());
    let signature = Signature::default();
    let mut state = f.restore(signature.clone());
    let view = state.snapshot();
    assert_eq!(
        view.restore.as_ref().unwrap().view.goal,
        " exact unsent 👩🏽‍💻\n"
    );
    assert_eq!(view.run.unwrap().phase, UpdatePhase::Unknown);
    assert!(
        !state.startup_ready(),
        "retained bytes are not a fresh display ACK"
    );
    assert!(
        state
            .displayed(&mut f.journal, &f.source, "old-operation")
            .is_err()
    );
    state
        .displayed(&mut f.journal, &f.source, &f.record.id)
        .unwrap();
    assert!(state.startup_ready());
    assert!(
        state
            .displayed(&mut f.journal, &f.source, &f.record.id)
            .is_err()
    );
    let displayed = f.journal.updates[&f.record.id].clone();
    verify_with(&f.selection, &displayed, &signature).unwrap();
    let observed = observe(&mut f.journal, displayed).unwrap();
    assert_eq!(observed.state, "startup");
    assert_eq!(observed.root, f.record.root);
    let revision = observed.revision;
    assert_eq!(
        observe(&mut f.journal, observed).unwrap().revision,
        revision
    );
    let state = f.restore(signature.clone());
    assert!(
        state.snapshot().restore.is_some(),
        "a cold successor needs its own display"
    );
    assert!(
        !state.startup_ready(),
        "a durable observation is never sent again"
    );
    assert_eq!(state.snapshot().run.unwrap().phase, UpdatePhase::Unknown);
    assert!(signature.calls.load(Ordering::SeqCst) >= 3);
}

#[test]
fn force_startup_observes_target_but_never_fakes_a_saved_view_or_resume() {
    let mut f = Fixture::new(true);
    f.selection.official = Some(Default::default());
    let mut state = f.restore(Signature::default());
    assert!(state.snapshot().restore.is_none());
    let run = state.snapshot().run.unwrap();
    assert_eq!(run.phase, UpdatePhase::Unknown);
    assert!(
        run.message
            .contains("signed Force target was observed at startup")
    );
    assert!(!state.startup_ready());
    assert!(
        state
            .displayed(&mut f.journal, &f.source, &f.record.id)
            .is_err()
    );
    assert!(observe(&mut f.journal, f.record.clone()).is_err());
    assert_eq!(f.journal.updates[&f.record.id], f.record);
    assert!(f.journal.windows.is_empty());
}

#[test]
fn signature_or_same_build_changed_bytes_refuses_restore_and_startup() {
    let f = Fixture::new(false);
    assert!(
        f.restore(Signature {
            reject: true,
            ..Default::default()
        })
        .snapshot()
        .restore
        .is_none()
    );
    assert!(
        verify(&f.selection, &f.record).is_err(),
        "fixture paths never replace genuine native code-seal verification"
    );
    std::fs::write(
        f.selection.installed.join("signed-image"),
        b"changed bytes with same build",
    )
    .unwrap();
    assert!(f.restore(Signature::default()).snapshot().restore.is_none());
}

#[test]
fn stale_target_source_preparation_receipt_and_incomplete_install_are_lookup_only() {
    let f = Fixture::new(false);
    for change in 0..13 {
        let mut selection = f.selection.clone();
        let mut r = f.record.clone();
        match change {
            0 => selection.trust.current_build = "3.0".into(),
            1 => {
                selection.connection = Connection::new(
                    Location {
                        home: selection.connection.location().home.clone(),
                        port: 2,
                        policy: Default::default(),
                    },
                    "daemon".into(),
                    "lineage".into(),
                )
            }
            2 => r.root["preparation"]["payloadHash"] = "d".repeat(64).into(),
            3 => r.manifest.as_mut().unwrap()["phase"] = "install-entered".into(),
            4 => r.manifest.as_mut().unwrap()["receipt"]["state"] = "unknown".into(),
            5 => r.manifest.as_mut().unwrap()["receipt"]["operationId"] = "other".into(),
            6 => r.manifest.as_mut().unwrap()["service"]["role"] = "rollback".into(),
            7 => r.manifest.as_mut().unwrap()["service"]["app"]["identity"] = "d".repeat(64).into(),
            8 => r.root["rollback"]["key"] = json!(vec![0_u8; 32]),
            9 => selection.restore_transaction = Some(f._dir.path().join("legacy")),
            10 => r.root["officialNsh"]["unexpected"] = true.into(),
            11 => r.root["preparation"]["origin"]["daemonId"] = "other".into(),
            _ => r.root["officialNsh"]["source"] = "e".repeat(40).into(),
        }
        r.auth = digest(&serde_json::to_vec(&r.root).unwrap());
        assert!(
            verify_with(&selection, &r, &Signature::default()).is_err(),
            "mismatch {change}"
        );
    }
}

#[test]
fn newer_capture_prevents_rewinding_and_lost_observation_ack_never_reenters() {
    let mut f = Fixture::new(false);
    let mut newer = f.capture.clone();
    newer.save_sequence += 1;
    newer.view["goal"] = "newer unsent bytes".into();
    f.journal.save_window(newer).unwrap();
    assert!(f.restore(Signature::default()).snapshot().restore.is_none());
    let mut f = Fixture::new(false);
    let mut state = f.restore(Signature::default());
    state
        .displayed(&mut f.journal, &f.source, &f.record.id)
        .unwrap();
    let displayed = f.journal.updates[&f.record.id].clone();
    verify_with(&f.selection, &displayed, &Signature::default()).unwrap();
    f.journal.fail_after_sync = true;
    assert_eq!(observe(&mut f.journal, displayed), Err(Error::Storage));
    let path = f.journal.path().to_path_buf();
    drop(f.journal);
    f.journal = Journal::open(path).unwrap();
    assert_eq!(f.journal.updates[&f.record.id].state, "startup");
    assert!(!f.restore(Signature::default()).startup_ready());
}

#[cfg(target_os = "macos")]
#[test]
fn real_native_root_exit_and_empty_group_do_not_prove_descendant_exit() {
    use std::{
        io::{Read, Write},
        os::{
            fd::OwnedFd,
            unix::{net::UnixStream, process::CommandExt},
        },
        process::{Command, Stdio},
        time::Duration,
    };
    // A disposable single-threaded process forks an owned child, which leaves
    // the original group/session and closes the parent's output pipe. The
    // retained private control socket bounds cleanup, not an update proof.
    let (mut control, child) = UnixStream::pair().unwrap();
    control
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let mut root = Command::new("/usr/bin/python3")
        .env_clear()
        .args([
            "-I",
            "-c",
            r#"
import os, select
child = os.fork()
if child:
    os._exit(0)
os.setsid()
os.write(1, (str(os.getpid()) + '\n').encode())
os.close(1)
if select.select([0], [], [], 10)[0] and os.read(0, 1) == b'X':
    os.write(0, b'alive')
os._exit(0)
"#,
        ])
        .stdin(Stdio::from(OwnedFd::from(child)))
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()
        .unwrap();
    let root_pid = i32::try_from(root.id()).unwrap();
    let mut output = String::new();
    root.stdout
        .take()
        .unwrap()
        .read_to_string(&mut output)
        .unwrap();
    assert!(root.wait().unwrap().success());
    let descendant: i32 = output.trim().parse().unwrap();
    // SAFETY: signal 0 and getpgid only inspect this fixture's exact groups.
    // No signal is sent and no unrelated process is canceled.
    assert_eq!(unsafe { libc::kill(-root_pid, 0) }, -1);
    assert_eq!(
        std::io::Error::last_os_error().raw_os_error(),
        Some(libc::ESRCH)
    );
    assert_eq!(unsafe { libc::getpgid(descendant) }, descendant);
    control.write_all(b"X").unwrap();
    let mut alive = [0; 5];
    control.read_exact(&mut alive).unwrap();
    assert_eq!(
        &alive, b"alive",
        "the escaped child executed after root wait and output EOF"
    );
    // Child exits after the reply; dropping control also unblocks it on panic.
}
