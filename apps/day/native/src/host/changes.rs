//! Stored Changes review-request records. Day never offered this write in
//! production, but the journal still reads and checks any stored line.
use super::{Error, Source, valid_id};
use crate::{changes::AttentionAsk, changes_contract as c, changes_project as project};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(super) struct Record {
    pub kind: String,
    pub version: u32,
    pub sequence: u64,
    pub source: Source,
    pub target: c::Target,
    pub action: String,
    pub command: Value,
    pub receipt: Option<Value>,
    pub not_sent: bool,
}
impl Record {
    pub fn id(&self) -> &str {
        self.command["operationId"].as_str().unwrap_or("")
    }
    fn snapshot(&self) -> &str {
        &self.target.snapshot_id
    }
    fn ask(&self) -> AttentionAsk {
        if self.action == "snooze" {
            AttentionAsk::Later
        } else {
            AttentionAsk::BringBack
        }
    }
    pub fn validate(&self) -> Result<(), Error> {
        if self.kind != "changes"
            || self.version != 1
            || self.sequence == 0
            || !valid_id(self.id())
            || !valid_id(self.snapshot())
            || !valid_id(&self.target.session_id)
            || self.target.project_id != self.source.project()?.project_id
            || !matches!(self.action.as_str(), "snooze" | "resume")
            || self.command["expectedRevision"]
                .as_u64()
                .is_none_or(|n| n == 0 || n >= u32::MAX as u64)
            || self.command["requestId"]
                .as_str()
                .is_none_or(|s| !valid_id(s))
            || self.command["reason"] != reason(self.ask())
            || self.command.as_object().is_none_or(|o| o.len() != 4)
        {
            return Err(Error::Storage);
        }
        if let Some(r) = &self.receipt {
            exact(r, self)?;
        }
        Ok(())
    }
}
fn reason(ask: AttentionAsk) -> &'static str {
    match ask {
        AttentionAsk::Later => "Later",
        AttentionAsk::BringBack => "Bring back",
    }
}
fn exact(receipt: &Value, record: &Record) -> Result<(), Error> {
    let mut payload = record.command.clone();
    payload["action"] = json!(record.action);
    let target: c::Target =
        serde_json::from_value(receipt["target"].clone()).map_err(|_| Error::Unknown)?;
    if receipt["operationId"] != record.id()
        || receipt["actor"] != json!({"kind":"native-user"})
        || receipt["payloadHash"] != project::sha256(&project::canonical(&payload))
        || receipt["requestId"] != record.command["requestId"]
        || receipt["revision"].as_u64()
            != record.command["expectedRevision"]
                .as_u64()
                .and_then(|n| n.checked_add(1))
        || receipt["state"]
            != if record.action == "snooze" {
                "snoozed"
            } else {
                "pending"
            }
        || target != record.target
    {
        return Err(Error::Unknown);
    }
    Ok(())
}
