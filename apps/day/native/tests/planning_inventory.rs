//! Complete inventory mapping and the same-worker real-daemon path, no visible app.
use pilot_day_native::{
    host::{Error, NativeHost, Source},
    plan::{PlanAvailability, PlanStage},
    plan_host,
};
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::mpsc,
    time::Duration,
};

fn item(id: &str, stage: &str, needs: bool) -> Value {
    json!({"missionId":id,"title":format!("Title {id}"),"stage":stage,"needsYou":needs,
        "round":{"missionId":id,"ownerSessionId":"owner","enrollmentId":"enrollment","questionSetRevision":2,"answerRevision":1},
        "interviewRevision":4,"planRevision":3})
}
fn inventory(items: Vec<Value>) -> Value {
    json!({"version":1,"projectId":"project","status":"available","limit":100,"total":items.len(),"items":items})
}

#[test]
fn complete_inventory_maps_plan_rows_without_an_open_page() {
    let read = inventory(vec![
        item("one", "questions", true),
        item("two", "review", true),
        item("three", "published", false),
    ]);
    let rows = plan_host::inventory_rows(&read).unwrap();
    assert_eq!(rows.len(), 3);
    assert_eq!(rows[0].title, "Title one");
    assert_eq!(rows[1].stage, PlanStage::Review);
    assert_eq!(
        rows[1].identity.as_ref().unwrap().interview_id,
        "enrollment-2"
    );
    assert_eq!(rows[1].identity.as_ref().unwrap().interview_revision, 4);
    assert_eq!(rows[1].identity.as_ref().unwrap().plan_revision, Some(3));
    assert!(rows[1].needs_you);
    assert!(!rows[2].needs_you);
    assert!(
        plan_host::inventory_rows(&inventory(vec![]))
            .unwrap()
            .is_empty()
    );
    for change in [
        json!({"total":4}),
        json!({"status":"unavailable"}),
        json!({"limit":1}),
        json!({"items":null}),
    ] {
        let mut bad = read.clone();
        for (key, value) in change.as_object().unwrap() {
            bad[key] = value.clone();
        }
        assert!(plan_host::inventory_rows(&bad).is_err(), "{bad}");
    }
    for key in ["round", "interviewRevision", "needsYou", "stage"] {
        let mut bad = read.clone();
        bad["items"][0].as_object_mut().unwrap().remove(key);
        assert!(plan_host::inventory_rows(&bad).is_err(), "missing {key}");
    }
    assert!(
        plan_host::inventory_rows(&inventory(vec![
            item("one", "questions", true),
            item("one", "questions", true)
        ]))
        .is_err()
    );
}

struct Fixture {
    child: Child,
    input: ChildStdin,
    output: mpsc::Receiver<Value>,
    info: Value,
}
impl Fixture {
    fn new() -> Self {
        let script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../packages/daemon/src/fixtures/day-planning-inventory.ts");
        let mut child = Command::new("node")
            .arg(script)
            .env_remove("NODE_TEST_CONTEXT")
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
                if let Ok(value) = serde_json::from_str(&line) {
                    if tx.send(value).is_err() {
                        break;
                    }
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
    fn cmd(&mut self, action: &str, value: bool) {
        writeln!(self.input, "{}", json!({"action":action,"value":value})).unwrap();
        self.input.flush().unwrap();
        self.info = self.output.recv_timeout(Duration::from_secs(25)).unwrap();
    }
    fn open(&self) -> NativeHost {
        NativeHost::open(
            serde_json::from_value::<Source>(self.info["source"].clone()).unwrap(),
            PathBuf::from(self.info["ledger"].as_str().unwrap()),
        )
        .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        if let Some(home) = self.info["source"]["profile"].as_str() {
            let _ = std::fs::remove_dir_all(home);
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
            .unwrap()
    })
}
fn wait(host: &NativeHost, count: usize) {
    let changes = host.changes();
    rt().block_on(async {
        tokio::time::timeout(Duration::from_secs(25), async {
            loop {
                let read = host.planning_inventory_snapshot();
                if read.availability == PlanAvailability::Live && read.plans.len() == count {
                    break;
                }
                changes.recv().await.unwrap();
            }
        })
        .await
        .unwrap();
    });
}

#[test]
fn real_inventory_survives_restart_revocation_is_unavailable_and_ws_only_invalidates() {
    let mut f = Fixture::new();
    let host = f.open();
    let _ = reply(host.read_planning_inventory());
    wait(&host, 3);
    assert!(
        host.planning(f.info["mission"].as_str().unwrap()).is_none(),
        "no selected detail required"
    );
    let before = host.planning_inventory_snapshot().plans;
    reply(host.close()).unwrap();
    f.cmd("restart", false);
    let host = f.open();
    let _ = reply(host.read_planning_inventory());
    wait(&host, 3);
    assert_eq!(host.planning_inventory_snapshot().plans, before);
    f.cmd("create", false);
    wait(&host, 4);
    f.cmd("revoke", true);
    assert!(reply(host.read_planning_inventory()).is_err());
    assert_eq!(
        host.planning_inventory_snapshot().availability,
        PlanAvailability::Unavailable
    );
    f.cmd("revoke", false);
    reply(host.read_planning_inventory()).unwrap();
    wait(&host, 4);
    f.cmd("empty", false);
    wait(&host, 0);
    reply(host.close()).unwrap();
}
