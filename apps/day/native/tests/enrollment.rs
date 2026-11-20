//! Creation starts in the real Rust host, never from a pre-enrolled fixture.
#[path = "support/bridge_calls.rs"]
mod bridge_calls;
use bridge_calls::Calls;
use pilot_day_native::{
    host::{NativeHost, Source},
    model::FreshnessState,
    plan::{NewIntent, PlanStage, SubmitIntent},
    plan_host::{self, Local},
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
            .join("../../../packages/daemon/src/fixtures/day/planning/day-planning-enrollment.ts");
        let mut child = Command::new("node")
            .arg(script)
            .env_remove("PILOT_HOME")
            .env_remove("PILOT_PORT")
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
        self.command(json!({"action":action,"value":value}))
    }
    fn command(&mut self, command: Value) -> Value {
        writeln!(self.input, "{command}").unwrap();
        self.input.flush().unwrap();
        self.output.recv_timeout(Duration::from_secs(25)).unwrap()
    }
    fn open(&self, planning: bool) -> NativeHost {
        let source: Source = serde_json::from_value(self.info["source"].clone()).unwrap();
        let ledger = self.info["ledger"].as_str().unwrap().into();
        if planning {
            NativeHost::open_with_options(
                source,
                ledger,
                pilot_day_native::host::Options {
                    planning_model: Some("faux/faux-1".into()),
                    ..Default::default()
                },
            )
        } else {
            NativeHost::open_with_options(source, ledger, Default::default())
        }
        .unwrap()
    }
    fn close(&mut self, calls: Calls) {
        calls.close().unwrap();
        self.cmd("close", false);
        assert!(
            self.child.wait().unwrap().success(),
            "joins daemon, kernel, watchers and stores"
        );
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
fn rt() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
}
fn ready(host: &NativeHost) {
    let changes = host.changes();
    rt().block_on(async {
        tokio::time::timeout(Duration::from_secs(20), async {
            while host.snapshot().freshness.state != FreshnessState::Live {
                changes.recv().await.unwrap();
            }
        })
        .await
        .unwrap();
    });
}
fn intent(host: &NativeHost, calls: &mut Calls) -> NewIntent {
    let result = calls.call("day.plan.prepare", json!({}));
    assert!(result["error"].is_null(), "{result}");
    NewIntent {
        create_another: false,
        allowance_micros: None,
        setup: host.planning_setup().unwrap().digest,
        goal: "  Clarify this exact goal\n💬  ".into(),
        replaces: None,
        request: None,
        feedback: None,
    }
}
fn mission(host: &NativeHost) -> String {
    host.planning_enrollments()[0]["missionId"]
        .as_str()
        .unwrap()
        .into()
}
// Retry only a passive read raced by a fixture invalidation.
fn read(calls: &mut Calls, id: &str) -> Value {
    for _ in 0..5 {
        let result = calls.call("day.plan.read", json!({"missionId":id}));
        match result["error"].as_str() {
            None => return result["value"]["snapshot"].clone(),
            Some("stale") => continue,
            _ => panic!("planning read: {result}"),
        }
    }
    panic!("planning GET did not settle");
}

fn answer_all(calls: &mut Calls, id: &str) {
    let page = read(calls, id);
    let i = &page["interview"];
    for q in i["questions"].as_array().unwrap() {
        let result = calls.outcome(
            "day.plan.save",
            json!({"missionId":id,"intent":{
                "interviewId":i["id"],"questionSet":i["questionSet"],"questionId":q["id"],
                "digest":q["digest"],"choiceId":q["choices"][0]["id"],"text":""
            }}),
        );
        assert_eq!(result["status"], "accepted", "{result}");
    }
}

fn submit(calls: &mut Calls, id: &str, page: &Value) -> Value {
    let i = &page["interview"];
    calls.outcome(
        "day.plan.submit",
        json!({"missionId":id,"intent":{
            "interviewId":i["id"],"revision":i["revision"],"proposal":i["proposal"]
        }}),
    )
}

#[test]
fn discovery_requires_native_model_and_current_profile_without_admitting_anything() {
    let mut f = Fixture::new();
    let host = f.open(false);
    let mut calls = Calls::new(host.clone());
    ready(&host);
    assert_eq!(
        calls.call("day.plan.prepare", json!({}))["error"],
        "unavailable"
    );
    assert!(host.planning_setup().is_none());
    assert_eq!(
        host.snapshot().freshness.state,
        FreshnessState::Live,
        "unconfigured New does not disable Today"
    );
    calls.close().unwrap();
    let host = f.open(true);
    let mut calls = Calls::new(host.clone());
    ready(&host);
    f.cmd("unavailable", true);
    assert_eq!(
        calls.call("day.plan.prepare", json!({}))["error"],
        "unavailable"
    );
    assert!(host.planning_setup().is_none());
    f.cmd("unavailable", false);
    let first = intent(&host, &mut calls);
    assert_eq!(host.planning_setup().unwrap().model, "faux/faux-1");
    assert!(calls.call("day.plan.prepare", json!({}))["error"].is_null());
    assert_eq!(
        host.planning_setup().unwrap().digest,
        first.setup,
        "passive refresh does not replace unconsumed identity"
    );
    assert_eq!(f.cmd("stats", false)["posts"], 0);
    assert_eq!(f.cmd("stats", false)["workers"], 0);
    f.close(calls);
}

#[test]
fn exact_new_enrollment_preparing_then_full_round_and_duplicate_intent_never_builds() {
    let mut f = Fixture::new();
    let host = f.open(true);
    let mut calls = Calls::new(host.clone());
    ready(&host);
    let new = intent(&host, &mut calls);
    assert_eq!(
        calls.outcome("day.plan.create", json!(new.clone()))["status"],
        "accepted"
    );
    let id = mission(&host);
    read(&mut calls, &id);
    let v = host.planning(&id).unwrap();
    assert_eq!(v["status"], "preparing");
    assert_eq!(v["view"], Value::Null);
    let page = plan_host::page(&v, &[], &Local::default());
    assert!(page.interview.is_none());
    assert_eq!(page.stage, PlanStage::Planning);
    assert!(plan_host::submit_request(&v, &SubmitIntent::default()).is_err());
    assert!(
        host.planning_setup().is_none(),
        "one shown setup is consumed once"
    );
    assert_eq!(
        calls.outcome("day.plan.create", json!(new.clone()))["status"],
        "accepted"
    );
    let changed = NewIntent {
        goal: "different".into(),
        ..new.clone()
    };
    assert_eq!(
        calls.call("day.plan.create", json!(changed))["error"],
        "stale"
    );
    let stats = f.cmd("stats", false);
    assert_eq!(stats["posts"], 1);
    assert_eq!(stats["goal"], new.goal);
    assert_ne!(stats["owner"], stats["enrollment"]);
    assert_ne!(stats["owner"], id);
    f.cmd("generate", true);
    f.cmd("held", false);
    let changes = host.changes();
    rt().block_on(async {
        tokio::time::timeout(Duration::from_secs(15), async {
            while host
                .planning(&id)
                .is_none_or(|v| v["status"] != "available" || v["capabilities"]["answers"] != 1)
            {
                changes.recv().await.unwrap();
            }
        })
        .await
        .unwrap();
    });
    let v = host.planning(&id).unwrap();
    assert_eq!(v["status"], "available");
    assert_eq!(
        v["view"]["interview"]["questions"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(v["capabilities"]["answers"], 1);
    assert_eq!(f.cmd("stats", false)["tasks"], 0);
    assert!(calls.call("day.plan.prepare", json!({}))["error"].is_null());
    assert_ne!(
        host.planning_setup().unwrap().digest,
        new.setup,
        "a later New gets fresh identities"
    );
    f.close(calls);
}

#[test]
fn stop_and_pause_after_native_creation_never_admit_a_continuation_or_build() {
    for action in ["stop", "pause"] {
        let mut f = Fixture::new();
        let host = f.open(true);
        let mut calls = Calls::new(host.clone());
        ready(&host);
        // Exercise actual Stop/Pause admission fences without relying on a WS
        // invalidation racing the write first. Every host probe still uses GET.
        f.cmd("quiet", true);
        let new = intent(&host, &mut calls);
        assert_eq!(
            calls.outcome("day.plan.create", json!(new))["status"],
            "accepted"
        );
        let id = mission(&host);
        f.cmd("generate", true);
        f.cmd("held", false);
        answer_all(&mut calls, &id);
        f.cmd(action, true);
        let page = read(&mut calls, &id);
        let submitted = submit(&mut calls, &id, &page);
        assert_eq!(
            submitted["status"], "accepted",
            "{action}: {submitted}, {page}"
        );
        f.cmd("drain", false);
        let stats = f.cmd("stats", false);
        assert_eq!(stats["requests"], 1, "{action} holds planning admission");
        assert_eq!(stats["tasks"], 0);
        f.close(calls);
    }
}

#[test]
fn changed_owner_cannot_use_the_retained_read_to_answer() {
    let mut f = Fixture::new();
    let host = f.open(true);
    let mut calls = Calls::new(host.clone());
    ready(&host);
    let new = intent(&host, &mut calls);
    assert_eq!(
        calls.outcome("day.plan.create", json!(new))["status"],
        "accepted"
    );
    let id = mission(&host);
    f.cmd("generate", true);
    f.cmd("held", false);
    answer_all(&mut calls, &id);
    let page = read(&mut calls, &id);
    let posts = f.cmd("stats", false)["posts"].clone();
    f.cmd("owner", true);
    let result = submit(&mut calls, &id, &page);
    assert!(result["error"].is_string(), "{result}");
    assert_eq!(f.cmd("stats", false)["posts"], posts);
    f.close(calls);
}

#[test]
fn changed_configuration_project_and_post_journal_probe_refuse_before_enrollment() {
    let mut f = Fixture::new();
    let host = f.open(true);
    let mut calls = Calls::new(host.clone());
    ready(&host);
    let old = intent(&host, &mut calls);
    f.cmd("configuration", true);
    assert_eq!(calls.call("day.plan.create", json!(old))["error"], "stale");
    assert_eq!(f.cmd("stats", false)["posts"], 0);
    let new = intent(&host, &mut calls);
    f.cmd("project", true);
    assert_eq!(
        calls.call("day.plan.create", json!(new))["error"],
        "identity"
    );
    assert!(host.planning_setup().is_none());
    f.cmd("project", false);
    let new = intent(&host, &mut calls);
    f.cmd("change-after-journal", true);
    assert_eq!(calls.call("day.plan.create", json!(new))["error"], "stale");
    assert_eq!(f.cmd("stats", false)["posts"], 0);
    assert_eq!(host.planning_enrollments()[0]["state"], "not-sent");
    f.close(calls);
}

#[test]
fn lost_ack_restart_missing_and_wrong_result_only_lookup_the_exact_enrollment() {
    let mut f = Fixture::new();
    let host = f.open(true);
    let mut calls = Calls::new(host.clone());
    ready(&host);
    let new = intent(&host, &mut calls);
    f.cmd("lost", true);
    assert_eq!(
        calls.outcome("day.plan.create", json!(new.clone()))["status"],
        "unknown"
    );
    assert_eq!(
        calls.outcome("day.plan.create", json!(new.clone()))["status"],
        "unknown"
    );
    // The lost creation can be checked; it does not block a new setup.
    let prepared = calls.call("day.plan.prepare", json!({}));
    assert!(prepared["error"].is_null(), "{prepared:?}");
    assert!(host.planning_setup().unwrap().unconfirmed);
    let op = host.planning_enrollments()[0]["operationId"]
        .as_str()
        .unwrap()
        .to_owned();
    calls.close().unwrap();
    f.cmd("generate", true);
    f.cmd("held", false);
    f.cmd("restart", true);
    let host = f.open(true);
    let mut calls = Calls::new(host.clone());
    ready(&host);
    assert_eq!(f.cmd("stats", false)["posts"], 1);
    assert_eq!(
        f.cmd("stats", false)["workers"],
        1,
        "cold open never starts a historical worker"
    );
    assert_eq!(
        calls.outcome("day.plan.create", json!(new))["status"],
        "unknown"
    );
    f.cmd("missing", true);
    assert_eq!(
        calls.call("day.plan.checkNew", json!({"operationId":op.clone()}))["error"],
        "unknown"
    );
    f.cmd("missing", false);
    for detail in ["hash", "owner", "enrollment"] {
        f.command(json!({"action":"mismatch","value":true,"detail":detail}));
        assert_eq!(
            calls.call("day.plan.checkNew", json!({"operationId":op.clone()}))["error"],
            "unknown"
        );
    }
    f.cmd("mismatch", false);
    assert_eq!(
        calls.outcome("day.plan.checkNew", json!({"operationId":op.clone()}))["status"],
        "accepted"
    );
    f.cmd("missing", true);
    assert_eq!(
        host.planning_enrollments()[0]["state"],
        "accepted",
        "terminal ACK cannot be erased"
    );
    assert_eq!(f.cmd("stats", false)["posts"], 1);
    f.close(calls);
}

#[test]
fn close_joins_entered_enrollment_and_preserves_its_receipt() {
    let mut f = Fixture::new();
    let host = f.open(true);
    let mut calls = Calls::new(host.clone());
    ready(&host);
    let new = intent(&host, &mut calls);
    f.cmd("block", true);
    let sending = calls.start("day.plan.create", json!(new));
    assert_eq!(f.cmd("entered", false)["held"], true);
    let closing = host.close();
    assert!(closing.try_recv().is_err());
    assert_eq!(calls.call("day.plan.prepare", json!({}))["error"], "closed");
    f.cmd("release", true);
    let sent = calls.wait(sending);
    assert_eq!(sent["value"]["outcome"]["status"], "accepted", "{sent}");
    closing.recv_blocking().unwrap().unwrap();
    let host = f.open(true);
    let calls = Calls::new(host.clone());
    ready(&host);
    assert_eq!(host.planning_enrollments()[0]["state"], "accepted");
    assert_eq!(f.cmd("stats", false)["posts"], 1);
    f.close(calls);
}

#[test]
fn interrupted_before_daemon_entry_stays_unknown_after_restart_without_historical_send() {
    let mut f = Fixture::new();
    let host = f.open(true);
    let mut calls = Calls::new(host.clone());
    ready(&host);
    let new = intent(&host, &mut calls);
    f.cmd("drop-before", true);
    assert_eq!(
        calls.outcome("day.plan.create", json!(new.clone()))["status"],
        "unknown"
    );
    let operation = host.planning_enrollments()[0]["operationId"]
        .as_str()
        .unwrap()
        .to_owned();
    calls.close().unwrap();
    f.cmd("restart", true);
    let host = f.open(true);
    let mut calls = Calls::new(host.clone());
    ready(&host);
    assert_eq!(
        calls.call("day.plan.checkNew", json!({"operationId":operation}))["error"],
        "unknown"
    );
    assert_eq!(
        calls.outcome("day.plan.create", json!(new))["status"],
        "unknown"
    );
    assert!(calls.call("day.plan.prepare", json!({}))["error"].is_null());
    assert!(host.planning_setup().unwrap().unconfirmed);
    let stats = f.cmd("stats", false);
    assert_eq!(
        stats["posts"], 1,
        "only the interrupted original attempt entered the proxy"
    );
    assert_eq!(stats["workers"], 0);
    assert_eq!(stats["requests"], 0);
    f.close(calls);
}
