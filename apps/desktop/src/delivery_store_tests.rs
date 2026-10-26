use super::*;

#[test]
fn question_discard_guard_keeps_separate_reply_and_original_pending_identity() {
    let temp = Temp::new();
    let mut store = Store::open(temp.0.clone(), host()).unwrap();
    let q = question_fixture(4);
    let captured = question_capture(&q, 2, "question words kept independently");
    save(&mut store, "chat:a", captured.clone());
    let before = serde_json::to_vec(&store.book).unwrap();
    assert!(store.discard_draft("chat:a", 2).is_err());
    assert_eq!(serde_json::to_vec(&store.book).unwrap(), before);
    let intent = store
        .prepare_answer("chat:a", &captured, &q, captured.answer.as_ref().unwrap())
        .unwrap();
    let original = serde_json::to_vec(&store.book).unwrap();
    let envelope = serde_json::to_vec(intent.operation.as_ref().unwrap()).unwrap();
    assert!(store.discard_draft("chat:a", 2).is_err());
    assert_eq!(serde_json::to_vec(&store.book).unwrap(), original);
    assert_eq!(
        serde_json::to_vec(store.book.pending[&intent.id].operation.as_ref().unwrap()).unwrap(),
        envelope
    );
    assert!(store.book.abandoned.is_empty());
    drop(store);
    let store = Store::open(temp.0.clone(), host()).unwrap();
    assert_eq!(store.book.pending[&intent.id].answer, intent.answer);
    assert_eq!(store.book.drafts["chat:a"].text, captured.text);
}

#[test]
fn question_answer_edits_do_not_unlock_settled_ordinary_message() {
    let temp = Temp::new();
    let mut store = Store::open(temp.0.clone(), host()).unwrap();
    let ordinary = draft(1, "unchanged rejected ordinary message");
    let rejected = store.prepare("chat:a", &ordinary, false, false).unwrap();
    store.finish(&rejected.id, "rejected", None).unwrap();
    let q = question_fixture(4);
    let mut reply = question_capture(&q, 2, "question words");
    reply.text = ordinary.text.clone();
    assert!(
        store.prepare("chat:a", &reply, false, false).is_err(),
        "Coalesced question-only capture cannot unlock ordinary delivery"
    );
    store
        .save_edits(BTreeMap::from([("chat:a".into(), reply)]))
        .unwrap();
    let saved = store.book.drafts["chat:a"].clone();
    assert!(
        saved
            .settled_revision
            .is_some_and(|revision| revision >= saved.revision),
        "Question-only edits must preserve the ordinary settled guard"
    );
    let intent = store
        .prepare_answer("chat:a", &saved, &q, saved.answer.as_ref().unwrap())
        .unwrap();
    store.finish(&intent.id, "accepted", None).unwrap();
    let saved = store.book.drafts["chat:a"].clone();
    assert!(
        store.prepare("chat:a", &saved, false, false).is_err(),
        "Answering is not editing the ordinary message"
    );
    store
        .retire_answer(
            "chat:a",
            saved.revision,
            &saved.answer.as_ref().unwrap().identity,
            false,
        )
        .unwrap();
    let saved = store.book.drafts["chat:a"].clone();
    assert!(
        store.prepare("chat:a", &saved, false, false).is_err(),
        "Private question cleanup is not an ordinary edit"
    );
    let mut edited = saved;
    edited.revision += 1;
    edited.text.push_str(" with an actual edit");
    assert!(store.prepare("chat:a", &edited, false, false).is_ok());
    let direct = Temp::new();
    let mut store = Store::open(direct.0.clone(), host()).unwrap();
    let rejected = store.prepare("chat:a", &ordinary, false, false).unwrap();
    store.finish(&rejected.id, "rejected", None).unwrap();
    let mut reply = question_capture(&q, 2, "direct question words");
    reply.text = ordinary.text;
    let intent = store
        .prepare_answer("chat:a", &reply, &q, reply.answer.as_ref().unwrap())
        .unwrap();
    store.finish(&intent.id, "accepted", None).unwrap();
    let saved = store.book.drafts["chat:a"].clone();
    assert!(
        store.prepare("chat:a", &saved, false, false).is_err(),
        "Direct admission preserves the same ordinary guard"
    );
}

#[test]
fn question_composer_private_retirement_requires_ack_or_explicit_recovery() {
    let temp = Temp::new();
    let mut store = Store::open(temp.0.clone(), host()).unwrap();
    let q = question_fixture(4);
    let mut captured = question_capture(&q, 2, " raw own words ");
    captured.text.clear();
    let identity = captured.answer.as_ref().unwrap().identity.clone();
    store
        .save_edits(BTreeMap::from([("chat:a".into(), captured.clone())]))
        .unwrap();
    assert!(store.retire_answer("chat:a", 2, &identity, false).is_err());
    let intent = store
        .prepare_answer("chat:a", &captured, &q, captured.answer.as_ref().unwrap())
        .unwrap();
    assert!(
        store.retire_answer("chat:a", 2, &identity, true).is_err(),
        "Uncertain original intent stays exact"
    );
    store.finish(&intent.id, "accepted", None).unwrap();
    store.retire_empty("chat:a", 2).unwrap();
    assert!(
        store.book.drafts.contains_key("chat:a"),
        "Question ACK guard cannot be pruned while its purpose remains"
    );
    store.retire_answer("chat:a", 2, &identity, false).unwrap();
    assert!(store.book.drafts["chat:a"].answer.is_none());
    assert!(store.book.drafts["chat:a"].recovered.is_empty());
    store.retire_empty("chat:a", 3).unwrap();
    assert!(!store.book.drafts.contains_key("chat:a"));
    store
        .save_edits(BTreeMap::from([("chat:a".into(), captured)]))
        .unwrap();
    store.retire_answer("chat:a", 2, &identity, true).unwrap();
    assert_eq!(
        store.book.drafts["chat:a"].recovered.as_ref(),
        &["Tests\n\n raw own words ".to_string()]
    );
}

fn question_fixture(entry: u64) -> crate::question::Question {
    crate::question::Question::parse(entry,&serde_json::json!({"question":"Which checks?","options":[{"label":"Typecheck"},{"label":"Tests"}],"multiSelect":true})).unwrap()
}
fn question_capture(question: &crate::question::Question, revision: u64, text: &str) -> Draft {
    let mut ordinary = draft(revision, "Ordinary unsent 👩‍💻 e\u{301}");
    ordinary.answer = Some(
        crate::question::AnswerDraft::capture(
            question,
            revision,
            std::collections::BTreeSet::from([1]),
            text.into(),
        )
        .unwrap(),
    );
    ordinary
}
#[test]
fn question_answer_acceptance_keeps_ordinary_draft_and_its_send_revision() {
    let temp = Temp::new();
    let mut store = Store::open(temp.0.clone(), host()).unwrap();
    let q = question_fixture(4);
    save(
        &mut store,
        "chat:a",
        draft(1, "Ordinary unsent 👩‍💻 e\u{301}"),
    );
    let captured = question_capture(&q, 2, " own words ");
    let intent = store
        .prepare_answer("chat:a", &captured, &q, captured.answer.as_ref().unwrap())
        .unwrap();
    let op = intent.operation.as_ref().unwrap();
    assert_eq!(op.kind, "chat-send");
    assert_eq!(op.target_id, "a");
    let payload: serde_json::Value = serde_json::from_str(&op.payload).unwrap();
    assert_eq!(
        payload,
        serde_json::json!({"message":"Tests\n\nown words","mode":"steer"})
    );
    store.finish(&intent.id, "accepted", None).unwrap();
    let kept = &store.book.drafts["chat:a"];
    assert_eq!(kept.text, captured.text);
    assert!(kept.settled_revision.is_none());
    assert!(kept.created.is_none());
    assert_eq!(
        kept.last
            .as_ref()
            .unwrap()
            .answer
            .as_ref()
            .unwrap()
            .question,
        q.identity
    );
    assert!(
        store
            .prepare_answer("chat:a", &captured, &q, captured.answer.as_ref().unwrap())
            .is_err(),
        "No duplicate answer while waiting for transcript"
    );
    drop(store);
    let mut store = Store::open(temp.0.clone(), host()).unwrap();
    assert_eq!(store.book.drafts["chat:a"].text, captured.text);
    let regular = store.prepare("chat:a", &captured, false, false).unwrap();
    assert!(regular.answer.is_none());
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&regular.operation.unwrap().payload).unwrap()["message"],
        captured.text
    );
}
#[test]
fn question_answer_unknown_restart_and_rejection_never_retarget_or_clear_ordinary() {
    let temp = Temp::new();
    let mut store = Store::open(temp.0.clone(), host()).unwrap();
    let q = question_fixture(4);
    let captured = question_capture(&q, 2, "original reply");
    let intent = store
        .prepare_answer("chat:a", &captured, &q, captured.answer.as_ref().unwrap())
        .unwrap();
    let original = serde_json::to_vec(intent.operation.as_ref().unwrap()).unwrap();
    save(&mut store, "chat:a", draft(3, "Newer ordinary"));
    drop(store);
    let mut store = Store::open(temp.0.clone(), host()).unwrap();
    assert_eq!(
        serde_json::to_vec(store.book.pending[&intent.id].operation.as_ref().unwrap()).unwrap(),
        original
    );
    assert_eq!(store.book.drafts["chat:a"].text, "Newer ordinary");
    let next = question_fixture(8);
    let retarget = question_capture(&next, 4, "different");
    assert!(
        store
            .prepare_answer(
                "chat:a",
                &retarget,
                &next,
                retarget.answer.as_ref().unwrap()
            )
            .is_err()
    );
    assert_eq!(
        serde_json::to_vec(store.book.pending[&intent.id].operation.as_ref().unwrap()).unwrap(),
        original
    );
    store.finish(&intent.id, "rejected", None).unwrap();
    assert_eq!(store.book.drafts["chat:a"].text, "Newer ordinary");
    assert!(
        store.book.drafts["chat:a"].recovered.is_empty(),
        "Question rejection does not replace ordinary recovery"
    );
    assert_eq!(
        store.book.drafts["chat:a"].answer.as_ref().unwrap().text,
        "original reply"
    );
    assert!(
        store
            .prepare_answer("chat:a", &captured, &q, captured.answer.as_ref().unwrap())
            .is_err()
    );
}
#[test]
fn question_answer_replaced_unsent_reply_is_recoverable_and_capacity_refuses_loss() {
    let temp = Temp::new();
    let mut store = Store::open(temp.0.clone(), host()).unwrap();
    let q = question_fixture(4);
    let first = question_capture(&q, 2, " raw own words \u{200b}");
    save(&mut store, "chat:a", first.clone());
    let next = question_fixture(8);
    let second = question_capture(&next, 3, "next");
    save(&mut store, "chat:a", second);
    assert_eq!(store.book.drafts["chat:a"].text, first.text);
    assert_eq!(
        store.book.drafts["chat:a"].recovered.as_ref(),
        &["Tests\n\n raw own words \u{200b}".to_string()]
    );
    let full = Temp::new();
    let mut store = Store::open(full.0.clone(), host()).unwrap();
    let mut first = first;
    first.recovered = Arc::new(vec!["keep".into(); 8]);
    save(&mut store, "chat:a", first.clone());
    assert!(
        store
            .save_edits(BTreeMap::from([(
                "chat:a".into(),
                question_capture(&next, 3, "next")
            )]))
            .is_err()
    );
    assert!(!store.is_faulted());
    assert!(store.book.drafts["chat:a"].answer == first.answer);
}
#[test]
fn question_answer_capture_legacy_and_write_failure_preserve_original_state() {
    let temp = Temp::new();
    let mut store = Store::open(temp.0.clone(), host()).unwrap();
    save(&mut store, "chat:a", draft(1, "ordinary"));
    let before = fs::read(temp.0.join("state-v1.json")).unwrap();
    assert!(
        !String::from_utf8(before.clone())
            .unwrap()
            .contains("\"answer\"")
    );
    let q = question_fixture(4);
    let captured = question_capture(&q, 2, "own");
    let other = question_fixture(8);
    assert!(
        store
            .prepare_answer(
                "chat:a",
                &captured,
                &other,
                captured.answer.as_ref().unwrap()
            )
            .is_err()
    );
    assert!(
        store
            .prepare_answer("new:slot", &captured, &q, captured.answer.as_ref().unwrap())
            .is_err()
    );
    assert_eq!(before, fs::read(temp.0.join("state-v1.json")).unwrap());
    store.fail_write = true;
    assert!(
        store
            .prepare_answer("chat:a", &captured, &q, captured.answer.as_ref().unwrap())
            .is_err()
    );
    assert!(store.book.pending.is_empty());
    assert_eq!(store.book.drafts["chat:a"].text, "ordinary");
    assert_eq!(before, fs::read(temp.0.join("state-v1.json")).unwrap());
}

#[test]
fn delivery_diagnostic_survives_autosave_other_owner_and_restart_without_tuple_changes() {
    use super::diagnostic::{Acknowledgment, Category, Diagnostic, Stage};
    let temp = Temp::new();
    let mut store = Store::open(temp.0.clone(), host()).unwrap();
    let intent = store
        .prepare("chat:a", &draft(1, "retained original"), false, false)
        .unwrap();
    let original = serde_json::to_vec(intent.operation.as_ref().unwrap()).unwrap();
    let mut delivery = Delivery::from_intent(&intent);
    delivery.diagnostic = Some(Diagnostic {
        stage: Stage::Lookup,
        category: Category::Refused,
        status: Some(503),
        acknowledgment: Acknowledgment::Unknown,
    });
    store.record_diagnostic("chat:a", &delivery).unwrap();
    let before = fs::read(temp.0.join("state-v1.json")).unwrap();
    assert!(store.record_diagnostic("chat:b", &delivery).is_err());
    let mut wrong = delivery.clone();
    wrong.target = "another".into();
    assert!(store.record_diagnostic("chat:a", &wrong).is_err());
    assert_eq!(before, fs::read(temp.0.join("state-v1.json")).unwrap());
    save(&mut store, "chat:b", draft(1, "other owner"));
    save(&mut store, "chat:a", draft(2, "newer native text"));
    drop(store);
    let store = Store::open(temp.0.clone(), host()).unwrap();
    let kept = &store.book.pending[&intent.id];
    assert_eq!(kept.diagnostic, delivery.diagnostic);
    assert_eq!(
        serde_json::to_vec(kept.operation.as_ref().unwrap()).unwrap(),
        original
    );
    assert_eq!(store.book.drafts["chat:a"].text, "newer native text");
    assert_eq!(kept.state, "unknown");
}

#[test]
fn delivery_diagnostic_legacy_absence_and_corrupt_detail_fail_closed() {
    let temp = Temp::new();
    let mut store = Store::open(temp.0.clone(), host()).unwrap();
    let intent = store
        .prepare("chat:a", &draft(1, "legacy"), false, false)
        .unwrap();
    let mut value = serde_json::to_value(&store.book).unwrap();
    value["pending"][&intent.id]
        .as_object_mut()
        .unwrap()
        .remove("diagnostic");
    let bytes = serde_json::to_vec(&value).unwrap();
    drop(store);
    fs::write(temp.0.join("state-v1.json"), &bytes).unwrap();
    let store = Store::open(temp.0.clone(), host()).unwrap();
    assert!(store.book.pending[&intent.id].diagnostic.is_none());
    drop(store);
    value["pending"][&intent.id]["diagnostic"] = serde_json::json!({"stage":"lookup","category":"refused","status":0,"acknowledgment":"unknown"});
    let bytes = serde_json::to_vec(&value).unwrap();
    fs::write(temp.0.join("state-v1.json"), &bytes).unwrap();
    assert!(Store::open(temp.0.clone(), host()).is_err());
    assert_eq!(fs::read(temp.0.join("state-v1.json")).unwrap(), bytes);
}

#[test]
fn delivery_diagnostic_capacity_is_best_effort_and_never_blocks_existing_settlement() {
    use super::diagnostic::{Acknowledgment, Category, Diagnostic, Stage};
    let temp = Temp::new();
    let mut store = Store::open(temp.0.clone(), host()).unwrap();
    let intent = store
        .prepare("chat:a", &draft(1, "capacity"), false, false)
        .unwrap();
    store
        .change(|book| {
            book.drafts.insert(
                "chat:pad".into(),
                Draft {
                    recovered: Arc::new(vec![String::new(); 4]),
                    ..Default::default()
                },
            );
            let amount = STATE_CAP - 16 - serde_json::to_vec(book).unwrap().len();
            let mut left = amount;
            for text in Arc::make_mut(&mut book.drafts.get_mut("chat:pad").unwrap().recovered) {
                let n = left.min(RECOVER_CAP);
                *text = "x".repeat(n);
                left -= n;
            }
            assert_eq!(left, 0);
            Ok(())
        })
        .unwrap();
    let original = store.book.pending[&intent.id].clone();
    let mut d = Delivery::from_intent(&intent);
    d.diagnostic = Some(Diagnostic {
        stage: Stage::Lookup,
        category: Category::Unknown,
        status: Some(200),
        acknowledgment: Acknowledgment::Unknown,
    });
    assert!(store.record_diagnostic("chat:a", &d).is_err());
    assert!(!store.is_faulted());
    assert!(store.book.pending[&intent.id] == original);
    // Existing settlement frees its envelope, independent of diagnostic space.
    store.finish(&intent.id, "accepted", None).unwrap();
    assert!(store.book.pending.is_empty());
    assert_eq!(
        store.book.drafts["chat:a"].last.as_ref().unwrap().state,
        "accepted"
    );
    d.diagnostic.as_mut().unwrap().category = Category::Accepted;
    d.diagnostic.as_mut().unwrap().acknowledgment = Acknowledgment::Accepted;
    store.record_diagnostic("chat:a", &d).unwrap();
    save(&mut store, "chat:a", draft(2, "next local text"));
    drop(store);
    let store = Store::open(temp.0.clone(), host()).unwrap();
    assert_eq!(
        store.book.drafts["chat:a"]
            .last
            .as_ref()
            .unwrap()
            .diagnostic,
        d.diagnostic
    );
}

#[test]
fn delivery_diagnostic_write_failure_preserves_original_durable_bytes() {
    use super::diagnostic::{Diagnostic, Stage};
    let temp = Temp::new();
    let mut store = Store::open(temp.0.clone(), host()).unwrap();
    let intent = store
        .prepare("chat:a", &draft(1, "durable"), false, false)
        .unwrap();
    let bytes = fs::read(temp.0.join("state-v1.json")).unwrap();
    let mut d = Delivery::from_intent(&intent);
    d.diagnostic = Some(Diagnostic::started(Stage::Lookup));
    store.fail_write = true;
    assert!(store.record_diagnostic("chat:a", &d).is_err());
    assert!(store.is_faulted());
    assert!(store.book.pending[&intent.id].diagnostic.is_none());
    assert_eq!(bytes, fs::read(temp.0.join("state-v1.json")).unwrap());
    drop(store);
    let store = Store::open(temp.0.clone(), host()).unwrap();
    assert!(store.book.pending[&intent.id] == intent);
}

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
        project_id: Some("project-a".into()),
        ..Default::default()
    }
}
fn save(store: &mut Store, key: &str, draft: Draft) {
    store
        .save_edits(BTreeMap::from([(key.into(), draft)]))
        .unwrap();
}

fn mission_request(source: &str) -> crate::mission_conversion::Request {
    crate::mission_conversion::Request {
        project_id: "project-exact".into(),
        from_session_id: source.into(),
        title: "Existing conversation".into(),
        goal: "A bounded goal".into(),
        coordinator: false,
        draft: false,
    }
}

fn model_attempt(source: &str) -> crate::chat_models::Attempt {
    crate::chat_models::Attempt {
        id: format!("model-{source}"),
        target: crate::chat_models::Target {
            session: source.into(),
            cwd: "/tmp".into(),
            model: Some("p/a".into()),
            thinking: Some("high".into()),
        },
        choice: crate::chat_models::Choice {
            model: "p/b".into(),
            thinking: None,
        },
    }
}
#[test]
fn model_change_unknown_is_bounded_durable_and_never_evicted_or_replaced() {
    let temp = Temp::new();
    let mut s = Store::open(temp.0.clone(), host()).unwrap();
    for i in 0..32 {
        s.prepare_model_change(model_attempt(&format!("s{i}")))
            .unwrap();
    }
    let retained = s.book.model_changes.clone();
    assert!(s.prepare_model_change(model_attempt("overflow")).is_err());
    assert!(s.prepare_model_change(model_attempt("s0")).is_err());
    assert_eq!(s.book.model_changes, retained);
    drop(s);
    let mut s = Store::open(temp.0.clone(), host()).unwrap();
    assert_eq!(s.book.model_changes, retained);
    assert!(s.finish_model_change("s0", "other-attempt").is_err());
    assert_eq!(s.book.model_changes, retained);
    s.finish_model_change("s0", "model-s0").unwrap();
    assert_eq!(s.book.model_changes.len(), 31);
    s.prepare_model_change(model_attempt("next")).unwrap();
}
#[test]
fn model_changes_cannot_race_retained_chat_delivery() {
    let temp = Temp::new();
    let mut s = Store::open(temp.0.clone(), host()).unwrap();
    let d = draft(1, "Unsent preserved");
    let op = s.prepare("chat:source", &d, true, false).unwrap();
    assert!(s.prepare_model_change(model_attempt("source")).is_err());
    assert!(s.book.pending[&op.id] == op);
    assert!(s.book.model_changes.is_empty());
}
#[test]
fn explicit_new_model_thinking_is_project_bound_and_only_new_payloads_get_overrides() {
    let temp = Temp::new();
    let mut s = Store::open(temp.0.clone(), host()).unwrap();
    let mut d = draft(1, "私の下書き");
    d.model_choice = Some(crate::chat_models::DraftChoice {
        project_id: "project-a".into(),
        cwd: "/tmp".into(),
        choice: crate::chat_models::Choice {
            model: "p/b".into(),
            thinking: Some("low".into()),
        },
    });
    let first = s.prepare("new:chosen", &d, true, false).unwrap();
    let payload: serde_json::Value =
        serde_json::from_str(&first.operation.as_ref().unwrap().payload).unwrap();
    assert_eq!(payload["model"], "p/b");
    assert_eq!(payload["thinking"], "low");
    assert!(payload.get("cwd").is_none());
    let mut changed = d.clone();
    changed.revision = 2;
    changed.model_choice.as_mut().unwrap().choice.model = "q/c".into();
    save(&mut s, "new:chosen", changed.clone());
    assert!(s.book.pending[&first.id] == first);
    assert!(s.book.drafts["new:chosen"].model_choice == d.model_choice);
    let mut wrong = d.clone();
    wrong.project_id = Some("project-b".into());
    assert!(s.prepare("new:wrong", &wrong, true, false).is_err());
    let existing = s.prepare("chat:existing", &d, true, false).unwrap();
    let payload: serde_json::Value =
        serde_json::from_str(&existing.operation.unwrap().payload).unwrap();
    assert!(payload.get("model").is_none() && payload.get("thinking").is_none());
}
#[test]
fn default_and_legacy_pending_envelopes_remain_byte_identical_after_choice_support() {
    let temp = Temp::new();
    let mut s = Store::open(temp.0.clone(), host()).unwrap();
    let d = draft(1, "legacy original");
    let first = s.prepare("new:legacy-model", &d, true, false).unwrap();
    let original = serde_json::to_vec(&first).unwrap();
    let payload: serde_json::Value =
        serde_json::from_str(&first.operation.as_ref().unwrap().payload).unwrap();
    assert_eq!(payload.as_object().unwrap().len(), 3);
    assert!(payload.get("model").is_none() && payload.get("thinking").is_none());
    drop(s);
    let mut s = Store::open(temp.0.clone(), host()).unwrap();
    let mut updated = d;
    updated.revision += 1;
    updated.model_choice = Some(crate::chat_models::DraftChoice {
        project_id: "project-a".into(),
        cwd: "/tmp".into(),
        choice: crate::chat_models::Choice {
            model: "p/b".into(),
            thinking: Some("low".into()),
        },
    });
    save(&mut s, "new:legacy-model", updated.clone());
    let retry = s
        .prepare("new:legacy-model", &updated, true, false)
        .unwrap();
    assert_eq!(serde_json::to_vec(&retry).unwrap(), original);
    assert!(s.book.drafts["new:legacy-model"].model_choice.is_none());
}

#[test]
fn mission_attempt_is_durable_one_shot_without_changing_chat_drafts() {
    use crate::mission_conversion::Outcome;
    let temp = Temp::new();
    let mut store = Store::open(temp.0.clone(), host()).unwrap();
    save(&mut store, "chat:source", draft(3, "私の下書き"));
    let original = store.book.drafts.clone();
    store
        .prepare_mission("attempt-one", mission_request("source"))
        .unwrap();
    assert!(
        store
            .prepare_mission("attempt-one", mission_request("source"))
            .is_err()
    );
    assert!(
        store
            .prepare_mission("attempt-two", mission_request("source"))
            .is_err()
    );
    assert!(store.book.drafts == original);
    drop(store);
    let mut store = Store::open(temp.0.clone(), host()).unwrap();
    assert!(store.book.missions["source"].outcome == Outcome::Unknown);
    assert!(
        store
            .prepare_mission("attempt-three", mission_request("source"))
            .is_err()
    );
    assert!(store.book.drafts == original);
    assert!(
        store
            .finish_mission("source", "wrong-attempt", Outcome::Rejected)
            .is_err()
    );
    store
        .finish_mission(
            "source",
            "attempt-one",
            Outcome::Created {
                mission_id: "mission-exact".into(),
            },
        )
        .unwrap();
    assert!(
        store
            .finish_mission("source", "attempt-one", Outcome::Rejected)
            .is_err()
    );
    drop(store);
    let store = Store::open(temp.0.clone(), host()).unwrap();
    assert!(
        store.book.missions["source"].outcome
            == Outcome::Created {
                mission_id: "mission-exact".into()
            }
    );
    assert!(store.book.drafts == original);
}

#[test]
fn mission_refusal_allows_only_a_new_explicit_attempt_and_validates_payload() {
    use crate::mission_conversion::Outcome;
    let temp = Temp::new();
    let mut store = Store::open(temp.0.clone(), host()).unwrap();
    let empty = serde_json::to_value(&store.book).unwrap();
    assert!(empty.get("missions").is_none()); // Legacy files need no migration.
    store
        .prepare_mission("first", mission_request("source"))
        .unwrap();
    store
        .finish_mission("source", "first", Outcome::Rejected)
        .unwrap();
    assert!(
        store
            .prepare_mission("first", mission_request("source"))
            .is_err()
    );
    store
        .prepare_mission("explicit-new", mission_request("source"))
        .unwrap();
    let payload = serde_json::to_value(mission_request("source")).unwrap();
    assert_eq!(payload["projectId"], "project-exact");
    assert_eq!(payload["fromSessionId"], "source");
    assert_eq!(payload["coordinator"], false);
    assert_eq!(payload["draft"], false);
    assert!(payload.get("startCoordinator").is_none() && payload.get("cwd").is_none());
    let mut invalid = mission_request("other");
    invalid.title = "🦀".repeat(101); // 202 UTF-16 units, only 101 scalars.
    assert!(store.prepare_mission("invalid", invalid).is_err());
    assert!(!store.book.missions.contains_key("other"));
}

#[test]
fn mission_write_failure_cannot_authorize_a_post_or_discard_input() {
    let temp = Temp::new();
    let mut store = Store::open(temp.0.clone(), host()).unwrap();
    save(&mut store, "chat:source", draft(1, "preserved"));
    store.fail_write = true;
    assert!(
        store
            .prepare_mission("first", mission_request("source"))
            .is_err()
    );
    assert!(store.book.missions.is_empty());
    assert_eq!(store.book.drafts["chat:source"].text, "preserved");
    assert!(store.is_faulted());
}

#[test]
fn project_identity_is_explicit_and_pending_selection_cannot_retarget_creation() {
    let temp = Temp::new();
    let mut store = Store::open(temp.0.clone(), host()).unwrap();
    let mut selected = draft(1, "Synthetic 日本語 project request");
    selected.project_id = Some("project-ab".into());
    let first = store
        .prepare("new:project", &selected, true, false)
        .unwrap();
    let payload: serde_json::Value =
        serde_json::from_str(&first.operation.as_ref().unwrap().payload).unwrap();
    assert_eq!(payload["projectId"], "project-ab");
    assert!(
        payload.get("cwd").is_none(),
        "project defaults/workspaces are not overridden"
    );
    let mut changed = selected.clone();
    changed.revision = 2;
    changed.project_id = Some("project-a".into());
    changed.cwd = "/another-folder".into();
    save(&mut store, "new:project", changed.clone());
    assert_eq!(
        store.book.drafts["new:project"].project_id.as_deref(),
        Some("project-ab")
    );
    assert_eq!(store.book.drafts["new:project"].cwd, "/tmp");
    assert!(store.prepare("new:project", &changed, true, false).unwrap() == first);
    drop(store);
    let mut store = Store::open(temp.0.clone(), host()).unwrap();
    assert!(store.prepare("new:project", &changed, true, false).unwrap() == first);
}

#[test]
fn old_unsubmitted_cwd_drafts_require_choice_but_old_pending_payloads_are_immutable() {
    let temp = Temp::new();
    let mut store = Store::open(temp.0.clone(), host()).unwrap();
    let mut legacy = draft(1, "Keep legacy 👩‍💻 text");
    legacy.project_id = None;
    let encoded = serde_json::to_value(&legacy).unwrap();
    assert!(encoded.get("projectId").is_none());
    let restored: Draft = serde_json::from_value(encoded).unwrap();
    assert!(restored == legacy);
    save(&mut store, "new:legacy", legacy.clone());
    assert!(store.prepare("new:legacy", &legacy, true, false).is_err());
    assert_eq!(store.book.drafts["new:legacy"].text, legacy.text);
    let selected = draft(2, &legacy.text);
    let intent = store.prepare("new:legacy", &selected, true, false).unwrap();
    store
        .change(|book| {
            let op = book
                .pending
                .get_mut(&intent.id)
                .unwrap()
                .operation
                .as_mut()
                .unwrap();
            op.payload =
                serde_json::json!({"message":legacy.text,"cwd":"/tmp","mode":"ask"}).to_string();
            op.payload_hash = hash(&op.payload);
            book.drafts.get_mut("new:legacy").unwrap().project_id = None;
            Ok(())
        })
        .unwrap();
    let original = store.book.pending[&intent.id].clone();
    drop(store);
    let mut store = Store::open(temp.0.clone(), host()).unwrap();
    assert!(store.prepare("new:legacy", &legacy, true, false).unwrap() == original);
    assert!(store.book.drafts["new:legacy"].project_id.is_none());
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
fn discarding_a_draft_removes_it_abandons_its_intent_and_keeps_the_record() {
    let temp = Temp::new();
    let mut store = Store::open(temp.0.clone(), host()).unwrap();
    save(&mut store, "new:slot", draft(1, "undelivered message"));
    let intent = store
        .prepare("new:slot", &draft(1, "undelivered message"), false, false)
        .unwrap();
    assert!(store.book.drafts["new:slot"].pending.is_some());
    store.discard_draft("new:slot", 1).unwrap();
    assert!(!store.book.drafts.contains_key("new:slot"));
    assert!(!store.book.pending.contains_key(&intent.id));
    assert_eq!(store.book.abandoned, vec![intent.id.clone()]);
    // A later deliberate message is a new operation, never the abandoned one.
    let next = store
        .prepare(
            "new:slot",
            &draft(2, "a new deliberate message"),
            false,
            false,
        )
        .unwrap();
    assert_ne!(next.id, intent.id);
    assert_eq!(store.book.abandoned, vec![intent.id.clone()]);
    store.discard_draft("new:slot", 2).unwrap();
    assert_eq!(store.book.abandoned.len(), 2);
    let value = serde_json::to_value(&store.book).unwrap();
    drop(store);
    fs::write(
        temp.0.join("state-v1.json"),
        serde_json::to_vec(&value).unwrap(),
    )
    .unwrap();
    let store = Store::open(temp.0.clone(), host()).unwrap();
    assert_eq!(store.book.abandoned.len(), 2);
    assert!(!store.book.drafts.contains_key("new:slot"));
}

#[test]
fn discarding_is_revision_fenced_and_never_silently_drops_a_newer_draft() {
    let temp = Temp::new();
    let mut store = Store::open(temp.0.clone(), host()).unwrap();
    save(&mut store, "chat:a", draft(1, "kept text"));
    assert!(store.discard_draft("chat:a", 2).is_err());
    assert!(store.discard_draft("chat:absent", 1).is_err());
    assert_eq!(store.book.drafts["chat:a"].text, "kept text");
    assert!(store.book.abandoned.is_empty());
    store.discard_draft("chat:a", 1).unwrap();
    assert!(!store.book.drafts.contains_key("chat:a"));
    assert!(store.book.abandoned.is_empty());
}

#[test]
fn abandoned_operations_are_bounded_and_corrupt_records_fail_closed() {
    let temp = Temp::new();
    let mut store = Store::open(temp.0.clone(), host()).unwrap();
    for index in 0..=ABANDONED_CAP {
        let revision = index as u64 + 1;
        save(&mut store, "new:slot", draft(revision, "text"));
        store
            .prepare("new:slot", &draft(revision, "text"), false, false)
            .unwrap();
        store.discard_draft("new:slot", revision).unwrap();
    }
    assert_eq!(store.book.abandoned.len(), ABANDONED_CAP);
    let mut value = serde_json::to_value(&store.book).unwrap();
    drop(store);
    value["abandoned"] = serde_json::json!["not a token"];
    let bytes = serde_json::to_vec(&value).unwrap();
    fs::write(temp.0.join("state-v1.json"), &bytes).unwrap();
    assert!(Store::open(temp.0.clone(), host()).is_err());
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
fn unchanged_transactions_do_not_replace_the_durable_snapshot() {
    let temp = Temp::new();
    let mut store = Store::open(temp.0.clone(), host()).unwrap();
    let captured = draft(1, "synthetic input");
    save(&mut store, "chat:a", captured.clone());
    let intent = store.prepare("chat:a", &captured, true, false).unwrap();
    store.pending(&intent.id).unwrap();
    let before = fs::metadata(temp.0.join("state-v1.json")).unwrap().ino();
    // A redundant transaction must not even reach the injected writer failure.
    store.fail_write = true;
    save(&mut store, "chat:a", captured.clone());
    save(&mut store, "chat:a", draft(0, "stale"));
    store.pending(&intent.id).unwrap();
    assert_eq!(
        store.prepare("chat:a", &captured, true, false).unwrap().id,
        intent.id
    );
    store.finish("unknown-intent", "accepted", None).unwrap();
    store.retire_empty("chat:a", 0).unwrap();
    store.retire_created("new:absent", 1, "absent").unwrap();
    store.save_edits(BTreeMap::new()).unwrap();
    assert!(!store.is_faulted());
    assert_eq!(
        before,
        fs::metadata(temp.0.join("state-v1.json")).unwrap().ino()
    );
    // Changed terminal adoption is still an immediate, fallible durable write.
    assert!(store.finish(&intent.id, "accepted", None).is_err());
    assert!(store.is_faulted());
    assert!(store.book.pending.contains_key(&intent.id));
}

#[test]
fn noop_elision_does_not_bypass_validation_or_an_existing_fault() {
    let temp = Temp::new();
    let mut store = Store::open(temp.0.clone(), host()).unwrap();
    save(&mut store, "chat:a", draft(1, "saved"));
    let mut invalid = draft(0, "stale but invalid");
    invalid.mode = "invalid".into();
    assert!(
        store
            .save_edits(BTreeMap::from([("chat:a".into(), invalid)]))
            .is_err()
    );
    store.fail_write = true;
    assert!(
        store
            .save_edits(BTreeMap::from([("chat:a".into(), draft(2, "unsaved"))]))
            .is_err()
    );
    assert!(store.save_edits(BTreeMap::new()).is_err());
    assert_eq!(store.book.drafts["chat:a"].revision, 1);
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

#[test]
#[ignore = "explicit bounded synthetic snapshot I/O observation, not GUI/performance acceptance"]
fn mission_ledger_snapshot_cost_observation() {
    for count in [0, 32] {
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
        if count > 0 {
            store
                .change(|book| {
                    for i in 0..count {
                        let source = format!("mission-source-{i}");
                        let mut request = mission_request(&source);
                        request.title = "界".repeat(200);
                        request.goal = "界".repeat(4_000);
                        book.missions.insert(
                            source,
                            crate::mission_conversion::Attempt {
                                id: format!("attempt-{i}"),
                                request,
                                outcome: crate::mission_conversion::Outcome::Unknown,
                            },
                        );
                    }
                    Ok(())
                })
                .unwrap();
        }
        let bytes = fs::metadata(temp.0.join("state-v1.json")).unwrap().len();
        let start = std::time::Instant::now();
        for revision in 2..12 {
            save(&mut store, "chat:synthetic-0", draft(revision, &text));
        }
        eprintln!(
            "Mission ledger synthetic: count={count} snapshot_bytes={bytes} updates=10 elapsed_ms={:.3}",
            start.elapsed().as_secs_f64() * 1000.
        );
    }
}

#[test]
fn mission_unicode_admission_refuses_new_blank_attempts_but_preserves_legacy_unknown() {
    use crate::mission_conversion::{Attempt, Outcome};
    let temp = Temp::new();
    let mut store = Store::open(temp.0.clone(), host()).unwrap();
    let original = fs::read(temp.0.join("state-v1.json")).unwrap();
    for title in [
        "",
        " ",
        "\u{feff}",
        " \u{feff} ",
        "\u{00a0}\u{feff}\u{3000}",
    ] {
        let mut r = mission_request("legacy");
        r.title = title.into();
        assert!(store.prepare_mission("new-blank", r).is_err());
        assert!(store.book.missions.is_empty());
        assert_eq!(fs::read(temp.0.join("state-v1.json")).unwrap(), original);
    }
    let mut request = mission_request("legacy");
    request.title = " \u{feff} ".into();
    let legacy = Attempt {
        id: "old-unknown".into(),
        request,
        outcome: Outcome::Unknown,
    };
    // Exact prior-version snapshot shape, without using the new admission gate.
    let mut snapshot = store.book.clone();
    snapshot.missions.insert("legacy".into(), legacy.clone());
    drop(store);
    fs::write(
        temp.0.join("state-v1.json"),
        serde_json::to_vec(&snapshot).unwrap(),
    )
    .unwrap();
    let mut store = Store::open(temp.0.clone(), host()).unwrap();
    assert!(store.book.missions["legacy"] == legacy);
    save(
        &mut store,
        "chat:ordinary",
        draft(1, "Ordinary drafts still save"),
    );
    assert!(
        store
            .prepare_mission("replacement", mission_request("legacy"))
            .is_err()
    );
    assert!(store.book.missions["legacy"] == legacy);
    drop(store);
    let store = Store::open(temp.0.clone(), host()).unwrap();
    assert!(store.book.missions["legacy"] == legacy);
    assert_eq!(
        store.book.drafts["chat:ordinary"].text,
        "Ordinary drafts still save"
    );
    let mut corrupt = legacy;
    corrupt.request.title = " \t".into();
    assert!(
        corrupt.validate("legacy").is_err(),
        "compatibility does not accept formerly invalid ASCII blanks"
    );
}
