//! Weekly Insights enable over the host's durable contract: passive hello/preflight/status
//! reads and the one native-confirmed `insights-enable` command. The preflight payload is
//! frozen verbatim; nothing here grants access, schedules a review or starts a provider turn.
//! Unavailable, ambiguous or malformed host state blocks confirmation, never falls back.
use crate::{
    delivery_store::{Failure, Host, Operation},
    insights::Outcome,
    local_client::LocalOptions,
    local_model::valid_id,
    scheduled_messages::Recurrence,
};
use serde_json::{Value, json};

pub(crate) const DISCLOSURE: &str = "insights-weekly-v1";
pub(crate) const KIND: &str = "insights-enable";
/// Frozen payload bytes. The host's own limit is larger; a real payload is about 1 KB.
pub(crate) const PAYLOAD_CAP: usize = 8 * 1024;
const INVALID: Failure = "Local returned malformed Insights setup data.";
const SUBSTITUTE: Failure = "Local offered a different report chat. Nothing was set up.";
const MAX_NUMBER: u64 = 9_007_199_254_740_990;

/// Pinned hello: the enable interface exists. Not a grant or a scheduler switch.
pub(crate) fn supported(hello: &Value) -> bool {
    hello["capabilities"]["insightsEnable"].as_u64() == Some(1)
}
/// The existing global Automations opt-in, as Local reports it now.
pub(crate) fn automations_on(hello: &Value) -> bool {
    hello["capabilities"]["automations"].as_u64() == Some(1)
}

/// One findings backlog by exact project and mission identity. The title is display only.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Backlog {
    pub(crate) project_id: String,
    pub(crate) mission_id: String,
    pub(crate) title: Option<String>,
    /// The one report chat already bound to this backlog, pinned in preflight.
    pub(crate) report: Option<String>,
}
impl Backlog {
    pub(crate) fn same(&self, other: &Self) -> bool {
        self.project_id == other.project_id && self.mission_id == other.mission_id
    }
    /// The slot of this backlog's enable command in the private writer.
    pub(crate) fn slot(&self) -> String {
        slot(&self.mission_id)
    }
}
pub(crate) fn slot(mission_id: &str) -> String {
    format!("enable:{mission_id}")
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Model {
    Available(String),
    /// "not_found" or "catalog_unavailable".
    Unavailable(String),
    /// Exact configured IDs sharing the requested display name.
    Ambiguous(Vec<String>),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Readiness {
    Ready,
    /// A matching weekly rule exists and is reused unchanged.
    Existing,
    Blocked,
}

/// The confirmable command, exactly as the host offered it.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Frozen {
    /// The exact payload bytes the operation hash covers.
    pub(crate) text: String,
    pub(crate) model: String,
    pub(crate) thinking: Option<String>,
    pub(crate) recurrence: Recurrence,
    /// The existing report chat this command reuses.
    pub(crate) chat: Option<String>,
    pub(crate) reuses_schedule: bool,
    /// Inventory pages, history pages, entries per page.
    pub(crate) bounds: (u64, u64, u64),
    pub(crate) budget_usd: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Preflight {
    pub(crate) project_id: String,
    pub(crate) mission_id: String,
    pub(crate) target_id: String,
    pub(crate) readiness: Readiness,
    pub(crate) reason: Option<String>,
    pub(crate) model: Model,
    pub(crate) frozen: Option<Frozen>,
    pub(crate) next_at: Option<u64>,
}
impl Preflight {
    /// The native command for this exact confirmation, or None when nothing is confirmable.
    pub(crate) fn request(&self) -> Option<crate::insights::Request> {
        let frozen = self.frozen.as_ref()?;
        (self.readiness != Readiness::Blocked).then(|| crate::insights::Request::Enable {
            project_id: self.project_id.clone(),
            mission_id: self.mission_id.clone(),
            target_id: self.target_id.clone(),
            payload: frozen.text.clone(),
        })
    }
}

fn text(value: &Value, max: usize) -> Result<String, Failure> {
    value
        .as_str()
        .filter(|s| {
            !s.trim().is_empty() && s.chars().count() <= max && !s.chars().any(char::is_control)
        })
        .map(str::to_owned)
        .ok_or(INVALID)
}
fn id(value: &Value) -> Result<String, Failure> {
    value
        .as_str()
        .filter(|s| valid_id(s))
        .map(str::to_owned)
        .ok_or(INVALID)
}
fn number(value: &Value) -> Result<u64, Failure> {
    value.as_u64().filter(|n| *n <= MAX_NUMBER).ok_or(INVALID)
}
fn optional_number(value: Option<&Value>) -> Result<Option<u64>, Failure> {
    match value.ok_or(INVALID)? {
        Value::Null => Ok(None),
        n => number(n).map(Some),
    }
}
/// A host reason code: short snake case, displayed only through `reason_text`.
fn reason(value: Option<&Value>) -> Result<Option<String>, Failure> {
    match value.ok_or(INVALID)? {
        Value::Null => Ok(None),
        Value::String(s)
            if !s.is_empty()
                && s.len() <= 128
                && s.bytes()
                    .all(|b| b.is_ascii_lowercase() || b == b'_' || b.is_ascii_digit()) =>
        {
            Ok(Some(s.clone()))
        }
        // Rejected receipts carry host prose; keep it bounded and plain.
        Value::String(s) => Ok(Some(
            s.chars().filter(|c| !c.is_control()).take(512).collect(),
        )),
        _ => Err(INVALID),
    }
}
fn same_home(value: &Value, host: &Host) -> bool {
    // The journal's own lineage check: hostId names the producer's view, not the home.
    value["daemonId"] == host.daemon_id.as_str()
        && value["lineageId"] == host.lineage_id.as_str()
        && value["hostId"].as_str().is_some_and(valid_id)
        && value.as_object().is_some_and(|o| o.len() == 3)
}

fn model(value: &Value) -> Result<Model, Failure> {
    match value["state"].as_str() {
        Some("available") if value.as_object().is_some_and(|o| o.len() == 2) => {
            Ok(Model::Available(text(&value["id"], 512)?))
        }
        Some("unavailable") => match value["reason"].as_str() {
            Some(r @ ("not_found" | "catalog_unavailable")) => Ok(Model::Unavailable(r.into())),
            _ => Err(INVALID),
        },
        Some("ambiguous") => {
            let ids = value["ids"]
                .as_array()
                .filter(|ids| (2..=20).contains(&ids.len()))
                .ok_or(INVALID)?
                .iter()
                .map(|id| text(id, 512))
                .collect::<Result<Vec<_>, _>>()?;
            if (1..ids.len()).any(|i| ids[..i].contains(&ids[i])) {
                return Err(INVALID);
            }
            Ok(Model::Ambiguous(ids))
        }
        _ => Err(INVALID),
    }
}

const PAYLOAD_KEYS: [&str; 13] = [
    "projectId",
    "missionId",
    "expectedHome",
    "context",
    "model",
    "thinking",
    "recurrence",
    "scope",
    "bounds",
    "budget",
    "disclosure",
    "chat",
    "schedule",
];

/// Parse the host's payload without changing it. Unknown keys or values outside the
/// fixed weekly scope are malformed: confirmation must show what is actually sent.
fn frozen(
    p: &Value,
    project: &str,
    mission: &str,
    target: &str,
    host: &Host,
) -> Result<Frozen, Failure> {
    let object = p.as_object().ok_or(INVALID)?;
    if object.keys().any(|k| !PAYLOAD_KEYS.contains(&k.as_str()))
        || p["projectId"] != project
        || p["missionId"] != mission
        || p["disclosure"] != DISCLOSURE
        || !same_home(&p["expectedHome"], host)
        || p["scope"]
            != json!({"host":"local","projects":"admitted","includeArchived":true,"sourceAccess":"read_only","coverage":"partial"})
    {
        return Err(INVALID);
    }
    text(&p["context"], 256)?;
    let model = text(&p["model"], 512)?;
    let thinking = match p.get("thinking") {
        None => None,
        Some(t) => Some(text(t, 64)?),
    };
    let recurrence: Recurrence =
        serde_json::from_value(p["recurrence"].clone()).map_err(|_| INVALID)?;
    if !matches!(recurrence.every.as_str(), "day" | "week" | "month")
        || !crate::recurring_schedules::zone_name(&recurrence.time_zone)
        || recurrence.time.len() != 5
    {
        return Err(INVALID);
    }
    let bounds = &p["bounds"];
    let bounds = (
        number(&bounds["inventoryPages"])?,
        number(&bounds["historyPages"])?,
        number(&bounds["entriesPerPage"])?,
    );
    if p["bounds"].as_object().is_none_or(|o| o.len() != 3)
        || [bounds.0, bounds.1, bounds.2]
            .iter()
            .any(|n| !(1..=100).contains(n))
    {
        return Err(INVALID);
    }
    let budget = &p["budget"];
    let budget_usd = budget["usd"]
        .as_f64()
        .filter(|n| n.is_finite() && *n > 0. && *n <= 10_000.)
        .ok_or(INVALID)?;
    if budget.as_object().is_none_or(|o| o.len() != 4)
        || budget["period"] != "report"
        || budget["enforcement"] != "advisory"
        || budget["basis"] != "initial_assumption"
    {
        return Err(INVALID);
    }
    let chat = match &p["chat"] {
        Value::Null => None,
        c => {
            let session = id(&c["sessionId"])?;
            id(&c["grantId"])?;
            number(&c["revision"])?;
            number(&c["inputGeneration"])?;
            if session != target
                || c["model"] != model.as_str()
                || c.get("thinking") != p.get("thinking")
            {
                return Err(INVALID);
            }
            Some(session)
        }
    };
    let reuses_schedule = match &p["schedule"] {
        Value::Null => false,
        s => {
            id(&s["id"])?;
            number(&s["revision"])?;
            true
        }
    };
    let text = serde_json::to_string(p).map_err(|_| INVALID)?;
    if text.len() > PAYLOAD_CAP {
        return Err(INVALID);
    }
    Ok(Frozen {
        text,
        model,
        thinking,
        recurrence,
        chat,
        reuses_schedule,
        bounds,
        budget_usd,
    })
}

/// `explicit` is the model this read asked for; a fresh payload must honor it exactly.
pub(crate) fn preflight(
    value: &Value,
    backlog: &Backlog,
    host: &Host,
    explicit: Option<&str>,
) -> Result<Preflight, Failure> {
    if value["projectId"] != backlog.project_id.as_str()
        || value["missionId"] != backlog.mission_id.as_str()
        || value["cost"] != json!({"pricing":"unknown","spendUsd":null})
    {
        return Err(INVALID);
    }
    let target_id = id(&value["targetId"])?;
    // The pinned report is the only acceptable target; never a substitute.
    if backlog.report.as_ref().is_some_and(|r| r != &target_id) {
        return Err(SUBSTITUTE);
    }
    let readiness = match value["state"].as_str() {
        Some("ready") => Readiness::Ready,
        Some("existing") => Readiness::Existing,
        Some("blocked") => Readiness::Blocked,
        _ => return Err(INVALID),
    };
    let model = model(&value["model"])?;
    let reason = reason(value.get("reason"))?;
    let next_at = optional_number(value.get("nextAt"))?;
    let frozen = match value.get("payload").ok_or(INVALID)? {
        Value::Null => None,
        p => Some(frozen(
            p,
            &backlog.project_id,
            &backlog.mission_id,
            &target_id,
            host,
        )?),
    };
    match (&frozen, readiness) {
        (None, Readiness::Blocked) => {}
        (Some(f), Readiness::Ready | Readiness::Existing) => {
            if model != Model::Available(f.model.clone())
                || reason.is_some()
                || (readiness == Readiness::Existing) != f.reuses_schedule
                || (f.chat.is_none() && explicit.is_some_and(|m| m != f.model))
            {
                return Err(INVALID);
            }
        }
        _ => return Err(INVALID),
    }
    Ok(Preflight {
        project_id: backlog.project_id.clone(),
        mission_id: backlog.mission_id.clone(),
        target_id,
        readiness,
        reason,
        model,
        frozen,
        next_at,
    })
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Phase {
    ChatPending,
    ChatReady,
    SchedulePending,
    Enabled,
}
impl Phase {
    fn parse(value: &Value) -> Option<Self> {
        match value.as_str()? {
            "chat_pending" => Some(Self::ChatPending),
            "chat_ready" => Some(Self::ChatReady),
            "schedule_pending" => Some(Self::SchedulePending),
            "enabled" => Some(Self::Enabled),
            _ => None,
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Receipt {
    Unknown,
    /// The last durable step marker, which means entered, not completed.
    Pending(Option<Phase>),
    Accepted,
    Rejected(String),
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Current {
    NotFound,
    Partial,
    Unknown,
    Enabled,
    Blocked,
}
/// Passive status: the receipt plus a present recheck of both resources.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Status {
    pub(crate) receipt: Receipt,
    pub(crate) current: Current,
    pub(crate) session_id: String,
    pub(crate) schedule_id: Option<String>,
    pub(crate) next_at: Option<u64>,
    pub(crate) reason: Option<String>,
}
/// The status of exactly this operation; a receipt for any other bytes is malformed.
pub(crate) fn status(value: &Value, op: &Operation) -> Result<Status, Failure> {
    let receipt = &value["receipt"];
    let receipt = match receipt["state"].as_str() {
        Some("unknown") if receipt.as_object().is_some_and(|o| o.len() == 1) => Receipt::Unknown,
        state => {
            if receipt["operationId"] != op.operation_id.as_str()
                || receipt["payloadHash"] != op.payload_hash.as_str()
                || receipt["targetId"] != op.target_id.as_str()
                || serde_json::to_value(&op.destination).ok().as_ref()
                    != Some(&receipt["destination"])
            {
                return Err(INVALID);
            }
            match state {
                Some("pending") => Receipt::Pending(Phase::parse(&receipt["result"]["phase"])),
                Some("accepted")
                    if crate::insights::valid_enable_result(op, &receipt["result"]) =>
                {
                    Receipt::Accepted
                }
                Some("rejected") => Receipt::Rejected(
                    reason(receipt.get("reason"))?.unwrap_or_else(|| "refused".into()),
                ),
                _ => return Err(INVALID),
            }
        }
    };
    let current = match value["state"].as_str() {
        Some("not_found") => Current::NotFound,
        Some("partial") => Current::Partial,
        Some("unknown") => Current::Unknown,
        Some("enabled") => Current::Enabled,
        Some("blocked") => Current::Blocked,
        _ => return Err(INVALID),
    };
    if value["sessionId"] != op.target_id.as_str()
        || (current == Current::NotFound) != (receipt == Receipt::Unknown)
        || (current == Current::Enabled && receipt != Receipt::Accepted)
    {
        return Err(INVALID);
    }
    let schedule_id = match value.get("scheduleId").ok_or(INVALID)? {
        Value::Null => None,
        s => Some(id(s)?),
    };
    Ok(Status {
        receipt,
        current,
        session_id: op.target_id.clone(),
        schedule_id,
        next_at: optional_number(value.get("nextAt"))?,
        reason: reason(value.get("reason"))?,
    })
}

/// Short words for a host reason code. Unknown codes stay generic, never guessed.
pub(crate) fn reason_text(code: &str) -> &'static str {
    match code {
        "enable_pending_use_status" => "An earlier enable is still unconfirmed. Check it first.",
        "model_unavailable" | "model_not_found" | "model_catalog_unavailable" => {
            "Terra 6.1 isn't available in this project. Nothing else is used instead."
        }
        "model_ambiguous" => "More than one model is named Terra 6.1. Choose one.",
        "thinking_unavailable" => "The report chat's thinking level isn't available.",
        "existing_model_choice_differs" => "The report chat already uses another model.",
        "report_chat_unavailable" => "The report chat is archived or its access was revoked.",
        "multiple_report_chats" => "More than one report chat uses this backlog.",
        "multiple_recurring_rules" => "The report chat has more than one repeating automation.",
        "existing_rule_not_ready" => {
            "Its weekly automation is paused or running. Check Automations."
        }
        "existing_rule_identity_unavailable" => {
            "An older automation sends to the report chat. Remove it in Automations first."
        }
        "preflight_changed" => "Something changed while checking. Try again.",
        "binding_unavailable" => "This backlog isn't an active mission in its project.",
        "scheduling_unavailable" => "Scheduling is unavailable. Automations may be off.",
        "report_target_retired" => "The earlier report chat was retired.",
        "schedule_changed" => "The weekly automation changed or was removed.",
        "schedule_unresolved" => "Report chat ready. The weekly automation isn't confirmed.",
        "report_identity_unavailable" => {
            "The linked report chat isn't available. Nothing new was set up."
        }
        "report_binding_mismatch" => "The report chat belongs to another backlog.",
        _ => "Weekly Insights can't be enabled right now.",
    }
}

/// What the confirmation can show before any write.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Gate {
    /// This Local predates the enable interface.
    Unsupported,
    /// The global Automations opt-in is off; it is never switched here.
    AutomationsOff,
    Checked(Box<Preflight>),
}

fn spawn<T: Send + 'static>(
    name: &str,
    failed: T,
    work: impl FnOnce(reqwest::Client, tokio::runtime::Runtime) -> T + Send + 'static,
) -> Option<async_channel::Receiver<T>> {
    let (tx, rx) = async_channel::bounded(1);
    std::thread::Builder::new()
        .name(name.into())
        .spawn(move || {
            let reply = match (
                tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build(),
                crate::chat_settings::client(),
            ) {
                (Ok(runtime), Ok(client)) => work(client, runtime),
                _ => failed,
            };
            let _ = tx.send_blocking(reply);
        })
        .ok()?;
    Some(rx)
}

/// Pinned hello, then the passive preflight. Never writes.
pub(crate) fn read_preflight(
    options: LocalOptions,
    backlog: Backlog,
    explicit: Option<String>,
) -> Option<async_channel::Receiver<Result<Gate, Failure>>> {
    spawn(
        "local-insights-preflight",
        Err("Couldn't start the Insights check."),
        move |client, runtime| {
            runtime.block_on(async {
                let hello = crate::local_client::hello(&client, &options).await?;
                if !supported(&hello) {
                    return Ok(Gate::Unsupported);
                }
                if !automations_on(&hello) {
                    return Ok(Gate::AutomationsOff);
                }
                let mut query = vec![
                    ("projectId", backlog.project_id.as_str()),
                    ("missionId", backlog.mission_id.as_str()),
                ];
                if let Some(model) = &explicit {
                    query.push(("model", model));
                }
                if let Some(report) = &backlog.report {
                    query.push(("reportSessionId", report));
                }
                let response = client
                    .get(format!(
                        "{}/api/insights/enable/preflight",
                        options.loopback()
                    ))
                    .query(&query)
                    .send()
                    .await
                    .map_err(|_| "Couldn't check Insights setup on Local.")?;
                let code = response.status().as_u16();
                let value = crate::insights::body(response).await;
                match code {
                    200 => preflight(&value?, &backlog, &options.host(), explicit.as_deref())
                        .map(|p| Gate::Checked(Box::new(p))),
                    404 | 409 => Err("This backlog isn't an active mission on this Local."),
                    405 | 501 => Ok(Gate::Unsupported),
                    503 => Err("Weekly Insights is unavailable on this Local."),
                    _ => Err("Local refused the Insights check."),
                }
            })
        },
    )
}

/// Passive status of a retained command. It never executes or resumes a step.
pub(crate) fn read_status(
    options: LocalOptions,
    op: Operation,
) -> Option<async_channel::Receiver<Result<Status, Failure>>> {
    spawn(
        "local-insights-status",
        Err("Couldn't start the Insights status read."),
        move |client, runtime| {
            runtime.block_on(async {
                crate::local_client::gate(&client, &options).await?;
                let value = post_status(&client, &options, &op).await?;
                status(&value, &op)
            })
        },
    )
}

async fn post_status(
    client: &reqwest::Client,
    options: &LocalOptions,
    op: &Operation,
) -> Result<Value, Failure> {
    let encoded = serde_json::to_vec(op).map_err(|_| "Cannot encode the Insights command.")?;
    let response = client
        .post(format!("{}/api/insights/enable/status", options.loopback()))
        .header("Content-Type", "application/json")
        .body(encoded)
        .send()
        .await
        .map_err(|_| "Couldn't read Insights status.")?;
    if response.status() != reqwest::StatusCode::OK {
        return Err("Local refused the Insights status read.");
    }
    crate::insights::body(response).await
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
        Err(_) => Outcome::Unknown("Couldn't check the Insights action. Try again."),
    }
}

/// Active missions defined on this Local, by exact identity, for the backlog choice.
pub(crate) fn read_backlogs(
    options: LocalOptions,
) -> Option<async_channel::Receiver<Result<Vec<Backlog>, Failure>>> {
    spawn(
        "local-insights-backlogs",
        Err("Couldn't start the mission read."),
        move |client, runtime| {
            runtime.block_on(async {
                let local = crate::mission_browser::Home::local(&options.host());
                match crate::mission_reader::fetch(
                    &client,
                    &options,
                    &crate::mission_reader::Route::Catalog,
                )
                .await?
                {
                    crate::mission_reader::Data::Catalog(catalog) => Ok(backlogs(&catalog, &local)),
                    _ => Err("Couldn't read missions."),
                }
            })
        },
    )
}
pub(crate) fn backlogs(
    catalog: &crate::mission_browser::Catalog,
    local: &crate::mission_browser::Home,
) -> Vec<Backlog> {
    catalog
        .rows
        .iter()
        .filter(|r| r.status == "active" && r.local_definition(local))
        .filter_map(|r| {
            let project = r
                .sources
                .iter()
                .find(|s| s.canonical && &s.home == local)?
                .project
                .clone();
            Some(Backlog {
                project_id: project,
                mission_id: r.key.id.clone(),
                title: Some(r.title.clone()),
                report: None,
            })
        })
        .take(50)
        .collect()
}

#[cfg(test)]
#[path = "insights_enable_tests.rs"]
mod tests;

/// Synthetic host replies for unit tests and hidden probes only.
#[cfg(any(test, feature = "native-probes"))]
pub(crate) mod fixture {
    use serde_json::{Value, json};
    pub(crate) const TARGET: &str = "5b0c3f3e-7d1a-5c2b-a1d4-0e9f8a7b6c5d";
    pub(crate) const TERRA: &str = "terra/terra-6.1";
    /// Friday 6 November 2026, 18:00 in Paris.
    pub(crate) const NEXT: u64 = 1_793_984_400_000;
    pub(crate) fn payload(
        project: &str,
        mission: &str,
        model: &str,
        chat: Value,
        schedule: Value,
    ) -> Value {
        json!({
            "projectId": project, "missionId": mission,
            "expectedHome": {"hostId":"daemon","daemonId":"test-daemon","lineageId":"test-lineage"},
            "context": "c0ffee", "model": model,
            "recurrence": {"every":"week","weekday":5,"time":"18:00","timeZone":"Europe/Paris"},
            "scope": {"host":"local","projects":"admitted","includeArchived":true,"sourceAccess":"read_only","coverage":"partial"},
            "bounds": {"inventoryPages":1,"historyPages":2,"entriesPerPage":4},
            "budget": {"usd":5,"period":"report","enforcement":"advisory","basis":"initial_assumption"},
            "disclosure": "insights-weekly-v1",
            "chat": chat, "schedule": schedule
        })
    }
    pub(crate) fn chat(target: &str, model: &str) -> Value {
        json!({"sessionId":target,"grantId":"grant-1","revision":1,"inputGeneration":0,"model":model})
    }
    /// Ready, or existing when a schedule is reused. `chat` reuses that report chat.
    pub(crate) fn offer(
        project: &str,
        mission: &str,
        model: &str,
        target: &str,
        chat: Value,
        schedule: Value,
    ) -> Value {
        json!({
            "projectId": project, "missionId": mission, "targetId": target,
            "cost": {"pricing":"unknown","spendUsd":null},
            "model": {"state":"available","id":model},
            "state": if schedule.is_null() { "ready" } else { "existing" },
            "reason": null, "nextAt": NEXT,
            "payload": payload(project, mission, model, chat, schedule)
        })
    }
    pub(crate) fn ready(project: &str, mission: &str, model: &str) -> Value {
        offer(project, mission, model, TARGET, Value::Null, Value::Null)
    }
    pub(crate) fn blocked(project: &str, mission: &str, model: Value, reason: &str) -> Value {
        json!({
            "projectId": project, "missionId": mission, "targetId": TARGET,
            "cost": {"pricing":"unknown","spendUsd":null},
            "model": model, "state": "blocked", "reason": reason, "nextAt": null, "payload": null
        })
    }
    /// The status route's reply for an exact envelope.
    pub(crate) fn status(
        op: &crate::delivery_store::Operation,
        receipt: &str,
        result: Value,
        state: &str,
        reason: Option<&str>,
    ) -> Value {
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
        json!({"receipt":receipt,"state":state,"sessionId":op.target_id,
            "scheduleId": if state == "not_found" { Value::Null } else { json!("7c1d2e3f-4a5b-5c6d-a7e8-f90a1b2c3d4e") },
            "nextAt": if state == "enabled" { json!(NEXT) } else { Value::Null },
            "reason": reason})
    }
    pub(crate) fn enabled(op: &crate::delivery_store::Operation) -> Value {
        let model: Value = serde_json::from_str::<Value>(&op.payload)
            .map(|p| p["model"].clone())
            .unwrap_or_default();
        json!({"phase":"enabled","sessionId":op.target_id,"scheduleId":"7c1d2e3f-4a5b-5c6d-a7e8-f90a1b2c3d4e",
            "chat":chat(&op.target_id, model.as_str().unwrap_or(TERRA))})
    }
}
