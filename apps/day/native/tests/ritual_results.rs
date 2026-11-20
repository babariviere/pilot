//! Retained evidence through the production ritual bridge.
#[path = "support/bridge_calls.rs"]
mod bridge_calls;
use bridge_calls::Calls;
use pilot_day_native::host::NativeHost;
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
        let mut command = Command::new("node");
        command.arg(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../../packages/daemon/src/fixtures/day-native-changes.ts"),
        );
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
#[test]
fn ritual_recap_uses_real_retained_sources_without_treating_capture_as_completion() {
    use pilot_day_native::host::ritual::{DaySource, LocalDay};
    let mut f = Fixture::new();
    let host = NativeHost::open_with_options(
        serde_json::from_value(f.info["source"].clone()).unwrap(),
        PathBuf::from(f.info["ledger"].as_str().unwrap()),
        pilot_day_native::host::Options {
            day: Some(DaySource {
                user_id: unsafe { libc::geteuid() },
                clock: std::sync::Arc::new(|| {
                    Ok(LocalDay {
                        date: "2026-11-10".into(),
                        time_zone: "Europe/Paris".into(),
                        hour: 9,
                        unix_ms: 1000,
                    })
                }),
            }),
            ..Default::default()
        },
    )
    .unwrap();
    let mut calls = Calls::new(host);
    assert!(calls.call("day.ritual.read", json!({}))["error"].is_null());
    // Initial WS admission may race a passive read, not an entered write.
    for attempt in 0..3 {
        match calls.call("day.ritual.results", json!({}))["error"].as_str() {
            None => break,
            Some("stale") if attempt < 2 => continue,
            e => panic!("retained recap read failed: {e:?}"),
        }
    }
    let view = calls.call("day.ritual.snapshot", json!({}))["value"]["snapshot"].clone();
    assert_eq!(view["resultsAvailability"], "available");
    assert!(
        view["results"].as_array().unwrap().is_empty(),
        "real snapshot capture and review requests do not prove completion"
    );
    assert_eq!(view["resultsLimited"], false);
    f.cmd("digest", true);
    assert!(calls.call("day.ritual.results", json!({}))["error"].is_string());
    assert_eq!(
        calls.call("day.ritual.snapshot", json!({}))["value"]["snapshot"]["resultsAvailability"],
        "unavailable",
        "mismatched history never becomes an empty successful recap"
    );
    f.cmd("digest", false);
    f.cmd("unavailable", true);
    assert!(calls.call("day.ritual.results", json!({}))["error"].is_string());
    assert_eq!(
        calls.call("day.ritual.snapshot", json!({}))["value"]["snapshot"]["resultsAvailability"],
        "unavailable"
    );
    assert_eq!(f.cmd("stats", true)["posts"], 0);
    calls.close().unwrap();
}
