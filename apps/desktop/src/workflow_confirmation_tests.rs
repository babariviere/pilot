use super::{fixture as fx, *};
use crate::delivery_store::{Host, Store};

fn host() -> Host {
    Host {
        host_id: "local".into(),
        daemon_id: "test-daemon".into(),
        lineage_id: "test-lineage".into(),
    }
}
fn ready(purpose: Purpose) -> Prepared {
    prepared(
        &fx::prepared(purpose, "mission-A", "project-A", Some("prior-1")),
        purpose,
        "mission-A",
        "project-A",
    )
    .unwrap()
}

#[test]
fn the_prepared_package_is_sent_verbatim_with_its_purpose_and_prior() {
    for purpose in Purpose::ALL {
        let reply = fx::prepared(purpose, "mission-A", "project-A", Some("prior-1"));
        let p = prepared(&reply, purpose, "mission-A", "project-A").unwrap();
        let sent: Value = serde_json::from_str(&p.payload).unwrap();
        assert_eq!(
            sent["package"], reply["package"],
            "{purpose:?} package bytes are unchanged"
        );
        assert_eq!(sent["purpose"], purpose.kind());
        assert_eq!(sent["expectedPriorOperationId"], "prior-1");
        assert_eq!(
            sent.as_object().unwrap().len(),
            3,
            "no actor, project path or provider is added"
        );
        assert_eq!(
            (
                p.brief_revision,
                p.decisions.iter().map(|d| d.number).collect::<Vec<_>>(),
                p.event_id
            ),
            (3, vec![1, 4], 42)
        );
        assert_eq!(p.disclosure.is_some(), purpose == Purpose::Consent);
        let request = p.request();
        request.validate().unwrap();
        assert_eq!(request.slot(), format!("{}:mission-A", purpose.kind()));
    }
}

#[test]
fn anything_outside_the_fixed_package_is_malformed_never_filled_in() {
    let base = fx::prepared(Purpose::Approve, "mission-A", "project-A", None);
    let mutate = |f: &dyn Fn(&mut Value)| {
        let mut v = base.clone();
        f(&mut v);
        prepared(&v, Purpose::Approve, "mission-A", "project-A")
    };
    assert!(mutate(&|_| {}).is_ok());
    for (label, f) in [
        (
            "extra package key",
            &(|v: &mut Value| v["package"]["actor"] = json!("user")) as &dyn Fn(&mut Value),
        ),
        ("extra reply key", &|v| v["source"] = json!("agent")),
        ("other purpose", &|v| {
            v["package"]["purpose"] = json!("review-consent")
        }),
        ("other mission", &|v| {
            v["package"]["missionId"] = json!("mission-B")
        }),
        ("other project", &|v| {
            v["package"]["projectId"] = json!("project-B")
        }),
        ("widened powers", &|v| {
            v["package"]["delegation"]["actions"] = json!(["plan", "integrate"])
        }),
        ("forced", &|v| {
            v["package"]["delegation"]["force"] = json!(true)
        }),
        ("other delegate", &|v| {
            v["package"]["delegation"]["coordinatorSessionId"] = json!("other")
        }),
        ("relaxed checks", &|v| {
            v["package"]["policy"]["requiredChecks"] = json!("advisory")
        }),
        ("approval with disclosure", &|v| {
            v["package"]["disclosure"] = fx::disclosure(1)
        }),
        ("fence mismatch", &|v| {
            v["package"]["contextFence"]["briefRevision"] = json!(2)
        }),
        ("bad digest", &|v| v["package"]["digest"] = json!("abc")),
        ("bad prior", &|v| {
            v["expectedPriorOperationId"] = json!("../x")
        }),
    ] {
        assert!(mutate(f).is_err(), "{label} must be refused");
    }
    let mut big = base.clone();
    big["package"]["brief"]["markdown"] = json!("x".repeat(PAYLOAD_CAP));
    assert_eq!(
        prepared(&big, Purpose::Approve, "mission-A", "project-A"),
        Err("This plan is larger than a confirmation can carry. Nothing was sent.")
    );
}

#[test]
fn consent_shows_only_the_hosts_full_disclosure() {
    let base = fx::prepared(Purpose::Consent, "mission-A", "project-A", None);
    let d = prepared(&base, Purpose::Consent, "mission-A", "project-A")
        .unwrap()
        .disclosure
        .unwrap();
    assert_eq!(
        (d.provider.as_str(), d.account.as_str()),
        ("Synthetic provider", "synthetic account (no credentials)")
    );
    for (key, value) in [
        ("account", json!("")),
        ("terms", Value::Null),
        ("missionLimitMicros", json!(40000000)),
        ("logicalTaskLimitMicros", json!(8000000)),
        ("refillOnReplacement", json!(true)),
        ("paidFallback", json!(true)),
        ("cumulativeAcrossRechecks", json!(false)),
    ] {
        let mut v = base.clone();
        v["package"]["disclosure"][key] = value;
        assert!(
            prepared(&v, Purpose::Consent, "mission-A", "project-A").is_err(),
            "{key}"
        );
    }
    let mut missing = base.clone();
    missing["package"]["disclosure"]
        .as_object_mut()
        .unwrap()
        .remove("model");
    assert!(prepared(&missing, Purpose::Consent, "mission-A", "project-A").is_err());
    let mut none = base.clone();
    none["package"]["disclosure"] = Value::Null;
    assert!(
        prepared(&none, Purpose::Consent, "mission-A", "project-A").is_err(),
        "consent needs a disclosure"
    );
    none["package"]["workflowApprovalOperationId"] = Value::Null;
    assert!(prepared(&none, Purpose::Consent, "mission-A", "project-A").is_err());
}

fn op(purpose: Purpose) -> Operation {
    let mut store_root = std::env::temp_dir();
    store_root.push(format!("workflow-op-{}", uuid::Uuid::new_v4()));
    let mut s = Store::open(store_root.clone(), host()).unwrap();
    let op = s.prepare_workflow(&ready(purpose).request()).unwrap();
    let _ = std::fs::remove_dir_all(store_root);
    op
}
fn receipt(op: &Operation, state: &str, result: Value) -> Value {
    let mut r = json!({"operationId":op.operation_id,"payloadHash":op.payload_hash,"targetId":op.target_id,"destination":op.destination,"state":state});
    if !result.is_null() {
        r["result"] = result;
    }
    r
}

#[test]
fn only_the_exact_receipt_settles_a_confirmation() {
    let op = op(Purpose::Approve);
    // No record is absence at this read only: Unknown, open, and it never changes the save.
    let missing = adopt(&op, &json!({"state":"unknown"}));
    assert_eq!(missing, Outcome::Unknown(NO_RECORD));
    assert_eq!(missing.state(), None);
    let accepted =
        json!({"operationId":op.operation_id,"missionId":"mission-A","kind":"workflow-approve"});
    assert_eq!(
        adopt(&op, &receipt(&op, "accepted", accepted.clone())),
        Outcome::Accepted
    );
    let marker = json!({"stage":"workflow-effect-entered","purpose":"workflow-approve","payloadHash":op.payload_hash});
    assert_eq!(
        adopt(&op, &receipt(&op, "pending", marker)),
        Outcome::Pending
    );
    assert_eq!(
        adopt(&op, &receipt(&op, "pending", Value::Null)),
        Outcome::Pending
    );
    assert_eq!(
        adopt(
            &op,
            &json!({"state":"rejected","operationId":op.operation_id,"payloadHash":op.payload_hash,"targetId":op.target_id,"destination":op.destination,"reason":"Confirmation package changed; prepare and confirm again"})
        ),
        Outcome::Rejected("The plan changed since this opened. Review again.".into())
    );
    // Another kind, mission, hash or host is never this confirmation's acceptance.
    for bad in [
        receipt(
            &op,
            "accepted",
            json!({"operationId":op.operation_id,"missionId":"mission-A","kind":"workflow-revoke"}),
        ),
        receipt(
            &op,
            "accepted",
            json!({"operationId":"other","missionId":"mission-A","kind":"workflow-approve"}),
        ),
        receipt(&op, "accepted", Value::Null),
        receipt(&op, "pending", json!({"stage":"other"})),
        {
            let mut r = receipt(&op, "accepted", accepted.clone());
            r["payloadHash"] = json!("0".repeat(64));
            r
        },
        {
            let mut r = receipt(&op, "accepted", accepted.clone());
            r["destination"]["daemonId"] = json!("other-daemon");
            r
        },
        json!({"state":"unknown","operationId":op.operation_id}),
    ] {
        assert!(matches!(adopt(&op, &bad), Outcome::Unknown(_)), "{bad}");
    }
}

#[test]
fn the_envelope_is_saved_once_per_slot_survives_restart_and_settles_once() {
    let root = std::env::temp_dir().join(format!("workflow-store-{}", uuid::Uuid::new_v4()));
    let mut s = Store::open(root.clone(), host()).unwrap();
    let request = ready(Purpose::Approve).request();
    let op = s.prepare_workflow(&request).unwrap();
    assert_eq!(
        (op.kind.as_str(), op.target_id.as_str()),
        ("workflow-approve", "mission-A")
    );
    assert_eq!(
        op.payload, request.payload,
        "the confirmed bytes, never rebuilt"
    );
    assert!(
        s.prepare_workflow(&request).is_err(),
        "an open slot is never replaced"
    );
    // Revocation is a separate purpose and can be confirmed while approval is unconfirmed.
    let revoke = s
        .prepare_workflow(&ready(Purpose::Revoke).request())
        .unwrap();
    drop(s);
    let mut s = Store::open(root.clone(), host()).unwrap();
    let slot = request.slot();
    let saved = s.book.workflow.get(&slot).unwrap().clone();
    assert!(
        saved.state == State::Unknown && saved.operation == op,
        "restart keeps the exact envelope"
    );
    s.finish_workflow(&slot, &op.operation_id, State::Accepted, None)
        .unwrap();
    assert!(
        s.finish_workflow(&slot, &op.operation_id, State::Rejected, Some("x".into()))
            .is_err()
    );
    assert!(
        s.finish_workflow(&slot, &revoke.operation_id, State::Accepted, None)
            .is_err(),
        "other slot's operation"
    );
    let next = s.prepare_workflow(&request).unwrap();
    assert_ne!(
        next.operation_id, op.operation_id,
        "a settled slot allows a fresh confirmation"
    );
    drop(s);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn no_record_keeps_the_exact_envelope_open_and_blocks_any_replacement() {
    let root = std::env::temp_dir().join(format!("workflow-absent-{}", uuid::Uuid::new_v4()));
    let mut s = Store::open(root.clone(), host()).unwrap();
    let request = ready(Purpose::Approve).request();
    let op = s.prepare_workflow(&request).unwrap();
    let slot = request.slot();
    // Check saw no record: nothing is finished, so the saved attempt is unchanged and open.
    assert_eq!(adopt(&op, &json!({"state":"unknown"})).state(), None);
    let saved = s.book.workflow.get(&slot).unwrap().clone();
    assert!(saved.open() && saved.operation == op);
    // A fresh package for the same purpose can't replace it, even a different one.
    let fresh = prepared(
        &fx::prepared(Purpose::Approve, "mission-A", "project-A", None),
        Purpose::Approve,
        "mission-A",
        "project-A",
    )
    .unwrap()
    .request();
    assert!(s.prepare_workflow(&fresh).is_err());
    assert!(s.prepare_workflow(&request).is_err());
    assert!(s.book.workflow.get(&slot).unwrap().operation == op);
    // Storage full of open attempts never prunes one to make room.
    for i in 0..31 {
        let mission = format!("mission-{i}");
        let r = prepared(
            &fx::prepared(Purpose::Approve, &mission, "project-A", None),
            Purpose::Approve,
            &mission,
            "project-A",
        )
        .unwrap()
        .request();
        s.prepare_workflow(&r).unwrap();
    }
    let extra = prepared(
        &fx::prepared(Purpose::Revoke, "mission-B", "project-A", Some("p")),
        Purpose::Revoke,
        "mission-B",
        "project-A",
    )
    .unwrap()
    .request();
    assert!(
        s.prepare_workflow(&extra).is_err(),
        "no open attempt is evicted"
    );
    assert_eq!(s.book.workflow.len(), 32);
    assert!(s.book.workflow.get(&slot).unwrap().operation == op);
    drop(s);
    // Restart keeps the same open envelope.
    let s = Store::open(root.clone(), host()).unwrap();
    let saved = s.book.workflow.get(&slot).unwrap();
    assert!(saved.state == State::Unknown && saved.operation == op);
    drop(s);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn an_older_saved_absent_decodes_as_open_unknown() {
    let op = op(Purpose::Revoke);
    let value = json!({"slot": format!("workflow-revoke:{}", op.target_id), "operation": op, "state": "absent"});
    let attempt: Attempt = serde_json::from_value(value).unwrap();
    assert_eq!(attempt.state, State::Unknown);
    assert!(attempt.open(), "absence was only true at that read");
    assert!(matches!(outcome(&attempt), Outcome::Unknown(_)));
    assert_eq!(serde_json::to_value(&attempt).unwrap()["state"], "unknown");
}

#[test]
fn complete_brief_decisions_and_disclosure_are_kept_unclipped_from_the_package() {
    let mut reply = fx::prepared(Purpose::Consent, "mission-A", "project-A", None);
    let brief = format!("{}BRIEF TAIL 末尾", "Long plan line 日本語.\n".repeat(400));
    let decision = format!("{}DECISION TAIL 決定", "Scope stays bounded. ".repeat(40));
    let terms = format!("{}TERMS TAIL", "Terms clause. ".repeat(60));
    reply["package"]["brief"]["markdown"] = json!(brief);
    reply["package"]["decisions"][1]["text"] = json!(decision);
    reply["package"]["disclosure"]["terms"] = json!(terms);
    reply["package"]["disclosure"]["account"] = json!(format!("{}ACCOUNT TAIL", "a".repeat(300)));
    let p = prepared(&reply, Purpose::Consent, "mission-A", "project-A").unwrap();
    assert!(p.brief.chars().count() > 4000 && p.brief == brief);
    assert_eq!(p.decisions[0].text, "Design first");
    assert_eq!(
        (p.decisions[1].number, p.decisions[1].text.as_str()),
        (4, decision.as_str())
    );
    let d = p.disclosure.as_ref().unwrap();
    assert!(d.terms == terms && d.account.ends_with("ACCOUNT TAIL"));
    // The displayed texts are the payload's own bytes.
    let sent: Value = serde_json::from_str(&p.payload).unwrap();
    assert_eq!(sent["package"]["brief"]["markdown"], json!(p.brief));
    assert_eq!(
        sent["package"]["decisions"][1]["text"],
        json!(p.decisions[1].text)
    );
    assert_eq!(sent["package"]["disclosure"]["terms"], json!(d.terms));
}
