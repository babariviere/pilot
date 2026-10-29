//! The one PATCH behind a project Save. A read first confirms the daemon identity and that the
//! project still holds the form's baseline; after the PATCH is sent nothing is retried.
use crate::{
    LocalOptions,
    local_model::{Project, valid_id},
    project_settings::{Fields, Outcome, Submission},
};
use serde_json::Value;
use std::time::Duration;

const RESPONSE_BYTES: usize = 256 * 1024;

pub(crate) fn start(
    options: LocalOptions,
    submission: Submission,
) -> Result<async_channel::Receiver<(Submission, Outcome)>, &'static str> {
    let (tx, rx) = async_channel::bounded(1);
    std::thread::Builder::new()
        .name("local-project-settings".into())
        .spawn(move || {
            let outcome = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(rt) => rt.block_on(async {
                    match client() {
                        Ok(client) => submit(&client, &options, &submission).await,
                        Err(reason) => Outcome::NotSent(reason),
                    }
                }),
                Err(_) => Outcome::NotSent("Couldn't start the save. Nothing was changed."),
            };
            let _ = tx.send_blocking((submission, outcome));
        })
        .map_err(|_| "Couldn't start the save. Nothing was changed.")?;
    Ok(rx)
}

pub(crate) fn client() -> Result<reqwest::Client, &'static str> {
    reqwest::Client::builder()
        .no_proxy()
        .retry(reqwest::retry::never())
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(2))
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|_| "Couldn't start the save. Nothing was changed.")
}

pub(crate) async fn submit(
    client: &reqwest::Client,
    options: &LocalOptions,
    s: &Submission,
) -> Outcome {
    if !valid_id(&s.project_id) || s.patch().as_object().is_none_or(|b| b.is_empty()) {
        return Outcome::NotSent("Nothing to save.");
    }
    if crate::local_client::gate(client, options).await.is_err() {
        return Outcome::NotSent("Couldn't reach Pilot. Nothing was changed.");
    }
    let url = format!("{}/api/projects/{}", options.loopback(), s.project_id);
    let current = match client.get(&url).send().await {
        Ok(r) if r.status() == reqwest::StatusCode::NOT_FOUND => {
            return Outcome::NotSent("This project was removed. Nothing was changed.");
        }
        Ok(r) if r.status() == reqwest::StatusCode::OK => match project(r).await {
            Some(p) if p.id == s.project_id => p,
            _ => return Outcome::NotSent("Couldn't read this project. Nothing was changed."),
        },
        _ => return Outcome::NotSent("Couldn't read this project. Nothing was changed."),
    };
    if !s.current(&Fields::of(&current)) {
        return Outcome::NotSent(
            "This project changed elsewhere. Revert to see the new values. Nothing was changed.",
        );
    }
    let response = client
        .patch(&url)
        .header("Content-Type", "application/json")
        .body(s.patch().to_string())
        .send()
        .await;
    // The daemon may change the project before failing to persist it, so no error proves
    // the save didn't happen.
    let Ok(response) = response else {
        return Outcome::Unknown(
            "No reply from Pilot. The save may have applied; it won't be resent.",
        );
    };
    if response.status() != reqwest::StatusCode::OK {
        return Outcome::Unknown(
            "Pilot reported an error. The save may have applied; it won't be resent.",
        );
    }
    match project(response).await {
        Some(saved) => Outcome::Saved(saved),
        None => Outcome::Unknown(
            "Pilot's reply was unreadable. The save may have applied; it won't be resent.",
        ),
    }
}

async fn project(mut response: reqwest::Response) -> Option<Project> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.ok()? {
        if bytes.len() + chunk.len() > RESPONSE_BYTES {
            return None;
        }
        bytes.extend_from_slice(&chunk);
    }
    let value: Value = serde_json::from_slice(&bytes).ok()?;
    crate::local_model::projects(&Value::Array(vec![value]))
        .ok()?
        .pop()
}

#[cfg(test)]
#[path = "project_settings_transport_tests.rs"]
mod tests;
