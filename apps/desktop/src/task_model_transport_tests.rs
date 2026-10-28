use super::*;
use crate::{
    mission_browser_fixture as f,
    task_model::{Preference, State},
    task_model_fixture::{Reply, Server},
};
fn target() -> Target {
    Target {
        key: f::key("mission-A"),
        task: "task-A".into(),
        number: 1,
    }
}
fn save() -> Save {
    let source = Source {
        target: target(),
        project: "project-A".into(),
    };
    let c = serde_json::from_value(crate::task_model_fixture::models()).unwrap();
    State::default()
        .begin(
            &source,
            &Preference {
                model: Some("p/a".into()),
                thinking: Some("high".into()),
            },
            &c,
        )
        .unwrap()
}
fn writes(s: &Server) -> usize {
    s.state
        .lock()
        .unwrap()
        .seen
        .iter()
        .filter(|(m, _, _)| m != "GET")
        .count()
}
#[tokio::test]
async fn exact_project_capped_catalog_and_one_passive_payload() {
    let s = Server::start();
    let a = save();
    assert_eq!(
        write(&client().unwrap(), &s.options, &a).await,
        Outcome::Saved
    );
    let state = s.state.lock().unwrap();
    let ops: Vec<_> = state.seen.iter().filter(|(m, _, _)| m != "GET").collect();
    assert_eq!(ops.len(), 1);
    assert_eq!(ops[0].0, "POST");
    assert_eq!(ops[0].1, "/api/missions/mission-A/tasks/task-A/model");
    assert_eq!(
        ops[0].2,
        json!({"operationId":a.id,"home":{"daemonId":"test-daemon","lineageId":"test-lineage"},"projectId":"project-A","preferredModel":"p/a","preferredThinking":"high"})
    );
    assert!(
        state
            .seen
            .iter()
            .any(|(_, p, _)| p == "/api/models?projectId=project-A&purpose=task-start")
    );
}
#[tokio::test]
async fn task_beyond_256_rows_and_2_mib_detail_is_still_admitted() {
    let s = Server::start();
    s.reply(
        "GET",
        "/api/missions/mission-A",
        Reply::json(200, f::many("mission-A", 300)),
    );
    assert_eq!(
        write(&client().unwrap(), &s.options, &save()).await,
        Outcome::Saved
    );
    assert_eq!(writes(&s), 1);
}
#[tokio::test]
async fn missing_capability_foreign_project_home_task_and_scope_never_send() {
    for case in 0..6 {
        let s = Server::start();
        let mut a = save();
        match case {
        0=>s.reply("GET","/api/hello",Reply::json(200,json!({"daemonId":"test-daemon","lineageId":"test-lineage","protocolVersion":1,"minimumClientProtocolVersion":1,"capabilities":{"independentExecution":true}}))),
        1=>a.source.project="other".into(),2=>a.source.target.key.home.daemon="foreign".into(),3=>a.source.target.task="1".into(),
        4=>{let mut d=f::detail("mission-A");d["tasks"]=json!([]);s.reply("GET","/api/missions/mission-A",Reply::json(200,d));},
        _=>a.value.thinking=Some("unsupported".into()),
    }
        assert!(
            matches!(
                write(&client().unwrap(), &s.options, &a).await,
                Outcome::NotSent(_)
            ),
            "{case}"
        );
        assert_eq!(writes(&s), 0);
    }
}
#[tokio::test]
async fn bad_or_lost_ack_stays_unknown_even_with_matching_get_no_fallback_or_retry() {
    for status in [Some(400), Some(409), Some(500), Some(302), None, Some(200)] {
        let s = Server::start();
        let mut r = Reply::json(status.unwrap_or(200), json!({"wrong":"ack"}));
        r.status = status;
        s.reply("POST", "/api/missions/mission-A/tasks/task-A/model", r);
        let a = save();
        let o = write(&client().unwrap(), &s.options, &a).await;
        assert!(matches!(o, Outcome::Unknown(_)));
        assert_eq!(writes(&s), 1);
        let mut state = State {
            attempt: Some((a.clone(), Outcome::Pending)),
        };
        state.finish(&a, o);
        let mut d = f::detail("mission-A");
        d["tasks"][1]["preferredModel"] = json!("p/a");
        d["tasks"][1]["preferredThinking"] = json!("high");
        s.reply("GET", "/api/missions/mission-A", Reply::json(200, d));
        assert_eq!(
            load(&client().unwrap(), &s.options, &target(), None)
                .await
                .unwrap()
                .value,
            a.value
        );
        assert!(state.blocked());
        assert_eq!(writes(&s), 1);
    }
}
#[tokio::test]
async fn default_and_clear_are_null_not_off_or_empty() {
    let s = Server::start();
    let mut a = save();
    a.value.thinking = None;
    assert_eq!(
        write(&client().unwrap(), &s.options, &a).await,
        Outcome::Saved
    );
    a.id = uuid::Uuid::new_v4().to_string();
    a.value = Preference::default();
    assert_eq!(
        write(&client().unwrap(), &s.options, &a).await,
        Outcome::Saved
    );
    let state = s.state.lock().unwrap();
    let ops: Vec<_> = state.seen.iter().filter(|(m, _, _)| m == "POST").collect();
    assert!(ops[0].2["preferredThinking"].is_null());
    assert!(ops[1].2["preferredModel"].is_null());
    assert!(ops[1].2["preferredThinking"].is_null());
}

#[tokio::test]
async fn malformed_oversized_and_wrong_source_ack_cannot_confirm() {
    for bytes in [b"{".to_vec(),vec![b' ';model::WIRE_BYTES+1],serde_json::to_vec(&json!({"operationId":"foreign","task":{"id":"task-A","number":1,"preferredModel":"p/a","preferredThinking":"high"}})).unwrap()] {
        let s=Server::start();s.reply("POST","/api/missions/mission-A/tasks/task-A/model",Reply{status:Some(200),bytes,delay:0});
        assert!(matches!(write(&client().unwrap(),&s.options,&save()).await,Outcome::Unknown(_)));assert_eq!(writes(&s),1);
    }
}
