//! Synthetic contracts only. No real MCP transports, browser, credentials or account calls.
#[cfg(test)]
use crate::mission_browser_fixture::{Reply, Server};
use serde_json::{Value, json};

pub(crate) const NAME: &str =
    "Research 日本語 👩‍💻 e\u{301} · repository tools and engineering knowledge";
pub(crate) fn roster() -> Value {
    json!({"checking":false,"configProblems":1,"servers":[
        {"name":NAME,"transport":"http","state":"connected","tools":12,"canSignIn":true,"checkedAt":1793381000000u64},
        {"name":"Linear","transport":"http","state":"needs_sign_in","canSignIn":true,"checkedAt":1793381000000u64},
        {"name":"Local tools","transport":"stdio","state":"failed","problem":"Couldn't start the server.","checkedAt":1793381000000u64},
        {"name":"Provider login","transport":"http","state":"unknown","problem":"Signs in with a model provider login. Check it in pi.","checkedAt":1793381000000u64},
        {"name":"Disabled","transport":"stdio","state":"disabled","checkedAt":1793381000000u64}
    ]})
}
#[cfg(test)]
fn install(s: &Server) {
    s.reply("/api/mcp", Reply::json(200, roster()));
}
/// Owned faux Local for MCP actions: records method, decoded path and body; never a real daemon.
#[derive(Clone)]
pub(crate) struct Answer {
    pub(crate) status: u16,
    pub(crate) body: String,
    pub(crate) delay_ms: u64,
    /// Read the request, then close without answering (a lost ACK).
    pub(crate) lost: bool,
}
impl Answer {
    pub(crate) fn json(status: u16, value: Value) -> Self {
        Self {
            status,
            body: value.to_string(),
            delay_ms: 0,
            lost: false,
        }
    }
    pub(crate) fn lost() -> Self {
        Self {
            lost: true,
            ..Self::json(200, Value::Null)
        }
    }
}
type Routes = std::collections::HashMap<(String, String), Answer>;
pub(crate) struct Daemon {
    pub(crate) options: crate::LocalOptions,
    routes: std::sync::Arc<std::sync::Mutex<Routes>>,
    identity: std::sync::Arc<std::sync::Mutex<String>>,
    /// (method, percent-decoded path, body) of every request, hello included.
    pub(crate) seen: std::sync::Arc<std::sync::Mutex<Vec<(String, String, String)>>>,
}
pub(crate) fn decode(path: &str) -> String {
    let bytes = path.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && let Some(byte) = path
                .get(i + 1..i + 3)
                .and_then(|h| u8::from_str_radix(h, 16).ok())
        {
            out.push(byte);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).unwrap()
}
pub(crate) fn sign_in_path(name: &str) -> String {
    format!("/api/mcp/servers/{name}/sign-in")
}
pub(crate) fn waiting(started_at: u64) -> Value {
    json!({"state":"waiting","startedAt":started_at,"expiresAt":started_at + 300_000})
}
impl Daemon {
    pub(crate) fn start() -> Self {
        use std::io::{BufRead, Read, Write};
        let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
        let daemon = Self {
            options: crate::LocalOptions::synthetic(listener.local_addr().unwrap().port()),
            routes: Default::default(),
            identity: std::sync::Arc::new(std::sync::Mutex::new("test-daemon".into())),
            seen: Default::default(),
        };
        daemon.reply("GET", "/api/mcp", Answer::json(200, roster()));
        let (routes, identity, seen) = (
            daemon.routes.clone(),
            daemon.identity.clone(),
            daemon.seen.clone(),
        );
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let (routes, identity, seen) = (routes.clone(), identity.clone(), seen.clone());
                std::thread::spawn(move || {
                    let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(5)));
                    let mut reader = std::io::BufReader::new(&mut stream);
                    let mut first = String::new();
                    if reader.read_line(&mut first).unwrap_or(0) == 0 {
                        return;
                    }
                    let mut parts = first.split_whitespace();
                    let method = parts.next().unwrap_or_default().to_string();
                    let path = decode(parts.next().unwrap_or_default());
                    let mut length = 0;
                    loop {
                        let mut line = String::new();
                        if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                            break;
                        }
                        if let Some(n) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                            length = n.trim().parse().unwrap_or(0);
                        }
                    }
                    let mut body = vec![0; length];
                    let _ = reader.read_exact(&mut body);
                    {
                        let mut seen = seen.lock().unwrap();
                        assert!(seen.len() < 512, "bounded faux request budget");
                        seen.push((
                            method.clone(),
                            path.clone(),
                            String::from_utf8_lossy(&body).into(),
                        ));
                    }
                    let answer = if path == "/api/hello" {
                        Answer::json(
                            200,
                            json!({"daemonId":*identity.lock().unwrap(),"lineageId":"test-lineage","protocolVersion":1,"minimumClientProtocolVersion":1,"capabilities":{"independentExecution":true}}),
                        )
                    } else {
                        routes
                            .lock()
                            .unwrap()
                            .get(&(method, path))
                            .cloned()
                            .unwrap_or_else(|| {
                                Answer::json(404, json!({"error":"Unknown MCP operation"}))
                            })
                    };
                    std::thread::sleep(std::time::Duration::from_millis(answer.delay_ms));
                    if answer.lost {
                        return;
                    }
                    let _ = write!(
                        stream,
                        "HTTP/1.1 {} Synthetic\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        answer.status,
                        answer.body.len(),
                        answer.body
                    );
                });
            }
        });
        daemon
    }
    pub(crate) fn reply(&self, method: &str, path: &str, answer: Answer) {
        self.routes
            .lock()
            .unwrap()
            .insert((method.into(), path.into()), answer);
    }
    pub(crate) fn identity(&self, daemon: &str) {
        *self.identity.lock().unwrap() = daemon.into();
    }
    /// Requests other than hello and the passive status read.
    pub(crate) fn actions(&self) -> Vec<(String, String, String)> {
        self.seen
            .lock()
            .unwrap()
            .iter()
            .filter(|(m, p, _)| !(m == "GET" && (p == "/api/hello" || p == "/api/mcp")))
            .cloned()
            .collect()
    }
    pub(crate) fn reads(&self) -> usize {
        self.seen
            .lock()
            .unwrap()
            .iter()
            .filter(|(m, p, _)| m == "GET" && p == "/api/mcp")
            .count()
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        mcp_status::{Snapshot, State, Status},
        mcp_status_reader::{Reader, Request, fetch},
    };
    fn parse(v: Value) -> Result<Snapshot, &'static str> {
        Snapshot::parse(&serde_json::to_vec(&v).unwrap())
    }
    #[test]
    fn roster_is_complete_unique_bounded_and_does_not_infer_connected() {
        let snapshot = parse(roster()).unwrap();
        assert_eq!(snapshot.servers[0].name, NAME);
        assert_eq!(snapshot.servers[0].label(), "Reported connected");
        assert!(
            snapshot.servers[0]
                .details()
                .contains("Account: not reported")
        );
        assert!(snapshot.servers[0].details().contains("Tools: 12"));
        let mut v = roster();
        v["servers"][0].as_object_mut().unwrap().remove("checkedAt");
        assert_eq!(
            parse(v.clone()).unwrap().servers[0].label(),
            "Unknown · no completed check"
        );
        v["servers"][0]["state"] = json!("future-state");
        assert_eq!(parse(v).unwrap().servers[0].state, Status::Unknown);
        for bad in [
            json!({"servers":[]}),
            json!({"servers":[{"name":"configured"}],"checking":false}),
            json!({"servers":[],"checking":"false"}),
        ] {
            assert!(parse(bad).is_err());
        }
        let mut v = roster();
        v["servers"][1]["name"] = json!(NAME);
        assert!(parse(v).is_err());
        let mut v = roster();
        v["servers"][0]["tools"] = json!(-1);
        assert!(parse(v).is_err());
        let mut v = roster();
        v["servers"] = json!(
            (0..65)
                .map(|i| json!({"name":i.to_string(),"transport":"http","state":"unknown"}))
                .collect::<Vec<_>>()
        );
        assert!(parse(v).is_err());
    }
    #[test]
    fn generation_fences_retained_snapshot_error_and_timestamp() {
        let mut s = State::default();
        let a = s.begin();
        assert!(s.accept(a, parse(roster()), 100));
        let b = s.begin();
        assert!(!s.accept(a, parse(json!({"checking":false,"servers":[]})), 200));
        assert!(s.busy);
        assert!(s.accept(b, Err("offline"), 300));
        assert_eq!(s.read_at, Some(100));
        assert_eq!(s.snapshot.as_ref().unwrap().servers[0].name, NAME);
        assert_eq!(s.error, Some("offline"));
        let c = s.begin();
        assert!(s.accept(c, parse(json!({"checking":false,"servers":[]})), 400));
        assert!(s.snapshot.unwrap().servers.is_empty());
        assert_eq!(s.read_at, Some(400));
        assert!(s.error.is_none());
    }
    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
    }
    fn client() -> reqwest::Client {
        reqwest::Client::builder()
            .no_proxy()
            .retry(reqwest::retry::never())
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap()
    }
    #[test]
    fn transport_is_only_passive_get_and_refuses_redirect_unavailable_malformed() {
        let s = Server::start();
        install(&s);
        runtime().block_on(async {
            let c = client();
            assert_eq!(fetch(&c, &s.options).await.unwrap().servers.len(), 5);
            for code in [302, 403, 404, 503] {
                s.reply("/api/mcp", Reply::json(code, json!({})));
                assert!(fetch(&c, &s.options).await.is_err());
            }
            s.reply(
                "/api/mcp",
                Reply::json(200, json!({"servers":[],"checking":null})),
            );
            assert!(fetch(&c, &s.options).await.is_err());
        });
        assert!(s.all_gets());
        assert!(
            s.state
                .lock()
                .unwrap()
                .seen
                .iter()
                .all(|(_, p)| p == "/api/hello" || p == "/api/mcp")
        );
    }
    fn wait_for_read(s: &Server) {
        let end = std::time::Instant::now() + std::time::Duration::from_secs(3);
        while !s
            .state
            .lock()
            .unwrap()
            .seen
            .iter()
            .any(|(_, p)| p == "/api/mcp")
        {
            assert!(std::time::Instant::now() < end);
            std::thread::yield_now();
        }
    }
    #[test]
    fn identity_is_rechecked_after_read_and_before_any_status_read() {
        let s = Server::start();
        let mut reply = Reply::json(200, roster());
        reply.delay_ms = 200;
        s.reply("/api/mcp", reply);
        let o = s.options.clone();
        let read = std::thread::spawn(move || runtime().block_on(fetch(&client(), &o)));
        wait_for_read(&s);
        s.reply(
            "/api/hello",
            Reply::json(
                200,
                json!({"daemonId":"different","lineageId":"test-lineage"}),
            ),
        );
        assert!(read.join().unwrap().is_err());
        s.state.lock().unwrap().seen.clear();
        assert!(runtime().block_on(fetch(&client(), &s.options)).is_err());
        assert_eq!(
            s.state.lock().unwrap().seen.as_slice(),
            &[("GET".into(), "/api/hello".into())]
        );
    }
    #[test]
    fn response_budget_rejects_whole_fixed_or_chunked_roster() {
        let s = Server::start();
        runtime().block_on(async {
            for chunked in [false, true] {
                let mut v = roster();
                v["servers"][0]["name"] = json!("x".repeat(2 * 1024 * 1024));
                let mut r = Reply::json(200, v);
                r.chunked = chunked;
                s.reply("/api/mcp", r);
                assert!(
                    fetch(&client(), &s.options)
                        .await
                        .unwrap_err()
                        .contains("budget")
                );
            }
        });
    }
    #[test]
    fn replacement_cancels_old_read_without_polling_or_mutation() {
        let s = Server::start();
        let mut r = Reply::json(200, roster());
        r.delay_ms = 500;
        s.reply("/api/mcp", r);
        let (reader, events) = Reader::start(s.options.clone()).unwrap();
        assert!(reader.request(Request { generation: 1 }));
        wait_for_read(&s);
        s.reply(
            "/api/mcp",
            Reply::json(200, json!({"checking":true,"servers":[]})),
        );
        assert!(reader.request(Request { generation: 2 }));
        let response = events.recv_blocking().unwrap();
        assert_eq!(response.generation, 2);
        assert!(response.result.unwrap().checking);
        drop(reader);
        assert!(s.all_gets());
    }
    use crate::{
        mcp_status::{RowAction, SignInStatus},
        mcp_status_reader::{Act, Outcome, act},
    };
    fn with_sign_in(name: &str, sign_in: Value) -> Value {
        let mut v = roster();
        for s in v["servers"].as_array_mut().unwrap() {
            if s["name"] == name {
                s["signIn"] = sign_in.clone();
            }
        }
        v
    }
    #[test]
    fn sign_in_state_maps_to_one_truthful_row_action() {
        let s = parse(roster()).unwrap();
        assert_eq!(s.servers[1].action(), Some(RowAction::SignIn));
        assert_eq!(s.servers[0].action(), None);
        assert!(s.servers[0].can_sign_in_again());
        assert_eq!(s.servers[2].action(), Some(RowAction::CheckAgain));
        assert_eq!(s.servers[3].action(), None);
        assert!(s.servers[0].details().contains("Account: not reported"));
        let mut v = roster();
        v["servers"][1]["canSignIn"] = json!(false);
        let manual = &parse(v).unwrap().servers[1];
        assert_eq!(manual.action(), None);
        assert!(manual.hint().is_some_and(|h| h.contains("pi mcp login")));
        assert!(manual.needs_you());
        let s = parse(roster()).unwrap();
        let needs: Vec<_> = s
            .servers
            .iter()
            .filter(|s| s.needs_you())
            .map(|s| s.name.as_str())
            .collect();
        assert_eq!(needs, ["Linear", "Local tools"]);
        assert_eq!(s.servers[0].status().0, "12 tools");
        assert_eq!(s.servers[4].status().0, "Off");
        assert!(
            s.servers[0]
                .details()
                .starts_with("State: Reported connected")
        );
        let s = parse(with_sign_in("Linear", waiting(7))).unwrap();
        assert_eq!(s.servers[1].action(), Some(RowAction::Cancel(7)));
        assert!(s.servers[1].status().0.starts_with("Waiting"));
        assert!(
            s.servers[1].sign_in_line().is_none(),
            "status already says waiting"
        );
        assert!(s.servers[1].details().contains("expires"));
        // Done is reported by the sign-in itself, never inferred from a connected row.
        let done = json!({"state":"done","startedAt":7,"expiresAt":9,"finishedAt":8});
        let s = parse(with_sign_in("Linear", done)).unwrap();
        assert_eq!(
            s.servers[1].sign_in.as_ref().unwrap().state,
            SignInStatus::Done
        );
        assert!(
            s.servers[1]
                .sign_in_line()
                .unwrap()
                .0
                .starts_with("Signed in")
        );
        assert!(parse(roster()).unwrap().servers[0].sign_in_line().is_none());
        let failed = json!({"state":"failed","startedAt":7,"expiresAt":9,"finishedAt":8,"error":"Sign-in timed out. Try again."});
        let s = parse(with_sign_in("Linear", failed.clone())).unwrap();
        assert_eq!(
            s.servers[1].sign_in_line().unwrap().0,
            "Sign-in timed out. Try again."
        );
        assert_eq!(s.servers[1].action(), Some(RowAction::SignIn));
        let s = parse(with_sign_in(NAME, failed)).unwrap();
        assert!(s.servers[0].sign_in_line().is_none());
        assert!(s.servers[0].details().contains("timed out"));
        for bad in [
            json!({"state":"waiting","startedAt":9_007_199_254_740_992u64,"expiresAt":1}),
            json!({"state":"waiting"}),
            json!({"state":"waiting","startedAt":1.5,"expiresAt":2}),
        ] {
            assert!(parse(with_sign_in("Linear", bad)).is_err());
        }
    }
    #[test]
    fn sign_in_ack_never_regresses_a_newer_report_and_push_replaces_reads() {
        let mut s = State::default();
        let g = s.begin();
        s.accept(
            g,
            parse(with_sign_in(
                "Linear",
                json!({"state":"done","startedAt":7,"expiresAt":9,"finishedAt":8}),
            )),
            1,
        );
        let ack: crate::mcp_status::SignIn = serde_json::from_value(waiting(7)).unwrap();
        s.record_sign_in("Linear", ack.clone());
        assert_eq!(
            s.snapshot.as_ref().unwrap().servers[1]
                .sign_in
                .as_ref()
                .unwrap()
                .state,
            SignInStatus::Done
        );
        s.record_sign_in("Missing", ack);
        let newer: crate::mcp_status::SignIn = serde_json::from_value(waiting(10)).unwrap();
        s.record_sign_in("Linear", newer.clone());
        assert_eq!(s.snapshot.as_ref().unwrap().servers[1].sign_in, Some(newer));
        let read = s.begin();
        s.adopt(parse(json!({"checking":true,"servers":[]})), 5);
        assert!(!s.busy);
        assert!(!s.accept(read, parse(roster()), 6));
        assert!(s.snapshot.as_ref().unwrap().servers.is_empty());
        assert_eq!(s.read_at, Some(5));
    }
    fn run(d: &Daemon, a: Act) -> Outcome {
        runtime().block_on(act(&client(), &d.options, &a))
    }
    #[test]
    fn actions_use_exact_existing_routes_bodies_and_identity() {
        let d = Daemon::start();
        d.reply("POST", &sign_in_path(NAME), Answer::json(200, waiting(41)));
        let Outcome::SignIn(Some(ack)) = run(
            &d,
            Act::SignIn {
                server: NAME.into(),
                again: true,
            },
        ) else {
            panic!()
        };
        assert_eq!(ack.started_at, 41);
        d.reply(
            "DELETE",
            &sign_in_path(NAME),
            Answer::json(
                200,
                json!({"state":"cancelled","startedAt":41,"expiresAt":9,"finishedAt":42}),
            ),
        );
        let Outcome::SignIn(Some(ack)) = run(
            &d,
            Act::Cancel {
                server: NAME.into(),
                started_at: 41,
            },
        ) else {
            panic!()
        };
        assert_eq!(ack.state, SignInStatus::Cancelled);
        d.reply(
            "DELETE",
            &sign_in_path(NAME),
            Answer::json(200, Value::Null),
        );
        assert!(matches!(
            run(
                &d,
                Act::Cancel {
                    server: NAME.into(),
                    started_at: 41
                }
            ),
            Outcome::SignIn(None)
        ));
        let mut checking = roster();
        checking["checking"] = json!(true);
        d.reply("POST", "/api/mcp/check", Answer::json(200, checking));
        assert!(matches!(run(&d, Act::Check { server: None }), Outcome::Status(s) if s.checking));
        assert!(matches!(
            run(
                &d,
                Act::Check {
                    server: Some("Local tools".into())
                }
            ),
            Outcome::Status(_)
        ));
        let seen = d.seen.lock().unwrap().clone();
        let path = sign_in_path(NAME);
        assert_eq!(
            d.actions(),
            vec![
                ("POST".into(), path.clone(), r#"{"again":true}"#.into()),
                (
                    "DELETE".into(),
                    path.clone(),
                    r#"{"expectedStartedAt":41}"#.into()
                ),
                ("DELETE".into(), path, r#"{"expectedStartedAt":41}"#.into()),
                ("POST".into(), "/api/mcp/check".into(), "{}".into()),
                (
                    "POST".into(),
                    "/api/mcp/check".into(),
                    r#"{"server":"Local tools"}"#.into()
                ),
            ]
        );
        // Every action is bracketed by identity checks; no status read is implied.
        assert_eq!(
            seen.iter().filter(|(_, p, _)| p == "/api/hello").count(),
            10
        );
        assert_eq!(d.reads(), 0);
    }
    #[test]
    fn refusals_lost_acks_and_identity_changes_are_never_replayed() {
        let d = Daemon::start();
        let path = sign_in_path("Linear");
        let sign_in = || Act::SignIn {
            server: "Linear".into(),
            again: false,
        };
        d.reply("POST", &path, Answer::lost());
        assert!(matches!(run(&d, sign_in()), Outcome::Unconfirmed(_)));
        assert_eq!(d.actions().len(), 1, "a lost ACK is not retried");
        for (code, text) in [
            (409, "isn’t available"),
            (404, "doesn’t report"),
            (503, "unavailable"),
            (400, "refused"),
        ] {
            d.reply("POST", &path, Answer::json(code, json!({"error":"x"})));
            assert!(matches!(run(&d, sign_in()), Outcome::Refused(t) if t.contains(text)));
        }
        d.reply("POST", &path, Answer::json(500, json!({})));
        assert!(matches!(run(&d, sign_in()), Outcome::Unconfirmed(_)));
        d.reply("POST", &path, Answer::json(200, json!({"state":"waiting"})));
        assert!(matches!(run(&d, sign_in()), Outcome::Unconfirmed(_)));
        d.reply(
            "DELETE",
            &path,
            Answer::json(409, json!({"error":"Sign-in changed"})),
        );
        assert!(
            matches!(run(&d, Act::Cancel { server: "Linear".into(), started_at: 3 }), Outcome::Refused(t) if t.contains("changed"))
        );
        // Changed identity after the request leaves it unconfirmed.
        let mut slow = Answer::json(200, waiting(5));
        slow.delay_ms = 300;
        d.reply("POST", &path, slow);
        let (o, a) = (d.options.clone(), sign_in());
        let pending = std::thread::spawn(move || runtime().block_on(act(&client(), &o, &a)));
        let end = std::time::Instant::now() + std::time::Duration::from_secs(3);
        while d.actions().len() < 9 {
            assert!(std::time::Instant::now() < end);
            std::thread::yield_now();
        }
        d.identity("different");
        assert!(matches!(pending.join().unwrap(), Outcome::Unconfirmed(_)));
        // A different daemon before sending: nothing is sent at all.
        let before = d.actions().len();
        assert!(
            matches!(run(&d, sign_in()), Outcome::Refused(t) if t.contains("Nothing was sent"))
        );
        assert_eq!(d.actions().len(), before);
        assert_eq!(d.reads(), 0);
    }
    #[test]
    fn offline_daemon_sends_nothing() {
        let port = std::net::TcpListener::bind(("127.0.0.1", 0))
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let options = crate::LocalOptions::synthetic(port);
        let outcome = runtime().block_on(act(&client(), &options, &Act::Check { server: None }));
        assert!(matches!(outcome, Outcome::Refused(_)));
    }
}
