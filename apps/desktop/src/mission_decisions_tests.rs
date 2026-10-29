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
    assert_eq!(p.kind, "Remove");
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
            "/api/sessions?archived=all&missionId=mission-A"
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
