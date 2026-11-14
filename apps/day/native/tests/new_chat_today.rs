//! New's project choice and standalone chat (`Connected.tsx`) on the released
//! host channel, one `Bridge` over the canonical `DayRoot` and an isolated
//! real daemon with two projects (`packages/daemon/src/fixtures/day-intake.ts`,
//! needs the repository's Node dependencies). Headless: no visible window,
//! provider, source sync or external write.
//!
//! New starts with no project, and both starts wait for the user's choice;
//! choosing a project and Ask only reads its setup. Start chat sends once. A creation whose answer is
//! lost stays "not confirmed" across a native reopen; Check reads the saved
//! receipt once, nothing is sent again, and the saved chat is in the chosen
//! project.
#![allow(dead_code)]
include!("support/intake_fixture.rs");
use nsh_core::prelude::*;
use std::path::Path;

/// A copy of the app's sources whose `nsh.json` declares the bridge's exact
/// method names, and nothing else, as a packaged connected window would.
fn entry() -> PathBuf {
    let app = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let dir = std::env::temp_dir().join(format!("day-new-chat-{}", uuid::Uuid::new_v4()));
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

/// Waits until `selector` can be pressed. NSH 0.4.0 rechecks waits only on
/// screen changes, so poll with a deadline.
fn enabled(app: &mut Headless, selector: &str) {
    let deadline = std::time::Instant::now() + WAIT;
    while !app.screen().enabled(selector).unwrap_or(false) {
        assert!(
            std::time::Instant::now() < deadline,
            "{selector} stays disabled: {:?}",
            app.screen().texts()
        );
        app.wait(Duration::from_millis(50)).unwrap();
    }
}

/// Waits until the screen shows exactly `text` (paths start with "/", which selectors read as a regex).
fn wait_text(app: &mut Headless, text: &str) {
    let deadline = std::time::Instant::now() + WAIT;
    while !app.screen().texts().contains(&text) {
        assert!(
            std::time::Instant::now() < deadline,
            "{text} never shows: {:?}",
            app.screen().texts()
        );
        app.wait(Duration::from_millis(50)).unwrap();
    }
}

const CHECK: &str = "role:button[Check whether the new chat started. This reads Pilot's saved answer and sends nothing.]";
const PICKER: &str = "label:Project for a new chat";

#[test]
fn new_chat_starts_once_in_the_chosen_project_and_a_lost_answer_stays_check_only_across_reopen() {
    let mut f = Fixture::new();
    let entry = entry();
    let bridge = f.bridge();
    // Passive: the profile's projects and this window's own one.
    let list = f.call(&bridge, "day.projects.read", json!({}));
    assert_eq!(
        list["value"]["current"], f.info["source"]["project_id"],
        "{list}"
    );
    let projects = list["value"]["snapshot"]["projects"]
        .as_array()
        .unwrap()
        .clone();
    assert_eq!(projects.len(), 2);
    let own = projects
        .iter()
        .find(|p| p["projectId"] == f.info["source"]["project_id"])
        .unwrap()
        .clone();
    let other = projects
        .iter()
        .find(|p| p["projectId"] != own["projectId"])
        .unwrap()
        .clone();
    let own_path = own["projectPath"].as_str().unwrap().to_owned();
    let own_name = own["name"].as_str().unwrap().to_owned();
    let other_path = other["projectPath"].as_str().unwrap().to_owned();
    let other_name = other["name"].as_str().unwrap().to_owned();
    assert_ne!(other_name, own["name"].as_str().unwrap());
    let stats = |f: &mut Fixture| f.stats("stats");

    let mut app = open(&entry, &bridge);
    wait(&mut app, "id:incoming");
    assert!(!has(&app, "Mock data"));
    app.press("role:button[New]").unwrap();
    wait(&mut app, "What do you want done?");
    // New never picks a project, not even this window's own.
    wait_text(&mut app, "No project is chosen for you.");
    app.type_text("id:goal", "  Exact words 👩🏽‍💻\nkept  ")
        .unwrap();
    assert!(!app.screen().enabled("role:button[Plan a mission]").unwrap());
    assert!(
        !app.screen()
            .enabled("role:button[Start as one chat]")
            .unwrap()
    );
    // Choosing a project only reads its setup.
    app.press(PICKER).unwrap();
    app.press(&format!("text:{own_name}")).unwrap();
    wait_text(&mut app, &own_path);
    enabled(&mut app, "role:button[Plan a mission]");
    app.press(PICKER).unwrap();
    app.press(&format!("text:{other_name}")).unwrap();
    wait_text(&mut app, &other_path);
    assert!(
        !app.screen().enabled("role:button[Plan a mission]").unwrap(),
        "missions still start in the window's own project"
    );
    app.press("role:button[Start as one chat]").unwrap();
    wait(&mut app, "Start one chat with exactly these words?");
    app.press("id:mode-ask").unwrap();
    enabled(&mut app, "role:button[Start chat]");
    let s = stats(&mut f);
    assert_eq!(
        (s["posts"].as_u64(), s["sessions"].as_u64()),
        (Some(0), Some(0)),
        "selection is passive"
    );

    // The creation's answer is lost: saved, sent once, then only checked.
    f.stats("lost");
    app.press("role:button[Start chat]").unwrap();
    wait(
        &mut app,
        &format!("A new chat in {other_name} is not confirmed."),
    );
    assert!(!app.screen().enabled("role:button[Start chat]").unwrap());
    let s = stats(&mut f);
    assert_eq!(s["posts"], 1);
    assert_eq!(s["sessions"], 1);
    close_window(app, bridge);

    // A cold native reopen still shows it on New, and offers Check only.
    let bridge = f.bridge();
    let mut app = open(&entry, &bridge);
    wait(&mut app, "id:incoming");
    app.press("role:button[New]").unwrap();
    wait(
        &mut app,
        &format!("A new chat in {other_name} is not confirmed."),
    );
    // New picks no project after reopen either. Choosing one only reads, and
    // the unknown creation refuses the selection.
    app.press(PICKER).unwrap();
    app.press(&format!("text:{other_name}")).unwrap();
    wait(
        &mut app,
        "An earlier new chat is not confirmed. Check it before you start another.",
    );
    assert!(
        !app.screen()
            .enabled("role:button[Start as one chat]")
            .unwrap()
    );
    app.press(CHECK).unwrap();
    wait(
        &mut app,
        &format!(
            "The chat in {other_name} started. It works on its own; that is not progress or a result yet."
        ),
    );
    let s = stats(&mut f);
    assert_eq!(s["posts"], 1, "Check never sends the creation again");
    assert_eq!(s["lookups"], 1);
    assert_eq!(s["sessions"], 1);
    assert_eq!(s["external"], 0);
    // The saved chat is in the chosen project.
    let read = f.call(&bridge, "day.projects.read", json!({}));
    let ops = read["value"]["operations"].as_array().unwrap();
    assert_eq!(ops.len(), 1, "{read}");
    assert_eq!(ops[0]["state"], "accepted");
    assert_eq!(ops[0]["projectId"], other["projectId"]);
    assert_eq!(ops[0]["receipt"]["result"]["projectId"], other["projectId"]);
    close_window(app, bridge);
    let _ = std::fs::remove_dir_all(entry.parent().unwrap());
}
