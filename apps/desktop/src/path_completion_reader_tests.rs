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

#[test]
fn refusal_keeps_http_status_and_existing_daemon_reason() {
    for (status, reason) in [
        (
            409,
            "Path completion requires the matching active Build workspace",
        ),
        (409, "Path completion daemon identity changed"),
        (409, "Path completion workspace changed"),
        (409, "Ask sessions are read-only"),
        (400, "Symlinks are outside the readable scope"),
        (
            400,
            "EACCES: permission denied, opendir '/synthetic/project/private'",
        ),
        (503, "Path completion reads are busy"),
        (404, "Unknown session"),
    ] {
        let s = setup();
        s.reply(&route(), Reply::json(status, json!({"error": reason})));
        let error = rt()
            .block_on(fetch(&client(), &s.options, &capture()))
            .unwrap_err();
        assert!(error.contains(&format!("HTTP {status}")), "{error}");
        assert!(error.contains(reason), "{error}");
        assert!(s.all_gets());
        assert_eq!(
            s.state.lock().unwrap().seen.len(),
            2,
            "no fallback or retries"
        );
    }
}

#[test]
fn unavailable_capability_and_missing_endpoint_explain_compatibility() {
    let s = setup();
    let mut h = hello();
    h["daemonVersion"] = json!("1.20.0");
    h["capabilities"]["sessionPathCandidates"] = Value::Null;
    s.reply("/api/hello", Reply::json(200, h.clone()));
    let error = rt()
        .block_on(fetch(&client(), &s.options, &capture()))
        .unwrap_err();
    assert!(error.contains("1.20.0"), "{error}");
    assert!(error.contains("Settings → Updates"), "{error}");
    assert_eq!(s.state.lock().unwrap().seen.len(), 1);

    h["capabilities"]["sessionPathCandidates"] = json!(1);
    s.reply("/api/hello", Reply::json(200, h));
    s.reply(&route(), Reply::json(404, json!({"error":"Not found"})));
    let error = rt()
        .block_on(fetch(&client(), &s.options, &capture()))
        .unwrap_err();
    assert!(error.contains("HTTP 404"), "{error}");
    assert!(error.contains("Settings → Updates"), "{error}");
    assert!(error.contains("1.20.0"), "{error}");
    assert!(s.all_gets());
    assert_eq!(s.state.lock().unwrap().seen.len(), 3);
}

#[test]
fn malformed_refusals_keep_status_and_untrusted_text_stays_bounded() {
    for body in [json!({}), json!({"error":42}), json!({"error":""})] {
        let s = setup();
        s.reply(&route(), Reply::json(409, body));
        let error = rt()
            .block_on(fetch(&client(), &s.options, &capture()))
            .unwrap_err();
        assert!(error.contains("HTTP 409"), "{error}");
        assert!(error.contains("No reason returned"), "{error}");
    }
    let s = setup();
    s.reply(
        &route(),
        Reply {
            status: 503,
            bytes: b"not json".to_vec(),
            chunked: false,
            delay_ms: 0,
        },
    );
    assert!(
        rt().block_on(fetch(&client(), &s.options, &capture()))
            .unwrap_err()
            .contains("HTTP 503")
    );
    s.reply(
        &route(),
        Reply::json(
            409,
            json!({"error":format!("に\n\u{1b}{}", "界".repeat(1000))}),
        ),
    );
    let error = rt()
        .block_on(fetch(&client(), &s.options, &capture()))
        .unwrap_err();
    assert!(error.chars().count() < 650);
    assert!(error.contains('に'));
    assert!(error.contains("に "));
    assert!(!error.chars().any(char::is_control));
    assert!(error.ends_with('…'));
    for chunked in [false, true] {
        s.reply(
            &route(),
            Reply {
                status: 409,
                bytes: vec![b'x'; 16385],
                chunked,
                delay_ms: 0,
            },
        );
        assert!(
            rt().block_on(fetch(&client(), &s.options, &capture()))
                .unwrap_err()
                .contains("exceeded")
        );
    }
}

#[test]
fn malformed_success_never_becomes_candidates_or_a_refusal_reason() {
    for patch in [
        json!({"entries":null}),
        json!({"entries":[{"path":"README","directory":"false"}]}),
        json!({"truncated":null}),
    ] {
        let s = setup();
        let mut body = report();
        body.as_object_mut()
            .unwrap()
            .extend(patch.as_object().unwrap().clone());
        s.reply(&route(), Reply::json(200, body));
        assert!(
            rt().block_on(fetch(&client(), &s.options, &capture()))
                .is_err()
        );
        assert_eq!(s.state.lock().unwrap().seen.len(), 2);
    }
    let s = setup();
    s.reply(
        &route(),
        Reply {
            status: 200,
            bytes: b"not json".to_vec(),
            chunked: false,
            delay_ms: 0,
        },
    );
    assert_eq!(
        rt().block_on(fetch(&client(), &s.options, &capture()))
            .unwrap_err(),
        "Invalid path response."
    );
}
