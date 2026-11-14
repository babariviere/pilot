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
const ACTION_CHARS: usize = 80;
/// Longest kept title and state reason.
const LINE_CHARS: usize = 300;

/// The open chat.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct ChatState {
    pub session: String,
    /// The project row this chat reads through, once a global window found it.
    pub project: Option<Value>,
    pub title: String,
    /// "unknown" before a good read, then "working", "question", "done",
    /// "failed", "stopped" or "idle".
    pub state: &'static str,
    /// The chat's own reason for its state, such as why it failed.
    pub state_reason: String,
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
        json!({"sessionId":self.session,"title":self.title,"state":self.state,
            "stateReason":self.state_reason,"rows":chat.rows,"more":chat.more,
            "reading":chat.reading,"reason":chat.reason})
    }
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

/// Compact rows for one history page, oldest first: the user's messages,
/// Pilot's text and one line per tool call. Tool results only mark their
/// step done or failed. Only the newest page can have a running step: an
/// older page's results may sit in a newer page.
pub(crate) fn rows(entries: &[Value], cwd: &str, newest: bool) -> Vec<Value> {
    let mut results: HashMap<&str, bool> = HashMap::new();
    for message in entries.iter().flat_map(messages) {
        if message["role"] == "toolResult"
            && let Some(id) = message["toolCallId"].as_str()
        {
            results.insert(id, message["isError"] == true);
        }
    }
    let mut sorted: Vec<(u64, &Value)> = entries
        .iter()
        .filter_map(|e| Some((entry_id(e)?, e)))
        .collect();
    sorted.sort_by_key(|(id, _)| *id);
    let mut rows = Vec::new();
    for (id, entry) in sorted {
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
            let failed = results
                .get(id_of)
                .copied()
                .or(if newest { None } else { Some(false) });
            let name = call["name"].as_str().unwrap_or_default();
            rows.push(json!({"key":format!("{id}.{n}"),"entryId":id,"role":"step",
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

/// The chat's state, and its own reason for it, from its session record.
pub(crate) fn status(session: &Value) -> (&'static str, String) {
    let reason = |key: &str| one_line(&session[key], LINE_CHARS).unwrap_or_default();
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
    match session["outcome"].as_str() {
        Some("failed") => ("failed", reason("outcomeReason")),
        Some("question") => ("question", String::new()),
        Some("stopped") => ("stopped", reason("outcomeReason")),
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
                    state.project = read.project.clone();
                    state.title = one_line(&read.session["title"], LINE_CHARS).unwrap_or_default();
                    (state.state, state.state_reason) = status(&read.session);
                    state.reason.clear();
                }
                Err(_) => {
                    state.reason = if state.pages.rows.is_empty() {
                        "Pilot could not read this chat. Nothing was sent.".into()
                    } else {
                        "Pilot could not read the newest part of this chat. What shows is from an earlier read.".into()
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

/// A global window reads a chat through the chat's own project, as it reads
/// a mission's planning; a project window reads through its project.
async fn fetch(
    t: &Transport,
    session: &str,
    before: Option<u64>,
    known: Option<Value>,
) -> Result<Read, Error> {
    let global = t.source.project.is_none() || t.focused;
    let path = format!("/api/sessions/{session}");
    let (selected, project) = if !global {
        (None, None)
    } else if let Some(project) = known {
        (Some(t.for_project(&project)?), Some(project))
    } else {
        let catalog = super::new_chat::inventory(t).await?;
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
        || !meta["title"].is_string()
        || project
            .as_ref()
            .is_some_and(|p| p["projectId"] != meta["projectId"])
    {
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
    Ok(Read {
        session: meta,
        page,
        project,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert_eq!(status(&json!({"state":"idle","working":true})).0, "working");
        assert_eq!(status(&json!({"state":"working"})).0, "working");
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
    }
}
