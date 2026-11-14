//! The planning agent's chat, read only, for the planning page. Reads are
//! the daemon's compact planning history (one page of rows at a time); they
//! never wake, subscribe to or write to the coordinator. Only the mission the
//! page shows is kept, and only while its chat is open.
use super::{Error, Shared, Transport, valid_id};
use serde_json::{Value, json};

/// Rows per read.
const PAGE: u64 = 32;
/// At most this many rows are kept. Older ones leave; Show earlier reads them again.
const MAX_ROWS: usize = 400;

/// The open chat of one mission.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct ChatState {
    pub mission: String,
    /// Daemon rows, oldest first, each with a unique `key`.
    pub rows: Vec<Value>,
    pub more: bool,
    pub next_before: Option<u64>,
    pub reading: bool,
    /// Why the last read failed. Empty after a good read.
    pub reason: String,
}

impl ChatState {
    /// What the feed projects.
    pub fn view(&self) -> Value {
        json!({"missionId":self.mission,"rows":self.rows,"more":self.more,
            "reading":self.reading,"reason":self.reason})
    }
}

fn valid_row(row: &Value) -> bool {
    row["key"]
        .as_str()
        .is_some_and(|k| !k.is_empty() && k.len() <= 64)
        && row["entryId"].as_u64().is_some()
        && match row["role"].as_str() {
            Some("you" | "pilot") => row["text"].is_string() && row["shortened"].is_boolean(),
            Some("request") => true,
            Some("step") => {
                row["step"]["tool"].is_string()
                    && row["step"]["running"].is_boolean()
                    && row["step"]["failed"].is_boolean()
            }
            _ => false,
        }
}

/// Checks one daemon page for `mission`. Any bad row refuses the page.
pub(crate) fn valid_page(v: &Value, mission: &str) -> bool {
    v["version"] == 1
        && v["missionId"] == mission
        && v["sessionId"].as_str().is_some_and(valid_id)
        && v["more"].is_boolean()
        && (v["nextBefore"].is_null() || v["nextBefore"].as_u64().is_some())
        && v["rows"]
            .as_array()
            .is_some_and(|rows| rows.len() <= 1_000 && rows.iter().all(valid_row))
}

/// Joins a page into what shows. Rows never move, so pages join by key; a
/// newer read of a row (a step that finished) replaces it. A newest page
/// with no overlap may leave a gap, so it starts again from that page.
pub(crate) fn merge(state: &mut ChatState, page: &Value, older: bool) {
    let rows: Vec<Value> = page["rows"].as_array().cloned().unwrap_or_default();
    let keys: std::collections::HashSet<&str> =
        rows.iter().filter_map(|r| r["key"].as_str()).collect();
    let page_more = page["more"] == true;
    let page_before = page["nextBefore"].as_u64();
    let joins = older
        || state
            .rows
            .iter()
            .any(|r| r["key"].as_str().is_some_and(|k| keys.contains(k)));
    let kept: Vec<Value> = if joins {
        state
            .rows
            .iter()
            .filter(|r| r["key"].as_str().is_none_or(|k| !keys.contains(k)))
            .cloned()
            .collect()
    } else {
        Vec::new()
    };
    let oldest_new = rows.iter().filter_map(|r| r["entryId"].as_u64()).min();
    let keeps_older = !older && kept.iter().any(|r| r["entryId"].as_u64() < oldest_new);
    let mut all: Vec<Value> = kept.into_iter().chain(rows).collect();
    all.sort_by_key(order);
    if !keeps_older {
        state.more = page_more;
        state.next_before = page_before;
    }
    if all.len() > MAX_ROWS {
        // Keep the newest rows. Show earlier reads the oldest kept entry
        // again in full, so a partly dropped entry comes back whole.
        all.drain(..all.len() - MAX_ROWS);
        state.more = true;
        state.next_before = all
            .first()
            .and_then(|r| r["entryId"].as_u64())
            .map(|e| e + 1);
    }
    state.rows = all;
}

/// A row's place: its entry, then its step number within the entry (a
/// message comes before its steps).
fn order(row: &Value) -> (u64, i64) {
    let step = row["key"]
        .as_str()
        .and_then(|k| k.split_once('.'))
        .and_then(|(_, n)| n.parse::<i64>().ok())
        .unwrap_or(-1);
    (row["entryId"].as_u64().unwrap_or(0), step)
}

/// Reads the newest page, or the page before what shows, of `mission`'s chat.
pub(super) async fn read(
    t: &Transport,
    shared: &Shared,
    mission: &str,
    older: bool,
) -> Result<(), Error> {
    if !valid_id(mission) {
        return Err(Error::Invalid);
    }
    let before = {
        let mut chat = shared
            .planning_chat
            .lock()
            .expect("native planning chat poisoned");
        let state = match chat.as_mut() {
            Some(s) if s.mission == mission => s,
            _ => {
                *chat = Some(ChatState {
                    mission: mission.into(),
                    ..ChatState::default()
                });
                chat.as_mut().expect("just set")
            }
        };
        let before = if older { state.next_before } else { None };
        if older && before.is_none() {
            return Ok(());
        }
        state.reading = true;
        before
    };
    shared.change(|_| ());
    let result = page(t, mission, before).await;
    {
        let mut chat = shared
            .planning_chat
            .lock()
            .expect("native planning chat poisoned");
        // Closed or moved to another mission meanwhile: drop the answer.
        if let Some(state) = chat.as_mut().filter(|s| s.mission == mission) {
            state.reading = false;
            match &result {
                Ok(v) => {
                    merge(state, v, older);
                    state.reason.clear();
                }
                Err(_) => {
                    state.reason = if state.rows.is_empty() {
                        "Pilot could not read the planning chat. Nothing was sent.".into()
                    } else {
                        "Pilot could not read the newest part of the planning chat. What shows is from an earlier read.".into()
                    };
                }
            }
        }
    }
    shared.change(|_| ());
    result.map(|_| ())
}

async fn page(t: &Transport, mission: &str, before: Option<u64>) -> Result<Value, Error> {
    let selected = t.mission_planning_transport(mission).await?;
    let t = selected.as_ref().unwrap_or(t);
    t.gate(false).await?;
    let before = before.map(|b| format!("&before={b}")).unwrap_or_default();
    let v = t
        .get(&format!(
            "/api/projects/{}/missions/{mission}/planning/history?limit={PAGE}{before}",
            t.source.project()?.project_id
        ))
        .await?;
    if !valid_page(&v, mission) {
        return Err(Error::Invalid);
    }
    t.gate(false).await?;
    Ok(v)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(entry: u64, key: &str, running: bool) -> Value {
        json!({"key":key,"entryId":entry,"role":"step","step":{"tool":"read","running":running,"failed":false}})
    }
    fn page(rows: Vec<Value>, more: bool, before: Option<u64>) -> Value {
        json!({"version":1,"missionId":"m","sessionId":"s","rows":rows,"more":more,"nextBefore":before})
    }
    fn keys(s: &ChatState) -> Vec<&str> {
        s.rows.iter().filter_map(|r| r["key"].as_str()).collect()
    }

    #[test]
    fn pages_must_be_complete_and_for_the_mission() {
        assert!(valid_page(
            &page(vec![row(1, "1.0", true)], false, Some(1)),
            "m"
        ));
        assert!(!valid_page(&page(vec![], false, None), "other"));
        assert!(!valid_page(
            &page(
                vec![json!({"key":"1","entryId":1,"role":"admin"})],
                false,
                None
            ),
            "m"
        ));
        assert!(!valid_page(
            &page(
                vec![json!({"key":"1","entryId":1,"role":"you"})],
                false,
                None
            ),
            "m"
        ));
    }

    #[test]
    fn newer_reads_replace_rows_and_older_pages_join_before() {
        let mut s = ChatState {
            mission: "m".into(),
            ..ChatState::default()
        };
        merge(
            &mut s,
            &page(vec![row(5, "5.0", true), row(6, "6", false)], true, Some(5)),
            false,
        );
        assert_eq!(keys(&s), ["5.0", "6"]);
        // The running step finished and a new row came.
        merge(
            &mut s,
            &page(
                vec![row(5, "5.0", false), row(7, "7", false)],
                true,
                Some(5),
            ),
            false,
        );
        assert_eq!(keys(&s), ["5.0", "6", "7"]);
        assert_eq!(s.rows[0]["step"]["running"], false);
        merge(
            &mut s,
            &page(vec![row(3, "3", false), row(4, "4", false)], false, Some(3)),
            true,
        );
        assert_eq!(keys(&s), ["3", "4", "5.0", "6", "7"]);
        assert!(!s.more);
        // A newest page that still overlaps keeps the older pages and where to read before them.
        merge(
            &mut s,
            &page(vec![row(7, "7", false), row(8, "8", false)], true, Some(7)),
            false,
        );
        assert_eq!(keys(&s), ["3", "4", "5.0", "6", "7", "8"]);
        assert!(!s.more);
        assert_eq!(s.next_before, Some(3));
        // A newest page with no overlap may hide a gap: start again from it.
        merge(
            &mut s,
            &page(vec![row(40, "40", false)], true, Some(40)),
            false,
        );
        assert_eq!(keys(&s), ["40"]);
        assert!(s.more);
        assert_eq!(s.next_before, Some(40));
    }

    #[test]
    fn only_the_newest_rows_are_kept() {
        let mut s = ChatState {
            mission: "m".into(),
            ..ChatState::default()
        };
        let rows: Vec<Value> = (1..=(MAX_ROWS as u64 + 10))
            .map(|n| row(n, &n.to_string(), false))
            .collect();
        merge(&mut s, &page(rows, false, Some(1)), false);
        assert_eq!(s.rows.len(), MAX_ROWS);
        assert_eq!(s.rows[0]["entryId"], 11);
        assert!(s.more);
        assert_eq!(s.next_before, Some(12));
    }

    #[test]
    fn steps_keep_their_order_within_one_message() {
        let mut s = ChatState {
            mission: "m".into(),
            ..ChatState::default()
        };
        let rows = vec![
            row(1, "1.10", false),
            row(1, "1", false),
            row(1, "1.2", false),
        ];
        merge(&mut s, &page(rows, false, Some(1)), false);
        assert_eq!(keys(&s), ["1", "1.2", "1.10"]);
    }
}
