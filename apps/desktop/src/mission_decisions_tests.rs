use super::*;
use serde_json::json;
fn decision(id: &str) -> Value {
    json!({"id":id,"number":1,"audience":"reference","text":"Binding 私 👩‍💻\nSecond line"})
}
fn proposal(id: &str) -> Value {
    json!({"id":id,"decisionId":"d1","kind":"edit","status":"pending","reason":"A suggestion, not policy","text":"Do something else"})
}
#[test]
fn absent_empty_malformed_and_pending_are_distinct() {
    let s = project(&json!({})).unwrap();
    assert!(s.decisions.rows.is_none() && s.proposals.rows.is_none());
    let s = project(&json!({"decisions":[],"decisionProposals":[]})).unwrap();
    assert!(s.decisions.rows.unwrap().is_empty());
    assert!(s.proposals.rows.unwrap().is_empty());
    assert!(project(&json!({"decisions":null})).is_err());
    let mut accepted = proposal("accepted");
    accepted["status"] = json!("accepted");
    let s = project(
        &json!({"decisions":[decision("d1")],"decisionProposals":[proposal("p1"),accepted]}),
    )
    .unwrap();
    assert_eq!(
        s.decisions.rows.unwrap()[0].text.value,
        decision("d1")["text"]
    );
    assert_eq!(s.proposals.received, 2);
    assert_eq!(s.proposals.rows.unwrap().len(), 1);
}
#[test]
fn untrusted_rows_do_not_infer_author_time_revision_or_target() {
    let mut p = proposal("p1");
    p["decisionId"] = json!("removed");
    p["kind"] = json!("remove");
    p.as_object_mut().unwrap().remove("text");
    let s = project(&json!({"decisions":[],"decisionProposals":[p]})).unwrap();
    let p = &s.proposals.rows.unwrap()[0];
    assert_eq!(p.target, "removed");
    assert_eq!(p.kind, Kind::Remove);
    assert!(p.text.is_none());
    for audience in ["all", "coordinator", "reference"] {
        let mut d = decision("d1");
        d["audience"] = json!(audience);
        assert!(project(&json!({"decisions":[d]})).is_ok());
    }
    let mut d = decision("d1");
    d.as_object_mut().unwrap().remove("audience");
    assert!(
        project(&json!({"decisions":[d]}))
            .unwrap()
            .decisions
            .rows
            .unwrap()[0]
            .audience
            .contains("Unknown")
    );
    let mut p = proposal("p1");
    p["status"] = json!("new status");
    assert!(project(&json!({"decisionProposals":[p]})).is_err());
    assert!(project(&json!({"decisions":[decision("same"),decision("same")]})).is_err());
}
#[test]
fn collection_coverage_limit_is_independent_of_content_limits() {
    let rows: Vec<_> = (0..ITEM_CAP + 1)
        .map(|i| decision(&format!("d{i}")))
        .collect();
    let s = project(&json!({"decisions":rows})).unwrap();
    assert!(s.decisions.capped);
    assert_eq!(s.decisions.received, ITEM_CAP + 1);
    assert_eq!(s.decisions.rows.unwrap().len(), ITEM_CAP);
}
#[test]
fn legacy_decision_and_proposal_text_is_exact_without_write_limits() {
    let content = " Legacy 私👩‍💻\n".repeat(32 * 1024);
    let mut d = decision("d1");
    d["text"] = json!(content);
    let mut p = proposal("p1");
    p["text"] = json!(content);
    p["reason"] = json!(content);
    let s = project(&json!({"decisions":[d],"decisionProposals":[p]})).unwrap();
    let rows = s.decisions.rows.unwrap();
    assert_eq!(rows[0].text.value, content);
    assert!(!rows[0].text.clipped);
    let rows = s.proposals.rows.unwrap();
    assert_eq!(rows[0].text.as_ref().unwrap().value, content);
    assert_eq!(rows[0].reason.value, content);
}
#[tokio::test]
async fn existing_actual_reader_projects_decisions_without_new_endpoints() {
    use crate::{
        mission_browser_fixture::{self as f, Reply, Server},
        mission_reader::{self, Data, Route},
    };
    let server = Server::start();
    let mut detail = f::detail("mission-A");
    let content = " Legacy 私👩‍💻\n".repeat(2000);
    let mut d = decision("d1");
    d["text"] = json!(content);
    detail["decisions"] = json!([d]);
    detail["decisionProposals"] = json!([proposal("p1")]);
    server.reply("/api/missions/mission-A", Reply::json(200, detail));
    let Data::Detail(d, _) = mission_reader::fetch(
        &reqwest::Client::new(),
        &server.options,
        &Route::Detail(f::key("mission-A")),
    )
    .await
    .unwrap() else {
        panic!()
    };
    let s = d.decisions.as_ref().unwrap();
    assert_eq!(s.decisions.rows.as_ref().unwrap()[0].id, "d1");
    assert_eq!(s.decisions.rows.as_ref().unwrap()[0].text.value, content);
    assert_eq!(s.proposals.rows.as_ref().unwrap()[0].id, "p1");
    assert!(server.all_gets());
    assert_eq!(
        server
            .state
            .lock()
            .unwrap()
            .seen
            .iter()
            .map(|(_, p)| p.as_str())
            .collect::<Vec<_>>(),
        vec![
            "/api/hello",
            "/api/missions/mission-A",
            "/api/projects/project-A/knowledge?missionId=mission-A&limit=50",
            "/api/sessions?archived=all&missionId=mission-A",
            // The reader rechecks its pinned hello after the responses.
            "/api/hello"
        ]
    );
    let seen = server.state.lock().unwrap().seen.len();
    server.reply("/api/hello", Reply::json(200,json!({"daemonId":"foreign","lineageId":"test-lineage","minimumClientProtocolVersion":1})));
    assert!(
        mission_reader::fetch(
            &reqwest::Client::new(),
            &server.options,
            &Route::Detail(f::key("mission-A"))
        )
        .await
        .is_err()
    );
    assert_eq!(
        server.state.lock().unwrap().seen.len(),
        seen + 1,
        "wrong hello must not reach detail"
    );
    let mut foreign = f::key("mission-A");
    foreign.home.daemon = "foreign".into();
    assert!(
        mission_reader::fetch(
            &reqwest::Client::new(),
            &server.options,
            &Route::Detail(foreign)
        )
        .await
        .is_err()
    );
    assert_eq!(
        server.state.lock().unwrap().seen.len(),
        seen + 1,
        "foreign home never falls back to Local"
    );
}
fn withdraw(id: &str) -> Value {
    json!({"id":id,"decisionId":"d1","kind":"withdraw","status":"pending","reason":"No longer needed 私","operationId":"op-1","authorSessionId":"chat-A","createdAt":1})
}
#[test]
fn lifecycle_states_are_explicit_and_withdraw_is_never_remove() {
    let mut withdrawn = decision("d2");
    withdrawn["number"] = json!(2);
    withdrawn["withdrawn"] = json!({"at":5,"reason":"Superseded by practice","proposalId":"p9"});
    let mut replaced = decision("d3");
    replaced["number"] = json!(3);
    replaced["replacement"] = json!({"id":"d1","number":1,"at":7});
    let mut missing = decision("d4");
    missing["number"] = json!(4);
    // A successor outside this window keeps only its number; no body is invented.
    missing["replacement"] = json!({"id":"gone","number":40,"at":7});
    let mut legacy = withdraw("p2");
    legacy.as_object_mut().unwrap().remove("operationId");
    legacy["decisionId"] = json!("d4");
    let mut rejected = withdraw("p3");
    rejected["status"] = json!("rejected");
    let mut accepted = withdraw("p4");
    accepted["status"] = json!("accepted");
    let s = project(&json!({
        "decisions":[decision("d1"),withdrawn,replaced,missing],
        "decisionProposals":[withdraw("p1"),legacy,rejected,accepted],
    }))
    .unwrap();
    let rows = s.decisions.rows.unwrap();
    assert!(
        rows[0].active(),
        "pending and rejected proposals leave guidance active"
    );
    match &rows[1].retired {
        Some(Retired::Withdrawn { reason, proposal }) => {
            assert_eq!(reason.value, "Superseded by practice");
            assert_eq!(proposal, "p9");
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(
        rows[1].text.value,
        decision("d1")["text"],
        "original text stays readable"
    );
    assert!(matches!(&rows[2].retired, Some(Retired::Replaced { id, number: 1 }) if id == "d1"));
    assert!(matches!(&rows[3].retired, Some(Retired::Replaced { id, number: 40 }) if id == "gone"));
    let proposals = s.proposals.rows.unwrap();
    assert_eq!(s.proposals.received, 4);
    assert_eq!(proposals.len(), 2, "only pending proposals are listed");
    assert_eq!(proposals[0].kind, Kind::Withdraw);
    assert_eq!(proposals[0].operation.as_deref(), Some("op-1"));
    assert!(proposals[0].text.is_none());
    assert_eq!(proposals[1].kind, Kind::Withdraw);
    assert!(proposals[1].operation.is_none(), "operationId is optional");
}
#[test]
fn malformed_lifecycle_metadata_fails_closed() {
    let bad_decisions = [
        json!({"withdrawn":null}),
        json!({"withdrawn":{"at":1,"reason":"x"}}),
        json!({"withdrawn":{"at":1,"proposalId":"p"}}),
        json!({"withdrawn":{"at":"soon","reason":"x","proposalId":"p"}}),
        json!({"withdrawn":{"at":-1,"reason":"x","proposalId":"p"}}),
        json!({"replacement":{"id":"d9","at":1}}),
        json!({"replacement":{"id":"d9","number":0,"at":1}}),
        json!({"replacement":{"id":"bad id","number":9,"at":1}}),
        json!({"replacement":{"id":"d9","number":9}}),
        json!({"replacement":{"id":"d1","number":1,"at":1}}),
        json!({"replacement":{"id":"d9","number":9,"at":1},"withdrawn":{"at":1,"reason":"x","proposalId":"p"}}),
    ];
    for extra in bad_decisions {
        let mut d = decision("d1");
        d.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        assert!(project(&json!({"decisions":[d]})).is_err(), "{extra}");
    }
    // A listed successor must agree with its own number.
    let mut replaced = decision("d2");
    replaced["replacement"] = json!({"id":"d1","number":5,"at":1});
    assert!(project(&json!({"decisions":[decision("d1"),replaced]})).is_err());
    let bad_proposals = [
        json!({"kind":"withdrawal"}),
        json!({"operationId":7}),
        json!({"operationId":""}),
        json!({"operationId":"x".repeat(129)}),
        json!({"text":"A withdrawal has no text"}),
        json!({"reason":null}),
    ];
    for extra in bad_proposals {
        let mut p = withdraw("p1");
        p.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        assert!(
            project(&json!({"decisionProposals":[p]})).is_err(),
            "{extra}"
        );
    }
}
