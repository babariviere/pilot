//! Fixed, pinned loopback transport. No provider URLs, credentials, retries or polling.
use crate::{LocalOptions, local_client};
use serde_json::Value;
use std::time::Duration;

pub(crate) fn url(options: &LocalOptions, provider: &str) -> reqwest::Url {
    let host = options.host();
    let mut url = reqwest::Url::parse(&format!(
        "{}/api/subscription-usage/refresh",
        options.loopback()
    ))
    .expect("fixed loopback URL");
    url.query_pairs_mut()
        .append_pair("daemonId", &host.daemon_id)
        .append_pair("lineageId", &host.lineage_id)
        .append_pair("provider", provider);
    url
}
pub(crate) fn start(
    options: LocalOptions,
) -> Result<async_channel::Receiver<Result<Vec<Value>, &'static str>>, &'static str> {
    let (tx, rx) = async_channel::bounded(1);
    std::thread::Builder::new()
        .name("subscription-refresh".into())
        .spawn(move || {
            let result = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|_| "Couldn't start limits refresh.")
                .and_then(|rt| rt.block_on(fetch(&options)));
            let _ = tx.send_blocking(result);
        })
        .map_err(|_| "Couldn't start limits refresh.")?;
    Ok(rx)
}
pub(crate) async fn fetch(options: &LocalOptions) -> Result<Vec<Value>, &'static str> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(45))
        .build()
        .map_err(|_| "Couldn't start limits refresh.")?;
    let hello = local_client::hello(&client, options).await?;
    if hello["capabilities"]["subscriptionRefresh"] != 1 {
        return Err("This daemon doesn't support limits refresh. Previous reports retained.");
    }
    let mut reports = Vec::new();
    for provider in ["anthropic", "openai"] {
        // Identity is checked before each provider request and again before publishing.
        local_client::hello(&client, options).await?;
        let result = post(&client, url(options, provider)).await;
        reports.push(result.unwrap_or_else(
            |_| serde_json::json!({"provider":provider,"account":"not_reported","state":"error"}),
        ));
    }
    local_client::hello(&client, options).await?;
    Ok(reports)
}
async fn post(client: &reqwest::Client, url: reqwest::Url) -> Result<Value, &'static str> {
    let mut response = client
        .post(url)
        .send()
        .await
        .map_err(|_| "Limits refresh response unavailable.")?;
    if response.status() != reqwest::StatusCode::OK {
        return Err("Limits refresh refused.");
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Limits refresh interrupted.")?
    {
        if bytes.len().saturating_add(chunk.len()) > 512 * 1024 {
            return Err("Limits response too large.");
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "Invalid limits response.")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mission_browser_fixture::{Reply, Server};
    use serde_json::json;
    #[tokio::test]
    async fn only_pinned_explicit_refresh_posts_no_provider_or_history_requests() {
        let s = Server::start();
        s.reply("/api/hello", Reply::json(200, json!({"daemonId":"test-daemon","lineageId":"test-lineage","protocolVersion":1,"minimumClientProtocolVersion":1,"capabilities":{"independentExecution":true,"subscriptionRefresh":1}})));
        for provider in ["anthropic", "openai"] {
            let u = url(&s.options, provider);
            s.reply(&format!("{}?{}", u.path(), u.query().unwrap()), Reply::json(200, json!({"provider":provider,"account":"not_reported","state":"refreshed","usage":{"provider":provider,"fetchedAt":1000,"windows":[]}})));
        }
        let values = fetch(&s.options).await.unwrap();
        assert_eq!(values[0]["usage"]["fetchedAt"], 1000);
        let seen = s.state.lock().unwrap().seen.clone();
        assert_eq!(seen.iter().filter(|(m, _)| m == "POST").count(), 2);
        assert!(
            seen.iter().all(
                |(_, p)| p == "/api/hello" || p.starts_with("/api/subscription-usage/refresh?")
            )
        );
        s.reply("/api/hello", Reply::json(200, json!({"daemonId":"wrong"})));
        assert!(fetch(&s.options).await.is_err());
        assert_eq!(
            s.state
                .lock()
                .unwrap()
                .seen
                .iter()
                .filter(|(m, _)| m == "POST")
                .count(),
            2
        );
    }
}
