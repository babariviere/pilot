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
    let snapshot = rt()
        .block_on(fetch(&client(), &s.options, r, &Filter::All, None))
        .unwrap();
    assert_eq!(snapshot.summary.total.records, 2);
    assert!(snapshot.trend.is_ok());
    let seen = s.state.lock().unwrap().seen.clone();
    assert_eq!(seen.len(), 7);
    assert!(s.all_gets());
    assert_eq!(seen[0].1, "/api/hello");
    assert_eq!(seen[1].1, f::path(&s.options, r, false));
    assert_eq!(seen[3].1, f::path(&s.options, r, true));
    let u = url(&s.options, r, &Filter::All, View::Buckets);
    let q: Value =
        serde_json::from_str(&u.query_pairs().find(|(k, _)| k == "query").unwrap().1).unwrap();
    assert_eq!(q["limit"], 100);
    assert_eq!(q["bucketMs"], model::DAY);
    assert!(q.get("after").is_none());
    for filter in [
        Filter::All,
        Filter::Project(f::PROJECT.into()),
        Filter::Unattributed,
    ] {
        for view in [View::Summary, View::Buckets, View::Projects] {
            let u = url(&s.options, r, &filter, view);
            let pairs: std::collections::BTreeMap<_, _> = u.query_pairs().collect();
            assert_eq!(pairs["daemonId"], s.options.host().daemon_id);
            assert_eq!(pairs["lineageId"], s.options.host().lineage_id);
            let query: Value = serde_json::from_str(&pairs["query"]).unwrap();
            let mut expected = json!({"version":1,"from":r.from,"to":r.to,"view":match view { View::Summary=>"summary", View::Buckets=>"buckets", View::Projects=>"breakdown" }});
            if view == View::Projects {
                expected["dimension"] = json!("project");
                expected["limit"] = json!(100);
            } else {
                match &filter {
                    Filter::All => {}
                    Filter::Project(id) => expected["filters"] = json!({"projectId":id}),
                    Filter::Unattributed => expected["filters"] = json!({"missing":["project"]}),
                }
            }
            if view == View::Buckets {
                expected["bucketMs"] = json!(model::DAY);
                expected["limit"] = json!(100);
            }
            assert_eq!(
                query, expected,
                "captured exact scope, no paging/account/refresh calls"
            );
        }
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
        assert!(
            rt().block_on(fetch(&client(), &s.options, r, &Filter::All, None))
                .is_err()
        );
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
        assert!(
            rt().block_on(fetch(&client(), &s.options, r, &Filter::All, None))
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
        let result = rt().block_on(fetch(&client(), &s.options, r, &Filter::All, None));
        if pointer == "generation" {
            assert_eq!(result.unwrap_err(), model::ERASED);
            continue;
        }
        let snapshot = result.unwrap();
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
        previous_generation: None,
        filter: Filter::All,
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
            previous_generation: None,
            filter: Filter::All,
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
        previous_generation: None,
        filter: Filter::All,
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

#[test]
fn filtered_totals_and_days_use_one_exact_scope_without_summing_catalogue_pages() {
    let s = f::Server::start();
    let r = range();
    for (n, filter) in [
        Filter::All,
        Filter::Project(f::PROJECT.into()),
        Filter::Unattributed,
    ]
    .into_iter()
    .enumerate()
    {
        f::install_filter(&s, r, &filter);
        let total = 1_000 + n as u64;
        let mut summary = f::report(r, false);
        summary["total"]["metrics"]["input"]["value"] = json!(total);
        s.reply(
            &f::scoped_path(&s.options, r, &filter, View::Summary),
            f::Reply::json(200, summary),
        );
        let mut daily = f::report(r, true);
        daily["groups"] = json!([f::day(r.from, 10 + n as u64, 2, 0)]);
        s.reply(
            &f::scoped_path(&s.options, r, &filter, View::Buckets),
            f::Reply::json(200, daily),
        );
        let mut catalogue = f::projects(r);
        catalogue["truncated"] = json!(true);
        catalogue["next"] = json!("do-not-follow");
        s.reply(
            &f::scoped_path(&s.options, r, &Filter::All, View::Projects),
            f::Reply::json(200, catalogue),
        );
        let snap = rt()
            .block_on(fetch(&client(), &s.options, r, &filter, None))
            .unwrap();
        assert_eq!(snap.filter, filter);
        assert_eq!(snap.range, r);
        assert_eq!(
            snap.summary.total.metric("input").unwrap().value,
            Some(total)
        );
        assert_eq!(
            snap.trend.unwrap().days(r)[0].1.tokens(),
            Some(12 + n as u64)
        );
        assert!(snap.projects.unwrap().limited);
    }
    assert!(s.all_gets());
    let seen = s.state.lock().unwrap().seen.clone();
    assert_eq!(
        seen.len(),
        21,
        "one page per captured range/filter, no account/provider calls"
    );
    assert!(
        seen.iter()
            .all(|(_, p)| p == "/api/hello" || p.starts_with("/api/usage-history/query?"))
    );
    assert!(!seen.iter().any(|(_, p)| p.contains("after")));
    let before = seen.len();
    assert!(
        rt().block_on(fetch(
            &client(),
            &s.options,
            r,
            &Filter::Project("bad".into()),
            None
        ))
        .is_err()
    );
    assert_eq!(
        s.state.lock().unwrap().seen.len(),
        before,
        "invalid identity never sent"
    );
}

#[test]
fn filtered_catalogue_failure_is_separate_but_observed_erasure_invalidates_everything() {
    let s = f::Server::start();
    let r = range();
    let filter = Filter::Project(f::PROJECT.into());
    f::install_filter(&s, r, &filter);
    let path = f::scoped_path(&s.options, r, &Filter::All, View::Projects);
    s.reply(&path, f::Reply::json(503, json!({})));
    let snap = rt()
        .block_on(fetch(&client(), &s.options, r, &filter, None))
        .unwrap();
    assert!(snap.projects.is_err());
    assert!(snap.trend.is_ok());
    assert_eq!(snap.summary.total.records, 2);
    for view in [View::Buckets, View::Projects] {
        f::install_filter(&s, r, &filter);
        let mut cleared = f::report(r, false);
        cleared["status"]["generation"] = json!("cleared");
        cleared["groups"] = json!([{"key":"malformed after erasure"}]);
        let path = f::scoped_path(&s.options, r, &filter, view);
        s.reply(&path, f::Reply::json(200, cleared));
        assert_eq!(
            rt().block_on(fetch(&client(), &s.options, r, &filter, None))
                .unwrap_err(),
            model::ERASED
        );
    }
}

#[test]
fn replacing_only_the_filter_cancels_slow_old_totals_and_errors() {
    let s = f::Server::start();
    let r = range();
    let project = Filter::Project(f::PROJECT.into());
    for filter in [Filter::All, project.clone(), Filter::Unattributed] {
        f::install_filter(&s, r, &filter);
    }
    let path = f::scoped_path(&s.options, r, &project, View::Summary);
    let mut slow = f::Reply::json(503, json!({}));
    slow.delay_ms = 500;
    s.reply(&path, slow);
    let (reader, output) = Reader::start(s.options.clone()).unwrap();
    reader.request(Request {
        generation: 1,
        previous_generation: None,
        target: Some(r),
        filter: project,
    });
    rt().block_on(async {
        let end = tokio::time::Instant::now() + Duration::from_secs(3);
        while !s.state.lock().unwrap().seen.iter().any(|(_, p)| p == &path) {
            assert!(tokio::time::Instant::now() < end);
            tokio::task::yield_now().await;
        }
        reader.request(Request {
            generation: 2,
            previous_generation: None,
            target: Some(r),
            filter: Filter::All,
        });
        reader.request(Request {
            generation: 3,
            previous_generation: None,
            target: Some(r),
            filter: Filter::Unattributed,
        });
        let response = tokio::time::timeout(Duration::from_secs(3), output.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(response.generation, 3);
        assert_eq!(response.filter, Filter::Unattributed);
        assert_eq!(response.result.unwrap().filter, Filter::Unattributed);
        drop(reader);
    });
    assert!(s.all_gets());
}

#[test]
fn new_summary_generation_clears_retained_reports_even_when_later_reads_would_fail() {
    let s = f::Server::start();
    let r = range();
    f::install(&s, r);
    let mut summary = f::report(r, false);
    summary["status"]["generation"] = json!("post-erasure");
    s.reply(&f::path(&s.options, r, false), f::Reply::json(200, summary));
    assert_eq!(
        rt().block_on(fetch(
            &client(),
            &s.options,
            r,
            &Filter::All,
            Some("synthetic-generation")
        ))
        .unwrap_err(),
        model::ERASED
    );
    assert_eq!(
        s.state.lock().unwrap().seen.len(),
        2,
        "erasure observed before later error paths"
    );
}
