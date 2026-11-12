include!("support/intake_fixture.rs");

fn fixture() -> Fixture {
    Fixture::with_daemon("day-delivered-artifact.ts")
}
fn selection(f: &Fixture, b: &Bridge) -> Value {
    let r = f.call(b, "day.delivery.read", f.info["task"].clone());
    let p = &r["value"]["snapshot"];
    let link = p["artifacts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["artifactId"] == f.info["artifactId"])
        .unwrap();
    json!({"subject":p["subject"],"targetId":p["targetId"],"deliveryId":p["deliveryId"],
        "ownerSessionId":p["ownerSessionId"],"sourceSessionId":link["sessionId"],
        "artifactId":link["artifactId"],"revision":link["revision"]})
}

#[test]
fn captured_revision_is_inert_text_and_reopen_has_no_effect() {
    let mut f = fixture();
    let b = f.bridge();
    let args = selection(&f, &b);
    let result = f.call(&b, "day.delivery.artifact", args.clone());
    let snapshot = &result["value"]["snapshot"];
    assert_eq!(snapshot["reference"], args, "{result}");
    assert_eq!(snapshot["rendering"], "unsupported");
    assert_eq!(
        snapshot["content"]["source"],
        "<script>throw Error('never execute')</script>"
    );
    assert_eq!(snapshot["metadata"]["kind"], "html");
    assert!(snapshot.get("html").is_none());
    assert!(snapshot.get("data").is_none());
    let page = f.call(&b, "day.delivery.read", f.info["task"].clone());
    assert!(page["value"]["snapshot"]["verification"].is_null());
    close(b);
    let b = f.bridge();
    let saved = f.call(&b, "day.delivery.saved", json!({}));
    assert_eq!(saved["value"]["operations"], json!([]));
    assert_eq!(f.stats("stats")["messages"], json!([]));
    close(b);
}

#[test]
fn captured_read_refuses_stale_permission_and_arbitrary_selectors() {
    for action in ["stale", "leave"] {
        let mut f = fixture();
        let b = f.bridge();
        let args = selection(&f, &b);
        f.stats(action);
        let r = f.call(&b, "day.delivery.artifact", args);
        assert!(r["error"].is_string(), "{action}: {r}");
        close(b);
    }
    let f = fixture();
    let b = f.bridge();
    let args = selection(&f, &b);
    for (field, value) in [
        ("path", json!("/tmp/a")),
        ("callback", json!("run")),
        ("url", json!("file:///tmp/a")),
        ("revision", json!(0)),
        ("artifactId", json!("../latest")),
    ] {
        let mut changed = args.clone();
        changed[field] = value;
        assert_eq!(
            f.call(&b, "day.delivery.artifact", changed)["error"],
            "invalid"
        );
    }
    let mut changed = args.clone();
    changed["revision"] = json!(2);
    assert_eq!(
        f.call(&b, "day.delivery.artifact", changed)["error"],
        "stale"
    );
    b.request_flush().unwrap();
    assert_eq!(f.call(&b, "day.delivery.artifact", args)["error"], "busy");
    close(b);
}

#[test]
fn missing_oversize_and_redacted_remain_unavailable_not_latest_or_empty() {
    for reason in ["missing", "oversize", "redacted"] {
        let mut f = fixture();
        let b = f.bridge();
        let args = selection(&f, &b);
        f.stats(reason);
        let r = f.call(&b, "day.delivery.artifact", args);
        assert_eq!(
            r["value"]["snapshot"]["content"],
            json!({"state":"unavailable","reason":reason}),
            "{r}"
        );
        assert_eq!(f.stats("stats")["messages"], json!([]));
        close(b);
    }
}
