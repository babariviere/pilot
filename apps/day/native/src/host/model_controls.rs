//! Native model settings and ephemeral sign-in. Codes never enter the command ledger.
use super::{Error, Journal, Shared, Transport, planning};
use crate::bridge::{Command, Gate};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

pub(super) const KIND: &str = "model-controls";

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
            "funding-settings" => self.value.as_object().is_some_and(|o| {
                o.len() == 3
                    && [
                        "missionDefaultMicros",
                        "quickFixDefaultMicros",
                        "dailyMicros",
                    ]
                    .iter()
                    .all(|k| {
                        o.get(*k).is_some_and(|v| {
                            v.is_null() || v.as_u64().is_some_and(|n| n <= 9_007_199_254_740_991)
                        })
                    })
            }),
            "fund-work" => {
                self.value.as_object().is_some_and(|o| o.len() == 2)
                    && self.value["sessionId"]
                        .as_str()
                        .is_some_and(super::valid_id)
                    && self.value["amountMicros"]
                        .as_u64()
                        .is_some_and(|n| n <= 9_007_199_254_740_991)
            }
            "continue-anyway" => self.value.as_str().is_some_and(super::valid_id),
            "funding-limits" => self.value.is_boolean(),
            "background-continue" => matches!(self.value.as_str(), Some("anthropic" | "openai")),
            "scope" => {
                // Same 256-pattern/256-byte contract as daemon model-scope; limits one native request's parsing.
                self.value.is_null()
                    || self.value.as_array().is_some_and(|a| {
                        !a.is_empty()
                            && a.len() <= 256
                            && a.iter().all(|s| {
                                s.as_str().is_some_and(|s| {
                                    !s.trim().is_empty()
                                        && s.len() <= 256
                                        && !s.chars().any(char::is_control)
                                })
                            })
                    })
            }
            "defaults" => {
                // Four small scalar fields (provider/model each <=256 bytes); reject oversized bridge values.
                self.value.as_object().is_some_and(|o| {
                    o.len() == 4
                        && [
                            "defaultProvider",
                            "defaultModel",
                            "defaultThinkingLevel",
                            "pilotTaskPriceLimit",
                        ]
                        .iter()
                        .all(|k| o.contains_key(*k))
                }) && self.value.to_string().len() <= 1024
            }
            "project-model" => {
                self.value.is_null()
                    || self
                        .value
                        .as_str()
                        .is_some_and(|s| !s.is_empty() && s.len() <= 256)
            }
            "work-profiles" => {
                // Same 12-profile limit as the daemon, with its six fields. The daemon checks the rest. The size
                // limit holds the daemon's largest list: 12 profiles of two 8-entry lists, about 60 KB.
                self.value.as_array().is_some_and(|a| {
                    a.len() <= 12
                        && a.iter().all(|p| {
                            p.as_object().is_some_and(|o| {
                                o.len() == 6
                                    && ["id", "name", "covers"]
                                        .iter()
                                        .all(|k| o.get(*k).is_some_and(Value::is_string))
                                    && o.get("optInOnly").is_some_and(Value::is_boolean)
                                    && ["large", "small"]
                                        .iter()
                                        .all(|k| o.get(*k).is_some_and(Value::is_array))
                            })
                        })
                }) && self.value.to_string().len() <= 65_536
            }
            "failed-model" => {
                self.value.as_object().is_some_and(|o| o.len() == 4)
                    && self.value["sessionId"]
                        .as_str()
                        .is_some_and(super::valid_id)
                    && self.value["model"]
                        .as_str()
                        .is_some_and(|m| !m.is_empty() && m.len() <= 256)
                    && self.value["thinking"].as_str().is_some_and(|m| {
                        ["off", "minimal", "low", "medium", "high", "xhigh", "max"].contains(&m)
                    })
                    && self.value["source"]
                        .as_object()
                        .is_some_and(|o| o.len() == 2)
                    && matches!(
                        self.value["source"]["source"].as_str(),
                        Some("startup" | "outcome")
                    )
                    && self.value["source"]["token"]
                        .as_str()
                        .is_some_and(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()))
            }
            "sign-in" => {
                self.value.as_object().is_some_and(|o| o.len() == 2)
                    && self.value["provider"].as_str().is_some_and(super::valid_id)
                    && matches!(
                        self.value["method"].as_str(),
                        Some("device_code" | "manual_code")
                    )
            }
            "cancel" | "logout" => self.value.as_str().is_some_and(super::valid_id),
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

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct SignIn {
    run_id: String,
    action: String,
    challenge_id: Option<String>,
    answer: Option<String>,
}
impl SignIn {
    pub(crate) fn validate(&self) -> Result<(), Error> {
        if !super::valid_id(&self.run_id) {
            return Err(Error::Invalid);
        }
        match self.action.as_str() {
            "read" | "open" if self.answer.is_none() && self.challenge_id.is_none() => Ok(()),
            "answer"
                // Match setup-provider.validManualAnswer's 4096-byte response cap before queueing native work.
                if self.challenge_id.as_deref().is_some_and(super::valid_id)
                    && self
                        .answer
                        .as_ref()
                        .is_some_and(|s| !s.trim().is_empty() && s.len() <= 4096) =>
            {
                Ok(())
            }
            _ => Err(Error::Invalid),
        }
    }
}

pub(super) fn validate_record(source: &super::Source, op: &Value) -> Result<(), Error> {
    let mut p: Value = serde_json::from_str(op["payload"].as_str().ok_or(Error::Storage)?)
        .map_err(|_| Error::Storage)?;
    if p["purpose"] != KIND
        || p["projectId"]
            != source
                .project
                .as_ref()
                .map(|p| p.project_id.clone())
                .map(Value::String)
                .unwrap_or(Value::Null)
        || op["targetId"]
            != source
                .project
                .as_ref()
                .map(|p| p.project_id.as_str())
                .unwrap_or("global-models")
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
    let result = &receipt["result"];
    if result["action"] != p["action"] {
        return Err(Error::Unknown);
    }
    let valid = match p["action"].as_str() {
        Some("sign-in") => {
            result["run"]["id"].as_str().is_some_and(super::valid_id)
                && result["run"]["provider"] == p["value"]["provider"]
                && result["run"]["method"] == p["value"]["method"]
        }
        Some("cancel") => {
            result["run"]["id"] == p["value"]
                && matches!(
                    result["run"]["state"].as_str(),
                    Some("cancelled" | "failed" | "done")
                )
        }
        Some(
            "scope"
            | "defaults"
            | "work-profiles"
            | "project-model"
            | "failed-model"
            | "logout"
            | "funding-settings"
            | "funding-limits"
            | "fund-work"
            | "continue-anyway"
            | "background-continue",
        ) => result["saved"] == true,
        _ => false,
    };
    if valid { Ok(()) } else { Err(Error::Unknown) }
}

async fn read(t: &Transport) -> Result<Value, Error> {
    t.profile_gate().await?;
    let path = t
        .source
        .project
        .as_ref()
        .map(|p| format!("/api/model-controls?projectId={}", p.project_id))
        .unwrap_or_else(|| "/api/model-controls".into());
    let v = t.get(&path).await?;
    if v["version"] != 1
        || !v["binding"].is_string()
        || !v["task"]["models"].is_array()
        || !v["providers"].is_array()
        || v["project"]["id"]
            != t.source
                .project
                .as_ref()
                .map(|p| Value::String(p.project_id.clone()))
                .unwrap_or(Value::Null)
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
        Command::ModelsRead => {}
        Command::ModelsRecovery(id) => {
            t.profile_gate().await?;
            let project = &t.source.project()?.project_id;
            let v = t
                .get(&format!(
                    "/api/model-controls/recovery/{id}?projectId={project}"
                ))
                .await?;
            check()?;
            if v["sessionId"] != *id
                || v["projectId"] != *project
                || !v["choices"]["models"].is_array()
            {
                return Err(Error::Invalid);
            }
            return Ok(json!({"snapshot":v}));
        }
        Command::ModelsSignIn(r) => {
            r.validate()?;
            t.profile_gate().await?;
            let path = format!("/api/model-controls/sign-in/{}", r.run_id);
            let v = t.get(&path).await?;
            check()?;
            if r.action == "read" {
                return Ok(json!({"snapshot":v}));
            }
            if r.action == "open" {
                let url = v["challenge"]["url"].as_str().ok_or(Error::Stale)?;
                shared.url_opener.as_ref().ok_or(Error::Unavailable)?(url)?;
            } else {
                if v["challenge"]["id"] != r.challenge_id.as_deref().unwrap_or("") {
                    return Err(Error::Stale);
                }
                // Ephemeral, send once. Never journal, log or include the answer in an error.
                let response = t
                    .client
                    .post(t.url(&path))
                    .header("x-pilot-github-capability", t.local()?)
                    .header("content-type", "application/json")
                    .body(json!({"challengeId":r.challenge_id,"answer":r.answer}).to_string())
                    .send()
                    .await
                    .map_err(|_| Error::Unknown)?;
                if !response.status().is_success() {
                    return Err(Error::Unknown);
                }
            }
            return Ok(json!({"snapshot":null,"outcome":{"state":"accepted"}}));
        }
        Command::ModelsWrite(i) => {
            i.validate()?;
            if !summaries(t, j).is_empty() && !matches!(i.action.as_str(), "cancel" | "logout") {
                return Err(Error::Unknown);
            }
            let current = read(t).await?;
            check()?;
            let mut binding = i.binding.clone();
            if current["binding"] != i.binding {
                // The binding also hashes the chats that need funding. When only lists of
                // other chats and runs moved, the settings the user edits are the same.
                binding = shared
                    .shown_settings
                    .rebind(KIND, &i.binding, &current, |v| {
                        super::shown::without(
                            v,
                            &["runs", "failed", "failedCount", "providers", "fundedWork"],
                        )
                    })
                    .ok_or(Error::Stale)?;
            }
            let mut payload = serde_json::to_value(i).map_err(|_| Error::Invalid)?;
            payload["purpose"] = json!(KIND);
            payload["binding"] = json!(binding);
            payload["projectId"] = t
                .source
                .project
                .as_ref()
                .map(|p| json!(p.project_id))
                .unwrap_or(Value::Null);
            let target = t
                .source
                .project
                .as_ref()
                .map(|p| p.project_id.clone())
                .unwrap_or_else(|| "global-models".into());
            let mut r = planning::record(&t.source, target, binding, payload)?;
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
        Command::ModelsCheck(id) => {
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
    let snapshot = read(t).await;
    if let Ok(v) = &snapshot {
        shared.shown_settings.remember(KIND, v);
    }
    if matches!(command, Command::ModelsRead) {
        check()?;
        return Ok(json!({"snapshot":snapshot?,"operations":summaries(t,j)}));
    }
    Ok(
        json!({"snapshot":snapshot.ok().filter(|_| check().is_ok()),"operations":summaries(t,j),"outcome":outcome}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn work_profiles_send_the_whole_list_of_exact_profiles() {
        let profile = json!({"id":"cyber","name":"Cyber","covers":"Security work.","optInOnly":true,
            "large":[{"model":"anthropic/claude-opus-5","thinking":"high"}],"small":[]});
        let intent = |value| Intent {
            binding: "a".repeat(64),
            action: "work-profiles".into(),
            value,
        };
        assert_eq!(intent(json!([profile.clone()])).validate(), Ok(()));
        assert_eq!(intent(json!([])).validate(), Ok(()));
        let mut extra = profile.clone();
        extra["projectId"] = json!("p");
        assert_eq!(intent(json!([extra])).validate(), Err(Error::Invalid));
        assert_eq!(
            intent(json!(vec![profile.clone(); 13])).validate(),
            Err(Error::Invalid)
        );
        let op = json!({"payload":serde_json::to_string(&intent(json!([profile]))).unwrap()});
        assert_eq!(
            exact_result(
                &op,
                &json!({"result":{"action":"work-profiles","saved":true}})
            ),
            Ok(())
        );
    }
    #[test]
    fn allowance_actions_require_integer_micros_and_exact_results() {
        for action in [
            "fund-work",
            "funding-settings",
            "funding-limits",
            "continue-anyway",
            "background-continue",
        ] {
            let value = match action {
                "fund-work" => json!({"sessionId":"chat","amountMicros":2000000}),
                "funding-settings" => {
                    json!({"dailyMicros":2000000,"missionDefaultMicros":null,"quickFixDefaultMicros":0})
                }
                "background-continue" => json!("anthropic"),
                "funding-limits" => json!(false),
                _ => json!("chat"),
            };
            let intent = Intent {
                binding: "a".repeat(64),
                action: action.into(),
                value,
            };
            assert_eq!(intent.validate(), Ok(()));
            let op = json!({"payload":serde_json::to_string(&intent).unwrap()});
            assert_eq!(
                exact_result(&op, &json!({"result":{"action":action,"saved":true}})),
                Ok(())
            );
            assert_eq!(
                exact_result(&op, &json!({"result":{"action":"other","saved":true}})),
                Err(Error::Unknown)
            );
        }
        for amount in [json!(-1), json!(1.5), json!("2")] {
            let intent = Intent {
                binding: "a".repeat(64),
                action: "fund-work".into(),
                value: json!({"sessionId":"chat","amountMicros":amount}),
            };
            assert_eq!(intent.validate(), Err(Error::Invalid));
        }
    }
    #[test]
    fn secret_answers_cannot_be_durable_settings_actions() {
        let binding = "a".repeat(64);
        let bad = Intent {
            binding: binding.clone(),
            action: "answer".into(),
            value: json!({"answer":"private-code#state"}),
        };
        assert_eq!(bad.validate(), Err(Error::Invalid));
        let sign_in: SignIn = serde_json::from_value(json!({"runId":"run","action":"answer","challengeId":"challenge","answer":"private-code#state"})).unwrap();
        assert_eq!(sign_in.validate(), Ok(()));
        assert!(serde_json::from_value::<Intent>(json!({"binding":binding,"action":"sign-in","value":{"provider":"p","method":"manual_code"},"answer":"private-code"})).is_err());
    }
    #[test]
    fn sign_in_ack_names_the_exact_provider_and_method() {
        let op = json!({"payload":json!({"action":"sign-in","value":{"provider":"p","method":"manual_code"}}).to_string()});
        let r = json!({"result":{"action":"sign-in","run":{"id":"run","provider":"p","method":"manual_code"}}});
        assert_eq!(exact_result(&op, &r), Ok(()));
        for key in ["provider", "method"] {
            let mut wrong = r.clone();
            wrong["result"]["run"][key] = json!("other");
            assert_eq!(exact_result(&op, &wrong), Err(Error::Unknown));
        }
    }
}
