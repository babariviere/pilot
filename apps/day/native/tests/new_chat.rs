include!("support/intake_fixture.rs");

fn projects(f: &Fixture, b: &Bridge) -> Vec<Value> {
    let r = f.call(b, "day.projects.read", json!({}));
    assert_eq!(r["value"]["snapshot"]["complete"], true, "{r}");
    r["value"]["snapshot"]["projects"]
        .as_array()
        .unwrap()
        .clone()
}
fn select(f: &Fixture, b: &Bridge, p: &Value, mode: &str) -> Value {
    let r = f.call(
        b,
        "day.chat.select",
        json!({"projectId":p["projectId"],"contextDigest":p["contextDigest"],"mode":mode}),
    );
    assert!(r["value"]["snapshot"]["draftId"].is_string(), "{r}");
    r["value"]["snapshot"].clone()
}
fn create(f: &Fixture, b: &Bridge, c: &Value) -> Value {
    f.call(
        b,
        "day.chat.create",
        json!({"choice":c,"message":"  Exact words 👩🏽‍💻\nkept  "}),
    )
}
fn capture(f: &Fixture, b: &Bridge, c: &Value) {
    let generation = b.request_flush().unwrap();
    let result = f.call(
        b,
        "day.flush.ack",
        json!({"generation":generation,"view":{
        "place":"new","id":"","update":false,"goal":"  Exact words 👩🏽‍💻\nkept  ",
        "chat":c,"focused":"","questions":[]}}),
    );
    assert!(result["value"].is_object(), "{result}");
}
#[test]
fn two_project_creation_saved_draft_lost_ack_and_exact_cold_lookup_never_retarget() {
    let mut f = Fixture::new();
    let b = f.bridge();
    let list = projects(&f, &b);
    assert_eq!(list.len(), 2);
    let a = list
        .iter()
        .find(|p| p["projectId"] == f.info["source"]["project_id"])
        .unwrap();
    let other = list
        .iter()
        .find(|p| p["projectId"] != a["projectId"])
        .unwrap();
    let superseded = select(&f, &b, a, "ask");
    select(&f, &b, other, "build");
    assert_eq!(
        create(&f, &b, &superseded)["error"],
        "stale",
        "an older selection reply cannot change the chosen project"
    );
    let choice = select(&f, &b, a, "ask");
    assert_eq!(
        f.stats("stats")["sessions"],
        0,
        "reads and selection are passive"
    );
    capture(&f, &b, &choice);
    close(b);
    let host = f.host();
    let saved = host.saved_window().unwrap();
    assert_eq!(saved.view["chat"], choice);
    assert_eq!(saved.view["goal"], "  Exact words 👩🏽‍💻\nkept  ");
    assert_eq!(f.stats("stats")["sessions"], 0, "reopen never sends");
    let b = Bridge::new(DayRoot::new(host));
    let first = create(&f, &b, &choice);
    assert_eq!(first["value"]["outcome"]["state"], "accepted", "{first}");
    let again = create(&f, &b, &choice);
    assert_eq!(again["value"]["outcome"], first["value"]["outcome"]);
    assert_eq!(f.stats("stats")["posts"], 1);
    let mut wrong = choice.clone();
    wrong["projectId"] = other["projectId"].clone();
    assert_eq!(create(&f, &b, &wrong)["error"], "stale");
    let old = select(&f, &b, other, "build");
    f.stats("change-other");
    let stale = create(&f, &b, &old);
    assert_eq!(stale["error"], "stale", "{stale}");
    let list = projects(&f, &b);
    let other = list
        .iter()
        .find(|p| p["projectId"] == other["projectId"])
        .unwrap();
    let choice_b = select(&f, &b, other, "build");
    f.stats("lost");
    let lost = create(&f, &b, &choice_b);
    assert_eq!(lost["value"]["outcome"]["state"], "unknown", "{lost}");
    let op = lost["value"]["outcome"]["operationId"].clone();
    assert_eq!(
        create(&f, &b, &choice_b)["value"]["outcome"]["state"],
        "unknown"
    );
    let blocked = f.call(
        &b,
        "day.chat.select",
        json!({"projectId":a["projectId"],"contextDigest":a["contextDigest"],"mode":"ask"}),
    );
    assert_eq!(blocked["error"], "unknown");
    close(b);
    // Another Today project in the same home must still see/block this uncertainty.
    let mut source: Source = serde_json::from_value(f.info["source"].clone()).unwrap();
    source.project.as_mut().unwrap().project_id = choice_b["projectId"].as_str().unwrap().into();
    source.project.as_mut().unwrap().project_path =
        choice_b["projectPath"].as_str().unwrap().into();
    let b = Bridge::new(DayRoot::new(f.host_for(source)));
    let read = f.call(&b, "day.projects.read", json!({}));
    assert!(
        read["value"]["operations"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["operationId"] == op && r["state"] == "unknown")
    );
    f.stats("delete-other");
    let checked = f.call(&b, "day.chat.check", json!({"operationId":op}));
    assert_eq!(
        checked["value"]["outcome"]["state"], "accepted",
        "{checked}"
    );
    assert_eq!(
        checked["value"]["outcome"]["receipt"]["result"]["projectId"],
        choice_b["projectId"]
    );
    let mut deleted = choice_b.clone();
    deleted["draftId"] = json!(uuid::Uuid::new_v4().to_string());
    assert_eq!(create(&f, &b, &deleted)["error"], "stale");
    let stats = f.stats("stats");
    assert_eq!(stats["sessions"], 2);
    assert_eq!(stats["posts"], 2);
    assert_eq!(stats["lookups"], 1);
    assert_eq!(stats["external"], 0);
    close(b);
}

#[test]
fn profile_and_project_reads_share_identity_protocol_errors_not_feature_requirements() {
    let mut f = Fixture::new();
    let b = f.bridge();
    let list = projects(&f, &b);
    let choice = select(&f, &b, &list[0], "build");
    for (mode, profile_error, project_error) in [
        ("hello-daemon", Some("identity"), Some("identity")),
        ("hello-lineage", Some("identity"), Some("identity")),
        (
            "hello-identity-before-protocol",
            Some("identity"),
            Some("identity"),
        ),
        ("hello-minimum", Some("unavailable"), Some("unavailable")),
        (
            "hello-missing-minimum",
            Some("unavailable"),
            Some("unavailable"),
        ),
        ("hello-protocol", Some("unavailable"), Some("unavailable")),
        (
            "hello-string-protocol",
            Some("unavailable"),
            Some("unavailable"),
        ),
        ("hello-execution", Some("unavailable"), Some("unavailable")),
        (
            "hello-string-execution",
            Some("unavailable"),
            Some("unavailable"),
        ),
        ("hello-no-day", None, Some("unavailable")),
        ("hello-no-controls", None, None),
    ] {
        f.stats(mode);
        for (method, expected) in [
            ("day.projects.read", profile_error),
            ("day.intake.read", project_error),
        ] {
            let result = f.call(&b, method, json!({}));
            if let Some(error) = expected {
                assert_eq!(result["error"], error, "{mode} {method}: {result}");
                assert!(
                    result["value"].is_null(),
                    "no successful empty read: {result}"
                );
            } else {
                assert!(
                    result["value"]["snapshot"].is_object(),
                    "{mode} {method}: {result}"
                );
            }
        }
        if let Some(error) = profile_error {
            assert_eq!(create(&f, &b, &choice)["error"], error, "{mode}");
        }
    }
    f.stats("allow");
    f.stats("delete-selected");
    assert_eq!(
        projects(&f, &b).len(),
        1,
        "profile reads do not require the old project"
    );
    assert_eq!(
        f.call(&b, "day.intake.read", json!({}))["error"],
        "identity"
    );
    let stats = f.stats("stats");
    assert_eq!(stats["posts"], 0);
    assert_eq!(stats["sessions"], 0);
    assert_eq!(stats["lookups"], 0);
    assert_eq!(stats["external"], 0);
    close(b);
}

#[test]
fn saved_window_read_is_exact_source_passive_and_refuses_changed_scope() {
    let mut f = Fixture::new();
    let b = f.bridge();
    assert!(f.call(&b, "day.window.read", json!({}))["value"]["snapshot"].is_null());
    assert_eq!(
        f.call(&b, "day.window.read", json!({"projectId":"forged"}))["error"],
        "invalid"
    );
    let list = projects(&f, &b);
    let p = list
        .iter()
        .find(|p| p["projectId"] == f.info["source"]["project_id"])
        .unwrap();
    let choice = select(&f, &b, p, "ask");
    capture(&f, &b, &choice);
    close(b);
    let b = f.bridge();
    let read = f.call(&b, "day.window.read", json!({}));
    assert_eq!(read["value"]["snapshot"]["chat"], choice, "{read}");
    assert_eq!(
        read["value"]["snapshot"]["goal"],
        "  Exact words 👩🏽‍💻\nkept  "
    );
    // Revoke the exact native capability, not just the fixture's intake route.
    use std::os::unix::fs::PermissionsExt;
    let capability =
        PathBuf::from(f.info["source"]["profile"].as_str().unwrap()).join("github-app-capability");
    std::fs::set_permissions(&capability, std::fs::Permissions::from_mode(0o644)).unwrap();
    assert_eq!(
        f.call(&b, "day.window.read", json!({}))["error"],
        "identity"
    );
    std::fs::set_permissions(&capability, std::fs::Permissions::from_mode(0o600)).unwrap();
    assert_eq!(f.call(&b, "day.window.read", json!({})), read);
    // An interrupted next capture (no form ACK) must not erase the prior one.
    b.begin_capture().unwrap();
    assert_eq!(
        f.call(&b, "day.window.read", json!({})),
        read,
        "startup read is allowed while close waits for forms"
    );
    close(b);
    let b = f.bridge();
    assert_eq!(f.call(&b, "day.window.read", json!({})), read);
    close(b);
    let original: Source = serde_json::from_value(f.info["source"].clone()).unwrap();
    for field in ["project", "profile", "home", "path"] {
        let mut other = original.clone();
        match field {
            "project" => other.project_id = "different-project".into(),
            "profile" => other.profile = f.dir.join("different-profile"),
            "home" => other.home.lineage_id = "different-lineage".into(),
            _ => other.project_path = "/different/path".into(),
        }
        let host = NativeHost::open(other, f.info["ledger"].as_str().unwrap().into()).unwrap();
        let b = Bridge::new(DayRoot::new(host));
        assert!(
            f.call(&b, "day.window.read", json!({}))["value"]["snapshot"].is_null(),
            "{field}"
        );
        close(b);
    }
    let b = f.bridge();
    let generation = b.request_flush().unwrap();
    let mut invalid = read["value"]["snapshot"].clone();
    invalid["y"] = json!(-1);
    assert_eq!(
        f.call(
            &b,
            "day.flush.ack",
            json!({"generation":generation,"view":invalid})
        )["error"],
        "invalid"
    );
    close(b);
    let b = f.bridge();
    assert_eq!(
        f.call(&b, "day.window.read", json!({})),
        read,
        "invalid capture never overwrites the draft"
    );
    f.stats("delete-selected");
    let missing = f.call(&b, "day.window.read", json!({}));
    assert!(
        missing["error"].is_string(),
        "deleted project cannot return saved content: {missing}"
    );
    close(b);
    let stats = f.stats("stats");
    assert_eq!(stats["posts"], 0);
    assert_eq!(stats["sessions"], 0);
    assert_eq!(stats["lookups"], 0);
    assert_eq!(stats["external"], 0);
}

#[test]
fn absent_nsh_host_capability_denies_creation_before_native_dispatch() {
    let mut f = Fixture::new();
    let b = f.bridge();
    let list = projects(&f, &b);
    let choice = select(&f, &b, &list[0], "build");
    std::fs::write(
        f.dir.join("nsh.json"),
        json!({"name":"Denied fixture","id":"test.denied","capabilities":{}}).to_string(),
    )
    .unwrap();
    let result = create(&f, &b, &choice);
    assert!(result["error"].is_string(), "{result}");
    assert_eq!(f.stats("stats")["posts"], 0);
    assert_eq!(f.stats("stats")["sessions"], 0);
    close(b);
}

#[test]
fn denied_offline_stale_choice_and_close_refuse_without_creating() {
    let mut f = Fixture::new();
    let b = f.bridge();
    let list = projects(&f, &b);
    let choice = select(&f, &b, &list[0], "build");
    // Existing selected-project intake and chats are not changed by selection.
    f.read(&b);
    f.stats("deny");
    assert_eq!(create(&f, &b, &choice)["error"], "identity");
    f.stats("offline");
    f.stats("allow");
    f.stats("offline");
    assert_eq!(create(&f, &b, &choice)["error"], "offline");
    f.stats("allow");
    let mut forged = choice.clone();
    forged["missionId"] = json!("not-a-chat");
    assert_eq!(create(&f, &b, &forged)["error"], "invalid");
    capture(&f, &b, &choice);
    assert_eq!(create(&f, &b, &choice)["error"], "busy");
    assert_eq!(f.stats("stats")["posts"], 0);
    assert_eq!(f.stats("stats")["sessions"], 0);
    close(b);
    let b = f.bridge();
    close(b);
    assert_eq!(f.stats("stats")["sessions"], 0);
}

#[test]
fn acknowledgement_save_failure_keeps_exact_evidence_but_stays_unknown_until_cold_lookup() {
    let mut f = Fixture::new();
    let b = f.bridge();
    let list = projects(&f, &b);
    let choice = select(&f, &b, &list[0], "build");
    f.stats("fail-save");
    let result = create(&f, &b, &choice);
    let outcome = &result["value"]["outcome"];
    assert_eq!(outcome["state"], "unknown", "{result}");
    assert_eq!(outcome["receiptSaved"], false);
    assert_eq!(
        outcome["receipt"]["state"], "accepted",
        "exact volatile ACK is not erased"
    );
    assert_eq!(b.close().recv_blocking().unwrap(), Err(Error::Storage));
    f.stats("restore-ledger");
    let b = f.bridge();
    let result = f.call(
        &b,
        "day.chat.check",
        json!({"operationId":outcome["operationId"]}),
    );
    assert_eq!(result["value"]["outcome"]["state"], "accepted", "{result}");
    let stats = f.stats("stats");
    assert_eq!(stats["posts"], 1);
    assert_eq!(stats["lookups"], 1);
    assert_eq!(stats["sessions"], 1);
    close(b);
}
