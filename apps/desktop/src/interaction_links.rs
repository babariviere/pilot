//! Links a chat created from a tracked item (a Slack message) to that item through the
//! existing PATCH /api/tracked-items/:id {sessionId, start: true}, as Swift does after a
//! confirmed start. The link is saved with the accepted creation and sent by this courier
//! until pilotd confirms it, also after a lost reply or a restart. Resending it is safe:
//! pilotd adds a chat to an item's links once, and its start effects (In progress, Slack's
//! eyes reaction) run only for a new link and at most once per item.
use super::*;
use crate::delivery_store::Tracked;

/// After a failed pass, the next one waits this long. Commands and edits never wait for it.
pub(super) const RETRY: Duration = Duration::from_secs(10);
const REPLY_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub(super) enum Linked {
    Done,
    /// pilotd no longer has the item or refused this exact link; resending cannot help.
    Gone,
    Later,
}

pub(super) async fn link(
    client: &reqwest::Client,
    options: &LocalOptions,
    session: &str,
    tracked: &Tracked,
) -> Linked {
    if gate(client, options).await.is_err() {
        return Linked::Later;
    }
    let response = client
        .patch(format!(
            "{}/api/tracked-items/{}",
            options.loopback(),
            tracked.item_id
        ))
        .header("Content-Type", "application/json")
        .body(serde_json::json!({"sessionId": session, "start": true}).to_string())
        .send()
        .await;
    let Ok(response) = response else {
        return Linked::Later;
    };
    match response.status().as_u16() {
        200 if response
            .content_length()
            .is_none_or(|n| n <= REPLY_BYTES as u64) =>
        {
            let Ok(bytes) = response.bytes().await else {
                return Linked::Later;
            };
            let Ok(item) = serde_json::from_slice::<Value>(&bytes) else {
                return Linked::Later;
            };
            let listed = item["sessionIds"]
                .as_array()
                .is_some_and(|ids| ids.iter().any(|id| id == session))
                || item["sessionId"] == session;
            if item["id"] == tracked.item_id.as_str() && listed {
                Linked::Done
            } else {
                Linked::Later
            }
        }
        400 | 404 => Linked::Gone,
        _ => Linked::Later,
    }
}

/// One pass over the pending links, stopping at the first that must wait. Returns when the
/// next pass is due, or None when nothing is left (or the app is closing).
pub(super) async fn drain(
    owner: &mut DeliveryOwner<'_>,
    client: &reqwest::Client,
    options: &LocalOptions,
) -> Option<tokio::time::Instant> {
    if owner.store.book.host != options.host() {
        return None;
    }
    let links: Vec<(String, Tracked)> = owner
        .store
        .book
        .links
        .iter()
        .map(|(s, t)| (s.clone(), t.clone()))
        .collect();
    for (session, tracked) in links {
        let outcome = owner
            .effect(async { Ok(link(client, options, &session, &tracked).await) })
            .await;
        match outcome {
            Ok(Linked::Done | Linked::Gone) => {
                if owner.store.linked(&session, &tracked).is_err() {
                    return Some(tokio::time::Instant::now() + RETRY);
                }
                if outcome == Ok(Linked::Done) {
                    owner.status.linked.insert(tracked.item_id, session);
                }
            }
            Ok(Linked::Later) => return Some(tokio::time::Instant::now() + RETRY),
            Err(_) => return None,
        }
    }
    None
}

#[cfg(test)]
#[path = "interaction_links_tests.rs"]
mod tests;
