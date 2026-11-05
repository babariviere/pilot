use super::{fixture as f, *};
use crate::insights::{Attempt, Request, State as Saved};
use crate::insights_enable::fixture as weekly_fx;
use serde_json::{Value, json};

fn host() -> Host {
    Host {
        host_id: "local".into(),
        daemon_id: "test-daemon".into(),
        lineage_id: "test-lineage".into(),
    }
}
fn parse(v: &Value) -> Result<Preview, Failure> {
    preview(v, "project-A", "mission-A", f::OLD, &host(), None)
}
fn operation(payload: String) -> Operation {
    let h = host();
    Operation {
        schema_version: 1,
        operation_id: "6e7f8091-a2b3-4c4d-9e5f-60718293a4b5".into(),
        producer_id: "producer".into(),
        sequence: 7,
        origin: h.clone(),
        destination: h,
        kind: KIND.into(),
        target_id: f::SUCCESSOR.into(),
        payload_hash: crate::delivery_store::hash(&payload),
        payload,
    }
}
fn ready_op() -> Operation {
    let pf = parse(&f::ready("project-A", "mission-A", weekly_fx::TERRA)).unwrap();
    operation(pf.frozen.unwrap().text)
}

#[test]
fn ready_preview_freezes_the_host_payload_exactly() {
    let v = f::ready("project-A", "mission-A", weekly_fx::TERRA);
    let pf = parse(&v).unwrap();
    assert_eq!(pf.state, State::Ready);
    let frozen = pf.frozen.clone().unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&frozen.text).unwrap(),
        v["payload"]
    );
    assert_eq!(
        (frozen.old.as_str(), frozen.successor.as_str()),
        (f::OLD, f::SUCCESSOR)
    );
    // Fresh fixed weekly settings, not copied ones: no chat, no reused rule.
    assert!(frozen.enable.chat.is_none() && !frozen.enable.reuses_schedule);
    assert_eq!(
        (frozen.enable.bounds, frozen.enable.budget_usd),
        ((1, 2, 4), 5.)
    );
    let dispositions: Vec<_> = frozen.rules.iter().map(|r| r.disposition).collect();
    assert_eq!(dispositions, [Disposition::Cancel, Disposition::Keep]);
    let Some(Request::Replace {
        old_id,
        target_id,
        payload,
        ..
    }) = pf.request()
    else {
        panic!("a ready preview is confirmable");
    };
    assert_eq!(
        (old_id.as_str(), target_id.as_str()),
        (f::OLD, f::SUCCESSOR)
    );
    assert_eq!(payload, frozen.text);
    let request = pf.request().unwrap();
    assert_eq!(request.slot(), format!("replace:{}", f::OLD));
    assert_eq!(request.kind(), KIND);
    assert!(request.validate().is_ok());
}

#[test]
fn blocked_stale_or_malformed_previews_are_never_confirmable() {
    for (reason, coverage) in [
        ("old_identity_home_unqualified", "bounded"),
        ("old_operation_pending_use_receipt", "bounded"),
        ("rule_overflow", "overflow"),
        ("replacement_observation_unavailable", "unavailable"),
    ] {
        let pf = parse(&f::blocked("project-A", "mission-A", reason, coverage)).unwrap();
        assert_eq!(
            (pf.state, pf.reason.as_deref()),
            (State::Blocked, Some(reason))
        );
        assert!(pf.request().is_none(), "{reason}");
    }
    let ready = f::ready("project-A", "mission-A", weekly_fx::TERRA);
    let mut cases: Vec<Value> = Vec::new();
    // Another backlog, another old identity, an added key, a changed home.
    let mut v = ready.clone();
    v["missionId"] = json!("mission-B");
    cases.push(v);
    let mut v = ready.clone();
    v["payload"]["oldSessionId"] = json!(f::SUCCESSOR);
    cases.push(v);
    let mut v = ready.clone();
    v["payload"]["extra"] = json!(1);
    cases.push(v);
    let mut v = ready.clone();
    v["payload"]["expectedHome"]["lineageId"] = json!("other");
    v["payload"]["enable"]["expectedHome"]["lineageId"] = json!("other");
    cases.push(v);
    // Copied grant or reused rule, an altered nested home, a settings revision.
    let mut v = ready.clone();
    v["payload"]["enable"]["chat"] = weekly_fx::chat(f::SUCCESSOR, weekly_fx::TERRA);
    cases.push(v);
    let mut v = ready.clone();
    v["payload"]["enable"]["schedule"] = json!({"id":f::RULE,"revision":1});
    cases.push(v);
    let mut v = ready.clone();
    v["payload"]["enable"]["expectedHome"]["hostId"] = json!("other");
    cases.push(v);
    let mut v = ready.clone();
    v["payload"]["enable"]["settingsRevision"] = json!(2);
    cases.push(v);
    // The payload must be the observation it summarizes, with no blocked rule.
    let mut v = ready.clone();
    v["payload"]["rules"] = json!([]);
    cases.push(v);
    let mut v = ready.clone();
    v["rules"][0]["disposition"] = json!("blocked");
    v["payload"]["rules"][0]["disposition"] = json!("blocked");
    cases.push(v);
    let mut v = ready.clone();
    v["coverage"] = json!("overflow");
    cases.push(v);
    let mut v = ready.clone();
    v["model"] = json!({"state":"available","id":"b/terra-6.1"});
    cases.push(v);
    let mut v = ready.clone();
    v["payload"]["successorSessionId"] = json!(f::OLD);
    cases.push(v);
    let mut v = ready.clone();
    v["supersession"] = f::link("project-A", "mission-A", 1);
    cases.push(v);
    let mut v = f::blocked("project-A", "mission-A", "x", "bounded");
    v["payload"] = ready["payload"].clone();
    cases.push(v);
    let mut v = f::replaced("project-A", "mission-A");
    v["supersession"]["revision"] = json!(1);
    cases.push(v);
    let mut v = f::replaced("project-A", "mission-A");
    v["supersession"]["successorSessionId"] = json!(f::OLD);
    cases.push(v);
    for (i, v) in cases.iter().enumerate() {
        assert!(parse(v).is_err(), "case {i} must be malformed");
    }
    // An explicit model choice must be honored exactly.
    assert!(
        preview(
            &ready,
            "project-A",
            "mission-A",
            f::OLD,
            &host(),
            Some("b/terra-6.1")
        )
        .is_err()
    );
}

#[test]
fn completed_link_is_not_a_confirmation() {
    let pf = parse(&f::replaced("project-A", "mission-A")).unwrap();
    assert_eq!(pf.state, State::Replaced);
    assert!(pf.request().is_none());
    let link = pf.supersession.unwrap();
    assert!(link.replaced);
    assert_eq!(
        (link.old.as_str(), link.successor.as_str()),
        (f::OLD, f::SUCCESSOR)
    );
    // A fence alone is a blocker, never an adoption.
    let mut fenced = f::blocked(
        "project-A",
        "mission-A",
        "replacement_pending_use_status",
        "bounded",
    );
    fenced["supersession"] = f::link("project-A", "mission-A", 1);
    let pf = parse(&fenced).unwrap();
    assert_eq!(pf.state, State::Blocked);
    assert!(!pf.supersession.unwrap().replaced);
}

#[test]
fn replace_attempt_round_trips_through_private_state() {
    let op = ready_op();
    let accepted = f::progress(&op, "replaced");
    assert!(valid_result(&op, &accepted));
    let attempt = Attempt {
        slot: slot(f::OLD),
        operation: op.clone(),
        state: Saved::Accepted,
        reason: None,
        result: Some(accepted.clone()),
    };
    let text = serde_json::to_string(&attempt).unwrap();
    let back: Attempt = serde_json::from_str(&text).unwrap();
    assert!(back.validate(&slot(f::OLD)).is_ok());
    assert!(
        back.validate(&slot(f::SUCCESSOR)).is_err(),
        "the slot names the old identity"
    );
    // Retained under another kind, or with an altered payload, it is corrupt.
    let mut other = back.clone();
    other.operation.target_id = f::OLD.into();
    assert!(other.validate(&slot(f::OLD)).is_err());
    let mut pending = back.clone();
    pending.state = Saved::Pending;
    pending.result = None;
    assert!(pending.validate(&slot(f::OLD)).is_ok());
    let mut marker = back.clone();
    marker.result = Some(f::progress(&op, "schedule_pending"));
    assert!(
        marker.validate(&slot(f::OLD)).is_err(),
        "an entered marker is not acceptance"
    );
}

#[test]
fn progress_belongs_to_the_exact_command() {
    let op = ready_op();
    for phase in [
        "fence_pending",
        "fenced",
        "cancel_pending",
        "rules_fenced",
        "chat_pending",
        "chat_ready",
        "schedule_pending",
    ] {
        assert!(
            valid_pending(&op, Some(&f::progress(&op, phase))),
            "{phase}"
        );
        assert!(
            !valid_result(&op, &f::progress(&op, phase)),
            "{phase} is not acceptance"
        );
    }
    assert!(!valid_pending(&op, Some(&f::progress(&op, "replaced"))));
    let good = f::progress(&op, "replaced");
    let mut cases = Vec::new();
    let mut v = good.clone();
    v["oldSessionId"] = json!(f::SUCCESSOR);
    cases.push(v);
    let mut v = good.clone();
    v["sessionId"] = json!(f::OLD);
    cases.push(v);
    let mut v = good.clone();
    v["chat"] = Value::Null;
    cases.push(v);
    let mut v = good.clone();
    v["chat"]["model"] = json!("b/terra-6.1");
    cases.push(v);
    let mut v = good.clone();
    v["chat"]["inputGeneration"] = json!(1);
    cases.push(v);
    // A cancellation the plan never named, a kept rule, a missing or duplicated ACK.
    let mut v = good.clone();
    v["cancelledRules"] = json!([{"id":f::KEPT,"revision":2,"digest":f::DIGEST}]);
    cases.push(v);
    let mut v = good.clone();
    v["cancelledRules"] = json!([]);
    cases.push(v);
    let mut v = good.clone();
    v["cancelledRules"] = json!([{"id":f::RULE,"revision":3,"digest":f::DIGEST},{"id":f::RULE,"revision":3,"digest":f::DIGEST}]);
    cases.push(v);
    let mut v = good.clone();
    v["extra"] = json!(true);
    cases.push(v);
    for (i, v) in cases.iter().enumerate() {
        assert!(!valid_result(&op, v), "case {i}");
    }
}

#[test]
fn status_belongs_to_the_exact_envelope() {
    let op = ready_op();
    let s = status(
        &f::status(&op, "unknown", Value::Null, "not_found", None),
        &op,
    )
    .unwrap();
    assert_eq!(
        (s.receipt, s.current),
        (Receipt::Unknown, Current::NotFound)
    );
    let s = status(
        &f::status(
            &op,
            "accepted",
            f::progress(&op, "replaced"),
            "replaced",
            None,
        ),
        &op,
    )
    .unwrap();
    assert_eq!(
        (s.receipt, s.current),
        (Receipt::Accepted, Current::Replaced)
    );
    assert_eq!(s.next_at, Some(weekly_fx::NEXT));
    // Completed beside a pending receipt after a lost final ACK: replaced, still pending.
    let s = status(
        &f::status(
            &op,
            "pending",
            f::progress(&op, "schedule_pending"),
            "replaced",
            None,
        ),
        &op,
    )
    .unwrap();
    assert_eq!(
        (s.receipt, s.current),
        (
            Receipt::Pending(Some(Phase::SchedulePending)),
            Current::Replaced
        )
    );
    let s = status(
        &f::status(
            &op,
            "pending",
            f::progress(&op, "cancel_pending"),
            "unknown",
            Some("old_cancellation_unknown_use_retained_receipt"),
        ),
        &op,
    )
    .unwrap();
    assert_eq!(s.current, Current::Unknown);
    let s = status(
        &f::status(
            &op,
            "rejected",
            Value::Null,
            "blocked",
            Some("replacement_preview_changed_refresh"),
        ),
        &op,
    )
    .unwrap();
    assert!(matches!(s.receipt, Receipt::Rejected(_)));

    let mut cases = Vec::new();
    // Replaced needs the completed link and the accepted or last-step receipt.
    cases.push(f::status(
        &op,
        "pending",
        f::progress(&op, "chat_ready"),
        "replaced",
        None,
    ));
    let mut v = f::status(
        &op,
        "accepted",
        f::progress(&op, "replaced"),
        "replaced",
        None,
    );
    v["supersession"] = f::link("project-A", "mission-A", 1);
    cases.push(v);
    let mut v = f::status(
        &op,
        "accepted",
        f::progress(&op, "replaced"),
        "replaced",
        None,
    );
    v["receipt"]["payloadHash"] = json!(f::DIGEST);
    cases.push(v);
    let mut v = f::status(
        &op,
        "accepted",
        f::progress(&op, "replaced"),
        "replaced",
        None,
    );
    v["supersession"]["context"] = json!("other");
    cases.push(v);
    let mut v = f::status(
        &op,
        "accepted",
        f::progress(&op, "replaced"),
        "replaced",
        None,
    );
    v["scheduleId"] = json!(f::RULE);
    cases.push(v);
    let mut v = f::status(&op, "unknown", Value::Null, "partial", None);
    v["supersession"] = Value::Null;
    cases.push(v);
    cases.push(f::status(
        &op,
        "accepted",
        f::progress(&op, "schedule_pending"),
        "replaced",
        None,
    ));
    cases.push(f::status(
        &op,
        "pending",
        f::progress(&op, "replaced"),
        "partial",
        None,
    ));
    cases.push(f::status(&op, "rejected", Value::Null, "partial", None));
    let mut v = f::status(
        &op,
        "accepted",
        f::progress(&op, "replaced"),
        "replaced",
        None,
    );
    v["sessionId"] = json!(f::OLD);
    cases.push(v);
    for (i, v) in cases.iter().enumerate() {
        assert!(status(v, &op).is_err(), "case {i} must be malformed");
    }
    // A receipt for other bytes is refused, never adopted.
    let mut changed = op.clone();
    changed.operation_id = "7e7f8091-a2b3-4c4d-9e5f-60718293a4b5".into();
    assert!(
        status(
            &f::status(
                &op,
                "accepted",
                f::progress(&op, "replaced"),
                "replaced",
                None
            ),
            &changed
        )
        .is_err()
    );
    assert!(matches!(
        crate::insights::adopt(
            &op,
            &f::status(
                &op,
                "accepted",
                f::progress(&op, "schedule_pending"),
                "replaced",
                None
            )["receipt"]
        ),
        crate::insights::Outcome::Unknown(_)
    ));
    assert_eq!(
        crate::insights::adopt(
            &op,
            &f::status(
                &op,
                "pending",
                f::progress(&op, "schedule_pending"),
                "replaced",
                None
            )["receipt"]
        ),
        crate::insights::Outcome::Pending
    );
}

#[test]
fn successor_adoption_needs_its_exact_settings_reread() {
    let link = parse(&f::replaced("project-A", "mission-A"))
        .unwrap()
        .supersession
        .unwrap();
    let fx = crate::insights_settings::fixture::snapshot(
        0,
        crate::insights_settings::fixture::settings(weekly_fx::TERRA),
        weekly_fx::TERRA,
    );
    let read = |v: &Value| crate::insights_settings::snapshot(v, f::SUCCESSOR, &host());
    let mut v = fx.clone();
    v["chat"]["sessionId"] = json!(f::SUCCESSOR);
    v["context"] = json!("c0ffee");
    v["projectId"] = json!("project-A");
    v["missionId"] = json!("mission-A");
    assert!(adoptable(&link, &read(&v).unwrap()));
    for (key, value) in [
        ("context", json!("other")),
        ("missionId", json!("mission-B")),
        ("projectId", json!("project-B")),
    ] {
        let mut w = v.clone();
        w[key] = value;
        assert!(!adoptable(&link, &read(&w).unwrap()), "{key}");
    }
    let fenced = Link {
        replaced: false,
        ..link.clone()
    };
    assert!(!adoptable(&fenced, &read(&v).unwrap()));
    // A home from another lineage never parses at all.
    let mut w = v.clone();
    w["expectedHome"]["lineageId"] = json!("other");
    assert!(read(&w).is_err());
}

#[test]
fn reasons_stay_short_and_unknown_codes_stay_generic() {
    for code in [
        "old_identity_home_unqualified",
        "old_operation_pending_use_receipt",
        "report_references_ambiguous",
        "old_automation_untrusted_or_uncertain",
        "replacement_pending_use_status",
        "old_cancellation_unknown_use_retained_receipt",
    ] {
        let words = reason_text(code);
        assert_ne!(words, reason_text("never-seen"), "{code}");
        assert!(words.chars().count() <= 90, "{code}");
        assert!(!words.contains('_'));
    }
    assert_eq!(
        reason_text("never-seen"),
        "The report chat can't be replaced right now."
    );
    // Rejected receipts carry codes or prose: codes become words, prose stays.
    assert_eq!(
        refusal_words("preview_changed"),
        reason_text("preview_changed")
    );
    assert_eq!(
        refusal_words("Another replacement is admitted"),
        "Another replacement is admitted"
    );
    assert!(uuid(f::OLD) && !uuid("report-1") && !uuid(&f::OLD.to_uppercase()));
}
