//! Profile-scoped Insights. Only the native worker can freeze, journal and send a review.
mod records;
mod settings;
mod work_draft;
pub(crate) use work_draft::valid_work_draft;
#[cfg(test)]
mod tests;
use self::{
    records::{Kind, WorkspaceRead},
    settings::{Owner, Settings, Status, UiSettings},
};
use super::{Error, Journal, Shared, Source, Transport, bridge::Call, planning::hash, valid_id};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    time::{Duration, Instant},
};
use uuid::Uuid;

const MAX_SAFE: u64 = 9_007_199_254_740_991;
const DAY: &str = "/api/insights/day";
const DAY_OPERATION: &str = "day-insights";
const LIFECYCLE: &str = "insights-workspace-lifecycle";

/// Local capture may contain incomplete amounts or chat IDs, but never authority.
pub(crate) fn valid_draft(text: &str) -> bool {
    if text.is_empty() {
        return true;
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Draft {
        binding: String,
        project_id: String,
        model: String,
        source_project_ids: Vec<String>,
        exclude_session_ids: Vec<String>,
        per_report_usd: String,
        monthly_usd: String,
        schedule: Option<Schedule>,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Schedule {
        weekday: u8,
        time: String,
        time_zone: String,
    }
    text.len() <= 20_000
        && serde_json::from_str::<Draft>(text).is_ok_and(|d| {
            d.binding.len() == 64
                && d.binding.bytes().all(|c| c.is_ascii_hexdigit())
                && (d.project_id.is_empty() || valid_id(&d.project_id))
                && d.model.len() <= 2048
                && d.source_project_ids.len() <= 256
                && d.source_project_ids.iter().all(|id| valid_id(id))
                && d.exclude_session_ids.len() <= 257
                && d.exclude_session_ids.iter().all(|s| s.len() <= 2000)
                && d.per_report_usd.len() <= 128
                && d.monthly_usd.len() <= 128
                && d.schedule.is_none_or(|s| {
                    s.weekday <= 6 && s.time.len() <= 128 && s.time_zone.len() <= 512
                })
        })
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "action", rename_all = "lowercase", deny_unknown_fields)]
pub(crate) enum Intent {
    Setup { settings: UiSettings },
    Save { settings: UiSettings },
    Apply { settings: UiSettings },
    Run {},
    Pause {},
    Resume {},
    Verify { key: String, revision: u64 },
    Ship { key: String, revision: u64 },
}

pub(crate) enum Request {
    Read,
    List {
        kind: Kind,
        cursor: u64,
        binding: String,
    },
    Item {
        kind: Kind,
        key: String,
        binding: String,
    },
    Models {
        project_id: String,
        binding: String,
    },
    History {
        cursor: String,
        binding: String,
    },
    Prepare {
        binding: String,
        intent: Intent,
    },
    Confirm(String),
    Check(String),
}

fn decode<T: DeserializeOwned>(v: Value) -> Result<T, Error> {
    serde_json::from_value(v).map_err(|_| Error::Invalid)
}

fn valid_history_cursor(cursor: &str) -> bool {
    !cursor.is_empty()
        && cursor.len() <= 512
        && cursor
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}

impl Request {
    pub(crate) fn parse(name: &str, args: Value) -> Result<Self, Error> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Read {}
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct List {
            kind: Kind,
            cursor: u64,
            binding: String,
        }
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Item {
            kind: Kind,
            key: String,
            binding: String,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Models {
            project_id: String,
            binding: String,
        }
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct History {
            cursor: String,
            binding: String,
        }
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Review {
            binding: String,
            intent: Intent,
        }
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Confirm {
            token: String,
        }
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Check {
            id: String,
        }
        fn id(s: &str) -> Result<(), Error> {
            if valid_id(s) {
                Ok(())
            } else {
                Err(Error::Invalid)
            }
        }
        Ok(match name {
            "day.insights.read" => {
                let _: Read = decode(args)?;
                Self::Read
            }
            "day.insights.list" => {
                let List {
                    kind,
                    cursor,
                    binding,
                } = decode(args)?;
                if cursor > MAX_SAFE {
                    return Err(Error::Invalid);
                }
                id(&binding)?;
                Self::List {
                    kind,
                    cursor,
                    binding,
                }
            }
            "day.insights.item" => {
                let Item { kind, key, binding } = decode(args)?;
                id(&binding)?;
                id(&key)?;
                Self::Item { kind, key, binding }
            }
            "day.insights.models" => {
                let Models {
                    project_id,
                    binding,
                } = decode(args)?;
                id(&project_id)?;
                id(&binding)?;
                Self::Models {
                    project_id,
                    binding,
                }
            }
            "day.insights.prepare" => {
                let Review { binding, intent } = decode(args)?;
                id(&binding)?;
                if let Intent::Verify { key, revision } | Intent::Ship { key, revision } = &intent {
                    id(key)?;
                    if !(1..MAX_SAFE).contains(revision) {
                        return Err(Error::Invalid);
                    }
                }
                Self::Prepare { binding, intent }
            }
            "day.insights.history" => {
                let History { cursor, binding } = decode(args)?;
                id(&binding)?;
                if !valid_history_cursor(&cursor) {
                    return Err(Error::Invalid);
                }
                Self::History { cursor, binding }
            }
            "day.insights.confirm" => {
                let Confirm { token } = decode(args)?;
                id(&token)?;
                Self::Confirm(token)
            }
            "day.insights.check" => {
                let Check { id: operation_id } = decode(args)?;
                id(&operation_id)?;
                Self::Check(operation_id)
            }
            _ => return Err(Error::Invalid),
        })
    }
}

pub(super) fn home(source: &Source, host: &str) -> Value {
    json!({"hostId":host,"daemonId":source.home.daemon_id,"lineageId":source.home.lineage_id})
}

pub(super) fn bounded(value: &Value, max: usize) -> Result<&str, Error> {
    value
        .as_str()
        .filter(|s| s.len() <= max)
        .ok_or(Error::Invalid)
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Record {
    insights_operation: String,
    source: Source,
    envelope: Value,
    receipt: Option<Decision>,
}

/// Saved only after the complete received receipt has been matched to the envelope.
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum Decision {
    Accepted,
    Rejected,
}

impl Record {
    fn new(source: &Source, kind: &str, owner: &Owner, payload: Value) -> Result<Self, Error> {
        let payload = serde_json::to_string(&payload).map_err(|_| Error::Invalid)?;
        let id = Uuid::new_v4().to_string();
        let record = Self {
            envelope: json!({"schemaVersion":1,"operationId":id,"producerId":Uuid::new_v4().to_string(),
                "sequence":1,"origin":home(source,"local"),"destination":home(source,"daemon"),
                "kind":kind,"targetId":owner.workspace_id,"payload":payload,"payloadHash":hash(&payload)}),
            insights_operation: id,
            source: source.clone(),
            receipt: None,
        };
        record.validate()?;
        Ok(record)
    }

    pub fn id(&self) -> &str {
        &self.insights_operation
    }

    fn payload(&self) -> Result<Value, Error> {
        decode_payload(bounded(&self.envelope["payload"], 65536)?)
    }

    pub fn settled(&self) -> bool {
        self.receipt.is_some()
    }

    pub fn follows(&self, old: &Self) -> bool {
        !old.settled()
            && self.settled()
            && self.source == old.source
            && self.envelope == old.envelope
    }

    fn for_source(&self, source: &Source) -> bool {
        self.source.profile == source.profile && self.source.home == source.home
    }

    fn action(&self) -> Result<WriteKind, Error> {
        if self.envelope["kind"] != DAY_OPERATION {
            return Ok(WriteKind::Other);
        }
        Ok(match self.payload()?["action"].as_str() {
            Some("pause") => WriteKind::Pause,
            Some("run") => WriteKind::Run,
            _ => WriteKind::Other,
        })
    }

    pub fn validate(&self) -> Result<(), Error> {
        let op = &self.envelope;
        if Uuid::parse_str(self.id()).is_err()
            || op["operationId"] != self.id()
            || op["schemaVersion"] != 1
            || op["sequence"] != 1
            || op["producerId"]
                .as_str()
                .is_none_or(|id| Uuid::parse_str(id).is_err())
            || op["origin"] != home(&self.source, "local")
            || op["destination"] != home(&self.source, "daemon")
            || !self.source.profile.is_absolute()
            || !valid_id(&self.source.home.daemon_id)
            || !valid_id(&self.source.home.lineage_id)
            || op["payloadHash"] != hash(bounded(&op["payload"], 65536)?)
        {
            return Err(Error::Invalid);
        }
        let p = self.payload()?;
        let owner: Owner = decode(p["owner"].clone())?;
        owner.validate(&self.source)?;
        let revision = p["expectedRevision"]
            .as_u64()
            .filter(|n| *n < MAX_SAFE)
            .ok_or(Error::Invalid)?;
        if op["targetId"] != owner.workspace_id {
            return Err(Error::Invalid);
        }
        match op["kind"].as_str() {
            Some(DAY_OPERATION)
                if p["schemaVersion"] == 1
                    && p["disclosure"] == "day-insights-v1"
                    && p["admissionEpoch"].as_str().is_some_and(valid_id) =>
            {
                match p["action"].as_str() {
                    Some("save" | "apply") => {
                        decode::<Settings>(p["settings"].clone())?.validate()?
                    }
                    Some("run" | "pause" | "resume") if p.get("settings") == Some(&Value::Null) => {
                        ()
                    }
                    _ => return Err(Error::Invalid),
                }
            }
            Some(LIFECYCLE)
                if p["schemaVersion"] == 2
                    && revision > 0
                    && p["key"].as_str().is_some_and(valid_id)
                    && matches!(p["lifecycle"].as_str(), Some("shipped" | "verified")) =>
            {
                ()
            }
            _ => return Err(Error::Invalid),
        }
        Ok(())
    }

    pub fn terminal_reservation(&self) -> Result<u64, Error> {
        let mut terminal = self.clone();
        terminal.receipt = Some(Decision::Accepted); // Same length as "rejected".
        Ok(serde_json::to_vec(&terminal)
            .map_err(|_| Error::Storage)?
            .len() as u64
            + 1)
    }

    fn terminal(&self, r: &Value) -> Result<Decision, Error> {
        super::planning::exact(r.clone(), &self.envelope)?;
        match r["state"].as_str() {
            Some("rejected") => Ok(Decision::Rejected),
            Some("accepted") => {
                let p = self.payload()?;
                let result = &r["result"];
                if self.envelope["kind"] == DAY_OPERATION {
                    let status = Status::parse(result.clone(), &self.source)?;
                    let changed = match p["action"].as_str() {
                        Some("save") => result["draft"] == p["settings"],
                        Some("apply") => result["effective"] == p["settings"],
                        Some("pause") => status.paused,
                        Some("resume") => !status.paused,
                        Some("run") => true,
                        _ => false,
                    };
                    let expected = p["expectedRevision"].as_u64().ok_or(Error::Invalid)?;
                    if result["owner"] == p["owner"]
                        && (if p["action"] == "run" {
                            status.revision >= expected
                        } else {
                            status.revision == expected + 1
                        })
                        && changed
                    {
                        Ok(Decision::Accepted)
                    } else {
                        Err(Error::Unknown)
                    }
                } else if result["key"] == p["key"]
                    && result["lifecycle"] == p["lifecycle"]
                    && result["revision"].as_u64() == p["expectedRevision"].as_u64().map(|n| n + 1)
                {
                    Ok(Decision::Accepted)
                } else {
                    Err(Error::Unknown)
                }
            }
            _ => Err(Error::Unknown),
        }
    }
}

fn decode_payload(payload: &str) -> Result<Value, Error> {
    serde_json::from_str(payload).map_err(|_| Error::Invalid)
}

#[derive(Clone)]
struct Scope {
    window: String,
    binding: String,
    status: Status,
    workspace: WorkspaceRead,
    projects: Vec<ProjectRow>,
}

struct Review {
    window: String,
    token: String,
    expires: Instant,
    record: Record,
}

#[derive(Default)]
pub(super) struct Shown {
    scope: Option<Scope>,
    review: Option<Review>,
}

#[derive(Clone, Deserialize, Serialize)]
struct ProjectRow {
    id: String,
    name: String,
}

async fn projects(t: &Transport) -> Result<Vec<ProjectRow>, Error> {
    let rows: Vec<ProjectRow> = decode(t.get("/api/projects").await?)?;
    let mut ids = BTreeSet::new();
    if rows.len() > 4096
        || rows
            .iter()
            .any(|p| !valid_id(&p.id) || p.name.len() > 4096 || !ids.insert(&p.id))
    {
        return Err(Error::Invalid);
    }
    Ok(rows)
}

async fn models(t: &Transport, project_id: &str) -> Result<Value, Error> {
    #[derive(Deserialize, Serialize)]
    struct Model {
        id: String,
        name: String,
        provider: String,
    }
    #[derive(Deserialize)]
    struct Catalog {
        models: Vec<Model>,
    }
    let Catalog { models } = decode(
        t.get(&format!("/api/models?projectId={project_id}"))
            .await?,
    )?;
    let mut ids = BTreeSet::new();
    if models.len() > 4096
        || models.iter().any(|m| {
            m.id.is_empty()
                || m.id.len() > 2048
                || m.name.len() > 1024
                || m.provider.len() > 128
                || !ids.insert(&m.id)
        })
    {
        return Err(Error::Invalid);
    }
    Ok(json!(models))
}

async fn day_hello(t: &Transport) -> Result<Value, Error> {
    let hello = t.profile_hello().await?;
    if hello["capabilities"]["dayInsights"] != 1 {
        return Err(Error::Unavailable);
    }
    Ok(hello)
}
async fn status(t: &Transport) -> Result<Status, Error> {
    Status::parse(t.get(DAY).await?, &t.source)
}

fn pending_records<'a>(
    source: &'a Source,
    journal: &'a Journal,
) -> impl Iterator<Item = &'a Record> {
    journal
        .insights
        .values()
        .filter(|r| r.for_source(source) && !r.settled())
}

fn pending(t: &Transport, journal: &Journal) -> Vec<Value> {
    pending_records(&t.source, journal)
        .map(|r| json!({"id":r.id()}))
        .collect()
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum WriteKind {
    Pause,
    Run,
    Other,
}

impl From<&Intent> for WriteKind {
    fn from(intent: &Intent) -> Self {
        match intent {
            Intent::Pause {} => Self::Pause,
            Intent::Run {} => Self::Run,
            _ => Self::Other,
        }
    }
}

#[derive(Default)]
struct PendingWrites {
    any: bool,
    pause: bool,
}

impl PendingWrites {
    fn read(source: &Source, journal: &Journal) -> Self {
        let mut pending = Self::default();
        for record in pending_records(source, journal) {
            pending.any = true;
            // A missing or invalid local action cannot authorize another Pause.
            pending.pause |= !matches!(record.action(), Ok(WriteKind::Run | WriteKind::Other));
        }
        pending
    }

    fn uncertain(&self, status: &Status) -> bool {
        self.any || status.uncertain_operation_id.is_some()
    }

    fn admit(&self, status: &Status, kind: WriteKind) -> Result<(), Error> {
        match kind {
            // This is a distinct safety stop, never a replay of the prior write.
            WriteKind::Pause if self.pause => Err(Error::Busy),
            WriteKind::Pause if status.effective.is_none() || status.paused => Err(Error::Stale),
            WriteKind::Pause => Ok(()),
            _ if self.uncertain(status) => Err(Error::Busy),
            WriteKind::Run if !status.run_review_available() => Err(Error::Unavailable),
            _ => Ok(()),
        }
    }
}

fn hold(status: &Status, pending: &PendingWrites) -> Option<(&'static str, &'static str)> {
    if pending.uncertain(status) {
        return Some(("uncertain", "An earlier Insights action is not confirmed."));
    }
    if status.effective.is_none() || !status.execution_supported || status.running != Some(false) {
        return None;
    }
    let reason = match status.hold_reason.as_deref() {
        Some("day_insights_report_allowance_hold") => {
            "The previous report stopped at its report allowance."
        }
        Some("day_insights_monthly_allowance_hold") => {
            "The previous report stopped at its monthly allowance."
        }
        Some(_) => "The previous report stopped before it could finish.",
        None if status.allowance_empty() => "There is no report allowance left right now.",
        None => return None,
    };
    Some(("terminal", reason))
}

fn admit(shared: &Shared, call: &Call) -> Result<(), Error> {
    shared.open()?;
    call.command
        .admit(&call.gate.lock().expect("bridge gate poisoned"))
}

fn shown(shared: &Shared, call: &Call, binding: &str) -> Result<Scope, Error> {
    shared
        .insights
        .lock()
        .expect("Insights state poisoned")
        .scope
        .as_ref()
        .filter(|scope| scope.window == call.window && scope.binding == binding)
        .cloned()
        .ok_or(Error::Stale)
}

async fn snapshot(
    t: &Transport,
    journal: &Journal,
    shared: &Shared,
    call: &Call,
) -> Result<Value, Error> {
    let hello = day_hello(t).await?;
    let (status, workspace, projects, legacy) = tokio::try_join!(
        status(t),
        records::workspace(t, &hello),
        projects(t),
        records::legacy(t, None)
    )?;
    if let WorkspaceRead::Present(w) = &workspace
        && status.owner.as_ref() != Some(&w.owner)
    {
        return Err(Error::Stale);
    }
    let (reports, findings) = tokio::try_join!(
        records::page(t, &workspace, Kind::Reports, 0),
        records::page(t, &workspace, Kind::Findings, 0),
    )?;
    let writes = PendingWrites::read(&t.source, journal);
    let hold = hold(&status, &writes);
    let pending = pending(t, journal);
    let (state, reason) = if status.paused {
        ("paused", hold.map(|(_, reason)| reason))
    } else if writes.uncertain(&status) {
        ("blocked", hold.map(|(_, reason)| reason))
    } else if status.effective.is_none() {
        ("off", None)
    } else if !status.execution_supported {
        (
            "blocked",
            Some("This service cannot run Insights reports yet."),
        )
    } else if status.running == Some(true) {
        ("running", None)
    } else if let Some((_, reason)) = hold {
        ("blocked", Some(reason))
    } else {
        ("enabled", None)
    };
    let draft_binding = status.draft_binding(&t.source);
    let binding =
        hash(&json!([t.source, call.window, status, workspace, projects, pending]).to_string());
    let ui = |settings: &Option<Settings>| {
        settings
            .as_ref()
            .zip(status.owner.as_ref())
            .map(|(s, o)| s.ui(o))
    };
    let mut value = json!({
        "binding":binding,"draftBinding":draft_binding,"state":state,
        "executionProjectId":status.owner.as_ref().map(|owner| &owner.project_id),
        "running":status.running,"nextAt":status.next_at,
        "canPause":writes.admit(&status, WriteKind::Pause).is_ok(),
        "canRun":writes.admit(&status, WriteKind::Run).is_ok(),
        "hold":hold.map(|(kind,reason)| json!({"kind":kind,"reason":reason})),
        "saved":ui(&status.draft),"applied":ui(&status.effective),"projects":projects,"models":[],
        "reports":reports,"findings":findings,"legacy":legacy
    });
    if let Some(reason) = reason {
        value["reason"] = json!(reason);
    }
    if let Some((report, month)) = status.allowance() {
        value["allowance"] = json!({"reportRemainingUsd":report,"monthRemainingUsd":month});
    }
    admit(shared, call)?;
    shared
        .insights
        .lock()
        .expect("Insights state poisoned")
        .scope = Some(Scope {
        window: call.window.clone(),
        binding,
        status,
        workspace,
        projects,
    });
    Ok(value)
}

async fn checked_workspace(t: &Transport, scope: &Scope) -> Result<Value, Error> {
    let hello = day_hello(t).await?;
    if records::workspace(t, &hello).await? != scope.workspace {
        return Err(Error::Stale);
    }
    Ok(hello)
}

struct PreparedReview {
    record: Record,
    label: &'static str,
    lines: Vec<String>,
}

enum ReviewPreparation {
    Ready(PreparedReview),
    Refused(&'static str),
}

// Render only fixed local copy. Never show a reason supplied by the daemon verbatim.
fn review_refusal(reason: &Value) -> Option<&'static str> {
    Some(match reason.as_str()? {
        "legacy_schedule_not_quiescent" => {
            "An earlier Insights schedule still blocks setup. Check Schedules for the earlier rule. Nothing changed."
        }
        "legacy_execution_not_proven_quiescent"
        | "legacy_execution_or_transfer_uncertain"
        | "legacy_executor_not_quiescent_or_grant_not_revoked"
        | "day_insights_existing_execution_requires_recovery" => {
            "Pilot can’t verify that earlier Insights work has stopped. Check the earlier setup before trying again. Nothing changed."
        }
        "schedule_inventory_unavailable" => {
            "Pilot can’t check earlier schedules right now. Try reviewing setup again. Nothing changed."
        }
        "legacy_journal_busy_or_unavailable" => {
            "Pilot can’t check earlier Insights changes right now. Try reviewing setup again. Nothing changed."
        }
        "day_insights_exact_model_unavailable" => {
            "This model is no longer available for the report project. Choose another model and review again. Nothing changed."
        }
        _ => return None,
    })
}

async fn prepare(
    t: &Transport,
    scope: &Scope,
    intent: &Intent,
    writes: &PendingWrites,
) -> Result<ReviewPreparation, Error> {
    if let Intent::Ship { key, revision } | Intent::Verify { key, revision } = intent {
        let hello = checked_workspace(t, scope).await?;
        let owner = &scope.workspace.workspace()?.owner;
        let detail = records::read_item(t, Kind::Findings, key).await?;
        if records::workspace(t, &hello).await? != scope.workspace {
            return Err(Error::Stale);
        }
        let verify = matches!(intent, Intent::Verify { .. });
        if detail.legacy
            || detail.item.revision != *revision
            || if verify {
                detail.item.lifecycle.as_deref() != Some("shipped")
            } else {
                matches!(
                    detail.item.lifecycle.as_deref(),
                    Some("shipped" | "verified")
                )
            }
        {
            return Err(Error::Stale);
        }
        let (lifecycle, label, description) = if verify {
            (
                "verified",
                "Mark benefit verified",
                "Confirms that you checked the benefit. No code or report will run.",
            )
        } else {
            (
                "shipped",
                "Mark shipped",
                "Records that the work shipped. This does not verify the benefit.",
            )
        };
        let record = Record::new(
            &t.source,
            LIFECYCLE,
            owner,
            json!({
                "schemaVersion":2,"owner":owner,"key":key,"expectedRevision":revision,"lifecycle":lifecycle,
            }),
        )?;
        return Ok(ReviewPreparation::Ready(PreparedReview {
            record,
            label,
            lines: vec![
                detail.value["title"]
                    .as_str()
                    .unwrap_or("Finding")
                    .to_owned(),
                description.into(),
            ],
        }));
    }
    day_hello(t).await?;
    let current = status(t).await?;
    if !current.same_configuration(&scope.status) {
        return Err(Error::Stale);
    }
    writes.admit(&current, intent.into())?;
    let prior = current.draft.as_ref().or(current.effective.as_ref());
    let (action, label, project, settings) = match intent {
        Intent::Setup { settings } | Intent::Apply { settings } => (
            "apply",
            "Apply report settings",
            settings.project_id.as_str(),
            Some(Settings::from_intent(settings, prior)?),
        ),
        Intent::Save { settings } => (
            "save",
            "Save report settings",
            settings.project_id.as_str(),
            Some(Settings::from_intent(settings, prior)?),
        ),
        Intent::Run {} | Intent::Pause {} | Intent::Resume {} => {
            let owner = current.owner.as_ref().ok_or(Error::Unavailable)?;
            match intent {
                Intent::Run {} => ("run", "Run report", owner.project_id.as_str(), None),
                Intent::Pause {} => ("pause", "Pause Insights", owner.project_id.as_str(), None),
                _ => ("resume", "Resume Insights", owner.project_id.as_str(), None),
            }
        }
        _ => return Err(Error::Invalid),
    };
    if current
        .owner
        .as_ref()
        .is_some_and(|owner| owner.project_id != project)
        || !scope.projects.iter().any(|p| p.id == project)
    {
        return Err(Error::Stale);
    }
    let preview = t.project_preview("/api/insights/day/preflight", json!({
        "action":action,"expectedRevision":current.revision,"projectId":project,"settings":settings,
    })).await?;
    match (preview["schemaVersion"].as_u64(), preview["state"].as_str()) {
        (Some(1), Some("ready")) if preview.get("reason") == Some(&Value::Null) => (),
        (Some(1), Some("blocked" | "unavailable"))
            if preview.get("payload") == Some(&Value::Null) =>
        {
            return review_refusal(&preview["reason"])
                .map(ReviewPreparation::Refused)
                .ok_or(Error::Unavailable);
        }
        _ => return Err(Error::Invalid),
    }
    let payload = &preview["payload"];
    let owner: Owner = decode(payload["owner"].clone())?;
    owner.validate(&t.source)?;
    if owner.project_id != project
        || current.owner.as_ref().is_some_and(|o| *o != owner)
        || payload["action"] != action
        || payload["expectedRevision"] != current.revision
        || payload.get("settings") != Some(&json!(settings))
    {
        return Err(Error::Stale);
    }
    let disclosure = if matches!(action, "run" | "resume") {
        Some(current.effective.as_ref().ok_or(Error::Unavailable)?)
    } else {
        settings.as_ref()
    };
    let mut lines = disclosure.map_or_else(Vec::new, |s| s.review_lines(project));
    lines.push(
        match action {
            "save" => "Saves a draft. Does not change active settings or run a report.",
            "apply" => "Applies the settings. Does not run a report now or resume if paused.",
            "run" => "Runs one report with the applied scope, model and allowance.",
            "pause" => "Pauses Insights and stops report work. It does not change your settings or remove reports or findings.",
            _ => "Resumes Insights with the applied settings.",
        }
        .into(),
    );
    Ok(ReviewPreparation::Ready(PreparedReview {
        record: Record::new(&t.source, DAY_OPERATION, &owner, payload.clone())?,
        label,
        lines,
    }))
}

fn settle(journal: &mut Journal, record: &mut Record, receipt: Value) -> Result<(), Error> {
    let decision = record.terminal(&receipt)?;
    let mut settled = record.clone();
    settled.receipt = Some(decision);
    journal.save_insights(settled.clone())?;
    *record = settled;
    Ok(())
}

async fn lookup(t: &Transport, journal: &mut Journal, record: &mut Record) -> Result<(), Error> {
    if record.settled() {
        return Ok(());
    }
    let receipt = t.raw_operation(&record.envelope, true).await?;
    settle(journal, record, receipt)
}

fn outcome(state: &str, message: &str) -> Value {
    json!({"state":state,"receipt":{"reason":message}})
}

async fn revalidate(
    t: &Transport,
    hello: &Value,
    status: &Status,
    record: &Record,
) -> Result<(), Error> {
    let p = record.payload()?;
    if record.envelope["kind"] == DAY_OPERATION {
        if p["expectedRevision"] != status.revision
            || status
                .owner
                .as_ref()
                .is_some_and(|o| p["owner"] != json!(o))
        {
            return Err(Error::Stale);
        }
    } else {
        let workspace = records::workspace(t, hello).await?;
        if p["owner"] != json!(workspace.workspace()?.owner) {
            return Err(Error::Stale);
        }
        let detail =
            records::read_item(t, Kind::Findings, p["key"].as_str().ok_or(Error::Invalid)?).await?;
        if detail.legacy
            || p["expectedRevision"] != detail.item.revision
            || (p["lifecycle"] == "verified" && detail.item.lifecycle.as_deref() != Some("shipped"))
        {
            return Err(Error::Stale);
        }
    }
    Ok(())
}

async fn operation_reply(
    t: &Transport,
    journal: &Journal,
    shared: &Shared,
    call: &Call,
    record: &Record,
) -> Value {
    let result = match record.receipt {
        Some(Decision::Accepted) => outcome("accepted", ""),
        Some(Decision::Rejected) => outcome(
            "rejected",
            "Insights did not accept this change. Review the current settings and try again.",
        ),
        _ => outcome(
            "unknown",
            "The result is not confirmed. Check the exact operation before trying again.",
        ),
    };
    let current = snapshot(t, journal, shared, call).await.ok();
    json!({"snapshot":current,"pending":pending(t,journal),"outcome":result})
}

pub(super) async fn handle(
    t: &Transport,
    journal: &mut Journal,
    shared: &Shared,
    call: &Call,
    request: &Request,
) -> Result<Value, Error> {
    let value = match request {
        Request::Read => {
            let current = snapshot(t, journal, shared, call).await;
            return match current {
                Ok(current) => {
                    Ok(json!({"snapshot":current,"pending":pending(t,journal),"outcome":null}))
                }
                Err(error @ (Error::Closed | Error::Identity)) => Err(error),
                Err(_) => Ok(json!({"snapshot":null,"pending":pending(t,journal),"outcome":null})),
            };
        }
        Request::List {
            kind,
            cursor,
            binding,
        } => {
            let scope = shown(shared, call, binding)?;
            checked_workspace(t, &scope).await?;
            records::page(t, &scope.workspace, *kind, *cursor).await?
        }
        Request::Item { kind, key, binding } => {
            let scope = shown(shared, call, binding)?;
            let hello = checked_workspace(t, &scope).await?;
            scope.workspace.workspace()?;
            let detail = records::read_item(t, *kind, key).await?;
            if records::workspace(t, &hello).await? != scope.workspace {
                return Err(Error::Stale);
            }
            detail.value
        }
        Request::Models {
            project_id,
            binding,
        } => {
            let scope = shown(shared, call, binding)?;
            if !scope.projects.iter().any(|p| &p.id == project_id) {
                return Err(Error::Stale);
            }
            day_hello(t).await?;
            json!({"projectId":project_id,"models":models(t,project_id).await?})
        }
        Request::Prepare { binding, intent } => {
            let scope = shown(shared, call, binding)?;
            shared
                .insights
                .lock()
                .expect("Insights state poisoned")
                .review = None;
            let writes = PendingWrites::read(&t.source, journal);
            writes.admit(&scope.status, intent.into())?;
            let prepared = prepare(t, &scope, intent, &writes).await?;
            admit(shared, call)?;
            let PreparedReview {
                record,
                label,
                lines,
            } = match prepared {
                ReviewPreparation::Ready(review) => review,
                ReviewPreparation::Refused(reason) => {
                    return Ok(json!({"snapshot":null,"outcome":null,"reason":reason}));
                }
            };
            let token = Uuid::new_v4().to_string();
            shared
                .insights
                .lock()
                .expect("Insights state poisoned")
                .review = Some(Review {
                window: call.window.clone(),
                token: token.clone(),
                expires: Instant::now() + Duration::from_secs(300),
                record,
            });
            json!({"intent":intent,"label":label,"lines":lines,"token":token})
        }
        Request::History { cursor, binding } => {
            shown(shared, call, binding)?;
            day_hello(t).await?;
            records::legacy(t, Some(cursor)).await?
        }
        Request::Confirm(token) => {
            let mut record = {
                let mut state = shared.insights.lock().expect("Insights state poisoned");
                let review = state
                    .review
                    .take_if(|r| &r.token == token && r.window == call.window)
                    .ok_or(Error::Stale)?;
                if review.expires <= Instant::now() {
                    return Err(Error::Stale);
                }
                review.record
            };
            let hello = day_hello(t).await?;
            let status = status(t).await?;
            PendingWrites::read(&t.source, journal).admit(&status, record.action()?)?;
            revalidate(t, &hello, &status, &record).await?;
            {
                let gate = call.gate.lock().expect("bridge gate poisoned");
                call.command.admit(&gate)?;
                shared.open()?;
                // Synchronously persist the complete envelope before any effect request.
                journal.save_insights(record.clone())?;
            }
            if let Ok(receipt) = t.raw_operation(&record.envelope, false).await {
                let _ = settle(journal, &mut record, receipt);
            }
            for wait in [0, 250] {
                if record.settled() || shared.open().is_err() || journal.is_failed() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(wait)).await;
                let _ =
                    tokio::time::timeout(Duration::from_secs(2), lookup(t, journal, &mut record))
                        .await;
            }
            return Ok(operation_reply(t, journal, shared, call, &record).await);
        }
        Request::Check(id) => {
            let mut record = journal
                .insights
                .get(id)
                .filter(|r| r.for_source(&t.source))
                .cloned()
                .ok_or(Error::Stale)?;
            t.profile_gate().await?;
            admit(shared, call)?;
            let _ = lookup(t, journal, &mut record).await;
            return Ok(operation_reply(t, journal, shared, call, &record).await);
        }
    };
    admit(shared, call)?;
    Ok(json!({"snapshot":value,"outcome":null}))
}
