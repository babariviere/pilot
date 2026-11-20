//! Real isolated daemon routes, the released JSON bridge, the native ledger and
//! joined teardown. No UI or providers.
#[path = "support/bridge_calls.rs"]
mod bridge_calls;

use bridge_calls::Calls;
use pilot_day_native::host::{NativeHost, Options, Source};
use pilot_day_native::model::FreshnessState;
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
            .join("../../../packages/daemon/src/fixtures/day/day-native-attention.ts");
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
        let output = child.stdout.take().unwrap();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(output).lines() {
                let Ok(line) = line else { break };
                if let Ok(value) = serde_json::from_str(&line)
                    && tx.send(value).is_err()
                {
                    break;
                }
            }
        });
        let info = rx
            .recv_timeout(Duration::from_secs(20))
            .expect("fixture ready");
        Self {
            child,
            input,
            output: rx,
            info,
        }
    }
    fn open(&self) -> (NativeHost, Calls) {
        let source: Source = serde_json::from_value(self.info["source"].clone()).unwrap();
        let ledger = PathBuf::from(self.info["ledger"].as_str().unwrap());
        let host = NativeHost::open_with_options(source, ledger, Options::default()).unwrap();
        ready(&host);
        let calls = Calls::new(host.clone());
        (host, calls)
    }
    fn cmd(&mut self, action: &str, value: bool) -> Value {
        writeln!(self.input, "{}", json!({"action":action,"value":value})).unwrap();
        self.input.flush().unwrap();
        self.output
            .recv_timeout(Duration::from_secs(25))
            .expect("fixture command")
    }
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
                loop {
                    if host.snapshot().freshness.state == FreshnessState::Live {
                        return;
                    }
                    changes.recv().await.unwrap();
                }
            })
            .await
            .expect("native Today ready")
        });
}
/// Reads attention through the bridge and returns the Today it shows.
fn read(calls: &mut Calls) -> Value {
    let reply = calls.call("day.attention.read", json!({}));
    assert!(reply["error"].is_null(), "{reply}");
    reply["value"]["snapshot"].clone()
}
fn action(calls: &mut Calls, today: &Value, ask: &str, text: &str) -> Value {
    let a = &today["actions"][0];
    calls.outcome(
        "day.attention.action",
        json!({"action":{"actionId":a["id"],"revision":a["revision"]},"ask":ask,"text":text}),
    )
}
fn answer(calls: &mut Calls, today: &Value) -> Value {
    let d = &today["decisions"][0];
    calls.outcome(
        "day.attention.reply",
        json!({"decisionId":d["id"],"revision":d["revision"],"optionId":null,"optionIds":[],"text":"Reviewed package"}),
    )
}
fn check(calls: &mut Calls, id: &str, action: bool) -> Value {
    calls.outcome("day.attention.check", json!({"id":id,"action":action}))
}
fn stale(outcome: &Value, says: &str) {
    assert_eq!(outcome["status"], "stale", "{outcome}");
    assert!(
        outcome["message"].as_str().unwrap().starts_with(says),
        "{outcome}"
    );
}

#[test]
fn real_progress_later_and_user_report_are_durable_but_never_resume_or_publish() {
    let mut f = Fixture::new();
    let (host, mut calls) = f.open();
    let today = read(&mut calls);
    let view = host.attention_snapshot().unwrap();
    assert_eq!(view["capabilities"]["help"], "unavailable");
    assert_eq!(view["capabilities"]["continuation"], "unavailable");
    assert_eq!(
        action(&mut calls, &today, "progress", "  exact\n日本 💬  ")["status"],
        "accepted"
    );
    let today = read(&mut calls);
    let view = host.attention_snapshot().unwrap();
    assert_eq!(
        view["actions"][0]["record"]["progress"],
        "  exact\n日本 💬  "
    );
    assert!(view["actions"][0]["record"]["completion"].is_null());
    assert_eq!(
        action(&mut calls, &today, "later", "")["status"],
        "accepted"
    );
    let today = read(&mut calls);
    assert_eq!(
        host.attention_snapshot().unwrap()["actions"][0]["record"]["state"],
        "deferred"
    );
    assert_eq!(
        action(
            &mut calls,
            &today,
            "complete",
            "Submitted. Review is pending."
        )["status"],
        "accepted"
    );
    read(&mut calls);
    assert_eq!(
        host.attention_snapshot().unwrap()["actions"][0]["record"]["completion"]["source"],
        "user_report"
    );
    let counts = f.cmd("stats", false);
    assert_eq!(counts["posts"], 3);
    assert_eq!(counts["sends"], 0);
    calls.close().unwrap();
    f.cmd("restart", false);
    let (again, mut calls) = f.open();
    read(&mut calls);
    assert_eq!(
        again.attention_snapshot().unwrap()["actions"][0]["record"]["completion"]["report"],
        "Submitted. Review is pending."
    );
    assert_eq!(f.cmd("stats", false)["posts"], 3);
    calls.close().unwrap();
}

#[test]
fn an_answer_whose_question_is_unchanged_is_sent_again_by_itself() {
    let mut f = Fixture::new();
    f.cmd("deliver", true);
    let (_host, mut calls) = f.open();
    let today = read(&mut calls);
    // Members work while it sends: the next two reads see the mission move.
    f.cmd("churn", true);
    assert_eq!(answer(&mut calls, &today)["status"], "accepted");
    let counts = f.cmd("stats", false);
    assert_eq!(counts["posts"], 1, "sent once, after the read settled");
    assert_eq!(counts["delivered"], 1);
    calls.close().unwrap();
}

#[test]
fn an_answer_stops_after_three_tries_and_when_its_question_changed() {
    let mut f = Fixture::new();
    f.cmd("deliver", true);
    let (_host, mut calls) = f.open();
    let today = read(&mut calls);
    f.cmd("churn", false);
    stale(&answer(&mut calls, &today), "Pilot tried 3 times");
    f.cmd("calm", false);
    let today = read(&mut calls);
    // The chat asked something else: the answer to the earlier question is not sent.
    f.cmd("multi", true);
    stale(
        &answer(&mut calls, &today),
        "This question is no longer waiting",
    );
    let counts = f.cmd("stats", false);
    assert_eq!(counts["posts"], 0);
    assert_eq!(counts["delivered"], 0);
    calls.close().unwrap();
}

#[test]
fn an_answer_is_sent_while_notices_keep_the_read_behind() {
    let mut f = Fixture::new();
    f.cmd("deliver", true);
    let (_host, mut calls) = f.open();
    let today = read(&mut calls);
    // A structural notice (the project list) arrives during every read, so no read is ever the
    // newest. Only the question must be up to date: the answer goes on the first try.
    f.cmd("notice", true);
    assert_eq!(answer(&mut calls, &today)["status"], "accepted");
    let counts = f.cmd("stats", false);
    assert_eq!(counts["posts"], 1);
    assert_eq!(counts["delivered"], 1);
    f.cmd("notice", false);
    calls.close().unwrap();
}

#[test]
fn mission_notices_during_every_read_do_not_refuse_or_retry_an_answer() {
    let mut f = Fixture::new();
    f.cmd("deliver", true);
    let (_host, mut calls) = f.open();
    let today = read(&mut calls);
    // Agents at work: a mission notice arrives during every read. It names no target, so the
    // answer goes on the first try.
    f.cmd("catalog", true);
    let started = std::time::Instant::now();
    assert_eq!(answer(&mut calls, &today)["status"], "accepted");
    assert!(
        started.elapsed() < Duration::from_millis(1500),
        "no retry waits: {:?}",
        started.elapsed()
    );
    let counts = f.cmd("stats", false);
    assert_eq!(counts["posts"], 1);
    assert_eq!(counts["delivered"], 1);
    f.cmd("catalog", false);
    calls.close().unwrap();
}

#[test]
fn lost_ack_and_cold_recovery_keep_exact_draft_and_only_lookup() {
    let mut f = Fixture::new();
    let (host, mut calls) = f.open();
    let today = read(&mut calls);
    let a = today["actions"][0].clone();
    let id = a["id"].as_str().unwrap().to_owned();
    let saved = calls.call(
        "day.attention.draft",
        json!({"itemId":id,"revision":a["revision"],"pick":null,"picks":[],
            "text":"  submitted\n💬 exact  ","question":"why?","later":false}),
    );
    assert!(saved["error"].is_null(), "{saved}");
    f.cmd("lost", true);
    assert_eq!(
        action(&mut calls, &today, "complete", "submitted")["error"],
        "unknown"
    );
    let operation = host.attention_operations()[0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    calls.close().unwrap();
    f.cmd("restart", false);
    let (again, mut calls) = f.open();
    read(&mut calls);
    // The successful daemon effect may have moved the shown action's revision.
    // Its old draft is kept on disk, not applied to a different revision.
    let drafts = again.attention_drafts();
    let (key, draft) = drafts.iter().find(|(key, _)| key.id == id).unwrap();
    assert_eq!(key.revision, a["revision"].as_u64().unwrap());
    assert_eq!(draft["text"], "  submitted\n💬 exact  ");
    assert_eq!(draft["question"], "why?");
    assert_eq!(again.attention_operations()[0]["id"], operation);
    assert_eq!(again.attention_operations()[0]["state"], "unknown");
    f.cmd("missing", true);
    assert_eq!(check(&mut calls, &id, true)["error"], "unknown");
    assert_eq!(f.cmd("stats", false)["posts"], 1);
    f.cmd("missing", false);
    f.cmd("mismatch", true);
    assert_eq!(check(&mut calls, &id, true)["error"], "unknown");
    f.cmd("mismatch", false);
    assert!(check(&mut calls, &id, true)["error"].is_null());
    assert_eq!(
        again.attention_operations()[0]["receipt"]["value"]["record"]["completion"]["source"],
        "user_report"
    );
    assert_eq!(again.attention_operations()[0]["state"], "acknowledged");
    assert_eq!(f.cmd("stats", false)["posts"], 1);
    calls.close().unwrap();
}

#[test]
fn stale_files_and_authority_cannot_complete_old_request() {
    let mut f = Fixture::new();
    let (_host, mut calls) = f.open();
    let today = read(&mut calls);
    f.cmd("file", true);
    assert_eq!(
        action(&mut calls, &today, "complete", "done")["status"],
        "rejected"
    );
    assert_eq!(f.cmd("stats", false)["state"], "pending");
    f.cmd("file", false);
    let today = read(&mut calls);
    f.cmd("revoke", true);
    let refused = action(&mut calls, &today, "complete", "done");
    assert!(
        refused["error"].is_string() || refused["status"] != "accepted",
        "{refused}"
    );
    assert_eq!(f.cmd("stats", false)["posts"], 1);
    calls.close().unwrap();
}

#[test]
fn close_joins_entered_attention_before_ledger_release_and_cold_open_never_sends() {
    let mut f = Fixture::new();
    let (_host, mut calls) = f.open();
    let today = read(&mut calls);
    f.cmd("hold", true);
    let a = &today["actions"][0];
    let pending = calls.start(
        "day.attention.action",
        json!({"action":{"actionId":a["id"],"revision":a["revision"]},"ask":"progress","text":"kept"}),
    );
    f.cmd("waitEntered", false);
    let closing = calls.bridge().close();
    assert!(closing.try_recv().is_err());
    f.cmd("release", false);
    assert!(calls.wait(pending)["error"].is_null());
    closing.recv_blocking().unwrap().unwrap();
    assert_eq!(
        calls.call("day.attention.read", json!({}))["thrown"],
        "ERR_NSH_HOST_ERROR"
    );
    drop(calls);
    let (again, mut calls) = f.open();
    read(&mut calls);
    assert_eq!(
        again.attention_snapshot().unwrap()["actions"][0]["record"]["progress"],
        "kept"
    );
    assert_eq!(f.cmd("stats", false)["posts"], 1);
    calls.close().unwrap();
}

#[test]
fn changed_profile_identity_refuses_attention_without_sending() {
    let mut f = Fixture::new();
    let (_host, mut calls) = f.open();
    let today = read(&mut calls);
    f.cmd("identity", true);
    let refused = action(&mut calls, &today, "complete", "done");
    assert!(
        refused["error"].is_string() || refused["status"] != "accepted",
        "{refused}"
    );
    assert_eq!(f.cmd("stats", false)["posts"], 0);
    calls.close().unwrap();
}

#[test]
fn ordinary_question_answer_never_resends_an_unconfirmed_operation() {
    let mut f = Fixture::new();
    let (host, mut calls) = f.open();
    let today = read(&mut calls);
    assert_eq!(answer(&mut calls, &today)["error"], "unknown");
    let today = read(&mut calls);
    assert_eq!(
        answer(&mut calls, &today)["error"],
        "unknown",
        "an unconfirmed answer is never sent again"
    );
    let counts = f.cmd("stats", false);
    assert_eq!(counts["posts"], 1);
    assert_eq!(counts["sends"], 1);
    let decision = today["decisions"][0]["id"].as_str().unwrap().to_owned();
    assert!(
        host.attention_operations()
            .iter()
            .any(|r| r["request"]["kind"] == "answer")
    );
    calls.close().unwrap();
    let (_again, mut calls) = f.open();
    read(&mut calls);
    assert_eq!(check(&mut calls, &decision, false)["error"], "unknown");
    assert_eq!(f.cmd("stats", false)["sends"], 1);
    calls.close().unwrap();
}
