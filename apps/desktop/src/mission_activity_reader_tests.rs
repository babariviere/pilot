use super::*;
use crate::mission_browser_fixture::{Reply, Server, key};
use serde_json::json;
fn rt() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
}
fn event(id: u64) -> Value {
    json!({"id":id,"kind":"handoff","text":"Exact bounded handoff 私","sessionId":"chat-A","at":123})
}
#[test]
fn get_exact_local_events_before_and_identity_gate_only() {
    let s = Server::start();
    let path = "/api/missions/mission-A/events?before=20";
    s.reply(path, Reply::json(200, json!([event(19)])));
    rt().block_on(async {
        let c = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let rows = fetch(&c, &s.options, &key("mission-A"), Some(20))
            .await
            .unwrap();
        assert_eq!(rows[0].id, 19);
        let mut foreign = key("mission-A");
        foreign.home.daemon = "foreign".into();
        assert!(fetch(&c, &s.options, &foreign, None).await.is_err());
    });
    let seen = s.state.lock().unwrap().seen.clone();
    assert_eq!(
        seen,
        [
            ("GET".into(), "/api/hello".into()),
            ("GET".into(), path.into())
        ]
    );
}
#[test]
fn malformed_status_redirect_and_both_wire_framings_fail_closed() {
    let s = Server::start();
    let path = "/api/missions/mission-A/events";
    let mut cases = vec![
        Reply::json(503, json!({})),
        Reply::json(302, json!({})),
        Reply::json(200, json!({})),
        Reply::json(200, json!([event(1)])),
    ];
    cases[3].bytes = b"invalid json".to_vec();
    for chunked in [false, true] {
        cases.push(Reply {
            status: 200,
            bytes: vec![b' '; model::WIRE_CAP + 1],
            chunked,
            delay_ms: 0,
        });
    }
    rt().block_on(async {
        let c = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(3))
            .build()
            .unwrap();
        for reply in cases {
            s.reply(path, reply);
            assert!(
                fetch(&c, &s.options, &key("mission-A"), None)
                    .await
                    .is_err()
            );
        }
    });
    assert!(s.all_gets());
    assert!(
        !s.state
            .lock()
            .unwrap()
            .seen
            .iter()
            .any(|(_, p)| p == "/redirect-target")
    );
}
#[test]
fn worker_replaces_slow_source_and_close_cancels_without_more_reads() {
    let s = Server::start();
    let mut slow = Reply::json(200, json!([event(99)]));
    slow.delay_ms = 500;
    s.reply("/api/missions/mission-A/events", slow);
    s.reply(
        "/api/missions/mission-B/events",
        Reply::json(200, json!([event(2)])),
    );
    let (reader, output) = Reader::start(s.options.clone()).unwrap();
    reader.request(Request {
        generation: 1,
        target: Some((key("mission-A"), None)),
    });
    rt().block_on(async {
        let end = tokio::time::Instant::now() + Duration::from_secs(3);
        while !s
            .state
            .lock()
            .unwrap()
            .seen
            .iter()
            .any(|(_, p)| p == "/api/missions/mission-A/events")
        {
            assert!(tokio::time::Instant::now() < end);
            tokio::task::yield_now().await;
        }
        assert!(reader.request(Request {
            generation: 2,
            target: Some((key("mission-B"), None))
        }));
        let r = tokio::time::timeout(Duration::from_secs(3), output.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(r.generation, 2);
        assert_eq!(r.key, key("mission-B"));
        assert_eq!(r.result.unwrap()[0].id, 2);
        drop(reader);
        assert!(
            tokio::time::timeout(Duration::from_secs(3), output.recv())
                .await
                .unwrap()
                .is_err()
        );
    });
    assert!(s.all_gets());
}
