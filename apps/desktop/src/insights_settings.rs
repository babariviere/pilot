//! Insights review settings over the host's two native contracts: the passive settings
//! snapshot and Apply preview reads, the native-built `insights-settings` Save payload and
//! the verbatim `insights-apply` preview payload. Save persists desired values only; it never
//! changes a grant, chat model or weekly rule. Apply is a separate confirmed operation.
//! Accepted and pending receipts are checked against the exact frozen intent.
use crate::{
    delivery_store::{Failure, Host, Operation},
    insights::Request,
    insights_enable::{self as weekly, Model},
    local_client::LocalOptions,
    local_model::valid_id,
    scheduled_messages::Recurrence,
};
use serde_json::{Value, json};

pub(crate) const SETTINGS_KIND: &str = "insights-settings";
pub(crate) const APPLY_KIND: &str = "insights-apply";
/// The host's durable operation payload limit.
pub(crate) const PAYLOAD_CAP: usize = 64 * 1024;
const INVALID: Failure = "Local returned malformed Insights settings.";
const MAX_NUMBER: u64 = 9_007_199_254_740_990;
/// Host bounds: inventory pages, history pages, entries per page.
pub(crate) const INVENTORY: (u64, u64) = (1, 4);
pub(crate) const HISTORY: (u64, u64) = (2, 8);
pub(crate) const ENTRIES: (u64, u64) = (1, 20);
/// Unique IDs per source list.
pub(crate) const LIST_CAP: usize = 100;

/// Both interfaces, on the pinned Local. Neither is a grant or a scheduler switch.
pub(crate) fn supported(hello: &Value) -> bool {
    hello["capabilities"]["insightsSettings"].as_u64() == Some(1)
        && hello["capabilities"]["insightsApply"].as_u64() == Some(1)
}
pub(crate) fn settings_slot(session: &str) -> String {
    format!("settings:{session}")
}
pub(crate) fn apply_slot(session: &str) -> String {
    format!("apply:{session}")
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
fn keys(value: &Value, expected: &[&str]) -> bool {
    value
        .as_object()
        .is_some_and(|o| o.len() == expected.len() && expected.iter().all(|k| o.contains_key(*k)))
}
/// Host project IDs: ASCII word characters, at most 128.
pub(crate) fn project_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
/// Host chat exclusions: canonical UUIDs, either case.
fn session_uuid(s: &str) -> bool {
    uuid::Uuid::parse_str(s).is_ok() && s.len() == 36
}
fn ids(value: &Value, valid: fn(&str) -> bool) -> Result<Vec<String>, Failure> {
    let list = value
        .as_array()
        .filter(|l| l.len() <= LIST_CAP)
        .ok_or(INVALID)?;
    let mut out: Vec<String> = Vec::with_capacity(list.len());
    for v in list {
        let s = v.as_str().filter(|s| valid(s)).ok_or(INVALID)?;
        if out.iter().any(|o| o == s) {
            return Err(INVALID);
        }
        out.push(s.to_owned());
    }
    Ok(out)
}

/// The requested model: an exact configured ID, or a unique display name.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Requested {
    pub(crate) by_name: bool,
    pub(crate) value: String,
}

/// Desired review settings, exactly the host's `InsightsReviewSettings`.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Settings {
    /// ISO weekday, 1 = Monday.
    pub(crate) weekday: u8,
    /// "HH:MM".
    pub(crate) time: String,
    pub(crate) zone: String,
    pub(crate) model: Requested,
    /// None reads every admitted project; Some lists the only projects read.
    pub(crate) projects: Option<Vec<String>>,
    pub(crate) include_archived: bool,
    pub(crate) exclude_projects: Vec<String>,
    pub(crate) exclude_sessions: Vec<String>,
    /// Inventory pages, history pages, entries per page.
    pub(crate) bounds: (u64, u64, u64),
    pub(crate) budget_usd: f64,
    pub(crate) monthly: bool,
    /// "user_choice" once the user set the budget; otherwise the initial assumption.
    pub(crate) user_budget: bool,
}
fn time_ok(t: &str) -> bool {
    let b = t.as_bytes();
    b.len() == 5
        && b[2] == b':'
        && [0, 1, 3, 4].iter().all(|&i| b[i].is_ascii_digit())
        && (b[0] - b'0') * 10 + (b[1] - b'0') < 24
        && (b[3] - b'0') * 10 + (b[4] - b'0') < 60
}
fn within(n: u64, (lo, hi): (u64, u64)) -> bool {
    (lo..=hi).contains(&n)
}
impl Settings {
    pub(crate) fn parse(v: &Value) -> Result<Self, Failure> {
        if !keys(
            v,
            &["recurrence", "requestedModel", "scope", "bounds", "budget"],
        ) {
            return Err(INVALID);
        }
        let r = &v["recurrence"];
        if !keys(r, &["every", "weekday", "time", "timeZone"]) || r["every"] != "week" {
            return Err(INVALID);
        }
        let weekday = r["weekday"]
            .as_u64()
            .filter(|d| (1..=7).contains(d))
            .ok_or(INVALID)? as u8;
        let time = r["time"]
            .as_str()
            .filter(|t| time_ok(t))
            .ok_or(INVALID)?
            .to_owned();
        let zone = r["timeZone"]
            .as_str()
            .filter(|z| crate::recurring_schedules::zone_name(z))
            .ok_or(INVALID)?
            .to_owned();
        let m = &v["requestedModel"];
        if !keys(m, &["kind", "value"]) {
            return Err(INVALID);
        }
        let model = Requested {
            by_name: match m["kind"].as_str() {
                Some("id") => false,
                Some("name") => true,
                _ => return Err(INVALID),
            },
            value: text(&m["value"], 512)?,
        };
        let s = &v["scope"];
        if !keys(
            s,
            &[
                "host",
                "projects",
                "includeArchived",
                "excludeProjects",
                "excludeSessions",
                "sourceAccess",
                "coverage",
            ],
        ) || s["host"] != "local"
            || s["sourceAccess"] != "read_only"
            || s["coverage"] != "partial"
        {
            return Err(INVALID);
        }
        let projects = match &s["projects"] {
            Value::String(a) if a == "admitted" => None,
            list => Some(ids(list, project_id)?),
        };
        let b = &v["bounds"];
        if !keys(b, &["inventoryPages", "historyPages", "entriesPerPage"]) {
            return Err(INVALID);
        }
        let bounds = (
            number(&b["inventoryPages"])?,
            number(&b["historyPages"])?,
            number(&b["entriesPerPage"])?,
        );
        let u = &v["budget"];
        if !keys(u, &["usd", "period", "enforcement", "basis"]) || u["enforcement"] != "advisory" {
            return Err(INVALID);
        }
        let settings = Self {
            weekday,
            time,
            zone,
            model,
            projects,
            include_archived: s["includeArchived"].as_bool().ok_or(INVALID)?,
            exclude_projects: ids(&s["excludeProjects"], project_id)?,
            exclude_sessions: ids(&s["excludeSessions"], session_uuid)?,
            bounds,
            budget_usd: u["usd"].as_f64().ok_or(INVALID)?,
            monthly: match u["period"].as_str() {
                Some("report") => false,
                Some("month") => true,
                _ => return Err(INVALID),
            },
            user_budget: match u["basis"].as_str() {
                Some("initial_assumption") => false,
                Some("user_choice") => true,
                _ => return Err(INVALID),
            },
        };
        settings.validate().map_err(|_| INVALID)?;
        Ok(settings)
    }
    /// The host's own bounds, before anything is confirmed.
    pub(crate) fn validate(&self) -> Result<(), Failure> {
        if !(1..=7).contains(&self.weekday) || !time_ok(&self.time) {
            return Err("Choose a day and a time.");
        }
        if !crate::recurring_schedules::zone_name(&self.zone) {
            return Err("Enter a time zone such as Europe/Paris.");
        }
        if self.model.value.trim().is_empty()
            || self.model.value.len() > 512
            || self.model.value.chars().any(char::is_control)
        {
            return Err("Choose a model.");
        }
        let (i, h, e) = self.bounds;
        if !within(i, INVENTORY) || !within(h, HISTORY) || !within(e, ENTRIES) {
            return Err("The sample is outside Local's bounds.");
        }
        if !(self.budget_usd.is_finite() && self.budget_usd > 0. && self.budget_usd <= 10_000.) {
            return Err("Enter a budget between $0.01 and $10,000.");
        }
        let lists = [
            self.projects.as_deref().unwrap_or(&[]),
            &self.exclude_projects,
            &self.exclude_sessions,
        ];
        if lists.iter().any(|l| l.len() > LIST_CAP)
            || lists
                .iter()
                .any(|l| (1..l.len()).any(|i| l[..i].contains(&l[i])))
        {
            return Err("Too many projects or chats are listed.");
        }
        Ok(())
    }
    pub(crate) fn recurrence(&self) -> Recurrence {
        Recurrence {
            every: "week".into(),
            time: self.time.clone(),
            time_zone: self.zone.clone(),
            weekdays: None,
            weekday: Some(self.weekday),
            day_of_month: None,
        }
    }
    /// Exactly the host schema: no added, dropped or defaulted keys.
    pub(crate) fn to_value(&self) -> Value {
        // A whole-dollar budget stays an integer, as the host wrote it.
        let usd = if self.budget_usd.fract() == 0. && self.budget_usd <= 10_000. {
            json!(self.budget_usd as u64)
        } else {
            json!(self.budget_usd)
        };
        json!({
            "recurrence": {"every":"week","weekday":self.weekday,"time":self.time,"timeZone":self.zone},
            "requestedModel": {"kind": if self.model.by_name { "name" } else { "id" }, "value": self.model.value},
            "scope": {
                "host": "local",
                "projects": match &self.projects { None => json!("admitted"), Some(p) => json!(p) },
                "includeArchived": self.include_archived,
                "excludeProjects": self.exclude_projects,
                "excludeSessions": self.exclude_sessions,
                "sourceAccess": "read_only",
                "coverage": "partial"
            },
            "bounds": {"inventoryPages":self.bounds.0,"historyPages":self.bounds.1,"entriesPerPage":self.bounds.2},
            "budget": {
                "usd": usd,
                "period": if self.monthly { "month" } else { "report" },
                "enforcement": "advisory",
                "basis": if self.user_budget { "user_choice" } else { "initial_assumption" }
            }
        })
    }
}

/// The report chat's exact admitted identity, as the host returned it.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Chat {
    pub(crate) value: Value,
    pub(crate) model: String,
    /// None means the chat follows its default thinking.
    pub(crate) thinking: Option<String>,
}
fn chat(value: &Value, session: &str) -> Result<Chat, Failure> {
    let o = value.as_object().ok_or(INVALID)?;
    if o.keys().any(|k| {
        ![
            "sessionId",
            "grantId",
            "revision",
            "inputGeneration",
            "model",
            "thinking",
        ]
        .contains(&k.as_str())
    }) || value["sessionId"] != session
    {
        return Err(INVALID);
    }
    id(&value["grantId"])?;
    number(&value["revision"])?;
    number(&value["inputGeneration"])?;
    Ok(Chat {
        value: value.clone(),
        model: text(&value["model"], 512)?,
        thinking: match value.get("thinking") {
            None => None,
            Some(t) => Some(text(t, 64)?),
        },
    })
}

/// GET settings: identity fences, the desired revision and the requested model's resolution.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Snapshot {
    pub(crate) session_id: String,
    pub(crate) project_id: String,
    pub(crate) mission_id: String,
    expected_home: Value,
    context: String,
    pub(crate) chat: Chat,
    /// Zero is an unsaved suggestion.
    pub(crate) revision: u64,
    pub(crate) settings: Settings,
    pub(crate) model: Model,
    /// The next occurrence these desired settings would have; not a scheduled run.
    pub(crate) next_at: Option<u64>,
}
pub(crate) fn snapshot(value: &Value, session: &str, host: &Host) -> Result<Snapshot, Failure> {
    if !keys(
        value,
        &[
            "projectId",
            "missionId",
            "expectedHome",
            "context",
            "chat",
            "revision",
            "settings",
            "model",
            "nextAt",
            "cost",
            "activationRequired",
        ],
    ) || value["cost"] != json!({"pricing":"unknown","spendUsd":null})
        || value["activationRequired"] != true
        || !weekly::same_home(&value["expectedHome"], host)
    {
        return Err(INVALID);
    }
    Ok(Snapshot {
        session_id: session.to_owned(),
        project_id: id(&value["projectId"])?,
        mission_id: id(&value["missionId"])?,
        expected_home: value["expectedHome"].clone(),
        context: text(&value["context"], 256)?,
        chat: chat(&value["chat"], session)?,
        revision: number(&value["revision"])?,
        settings: Settings::parse(&value["settings"])?,
        model: weekly::model(&value["model"])?,
        next_at: match &value["nextAt"] {
            Value::Null => None,
            n => Some(number(n)?),
        },
    })
}
impl Snapshot {
    /// The host's hash of storage home, project path and exact backlog.
    pub(crate) fn context(&self) -> &str {
        &self.context
    }
    /// The Save command for this exact snapshot: identity verbatim, CAS on its revision.
    pub(crate) fn request(&self, settings: &Settings) -> Result<Request, Failure> {
        settings.validate()?;
        let payload = json!({
            "projectId": self.project_id,
            "missionId": self.mission_id,
            "expectedHome": self.expected_home,
            "context": self.context,
            "chat": self.chat.value,
            "expectedRevision": self.revision,
            "settings": settings.to_value(),
        });
        let payload = serde_json::to_string(&payload).map_err(|_| INVALID)?;
        if payload.len() > PAYLOAD_CAP {
            return Err("These settings are too large to save.");
        }
        Ok(Request::Settings {
            project_id: self.project_id.clone(),
            mission_id: self.mission_id.clone(),
            target_id: self.session_id.clone(),
            payload,
        })
    }
}

/// A weekly rule exactly as the Apply preview names it.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Rule {
    pub(crate) id: String,
    pub(crate) revision: u64,
    pub(crate) title: String,
    pub(crate) recurrence: Recurrence,
    /// The settings revision the rule was created for; None is the original fixed rule.
    pub(crate) settings_revision: Option<u64>,
}
fn rule(value: &Value, session: &str) -> Result<Rule, Failure> {
    let target = &value["target"];
    if target["kind"] != "message"
        || target["sessionId"] != session
        || value["trigger"] != "recurring"
        || value["state"] != "pending"
        || value.get("paused").is_some_and(|p| p != false)
    {
        return Err(INVALID);
    }
    let recurrence: Recurrence =
        serde_json::from_value(value["recurrence"].clone()).map_err(|_| INVALID)?;
    Ok(Rule {
        id: id(&value["id"])?,
        revision: number(&value["revision"])?,
        title: value["title"]
            .as_str()
            .filter(|t| t.chars().count() <= 2000)
            .ok_or(INVALID)?
            .to_owned(),
        recurrence,
        settings_revision: match value.get("insightsSettingsRevision") {
            None => None,
            Some(n) => Some(number(n)?),
        },
    })
}

/// The host's deterministic replacement rule ID for this report and settings revision.
pub(crate) fn replacement_id(session: &str, revision: u64) -> String {
    let h = crate::delivery_store::hash(&format!("insights-apply:{session}:{revision}"));
    format!(
        "{}-{}-5{}-a{}-{}",
        &h[..8],
        &h[8..12],
        &h[13..16],
        &h[17..20],
        &h[20..32]
    )
}

/// The confirmable Apply, exactly as the host previewed it.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Frozen {
    /// The exact payload bytes the operation hash covers.
    pub(crate) text: String,
    pub(crate) project_id: String,
    pub(crate) mission_id: String,
    pub(crate) revision: u64,
    /// The exact resolved model the record names.
    pub(crate) model: String,
    pub(crate) settings: Settings,
    pub(crate) chat: Chat,
    pub(crate) rule: Option<Rule>,
    /// The previewed rule already carries this revision and cadence: kept unchanged.
    pub(crate) keeps_rule: bool,
    /// The rule this Apply leaves in place or creates.
    pub(crate) schedule_id: String,
}
const APPLY_KEYS: [&str; 7] = [
    "projectId",
    "missionId",
    "expectedHome",
    "context",
    "chat",
    "record",
    "rule",
];
fn frozen(p: &Value, session: &str, host: &Host) -> Result<Frozen, Failure> {
    if !weekly::same_home(&p["expectedHome"], host) {
        return Err(INVALID);
    }
    frozen_body(p, session)
}
/// The payload's own shape; the destination home is checked by the caller.
fn frozen_body(p: &Value, session: &str) -> Result<Frozen, Failure> {
    if !keys(p, &APPLY_KEYS) {
        return Err(INVALID);
    }
    text(&p["context"], 256)?;
    let record = &p["record"];
    if !keys(record, &["revision", "settings", "model"]) {
        return Err(INVALID);
    }
    let revision = number(&record["revision"])
        .ok()
        .filter(|r| *r > 0)
        .ok_or(INVALID)?;
    let settings = Settings::parse(&record["settings"])?;
    let model = text(&record["model"], 512)?;
    if !settings.model.by_name && settings.model.value != model {
        return Err(INVALID);
    }
    let rule = match &p["rule"] {
        Value::Null => None,
        r => Some(rule(r, session)?),
    };
    let keeps_rule = rule.as_ref().is_some_and(|r| {
        r.settings_revision == Some(revision)
            && p["rule"]["recurrence"] == record["settings"]["recurrence"]
    });
    let schedule_id = match (&rule, keeps_rule) {
        (Some(r), true) => r.id.clone(),
        _ => replacement_id(session, revision),
    };
    let text = serde_json::to_string(p).map_err(|_| INVALID)?;
    if text.len() > PAYLOAD_CAP {
        return Err(INVALID);
    }
    Ok(Frozen {
        text,
        project_id: id(&p["projectId"])?,
        mission_id: id(&p["missionId"])?,
        revision,
        model,
        settings,
        chat: chat(&p["chat"], session)?,
        rule,
        keeps_rule,
        schedule_id,
    })
}
impl Frozen {
    /// A retained Apply's frozen values, from its own bytes and destination.
    pub(crate) fn from_operation(op: &Operation) -> Option<Self> {
        if op.kind != APPLY_KIND {
            return None;
        }
        let p: Value = serde_json::from_str(&op.payload).ok()?;
        frozen(&p, &op.target_id, &op.destination).ok()
    }
    pub(crate) fn request(&self, session: &str) -> Request {
        Request::Apply {
            project_id: self.project_id.clone(),
            mission_id: self.mission_id.clone(),
            target_id: session.to_owned(),
            payload: self.text.clone(),
        }
    }
    /// The report chat's model changes before the rule does.
    pub(crate) fn changes_model(&self) -> bool {
        self.chat.model != self.model
    }
}

/// A retained Save payload: exact keys, this report and backlog, valid settings.
pub(crate) fn settings_payload_ok(text: &str, project: &str, mission: &str, target: &str) -> bool {
    let Ok(p) = serde_json::from_str::<Value>(text) else {
        return false;
    };
    text.len() <= PAYLOAD_CAP
        && valid_id(project)
        && valid_id(mission)
        && valid_id(target)
        && keys(
            &p,
            &[
                "projectId",
                "missionId",
                "expectedHome",
                "context",
                "chat",
                "expectedRevision",
                "settings",
            ],
        )
        && p["projectId"] == project
        && p["missionId"] == mission
        && p["expectedHome"].as_object().is_some_and(|o| o.len() == 3)
        && text_ok(&p["context"])
        && chat(&p["chat"], target).is_ok()
        && number(&p["expectedRevision"]).is_ok()
        && Settings::parse(&p["settings"]).is_ok()
}
/// A retained Apply payload: the preview's shape, this report and backlog.
pub(crate) fn apply_payload_ok(text: &str, project: &str, mission: &str, target: &str) -> bool {
    let Ok(p) = serde_json::from_str::<Value>(text) else {
        return false;
    };
    text.len() <= PAYLOAD_CAP
        && valid_id(target)
        && p["expectedHome"].as_object().is_some_and(|o| o.len() == 3)
        && frozen_body(&p, target).is_ok_and(|f| f.project_id == project && f.mission_id == mission)
}
fn text_ok(value: &Value) -> bool {
    text(value, 256).is_ok()
}

/// GET apply: ready with the exact payload, or blocked with the host's reason.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Preview {
    pub(crate) reason: Option<String>,
    pub(crate) frozen: Option<Frozen>,
    pub(crate) next_at: Option<u64>,
}
pub(crate) fn preview(value: &Value, session: &str, host: &Host) -> Result<Preview, Failure> {
    if !keys(value, &["state", "reason", "payload", "nextAt", "cost"])
        || value["cost"] != json!({"pricing":"unknown","spendUsd":null})
    {
        return Err(INVALID);
    }
    let reason = weekly::reason(value.get("reason"))?;
    let next_at = match &value["nextAt"] {
        Value::Null => None,
        n => Some(number(n)?),
    };
    match (value["state"].as_str(), &value["payload"]) {
        (Some("ready"), p) if !p.is_null() && reason.is_none() => Ok(Preview {
            reason,
            frozen: Some(frozen(p, session, host)?),
            next_at,
        }),
        (Some("blocked"), Value::Null) => Ok(Preview {
            reason: Some(reason.unwrap_or_else(|| "Apply isn't available.".into())),
            frozen: None,
            next_at: None,
        }),
        _ => Err(INVALID),
    }
}

/// Settings: absent or exactly `{phase:"settings_pending"}`, which means entered, not saved.
pub(crate) fn valid_settings_pending(result: Option<&Value>) -> bool {
    match result {
        None | Some(Value::Null) => true,
        Some(r) => *r == json!({"phase":"settings_pending"}),
    }
}
/// Settings: the saved record for exactly these bytes, one revision after its CAS.
pub(crate) fn valid_settings_result(op: &Operation, result: &Value) -> bool {
    let Ok(p) = serde_json::from_str::<Value>(&op.payload) else {
        return false;
    };
    let (Ok(settings), Ok(sent)) = (
        Settings::parse(&result["settings"]),
        Settings::parse(&p["settings"]),
    ) else {
        return false;
    };
    keys(result, &["revision", "settings", "model"])
        && p["expectedRevision"].as_u64().map(|r| r + 1) == result["revision"].as_u64()
        && settings == sent
        && result["settings"] == p["settings"]
        && text(&result["model"], 512).is_ok_and(|m| sent.model.by_name || m == sent.model.value)
}
const APPLY_PHASES: [&str; 6] = [
    "model_pending",
    "model_ready",
    "cancel_pending",
    "rule_cancelled",
    "schedule_pending",
    "applied",
];
/// Apply progress for exactly this command: the report chat, the planned rule and revision.
fn valid_apply_progress(op: &Operation, result: &Value, accepted: bool) -> bool {
    let Ok(p) = serde_json::from_str::<Value>(&op.payload) else {
        return false;
    };
    let Some(phase) = result["phase"]
        .as_str()
        .filter(|ph| APPLY_PHASES.contains(ph))
    else {
        return false;
    };
    if (phase == "applied") != accepted
        || result.as_object().is_none_or(|o| {
            o.keys().any(|k| {
                ![
                    "phase",
                    "chat",
                    "scheduleId",
                    "settingsRevision",
                    "cancelledRule",
                ]
                .contains(&k.as_str())
            })
        })
    {
        return false;
    }
    let Ok(f) = frozen(&p, &op.target_id, &op.destination) else {
        return false;
    };
    let c = &result["chat"];
    // The confirmed chat until a model change settles; then the same grant on the record's model.
    let chat_ok = if phase == "model_pending" || !f.changes_model() {
        *c == f.chat.value
    } else {
        c["sessionId"] == op.target_id.as_str()
            && c["grantId"] == f.chat.value["grantId"]
            && c["model"] == f.model.as_str()
    };
    let cancelled_ok = match result.get("cancelledRule") {
        None => true,
        Some(r) => {
            ["rule_cancelled", "schedule_pending", "applied"].contains(&phase)
                && !f.keeps_rule
                && f.rule
                    .as_ref()
                    .is_some_and(|rule| r["id"] == rule.id.as_str())
        }
    };
    chat_ok
        && cancelled_ok
        && result["scheduleId"] == f.schedule_id.as_str()
        && result["settingsRevision"].as_u64() == Some(f.revision)
}
pub(crate) fn valid_apply_result(op: &Operation, result: &Value) -> bool {
    valid_apply_progress(op, result, true)
}
pub(crate) fn valid_apply_pending(op: &Operation, result: Option<&Value>) -> bool {
    match result {
        None | Some(Value::Null) => true,
        Some(r) => valid_apply_progress(op, r, false),
    }
}

/// What a reader can show before any write.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Gate<T> {
    /// This Local predates the settings or Apply interface.
    Unsupported,
    Ready(T),
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

/// A host refusal's own words, bounded and plain.
fn refusal(value: &Value) -> String {
    value["error"]
        .as_str()
        .map(|s| {
            s.chars()
                .filter(|c| !c.is_control())
                .take(240)
                .collect::<String>()
        })
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "Local refused the read.".into())
}

/// Pinned hello, then one passive GET. Reads configuration only, never history.
async fn get(
    client: &reqwest::Client,
    options: &LocalOptions,
    session: &str,
    suffix: &str,
) -> Result<Gate<Value>, String> {
    let hello = crate::local_client::hello(client, options).await?;
    if !supported(&hello) {
        return Ok(Gate::Unsupported);
    }
    if !valid_id(session) {
        return Err(INVALID.into());
    }
    let response = client
        .get(format!(
            "{}/api/insights/sessions/{session}/{suffix}",
            options.loopback()
        ))
        .send()
        .await
        .map_err(|_| "Couldn't read Insights settings from Local.")?;
    let code = response.status().as_u16();
    let value = crate::insights::body(response).await;
    match (code, value) {
        (200, value) => value.map(Gate::Ready).map_err(String::from),
        (405 | 501, _) => Ok(Gate::Unsupported),
        (404, Ok(v)) if v["error"] == "not_insights" => Err("Not an Insights report chat.".into()),
        (404, _) => Ok(Gate::Unsupported),
        (409, Ok(v)) => Err(refusal(&v)),
        (503, _) => Err("Insights settings are unavailable on this Local.".into()),
        _ => Err("Local refused the Insights settings read.".into()),
    }
}

pub(crate) fn read_snapshot(
    options: LocalOptions,
    session: String,
) -> Option<async_channel::Receiver<Result<Gate<Snapshot>, String>>> {
    spawn(
        "local-insights-settings",
        Err("Couldn't start the settings read.".into()),
        move |client, runtime| {
            runtime.block_on(async {
                match get(&client, &options, &session, "settings").await? {
                    Gate::Unsupported => Ok(Gate::Unsupported),
                    Gate::Ready(v) => snapshot(&v, &session, &options.host())
                        .map(Gate::Ready)
                        .map_err(String::from),
                }
            })
        },
    )
}

pub(crate) fn read_preview(
    options: LocalOptions,
    session: String,
) -> Option<async_channel::Receiver<Result<Gate<Preview>, String>>> {
    spawn(
        "local-insights-apply",
        Err("Couldn't start the Apply check.".into()),
        move |client, runtime| {
            runtime.block_on(async {
                match get(&client, &options, &session, "apply").await? {
                    Gate::Unsupported => Ok(Gate::Unsupported),
                    Gate::Ready(v) => preview(&v, &session, &options.host())
                        .map(Gate::Ready)
                        .map_err(String::from),
                }
            })
        },
    )
}

#[cfg(test)]
#[path = "insights_settings_tests.rs"]
mod tests;

/// Synthetic host replies for unit tests and hidden probes only.
#[cfg(any(test, feature = "native-probes"))]
pub(crate) mod fixture {
    use serde_json::{Value, json};
    pub(crate) const REPORT: &str = "report-1";
    pub(crate) const TERRA: &str = "terra/terra-6.1";
    pub(crate) const SONNET: &str = "anthropic/claude-sonnet";
    /// The original fixed rule, created by enable.
    pub(crate) const RULE: &str = "7c1d2e3f-4a5b-5c6d-a7e8-f90a1b2c3d4e";
    /// Friday 6 November 2026, 18:00 in Paris.
    pub(crate) const NEXT: u64 = 1_793_984_400_000;
    pub(crate) fn home() -> Value {
        json!({"hostId":"daemon","daemonId":"test-daemon","lineageId":"test-lineage"})
    }
    pub(crate) fn chat(model: &str) -> Value {
        json!({"sessionId":REPORT,"grantId":"grant-1","revision":1,"inputGeneration":0,"model":model})
    }
    pub(crate) fn settings(model: &str) -> Value {
        json!({
            "recurrence": {"every":"week","weekday":5,"time":"18:00","timeZone":"Europe/Paris"},
            "requestedModel": {"kind":"id","value":model},
            "scope": {"host":"local","projects":"admitted","includeArchived":true,"excludeProjects":[],"excludeSessions":[],"sourceAccess":"read_only","coverage":"partial"},
            "bounds": {"inventoryPages":1,"historyPages":2,"entriesPerPage":4},
            "budget": {"usd":5,"period":"report","enforcement":"advisory","basis":"initial_assumption"}
        })
    }
    pub(crate) fn snapshot(revision: u64, settings: Value, chat_model: &str) -> Value {
        let id = settings["requestedModel"]["value"].clone();
        json!({
            "projectId":"project-A","missionId":"mission-A","expectedHome":home(),"context":"c0ffee",
            "chat":chat(chat_model),"revision":revision,"settings":settings,
            "model":{"state":"available","id":id},"nextAt":NEXT,
            "cost":{"pricing":"unknown","spendUsd":null},"activationRequired":true
        })
    }
    /// A pending, unpaused rule for the report chat; `revision` None is the fixed original.
    pub(crate) fn rule(settings_revision: Option<u64>, recurrence: Value) -> Value {
        let mut r = json!({
            "id":RULE,"revision":2,"title":"Weekly Insights","trigger":"recurring","recurrence":recurrence,
            "target":{"kind":"message","sessionId":REPORT,"message":"Prepare the next bounded weekly Insights report."},
            "state":"pending","createdAt":1,"updatedAt":2,"at":NEXT,
            "insightsDestination":{"sessionId":REPORT,"projectId":"project-A","missionId":"mission-A"},
            "insightsEnableOperationId":"op-enable"
        });
        if let Some(n) = settings_revision {
            r["insightsSettingsRevision"] = json!(n);
        }
        r
    }
    pub(crate) fn ready(
        revision: u64,
        settings: Value,
        model: &str,
        chat_model: &str,
        rule: Value,
    ) -> Value {
        json!({
            "state":"ready","reason":null,"nextAt":NEXT,"cost":{"pricing":"unknown","spendUsd":null},
            "payload":{
                "projectId":"project-A","missionId":"mission-A","expectedHome":home(),"context":"c0ffee",
                "chat":chat(chat_model),"record":{"revision":revision,"settings":settings,"model":model},"rule":rule
            }
        })
    }
    pub(crate) fn blocked(reason: &str) -> Value {
        json!({"state":"blocked","reason":reason,"payload":null,"nextAt":null,"cost":{"pricing":"unknown","spendUsd":null}})
    }
    /// Apply progress for an exact envelope, as the host journal stores it.
    pub(crate) fn progress(op: &crate::delivery_store::Operation, phase: &str) -> Value {
        let p: Value = serde_json::from_str(&op.payload).unwrap_or_default();
        let mut chat = p["chat"].clone();
        if phase != "model_pending" {
            chat["model"] = p["record"]["model"].clone();
        }
        let keeps = p["rule"]["insightsSettingsRevision"] == p["record"]["revision"]
            && p["rule"]["recurrence"] == p["record"]["settings"]["recurrence"];
        let revision = p["record"]["revision"].as_u64().unwrap_or_default();
        let schedule = if keeps {
            p["rule"]["id"].as_str().unwrap_or_default().to_owned()
        } else {
            super::replacement_id(&op.target_id, revision)
        };
        let mut r =
            json!({"phase":phase,"chat":chat,"scheduleId":schedule,"settingsRevision":revision});
        if !keeps
            && !p["rule"].is_null()
            && ["rule_cancelled", "schedule_pending", "applied"].contains(&phase)
        {
            let mut cancelled = p["rule"].clone();
            cancelled["state"] = json!("cancelled");
            r["cancelledRule"] = cancelled;
        }
        r
    }
    /// A receipt for exactly this envelope.
    pub(crate) fn receipt(
        op: &crate::delivery_store::Operation,
        state: &str,
        result: Value,
    ) -> Value {
        let mut r = json!({"operationId":op.operation_id,"payloadHash":op.payload_hash,"targetId":op.target_id,"destination":op.destination,"state":state});
        if !result.is_null() {
            r["result"] = result;
        }
        if state == "rejected" {
            r["reason"] = json!("Insights settings revision changed");
        }
        r
    }
}
