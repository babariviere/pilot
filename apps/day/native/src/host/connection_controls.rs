//! Native connections. Cached reads and durable, lookup-only mutations.
use super::{Error, Journal, Shared, Transport, planning};
use crate::bridge::{Command, Gate};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

pub(super) const KIND: &str = "connection-controls";
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Intent {
    pub binding: String,
    pub action: String,
    pub value: Value,
}
impl Intent {
    pub(crate) fn validate(&self) -> Result<(), Error> {
        let name = |v: &Value| {
            v.as_str()
                .is_some_and(|s| s.len() <= 64 && super::valid_id(s))
        };
        let valid = match self.action.as_str() {
            "add" => {
                self.value.as_object().is_some_and(|o| o.len() == 2)
                    && name(&self.value["name"])
                    && self.value["config"].as_object().is_some_and(|o| {
                        o.len() == 1
                            && o.keys().all(|k| matches!(k.as_str(), "url" | "command"))
                            && o.iter()
                                .all(|(k, v)| v.as_str().is_some_and(|s| safe_target(k, s)))
                    })
            }
            "sign-in" => {
                self.value.as_object().is_some_and(|o| o.len() == 1) && name(&self.value["server"])
            }
            "cancel" => {
                self.value.as_object().is_some_and(|o| o.len() == 2)
                    && name(&self.value["server"])
                    && self.value["expectedStartedAt"].as_u64().is_some()
            }
            _ => false,
        };
        if valid && self.binding.len() == 64 && self.binding.bytes().all(|b| b.is_ascii_hexdigit())
        {
            Ok(())
        } else {
            Err(Error::Invalid)
        }
    }
}
// Reject credentials and shell syntax before either native or daemon command journals see them.
fn safe_target(kind: &str, s: &str) -> bool {
    if kind == "command" {
        return !s.is_empty()
            && s.len() <= 64
            && s.bytes().enumerate().all(|(i, b)| {
                b.is_ascii_alphabetic()
                    || b == b'_'
                    || (i > 0 && (b.is_ascii_digit() || b".-".contains(&b)))
            });
    }
    s.len() <= 2048
        && s.strip_prefix("https://").is_some_and(|rest| {
            let (host, path) = rest.split_at(rest.find('/').unwrap_or(rest.len()));
            host.contains('.')
                && host
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b".-".contains(&b))
                && ["", "/", "/mcp", "/mcp/", "/api/mcp", "/v1/mcp"].contains(&path)
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn setup_rejects_credentials_before_journaling() {
        for (kind, target) in [
            ("url", "https://user:secret@example.test/mcp"),
            ("url", "https://example.test/mcp?token=secret"),
            ("url", "https://example.test/mcp#secret"),
            ("url", "https://example.test/mcp/private-key/sse"),
            ("command", "TOKEN=secret command"),
            ("command", "/tmp/command"),
        ] {
            let intent = Intent {
                binding: "a".repeat(64),
                action: "add".into(),
                value: json!({"name":"example","config":{kind:target}}),
            };
            assert_eq!(intent.validate(), Err(Error::Invalid));
        }
        for (kind, target) in [
            ("url", "https://example.test/mcp"),
            ("command", "mcp-server"),
        ] {
            assert!(safe_target(kind, target));
        }
    }
}
pub(super) fn validate_record(_source: &super::Source, op: &Value) -> Result<(), Error> {
    let mut p: Value = serde_json::from_str(op["payload"].as_str().ok_or(Error::Storage)?)
        .map_err(|_| Error::Storage)?;
    if p["purpose"] != KIND || op["targetId"] != "global-connections" {
        return Err(Error::Storage);
    }
    p.as_object_mut().ok_or(Error::Storage)?.remove("purpose");
    let i: Intent = serde_json::from_value(p).map_err(|_| Error::Storage)?;
    i.validate()?;
    if op["bindingId"] != i.binding {
        return Err(Error::Storage);
    }
    Ok(())
}
pub(super) fn exact_result(op: &Value, receipt: &Value) -> Result<(), Error> {
    let p: Value = serde_json::from_str(op["payload"].as_str().ok_or(Error::Unknown)?)
        .map_err(|_| Error::Unknown)?;
    let r = &receipt["result"];
    if r["action"] != p["action"] {
        return Err(Error::Unknown);
    }
    let valid = match p["action"].as_str() {
        Some("add") => r["saved"] == true,
        Some("sign-in") => {
            r["server"] == p["value"]["server"] && r["run"]["startedAt"].as_u64().is_some()
        }
        Some("cancel") => {
            r["server"] == p["value"]["server"]
                && r["run"]["startedAt"] == p["value"]["expectedStartedAt"]
                && matches!(
                    r["run"]["state"].as_str(),
                    Some("cancelled" | "done" | "failed")
                )
        }
        _ => false,
    };
    if valid { Ok(()) } else { Err(Error::Unknown) }
}
async fn read(t: &Transport) -> Result<Value, Error> {
    t.profile_gate().await?;
    let v = t.get("/api/connection-controls").await?;
    if v["version"] != 1
        || v["setup"]["schemaVersion"] != 1
        || v["setup"]["writeMode"] != "additive"
        || !v["binding"].is_string()
        || !v["setup"]["entries"].is_array()
    {
        return Err(Error::Invalid);
    }
    t.profile_gate().await?;
    Ok(v)
}
fn summaries(t: &Transport, j: &Journal) -> Vec<Value> {
    j.planning
        .values()
        .filter(|r| {
            r.source.profile == t.source.profile
                && r.source.home == t.source.home
                && r.operation["kind"] == KIND
                && r.pending()
        })
        .map(|r| json!({"operationId":r.id(),"state":"unknown"}))
        .collect()
}
pub(super) async fn handle(
    t: &Transport,
    j: &mut Journal,
    shared: &Shared,
    command: &Command,
    gate: &Arc<Mutex<Gate>>,
) -> Result<Value, Error> {
    let check = || {
        shared.open()?;
        command.admit(&gate.lock().expect("bridge gate poisoned"))
    };
    let mut outcome = Value::Null;
    match command {
        Command::ConnectionsRead => {}
        Command::ConnectionsProbe => {
            t.profile_gate().await?;
            check()?;
            let response = t
                .client
                .post(t.url("/api/connection-controls/check"))
                .header("x-pilot-github-capability", t.local()?)
                .send()
                .await
                .map_err(|_| Error::Unknown)?;
            if !response.status().is_success() {
                return Err(Error::Unknown);
            }
        }
        Command::ConnectionsWrite(i) => {
            i.validate()?;
            if !summaries(t, j).is_empty() && i.action != "cancel" {
                return Err(Error::Unknown);
            }
            let current = read(t).await?;
            check()?;
            if current["binding"] != i.binding {
                return Err(Error::Stale);
            }
            let mut payload = serde_json::to_value(i).map_err(|_| Error::Invalid)?;
            payload["purpose"] = json!(KIND);
            let mut r = planning::record(
                &t.source,
                "global-connections".into(),
                i.binding.clone(),
                payload,
            )?;
            j.save_planning(r.clone())?;
            if let Err(e) = t.local().and_then(|_| check()) {
                r.not_sent = true;
                j.save_planning(r)?;
                return Err(e);
            }
            if let Ok(receipt) = t.planning_operation(&r.operation, false).await {
                r.receipt = Some(receipt);
                if j.save_planning(r.clone()).is_err() {
                    j.poison();
                    return Err(Error::Unknown);
                }
            }
            outcome = json!({"operationId":r.id(),"state":r.receipt.as_ref().map(|r| r["state"].clone()).unwrap_or(json!("unknown"))});
        }
        Command::ConnectionsCheck(id) => {
            let mut r = j
                .planning
                .get(id)
                .filter(|r| {
                    r.source.profile == t.source.profile
                        && r.source.home == t.source.home
                        && r.operation["kind"] == KIND
                })
                .cloned()
                .ok_or(Error::Unknown)?;
            t.profile_gate().await?;
            check()?;
            if r.pending()
                && let Ok(receipt) = t.planning_operation(&r.operation, true).await
            {
                r.receipt = Some(receipt);
                j.save_planning(r.clone())?;
            }
            outcome = json!({"state":r.receipt.as_ref().map(|r| r["state"].clone()).unwrap_or(json!("unknown"))});
        }
        _ => return Err(Error::Invalid),
    }
    let snapshot = read(t).await;
    if matches!(command, Command::ConnectionsRead) {
        check()?;
        return Ok(json!({"snapshot":snapshot?,"operations":summaries(t,j)}));
    }
    Ok(
        json!({"snapshot":snapshot.ok().filter(|_| check().is_ok()),"operations":summaries(t,j),"outcome":outcome}),
    )
}
