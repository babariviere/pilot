use super::{Error, MAX_SAFE, Source, Value, hash, home, valid_id};
use serde::{Deserialize, Serialize};
use serde_json::json;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct UiSettings {
    pub project_id: String,
    model: String,
    source_project_ids: Vec<String>,
    exclude_session_ids: Vec<String>,
    per_report_usd: f64,
    monthly_usd: f64,
    schedule: Option<UiSchedule>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UiSchedule {
    weekday: u8,
    time: String,
    time_zone: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Owner {
    schema_version: u32,
    pub workspace_id: String,
    report_session_id: String,
    schedule_id: String,
    pub project_id: String,
    expected_home: Value,
    context: String,
}

impl Owner {
    pub fn validate(&self, source: &Source) -> Result<(), Error> {
        if self.schema_version != 2
            || ![
                &self.workspace_id,
                &self.report_session_id,
                &self.schedule_id,
                &self.project_id,
            ]
            .into_iter()
            .all(|s| valid_id(s))
            || self.expected_home != home(source, "daemon")
            || self.context.len() != 64
            || !self.context.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err(Error::Identity);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Status {
    schema_version: u32,
    pub revision: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    settings_revision: Option<u64>,
    pub owner: Option<Owner>,
    pub draft: Option<Settings>,
    pub effective: Option<Settings>,
    pub paused: bool,
    pub execution_supported: bool,
    pub uncertain_operation_id: Option<String>,
    pub running: Option<bool>,
    pub next_at: Option<u64>,
    pub hold_reason: Option<String>,
    pub remaining: Option<Remaining>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Remaining {
    per_report_micros: Option<u64>,
    monthly_micros: Option<u64>,
    uncertain_micros: Option<u64>,
}

impl Status {
    pub fn parse(value: Value, source: &Source) -> Result<Self, Error> {
        if !["owner", "draft", "effective", "uncertainOperationId"]
            .into_iter()
            .all(|k| value.get(k).is_some())
        {
            return Err(Error::Invalid);
        }
        let status: Self = serde_json::from_value(value).map_err(|_| Error::Invalid)?;
        if status.schema_version != 1
            || status.revision > MAX_SAFE
            || status
                .settings_revision
                .is_some_and(|r| r > status.revision)
            || status.owner.is_none()
                && (status.draft.is_some() || status.effective.is_some() || status.paused)
            || status
                .uncertain_operation_id
                .as_deref()
                .is_some_and(|id| !valid_id(id))
            || status.next_at.is_some_and(|n| n > 8_640_000_000_000_000)
            || status
                .hold_reason
                .as_ref()
                .is_some_and(|reason| reason.len() > 512)
            || status.remaining.as_ref().is_some_and(|r| {
                [r.per_report_micros, r.monthly_micros, r.uncertain_micros]
                    .into_iter()
                    .flatten()
                    .any(|n| n > MAX_SAFE)
            })
        {
            return Err(Error::Invalid);
        }
        if let Some(owner) = &status.owner {
            owner.validate(source)?;
        }
        for settings in [&status.draft, &status.effective].into_iter().flatten() {
            settings.validate()?;
        }
        Ok(status)
    }

    pub fn draft_binding(&self, source: &Source) -> String {
        // A general status revision may also count Pause, Resume and Run.
        hash(
            &json!([
                source.profile,
                source.home,
                source.project,
                self.owner,
                self.settings_revision,
                self.draft,
                self.effective
            ])
            .to_string(),
        )
    }

    pub fn same_configuration(&self, other: &Self) -> bool {
        self.revision == other.revision
            && self.owner == other.owner
            && self.settings_revision == other.settings_revision
            && self.draft == other.draft
            && self.effective == other.effective
            && self.paused == other.paused
    }

    pub fn allowance(&self) -> Option<(f64, f64)> {
        let r = self.remaining.as_ref()?;
        Some((
            r.per_report_micros? as f64 / 1_000_000.0,
            r.monthly_micros? as f64 / 1_000_000.0,
        ))
    }

    pub fn allowance_empty(&self) -> bool {
        self.remaining
            .as_ref()
            .is_some_and(|r| r.per_report_micros == Some(0) || r.monthly_micros == Some(0))
    }

    /// Eligibility to request a fresh review. A preview or send must still
    /// pass daemon admission, and the provider call must reserve its allowance.
    pub fn run_review_available(&self) -> bool {
        self.effective.is_some()
            && !self.paused
            && self.execution_supported
            && self.running == Some(false)
            && !self.allowance_empty()
    }
}

#[derive(Debug, Clone, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Settings {
    model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    thinking: Option<String>,
    source: Scope,
    weekly: Option<Weekly>,
    allowance: Allowance,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Scope {
    projects: Vec<String>,
    exclude_projects: Vec<String>,
    exclude_sessions: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct Weekly {
    day: u8,
    time: String,
    timezone: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Allowance {
    per_report_micros: u64,
    monthly_micros: u64,
    basis: String,
}

fn micros(usd: f64) -> Result<u64, Error> {
    let rounded = (usd * 1_000_000.0).round();
    if !rounded.is_finite() || rounded < 1.0 || rounded > MAX_SAFE as f64
        // Accept ordinary IEEE-754 multiplication noise, never round a sub-micro amount.
        || usd != rounded / 1_000_000.0
    {
        return Err(Error::Invalid);
    }
    Ok(rounded as u64)
}

impl Settings {
    pub fn from_intent(ui: &UiSettings, prior: Option<&Self>) -> Result<Self, Error> {
        if !valid_id(&ui.project_id) {
            return Err(Error::Invalid);
        }
        let result = Self {
            model: ui.model.clone(),
            thinking: prior
                .filter(|p| p.model == ui.model)
                .and_then(|p| p.thinking.clone()),
            source: Scope {
                projects: ui.source_project_ids.clone(),
                exclude_projects: prior
                    .map_or_else(Vec::new, |p| p.source.exclude_projects.clone()),
                exclude_sessions: ui.exclude_session_ids.clone(),
            },
            weekly: ui.schedule.as_ref().map(|s| Weekly {
                day: s.weekday,
                time: s.time.clone(),
                timezone: s.time_zone.clone(),
            }),
            allowance: Allowance {
                per_report_micros: micros(ui.per_report_usd)?,
                monthly_micros: micros(ui.monthly_usd)?,
                basis: "catalog_estimate".into(),
            },
        };
        result.validate()?;
        Ok(result)
    }

    pub fn validate(&self) -> Result<(), Error> {
        let lists = [
            &self.source.projects,
            &self.source.exclude_projects,
            &self.source.exclude_sessions,
        ];
        if self.model.trim().is_empty()
            || self.model.len() > 2048
            || self.model.contains(char::is_control)
            || self
                .thinking
                .as_deref()
                .is_some_and(|s| s.is_empty() || s.len() > 64 || s.contains(char::is_control))
            || self.source.projects.is_empty()
            || lists.iter().any(|ids| {
                ids.len() > 256
                    || ids.iter().any(|s| !valid_id(s))
                    || ids.iter().collect::<std::collections::BTreeSet<_>>().len() != ids.len()
            })
            || self.weekly.as_ref().is_some_and(|w| {
                let Some((hour, minute)) = w.time.split_once(':') else {
                    return true;
                };
                let time = |s: &str, max| {
                    s.len() == 2
                        && s.bytes().all(|b| b.is_ascii_digit())
                        && s.parse::<u8>().is_ok_and(|n| n <= max)
                };
                w.day > 6
                    || !time(hour, 23)
                    || !time(minute, 59)
                    || w.timezone.is_empty()
                    || w.timezone.len() > 128
                    || w.timezone.contains(char::is_control)
            })
            || self.allowance.basis != "catalog_estimate"
            || ![
                self.allowance.per_report_micros,
                self.allowance.monthly_micros,
            ]
            .into_iter()
            .all(|n| (1..=MAX_SAFE).contains(&n))
        {
            return Err(Error::Invalid);
        }
        Ok(())
    }

    pub fn ui(&self, owner: &Owner) -> Value {
        json!({
            "projectId":owner.project_id,
            "model":self.model,
            "sourceProjectIds":self.source.projects,
            "excludeSessionIds":self.source.exclude_sessions,
            "perReportUsd":self.allowance.per_report_micros as f64 / 1_000_000.0,
            "monthlyUsd":self.allowance.monthly_micros as f64 / 1_000_000.0,
            "schedule":self.weekly.as_ref().map(|w| json!({"weekday":w.day,"time":w.time,"timeZone":w.timezone})),
        })
    }

    pub fn review_lines(&self, project: &str) -> Vec<String> {
        // The catalog defines IDs as provider/model.
        let provider = self
            .model
            .split_once('/')
            .map_or("Not available", |(provider, _)| provider);
        let mut lines = vec![
            format!("Execution project: {project}"),
            format!("Provider: {provider}"),
            format!("Model: {}", self.model),
            format!("Source projects: {}", self.source.projects.join(", ")),
            format!("Excluded projects: {}", self.source.exclude_projects.join(", ")),
            format!("Excluded chats: {}", self.source.exclude_sessions.join(", ")),
            format!("Catalog estimate limits: ${:.6} per report and ${:.6} per UTC calendar month.",
                self.allowance.per_report_micros as f64 / 1_000_000.0, self.allowance.monthly_micros as f64 / 1_000_000.0),
            "Includes eligible active chats and chats archived in the previous 24 hours within scope.".into(),
            "The selected provider receives sanitized excerpts that may still contain private project text.".into(),
            "Reports stop when either allowance cannot cover the next request. These limits are estimates, not provider bills.".into(),
            self.weekly.as_ref().map_or_else(|| "Manual reports only.".into(), |w| {
                let day = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][usize::from(w.day)];
                format!("Weekly: {day} at {} ({}).", w.time, w.timezone)
            }),
        ];
        if let Some(thinking) = &self.thinking {
            lines.push(format!("Thinking: {thinking}"));
        }
        lines
    }
}
