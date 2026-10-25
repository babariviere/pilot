use super::*;
use crate::project_registration_fixture::{Behavior, Server};
use std::time::Duration;
struct Temp(std::path::PathBuf);
impl Temp {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!("add-project-{}", uuid::Uuid::new_v4())))
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .retry(reqwest::retry::never())
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(2))
        .build()
        .unwrap()
}

// Legal recovery data leaves room for the pre-POST Unknown, but not its UUID receipt.
fn fill_near_project_receipt_capacity(store: &mut Store) {
    use crate::delivery_store::{Draft, RECOVER_CAP, STATE_CAP};
    use std::{collections::BTreeMap, sync::Arc};
    let original = Draft {
        revision: 1,
        text: "Original pending request must not change".into(),
        cwd: "/synthetic/original".into(),
        project_id: Some("original-project".into()),
        ..Default::default()
    };
    store
        .prepare("new:original", &original, false, false)
        .unwrap();
    let mut filler = Draft {
        revision: 1,
        recovered: Arc::new(vec![
            "x".repeat(RECOVER_CAP),
            "x".repeat(RECOVER_CAP),
            "x".repeat(RECOVER_CAP),
            String::new(),
        ]),
        ..Default::default()
    };
    let mut budget = store.book.clone();
    budget.drafts.insert("chat:recovery".into(), filler.clone());
    budget.project_registrations.insert(
        "one".into(),
        Attempt {
            id: "one".into(),
            path: "/synthetic/folder".into(),
            created: None,
        },
    );
    let room = STATE_CAP - serde_json::to_vec(&budget).unwrap().len() - 8;
    assert!(room <= RECOVER_CAP);
    *Arc::make_mut(&mut filler.recovered).last_mut().unwrap() = "x".repeat(room);
    store
        .save_edits(BTreeMap::from([("chat:recovery".into(), filler)]))
        .unwrap();
}
async fn project_update(
    updates: &async_channel::Receiver<crate::interaction::WriteState>,
) -> crate::interaction::WriteState {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let s = updates.recv().await.unwrap();
            if s.project
                .as_ref()
                .is_some_and(|r| !matches!(r.result, Ok(Outcome::Pending)))
            {
                return s;
            }
        }
    })
    .await
    .unwrap()
}
#[tokio::test]
async fn acknowledged_near_capacity_retains_worker_id_unknown_and_original_envelope_without_replay()
{
    use crate::{
        delivery_store::STATE_CAP,
        interaction::{Interaction, WriteCommand},
    };
    let s = Server::start(Behavior::Accept);
    let created = "12345678-1234-4234-8234-123456789abc";
    s.seen.lock().unwrap().created_id = created.into();
    let t = Temp::new();
    let mut store = Store::open(t.0.clone(), s.options.host()).unwrap();
    fill_near_project_receipt_capacity(&mut store);
    let original = serde_json::to_vec(&store.book.pending).unwrap();
    drop(store);
    let (writer, updates) = Interaction::start(s.options.clone(), Ok(t.0.clone()));
    assert!(writer.command(WriteCommand::Project {
        id: "one".into(),
        path: Some("/synthetic/folder".into())
    }));
    let acknowledged = project_update(&updates).await;
    let bytes = std::fs::read(t.0.join("state-v1.json")).unwrap();
    assert_eq!(bytes.len(), STATE_CAP - 8);
    assert!(writer.command(WriteCommand::Project {
        id: "inspect".into(),
        path: None
    }));
    let inspected = project_update(&updates).await;
    assert!(writer.command(WriteCommand::Close));
    tokio::time::timeout(Duration::from_secs(10), async {
        let mut flushed = false;
        while let Ok(state) = updates.recv().await {
            flushed |= state.flushed;
        }
        assert!(flushed);
    })
    .await
    .unwrap();
    drop(writer);
    let mut reopened = Store::open(t.0.clone(), s.options.host()).unwrap();
    assert!(
        !reopened.is_faulted(),
        "STATE_CAP refusal is not an I/O failure"
    );
    assert!(reopened.book.project_registrations["one"].created.is_none());
    assert_eq!(
        serde_json::to_vec(&reopened.book.pending).unwrap(),
        original
    );
    assert_eq!(std::fs::read(t.0.join("state-v1.json")).unwrap(), bytes);
    s.seen.lock().unwrap().projects.clear();
    assert!(
        register(
            &client(),
            &s.options,
            &mut reopened,
            "new-attempt",
            "/synthetic/folder",
            |_| panic!("durable Unknown must fence a restarted resend")
        )
        .await
        .is_err()
    );
    assert_eq!(s.posts(), 1);
    assert_eq!(
        acknowledged.project.as_ref().unwrap().result,
        Ok(Outcome::Created(created.into()))
    );
    assert_eq!(
        acknowledged.project_receipt,
        Some(("one".into(), created.into()))
    );
    assert_eq!(
        inspected.project_receipt, acknowledged.project_receipt,
        "read-only refresh must not erase the in-process acknowledgment"
    );
    assert!(
        acknowledged.error.is_none(),
        "capacity does not falsely claim an I/O fault"
    );
}
#[tokio::test]
async fn exact_post_receipt_catalog_and_restart_never_replay() {
    let s = Server::start(Behavior::Accept);
    let t = Temp::new();
    let mut store = Store::open(t.0.clone(), s.options.host()).unwrap();
    assert_eq!(
        register(
            &client(),
            &s.options,
            &mut store,
            "one",
            "/synthetic/日本語",
            |store| assert!(store.book.project_registrations["one"].created.is_none())
        )
        .await
        .unwrap(),
        Outcome::Created("registered-project".into())
    );
    assert_eq!(
        catalog(&client(), &s.options).await.unwrap()[0].path,
        "/synthetic/日本語"
    );
    assert_eq!(s.posts(), 1);
    drop(store);
    let mut store = Store::open(t.0.clone(), s.options.host()).unwrap();
    assert_eq!(
        store.book.project_registrations["one"].created.as_deref(),
        Some("registered-project")
    );
    assert!(
        register(
            &client(),
            &s.options,
            &mut store,
            "two",
            "/synthetic/日本語",
            |_| panic!()
        )
        .await
        .is_err()
    );
    assert_eq!(s.posts(), 1);
    assert!(store.book.pending.is_empty() && store.book.drafts.is_empty());
}
#[tokio::test]
async fn lost_malformed_oversized_chunked_and_non2xx_preserve_unknown_after_observed_catalog() {
    for b in [
        Behavior::Lost,
        Behavior::Malformed,
        Behavior::InvalidReceipt,
        Behavior::Oversized,
        Behavior::Chunked,
        Behavior::Status(400),
        Behavior::Status(403),
        Behavior::Status(404),
        Behavior::Status(409),
        Behavior::Status(503),
    ] {
        let s = Server::start(b);
        let t = Temp::new();
        let mut store = Store::open(t.0.clone(), s.options.host()).unwrap();
        assert!(matches!(
            register(
                &client(),
                &s.options,
                &mut store,
                "one",
                "/synthetic/folder",
                |_| {}
            )
            .await
            .unwrap(),
            Outcome::Unknown(_)
        ));
        assert_eq!(s.posts(), 1);
        assert!(store.book.project_registrations["one"].created.is_none());
        assert_eq!(catalog(&client(), &s.options).await.unwrap().len(), 1);
        drop(store);
        let mut store = Store::open(t.0.clone(), s.options.host()).unwrap();
        // Even after source availability disappears, the exact attempt fences resend.
        s.seen.lock().unwrap().projects.clear();
        assert!(
            register(
                &client(),
                &s.options,
                &mut store,
                "new-id",
                "/synthetic/folder",
                |_| panic!()
            )
            .await
            .is_err()
        );
        assert_eq!(s.posts(), 1);
        assert!(store.book.project_registrations["one"].created.is_none());
    }
}
#[tokio::test]
async fn validation_foreign_identity_bad_catalog_and_private_admission_fault_send_zero() {
    let s = Server::start(Behavior::Accept);
    let t = Temp::new();
    let mut store = Store::open(t.0.clone(), s.options.host()).unwrap();
    store.book.host.daemon_id = "wrong-private-host".into();
    assert!(
        register(
            &client(),
            &s.options,
            &mut store,
            "one",
            "/synthetic/folder",
            |_| panic!()
        )
        .await
        .is_err()
    );
    assert!(s.seen.lock().unwrap().requests.is_empty());
    store.book.host = s.options.host();
    for path in [
        "relative".into(),
        "/nul\0".into(),
        format!("/{}", "a".repeat(4096)),
    ] {
        assert!(
            register(
                &client(),
                &s.options,
                &mut store,
                "one",
                &path,
                |_| panic!()
            )
            .await
            .is_err()
        );
    }
    s.seen.lock().unwrap().hello["daemonId"] = serde_json::json!("foreign");
    assert!(
        register(
            &client(),
            &s.options,
            &mut store,
            "one",
            "/synthetic/folder",
            |_| panic!()
        )
        .await
        .is_err()
    );
    s.seen.lock().unwrap().hello["daemonId"] = serde_json::json!("test-daemon");
    s.seen.lock().unwrap().projects = vec![serde_json::json!({"id":"bad/identity"})];
    assert!(
        register(
            &client(),
            &s.options,
            &mut store,
            "one",
            "/synthetic/folder",
            |_| panic!()
        )
        .await
        .is_err()
    );
    s.seen.lock().unwrap().projects.clear();
    store.fail_write = true;
    assert!(
        register(
            &client(),
            &s.options,
            &mut store,
            "one",
            "/synthetic/folder",
            |_| panic!()
        )
        .await
        .is_err()
    );
    assert_eq!(s.posts(), 0);
    assert!(store.book.project_registrations.is_empty());
}
#[tokio::test]
async fn acknowledged_receipt_survives_private_finish_fault_in_memory_not_false_rollback() {
    let s = Server::start(Behavior::Accept);
    let t = Temp::new();
    let mut store = Store::open(t.0.clone(), s.options.host()).unwrap();
    let state = t.0.join("state-v1.json");
    let result = register(
        &client(),
        &s.options,
        &mut store,
        "one",
        "/synthetic/folder",
        |_| {
            std::fs::remove_file(&state).unwrap();
            std::fs::create_dir(&state).unwrap();
        },
    )
    .await
    .unwrap();
    assert_eq!(result, Outcome::Created("registered-project".into()));
    assert!(store.is_faulted());
    assert_eq!(s.posts(), 1);
}
#[test]
fn bounded_unknown_never_evicted_and_old_books_still_load() {
    let t = Temp::new();
    let host = LocalOptions::synthetic(1).host();
    let mut store = Store::open(t.0.clone(), host.clone()).unwrap();
    drop(store);
    let file = t.0.join("state-v1.json");
    let mut legacy: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    legacy
        .as_object_mut()
        .unwrap()
        .remove("project_registrations");
    std::fs::write(&file, serde_json::to_vec(&legacy).unwrap()).unwrap();
    store = Store::open(t.0.clone(), host.clone()).unwrap();
    assert!(store.book.project_registrations.is_empty());
    for i in 0..32 {
        store
            .prepare_project(&format!("id{i}"), &format!("/synthetic/{i}"))
            .unwrap();
    }
    assert!(
        store
            .prepare_project("overflow", "/synthetic/overflow")
            .is_err()
    );
    assert_eq!(store.book.project_registrations.len(), 32);
    drop(store);
    let store = Store::open(t.0.clone(), host).unwrap();
    assert_eq!(store.book.project_registrations.len(), 32);
}
