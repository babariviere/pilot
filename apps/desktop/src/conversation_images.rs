//! Exact inline pi-ai image blocks only. No paths, URLs, asset inference or I/O.
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::sync::Arc;

#[derive(Clone)]
pub(crate) struct Source {
    pub(crate) owner: Option<(crate::delivery_store::Host, String)>,
    pub(crate) block: usize,
    pub(crate) mime: String,
    pub(crate) hash: Option<String>,
    pub(crate) data: Option<Arc<String>>,
    pub(crate) problem: Option<&'static str>,
    /// Upright header size, known before decode so the row keeps its geometry.
    pub(crate) size: Option<(u32, u32)>,
}
impl PartialEq for Source {
    fn eq(&self, other: &Self) -> bool {
        self.owner == other.owner
            && self.block == other.block
            && self.mime == other.mime
            && self.hash == other.hash
            && self.problem == other.problem
    }
}
impl Eq for Source {}
impl Source {
    pub(crate) fn read(block: usize, value: &Value) -> Self {
        let mime = value["mimeType"].as_str().unwrap_or("");
        let data = value["data"].as_str();
        let mut result = Self {
            owner: None,
            block,
            mime: if mime.len() <= 80 {
                mime.into()
            } else {
                "unknown".into()
            },
            hash: None,
            data: None,
            problem: None,
            size: None,
        };
        let Some(data) = data else {
            result.problem =
                Some("Stored image has no supported inline bytes. Paths and URLs are not loaded.");
            return result;
        };
        // Both metadata and the exact stored bytes qualify source identity.
        let mut digest = Sha256::new();
        digest.update(mime.as_bytes());
        digest.update([0]);
        digest.update(data.as_bytes());
        result.hash = Some(
            digest
                .finalize()
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>(),
        );
        result.problem = match mime {
            "image/png" | "image/jpeg" | "image/gif" => None,
            "image/webp" => Some("WebP preview is unavailable. Stored source is preserved."),
            _ => Some("Unsupported stored image format. No external image is loaded."),
        };
        if result.problem.is_none() {
            result.size = crate::artifact_image::intrinsic_size(mime, data);
            result.data = Some(Arc::new(data.into()));
        }
        result
    }
    pub(crate) fn retained_bytes(&self) -> usize {
        self.data.as_ref().map_or(0, |data| data.len())
    }
    pub(crate) fn decode(
        &self,
        stop: impl Fn() -> bool,
    ) -> Result<crate::artifact_image::Raster, &'static str> {
        if stop() {
            return Err("Image read cancelled.");
        }
        let data = self
            .data
            .as_ref()
            .ok_or("No supported inline image source.")?;
        // Prefix creation, canonical base64 validation and codec work stay off-UI.
        crate::artifact_image::decode(&format!("data:{};base64,{data}", self.mime), stop)
    }
}

#[cfg(test)]
#[path = "conversation_images_tests.rs"]
mod tests;

#[cfg(any(test, feature = "native-probes"))]
#[path = "conversation_images_fixture.rs"]
pub(crate) mod fixture;
