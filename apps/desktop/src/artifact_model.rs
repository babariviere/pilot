//! Exact read provenance. Never resolve unpinned/cross-session links or consume prepared HTML.
use serde_json::Value;
use std::sync::Arc;
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Reference {
    pub(crate) id: String,
    pub(crate) session: String,
    pub(crate) revision: u32,
    pub(crate) title: String,
    pub(crate) kind: String,
}
impl Reference {
    pub(crate) fn parse(value: &Value, owner: &str) -> Option<Self> {
        let id = value["id"]
            .as_str()
            .filter(|id| crate::local_model::valid_id(id))?;
        if value["sessionId"].as_str() != Some(owner) {
            return None;
        }
        let title = value["title"].as_str()?;
        let kind = value["kind"].as_str()?;
        if title.encode_utf16().count() > 240
            || kind.len() > 32
            || !crate::local_model::valid_id(owner)
        {
            return None;
        }
        let revision = value["revision"]
            .as_u64()
            .filter(|n| (1..=1_000_000).contains(n))? as u32;
        Some(Self {
            id: id.into(),
            session: owner.into(),
            revision,
            title: title.into(),
            kind: kind.into(),
        })
    }
    pub(crate) fn same_revision(&self, other: &Self) -> bool {
        self.id == other.id && self.session == other.session && self.revision == other.revision
    }
}
pub(crate) fn summaries(value: &Value, owner: &str) -> Arc<Vec<Reference>> {
    Arc::new(
        value
            .as_array()
            .into_iter()
            .flatten()
            .take(64)
            .filter_map(|v| Reference::parse(v, owner))
            .collect(),
    )
}
#[derive(Clone, Debug)]
pub(crate) struct Revision {
    pub(crate) reference: Reference,
    pub(crate) source: Arc<String>,
    pub(crate) data: Value,
    pub(crate) visual_supported: bool,
    pub(crate) created_at: f64,
    pub(crate) updated_at: f64,
}
impl Revision {
    pub(crate) fn parse(value: Value, expected: &Reference) -> Result<Self, &'static str> {
        let reference =
            Reference::parse(&value, &expected.session).ok_or("Invalid artifact metadata")?;
        if !reference.same_revision(expected) {
            return Err("Artifact revision/ownership changed; no preview was evaluated");
        }
        let source = value["source"]
            .as_str()
            .ok_or("Artifact source is unavailable")?;
        // The HTTP envelope is independently capped. Visual source has its stricter VM cap.
        if source.len() > 3 * 1024 * 1024 {
            return Err("Artifact source exceeds the reader limit");
        }
        let created_at = value["createdAt"]
            .as_f64()
            .filter(|n| n.is_finite())
            .ok_or("Invalid artifact provenance")?;
        let updated_at = value["updatedAt"]
            .as_f64()
            .filter(|n| n.is_finite())
            .ok_or("Invalid artifact provenance")?;
        let visual_supported = reference.kind == "visual"
            && value["visual"]["api"] == 1
            && value["visual"]["engine"] == "quickjs-ng 0.17.0";
        Ok(Self {
            reference,
            source: Arc::new(source.into()),
            data: value.get("data").cloned().unwrap_or(Value::Null),
            visual_supported,
            created_at,
            updated_at,
        })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn scoped_revision_checks_do_not_trust_titles_or_html() {
        let v = json!({"id":"synthetic","sessionId":"owner","revision":2,"title":"Synthetic","kind":"visual","source":"()=>null","html":"not consumed","visual":{"api":1,"engine":"quickjs-ng 0.17.0"},"createdAt":1,"updatedAt":2});
        let expected = Reference::parse(&v, "owner").unwrap();
        assert!(Reference::parse(&v, "other").is_none());
        let r = Revision::parse(v.clone(), &expected).unwrap();
        assert!(r.visual_supported);
        assert_eq!(r.source.as_str(), "()=>null");
        let mut old = expected.clone();
        old.revision = 1;
        assert!(Revision::parse(v.clone(), &old).is_err());
        let mut future = v;
        future["visual"]["api"] = json!(2);
        assert!(!Revision::parse(future, &expected).unwrap().visual_supported);
    }
}
