use crate::{
    mission_browser_fixture::{self as m, Reply, Server},
    native_review as model, native_review_fixture as f,
    native_review_reader::*,
};
use serde_json::json;
use std::time::Duration;
/// A custody chat route expecting the fixture project.
fn ch(id: &str) -> Chat {
    Chat {
        key: m::key(id),
        project: f::EXPECTED.into(),
    }
}
fn home() -> crate::mission_browser::Home {
    m::key("project-A").home
}
fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .retry(reqwest::retry::never())
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap()
}

#[test]
fn capture_status_is_bounded_and_unsupported_is_not_empty_or_success() {
    let status: model::CaptureStatus =
        serde_json::from_value(json!({"pending":0,"failed":1,"unsupported":["conflicted"]}))
            .unwrap();
    assert!(status.valid());
    assert!(status.notice().unwrap().contains("Conflicted"));
    assert_eq!(status.limitations().len(), 1);
    for reason in [
        "divergent",
        "multiple-parents",
        "root-base",
        "missing",
        "unknown-custody",
        "unknown-discovery",
    ] {
        let status: model::CaptureStatus =
            serde_json::from_value(json!({"pending":0,"failed":0,"unsupported":[reason]})).unwrap();
        assert!(status.valid());
        assert!(status.notice().unwrap().contains("aren't supported"));
        assert_eq!(status.limitations().len(), 1);
    }
    for invalid in [
        json!({"pending":10001,"failed":0}),
        json!({"pending":u64::MAX,"failed":1}),
        json!({"pending":0,"failed":0,"unsupported":["guessed"]}),
    ] {
        let status: model::CaptureStatus = serde_json::from_value(invalid).unwrap();
        assert!(!status.valid());
    }
}
#[tokio::test]
async fn exact_layer_stack_source_and_corruption_are_not_live_fallbacks() {
    let s = Server::start();
    f::install(&s);
    let client = client();
    let c: model::Comparison = serde_json::from_value(f::comparison(1, "layer")).unwrap();
    let route = Route::Snapshot(ch("chat-B"), Box::new(c.clone()));
    let Data::Snapshot(snapshot, files) = fetch(&client, &s.options, &route).await.unwrap() else {
        panic!("snapshot");
    };
    assert_eq!(files.unwrap().len(), 1);
    assert_eq!(snapshot.request.scope.kind, "layer");
    let source = Route::Source(
        ch("chat-B"),
        c.snapshot_id.clone(),
        "after".into(),
        "a.rs".into(),
        model::hash(b"retained lower\n"),
    );
    assert!(
        matches!(fetch(&client,&s.options,&source).await.unwrap(),Data::Source(t) if t=="retained lower\n")
    );
    for mutate in [0, 1, 2, 3] {
        let mut v = f::snapshot(&f::comparison(1, "layer"));
        match mutate {
            0 => {
                v.as_object_mut().unwrap().remove("creation");
            }
            1 => v["request"]["head"]["commitId"] = json!("e".repeat(40)),
            2 => v["workerId"] = json!("foreign"),
            _ => v["request"]["scope"]["kind"] = json!("stack"),
        }
        f::reply(
            &s,
            &format!("{}/{}", f::ROOT, c.snapshot_id),
            Reply::json(200, v),
        );
        assert!(fetch(&client, &s.options, &route).await.is_err());
    }
    // The same snapshot read through another chat is not that chat's revision.
    let foreign_chat = Route::Snapshot(ch("chat-C"), Box::new(c.clone()));
    f::reply(
        &s,
        &format!("{}/{}", f::chat("chat-C"), c.snapshot_id),
        Reply::json(200, f::snapshot(&f::comparison(1, "layer"))),
    );
    assert!(fetch(&client, &s.options, &foreign_chat).await.is_err());
    f::install(&s);
    f::reply(
        &s,
        &format!("{}/{}/patch", f::ROOT, c.snapshot_id),
        Reply::json(
            200,
            json!({"snapshotId":c.snapshot_id,"patch":"wrong hash"}),
        ),
    );
    assert!(matches!(
        fetch(&client, &s.options, &route).await.unwrap(),
        Data::Snapshot(_, Err(_))
    ));
    f::reply(
        &s,
        &format!("{}/{}/patch", f::ROOT, c.snapshot_id),
        Reply::json(403, json!({"error":"revoked"})),
    );
    assert_eq!(
        fetch(&client, &s.options, &route).await.err(),
        Some(ACCESS_REFUSED)
    );
    let before = s.state.lock().unwrap().seen.len();
    let mut foreign = home();
    foreign.daemon = "other".into();
    assert!(
        fetch(&client, &s.options, &Route::Requests(foreign, 0, None))
            .await
            .is_err()
    );
    assert_eq!(before, s.state.lock().unwrap().seen.len());
    assert!(s.all_gets());
    assert!(
        s.state
            .lock()
            .unwrap()
            .seen
            .iter()
            .all(|(_, p)| !p.contains("/changes")
                && !p.contains("/file")
                && !p.contains("/workspace")
                && !p.contains("/api/missions/"))
    );
}
#[tokio::test]
async fn global_requests_are_explicit_and_a_chat_filter_never_admits_others() {
    let s = Server::start();
    f::install(&s);
    let client = client();
    let all = Route::Requests(home(), 0, None);
    let Data::Requests(v) = fetch(&client, &s.options, &all).await.unwrap() else {
        panic!("requests");
    };
    assert_eq!(
        v.requests
            .iter()
            .map(|r| r.request_id.as_str())
            .collect::<Vec<_>>(),
        ["req-1", "req-2", "req-3", "req-4"]
    );
    // Several changes from one chat and changes from other projects are each listed.
    assert_eq!(v.requests[0].session_id, v.requests[1].session_id);
    assert_eq!(v.requests[3].project_id, "project-B");
    // Pending never implies approval-ready: readiness is its own field.
    assert_eq!(
        v.requests.iter().map(|r| r.status()).collect::<Vec<_>>(),
        [
            "Ready for review",
            "Waiting on checks and agent review",
            "Waiting on checks and agent review",
            "Pending · readiness unknown"
        ]
    );
    // A later revision of the same change and scope is newer; another scope is not.
    let later: model::ReviewRequest = serde_json::from_value(f::request(
        "req-9",
        9,
        "chat-B",
        f::PARSER,
        &f::comparison(3, "layer"),
    ))
    .unwrap();
    assert!(v.requests[0].comparison.superseded_by(&later.comparison));
    assert!(!v.requests[1].comparison.superseded_by(&later.comparison));
    assert!(
        !v.requests[3].comparison.superseded_by(&later.comparison),
        "another repository"
    );
    let filtered = Route::Requests(home(), 0, Some("chat-B".into()));
    let Data::Requests(mine) = fetch(&client, &s.options, &filtered).await.unwrap() else {
        panic!("requests");
    };
    assert_eq!(mine.requests.len(), 2);
    // Any state other than an explicit pending request is unknown, never reviewed.
    let mut odd = f::requests();
    odd[0]["state"] = json!("approved");
    s.reply(f::REQUESTS, Reply::json(200, f::list(odd)));
    let Data::Requests(v) = fetch(&client, &s.options, &all).await.unwrap() else {
        panic!("requests");
    };
    assert_eq!(v.requests[0].status(), "Status unknown");
    // No request source is unavailable, not an empty queue.
    s.reply(
        f::REQUESTS,
        Reply::json(
            200,
            json!({"requests":[],"next":null,"unavailable":"not installed"}),
        ),
    );
    let Data::Requests(v) = fetch(&client, &s.options, &all).await.unwrap() else {
        panic!("requests");
    };
    assert!(v.unavailable.is_some() && v.requests.is_empty());
    // A filtered reply with another chat's request, duplicates, disorder, a wrong
    // cursor, an unavailable list with rows, or a malformed row never reach the view.
    let reject = |requests: Vec<serde_json::Value>, next: serde_json::Value| json!({"requests":requests,"next":next});
    s.reply(
        &f::requests_from("chat-B"),
        Reply::json(200, f::list(f::requests())),
    );
    assert_eq!(
        fetch(&client, &s.options, &filtered).await.err(),
        Some(model::INVALID)
    );
    let r = f::requests();
    let mut bad_id = r.clone();
    bad_id[0]["projectId"] = json!("../project-A");
    let mut empty_state = r.clone();
    empty_state[0]["state"] = json!("");
    let mut guessed = r.clone();
    guessed[0]["actionability"] = json!("approved");
    let mut missing = r.clone();
    missing[0].as_object_mut().unwrap().remove("actionability");
    for body in [
        reject(vec![r[0].clone(), r[0].clone()], json!(null)),
        reject(vec![r[1].clone(), r[0].clone()], json!(null)),
        reject(vec![r[0].clone()], json!(7)),
        json!({"requests":[r[0].clone()],"next":null,"unavailable":"none"}),
        f::list(bad_id),
        f::list(empty_state),
        f::list(guessed),
    ] {
        s.reply(f::REQUESTS, Reply::json(200, body));
        assert_eq!(
            fetch(&client, &s.options, &all).await.err(),
            Some(model::INVALID)
        );
    }
    s.reply(f::REQUESTS, Reply::json(200, f::list(missing)));
    assert!(fetch(&client, &s.options, &all).await.is_err());
    // A chat's saved revisions are read through it; no custody reads as not captured,
    // never as an error or an empty queue.
    let Data::Comparisons(saved) = fetch(&client, &s.options, &Route::Comparisons(ch("chat-C"), 0))
        .await
        .unwrap()
    else {
        panic!("comparisons");
    };
    assert_eq!(saved.comparisons.len(), 2);
    let Data::Comparisons(standalone) =
        fetch(&client, &s.options, &Route::Comparisons(ch("chat-S"), 0))
            .await
            .unwrap()
    else {
        panic!("comparisons");
    };
    assert!(standalone.comparisons.is_empty() && standalone.unavailable.is_some());
    // A malformed chat filter is never sent.
    let before = s.state.lock().unwrap().seen.len();
    assert_eq!(
        fetch(
            &client,
            &s.options,
            &Route::Requests(home(), 0, Some("../chat".into()))
        )
        .await
        .err(),
        Some(model::INVALID)
    );
    assert_eq!(before, s.state.lock().unwrap().seen.len());
    assert!(s.all_gets());
    assert!(
        s.state
            .lock()
            .unwrap()
            .seen
            .iter()
            .all(|(_, p)| !p.contains("/api/missions/") && !p.contains("/api/projects/"))
    );
}
#[tokio::test]
async fn replacement_cancels_obsolete_reads_and_byte_limits_precede_decoding() {
    let s = Server::start();
    f::install(&s);
    let mut delayed = Reply::json(200, f::list(vec![]));
    delayed.delay_ms = 1000;
    s.reply(f::REQUESTS, delayed);
    let (reader, rx) = Reader::start(s.options.clone()).unwrap();
    assert!(reader.request(1, Route::Requests(home(), 0, None)));
    tokio::time::timeout(Duration::from_secs(2), async {
        while !s
            .state
            .lock()
            .unwrap()
            .seen
            .iter()
            .any(|(_, path)| path == f::REQUESTS)
        {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .expect("first read must be actively awaiting its delayed response");
    let c: model::Comparison = serde_json::from_value(f::comparison(1, "layer")).unwrap();
    assert!(reader.request(2, Route::Snapshot(ch("chat-B"), Box::new(c))));
    let r = tokio::time::timeout(Duration::from_millis(800), rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(r.generation, 2);
    drop(reader);
    let mut oversized = Reply::json(200, json!({}));
    oversized.bytes = vec![b' '; model::WIRE_CAP + 1];
    s.reply(f::REQUESTS, oversized);
    assert!(
        fetch(&client(), &s.options, &Route::Requests(home(), 0, None))
            .await
            .err()
            .unwrap()
            .contains("byte limit")
    );
}
#[test]
fn malformed_truncated_binary_and_partial_are_explicit() {
    let c: model::Comparison = serde_json::from_value(f::comparison(1, "layer")).unwrap();
    let mut s: model::Snapshot =
        serde_json::from_value(f::snapshot(&f::comparison(1, "layer"))).unwrap();
    s.validate("chat-B", "project-A", &c).unwrap();
    s.diff.as_mut().unwrap().sha256 = model::hash(b"@@ truncated");
    s.diff.as_mut().unwrap().bytes = 12;
    assert!(s.parse_patch("@@ truncated").is_err());
    s.status = "partial".into();
    s.omissions.push("Blob limit".into());
    let mut c = c;
    c.status = "partial".into();
    assert!(s.validate("chat-B", "project-A", &c).is_ok());
    assert!(s.notes().contains("partial"));
    s.after[0].state = "binary".into();
    assert!(s.notes().contains("1 binary"));
    s.after[0].path = "../secret".into();
    assert!(s.validate("chat-B", "project-A", &c).is_err());
}

#[tokio::test]
async fn every_chat_read_expects_the_listed_project_and_a_host_mismatch_is_refused() {
    let s = Server::start();
    f::install(&s);
    let client = client();
    let c: model::Comparison = serde_json::from_value(f::comparison(1, "layer")).unwrap();
    for route in [
        Route::Comparisons(ch("chat-B"), 0),
        Route::Snapshot(ch("chat-B"), Box::new(c.clone())),
        Route::Records(ch("chat-B"), c.snapshot_id.clone()),
        Route::Source(
            ch("chat-B"),
            c.snapshot_id.clone(),
            "after".into(),
            "a.rs".into(),
            model::hash(b"retained lower\n"),
        ),
    ] {
        assert!(fetch(&client, &s.options, &route).await.is_ok());
    }
    let seen = s.state.lock().unwrap().seen.clone();
    let chat_reads: Vec<_> = seen
        .iter()
        .filter(|(_, p)| p.starts_with("/api/sessions/"))
        .collect();
    assert_eq!(
        chat_reads.len(),
        5,
        "saved revisions, snapshot, patch, records, source"
    );
    assert!(
        chat_reads
            .iter()
            .all(|(_, p)| p.ends_with("expectedProjectId=project-A"))
    );
    // The host now has chat-B in another project: the stale expectation is refused.
    f::reply(
        &s,
        &format!("{}/{}", f::ROOT, c.snapshot_id),
        Reply::json(
            403,
            json!({"error":"Retained Review unavailable in this scope"}),
        ),
    );
    assert_eq!(
        fetch(
            &client,
            &s.options,
            &Route::Snapshot(ch("chat-B"), Box::new(c.clone()))
        )
        .await
        .err(),
        Some(ACCESS_REFUSED)
    );
    // A malformed expectation is never sent.
    let before = s.state.lock().unwrap().seen.len();
    let bad = Chat {
        key: m::key("chat-B"),
        project: "../project-B".into(),
    };
    assert_eq!(
        fetch(
            &client,
            &s.options,
            &Route::Records(bad, c.snapshot_id.clone())
        )
        .await
        .err(),
        Some(model::INVALID)
    );
    assert_eq!(before, s.state.lock().unwrap().seen.len());
    assert!(s.all_gets());
    assert_eq!(s.write_count(), 0);
}

#[test]
fn project_owned_capture_needs_this_exact_project_and_no_task_scope() {
    let c: model::Comparison = serde_json::from_value(f::comparison(1, "layer")).unwrap();
    let parse = |v: serde_json::Value| serde_json::from_value::<model::Snapshot>(v).unwrap();
    // A v2 standalone capture: project marker, empty task scope.
    let owned = parse(f::standalone(&f::comparison(1, "layer"), "chat-B"));
    owned.validate("chat-B", "project-A", &c).unwrap();
    assert_eq!(
        owned.enrollment(),
        "project-owned chat capture · no task scope"
    );
    // The marker must match the shown project exactly.
    assert!(owned.validate("chat-B", "project-B", &c).is_err());
    // Legacy v1 bodies keep a nonempty task scope and no marker.
    let legacy = parse(f::snapshot(&f::comparison(1, "layer")));
    legacy.validate("chat-B", "project-A", &c).unwrap();
    assert!(legacy.enrollment().contains("task-A"));
    for (tasks, project) in [
        // Legacy empty scope without a marker.
        (json!([]), None),
        // A marker never comes with task scope.
        (json!(["task-A"]), Some(json!("project-A"))),
        // Malformed or wrong-project markers.
        (json!([]), Some(json!("../project-A"))),
        (json!([]), Some(json!(""))),
        (json!([]), Some(json!("project-B"))),
    ] {
        let mut v = f::snapshot(&f::comparison(1, "layer"));
        v["enrollmentTaskIds"] = tasks;
        if let Some(p) = project {
            v["enrollmentProjectId"] = p;
        }
        assert!(parse(v).validate("chat-B", "project-A", &c).is_err());
    }
    // A non-string marker is not a Snapshot at all.
    let mut v = f::standalone(&f::comparison(1, "layer"), "chat-B");
    v["enrollmentProjectId"] = json!(7);
    assert!(serde_json::from_value::<model::Snapshot>(v).is_err());
}
