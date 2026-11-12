//! The read-only Linear page (`Connected.tsx`) on the released host channel,
//! one `Bridge` over the canonical `DayRoot` and an isolated real daemon with
//! synthetic saved Linear issues (`packages/daemon/src/fixtures/day-intake.ts`,
//! needs the repository's Node dependencies). Headless: no visible window,
//! provider, live source poll or external write.
//!
//! The page opens from New on Today and shows only the saved own issues and
//! saved cycle: exact links, the count it does not show, source trouble with
//! the earlier saved copy, a lost read, and a replaced checkpoint that hides
//! every row. Reading never polls Linear and sends nothing.
#![allow(dead_code)]
include!("support/intake_fixture.rs");
use nsh_core::prelude::*;
use std::path::Path;

/// A copy of the app's sources whose `nsh.json` declares the bridge's exact
/// method names, and nothing else, as a packaged connected window would.
fn entry() -> PathBuf {
    let app = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let dir = std::env::temp_dir().join(format!("day-linear-today-{}", uuid::Uuid::new_v4()));
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

const READ: &str = "id:linear-read";

#[test]
fn linear_page_shows_saved_issues_with_exact_links_and_never_polls_or_sends() {
    let mut f = Fixture::new();
    // One sync saves 102 own issues and the cycle; the first is Done and linked twice.
    f.stats("saved-linear");
    let entry = entry();
    let bridge = f.bridge();
    let mut app = open(&entry, &bridge);
    wait(&mut app, "id:incoming");
    wait(&mut app, "id:linear-open");
    app.press("id:linear-open").unwrap();
    wait(&mut app, "id:linear");
    wait(&mut app, "Your issues in cycle 12");
    assert!(!has(&app, "Mock data"));
    assert!(has(
        &app,
        "Yours: 1 of 2 finished, 1 in progress, 0 not started."
    ));
    assert!(has(&app, "id:linear-saved"));
    wait(
        &mut app,
        "100 of 102 saved issues are shown. 2 more are not shown here: Pilot shows up to 100.",
    );
    assert!(has(&app, "id:linear-group-done"));
    assert!(has(&app, "id:linear-group-todo"));
    // Exact saved IDs only: the linked issue names no mission on Today, and
    // the same title on other issues links nothing.
    let linked = "label:/^Same title, Done\\. In a mission\\./";
    app.press(linked).unwrap();
    wait(
        &mut app,
        "Linked to a mission that is not on Today. A chat is linked to it too.",
    );
    assert!(has(
        &app,
        "Earlier it was also linked to 1 other mission and 1 other chat."
    ));
    assert!(has(&app, "label:/^Same title, Todo\\. New on Today\\./"));
    let stats = f.stats("stats");
    assert_eq!(
        stats["linearReads"], 1,
        "opening the page never polls Linear"
    );
    assert_eq!(stats["posts"], 0);

    // A failed refresh keeps the earlier saved copy and says so.
    f.stats("linear-error");
    app.press(READ).unwrap();
    wait(
        &mut app,
        "Linear needs you to sign in again. These are the issues it saved before.",
    );
    assert!(has(&app, linked));

    // A read that cannot reach the service keeps the last read and says so.
    f.stats("offline");
    app.press(READ).unwrap();
    wait(&mut app, "text:/What shows is from Pilot's last read\\.$/");
    assert!(has(&app, linked));
    f.stats("allow");

    // Settings replaced since the last sync: no rows, and not the same as none.
    f.stats("linear-stale");
    app.press(READ).unwrap();
    wait(
        &mut app,
        "Pilot has not saved issues for this project's current Linear settings yet.",
    );
    gone(&mut app, linked);
    assert!(!has(&app, "id:linear-saved"));
    assert!(!has(&app, "id:linear-cycle"));

    app.press("role:button[Back to Today]").unwrap();
    wait(&mut app, "id:incoming");
    let stats = f.stats("stats");
    assert_eq!(
        stats["linearReads"], 2,
        "only the fixture's own syncs polled"
    );
    assert_eq!(stats["posts"], 0);
    assert_eq!(stats["lookups"], 0);
    assert_eq!(stats["external"], 0);
    assert_eq!(stats["sessions"], 0);
    drop(app);
    close(bridge);
    let _ = std::fs::remove_dir_all(entry.parent().unwrap());
}

/// Asks the window to save its forms and view, as a close does, and waits for its answer.
fn flush(app: &mut Headless, bridge: &Bridge) {
    let generation = bridge.request_flush().unwrap();
    let deadline = std::time::Instant::now() + WAIT;
    while !bridge.flush_ready(generation) {
        assert!(
            bridge.native_capture_finished(generation).is_ok(),
            "flush generation lost"
        );
        assert!(
            std::time::Instant::now() < deadline,
            "UI never acknowledged its saved forms"
        );
        app.wait(Duration::from_millis(50)).unwrap();
    }
}

#[test]
fn a_close_saves_the_linear_page_its_project_and_open_issue_and_sends_nothing() {
    let mut f = Fixture::new();
    f.stats("saved-linear");
    let entry = entry();
    let bridge = f.bridge();
    let mut app = open(&entry, &bridge);
    wait(&mut app, "id:linear-open");
    app.press("id:linear-open").unwrap();
    wait(&mut app, "Your issues in cycle 12");
    let linked = "label:/^Same title, Done\\. In a mission\\./";
    app.press(linked).unwrap();
    wait(
        &mut app,
        "Linked to a mission that is not on Today. A chat is linked to it too.",
    );
    flush(&mut app, &bridge);
    drop(app);
    close(bridge);
    // Read the saved window, then join that host so it lets go of the journal.
    let host = f.host();
    let saved = host.saved_window().unwrap();
    assert_eq!(host.close().recv_blocking().unwrap(), Ok(()));
    assert_eq!(saved.view["place"], "today");
    assert_eq!(saved.view["todayRow"], "linear-open");
    // The exact project and the issue open in place, by their saved IDs.
    let bridge = f.bridge();
    let read = f.call(&bridge, "day.linear.read", json!({}))["value"]["snapshot"].clone();
    close(bridge);
    let issue = read["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["title"] == "Same title" && i["metadata"]["statusType"] == "completed")
        .unwrap();
    assert_eq!(
        saved.view["linear"],
        json!(format!(
            "{}/{}",
            read["projectId"].as_str().unwrap(),
            issue["id"].as_str().unwrap()
        ))
    );
    // A plain cold reopen, without an updater selection or acknowledgement,
    // opens the same saved issue. A new capture must keep that navigation.
    let bridge = f.bridge();
    let mut app = open(&entry, &bridge);
    wait(&mut app, "id:linear");
    wait(
        &mut app,
        "Linked to a mission that is not on Today. A chat is linked to it too.",
    );
    flush(&mut app, &bridge);
    drop(app);
    close(bridge);
    let host = f.host();
    assert_eq!(
        host.saved_window().unwrap().view["linear"],
        saved.view["linear"]
    );
    assert_eq!(host.close().recv_blocking().unwrap(), Ok(()));
    let stats = f.stats("stats");
    assert_eq!(
        stats["linearReads"], 1,
        "saving the page never polls Linear"
    );
    assert_eq!(stats["posts"], 0);
    assert_eq!(stats["lookups"], 0);
    assert_eq!(stats["external"], 0);
    assert_eq!(stats["sessions"], 0);
    let _ = std::fs::remove_dir_all(entry.parent().unwrap());
}

#[test]
fn ordinary_close_reopens_exact_unsent_new_chat_words_and_never_starts() {
    let mut f = Fixture::new();
    let entry = entry();
    let bridge = f.bridge();
    let mut app = open(&entry, &bridge);
    wait(&mut app, "role:button[New]");
    app.press("role:button[New]").unwrap();
    wait(&mut app, "id:goal");
    let exact = "  Unsent 👩🏽‍💻 e\u{301} 日本語\n  ";
    app.type_text("id:goal", exact).unwrap();
    // Wait for the passive project selection so its exact choice is captured.
    wait(&mut app, "id:new-project");
    app.wait_until("project selected", WAIT, |s| !s.shows("Reading projects…"))
        .unwrap();
    flush(&mut app, &bridge);
    drop(app);
    close(bridge);
    let host = f.host();
    let saved = host.saved_window().unwrap();
    assert_eq!(saved.view["goal"], exact);
    assert_eq!(host.close().recv_blocking().unwrap(), Ok(()));
    let posts = f.stats("stats")["posts"].clone();
    let bridge = f.bridge();
    let mut app = open(&entry, &bridge);
    wait(&mut app, "id:goal");
    assert_eq!(app.screen().input_text("id:goal"), Ok(Some(exact)));
    assert!(
        !has(&app, "id:confirm-start"),
        "reopen grants no Start confirmation"
    );
    flush(&mut app, &bridge);
    drop(app);
    close(bridge);
    let host = f.host();
    assert_eq!(host.saved_window().unwrap().view["goal"], exact);
    assert_eq!(host.close().recv_blocking().unwrap(), Ok(()));
    let stats = f.stats("stats");
    assert_eq!(stats["posts"], posts);
    assert_eq!(stats["sessions"], 0);
    assert_eq!(stats["lookups"], 0);
    assert_eq!(stats["external"], 0);
    let _ = std::fs::remove_dir_all(entry.parent().unwrap());
}
