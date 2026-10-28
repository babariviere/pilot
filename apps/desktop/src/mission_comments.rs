//! Read-only projection of the comments in the existing mission detail GET.
//! No reply, resolve or delete contract: Pilot Next only reads them.
use crate::local_model::valid_id;
use serde_json::Value;
use std::collections::HashSet;

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Comment {
    pub(crate) id: String,
    /// Exact received text and quoted brief excerpt.
    pub(crate) text: String,
    pub(crate) anchor: Option<String>,
    pub(crate) revision: Option<u64>,
    /// Omitted: the user wrote it.
    pub(crate) author: Option<String>,
    /// Omitted: the coordinator, or the user when there is none.
    pub(crate) target: Option<String>,
    pub(crate) created_at: f64,
    pub(crate) resolved_at: Option<f64>,
    pub(crate) resolved_by: Option<String>,
}
impl Comment {
    pub(crate) fn open(&self) -> bool {
        self.resolved_at.is_none()
    }
}
/// `Ok(None)`: the response has no comments field, so coverage is unknown, not empty.
/// The daemon sends every open comment, then only recently resolved ones.
pub(crate) fn project(v: &Value) -> Result<Option<Vec<Comment>>, &'static str> {
    let Some(raw) = v.get("comments") else {
        return Ok(None);
    };
    let raw = raw.as_array().ok_or("Mission comments are malformed.")?;
    let mut seen = HashSet::new();
    let mut rows = Vec::with_capacity(raw.len());
    for c in raw {
        let comment = id(&c["id"])?.ok_or("Invalid comment identity.")?;
        if !seen.insert(comment.clone()) {
            return Err("Duplicate comment identity.");
        }
        let time = |v: &Value| match v {
            Value::Null => Ok(None),
            v => v
                .as_f64()
                .filter(|t| t.is_finite())
                .map(Some)
                .ok_or("Invalid comment time."),
        };
        rows.push(Comment {
            text: c["text"]
                .as_str()
                .ok_or("Comment text is malformed.")?
                .to_owned(),
            anchor: match &c["anchor"] {
                Value::Null => None,
                v => Some(v.as_str().ok_or("Comment quote is malformed.")?.to_owned()),
            },
            revision: match &c["revision"] {
                Value::Null => None,
                v => Some(v.as_u64().ok_or("Invalid comment brief revision.")?),
            },
            author: id(&c["authorSessionId"])?,
            target: id(&c["targetSessionId"])?,
            created_at: time(&c["createdAt"])?.ok_or("Invalid comment time.")?,
            resolved_at: time(&c["resolvedAt"])?,
            resolved_by: id(&c["resolvedBySessionId"])?,
            id: comment,
        });
    }
    Ok(Some(rows))
}
fn id(v: &Value) -> Result<Option<String>, &'static str> {
    match v {
        Value::Null => Ok(None),
        v => v
            .as_str()
            .filter(|s| valid_id(s))
            .map(|s| Some(s.to_owned()))
            .ok_or("Invalid comment chat identity."),
    }
}

#[cfg(test)]
#[path = "mission_comments_tests.rs"]
mod tests;
