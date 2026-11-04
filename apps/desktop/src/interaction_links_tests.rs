//! The courier's link of a chat created from a Slack message, against an isolated faux pilotd.
use super::*;
use crate::slack_triage_fixture::{Reply, Server, item, project, source};
use serde_json::json;

struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!("desktop-link-test-{}", uuid::Uuid::new_v4())))
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn server() -> Server {
    Server::start(
        vec![project("p1", "Atlas", &["C1"])],
        vec![source("p1", "ok")],
        vec![item("m1", "p1", "Checkout fails", "open", "high", 1_000)],
    )
}
fn tracked() -> Tracked {
    Tracked {
        item_id: "m1".into(),
        project_id: "p1".into(),
        label: "#support".into(),
    }
}
fn draft(tracked: Option<Tracked>) -> Draft {
    Draft {
        revision: 1,
        text: "Please look into this Slack message.".into(),
        cwd: "/synthetic/p1".into(),
        project_id: Some("p1".into()),
        tracked,
        ..Default::default()
    }
}
async fn until(
    rx: &async_channel::Receiver<WriteState>,
    what: &str,
    predicate: impl Fn(&WriteState) -> bool,
) -> WriteState {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let value = rx.recv().await.unwrap();
            if predicate(&value) {
                return value;
            }
        }
    })
    .await
    .unwrap_or_else(|_| panic!("bounded courier update: {what}"))
}
async fn start(s: &Server, temp: &Temp) -> (Interaction, async_channel::Receiver<WriteState>) {
    let (client, updates) = Interaction::start(s.options.clone(), Ok(temp.0.clone()));
    until(&updates, "ready", |s| s.book.is_some()).await;
    (client, updates)
}
fn create(client: &Interaction, draft: Draft) {
    assert!(client.edit("new:slot".into(), draft.clone()));
    assert!(client.command(WriteCommand::Submit {
        key: "new:slot".into(),
        draft: Box::new(draft),
        follow_up: false,
        stop: false,
        request: 1,
    }));
}
fn patches(s: &Server) -> Vec<(String, Value)> {
    s.state
        .lock()
        .unwrap()
        .writes()
        .into_iter()
        .filter(|(m, _, _)| m == "PATCH")
        .map(|(_, p, b)| (p, b))
        .collect()
}
async fn close(client: Interaction, updates: async_channel::Receiver<WriteState>) {
    assert!(client.command(WriteCommand::Close));
    until(&updates, "flushed", |s| s.flushed).await;
}

#[tokio::test]
async fn a_created_chat_is_linked_to_its_message_once_and_never_before_creation() {
    let s = server();
    let temp = Temp::new();
    let (client, updates) = start(&s, &temp).await;
    // An edit alone sends nothing.
    assert!(client.edit("new:slot".into(), draft(Some(tracked()))));
    assert!(client.command(WriteCommand::Checkpoint(1)));
    until(&updates, "edit saved", |s| s.checkpoint == Some(1)).await;
    assert!(s.state.lock().unwrap().writes().is_empty());
    create(&client, draft(Some(tracked())));
    let state = until(&updates, "linked", |s| s.linked.contains_key("m1")).await;
    let book = state.book.as_ref().unwrap();
    let chat = book.drafts["new:slot"].created.clone().unwrap();
    assert!(book.links.is_empty());
    assert_eq!(state.linked["m1"], chat);
    let writes: Vec<_> = s
        .state
        .lock()
        .unwrap()
        .writes()
        .into_iter()
        .filter(|(_, p, _)| p != "/api/operations/receipt")
        .collect();
    assert_eq!(writes.len(), 2, "one creation, one link: {writes:?}");
    assert_eq!(writes[0].1, "/api/operations");
    assert_eq!(
        writes[1].1, "/api/tracked-items/m1",
        "linked after creation"
    );
    let payload: Value = serde_json::from_str(writes[0].2["payload"].as_str().unwrap()).unwrap();
    assert_eq!(
        payload,
        json!({"message":"Please look into this Slack message.","projectId":"p1","mode":"build"}),
        "the creation request never carries the message identity"
    );
    assert_eq!(
        patches(&s),
        [(
            "/api/tracked-items/m1".to_owned(),
            json!({"sessionId":chat,"start":true})
        )]
    );
    let item = s.state.lock().unwrap().items[0].clone();
    assert_eq!(item["sessionIds"], json!([chat]));
    assert_eq!(item["slack"]["status"], "in_progress");
    close(client, updates).await;
}

#[tokio::test]
async fn an_ordinary_chat_has_no_link() {
    let s = server();
    let temp = Temp::new();
    let (client, updates) = start(&s, &temp).await;
    create(&client, draft(None));
    let state = until(&updates, "created", |s| {
        s.book
            .as_ref()
            .is_some_and(|b| b.drafts["new:slot"].created.is_some())
    })
    .await;
    assert!(state.book.as_ref().unwrap().links.is_empty());
    assert!(patches(&s).is_empty());
    close(client, updates).await;
}

#[tokio::test]
async fn a_lost_link_reply_is_kept_and_resent_after_restart_only_to_the_same_daemon() {
    let s = server();
    s.reply(
        "PATCH",
        "/api/tracked-items/m1",
        Reply::status(None, Value::Null),
    );
    let temp = Temp::new();
    let (client, updates) = start(&s, &temp).await;
    create(&client, draft(Some(tracked())));
    let state = until(&updates, "created", |s| {
        s.book
            .as_ref()
            .is_some_and(|b| b.drafts["new:slot"].created.is_some())
    })
    .await;
    let chat = state.book.as_ref().unwrap().drafts["new:slot"]
        .created
        .clone()
        .unwrap();
    wait(|| patches(&s).len() == 1).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(patches(&s).len(), 1, "a pass sends each link once");
    close(client, updates).await;
    let kept = crate::delivery_store::Store::open(temp.0.clone(), s.options.host()).unwrap();
    assert_eq!(
        kept.book.links.get(&chat),
        Some(&tracked()),
        "kept with the chat"
    );
    drop(kept);

    // Another daemon answers after the restart: the link is not sent and waits.
    s.clear("PATCH", "/api/tracked-items/m1");
    s.state.lock().unwrap().daemon = "other".into();
    let hellos = || {
        s.state
            .lock()
            .unwrap()
            .seen
            .iter()
            .filter(|(_, p, _)| p == "/api/hello")
            .count()
    };
    let before = hellos();
    let (client, updates) = start(&s, &temp).await;
    wait(|| hellos() > before).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(patches(&s).len(), 1, "never sent to another daemon");
    close(client, updates).await;

    // The same daemon again: sent once more, which pilotd treats as the same link.
    s.state.lock().unwrap().daemon = "test-daemon".into();
    let (client, updates) = start(&s, &temp).await;
    let state = until(&updates, "linked", |s| s.linked.contains_key("m1")).await;
    assert!(state.book.as_ref().unwrap().links.is_empty());
    let sent = patches(&s);
    assert_eq!(sent.len(), 2);
    assert_eq!(sent[0], sent[1], "the same link, never another");
    assert_eq!(
        s.state.lock().unwrap().items[0]["sessionIds"],
        json!([chat])
    );
    close(client, updates).await;
}
async fn wait(done: impl Fn() -> bool) {
    tokio::time::timeout(Duration::from_secs(10), async {
        while !done() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("bounded faux pilotd wait");
}

#[tokio::test]
async fn a_gone_message_is_forgotten_and_not_retried() {
    let s = server();
    s.state.lock().unwrap().items.clear();
    let temp = Temp::new();
    let (client, updates) = start(&s, &temp).await;
    create(&client, draft(Some(tracked())));
    until(&updates, "dropped", |s| {
        s.book
            .as_ref()
            .is_some_and(|b| b.drafts["new:slot"].created.is_some() && b.links.is_empty())
    })
    .await;
    assert_eq!(patches(&s).len(), 1);
    close(client, updates).await;
}

#[tokio::test]
async fn close_is_not_held_by_a_slow_link() {
    let s = server();
    let mut slow = Reply::status(Some(200), json!({"id":"m1","sessionIds":[]}));
    slow.delay_ms = 4_000;
    s.reply("PATCH", "/api/tracked-items/m1", slow);
    let temp = Temp::new();
    let (client, updates) = start(&s, &temp).await;
    create(&client, draft(Some(tracked())));
    wait(|| patches(&s).len() == 1).await;
    let started = std::time::Instant::now();
    close(client, updates).await;
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "Close waited for the link"
    );
    let kept = crate::delivery_store::Store::open(temp.0.clone(), s.options.host()).unwrap();
    assert_eq!(kept.book.links.len(), 1, "an unconfirmed link is kept");
}

#[tokio::test]
async fn link_reply_is_confirmed_only_by_the_linked_item() {
    let s = server();
    let link = tracked();
    let client = reqwest::Client::new();
    s.reply(
        "PATCH",
        "/api/tracked-items/m1",
        Reply::status(Some(200), json!({"id":"m1","sessionIds":["other"]})),
    );
    assert_eq!(link_once(&client, &s, &link).await, Linked::Later);
    s.reply(
        "PATCH",
        "/api/tracked-items/m1",
        Reply::status(Some(503), json!({"error":"busy"})),
    );
    assert_eq!(link_once(&client, &s, &link).await, Linked::Later);
    s.reply(
        "PATCH",
        "/api/tracked-items/m1",
        Reply::status(Some(400), json!({"error":"Invalid"})),
    );
    assert_eq!(link_once(&client, &s, &link).await, Linked::Gone);
    s.clear("PATCH", "/api/tracked-items/m1");
    assert_eq!(link_once(&client, &s, &link).await, Linked::Done);
}
async fn link_once(client: &reqwest::Client, s: &Server, tracked: &Tracked) -> Linked {
    link(client, &s.options, "chat-1", tracked).await
}
