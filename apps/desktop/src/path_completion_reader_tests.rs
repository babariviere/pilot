use super::*;
use crate::{
    mission_browser_fixture::{Reply, Server},
    path_completion::{Target, token},
};
use serde_json::json;
pub(crate) fn capture() -> Capture {
    Capture {
        revision: 1,
        target: Target {
            chat: "source".into(),
            cwd: "/synthetic/project".into(),
            generation: 7,
        },
        key: "chat:source".into(),
        intent: 1,
        text: "Read R".into(),
        selection: 6..6,
        token: token("Read R", 6..6).unwrap(),
    }
}
pub(crate) fn route() -> String {
    let mut u =
        reqwest::Url::parse("http://127.0.0.1/api/sessions/source/path-candidates").unwrap();
    u.query_pairs_mut()
        .append_pair("cwd", "/synthetic/project")
        .append_pair("prefix", "R")
        .append_pair("daemonId", "test-daemon")
        .append_pair("lineageId", "test-lineage");
    format!("{}?{}", u.path(), u.query().unwrap())
}
pub(crate) fn hello() -> Value {
    json!({"daemonId":"test-daemon","lineageId":"test-lineage","protocolVersion":1,"minimumClientProtocolVersion":1,"capabilities":{"independentExecution":true,"sessionPathCandidates":1}})
}
pub(crate) fn report() -> Value {
    json!({"sessionId":"source","cwd":"/synthetic/project","prefix":"R","daemonId":"test-daemon","lineageId":"test-lineage","entries":[{"path":"README 🦀.md","directory":false},{"path":"Reports","directory":true}],"truncated":false})
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
fn setup() -> Server {
    let s = Server::start();
    s.reply("/api/hello", Reply::json(200, hello()));
    s.reply(&route(), Reply::json(200, report()));
    s
}
#[test]
fn exact_source_gets_only_no_fallback_or_background_reads() {
    let s = setup();
    let result = rt()
        .block_on(fetch(&client(), &s.options, &capture()))
        .unwrap();
    assert_eq!(result.entries.len(), 2);
    assert!(s.all_gets());
    let seen = s
        .state
        .lock()
        .unwrap()
        .seen
        .iter()
        .map(|(_, p)| p.clone())
        .collect::<Vec<_>>();
    assert_eq!(
        seen,
        vec!["/api/hello".into(), route(), "/api/hello".into()]
    );
}
#[test]
fn refuses_identity_scope_status_payload_and_capability() {
    for field in ["sessionId", "cwd", "prefix", "daemonId", "lineageId"] {
        let s = setup();
        let mut value = report();
        value[field] = json!("foreign");
        s.reply(&route(), Reply::json(200, value));
        assert!(
            rt().block_on(fetch(&client(), &s.options, &capture()))
                .is_err()
        );
    }
    for status in [302, 404, 409, 429, 503] {
        let s = setup();
        s.reply(&route(), Reply::json(status, json!({})));
        assert!(
            rt().block_on(fetch(&client(), &s.options, &capture()))
                .is_err()
        );
        assert_eq!(s.state.lock().unwrap().seen.len(), 2);
    }
    for path in ["../secret", "/secret", "R/secret", "R//x", "R\\x"] {
        let s = setup();
        let mut v = report();
        v["entries"] = json!([{"path":path,"directory":false}]);
        s.reply(&route(), Reply::json(200, v));
        assert!(
            rt().block_on(fetch(&client(), &s.options, &capture()))
                .is_err()
        );
    }
    let s = setup();
    let mut h = hello();
    h["capabilities"]["sessionPathCandidates"] = Value::Null;
    s.reply("/api/hello", Reply::json(200, h));
    assert!(
        rt().block_on(fetch(&client(), &s.options, &capture()))
            .is_err()
    );
    assert_eq!(s.state.lock().unwrap().seen.len(), 1);
    let s = setup();
    s.reply(
        &route(),
        Reply {
            status: 200,
            bytes: vec![b'x'; 16385],
            chunked: true,
            delay_ms: 0,
        },
    );
    assert!(
        rt().block_on(fetch(&client(), &s.options, &capture()))
            .is_err()
    );
}
#[test]
fn cancellation_replaces_debounce_and_closes_command_lane() {
    let s = setup();
    let (reader, output) = Reader::start(s.options.clone()).unwrap();
    for serial in 1..=50 {
        assert!(reader.request(Request {
            serial,
            capture: Some(capture())
        }));
    }
    assert!(reader.request(Request {
        serial: 51,
        capture: None
    }));
    // Completion is event-driven, not a recurring poll: one explicit final token produces one response.
    assert!(reader.request(Request {
        serial: 52,
        capture: Some(capture())
    }));
    let response = rt().block_on(async {
        tokio::time::timeout(Duration::from_secs(3), output.recv())
            .await
            .unwrap()
            .unwrap()
    });
    assert_eq!(response.serial, 52);
    assert!(response.result.is_ok());
    drop(reader);
    rt().block_on(async {
        assert!(
            tokio::time::timeout(Duration::from_secs(3), output.recv())
                .await
                .unwrap()
                .is_err()
        );
    });
    assert_eq!(s.state.lock().unwrap().seen.len(), 3);
}
