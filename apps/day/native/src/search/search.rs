//! Passive search over the profile's authorized project catalog. No focus change.
use super::{Error, Transport, delivery, delivery_artifact, knowledge, new_chat, valid_id};
use futures_util::{StreamExt, stream};
use serde::Deserialize;
use serde_json::{Value, json};
use std::time::Duration;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct Request {
    query: String,
    project_id: Option<String>,
    cursor: Option<String>,
}

impl Request {
    pub(crate) fn validate(&self) -> Result<(), Error> {
        if let Some(cursor) = &self.cursor
            && (self.project_id.is_none()
                || self.query.trim().is_empty()
                || uuid::Uuid::parse_str(cursor).is_err())
        {
            return Err(Error::Invalid);
        }
        if self.query.chars().count() > 200
            || self.project_id.as_deref().is_some_and(|id| !valid_id(id))
        {
            return Err(Error::Invalid);
        }
        Ok(())
    }
}

/// Re-resolve item project scope at the point of use, never from TSX labels.
pub(super) async fn project(root: &Transport, id: &str) -> Result<Transport, Error> {
    if let Some(own) = &root.source.project
        && own.project_id != id
    {
        return Err(Error::Identity);
    }
    let catalog = new_chat::inventory(root).await?;
    let row = catalog["projects"]
        .as_array()
        .ok_or(Error::Invalid)?
        .iter()
        .find(|row| row["projectId"] == id)
        .ok_or(Error::Identity)?;
    root.for_project(row)
}

pub(super) async fn read(root: &Transport, request: &Request) -> Result<Value, Error> {
    let catalog = new_chat::inventory(root).await?;
    let allowed: Vec<_> = catalog["projects"]
        .as_array()
        .ok_or(Error::Invalid)?
        .iter()
        .filter(|row| {
            root.source
                .project
                .as_ref()
                .is_none_or(|own| row["projectId"] == own.project_id)
        })
        .collect();
    let projects: Vec<_> = allowed
        .iter()
        .map(|row| json!({"id":row["projectId"],"name":row["name"]}))
        .collect();
    if request
        .project_id
        .as_ref()
        .is_some_and(|id| !allowed.iter().any(|row| row["projectId"] == *id))
    {
        return Err(Error::Identity);
    }
    let query = request.query.trim();
    let mut hits = Vec::new();
    let mut partial = false;
    let mut more = false;
    let mut next_cursor = None;
    if !query.is_empty() {
        let tokens: Vec<_> = query.split_whitespace().map(str::to_lowercase).collect();
        let selected: Vec<Value> = allowed
            .iter()
            .copied()
            .filter(|p| {
                request
                    .project_id
                    .as_ref()
                    .is_none_or(|id| p["projectId"] == *id)
            })
            .cloned()
            .collect();
        // Keep a slow source from delaying the other projects to the transport's 15-second timeout.
        let result = tokio::time::timeout(Duration::from_secs(2), async {
            let tokens = &tokens;
            let mut reads = stream::iter(selected.into_iter().map(|row| async move {
                let t = root.for_project(&row)?;
                project_hits(&t, &row, query, tokens, request.cursor.as_deref()).await
            }))
            .buffer_unordered(2);
            while let Some(reply) = reads.next().await {
                match reply {
                    Ok((rows, limited, incomplete, cursor)) => {
                        more |= limited;
                        partial |= incomplete;
                        if request.project_id.is_some() {
                            next_cursor = cursor;
                        }
                        hits.extend(rows);
                    }
                    Err(_) => partial = true,
                }
            }
        })
        .await;
        partial |= result.is_err();
    }
    // Do not publish a search from a replaced profile or a revoked project.
    let current = new_chat::inventory(root).await?;
    if current["projects"] != catalog["projects"] {
        return Err(Error::Stale);
    }
    hits.sort_by(|a, b| {
        let score = |r: &Value| {
            let title = r["title"].as_str().unwrap_or_default().to_lowercase();
            let query = query.to_lowercase();
            (title != query, !title.starts_with(&query), title)
        };
        score(a)
            .cmp(&score(b))
            .then_with(|| a["key"].as_str().cmp(&b["key"].as_str()))
    });
    // Leave room for places in the palette without retaining hundreds of rows.
    more |= hits.len() > 30;
    hits.truncate(30);
    Ok(
        json!({"projects":projects,"hits":hits,"partial":partial,"more":more,"nextCursor":next_cursor}),
    )
}

async fn project_hits(
    t: &Transport,
    project: &Value,
    query: &str,
    tokens: &[String],
    cursor: Option<&str>,
) -> Result<(Vec<Value>, bool, bool, Option<String>), Error> {
    t.gate(false).await?;
    let id = &t.source.project()?.project_id;
    let mut metadata = format!(
        "/api/projects/{id}/metadata-search?q={}",
        knowledge::encoded(query)
    );
    if let Some(cursor) = cursor {
        metadata.push_str("&cursor=");
        metadata.push_str(&knowledge::encoded(cursor));
    }
    let library = knowledge::Read::List {
        query: query.into(),
        cursor: None,
        mission_id: None,
    }
    .path(id)?;
    let deliveries = format!(
        "/api/projects/{id}/result-search?q={}",
        knowledge::encoded(query)
    );
    let (metadata, results, library) = if cursor.is_some() {
        (
            t.get(&metadata).await,
            Ok(json!({"items":[]})),
            Ok(json!({"entries":[]})),
        )
    } else {
        tokio::join!(t.get(&metadata), t.get(&deliveries), t.get(&library))
    };
    if cursor.is_some() && metadata.is_err() {
        return Err(Error::Stale);
    }
    let next_cursor = metadata
        .as_ref()
        .ok()
        .filter(|v| v["projectId"] == *id)
        .and_then(|v| v["nextCursor"].as_str())
        .filter(|id| uuid::Uuid::parse_str(id).is_ok())
        .map(str::to_owned);
    let mut out = Vec::new();
    let mut add = |kind: &str, key: String, title: &Value, target: Value, supplied_match: bool| {
        let Some(title) = title.as_str().filter(|s| !s.trim().is_empty()) else {
            return;
        };
        if !supplied_match && !tokens.iter().all(|s| title.to_lowercase().contains(s)) {
            return;
        }
        out.push(
            json!({"kind":kind,"key":format!("{kind}:{id}:{key}"),"title":title,
            "projectId":id,"projectName":project["name"],"target":target}),
        );
    };
    let mut limited = false;
    let mut incomplete = false;
    for (source, key, kind) in [
        (metadata, "items", "metadata"),
        (results, "items", "result"),
        (library, "entries", "knowledge"),
    ] {
        let Ok(source) = source else {
            incomplete = true;
            continue;
        };
        if kind == "metadata" && source["projectId"] != *id {
            incomplete = true;
            continue;
        }
        let Some(rows) = source[key].as_array().filter(|rows| rows.len() <= 30) else {
            incomplete = true;
            continue;
        };
        limited |= source["more"] == true;
        incomplete |= source["partial"] == true;
        for row in rows {
            let title = &row["title"];
            let kind = if kind == "metadata" {
                row["kind"].as_str().unwrap_or("")
            } else {
                kind
            };
            match kind {
                "mission" | "chat" => {
                    if let Some(target) = row["id"].as_str().filter(|id| valid_id(id)) {
                        add(kind, target.into(), title, json!(target), false);
                    }
                }
                "result" if row["subject"]["projectId"] == *id => {
                    if let Ok(subject) =
                        serde_json::from_value::<delivery::Subject>(row["subject"].clone())
                        && subject.validate().is_ok()
                    {
                        add(kind, subject.path(), title, row["subject"].clone(), false);
                    }
                }
                "output" => {
                    if let Some(session) = row["sessionId"].as_str().filter(|s| valid_id(s))
                        && let Some(artifact) = row["artifactId"]
                            .as_str()
                            .filter(|s| uuid::Uuid::parse_str(s).is_ok())
                        && let Some(revision) = row["revision"]
                            .as_u64()
                            .filter(|n| *n > 0 && *n <= 9_007_199_254_740_991)
                        && let Some(format) = row["artifactKind"]
                            .as_str()
                            .filter(|s| delivery_artifact::kind_ok(s))
                    {
                        add(
                            kind,
                            format!("{session}:{artifact}"),
                            title,
                            json!({
                                "sessionId":session,"artifactId":artifact,"revision":revision,"kind":format,
                                "title":title,"updatedAt":row["updatedAt"],
                            }),
                            false,
                        );
                    }
                }
                "knowledge" if row["projectId"] == *id => {
                    if let Some(key) = row["id"].as_str().filter(|id| valid_id(id))
                        && let Some(revision) = row["revision"]
                            .as_u64()
                            .filter(|r| *r > 0 && *r <= u64::from(u32::MAX))
                    {
                        add(
                            kind,
                            key.into(),
                            title,
                            json!({"id":key,"revision":revision}),
                            true,
                        );
                    }
                }
                _ => {}
            }
        }
    }
    t.gate(false).await?;
    Ok((out, limited, incomplete, next_cursor))
}
