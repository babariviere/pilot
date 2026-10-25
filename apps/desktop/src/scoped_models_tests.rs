use super::*;
use serde_json::json;
#[test]
fn hashes_match_node_json_stringify_sha256_oracle_without_normalizing_unicode() {
    for (value, expected) in [
        (
            None,
            "15dbb2c4361b809a46b847b3b6c071f3c27c096057d31c45351902b79fe39efd",
        ),
        (
            Some(vec![]),
            "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
        ),
        (
            Some(vec![
                "日本語".into(),
                " provider/*:high".into(),
                "provider/*".into(),
                "provider/*".into(),
            ]),
            "da74db0efbb570d8cd8eebe890ba81050206baaf6cc54b1b1022b80bb528af54",
        ),
        (
            Some(vec!["\u{2028}".into(), "\u{85}".into(), "\u{feff}".into()]),
            "a460746e1efe95596b0ea70eaf63b89b338c1b307d38ec1584f54d7cbdcbd39c",
        ),
    ] {
        assert_eq!(hash(&value), expected);
    }
}
#[test]
fn literal_patterns_and_ecmascript_blank_admission_preserve_order_duplicates_suffixes() {
    for v in [
        None,
        Some(vec![
            "provider/model:high".into(),
            "provider/*".into(),
            "provider/*".into(),
        ]),
        Some(vec!["\u{85}".into()]),
    ] {
        assert!(valid_selection(&v).is_ok());
    }
    for v in [
        vec![],
        vec!["\u{feff}".into()],
        vec!["\t".into()],
        vec!["x".repeat(257)],
        vec!["x".into(); 257],
    ] {
        assert!(valid_selection(&Some(v)).is_err());
    }
    assert_ne!(hash(&None), hash(&Some(vec![])));
    assert_ne!(
        hash(&Some(vec!["a".into(), "b".into()])),
        hash(&Some(vec!["b".into(), "a".into()]))
    );
    let req = serde_json::to_value(Save {
        enabled_models: None,
        expected_hash: hash(&None),
    })
    .unwrap();
    assert!(req.get("enabledModels").unwrap().is_null());
    assert_eq!(req.as_object().unwrap().len(), 2);
}
#[test]
fn snapshots_reject_missing_or_forged_hash_identity_and_bounds_without_resolving_patterns() {
    let value = json!({"enabledModels":null,"scopeHash":hash(&None),"allModels":true,"candidates":[{"id":"p/m","provider":"p","name":"模型 👩‍💻"}],"resolution":[]});
    let s: Snapshot = serde_json::from_value(value.clone()).unwrap();
    assert!(s.validate().is_ok());
    let mut bad = s.clone();
    bad.all_models = false;
    assert!(bad.validate().is_err());
    bad = s.clone();
    bad.candidates.push(bad.candidates[0].clone());
    assert!(bad.validate().is_err());
    bad = s.clone();
    bad.scope_hash = "forged".into();
    assert!(bad.validate().is_err());
    bad = s.clone();
    bad.enabled_models = Some(vec!["p/a\np/b".into()]);
    bad.scope_hash = hash(&bad.enabled_models);
    bad.all_models = false;
    assert!(
        bad.validate().is_err(),
        "a legacy newline cannot be silently split into two model patterns"
    );
    bad = s;
    bad.enabled_models = Some(vec!["*".into(); 257]);
    bad.scope_hash = hash(&bad.enabled_models);
    bad.all_models = false;
    assert!(bad.validate().is_err());
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .retry(reqwest::retry::never())
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(2))
        .build()
        .unwrap()
}
#[tokio::test]
async fn exact_global_put_and_both_success_arms_require_get_readback_no_other_mutation() {
    use crate::scoped_models_fixture::{Mode, Server};
    for mode in [
        Mode::Accept,
        Mode::Unchanged,
        Mode::Lost,
        Mode::LostBefore,
        Mode::Conflict,
        Mode::Denied,
        Mode::ReadbackFailure,
    ] {
        let s = Server::start(mode);
        let c = client();
        let desired = Some(vec![
            "p/*:high".into(),
            "p/unknown".into(),
            "p/unknown".into(),
        ]);
        if matches!(mode, Mode::Unchanged) {
            s.seen.lock().unwrap().patterns = desired.clone();
        }
        let initial = read(&c, &s.options).await.unwrap();
        assert_eq!(s.puts(), 0);
        let reply = save(
            &c,
            &s.options,
            Save {
                enabled_models: desired.clone(),
                expected_hash: initial.scope_hash,
            },
        )
        .await;
        assert!(reply.attempted);
        assert_eq!(s.puts(), 1);
        if matches!(mode, Mode::Accept | Mode::Unchanged | Mode::Lost) {
            assert_eq!(reply.observation.unwrap().enabled_models, desired);
        } else if matches!(mode, Mode::ReadbackFailure) {
            assert!(reply.observation.is_err());
        } else {
            assert_ne!(reply.observation.unwrap().enabled_models, desired);
            assert!(reply.problem.is_some());
        }
        let seen = s.seen.lock().unwrap();
        assert!(seen.requests.iter().all(|(m, p, _)| (m == "GET"
            && matches!(p.as_str(), "/api/hello" | "/api/model-scope"))
            || (m == "PUT" && p == "/api/model-scope")));
        let put = seen
            .requests
            .iter()
            .position(|(m, _, _)| m == "PUT")
            .unwrap();
        assert!(
            seen.requests[put + 1..]
                .iter()
                .any(|(m, p, _)| m == "GET" && p == "/api/model-scope")
        );
    }
}
#[tokio::test]
async fn reads_never_acquire_capability_and_bad_capability_or_identity_never_puts() {
    use crate::scoped_models_fixture::{Mode, Server};
    use std::os::unix::fs::PermissionsExt;
    for fault in [
        "missing",
        "oversized",
        "malformed",
        "foreign",
        "permissions",
        "symlink",
        "hello",
    ] {
        let s = Server::start(Mode::Accept);
        let c = client();
        let path = s.home.join("github-app-capability");
        match fault {
            "missing" => std::fs::remove_file(&path).unwrap(),
            "oversized" => std::fs::write(&path, "x".repeat(4097)).unwrap(),
            "malformed" => std::fs::write(&path, "{bad").unwrap(),
            "foreign" => std::fs::write(
                &path,
                json!({"daemonId":"foreign","lineageId":"test-lineage","token":"a".repeat(64)})
                    .to_string(),
            )
            .unwrap(),
            "permissions" => {
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap()
            }
            "symlink" => {
                std::fs::rename(&path, s.home.join("kept")).unwrap();
                std::os::unix::fs::symlink(s.home.join("kept"), &path).unwrap();
            }
            "hello" => s.seen.lock().unwrap().foreign = true,
            _ => unreachable!(),
        }
        let observed = read(&c, &s.options).await;
        assert_eq!(observed.is_ok(), fault != "hello");
        let reply = save(
            &c,
            &s.options,
            Save {
                enabled_models: Some(vec!["p/one".into()]),
                expected_hash: hash(&None),
            },
        )
        .await;
        assert!(!reply.attempted);
        assert!(reply.problem.is_some());
        assert_eq!(s.puts(), 0);
    }
}
#[tokio::test]
async fn unsupported_malformed_and_chunked_oversized_reads_are_bounded_no_fallback() {
    use crate::scoped_models_fixture::{Mode, Server};
    for mode in [
        Mode::Unsupported,
        Mode::Malformed,
        Mode::Oversized,
        Mode::Chunked,
    ] {
        eprintln!("bounded response case {mode:?}");
        let started = std::time::Instant::now();
        let s = Server::start(mode);
        assert!(read(&client(), &s.options).await.is_err());
        assert_eq!(s.puts(), 0);
        drop(s);
        assert!(
            started.elapsed() < std::time::Duration::from_secs(8),
            "owned fixture teardown must be bounded: {mode:?}"
        );
    }
}
