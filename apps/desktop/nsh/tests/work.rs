#![cfg(feature = "native-probes")]
use nsh_engine::EngineConfig;
use nsh_testing::Headless;
use pilot_desktop::nsh_adapter::{Adapter, Snapshot};
use pilot_nsh::{
    Config,
    fixture::{Fixture, WORK_CODE, WORK_OUTPUT},
};
use std::{path::PathBuf, time::Duration};

struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!(
                "nsh-work-{}-{}",
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
            let s = adapter.snapshot();
            if predicate(&s) {
                return s;
            }
            adapter.accept(events.next().await.unwrap());
        }
    })
    .await
    .unwrap_or_else(|_| panic!("adapter deadline: {:?}", adapter.snapshot()))
}

#[tokio::test]
async fn production_work_projection_keeps_notes_identities_status_and_literal_source() {
    let fixture = Fixture::start();
    fixture.work("a");
    let temp = Temp::new();
    let mut adapter = Adapter::start(fixture.options(), temp.0.clone());
    until(&mut adapter, |s| {
        s.sidebar.iter().any(|r| r.session.as_deref() == Some("a"))
    })
    .await;
    assert!(adapter.open("a"));
    let s = until(&mut adapter, |s| {
        s.messages
            .iter()
            .filter_map(|m| m.work.as_ref())
            .any(|w| w.calls.iter().any(|c| c.status == "Running…"))
    })
    .await;
    let work: Vec<_> = s.messages.iter().filter_map(|m| m.work.as_ref()).collect();
    assert_eq!(work.len(), 2);
    assert!(
        work[0]
            .title
            .starts_with("Edited main.rs · +2 −1 · command failed")
    );
    assert_eq!(
        work[0].first_error.as_ref().unwrap().1,
        "Error: exact failure <&> 日本語 👩🏽‍💻"
    );
    let failed = &work[0].calls[1];
    assert_eq!(failed.id, "failed");
    assert_eq!(failed.input.as_ref().unwrap().1.as_str(), WORK_CODE);
    assert_eq!(failed.output.as_str(), WORK_OUTPUT);
    assert_eq!(failed.duration.as_deref(), Some("0.125 s"));
    assert!(!failed.shown_output.starts_with("Script failed"));
    assert!(work[1].active);
    assert_eq!(work[1].units.len(), 9);
    assert_eq!(work[1].units[0], [0, 1]);
    let calls = &work[1].calls;
    for (id, status) in [
        ("pending", "Pending"),
        ("running", "Running…"),
        ("unknown", "Status unknown"),
        ("script", ""),
    ] {
        assert_eq!(calls.iter().find(|c| c.id == id).unwrap().status, status);
    }
    assert!(
        calls
            .iter()
            .find(|c| c.id == "script")
            .unwrap()
            .caption
            .contains("printf test")
    );
    assert!(
        !calls.iter().find(|c| c.id == "script").unwrap().failed,
        "nested printed failure is not script status"
    );
    assert!(s.messages.iter().any(|m| m.source
        == "Visible interleaved Note. Not hidden work or Thinking."
        && m.work.is_none()));
    let note = s
        .messages
        .iter()
        .position(|m| m.source.starts_with("Visible interleaved Note."))
        .unwrap();
    assert!(
        s.messages[note - 1].work.is_some() && s.messages[note + 1].work.is_some(),
        "Notes keep their chronological place between groups"
    );
    assert!(
        !s.messages
            .iter()
            .any(|m| m.source.contains("Private reasoning"))
    );
    let a = s.location.unwrap();
    assert!(adapter.open("b"));
    until(&mut adapter, |s| {
        s.messages
            .iter()
            .any(|m| m.source.contains("production Local reader"))
            && s.messages.iter().all(|m| m.work.is_none())
    })
    .await;
    fixture.changed();
    assert!(!adapter.stop(&a), "old generation cannot stop another chat");
    assert!(adapter.open("a"));
    let s = until(&mut adapter, |s| {
        s.can_stop
            && s.messages
                .iter()
                .filter_map(|m| m.work.as_ref())
                .any(|w| w.active)
    })
    .await;
    assert!(adapter.stop(&s.location.unwrap()));
    until(&mut adapter, |s| {
        !s.working
            && s.messages
                .iter()
                .filter_map(|m| m.work.as_ref())
                .all(|w| !w.active)
    })
    .await;
    assert!(adapter.close());
    until(&mut adapter, |s| s.closed).await;
    let state = fixture.state.lock().unwrap();
    assert!(state.envelopes.is_empty());
    assert_eq!(state.stops, ["a"]);
}

#[test]
fn native_disclosure_keeps_exact_copy_and_choices_across_updates_and_chat_switch() {
    let fixture = Fixture::start();
    fixture.work("a");
    fixture.work("b");
    fixture
        .state
        .lock()
        .unwrap()
        .work_events
        .get_mut("b")
        .unwrap()[1]["message"]["content"][2]["arguments"]["code"] =
        serde_json::json!("await tools.read({path: 'other-chat.rs'});");
    let temp = Temp::new();
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
    app.wait_for("id:call-running").unwrap();
    app.wait_for("Visible interleaved Note. Not hidden work or Thinking.")
        .unwrap();
    app.wait_for("Show 4 earlier steps").unwrap();
    assert!(
        !app.screen()
            .texts()
            .iter()
            .any(|s| s.contains("Private reasoning"))
    );
    app.press("id:call-running").unwrap();
    app.wait_for("  live 日本語\n<&> 👩🏽‍💻  ").unwrap();
    app.press("label:Copy output").unwrap();
    assert_eq!(app.screen().clipboard(), Some("  live 日本語\n<&> 👩🏽‍💻  "));
    assert!(
        !app.screen()
            .texts()
            .iter()
            .any(|s| s.contains("await tools.read({path: 'running.rs'});")),
        "code starts collapsed"
    );
    app.press("id:source-running").unwrap();
    app.press("label:Copy code").unwrap();
    assert_eq!(
        app.screen().clipboard(),
        Some("// Stream exact output\nawait tools.read({path: 'running.rs'});")
    );
    fixture.changed();
    app.press("label:Open chat b").unwrap();
    app.wait_for("label:Message in b").unwrap();
    assert!(
        !app.screen().matches("id:detail-running").unwrap(),
        "same call IDs in another chat do not share disclosure"
    );
    app.press("label:Open chat a").unwrap();
    app.wait_for("id:source-running").unwrap();
    app.press("label:Copy code").unwrap();
    assert_eq!(
        app.screen().clipboard(),
        Some("// Stream exact output\nawait tools.read({path: 'running.rs'});")
    );
    app.scroll("id:transcript", nsh_core::geometry::px(-250.))
        .unwrap();
    app.press("label:Show earlier work steps").unwrap();
    app.wait_for("id:call-read-a").unwrap();
    app.wait_for("id:call-read-b").unwrap();
    // A late output publication updates the open call, not its disclosure owner.
    {
        let mut state = fixture.state.lock().unwrap();
        state.work_events.get_mut("a").unwrap().last_mut().unwrap()["output"]["set"] =
            serde_json::json!("late exact 日本語\n<&>  ");
    }
    fixture.changed();
    app.wait_for("late exact 日本語\n<&>  ").unwrap();
    app.scroll("id:transcript", nsh_core::geometry::px(1000.))
        .unwrap();
    app.press("label:Copy output").unwrap();
    assert_eq!(app.screen().clipboard(), Some("late exact 日本語\n<&>  "));
    app.scroll("id:transcript", nsh_core::geometry::px(-1000.))
        .unwrap();
    app.press("label:Show failed call").unwrap();
    app.scroll("id:transcript", nsh_core::geometry::px(180.))
        .unwrap();
    app.press("id:detail-failed >> label:Copy output").unwrap();
    assert_eq!(app.screen().clipboard(), Some(WORK_OUTPUT));
    // Append enough ordinary entries to recycle the original work row, then
    // return to it. Selection/copy must still name the original canonical call.
    {
        let mut state = fixture.state.lock().unwrap();
        let entries = state.messages.get_mut("a").unwrap();
        for id in 100..180 {
            entries.push(serde_json::json!({"id":id,"kind":"pi.assistant","model":[{"role":"assistant","content":[{"type":"text","text":format!("Recycling row {id} 日本語")}]}]}));
        }
    }
    fixture.changed();
    app.wait(Duration::from_millis(50)).unwrap();
    app.scroll("id:transcript", nsh_core::geometry::px(12000.))
        .unwrap();
    app.wait_for("Recycling row 179 日本語").unwrap();
    assert!(
        !app.screen().matches("id:call-failed").unwrap(),
        "original row left the recycled viewport"
    );
    app.scroll("id:transcript", nsh_core::geometry::px(-100000.))
        .unwrap();
    app.wait_for("id:detail-failed").unwrap();
    app.scroll("id:transcript", nsh_core::geometry::px(180.))
        .unwrap();
    app.press("id:detail-failed >> label:Copy output").unwrap();
    assert_eq!(app.screen().clipboard(), Some(WORK_OUTPUT));
    close
        .send_blocking(pilot_nsh::CloseInput {
            session: Some("a".into()),
            text: Some(String::new()),
            reply: None,
            composing: false,
        })
        .unwrap();
    app.wait_until("close", Duration::from_secs(5), |_| {
        replies.try_recv().is_ok()
    })
    .unwrap();
}

#[tokio::test]
async fn existing_output_bounds_keep_the_limit_disclosure_and_full_script_source() {
    let fixture = Fixture::start();
    fixture.work("a");
    let code = WORK_CODE.repeat(500);
    {
        let mut state = fixture.state.lock().unwrap();
        for entry in state.messages.get_mut("a").unwrap() {
            let message = &mut entry["model"][0];
            if message["content"][0]["id"] == "failed" {
                message["content"][0]["arguments"]["code"] = serde_json::json!(code);
            }
            if message["toolCallId"] == "failed" {
                message["content"][0]["text"] = serde_json::json!("日本語 <&>\n".repeat(10000));
            }
        }
    }
    let temp = Temp::new();
    let mut adapter = Adapter::start(fixture.options(), temp.0.clone());
    until(&mut adapter, |s| {
        s.sidebar.iter().any(|r| r.session.as_deref() == Some("a"))
    })
    .await;
    assert!(adapter.open("a"));
    let s = until(&mut adapter, |s| {
        s.messages
            .iter()
            .filter_map(|m| m.work.as_ref())
            .any(|w| w.calls.iter().any(|c| c.id == "failed" && c.limited))
    })
    .await;
    let call = s
        .messages
        .iter()
        .filter_map(|m| m.work.as_ref())
        .flat_map(|w| &w.calls)
        .find(|c| c.id == "failed")
        .unwrap();
    assert_eq!(call.input.as_ref().unwrap().1.as_str(), code);
    assert!(call.output.len() <= 40 * 1024 && call.output.ends_with('…'));
    assert_eq!(
        call.output, call.shown_output,
        "an incomplete non-header result stays literal"
    );
    assert!(adapter.close());
    until(&mut adapter, |s| s.closed).await;
}
