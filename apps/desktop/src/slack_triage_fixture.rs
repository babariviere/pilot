//! Owned synthetic pilotd for Slack triage checks: projects, sources, tracked items, threads,
//! override PATCHes, polls, the local link search and pasted-link adds. Loopback only, no real
//! accounts, Slack or settings.
use crate::LocalOptions;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[derive(Clone)]
pub(crate) struct Reply {
    /// None drops the connection without a response.
    pub(crate) status: Option<u16>,
    pub(crate) body: Value,
    /// Apply a PATCH before replying, as pilotd may before a persistence failure.
    pub(crate) apply: bool,
    pub(crate) delay_ms: u64,
}
impl Reply {
    pub(crate) fn status(status: Option<u16>, body: Value) -> Self {
        Self {
            status,
            body,
            apply: false,
            delay_ms: 0,
        }
    }
}

#[derive(Default)]
pub(crate) struct State {
    pub(crate) seen: Vec<(String, String, Value)>,
    pub(crate) projects: Vec<Value>,
    pub(crate) sources: Vec<Value>,
    pub(crate) items: Vec<Value>,
    pub(crate) threads: BTreeMap<String, Value>,
    /// Keyed by method and exact path (without the query).
    pub(crate) replies: BTreeMap<(String, String), Reply>,
    pub(crate) daemon: String,
    /// Chat-creation receipts by operation id.
    pub(crate) receipts: BTreeMap<String, Value>,
}
impl State {
    pub(crate) fn writes(&self) -> Vec<(String, String, Value)> {
        self.seen
            .iter()
            .filter(|(m, _, _)| m != "GET")
            .cloned()
            .collect()
    }
}

pub(crate) fn project(id: &str, name: &str, channels: &[&str]) -> Value {
    json!({"id":id,"name":name,"path":format!("/synthetic/{id}"),"createdAt":1,
        "tracking":{"slackChannels":channels,
            "slackChannelNames":{"C1":"support"},
            "slackLabels":[{"name":"Product","description":"","effect":"none"},
                {"name":"Noise","description":"","effect":"hide"},
                {"name":"Spam","description":"","effect":"close"}]}})
}

pub(crate) fn source(project: &str, status: &str) -> Value {
    json!({"id":format!("{project}:slack"),"projectId":project,"kind":"slack","label":"Slack",
        "configured":true,"status":status})
}

/// A stored message as pilotd lists it. `updated` is epoch milliseconds.
pub(crate) fn item(
    id: &str,
    project: &str,
    title: &str,
    status: &str,
    severity: &str,
    updated: u64,
) -> Value {
    json!({"id":id,"projectId":project,"kind":"slack","externalId":format!("C1/{updated}.000100"),
        "title":title,"url":format!("https://acme.slack.com/archives/C1/p{updated}000100?team=T1"),
        "status":status,"dismissed":(status == "dismissed"),
        "metadata":{"channel":"C1","channelName":"support","thread_ts":"1.000100","replies":3,
            "type":"bug","severity":severity,"label":null},
        "slack":{"type":"bug","label":null,"severity":severity,"status":status,"overrides":{}},
        "createdAt":updated,"updatedAt":updated})
}

/// A stored message whose permalink and source key are a real Slack message link's:
/// `https://acme.slack.com/archives/C1/p<seconds>000100`, keyed `C1/<seconds>.000100`.
pub(crate) fn message(id: &str, project: &str, title: &str, status: &str, seconds: u64) -> Value {
    let mut value = item(id, project, title, status, "medium", seconds * 1000);
    value["externalId"] = json!(format!("C1/{seconds}.000100"));
    value["url"] = json!(format!(
        "https://acme.slack.com/archives/C1/p{seconds}000100?team=T1"
    ));
    value
}

pub(crate) struct Server {
    pub(crate) options: LocalOptions,
    pub(crate) state: Arc<Mutex<State>>,
    stop: Option<tokio::sync::oneshot::Sender<()>>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl Server {
    pub(crate) fn start(projects: Vec<Value>, sources: Vec<Value>, items: Vec<Value>) -> Self {
        let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let options = LocalOptions::synthetic(listener.local_addr().unwrap().port());
        let state = Arc::new(Mutex::new(State {
            projects,
            sources,
            items,
            daemon: "test-daemon".into(),
            ..Default::default()
        }));
        let shared = state.clone();
        let (stop, mut stopped) = tokio::sync::oneshot::channel::<()>();
        let thread = std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            rt.block_on(async move {
                let listener = tokio::net::TcpListener::from_std(listener).unwrap();
                let mut handlers = tokio::task::JoinSet::new();
                loop {
                    tokio::select! {
                        biased;
                        _ = &mut stopped => break,
                        _ = handlers.join_next(), if !handlers.is_empty() => {}
                        connection = listener.accept(), if handlers.len() < 8 => {
                            let Ok((stream, _)) = connection else { break };
                            let state = shared.clone();
                            handlers.spawn(async move {
                                let _ = tokio::time::timeout(Duration::from_secs(5), serve(stream, state)).await;
                            });
                        }
                    }
                }
                handlers.abort_all();
                while handlers.join_next().await.is_some() {}
            });
        });
        Self {
            options,
            state,
            stop: Some(stop),
            thread: Some(thread),
        }
    }
    pub(crate) fn reply(&self, method: &str, path: &str, reply: Reply) {
        self.state
            .lock()
            .unwrap()
            .replies
            .insert((method.into(), path.into()), reply);
    }
    pub(crate) fn clear(&self, method: &str, path: &str) {
        self.state
            .lock()
            .unwrap()
            .replies
            .remove(&(method.into(), path.into()));
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        self.thread.take().unwrap().join().unwrap();
    }
}

fn query(path: &str) -> (&str, BTreeMap<&str, &str>) {
    let (route, query) = path.split_once('?').unwrap_or((path, ""));
    (
        route,
        query
            .split('&')
            .filter_map(|pair| pair.split_once('='))
            .collect(),
    )
}

fn apply(state: &mut State, id: &str, body: &Value) -> Option<Value> {
    let item = state.items.iter_mut().find(|i| i["id"] == id)?;
    // A confirmed start links one chat, as pilotd does: each chat once, the latest last, and
    // only a new link moves the message to In progress.
    if let Some(session) = body["sessionId"].as_str() {
        let mut ids: Vec<Value> = item["sessionIds"].as_array().cloned().unwrap_or_default();
        let new = !ids.iter().any(|s| s == session);
        ids.retain(|s| s != session);
        ids.push(json!(session));
        item["sessionIds"] = json!(ids);
        item["sessionId"] = json!(session);
        if new && body["start"] == true {
            item["slack"]["status"] = json!("in_progress");
            item["metadata"]["slackStart"] = json!({"outcome":"reacted"});
        }
        item["updatedAt"] = json!(item["updatedAt"].as_u64().unwrap() + 1);
        return Some(item.clone());
    }
    let slack = body["slack"].as_object()?;
    for (key, value) in slack {
        item["slack"][key] = value.clone();
        item["slack"]["overrides"][key] = value.clone();
        if key == "status" {
            item["dismissed"] = json!(value == "dismissed");
            item["slack"]
                .as_object_mut()
                .unwrap()
                .remove("closedByLabel");
        }
    }
    item["updatedAt"] = json!(item["updatedAt"].as_u64().unwrap() + 1);
    Some(item.clone())
}

fn respond(state: &mut State, method: &str, path: &str, body: Value) -> (Option<u16>, Value, u64) {
    assert!(state.seen.len() < 512, "bounded faux request budget");
    state.seen.push((method.into(), path.into(), body.clone()));
    let (route, q) = query(path);
    if let Some(reply) = state.replies.get(&(method.into(), route.into())).cloned() {
        if reply.apply
            && let Some(id) = route.strip_prefix("/api/tracked-items/")
        {
            apply(state, id, &body);
        }
        return (reply.status, reply.body, reply.delay_ms);
    }
    let ok = |v: Value| (Some(200), v, 0);
    match (method, route) {
        ("GET", "/api/hello") => ok(
            json!({"daemonId":state.daemon.clone(),"lineageId":"test-lineage",
            "protocolVersion":1,"minimumClientProtocolVersion":1,
            "capabilities":{"independentExecution":true}}),
        ),
        ("GET", "/api/projects") => ok(Value::Array(state.projects.clone())),
        ("GET", "/api/sources") => ok(Value::Array(
            state
                .sources
                .iter()
                .filter(|s| q.get("projectId").is_none_or(|p| s["projectId"] == *p))
                .cloned()
                .collect(),
        )),
        ("GET", "/api/tracked-items") => {
            let dismissed = q.get("dismissed") == Some(&"true");
            let closed = q.get("closedByLabel") == Some(&"true");
            let all: Vec<&Value> = state
                .items
                .iter()
                .filter(|i| q.get("projectId").is_some_and(|p| i["projectId"] == *p))
                .filter(|i| (i["dismissed"] == true) == dismissed)
                .filter(|i| !closed || i["slack"]["closedByLabel"].is_string())
                .collect();
            let offset: usize = q.get("offset").and_then(|o| o.parse().ok()).unwrap_or(0);
            let limit: usize = q.get("limit").and_then(|o| o.parse().ok()).unwrap_or(100);
            let page: Vec<Value> = all
                .iter()
                .skip(offset)
                .take(limit)
                .map(|v| (*v).clone())
                .collect();
            ok(json!({"items":page,"total":all.len()}))
        }
        ("GET", r) if r.ends_with("/thread") => {
            let id = r
                .trim_start_matches("/api/tracked-items/")
                .trim_end_matches("/thread");
            match state.threads.get(id) {
                Some(v) => ok(v.clone()),
                None => (
                    Some(503),
                    json!({"error":"Couldn't read this message from Slack"}),
                    0,
                ),
            }
        }
        ("PATCH", r) if r.starts_with("/api/tracked-items/") => {
            match apply(state, r.trim_start_matches("/api/tracked-items/"), &body) {
                Some(item) => ok(item),
                None => (Some(404), json!({"error":"Unknown tracked item"}), 0),
            }
        }
        ("POST", r) if r.starts_with("/api/sources/") && r.ends_with("/poll") => {
            ok(json!({"kind":"slack","status":"ok"}))
        }
        // The draft courier's chat creation: every new operation is accepted once.
        ("POST", "/api/operations/receipt") => ok(state
            .receipts
            .get(body["operationId"].as_str().unwrap_or_default())
            .cloned()
            .unwrap_or_else(|| json!({"state":"unknown"}))),
        ("POST", "/api/operations") => {
            let id = body["operationId"].as_str().unwrap_or_default().to_owned();
            let receipt = json!({"operationId":id,"payloadHash":body["payloadHash"],
                "destination":body["destination"],"targetId":body["targetId"],
                "state":"accepted","result":{"sessionId":body["targetId"]}});
            ok(state.receipts.entry(id).or_insert(receipt).clone())
        }
        ("GET", "/api/tracking/slack/search") => {
            // pilotd's link form: exact source keys in Slack-tracking projects, done and
            // dismissed included. Words are not modelled.
            let url = reqwest::Url::parse(&format!("http://fixture{path}")).unwrap();
            let text = url
                .query_pairs()
                .find(|(k, _)| k == "query")
                .map(|(_, v)| v.into_owned())
                .unwrap_or_default();
            let Some(link) = crate::slack_triage::MessageLink::parse(&text) else {
                return ok(json!({"items":[],"total":0}));
            };
            let tracking: Vec<&Value> = state
                .projects
                .iter()
                .filter(|p| {
                    p["tracking"]["slackChannels"]
                        .as_array()
                        .is_some_and(|c| !c.is_empty())
                })
                .collect();
            let items: Vec<Value> = state
                .items
                .iter()
                .filter(|i| tracking.iter().any(|p| p["id"] == i["projectId"]))
                .filter(|i| link.keys().iter().any(|k| i["externalId"] == k.as_str()))
                .cloned()
                .collect();
            ok(json!({"total":items.len(),"items":items}))
        }
        ("POST", "/api/tracking/slack/messages") => {
            let (Some(project), Some(link)) = (
                body["projectId"].as_str(),
                body["url"]
                    .as_str()
                    .and_then(crate::slack_triage::MessageLink::parse),
            ) else {
                return (
                    Some(400),
                    json!({"error":"projectId and url are required"}),
                    0,
                );
            };
            let key = link.keys()[0].clone();
            if let Some(existing) = state
                .items
                .iter()
                .find(|i| i["projectId"] == project && i["externalId"] == key.as_str())
            {
                // A message already in triage is returned as it is.
                return ok(existing.clone());
            }
            let mut added = item(
                &format!("added-{}", state.items.len()),
                project,
                "Added from a link",
                "open",
                "medium",
                1_791_892_800_000,
            );
            added["externalId"] = json!(key);
            added["url"] = json!(link.url);
            added["metadata"]["manual"] = json!(true);
            state.items.push(added.clone());
            ok(added)
        }
        _ => (Some(404), json!({"error":"Unsupported synthetic path"}), 0),
    }
}

async fn serve(mut stream: tokio::net::TcpStream, state: Arc<Mutex<State>>) -> std::io::Result<()> {
    let mut bytes = Vec::new();
    let header_end = loop {
        let mut b = [0; 1024];
        let n = stream.read(&mut b).await?;
        if n == 0 {
            return Ok(());
        }
        bytes.extend_from_slice(&b[..n]);
        if let Some(n) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
            break n + 4;
        }
        if bytes.len() > 8192 {
            return Ok(());
        }
    };
    let headers = String::from_utf8_lossy(&bytes[..header_end]).into_owned();
    let mut words = headers.split_whitespace();
    let method = words.next().unwrap().to_owned();
    let path = words.next().unwrap().to_owned();
    assert!(
        matches!(method.as_str(), "GET" | "PATCH" | "POST"),
        "Slack triage only reads, patches overrides and polls"
    );
    let lower = headers.to_ascii_lowercase();
    let len = lower
        .lines()
        .find_map(|l| l.strip_prefix("content-length:").map(str::trim))
        .and_then(|n| n.parse::<usize>().ok())
        .unwrap_or(0);
    while bytes.len() - header_end < len {
        let mut b = [0; 4096];
        let n = stream.read(&mut b).await?;
        if n == 0 {
            return Ok(());
        }
        bytes.extend_from_slice(&b[..n]);
    }
    let body = if len == 0 {
        Value::Null
    } else {
        serde_json::from_slice(&bytes[header_end..header_end + len]).unwrap()
    };
    let (status, body, delay) = respond(&mut state.lock().unwrap(), &method, &path, body);
    if delay > 0 {
        tokio::time::sleep(Duration::from_millis(delay)).await;
    }
    let Some(status) = status else {
        return Ok(());
    };
    let body = serde_json::to_vec(&body).unwrap();
    stream
        .write_all(
            format!(
                "HTTP/1.1 {status} fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .as_bytes(),
        )
        .await?;
    stream.write_all(&body).await
}
