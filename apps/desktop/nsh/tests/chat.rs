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

fn question(multi: bool) -> serde_json::Value {
    serde_json::json!({"question":"Which checks should run? 日本語", "context":"Choose explicitly. The ordinary draft stays separate.", "blocking":true,"multiSelect":multi,"options":[{"label":"Typecheck","detail":"Check shared types","suggested":true},{"label":"Tests"}]})
}

#[tokio::test]
async fn unsent_reply_and_choices_restore_without_replacing_ordinary_draft() {
    let fixture = Fixture::start();
    let temp = Temp::new();
    fixture.question("a", 40, question(true));
    let mut adapter = Adapter::start(fixture.options(), temp.0.clone());
    open(&mut adapter, "a").await;
    let p = until(&mut adapter, |s| {
        s.prompt.as_ref().is_some_and(|p| p.editable)
    })
    .await
    .prompt
    .unwrap();
    let location = adapter.snapshot().location.unwrap();
    assert!(adapter.edit(&location, "ordinary before\n"));
    assert!(adapter.pick(&p.target, 0, true));
    assert!(adapter.edit_reply(&p.target, "  unsent 日本\n "));
    // An ordinary edit does not change which question owns the separate reply.
    assert!(adapter.edit(&location, "ordinary after\n保持 "));
    close(&mut adapter).await;
    drop(adapter);
    let mut adapter = Adapter::start(fixture.options(), temp.0.clone());
    open(&mut adapter, "a").await;
    let p = until(&mut adapter, |s| {
        s.prompt.as_ref().is_some_and(|p| p.can_answer)
    })
    .await
    .prompt
    .unwrap();
    assert_eq!(adapter.snapshot().text, "ordinary after\n保持 ");
    assert_eq!(p.text, "  unsent 日本\n ");
    assert_eq!(p.selected.into_iter().collect::<Vec<_>>(), [0]);
    assert!(fixture.state.lock().unwrap().envelopes.is_empty());
    close(&mut adapter).await;
}
fn access(mode: &str) -> serde_json::Value {
    serde_json::json!({"question":"Agent prose must not change the grant", "context":"Needed for the requested query.","databaseAccess":{"id":"grant-1","env":"Development 日本語","mode":mode}})
}

#[tokio::test]
async fn blocking_choices_use_exact_reply_identity_and_keep_both_drafts() {
    let fixture = Fixture::start();
    let temp = Temp::new();
    let mut adapter = Adapter::start(fixture.options(), temp.0.clone());
    let a = open(&mut adapter, "a").await.location.unwrap();
    until(&mut adapter, |s| s.editable).await;
    assert!(adapter.edit(&a, "ordinary 日本語\n  keep "));
    fixture.question("a", 40, question(true));
    let p = until(&mut adapter, |s| {
        s.prompt.as_ref().is_some_and(|p| p.editable)
    })
    .await
    .prompt
    .unwrap();
    assert!(
        adapter.snapshot().can_stop,
        "blocking ask keeps contextual Stop"
    );
    assert!(!adapter.send(&a));
    assert!(adapter.pick(&p.target, 1, true));
    assert!(adapter.pick(&p.target, 0, true));
    assert!(adapter.edit_reply(&p.target, "  own 日本語 👩🏽‍💻\nsecond line  "));
    assert!(fixture.state.lock().unwrap().envelopes.is_empty());
    open(&mut adapter, "b").await;
    assert!(!adapter.answer(
        &p.target,
        adapter.snapshot().prompt.map_or(0, |p| p.revision)
    ));
    assert!(!adapter.pick(&p.target, 0, false));
    assert!(!adapter.edit_reply(&p.target, "stale navigation callback"));
    open(&mut adapter, "a").await;
    let p = until(&mut adapter, |s| {
        s.prompt.as_ref().is_some_and(|p| p.can_answer)
    })
    .await
    .prompt
    .unwrap();
    assert_eq!(p.text, "  own 日本語 👩🏽‍💻\nsecond line  ");
    assert!(!adapter.answer(&p.target, p.revision - 1));
    assert!(adapter.answer(&p.target, p.revision));
    assert!(!adapter.answer(&p.target, p.revision));
    until(&mut adapter, |s| {
        !s.submitting && s.prompt.is_none() && s.can_stop
    })
    .await;
    assert_eq!(adapter.snapshot().text, "ordinary 日本語\n  keep ");
    let a = adapter.snapshot().location.unwrap();
    assert!(adapter.stop(&a));
    until(&mut adapter, |s| !s.working && s.can_send).await;
    close(&mut adapter).await;
    let state = fixture.state.lock().unwrap();
    assert_eq!(state.envelopes.len(), 1);
    let body: serde_json::Value =
        serde_json::from_str(state.envelopes[0]["payload"].as_str().unwrap()).unwrap();
    assert_eq!(body["questionReplyId"], 40);
    assert_eq!(body["inputGeneration"], 0);
    assert_eq!(
        body["message"],
        "- Typecheck\n- Tests\n\nown 日本語 👩🏽‍💻\nsecond line"
    );
    assert_eq!(body["mode"], "steer");
}

#[tokio::test]
async fn replaced_questions_keep_old_reply_and_require_explicit_recovery() {
    let fixture = Fixture::start();
    let temp = Temp::new();
    fixture.question("a", 40, question(false));
    let mut adapter = Adapter::start(fixture.options(), temp.0.clone());
    open(&mut adapter, "a").await;
    let p = until(&mut adapter, |s| {
        s.prompt.as_ref().is_some_and(|p| p.editable)
    })
    .await
    .prompt
    .unwrap();
    assert!(adapter.pick(&p.target, 0, true));
    assert!(adapter.pick(&p.target, 1, true));
    assert_eq!(
        adapter
            .snapshot()
            .prompt
            .unwrap()
            .selected
            .into_iter()
            .collect::<Vec<_>>(),
        [1]
    );
    assert!(adapter.edit_reply(&p.target, "old exact 日本\n  "));
    fixture.question("a", 41, question(false));
    until(&mut adapter, |s| s.previous_reply.is_some()).await;
    assert!(!adapter.answer(&p.target, p.revision));
    let a = adapter.snapshot().location.unwrap();
    assert!(!adapter.snapshot().prompt.unwrap().editable);
    assert!(adapter.recover_reply(&a));
    until(&mut adapter, |s| {
        s.prompt.as_ref().is_some_and(|p| p.editable) && !s.recovered.is_empty()
    })
    .await;
    assert_eq!(
        adapter.snapshot().recovered,
        ["Tests\n\nold exact 日本\n  "]
    );
    assert!(fixture.state.lock().unwrap().envelopes.is_empty());
    assert!(adapter.stop(&a));
    until(&mut adapter, |s| !s.working).await;
    close(&mut adapter).await;
}

#[tokio::test]
async fn lost_reply_ack_survives_restart_without_a_new_submission() {
    let fixture = Fixture::start();
    let temp = Temp::new();
    fixture.question("a", 40, question(false));
    {
        let mut state = fixture.state.lock().unwrap();
        state.lose_ack = true;
        state.hide_receipt = true;
    }
    let mut adapter = Adapter::start(fixture.options(), temp.0.clone());
    open(&mut adapter, "a").await;
    let p = until(&mut adapter, |s| {
        s.prompt.as_ref().is_some_and(|p| p.editable)
    })
    .await
    .prompt
    .unwrap();
    assert!(adapter.edit_reply(&p.target, "original exact\n 日本 "));
    let revision = adapter.snapshot().prompt.unwrap().revision;
    assert!(adapter.answer(&p.target, revision));
    until(&mut adapter, |s| {
        !s.submitting && s.problem.as_deref().is_some_and(|p| p.contains("unknown"))
    })
    .await;
    assert!(!adapter.answer(&p.target, revision));
    close(&mut adapter).await;
    drop(adapter);
    let before = fixture.state.lock().unwrap().envelopes.len();
    let mut adapter = Adapter::start(fixture.options(), temp.0.clone());
    open(&mut adapter, "a").await;
    until(&mut adapter, |s| {
        s.problem.as_deref().is_some_and(|p| p.contains("unknown"))
    })
    .await;
    assert_eq!(
        adapter.snapshot().previous_reply.as_deref(),
        Some("original exact\n 日本 ")
    );
    assert!(!adapter.snapshot().can_send);
    close(&mut adapter).await;
    assert_eq!(fixture.state.lock().unwrap().envelopes.len(), before);
    let book: serde_json::Value =
        serde_json::from_slice(&std::fs::read(temp.0.join("state-v1.json")).unwrap()).unwrap();
    let intent = book["pending"]
        .as_object()
        .unwrap()
        .values()
        .next()
        .unwrap();
    assert_eq!(intent["answer"]["question"]["entry"], 40);
    assert_eq!(
        intent["automatic"]["answer"]["text"],
        "original exact\n 日本 "
    );
}

#[tokio::test]
async fn explicit_database_allow_deny_and_unknown_never_become_messages() {
    for allow in [true, false] {
        let fixture = Fixture::start();
        let temp = Temp::new();
        fixture.question("a", 40, access("read"));
        let mut adapter = Adapter::start(fixture.options(), temp.0.clone());
        open(&mut adapter, "a").await;
        let p = until(&mut adapter, |s| {
            s.prompt.as_ref().is_some_and(|p| p.can_decide)
        })
        .await
        .prompt
        .unwrap();
        assert_eq!(
            p.title,
            "Allow read access to the Development 日本語 database?"
        );
        assert!(!adapter.edit_reply(&p.target, "yes"));
        assert!(!adapter.answer(&p.target, p.revision));
        assert!(adapter.decide(&p.target, allow));
        assert!(!adapter.decide(&p.target, allow));
        until(&mut adapter, |s| {
            s.prompt
                .as_ref()
                .is_some_and(|p| p.status.starts_with("Decision sent"))
        })
        .await;
        open(&mut adapter, "b").await;
        assert!(!adapter.decide(&p.target, !allow));
        open(&mut adapter, "a").await;
        until(&mut adapter, |s| s.prompt.is_some()).await;
        assert!(!adapter.snapshot().prompt.unwrap().can_decide);
        close(&mut adapter).await;
        let state = fixture.state.lock().unwrap();
        assert!(state.envelopes.is_empty());
        assert_eq!(
            state.decisions,
            [(
                "a".into(),
                serde_json::json!({"id":"grant-1","allow":allow})
            )]
        );
    }
    let fixture = Fixture::start();
    let temp = Temp::new();
    fixture.question("a", 40, access("write"));
    fixture.state.lock().unwrap().lose_decision_ack = true;
    let mut adapter = Adapter::start(fixture.options(), temp.0.clone());
    open(&mut adapter, "a").await;
    let p = until(&mut adapter, |s| {
        s.prompt.as_ref().is_some_and(|p| p.can_decide)
    })
    .await
    .prompt
    .unwrap();
    assert!(adapter.decide(&p.target, false));
    until(&mut adapter, |s| {
        s.prompt
            .as_ref()
            .is_some_and(|p| p.status.starts_with("Decision unknown"))
    })
    .await;
    open(&mut adapter, "b").await;
    open(&mut adapter, "a").await;
    until(&mut adapter, |s| s.prompt.is_some()).await;
    assert!(
        adapter
            .snapshot()
            .prompt
            .unwrap()
            .status
            .starts_with("Decision unknown")
    );
    assert!(!adapter.decide(&p.target, true));
    close(&mut adapter).await;
    drop(adapter);
    let mut adapter = Adapter::start(fixture.options(), temp.0.clone());
    open(&mut adapter, "a").await;
    until(&mut adapter, |s| s.prompt.is_some()).await;
    close(&mut adapter).await;
    assert_eq!(
        fixture.state.lock().unwrap().decisions.len(),
        1,
        "cold open cannot replay a decision"
    );
}

#[tokio::test]
async fn unsupported_requests_roles_and_refused_decisions_stay_explicit() {
    let fixture = Fixture::start();
    let temp = Temp::new();
    fixture.question(
        "a",
        40,
        serde_json::json!({"question":"Allow?","databaseAccess":{"requestId":"unsupported"}}),
    );
    let mut adapter = Adapter::start(fixture.options(), temp.0.clone());
    open(&mut adapter, "a").await;
    let p = until(&mut adapter, |s| s.prompt.is_some())
        .await
        .prompt
        .unwrap();
    assert!(!p.message && !p.can_decide && !p.can_answer);
    assert!(!adapter.decide(&p.target, true));
    assert!(!adapter.edit_reply(&p.target, "yes"));
    fixture.question("a", 41, access("write"));
    fixture.state.lock().unwrap().refuse_decision = true;
    let p = until(&mut adapter, |s| {
        s.prompt.as_ref().is_some_and(|p| p.can_decide)
    })
    .await
    .prompt
    .unwrap();
    assert!(adapter.decide(&p.target, true));
    until(&mut adapter, |s| {
        s.prompt
            .as_ref()
            .is_some_and(|p| p.status.contains("no longer pending"))
    })
    .await;
    assert_eq!(fixture.state.lock().unwrap().decisions.len(), 1);
    fixture.question("restricted", 40, access("read"));
    open(&mut adapter, "restricted").await;
    let p = until(&mut adapter, |s| s.prompt.is_some())
        .await
        .prompt
        .unwrap();
    assert!(!p.can_decide);
    assert!(!adapter.decide(&p.target, true));
    close(&mut adapter).await;
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
            reply: None,
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

#[test]
fn nsh_native_controls_keep_reply_and_ordinary_draft_separate() {
    let fixture = Fixture::start();
    let temp = Temp::new();
    fixture.question("a", 40, question(false));
    let (close, requests) = async_channel::bounded(1);
    let (closed, replies) = async_channel::bounded(1);
    let mut engine = EngineConfig::new(pilot_nsh::root(Config {
        options: fixture.options(),
        state: temp.0.clone(),
        close: requests,
        closed,
    }));
    engine.clock = nsh_core::time::Clock::manual(std::time::UNIX_EPOCH);
    engine.environment.os = nsh_core::platform::Os::MacOs;
    let mut app = Headless::start(engine).unwrap();
    app.wait_for("label:Open chat a").unwrap();
    app.press("label:Open chat a").unwrap();
    app.wait_until("reply editable", Duration::from_secs(5), |s| {
        s.enabled("id:question-reply") == Ok(true)
    })
    .unwrap();
    app.type_text("id:composer", "ordinary exact\n保持")
        .unwrap();
    app.press("label:Typecheck").unwrap();
    app.type_text("id:question-reply", "").unwrap();
    app.press_key("shift+tab").unwrap();
    app.press_key("right").unwrap();
    app.type_text("id:question-reply", "  own 日本\n👩🏽‍💻  ")
        .unwrap();
    app.press("label:Open chat b").unwrap();
    app.press("label:Open chat a").unwrap();
    app.wait_until("reply restored", Duration::from_secs(5), |s| {
        s.input_text("id:question-reply") == Ok(Some("  own 日本\n👩🏽‍💻  "))
    })
    .unwrap();
    app.wait_until("ordinary draft restored", Duration::from_secs(5), |s| {
        s.input_text("id:composer") == Ok(Some("ordinary exact\n保持"))
    })
    .unwrap();
    app.press("label:Send answer").unwrap();
    app.wait_for_gone("id:question-reply", Duration::from_secs(5))
        .unwrap();
    app.wait_for("label:Stop reply").unwrap();
    app.wait_until("answer settled before Stop", Duration::from_secs(5), |s| {
        s.enabled("label:Stop reply") == Ok(true)
    })
    .unwrap();
    app.press("label:Stop reply").unwrap();
    app.wait_until(
        "Stop reached the original chat",
        Duration::from_secs(5),
        |_| fixture.state.lock().unwrap().stops == ["a"],
    )
    .unwrap();
    close
        .send_blocking(pilot_nsh::CloseInput {
            session: Some("a".into()),
            text: Some("ordinary exact\n保持".into()),
            reply: None,
            composing: false,
        })
        .unwrap();
    app.wait_until("prompt courier close", Duration::from_secs(5), |_| {
        replies.try_recv().is_ok()
    })
    .unwrap();
    let state = fixture.state.lock().unwrap();
    assert_eq!(state.envelopes.len(), 1);
    let body: serde_json::Value =
        serde_json::from_str(state.envelopes[0]["payload"].as_str().unwrap()).unwrap();
    assert_eq!(body["message"], "Tests\n\nown 日本\n👩🏽‍💻");
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
