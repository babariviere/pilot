//! Reads behind the Slack settings: the project's tracking value, its Slack source status and
//! the channel lookup. All are GETs; nothing here writes, polls a source or signs in.
use crate::{
    LocalOptions,
    local_model::valid_id,
    project_slack::{Lookup, Source},
};
use serde_json::Value;
use std::time::Duration;

const BODY_BYTES: usize = 512 * 1024;

/// One project's tracking value (Null when it has none) and its Slack source, if pilotd reported one.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Read {
    pub(crate) tracking: Result<Value, &'static str>,
    pub(crate) source: Option<Source>,
}

/// Runs one read off the UI thread and hands back its result once.
pub(crate) fn spawn<T, F>(
    timeout: Duration,
    read: impl FnOnce(reqwest::Client) -> F + Send + 'static,
) -> Option<async_channel::Receiver<T>>
where
    T: Send + 'static,
    F: std::future::Future<Output = T>,
{
    let (tx, rx) = async_channel::bounded(1);
    std::thread::Builder::new()
        .name("local-project-slack".into())
        .spawn(move || {
            let Ok(rt) = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            else {
                return;
            };
            let Ok(client) = reqwest::Client::builder()
                .no_proxy()
                .retry(reqwest::retry::never())
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(2))
                .timeout(timeout)
                .build()
            else {
                return;
            };
            let _ = tx.send_blocking(rt.block_on(read(client)));
        })
        .ok()?;
    Some(rx)
}

async fn body(mut response: reqwest::Response) -> Option<Value> {
    if response.status() != reqwest::StatusCode::OK {
        return None;
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.ok()? {
        if bytes.len() + chunk.len() > BODY_BYTES {
            return None;
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).ok()
}

pub(crate) async fn read(
    client: &reqwest::Client,
    options: &LocalOptions,
    project_id: &str,
) -> Read {
    let failed = |reason| Read {
        tracking: Err(reason),
        source: None,
    };
    if !valid_id(project_id) {
        return failed("Couldn't load the Slack settings.");
    }
    if crate::local_client::gate(client, options).await.is_err() {
        return failed("Couldn't reach Pilot.");
    }
    let url = format!("{}/api/projects/{project_id}", options.loopback());
    let tracking = match client.get(&url).send().await {
        Ok(r) if r.status() == reqwest::StatusCode::OK => {
            match crate::project_settings_transport::project(r).await {
                Some((p, tracking)) if p.id == project_id => Ok(tracking),
                _ => Err("Couldn't load the Slack settings."),
            }
        }
        Ok(r) if r.status() == reqwest::StatusCode::NOT_FOUND => Err("This project was removed."),
        _ => Err("Couldn't load the Slack settings."),
    };
    // Status is optional: settings stay editable without it.
    let source = match client
        .get(format!("{}/api/sources", options.loopback()))
        .query(&[("projectId", project_id)])
        .send()
        .await
    {
        Ok(r) => body(r).await.and_then(|v| Source::read(&v, project_id)),
        Err(_) => None,
    };
    Read { tracking, source }
}

/// Channels matching the query, from pilotd's read-only Slack lookup.
pub(crate) async fn channels(
    client: &reqwest::Client,
    options: &LocalOptions,
    query: &str,
) -> Lookup {
    if crate::local_client::gate(client, options).await.is_err() {
        return Lookup::Failed("Couldn't reach Pilot.".into());
    }
    let query: String = query.trim().chars().take(100).collect();
    match client
        .get(format!(
            "{}/api/tracking/slack/channels",
            options.loopback()
        ))
        .query(&[("query", query.as_str())])
        .send()
        .await
    {
        Ok(r) => match body(r).await {
            Some(v) => Lookup::read(&v),
            None => Lookup::Failed("Couldn't search Slack channels.".into()),
        },
        Err(_) => Lookup::Failed("Couldn't search Slack channels.".into()),
    }
}
