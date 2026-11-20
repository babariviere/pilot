//! Today's Slack request cards in Needs you (`Connected.tsx`) on the released
//! host channel, one `Bridge` over the canonical `DayRoot` and an isolated
//! real daemon with synthetic Slack and Linear requests
//! (`packages/daemon/src/fixtures/day/day-intake.ts`, needs the repository's Node
//! dependencies). Headless: no visible window, provider, source sync or
//! external write.
//!
//! Linear's saved issues have their own tab. New lists only Slack requests.
//! Later, Bring back, Discard and Undo each send once. A Start whose answer
//! is lost stays "not confirmed" across a native reopen; Check reads the
//! saved receipt once and nothing is sent again.
#![allow(dead_code)]
include!("support/intake_fixture.rs");
#[path = "support/app_source.rs"]
mod app_source;
use nsh_core::prelude::*;
use std::path::Path;
use std::sync::{Arc, Mutex};

/// A copy of the app's sources whose `nsh.json` declares the bridge's exact
/// method names, and nothing else, as a packaged connected window would.
fn entry() -> PathBuf {
    let app = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let dir = std::env::temp_dir().join(format!("day-intake-today-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&dir).unwrap();
    app_source::copy(&app, &dir).unwrap();
    std::fs::write(
        dir.join("nsh.json"),
        json!({"name":"Pilot","id":"dev.pilot.day","theme":"theme.json","capabilities":{"host":METHODS}})
            .to_string(),
    )
    .unwrap();
    dir.join("Connected.tsx")
}

fn ui_sets() -> Vec<Registry> {
    vec![nsh_base::registry(), pilot_day_native::registry()]
}

fn open(entry: &Path, bridge: &Bridge) -> Headless {
    let bundle = restrict(compile_tsx(entry, &ui_sets()).expect("Connected.tsx builds")).unwrap();
    let config = EngineConfig {
        ui_sets: ui_sets(),
        viewport: Size::new(Points(1100.0), Points(1400.0)),
        host: bridge.channel(),
        ..EngineConfig::new(bundle)
    };
    Headless::start(config).expect("the engine starts")
}

/// Stops the engine first, then joins the root, as the native owner must.
fn close_window(app: Headless, bridge: Bridge) {
    drop(app);
    close(bridge);
}

fn wait(app: &mut Headless, what: &str) {
    app.wait_for_within(what, WAIT)
        .unwrap_or_else(|e| panic!("{what}: {e}\n{:?}", app.screen().texts()));
}

fn has(app: &Headless, selector: &str) -> bool {
    app.screen().matches(selector).unwrap_or(false)
}

/// Waits until `selector` no longer shows.
fn gone(app: &mut Headless, selector: &str) {
    let deadline = std::time::Instant::now() + WAIT;
    while has(app, selector) {
        assert!(
            std::time::Instant::now() < deadline,
            "{selector} still shows"
        );
        app.wait(Duration::from_millis(50)).unwrap();
    }
}

const CHECK: &str =
    "role:button[Check whether it happened. This reads Pilot's saved answer and sends nothing.]";

#[test]
fn today_triage_and_start_send_once_and_a_lost_start_stays_check_only_across_reopen() {
    let mut f = Fixture::new();
    f.stats("saved-linear");
    f.stats("slack-requests");
    let entry = entry();
    let bridge = f.bridge();
    let mut app = open(&entry, &bridge);
    let card = |title: &str| format!("id:request >> {title}");
    let button = |label: &str| format!("id:request >> role:button[{label}]");
    let posts = |f: &mut Fixture| f.stats("stats")["posts"].as_u64().unwrap();
    // The newest Slack request is the card in front; the next waits as Up next.
    wait(&mut app, &card("Slack one"));
    wait(&mut app, "Up next, Slack request: Slack two");
    assert!(!has(&app, "Mock data"));
    assert!(has(
        &app,
        "id:request >> text:/^· #client-one · Jane Doe · \\d+ min ago$/"
    ));
    assert!(has(&app, "“the Export button spins forever”"));
    assert!(has(&app, "id:request >> Northwind"));
    assert!(!has(&app, "Same title"));
    app.press("id:today-tab-new").unwrap();
    wait(&mut app, "id:today-new >> text:Slack one");
    assert!(has(&app, "id:today-tab-new >> text:2"));
    assert!(!has(&app, "id:today-new >> text:Same title"));
    wait(&mut app, "id:today-tab-linear");
    app.press("id:today-tab-linear").unwrap();
    wait(&mut app, "id:today-linear >> text:Same title");
    assert!(!has(&app, "id:linear-panel"));
    app.press("id:today-tab-overview").unwrap();
    wait(&mut app, &card("Slack one"));
    // This window has no browser opener, so the card offers no link.
    assert!(!has(&app, "Open in Slack"));
    assert_eq!(posts(&mut f), 0);

    app.press(&button("Later")).unwrap();
    wait(&mut app, "id:intake-later");
    wait(&mut app, &card("Slack two"));
    assert_eq!(posts(&mut f), 1);
    app.press("role:button[Show later requests]").unwrap();
    app.press("role:button[Bring back]").unwrap();
    wait(&mut app, &card("Slack one"));
    gone(&mut app, "id:intake-later");
    assert_eq!(posts(&mut f), 2);

    app.press(&button("Discard")).unwrap();
    wait(&mut app, "Discarded “Slack one”.");
    app.press("id:undo-last").unwrap();
    wait(&mut app, &card("Slack one"));
    gone(&mut app, "id:incoming-undo");
    assert_eq!(posts(&mut f), 4);

    // A Start whose answer is lost: saved, sent once, then only checked.
    f.stats("lost");
    app.press(&button("Start work")).unwrap();
    wait(
        &mut app,
        "Start one Build chat for “Slack one” as standalone work?",
    );
    app.press(&button("Start")).unwrap();
    wait(&mut app, "Starting work on “Slack one” is not confirmed.");
    gone(&mut app, &card("Slack one"));
    let stats = f.stats("stats");
    assert_eq!(stats["posts"], 5);
    assert_eq!(stats["sessions"], 1);
    close_window(app, bridge);

    // A cold native reopen still shows it, and offers Check only. The request
    // is already linked to its chat, so the read no longer holds its title.
    // This window's opener only records the address it is handed.
    let opened = Arc::new(Mutex::new(Vec::<String>::new()));
    let source: Source = serde_json::from_value(f.info["source"].clone()).unwrap();
    let recorder = opened.clone();
    let host = f.host_for_options(
        source,
        pilot_day_native::host::Options {
            url_opener: Some(Arc::new(move |url| {
                recorder.lock().unwrap().push(url.into());
                Ok(())
            })),
            ..Default::default()
        },
    );
    let bridge = Bridge::new(DayRoot::new(host));
    let mut app = open(&entry, &bridge);
    wait(&mut app, "Starting work on a request is not confirmed.");
    wait(&mut app, &card("Slack two"));
    assert!(!has(&app, "Slack one"));
    app.press(CHECK).unwrap();
    wait(
        &mut app,
        "Started a request as standalone work: one Build chat was created. That is not progress or a result yet.",
    );
    gone(&mut app, "Starting work on a request is not confirmed.");
    // Open in Slack hands the request's saved message link to the browser once, and sends nothing.
    app.press(&button("Open in Slack")).unwrap();
    let deadline = std::time::Instant::now() + WAIT;
    while opened.lock().unwrap().is_empty() {
        assert!(std::time::Instant::now() < deadline, "nothing opened");
        app.wait(Duration::from_millis(50)).unwrap();
    }
    assert_eq!(
        *opened.lock().unwrap(),
        ["https://slack.com/archives/C1/p1791892700000200"]
    );
    let stats = f.stats("stats");
    assert_eq!(stats["posts"], 5, "Check never sends the Start again");
    assert_eq!(stats["lookups"], 1);
    assert_eq!(stats["sessions"], 1);
    assert_eq!(stats["external"], 0);
    close_window(app, bridge);
    let _ = std::fs::remove_dir_all(entry.parent().unwrap());
}
