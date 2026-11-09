//! Real isolated daemon routes, native ledger and joined teardown. No UI or providers.
use pilot_day_native::host::{Error, NativeHost, Source, attention::DraftKey};
use pilot_day_native::model::{FreshnessState, IntentOutcome, OutcomeStatus};
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{Arc, Mutex, mpsc},
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
            .join("../../../packages/daemon/src/fixtures/day-native-attention.ts");
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
    fn source(&self) -> Source {
        serde_json::from_value(self.info["source"].clone()).unwrap()
    }
    fn ledger(&self) -> PathBuf {
        self.info["ledger"].as_str().unwrap().into()
    }
    fn open(&self) -> NativeHost {
        let h = NativeHost::open(self.source(), self.ledger()).unwrap();
        ready(&h);
        h
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
fn rt() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
}
fn reply<T>(rx: async_channel::Receiver<Result<T, Error>>) -> Result<T, Error> {
    rt().block_on(async {
        tokio::time::timeout(Duration::from_secs(25), rx.recv())
            .await
            .expect("native deadline")
            .map_err(|_| Error::Unavailable)?
    })
}
fn ready(host: &NativeHost) {
    let changes = host.changes();
    rt().block_on(async {
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
fn read(host: &NativeHost) -> Value {
    reply(host.read_attention()).unwrap();
    host.attention_snapshot().unwrap()
}
fn command(read: &Value, kind: &str, text: &str) -> Value {
    let a = &read["actions"][0];
    let row = &a["record"];
    let mut cmd = json!({"kind":kind,"expected":{"id":row["id"],"revision":row["revision"],"digest":row["digest"]}});
    cmd[if kind == "complete" {
        "report"
    } else {
        "progress"
    }] = json!(text);
    json!({"kind":"action","authorityDigest":a["authorityDigest"],"command":cmd})
}
fn status(result: Result<IntentOutcome, Error>, expected: OutcomeStatus) {
    assert_eq!(result.unwrap().status, expected);
}
fn close(host: &NativeHost) {
    reply(host.close()).unwrap();
}

#[test]
fn real_progress_later_and_user_report_are_durable_but_never_resume_or_publish() {
    let mut f = Fixture::new();
    let host = f.open();
    let mut view = read(&host);
    assert_eq!(view["capabilities"]["help"], "unavailable");
    assert_eq!(view["capabilities"]["continuation"], "unavailable");
    status(
        reply(host.send_attention(command(&view, "progress", "  exact\n日本 💬  "))),
        OutcomeStatus::Accepted,
    );
    view = read(&host);
    assert_eq!(
        view["actions"][0]["record"]["progress"],
        "  exact\n日本 💬  "
    );
    assert!(view["actions"][0]["record"]["completion"].is_null());
    status(
        reply(host.send_attention(command(&view, "defer", "later"))),
        OutcomeStatus::Accepted,
    );
    view = read(&host);
    assert_eq!(view["actions"][0]["record"]["state"], "deferred");
    status(
        reply(host.send_attention(command(&view, "complete", "Submitted. Review is pending."))),
        OutcomeStatus::Accepted,
    );
    view = read(&host);
    assert_eq!(
        view["actions"][0]["record"]["completion"]["source"],
        "user_report"
    );
    let counts = f.cmd("stats", false);
    assert_eq!(counts["posts"], 3);
    assert_eq!(counts["sends"], 0);
    close(&host);
    f.cmd("restart", false);
    let again = f.open();
    assert_eq!(
        read(&again)["actions"][0]["record"]["completion"]["report"],
        "Submitted. Review is pending."
    );
    assert_eq!(f.cmd("stats", false)["posts"], 3);
    close(&again);
}

#[test]
fn lost_ack_and_cold_recovery_keep_exact_draft_and_only_lookup() {
    let mut f = Fixture::new();
    let host = f.open();
    let view = read(&host);
    let row = &view["actions"][0]["record"];
    let key = DraftKey {
        kind: "action".into(),
        id: "upload".into(),
        revision: row["revision"].as_u64().unwrap(),
        digest: row["digest"].as_str().unwrap().into(),
    };
    let draft = json!({"report":"  submitted\n💬 exact  ","question":"why?","selectedOption":"not consent"});
    reply(host.save_attention_draft(key.clone(), draft.clone())).unwrap();
    f.cmd("lost", true);
    assert_eq!(
        reply(host.send_attention(command(&view, "complete", "submitted"))),
        Err(Error::Unknown)
    );
    let id = host.attention_operations()[0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    close(&host);
    f.cmd("restart", false);
    let again = f.open();
    assert_eq!(again.attention_draft(&key), Some(draft));
    assert_eq!(again.attention_operations()[0]["state"], "unknown");
    f.cmd("missing", true);
    assert_eq!(
        reply(again.check_attention(id.clone())),
        Err(Error::Unknown)
    );
    assert_eq!(f.cmd("stats", false)["posts"], 1);
    f.cmd("missing", false);
    f.cmd("mismatch", true);
    assert_eq!(
        reply(again.check_attention(id.clone())),
        Err(Error::Unknown)
    );
    f.cmd("mismatch", false);
    reply(again.check_attention(id.clone())).unwrap();
    assert_eq!(
        again.attention_operations()[0]["receipt"]["value"]["record"]["completion"]["source"],
        "user_report"
    );
    f.cmd("missing", true);
    reply(again.check_attention(id)).unwrap();
    assert_eq!(again.attention_operations()[0]["state"], "acknowledged");
    assert_eq!(f.cmd("stats", false)["posts"], 1);
    close(&again);
}

#[test]
fn stale_files_and_authority_cannot_complete_old_request() {
    let mut f = Fixture::new();
    let host = f.open();
    let view = read(&host);
    f.cmd("file", true);
    status(
        reply(host.send_attention(command(&view, "complete", "done"))),
        OutcomeStatus::Rejected,
    );
    assert_eq!(f.cmd("stats", false)["state"], "pending");
    f.cmd("file", false);
    let view = read(&host);
    f.cmd("revoke", true);
    assert!(reply(host.send_attention(command(&view, "complete", "done"))).is_err());
    assert_eq!(f.cmd("stats", false)["posts"], 1);
    close(&host);
}

#[test]
fn navigation_is_permission_checked_and_never_completion_or_reopened_on_check() {
    let mut f = Fixture::new();
    let opened = Arc::new(Mutex::new(Vec::new()));
    let sink = opened.clone();
    let host = NativeHost::open_with_navigation(
        f.source(),
        f.ledger(),
        Arc::new(move |url| {
            sink.lock().unwrap().push(url.to_owned());
            Ok(())
        }),
    )
    .unwrap();
    ready(&host);
    let view = read(&host);
    let a = &view["actions"][0];
    let r = &a["record"];
    let request = json!({"kind":"resource","expected":{"id":r["id"],"revision":r["revision"],"digest":r["digest"]},"authorityDigest":a["authorityDigest"]});
    reply(host.send_attention(request)).unwrap();
    assert_eq!(
        *opened.lock().unwrap(),
        vec!["https://example.com/developer/upload"]
    );
    let id = host.attention_operations()[0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    reply(host.check_attention(id)).unwrap();
    assert_eq!(opened.lock().unwrap().len(), 1);
    assert_eq!(f.cmd("stats", false)["state"], "pending");
    close(&host);
    let again = f.open();
    assert_eq!(opened.lock().unwrap().len(), 1);
    assert_eq!(f.cmd("stats", false)["state"], "pending");
    close(&again);
}

#[test]
fn close_joins_entered_attention_before_ledger_release_and_cold_open_never_sends() {
    let mut f = Fixture::new();
    let host = f.open();
    let view = read(&host);
    f.cmd("hold", true);
    let pending = host.send_attention(command(&view, "progress", "kept"));
    f.cmd("waitEntered", false);
    let closing = host.close();
    assert!(closing.try_recv().is_err());
    f.cmd("release", false);
    reply(pending).unwrap();
    reply(closing).unwrap();
    assert_eq!(reply(host.read_attention()), Err(Error::Closed));
    let again = f.open();
    assert_eq!(read(&again)["actions"][0]["record"]["progress"], "kept");
    assert_eq!(f.cmd("stats", false)["posts"], 1);
    close(&again);
}

#[test]
fn changed_profile_identity_refuses_attention_without_sending() {
    let mut f = Fixture::new();
    let host = f.open();
    let view = read(&host);
    f.cmd("identity", true);
    assert!(reply(host.send_attention(command(&view, "complete", "done"))).is_err());
    assert_eq!(f.cmd("stats", false)["posts"], 0);
    close(&host);
}

#[test]
fn ordinary_question_answer_and_unavailable_help_use_exact_saved_transport() {
    let mut f = Fixture::new();
    let host = f.open();
    let view = read(&host);
    let request =
        json!({"kind":"help","request":{"scope":view["questions"][0]["scope"],"kind":"simpler"}});
    status(reply(host.send_attention(request)), OutcomeStatus::Rejected);
    let view = read(&host);
    let request =
        json!({"kind":"answer","scope":view["questions"][0]["scope"],"message":"Reviewed package"});
    assert_eq!(
        reply(host.send_attention(request.clone())),
        Err(Error::Unknown)
    );
    assert_eq!(reply(host.send_attention(request)), Err(Error::Unknown));
    let counts = f.cmd("stats", false);
    assert_eq!(counts["posts"], 2);
    assert_eq!(counts["sends"], 1);
    let id = host
        .attention_operations()
        .iter()
        .find(|r| r["request"]["kind"] == "answer")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    close(&host);
    let again = f.open();
    assert_eq!(reply(again.check_attention(id)), Err(Error::Unknown));
    assert_eq!(f.cmd("stats", false)["sends"], 1);
    close(&again);
}
