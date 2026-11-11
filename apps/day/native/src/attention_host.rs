//! Maps the trusted native host's attention read (the daemon's exact
//! NativeAttentionRead: agents' ordinary questions and human actions, with
//! their authority digests and capabilities; see
//! docs/technical/day-native-host.md) to Today's decision and action cards,
//! and the cards' intents to exact host requests. Pure functions: the host
//! keeps transport, credentials, operation IDs, saved drafts and receipts.
//!
//! Nothing here completes, answers or resumes anything on its own. An
//! acknowledged receipt is the only success; a lost one stays unknown and
//! only an exact lookup settles it. Help and continuation that the daemon
//! reports unavailable stay unavailable.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Value, json};

use crate::{
    host::attention::DraftKey,
    model::{
        ActionAsk, ActionFile, ActionState, Answer, AnswerState, Decision, DecisionKind,
        DecisionOption, Delivery, Destination, Draft, DraftIntent, Freshness, FreshnessState,
        HumanAction, Origin, OutcomeStatus,
    },
};

/// The longest answer the daemon takes, in UTF-16 code units.
pub const REPLY_LIMIT: usize = 8000;

/// The largest draft the host saves, in JSON bytes.
pub const DRAFT_LIMIT: usize = 16384;

/// Said when the daemon has no help producer.
pub const NO_HELP: &str = "Simpler words, charts and questions are not available here yet.";

/// What a request on its way asks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Sending {
    /// An answer, with the options it carries, if any.
    Answer(Vec<String>),
    /// An action request.
    Action(ActionAsk),
}

/// What the feed is doing now, which the read cannot say. Kept for this run
/// of the app only; saved drafts and receipts live in the host.
#[derive(Debug, Clone, Default)]
pub struct Local {
    /// Items whose request is on its way.
    pub sending: BTreeMap<String, Sending>,
    /// Items and help questions whose exact lookup is on its way.
    pub checking: BTreeSet<String>,
    /// Questions about a decision on their way, by decision.
    pub asking: BTreeMap<String, String>,
    /// Decisions the user put off in this run, oldest first. Not sent. The
    /// Later itself is saved with each question's draft.
    pub later: Vec<String>,
    /// Confirmed results of the user's own requests in this run.
    pub notes: Vec<String>,
    /// Drafts not saved yet, by draft key.
    pub dirty: BTreeMap<String, (DraftKey, Value)>,
    /// Draft keys whose last save failed.
    pub unsaved: BTreeSet<String>,
    /// Why the last attention read failed, until one succeeds.
    pub read_error: Option<String>,
    /// Bumps on every change above.
    pub revision: u32,
}

impl Local {
    /// Records a change, so the screen hears of it.
    pub fn touch(&mut self) {
        self.revision = self.revision.wrapping_add(1);
    }
}

/// Why an intent was refused before anything was sent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refusal {
    /// Stale or rejected.
    pub status: OutcomeStatus,
    /// One sentence for the user.
    pub message: &'static str,
}

const GONE: Refusal = Refusal {
    status: OutcomeStatus::Stale,
    message: "This is no longer waiting. Nothing was sent.",
};
const CHANGED: Refusal = Refusal {
    status: OutcomeStatus::Stale,
    message: "Pilot changed this since you read it. Nothing was sent; your words stay.",
};
const NOT_AN_OPTION: Refusal = Refusal {
    status: OutcomeStatus::Rejected,
    message: "That answer is not one of the options.",
};
const ONE_ONLY: Refusal = Refusal {
    status: OutcomeStatus::Rejected,
    message: "This question takes one answer. Pick one, or say more in your own words.",
};

/// The cards Today shows from one read.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct View {
    /// Agents' questions, and answers that were not confirmed.
    pub decisions: Vec<Decision>,
    /// Actions only the user can take.
    pub actions: Vec<HumanAction>,
    /// How fresh the read is.
    pub attention: Freshness,
}

fn s(v: &Value) -> String {
    v.as_str().unwrap_or_default().to_owned()
}

fn arr(v: &Value) -> &[Value] {
    v.as_array().map_or(&[], Vec::as_slice)
}

fn subject_id(subject: &Value) -> Option<String> {
    if subject["kind"] != "question" {
        return None;
    }
    let session = subject["sessionId"].as_str()?;
    let entry = subject["entryId"].as_u64()?;
    Some(format!("question-{session}-{entry}"))
}

/// The card id of an ordinary question: its chat and entry. An entry never
/// changes, so a question has one revision.
pub fn question_id(question: &Value) -> Option<String> {
    subject_id(&question["scope"]["subject"])
}

/// The card a saved request is about, if it is an answer or a help question.
fn request_question(request: &Value) -> Option<String> {
    match request["kind"].as_str() {
        Some("answer") => subject_id(&request["scope"]["subject"]),
        Some("help") => subject_id(&request["request"]["scope"]["subject"]),
        _ => None,
    }
}

fn request_action(request: &Value) -> Option<String> {
    (request["kind"] == "action").then(|| s(&request["command"]["expected"]["id"]))
}

/// The question card "id" in "read".
pub fn find_question<'a>(read: &'a Value, id: &str) -> Option<&'a Value> {
    arr(&read["questions"])
        .iter()
        .find(|q| question_id(q).as_deref() == Some(id))
}

/// Whether a question takes several options together. The agent's ask_user
/// tool says so only when it offers more than one.
pub fn takes_several(question: &Value) -> bool {
    question["question"]["multiSelect"] == true && arr(&question["question"]["options"]).len() > 1
}

/// The position of option card id "option-<n>", counted from 0.
fn option_index(option: &str) -> Option<usize> {
    option
        .strip_prefix("option-")
        .and_then(|n| n.parse::<usize>().ok())
        .filter(|n| *n > 0)
        .map(|n| n - 1)
}

/// The action "id" in "read", with its authority digest.
pub fn find_action<'a>(read: &'a Value, id: &str) -> Option<&'a Value> {
    arr(&read["actions"])
        .iter()
        .find(|a| a["record"]["id"] == id)
}

/// Where a question's draft is saved: its card, revision 1 and the
/// backend's own content digest.
pub fn question_key(question: &Value) -> Option<DraftKey> {
    let digest = question["scope"]["contentDigest"].as_str()?;
    Some(DraftKey {
        kind: "question".into(),
        id: question_id(question)?,
        revision: 1,
        digest: digest.into(),
    })
}

/// Where an action's draft is saved: its exact revision and digest. A
/// replaced action has a new key; the old draft is history.
pub fn action_key(action: &Value) -> Option<DraftKey> {
    let record = &action["record"];
    Some(DraftKey {
        kind: "action".into(),
        id: record["id"].as_str()?.into(),
        revision: record["revision"].as_u64()?,
        digest: record["digest"].as_str()?.into(),
    })
}

/// A draft key as a map key.
pub fn key_string(key: &DraftKey) -> String {
    serde_json::to_string(key).unwrap_or_default()
}

/// The saved form of a draft. Several picks and Later are written only when
/// set, so other drafts keep the form earlier Day versions saved.
pub fn draft_value(draft: &Draft) -> Value {
    let mut value = json!({ "pick": draft.pick, "text": draft.text, "question": draft.question });
    if !draft.picks.is_empty() {
        value["picks"] = json!(draft.picks);
    }
    if draft.later {
        value["later"] = json!(true);
    }
    value
}

/// The draft "intent" saves under "key". A question keeps a Later saved
/// before ("before"): only a sent answer clears it. An action takes no picks
/// and no Later, since its own Later is a request to the daemon.
pub fn draft_from(key: &DraftKey, intent: &DraftIntent, before: Option<&Value>) -> Draft {
    let question = key.kind == "question";
    Draft {
        pick: intent.pick.clone(),
        picks: if question {
            intent.picks.clone()
        } else {
            Vec::new()
        },
        text: intent.text.clone(),
        question: intent.question.clone(),
        later: question && (intent.later || before.is_some_and(|v| v["later"] == true)),
        unsaved: false,
    }
}

fn draft_of(value: &Value, unsaved: bool) -> Draft {
    Draft {
        pick: value["pick"].as_str().map(str::to_owned),
        picks: arr(&value["picks"])
            .iter()
            .filter_map(|p| p.as_str().map(str::to_owned))
            .collect(),
        text: s(&value["text"]),
        question: s(&value["question"]),
        later: value["later"] == true,
        unsaved,
    }
}

/// The options an answer's message names, the way answer_request writes
/// them: one label, or "- label" lines on a question that takes several,
/// before any words of the user's own. Empty when it names none.
fn sent_picks(message: &str, options: &[DecisionOption], several: bool) -> Vec<String> {
    let head = message.split("\n\n").next().unwrap_or_default();
    if let Some(o) = options.iter().find(|o| o.label == head) {
        return vec![o.id.clone()];
    }
    if !several {
        return Vec::new();
    }
    let mut ids = Vec::new();
    for line in head.split('\n') {
        let found = line
            .strip_prefix("- ")
            .and_then(|label| options.iter().find(|o| o.label == label));
        match found {
            Some(o) if !ids.contains(&o.id) => ids.push(o.id.clone()),
            _ => return Vec::new(),
        }
    }
    if ids.len() < 2 { Vec::new() } else { ids }
}

/// The unsettled operation of an answer to question card "id".
pub fn pending_answer<'a>(ops: &'a [Value], id: &str) -> Option<&'a Value> {
    ops.iter().find(|op| {
        op["state"] == "unknown"
            && op["request"]["kind"] == "answer"
            && request_question(&op["request"]).as_deref() == Some(id)
    })
}

/// The unsettled operation of a request on action "id". Navigation is not
/// one: it changes nothing and has no receipt to look up.
pub fn pending_action<'a>(ops: &'a [Value], id: &str) -> Option<&'a Value> {
    ops.iter().find(|op| {
        op["state"] == "unknown" && request_action(&op["request"]).as_deref() == Some(id)
    })
}

/// Whether an answer to exactly this question was acknowledged as accepted.
fn answered(ops: &[Value], scope: &Value) -> bool {
    ops.iter().any(|op| {
        op["state"] == "acknowledged"
            && op["request"]["kind"] == "answer"
            && op["request"]["scope"] == *scope
            && op["receipt"]["ok"] == true
            && op["receipt"]["value"]["state"] == "accepted"
    })
}

fn ask_of(kind: &Value) -> ActionAsk {
    match kind.as_str() {
        Some("complete") => ActionAsk::Complete,
        Some("defer") => ActionAsk::Later,
        _ => ActionAsk::Progress,
    }
}

fn short(digest: &str) -> String {
    if digest.len() < 12 || !digest.is_ascii() {
        return digest.to_owned();
    }
    format!("sha256 {}…{}", &digest[..4], &digest[digest.len() - 4..])
}

fn host_of(uri: &str) -> String {
    uri.split_once("://")
        .map(|(_, rest)| rest.split(['/', '?', '#']).next().unwrap_or(rest))
        .unwrap_or(uri)
        .to_owned()
}

fn file(f: &Value) -> ActionFile {
    if f["kind"] == "artifact" {
        return ActionFile {
            name: format!("Artifact {}", s(&f["artifactId"])),
            version: format!("revision {}", f["revision"]),
            digest: short(&s(&f["sha256"])),
        };
    }
    let uri = s(&f["uri"]);
    let name = uri.rsplit('/').next().unwrap_or(&uri).to_owned();
    ActionFile {
        name,
        version: s(&f["version"]),
        digest: short(&s(&f["sha256"])),
    }
}

/// Drafts by key: saved ones, then unsaved local ones over them.
fn drafts_by_key(saved: &[(DraftKey, Value)], local: &Local) -> BTreeMap<String, Value> {
    let mut all: BTreeMap<String, Value> = saved
        .iter()
        .map(|(k, v)| (key_string(k), v.clone()))
        .collect();
    for (k, (_, v)) in &local.dirty {
        all.insert(k.clone(), v.clone());
    }
    all
}

/// Words written on an earlier revision of action "id", newest first.
fn earlier(
    saved: &[(DraftKey, Value)],
    local: &Local,
    all: &BTreeMap<String, Value>,
    id: &str,
    revision: u64,
) -> Option<String> {
    let mut keys: Vec<&DraftKey> = saved
        .iter()
        .map(|(k, _)| k)
        .chain(local.dirty.values().map(|(k, _)| k))
        .filter(|k| k.kind == "action" && k.id == id && k.revision < revision)
        .collect();
    keys.sort_by_key(|k| std::cmp::Reverse(k.revision));
    keys.into_iter()
        .filter_map(|k| all.get(&key_string(k)))
        .map(|v| s(&v["text"]))
        .find(|t| !t.trim().is_empty())
}

fn help_answers(ops: &[Value], id: &str, local: &Local) -> Vec<Answer> {
    let mut answers: Vec<Answer> = ops
        .iter()
        .filter(|op| {
            op["state"] != "not-sent"
                && op["request"]["kind"] == "help"
                && op["request"]["request"]["kind"] == "question"
                && request_question(&op["request"]).as_deref() == Some(id)
        })
        .map(|op| {
            let receipt = &op["receipt"];
            let op_id = s(&op["id"]);
            let (state, answer) = if local.checking.contains(&op_id) {
                (AnswerState::Checking, String::new())
            } else if op["state"] == "unknown" {
                (AnswerState::Unknown, String::new())
            } else if receipt["ok"] == true && receipt["value"]["state"] == "ready" {
                (AnswerState::Ready, s(&receipt["value"]["output"]["answer"]))
            } else if receipt["ok"] == true && receipt["value"]["state"] == "entered" {
                (AnswerState::Asking, String::new())
            } else {
                (
                    AnswerState::Ready,
                    "Pilot could not answer this question.".to_owned(),
                )
            };
            Answer {
                id: op_id,
                question: s(&op["request"]["request"]["question"]),
                answer,
                state,
                earlier: false,
            }
        })
        .collect();
    if let Some(question) = local.asking.get(id) {
        answers.push(Answer {
            id: "asking".into(),
            question: question.clone(),
            ..Answer::default()
        });
    }
    answers
}

fn freshness(read: Option<&Value>, local: &Local) -> Freshness {
    match read {
        None => match &local.read_error {
            Some(reason) => Freshness {
                state: FreshnessState::Unavailable,
                age: String::new(),
                reason: reason.clone(),
            },
            None => Freshness {
                state: FreshnessState::Unreadable,
                age: String::new(),
                reason: "Pilot has not read what needs you yet.".into(),
            },
        },
        Some(r) if r["current"] == true => Freshness::default(),
        Some(_) => Freshness {
            state: FreshnessState::Stale,
            age: String::new(),
            reason:
                "What needs you may have changed. Pilot reads it again before it sends anything."
                    .into(),
        },
    }
}

/// The cards from one read. "read" is the host's attention snapshot, "ops"
/// its operation summaries, "saved" its drafts and "missions" the missions'
/// ids and titles from Today.
pub fn project(
    read: Option<&Value>,
    ops: &[Value],
    saved: &[(DraftKey, Value)],
    missions: &[(String, String)],
    local: &Local,
) -> View {
    let attention = freshness(read, local);
    let empty = json!({});
    let read = read.unwrap_or(&empty);
    let live = attention.state == FreshnessState::Live;
    let help = (read["capabilities"]["help"] != 1).then(|| NO_HELP.to_owned());
    let drafts = drafts_by_key(saved, local);
    let title = |mission: &Value| {
        missions
            .iter()
            .find(|(id, _)| mission.as_str() == Some(id))
            .map(|(_, t)| t.clone())
    };
    let draft_for = |key: Option<DraftKey>| {
        key.and_then(|k| {
            let ks = key_string(&k);
            drafts
                .get(&ks)
                .map(|v| draft_of(v, local.unsaved.contains(&ks)))
        })
        .unwrap_or_default()
    };

    let mut decisions = Vec::new();
    for q in arr(&read["questions"]) {
        let Some(id) = question_id(q) else { continue };
        let pending = pending_answer(ops, &id);
        if pending.is_none() && !local.sending.contains_key(&id) && answered(ops, &q["scope"]) {
            continue;
        }
        let data = &q["question"];
        let several = takes_several(q);
        let mut options: Vec<DecisionOption> = arr(&data["options"])
            .iter()
            .enumerate()
            .map(|(n, o)| DecisionOption {
                id: format!("option-{}", n + 1),
                label: s(&o["label"]),
                detail: s(&o["detail"]),
                // A question that takes several may suggest several.
                recommended: several && o["suggested"] == true,
            })
            .collect();
        if !several
            && let Some(n) = arr(&data["options"])
                .iter()
                .position(|o| o["suggested"] == true)
        {
            options[n].recommended = true;
        }
        let chat = s(&q["session"]["title"]);
        let sent = match local.sending.get(&id) {
            Some(Sending::Answer(picks)) => options
                .iter()
                .filter(|o| picks.contains(&o.id))
                .map(|o| o.id.clone())
                .collect(),
            _ => pending
                .map(|op| sent_picks(&s(&op["request"]["message"]), &options, several))
                .unwrap_or_default(),
        };
        let delivery = if local.sending.contains_key(&id) {
            Delivery::Sending
        } else if local.checking.contains(&id) {
            Delivery::Checking
        } else if pending.is_some() {
            Delivery::Unknown
        } else {
            Delivery::Idle
        };
        decisions.push(Decision {
            revision: 1,
            kind: DecisionKind::Choice,
            title: s(&data["question"]),
            reason: "Asks for your answer".into(),
            mission_id: s(&q["session"]["missionId"]),
            mission_title: title(&q["session"]["missionId"]).unwrap_or_else(|| chat.clone()),
            context: s(&data["context"]),
            boundary: format!(
                "Only you can answer. Pilot sends your answer to “{chat}” once, exactly as you write it."
            ),
            options,
            answers: help_answers(ops, &id, local),
            delivery,
            sent_option: if several {
                None
            } else {
                sent.first().cloned()
            },
            sent_options: if several { sent } else { Vec::new() },
            multiple: several,
            reply: true,
            help_unavailable: help.clone(),
            draft: draft_for(question_key(q)),
            id,
            ..Decision::default()
        });
    }
    // An answer whose question left the read stays until a lookup settles it.
    for op in ops
        .iter()
        .filter(|op| op["state"] == "unknown" && op["request"]["kind"] == "answer")
    {
        let Some(id) = request_question(&op["request"]) else {
            continue;
        };
        if decisions.iter().any(|d| d.id == id) {
            continue;
        }
        decisions.push(Decision {
            revision: 1,
            kind: DecisionKind::Unknown,
            title: "Your answer was not confirmed".into(),
            reason: "Not confirmed".into(),
            context: format!(
                "You answered: “{}”. Pilot heard nothing back and will not send it again.",
                s(&op["request"]["message"])
            ),
            boundary: "Check again only reads the saved answer; it never sends it twice.".into(),
            delivery: if local.checking.contains(&id) {
                Delivery::Checking
            } else {
                Delivery::Unknown
            },
            help_unavailable: Some(NO_HELP.into()),
            id,
            ..Decision::default()
        });
    }
    // Questions put off go last: those saved before this run first, then
    // this run's, oldest first. Nothing about it is sent.
    decisions.sort_by_key(|d| match local.later.iter().position(|id| *id == d.id) {
        Some(n) => n + 2,
        None => usize::from(d.draft.later),
    });

    let chat_title = |session: &Value| {
        arr(&read["questions"])
            .iter()
            .find(|q| q["session"]["id"] == *session)
            .map(|q| s(&q["session"]["title"]))
            .unwrap_or_else(|| "The chat that asked".to_owned())
    };
    let mut actions = Vec::new();
    for a in arr(&read["actions"]) {
        let r = &a["record"];
        let id = s(&r["id"]);
        let pending = pending_action(ops, &id);
        let waiting = matches!(r["state"].as_str(), Some("pending" | "deferred"));
        if !waiting && pending.is_none() && !local.sending.contains_key(&id) {
            continue;
        }
        let c = &r["content"];
        let revision = r["revision"].as_u64().unwrap_or(0);
        let earlier_report = earlier(saved, local, &drafts, &id, revision);
        let (delivery, asked) = match (local.sending.get(&id), pending) {
            (Some(Sending::Action(ask)), _) => (Delivery::Sending, Some(*ask)),
            (_, Some(op)) if local.checking.contains(&id) => (
                Delivery::Checking,
                Some(ask_of(&op["request"]["command"]["kind"])),
            ),
            (_, Some(op)) => (
                Delivery::Unknown,
                Some(ask_of(&op["request"]["command"]["kind"])),
            ),
            _ => (Delivery::Idle, None),
        };
        let destination = &c["destination"];
        actions.push(HumanAction {
            revision: u32::try_from(revision).unwrap_or(u32::MAX),
            title: s(&c["action"]),
            why: s(&c["reason"]),
            files: arr(&c["files"]).iter().map(file).collect(),
            destination: Destination {
                label: host_of(&s(&destination["uri"])),
                link: s(&destination["uri"]),
                target: [s(&destination["targetId"]), s(&destination["version"])]
                    .into_iter()
                    .filter(|p| !p.is_empty())
                    .collect::<Vec<_>>()
                    .join(" "),
            },
            origin: Origin {
                chat_title: chat_title(&c["sessionId"]),
                chat_link: format!("pilot://chat/{}", s(&c["sessionId"])),
                mission_title: title(&c["missionId"]).unwrap_or_default(),
            },
            needs: arr(&c["completionRequirements"]).iter().map(s).collect(),
            progress: s(&r["progress"]),
            state: if r["state"] == "deferred" {
                ActionState::Deferred
            } else {
                ActionState::Pending
            },
            replaced: earlier_report.as_ref().map(|_| {
                "Pilot changed this request after you wrote here. Read it again before you report."
                    .to_owned()
            }),
            delivery,
            asked,
            draft: draft_for(action_key(a)),
            earlier_report,
            can_open: live && read["canOpenUrl"] == true && waiting,
            id,
            ..HumanAction::default()
        });
    }
    for op in ops
        .iter()
        .filter(|op| op["state"] == "unknown" && op["request"]["kind"] == "action")
    {
        let Some(id) = request_action(&op["request"]) else {
            continue;
        };
        if actions.iter().any(|a| a.id == id) {
            continue;
        }
        actions.push(HumanAction {
            revision: op["request"]["command"]["expected"]["revision"]
                .as_u64()
                .and_then(|r| u32::try_from(r).ok())
                .unwrap_or(0),
            title: "A request Pilot could not confirm".into(),
            why: "Pilot sent your request but heard nothing back. It will not send it again."
                .into(),
            delivery: if local.checking.contains(&id) {
                Delivery::Checking
            } else {
                Delivery::Unknown
            },
            asked: Some(ask_of(&op["request"]["command"]["kind"])),
            id,
            ..HumanAction::default()
        });
    }
    actions.sort_by_key(|a| a.state == ActionState::Deferred);
    View {
        decisions,
        actions,
        attention,
    }
}

/// The answer to question card "id": the picked option's label, then the
/// user's own words, exactly as typed, the way the chat composers send it.
/// A question that takes several lists every picked label as "- label"
/// lines, in the order shown; one pick is sent as its label alone.
pub fn answer_request(
    read: &Value,
    id: &str,
    picks: &[String],
    text: &str,
) -> Result<Value, Refusal> {
    let q = find_question(read, id).ok_or(GONE)?;
    let options = arr(&q["question"]["options"]);
    let mut picked: Vec<usize> = Vec::new();
    for option in picks.iter().filter(|o| !o.is_empty()) {
        let n = option_index(option)
            .filter(|n| *n < options.len())
            .ok_or(NOT_AN_OPTION)?;
        if !picked.contains(&n) {
            picked.push(n);
        }
    }
    if picked.len() > 1 && !takes_several(q) {
        return Err(ONE_ONLY);
    }
    picked.sort_unstable();
    let labels = picked
        .iter()
        .map(|n| options[*n]["label"].as_str().ok_or(NOT_AN_OPTION))
        .collect::<Result<Vec<_>, _>>()?;
    let label = match labels.as_slice() {
        [] => None,
        [one] => Some((*one).to_owned()),
        many => Some(
            many.iter()
                .map(|l| format!("- {l}"))
                .collect::<Vec<_>>()
                .join("\n"),
        ),
    };
    let own = (!text.trim().is_empty()).then_some(text);
    let message = match (label, own) {
        (Some(label), Some(own)) => format!("{label}\n\n{own}"),
        (Some(label), None) => label,
        (None, Some(own)) => own.to_owned(),
        (None, None) => {
            return Err(Refusal {
                status: OutcomeStatus::Rejected,
                message: "Pick an answer or write one first.",
            });
        }
    };
    if message.encode_utf16().count() > REPLY_LIMIT {
        return Err(Refusal {
            status: OutcomeStatus::Rejected,
            message: "Keep the answer under 8,000 characters. It stays here.",
        });
    }
    Ok(json!({ "kind": "answer", "scope": q["scope"], "message": message }))
}

/// A help question about question card "id". Only sent when the daemon
/// reports a help producer.
pub fn help_request(read: &Value, id: &str, question: &str) -> Result<Value, Refusal> {
    let q = find_question(read, id).ok_or(GONE)?;
    if read["capabilities"]["help"] != 1 {
        return Err(Refusal {
            status: OutcomeStatus::Rejected,
            message: "Pilot cannot answer questions here yet. Nothing was sent; your question stays.",
        });
    }
    if question.trim().is_empty() {
        return Err(Refusal {
            status: OutcomeStatus::Rejected,
            message: "Write a question first.",
        });
    }
    Ok(json!({
        "kind": "help",
        "request": { "scope": q["scope"], "kind": "question", "question": question },
    }))
}

fn shown<'a>(read: &'a Value, id: &str, revision: u32) -> Result<&'a Value, Refusal> {
    let a = find_action(read, id).ok_or(GONE)?;
    if a["record"]["revision"].as_u64() != Some(u64::from(revision)) {
        return Err(CHANGED);
    }
    Ok(a)
}

fn expected(a: &Value) -> Value {
    let r = &a["record"];
    json!({ "id": r["id"], "revision": r["revision"], "digest": r["digest"] })
}

/// A progress, Later or completion request on action "id" at the revision
/// shown. Later keeps the saved progress exactly; it never erases it.
pub fn action_request(
    read: &Value,
    id: &str,
    revision: u32,
    ask: ActionAsk,
    text: &str,
) -> Result<Value, Refusal> {
    let a = shown(read, id, revision)?;
    let state = a["record"]["state"].as_str();
    if !matches!(state, Some("pending" | "deferred")) {
        return Err(GONE);
    }
    let command = match ask {
        ActionAsk::Progress => {
            if text.trim().is_empty() {
                return Err(Refusal {
                    status: OutcomeStatus::Rejected,
                    message: "Write your progress first.",
                });
            }
            json!({ "kind": "progress", "expected": expected(a), "progress": text })
        }
        ActionAsk::Later => {
            if state == Some("deferred") {
                return Err(Refusal {
                    status: OutcomeStatus::Rejected,
                    message: "This action is already put off.",
                });
            }
            json!({ "kind": "defer", "expected": expected(a), "progress": a["record"]["progress"] })
        }
        ActionAsk::Complete => {
            let needs = !arr(&a["record"]["content"]["completionRequirements"]).is_empty();
            if needs && text.trim().is_empty() {
                return Err(Refusal {
                    status: OutcomeStatus::Rejected,
                    message: "Say what you did first. Pilot needs it to go on.",
                });
            }
            json!({ "kind": "complete", "expected": expected(a), "report": text })
        }
    };
    Ok(json!({ "kind": "action", "authorityDigest": a["authorityDigest"], "command": command }))
}

/// Permission to open action "id"'s destination. The host rechecks it and
/// opens only the pinned link; opening reports nothing.
pub fn resource_request(read: &Value, id: &str, revision: u32) -> Result<Value, Refusal> {
    let a = shown(read, id, revision)?;
    if read["canOpenUrl"] != true {
        return Err(Refusal {
            status: OutcomeStatus::Rejected,
            message: "Pilot cannot open links here. Copy the link instead; nothing was sent.",
        });
    }
    Ok(
        json!({ "kind": "resource", "expected": expected(a), "authorityDigest": a["authorityDigest"] }),
    )
}

/// Where the draft for item "id" at "revision" is saved.
pub fn draft_key(read: &Value, id: &str, revision: u32) -> Result<DraftKey, Refusal> {
    if let Some(q) = find_question(read, id) {
        if revision != 1 {
            return Err(CHANGED);
        }
        return question_key(q).ok_or(GONE);
    }
    action_key(shown(read, id, revision)?).ok_or(GONE)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(pick: Option<&str>, text: &str, question: &str) -> Value {
        draft_value(&Draft {
            pick: pick.map(str::to_owned),
            text: text.into(),
            question: question.into(),
            ..Draft::default()
        })
    }

    fn picks(ids: &[&str]) -> Vec<String> {
        ids.iter().map(|id| (*id).to_owned()).collect()
    }

    fn read() -> Value {
        json!({
            "version": 1, "projectId": "p", "current": true, "canOpenUrl": false,
            "capabilities": { "help": "unavailable", "continuation": "unavailable" },
            "questions": [{
                "scope": { "subject": { "kind": "question", "sessionId": "s1", "entryId": 12 },
                    "projectId": "p", "eventId": 12, "contentDigest": "c".repeat(64), "authorityDigest": "a".repeat(64) },
                "question": { "question": "Which package?", "context": "Use the reviewed bytes.",
                    "options": [{ "label": "Reviewed package", "suggested": true }, { "label": "Rebuild" }] },
                "session": { "id": "s1", "title": "Release chat", "missionId": "m1", "inputGeneration": 0 },
            }],
            "actions": [{
                "authorityDigest": "b".repeat(64),
                "record": { "id": "upload", "revision": 2, "digest": "d".repeat(64), "state": "pending", "progress": "half",
                    "completion": null,
                    "content": { "projectId": "p", "sessionId": "s1", "missionId": "m1", "action": "Upload reviewed.zip",
                        "reason": "Browser upload requires the user",
                        "files": [{ "kind": "file", "uri": "file:///w/reviewed.zip", "version": "1.0", "sha256": "e".repeat(64) }],
                        "destination": { "uri": "https://example.com/developer/upload", "targetId": "package", "version": "1.0" },
                        "completionRequirements": ["Report submission, not publication."] } },
            }],
        })
    }

    fn missions() -> Vec<(String, String)> {
        vec![("m1".into(), "Release".into())]
    }

    #[test]
    fn a_read_becomes_cards_with_help_unavailable() {
        let view = project(Some(&read()), &[], &[], &missions(), &Local::default());
        assert_eq!(view.attention.state, FreshnessState::Live);
        let d = &view.decisions[0];
        assert_eq!(d.id, "question-s1-12");
        assert_eq!(d.mission_title, "Release");
        assert!(d.reply);
        assert_eq!(d.help_unavailable.as_deref(), Some(NO_HELP));
        assert!(d.options[0].recommended && !d.options[1].recommended);
        let a = &view.actions[0];
        assert_eq!((a.revision, a.title.as_str()), (2, "Upload reviewed.zip"));
        assert_eq!(a.destination.label, "example.com");
        assert_eq!(a.destination.target, "package 1.0");
        assert_eq!(a.files[0].name, "reviewed.zip");
        assert_eq!(a.origin.chat_title, "Release chat");
        assert!(!a.can_open);
    }

    #[test]
    fn no_read_is_never_an_empty_success() {
        let view = project(None, &[], &[], &[], &Local::default());
        assert_eq!(view.attention.state, FreshnessState::Unreadable);
        let local = Local {
            read_error: Some("No attention read.".into()),
            ..Local::default()
        };
        let view = project(None, &[], &[], &[], &local);
        assert_eq!(view.attention.state, FreshnessState::Unavailable);
        let mut stale = read();
        stale["current"] = json!(false);
        let view = project(Some(&stale), &[], &[], &[], &Local::default());
        assert_eq!(view.attention.state, FreshnessState::Stale);
        assert_eq!(view.decisions.len(), 1);
    }

    #[test]
    fn drafts_belong_to_their_exact_revision_and_earlier_ones_are_history() {
        let r = read();
        let current = action_key(&r["actions"][0]).unwrap();
        let mut old = current.clone();
        old.revision = 1;
        old.digest = "f".repeat(64);
        let saved = vec![
            (old, words(None, "Uploaded 0.9", "")),
            (current, words(None, "  exact\n日本  ", "")),
            (
                question_key(&r["questions"][0]).unwrap(),
                words(Some("option-2"), "why", "q?"),
            ),
        ];
        let view = project(Some(&r), &[], &saved, &[], &Local::default());
        assert_eq!(view.actions[0].draft.text, "  exact\n日本  ");
        assert_eq!(
            view.actions[0].earlier_report.as_deref(),
            Some("Uploaded 0.9")
        );
        assert!(view.actions[0].replaced.is_some());
        assert_eq!(view.decisions[0].draft.pick.as_deref(), Some("option-2"));
        assert_eq!(view.decisions[0].draft.question, "q?");
        assert_eq!(draft_key(&r, "upload", 1), Err(CHANGED));
        assert_eq!(draft_key(&r, "question-s1-12", 2), Err(CHANGED));
    }

    #[test]
    fn unsettled_answers_stay_unknown_even_after_their_question_leaves() {
        let r = read();
        let request = answer_request(&r, "question-s1-12", &picks(&["option-1"]), "").unwrap();
        let ops =
            vec![json!({ "id": "op", "request": request, "receipt": null, "state": "unknown" })];
        let view = project(Some(&r), &ops, &[], &[], &Local::default());
        assert_eq!(view.decisions[0].delivery, Delivery::Unknown);
        assert_eq!(view.decisions[0].sent_option.as_deref(), Some("option-1"));
        let mut gone = r.clone();
        gone["questions"] = json!([]);
        let view = project(Some(&gone), &ops, &[], &[], &Local::default());
        assert_eq!(view.decisions[0].kind, DecisionKind::Unknown);
        assert_eq!(view.decisions[0].delivery, Delivery::Unknown);
        assert_eq!(pending_answer(&ops, "question-s1-12").unwrap()["id"], "op");
    }

    #[test]
    fn an_accepted_answer_hides_its_question_and_a_rejected_one_does_not() {
        let r = read();
        let request = answer_request(&r, "question-s1-12", &[], "Rebuild it").unwrap();
        let mut op = json!({ "id": "op", "request": request, "state": "acknowledged",
            "receipt": { "ok": true, "value": { "state": "accepted" } } });
        let view = project(Some(&r), &[op.clone()], &[], &[], &Local::default());
        assert!(view.decisions.is_empty());
        op["receipt"]["value"]["state"] = json!("rejected");
        let view = project(Some(&r), &[op], &[], &[], &Local::default());
        assert_eq!(view.decisions.len(), 1);
    }

    #[test]
    fn answers_are_exact_and_limited() {
        let r = read();
        let a = answer_request(
            &r,
            "question-s1-12",
            &picks(&["option-1"]),
            "  and keep 💬  ",
        )
        .unwrap();
        assert_eq!(a["message"], "Reviewed package\n\n  and keep 💬  ");
        assert_eq!(a["scope"], r["questions"][0]["scope"]);
        let refused = |o: Option<&str>, t: &str, id: &str| {
            let o: Vec<String> = o.into_iter().map(str::to_owned).collect();
            answer_request(&r, id, &o, t).unwrap_err().status
        };
        assert_eq!(
            refused(None, " ", "question-s1-12"),
            OutcomeStatus::Rejected
        );
        assert_eq!(
            refused(Some("option-9"), "", "question-s1-12"),
            OutcomeStatus::Rejected
        );
        assert_eq!(refused(Some("option-1"), "", "gone"), OutcomeStatus::Stale);
        let long = "x".repeat(REPLY_LIMIT + 1);
        assert!(answer_request(&r, "question-s1-12", &[], &long).is_err());
    }

    /// The read with its question taking several of three options.
    fn several() -> Value {
        let mut r = read();
        r["questions"][0]["question"] = json!({
            "question": "Which checks run before upload?",
            "options": [{ "label": "Typecheck", "suggested": true }, { "label": "Tests", "suggested": true },
                { "label": "Lint" }],
            "multiSelect": true,
        });
        r
    }

    #[test]
    fn a_question_that_takes_several_sends_every_pick_in_the_order_shown() {
        let r = several();
        let id = "question-s1-12";
        let view = project(Some(&r), &[], &[], &[], &Local::default());
        let d = &view.decisions[0];
        assert!(d.multiple);
        assert!(d.options[0].recommended && d.options[1].recommended && !d.options[2].recommended);
        // Picked out of order and twice: sent once each, in the order shown.
        let a = answer_request(&r, id, &picks(&["option-3", "option-1", "option-3"]), "").unwrap();
        assert_eq!(a["message"], "- Typecheck\n- Lint");
        let a = answer_request(&r, id, &picks(&["option-2", "option-1"]), " also 日本 ").unwrap();
        assert_eq!(a["message"], "- Typecheck\n- Tests\n\n also 日本 ");
        // One pick is its label alone, as the chat composers send it.
        let a = answer_request(&r, id, &picks(&["option-2"]), "").unwrap();
        assert_eq!(a["message"], "Tests");
        // A pick that names no option refuses the whole answer.
        let refused = answer_request(&r, id, &picks(&["option-1", "option-4"]), "").unwrap_err();
        assert_eq!(refused, NOT_AN_OPTION);
        assert_eq!(
            answer_request(&r, id, &picks(&["option-0"]), "").unwrap_err(),
            NOT_AN_OPTION
        );
    }

    #[test]
    fn a_question_that_takes_one_refuses_several_picks() {
        let r = read();
        let refused = answer_request(&r, "question-s1-12", &picks(&["option-1", "option-2"]), "")
            .unwrap_err();
        assert_eq!(refused, ONE_ONLY);
        let view = project(Some(&r), &[], &[], &[], &Local::default());
        assert!(!view.decisions[0].multiple);
        // One option alone never takes several, whatever the question says.
        let mut one = several();
        one["questions"][0]["question"]["options"] = json!([{ "label": "Typecheck" }]);
        assert!(!takes_several(&one["questions"][0]));
    }

    #[test]
    fn several_picks_and_later_are_saved_and_read_back() {
        let r = several();
        let key = question_key(&r["questions"][0]).unwrap();
        let intent = DraftIntent {
            item_id: "question-s1-12".into(),
            revision: 1,
            pick: None,
            picks: picks(&["option-1", "option-3"]),
            text: "  exact 💬 ".into(),
            question: String::new(),
            later: false,
        };
        let value = draft_value(&draft_from(&key, &intent, None));
        assert_eq!(value["picks"], json!(["option-1", "option-3"]));
        assert!(value.get("later").is_none());
        let view = project(
            Some(&r),
            &[],
            &[(key.clone(), value.clone())],
            &[],
            &Local::default(),
        );
        let draft = &view.decisions[0].draft;
        assert_eq!(draft.picks, picks(&["option-1", "option-3"]));
        assert_eq!(draft.text, "  exact 💬 ");
        assert!(!draft.later);
        // Later stays with the draft until an answer clears it; a later save
        // that does not say Later keeps it.
        let put_off = draft_value(&draft_from(
            &key,
            &DraftIntent {
                later: true,
                ..intent.clone()
            },
            Some(&value),
        ));
        assert_eq!(put_off["later"], true);
        let unpicked = DraftIntent {
            picks: picks(&["option-3"]),
            ..intent.clone()
        };
        let kept = draft_value(&draft_from(&key, &unpicked, Some(&put_off)));
        assert_eq!(kept["later"], true);
        assert_eq!(kept["picks"], json!(["option-3"]));
        // A draft saved by an earlier Day reads as one pick and no Later.
        let legacy = json!({ "pick": "option-2", "text": "t", "question": "" });
        let view = project(
            Some(&r),
            &[],
            &[(key.clone(), legacy)],
            &[],
            &Local::default(),
        );
        assert!(view.decisions[0].draft.picks.is_empty() && !view.decisions[0].draft.later);
        // An action takes no picks and no Later: its own Later is a request.
        let action = action_key(&r["actions"][0]).unwrap();
        let saved = draft_from(
            &action,
            &DraftIntent {
                later: true,
                ..intent
            },
            None,
        );
        assert!(saved.picks.is_empty() && !saved.later);
    }

    #[test]
    fn an_unconfirmed_answer_shows_every_option_it_sent() {
        let r = several();
        let id = "question-s1-12";
        let request = answer_request(&r, id, &picks(&["option-1", "option-3"]), "why").unwrap();
        let ops =
            vec![json!({ "id": "op", "request": request, "receipt": null, "state": "unknown" })];
        let view = project(Some(&r), &ops, &[], &[], &Local::default());
        let d = &view.decisions[0];
        assert_eq!(d.delivery, Delivery::Unknown);
        assert_eq!(d.sent_options, picks(&["option-1", "option-3"]));
        assert_eq!(d.sent_option, None);
        // Own words alone name no option.
        let request = answer_request(&r, id, &[], "- Typecheck").unwrap();
        let ops =
            vec![json!({ "id": "op", "request": request, "receipt": null, "state": "unknown" })];
        let view = project(Some(&r), &ops, &[], &[], &Local::default());
        assert!(view.decisions[0].sent_options.is_empty());
        // While it is on its way, the picks it carries show.
        let local = Local {
            sending: BTreeMap::from([(id.to_owned(), Sending::Answer(picks(&["option-2"])))]),
            ..Local::default()
        };
        let view = project(Some(&r), &[], &[], &[], &local);
        assert_eq!(view.decisions[0].delivery, Delivery::Sending);
        assert_eq!(view.decisions[0].sent_options, picks(&["option-2"]));
    }

    #[test]
    fn help_is_refused_while_unavailable() {
        let r = read();
        let refused = help_request(&r, "question-s1-12", "why?").unwrap_err();
        assert_eq!(refused.status, OutcomeStatus::Rejected);
    }

    #[test]
    fn action_requests_name_the_revision_shown_and_later_keeps_progress() {
        let r = read();
        assert_eq!(
            action_request(&r, "upload", 1, ActionAsk::Complete, "done").unwrap_err(),
            CHANGED
        );
        let later = action_request(&r, "upload", 2, ActionAsk::Later, "ignored").unwrap();
        assert_eq!(later["command"]["kind"], "defer");
        assert_eq!(later["command"]["progress"], "half");
        assert_eq!(later["authorityDigest"], "b".repeat(64));
        assert!(action_request(&r, "upload", 2, ActionAsk::Complete, " ").is_err());
        let done = action_request(&r, "upload", 2, ActionAsk::Complete, "Submitted").unwrap();
        assert_eq!(done["command"]["report"], "Submitted");
        assert_eq!(done["command"]["expected"]["revision"], 2);
    }

    #[test]
    fn links_open_only_with_a_root_opener_and_never_count() {
        let mut r = read();
        assert!(resource_request(&r, "upload", 2).is_err());
        r["canOpenUrl"] = json!(true);
        let view = project(Some(&r), &[], &[], &[], &Local::default());
        assert!(view.actions[0].can_open);
        let open = resource_request(&r, "upload", 2).unwrap();
        let ops =
            vec![json!({ "id": "nav", "request": open, "receipt": null, "state": "unknown" })];
        let view = project(Some(&r), &ops, &[], &[], &Local::default());
        assert_eq!(view.actions[0].delivery, Delivery::Idle);
        assert!(pending_action(&ops, "upload").is_none());
    }

    #[test]
    fn later_moves_a_question_to_the_end_without_sending() {
        let mut r = read();
        let mut second = r["questions"][0].clone();
        second["scope"]["subject"]["entryId"] = json!(13);
        r["questions"].as_array_mut().unwrap().push(second);
        let local = Local {
            later: vec!["question-s1-12".into()],
            ..Local::default()
        };
        let view = project(Some(&r), &[], &[], &[], &local);
        assert_eq!(view.decisions[0].id, "question-s1-13");
        assert_eq!(view.decisions[1].id, "question-s1-12");
    }

    #[test]
    fn a_saved_later_goes_last_after_a_restart_and_before_this_runs() {
        let mut r = read();
        for entry in [13, 14] {
            let mut next = r["questions"][0].clone();
            next["scope"]["subject"]["entryId"] = json!(entry);
            r["questions"].as_array_mut().unwrap().push(next);
        }
        let key = question_key(&r["questions"][0]).unwrap();
        let mut put_off = words(None, "", "");
        put_off["later"] = json!(true);
        let saved = vec![(key, put_off)];
        // After a restart: the saved Later goes last; nothing else moved.
        let view = project(Some(&r), &[], &saved, &[], &Local::default());
        let order: Vec<&str> = view.decisions.iter().map(|d| d.id.as_str()).collect();
        assert_eq!(
            order,
            ["question-s1-13", "question-s1-14", "question-s1-12"]
        );
        assert!(view.decisions[2].draft.later);
        // A Later in this run goes after the saved one.
        let local = Local {
            later: vec!["question-s1-13".into()],
            ..Local::default()
        };
        let view = project(Some(&r), &[], &saved, &[], &local);
        let order: Vec<&str> = view.decisions.iter().map(|d| d.id.as_str()).collect();
        assert_eq!(
            order,
            ["question-s1-14", "question-s1-12", "question-s1-13"]
        );
    }
}
