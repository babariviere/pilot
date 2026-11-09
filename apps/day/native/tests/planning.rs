//! Actual native worker, credential reader, command ledger and isolated production daemon.
use pilot_day_native::{
    host::{Error, NativeHost, Source},
    model::{FreshnessState, OutcomeStatus},
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
            .join("../../../packages/daemon/src/fixtures/day-native-planning.ts");
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
        writeln!(self.input, "{}", json!({"action":action,"value":value})).unwrap();
        self.input.flush().unwrap();
        self.output.recv_timeout(Duration::from_secs(25)).unwrap()
    }
    fn mission(&self) -> &str {
        self.info["mission"].as_str().unwrap()
    }
    fn open(&self) -> NativeHost {
        let source: Source = serde_json::from_value(self.info["source"].clone()).unwrap();
        NativeHost::open(source, self.info["ledger"].as_str().unwrap().into()).unwrap()
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
            .unwrap()
            .map_err(|_| Error::Unavailable)?
    })
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
fn read(host: &NativeHost, mission: &str) -> Value {
    reply(host.read_planning(mission.into())).unwrap();
    host.planning(mission).unwrap()
}
fn write(
    host: &NativeHost,
    mission: &str,
    view: &Value,
    submit: bool,
    text: &str,
) -> async_channel::Receiver<Result<pilot_day_native::model::IntentOutcome, Error>> {
    let i = &view["view"]["interview"];
    let mut request = json!({"purpose":if submit {"interview-submit"} else {"interview-save"},
        "expected":{"fence":i["fence"],"revision":i["revision"]}});
    if !submit {
        let q = &i["questions"][0];
        let digest = &view["questionDigests"][q["id"].as_str().unwrap()];
        request["answers"] = json!([{"questionId":q["id"],"questionDigest":digest,"selectedOption":q["options"][0],"text":text}]);
    }
    host.write_interview(
        mission.into(),
        view["contextDigest"].as_str().unwrap().into(),
        request,
    )
}

#[test]
fn drafts_restart_submission_and_cold_open_never_replay() {
    let mut f = Fixture::new();
    let host = f.open();
    ready(&host);
    let v = read(&host, f.mission());
    assert_eq!(v["capabilities"]["continuation"], "unavailable");
    assert_eq!(
        reply(write(&host, f.mission(), &v, false, " exact\n💬 "))
            .unwrap()
            .status,
        OutcomeStatus::Accepted
    );
    let v = read(&host, f.mission());
    assert_eq!(v["view"]["interview"]["answers"][0]["text"], " exact\n💬 ");
    reply(host.close()).unwrap();
    f.cmd("restart", true);
    let host = f.open();
    ready(&host);
    assert_eq!(f.cmd("stats", true)["posts"], 1);
    let v = read(&host, f.mission());
    assert_eq!(v["view"]["interview"]["submission"], Value::Null);
    assert_eq!(
        reply(write(&host, f.mission(), &v, true, ""))
            .unwrap()
            .status,
        OutcomeStatus::Accepted
    );
    let v = read(&host, f.mission());
    assert!(v["view"]["interview"]["submission"]["operationId"].is_string());
    assert_eq!(f.cmd("stats", true)["posts"], 2);
    reply(host.close()).unwrap();
}

#[test]
fn lost_ack_exact_lookup_missing_and_mismatched_receipts_never_resend() {
    let mut f = Fixture::new();
    let host = f.open();
    ready(&host);
    let v = read(&host, f.mission());
    f.cmd("lost", true);
    assert_eq!(
        reply(write(&host, f.mission(), &v, false, "kept"))
            .unwrap()
            .status,
        OutcomeStatus::Unknown
    );
    let id = host.planning_operations(f.mission())[0]["operationId"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(matches!(
        reply(write(&host, f.mission(), &v, false, "no retry")),
        Err(Error::Unknown)
    ));
    reply(host.close()).unwrap();
    let host = f.open();
    ready(&host);
    assert_eq!(f.cmd("stats", true)["posts"], 1);
    f.cmd("missing", true);
    assert_eq!(reply(host.check_planning(id.clone())), Err(Error::Unknown));
    f.cmd("missing", false);
    f.cmd("mismatch", true);
    assert_eq!(reply(host.check_planning(id.clone())), Err(Error::Unknown));
    f.cmd("mismatch", false);
    assert_eq!(
        reply(host.check_planning(id.clone())).unwrap().status,
        OutcomeStatus::Accepted
    );
    f.cmd("missing", true);
    assert_eq!(
        reply(host.check_planning(id)).unwrap().status,
        OutcomeStatus::Accepted,
        "keep matched ACK"
    );
    assert_eq!(f.cmd("stats", true)["posts"], 1);
    reply(host.close()).unwrap();
}

#[test]
fn close_fences_new_actions_and_joins_entered_http_and_journal() {
    let mut f = Fixture::new();
    let host = f.open();
    ready(&host);
    let v = read(&host, f.mission());
    f.cmd("block", true);
    let saving = write(&host, f.mission(), &v, false, "joined");
    assert_eq!(f.cmd("entered", true)["held"], true);
    let closing = host.close();
    assert!(
        closing.try_recv().is_err(),
        "close cannot precede entered HTTP"
    );
    assert_eq!(
        reply(host.read_planning(f.mission().into())),
        Err(Error::Closed)
    );
    f.cmd("release", true);
    assert_eq!(reply(saving).unwrap().status, OutcomeStatus::Accepted);
    reply(closing).unwrap();
    let host = f.open();
    ready(&host);
    let v = read(&host, f.mission());
    assert_eq!(v["view"]["interview"]["answers"][0]["text"], "joined");
    assert_eq!(f.cmd("stats", true)["posts"], 1);
    reply(host.close()).unwrap();
}
