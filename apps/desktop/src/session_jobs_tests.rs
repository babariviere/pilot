use super::*;
use serde_json::json;

fn job(id: &str, name: &str, started: i64) -> serde_json::Value {
    json!({"id":id,"name":name,"state":"running","startedAt":started,"outputPath":format!("/home/u/.jobs/{id}.log")})
}

#[test]
fn reads_running_jobs_in_server_order_and_skips_what_it_cannot_name() {
    let long = "日本 👩‍💻 build ".repeat(40);
    let jobs = read(&json!({"runningJobs":[
        job("b", "cargo test", 20),
        job("a", &long, 10),
        job("b", "duplicate", 5),
        {"id":"c","name":"no start"},
        {"name":"no id","startedAt":1},
        {"id":"d","name":"done","state":"exited","startedAt":1},
        {"id":"e","name":"","startedAt":3.7},
    ]}));
    assert_eq!(
        jobs.iter().map(|j| j.id.as_str()).collect::<Vec<_>>(),
        ["b", "a", "e"]
    );
    assert_eq!(jobs[0].name, "cargo test");
    assert!(jobs[1].name.ends_with('…') && jobs[1].name.len() <= 240);
    assert_eq!(jobs[2].name, "e", "an unnamed job shows its ID");
    assert_eq!(jobs[2].started_at, 3);
    assert_eq!(oldest(&jobs).unwrap().id, "e");
    assert!(read(&json!({})).is_empty());
    assert!(read(&json!({"runningJobs":{}})).is_empty());
}

#[test]
fn chat_summary_carries_jobs() {
    let chat = crate::local_model::chat(
        &json!({"id":"s","state":"idle","runningJobs":[job("j","tests",1)]}),
    )
    .unwrap();
    assert_eq!(chat.running_jobs.len(), 1);
    assert!(chat.background_work);
    let idle = crate::local_model::chat(&json!({"id":"s","state":"idle"})).unwrap();
    assert!(idle.running_jobs.is_empty());
}

#[test]
fn elapsed_matches_swift_working_line() {
    for (ms, compact, words) in [
        (-5, "0s", "0 seconds"),
        (1_000, "1s", "1 second"),
        (59_999, "59s", "59 seconds"),
        (60_000, "1m", "1 minute"),
        (3_599_000, "59m", "59 minutes"),
        (3_600_000, "1h", "1 hour"),
        (3_900_000, "1h 5m", "1 hour 5 minutes"),
        (7_200_000, "2h", "2 hours"),
    ] {
        assert_eq!(elapsed(ms), compact);
        assert_eq!(spoken(ms), words);
    }
    assert_eq!(next_change(1_500, 0), 2_000);
    assert_eq!(next_change(59_000, 0), 60_000);
    assert_eq!(next_change(61_000, 0), 120_000);
    assert_eq!(
        next_change(0, 5_000),
        6_000,
        "a future start ticks after it"
    );
    assert_eq!(count(1), "1 job running");
    assert_eq!(count(3), "3 jobs running");
}

#[test]
fn abbreviates_only_paths_inside_home() {
    let home = Some("/Users/me");
    assert_eq!(abbreviate("/Users/me/x/out.log", home), "~/x/out.log");
    assert_eq!(
        abbreviate("/Users/meow/out.log", home),
        "/Users/meow/out.log"
    );
    assert_eq!(abbreviate("/tmp/out.log", None), "/tmp/out.log");
    assert_eq!(abbreviate("/out.log", Some("/")), "/out.log");
}

#[test]
fn stop_url_encodes_the_exact_job_id() {
    let options = LocalOptions::synthetic(4100);
    assert_eq!(
        stop_url(&options, "chat-1", "build/all ?#").unwrap(),
        "http://127.0.0.1:4100/api/sessions/chat-1/jobs/build%2Fall%20%3F%23/stop"
    );
    assert!(stop_url(&options, "../x", "j").is_none());
    assert!(stop_url(&options, "chat-1", "").is_none());
}

#[test]
fn stop_reports_each_daemon_answer_without_retrying() {
    let server = crate::session_jobs_fixture::Server::start(202);
    let worker = Worker::start(server.options.clone()).unwrap();
    let recv = |rx: async_channel::Receiver<Stop>| rx.recv_blocking().unwrap();
    assert_eq!(recv(worker.stop("chat-1", "tests")), Stop::Accepted);
    *server.code.lock().unwrap() = 404;
    assert_eq!(recv(worker.stop("chat-1", "gone")), Stop::Ended);
    *server.code.lock().unwrap() = 500;
    assert!(matches!(
        recv(worker.stop("chat-1", "tests")),
        Stop::Failed(_)
    ));
    assert_eq!(
        server.stops(),
        [
            "/api/sessions/chat-1/jobs/tests/stop",
            "/api/sessions/chat-1/jobs/gone/stop",
            "/api/sessions/chat-1/jobs/tests/stop"
        ],
        "one POST per click, never retried"
    );
    // A different daemon identity never receives the POST.
    *server.daemon.lock().unwrap() = "someone-else";
    assert!(matches!(
        recv(worker.stop("chat-1", "tests")),
        Stop::Failed(_)
    ));
    assert_eq!(server.stops().len(), 3);
}
