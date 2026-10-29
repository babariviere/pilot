use super::*;
use serde_json::json;

#[tokio::test]
async fn subagent_send_journals_exact_target_and_never_replays_a_lost_ack() {
    let server = crate::session_subagents_fixture::Server::start();
    let client = reqwest::Client::builder()
        .no_proxy()
        .retry(reqwest::retry::never())
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    let root = std::env::temp_dir().join(format!("subagent-send-{}", uuid::Uuid::new_v4()));
    let host = server.options.host();
    let mut store = Store::open(root.clone(), host.clone()).unwrap();
    let target = crate::session_subagents::Target {
        parent: "Parent-A".into(),
        name: "Review/日本 %?#".into(),
        created_at: 1f64.to_bits(),
    };
    let key = target.key();
    let draft = Draft {
        revision: 1,
        text: "User child message 私".into(),
        ..Default::default()
    };
    let mut report = None;
    submit(
        &client,
        &server.options,
        &mut store,
        Submission {
            key: &key,
            draft: &draft,
            follow_up: true,
            stop: false,
        },
        &mut report,
        |s| {
            let intent = s.book.pending.values().next().unwrap();
            assert_eq!(intent.target, "Parent-A");
            assert_eq!(intent.operation.as_ref().unwrap().kind, "subagent-send");
            assert!(root.join("state-v1.json").exists());
        },
    )
    .await
    .unwrap();
    assert_eq!(server.messages.lock().unwrap().len(), 1);
    let sent = server.messages.lock().unwrap()[0].clone();
    assert_eq!(sent["message"], draft.text);
    assert_eq!(sent["mode"], "followUp");
    assert!(sent["requestId"].as_str().is_some());
    assert_eq!(
        sent["requestId"],
        store.book.drafts[&key].last.as_ref().unwrap().id
    );
    assert!(store.book.pending.is_empty());
    assert!(store.book.drafts[&key].text.is_empty());
    assert_eq!(
        store.book.drafts[&key].last.as_ref().unwrap().state,
        "accepted"
    );
    server.summary.lock().unwrap()["subagents"][0]["retired"] = json!(true);
    let refused = Draft {
        revision: 2,
        text: "Never send to retired child".into(),
        ..Default::default()
    };
    assert!(
        submit(
            &client,
            &server.options,
            &mut store,
            Submission {
                key: &key,
                draft: &refused,
                follow_up: false,
                stop: false
            },
            &mut report,
            |_| panic!("refuse before journaling")
        )
        .await
        .is_err()
    );
    assert_eq!(server.messages.lock().unwrap().len(), 1);
    assert!(store.book.pending.is_empty());
    server.summary.lock().unwrap()["subagents"][0]["retired"] = json!(false);
    let next = Draft {
        revision: 2,
        text: "Second child message".into(),
        ..Default::default()
    };
    server
        .drop_ack
        .store(true, std::sync::atomic::Ordering::Relaxed);
    assert!(
        submit(
            &client,
            &server.options,
            &mut store,
            Submission {
                key: &key,
                draft: &next,
                follow_up: false,
                stop: false
            },
            &mut report,
            |_| {}
        )
        .await
        .is_err()
    );
    assert_eq!(server.messages.lock().unwrap().len(), 2);
    let intent = store.book.pending.values().next().unwrap().clone();
    assert_eq!(intent.state, "unknown");
    drop(store);
    let mut reopened = Store::open(root.clone(), host).unwrap();
    assert!(reopened.book.pending[&intent.id].operation == intent.operation);
    let requests = server.requests.lock().unwrap().len();
    reconcile(
        &client,
        &server.options,
        &mut reopened,
        &intent.id,
        true,
        None,
        &mut None,
    )
    .await
    .unwrap();
    assert_eq!(
        server.requests.lock().unwrap().len(),
        requests,
        "no receipt lookup or retry API invented"
    );
    assert_eq!(server.messages.lock().unwrap().len(), 2);
    assert_eq!(reopened.book.drafts[&key].text, next.text);
    assert!(
        reopened.prepare(&key, &next, false, true).is_err(),
        "child target never maps to parent Stop"
    );
    drop(reopened);
    std::fs::remove_dir_all(root).unwrap();
}
