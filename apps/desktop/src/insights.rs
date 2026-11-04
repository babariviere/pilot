//! Bounded Insights reads and explicitly checked, immutable native actions.
use crate::{
    delivery_store::{Failure, Operation},
    local_client::LocalOptions,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

pub(crate) const DISCLOSURE: &str = "insights-history-v1";
const BODY_CAP: usize = 512 * 1024;
const RESULT_CAP: usize = 16 * 1024;
const INVALID: Failure = "Local returned malformed Insights data.";
const CORRUPT: Failure = "Stored Insights action is corrupt.";
const MAX_REVISION: u64 = 9_007_199_254_740_990;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Lifecycle {
    Proposed,
    Approved,
    InProgress,
    Shipped,
    Verified,
    Deferred,
    Dismissed,
}
impl Lifecycle {
    pub(crate) const ALL: [Self; 7] = [
        Self::Proposed,
        Self::Approved,
        Self::InProgress,
        Self::Shipped,
        Self::Verified,
        Self::Deferred,
        Self::Dismissed,
    ];
    pub(crate) fn wire(self) -> &'static str {
        match self {
            Self::Proposed => "proposed",
            Self::Approved => "approved",
            Self::InProgress => "in_progress",
            Self::Shipped => "shipped",
            Self::Verified => "verified",
            Self::Deferred => "deferred",
            Self::Dismissed => "dismissed",
        }
    }
    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Proposed => "Proposed",
            Self::Approved => "Approved",
            Self::InProgress => "In progress",
            Self::Shipped => "Shipped",
            Self::Verified => "Verified",
            Self::Deferred => "Deferred",
            Self::Dismissed => "Dismissed",
        }
    }
    pub(crate) fn parse(value: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|lifecycle| lifecycle.wire() == value)
    }
}

fn text(value: &Value, max: usize, empty: bool) -> Result<String, Failure> {
    value
        .as_str()
        .filter(|s| {
            (empty || !s.trim().is_empty()) && s.chars().count() <= max && !s.contains('\0')
        })
        .map(str::to_owned)
        .ok_or(INVALID)
}
fn id(value: &Value) -> Result<String, Failure> {
    value
        .as_str()
        .filter(|id| crate::local_model::valid_id(id))
        .map(str::to_owned)
        .ok_or(INVALID)
}
fn number(value: &Value) -> Result<u64, Failure> {
    value.as_u64().filter(|n| *n <= MAX_REVISION).ok_or(INVALID)
}
fn uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok_and(|id| id.to_string() == value)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Status {
    pub(crate) session_id: String,
    pub(crate) enabled: bool,
    pub(crate) revision: u64,
    pub(crate) project_id: String,
    pub(crate) mission_id: String,
    pub(crate) setup_pending: bool,
    pub(crate) archived: bool,
    pub(crate) available: bool,
}
pub(crate) fn status(value: &Value, session: &str) -> Result<Status, Failure> {
    let session_id = id(&value["sessionId"])?;
    if session_id != session || value["disclosure"] != DISCLOSURE {
        return Err(INVALID);
    }
    Ok(Status {
        session_id,
        enabled: value["enabled"].as_bool().ok_or(INVALID)?,
        revision: number(&value["revision"])?,
        project_id: id(&value["projectId"])?,
        mission_id: id(&value["missionId"])?,
        setup_pending: value["setupPending"].as_bool().ok_or(INVALID)?,
        archived: value["archived"].as_bool().ok_or(INVALID)?,
        available: value["available"].as_bool().ok_or(INVALID)?,
    })
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Target {
    pub(crate) project_id: String,
    pub(crate) label: String,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Cost {
    pub(crate) baseline: String,
    pub(crate) assumptions: String,
    pub(crate) estimate: String,
    pub(crate) quality_risks: String,
    pub(crate) later_result: String,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Finding {
    pub(crate) key: String,
    pub(crate) revision: u64,
    pub(crate) task_id: String,
    pub(crate) lifecycle: Lifecycle,
    pub(crate) title: String,
    pub(crate) priority: String,
    pub(crate) targets: Vec<Target>,
    pub(crate) cost: Option<Cost>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Findings {
    pub(crate) items: Vec<Finding>,
    pub(crate) next_cursor: Option<u64>,
}
pub(crate) fn findings(value: &Value) -> Result<Findings, Failure> {
    let raw = value["items"]
        .as_array()
        .filter(|items| items.len() <= 20)
        .ok_or(INVALID)?;
    let mut items = Vec::with_capacity(raw.len());
    for item in raw {
        let key = text(&item["key"], 36, false)?;
        if !uuid(&key) || items.iter().any(|f: &Finding| f.key == key) {
            return Err(INVALID);
        }
        let priority = text(&item["priority"], 6, false)?;
        if !matches!(priority.as_str(), "low" | "medium" | "high") {
            return Err(INVALID);
        }
        let targets = item["targets"]
            .as_array()
            .filter(|t| t.len() <= 20)
            .ok_or(INVALID)?
            .iter()
            .map(|t| {
                Ok(Target {
                    project_id: id(&t["projectId"])?,
                    label: text(&t["label"], 2000, false)?,
                })
            })
            .collect::<Result<Vec<_>, Failure>>()?;
        let cost = match item.get("cost").ok_or(INVALID)? {
            Value::Null => None,
            cost if cost.is_object() => Some(Cost {
                baseline: text(&cost["baseline"], 2000, true)?,
                assumptions: text(&cost["assumptions"], 2000, true)?,
                estimate: text(&cost["estimate"], 2000, true)?,
                quality_risks: text(&cost["qualityRisks"], 2000, true)?,
                later_result: text(&cost["laterResult"], 2000, true)?,
            }),
            _ => return Err(INVALID),
        };
        items.push(Finding {
            key,
            revision: number(&item["revision"])?,
            task_id: id(&item["taskId"])?,
            lifecycle: Lifecycle::parse(item["lifecycle"].as_str().ok_or(INVALID)?)
                .ok_or(INVALID)?,
            title: text(&item["title"], 2000, false)?,
            priority,
            targets,
            cost,
        });
    }
    let next_cursor = match value.get("nextCursor").ok_or(INVALID)? {
        Value::Null => None,
        n => Some(number(n)?),
    };
    Ok(Findings { items, next_cursor })
}
pub(crate) fn supported(hello: &Value) -> bool {
    hello["capabilities"]["insights"].as_u64() == Some(1)
}

pub(crate) enum Read {
    Status {
        session: String,
    },
    Findings {
        session: String,
        cursor: Option<u64>,
    },
}
#[derive(Clone, Debug)]
pub(crate) enum ReadReply {
    Status(Result<Status, Failure>),
    Findings(Result<Findings, Failure>),
    Unavailable,
    NotInsights,
    Unsupported,
}
impl Read {
    fn failed(&self, error: Failure) -> ReadReply {
        match self {
            Self::Status { .. } => ReadReply::Status(Err(error)),
            Self::Findings { .. } => ReadReply::Findings(Err(error)),
        }
    }
}
pub(crate) fn read(
    options: LocalOptions,
    read: Read,
) -> Option<async_channel::Receiver<ReadReply>> {
    let (tx, rx) = async_channel::bounded(1);
    std::thread::Builder::new()
        .name("local-insights-read".into())
        .spawn(move || {
            let reply = match (
                tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build(),
                crate::chat_settings::client(),
            ) {
                (Ok(runtime), Ok(client)) => runtime.block_on(run_read(&client, &options, &read)),
                _ => read.failed("Couldn't start the Insights read."),
            };
            let _ = tx.send_blocking(reply);
        })
        .ok()?;
    Some(rx)
}
async fn run_read(client: &reqwest::Client, options: &LocalOptions, read: &Read) -> ReadReply {
    match crate::local_client::hello(client, options).await {
        Err(error) => return read.failed(error),
        Ok(hello) if !supported(&hello) => return ReadReply::Unsupported,
        Ok(_) => {}
    }
    let (session, suffix) = match read {
        Read::Status { session } => (session, String::new()),
        Read::Findings { session, cursor } => (
            session,
            cursor.map_or_else(|| "/findings".into(), |n| format!("/findings?cursor={n}")),
        ),
    };
    if !crate::local_model::valid_id(session) {
        return read.failed(INVALID);
    }
    let response = match client
        .get(format!(
            "{}/api/insights/sessions/{session}{suffix}",
            options.loopback()
        ))
        .send()
        .await
    {
        Ok(response) => response,
        Err(_) => return read.failed("Couldn't read Insights from Local."),
    };
    let code = response.status().as_u16();
    let value = match body(response).await {
        Ok(value) => value,
        Err(_) if matches!(code, 404 | 405 | 501) => return ReadReply::Unsupported,
        Err(error) => return read.failed(error),
    };
    match code {
        200 => match read {
            Read::Status { .. } => ReadReply::Status(status(&value, session)),
            Read::Findings { .. } => ReadReply::Findings(findings(&value)),
        },
        404 if value["error"] == "not_insights" => ReadReply::NotInsights,
        409 if value["error"] == "insights_unavailable" => ReadReply::Unavailable,
        404 | 405 | 501 => ReadReply::Unsupported,
        _ => read.failed("Local refused the Insights read."),
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Request {
    Create {
        project_id: String,
        mission_id: String,
        model: String,
        thinking: Option<String>,
    },
    Revoke {
        session_id: String,
        expected_revision: u64,
    },
    Lifecycle {
        session_id: String,
        key: String,
        expected_revision: u64,
        lifecycle: Lifecycle,
    },
}
impl Request {
    pub(crate) fn slot(&self) -> String {
        match self {
            Self::Create { mission_id, .. } => format!("create:{mission_id}"),
            Self::Revoke { session_id, .. } => format!("revoke:{session_id}"),
            Self::Lifecycle {
                session_id, key, ..
            } => format!("lifecycle:{session_id}:{key}"),
        }
    }
    pub(crate) fn kind(&self) -> &'static str {
        match self {
            Self::Create { .. } => "insights-create",
            Self::Revoke { .. } => "insights-revoke",
            Self::Lifecycle { .. } => "insights-lifecycle",
        }
    }
    pub(crate) fn target(&self) -> Option<String> {
        match self {
            Self::Create { .. } => None,
            Self::Revoke { session_id, .. } | Self::Lifecycle { session_id, .. } => {
                Some(session_id.clone())
            }
        }
    }
    pub(crate) fn payload(&self) -> String {
        // Sorted keys, independent of serde_json's map feature: the payload hash covers these bytes.
        fn canonical(pairs: Vec<(&str, Value)>) -> String {
            serde_json::to_string(
                &pairs
                    .into_iter()
                    .collect::<std::collections::BTreeMap<_, _>>(),
            )
            .unwrap_or_default()
        }
        match self {
            Self::Create {
                project_id,
                mission_id,
                model,
                thinking,
            } => {
                let mut pairs = vec![
                    ("projectId", json!(project_id)),
                    ("missionId", json!(mission_id)),
                    ("model", json!(model)),
                    ("disclosure", json!(DISCLOSURE)),
                ];
                if let Some(thinking) = thinking {
                    pairs.push(("thinking", json!(thinking)));
                }
                canonical(pairs)
            }
            Self::Revoke {
                expected_revision, ..
            } => canonical(vec![("expectedRevision", json!(expected_revision))]),
            Self::Lifecycle {
                key,
                expected_revision,
                lifecycle,
                ..
            } => canonical(vec![
                ("key", json!(key)),
                ("expectedRevision", json!(expected_revision)),
                ("lifecycle", json!(lifecycle.wire())),
            ]),
        }
    }
    pub(crate) fn validate(&self) -> Result<(), Failure> {
        match self {
            Self::Create {
                project_id,
                mission_id,
                model,
                thinking,
            } => {
                if !crate::local_model::valid_id(project_id)
                    || !crate::local_model::valid_id(mission_id)
                    || model.trim().is_empty()
                    || model.len() > 512
                    || model.chars().any(char::is_control)
                    || thinking.as_ref().is_some_and(|s| {
                        s.is_empty() || s.len() > 64 || s.chars().any(char::is_control)
                    })
                {
                    return Err(INVALID);
                }
            }
            Self::Revoke {
                session_id,
                expected_revision,
            }
            | Self::Lifecycle {
                session_id,
                expected_revision,
                ..
            } => {
                if !crate::local_model::valid_id(session_id) || *expected_revision > MAX_REVISION {
                    return Err(INVALID);
                }
            }
        }
        if let Self::Lifecycle { key, .. } = self
            && !uuid(key)
        {
            return Err(INVALID);
        }
        Ok(())
    }
}
#[derive(Clone, Debug)]
pub(crate) enum Action {
    Start(Request),
    Check { slot: String },
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum State {
    Unknown,
    Pending,
    Accepted,
    Rejected,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Attempt {
    pub(crate) slot: String,
    pub(crate) operation: Operation,
    pub(crate) state: State,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) result: Option<Value>,
}
impl std::fmt::Debug for Attempt {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Attempt")
            .field("slot", &self.slot)
            .field("state", &self.state)
            .finish_non_exhaustive()
    }
}
impl Attempt {
    pub(crate) fn open(&self) -> bool {
        matches!(self.state, State::Unknown | State::Pending)
    }
    pub(crate) fn validate(&self, slot: &str) -> Result<(), Failure> {
        let op = &self.operation;
        if op.payload.len() > 4096 {
            return Err(CORRUPT);
        }
        let p: Value = serde_json::from_str(&op.payload).map_err(|_| CORRUPT)?;
        let request = match op.kind.as_str() {
            "insights-create" if uuid(&op.target_id) && p["disclosure"] == DISCLOSURE => {
                Request::Create {
                    project_id: id(&p["projectId"])?,
                    mission_id: id(&p["missionId"])?,
                    model: text(&p["model"], 512, false)?,
                    thinking: match p.get("thinking") {
                        None => None,
                        Some(s) => Some(text(s, 64, false)?),
                    },
                }
            }
            "insights-revoke" => Request::Revoke {
                session_id: op.target_id.clone(),
                expected_revision: number(&p["expectedRevision"])?,
            },
            "insights-lifecycle" => Request::Lifecycle {
                session_id: op.target_id.clone(),
                key: text(&p["key"], 36, false)?,
                expected_revision: number(&p["expectedRevision"])?,
                lifecycle: Lifecycle::parse(p["lifecycle"].as_str().ok_or(CORRUPT)?)
                    .ok_or(CORRUPT)?,
            },
            _ => return Err(CORRUPT),
        };
        request.validate()?;
        if self.slot != slot
            || request.slot() != slot
            || request.payload() != op.payload
            || self
                .reason
                .as_ref()
                .is_some_and(|r| r.chars().count() > 512)
            || (self.state == State::Accepted) != self.result.is_some()
            || self.result.as_ref().is_some_and(|r| !valid_result(op, r))
        {
            return Err(CORRUPT);
        }
        Ok(())
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Outcome {
    Accepted(Value),
    Pending,
    Rejected(String),
    Unknown(Failure),
    Refused(Failure),
}
impl Outcome {
    pub(crate) fn state(&self) -> Option<(State, Option<String>)> {
        match self {
            Self::Accepted(_) => Some((State::Accepted, None)),
            Self::Pending => Some((State::Pending, None)),
            Self::Rejected(reason) => Some((State::Rejected, Some(reason.clone()))),
            Self::Unknown(_) | Self::Refused(_) => None,
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Reply {
    pub(crate) slot: String,
    pub(crate) request: u64,
    pub(crate) outcome: Option<Outcome>,
}
pub(crate) fn outcome(attempt: &Attempt) -> Outcome {
    match attempt.state {
        State::Unknown => Outcome::Unknown(
            "Couldn't confirm the Insights action. Check it; nothing is resent automatically.",
        ),
        State::Pending => Outcome::Pending,
        State::Accepted => attempt
            .result
            .clone()
            .map(Outcome::Accepted)
            .unwrap_or(Outcome::Unknown(CORRUPT)),
        State::Rejected => Outcome::Rejected(
            attempt
                .reason
                .clone()
                .unwrap_or_else(|| "Local refused the Insights action.".into()),
        ),
    }
}
fn valid_result(op: &Operation, result: &Value) -> bool {
    if result.to_string().len() > RESULT_CAP || result["sessionId"] != op.target_id {
        return false;
    }
    match op.kind.as_str() {
        "insights-create" => true,
        "insights-revoke" => number(&result["revision"]).is_ok(),
        "insights-lifecycle" => {
            let Ok(payload) = serde_json::from_str::<Value>(&op.payload) else {
                return false;
            };
            result["key"] == payload["key"]
                && result["operationId"] == op.operation_id
                && result["kind"] == "finding"
                && number(&result["revision"]).is_ok()
                && id(&result["taskId"]).is_ok()
        }
        _ => false,
    }
}
pub(crate) fn adopt(op: &Operation, receipt: &Value) -> Outcome {
    const MISMATCH: Failure =
        "The receipt doesn't match this Insights action. It was kept unchanged.";
    if receipt["state"] == "unknown" {
        return Outcome::Unknown(
            "Local has no record of this action yet. Check to send the same request.",
        );
    }
    if receipt["operationId"] != op.operation_id
        || receipt["payloadHash"] != op.payload_hash
        || receipt["targetId"] != op.target_id
        || serde_json::to_value(&op.destination).ok().as_ref() != Some(&receipt["destination"])
    {
        return Outcome::Unknown(MISMATCH);
    }
    match receipt["state"].as_str() {
        Some("pending") => Outcome::Pending,
        Some("accepted") if valid_result(op, &receipt["result"]) => {
            Outcome::Accepted(receipt["result"].clone())
        }
        Some("rejected") => Outcome::Rejected(
            receipt["reason"]
                .as_str()
                .unwrap_or("Local refused the Insights action.")
                .chars()
                .take(512)
                .collect(),
        ),
        _ => Outcome::Unknown(MISMATCH),
    }
}
async fn body(mut response: reqwest::Response) -> Result<Value, Failure> {
    if response
        .content_length()
        .is_some_and(|n| n > BODY_CAP as u64)
    {
        return Err("Local response exceeds the bounded reader limit.");
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Local response was interrupted.")?
    {
        if bytes.len() + chunk.len() > BODY_CAP {
            return Err("Local response exceeds the bounded reader limit.");
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "Local returned malformed JSON.")
}
async fn post(
    client: &reqwest::Client,
    options: &LocalOptions,
    op: &Operation,
    lookup: bool,
) -> Result<Value, Failure> {
    let encoded = serde_json::to_vec(op).map_err(|_| "Cannot encode the Insights action.")?;
    let mut request = client
        .post(format!(
            "{}/api/operations{}",
            options.loopback(),
            if lookup { "/receipt" } else { "" }
        ))
        .header("Content-Type", "application/json")
        .body(encoded);
    if !lookup {
        let token = options
            .model_scope_capability()
            .map_err(|_| "Native Insights authorization is unavailable on this Local.")?;
        let mut header = reqwest::header::HeaderValue::from_str(&token)
            .map_err(|_| "Native Insights authorization is malformed.")?;
        header.set_sensitive(true);
        request = request.header("x-pilot-github-capability", header);
    }
    let response = request
        .send()
        .await
        .map_err(|_| "The Insights action was interrupted.")?;
    if response.status() != reqwest::StatusCode::OK {
        return Err("Local refused the Insights action request.");
    }
    body(response).await
}
pub(crate) async fn execute(
    client: &reqwest::Client,
    options: &LocalOptions,
    op: &Operation,
) -> Outcome {
    if crate::local_client::gate(client, options).await.is_err() {
        return Outcome::Unknown(
            "Couldn't reach Local. The Insights action was saved; Check sends the same request.",
        );
    }
    match post(client, options, op, false).await {
        Ok(receipt) => adopt(op, &receipt),
        Err(_) => Outcome::Unknown(
            "Couldn't confirm the Insights action. Check it; nothing is resent automatically.",
        ),
    }
}
pub(crate) async fn check(
    client: &reqwest::Client,
    options: &LocalOptions,
    op: &Operation,
) -> Outcome {
    if crate::local_client::gate(client, options).await.is_err() {
        return Outcome::Unknown("Couldn't reach Local. Check again when Pilot is running.");
    }
    match post(client, options, op, true).await {
        Ok(receipt) if receipt["state"] == "unknown" => execute(client, options, op).await,
        Ok(receipt) => adopt(op, &receipt),
        Err(_) => Outcome::Unknown("Couldn't check the Insights action. Try again."),
    }
}

#[cfg(test)]
#[path = "insights_tests.rs"]
mod tests;
