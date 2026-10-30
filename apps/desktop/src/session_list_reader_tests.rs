//! Full snapshot adoption through the production Local control socket/reader.
use super::*;

async fn frame(
    mock: &Mock,
    rx: &async_channel::Receiver<Presentation>,
    serial: &mut u64,
    value: Value,
) -> Presentation {
    *serial += 1;
    let marker = serial.to_string();
    mock.list_frames.send(value).await.unwrap();
    // An ordered, independent frame proves even a rejected input was consumed.
    mock.list_frames
        .send(json!({"type":"missions","missions":[{"id":"marker","title":marker}]}))
        .await
        .unwrap();
    until(rx, |v| {
        v.mission_titles.as_ref().and_then(|m| m.get("marker")) == Some(&marker)
    })
    .await
}

fn snapshot(rows: Value) -> Value {
    json!({"type":"sessions","sessions":rows})
}

fn good() -> Value {
    snapshot(json!([
        {"id":"a","title":"Canonical 日本語","state":"idle","projectId":"p-a","missionId":"m-a","updatedAt":20},
        {"id":"retained","title":"Archived history","archivedAt":1,"continuedTo":"later","state":"parked","projectId":"p-b","missionId":"m-b"}
    ]))
}

fn retained(before: &Presentation, after: &Presentation) {
    assert!(
        before.chats == after.chats,
        "all row fields retained exactly"
    );
    assert_eq!(before.mission_metadata, after.mission_metadata);
    assert!(Arc::ptr_eq(&before.chats, &after.chats));
    assert!(Arc::ptr_eq(
        &before.mission_metadata,
        &after.mission_metadata
    ));
    assert_eq!(before.list_loaded, after.list_loaded);
    assert!(before.rows == after.rows, "selected history remains exact");
    assert_eq!(before.generation, after.generation);
    assert_eq!(before.cursor, after.cursor);
    assert_eq!(before.reader_revision, after.reader_revision);
    assert_eq!(before.loaded, after.loaded);
}

#[tokio::test]
async fn malformed_snapshot_keeps_exact_rows_metadata_and_selected_history() {
    let mock = Mock::start(Scenario::SessionList).await;
    let (client, rx) = LocalClient::start(mock.options.clone());
    let mut serial = 0;
    let first = frame(&mock, &rx, &mut serial, good()).await;
    assert!(first.summary_fresh && first.list_loaded);
    assert!(client.command(Command::Open {
        id: "a".into(),
        generation: 7
    }));
    let selected = until(&rx, |v| v.loaded && v.generation == 7).await;
    assert!(!selected.rows.is_empty());
    assert!(selected.question_fresh(Some("a"), 7));
    for bad in [
        json!({"type":"sessions"}),
        snapshot(Value::Null),
        snapshot(json!({"private":"/private/synthetic"})),
        snapshot(json!("private content")),
        snapshot(json!(false)),
        snapshot(json!(42)),
        snapshot(
            json!([{"id":"a","missionId":"changed","projectId":"p-b","title":"Do not adopt"},{"id":"bad/id"}]),
        ),
        snapshot(json!([{"id":"a"},{"id":"a","missionId":"changed"}])),
        snapshot(json!([{"id":"a"},{}])),
        snapshot(json!([{"id":"a"},{"id":9}])),
        snapshot(json!([{"id":"a"},null])),
        snapshot(json!([{"id":""}])),
        snapshot(json!([{"id":"x".repeat(129)}])),
    ] {
        let rejected = frame(&mock, &rx, &mut serial, bad).await;
        retained(&selected, &rejected);
        assert!(!rejected.summary_fresh);
        assert!(!rejected.question_fresh(Some("a"), 7));
        assert!(rejected.status.starts_with("Local chat list unavailable"));
        assert!(rejected.status.len() < 100);
        assert!(!rejected.status.contains("private"));
        assert!(!rejected.status.contains("changed"));
    }
    let recovered = frame(&mock, &rx, &mut serial, good()).await;
    assert!(recovered.summary_fresh);
    assert_eq!(recovered.status, "Connected · Local");
    assert!(recovered.chats == selected.chats);
    assert_eq!(recovered.mission_metadata, selected.mission_metadata);
    assert!(recovered.rows == selected.rows);
    let empty = frame(&mock, &rx, &mut serial, snapshot(json!([]))).await;
    assert!(empty.summary_fresh && empty.list_loaded && empty.chats.is_empty());
    assert!(empty.rows == selected.rows);
    assert_eq!(empty.generation, selected.generation);
    assert_eq!(empty.reader_revision, selected.reader_revision);
    assert_eq!(empty.mission_metadata, Arc::default());
    let requests = mock.requests.lock().unwrap();
    assert_eq!(requests.len(), 4, "no extra validation requests");
    assert!(requests.iter().all(|r| r.starts_with("GET ")));
}

#[tokio::test]
async fn cold_failure_incremental_and_empty_recovery_have_distinct_authority() {
    let mock = Mock::start(Scenario::SessionList).await;
    let (_client, rx) = LocalClient::start(mock.options.clone());
    let mut serial = 0;
    let cold = frame(&mock, &rx, &mut serial, snapshot(json!({}))).await;
    assert!(!cold.list_loaded && !cold.summary_fresh && cold.chats.is_empty());
    assert!(cold.status.starts_with("Local chat list unavailable"));
    let delta = frame(&mock, &rx, &mut serial, json!({"type":"session","session":{"id":"a","title":"Delta","projectId":"p-a","missionId":"m-delta"}})).await;
    assert_eq!(delta.chats[0].title, "Delta");
    assert_eq!(
        delta.mission_metadata.link("a"),
        &crate::mission_inspector::Link::Mission {
            project: "p-a".into(),
            mission: "m-delta".into()
        }
    );
    assert!(!delta.summary_fresh && !delta.list_loaded);
    assert_eq!(
        delta.status, cold.status,
        "delta cannot clear full-list failure"
    );
    let empty = frame(&mock, &rx, &mut serial, snapshot(json!([]))).await;
    assert!(empty.chats.is_empty() && empty.list_loaded && empty.summary_fresh);
    assert_eq!(empty.status, "Connected · Local");
    assert_eq!(*empty.mission_metadata, Default::default());
    let live = frame(
        &mock,
        &rx,
        &mut serial,
        json!({"type":"session","session":{"id":"a","state":"idle"}}),
    )
    .await;
    assert!(live.summary_fresh && live.list_loaded);
    assert_eq!(
        live.mission_metadata.link("a"),
        &crate::mission_inspector::Link::Unlinked
    );
    let invalid_delta = frame(
        &mock,
        &rx,
        &mut serial,
        json!({"type":"session","session":{"id":"bad/id","missionId":"m-other"}}),
    )
    .await;
    retained(&live, &invalid_delta);
    assert!(invalid_delta.summary_fresh);
    let bad = frame(&mock, &rx, &mut serial, snapshot(json!([{"id":"a"},false]))).await;
    retained(&live, &bad);
    let delta = frame(
        &mock,
        &rx,
        &mut serial,
        json!({"type":"session","session":{"id":"a","title":"Updated after failure"}}),
    )
    .await;
    assert_eq!(delta.chats[0].title, "Updated after failure");
    assert!(!delta.summary_fresh && delta.list_loaded);
    assert_eq!(delta.status, bad.status);
    let empty = frame(&mock, &rx, &mut serial, snapshot(json!([]))).await;
    assert!(empty.summary_fresh && empty.chats.is_empty());
    assert_eq!(empty.status, "Connected · Local");
}

#[tokio::test]
async fn optional_unknown_archived_and_legacy_summaries_remain_supported() {
    let mock = Mock::start(Scenario::SessionList).await;
    let (_client, rx) = LocalClient::start(mock.options.clone());
    let mut serial = 0;
    let rows = json!([
        {"id":"A","state":"future-state","title":9,"usage":"unknown","projectId":false,"missionId":42,"future":{"enabled":true}},
        {"id":"a","archivedAt":123,"continuedTo":"elsewhere","role":"legacy","state":"parked"},
        {"id":"legacy"}
    ]);
    let current = frame(&mock, &rx, &mut serial, snapshot(rows.clone())).await;
    let mut expected: Vec<_> = rows
        .as_array()
        .unwrap()
        .iter()
        .map(|row| local_model::chat(row).unwrap())
        .collect();
    crate::chat_order::sort(&mut expected);
    assert!(*current.chats == expected);
    assert!(current.summary_fresh && current.list_loaded);
    assert_eq!(
        current.mission_metadata.link("A"),
        &crate::mission_inspector::Link::Malformed
    );
    assert!(current.chats.iter().any(|c| c.id == "a" && c.archived));
    assert!(
        current
            .chats
            .iter()
            .any(|c| c.id == "A" && c.state == "future-state")
    );
}

#[tokio::test]
async fn reconnect_hello_and_deltas_do_not_refresh_retained_baseline_or_clear_failure() {
    let mock = Mock::start(Scenario::SessionList).await;
    let (client, rx) = LocalClient::start(mock.options.clone());
    let hello = until(&rx, |v| v.control_connection_generation == 1).await;
    assert!(!hello.summary_fresh && !hello.list_loaded);
    assert!(!hello.status.starts_with("Connected"));
    let mut serial = 0;
    let first = frame(&mock, &rx, &mut serial, good()).await;
    let failed = frame(&mock, &rx, &mut serial, snapshot(Value::Null)).await;
    assert!(client.command(Command::Reconnect));
    let hello = until(&rx, |v| {
        v.control_connection_generation == 2 && v.projects_loaded
    })
    .await;
    assert!(Arc::ptr_eq(&first.chats, &hello.chats));
    assert_eq!(first.mission_metadata, hello.mission_metadata);
    assert_eq!(first.list_loaded, hello.list_loaded);
    assert!(!hello.summary_fresh);
    assert!(!hello.status.starts_with("Connected"));
    let delta = frame(
        &mock,
        &rx,
        &mut serial,
        json!({"type":"session","session":{"id":"new","title":"Before baseline"}}),
    )
    .await;
    assert!(!delta.summary_fresh);
    assert_eq!(delta.status, failed.status);
    let recovered = frame(&mock, &rx, &mut serial, good()).await;
    assert!(recovered.summary_fresh && recovered.list_loaded);
    assert_eq!(recovered.status, "Connected · Local");
    assert!(recovered.chats == first.chats);
    assert!(client.command(Command::Reconnect));
    let healthy_hello = until(&rx, |v| v.control_connection_generation == 3).await;
    assert!(Arc::ptr_eq(&recovered.chats, &healthy_hello.chats));
    assert!(!healthy_hello.summary_fresh && healthy_hello.list_loaded);
    assert_eq!(
        healthy_hello.status, "Loading Local chats…",
        "recovery clears the retained error, not just its visible status"
    );
    let current = frame(&mock, &rx, &mut serial, snapshot(json!([]))).await;
    assert!(current.summary_fresh && current.chats.is_empty());
}

#[tokio::test]
async fn changed_lineage_retains_list_but_refuses_freshness_and_new_socket() {
    let mock = Mock::start(Scenario::SessionListLineage).await;
    let (client, rx) = LocalClient::start(mock.options.clone());
    let mut serial = 0;
    let first = frame(&mock, &rx, &mut serial, good()).await;
    assert!(client.command(Command::Reconnect));
    let refused = until(&rx, |v| v.status.contains("identity changed")).await;
    assert!(first.chats == refused.chats);
    assert_eq!(first.mission_metadata, refused.mission_metadata);
    assert!(refused.list_loaded && !refused.summary_fresh);
    assert_eq!(refused.control_connection_generation, 1);
    assert_eq!(client.daemon(), ConnectedDaemon::NotConnected);
    assert_eq!(
        mock.requests
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r.contains("/api/ws"))
            .count(),
        1
    );
}
