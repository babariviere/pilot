//! One bounded cancellable Local read lane; optional records follow, never precede raw diff.
//! Review is global: one list of explicit review requests across projects. Each request's
//! exact saved revision is read through the chat that holds its custody.
use crate::{
    LocalOptions,
    mission_browser::{Home, Key},
    native_review as model,
};
use gpui_kit::component::diff::DiffFile;
use serde::Deserialize;
use serde::de::DeserializeOwned;
use std::{sync::Arc, time::Duration};
/// The host answers every refused, missing or unreadable revision read the same way, so
/// this never claims which one happened.
pub(crate) const ACCESS_REFUSED: &str = "This revision is unavailable here, or access was refused. Earlier content was cleared. No live fallback.";
pub(crate) const UNAVAILABLE: &str = "Review data is unavailable: missing, unsupported, unreadable or not allowed here. No live fallback.";
/// The host has no review request source, which is not an empty list.
pub(crate) const REQUESTS_UNAVAILABLE: &str =
    "This host doesn't provide review requests right now.";
pub(crate) const RECORDS_UNAVAILABLE: &str =
    "Related records are unavailable: malformed, partial or unsupported exact assessment scope.";

/// One change's exact reads, through its custody chat, with the project the request
/// listed for it. The host refuses the read unless the chat is currently in that project;
/// the expectation is a precondition only, never authority.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Chat {
    pub(crate) key: Key,
    pub(crate) project: String,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Route {
    /// Review requests after a cursor, optionally only those from one chat.
    Requests(Home, u64, Option<String>),
    /// One chat's saved revisions, with or without a review request.
    Comparisons(Chat, u64),
    Snapshot(Chat, Box<model::Comparison>),
    Records(Chat, String),
    /// Chat, snapshot, side, path, SHA-256.
    Source(Chat, String, String, String, String),
}
impl Route {
    fn home(&self) -> &Home {
        match self {
            Self::Requests(h, ..) => h,
            Self::Comparisons(c, ..)
            | Self::Snapshot(c, ..)
            | Self::Records(c, ..)
            | Self::Source(c, ..) => &c.key.home,
        }
    }
    fn chat(&self) -> Option<&Chat> {
        match self {
            Self::Requests(..) => None,
            Self::Comparisons(c, ..)
            | Self::Snapshot(c, ..)
            | Self::Records(c, ..)
            | Self::Source(c, ..) => Some(c),
        }
    }
}
pub(crate) enum Data {
    Requests(model::Requests),
    Comparisons(model::Comparisons),
    Snapshot(Arc<model::Snapshot>, Result<Vec<DiffFile>, &'static str>),
    Records(Vec<String>),
    Source(String),
}
pub(crate) struct Response {
    pub generation: u64,
    pub route: Route,
    pub result: Result<Data, &'static str>,
}
struct Request {
    generation: u64,
    route: Route,
}
pub(crate) struct Reader {
    commands: async_channel::Sender<Request>,
    replace: async_channel::Receiver<Request>,
}
impl Reader {
    pub(crate) fn start(
        options: LocalOptions,
    ) -> Result<(Self, async_channel::Receiver<Response>), &'static str> {
        let (commands, events) = async_channel::bounded::<Request>(1);
        let replace = events.clone();
        let (updates, output) = async_channel::bounded(1);
        let stale = output.clone();
        std::thread::Builder::new().name("retained-review-reader".into()).spawn(move|| {
            let run=async {
                let client=reqwest::Client::builder().no_proxy().retry(reqwest::retry::never()).redirect(reqwest::redirect::Policy::none())
                    .connect_timeout(Duration::from_secs(2)).timeout(Duration::from_secs(10)).build().map_err(|_| ())?;
                let mut next=None;
                loop {
                    let r=match next.take() { Some(r)=>r, None=> match events.recv().await {Ok(r)=>r,Err(_)=>break} };
                    let result=tokio::select! {biased;
                        n=events.recv()=>{ match n {Ok(n)=>next=Some(n),Err(_)=>break}; continue;},
                        v=fetch(&client,&options,&r.route)=>v,
                    };
                    let response=Response{generation:r.generation,route:r.route,result};
                    if let Err(async_channel::TrySendError::Full(r))=updates.try_send(response) {let _=stale.try_recv(); let _=updates.try_send(r);}
                }
                Ok::<_,()>(())
            };
            if let Ok(rt)=tokio::runtime::Builder::new_current_thread().enable_all().build() {let _=rt.block_on(run);}
            events.close();
        }).map_err(|_| "Couldn't start retained Review reader.")?;
        Ok((Self { commands, replace }, output))
    }
    pub(crate) fn request(&self, generation: u64, route: Route) -> bool {
        match self.commands.try_send(Request { generation, route }) {
            Ok(()) => true,
            Err(async_channel::TrySendError::Closed(_)) => false,
            Err(async_channel::TrySendError::Full(r)) => {
                let _ = self.replace.try_recv();
                self.commands.try_send(r).is_ok()
            }
        }
    }
}
impl Drop for Reader {
    fn drop(&mut self) {
        self.commands.close();
    }
}

async fn get<T: DeserializeOwned>(
    client: &reqwest::Client,
    url: reqwest::Url,
) -> Result<T, &'static str> {
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|_| "Retained Review read failed. Refresh to retry.")?;
    if response.status().as_u16() == 403 {
        return Err(ACCESS_REFUSED);
    }
    if response.status().as_u16() == 422 {
        return Err(RECORDS_UNAVAILABLE);
    }
    if response.status().as_u16() == 503 {
        return Err(REQUESTS_UNAVAILABLE);
    }
    if response.status().as_u16() != 200 {
        return Err(UNAVAILABLE);
    }
    if response
        .content_length()
        .is_some_and(|n| n > model::WIRE_CAP as u64)
    {
        return Err("Retained response exceeds the byte limit. Nothing was decoded.");
    }
    let mut body = Vec::new();
    while let Some(c) = response
        .chunk()
        .await
        .map_err(|_| "Retained Review read interrupted.")?
    {
        if body.len().saturating_add(c.len()) > model::WIRE_CAP {
            return Err("Retained response exceeds the byte limit. Nothing was decoded.");
        }
        body.extend_from_slice(&c);
    }
    serde_json::from_slice(&body).map_err(|_| model::INVALID)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Patch {
    snapshot_id: String,
    patch: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct SourceText {
    snapshot_id: String,
    text: String,
}

pub(crate) async fn fetch(
    client: &reqwest::Client,
    options: &LocalOptions,
    route: &Route,
) -> Result<Data, &'static str> {
    if *route.home() != Home::local(&options.host()) {
        return Err("Review home changed. No host fallback.");
    }
    if route
        .chat()
        .is_some_and(|c| !c.key.valid() || !crate::local_model::valid_id(&c.project))
    {
        return Err(model::INVALID);
    }
    if let Route::Requests(_, _, Some(chat)) = route
        && !crate::local_model::valid_id(chat)
    {
        return Err(model::INVALID);
    }
    crate::local_client::gate(client, options).await?;
    let base = options.loopback();
    // Keys are validated IDs, so they are safe single path segments. Every chat read
    // ends with the request's listed project, so a chat now in another project is refused.
    let chat = |s: &str, pairs: &[(&str, &str)]| {
        let c = route.chat().ok_or(model::INVALID)?;
        let mut url = reqwest::Url::parse(&format!("{base}/api/sessions/{}/review{s}", c.key.id))
            .map_err(|_| model::INVALID)?;
        let mut query = url.query_pairs_mut();
        for (k, v) in pairs {
            query.append_pair(k, v);
        }
        query.append_pair("expectedProjectId", &c.project);
        drop(query);
        Ok::<_, &'static str>(url)
    };
    let data = match route {
        Route::Requests(_, after, filter) => {
            let mut url = reqwest::Url::parse(&format!("{base}/api/review/requests"))
                .map_err(|_| model::INVALID)?;
            url.query_pairs_mut()
                .append_pair("after", &after.to_string());
            if let Some(chat) = filter {
                url.query_pairs_mut().append_pair("sessionId", chat);
            }
            let v: model::Requests = get(client, url).await?;
            let mut seen = std::collections::BTreeSet::new();
            // A chat filter narrows the list; it never admits another chat's request. An
            // unavailable slot names no chat, so only the host's filter can place it.
            if v.requests.len() > 20
                || v.requests.iter().any(|r| {
                    !r.valid()
                        || r.sequence() <= *after
                        || !seen.insert(r.request_id())
                        || filter
                            .as_ref()
                            .is_some_and(|c| r.request().is_some_and(|r| &r.session_id != c))
                })
                || v.requests
                    .windows(2)
                    .any(|r| r[0].sequence() >= r[1].sequence())
                || v.next
                    .is_some_and(|n| v.requests.last().is_none_or(|r| r.sequence() != n))
            {
                return Err(model::INVALID);
            }
            Data::Requests(v)
        }
        Route::Comparisons(_, after) => {
            let v: model::Comparisons =
                get(client, chat("", &[("after", &after.to_string())])?).await?;
            if v.comparisons.len() > 20
                || v.unavailable.as_ref().is_some_and(|u| u.len() > 8192)
                || v.capture.as_ref().is_some_and(|c| !c.valid())
                || v.comparisons
                    .iter()
                    .any(|c| !c.valid() || c.sequence <= *after)
                || v.comparisons
                    .windows(2)
                    .any(|c| c[0].sequence >= c[1].sequence)
                || v.next
                    .is_some_and(|n| v.comparisons.last().is_none_or(|c| c.sequence != n))
            {
                return Err(model::INVALID);
            }
            Data::Comparisons(v)
        }
        Route::Snapshot(_, selected) => {
            if !selected.valid() {
                return Err(model::INVALID);
            }
            let v: model::Snapshot =
                get(client, chat(&format!("/{}", selected.snapshot_id), &[])?).await?;
            // The retained creator must be this exact custody chat.
            let c = route.chat().ok_or(model::INVALID)?;
            v.validate(&c.key.id, &c.project, selected)?;
            let files = if v.diff.is_some() {
                let url = chat(&format!("/{}/patch", selected.snapshot_id), &[])?;
                match get::<Patch>(client, url).await {
                    Ok(p) if p.snapshot_id == selected.snapshot_id => v.parse_patch(&p.patch),
                    Ok(_) => Err(model::INVALID),
                    Err(ACCESS_REFUSED) => return Err(ACCESS_REFUSED),
                    Err(e) => Err(e),
                }
            } else {
                Err("Retained patch unavailable. No live source was substituted.")
            };
            Data::Snapshot(Arc::new(v), files)
        }
        Route::Records(_, snapshot) => {
            if !model::hex(snapshot, 64) {
                return Err(model::INVALID);
            }
            let v: Records = get(client, chat(&format!("/{snapshot}/records"), &[])?).await?;
            Data::Records(v.lines()?)
        }
        Route::Source(_, snapshot, side, path, sha) => {
            if !model::hex(snapshot, 64)
                || !model::hex(sha, 64)
                || !matches!(side.as_str(), "before" | "after")
            {
                return Err(model::INVALID);
            }
            let u = chat(
                &format!("/{snapshot}/source"),
                &[("side", side), ("path", path), ("sha256", sha)],
            )?;
            let v: SourceText = get(client, u).await?;
            if &v.snapshot_id != snapshot
                || v.text.len() > 2 * 1024 * 1024
                || model::hash(v.text.as_bytes()) != *sha
            {
                return Err("Retained source identity/hash failed.");
            }
            Data::Source(v.text)
        }
    };
    crate::local_client::gate(client, options).await?;
    Ok(data)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Assessment {
    id: String,
    task_id: String,
    profile: String,
    profile_revision: u64,
    intent: String,
    applicability: String,
    state: String,
    outcome: Option<String>,
    reason: String,
    limitations: String,
    findings: Vec<Finding>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Finding {
    title: String,
    trigger: String,
    cost: String,
    severity: String,
    evidence: Vec<Citation>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Citation {
    path: String,
    side: String,
    sha256: String,
    start: u64,
    end: u64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Report {
    id: String,
    task_id: String,
    intent: String,
    claim: String,
    limitations: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Allocation {
    id: String,
    task_id: String,
    intent: String,
    reason: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Records {
    assessments: Vec<Assessment>,
    reported: Vec<Report>,
    allocations: Vec<Allocation>,
    more: bool,
}
impl Records {
    fn lines(self) -> Result<Vec<String>, &'static str> {
        if self.assessments.len() > 8 || self.reported.len() > 8 || self.allocations.len() > 8 {
            return Err(model::INVALID);
        }
        let mut lines = Vec::new();
        for a in self.assessments {
            if !crate::local_model::valid_id(&a.id)
                || !crate::local_model::valid_id(&a.task_id)
                || a.profile_revision == 0
                || !matches!(a.applicability.as_str(), "outdated" | "unavailable")
                || a.findings.len() > 100
            {
                return Err(model::INVALID);
            }
            lines.push(format!("Agent · {} (profile r{}) · {} · recorded {} {}\nIntent: {}\n{}\nLimits: {}\nTask {} · result {}",a.profile,a.profile_revision,a.applicability,a.state,a.outcome.unwrap_or_default(),a.intent,a.reason,a.limitations,a.task_id,a.id));
            for f in a.findings {
                lines.push(format!(
                    "Agent finding · {} · {}\n{}\nCost: {}",
                    f.severity, f.title, f.trigger, f.cost
                ));
                for e in f.evidence {
                    if !model::hex(&e.sha256, 64)
                        || !matches!(e.side.as_str(), "before" | "after")
                        || e.start >= e.end
                        || e.end > 2 * 1024 * 1024
                    {
                        return Err(model::INVALID);
                    }
                    lines.push(format!(
                        "Reported citation · {}:{} · UTF-8 bytes {}..{} · {}",
                        e.side, e.path, e.start, e.end, e.sha256
                    ));
                }
            }
        }
        for r in self.reported {
            if !crate::local_model::valid_id(&r.id) || !crate::local_model::valid_id(&r.task_id) {
                return Err(model::INVALID);
            }
            lines.push(format!(
                "Worker reports (not observed) · {}\nIntent: {}\n{}\nLimits: {}\nSubmission {}",
                r.task_id, r.intent, r.claim, r.limitations, r.id
            ));
        }
        for a in self.allocations {
            if !crate::local_model::valid_id(&a.id) || !crate::local_model::valid_id(&a.task_id) {
                return Err(model::INVALID);
            }
            lines.push(format!("Recorded selected scope (current applicability unavailable) · {}\nIntent: {}\n{}\nAllocation {}. Not final acceptance or historical task-purpose proof.",a.task_id,a.intent,a.reason,a.id));
        }
        if self.more {
            lines.push("Related records are bounded; additional history is not shown.".into());
        }
        if lines.is_empty() {
            lines.push("Agent dimensions: Not assessed. No exact scoped results, submissions or allocations are retained.".into());
        }
        Ok(lines)
    }
}
