//! Scoped Local catalog and explicit idle-only selection. Never continue/spawn/send.
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
    pub(crate) model: Option<String>,
    pub(crate) thinking: Option<String>,
    pub(crate) updated_at: u64,
    pub(crate) failed_source: Option<FailedSource>,
    pub(crate) allowed: bool,
    pub(crate) blocked: Option<&'static str>,
}
impl SessionModel {
    pub(crate) fn read(v: &Value) -> Self {
        let next = &v["nextAttemptModel"];
        let choice = if next.is_object() { next } else { v };
        Self {
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
        } else if !v["subscriptionPause"].is_null() {
            Some(
                "This chat is paused at a subscription limit. A model change here will not continue it or create another chat.",
            )
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
            Some(
                "Wait for this chat's work and queued messages to finish before changing its model or thinking.",
            )
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
    Acknowledge { session: String, id: String },
}
#[derive(Clone)]
pub(crate) enum Outcome {
    Pending,
    Refused(Failure),
    Unknown(Failure),
    Acknowledged(SessionModel),
    Observed(SessionModel),
    Dismissed(SessionModel),
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
pub(crate) async fn catalog(
    client: &reqwest::Client,
    options: &LocalOptions,
    path: &str,
) -> Result<Catalog, Failure> {
    if !cwd(path) {
        return Err("Choose an exact Local project/chat directory before loading models.");
    }
    gate(client, options).await?;
    let r = client
        .get(format!("{}/api/models", options.loopback()))
        .query(&[("cwd", path)])
        .send()
        .await
        .map_err(|_| "Scoped models unavailable. Refresh explicitly; no fallback is used.")?;
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
    gate(client, options).await?;
    let r = client
        .get(format!(
            "{}/api/sessions/{}",
            options.loopback(),
            target.session
        ))
        .send()
        .await
        .map_err(|_| "Local chat model could not be checked.")?;
    if r.status() != reqwest::StatusCode::OK {
        return Err("Local chat model is unavailable.");
    }
    let v = body(r).await?;
    if v["id"] != target.session || v["cwd"] != target.cwd {
        return Err("Local chat identity or directory changed. Reopen the exact chat.");
    }
    Ok(SessionModel::read(&v))
}
pub(crate) async fn execute(
    client: &reqwest::Client,
    options: &LocalOptions,
    store: &mut Store,
    action: Action,
    prepared: impl FnOnce(&Store),
) -> Outcome {
    match action {
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
