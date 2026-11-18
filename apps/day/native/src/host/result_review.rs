//! Private review storage only. Save once after fsync; recovery only reads receipts.
use super::{Error, Source, Transport, delivery, valid_id};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

// A 32 KiB edit plus a 16,000-byte service excerpt at JSON's worst 6x escaping,
// subject/owner IDs and framing fit below 160 KiB. Reserve this before PUT.
pub(super) const MAX_RECEIPT_BYTES: u64 = 160 * 1024;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Request {
    pub subject: delivery::Subject,
    pub delivery_id: String,
    pub kind: String,
    pub snapshot_id: Option<String>,
    pub edit: Option<Value>,
    pub before_revision: Option<u64>,
}
impl Request {
    pub(crate) fn validate(&self) -> Result<(), Error> {
        self.subject.validate()?;
        if !delivery::digest(&self.delivery_id)
            || !matches!(self.kind.as_str(), "read" | "diff" | "save")
            || self.snapshot_id.as_ref().is_some_and(|id| !valid_id(id))
            || (self.kind == "diff") != self.snapshot_id.is_some()
            || (self.kind == "save") != self.edit.is_some()
            || self
                .before_revision
                .is_some_and(|n| self.kind != "read" || n == 0 || n > 9_007_199_254_740_991)
        {
            return Err(Error::Invalid);
        }
        if let Some(edit) = &self.edit {
            if edit["deliveryId"] != self.delivery_id
                || edit["operationId"].as_str().is_none_or(|id| !valid_id(id))
                || serde_json::to_vec(edit).map_err(|_| Error::Invalid)?.len() > 32 * 1024
            {
                return Err(Error::Invalid);
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(super) struct Record {
    pub review_operation: String,
    pub source: Source,
    pub request: Request,
    pub receipt: Option<Value>,
}
impl Record {
    pub fn terminal_reservation(&self) -> Result<u64, Error> {
        let mut pending = self.clone();
        pending.receipt = None;
        Ok(serde_json::to_vec(&pending)
            .map_err(|_| Error::Storage)?
            .len() as u64
            + MAX_RECEIPT_BYTES
            + 1)
    }
    pub fn validate(&self) -> Result<(), Error> {
        self.request.validate().map_err(|_| Error::Storage)?;
        if self.request.kind != "save"
            || self.request.subject.project() != self.source.project()?.project_id
            || !valid_id(&self.review_operation)
            || self
                .request
                .edit
                .as_ref()
                .is_none_or(|e| e["operationId"] != self.review_operation)
        {
            return Err(Error::Storage);
        }
        if let Some(receipt) = &self.receipt {
            self.exact(receipt)?;
        }
        Ok(())
    }
    pub fn follows(&self, old: &Self) -> bool {
        self.review_operation == old.review_operation
            && self.source == old.source
            && self.request == old.request
            && (old.receipt.is_none() || old.receipt == self.receipt)
    }
    fn exact(&self, receipt: &Value) -> Result<(), Error> {
        if serde_json::to_vec(receipt)
            .map_err(|_| Error::Unknown)?
            .len() as u64
            > MAX_RECEIPT_BYTES
        {
            return Err(Error::Unknown);
        }
        let edit = self.request.edit.as_ref().ok_or(Error::Storage)?;
        if receipt["subject"]
            != serde_json::to_value(&self.request.subject).map_err(|_| Error::Storage)?
        {
            return Err(Error::Unknown);
        }
        for key in [
            "operationId",
            "deliveryId",
            "expectedRevision",
            "kind",
            "body",
        ] {
            if receipt[key] != edit[key] {
                return Err(Error::Unknown);
            }
        }
        if receipt["state"] != "rejected"
            && receipt["revision"].as_u64()
                != edit["expectedRevision"]
                    .as_u64()
                    .and_then(|n| n.checked_add(1))
            || receipt["anchor"]["kind"] != edit["anchor"]["kind"]
        {
            return Err(Error::Unknown);
        }
        // Only excerpt is service-supplied. Every original location field stays exact.
        let anchor = edit["anchor"].as_object().ok_or(Error::Invalid)?;
        for (key, value) in anchor {
            if key != "excerpt" && receipt["anchor"][key] != *value {
                return Err(Error::Unknown);
            }
        }
        Ok(())
    }
}

pub(super) async fn handle(
    t: &Transport,
    journal: &mut super::Journal,
    shared: &super::Shared,
    request: &Request,
    gate: &std::sync::Mutex<crate::bridge::Gate>,
) -> Result<Value, Error> {
    request.validate()?;
    t.gate(false).await?;
    let shown = delivery::read(t, &request.subject).await?;
    if shown["deliveryId"] != request.delivery_id {
        return Err(Error::Stale);
    }
    let path = format!("{}/review", request.subject.path());
    let pending: Vec<_> = journal
        .result_reviews
        .values()
        .filter(|r| {
            delivery::receipt_source(&r.source, &t.source)
                && r.request.subject == request.subject
                && r.receipt.is_none()
        })
        .map(|r| r.review_operation.clone())
        .collect();
    let data = match request.kind.as_str() {
        "read" => {
            t.get(&match request.before_revision {
                Some(n) => format!("{path}?beforeRevision={n}"),
                None => path.clone(),
            })
            .await?
        }
        "diff" => {
            t.get(&format!(
                "{path}/diff/{}",
                request.snapshot_id.as_deref().ok_or(Error::Invalid)?
            ))
            .await?
        }
        "save" => {
            if !pending.is_empty() {
                return Err(Error::Unknown);
            }
            shared.open()?;
            crate::bridge::Command::ResultReview(request.clone())
                .admit(&gate.lock().expect("bridge gate poisoned"))?;
            let edit = request.edit.as_ref().ok_or(Error::Invalid)?;
            let id = edit["operationId"]
                .as_str()
                .ok_or(Error::Invalid)?
                .to_owned();
            if journal.result_reviews.contains_key(&id) {
                return Err(Error::Unknown);
            }
            let record = Record {
                review_operation: id.clone(),
                source: t.source.clone(),
                request: request.clone(),
                receipt: None,
            };
            let token = t.local()?;
            journal.save_result_review(record)?;
            shared.open()?;
            crate::bridge::Command::ResultReview(request.clone())
                .admit(&gate.lock().expect("bridge gate poisoned"))?;
            let response = t
                .client
                .put(t.url(&path))
                .header("x-pilot-github-capability", token)
                .header("content-type", "application/json")
                .body(edit.to_string())
                .send()
                .await;
            match response {
                Ok(r) if r.status().is_success() => return check(t, journal, &id).await,
                _ => return Ok(json!({"state":"unknown", "operationId":id, "receipt":null})),
            }
        }
        _ => return Err(Error::Invalid),
    };
    // These reads never settle a saved operation or authorize replay.
    shared.open()?;
    if request.kind == "read" && data["deliveryId"] != request.delivery_id {
        return Err(Error::Stale);
    }
    Ok(json!({"data":data,"pending":pending}))
}
pub(super) async fn check(
    t: &Transport,
    journal: &mut super::Journal,
    id: &str,
) -> Result<Value, Error> {
    t.gate(false).await?;
    let mut record = journal
        .result_reviews
        .get(id)
        .filter(|r| delivery::receipt_source(&r.source, &t.source))
        .cloned()
        .ok_or(Error::Stale)?;
    let receipt = t
        .get(&format!(
            "{}/review/operations/{id}",
            record.request.subject.path()
        ))
        .await?;
    if !receipt.is_null() {
        record.exact(&receipt)?;
        record.receipt = Some(receipt.clone());
        journal.save_result_review(record)?;
    }
    Ok(
        json!({"operationId":id,"state":if receipt.is_null() {"unknown"} else if receipt["state"] == "rejected" {"rejected"} else {"saved"},"receipt":receipt}),
    )
}
