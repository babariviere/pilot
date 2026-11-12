include!("support/intake_fixture.rs");

#[test]
fn saved_linear_released_bridge_keeps_links_cycle_counts_and_refuses_stale_or_denied_reads() {
    let mut f = Fixture::new();
    let bridge = f.bridge();
    let read = |f: &Fixture| f.call(&bridge, "day.linear.read", json!({}));
    let initial = read(&f);
    assert_eq!(initial["value"]["snapshot"]["configurationCurrent"], false);
    assert_eq!(initial["value"]["snapshot"]["total"], 0);
    f.stats("saved-linear");
    let r = read(&f);
    let s = &r["value"]["snapshot"];
    assert_eq!(s["scope"], "saved-own-issues", "{r}");
    assert_eq!(s["configurationCurrent"], true);
    assert_eq!(s["total"], 102);
    assert_eq!(s["items"].as_array().unwrap().len(), 100);
    assert_eq!(s["complete"], false);
    assert_eq!(s["more"], 2);
    assert_eq!(s["source"]["linear"]["currentCycle"]["id"], "saved-cycle");
    assert_eq!(s["source"]["linear"]["currentCycle"]["total"], 2);
    assert!(s["source"]["lastPolledAt"].as_u64().is_some());
    assert_eq!(
        s["items"][0]["missionIds"],
        json!(["mission-A", "mission-B"])
    );
    assert_eq!(s["items"][0]["sessionIds"], json!(["chat-A", "chat-B"]));
    assert_eq!(s["items"][0]["missionId"], "mission-B");
    assert_eq!(s["items"][0]["sessionId"], "chat-B");
    assert!(s["items"][1]["missionId"].is_null());
    assert_eq!(s["items"][0]["status"], "Done");
    assert_eq!(read(&f)["value"]["snapshot"], *s);
    assert_eq!(f.stats("stats")["linearReads"], 1, "reads never poll");
    let forged = f.call(&bridge, "day.linear.read", json!({"projectId":"other"}));
    assert!(!forged["error"].is_null(), "{forged}");
    for action in ["deny", "offline", "linear-bad-project", "linear-bad-count"] {
        f.stats(action);
        let refused = read(&f);
        assert!(!refused["error"].is_null(), "{action}: {refused}");
        assert!(refused["value"]["snapshot"].is_null());
        f.stats("allow");
    }
    // Real released runtime capability denial, not just a daemon refusal.
    std::fs::write(
        f.dir.join("nsh.json"),
        r#"{"name":"Denied","capabilities":{}}"#,
    )
    .unwrap();
    let denied = read(&f);
    assert!(!denied["error"].is_null(), "{denied}");
    std::fs::write(
        f.dir.join("nsh.json"),
        json!({"name":"Linear fixture","capabilities":{"host":METHODS}}).to_string(),
    )
    .unwrap();
    f.stats("linear-error");
    let failed = read(&f);
    assert_eq!(
        failed["value"]["snapshot"]["source"]["status"],
        "sign_in_required"
    );
    assert_eq!(
        failed["value"]["snapshot"]["source"]["linear"],
        s["source"]["linear"]
    );
    assert_eq!(
        failed["value"]["snapshot"]["source"]["lastPolledAt"],
        s["source"]["lastPolledAt"]
    );
    f.stats("linear-stale");
    let stale = read(&f);
    assert_eq!(stale["value"]["snapshot"]["configurationCurrent"], false);
    assert_eq!(stale["value"]["snapshot"]["items"], json!([]));
    assert!(stale["value"]["snapshot"]["source"]["linear"].is_null());
    f.stats("linear-empty");
    let empty = read(&f);
    assert_eq!(empty["value"]["snapshot"]["configurationCurrent"], true);
    assert_eq!(
        empty["value"]["snapshot"]["source"]["linear"]["cycleStatus"],
        "no_active_cycle"
    );
    assert_eq!(empty["value"]["snapshot"]["items"], json!([]));
    assert_eq!(empty["value"]["snapshot"]["complete"], true);
    f.stats("delete-selected");
    assert!(
        !read(&f)["error"].is_null(),
        "deleted selected project cannot fall back"
    );
    let stats = f.stats("stats");
    assert_eq!(stats["posts"], 0);
    assert_eq!(stats["lookups"], 0);
    assert_eq!(stats["external"], 0);
    assert_eq!(stats["sessions"], 0);
    close(bridge);
}
