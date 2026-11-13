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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub setup_digest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verification_pin: Option<super::delivery::Pin>,
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
                Some(
                    "interview-save"
                        | "interview-submit"
                        | "planning-enroll"
                        | "plan-start"
                        | "plan-revisit"
                        | "revision-preview"
                        | "revision-confirm"
                        | "intake-triage"
                        | "intake-start"
                        | "native-chat-create"
                        | "user-verification"
                        | "project-preferences-update"
                        | "thread-create"
                        | "thread-disposition"
                        | "thread-reference"
                        | "thread-send"
                )
            )
            || o["payload"]
                .as_str()
                .is_none_or(|p| p.len() > 65536 || hash(p) != o["payloadHash"])
        {
            return Err(Error::Storage);
        }
        if o["kind"] == "user-verification" {
            super::delivery::validate_record(self)?;
        } else if self.verification_pin.is_some() {
            return Err(Error::Storage);
        } else if let Some(r) = &self.receipt {
            exact(r.clone(), o)?;
        }
        if o["kind"] == "planning-enroll" {
            super::enrollment::validate_record(&self.source, o, self.setup_digest.as_deref())?;
        }
        if matches!(o["kind"].as_str(), Some("intake-triage" | "intake-start")) {
            super::intake::validate_record(&self.source, o)?;
        }
        if o["kind"] == "native-chat-create" {
            super::new_chat::validate_record(o)?;
        }
        if o["kind"] == super::preferences::KIND {
            super::preferences::validate_record(&self.source, o)?;
        }
        if o["kind"].as_str().is_some_and(super::threads::is_thread_kind) {
            super::threads::validate_record(o)?;
        }
        Ok(())
    }
    pub fn summary(&self) -> Value {
        let enrollment = self.operation["kind"] == "planning-enroll";
        let request: Value = self.operation["payload"]
            .as_str()
            .and_then(|p| serde_json::from_str(p).ok())
            .unwrap_or(Value::Null);
        json!({"operationId":self.id(), "missionId":if enrollment {self.receipt.as_ref().map(|r| r["result"]["missionId"].clone()).unwrap_or(Value::Null)} else {json!(self.mission())},
            "proposalId":request["proposalId"],
            "enrollmentId":if enrollment {json!(self.mission())} else {Value::Null}, "setupDigest":self.setup_digest,
            "kind":self.operation["kind"],
            "state": if self.not_sent {"not-sent"} else {self.receipt.as_ref().and_then(|r| r["state"].as_str()).unwrap_or("unknown")},
            "receipt":self.receipt})
    }
}
pub(super) fn hash(text: &str) -> String {
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
    record_pinned(source, mission, digest, request, None)
}
pub(super) fn verification_record(
    source: &Source,
    target: String,
    digest: String,
    request: Value,
    pin: super::delivery::Pin,
) -> Result<PlanningRecord, Error> {
    if request["purpose"] != "user-verification" {
        return Err(Error::Invalid);
    }
    record_pinned(source, target, digest, request, Some(pin))
}
fn record_pinned(
    source: &Source,
    mission: String,
    digest: String,
    request: Value,
    verification_pin: Option<super::delivery::Pin>,
) -> Result<PlanningRecord, Error> {
    if !valid_id(&mission)
        || digest.len() != 64
        || !digest.bytes().all(|b| b.is_ascii_hexdigit())
        || !matches!(
            request["purpose"].as_str(),
            Some(
                "interview-save"
                    | "interview-submit"
                    | "plan-start"
                    | "plan-revisit"
                    | "revision-preview"
                    | "revision-confirm"
                    | "intake-triage"
                    | "intake-start"
                    | "native-chat-create"
                    | "user-verification"
                    | "project-preferences-update"
                    | "thread-create"
                    | "thread-disposition"
                    | "thread-reference"
                    | "thread-send"
            )
        )
        || (!matches!(
            request["purpose"].as_str(),
            Some(
                "plan-start"
                    | "plan-revisit"
                    | "revision-preview"
                    | "revision-confirm"
                    | "intake-triage"
                    | "intake-start"
                    | "native-chat-create"
                    | "user-verification"
                    | "project-preferences-update"
                    | "thread-create"
                    | "thread-disposition"
                    | "thread-reference"
                    | "thread-send"
            )
        ) && request["expected"]["fence"]["missionId"] != mission)
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
        setup_digest: None,
        verification_pin,
        operation: json!({"schemaVersion":1,"operationId":id,"producerId":uuid::Uuid::new_v4().to_string(),"sequence":1,
            "origin":home(source,"local"),"destination":home(source,"daemon"),"kind":request["purpose"],
            "targetId":mission,"payloadHash":hash(&payload),"payload":payload,"bindingId":digest,"bindingGeneration":1}),
    };
    r.validate()?;
    Ok(r)
}
pub(super) fn exact(r: Value, op: &Value) -> Result<Value, Error> {
    // Verification needs both receipts and its native owner pin, never this generic path.
    if op["kind"] == "user-verification"
        || r["operationId"] != op["operationId"]
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
    if op["kind"] == "planning-enroll" && r["state"] == "accepted" {
        let request: Value = serde_json::from_str(op["payload"].as_str().ok_or(Error::Unknown)?)
            .map_err(|_| Error::Unknown)?;
        if r["result"]["enrollmentId"] != op["targetId"]
            || r["result"]["ownerSessionId"] != request["ownerSessionId"]
            || r["result"]["missionId"]
                .as_str()
                .is_none_or(|s| !valid_id(s))
        {
            return Err(Error::Unknown);
        }
    }
    if op["kind"] == "plan-start"
        && r["state"] == "accepted"
        && (r["result"]["admissionId"] != op["operationId"]
            || r["result"]["sessionId"]
                .as_str()
                .is_none_or(|s| !valid_id(s)))
    {
        return Err(Error::Unknown);
    }
    if op["kind"] == "plan-revisit"
        && r["state"] == "accepted"
        && r["result"]["admissionId"] != op["operationId"]
    {
        return Err(Error::Unknown);
    }
    if matches!(
        op["kind"].as_str(),
        Some("revision-preview" | "revision-confirm")
    ) && r["state"] == "accepted"
    {
        let p: Value = serde_json::from_str(op["payload"].as_str().ok_or(Error::Unknown)?)
            .map_err(|_| Error::Unknown)?;
        let result = &r["result"];
        if result["missionId"] != op["targetId"]
            || (op["kind"] == "revision-preview"
                && (result["operationId"] != op["operationId"]
                    || result["repreviewOf"]["id"] != p["proposalId"]
                    || result["repreviewOf"]["digest"] != p["digest"]
                    || result["source"] != p["source"]))
            || (op["kind"] == "revision-confirm"
                && (result["id"] != p["proposalId"]
                    || result["digest"] != p["digest"]
                    || result["confirmation"]["humanSource"]
                        != format!(
                            "native-revision:{}",
                            op["operationId"].as_str().unwrap_or("")
                        )))
        {
            return Err(Error::Unknown);
        }
    }
    if op["kind"] == "intake-start" && r["state"] == "accepted" {
        let p: Value = serde_json::from_str(op["payload"].as_str().ok_or(Error::Unknown)?)
            .map_err(|_| Error::Unknown)?;
        if r["result"]["sessionId"] != p["sessionId"]
            || r["result"]["itemId"] != op["targetId"]
            || r["result"]["admissionId"] != op["operationId"]
        {
            return Err(Error::Unknown);
        }
    }
    if op["kind"] == "native-chat-create" && r["state"] == "accepted" {
        let p: Value = serde_json::from_str(op["payload"].as_str().ok_or(Error::Unknown)?)
            .map_err(|_| Error::Unknown)?;
        if r["result"]["sessionId"] != op["targetId"]
            || r["result"]["projectId"] != p["projectId"]
            || r["result"]["admissionId"] != op["operationId"]
        {
            return Err(Error::Unknown);
        }
    }
    if op["kind"] == super::preferences::KIND && r["state"] == "accepted" {
        super::preferences::exact_result(op, &r)?;
    }
    if op["kind"].as_str().is_some_and(super::threads::is_thread_kind) && r["state"] == "accepted" {
        super::threads::exact_result(op, &r)?;
    }
    Ok(r)
}

pub(super) fn enrollment_record(
    source: &Source,
    enrollment: &str,
    setup: &str,
    request: Value,
) -> Result<PlanningRecord, Error> {
    let payload = serde_json::to_string(&request).map_err(|_| Error::Invalid)?;
    let r = PlanningRecord {
        version: 1,
        source: source.clone(),
        receipt: None,
        not_sent: false,
        setup_digest: Some(setup.into()),
        verification_pin: None,
        operation: json!({"schemaVersion":1,"operationId":uuid::Uuid::new_v4().to_string(),
            "producerId":uuid::Uuid::new_v4().to_string(),"sequence":1,"origin":home(source,"local"),
            "destination":home(source,"daemon"),"kind":"planning-enroll","targetId":enrollment,
            "payloadHash":hash(&payload),"payload":payload,"bindingId":request["configurationDigest"],"bindingGeneration":1}),
    };
    r.validate()?;
    Ok(r)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn start_ack_requires_exact_kernel_admission_and_worker_identity() {
        let op = json!({"kind":"plan-start", "operationId":"start", "payloadHash":"digest", "destination":{"home":"one"}, "targetId":"mission"});
        let receipt = json!({"operationId":"start", "payloadHash":"digest", "destination":{"home":"one"}, "targetId":"mission", "state":"accepted", "result":{"admissionId":"start","sessionId":"worker"}});
        assert!(exact(receipt.clone(), &op).is_ok());
        for result in [
            json!({}),
            json!({"admissionId":"other","sessionId":"worker"}),
            json!({"admissionId":"start","sessionId":"invalid/id"}),
        ] {
            let mut wrong = receipt.clone();
            wrong["result"] = result;
            assert!(matches!(exact(wrong, &op), Err(Error::Unknown)));
        }
    }
}
