//! The user's own feedback about Pilot on the existing serialized host and
//! fsynced ledger. TSX sends only the words and, when the user kept it, the
//! exact mission or chat the feedback came from; the host names the record
//! and the service reads that origin's project and title. A Send is one
//! journaled operation sent once. A lost answer stays Unknown: Check looks up
//! that exact envelope and never sends a replacement. Saving feedback starts
//! no work and approves nothing.
use super::{Error, Journal, Shared, Transport, planning, valid_id};
use crate::bridge::{Command, Gate};
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

/// The operation kind and payload purpose.
pub(super) const KIND: &str = "user-feedback";
/// At most this many UTF-8 bytes of feedback text, as the service counts them.
pub(crate) const MAX_TEXT: usize = 8192;
/// At most this many saved items per page.
const PAGE: usize = 20;
const MAX_CURSOR: u64 = 9_007_199_254_740_991;

fn valid_text(text: &str) -> bool {
    !text.trim().is_empty() && text.len() <= MAX_TEXT && !text.contains('\0')
}

/// Null, or exactly one mission or chat by its ID.
fn valid_origin(o: &Value) -> bool {
    o.is_null()
        || o.as_object().is_some_and(|m| {
            m.len() == 2
                && match m.get("kind").and_then(Value::as_str) {
                    Some("mission") => m
                        .get("missionId")
                        .and_then(Value::as_str)
                        .is_some_and(valid_id),
                    Some("chat") => m
                        .get("sessionId")
                        .and_then(Value::as_str)
                        .is_some_and(valid_id),
                    _ => false,
                }
        })
}

/// One piece of feedback as the user wrote it.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Intent {
    text: String,
    #[serde(default)]
    origin: Value,
}
impl Intent {
    pub(crate) fn validate(&self) -> Result<(), Error> {
        if valid_text(&self.text) && valid_origin(&self.origin) {
            Ok(())
        } else {
            Err(Error::Invalid)
        }
    }
}

/// One page of saved feedback: the newest, or older than `before`. Read only.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Read {
    before: Option<u64>,
}
impl Read {
    pub(crate) fn validate(&self) -> Result<(), Error> {
        if self.before.is_some_and(|n| n == 0 || n > MAX_CURSOR) {
            return Err(Error::Invalid);
        }
        Ok(())
    }
}

fn payload(op: &Value) -> Result<Value, Error> {
    serde_json::from_str(op["payload"].as_str().ok_or(Error::Storage)?).map_err(|_| Error::Storage)
}

/// A saved feedback operation holds only the words and an exact origin.
pub(super) fn validate_record(op: &Value) -> Result<(), Error> {
    let p = payload(op)?;
    if p.as_object().is_none_or(|o| o.len() != 3)
        || p["purpose"] != KIND
        || op["kind"] != KIND
        || op["bindingGeneration"] != 1
        || p["text"].as_str().is_none_or(|t| !valid_text(t))
        || !valid_origin(&p["origin"])
    {
        return Err(Error::Storage);
    }
    Ok(())
}

/// Only an accepted receipt naming this record, operation and words proves a Send.
pub(super) fn exact_result(op: &Value, r: &Value) -> Result<(), Error> {
    let p = payload(op).map_err(|_| Error::Unknown)?;
    let result = &r["result"];
    if result["id"] != op["targetId"]
        || result["operationId"] != op["operationId"]
        || result["text"] != p["text"]
        || !result["recordedAt"].is_u64()
    {
        return Err(Error::Unknown);
    }
    Ok(())
}

fn is_feedback(r: &planning::PlanningRecord) -> bool {
    r.operation["kind"] == KIND
}

/// Sends whose result is not known yet. Settled ones show in the saved list.
fn unsettled(t: &Transport, journal: &Journal) -> Vec<Value> {
    journal
        .planning
        .values()
        .filter(|r| r.source == t.source && is_feedback(r) && r.pending())
        .map(|r| {
            let p = payload(&r.operation).unwrap_or(Value::Null);
            json!({"operationId":r.id(),"state":"unknown","text":p["text"]})
        })
        .collect()
}

fn valid_item(v: &Value) -> bool {
    let origin = &v["origin"];
    v["id"].as_str().is_some_and(valid_id)
        && v["operationId"].as_str().is_some_and(valid_id)
        && v["text"].as_str().is_some()
        && v["recordedAt"].is_u64()
        && (origin.is_null()
            || (match origin["kind"].as_str() {
                Some("mission") => origin["missionId"].as_str().is_some_and(valid_id),
                Some("chat") => origin["sessionId"].as_str().is_some_and(valid_id),
                _ => false,
            } && origin["projectId"].as_str().is_some_and(valid_id)
                && origin["title"].is_string()))
}

/// A page is newest first, strictly older than `before`, with an exact cursor.
fn valid_page(v: &Value, before: Option<u64>) -> bool {
    let (Some(list), Some(more)) = (v["items"].as_array(), v["more"].as_bool()) else {
        return false;
    };
    let mut previous = before.unwrap_or(u64::MAX);
    for item in list {
        let Some(n) = item["sequence"].as_u64() else {
            return false;
        };
        if n == 0 || n >= previous || !valid_item(item) {
            return false;
        }
        previous = n;
    }
    list.len() <= PAGE
        && if more {
            !list.is_empty() && v["before"].as_u64() == Some(previous)
        } else {
            v["before"].is_null()
        }
}

/// One page of the user's saved feedback. A failed read is never an empty list.
async fn read(t: &Transport, before: Option<u64>) -> Result<Value, Error> {
    t.gate(false).await?;
    let after = before.map(|n| format!("&before={n}")).unwrap_or_default();
    let v = t.get(&format!("/api/feedback?limit={PAGE}{after}")).await?;
    if !valid_page(&v, before) {
        return Err(Error::Invalid);
    }
    t.gate(false).await?;
    Ok(
        json!({"version":1,"items":v["items"],"more":v["more"],"before":v["before"],"older":before.is_some()}),
    )
}

pub(super) async fn handle(
    t: &Transport,
    journal: &mut Journal,
    shared: &Shared,
    command: &Command,
    gate: &Arc<Mutex<Gate>>,
) -> Result<Value, Error> {
    let check = || {
        shared.open()?;
        command.admit(&gate.lock().expect("bridge gate poisoned"))
    };
    let mut outcome = Value::Null;
    let mut before = None;
    match command {
        Command::FeedbackRead(request) => {
            request.validate()?;
            before = request.before;
        }
        Command::FeedbackSend(intent) => {
            intent.validate()?;
            // An earlier Send whose result is unknown is checked first, never sent again beside a copy.
            if journal
                .planning
                .values()
                .any(|r| r.source == t.source && is_feedback(r) && r.pending())
            {
                return Err(Error::Unknown);
            }
            // A service that cannot list feedback cannot be sent any.
            read(t, None).await?;
            check()?;
            let request = json!({"purpose":KIND,"text":intent.text,"origin":intent.origin});
            let digest = planning::hash(&request.to_string());
            let id = uuid::Uuid::new_v4().to_string();
            let mut record = planning::record(&t.source, id, digest, request)?;
            journal.save_planning(record.clone())?;
            if let Err(e) = t.local().and_then(|_| check()) {
                record.not_sent = true;
                journal.save_planning(record)?;
                return Err(e);
            }
            // No async gap, retry or recreation between the durable record and this sole POST.
            let mut saved = true;
            if let Ok(receipt) = t.planning_operation(&record.operation, false).await {
                record.receipt = Some(receipt);
                if journal.save_planning(record.clone()).is_err() {
                    journal.poison();
                    saved = false;
                }
            }
            outcome = outcome_of(&record, saved);
        }
        Command::FeedbackCheck(id) => {
            let mut record = journal
                .planning
                .get(id)
                .filter(|r| r.source == t.source && is_feedback(r))
                .cloned()
                .ok_or(Error::Unknown)?;
            // Only the saved envelope's receipt. Nothing is sent again.
            t.gate(false).await?;
            check()?;
            if record.pending()
                && let Ok(receipt) = t.planning_operation(&record.operation, true).await
            {
                record.receipt = Some(receipt);
                journal.save_planning(record.clone())?;
            }
            outcome = outcome_of(&record, true);
        }
        _ => return Err(Error::Invalid),
    }
    let snapshot = read(t, before).await;
    if matches!(command, Command::FeedbackRead(_)) {
        let snapshot = snapshot?;
        check()?;
        Ok(json!({"snapshot":snapshot,"operations":unsettled(t,journal),"outcome":outcome}))
    } else {
        // A failed/raced refresh cannot erase the exact acknowledgement.
        Ok(
            json!({"snapshot":snapshot.ok().filter(|_| check().is_ok()),"operations":unsettled(t,journal),"outcome":outcome}),
        )
    }
}

fn outcome_of(record: &planning::PlanningRecord, saved: bool) -> Value {
    let state = if record.not_sent {
        json!("not-sent")
    } else if saved {
        record
            .receipt
            .as_ref()
            .map(|r| r["state"].clone())
            .unwrap_or(json!("unknown"))
    } else {
        json!("unknown")
    };
    json!({"operationId":record.id(),"state":state,"receipt":if saved {record.receipt.clone()} else {None}})
}

#[cfg(test)]
mod tests {
    use super::*;

    fn intent(v: Value) -> Result<Intent, Error> {
        let i: Intent = serde_json::from_value(v).map_err(|_| Error::Invalid)?;
        i.validate()?;
        Ok(i)
    }

    #[test]
    fn a_send_holds_words_and_at_most_one_exact_origin() {
        assert!(intent(json!({"text":"The plan page is slow 🐢","origin":null})).is_ok());
        assert!(
            intent(json!({"text":"About this","origin":{"kind":"mission","missionId":"m-1"}}))
                .is_ok()
        );
        assert!(
            intent(json!({"text":"About this","origin":{"kind":"chat","sessionId":"s_1"}})).is_ok()
        );
        for bad in [
            json!({"text":"   ","origin":null}),
            json!({"text":"x".repeat(MAX_TEXT + 1),"origin":null}),
            json!({"text":"nul\0","origin":null}),
            json!({"text":"t","origin":{"kind":"mission","missionId":"../m"}}),
            json!({"text":"t","origin":{"kind":"chat","missionId":"m"}}),
            json!({"text":"t","origin":{"kind":"mission","missionId":"m","projectId":"p"}}),
            json!({"text":"t","origin":{"kind":"project","projectId":"p"}}),
            json!({"text":"t","origin":"m"}),
        ] {
            assert!(intent(bad.clone()).is_err(), "{bad}");
        }
        // The window cannot choose an ID, project, operation or status.
        for extra in ["id", "projectId", "operationId", "state"] {
            let mut forged = json!({"text":"t","origin":null});
            forged[extra] = json!("x");
            assert!(intent(forged).is_err(), "{extra}");
        }
    }

    #[test]
    fn only_the_same_record_operation_and_words_settle_a_send() {
        let p = json!({"purpose":KIND,"text":"Slow","origin":null});
        let op = json!({"operationId":"op","targetId":"f","kind":KIND,"bindingGeneration":1,"payload":p.to_string()});
        assert_eq!(validate_record(&op), Ok(()));
        let r = json!({"result":{"id":"f","operationId":"op","text":"Slow","recordedAt":1,"origin":null}});
        assert_eq!(exact_result(&op, &r), Ok(()));
        for (pointer, value) in [
            ("/result/id", json!("other")),
            ("/result/operationId", json!("other")),
            ("/result/text", json!("Fast")),
            ("/result/recordedAt", Value::Null),
        ] {
            let mut changed = r.clone();
            *changed.pointer_mut(pointer).unwrap() = value;
            assert_eq!(
                exact_result(&op, &changed),
                Err(Error::Unknown),
                "{pointer}"
            );
        }
        let mut forged = op.clone();
        forged["payload"] =
            json!(json!({"purpose":KIND,"text":"Slow","origin":null,"projectId":"p"}).to_string());
        assert_eq!(validate_record(&forged), Err(Error::Storage));
    }

    #[test]
    fn a_page_is_newest_first_with_an_exact_cursor() {
        let item = |n: u64| {
            json!({"sequence":n,"id":format!("f{n}"),"operationId":format!("o{n}"),"text":"t","recordedAt":1,
                "origin":{"kind":"mission","missionId":"m","projectId":"p","title":"Mission"}})
        };
        let page = json!({"items":[item(5),item(4)],"more":true,"before":4});
        assert!(valid_page(&page, None));
        assert!(valid_page(&page, Some(6)));
        assert!(!valid_page(&page, Some(5)));
        for (pointer, value) in [
            ("/before", json!(5)),
            ("/before", Value::Null),
            ("/items/1/sequence", json!(5)),
            ("/items/0/origin/projectId", Value::Null),
            ("/items/0/origin/kind", json!("project")),
            ("/items/0/id", json!("bad id")),
            ("/more", Value::Null),
        ] {
            let mut changed = page.clone();
            *changed.pointer_mut(pointer).unwrap() = value;
            assert!(!valid_page(&changed, None), "{pointer}");
        }
        assert!(valid_page(
            &json!({"items":[],"more":false,"before":null}),
            None
        ));
        let many = json!({"items":(1..=21).rev().map(item).collect::<Vec<_>>(),"more":false,"before":null});
        assert!(!valid_page(&many, None));
        assert_eq!(Read { before: Some(0) }.validate(), Err(Error::Invalid));
    }
}
