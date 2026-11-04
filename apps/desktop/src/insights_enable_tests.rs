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
        json!({"phase":"chat_ready"}),
        "partial",
        Some("schedule_unresolved"),
    );
    let s = status(&pending, &op).unwrap();
    assert_eq!(s.receipt, Receipt::Pending(Some(Phase::ChatReady)));
    assert_eq!(s.current, Current::Partial);
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
