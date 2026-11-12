//! Today's To check and a delivered result's page (`Connected.tsx`) on the
//! released host channel, one `Bridge` over the canonical `DayRoot` and an
//! isolated real daemon with a synthetic delivered task
//! (`packages/daemon/src/fixtures/day-delivery.ts`, needs the repository's
//! Node dependencies). Headless: no visible window, provider or external write.
//!
//! Reading the page sends nothing; Mark done, Reopen and Send back each send
//! once. An unsent note is saved with the window. A result reopened for a
//! check joins To check after a cold reopen. A Send back whose answer is lost
//! stays "not confirmed" across a reopen; Check reads it once and nothing is
//! sent again.
#![allow(dead_code)]
include!("support/intake_fixture.rs");
use nsh_core::prelude::*;
use std::path::Path;

/// A copy of the app's sources whose `nsh.json` declares the bridge's exact
/// method names, and nothing else, as a packaged connected window would.
fn entry() -> PathBuf {
    let app = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let dir = std::env::temp_dir().join(format!("day-delivery-today-{}", uuid::Uuid::new_v4()));
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
        viewport: Size::new(Points(1100.0), Points(1600.0)),
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

/// Waits until a text on screen equals `text` exactly.
fn wait_text(app: &mut Headless, text: &str) {
    let deadline = std::time::Instant::now() + WAIT;
    while !app.screen().texts().contains(&text) {
        assert!(
            std::time::Instant::now() < deadline,
            "{text} never showed: {:?}",
            app.screen().texts()
        );
        app.wait(Duration::from_millis(50)).unwrap();
    }
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

/// Asks for a flush and waits until the UI saved its forms and the view.
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

const CHECK: &str =
    "role:button[Check whether it happened. This reads Pilot's saved answer and sends nothing.]";
const NOTE: &str = "  Keep exact bytes 👩🏽‍💻\nThis is not deployed.  ";

#[test]
fn delivered_task_checked_from_its_mission_sent_back_once_and_a_lost_answer_stays_check_only() {
    let mut f = Fixture::with_daemon("day-delivery.ts");
    let entry = entry();
    let task = f.info["task"].clone();
    let mission = task["missionId"].as_str().unwrap().to_owned();
    let task_id = task["taskId"].as_str().unwrap().to_owned();
    let key = format!(
        "task/{}/{mission}/{task_id}",
        task["projectId"].as_str().unwrap()
    );
    let row = format!("id:check-{}", key.replace('/', "."));
    let posts = |f: &mut Fixture| f.stats("stats")["posts"].as_u64().unwrap();

    let bridge = f.bridge();
    let mut app = open(&entry, &bridge);
    wait(&mut app, &format!("id:mission-{mission}"));
    assert!(!has(&app, "Mock data"));
    // Nothing was checked before: To check has nothing to show yet.
    assert!(!has(&app, "id:to-check"));
    app.press(&format!("id:mission-{mission}")).unwrap();
    wait(&mut app, &format!("id:check-result-{task_id}"));
    app.press(&format!("id:check-result-{task_id}")).unwrap();
    wait(&mut app, "id:your-check");
    // The agent's account, its outputs and four separate lines.
    assert!(has(&app, "Synthetic checks"));
    assert!(has(&app, "Not deployed"));
    assert!(has(&app, "PR #1 · Synthetic PR"));
    assert!(has(&app, "Output"));
    wait_text(&mut app, "Says it finished. Commit aaaaaaa.");
    wait_text(&mut app, "PR #1: merged.");
    wait_text(&mut app, "Not tracked. Merged is not released.");
    wait_text(&mut app, "Not checked yet.");
    app.press("id:reminder-report").unwrap();
    assert_eq!(posts(&mut f), 0, "reading and reminders send nothing");

    // A merged PR needs no extra confirmation. Done, then Reopen, each once.
    app.press("id:mark-done").unwrap();
    wait(&mut app, "id:delivery-done");
    wait_text(&mut app, "Done. You accepted this result.");
    wait_text(&mut app, "Not tracked. Merged is not released.");
    assert_eq!(posts(&mut f), 1);
    app.press("id:delivery-reopen").unwrap();
    wait(&mut app, "id:mark-done");
    wait_text(&mut app, "Open again. Not checked yet.");
    assert_eq!(posts(&mut f), 2);

    // An unsent note is saved with the window, exactly.
    app.press("id:send-back-open").unwrap();
    wait(&mut app, "id:send-back-note");
    app.type_text("id:send-back-note", NOTE).unwrap();
    flush(&mut app, &bridge);
    close_window(app, bridge);
    let host = f.host();
    let saved = host.saved_window().unwrap();
    assert_eq!(saved.view["delivery"], key);
    assert_eq!(saved.view["notes"], json!([format!("{key}\n{NOTE}")]));
    assert_eq!(posts(&mut f), 2, "saving the window sends nothing");

    // A cold reopen: the reopened result waits in To check.
    let bridge = Bridge::new(DayRoot::new(host));
    let mut app = open(&entry, &bridge);
    wait(&mut app, "id:to-check");
    wait(&mut app, &row);
    app.press(&row).unwrap();
    wait(&mut app, "id:your-check");
    app.press("id:send-back-open").unwrap();
    wait(&mut app, "id:send-back-note");
    app.type_text("id:send-back-note", NOTE).unwrap();
    // Its answer is lost: saved, sent once, then only checked.
    f.stats("lost");
    app.press("id:send-back").unwrap();
    wait(&mut app, "id:delivery-unknown");
    wait_text(&mut app, "Not confirmed. Check only.");
    assert!(!has(&app, "id:mark-done"));
    let stats = f.stats("stats");
    assert_eq!(stats["posts"], 3);
    assert_eq!(stats["messages"].as_array().unwrap().len(), 1);
    assert_eq!(stats["messages"][0]["content"], NOTE);
    close_window(app, bridge);

    // Another cold reopen still says so on Today and offers Check only.
    let bridge = f.bridge();
    let mut app = open(&entry, &bridge);
    wait(
        &mut app,
        "Sending back “A task in Synthetic result” is not confirmed.",
    );
    gone(&mut app, &row);
    app.press(CHECK).unwrap();
    wait(
        &mut app,
        "Sent “A task in Synthetic result” back. The agent has your note.",
    );
    let stats = f.stats("stats");
    assert_eq!(stats["posts"], 3, "Check never sends the note again");
    assert_eq!(stats["lookups"], 1);
    assert_eq!(stats["messages"].as_array().unwrap().len(), 1);
    assert_eq!(stats["external"], 0);
    // The saved commands read only the journal: the root's own project and
    // every command, with no lookup or send.
    let saved = f.call(&bridge, "day.delivery.saved", json!({}));
    assert_eq!(saved["value"]["snapshot"]["projectId"], task["projectId"]);
    let actions: Vec<_> = saved["value"]["operations"]
        .as_array()
        .unwrap()
        .iter()
        .map(|o| o["action"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(actions.len(), 3, "{saved}");
    for action in ["done", "reopen", "send_back"] {
        assert!(actions.iter().any(|a| a == action), "{saved}");
    }
    assert_eq!(
        f.call(&bridge, "day.delivery.saved", json!({"subject":task}))["error"],
        "invalid"
    );
    let stats = f.stats("stats");
    assert_eq!(
        (stats["posts"].as_u64(), stats["lookups"].as_u64()),
        (Some(3), Some(1))
    );
    close_window(app, bridge);
    let _ = std::fs::remove_dir_all(entry.parent().unwrap());
}
