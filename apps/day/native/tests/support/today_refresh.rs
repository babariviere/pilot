//! Real connection.ts → public bridge → serialized NativeHost → HTTP/WS.
//! All services use the isolated fixture. No live daemon, model or window.
use super::*;
use nsh_core::NodeId;
use pilot_day_native::model::FreshnessState;

#[test]
fn unknown_empty_attention_is_not_a_fresh_headline_or_an_all_clear_footer() {
    let entry = entry();
    let root = FakeRoot::new();
    let mut today = serde_json::to_value(Desk::new(Scenario::Quiet).today()).unwrap();
    today["attention"]["state"] = json!("stale");
    today["attention"]["reason"] = json!("Reading changes. Showing the earlier attention read.");
    root.reply("day.today.read", today);
    root.reply("day.plan.inventory", inventory(vec![]));
    let mut app = open_on(&entry, root.channel.clone());
    wait(&mut app, "Your last read.");
    assert!(
        !app.screen()
            .texts()
            .iter()
            .any(|text| text.starts_with("Nothing needs you"))
    );
    assert!(!contains(&app, "Pilot keeps going on its own"));
    assert!(!contains(&app, "That is everything for now"));
    drop(app);
    std::fs::remove_dir_all(entry.parent().unwrap()).unwrap();
}

fn pump(app: &mut Headless, done: impl Fn() -> bool) {
    let end = std::time::Instant::now() + WAIT;
    while !done() {
        assert!(
            std::time::Instant::now() < end,
            "{:?}",
            app.screen().texts()
        );
        app.wait(Duration::from_millis(25)).unwrap();
    }
    app.wait(Duration::from_millis(100)).unwrap();
}

fn status_nodes(app: &Headless) -> Vec<(String, NodeId, Bounds<Points>)> {
    let mut nodes: Vec<_> = app
        .screen()
        .layout_nodes()
        .into_iter()
        .filter_map(|node| {
            let id = node.test_id.as_deref()?;
            ["freshness", "attention-note", "planning"]
                .contains(&id)
                .then(|| (id.to_owned(), node.id, node.bounds))
        })
        .collect();
    nodes.sort_by(|a, b| a.0.cmp(&b.0));
    nodes
}

fn contains(app: &Headless, text: &str) -> bool {
    app.screen()
        .texts()
        .iter()
        .any(|shown| shown.contains(text))
}

fn capture(app: &mut Headless, host: &NativeHost, bridge: &Bridge) -> Value {
    let generation = bridge.request_flush().unwrap();
    bridge.native_capture_finished(generation).unwrap();
    pump(app, || bridge.flush_ready(generation));
    let view = host.saved_window().unwrap().view;
    bridge.cancel_flush(generation).unwrap();
    view
}

#[test]
fn automatic_refresh_races_and_outage_recovery_keep_today_stable_and_send_nothing() {
    let mut f = Fixture::new();
    let (host, bridge) = f.bridge();
    let entry = entry();
    let mut app = open(&entry, &bridge);
    wait(&mut app, "role:button[New]");
    pump(&mut app, || {
        host.planning_inventory_snapshot().availability == PlanAvailability::Live
    });
    let initial = status_nodes(&app);
    assert_eq!(initial.len(), 3, "status regions must have stable owners");
    for _ in 0..5 {
        f.cmd("hold-day", true);
        f.cmd("notice", true);
        f.cmd("day-entered", true);
        // Let connection.ts enqueue its cached reads, then age the entered
        // HTTP response. This reproduces the ordinary multi-notice race.
        app.wait(Duration::from_millis(50)).unwrap();
        f.cmd("notice", true);
        f.cmd("release-day", true);
        let end = std::time::Instant::now() + Duration::from_millis(250);
        while std::time::Instant::now() < end {
            app.wait(Duration::from_millis(10)).unwrap();
            assert!(
                !contains(&app, "Daemon read is unavailable"),
                "notice is not transport failure"
            );
            assert!(!has(&app, "id:planning-off"));
            assert_eq!(
                status_nodes(&app),
                initial,
                "automatic refresh changed layout or identity"
            );
            if contains(&app, "What needs you is not current") {
                assert!(!app.shows("Nothing needs you. Pilot keeps going on its own."));
            }
        }
    }
    f.cmd("read-outage", true);
    f.cmd("notice", true);
    pump(&mut app, || {
        host.snapshot().freshness.state == FreshnessState::Unavailable
    });
    assert!(contains(&app, "Daemon read is unavailable"));
    assert!(!app.shows("Nothing needs you. Pilot keeps going on its own."));
    for _ in 0..3 {
        f.cmd("notice", true);
        app.wait(Duration::from_millis(100)).unwrap();
        assert!(contains(&app, "Daemon read is unavailable"));
    }
    f.cmd("read-outage", false);
    f.cmd("notice", true);
    pump(&mut app, || {
        host.planning_inventory_snapshot().availability == PlanAvailability::Live
            && host.snapshot().freshness.state == FreshnessState::Live
    });
    assert!(!contains(&app, "Daemon read is unavailable"));
    assert_eq!(status_nodes(&app), initial);
    // A background failure must not rebuild New or lose the exact unsent goal.
    app.press("role:button[New]").unwrap();
    wait(&mut app, "id:goal");
    app.type_text("id:goal", "Keep 👩🏽‍💻  this\nunsent draft")
        .unwrap();
    app.set_viewport(Size::new(Points(1100.0), Points(500.0)))
        .unwrap();
    let scroll = app
        .screen()
        .layout_nodes()
        .into_iter()
        .find(|n| n.scroll.is_some())
        .unwrap();
    app.scroll(&format!("view:{}", scroll.id), Points(80.0))
        .unwrap();
    app.wait(Duration::from_millis(150)).unwrap();
    let before = capture(&mut app, &host, &bridge);
    assert_eq!(before["input"], "goal");
    assert!(
        before["y"].as_f64().unwrap() > 0.0,
        "test must preserve a nonzero scroll offset"
    );
    f.cmd("read-outage", true);
    f.cmd("notice", true);
    app.wait(Duration::from_millis(150)).unwrap();
    f.cmd("read-outage", false);
    f.cmd("notice", true);
    pump(&mut app, || {
        host.snapshot().freshness.state == FreshnessState::Live
    });
    assert_eq!(
        app.screen().input_text("id:goal"),
        Ok(Some("Keep 👩🏽‍💻  this\nunsent draft"))
    );
    let after = capture(&mut app, &host, &bridge);
    for field in ["goal", "input", "start", "end", "y", "todayY"] {
        assert_eq!(after[field], before[field], "refresh changed saved {field}");
    }
    let stats = f.cmd("stats", true);
    assert_eq!(stats["effects"], 0);
    assert_eq!(stats["posts"], 0);
    assert_eq!(stats["requests"], 0);
    assert_eq!(stats["workers"], 0);
    close(app, bridge);
    std::fs::remove_dir_all(entry.parent().unwrap()).unwrap();
}
