//! Confirmed replacement of an unavailable Insights report chat over the host's durable
//! contract (docs/technical/insights-replacement.md): passive hello/preflight/status reads
//! and one native-confirmed `insights-replace` command. The preflight payload is frozen
//! verbatim. A replacement names a new report chat; it never restores deleted content,
//! copies a grant, starts a review or switches Automations on.
use crate::{
    delivery_store::{Failure, Host, Operation},
    insights::Outcome,
    insights_enable::{self as weekly, Model},
    local_client::LocalOptions,
    scheduled_messages::Recurrence,
};
use serde_json::{Value, json};

pub(crate) const KIND: &str = "insights-replace";
pub(crate) const DISCLOSURE: &str = "insights-replacement-v1";
/// The host's own operation payload limit.
pub(crate) const PAYLOAD_CAP: usize = 64 * 1024;
const INVALID: Failure = "Local returned malformed replacement data.";
const MAX_REFERENCES: usize = 32;
const MAX_RULES: usize = 8;
const MAX_NUMBER: u64 = 9_007_199_254_740_990;

/// Pinned hello: both the replacement and the enable interfaces exist. Not a grant.
pub(crate) fn supported(hello: &Value) -> bool {
    hello["capabilities"]["insightsReplacement"].as_u64() == Some(1) && weekly::supported(hello)
}
/// The writer slot of one old report's replacement. Each old identity keeps its own record.
pub(crate) fn slot(old: &str) -> String {
    format!("replace:{old}")
}
/// The host's report identity form: lowercase hyphenated UUID.
pub(crate) fn uuid(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => c.is_ascii_digit() || (b'a'..=b'f').contains(c),
        })
}
fn keys(value: &Value, expected: &[&str]) -> bool {
    value
        .as_object()
        .is_some_and(|o| o.len() == expected.len() && expected.iter().all(|k| o.contains_key(*k)))
}
fn text(value: &Value, max: usize, empty: bool) -> Result<String, Failure> {
    value
        .as_str()
        .filter(|s| {
            (empty || !s.trim().is_empty())
                && s.chars().count() <= max
                && !s.chars().any(char::is_control)
        })
        .map(str::to_owned)
        .ok_or(INVALID)
}
fn number(value: &Value) -> Result<u64, Failure> {
    value.as_u64().filter(|n| *n <= MAX_NUMBER).ok_or(INVALID)
}
fn ident(value: &Value) -> Result<String, Failure> {
    value
        .as_str()
        .filter(|s| crate::local_model::valid_id(s))
        .map(str::to_owned)
        .ok_or(INVALID)
}
fn report(value: &Value) -> Result<String, Failure> {
    value
        .as_str()
        .filter(|s| uuid(s))
        .map(str::to_owned)
        .ok_or(INVALID)
}
fn digest(value: &Value) -> Result<String, Failure> {
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

/// What the host plans for one automation that names the old report chat.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Disposition {
    /// An integration-owned pending rule, cancelled by exact revision before the new chat.
    Cancel,
    /// A finished rule, left as history.
    Keep,
    /// Manual, running, mismatched or uncertain: the replacement refuses.
    Blocked,
}
/// Bounded projection only: no saved prompt, run history or grant.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Rule {
    pub(crate) id: String,
    pub(crate) revision: u64,
    pub(crate) title: String,
    pub(crate) paused: bool,
    pub(crate) recurrence: Option<Recurrence>,
    pub(crate) disposition: Disposition,
}
fn rule(v: &Value) -> Result<Rule, Failure> {
    if !keys(
        v,
        &[
            "id",
            "revision",
            "digest",
            "title",
            "trigger",
            "state",
            "paused",
            "targetSessionId",
            "recurrence",
            "disposition",
        ],
    ) {
        return Err(INVALID);
    }
    digest(&v["digest"])?;
    text(&v["trigger"], 32, false)?;
    text(&v["state"], 32, false)?;
    if !v["targetSessionId"]
        .as_str()
        .is_some_and(|s| s.is_empty() || crate::local_model::valid_id(s))
    {
        return Err(INVALID);
    }
    let recurrence = match &v["recurrence"] {
        Value::Null => None,
        r => Some(serde_json::from_value::<Recurrence>(r.clone()).map_err(|_| INVALID)?),
    };
    Ok(Rule {
        id: ident(&v["id"])?,
        revision: number(&v["revision"])?,
        title: text(&v["title"], 500, true)?,
        paused: v["paused"].as_bool().ok_or(INVALID)?,
        recurrence,
        disposition: match v["disposition"].as_str() {
            Some("cancel") => Disposition::Cancel,
            Some("keep") => Disposition::Keep,
            Some("blocked") => Disposition::Blocked,
            _ => return Err(INVALID),
        },
    })
}
fn rules(v: &Value) -> Result<Vec<Rule>, Failure> {
    let rows = v
        .as_array()
        .filter(|r| r.len() <= MAX_RULES)
        .ok_or(INVALID)?;
    let rules = rows.iter().map(rule).collect::<Result<Vec<_>, _>>()?;
    if (1..rules.len()).any(|i| rules[..i].iter().any(|r| r.id == rules[i].id)) {
        return Err(INVALID);
    }
    Ok(rules)
}
fn references(v: &Value) -> Result<usize, Failure> {
    let rows = v
        .as_array()
        .filter(|r| r.len() <= MAX_REFERENCES)
        .ok_or(INVALID)?;
    for r in rows {
        if !keys(
            r,
            &["operationId", "kind", "targetId", "state", "payloadHash"],
        ) || !matches!(
            r["state"].as_str(),
            Some("pending" | "accepted" | "rejected")
        ) || !r["kind"].as_str().is_some_and(|k| {
            !k.is_empty() && k.len() <= 64 && k.bytes().all(|b| b.is_ascii_lowercase() || b == b'-')
        }) {
            return Err(INVALID);
        }
        ident(&r["operationId"])?;
        ident(&r["targetId"])?;
        digest(&r["payloadHash"])?;
    }
    Ok(rows.len())
}

/// An exact old → successor record. Revision 1 is a fence only; revision 2 is completion.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Link {
    pub(crate) old: String,
    pub(crate) successor: String,
    pub(crate) project_id: String,
    pub(crate) mission_id: String,
    pub(crate) context: String,
    pub(crate) replaced: bool,
}
fn link(v: &Value, old: &str, project: &str, mission: &str) -> Result<Link, Failure> {
    if !keys(
        v,
        &[
            "oldSessionId",
            "successorSessionId",
            "projectId",
            "missionId",
            "context",
            "revision",
            "state",
        ],
    ) || v["oldSessionId"] != old
        || v["projectId"] != project
        || v["missionId"] != mission
    {
        return Err(INVALID);
    }
    let replaced = match (number(&v["revision"])?, v["state"].as_str()) {
        (1, Some("fenced")) => false,
        (2, Some("replaced")) => true,
        _ => return Err(INVALID),
    };
    let successor = report(&v["successorSessionId"])?;
    if successor == old {
        return Err(INVALID);
    }
    Ok(Link {
        old: old.to_owned(),
        successor,
        project_id: project.to_owned(),
        mission_id: mission.to_owned(),
        context: text(&v["context"], 256, false)?,
        replaced,
    })
}

/// The confirmable command, exactly as the host offered it.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Frozen {
    /// The exact payload bytes the operation hash covers.
    pub(crate) text: String,
    pub(crate) old: String,
    pub(crate) successor: String,
    /// Fresh fixed weekly settings for the new report chat; nothing is copied.
    pub(crate) enable: weekly::Frozen,
    pub(crate) rules: Vec<Rule>,
}
const PAYLOAD_KEYS: [&str; 11] = [
    "projectId",
    "missionId",
    "expectedHome",
    "context",
    "oldSessionId",
    "successorSessionId",
    "expectedReplacementRevision",
    "references",
    "rules",
    "enable",
    "disclosure",
];
/// The payload's identity checks shared by parsing and the stored command's validation.
fn identity(p: &Value, project: &str, mission: &str, old: &str, successor: &str) -> bool {
    let e = &p["enable"];
    keys(p, &PAYLOAD_KEYS)
        && p["projectId"] == project
        && p["missionId"] == mission
        && p["oldSessionId"] == old
        && p["successorSessionId"] == successor
        && uuid(old)
        && uuid(successor)
        && old != successor
        && p["expectedReplacementRevision"] == 0
        && p["disclosure"] == DISCLOSURE
        && e["projectId"] == project
        && e["missionId"] == mission
        && e["context"] == p["context"]
        && e["expectedHome"] == p["expectedHome"]
        && e["disclosure"] == weekly::DISCLOSURE
        && e["chat"].is_null()
        && e.get("chat").is_some()
        && e["schedule"].is_null()
        && e.get("schedule").is_some()
        && e.get("settingsRevision").is_none()
}
fn frozen(
    p: &Value,
    project: &str,
    mission: &str,
    old: &str,
    host: &Host,
) -> Result<Frozen, Failure> {
    let successor = report(&p["successorSessionId"])?;
    if !identity(p, project, mission, old, &successor)
        || !weekly::same_home(&p["expectedHome"], host)
    {
        return Err(INVALID);
    }
    text(&p["context"], 256, false)?;
    references(&p["references"])?;
    let rules = rules(&p["rules"])?;
    if rules.iter().any(|r| r.disposition == Disposition::Blocked) {
        return Err(INVALID);
    }
    let enable = weekly::frozen(&p["enable"], project, mission, &successor, host)?;
    if enable.chat.is_some() || enable.reuses_schedule {
        return Err(INVALID);
    }
    let text = serde_json::to_string(p).map_err(|_| INVALID)?;
    if text.len() > PAYLOAD_CAP {
        return Err(INVALID);
    }
    Ok(Frozen {
        text,
        old: old.to_owned(),
        successor,
        enable,
        rules,
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum State {
    Ready,
    Blocked,
    /// A completed exact replacement already exists; adopt it only after its re-read.
    Replaced,
}
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Preview {
    pub(crate) project_id: String,
    pub(crate) mission_id: String,
    pub(crate) old: String,
    pub(crate) state: State,
    pub(crate) reason: Option<String>,
    /// "bounded", "overflow" or "unavailable": this observation, not proof of deletion.
    pub(crate) coverage: String,
    pub(crate) rules: Vec<Rule>,
    pub(crate) supersession: Option<Link>,
    pub(crate) model: Model,
    pub(crate) frozen: Option<Frozen>,
    pub(crate) next_at: Option<u64>,
}
impl Preview {
    /// The native command for this exact confirmation, or None when nothing is confirmable.
    pub(crate) fn request(&self) -> Option<crate::insights::Request> {
        let f = self
            .frozen
            .as_ref()
            .filter(|_| self.state == State::Ready)?;
        Some(crate::insights::Request::Replace {
            project_id: self.project_id.clone(),
            mission_id: self.mission_id.clone(),
            old_id: f.old.clone(),
            target_id: f.successor.clone(),
            payload: f.text.clone(),
        })
    }
}
/// Strict: unknown keys, another backlog or old identity, a changed home or a payload that
/// differs from the observation it summarizes are malformed, never confirmable.
pub(crate) fn preview(
    value: &Value,
    project: &str,
    mission: &str,
    old: &str,
    host: &Host,
    explicit: Option<&str>,
) -> Result<Preview, Failure> {
    if !keys(
        value,
        &[
            "projectId",
            "missionId",
            "oldSessionId",
            "state",
            "reason",
            "coverage",
            "references",
            "rules",
            "supersession",
            "payload",
            "nextAt",
            "model",
            "cost",
        ],
    ) || value["projectId"] != project
        || value["missionId"] != mission
        || value["oldSessionId"] != old
        || value["cost"] != json!({"pricing":"unknown","spendUsd":null})
    {
        return Err(INVALID);
    }
    let state = match value["state"].as_str() {
        Some("ready") => State::Ready,
        Some("blocked") => State::Blocked,
        Some("replaced") => State::Replaced,
        _ => return Err(INVALID),
    };
    let coverage = match value["coverage"].as_str() {
        Some(c @ ("bounded" | "overflow" | "unavailable")) => c.to_owned(),
        _ => return Err(INVALID),
    };
    references(&value["references"])?;
    let rules = rules(&value["rules"])?;
    let supersession = match &value["supersession"] {
        Value::Null => None,
        l => Some(link(l, old, project, mission)?),
    };
    let model = weekly::model(&value["model"])?;
    let reason = weekly::reason(value.get("reason"))?;
    let next_at = match &value["nextAt"] {
        Value::Null => None,
        n => Some(number(n)?),
    };
    let frozen = match &value["payload"] {
        Value::Null => None,
        p => Some(frozen(p, project, mission, old, host)?),
    };
    match (state, &frozen, &supersession) {
        (State::Ready, Some(f), None) => {
            let p = &value["payload"];
            if coverage != "bounded"
                || reason.is_some()
                || model != Model::Available(f.enable.model.clone())
                || explicit.is_some_and(|m| m != f.enable.model)
                || p["references"] != value["references"]
                || p["rules"] != value["rules"]
                || next_at.is_none()
            {
                return Err(INVALID);
            }
        }
        (State::Blocked, None, s) if reason.is_some() && s.as_ref().is_none_or(|l| !l.replaced) => {
        }
        (State::Replaced, None, Some(l)) if l.replaced => {}
        _ => return Err(INVALID),
    }
    Ok(Preview {
        project_id: project.to_owned(),
        mission_id: mission.to_owned(),
        old: old.to_owned(),
        state,
        reason,
        coverage,
        rules,
        supersession,
        model,
        frozen,
        next_at,
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum Phase {
    FencePending,
    Fenced,
    CancelPending,
    RulesFenced,
    ChatPending,
    ChatReady,
    SchedulePending,
    Replaced,
}
impl Phase {
    fn parse(v: &Value) -> Option<Self> {
        Some(match v.as_str()? {
            "fence_pending" => Self::FencePending,
            "fenced" => Self::Fenced,
            "cancel_pending" => Self::CancelPending,
            "rules_fenced" => Self::RulesFenced,
            "chat_pending" => Self::ChatPending,
            "chat_ready" => Self::ChatReady,
            "schedule_pending" => Self::SchedulePending,
            "replaced" => Self::Replaced,
            _ => return None,
        })
    }
}
fn frozen_payload(op: &Operation) -> Option<Value> {
    (op.kind == KIND)
        .then(|| serde_json::from_str::<Value>(&op.payload).ok())
        .flatten()
}
/// A receipt's progress for exactly this command: both frozen identities, this target's
/// committed chat once past its step, and only cancellation ACKs the plan named.
fn progress(result: &Value, op: &Operation) -> Result<(Phase, String), Failure> {
    let p = frozen_payload(op).ok_or(INVALID)?;
    if !keys(
        result,
        &[
            "phase",
            "oldSessionId",
            "sessionId",
            "scheduleId",
            "chat",
            "cancelledRules",
        ],
    ) || result["oldSessionId"] != p["oldSessionId"]
        || result["sessionId"] != op.target_id.as_str()
        || p["successorSessionId"] != op.target_id.as_str()
    {
        return Err(INVALID);
    }
    let phase = Phase::parse(&result["phase"]).ok_or(INVALID)?;
    let schedule = ident(&result["scheduleId"])?;
    let chat_ok = match &result["chat"] {
        Value::Null => phase <= Phase::ChatPending,
        c => {
            let expected: &[&str] = if c.get("thinking").is_some() {
                &[
                    "sessionId",
                    "grantId",
                    "revision",
                    "inputGeneration",
                    "model",
                    "thinking",
                ]
            } else {
                &[
                    "sessionId",
                    "grantId",
                    "revision",
                    "inputGeneration",
                    "model",
                ]
            };
            phase >= Phase::ChatReady
                && keys(c, expected)
                && c["sessionId"] == op.target_id.as_str()
                && c["model"] == p["enable"]["model"]
                && c.get("thinking") == p["enable"].get("thinking")
                && c["revision"] == 1
                && c["inputGeneration"] == 0
                && ident(&c["grantId"]).is_ok()
        }
    };
    let cancel: Vec<&Value> = p["rules"]
        .as_array()
        .ok_or(INVALID)?
        .iter()
        .filter(|r| r["disposition"] == "cancel")
        .collect();
    let acks = result["cancelledRules"]
        .as_array()
        .filter(|a| a.len() <= MAX_RULES)
        .ok_or(INVALID)?;
    let mut seen = Vec::new();
    for a in acks {
        let id = ident(&a["id"])?;
        if !keys(a, &["id", "revision", "digest"])
            || seen.contains(&id)
            || !cancel.iter().any(|r| r["id"] == id.as_str())
        {
            return Err(INVALID);
        }
        number(&a["revision"])?;
        digest(&a["digest"])?;
        seen.push(id);
    }
    // Past the rule step every planned cancellation has its exact ACK; a committed chat
    // is required from its ready step on.
    if !chat_ok
        || (phase >= Phase::ChatReady && result["chat"].is_null())
        || (phase >= Phase::RulesFenced && seen.len() != cancel.len())
    {
        return Err(INVALID);
    }
    Ok((phase, schedule))
}
/// An accepted replacement: the final transaction receipt, phase replaced.
pub(crate) fn valid_result(op: &Operation, result: &Value) -> bool {
    result.to_string().len() <= PAYLOAD_CAP
        && progress(result, op).is_ok_and(|(phase, _)| phase == Phase::Replaced)
}
/// A pending receipt's entered marker, never the final phase.
pub(crate) fn valid_pending(op: &Operation, result: Option<&Value>) -> bool {
    match result {
        None | Some(Value::Null) => true,
        Some(r) => progress(r, op).is_ok_and(|(phase, _)| phase != Phase::Replaced),
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Receipt {
    Unknown,
    /// The last durable step marker: entered, not completed.
    Pending(Option<Phase>),
    Accepted,
    Rejected(String),
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Current {
    NotFound,
    Unknown,
    Partial,
    Blocked,
    Replaced,
}
/// Passive status: the receipt plus a present recheck. Never settles or promotes anything.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Status {
    pub(crate) receipt: Receipt,
    pub(crate) current: Current,
    pub(crate) reason: Option<String>,
    pub(crate) successor: String,
    pub(crate) schedule_id: Option<String>,
    pub(crate) next_at: Option<u64>,
}
/// The status of exactly this operation; a receipt or link for anything else is malformed.
pub(crate) fn status(value: &Value, op: &Operation) -> Result<Status, Failure> {
    let p = frozen_payload(op).ok_or(INVALID)?;
    if !keys(
        value,
        &[
            "receipt",
            "state",
            "reason",
            "supersession",
            "sessionId",
            "scheduleId",
            "nextAt",
        ],
    ) || value["sessionId"] != op.target_id.as_str()
    {
        return Err(INVALID);
    }
    let r = &value["receipt"];
    let mut reserved = None;
    let receipt = match r["state"].as_str() {
        Some("unknown") if keys(r, &["state"]) => Receipt::Unknown,
        state => {
            if r["operationId"] != op.operation_id.as_str()
                || r["payloadHash"] != op.payload_hash.as_str()
                || r["targetId"] != op.target_id.as_str()
                || serde_json::to_value(&op.destination).ok().as_ref() != Some(&r["destination"])
            {
                return Err(INVALID);
            }
            match state {
                Some("pending") => match r.get("result") {
                    None | Some(Value::Null) => Receipt::Pending(None),
                    Some(result) => {
                        let (phase, schedule) = progress(result, op)?;
                        if phase == Phase::Replaced {
                            return Err(INVALID);
                        }
                        reserved = Some(schedule);
                        Receipt::Pending(Some(phase))
                    }
                },
                Some("accepted") => {
                    let (phase, schedule) = progress(&r["result"], op)?;
                    if phase != Phase::Replaced {
                        return Err(INVALID);
                    }
                    reserved = Some(schedule);
                    Receipt::Accepted
                }
                Some("rejected") => Receipt::Rejected(
                    weekly::reason(r.get("reason"))?.unwrap_or_else(|| "refused".into()),
                ),
                _ => return Err(INVALID),
            }
        }
    };
    let current = match value["state"].as_str() {
        Some("not_found") => Current::NotFound,
        Some("unknown") => Current::Unknown,
        Some("partial") => Current::Partial,
        Some("blocked") => Current::Blocked,
        Some("replaced") => Current::Replaced,
        _ => return Err(INVALID),
    };
    let supersession = match &value["supersession"] {
        Value::Null => None,
        l => {
            let l = link(
                l,
                p["oldSessionId"].as_str().ok_or(INVALID)?,
                p["projectId"].as_str().ok_or(INVALID)?,
                p["missionId"].as_str().ok_or(INVALID)?,
            )?;
            if l.successor != op.target_id || p["context"] != l.context.as_str() {
                return Err(INVALID);
            }
            Some(l)
        }
    };
    let schedule_id = match &value["scheduleId"] {
        Value::Null => None,
        s => Some(ident(s)?),
    };
    // Replaced is a durable completed link plus a present rule recheck. It pairs only with
    // the accepted receipt or the last entered step; that pending receipt stays pending.
    let replaced_ok = supersession.as_ref().is_some_and(|l| l.replaced)
        && matches!(
            receipt,
            Receipt::Accepted | Receipt::Pending(Some(Phase::SchedulePending))
        );
    if (current == Current::NotFound) != (receipt == Receipt::Unknown)
        || (current == Current::Replaced && !replaced_ok)
        || (matches!(receipt, Receipt::Rejected(_)) && current != Current::Blocked)
        || (reserved.is_some() && schedule_id.is_some() && schedule_id != reserved)
        || (current == Current::Replaced && schedule_id.is_none())
    {
        return Err(INVALID);
    }
    Ok(Status {
        receipt,
        current,
        reason: weekly::reason(value.get("reason"))?,
        successor: op.target_id.clone(),
        schedule_id,
        next_at: match &value["nextAt"] {
            Value::Null => None,
            n => Some(number(n)?),
        },
    })
}

/// The stored command's own shape, for the writer's validation. The home is checked there.
pub(crate) fn payload_ok(
    text: &str,
    project: &str,
    mission: &str,
    old: &str,
    target: &str,
) -> bool {
    text.len() <= PAYLOAD_CAP
        && serde_json::from_str::<Value>(text)
            .is_ok_and(|p| identity(&p, project, mission, old, target))
}
/// The frozen backlog and the old and successor identities of a stored command.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Identities {
    pub(crate) project_id: String,
    pub(crate) mission_id: String,
    pub(crate) old: String,
    pub(crate) successor: String,
}
pub(crate) fn identities(op: &Operation) -> Option<Identities> {
    let p = frozen_payload(op)?;
    Some(Identities {
        project_id: p["projectId"].as_str()?.to_owned(),
        mission_id: p["missionId"].as_str()?.to_owned(),
        old: p["oldSessionId"].as_str()?.to_owned(),
        successor: p["successorSessionId"].as_str()?.to_owned(),
    })
}
/// The model, thinking and cadence the stored command froze, for display.
pub(crate) fn frozen_enable(
    op: &Operation,
) -> Option<(String, Option<String>, Option<Recurrence>)> {
    let p = frozen_payload(op)?;
    let e = &p["enable"];
    Some((
        e["model"].as_str()?.to_owned(),
        e["thinking"].as_str().map(str::to_owned),
        serde_json::from_value(e["recurrence"].clone()).ok(),
    ))
}
/// The successor named by an exact completed link may be adopted only when its own admitted
/// settings re-read names the same report chat, backlog and context on the pinned home.
pub(crate) fn adoptable(link: &Link, snapshot: &crate::insights_settings::Snapshot) -> bool {
    link.replaced
        && snapshot.session_id == link.successor
        && snapshot.chat.value["sessionId"] == link.successor.as_str()
        && snapshot.project_id == link.project_id
        && snapshot.mission_id == link.mission_id
        && snapshot.context() == link.context
}

/// Short words for a host reason code. Unknown codes stay generic, never guessed.
pub(crate) fn reason_text(code: &str) -> &'static str {
    match code {
        "old_identity_home_unqualified" => {
            "Pilot can't confirm where the old report chat lived, so it can't be replaced."
        }
        "old_report_present" => "The old report chat still exists. Nothing was replaced.",
        "old_storage_present_or_unavailable" => {
            "The old report chat's files are still present or unreadable."
        }
        "old_work_admitted_wait_for_quiescence"
        | "report_creation_admitted_wait_for_quiescence"
        | "old_review_uncertain" => "Earlier work for the old report chat may still be running.",
        "old_operation_pending_use_receipt" | "enable_pending_use_status" => {
            "An earlier Insights action is still unconfirmed. Check it first."
        }
        "report_references_ambiguous"
        | "report_binding_ambiguous"
        | "successor_appeared_before_admission" => {
            "Another report chat is linked to this backlog. Nothing was replaced."
        }
        "old_automation_binding_unavailable" | "old_automation_untrusted_or_uncertain" => {
            "An automation for the old report chat can't be stopped safely."
        }
        "reference_overflow" | "rule_overflow" => "Too many earlier records to check safely.",
        "replacement_pending_use_status" => {
            "A replacement is already under way. It isn't confirmed yet."
        }
        "replacement_home_or_binding_changed" | "replacement_home_or_context_changed" => {
            "This report chat was replaced for another backlog or Local."
        }
        "automations_disabled" => "Automations are off. Weekly Insights needs them.",
        "model_unavailable"
        | "model_not_found"
        | "model_catalog_unavailable"
        | "successor_model_unavailable" => {
            "Terra 6.1 isn't available in this project. Nothing else is used instead."
        }
        "model_ambiguous" => "More than one model is named Terra 6.1. Choose one.",
        "thinking_unavailable" => "The chosen thinking level isn't available.",
        "preview_changed"
        | "replacement_preview_changed_refresh"
        | "old_rules_changed"
        | "old_rule_revision_changed"
        | "old_operations_changed_use_receipts" => "Something changed while checking. Check again.",
        "preview_too_large" => "The replacement is too large to confirm.",
        "old_cancellation_unknown_use_retained_receipt" => {
            "Stopping an old automation isn't confirmed. Nothing more is retried."
        }
        "replacement_incomplete_use_retained_receipt" => "The replacement isn't finished.",
        "successor_schedule_unresolved_or_changed" | "successor_rule_owner_changed" => {
            "The new weekly automation changed or isn't confirmed."
        }
        "successor_stop_or_authority_changed" | "successor_host_or_binding_changed" => {
            "The new report chat was stopped or changed."
        }
        _ => "The report chat can't be replaced right now.",
    }
}
/// A rejected receipt's reason in words: host codes are translated, prose is kept.
pub(crate) fn refusal_words(reason: &str) -> String {
    if !reason.is_empty()
        && reason
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b == b'_' || b.is_ascii_digit())
    {
        reason_text(reason).to_owned()
    } else {
        reason.to_owned()
    }
}

/// What the replacement step can show before any write.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Gate {
    /// This Local predates the replacement interface.
    Unsupported,
    /// The global Automations opt-in is off; it is never switched here.
    AutomationsOff,
    Checked(Box<Preview>),
}

/// Pinned hello, then the passive preflight. Never writes.
pub(crate) fn read_preview(
    options: LocalOptions,
    project: String,
    mission: String,
    old: String,
    explicit: Option<String>,
) -> Option<async_channel::Receiver<Result<Gate, Failure>>> {
    weekly::spawn(
        "local-insights-replacement",
        Err("Couldn't start the replacement check."),
        move |client, runtime| {
            runtime.block_on(async {
                let hello = crate::local_client::hello(&client, &options).await?;
                if !supported(&hello) {
                    return Ok(Gate::Unsupported);
                }
                if !weekly::automations_on(&hello) {
                    return Ok(Gate::AutomationsOff);
                }
                let mut query = vec![
                    ("projectId", project.as_str()),
                    ("missionId", mission.as_str()),
                    ("reportSessionId", old.as_str()),
                ];
                if let Some(model) = &explicit {
                    query.push(("model", model));
                }
                let response = client
                    .get(format!(
                        "{}/api/insights/replacement/preflight",
                        options.loopback()
                    ))
                    .query(&query)
                    .send()
                    .await
                    .map_err(|_| "Couldn't check the replacement on Local.")?;
                let code = response.status().as_u16();
                let value = crate::insights::body(response).await;
                match code {
                    200 => preview(
                        &value?,
                        &project,
                        &mission,
                        &old,
                        &options.host(),
                        explicit.as_deref(),
                    )
                    .map(|p| Gate::Checked(Box::new(p))),
                    404 | 409 => Err("This backlog isn't an active mission on this Local."),
                    405 | 501 => Ok(Gate::Unsupported),
                    503 => Err("Report replacement is unavailable on this Local."),
                    _ => Err("Local refused the replacement check."),
                }
            })
        },
    )
}

async fn post_status(
    client: &reqwest::Client,
    options: &LocalOptions,
    op: &Operation,
) -> Result<Value, Failure> {
    let encoded = serde_json::to_vec(op).map_err(|_| "Cannot encode the replacement.")?;
    let response = client
        .post(format!(
            "{}/api/insights/replacement/status",
            options.loopback()
        ))
        .header("Content-Type", "application/json")
        .body(encoded)
        .send()
        .await
        .map_err(|_| "Couldn't read the replacement status.")?;
    if response.status() != reqwest::StatusCode::OK {
        return Err("Local refused the replacement status read.");
    }
    crate::insights::body(response).await
}
/// Passive status of a retained command. It never executes or resumes a step.
pub(crate) fn read_status(
    options: LocalOptions,
    op: Operation,
) -> Option<async_channel::Receiver<Result<Status, Failure>>> {
    weekly::spawn(
        "local-insights-replacement-status",
        Err("Couldn't start the replacement status read."),
        move |client, runtime| {
            runtime.block_on(async {
                crate::local_client::gate(&client, &options).await?;
                let value = post_status(&client, &options, &op).await?;
                status(&value, &op)
            })
        },
    )
}
/// Check: the passive status first. Only when Local has no record of these bytes is the
/// same envelope sent again; the journal deduplicates it by operation ID.
pub(crate) async fn check(
    client: &reqwest::Client,
    options: &LocalOptions,
    op: &Operation,
) -> Outcome {
    if crate::local_client::gate(client, options).await.is_err() {
        return Outcome::Unknown("Couldn't reach Local. Check again when Pilot is running.");
    }
    match post_status(client, options, op)
        .await
        .and_then(|v| status(&v, op).map(|s| (v, s)))
    {
        Ok((_, s)) if s.receipt == Receipt::Unknown => {
            crate::insights::execute(client, options, op).await
        }
        Ok((v, _)) => crate::insights::adopt(op, &v["receipt"]),
        Err(_) => Outcome::Unknown("Couldn't check the replacement. Try again."),
    }
}

#[cfg(test)]
#[path = "insights_replace_tests.rs"]
mod tests;

/// Synthetic host replies for unit tests and hidden probes only.
#[cfg(any(test, feature = "native-probes"))]
pub(crate) mod fixture {
    use crate::insights_enable::fixture as weekly;
    use serde_json::{Value, json};
    pub(crate) const OLD: &str = "1a2b3c4d-5e6f-5a7b-a8c9-d0e1f2a3b4c5";
    pub(crate) const SUCCESSOR: &str = "9f8e7d6c-5b4a-5392-a817-263544536271";
    pub(crate) const RULE: &str = "2b3c4d5e-6f70-4182-9a3b-4c5d6e7f8091";
    pub(crate) const KEPT: &str = "3c4d5e6f-7081-4293-8a4b-5c6d7e8f90a1";
    pub(crate) const SCHEDULE: &str = "4d5e6f70-8192-5a3b-a4c5-d6e7f8091a2b";
    pub(crate) const DIGEST: &str =
        "0b2f3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f809";
    pub(crate) fn rules() -> Value {
        json!([
            {"id":RULE,"revision":2,"digest":DIGEST,"title":"Weekly Insights","trigger":"recurring","state":"pending","paused":false,"targetSessionId":OLD,
             "recurrence":{"every":"week","weekday":5,"time":"18:00","timeZone":"Europe/Paris"},"disposition":"cancel"},
            {"id":KEPT,"revision":1,"digest":DIGEST,"title":"Weekly Insights 日本語","trigger":"recurring","state":"cancelled","paused":true,"targetSessionId":OLD,
             "recurrence":{"every":"week","weekday":5,"time":"18:00","timeZone":"Europe/Paris"},"disposition":"keep"}
        ])
    }
    pub(crate) fn references() -> Value {
        json!([{"operationId":"0d8f0f5e-3b6c-4f7a-9d1e-2a3b4c5d6e7f","kind":"insights-enable","targetId":OLD,"state":"accepted","payloadHash":DIGEST}])
    }
    pub(crate) fn payload(project: &str, mission: &str, model: &str) -> Value {
        json!({
            "projectId": project, "missionId": mission,
            "expectedHome": {"hostId":"daemon","daemonId":"test-daemon","lineageId":"test-lineage"},
            "context": "c0ffee", "oldSessionId": OLD, "successorSessionId": SUCCESSOR,
            "expectedReplacementRevision": 0,
            "references": references(), "rules": rules(),
            "enable": weekly::payload(project, mission, model, Value::Null, Value::Null),
            "disclosure": "insights-replacement-v1"
        })
    }
    pub(crate) fn ready(project: &str, mission: &str, model: &str) -> Value {
        json!({
            "projectId": project, "missionId": mission, "oldSessionId": OLD,
            "state": "ready", "reason": null, "coverage": "bounded",
            "references": references(), "rules": rules(), "supersession": null,
            "payload": payload(project, mission, model), "nextAt": weekly::NEXT,
            "model": {"state":"available","id":model},
            "cost": {"pricing":"unknown","spendUsd":null}
        })
    }
    pub(crate) fn blocked(project: &str, mission: &str, reason: &str, coverage: &str) -> Value {
        json!({
            "projectId": project, "missionId": mission, "oldSessionId": OLD,
            "state": "blocked", "reason": reason, "coverage": coverage,
            "references": [], "rules": [], "supersession": null, "payload": null, "nextAt": null,
            "model": {"state":"unavailable","reason":"catalog_unavailable"},
            "cost": {"pricing":"unknown","spendUsd":null}
        })
    }
    pub(crate) fn link(project: &str, mission: &str, revision: u64) -> Value {
        json!({"oldSessionId":OLD,"successorSessionId":SUCCESSOR,"projectId":project,"missionId":mission,
            "context":"c0ffee","revision":revision,"state": if revision == 2 { "replaced" } else { "fenced" }})
    }
    pub(crate) fn replaced(project: &str, mission: &str) -> Value {
        let mut v = blocked(project, mission, "use_exact_successor", "bounded");
        v["state"] = json!("replaced");
        v["supersession"] = link(project, mission, 2);
        v
    }
    /// The host's step progress for this envelope, as its journal stores it.
    pub(crate) fn progress(op: &crate::delivery_store::Operation, phase: &str) -> Value {
        let payload = serde_json::from_str::<Value>(&op.payload).unwrap_or_default();
        let model = payload["enable"]["model"].as_str().unwrap_or(weekly::TERRA);
        let late = matches!(phase, "chat_ready" | "schedule_pending" | "replaced");
        let acked = !matches!(phase, "fence_pending" | "fenced" | "cancel_pending");
        json!({"phase":phase,"oldSessionId":payload["oldSessionId"],"sessionId":op.target_id,"scheduleId":SCHEDULE,
            "chat": if late { weekly::chat(&op.target_id, model) } else { Value::Null },
            "cancelledRules": if acked { json!([{"id":RULE,"revision":3,"digest":DIGEST}]) } else { json!([]) }})
    }
    /// The status route's reply for an exact envelope.
    pub(crate) fn status(
        op: &crate::delivery_store::Operation,
        receipt: &str,
        result: Value,
        state: &str,
        reason: Option<&str>,
    ) -> Value {
        let payload = serde_json::from_str::<Value>(&op.payload).unwrap_or_default();
        let receipt = if receipt == "unknown" {
            json!({"state":"unknown"})
        } else {
            let mut r = json!({"operationId":op.operation_id,"payloadHash":op.payload_hash,"targetId":op.target_id,"destination":op.destination,"state":receipt});
            if !result.is_null() {
                r["result"] = result;
            }
            if receipt == "rejected" {
                r["reason"] = json!(reason.unwrap_or("refused"));
            }
            r
        };
        let project = payload["projectId"].as_str().unwrap_or_default();
        let mission = payload["missionId"].as_str().unwrap_or_default();
        json!({"receipt":receipt,"state":state,"reason":reason,
            "supersession": match state { "replaced" => link(project, mission, 2), "not_found" => Value::Null, _ => link(project, mission, 1) },
            "sessionId":op.target_id,
            "scheduleId": if state == "not_found" { Value::Null } else { json!(SCHEDULE) },
            "nextAt": if state == "replaced" { json!(weekly::NEXT) } else { Value::Null }})
    }
}
