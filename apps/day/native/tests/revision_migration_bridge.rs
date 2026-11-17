//! Real native HTTP and durable lookup. Fake participants are not process-exit qualification.
include!("support/intake_fixture.rs");

#[test]
fn native_revision_scopes_checkpoint_and_legacy_finish_is_exact_and_lookup_only() {
    let mut f = Fixture::with_daemon("day-revision-migration.ts");
    let b = f.bridge();
    let mission = f.info["mission"].as_str().unwrap().to_owned();
    let old = f.info["old"].as_str().unwrap().to_owned();
    let read = f.call(&b, "day.plan.read", json!({"missionId":mission}));
    assert_eq!(
        read["value"]["snapshot"]["revisit"]["revision"]["selectivePause"], true,
        "{read}"
    );
    let intent =
        json!({"missionId":mission,"revisionId":f.info["proposal"],"digest":f.info["digest"]});
    let pause = f.call(&b, "day.plan.pauseRevision", intent.clone());
    assert_eq!(pause["value"]["outcome"]["status"], "accepted", "{pause}");
    let stats = f.stats("stats");
    let mut expected: Vec<_> = f.info["owners"].as_array().unwrap()[..2]
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    expected.sort();
    assert_eq!(stats["paused"], json!(expected));
    assert_eq!(stats["independentHeld"], false);
    let confirm = f.call(&b, "day.plan.confirmRevision", intent);
    assert_eq!(
        confirm["value"]["outcome"]["status"], "accepted",
        "{confirm}"
    );
    let preview_request = json!({"missionId":old,"successorId":mission,"action":"read"});
    let preview = f.call(&b, "day.mission.migration", preview_request.clone());
    assert_eq!(
        preview["value"]["snapshot"]["state"], "preview",
        "{preview}"
    );
    assert_eq!(
        preview["value"]["snapshot"]["oldAgreement"],
        "Keep this history"
    );
    assert!(preview["value"]["snapshot"]["publicationId"].is_string());
    f.stats("change-old");
    let before = f.stats("stats")["posts"].clone();
    let stale = f.call(&b, "day.mission.migration", json!({"missionId":old,"successorId":mission,"action":"finish","digest":preview["value"]["snapshot"]["digest"]}));
    assert_eq!(stale["error"], "stale", "{stale}");
    assert_eq!(f.stats("stats")["posts"], before);
    let preview = f.call(&b, "day.mission.migration", preview_request);
    f.stats("lost");
    let lost = f.call(&b, "day.mission.migration", json!({"missionId":old,"successorId":mission,"action":"finish","digest":preview["value"]["snapshot"]["digest"]}));
    assert_eq!(lost["value"]["snapshot"]["state"], "unknown", "{lost}");
    close(b);
    let b = f.bridge();
    let before = f.stats("stats")["posts"].clone();
    let checked = f.call(
        &b,
        "day.mission.migration",
        json!({"missionId":old,"successorId":mission,"action":"check"}),
    );
    assert_eq!(
        checked["value"]["snapshot"]["state"], "finished",
        "{checked}"
    );
    let stats = f.stats("stats");
    assert_eq!(stats["posts"], before);
    assert_eq!(stats["oldStatus"], "archived");
    assert_eq!(stats["inputs"], 0);
    let history = f.call(
        &b,
        "day.mission.migration",
        json!({"missionId":old,"successorId":mission,"action":"history"}),
    );
    assert_eq!(
        history["value"]["snapshot"]["state"], "history",
        "{history}"
    );
    assert_eq!(
        history["value"]["snapshot"]["oldAgreement"],
        "Keep this history"
    );
    assert_eq!(
        f.stats("stats")["posts"],
        before,
        "reading history starts nothing"
    );
    close(b);
    f.stats("close");
    assert!(f.child.wait().unwrap().success());
}
