//! Local global enabledModels only. No project/default/credential/chat writes.
use crate::{LocalOptions, delivery_store::Failure};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Candidate {
    pub(crate) id: String,
    pub(crate) provider: String,
    pub(crate) name: String,
    #[serde(skip)]
    pub(crate) search_key: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub(crate) struct Resolution {
    pub(crate) pattern: String,
    pub(crate) matches: Vec<String>,
    pub(crate) unresolved: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot {
    pub(crate) enabled_models: Option<Vec<String>>,
    pub(crate) scope_hash: String,
    pub(crate) all_models: bool,
    pub(crate) candidates: Vec<Candidate>,
    pub(crate) resolution: Vec<Resolution>,
}
pub(crate) fn hash(value: &Option<Vec<String>>) -> String {
    let bytes = match value {
        None => serde_json::to_vec("absent"),
        Some(value) => serde_json::to_vec(value),
    }
    .unwrap();
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()
}
pub(crate) fn valid_selection(value: &Option<Vec<String>>) -> Result<(), Failure> {
    if let Some(patterns) = value
        && (patterns.is_empty()
            || patterns.len() > 256
            || patterns.iter().any(|p| {
                crate::mission_conversion::trim_text(p).is_empty()
                    || p.len() > 256
                    || p.chars().any(|c| c < ' ' || c == '\u{7f}')
            }))
    {
        return Err(
            "Choose All, or 1–256 nonempty literal patterns of at most 256 UTF-8 bytes each, without control characters.",
        );
    }
    Ok(())
}
impl Snapshot {
    pub(crate) fn validate(&self) -> Result<(), Failure> {
        let text = |s: &str, cap: usize| s.len() <= cap && !s.contains('\0');
        if self.scope_hash != hash(&self.enabled_models)
            || self.all_models != self.enabled_models.as_ref().is_none_or(Vec::is_empty)
            || self.enabled_models.as_ref().is_some_and(|p| {
                p.len() > 256
                    || p.iter()
                        .any(|s| !text(s, 256) || s.chars().any(|c| c < ' ' || c == '\u{7f}'))
            })
            || self.candidates.len() > 2048
            || self.resolution.len() > 256
            || self.candidates.iter().any(|c| {
                c.id.is_empty()
                    || !text(&c.id, 1024)
                    || !text(&c.provider, 256)
                    || !text(&c.name, 1024)
            })
            || self.resolution.iter().any(|r| {
                !text(&r.pattern, 256)
                    || r.matches.len() > 2048
                    || r.matches.iter().any(|s| !text(s, 1024))
                    || r.unresolved.as_ref().is_some_and(|s| {
                        !matches!(s.as_str(), "unknown" | "provider-not-logged-in")
                    })
            })
        {
            return Err(
                "Local model scope is malformed, unsupported or exceeds the bounded editor limit. Existing settings are unchanged.",
            );
        }
        let mut ids = std::collections::HashSet::new();
        if self.candidates.iter().any(|c| !ids.insert(&c.id)) {
            return Err(
                "Local model catalog has duplicate identities. Existing settings are unchanged.",
            );
        }
        Ok(())
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Save {
    pub(crate) enabled_models: Option<Vec<String>>,
    pub(crate) expected_hash: String,
}
#[derive(Clone)]
pub(crate) struct Reply {
    pub(crate) observation: Result<Snapshot, Failure>,
    pub(crate) problem: Option<Failure>,
    pub(crate) attempted: bool,
}

async fn body(mut response: reqwest::Response) -> Result<serde_json::Value, Failure> {
    const CAP: usize = 2 * 1024 * 1024;
    if response.content_length().is_some_and(|n| n > CAP as u64) {
        return Err("Model-scope response exceeds the bounded reader limit.");
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Local model-scope response interrupted.")?
    {
        if bytes.len() + chunk.len() > CAP {
            return Err("Model-scope response exceeds the bounded reader limit.");
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "Local model-scope response is malformed.")
}
pub(crate) async fn read(
    client: &reqwest::Client,
    options: &LocalOptions,
) -> Result<Snapshot, Failure> {
    crate::local_client::gate(client, options).await?;
    let r = client
        .get(format!("{}/api/model-scope", options.loopback()))
        .send()
        .await
        .map_err(|_| "Couldn't load scoped models. Check again to retry.")?;
    if r.status() != reqwest::StatusCode::OK {
        return Err(status(r.status().as_u16()));
    }
    let value = body(r).await?;
    // The field is required even for null. Missing must not masquerade as All.
    if value.get("enabledModels").is_none() {
        return Err("Local model scope omitted its global baseline.");
    }
    let mut scope: Snapshot =
        serde_json::from_value(value).map_err(|_| "Local model scope is malformed.")?;
    scope.validate()?;
    for candidate in &mut scope.candidates {
        candidate.search_key =
            format!("{} {} {}", candidate.provider, candidate.id, candidate.name).to_lowercase();
    }
    Ok(scope)
}
fn status(code: u16) -> Failure {
    match code {
        404 | 405 | 501 => "This Local daemon does not support scoped-model settings.",
        403 => {
            "Scoped-model changes are read-only or require native authorization. No fallback is used."
        }
        409 => "Changed elsewhere. Your selection is kept; check again and review before saving.",
        400 => "Local rejected the literal model selection. Review it before saving again.",
        422 | 503 => {
            "Couldn't read or save scoped models. Check again; the last save may not have applied."
        }
        _ => "Couldn't save scoped models. Check again before saving.",
    }
}
pub(crate) async fn save(client: &reqwest::Client, options: &LocalOptions, request: Save) -> Reply {
    let pre = async {
        valid_selection(&request.enabled_models)?;
        if request.expected_hash.len() != 64
            || !request.expected_hash.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err("A verified Local baseline is required before Save.");
        }
        crate::local_client::gate(client, options).await?;
        // Acquired freshly for this explicit settings action, never on read.
        let capability = options.model_scope_capability()?;
        let mut header = reqwest::header::HeaderValue::from_str(&capability)
            .map_err(|_| "Native authorization is unavailable.")?;
        header.set_sensitive(true);
        let bytes =
            serde_json::to_vec(&request).map_err(|_| "Cannot encode scoped-model selection.")?;
        if bytes.len() > 160 * 1024 {
            return Err("Scoped-model selection exceeds the request limit.");
        }
        Ok((header, bytes))
    }
    .await;
    let (header, bytes) = match pre {
        Ok(v) => v,
        Err(problem) => {
            return Reply {
                observation: Err(problem),
                problem: Some(problem),
                attempted: false,
            };
        }
    };
    let response = client
        .put(format!("{}/api/model-scope", options.loopback()))
        .header("x-pilot-github-capability", header)
        .header("Content-Type", "application/json")
        .body(bytes)
        .send()
        .await;
    let problem = match response {
        Err(_) => Some("Couldn't confirm the save. Check again to see the current value."),
        Ok(response) if response.status() != reqwest::StatusCode::OK => {
            Some(status(response.status().as_u16()))
        }
        Ok(response) => match body(response).await {
            Ok(v) if v["changed"].is_boolean() && v["scopeHash"].as_str().is_some() => None,
            _ => Some("Couldn't confirm the save. Check again before saving."),
        },
    };
    // Both changed:true and changed:false require literal GET readback. Even
    // readback equality describes current settings, not stronger disk durability.
    Reply {
        observation: read(client, options).await,
        problem,
        attempted: true,
    }
}

#[cfg(test)]
#[path = "scoped_models_tests.rs"]
mod tests;
