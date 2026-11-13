//! The selected project's small preferences on the existing serialized host
//! and fsynced ledger. The root chooses the project; TSX names it only so a
//! draft for another project is refused, never retargeted. A Save is one
//! journaled operation sent once. A lost answer stays Unknown: Check looks
//! up that exact envelope and never sends a replacement.
use super::{Error, Journal, Shared, Transport, planning, valid_id};
use crate::bridge::{Command, Gate};
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

/// The operation kind and payload purpose.
pub(super) const KIND: &str = "project-preferences-update";
/// At most this many preferences per project.
pub(crate) const MAX_ENTRIES: usize = 16;
/// At most this many UTF-8 bytes per preference.
pub(crate) const MAX_TEXT: usize = 512;
const MAX_REVISION: u64 = 9_007_199_254_740_990;
/// Why the user's own edit was saved. Fixed by the host, never by TSX.
const REASON: &str = "Edited in Pilot Settings";

fn valid_text(text: &str) -> bool {
    !text.trim().is_empty() && text.len() <= MAX_TEXT && !text.contains('\0')
}

/// One preference as the user typed it. No ID is a new preference; the host names it.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Entry {
    id: Option<String>,
    text: String,
}

/// One full list, written against the exact revision the window showed.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct Intent {
    project_id: String,
    expected_revision: u64,
    entries: Vec<Entry>,
}
impl Intent {
    pub(crate) fn validate(&self) -> Result<(), Error> {
        let mut ids = std::collections::HashSet::new();
        if !valid_id(&self.project_id)
            || self.expected_revision > MAX_REVISION
            || self.entries.len() > MAX_ENTRIES
            || self.entries.iter().any(|e| {
                !valid_text(&e.text)
                    || e.id
                        .as_ref()
                        .is_some_and(|id| !valid_id(id) || !ids.insert(id.clone()))
            })
        {
            return Err(Error::Invalid);
        }
        Ok(())
    }
}

fn payload(op: &Value) -> Result<Value, Error> {
    serde_json::from_str(op["payload"].as_str().ok_or(Error::Storage)?).map_err(|_| Error::Storage)
}

fn valid_entries(entries: &Value) -> bool {
    let mut ids = std::collections::HashSet::new();
    entries.as_array().is_some_and(|list| {
        list.len() <= MAX_ENTRIES
            && list.iter().all(|e| {
                e.as_object().is_some_and(|o| o.len() == 2)
                    && e["id"]
                        .as_str()
                        .is_some_and(|id| valid_id(id) && ids.insert(id.to_owned()))
                    && e["text"].as_str().is_some_and(valid_text)
            })
    })
}

/// A saved preferences operation names its own project exactly, with the host's reason.
pub(super) fn validate_record(source: &super::Source, op: &Value) -> Result<(), Error> {
    let p = payload(op)?;
    if p.as_object().is_none_or(|o| o.len() != 5)
        || p["purpose"] != KIND
        || op["kind"] != KIND
        || p["projectId"] != source.project_id
        || op["targetId"] != source.project_id
        || op["bindingGeneration"] != 1
        || p["reason"] != REASON
        || p["expectedRevision"]
            .as_u64()
            .is_none_or(|n| n > MAX_REVISION)
        || !valid_entries(&p["entries"])
    {
        return Err(Error::Storage);
    }
    Ok(())
}

/// Only an accepted receipt naming the next revision of this project proves a Save.
pub(super) fn exact_result(op: &Value, r: &Value) -> Result<(), Error> {
    let p = payload(op).map_err(|_| Error::Unknown)?;
    let result = &r["result"];
    if result["projectId"] != op["targetId"]
        || result["revision"].as_u64()
            != p["expectedRevision"]
                .as_u64()
                .and_then(|n| n.checked_add(1))
        || !result["entries"].is_array()
    {
        return Err(Error::Unknown);
    }
    Ok(())
}

fn is_preferences(r: &planning::PlanningRecord) -> bool {
    r.operation["kind"] == KIND
}

fn summaries(t: &Transport, journal: &Journal) -> Vec<Value> {
    journal
        .planning
        .values()
        .filter(|r| r.source == t.source && is_preferences(r))
        .map(|r| {
            let p = payload(&r.operation).unwrap_or(Value::Null);
            json!({"operationId":r.id(),"expectedRevision":p["expectedRevision"],
                "state":if r.not_sent {"not-sent"} else {
                    r.receipt.as_ref().and_then(|r| r["state"].as_str()).unwrap_or("unknown")},
                "receipt":r.receipt})
        })
        .collect()
}

fn valid_list(v: &Value, project: &str) -> bool {
    let mut ids = std::collections::HashSet::new();
    v["projectId"] == project
        && v["revision"].as_u64().is_some_and(|n| n <= MAX_REVISION)
        && v["entries"].as_array().is_some_and(|list| {
            list.len() <= MAX_ENTRIES
                && list.iter().all(|e| {
                    e["id"]
                        .as_str()
                        .is_some_and(|id| valid_id(id) && ids.insert(id.to_owned()))
                        && e["text"].as_str().is_some()
                        && e["recordedAt"].is_u64()
                        && matches!(e["source"]["type"].as_str(), Some("user" | "mission_note"))
                        && matches!(e["author"]["type"].as_str(), Some("user" | "coordinator"))
                })
        })
}

/// The root's project's list and its name. A list for another project is never shown.
pub(super) async fn read(t: &Transport) -> Result<Value, Error> {
    t.gate(false).await?;
    let project = &t.source.project_id;
    let list = t
        .get(&format!("/api/projects/{project}/preferences"))
        .await?;
    if !valid_list(&list, project) {
        return Err(Error::Invalid);
    }
    // The name only labels the page; without it the page says "this project".
    let name = super::new_chat::inventory(t)
        .await
        .ok()
        .and_then(|v| {
            v["projects"].as_array().and_then(|rows| {
                rows.iter()
                    .find(|r| r["projectId"] == *project)
                    .and_then(|r| r["name"].as_str().map(str::to_owned))
            })
        })
        .unwrap_or_default();
    // A changed project/path or native identity during the read cannot publish it.
    t.gate(false).await?;
    Ok(json!({"version":1,"projectId":project,"projectName":name,"preferences":list}))
}

pub(super) async fn handle(
    t: &Transport,
    journal: &mut Journal,
    shared: &Shared,
    command: &Command,
    gate: &Arc<Mutex<Gate>>,
) -> Result<Value, Error> {
    // The daemon's revision CAS decides; the host only has to be open and the window admitting.
    let check = || {
        shared.open()?;
        command.admit(&gate.lock().expect("bridge gate poisoned"))
    };
    let mut outcome = Value::Null;
    match command {
        Command::PreferencesRead => {}
        Command::PreferencesSave(intent) => {
            intent.validate()?;
            // A draft for another project is refused, never saved to this one.
            if intent.project_id != t.source.project_id {
                return Err(Error::Stale);
            }
            if journal
                .planning
                .values()
                .any(|r| r.source == t.source && is_preferences(r) && r.pending())
            {
                return Err(Error::Unknown);
            }
            let current = read(t).await?;
            check()?;
            if current["preferences"]["revision"] != intent.expected_revision {
                return Err(Error::Stale);
            }
            let entries: Vec<Value> = intent
                .entries
                .iter()
                .map(|e| {
                    let id =
                        e.id.clone()
                            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
                    json!({"id":id,"text":e.text})
                })
                .collect();
            let request = json!({"purpose":KIND,"projectId":t.source.project_id,
                "expectedRevision":intent.expected_revision,"entries":entries,"reason":REASON});
            let digest = planning::hash(&current["preferences"].to_string());
            let mut record =
                planning::record(&t.source, t.source.project_id.clone(), digest, request)?;
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
            outcome = json!({"operationId":record.id(),"state":if saved {record.receipt.as_ref().map(|r| r["state"].clone()).unwrap_or(json!("unknown"))} else {json!("unknown")},
                "receipt":if saved {record.receipt.clone()} else {None}});
        }
        Command::PreferencesCheck(id) => {
            let mut record = journal
                .planning
                .get(id)
                .filter(|r| r.source == t.source && is_preferences(r))
                .cloned()
                .ok_or(Error::Unknown)?;
            // Only the saved envelope. Never read or rebind the current list for this lookup.
            t.gate(false).await?;
            check()?;
            if record.pending()
                && let Ok(receipt) = t.planning_operation(&record.operation, true).await
            {
                record.receipt = Some(receipt);
                journal.save_planning(record.clone())?;
            }
            outcome = json!({"operationId":record.id(),"state":if record.not_sent {json!("not-sent")} else {record.receipt.as_ref().map(|r| r["state"].clone()).unwrap_or(json!("unknown"))},"receipt":record.receipt});
        }
        _ => return Err(Error::Invalid),
    }
    let snapshot = read(t).await;
    if matches!(command, Command::PreferencesRead) {
        let snapshot = snapshot?;
        check()?;
        Ok(json!({"snapshot":snapshot,"operations":summaries(t,journal),"outcome":outcome}))
    } else {
        // A failed/raced refresh cannot erase the exact acknowledgement.
        Ok(
            json!({"snapshot":snapshot.ok().filter(|_| check().is_ok()),"operations":summaries(t,journal),"outcome":outcome}),
        )
    }
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
    fn a_save_names_one_project_a_revision_and_a_small_list() {
        let ok = json!({"projectId":"p","expectedRevision":3,
            "entries":[{"id":"a","text":"Keep PRs small"},{"id":null,"text":"Plain names 🐦"}]});
        assert!(intent(ok.clone()).is_ok());
        for (pointer, value) in [
            ("/projectId", json!("../other")),
            ("/expectedRevision", json!(-1)),
            ("/entries/0/id", json!("bad id")),
            ("/entries/1/id", json!("a")),
            ("/entries/0/text", json!("   ")),
            ("/entries/0/text", json!("x".repeat(MAX_TEXT + 1))),
            ("/entries/0/text", json!("nul\0")),
        ] {
            let mut changed = ok.clone();
            *changed.pointer_mut(pointer).unwrap() = value;
            assert!(intent(changed).is_err(), "{pointer}");
        }
        let mut many = ok.clone();
        many["entries"] = json!(vec![json!({"id":null,"text":"x"}); MAX_ENTRIES + 1]);
        assert!(intent(many).is_err());
        // No source, author, reason or operation ID can be chosen by the window.
        for extra in ["source", "author", "reason", "operationId"] {
            let mut forged = ok.clone();
            forged[extra] = json!("x");
            assert!(intent(forged).is_err(), "{extra}");
        }
    }

    #[test]
    fn only_the_next_revision_of_the_same_project_settles_a_save() {
        let p = json!({"purpose":KIND,"projectId":"p","expectedRevision":3,"entries":[],"reason":REASON});
        let op = json!({"targetId":"p","kind":KIND,"bindingGeneration":1,"payload":p.to_string()});
        let r = json!({"result":{"projectId":"p","revision":4,"entries":[]}});
        assert_eq!(exact_result(&op, &r), Ok(()));
        for (pointer, value) in [
            ("/result/projectId", json!("other")),
            ("/result/revision", json!(3)),
            ("/result/revision", json!(5)),
            ("/result/entries", Value::Null),
        ] {
            let mut changed = r.clone();
            *changed.pointer_mut(pointer).unwrap() = value;
            assert_eq!(
                exact_result(&op, &changed),
                Err(Error::Unknown),
                "{pointer}"
            );
        }
    }
}
