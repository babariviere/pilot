//! Mounted Replace deleted report in the real LocalViewer over an owned synthetic Local
//! only: the unavailable-report blocker inside Weekly Insights, one passive preview, the
//! compact confirmation, Escape back, stale and blocked previews, the frozen payload, a lost
//! ACK across close and restart, same-envelope Check, status-only pending steps, completion
//! beside a pending receipt, acceptance, the exact pin transition, adoption of a completed
//! link after the successor's settings re-read, rejection and render-only layouts. No real
//! grant, history, provider turn, rule or visible window.
use super::insights_enable_probe::{
    Mounted, attempt, click, contained, draft, from_automations, mount_with, open, panel, posts,
    ready, settle, type_draft, unmount, until,
};
use super::*;
use crate::{
    insights::State,
    insights_enable::fixture as weekly,
    insights_replace::fixture as fx,
    mission_browser_fixture::{Reply, Server},
};
use gpui_kit::{AnyWindowHandle, HeadlessAppContext, component::ThemeMode, test::TestWindowExt};
use serde_json::{Value, json};
use std::path::PathBuf;

const OPERATIONS: &str = "POST /api/operations";
const ENABLE_STATUS: &str = "POST /api/insights/enable/status";
const STATUS: &str = "POST /api/insights/replacement/status";
const STATUS_PATH: &str = "/api/insights/replacement/status";

fn pinned(report: &str) -> String {
    format!(
        "/api/insights/enable/preflight?projectId=project-A&missionId=mission-A&reportSessionId={report}"
    )
}
fn preview_path(model: Option<&str>) -> String {
    let mut p = format!(
        "/api/insights/replacement/preflight?projectId=project-A&missionId=mission-A&reportSessionId={}",
        fx::OLD
    );
    if let Some(m) = model {
        p.push_str(&format!("&model={}", m.replace('/', "%2F")));
    }
    p
}
fn hello(replacement: bool) -> Value {
    let mut caps = json!({"independentExecution":true,"insights":1,"insightsEnable":1,"insightsSettings":1,"insightsApply":1,"automations":1});
    if replacement {
        caps["insightsReplacement"] = json!(1);
    }
    json!({"daemonId":"test-daemon","lineageId":"test-lineage","protocolVersion":1,"minimumClientProtocolVersion":1,"capabilities":caps})
}
fn server() -> Server {
    let s = Server::start().with_capability();
    s.reply("/api/hello", Reply::json(200, hello(true)));
    s.reply("GET /api/schedules", Reply::json(200, json!([])));
    let models = json!({"defaultModel":"anthropic/claude-sonnet","models":[
        {"id":weekly::TERRA,"provider":"terra","name":"Terra 6.1","thinkingLevels":["off"]},
        {"id":"b/terra-6.1","provider":"b","name":"Terra 6.1","thinkingLevels":["off"]},
        {"id":"anthropic/claude-sonnet","provider":"anthropic","name":"Claude Sonnet","thinkingLevels":["off"]}
    ]});
    s.reply("/api/models?cwd=%2Fsynthetic%2FA", Reply::json(200, models));
    s
}
fn sent(all: &[(String, bool, Value)]) -> Vec<Value> {
    all.iter()
        .filter(|(p, _, _)| p == "/api/operations")
        .map(|(_, cap, body)| {
            assert!(
                *cap,
                "the replacement carries native confirmation authority"
            );
            body.clone()
        })
        .collect()
}
#[track_caller]
fn status_reads_only(s: &Server, envelope: &Value) {
    // The retained enable beside it may be re-read too; that is passive and never resent.
    let all: Vec<_> = posts(s)
        .into_iter()
        .filter(|(p, cap, b)| {
            let enable = p == "/api/insights/enable/status";
            assert!(!enable || (!cap && b["kind"] == "insights-enable"));
            !enable
        })
        .collect();
    assert!(sent(&all).is_empty(), "nothing is resent");
    assert!(
        all.iter()
            .all(|(p, _, b)| p == STATUS_PATH && b == envelope),
        "only passive status reads of the same envelope: {all:?}"
    );
}
fn shot(cx: &mut HeadlessAppContext, h: AnyWindowHandle, dir: &Option<PathBuf>, name: &str) {
    if let Some(d) = dir {
        cx.capture_screenshot(h)
            .unwrap()
            .save(d.join(format!("replace-{name}.png")))
            .unwrap();
    }
}
fn shown(
    cx: &mut HeadlessAppContext,
    view: &Entity<LocalViewer>,
) -> (&'static str, Option<String>) {
    let p = panel(cx, view);
    cx.update(|cx| p.read(cx).probe_replace())
}
fn known(cx: &mut HeadlessAppContext, view: &Entity<LocalViewer>) -> Vec<String> {
    let p = panel(cx, view);
    cx.update(|cx| p.read(cx).probe_known("project-A", "mission-A"))
}
/// Escape inside the panel: it closes the step first, then the panel.
fn escape(cx: &mut HeadlessAppContext, h: AnyWindowHandle) {
    cx.update_window(h, |_, w, cx| w.press("escape", cx))
        .unwrap();
    settle(cx, h);
}
fn close(cx: &mut HeadlessAppContext, h: AnyWindowHandle) {
    escape(cx, h);
    if cx.update_window(h, |_, w, _| open(w)).unwrap() {
        escape(cx, h);
    }
    assert!(!cx.update_window(h, |_, w, _| open(w)).unwrap());
}

/// A report chat enabled through the real flow, then missing from the list after a restart:
/// the retained accepted enable keeps its identity pinned, and Local calls it unavailable.
fn deleted(cx: &mut HeadlessAppContext, s: &Server, width: f32, mode: ThemeMode) -> Mounted {
    s.reply(
        &pinned(fx::OLD),
        Reply::json(
            200,
            weekly::offer(
                "project-A",
                "mission-A",
                weekly::TERRA,
                fx::OLD,
                weekly::chat(fx::OLD, weekly::TERRA),
                Value::Null,
            ),
        ),
    );
    let m = mount_with(cx, s, width, mode, Some(fx::OLD), None);
    let (h, view) = (m.h, m.view.clone());
    from_automations(cx, h, &view);
    s.reply(OPERATIONS, Reply::json(0, Value::Null));
    s.reply(
        ENABLE_STATUS,
        Reply::json(503, json!({"error":"synthetic"})),
    );
    click(cx, h, "insights-enable-confirm");
    until(cx, h, |w, cx| {
        w.try_find("insights-unconfirmed").is_some() && ready(&view, cx)
    });
    let envelope = sent(&posts(s)).remove(0);
    let op: crate::delivery_store::Operation = serde_json::from_value(envelope).unwrap();
    s.reply(
        ENABLE_STATUS,
        Reply::json(
            200,
            weekly::status(&op, "accepted", weekly::enabled(&op), "enabled", None),
        ),
    );
    click(cx, h, "insights-check");
    until(cx, h, |_, cx| {
        view.read(cx)
            .insights_book
            .as_ref()
            .and_then(|b| b.insights.get("enable:mission-A"))
            .is_some_and(|a| a.state == State::Accepted)
    });
    close(cx, h);
    posts(s);
    let root = unmount(cx, m);
    // Restart without the report chat: its status is blocked and a pinned check refuses it.
    s.reply(
        ENABLE_STATUS,
        Reply::json(
            200,
            weekly::status(
                &op,
                "accepted",
                weekly::enabled(&op),
                "blocked",
                Some("report_identity_unavailable"),
            ),
        ),
    );
    let mut missing = weekly::blocked(
        "project-A",
        "mission-A",
        json!({"state":"unavailable","reason":"catalog_unavailable"}),
        "report_identity_unavailable",
    );
    missing["targetId"] = json!(fx::OLD);
    s.reply(&pinned(fx::OLD), Reply::json(200, missing));
    let m = mount_with(cx, s, width, mode, None, Some(root));
    let (h, view) = (m.h, m.view.clone());
    // A composer draft typed before the flow must survive all of it.
    type_draft(cx, h, &view);
    from_automations(cx, h, &view);
    click(cx, h, "insights-enable-again");
    let p = panel(cx, &view);
    until(cx, h, |_, cx| {
        p.read(cx).probe_ready() && p.read(cx).probe_gate() == Some("checked")
    });
    posts(s);
    m
}

pub fn run_insights_replace_probe(cx: &mut HeadlessAppContext) {
    let reduced = cx.update(|cx| {
        let previous = cx.reduce_motion();
        cx.set_reduce_motion(true);
        previous
    });
    let dir = std::env::var_os("PILOT_NEXT_INSIGHTS_DIR").map(PathBuf::from);
    if let Some(d) = &dir {
        std::fs::create_dir_all(d).unwrap();
    }
    replacement(cx, &dir);
    adoption_and_refusals(cx, &dir);
    for (width, mode) in [
        (680., ThemeMode::Light),
        (680., ThemeMode::Dark),
        (1100., ThemeMode::Dark),
    ] {
        render_only(cx, &dir, width, mode);
    }
    cx.update(|cx| cx.set_reduce_motion(reduced));
    println!("insights replace: replacement, adoption/refusals and 3 render-only layouts passed");
}

/// Blocker → passive preview → Escape back → stale preview → confirmation → lost ACK →
/// close/restart → Check (same envelope) → pending steps → completion beside a pending
/// receipt → accepted → pins move to the successor → report navigation.
fn replacement(cx: &mut HeadlessAppContext, dir: &Option<PathBuf>) {
    let width = 1100.;
    let s = server();
    let m = deleted(cx, &s, width, ThemeMode::Light);
    let (h, view) = (m.h, m.view.clone());
    let p = panel(cx, &view);
    // The blocker offers replacement; Enable is not offered over an unavailable report.
    cx.update_window(h, |_, w, cx| {
        assert_eq!(
            p.read(cx).probe_preflight().unwrap().reason.as_deref(),
            Some("report_identity_unavailable")
        );
        assert!(w.try_find("insights-enable-blocked").is_some());
        assert!(w.try_find("insights-enable-confirm").is_none());
        assert_ne!(w.find("insights-replace-open").disabled(), Some(true));
        contained(w, width);
    })
    .unwrap();
    assert_eq!(known(cx, &view), [fx::OLD]);
    shot(cx, h, dir, "blocker");

    // Opening the step is a passive read of the exact old identity.
    s.reply(
        &preview_path(None),
        Reply::json(200, fx::ready("project-A", "mission-A", weekly::TERRA)),
    );
    click(cx, h, "insights-replace-open");
    until(cx, h, |_, cx| {
        p.read(cx).probe_ready() && p.read(cx).probe_replace_gate() == Some("checked")
    });
    assert!(
        posts(&s).is_empty(),
        "nothing is written before confirmation"
    );
    cx.update_window(h, |_, w, cx| {
        assert_eq!(p.read(cx).probe_replace(), ("step", None));
        for id in [
            "insights-replace-lead",
            "insights-replace-old",
            "insights-replace-rules",
            "insights-replace-new",
            "insights-field-when",
            "insights-when-note",
            "insights-model-note",
            "insights-enable-provider",
            "insights-field-budget",
            "insights-budget-note",
        ] {
            assert!(w.try_find(id).is_some(), "{id} is disclosed");
        }
        // One cancelled rule is listed; the kept one is counted as history.
        assert!(w.try_find(("insights-replace-rule", 0usize)).is_some());
        assert!(w.try_find(("insights-replace-rule", 1usize)).is_none());
        assert_ne!(w.find("insights-replace-confirm").disabled(), Some(true));
        assert!(
            w.find("insights-replace-confirm").visible(),
            "actions stay pinned"
        );
        assert_eq!(p.read(cx).probe_model_name().as_deref(), Some("Terra 6.1"));
        contained(w, width);
    })
    .unwrap();
    click(cx, h, "insights-enable-details");
    cx.update_window(h, |_, w, _| {
        assert!(w.try_find("insights-replace-old-id").is_some());
        assert!(w.try_find("insights-replace-new-id").is_some());
    })
    .unwrap();
    shot(cx, h, dir, "confirm");

    // Escape leaves the step, not the panel; focus stays in the dialog. Nothing was sent.
    escape(cx, h);
    cx.update_window(h, |_, w, cx| {
        assert!(open(w));
        assert_eq!(p.read(cx).probe_replace().0, "none");
        assert!(p.read(cx).owns_focus(w, cx), "focus stays in the dialog");
        assert!(w.try_find("insights-replace-open").is_some());
    })
    .unwrap();
    assert!(posts(&s).is_empty());

    // A stale preview: Local now refuses; the confirmation disappears until a fresh ready read.
    s.reply(
        &preview_path(None),
        Reply::json(
            200,
            fx::blocked("project-A", "mission-A", "preview_changed", "bounded"),
        ),
    );
    click(cx, h, "insights-replace-open");
    until(cx, h, |_, cx| {
        p.read(cx).probe_ready() && p.read(cx).probe_replace_gate() == Some("checked")
    });
    cx.update_window(h, |_, w, cx| {
        assert!(
            p.read(cx)
                .probe_replace_preview()
                .unwrap()
                .request()
                .is_none()
        );
        assert!(w.try_find("insights-replace-blocked").is_some());
        assert_eq!(w.find("insights-replace-confirm").disabled(), Some(true));
    })
    .unwrap();
    // A slow ready reply for a step the user left is overtaken by a newer refusal and never lands.
    s.reply(
        &preview_path(None),
        Reply {
            delay_ms: 1_500,
            ..Reply::json(200, fx::ready("project-A", "mission-A", weekly::TERRA))
        },
    );
    click(cx, h, "insights-replace-retry");
    let slow = std::time::Instant::now();
    until(cx, h, |w, _| {
        w.try_find("insights-replace-checking").is_some()
    });
    click(cx, h, "insights-replace-back");
    s.reply(
        &preview_path(None),
        Reply::json(
            200,
            fx::blocked(
                "project-A",
                "mission-A",
                "old_operation_pending_use_receipt",
                "bounded",
            ),
        ),
    );
    click(cx, h, "insights-replace-open");
    until(cx, h, |_, cx| {
        p.read(cx).probe_ready()
            && p.read(cx)
                .probe_replace_preview()
                .is_some_and(|pf| pf.reason.as_deref() == Some("old_operation_pending_use_receipt"))
    });
    std::thread::sleep(Duration::from_millis(1_800).saturating_sub(slow.elapsed()));
    settle(cx, h);
    cx.update_window(h, |_, w, cx| {
        assert!(
            p.read(cx)
                .probe_replace_preview()
                .unwrap()
                .request()
                .is_none(),
            "the overtaken reply is fenced"
        );
        assert_eq!(w.find("insights-replace-confirm").disabled(), Some(true));
    })
    .unwrap();
    assert!(posts(&s).is_empty(), "refusals send nothing");

    // Fresh ready preview, one explicit confirmation; its ACK is lost.
    s.reply(
        &preview_path(None),
        Reply::json(200, fx::ready("project-A", "mission-A", weekly::TERRA)),
    );
    click(cx, h, "insights-replace-retry");
    until(cx, h, |_, cx| {
        p.read(cx).probe_ready()
            && p.read(cx)
                .probe_replace_preview()
                .is_some_and(|pf| pf.request().is_some())
    });
    s.reply(OPERATIONS, Reply::json(0, Value::Null));
    s.reply(STATUS, Reply::json(503, json!({"error":"synthetic"})));
    click(cx, h, "insights-replace-confirm");
    until(cx, h, |w, cx| {
        w.try_find("insights-unconfirmed").is_some() && ready(&view, cx)
    });
    let first = sent(&posts(&s));
    assert_eq!(first.len(), 1, "one send");
    let envelope = first[0].clone();
    assert_eq!(envelope["kind"], "insights-replace");
    assert_eq!(envelope["targetId"], fx::SUCCESSOR);
    assert_eq!(
        envelope["destination"],
        serde_json::to_value(s.options.host()).unwrap()
    );
    let payload: Value = serde_json::from_str(envelope["payload"].as_str().unwrap()).unwrap();
    assert_eq!(
        payload,
        fx::payload("project-A", "mission-A", weekly::TERRA),
        "the preview payload, verbatim"
    );
    let slot = format!("replace:{}", fx::OLD);
    let saved = attempt(cx, &view, &slot).unwrap();
    assert_eq!(
        (saved.state, serde_json::to_value(&saved.operation).unwrap()),
        (State::Unknown, envelope.clone())
    );
    assert_eq!(shown(cx, &view).0, "progress");
    assert_eq!(
        known(cx, &view),
        [fx::OLD],
        "an unconfirmed replacement moves no pin"
    );
    // The original enable attempt is kept unchanged beside it.
    assert_eq!(
        attempt(cx, &view, "enable:mission-A").unwrap().state,
        State::Accepted
    );
    shot(cx, h, dir, "unknown");

    // Close and reopen, then restart the writer: the attempt stays, nothing is resent.
    close(cx, h);
    from_automations(cx, h, &view);
    assert_eq!(shown(cx, &view).0, "progress");
    assert!(sent(&posts(&s)).is_empty(), "reopening never replays");
    close(cx, h);
    assert!(
        draft(cx, &view).starts_with("Unsent reply"),
        "the composer draft survives"
    );
    drop(p);
    let root = unmount(cx, m);
    let op: crate::delivery_store::Operation = serde_json::from_value(envelope.clone()).unwrap();
    s.reply(
        STATUS,
        Reply::json(
            200,
            fx::status(&op, "unknown", Value::Null, "not_found", None),
        ),
    );
    let m = mount_with(cx, &s, width, ThemeMode::Light, None, Some(root));
    let (h, view) = (m.h, m.view.clone());
    from_automations(cx, h, &view);
    assert_eq!(
        shown(cx, &view),
        ("progress", Some("Local has no record of it yet.".into()))
    );
    status_reads_only(&s, &envelope);

    // Check: Local has no record, so the same envelope goes once; the host entered a step.
    let pending = fx::status(
        &op,
        "pending",
        fx::progress(&op, "cancel_pending"),
        "unknown",
        Some("old_cancellation_unknown_use_retained_receipt"),
    );
    s.reply(OPERATIONS, Reply::json(200, pending["receipt"].clone()));
    s.hold(OPERATIONS);
    click(cx, h, "insights-check");
    until(cx, h, |_, _| {
        s.state
            .lock()
            .unwrap()
            .writes
            .iter()
            .any(|w| w.1 == "/api/operations")
    });
    s.reply(STATUS, Reply::json(200, pending.clone()));
    s.release(OPERATIONS);
    until(cx, h, |_, cx| {
        ready(&view, cx)
            && view
                .read(cx)
                .insights_book
                .as_ref()
                .and_then(|b| b.insights.get(&slot))
                .is_some_and(|a| a.state == State::Pending)
    });
    let resent = sent(&posts(&s));
    assert_eq!(
        resent, first,
        "Check resends exactly the saved bytes and operation ID"
    );
    let words =
        crate::insights_replace::reason_text("old_cancellation_unknown_use_retained_receipt");
    assert_eq!(shown(cx, &view), ("progress", Some(words.into())));
    shot(cx, h, dir, "cancellation-unknown");

    // Pending at a later step: Check is a status read only.
    s.reply(
        STATUS,
        Reply::json(
            200,
            fx::status(
                &op,
                "pending",
                fx::progress(&op, "chat_ready"),
                "partial",
                Some("replacement_incomplete_use_retained_receipt"),
            ),
        ),
    );
    click(cx, h, "insights-check");
    until(cx, h, |_, cx| {
        ready(&view, cx)
            && shown_words(&view, cx) == Some("New report chat ready. Scheduling…".into())
    });
    status_reads_only(&s, &envelope);

    // Completed beside a pending receipt (lost final ACK): Replaced, but still pending.
    s.reply(
        STATUS,
        Reply::json(
            200,
            fx::status(
                &op,
                "pending",
                fx::progress(&op, "schedule_pending"),
                "replaced",
                None,
            ),
        ),
    );
    click(cx, h, "insights-check");
    until(cx, h, |_, cx| {
        ready(&view, cx) && shown_words(&view, cx) == Some("Replaced".into())
    });
    status_reads_only(&s, &envelope);
    assert_eq!(attempt(cx, &view, &slot).unwrap().state, State::Pending);
    assert!(
        attempt(cx, &view, &slot).unwrap().result.is_none(),
        "no acceptance is invented"
    );
    assert_eq!(
        known(cx, &view),
        [fx::OLD],
        "completion beside a pending receipt moves no pin"
    );
    cx.update_window(h, |_, w, _| {
        assert!(
            w.try_find("insights-unconfirmed").is_some(),
            "a pending receipt keeps Check"
        );
        assert!(w.try_find("insights-replace-open-chat").is_none());
        contained(w, width);
    })
    .unwrap();
    shot(cx, h, dir, "replaced-pending");

    // Accepted: the exact receipt settles it; pins move to the successor, passively.
    s.reply(
        &pinned(fx::SUCCESSOR),
        Reply::json(
            200,
            weekly::blocked(
                "project-A",
                "mission-A",
                json!({"state":"available","id":weekly::TERRA}),
                "enable_pending_use_status",
            ),
        ),
    );
    s.reply(
        STATUS,
        Reply::json(
            200,
            fx::status(
                &op,
                "accepted",
                fx::progress(&op, "replaced"),
                "replaced",
                None,
            ),
        ),
    );
    click(cx, h, "insights-check");
    until(cx, h, |_, cx| {
        ready(&view, cx)
            && view.read(cx).insights.as_ref().is_some_and(|(p, _)| {
                p.read(cx).probe_replace() == ("settled", Some("Replaced".into()))
            })
    });
    status_reads_only(&s, &envelope);
    assert_eq!(attempt(cx, &view, &slot).unwrap().state, State::Accepted);
    assert_eq!(
        known(cx, &view),
        [fx::SUCCESSOR],
        "the exact receipt moves the pin"
    );
    cx.update_window(h, |_, w, _| {
        assert!(w.try_find("insights-unconfirmed").is_none());
        assert!(w.try_find("insights-when-note").is_some(), "next run shown");
        contained(w, width);
    })
    .unwrap();
    shot(cx, h, dir, "replaced");
    close(cx, h);
    let root = unmount(cx, m);

    // Restart: the accepted record and its pin survive; the next check pins the successor.
    let m = mount_with(cx, &s, width, ThemeMode::Light, None, Some(root));
    let (h, view) = (m.h, m.view.clone());
    from_automations(cx, h, &view);
    assert_eq!(shown(cx, &view), ("settled", Some("Replaced".into())));
    assert_eq!(known(cx, &view), [fx::SUCCESSOR]);
    status_reads_only(&s, &envelope);
    click(cx, h, "insights-replace-open-chat");
    until(cx, h, |w, _| !open(w));
    assert!(sent(&posts(&s)).is_empty());
    // A later enable check for this backlog pins the successor, never the old identity.
    assert!(
        !s.state
            .lock()
            .unwrap()
            .seen
            .iter()
            .any(|(m, path)| m != "GET" && path.contains(fx::OLD)),
        "nothing is written for the old identity"
    );
    let root = unmount(cx, m);
    let _ = std::fs::remove_dir_all(root);
    println!(
        "insights replace 1100 Light: blocker, passive preview, Escape back, stale/overtaken previews, exact payload, lost ACK, close/restart without replay, same-envelope Check, status-only steps, completion beside pending receipt, acceptance, pin transition and navigation passed"
    );
}
fn shown_words(view: &Entity<LocalViewer>, cx: &App) -> Option<String> {
    view.read(cx)
        .insights
        .as_ref()
        .and_then(|(p, _)| p.read(cx).probe_replace().1)
}

/// Blocked old authority, an older Local, malformed and fenced previews, adoption of a
/// completed link only after the successor's exact settings re-read, and a rejection.
fn adoption_and_refusals(cx: &mut HeadlessAppContext, dir: &Option<PathBuf>) {
    let width = 1100.;
    let s = server();
    let m = deleted(cx, &s, width, ThemeMode::Light);
    let (h, view) = (m.h, m.view.clone());
    let p = panel(cx, &view);
    let check = |cx: &mut HeadlessAppContext, h| {
        let p = p.clone();
        until(cx, h, move |_, cx| {
            p.read(cx).probe_ready()
                && p.read(cx)
                    .probe_replace_gate()
                    .is_some_and(|g| g != "loading")
        });
    };

    // Old identity whose home can't be qualified: a real blocker, nothing to confirm.
    s.reply(
        &preview_path(None),
        Reply::json(
            200,
            fx::blocked(
                "project-A",
                "mission-A",
                "old_identity_home_unqualified",
                "bounded",
            ),
        ),
    );
    click(cx, h, "insights-replace-open");
    check(cx, h);
    cx.update_window(h, |_, w, _| {
        assert!(w.try_find("insights-replace-blocked").is_some());
        assert_eq!(w.find("insights-replace-confirm").disabled(), Some(true));
    })
    .unwrap();
    shot(cx, h, dir, "unqualified");

    // An automation that can't be stopped safely is named as the blocker.
    let mut untrusted = fx::blocked(
        "project-A",
        "mission-A",
        "old_automation_untrusted_or_uncertain",
        "bounded",
    );
    untrusted["rules"] = fx::rules();
    untrusted["rules"][0]["disposition"] = json!("blocked");
    s.reply(&preview_path(None), Reply::json(200, untrusted));
    click(cx, h, "insights-replace-retry");
    check(cx, h);
    cx.update_window(h, |_, w, _| {
        assert!(w.try_find("insights-replace-rules").is_some());
        assert!(w.try_find(("insights-replace-rule", 0usize)).is_some());
        assert_eq!(w.find("insights-replace-confirm").disabled(), Some(true));
    })
    .unwrap();

    // Malformed: a copied grant in the payload is never confirmable.
    let mut copied = fx::ready("project-A", "mission-A", weekly::TERRA);
    copied["payload"]["enable"]["chat"] = weekly::chat(fx::SUCCESSOR, weekly::TERRA);
    s.reply(&preview_path(None), Reply::json(200, copied));
    click(cx, h, "insights-replace-retry");
    check(cx, h);
    assert_eq!(
        cx.update(|cx| p.read(cx).probe_replace_gate()),
        Some("failed")
    );

    // A fence alone is pending work elsewhere, not an adoption.
    let mut fenced = fx::blocked(
        "project-A",
        "mission-A",
        "replacement_pending_use_status",
        "bounded",
    );
    fenced["supersession"] = fx::link("project-A", "mission-A", 1);
    s.reply(&preview_path(None), Reply::json(200, fenced));
    click(cx, h, "insights-replace-retry");
    check(cx, h);
    assert!(!cx.update(|cx| p.read(cx).probe_adopted()));
    assert_eq!(known(cx, &view), [fx::OLD]);

    // A completed link whose successor re-read names another context is not adopted.
    let settings = format!("/api/insights/sessions/{}/settings", fx::SUCCESSOR);
    let mut snapshot = crate::insights_settings::fixture::snapshot(
        0,
        crate::insights_settings::fixture::settings(weekly::TERRA),
        weekly::TERRA,
    );
    snapshot["chat"]["sessionId"] = json!(fx::SUCCESSOR);
    let mut other = snapshot.clone();
    other["context"] = json!("other");
    s.reply(&settings, Reply::json(200, other));
    s.reply(
        &preview_path(None),
        Reply::json(200, fx::replaced("project-A", "mission-A")),
    );
    click(cx, h, "insights-replace-retry");
    check(cx, h);
    assert!(!cx.update(|cx| p.read(cx).probe_adopted()));
    assert_eq!(
        cx.update(|cx| p.read(cx).probe_successor_refusal())
            .as_deref(),
        Some("The new report chat doesn't match this backlog. Nothing was adopted."),
        "the re-read itself refused it"
    );
    assert_eq!(
        known(cx, &view),
        [fx::OLD],
        "a mismatched successor moves no pin"
    );
    cx.update_window(h, |_, w, _| {
        assert!(w.try_find("insights-replace-open-chat").is_none())
    })
    .unwrap();

    // The exact re-read adopts it: pins move, and the next check pins the successor.
    s.reply(&settings, Reply::json(200, snapshot));
    s.reply(
        &pinned(fx::SUCCESSOR),
        Reply::json(
            200,
            weekly::blocked(
                "project-A",
                "mission-A",
                json!({"state":"available","id":weekly::TERRA}),
                "enable_pending_use_status",
            ),
        ),
    );
    click(cx, h, "insights-replace-retry");
    check(cx, h);
    until(cx, h, |_, cx| {
        p.read(cx).probe_adopted() && p.read(cx).probe_ready()
    });
    assert_eq!(known(cx, &view), [fx::SUCCESSOR]);
    until(cx, h, |_, _| {
        s.state
            .lock()
            .unwrap()
            .seen
            .iter()
            .any(|(_, path)| *path == pinned(fx::SUCCESSOR))
    });
    cx.update_window(h, |_, w, _| {
        assert!(w.try_find("insights-replace-open-chat").is_some());
        contained(w, width);
    })
    .unwrap();
    assert!(posts(&s).is_empty(), "adoption is read-only");
    shot(cx, h, dir, "adopted");
    close(cx, h);
    drop(p);
    let root = unmount(cx, m);
    let _ = std::fs::remove_dir_all(root);

    // An older Local without the replacement interface: the blocker offers nothing new.
    let s = server();
    let m = deleted(cx, &s, width, ThemeMode::Light);
    let (h, view) = (m.h, m.view.clone());
    s.reply("/api/hello", Reply::json(200, hello(false)));
    click(cx, h, "insights-enable-retry");
    let p = panel(cx, &view);
    until(cx, h, |_, cx| {
        p.read(cx).probe_ready() && p.read(cx).probe_gate() == Some("checked")
    });
    cx.update_window(h, |_, w, _| {
        assert!(w.try_find("insights-replace-open").is_none());
        assert_eq!(w.find("insights-enable-confirm").disabled(), Some(true));
    })
    .unwrap();

    // Rejected: final and shown; the step re-reads its preview, nothing is resent.
    s.reply("/api/hello", Reply::json(200, hello(true)));
    click(cx, h, "insights-enable-retry");
    until(cx, h, |w, cx| {
        p.read(cx).probe_ready() && w.try_find("insights-replace-open").is_some()
    });
    s.reply(
        &preview_path(None),
        Reply::json(200, fx::ready("project-A", "mission-A", weekly::TERRA)),
    );
    click(cx, h, "insights-replace-open");
    until(cx, h, |_, cx| {
        p.read(cx).probe_ready()
            && p.read(cx)
                .probe_replace_preview()
                .is_some_and(|pf| pf.request().is_some())
    });
    s.reply(OPERATIONS, Reply::json(500, json!({"error":"synthetic"})));
    click(cx, h, "insights-replace-confirm");
    until(cx, h, |w, cx| {
        w.try_find("insights-unconfirmed").is_some() && ready(&view, cx)
    });
    let op: crate::delivery_store::Operation =
        serde_json::from_value(sent(&posts(&s)).remove(0)).unwrap();
    s.reply(
        STATUS,
        Reply::json(
            200,
            fx::status(
                &op,
                "rejected",
                Value::Null,
                "blocked",
                Some("replacement_preview_changed_refresh"),
            ),
        ),
    );
    s.reply(
        &preview_path(None),
        Reply::json(
            200,
            fx::blocked("project-A", "mission-A", "preview_changed", "bounded"),
        ),
    );
    click(cx, h, "insights-check");
    let slot = format!("replace:{}", fx::OLD);
    until(cx, h, |w, cx| {
        p.read(cx).probe_ready()
            && view
                .read(cx)
                .insights_book
                .as_ref()
                .and_then(|b| b.insights.get(&slot))
                .is_some_and(|a| a.state == State::Rejected)
            && w.try_find("insights-outcome").is_some()
    });
    cx.update_window(h, |_, w, cx| {
        assert_eq!(
            p.read(cx).probe_replace().0,
            "step",
            "a refusal returns to the step"
        );
        assert_eq!(
            p.read(cx)
                .probe_replace_preview()
                .unwrap()
                .reason
                .as_deref(),
            Some("preview_changed"),
            "a fresh preview follows"
        );
        assert_eq!(w.find("insights-replace-confirm").disabled(), Some(true));
    })
    .unwrap();
    assert!(
        sent(&posts(&s)).is_empty(),
        "a rejected receipt is never resent"
    );
    assert_eq!(known(cx, &view), [fx::OLD]);
    shot(cx, h, dir, "rejected");
    close(cx, h);
    drop(p);
    let root = unmount(cx, m);
    let _ = std::fs::remove_dir_all(root);
    println!(
        "insights replace 1100 Light: unqualified old home, untrusted rule, malformed copied grant, fence-only link, mismatched and exact successor adoption, older Local and rejection passed"
    );
}

fn render_only(cx: &mut HeadlessAppContext, dir: &Option<PathBuf>, width: f32, mode: ThemeMode) {
    let s = server();
    let m = deleted(cx, &s, width, mode);
    let (h, view) = (m.h, m.view.clone());
    let tag = format!("{}-{mode:?}", width as u32);
    let p = panel(cx, &view);
    s.reply(
        &preview_path(None),
        Reply::json(200, fx::ready("project-A", "mission-A", weekly::TERRA)),
    );
    click(cx, h, "insights-replace-open");
    until(cx, h, |_, cx| {
        p.read(cx).probe_ready() && p.read(cx).probe_replace_gate() == Some("checked")
    });
    click(cx, h, "insights-enable-details");
    cx.update_window(h, |_, w, _| {
        contained(w, width);
        for id in [
            "insights-replace-old-id",
            "insights-replace-new-id",
            "insights-enable-sample",
            "insights-field-budget",
        ] {
            assert!(w.try_find(id).is_some(), "{id}");
        }
        assert!(
            w.find("insights-replace-confirm").visible(),
            "actions stay pinned"
        );
        assert!(w.find("insights-replace-back").visible());
    })
    .unwrap();
    shot(cx, h, dir, &format!("confirm-{tag}"));
    close(cx, h);
    assert!(posts(&s).is_empty(), "rendering never writes");
    drop(p);
    let root = unmount(cx, m);
    let _ = std::fs::remove_dir_all(root);
    println!("insights replace render-only {tag} passed");
}
