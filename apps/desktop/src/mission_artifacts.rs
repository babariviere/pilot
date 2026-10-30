//! Mission-level links only. Each pin carries its own owner, kind and revision.
use crate::artifact_model::Reference;
use serde_json::{Value, json};
use std::{collections::HashSet, sync::Arc};

#[derive(Clone, Debug)]
pub(crate) struct Link {
    pub(crate) key: String,
    pub(crate) title: String,
    pub(crate) kind: String,
    pub(crate) reference: Option<Reference>,
}

pub(crate) fn project(v: &Value) -> Result<Arc<Vec<Link>>, &'static str> {
    let raw = v["artifacts"]
        .as_array()
        .ok_or("Artifact links weren't included in this mission response.")?;
    let mut seen = HashSet::new();
    let mut rows = Vec::new();
    for link in raw {
        // Task pins are independent. Never merge/restamp them with mission pins.
        if !link["taskId"].is_null() {
            continue;
        }
        let valid = |name| {
            link[name]
                .as_str()
                .filter(|s| crate::local_model::valid_id(s))
        };
        let owner = valid("sessionId").ok_or("Artifact owner is unavailable.")?;
        let id = valid("artifactId").ok_or("Artifact identity is unavailable.")?;
        let key = serde_json::to_string(&[owner, id]).expect("string tuple");
        if !seen.insert(id.to_owned()) {
            return Err("Mission artifact links are ambiguous. No artifact was opened.");
        }
        let title = link["title"]
            .as_str()
            .ok_or("Artifact title is unavailable.")?;
        let kind = link["kind"]
            .as_str()
            .ok_or("Artifact kind is unavailable.")?;
        let value = json!({"id":id,"sessionId":owner,"title":title,"kind":kind,"revision":link["revision"]});
        let reference = Reference::parse(&value, owner);
        if title.encode_utf16().count() > 240
            || !matches!(
                kind,
                "image" | "visual" | "html" | "react" | "swiftui" | "shader"
            )
        {
            return Err("Artifact link metadata is invalid.");
        }
        rows.push(Link {
            key,
            title: title.into(),
            kind: kind.into(),
            reference,
        });
    }
    Ok(Arc::new(rows))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn mission_and_task_pins_keep_independent_revision_metadata() {
        let mission = json!({"artifactId":"art","sessionId":"owner","revision":5,"kind":"html","title":"New"});
        let mut task = mission.clone();
        task["taskId"] = json!("task");
        task["revision"] = json!(4);
        task["kind"] = json!("image");
        let v = json!({"artifacts":[task.clone(),mission]});
        let rows = project(&v).unwrap();
        assert_eq!(rows.len(), 1);
        let r = rows[0].reference.as_ref().unwrap();
        assert_eq!((r.revision, r.kind.as_str()), (5, "html"));
        assert_eq!(v["artifacts"][0], task);
    }
    #[test]
    fn absent_unpinned_invalid_and_ambiguous_links_never_infer_latest() {
        assert!(project(&json!({})).is_err());
        assert!(project(&json!({"artifacts":[]})).unwrap().is_empty());
        let link = json!({"artifactId":"art","sessionId":"owner","kind":"image","title":"Pin"});
        for revision in [Value::Null, json!(0), json!(-1), json!(1.5), json!("2")] {
            let mut l = link.clone();
            l["revision"] = revision;
            assert!(
                project(&json!({"artifacts":[l]})).unwrap()[0]
                    .reference
                    .is_none()
            );
        }
        assert!(project(&json!({"artifacts":[link.clone(),link]})).is_err());
        for kind in ["unknown", "", "future-kind"] {
            assert!(project(&json!({"artifacts":[{"artifactId":"art","sessionId":"owner","revision":1,"kind":kind,"title":"Bad kind"}]})).is_err());
        }
    }
}
