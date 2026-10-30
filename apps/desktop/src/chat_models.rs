//! Scoped Local catalog and explicit idle-only selection, plus the explicit
//! subscription-limit Force work and continue-model actions. Never spawn/send.
use crate::{
    LocalOptions,
    delivery_store::{Failure, Store, token},
    local_client::gate,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

fn text(s: &str, cap: usize) -> bool {
    !s.is_empty() && s.len() <= cap && !s.chars().any(|c| c < ' ' || c == '\u{7f}')
}
pub(crate) fn model_id(s: &str) -> bool {
    text(s, 1024)
        && s.split_once('/')
            .is_some_and(|(p, m)| !p.is_empty() && !m.is_empty())
}
fn level(s: &str) -> bool {
    text(s, 64)
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Choice {
    pub(crate) model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) thinking: Option<String>,
}
impl Choice {
    pub(crate) fn validate(&self) -> Result<(), Failure> {
        if !model_id(&self.model) || self.thinking.as_deref().is_some_and(|s| !level(s)) {
            Err("Model/thinking choice is malformed.")
        } else {
            Ok(())
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DraftChoice {
    pub(crate) project_id: String,
    pub(crate) cwd: String,
    pub(crate) choice: Choice,
}
impl DraftChoice {
    pub(crate) fn validate(&self) -> Result<(), Failure> {
        if !token(&self.project_id) || !cwd(&self.cwd) {
            return Err("Model choice has an invalid project scope.");
        }
        self.choice.validate()
    }
}
fn cwd(s: &str) -> bool {
    s.starts_with('/') && s.len() <= 4096 && !s.contains('\0')
}
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Model {
    #[serde(skip)]
    pub(crate) search_key: String,
    pub(crate) id: String,
    pub(crate) provider: String,
    pub(crate) name: String,
    #[serde(default)]
    pub(crate) thinking_levels: Vec<String>,
    pub(crate) thinking: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Catalog {
    pub(crate) models: Vec<Model>,
    pub(crate) default_model: Option<String>,
}
impl Catalog {
    pub(crate) fn validate(&self) -> Result<(), Failure> {
        let mut ids = std::collections::HashSet::new();
        if self.models.len() > 2048
            || self
                .default_model
                .as_deref()
                .is_some_and(|s| !text(s, 1024))
            || self.models.iter().any(|m| {
                !model_id(&m.id)
                    || !text(&m.provider, 256)
                    || !m.id.starts_with(&format!("{}/", m.provider))
                    || !text(&m.name, 1024)
                    || !ids.insert(&m.id)
                    || m.thinking_levels.len() > 16
                    || m.thinking_levels.iter().any(|l| !level(l))
                    || m.thinking
                        .as_deref()
                        .is_some_and(|l| !level(l) || !m.thinking_levels.iter().any(|v| v == l))
                    || m.thinking_levels
                        .iter()
                        .collect::<std::collections::HashSet<_>>()
                        .len()
                        != m.thinking_levels.len()
            })
        {
            Err(
                "Scoped model catalog is malformed or exceeds the bounded reader. No unscoped fallback.",
            )
        } else {
            Ok(())
        }
    }
    pub(crate) fn admits(&self, choice: &Choice) -> bool {
        choice.validate().is_ok()
            && self.models.iter().any(|m| {
                m.id == choice.model
                    && choice
                        .thinking
                        .as_ref()
                        .is_none_or(|l| m.thinking_levels.contains(l))
            })
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct FailedSource {
    pub(crate) token: String,
    pub(crate) source: String,
}
impl FailedSource {
    fn valid(&self) -> bool {
        self.token.len() == 64
            && self
                .token
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
            && matches!(self.source.as_str(), "startup" | "outcome")
    }
    fn read(v: &Value) -> Option<Self> {
        serde_json::from_value::<Self>(v.clone())
            .ok()
            .filter(Self::valid)
    }
}
fn failure_source(v: &Value) -> Option<FailedSource> {
    (v["state"] == "failed" || v["outcome"] == "failed")
        .then(|| FailedSource::read(&v["failedModelSource"]))
        .flatten()
}
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub(crate) struct SessionModel {
    pub(crate) diagnostics: bool,
    pub(crate) model: Option<String>,
    pub(crate) thinking: Option<String>,
    pub(crate) updated_at: u64,
    pub(crate) failed_source: Option<FailedSource>,
    pub(crate) allowed: bool,
    pub(crate) blocked: Option<&'static str>,
    /// pilotd's subscription hold (or forced work past it), as reported.
    pub(crate) pause: Option<crate::subscription_pause::Pause>,
    /// pilotd accepts continue-model: an interactive, healthy chat under an unforced pause.
    pub(crate) continuable: bool,
}
/// A held chat changes model only through the explicit continuation.
pub(crate) const PAUSED: &str =
    "This chat is paused at a subscription limit. Continue with another model or force work.";
/// Routine while a chat works. Shown in context (model/thinking tooltip and menu), not as a notice.
pub(crate) const BUSY: &str =
    "Model and thinking can change after this chat's work and queued messages finish.";
impl SessionModel {
    pub(crate) fn read(v: &Value) -> Self {
        let next = &v["nextAttemptModel"];
        let choice = if next.is_object() { next } else { v };
        let pause = crate::subscription_pause::Pause::read(v);
        let failed = v["state"] == "failed" || v["outcome"] == "failed" || !v["failure"].is_null();
        Self {
            diagnostics: v["role"] == "diagnostics",
            continuable: pause.as_ref().is_some_and(|p| !p.forced)
                && crate::local_model::interactive_local(v)
                && v["continuationPending"] != true
                && !failed
                && v["sleepPaused"] != true
                && v["offlinePaused"] != true,
            pause,
            failed_source: failure_source(v),
            model: choice["model"]
                .as_str()
                .filter(|s| model_id(s))
                .map(str::to_owned),
            thinking: choice["thinking"]
                .as_str()
                .filter(|s| level(s))
                .map(str::to_owned),
            updated_at: v["updatedAt"].as_u64().unwrap_or(0),
            allowed: Self::restriction(v).is_none(),
            blocked: Self::restriction(v),
        }
    }
    // Summary state is kernelState, not an admission capability. With no worker
    // (or a stopped recovery) it is parked. changeModel explicitly reopens it.
    // Worker/inbox/configuration races remain authoritative at POST admission.
    fn restriction(v: &Value) -> Option<&'static str> {
        if !crate::local_model::interactive_local(v) || v["continuationPending"] == true {
            Some("Model changes are unavailable for this read-only chat or ownership transfer.")
        } else if (v["state"] == "failed" || v["outcome"] == "failed" || !v["failure"].is_null())
            && failure_source(v).is_none()
        {
            Some(
                "This failure does not support a safe next-attempt model save. It has not been retried.",
            )
        } else if !v["subscriptionPause"].is_null() && v["subscriptionPause"]["forced"] != true {
            // Forced work is not held, so the ordinary idle-only change applies.
            Some(PAUSED)
        } else if v["sleepPaused"] == true || v["offlinePaused"] == true {
            Some(
                "Model changes are unavailable while this chat is paused for sleep or connectivity.",
            )
        } else if v["working"] == true
            || matches!(v["state"].as_str(), Some("working" | "starting"))
            || v["runningJobs"]
                .as_array()
                .is_some_and(|jobs| !jobs.is_empty())
        {
            Some(BUSY)
        } else if failure_source(v).is_some() {
            None
        } else if !matches!(v["state"].as_str(), Some("idle" | "parked")) {
            Some(
                "The chat's idle state is not known. Refresh before changing its model or thinking.",
            )
        } else {
            None
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Target {
    pub(crate) session: String,
    pub(crate) cwd: String,
    pub(crate) model: Option<String>,
    pub(crate) thinking: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) failed_source: Option<FailedSource>,
}
impl Target {
    pub(crate) fn validate(&self) -> Result<(), Failure> {
        if self.failed_source.as_ref().is_some_and(|s| !s.valid())
            || !token(&self.session)
            || !cwd(&self.cwd)
            || self.model.as_deref().is_some_and(|m| !model_id(m))
            || self.thinking.as_deref().is_some_and(|m| !level(m))
        {
            Err("Invalid captured Local model target.")
        } else {
            Ok(())
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Attempt {
    pub(crate) id: String,
    pub(crate) target: Target,
    pub(crate) choice: Choice,
}
impl Attempt {
    pub(crate) fn validate(&self, source: &str) -> Result<(), Failure> {
        self.target.validate()?;
        self.choice.validate()?;
        if !token(&self.id) || source != self.target.session {
            Err("Retained model switch ownership is invalid.")
        } else {
            Ok(())
        }
    }
}
pub(crate) enum Action {
    Submit(Attempt),
    Inspect(Target),
    Acknowledge {
        session: String,
        id: String,
    },
    /// POST subscription-force: Force work past the limit, or Pause at limit again.
    Force {
        target: Target,
        force: bool,
    },
    /// POST continue-model. Retained like a model switch until acknowledged.
    Continue(Attempt),
}
#[derive(Clone)]
pub(crate) enum Outcome {
    Pending,
    Refused(Failure),
    Unknown(Failure),
    Acknowledged(SessionModel),
    Observed(SessionModel),
    Dismissed(SessionModel),
    /// Work moved to another provider's new chat. The source chat is now read-only.
    Continued(Box<crate::local_model::Chat>),
}
#[derive(Clone)]
pub(crate) struct Reply {
    pub(crate) session: String,
    pub(crate) request: u64,
    pub(crate) outcome: Outcome,
}

async fn body(mut response: reqwest::Response) -> Result<Value, Failure> {
    const CAP: usize = 2 * 1024 * 1024;
    if response.content_length().is_some_and(|n| n > CAP as u64) {
        return Err("Model response exceeds the bounded reader limit.");
    }
    let mut bytes = Vec::new();
    while let Some(c) = response
        .chunk()
        .await
        .map_err(|_| "Model response interrupted.")?
    {
        if bytes.len() + c.len() > CAP {
            return Err("Model response exceeds the bounded reader limit.");
        }
        bytes.extend_from_slice(&c);
    }
    serde_json::from_slice(&bytes).map_err(|_| "Model response is malformed.")
}
async fn post(
    client: &reqwest::Client,
    options: &LocalOptions,
    session: &str,
    route: &str,
    payload: &Value,
) -> Result<reqwest::Response, ()> {
    let bytes = serde_json::to_vec(payload).map_err(|_| ())?;
    client
        .post(format!(
            "{}/api/sessions/{session}/{route}",
            options.loopback()
        ))
        .header("Content-Type", "application/json")
        .body(bytes)
        .send()
        .await
        .map_err(|_| ())
}
/// One subscription-force POST after a fresh identity read. Setting the same value
/// again is harmless, so a lost reply is reported, never resent.
async fn force(
    client: &reqwest::Client,
    options: &LocalOptions,
    target: &Target,
    value: bool,
) -> Outcome {
    let current = match session(client, options, target).await {
        Ok(s) => s,
        Err(e) => return Outcome::Refused(e),
    };
    if current.pause.as_ref().is_none_or(|p| p.forced == value) {
        return Outcome::Observed(current);
    }
    let response = post(
        client,
        options,
        &target.session,
        "subscription-force",
        &serde_json::json!({ "force": value }),
    )
    .await;
    match response {
        Ok(r) if r.status() == reqwest::StatusCode::OK => match body(r).await {
            Ok(v) if v["id"] == target.session && v["cwd"] == target.cwd => {
                Outcome::Acknowledged(SessionModel::read(&v))
            }
            _ => Outcome::Unknown(
                "Couldn't confirm the change. Nothing was resent; this chat updates when Local reports it.",
            ),
        },
        Ok(r) if r.status().is_client_error() => Outcome::Refused(
            "Local refused the change. This chat may be archived, continued or changing its model.",
        ),
        _ => Outcome::Unknown(
            "Couldn't confirm the change. Nothing was resent; this chat updates when Local reports it.",
        ),
    }
}
/// One continue-model POST, retained like a model switch so a lost reply fences
/// Send until it is inspected. A refusal (4xx) changed nothing and settles it.
async fn continue_model(
    client: &reqwest::Client,
    options: &LocalOptions,
    store: &mut Store,
    attempt: Attempt,
    prepared: impl FnOnce(&Store),
) -> Outcome {
    let target = &attempt.target;
    let pre = async {
        attempt.validate(&target.session)?;
        let current = session(client, options, target).await?;
        if !current.continuable || current.model != target.model {
            return Err("This chat is no longer held at a usage limit, or its model changed. Nothing was continued.");
        }
        if !catalog(client, options, &target.cwd).await?.admits(&attempt.choice) {
            return Err("This model is no longer in this chat's scope. Refresh models.");
        }
        store.prepare_model_change(attempt.clone())
    }
    .await;
    if let Err(e) = pre {
        return Outcome::Refused(e);
    }
    prepared(store);
    let payload = serde_json::to_value(&attempt.choice).expect("serializable choice");
    let lost = "Couldn't confirm the continuation. Nothing was resent; inspect this chat before acting again.";
    let value = match post(client, options, &target.session, "continue-model", &payload).await {
        Ok(r) if r.status() == reqwest::StatusCode::OK => match body(r).await {
            Ok(v) => v,
            Err(_) => return Outcome::Unknown(lost),
        },
        Ok(r) if r.status().is_client_error() => {
            let _ = store.finish_model_change(&target.session, &attempt.id);
            return Outcome::Refused(
                "Local couldn't continue this chat now. It may be busy, running jobs or no longer paused. Nothing changed.",
            );
        }
        _ => return Outcome::Unknown(lost),
    };
    if value["id"] == target.session {
        let actual = SessionModel::read(&value);
        if value["cwd"] != target.cwd || actual.model.as_deref() != Some(&attempt.choice.model) {
            return Outcome::Unknown(lost);
        }
        let _ = store.finish_model_change(&target.session, &attempt.id);
        return Outcome::Acknowledged(actual);
    }
    match crate::local_model::chat(&value) {
        Some(next) => {
            let _ = store.finish_model_change(&target.session, &attempt.id);
            Outcome::Continued(Box::new(next))
        }
        None => Outcome::Unknown(lost),
    }
}
pub(crate) async fn catalog(
    client: &reqwest::Client,
    options: &LocalOptions,
    path: &str,
) -> Result<Catalog, Failure> {
    if !cwd(path) {
        return Err("Choose an exact Local project/chat directory before loading models.");
    }
    read_gate(client, options).await?;
    let r = client
        .get(format!("{}/api/models", options.loopback()))
        .query(&[("cwd", path)])
        .send()
        .await
        .map_err(|_| CATALOG_INTERRUPTED)?;
    if r.status() != reqwest::StatusCode::OK {
        return Err("Scoped models unavailable for this Local directory.");
    }
    let mut c: Catalog =
        serde_json::from_value(body(r).await?).map_err(|_| "Scoped model catalog is malformed.")?;
    c.validate()?;
    for m in &mut c.models {
        m.search_key = format!("{} {}", m.name, m.id).to_lowercase();
    }
    Ok(c)
}
pub(crate) async fn session(
    client: &reqwest::Client,
    options: &LocalOptions,
    target: &Target,
) -> Result<SessionModel, Failure> {
    target.validate()?;
    read_gate(client, options).await?;
    let r = client
        .get(format!(
            "{}/api/sessions/{}",
            options.loopback(),
            target.session
        ))
        .send()
        .await
        .map_err(|_| SESSION_INTERRUPTED)?;
    if r.status() != reqwest::StatusCode::OK {
        return Err("Local chat model is unavailable.");
    }
    let v = body(r).await?;
    if v["id"] != target.session || v["cwd"] != target.cwd {
        return Err("Local chat identity or directory changed. Reopen the exact chat.");
    }
    Ok(SessionModel::read(&v))
}

const CONNECTION_INTERRUPTED: &str =
    "Couldn't check the Local connection for models. Retry models or reconnect.";
const CATALOG_INTERRUPTED: &str = "Couldn't load scoped models. Refresh to try again.";
const SESSION_INTERRUPTED: &str = "Local chat model could not be checked.";

pub(crate) fn interrupted_read(error: &str) -> bool {
    matches!(
        error,
        CONNECTION_INTERRUPTED
            | CATALOG_INTERRUPTED
            | SESSION_INTERRUPTED
            | "Model response interrupted."
    )
}

/// A failed hello request is not evidence that the independently connected daemon stopped.
pub(crate) async fn read_gate(
    client: &reqwest::Client,
    options: &LocalOptions,
) -> Result<(), Failure> {
    gate(client, options).await.map_err(|error| match error {
        "Local read failed. Check that Pilot is running." | "Local response interrupted" => {
            CONNECTION_INTERRUPTED
        }
        _ => error, // Identity/protocol refusals remain explicit, and are never retried.
    })
}
pub(crate) async fn execute(
    client: &reqwest::Client,
    options: &LocalOptions,
    store: &mut Store,
    action: Action,
    prepared: impl FnOnce(&Store),
) -> Outcome {
    match action {
        Action::Force {
            target,
            force: value,
        } => force(client, options, &target, value).await,
        Action::Continue(attempt) => {
            continue_model(client, options, store, attempt, prepared).await
        }
        Action::Inspect(target) => match session(client, options, &target).await {
            Ok(s) => Outcome::Observed(s),
            Err(e) => Outcome::Refused(e),
        },
        Action::Acknowledge {
            session: source,
            id,
        } => {
            let target = match store.book.model_changes.get(&source).filter(|a| a.id == id) {
                Some(a) => a.target.clone(),
                None => {
                    return Outcome::Refused(
                        "Model switch ownership changed. Nothing was acknowledged.",
                    );
                }
            };
            match session(client, options, &target).await {
                Ok(s) => match store.finish_model_change(&source, &id) {
                    Ok(()) => Outcome::Dismissed(s),
                    Err(e) => Outcome::Refused(e),
                },
                Err(e) => Outcome::Refused(e),
            }
        }
        Action::Submit(attempt) => {
            let pre=async{
                attempt.validate(&attempt.target.session)?;
                let current=session(client,options,&attempt.target).await?;
                if !current.allowed||current.model!=attempt.target.model||current.thinking!=attempt.target.thinking||current.failed_source!=attempt.target.failed_source{return Err("Chat model/state changed or is not idle. Refresh; nothing was switched.");}
                let c=catalog(client,options,&attempt.target.cwd).await?;if !c.admits(&attempt.choice){return Err("This model/thinking choice is no longer in this chat's scope. Refresh models.");}
                if attempt.target.failed_source.is_some() {
                    let h = crate::local_client::hello(client, options).await?;
                    if h["capabilities"]["passiveFailedModel"] != true { return Err("This daemon cannot save a failed chat's next model safely. No legacy fallback was sent."); }
                }
                store.prepare_model_change(attempt.clone())?;Ok(())
            }.await;
            if let Err(e) = pre {
                return Outcome::Refused(e);
            }
            prepared(store);
            // Exactly one supported POST, no continuation, retry or extra action.
            let failed = attempt.target.failed_source.as_ref();
            let payload = if let Some(source) = failed {
                let host = options.host();
                let mut v = serde_json::to_value(&attempt.choice).expect("serializable choice");
                v["operationId"] = serde_json::json!(attempt.id);
                v["daemonId"] = serde_json::json!(host.daemon_id);
                v["lineageId"] = serde_json::json!(host.lineage_id);
                v["source"] = serde_json::to_value(source).expect("serializable source");
                v
            } else {
                serde_json::to_value(&attempt.choice).expect("serializable choice")
            };
            let bytes = match serde_json::to_vec(&payload) {
                Ok(b) => b,
                Err(_) => {
                    return Outcome::Unknown(
                        "Cannot encode the retained model choice. It was not sent.",
                    );
                }
            };
            let response = client
                .post(format!(
                    "{}/api/sessions/{}/{}",
                    options.loopback(),
                    attempt.target.session,
                    if failed.is_some() {
                        "failed-model"
                    } else {
                        "model"
                    }
                ))
                .header("Content-Type", "application/json")
                .body(bytes)
                .send()
                .await;
            let value = match response {
                Ok(r) if r.status() == reqwest::StatusCode::OK => body(r).await,
                _ => Err(
                    "Model switch response was lost or rejected. Original choice retained; no retry was sent.",
                ),
            };
            let value = match value {
                Ok(v) => v,
                Err(e) => return Outcome::Unknown(e),
            };
            let value = if let Some(source) = failed {
                let host = options.host();
                if value["operationId"] != attempt.id
                    || value["sessionId"] != attempt.target.session
                    || value["daemonId"] != host.daemon_id
                    || value["lineageId"] != host.lineage_id
                    || FailedSource::read(&value["source"]).as_ref() != Some(source)
                    || value["model"] != attempt.choice.model
                    || value.get("thinking") != payload.get("thinking")
                    || value["session"]["nextAttemptModel"]
                        != serde_json::to_value(&attempt.choice).unwrap()
                    || failure_source(&value["session"])
                        .as_ref()
                        .is_none_or(|s| s.source != source.source)
                    || value["session"]["outcome"] != "failed"
                    || value["session"]["outcomeAt"].as_u64().is_none()
                {
                    return Outcome::Unknown(
                        "Next-attempt model acknowledgment was incomplete. No retry was sent.",
                    );
                }
                value["session"].clone()
            } else {
                value
            };
            let actual = SessionModel::read(&value);
            if value["id"] != attempt.target.session
                || value["cwd"] != attempt.target.cwd
                || actual.model.as_deref() != Some(&attempt.choice.model)
                || attempt
                    .choice
                    .thinking
                    .as_ref()
                    .is_some_and(|v| actual.thinking.as_ref() != Some(v))
            {
                return Outcome::Unknown(
                    "Model switch acknowledgment was incomplete. Inspect this chat before another action.",
                );
            }
            // Keep the known acknowledgment in memory even if private settlement fails.
            let _ = store.finish_model_change(&attempt.target.session, &attempt.id);
            Outcome::Acknowledged(actual)
        }
    }
}

#[cfg(test)]
#[path = "chat_models_tests.rs"]
mod transport_tests;
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn scoped_catalog_qualifies_ids_and_reported_levels_without_inventing_defaults() {
        let c:Catalog=serde_json::from_value(json!({"models":[{"id":"p/a","provider":"p","name":"模型","thinkingLevels":["off","high"],"thinking":"high"}],"defaultModel":"p/a"})).unwrap();
        c.validate().unwrap();
        assert!(c.admits(&Choice {
            model: "p/a".into(),
            thinking: None
        }));
        assert!(!c.admits(&Choice {
            model: "a".into(),
            thinking: None
        }));
        assert!(!c.admits(&Choice {
            model: "p/a".into(),
            thinking: Some("medium".into())
        }));
        let mut bad = c.clone();
        bad.models.push(c.models[0].clone());
        assert!(bad.validate().is_err());
        bad = c;
        bad.models[0].provider = "elsewhere".into();
        assert!(bad.validate().is_err());
        let mut levels: Catalog =
            serde_json::from_value(crate::chat_models_fixture::catalog()).unwrap();
        levels.models[0].thinking_levels = (0..17).map(|i| format!("level-{i}")).collect();
        assert!(levels.validate().is_err());
        levels.models[0].thinking_levels = vec!["high".into(), "high".into()];
        assert!(levels.validate().is_err());
        let mut count = Catalog {
            models: vec![],
            default_model: None,
        };
        for i in 0..2049 {
            count.models.push(Model {
                search_key: String::new(),
                id: format!("p/{i}"),
                provider: "p".into(),
                name: "Model".into(),
                thinking_levels: vec![],
                thinking: None,
            });
        }
        assert!(count.validate().is_err());
        count.models.clear();
        assert!(count.validate().is_ok());
    }
    #[test]
    fn retained_failed_paused_and_nonidle_sessions_cannot_change() {
        let v = json!({"id":"a","cwd":"/faux","state":"idle","working":false,"model":"p/a","thinking":"high"});
        assert!(SessionModel::read(&v).allowed);
        let mut parked = v.clone();
        parked["state"] = json!("parked");
        assert!(SessionModel::read(&parked).allowed);
        assert!(SessionModel::read(&parked).blocked.is_none());
        // summary.error also carries old kernel/input diagnostics. Actual
        // meta.failure projects as failed; a healthy idle state isn't a failure
        // merely because that diagnostic is still displayed.
        for state in ["idle", "parked"] {
            let mut recovered = v.clone();
            recovered["state"] = json!(state);
            recovered["error"] = json!("Retained diagnostic");
            assert!(SessionModel::read(&recovered).allowed);
        }
        for (key, value) in [
            ("state", json!("working")),
            ("state", json!("failed")),
            ("state", json!("starting")),
            ("state", json!("unknown")),
            ("state", Value::Null),
            ("working", json!(true)),
            ("control", json!(true)),
            ("role", json!("diagnostics")),
            ("archivedAt", json!(1)),
            ("continuedTo", json!("next")),
            ("continuationPending", json!(true)),
            ("failure", json!({"message":"failed"})),
            ("sleepPaused", json!(true)),
            ("offlinePaused", json!(true)),
            ("runningJobs", json!([{"id":"job"}])),
            ("subscriptionPause", json!({"force":false})),
        ] {
            let mut blocked = v.clone();
            blocked[key] = value;
            assert!(!SessionModel::read(&blocked).allowed, "{key}");
            assert!(SessionModel::read(&blocked).blocked.is_some(), "{key}");
            if key != "state" {
                blocked["state"] = json!("parked");
                assert!(!SessionModel::read(&blocked).allowed, "parked {key}");
            }
        }
    }
}
