use super::*;
struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!("desktop-state-test-{}", Uuid::new_v4())))
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn host() -> Host {
    Host {
        host_id: "local".into(),
        daemon_id: "test-daemon".into(),
        lineage_id: "test-lineage".into(),
    }
}
fn draft(revision: u64, text: &str) -> Draft {
    Draft {
        revision,
        text: text.into(),
        cwd: "/tmp".into(),
        ..Default::default()
    }
}
fn save(store: &mut Store, key: &str, draft: Draft) {
    store
        .save_edits(BTreeMap::from([(key.into(), draft)]))
        .unwrap();
}

#[test]
fn drafts_and_immutable_intent_survive_restart_without_a_fresh_target() {
    let temp = Temp::new();
    let mut store = Store::open(temp.0.clone(), host()).unwrap();
    save(&mut store, "new:slot", draft(1, "日本語 é 👋"));
    let first = store
        .prepare("new:slot", &draft(1, "日本語 é 👋"), true, false)
        .unwrap();
    let second = store
        .prepare("new:slot", &draft(1, "日本語 é 👋"), true, false)
        .unwrap();
    assert_eq!(first.id, second.id);
    assert_eq!(first.target, second.target);
    drop(store);
    let mut restored = Store::open(temp.0.clone(), host()).unwrap();
    let pending = restored.book.pending.get(&first.id).unwrap();
    assert_eq!(
        pending.operation.as_ref().unwrap().payload_hash,
        first.operation.as_ref().unwrap().payload_hash
    );
    assert_eq!(pending.target, first.target);
    restored.finish(&first.id, "accepted", None).unwrap();
    assert!(restored.book.drafts["new:slot"].text.is_empty());
    assert_eq!(
        restored.book.drafts["new:slot"].created.as_ref(),
        Some(&first.target)
    );
    assert!(
        restored
            .prepare("new:slot", &draft(1, "日本語 é 👋"), true, false)
            .is_err()
    );
}

#[test]
fn late_acceptance_never_clears_newer_edits_or_another_chat() {
    let temp = Temp::new();
    let mut store = Store::open(temp.0.clone(), host()).unwrap();
    save(&mut store, "chat:a", draft(1, "first"));
    save(&mut store, "chat:b", draft(1, "other"));
    let intent = store
        .prepare("chat:a", &draft(1, "first"), false, false)
        .unwrap();
    save(&mut store, "chat:a", draft(2, "newer 日本語"));
    store.finish(&intent.id, "accepted", None).unwrap();
    assert_eq!(store.book.drafts["chat:a"].text, "newer 日本語");
    assert_eq!(store.book.drafts["chat:b"].text, "other");
    assert!(
        store
            .prepare("chat:a", &draft(1, "first"), false, false)
            .is_err()
    );
    assert!(
        store
            .prepare("chat:a", &draft(2, "newer 日本語"), false, false)
            .is_ok()
    );
}

#[test]
fn failed_writes_fence_delivery_and_do_not_replace_committed_text() {
    let temp = Temp::new();
    let mut store = Store::open(temp.0.clone(), host()).unwrap();
    save(&mut store, "chat:a", draft(1, "committed"));
    let before = fs::read(temp.0.join("state-v1.json")).unwrap();
    store.fail_write = true;
    assert!(
        store
            .prepare("chat:a", &draft(1, "committed"), true, false)
            .is_err()
    );
    assert!(store.book.pending.is_empty());
    assert_eq!(before, fs::read(temp.0.join("state-v1.json")).unwrap());
    drop(store);
    let restored = Store::open(temp.0.clone(), host()).unwrap();
    assert_eq!(restored.book.drafts["chat:a"].text, "committed");
}

#[test]
fn corruption_identity_change_and_duplicate_owner_fail_closed() {
    let temp = Temp::new();
    let mut store = Store::open(temp.0.clone(), host()).unwrap();
    save(&mut store, "chat:a", draft(1, "private synthetic text"));
    assert!(Store::open(temp.0.clone(), host()).is_err());
    drop(store);
    let before = fs::read(temp.0.join("state-v1.json")).unwrap();
    let mut different = host();
    different.lineage_id = "other-lineage".into();
    assert!(Store::open(temp.0.clone(), different).is_err());
    assert_eq!(before, fs::read(temp.0.join("state-v1.json")).unwrap());
    fs::write(temp.0.join("state-v1.json"), b"{truncated").unwrap();
    assert!(Store::open(temp.0.clone(), host()).is_err());
    assert_eq!(
        fs::read(temp.0.join("state-v1.json")).unwrap(),
        b"{truncated"
    );
}

#[test]
fn stop_restores_withdrawn_text_separately_and_only_once() {
    let temp = Temp::new();
    let mut store = Store::open(temp.0.clone(), host()).unwrap();
    save(&mut store, "chat:a", draft(1, "still typing"));
    let stop = store
        .prepare("chat:a", &draft(1, "still typing"), true, true)
        .unwrap();
    assert!(stop.operation.is_none());
    save(&mut store, "chat:a", draft(2, "new typing"));
    store
        .finish(
            &stop.id,
            "accepted",
            Some("queued one\n\nqueued two".into()),
        )
        .unwrap();
    store
        .finish(
            &stop.id,
            "accepted",
            Some("queued one\n\nqueued two".into()),
        )
        .unwrap();
    assert_eq!(store.book.drafts["chat:a"].text, "new typing");
    assert_eq!(store.book.drafts["chat:a"].recovered.len(), 1);
}

#[test]
fn private_permissions_and_state_limits_are_enforced() {
    let temp = Temp::new();
    let mut store = Store::open(temp.0.clone(), host()).unwrap();
    let edits = (0..DRAFT_CAP)
        .map(|i| (format!("chat:synthetic-{i}"), draft(1, "bounded")))
        .collect();
    store.save_edits(edits).unwrap();
    assert!(
        store
            .save_edits(BTreeMap::from([(
                "chat:overflow".into(),
                draft(1, "refuse")
            )]))
            .is_err()
    );
    assert_eq!(store.book.drafts.len(), DRAFT_CAP);
    assert_eq!(
        fs::metadata(temp.0.join("state-v1.json")).unwrap().mode() & 0o777,
        0o600
    );
    assert_eq!(fs::metadata(&temp.0).unwrap().mode() & 0o777, 0o700);
}

#[test]
fn missing_initialized_snapshot_never_becomes_an_empty_profile() {
    let temp = Temp::new();
    let mut store = Store::open(temp.0.clone(), host()).unwrap();
    save(&mut store, "chat:a", draft(1, "preserve private data"));
    drop(store);
    fs::remove_file(temp.0.join("state-v1.json")).unwrap();
    assert!(Store::open(temp.0.clone(), host()).is_err());
    assert!(!temp.0.join("state-v1.json").exists());
}
#[test]
fn recovery_removal_and_empty_retirement_are_revision_fenced() {
    let temp = Temp::new();
    let mut store = Store::open(temp.0.clone(), host()).unwrap();
    let stop = store.prepare("chat:a", &draft(1, ""), true, true).unwrap();
    store
        .finish(&stop.id, "accepted", Some("withdrawn".into()))
        .unwrap();
    let first = store.book.drafts["chat:a"].recovery_revision;
    let stop = store.prepare("chat:a", &draft(1, ""), true, true).unwrap();
    store
        .finish(&stop.id, "accepted", Some("later withdrawn".into()))
        .unwrap();
    store.clear_recovery("chat:a", first).unwrap();
    assert_eq!(store.book.drafts["chat:a"].recovered.len(), 2);
    store.clear_recovery("chat:a", first + 1).unwrap();
    assert!(store.book.drafts["chat:a"].recovered.is_empty());
    save(&mut store, "chat:a", draft(2, "newer typing"));
    store.retire_empty("chat:a", 1).unwrap();
    assert_eq!(store.book.drafts["chat:a"].text, "newer typing");
    save(&mut store, "chat:a", draft(3, ""));
    store.retire_empty("chat:a", 3).unwrap();
    assert!(!store.book.drafts.contains_key("chat:a"));
}
#[test]
fn rejection_retains_original_when_the_composer_has_newer_text() {
    let temp = Temp::new();
    let mut store = Store::open(temp.0.clone(), host()).unwrap();
    let intent = store
        .prepare("chat:a", &draft(1, "original"), true, false)
        .unwrap();
    save(&mut store, "chat:a", draft(2, "newer"));
    store.finish(&intent.id, "rejected", None).unwrap();
    assert_eq!(store.book.drafts["chat:a"].text, "newer");
    assert_eq!(*store.book.drafts["chat:a"].recovered, vec!["original"]);
}

#[test]
fn stop_cannot_erase_settled_send_revision_protection() {
    let temp = Temp::new();
    let mut store = Store::open(temp.0.clone(), host()).unwrap();
    let captured = draft(1, "sent once");
    let intent = store.prepare("chat:a", &captured, true, false).unwrap();
    store.finish(&intent.id, "accepted", None).unwrap();
    let stop = store.prepare("chat:a", &draft(2, ""), true, true).unwrap();
    store.finish(&stop.id, "accepted", None).unwrap();
    assert!(store.prepare("chat:a", &captured, true, false).is_err());
    assert!(
        store
            .prepare("chat:a", &draft(2, "new deliberate intent"), true, false)
            .is_ok()
    );
}

#[test]
#[ignore = "explicit synthetic disk-I/O observation, not a GUI benchmark"]
fn private_snapshot_writer_workload() {
    let temp = Temp::new();
    let mut store = Store::open(temp.0.clone(), host()).unwrap();
    let text = "x".repeat(TEXT_CAP);
    store
        .save_edits(
            (0..DRAFT_CAP)
                .map(|i| (format!("chat:synthetic-{i}"), draft(1, &text)))
                .collect(),
        )
        .unwrap();
    let bytes = fs::metadata(temp.0.join("state-v1.json")).unwrap().len();
    let start = std::time::Instant::now();
    for revision in 2..12 {
        save(&mut store, "chat:synthetic-0", draft(revision, &text));
    }
    eprintln!(
        "Synthetic snapshot: {bytes} bytes; 10 atomic updates: {:.3} ms",
        start.elapsed().as_secs_f64() * 1000.
    );
}
