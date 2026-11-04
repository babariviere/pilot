//! Exact Local row intents. Reads never settle an unacknowledged mutation.
use crate::{LocalOptions, local_model::Chat, mission_browser::Home};
use serde_json::Value;

pub(crate) type Failure = &'static str;
/// Menu-worded refusals. Other surfaces may word them for their own context.
pub(crate) const CHANGED: Failure =
    "This chat changed. Reopen its menu to check the current actions.";
pub(crate) const INELIGIBLE: Failure =
    "Chat eligibility changed. Reopen its menu. Nothing was submitted.";
#[derive(Clone, PartialEq, Eq)]
pub(crate) struct Target {
    pub(crate) host: crate::delivery_store::Host,
    pub(crate) home: Home,
    pub(crate) endpoint: String,
    pub(crate) chat: Chat,
}
impl Target {
    pub(crate) fn new(options: &LocalOptions, chat: Chat) -> Self {
        Self {
            host: options.host(),
            home: Home::local(&options.host()),
            endpoint: options.loopback(),
            chat,
        }
    }
    pub(crate) fn matches(&self, options: &LocalOptions) -> bool {
        self.host == options.host()
            && self.home == Home::local(&options.host())
            && self.endpoint == options.loopback()
            && !self.chat.local_draft
            && crate::local_model::valid_id(&self.chat.id)
    }
}

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct Evidence {
    pub(crate) target: Target,
    pub(crate) stamp: Value,
    pub(crate) archive: bool,
    pub(crate) can_archive: bool,
    pub(crate) can_convert: bool,
    /// The daemon can reload this chat's worker after a failed startup.
    pub(crate) can_retry_startup: bool,
    /// The chat's last run failed and nothing visible blocks pilotd's turn
    /// retry. pilotd remains authoritative for its own guards.
    pub(crate) can_retry_turn: bool,
    /// The chat's workspace has a recorded setup (created or restored with setup hooks).
    pub(crate) has_setup: bool,
    /// Setup can be queued again: an idle, unarchived chat with no setup running.
    /// pilotd also requires Automations on and an isolated Build workspace.
    pub(crate) can_rerun_setup: bool,
}
impl Evidence {
    pub(crate) fn read(target: &Target, raw: &Value, guarded: bool) -> Result<Self, Failure> {
        if !raw["title"].is_string()
            || !raw["cwd"].is_string()
            || ["projectId", "missionId", "continuedTo"].iter().any(|key| {
                !raw[*key].is_null()
                    && !raw[*key].as_str().is_some_and(crate::local_model::valid_id)
            })
            || [
                "control",
                "working",
                "sleepPaused",
                "offlinePaused",
                "canRetryStartup",
            ]
            .iter()
            .any(|key| !raw[*key].is_null() && !raw[*key].is_boolean())
            || (!raw["runningJobs"].is_null() && !raw["runningJobs"].is_array())
            || (!raw["workspaceSetup"].is_null() && !raw["workspaceSetup"]["state"].is_string())
        {
            return Err("Chat action metadata is incomplete or invalid.");
        }
        if crate::local_model::chat(raw).as_ref() != Some(&target.chat) {
            return Err(CHANGED);
        }
        if !matches!(
            raw["state"].as_str(),
            Some("parked" | "idle" | "working" | "starting" | "failed")
        ) {
            return Err("Chat state is unavailable. No action was submitted.");
        }
        if !raw["archivedAt"].is_null() && !raw["archivedAt"].is_u64() {
            return Err("Archive metadata is unavailable.");
        }
        let archived = raw["archivedAt"].is_number();
        let working = raw["sleepPaused"] != true
            && raw["offlinePaused"] != true
            && raw["working"].as_bool().unwrap_or(
                matches!(raw["state"].as_str(), Some("working" | "starting"))
                    || raw["runningJobs"].as_array().is_some_and(|j| !j.is_empty()),
            );
        let mut stamp = serde_json::Map::new();
        // Only bounded action metadata, never conversation/history or credentials.
        for key in [
            "id",
            "projectId",
            "cwd",
            "title",
            "state",
            "createdAt",
            "updatedAt",
            "executionPermission",
            "working",
            "archivedAt",
            "control",
            "role",
            "diagnosticHost",
            "continuedTo",
            "mode",
            "missionId",
            "missionCoordinator",
            "activeMissionCoordinator",
            "sleepPaused",
            "offlinePaused",
            "initializing",
            "preparing",
            "workspaceRecovery",
            "kernelRestartPending",
            "canRetryStartup",
            "outcome",
            "outcomeAt",
        ] {
            stamp.insert(key.into(), raw[key].clone());
        }
        stamp.insert("failed".into(), Value::Bool(!raw["failure"].is_null()));
        stamp.insert(
            "nextAttemptModel".into(),
            Value::Bool(!raw["nextAttemptModel"].is_null()),
        );
        stamp.insert("setup".into(), raw["workspaceSetup"]["state"].clone());
        stamp.insert(
            "attempt".into(),
            raw["attempts"]
                .as_array()
                .and_then(|a| a.iter().find(|a| a["active"] == true))
                .map_or(Value::Null, |a| a["id"].clone()),
        );
        for key in ["pending", "runningJobs"] {
            stamp.insert(
                key.into(),
                Value::from(raw[key].as_array().map_or(0, Vec::len)),
            );
        }
        if serde_json::to_vec(&stamp)
            .map_err(|_| "Invalid action metadata")?
            .len()
            > 64 * 1024
        {
            return Err("Chat action metadata exceeds its limit.");
        }
        let idle = !archived
            && !working
            && matches!(raw["state"].as_str(), Some("idle" | "parked"))
            && raw["sleepPaused"] != true
            && raw["offlinePaused"] != true
            && raw["runningJobs"].as_array().is_none_or(Vec::is_empty);
        let has_setup = raw["workspaceSetup"]["state"].is_string();
        Ok(Self {
            target: target.clone(),
            stamp: Value::Object(stamp),
            archive: !archived,
            can_archive: raw["control"] != true && (archived || !working),
            can_convert: guarded
                && crate::local_model::interactive_local(raw)
                && raw["missionId"].is_null()
                && target.chat.project_id.is_some(),
            can_retry_startup: raw["canRetryStartup"] == true,
            can_retry_turn: raw["outcome"] == "failed"
                && raw["canRetryStartup"] != true
                && raw["nextAttemptModel"].is_null()
                && idle
                && crate::local_model::messageable_local(raw),
            has_setup,
            can_rerun_setup: has_setup
                && idle
                && raw["control"] != true
                && raw["workspaceSetup"]["state"] != "pending",
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Action {
    Archive,
    Convert,
    /// Reload a chat whose worker failed to start, keeping its outbox.
    Retry,
    /// Swift's failed-turn Retry: pilotd starts a new attempt from before the
    /// user message that began this failed assistant entry and sends that
    /// message again. The failed attempt stays in history.
    RetryTurn(u64),
    /// Queue the workspace setup hooks again (`POST /api/sessions/:id/setup`).
    /// No model turn; never repeated after an unconfirmed answer.
    RerunSetup,
}
impl Action {
    pub(crate) fn retry(self) -> bool {
        matches!(self, Self::Retry | Self::RetryTurn(_))
    }
}
#[derive(Clone, PartialEq, Eq)]
pub(crate) enum Outcome {
    Acknowledged,
    Rejected(Failure),
    Unknown,
}

/// One immutable operation/report. A late or repeated completion cannot replace it.
pub(crate) struct Report {
    pub(crate) id: u64,
    pub(crate) evidence: Evidence,
    pub(crate) action: Action,
    pub(crate) outcome: Option<Outcome>,
    pub(crate) observed_current: bool,
}
impl Report {
    pub(crate) fn finish(&mut self, id: u64, evidence: &Evidence, outcome: Outcome) -> bool {
        if self.id != id || &self.evidence != evidence || self.outcome.is_some() {
            return false;
        }
        self.outcome = Some(outcome);
        true
    }
}

#[cfg(test)]
#[path = "chat_actions_tests.rs"]
mod tests;
