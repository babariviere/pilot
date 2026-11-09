//! Isolated real daemon/retained store, native capability and durable Changes commands.
use pilot_day_native::{
    changes::{AttentionAsk, AttentionIntent, ChangeList, ChangePage, ChangesAvailability},
    changes_project::sha256,
    host::{Error, NativeHost, Source},
    model::{Delivery, OutcomeStatus},
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
        Self::sized(false)
    }
    fn sized(large: bool) -> Self {
        let mut command = Command::new("node");
        command.arg(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../../packages/daemon/src/fixtures/day-native-changes.ts"),
        );
        if large {
            command.arg("--large");
        }
        let mut child = command
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
                let Ok(line) = line else {
                    break;
                };
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
        self.output
            .recv_timeout(Duration::from_secs(30))
            .expect("fixture command")
    }
    fn open(&self) -> NativeHost {
        NativeHost::open(
            serde_json::from_value::<Source>(self.info["source"].clone()).unwrap(),
            PathBuf::from(self.info["ledger"].as_str().unwrap()),
        )
        .unwrap()
    }
    fn snapshot(&self) -> String {
        self.info["retained"][0].as_str().unwrap().into()
    }
    fn ledger(&self) -> String {
        std::fs::read_to_string(self.info["ledger"].as_str().unwrap()).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        if let Some(root) = self.info["root"].as_str() {
            let _ = std::fs::remove_dir_all(root);
        }
    }
}
fn reply<T>(rx: async_channel::Receiver<Result<T, Error>>) -> Result<T, Error> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            tokio::time::timeout(Duration::from_secs(40), rx.recv())
                .await
                .expect("native deadline")
                .map_err(|_| Error::Unavailable)?
        })
}
fn read(host: &NativeHost) -> ChangeList {
    // Initial WS admission can invalidate a request already queued at cold open.
    for _ in 0..3 {
        match reply(host.read_changes()) {
            Ok(_) => return host.changes_snapshot(),
            Err(Error::Stale) => continue,
            e => panic!("Changes read failed: {e:?}"),
        }
    }
    panic!("Changes read did not settle");
}
fn open(host: &NativeHost, snapshot: &str) -> ChangePage {
    reply(host.open_change(snapshot.into())).unwrap();
    host.change_page(snapshot).expect("exact retained page")
}
fn intent(p: &ChangePage) -> AttentionIntent {
    let r = p.request.as_ref().unwrap();
    AttentionIntent {
        snapshot_id: p.identity.snapshot_id.clone(),
        request_id: r.request_id.clone(),
        revision: r.revision,
    }
}

#[test]
fn all_oldest_first_pages_across_sessions_exact_reopen_and_revision_fenced_transitions() {
    let mut f = Fixture::sized(true);
    let host = f.open();
    let list = read(&host);
    assert_eq!(list.availability, ChangesAvailability::Available);
    assert_eq!(
        list.waiting.len() + list.later.len() + list.earlier.len(),
        22
    );
    assert!(!list.more);
    assert!(f.cmd("stats", true)["listReads"].as_u64().unwrap() >= 3);
    let p = open(&host, &f.snapshot());
    assert_eq!(sha256(&p.patch), p.identity.diff);
    assert!(p.patch.contains("\u{feff}after 👩‍💻\r"));
    let ask = intent(&p);
    assert_eq!(
        reply(host.change_attention(ask.clone(), AttentionAsk::Later))
            .unwrap()
            .status,
        OutcomeStatus::Accepted
    );
    assert_eq!(
        reply(host.change_attention(ask.clone(), AttentionAsk::Later)),
        Err(Error::Stale)
    );
    read(&host);
    let p = open(&host, &f.snapshot());
    assert_eq!(p.request.as_ref().unwrap().revision, ask.revision + 1);
    assert_eq!(
        reply(host.change_attention(intent(&p), AttentionAsk::BringBack))
            .unwrap()
            .status,
        OutcomeStatus::Accepted
    );
    assert_eq!(f.cmd("stats", true)["posts"], 2);
    assert!(
        f.ledger()
            .lines()
            .all(|l| serde_json::from_str::<Value>(l).unwrap()["kind"] == "changes")
    );
    reply(host.close()).unwrap();
}

#[test]
fn lost_ack_lookup_only_survives_native_and_daemon_restart() {
    let mut f = Fixture::new();
    let host = f.open();
    read(&host);
    let p = open(&host, &f.snapshot());
    f.cmd("lost", true);
    assert_eq!(
        reply(host.change_attention(intent(&p), AttentionAsk::Later))
            .unwrap()
            .status,
        OutcomeStatus::Unknown
    );
    assert_eq!(
        host.change_page(&f.snapshot()).unwrap().row.delivery,
        Delivery::Unknown
    );
    reply(host.close()).unwrap();
    f.cmd("restart", true);
    let host = f.open();
    let list = read(&host);
    assert_eq!(list.later[0].delivery, Delivery::Unknown);
    assert_eq!(f.cmd("stats", true)["posts"], 1);
    let p = open(&host, &f.snapshot());
    assert_eq!(
        reply(host.change_attention(intent(&p), AttentionAsk::BringBack))
            .unwrap()
            .status,
        OutcomeStatus::Unknown
    );
    for fault in ["missing", "mismatch"] {
        f.cmd(fault, true);
        assert_eq!(
            reply(host.check_change_attention(f.snapshot()))
                .unwrap()
                .status,
            OutcomeStatus::Unknown
        );
        f.cmd(fault, false);
    }
    assert_eq!(
        reply(host.check_change_attention(f.snapshot()))
            .unwrap()
            .status,
        OutcomeStatus::Accepted
    );
    assert!(
        host.change_page(&f.snapshot()).is_none(),
        "receipt is not a current read"
    );
    read(&host);
    let p = open(&host, &f.snapshot());
    assert_eq!(p.row.delivery, Delivery::Idle);
    assert_eq!(p.request.as_ref().unwrap().revision, 2);
    let stats = f.cmd("stats", true);
    assert_eq!(stats["posts"], 1);
    assert_eq!(stats["lookups"], 3);
    reply(host.close()).unwrap();
}

#[test]
fn unavailable_empty_capacity_and_nonterminating_cursor_are_distinct() {
    let mut f = Fixture::new();
    let host = f.open();
    read(&host);
    for (fault, error) in [
        ("unavailable", Error::Unavailable),
        ("capacity", Error::Busy),
        ("endless", Error::Busy),
    ] {
        f.cmd(fault, true);
        assert_eq!(reply(host.read_changes()), Err(error));
        let list = host.changes_snapshot();
        assert_eq!(list.availability, ChangesAvailability::Unavailable);
        assert_eq!(list.more, error == Error::Busy);
        assert!(!list.reason.is_empty());
        f.cmd(fault, false);
    }
    f.cmd("empty", true);
    let list = read(&host);
    assert_eq!(list.availability, ChangesAvailability::Available);
    assert!(list.waiting.is_empty() && list.earlier.is_empty());
    assert!(!list.more);
    assert_eq!(f.cmd("stats", true)["posts"], 0);
    reply(host.close()).unwrap();
}

#[test]
fn exact_digest_and_raw_patch_identity_fail_closed() {
    let mut f = Fixture::new();
    let host = f.open();
    read(&host);
    f.cmd("digest", true);
    assert!(matches!(
        reply(host.open_change(f.snapshot())),
        Err(Error::Invalid | Error::Stale)
    ));
    assert!(host.change_page(&f.snapshot()).is_none());
    f.cmd("digest", false);
    read(&host);
    f.cmd("patch", true);
    let p = open(&host, &f.snapshot());
    assert!(p.patch.is_empty());
    assert!(p.diff_note.contains("digest"));
    assert_eq!(f.cmd("stats", true)["posts"], 0);
    reply(host.close()).unwrap();
}

#[test]
fn async_currentness_source_revocation_and_post_journal_authority_refuse_send() {
    let mut f = Fixture::new();
    let host = f.open();
    read(&host);
    for fault in ["race", "revoke", "identityRead", "capabilityRead"] {
        f.cmd(fault, true);
        assert!(reply(host.open_change(f.snapshot())).is_err(), "{fault}");
        assert!(host.change_page(&f.snapshot()).is_none());
        f.cmd("restore", true);
        read(&host);
    }
    let p = open(&host, &f.snapshot());
    f.cmd("afterJournal", true);
    assert!(reply(host.change_attention(intent(&p), AttentionAsk::BringBack)).is_err());
    assert_eq!(f.cmd("stats", true)["posts"], 0);
    assert!(
        f.ledger()
            .lines()
            .any(|l| serde_json::from_str::<Value>(l).unwrap()["not_sent"] == true)
    );
    reply(host.close()).unwrap();
}

#[test]
fn close_joins_entered_transport_and_never_replays() {
    let mut f = Fixture::new();
    let host = f.open();
    read(&host);
    let p = open(&host, &f.snapshot());
    f.cmd("block", true);
    let pending = host.change_attention(intent(&p), AttentionAsk::Later);
    f.cmd("waitEntered", true);
    let close = host.close();
    assert!(close.try_recv().is_err(), "close must join entered HTTP");
    assert_eq!(reply(host.read_changes()), Err(Error::Closed));
    f.cmd("release", true);
    let _ = reply(pending);
    reply(close).unwrap();
    let host = f.open();
    read(&host);
    assert_eq!(f.cmd("stats", true)["posts"], 1);
    reply(host.close()).unwrap();
}
