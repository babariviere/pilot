include!("support/intake_fixture.rs");
use std::sync::{Arc, Mutex};

fn fixture() -> Fixture {
    Fixture::with_daemon("day-delivery.ts")
}
fn navigation(f: &Fixture, opened: Arc<Mutex<Vec<String>>>) -> Bridge {
    let source: Source = serde_json::from_value(f.info["source"].clone()).unwrap();
    let options = pilot_day_native::host::Options {
        url_opener: Some(Arc::new(move |url| {
            opened.lock().unwrap().push(url.into());
            Ok(())
        })),
        ..Default::default()
    };
    Bridge::new(DayRoot::new(f.host_for_options(source, options)))
}
fn page(f: &Fixture, b: &Bridge) -> Value {
    let r = f.call(b, "day.delivery.read", f.info["task"].clone());
    assert_eq!(r["value"]["outputCapabilities"]["artifacts"], false);
    r["value"]["snapshot"].clone()
}
fn activation(v: &Value) -> Value {
    json!({"subject":v["subject"],"targetId":v["targetId"],"deliveryId":v["deliveryId"],
        "ownerSessionId":v["ownerSessionId"],"resourceId":v["pullRequests"][0]["id"],
        "url":v["pullRequests"][0]["pullRequest"]["url"]})
}
fn open(f: &Fixture, b: &Bridge, args: Value) -> Value {
    f.call(b, "day.delivery.open", args)
}

#[test]
fn explicit_web_output_uses_injected_opener_only_and_reopen_never_replays() {
    let mut f = fixture();
    let opened = Arc::new(Mutex::new(Vec::new()));
    let b = navigation(&f, opened.clone());
    let p = page(&f, &b);
    let baseline = f.stats("stats");
    let result = open(&f, &b, activation(&p));
    assert_eq!(result["value"]["opened"], true, "{result}");
    assert_eq!(result["value"]["outcome"], Value::Null);
    assert_eq!(
        *opened.lock().unwrap(),
        vec![p["pullRequests"][0]["url"].as_str().unwrap()]
    );
    assert_eq!(
        page(&f, &b),
        p,
        "opening never assesses or changes the delivery"
    );
    let url = "http://github.com/example/repo/pull/1";
    f.stats(&format!("output-url:{url}"));
    let updated = page(&f, &b);
    assert_eq!(updated["deliveryId"], p["deliveryId"]);
    assert_eq!(open(&f, &b, activation(&p))["error"], "stale");
    assert_eq!(open(&f, &b, activation(&updated))["value"]["opened"], true);
    assert_eq!(opened.lock().unwrap().len(), 2);
    close(b);
    let b = navigation(&f, opened.clone());
    let _ = page(&f, &b);
    let saved = f.call(&b, "day.delivery.saved", json!({}));
    assert_eq!(saved["value"]["operations"], json!([]));
    assert_eq!(
        opened.lock().unwrap().len(),
        2,
        "cold open never replays navigation"
    );
    let stats = f.stats("stats");
    assert_eq!(stats["posts"], 0);
    assert_eq!(stats["lookups"], 0);
    assert_eq!(stats["messages"], json!([]));
    assert_eq!(stats["external"], 0);
    assert_eq!(stats["sessions"], baseline["sessions"]);
    close(b);
}

#[test]
fn stale_deleted_denied_and_second_read_races_never_dispatch() {
    for mode in ["delivery", "delete", "deny", "retarget"] {
        let mut f = fixture();
        let opened = Arc::new(Mutex::new(Vec::new()));
        let b = navigation(&f, opened.clone());
        let p = page(&f, &b);
        f.stats(&format!("output-race:{mode}"));
        let result = open(&f, &b, activation(&p));
        assert!(result["error"].is_string(), "{mode}: {result}");
        assert!(opened.lock().unwrap().is_empty(), "{mode}");
        assert_eq!(f.stats("stats")["posts"], 0);
        close(b);
    }
    let mut f = fixture();
    let opened = Arc::new(Mutex::new(Vec::new()));
    let b = navigation(&f, opened.clone());
    let p = page(&f, &b);
    let mut foreign = activation(&p);
    foreign["subject"]["projectId"] = json!("other");
    assert_eq!(open(&f, &b, foreign)["error"], "identity");
    f.stats("delete-output");
    assert_eq!(open(&f, &b, activation(&p))["error"], "stale");
    assert!(opened.lock().unwrap().is_empty());
    close(b);
}

#[test]
fn unavailable_callback_unsupported_records_and_dangerous_targets_fail_closed() {
    let mut f = fixture();
    let b = f.bridge();
    let p = page(&f, &b);
    assert_eq!(open(&f, &b, activation(&p))["error"], "unavailable");
    close(b);
    let opened = Arc::new(Mutex::new(Vec::new()));
    let b = navigation(&f, opened.clone());
    for url in [
        "file:///tmp/a.pdf",
        "file:///../../Applications/a.app",
        "../../a",
        "javascript:alert(1)",
        "data:text/html,x",
        "pilot://chat/a",
        "https://example.com/%0a",
        "https://user:pass@example.com",
        "https://example.com\\@evil.com",
    ] {
        let mut args = activation(&p);
        args["url"] = json!(url);
        assert_eq!(open(&f, &b, args)["error"], "invalid", "{url}");
    }
    for (field, value) in [
        ("artifactId", json!("fake-artifact")),
        ("path", json!("../../a")),
        ("callback", json!("run")),
    ] {
        let mut args = activation(&p);
        args[field] = value;
        assert_eq!(open(&f, &b, args)["error"], "invalid");
    }
    let mut unknown = activation(&p);
    unknown["resourceId"] = json!("unlinked-document");
    unknown["url"] = json!("https://example.com/docs");
    assert_eq!(open(&f, &b, unknown)["error"], "stale");
    // Even a canonical wire target cannot widen the native scheme policy.
    f.stats("output-url:file:///tmp/a.app");
    let bad = page(&f, &b);
    assert_eq!(open(&f, &b, activation(&bad))["error"], "invalid");
    assert!(opened.lock().unwrap().is_empty());
    assert_eq!(f.stats("stats")["posts"], 0);
    close(b);
}

#[test]
fn flush_fences_navigation_before_callback_dispatch() {
    let f = fixture();
    let opened = Arc::new(Mutex::new(Vec::new()));
    let b = navigation(&f, opened.clone());
    let p = page(&f, &b);
    b.request_flush().unwrap();
    assert_eq!(open(&f, &b, activation(&p))["error"], "busy");
    assert!(opened.lock().unwrap().is_empty());
    close(b);
}

#[test]
fn attempted_callback_failure_is_unknown_and_cold_reads_never_retry() {
    let mut f = fixture();
    let opened = Arc::new(Mutex::new(Vec::new()));
    let attempts = opened.clone();
    let source: Source = serde_json::from_value(f.info["source"].clone()).unwrap();
    let options = pilot_day_native::host::Options {
        url_opener: Some(Arc::new(move |url| {
            attempts.lock().unwrap().push(url.to_owned());
            Err(Error::Unavailable)
        })),
        ..Default::default()
    };
    let b = Bridge::new(DayRoot::new(f.host_for_options(source, options)));
    let p = page(&f, &b);
    assert_eq!(open(&f, &b, activation(&p))["error"], "unknown");
    assert_eq!(opened.lock().unwrap().len(), 1);
    close(b);
    let b = navigation(&f, opened.clone());
    let _ = page(&f, &b);
    assert_eq!(opened.lock().unwrap().len(), 1);
    assert_eq!(f.stats("stats")["posts"], 0);
    close(b);
}
