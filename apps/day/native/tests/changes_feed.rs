//! ChangesFeed over the real native host and an isolated daemon: the feed a
//! root owner builds with `from_host`. The first read survives the initial
//! WS admission race; Read again only reads; an unavailable, revoked or
//! limited source never shows as an empty or complete list; one exact
//! snapshot reopens; Later and Bring back name the revision shown; a lost
//! answer stays unconfirmed through reopening and a re-read, and only Check
//! looks it up. Headless with a manual clock; no provider or visible window.
use nsh_core::prelude::*;
use nsh_engine::{Clock, EngineConfig, Root};
use nsh_testing::Headless;
use pilot_day_native::{
    ChangesFeed,
    changes::{AttentionIntent, ChangeList, ChangePage, ChangeRef, ChangesAvailability},
    changes_project::sha256,
    host::{NativeHost, Source},
    model::{Delivery, IntentOutcome, OutcomeStatus},
};
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{Mutex, mpsc},
    time::Duration,
};

/// The fixture's command pipe, shared with the headless phase.
struct Control {
    input: ChildStdin,
    output: mpsc::Receiver<Value>,
}
static CONTROL: Mutex<Option<Control>> = Mutex::new(None);

/// Sends one fixture command and waits for its answer. Blocks briefly: the
/// host's I/O runs on its own worker, not on this executor.
fn cmd(action: &str, value: bool) -> Value {
    let mut control = CONTROL.lock().unwrap();
    let control = control.as_mut().expect("fixture running");
    writeln!(control.input, "{}", json!({"action":action,"value":value})).unwrap();
    control.input.flush().unwrap();
    control
        .output
        .recv_timeout(Duration::from_secs(30))
        .expect("fixture command")
}

struct Fixture {
    child: Child,
    info: Value,
}
impl Fixture {
    fn new() -> Self {
        let mut child = Command::new("node")
            .arg(
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("../../../packages/daemon/src/fixtures/day-native-changes.ts"),
            )
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
                if let Ok(v) = serde_json::from_str(&line)
                    && tx.send(v).is_err()
                {
                    break;
                }
            }
        });
        let info = output
            .recv_timeout(Duration::from_secs(60))
            .expect("fixture ready");
        *CONTROL.lock().unwrap() = Some(Control { input, output });
        Self { child, info }
    }
    fn run(&self) {
        let source = serde_json::to_string(&self.info["source"]).unwrap();
        let ledger = self.info["ledger"].as_str().unwrap().to_owned();
        let snapshot = self.info["retained"][0].as_str().unwrap().to_owned();
        let root = Root::new::<Probe>(move || ProbeProps {
            source: source.clone().into(),
            ledger: ledger.clone().into(),
            snapshot: snapshot.clone().into(),
        });
        let mut app = Headless::start(EngineConfig {
            clock: Clock::manual(std::time::UNIX_EPOCH),
            ..EngineConfig::new(root)
        })
        .unwrap();
        app.wait_for_within("done", Duration::from_secs(120))
            .unwrap();
        drop(app);
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        CONTROL.lock().unwrap().take();
        let _ = self.child.kill();
        let _ = self.child.wait();
        if let Some(root) = self.info["root"].as_str() {
            let _ = std::fs::remove_dir_all(root);
        }
    }
}

#[derive(Debug, Clone, PartialEq, Props)]
struct ProbeProps {
    source: Prop<String>,
    ledger: Prop<String>,
    snapshot: Prop<String>,
}

/// Waits until the feed's list satisfies `ready`, hearing the host's changes.
async fn until(
    host: &NativeHost,
    feed: &Instance<ChangesFeed>,
    ready: impl Fn(&ChangeList) -> bool,
) -> ChangeList {
    let changes = host.changes();
    loop {
        let list = feed.with(|f| f.snapshot());
        if ready(&list) {
            return list;
        }
        changes.recv().await.expect("host open");
    }
}

fn total(list: &ChangeList) -> usize {
    list.waiting.len() + list.later.len() + list.earlier.len()
}

fn status(outcome: IntentOutcome) -> OutcomeStatus {
    eprintln!("outcome {:?}: {}", outcome.status, outcome.message);
    outcome.status
}

fn shown(page: &ChangePage) -> AttentionIntent {
    let r = page.request.as_ref().expect("a review request");
    AttentionIntent {
        snapshot_id: page.identity.snapshot_id.clone(),
        request_id: r.request_id.clone(),
        revision: r.revision,
    }
}

/// Reopens one exact snapshot through the feed and returns its page.
async fn reopen(feed: &Instance<ChangesFeed>, snapshot: &str) -> ChangePage {
    let opened = ChangesFeed::open(
        feed.clone(),
        ChangeRef {
            snapshot_id: snapshot.into(),
        },
    )
    .await;
    assert_eq!(status(opened), OutcomeStatus::Accepted);
    feed.with(|f| f.change(snapshot.into()))
        .expect("the exact reopened snapshot")
}

/// Reads the list again and waits for that read to land available.
async fn read_again(host: &NativeHost, feed: &Instance<ChangesFeed>) -> ChangeList {
    let before = feed.with(|f| f.snapshot()).revision;
    let outcome = feed.with_mut(|f| f.refresh());
    assert_eq!(status(outcome), OutcomeStatus::Accepted, "admission only");
    until(host, feed, |l| {
        l.revision != before && l.availability == ChangesAvailability::Available
    })
    .await
}

async fn run(source: Source, ledger: PathBuf, snapshot: String) {
    let host = NativeHost::open(source, ledger).unwrap();
    let feed = Instance::new(ChangesFeed::from_host(host.clone()));

    // Before the first read lands, the feed says it needs a read, never "none".
    let first = feed.with(|f| f.snapshot());
    if first.availability == ChangesAvailability::Unavailable {
        assert!(!first.reason.is_empty());
        assert_eq!(total(&first), 0);
    }
    // The initial read survives the WS admission race on its own.
    let list = until(&host, &feed, |l| {
        l.availability == ChangesAvailability::Available
    })
    .await;
    let kept = total(&list);
    assert!(kept > 0 && !list.more);

    // Read again only reads: the same complete list, nothing sent.
    let again = read_again(&host, &feed).await;
    assert_eq!(total(&again), kept);
    assert_eq!(cmd("stats", true)["posts"], 0);

    // An unavailable source or a limited inventory is never empty or complete.
    for (fault, limited) in [("unavailable", false), ("capacity", true)] {
        cmd(fault, true);
        assert_eq!(
            status(feed.with_mut(|f| f.refresh())),
            OutcomeStatus::Accepted
        );
        let off = until(&host, &feed, |l| {
            l.availability == ChangesAvailability::Unavailable
        })
        .await;
        assert_eq!(total(&off), 0, "{fault}: no partial rows");
        assert_eq!(off.more, limited, "{fault}");
        assert!(!off.reason.is_empty());
        assert!(feed.with(|f| f.change(snapshot.clone())).is_none());
        cmd(fault, false);
        assert_eq!(total(&read_again(&host, &feed).await), kept);
    }

    // A source revoked during the reopen shows nothing from that snapshot.
    cmd("revoke", true);
    let revoked = ChangesFeed::open(
        feed.clone(),
        ChangeRef {
            snapshot_id: snapshot.clone(),
        },
    )
    .await;
    assert_ne!(status(revoked), OutcomeStatus::Accepted);
    assert!(feed.with(|f| f.change(snapshot.clone())).is_none());
    assert_eq!(
        feed.with(|f| f.snapshot()).availability,
        ChangesAvailability::Unavailable
    );
    cmd("restore", true);
    read_again(&host, &feed).await;

    // One exact snapshot, its bytes and digest.
    let page = reopen(&feed, &snapshot).await;
    assert_eq!(page.identity.snapshot_id, snapshot);
    assert_eq!(sha256(&page.patch), page.identity.diff);

    // Later and Bring back name the revision shown; an old one is stale.
    let ask = shown(&page);
    assert_eq!(
        status(ChangesFeed::later(feed.clone(), ask.clone()).await),
        OutcomeStatus::Accepted
    );
    assert_eq!(
        status(ChangesFeed::later(feed.clone(), ask.clone()).await),
        OutcomeStatus::Stale
    );
    read_again(&host, &feed).await;
    let page = reopen(&feed, &snapshot).await;
    assert_eq!(shown(&page).revision, ask.revision + 1);
    assert_eq!(
        status(ChangesFeed::bring_back(feed.clone(), shown(&page)).await),
        OutcomeStatus::Accepted
    );
    assert_eq!(cmd("stats", true)["posts"], 2);

    // A lost answer: unconfirmed through reopening and a re-read, never resent.
    read_again(&host, &feed).await;
    let page = reopen(&feed, &snapshot).await;
    cmd("lost", true);
    assert_eq!(
        status(ChangesFeed::later(feed.clone(), shown(&page)).await),
        OutcomeStatus::Unknown
    );
    let list = read_again(&host, &feed).await;
    assert!(
        list.waiting
            .iter()
            .chain(&list.later)
            .chain(&list.earlier)
            .any(|r| r.snapshot_id == snapshot && r.delivery == Delivery::Unknown)
    );
    let page = reopen(&feed, &snapshot).await;
    assert_eq!(page.row.delivery, Delivery::Unknown);
    assert_eq!(
        status(ChangesFeed::later(feed.clone(), shown(&page)).await),
        OutcomeStatus::Unknown,
        "a second send is refused while the first is unconfirmed"
    );
    assert_eq!(cmd("stats", true)["posts"], 3);
    let checked = ChangesFeed::check_attention(
        feed.clone(),
        ChangeRef {
            snapshot_id: snapshot.clone(),
        },
    )
    .await;
    assert_eq!(status(checked), OutcomeStatus::Accepted);
    // A receipt is history, not a current read: the snapshot needs a fresh one.
    assert!(feed.with(|f| f.change(snapshot.clone())).is_none());
    read_again(&host, &feed).await;
    let page = reopen(&feed, &snapshot).await;
    assert_eq!(page.row.delivery, Delivery::Idle);
    let stats = cmd("stats", true);
    assert_eq!(stats["posts"], 3);
    assert!(stats["lookups"].as_u64().unwrap() >= 1);

    // The bootstrap joins the host; afterwards Read again is refused at once.
    host.close().recv().await.unwrap().unwrap();
    assert_eq!(status(feed.with_mut(|f| f.refresh())), OutcomeStatus::Stale);
    assert_eq!(
        feed.with(|f| f.snapshot()).availability,
        ChangesAvailability::Unavailable
    );
}

#[component]
fn Probe(props: ProbeProps) -> impl IntoElement {
    let source: Source = serde_json::from_str(&props.source.get()).unwrap();
    let ledger = PathBuf::from(props.ledger.get());
    let snapshot = props.snapshot.get();
    let state = signal("waiting".to_owned());
    spawn(async move {
        run(source, ledger, snapshot).await;
        state.set("done".into());
    });
    text(move || state.get())
}

#[test]
fn the_root_feed_reads_again_reopens_exactly_and_never_resends() {
    Fixture::new().run();
}
