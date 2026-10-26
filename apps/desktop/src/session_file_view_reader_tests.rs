use super::*;
use crate::mission_browser_fixture::{Reply, Server};
use serde_json::json;
fn target(chat: &str) -> Target {
    Target {
        chat: chat.into(),
        cwd: "/synthetic/workspace".into(),
        path: "src/日本語 ?#%.rs".into(),
    }
}
fn report() -> Value {
    json!({"path":target("chat-A").path,"text":"Exact 👩‍💻\r\ntext\n","binary":false,"truncated":false})
}
fn path(s: &Server, chat: &str) -> String {
    let u = url(&s.options, &target(chat)).unwrap();
    format!("{}?{}", u.path(), u.query().unwrap())
}
fn server() -> Server {
    let s = Server::start();
    for id in ["chat-A", "chat-B"] {
        s.reply(
            &format!("/api/sessions/{id}"),
            Reply::json(200, json!({"id":id,"cwd":"/synthetic/workspace"})),
        );
        s.reply(&path(&s, id), Reply::json(200, report()));
    }
    s
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
        .timeout(Duration::from_secs(3))
        .build()
        .unwrap()
}
#[test]
fn exact_path_encoded_once_and_source_bracketed_get_only() {
    let s = server();
    let t = target("chat-A");
    let u = url(&s.options, &t).unwrap();
    assert_eq!(
        u.query_pairs().collect::<Vec<_>>(),
        vec![("path".into(), t.path.clone().into())]
    );
    assert!(matches!(
        rt().block_on(fetch(&client(), &s.options, &t)).unwrap(),
        Content::Text {
            truncated: false,
            ..
        }
    ));
    assert_eq!(
        s.state
            .lock()
            .unwrap()
            .seen
            .iter()
            .map(|(_, p)| p.clone())
            .collect::<Vec<_>>(),
        vec![
            "/api/hello".into(),
            "/api/sessions/chat-A".into(),
            path(&s, "chat-A"),
            "/api/sessions/chat-A".into(),
            "/api/hello".into()
        ]
    );
    assert!(s.all_gets());
    for chat in ["../a", "a/b", "a?b", ""] {
        assert!(url(&s.options, &target(chat)).is_err());
    }
}
#[test]
fn identity_workspace_and_path_refusals_never_fallback() {
    let a = server();
    let b = server();
    assert!(same_source(Some(&a.options), Some(&a.options.clone())));
    assert!(!same_source(Some(&a.options), Some(&b.options)));
    assert!(!same_source(Some(&a.options), None));
    let s = server();
    s.reply("/api/hello", Reply::json(200, json!({})));
    assert!(
        rt().block_on(fetch(&client(), &s.options, &target("chat-A")))
            .is_err()
    );
    assert_eq!(s.state.lock().unwrap().seen.len(), 1);
    let s = server();
    s.reply(
        "/api/sessions/chat-A",
        Reply::json(200, json!({"id":"chat-A","cwd":"/other"})),
    );
    assert!(
        rt().block_on(fetch(&client(), &s.options, &target("chat-A")))
            .is_err()
    );
    assert_eq!(s.state.lock().unwrap().seen.len(), 2);
    let s = server();
    let mut v = report();
    v["path"] = json!("other");
    s.reply(&path(&s, "chat-A"), Reply::json(200, v));
    assert!(
        rt().block_on(fetch(&client(), &s.options, &target("chat-A")))
            .is_err()
    );
    assert!(s.all_gets());
}
#[test]
fn refusal_redirect_malformed_and_both_wire_framings_are_bounded() {
    let s = server();
    let p = path(&s, "chat-A");
    for code in [302, 400, 404, 409, 429, 503] {
        s.reply(&p, Reply::json(code, report()));
        let e = rt()
            .block_on(fetch(&client(), &s.options, &target("chat-A")))
            .unwrap_err();
        if code == 409 {
            assert!(e.contains("refused"));
            assert!(!e.contains("identity changed"));
        }
    }
    for chunked in [false, true] {
        s.reply(
            &p,
            Reply {
                status: 200,
                bytes: vec![b' '; model::WIRE_CAP + 1],
                chunked,
                delay_ms: 0,
            },
        );
        assert!(
            rt().block_on(fetch(&client(), &s.options, &target("chat-A")))
                .unwrap_err()
                .contains("4 MiB")
        );
    }
    s.reply(
        &p,
        Reply {
            status: 200,
            bytes: b"not JSON".to_vec(),
            chunked: false,
            delay_ms: 0,
        },
    );
    assert!(
        rt().block_on(fetch(&client(), &s.options, &target("chat-A")))
            .is_err()
    );
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
async fn seen(s: &Server, path: &str) {
    let end = tokio::time::Instant::now() + Duration::from_secs(3);
    while !s.state.lock().unwrap().seen.iter().any(|(_, p)| p == path) {
        assert!(tokio::time::Instant::now() < end);
        tokio::task::yield_now().await;
    }
}
#[test]
fn late_identity_and_workspace_changes_are_fenced() {
    for home in [true, false] {
        let s = server();
        let p = path(&s, "chat-A");
        let mut slow = Reply::json(200, report());
        slow.delay_ms = 150;
        s.reply(&p, slow);
        rt().block_on(async {
            let c = client();
            let t = target("chat-A");
            let read = fetch(&c, &s.options, &t);
            let change = async {
                seen(&s, &p).await;
                if home {
                    s.reply("/api/hello", Reply::json(200, json!({})));
                } else {
                    s.reply(
                        "/api/sessions/chat-A",
                        Reply::json(200, json!({"id":"chat-A","cwd":"/other"})),
                    );
                }
            };
            let (result, _) = tokio::join!(read, change);
            assert!(result.is_err());
        });
    }
}
#[test]
fn replacement_and_drop_cancel_inflight_and_close_lane() {
    let s = server();
    let p = path(&s, "chat-A");
    let mut slow = Reply::json(200, report());
    slow.delay_ms = 500;
    s.reply(&p, slow);
    let (reader, output) = Reader::start(s.options.clone()).unwrap();
    reader.request(Request {
        generation: 1,
        target: Some(target("chat-A")),
    });
    rt().block_on(async {
        seen(&s, &p).await;
        reader.request(Request {
            generation: 2,
            target: Some(target("chat-B")),
        });
        let r = tokio::time::timeout(Duration::from_secs(3), output.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(r.target, target("chat-B"));
        assert_eq!(r.generation, 2);
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
