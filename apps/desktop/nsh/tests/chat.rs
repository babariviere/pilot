#![cfg(feature = "native-probes")]
use nsh_engine::EngineConfig;
use nsh_testing::Headless;
use pilot_desktop::nsh_adapter::{Adapter, Snapshot};
use pilot_nsh::{Config, fixture::Fixture};
use std::{path::PathBuf, time::Duration};

struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!(
                "nsh-chat-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            )))
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

async fn until(adapter: &mut Adapter, predicate: impl Fn(&Snapshot) -> bool) -> Snapshot {
    let events = adapter.events();
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let snapshot = adapter.snapshot();
            if predicate(&snapshot) {
                return snapshot;
            }
            adapter.accept(events.next().await.expect("production worker publication"));
        }
    })
    .await
    .unwrap_or_else(|_| panic!("adapter deadline: {:?}", adapter.snapshot()))
}
async fn open(adapter: &mut Adapter, id: &str) -> Snapshot {
    until(adapter, |s| {
        s.sidebar.iter().any(|r| r.session.as_deref() == Some(id))
    })
    .await;
    assert!(adapter.open(id));
    until(adapter, |s| {
        s.location.as_ref().is_some_and(|l| l.session == id) && !s.messages.is_empty()
    })
    .await
}
async fn close(adapter: &mut Adapter) {
    assert!(adapter.close());
    until(adapter, |s| s.closed).await;
}

#[tokio::test]
async fn real_transports_keep_exact_drafts_stream_stop_and_restart() {
    let fixture = Fixture::start();
    let temp = Temp::new();
    let mut adapter = Adapter::start(fixture.options(), temp.0.clone());
    open(&mut adapter, "a").await;
    let a = until(&mut adapter, |s| s.editable).await.location.unwrap();
    let exact = "  日本語 👩🏽‍💻 cafe\u{301}\nsecond line  ";
    assert!(adapter.edit(&a, exact));
    let b = open(&mut adapter, "b").await.location.unwrap();
    assert!(!adapter.edit(&a, "late stale text"));
    assert!(!adapter.send(&a));
    assert!(adapter.edit(&b, "draft B\n保持"));
    let a = open(&mut adapter, "a").await.location.unwrap();
    assert_eq!(adapter.snapshot().text, exact);
    assert!(adapter.send(&a));
    assert!(
        !adapter.send(&a),
        "double-click cannot create another operation"
    );
    open(&mut adapter, "b").await;
    assert_eq!(adapter.snapshot().text, "draft B\n保持");
    let a = open(&mut adapter, "a").await.location.unwrap();
    let streaming = until(&mut adapter, |s| {
        s.can_stop && s.messages.iter().any(|m| m.source.contains("Continuing"))
    })
    .await;
    assert!(streaming.messages.iter().any(|m| m.source == exact));
    assert!(adapter.stop(&a));
    let stopped = until(&mut adapter, |s| {
        !s.working
            && s.messages
                .iter()
                .any(|m| m.source.contains("retained partial"))
    })
    .await;
    assert!(!stopped.can_stop);
    close(&mut adapter).await;
    drop(adapter);
    let mut restarted = Adapter::start(fixture.options(), temp.0.clone());
    open(&mut restarted, "b").await;
    until(&mut restarted, |s| s.editable).await;
    assert_eq!(restarted.snapshot().text, "draft B\n保持");
    close(&mut restarted).await;
    let state = fixture.state.lock().unwrap();
    assert_eq!(state.receipts.len(), 1);
    assert_eq!(state.stops, ["a"]);
    let payload: serde_json::Value =
        serde_json::from_str(state.envelopes[0]["payload"].as_str().unwrap()).unwrap();
    assert_eq!(payload["message"], exact);
    assert_eq!(state.envelopes[0]["targetId"], "a");
}

#[tokio::test]
async fn lost_ack_cold_open_keeps_unknown_and_does_not_resend() {
    let fixture = Fixture::start();
    let temp = Temp::new();
    {
        let mut state = fixture.state.lock().unwrap();
        state.lose_ack = true;
        state.hide_receipt = true;
    }
    let mut adapter = Adapter::start(fixture.options(), temp.0.clone());
    open(&mut adapter, "a").await;
    let a = until(&mut adapter, |s| s.editable).await.location.unwrap();
    adapter.edit(&a, "unknown exact 日本\nkeep");
    assert!(adapter.send(&a));
    until(&mut adapter, |s| {
        !s.submitting && s.problem.as_deref().is_some_and(|p| p.contains("unknown"))
    })
    .await;
    let envelopes = fixture.state.lock().unwrap().envelopes.len();
    assert!(!adapter.send(&a));
    close(&mut adapter).await;
    drop(adapter);
    let mut restarted = Adapter::start(fixture.options(), temp.0.clone());
    open(&mut restarted, "a").await;
    until(&mut restarted, |s| {
        s.problem.as_deref().is_some_and(|p| p.contains("unknown"))
    })
    .await;
    assert_eq!(restarted.snapshot().text, "unknown exact 日本\nkeep");
    assert!(!restarted.snapshot().can_send);
    assert_eq!(fixture.state.lock().unwrap().envelopes.len(), envelopes);
    close(&mut restarted).await;
    assert_eq!(fixture.state.lock().unwrap().receipts.len(), 1);
}

#[tokio::test]
async fn changed_hello_and_restricted_roles_cannot_send() {
    let fixture = Fixture::start();
    let temp = Temp::new();
    let mut adapter = Adapter::start(fixture.options(), temp.0.clone());
    for id in ["ask", "restricted"] {
        open(&mut adapter, id).await;
        assert!(!adapter.snapshot().editable);
        assert!(!adapter.snapshot().can_send);
        let location = adapter.snapshot().location.unwrap();
        assert!(!adapter.send(&location));
    }
    assert!(
        !fixture
            .state
            .lock()
            .unwrap()
            .requests
            .iter()
            .any(|(method, path)| method == "WS" && path.starts_with("/api/sessions/ask/")),
        "legacy Ask must never subscribe interactively"
    );
    open(&mut adapter, "a").await;
    let a = until(&mut adapter, |s| s.editable).await.location.unwrap();
    adapter.edit(&a, "captured before identity change");
    fixture.state.lock().unwrap().bad_identity = true;
    assert!(adapter.send(&a));
    until(&mut adapter, |s| {
        s.problem.as_deref().is_some_and(|p| p.contains("unknown"))
    })
    .await;
    assert!(
        fixture.state.lock().unwrap().envelopes.is_empty(),
        "hello pins the production writer"
    );
    close(&mut adapter).await;
}

#[test]
fn actual_nsh_root_uses_the_same_production_adapter() {
    let fixture = Fixture::start();
    let temp = Temp::new();
    let (close, requests) = async_channel::bounded(1);
    let (closed, replies) = async_channel::bounded(1);
    let config = Config {
        options: fixture.options(),
        state: temp.0.clone(),
        close: requests,
        closed,
    };
    let mut engine = EngineConfig::new(pilot_nsh::root(config));
    engine.clock = nsh_core::time::Clock::manual(std::time::UNIX_EPOCH);
    let mut app = Headless::start(engine).unwrap();
    app.wait_for("label:Open chat a").unwrap();
    app.press("label:Open chat a").unwrap();
    app.wait_for("This chat uses the production Local reader and courier.")
        .unwrap();
    app.wait_until("composer ready", Duration::from_secs(5), |s| {
        s.enabled("id:composer") == Ok(true)
    })
    .unwrap();
    app.type_text("id:composer", "native 日本\n👩🏽‍💻").unwrap();
    app.wait_until("typed draft", Duration::from_secs(5), |s| {
        s.enabled("label:Send message") == Ok(true)
    })
    .unwrap();
    app.press("label:Open chat b").unwrap();
    app.press("label:Open chat a").unwrap();
    app.wait_until("restored exact draft", Duration::from_secs(5), |s| {
        s.input_text("id:composer") == Ok(Some("native 日本\n👩🏽‍💻"))
    })
    .unwrap();
    app.press("label:Open chat a").unwrap();
    app.press("label:Send message").unwrap();
    app.wait_for("label:Stop reply").unwrap();
    app.press("label:Stop reply").unwrap();
    app.wait_for_gone("label:Stop reply", Duration::from_secs(5))
        .unwrap();
    close
        .send_blocking(pilot_nsh::CloseInput {
            session: Some("a".into()),
            text: Some(String::new()),
            composing: false,
        })
        .unwrap();
    app.wait_until("courier close", Duration::from_secs(5), |_| {
        replies.try_recv().is_ok()
    })
    .unwrap();
    assert_eq!(fixture.state.lock().unwrap().receipts.len(), 1);
}

#[tokio::test]
async fn close_refuses_failed_private_save_and_second_writer() {
    let fixture = Fixture::start();
    let temp = Temp::new();
    let mut adapter = Adapter::start(fixture.options(), temp.0.clone());
    open(&mut adapter, "a").await;
    let location = until(&mut adapter, |s| s.editable).await.location.unwrap();
    let mut second = Adapter::start(fixture.options(), temp.0.clone());
    until(&mut second, |s| s.problem.is_some()).await;
    assert!(!second.close());
    assert!(!second.snapshot().editable);
    let events = second.events();
    drop(second);
    tokio::time::timeout(Duration::from_secs(5), async {
        while events.next().await.is_some() {}
    })
    .await
    .unwrap();
    // Synthetic private-save refusal. Never touches a user profile or lock.
    let state = temp.0.join("state-v1.json");
    if state.exists() {
        std::fs::remove_file(&state).unwrap();
    }
    std::fs::create_dir(&state).unwrap();
    assert!(adapter.edit(&location, "unsaved exact 日本\nkeep"));
    assert!(adapter.close());
    until(&mut adapter, |s| s.problem.is_some()).await;
    assert!(!adapter.snapshot().closed, "a failed save is not Flushed");
    assert_eq!(adapter.snapshot().text, "unsaved exact 日本\nkeep");
    let events = adapter.events();
    drop(adapter);
    tokio::time::timeout(Duration::from_secs(5), async {
        while events.next().await.is_some() {}
    })
    .await
    .unwrap();
}
