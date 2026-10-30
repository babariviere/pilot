use super::*;
use crate::chat_models_fixture::{Mode, Server};

#[test]
fn diagnostic_role_can_converse_without_build_conversion_or_model_authority() {
    let mut v = serde_json::json!({"id":"diagnostic", "role":"diagnostics", "mode":"ask", "diagnosticScope":"app", "state":"idle"});
    assert!(crate::local_model::messageable_local(&v));
    assert!(!crate::local_model::interactive_local(&v));
    let model = SessionModel::read(&v);
    assert!(model.diagnostics && !model.allowed && !model.continuable);
    for (key, value) in [
        ("archivedAt", serde_json::json!(1)),
        ("continuedTo", serde_json::json!("other")),
        ("mode", serde_json::json!("build")),
        ("control", serde_json::json!(true)),
        ("role", serde_json::json!("unknown")),
    ] {
        let old = v[key].clone();
        v[key] = value;
        assert!(!crate::local_model::messageable_local(&v), "{key}");
        v[key] = old;
    }
}
fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .timeout(std::time::Duration::from_secs(2))
        .build()
        .unwrap()
}
fn attempt() -> Attempt {
    Attempt {
        id: "choice-one".into(),
        target: Target {
            failed_source: None,
            session: "source".into(),
            cwd: "/synthetic/project".into(),
            model: Some("p/a".into()),
            thinking: Some("high".into()),
        },
        choice: Choice {
            model: "p/b".into(),
            thinking: None,
        },
    }
}

#[tokio::test]
async fn failed_preference_is_passive_exact_ack_and_no_legacy_fallback_or_get_settlement() {
    for mode in [
        Mode::FailedPassive,
        Mode::FailedLost,
        Mode::FailedBadAck,
        Mode::FailedOld,
    ] {
        let s = Server::start(mode);
        let mut store = Store::open(s.home.join("state"), s.options.host()).unwrap();
        let c = client();
        let mut a = attempt();
        a.target.failed_source =
            FailedSource::read(&s.seen.lock().unwrap().session()["failedModelSource"]);
        let result = execute(
            &c,
            &s.options,
            &mut store,
            Action::Submit(a.clone()),
            |_| {},
        )
        .await;
        match mode {
            Mode::FailedPassive => {
                let Outcome::Acknowledged(next) = result else {
                    panic!("exact passive ACK");
                };
                assert_eq!(next.model.as_deref(), Some("p/b"));
                assert_eq!(
                    next.thinking, None,
                    "default is a future scope choice, not the old effective level"
                );
                assert!(next.failed_source.is_some());
                assert!(store.book.model_changes.is_empty());
            }
            Mode::FailedOld => {
                assert!(matches!(result, Outcome::Refused(_)));
                assert_eq!(s.posts(), 0);
            }
            _ => {
                assert!(matches!(result, Outcome::Unknown(_)));
                assert_eq!(store.book.model_changes.get("source"), Some(&a));
                assert!(matches!(
                    execute(
                        &c,
                        &s.options,
                        &mut store,
                        Action::Inspect(a.target.clone()),
                        |_| {}
                    )
                    .await,
                    Outcome::Observed(_)
                ));
                assert_eq!(
                    store.book.model_changes.get("source"),
                    Some(&a),
                    "GET equality never settles uncertainty"
                );
                drop(store);
                store = Store::open(s.home.join("state"), s.options.host()).unwrap();
                assert_eq!(store.book.model_changes.get("source"), Some(&a));
            }
        }
        let seen = s.seen.lock().unwrap();
        assert_eq!(seen.model, "p/a", "does not change the current worker");
        assert_eq!(seen.thinking, "high");
        assert_eq!(seen.session()["outcomeAt"], 100);
        assert!(
            seen.requests
                .iter()
                .filter(|(m, _, _)| m == "POST")
                .all(|(_, p, b)| p.ends_with("/failed-model") && b["operationId"] == "choice-one")
        );
        if !matches!(mode, Mode::FailedOld) {
            assert_eq!(
                seen.requests.iter().filter(|(m, _, _)| m == "POST").count(),
                1
            );
        }
    }
}
#[tokio::test]
async fn explicit_model_only_post_uses_new_scoped_default_not_previous_thinking() {
    let s = Server::start(Mode::Accept);
    let mut store = Store::open(s.home.join("state"), s.options.host()).unwrap();
    let c = client();
    let result = execute(
        &c,
        &s.options,
        &mut store,
        Action::Submit(attempt()),
        |store| assert!(store.book.model_changes.contains_key("source")),
    )
    .await;
    let Outcome::Acknowledged(actual) = result else {
        panic!("expected real model acknowledgment");
    };
    assert_eq!(actual.model.as_deref(), Some("p/b"));
    assert_eq!(actual.thinking.as_deref(), Some("low"));
    assert_eq!(s.posts(), 1);
    assert!(store.book.model_changes.is_empty());
    let seen = s.seen.lock().unwrap();
    let payload = &seen
        .requests
        .iter()
        .find(|(m, _, _)| m == "POST")
        .unwrap()
        .2;
    assert!(payload.get("thinking").is_none());
    assert_eq!(payload.as_object().unwrap().len(), 1);
}
#[tokio::test]
async fn thinking_override_is_exact_and_supported_while_fixed_or_unknown_levels_are_not_invented() {
    let s = Server::start(Mode::Accept);
    let mut store = Store::open(s.home.join("state"), s.options.host()).unwrap();
    let c = client();
    let mut a = attempt();
    a.choice.thinking = Some("high".into());
    assert!(matches!(
        execute(&c, &s.options, &mut store, Action::Submit(a), |_| {}).await,
        Outcome::Acknowledged(_)
    ));
    assert_eq!(s.seen.lock().unwrap().thinking, "high");
    let c = catalog(&c, &s.options, "/synthetic/project").await.unwrap();
    assert_eq!(
        c.models
            .iter()
            .find(|m| m.id == "q/c")
            .unwrap()
            .thinking_levels,
        ["off"]
    );
    assert!(
        c.models
            .iter()
            .find(|m| m.id == "q/d")
            .unwrap()
            .thinking_levels
            .is_empty()
    );
}
#[tokio::test]
async fn server_preflight_idle_pause_stale_scope_and_identity_failures_do_not_post() {
    for mode in [
        Mode::Busy,
        Mode::Failed,
        Mode::Paused,
        Mode::Stale,
        Mode::ScopeChanged,
        Mode::Foreign,
    ] {
        let s = Server::start(mode);
        let mut store = Store::open(s.home.join("state"), s.options.host()).unwrap();
        let r = execute(
            &client(),
            &s.options,
            &mut store,
            Action::Submit(attempt()),
            |_| panic!("must not admit {mode:?}"),
        )
        .await;
        assert!(matches!(r, Outcome::Refused(_)), "{mode:?}");
        assert_eq!(s.posts(), 0);
        assert!(store.book.model_changes.is_empty());
    }
}
#[tokio::test]
async fn parked_idle_change_uses_only_explicit_model_post_without_start_or_send() {
    let s = Server::start(Mode::Parked);
    let mut store = Store::open(s.home.join("state"), s.options.host()).unwrap();
    let result = execute(
        &client(),
        &s.options,
        &mut store,
        Action::Submit(attempt()),
        |_| {},
    )
    .await;
    assert!(matches!(result, Outcome::Acknowledged(_)));
    assert_eq!(s.posts(), 1);
    assert!(store.book.model_changes.is_empty());
    assert!(
        s.seen
            .lock()
            .unwrap()
            .requests
            .iter()
            .all(|(method, path, _)| method == "GET" || path == "/api/sessions/source/model")
    );
}
#[tokio::test]
async fn lost_denied_or_queue_race_is_retained_durably_without_any_automatic_replay() {
    for mode in [Mode::Lost, Mode::Denied, Mode::Queued] {
        let s = Server::start(mode);
        let path = s.home.join("state");
        let mut store = Store::open(path.clone(), s.options.host()).unwrap();
        let c = client();
        let a = attempt();
        assert!(matches!(
            execute(
                &c,
                &s.options,
                &mut store,
                Action::Submit(a.clone()),
                |_| {}
            )
            .await,
            Outcome::Unknown(_)
        ));
        assert_eq!(s.posts(), 1);
        assert_eq!(store.book.model_changes["source"], a);
        drop(store);
        let mut store = Store::open(path, s.options.host()).unwrap();
        assert_eq!(store.book.model_changes["source"], a);
        assert!(matches!(
            execute(
                &c,
                &s.options,
                &mut store,
                Action::Inspect(a.target.clone()),
                |_| {}
            )
            .await,
            Outcome::Observed(_)
        ));
        assert_eq!(store.book.model_changes["source"], a);
        assert_eq!(s.posts(), 1);
        assert!(matches!(
            execute(
                &c,
                &s.options,
                &mut store,
                Action::Submit(a.clone()),
                |_| panic!("no read may authorize retransmission")
            )
            .await,
            Outcome::Refused(_)
        ));
        assert_eq!(s.posts(), 1);
        assert!(matches!(
            execute(
                &c,
                &s.options,
                &mut store,
                Action::Acknowledge {
                    session: "source".into(),
                    id: a.id
                },
                |_| {}
            )
            .await,
            Outcome::Dismissed(_)
        ));
        assert!(store.book.model_changes.is_empty());
        assert_eq!(s.posts(), 1);
    }
}
#[tokio::test]
async fn catalog_cwd_is_exact_encoded_and_response_allocation_and_fixture_teardown_are_bounded() {
    for mode in [Mode::Accept, Mode::Bad, Mode::Oversized, Mode::Chunked] {
        let started = std::time::Instant::now();
        let s = Server::start(mode);
        let r = catalog(&client(), &s.options, "/synthetic/日本語 ?#&").await;
        assert_eq!(r.is_ok(), matches!(mode, Mode::Accept));
        assert_eq!(s.posts(), 0);
        drop(s);
        assert!(
            started.elapsed() < std::time::Duration::from_secs(8),
            "{mode:?}"
        );
    }
}

#[tokio::test]
async fn catalog_hello_transport_failure_is_model_scoped_not_a_daemon_outage_claim() {
    let s = Server::start(Mode::HelloLost);
    let error = catalog(&client(), &s.options, "/synthetic/project")
        .await
        .unwrap_err();
    assert!(error.contains("models"), "{error}");
    assert!(!error.contains("Check that Pilot is running"), "{error}");
    s.seen.lock().unwrap().mode = Mode::Accept;
    assert!(
        catalog(&client(), &s.options, "/synthetic/project")
            .await
            .is_ok()
    );
    assert_eq!(s.posts(), 0);
}
#[test]
fn forced_pause_permits_ordinary_change_and_only_an_unforced_pause_continues() {
    let s = Server::start(Mode::Paused);
    let mut seen = s.seen.lock().unwrap();
    let held = SessionModel::read(&seen.session());
    assert!(!held.allowed && held.blocked == Some(PAUSED));
    assert!(held.continuable && !held.pause.as_ref().unwrap().forced);
    seen.forced = true;
    let forced = SessionModel::read(&seen.session());
    assert!(forced.allowed && !forced.continuable && forced.pause.unwrap().forced);
    seen.forced = false;
    for (key, value) in [
        ("state", serde_json::json!("failed")),
        ("archivedAt", serde_json::json!(1)),
        ("continuationPending", serde_json::json!(true)),
        ("sleepPaused", serde_json::json!(true)),
        ("control", serde_json::json!(true)),
    ] {
        let mut v = seen.session();
        v[key] = value;
        assert!(!SessionModel::read(&v).continuable, "{key}");
    }
}
fn force(value: bool) -> Action {
    Action::Force {
        target: attempt().target,
        force: value,
    }
}
#[tokio::test]
async fn force_posts_once_per_change_and_never_resends_a_lost_reply() {
    let s = Server::start(Mode::Paused);
    let mut store = Store::open(s.home.join("state"), s.options.host()).unwrap();
    let c = client();
    let Outcome::Acknowledged(next) =
        execute(&c, &s.options, &mut store, force(true), |_| {}).await
    else {
        panic!("Force work acknowledged");
    };
    assert!(next.pause.unwrap().forced && next.allowed);
    assert_eq!(s.posts(), 1);
    // Already forced: a fresh read observes it and nothing is posted.
    assert!(matches!(
        execute(&c, &s.options, &mut store, force(true), |_| {}).await,
        Outcome::Observed(_)
    ));
    assert_eq!(s.posts(), 1);
    let Outcome::Acknowledged(next) =
        execute(&c, &s.options, &mut store, force(false), |_| {}).await
    else {
        panic!("Pause at limit acknowledged");
    };
    assert!(!next.pause.unwrap().forced);
    {
        let seen = s.seen.lock().unwrap();
        let posts: Vec<_> = seen
            .requests
            .iter()
            .filter(|(m, _, _)| m == "POST")
            .collect();
        assert_eq!(posts.len(), 2);
        assert!(
            posts
                .iter()
                .all(|(_, p, _)| p == "/api/sessions/source/subscription-force")
        );
        assert_eq!(posts[0].2, serde_json::json!({"force": true}));
        assert_eq!(posts[1].2, serde_json::json!({"force": false}));
    }
    assert!(
        store.book.model_changes.is_empty(),
        "Force never fences Send"
    );
    for (mode, posts) in [
        (Mode::Accept, 0),
        (Mode::PausedRefused, 1),
        (Mode::PausedLost, 1),
    ] {
        let s = Server::start(mode);
        let mut store = Store::open(s.home.join("state"), s.options.host()).unwrap();
        let r = execute(&c, &s.options, &mut store, force(true), |_| {}).await;
        match mode {
            Mode::Accept => assert!(
                matches!(r, Outcome::Observed(_)),
                "no pause, nothing to force"
            ),
            Mode::PausedRefused => assert!(matches!(r, Outcome::Refused(_))),
            _ => assert!(matches!(r, Outcome::Unknown(_))),
        }
        assert_eq!(s.posts(), posts, "{mode:?}");
    }
}
fn continuation(model: &str) -> Action {
    let mut a = attempt();
    a.id = format!("continue-{}", model.replace('/', "-"));
    a.choice.model = model.into();
    Action::Continue(a)
}
#[tokio::test]
async fn continue_model_keeps_the_chat_or_opens_the_replacement_once() {
    let c = client();
    // Same provider: this chat switches model in place, still held.
    let s = Server::start(Mode::Paused);
    let mut store = Store::open(s.home.join("state"), s.options.host()).unwrap();
    let r = execute(&c, &s.options, &mut store, continuation("p/b"), |store| {
        assert!(store.book.model_changes.contains_key("source"))
    })
    .await;
    let Outcome::Acknowledged(next) = r else {
        panic!("same-chat continuation acknowledged");
    };
    assert_eq!(next.model.as_deref(), Some("p/b"));
    assert!(next.pause.is_some());
    assert!(store.book.model_changes.is_empty());
    {
        let seen = s.seen.lock().unwrap();
        let (_, path, body) = seen.requests.iter().find(|(m, _, _)| m == "POST").unwrap();
        assert_eq!(path, "/api/sessions/source/continue-model");
        assert_eq!(body, &serde_json::json!({"model": "p/b"}));
    }
    assert_eq!(s.posts(), 1);
    // Another provider: the replacement chat is returned to open.
    let s = Server::start(Mode::Paused);
    let mut store = Store::open(s.home.join("state"), s.options.host()).unwrap();
    let Outcome::Continued(next) =
        execute(&c, &s.options, &mut store, continuation("q/c"), |_| {}).await
    else {
        panic!("replacement chat");
    };
    assert_eq!(next.id, "next");
    assert!(store.book.model_changes.is_empty());
    assert_eq!(s.posts(), 1);
    assert_eq!(
        s.seen.lock().unwrap().model,
        "p/a",
        "the source keeps its model"
    );
    // Refused settles; a lost reply stays retained across restart, never resent.
    for mode in [Mode::PausedRefused, Mode::PausedLost] {
        let s = Server::start(mode);
        let mut store = Store::open(s.home.join("state"), s.options.host()).unwrap();
        let r = execute(&c, &s.options, &mut store, continuation("q/c"), |_| {}).await;
        assert_eq!(s.posts(), 1);
        if matches!(mode, Mode::PausedRefused) {
            assert!(matches!(r, Outcome::Refused(_)));
            assert!(store.book.model_changes.is_empty());
        } else {
            assert!(matches!(r, Outcome::Unknown(_)));
            drop(store);
            let store = Store::open(s.home.join("state"), s.options.host()).unwrap();
            assert_eq!(store.book.model_changes["source"].choice.model, "q/c");
        }
    }
    // Not paused, forced, or out of scope: refused before any POST.
    for (mode, forced, model) in [
        (Mode::Accept, false, "p/b"),
        (Mode::Paused, true, "p/b"),
        (Mode::Paused, false, "z/unknown"),
    ] {
        let s = Server::start(mode);
        s.seen.lock().unwrap().forced = forced;
        let mut store = Store::open(s.home.join("state"), s.options.host()).unwrap();
        let r = execute(&c, &s.options, &mut store, continuation(model), |_| {
            panic!("must not admit {mode:?}")
        })
        .await;
        assert!(
            matches!(r, Outcome::Refused(_)),
            "{mode:?} {forced} {model}"
        );
        assert_eq!(s.posts(), 0);
        assert!(store.book.model_changes.is_empty());
    }
}
