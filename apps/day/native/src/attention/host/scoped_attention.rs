//! Direct answers share the root worker and its only journal.
//! The focused project and its cached attention read are not routing authority.
use super::{Draft, DraftKey, Record, bind_answer, canonical, digest, exact, home, snapshot};
use crate::{
    attention_host as cards, attention_interview,
    host::{Error, Journal, Shared, Source, Transport, new_chat, valid_id},
    model::OutcomeStatus,
};
use serde::{Deserialize, Serialize};
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
    },
    Send {
        target: Target,
        answer: Answer,
    },
    Check {
        selector: Selector,
        operation_id: String,
    },
    Recover {
        target: Target,
    },
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
            Self::Save { target, answer } | Self::Send { target, answer } => {
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
    } else {
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
        draft.value =
            json!({"pick":null,"picks":[],"text":answer.text,"question":"","later":false});
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

fn opened(
    t: &Transport,
    journal: &Journal,
    selector: &Selector,
    read: &Value,
) -> Result<Value, Error> {
    let q = question(read, selector)?;
    let pin = question_target(&t.source, selector, q)?;
    let draft = draft(journal, &t.source, scoped_key(q, &pin)?);
    let card_key = cards::question_key(q).ok_or(Error::Invalid)?;
    // Project this card with the existing form and draft contract. The direct
    // route does not offer clarification, artifact opens, or chat navigation.
    let read = json!({"current":true,"questions":[q]});
    let mut view = cards::project(
        Some(&read),
        &[],
        &[(card_key, draft.value)],
        &[],
        &cards::Local::default(),
    );
    let decision = view.decisions.first_mut().ok_or(Error::Invalid)?;
    decision.artifacts.clear();
    decision.request_session_id.clear();
    Ok(json!({"state":"ready","target":pin,"decision":decision}))
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
            opened(&t, journal, selector, &read)
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
        Command::Save { target, answer } | Command::Send { target, answer } => {
            if let Some(record) = pending() {
                return Ok(answer_state(record));
            }
            live()?;
            let read = snapshot(&t).await?;
            let q = exact_question(&t.source, &read, target)?;
            live()?;
            let draft = draft_answer(journal, q, &t.source, target, answer)?;
            journal.save_attention_draft(draft)?;
            if matches!(command, Command::Save { .. }) {
                return Ok(json!({"state":"saved"}));
            }
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
        let opened_round = opened(&t, &journal, &selector, &read).unwrap();
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
        let restored = opened(&t, &journal, &selector, &read).unwrap();
        assert_eq!(
            restored["decision"]["interviewQuestions"][0]["selectedOptionId"],
            "keep"
        );
        assert_eq!(
            restored["decision"]["interviewQuestions"][1]["text"],
            "  中文\n  "
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
        let open = opened(&transport, &journal, &selector, &read).unwrap();
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
        let open = opened(&transport, &journal, &selector, &read).unwrap();
        assert_eq!(open["decision"]["draft"]["text"], "  draft\n");
        assert_eq!(open["decision"]["draft"]["picks"], json!(["option-2"]));
        assert_eq!(open["decision"]["draft"]["later"], true);
        let mut changed = read.clone();
        changed["questions"][0]["scope"]["authorityDigest"] = json!("e".repeat(64));
        assert_eq!(
            opened(&transport, &journal, &selector, &changed).unwrap()["decision"]["draft"]["text"],
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

    async fn check_saved_receipt(mut record: Record, selector: Selector, read: Value) {
        use std::{
            io::{BufRead, BufReader, Read, Write},
            os::unix::fs::OpenOptionsExt,
        };
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
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        record.source.profile = dir.clone();
        record.source.port = listener.local_addr().unwrap().port();
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
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(2)))
                .unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut first = String::new();
            reader.read_line(&mut first).unwrap();
            assert!(first.starts_with("POST /api/operations/receipt "));
            let mut size = 0;
            loop {
                let mut line = String::new();
                assert_ne!(reader.read_line(&mut line).unwrap(), 0);
                if line == "\r\n" {
                    break;
                }
                if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                    size = value.trim().parse().unwrap();
                }
            }
            let mut bytes = vec![0; size];
            reader.read_exact(&mut bytes).unwrap();
            assert_eq!(serde_json::from_slice::<Value>(&bytes).unwrap(), operation);
            let body = json!({"operationId":operation["operationId"],"payloadHash":operation["payloadHash"],
                "destination":operation["destination"],"targetId":operation["targetId"],
                "state":"accepted","result":{"sessionId":"chat"}}).to_string();
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
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
}
