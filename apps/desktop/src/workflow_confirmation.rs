//! Native workflow confirmations: plan approval, reviewer consent and their revocation.
//! Local prepares one exact immutable package with a passive GET. Confirm saves that
//! package's envelope in the private writer, then POSTs it once with the existing native
//! host-action capability. Check is the passive receipt lookup only: nothing is resent and
//! a matching GET never counts as acceptance. This guards against practical mistakes. It
//! doesn't verify who confirmed or isolate other processes of the same user.
use crate::{
    delivery_store::{Failure, Operation},
    local_client::LocalOptions,
    local_model::valid_id,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;

/// The host journal's payload limit. A larger package is refused before any write.
pub(crate) const PAYLOAD_CAP: usize = 64 * 1024;
const BODY_CAP: usize = 256 * 1024;
const INVALID: Failure = "Local returned a malformed confirmation package. Nothing was sent.";
const CORRUPT: Failure = "Stored workflow confirmation is corrupt.";
const UNCONFIRMED: Failure = "Couldn't confirm it. Check it; nothing is resent.";
/// No host record at this read only. The original request may still arrive, so it stays open.
pub(crate) const NO_RECORD: Failure =
    "No record on Local yet. It may still arrive, so it stays unconfirmed. Check again later.";
const MAX_NUMBER: u64 = 9_007_199_254_740_990;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum Purpose {
    Approve,
    Revoke,
    Consent,
    ConsentRevoke,
}
impl Purpose {
    pub(crate) const ALL: [Self; 4] = [
        Self::Approve,
        Self::Revoke,
        Self::Consent,
        Self::ConsentRevoke,
    ];
    pub(crate) fn kind(self) -> &'static str {
        match self {
            Self::Approve => "workflow-approve",
            Self::Revoke => "workflow-revoke",
            Self::Consent => "review-consent",
            Self::ConsentRevoke => "review-consent-revoke",
        }
    }
    pub(crate) fn from_kind(kind: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|p| p.kind() == kind)
    }
    pub(crate) fn consent(self) -> bool {
        matches!(self, Self::Consent | Self::ConsentRevoke)
    }
    pub(crate) fn revoke(self) -> bool {
        matches!(self, Self::Revoke | Self::ConsentRevoke)
    }
    fn route(self) -> (&'static str, &'static str) {
        (
            if self.consent() {
                "reviewer-consent-package"
            } else {
                "approval-package"
            },
            if self.revoke() { "revoke" } else { "approve" },
        )
    }
    pub(crate) fn title(self) -> &'static str {
        match self {
            Self::Approve => "Approve plan",
            Self::Revoke => "Revoke plan approval",
            Self::Consent => "Reviewer consent",
            Self::ConsentRevoke => "Revoke reviewer consent",
        }
    }
    pub(crate) fn menu(self) -> &'static str {
        match self {
            Self::Approve => "Approve plan…",
            Self::Revoke => "Revoke plan approval…",
            Self::Consent => "Reviewer consent…",
            Self::ConsentRevoke => "Revoke reviewer consent…",
        }
    }
    pub(crate) fn confirm(self) -> &'static str {
        match self {
            Self::Approve => "Approve",
            Self::Consent => "Give consent",
            Self::Revoke | Self::ConsentRevoke => "Revoke",
        }
    }
}
/// One retained confirmation per purpose and mission.
pub(crate) fn slot(purpose: Purpose, mission: &str) -> String {
    format!("{}:{mission}", purpose.kind())
}

/// Host-configured, non-secret reviewer disclosure, shown as Local states it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Disclosure {
    pub(crate) revision: String,
    pub(crate) provider: String,
    pub(crate) model: String,
    pub(crate) account: String,
    pub(crate) terms: String,
    pub(crate) expires_at: u64,
}

/// One active decision of the package, number and text as frozen by Local.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Decision {
    pub(crate) number: u64,
    pub(crate) text: String,
}

/// The package exactly as Local prepared it. Confirm sends `payload`, never a rebuilt one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Prepared {
    pub(crate) purpose: Purpose,
    pub(crate) mission_id: String,
    pub(crate) project_id: String,
    pub(crate) coordinator: String,
    pub(crate) brief_revision: u64,
    pub(crate) brief: String,
    pub(crate) decisions: Vec<Decision>,
    pub(crate) event_id: u64,
    pub(crate) digest: String,
    pub(crate) prior: Option<String>,
    pub(crate) disclosure: Option<Disclosure>,
    pub(crate) payload: String,
}
impl Prepared {
    pub(crate) fn request(&self) -> Request {
        Request {
            purpose: self.purpose,
            mission_id: self.mission_id.clone(),
            payload: self.payload.clone(),
        }
    }
}

fn exact(value: &Value, keys: &[&str]) -> bool {
    value
        .as_object()
        .is_some_and(|o| o.len() == keys.len() && keys.iter().all(|k| o.contains_key(*k)))
}
fn number(value: &Value) -> Result<u64, Failure> {
    value.as_u64().filter(|n| *n <= MAX_NUMBER).ok_or(INVALID)
}
fn id(value: &Value) -> Result<String, Failure> {
    value
        .as_str()
        .filter(|s| valid_id(s))
        .map(str::to_owned)
        .ok_or(INVALID)
}
fn optional_id(value: &Value) -> Result<Option<String>, Failure> {
    match value {
        Value::Null => Ok(None),
        v => id(v).map(Some),
    }
}
fn hash(value: &Value) -> Result<String, Failure> {
    value
        .as_str()
        .filter(|s| {
            s.len() == 64
                && s.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
        .map(str::to_owned)
        .ok_or(INVALID)
}
fn field(value: &Value) -> Result<String, Failure> {
    value
        .as_str()
        .filter(|s| !s.trim().is_empty() && s.chars().count() <= 2000)
        .map(str::to_owned)
        .ok_or(INVALID)
}
/// Sorted keys, independent of serde_json's map feature: the payload hash covers these bytes.
fn canonical(pairs: Vec<(&str, Value)>) -> String {
    serde_json::to_string(&pairs.into_iter().collect::<BTreeMap<_, _>>()).unwrap_or_default()
}

/// The fixed policy the host binds into every package. Anything else is malformed.
fn policy() -> Value {
    json!({
        "scrutiny": "Balanced",
        "requiredChecks": "must-pass",
        "review": {"T1": "targeted-independent", "T2": "full-independent", "T3": "specialist-and-human"},
        "excludedPowers": ["review-spend", "human-review", "integrate", "cleanup", "subdelegate"],
        "expiry": "mission-end-or-revocation"
    })
}
fn delegation(coordinator: &str) -> Value {
    json!({
        "coordinatorSessionId": coordinator,
        "actions": ["plan", "classify", "assign", "assess", "accept-outcome"],
        "expansion": "fresh-user-confirmation",
        "protectedDecisions": "user-only",
        "force": false
    })
}
const DISCLOSURE_KEYS: [&str; 13] = [
    "configurationRevision",
    "provider",
    "model",
    "account",
    "terms",
    "dataScope",
    "retention",
    "expiresAt",
    "missionLimitMicros",
    "logicalTaskLimitMicros",
    "cumulativeAcrossRechecks",
    "refillOnReplacement",
    "paidFallback",
];
/// Every field must be present as Local states it. Nothing missing is filled in here.
fn disclosure(v: &Value) -> Result<Disclosure, Failure> {
    if !exact(v, &DISCLOSURE_KEYS)
        || v["dataScope"] != "exact-local-research-plan-revisions"
        || v["retention"] != "raw-30-days-records-90-days-active-pins-excepted"
        || v["missionLimitMicros"] != 20_000_000
        || v["logicalTaskLimitMicros"] != 4_000_000
        || v["cumulativeAcrossRechecks"] != true
        || v["refillOnReplacement"] != false
        || v["paidFallback"] != false
    {
        return Err(INVALID);
    }
    Ok(Disclosure {
        revision: field(&v["configurationRevision"])?,
        provider: field(&v["provider"])?,
        model: field(&v["model"])?,
        account: field(&v["account"])?,
        terms: field(&v["terms"])?,
        expires_at: number(&v["expiresAt"])?,
    })
}
const PACKAGE_KEYS: [&str; 15] = [
    "version",
    "purpose",
    "missionId",
    "projectId",
    "coordinatorSessionId",
    "brief",
    "decisions",
    "eventId",
    "contextFence",
    "configurationDigest",
    "policy",
    "delegation",
    "workflowApprovalOperationId",
    "disclosure",
    "digest",
];
const FENCE_KEYS: [&str; 5] = [
    "briefRevision",
    "decisionEventId",
    "artifactEventId",
    "memberEventId",
    "coordinatorEventId",
];

/// Parse Local's prepared package without changing it. Unknown keys or values outside the
/// fixed scope are malformed: the sheet must show what is actually sent.
pub(crate) fn prepared(
    value: &Value,
    purpose: Purpose,
    mission: &str,
    project: &str,
) -> Result<Prepared, Failure> {
    let p = &value["package"];
    if !exact(value, &["package", "expectedPriorOperationId"])
        || !exact(p, &PACKAGE_KEYS)
        || p["version"] != 1
        || p["purpose"] != purpose.kind()
        || p["missionId"] != mission
        || p["projectId"] != project
        || p["policy"] != policy()
        || !exact(&p["contextFence"], &FENCE_KEYS)
    {
        return Err(INVALID);
    }
    let coordinator = id(&p["coordinatorSessionId"])?;
    if p["delegation"] != delegation(&coordinator) {
        return Err(INVALID);
    }
    for key in FENCE_KEYS {
        number(&p["contextFence"][key])?;
    }
    let brief = &p["brief"];
    let brief_revision = number(&brief["revision"])
        .ok()
        .filter(|n| *n > 0)
        .ok_or(INVALID)?;
    if brief["missionId"] != mission || p["contextFence"]["briefRevision"] != brief_revision {
        return Err(INVALID);
    }
    let markdown = brief["markdown"].as_str().ok_or(INVALID)?.to_owned();
    let decisions = p["decisions"]
        .as_array()
        .filter(|d| d.len() <= 128)
        .ok_or(INVALID)?
        .iter()
        .map(|d| {
            let text = d["text"]
                .as_str()
                .filter(|_| d.is_object())
                .ok_or(INVALID)?;
            Ok::<_, Failure>(Decision {
                number: number(&d["number"])?,
                text: text.to_owned(),
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    hash(&p["configurationDigest"])?;
    let digest = hash(&p["digest"])?;
    let approval = optional_id(&p["workflowApprovalOperationId"])?;
    let disclosure = match (&p["disclosure"], purpose) {
        (Value::Null, Purpose::Approve | Purpose::Revoke | Purpose::ConsentRevoke) => None,
        (d, Purpose::Consent | Purpose::ConsentRevoke) => Some(disclosure(d)?),
        _ => return Err(INVALID),
    };
    // Consent names the exact approval it builds on; plan purposes carry none.
    if match purpose {
        Purpose::Approve | Purpose::Revoke => approval.is_some(),
        Purpose::Consent => approval.is_none(),
        Purpose::ConsentRevoke => false,
    } {
        return Err(INVALID);
    }
    let prior = optional_id(&value["expectedPriorOperationId"])?;
    let payload = canonical(vec![
        ("purpose", json!(purpose.kind())),
        ("package", p.clone()),
        ("expectedPriorOperationId", json!(prior)),
    ]);
    if payload.len() > PAYLOAD_CAP {
        return Err("This plan is larger than a confirmation can carry. Nothing was sent.");
    }
    Ok(Prepared {
        purpose,
        mission_id: mission.into(),
        project_id: project.into(),
        coordinator,
        brief_revision,
        brief: markdown,
        decisions,
        event_id: number(&p["eventId"])?,
        digest,
        prior,
        disclosure,
        payload,
    })
}

/// The confirmable command: the purpose and exact bytes the sheet showed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Request {
    pub(crate) purpose: Purpose,
    pub(crate) mission_id: String,
    pub(crate) payload: String,
}
impl Request {
    pub(crate) fn slot(&self) -> String {
        slot(self.purpose, &self.mission_id)
    }
    pub(crate) fn validate(&self) -> Result<(), Failure> {
        let p: Value = serde_json::from_str(&self.payload).map_err(|_| CORRUPT)?;
        if self.payload.len() > PAYLOAD_CAP
            || !valid_id(&self.mission_id)
            || !exact(&p, &["purpose", "package", "expectedPriorOperationId"])
            || p["purpose"] != self.purpose.kind()
            || p["package"]["purpose"] != self.purpose.kind()
            || p["package"]["missionId"] != self.mission_id.as_str()
        {
            return Err(CORRUPT);
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
    /// Saved and unconfirmed, including "no record yet" at a Check. An older store's
    /// "absent" decodes here: absence was only ever true at that read, so it stays open.
    #[serde(alias = "absent")]
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
        let purpose = Purpose::from_kind(&op.kind).ok_or(CORRUPT)?;
        let request = Request {
            purpose,
            mission_id: op.target_id.clone(),
            payload: op.payload.clone(),
        };
        request.validate()?;
        if self.slot != slot
            || request.slot() != slot
            || self
                .reason
                .as_ref()
                .is_some_and(|r| r.chars().count() > 512)
        {
            return Err(CORRUPT);
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Outcome {
    Accepted,
    Pending,
    Rejected(String),
    Unknown(Failure),
    Refused(Failure),
}
impl Outcome {
    pub(crate) fn state(&self) -> Option<(State, Option<String>)> {
        match self {
            Self::Accepted => Some((State::Accepted, None)),
            Self::Pending => Some((State::Pending, None)),
            Self::Rejected(r) => Some((State::Rejected, Some(r.clone()))),
            // Unknown, including no record, never changes what was saved.
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
/// A retained attempt's last known outcome, without contacting Local.
pub(crate) fn outcome(attempt: &Attempt) -> Outcome {
    match attempt.state {
        State::Unknown => Outcome::Unknown(UNCONFIRMED),
        State::Pending => Outcome::Pending,
        State::Accepted => Outcome::Accepted,
        State::Rejected => {
            Outcome::Rejected(attempt.reason.clone().unwrap_or_else(|| "Refused.".into()))
        }
    }
}

/// Short words for a host refusal. Unknown text stays bounded and plain.
pub(crate) fn reason_text(reason: &str) -> String {
    let known = [
        (
            "package changed",
            "The plan changed since this opened. Review again.",
        ),
        (
            "authority changed",
            "The plan changed since this opened. Review again.",
        ),
        (
            "prior revocation is uncertain",
            "An earlier revocation is unconfirmed. Check it first.",
        ),
        (
            "current exact workflow approval",
            "Approve the current plan first.",
        ),
        (
            "current coordinator",
            "This mission has no current coordinator.",
        ),
        (
            "coordinator project or availability",
            "The coordinator changed or is unavailable.",
        ),
        (
            "disclosure configuration is unavailable",
            "Reviewer consent isn't set up on this Local. No provider, model, account or terms are configured.",
        ),
    ];
    let lower = reason.to_lowercase();
    known
        .iter()
        .find(|(needle, _)| lower.contains(needle))
        .map(|(_, text)| (*text).to_owned())
        .unwrap_or_else(|| {
            reason
                .chars()
                .filter(|c| !c.is_control())
                .take(240)
                .collect()
        })
}

/// The receipt of exactly this envelope. Any other identity is a mismatch, kept Unknown.
pub(crate) fn adopt(op: &Operation, receipt: &Value) -> Outcome {
    const MISMATCH: Failure = "The receipt doesn't match this confirmation. It was kept unchanged.";
    // Absence holds at this read point only; a late original may still be reserved.
    if receipt["state"] == "unknown" && exact(receipt, &["state"]) {
        return Outcome::Unknown(NO_RECORD);
    }
    if receipt["operationId"] != op.operation_id.as_str()
        || receipt["payloadHash"] != op.payload_hash.as_str()
        || receipt["targetId"] != op.target_id.as_str()
        || serde_json::to_value(&op.destination).ok().as_ref() != Some(&receipt["destination"])
    {
        return Outcome::Unknown(MISMATCH);
    }
    let marker =
        json!({"stage":"workflow-effect-entered","purpose":op.kind,"payloadHash":op.payload_hash});
    match receipt["state"].as_str() {
        Some("pending")
            if receipt
                .get("result")
                .is_none_or(|r| r.is_null() || *r == marker) =>
        {
            Outcome::Pending
        }
        Some("accepted")
            if receipt["result"]
                == json!({"operationId":op.operation_id,"missionId":op.target_id,"kind":op.kind}) =>
        {
            Outcome::Accepted
        }
        Some("rejected") => Outcome::Rejected(reason_text(
            receipt["reason"].as_str().unwrap_or("Refused."),
        )),
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

/// What the sheet can show before any write.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Gate {
    Ready(Box<Prepared>),
    /// Local can't prepare this purpose now. The reason is shown; nothing is offered instead.
    Unavailable(String),
}

/// Pinned hello, then the passive package GET. Never writes.
pub(crate) fn prepare(
    options: LocalOptions,
    purpose: Purpose,
    mission: String,
    project: String,
) -> Option<async_channel::Receiver<Result<Gate, Failure>>> {
    let (tx, rx) = async_channel::bounded(1);
    std::thread::Builder::new()
        .name("local-workflow-package".into())
        .spawn(move || {
            let reply = match (
                tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build(),
                crate::chat_settings::client(),
            ) {
                (Ok(runtime), Ok(client)) => {
                    runtime.block_on(read_package(&client, &options, purpose, &mission, &project))
                }
                _ => Err("Couldn't start the confirmation read."),
            };
            let _ = tx.send_blocking(reply);
        })
        .ok()?;
    Some(rx)
}
async fn read_package(
    client: &reqwest::Client,
    options: &LocalOptions,
    purpose: Purpose,
    mission: &str,
    project: &str,
) -> Result<Gate, Failure> {
    if !valid_id(mission) || !valid_id(project) {
        return Err(INVALID);
    }
    crate::local_client::gate(client, options).await?;
    let (route, action) = purpose.route();
    let response = client
        .get(format!(
            "{}/api/missions/{mission}/{route}?action={action}",
            options.loopback()
        ))
        .send()
        .await
        .map_err(|_| "Couldn't read the confirmation package from Local.")?;
    let code = response.status().as_u16();
    let value = body(response).await;
    match code {
        200 => prepared(&value?, purpose, mission, project).map(|p| Gate::Ready(Box::new(p))),
        409 | 503 => {
            let reason = value
                .ok()
                .and_then(|v| v["error"].as_str().map(reason_text));
            Ok(Gate::Unavailable(
                reason.unwrap_or_else(|| "Local can't prepare this now.".into()),
            ))
        }
        404 | 405 | 501 => Ok(Gate::Unavailable(
            "This Local doesn't support workflow confirmations.".into(),
        )),
        _ => Err("Local refused the confirmation read."),
    }
}

async fn post(
    client: &reqwest::Client,
    options: &LocalOptions,
    op: &Operation,
    lookup: bool,
) -> Result<Value, Failure> {
    let encoded = serde_json::to_vec(op).map_err(|_| "Cannot encode the confirmation.")?;
    let mut request = client
        .post(format!(
            "{}/api/operations{}",
            options.loopback(),
            if lookup { "/receipt" } else { "" }
        ))
        .header("Content-Type", "application/json")
        .body(encoded);
    // Only the one confirmed send carries the native capability; Check never does.
    if !lookup {
        let token = options
            .model_scope_capability()
            .map_err(|_| "Native confirmation is unavailable on this Local.")?;
        let mut header = reqwest::header::HeaderValue::from_str(&token)
            .map_err(|_| "Native confirmation is unavailable on this Local.")?;
        header.set_sensitive(true);
        request = request.header("x-pilot-github-capability", header);
    }
    let response = request
        .send()
        .await
        .map_err(|_| "The confirmation was interrupted.")?;
    if response.status() != reqwest::StatusCode::OK {
        return Err("Local refused the confirmation request.");
    }
    body(response).await
}
/// The one send of a saved envelope. A lost reply is Unknown and is only ever Checked.
pub(crate) async fn execute(
    client: &reqwest::Client,
    options: &LocalOptions,
    op: &Operation,
) -> Outcome {
    if crate::local_client::gate(client, options).await.is_err() {
        return Outcome::Unknown(
            "Couldn't reach Local. It was saved; Check it, nothing is resent.",
        );
    }
    match post(client, options, op, false).await {
        // A receipt-free reply leaves the envelope Unknown, like any lost reply.
        Ok(receipt) => match adopt(op, &receipt) {
            Outcome::Unknown(_) => Outcome::Unknown(UNCONFIRMED),
            o => o,
        },
        Err(_) => Outcome::Unknown(UNCONFIRMED),
    }
}
/// Check: the exact passive receipt lookup. It never sends the confirmation again.
pub(crate) async fn check(
    client: &reqwest::Client,
    options: &LocalOptions,
    op: &Operation,
) -> Outcome {
    if crate::local_client::gate(client, options).await.is_err() {
        return Outcome::Unknown("Couldn't reach Local. Check again when Pilot is running.");
    }
    match post(client, options, op, true).await {
        Ok(receipt) => adopt(op, &receipt),
        Err(_) => Outcome::Unknown("Couldn't check the confirmation. Try again."),
    }
}

#[cfg(test)]
#[path = "workflow_confirmation_tests.rs"]
mod tests;

/// Synthetic packages for unit tests and labelled synthetic probes only. Never a live source.
#[cfg(any(test, feature = "native-probes"))]
pub(crate) mod fixture {
    use super::Purpose;
    use serde_json::{Value, json};
    pub(crate) const DIGEST: &str =
        "c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00";
    pub(crate) fn disclosure(expires_at: u64) -> Value {
        json!({
            "configurationRevision": "synthetic-1", "provider": "Synthetic provider",
            "model": "synthetic/reviewer-1", "account": "synthetic account (no credentials)",
            "terms": "Synthetic terms for layout only.",
            "dataScope": "exact-local-research-plan-revisions",
            "retention": "raw-30-days-records-90-days-active-pins-excepted",
            "expiresAt": expires_at, "missionLimitMicros": 20000000, "logicalTaskLimitMicros": 4000000,
            "cumulativeAcrossRechecks": true, "refillOnReplacement": false, "paidFallback": false
        })
    }
    /// A prepared reply as the host shapes it.
    pub(crate) fn prepared(
        purpose: Purpose,
        mission: &str,
        project: &str,
        prior: Option<&str>,
    ) -> Value {
        let consent = purpose == Purpose::Consent;
        json!({
            "package": {
                "version": 1, "purpose": purpose.kind(), "missionId": mission, "projectId": project,
                "coordinatorSessionId": "lead",
                "brief": {"missionId": mission, "revision": 3, "markdown": "# Plan\nShip the slice 日本語 👩‍💻", "createdAt": 1},
                "decisions": [{"id":"d1","number":1,"audience":"all","text":"Design first","createdAt":1,"updatedAt":1},
                              {"id":"d2","number":4,"audience":"all","text":"Then build","createdAt":2,"updatedAt":2}],
                "eventId": 42,
                "contextFence": {"briefRevision":3,"decisionEventId":40,"artifactEventId":0,"memberEventId":12,"coordinatorEventId":13},
                "configurationDigest": DIGEST,
                "policy": super::policy(),
                "delegation": super::delegation("lead"),
                "workflowApprovalOperationId": if consent { json!("approval-1") } else { Value::Null },
                "disclosure": if consent { disclosure(4_102_444_800_000) } else { Value::Null },
                "digest": DIGEST
            },
            "expectedPriorOperationId": prior
        })
    }
}
