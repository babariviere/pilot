//! Existing Local summary watch, no selected chat or provider/network refresh.
use super::*;

pub(super) async fn serve(
    socket: &mut tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
    steps: &async_channel::Receiver<()>,
    attempt: usize,
) {
    if steps.recv().await.is_err() {
        return;
    }
    let claude = |at, percent| {
        json!({"id":"a","usage":{"subscription":{"provider":"anthropic","fetchedAt":at,
        "windows":[{"label":"5h","usedPercent":percent,"resetsAt":"2000-01-01T00:00:00Z"},
        {"label":"Week","usedPercent":99},{"label":"Unknown model window"}]}}})
    };
    socket.send(Frame::Text(json!({"type":"sessions","sessions":[claude(if attempt == 0 {1000} else {2000},15),
        {"id":"b","usage":{"subscription":{"provider":"openai","fetchedAt":1500,"windows":[{"label":"Week","usedPercent":66}]}}}]}).to_string().into())).await.unwrap();
    if steps.recv().await.is_err() {
        return;
    }
    socket
        .send(Frame::Text(
            json!({"type":"session","session":claude(3000,42)})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    while let Some(frame) = socket.next().await {
        if frame.is_err() || matches!(frame, Ok(Frame::Close(_))) {
            break;
        }
    }
}

#[tokio::test]
async fn provider_usage_cold_cache_live_and_reconnect_keep_authoritative_time() {
    let mock = Mock::start(Scenario::ProviderUsageReconnect).await;
    let (client, rx) = LocalClient::start(mock.options.clone());
    let hello = until(&rx, |v| v.control_connection_generation == 1).await;
    assert!(crate::provider_usage::newest(&hello.chats).is_empty());
    mock.step.send(()).await.unwrap();
    let cold = until(&rx, |v| v.summary_fresh).await;
    let mut limits = crate::provider_refresh::State::default();
    limits.merge(crate::provider_usage::newest(&cold.chats));
    let claude = limits
        .snapshots
        .iter()
        .find(|s| s.provider == "Claude")
        .unwrap();
    assert_eq!(claude.fetched_at, Some(1000));
    assert_eq!(
        claude.windows.len(),
        2,
        "missing count stays unknown, known windows remain"
    );
    assert_eq!(claude.freshness(1_000_000), "Not recent");
    assert_eq!(claude.windows[1].reset(0), "Reset unknown");
    assert_eq!(
        limits
            .snapshots
            .iter()
            .find(|s| s.provider == "Codex")
            .unwrap()
            .windows[0]
            .value,
        "66% used"
    );
    mock.step.send(()).await.unwrap();
    let live = until(&rx, |v| {
        crate::provider_usage::newest(&v.chats)
            .iter()
            .any(|s| s.fetched_at == Some(3000))
    })
    .await;
    limits.merge(crate::provider_usage::newest(&live.chats));
    assert!(client.command(Command::Reconnect));
    let gap = until(&rx, |v| {
        v.control_connection_generation == 2 && !v.summary_fresh
    })
    .await;
    limits.merge(crate::provider_usage::newest(&gap.chats));
    assert_eq!(
        limits
            .snapshots
            .iter()
            .find(|s| s.provider == "Claude")
            .unwrap()
            .fetched_at,
        Some(3000)
    );
    mock.step.send(()).await.unwrap();
    let replay = until(&rx, |v| {
        v.control_connection_generation == 2 && v.summary_fresh
    })
    .await;
    limits.merge(crate::provider_usage::newest(&replay.chats));
    assert_eq!(
        limits
            .snapshots
            .iter()
            .find(|s| s.provider == "Claude")
            .unwrap()
            .fetched_at,
        Some(3000),
        "older cached replay is not fresh usage"
    );
    drop(client);
    tokio::time::timeout(Duration::from_secs(3), async {
        while rx.recv().await.is_ok() {}
    })
    .await
    .unwrap();
    let requests = mock.requests.lock().unwrap();
    assert_eq!(requests.len(), 4);
    assert!(
        requests
            .iter()
            .all(|r| r == "GET /api/hello HTTP/1.1" || r == "GET /api/ws HTTP/1.1")
    );
}

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
