//! One admitted POST, no retries, redirects, status-based replay or GET reconciliation.
use crate::{
    LocalOptions,
    mission_browser::Home,
    mission_update::{self as model, Outcome, Submission},
};
use serde_json::Value;
use std::time::Duration;

pub(crate) struct Reply {
    pub(crate) submission: Submission,
    pub(crate) outcome: Outcome,
}
pub(crate) fn start(
    options: LocalOptions,
    submission: Submission,
) -> Result<async_channel::Receiver<Reply>, &'static str> {
    let (tx, rx) = async_channel::bounded(1);
    std::thread::Builder::new()
        .name("local-mission-update".into())
        .spawn(move || {
            let outcome = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(rt) => rt.block_on(async {
                    match reqwest::Client::builder()
                        .no_proxy()
                        .retry(reqwest::retry::never())
                        .redirect(reqwest::redirect::Policy::none())
                        .connect_timeout(Duration::from_secs(2))
                        .timeout(Duration::from_secs(5))
                        .build()
                    {
                        Ok(client) => submit(&client, &options, &submission).await,
                        Err(_) => Outcome::NotSent(
                            "Cannot initialize Local update transport. No request sent.",
                        ),
                    }
                }),
                Err(_) => Outcome::NotSent("Cannot initialize Local worker. No request sent."),
            };
            let _ = tx.send_blocking(Reply {
                submission,
                outcome,
            });
        })
        .map_err(|_| "Cannot start update worker. No request sent.")?;
    Ok(rx)
}
pub(crate) async fn submit(
    client: &reqwest::Client,
    options: &LocalOptions,
    s: &Submission,
) -> Outcome {
    if !s.key.valid()
        || s.key.home != Home::local(&options.host())
        || model::validate(&s.text).is_err()
    {
        return Outcome::NotSent("Captured update or Local identity is invalid. No request sent.");
    }
    let catalog =
        match crate::mission_reader::fetch(client, options, &crate::mission_reader::Route::Catalog)
            .await
        {
            Ok(crate::mission_reader::Data::Catalog(c)) => c,
            _ => {
                return Outcome::NotSent("Cannot verify canonical Local missions. No update sent.");
            }
        };
    if !catalog
        .rows
        .iter()
        .any(|r| r.key == s.key && r.local_definition(&s.key.home))
    {
        return Outcome::NotSent("Captured canonical mission is unavailable. No update sent.");
    }
    // Explicit user update only. No actor/sessionId/health/handoff fields.
    // The supported HTTP route supplies USER, not an agent tool origin.
    let payload = serde_json::json!({"text":s.text,"kind":"update"});
    let response = match client
        .post(format!(
            "{}/api/missions/{}/events",
            options.loopback(),
            s.key.id
        ))
        .header("Content-Type", "application/json")
        .body(serde_json::to_vec(&payload).expect("string fields"))
        .send()
        .await
    {
        Ok(r) => r,
        Err(_) => {
            return Outcome::Unknown(
                "No update response. The update may exist. Do not resubmit; copy your text and inspect updates separately.",
            );
        }
    };
    // changed()/publication may fail after COMMIT. A 400/409/500 is not proof
    // of rejection, and a later read cannot turn that into a update ACK.
    if response.status().as_u16() != 201 {
        return Outcome::Unknown(
            "Update returned no confirmed success. It may have committed. No retry is available; your text is retained.",
        );
    }
    match body(response).await.and_then(|v| model::acknowledge(s, &v)) {
        Ok(created) => Outcome::Acknowledged(created),
        Err(_) => Outcome::Unknown(
            "Update response could not be validated. The update may exist; do not resubmit.",
        ),
    }
}
async fn body(mut response: reqwest::Response) -> Result<Value, &'static str> {
    if response
        .content_length()
        .is_some_and(|n| n > model::WIRE_BYTES as u64)
    {
        return Err("Oversized update response.");
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Interrupted update response.")?
    {
        if bytes.len().saturating_add(chunk.len()) > model::WIRE_BYTES {
            return Err("Oversized update response.");
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "Malformed update response.")
}

#[cfg(test)]
#[path = "mission_update_transport_tests.rs"]
mod tests;
