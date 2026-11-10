//! TodayFeed's decision and action cards over the real native host and an
//! isolated production daemon: drafts that survive a safe close and a
//! restart, the user's own Later, a replaced request, exact acknowledged
//! completion, a lost answer that is only looked up, help that stays
//! unavailable and a link that reports nothing. Headless with a manual
//! clock; no provider, worker, visible window or real navigation.
use nsh_core::prelude::*;
use nsh_engine::{Clock, EngineConfig, Root};
use nsh_testing::Headless;
use pilot_day_native::{
    TodayFeed,
    host::{NativeHost, Source},
    model::{
        ActionRef, ActionState, AskIntent, CompleteIntent, DecideIntent, DecisionRef, Delivery,
        DraftIntent, FreshnessState, OutcomeStatus, Today,
    },
};
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc,
    },
    time::Duration,
};

static OPENED: AtomicUsize = AtomicUsize::new(0);

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
    /// Runs one headless phase until it says "done".
    fn phase(&self, phase: &str) {
        let source = serde_json::to_string(&self.info["source"]).unwrap();
        let ledger = self.info["ledger"].as_str().unwrap().to_owned();
        let phase = phase.to_owned();
        let root = Root::new::<Probe>(move || ProbeProps {
            source: source.clone().into(),
            ledger: ledger.clone().into(),
            phase: phase.clone().into(),
        });
        let mut app = Headless::start(EngineConfig {
            clock: Clock::manual(std::time::UNIX_EPOCH),
            ..EngineConfig::new(root)
        })
        .unwrap();
        app.wait_for_within("done", Duration::from_secs(60))
            .unwrap();
        drop(app);
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

#[derive(Debug, Clone, PartialEq, Props)]
struct ProbeProps {
    source: Prop<String>,
    ledger: Prop<String>,
    phase: Prop<String>,
}

/// Waits for a live attention read that satisfies "ready".
async fn live(
    host: &NativeHost,
    feed: &Instance<TodayFeed>,
    ready: impl Fn(&Today) -> bool,
) -> Today {
    let changes = host.changes();
    loop {
        let today = feed.with(|f| f.snapshot());
        if today.attention.state == FreshnessState::Live && ready(&today) {
            return today;
        }
        changes.recv().await.unwrap();
    }
}

fn status(outcome: pilot_day_native::model::IntentOutcome) -> OutcomeStatus {
    eprintln!("outcome {:?}: {}", outcome.status, outcome.message);
    outcome.status
}

async fn run(phase: &str, source: Source, ledger: PathBuf) {
    let host = if phase == "link" {
        NativeHost::open_with_navigation(
            source,
            ledger,
            std::sync::Arc::new(|url: &str| {
                assert_eq!(url, "https://example.com/developer/upload");
                OPENED.fetch_add(1, Ordering::SeqCst);
                Ok(())
            }),
        )
        .unwrap()
    } else {
        NativeHost::open(source, ledger).unwrap()
    };
    let feed = Instance::new(TodayFeed::from_host(host.clone()));
    feed.with(|f| f.set_draft_delay(Duration::ZERO));
    match phase {
        "first" => {
            let t = live(&host, &feed, |t| {
                !t.actions.is_empty() && !t.decisions.is_empty()
            })
            .await;
            let d = t.decisions[0].clone();
            let a = t.actions[0].clone();
            assert!(d.reply);
            assert!(d.help_unavailable.is_some());
            assert_eq!(d.options[0].label, "Reviewed package");
            assert!(!a.can_open, "no root opener, no link button");
            // Unavailable help and a link without an opener send nothing.
            let ask = AskIntent {
                decision_id: d.id.clone(),
                revision: d.revision,
                question: "Why?".into(),
            };
            assert_eq!(
                status(TodayFeed::ask(feed.clone(), ask).await),
                OutcomeStatus::Rejected
            );
            let shown = ActionRef {
                action_id: a.id.clone(),
                revision: a.revision,
            };
            assert_eq!(
                status(TodayFeed::open_link(feed.clone(), shown.clone()).await),
                OutcomeStatus::Rejected
            );
            // Drafts name the exact revision shown.
            let words = "  exact\n日本 💬  ";
            let draft =
                |item: &str, revision: u32, pick: Option<&str>, text: &str, question: &str| {
                    DraftIntent {
                        item_id: item.into(),
                        revision,
                        pick: pick.map(str::to_owned),
                        text: text.into(),
                        question: question.into(),
                    }
                };
            let saved = feed.with_mut(|f| f.save_draft(draft(&a.id, a.revision, None, words, "")));
            assert_eq!(saved.status, OutcomeStatus::Accepted);
            let saved = feed.with_mut(|f| {
                f.save_draft(draft(&d.id, 1, Some("option-1"), "keep bytes", "why?"))
            });
            assert_eq!(saved.status, OutcomeStatus::Accepted);
            let old =
                feed.with_mut(|f| f.save_draft(draft(&a.id, a.revision + 5, None, "old", "")));
            assert_eq!(old.status, OutcomeStatus::Stale);
            // The user's own Later is a new revision that keeps their words and
            // completes nothing.
            assert_eq!(
                status(TodayFeed::action_later(feed.clone(), shown).await),
                OutcomeStatus::Accepted
            );
            let t = feed.with(|f| f.snapshot());
            let later = &t.actions[0];
            assert_eq!(later.state, ActionState::Deferred);
            assert_eq!(later.revision, a.revision + 1);
            assert_eq!(later.draft.text, words);
            assert!(later.earlier_report.is_none() && later.replaced.is_none());
            assert!(t.notes.is_empty());
            // A safe close through the feed writes queued drafts in the joined drain.
            let closing = feed.with(|f| f.close()).unwrap();
            closing.recv().await.unwrap().unwrap();
        }
        "second" => {
            // After a restart and the agent's replacement: the question's draft
            // is back; the action's words are history on the old revision.
            let t = live(&host, &feed, |t| !t.actions.is_empty()).await;
            let d = &t.decisions[0];
            assert_eq!(d.draft.pick.as_deref(), Some("option-1"));
            assert_eq!(d.draft.text, "keep bytes");
            assert_eq!(d.draft.question, "why?");
            let a = t.actions[0].clone();
            assert_eq!(a.title, "Upload reviewed.zip, checked again");
            assert_eq!(a.draft.text, "");
            assert_eq!(a.earlier_report.as_deref(), Some("  exact\n日本 💬  "));
            assert!(a.replaced.is_some());
            let old = CompleteIntent {
                action_id: a.id.clone(),
                revision: a.revision - 1,
                report: "Submitted".into(),
            };
            assert_eq!(
                status(TodayFeed::complete(feed.clone(), old).await),
                OutcomeStatus::Stale
            );
            let done = CompleteIntent {
                action_id: a.id.clone(),
                revision: a.revision,
                report: "Submitted; review is pending.".into(),
            };
            assert_eq!(
                status(TodayFeed::complete(feed.clone(), done).await),
                OutcomeStatus::Accepted
            );
            let t = feed.with(|f| f.snapshot());
            assert!(t.actions.is_empty());
            assert!(t.notes.iter().any(|n| n.starts_with("You reported done")));
            // The fixture's input executor cannot confirm an answer: it stays
            // unknown and is never sent twice.
            let decide = DecideIntent {
                decision_id: d.id.clone(),
                revision: 1,
                option_id: "option-1".into(),
            };
            assert_eq!(
                status(TodayFeed::decide(feed.clone(), decide.clone()).await),
                OutcomeStatus::Unknown
            );
            let t = feed.with(|f| f.snapshot());
            assert_eq!(t.decisions[0].delivery, Delivery::Unknown);
            assert_eq!(t.decisions[0].sent_option.as_deref(), Some("option-1"));
            assert_eq!(
                status(TodayFeed::decide(feed.clone(), decide).await),
                OutcomeStatus::Rejected
            );
            let closing = feed.with(|f| f.close()).unwrap();
            closing.recv().await.unwrap().unwrap();
        }
        "third" => {
            // Cold open restores the unknown answer; Check only looks it up.
            let t = live(&host, &feed, |t| !t.decisions.is_empty()).await;
            let d = t.decisions[0].clone();
            assert_eq!(d.delivery, Delivery::Unknown);
            let check = DecisionRef {
                decision_id: d.id.clone(),
                revision: d.revision,
            };
            assert_eq!(
                status(TodayFeed::check(feed.clone(), check).await),
                OutcomeStatus::Unknown
            );
            assert_eq!(
                feed.with(|f| f.snapshot()).decisions[0].delivery,
                Delivery::Unknown
            );
            let closing = feed.with(|f| f.close()).unwrap();
            closing.recv().await.unwrap().unwrap();
        }
        "link" => {
            let t = live(&host, &feed, |t| !t.actions.is_empty()).await;
            let a = t.actions[0].clone();
            assert!(a.can_open);
            let shown = ActionRef {
                action_id: a.id.clone(),
                revision: a.revision,
            };
            assert_eq!(
                status(TodayFeed::open_link(feed.clone(), shown).await),
                OutcomeStatus::Accepted
            );
            assert_eq!(OPENED.load(Ordering::SeqCst), 1);
            let t = feed.with(|f| f.snapshot());
            assert_eq!(t.actions[0].state, ActionState::Pending);
            assert_eq!(t.actions[0].delivery, Delivery::Idle);
            assert!(t.notes.is_empty());
            let closing = feed.with(|f| f.close()).unwrap();
            closing.recv().await.unwrap().unwrap();
        }
        "lost" => {
            // The completion's answer is lost: Unknown until the exact lookup.
            let t = live(&host, &feed, |t| !t.actions.is_empty()).await;
            let a = t.actions[0].clone();
            let done = CompleteIntent {
                action_id: a.id.clone(),
                revision: a.revision,
                report: "Uploaded".into(),
            };
            assert_eq!(
                status(TodayFeed::complete(feed.clone(), done.clone()).await),
                OutcomeStatus::Unknown
            );
            let t = feed.with(|f| f.snapshot());
            assert_eq!(t.actions[0].delivery, Delivery::Unknown);
            assert!(t.notes.is_empty());
            assert_eq!(
                status(TodayFeed::complete(feed.clone(), done).await),
                OutcomeStatus::Rejected
            );
            let check = pilot_day_native::model::ActionCheck {
                action_id: a.id.clone(),
            };
            assert_eq!(
                status(TodayFeed::check_action(feed.clone(), check).await),
                OutcomeStatus::Accepted
            );
            let t = feed.with(|f| f.snapshot());
            assert!(t.actions.is_empty());
            assert!(
                t.notes
                    .iter()
                    .any(|n| n.starts_with("You reported done: Upload reviewed.zip"))
            );
            let closing = feed.with(|f| f.close()).unwrap();
            closing.recv().await.unwrap().unwrap();
        }
        other => panic!("unknown phase {other}"),
    }
}

#[component]
fn Probe(props: ProbeProps) -> impl IntoElement {
    let source: Source = serde_json::from_str(&props.source.get()).unwrap();
    let ledger = PathBuf::from(props.ledger.get());
    let phase = props.phase.get();
    let state = signal("waiting".to_owned());
    spawn(async move {
        run(&phase, source, ledger).await;
        state.set("done".into());
    });
    text(move || state.get())
}

#[test]
fn drafts_later_replacement_completion_and_unknown_answers_go_through_the_real_host() {
    let mut f = Fixture::new();
    f.phase("first");
    let stats = f.cmd("stats", false);
    assert_eq!(
        (stats["posts"].clone(), stats["state"].clone()),
        (json!(1), json!("deferred"))
    );
    f.cmd("restart", false);
    f.cmd("replace", false);
    f.phase("second");
    let stats = f.cmd("stats", false);
    assert_eq!(stats["state"], "completed");
    assert_eq!(
        (stats["posts"].clone(), stats["sends"].clone()),
        (json!(3), json!(1))
    );
    f.cmd("restart", false);
    f.phase("third");
    let stats = f.cmd("stats", false);
    assert_eq!(
        (stats["posts"].clone(), stats["sends"].clone()),
        (json!(3), json!(1))
    );
}

#[test]
fn a_link_reports_nothing_and_a_lost_completion_is_only_looked_up() {
    let mut f = Fixture::new();
    f.phase("link");
    let stats = f.cmd("stats", false);
    assert_eq!(stats["state"], "pending");
    f.cmd("lost", true);
    f.phase("lost");
    let stats = f.cmd("stats", false);
    assert_eq!(stats["state"], "completed");
    // The link permission and one completion; the lookup is not a send.
    assert_eq!(stats["posts"], 2);
}
