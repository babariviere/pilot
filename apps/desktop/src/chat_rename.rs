//! One-shot exact Local title writes. Reads are preflight, never receipts.
use crate::{
    LocalOptions,
    chat_actions::{Evidence, Outcome},
    chat_actions_worker,
};
use serde_json::Value;

pub(crate) const LIMIT: usize = 200;
pub(crate) fn bounded(value: &str) -> bool {
    value.len() <= LIMIT * 4 && value.encode_utf16().count() <= LIMIT
}
pub(crate) fn normalized(value: &str) -> Option<String> {
    if !bounded(value) {
        return None;
    }
    let title = value
        .split(|c: char| crate::mission_conversion::trim_text(&c.to_string()).is_empty())
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    (!title.is_empty()).then_some(title)
}
pub(crate) async fn rename(options: &LocalOptions, evidence: &Evidence, title: &str) -> Outcome {
    let Some(title) = normalized(title) else {
        return Outcome::Rejected("Use a nonempty title of at most 200 UTF-16 units.");
    };
    if evidence.stamp["control"] == true {
        return Outcome::Rejected("Retained history is read-only.");
    }
    let client = match chat_actions_worker::client() {
        Ok(c) => c,
        Err(e) => return Outcome::Rejected(e),
    };
    // The immutable clicked target is checked again before dispatch. No selected-chat lookup.
    match chat_actions_worker::inspect(&client, options, &evidence.target).await {
        Ok(current) if current.target == evidence.target && current.stamp["control"] != true => {}
        _ => {
            return Outcome::Rejected(
                "The original chat changed or Local is unavailable. Reopen Rename. Nothing was submitted.",
            );
        }
    }
    let response = client
        .post(format!(
            "{}/api/sessions/{}/title",
            options.loopback(),
            evidence.target.chat.id
        ))
        .header("Content-Type", "application/json")
        .body(serde_json::json!({"title": title}).to_string())
        .send()
        .await;
    let Ok(mut response) = response else {
        return Outcome::Unknown;
    };
    // rename mutates memory and may rename a mission coordinator before save/emit.
    // Any HTTP error can follow a side effect. No status error is safe to replay.
    if response.status() != reqwest::StatusCode::OK {
        return Outcome::Unknown;
    }
    let mut bytes = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) if bytes.len() + chunk.len() <= 256 * 1024 => {
                bytes.extend_from_slice(&chunk)
            }
            Ok(None) => break,
            _ => return Outcome::Unknown,
        }
    }
    let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
        return Outcome::Unknown;
    };
    if value["id"] != evidence.target.chat.id || value["title"] != title {
        return Outcome::Unknown;
    }
    // The actual endpoint returns SessionSummary. Do not treat a generic 200 as an ACK.
    if !value["cwd"].is_string()
        || !value["state"].is_string()
        || crate::local_model::chat(&value).is_none()
    {
        return Outcome::Unknown;
    }
    Outcome::Acknowledged
}
#[cfg(test)]
#[path = "chat_rename_tests.rs"]
mod tests;
