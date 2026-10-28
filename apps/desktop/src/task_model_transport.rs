//! One passive POST, never PATCH fallback, retry, redirect or GET settlement.
use crate::{
    LocalOptions,
    mission_browser::Home,
    task_edit::Target,
    task_model::{self as model, Loaded, Outcome, Save, Source},
};
use serde_json::{Value, json};
use std::time::Duration;
fn client() -> Result<reqwest::Client, &'static str> {
    reqwest::Client::builder()
        .no_proxy()
        .retry(reqwest::retry::never())
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(2))
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|_| "Cannot initialize preference transport.")
}
fn spawn<T: Send + 'static>(
    name: &str,
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<async_channel::Receiver<T>, &'static str> {
    let (tx, rx) = async_channel::bounded(1);
    std::thread::Builder::new()
        .name(name.into())
        .spawn(move || {
            let result = work();
            let _ = tx.send_blocking(result);
        })
        .map_err(|_| "Cannot start preference worker. No save sent.")?;
    Ok(rx)
}
pub(crate) fn read(
    o: LocalOptions,
    t: Target,
) -> Result<async_channel::Receiver<Result<Loaded, &'static str>>, &'static str> {
    spawn("task-model-read", move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|_| "Cannot initialize preference reader.")?;
        rt.block_on(async { load(&client()?, &o, &t, None).await })
    })
}
pub(crate) fn start(
    o: LocalOptions,
    s: Save,
) -> Result<async_channel::Receiver<Outcome>, &'static str> {
    spawn("task-model-save", move || {
        let Ok(rt) = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        else {
            return Outcome::NotSent("Cannot initialize preference runtime. No save sent.");
        };
        rt.block_on(async {
            match client() {
                Ok(c) => write(&c, &o, &s).await,
                Err(e) => Outcome::NotSent(e),
            }
        })
    })
}
async fn get(c: &reqwest::Client, o: &LocalOptions, path: &str) -> Result<Value, &'static str> {
    body(send(c, o, path).await?).await
}
async fn send(
    c: &reqwest::Client,
    o: &LocalOptions,
    path: &str,
) -> Result<reqwest::Response, &'static str> {
    let r = c
        .get(format!("{}{path}", o.loopback()))
        .send()
        .await
        .map_err(|_| "Preference source read failed.")?;
    if r.status().as_u16() != 200 {
        return Err("Preference source unavailable. No save sent.");
    }
    Ok(r)
}
pub(crate) async fn load(
    c: &reqwest::Client,
    o: &LocalOptions,
    t: &Target,
    expected: Option<&Source>,
) -> Result<Loaded, &'static str> {
    if !t.valid() || t.key.home != Home::local(&o.host()) {
        return Err("Invalid canonical Local task source.");
    }
    crate::local_client::gate(c, o).await?;
    // Capability is checked again on save. Older daemons never receive a legacy PATCH.
    let hello = get(c, o, "/api/hello").await?;
    if hello["daemonId"] != t.key.home.daemon
        || hello["lineageId"] != t.key.home.lineage
        || hello["capabilities"]["passiveTaskModel"] != true
    {
        return Err("This Local daemon does not support safe task preferences.");
    }
    let crate::mission_reader::Data::Catalog(catalog) =
        crate::mission_reader::fetch(c, o, &crate::mission_reader::Route::Catalog).await?
    else {
        return Err("Canonical mission catalog unavailable.");
    };
    let v = crate::mission_tasks_reader::detail_body(
        send(c, o, &format!("/api/missions/{}", t.key.id)).await?,
    )
    .await?;
    let project = v["mission"]["projectId"]
        .as_str()
        .filter(|id| crate::local_model::valid_id(id))
        .ok_or("Missing canonical task project.")?;
    let source = Source {
        target: t.clone(),
        project: project.into(),
    };
    if v["mission"]["id"] != t.key.id
        || expected.is_some_and(|s| s != &source)
        || !catalog.rows.iter().any(|r| {
            r.key == t.key
                && r.local_definition(&t.key.home)
                && r.sources
                    .iter()
                    .any(|s| s.canonical && s.home == t.key.home && s.project == project)
        })
    {
        return Err("Canonical mission/project changed. No save sent.");
    }
    let tasks = v["tasks"].as_array().ok_or("Task snapshot unavailable.")?;
    let mut matches = tasks.iter().filter(|v| v["id"] == t.task);
    let task = matches.next().ok_or("Exact task unavailable.")?;
    if matches.next().is_some() {
        return Err("Duplicate task identity.");
    }
    let value = model::parse(t, task)?;
    let title = task["title"]
        .as_str()
        .filter(|s| s.len() <= 800)
        .ok_or("Invalid task title.")?
        .into();
    let r = c
        .get(format!("{}/api/models", o.loopback()))
        .query(&[("projectId", project), ("purpose", "task-start")])
        .send()
        .await
        .map_err(|_| "Task model catalog unavailable.")?;
    if r.status().as_u16() != 200 {
        return Err("Task model scope unavailable. No unscoped fallback.");
    }
    let catalog: crate::chat_models::Catalog =
        serde_json::from_value(body(r).await?).map_err(|_| "Malformed task model catalog.")?;
    catalog.validate()?;
    Ok(Loaded {
        source,
        title,
        value,
        catalog,
    })
}
pub(crate) async fn write(c: &reqwest::Client, o: &LocalOptions, s: &Save) -> Outcome {
    if !s.source.valid() || !s.value.valid() || uuid::Uuid::parse_str(&s.id).is_err() {
        return Outcome::NotSent("Invalid captured preference. No save sent.");
    }
    let current = match load(c, o, &s.source.target, Some(&s.source)).await {
        Ok(v) => v,
        Err(e) => return Outcome::NotSent(e),
    };
    if !s.value.admitted(&current.catalog) {
        return Outcome::NotSent(
            "Choice is no longer supported in this project's task scope. No save sent.",
        );
    }
    let payload = json!({"operationId":s.id,"home":{"daemonId":s.source.target.key.home.daemon,"lineageId":s.source.target.key.home.lineage},"projectId":s.source.project,"preferredModel":s.value.model,"preferredThinking":s.value.thinking});
    let r = match c
        .post(format!(
            "{}/api/missions/{}/tasks/{}/model",
            o.loopback(),
            s.source.target.key.id,
            s.source.target.task
        ))
        .header("Content-Type", "application/json")
        .body(serde_json::to_vec(&payload).expect("captured string preference"))
        .send()
        .await
    {
        Ok(r) => r,
        Err(_) => {
            return Outcome::Unknown("No save response. It may have committed. Do not replay.");
        }
    };
    if r.status().as_u16() != 200 {
        return Outcome::Unknown(
            "Save returned no confirmed success. It may have committed. No retry is available.",
        );
    }
    match body(r).await {
        Ok(v) if model::ack(s, &v) => Outcome::Saved,
        _ => Outcome::Unknown(
            "Save response did not match this captured preference and exact source. Do not replay.",
        ),
    }
}
async fn body(mut r: reqwest::Response) -> Result<Value, &'static str> {
    if r.content_length()
        .is_some_and(|n| n > model::WIRE_BYTES as u64)
    {
        return Err("Preference response exceeds wire limit.");
    }
    let mut bytes = Vec::new();
    while let Some(b) = r
        .chunk()
        .await
        .map_err(|_| "Interrupted preference response.")?
    {
        if bytes.len().saturating_add(b.len()) > model::WIRE_BYTES {
            return Err("Preference response exceeds wire limit.");
        }
        bytes.extend_from_slice(&b);
    }
    serde_json::from_slice(&bytes).map_err(|_| "Malformed preference response.")
}
#[cfg(test)]
#[path = "task_model_transport_tests.rs"]
mod tests;
