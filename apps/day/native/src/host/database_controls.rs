//! Native connections. Cached reads and durable, lookup-only mutations.
use super::{Error, Journal, Shared, Transport, planning};
use crate::bridge::{Command, Gate};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex, atomic::Ordering};

pub(super) struct Cache {
    source: super::Source,
    epoch: u64,
    fresh: bool,
    value: Value,
}
pub(super) async fn refresh(t: &Transport, shared: &Shared, epoch: u64) -> Result<(), Error> {
    shared.database_wanted.store(true, Ordering::SeqCst);
    if t.source.project.is_none() {
        return Err(Error::Unavailable);
    }
    let value = match read(t).await.and_then(|value| {
        shared.current(epoch)?;
        Ok(value)
    }) {
        Ok(value) => value,
        Err(error) => {
            let mut cache = shared
                .database_cache
                .lock()
                .expect("database cache poisoned");
            if let Some(cache) = cache.as_mut().filter(|c| c.source == t.source) {
                cache.fresh = false;
            }
            drop(cache);
            shared.change(|_| ());
            return Err(error);
        }
    };
    *shared
        .database_cache
        .lock()
        .expect("database cache poisoned") = Some(Cache {
        source: t.source.clone(),
        epoch,
        fresh: true,
        value,
    });
    shared.change(|_| ());
    Ok(())
}
fn cached(t: &Transport, shared: &Shared, j: &Journal) -> Value {
    let cache = shared
        .database_cache
        .lock()
        .expect("database cache poisoned");
    let cache = cache.as_ref().filter(|c| c.source == t.source);
    json!({"snapshot":cache.map(|c|&c.value),"current":cache.is_some_and(|c|c.fresh && shared.current(c.epoch).is_ok()),"operations":summaries(t,j)})
}

pub(super) const KIND: &str = "database-controls";
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Intent {
    pub binding: String,
    pub action: String,
    pub value: Value,
}
impl Intent {
    pub(crate) fn validate(&self) -> Result<(), Error> {
        let valid = match self.action.as_str() {
            "edit" => valid_edit(&self.value),
            "test" => {
                self.value.as_object().is_some_and(|o| o.len() == 2)
                    && self.value["env"].as_str().is_some_and(environment)
                    && matches!(self.value["mode"].as_str(), Some("read" | "write"))
            }
            "decide" => {
                self.value.as_object().is_some_and(|o| o.len() == 3)
                    && self.value["agentId"].as_str().is_some_and(super::valid_id)
                    && self.value["requestId"]
                        .as_str()
                        .is_some_and(super::valid_id)
                    && self.value["allow"].is_boolean()
            }
            "revoke" => {
                self.value.as_object().is_some_and(|o| o.len() == 3)
                    && self.value["agentId"].as_str().is_some_and(super::valid_id)
                    && self.value["env"].as_str().is_some_and(environment)
                    && matches!(self.value["mode"].as_str(), Some("read" | "write"))
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
fn safe_url(s: &str) -> bool {
    reqwest::Url::parse(s).is_ok_and(|u| {
        matches!(u.scheme(), "postgres" | "postgresql")
            && u.host_str().is_some()
            && u.password().is_none()
            && u.query().is_none()
            && u.fragment().is_none()
    })
}
pub(super) fn validate_record(source: &super::Source, op: &Value) -> Result<(), Error> {
    let mut p: Value = serde_json::from_str(op["payload"].as_str().ok_or(Error::Storage)?)
        .map_err(|_| Error::Storage)?;
    if p["purpose"] != KIND
        || op["targetId"] != source.project()?.project_id
        || p["projectId"] != source.project()?.project_id
    {
        return Err(Error::Storage);
    }
    p.as_object_mut().ok_or(Error::Storage)?.remove("purpose");
    p.as_object_mut().ok_or(Error::Storage)?.remove("projectId");
    let i: Intent = serde_json::from_value(p).map_err(|_| Error::Storage)?;
    if i.action == "save" {
        if !valid_settings(&i.value) {
            return Err(Error::Storage);
        }
    } else {
        i.validate()?;
    }
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
    let valid = r["confirmed"] == true && r["projectId"] == p["projectId"];
    if valid { Ok(()) } else { Err(Error::Unknown) }
}
async fn read(t: &Transport) -> Result<Value, Error> {
    t.gate(false).await?;
    let project = &t.source.project()?.project_id;
    let v = t
        .get(&format!("/api/database-controls?projectId={project}"))
        .await?;
    if v["version"] != 1
        || v["projectId"] != *project
        || !v["settings"]["environments"].is_array()
        || !v["agents"].is_array()
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
    if matches!(command, Command::DatabasesRead) {
        check()?;
        return Ok(cached(t, shared, j));
    }
    match command {
        Command::DatabasesRefresh => {}
        Command::DatabasesWrite(i) => {
            i.validate()?;
            // Reducing authority must remain possible while another action is Unknown.
            if !summaries(t, j).is_empty() && i.action != "revoke" {
                return Err(Error::Unknown);
            }
            let current = read(t).await?;
            check()?;
            if current["binding"] != i.binding {
                return Err(Error::Stale);
            }
            let mut payload = serde_json::to_value(i).map_err(|_| Error::Invalid)?;
            if i.action == "edit" {
                payload["action"] = json!("save");
                payload["value"] = edit_settings(&i.value, &current)?;
            }
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
            outcome = json!({"operationId":r.id(),"state":r.receipt.as_ref().map(|r| r["state"].clone()).unwrap_or(json!("unknown")),"receipt":r.receipt});
        }
        Command::DatabasesCheck(id) => {
            let mut r = j
                .planning
                .get(id)
                .filter(|r| r.source == t.source && r.operation["kind"] == KIND)
                .cloned()
                .ok_or(Error::Unknown)?;
            t.gate(false).await?;
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
    let _ = refresh(t, shared, shared.epoch.load(Ordering::SeqCst)).await;
    check()?;
    let mut result = cached(t, shared, j);
    result["outcome"] = outcome;
    Ok(result)
}

fn environment(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.as_bytes()[0].is_ascii_alphanumeric()
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}
fn valid_settings(v: &Value) -> bool {
    // Same 64 KiB ceiling as database.json, before copying a settings payload into either journal.
    if v.to_string().len() > 64 * 1024
        || v.as_object()
            .is_none_or(|o| o.len() != 1 || !o.contains_key("environments"))
    {
        return false;
    }
    v["environments"].as_array().is_some_and(|a| {
        a.iter().all(|e| {
            e.as_object().is_some_and(|o| {
                o.keys()
                    .all(|k| matches!(k.as_str(), "name" | "read" | "write"))
            }) && e["name"].as_str().is_some_and(environment)
                && ["read", "write"].iter().all(|m| {
                    if e.get(*m).is_none() {
                        return true;
                    }
                    e[*m].as_object().is_some_and(|o| {
                        o.iter().all(|(k, v)| match k.as_str() {
                            "url" => v.as_str().is_some_and(safe_url),
                            "tlsException" => {
                                v.is_null()
                                    || (v.as_object().is_some_and(|o| o.len() == 2)
                                        && v["name"].as_str().is_some_and(|n| {
                                            !n.is_empty()
                                                && n.len() <= 80
                                                && n.bytes().all(|b| {
                                                    b.is_ascii_alphanumeric()
                                                        || b" ._-".contains(&b)
                                                })
                                        })
                                        && matches!(
                                            v["mode"].as_str(),
                                            Some("plaintext" | "unverified")
                                        ))
                            }
                            _ => false,
                        })
                    })
                })
        })
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn credentials_never_enter_the_command_journal() {
        for url in [
            "postgres://u:****@host/db",
            "postgres://u@host/db?password=secret",
            "postgres://u@host/db#secret",
        ] {
            assert!(!safe_url(url));
        }
        assert!(safe_url("postgres://reader@host:5432/db"));
        assert!(environment("prod.eu-1"));
        assert!(!valid_settings(
            &json!({"environments":[{"name":"prod","read":{"password":"secret"}}]})
        ));
        assert!(valid_settings(
            &json!({"environments":[{"name":"prod","read":{}}]})
        ));
    }

    #[test]
    fn destination_edit_preserves_only_unchanged_credentials_and_accepts_dotted_revocation() {
        let current = json!({"projectId":"atlas","settings":{"environments":[{"name":"prod.eu-1","read":{"host":"host","port":"5432","user":"reader","database":"app"},"write":{"host":"host","port":"5432","user":"writer","database":"app"}}]}});
        let mut edit = json!({"projectId":"atlas","name":"prod.eu-1","mode":"read","host":"host:5432","user":"reader","database":"app","transport":"verified","exception":""});
        assert!(valid_edit(&edit));
        let saved = edit_settings(&edit, &current).unwrap();
        assert!(saved["environments"][0]["read"].get("url").is_none());
        assert_eq!(saved["environments"][0]["write"], json!({}));
        edit["host"] = json!("other:5432");
        assert_eq!(
            edit_settings(&edit, &current).unwrap()["environments"][0]["read"]["url"],
            "postgres://reader@other:5432/app"
        );
        edit["host"] = json!("u:secret@other");
        assert_eq!(edit_settings(&edit, &current), Err(Error::Invalid));
        let revoke = Intent {
            binding: "a".repeat(64),
            action: "revoke".into(),
            value: json!({"agentId":"agent","env":"prod.eu-1","mode":"read"}),
        };
        assert!(revoke.validate().is_ok());
    }
}

fn valid_edit(v: &Value) -> bool {
    v.as_object().is_some_and(|o| {
        o.len() == 8
            && o.keys().all(|k| {
                [
                    "name",
                    "mode",
                    "host",
                    "user",
                    "database",
                    "transport",
                    "exception",
                    "projectId",
                ]
                .contains(&k.as_str())
            })
    }) && v["name"].as_str().is_some_and(environment)
        && ["host", "user", "database", "projectId"]
            .iter()
            .all(|k| v[*k].as_str().is_some_and(|s| !s.is_empty()))
        && matches!(v["mode"].as_str(), Some("read" | "write"))
        && matches!(
            v["transport"].as_str(),
            Some("verified" | "plaintext" | "unverified")
        )
        && v["exception"].is_string()
}
fn edit_settings(v: &Value, current: &Value) -> Result<Value, Error> {
    if v["projectId"] != current["projectId"] {
        return Err(Error::Stale);
    }
    let name = v["name"].as_str().ok_or(Error::Invalid)?;
    let mode = v["mode"].as_str().ok_or(Error::Invalid)?;
    let host = v["host"].as_str().ok_or(Error::Invalid)?;
    let user = v["user"].as_str().ok_or(Error::Invalid)?;
    let database = v["database"].as_str().ok_or(Error::Invalid)?;
    let mut url = reqwest::Url::parse(&format!("postgres://{host}")).map_err(|_| Error::Invalid)?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !matches!(url.path(), "" | "/")
        || url.host_str().is_none()
    {
        return Err(Error::Invalid);
    }
    url.set_username(user).map_err(|_| Error::Invalid)?;
    url.path_segments_mut()
        .map_err(|_| Error::Invalid)?
        .clear()
        .push(database);
    let source = current["settings"]["environments"]
        .as_array()
        .ok_or(Error::Invalid)?;
    let mut environments: Vec<Value> = source
        .iter()
        .map(|e| {
            let mut out = json!({"name":e["name"]});
            for m in ["read", "write"] {
                if e.get(m).is_some() {
                    out[m] = json!({});
                }
            }
            out
        })
        .collect();
    let old = source.iter().find(|e| e["name"] == name).map(|e| &e[mode]);
    let unchanged = old.is_some_and(|o| {
        let port = o["port"].as_str().unwrap_or("");
        let original = o["host"].as_str().unwrap_or("");
        let bracketed = if original.contains(':') && !original.starts_with('[') {
            format!("[{original}]")
        } else {
            original.to_owned()
        };
        let old_host = if port.is_empty() {
            bracketed
        } else {
            format!("{bracketed}:{port}")
        };
        old_host == host && o["user"] == user && o["database"] == database
    });
    let mut connection = json!({"tlsException":if v["transport"]=="verified" {Value::Null} else {json!({"name":v["exception"],"mode":v["transport"]})}});
    if !unchanged {
        connection["url"] = json!(url.to_string());
    }
    if let Some(e) = environments.iter_mut().find(|e| e["name"] == name) {
        e[mode] = connection;
    } else {
        environments.push(json!({"name":name,mode:connection}));
    }
    let out = json!({"environments":environments});
    if !valid_settings(&out) {
        return Err(Error::Invalid);
    }
    Ok(out)
}
