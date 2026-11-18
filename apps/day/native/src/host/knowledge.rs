//! Project library over existing durable Knowledge. Reads never start maintenance.
use super::{Error, Source, Transport, valid_id};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum Read {
    List {
        query: String,
        cursor: Option<String>,
        #[serde(rename = "missionId")]
        mission_id: Option<String>,
    },
    Detail {
        id: String,
        revision: Option<u32>,
    },
    Revisions {
        id: String,
        cursor: Option<String>,
    },
    Memory {
        lo: Option<u32>,
        hi: Option<u32>,
    },
    Pending {
        id: Option<String>,
        #[serde(rename = "expectedRevision")]
        expected_revision: Option<u32>,
    },
}

pub(super) fn encoded(s: &str) -> String {
    s.bytes().map(|b| format!("%{b:02X}")).collect()
}
impl Read {
    pub(super) fn path(&self, project: &str) -> Result<String, Error> {
        let base = format!("/api/projects/{project}");
        Ok(match self {
            Self::List {
                query,
                cursor,
                mission_id,
            } => {
                if query.chars().count() > 200
                    || cursor.as_ref().is_some_and(|s| s.len() > 4096)
                    || mission_id.as_ref().is_some_and(|s| !valid_id(s))
                {
                    return Err(Error::Invalid);
                }
                format!(
                    "{base}/knowledge?limit=25&q={}&cursor={}&missionId={}",
                    encoded(query),
                    encoded(cursor.as_deref().unwrap_or("")),
                    mission_id.as_deref().unwrap_or("")
                )
            }
            Self::Detail { id, revision } => {
                if !valid_id(id) || *revision == Some(0) {
                    return Err(Error::Invalid);
                }
                format!(
                    "{base}/knowledge/{id}?revision={}",
                    revision.map(|n| n.to_string()).unwrap_or_default()
                )
            }
            Self::Revisions { id, cursor } => {
                if !valid_id(id) || cursor.as_ref().is_some_and(|s| s.len() > 4096) {
                    return Err(Error::Invalid);
                }
                format!(
                    "{base}/knowledge/{id}/revisions?limit=25&cursor={}",
                    encoded(cursor.as_deref().unwrap_or(""))
                )
            }
            Self::Memory { lo, hi } => match (lo, hi) {
                (None, None) => format!("{base}/memory/tree?depth=1"),
                (Some(lo), Some(hi)) if lo <= hi => {
                    format!("{base}/memory/tree?lo={lo}&hi={hi}&depth=1")
                }
                _ => return Err(Error::Invalid),
            },
            Self::Pending { .. } => return Err(Error::Invalid),
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct Edit {
    pub project_id: String,
    pub id: String,
    pub expected_revision: u32,
    pub title: String,
    pub synopsis: String,
    pub body: String,
    pub sources: Vec<Value>,
    pub reason: String,
}
impl Edit {
    pub(crate) fn validate(&self) -> Result<(), Error> {
        if !valid_id(&self.project_id)
            || !valid_id(&self.id)
            || self.expected_revision == 0
            || self.title.trim().is_empty()
            || self.title.chars().count() > 200
            || self.synopsis.chars().count() > 1000
            || self.body.trim().is_empty()
            || self.reason.trim().is_empty()
            || self.reason.chars().count() > 1000
            || self.sources.len() > 64
        {
            return Err(Error::Invalid);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct Record {
    pub knowledge_operation: String,
    pub source: Source,
    pub id: String,
    pub expected_revision: u32,
    pub state: State,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub(super) enum State {
    Pending,
    Saved,
    Rejected,
}
impl Record {
    pub fn validate(&self) -> Result<(), Error> {
        self.source.project()?;
        if !valid_id(&self.knowledge_operation)
            || !valid_id(&self.id)
            || self.expected_revision == 0
        {
            return Err(Error::Storage);
        }
        Ok(())
    }
    pub fn follows(&self, old: &Self) -> bool {
        self.knowledge_operation == old.knowledge_operation
            && self.source == old.source
            && self.id == old.id
            && self.expected_revision == old.expected_revision
            && (old.state == State::Pending || old.state == self.state)
    }
    fn exact(&self, receipt: &Value) -> Result<(), Error> {
        let d = &receipt["detail"];
        let r = &d["revision"];
        if receipt["operationId"] != self.knowledge_operation
            || d["entry"]["projectId"] != self.source.project()?.project_id
            || d["entry"]["id"] != self.id
            || r["knowledgeId"] != self.id
            || r["revision"].as_u64() != Some(u64::from(self.expected_revision) + 1)
            || r["author"]["type"] != "user"
        {
            return Err(Error::Unknown);
        }
        Ok(())
    }
}

pub(super) async fn read(
    t: &Transport,
    r: &Read,
    journal: &super::Journal,
) -> Result<Value, Error> {
    t.gate(false).await?;
    let project = &t.source.project()?.project_id;
    let value = if let Read::Pending {
        id,
        expected_revision,
    } = r
    {
        if id.as_ref().is_some_and(|id| !valid_id(id)) {
            return Err(Error::Invalid);
        }
        json!(
            journal
                .knowledge
                .values()
                .filter(|r| r.source == t.source
                    && (r.state == State::Pending
                        || (r.state == State::Saved
                            && Some(&r.id) == id.as_ref()
                            && Some(r.expected_revision) == *expected_revision)))
                .map(|r| json!({"operationId":r.knowledge_operation,"id":r.id}))
                .collect::<Vec<_>>()
        )
    } else {
        let v = t.get(&r.path(project)?).await?;
        if let Read::Detail { id, revision } = r {
            if v["entry"]["projectId"] != *project
                || v["entry"]["id"] != *id
                || v["revision"]["knowledgeId"] != *id
                || revision.is_some_and(|n| v["revision"]["revision"] != n)
            {
                return Err(Error::Invalid);
            }
        }
        v
    };
    t.gate(false).await?;
    Ok(json!({"projectId":project,"data":value}))
}

pub(super) async fn check(
    t: &Transport,
    journal: &mut super::Journal,
    id: &str,
) -> Result<Value, Error> {
    t.gate(false).await?;
    let mut record = journal
        .knowledge
        .get(id)
        .filter(|r| r.source == t.source)
        .cloned()
        .ok_or(Error::Stale)?;
    if record.state == State::Rejected {
        return Ok(json!({"operationId":id,"state":"rejected","receipt":null}));
    }
    let receipt = t
        .get(&format!(
            "/api/projects/{}/knowledge/operations/{id}",
            t.source.project()?.project_id
        ))
        .await?;
    if !receipt.is_null() {
        record.exact(&receipt)?;
        if record.state == State::Pending {
            record.state = State::Saved;
            journal.save_knowledge(record.clone())?;
        }
    }
    t.gate(false).await?;
    Ok(
        json!({"operationId":id,"state":if !receipt.is_null() {"saved"} else {"unknown"},"receipt":receipt}),
    )
}

pub(super) async fn save(
    t: &Transport,
    journal: &mut super::Journal,
    edit: &Edit,
    gate: &std::sync::Mutex<crate::bridge::Gate>,
) -> Result<Value, Error> {
    edit.validate()?;
    t.gate(false).await?;
    if edit.project_id != t.source.project()?.project_id {
        return Err(Error::Stale);
    }
    if journal
        .knowledge
        .values()
        .any(|r| r.source == t.source && r.state == State::Pending)
    {
        return Err(Error::Unknown);
    }
    let current = t
        .get(&format!(
            "/api/projects/{}/knowledge/{}",
            t.source.project()?.project_id,
            edit.id
        ))
        .await?;
    if current["entry"]["projectId"] != t.source.project()?.project_id
        || current["entry"]["id"] != edit.id
        || current["entry"]["revision"] != edit.expected_revision
    {
        return Err(Error::Stale);
    }
    t.gate(false).await?;
    crate::bridge::Command::KnowledgeSave(edit.clone())
        .admit(&gate.lock().expect("bridge gate poisoned"))?;
    let id = uuid::Uuid::new_v4().to_string();
    let record = Record {
        knowledge_operation: id.clone(),
        source: t.source.clone(),
        id: edit.id.clone(),
        expected_revision: edit.expected_revision,
        state: State::Pending,
    };
    // Persist before entering PUT. Recovery only looks up this operation, even after a crash before send.
    journal.save_knowledge(record)?;
    let payload = json!({"operationId":id,"expectedRevision":edit.expected_revision,"title":edit.title,
        "synopsis":edit.synopsis,"body":edit.body,"sources":edit.sources,"reason":edit.reason});
    let response = t
        .client
        .put(t.url(&format!(
            "/api/projects/{}/knowledge/{}",
            t.source.project()?.project_id,
            edit.id
        )))
        .header("x-pilot-github-capability", t.local()?)
        .header("content-type", "application/json")
        .body(payload.to_string())
        .send()
        .await;
    match response {
        Ok(response) if response.status().is_success() => check(t, journal, &id).await,
        Ok(response) if matches!(response.status().as_u16(), 400 | 409 | 404) => {
            let mut record = journal.knowledge.get(&id).cloned().ok_or(Error::Storage)?;
            record.state = State::Rejected;
            journal.save_knowledge(record)?;
            Ok(json!({"operationId":id,"state":"rejected","receipt":null}))
        }
        _ => Ok(json!({"operationId":id,"state":"unknown","receipt":null})),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn paths_are_project_local_and_encoded() {
        let r: Read = serde_json::from_value(
            json!({"kind":"list","query":"a&missionId=other","cursor":null,"missionId":null}),
        )
        .unwrap();
        let p = r.path("p").unwrap();
        assert!(p.contains("%26"));
        assert!(!p.contains("missionId=other"));
        assert!(
            Read::Detail {
                id: "../other".into(),
                revision: None
            }
            .path("p")
            .is_err()
        );
        assert!(
            Read::Detail {
                id: "k".into(),
                revision: Some(0)
            }
            .path("p")
            .is_err()
        );
    }
}
