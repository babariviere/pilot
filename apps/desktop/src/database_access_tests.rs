//! Faux loopback daemon only. No real daemon, database, account or grant.
use super::*;
use crate::question::Question;
use std::sync::{Arc, Mutex};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::TcpListener,
};

type Seen = Arc<Mutex<Vec<(String, String, Value)>>>;

/// Hello reports `daemon`; the decision POST gets `reply`, or a dropped connection.
async fn serve(daemon: &'static str, reply: Option<(u16, &'static str)>) -> (LocalOptions, Seen) {
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .unwrap();
    let options = LocalOptions::synthetic(listener.local_addr().unwrap().port());
    let seen = Seen::default();
    let record = seen.clone();
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let record = record.clone();
            tokio::spawn(async move {
                let mut reader = BufReader::new(stream);
                let mut first = String::new();
                if reader.read_line(&mut first).await.unwrap_or(0) == 0 {
                    return;
                }
                let words: Vec<_> = first.split_whitespace().map(str::to_owned).collect();
                let mut length = 0;
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).await.unwrap();
                    if line == "\r\n" {
                        break;
                    }
                    if let Some(n) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                        length = n.trim().parse().unwrap();
                    }
                }
                let mut bytes = vec![0; length];
                reader.read_exact(&mut bytes).await.unwrap();
                let payload = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
                record
                    .lock()
                    .unwrap()
                    .push((words[0].clone(), words[1].clone(), payload));
                let response = if words[1] == "/api/hello" {
                    Some((200, json!({"daemonId":daemon,"lineageId":"test-lineage","protocolVersion":1,"minimumClientProtocolVersion":1,"capabilities":{"independentExecution":true}}).to_string()))
                } else {
                    reply.map(|(status, body)| (status, body.to_owned()))
                };
                if let Some((status, body)) = response {
                    let _ = reader
                        .into_inner()
                        .write_all(
                            format!(
                                "HTTP/1.1 {status} Synthetic\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                                body.len()
                            )
                            .as_bytes(),
                        )
                        .await;
                }
            });
        }
    });
    (options, seen)
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
/// The prose says SELECT-only; the structured request is write and stays write.
pub(crate) fn decision(allow: bool) -> Decision {
    let q = Question::parse(
        4,
        &json!({"question":"Allow read access?","context":"SELECT-only, I promise 日本語",
            "options":[{"label":"Allow read access","suggested":true},{"label":"Deny"}],
            "databaseAccess":{"id":"request-1","env":"prod 日本語","mode":"write"}}),
    )
    .unwrap();
    Decision {
        session: "a".into(),
        question: q.identity.clone(),
        access: q.content.access.clone().unwrap(),
        allow,
    }
}

#[tokio::test]
async fn decision_posts_exact_request_once_and_refuses_only_before_any_change() {
    let refused = |o: &Outcome| matches!(o, Outcome::Refused(_));
    let unknown = |o: &Outcome| *o == Outcome::Unknown(UNKNOWN);
    type Case<'a> = (Option<(u16, &'static str)>, &'a dyn Fn(&Outcome) -> bool);
    let cases: [Case<'_>; 13] = [
        (Some((202, r#"{"ok":true}"#)), &|o: &Outcome| {
            *o == Outcome::Accepted
        }),
        (
            Some((
                409,
                r#"{"error":"This database access request is no longer pending"}"#,
            )),
            &|o: &Outcome| *o == Outcome::Refused(NOT_PENDING),
        ),
        (
            Some((
                409,
                r#"{"error":"Restore the archived session before answering"}"#,
            )),
            &refused,
        ),
        // Saved, then its follow-up message failed: the grant may exist.
        (
            Some((
                409,
                r#"{"error":"Session is changing its model or conversation"}"#,
            )),
            &unknown,
        ),
        (Some((404, r#"{"error":"Unknown session: a"}"#)), &refused),
        (Some((404, r#"{"error":"Not found"}"#)), &unknown),
        (
            Some((400, r#"{"error":"id and allow are required"}"#)),
            &refused,
        ),
        (Some((202, "{broken")), &unknown),
        (Some((202, r#"{"ok":false}"#)), &unknown),
        (Some((200, r#"{"ok":true}"#)), &unknown),
        (Some((500, r#"{"error":"failed"}"#)), &unknown),
        (Some((503, "")), &unknown),
        (None, &unknown),
    ];
    for (reply, expected) in cases {
        for allow in [true, false] {
            let (options, seen) = serve("test-daemon", reply).await;
            let outcome = submit(&client(), &options, &decision(allow)).await;
            assert!(expected(&outcome), "{reply:?} {allow}: {outcome:?}");
            let seen = seen.lock().unwrap().clone();
            assert_eq!(seen.len(), 2, "one identity read, one POST, never a retry");
            assert_eq!(
                (seen[0].0.as_str(), seen[0].1.as_str()),
                ("GET", "/api/hello")
            );
            assert_eq!(
                seen[1],
                (
                    "POST".into(),
                    "/api/sessions/a/database-access".into(),
                    json!({"id":"request-1","allow":allow})
                ),
                "exact request ID and decision only, never prose or env/mode"
            );
        }
    }
}

#[tokio::test]
async fn replaced_daemon_or_invalid_identity_posts_nothing() {
    let (options, seen) = serve("replaced-daemon", Some((202, r#"{"ok":true}"#))).await;
    assert!(matches!(
        submit(&client(), &options, &decision(true)).await,
        Outcome::Refused(_)
    ));
    assert!(seen.lock().unwrap().iter().all(|(m, _, _)| m == "GET"));
    for bad in [
        Decision {
            session: "../a".into(),
            ..decision(true)
        },
        Decision {
            question: crate::question::Identity {
                entry: 4,
                fingerprint: "not-a-digest".into(),
            },
            ..decision(true)
        },
    ] {
        let (options, seen) = serve("test-daemon", Some((202, r#"{"ok":true}"#))).await;
        assert!(matches!(
            submit(&client(), &options, &bad).await,
            Outcome::Refused(_)
        ));
        assert!(seen.lock().unwrap().is_empty());
    }
}
