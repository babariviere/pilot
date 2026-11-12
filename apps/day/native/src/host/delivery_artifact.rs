//! Read-only captured source, not a renderer, revision catalogue or artifact runtime.
use super::{Error, Transport, delivery, valid_id};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Request {
    subject: delivery::Subject,
    target_id: String,
    delivery_id: String,
    owner_session_id: Option<String>,
    source_session_id: String,
    artifact_id: String,
    revision: u64,
}
impl Request {
    pub(crate) fn validate(&self) -> Result<(), Error> {
        self.subject.validate()?;
        if !matches!(self.subject, delivery::Subject::Task { .. })
            || !delivery::digest(&self.target_id)
            || !delivery::digest(&self.delivery_id)
            || !valid_id(&self.source_session_id)
            || self.owner_session_id.as_ref().is_some_and(|s| !valid_id(s))
            || uuid::Uuid::parse_str(&self.artifact_id).is_err()
            || self.artifact_id.len() != 36
            || self.revision == 0
            || self.revision > 9_007_199_254_740_991
        {
            return Err(Error::Invalid);
        }
        Ok(())
    }
    fn qualifies(&self, page: &Value) -> Result<(), Error> {
        if page["subject"] != serde_json::to_value(&self.subject).map_err(|_| Error::Invalid)?
            || page["targetId"] != self.target_id
            || page["deliveryId"] != self.delivery_id
            || page["ownerSessionId"] != json!(self.owner_session_id)
        {
            return Err(Error::Stale);
        }
        let links = page["artifacts"].as_array().ok_or(Error::Invalid)?;
        if !links.iter().any(|a| {
            a["artifactId"] == self.artifact_id
                && a["sessionId"] == self.source_session_id
                && a["revision"] == self.revision
        }) || links.iter().any(|a| {
            a["artifactId"] == self.artifact_id && a["sessionId"] != self.source_session_id
        }) {
            return Err(Error::Stale);
        }
        Ok(())
    }
}

pub(super) async fn read(t: &Transport, request: &Request) -> Result<Value, Error> {
    request.validate()?;
    let page = delivery::read(t, &request.subject).await?;
    request.qualifies(&page)?;
    // All components passed the identifier/digest/integer checks. No supplied
    // URL, path, query fragment or callback can enter this purpose-specific GET.
    let result = t.get(&format!(
        "{}/artifact?targetId={}&deliveryId={}&ownerSessionId={}&sourceSessionId={}&artifactId={}&revision={}",
        request.subject.path(), request.target_id, request.delivery_id,
        request.owner_session_id.as_deref().unwrap_or(""), request.source_session_id,
        request.artifact_id, request.revision,
    )).await?;
    let expected = serde_json::to_value(request).map_err(|_| Error::Invalid)?;
    if result["version"] != 1
        || result["reference"] != expected
        || result["rendering"] != "unsupported"
    {
        return Err(Error::Invalid);
    }
    // Deserialize only the inert contract. Never pass HTML, data, callbacks or
    // unlisted daemon fields to the VM, even if a future server adds them.
    let kind = result["metadata"]["kind"].as_str().ok_or(Error::Invalid)?;
    if !page["artifacts"]
        .as_array()
        .ok_or(Error::Invalid)?
        .iter()
        .any(|a| {
            a["artifactId"] == request.artifact_id
                && a["revision"] == request.revision
                && a["kind"] == kind
        })
    {
        return Err(Error::Stale);
    }
    let title = result["metadata"]["title"]
        .as_str()
        .filter(|s| s.len() <= 640)
        .ok_or(Error::Invalid)?;
    if !matches!(
        kind,
        "html" | "react" | "swiftui" | "shader" | "visual" | "image"
    ) {
        return Err(Error::Invalid);
    }
    let content = match result["content"]["state"].as_str() {
        Some("text") if kind != "image" => {
            let source = result["content"]["source"]
                .as_str()
                .filter(|s| s.len() <= 512 * 1024)
                .ok_or(Error::Invalid)?;
            let digest = result["content"]["containerSha256"]
                .as_str()
                .filter(|s| delivery::digest(s))
                .ok_or(Error::Invalid)?;
            let bytes = result["content"]["containerBytes"]
                .as_u64()
                .filter(|n| *n <= 1024 * 1024)
                .ok_or(Error::Invalid)?;
            json!({"state":"text","source":source,"containerSha256":digest,"containerBytes":bytes})
        }
        Some("unavailable") => {
            let reason = result["content"]["reason"].as_str().ok_or(Error::Invalid)?;
            if !matches!(
                reason,
                "missing" | "oversize" | "redacted" | "unsupported" | "invalid"
            ) {
                return Err(Error::Invalid);
            }
            json!({"state":"unavailable","reason":reason})
        }
        _ => return Err(Error::Invalid),
    };
    // The artifact endpoint is the final asynchronous disclosure barrier: it
    // checks current delivery/source membership after reading captured bytes.
    // Do not await an unrelated delivery GET afterwards (that GET alone does
    // not check source custody and could hide a revocation during that wait).
    Ok(
        json!({"version":1,"reference":expected,"metadata":{"kind":kind,"title":title},
        "rendering":"unsupported","content":content}),
    )
}
