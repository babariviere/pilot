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

/// The project's rows. A row that is off (for example an old artifact saved
/// without its project) is left out; it never hides the others.
fn project_rows(all: &Value, project: &str) -> Result<Vec<Value>, Error> {
    Ok(all
        .as_array()
        .ok_or(Error::Invalid)?
        .iter()
        .filter_map(|a| summary(a, project))
        .collect())
}

/// One capture of a reported screen, pinned on its task.
#[derive(Debug, Clone, PartialEq)]
struct Capture {
    id: String,
    revision: u64,
    title: String,
}

fn capture(v: &Value) -> Option<Capture> {
    Some(Capture {
        id: v["artifactId"].as_str().filter(|s| artifact_id(s))?.into(),
        revision: v["revision"]
            .as_u64()
            .filter(|n| (1..=MAX_REVISION).contains(n))?,
        title: title(&v["title"])?.into(),
    })
}

/// A screen the task's current worker reported: its After and, unless the screen is new, its Before.
#[derive(Debug, Clone, PartialEq)]
struct Pair {
    mission: String,
    task: String,
    session: String,
    before: Option<Capture>,
    after: Capture,
}

/// The project's screen pairs. A pair that is off is left out, so its images show on their own.
fn screen_pairs(all: &Value) -> Vec<Pair> {
    let Some(all) = all.as_array() else {
        return Vec::new();
    };
    all.iter()
        .filter_map(|p| {
            let before = match &p["before"] {
                Value::Null => None,
                b => Some(capture(b)?),
            };
            Some(Pair {
                mission: p["missionId"].as_str().filter(|s| valid_id(s))?.into(),
                task: p["taskId"].as_str().filter(|s| valid_id(s))?.into(),
                session: p["sessionId"].as_str().filter(|s| valid_id(s))?.into(),
                before,
                after: capture(&p["after"])?,
            })
        })
        .collect()
}

fn pair_json(p: &Pair) -> Value {
    let side = |c: &Capture| json!({"artifactId":c.id,"revision":c.revision,"title":c.title});
    json!({"before":p.before.as_ref().map(side),"after":side(&p.after)})
}

/// Shows each reported screen once: its After row carries the pair at the pinned revisions, and its Before row leaves
/// the list. On a mission page only that mission's pairs fold, and only the links the pair pinned on its task.
fn fold_pairs(rows: Vec<Value>, pairs: &[Pair], mission: Option<&str>) -> Vec<Value> {
    let matches = |row: &Value, p: &Pair, c: &Capture| {
        row["sessionId"] == *p.session
            && row["artifactId"] == *c.id
            && row["kind"] == "image"
            && mission.is_none_or(|_| row["taskId"] == *p.task && row["revision"] == c.revision)
    };
    let pairs: Vec<&Pair> = pairs
        .iter()
        .filter(|p| mission.is_none_or(|m| p.mission == m))
        .filter(|p| rows.iter().any(|row| matches(row, p, &p.after)))
        .collect();
    rows.into_iter()
        .filter(|row| {
            !pairs
                .iter()
                .any(|p| p.before.as_ref().is_some_and(|b| matches(row, p, b)))
        })
        .map(|mut row| {
            if let Some(p) = pairs.iter().find(|p| matches(&row, p, &p.after)) {
                row["revision"] = json!(p.after.revision);
                row["pair"] = pair_json(p);
            }
            row
        })
        .collect()
}

/// The project's artifacts, newest first, or one mission's linked artifacts
/// with their task. A mission link without a pin names the current revision,
/// read now; a link whose chat is not in this project has no revision.
pub(super) async fn list(t: &Transport, r: &List) -> Result<Value, Error> {
    r.validate()?;
    t.gate(false).await?;
    let project = &t.source.project()?.project_id;
    let all = t.get(&format!("/api/projects/{project}/artifacts")).await?;
    let all = project_rows(&all, project)?;
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
    // Screens fold into one row each. Without the pairs (an older service), each image shows on its own.
    let pairs = t
        .get(&format!("/api/projects/{project}/screen-pairs"))
        .await
        .map(|v| screen_pairs(&v))
        .unwrap_or_default();
    rows = fold_pairs(rows, &pairs, r.mission_id.as_deref());
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

    const BEFORE: &str = "11111111-1111-1111-1111-111111111111";
    const AFTER: &str = "22222222-2222-2222-2222-222222222222";
    const OTHER: &str = "33333333-3333-3333-3333-333333333333";

    fn pairs() -> Vec<Pair> {
        screen_pairs(&json!([
            {"missionId":"m","taskId":"t","sessionId":"s","reportedAt":1,
             "before":{"artifactId":BEFORE,"revision":1,"title":"Row (Before)"},
             "after":{"artifactId":AFTER,"revision":2,"title":"Row (After)"}},
            {"missionId":"m","taskId":"t","sessionId":"s","after":{"artifactId":"../x","revision":1,"title":"Bad"}}
        ]))
    }

    #[test]
    fn a_reported_screen_folds_into_one_row_at_its_pinned_revisions() {
        assert_eq!(pairs().len(), 1, "a pair that is off is left out");
        assert!(screen_pairs(&json!({"error":"Not found"})).is_empty());
        let row = |id: &str, revision: u64| {
            json!({"sessionId":"s","artifactId":id,"title":id,"kind":"image","revision":revision,"updatedAt":1})
        };
        let rows = fold_pairs(vec![row(AFTER, 3), row(OTHER, 1), row(BEFORE, 1)], &pairs(), None);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["revision"], 2, "the pinned After, not the newest");
        assert_eq!(rows[0]["pair"]["before"]["artifactId"], BEFORE);
        assert_eq!(rows[0]["pair"]["after"]["revision"], 2);
        assert!(rows[1].get("pair").is_none());
        // Without its After in the list, the Before stays a card of its own.
        assert_eq!(fold_pairs(vec![row(BEFORE, 1)], &pairs(), None).len(), 1);
        // Another chat's artifact with the same ID does not fold.
        let mut theirs = row(BEFORE, 1);
        theirs["sessionId"] = json!("other");
        assert_eq!(fold_pairs(vec![row(AFTER, 2), theirs], &pairs(), None).len(), 2);
    }

    #[test]
    fn a_mission_page_folds_only_its_tasks_pinned_links() {
        let link = |id: &str, task: &str, revision: u64| {
            json!({"sessionId":"s","artifactId":id,"title":id,"kind":"image","revision":revision,
                "pinned":true,"taskId":task,"updatedAt":1})
        };
        let rows = fold_pairs(vec![link(AFTER, "t", 2), link(BEFORE, "t", 1)], &pairs(), Some("m"));
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["pair"]["before"]["revision"], 1);
        assert_eq!(
            fold_pairs(vec![link(AFTER, "t", 2), link(BEFORE, "t", 1)], &pairs(), Some("n")).len(),
            2,
            "another mission's page"
        );
        assert_eq!(
            fold_pairs(vec![link(AFTER, "t", 1), link(BEFORE, "t", 1)], &pairs(), Some("m")).len(),
            2,
            "an older link of the After"
        );
        assert_eq!(
            fold_pairs(vec![link(AFTER, "other", 2), link(BEFORE, "t", 1)], &pairs(), Some("m")).len(),
            2,
            "a link on another task"
        );
    }

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
        // One row without its project is left out; the others still show.
        let mut legacy = a.clone();
        legacy["projectId"] = Value::Null;
        let rows = project_rows(&json!([a, legacy]), "p").unwrap();
        assert_eq!(rows.len(), 1);
        assert!(project_rows(&json!({}), "p").is_err());
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
