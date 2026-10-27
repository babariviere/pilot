//! One-shot Local registration. Unknown attempts are retained, never replayed.
use crate::{
    LocalOptions,
    delivery_store::{Failure, Store, token},
    local_model::Project,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Attempt {
    pub(crate) id: String,
    pub(crate) path: String,
    pub(crate) created: Option<String>,
}
pub(crate) fn validate_path(path: &str) -> Result<(), Failure> {
    if !path.starts_with('/') || path.len() > 4096 || path.contains('\0') {
        return Err("Choose one existing Local folder with a supported path (up to 4096 bytes).");
    }
    Ok(())
}
impl Attempt {
    pub(crate) fn validate(&self, id: &str) -> Result<(), Failure> {
        validate_path(&self.path)?;
        if self.id != id || !token(id) || self.created.as_deref().is_some_and(|id| !token(id)) {
            return Err("Invalid retained project registration; original state preserved.");
        }
        Ok(())
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Outcome {
    Pending,
    Created(String),
    Unknown(Failure),
    Read,
}
#[derive(Clone)]
pub(crate) struct Reply {
    pub(crate) id: String,
    pub(crate) result: Result<Outcome, Failure>,
    pub(crate) catalog: Option<Result<Vec<Project>, Failure>>,
}

async fn body(mut response: reqwest::Response, cap: usize) -> Result<Value, Failure> {
    if response.content_length().is_some_and(|n| n > cap as u64) {
        return Err("Project response exceeds the bounded reader limit.");
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Project response interrupted.")?
    {
        if bytes.len() + chunk.len() > cap {
            return Err("Project response exceeds the bounded reader limit.");
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "Malformed project response.")
}
pub(crate) async fn catalog(
    client: &reqwest::Client,
    options: &LocalOptions,
) -> Result<Vec<Project>, Failure> {
    crate::local_client::gate(client, options).await?;
    let response = client
        .get(format!("{}/api/projects", options.loopback()))
        .send()
        .await
        .map_err(|_| "Couldn't load projects. Refresh to try again.")?;
    if response.status() != reqwest::StatusCode::OK {
        return Err("Local project list refused; no redirect or authentication fallback.");
    }
    crate::local_model::projects(&body(response, 2 * 1024 * 1024).await?)
}
pub(crate) async fn register(
    client: &reqwest::Client,
    options: &LocalOptions,
    store: &mut Store,
    id: &str,
    path: &str,
    prepared: impl FnOnce(&Store),
) -> Result<Outcome, Failure> {
    if store.book.host != options.host() {
        return Err("Local registration source differs from private state; no request was sent.");
    }
    validate_path(path)?;
    // Preflight is read-only. Even a duplicate is current catalog evidence,
    // never a receipt proving that a previous Unknown request succeeded.
    let projects = catalog(client, options).await?;
    if projects.iter().any(|p| p.path == path) {
        return Err("This folder is already a project. Refresh projects to see it.");
    }
    let payload = serde_json::to_vec(&serde_json::json!({"path":path}))
        .map_err(|_| "Cannot encode project registration.")?;
    if payload.len() > 32 * 1024 {
        return Err("Encoded project path is too large.");
    }
    store.prepare_project(id, path)?;
    prepared(store);
    let response = client
        .post(format!("{}/api/projects", options.loopback()))
        .header("Content-Type", "application/json")
        .body(payload)
        .send()
        .await;
    let Ok(response) = response else {
        return Ok(Outcome::Unknown(
            "Registration is unconfirmed. The response was lost; do not resend this folder.",
        ));
    };
    // ProjectStore pushes in memory before persist. Even non-2xx may follow
    // mutation; no status/body string proves that retry is safe.
    if response.status() != reqwest::StatusCode::CREATED {
        return Ok(Outcome::Unknown(match response.status().as_u16() {
            401 | 403 => {
                "Local refused access. Registration is unconfirmed; check projects, not a mutation retry."
            }
            404 | 405 | 501 => {
                "Registration is unavailable on this Local daemon. The attempted outcome is unconfirmed."
            }
            400 | 409 | 422 => {
                "Local reported validation or duplicate registration. Outcome is unconfirmed; check projects before any other action."
            }
            _ => {
                "Local reported an error. Registration may have changed before that error; do not resend this folder."
            }
        }));
    }
    let value = match body(response, 64 * 1024).await {
        Ok(value) => value,
        Err(_) => {
            return Ok(Outcome::Unknown(
                "Registration response is incomplete, oversized or malformed. Do not resend this folder.",
            ));
        }
    };
    let rows = crate::local_model::projects(&serde_json::json!([value]));
    let Ok(rows) = rows else {
        return Ok(Outcome::Unknown(
            "Registration receipt identity/path is invalid. Do not resend this folder.",
        ));
    };
    let id_created = rows[0].id.clone();
    // No local settlement failure, including pre-I/O capacity refusal, can
    // undo the known 201. Keep its ID in the worker's memory receipt while
    // the original durable Unknown continues fencing replay. The UI compares
    // that receipt with the private record, never claims it survived restart.
    let _ = store.finish_project(id, &id_created);
    Ok(Outcome::Created(id_created))
}

#[cfg(test)]
#[path = "project_registration_tests.rs"]
mod tests;
