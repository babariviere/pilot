//! One admitted PATCH, no retries, redirects, status-based replay or GET reconciliation.
use crate::{
    LocalOptions,
    mission_browser::Home,
    task_status::{self as model, Outcome, Submission},
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
        .name("local-task-status".into())
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
                            "Cannot initialize Local task transport. No request sent.",
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
        .map_err(|_| "Cannot start task worker. No request sent.")?;
    Ok(rx)
}
pub(crate) async fn submit(
    client: &reqwest::Client,
    options: &LocalOptions,
    s: &Submission,
) -> Outcome {
    if !model::valid(&s.target, &s.chosen) || s.target.key.home != Home::local(&options.host()) {
        return Outcome::NotSent("Invalid captured task or Local identity. No change sent.");
    }
    let catalog =
        match crate::mission_reader::fetch(client, options, &crate::mission_reader::Route::Catalog)
            .await
        {
            Ok(crate::mission_reader::Data::Catalog(c)) => c,
            _ => {
                return Outcome::NotSent("Cannot verify canonical Local missions. No change sent.");
            }
        };
    if !catalog
        .rows
        .iter()
        .any(|r| r.key == s.target.key && r.local_definition(&s.target.key.home))
    {
        return Outcome::NotSent("Canonical mission unavailable. No change sent.");
    }
    let route = format!("{}/api/missions/{}", options.loopback(), s.target.key.id);
    let detail = match client.get(&route).send().await {
        Ok(r) if r.status().as_u16() == 200 => body(r, crate::mission_tasks::WIRE_BYTES).await,
        _ => Err("Cannot verify current task. No change sent."),
    };
    let detail = match detail {
        Ok(v) => v,
        Err(e) => return Outcome::NotSent(e),
    };
    if detail["mission"]["id"] != s.target.key.id
        || !["active", "done", "archived"]
            .contains(&detail["mission"]["status"].as_str().unwrap_or(""))
    {
        return Outcome::NotSent("Mission identity or lifecycle is unsupported. No change sent.");
    }
    let Some(tasks) = detail["tasks"]
        .as_array()
        .filter(|a| a.len() <= crate::mission_tasks::ROW_LIMIT)
    else {
        return Outcome::NotSent("Task snapshot exceeds supported limits. No change sent.");
    };
    let mut matches = tasks.iter().filter(|t| t["id"] == s.target.task);
    let Some(task) = matches.next() else {
        return Outcome::NotSent("Exact task unavailable. No change sent.");
    };
    if matches.next().is_some()
        || task["number"].as_u64() != Some(s.target.number)
        || task["title"] != s.target.title
        || task["storedStatus"]
            .as_str()
            .unwrap_or_else(|| task["status"].as_str().unwrap_or(""))
            != s.target.current
    {
        return Outcome::NotSent(
            "Task changed since confirmation opened. Choice retained; close and refresh tasks to inspect it. No change sent.",
        );
    }
    // Preflight is NOT compare-and-swap. Another writer may still race.
    let response = match client
        .patch(format!("{route}/tasks/{}", s.target.task))
        .header("Content-Type", "application/json")
        .body(serde_json::to_vec(&serde_json::json!({"status":s.chosen})).expect("status string"))
        .send()
        .await
    {
        Ok(r) => r,
        Err(_) => {
            return Outcome::Unknown(
                "No response. The change may have committed. Do not resubmit.",
            );
        }
    };
    if response.status().as_u16() != 200 {
        return Outcome::Unknown(
            "No confirmed success. Errors can follow commit. No retry is available.",
        );
    }
    match body(response, 64 * 1024).await {
        Ok(v) if model::acknowledge(s, &v) => Outcome::Acknowledged,
        _ => Outcome::Unknown(
            "Invalid or interrupted acknowledgment. The change may have committed. Do not resubmit.",
        ),
    }
}
async fn body(mut response: reqwest::Response, cap: usize) -> Result<Value, &'static str> {
    if response.content_length().is_some_and(|n| n > cap as u64) {
        return Err("Response exceeds byte limit. No valid receipt.");
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Interrupted response.")?
    {
        if bytes.len().saturating_add(chunk.len()) > cap {
            return Err("Response exceeds byte limit. No valid receipt.");
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "Malformed response.")
}
