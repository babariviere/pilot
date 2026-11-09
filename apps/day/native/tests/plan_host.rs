//! The planning read model and intents over the real native host and an
//! isolated production daemon: backend digests, exact save and submit
//! requests, topic binding, stale refusal, lost answers and honest
//! unavailable steps. No worker, provider or live home is used.
use pilot_day_native::{
    host::{Error, NativeHost, Source},
    model::{FreshnessState, IntentOutcome},
    plan::{
        AnswerIntent, OutcomeStatus, PlanStage, QuestionState, RoundKind, StepState, SubmitIntent,
        SubmitState,
    },
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
    fn mission(&self) -> String {
        self.info["mission"].as_str().unwrap().to_owned()
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
fn send(host: &NativeHost, mission: &str, built: (String, Value)) -> Result<IntentOutcome, Error> {
    reply(host.write_interview(mission.into(), built.0, built.1))
}

/// The answer the screen would send for the first question as shown.
fn intent(read: &Value, choice: Option<&str>, text: &str) -> AnswerIntent {
    let page = plan_host::page(read, &[], &Local::default());
    let iv = page.interview.unwrap();
    let q = &iv.questions[0];
    AnswerIntent {
        interview_id: iv.id,
        question_set: iv.question_set,
        question_id: q.id.clone(),
        digest: q.digest.clone(),
        choice_id: choice.map(Into::into),
        text: text.into(),
    }
}

#[test]
fn the_real_read_maps_with_backend_digests_and_honest_unavailable_steps() {
    let f = Fixture::new();
    let host = f.open();
    ready(&host);
    let mission = f.mission();
    let v = read(&host, &mission);
    let page = plan_host::page(&v, &host.planning_operations(&mission), &Local::default());
    assert!(page.available && page.fresh);
    assert_eq!(page.stage, PlanStage::Questions);
    let iv = page.interview.clone().unwrap();
    assert_eq!(iv.kind, RoundKind::Mission);
    let q = &iv.questions[0];
    assert_eq!(q.digest, v["questionDigests"][&q.id].as_str().unwrap());
    assert_eq!(q.state, QuestionState::Open);
    assert!(q.choices[0].recommended, "recommended, not chosen");
    assert_eq!(q.chosen, None);
    let step = |label: &str| page.steps.iter().find(|s| s.label == label).unwrap().state;
    assert_eq!(step("Pilot continues planning"), StepState::Unavailable);
    assert_eq!(step("Work started"), StepState::Unavailable);
    assert!(!page.prototypes.available);
    reply(host.close()).unwrap();
}

#[test]
fn saves_and_one_submission_go_through_the_exact_host_requests() {
    let mut f = Fixture::new();
    let host = f.open();
    ready(&host);
    let mission = f.mission();
    let v = read(&host, &mission);
    // A recommendation is not an answer: submitting now is refused before sending.
    let page = plan_host::page(&v, &[], &Local::default());
    let iv = page.interview.unwrap();
    let submit = SubmitIntent {
        interview_id: iv.id.clone(),
        revision: iv.revision,
        proposal: String::new(),
    };
    assert_eq!(
        plan_host::submit_request(&v, &submit).unwrap_err().0,
        OutcomeStatus::Rejected
    );
    assert_eq!(f.cmd("stats", true)["posts"], 0);
    let save = plan_host::save_request(&v, &intent(&v, Some("fix"), " exact\n💬 ")).unwrap();
    assert_eq!(
        save.1["answers"][0]["selectedOption"],
        json!({"id":"fix","meaning":"Fix the importer"})
    );
    assert_eq!(
        send(&host, &mission, save).unwrap().status,
        OutcomeStatus::Accepted
    );
    let v = read(&host, &mission);
    let page = plan_host::page(&v, &host.planning_operations(&mission), &Local::default());
    let iv = page.interview.unwrap();
    let q = &iv.questions[0];
    assert_eq!(
        (q.state, q.chosen.as_deref(), q.text.as_str()),
        (QuestionState::Answered, Some("fix"), " exact\n💬 ")
    );
    assert_eq!(iv.answered, 1);
    // Switching to own words keeps the text, exactly.
    let custom = plan_host::save_request(&v, &intent(&v, None, " exact\n💬 ")).unwrap();
    assert_eq!(
        send(&host, &mission, custom).unwrap().status,
        OutcomeStatus::Accepted
    );
    let v = read(&host, &mission);
    let iv = plan_host::page(&v, &[], &Local::default())
        .interview
        .unwrap();
    assert_eq!(
        (iv.questions[0].chosen.clone(), iv.questions[0].state),
        (None, QuestionState::Answered)
    );
    let submit = SubmitIntent {
        interview_id: iv.id.clone(),
        revision: iv.revision,
        proposal: String::new(),
    };
    let built = plan_host::submit_request(&v, &submit).unwrap();
    assert_eq!(
        send(&host, &mission, built).unwrap().status,
        OutcomeStatus::Accepted
    );
    let v = read(&host, &mission);
    let page = plan_host::page(&v, &host.planning_operations(&mission), &Local::default());
    assert_eq!(
        page.interview.as_ref().unwrap().submit,
        SubmitState::Submitted
    );
    assert_eq!(
        page.stage,
        PlanStage::Submitted,
        "continuation is unavailable, so nothing is planning"
    );
    assert_eq!(page.steps[0].state, StepState::Done);
    // Submitted answers are fixed, and a second submission is refused before sending.
    let posts = f.cmd("stats", true)["posts"].clone();
    assert!(plan_host::save_request(&v, &intent(&v, Some("fix"), "")).is_err());
    assert!(plan_host::submit_request(&v, &submit).is_err());
    assert_eq!(f.cmd("stats", true)["posts"], posts);
    reply(host.close()).unwrap();
}

#[test]
fn shown_fences_refuse_before_sending_and_bind_the_round() {
    let mut f = Fixture::new();
    let host = f.open();
    ready(&host);
    let mission = f.mission();
    let v = read(&host, &mission);
    let mut stale = intent(&v, Some("fix"), "");
    stale.digest = "0".repeat(64);
    assert_eq!(
        plan_host::save_request(&v, &stale).unwrap_err().0,
        OutcomeStatus::Stale
    );
    let mut other = intent(&v, Some("fix"), "");
    other.question_id = "elsewhere".into();
    assert_eq!(
        plan_host::save_request(&v, &other).unwrap_err().0,
        OutcomeStatus::Rejected
    );
    let mut round = intent(&v, Some("fix"), "");
    round.interview_id = "another-round-1".into();
    assert_eq!(
        plan_host::save_request(&v, &round).unwrap_err().0,
        OutcomeStatus::Stale
    );
    let mut gone = intent(&v, Some("withdrawn"), "");
    gone.choice_id = Some("withdrawn".into());
    assert_eq!(
        plan_host::save_request(&v, &gone).unwrap_err().0,
        OutcomeStatus::Stale
    );
    let mut long = intent(&v, None, "");
    long.text = "x".repeat(13 * 1024);
    assert_eq!(
        plan_host::save_request(&v, &long).unwrap_err().0,
        OutcomeStatus::Rejected
    );
    assert_eq!(f.cmd("stats", true)["posts"], 0);
    reply(host.close()).unwrap();
}

#[test]
fn a_lost_answer_is_unconfirmed_and_only_checked() {
    let mut f = Fixture::new();
    let host = f.open();
    ready(&host);
    let mission = f.mission();
    let v = read(&host, &mission);
    f.cmd("lost", true);
    let save = plan_host::save_request(&v, &intent(&v, Some("fix"), "kept")).unwrap();
    assert_eq!(
        send(&host, &mission, save).unwrap().status,
        OutcomeStatus::Unknown
    );
    let ops = host.planning_operations(&mission);
    let page = plan_host::page(&v, &ops, &Local::default());
    assert!(page.interview.unwrap().unconfirmed);
    assert_eq!(page.stage, PlanStage::Unknown);
    let id = plan_host::unsettled_operation(&ops).unwrap();
    assert_eq!(
        reply(host.check_planning(id)).unwrap().status,
        OutcomeStatus::Accepted
    );
    let v = read(&host, &mission);
    let page = plan_host::page(&v, &host.planning_operations(&mission), &Local::default());
    assert!(!page.interview.as_ref().unwrap().unconfirmed);
    assert_eq!(page.interview.unwrap().questions[0].text, "kept");
    assert_eq!(f.cmd("stats", true)["posts"], 1, "checked, never resent");
    reply(host.close()).unwrap();
}

#[test]
fn a_mission_without_a_saved_interview_is_unavailable_not_empty() {
    let read = json!({"version":1,"projectId":"p","missionId":"m","status":"not-enrolled",
        "contextDigest":null,"view":null,"fresh":true,
        "capabilities":{"answers":"unavailable","continuation":"unavailable"}});
    let page = plan_host::page(&read, &[], &Local::default());
    assert!(!page.available);
    assert!(page.interview.is_none());
    assert!(page.reason.contains("Nothing was changed"));
    let refused = plan_host::save_request(&read, &AnswerIntent::default()).unwrap_err();
    assert_eq!(refused.0, OutcomeStatus::Rejected);
}

#[test]
fn a_round_without_questions_is_never_shown_or_submittable() {
    let fence = json!({"missionId":"m","ownerSessionId":"o","enrollmentId":"e","questionSetRevision":1,"answerRevision":0});
    let read = json!({"version":1,"projectId":"p","missionId":"m","status":"available","contextDigest":"0".repeat(64),
        "questionDigests":{},"fresh":true,"capabilities":{"answers":1,"continuation":"unavailable"},
        "view":{"plan":null,"destination":"d","interview":{"fence":fence,"revision":1,"questions":[],"answers":[],"submission":null}}});
    let page = plan_host::page(&read, &[], &Local::default());
    assert!(page.available && page.interview.is_none());
    let submit = SubmitIntent {
        interview_id: "e-1".into(),
        revision: 1,
        proposal: String::new(),
    };
    assert_eq!(
        plan_host::submit_request(&read, &submit).unwrap_err().0,
        OutcomeStatus::Rejected
    );
}
