//! Whole detail read and one bounded PATCH ACK. No retry, redirect or GET settlement.
use crate::{
    LocalOptions,
    mission_brief::Source,
    mission_browser::Home,
    mission_metadata::{self as model, Metadata, Outcome, Save},
};
use serde_json::Value;
use std::time::Duration;
fn client() -> Result<reqwest::Client, &'static str> {
    reqwest::Client::builder()
        .no_proxy()
        .retry(reqwest::retry::never())
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(2))
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|_| "Cannot initialize metadata transport. No save sent.")
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
        .map_err(|_| "Cannot start metadata worker. No save sent.")?;
    Ok(rx)
}
pub(crate) fn read(
    options: LocalOptions,
    source: Source,
) -> Result<async_channel::Receiver<Result<Metadata, &'static str>>, &'static str> {
    spawn("local-metadata-read", move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|_| "Cannot start metadata runtime.")?;
        rt.block_on(async {
            let c = client()?;
            qualify(&c, &options, &source).await?;
            fetch(&c, &options, &source).await
        })
    })
}
pub(crate) fn start(
    options: LocalOptions,
    save: Save,
) -> Result<async_channel::Receiver<Outcome>, &'static str> {
    spawn("local-metadata-save", move || {
        let Ok(rt) = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        else {
            return Outcome::NotSent("Cannot start metadata runtime. No save sent.");
        };
        rt.block_on(async {
            match client() {
                Ok(c) => write(&c, &options, &save).await,
                Err(e) => Outcome::NotSent(e),
            }
        })
    })
}
async fn qualify(c: &reqwest::Client, o: &LocalOptions, s: &Source) -> Result<(), &'static str> {
    if !s.valid() || s.key.home != Home::local(&o.host()) {
        return Err("Captured Local mission identity is unavailable. No save sent.");
    }
    let crate::mission_reader::Data::Catalog(catalog) =
        crate::mission_reader::fetch(c, o, &crate::mission_reader::Route::Catalog).await?
    else {
        return Err("Cannot verify canonical metadata source.");
    };
    if !s.canonical(&catalog) {
        return Err("Exact canonical mission/project is absent. No save sent.");
    }
    Ok(())
}
async fn fetch(
    c: &reqwest::Client,
    o: &LocalOptions,
    s: &Source,
) -> Result<Metadata, &'static str> {
    let r = c
        .get(format!("{}/api/missions/{}", o.loopback(), s.key.id))
        .send()
        .await
        .map_err(|_| "Mission metadata read failed.")?;
    if r.status().as_u16() != 200 {
        return Err("Mission metadata read unavailable. Retained text is unchanged.");
    }
    let v = crate::mission_tasks_reader::detail_body(r).await?;
    model::parse(s, &v["mission"])
}
pub(crate) async fn write(c: &reqwest::Client, o: &LocalOptions, s: &Save) -> Outcome {
    if Metadata::capture(&s.value.title, &s.value.goal).as_ref() != Ok(&s.value) {
        return Outcome::NotSent("Invalid captured metadata. No save sent.");
    }
    if let Err(e) = qualify(c, o, &s.source).await {
        return Outcome::NotSent(e);
    }
    // Identity admission is not CAS. A concurrent editor can still overwrite.
    if let Err(e) = fetch(c, o, &s.source).await {
        return Outcome::NotSent(e);
    }
    let payload = serde_json::json!({"title":s.value.title,"goal":s.value.goal});
    let response = match c
        .patch(format!("{}/api/missions/{}", o.loopback(), s.source.key.id))
        .header("Content-Type", "application/json")
        .body(serde_json::to_vec(&payload).expect("metadata string fields"))
        .send()
        .await
    {
        Ok(r) => r,
        Err(_) => {
            return Outcome::Unknown(
                "No save response. It may have committed. Do not replay; copy your text and inspect separately.",
            );
        }
    };
    // Publication/listeners may fail after COMMIT, including HTTP400.
    if response.status().as_u16() != 200 {
        return Outcome::Unknown(
            "Save returned no confirmed success. It may have committed. No retry is available.",
        );
    }
    match body(response)
        .await
        .and_then(|v| model::parse(&s.source, &v))
    {
        Ok(m) if m == s.value => Outcome::Saved(m),
        _ => Outcome::Unknown(
            "Save response was incomplete or did not match the captured mission and metadata. Do not replay.",
        ),
    }
}
async fn body(mut r: reqwest::Response) -> Result<Value, &'static str> {
    if r.content_length()
        .is_some_and(|n| n > model::WIRE_BYTES as u64)
    {
        return Err("Metadata response exceeds wire limit.");
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = r
        .chunk()
        .await
        .map_err(|_| "Interrupted metadata response.")?
    {
        if bytes.len().saturating_add(chunk.len()) > model::WIRE_BYTES {
            return Err("Metadata response exceeds wire limit.");
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "Malformed metadata response.")
}
#[cfg(test)]
#[path = "mission_metadata_transport_tests.rs"]
mod tests;
