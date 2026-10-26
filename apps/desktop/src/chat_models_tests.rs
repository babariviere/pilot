use super::*;
use crate::chat_models_fixture::{Mode, Server};
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
