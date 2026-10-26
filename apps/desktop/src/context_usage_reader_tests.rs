//! Existing identity-pinned, bounded reader over a synthetic loopback WebSocket.
use super::*;
#[tokio::test]
async fn context_usage_follows_only_canonical_summary_and_clears_missing_worker_data() {
    let mock = Mock::start(Scenario::ContextUsage).await;
    let (client, rx) = LocalClient::start(mock.options.clone());
    let first = until(&rx, |v| v.list_loaded).await;
    assert!(first.chats[0].context_usage.lines()[0].contains("Unknown / Unknown"));
    for expected in ["42 / 100", "80 / 100", "Unknown / Unknown"] {
        mock.step.send(()).await.unwrap();
        let next = until(&rx, |v| {
            v.chats
                .iter()
                .any(|c| c.id == "a" && c.context_usage.lines()[0].contains(expected))
        })
        .await;
        assert!(
            next.chats
                .iter()
                .find(|c| c.id == "b")
                .unwrap()
                .context_usage
                .lines()[0]
                .contains("Unknown / Unknown")
        );
    }
    drop(client);
    tokio::time::timeout(Duration::from_secs(3), async {
        while rx.recv().await.is_ok() {}
    })
    .await
    .unwrap();
    assert!(
        mock.requests
            .lock()
            .unwrap()
            .iter()
            .all(|r| r.starts_with("GET "))
    );
    assert!(
        mock.requests
            .lock()
            .unwrap()
            .iter()
            .all(|r| r.contains("/api/hello") || r.contains("/api/ws"))
    );
}
