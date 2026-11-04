//! Bounded off-UI Local HTTP. A dispatched archive/restore/retry is never repeated.
use crate::{
    LocalOptions,
    chat_actions::{Action, Evidence, Failure, Outcome, Target},
};
use serde_json::Value;
use std::time::Duration;

/// Retries wait for pilotd to start a worker before answering.
const RETRY_DEADLINE: Duration = Duration::from_secs(60);

enum Request {
    Inspect(Target, async_channel::Sender<Result<Evidence, Failure>>),
    Set(Evidence, Action, async_channel::Sender<Outcome>),
}
pub(crate) struct Worker {
    commands: async_channel::Sender<Request>,
}
impl Drop for Worker {
    fn drop(&mut self) {
        self.commands.close();
    }
}
impl Worker {
    pub(crate) fn start(options: LocalOptions) -> Result<Self, Failure> {
        let (commands, rx) = async_channel::bounded(1);
        std::thread::Builder::new()
            .name("local-chat-actions".into())
            .spawn(move || {
                let _close = Close(rx.clone());
                let Ok(rt) = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                else {
                    return;
                };
                rt.block_on(async move {
                    let Ok(client) = client() else {
                        return;
                    };
                    while let Ok(request) = rx.recv().await {
                        match request {
                            Request::Inspect(target, reply) => {
                                let _ = reply.try_send(inspect(&client, &options, &target).await);
                            }
                            Request::Set(evidence, action, reply) => {
                                let _ =
                                    reply.try_send(set(&client, &options, &evidence, action).await);
                            }
                        }
                    }
                });
            })
            .map_err(|_| "Chat actions worker is unavailable.")?;
        Ok(Self { commands })
    }
    pub(crate) fn inspect(
        &self,
        target: Target,
    ) -> Result<async_channel::Receiver<Result<Evidence, Failure>>, Failure> {
        let (tx, rx) = async_channel::bounded(1);
        self.commands
            .try_send(Request::Inspect(target, tx))
            .map_err(|_| "Chat actions are busy or unavailable. Reopen the menu.")?;
        Ok(rx)
    }
    pub(crate) fn set(
        &self,
        evidence: Evidence,
        action: Action,
    ) -> Result<async_channel::Receiver<Outcome>, Failure> {
        let (tx, rx) = async_channel::bounded(1);
        self.commands
            .try_send(Request::Set(evidence, action, tx))
            .map_err(|_| "Chat actions are busy or unavailable. Nothing was submitted.")?;
        Ok(rx)
    }
}
struct Close(async_channel::Receiver<Request>);
impl Drop for Close {
    fn drop(&mut self) {
        self.0.close();
    }
}
pub(crate) fn client() -> Result<reqwest::Client, Failure> {
    reqwest::Client::builder()
        .no_proxy()
        .retry(reqwest::retry::never())
        .redirect(reqwest::redirect::Policy::none())
        .pool_max_idle_per_host(1)
        .connect_timeout(Duration::from_secs(2))
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|_| "Chat actions transport is unavailable.")
}
async fn body(mut response: reqwest::Response) -> Result<Value, Failure> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Chat response interrupted.")?
    {
        if bytes.len() + chunk.len() > 256 * 1024 {
            return Err("Chat response exceeds its limit.");
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "Chat response is malformed.")
}
pub(crate) async fn inspect(
    client: &reqwest::Client,
    options: &LocalOptions,
    target: &Target,
) -> Result<Evidence, Failure> {
    if !target.matches(options) {
        return Err("The exact Local chat home is unavailable.");
    }
    let hello = crate::local_client::hello(client, options).await?;
    let response = client
        .get(format!(
            "{}/api/sessions/{}",
            options.loopback(),
            target.chat.id
        ))
        .send()
        .await
        .map_err(|_| "This Local chat is unavailable.")?;
    if response.status() != reqwest::StatusCode::OK {
        return Err("This Local chat is unavailable.");
    }
    Evidence::read(
        target,
        &body(response).await?,
        hello["capabilities"]["guardedMissionConversion"] == true,
    )
}
pub(crate) async fn set(
    client: &reqwest::Client,
    options: &LocalOptions,
    evidence: &Evidence,
    action: Action,
) -> Outcome {
    let current = match inspect(client, options, &evidence.target).await {
        Ok(current) if &current == evidence => current,
        Ok(_) => {
            return Outcome::Rejected(crate::chat_actions::INELIGIBLE);
        }
        Err(error) => return Outcome::Rejected(error),
    };
    if let Action::RetryTurn(entry) = action {
        // pilotd forks a new attempt and sends the failed turn's user message
        // itself. Nothing is reposted by this client, and an unconfirmed POST
        // is never repeated.
        if !current.can_retry_turn {
            return Outcome::Rejected(
                "This failure can no longer be retried here. Nothing was resent.",
            );
        }
        let response = client
            .post(format!(
                "{}/api/sessions/{}/rewind",
                options.loopback(),
                current.target.chat.id
            ))
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(serde_json::json!({"action":"retry","entryId":entry}).to_string())
            .timeout(RETRY_DEADLINE)
            .send()
            .await;
        let Ok(response) = response else {
            return Outcome::Unknown;
        };
        // Only request validation precedes every change. A conflict can follow
        // the attempt switch (the resend is a separate admission), so it is
        // not proof that nothing happened.
        return match response.status() {
            reqwest::StatusCode::OK => match body(response).await {
                Ok(value) if value["session"]["id"] == current.target.chat.id => {
                    Outcome::Acknowledged
                }
                _ => Outcome::Unknown,
            },
            reqwest::StatusCode::BAD_REQUEST | reqwest::StatusCode::NOT_FOUND => {
                Outcome::Rejected("Local refused this retry. Nothing was resent.")
            }
            _ => Outcome::Unknown,
        };
    }
    if action == Action::Retry {
        // The daemon reloads the worker with the existing outbox. It is never resent.
        if !current.can_retry_startup {
            return Outcome::Rejected(
                "This chat has no retryable startup failure. Reopen its menu.",
            );
        }
        let response = client
            .post(format!(
                "{}/api/sessions/{}/retry-startup",
                options.loopback(),
                current.target.chat.id
            ))
            .timeout(RETRY_DEADLINE)
            .send()
            .await;
        let Ok(response) = response else {
            return Outcome::Unknown;
        };
        return match response.status() {
            reqwest::StatusCode::OK => Outcome::Acknowledged,
            reqwest::StatusCode::CONFLICT => {
                Outcome::Rejected("This chat can't restart right now. Try again in a moment.")
            }
            _ => Outcome::Unknown,
        };
    }
    if action == Action::RerunSetup {
        return rerun_setup(client, options, &current).await;
    }
    if action == Action::RetryHandoff {
        return retry_handoff(client, options, &current).await;
    }
    if !current.can_archive {
        return Outcome::Rejected(crate::chat_actions::INELIGIBLE);
    }
    let route = if current.archive {
        "archive"
    } else {
        "restore"
    };
    let response = client
        .post(format!(
            "{}/api/sessions/{}/{route}",
            options.loopback(),
            current.target.chat.id
        ))
        .send()
        .await;
    // Errors may follow save/emit/cleanup. GET/WS is not a mutation receipt.
    let Ok(response) = response else {
        return Outcome::Unknown;
    };
    if response.status() != reqwest::StatusCode::OK {
        return Outcome::Unknown;
    }
    let Ok(value) = body(response).await else {
        return Outcome::Unknown;
    };
    if value["id"] != current.target.chat.id
        || (!value["projectId"].is_null() && !value["projectId"].is_string())
        || value
            .get("projectId")
            .filter(|v| !v.is_null())
            .and_then(Value::as_str)
            != current.target.chat.project_id.as_deref()
        || (!value["control"].is_null() && value["control"] != false)
        || (if current.archive {
            !value["archivedAt"].is_u64()
        } else {
            !value["archivedAt"].is_null()
        })
    {
        return Outcome::Unknown;
    }
    Outcome::Acknowledged
}
/// One fresh run after a failed automatic handoff. pilotd admits a single input
/// named by a new operation ID; nothing earlier is resent. Only its eligibility
/// refusal (409) and an unknown chat (404) precede any change, so every other
/// answer stays Unknown and is never repeated.
async fn retry_handoff(
    client: &reqwest::Client,
    options: &LocalOptions,
    current: &Evidence,
) -> Outcome {
    if !current.can_retry_handoff {
        return Outcome::Rejected("This failure can no longer be retried here. Nothing was sent.");
    }
    let operation = uuid::Uuid::new_v4().to_string();
    let response = client
        .post(format!(
            "{}/api/sessions/{}/retry-handoff",
            options.loopback(),
            current.target.chat.id
        ))
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(serde_json::json!({ "operationId": operation }).to_string())
        .timeout(RETRY_DEADLINE)
        .send()
        .await;
    let Ok(response) = response else {
        return Outcome::Unknown;
    };
    match response.status() {
        reqwest::StatusCode::OK => match body(response).await {
            Ok(value) if value["id"] == current.target.chat.id => Outcome::Acknowledged,
            _ => Outcome::Unknown,
        },
        reqwest::StatusCode::CONFLICT | reqwest::StatusCode::NOT_FOUND => {
            Outcome::Rejected("Local refused this retry. Nothing was sent.")
        }
        _ => Outcome::Unknown,
    }
}
/// Queue setup again with native authority. pilotd checks idleness, Automations and
/// the workspace before queueing; refusals (403/404/409/503) changed nothing.
async fn rerun_setup(
    client: &reqwest::Client,
    options: &LocalOptions,
    current: &Evidence,
) -> Outcome {
    const UNAUTHORIZED: Failure = "Pilot couldn't authorize this on Local. Nothing was started.";
    if !current.can_rerun_setup {
        return Outcome::Rejected(
            "Setup can run again only while this chat is idle. Nothing was started.",
        );
    }
    let Ok(capability) = options.model_scope_capability() else {
        return Outcome::Rejected(UNAUTHORIZED);
    };
    let Ok(mut header) = reqwest::header::HeaderValue::from_str(&capability) else {
        return Outcome::Rejected(UNAUTHORIZED);
    };
    header.set_sensitive(true);
    let response = client
        .post(format!(
            "{}/api/sessions/{}/setup",
            options.loopback(),
            current.target.chat.id
        ))
        .header("x-pilot-github-capability", header)
        .timeout(RETRY_DEADLINE)
        .send()
        .await;
    let Ok(response) = response else {
        return Outcome::Unknown;
    };
    match response.status().as_u16() {
        202 => match body(response).await {
            Ok(value) if value["id"] == current.target.chat.id => Outcome::Acknowledged,
            _ => Outcome::Unknown,
        },
        403 => Outcome::Rejected(UNAUTHORIZED),
        404 => Outcome::Rejected(
            "Local didn't start setup. Check that automations are on in Settings → Chats.",
        ),
        409 => Outcome::Rejected(
            "Local can't run setup now: the chat must be idle, with no setup running and setup hooks on. Nothing was started.",
        ),
        503 => Outcome::Rejected("Local can't run setup right now. Nothing was started."),
        _ => Outcome::Unknown,
    }
}
