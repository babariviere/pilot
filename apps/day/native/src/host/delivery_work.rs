//! Read-only Agent work for one delivered result: owned change history from its
//! retained comparisons and the owner chat's saved push/PR audit. No ownership
//! is inferred from authors, workspaces or the operation log, and nothing is
//! started, subscribed, observed, replayed or written.
use super::{Error, Transport, delivery, valid_id};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// The most retained comparisons and audit records one read shows.
const MAX_CHANGES: usize = 3;
const MAX_ACTIONS: usize = 20;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Request {
    subject: delivery::Subject,
    target_id: String,
    delivery_id: String,
    owner_session_id: String,
}
impl Request {
    pub(crate) fn validate(&self) -> Result<(), Error> {
        self.subject.validate()?;
        if !valid_id(&self.target_id)
            || !delivery::digest(&self.delivery_id)
            || !valid_id(&self.owner_session_id)
        {
            return Err(Error::Invalid);
        }
        Ok(())
    }
    fn qualifies(&self, page: &Value) -> Result<(), Error> {
        if page["subject"] != serde_json::to_value(&self.subject).map_err(|_| Error::Invalid)?
            || page["targetId"] != self.target_id
            || page["deliveryId"] != self.delivery_id
            || page["ownerSessionId"] != self.owner_session_id
        {
            return Err(Error::Stale);
        }
        Ok(())
    }
}

fn hex(s: &Value, len: usize) -> bool {
    s.as_str().is_some_and(|s| {
        s.len() == len && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    })
}
fn change(s: &Value) -> bool {
    s.as_str()
        .is_some_and(|s| s.len() == 32 && s.bytes().all(|b| matches!(b, b'k'..=b'z')))
}
fn text(v: &Value, max: usize) -> Option<&str> {
    v.as_str().filter(|s| s.len() <= max)
}

/// One retained comparison's owned change history, as the daemon's pinned read returned it.
fn evolution(v: &Value, snapshot: &str) -> Result<Value, Error> {
    let creation = &v["creation"];
    let revisions = v["revisions"].as_array().ok_or(Error::Invalid)?;
    if v["snapshotId"] != snapshot
        || !change(&v["changeId"])
        || !hex(&creation["commitId"], 40)
        || (!creation["baselineCommitId"].is_null() && !hex(&creation["baselineCommitId"], 40))
        || !matches!(v["current"].as_str(), Some("present" | "absent"))
        || !matches!(
            v["seed"].as_str(),
            Some("current" | "retained-observation" | "creation-only")
        )
        || !v["more"].is_boolean()
        || revisions.len() > 20
        || !hex(&v["operation"]["id"], 128)
        || v["operation"]["scope"] != "repository-not-chat"
    {
        return Err(Error::Invalid);
    }
    let mut out = Vec::with_capacity(revisions.len());
    for r in revisions {
        let parents = r["parents"].as_array().ok_or(Error::Invalid)?;
        if !change(&r["changeId"])
            || !hex(&r["commitId"], 40)
            || !r["ownedChange"].is_boolean()
            || parents.len() > 8
            || parents.iter().any(|p| !hex(p, 40))
        {
            return Err(Error::Invalid);
        }
        out.push(json!({"changeId":r["changeId"],"commitId":r["commitId"],
            "parents":parents,"ownedChange":r["ownedChange"]}));
    }
    Ok(
        json!({"snapshotId":snapshot,"state":"shown","changeId":v["changeId"],
        "creationCommitId":creation["commitId"],"baselineCommitId":creation["baselineCommitId"],
        "current":v["current"],"seed":v["seed"],"revisions":out,"more":v["more"],
        "operationId":v["operation"]["id"]}),
    )
}

/// The saved local selection of one publication attempt. Never remote proof.
fn local(v: &Value) -> Result<Value, Error> {
    match v["status"].as_str() {
        Some("unknown") => Ok(json!({"status":"unknown"})),
        Some("owned") => {
            let revisions = v["revisions"].as_array().ok_or(Error::Invalid)?;
            if revisions.is_empty() || revisions.len() > 4 {
                return Err(Error::Invalid);
            }
            let mut out = Vec::new();
            for r in revisions {
                if !change(&r["changeId"])
                    || !hex(&r["commitId"], 40)
                    || !hex(&r["startCommitId"], 40)
                    || (!r["baselineCommitId"].is_null() && !hex(&r["baselineCommitId"], 40))
                {
                    return Err(Error::Invalid);
                }
                out.push(json!({"changeId":r["changeId"],"commitId":r["commitId"],
                    "startCommitId":r["startCommitId"],"baselineCommitId":r["baselineCommitId"]}));
            }
            Ok(json!({"status":"owned","revisions":out}))
        }
        _ => Err(Error::Invalid),
    }
}

/// One saved push or PR-creation record, reduced to inert fields. Other kinds are skipped.
fn action(a: &Value) -> Result<Option<Value>, Error> {
    let summary = text(&a["summary"], 512).ok_or(Error::Invalid)?;
    let kind = match a["kind"].as_str() {
        Some(k @ ("push" | "pr_opened")) => k,
        Some(_) => return Ok(None),
        None if a.get("kind").is_some() => return Err(Error::Invalid),
        // Older audits have no kind: keep only plain push and PR creation summaries.
        None if summary.ends_with(" push") => "push",
        None if summary == "gh pr create" => "pr_opened",
        None => return Ok(None),
    };
    let id = text(&a["id"], 512).ok_or(Error::Invalid)?;
    let description = text(&a["description"], 1024).ok_or(Error::Invalid)?;
    let at = a["at"]
        .as_u64()
        .filter(|n| *n <= 8_640_000_000_000_000)
        .ok_or(Error::Invalid)?;
    if !(a["exitCode"].is_null() || a["exitCode"].is_i64())
        || !(a["branch"].is_null() || text(&a["branch"], 256).is_some())
        || !(a["prNumber"].is_null() || a["prNumber"].as_u64().is_some_and(|n| n > 0))
    {
        return Err(Error::Invalid);
    }
    let url = text(&a["url"], 512).filter(|u| u.starts_with("https://github.com/"));
    let publication = match a.get("publication") {
        None | Some(Value::Null) => Value::Null,
        Some(p) => {
            if text(&p["attemptId"], 512).is_none()
                || !matches!(
                    p["stage"].as_str(),
                    Some("attempted" | "confirmed" | "unknown")
                )
                || !matches!(
                    p["evidence"].as_str(),
                    Some("command-dispatch" | "command-result")
                )
            {
                return Err(Error::Invalid);
            }
            json!({"attemptId":p["attemptId"],"stage":p["stage"],"evidence":p["evidence"],
                "local":local(&p["local"])?})
        }
    };
    Ok(Some(
        json!({"id":id,"kind":kind,"branch":a["branch"],"prNumber":a["prNumber"],
        "url":url,"summary":summary,"description":description,"at":at,
        "exitCode":a["exitCode"],"publication":publication}),
    ))
}

/// The owner chat's saved push/PR records. A task result keeps only records
/// made while that chat was in the task's mission.
fn publication(v: &Value, request: &Request) -> Result<Value, Error> {
    let actions = v["actions"].as_array().ok_or(Error::Invalid)?;
    if v["version"] != 1
        || v["sessionId"] != request.owner_session_id
        || v["projectId"] != request.subject.project()
        || actions.len() > 200
    {
        return Err(Error::Invalid);
    }
    let mission = match &request.subject {
        delivery::Subject::Task { mission, .. } => Some(mission.as_str()),
        delivery::Subject::Chat { .. } => None,
    };
    let mut kept = Vec::new();
    for a in actions {
        if mission.is_some_and(|m| a["missionId"] != m) {
            continue;
        }
        if let Some(a) = action(a)? {
            kept.push(a);
        }
    }
    let more = kept.len() > MAX_ACTIONS;
    let start = kept.len().saturating_sub(MAX_ACTIONS);
    Ok(
        json!({"state":"shown","scope":if mission.is_some() {"mission"} else {"chat"},
        "actions":kept.split_off(start),"more":more}),
    )
}

pub(super) async fn read(t: &Transport, request: &Request) -> Result<Value, Error> {
    request.validate()?;
    let page = delivery::read(t, &request.subject).await?;
    request.qualifies(&page)?;
    let owner = &request.owner_session_id;
    let project = request.subject.project();
    // Only the retained comparisons this exact result names. No discovery.
    let snapshots: Vec<String> = page["submission"]["evidence"]
        .as_array()
        .map(|e| {
            e.iter()
                .filter(|x| x["kind"] == "snapshot")
                .filter_map(|x| x["snapshotId"].as_str())
                .filter(|s| valid_id(s))
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    let more_changes = snapshots.len() > MAX_CHANGES;
    let mut changes = Vec::new();
    for snapshot in snapshots.iter().take(MAX_CHANGES) {
        // Each read is pinned and scope-checked by the daemon. A refusal here
        // (legacy, unowned, GC'd or changed custody) shows as unavailable.
        let shown = t
            .get(&format!(
                "/api/sessions/{owner}/review/{snapshot}/evolution?expectedProjectId={project}"
            ))
            .await
            .and_then(|v| evolution(&v, snapshot));
        changes.push(match shown {
            Ok(v) => v,
            Err(Error::Offline) => return Err(Error::Offline),
            Err(_) => json!({"snapshotId":snapshot,"state":"unavailable"}),
        });
    }
    let publication = match t
        .get(&format!(
            "/api/sessions/{owner}/publication-audit?expectedProjectId={project}"
        ))
        .await
        .and_then(|v| publication(&v, request))
    {
        Ok(v) => v,
        Err(Error::Offline) => return Err(Error::Offline),
        Err(_) => json!({"state":"unavailable"}),
    };
    // The result, owner and access are checked again after every entered read.
    let after = delivery::read(t, &request.subject).await?;
    request.qualifies(&after)?;
    Ok(json!({"version":1,"reference":request,"changes":changes,
        "moreChanges":more_changes,"publication":publication}))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(subject: delivery::Subject) -> Request {
        Request {
            subject,
            target_id: "t".into(),
            delivery_id: "d".repeat(64),
            owner_session_id: "owner".into(),
        }
    }
    fn task() -> delivery::Subject {
        delivery::Subject::Task {
            project: "p".into(),
            mission: "m".into(),
            task: "t".into(),
        }
    }

    #[test]
    fn publication_keeps_mission_push_and_pr_records_and_never_upgrades_stages() {
        let c = "k".repeat(32);
        let commit = "a".repeat(40);
        let audit = json!({"version":1,"sessionId":"owner","projectId":"p","actions":[
            {"id":"x:0:attempt","kind":"push","branch":"main","summary":"jj git push",
             "description":"pushed main","at":1,"exitCode":null,"missionId":"m",
             "publication":{"attemptId":"x:0:attempt","stage":"attempted","evidence":"command-dispatch",
               "local":{"status":"owned","repositoryId":"r","operationId":"o",
                 "revisions":[{"changeId":c,"commitId":commit,"startCommitId":commit}]}}},
            {"id":"y:0","kind":"push","summary":"jj git push","description":"pushed","at":2,
             "exitCode":0,"missionId":"other"},
            {"id":"z:0","kind":"pr_edited","summary":"gh pr edit","description":"edited","at":3,
             "exitCode":0,"missionId":"m"},
            {"id":"w:0","summary":"gh pr create","description":"created PR","at":4,"exitCode":0,
             "missionId":"m","url":"javascript:alert(1)"}
        ]});
        let v = publication(&audit, &request(task())).unwrap();
        let actions = v["actions"].as_array().unwrap();
        assert_eq!(actions.len(), 2);
        assert_eq!(actions[0]["publication"]["stage"], "attempted");
        assert_eq!(
            actions[0]["publication"]["local"]["revisions"][0]["commitId"],
            commit
        );
        assert!(
            actions[0]["publication"]["local"]
                .get("repositoryId")
                .is_none()
        );
        assert_eq!(actions[1]["kind"], "pr_opened");
        assert!(actions[1]["url"].is_null());
        assert_eq!(v["scope"], "mission");

        let mut wrong = audit.clone();
        wrong["sessionId"] = json!("someone-else");
        assert_eq!(publication(&wrong, &request(task())), Err(Error::Invalid));
        let mut bad = audit;
        bad["actions"][0]["publication"]["stage"] = json!("pushed");
        assert_eq!(publication(&bad, &request(task())), Err(Error::Invalid));
    }

    #[test]
    fn evolution_requires_exact_snapshot_and_repository_scoped_operation() {
        let v = json!({"snapshotId":"s1","changeId":"k".repeat(32),"repositoryId":"r",
            "creation":{"changeId":"k".repeat(32),"commitId":"a".repeat(40),"operationId":"o","kind":"new",
              "baselineCommitId":"b".repeat(40)},
            "revisions":[{"changeId":"k".repeat(32),"commitId":"c".repeat(40),"parents":["b".repeat(40)],"ownedChange":true}],
            "more":false,"current":"present","seed":"current",
            "operation":{"id":"f".repeat(128),"parents":[],"scope":"repository-not-chat"}});
        let shown = evolution(&v, "s1").unwrap();
        assert_eq!(shown["baselineCommitId"], "b".repeat(40));
        assert!(shown.get("repositoryId").is_none());
        assert_eq!(evolution(&v, "s2"), Err(Error::Invalid));
        let mut wide = v;
        wide["operation"]["scope"] = json!("chat");
        assert_eq!(evolution(&wide, "s1"), Err(Error::Invalid));
    }
}
