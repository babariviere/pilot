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
        Self::parse_kind(value, owner, value["kind"].as_str()?)
    }
    fn parse_kind(value: &Value, owner: &str, kind: &str) -> Option<Self> {
        let id = value["id"]
            .as_str()
            .filter(|id| crate::local_model::valid_id(id))?;
        if value["sessionId"].as_str() != Some(owner) {
            return None;
        }
        let title = value["title"].as_str()?;
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
    pub(crate) fn pinned(value: &Value) -> Option<Self> {
        Self::parse_kind(value, value["sessionId"].as_str()?, "unknown")
    }
}
/// Upright raster size an inline pin reserves before its revision is read: the
/// publication's header hint, or the exact revision's decoded size. Only layout
/// uses it; the read keeps its identity, kind and codec checks, and decoding wins.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct RasterSize {
    pub(crate) width: u32,
    pub(crate) height: u32,
    /// GIF previews show their first frame, with a note.
    pub(crate) first_frame: bool,
}
impl RasterSize {
    /// A publication entry's `data.image`, for formats and sizes this client decodes.
    pub(crate) fn hint(value: &Value) -> Option<Self> {
        let first_frame = match value["mimeType"].as_str()? {
            "image/png" | "image/jpeg" => false,
            "image/gif" => true,
            _ => return None,
        };
        let axis = |key| value[key].as_u64().and_then(|n| u32::try_from(n).ok());
        let (width, height) = (axis("width")?, axis("height")?);
        crate::artifact_image::dimensions(width, height).ok()?;
        Some(Self {
            width,
            height,
            first_frame,
        })
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
    pub(crate) fn parse(mut value: Value, expected: &Reference) -> Result<Self, &'static str> {
        let reference =
            Reference::parse(&value, &expected.session).ok_or("Invalid artifact metadata")?;
        if !reference.same_revision(expected) {
            return Err("Artifact revision/ownership changed; no preview was evaluated");
        }
        if expected.kind != "unknown" && reference.kind != expected.kind {
            return Err("Artifact kind changed; no preview was evaluated");
        }
        let source = value["source"]
            .as_str()
            .ok_or("Artifact source is unavailable")?;
        // The HTTP envelope is independently capped. Visual source has its stricter VM cap.
        let source_cap = if reference.kind == "image" {
            crate::artifact_image::SOURCE_CAP
        } else {
            3 * 1024 * 1024
        };
        if source.len() > source_cap {
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
        let source = match value.get_mut("source").map(std::mem::take) {
            Some(Value::String(source)) => source,
            _ => return Err("Artifact source is unavailable"),
        };
        Ok(Self {
            reference,
            source: Arc::new(source),
            data: value
                .get_mut("data")
                .map(std::mem::take)
                .unwrap_or(Value::Null),
            visual_supported,
            created_at,
            updated_at,
        })
    }
    /// A large raster envelope never materializes its redundant prepared HTML.
    /// Struct deserialization also rejects duplicate recognized metadata fields.
    pub(crate) fn image_bytes(bytes: &[u8], expected: &Reference) -> Result<Self, &'static str> {
        if expected.kind != "image" {
            return Err("Image read requires verified image metadata");
        }
        if bytes.len() > crate::artifact_image::HTTP_CAP {
            return Err("Stored image envelope exceeds its read limit");
        }
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Wire {
            id: String,
            session_id: String,
            revision: u32,
            title: String,
            kind: String,
            source: String,
            created_at: f64,
            updated_at: f64,
        }
        let w: Wire =
            serde_json::from_slice(bytes).map_err(|_| "Invalid stored image revision JSON")?;
        let value = Value::Object(serde_json::Map::from_iter([
            ("id".into(), Value::String(w.id)),
            ("sessionId".into(), Value::String(w.session_id)),
            ("revision".into(), Value::from(w.revision)),
            ("title".into(), Value::String(w.title)),
            ("kind".into(), Value::String(w.kind)),
            ("source".into(), Value::String(w.source)),
            ("createdAt".into(), Value::from(w.created_at)),
            ("updatedAt".into(), Value::from(w.updated_at)),
        ]));
        Self::parse(value, expected)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn artifact_image_admission_does_not_raise_visual_limits_or_trust_mismatched_provenance() {
        let v = json!({"id":"synthetic","sessionId":"owner","revision":2,"title":"Synthetic","kind":"image","source":"stored bytes","html":"ignored","createdAt":1,"updatedAt":2});
        let expected = Reference::parse(&v, "owner").unwrap();
        let bytes = serde_json::to_vec(&v).unwrap();
        let mut wrong_kind = expected.clone();
        wrong_kind.kind = "visual".into();
        assert!(
            Revision::parse(v.clone(), &wrong_kind).is_err(),
            "known kinds must match in both directions"
        );
        let r = Revision::image_bytes(&bytes, &expected).unwrap();
        assert_eq!(r.source.as_str(), "stored bytes");
        assert!(!r.visual_supported);
        assert!(r.data.is_null());
        for (key, value) in [
            ("sessionId", json!("other")),
            ("id", json!("other")),
            ("revision", json!(1)),
            ("kind", json!("visual")),
        ] {
            let mut bad = v.clone();
            bad[key] = value;
            assert!(Revision::image_bytes(&serde_json::to_vec(&bad).unwrap(), &expected).is_err());
        }
        let mut pin = expected.clone();
        pin.kind = "unknown".into();
        assert!(Revision::image_bytes(&bytes, &pin).is_err());
        assert!(Revision::parse(v.clone(), &pin).is_ok());
        let mut large = v;
        large["source"] = json!("a".repeat(3 * 1024 * 1024 + 1));
        assert!(Revision::parse(large.clone(), &expected).is_ok());
        large["kind"] = json!("visual");
        assert!(Revision::parse(large, &pin).is_err());
        assert!(Revision::image_bytes(br#"{"id":"synthetic","sessionId":"owner","revision":2,"title":"Synthetic","kind":"image","kind":"visual","source":"a","createdAt":1,"updatedAt":2}"#,&expected).is_err());
    }
    #[test]
    fn scoped_revision_checks_do_not_trust_titles_or_html() {
        let v = json!({"id":"synthetic","sessionId":"owner","revision":2,"title":"Synthetic","kind":"visual","source":"()=>null","html":"not consumed","visual":{"api":1,"engine":"quickjs-ng 0.17.0"},"createdAt":1,"updatedAt":2});
        let expected = Reference::parse(&v, "owner").unwrap();
        let mut bare = v.clone();
        bare.as_object_mut().unwrap().remove("kind");
        let pin = Reference::pinned(&bare).unwrap();
        assert!(Reference::parse(&bare, "owner").is_none());
        assert!(Revision::parse(bare, &pin).is_err());
        assert!(Revision::parse(v.clone(), &pin).unwrap().visual_supported);
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
    #[test]
    fn raster_size_hints_cover_only_decodable_formats_and_sizes() {
        let hint = |v| RasterSize::hint(&v);
        assert_eq!(
            hint(json!({"mimeType":"image/png","width":1024,"height":640})),
            Some(RasterSize {
                width: 1024,
                height: 640,
                first_frame: false
            })
        );
        assert!(
            hint(json!({"mimeType":"image/gif","width":3,"height":2}))
                .unwrap()
                .first_frame
        );
        assert!(hint(json!({"mimeType":"image/jpeg","width":3,"height":2})).is_some());
        for v in [
            json!(null),
            json!({"mimeType":"image/webp","width":3,"height":2}),
            json!({"mimeType":"image/png","width":0,"height":2}),
            json!({"mimeType":"image/png","width":8193,"height":2}),
            json!({"mimeType":"image/png","width":4096,"height":4096}),
            json!({"mimeType":"image/png","width":-3,"height":2}),
            json!({"mimeType":"image/png","width":3.5,"height":2}),
            json!({"mimeType":"image/png","width":"3","height":2}),
        ] {
            assert_eq!(hint(v.clone()), None, "{v}");
        }
    }
}
