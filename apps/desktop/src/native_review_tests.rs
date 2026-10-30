use crate::{
    mission_browser_fixture::{self as m, Reply, Server},
    native_review as model, native_review_fixture as f,
    native_review_reader::*,
};
use serde_json::json;
use std::time::Duration;
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
    let route = Route::Snapshot(m::key("mission-A"), "chat-B".into(), Box::new(c.clone()));
    let Data::Snapshot(snapshot, files) = fetch(&client, &s.options, &route).await.unwrap() else {
        panic!("snapshot");
    };
    assert_eq!(files.unwrap().len(), 1);
    assert_eq!(snapshot.request.scope.kind, "layer");
    let source = Route::Source(
        m::key("mission-A"),
        "chat-B".into(),
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
        s.reply(
            &format!("{}/chat-B/{}", f::ROOT, c.snapshot_id),
            Reply::json(200, v),
        );
        assert!(fetch(&client, &s.options, &route).await.is_err());
    }
    f::install(&s);
    s.reply(
        &format!("{}/chat-B/{}/patch", f::ROOT, c.snapshot_id),
        Reply::json(
            200,
            json!({"snapshotId":c.snapshot_id,"patch":"wrong hash"}),
        ),
    );
    assert!(matches!(
        fetch(&client, &s.options, &route).await.unwrap(),
        Data::Snapshot(_, Err(_))
    ));
    s.reply(
        &format!("{}/chat-B/{}/patch", f::ROOT, c.snapshot_id),
        Reply::json(403, json!({"error":"revoked"})),
    );
    assert_eq!(
        fetch(&client, &s.options, &route).await.err(),
        Some(ACCESS_REFUSED)
    );
    let before = s.state.lock().unwrap().seen.len();
    let mut foreign = m::key("mission-A");
    foreign.home.daemon = "other".into();
    assert!(
        fetch(&client, &s.options, &Route::Workers(foreign))
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
                && !p.contains("/workspace"))
    );
}
#[tokio::test]
async fn replacement_cancels_obsolete_reads_and_byte_limits_precede_decoding() {
    let s = Server::start();
    f::install(&s);
    let mut delayed = Reply::json(
        200,
        json!({"missionId":"mission-A","projectId":"project-A","workers":[],"more":false}),
    );
    delayed.delay_ms = 1000;
    s.reply(f::ROOT, delayed);
    let (reader, rx) = Reader::start(s.options.clone()).unwrap();
    assert!(reader.request(1, Route::Workers(m::key("mission-A"))));
    tokio::time::timeout(Duration::from_secs(2), async {
        while !s
            .state
            .lock()
            .unwrap()
            .seen
            .iter()
            .any(|(_, path)| path == f::ROOT)
        {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .expect("first read must be actively awaiting its delayed response");
    assert!(reader.request(
        2,
        Route::Comparisons(m::key("mission-A"), "chat-B".into(), 0)
    ));
    let r = tokio::time::timeout(Duration::from_millis(800), rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(r.generation, 2);
    drop(reader);
    let mut oversized = Reply::json(200, json!({}));
    oversized.bytes = vec![b' '; model::WIRE_CAP + 1];
    s.reply(f::ROOT, oversized);
    assert!(
        fetch(&client(), &s.options, &Route::Workers(m::key("mission-A")))
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
    s.validate("chat-B", &c).unwrap();
    s.diff.as_mut().unwrap().sha256 = model::hash(b"@@ truncated");
    s.diff.as_mut().unwrap().bytes = 12;
    assert!(s.parse_patch("@@ truncated").is_err());
    s.status = "partial".into();
    s.omissions.push("Blob limit".into());
    let mut c = c;
    c.status = "partial".into();
    assert!(s.validate("chat-B", &c).is_ok());
    assert!(s.notes().contains("partial"));
    s.after[0].state = "binary".into();
    assert!(s.notes().contains("1 binary"));
    s.after[0].path = "../secret".into();
    assert!(s.validate("chat-B", &c).is_err());
}
