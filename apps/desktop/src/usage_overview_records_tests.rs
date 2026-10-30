use super::*;
use crate::usage_overview_fixture as f;
fn request() -> Request {
    f::records_request(Range::preset(7, 1_730_000_000_000).unwrap())
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
        .build()
        .unwrap()
}
#[test]
fn usage_records_replace_pages_and_never_reduce_unknown_counts_or_costs() {
    let r = request();
    let first = Page::parse(f::records(r.range, 0, 25, true), &r).unwrap();
    assert_eq!(first.rows.len(), 25);
    assert!(first.rows[0].counts().contains("Input 0"));
    assert!(first.rows[1].counts().contains("Input Unknown"));
    assert!(first.rows[1].costs().contains("not billed): Unknown"));
    assert_eq!(first.rows[1].value["operationId"], "request-0001");
    let mut priced = f::records(r.range, 0, 1, false);
    priced["rows"][0]["cost"] = json!({"estimateStatus":"partial_catalog_estimate","estimatedUsdMicros":9_007_199_254_740_991_u64,"pricingRevision":"synthetic","billedStatus":"unavailable","subscriptionCoverage":"unknown"});
    assert!(
        Page::parse(priced, &r).unwrap().rows[0]
            .costs()
            .contains("$9007199254.740991 · partial_catalog_estimate")
    );
    let mut second = r.clone();
    second.after = first.next.clone();
    second.boundary = first.rows.last().map(|v| v.key.clone());
    let page = Page::parse(f::records(r.range, 25, 1, false), &second).unwrap();
    let mut state = State {
        open: true,
        ..Default::default()
    };
    let serial = state.begin();
    state.accept(serial, Ok(first));
    let serial = state.begin();
    state.accept(serial, Ok(page));
    assert_eq!(state.page.unwrap().rows.len(), 1);
}
#[test]
fn usage_records_reject_duplicate_boundary_empty_short_repeat_cursor_and_wrong_kind() {
    let r = request();
    let mut cases = vec![];
    for count in [0, 1, 24, 26] {
        cases.push(f::records(r.range, 0, count, true));
    }
    let mut duplicate = f::records(r.range, 0, 2, false);
    duplicate["rows"][1] = duplicate["rows"][0].clone();
    cases.push(duplicate);
    for (key, value) in [
        ("kind", json!("checkpoint")),
        ("generation", json!("old")),
        ("completedAt", json!(r.range.to)),
        ("sourceId", json!("session-guessed")),
    ] {
        let mut v = f::records(r.range, 0, 1, false);
        v["rows"][0][key] = value;
        cases.push(v);
    }
    for v in cases {
        assert!(Page::parse(v, &r).is_err());
    }
    let mut next = r.clone();
    next.after = Some("opaque-next-25".into());
    assert_eq!(
        Page::parse(f::records(r.range, 0, 25, true), &next).unwrap_err(),
        RESET
    );
    next.boundary = Some((
        r.range.from + 2000,
        f::PROJECT.into(),
        "request-0001".into(),
    ));
    assert_eq!(
        Page::parse(f::records(r.range, 0, 1, false), &next).unwrap_err(),
        RESET
    );
}
#[test]
fn usage_records_scope_generation_cost_and_missing_evidence_fail_closed() {
    let mut r = request();
    let mut v = f::records(r.range, 0, 1, false);
    r.filter = Filter::Project(f::PROJECT.into());
    assert!(Page::parse(v.clone(), &r).is_err());
    v["rows"][0]["attribution"] = json!({"projectId":f::PROJECT});
    assert!(Page::parse(v.clone(), &r).is_ok());
    r.filter = Filter::Unattributed;
    assert!(Page::parse(v.clone(), &r).is_err());
    r.filter = Filter::All;
    v["rows"][0]["cost"]["billedStatus"] = json!("known");
    assert!(Page::parse(v.clone(), &r).is_err());
    v["status"]["generation"] = json!("cleared");
    v["rows"] = json!(null);
    assert_eq!(Page::parse(v, &r).unwrap_err(), model::ERASED);
    let mut v = f::records(r.range, 0, 1, false);
    v["status"]["retainedRows"] = json!(null);
    assert!(Page::parse(v, &r).is_err());
    let mut v = f::records(r.range, 0, 1, false);
    v["rows"][0]["cost"]["estimatedUsdMicros"] = 0.into();
    assert!(Page::parse(v, &r).is_err());
}
#[test]
fn usage_records_retained_error_and_clear_late_success_or_error() {
    let r = request();
    let page = || Page::parse(f::records(r.range, 0, 1, false), &r).unwrap();
    let mut s = State {
        open: true,
        ..Default::default()
    };
    let n = s.begin();
    assert!(s.accept(n, Ok(page())));
    let n = s.begin();
    s.accept(n, Err("unavailable"));
    assert!(s.page.is_some());
    let n = s.begin();
    s.clear();
    s.open = true;
    s.begin();
    assert!(!s.accept(n, Ok(page())));
    assert!(!s.accept(n, Err(model::ERASED)));
    assert!(s.page.is_none());
    let n = s.serial;
    s.accept(n, Err(RESET));
    assert!(s.page.is_none());
}
#[test]
fn usage_records_only_pinned_gets_captured_range_filter_and_opaque_cursor() {
    let s = f::Server::start();
    let mut r = request();
    f::install(&s, r.range);
    for filter in [
        Filter::All,
        Filter::Project(f::PROJECT.into()),
        Filter::Unattributed,
    ] {
        r.filter = filter.clone();
        r.after = Some("opaque+/= cursor".into());
        let mut v = f::records(r.range, 25, 1, false);
        if let Filter::Project(id) = &filter {
            v["rows"][0]["attribution"] = json!({"projectId":id});
        }
        s.reply(&f::records_path(&s.options, &r), f::Reply::json(200, v));
        let page = rt().block_on(fetch(&client(), &s.options, &r)).unwrap();
        assert_eq!(page.rows.len(), 1);
        let u = url(&s.options, &r);
        let pairs: std::collections::BTreeMap<_, _> = u.query_pairs().collect();
        let q: Value = serde_json::from_str(&pairs["query"]).unwrap();
        assert_eq!(q["kind"], "request");
        assert_eq!(q["limit"], 25);
        assert_eq!(q["after"], "opaque+/= cursor");
        assert_eq!(q["from"], r.range.from);
        assert_eq!(q["to"], r.range.to);
        assert_eq!(pairs["daemonId"], s.options.host().daemon_id);
        match filter {
            Filter::All => assert!(q.get("filters").is_none()),
            Filter::Project(id) => assert_eq!(q["filters"], json!({"projectId":id})),
            Filter::Unattributed => assert_eq!(q["filters"], json!({"missing":["project"]})),
        }
    }
    assert!(s.all_gets());
    assert_eq!(s.state.lock().unwrap().seen.len(), 9);
}
#[test]
fn usage_records_cursor_refusal_capacity_erasure_and_identity_errors() {
    let s = f::Server::start();
    let r = request();
    f::install(&s, r.range);
    for (status, error) in [
        (400, RESET),
        (409, "Local identity changed. No fallback was attempted."),
        (429, "Local usage query capacity reached. Retry later."),
    ] {
        s.reply(
            &f::records_path(&s.options, &r),
            f::Reply::json(status, json!({})),
        );
        assert_eq!(
            rt().block_on(fetch(&client(), &s.options, &r)).unwrap_err(),
            error
        );
    }
    let mut v = f::records(r.range, 0, 1, false);
    v["status"]["generation"] = "cleared".into();
    s.reply(&f::records_path(&s.options, &r), f::Reply::json(200, v));
    assert_eq!(
        rt().block_on(fetch(&client(), &s.options, &r)).unwrap_err(),
        model::ERASED
    );
    s.reply(
        "/api/hello",
        f::Reply::json(200, json!({"daemonId":"foreign"})),
    );
    assert!(rt().block_on(fetch(&client(), &s.options, &r)).is_err());
    assert!(s.all_gets());
}
#[test]
fn usage_records_drop_cancels_inflight_page_before_replacement_scope() {
    let s = f::Server::start();
    let r = request();
    f::install(&s, r.range);
    let mut slow = f::Reply::json(200, f::records(r.range, 0, 25, true));
    slow.delay_ms = 600;
    s.reply(&f::records_path(&s.options, &r), slow);
    let (reader, out) = Reader::start(s.options.clone()).unwrap();
    reader.request(r.clone());
    rt().block_on(async {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
        while !s
            .state
            .lock()
            .unwrap()
            .seen
            .iter()
            .any(|(_, p)| p == &f::records_path(&s.options, &r))
        {
            assert!(tokio::time::Instant::now() < deadline);
            tokio::task::yield_now().await;
        }
        drop(reader);
        assert!(
            tokio::time::timeout(Duration::from_secs(2), out.recv())
                .await
                .unwrap()
                .is_err()
        );
    });
    assert!(s.all_gets());
}
