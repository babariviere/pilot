//! Single POST, no redirects/retries or GET-based settlement. Old daemons fail closed.
use crate::{
    LocalOptions,
    mission_brief::Source,
    mission_browser::Home,
    mission_lifecycle::{self as model, Outcome, Send as Submission, Snapshot},
};
use serde_json::Value;
use std::time::Duration;
const CAP: usize = 2 * 1024 * 1024;
fn client() -> Result<reqwest::Client, &'static str> {
    reqwest::Client::builder()
        .no_proxy()
        .retry(reqwest::retry::never())
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(2))
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|_| "Cannot initialize lifecycle transport. Nothing sent.")
}
fn spawn<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<async_channel::Receiver<T>, &'static str> {
    let (tx, rx) = async_channel::bounded(1);
    std::thread::Builder::new()
        .name("mission-lifecycle".into())
        .spawn(move || {
            let _ = tx.send_blocking(work());
        })
        .map_err(|_| "Cannot start lifecycle worker. Nothing sent.")?;
    Ok(rx)
}
fn runtime() -> Result<tokio::runtime::Runtime, &'static str> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|_| "Cannot start lifecycle runtime. Nothing sent.")
}
pub(crate) fn read(
    o: LocalOptions,
    s: Source,
    action: model::Action,
) -> Result<async_channel::Receiver<Result<Snapshot, &'static str>>, &'static str> {
    spawn(move || {
        runtime()?.block_on(async {
            let c = client()?;
            qualify(&c, &o, &s, action).await?;
            fetch(&c, &o, &s).await
        })
    })
}
pub(crate) fn start(
    o: LocalOptions,
    s: Submission,
) -> Result<async_channel::Receiver<Outcome>, &'static str> {
    spawn(move || {
        let rt = match runtime() {
            Ok(r) => r,
            Err(e) => return Outcome::NotSent(e),
        };
        rt.block_on(async {
            match client() {
                Ok(c) => write(&c, &o, &s).await,
                Err(e) => Outcome::NotSent(e),
            }
        })
    })
}
async fn qualify(
    c: &reqwest::Client,
    o: &LocalOptions,
    s: &Source,
    action: model::Action,
) -> Result<(), &'static str> {
    if !s.valid() || s.key.home != Home::local(&o.host()) {
        return Err("Captured Local home is unavailable. Nothing sent.");
    }
    let crate::mission_reader::Data::Catalog(catalog) =
        crate::mission_reader::fetch(c, o, &crate::mission_reader::Route::Catalog).await?
    else {
        return Err("Cannot verify canonical mission.");
    };
    if !s.canonical(&catalog) {
        return Err("Canonical mission/project is unavailable. Nothing sent.");
    }
    let r = c
        .get(format!("{}/api/hello", o.loopback()))
        .send()
        .await
        .map_err(|_| "Local safety capability unavailable.")?;
    if r.status().as_u16() != 200 {
        return Err("Local safety capability unavailable.");
    }
    let v = body(r).await?;
    if v["daemonId"].as_str() != Some(&s.key.home.daemon)
        || v["lineageId"].as_str() != Some(&s.key.home.lineage)
        || v["capabilities"]["passiveMissionLifecycle"] != true
    {
        return Err(
            "This Local daemon cannot safely archive/reopen without chat side effects. Nothing sent.",
        );
    }
    if action == model::Action::Complete && v["capabilities"]["passiveMissionCompletion"] != true {
        return Err("This Local daemon cannot safely mark missions done. Nothing sent.");
    }
    Ok(())
}
async fn fetch(
    c: &reqwest::Client,
    o: &LocalOptions,
    s: &Source,
) -> Result<Snapshot, &'static str> {
    let r = c
        .get(format!("{}/api/missions/{}", o.loopback(), s.key.id))
        .send()
        .await
        .map_err(|_| "Mission read failed.")?;
    if r.status().as_u16() != 200 {
        return Err("Mission read unavailable. Nothing sent.");
    }
    model::detail(s, &crate::mission_tasks_reader::detail_body(r).await?)
}
pub(crate) async fn write(c: &reqwest::Client, o: &LocalOptions, s: &Submission) -> Outcome {
    if !s.action.eligible(&s.before) {
        return Outcome::NotSent("Invalid captured transition.");
    }
    if let Err(e) = qualify(c, o, &s.source, s.action).await {
        return Outcome::NotSent(e);
    }
    let current = fetch(c, o, &s.source).await;
    if !current.as_ref().is_ok_and(|m| {
        m.title == s.before.title
            && m.status == s.before.status
            && (s.action != model::Action::Complete || m.finished == s.before.finished)
    }) {
        return Outcome::NotSent(
            "The mission changed or could not be checked. Nothing sent. Review a fresh confirmation.",
        );
    }
    let payload = serde_json::json!({"operationId":s.id,"home":{"daemonId":s.source.key.home.daemon,"lineageId":s.source.key.home.lineage},"projectId":s.source.project,"expectedStatus":s.before.status,"action":s.action.wire()});
    let r = match c
        .post(format!(
            "{}/api/missions/{}/lifecycle",
            o.loopback(),
            s.source.key.id
        ))
        .header("Content-Type", "application/json")
        .body(serde_json::to_vec(&payload).expect("lifecycle payload"))
        .send()
        .await
    {
        Ok(r) => r,
        Err(_) => {
            return Outcome::Unknown(
                "No lifecycle response. It may have committed. Do not repeat the action.",
            );
        }
    };
    if r.status().as_u16() != 200 {
        return Outcome::Unknown(
            "No confirmed lifecycle success. The action may have committed, even after an error. No retry is available.",
        );
    }
    match body(r).await {
        Ok(v)
            if v["operationId"].as_str() == Some(&s.id)
                && v["mission"]["passiveLifecycle"] == true
                && model::parse(&s.source, &v["mission"])
                    .is_ok_and(|m| m.status == s.action.status()) =>
        {
            Outcome::Ack
        }
        _ => Outcome::Unknown(
            "Incomplete or mismatched lifecycle response. No GET or retry can settle this action.",
        ),
    }
}
async fn body(mut r: reqwest::Response) -> Result<Value, &'static str> {
    if r.content_length().is_some_and(|n| n > CAP as u64) {
        return Err("Lifecycle response exceeds limit.");
    }
    let mut b = Vec::new();
    while let Some(chunk) = r
        .chunk()
        .await
        .map_err(|_| "Interrupted lifecycle response.")?
    {
        if b.len().saturating_add(chunk.len()) > CAP {
            return Err("Lifecycle response exceeds limit.");
        }
        b.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&b).map_err(|_| "Malformed lifecycle response.")
}
#[cfg(test)]
#[path = "mission_lifecycle_transport_tests.rs"]
mod tests;
