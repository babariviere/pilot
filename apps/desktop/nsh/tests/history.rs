#![cfg(feature = "native-probes")]
use nsh_engine::EngineConfig;
use nsh_testing::Headless;
use pilot_desktop::nsh_adapter::{Adapter, Snapshot};
use pilot_nsh::{
    Config,
    fixture::{Fixture, HISTORY_QUERY},
};
use std::{path::PathBuf, time::Duration};

struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!(
                "nsh-history-{}-{}",
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
async fn until(a: &mut Adapter, predicate: impl Fn(&Snapshot) -> bool) -> Snapshot {
    let events = a.events();
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let s = a.snapshot();
            if predicate(&s) {
                return s;
            }
            a.accept(events.next().await.unwrap());
        }
    })
    .await
    .unwrap_or_else(|_| panic!("adapter deadline: {:?}", a.snapshot()))
}
async fn open(a: &mut Adapter) -> Snapshot {
    until(a, |s| {
        s.sidebar.iter().any(|r| r.session.as_deref() == Some("a"))
    })
    .await;
    assert!(a.open("a"));
    until(a, |s| s.earlier && s.messages.len() == 24 && s.editable).await
}
fn pages(f: &Fixture) -> usize {
    f.state
        .lock()
        .unwrap()
        .requests
        .iter()
        .filter(|(_, p)| p.contains("/history?"))
        .count()
}

#[tokio::test]
async fn bounded_initial_full_history_unicode_wrapping_and_concurrent_append() {
    let fixture = Fixture::start();
    fixture.history("a", 96);
    let temp = Temp::new();
    let mut a = Adapter::start(fixture.options(), temp.0.clone());
    let s = open(&mut a).await;
    let location = s.location.unwrap();
    assert_eq!(pages(&fixture), 0, "no eager prefix reads");
    assert!(
        fixture
            .state
            .lock()
            .unwrap()
            .requests
            .iter()
            .any(|(m, p)| m == "WS" && p == "/api/sessions/a/ws?history=paged-v1")
    );
    let anchor = s.messages[0].reader.clone();
    a.find_open(&location, true);
    a.find_query(&location, HISTORY_QUERY);
    until(&mut a, |s| !s.find.busy).await;
    assert_eq!(a.snapshot().find.status, "No matches in loaded messages");
    assert!(
        a.snapshot()
            .find
            .coverage
            .starts_with("Loaded messages only")
    );
    fixture.state.lock().unwrap().history_delay_ms = 50;
    a.find_history(&location, true);
    fixture.append_history("a");
    let s = until(&mut a, |s| {
        s.messages.len() == 97 && !s.earlier && !s.find.busy && !s.find.loading
    })
    .await;
    assert_eq!(pages(&fixture), 3);
    assert!(s.messages.iter().any(|m| m.reader == anchor));
    assert_eq!(s.find.coverage, "All messages · literal source");
    assert_eq!(s.find.count, 4);
    a.find_step(&location, true);
    let s = a.snapshot();
    assert_eq!(s.find.status, "4 of 4");
    let hit = s.find.target.unwrap();
    assert_eq!(&hit.source[hit.range.clone()], HISTORY_QUERY);
    assert!(hit.range.start > HISTORY_QUERY.chars().count());
    assert!(
        s.messages
            .iter()
            .any(|m| m.reader.as_ref() == Some(&hit.key) && m.source == *hit.source)
    );
    a.find_step(&location, false);
    assert_eq!(a.snapshot().find.status, "1 of 4");
    a.find_query(&location, "CAFÉ");
    until(&mut a, |s| !s.find.busy).await;
    assert_eq!(
        a.snapshot().find.status,
        "No matches",
        "literal case and normalization are unchanged"
    );
    a.find_query(&location, &"x".repeat(1025));
    assert_eq!(a.snapshot().find.status, "Query exceeds 1 KiB");
    assert!(a.close());
    until(&mut a, |s| s.closed).await;
    assert!(fixture.state.lock().unwrap().envelopes.is_empty());
}

#[tokio::test]
async fn scanner_keeps_the_existing_hit_limit() {
    let fixture = Fixture::start();
    fixture.history("a", 96);
    fixture
        .state
        .lock()
        .unwrap()
        .histories
        .get_mut("a")
        .unwrap()[73]["model"][0]["content"][0]["text"] = serde_json::json!("needle ".repeat(1100));
    let temp = Temp::new();
    let mut a = Adapter::start(fixture.options(), temp.0.clone());
    let location = open(&mut a).await.location.unwrap();
    a.find_open(&location, true);
    a.find_query(&location, "needle");
    let s = until(&mut a, |s| !s.find.busy).await;
    assert_eq!(s.find.count, 1000);
    assert_eq!(s.find.status, "1 of 1000+ (limit)");
    assert!(s.find.coverage.starts_with("Loaded messages only"));
    assert!(a.close());
    until(&mut a, |s| s.closed).await;
}

#[tokio::test]
async fn cancellation_query_location_and_failed_page_never_claim_complete() {
    let fixture = Fixture::start();
    fixture.history("a", 120);
    let temp = Temp::new();
    let mut a = Adapter::start(fixture.options(), temp.0.clone());
    let location = open(&mut a).await.location.unwrap();
    a.find_open(&location, true);
    a.find_query(&location, HISTORY_QUERY);
    until(&mut a, |s| !s.find.busy).await;
    fixture.state.lock().unwrap().history_failure = true;
    a.find_history(&location, true);
    let s = until(&mut a, |s| !s.history_status.is_empty() && !s.find.loading).await;
    assert!(s.find.coverage.contains("reader unavailable"));
    assert_eq!(s.find.status, "No matches in loaded messages");
    let failed_pages = pages(&fixture);
    a.history_top(&location);
    assert_eq!(pages(&fixture), failed_pages, "no failed-page retry loop");
    {
        let mut state = fixture.state.lock().unwrap();
        state.history_failure = false;
        state.history_delay_ms = 200;
    }
    a.find_history(&location, true);
    a.find_history(&location, false);
    let s = until(&mut a, |s| s.messages.len() == 48 && !s.find.busy).await;
    assert_eq!(s.find.coverage, "Loading cancelled · loaded messages only");
    assert!(s.earlier);
    a.find_history(&location, true);
    a.find_query(&location, "not present");
    assert!(
        !a.snapshot().find.loading,
        "query change cancels further pages"
    );
    assert!(a.open("b"));
    let b = until(&mut a, |s| {
        s.messages
            .iter()
            .any(|m| m.source.contains("production Local reader"))
    })
    .await;
    assert!(!b.find.open);
    assert!(b.find.target.is_none());
    a.find_query(&location, HISTORY_QUERY);
    a.find_history(&location, true);
    assert!(
        !a.snapshot().find.open,
        "late callbacks cannot target another chat"
    );
    assert!(a.close());
    until(&mut a, |s| s.closed).await;
}

#[test]
fn native_find_shortcuts_older_hit_recycling_and_draft_focus() {
    let fixture = Fixture::start();
    fixture.history("a", 96);
    let temp = Temp::new();
    let (_close, requests) = async_channel::bounded(1);
    let (closed, _replies) = async_channel::bounded(1);
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
    app.wait_for("label:Message in a").unwrap();
    app.type_text("label:Message in a", "draft 日本語 👩🏽‍💻")
        .unwrap();
    assert_eq!(pages(&fixture), 0);
    app.press_key("mod+f").unwrap();
    app.wait_for("id:transcript-find").unwrap();
    app.type_text("id:transcript-find", HISTORY_QUERY).unwrap();
    app.wait_for("No matches in loaded messages").unwrap();
    app.press("label:Load full history").unwrap();
    app.wait_for("All messages · literal source").unwrap();
    app.wait_for("1 of 4").unwrap();
    app.press("label:Next match (Enter)").unwrap();
    app.wait_for("2 of 4").unwrap();
    app.wait_until("source context", Duration::from_secs(5), |s| {
        s.texts().iter().any(|s| s.starts_with("Source match 2:"))
    })
    .unwrap();
    app.press_key("mod+f").unwrap();
    app.press_key("shift+enter").unwrap();
    app.wait_for("1 of 4").unwrap();
    app.press_key("shift+enter").unwrap();
    app.wait_for("4 of 4").unwrap();
    app.press_key("enter").unwrap();
    app.wait_for("1 of 4").unwrap();
    app.press_key("escape").unwrap();
    assert!(!app.screen().matches("id:transcript-find").unwrap());
    assert_eq!(
        app.screen().input_text("label:Message in a").unwrap(),
        Some("draft 日本語 👩🏽‍💻")
    );
    let loaded = pages(&fixture);
    app.press("label:Open chat b").unwrap();
    app.wait_for("label:Message in b").unwrap();
    app.press("label:Open chat a").unwrap();
    app.wait_until(
        "canonical old-page restoration",
        Duration::from_secs(5),
        |s| pages(&fixture) >= loaded + 3 && s.texts().iter().any(|s| s.starts_with("Older 3:")),
    )
    .unwrap();
    assert!(fixture.state.lock().unwrap().envelopes.is_empty());
}
