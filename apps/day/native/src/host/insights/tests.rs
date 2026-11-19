use super::*;

fn source() -> Source {
    Source {
        profile: std::env::temp_dir(),
        port: 12345,
        project: None,
        home: crate::contract::Home {
            daemon_id: "daemon".into(),
            lineage_id: "lineage".into(),
        },
    }
}

fn owner(source: &Source) -> Owner {
    decode(
        json!({"schemaVersion":2,"workspaceId":"workspace","reportSessionId":"report",
        "scheduleId":"weekly","projectId":"project","expectedHome":home(source,"daemon"),
        "context":"a".repeat(64)}),
    )
    .unwrap()
}

fn settings() -> Value {
    json!({"model":"fixture/Exact","source":{"projects":["project"],"excludeProjects":[],"excludeSessions":[]},
        "weekly":null,"allowance":{"basis":"catalog_estimate","perReportMicros":230001,"monthlyMicros":1000000}})
}

fn status_value(source: &Source) -> Value {
    json!({"schemaVersion":1,"revision":3,"settingsRevision":2,"owner":owner(source),"draft":settings(),
        "effective":settings(),"paused":false,"executionSupported":true,"uncertainOperationId":null,
        "running":false,"nextAt":null,"holdReason":null,
        "remaining":{"perReportMicros":230001,"monthlyMicros":0,"uncertainMicros":0}})
}

#[test]
fn insights_snapshot_status_does_not_stale_drafts() {
    let source = source();
    let v = status_value(&source);
    let first = Status::parse(v.clone(), &source).unwrap();
    assert_eq!(first.allowance(), Some((0.230001, 0.0)));
    let mut changed = v;
    changed["revision"] = json!(4);
    changed["paused"] = json!(true);
    changed["nextAt"] = json!(100);
    let second = Status::parse(changed.clone(), &source).unwrap();
    assert_ne!(first, second);
    assert_eq!(first.draft_binding(&source), second.draft_binding(&source));
    changed["settingsRevision"] = json!(3);
    let third = Status::parse(changed, &source).unwrap();
    assert_ne!(second.draft_binding(&source), third.draft_binding(&source));
}

#[test]
fn insights_pause_is_the_only_write_allowed_during_uncertainty() {
    let source = source();
    let mut v = status_value(&source);
    v["uncertainOperationId"] = json!("earlier-write");
    let status = Status::parse(v.clone(), &source).unwrap();
    let pending = PendingWrites {
        any: true,
        pause: false,
    };
    assert_eq!(pending.admit(&status, WriteKind::Pause), Ok(()));
    assert_eq!(pending.admit(&status, WriteKind::Run), Err(Error::Busy));
    assert_eq!(pending.admit(&status, WriteKind::Other), Err(Error::Busy));
    assert_eq!(hold(&status, &pending).unwrap().0, "uncertain");
    let pause_pending = PendingWrites {
        any: true,
        pause: true,
    };
    assert_eq!(
        pause_pending.admit(&status, WriteKind::Pause),
        Err(Error::Busy)
    );
    v["paused"] = json!(true);
    assert_eq!(
        pending.admit(&Status::parse(v, &source).unwrap(), WriteKind::Pause),
        Err(Error::Stale)
    );
}

#[test]
fn insights_terminal_hold_is_not_a_retry_or_an_uncertain_write() {
    let source = source();
    let mut v = status_value(&source);
    let pending = PendingWrites::default();
    v["holdReason"] = json!("synthetic raw backend path /private/not-for-ui");
    let empty = Status::parse(v.clone(), &source).unwrap();
    assert_eq!(
        hold(&empty, &pending),
        Some((
            "terminal",
            "The previous report stopped before it could finish."
        ))
    );
    assert_eq!(
        pending.admit(&empty, WriteKind::Run),
        Err(Error::Unavailable)
    );
    v["remaining"]["monthlyMicros"] = json!(1_000_000);
    let funded = Status::parse(v.clone(), &source).unwrap();
    assert_eq!(pending.admit(&funded, WriteKind::Run), Ok(()));
    v["paused"] = json!(true);
    assert_eq!(
        pending.admit(&Status::parse(v, &source).unwrap(), WriteKind::Run),
        Err(Error::Unavailable)
    );
}

#[test]
fn insights_window_drafts_keep_incomplete_text_without_authority() {
    let mut value = json!({"binding":"a".repeat(64),"projectId":"","model":"","sourceProjectIds":[],
        "excludeSessionIds":["partially typed"],"perReportUsd":"0.","monthlyUsd":"",
        "schedule":{"weekday":4,"time":"1:","timeZone":"Europe/Pa"}});
    let capture = crate::update::SavedView {
        insights_draft: value.to_string(),
        ..Default::default()
    };
    assert!(capture.insights_draft_valid());
    assert_eq!(capture.text_bytes(), capture.insights_draft.len());
    value["token"] = json!("never-restored");
    assert!(!valid_draft(&value.to_string()));
}

#[test]
fn insights_work_capture_keeps_the_previous_form_without_authority() {
    let mut work = json!({
        "kind":"plan","key":"fixture-finding","revision":1,"title":"Use the existing check",
        "projectId":"fixture-project","sourceIds":["fixture-source"],
        "other":{"goal":"  Keep this exactly\n","pick":{"projectId":"other-project","mode":"ask"},
            "replaces":{"missionId":"earlier-mission","title":""},
            "request":{"itemId":"linear-issue","revision":2,"title":"Earlier request","source":"Linear","manageStatus":true},
            "funding":{"project":"other-project","quickFix":"0.","mission":null}}
    });
    let mut capture = crate::update::SavedView::default();
    assert!(capture.insights_work_valid());
    assert!(
        serde_json::to_value(&capture)
            .unwrap()
            .get("insightsWork")
            .is_none()
    );
    capture.insights_work = work.to_string();
    let wire = serde_json::to_value(&capture).unwrap();
    let saved: crate::update::SavedView = nsh_core::element::from_json(&wire).unwrap();
    assert_eq!(saved.insights_work, capture.insights_work);
    assert_eq!(saved.text_bytes(), saved.insights_work.len());
    assert!(super::super::updates::validate_view(&saved).is_ok());

    work["other"]["pick"]["token"] = json!("not-authority");
    capture.insights_work = work.to_string();
    assert_eq!(
        super::super::updates::validate_view(&capture),
        Err(Error::Invalid)
    );
    work["other"]["pick"] = json!(null);
    work["sourceIds"] = json!(["same", "same"]);
    assert!(!valid_work_draft(&work.to_string()));
    work["sourceIds"] = json!(["source"]);
    let oversized = format!("{:width$}", work.to_string(), width = 28_673);
    assert!(!valid_work_draft(&oversized));
}

#[test]
fn insights_bridge_refuses_client_envelopes_and_transport_arguments() {
    for (command, args) in [
        ("day.insights.read", json!({"profile":"/wrong"})),
        (
            "day.insights.confirm",
            json!({"token":"test","envelope":{}}),
        ),
        ("day.insights.check", json!({"id":"test","operation":{}})),
        (
            "day.insights.history",
            json!({"binding":"test","cursor":"a&x=1"}),
        ),
        (
            "day.insights.prepare",
            json!({"binding":"test","intent":{"action":"run","projectId":"wrong"}}),
        ),
    ] {
        assert!(
            matches!(Request::parse(command, args), Err(Error::Invalid)),
            "{command}"
        );
    }
    assert!(
        matches!(Request::parse("day.insights.confirm", json!({"token":"opaque"})),
        Ok(Request::Confirm(t)) if t == "opaque")
    );
}

#[test]
fn insights_check_uses_the_exact_saved_envelope_after_reopen() {
    let source = source();
    let owner = owner(&source);
    let record = Record::new(&source, DAY_OPERATION, &owner, json!({
        "schemaVersion":1,"admissionEpoch":"epoch","owner":owner,"action":"save","expectedRevision":2,
        "settings":settings(),"disclosure":"day-insights-v1"
    })).unwrap();
    let id = record.id().to_owned();
    let dir = std::env::temp_dir().join(format!("day-insights-test-{}", Uuid::new_v4()));
    std::fs::create_dir(&dir).unwrap();
    let file = dir.join("journal");
    let mut journal = Journal::open(file.clone()).unwrap();
    journal.save_insights(record.clone()).unwrap();
    drop(journal);
    let mut journal = Journal::open(file.clone()).unwrap();
    let mut restored = journal.insights.get(&id).unwrap().clone();
    assert!(!restored.settled());
    assert_eq!(restored.envelope, record.envelope);
    let op = &record.envelope;
    let mut receipt = json!({"operationId":id,"payloadHash":"wrong","targetId":op["targetId"],
        "destination":op["destination"],"state":"accepted","result":status_value(&source)});
    assert_eq!(
        settle(&mut journal, &mut restored, receipt.clone()),
        Err(Error::Unknown)
    );
    receipt["payloadHash"] = op["payloadHash"].clone();
    receipt["result"]["draft"]["model"] = json!("fixture/Other");
    assert_eq!(
        settle(&mut journal, &mut restored, receipt.clone()),
        Err(Error::Unknown)
    );
    receipt["result"]["draft"]["model"] = json!("fixture/Exact");
    settle(&mut journal, &mut restored, receipt).unwrap();
    assert!(restored.settled());
    assert_eq!(restored.envelope, record.envelope);
    drop(journal);
    let journal = Journal::open(file).unwrap();
    assert!(journal.insights.get(&id).unwrap().settled());
    drop(journal);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn insights_journal_reserves_terminal_space_before_any_send() {
    let source = source();
    let owner = owner(&source);
    let record = Record::new(&source, DAY_OPERATION, &owner, json!({
        "schemaVersion":1,"admissionEpoch":"epoch","owner":owner,"action":"pause","expectedRevision":2,
        "settings":null,"disclosure":"day-insights-v1"
    })).unwrap();
    let dir = std::env::temp_dir().join(format!("day-insights-capacity-{}", Uuid::new_v4()));
    std::fs::create_dir(&dir).unwrap();
    let mut journal = Journal::open(dir.join("journal")).unwrap();
    let pending_bytes = serde_json::to_vec(&record).unwrap().len() as u64 + 1;
    let both = record.terminal_reservation().unwrap() + pending_bytes;
    journal.test_fill(both - 1);
    assert_eq!(journal.save_insights(record.clone()), Err(Error::Capacity));
    journal.test_fill(both);
    journal.save_insights(record.clone()).unwrap();
    assert_eq!(journal.test_append(&json!({})), Err(Error::Capacity));
    let op = &record.envelope;
    let receipt = json!({"operationId":record.id(),"payloadHash":op["payloadHash"],"targetId":op["targetId"],
        "destination":op["destination"],"state":"rejected","reason":"never persisted"});
    let mut record = record;
    settle(&mut journal, &mut record, receipt).unwrap();
    assert!(record.settled());
    drop(journal);
    std::fs::remove_dir_all(dir).unwrap();
}
