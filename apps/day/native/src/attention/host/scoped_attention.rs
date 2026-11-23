//! Direct answers share the root worker and its only journal.
//! The focused project and its cached attention read are not routing authority.
use super::{Draft, DraftKey, Record, bind_answer, canonical, digest, exact, home, snapshot};
use crate::{
    attention_host as cards, attention_interview,
    host::{Error, Journal, Shared, Source, Transport, new_chat, valid_id},
    model::OutcomeStatus,
};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::sync::atomic::Ordering;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Selector {
    project_id: String,
    decision_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    interview_round_id: Option<String>,
}

impl Selector {
    fn validate(&self) -> Result<(), Error> {
        let (session, entry) = self
            .decision_id
            .strip_prefix("question-")
            .and_then(|id| id.rsplit_once('-'))
            .ok_or(Error::Invalid)?;
        if !valid_id(&self.project_id)
            || !valid_id(session)
            || self
                .interview_round_id
                .as_ref()
                .is_some_and(|id| id.is_empty() || id.len() > attention_interview::ANSWERS_LIMIT)
            || !entry
                .parse::<u64>()
                .is_ok_and(|n| safe_number(n) && n.to_string() == entry)
        {
            return Err(Error::Invalid);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Target {
    selector: Selector,
    pin: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Answer {
    picks: Vec<String>,
    text: String,
    #[serde(default)]
    later: bool,
}

#[derive(Debug, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum Command {
    Open {
        selector: Selector,
    },
    Save {
        target: Target,
        answer: Answer,
        #[serde(default, deserialize_with = "present_revision")]
        draft_revision: Option<Option<u64>>,
    },
    Send {
        target: Target,
        answer: Answer,
        #[serde(default, deserialize_with = "present_revision")]
        draft_revision: Option<Option<u64>>,
    },
    Check {
        selector: Selector,
        operation_id: String,
    },
    Recover {
        target: Target,
    },
}

// Omitted is the legacy command; explicitly null is a create-only CAS.
fn present_revision<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Option<u64>>, D::Error> {
    Option::<u64>::deserialize(d).map(Some)
}

impl Command {
    pub(crate) fn validate(&self) -> Result<(), Error> {
        match self {
            Self::Open { selector } => selector.validate(),
            Self::Recover { target } => {
                target.selector.validate()?;
                digest(&target.pin).then_some(()).ok_or(Error::Invalid)
            }
            Self::Check {
                selector,
                operation_id,
            } => {
                selector.validate()?;
                if !valid_id(operation_id) {
                    return Err(Error::Invalid);
                }
                Ok(())
            }
            Self::Save {
                target,
                answer,
                draft_revision,
            }
            | Self::Send {
                target,
                answer,
                draft_revision,
            } => {
                target.selector.validate()?;
                let interview = target.selector.interview_round_id.is_some();
                let malformed = if interview {
                    !answer.picks.is_empty()
                        || answer.later
                        || answer.text.len() > attention_interview::ANSWERS_LIMIT
                } else {
                    answer.text.len() > cards::DRAFT_LIMIT
                };
                if !digest(&target.pin)
                    || answer.picks.len() > 128
                    || answer.picks.iter().any(|p| !valid_id(p))
                    || malformed
                    || !interview && draft_revision.is_some()
                    || draft_revision.flatten().is_some_and(|n| !valid_revision(n))
                    || matches!(self, Self::Send { .. }) && answer.later
                {
                    return Err(Error::Invalid);
                }
                Ok(())
            }
        }
    }
}

fn hash(bytes: &str) -> String {
    format!("{:x}", Sha256::digest(bytes.as_bytes()))
}

fn safe_number(n: u64) -> bool {
    n <= 9_007_199_254_740_991
}

fn valid_revision(n: u64) -> bool {
    n > 0 && safe_number(n)
}

fn positive_revision(value: &Value) -> Option<u64> {
    value.as_u64().filter(|n| valid_revision(*n))
}

fn generation(value: &Value) -> Result<u64, Error> {
    value
        .as_u64()
        .filter(|n| safe_number(*n))
        .ok_or(Error::Invalid)
}

fn validate_scope(scope: &Value, selector: &Selector) -> Result<(), Error> {
    let subject = &scope["subject"];
    let session = subject["sessionId"]
        .as_str()
        .filter(|id| valid_id(id))
        .ok_or(Error::Invalid)?;
    let entry = generation(&subject["entryId"])?;
    generation(&scope["eventId"])?;
    if scope["projectId"] != selector.project_id
        || subject["kind"] != "question"
        || format!("question-{session}-{entry}") != selector.decision_id
        || ["contentDigest", "authorityDigest"]
            .iter()
            .any(|name| scope[*name].as_str().is_none_or(|s| !digest(s)))
    {
        return Err(Error::Identity);
    }
    Ok(())
}

fn target(source: &Source, selector: &Selector, scope: &Value, input_generation: u64) -> Target {
    Target {
        selector: selector.clone(),
        pin: hash(&canonical(&json!([source, scope, input_generation]))),
    }
}

fn answer_kind(request: &Value, selector: &Selector) -> bool {
    request["kind"] == "answer"
        && request.get("clarification").is_none()
        && match &selector.interview_round_id {
            Some(round) => {
                request["interview"]["roundId"] == *round && request.get("message").is_none()
            }
            None => request.get("interview").is_none() && request["message"].is_string(),
        }
}

/// Validate the direct marker and immutable envelope on durable write and reopen.
pub(super) fn validate_record(record: &Record) -> Result<(), Error> {
    let request = &record.request;
    let pinned: Target =
        serde_json::from_value(request["scopedTarget"].clone()).map_err(|_| Error::Invalid)?;
    pinned.selector.validate()?;
    validate_scope(&request["scope"], &pinned.selector)?;
    let input_generation = generation(&request["scopedInputGeneration"])?;
    let operation = &request["operation"];
    let payload = operation["payload"].as_str().ok_or(Error::Invalid)?;
    let mut body = json!({"projectId":pinned.selector.project_id,"scope":request["scope"]});
    if pinned.selector.interview_round_id.is_some() {
        if !request["interview"]["answers"]
            .as_array()
            .is_some_and(|a| !a.is_empty())
            || !request["interviewQuestions"]
                .as_array()
                .is_some_and(|q| !q.is_empty())
        {
            return Err(Error::Invalid);
        }
        body["interview"] = request["interview"].clone();
        if let Some(revision) = request.get("draftRevision") {
            positive_revision(revision).ok_or(Error::Invalid)?;
            body["draftRevision"] = revision.clone();
        }
    } else {
        if request.get("draftRevision").is_some() {
            return Err(Error::Invalid);
        }
        let message = request["message"].as_str().ok_or(Error::Invalid)?;
        if message.trim().is_empty() || message.encode_utf16().count() > cards::REPLY_LIMIT {
            return Err(Error::Invalid);
        }
        body["message"] = json!(message);
    }
    let destination = json!({"hostId":"daemon","daemonId":record.source.home.daemon_id,
        "lineageId":record.source.home.lineage_id});
    if !answer_kind(request, &pinned.selector)
        || record.not_sent && record.receipt.is_some()
        || request["projectId"] != pinned.selector.project_id
        || pinned
            != target(
                &record.source,
                &pinned.selector,
                &request["scope"],
                input_generation,
            )
        || operation["schemaVersion"] != 1
        || operation["sequence"] != 1
        || !operation["producerId"].as_str().is_some_and(valid_id)
        || operation["origin"] != home(&record.source)
        || operation["destination"] != destination
        || operation["targetId"] != request["scope"]["subject"]["sessionId"]
        || operation["payloadHash"] != hash(payload)
        || operation["bindingId"] != hash(&canonical(&request["scope"]))
        || operation["bindingGeneration"] != 1
        || serde_json::from_str::<Value>(payload).map_err(|_| Error::Invalid)? != body
    {
        return Err(Error::Invalid);
    }
    Ok(())
}

async fn project(root: &Transport, selector: &Selector) -> Result<Transport, Error> {
    let catalog = new_chat::inventory(root).await?;
    let row = catalog["projects"]
        .as_array()
        .ok_or(Error::Invalid)?
        .iter()
        .find(|row| row["projectId"] == selector.project_id)
        .ok_or(Error::Identity)?;
    let t = root.for_project(row)?;
    if root
        .source
        .project
        .as_ref()
        .is_some_and(|p| t.source.project.as_ref() != Some(p))
    {
        return Err(Error::Identity);
    }
    Ok(t)
}

fn question<'a>(read: &'a Value, selector: &Selector) -> Result<&'a Value, Error> {
    let mut matches = read["questions"]
        .as_array()
        .ok_or(Error::Invalid)?
        .iter()
        .filter(|q| cards::question_id(q).as_deref() == Some(&selector.decision_id));
    let q = matches.next().ok_or(Error::Stale)?;
    if matches.next().is_some() {
        return Err(Error::Identity);
    }
    validate_scope(&q["scope"], selector)?;
    if q["session"]["id"] != q["scope"]["subject"]["sessionId"] {
        return Err(Error::Identity);
    }
    if !q["question"].is_object() {
        return Err(Error::Unavailable);
    }
    let round = &q["question"]["interview"];
    match &selector.interview_round_id {
        Some(id) if round["roundId"] != *id => return Err(Error::Stale),
        None if !round.is_null() => return Err(Error::Unavailable),
        _ => {}
    }
    Ok(q)
}

fn question_target(source: &Source, selector: &Selector, q: &Value) -> Result<Target, Error> {
    Ok(target(
        source,
        selector,
        &q["scope"],
        generation(&q["session"]["inputGeneration"])?,
    ))
}

fn exact_question<'a>(
    source: &Source,
    read: &'a Value,
    pinned: &Target,
) -> Result<&'a Value, Error> {
    let q = question(read, &pinned.selector)?;
    if question_target(source, &pinned.selector, q)? != *pinned {
        return Err(Error::Stale);
    }
    Ok(q)
}

fn matches_record(record: &Record, source: &Source, selector: &Selector) -> bool {
    record.source == *source
        && validate_scope(&record.request["scope"], selector).is_ok()
        && answer_kind(&record.request, selector)
}

fn answer_state(record: &Record) -> Value {
    let state = if record.not_sent {
        "not-sent"
    } else if record.pending() {
        "unknown"
    } else if super::record_status(record) == OutcomeStatus::Accepted {
        "accepted"
    } else {
        "rejected"
    };
    let mut reply = json!({"operationId":record.id,"state":state});
    if state == "unknown" && record.request["interview"].is_object() {
        let view = cards::project(
            None,
            &[record.summary()],
            &[],
            &[],
            &cards::Local::default(),
        );
        if let Some(decision) = view.decisions.first() {
            reply["decision"] = json!(decision);
        }
    }
    reply
}

fn visible_source(root: &Source, shared: &Shared, source: &Source) -> bool {
    if root.project.is_some() {
        return root == source;
    }
    *shared.focus.lock().expect("native focus poisoned") == source.project
}

fn publish(root: &Source, shared: &Shared, record: &Record) {
    if visible_source(root, shared, &record.source) {
        super::publish(shared, record);
    } else {
        shared.change(|_| ());
    }
}

fn draft(journal: &Journal, source: &Source, key: DraftKey) -> Draft {
    let mut draft = Draft {
        draft_version: 1,
        source: source.clone(),
        key,
        value: Value::Null,
    };
    if let Some(saved) = journal.attention_drafts.get(&draft.id()) {
        draft.value = saved.value.clone();
    }
    draft
}

fn scoped_key(question: &Value, pin: &Target) -> Result<DraftKey, Error> {
    let mut key = cards::question_key(question).ok_or(Error::Invalid)?;
    // Keep direct drafts on the same ledger, without making an older target
    // or the ordinary composer adopt a pick made here.
    key.digest.clone_from(&pin.pin);
    Ok(key)
}

fn draft_answer(
    journal: &Journal,
    q: &Value,
    source: &Source,
    pin: &Target,
    answer: &Answer,
) -> Result<Draft, Error> {
    let mut draft = draft(journal, source, scoped_key(q, pin)?);
    if pin.selector.interview_round_id.is_some() {
        if !attention_interview::matches_draft(&q["question"]["interview"], &answer.text) {
            return Err(Error::Invalid);
        }
        draft.value = interview_draft_value(&answer.text);
        return Ok(draft);
    }
    let n = q["question"]["options"].as_array().map_or(0, Vec::len);
    let several = cards::takes_several(q);
    if (!several && answer.picks.len() > 1)
        || answer
            .picks
            .iter()
            .any(|pick| !(1..=n).any(|i| *pick == format!("option-{i}")))
    {
        return Err(Error::Invalid);
    }
    let (pick, picks) = if several {
        (None, answer.picks.as_slice())
    } else {
        (answer.picks.first(), &[][..])
    };
    draft.value = json!({"pick":pick,"picks":picks,"text":answer.text,
        "question":draft.value["question"].as_str().unwrap_or_default(),
        "later":answer.later || draft.value["later"] == true});
    Ok(draft)
}

fn interview_draft_value(text: &str) -> Value {
    json!({"pick":null,"picks":[],"text":text,"question":"","later":false})
}

fn supports_drafts(read: &Value, selector: &Selector) -> bool {
    selector.interview_round_id.is_some() && read["capabilities"]["interviewDrafts"] == 1
}

fn draft_request(t: &Transport, q: &Value, kind: &str) -> Value {
    json!({"version":1,"home":home(&t.source),"projectId":q["scope"]["projectId"],
        "kind":kind,"scope":q["scope"]})
}

async fn read_draft(t: &Transport, q: &Value, lookup: bool) -> Result<Value, Error> {
    let mut request = draft_request(t, q, "interview-draft");
    request["roundId"] = q["question"]["interview"]["roundId"].clone();
    let mut reply = t.attention_call(&request, lookup).await?;
    match reply["ok"].as_bool() {
        Some(true) => reply
            .as_object_mut()
            .and_then(|r| r.remove("value"))
            .ok_or(Error::Invalid),
        Some(false) if reply["error"]["code"] == "stale" => Err(Error::Stale),
        _ => Err(Error::Unavailable),
    }
}

fn draft_not_saved() -> Value {
    json!({"state":"draft-not-saved"})
}

async fn save_draft(
    t: &Transport,
    q: &Value,
    text: &str,
    expected_revision: Option<Option<u64>>,
    live: impl Fn() -> Result<(), Error>,
) -> Result<Value, Error> {
    let Some(expected) = expected_revision else {
        return Ok(draft_not_saved());
    };
    let next = expected.unwrap_or(0) + 1;
    let Some(draft) = attention_interview::partial_answer(&q["question"]["interview"], text)
        .filter(|_| valid_revision(next))
    else {
        return Ok(draft_not_saved());
    };
    let mut request = draft_request(t, q, "interview-draft-save");
    request["expectedRevision"] = json!(expected);
    request["draft"] = draft;
    let confirms = |value: &Value| {
        positive_revision(&value["revision"]) == Some(next)
            && value["roundId"] == request["draft"]["roundId"]
            && value["answers"] == request["draft"]["answers"]
    };
    live()?;
    let reply = t.attention_call(&request, false).await;
    live()?;
    match reply {
        Ok(reply) if reply["ok"] == true && confirms(&reply["value"]) => {}
        Ok(reply) if reply["ok"] == false && reply["error"]["code"] == "conflict" => {
            return Ok(json!({"state":"draft-conflict"}));
        }
        Ok(reply)
            if reply["ok"] == false
                && reply["error"]["code"]
                    .as_str()
                    .is_some_and(|code| code != "unknown") =>
        {
            return Ok(draft_not_saved());
        }
        Err(Error::Identity) => return Ok(draft_not_saved()),
        _ => {
            // A lost reply may have committed. Read once, never repeat the save.
            let saved = read_draft(t, q, true).await;
            live()?;
            if !saved.is_ok_and(|value| confirms(&value)) {
                return Ok(draft_not_saved());
            }
        }
    }
    Ok(json!({"state":"saved","draftRevision":next}))
}

fn opened(
    t: &Transport,
    journal: &Journal,
    selector: &Selector,
    read: &Value,
    remote: Option<Value>,
) -> Result<Value, Error> {
    let q = question(read, selector)?;
    let pin = question_target(&t.source, selector, q)?;
    let (value, revision) = match remote {
        Some(saved) if !saved.is_null() => {
            let revision = positive_revision(&saved["revision"]).ok_or(Error::Invalid)?;
            let text = attention_interview::saved_text(&q["question"]["interview"], &saved)
                .ok_or(Error::Invalid)?;
            (interview_draft_value(&text), Some(json!(revision)))
        }
        other => (
            draft(journal, &t.source, scoped_key(q, &pin)?).value,
            other, // Only explicit daemon null allows the legacy draft as a seed.
        ),
    };
    let card_key = cards::question_key(q).ok_or(Error::Invalid)?;
    // Project this card with the existing form and draft contract. The direct
    // route does not offer clarification, artifact opens, or chat navigation.
    let read = json!({"current":true,"questions":[q]});
    let mut view = cards::project(
        Some(&read),
        &[],
        &[(card_key, value)],
        &[],
        &cards::Local::default(),
    );
    let decision = view.decisions.first_mut().ok_or(Error::Invalid)?;
    decision.artifacts.clear();
    decision.request_session_id.clear();
    let mut result = json!({"state":"ready","target":pin,"decision":decision});
    if let Some(revision) = revision {
        result["draftRevision"] = revision;
    }
    Ok(result)
}

fn exact_receipt(record: &Record, reply: &Value) -> Result<(), Error> {
    exact(&record.request, reply)?;
    if reply["ok"] != true
        || reply["value"]["state"] == "accepted"
            && reply["value"]["result"]["sessionId"] != record.request["operation"]["targetId"]
    {
        return Err(Error::Unknown);
    }
    Ok(())
}

async fn receipt(
    t: &Transport,
    journal: &mut Journal,
    record: &mut Record,
    lookup: bool,
) -> Result<(), Error> {
    if let Ok(reply) = t.attention_call(&record.request, lookup).await
        && exact_receipt(record, &reply).is_ok()
    {
        let mut fresh = record.clone();
        fresh.receipt = Some(reply);
        if journal.save_attention(fresh.clone()).is_err() {
            journal.poison();
            return Err(Error::Storage);
        }
        *record = fresh;
    }
    Ok(())
}

/// Call on the existing worker with the root transport and the sole journal.
/// The bridge supplies its enqueue/close admission fence. Only first send
/// needs a live stream; historical receipt lookup never rereads the question.
pub(in crate::host) async fn handle(
    root: &Transport,
    journal: &mut Journal,
    shared: &Shared,
    epoch: u64,
    command: &Command,
    admit: impl Fn() -> Result<(), Error>,
) -> Result<Value, Error> {
    command.validate()?;
    let selector = match command {
        Command::Open { selector } | Command::Check { selector, .. } => selector,
        Command::Save { target, .. }
        | Command::Send { target, .. }
        | Command::Recover { target } => &target.selector,
    };
    let live = || {
        admit()?;
        shared.current(epoch)?;
        if !shared.connected.load(Ordering::SeqCst) {
            return Err(Error::Offline);
        }
        Ok(())
    };
    admit()?;
    shared.open()?;
    let t = project(root, selector).await?;
    admit()?;
    shared.open()?;
    let pending = || {
        journal
            .attention
            .values()
            .find(|r| r.pending() && matches_record(r, &t.source, selector))
    };
    match command {
        Command::Open { .. } => {
            if let Some(record) = pending() {
                t.gate(false).await?;
                admit()?;
                shared.open()?;
                return Ok(answer_state(record));
            }
            live()?;
            let read = snapshot(&t).await?;
            live()?;
            let remote = if supports_drafts(&read, selector) {
                let result = read_draft(&t, question(&read, selector)?, false).await;
                live()?;
                Some(result?)
            } else {
                None
            };
            opened(&t, journal, selector, &read, remote)
        }
        Command::Check { .. } | Command::Recover { .. } => {
            let pin = match command {
                Command::Recover { target } => {
                    Some(serde_json::to_value(target).map_err(|_| Error::Invalid)?)
                }
                _ => None,
            };
            let mut record = journal
                .attention
                .values()
                .filter(|r| {
                    matches_record(r, &t.source, selector)
                        && match command {
                            Command::Check { operation_id, .. } => r.id == *operation_id,
                            _ => pin.as_ref() == r.request.get("scopedTarget"),
                        }
                })
                .max_by_key(|r| {
                    (
                        r.pending(),
                        super::record_status(r) == OutcomeStatus::Accepted,
                    )
                })
                .cloned()
                .ok_or(Error::Unknown)?;
            t.gate(false).await?;
            admit()?;
            shared.open()?;
            if record.pending() {
                receipt(&t, journal, &mut record, true).await?;
                publish(&root.source, shared, &record);
            }
            Ok(answer_state(&record))
        }
        Command::Save {
            target,
            answer,
            draft_revision,
        }
        | Command::Send {
            target,
            answer,
            draft_revision,
        } => {
            if let Some(record) = pending() {
                return Ok(answer_state(record));
            }
            live()?;
            let read = snapshot(&t).await?;
            let q = exact_question(&t.source, &read, target)?;
            live()?;
            let saving = matches!(command, Command::Save { .. });
            let daemon_drafts = supports_drafts(&read, selector);
            if daemon_drafts && saving {
                return save_draft(&t, q, &answer.text, *draft_revision, live).await;
            }
            let revision = if daemon_drafts {
                let Some(revision) = draft_revision.flatten() else {
                    return Ok(draft_not_saved());
                };
                Some(revision)
            } else {
                if draft_revision.is_some() {
                    // A daemon that no longer offers drafts cannot honor this CAS or send.
                    return Ok(draft_not_saved());
                }
                let draft = draft_answer(journal, q, &t.source, target, answer)?;
                journal.save_attention_draft(draft)?;
                if saving {
                    return Ok(json!({"state":"saved"}));
                }
                None
            };
            let mut request = cards::answer_request(
                &json!({"questions":[q]}),
                &selector.decision_id,
                &answer.picks,
                &answer.text,
            )
            .map_err(|_| Error::Invalid)?;
            // A pending clarification or help is an unresolved intent too.
            if journal.attention.values().any(|r| {
                r.source == t.source
                    && r.pending()
                    && super::subject(&r.request) == request["scope"]["subject"]
            }) {
                return Err(Error::Unknown);
            }
            // Even if a passive read still shows the question, a durable accepted
            // answer to its exact scope is terminal.
            if journal.attention.values().any(|r| {
                matches_record(r, &t.source, selector)
                    && r.request["scope"] == request["scope"]
                    && super::record_status(r) == OutcomeStatus::Accepted
            }) {
                return Err(Error::Stale);
            }
            let id = uuid::Uuid::new_v4().to_string();
            request["version"] = json!(1);
            request["home"] = home(&t.source);
            request["projectId"] = json!(selector.project_id);
            request["scopedTarget"] = json!(target);
            request["scopedInputGeneration"] = q["session"]["inputGeneration"].clone();
            if let Some(revision) = revision {
                request["draftRevision"] = json!(revision);
            }
            bind_answer(&t.source, &id, &mut request)?;
            let mut record = Record {
                attention_version: 1,
                source: t.source.clone(),
                id,
                request,
                receipt: None,
                not_sent: false,
            };
            journal.save_attention(record.clone())?;
            publish(&root.source, shared, &record);

            let checked = async {
                let current = project(root, selector).await?;
                if current.source != t.source {
                    return Err(Error::Identity);
                }
                let fresh = snapshot(&current).await?;
                exact_question(&current.source, &fresh, target)?;
                if supports_drafts(&fresh, selector) != daemon_drafts {
                    return Err(Error::Stale);
                }
                live()?;
                Ok(())
            }
            .await;
            if checked.is_err() {
                record.not_sent = true;
                journal.save_attention(record.clone())?;
                publish(&root.source, shared, &record);
                return Ok(answer_state(&record));
            }

            // Enter at most once. A reply that fails to cross fsync is unknown.
            let _ = receipt(&t, journal, &mut record, false).await;
            publish(&root.source, shared, &record);
            Ok(answer_state(&record))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{contract::Home, host::Project};
    use std::{
        io::{BufRead, BufReader, Read, Write},
        net::{TcpListener, TcpStream},
        os::unix::fs::OpenOptionsExt,
        path::PathBuf,
        time::Duration,
    };

    fn source() -> Source {
        Source {
            profile: "/profile".into(),
            port: 1,
            home: Home {
                daemon_id: "daemon".into(),
                lineage_id: "lineage".into(),
            },
            project: Some(Project {
                project_id: "other".into(),
                project_path: "/other".into(),
            }),
        }
    }

    fn selector() -> Selector {
        Selector {
            project_id: "other".into(),
            decision_id: "question-chat-5".into(),
            interview_round_id: None,
        }
    }

    fn read() -> Value {
        json!({"questions":[{
            "scope":{"projectId":"other","subject":{"kind":"question","sessionId":"chat","entryId":5},
                "eventId":9,"contentDigest":"a".repeat(64),"authorityDigest":"b".repeat(64)},
            "session":{"id":"chat","title":"Origin chat","inputGeneration":3},
            "question":{"question":"Which items?","multiSelect":true,
                "options":[{"label":"One","suggested":true},{"label":"Two"}]}
        }]})
    }

    fn interview() -> (Selector, Value, Answer) {
        let mut read = read();
        let mut selector = selector();
        selector.interview_round_id = Some("round-1".into());
        read["questions"][0]["question"]["interview"] = json!({
            "roundId":"round-1","questionDigests":{"scope":"digest-1","detail":"digest-2"},
            "questions":[
                {"id":"scope","section":"outcome","prompt":"What should change?",
                    "options":[{"id":"keep","meaning":"Keep draft text"}],"recommendedOptionId":"keep"},
                {"id":"detail","section":"constraints","prompt":"Which details?","options":[]}
            ]
        });
        let answer = Answer {
            picks: vec![],
            text: json!({"roundId":"round-1","answers":[
                {"questionId":"scope","selectedOptionId":"keep","text":""},
                {"questionId":"detail","selectedOptionId":null,"text":"  中文\n  "}
            ]})
            .to_string(),
            later: false,
        };
        (selector, read, answer)
    }

    fn record() -> Record {
        let selector = selector();
        let read = read();
        let record = answer_record(
            &read,
            &selector,
            &["option-2".into(), "option-1".into()],
            "  the rest\n",
        );
        assert_eq!(record.request["message"], "- One\n- Two\n\n  the rest\n");
        record
    }

    fn answer_record(read: &Value, selector: &Selector, picks: &[String], text: &str) -> Record {
        let src = source();
        let q = question(read, selector).unwrap();
        let mut request = cards::answer_request(read, &selector.decision_id, picks, text).unwrap();
        request["version"] = json!(1);
        request["home"] = home(&src);
        request["projectId"] = json!(selector.project_id);
        request["scopedTarget"] = json!(question_target(&src, selector, q).unwrap());
        request["scopedInputGeneration"] = q["session"]["inputGeneration"].clone();
        bind_answer(&src, "op-id", &mut request).unwrap();
        Record {
            attention_version: 1,
            source: src,
            id: "op-id".into(),
            request,
            receipt: None,
            not_sent: false,
        }
    }

    #[test]
    fn interview_open_and_draft_keep_exact_round_without_creating_an_intent() {
        let (selector, mut read, answer) = interview();
        let path = std::env::temp_dir().join(format!("scoped-interview-{}", uuid::Uuid::new_v4()));
        let t = Transport::new(source()).unwrap();
        let mut journal = Journal::open(path.clone()).unwrap();
        let opened_round = opened(&t, &journal, &selector, &read, None).unwrap();
        assert!(opened_round.get("draftRevision").is_none());
        let decision = &opened_round["decision"];
        assert_eq!(decision["interviewRoundId"], "round-1");
        assert_eq!(
            decision["interviewQuestions"][0]["selectedOptionId"],
            Value::Null
        );
        let pin: Target = serde_json::from_value(opened_round["target"].clone()).unwrap();
        let q = exact_question(&t.source, &read, &pin).unwrap();
        let draft = draft_answer(&journal, q, &t.source, &pin, &answer).unwrap();
        journal.save_attention_draft(draft).unwrap();
        drop(journal);

        let journal = Journal::open(path.clone()).unwrap();
        assert!(journal.attention.is_empty());
        let restored = opened(&t, &journal, &selector, &read, None).unwrap();
        assert_eq!(
            restored["decision"]["interviewQuestions"][0]["selectedOptionId"],
            "keep"
        );
        assert_eq!(
            restored["decision"]["interviewQuestions"][1]["text"],
            "  中文\n  "
        );
        let seeded = opened(&t, &journal, &selector, &read, Some(Value::Null)).unwrap();
        assert_eq!(seeded["decision"], restored["decision"]);
        assert_eq!(seeded.get("draftRevision"), Some(&Value::Null));

        let round = &q["question"]["interview"];
        let mut saved = attention_interview::partial_answer(round, &answer.text).unwrap();
        saved["revision"] = json!(2);
        saved["answers"].as_array_mut().unwrap().remove(0);
        saved["answers"][0]["text"] = json!("  Daemon's newer words\n");
        let opened = opened(&t, &journal, &selector, &read, Some(saved)).unwrap();
        assert_eq!(opened["draftRevision"], 2);
        assert!(opened["decision"]["interviewQuestions"][0]["selectedOptionId"].is_null());
        assert_eq!(
            opened["decision"]["interviewQuestions"][1]["text"],
            "  Daemon's newer words\n"
        );
        assert_eq!(
            serde_json::from_str::<Value>(opened["decision"]["draft"]["text"].as_str().unwrap())
                .unwrap(),
            json!({"roundId":"round-1","answers":[
                {"questionId":"detail","selectedOptionId":null,"text":"  Daemon's newer words\n"}
            ]})
        );
        assert_eq!(
            journal.attention_drafts.len(),
            1,
            "daemon open never rewrites the local draft"
        );
        read["questions"][0]["session"]["inputGeneration"] = json!(4);
        assert_eq!(exact_question(&t.source, &read, &pin), Err(Error::Stale));
        read["questions"][0]["question"]["interview"]["roundId"] = json!("round-2");
        assert_eq!(question(&read, &selector), Err(Error::Stale));
        assert_eq!(question(&read, &self::selector()), Err(Error::Unavailable));
        drop(journal);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn interview_record_only_matches_its_round_and_persists_the_structured_payload() {
        let (selector, read, answer) = interview();
        let record = answer_record(&read, &selector, &answer.picks, &answer.text);
        record.validate().unwrap();
        assert!(record.request.get("message").is_none());
        assert_eq!(
            record.request["interview"]["answers"][0],
            json!({"questionId":"scope","questionDigest":"digest-1",
                "selectedOption":{"id":"keep","meaning":"Keep draft text"},"text":""})
        );
        assert_eq!(
            record.request["interview"]["answers"][1]["text"],
            "  中文\n  "
        );
        assert!(matches_record(&record, &record.source, &selector));
        let mut wrong_round = selector.clone();
        wrong_round.interview_round_id = Some("round-2".into());
        assert!(!matches_record(&record, &record.source, &wrong_round));
        assert!(!matches_record(&record, &record.source, &self::selector()));
        let mut tampered = record.clone();
        tampered.request["interview"]["answers"][0]["questionDigest"] = json!("tampered");
        assert_eq!(tampered.validate(), Err(Error::Invalid));
        let unknown = answer_state(&record);
        assert_eq!(unknown["state"], "unknown");
        assert_eq!(unknown["decision"]["delivery"], "unknown");
        assert_eq!(unknown["decision"]["interviewRoundId"], "round-1");
        assert_eq!(
            unknown["decision"]["interviewQuestions"][1]["text"],
            "  中文\n  "
        );
    }

    #[test]
    fn exact_card_cannot_drift_to_another_project_question_or_input_generation() {
        let source = source();
        let mut read = read();
        let selector = selector();
        let pin = question_target(&source, &selector, question(&read, &selector).unwrap()).unwrap();
        assert!(exact_question(&source, &read, &pin).is_ok());
        let mut moved = source.clone();
        moved.project.as_mut().unwrap().project_path = "/different".into();
        assert_eq!(exact_question(&moved, &read, &pin), Err(Error::Stale));
        read["questions"][0]["session"]["inputGeneration"] = json!(4);
        assert_eq!(exact_question(&source, &read, &pin), Err(Error::Stale));
        read["questions"][0]["session"]["inputGeneration"] = json!(3);
        read["questions"][0]["scope"]["authorityDigest"] = json!("c".repeat(64));
        assert_eq!(exact_question(&source, &read, &pin), Err(Error::Stale));
        read["questions"][0]["scope"]["projectId"] = json!("home");
        assert_eq!(exact_question(&source, &read, &pin), Err(Error::Identity));
        read["questions"][0]["scope"]["projectId"] = json!("other");
        read["questions"][0]["question"]["interview"] = json!({"roundId":"round"});
        assert_eq!(
            exact_question(&source, &read, &pin),
            Err(Error::Unavailable)
        );
    }

    #[test]
    fn shared_journal_reopens_exact_draft_and_preserves_unknown_until_matching_receipt() {
        let path = std::env::temp_dir().join(format!("scoped-attention-{}", uuid::Uuid::new_v4()));
        let selector = selector();
        let mut record = record();
        let transport = Transport::new(record.source.clone()).unwrap();
        let mut journal = Journal::open(path.clone()).unwrap();
        let read = read();
        let q = question(&read, &selector).unwrap();
        let open = opened(&transport, &journal, &selector, &read, None).unwrap();
        assert_eq!(
            open["decision"]["draft"]["pick"],
            Value::Null,
            "suggestion is not consent"
        );
        let draft = draft_answer(
            &journal,
            q,
            &record.source,
            &question_target(&record.source, &selector, q).unwrap(),
            &Answer {
                picks: vec!["option-2".into()],
                text: "  draft\n".into(),
                later: true,
            },
        )
        .unwrap();
        journal.save_attention_draft(draft).unwrap();
        journal.save_attention(record.clone()).unwrap();
        drop(journal);

        let mut journal = Journal::open(path.clone()).unwrap();
        assert_eq!(journal.attention[&record.id], record);
        assert_eq!(answer_state(&record)["state"], "unknown");
        let open = opened(&transport, &journal, &selector, &read, None).unwrap();
        assert_eq!(open["decision"]["draft"]["text"], "  draft\n");
        assert_eq!(open["decision"]["draft"]["picks"], json!(["option-2"]));
        assert_eq!(open["decision"]["draft"]["later"], true);
        let mut changed = read.clone();
        changed["questions"][0]["scope"]["authorityDigest"] = json!("e".repeat(64));
        assert_eq!(
            opened(&transport, &journal, &selector, &changed, None).unwrap()["decision"]["draft"]["text"],
            ""
        );
        let mut wrong = source();
        wrong.home.lineage_id = "another".into();
        assert!(!matches_record(&record, &wrong, &selector));

        let operation = &record.request["operation"];
        let mut ack = json!({"ok":true,"value":{"operationId":operation["operationId"],
            "payloadHash":operation["payloadHash"],"destination":operation["destination"],
            "targetId":operation["targetId"],"state":"accepted","result":{"sessionId":"different"}}});
        assert_eq!(exact_receipt(&record, &ack), Err(Error::Unknown));
        ack["value"]["result"]["sessionId"] = json!("chat");
        let mut wrong = ack.clone();
        wrong["value"]["payloadHash"] = json!("different");
        assert_eq!(exact_receipt(&record, &wrong), Err(Error::Unknown));
        exact_receipt(&record, &ack).unwrap();
        record.receipt = Some(ack);
        journal.save_attention(record.clone()).unwrap();
        drop(journal);
        let journal = Journal::open(path.clone()).unwrap();
        assert_eq!(
            answer_state(&journal.attention[&record.id])["state"],
            "accepted"
        );
        drop(journal);
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn reopened_answer_uses_only_the_saved_receipt_route() {
        check_saved_receipt(record(), selector(), read()).await;
    }

    #[tokio::test]
    async fn reopened_interview_uses_only_the_saved_receipt_route() {
        let (selector, read, answer) = interview();
        let record = answer_record(&read, &selector, &answer.picks, &answer.text);
        check_saved_receipt(record, selector, read).await;
    }

    #[tokio::test]
    async fn reopened_revision_bound_interview_uses_only_the_saved_receipt_route() {
        let (selector, read, answer) = interview();
        let mut record = answer_record(&read, &selector, &answer.picks, &answer.text);
        record.request["draftRevision"] = json!(2);
        bind_answer(&record.source, &record.id, &mut record.request).unwrap();
        record.validate().unwrap();
        let payload: Value =
            serde_json::from_str(record.request["operation"]["payload"].as_str().unwrap()).unwrap();
        assert_eq!(payload["draftRevision"], 2);
        let mut tampered = record.clone();
        tampered.request["draftRevision"] = json!(3);
        assert_eq!(tampered.validate(), Err(Error::Invalid));
        check_saved_receipt(record, selector, read).await;
    }

    fn attention_peer(source: &mut Source) -> (PathBuf, TcpListener) {
        let dir = std::env::temp_dir().join(format!("scoped-check-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        std::fs::write(dir.join("daemon-id"), "daemon").unwrap();
        std::fs::write(dir.join("storage-lineage"), "lineage").unwrap();
        let mut capability = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(dir.join("github-app-capability"))
            .unwrap();
        write!(
            capability,
            "{}",
            json!({"daemonId":"daemon","lineageId":"lineage","token":"a".repeat(64)})
        )
        .unwrap();
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        source.profile = dir.clone();
        source.port = listener.local_addr().unwrap().port();
        (dir, listener)
    }

    fn post(listener: &TcpListener, path: &str) -> (TcpStream, Value) {
        let (stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut first = String::new();
        reader.read_line(&mut first).unwrap();
        assert!(first.starts_with(&format!("POST {path} ")), "{first}");
        let mut size = 0;
        let mut authenticated = false;
        loop {
            let mut line = String::new();
            assert_ne!(reader.read_line(&mut line).unwrap(), 0);
            if line == "\r\n" {
                break;
            }
            let line = line.to_ascii_lowercase();
            if let Some(value) = line.strip_prefix("content-length:") {
                size = value.trim().parse().unwrap();
            }
            if let Some(value) = line.strip_prefix("x-pilot-github-capability:") {
                assert_eq!(value.trim(), "a".repeat(64));
                authenticated = true;
            }
        }
        assert!(authenticated);
        let mut bytes = vec![0; size];
        reader.read_exact(&mut bytes).unwrap();
        (stream, serde_json::from_slice::<Value>(&bytes).unwrap())
    }

    fn respond(mut stream: TcpStream, body: Value) {
        let body = body.to_string();
        write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
    }

    #[tokio::test]
    async fn draft_save_cas_and_ambiguous_readback_use_the_exact_round() {
        let (selector, read, _) = interview();
        let q = question(&read, &selector).unwrap();
        let mut src = source();
        let (dir, listener) = attention_peer(&mut src);
        let t = Transport::new(src.clone()).unwrap();
        let read_request = json!({"version":1,"home":home(&src),"projectId":"other",
            "scope":q["scope"],"kind":"interview-draft","roundId":"round-1"});
        let text = json!({"roundId":"round-1","answers":[
            {"questionId":"detail","selectedOptionId":null,"text":"  中文\n  "}
        ]})
        .to_string();
        let payload = json!({"roundId":"round-1","answers":[
            {"questionId":"detail","questionDigest":"digest-2","selectedOption":null,"text":"  中文\n  "}
        ]});
        let save_request = json!({"version":1,"home":home(&src),"projectId":"other",
            "scope":q["scope"],"kind":"interview-draft-save","expectedRevision":null,"draft":payload});
        let pending = listener.try_clone().unwrap();
        let peer = std::thread::spawn(move || {
            let (stream, body) = post(&listener, "/api/native-attention");
            assert_eq!(body, read_request);
            respond(stream, json!({"ok":true,"value":null}));

            let mut saved = payload;
            saved["revision"] = json!(1);
            let (stream, body) = post(&listener, "/api/native-attention");
            assert_eq!(body, save_request);
            respond(stream, json!({"ok":true,"value":saved}));

            let mut update = save_request;
            update["expectedRevision"] = json!(1);
            let (stream, body) = post(&listener, "/api/native-attention");
            assert_eq!(body, update);
            respond(stream, json!({"ok":false,"error":{"code":"conflict"}}));

            for (revision, answers_match) in [(2, true), (3, true), (2, false)] {
                let (stream, body) = post(&listener, "/api/native-attention");
                assert_eq!(body, update);
                drop(stream); // The save reply was lost.
                let (stream, body) = post(&listener, "/api/native-attention/receipt");
                assert_eq!(body, read_request);
                let mut ack = saved.clone();
                ack["revision"] = json!(revision);
                if !answers_match {
                    ack["answers"][0]["text"] = json!("Other words");
                }
                respond(stream, json!({"ok":true,"value":ack}));
            }
        });
        let live = || Ok(());
        assert!(read_draft(&t, q, false).await.unwrap().is_null());
        assert_eq!(
            save_draft(&t, q, &text, None, live).await.unwrap(),
            draft_not_saved()
        );
        assert_eq!(
            save_draft(&t, q, "", Some(None), live).await.unwrap(),
            draft_not_saved()
        );
        assert_eq!(
            save_draft(&t, q, &text, Some(None), live).await.unwrap(),
            json!({"state":"saved","draftRevision":1})
        );
        assert_eq!(
            save_draft(&t, q, &text, Some(Some(1)), live).await.unwrap(),
            json!({"state":"draft-conflict"})
        );
        assert_eq!(
            save_draft(&t, q, &text, Some(Some(1)), live).await.unwrap(),
            json!({"state":"saved","draftRevision":2})
        );
        for _ in 0..2 {
            assert_eq!(
                save_draft(&t, q, &text, Some(Some(1)), live).await.unwrap(),
                draft_not_saved()
            );
        }
        peer.join().unwrap();
        pending.set_nonblocking(true).unwrap();
        assert_eq!(
            pending.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    async fn check_saved_receipt(mut record: Record, selector: Selector, read: Value) {
        let (dir, listener) = attention_peer(&mut record.source);
        record.request["scopedTarget"] = json!(
            question_target(
                &record.source,
                &selector,
                question(&read, &selector).unwrap(),
            )
            .unwrap()
        );
        let path = dir.join("journal");
        let mut journal = Journal::open(path.clone()).unwrap();
        journal.save_attention(record.clone()).unwrap();
        drop(journal);
        let mut journal = Journal::open(path).unwrap();
        record = journal.attention["op-id"].clone();
        let operation = record.request["operation"].clone();
        let transport = Transport::new(record.source.clone()).unwrap();

        let peer = std::thread::spawn(move || {
            let (stream, body) = post(&listener, "/api/operations/receipt");
            assert_eq!(body, operation);
            respond(
                stream,
                json!({"operationId":operation["operationId"],"payloadHash":operation["payloadHash"],
                "destination":operation["destination"],"targetId":operation["targetId"],
                "state":"accepted","result":{"sessionId":"chat"}}),
            );
        });
        assert_eq!(answer_state(&record)["state"], "unknown");
        receipt(&transport, &mut journal, &mut record, true)
            .await
            .unwrap();
        peer.join().unwrap();
        assert_eq!(
            answer_state(&journal.attention["op-id"])["state"],
            "accepted"
        );
        drop(journal);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn direct_command_rejects_nonordinary_and_unqualified_input() {
        let record = record();
        let mut changed = record.clone();
        changed.request["clarification"] = json!(true);
        assert_eq!(changed.validate(), Err(Error::Invalid));
        changed = record.clone();
        changed.request["operation"]["bindingId"] = json!("bad");
        assert_eq!(changed.validate(), Err(Error::Invalid));
        let value = json!({"kind":"check","selector":selector(),"operationId":"op-id"});
        serde_json::from_value::<Command>(value.clone())
            .unwrap()
            .validate()
            .unwrap();
        let mut value = value;
        value["message"] = json!("never replay");
        assert!(serde_json::from_value::<Command>(value).is_err());
    }

    #[test]
    fn revision_is_optional_but_null_is_not_omission() {
        let (selector, mut read, answer) = interview();
        assert!(!supports_drafts(&read, &selector));
        read["capabilities"]["interviewDrafts"] = json!(1);
        assert!(supports_drafts(&read, &selector));
        assert!(!supports_drafts(&read, &self::selector()));
        let pin =
            question_target(&source(), &selector, question(&read, &selector).unwrap()).unwrap();
        let mut command =
            json!({"kind":"save","target":pin,"answer":{"picks":[],"text":answer.text}});
        for (revision, expected) in [
            (None, None),
            (Some(Value::Null), Some(None)),
            (Some(json!(2)), Some(Some(2))),
        ] {
            if let Some(revision) = revision {
                command["draftRevision"] = revision;
            }
            let parsed: Command = serde_json::from_value(command.clone()).unwrap();
            assert!(parsed.validate().is_ok());
            assert!(
                matches!(parsed, Command::Save { draft_revision, .. } if draft_revision == expected)
            );
        }
        command["kind"] = json!("send");
        command["draftRevision"] = json!(0);
        assert_eq!(
            serde_json::from_value::<Command>(command)
                .unwrap()
                .validate(),
            Err(Error::Invalid)
        );
    }
}
