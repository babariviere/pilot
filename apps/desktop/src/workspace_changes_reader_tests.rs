use super::*;
use crate::mission_browser_fixture::{Reply, Server};
use serde_json::json;
fn report() -> Value {
    json!({"base":"canonical-base","branch":"recorded/branch","files":[{"path":"src/日本語.rs","status":"modified","additions":1,"deletions":1}],"diff":"diff --git a/src/日本語.rs b/src/日本語.rs\n--- a/src/日本語.rs\n+++ b/src/日本語.rs\n@@ -1 +1 @@\n-old\n+new\n","truncated":false})
}
fn rt() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
}
fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(2))
        .build()
        .unwrap()
}
#[test]
fn pinned_exact_chat_get_only_no_fallback_or_fanout() {
    let s = Server::start();
    s.reply("/api/sessions/chat-A/changes", Reply::json(200, report()));
    assert_eq!(
        rt().block_on(fetch(&client(), &s.options, "chat-A"))
            .unwrap()
            .base,
        "canonical-base"
    );
    assert_eq!(
        s.state
            .lock()
            .unwrap()
            .seen
            .iter()
            .map(|(_, p)| p.as_str())
            .collect::<Vec<_>>(),
        vec!["/api/hello", "/api/sessions/chat-A/changes", "/api/hello"]
    );
    assert!(s.all_gets());
    for id in ["../other", "a?x", "a/b", ""] {
        assert!(url(&s.options, id).is_err());
    }
}
#[test]
fn foreign_hello_refusals_redirect_and_both_wire_framings_fail_closed() {
    let s = Server::start();
    s.reply("/api/hello", Reply::json(200, json!({})));
    assert!(
        rt().block_on(fetch(&client(), &s.options, "chat-A"))
            .is_err()
    );
    assert_eq!(s.state.lock().unwrap().seen.len(), 1);
    let s = Server::start();
    for code in [302, 400, 404, 409, 429, 503] {
        s.reply("/api/sessions/chat-A/changes", Reply::json(code, report()));
        assert!(
            rt().block_on(fetch(&client(), &s.options, "chat-A"))
                .is_err()
        );
    }
    for chunked in [false, true] {
        s.reply(
            "/api/sessions/chat-A/changes",
            Reply {
                status: 200,
                bytes: vec![b' '; model::WIRE_CAP + 1],
                chunked,
                delay_ms: 0,
            },
        );
        assert!(
            rt().block_on(fetch(&client(), &s.options, "chat-A"))
                .is_err()
        );
    }
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
fn replacement_and_drop_cancel_inflight_and_close_output() {
    let s = Server::start();
    let mut slow = Reply::json(200, report());
    slow.delay_ms = 500;
    s.reply("/api/sessions/chat-A/changes", slow);
    s.reply("/api/sessions/chat-B/changes", Reply::json(200, report()));
    let (reader, output) = Reader::start(s.options.clone()).unwrap();
    reader.request(Request {
        generation: 1,
        target: Some("chat-A".into()),
    });
    rt().block_on(async {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
        while !s
            .state
            .lock()
            .unwrap()
            .seen
            .iter()
            .any(|(_, p)| p == "/api/sessions/chat-A/changes")
        {
            assert!(tokio::time::Instant::now() < deadline);
            tokio::task::yield_now().await;
        }
        reader.request(Request {
            generation: 2,
            target: Some("chat-B".into()),
        });
        let response = tokio::time::timeout(Duration::from_secs(3), output.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(response.chat, "chat-B");
        assert_eq!(response.generation, 2);
        reader.request(Request {
            generation: 3,
            target: Some("chat-A".into()),
        });
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

#[test]
fn post_read_identity_change_never_publishes_the_old_source() {
    let s = Server::start();
    let mut slow = Reply::json(200, report());
    slow.delay_ms = 100;
    s.reply("/api/sessions/chat-A/changes", slow);
    rt().block_on(async {
        let client = client();
        let read = fetch(&client, &s.options, "chat-A");
        let change = async {
            let end = tokio::time::Instant::now() + Duration::from_secs(3);
            while !s
                .state
                .lock()
                .unwrap()
                .seen
                .iter()
                .any(|(_, p)| p == "/api/sessions/chat-A/changes")
            {
                assert!(tokio::time::Instant::now() < end);
                tokio::task::yield_now().await;
            }
            s.reply("/api/hello", Reply::json(200, json!({})));
        };
        let (result, _) = tokio::join!(read, change);
        assert!(result.is_err());
    });
    assert!(s.all_gets());
}
