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
