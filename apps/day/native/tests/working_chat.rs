//! Real native JSON bridge and authenticated project catalog. No worker starts.
include!("support/intake_fixture.rs");

#[test]
fn opening_foreign_project_chat_rechecks_access_and_clears_old_history_on_loss() {
    let mut f = Fixture::new();
    let b = f.bridge();
    let read = f.call(
        &b,
        "day.chat.read",
        json!({"sessionId":"working-two","older":false}),
    );
    assert!(read["value"].is_object(), "{read}");
    let snapshot = f.call(&b, "day.chat.snapshot", json!({"sessionId":"working-two"}));
    assert_eq!(
        snapshot["value"]["snapshot"]["title"], "Exact working-two",
        "{snapshot}"
    );
    assert!(
        snapshot.to_string().contains("Saved words working-two"),
        "{snapshot}"
    );
    let before = f.stats("stats");
    f.stats("delete-other");
    let _ = f.call(
        &b,
        "day.chat.read",
        json!({"sessionId":"working-two","older":false}),
    );
    let lost = f.call(&b, "day.chat.snapshot", json!({"sessionId":"working-two"}));
    assert!(!lost.to_string().contains("Saved words"), "{lost}");
    assert_eq!(
        lost["value"]["snapshot"]["reason"], "Chat not available. Nothing was sent.",
        "{lost}"
    );
    let after = f.stats("stats");
    assert_eq!(after["posts"], before["posts"]);
    assert_eq!(after["sessions"], before["sessions"]);
    close(b);
}

#[test]
fn automatic_profile_access_loss_purges_open_chat_before_its_own_read_can_run() {
    let mut f = Fixture::new();
    let host = f.host();
    let b = Bridge::new(DayRoot::new(host.clone()));
    let _ = f.call(
        &b,
        "day.chat.read",
        json!({"sessionId":"working-two","older":false}),
    );
    assert!(
        host.session_chat("working-two")
            .unwrap()
            .to_string()
            .contains("Saved words")
    );
    let events = host.changes();
    f.stats("revoke-capability");
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            tokio::time::timeout(WAIT, async {
                loop {
                    if host
                        .session_chat("working-two")
                        .is_some_and(|v| v["reason"] == "Chat not available. Nothing was sent.")
                    {
                        break;
                    }
                    events.recv().await.unwrap();
                }
            })
            .await
            .unwrap();
        });
    let current = f.call(&b, "day.chat.snapshot", json!({"sessionId":"working-two"}));
    assert!(!current.to_string().contains("Saved words"), "{current}");
    close(b);
}
