//! Existing Local summary watch, no selected chat or provider/network refresh.
use super::*;

#[tokio::test]
async fn provider_usage_watch_updates_reset_error_and_absence_without_provider_requests() {
    let mock = Mock::start(Scenario::ProviderUsage).await;
    let (client, rx) = LocalClient::start(mock.options.clone());
    let first = until(&rx, |v| v.list_loaded).await;
    assert!(crate::provider_usage::newest(&first.chats).is_empty());
    for at in [1000, 2000, 3000] {
        mock.step.send(()).await.unwrap();
        let next = until(&rx, |v| {
            crate::provider_usage::newest(&v.chats)
                .first()
                .is_some_and(|s| s.fetched_at == Some(at))
        })
        .await;
        let snapshots = crate::provider_usage::newest(&next.chats);
        let snapshot = &snapshots[0];
        match at {
            1000 => assert_eq!(snapshot.windows[0].value, "96% used"),
            2000 => {
                assert_eq!(snapshot.windows[0].value, "0% used");
                assert_eq!(snapshot.windows[1].label, "Week");
            }
            _ => {
                assert!(snapshot.update_error);
                assert!(snapshot.windows.is_empty());
            }
        }
        assert!(
            next.chats
                .iter()
                .find(|c| c.id == "b")
                .unwrap()
                .subscription_usage
                .is_none()
        );
    }
    mock.step.send(()).await.unwrap();
    until(&rx, |v| crate::provider_usage::newest(&v.chats).is_empty()).await;
    drop(client);
    tokio::time::timeout(Duration::from_secs(3), async {
        while rx.recv().await.is_ok() {}
    })
    .await
    .unwrap();
    let requests = mock.requests.lock().unwrap();
    assert_eq!(requests.len(), 2, "reuse only the hello and summary watch");
    assert!(
        requests
            .iter()
            .all(|r| r == "GET /api/hello HTTP/1.1" || r == "GET /api/ws HTTP/1.1")
    );
}
