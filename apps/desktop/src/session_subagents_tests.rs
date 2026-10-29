use super::*;
use serde_json::json;

#[test]
fn canonical_children_are_not_mission_members_or_tool_summaries() {
    assert!(
        !read(
            &json!({"missionId":"m", "members":[{"name":"worker"}], "tools":[{"name":"subagent"}]})
        )
        .visible()
    );
    let raw = json!({"subagents":[{"name":"Review/日本 %?#", "state":"working", "createdAt":1}, {"name":"review/日本 %?#", "state":"idle", "createdAt":2}]});
    let r = read(&raw);
    assert_eq!(r.children.len(), 2);
    assert_eq!(r.children[0].name, "Review/日本 %?#");
    assert_eq!(r.children[1].state, State::Idle);
    assert!(read(&json!({"subagents":[{"name":"same"},{"name":"same"}]})).unavailable);
    for value in [
        json!({}),
        json!(true),
        json!([{"name":""}]),
        json!([{"name":".."}]),
    ] {
        assert!(read(&json!({"subagents":value})).unavailable);
    }
}

#[test]
fn lifecycle_does_not_turn_idle_or_offline_into_finished_or_running() {
    let mut value =
        json!({"state":"idle", "subagents":[{"name":"child", "state":"idle", "createdAt":1}]});
    assert_eq!(read(&value).children[0].state, State::Idle);
    value["subagents"][0]["lastAnswerId"] = json!("ANSWER-A");
    assert_eq!(read(&value).children[0].state, State::Done);
    value["subagents"][0]["error"] = json!("Synthetic failure");
    assert_eq!(read(&value).children[0].state, State::Failed);
    value["subagents"][0]["state"] = json!("working");
    assert_eq!(read(&value).children[0].state, State::Working);
    assert_eq!(read(&value).summary(false), "1 subagent · Last reported");
    value["offlinePaused"] = json!(true);
    assert_eq!(read(&value).children[0].state, State::Paused);
    value["offlinePaused"] = json!(false);
    value["state"] = json!("parked");
    assert_eq!(read(&value).children[0].state, State::Unknown);
    value["subagents"][0]["state"] = json!("other");
    assert_eq!(read(&value).children[0].state, State::Unknown);
    assert!(!read(&json!({"subagents":[]})).visible());
}

#[test]
fn snapshot_requires_exact_child_identity_and_full_snapshot() {
    assert!(transcript(&json!({"name":"Child", "full":true, "events":[]}), "child").is_err());
    assert!(transcript(&json!({"name":"child", "full":false, "events":[]}), "child").is_err());
    assert!(transcript(&json!({"name":"child", "full":true}), "child").is_err());
    assert!(
        transcript(&json!({"name":"child", "full":true, "events":[]}), "child")
            .unwrap()
            .is_empty()
    );
}

#[test]
fn subagent_draft_keys_preserve_parent_name_case_unicode_and_spawn() {
    let child =
        read(&json!({"subagents":[{"name":"Review/日本 %?#","state":"idle","createdAt":1}]}))
            .children[0]
            .clone();
    let target = Target::new("Parent-A", &child).unwrap();
    assert_eq!(Target::from_key(&target.key()), Some(target.clone()));
    assert_ne!(
        Target {
            parent: "parent-a".into(),
            ..target.clone()
        }
        .key(),
        target.key()
    );
    assert_ne!(
        Target {
            name: "review/日本 %?#".into(),
            ..target.clone()
        }
        .key(),
        target.key()
    );
    assert_ne!(
        Target {
            created_at: 2f64.to_bits(),
            ..target.clone()
        }
        .key(),
        target.key()
    );
    assert!(crate::delivery_store::valid_key(&target.key()));
    for key in [
        "subagent:Parent-A:1:!!!",
        "subagent:Parent/A:3ff0000000000000:YQ",
        "subagent:Parent-A:3ff0000000000000:",
    ] {
        assert!(!crate::delivery_store::valid_key(key));
    }
}

#[tokio::test]
async fn exact_encoded_read_is_get_only_and_identity_pinned() {
    let server = crate::session_subagents_fixture::Server::start();
    let name = "Review/日本 %?#";
    let rows = crate::local_client::subagent_snapshot(&server.options, "Parent-A", name)
        .await
        .unwrap();
    assert_eq!(
        rows.iter().map(|r| r.source()).collect::<Vec<_>>(),
        ["Synthetic child task", "Synthetic child answer"]
    );
    let requests = server.requests.lock().unwrap().clone();
    assert_eq!(requests.len(), 3);
    assert_eq!(
        requests[1],
        "GET /api/sessions/Parent-A/subagents/Review%2F%E6%97%A5%E6%9C%AC%20%25%3F%23/transcript HTTP/1.1"
    );
    *server.daemon.lock().unwrap() = "other-daemon".into();
    assert!(
        crate::local_client::subagent_snapshot(&server.options, "Parent-A", name)
            .await
            .is_err()
    );
    assert_eq!(
        server.requests.lock().unwrap().len(),
        4,
        "refuse before child read"
    );
    *server.daemon.lock().unwrap() = "test-daemon".into();
    server.response.lock().unwrap()["name"] = json!("review/日本 %?#");
    assert!(
        crate::local_client::subagent_snapshot(&server.options, "Parent-A", name)
            .await
            .is_err()
    );
    *server.code.lock().unwrap() = 404;
    assert!(
        crate::local_client::subagent_snapshot(&server.options, "Parent-A", name)
            .await
            .is_err()
    );
}
