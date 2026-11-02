//! Synthetic checks only: owned faux loopback HTTP and private temporary state.
use super::*;
use crate::{
    delivery_store::{Draft, Store},
    interaction::{Interaction, WriteCommand, WriteState},
};
use std::{
    io::{BufRead, Read, Write},
    net::TcpListener,
    os::unix::fs::PermissionsExt,
    sync::Mutex,
};

const PROPOSAL: &str = "diagnostic-proposal:v1:12345678-1234-4234-8234-123456789abc";
const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

fn local_host() -> Value {
    json!({"hostId":"local","daemonId":"test-daemon","lineageId":"test-lineage"})
}
fn app_subject() -> Value {
    json!({"kind":"app","host":local_host()})
}
fn proposal_json() -> Value {
    json!({
        "schemaVersion":1,"id":PROPOSAL,"createdAt":"2026-11-02T10:00:00.000Z",
        "repairTitle":"Fix stalled tool 日本語",
        "evidenceRefs":["diagnostic:v1:a","diagnostic:v1:b"],
        "findings":"The tool stalled 👩‍💻.","uncertainty":"medium",
        "suggestedRepair":"Add a timeout.","regressionTestGuidance":"Cover the timeout."
    })
}
fn summary(extra: Value) -> Value {
    let mut value = json!({
        "id":"spec-1","title":"Diagnose","role":"diagnostics","mode":"ask","state":"idle",
        "diagnosticScope":"app","diagnosticHost":local_host()
    });
    for (k, v) in extra.as_object().unwrap() {
        value[k] = v.clone();
    }
    value
}
fn ready() -> Arc<Proposal> {
    specialist(&summary(
        json!({"diagnosticRepairProposal":proposal_json()}),
    ))
    .unwrap()
    .proposal()
    .unwrap()
    .clone()
}
fn binding_json() -> Value {
    json!({
        "schemaVersion":1,"id":"11111111-2222-4333-8444-555555555555","revision":3,
        "host":local_host(),"projectId":"pilot-src","path":"/src/pilot",
        "origin":PILOT_ORIGIN,"configuredAt":"2026-11-01T00:00:00.000Z"
    })
}
fn handoff_json() -> Value {
    json!({
        "schemaVersion":1,"host":local_host(),"subject":app_subject(),
        "evidence":[
            {"ref":"diagnostic:v1:a","kind":"tool.in_flight","source":"kernel","at":"2026-11-02T09:00:00.000Z"},
            {"ref":"diagnostic:v1:b","kind":"model.request","source":"daemon","at":"2026-11-02T09:01:00.000Z"}
        ],
        "proposalId":PROPOSAL,"findings":"The tool stalled 👩‍💻.","uncertainty":"medium",
        "suggestedRepair":"Add a timeout.","regressionTestGuidance":"Cover the timeout.",
        "repairTitle":"Fix stalled tool 日本語"
    })
}
fn available() -> Binding {
    match project_status(&json!({"state":"available","revision":3,"binding":binding_json()}))
        .unwrap()
        .state
    {
        ProjectState::Available(b) => b,
        other => panic!("{other:?}"),
    }
}

#[test]
fn structured_proposal_comes_only_from_the_persisted_role() {
    let chat = crate::local_model::chat(&summary(
        json!({"diagnosticRepairProposal":proposal_json()}),
    ))
    .unwrap();
    let spec = chat.diagnostic.as_deref().unwrap();
    let proposal = spec.proposal().unwrap();
    assert_eq!(proposal.title, "Fix stalled tool 日本語");
    assert_eq!(proposal.uncertainty.label(), "Medium uncertainty");
    assert_eq!(spec.subject, Some(app_subject()));
    assert!(spec.same_host(&LocalOptions::synthetic(1)));

    // Prose never grants a role or a proposal.
    let ordinary = json!({"id":"a","state":"idle","lastMessage":"repair_proposal {\"id\":\"x\"}","diagnosticRepairProposal":proposal_json()});
    assert!(
        crate::local_model::chat(&ordinary)
            .unwrap()
            .diagnostic
            .is_none()
    );
    assert_eq!(specialist_of(json!({})).proposal, ProposalState::None);

    // Malformed or mismatched proposals are shown as unreadable, never repaired.
    for (field, value) in [
        (
            "id",
            json!("diagnostic-proposal:v2:12345678-1234-4234-8234-123456789abc"),
        ),
        ("uncertainty", json!("certain")),
        ("evidenceRefs", json!(["diagnostic-log:v1:a"])),
        ("evidenceRefs", json!([])),
        ("targetSessionId", json!("other-chat")),
        ("findings", json!("  ")),
        ("subject", json!({"kind":"app","host":{"hostId":"local"}})),
    ] {
        let mut raw = proposal_json();
        raw[field] = value;
        assert_eq!(
            specialist_of(json!({"diagnosticRepairProposal":raw})).proposal,
            ProposalState::Malformed,
            "{field}"
        );
    }

    // Legacy chats without a verified subject cannot repair.
    assert!(
        specialist_of(json!({"diagnosticHost":null}))
            .subject
            .is_none()
    );
    // Chat scope must name the same target it was admitted with.
    let target =
        json!({"host":local_host(),"sessionId":"target-1","chatUrl":"pilot://chat/target-1"});
    let chat_scope = |id: &str| {
        specialist(&json!({"id":"s","role":"diagnostics","diagnosticTarget":target,"diagnosticTargetId":id}))
            .unwrap()
            .subject
    };
    assert_eq!(
        chat_scope("target-1"),
        Some(
            json!({"kind":"chat","host":local_host(),"sessionId":"target-1","chatUrl":"pilot://chat/target-1"})
        )
    );
    assert_eq!(chat_scope("other"), None);

    // Another daemon or lineage is a different host; repairs never switch hosts.
    let mut foreign = local_host();
    foreign["lineageId"] = json!("other-lineage");
    assert!(
        !specialist_of(json!({"diagnosticHost":foreign})).same_host(&LocalOptions::synthetic(1))
    );
}
fn specialist_of(extra: Value) -> Specialist {
    specialist(&summary(extra)).unwrap()
}

#[test]
fn review_and_start_payloads_are_exact() {
    let proposal = ready();
    assert_eq!(
        review_request(&proposal, &app_subject()),
        json!({
            "proposalId":PROPOSAL,"findings":"The tool stalled 👩‍💻.","uncertainty":"medium",
            "suggestedRepair":"Add a timeout.","regressionTestGuidance":"Cover the timeout.",
            "subject":app_subject(),"repairTitle":"Fix stalled tool 日本語"
        })
    );
    let reviewed = handoff(&handoff_json(), &proposal, &app_subject()).unwrap();
    assert_eq!(reviewed.title, "Fix stalled tool 日本語");
    assert_eq!(reviewed.evidence[0].title, "Tool in flight");
    assert_eq!(
        reviewed.evidence[0].detail,
        "Kernel · 2026-11-02T09:00:00.000Z"
    );
    for (field, value) in [
        (
            "proposalId",
            json!("diagnostic-proposal:v1:00000000-1234-4234-8234-123456789abc"),
        ),
        (
            "subject",
            json!({"kind":"app","host":{"hostId":"local","daemonId":"other","lineageId":"test-lineage"}}),
        ),
        ("evidence", json!([{"ref":"diagnostic:v1:a"}])),
        ("repairTitle", json!("bad\ntitle")),
    ] {
        let mut raw = handoff_json();
        raw[field] = value;
        assert!(handoff(&raw, &proposal, &app_subject()).is_err(), "{field}");
    }

    let payload: Value = serde_json::from_str(
        &start_payload(
            "spec-1",
            &proposal,
            &app_subject(),
            &reviewed,
            &available(),
            true,
        )
        .unwrap(),
    )
    .unwrap();
    let message = payload["message"].as_str().unwrap();
    assert!(message.starts_with("Investigate and repair the diagnosed issue."));
    assert!(message.contains("fresh bounded, sanitized evidence of the approved subject"));
    let material: Value = serde_json::from_str(message.split_once("\n\n").unwrap().1).unwrap();
    assert_eq!(material, handoff_json());
    let mut expected = json!({
        "projectId":"pilot-src","title":"Fix stalled tool 日本語","mode":"build","workspace":"clone",
        "diagnosticRepair":{
            "specialistSessionId":"spec-1","proposalId":PROPOSAL,"subject":app_subject(),
            "binding":binding_json(),"repairTitle":"Fix stalled tool 日本語","readDiagnostics":true
        }
    });
    expected["message"] = payload["message"].clone();
    assert_eq!(
        payload, expected,
        "no model, cwd, mission, branch or role overrides"
    );

    let denied: Value = serde_json::from_str(
        &start_payload(
            "spec-1",
            &proposal,
            &app_subject(),
            &reviewed,
            &available(),
            false,
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(denied["diagnosticRepair"]["readDiagnostics"], false);
    assert!(
        denied["message"]
            .as_str()
            .unwrap()
            .contains("No fresh diagnostic access was granted")
    );

    // A destination configured for another host identity is refused, not retargeted.
    let mut other = binding_json();
    other["host"]["hostId"] = json!("devbox");
    let ProjectState::Available(other) =
        project_status(&json!({"state":"available","revision":3,"binding":other}))
            .unwrap()
            .state
    else {
        panic!()
    };
    assert!(start_payload("spec-1", &proposal, &app_subject(), &reviewed, &other, true).is_err());
    // Oversized handoff material never becomes an operation.
    let mut large = handoff_json();
    large["findings"] = json!("x".repeat(70 * 1024));
    let large = Handoff {
        raw: large,
        ..reviewed.clone()
    };
    assert!(
        start_payload(
            "spec-1",
            &proposal,
            &app_subject(),
            &large,
            &available(),
            true
        )
        .is_err()
    );
}

#[test]
fn project_status_states_are_truthful() {
    assert_eq!(
        project_status(&json!({"state":"missing","revision":0}))
            .unwrap()
            .state,
        ProjectState::Missing
    );
    assert_eq!(
        project_status(&json!({"state":"invalid","revision":0,"reason":"storage"}))
            .unwrap()
            .state,
        ProjectState::Invalid
    );
    assert_eq!(
        project_status(&json!({"state":"unavailable","revision":2,"reason":"origin_changed","binding":binding_json()}))
            .unwrap()
            .state,
        ProjectState::Unavailable("The repair project is no longer a Pilot source checkout.")
    );
    let mut wrong = binding_json();
    wrong["origin"] = json!("[\"github.com\",\"someone/else\"]");
    assert!(project_status(&json!({"state":"available","revision":3,"binding":wrong})).is_err());
}

struct Temp(std::path::PathBuf);
impl Temp {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!("diagnostic-repair-{}", uuid::Uuid::new_v4())))
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn retained_start_is_immutable_and_never_duplicated() {
    let temp = Temp::new();
    let host = LocalOptions::synthetic(1).host();
    let payload =
        json!({"diagnosticRepair":{"specialistSessionId":"spec-1","proposalId":PROPOSAL}})
            .to_string();
    let mut store = Store::open(temp.0.clone(), host.clone()).unwrap();
    // The payload must name its owner chat and proposal.
    assert!(
        store
            .prepare_repair("spec-2", PROPOSAL, payload.clone())
            .is_err()
    );
    let op = store
        .prepare_repair("spec-1", PROPOSAL, payload.clone())
        .unwrap();
    assert_eq!(op.kind, "repair-create");
    assert_eq!(op.payload_hash, crate::delivery_store::hash(&payload));
    assert_eq!(
        store
            .prepare_repair("spec-1", PROPOSAL, payload.clone())
            .err()
            .unwrap(),
        "A repair start is still unconfirmed. Check it; nothing new was sent."
    );
    drop(store);
    let store = Store::open(temp.0.clone(), host.clone()).unwrap();
    assert!(store.book.repairs["spec-1"].open());
    assert!(store.book.repairs["spec-1"].operation == op);
    drop(store);

    let temp = Temp::new();
    let mut store = Store::open(temp.0.clone(), host.clone()).unwrap();
    let op = store
        .prepare_repair("spec-1", PROPOSAL, payload.clone())
        .unwrap();
    store
        .finish_repair("spec-1", &op.operation_id, State::Pending, None)
        .unwrap();
    store
        .finish_repair("spec-1", &op.operation_id, State::Accepted, None)
        .unwrap();
    assert!(
        store
            .finish_repair(
                "spec-1",
                &op.operation_id,
                State::Rejected,
                Some("x".into())
            )
            .is_err(),
        "a settled receipt is never replaced"
    );
    assert_eq!(
        store
            .prepare_repair("spec-1", PROPOSAL, payload.clone())
            .err()
            .unwrap(),
        "This proposal already started a repair chat."
    );
    drop(store);
    let store = Store::open(temp.0.clone(), host).unwrap();
    assert_eq!(store.book.repairs["spec-1"].state, State::Accepted);
    assert!(store.book.repairs["spec-1"].operation == op);
    drop(store);
    let file = temp.0.join("state-v1.json");
    let edited = std::fs::read_to_string(&file).unwrap().replace(
        "\"specialistSessionId\\\":\\\"spec-1",
        "\"specialistSessionId\\\":\\\"spec-2",
    );
    std::fs::write(&file, edited).unwrap();
    assert!(Store::open(temp.0.clone(), LocalOptions::synthetic(1).host()).is_err());
}

/// One owned loopback server. A None reply drops the connection after reading
/// the request: the lost-acknowledgement case.
type Handler = Box<dyn Fn(&str, &str, &Value) -> Option<(u16, Value)> + Send>;
/// Every request: method, path, capability present, body bytes.
type Seen = Arc<Mutex<Vec<(String, String, bool, Vec<u8>)>>>;
/// Blocks the first request on a route until released.
type Gate = (
    String,
    async_channel::Sender<()>,
    async_channel::Receiver<()>,
);
type Hold = Arc<Mutex<Option<Gate>>>;
struct Faux {
    options: LocalOptions,
    seen: Seen,
    handler: Arc<Mutex<Handler>>,
    hold: Hold,
    _home: Temp,
}
impl Faux {
    fn start(handler: Handler) -> Self {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
        let home = Temp::new();
        std::fs::create_dir_all(&home.0).unwrap();
        let capability = home.0.join("github-app-capability");
        std::fs::write(
            &capability,
            json!({"daemonId":"test-daemon","lineageId":"test-lineage","token":TOKEN}).to_string(),
        )
        .unwrap();
        std::fs::set_permissions(&capability, std::fs::Permissions::from_mode(0o600)).unwrap();
        let options = LocalOptions::synthetic(listener.local_addr().unwrap().port())
            .with_scope_home(home.0.clone());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let handler = Arc::new(Mutex::new(handler));
        let hold: Hold = Arc::new(Mutex::new(None));
        let (record, respond, held) = (seen.clone(), handler.clone(), hold.clone());
        std::thread::spawn(move || {
            while let Ok((mut stream, _)) = listener.accept() {
                let mut reader = std::io::BufReader::new(&mut stream);
                let mut first = String::new();
                if reader.read_line(&mut first).unwrap_or(0) == 0 {
                    continue;
                }
                let mut parts = first.split_whitespace();
                let method = parts.next().unwrap_or("").to_owned();
                let path = parts.next().unwrap_or("").to_owned();
                let (mut length, mut authorized) = (0, false);
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                        break;
                    }
                    let lower = line.to_ascii_lowercase();
                    if let Some(v) = lower.strip_prefix("content-length:") {
                        length = v.trim().parse().unwrap();
                    }
                    authorized |= lower.trim() == format!("x-pilot-github-capability: {TOKEN}");
                }
                let mut bytes = vec![0; length];
                reader.read_exact(&mut bytes).unwrap();
                let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
                record
                    .lock()
                    .unwrap()
                    .push((method.clone(), path.clone(), authorized, bytes));
                let gate = held.lock().unwrap().clone();
                if let Some((route, entered, release)) = gate
                    && path.starts_with(&route)
                {
                    let _ = entered.send_blocking(());
                    let _ = release.recv_blocking();
                }
                let reply = if path == "/api/hello" {
                    Some((
                        200,
                        json!({"daemonId":"test-daemon","lineageId":"test-lineage","protocolVersion":1,"minimumClientProtocolVersion":1,"capabilities":{"independentExecution":true}}),
                    ))
                } else {
                    (respond.lock().unwrap())(&method, &path, &body)
                };
                let Some((status, value)) = reply else {
                    continue;
                };
                let text = value.to_string();
                let _ = write!(
                    stream,
                    "HTTP/1.1 {status} x\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{text}",
                    text.len()
                );
            }
        });
        Self {
            options,
            seen,
            handler,
            hold,
            _home: home,
        }
    }
    fn set(&self, handler: Handler) {
        *self.handler.lock().unwrap() = handler;
    }
    fn requests(&self, route: &str) -> Vec<(String, bool, Vec<u8>)> {
        self.seen
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, p, ..)| p == route)
            .map(|(m, _, a, b)| (m.clone(), *a, b.clone()))
            .collect()
    }
}
fn receipt(op: &Value, state: &str) -> Value {
    let mut receipt = json!({
        "operationId":op["operationId"],"payloadHash":op["payloadHash"],
        "targetId":op["targetId"],"destination":op["destination"],"state":state
    });
    if state == "accepted" {
        receipt["result"] = json!({"sessionId":op["targetId"]});
    }
    if state == "rejected" {
        receipt["reason"] = json!("repair-create requires an ordinary Build chat");
    }
    receipt
}

async fn until(
    updates: &async_channel::Receiver<WriteState>,
    done: impl Fn(&WriteState) -> bool,
) -> WriteState {
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            let state = updates.recv().await.unwrap();
            if done(&state) {
                return state;
            }
        }
    })
    .await
    .unwrap()
}
fn settled(request: u64) -> impl Fn(&WriteState) -> bool {
    move |s| {
        s.repair
            .as_ref()
            .is_some_and(|r| r.request == request && r.outcome.is_some())
    }
}
fn start_action() -> crate::diagnostic_repair::Action {
    let proposal = ready();
    let reviewed = handoff(&handoff_json(), &proposal, &app_subject()).unwrap();
    Action::Start {
        proposal_id: PROPOSAL.into(),
        payload: start_payload(
            "spec-1",
            &proposal,
            &app_subject(),
            &reviewed,
            &available(),
            true,
        )
        .unwrap(),
    }
}
fn summary_route() -> Handler {
    Box::new(|method, path, _| {
        (method == "GET" && path == "/api/sessions/spec-1").then(|| {
            (
                200,
                summary(json!({"diagnosticRepairProposal":proposal_json()})),
            )
        })
    })
}

#[tokio::test]
async fn lost_start_ack_is_checked_and_never_duplicated() {
    let server = Faux::start(Box::new(|method, path, _| match (method, path) {
        ("GET", "/api/sessions/spec-1") => Some((
            200,
            summary(json!({"diagnosticRepairProposal":proposal_json()})),
        )),
        // The first execute loses its reply after reaching Local.
        ("POST", "/api/operations") => None,
        _ => panic!("unexpected {method} {path}"),
    }));
    let temp = Temp::new();
    let (writer, updates) = Interaction::start(server.options.clone(), Ok(temp.0.clone()));
    until(&updates, |s| s.book.is_some()).await;
    assert!(writer.command(WriteCommand::Repair {
        specialist: "spec-1".into(),
        request: 1,
        action: start_action(),
    }));
    let state = until(&updates, settled(1)).await;
    assert!(matches!(
        state.repair.unwrap().outcome,
        Some(Outcome::Unknown(_))
    ));
    let book = state.book.unwrap();
    let attempt = &book.repairs["spec-1"];
    assert_eq!(attempt.state, State::Unknown);
    let executes = server.requests("/api/operations");
    assert_eq!(executes.len(), 1);
    assert!(executes[0].1, "execute carries the native capability");
    assert_eq!(
        executes[0].2,
        serde_json::to_vec(&attempt.operation).unwrap()
    );

    // A second confirmed Start cannot create another repair while one is unconfirmed.
    assert!(writer.command(WriteCommand::Repair {
        specialist: "spec-1".into(),
        request: 2,
        action: start_action(),
    }));
    let state = until(&updates, settled(2)).await;
    assert!(matches!(
        state.repair.unwrap().outcome,
        Some(Outcome::Refused(_))
    ));
    assert_eq!(server.requests("/api/operations").len(), 1);

    // Restart: the retained start survives unchanged and nothing is sent on open.
    assert!(writer.command(WriteCommand::Close));
    until(&updates, |s| s.flushed).await;
    drop(writer);
    let reopened = Store::open(temp.0.clone(), server.options.host()).unwrap();
    assert!(reopened.book.repairs["spec-1"] == *attempt);
    drop(reopened);
    let (writer, updates) = Interaction::start(server.options.clone(), Ok(temp.0.clone()));
    until(&updates, |s| s.book.is_some()).await;
    assert_eq!(server.requests("/api/operations").len(), 1);

    // Explicit Check: Local has no record, so the same bytes are sent once, then accepted.
    let op = serde_json::to_value(&attempt.operation).unwrap();
    let once = op.clone();
    server.set(Box::new(move |method, path, body| match (method, path) {
        ("POST", "/api/operations/receipt") => {
            assert_eq!(body, &once);
            Some((200, json!({"state":"unknown"})))
        }
        ("POST", "/api/operations") => {
            assert_eq!(body, &once);
            Some((200, receipt(&once, "accepted")))
        }
        _ => panic!("unexpected {method} {path}"),
    }));
    assert!(writer.command(WriteCommand::Repair {
        specialist: "spec-1".into(),
        request: 3,
        action: Action::Check,
    }));
    let state = until(&updates, settled(3)).await;
    assert_eq!(
        state.repair.unwrap().outcome,
        Some(Outcome::Accepted(attempt.operation.target_id.clone()))
    );
    assert_eq!(state.book.unwrap().repairs["spec-1"].state, State::Accepted);
    let lookups = server.requests("/api/operations/receipt");
    assert_eq!(lookups.len(), 1);
    assert!(!lookups[0].1, "lookup needs no capability");
    let executes = server.requests("/api/operations");
    assert_eq!(executes.len(), 2);
    assert_eq!(executes[0].2, executes[1].2, "the same immutable bytes");

    // A settled start answers Check locally, with no further request.
    assert!(writer.command(WriteCommand::Repair {
        specialist: "spec-1".into(),
        request: 4,
        action: Action::Check,
    }));
    until(&updates, settled(4)).await;
    assert_eq!(server.requests("/api/operations").len(), 2);
    assert_eq!(server.requests("/api/operations/receipt").len(), 1);
    assert!(writer.command(WriteCommand::Close));
    until(&updates, |s| s.flushed).await;
}

#[tokio::test]
async fn setup_writes_once_then_reads_review_again() {
    let put = Arc::new(Mutex::new(Vec::new()));
    let seen = put.clone();
    let server = Faux::start(Box::new(move |method, path, body| match (method, path) {
        ("PUT", "/api/diagnostics/repair-project") => {
            seen.lock().unwrap().push(body.clone());
            Some((
                200,
                json!({"state":"available","revision":1,"binding":binding_json()}),
            ))
        }
        ("GET", "/api/diagnostics/repair-project") => Some((
            200,
            json!({"state":"available","revision":1,"binding":binding_json()}),
        )),
        ("POST", p) if p.starts_with("/api/sessions/spec-1/diagnostics/handoff?") => {
            assert_eq!(
                p,
                "/api/sessions/spec-1/diagnostics/handoff?hostId=local&daemonId=test-daemon&lineageId=test-lineage"
            );
            assert_eq!(body, &review_request(&ready(), &app_subject()));
            Some((200, handoff_json()))
        }
        _ => panic!("unexpected {method} {path}"),
    }));
    let project = crate::local_model::projects(
        &json!([{"id":"pilot-src","name":"Pilot","path":"/src/pilot"}]),
    )
    .unwrap()
    .remove(0);
    let client = crate::chat_settings::client().unwrap();
    let (review, error) = run(
        &client,
        &server.options,
        Job {
            specialist: "spec-1".into(),
            proposal: ready(),
            subject: app_subject(),
            configure: Some((0, project)),
        },
    )
    .await;
    assert_eq!(error, None);
    assert_eq!(
        *put.lock().unwrap(),
        [
            json!({"expectedRevision":0,"host":local_host(),"projectId":"pilot-src","path":"/src/pilot","origin":PILOT_ORIGIN})
        ]
    );
    let writes = server.requests("/api/diagnostics/repair-project");
    assert!(
        writes.iter().all(|(_, authorized, _)| *authorized),
        "native capability on every setup request"
    );
    assert_eq!(writes.iter().filter(|(m, ..)| m == "PUT").count(), 1);
    assert_eq!(review.handoff.unwrap().title, "Fix stalled tool 日本語");
    assert!(matches!(
        review.project.unwrap().state,
        ProjectState::Available(_)
    ));
    assert!(review.checkouts.is_none());
}

#[tokio::test]
async fn receipts_are_adopted_only_when_exact() {
    let op = Operation {
        schema_version: 1,
        operation_id: "op".into(),
        producer_id: "p".into(),
        sequence: 1,
        origin: LocalOptions::synthetic(1).host(),
        destination: LocalOptions::synthetic(1).host(),
        kind: "repair-create".into(),
        target_id: "target".into(),
        payload: "{}".into(),
        payload_hash: crate::delivery_store::hash("{}"),
    };
    let value = serde_json::to_value(&op).unwrap();
    assert_eq!(adopt(&op, &receipt(&value, "pending")), Outcome::Pending);
    assert_eq!(
        adopt(&op, &receipt(&value, "accepted")),
        Outcome::Accepted("target".into())
    );
    assert!(matches!(
        adopt(&op, &receipt(&value, "rejected")),
        Outcome::Rejected(_)
    ));
    for (field, wrong) in [
        ("operationId", json!("other")),
        ("payloadHash", json!("0")),
        ("targetId", json!("other")),
        (
            "destination",
            json!({"hostId":"local","daemonId":"x","lineageId":"y"}),
        ),
    ] {
        let mut changed = receipt(&value, "accepted");
        changed[field] = wrong;
        assert!(
            matches!(adopt(&op, &changed), Outcome::Unknown(_)),
            "{field}"
        );
    }
    let mut other = receipt(&value, "accepted");
    other["result"]["sessionId"] = json!("someone-else");
    assert!(matches!(adopt(&op, &other), Outcome::Unknown(_)));
}

#[tokio::test]
async fn stale_proposal_is_refused_before_anything_is_saved() {
    let server = Faux::start(Box::new(|method, path, _| match (method, path) {
        ("GET", "/api/sessions/spec-1") => {
            let mut changed = proposal_json();
            changed["id"] = json!("diagnostic-proposal:v1:99999999-1234-4234-8234-123456789abc");
            Some((200, summary(json!({"diagnosticRepairProposal":changed}))))
        }
        _ => panic!("unexpected {method} {path}"),
    }));
    let temp = Temp::new();
    let (writer, updates) = Interaction::start(server.options.clone(), Ok(temp.0.clone()));
    until(&updates, |s| s.book.is_some()).await;
    assert!(writer.command(WriteCommand::Repair {
        specialist: "spec-1".into(),
        request: 1,
        action: start_action(),
    }));
    let state = until(&updates, settled(1)).await;
    assert!(matches!(
        state.repair.unwrap().outcome,
        Some(Outcome::Refused(_))
    ));
    assert!(state.book.unwrap().repairs.is_empty());
    assert!(server.requests("/api/operations").is_empty());
    assert!(writer.command(WriteCommand::Close));
    until(&updates, |s| s.flushed).await;
}

#[tokio::test]
async fn drafts_autosave_while_the_start_is_held_and_close_keeps_it_unconfirmed() {
    let server = Faux::start(summary_route());
    let (entered, arrived) = async_channel::bounded(1);
    let (release, released) = async_channel::bounded(1);
    *server.hold.lock().unwrap() = Some(("/api/operations".into(), entered, released));
    server.set(Box::new(|method, path, body| match (method, path) {
        ("GET", "/api/sessions/spec-1") => Some((
            200,
            summary(json!({"diagnosticRepairProposal":proposal_json()})),
        )),
        ("POST", "/api/operations") => Some((200, receipt(body, "accepted"))),
        _ => panic!("unexpected {method} {path}"),
    }));
    let temp = Temp::new();
    let (writer, updates) = Interaction::start(server.options.clone(), Ok(temp.0.clone()));
    until(&updates, |s| s.book.is_some()).await;
    assert!(writer.command(WriteCommand::Repair {
        specialist: "spec-1".into(),
        request: 1,
        action: start_action(),
    }));
    tokio::time::timeout(std::time::Duration::from_secs(5), arrived.recv())
        .await
        .unwrap()
        .unwrap();
    // The start was saved before its POST, and typing keeps saving while HTTP waits.
    let draft = Draft {
        revision: 4,
        text: "Unsent 日本語 e\u{301} 🦀".into(),
        ..Default::default()
    };
    assert!(writer.edit("chat:spec-1".into(), draft.clone()));
    let saved = until(&updates, |s| {
        s.book
            .as_ref()
            .is_some_and(|b| b.drafts.get("chat:spec-1").is_some_and(|d| d.revision == 4))
    })
    .await;
    assert!(saved.book.unwrap().repairs["spec-1"].open());
    // Close while held: the latest text is flushed and the start stays unconfirmed.
    let mut latest = draft.clone();
    latest.revision = 5;
    latest.text = "Latest before Close".into();
    assert!(writer.edit("chat:spec-1".into(), latest.clone()));
    assert!(writer.command(WriteCommand::Close));
    until(&updates, |s| s.flushed).await;
    drop(writer);
    drop(updates);
    let reopened = Store::open(temp.0.clone(), server.options.host()).unwrap();
    assert_eq!(reopened.book.drafts["chat:spec-1"].text, latest.text);
    assert_eq!(reopened.book.repairs["spec-1"].state, State::Unknown);
    let _ = release.send(()).await;
}
