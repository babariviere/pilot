//! Released JSON bridge and real daemon/storage. No live Slack account or model.
#[path = "support/day_library.rs"]
mod day_library;
include!("support/intake_fixture.rs");

#[test]
fn paged_report_beyond_first_intake_page_starts_only_after_explicit_native_start() {
    let mut f = Fixture::with_daemon("day-slack-controls.ts");
    f.stats("many");
    let b = f.bridge();
    let page = f.call(&b, "day.slack.read", json!({"offset":100}));
    let item = &page["value"]["snapshot"]["reports"]["items"][0];
    assert_eq!(page["value"]["snapshot"]["reports"]["offset"], 100);
    let intake = f.read(&b);
    assert!(
        !intake["sources"][0]["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|i| i["id"] == item["id"])
    );
    f.stats("defer-old");
    assert_eq!(f.call(&b,"day.intake.start",json!({"itemId":item["id"],"revision":item["revision"],"contextDigest":intake["contextDigest"]}))["error"],"stale");
    let deferred = f.call(&b, "day.slack.read", json!({"offset":100}));
    let item = &deferred["value"]["snapshot"]["reports"]["items"][0];
    assert_eq!(item["triageState"], "later");
    let restored = f.call(&b,"day.intake.triage",json!({"itemId":item["id"],"revision":item["revision"],"contextDigest":intake["contextDigest"],"state":"new"}));
    assert_eq!(
        restored["value"]["outcome"]["state"], "accepted",
        "{restored}"
    );
    let fresh = f.call(&b, "day.slack.read", json!({"offset":100}));
    let item = &fresh["value"]["snapshot"]["reports"]["items"][0];
    let started = f.call(&b,"day.intake.start",json!({"itemId":item["id"],"revision":item["revision"],"contextDigest":intake["contextDigest"]}));
    assert_eq!(
        started["value"]["outcome"]["state"], "accepted",
        "{started}"
    );
    let page = f.call(&b, "day.slack.read", json!({"offset":100}));
    let saved = page["value"]["snapshot"]["reports"]["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["id"] == item["id"])
        .unwrap();
    assert_eq!(saved["slack"]["status"], "in_progress");
    assert!(saved["sessionId"].is_string());
    close(b);
}

#[test]
fn real_report_screen_saves_corrections_through_the_released_bridge_and_storage() {
    let f = Fixture::with_daemon("day-slack-controls.ts");
    let b = f.bridge();
    let first = f.call(&b, "day.slack.read", json!({}));
    let added = f.call(&b,"day.slack.write",json!({"binding":first["value"]["snapshot"]["binding"],"action":"import","value":{"url":"https://example.slack.com/archives/COTHER/p1794843000000001"}}));
    let id = added["value"]["snapshot"]["reports"]["items"][0]["id"]
        .as_str()
        .unwrap();
    let day = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    // The released bundler requires imported SVGs to live inside the app root.
    for entry in std::fs::read_dir(&day).unwrap() {
        let p = entry.unwrap().path();
        let name = p.file_name().unwrap().to_str().unwrap();
        if p.is_file()
            && (name.ends_with(".ts") || name.ends_with(".tsx"))
            && !name.ends_with(".test.tsx")
        {
            std::fs::copy(&p, f.dir.join(name)).unwrap();
        }
    }
    day_library::copy(&day, &f.dir);
    let source = format!(
        r#"import {{mount,host}} from 'nsh';
import {{SlackReportsScreen}} from {};
import {{connectedSlackControls}} from {};
import {{selectedSlackReport}} from {};
selectedSlackReport.set({});
mount(()=> <SlackReportsScreen day={{{{slack:connectedSlackControls(host.params.day.window,()=>{{}})}}}}/>);"#,
        json!("./SlackReportsScreen.tsx"),
        json!("./slackControls.ts"),
        json!("./slackView.ts"),
        json!(id)
    );
    let path = f.dir.join("Reports.tsx");
    std::fs::write(&path, source).unwrap();
    let sets = vec![nsh_base::registry()];
    let bundle = restrict(compile_tsx(&path, &sets).unwrap()).unwrap();
    let config = EngineConfig {
        ui_sets: sets,
        host: b.channel(),
        viewport: nsh_core::Size::new(nsh_core::Points(1100.0), nsh_core::Points(1600.0)),
        ..EngineConfig::new(bundle)
    };
    let mut app = Headless::start(config).unwrap();
    app.wait_for("Correct details…").unwrap();
    app.press("Correct details…").unwrap();
    app.type_text("id:slack-edit-client", "Northwind").unwrap();
    app.type_text(
        "id:slack-evidence-client",
        "Customer organization confirmed by the user",
    )
    .unwrap();
    app.press("id:slack-corrections-save").unwrap();
    app.wait_for("Report changes saved.").unwrap();
    app.wait_for("Northwind").unwrap();
    drop(app);
    close(b);
    let b = f.bridge();
    let saved = f.call(&b, "day.slack.read", json!({}));
    assert_eq!(
        saved["value"]["snapshot"]["reports"]["items"][0]["slack"]["overrides"]["details"]["client"]
            ["value"],
        "Northwind"
    );
    close(b);
}

#[test]
fn source_open_pins_report_identity_and_refuses_stale_display() {
    use std::sync::{Arc, Mutex};
    let mut f = Fixture::with_daemon("day-slack-controls.ts");
    let opened = Arc::new(Mutex::new(Vec::<String>::new()));
    let capture = opened.clone();
    let source: Source = serde_json::from_value(f.info["source"].clone()).unwrap();
    let b = Bridge::new(DayRoot::new(f.host_for_options(
        source,
        pilot_day_native::host::Options {
            url_opener: Some(Arc::new(move |url| {
                capture.lock().unwrap().push(url.into());
                Ok(())
            })),
            ..Default::default()
        },
    )));
    let first = f.call(&b, "day.slack.read", json!({}));
    let added = f.call(&b, "day.slack.write", json!({"binding":first["value"]["snapshot"]["binding"],"action":"import","value":{"url":"https://example.slack.com/archives/COTHER/p1794843000000001"}}));
    let s = &added["value"]["snapshot"];
    let intent = json!({"binding":s["binding"],"action":"open","value":{"digest":s["reports"]["digest"],"itemId":s["reports"]["items"][0]["id"]}});
    let result = f.call(&b, "day.slack.write", intent.clone());
    assert_eq!(result["value"]["outcome"]["state"], "opened", "{result}");
    assert_eq!(
        opened.lock().unwrap().as_slice(),
        ["https://example.slack.com/archives/COTHER/p1794843000000001"]
    );
    f.stats("change");
    assert_eq!(f.call(&b, "day.slack.write", intent)["error"], "stale");
    assert_eq!(opened.lock().unwrap().len(), 1);
    close(b);
}

#[test]
fn report_tackled_is_explicit_fenced_and_kept_across_reopen() {
    let mut f = Fixture::with_daemon("day-slack-controls.ts");
    let b = f.bridge();
    let first = f.call(&b, "day.slack.read", json!({}));
    let added = f.call(&b, "day.slack.write", json!({"binding":first["value"]["snapshot"]["binding"],"action":"import","value":{"url":"https://example.slack.com/archives/COTHER/p1794843000000001"}}));
    let s = &added["value"]["snapshot"];
    let item = s["reports"]["items"][0]["id"].clone();
    let old = json!({"binding":s["binding"],"action":"report","value":{"digest":s["reports"]["digest"],"itemId":item,"patch":{"status":"done"}}});
    let saved = f.call(&b, "day.slack.write", old.clone());
    assert_eq!(saved["value"]["outcome"]["state"], "accepted", "{saved}");
    assert_eq!(
        saved["value"]["snapshot"]["reports"]["items"][0]["slack"]["status"],
        "done"
    );
    let stale = f.call(&b, "day.slack.write", old);
    assert_eq!(stale["value"]["outcome"]["state"], "rejected", "{stale}");
    close(b);
    let b = f.bridge();
    let read = f.call(&b, "day.slack.read", json!({}));
    assert_eq!(
        read["value"]["snapshot"]["reports"]["items"][0]["slack"]["status"],
        "done"
    );
    assert_eq!(f.stats("stats")["imports"], 1);
    assert_eq!(f.stats("stats")["external"], 0);
    close(b);
}

#[test]
fn a_send_lost_before_daemon_admission_can_be_set_aside_without_sending_again() {
    let mut f = Fixture::with_daemon("day-slack-controls.ts");
    let b = f.bridge();
    let read = f.call(&b, "day.slack.read", json!({}));
    f.stats("drop");
    let lost = f.call(&b, "day.slack.write", json!({"binding":read["value"]["snapshot"]["binding"],"action":"import","value":{"url":"https://example.slack.com/archives/COTHER/p1794843000000001"}}));
    assert_eq!(lost["value"]["outcome"]["state"], "unknown", "{lost}");
    let id = lost["value"]["outcome"]["operationId"].clone();
    let aside = f.call(&b, "day.slack.setAside", json!({"operationId":id}));
    assert_eq!(aside["value"]["outcome"]["state"], "set-aside", "{aside}");
    assert!(aside["value"]["operations"].as_array().unwrap().is_empty());
    let saved = f.call(&b, "day.slack.write", json!({"binding":aside["value"]["snapshot"]["binding"],"action":"save","value":{"channels":[],"mentionOnly":[],"groups":[]}}));
    assert_eq!(saved["value"]["outcome"]["state"], "accepted", "{saved}");
    close(b);
    let b = f.bridge();
    assert!(
        f.call(&b, "day.slack.read", json!({}))["value"]["operations"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let stats = f.stats("stats");
    assert_eq!(stats["imports"], 0);
    assert_eq!(stats["external"], 0);
    close(b);
}

#[test]
fn slack_tracking_and_independent_import_are_fenced_and_unknown_never_replays() {
    let mut f = Fixture::with_daemon("day-slack-controls.ts");
    let b = f.bridge();
    let first = f.call(&b, "day.slack.read", json!({}));
    let s = &first["value"]["snapshot"];
    assert_eq!(s["source"]["configured"], false, "{first}");
    assert_eq!(f.stats("stats")["imports"], 0);
    let save = json!({"binding":s["binding"],"action":"save","value":{"channels":["C123"],"mentionOnly":["C123"],"groups":["support"]}});
    let ack = f.call(&b, "day.slack.write", save.clone());
    assert_eq!(ack["value"]["outcome"]["state"], "accepted", "{ack}");
    assert_eq!(f.call(&b, "day.slack.write", save)["error"], "stale");
    let fresh = f.call(&b, "day.slack.read", json!({}));
    let off = f.call(&b, "day.slack.write", json!({"binding":fresh["value"]["snapshot"]["binding"],"action":"save","value":{"channels":[],"mentionOnly":[],"groups":[]}}));
    assert_eq!(off["value"]["outcome"]["state"], "accepted", "{off}");
    let binding = off["value"]["snapshot"]["binding"].clone();
    let bad = f.call(&b, "day.slack.write", json!({"binding":binding,"action":"import","value":{"url":"https://example.slack.com/archives/COTHER/p1794843000000001?token=secret"}}));
    assert_eq!(bad["error"], "invalid");
    assert!(
        !std::fs::read_to_string(f.info["ledger"].as_str().unwrap())
            .unwrap()
            .contains("secret")
    );
    f.stats("lost");
    let unknown = f.call(&b, "day.slack.write", json!({"binding":binding,"action":"import","value":{"url":"https://example.slack.com/archives/COTHER/p1794843000000001"}}));
    assert_eq!(unknown["value"]["outcome"]["state"], "pending", "{unknown}");
    let id = unknown["value"]["outcome"]["operationId"].clone();
    assert_eq!(f.stats("stats")["intake"][0]["total"], 1);
    close(b);
    let b = f.bridge();
    let read = f.call(&b, "day.slack.read", json!({}));
    assert_eq!(
        read["value"]["operations"].as_array().unwrap().len(),
        1,
        "{read}"
    );
    let lookup = f.call(&b, "day.slack.check", json!({"operationId":id}));
    assert_eq!(lookup["value"]["outcome"]["state"], "pending", "{lookup}");
    let aside = f.call(&b, "day.slack.setAside", json!({"operationId":id}));
    assert_eq!(aside["value"]["outcome"]["state"], "set-aside", "{aside}");
    assert!(aside["value"]["operations"].as_array().unwrap().is_empty());
    let unlocked = f.call(&b, "day.slack.write", json!({"binding":aside["value"]["snapshot"]["binding"],"action":"save","value":{"channels":[],"mentionOnly":[],"groups":[]}}));
    assert_eq!(
        unlocked["value"]["outcome"]["state"], "accepted",
        "{unlocked}"
    );
    let stats = f.stats("stats");
    assert_eq!(stats["imports"], 1);
    assert_eq!(stats["external"], 0);
    assert_eq!(stats["tracking"]["linearTeam"], "FAKE");
    assert_eq!(stats["tracking"]["slackChannels"], json!([]));
    close(b);
    let b = f.bridge();
    assert!(
        f.call(&b, "day.slack.read", json!({}))["value"]["operations"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        f.stats("stats")["imports"],
        1,
        "setting aside never retries an import, including on reopen"
    );
    close(b);
}
