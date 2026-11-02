//! Explicit database-access decisions on the production FIFO writer, real
//! private bytes and held faux HTTP. No real daemon, database or grant.
use super::model_waits::{close, posts, reached, seed, start};
use super::recovery_waits::edit_while_held;
use super::send_waits::{disconnected, disk};
use super::*;
use crate::database_access::{NOT_PENDING, Outcome, UNKNOWN, tests::decision};
use crate::model_wait_fixture::{Behavior as ModelBehavior, Server};

const ROUTE: &str = "/api/sessions/a/database-access";
fn settled(state: &WriteState, request: u64) -> bool {
    state
        .access
        .as_ref()
        .is_some_and(|r| r.request == request && r.outcome != Outcome::Pending)
}

#[tokio::test]
async fn access_decision_autosaves_while_held_posts_once_and_never_resends() {
    for (behavior, allow) in [
        (ModelBehavior::Accept, true),
        (ModelBehavior::Accept, false),
        (ModelBehavior::Lost, true),
        (ModelBehavior::Reject, false),
        (ModelBehavior::Malformed, true),
    ] {
        let server = Server::start(false, behavior, ROUTE);
        let temp = Temp::new();
        let captured = seed(&server, &temp);
        let (client, updates) = start(&server, &temp).await;
        assert!(client.command(WriteCommand::DatabaseAccess {
            decision: decision(allow),
            request: 17,
        }));
        reached(&server).await;
        edit_while_held(&client, &updates, &temp, &captured, false).await;
        assert!(client.command(WriteCommand::Checkpoint(28)));
        assert_eq!(client.commands.len(), 1, "commands stay FIFO behind HTTP");
        server.release.send(()).await.unwrap();
        // The single-slot update channel may coalesce settlement and checkpoint.
        let done = until(&updates, |s| s.checkpoint == Some(28)).await;
        assert!(settled(&done, 17));
        let reply = done.access.unwrap();
        assert_eq!(reply.decision, decision(allow));
        assert_eq!(
            reply.outcome,
            match behavior {
                ModelBehavior::Accept => Outcome::Accepted,
                ModelBehavior::Reject => Outcome::Refused(NOT_PENDING),
                _ => Outcome::Unknown(UNKNOWN),
            }
        );
        assert_eq!(
            posts(&server),
            1,
            "a lost or refused decision is never resent"
        );
        let posted = server
            .seen
            .lock()
            .unwrap()
            .iter()
            .find(|(m, _, _)| m == "POST")
            .cloned()
            .unwrap();
        assert_eq!(posted.1, ROUTE);
        assert_eq!(posted.2, json!({"id":"request-1","allow":allow}));
        // The private Book has no database-access intent to replay.
        let book = disk(&temp);
        assert!(book.pending.is_empty());
        assert_eq!(book.drafts["chat:a"].revision, 9);
        close(client, updates, &server, &temp).await;
    }
}

#[tokio::test]
async fn close_during_held_decision_is_unknown_and_releases_store() {
    let server = Server::start(false, ModelBehavior::Accept, ROUTE);
    let temp = Temp::new();
    seed(&server, &temp);
    let (client, updates) = start(&server, &temp).await;
    assert!(client.command(WriteCommand::DatabaseAccess {
        decision: decision(true),
        request: 5,
    }));
    reached(&server).await;
    assert!(client.command(WriteCommand::Close));
    let closed = until(&updates, |s| s.flushed).await;
    assert_eq!(closed.access.unwrap().outcome, Outcome::Unknown(UNKNOWN));
    disconnected(client, updates).await;
    Store::open(temp.0.clone(), server.options.host()).unwrap();
    server.release.send(()).await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), server.completed.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(posts(&server), 1);
}
