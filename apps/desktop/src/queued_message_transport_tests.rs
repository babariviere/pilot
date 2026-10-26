use super::*;
use crate::{
    queued_message::{Snapshot, Source, State},
    queued_message_fixture::Server,
};
use std::sync::atomic::Ordering;
fn op(server: &Server, remove: bool) -> Operation {
    let row = Snapshot::read(
        &json!([{"id":42,"mode":"followUp","content":"Original","guardToken":"a".repeat(64)}]),
    )
    .rows
    .remove(0);
    State::default()
        .begin(
            &Source {
                home: server.options().host(),
                chat: "source".into(),
            },
            &row,
            if remove {
                Change::Remove
            } else {
                Change::Edit {
                    text: "Exact edit 🦀".into(),
                    mode: None,
                }
            },
        )
        .unwrap()
}
#[tokio::test]
async fn exact_hello_guard_and_ack_and_no_delivery_mode_override() {
    let s = Server::new();
    let edit = op(&s, false);
    assert_eq!(write(&s.options(), &edit).await, Outcome::Acknowledged);
    let remove = op(&s, true);
    assert_eq!(write(&s.options(), &remove).await, Outcome::Acknowledged);
    let writes = s.writes.lock().unwrap();
    assert_eq!(writes.len(), 2);
    assert_eq!(writes[0].0, "PATCH");
    assert!(writes[0].1.get("mode").is_none());
    assert_eq!(writes[0].1["message"], "Exact edit 🦀");
    assert_eq!(writes[1].0, "DELETE");
    assert!(writes[1].1.get("message").is_none());
}
#[tokio::test]
async fn mismatched_ack_is_unknown_and_missing_capability_sends_nothing() {
    let s = Server::new();
    s.capable.store(false, Ordering::SeqCst);
    assert!(matches!(
        write(&s.options(), &op(&s, false)).await,
        Outcome::NotSent(_)
    ));
    assert!(s.writes.lock().unwrap().is_empty());
    s.capable.store(true, Ordering::SeqCst);
    s.mismatch.store(true, Ordering::SeqCst);
    assert!(matches!(
        write(&s.options(), &op(&s, false)).await,
        Outcome::Unknown(_)
    ));
    assert_eq!(s.writes.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn fragmented_fixture_writes_do_not_depend_on_accept_timing() {
    for _ in 0..16 {
        let server = Server::new();
        let mut operation = op(&server, false);
        operation.change = Change::Edit {
            text: "🦀".repeat(12_000),
            mode: Some("steer".into()),
        };
        assert_eq!(
            write(&server.options(), &operation).await,
            Outcome::Acknowledged
        );
        assert_eq!(server.writes.lock().unwrap().len(), 1);
    }
}
