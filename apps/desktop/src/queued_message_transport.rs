//! One captured queue mutation. Pinned Local identity; no retry, redirect or GET settlement.
use crate::{
    LocalOptions,
    queued_message::{Change, Operation, Outcome},
};
use serde_json::{Value, json};
use std::time::Duration;
static ACTIVE: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
struct Slot;
impl Drop for Slot {
    fn drop(&mut self) {
        ACTIVE.fetch_sub(1, std::sync::atomic::Ordering::AcqRel);
    }
}
pub(crate) fn start(
    options: LocalOptions,
    op: Operation,
) -> Result<async_channel::Receiver<Outcome>, &'static str> {
    ACTIVE
        .fetch_update(
            std::sync::atomic::Ordering::AcqRel,
            std::sync::atomic::Ordering::Acquire,
            |n| (n < 2).then_some(n + 1),
        )
        .map_err(|_| "Two queue operations are already active. Nothing sent.")?;
    let slot = Slot;
    let (tx, rx) = async_channel::bounded(1);
    std::thread::Builder::new()
        .name("local-queue-edit".into())
        .spawn(move || {
            let _slot = slot;
            let result = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(rt) => rt.block_on(write(&options, &op)),
                Err(_) => Outcome::NotSent("Queue runtime unavailable. Nothing sent."),
            };
            let _ = tx.send_blocking(result);
        })
        .map_err(|_| "Queue worker unavailable. Nothing sent.")?;
    Ok(rx)
}
pub(crate) async fn write(o: &LocalOptions, op: &Operation) -> Outcome {
    if op.source.home != o.host()
        || !crate::local_model::valid_id(&op.source.chat)
        || op.id.len() > 128
        || op.id.is_empty()
        || !op
            .id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
        || crate::queued_message::State::default()
            .begin(&op.source, &op.row, op.change.clone())
            .is_err()
    {
        return Outcome::NotSent("Captured Local queue identity is invalid.");
    }
    let c = match reqwest::Client::builder()
        .no_proxy()
        .retry(reqwest::retry::never())
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(2))
        .timeout(Duration::from_secs(5))
        .build()
    {
        Ok(c) => c,
        Err(_) => return Outcome::NotSent("Queue transport unavailable."),
    };
    let hello = match crate::local_client::hello(&c, o).await {
        Ok(v) => v,
        Err(e) => return Outcome::NotSent(e),
    };
    if hello["capabilities"]["guardedQueue"] != true {
        return Outcome::NotSent("This Local daemon lacks safe queue editing. Nothing sent.");
    }
    let action = if matches!(op.change, Change::Remove) {
        "remove"
    } else {
        "edit"
    };
    let guard = json!({"token":op.row.token,"operationId":op.id,"daemonId":op.source.home.daemon_id,"lineageId":op.source.home.lineage_id});
    let mut payload = json!({"guard":guard});
    if let Change::Edit { text, mode } = &op.change {
        payload["message"] = json!(text);
        if let Some(m) = mode {
            payload["mode"] = json!(m);
        }
    }
    let url = format!(
        "{}/api/sessions/{}/queue/{}",
        o.loopback(),
        op.source.chat,
        op.row.id
    );
    let request = if action == "remove" {
        c.delete(url)
    } else {
        c.patch(url)
    };
    let response = match request
        .header("Content-Type", "application/json")
        .body(serde_json::to_vec(&payload).expect("bounded captured strings"))
        .send()
        .await
    {
        Ok(r) => r,
        Err(_) => {
            return Outcome::Unknown(
                "No response. The captured operation may have committed. Do not replay.",
            );
        }
    };
    if response.status().as_u16() != 200 {
        return Outcome::Unknown(
            "No success receipt. The operation may have committed, or the captured row changed. Draft retained; no retry.",
        );
    }
    match body(response).await {
        Ok(v)
            if v["ok"] == true
                && v["guard"] == guard
                && v["sessionId"] == op.source.chat
                && v["submissionId"] == op.row.id
                && v["action"] == action =>
        {
            Outcome::Acknowledged
        }
        _ => Outcome::Unknown("Incomplete or mismatched queue receipt. Draft retained; no retry."),
    }
}
async fn body(mut r: reqwest::Response) -> Result<Value, &'static str> {
    let mut bytes = Vec::new();
    while let Some(c) = r.chunk().await.map_err(|_| "Queue response interrupted")? {
        if bytes.len() + c.len() > 4096 {
            return Err("Queue receipt over limit");
        }
        bytes.extend_from_slice(&c);
    }
    serde_json::from_slice(&bytes).map_err(|_| "Invalid queue receipt")
}
#[cfg(test)]
#[path = "queued_message_transport_tests.rs"]
mod tests;
