use super::*;
use crate::usage_overview_fixture as f;
use serde_json::json;
fn rt() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
}
fn range() -> Range {
    Range::preset(7, 1_730_000_000_000).unwrap()
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
fn only_pinned_get_analytics_with_bounded_range_and_no_mutations() {
    let s = f::Server::start();
    let r = range();
    f::install(&s, r);
    let snapshot = rt().block_on(fetch(&client(), &s.options, r)).unwrap();
    assert_eq!(snapshot.summary.total.records, 2);
    assert!(snapshot.trend.is_ok());
    let seen = s.state.lock().unwrap().seen.clone();
    assert_eq!(seen.len(), 5);
    assert!(s.all_gets());
    assert_eq!(seen[0].1, "/api/hello");
    assert_eq!(seen[1].1, f::path(&s.options, r, false));
    assert_eq!(seen[3].1, f::path(&s.options, r, true));
    let u = url(&s.options, r, true);
    let q: Value =
        serde_json::from_str(&u.query_pairs().find(|(k, _)| k == "query").unwrap().1).unwrap();
    assert_eq!(q["limit"], 100);
    assert_eq!(q["bucketMs"], model::DAY);
    assert!(q.get("after").is_none());
    for buckets in [false, true] {
        let u = url(&s.options, r, buckets);
        let query: Value =
            serde_json::from_str(&u.query_pairs().find(|(k, _)| k == "query").unwrap().1).unwrap();
        let mut expected = json!({"version": 1, "from": r.from, "to": r.to,
            "view": if buckets { "buckets" } else { "summary" }});
        if buckets {
            expected["bucketMs"] = json!(model::DAY);
            expected["limit"] = json!(100);
        }
        assert_eq!(query, expected, "only global summary and UTC-day queries");
    }
}
#[test]
fn unsupported_or_foreign_hello_stops_before_usage() {
    let s = f::Server::start();
    let r = range();
    for hello in [
        json!({}),
        {
            let mut v = f::hello();
            v["daemonId"] = json!("foreign");
            v
        },
        {
            let mut v = f::hello();
            v["capabilities"]["usageQueries"] = json!(2);
            v
        },
    ] {
        s.reply("/api/hello", f::Reply::json(200, hello));
        assert!(rt().block_on(fetch(&client(), &s.options, r)).is_err());
    }
    assert!(
        s.state
            .lock()
            .unwrap()
            .seen
            .iter()
            .all(|(_, p)| p == "/api/hello")
    );
}
#[test]
fn malformed_redirect_capacity_and_wire_caps_fail_closed() {
    let s = f::Server::start();
    let r = range();
    f::install(&s, r);
    let path = f::path(&s.options, r, false);
    let mut cases = vec![
        f::Reply::json(302, json!({})),
        f::Reply::json(429, json!({})),
        f::Reply::json(503, json!({})),
        f::Reply::json(200, json!({})),
    ];
    for chunked in [false, true] {
        cases.push(f::Reply {
            status: 200,
            bytes: vec![b' '; model::WIRE_CAP + 1],
            chunked,
            delay_ms: 0,
        });
    }
    for reply in cases {
        s.reply(&path, reply);
        assert!(rt().block_on(fetch(&client(), &s.options, r)).is_err());
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
fn truncated_or_changed_trend_never_replaces_authoritative_summary() {
    let s = f::Server::start();
    let r = range();
    f::install(&s, r);
    for pointer in ["truncated", "generation"] {
        let mut v = f::report(r, true);
        if pointer == "truncated" {
            v["truncated"] = json!(true);
        } else {
            v["status"]["generation"] = json!("changed");
        }
        s.reply(&f::path(&s.options, r, true), f::Reply::json(200, v));
        let snapshot = rt().block_on(fetch(&client(), &s.options, r)).unwrap();
        assert!(snapshot.trend.is_err());
        assert_eq!(snapshot.summary.total.records, 2);
    }
}
#[test]
fn replace_and_drop_cancel_slow_reads_and_coalesce_to_one_range() {
    let s = f::Server::start();
    let a = range();
    let b = Range::preset(30, a.to - 1).unwrap();
    f::install(&s, a);
    f::install(&s, b);
    let mut slow = f::Reply::json(200, f::report(a, false));
    slow.delay_ms = 500;
    s.reply(&f::path(&s.options, a, false), slow);
    let (reader, output) = Reader::start(s.options.clone()).unwrap();
    reader.request(Request {
        generation: 1,
        target: Some(a),
    });
    rt().block_on(async {
        let end = tokio::time::Instant::now() + Duration::from_secs(3);
        while !s
            .state
            .lock()
            .unwrap()
            .seen
            .iter()
            .any(|(_, p)| p == &f::path(&s.options, a, false))
        {
            assert!(tokio::time::Instant::now() < end);
            tokio::task::yield_now().await;
        }
        assert!(reader.request(Request {
            generation: 2,
            target: Some(b)
        }));
        let response = tokio::time::timeout(Duration::from_secs(3), output.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(response.generation, 2);
        assert_eq!(response.range, b);
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
fn identity_change_during_query_cannot_publish_the_old_source() {
    let s = f::Server::start();
    let r = range();
    f::install(&s, r);
    let mut slow = f::Reply::json(200, f::report(r, false));
    slow.delay_ms = 180;
    let path = f::path(&s.options, r, false);
    s.reply(&path, slow);
    let (reader, output) = Reader::start(s.options.clone()).unwrap();
    reader.request(Request {
        generation: 1,
        target: Some(r),
    });
    rt().block_on(async {
        let end = tokio::time::Instant::now() + Duration::from_secs(3);
        while !s.state.lock().unwrap().seen.iter().any(|(_, p)| p == &path) {
            assert!(tokio::time::Instant::now() < end);
            tokio::task::yield_now().await;
        }
        let mut hello = f::hello();
        hello["lineageId"] = json!("different-home");
        s.reply("/api/hello", f::Reply::json(200, hello));
        let response = tokio::time::timeout(Duration::from_secs(3), output.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(
            response.result.is_err(),
            "no old-source snapshot may be published"
        );
        drop(reader);
    });
    assert!(
        !s.state
            .lock()
            .unwrap()
            .seen
            .iter()
            .any(|(_, p)| p == &f::path(&s.options, r, true))
    );
    assert!(s.all_gets());
}
