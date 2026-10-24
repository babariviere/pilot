//! Faux loopback only. No running daemon, credentials, agent or real mutations.
use super::*;
use crate::{
    interaction::{Interaction, WriteCommand, WriteState},
    mission_conversion::{Outcome, Request},
    mission_fixture::{Behavior, Daemon},
};
use serde_json::json;
use std::{path::PathBuf, time::Duration};

struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!("desktop-mission-test-{}", uuid::Uuid::new_v4())))
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
fn target() -> Target {
    Target {
        source: "source".into(),
        project: "project".into(),
        generation: 12,
    }
}
fn request(coordinator: bool, draft: bool) -> Request {
    Request {
        project_id: "project".into(),
        from_session_id: "source".into(),
        title: "Edited title".into(),
        goal: "Explicit goal".into(),
        coordinator,
        draft,
    }
}
fn action(id: &str, coordinator: bool, draft: bool) -> Action {
    Action::Submit {
        id: id.into(),
        request: request(coordinator, draft),
    }
}

#[tokio::test]
async fn admission_requires_guarded_identity_exact_source_and_ordinary_unlinked_chat() {
    for patch in [
        json!({"mode":"control"}),
        json!({"control":true}),
        json!({"role":"diagnostics"}),
        json!({"archivedAt":1}),
        json!({"continuedTo":"other"}),
        json!({"missionId":"old"}),
        json!({"projectId":"other"}),
        json!({"id":"other"}),
    ] {
        let d = Daemon::start(Behavior::Accept).await;
        let tmp = Temp::new();
        let mut store = Store::open(tmp.0.clone(), d.options.host()).unwrap();
        d.seen
            .lock()
            .unwrap()
            .source
            .as_object_mut()
            .unwrap()
            .extend(patch.as_object().unwrap().clone());
        assert!(
            execute(
                &client(),
                &d.options,
                &mut store,
                &target(),
                action("attempt", false, false),
                |_| panic!("inadmissible reservation")
            )
            .await
            .is_err()
        );
        assert!(store.book.missions.is_empty());
        assert!(d.seen.lock().unwrap().posts.is_empty());
    }
    for cap in [Value::Null, json!(false), json!("true")] {
        let d = Daemon::start(Behavior::Accept).await;
        d.seen.lock().unwrap().hello["capabilities"]["guardedMissionConversion"] = cap;
        let tmp = Temp::new();
        let mut store = Store::open(tmp.0.clone(), d.options.host()).unwrap();
        assert!(
            execute(
                &client(),
                &d.options,
                &mut store,
                &target(),
                action("attempt", false, false),
                |_| panic!("unguarded reservation")
            )
            .await
            .is_err()
        );
        assert!(d.seen.lock().unwrap().posts.is_empty());
        assert!(store.book.missions.is_empty());
    }
    let d = Daemon::start(Behavior::Accept).await;
    d.seen.lock().unwrap().hello["daemonId"] = json!("changed");
    let tmp = Temp::new();
    let mut store = Store::open(tmp.0.clone(), d.options.host()).unwrap();
    assert!(
        execute(
            &client(),
            &d.options,
            &mut store,
            &target(),
            action("attempt", false, false),
            |_| {}
        )
        .await
        .is_err()
    );
    assert!(d.seen.lock().unwrap().posts.is_empty());
}

#[tokio::test]
async fn explicit_choices_send_one_exact_payload_after_durable_reservation() {
    for coordinator in [false, true] {
        for draft in [false, true] {
            let d = Daemon::start(Behavior::Accept).await;
            let tmp = Temp::new();
            let mut store = Store::open(tmp.0.clone(), d.options.host()).unwrap();
            let result = execute(
                &client(),
                &d.options,
                &mut store,
                &target(),
                action("one", coordinator, draft),
                |s| {
                    assert!(s.book.missions["source"].outcome == Outcome::Unknown);
                    let disk: Value = serde_json::from_slice(
                        &std::fs::read(tmp.0.join("state-v1.json")).unwrap(),
                    )
                    .unwrap();
                    assert_eq!(disk["missions"]["source"]["outcome"]["kind"], "unknown");
                    assert!(d.seen.lock().unwrap().posts.is_empty());
                },
            )
            .await
            .unwrap();
            assert!(
                matches!(result,Inspection::Created{mission_id} if mission_id=="mission-exact")
            );
            assert!(
                execute(
                    &client(),
                    &d.options,
                    &mut store,
                    &target(),
                    action("duplicate", coordinator, draft),
                    |_| {}
                )
                .await
                .is_err()
            );
            let s = d.seen.lock().unwrap();
            assert_eq!(s.posts.len(), 1);
            assert_eq!(
                s.posts[0],
                serde_json::to_value(request(coordinator, draft)).unwrap()
            );
        }
    }
}

#[tokio::test]
async fn lost_reply_reconciliation_reports_membership_without_inventing_creation_receipt() {
    for behavior in [
        Behavior::LostBefore,
        Behavior::LostAfter,
        Behavior::BadReceipt,
        Behavior::AfterCommitFailure,
    ] {
        let d = Daemon::start(behavior).await;
        let tmp = Temp::new();
        let mut store = Store::open(tmp.0.clone(), d.options.host()).unwrap();
        assert!(matches!(
            execute(
                &client(),
                &d.options,
                &mut store,
                &target(),
                action("one", true, true),
                |_| {}
            )
            .await
            .unwrap(),
            Inspection::Uncertain
        ));
        drop(store);
        let mut store = Store::open(tmp.0.clone(), d.options.host()).unwrap();
        assert!(store.book.missions["source"].outcome == Outcome::Unknown);
        let observed = execute(
            &client(),
            &d.options,
            &mut store,
            &target(),
            Action::Check,
            |_| panic!("read-only reconciliation"),
        )
        .await
        .unwrap();
        assert!(
            matches!(observed,Inspection::Membership{mission_id} if mission_id.is_some()==(behavior!=Behavior::LostBefore))
        );
        assert!(store.book.missions["source"].outcome == Outcome::Unknown);
        assert!(
            execute(
                &client(),
                &d.options,
                &mut store,
                &target(),
                action("two", true, true),
                |_| {}
            )
            .await
            .is_err()
        );
        assert_eq!(d.seen.lock().unwrap().posts.len(), 1);
    }
}

#[tokio::test]
async fn private_write_failure_and_captured_target_mismatch_never_post() {
    let d = Daemon::start(Behavior::Accept).await;
    let tmp = Temp::new();
    let mut store = Store::open(tmp.0.clone(), d.options.host()).unwrap();
    let mut captured = target();
    captured.project = "another".into();
    assert!(
        execute(
            &client(),
            &d.options,
            &mut store,
            &captured,
            action("one", false, false),
            |_| panic!("retargeted")
        )
        .await
        .is_err()
    );
    store.fail_write = true;
    assert!(
        execute(
            &client(),
            &d.options,
            &mut store,
            &target(),
            action("one", false, false),
            |_| panic!("not durable")
        )
        .await
        .is_err()
    );
    assert!(d.seen.lock().unwrap().posts.is_empty());
    assert!(store.is_faulted());
}

#[test]
fn private_receipt_write_failure_retains_the_known_201_id_without_claiming_local_durability() {
    let tmp = Temp::new();
    let options = LocalOptions::synthetic(1);
    let mut store = Store::open(tmp.0.clone(), options.host()).unwrap();
    store
        .prepare_mission("known", request(false, false))
        .unwrap();
    store.fail_write = true;
    let result = retain_receipt(&mut store, &target(), "known", "mission-known").unwrap();
    assert!(matches!(result,Inspection::Created{mission_id} if mission_id=="mission-known"));
    assert!(store.is_faulted());
    assert!(store.book.missions["source"].outcome == Outcome::Unknown);
}

async fn update(
    rx: &async_channel::Receiver<WriteState>,
    predicate: impl Fn(&WriteState) -> bool,
) -> WriteState {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let s = rx.recv().await.unwrap();
            if predicate(&s) {
                return s;
            }
        }
    })
    .await
    .expect("bounded mission worker publication")
}
#[tokio::test]
async fn closing_worker_aborts_wait_and_retains_unknown_attempt_and_latest_draft() {
    let d = Daemon::start(Behavior::Slow).await;
    let tmp = Temp::new();
    let (writer, rx) = Interaction::start(d.options.clone(), Ok(tmp.0.clone()));
    update(&rx, |s| s.book.is_some()).await;
    assert!(writer.edit(
        "chat:source".into(),
        crate::delivery_store::Draft {
            revision: 1,
            text: "Unsent 私の下書き".into(),
            ..Default::default()
        }
    ));
    assert!(writer.command(WriteCommand::Mission {
        target: target(),
        request: 71,
        action: action("one", true, false)
    }));
    tokio::time::timeout(Duration::from_secs(5), d.posted.notified())
        .await
        .unwrap();
    let pending = update(&rx, |s| {
        s.book
            .as_ref()
            .is_some_and(|b| b.missions.contains_key("source"))
    })
    .await;
    assert_eq!(pending.mission.as_ref().unwrap().request, 71);
    assert!(writer.command(WriteCommand::Close));
    let final_state = tokio::time::timeout(Duration::from_secs(1), update(&rx, |s| s.flushed))
        .await
        .unwrap();
    let book = final_state.book.unwrap();
    assert!(book.missions["source"].outcome == Outcome::Unknown);
    assert_eq!(book.drafts["chat:source"].text, "Unsent 私の下書き");
    assert_eq!(d.seen.lock().unwrap().posts.len(), 1);
    assert_eq!(book.pending.len(), 0);
}

#[tokio::test]
async fn outbound_raw_utf16_padding_and_unicode_overflow_refused_before_attempt_or_post() {
    let d = Daemon::start(Behavior::Accept).await;
    let tmp = Temp::new();
    let mut store = Store::open(tmp.0.clone(), d.options.host()).unwrap();
    for (title, goal) in [
        (format!(" {} ", "a".repeat(200)), String::new()),
        ("Valid".into(), format!(" {} ", "a".repeat(4000))),
        ("😀".repeat(101), String::new()),
        ("Valid".into(), "😀".repeat(2001)),
    ] {
        let mut request = request(false, false);
        request.title = title;
        request.goal = goal;
        assert!(
            execute(
                &client(),
                &d.options,
                &mut store,
                &target(),
                Action::Submit {
                    id: "never-prepared".into(),
                    request
                },
                |_| panic!("invalid intent cannot be prepared")
            )
            .await
            .is_err()
        );
        assert!(store.book.missions.is_empty());
        assert!(d.seen.lock().unwrap().posts.is_empty());
    }
}

#[tokio::test]
async fn ecmascript_blank_titles_never_reserve_or_post_but_nonblank_controls_do() {
    let d = Daemon::start(Behavior::Accept).await;
    let tmp = Temp::new();
    let mut store = Store::open(tmp.0.clone(), d.options.host()).unwrap();
    let oracle: serde_json::Value =
        serde_json::from_str(include_str!("../tests/fixtures/ecmascript-trim.json")).unwrap();
    let mut invalid = vec![String::new(), "\u{feff}".into(), " \u{feff} ".into()];
    invalid.extend(
        oracle["trimmedCodePoints"]
            .as_array()
            .unwrap()
            .iter()
            .map(|cp| {
                format!(
                    " \u{feff}{}\u{feff} ",
                    char::from_u32(cp.as_u64().unwrap() as u32).unwrap()
                )
            }),
    );
    for title in invalid {
        let mut r = request(false, false);
        r.title = title;
        assert!(
            execute(
                &client(),
                &d.options,
                &mut store,
                &target(),
                Action::Submit {
                    id: "never-blank".into(),
                    request: r
                },
                |_| panic!("invalid whitespace title must not prepare")
            )
            .await
            .is_err()
        );
        assert!(store.book.missions.is_empty());
        assert!(d.seen.lock().unwrap().posts.is_empty());
    }
    let mut r = request(false, false);
    r.title = "\u{0085}".into();
    r.goal = "\u{0085}".into();
    assert!(matches!(
        execute(
            &client(),
            &d.options,
            &mut store,
            &target(),
            Action::Submit {
                id: "nonblank-nel".into(),
                request: r
            },
            |_| {}
        )
        .await
        .unwrap(),
        Inspection::Created { .. }
    ));
    let seen = d.seen.lock().unwrap();
    assert_eq!(seen.posts.len(), 1);
    assert_eq!(seen.posts[0]["title"], "\u{0085}");
    assert_eq!(seen.posts[0]["goal"], "\u{0085}");
}

#[tokio::test]
async fn legacy_bom_unknown_remains_uncertain_and_cannot_resubmit_after_empty_membership() {
    let d = Daemon::start(Behavior::Accept).await;
    let tmp = Temp::new();
    let mut store = Store::open(tmp.0.clone(), d.options.host()).unwrap();
    let mut r = request(false, false);
    r.title = "\u{feff}".into();
    let legacy = crate::mission_conversion::Attempt {
        id: "legacy-unknown".into(),
        request: r,
        outcome: Outcome::Unknown,
    };
    store.book.missions.insert("source".into(), legacy.clone());
    assert!(matches!(
        execute(
            &client(),
            &d.options,
            &mut store,
            &target(),
            Action::Inspect,
            |_| panic!("read only")
        )
        .await
        .unwrap(),
        Inspection::Membership { mission_id: None }
    ));
    assert!(store.book.missions["source"] == legacy);
    assert!(
        execute(
            &client(),
            &d.options,
            &mut store,
            &target(),
            action("fresh-request-refused", false, false),
            |_| panic!("retained Unknown must not prepare")
        )
        .await
        .is_err()
    );
    assert!(store.book.missions["source"] == legacy);
    assert!(d.seen.lock().unwrap().posts.is_empty());
}
