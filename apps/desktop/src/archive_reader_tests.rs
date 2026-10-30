//! Source-shaped synthetic endpoints exercise the actual shared reader.
use super::*;

async fn baseline(mock: &Mock, rx: &async_channel::Receiver<Presentation>) -> Presentation {
    mock.list_frames.send(json!({"type":"sessions","sessions":[{"id":"a","title":"Same title","state":"parked","archivedAt":1,"projectId":"p-a","missionId":"m"},{"id":"b","title":"Same title","state":"parked","archivedAt":2}]})).await.unwrap();
    until(rx, |v| v.summary_fresh && v.chats.len() == 2).await
}
async fn requested(mock: &Mock, needle: &str, count: usize) {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if mock
                .requests
                .lock()
                .unwrap()
                .iter()
                .filter(|r| r.contains(needle))
                .count()
                >= count
            {
                return;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}
#[tokio::test]
async fn archive_open_pages_and_reconnect_never_subscribe_even_after_restore() {
    let mock = Mock::start(Scenario::Archive).await;
    let (client, rx) = LocalClient::start(mock.options.clone());
    baseline(&mock, &rx).await;
    assert!(client.command(Command::OpenArchive {
        id: "a".into(),
        generation: 1
    }));
    requested(&mock, "/a/history?", 1).await;
    mock.page_step.send(()).await.unwrap();
    let tail = until(&rx, |v| v.generation == 1 && v.loaded).await;
    assert!(tail.passive_history && tail.chat_status.contains("Read-only"));
    assert_eq!(tail.cursor, Some(30));
    assert!(client.command(Command::Earlier {
        before: 30,
        generation: 1
    }));
    requested(&mock, "before=30&", 1).await;
    mock.page_step.send(()).await.unwrap();
    let all = until(&rx, |v| v.cursor.is_none() && v.loaded && !v.page_busy).await;
    assert!(
        all.rows
            .iter()
            .any(|r| r.source().contains("Find in older history"))
    );
    mock.list_frames.send(json!({"type":"session","session":{"id":"a","title":"Restored elsewhere","state":"working"}})).await.unwrap();
    until(&rx, |v| v.chats.iter().any(|c| c.id == "a" && !c.archived)).await;
    assert!(client.command(Command::Reconnect));
    requested(&mock, "/a/history?", 3).await;
    mock.page_step.send(()).await.unwrap();
    until(&rx, |v| {
        v.loaded && v.passive_history && v.cursor == Some(30)
    })
    .await;
    let requests = mock.requests.lock().unwrap();
    assert!(requests.iter().all(|r| r.starts_with("GET ")));
    assert!(
        !requests
            .iter()
            .any(|r| r.contains("/a/ws") || r.contains("/b/ws"))
    );
    assert!(
        !requests
            .iter()
            .any(|r| r.contains("/restore") || r.contains("/model"))
    );
}
#[tokio::test]
async fn held_refresh_is_single_flight_and_cannot_replace_newer_stream_or_reader() {
    let mock = Mock::start(Scenario::Archive).await;
    let (client, rx) = LocalClient::start(mock.options.clone());
    baseline(&mock, &rx).await;
    client.command(Command::OpenArchive {
        id: "a".into(),
        generation: 1,
    });
    requested(&mock, "/a/history?", 1).await;
    mock.page_step.send(()).await.unwrap();
    let before = until(&rx, |v| v.loaded).await;
    client.command(Command::RefreshSummaries);
    requested(&mock, "archived=all", 1).await;
    client.command(Command::RefreshSummaries);
    until(&rx, |v| v.inventory_refreshing).await;
    mock.list_frames.send(json!({"type":"session","session":{"id":"b","title":"Newer than held GET","archivedAt":2}})).await.unwrap();
    until(&rx, |v| {
        v.chats.iter().any(|c| c.title == "Newer than held GET")
    })
    .await;
    mock.page_step.send(()).await.unwrap();
    let after = until(&rx, |v| !v.inventory_refreshing).await;
    assert!(after.rows == before.rows);
    assert_eq!(after.reader_revision, before.reader_revision);
    assert_eq!(after.generation, before.generation);
    assert_eq!(after.cursor, before.cursor);
    assert!(after.chats.iter().any(|c| c.title == "Newer than held GET"));
    assert_eq!(
        mock.requests
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r.contains("archived=all"))
            .count(),
        1
    );
    client.command(Command::RefreshSummaries);
    requested(&mock, "archived=all", 2).await;
    mock.page_step.send(()).await.unwrap();
    let refreshed = until(&rx, |v| {
        !v.inventory_refreshing && v.chats.iter().any(|c| c.title == "Refreshed archive")
    })
    .await;
    assert!(refreshed.rows == before.rows);
    assert_eq!(refreshed.reader_revision, before.reader_revision);
}
#[tokio::test]
async fn late_archived_target_cannot_replace_newer_exact_id() {
    let mock = Mock::start(Scenario::Archive).await;
    let (client, rx) = LocalClient::start(mock.options.clone());
    baseline(&mock, &rx).await;
    client.command(Command::OpenArchive {
        id: "a".into(),
        generation: 1,
    });
    requested(&mock, "/a/history?", 1).await;
    client.command(Command::OpenArchive {
        id: "b".into(),
        generation: 2,
    });
    requested(&mock, "/b/history?", 1).await;
    mock.page_step.send(()).await.unwrap();
    mock.page_step.send(()).await.unwrap();
    let v = until(&rx, |v| v.loaded && v.generation == 2).await;
    assert!(v.rows.iter().any(|r| r.source().contains("b retained")));
    assert!(!v.rows.iter().any(|r| r.source().contains("a retained")));
    assert!(
        !mock
            .requests
            .lock()
            .unwrap()
            .iter()
            .any(|r| r.contains("/a/ws") || r.contains("/b/ws"))
    );
}

#[test]
fn archive_pages_validate_identity_and_cursor_before_projection() {
    for page in [
        json!({}),
        json!({"entries":[],"more":true}),
        json!({"entries":[entry(5,"x"),entry(5,"duplicate")],"more":false}),
        json!({"entries":[entry(10,"outside")],"more":false}),
    ] {
        assert!(validate_archive_page(&page, 10).is_err());
    }
    assert!(validate_archive_page(&json!({"entries":[],"more":false}), 10).is_ok());
}

#[tokio::test]
async fn fatal_identity_refresh_settles_without_enumeration_or_lifting_the_fence() {
    let mock = Mock::start(Scenario::SessionListLineage).await;
    let (client, rx) = LocalClient::start(mock.options.clone());
    let baseline = baseline(&mock, &rx).await;
    client.command(Command::Reconnect);
    until(&rx, |v| v.status.contains("identity") && !v.summary_fresh).await;
    client.command(Command::RefreshSummaries);
    let refused = until(&rx, |v| {
        v.inventory_error.is_some() && !v.inventory_refreshing
    })
    .await;
    assert!(!refused.summary_fresh);
    assert!(refused.chats == baseline.chats);
    assert!(
        !mock
            .requests
            .lock()
            .unwrap()
            .iter()
            .any(|r| r.contains("archived=all"))
    );
}
