//! Explicit diagnostics and privacy intents on the existing native receipt ledger.
use super::{Error, Journal, Shared, Source, Transport, planning};
use crate::bridge::{Command, Gate};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

pub(super) const KIND: &str = "diagnostics-controls";
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Intent {
    pub binding: String,
    pub action: String,
    pub value: Value,
}

/// Paths can contain credentials too. Reject them before either command journal.
pub(crate) fn safe_endpoint(s: &str) -> bool {
    if s.len() > 512 || s.trim() != s {
        return false;
    }
    let Ok(u) = reqwest::Url::parse(s) else {
        return false;
    };
    let local = matches!(u.host_str(), Some("127.0.0.1" | "[::1]" | "::1"));
    (u.scheme() == "https" || (u.scheme() == "http" && local))
        && u.username().is_empty()
        && u.password().is_none()
        && u.query().is_none()
        && u.fragment().is_none()
        && ["", "/", "/v1/traces"].contains(&u.path())
        && !s.contains(['%', '\\'])
        && s.strip_prefix(&format!("{}://", u.scheme()))
            .is_some_and(|rest| {
                let path = rest.find('/').map(|i| &rest[i..]).unwrap_or("");
                ["", "/", "/v1/traces"].contains(&path)
            })
}
impl Intent {
    pub(crate) fn validate(&self) -> Result<(), Error> {
        let valid = match self.action.as_str() {
            "save" => self.value.as_object().is_some_and(|o| {
                [
                    "localDiagnostics",
                    "localFeatureUsage",
                    "remoteOperational",
                    "productAnalytics",
                ]
                .iter()
                .all(|k| o.get(*k).is_some_and(Value::is_boolean))
                    && o.keys().all(|k| {
                        [
                            "localDiagnostics",
                            "localFeatureUsage",
                            "remoteOperational",
                            "productAnalytics",
                            "endpoint",
                        ]
                        .contains(&k.as_str())
                    })
                    && o.get("endpoint")
                        .is_none_or(|v| v.as_str().is_some_and(safe_endpoint))
                    && (self.value["remoteOperational"] != true
                        || self.value["endpoint"].is_string())
            }),
            "clear" => self.value.is_null(),
            "start" => self.value.as_object().is_some_and(|o| {
                o.len() == 3
                    && ["model", "thinking", "question"].iter().all(|k| {
                        o.get(*k)
                            .is_some_and(|s| s.as_str().is_some_and(|s| !s.trim().is_empty()))
                    })
                    && self.value["model"].as_str().is_some_and(|s| s.len() <= 256)
                    && self.value["thinking"]
                        .as_str()
                        .is_some_and(|s| s.len() <= 32)
                    && self.value["question"]
                        .as_str()
                        .is_some_and(|s| s.len() <= 8192)
            }),
            "send" => {
                self.value.as_object().is_some_and(|o| o.len() == 2)
                    && self.value["sessionId"]
                        .as_str()
                        .is_some_and(super::valid_id)
                    && self.value["message"]
                        .as_str()
                        .is_some_and(|s| !s.trim().is_empty() && s.len() <= 8192)
            }
            _ => false,
        };
        if valid
            && self.binding.len() == 64
            && self
                .binding
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        {
            Ok(())
        } else {
            Err(Error::Invalid)
        }
    }
}
pub(super) fn validate_record(op: &Value) -> Result<(), Error> {
    let mut p: Value = serde_json::from_str(op["payload"].as_str().ok_or(Error::Storage)?)
        .map_err(|_| Error::Storage)?;
    if p.as_object_mut().ok_or(Error::Storage)?.remove("purpose") != Some(json!(KIND))
        || op["targetId"] != "global-diagnostics"
    {
        return Err(Error::Storage);
    }
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
        Some("save" | "clear") => r["saved"] == true,
        Some("start") => r["sessionId"].as_str().is_some_and(super::valid_id),
        Some("send") => r["sessionId"] == p["value"]["sessionId"],
        _ => false,
    };
    if valid { Ok(()) } else { Err(Error::Unknown) }
}

pub(super) async fn log_controls(source: &Source, settings: &Value, clear: bool) -> bool {
    let token = crate::day_log::admit_control();
    log_controls_at(source, settings, clear, token).await
}
pub(super) async fn log_controls_at(
    source: &Source,
    settings: &Value,
    clear: bool,
    token: u64,
) -> bool {
    let binding = planning::hash(&format!(
        "daemon\0{}\0{}",
        source.home.daemon_id, source.home.lineage_id
    ));
    let settings = settings.clone();
    tokio::task::spawn_blocking(move || {
        crate::day_log::configure(token, &binding, &settings, clear)
    })
    .await
    .unwrap_or(false)
}
async fn read(t: &Transport) -> Result<Value, Error> {
    t.profile_gate().await?;
    let v = t.get("/api/diagnostics-controls").await?;
    if v["version"] != 1
        || v["host"]["daemonId"] != t.source.home.daemon_id
        || v["host"]["lineageId"] != t.source.home.lineage_id
        || v["host"]["hostId"] != "daemon"
        || !v["models"].is_array()
        || !v["chats"]["items"].is_array()
    {
        return Err(Error::Invalid);
    }
    t.profile_gate().await?;
    Ok(v)
}
fn operations(t: &Transport, j: &Journal) -> Vec<Value> {
    j.planning.values().filter(|r| r.source.profile == t.source.profile && r.source.home == t.source.home && r.operation["kind"] == KIND)
        .map(|r| json!({"operationId":r.id(),"pending":r.pending(),"state":if r.not_sent {json!("not-sent")} else {r.receipt.as_ref().map(|r| r["state"].clone()).unwrap_or(json!("unknown"))},"receipt":r.receipt})).collect()
}
fn unresolved_revoke(source: &Source, record: &planning::PlanningRecord) -> bool {
    if record.source.profile != source.profile
        || record.source.home != source.home
        || record.operation["kind"] != KIND
        || !record.pending()
    {
        return false;
    }
    record_is_revoke(record)
}
fn record_is_revoke(record: &planning::PlanningRecord) -> bool {
    let p: Value = serde_json::from_str(record.operation["payload"].as_str().unwrap_or(""))
        .unwrap_or(Value::Null);
    p["action"] == "save"
        && p["value"]
            == json!({"localDiagnostics":false,"localFeatureUsage":false,"remoteOperational":false,"productAnalytics":false})
}
/// Restore only a local no-collection hold. Never resend the service intent.
pub(super) async fn restore_log_hold(t: &Transport, j: &Journal) {
    if j.planning.values().any(|r| unresolved_revoke(&t.source, r)) {
        let token = crate::day_log::revoke_control();
        log_controls_at(&t.source, &Value::Null, false, token).await;
    }
}
pub(super) async fn handle(
    t: &Transport,
    j: &mut Journal,
    shared: &Shared,
    command: &Command,
    gate: &Arc<Mutex<Gate>>,
) -> Result<Value, Error> {
    let revoke = matches!(command,Command::DiagnosisWrite(i) if i.action == "save" && i.value == json!({"localDiagnostics":false,"localFeatureUsage":false,"remoteOperational":false,"productAnalytics":false}));
    let mut authority = 0;
    let stopped = if revoke {
        shared.open()?;
        command.admit(&gate.lock().expect("bridge gate poisoned"))?;
        let token = crate::day_log::revoke_control();
        authority = token;
        log_controls_at(&t.source, &Value::Null, false, token).await
    } else {
        false
    };
    match handle_inner(t, j, shared, command, gate).await {
        Ok(mut v) => {
            if let Some(authority) = off_receipt_authority(command, &v, authority) {
                // Fence every read begun before the durable off receipt. A
                // subsequent explicit enable need not wait for a WS off frame.
                let token = crate::day_log::admit_control();
                let _ = tokio::task::spawn_blocking(move || {
                    crate::day_log::confirm_off(token, authority)
                })
                .await;
            }
            if revoke {
                v["appStopped"] = json!(stopped);
            }
            Ok(v)
        }
        Err(_) if revoke => Ok(
            json!({"snapshot":null,"operations":operations(t,j),"outcome":{"state":"unknown"},"appStopped":stopped}),
        ),
        Err(e) => Err(e),
    }
}
/// A receipt lookup is historical evidence, never fresh hold-release authority.
pub(crate) fn off_receipt_authority(
    command: &Command,
    result: &Value,
    authority: u64,
) -> Option<u64> {
    (result["outcome"]["state"] == "accepted" && matches!(command,Command::DiagnosisWrite(i) if i.action == "save" && i.value == json!({"localDiagnostics":false,"localFeatureUsage":false,"remoteOperational":false,"productAnalytics":false}))).then_some(authority)
}
async fn handle_inner(
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
    let mut app_cleared = Value::Null;
    match command {
        Command::DiagnosisRead => {}
        Command::DiagnosisWrite(i) => {
            i.validate()?;
            let revoke = i.action == "save"
                && i.value
                    == json!({"localDiagnostics":false,"localFeatureUsage":false,"remoteOperational":false,"productAnalytics":false});
            if !revoke && operations(t, j).iter().any(|r| r["pending"] == true) {
                return Err(Error::Unknown);
            }
            let mut binding = i.binding.clone();
            if revoke {
                t.profile_gate().await?;
                check()?;
            } else {
                let authority = crate::day_log::revoke_authority();
                let token = crate::day_log::admit_control();
                let current = read(t).await?;
                check()?;
                if current["binding"] != i.binding {
                    // The binding also hashes every chat and model. When only those moved,
                    // the settings the user edits are the same: save against the current read.
                    binding = shared
                        .shown_settings
                        .rebind(KIND, &i.binding, &current, |v| {
                            super::shown::without(v, &["chats", "models"])
                        })
                        .ok_or(Error::Stale)?;
                }
                let s = &current["settings"];
                if s["localDiagnostics"] == false
                    && s["nextDiagnostics"]["schemaVersion"] == 1
                    && s["nextDiagnostics"]["epoch"]
                        .as_u64()
                        .is_some_and(|n| n <= 281_474_976_710_655)
                {
                    let _ = tokio::task::spawn_blocking(move || {
                        crate::day_log::confirm_off(token, authority)
                    })
                    .await;
                }
            }
            let mut payload = serde_json::to_value(i).map_err(|_| Error::Invalid)?;
            payload["purpose"] = json!(KIND);
            payload["binding"] = json!(binding);
            let mut r = planning::record(&t.source, "global-diagnostics".into(), binding, payload)?;
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
            if i.action == "clear" && r.receipt.as_ref().is_none_or(|r| r["state"] != "rejected") {
                // Own writer clearing is independent of service acceptance. Never claim another process's writer.
                app_cleared = json!(log_controls(&t.source, &Value::Null, true).await);
            }
            outcome = json!({"operationId":r.id(),"state":r.receipt.as_ref().map(|r| r["state"].clone()).unwrap_or(json!("unknown")),"receipt":r.receipt});
        }
        Command::DiagnosisCheck(id) => {
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
            outcome = json!({"operationId":r.id(),"state":r.receipt.as_ref().map(|r| r["state"].clone()).unwrap_or(json!("unknown")),"receipt":r.receipt});
        }
        _ => return Err(Error::Invalid),
    }
    let revoke = matches!(command, Command::DiagnosisWrite(i) if i.action == "save" && i.value == json!({"localDiagnostics":false,"localFeatureUsage":false,"remoteOperational":false,"productAnalytics":false}));
    let snapshot = if revoke {
        Err(Error::Unavailable)
    } else {
        read(t).await
    };
    if let Ok(v) = &snapshot {
        shared.shown_settings.remember(KIND, v);
    }
    if matches!(command, Command::DiagnosisRead) {
        check()?;
        return Ok(json!({"snapshot":snapshot?,"operations":operations(t,j)}));
    }
    Ok(
        json!({"snapshot":snapshot.ok().filter(|_| check().is_ok()),"operations":operations(t,j),"outcome":outcome,"appCleared":app_cleared}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unresolved_revoke_restores_only_the_exact_homes_local_hold() {
        let source = Source {
            profile: "/profile".into(),
            port: 1,
            home: crate::contract::Home {
                daemon_id: "daemon".into(),
                lineage_id: "lineage".into(),
            },
            project: None,
        };
        let mut r=planning::record(&source,"global-diagnostics".into(),"0".repeat(64),json!({"purpose":KIND,"binding":"0".repeat(64),"action":"save","value":{"localDiagnostics":false,"localFeatureUsage":false,"remoteOperational":false,"productAnalytics":false}})).unwrap();
        assert!(unresolved_revoke(&source, &r));
        let mut other = source.clone();
        other.home.lineage_id = "other".into();
        assert!(!unresolved_revoke(&other, &r));
        r.not_sent = true;
        assert!(!unresolved_revoke(&source, &r));
        r.not_sent = false;
        r.receipt = Some(json!({"state":"accepted"}));
        assert!(!unresolved_revoke(&source, &r));
    }

    #[test]
    fn rejects_secret_endpoints_before_journaling() {
        for s in [
            "https://collector.test/secret-token",
            "https://u:p@collector.test",
            "https://collector.test/?key=x",
            "https://collector.test/%76%31/traces",
            "https://collector.test/x/../v1/traces",
            "http://collector.test",
            "http://localhost",
        ] {
            assert!(!safe_endpoint(s), "{s}");
        }
        for s in [
            "https://collector.test",
            "https://collector.test/v1/traces",
            "http://127.0.0.1:4318/v1/traces",
            "http://[::1]:4318/",
        ] {
            assert!(safe_endpoint(s), "{s}");
        }
    }
    #[test]
    fn intent_and_receipt_keep_exact_action() {
        let i = Intent {
            binding: "a".repeat(64),
            action: "clear".into(),
            value: Value::Null,
        };
        assert_eq!(i.validate(), Ok(()));
        let op = json!({"payload":serde_json::to_string(&i).unwrap()});
        assert_eq!(
            exact_result(&op, &json!({"result":{"action":"save","saved":true}})),
            Err(Error::Unknown)
        );
        assert_eq!(
            exact_result(&op, &json!({"result":{"action":"clear","saved":true}})),
            Ok(())
        );
    }
}
