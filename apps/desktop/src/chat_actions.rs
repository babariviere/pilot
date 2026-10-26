//! Exact Local row intents. Reads never settle an unacknowledged mutation.
use crate::{LocalOptions, local_model::Chat, mission_browser::Home};
use serde_json::Value;

pub(crate) type Failure = &'static str;
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
}
impl Evidence {
    pub(crate) fn read(target: &Target, raw: &Value, guarded: bool) -> Result<Self, Failure> {
        if !raw["title"].is_string()
            || !raw["cwd"].is_string()
            || ["projectId", "missionId", "continuedTo"].iter().any(|key| {
                !raw[*key].is_null()
                    && !raw[*key].as_str().is_some_and(crate::local_model::valid_id)
            })
            || ["control", "working", "sleepPaused", "offlinePaused", "canRetryStartup"]
                .iter()
                .any(|key| !raw[*key].is_null() && !raw[*key].is_boolean())
            || (!raw["runningJobs"].is_null() && !raw["runningJobs"].is_array())
        {
            return Err("Chat action metadata is incomplete or invalid.");
        }
        if crate::local_model::chat(raw).as_ref() != Some(&target.chat) {
            return Err("This chat changed. Reopen its menu to check the current actions.");
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
        ] {
            stamp.insert(key.into(), raw[key].clone());
        }
        stamp.insert("failed".into(), Value::Bool(!raw["failure"].is_null()));
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
        })
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Action {
    Archive,
    Convert,
    /// Reload a chat whose worker failed to start, keeping its outbox.
    Retry,
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
