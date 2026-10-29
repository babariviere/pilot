use super::*;
use crate::mission_browser_fixture::{self as f, Reply, Server};
use serde_json::json;
fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .retry(reqwest::retry::never())
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap()
}
#[tokio::test]
async fn exact_local_get_only_no_task_endpoint_paging_redirect_or_identity_fallback() {
    let s = Server::start();
    let c = client();
    let key = f::key("mission-A");
    assert_eq!(
        fetch(&c, &s.options, &Route(key.clone()))
            .await
            .unwrap()
            .tasks
            .len(),
        2
    );
    assert_eq!(
        s.state
            .lock()
            .unwrap()
            .seen
            .iter()
            .map(|(_, p)| p.as_str())
            .collect::<Vec<_>>(),
        ["/api/hello", "/api/missions/mission-A"]
    );
    let mut foreign = key.clone();
    foreign.home.daemon = "other".into();
    assert!(fetch(&c, &s.options, &Route(foreign)).await.is_err());
    assert_eq!(s.state.lock().unwrap().seen.len(), 2);
    for status in [302, 404, 405, 503, 500] {
        s.reply("/api/missions/mission-A", Reply::json(status, json!({})));
        assert!(fetch(&c, &s.options, &Route(key.clone())).await.is_err());
    }
    assert!(
        !s.state
            .lock()
            .unwrap()
            .seen
            .iter()
            .any(|(_, p)| p == "/redirect-target")
    );
    s.reply(
        "/api/hello",
        Reply::json(200, json!({"daemonId":"other","lineageId":"test-lineage"})),
    );
    let before = s.state.lock().unwrap().seen.len();
    assert!(fetch(&c, &s.options, &Route(key)).await.is_err());
    assert_eq!(s.state.lock().unwrap().seen.len(), before + 1);
    assert!(s.all_gets());
}
#[tokio::test]
async fn large_legacy_details_load_whole_while_malformed_and_foreign_fail_closed() {
    let s = Server::start();
    let c = client();
    let route = Route(f::key("mission-A"));
    // Over 2 MiB and 256 rows, declared or streamed: every task arrives.
    let large = serde_json::to_vec(&f::many("mission-A", 300)).unwrap();
    assert!(large.len() > 2 * 1024 * 1024);
    for chunked in [false, true] {
        s.reply(
            "/api/missions/mission-A",
            Reply {
                status: 200,
                bytes: large.clone(),
                chunked,
                delay_ms: 0,
            },
        );
        let snapshot = fetch(&c, &s.options, &route).await.unwrap();
        assert_eq!(snapshot.tasks.len(), 302);
        assert_eq!(snapshot.tasks[300].id, "task-A");
    }
    s.reply(
        "/api/missions/mission-A",
        Reply {
            status: 200,
            bytes: b"bad json".to_vec(),
            chunked: false,
            delay_ms: 0,
        },
    );
    assert!(fetch(&c, &s.options, &route).await.is_err());
    s.reply(
        "/api/missions/mission-A",
        Reply::json(200, f::detail("mission-B")),
    );
    assert!(fetch(&c, &s.options, &route).await.is_err());
    let mut d = f::detail("mission-A");
    let body = " 語😀\n".repeat(128 * 1024 / 3 + 1);
    let title = " Legacy 😀 ".repeat(801);
    d["tasks"][0]["body"] = json!(body);
    d["tasks"][0]["title"] = json!(title);
    let id = d["tasks"][0]["id"].as_str().unwrap().to_owned();
    s.reply("/api/missions/mission-A", Reply::json(200, d));
    let loaded = fetch(&c, &s.options, &route).await.unwrap();
    let task = loaded.task(&id).unwrap();
    assert_eq!(task.body, body);
    assert_eq!(task.title, title);
    assert!(s.all_gets());
}
#[tokio::test]
async fn superseded_and_closed_reads_are_cancelled_and_cannot_retarget() {
    let s = Server::start();
    let mut slow = Reply::json(200, f::detail("mission-A"));
    slow.delay_ms = 500;
    s.reply("/api/missions/mission-A", slow);
    let (reader, output) = Reader::start(s.options.clone()).unwrap();
    assert!(reader.request(Request {
        generation: 1,
        route: Some(Route(f::key("mission-A")))
    }));
    let end = std::time::Instant::now() + Duration::from_secs(2);
    while !s
        .state
        .lock()
        .unwrap()
        .seen
        .iter()
        .any(|(_, p)| p == "/api/missions/mission-A")
    {
        assert!(std::time::Instant::now() < end);
        tokio::task::yield_now().await;
    }
    assert!(reader.request(Request {
        generation: 2,
        route: Some(Route(f::key("mission-B")))
    }));
    let response = tokio::time::timeout(Duration::from_secs(2), output.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(response.generation, 2);
    assert_eq!(response.result.unwrap().key.id, "mission-B");
    reader.disconnect_fixture();
    assert!(
        tokio::time::timeout(Duration::from_secs(2), output.recv())
            .await
            .unwrap()
            .is_err()
    );
    assert!(!reader.request(Request {
        generation: 3,
        route: None
    }));
    assert!(s.all_gets());
}
