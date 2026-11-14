//! Creation starts in the real Rust host, never from a pre-enrolled fixture.
use nsh_core::prelude::*;
use nsh_engine::{Clock, EngineConfig, Root};
use nsh_testing::Headless;
use pilot_day_native::{
    host::{Error, NativeHost, Source},
    model::{FreshnessState, IntentOutcome, OutcomeStatus},
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
            .join("../../../packages/daemon/src/fixtures/day-planning-enrollment.ts");
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
            NativeHost::open_planning(source, ledger, "faux/faux-1".into())
        } else {
            NativeHost::open(source, ledger)
        }
        .unwrap()
    }
    fn close(&mut self, host: NativeHost) {
        reply(host.close()).unwrap();
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
fn intent(host: &NativeHost) -> NewIntent {
    reply(host.prepare_planning()).unwrap();
    NewIntent {
        setup: host.planning_setup().unwrap().digest,
        goal: "  Clarify this exact goal\n💬  ".into(),
        replaces: None,
    }
}
fn mission(host: &NativeHost) -> String {
    host.planning_enrollments()[0]["missionId"]
        .as_str()
        .unwrap()
        .into()
}
fn read(host: &NativeHost, id: &str) -> Value {
    for _ in 0..5 {
        ready(host);
        match reply(host.read_planning(id.into())) {
            Ok(_) => return host.planning(id).unwrap(),
            Err(Error::Stale) => continue, // Only passive GET, raced by an invalidation.
            other => panic!("planning read: {other:?}"),
        }
    }
    panic!("planning GET did not settle after bounded invalidations");
}
#[track_caller]
fn status(result: Result<IntentOutcome, Error>) -> OutcomeStatus {
    result.unwrap().status
}

fn answer_all(host: &NativeHost, id: &str) {
    let v = read(host, id);
    let i = &v["view"]["interview"];
    let answers: Vec<Value> = i["questions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|q| {
            json!({
        "questionId":q["id"],"questionDigest":v["questionDigests"][q["id"].as_str().unwrap()],
        "selectedOption":q["options"][0],"text":""})
        })
        .collect();
    assert_eq!(status(reply(host.write_interview(id.into(), v["contextDigest"].as_str().unwrap().into(), json!({
        "purpose":"interview-save","expected":{"fence":i["fence"],"revision":i["revision"]},"answers":answers
    })))), OutcomeStatus::Accepted);
}

fn submit(host: &NativeHost, id: &str) -> Result<IntentOutcome, Error> {
    let v = read(host, id);
    let i = &v["view"]["interview"];
    reply(host.write_interview(
        id.into(),
        v["contextDigest"].as_str().unwrap().into(),
        json!({
            "purpose":"interview-submit","expected":{"fence":i["fence"],"revision":i["revision"]}
        }),
    ))
}

#[test]
fn discovery_requires_native_model_and_current_profile_without_admitting_anything() {
    let mut f = Fixture::new();
    let host = f.open(false);
    ready(&host);
    assert_eq!(reply(host.prepare_planning()), Err(Error::Unavailable));
    assert!(host.planning_setup().is_none());
    assert_eq!(
        host.snapshot().freshness.state,
        FreshnessState::Live,
        "unconfigured New does not disable Today"
    );
    reply(host.close()).unwrap();
    let host = f.open(true);
    ready(&host);
    f.cmd("unavailable", true);
    assert_eq!(reply(host.prepare_planning()), Err(Error::Unavailable));
    assert!(host.planning_setup().is_none());
    f.cmd("unavailable", false);
    let first = intent(&host);
    assert_eq!(host.planning_setup().unwrap().model, "faux/faux-1");
    reply(host.prepare_planning()).unwrap();
    assert_eq!(
        host.planning_setup().unwrap().digest,
        first.setup,
        "passive refresh does not replace unconsumed identity"
    );
    assert_eq!(f.cmd("stats", false)["posts"], 0);
    assert_eq!(f.cmd("stats", false)["workers"], 0);
    f.close(host);
}

#[test]
fn exact_new_enrollment_preparing_then_full_round_and_duplicate_intent_never_builds() {
    let mut f = Fixture::new();
    let host = f.open(true);
    ready(&host);
    let new = intent(&host);
    assert_eq!(
        status(reply(host.enroll_planning(new.clone()))),
        OutcomeStatus::Accepted
    );
    let id = mission(&host);
    let v = read(&host, &id);
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
        status(reply(host.enroll_planning(new.clone()))),
        OutcomeStatus::Accepted
    );
    let changed = NewIntent {
        goal: "different".into(),
        ..new.clone()
    };
    assert_eq!(reply(host.enroll_planning(changed)), Err(Error::Stale));
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
    reply(host.prepare_planning()).unwrap();
    assert_ne!(
        host.planning_setup().unwrap().digest,
        new.setup,
        "a later New gets fresh identities"
    );
    f.close(host);
}

#[test]
fn stop_and_pause_after_native_creation_never_admit_a_continuation_or_build() {
    for action in ["stop", "pause"] {
        let mut f = Fixture::new();
        let host = f.open(true);
        ready(&host);
        // Exercise actual Stop/Pause admission fences without relying on a WS
        // invalidation racing the write first. Every host probe still uses GET.
        f.cmd("quiet", true);
        let new = intent(&host);
        assert_eq!(
            status(reply(host.enroll_planning(new))),
            OutcomeStatus::Accepted
        );
        let id = mission(&host);
        f.cmd("generate", true);
        f.cmd("held", false);
        answer_all(&host, &id);
        f.cmd(action, true);
        assert_eq!(status(submit(&host, &id)), OutcomeStatus::Accepted);
        f.cmd("drain", false);
        let stats = f.cmd("stats", false);
        assert_eq!(stats["requests"], 1, "{action} holds planning admission");
        assert_eq!(stats["tasks"], 0);
        f.close(host);
    }
}

#[test]
fn changed_owner_cannot_use_the_retained_read_to_answer() {
    let mut f = Fixture::new();
    let host = f.open(true);
    ready(&host);
    let new = intent(&host);
    assert_eq!(
        status(reply(host.enroll_planning(new))),
        OutcomeStatus::Accepted
    );
    let id = mission(&host);
    f.cmd("generate", true);
    f.cmd("held", false);
    let v = read(&host, &id);
    f.cmd("owner", true);
    let i = &v["view"]["interview"];
    assert!(reply(host.write_interview(id, v["contextDigest"].as_str().unwrap().into(), json!({
        "purpose":"interview-submit","expected":{"fence":i["fence"],"revision":i["revision"]}
    }))).is_err());
    assert_eq!(f.cmd("stats", false)["posts"], 1);
    f.close(host);
}

#[test]
fn changed_configuration_project_and_post_journal_probe_refuse_before_enrollment() {
    let mut f = Fixture::new();
    let host = f.open(true);
    ready(&host);
    let old = intent(&host);
    f.cmd("configuration", true);
    assert!(matches!(
        reply(host.enroll_planning(old)),
        Err(Error::Stale)
    ));
    assert_eq!(f.cmd("stats", false)["posts"], 0);
    let new = intent(&host);
    f.cmd("project", true);
    assert_eq!(reply(host.enroll_planning(new)), Err(Error::Identity));
    assert!(host.planning_setup().is_none());
    f.cmd("project", false);
    let new = intent(&host);
    f.cmd("change-after-journal", true);
    assert!(matches!(
        reply(host.enroll_planning(new)),
        Err(Error::Stale)
    ));
    assert_eq!(f.cmd("stats", false)["posts"], 0);
    assert_eq!(host.planning_enrollments()[0]["state"], "not-sent");
    f.close(host);
}

#[test]
fn lost_ack_restart_missing_and_wrong_result_only_lookup_the_exact_enrollment() {
    let mut f = Fixture::new();
    let host = f.open(true);
    ready(&host);
    let new = intent(&host);
    f.cmd("lost", true);
    assert_eq!(
        status(reply(host.enroll_planning(new.clone()))),
        OutcomeStatus::Unknown
    );
    assert_eq!(
        status(reply(host.enroll_planning(new.clone()))),
        OutcomeStatus::Unknown
    );
    assert_eq!(reply(host.prepare_planning()), Err(Error::Unknown));
    let op = host.planning_enrollments()[0]["operationId"]
        .as_str()
        .unwrap()
        .to_owned();
    reply(host.close()).unwrap();
    f.cmd("generate", true);
    f.cmd("held", false);
    f.cmd("restart", true);
    let host = f.open(true);
    ready(&host);
    assert_eq!(f.cmd("stats", false)["posts"], 1);
    assert_eq!(
        f.cmd("stats", false)["workers"],
        1,
        "cold open never starts a historical worker"
    );
    assert_eq!(
        status(reply(host.enroll_planning(new))),
        OutcomeStatus::Unknown
    );
    f.cmd("missing", true);
    assert_eq!(reply(host.check_planning(op.clone())), Err(Error::Unknown));
    f.cmd("missing", false);
    for detail in ["hash", "owner", "enrollment"] {
        f.command(json!({"action":"mismatch","value":true,"detail":detail}));
        assert_eq!(reply(host.check_planning(op.clone())), Err(Error::Unknown));
    }
    f.cmd("mismatch", false);
    assert_eq!(
        status(reply(host.check_planning(op.clone()))),
        OutcomeStatus::Accepted
    );
    f.cmd("missing", true);
    assert_eq!(
        status(reply(host.check_planning(op))),
        OutcomeStatus::Accepted,
        "terminal ACK cannot be erased"
    );
    assert_eq!(f.cmd("stats", false)["posts"], 1);
    f.close(host);
}

#[test]
fn close_joins_entered_enrollment_and_preserves_its_receipt() {
    let mut f = Fixture::new();
    let host = f.open(true);
    ready(&host);
    let new = intent(&host);
    f.cmd("block", true);
    let sending = host.enroll_planning(new);
    assert_eq!(f.cmd("entered", false)["held"], true);
    let closing = host.close();
    assert!(closing.try_recv().is_err());
    assert_eq!(reply(host.prepare_planning()), Err(Error::Closed));
    f.cmd("release", true);
    assert_eq!(status(reply(sending)), OutcomeStatus::Accepted);
    reply(closing).unwrap();
    let host = f.open(true);
    ready(&host);
    assert_eq!(host.planning_enrollments()[0]["state"], "accepted");
    assert_eq!(f.cmd("stats", false)["posts"], 1);
    f.close(host);
}

#[test]
fn interrupted_before_daemon_entry_stays_unknown_after_restart_without_historical_send() {
    let mut f = Fixture::new();
    let host = f.open(true);
    ready(&host);
    let new = intent(&host);
    f.cmd("drop-before", true);
    assert_eq!(
        status(reply(host.enroll_planning(new.clone()))),
        OutcomeStatus::Unknown
    );
    let operation = host.planning_enrollments()[0]["operationId"]
        .as_str()
        .unwrap()
        .to_owned();
    reply(host.close()).unwrap();
    f.cmd("restart", true);
    let host = f.open(true);
    ready(&host);
    assert_eq!(reply(host.check_planning(operation)), Err(Error::Unknown));
    assert_eq!(
        status(reply(host.enroll_planning(new))),
        OutcomeStatus::Unknown
    );
    assert_eq!(reply(host.prepare_planning()), Err(Error::Unknown));
    let stats = f.cmd("stats", false);
    assert_eq!(
        stats["posts"], 1,
        "only the interrupted original attempt entered the proxy"
    );
    assert_eq!(stats["workers"], 0);
    assert_eq!(stats["requests"], 0);
    f.close(host);
}

#[derive(Debug, Clone, PartialEq, Props)]
struct FeedProbeProps {
    source: Prop<String>,
    ledger: Prop<String>,
}

#[component]
fn FeedProbe(props: FeedProbeProps) -> impl IntoElement {
    let source: Source = serde_json::from_str(&props.source.get()).unwrap();
    let host =
        NativeHost::open_planning(source, props.ledger.get().into(), "faux/faux-1".into()).unwrap();
    let feed = Instance::new(pilot_day_native::PlanFeed::from_host(host.clone()));
    let state = signal("waiting".to_owned());
    spawn(async move {
        let changes = host.changes();
        while host.snapshot().freshness.state != FreshnessState::Live {
            changes.recv().await.unwrap();
        }
        let prepared = pilot_day_native::PlanFeed::prepare_new(feed.clone()).await;
        assert_eq!(prepared.status, OutcomeStatus::Accepted);
        let shown = feed.with(|f| f.snapshot());
        assert!(shown.can_create);
        assert!(!shown.can_start);
        assert!(!shown.start_reason.is_empty());
        let new = NewIntent {
            goal: "Exact feed goal".into(),
            setup: shown.setup.digest,
            replaces: None,
        };
        assert_eq!(
            pilot_day_native::PlanFeed::start(feed.clone(), new.clone())
                .await
                .status,
            OutcomeStatus::Rejected
        );
        assert_eq!(
            pilot_day_native::PlanFeed::plan(feed.clone(), new.clone())
                .await
                .status,
            OutcomeStatus::Unknown
        );
        assert!(!feed.with(|f| f.snapshot()).can_create);
        assert_eq!(
            pilot_day_native::PlanFeed::prepare_new(feed.clone())
                .await
                .status,
            OutcomeStatus::Unknown
        );
        let checked = pilot_day_native::PlanFeed::check_new(feed.clone()).await;
        assert_eq!(checked.status, OutcomeStatus::Accepted);
        let mission = checked.mission_id.unwrap();
        // A receipt settles creation, not the asynchronously refreshed page.
        while feed.with(|f| f.page(mission.clone())).is_none() {
            changes.recv().await.unwrap();
        }
        let page = feed.with(|f| f.page(mission)).unwrap();
        assert!(page.interview.is_none());
        assert_eq!(page.stage, PlanStage::Planning);
        assert_eq!(
            pilot_day_native::PlanFeed::plan(feed.clone(), new)
                .await
                .status,
            OutcomeStatus::Accepted
        );
        feed.dispose();
        host.close().recv().await.unwrap().unwrap();
        state.set("feed creation checked".into());
    });
    text(move || state.get())
}

#[test]
fn root_owned_plan_feed_creates_only_missions_and_checks_unknown_without_resend() {
    let mut f = Fixture::new();
    f.cmd("lost", true);
    let source = serde_json::to_string(&f.info["source"]).unwrap();
    let ledger = f.info["ledger"].as_str().unwrap().to_owned();
    let root = Root::new::<FeedProbe>(move || FeedProbeProps {
        source: source.clone().into(),
        ledger: ledger.clone().into(),
    });
    let mut app = Headless::start(EngineConfig {
        clock: Clock::manual(std::time::UNIX_EPOCH),
        ..EngineConfig::new(root)
    })
    .unwrap();
    app.wait_for_within("feed creation checked", Duration::from_secs(30))
        .unwrap();
    assert_eq!(f.cmd("stats", false)["posts"], 1);
    drop(app);
    f.cmd("close", false);
    assert!(f.child.wait().unwrap().success());
}
