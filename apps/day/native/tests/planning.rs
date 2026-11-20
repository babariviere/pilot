//! Actual native worker, credential reader, command ledger, released JSON bridge
//! and isolated production daemon.
#[path = "support/bridge_calls.rs"]
mod bridge_calls;

use bridge_calls::Calls;
use pilot_day_native::{
    host::{NativeHost, Options, Source},
    model::FreshnessState,
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
        Self::script("day-native-planning.ts")
    }
    fn script(name: &str) -> Self {
        let script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../packages/daemon/src/fixtures/day/planning")
            .join(if name == "day-published-plan.ts" {
                "day-planning-worker.ts"
            } else {
                name
            });
        let mut child = Command::new("node")
            .arg(script)
            .args(if name == "day-published-plan.ts" {
                vec!["--published-plan"]
            } else {
                vec![]
            })
            .env_remove("PILOT_HOME")
            .env_remove("PILOT_PORT")
            .env_remove("NODE_TEST_CONTEXT")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let input = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let (tx, output) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if let Ok(v) = serde_json::from_str::<Value>(&line)
                    && tx.send(v).is_err()
                {
                    break;
                }
            }
        });
        let info = output.recv_timeout(Duration::from_secs(25)).unwrap();
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
        self.output.recv_timeout(Duration::from_secs(25)).unwrap()
    }
    fn mission(&self) -> &str {
        self.info["mission"].as_str().unwrap()
    }
    fn open(&self) -> (NativeHost, Calls) {
        let source: Source = serde_json::from_value(self.info["source"].clone()).unwrap();
        let host = NativeHost::open_with_options(
            source,
            self.info["ledger"].as_str().unwrap().into(),
            Options::default(),
        )
        .unwrap();
        ready(&host);
        let calls = Calls::new(host.clone());
        (host, calls)
    }
}

#[test]
fn real_planning_worker_yields_then_continues_once_after_every_answer() {
    let mut f = Fixture::script("day-planning-worker.ts");
    let (host, mut calls) = f.open();
    let mission = f.mission().to_owned();
    let page = read(&mut calls, &mission);
    assert_eq!(
        host.planning(&mission).unwrap()["capabilities"]["coordinatorProfile"],
        1
    );
    assert_eq!(f.cmd("stats", false)["requests"], 1);
    assert_eq!(
        save(&mut calls, &mission, &page, 0, "partial draft")["status"],
        "accepted"
    );
    let partial = read(&mut calls, &mission);
    assert_ne!(
        submit(&mut calls, &mission, &partial)["status"],
        "accepted",
        "a partial interview is not submitted"
    );
    assert_eq!(f.cmd("stats", false)["requests"], 1);
    let count = read(&mut calls, &mission)["interview"]["questions"]
        .as_array()
        .unwrap()
        .len();
    for index in 0..count {
        let page = read(&mut calls, &mission);
        assert_eq!(
            save(&mut calls, &mission, &page, index, " exact detail\n")["status"],
            "accepted"
        );
    }
    let page = read(&mut calls, &mission);
    assert_eq!(submit(&mut calls, &mission, &page)["status"], "accepted");
    assert_eq!(f.cmd("idle", false)["requests"], 2);
    calls.close().unwrap();
    assert_eq!(f.cmd("close", false)["closed"], true);
    assert!(
        f.child.wait().unwrap().success(),
        "fixture joins its real kernel and exits cleanly"
    );
}

#[test]
fn published_plan_explicit_native_start_real_worker_and_visible_report() {
    let mut f = Fixture::script("day-published-plan.ts");
    let (host, mut calls) = f.open();
    let mission = f.mission().to_owned();
    let page = read_current(&mut calls, &mission);
    assert_eq!(f.cmd("stats", false)["workers"], 1);
    assert_eq!(
        save(&mut calls, &mission, &page, 0, "Agree to this plan")["status"],
        "accepted"
    );
    let page = read_current(&mut calls, &mission);
    assert_eq!(submit(&mut calls, &mission, &page)["status"], "accepted");
    assert_eq!(
        f.cmd("idle", false)["workers"],
        1,
        "Submitting and publishing start no builder"
    );
    read_current(&mut calls, &mission);
    let view = host.planning(&mission).unwrap();
    let start = &view["start"];
    assert_eq!(start["available"], true, "{view}");
    let shown = json!({"revision": start["revision"], "digest": start["digest"], "taskId":start["taskId"], "context":start["contextDigest"]});
    let mut stale = shown.clone();
    stale["revision"] = json!(0);
    assert!(pilot_day_native::plan_host::start_request(&view, &stale).is_err());
    f.cmd("lost", true);
    assert_eq!(
        calls.outcome(
            "day.plan.startWork",
            json!({"missionId":mission,"intent":shown})
        )["status"],
        "unknown"
    );
    assert_eq!(f.cmd("reported", false)["workers"], 2);
    let read = calls.call("day.mission.read", json!({"missionId":mission}));
    assert_eq!(
        read["value"]["snapshot"]["tasks"][0]["report"]["summary"],
        "Offline background worker reported",
        "{read}"
    );
    let requests = f.cmd("stats", false)["requests"].clone();
    assert!(
        calls.outcome(
            "day.plan.startWork",
            json!({"missionId":mission,"intent":shown})
        )["status"]
            != "accepted",
        "A second fresh Start is not an exact receipt lookup"
    );
    assert_eq!(f.cmd("stats", false)["requests"], requests);
    calls.close().unwrap();
    let (host, mut calls) = f.open();
    let pending = host
        .planning_operations(&mission)
        .into_iter()
        .find(|r| r["kind"] == "plan-start")
        .unwrap();
    assert_eq!(pending["state"], "unknown");
    read_current(&mut calls, &mission);
    assert_eq!(
        calls.outcome("day.plan.checkWork", json!({"missionId":mission}))["status"],
        "accepted",
        "Reopen checks the exact saved Start, never resends it"
    );
    read_current(&mut calls, &mission);
    assert_eq!(
        host.planning(&mission).unwrap()["start"]["state"],
        "admitted"
    );
    assert_eq!(f.cmd("stats", false)["workers"], 2, "Cold-open is passive");
    assert_eq!(f.cmd("stats", false)["requests"], requests);
    calls.close().unwrap();
    assert_eq!(f.cmd("close", false)["closed"], true);
    assert!(f.child.wait().unwrap().success());
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        if let Some(path) = self.info["source"]["profile"].as_str() {
            let _ = std::fs::remove_dir_all(path);
        }
    }
}
fn ready(host: &NativeHost) {
    let changes = host.changes();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            tokio::time::timeout(Duration::from_secs(20), async {
                while host.snapshot().freshness.state != FreshnessState::Live {
                    changes.recv().await.unwrap();
                }
            })
            .await
            .unwrap();
        });
}
/// The planning page the bridge shows for `mission`.
fn read(calls: &mut Calls, mission: &str) -> Value {
    let reply = calls.call("day.plan.read", json!({"missionId":mission}));
    assert!(reply["error"].is_null(), "{reply}");
    reply["value"]["snapshot"].clone()
}
// Real worker transitions can send several invalidations after a fixture barrier.
// Retry only passive reads. Never retry save, submit, Start or any entered effect.
fn read_current(calls: &mut Calls, mission: &str) -> Value {
    for _ in 0..4 {
        let reply = calls.call("day.plan.read", json!({"missionId":mission}));
        match reply["error"].as_str() {
            None => return reply["value"]["snapshot"].clone(),
            Some("stale") => continue,
            Some(error) => panic!("Planning read failed: {error}"),
        }
    }
    panic!("Planning read kept changing");
}
/// Saves question `index` of the shown interview with its first choice.
fn save(calls: &mut Calls, mission: &str, page: &Value, index: usize, text: &str) -> Value {
    let i = &page["interview"];
    let q = &i["questions"][index];
    calls.outcome(
        "day.plan.save",
        json!({"missionId":mission,"intent":{"interviewId":i["id"],"questionSet":i["questionSet"],
            "questionId":q["id"],"digest":q["digest"],"choiceId":q["choices"][0]["id"],"text":text}}),
    )
}
fn submit(calls: &mut Calls, mission: &str, page: &Value) -> Value {
    let i = &page["interview"];
    calls.outcome(
        "day.plan.submit",
        json!({"missionId":mission,"intent":{"interviewId":i["id"],"revision":i["revision"],"proposal":i["proposal"]}}),
    )
}
fn check(calls: &mut Calls, mission: &str, page: &Value) -> Value {
    calls.outcome(
        "day.plan.check",
        json!({"missionId":mission,"intent":{"interviewId":page["interview"]["id"]}}),
    )
}

#[test]
fn drafts_restart_submission_and_cold_open_never_replay() {
    let mut f = Fixture::new();
    let (host, mut calls) = f.open();
    let mission = f.mission().to_owned();
    let page = read(&mut calls, &mission);
    assert_eq!(
        host.planning(&mission).unwrap()["capabilities"]["continuation"],
        "unavailable"
    );
    assert_eq!(
        save(&mut calls, &mission, &page, 0, " exact\n💬 ")["status"],
        "accepted"
    );
    read(&mut calls, &mission);
    assert_eq!(
        host.planning(&mission).unwrap()["view"]["interview"]["answers"][0]["text"],
        " exact\n💬 "
    );
    calls.close().unwrap();
    f.cmd("restart", true);
    let (host, mut calls) = f.open();
    assert_eq!(f.cmd("stats", true)["posts"], 1);
    let page = read(&mut calls, &mission);
    assert_eq!(
        host.planning(&mission).unwrap()["view"]["interview"]["submission"],
        Value::Null
    );
    assert_eq!(submit(&mut calls, &mission, &page)["status"], "accepted");
    read(&mut calls, &mission);
    assert!(
        host.planning(&mission).unwrap()["view"]["interview"]["submission"]["operationId"]
            .is_string()
    );
    assert_eq!(f.cmd("stats", true)["posts"], 2);
    calls.close().unwrap();
}

#[test]
fn lost_ack_exact_lookup_missing_and_mismatched_receipts_never_resend() {
    let mut f = Fixture::new();
    let (_host, mut calls) = f.open();
    let mission = f.mission().to_owned();
    let page = read(&mut calls, &mission);
    f.cmd("lost", true);
    assert_eq!(
        save(&mut calls, &mission, &page, 0, "kept")["status"],
        "unknown"
    );
    assert_eq!(
        save(&mut calls, &mission, &page, 0, "no retry")["error"],
        "unknown"
    );
    calls.close().unwrap();
    let (_host, mut calls) = f.open();
    assert_eq!(f.cmd("stats", true)["posts"], 1);
    let page = read(&mut calls, &mission);
    f.cmd("missing", true);
    assert_eq!(check(&mut calls, &mission, &page)["error"], "unknown");
    f.cmd("missing", false);
    f.cmd("mismatch", true);
    assert_eq!(check(&mut calls, &mission, &page)["error"], "unknown");
    f.cmd("mismatch", false);
    assert_eq!(check(&mut calls, &mission, &page)["status"], "accepted");
    assert_eq!(f.cmd("stats", true)["posts"], 1);
    calls.close().unwrap();
}

#[test]
fn close_fences_new_actions_and_joins_entered_http_and_journal() {
    let mut f = Fixture::new();
    let (host, mut calls) = f.open();
    let mission = f.mission().to_owned();
    let page = read(&mut calls, &mission);
    f.cmd("block", true);
    let i = &page["interview"];
    let q = &i["questions"][0];
    let saving = calls.start(
        "day.plan.save",
        json!({"missionId":mission,"intent":{"interviewId":i["id"],"questionSet":i["questionSet"],
            "questionId":q["id"],"digest":q["digest"],"choiceId":q["choices"][0]["id"],"text":"joined"}}),
    );
    assert_eq!(f.cmd("entered", true)["held"], true);
    let closing = calls.bridge().close();
    assert!(
        closing.try_recv().is_err(),
        "close cannot precede entered HTTP"
    );
    assert_eq!(
        calls.call("day.plan.read", json!({"missionId":mission}))["thrown"],
        "ERR_NSH_HOST_ERROR"
    );
    f.cmd("release", true);
    assert_eq!(calls.wait(saving)["value"]["outcome"]["status"], "accepted");
    closing.recv_blocking().unwrap().unwrap();
    drop(calls);
    drop(host);
    let (host, mut calls) = f.open();
    read(&mut calls, &mission);
    assert_eq!(
        host.planning(&mission).unwrap()["view"]["interview"]["answers"][0]["text"],
        "joined"
    );
    assert_eq!(f.cmd("stats", true)["posts"], 1);
    calls.close().unwrap();
}
