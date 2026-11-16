include!("support/intake_fixture.rs");

#[test]
fn compiled_native_intake_and_linear_reads_reach_authenticated_project_routes() {
    let mut f = Fixture::new();
    let bridge = f.bridge();
    let project = f.info["source"]["project_id"].clone();
    // Calls cross the released bridge, compiled Rust transport and real router.
    // Incorrect URI templates or capability headers fail the actual reads.
    for method in ["day.intake.read", "day.linear.read"] {
        let result = f.call(&bridge, method, json!({}));
        let snapshot = &result["value"]["snapshot"];
        assert_eq!(snapshot["version"], 1, "{method}: {result}");
        assert_eq!(snapshot["projectId"], project, "{method}: {result}");
        let forged = f.call(&bridge, method, json!({"projectId":"other"}));
        assert!(!forged["error"].is_null(), "{method}: {forged}");
    }
    // Revoke the real local credential rather than a route-specific proxy mode.
    use std::os::unix::fs::PermissionsExt;
    let capability = PathBuf::from(f.info["source"]["profile"].as_str().unwrap())
        .join("github-app-capability");
    std::fs::set_permissions(&capability, std::fs::Permissions::from_mode(0o644)).unwrap();
    for method in ["day.intake.read", "day.linear.read"] {
        let result = f.call(&bridge, method, json!({}));
        assert_eq!(result["error"], "identity", "{method}: {result}");
        assert!(result["value"].is_null(), "denial is not an empty result");
    }
    std::fs::set_permissions(&capability, std::fs::Permissions::from_mode(0o600)).unwrap();
    let stats = f.stats("stats");
    for field in ["posts", "lookups", "sessions", "external"] {
        assert_eq!(stats[field], 0, "passive reads changed {field}: {stats}");
    }
    close(bridge);
}

fn intent(snapshot: &Value) -> Value {
    let item = &snapshot["sources"][1]["items"][0];
    json!({"itemId":item["id"],"revision":item["revision"],"contextDigest":snapshot["contextDigest"]})
}
#[test]
fn durable_intake_triage_start_lost_ack_and_lookup_only_cold_reopen() {
    let mut f = Fixture::new();
    let bridge = f.bridge();
    let snapshot = f.read(&bridge);
    assert_eq!(snapshot["sources"][1]["total"], 2);
    assert_eq!(snapshot["intake"]["requests"].as_array().unwrap().len(), 2);
    let forged = f.call(
        &bridge,
        "day.intake.start",
        json!({"itemId":"x","revision":1,"contextDigest":"a".repeat(64),"projectId":"other"}),
    );
    assert!(
        forged["error"].is_object() || forged["error"].is_string() || forged["ok"] == false,
        "{forged}"
    );
    for state in ["later", "new", "discarded", "new"] {
        let snapshot = f.read(&bridge);
        let mut r = intent(&snapshot);
        r["state"] = json!(state);
        let result = f.call(&bridge, "day.intake.triage", r);
        assert_eq!(result["value"]["outcome"]["state"], "accepted", "{result}");
        assert_eq!(
            f.read(&bridge)["intake"]["more"],
            "",
            "triaged loaded rows are not missing pages"
        );
    }
    let snapshot = f.read(&bridge);
    let r = intent(&snapshot);
    f.stats("lost");
    let result = f.call(&bridge, "day.intake.start", r.clone());
    assert_eq!(result["value"]["outcome"]["state"], "unknown", "{result}");
    let operation = result["value"]["outcome"]["operationId"].clone();
    assert_eq!(f.stats("stats")["sessions"], 1);
    close(bridge);
    let bridge = f.bridge();
    let restored = f.call(&bridge, "day.intake.read", json!({}));
    assert!(
        restored["value"]["operations"]
            .as_array()
            .unwrap()
            .iter()
            .any(|o| o["operationId"] == operation && o["state"] == "unknown")
    );
    let checked = f.call(
        &bridge,
        "day.intake.check",
        json!({"operationId":operation}),
    );
    assert_eq!(
        checked["value"]["outcome"]["state"], "accepted",
        "{checked}"
    );
    let stats = f.stats("stats");
    assert_eq!(stats["posts"], 5);
    assert_eq!(stats["lookups"], 1);
    assert_eq!(stats["sessions"], 1);
    assert_eq!(stats["external"], 0);
    f.call(
        &bridge,
        "day.intake.check",
        json!({"operationId":operation}),
    );
    let duplicate = f.call(&bridge, "day.intake.start", r);
    assert_ne!(duplicate["value"]["outcome"]["state"], "accepted");
    assert_eq!(f.stats("stats")["posts"], 5);
    close(bridge);
}
