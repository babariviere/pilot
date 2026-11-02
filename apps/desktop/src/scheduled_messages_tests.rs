//! Synthetic stored schedules and owned faux HTTP only.
#[cfg(test)]
use crate::mission_browser_fixture::{Reply, Server};
use serde_json::{Value, json};
pub(crate) const NAME: &str = "Research 日本語 👩‍💻 e\u{301} · scheduled follow-up";
pub(crate) const MESSAGE: &str = "Exact  日本語\n  keep spacing 👩‍💻";
const DAY: u64 = 86_400_000;
/// Every state the store reports. Times are relative to `now` so rows read naturally.
pub(crate) fn roster_at(now: u64) -> Value {
    json!([
        {"id":"one","revision":1,"title":NAME,"projectId":"project-a","trigger":"at","at":now + DAY,"target":{"kind":"message","sessionId":"chat-a","message":MESSAGE},"state":"pending","createdAt":1,"updatedAt":1},
        {"id":"two","revision":2,"title":"Failed new chat","projectId":"project-b","trigger":"at","at":now - DAY,"target":{"kind":"chat","spawn":{"message":"Investigate","projectId":"project-b","mode":"build"}},"state":"failed","error":"Dispatch interrupted by restart; delivery is uncertain.","createdAt":1,"updatedAt":2},
        {"id":"three","revision":3,"title":"Cancelled","trigger":"removed","target":{"kind":"message","sessionId":"chat-b","message":"Never sent"},"state":"cancelled","createdAt":1,"updatedAt":2},
        {"id":"four","revision":1,"title":"Weekly check","projectId":"project-a","trigger":"at","at":now + 3 * DAY,"target":{"kind":"chat","spawn":{"message":"Run the weekly check","projectId":"project-a"}},"state":"pending","createdAt":1,"updatedAt":1},
        {"id":"five","revision":4,"title":"Sent","trigger":"at","at":now - 2 * DAY,"target":{"kind":"message","sessionId":"chat-a","message":"Already sent"},"sessionId":"chat-a","state":"fired","createdAt":1,"updatedAt":4,"firedAt":now - 2 * DAY},
        {"id":"six","revision":2,"title":"Sending","trigger":"at","at":now - 60_000,"target":{"kind":"message","sessionId":"chat-gone","message":"In flight"},"state":"dispatching","createdAt":1,"updatedAt":2,"claimedAt":now - 30_000}
    ])
}
/// Midnight UTC, Tuesday 3 November 2026.
#[cfg(test)]
pub(crate) const TUESDAY: u64 = 20_760 * DAY;
#[cfg(test)]
pub(crate) fn roster() -> Value {
    roster_at(TUESDAY + 10 * 3_600_000)
}
#[cfg(test)]
pub(crate) fn install(s: &Server) {
    s.reply("/api/schedules", Reply::json(200, roster()));
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        scheduled_messages::{RowAction, Section, Snapshot, State, Status, words},
        scheduled_messages_reader::{Outcome, Reader, Request, act, fetch},
    };
    fn parse(v: Value) -> Result<Snapshot, &'static str> {
        Snapshot::parse(&serde_json::to_vec(&v).unwrap())
    }
    #[test]
    fn local_time_in_words() {
        let utc = |_| 0;
        let now = TUESDAY + 10 * 3_600_000;
        let h = 3_600_000;
        assert_eq!(words(TUESDAY + 18 * h, now, utc), "Today at 18:00");
        assert_eq!(words(TUESDAY + DAY + 8 * h, now, utc), "Tomorrow at 08:00");
        assert_eq!(words(TUESDAY + 3 * DAY + 9 * h, now, utc), "Fri at 09:00");
        assert_eq!(
            words(TUESDAY + 10 * DAY + 9 * h, now, utc),
            "13 Nov at 09:00"
        );
        // The local offset decides the day: 23:30 UTC is tomorrow in UTC+1.
        assert_eq!(
            words(TUESDAY + 23 * h + h / 2, now, |_| 3600),
            "Tomorrow at 00:30"
        );
    }
    #[test]
    fn sections_statuses_actions_and_technical_details() {
        let read_at = TUESDAY + 10 * 3_600_000;
        let snapshot = parse(roster()).unwrap();
        let one_time: Vec<_> = snapshot
            .section(Section::OneTime)
            .iter()
            .map(|s| s.id.as_str())
            .collect();
        // By due time; sent and cancelled history stays off the page.
        assert_eq!(one_time, ["six", "one", "four"]);
        let attention: Vec<_> = snapshot
            .section(Section::Attention)
            .iter()
            .map(|s| s.id.as_str())
            .collect();
        assert_eq!(attention, ["two"]);
        let item = |id: &str| snapshot.items.iter().find(|s| s.id == id).unwrap();
        assert_eq!(item("one").status(read_at), None);
        assert_eq!(item("one").action(), Some(RowAction::Cancel));
        assert_eq!(item("one").message(), MESSAGE);
        assert_eq!(item("two").status(read_at), Some(Status::Failed));
        assert_eq!(item("two").action(), Some(RowAction::Dismiss));
        assert_eq!(item("two").new_chat_project(), Some("project-b"));
        assert_eq!(item("six").status(read_at), Some(Status::Sending));
        assert_eq!(item("six").action(), None);
        assert_eq!(
            item("one").status(item("one").at.unwrap()),
            Some(Status::Overdue)
        );
        assert_eq!(item("three").when(read_at), "No time");
        let technical = item("one").technical();
        for line in [
            "Schedule ID: one",
            "Revision: 1",
            "State: pending",
            "Target chat ID: chat-a",
            "Project ID: project-a",
            "Scheduled: 2026-11-04 10:00:00 UTC",
        ] {
            assert!(technical.contains(line), "{line} in {technical}");
        }
        assert!(
            item("two")
                .technical()
                .contains("\"projectId\":\"project-b\"")
        );
        assert!(item("six").technical().contains("Claimed: "));
    }
    #[test]
    fn validation_rejects_the_whole_report() {
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
        let mut v = roster();
        v[0]["state"] = json!("future");
        let item = parse(v).unwrap().items.remove(0);
        assert_eq!((item.section(), item.action()), (None, None));
        let mut v = roster();
        v[0]["trigger"] = json!("recurring");
        v[0]["recurrence"] =
            json!({"every":"week","time":"09:00","timeZone":"Europe/Paris","weekdays":[1]});
        assert_eq!(parse(v).unwrap().items[0].section(), None);
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
            assert_eq!(fetch(&c, &s.options).await.unwrap().items.len(), 6);
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
    fn seen(s: &Server) -> Vec<(String, String)> {
        std::mem::take(&mut s.state.lock().unwrap().seen)
    }
    #[test]
    fn cancel_and_dismiss_check_the_shown_record_then_delete_once() {
        let s = Server::start();
        let one = roster()[0].clone();
        let two = roster()[1].clone();
        s.reply("GET /api/schedules/one", Reply::json(200, one.clone()));
        s.reply(
            "DELETE /api/schedules/one",
            Reply::json(200, json!({"ok": true})),
        );
        s.reply("GET /api/schedules/two", Reply::json(200, two));
        s.reply(
            "DELETE /api/schedules/two",
            Reply::json(200, json!({"ok": true})),
        );
        let rt = runtime();
        let c = client();
        let run =
            |id: &str, revision, action| rt.block_on(act(&c, &s.options, id, revision, action));
        assert_eq!(run("one", 1, RowAction::Cancel), Outcome::Done);
        let path = |m: &str, p: &str| (m.to_owned(), p.to_owned());
        assert_eq!(
            seen(&s),
            [
                path("GET", "/api/hello"),
                path("GET", "/api/schedules/one"),
                path("DELETE", "/api/schedules/one"),
                path("GET", "/api/hello"),
            ]
        );
        assert_eq!(run("two", 2, RowAction::Dismiss), Outcome::Done);
        seen(&s);
        // A changed revision or state sends nothing.
        for (id, revision, action) in [
            ("one", 2, RowAction::Cancel),
            ("one", 1, RowAction::Dismiss),
            ("two", 2, RowAction::Cancel),
        ] {
            assert!(matches!(run(id, revision, action), Outcome::Refused(_)));
            assert!(seen(&s).iter().all(|(m, _)| m == "GET"));
        }
        assert!(matches!(
            run("../one", 1, RowAction::Cancel),
            Outcome::Refused(_)
        ));
        assert!(seen(&s).is_empty());
        s.reply("GET /api/schedules/one", Reply::json(404, json!({})));
        assert!(matches!(
            run("one", 1, RowAction::Cancel),
            Outcome::Refused(_)
        ));
        assert!(seen(&s).iter().all(|(m, _)| m == "GET"));
        s.reply("GET /api/schedules/one", Reply::json(200, one));
        s.reply("DELETE /api/schedules/one", Reply::json(409, json!({})));
        assert!(matches!(
            run("one", 1, RowAction::Cancel),
            Outcome::Refused(_)
        ));
        // Anything else after sending is unconfirmed, never retried.
        for reply in [
            Reply::json(500, json!({})),
            Reply::json(400, json!({})),
            Reply::json(200, json!({})),
        ] {
            s.reply("DELETE /api/schedules/one", reply);
            seen(&s);
            assert!(matches!(
                run("one", 1, RowAction::Cancel),
                Outcome::Unconfirmed(_)
            ));
            assert_eq!(seen(&s).iter().filter(|(m, _)| m == "DELETE").count(), 1);
        }
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
        assert!(matches!(
            runtime().block_on(act(&client(), &s.options, "one", 1, RowAction::Cancel)),
            Outcome::Refused(_)
        ));
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
