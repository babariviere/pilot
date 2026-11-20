//! One chat Pilot started for the user (a feedback triage or fix, or a chat
//! started from New), read only. Reads the daemon's saved history one page
//! at a time and the chat's state; they never wake, subscribe to or write
//! to the chat. Only one chat is kept, and only while its page is open.
//! Rows have the planning chat's shape (`planning_chat`), so both page and
//! show the same way.
use super::{
    Error, Shared, Transport,
    planning_chat::{Pages, merge},
    valid_id,
};
use serde_json::{Map, Value, json};
use std::collections::HashMap;

/// Entries per read.
const PAGE: u64 = 32;
/// The newest page: `before` past any entry (the daemon's largest safe integer).
const NEWEST: u64 = 9_007_199_254_740_991;
/// At most this many UTF-8 bytes of one message are kept.
const TEXT_BYTES: usize = 8_000;
const TARGET_CHARS: usize = 200;
const MAX_NESTED_STEPS: usize = 12;
const ACTION_CHARS: usize = 80;
/// Longest kept title and state reason.
const LINE_CHARS: usize = 300;
/// The daemon's limit for one unified patch.
const PATCH_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, PartialEq)]
struct LiveWorkspace {
    cwd: String,
    created_at: u64,
    mission: Value,
    branch: Value,
    source_branch: Value,
    storage: Value,
}

impl LiveWorkspace {
    fn from_session(session: &Value, id: &str, project: &Value) -> Option<Self> {
        let project_id = project["projectId"].as_str()?;
        let project_path = project["projectPath"].as_str()?;
        let cwd = session["cwd"].as_str()?;
        if !valid_id(project_id)
            || session["id"] != id
            || session["projectId"] != project_id
            || session["mode"] != "build"
            || session["workspace"] != "clone"
            || !session["role"].is_null()
            || session["control"] == true
            || session["missionCoordinator"] == true
            || !session["archivedAt"].is_null()
            || !session["continuedTo"].is_null()
            || !session["workspaceDiscardedAt"].is_null()
            || !session["workspaceReclaimedAt"].is_null()
            || !session["recoveryBlockedReason"].is_null()
            || (!session["workspaceSetup"].is_null() && session["workspaceSetup"]["state"] != "ok")
            || !cwd.starts_with('/')
            || cwd.len() > 4096
            || cwd.contains('\0')
            || cwd == project_path
        {
            return None;
        }
        Some(Self {
            cwd: cwd.into(),
            created_at: session["createdAt"].as_u64()?,
            mission: session["missionId"].clone(),
            branch: session["branch"].clone(),
            source_branch: session["sourceBranch"].clone(),
            storage: session["workspaceStorage"].clone(),
        })
    }
}

/// The open chat.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct ChatState {
    pub session: String,
    /// The project row this chat reads through, once a global window found it.
    pub project: Option<Value>,
    /// Changes only when the eligible workspace changes, not on transcript updates.
    live_workspace: Option<(uuid::Uuid, LiveWorkspace)>,
    pub title: String,
    pub source_path: String,
    pub source_label: String,
    /// "unknown" before a good read, then "working", "question", "done",
    /// "failed", "stopped" or "idle".
    pub state: &'static str,
    /// The chat's own reason for its state, such as why it failed.
    pub state_reason: String,
    /// While it waits for a coding slot: its place in line and what holds
    /// the slots, as the service says. Null otherwise.
    pub queue: Value,
    /// The service says it can take one Continue: stopped (also by a mission
    /// User Stop hold), or failed with a safe retry.
    pub can_continue: bool,
    pub can_reply: bool,
    pub reply: Option<Value>,
    /// Its question no longer needs the user: the plan settled it (an explorer chat).
    pub question_settled: bool,
    pub specialist: bool,
    pub archived: bool,
    pub workspace_kept: bool,
    pub restart_only: bool,
    pub recovery_blocked: String,
    pub updated_at: u64,
    pub input_generation: u64,
    pub pending_recovery: Option<Value>,
    pub fix_handoff: Value,
    pub continuation_of: Value,
    pub continued_to: Value,
    pub pages: Pages,
    pub reading: bool,
    /// Why the last read failed. Empty after a good read.
    pub reason: String,
}

impl ChatState {
    fn new(session: &str) -> Self {
        Self {
            session: session.into(),
            state: "unknown",
            ..Self::default()
        }
    }
    /// What the bridge sends: the planning chat's rows plus the chat's state.
    pub fn view(&self) -> Value {
        let rows = json!({"rows":self.pages.rows,"more":self.pages.more,
            "reading":self.reading,"reason":self.reason});
        let chat = crate::plan_activity::chat(&rows);
        json!({"sessionId":self.session,"projectId":self.project.as_ref().map(|p| &p["projectId"]),"title":self.title,"state":self.state,
            "stateReason":self.state_reason,"queue":self.queue,"canContinue":self.can_continue,"canReply":self.can_reply,"reply":self.reply,"questionSettled":self.question_settled,"specialist":self.specialist,"archived":self.archived,"workspaceKept":self.workspace_kept,"restartOnly":self.restart_only,"rows":chat.rows,"more":chat.more,
            "reading":chat.reading,"reason":chat.reason,"sourcePath":self.source_path,"sourceLabel":self.source_label,"pendingRecovery":self.pending_recovery,"recoveryBlocked":self.recovery_blocked,
            "fixHandoff":self.fix_handoff,"continuationOf":self.continuation_of,"continuedTo":self.continued_to,"liveChangesKey":self.live_workspace.as_ref().map(|(key, _)| key.to_string())})
    }

    fn set_workspace(&mut self, read: &Read) {
        let workspace = read
            .project
            .as_ref()
            .and_then(|p| LiveWorkspace::from_session(&read.session, &self.session, p));
        if self.project == read.project
            && self.live_workspace.as_ref().map(|(_, w)| w) == workspace.as_ref()
        {
            return;
        }
        self.live_workspace = workspace.map(|w| (uuid::Uuid::new_v4(), w));
    }
}

/// Authoritative profile access loss can happen before the selected project's
/// refresh reaches this chat. Purge it independently, and notify only once.
pub(super) fn deny(shared: &Shared) -> bool {
    let mut chat = shared
        .session_chat
        .lock()
        .expect("native session chat poisoned");
    let Some(state) = chat.as_mut() else {
        return false;
    };
    let mut unavailable = ChatState::new(&state.session);
    unavailable.reason = "Chat not available. Nothing was sent.".into();
    if *state == unavailable {
        return false;
    }
    *state = unavailable;
    true
}

fn one_line(value: &Value, max: usize) -> Option<String> {
    let line = value
        .as_str()?
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if line.is_empty() {
        return None;
    }
    Some(if line.chars().count() > max {
        let mut cut: String = line.chars().take(max - 1).collect();
        cut.push('…');
        cut
    } else {
        line
    })
}

/// A path relative to the chat's working directory when it is inside it.
fn short_path(value: &Value, cwd: &str) -> Option<String> {
    let path = value.as_str()?;
    let root = if cwd.ends_with('/') {
        cwd.to_owned()
    } else {
        format!("{cwd}/")
    };
    let path = match path.strip_prefix(&root) {
        Some(rest) if !cwd.is_empty() => rest,
        _ => path,
    };
    one_line(&Value::String(path.into()), TARGET_CHARS)
}

/// One tool call as a step. Only small known arguments leave the call.
fn step(name: &str, args: &Value, cwd: &str, failed: Option<bool>) -> Value {
    let request = &args["request"];
    let action = if args["action"] == "write" && request["purpose"].is_string() {
        one_line(&request["purpose"], ACTION_CHARS)
    } else {
        one_line(&args["action"], ACTION_CHARS)
    };
    let target = if name == "grep" {
        one_line(&args["pattern"], TARGET_CHARS)
    } else {
        short_path(&args["path"], cwd)
            .or_else(|| one_line(&args["query"], TARGET_CHARS))
            .or_else(|| one_line(&args["url"], TARGET_CHARS))
            .or_else(|| one_line(&args["pattern"], TARGET_CHARS))
    };
    let mut step = Map::new();
    step.insert(
        "tool".into(),
        json!(one_line(&json!(name), ACTION_CHARS).unwrap_or_else(|| "tool".into())),
    );
    step.insert("running".into(), json!(failed.is_none()));
    step.insert("failed".into(), json!(failed == Some(true)));
    if let Some(action) = action {
        step.insert("action".into(), json!(action));
    }
    if let Some(target) = target {
        step.insert("target".into(), json!(target));
    }
    Value::Object(step)
}

fn messages(entry: &Value) -> &[Value] {
    entry["model"].as_array().map_or(&[], Vec::as_slice)
}

fn blocks(message: &Value) -> &[Value] {
    message["content"].as_array().map_or(&[], Vec::as_slice)
}

fn text(message: &Value) -> String {
    if let Some(s) = message["content"].as_str() {
        return s.into();
    }
    blocks(message)
        .iter()
        .filter(|b| b["type"] == "text")
        .filter_map(|b| b["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n")
}

/// The first bytes of a long message, cut on a character boundary.
fn limited(text: String) -> (String, bool) {
    if text.len() <= TEXT_BYTES {
        return (text, false);
    }
    let mut end = TEXT_BYTES;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    (text[..end].to_owned(), true)
}

fn entry_id(entry: &Value) -> Option<u64> {
    entry["id"]
        .as_u64()
        .filter(|&id| id <= NEWEST)
        .or_else(|| entry["id"].as_str()?.parse().ok())
}

/// Saved interview evidence has no model messages. Read only the immutable
/// record, never tool output or a model's summary of the answers.
fn interview_evidence(entry: &Value) -> Option<(&'static str, String, bool)> {
    let submitted = entry["kind"] == "pilot.interview-submission";
    let round = if submitted {
        &entry["data"]
    } else if entry["kind"] == "pilot.question" && entry["data"]["interview"].is_object() {
        &entry["data"]["interview"]
    } else {
        return None;
    };
    let mut words = if submitted {
        "Submitted interview answers\n\n"
    } else {
        "Questions before proceeding\n\n"
    }
    .to_owned();
    // Stop adding fields once the existing per-message limit is reached.
    let mut shortened = false;
    let mut append = |text: &str| {
        let left = TEXT_BYTES.saturating_sub(words.len());
        let mut end = left.min(text.len());
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        words.push_str(&text[..end]);
        shortened |= end < text.len();
    };
    let questions = round["questions"].as_array()?;
    for q in questions {
        append(q["prompt"].as_str().unwrap_or("Question text unavailable"));
        append("\n");
        if let Some(context) = q["context"].as_str().filter(|c| !c.is_empty()) {
            append(context);
            append("\n");
        }
        for option in q["options"].as_array().into_iter().flatten() {
            append("• ");
            append(option["meaning"].as_str().unwrap_or_default());
            if q["recommendedOptionId"].is_string() && q["recommendedOptionId"] == option["id"] {
                append(" (Recommended)");
            }
            append("\n");
        }
        if submitted {
            let answer = round["answers"]
                .as_array()
                .and_then(|answers| answers.iter().find(|a| a["questionId"] == q["id"]));
            append("Answer: ");
            if let Some(answer) = answer {
                if let Some(meaning) = answer["selectedOption"]["meaning"].as_str() {
                    append(meaning);
                    append("\n");
                }
                append(answer["text"].as_str().unwrap_or_default());
            } else {
                append("No saved answer.");
            }
            append("\n");
        }
        append("\n");
    }
    Some((if submitted { "you" } else { "pilot" }, words, shortened))
}

/// Compact rows for one history page, oldest first: the user's messages,
/// Pilot's text and one line per tool call. Tool results only mark their
/// step done or failed. Only the newest page can have a running step: an
/// older page's results may sit in a newer page.
pub(crate) fn rows(entries: &[Value], cwd: &str, newest: bool) -> Vec<Value> {
    let mut results: HashMap<&str, &Value> = HashMap::new();
    for message in entries.iter().flat_map(messages) {
        if message["role"] == "toolResult"
            && let Some(id) = message["toolCallId"].as_str()
        {
            results.insert(id, message);
        }
    }
    let mut sorted: Vec<(u64, &Value)> = entries
        .iter()
        .filter_map(|e| Some((entry_id(e)?, e)))
        .collect();
    sorted.sort_by_key(|(id, _)| *id);
    let mut rows = Vec::new();
    for (id, entry) in sorted {
        if let Some((role, text, shortened)) = interview_evidence(entry) {
            rows.push(json!({"key":id.to_string(),"entryId":id,"role":role,"text":text,"shortened":shortened}));
            continue;
        }
        // Pilot's note after it sent a cyber-blocked turn again with the Cyber profile.
        if entry["kind"] == "pilot.activity" && entry["data"]["event"]["kind"] == "cyber_retry" {
            if let Some(text) = entry["data"]["event"]["text"].as_str() {
                let (text, shortened) = limited(text.to_owned());
                rows.push(json!({"key":id.to_string(),"entryId":id,"role":"request","text":text,"shortened":shortened}));
            }
            continue;
        }
        let (role, from) = match entry["kind"].as_str() {
            Some("pi.user") => ("you", "user"),
            Some("pi.assistant") => ("pilot", "assistant"),
            _ => continue,
        };
        let words = messages(entry)
            .iter()
            .filter(|m| m["role"] == from)
            .map(text)
            .filter(|t| !t.trim().is_empty())
            .collect::<Vec<_>>()
            .join("\n\n");
        if !words.trim().is_empty() {
            let (text, shortened) = limited(words);
            rows.push(json!({"key":id.to_string(),"entryId":id,"role":role,
                "text":text,"shortened":shortened}));
        }
        if role != "pilot" {
            continue;
        }
        let calls = messages(entry)
            .iter()
            .filter(|m| m["role"] == "assistant")
            .flat_map(blocks)
            .filter(|b| b["type"] == "toolCall" && b["id"].is_string() && b["name"].is_string());
        for (n, call) in calls.enumerate() {
            let id_of = call["id"].as_str().unwrap_or_default();
            let result = results.get(id_of).copied();
            let failed =
                result
                    .map(|m| m["isError"] == true)
                    .or(if newest { None } else { Some(false) });
            let name = call["name"].as_str().unwrap_or_default();
            let key = format!("{id}.{n}");
            // Codemode saves observed calls in the tool result. Never show its
            // source, argument previews or output (which may contain secrets).
            let nested = result
                .filter(|_| name == "codemode")
                .and_then(|m| m["details"]["calls"].as_array());
            if let Some(nested) = nested.filter(|calls| !calls.is_empty()) {
                let valid = |call: &&Value| call["name"].is_string();
                // Keep the first few observed calls and every failure in the
                // aggregate count, even when its details do not fit.
                let (mut shown, mut total) = (0, 0);
                let (mut has_error, mut hidden_failed) = (false, false);
                for child in nested.iter().filter(valid) {
                    let error = matches!(child["status"].as_str(), Some("error" | "cancelled"));
                    has_error |= error;
                    total += 1;
                    if shown == MAX_NESTED_STEPS {
                        hidden_failed |= error;
                        continue;
                    }
                    shown += 1;
                    let child_key = if shown == 1 {
                        key.clone()
                    } else {
                        format!("{key}.{shown}")
                    };
                    rows.push(json!({"key":child_key,"entryId":id,"role":"step","step":
                        step(child["name"].as_str().unwrap_or_default(), &Value::Null, cwd, Some(error))}));
                }
                if total > shown {
                    rows.push(json!({"key":format!("{key}.more"),"entryId":id,"role":"step","step":{
                        "tool":"nested_more","target":format!("{} more tool calls",total - shown),
                        "running":false,"failed":hidden_failed
                    }}));
                }
                if failed == Some(true) && !has_error {
                    rows.push(
                        json!({"key":format!("{key}.script"),"entryId":id,"role":"step","step":
                        step(name, &Value::Null, cwd, failed)}),
                    );
                }
                if shown > 0 || failed == Some(true) {
                    continue;
                }
            }
            rows.push(json!({"key":key,"entryId":id,"role":"step",
                "step":step(name, &call["arguments"], cwd, failed)}));
        }
    }
    rows
}

/// One page of rows from one history page. A history page that is not
/// complete is refused, never shown as an empty chat.
pub(crate) fn page(history: &Value, cwd: &str, newest: bool) -> Result<Value, Error> {
    let (Some(entries), Some(more)) = (history["entries"].as_array(), history["more"].as_bool())
    else {
        return Err(Error::Invalid);
    };
    if entries.len() > 1_000 || entries.iter().any(|e| entry_id(e).is_none()) {
        return Err(Error::Invalid);
    }
    let oldest = entries.iter().filter_map(entry_id).min();
    Ok(json!({"rows":rows(entries, cwd, newest),
        "more":more && oldest.is_some_and(|o| o > 1),"nextBefore":oldest}))
}

/// The service's queue view while the chat waits for a coding slot, or
/// null. A view that does not read is left out, never guessed.
pub(crate) fn queue(session: &Value) -> Value {
    if session["codingQueueReason"]
        .as_str()
        .is_none_or(str::is_empty)
    {
        return Value::Null;
    }
    serde_json::from_value::<crate::contract::CodingQueue>(session["codingQueue"].clone())
        .ok()
        .filter(crate::contract::CodingQueue::valid)
        .map(|mut q| {
            for h in &mut q.holders {
                *h = one_line(&json!(h), LINE_CHARS).unwrap_or_default();
            }
            json!(q)
        })
        .unwrap_or(Value::Null)
}

/// The chat's state, and its own reason for it, from its session record.
pub(crate) fn status(session: &Value) -> (&'static str, String) {
    let reason = |key: &str| one_line(&session[key], LINE_CHARS).unwrap_or_default();
    let queued = reason("codingQueueReason");
    // Saved input waiting for a coding slot reports `working`, but nothing runs yet.
    if !queued.is_empty() && session["state"] != "working" {
        return ("idle", queued);
    }
    let working = match session["working"].as_bool() {
        Some(w) => w,
        None => matches!(session["state"].as_str(), Some("working" | "starting")),
    };
    if working {
        return ("working", String::new());
    }
    if session["state"] == "failed" {
        let why = reason("error");
        return (
            "failed",
            if why.is_empty() {
                reason("outcomeReason")
            } else {
                why
            },
        );
    }
    if !queued.is_empty() {
        return ("idle", queued);
    }
    match session["outcome"].as_str() {
        Some("failed") => ("failed", reason("outcomeReason")),
        Some("question") => ("question", String::new()),
        Some("stopped") => ("stopped", reason("outcomeReason")),
        // A mission chat the user stopped keeps no outcome, only this hold.
        _ if session["workHolds"]
            .as_array()
            .is_some_and(|h| h.iter().any(|h| h == "User Stop hold")) =>
        {
            ("stopped", "You stopped it.".into())
        }
        Some("done") => ("done", String::new()),
        _ => ("idle", String::new()),
    }
}

/// Reads the newest page of `session`'s chat, or the page before what shows,
/// and opens it when another or none is open. Passive: it sends nothing.
pub(super) async fn read(
    t: &Transport,
    shared: &Shared,
    session: &str,
    older: bool,
) -> Result<(), Error> {
    read_chat(t, shared, session, older, true).await
}

/// Reads the open chat's newest page again, without a reading mark, so a
/// live update changes rows in place.
pub(super) async fn live(t: &Transport, shared: &Shared) {
    let open = shared
        .session_chat
        .lock()
        .expect("native session chat poisoned")
        .as_ref()
        .map(|c| c.session.clone());
    if let Some(session) = open {
        let _ = read_chat(t, shared, &session, false, false).await;
    }
}

async fn read_chat(
    t: &Transport,
    shared: &Shared,
    session: &str,
    older: bool,
    mark: bool,
) -> Result<(), Error> {
    if !valid_id(session) {
        return Err(Error::Invalid);
    }
    let (before, project) = {
        let mut chat = shared
            .session_chat
            .lock()
            .expect("native session chat poisoned");
        let state = match chat.as_mut() {
            Some(s) if s.session == session => s,
            _ => chat.insert(ChatState::new(session)),
        };
        let before = if older { state.pages.next_before } else { None };
        if older && before.is_none() {
            return Ok(());
        }
        state.reading |= mark;
        (before, state.project.clone())
    };
    if mark {
        shared.change(|_| ());
    }
    let result = fetch(t, session, before, project).await;
    {
        let mut chat = shared
            .session_chat
            .lock()
            .expect("native session chat poisoned");
        // Closed or another chat opened meanwhile: drop the answer.
        if let Some(state) = chat.as_mut().filter(|s| s.session == session) {
            if mark {
                state.reading = false;
            }
            match &result {
                Ok(read) => {
                    merge(&mut state.pages, &read.page, older);
                    state.set_workspace(read);
                    state.project = read.project.clone();
                    state.title = one_line(&read.session["title"], LINE_CHARS).unwrap_or_default();
                    state.specialist = read.session["role"] == "diagnostics";
                    state.archived = read.session["archivedAt"].is_number();
                    state.workspace_kept = read.session["workspaceCustody"] == "review";
                    state.restart_only = read.session["canRetryStartup"] == true;
                    state.fix_handoff = read.session["fixHandoff"].clone();
                    if state.fix_handoff.is_object() {
                        state.fix_handoff["projectName"] = read.project.as_ref().map(|p| p["name"].clone()).unwrap_or(Value::Null);
                    }
                    state.continuation_of = read.session["continuationOf"].clone();
                    state.continued_to = read.session["continuedTo"].clone();
                    state.recovery_blocked =
                        one_line(&read.session["recoveryBlockedReason"], LINE_CHARS)
                            .unwrap_or_default();
                    state.updated_at = read.session["updatedAt"].as_u64().unwrap_or(0);
                    state.input_generation = read.session["inputGeneration"].as_u64().unwrap_or(0);
                    state.source_path = read.session["cwd"]
                        .as_str()
                        .filter(|s| s.len() <= 4096)
                        .unwrap_or_default()
                        .into();
                    state.source_label = if read.session["mode"] == "ask" {
                        "Read source"
                    } else if read.session["workspace"] == "clone" {
                        "Private coding copy"
                    } else {
                        "Your folder"
                    }
                    .into();
                    (state.state, state.state_reason) = status(&read.session);
                    state.queue = queue(&read.session);
                    state.can_continue = read.session["canContinue"] == true;
                    state.can_reply = read.session["canReply"] == true;
                    state.question_settled = read.session["questionSettled"] == true;
                    state.reason.clear();
                }
                Err(Error::Identity | Error::Unavailable) => {
                    // Access/identity loss cannot leave the prior project's text visible.
                    *state = ChatState::new(session);
                    state.reason = "Chat not available. Nothing was sent.".into();
                }
                Err(_) => {
                    state.live_workspace = None;
                    state.reason = if state.pages.rows.is_empty() {
                        "Pilot could not read this chat. Nothing was sent.".into()
                    } else {
                        "Pilot could not read the newest part of this chat.".into()
                    };
                }
            }
        }
    }
    shared.change(|_| ());
    result.map(|_| ())
}

struct Read {
    session: Value,
    page: Value,
    project: Option<Value>,
}

/// An explicit read for the open chat's current private coding copy.
/// Nothing is cached in window state, and no worker or subscription is opened.
pub(super) async fn live_changes(
    root: &Transport,
    shared: &Shared,
    session: &str,
    workspace_key: &str,
) -> Result<Value, Error> {
    let key = uuid::Uuid::parse_str(workspace_key).map_err(|_| Error::Invalid)?;
    if !valid_id(session) {
        return Err(Error::Invalid);
    }
    let pinned = || {
        let chat = shared
            .session_chat
            .lock()
            .expect("native session chat poisoned");
        let state = chat
            .as_ref()
            .filter(|s| s.session == session)
            .ok_or(Error::Stale)?;
        let (_, workspace) = state
            .live_workspace
            .as_ref()
            .filter(|(current, _)| *current == key)
            .ok_or(Error::Stale)?;
        Ok::<_, Error>((
            state.project.clone().ok_or(Error::Stale)?,
            workspace.clone(),
        ))
    };
    let (project, workspace) = pinned()?;
    let t = root.for_project(&project)?;
    let project_id = &t.source.project()?.project_id;
    let check_access = || async {
        t.gate(false).await?;
        let catalog = super::new_chat::inventory(root).await?;
        if !catalog["projects"]
            .as_array()
            .is_some_and(|rows| rows.contains(&project))
        {
            return Err(Error::Identity);
        }
        Ok::<_, Error>(())
    };
    let path = format!("/api/sessions/{session}");
    let check_workspace = || async {
        let meta = t.get(&path).await?;
        if LiveWorkspace::from_session(&meta, session, &project).as_ref() != Some(&workspace) {
            return Err(Error::Stale);
        }
        Ok::<_, Error>(())
    };
    check_access().await?;
    check_workspace().await?;
    pinned()?;
    let url = reqwest::Url::parse_with_params(
        &t.url(&format!("{path}/changes/live")),
        [
            ("expectedProjectId", project_id.as_str()),
            ("expectedCwd", workspace.cwd.as_str()),
        ],
    )
    .map_err(|_| Error::Invalid)?;
    let query = url.query().ok_or(Error::Invalid)?;
    let snapshot = t.get(&format!("{path}/changes/live?{query}")).await?;
    check_access().await?;
    check_workspace().await?;
    pinned()?;
    live_changes_view(
        &snapshot,
        session,
        project_id,
        &workspace.cwd,
        workspace_key,
    )
}

fn live_changes_view(
    snapshot: &Value,
    session: &str,
    project_id: &str,
    cwd: &str,
    workspace_key: &str,
) -> Result<Value, Error> {
    if snapshot["version"] != 1
        || snapshot["sessionId"] != session
        || snapshot["projectId"] != project_id
        || snapshot["cwd"] != cwd
    {
        return Err(Error::Identity);
    }
    let files = snapshot["files"].as_array().ok_or(Error::Invalid)?;
    let patch = snapshot["diff"].as_str().ok_or(Error::Invalid)?;
    let truncated = snapshot["truncated"].as_bool().ok_or(Error::Invalid)?;
    if patch.len() > PATCH_BYTES || (files.is_empty() && (!patch.is_empty() || truncated)) {
        return Err(Error::Invalid);
    }
    Ok(json!({
        "sessionId": session, "workspaceKey": workspace_key,
        "fileCount": files.len(), "patch": patch, "truncated": truncated
    }))
}

/// Every window reads through the chat's accessible project. Opening never
/// retargets the window's project or opens a worker subscription.
async fn fetch(
    t: &Transport,
    session: &str,
    before: Option<u64>,
    _known: Option<Value>,
) -> Result<Read, Error> {
    let path = format!("/api/sessions/{session}");
    t.profile_gate().await?;
    let meta = t.get(&path).await?;
    if meta["role"] == "diagnostics" {
        let scoped = |m: &Value| {
            m["id"] == session
                && m["role"] == "diagnostics"
                && m["diagnosticScope"] == "app"
                && matches!(
                    m["diagnosticHost"]["hostId"].as_str(),
                    Some("daemon" | "local")
                )
                && m["diagnosticHost"]["daemonId"] == t.source.home.daemon_id
                && m["diagnosticHost"]["lineageId"] == t.source.home.lineage_id
        };
        if !scoped(&meta) {
            return Err(Error::Identity);
        }
        let cursor = before.unwrap_or(NEWEST);
        let history = t
            .get(&format!("{path}/history?before={cursor}&limit={PAGE}"))
            .await?;
        let page = page(&history, "", before.is_none())?;
        let current = t.get(&path).await?;
        t.profile_gate().await?;
        if !scoped(&current) {
            return Err(Error::Stale);
        }
        return Ok(Read {
            session: current,
            page,
            project: None,
        });
    }
    let catalog = super::new_chat::inventory(t).await?;
    let (selected, project) = {
        let meta = t.get(&path).await?;
        let project = catalog["projects"]
            .as_array()
            .ok_or(Error::Invalid)?
            .iter()
            .find(|p| meta["projectId"].is_string() && p["projectId"] == meta["projectId"])
            .ok_or(Error::Unavailable)?
            .clone();
        (Some(t.for_project(&project)?), Some(project))
    };
    let t = selected.as_ref().unwrap_or(t);
    t.gate(false).await?;
    let meta = t.get(&path).await?;
    if meta["id"] != session
        || project
            .as_ref()
            .is_some_and(|p| p["projectId"] != meta["projectId"])
    {
        return Err(Error::Identity);
    }
    if !meta["title"].is_string() {
        return Err(Error::Invalid);
    }
    let cursor = before.unwrap_or(NEWEST);
    let history = t
        .get(&format!("{path}/history?before={cursor}&limit={PAGE}"))
        .await?;
    let page = page(
        &history,
        meta["cwd"].as_str().unwrap_or_default(),
        before.is_none(),
    )?;
    t.gate(false).await?;
    let mut current = t.get(&path).await?;
    if current["id"] != session
        || current["projectId"] != meta["projectId"]
        || super::new_chat::inventory(t).await? != catalog
    {
        return Err(Error::Identity);
    }
    if current["mode"] == "build" && matches!(current["outcome"].as_str(), Some("failed" | "stopped")) {
        current["fixHandoff"] = t.get(&format!("{path}/fix-handoff")).await.unwrap_or(Value::Null);
    }
    Ok(Read {
        session: current,
        page,
        project,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace_read(cwd: &str) -> Read {
        Read {
            session: json!({"id":"s","projectId":"p","mode":"build","workspace":"clone","cwd":cwd,"createdAt":52}),
            page: Value::Null,
            project: Some(json!({"projectId":"p","projectPath":"/project"})),
        }
    }

    #[test]
    fn live_changes_require_an_active_private_coding_copy() {
        for (field, value) in [
            ("id", json!("another")),
            ("projectId", json!("another")),
            ("mode", json!("ask")),
            ("workspace", json!("direct")),
            ("cwd", json!("/project")),
            ("role", json!("diagnostics")),
            ("missionCoordinator", json!(true)),
            ("archivedAt", json!(1)),
            ("continuedTo", json!("another")),
            ("workspaceDiscardedAt", json!(1)),
            ("workspaceReclaimedAt", json!(1)),
            ("recoveryBlockedReason", json!("Still preparing")),
            ("workspaceSetup", json!({"state":"pending"})),
        ] {
            let mut read = workspace_read("/copy");
            read.session[field] = value;
            let mut state = ChatState::new("s");
            state.set_workspace(&read);
            assert!(
                state.view()["liveChangesKey"].is_null(),
                "{field} must fail closed"
            );
        }
    }

    #[test]
    fn workspace_keys_survive_transcript_updates_but_not_replacement_or_reopen() {
        let mut read = workspace_read("/copy");
        let mut state = ChatState::new("s");
        state.set_workspace(&read);
        state.project = read.project.clone();
        let first = state.view()["liveChangesKey"].clone();
        read.session["updatedAt"] = json!(100);
        state.set_workspace(&read);
        assert_eq!(state.view()["liveChangesKey"], first);
        read.session["cwd"] = json!("/other-copy");
        state.set_workspace(&read);
        let replacement = state.view()["liveChangesKey"].clone();
        assert_ne!(first, replacement);
        let mut reopened = ChatState::new("s");
        reopened.set_workspace(&read);
        assert_ne!(reopened.view()["liveChangesKey"], replacement);
    }

    #[test]
    fn live_changes_never_show_a_mismatched_or_incomplete_reply_as_empty() {
        let mut snapshot = json!({
            "version":1,"sessionId":"s","projectId":"p","cwd":"/copy",
            "files":[],"diff":"","truncated":false
        });
        let view = live_changes_view(&snapshot, "s", "p", "/copy", "key").unwrap();
        assert_eq!(view["fileCount"], 0);
        assert_eq!(view["workspaceKey"], "key");
        assert!(live_changes_view(&snapshot, "s", "p", "/new-copy", "key").is_err());
        snapshot["files"] = Value::Null;
        assert!(live_changes_view(&snapshot, "s", "p", "/copy", "key").is_err());
    }

    fn user(id: u64, text: &str) -> Value {
        json!({"id":id,"kind":"pi.user","model":[{"role":"user","content":text}]})
    }
    fn assistant(id: u64, text: &str, calls: Value) -> Value {
        let mut content = vec![json!({"type":"text","text":text})];
        content.extend(calls.as_array().cloned().unwrap_or_default());
        json!({"id":id,"kind":"pi.assistant","model":[{"role":"assistant","content":content}]})
    }
    fn result(id: u64, call: &str, error: bool) -> Value {
        json!({"id":id,"kind":"pi.toolResult","model":[{"role":"toolResult","toolCallId":call,"isError":error}]})
    }

    #[test]
    fn entries_become_messages_and_compact_steps() {
        let note = "Opus 5.5 blocked this turn as cyber work. Pilot sent it again with Cyber (Opus 5).";
        let entries = vec![
            json!({"id":5,"kind":"pilot.activity","model":[],
                "data":{"text":note,"event":{"kind":"cyber_retry","text":note}}}),
            json!({"id":6,"kind":"pilot.activity","model":[],
                "data":{"text":"Checks passed","event":{"kind":"automation_finished","text":"Checks passed"}}}),
        ];
        let notes = rows(&entries, "/w", true);
        assert_eq!(notes.len(), 1, "only the cyber retry note shows");
        assert_eq!(notes[0]["role"], "request");
        assert_eq!(notes[0]["text"], note);
        let entries = vec![
            result(4, "c1", true),
            assistant(
                3,
                "Reading it.",
                json!([{"type":"toolCall","id":"c1","name":"read","arguments":{"path":"/w/src/a.rs"}},
                    {"type":"toolCall","id":"c2","name":"bash","arguments":{"command":"secret"}}]),
            ),
            user(2, "Fix the  \n bug"),
            json!({"id":1,"kind":"pilot.compaction","data":{}}),
        ];
        let rows = rows(&entries, "/w", true);
        let keys: Vec<&str> = rows.iter().filter_map(|r| r["key"].as_str()).collect();
        assert_eq!(keys, ["2", "3", "3.0", "3.1"]);
        assert_eq!(rows[0]["role"], "you");
        assert_eq!(rows[0]["text"], "Fix the  \n bug");
        assert_eq!(rows[1]["role"], "pilot");
        assert_eq!(
            rows[2]["step"],
            json!({"tool":"read","running":false,"failed":true,"target":"src/a.rs"})
        );
        // No saved result yet: still running. Commands never leave the call.
        assert_eq!(
            rows[3]["step"],
            json!({"tool":"bash","running":true,"failed":false})
        );
        // On an older page, a missing result may sit in a newer page.
        assert_eq!(
            super::rows(&entries, "/w", false)[3]["step"]["running"],
            false
        );
        let words = crate::plan_activity::chat(&json!({"rows":rows}));
        assert_eq!(words.rows[2].text, "Read src/a.rs");
        assert!(words.rows[2].failed);
    }

    #[test]
    fn codemode_projects_observed_nested_steps_in_order_without_arguments_or_output() {
        let call = assistant(
            1,
            "",
            json!([
                {"type":"toolCall","id":"script","name":"codemode","arguments":{"code":"secret-code"}},
                {"type":"toolCall","id":"other","name":"read","arguments":{"path":"a.txt"}}
            ]),
        );
        let mut result = result(2, "script", false);
        result["model"][0]["details"]["calls"] = json!([
            {"name":"read","status":"ok","args":"secret-args"},
            {"name":"bash","status":"error","error":"secret-output"},
            {"name":"grep","status":"ok"}
        ]);
        let page = page(&json!({"entries":[call,result],"more":false}), "", true).unwrap();
        let mut pages = Pages::default();
        merge(&mut pages, &page, false);
        let saved = json!({"rows":pages.rows});
        let words = crate::plan_activity::chat(&saved);
        assert_eq!(
            words
                .rows
                .iter()
                .map(|r| r.text.as_str())
                .collect::<Vec<_>>(),
            [
                "Read files",
                "Ran a command",
                "Searched files",
                "Reading a.txt"
            ]
        );
        assert!(words.rows[1].failed);
        assert!(!words.rows[1].running);
        assert!(!saved.to_string().contains("secret-"));
    }

    #[test]
    fn immutable_interviews_remain_readable_without_model_messages() {
        let questions = json!([{"id":"q","section":"authority","prompt":"Who can approve?",
            "context":"Approval is required.","options":[{"id":"me","meaning":"I approve"}],"recommendedOptionId":"me"}]);
        let entries = vec![
            json!({"id":1,"kind":"pilot.question","model":[],"data":{"interview":{"roundId":"r","questions":questions}}}),
            json!({"id":2,"kind":"pilot.interview-submission","model":[],"data":{"roundId":"r","questions":questions,
                "answers":[{"questionId":"q","questionDigest":"digest","selectedOption":{"id":"me","meaning":"I approve"},"text":"  after review\n日本  "}]}}),
        ];
        let rows = rows(&entries, "", true);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["role"], "pilot");
        assert_eq!(rows[1]["role"], "you");
        let shown = rows[1]["text"].as_str().unwrap();
        assert!(shown.contains("Who can approve?\nApproval is required."));
        assert!(shown.contains("• I approve (Recommended)"));
        assert!(shown.contains("Answer: I approve\n  after review\n日本  "));
        assert!(!shown.contains("questionDigest"));
        assert_eq!(rows[1]["shortened"], false);
        let mut long = entries[0].clone();
        long["data"]["interview"]["questions"][0]["prompt"] = json!("日本".repeat(TEXT_BYTES));
        let cut = super::rows(&[long], "", false);
        assert_eq!(cut[0]["shortened"], true);
        assert!(cut[0]["text"].as_str().unwrap().len() <= TEXT_BYTES);
    }

    #[test]
    fn long_messages_are_cut_on_a_character() {
        let long = "é".repeat(TEXT_BYTES);
        let rows = rows(&[user(1, &long)], "", true);
        let text = rows[0]["text"].as_str().unwrap();
        assert!(text.len() <= TEXT_BYTES && text.chars().all(|c| c == 'é'));
        assert_eq!(rows[0]["shortened"], true);
    }

    #[test]
    fn pages_name_where_to_read_before_and_refuse_bad_history() {
        let p = page(
            &json!({"entries":[user(7, "a"), user(9, "b")],"more":true}),
            "",
            true,
        )
        .unwrap();
        assert_eq!(p["nextBefore"], 7);
        assert_eq!(p["more"], true);
        let first = page(&json!({"entries":[user(1, "a")],"more":true}), "", true).unwrap();
        assert_eq!(first["more"], false);
        assert!(
            page(
                &json!({"entries":[{"kind":"pi.user"}],"more":false}),
                "",
                true
            )
            .is_err()
        );
        assert!(page(&json!({"more":false}), "", true).is_err());
    }

    #[test]
    fn pages_join_into_one_chat_with_earlier_rows_first() {
        let mut s = ChatState::new("s");
        let newest = page(
            &json!({"entries":[user(5, "five"), user(6, "six")],"more":true}),
            "",
            true,
        )
        .unwrap();
        merge(&mut s.pages, &newest, false);
        let older = page(
            &json!({"entries":[user(3, "three"), user(4, "four")],"more":false}),
            "",
            false,
        )
        .unwrap();
        merge(&mut s.pages, &older, true);
        let view = s.view();
        let texts: Vec<&str> = view["rows"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|r| r["text"].as_str())
            .collect();
        assert_eq!(texts, ["three", "four", "five", "six"]);
        assert_eq!(view["more"], false);
        assert_eq!(view["state"], "unknown");
    }

    #[test]
    fn state_comes_from_the_session_with_its_reason() {
        let queued = json!({"state":"idle","codingQueueReason":"Waiting for a project coding slot (2 of 2 occupied).",
            "codingQueue":{"kind":"slots","position":2,"holders":["Search index","Export  tests"]}});
        assert_eq!(
            queue(&queued),
            json!({"kind":"slots","position":2,"holders":["Search index","Export tests"]})
        );
        let mut started = queued.clone();
        started["codingQueueReason"] = Value::Null;
        assert!(queue(&started).is_null(), "no reason, no line");
        let mut odd = queued.clone();
        odd["codingQueue"]["position"] = json!(0);
        assert!(
            queue(&odd).is_null(),
            "a view that does not read is left out"
        );
        assert_eq!(status(&json!({"state":"idle","working":true})).0, "working");
        assert_eq!(status(&json!({"state":"working"})).0, "working");
        // Saved input waiting for a coding slot is not running yet.
        let queued = status(&json!({"state":"parked","working":true,
            "codingQueueReason":"Waiting for a project coding slot (2 of 2 occupied)."}));
        assert_eq!(queued.0, "idle");
        assert!(queued.1.starts_with("Waiting for a project coding slot"));
        assert_eq!(
            status(&json!({"state":"idle","outcome":"failed","outcomeReason":"Tests  failed"})),
            ("failed", "Tests failed".into())
        );
        assert_eq!(
            status(&json!({"state":"failed","error":"Worker crashed"})),
            ("failed", "Worker crashed".into())
        );
        assert_eq!(
            status(&json!({"state":"parked","outcome":"done"})).0,
            "done"
        );
        assert_eq!(
            status(&json!({"state":"idle","outcome":"question"})).0,
            "question"
        );
        assert_eq!(status(&json!({"state":"parked"})).0, "idle");
        assert_eq!(
            status(&json!({"state":"parked","workHolds":["User Stop hold"]})),
            ("stopped", "You stopped it.".into()),
            "a mission chat the user stopped has no outcome, only its hold"
        );
        assert_eq!(
            status(
                &json!({"state":"idle","outcome":"done","codingQueueReason":"Waiting for a Pilot coding slot (4 of 4 occupied)."})
            ),
            (
                "idle",
                "Waiting for a Pilot coding slot (4 of 4 occupied).".into()
            )
        );
    }
}
