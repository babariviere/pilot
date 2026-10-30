//! Synthetic contracts only. No real MCP transports, credentials or account calls.
use crate::mission_browser_fixture::{Reply, Server};
use serde_json::{Value, json};

pub(crate) const NAME: &str =
    "Research 日本語 👩‍💻 e\u{301} · repository tools and engineering knowledge";
pub(crate) fn roster() -> Value {
    json!({"checking":false,"configProblems":1,"servers":[
        {"name":NAME,"transport":"http","state":"connected","tools":12,"checkedAt":1793381000000u64},
        {"name":"Linear","transport":"http","state":"needs_sign_in","checkedAt":1793381000000u64},
        {"name":"Local tools","transport":"stdio","state":"failed","problem":"Couldn't start the server.","checkedAt":1793381000000u64},
        {"name":"Provider login","transport":"http","state":"unknown","problem":"Signs in with a model provider login. Check it in pi.","checkedAt":1793381000000u64},
        {"name":"Disabled","transport":"stdio","state":"disabled","checkedAt":1793381000000u64}
    ]})
}
pub(crate) fn install(s: &Server) {
    s.reply("/api/mcp", Reply::json(200, roster()));
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
}
