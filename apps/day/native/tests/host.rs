//! Real daemon HTTP/WS, native Rust transport and private on-disk journal.
use pilot_day_native::{
    host::{Error, NativeHost, Source},
    model::{Delivery, FreshnessState, MissionRow, OutcomeStatus, Today},
};
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::mpsc,
    time::Duration,
};

struct Fixture {
    child: Child,
    input: ChildStdin,
    output: mpsc::Receiver<Value>,
    info: Value,
}
impl Fixture {
    fn new() -> Self {
        let script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../packages/daemon/src/fixtures/day-native-host.ts");
        let mut child = Command::new("node")
            .arg(script)
            .env_remove("PILOT_HOME")
            .env_remove("PILOT_PORT")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("node fixture starts");
        let input = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let (tx, output) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else {
                    break;
                };
                if let Ok(value) = serde_json::from_str::<Value>(&line)
                    && tx.send(value).is_err()
                {
                    break;
                }
            }
        });
        let info = output
            .recv_timeout(Duration::from_secs(20))
            .expect("fixture ready");
        Self {
            child,
            input,
            output,
            info,
        }
    }
    fn cmd(&mut self, action: &str, value: bool) -> Value {
        writeln!(self.input, "{}", json!({"action":action,"value":value})).unwrap();
        self.input.flush().unwrap();
        self.output
            .recv_timeout(Duration::from_secs(20))
            .expect("fixture reply")
    }
    fn source(&self) -> Source {
        serde_json::from_value(self.info["source"].clone()).unwrap()
    }
    fn ledger(&self) -> PathBuf {
        PathBuf::from(self.info["ledger"].as_str().unwrap())
    }
    fn mission(&self) -> String {
        self.info["mission"].as_str().unwrap().into()
    }
    fn open(&self) -> NativeHost {
        NativeHost::open(self.source(), self.ledger()).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        // Kill only this isolated child, also on a failed assertion. Never wait
        // forever for a deliberately blocked participant or open stdin stream.
        let _ = self.child.kill();
        let _ = self.child.wait();
        if let Some(path) = self.info["source"]["profile"].as_str() {
            let _ = std::fs::remove_dir_all(path);
        }
    }
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
}
fn reply<T>(rx: async_channel::Receiver<Result<T, Error>>) -> Result<T, Error> {
    runtime().block_on(async {
        tokio::time::timeout(Duration::from_secs(25), rx.recv())
            .await
            .expect("host deadline")
            .map_err(|_| Error::Unavailable)?
    })
}
fn wait(host: &NativeHost, predicate: impl Fn(&Today) -> bool) -> Today {
    let changes = host.changes();
    runtime().block_on(async {
        tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                let today = host.snapshot();
                if predicate(&today) {
                    return today;
                }
                changes.recv().await.expect("host stays open");
            }
        })
        .await
        .unwrap_or_else(|_| panic!("read did not settle: {:?}", host.snapshot()))
    })
}
fn row(today: &Today) -> &MissionRow {
    today
        .moving
        .iter()
        .chain(&today.not_moving)
        .chain(&today.unreported)
        .next()
        .expect("real mission")
}
fn ready(host: &NativeHost) -> Today {
    wait(host, |t| {
        t.freshness.state == FreshnessState::Live
            && t.moving.len() + t.not_moving.len() + t.unreported.len() == 1
    })
}

#[test]
fn canonical_failure_is_visible_without_chat_reads_and_survives_host_reopen() {
    let mut f = Fixture::new();
    let host = f.open();
    ready(&host);
    f.cmd("problem", true);
    assert!(matches!(reply(host.refresh()), Ok(_) | Err(Error::Stale)));
    let today = wait(&host, |t| !t.problems.is_empty());
    assert!(today.problems_known);
    assert_eq!(
        today.problems[0].cause.as_deref(),
        Some("Synthetic native checks failed")
    );
    assert_eq!(
        today.problems[0].mission_id.as_deref(),
        Some(f.mission().as_str())
    );
    assert!(today.problems[0].session_id.is_some());
    assert_eq!(today.problems[0].task_id, None, "Today has no task details");
    assert_eq!(f.cmd("stats", false)["posts"], 0);
    reply(host.close()).unwrap();
    let reopened = f.open();
    assert_eq!(ready(&reopened).problems, today.problems);
    f.cmd("problem", false);
    assert!(matches!(
        reply(reopened.refresh()),
        Ok(_) | Err(Error::Stale)
    ));
    let cleared = wait(&reopened, |t| t.problems.is_empty());
    assert!(cleared.problems_known);
    assert_eq!(f.cmd("stats", false)["posts"], 0);
    reply(reopened.close()).unwrap();
}

#[test]
fn background_refresh_does_not_turn_notice_invalidation_into_read_failure() {
    let mut f = Fixture::new();
    let host = f.open();
    ready(&host);
    // The real WS notice arrives while the authoritative HTTP read is
    // in flight. This is ordinary background activity, not an outage.
    for _ in 0..5 {
        f.cmd("dayRace", true);
        let _ = reply(host.refresh());
        let during = host.snapshot();
        assert!(
            !during.freshness.reason.contains("unavailable"),
            "automatic refresh showed a failure block: {:?}",
            during.freshness
        );
        ready(&host);
    }
    assert_eq!(f.cmd("stats", true)["posts"], 0);
    reply(host.close()).unwrap();
}

#[test]
fn real_reads_exact_detail_and_selective_pause_resume_preserve_other_holds() {
    let mut f = Fixture::new();
    let host = f.open();
    let today = ready(&host);
    assert_eq!(row(&today).title, "Native synthetic mission");
    assert_eq!(
        row(&today).report.as_ref().unwrap().summary,
        "Agent assessment only"
    );
    reply(host.read_mission(f.mission())).unwrap();
    let page = host.mission(&f.mission()).unwrap();
    assert!(page.tasks_known);
    assert_eq!(page.tasks.len(), 1);
    let pause = reply(host.pause(f.mission(), row(&ready(&host)).control.revision)).unwrap();
    assert_eq!(pause.status, OutcomeStatus::Accepted);
    let paused = ready(&host);
    let control = &row(&paused).control;
    assert_eq!(control.state, pilot_day_native::model::ControlState::Paused);
    let pause_id = control.pause_operation_id.clone().unwrap();
    f.cmd("holdResume", true);
    let resumed = reply(host.resume(f.mission(), control.revision, pause_id.clone())).unwrap();
    assert_eq!(resumed.status, OutcomeStatus::Accepted);
    let stats = f.cmd("stats", true);
    assert_eq!(stats["posts"], 2);
    assert_eq!(stats["pauses"].as_array().unwrap().len(), 3);
    assert_eq!(
        stats["resumes"].as_array().unwrap().len(),
        2,
        "idle member was not owned by Pause"
    );
    let ledger = std::fs::read_to_string(f.ledger()).unwrap();
    let records: Vec<Value> = ledger
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    assert!(
        records
            .iter()
            .any(|r| r["command"]["pauseOperationId"] == pause_id)
    );
    assert!(records.iter().any(|r| {
        r["receipt"]["members"]
            .as_array()
            .is_some_and(|members| members.iter().all(|m| m["state"] == "held"))
    }));
    reply(host.close()).unwrap();
}

/// Regression: a global window (the normal launch) showed every mission as
/// read only. Opening one now acts in its project, and its saved control
/// records come back after a cold reopen.
#[test]
fn global_window_opens_and_controls_a_mission_in_its_own_project() {
    let mut f = Fixture::new();
    let mut global = f.source();
    global.project = None;
    let host = NativeHost::open(global.clone(), f.ledger()).unwrap();
    reply(host.read_mission(f.mission())).unwrap();
    let page = host.mission(&f.mission()).expect("mission opens");
    assert!(page.tasks_known);
    let today = ready(&host);
    let pause = reply(host.pause(f.mission(), row(&today).control.revision)).unwrap();
    assert_eq!(pause.status, OutcomeStatus::Accepted);
    let paused = ready(&host);
    assert_eq!(
        row(&paused).control.state,
        pilot_day_native::model::ControlState::Paused
    );
    reply(host.close()).unwrap();
    let reopened = NativeHost::open(global, f.ledger()).unwrap();
    reply(reopened.read_mission(f.mission())).unwrap();
    assert_eq!(
        row(&ready(&reopened)).control.state,
        pilot_day_native::model::ControlState::Paused
    );
    assert_eq!(f.cmd("stats", true)["posts"], 1, "reopening sends nothing");
    reply(reopened.close()).unwrap();
}

#[test]
fn lost_ack_cold_open_and_missing_mismatched_lookup_never_replay() {
    let mut f = Fixture::new();
    let host = f.open();
    let before = ready(&host);
    f.cmd("lost", true);
    let outcome = reply(host.pause(f.mission(), row(&before).control.revision)).unwrap();
    assert_eq!(outcome.status, OutcomeStatus::Unknown);
    wait(&host, |t| row(t).control.delivery == Delivery::Unknown);
    reply(host.close()).unwrap();
    let host = f.open();
    let reopened = ready(&host);
    assert_eq!(row(&reopened).control.delivery, Delivery::Unknown);
    assert_eq!(f.cmd("stats", true)["posts"], 1, "cold open never POSTs");
    f.cmd("missing", true);
    assert_eq!(
        reply(host.check(f.mission())).unwrap().status,
        OutcomeStatus::Unknown
    );
    assert_eq!(
        reply(host.pause(f.mission(), row(&ready(&host)).control.revision)),
        Err(Error::Unknown)
    );
    f.cmd("missing", false);
    f.cmd("mismatch", true);
    assert_eq!(
        reply(host.check(f.mission())).unwrap().status,
        OutcomeStatus::Unknown
    );
    f.cmd("mismatch", false);
    assert_eq!(
        reply(host.check(f.mission())).unwrap().status,
        OutcomeStatus::Accepted
    );
    let stats = f.cmd("stats", true);
    assert_eq!(stats["posts"], 1);
    assert_eq!(stats["lookups"], 3);
    reply(host.close()).unwrap();
}

#[test]
fn missing_capabilities_never_enable_controls_or_fabricate_empty_inventory() {
    let mut f = Fixture::new();
    f.cmd("noControls", true);
    let host = f.open();
    let today = ready(&host);
    assert!(!row(&today).control.can_pause);
    assert!(reply(host.pause(f.mission(), row(&today).control.revision)).is_err());
    assert_eq!(f.cmd("stats", true)["posts"], 0);
    f.cmd("noDay", true);
    wait(&host, |t| t.freshness.state == FreshnessState::Unavailable);
    assert_eq!(
        host.snapshot().moving.len(),
        1,
        "unavailable keeps the earlier inventory"
    );
    reply(host.close()).unwrap();
}

#[test]
fn authority_changed_during_preflight_or_after_durable_save_refuses_admission() {
    for fault in [
        "coordinator",
        "project",
        "gateAfterJournal",
        "identity",
        "capability",
    ] {
        let mut f = Fixture::new();
        let host = f.open();
        let before = ready(&host);
        f.cmd(fault, true);
        assert!(
            reply(host.pause(f.mission(), row(&before).control.revision)).is_err(),
            "{fault}"
        );
        let stats = f.cmd("stats", true);
        assert_eq!(stats["posts"], 0, "{fault} never admitted a POST");
        if fault == "gateAfterJournal" {
            assert_eq!(stats["journalInvalidation"], true);
            let bytes = std::fs::read_to_string(f.ledger()).unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(bytes.lines().last().unwrap()).unwrap()["not_sent"],
                true
            );
        }
        reply(host.close()).unwrap();
    }
}

/// Regression for flicker: busy agents send many session events. Each one is
/// read again, but the shown read never turns stale while that happens.
#[test]
fn session_events_read_again_without_marking_the_shown_read_stale() {
    let mut f = Fixture::new();
    let host = f.open();
    ready(&host);
    let before = f.cmd("stats", true)["dayReads"].as_u64().unwrap();
    let changes = host.changes();
    for _ in 0..5 {
        f.cmd("sessionEvent", true);
    }
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        assert_eq!(
            host.snapshot().freshness.state,
            FreshnessState::Live,
            "a session event repainted Today as stale"
        );
        if f.cmd("stats", true)["dayReads"].as_u64().unwrap() > before {
            break;
        }
        assert!(std::time::Instant::now() < deadline, "no read after events");
        let _ = runtime().block_on(async {
            tokio::time::timeout(Duration::from_millis(50), changes.recv()).await
        });
    }
    assert_eq!(f.cmd("stats", true)["posts"], 0);
    reply(host.close()).unwrap();
}

#[test]
fn ws_invalidates_inflight_reads_but_does_not_confirm_an_operation() {
    let mut f = Fixture::new();
    let host = f.open();
    ready(&host);
    f.cmd("dayRace", true);
    assert_eq!(reply(host.refresh()), Err(Error::Stale));
    ready(&host);
    f.cmd("disconnect", true);
    wait(&host, |t| t.freshness.state == FreshnessState::Offline);
    assert!(reply(host.pause(f.mission(), row(&host.snapshot()).control.revision)).is_err());
    assert_eq!(f.cmd("stats", true)["posts"], 0);
    reply(host.close()).unwrap();
}

#[test]
fn passive_detail_reread_requalifies_one_invalidation_and_never_relaxes_project_checks() {
    let mut f = Fixture::new();
    let host = f.open();
    ready(&host);
    f.cmd("detailRace", true);
    reply(host.read_mission(f.mission())).expect("one raced passive read is requalified");
    assert!(host.mission(&f.mission()).is_some());
    ready(&host);
    f.cmd("detailRace", false);
    assert_eq!(
        reply(host.read_mission(f.mission())),
        Err(Error::Stale),
        "retries are limited"
    );
    f.cmd("detailRaceOff", false);
    ready(&host);
    f.cmd("coordinator", true);
    assert_eq!(
        reply(host.read_mission(f.mission())),
        Err(Error::Stale),
        "mismatched overview/detail owner refuses the read"
    );
    f.cmd("coordinator", false);
    reply(host.refresh()).unwrap();
    ready(&host);
    f.cmd("project", true);
    f.cmd("detailRace", true);
    assert_eq!(
        reply(host.read_mission(f.mission())),
        Err(Error::Identity),
        "project denial is never retried away"
    );
    assert_eq!(f.cmd("stats", true)["posts"], 0);
    reply(host.close()).unwrap();
}

#[test]
fn stop_racing_resume_remains_held_and_close_joins_entered_controls() {
    let mut f = Fixture::new();
    let host = f.open();
    ready(&host);
    f.cmd("pauseGate", true);
    let pending = host.pause(f.mission(), row(&host.snapshot()).control.revision);
    wait(&host, |t| row(t).control.delivery == Delivery::Sending);
    // Barrier is inside the real daemon's participant adapter, not a simulated ACK.
    f.cmd("waitPause", true);
    let closing = host.close();
    assert!(
        closing.is_empty(),
        "close cannot claim quiescence while POST is entered"
    );
    f.cmd("release", true);
    let _ = reply(pending);
    reply(closing).unwrap();
    assert!(matches!(reply(host.refresh()), Err(Error::Closed)));
    let host = f.open();
    let paused = ready(&host);
    f.cmd("resumeStop", true);
    let control = &row(&paused).control;
    let outcome = reply(host.resume(
        f.mission(),
        control.revision,
        control.pause_operation_id.clone().unwrap(),
    ))
    .unwrap();
    assert_eq!(outcome.status, OutcomeStatus::Unknown);
    assert_eq!(f.cmd("stats", true)["control"]["held"], true);
    reply(host.close()).unwrap();
}

#[test]
fn selected_project_is_never_guessed_and_journal_writer_is_exclusive() {
    let mut f = Fixture::new();
    let host = f.open();
    ready(&host);
    let duplicate = f.open();
    wait(&duplicate, |t| {
        t.freshness.state == FreshnessState::Unavailable
    });
    assert!(reply(duplicate.pause(f.mission(), 0)).is_err());
    assert_eq!(reply(duplicate.close()), Err(Error::Storage));
    reply(host.close()).unwrap();
    let mut changed = f.source();
    changed.project.as_mut().unwrap().project_id = f.info["other"].as_str().unwrap().into();
    let other = NativeHost::open(changed, f.ledger()).unwrap();
    wait(&other, |t| t.freshness.state == FreshnessState::Unavailable);
    assert!(
        other.snapshot().moving.is_empty(),
        "other source never inherits this cached project"
    );
    assert_eq!(f.cmd("stats", true)["posts"], 0);
    reply(other.close()).unwrap();
}

#[test]
fn failed_journal_durability_never_sends() {
    let mut f = Fixture::new();
    let host = f.open();
    let before = ready(&host);
    f.cmd("corruptJournal", true);
    assert_eq!(
        reply(host.pause(f.mission(), row(&before).control.revision)),
        Err(Error::Storage)
    );
    assert_eq!(f.cmd("stats", true)["posts"], 0);
    assert_eq!(reply(host.close()), Err(Error::Storage));
    let host = f.open();
    wait(&host, |t| t.freshness.state == FreshnessState::Unavailable);
    assert!(host.snapshot().moving.is_empty());
    assert_eq!(reply(host.close()), Err(Error::Storage));
}

#[test]
fn crash_child_entry() {
    let Ok(info) = std::env::var("DAY_HOST_FIXTURE") else {
        return;
    };
    let info: Value = serde_json::from_str(&info).unwrap();
    let host = NativeHost::open(
        serde_json::from_value(info["source"].clone()).unwrap(),
        PathBuf::from(info["ledger"].as_str().unwrap()),
    )
    .unwrap();
    let today = ready(&host);
    // Parent kills this native process after the real daemon enters its checkpoint.
    let _ = reply(host.pause(
        info["mission"].as_str().unwrap().into(),
        row(&today).control.revision,
    ));
    panic!("parent should have killed the entered native host");
}

#[test]
fn abrupt_native_process_crash_recovers_by_exact_lookup_without_post() {
    let mut f = Fixture::new();
    f.cmd("pauseGate", true);
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "crash_child_entry", "--nocapture"])
        .env("DAY_HOST_FIXTURE", f.info.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    f.cmd("waitPause", true);
    child.kill().unwrap();
    child.wait().unwrap();
    f.cmd("release", true);
    f.cmd("waitPaused", true);
    let host = f.open();
    let today = ready(&host);
    assert_eq!(row(&today).control.delivery, Delivery::Unknown);
    assert_eq!(f.cmd("stats", true)["posts"], 1);
    assert_eq!(
        reply(host.check(f.mission())).unwrap().status,
        OutcomeStatus::Accepted
    );
    let stats = f.cmd("stats", true);
    assert_eq!(stats["posts"], 1);
    assert_eq!(stats["lookups"], 1);
    reply(host.close()).unwrap();
}
