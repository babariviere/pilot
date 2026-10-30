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
async fn detail_read_rechecks_pinned_home_after_a_held_response() {
    let s = Server::start();
    let c = client();
    let mut held = Reply::json(200, f::detail("mission-A"));
    held.delay_ms = 100;
    s.reply("/api/missions/mission-A", held);
    let route = Route::Detail(f::key("mission-A"));
    let (result, ()) = tokio::join!(fetch(&c, &s.options, &route), async {
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if s.state
                    .lock()
                    .unwrap()
                    .seen
                    .iter()
                    .any(|(_, p)| p == "/api/missions/mission-A")
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        s.reply("/api/hello", Reply::json(200, json!({"daemonId":"replacement","lineageId":"test-lineage","protocolVersion":1,"minimumClientProtocolVersion":1,"capabilities":{"independentExecution":true}})));
    });
    assert!(
        result.is_err(),
        "an old admission cannot certify a replacement daemon's detail"
    );
    assert_eq!(
        s.state
            .lock()
            .unwrap()
            .seen
            .iter()
            .filter(|(_, p)| p == "/api/hello")
            .count(),
        2
    );
    assert!(s.all_gets());
}
#[test]
fn worker_exit_closes_coalescing_receiver_even_before_runtime_initialization() {
    let (commands, events) = async_channel::bounded(1);
    let retained = events.clone();
    {
        let _guard = CloseRequests(events);
    }
    assert!(retained.is_closed());
    assert!(
        commands
            .try_send(Request {
                generation: 1,
                route: Some(Route::Catalog)
            })
            .is_err()
    );
}
#[tokio::test]
async fn closed_worker_closes_updates_and_refuses_apparently_live_requests() {
    let s = Server::start();
    let (reader, updates) = Reader::start(s.options.clone()).unwrap();
    assert!(reader.request(Request {
        generation: 1,
        route: Some(Route::Catalog)
    }));
    assert!(
        tokio::time::timeout(Duration::from_secs(2), updates.recv())
            .await
            .unwrap()
            .unwrap()
            .result
            .is_ok()
    );
    reader.disconnect_fixture();
    assert!(
        tokio::time::timeout(Duration::from_secs(2), updates.recv())
            .await
            .unwrap()
            .is_err()
    );
    assert!(!reader.request(Request {
        generation: 2,
        route: Some(Route::Catalog)
    }));
    assert!(s.all_gets());
}
#[tokio::test]
async fn only_existing_get_routes_and_pinned_local_home_are_admitted() {
    let s = Server::start();
    let c = client();
    assert!(matches!(
        fetch(&c, &s.options, &Route::Catalog).await.unwrap(),
        Data::Catalog(_)
    ));
    assert!(matches!(
        fetch(&c, &s.options, &Route::Detail(f::key("mission-A")))
            .await
            .unwrap(),
        Data::Detail(_, Ok(_))
    ));
    let before = s.state.lock().unwrap().seen.len();
    let mut key = f::key("mission-A");
    key.home.daemon = "foreign-daemon".into();
    assert!(fetch(&c, &s.options, &Route::Detail(key)).await.is_err());
    assert_eq!(before, s.state.lock().unwrap().seen.len());
    assert!(s.all_gets());
    assert!(
        s.state
            .lock()
            .unwrap()
            .seen
            .iter()
            .all(|(_, p)| p == "/api/hello"
                || p == "/api/mission-catalog"
                || p == "/api/missions/mission-A"
                || p == "/api/sessions?archived=all&missionId=mission-A")
    );
}
#[tokio::test]
async fn byte_limits_before_json_including_chunked_and_member_failure_preserves_detail() {
    let s = Server::start();
    let c = client();
    let path = "/api/mission-catalog";
    for chunked in [false, true] {
        s.reply(
            path,
            Reply {
                status: 200,
                bytes: vec![b'!'; model::CATALOG_BYTES + 1],
                chunked,
                delay_ms: 0,
            },
        );
        let Err(e) = fetch(&c, &s.options, &Route::Catalog).await else {
            panic!("oversized response")
        };
        assert!(e.contains("byte limit"));
    }
    s.reply(
        path,
        Reply {
            status: 200,
            bytes: b"not json".to_vec(),
            chunked: false,
            delay_ms: 0,
        },
    );
    let Err(e) = fetch(&c, &s.options, &Route::Catalog).await else {
        panic!("malformed response")
    };
    assert!(e.contains("Malformed"));
    // Detail carries every task: over 2 MiB and 256 rows still loads whole.
    let large = serde_json::to_vec(&f::many("mission-B", 300)).unwrap();
    assert!(large.len() > 2 * 1024 * 1024);
    for chunked in [false, true] {
        s.reply(
            "/api/missions/mission-B",
            Reply {
                status: 200,
                bytes: large.clone(),
                chunked,
                delay_ms: 0,
            },
        );
        let Ok(Data::Detail(d, _)) =
            fetch(&c, &s.options, &Route::Detail(f::key("mission-B"))).await
        else {
            panic!("large detail")
        };
        assert_eq!(d.task_count, 302);
        assert_eq!(d.summary.total(), 302);
    }
    s.reply(
        "/api/sessions?archived=all&missionId=mission-A",
        Reply {
            status: 200,
            bytes: vec![b'x'; model::MEMBER_BYTES + 1],
            chunked: false,
            delay_ms: 0,
        },
    );
    let Data::Detail(d, Err(e)) = fetch(&c, &s.options, &Route::Detail(f::key("mission-A")))
        .await
        .unwrap()
    else {
        panic!("independent member context failure")
    };
    assert_eq!(d.key.id, "mission-A");
    assert!(e.contains("byte limit"));
    assert!(s.all_gets());
}
#[tokio::test]
async fn identity_error_unsupported_redirect_and_malformed_detail_never_fall_back() {
    let s = Server::start();
    let c = client();
    s.reply("/api/hello",Reply::json(200,json!({"daemonId":"wrong","lineageId":"test-lineage","protocolVersion":1,"minimumClientProtocolVersion":1,"capabilities":{"independentExecution":true}})));
    assert!(fetch(&c, &s.options, &Route::Catalog).await.is_err());
    assert_eq!(s.state.lock().unwrap().seen.len(), 1);
    s.state.lock().unwrap().overrides.clear();
    for status in [404, 405, 503, 302] {
        s.reply("/api/mission-catalog", Reply::json(status, json!({})));
        assert!(fetch(&c, &s.options, &Route::Catalog).await.is_err());
    }
    assert!(
        !s.state
            .lock()
            .unwrap()
            .seen
            .iter()
            .any(|(_, p)| p == "/redirect-target")
    );
    let mut detail = f::detail("mission-A");
    detail["mission"]["id"] = json!("mission-B");
    s.reply("/api/missions/mission-A", Reply::json(200, detail));
    assert!(
        fetch(&c, &s.options, &Route::Detail(f::key("mission-A")))
            .await
            .is_err()
    );
    assert!(s.all_gets());
}
#[tokio::test]
async fn switching_and_inactive_cancel_previous_reads_and_late_publications() {
    let s = Server::start();
    let mut slow = Reply::json(200, f::catalog());
    slow.delay_ms = 150;
    s.reply("/api/mission-catalog", slow);
    let (reader, updates) = Reader::start(s.options.clone()).unwrap();
    assert!(reader.request(Request {
        generation: 1,
        route: Some(Route::Catalog)
    }));
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if s.state
                .lock()
                .unwrap()
                .seen
                .iter()
                .any(|(_, p)| p == "/api/mission-catalog")
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(reader.request(Request {
        generation: 2,
        route: Some(Route::Detail(f::key("mission-A")))
    }));
    let response = tokio::time::timeout(Duration::from_secs(2), updates.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(response.generation, 2);
    assert_eq!(response.route, Route::Detail(f::key("mission-A")));
    assert!(response.result.is_ok());
    assert!(reader.request(Request {
        generation: 3,
        route: Some(Route::Catalog)
    }));
    assert!(reader.request(Request {
        generation: 4,
        route: None
    }));
    assert!(
        tokio::time::timeout(Duration::from_millis(250), updates.recv())
            .await
            .is_err()
    );
    drop(reader);
    assert!(s.all_gets());
}
