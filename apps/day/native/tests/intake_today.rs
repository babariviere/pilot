//! Today's New section (`Connected.tsx`) on the released host channel, one
//! `Bridge` over the canonical `DayRoot` and an isolated real daemon with
//! synthetic Linear requests (`packages/daemon/src/fixtures/day-intake.ts`,
//! needs the repository's Node dependencies). Headless: no visible window,
//! provider, source sync or external write.
//!
//! Later, Bring back, Discard and Undo each send once. A Start whose answer
//! is lost stays "not confirmed" across a native reopen; Check reads the
//! saved receipt once and nothing is sent again.
#![allow(dead_code)]
include!("support/intake_fixture.rs");
use nsh_core::prelude::*;
use std::path::Path;

/// A copy of the app's sources whose `nsh.json` declares the bridge's exact
/// method names, and nothing else, as a packaged connected window would.
fn entry() -> PathBuf {
    let app = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let dir = std::env::temp_dir().join(format!("day-intake-today-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&dir).unwrap();
    for file in std::fs::read_dir(&app).unwrap() {
        let path = file.unwrap().path();
        let name = path.file_name().unwrap().to_str().unwrap().to_owned();
        if (name.ends_with(".ts") || name.ends_with(".tsx") || name == "theme.json")
            && !name.ends_with(".test.tsx")
        {
            std::fs::copy(&path, dir.join(&name)).unwrap();
        }
    }
    // Shared chrome imports its packaged SVGs. Keep this isolated source copy
    // complete rather than removing icons or granting filesystem capabilities.
    std::fs::create_dir(dir.join("icons")).unwrap();
    for file in std::fs::read_dir(app.join("icons")).unwrap() {
        let path = file.unwrap().path();
        if path.extension().is_some_and(|e| e == "svg") {
            std::fs::copy(&path, dir.join("icons").join(path.file_name().unwrap())).unwrap();
        }
    }
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
    let entry = entry();
    let bridge = f.bridge();
    let mut app = open(&entry, &bridge);
    wait(&mut app, "id:incoming");
    wait(&mut app, "Request one");
    wait(&mut app, "Request two");
    assert!(!has(&app, "Mock data"));
    // Linear only: the fixture's project has no Slack channels.
    assert!(has(&app, "From Linear"));
    // Rows name their request; their test IDs carry the exact tracked-item ID.
    let row = |title: &str| format!("label:/^{title}, new from Linear\\./");
    let posts = |f: &mut Fixture| f.stats("stats")["posts"].as_u64().unwrap();
    // Opening a request sends nothing.
    app.press(&row("Request one")).unwrap();
    wait(&mut app, "role:button[Later]");
    assert_eq!(posts(&mut f), 0);

    app.press("role:button[Later]").unwrap();
    wait(&mut app, "id:intake-later");
    gone(&mut app, &row("Request one"));
    assert_eq!(posts(&mut f), 1);
    app.press("role:button[Show later requests]").unwrap();
    app.press("role:button[Bring back]").unwrap();
    wait(&mut app, &row("Request one"));
    gone(&mut app, "id:intake-later");
    assert_eq!(posts(&mut f), 2);

    app.press(&row("Request two")).unwrap();
    app.press("role:button[Discard]").unwrap();
    wait(&mut app, "Discarded “Request two”.");
    app.press("id:undo-last").unwrap();
    wait(&mut app, &row("Request two"));
    gone(&mut app, "id:incoming-undo");
    assert_eq!(posts(&mut f), 4);

    // A Start whose answer is lost: saved, sent once, then only checked.
    f.stats("lost");
    app.press(&row("Request one")).unwrap();
    app.press("role:button[Start work…]").unwrap();
    wait(
        &mut app,
        "Start one Build chat for “Request one” as standalone work?",
    );
    app.press("role:button[Start]").unwrap();
    wait(&mut app, "Starting work on “Request one” is not confirmed.");
    gone(&mut app, &row("Request one"));
    let stats = f.stats("stats");
    assert_eq!(stats["posts"], 5);
    assert_eq!(stats["sessions"], 1);
    close_window(app, bridge);

    // A cold native reopen still shows it, and offers Check only. The request
    // is already linked to its chat, so the read no longer holds its title.
    let bridge = f.bridge();
    let mut app = open(&entry, &bridge);
    wait(&mut app, "Starting work on a request is not confirmed.");
    assert!(!has(&app, &row("Request one")));
    assert!(has(&app, &row("Request two")));
    app.press(CHECK).unwrap();
    wait(
        &mut app,
        "Started a request as standalone work: one Build chat was created. That is not progress or a result yet.",
    );
    gone(&mut app, "Starting work on a request is not confirmed.");
    let stats = f.stats("stats");
    assert_eq!(stats["posts"], 5, "Check never sends the Start again");
    assert_eq!(stats["lookups"], 1);
    assert_eq!(stats["sessions"], 1);
    assert_eq!(stats["external"], 0);
    close_window(app, bridge);
    let _ = std::fs::remove_dir_all(entry.parent().unwrap());
}
