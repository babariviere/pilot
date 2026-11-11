//! Startup recovery on the released QuickJS/HostChannel boundary. Scripted
//! native replies, no live profile, provider, daemon or visible window.
use super::*;
use nsh_engine::HostReply;
use std::time::Instant;

fn recovery_entry() -> PathBuf {
    let path = entry();
    let mut source = std::fs::read_to_string(&path).unwrap();
    // Test-only events exercise repeated calls even after the visible button
    // has disappeared. They grant no host calls or alternate service selection.
    source.push_str(
        r#"
import { host as probeHost } from "nsh";
import { readAgain as probeRead } from "./connection";
probeHost.on("test.read", () => { void probeRead(); });
probeHost.on("test.identity", () => { probeHost.params.day.window = "changed-window"; });
"#,
    );
    std::fs::write(&path, source).unwrap();
    path
}

/// Unlike wait_until, keep pumping even if only native call counts change.
fn until(app: &mut Headless, description: &str, done: impl Fn() -> bool) {
    let end = Instant::now() + WAIT;
    while !done() {
        assert!(
            Instant::now() < end,
            "{description}: {:?}",
            app.screen().texts()
        );
        app.wait(Duration::from_millis(25)).unwrap();
    }
}

fn hold_next(root: &FakeRoot) -> Arc<Mutex<Option<HostReply>>> {
    let held = Arc::new(Mutex::new(None));
    let (slot, calls, replies) = (held.clone(), root.calls.clone(), root.replies.clone());
    let first = std::sync::atomic::AtomicBool::new(true);
    root.channel.handle("day.today.read", move |call| {
        calls
            .lock()
            .unwrap()
            .push(("day.today.read".into(), call.data().clone()));
        if first.swap(false, std::sync::atomic::Ordering::SeqCst) {
            *slot.lock().unwrap() = call.into_reply();
        } else {
            call.resolve(replies.lock().unwrap()["day.today.read"].clone());
        }
    });
    held
}

fn retry(root: &FakeRoot) {
    root.channel.send("test.read", json!({})).unwrap();
}

fn no_effects(root: &FakeRoot) {
    for method in [
        "day.plan.create",
        "day.plan.submit",
        "day.plan.startWork",
        "day.update.prepare",
        "day.update.confirm",
        "day.update.restored",
        "day.attention.reply",
        "day.attention.action",
        "day.ritual.visit",
        "day.ritual.save",
    ] {
        assert_eq!(root.count(method), 0, "recovery entered {method}");
    }
    assert!(
        root.calls
            .lock()
            .unwrap()
            .iter()
            .all(|(_, e)| e["window"] == FAKE_WINDOW)
    );
}

#[test]
fn failed_first_read_recovers_explicitly_once_without_repeating_startup() {
    let entry = recovery_entry();
    let root = FakeRoot::new();
    root.refuse("day.today.read", "offline");
    let mut app = open_on(&entry, root.channel.clone());
    wait(&mut app, "id:connection-read");
    assert!(app.shows("Pilot could not reach its service. Nothing is shown rather than a guess."));
    root.changed();
    app.wait(Duration::from_millis(100)).unwrap();
    assert_eq!(
        root.count("day.today.read"),
        1,
        "no automatic startup retry"
    );
    assert_eq!(root.count("day.plan.prepare"), 0);
    assert_eq!(root.count("day.update.read"), 0);

    root.reply(
        "day.today.read",
        serde_json::to_value(Desk::new(Scenario::Quiet).today()).unwrap(),
    );
    root.reply("day.plan.inventory", inventory(vec![]));
    let held = hold_next(&root);
    app.press("id:connection-read").unwrap();
    until(&mut app, "retry entered", || held.lock().unwrap().is_some());
    wait(&mut app, "Opening Pilot…");
    assert!(!has(&app, "id:connection-read"));
    retry(&root);
    retry(&root);
    root.changed();
    app.wait(Duration::from_millis(100)).unwrap();
    assert_eq!(
        root.count("day.today.read"),
        2,
        "no overlap or queued retries"
    );
    held.lock()
        .unwrap()
        .take()
        .unwrap()
        .resolve(root.replies.lock().unwrap()["day.today.read"].clone());
    wait(&mut app, "role:button[New]");
    until(&mut app, "opening catch-up read", || {
        root.count("day.today.read") == 3
    });
    retry(&root);
    app.wait(Duration::from_millis(100)).unwrap();
    for name in [
        "day.attention.read",
        "day.ritual.read",
        "day.plan.prepare",
        "day.plan.inventory",
        "day.update.read",
    ] {
        assert_eq!(root.count(name), 1, "{name} was repeated");
    }
    let before = root.count("day.today.read");
    root.changed();
    until(&mut app, "one invalidation listener", || {
        root.count("day.today.read") > before
    });
    app.wait(Duration::from_millis(100)).unwrap();
    assert_eq!(root.count("day.today.read"), before + 1);
    root.flush(12);
    until(&mut app, "one flush listener", || {
        root.count("day.flush.ack") == 1
    });
    root.flush(12);
    root.flush(11);
    app.wait(Duration::from_millis(100)).unwrap();
    assert_eq!(root.count("day.flush.ack"), 1);
    no_effects(&root);
    drop(app);
    std::fs::remove_dir_all(entry.parent().unwrap()).unwrap();
}

#[test]
fn close_during_opening_waits_through_a_failed_read_and_explicit_recovery() {
    let entry = recovery_entry();
    let root = FakeRoot::new();
    let held = hold_next(&root);
    let mut app = open_on(&entry, root.channel.clone());
    until(&mut app, "first read", || held.lock().unwrap().is_some());
    root.flush(4);
    root.flush(5);
    app.wait(Duration::from_millis(100)).unwrap();
    assert_eq!(
        root.count("day.flush.ack"),
        0,
        "opening is not a saved view"
    );
    held.lock()
        .unwrap()
        .take()
        .unwrap()
        .resolve(json!({"version":1,"error":"offline"}));
    wait(&mut app, "id:connection-read");
    assert_eq!(
        root.count("day.flush.ack"),
        0,
        "failure is not an empty saved view"
    );
    root.reply("day.plan.inventory", inventory(vec![]));
    app.press("id:connection-read").unwrap();
    wait(&mut app, "role:button[New]");
    until(&mut app, "pending close answered", || {
        root.count("day.flush.ack") == 1
    });
    let ack = &root.args("day.flush.ack")[0];
    assert_eq!(
        ack["generation"], 5,
        "only the newest generation is answered"
    );
    assert_eq!(ack["view"]["place"], "today");
    no_effects(&root);
    drop(app);
    std::fs::remove_dir_all(entry.parent().unwrap()).unwrap();
}

#[test]
fn a_channel_rejection_settles_without_restarting_or_acknowledging_close() {
    let entry = recovery_entry();
    let root = FakeRoot::new();
    let held = hold_next(&root);
    let mut app = open_on(&entry, root.channel.clone());
    until(&mut app, "first read", || held.lock().unwrap().is_some());
    root.flush(6);
    // NSH 0.4 reports a rejected/missing native handler with the same host
    // error code. The existing transport conservatively refuses it; recovery
    // must not reinterpret it as permission or leave an unhandled rejection.
    held.lock()
        .unwrap()
        .take()
        .unwrap()
        .reject("synthetic rejection");
    wait(
        &mut app,
        "This window may not read Pilot's service. Nothing is shown rather than examples.",
    );
    retry(&root);
    app.wait(Duration::from_millis(100)).unwrap();
    assert!(!has(&app, "id:connection-read"));
    assert_eq!(root.count("day.today.read"), 1);
    assert_eq!(root.count("day.flush.ack"), 0);
    no_effects(&root);
    drop(app);
    std::fs::remove_dir_all(entry.parent().unwrap()).unwrap();
}

#[test]
fn a_close_queued_while_opening_does_not_capture_before_the_saved_view_is_restored() {
    use pilot_day_native::update::{PlaceKind, Restore, SavedView, ServiceView};
    let entry = recovery_entry();
    let root = FakeRoot::new();
    let view = SavedView {
        place: PlaceKind::New,
        goal: "Exact 👩🏽‍💻  goal\nkept".into(),
        input: "goal".into(),
        start: 2,
        end: 5,
        ..SavedView::default()
    };
    let service = ServiceView {
        restore: Some(Restore {
            id: "saved-window".into(),
            view: view.clone(),
        }),
        ..ServiceView::default()
    };
    root.reply("day.update.read", serde_json::to_value(service).unwrap());
    let held = hold_next(&root);
    let mut app = open_on(&entry, root.channel.clone());
    until(&mut app, "first read", || held.lock().unwrap().is_some());
    root.flush(10);
    app.wait(Duration::from_millis(100)).unwrap();
    assert_eq!(root.count("day.flush.ack"), 0);
    held.lock()
        .unwrap()
        .take()
        .unwrap()
        .resolve(root.replies.lock().unwrap()["day.today.read"].clone());
    until(&mut app, "saved restored view", || {
        root.count("day.flush.ack") == 1
    });
    let ack = &root.args("day.flush.ack")[0]["view"];
    assert_eq!(ack["place"], "new");
    assert_eq!(ack["goal"], view.goal);
    assert_eq!(ack["input"], "goal");
    assert_eq!(
        (ack["start"].as_u64(), ack["end"].as_u64()),
        (Some(2), Some(5))
    );
    assert_eq!(
        root.count("day.update.restored"),
        1,
        "display ACK once, never enrollment/restart"
    );
    assert_eq!(root.count("day.plan.create"), 0);
    assert_eq!(root.count("day.update.confirm"), 0);
    drop(app);
    std::fs::remove_dir_all(entry.parent().unwrap()).unwrap();
}

#[test]
fn missing_root_denial_and_identity_do_not_offer_retry_or_choose_another_root() {
    let entry = recovery_entry();
    let mut app = open_on(&entry, HostChannel::new());
    wait(
        &mut app,
        "This window was not opened for a Pilot service, so it shows nothing rather than examples.",
    );
    assert!(!has(&app, "id:connection-read"));
    assert!(!app.shows("Mock data"));
    drop(app);
    for refusal in ["identity", "closed", "busy"] {
        let root = FakeRoot::new();
        root.refuse("day.today.read", refusal);
        let mut app = open_on(&entry, root.channel.clone());
        until(&mut app, "refusal answered", || {
            root.count("day.today.read") == 1
        });
        app.wait(Duration::from_millis(100)).unwrap();
        assert!(has(&app, "id:not-connected"));
        assert!(!has(&app, "id:connection-read"));
        retry(&root);
        app.wait(Duration::from_millis(100)).unwrap();
        assert_eq!(root.count("day.today.read"), 1);
        assert_eq!(root.count("day.plan.prepare"), 0);
        no_effects(&root);
        drop(app);
    }
    // Actual released capability refusal, before the native handler is entered.
    let root = FakeRoot::new();
    let methods = METHODS
        .iter()
        .filter(|m| **m != "day.today.read")
        .collect::<Vec<_>>();
    std::fs::write(entry.parent().unwrap().join("nsh.json"), json!({"name":"Pilot","id":"dev.pilot.day","theme":"theme.json","capabilities":{"host":methods}}).to_string()).unwrap();
    let mut app = open_on(&entry, root.channel.clone());
    wait(
        &mut app,
        "This window may not read Pilot's service. Nothing is shown rather than examples.",
    );
    assert!(!has(&app, "id:connection-read"));
    retry(&root);
    app.wait(Duration::from_millis(100)).unwrap();
    assert_eq!(root.count("day.today.read"), 0);
    no_effects(&root);
    drop(app);
    std::fs::remove_dir_all(entry.parent().unwrap()).unwrap();
}

#[test]
fn an_old_completion_cannot_open_a_changed_window() {
    let entry = recovery_entry();
    let root = FakeRoot::new();
    let held = hold_next(&root);
    let mut app = open_on(&entry, root.channel.clone());
    until(&mut app, "first read", || held.lock().unwrap().is_some());
    root.channel.send("test.identity", json!({})).unwrap();
    app.wait(Duration::from_millis(50)).unwrap();
    held.lock()
        .unwrap()
        .take()
        .unwrap()
        .resolve(root.replies.lock().unwrap()["day.today.read"].clone());
    wait(
        &mut app,
        "The Pilot service this window was opened for changed. Open Pilot again.",
    );
    retry(&root);
    root.flush(9);
    app.wait(Duration::from_millis(100)).unwrap();
    assert!(!has(&app, "id:connection-read"));
    assert_eq!(root.count("day.plan.prepare"), 0);
    assert_eq!(root.count("day.today.read"), 1);
    assert_eq!(root.count("day.flush.ack"), 0);
    no_effects(&root);
    drop(app);
    std::fs::remove_dir_all(entry.parent().unwrap()).unwrap();
}

#[test]
fn a_failed_read_after_open_keeps_the_interview_draft_and_flush_owner() {
    let entry = recovery_entry();
    let root = FakeRoot::new();
    let (page, identity) = export_page();
    root.reply(
        "day.plan.inventory",
        inventory(vec![plan_row(
            "export",
            "Export a chat as Markdown",
            PlanStage::Questions,
            identity,
        )]),
    );
    root.reply("day.plan.read", page.clone());
    root.reply("day.plan.snapshot", page.clone());
    root.refuse("day.plan.save", "unavailable");
    let mut app = open_on(&entry, root.channel.clone());
    wait(&mut app, "id:plan-export");
    app.press("id:plan-export").unwrap();
    wait(&mut app, "id:interview");
    app.press("id:own-what").unwrap();
    app.type_text("id:answer-what", "Keep this exact draft")
        .unwrap();
    until(&mut app, "draft save refused", || {
        root.count("day.plan.save") == 1
    });
    root.refuse("day.today.read", "offline");
    let reads = root.count("day.today.read");
    root.changed();
    until(&mut app, "failed cached read", || {
        root.count("day.today.read") > reads
    });
    retry(&root);
    app.wait(Duration::from_millis(100)).unwrap();
    assert!(has(&app, "id:interview"));
    assert_eq!(
        app.screen().input_text("id:answer-what"),
        Ok(Some("Keep this exact draft"))
    );
    assert_eq!(root.count("day.plan.prepare"), 1);
    assert_eq!(root.count("day.today.read"), reads + 1);
    root.reply("day.plan.save", page);
    root.flush(15);
    until(&mut app, "same owner's saved view", || {
        root.count("day.flush.ack") == 1
    });
    assert_eq!(
        root.args("day.plan.save")[1]["intent"]["text"],
        "Keep this exact draft"
    );
    assert_eq!(root.args("day.flush.ack")[0]["view"]["id"], "export");
    no_effects(&root);
    drop(app);
    std::fs::remove_dir_all(entry.parent().unwrap()).unwrap();
}
