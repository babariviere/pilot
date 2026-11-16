//! Canonical Revisit projection and exact user intents. No transport or admission authority.
use crate::plan::{
    ChangeKind, ConfirmRevisionIntent, ConfirmState, Correction, CorrectionKind, DecisionAction,
    DecisionChange, OutcomeStatus, PauseNeed, Revision, Revisit, RevisitStage, TaskChange,
    TextChange,
};
use crate::plan_host::Refusal;
use serde_json::{Value, json};

fn s(v: &Value) -> String {
    v.as_str().unwrap_or_default().to_owned()
}
fn arr(v: &Value) -> &[Value] {
    v.as_array().map_or(&[], Vec::as_slice)
}
fn text(before: &Value, after: &Value) -> TextChange {
    let before = s(before);
    let after = after
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| before.clone());
    TextChange {
        kind: if before == after {
            ChangeKind::Stays
        } else {
            ChangeKind::Changes
        },
        before,
        after,
    }
}
fn pending(ops: &[Value]) -> bool {
    crate::plan_host::unsettled_operation(ops).is_some()
}

/// Whether a revision only adds tasks. That changes nothing a working chat uses, so
/// the daemon applies it without Pause.
fn adds_only(d: &Value) -> bool {
    d["goal"].is_null()
        && d["markdown"].is_null()
        && arr(&d["tasks"]).is_empty()
        && arr(&d["decisions"]).is_empty()
}

/// Full current comparison, including unchanged open tasks and all assignment fields.
pub fn view(read: &Value, ops: &[Value]) -> Revisit {
    let r = &read["revision"];
    if r["source"].as_str().is_none_or(|v| v.len() != 64) {
        return Revisit {
            available: false,
            reason: "Revisit is not available from this service. Nothing was sent or changed."
                .into(),
            ..Revisit::default()
        };
    }
    let p = &r["pending"]["proposal"];
    let tasks = arr(&r["tasks"]);
    let decisions = arr(&r["decisions"]);
    let finished = |t: &&Value| matches!(t["status"].as_str(), Some("done" | "dropped"));
    let paused = r["control"]["state"] == "paused" && r["control"]["held"] == true;
    let repreview = p.is_object() && r["pending"]["current"] == false && paused;
    let revision = p.is_object().then(|| {
        let d = &p["delta"];
        let adds_only = adds_only(d);
        let unknown = ops.iter().any(|op| {
            matches!(
                op["kind"].as_str(),
                Some("revision-confirm" | "revision-preview" | "plan-revisit")
            ) && !matches!(
                op["state"].as_str(),
                Some("accepted" | "rejected" | "not-sent")
            )
        });
        Revision {
            id: s(&p["id"]),
            digest: s(&p["digest"]),
            summary: s(&p["summary"]),
            current: r["pending"]["current"] == true,
            goal: text(&r["mission"]["goal"], &d["goal"]),
            plan: text(&r["brief"]["markdown"], &d["markdown"]),
            tasks: tasks
                .iter()
                .filter(|t| !finished(t))
                .map(|t| {
                    let change = arr(&d["tasks"]).iter().find(|c| c["id"] == t["id"]);
                    TaskChange {
                        id: s(&t["id"]),
                        number: t["number"].as_u64().unwrap_or(0) as u32,
                        title: s(&t["title"]),
                        kind: change.map_or(ChangeKind::Stays, |c| {
                            if c["drop"] == true {
                                ChangeKind::Drops
                            } else {
                                ChangeKind::Changes
                            }
                        }),
                        lines: change
                            .and_then(Value::as_object)
                            .map(|c| {
                                c.iter()
                                    .filter(|(k, _)| *k != "id" && *k != "drop")
                                    .map(|(k, v)| format!("{k}: {} → {v}", t[k]))
                                    .collect()
                            })
                            .unwrap_or_default(),
                    }
                })
                .collect(),
            added: arr(&d["newTasks"])
                .iter()
                .map(|n| {
                    let after: Vec<String> = arr(&n["dependsOn"])
                        .iter()
                        .map(|dep| {
                            let key = s(dep);
                            tasks
                                .iter()
                                .find(|t| t["id"] == *dep || t["number"].to_string() == key)
                                .map_or(key, |t| format!("#{}", t["number"]))
                        })
                        .collect();
                    let mut lines = vec![s(&n["body"])];
                    if !after.is_empty() {
                        lines.push(format!("After: {}", after.join(", ")));
                    }
                    TaskChange {
                        id: s(&n["key"]),
                        number: 0,
                        title: s(&n["title"]),
                        kind: ChangeKind::Adds,
                        lines,
                    }
                })
                .collect(),
            finished: tasks.iter().filter(finished).count() as u32,
            decisions: arr(&d["decisions"])
                .iter()
                .map(|c| {
                    let old = decisions.iter().find(|v| v["id"] == c["id"]);
                    DecisionChange {
                        id: s(&c["id"]),
                        number: old.and_then(|v| v["number"].as_u64()).unwrap_or(0) as u32,
                        before: old.map(|v| s(&v["text"])).unwrap_or_default(),
                        action: if c["action"] == "withdraw" {
                            DecisionAction::Withdraw
                        } else {
                            DecisionAction::Replace
                        },
                        after: s(&c["text"]),
                        reason: s(&c["reason"]),
                    }
                })
                .collect(),
            kept_decisions: decisions.len().saturating_sub(arr(&d["decisions"]).len()) as u32,
            corrections: arr(&d["corrections"])
                .iter()
                .map(|c| Correction {
                    kind: if c["kind"] == "permission" {
                        CorrectionKind::Permission
                    } else {
                        CorrectionKind::Instruction
                    },
                    text: s(&c["text"]),
                })
                .collect(),
            pause: if paused {
                PauseNeed::Paused
            } else if adds_only {
                PauseNeed::None
            } else {
                PauseNeed::Needed
            },
            confirm: if unknown {
                ConfirmState::Unknown
            } else {
                ConfirmState::Open
            },
        }
    });
    let questions = read["view"]["interview"]["kind"] == "revisit"
        && read["view"]["interview"]["submission"].is_null();
    Revisit {
        available: true,
        reason: s(&read["revisit"]["reason"]),
        stage: if revision.is_some() {
            RevisitStage::Review
        } else if questions {
            RevisitStage::Questions
        } else if r["latestConfirmed"].is_object() {
            RevisitStage::Confirmed
        } else if ops.iter().any(|o| o["kind"] == "plan-revisit") {
            if read["view"]["interview"]["kind"] == "revisit" {
                RevisitStage::Proposing
            } else {
                RevisitStage::Preparing
            }
        } else {
            RevisitStage::Idle
        },
        can_ask: read["fresh"] == true
            && !pending(ops)
            && (repreview || read["revisit"]["available"] == true),
        goal: s(&r["mission"]["goal"]),
        plan: s(&r["brief"]["markdown"]),
        open_tasks: tasks.iter().filter(|t| !finished(t)).count() as u32,
        finished_tasks: tasks.iter().filter(finished).count() as u32,
        decisions: decisions.len() as u32,
        revision,
        history: vec![],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read() -> Value {
        json!({"fresh":true,"missionId":"mission","revisit":{"available":true,"source":"a".repeat(64),"contextDigest":"b".repeat(64)},"revision":{"source":"a".repeat(64),"mission":{"goal":"Old"},"brief":{"markdown":"Agreed"},"tasks":[{"id":"open","number":1,"title":"Open","body":"Before","status":"todo"},{"id":"done","status":"done"}],"decisions":[{"id":"decision","number":1,"text":"Current guidance"}],"control":{"state":"running","held":false},"pending":{"current":true,"proposal":{"id":"proposal","digest":"c".repeat(64),"summary":"New goal","delta":{"goal":"New","tasks":[{"id":"open","body":"After","dependsOn":[]}],"decisions":[{"id":"decision","action":"withdraw","reason":"Changed need"}],"corrections":[{"kind":"permission","text":"Unapplied"}]}}}}})
    }
    #[test]
    fn exact_user_revisit_and_post_pause_preview_are_distinct_from_confirmation() {
        let mut r = read();
        assert_eq!(
            request(&r, "mission").expect("unheld user request").1["purpose"],
            "plan-revisit"
        );
        let intent = ConfirmRevisionIntent {
            mission_id: "mission".into(),
            revision_id: "proposal".into(),
            digest: "c".repeat(64),
        };
        assert!(
            confirm(&r, &intent).is_err(),
            "running is not an apply boundary"
        );
        r["revision"]["pending"]["current"] = json!(false);
        r["revision"]["control"] = json!({"state":"paused","held":true});
        r["revisit"]["available"] = json!(false);
        let preview = request(&r, "mission").expect("explicit fresh preview");
        assert_eq!(preview.1["purpose"], "revision-preview");
        assert_eq!(preview.1["digest"], intent.digest);
        assert!(
            confirm(&r, &intent).is_err(),
            "never ignore post-Pause source mismatch"
        );
        r["revision"]["pending"]["current"] = json!(true);
        assert_eq!(
            confirm(&r, &intent).expect("fresh reviewed confirmation").1["purpose"],
            "revision-confirm"
        );
        r["fresh"] = json!(false);
        assert!(request(&r, "mission").is_err());
        assert!(confirm(&r, &intent).is_err());
    }
    #[test]
    fn a_revision_that_only_adds_tasks_shows_them_and_needs_no_pause() {
        let mut r = read();
        r["revision"]["pending"]["proposal"]["delta"] = json!({"newTasks":[
            {"key":"export","title":"Export chats","body":"Outcome: export.","dependsOn":["open"]},
            {"key":"docs","title":"Document it","body":"A guide.","dependsOn":["export"]}
        ]});
        let revision = view(&r, &[]).revision.expect("saved revision");
        assert_eq!(revision.added.len(), 2);
        assert_eq!(revision.added[0].kind, ChangeKind::Adds);
        assert_eq!(
            revision.added[0].lines,
            vec!["Outcome: export.", "After: #1"]
        );
        assert_eq!(revision.added[1].lines[1], "After: export");
        assert_eq!(revision.pause, PauseNeed::None);
        assert!(revision.tasks.iter().all(|t| t.kind == ChangeKind::Stays));
        let intent = ConfirmRevisionIntent {
            mission_id: "mission".into(),
            revision_id: "proposal".into(),
            digest: "c".repeat(64),
        };
        assert!(confirm(&r, &intent).is_ok(), "adding tasks needs no Pause");
    }
    #[test]
    fn complete_comparison_and_unknown_operation_block_new_intents() {
        let r = read();
        let v = view(&r, &[]);
        let revision = v.revision.expect("saved revision");
        assert_eq!(revision.goal.before, "Old");
        assert_eq!(revision.goal.after, "New");
        assert_eq!(revision.tasks.len(), 1);
        assert_eq!(revision.finished, 1);
        assert!(revision.tasks[0].lines.iter().any(|l| l.contains("After")));
        assert_eq!(revision.decisions[0].before, "Current guidance");
        assert_eq!(revision.decisions[0].reason, "Changed need");
        assert_eq!(revision.corrections[0].text, "Unapplied");
        let v = view(
            &r,
            &[json!({"kind":"revision-confirm","state":"unknown","operationId":"exact"})],
        );
        assert!(!v.can_ask);
        assert_eq!(
            v.revision.expect("unknown saved confirmation").confirm,
            ConfirmState::Unknown
        );
        assert!(
            !view(&json!({}), &[]).available,
            "old service never appears connected"
        );
    }
}

/// A stale post-Pause proposal requires an explicit new user preview, never a held planner.
pub fn request(read: &Value, mission: &str) -> Result<(String, Value), Refusal> {
    if read["fresh"] != true || read["missionId"] != mission {
        return Err((
            OutcomeStatus::Rejected,
            "Read this mission again. Nothing was sent.",
        ));
    }
    let r = &read["revision"];
    let p = &r["pending"]["proposal"];
    if p.is_object()
        && r["pending"]["current"] == false
        && r["control"]["state"] == "paused"
        && r["control"]["held"] == true
    {
        return Ok((
            s(&r["source"]),
            json!({"purpose":"revision-preview", "proposalId":p["id"], "digest":p["digest"], "source":r["source"]}),
        ));
    }
    if read["revisit"]["available"] != true {
        return Err((
            OutcomeStatus::Rejected,
            "Revisit needs a published, active, unheld planner. Nothing was sent.",
        ));
    }
    Ok((
        s(&read["revisit"]["contextDigest"]),
        json!({"purpose":"plan-revisit", "source":read["revisit"]["source"]}),
    ))
}

/// Confirmation names only the exact current proposal that the user reviewed.
pub fn confirm(read: &Value, intent: &ConfirmRevisionIntent) -> Result<(String, Value), Refusal> {
    let r = &read["revision"];
    let p = &r["pending"]["proposal"];
    let paused = r["control"]["state"] == "paused" && r["control"]["held"] == true;
    if read["fresh"] != true
        || read["missionId"] != intent.mission_id
        || r["pending"]["current"] != true
        || p["id"] != intent.revision_id
        || p["digest"] != intent.digest
        || !(paused || adds_only(&p["delta"]))
    {
        return Err((
            OutcomeStatus::Rejected,
            "Read and confirm a fresh revision while the mission is paused. Nothing was sent.",
        ));
    }
    Ok((
        s(&r["source"]),
        json!({"purpose":"revision-confirm", "proposalId":p["id"], "digest":p["digest"], "source":r["source"]}),
    ))
}
