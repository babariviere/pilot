use super::{fixture as f, *};
use crate::insights::{Attempt, Request, State};
use serde_json::{Value, json};

fn host() -> Host {
    Host {
        host_id: "local".into(),
        daemon_id: "test-daemon".into(),
        lineage_id: "test-lineage".into(),
    }
}
fn backlog() -> Backlog {
    Backlog {
        project_id: "project-A".into(),
        mission_id: "mission-A".into(),
        title: None,
        report: None,
    }
}
fn parse(v: &Value) -> Result<Preflight, Failure> {
    preflight(v, &backlog(), &host(), None)
}
fn operation(payload: String) -> Operation {
    let h = host();
    Operation {
        schema_version: 1,
        operation_id: "0d8f0f5e-3b6c-4f7a-9d1e-2a3b4c5d6e7f".into(),
        producer_id: "producer".into(),
        sequence: 3,
        origin: h.clone(),
        destination: h,
        kind: KIND.into(),
        target_id: f::TARGET.into(),
        payload_hash: crate::delivery_store::hash(&payload),
        payload,
    }
}

#[test]
fn ready_preflight_freezes_the_host_payload_exactly() {
    let v = f::ready("project-A", "mission-A", f::TERRA);
    let pf = parse(&v).unwrap();
    assert_eq!(pf.readiness, Readiness::Ready);
    assert_eq!(pf.model, Model::Available(f::TERRA.into()));
    let frozen = pf.frozen.clone().unwrap();
    // Same JSON value, no added or dropped key, hostId kept as the host wrote it.
    assert_eq!(
        serde_json::from_str::<Value>(&frozen.text).unwrap(),
        v["payload"]
    );
    assert_eq!((frozen.bounds, frozen.budget_usd), ((1, 2, 4), 5.));
    assert_eq!(frozen.recurrence.weekday, Some(5));
    let Some(Request::Enable {
        payload,
        target_id,
        mission_id,
        ..
    }) = pf.request()
    else {
        panic!("a ready preflight is confirmable");
    };
    assert_eq!(
        (payload, target_id.as_str(), mission_id.as_str()),
        (frozen.text, f::TARGET, "mission-A")
    );
}

#[test]
fn blocked_or_malformed_preflight_is_never_confirmable() {
    let blocked = parse(&f::blocked(
        "project-A",
        "mission-A",
        json!({"state":"unavailable","reason":"not_found"}),
        "model_unavailable",
    ))
    .unwrap();
    assert!(blocked.request().is_none());
    assert_eq!(blocked.model, Model::Unavailable("not_found".into()));
    let ambiguous = parse(&f::blocked(
        "project-A",
        "mission-A",
        json!({"state":"ambiguous","ids":["a/terra-6.1","b/terra-6.1"]}),
        "model_ambiguous",
    ))
    .unwrap();
    assert_eq!(
        ambiguous.model,
        Model::Ambiguous(vec!["a/terra-6.1".into(), "b/terra-6.1".into()])
    );
    let good = f::ready("project-A", "mission-A", f::TERRA);
    type Mutation = Box<dyn Fn(&mut Value)>;
    let mutations: Vec<Mutation> = vec![
        Box::new(|v| v["state"] = json!("blocked")),
        Box::new(|v| v["payload"] = Value::Null),
        Box::new(|v| v["payload"]["extra"] = json!(1)),
        Box::new(|v| v["payload"]["scope"]["includeArchived"] = json!(false)),
        Box::new(|v| v["payload"]["budget"]["enforcement"] = json!("hard")),
        Box::new(|v| v["payload"]["disclosure"] = json!("insights-history-v1")),
        Box::new(|v| v["payload"]["expectedHome"]["daemonId"] = json!("other")),
        Box::new(|v| v["payload"]["missionId"] = json!("mission-B")),
        Box::new(|v| v["model"]["id"] = json!("anthropic/sol")),
        Box::new(|v| v["missionId"] = json!("mission-B")),
        Box::new(|v| v["cost"]["spendUsd"] = json!(0)),
        Box::new(
            |v| v["payload"]["chat"] = json!({"sessionId":"other","grantId":"g","revision":1,"inputGeneration":0,"model":f::TERRA}),
        ),
    ];
    for (ix, mutate) in mutations.iter().enumerate() {
        let mut v = good.clone();
        mutate(&mut v);
        assert!(parse(&v).is_err(), "mutation {ix} must be refused");
    }
}

#[test]
fn explicit_model_choice_survives_only_when_the_host_honors_it() {
    let v = f::ready("project-A", "mission-A", "b/terra-6.1");
    assert!(preflight(&v, &backlog(), &host(), Some("b/terra-6.1")).is_ok());
    // A late reply for another choice never replaces the explicit one.
    assert!(preflight(&v, &backlog(), &host(), Some("a/terra-6.1")).is_err());
    // An existing chat keeps its own model; the explicit choice is not applied.
    let mut existing = v.clone();
    existing["payload"]["chat"] = json!({"sessionId":f::TARGET,"grantId":"g","revision":2,"inputGeneration":1,"model":"b/terra-6.1"});
    existing["payload"]["schedule"] = json!({"id":"rule-1","revision":4});
    existing["state"] = json!("existing");
    let pf = preflight(&existing, &backlog(), &host(), None).unwrap();
    let frozen = pf.frozen.unwrap();
    assert_eq!(
        (frozen.chat.as_deref(), frozen.reuses_schedule),
        (Some(f::TARGET), true)
    );
}

#[test]
fn enable_attempt_round_trips_through_private_state() {
    let pf = parse(&f::ready("project-A", "mission-A", f::TERRA)).unwrap();
    let request = pf.request().unwrap();
    assert_eq!(request.slot(), "enable:mission-A");
    assert_eq!(request.kind(), KIND);
    request.validate().unwrap();
    let op = operation(request.payload());
    let attempt = Attempt {
        slot: request.slot(),
        operation: op.clone(),
        state: State::Unknown,
        reason: None,
        result: None,
    };
    attempt.validate("enable:mission-A").unwrap();
    assert!(attempt.validate("enable:mission-B").is_err());
    let accepted = Attempt {
        state: State::Accepted,
        result: Some(f::enabled(&op)),
        ..attempt.clone()
    };
    accepted.validate("enable:mission-A").unwrap();
    // Admission alone, without both resources, is not a valid accepted result.
    let partial = Attempt {
        result: Some(
            json!({"phase":"chat_ready","sessionId":f::TARGET,"scheduleId":"r","chat":null}),
        ),
        ..accepted
    };
    assert!(partial.validate("enable:mission-A").is_err());
}

#[test]
fn status_belongs_to_the_exact_envelope() {
    let pf = parse(&f::ready("project-A", "mission-A", f::TERRA)).unwrap();
    let op = operation(pf.frozen.unwrap().text);
    let s = status(
        &f::status(&op, "unknown", Value::Null, "not_found", None),
        &op,
    )
    .unwrap();
    assert_eq!(
        (s.receipt.clone(), s.current),
        (Receipt::Unknown, Current::NotFound)
    );
    let pending = f::status(
        &op,
        "pending",
        f::progress(&op, "chat_ready"),
        "partial",
        Some("schedule_unresolved"),
    );
    let s = status(&pending, &op).unwrap();
    assert_eq!(s.receipt, Receipt::Pending(Some(Phase::ChatReady)));
    assert_eq!(s.current, Current::Partial);
    // An entered fresh-chat step has no committed chat yet.
    let entered = f::status(
        &op,
        "pending",
        f::progress(&op, "chat_pending"),
        "unknown",
        None,
    );
    assert_eq!(
        status(&entered, &op).unwrap().receipt,
        Receipt::Pending(Some(Phase::ChatPending))
    );
    let enabled = status(
        &f::status(&op, "accepted", f::enabled(&op), "enabled", None),
        &op,
    )
    .unwrap();
    assert_eq!(
        (enabled.current, enabled.next_at.is_some()),
        (Current::Enabled, true)
    );
    // Another operation's receipt, or enabled without an accepted receipt, is malformed.
    let mut other = f::status(&op, "accepted", f::enabled(&op), "enabled", None);
    other["receipt"]["payloadHash"] = json!("0".repeat(64));
    assert!(status(&other, &op).is_err());
    assert!(
        status(
            &f::status(&op, "pending", Value::Null, "enabled", None),
            &op
        )
        .is_err()
    );
    let mut elsewhere = f::status(&op, "unknown", Value::Null, "not_found", None);
    elsewhere["sessionId"] = json!("another");
    assert!(status(&elsewhere, &op).is_err());
}

/// The host's lost schedule ACK (insights-enable.test.ts): the rule was placed, the receipt
/// stays pending at its `schedule_pending` marker and the present status is enabled.
#[test]
fn lost_schedule_ack_is_enabled_while_its_receipt_stays_pending() {
    let pf = parse(&f::ready("project-A", "mission-A", f::TERRA)).unwrap();
    let op = operation(pf.frozen.unwrap().text);
    let lost = f::status(
        &op,
        "pending",
        f::progress(&op, "schedule_pending"),
        "enabled",
        None,
    );
    let s = status(&lost, &op).unwrap();
    assert_eq!(s.receipt, Receipt::Pending(Some(Phase::SchedulePending)));
    assert_eq!(
        (s.current, s.schedule_id.as_deref(), s.next_at),
        (Current::Enabled, Some(f::SCHEDULE), Some(f::NEXT))
    );
    // Check adopts the receipt as it is: still pending, never an invented acceptance.
    assert_eq!(
        crate::insights::adopt(&op, &lost["receipt"]),
        Outcome::Pending
    );
    // Reused chat and rule: an earlier entered marker can also see both resources.
    let reused = f::status(
        &op,
        "pending",
        f::progress(&op, "chat_ready"),
        "enabled",
        None,
    );
    assert_eq!(status(&reused, &op).unwrap().current, Current::Enabled);
    // Later: recovery accepts it; later still, a revoke or edit blocks the same receipt.
    let accepted = status(
        &f::status(&op, "accepted", f::enabled(&op), "enabled", None),
        &op,
    )
    .unwrap();
    assert_eq!(
        (accepted.receipt, accepted.current),
        (Receipt::Accepted, Current::Enabled)
    );
    for receipt in ["pending", "accepted"] {
        let result = if receipt == "pending" {
            f::progress(&op, "schedule_pending")
        } else {
            f::enabled(&op)
        };
        let blocked = status(
            &f::status(
                &op,
                receipt,
                result,
                "blocked",
                Some("report_chat_unavailable"),
            ),
            &op,
        )
        .unwrap();
        assert_eq!(
            (blocked.current, blocked.reason.as_deref()),
            (Current::Blocked, Some("report_chat_unavailable"))
        );
    }
    // Contradictions and other identities stay refused.
    type Mutation = Box<dyn Fn(&mut Value)>;
    let other = "9a8b7c6d-5e4f-5a3b-8c2d-1e0f9a8b7c6d";
    let mutations: Vec<Mutation> = vec![
        Box::new(|v| v["receipt"]["result"] = Value::Null),
        Box::new(|v| {
            v["receipt"].as_object_mut().unwrap().remove("result");
        }),
        Box::new(|v| v["receipt"]["result"] = json!({"phase":"schedule_pending"})),
        Box::new(|v| v["receipt"]["result"]["phase"] = json!("enabled")),
        Box::new(|v| v["receipt"]["result"]["phase"] = json!("scheduled")),
        Box::new(|v| v["receipt"]["result"]["sessionId"] = json!("another")),
        Box::new(move |v| v["receipt"]["result"]["scheduleId"] = json!(other)),
        Box::new(move |v| v["scheduleId"] = json!(other)),
        Box::new(|v| v["scheduleId"] = Value::Null),
        Box::new(|v| v["receipt"]["result"]["chat"] = Value::Null),
        Box::new(|v| v["receipt"]["result"]["chat"]["sessionId"] = json!("another")),
        Box::new(|v| v["receipt"]["result"]["chat"]["model"] = json!("anthropic/sol")),
        Box::new(|v| v["receipt"]["payloadHash"] = json!("0".repeat(64))),
        Box::new(move |v| v["receipt"]["operationId"] = json!(other)),
        Box::new(|v| v["receipt"]["destination"]["lineageId"] = json!("other-lineage")),
        Box::new(|v| v["receipt"]["targetId"] = json!("another")),
        Box::new(|v| v["receipt"] = json!({"state":"unknown"})),
        Box::new(|v| {
            v["receipt"]["state"] = json!("rejected");
            v["receipt"]["reason"] = json!("refused");
        }),
        Box::new(|v| v["sessionId"] = json!("another")),
    ];
    for (ix, mutate) in mutations.iter().enumerate() {
        let mut v = lost.clone();
        mutate(&mut v);
        assert!(status(&v, &op).is_err(), "mutation {ix} must be refused");
    }
}

#[test]
fn backlog_choices_are_active_local_definitions_only() {
    let catalog =
        crate::mission_browser::catalog(&crate::mission_browser_fixture::catalog()).unwrap();
    let local = crate::mission_browser_fixture::home();
    let all = backlogs(&catalog, &local);
    let ids: Vec<_> = all
        .iter()
        .map(|b| (b.project_id.as_str(), b.mission_id.as_str()))
        .collect();
    assert_eq!(
        ids,
        [("project-A", "mission-A"), ("project-B", "mission-B")]
    );
}

#[test]
fn reasons_stay_short_and_unknown_codes_stay_generic() {
    assert!(reason_text("model_unavailable").contains("Terra 6.1"));
    // Several admission failures share this code: the words name no cause.
    let unavailable = reason_text("report_chat_unavailable");
    assert!(
        ["archiv", "revok", "delet", "access"]
            .iter()
            .all(|cause| !unavailable.to_lowercase().contains(cause)),
        "{unavailable}"
    );
    assert_ne!(unavailable, reason_text("setup_unavailable"));
    assert_eq!(
        reason_text("something_new"),
        reason_text("setup_unavailable")
    );
    assert!(supported(&json!({"capabilities":{"insightsEnable":1}})));
    assert!(!supported(&json!({"capabilities":{"insights":1}})));
    assert!(!automations_on(&json!({"capabilities":{}})));
}

#[test]
fn a_pinned_report_refuses_any_substitute() {
    let pinned = Backlog {
        report: Some("report-1".into()),
        ..backlog()
    };
    // A fresh target instead of the known report is refused, not confirmable.
    let fresh = f::ready("project-A", "mission-A", f::TERRA);
    assert_eq!(preflight(&fresh, &pinned, &host(), None), Err(SUBSTITUTE));
    let reuse = f::offer(
        "project-A",
        "mission-A",
        f::TERRA,
        "report-1",
        f::chat("report-1", f::TERRA),
        Value::Null,
    );
    assert!(
        preflight(&reuse, &pinned, &host(), None)
            .unwrap()
            .request()
            .is_some()
    );
    let blocked = f::blocked(
        "project-A",
        "mission-A",
        json!({"state":"unavailable","reason":"not_found"}),
        "report_identity_unavailable",
    );
    let mut blocked = blocked;
    blocked["targetId"] = json!("report-1");
    let pf = preflight(&blocked, &pinned, &host(), None).unwrap();
    assert!(pf.request().is_none());
    assert!(reason_text("report_identity_unavailable").contains("Nothing new"));
}
/// After deletion the host keeps the accepted receipt but reports present state Unknown with
/// `report_identity_unavailable` (insights-enable.ts status). Only that exact shape lets the
/// user ask for a fresh pinned check; pending, unrelated or mismatched states never do.
#[test]
fn only_an_accepted_missing_report_leads_to_a_fresh_check() {
    let pf = parse(&f::ready("project-A", "mission-A", f::TERRA)).unwrap();
    let op = operation(pf.frozen.unwrap().text);
    const MISSING: Option<&str> = Some("report_identity_unavailable");
    let deleted = f::status(&op, "accepted", f::enabled(&op), "unknown", MISSING);
    let s = status(&deleted, &op).unwrap();
    assert_eq!(
        (&s.receipt, s.current, s.reason.as_deref(), s.next_at),
        (&Receipt::Accepted, Current::Unknown, MISSING, None)
    );
    assert_eq!(s.schedule_id.as_deref(), Some(f::SCHEDULE));
    assert!(s.report_missing());
    // A report present but unusable stays Blocked, a separate path.
    let present = f::status(&op, "accepted", f::enabled(&op), "blocked", MISSING);
    assert!(!status(&present, &op).unwrap().report_missing());
    // Unrelated Unknown states keep Check only.
    for reason in [
        None,
        Some("schedule_unresolved"),
        Some("report_chat_unavailable"),
    ] {
        let other = f::status(&op, "accepted", f::enabled(&op), "unknown", reason);
        assert!(!status(&other, &op).unwrap().report_missing(), "{reason:?}");
    }
    // Pending or unresolved receipts stay status-only, whatever the present state says.
    for (phase, result) in [
        ("chat_pending", f::progress(&op, "chat_pending")),
        ("schedule_pending", f::progress(&op, "schedule_pending")),
        ("none", Value::Null),
    ] {
        let pending = f::status(&op, "pending", result, "unknown", MISSING);
        assert!(!status(&pending, &op).unwrap().report_missing(), "{phase}");
    }
    // No receipt at all, or one for other bytes, is never this shape.
    assert!(
        status(
            &f::status(&op, "unknown", Value::Null, "unknown", MISSING),
            &op
        )
        .is_err()
    );
    let mut foreign = deleted.clone();
    foreign["receipt"]["payloadHash"] = json!("0".repeat(64));
    assert!(status(&foreign, &op).is_err());
    let mut elsewhere = deleted;
    elsewhere["sessionId"] = json!("another");
    assert!(status(&elsewhere, &op).is_err());
}
