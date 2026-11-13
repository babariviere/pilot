//! The window's project and mission artifact rows and their exact saved
//! sources, on the released host channel over an isolated real daemon
//! (`packages/daemon/src/fixtures/day-delivered-artifact.ts`). Headless: no
//! window, provider or external write. Reading records and sends nothing.
include!("support/intake_fixture.rs");

fn rows(v: &Value) -> &Vec<Value> {
    v["value"]["snapshot"]["rows"].as_array().unwrap()
}

#[test]
fn project_and_mission_rows_read_exact_revisions_as_inert_text() {
    let mut f = Fixture::with_daemon("day-delivered-artifact.ts");
    let nsh = f.stats("nsh");
    let nsh_id = nsh["nshId"].as_str().unwrap().to_owned();
    let b = f.bridge();
    let id = f.info["artifactId"].as_str().unwrap().to_owned();
    let mission = f.info["task"]["missionId"].as_str().unwrap().to_owned();

    // The project: every saved artifact of its chats, at its current revision.
    let project = f.call(&b, "day.artifacts.read", json!({}));
    assert_eq!(
        project["value"]["snapshot"]["projectId"],
        f.info["task"]["projectId"]
    );
    assert_eq!(project["value"]["snapshot"]["more"], false);
    let row = |list: &Value, id: &str| {
        rows(list)
            .iter()
            .filter(|r| r["artifactId"] == id)
            .cloned()
            .collect::<Vec<_>>()
    };
    assert_eq!(row(&project, &id)[0]["revision"], 2, "{project}");
    assert_eq!(row(&project, &nsh_id)[0]["kind"], "nsh");

    // The mission: its links with their pins and tasks, newest first.
    let linked = f.call(&b, "day.artifacts.read", json!({"missionId":mission}));
    let pins: Vec<_> = row(&linked, &id)
        .iter()
        .map(|r| r["revision"].clone())
        .collect();
    assert_eq!(pins.len(), 2, "{linked}");
    assert!(pins.contains(&json!(1)) && pins.contains(&json!(2)));
    let preview = row(&linked, &nsh_id)[0].clone();
    assert_eq!(
        preview["revision"], 1,
        "a pin never follows the latest revision"
    );
    assert_eq!(preview["pinned"], true);
    assert_eq!(preview["taskTitle"], "Saved output");
    assert_eq!(rows(&linked)[0]["artifactId"], nsh_id, "newest link first");

    // One exact revision, inert text.
    let session = preview["sessionId"].clone();
    let read = |f: &Fixture, artifact: &str, revision: u64| {
        f.call(
            &b,
            "day.artifacts.source",
            json!({"sourceSessionId":session,"artifactId":artifact,"revision":revision}),
        )
    };
    let saved = read(&f, &nsh_id, 1);
    let snapshot = &saved["value"]["snapshot"];
    assert_eq!(snapshot["content"]["source"], nsh["nshSource"], "{saved}");
    assert_eq!(snapshot["reference"]["revision"], 1);
    assert_eq!(snapshot["reference"]["artifactId"], nsh_id);
    assert_eq!(snapshot["metadata"]["kind"], "nsh");
    assert_eq!(snapshot["rendering"], "unsupported");
    let older = read(&f, &id, 1);
    assert_eq!(
        older["value"]["snapshot"]["content"]["source"],
        "<script>throw Error('never execute')</script>"
    );
    assert!(read(&f, &id, 3)["error"].is_string(), "no revision 3");
    assert!(read(&f, &uuid::Uuid::new_v4().to_string(), 1)["error"].is_string());
    // Another project's mission or a selector field is refused.
    assert!(f.call(&b, "day.artifacts.read", json!({"missionId":"missing"}))["error"].is_string());
    assert_eq!(
        f.call(&b, "day.artifacts.read", json!({"projectId":"other"}))["error"],
        "invalid"
    );
    f.stats("redacted");
    assert_eq!(
        read(&f, &id, 1)["value"]["snapshot"]["content"],
        json!({"state":"unavailable","reason":"redacted"})
    );
    let stats = f.stats("stats");
    assert_eq!(stats["posts"], 0);
    assert_eq!(stats["messages"], json!([]));
    close(b);
}
