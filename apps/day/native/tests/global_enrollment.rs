//! Profile-only New reuses explicit native choices and the existing trusted planning journey.
include!("support/intake_fixture.rs");

fn command(f: &mut Fixture, action: &str, value: bool) -> Value {
    writeln!(f.input, "{}", json!({"action":action,"value":value})).unwrap();
    f.input.flush().unwrap();
    f.output.recv_timeout(WAIT).unwrap()
}
fn global(f: &Fixture) -> (NativeHost, Bridge) {
    let mut source: Source = serde_json::from_value(f.info["source"].clone()).unwrap();
    source.project = None;
    let host = NativeHost::open(source, f.info["ledger"].as_str().unwrap().into()).unwrap();
    let bridge = Bridge::new(DayRoot::new(host.clone()));
    (host, bridge)
}
fn choose(f: &Fixture, b: &Bridge) -> Value {
    let projects = f.call(b, "day.projects.read", json!({}));
    let project = &projects["value"]["snapshot"]["projects"][0];
    let selected = f.call(
        b,
        "day.chat.select",
        json!({"projectId":project["projectId"],
        "contextDigest":project["contextDigest"],"mode":"build"}),
    );
    assert!(
        selected["value"]["snapshot"]["draftId"].is_string(),
        "{selected}"
    );
    selected["value"]["snapshot"].clone()
}
fn prepare(f: &Fixture, b: &Bridge) -> Value {
    for _ in 0..5 {
        let read = f.call(b, "day.plan.prepare", json!({}));
        if read["error"] != "stale" {
            return read;
        }
    }
    panic!("passive setup read did not settle");
}

#[test]
fn profile_only_explicit_choice_stale_setup_lost_ack_and_restart_are_lookup_only() {
    let mut f = Fixture::with_daemon("day-planning-enrollment.ts");
    command(&mut f, "quiet", true);
    let (host, b) = global(&f);
    assert_eq!(prepare(&f, &b)["error"], "unavailable");
    assert!(host.planning_setup().is_none());
    let choice = choose(&f, &b);
    let setup = prepare(&f, &b)["value"]["snapshot"].clone();
    assert_eq!(setup["project"], choice["projectPath"]);
    assert_eq!(setup["model"], choice["model"]);
    assert_eq!(
        prepare(&f, &b)["value"]["snapshot"],
        setup,
        "passive refresh keeps operation identity"
    );
    let stats = f.stats("stats");
    assert_eq!(stats["posts"], 0);
    assert_eq!(stats["workers"], 0);
    let goal = "  Clarify my exact goal 👩🏽‍💻\nkept  ";
    let intent = json!({"setup":setup["digest"],"goal":goal});
    // A later explicit selection invalidates the earlier setup, even for the same project.
    choose(&f, &b);
    assert!(host.planning_setup().is_none());
    assert_eq!(
        f.call(&b, "day.plan.create", intent.clone())["error"],
        "stale"
    );
    let setup = prepare(&f, &b)["value"]["snapshot"].clone();
    let intent = json!({"setup":setup["digest"],"goal":goal});
    command(&mut f, "lost", true);
    let lost = f.call(&b, "day.plan.create", intent.clone());
    assert_eq!(lost["value"]["outcome"]["status"], "unknown", "{lost}");
    assert_eq!(
        f.call(&b, "day.plan.create", intent.clone())["value"]["outcome"]["status"],
        "unknown"
    );
    assert_eq!(prepare(&f, &b)["error"], "unknown");
    let operation = host.planning_enrollments()[0]["operationId"].clone();
    close(b);
    let (host, b) = global(&f);
    assert!(
        host.planning_setup().is_none(),
        "reopen grants no fresh selection"
    );
    assert_eq!(prepare(&f, &b)["error"], "unknown");
    assert_eq!(host.planning_enrollments()[0]["operationId"], operation);
    let checked = f.call(&b, "day.plan.checkNew", json!({}));
    assert_eq!(
        checked["value"]["outcome"]["status"], "accepted",
        "{checked}"
    );
    let mission = checked["value"]["snapshot"]["missionId"]
        .as_str()
        .unwrap()
        .to_owned();
    command(&mut f, "generate", true);
    command(&mut f, "held", false);
    let read = f.call(&b, "day.plan.read", json!({"missionId":mission}));
    assert!(read["value"]["snapshot"]["interview"].is_object(), "{read}");
    let current = host.planning(&mission).unwrap();
    assert_eq!(current["projectId"], choice["projectId"]);
    let interview = &current["view"]["interview"];
    let answers: Vec<_> = interview["questions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|q| {
            json!({
        "questionId":q["id"],"questionDigest":current["questionDigests"][q["id"].as_str().unwrap()],
        "selectedOption":q["options"][0],"text":""})
        })
        .collect();
    let result = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
        host.write_interview(mission, current["contextDigest"].as_str().unwrap().into(), json!({
            "purpose":"interview-save","expected":{"fence":interview["fence"],"revision":interview["revision"]},"answers":answers
        })).recv().await.unwrap().unwrap()
    });
    assert_eq!(result.status, pilot_day_native::OutcomeStatus::Accepted);
    let stats = f.stats("stats");
    assert_eq!(
        stats["posts"], 2,
        "one enrollment and one explicit answer save only"
    );
    assert_eq!(stats["workers"], 1);
    assert_eq!(stats["goal"], goal);
    assert_eq!(stats["tasks"], 0, "planning is not Build admission");
    close(b);
    f.stats("close");
    assert!(f.child.wait().unwrap().success());
}

#[test]
fn changed_project_and_unavailable_configured_model_never_fall_back_or_enroll() {
    let mut f = Fixture::with_daemon("day-planning-enrollment.ts");
    command(&mut f, "quiet", true);
    let (host, b) = global(&f);
    choose(&f, &b);
    let setup = prepare(&f, &b)["value"]["snapshot"].clone();
    command(&mut f, "configuration", true);
    assert_eq!(
        f.call(
            &b,
            "day.plan.create",
            json!({"setup":setup["digest"],"goal":"Exact goal"})
        )["error"],
        "stale"
    );
    assert!(host.planning_setup().is_none());
    let projects = f.call(&b, "day.projects.read", json!({}));
    let project = &projects["value"]["snapshot"]["projects"][0];
    let selection = f.call(
        &b,
        "day.chat.select",
        json!({"projectId":project["projectId"],
        "contextDigest":project["contextDigest"],"mode":"build"}),
    );
    assert_eq!(
        selection["error"], "unavailable",
        "missing configured model is not substituted"
    );
    assert_eq!(f.stats("stats")["posts"], 0);
    close(b);
    f.stats("close");
    assert!(f.child.wait().unwrap().success());
}

#[test]
fn legacy_enrollment_uncertainty_blocks_profile_only_creation_until_exact_lookup() {
    let mut f = Fixture::with_daemon("day-planning-enrollment.ts");
    command(&mut f, "quiet", true);
    let source: Source = serde_json::from_value(f.info["source"].clone()).unwrap();
    let host = f.host_for_options(
        source,
        pilot_day_native::host::Options {
            planning_model: Some("faux/faux-1".into()),
            ..Default::default()
        },
    );
    let b = Bridge::new(DayRoot::new(host.clone()));
    let setup = prepare(&f, &b)["value"]["snapshot"].clone();
    command(&mut f, "lost", true);
    let intent = json!({"setup":setup["digest"],"goal":"Legacy exact goal"});
    let sent = f.call(&b, "day.plan.create", intent.clone());
    assert_eq!(sent["value"]["outcome"]["status"], "unknown", "{sent}");
    close(b);
    let (_, b) = global(&f);
    assert_eq!(prepare(&f, &b)["error"], "unknown");
    assert_eq!(
        f.call(&b, "day.plan.create", intent)["value"]["outcome"]["status"],
        "unknown"
    );
    let checked = f.call(&b, "day.plan.checkNew", json!({}));
    assert_eq!(
        checked["value"]["outcome"]["status"], "accepted",
        "{checked}"
    );
    assert_eq!(
        f.stats("stats")["posts"],
        1,
        "startup never re-enters enrollment"
    );
    close(b);
    f.stats("close");
    assert!(f.child.wait().unwrap().success());
}
