use super::*;
use crate::{
    mission_browser_fixture::{self as f, Reply, Server},
    mission_decisions::project,
};
use serde_json::json;
fn source() -> Source {
    Source {
        key: f::key("mission-A"),
        project: "project-A".into(),
    }
}
fn withdraw(id: &str) -> Value {
    json!({"id":id,"decisionId":"d1","kind":"withdraw","status":"pending","reason":"No longer needed 私","operationId":"op-1","authorSessionId":"chat-A","createdAt":1})
}
fn detail() -> Value {
    let mut v = f::detail("mission-A");
    v["decisions"] = json!([{"id":"d1","number":1,"audience":"all","text":"Binding"}]);
    v["decisionProposals"] = json!([withdraw("p1")]);
    v
}
fn proposal(v: &Value, id: &str) -> Proposal {
    project(v)
        .unwrap()
        .proposals
        .rows
        .unwrap()
        .into_iter()
        .find(|p| p.id == id)
        .unwrap()
}
fn ack(choice: Choice) -> Value {
    let mut p = withdraw("p1");
    p["status"] = json!(choice.status());
    p["resolvedAt"] = json!(2);
    p
}
const ACCEPT: &str = "POST /api/missions/mission-A/decision-proposals/p1/accept";
#[test]
fn begin_requires_an_exact_withdrawal_and_never_replays() {
    let s = source();
    let p = proposal(&detail(), "p1");
    let mut a = Attempts::default();
    for kind in ["edit", "remove"] {
        let mut v = detail();
        v["decisionProposals"][0]["kind"] = json!(kind);
        v["decisionProposals"][0]
            .as_object_mut()
            .unwrap()
            .remove("operationId");
        assert!(
            a.begin(&s, &proposal(&v, "p1"), true, Choice::Accept)
                .is_err(),
            "{kind}"
        );
    }
    assert!(
        a.begin(&s, &p, false, Choice::Accept).is_err(),
        "inactive target"
    );
    let send = a.begin(&s, &p, true, Choice::Accept).unwrap();
    assert_eq!(a.sending(), Some(&send));
    assert!(
        a.begin(&s, &p, true, Choice::Reject).is_err(),
        "one send at a time"
    );
    assert!(a.finish(&send, Outcome::NotSent("offline")));
    assert!(!a.finish(&send, Outcome::Ack), "a settled outcome is final");
    // Nothing was sent, so an explicit new response may start.
    let send = a.begin(&s, &p, false, Choice::Reject).unwrap();
    assert!(a.finish(&send, Outcome::Unknown("lost")));
    for choice in [Choice::Accept, Choice::Reject] {
        assert!(
            a.begin(&s, &p, true, choice).is_err(),
            "Unknown never resends"
        );
    }
    assert!(matches!(a.get(&s, "p1"), Some((_, Outcome::Unknown(_)))));
    let mut q = p.clone();
    q.id = "p2".into();
    let send = a.begin(&s, &q, true, Choice::Accept).unwrap();
    assert!(a.finish(&send, Outcome::Ack));
    assert!(
        a.begin(&s, &q, true, Choice::Accept).is_err(),
        "Ack never resends"
    );
    // Bounded: settled rows are evicted, Unknown locks stay.
    for i in 0..40 {
        let mut r = p.clone();
        r.id = format!("bulk-{i}");
        let send = a.begin(&s, &r, true, Choice::Reject).unwrap();
        a.finish(&send, Outcome::Ack);
    }
    assert!(a.rows.len() <= ATTEMPTS);
    assert!(matches!(a.get(&s, "p1"), Some((_, Outcome::Unknown(_)))));
}
#[tokio::test]
async fn requalifies_home_mission_and_exact_proposal_before_one_post() {
    for kind in [
        "accept",
        "reject",
        "offline",
        "foreign-hello",
        "foreign-project",
        "reason",
        "target",
        "resolved",
        "withdrawn",
        "replaced",
        "malformed",
    ] {
        let server = Server::start();
        let mut v = detail();
        let mut choice = Choice::Accept;
        match kind {
            "reject" => choice = Choice::Reject,
            "foreign-hello" => server.reply(
                "/api/hello",
                Reply::json(200, json!({"daemonId":"foreign","lineageId":"test-lineage","minimumClientProtocolVersion":1})),
            ),
            "foreign-project" => v["mission"]["projectId"] = json!("project-B"),
            "reason" => v["decisionProposals"][0]["reason"] = json!("Different reason"),
            "target" => v["decisionProposals"][0]["decisionId"] = json!("d2"),
            "resolved" => v["decisionProposals"][0]["status"] = json!("accepted"),
            "withdrawn" => {
                v["decisions"][0]["withdrawn"] = json!({"at":1,"reason":"x","proposalId":"p0"})
            }
            "replaced" => {
                v["decisions"][0]["replacement"] = json!({"id":"d9","number":9,"at":1})
            }
            "malformed" => v["decisionProposals"][0]["kind"] = json!("withdrawal"),
            _ => {}
        }
        server.reply(
            "/api/missions/mission-A",
            Reply::json(if kind == "offline" { 503 } else { 200 }, v),
        );
        server.reply(ACCEPT, Reply::json(200, ack(Choice::Accept)));
        server.reply(
            "POST /api/missions/mission-A/decision-proposals/p1/reject",
            Reply::json(200, ack(Choice::Reject)),
        );
        let send = Attempts::default()
            .begin(&source(), &proposal(&detail(), "p1"), true, choice)
            .unwrap();
        let outcome = write(&client().unwrap(), &server.options, &send).await;
        let writes = server.writes();
        if matches!(kind, "accept" | "reject") {
            assert_eq!(outcome, Outcome::Ack, "{kind}");
            assert_eq!(writes.len(), 1);
            let (method, path, _, body) = &writes[0];
            assert_eq!(method, "POST");
            assert_eq!(
                path,
                &format!("/api/missions/mission-A/decision-proposals/p1/{kind}")
            );
            assert_eq!(body, &json!({}), "no replacement text or other authority");
        } else {
            assert!(
                matches!(outcome, Outcome::NotSent(_)),
                "{kind}: {outcome:?}"
            );
            assert!(writes.is_empty(), "{kind}");
        }
    }
    // A wrong captured Local home never reaches the daemon.
    let server = Server::start();
    let mut send = Attempts::default()
        .begin(&source(), &proposal(&detail(), "p1"), true, Choice::Reject)
        .unwrap();
    send.source.key.home.daemon = "other-daemon".into();
    assert!(matches!(
        write(&client().unwrap(), &server.options, &send).await,
        Outcome::NotSent(_)
    ));
    assert!(server.state.lock().unwrap().seen.is_empty());
}
#[tokio::test]
async fn lost_error_or_mismatched_ack_stays_unknown_without_replay() {
    let mismatched = |field: &str, value: Value| {
        let mut v = ack(Choice::Accept);
        v[field] = value;
        Reply::json(200, v)
    };
    let replies = [
        Reply::json(0, json!({})),
        Reply::json(400, json!({"error":"Invalid JSON"})),
        Reply::json(
            409,
            json!({"error":"Withdrawal proposal already has a different outcome"}),
        ),
        Reply::json(500, json!({})),
        mismatched("id", json!("p2")),
        mismatched("decisionId", json!("d2")),
        mismatched("kind", json!("remove")),
        mismatched("status", json!("pending")),
        mismatched("status", json!("rejected")),
        Reply {
            status: 200,
            bytes: b"{".to_vec(),
            chunked: false,
            delay_ms: 0,
        },
    ];
    for reply in replies {
        let server = Server::start();
        server.reply("/api/missions/mission-A", Reply::json(200, detail()));
        server.reply(ACCEPT, reply);
        let mut attempts = Attempts::default();
        let p = proposal(&detail(), "p1");
        let send = attempts.begin(&source(), &p, true, Choice::Accept).unwrap();
        let outcome = write(&client().unwrap(), &server.options, &send).await;
        assert!(matches!(outcome, Outcome::Unknown(_)), "{outcome:?}");
        assert!(attempts.finish(&send, outcome));
        // No later GET settles this or permits a resend.
        assert!(attempts.begin(&source(), &p, true, Choice::Accept).is_err());
        assert!(attempts.begin(&source(), &p, true, Choice::Reject).is_err());
        assert!(matches!(
            attempts.get(&source(), "p1"),
            Some((_, Outcome::Unknown(_)))
        ));
        assert_eq!(server.writes().len(), 1, "exactly one POST");
    }
}
