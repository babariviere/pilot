//! Two real daemon projects, one window and one lost settings receipt.
include!("support/intake_fixture.rs");

#[test]
fn preferences_follow_the_explicit_project_not_window_focus() {
    let mut command = Command::new("node");
    command.arg(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../packages/daemon/src/fixtures/day-native-planning.ts"),
    );
    command.args(["--quiet-events", "--preference-projects"]);
    let mut f = Fixture::with_command(command);
    let fixed: Source = serde_json::from_value(f.info["source"].clone()).unwrap();
    let a = fixed.project.as_ref().unwrap().project_id.clone();
    let mut global = fixed.clone();
    global.project = None;
    let global_bridge = |f: &Fixture, source: Source| {
        let host = NativeHost::open_with_options(
            source,
            f.info["ledger"].as_str().unwrap().into(),
            Default::default(),
        )
        .unwrap();
        Bridge::new(DayRoot::new(host))
    };
    let bridge = global_bridge(&f, global.clone());
    let catalog = f.call(&bridge, "day.preferences.projects.read", json!({}));
    let projects = catalog["value"]["snapshot"]["projects"].as_array().unwrap();
    assert_eq!(projects.len(), 2, "{catalog}");
    let b = projects
        .iter()
        .find_map(|r| r["id"].as_str().filter(|id| *id != a.as_str()))
        .unwrap()
        .to_owned();
    let read = |bridge: &Bridge, f: &Fixture, project: &str| {
        f.call(bridge, "day.preferences.read", json!({"projectId":project}))
    };
    for id in [&a, &b] {
        let r = read(&bridge, &f, id);
        assert_eq!(r["value"]["snapshot"]["projectId"], *id, "{r}");
        assert_eq!(r["value"]["snapshot"]["preferences"]["revision"], 0, "{r}");
    }
    writeln!(f.input, "{}", json!({"action":"lost","value":true})).unwrap();
    f.input.flush().unwrap();
    assert_eq!(f.output.recv_timeout(WAIT).unwrap()["posts"], 0);
    let intent =
        json!({"projectId":b,"expectedRevision":0,"entries":[{"id":null,"text":"Only B"}]});
    let save = f.call(&bridge, "day.preferences.save", intent.clone());
    assert_eq!(save["value"]["outcome"]["state"], "unknown", "{save}");
    let id = &save["value"]["outcome"]["operationId"];
    assert!(id.is_string());
    assert_eq!(
        f.call(&bridge, "day.preferences.save", intent.clone())["error"],
        "unknown"
    );
    let a_read = read(&bridge, &f, &a);
    assert_eq!(
        a_read["value"]["snapshot"]["preferences"]["revision"], 0,
        "{a_read}"
    );
    assert_eq!(a_read["value"]["operations"], json!([]), "{a_read}");
    assert_eq!(
        f.call(&bridge, "day.navigation.project", json!({}))["value"]["snapshot"],
        Value::Null
    );
    close(bridge);

    let bridge = global_bridge(&f, global);
    let wrong = f.call(
        &bridge,
        "day.preferences.check",
        json!({"projectId":a,"operationId":id}),
    );
    assert_eq!(wrong["error"], "unknown", "{wrong}");
    let checked = f.call(
        &bridge,
        "day.preferences.check",
        json!({"projectId":b,"operationId":id}),
    );
    assert_eq!(
        checked["value"]["outcome"]["state"], "accepted",
        "{checked}"
    );
    assert_eq!(
        checked["value"]["outcome"]["receipt"]["result"]["projectId"], b,
        "{checked}"
    );
    let history = f.call(&bridge, "day.preferences.history", json!({"projectId":b}));
    assert_eq!(
        history["value"]["snapshot"]["revisions"][0]["entries"][0]["text"], "Only B",
        "{history}"
    );
    assert_eq!(
        f.call(&bridge, "day.navigation.project", json!({}))["value"]["snapshot"],
        Value::Null
    );
    close(bridge);

    let bridge = f.bridge();
    let catalog = f.call(&bridge, "day.preferences.projects.read", json!({}));
    assert_eq!(
        catalog["value"]["snapshot"]["projects"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(read(&bridge, &f, &b)["error"], "identity");
    assert_eq!(
        f.call(&bridge, "day.preferences.save", intent)["error"],
        "identity"
    );
    assert_eq!(
        f.call(&bridge, "day.preferences.history", json!({"projectId":b}))["error"],
        "identity"
    );
    assert_eq!(
        f.call(
            &bridge,
            "day.preferences.check",
            json!({"projectId":b,"operationId":id})
        )["error"],
        "identity"
    );
    let stats = f.stats("stats");
    assert_eq!(stats["posts"], 1);
    assert_eq!(stats["lookups"], 1);
    close(bridge);
}
