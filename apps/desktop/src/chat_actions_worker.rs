//! Bounded off-UI Local HTTP. A dispatched archive/restore is never retried.
use crate::{
    LocalOptions,
    chat_actions::{Action, Evidence, Failure, Outcome, Target},
};
use serde_json::Value;
use std::time::Duration;

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
            return Outcome::Rejected(
                "Chat eligibility changed. Reopen its menu. Nothing was submitted.",
            );
        }
        Err(error) => return Outcome::Rejected(error),
    };
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
            .send()
            .await;
        let Ok(response) = response else {
            return Outcome::Unknown;
        };
        return match response.status() {
            reqwest::StatusCode::OK => Outcome::Acknowledged,
            reqwest::StatusCode::CONFLICT => Outcome::Rejected(
                "This chat cannot retry its startup now. Check Local and try again.",
            ),
            _ => Outcome::Unknown,
        };
    }
    if !current.can_archive {
        return Outcome::Rejected(
            "Chat eligibility changed. Reopen its menu. Nothing was submitted.",
        );
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
