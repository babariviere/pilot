//! Existing interview contracts on the same host worker and private command ledger.
use super::{Error, Source, valid_id};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(super) struct PlanningRecord {
    pub version: u32,
    pub source: Source,
    pub operation: Value,
    pub receipt: Option<Value>,
    pub not_sent: bool,
}
impl PlanningRecord {
    pub fn id(&self) -> &str {
        self.operation["operationId"].as_str().unwrap_or("")
    }
    pub fn mission(&self) -> &str {
        self.operation["targetId"].as_str().unwrap_or("")
    }
    pub fn pending(&self) -> bool {
        !self.not_sent
            && self
                .receipt
                .as_ref()
                .is_none_or(|r| r["state"] == "pending")
    }
    pub fn validate(&self) -> Result<(), Error> {
        let o = &self.operation;
        if self.version != 1
            || !valid_id(self.id())
            || !valid_id(self.mission())
            || o["schemaVersion"] != 1
            || o["origin"] != home(&self.source, "local")
            || o["destination"] != home(&self.source, "daemon")
            || !matches!(
                o["kind"].as_str(),
                Some("interview-save" | "interview-submit")
            )
            || o["payload"]
                .as_str()
                .is_none_or(|p| p.len() > 65536 || hash(p) != o["payloadHash"])
        {
            return Err(Error::Storage);
        }
        if let Some(r) = &self.receipt {
            exact(r.clone(), o)?;
        }
        Ok(())
    }
    pub fn summary(&self) -> Value {
        json!({"operationId":self.id(), "missionId":self.mission(), "kind":self.operation["kind"],
            "state": if self.not_sent {"not-sent"} else {self.receipt.as_ref().and_then(|r| r["state"].as_str()).unwrap_or("unknown")},
            "receipt":self.receipt})
    }
}
fn hash(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}
fn home(source: &Source, host: &str) -> Value {
    json!({"hostId":host,"daemonId":source.home.daemon_id,"lineageId":source.home.lineage_id})
}
pub(super) fn record(
    source: &Source,
    mission: String,
    digest: String,
    request: Value,
) -> Result<PlanningRecord, Error> {
    if !valid_id(&mission)
        || digest.len() != 64
        || !digest.bytes().all(|b| b.is_ascii_hexdigit())
        || !matches!(
            request["purpose"].as_str(),
            Some("interview-save" | "interview-submit")
        )
        || request["expected"]["fence"]["missionId"] != mission
    {
        return Err(Error::Invalid);
    }
    let payload = serde_json::to_string(&request).map_err(|_| Error::Invalid)?;
    let id = uuid::Uuid::new_v4().to_string();
    let r = PlanningRecord {
        version: 1,
        source: source.clone(),
        receipt: None,
        not_sent: false,
        operation: json!({"schemaVersion":1,"operationId":id,"producerId":uuid::Uuid::new_v4().to_string(),"sequence":1,
            "origin":home(source,"local"),"destination":home(source,"daemon"),"kind":request["purpose"],
            "targetId":mission,"payloadHash":hash(&payload),"payload":payload,"bindingId":digest,"bindingGeneration":1}),
    };
    r.validate()?;
    Ok(r)
}
pub(super) fn exact(r: Value, op: &Value) -> Result<Value, Error> {
    if r["operationId"] != op["operationId"]
        || r["payloadHash"] != op["payloadHash"]
        || r["destination"] != op["destination"]
        || r["targetId"] != op["targetId"]
        || !matches!(
            r["state"].as_str(),
            Some("pending" | "accepted" | "rejected")
        )
    {
        return Err(Error::Unknown);
    }
    Ok(r)
}
