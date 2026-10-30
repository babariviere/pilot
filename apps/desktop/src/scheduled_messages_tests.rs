//! Synthetic stored schedules and owned faux HTTP only.
use crate::mission_browser_fixture::{Reply, Server};
use serde_json::{Value, json};
pub(crate) const NAME: &str = "Research 日本語 👩‍💻 e\u{301} · scheduled follow-up";
pub(crate) fn roster() -> Value {
    json!([
        {"id":"one","revision":1,"title":NAME,"projectId":"project-a","trigger":"at","at":1793381000000u64,"target":{"kind":"message","sessionId":"chat-a","message":"Exact  日本語\n  keep spacing 👩‍💻"},"sessionId":"chat-a","state":"pending","createdAt":1,"updatedAt":1},
        {"id":"two","revision":2,"title":"Failed new chat","projectId":"project-b","trigger":"on_back","target":{"kind":"chat","spawn":{"message":"Investigate","projectId":"project-b","mode":"build"}},"state":"failed","error":"Dispatch interrupted by restart; delivery is uncertain.","createdAt":1,"updatedAt":2},
        {"id":"three","revision":3,"title":"Cancelled","trigger":"removed","target":{"kind":"message","sessionId":"chat-b","message":"Never sent"},"state":"cancelled","createdAt":1,"updatedAt":2}
    ])
}
pub(crate) fn install(s: &Server) {
    s.reply("/api/schedules", Reply::json(200, roster()));
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        scheduled_messages::{Snapshot, State},
        scheduled_messages_reader::{Reader, Request, fetch},
    };
    fn parse(v: Value) -> Result<Snapshot, &'static str> {
        Snapshot::parse(&serde_json::to_vec(&v).unwrap())
    }
    #[test]
    fn exact_records_times_targets_terminal_unknown_and_validation() {
        let snapshot = parse(roster()).unwrap();
        let item = &snapshot.items[0];
        assert_eq!(item.title, NAME);
        assert!(
            item.when(1793382000000)
                .contains("overdue at last read, not dispatched")
        );
        assert!(!item.when(100).contains("overdue"));
        assert!(
            item.details(100)
                .contains("Exact  日本語\n  keep spacing 👩‍💻")
        );
        assert!(item.details(100).contains("Project ID: project-a"));
        assert_eq!(snapshot.items[2].status(), "Cancelled");
        assert!(snapshot.items[1].status().contains("uncertain"));
        assert!(snapshot.items[1].details(100).contains("project-b"));
        for state in [
            "pending",
            "dispatching",
            "fired",
            "failed",
            "cancelled",
            "future",
        ] {
            let mut v = roster();
            v[0]["state"] = json!(state);
            let item = parse(v).unwrap().items.remove(0);
            assert!(!item.status().contains("succeeded"));
            if state == "fired" {
                assert!(item.status().contains("not agent completion"));
            }
            if state == "future" {
                assert_eq!(item.status(), "Unknown");
            }
        }
        for trigger in ["at", "on_wake", "on_online", "on_back", "removed", "future"] {
            let mut v = roster();
            v[0]["trigger"] = json!(trigger);
            assert!(!parse(v).unwrap().items[0].when(100).is_empty());
        }
        for bad in [json!({}), json!([{}]), json!(null)] {
            assert!(parse(bad).is_err());
        }
        let mut v = roster();
        v[1]["id"] = json!("one");
        assert!(parse(v).is_err());
        let mut v = roster();
        v[0]["at"] = json!(-1);
        assert!(parse(v).is_err());
        let mut v = roster();
        v[0]["at"] = json!(8_640_000_000_000_001u64);
        assert!(parse(v).is_err());
        let mut v = roster();
        v[0]["sessionId"] = json!("other");
        assert!(parse(v).is_err());
        let mut v = roster();
        v[0].as_object_mut().unwrap().remove("at");
        assert!(parse(v).is_err());
        assert!(parse(json!(vec![roster()[0].clone(); 1001])).is_err());
        assert!(parse(json!([])).unwrap().items.is_empty());
    }
    #[test]
    fn generation_fences_retained_snapshot_and_timestamp() {
        let mut s = State::default();
        let a = s.begin();
        assert!(s.accept(a, parse(roster()), 100));
        let b = s.begin();
        assert!(!s.accept(a, parse(json!([])), 200));
        assert!(s.busy);
        assert!(s.accept(b, Err("offline"), 300));
        assert_eq!(s.read_at, Some(100));
        assert_eq!(s.snapshot.as_ref().unwrap().items[0].title, NAME);
        let c = s.begin();
        assert!(s.accept(c, parse(json!([])), 400));
        assert!(s.snapshot.unwrap().items.is_empty());
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
    fn passive_transport_refuses_redirect_unavailable_malformed() {
        let s = Server::start();
        install(&s);
        runtime().block_on(async {
            let c = client();
            assert_eq!(fetch(&c, &s.options).await.unwrap().items.len(), 3);
            for code in [302, 403, 404, 503] {
                s.reply("/api/schedules", Reply::json(code, json!({})));
                assert!(fetch(&c, &s.options).await.is_err());
            }
            s.reply("/api/schedules", Reply::json(200, json!([{}])));
            assert!(fetch(&c, &s.options).await.is_err());
        });
        assert!(s.all_gets());
        assert!(
            s.state
                .lock()
                .unwrap()
                .seen
                .iter()
                .all(|(_, p)| p == "/api/hello" || p == "/api/schedules")
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
            .any(|(_, p)| p == "/api/schedules")
        {
            assert!(std::time::Instant::now() < end);
            std::thread::yield_now();
        }
    }
    #[test]
    fn identity_is_checked_on_both_sides_of_read() {
        let s = Server::start();
        let mut r = Reply::json(200, roster());
        r.delay_ms = 200;
        s.reply("/api/schedules", r);
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
    fn budget_rejects_entire_fixed_and_chunked_body() {
        let s = Server::start();
        runtime().block_on(async {
            for chunked in [false, true] {
                let mut v = roster();
                v[0]["title"] = json!("x".repeat(8 * 1024 * 1024));
                let mut r = Reply::json(200, v);
                r.chunked = chunked;
                s.reply("/api/schedules", r);
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
    fn newer_generation_cancels_obsolete_read_without_polling() {
        let s = Server::start();
        let mut r = Reply::json(200, roster());
        r.delay_ms = 500;
        s.reply("/api/schedules", r);
        let (reader, events) = Reader::start(s.options.clone()).unwrap();
        assert!(reader.request(Request { generation: 1 }));
        wait_for_read(&s);
        s.reply("/api/schedules", Reply::json(200, json!([])));
        assert!(reader.request(Request { generation: 2 }));
        let r = events.recv_blocking().unwrap();
        assert_eq!(r.generation, 2);
        assert!(r.result.unwrap().items.is_empty());
        drop(reader);
        assert!(s.all_gets());
    }
}
