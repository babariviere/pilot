//! Artifact rows and exact saved sources for the window's own project, and
//! for one of its missions. Read-only: not a renderer, revision catalogue,
//! open or host action. The project comes from the root, never from TSX.
use super::{Error, Transport, delivery_artifact, valid_id};
use serde::Deserialize;
use serde_json::{Value, json};

/// The most rows one read returns, newest first. Later rows say so.
const MAX_ROWS: usize = 100;
const MAX_REVISION: u64 = 9_007_199_254_740_991;

fn artifact_id(s: &str) -> bool {
    s.len() == 36 && uuid::Uuid::parse_str(s).is_ok()
}

fn title(v: &Value) -> Option<&str> {
    v.as_str().filter(|s| s.len() <= 640)
}

/// `{}` lists the project's artifacts; `{missionId}` lists one of its missions' links.
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct List {
    mission_id: Option<String>,
}
impl List {
    pub(crate) fn validate(&self) -> Result<(), Error> {
        if self.mission_id.as_deref().is_some_and(|m| !valid_id(m)) {
            return Err(Error::Invalid);
        }
        Ok(())
    }
}

/// One exact saved revision, named by the row the window showed.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct Request {
    source_session_id: String,
    artifact_id: String,
    revision: u64,
}
impl Request {
    pub(crate) fn validate(&self) -> Result<(), Error> {
        if !valid_id(&self.source_session_id)
            || !artifact_id(&self.artifact_id)
            || self.revision == 0
            || self.revision > MAX_REVISION
        {
            return Err(Error::Invalid);
        }
        Ok(())
    }
}

/// One `ArtifactSummary` of the project, or None when any field is off.
fn summary(a: &Value, project: &str) -> Option<Value> {
    let id = a["id"].as_str().filter(|s| artifact_id(s))?;
    let session = a["sessionId"].as_str().filter(|s| valid_id(s))?;
    let kind = a["kind"]
        .as_str()
        .filter(|k| delivery_artifact::kind_ok(k))?;
    let revision = a["revision"]
        .as_u64()
        .filter(|n| (1..=MAX_REVISION).contains(n))?;
    if a["projectId"] != project {
        return None;
    }
    Some(
        json!({"sessionId":session,"artifactId":id,"title":title(&a["title"])?,"kind":kind,
        "revision":revision,"updatedAt":a["updatedAt"].as_u64()?}),
    )
}

/// The project's artifacts, newest first, or one mission's linked artifacts
/// with their task. A mission link without a pin names the current revision,
/// read now; a link whose chat is not in this project has no revision.
pub(super) async fn list(t: &Transport, r: &List) -> Result<Value, Error> {
    r.validate()?;
    t.gate(false).await?;
    let project = &t.source.project()?.project_id;
    let all = t.get(&format!("/api/projects/{project}/artifacts")).await?;
    let all: Vec<Value> = all
        .as_array()
        .ok_or(Error::Invalid)?
        .iter()
        .map(|a| summary(a, project).ok_or(Error::Invalid))
        .collect::<Result<_, _>>()?;
    let mut rows = match &r.mission_id {
        None => all,
        Some(mission) => {
            let detail = t.get(&format!("/api/missions/{mission}")).await?;
            if detail["mission"]["id"] != *mission || detail["mission"]["projectId"] != *project {
                return Err(Error::Identity);
            }
            let tasks = detail["tasks"].as_array().ok_or(Error::Invalid)?;
            let mut rows = Vec::new();
            for link in detail["artifacts"].as_array().ok_or(Error::Invalid)? {
                let id = link["artifactId"].as_str().ok_or(Error::Invalid)?;
                let session = link["sessionId"].as_str().ok_or(Error::Invalid)?;
                let kind = link["kind"].as_str().ok_or(Error::Invalid)?;
                if !artifact_id(id) || !valid_id(session) || !delivery_artifact::kind_ok(kind) {
                    return Err(Error::Invalid);
                }
                let pinned = match &link["revision"] {
                    Value::Null => None,
                    n => Some(
                        n.as_u64()
                            .filter(|n| (1..=MAX_REVISION).contains(n))
                            .ok_or(Error::Invalid)?,
                    ),
                };
                let task = link["taskId"].as_str();
                let task_title = task.and_then(|id| {
                    tasks
                        .iter()
                        .find(|t| t["id"] == id)
                        .and_then(|t| title(&t["title"]))
                });
                let current = all
                    .iter()
                    .find(|a| a["artifactId"] == id && a["sessionId"] == session);
                let revision = pinned.or_else(|| current.and_then(|a| a["revision"].as_u64()));
                rows.push(json!({"sessionId":session,"artifactId":id,
                    "title":title(&link["title"]).ok_or(Error::Invalid)?,"kind":kind,
                    "revision":revision,"pinned":pinned.is_some(),"taskId":task,"taskTitle":task_title,
                    "updatedAt":link["linkedAt"].as_u64().unwrap_or(0)}));
            }
            rows.sort_by_key(|row| std::cmp::Reverse(row["updatedAt"].as_u64()));
            rows
        }
    };
    let more = rows.len() > MAX_ROWS;
    rows.truncate(MAX_ROWS);
    // A changed project or native identity during the read cannot publish it.
    t.gate(false).await?;
    Ok(json!({"version":1,"projectId":project,"missionId":r.mission_id,"rows":rows,"more":more}))
}

/// The exact saved revision as inert text, or why it is not shown. The
/// daemon checks that the chat is in this project during its read.
pub(super) async fn source(t: &Transport, r: &Request) -> Result<Value, Error> {
    r.validate()?;
    t.gate(false).await?;
    let project = &t.source.project()?.project_id;
    let v = t
        .get(&format!(
            "/api/projects/{project}/artifacts/{}/{}?revision={}",
            r.source_session_id, r.artifact_id, r.revision
        ))
        .await?;
    let expected = json!({"projectId":project,"sourceSessionId":r.source_session_id,
        "artifactId":r.artifact_id,"revision":r.revision});
    let kind = v["metadata"]["kind"].as_str().ok_or(Error::Invalid)?;
    let name = title(&v["metadata"]["title"]).ok_or(Error::Invalid)?;
    if v["version"] != 1
        || v["reference"] != expected
        || v["rendering"] != "unsupported"
        || !delivery_artifact::kind_ok(kind)
    {
        return Err(Error::Invalid);
    }
    let content = delivery_artifact::content(&v["content"], kind)?;
    Ok(json!({"version":1,
        "reference":{"sourceSessionId":r.source_session_id,"artifactId":r.artifact_id,"revision":r.revision},
        "metadata":{"kind":kind,"title":name},"rendering":"unsupported","content":content}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summaries_keep_only_this_projects_known_kinds_and_exact_ids() {
        let a = json!({"id":"11111111-1111-1111-1111-111111111111","sessionId":"s","projectId":"p",
            "title":"Chart","kind":"nsh","revision":2,"createdAt":1,"updatedAt":3});
        assert_eq!(summary(&a, "p").unwrap()["revision"], 2);
        for (field, value) in [
            ("projectId", json!("other")),
            ("id", json!("../latest")),
            ("sessionId", json!("a/b")),
            ("kind", json!("pdf")),
            ("revision", json!(0)),
            ("title", json!("x".repeat(641))),
        ] {
            let mut changed = a.clone();
            changed[field] = value;
            assert!(summary(&changed, "p").is_none(), "{field}");
        }
        assert!(
            List {
                mission_id: Some("a/b".into())
            }
            .validate()
            .is_err()
        );
        assert!(serde_json::from_value::<List>(json!({"projectId":"p"})).is_err());
        assert!(
            serde_json::from_value::<Request>(json!({"sourceSessionId":"s",
            "artifactId":"11111111-1111-1111-1111-111111111111","revision":1,"projectId":"p"}))
            .is_err()
        );
    }
}
