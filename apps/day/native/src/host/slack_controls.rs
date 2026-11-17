//! Project-scoped Slack settings and imports, journaled before dispatch. Check never resends.
use super::{Error, Journal, Shared, Transport, planning};
use crate::bridge::{Command, Gate};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

pub(super) const KIND: &str = "slack-controls";
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Intent {
    pub binding: String,
    pub action: String,
    pub value: Value,
}
fn strings(v: &Value, max: usize) -> bool {
    v.as_array().is_some_and(|a| {
        a.len() <= max
            && a.iter().all(|s| {
                s.as_str()
                    .is_some_and(|s| !s.trim().is_empty() && s.len() <= 200)
            })
    })
}
// Keep arbitrary URLs and credentials out of both durable command journals.
fn safe_link(s: &str) -> bool {
    if s.len() > 2000 {
        return false;
    }
    let Ok(url) = reqwest::Url::parse(s) else {
        return false;
    };
    let host = url.host_str().unwrap_or("");
    let Some(workspace) = host.strip_suffix(".slack.com") else {
        return false;
    };
    let parts: Vec<_> = url.path().trim_end_matches('/').split('/').collect();
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && url.fragment().is_none()
        && !workspace.is_empty()
        && workspace
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && parts.len() == 4
        && parts[1] == "archives"
        && channel(parts[2])
        && parts[3]
            .strip_prefix('p')
            .is_some_and(|n| (16..=18).contains(&n.len()) && n.bytes().all(|b| b.is_ascii_digit()))
        && url.query_pairs().all(|(key, value)| match key.as_ref() {
            "thread_ts" => value.split_once('.').is_some_and(|(s, micros)| {
                !s.is_empty()
                    && s.len() <= 12
                    && s.bytes().all(|b| b.is_ascii_digit())
                    && micros.len() == 6
                    && micros.bytes().all(|b| b.is_ascii_digit())
            }),
            "cid" => channel(&value),
            _ => false,
        })
}
fn channel(s: &str) -> bool {
    (2..=200).contains(&s.len())
        && matches!(s.as_bytes()[0], b'C' | b'D' | b'G')
        && s.bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
}
impl Intent {
    pub(crate) fn validate(&self) -> Result<(), Error> {
        let valid = match self.action.as_str() {
            "save" => {
                self.value.as_object().is_some_and(|o| {
                    o.len() == 3
                        && o.keys()
                            .all(|k| ["channels", "mentionOnly", "groups"].contains(&k.as_str()))
                }) && strings(&self.value["channels"], 100)
                    && strings(&self.value["mentionOnly"], 100)
                    && strings(&self.value["groups"], 100)
            }
            "import" => {
                self.value.as_object().is_some_and(|o| o.len() == 1)
                    && self.value["url"].as_str().is_some_and(safe_link)
            }
            "open" => {
                self.value.as_object().is_some_and(|o| {
                    (o.len() == 2 || o.len() == 3)
                        && o.keys()
                            .all(|k| ["itemId", "digest", "offset"].contains(&k.as_str()))
                }) && self.value["itemId"].as_str().is_some_and(super::valid_id)
                    && self.value["digest"]
                        .as_str()
                        .is_some_and(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()))
            }
            "report" | "group" => {
                // Closed, size-limited JSON only. The worker enforces exact shown-row/group CAS.
                self.value.as_object().is_some_and(|o| {
                    (o.len() == 3 || o.len() == 4)
                        && o.keys().all(|k| {
                            if self.action == "report" {
                                ["itemId", "patch", "digest", "offset"].contains(&k.as_str())
                            } else {
                                ["caseId", "edit", "digest", "offset"].contains(&k.as_str())
                            }
                        })
                        && self.value["digest"].as_str().is_some_and(|s| {
                            s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
                        })
                        && if self.action == "report" {
                            self.value["itemId"].as_str().is_some_and(super::valid_id)
                                && self.value["patch"].as_object().is_some_and(|p| {
                                    !p.is_empty()
                                        && p.keys().all(|k| {
                                            ["details", "type", "label", "severity", "status"]
                                                .contains(&k.as_str())
                                        })
                                })
                        } else {
                            self.value["caseId"].as_str().is_some_and(super::valid_id)
                                && self.value["edit"].is_object()
                        }
                }) && serde_json::to_vec(&self.value).is_ok_and(|v| v.len() <= 16_384)
            }
            _ => false,
        };
        if valid
            && (self.value.get("offset").is_none()
                || self.value["offset"]
                    .as_u64()
                    .is_some_and(|n| n <= 1_000_000))
            && self.binding.len() == 64
            && self.binding.bytes().all(|b| b.is_ascii_hexdigit())
        {
            Ok(())
        } else {
            Err(Error::Invalid)
        }
    }
}
pub(super) fn validate_record(source: &super::Source, op: &Value) -> Result<(), Error> {
    let mut p: Value = serde_json::from_str(op["payload"].as_str().ok_or(Error::Storage)?)
        .map_err(|_| Error::Storage)?;
    if p["purpose"] != KIND
        || p["projectId"] != source.project()?.project_id
        || op["targetId"] != p["projectId"]
    {
        return Err(Error::Storage);
    }
    let o = p.as_object_mut().ok_or(Error::Storage)?;
    o.remove("purpose");
    o.remove("projectId");
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
    if r["action"] == p["action"]
        && r["projectId"] == p["projectId"]
        && r["saved"] == true
        && (p["action"] != "import" || r["itemId"].as_str().is_some_and(super::valid_id))
    {
        Ok(())
    } else {
        Err(Error::Unknown)
    }
}
async fn read_page(t: &Transport, offset: u32) -> Result<Value, Error> {
    let project = &t.source.project()?.project_id;
    t.gate(false).await?;
    let v = t
        .get(&format!(
            "/api/slack-controls?projectId={project}&offset={offset}"
        ))
        .await?;
    if v["version"] != 1
        || v["projectId"] != *project
        || v["binding"]
            .as_str()
            .is_none_or(|s| s.len() != 64 || !s.bytes().all(|b| b.is_ascii_hexdigit()))
        || !v["channels"].is_array()
        || !v["config"]["channels"].is_array()
    {
        return Err(Error::Invalid);
    }
    t.gate(false).await?;
    Ok(v)
}
fn summaries(t: &Transport, j: &Journal) -> Vec<Value> {
    j.planning
        .values()
        .filter(|r| r.source == t.source && r.operation["kind"] == KIND && r.pending())
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
    let offset = match command {
        Command::SlackRead(n) => *n,
        Command::SlackWrite(i) => i.value["offset"].as_u64().unwrap_or(0) as u32,
        _ => 0,
    };
    match command {
        Command::SlackRead(_) => {}
        Command::SlackWrite(i) => {
            i.validate()?;
            if i.action == "open" {
                let opener = shared.url_opener.as_ref().ok_or(Error::Unavailable)?;
                let qualify = |snapshot: &Value| -> Result<String, Error> {
                    if snapshot["binding"] != i.binding
                        || snapshot["reports"]["digest"] != i.value["digest"]
                    {
                        return Err(Error::Stale);
                    }
                    let item = snapshot["reports"]["items"]
                        .as_array()
                        .ok_or(Error::Invalid)?
                        .iter()
                        .find(|r| r["id"] == i.value["itemId"])
                        .ok_or(Error::Stale)?;
                    let url = item["url"].as_str().ok_or(Error::Invalid)?;
                    let mut checked = reqwest::Url::parse(url).map_err(|_| Error::Invalid)?;
                    if checked.host_str() == Some("slack.com") {
                        checked
                            .set_host(Some("source.slack.com"))
                            .map_err(|_| Error::Invalid)?;
                    }
                    if !safe_link(checked.as_str()) {
                        return Err(Error::Invalid);
                    }
                    Ok(url.to_owned())
                };
                let url = qualify(&read_page(t, offset).await?)?;
                if qualify(&read_page(t, offset).await?)? != url {
                    return Err(Error::Stale);
                }
                t.local()?;
                let guard = gate.lock().expect("bridge gate poisoned");
                shared.open()?;
                command.admit(&guard)?;
                opener(&url).map_err(|_| Error::Unknown)?;
                return Ok(json!({"outcome":{"state":"opened"},"operations":summaries(t,j)}));
            }
            if !summaries(t, j).is_empty() {
                return Err(Error::Unknown);
            }
            let current = read_page(t, offset).await?;
            check()?;
            if current["binding"] != i.binding {
                return Err(Error::Stale);
            }
            let mut payload = serde_json::to_value(i).map_err(|_| Error::Invalid)?;
            payload["purpose"] = json!(KIND);
            payload["projectId"] = json!(t.source.project()?.project_id);
            let mut r = planning::record(
                &t.source,
                t.source.project()?.project_id.clone(),
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
            outcome = json!({"operationId":r.id(),"state":r.receipt.as_ref().map(|r|r["state"].clone()).unwrap_or(json!("unknown")),"receipt":r.receipt});
        }
        Command::SlackCheck(id) | Command::SlackSetAside(id) => {
            let mut r = j
                .planning
                .get(id)
                .filter(|r| r.source == t.source && r.operation["kind"] == KIND)
                .cloned()
                .ok_or(Error::Unknown)?;
            t.gate(false).await?;
            check()?;
            let setting_aside = matches!(command, Command::SlackSetAside(_));
            if r.receipt.as_ref().is_none_or(|r| r["state"] == "pending") {
                // Set aside requires a fresh successful lookup, not a cached Pending or a failed read.
                let reply = t.raw_operation(&r.operation, true).await?;
                let missing = setting_aside && reply == json!({"state":"unknown"});
                if !missing {
                    r.receipt = Some(planning::exact(reply, &r.operation)?);
                }
                check()?;
                if missing
                    || (setting_aside
                        && r.receipt.as_ref().is_some_and(|r| r["state"] == "pending"))
                {
                    r.dismissed = true;
                }
                j.save_planning(r.clone())?;
            }
            outcome = json!({"state":if setting_aside && r.dismissed {json!("set-aside")} else {r.receipt.as_ref().map(|r|r["state"].clone()).unwrap_or(json!("unknown"))},"receipt":r.receipt});
        }
        _ => return Err(Error::Invalid),
    }
    let snapshot = read_page(t, offset).await.map(|mut v| {
        v["canOpenUrl"] = json!(shared.url_opener.is_some());
        v
    });
    if matches!(command, Command::SlackRead(_)) {
        check()?;
        return Ok(json!({"snapshot":snapshot?,"operations":summaries(t,j)}));
    }
    Ok(
        json!({"snapshot":snapshot.ok().filter(|_|check().is_ok()),"operations":summaries(t,j),"outcome":outcome}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn links_refuse_secrets_before_journaling() {
        assert!(safe_link(
            "https://example.slack.com/archives/C123/p1794843000000001?thread_ts=1794843000.000001&cid=C123"
        ));
        for url in [
            "https://user:secret@example.slack.com/archives/C123/p1794843000000001",
            "https://example.slack.com/archives/C123/p1794843000000001?token=secret",
            "https://example.slack.com/archives/C123/p1794843000000001#secret",
            "https://example.test/archives/C123/p1794843000000001",
        ] {
            assert!(!safe_link(url));
        }
    }
}
