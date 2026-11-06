use super::{fixture as f, *};
use crate::insights::{Attempt, Outcome, State};
use serde_json::{Value, json};

fn host() -> Host {
    Host {
        host_id: "local".into(),
        daemon_id: "test-daemon".into(),
        lineage_id: "test-lineage".into(),
    }
}
fn operation(kind: &str, payload: String) -> Operation {
    let h = host();
    Operation {
        schema_version: 1,
        operation_id: "0d8f0f5e-3b6c-4f7a-9d1e-2a3b4c5d6e7f".into(),
        producer_id: "producer".into(),
        sequence: 3,
        origin: h.clone(),
        destination: h,
        kind: kind.into(),
        target_id: f::REPORT.into(),
        payload_hash: crate::delivery_store::hash(&payload),
        payload,
    }
}
type Edit = Box<dyn Fn(&mut Value)>;
fn snap(v: &Value) -> Result<Snapshot, Failure> {
    snapshot(v, f::REPORT, &host())
}
fn weekly(day: u8, time: &str) -> Value {
    json!({"every":"week","weekday":day,"time":time,"timeZone":"Europe/Paris"})
}

#[test]
fn snapshot_parses_exactly_and_refuses_malformed_or_foreign_values() {
    let v = f::snapshot(0, f::settings(f::TERRA), f::TERRA);
    let s = snap(&v).unwrap();
    assert_eq!(
        (
            s.revision,
            s.chat.model.as_str(),
            s.chat.thinking.as_deref()
        ),
        (0, f::TERRA, None)
    );
    assert_eq!(s.model, Model::Available(f::TERRA.into()));
    assert_eq!(
        s.settings.to_value(),
        f::settings(f::TERRA),
        "round trip is the host's value"
    );
    assert_eq!(
        (
            s.settings.bounds,
            s.settings.budget_usd,
            s.settings.projects.clone()
        ),
        ((1, 2, 4), 5., None)
    );

    let bad: Vec<Edit> = vec![
        Box::new(|v| v["extra"] = json!(1)),
        Box::new(|v| v["expectedHome"]["lineageId"] = json!("other")),
        Box::new(|v| v["cost"]["spendUsd"] = json!(0)),
        Box::new(|v| v["activationRequired"] = json!(false)),
        Box::new(|v| v["chat"]["sessionId"] = json!("report-2")),
        Box::new(|v| v["settings"]["recurrence"]["every"] = json!("day")),
        Box::new(|v| v["settings"]["recurrence"]["time"] = json!("24:00")),
        Box::new(|v| v["settings"]["bounds"]["historyPages"] = json!(1)),
        Box::new(|v| v["settings"]["bounds"]["inventoryPages"] = json!(5)),
        Box::new(|v| v["settings"]["budget"]["usd"] = json!(0)),
        Box::new(|v| v["settings"]["budget"]["enforcement"] = json!("cap")),
        Box::new(|v| v["settings"]["scope"]["projects"] = json!(["a", "a"])),
        Box::new(|v| v["settings"]["scope"]["excludeSessions"] = json!(["not-a-uuid"])),
        Box::new(|v| v["settings"]["scope"]["sourceAccess"] = json!("write")),
        Box::new(|v| v["settings"]["extra"] = json!(true)),
        Box::new(|v| v["model"] = json!({"state":"maybe"})),
    ];
    for (i, change) in bad.iter().enumerate() {
        let mut v = v.clone();
        change(&mut v);
        assert!(snap(&v).is_err(), "malformed snapshot {i} refused");
    }
    let mut unavailable = v.clone();
    unavailable["model"] = json!({"state":"unavailable","reason":"not_found"});
    assert_eq!(
        snap(&unavailable).unwrap().model,
        Model::Unavailable("not_found".into())
    );
}

#[test]
fn save_payload_keeps_identity_verbatim_and_marks_user_budget() {
    let mut v = f::snapshot(3, f::settings(f::TERRA), f::SONNET);
    v["chat"]["thinking"] = json!("high");
    let s = snap(&v).unwrap();
    let mut edited = s.settings.clone();
    edited.weekday = 1;
    edited.time = "07:30".into();
    edited.projects = Some(vec!["project-A".into()]);
    edited.include_archived = false;
    edited.exclude_sessions = vec!["9f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f".into()];
    edited.bounds = (4, 8, 20);
    edited.budget_usd = 12.5;
    edited.monthly = true;
    edited.user_budget = true;
    let Ok(Request::Settings {
        payload,
        target_id,
        project_id,
        mission_id,
    }) = s.request(&edited)
    else {
        panic!("a valid draft is savable");
    };
    assert_eq!(
        (target_id.as_str(), project_id.as_str(), mission_id.as_str()),
        (f::REPORT, "project-A", "mission-A")
    );
    let p: Value = serde_json::from_str(&payload).unwrap();
    assert_eq!(
        p["expectedHome"], v["expectedHome"],
        "home is frozen as returned"
    );
    assert_eq!(
        p["chat"], v["chat"],
        "the report's exact fences, thinking included"
    );
    assert_eq!(p["expectedRevision"], 3);
    assert_eq!(p.as_object().unwrap().len(), 7);
    assert_eq!(p["settings"]["recurrence"], weekly(1, "07:30"));
    assert_eq!(p["settings"]["scope"]["projects"], json!(["project-A"]));
    assert_eq!(
        p["settings"]["budget"],
        json!({"usd":12.5,"period":"month","enforcement":"advisory","basis":"user_choice"})
    );
    assert!(settings_payload_ok(
        &payload,
        "project-A",
        "mission-A",
        f::REPORT
    ));
    assert!(!settings_payload_ok(
        &payload,
        "project-A",
        "mission-B",
        f::REPORT
    ));
    // The host's bounds refuse before anything is confirmed.
    let mut wrong = edited.clone();
    wrong.bounds = (1, 9, 4);
    assert!(s.request(&wrong).is_err());
    wrong = edited.clone();
    wrong.zone = "../etc".into();
    assert!(s.request(&wrong).is_err());
    wrong = edited;
    wrong.budget_usd = 10_001.;
    assert!(s.request(&wrong).is_err());
}

#[test]
fn replacement_id_matches_the_host_derivation() {
    // Node: sha256("insights-apply:report-1:4") shaped as the host's scheduleId.
    assert_eq!(
        replacement_id(f::REPORT, 4),
        "ea6ff9fa-4420-57a2-af58-45f1923771cc"
    );
}

#[test]
fn apply_preview_freezes_the_exact_payload_and_names_the_rule() {
    let mut settings = f::settings(f::TERRA);
    settings["recurrence"] = weekly(1, "07:30");
    // A fixed original rule with another cadence: cancelled and replaced.
    let v = f::ready(
        4,
        settings.clone(),
        f::TERRA,
        f::SONNET,
        f::rule(None, weekly(5, "18:00")),
    );
    let p = preview(&v, f::REPORT, &host()).unwrap();
    let fr = p.frozen.clone().unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&fr.text).unwrap(),
        v["payload"]
    );
    assert_eq!(
        (
            fr.revision,
            fr.model.as_str(),
            fr.changes_model(),
            fr.keeps_rule
        ),
        (4, f::TERRA, true, false)
    );
    assert_eq!(fr.schedule_id, replacement_id(f::REPORT, 4));
    assert_eq!(fr.rule.as_ref().unwrap().id, f::RULE);
    assert!(apply_payload_ok(
        &fr.text,
        "project-A",
        "mission-A",
        f::REPORT
    ));
    let Request::Apply { payload, .. } = fr.request(f::REPORT) else {
        panic!("apply request");
    };
    assert_eq!(payload, fr.text, "never rebuilt");

    // The same revision and cadence on the rule: kept, no new ID.
    let kept = f::ready(
        4,
        settings.clone(),
        f::TERRA,
        f::TERRA,
        f::rule(Some(4), weekly(1, "07:30")),
    );
    let fr = preview(&kept, f::REPORT, &host()).unwrap().frozen.unwrap();
    assert!(fr.keeps_rule && !fr.changes_model());
    assert_eq!(fr.schedule_id, f::RULE);
    // No rule: created.
    let none = f::ready(4, settings.clone(), f::TERRA, f::TERRA, Value::Null);
    assert!(
        preview(&none, f::REPORT, &host())
            .unwrap()
            .frozen
            .unwrap()
            .rule
            .is_none()
    );

    let blocked = preview(
        &f::blocked("Save settings before Apply"),
        f::REPORT,
        &host(),
    )
    .unwrap();
    assert!(blocked.frozen.is_none());
    assert_eq!(
        blocked.reason.as_deref(),
        Some("Save settings before Apply")
    );

    let bad: Vec<Edit> = vec![
        Box::new(|v| v["payload"]["extra"] = json!(1)),
        Box::new(|v| v["payload"]["expectedHome"]["daemonId"] = json!("other")),
        Box::new(|v| v["payload"]["record"]["revision"] = json!(0)),
        Box::new(|v| v["payload"]["record"]["model"] = json!("other/model")),
        Box::new(|v| v["payload"]["chat"]["sessionId"] = json!("report-2")),
        Box::new(|v| v["payload"]["rule"]["target"]["sessionId"] = json!("report-2")),
        Box::new(|v| v["payload"]["rule"]["paused"] = json!(true)),
        Box::new(|v| v["payload"]["rule"]["state"] = json!("dispatching")),
        Box::new(|v| v["payload"] = Value::Null),
        Box::new(|v| v["reason"] = json!("ready_with_reason")),
        Box::new(|v| v["cost"] = json!({"pricing":"known","spendUsd":1})),
    ];
    for (i, change) in bad.iter().enumerate() {
        let mut v = v.clone();
        change(&mut v);
        assert!(
            preview(&v, f::REPORT, &host()).is_err(),
            "malformed preview {i} refused"
        );
    }
}

#[test]
fn settings_receipts_match_the_frozen_save_only() {
    let s = snap(&f::snapshot(2, f::settings(f::TERRA), f::TERRA)).unwrap();
    let Ok(Request::Settings { payload, .. }) = s.request(&s.settings) else {
        panic!();
    };
    let op = operation(SETTINGS_KIND, payload);
    let good = json!({"revision":3,"settings":f::settings(f::TERRA),"model":f::TERRA});
    assert!(valid_settings_result(&op, &good));
    for bad in [
        json!({"revision":2,"settings":f::settings(f::TERRA),"model":f::TERRA}),
        json!({"revision":3,"settings":f::settings(f::SONNET),"model":f::SONNET}),
        json!({"revision":3,"settings":f::settings(f::TERRA),"model":f::SONNET}),
        json!({"revision":3,"settings":f::settings(f::TERRA),"model":f::TERRA,"extra":1}),
        json!({"sessionId":f::REPORT}),
    ] {
        assert!(!valid_settings_result(&op, &bad), "{bad}");
    }
    assert!(valid_settings_pending(None));
    assert!(valid_settings_pending(Some(
        &json!({"phase":"settings_pending"})
    )));
    assert!(!valid_settings_pending(Some(&json!({"phase":"applied"}))));

    // The shared receipt adoption refuses a pending marker for other bytes; it is never success.
    let mut receipt = f::receipt(&op, "pending", json!({"phase":"settings_pending"}));
    assert_eq!(crate::insights::adopt(&op, &receipt), Outcome::Pending);
    receipt["result"] = json!({"phase":"model_pending"});
    assert!(matches!(
        crate::insights::adopt(&op, &receipt),
        Outcome::Unknown(_)
    ));
    assert_eq!(
        crate::insights::adopt(&op, &f::receipt(&op, "accepted", good.clone())),
        Outcome::Accepted(good)
    );
    assert!(matches!(
        crate::insights::adopt(&op, &f::receipt(&op, "accepted", json!({"revision":9}))),
        Outcome::Unknown(_)
    ));
}

#[test]
fn apply_progress_matches_the_frozen_intent_only() {
    let mut settings = f::settings(f::TERRA);
    settings["recurrence"] = weekly(1, "07:30");
    let v = f::ready(
        4,
        settings,
        f::TERRA,
        f::SONNET,
        f::rule(None, weekly(5, "18:00")),
    );
    let fr = preview(&v, f::REPORT, &host()).unwrap().frozen.unwrap();
    let op = operation(APPLY_KIND, fr.text.clone());
    for phase in [
        "model_pending",
        "model_ready",
        "cancel_pending",
        "rule_cancelled",
        "schedule_pending",
    ] {
        let p = f::progress(&op, phase);
        assert!(valid_apply_pending(&op, Some(&p)), "{phase}");
        assert!(!valid_apply_result(&op, &p), "{phase} is not acceptance");
    }
    let applied = f::progress(&op, "applied");
    assert!(valid_apply_result(&op, &applied));
    assert!(!valid_apply_pending(&op, Some(&applied)));
    assert!(valid_apply_pending(&op, None));
    let bad: Vec<Edit> = vec![
        Box::new(|r| r["scheduleId"] = json!(f::RULE)),
        Box::new(|r| r["settingsRevision"] = json!(3)),
        Box::new(|r| r["chat"]["sessionId"] = json!("report-2")),
        Box::new(|r| r["chat"]["model"] = json!(f::SONNET)),
        Box::new(|r| r["chat"]["grantId"] = json!("grant-2")),
        Box::new(|r| r["cancelledRule"]["id"] = json!("other-rule")),
        Box::new(|r| r["sessionId"] = json!(f::REPORT)),
    ];
    for (i, change) in bad.iter().enumerate() {
        let mut r = applied.clone();
        change(&mut r);
        assert!(
            !valid_apply_result(&op, &r),
            "malformed progress {i} refused"
        );
    }
    // Before the model step settles, the chat must still be the confirmed one.
    let mut early = f::progress(&op, "model_pending");
    early["chat"]["model"] = json!(f::TERRA);
    assert!(!valid_apply_pending(&op, Some(&early)));
    assert!(matches!(
        crate::insights::adopt(&op, &f::receipt(&op, "pending", early)),
        Outcome::Unknown(_)
    ));
}

#[test]
fn retained_attempts_round_trip_and_refuse_edits() {
    let s = snap(&f::snapshot(0, f::settings(f::TERRA), f::TERRA)).unwrap();
    let request = s.request(&s.settings).unwrap();
    let op = operation(SETTINGS_KIND, request.payload());
    let attempt = Attempt {
        slot: settings_slot(f::REPORT),
        operation: op.clone(),
        state: State::Unknown,
        reason: None,
        result: None,
    };
    assert_eq!(request.slot(), attempt.slot);
    attempt.validate(&attempt.slot).unwrap();
    let mut wrong_slot = attempt.clone();
    wrong_slot.slot = apply_slot(f::REPORT);
    assert!(wrong_slot.validate(&wrong_slot.slot).is_err());
    let mut accepted = attempt;
    accepted.state = State::Accepted;
    accepted.result = Some(json!({"revision":1,"settings":f::settings(f::TERRA),"model":f::TERRA}));
    accepted.validate(&accepted.slot).unwrap();
    accepted.result = Some(json!({"revision":2,"settings":f::settings(f::TERRA),"model":f::TERRA}));
    assert!(accepted.validate(&accepted.slot).is_err());

    let v = f::ready(
        1,
        f::settings(f::TERRA),
        f::TERRA,
        f::TERRA,
        f::rule(None, weekly(5, "18:00")),
    );
    let fr = preview(&v, f::REPORT, &host()).unwrap().frozen.unwrap();
    let op = operation(APPLY_KIND, fr.text.clone());
    assert_eq!(Frozen::from_operation(&op).unwrap(), fr);
    let apply = Attempt {
        slot: apply_slot(f::REPORT),
        operation: op,
        state: State::Pending,
        reason: None,
        result: None,
    };
    apply.validate(&apply.slot).unwrap();
}

#[test]
fn capabilities_need_both_interfaces() {
    assert!(supported(
        &json!({"capabilities":{"insightsSettings":1,"insightsApply":1}})
    ));
    assert!(!supported(&json!({"capabilities":{"insightsSettings":1}})));
    assert!(!supported(&json!({"capabilities":{"insightsApply":1}})));
}
