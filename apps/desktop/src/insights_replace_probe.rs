//! Mounted Replace deleted report in the real LocalViewer over an owned synthetic Local
//! only: the accepted old enable whose present status is Unknown after deletion, the
//! unavailable-report blocker inside Weekly Insights, one passive preview, the compact
//! confirmation, Escape back, stale and blocked previews, the frozen payload, a lost ACK
//! across close and restart, same-envelope Check, status-only pending steps, completion
//! beside a pending receipt, acceptance, the exact pin transition, adoption of a completed
//! link after the successor's settings re-read (also across close, reopen and restart),
//! double confirmation, malformed ACKs, current replacement blockers beside the old
//! enable's status, rejection and render-only layouts. No real grant, history, provider
//! turn, rule or visible window.
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
const ENABLE_STATUS_PATH: &str = "/api/insights/enable/status";
const MISSING: Option<&str> = Some("report_identity_unavailable");

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
fn status_reads_only(s: &Server, envelope: &Value) -> usize {
    // The retained enable beside it may be re-read too; that is passive and never resent.
    let mut enable_reads = 0;
    let all: Vec<_> = posts(s)
        .into_iter()
        .filter(|(p, cap, b)| {
            let enable = p == ENABLE_STATUS_PATH;
            assert!(!enable || (!cap && b["kind"] == "insights-enable"));
            enable_reads += usize::from(enable);
            !enable
        })
        .collect();
    assert!(sent(&all).is_empty(), "nothing is resent");
    assert!(
        all.iter()
            .all(|(p, _, b)| p == STATUS_PATH && b == envelope),
        "only passive status reads of the same envelope: {all:?}"
    );
    enable_reads
}
/// Only passive status reads of the old enable's exact envelope; no operation at all.
#[track_caller]
fn enable_reads_only(s: &Server, envelope: &Value) {
    let all = posts(s);
    assert!(
        all.iter()
            .all(|(p, cap, b)| p == ENABLE_STATUS_PATH && !cap && b == envelope),
        "the old enable is only read, never resent: {all:?}"
    );
}
/// Every operation POST this Local has received, drained or not.
fn operation_posts(s: &Server) -> usize {
    s.state
        .lock()
        .unwrap()
        .seen
        .iter()
        .filter(|(m, p)| m == "POST" && p == "/api/operations")
        .count()
}
/// GET requests for exactly `path` so far.
fn gets(s: &Server, path: &str) -> usize {
    s.state
        .lock()
        .unwrap()
        .seen
        .iter()
        .filter(|(m, p)| m == "GET" && p == path)
        .count()
}
/// Only passive status reads without native authority; no operation.
#[track_caller]
fn passive_only(s: &Server) {
    let all = posts(s);
    assert!(
        all.iter()
            .all(|(p, cap, _)| !cap && (p == STATUS_PATH || p == ENABLE_STATUS_PATH)),
        "only passive status reads: {all:?}"
    );
}
/// SHA-256 of the exact UTF-8 payload bytes, computed here rather than by the writer.
fn sha256(text: &str) -> String {
    use sha2::Digest as _;
    sha2::Sha256::digest(text.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
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
fn enable_shown(
    cx: &mut HeadlessAppContext,
    view: &Entity<LocalViewer>,
) -> (&'static str, Option<String>) {
    let p = panel(cx, view);
    cx.update(|cx| p.read(cx).probe_enable())
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

/// A report chat enabled through the real flow, then deleted: after a restart it is missing
/// from the list, the retained accepted enable keeps its identity pinned, and the host's
/// present status is Unknown with `report_identity_unavailable` (insights-enable.ts).
fn deleted(cx: &mut HeadlessAppContext, s: &Server, width: f32, mode: ThemeMode) -> Mounted {
    deleted_as(cx, s, width, mode, "unknown")
}
/// `current` is the old enable's present state after the restart: "unknown" is the host's
/// shape after deletion; "blocked" (a report that is present but unusable) stays its own path.
fn deleted_as(
    cx: &mut HeadlessAppContext,
    s: &Server,
    width: f32,
    mode: ThemeMode,
    current: &str,
) -> Mounted {
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
    let envelope = serde_json::to_value(&op).unwrap();
    let historical = |current: &str, reason: Option<&str>| {
        Reply::json(
            200,
            weekly::status(&op, "accepted", weekly::enabled(&op), current, reason),
        )
    };
    // Restart without the report chat. Before the deletion shape, another Unknown: it
    // offers Check only.
    let deletion = current == "unknown";
    s.reply(
        ENABLE_STATUS,
        if deletion {
            historical("unknown", None)
        } else {
            historical(current, MISSING)
        },
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
    if deletion {
        assert_eq!(
            enable_shown(cx, &view),
            ("settled", Some("Not confirmed.".into()))
        );
        cx.update_window(h, |_, w, _| {
            assert!(w.try_find("insights-enable-again").is_none());
            assert!(w.try_find("insights-enable-recheck").is_some());
        })
        .unwrap();
        // Check again is one more passive read; now the host's exact deletion shape.
        s.reply(ENABLE_STATUS, historical("unknown", MISSING));
        click(cx, h, "insights-enable-recheck");
        until(cx, h, |w, cx| {
            ready(&view, cx) && w.try_find("insights-enable-again").is_some()
        });
    }
    let p = panel(cx, &view);
    let words = crate::insights_enable::reason_text("report_identity_unavailable");
    assert_eq!(enable_shown(cx, &view), ("settled", Some(words.into())));
    let status = cx.update(|cx| p.read(cx).probe_enable_status()).unwrap();
    assert_eq!(
        (
            status.current == crate::insights_enable::Current::Unknown,
            status.reason.as_deref()
        ),
        (deletion, MISSING),
        "the host's present state is shown as it is, never promoted"
    );
    cx.update_window(h, |_, w, _| {
        assert!(w.try_find("insights-enable-recheck").is_none());
        assert!(
            w.try_find("insights-unconfirmed").is_none(),
            "nothing to resend"
        );
        assert!(w.try_find("insights-replace-open").is_none());
    })
    .unwrap();
    // The accepted receipt is history: it stays accepted and is never resent.
    let old = attempt(cx, &view, "enable:mission-A").unwrap();
    assert_eq!(
        (old.state, serde_json::to_value(&old.operation).unwrap()),
        (State::Accepted, envelope.clone())
    );
    enable_reads_only(s, &envelope);
    click(cx, h, "insights-enable-again");
    until(cx, h, |_, cx| {
        p.read(cx).probe_ready() && p.read(cx).probe_gate() == Some("checked")
    });
    // Set up again is a fresh pinned check of the exact old identity, not a send.
    enable_reads_only(s, &envelope);
    assert_eq!(
        operation_posts(s),
        1,
        "only the original enable was ever sent"
    );
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
    double_confirm_and_authority(cx, &dir);
    for (width, mode) in [
        (680., ThemeMode::Light),
        (680., ThemeMode::Dark),
        (1100., ThemeMode::Dark),
    ] {
        render_only(cx, &dir, width, mode);
    }
    cx.update(|cx| cx.set_reduce_motion(reduced));
    println!(
        "insights replace: replacement, adoption/refusals, double confirm/malformed ACK/current authority and 3 render-only layouts passed"
    );
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

/// Two clicks on one confirmation and two malformed ACKs keep one Unknown attempt with its
/// exact ID, bytes and hash; only Check resends that envelope. After acceptance, the
/// replacement's own present Blocked or Partial state is what the panel shows, while the old
/// enable's historical status (accepted receipt, Unknown) is read beside it.
fn double_confirm_and_authority(cx: &mut HeadlessAppContext, dir: &Option<PathBuf>) {
    let width = 1100.;
    let s = server();
    let mut m = deleted(cx, &s, width, ThemeMode::Light);
    let (h, view) = (m.h, m.view.clone());
    let p = panel(cx, &view);
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
    // A receipt for other bytes is malformed. It is held, so more clicks land meanwhile.
    s.reply(
        OPERATIONS,
        Reply::json(
            200,
            json!({"operationId":"0d8f0f5e-3b6c-4f7a-9d1e-2a3b4c5d6e7f","payloadHash":"0".repeat(64),
                "targetId":fx::SUCCESSOR,"destination":s.options.host(),"state":"accepted",
                "result":Value::Null}),
        ),
    );
    s.reply(STATUS, Reply::json(503, json!({"error":"synthetic"})));
    s.hold(OPERATIONS);
    let before = cx.update(|cx| p.read(cx).probe_requests().0);
    cx.update_window(h, |_, w, cx| {
        w.click("insights-replace-confirm", cx);
        w.click("insights-replace-confirm", cx);
    })
    .unwrap();
    settle(cx, h);
    until(cx, h, |_, _| {
        s.state
            .lock()
            .unwrap()
            .writes
            .iter()
            .any(|w| w.1 == "/api/operations")
    });
    cx.update_window(h, |_, w, cx| {
        if w.try_find("insights-replace-confirm").is_some() {
            w.click("insights-replace-confirm", cx);
        }
    })
    .unwrap();
    settle(cx, h);
    s.release(OPERATIONS);
    let slot = format!("replace:{}", fx::OLD);
    until(cx, h, |w, cx| {
        w.try_find("insights-unconfirmed").is_some()
            && ready(&view, cx)
            && view
                .read(cx)
                .insights_book
                .as_ref()
                .and_then(|b| b.insights.get(&slot))
                .is_some_and(|a| a.state == State::Unknown)
    });
    assert_eq!(
        cx.update(|cx| p.read(cx).probe_requests()),
        (
            before + 1,
            Some(crate::insights::Outcome::Unknown(
                "The receipt doesn't match this Insights action. It was kept unchanged."
            ))
        ),
        "one command reached the writer; its malformed ACK left it Unknown"
    );
    cx.update_window(h, |_, w, _| {
        assert!(w.try_find("insights-outcome").is_none());
        assert!(w.try_find("insights-error").is_none());
    })
    .unwrap();
    let first = sent(&posts(&s));
    assert_eq!(first.len(), 1, "one confirmation, one send");
    let envelope = first[0].clone();
    let op: crate::delivery_store::Operation = serde_json::from_value(envelope.clone()).unwrap();
    assert_eq!(
        (op.kind.as_str(), op.target_id.as_str()),
        ("insights-replace", fx::SUCCESSOR)
    );
    assert_eq!(
        serde_json::from_str::<Value>(&op.payload).unwrap(),
        fx::payload("project-A", "mission-A", weekly::TERRA),
        "the preview payload, verbatim"
    );
    assert_eq!(
        op.payload_hash,
        sha256(&op.payload),
        "hash of the exact bytes"
    );
    let retained = |cx: &mut HeadlessAppContext, view: &Entity<LocalViewer>| {
        let a = attempt(cx, view, &slot).unwrap();
        assert_eq!(
            (a.state, serde_json::to_value(&a.operation).unwrap()),
            (State::Unknown, envelope.clone()),
            "the same Unknown attempt, unchanged"
        );
        assert!(a.result.is_none(), "no acceptance is invented");
    };
    retained(cx, &view);
    assert_eq!(shown(cx, &view).0, "progress");
    assert_eq!(known(cx, &view), [fx::OLD], "a malformed ACK moves no pin");
    assert_eq!(
        attempt(cx, &view, "enable:mission-A").unwrap().state,
        State::Accepted
    );
    let count = cx.update(|cx| {
        view.read(cx).insights_book.as_ref().map_or(0, |b| {
            b.insights
                .values()
                .filter(|a| a.operation.kind == "insights-replace")
                .count()
        })
    });
    assert_eq!(count, 1, "one replacement attempt");
    shot(cx, h, dir, "malformed-ack");

    // Check: no record yet, so the same envelope goes once more. Its ACK names this exact
    // command but an unfinished step as accepted: malformed too, and still Unknown.
    s.reply(
        STATUS,
        Reply::json(
            200,
            fx::status(&op, "unknown", Value::Null, "not_found", None),
        ),
    );
    let early = json!({"operationId":op.operation_id,"payloadHash":op.payload_hash,
        "targetId":op.target_id,"destination":op.destination,"state":"accepted",
        "result":fx::progress(&op, "chat_ready")});
    s.reply(OPERATIONS, Reply::json(200, early));
    click(cx, h, "insights-check");
    until(cx, h, |_, cx| {
        ready(&view, cx) && shown_words(&view, cx) == Some("Local has no record of it yet.".into())
    });
    let resent = sent(&posts(&s));
    assert_eq!(
        resent, first,
        "Check resends exactly the saved envelope once"
    );
    retained(cx, &view);
    assert_eq!(known(cx, &view), [fx::OLD]);
    assert_eq!(
        operation_posts(&s),
        3,
        "the enable, then this one envelope twice"
    );

    // Close and restart: nothing is resent; then the exact accepted receipt settles it.
    close(cx, h);
    drop(p);
    let root = unmount(cx, m);
    m = mount_with(cx, &s, width, ThemeMode::Light, None, Some(root));
    let (h, view) = (m.h, m.view.clone());
    from_automations(cx, h, &view);
    status_reads_only(&s, &envelope);
    retained(cx, &view);
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
    click(cx, h, "insights-check");
    until(cx, h, |_, cx| {
        ready(&view, cx)
            && shown_words(&view, cx) == Some("Replaced".into())
            && view
                .read(cx)
                .insights_book
                .as_ref()
                .and_then(|b| b.insights.get(&slot))
                .is_some_and(|a| a.state == State::Accepted)
    });
    status_reads_only(&s, &envelope);
    assert_eq!(known(cx, &view), [fx::SUCCESSOR]);

    // The replacement's present blocker outranks everything else; the old enable is only
    // read, and its historical Unknown never takes over the panel.
    for (current, reason) in [
        ("blocked", "successor_stop_or_authority_changed"),
        ("partial", "successor_schedule_unresolved_or_changed"),
    ] {
        close(cx, m.h);
        let root = unmount(cx, m);
        let mut now = fx::status(
            &op,
            "accepted",
            fx::progress(&op, "replaced"),
            current,
            Some(reason),
        );
        now["supersession"] = fx::link("project-A", "mission-A", 2);
        s.reply(STATUS, Reply::json(200, now));
        m = mount_with(cx, &s, width, ThemeMode::Light, None, Some(root));
        let (h, view) = (m.h, m.view.clone());
        from_automations(cx, h, &view);
        let p = panel(cx, &view);
        assert_eq!(
            shown(cx, &view),
            (
                "settled",
                Some(crate::insights_replace::reason_text(reason).into())
            ),
            "{current}"
        );
        let old = cx.update(|cx| p.read(cx).probe_enable_status()).unwrap();
        assert!(old.report_missing(), "the old enable was read: {old:?}");
        assert!(status_reads_only(&s, &envelope) >= 1, "and only read");
        assert_eq!(known(cx, &view), [fx::SUCCESSOR]);
        cx.update_window(h, |_, w, _| {
            assert!(w.try_find("insights-enable-again").is_some());
            assert!(w.try_find("insights-replace-open-chat").is_none());
            assert!(w.try_find("insights-unconfirmed").is_none());
            contained(w, width);
        })
        .unwrap();
        shot(cx, h, dir, &format!("current-{current}"));
        if current == "blocked" {
            // Set up again is a fresh check pinned to the successor; nothing is sent.
            let mut unusable = weekly::blocked(
                "project-A",
                "mission-A",
                json!({"state":"available","id":weekly::TERRA}),
                "report_chat_unavailable",
            );
            unusable["targetId"] = json!(fx::SUCCESSOR);
            s.reply(&pinned(fx::SUCCESSOR), Reply::json(200, unusable));
            let checks = gets(&s, &pinned(fx::SUCCESSOR));
            let old_checks = gets(&s, &pinned(fx::OLD));
            click(cx, h, "insights-enable-again");
            until(cx, h, |_, cx| {
                p.read(cx).probe_ready() && p.read(cx).probe_gate() == Some("checked")
            });
            assert!(gets(&s, &pinned(fx::SUCCESSOR)) > checks);
            assert_eq!(
                gets(&s, &pinned(fx::OLD)),
                old_checks,
                "the old pin isn't read again"
            );
            cx.update_window(h, |_, w, _| {
                assert!(w.try_find("insights-replace-open").is_none());
                assert_eq!(w.find("insights-enable-confirm").disabled(), Some(true));
            })
            .unwrap();
            passive_only(&s);
        }
    }
    assert_eq!(operation_posts(&s), 3, "nothing more was ever sent");
    let h = m.h;
    close(cx, h);
    let root = unmount(cx, m);
    let _ = std::fs::remove_dir_all(root);
    println!(
        "insights replace 1100 Light: double confirmation, malformed ACKs, retained Unknown, same-envelope Check, restart, acceptance and current Blocked/Partial beside the old enable's Unknown passed"
    );
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

    // A successor snapshot for another home is refused by the re-read itself.
    let mut elsewhere = snapshot.clone();
    elsewhere["expectedHome"]["daemonId"] = json!("other-daemon");
    s.reply(&settings, Reply::json(200, elsewhere));
    click(cx, h, "insights-replace-retry");
    check(cx, h);
    assert!(!cx.update(|cx| p.read(cx).probe_adopted()));
    assert_eq!(
        cx.update(|cx| p.read(cx).probe_successor_refusal())
            .as_deref(),
        Some("The new report chat couldn't be confirmed. Nothing was adopted.")
    );
    assert_eq!(known(cx, &view), [fx::OLD], "another home moves no pin");

    // An exact but slow re-read never lands in the newer step that overtook it.
    let reads = gets(&s, &settings);
    s.reply(
        &settings,
        Reply {
            delay_ms: 1_500,
            ..Reply::json(200, snapshot.clone())
        },
    );
    click(cx, h, "insights-replace-retry");
    let slow = std::time::Instant::now();
    until(cx, h, |_, _| gets(&s, &settings) > reads);
    click(cx, h, "insights-replace-back");
    let mut fenced = fx::blocked(
        "project-A",
        "mission-A",
        "replacement_pending_use_status",
        "bounded",
    );
    fenced["supersession"] = fx::link("project-A", "mission-A", 1);
    s.reply(&preview_path(None), Reply::json(200, fenced));
    click(cx, h, "insights-replace-open");
    check(cx, h);
    std::thread::sleep(Duration::from_millis(1_800).saturating_sub(slow.elapsed()));
    settle(cx, h);
    assert_eq!(
        cx.update(|cx| p.read(cx).probe_replace_gate()),
        Some("checked"),
        "the newer step keeps its own fenced preview"
    );
    assert!(!cx.update(|cx| p.read(cx).probe_adopted()));
    assert_eq!(
        known(cx, &view),
        [fx::OLD],
        "an overtaken re-read moves no pin"
    );
    assert!(posts(&s).is_empty(), "re-reads write nothing");

    // The exact re-read adopts it: pins move, and the next check pins the successor.
    s.reply(
        &preview_path(None),
        Reply::json(200, fx::replaced("project-A", "mission-A")),
    );
    s.reply(&settings, Reply::json(200, snapshot.clone()));
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

    // Close and reopen: the open panel keeps the adoption; its pinned check uses the
    // successor, and nothing is written.
    close(cx, h);
    let successor_checks = gets(&s, &pinned(fx::SUCCESSOR));
    let old_checks = gets(&s, &pinned(fx::OLD));
    from_automations(cx, h, &view);
    assert_eq!(known(cx, &view), [fx::SUCCESSOR]);
    assert!(gets(&s, &pinned(fx::SUCCESSOR)) > successor_checks);
    assert_eq!(
        gets(&s, &pinned(fx::OLD)),
        old_checks,
        "the old pin isn't read again"
    );
    passive_only(&s);
    close(cx, h);
    drop(p);
    let root = unmount(cx, m);

    // Restart: the adoption lived in the open panel only. The old pin is back until the
    // exact link is re-derived and the successor's own settings admit it on this home.
    let mut superseded = weekly::blocked(
        "project-A",
        "mission-A",
        json!({"state":"unavailable","reason":"catalog_unavailable"}),
        "report_superseded_use_replacement_status",
    );
    superseded["targetId"] = json!(fx::OLD);
    s.reply(&pinned(fx::OLD), Reply::json(200, superseded));
    let m = mount_with(cx, &s, width, ThemeMode::Light, None, Some(root));
    let (h, view) = (m.h, m.view.clone());
    from_automations(cx, h, &view);
    assert_eq!(known(cx, &view), [fx::OLD]);
    assert_eq!(
        enable_shown(cx, &view),
        (
            "settled",
            Some(crate::insights_enable::reason_text("report_identity_unavailable").into())
        )
    );
    click(cx, h, "insights-enable-again");
    let p = panel(cx, &view);
    until(cx, h, |w, cx| {
        p.read(cx).probe_ready() && w.try_find("insights-replace-open").is_some()
    });
    // Leaving before a slow exact re-read lands adopts nothing.
    s.reply(
        &preview_path(None),
        Reply::json(200, fx::replaced("project-A", "mission-A")),
    );
    s.reply(
        &settings,
        Reply {
            delay_ms: 1_500,
            ..Reply::json(200, snapshot.clone())
        },
    );
    let reads = gets(&s, &settings);
    click(cx, h, "insights-replace-open");
    let slow = std::time::Instant::now();
    until(cx, h, |_, _| gets(&s, &settings) > reads);
    click(cx, h, "insights-replace-back");
    std::thread::sleep(Duration::from_millis(1_800).saturating_sub(slow.elapsed()));
    settle(cx, h);
    assert!(!cx.update(|cx| p.read(cx).probe_adopted()));
    assert_eq!(
        known(cx, &view),
        [fx::OLD],
        "a re-read after Back moves no pin"
    );
    cx.update_window(h, |_, w, _| {
        assert!(w.try_find("insights-replace-open").is_some())
    })
    .unwrap();
    // Re-derived: the exact completed link, then the successor's current settings.
    s.reply(&settings, Reply::json(200, snapshot));
    let successor_checks = gets(&s, &pinned(fx::SUCCESSOR));
    click(cx, h, "insights-replace-open");
    until(cx, h, |_, cx| {
        p.read(cx).probe_adopted() && p.read(cx).probe_ready()
    });
    assert_eq!(known(cx, &view), [fx::SUCCESSOR]);
    until(cx, h, |_, _| {
        gets(&s, &pinned(fx::SUCCESSOR)) > successor_checks
    });
    cx.update_window(h, |_, w, _| {
        assert!(w.try_find("insights-replace-open-chat").is_some());
        contained(w, width);
    })
    .unwrap();
    passive_only(&s);
    assert_eq!(
        operation_posts(&s),
        1,
        "only the original enable was ever sent"
    );
    close(cx, h);
    drop(p);
    let root = unmount(cx, m);
    let _ = std::fs::remove_dir_all(root);

    // An older Local without the replacement interface: the blocker offers nothing new.
    // This path also keeps the distinct Blocked status of a present but unusable report.
    let s = server();
    let m = deleted_as(cx, &s, width, ThemeMode::Light, "blocked");
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
        "insights replace 1100 Light: unqualified old home, untrusted rule, malformed copied grant, fence-only link, mismatched/other-home/overtaken successor re-reads, exact adoption across close, reopen and restart, older Local over a Blocked old enable and rejection passed"
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
