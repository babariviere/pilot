//! One explicit Allow/Deny decision for an exact pending database-access request.
//! pilotd's exact request-ID check is the grant authority. Nothing is resent:
//! a lost reply stays Unknown and only another explicit choice may post again.
use crate::{
    LocalOptions,
    delivery_store::Failure,
    question::{Access, Identity},
};
use serde_json::{Value, json};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Decision {
    /// The chat whose transcript holds the request.
    pub(crate) session: String,
    /// The exact projected question entry the user decided.
    pub(crate) question: Identity,
    pub(crate) access: Access,
    pub(crate) allow: bool,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Outcome {
    Pending,
    /// pilotd's exact 202 acknowledgment.
    Accepted,
    /// Refused before any change: nothing was decided by this request.
    Refused(Failure),
    /// The decision may or may not have been applied. Never resent.
    Unknown(Failure),
}
#[derive(Clone, Debug)]
pub(crate) struct Reply {
    pub(crate) decision: Decision,
    pub(crate) request: u64,
    pub(crate) outcome: Outcome,
}

pub(crate) const UNKNOWN: Failure = "Couldn't confirm the decision. It was not resent; choose again only if the request stays open.";
pub(crate) const NOT_PENDING: Failure =
    "This request is no longer pending. It may already have been decided.";
const BODY_CAP: usize = 16 * 1024;

/// Bounded body read. Any interruption leaves the decision unconfirmed.
async fn body(mut response: reqwest::Response) -> Option<Value> {
    if response
        .content_length()
        .is_some_and(|n| n > BODY_CAP as u64)
    {
        return None;
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.ok()? {
        if bytes.len() + chunk.len() > BODY_CAP {
            return None;
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).ok()
}

/// Pins the daemon identity, then posts exactly `{id, allow}` once.
pub(crate) async fn submit(
    client: &reqwest::Client,
    options: &LocalOptions,
    decision: &Decision,
) -> Outcome {
    if !crate::local_model::valid_id(&decision.session) || decision.question.validate().is_err() {
        return Outcome::Refused("This access request's identity is invalid. Nothing was sent.");
    }
    if let Err(error) = crate::local_client::gate(client, options).await {
        return Outcome::Refused(error);
    }
    let payload = json!({ "id": decision.access.id, "allow": decision.allow });
    let Ok(bytes) = serde_json::to_vec(&payload) else {
        return Outcome::Refused("The decision could not be encoded. Nothing was sent.");
    };
    let response = client
        .post(format!(
            "{}/api/sessions/{}/database-access",
            options.loopback(),
            decision.session
        ))
        .header("Content-Type", "application/json")
        .body(bytes)
        .send()
        .await;
    let Ok(response) = response else {
        return Outcome::Unknown(UNKNOWN);
    };
    let status = response.status().as_u16();
    let value = body(response).await;
    classify(&decision.session, status, value.as_ref())
}

/// Only responses pilotd returns before changing anything are refusals.
/// A 409 after the decision is saved (its follow-up message failed) stays Unknown.
fn classify(session: &str, status: u16, value: Option<&Value>) -> Outcome {
    let error = value.and_then(|v| v["error"].as_str());
    match status {
        202 if value.is_some_and(|v| v["ok"] == true) => Outcome::Accepted,
        400 => Outcome::Refused("Local rejected the decision as malformed. Nothing changed."),
        404 if error == Some(format!("Unknown session: {session}").as_str()) => {
            Outcome::Refused("This chat is no longer available. Nothing changed.")
        }
        409 if error == Some("This database access request is no longer pending") => {
            Outcome::Refused(NOT_PENDING)
        }
        409 if error == Some("Restore the archived session before answering") => {
            Outcome::Refused("Restore this archived chat before deciding. Nothing changed.")
        }
        _ => Outcome::Unknown(UNKNOWN),
    }
}

#[cfg(test)]
#[path = "database_access_tests.rs"]
pub(crate) mod tests;
