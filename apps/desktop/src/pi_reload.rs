//! App-wide configuration reload. Native menu intent uses the existing courier
//! effect fence; pushed observations never issue or replay a request.
use crate::{LocalOptions, interaction::WriteCommand};
use gpui_kit::{App, AppContext, Entity, Global, Task};
use serde::Deserialize;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Status {
    operation_id: Option<String>,
    pending: u32,
    reloading: u32,
    reloaded: u32,
    failed: u32,
}
impl Status {
    pub(crate) fn parse(value: &serde_json::Value) -> Option<Self> {
        value.get("operationId")?;
        let result: Self = serde_json::from_value(value.clone()).ok()?;
        // Missing identity is valid only for the initial, empty observation.
        let total = u64::from(result.pending)
            + u64::from(result.reloading)
            + u64::from(result.reloaded)
            + u64::from(result.failed);
        if total > 1_000_000
            || result
                .operation_id
                .as_ref()
                .is_some_and(|id| uuid::Uuid::parse_str(id).is_err())
            || (result.operation_id.is_none() && total != 0)
        {
            return None;
        }
        Some(result)
    }
    fn active(&self) -> bool {
        self.pending > 0 || self.reloading > 0
    }
    fn label(&self) -> String {
        if self.failed > 0 {
            format!(
                "Pi reload: {} failed, {} pending",
                self.failed,
                self.pending + self.reloading
            )
        } else if self.active() {
            format!(
                "Pi reload: {} reloaded, {} pending",
                self.reloaded,
                self.pending + self.reloading
            )
        } else if self.reloaded == 0 {
            "Pi configuration ready for new chats".into()
        } else {
            let chats = if self.reloaded == 1 { "chat" } else { "chats" };
            format!("Pi configuration reloaded in {} {chats}", self.reloaded)
        }
    }
}

pub(crate) enum Outcome {
    Accepted(Status),
    Refused(&'static str),
    Unknown,
}
const UNKNOWN: &str = "Reload unconfirmed. Nothing was retried. Check the daemon connection.";

/// One POST, no fallback or retry. Both identities and the echoed operation must match.
pub(crate) async fn submit(
    client: &reqwest::Client,
    options: &LocalOptions,
    operation_id: &str,
) -> Outcome {
    if crate::local_client::hello(client, options).await.is_err() {
        return Outcome::Refused("Local is unavailable or changed identity. Reload was not sent.");
    }
    let sent = client
        .post(format!("{}/api/pi/reload", options.loopback()))
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(serde_json::json!({"operationId": operation_id}).to_string())
        .send()
        .await;
    let mut response = match sent {
        Ok(response) => response,
        Err(error) if error.is_connect() => {
            return Outcome::Refused("Local is offline. Reload was not sent.");
        }
        Err(_) => return Outcome::Unknown,
    };
    match response.status().as_u16() {
        200 => {}
        404 => {
            return Outcome::Refused(
                "This daemon does not support Reload. Update its runtime first.",
            );
        }
        409 => return Outcome::Refused("A pi configuration reload is already pending."),
        503 => {
            return Outcome::Refused(
                "Reload is unavailable while the daemon is updating or closing.",
            );
        }
        400..=499 => return Outcome::Refused("Local refused the reload request."),
        _ => return Outcome::Unknown,
    }
    let mut bytes = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) if chunk.len() <= (64 * 1024_usize).saturating_sub(bytes.len()) => {
                bytes.extend_from_slice(&chunk)
            }
            Ok(None) => break,
            _ => return Outcome::Unknown,
        }
    }
    if crate::local_client::hello(client, options).await.is_err() {
        return Outcome::Unknown;
    }
    let status = serde_json::from_slice(&bytes)
        .ok()
        .and_then(|value| Status::parse(&value));
    match status {
        Some(status) if status.operation_id.as_deref() == Some(operation_id) => {
            Outcome::Accepted(status)
        }
        _ => Outcome::Unknown,
    }
}

#[derive(Default)]
struct Owner {
    status: Option<Status>,
    sending: bool,
    notice: Option<&'static str>,
    task: Option<Task<()>>,
}
struct Managed(Entity<Owner>);
impl Global for Managed {}
fn owner(cx: &App) -> Option<Entity<Owner>> {
    cx.try_global::<Managed>().map(|m| m.0.clone())
}
pub(crate) fn init(cx: &mut App) {
    let entity = cx.new(|_| Owner::default());
    cx.set_global(Managed(entity));
}
pub(crate) fn pushed(status: Status, cx: &mut App) {
    let Some(owner) = owner(cx) else {
        return;
    };
    if owner.read(cx).status.as_ref() == Some(&status) {
        return;
    }
    owner.update(cx, |o, _| o.status = Some(status));
    // Reader pushes can hold LocalViewer's lease; menu availability reads it.
    cx.defer(crate::app_menu::refresh);
}
pub(crate) fn enabled(cx: &App) -> bool {
    owner(cx).is_some_and(|owner| {
        let o = owner.read(cx);
        !o.sending && o.status.as_ref().is_some_and(|s| !s.active())
    }) && crate::local_view::menu_routing::reload_writer(cx).is_some()
        && !super::active(cx)
}
pub(crate) fn label(cx: &App) -> Option<String> {
    let owner = owner(cx)?;
    let o = owner.read(cx);
    if o.sending {
        Some("Requesting pi configuration reload…".into())
    } else if let Some(notice) = o.notice {
        Some(notice.into())
    } else {
        o.status
            .as_ref()
            .filter(|s| s.operation_id.is_some())
            .map(Status::label)
    }
}
pub(crate) fn request(cx: &mut App) {
    if !enabled(cx) {
        return;
    }
    let Some(writer) = crate::local_view::menu_routing::reload_writer(cx) else {
        return;
    };
    let Some(owner) = owner(cx) else {
        return;
    };
    let (reply, result) = async_channel::bounded(1);
    if !writer.command(WriteCommand::ReloadPi {
        operation_id: uuid::Uuid::new_v4().to_string(),
        reply,
    }) {
        owner.update(cx, |o, _| {
            o.notice = Some("Reload could not be queued. Nothing was sent.")
        });
        crate::app_menu::refresh(cx);
        return;
    }
    owner.update(cx, |o, _| {
        o.sending = true;
        o.notice = None;
    });
    let task = cx.spawn({
        let owner = owner.clone();
        async move |cx| {
            let outcome = result.recv().await.unwrap_or(Outcome::Unknown);
            cx.update(|cx| {
                owner.update(cx, |o, _| {
                    o.sending = false;
                    o.task = None;
                    match outcome {
                        // The control socket may already carry a later completion. Never regress it
                        // to the admission snapshot returned by POST.
                        Outcome::Accepted(status) => {
                            if !o
                                .status
                                .as_ref()
                                .is_some_and(|s| s.operation_id == status.operation_id)
                            {
                                o.status = Some(status);
                            }
                        }
                        Outcome::Refused(message) => o.notice = Some(message),
                        Outcome::Unknown => o.notice = Some(UNKNOWN),
                    }
                });
                crate::app_menu::refresh(cx);
            });
        }
    });
    owner.update(cx, |o, _| o.task = Some(task));
    crate::app_menu::refresh(cx);
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn counts_and_identity_are_required_and_bounded() {
        let id = uuid::Uuid::new_v4().to_string();
        let value = json!({"operationId":id,"pending":1,"reloading":0,"reloaded":2,"failed":0});
        let status = Status::parse(&value).unwrap();
        assert!(status.active());
        assert!(status.label().contains("1 pending"));
        let mut complete = status.clone();
        complete.pending = 0;
        complete.reloaded = 1;
        assert!(complete.label().ends_with("1 chat"));
        for bad in [
            json!({}),
            json!({"pending":0,"reloading":0,"reloaded":1,"failed":0}),
            json!({"operationId":id,"pending":-1,"reloading":0,"reloaded":0,"failed":0}),
            json!({"operationId":id,"pending":1000001,"reloading":0,"reloaded":0,"failed":0}),
        ] {
            assert!(Status::parse(&bad).is_none());
        }
    }

    #[tokio::test]
    async fn transport_checks_identity_and_echo_without_replaying_or_following_redirects() {
        use std::sync::{Arc, Mutex};
        use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
        let id = uuid::Uuid::new_v4().to_string();
        let hello = serde_json::json!({"daemonId":"test-daemon","lineageId":"test-lineage", "protocolVersion":1,
            "minimumClientProtocolVersion":1,"capabilities":{"independentExecution":true}}).to_string();
        let status =
            serde_json::json!({"operationId":id,"pending":0,"reloading":0,"reloaded":1,"failed":0})
                .to_string();
        for case in [
            "accepted",
            "wrong-echo",
            "changed-daemon",
            "lost-ack",
            "redirect",
            "unsupported",
            "malformed",
        ] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let options = LocalOptions::synthetic(listener.local_addr().unwrap().port());
            let requests = Arc::new(Mutex::new(Vec::new()));
            let seen = requests.clone();
            let mut replies = vec![(200, Some(hello.clone()))];
            replies.push(match case {
                "lost-ack" => (200, None),
                "redirect" => (307, Some(String::new())),
                "unsupported" => (404, Some("{}".into())),
                "wrong-echo" => (
                    200,
                    Some(status.replace(&id, &uuid::Uuid::new_v4().to_string())),
                ),
                "malformed" => (200, Some("{}".into())),
                _ => (200, Some(status.clone())),
            });
            if !matches!(case, "lost-ack" | "redirect" | "unsupported") {
                replies.push((
                    200,
                    Some(if case == "changed-daemon" {
                        hello.replace("test-daemon", "other-daemon")
                    } else {
                        hello.clone()
                    }),
                ));
            }
            let server = tokio::spawn(async move {
                for (code, response) in replies {
                    let (stream, _) = listener.accept().await.unwrap();
                    let mut reader = BufReader::new(stream);
                    let mut first = String::new();
                    reader.read_line(&mut first).await.unwrap();
                    seen.lock().unwrap().push(first.clone());
                    let mut length = 0;
                    loop {
                        let mut line = String::new();
                        reader.read_line(&mut line).await.unwrap();
                        if line == "\r\n" {
                            break;
                        }
                        if let Some((name, value)) = line.split_once(':')
                            && name.eq_ignore_ascii_case("content-length")
                        {
                            length = value.trim().parse::<usize>().unwrap();
                        }
                    }
                    let mut body = vec![0; length];
                    reader.read_exact(&mut body).await.unwrap();
                    if first.starts_with("POST ") {
                        assert!(serde_json::from_slice::<serde_json::Value>(&body).unwrap()["operationId"].is_string());
                    }
                    if let Some(response) = response {
                        reader.get_mut().write_all(format!("HTTP/1.1 {code} Fixture\r\nConnection: close\r\nContent-Type: application/json\r\nLocation: /must-not-follow\r\nContent-Length: {}\r\n\r\n{response}", response.len()).as_bytes()).await.unwrap();
                    }
                }
            });
            let client = reqwest::Client::builder()
                .no_proxy()
                .retry(reqwest::retry::never())
                .redirect(reqwest::redirect::Policy::none())
                .timeout(std::time::Duration::from_secs(2))
                .build()
                .unwrap();
            let outcome = submit(&client, &options, &id).await;
            server.await.unwrap();
            match (case, outcome) {
                ("accepted", Outcome::Accepted(status)) => assert_eq!(status.reloaded, 1),
                ("unsupported", Outcome::Refused(_)) => {}
                ("accepted" | "unsupported", _) => panic!("unexpected outcome: {case}"),
                (_, Outcome::Unknown) => {}
                _ => panic!("unconfirmed requests must not claim success: {case}"),
            }
            let requests = requests.lock().unwrap();
            assert_eq!(
                requests
                    .iter()
                    .filter(|line| line.starts_with("POST /api/pi/reload "))
                    .count(),
                1,
                "{case}"
            );
            assert!(
                requests
                    .iter()
                    .all(|line| line.starts_with("POST /api/pi/reload ")
                        || line.starts_with("GET /api/hello ")),
                "{case}"
            );
        }
    }
}
