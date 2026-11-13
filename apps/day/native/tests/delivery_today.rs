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
use nsh_engine::HostCall;
use std::path::Path;
use std::sync::{Arc, Mutex};

/// A copy of the app's sources whose `nsh.json` declares the bridge's exact
/// method names, and nothing else, as a packaged connected window would.
fn entry() -> PathBuf {
    let app = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let dir = std::env::temp_dir().join(format!("day-delivery-today-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&dir).unwrap();
    std::fs::create_dir(dir.join("icons")).unwrap();
    for file in std::fs::read_dir(app.join("icons")).unwrap() {
        let path = file.unwrap().path();
        std::fs::copy(&path, dir.join("icons").join(path.file_name().unwrap())).unwrap();
    }
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
    // Nothing was checked before, and the start-fresh cutoff leaves out this
    // earlier delivery. To check says it is reading, then has nothing to show.
    gone(&mut app, "id:to-check");
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

    // A cold reopen restores the result and its unsent note first.
    let bridge = Bridge::new(DayRoot::new(host));
    let mut app = open(&entry, &bridge);
    wait(&mut app, "id:send-back-note");
    assert_eq!(app.screen().input_text("id:send-back-note"), Ok(Some(NOTE)));
    // Explicitly return to Today to find the reopened result in To check.
    app.press("id:back").unwrap();
    wait(&mut app, &format!("id:check-result-{task_id}"));
    app.press("id:back").unwrap();
    wait(&mut app, "id:to-check");
    wait(&mut app, &row);
    app.press(&row).unwrap();
    wait(&mut app, "id:your-check");
    wait(&mut app, "id:send-back-note");
    assert_eq!(app.screen().input_text("id:send-back-note"), Ok(Some(NOTE)));
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
    app.press("id:back").unwrap();
    wait(&mut app, "id:to-check");
    flush(&mut app, &bridge);
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

/// A host whose browser opener only records the addresses it is handed.
fn recording(f: &Fixture, opened: &Arc<Mutex<Vec<String>>>) -> NativeHost {
    let source: Source = serde_json::from_value(f.info["source"].clone()).unwrap();
    let opened = opened.clone();
    let options = pilot_day_native::host::Options {
        url_opener: Some(Arc::new(move |url| {
            opened.lock().unwrap().push(url.into());
            Ok(())
        })),
        ..Default::default()
    };
    f.host_for_options(source, options)
}

#[test]
fn a_press_opens_the_exact_pull_request_once_and_ticked_reminders_are_saved_with_the_window() {
    let mut f = Fixture::with_daemon("day-delivery.ts");
    let entry = entry();
    let task = f.info["task"].clone();
    let mission = task["missionId"].as_str().unwrap().to_owned();
    let task_id = task["taskId"].as_str().unwrap().to_owned();
    let key = format!(
        "task/{}/{mission}/{task_id}",
        task["projectId"].as_str().unwrap()
    );
    let opened = Arc::new(Mutex::new(Vec::new()));

    // Without an opener the link is text only.
    let bridge = f.bridge();
    let mut app = open(&entry, &bridge);
    wait(&mut app, &format!("id:mission-{mission}"));
    app.press(&format!("id:mission-{mission}")).unwrap();
    wait(&mut app, &format!("id:check-result-{task_id}"));
    app.press(&format!("id:check-result-{task_id}")).unwrap();
    wait(&mut app, "id:your-check");
    wait(
        &mut app,
        "Pilot cannot open links in this window. Copy one; opening it records nothing.",
    );
    let page = f.call(&bridge, "day.delivery.read", task.clone())["value"]["snapshot"].clone();
    let pr = page["pullRequests"][0].clone();
    let button = format!("id:output-open-{}", pr["id"].as_str().unwrap());
    assert!(!has(&app, &button));
    close_window(app, bridge);

    let bridge = Bridge::new(DayRoot::new(recording(&f, &opened)));
    let mut app = open(&entry, &bridge);
    wait(&mut app, &format!("id:mission-{mission}"));
    app.press(&format!("id:mission-{mission}")).unwrap();
    wait(&mut app, &format!("id:check-result-{task_id}"));
    app.press(&format!("id:check-result-{task_id}")).unwrap();
    wait(&mut app, &button);
    let baseline = f.stats("stats");
    app.press(&button).unwrap();
    wait(
        &mut app,
        "Sent PR #1 to your browser. Nothing was recorded.",
    );
    assert_eq!(
        *opened.lock().unwrap(),
        vec![pr["pullRequest"]["url"].as_str().unwrap().to_owned()]
    );
    // Opening is never the user's check.
    wait_text(&mut app, "Not checked yet.");
    assert!(has(&app, "id:mark-done"));

    // The link moved after the page read it: nothing opens, and the page reads it again.
    f.stats("output-url:https://github.com/example/repo/pull/2");
    app.press(&button).unwrap();
    wait(
        &mut app,
        "This link changed since Pilot read the result. Nothing opened. Look at it again.",
    );
    wait_text(&mut app, "https://github.com/example/repo/pull/2");
    assert_eq!(opened.lock().unwrap().len(), 1);

    // A ticked reminder is saved with the window, exactly, and sends nothing.
    app.press("id:reminder-report").unwrap();
    wait(&mut app, "id:reminder-ticked-report");
    flush(&mut app, &bridge);
    close_window(app, bridge);
    // Read the saved window, then join that host so it lets go of the journal
    // before the next host opens it. A dropped host exits later on its own.
    let host = f.host();
    let saved = host.saved_window().unwrap();
    assert_eq!(host.close().recv_blocking().unwrap(), Ok(()));
    assert_eq!(
        saved.view["reminders"],
        json!([format!(
            "{key}#{}\nreport",
            page["deliveryId"].as_str().unwrap()
        )])
    );

    // A cold reopen hands nothing to the browser again.
    let bridge = Bridge::new(DayRoot::new(recording(&f, &opened)));
    let mut app = open(&entry, &bridge);
    wait(&mut app, "id:your-check");
    app.press("id:back").unwrap();
    wait(&mut app, &format!("id:check-result-{task_id}"));
    app.press("id:back").unwrap();
    wait(&mut app, &format!("id:mission-{mission}"));
    app.wait(Duration::from_millis(300)).unwrap();
    assert_eq!(
        opened.lock().unwrap().len(),
        1,
        "navigation is never replayed"
    );
    let stats = f.stats("stats");
    assert_eq!(stats["posts"], baseline["posts"]);
    assert_eq!(stats["lookups"], baseline["lookups"]);
    assert_eq!(stats["messages"], json!([]));
    assert_eq!(stats["external"], 0);
    close_window(app, bridge);
    let _ = std::fs::remove_dir_all(entry.parent().unwrap());
}

/// Uses the real connected entry and native artifact handler, not DeliveryDemo.
fn result(app: &mut Headless, subject: &Value) {
    let mission = subject["missionId"].as_str().unwrap();
    let task = subject["taskId"].as_str().unwrap();
    let row = format!("id:check-result-{task}");
    if !has(app, &row) {
        wait(app, &format!("id:mission-{mission}"));
        app.press(&format!("id:mission-{mission}")).unwrap();
    }
    wait(app, &row);
    app.press(&row).unwrap();
    wait(app, "id:your-check");
}

fn inspect_button(id: &Value) -> String {
    format!("id:output-source-{}", id.as_str().unwrap())
}

fn no_source(app: &Headless) {
    assert!(
        !has(app, "id:artifact-source-text"),
        "{:?}",
        app.screen().texts()
    );
}

#[test]
fn connected_inspect_cold_open_keeps_drafts_and_navigation_but_not_source() {
    let mut f = Fixture::with_daemon("day-delivered-artifact.ts");
    let entry = entry();
    let task = f.info["task"].clone();
    let button = inspect_button(&f.info["artifactId"]);
    let long = inspect_button(&f.info["longId"]);
    let source = f.info["longSource"].as_str().unwrap().to_owned();
    let bridge = f.bridge();
    let mut app = open(&entry, &bridge);
    wait(&mut app, "role:button[New]");
    app.press("role:button[New]").unwrap();
    wait(&mut app, "id:goal");
    app.type_text("id:goal", NOTE).unwrap();
    app.press("id:back").unwrap();
    result(&mut app, &task);
    no_source(&app);
    assert_eq!(f.stats("stats")["artifactReads"], json!([]));

    app.press(&button).unwrap();
    wait_text(&mut app, "<script>throw Error('never execute')</script>");
    wait_text(&mut app, "Source · HTML · revision 1");
    assert!(!has(&app, "historical prepared document must stay private"));
    assert!(!has(&app, "newer"), "never falls back to revision 2");
    let stats = f.stats("stats");
    let reads = stats["artifactReads"].as_array().unwrap();
    assert_eq!(reads.len(), 1, "one press, one native acquisition");
    assert_eq!(
        reads[0]["path"],
        format!(
            "/api/projects/{}/missions/{}/tasks/{}/delivered-work/artifact",
            task["projectId"].as_str().unwrap(),
            task["missionId"].as_str().unwrap(),
            task["taskId"].as_str().unwrap()
        )
    );
    let query = &reads[0]["query"];
    assert_eq!(query.as_object().unwrap().len(), 6, "no extra selector");
    assert_eq!(query["revision"], "1");
    assert_eq!(query["artifactId"], f.info["artifactId"]);
    // Native/daemon reject any mismatch in subject, target, delivery, owner or source.
    assert_eq!(query["ownerSessionId"], query["sourceSessionId"]);
    assert_eq!(query["targetId"].as_str().unwrap().len(), 64);
    assert_eq!(query["deliveryId"].as_str().unwrap().len(), 64);
    wait_text(&mut app, "Not checked yet.");
    assert!(has(&app, "id:mark-done"));

    app.press(&long).unwrap();
    wait(&mut app, "id:artifact-source-all");
    assert!(!app.screen().texts().contains(&source.as_str()));
    // Each output keeps its own view.
    assert!(has(&app, "<script>throw Error('never execute')</script>"));
    app.press("id:artifact-source-all").unwrap();
    wait_text(&mut app, &source);
    assert!(!has(&app, "id:artifact-source-all"));
    let stats = f.stats("stats");
    assert_eq!(
        stats["artifactReads"].as_array().unwrap().len(),
        2,
        "Show all is local"
    );
    assert_eq!(
        stats["longBytes"], f.info["longBytes"],
        "display never changes saved bytes"
    );
    assert_eq!(stats["posts"], 0);
    assert_eq!(stats["external"], 0);
    assert_eq!(stats["messages"], json!([]));

    app.press("id:send-back-open").unwrap();
    app.type_text("id:send-back-note", NOTE).unwrap();
    flush(&mut app, &bridge);
    close_window(app, bridge);
    let host = f.host();
    let saved = host.saved_window().unwrap();
    let key = format!(
        "task/{}/{}/{}",
        task["projectId"].as_str().unwrap(),
        task["missionId"].as_str().unwrap(),
        task["taskId"].as_str().unwrap()
    );
    assert_eq!(saved.view["delivery"], key);
    assert_eq!(saved.view["place"], "mission");
    assert_eq!(saved.view["id"], task["missionId"]);
    assert_eq!(saved.view["goal"], NOTE);
    assert_eq!(saved.view["notes"], json!([format!("{key}\n{NOTE}")]));
    assert!(
        !serde_json::to_string(&saved.view)
            .unwrap()
            .contains("never evaluate saved source")
    );
    // Read canonical verification on a fresh channel, never steal the window's flush ACK.
    let bridge = Bridge::new(DayRoot::new(host));
    let page = f.call(&bridge, "day.delivery.read", task.clone());
    let work = &page["value"]["snapshot"];
    assert_eq!(query["targetId"], work["targetId"]);
    assert_eq!(query["deliveryId"], work["deliveryId"]);
    assert_eq!(query["ownerSessionId"], work["ownerSessionId"]);
    let link = work["artifacts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["artifactId"] == f.info["artifactId"])
        .unwrap();
    assert_eq!(query["sourceSessionId"], link["sessionId"]);
    assert!(page["value"]["snapshot"]["verification"].is_null());
    assert_eq!(
        f.call(&bridge, "day.delivery.saved", json!({}))["value"]["operations"],
        json!([])
    );
    close(bridge);

    let bridge = f.bridge();
    let mut app = open(&entry, &bridge);
    wait(&mut app, "id:send-back-note");
    assert_eq!(app.screen().input_text("id:send-back-note"), Ok(Some(NOTE)));
    no_source(&app);
    assert!(!has(&app, "id:artifact-source"));
    flush(&mut app, &bridge);
    assert_eq!(
        f.stats("stats")["artifactReads"].as_array().unwrap().len(),
        2,
        "cold open never reads source"
    );
    // The mission's detail is not read until the overlay closes.
    app.press("id:back").unwrap();
    wait(
        &mut app,
        &format!("id:check-result-{}", task["taskId"].as_str().unwrap()),
    );
    app.press("id:back").unwrap();
    app.press("role:button[New]").unwrap();
    wait(&mut app, "id:goal");
    assert_eq!(app.screen().input_text("id:goal"), Ok(Some(NOTE)));
    assert_eq!(f.stats("stats")["posts"], 0);
    close_window(app, bridge);
    let _ = std::fs::remove_dir_all(entry.parent().unwrap());
}

#[test]
fn connected_preview_opens_the_exact_pin_on_its_own_and_revocation_refuses_the_next_preview() {
    let mut f = Fixture::with_daemon("day-delivered-artifact.ts");
    let fixture = f.stats("nsh");
    let id = fixture["nshId"].as_str().expect("saved NSH fixture");
    let entry = entry();
    let bridge = f.bridge();
    // Availability only: Headless records the native component's props. The
    // separate artifact_preview target exercises that actual AppKit factory.
    let mut params = bridge.channel().params();
    params.get_mut("day").unwrap()["artifactPreview"] = json!(true);
    bridge.channel().set_params(params);
    #[derive(Default)]
    struct Observed {
        node: Option<nsh_core::NodeId>,
        snapshots: Vec<Value>,
    }
    let observed = Arc::new(Mutex::new(Observed::default()));
    let observer = observed.clone();
    let mut app = open(&entry, &bridge);
    app.observe(move |_, batch| {
        let mut observed = observer.lock().unwrap();
        for item in &batch.items {
            match item {
                nsh_core::MountItem::Component { id, name }
                    if &**name == "pilot/artifact-preview" =>
                {
                    observed.node = Some(*id)
                }
                nsh_core::MountItem::ComponentProps { id, props } if Some(*id) == observed.node => {
                    for (name, value) in props {
                        if &**name == "snapshot"
                            && let Some(value) = value
                            // The result page's pins only; the mission's own
                            // Artifacts section previews through another read.
                            && !value["reference"]["deliveryId"].is_null()
                        {
                            observed.snapshots.push(value.clone());
                        }
                    }
                }
                _ => {}
            }
        }
    });
    result(&mut app, &f.info["task"]);
    let preview_button = format!("id:output-preview-{id}");
    wait(&mut app, &preview_button);
    assert!(
        !has(
            &app,
            &format!(
                "id:output-preview-{}",
                f.info["artifactId"].as_str().unwrap()
            )
        ),
        "HTML has no preview action"
    );
    // The first pinned NSH output opens on its own when the page opens.
    app.wait_until("exact saved bytes reach native preview", WAIT, |_| {
        !observed.lock().unwrap().snapshots.is_empty()
    })
    .unwrap();
    {
        let observed = observed.lock().unwrap();
        assert_eq!(observed.snapshots.len(), 1);
        let snapshot = &observed.snapshots[0];
        assert_eq!(snapshot["reference"]["artifactId"], id);
        assert_eq!(
            snapshot["reference"]["revision"], 1,
            "never follows latest revision2"
        );
        assert_eq!(snapshot["content"]["source"], fixture["nshSource"]);
        assert_eq!(snapshot["metadata"]["kind"], "nsh");
    }
    let stats = f.stats("stats");
    assert_eq!(stats["artifactReads"].as_array().unwrap().len(), 1);
    assert_eq!(stats["artifactReads"][0]["query"]["revision"], "1");
    assert_eq!(stats["posts"], 0);
    assert_eq!(stats["external"], 0);
    assert_eq!(stats["messages"], json!([]));

    app.press_key("escape").unwrap();
    app.wait_until("Escape dismisses preview", WAIT, |screen| {
        !screen.matches("id:artifact-preview").unwrap()
    })
    .unwrap();
    assert!(
        has(&app, "id:your-check"),
        "Escape closes preview, not result"
    );
    app.press(&preview_button).unwrap();
    app.wait_until("explicit reopen rereads the same pin", WAIT, |_| {
        observed.lock().unwrap().snapshots.len() == 2
    })
    .unwrap();
    app.press(&format!("id:output-source-{id}")).unwrap();
    wait_text(&mut app, fixture["nshSource"].as_str().unwrap());
    app.wait_until("source switch disposes preview", WAIT, |screen| {
        !screen.matches("id:artifact-preview").unwrap()
    })
    .unwrap();
    app.press(&preview_button).unwrap();
    app.wait_until("source switch recreates preview", WAIT, |_| {
        observed.lock().unwrap().snapshots.len() == 3
    })
    .unwrap();
    // An open preview is a copy already read, like shown source text. After
    // the owner leaves, the next press is refused before any bytes reach it.
    app.press(&preview_button).unwrap();
    gone(&mut app, "id:artifact-preview");
    f.stats("leave");
    app.press(&preview_button).unwrap();
    gone(&mut app, "Opening the saved preview…");
    flush(&mut app, &bridge);
    assert_eq!(observed.lock().unwrap().snapshots.len(), 3);
    let stats = f.stats("stats");
    // Three previews and one source read of the first delivery. Leaving makes
    // a newer delivery, whose first preview is read once and refused: no
    // bytes reach the preview after leaving.
    let reads = stats["artifactReads"].as_array().unwrap();
    assert_eq!(reads.len(), 5, "{stats}");
    assert_ne!(
        reads[4]["query"]["deliveryId"],
        reads[0]["query"]["deliveryId"]
    );
    assert_eq!(stats["posts"], 0);
    assert_eq!(stats["messages"], json!([]));
    close_window(app, bridge);
    let _ = std::fs::remove_dir_all(entry.parent().unwrap());
}

#[test]
fn connected_native_stale_source_refusal_drops_the_earlier_text_and_refreshes_the_result() {
    for action in ["stale", "leave"] {
        let mut f = Fixture::with_daemon("day-delivered-artifact.ts");
        let entry = entry();
        let bridge = f.bridge();
        let mut app = open(&entry, &bridge);
        result(&mut app, &f.info["task"]);
        app.press(&inspect_button(&f.info["longId"])).unwrap();
        wait(&mut app, "id:artifact-source-text");
        let before = f.stats(action)["deliveryReads"].as_u64().unwrap();
        app.press(&inspect_button(&f.info["artifactId"])).unwrap();
        // A stale reply refreshes the canonical result; that newer read can
        // drop the whole source panel, including the transient refusal.
        gone(&mut app, "Reading the saved source…");
        flush(&mut app, &bridge);
        no_source(&app);
        let stats = f.stats("stats");
        // Preflight refuses before source acquisition; ConnectedDelivery.inspect refreshes on stale.
        assert!(
            stats["deliveryReads"].as_u64().unwrap() >= before + 2,
            "{action}: {stats}"
        );
        assert_eq!(stats["artifactReads"].as_array().unwrap().len(), 1);
        assert_eq!(stats["posts"], 0);
        close_window(app, bridge);
        let _ = std::fs::remove_dir_all(entry.parent().unwrap());
    }
}

#[test]
fn connected_denied_and_late_channel_replies_never_restore_an_earlier_results_source() {
    let mut f = Fixture::with_daemon("day-delivered-artifact.ts");
    let entry = entry();
    let bridge = f.bridge();
    // Acquire the actual inert envelopes on the real native path first. Only
    // denial and response timing below are scripted at the released channel.
    let mut answers = Vec::new();
    for (subject, artifact) in [
        (f.info["task"].clone(), f.info["artifactId"].clone()),
        (f.info["task"].clone(), f.info["longId"].clone()),
        (f.info["second"].clone(), f.info["artifactId"].clone()),
    ] {
        let page = f.call(&bridge, "day.delivery.read", subject)["value"]["snapshot"].clone();
        let link = page["artifacts"]
            .as_array()
            .unwrap()
            .iter()
            .find(|a| a["artifactId"] == artifact)
            .unwrap();
        let args = json!({"subject":page["subject"],"targetId":page["targetId"],"deliveryId":page["deliveryId"],
            "ownerSessionId":page["ownerSessionId"],"sourceSessionId":link["sessionId"],"artifactId":link["artifactId"],"revision":link["revision"]});
        let reply = f.call(&bridge, "day.delivery.artifact", args.clone());
        assert!(reply["value"]["snapshot"].is_object(), "{reply}");
        answers.push((args, reply));
    }
    let calls: Arc<Mutex<Vec<Value>>> = Arc::default();
    let held: Arc<Mutex<Option<(HostCall, Value)>>> = Arc::default();
    let mode = Arc::new(Mutex::new("answer"));
    {
        let (calls, held, mode) = (calls.clone(), held.clone(), mode.clone());
        bridge
            .channel()
            .handle("day.delivery.artifact", move |call: HostCall| {
                let args = call.data()["args"].clone();
                calls.lock().unwrap().push(args.clone());
                let reply = answers
                    .iter()
                    .find(|(pin, _)| *pin == args)
                    .expect("exact displayed pin")
                    .1
                    .clone();
                match *mode.lock().unwrap() {
                    "denied" => call.reject("synthetic denied"),
                    "hold" => {
                        assert!(held.lock().unwrap().replace((call, reply)).is_none());
                    }
                    _ => call.resolve(reply),
                }
            });
    }
    let mut app = open(&entry, &bridge);
    result(&mut app, &f.info["task"]);
    app.press(&inspect_button(&f.info["longId"])).unwrap();
    wait(&mut app, "id:artifact-source-text");
    // Each output keeps its own view: hide this one so only the next shows.
    app.press(&inspect_button(&f.info["longId"])).unwrap();
    gone(&mut app, "id:artifact-source-text");
    *mode.lock().unwrap() = "denied";
    app.press(&inspect_button(&f.info["artifactId"])).unwrap();
    wait_text(&mut app, "Pilot cannot show saved sources in this window.");
    no_source(&app);

    // Pressing the refused pin hides its panel without another read.
    app.press(&inspect_button(&f.info["artifactId"])).unwrap();
    gone(&mut app, "Pilot cannot show saved sources in this window.");
    *mode.lock().unwrap() = "hold";
    app.press(&inspect_button(&f.info["artifactId"])).unwrap();
    wait_text(&mut app, "Reading the saved source…");
    no_source(&app);
    assert!(
        !app.screen()
            .enabled(&inspect_button(&f.info["artifactId"]))
            .unwrap()
    );
    app.press("role:button[Back to Synthetic captured output]")
        .unwrap();
    result(&mut app, &f.info["second"]);
    no_source(&app);
    *mode.lock().unwrap() = "answer";
    app.press(&inspect_button(&f.info["artifactId"])).unwrap();
    wait_text(&mut app, "newer");
    wait_text(&mut app, "Source · HTML · revision 2");
    let (call, reply) = held
        .lock()
        .unwrap()
        .take()
        .expect("first result still in flight");
    call.resolve(reply);
    flush(&mut app, &bridge);
    wait_text(&mut app, "newer");
    assert!(!has(&app, "<script>throw Error('never execute')</script>"));
    assert_eq!(
        calls.lock().unwrap().len(),
        4,
        "each explicit Inspect calls once"
    );
    wait_text(&mut app, "Not checked yet.");
    let stats = f.stats("stats");
    assert_eq!(stats["posts"], 0);
    assert_eq!(stats["external"], 0);
    assert_eq!(stats["messages"], json!([]));
    close_window(app, bridge);
    let bridge = f.bridge();
    for subject in [&f.info["task"], &f.info["second"]] {
        let page = f.call(&bridge, "day.delivery.read", subject.clone());
        assert!(page["value"]["snapshot"]["verification"].is_null());
    }
    assert_eq!(
        f.call(&bridge, "day.delivery.saved", json!({}))["value"]["operations"],
        json!([])
    );
    close(bridge);
    let _ = std::fs::remove_dir_all(entry.parent().unwrap());
}
