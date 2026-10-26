//! Current-chat gallery policy. No source, full-size raster, I/O or view lifetime is cached here.
use crate::artifact_model::Reference;
use gpui_kit::RenderImage;
use serde_json::Value;
use std::{
    collections::{BTreeSet, VecDeque},
    ops::Range,
    sync::Arc,
};

pub(crate) const INDEX_CAP: usize = 64;
pub(crate) const REQUEST_CAP: usize = 12;
pub(crate) const CACHE_ENTRIES: usize = 12;
pub(crate) const CACHE_BYTES: usize = 8 * 1024 * 1024;
pub(crate) const THUMB_WIDTH: u32 = 512;
pub(crate) const THUMB_HEIGHT: u32 = 320;
pub(crate) const THUMB_BYTES: usize = THUMB_WIDTH as usize * THUMB_HEIGHT as usize * 4;

/// Host identity and owner are fenced by the pane; title is deliberately not identity.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct Key {
    session: String,
    id: String,
    revision: u32,
    kind: String,
}
impl Key {
    pub(crate) fn new(reference: &Reference) -> Self {
        Self {
            session: reference.session.clone(),
            id: reference.id.clone(),
            revision: reference.revision,
            kind: reference.kind.clone(),
        }
    }
    pub(crate) fn element_id(&self) -> String {
        format!(
            "artifact-card:{}:{}:{}:{}",
            self.session, self.id, self.revision, self.kind
        )
    }
    pub(crate) fn same_artifact(&self, reference: &Reference) -> bool {
        self.session == reference.session && self.id == reference.id
    }
}

/// Only an actual, valid matching-chat artifacts message establishes an empty index.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Metadata {
    received: bool,
    limited: bool,
    stale: bool,
    problem: Option<&'static str>,
}
impl Metadata {
    pub(crate) fn is_received(&self) -> bool {
        self.received
    }
    pub(crate) fn is_limited(&self) -> bool {
        self.limited
    }
    pub(crate) fn is_stale(&self) -> bool {
        self.stale
    }
    pub(crate) fn mark_stale(&mut self) {
        self.stale = true;
    }
    pub(crate) fn problem(&self) -> Option<&'static str> {
        self.problem
    }
    pub(crate) fn accept(&mut self, value: &Value, owner: &str) -> Option<Arc<Vec<Reference>>> {
        match parse_index(value, owner) {
            Ok((items, limited)) => {
                *self = Self {
                    received: true,
                    limited,
                    stale: false,
                    problem: None,
                };
                Some(items)
            }
            Err(problem) => {
                // The caller keeps its last usable index, rather than replacing it with empty.
                self.problem = Some(problem);
                None
            }
        }
    }
}
fn parse_index(value: &Value, owner: &str) -> Result<(Arc<Vec<Reference>>, bool), &'static str> {
    let rows = value
        .as_array()
        .ok_or("Artifact metadata is unavailable.")?;
    let items = crate::artifact_model::summaries(value, owner);
    if items.len() != rows.len().min(INDEX_CAP) {
        return Err("Artifact metadata changed or is invalid.");
    }
    let mut ids = BTreeSet::new();
    for reference in items.iter() {
        if !ids.insert(reference.id.clone()) {
            return Err("Artifact metadata contains an ambiguous identity.");
        }
    }
    Ok((items, rows.len() > INDEX_CAP))
}

pub(crate) fn columns(width: f32, rem: f32, gap: f32) -> usize {
    if !width.is_finite()
        || !rem.is_finite()
        || !gap.is_finite()
        || rem <= 0.
        || width <= 0.
        || gap < 0.
    {
        return 1;
    }
    (((width + gap) / (20. * rem + gap)).floor() as usize).clamp(1, 4)
}
/// Uses the list's resolved stride, never its measurement-only render callback.
pub(crate) fn visible_rows(
    offset: f32,
    height: f32,
    stride: f32,
    row_count: usize,
) -> Range<usize> {
    if !offset.is_finite()
        || !height.is_finite()
        || !stride.is_finite()
        || height <= 0.
        || stride <= 0.
    {
        return 0..0;
    }
    let top = (-offset).max(0.);
    let start = (top / stride).floor() as usize;
    let end = ((top + height) / stride).ceil() as usize;
    start.min(row_count)..end.saturating_add(1).min(row_count)
}
pub(crate) fn requests(
    items: &[Reference],
    rows: Range<usize>,
    cols: usize,
    target: Option<&Key>,
) -> Vec<Reference> {
    let start = rows.start.saturating_mul(cols).min(items.len());
    let end = rows.end.saturating_mul(cols).min(items.len()).max(start);
    let visible = &items[start..end];
    let mut result = Vec::with_capacity(REQUEST_CAP);
    if let Some(reference) = visible
        .iter()
        .find(|r| r.kind == "image" && target.is_some_and(|key| *key == Key::new(r)))
    {
        result.push(reference.clone());
    }
    for reference in visible.iter().filter(|r| r.kind == "image") {
        if result.len() == REQUEST_CAP {
            break;
        }
        if !result.iter().any(|r| Key::new(r) == Key::new(reference)) {
            result.push(reference.clone());
        }
    }
    result
}

pub(crate) struct Thumbnail {
    image: Arc<RenderImage>,
    bytes: usize,
    mime: &'static str,
    first_frame: bool,
}
impl Thumbnail {
    /// Borrow BGRA input: only the small output is copied, never a second full raster.
    pub(crate) fn from_raster(
        raster: &crate::artifact_image::Raster,
        stop: impl Fn() -> bool,
    ) -> Result<Self, &'static str> {
        if stop() {
            return Err("Thumbnail cancelled.");
        }
        crate::artifact_image::dimensions(raster.width, raster.height)?;
        let bytes = raster
            .image
            .as_bytes(0)
            .ok_or("Image pixels are unavailable.")?;
        if bytes.len() != raster.width as usize * raster.height as usize * 4 {
            return Err("Image pixel layout is invalid.");
        }
        let view = image::ImageBuffer::<image::Rgba<u8>, &[u8]>::from_raw(
            raster.width,
            raster.height,
            bytes,
        )
        .ok_or("Image pixel layout is invalid.")?;
        let output = if raster.width <= THUMB_WIDTH && raster.height <= THUMB_HEIGHT {
            image::ImageBuffer::from_raw(raster.width, raster.height, bytes.to_vec())
                .ok_or("Image pixel layout is invalid.")?
        } else {
            // Channel-independent resampling preserves the existing BGRA ordering.
            image::imageops::thumbnail(&view, THUMB_WIDTH, THUMB_HEIGHT)
        };
        if stop() {
            return Err("Thumbnail cancelled.");
        }
        let bytes = output.as_raw().len();
        if bytes > THUMB_BYTES {
            return Err("Thumbnail exceeds its pixel budget.");
        }
        Ok(Self {
            image: Arc::new(RenderImage::new(vec![image::Frame::new(output)])),
            bytes,
            mime: raster.mime,
            first_frame: raster.first_frame,
        })
    }
    pub(crate) fn image(&self) -> Arc<RenderImage> {
        self.image.clone()
    }
    pub(crate) fn bytes(&self) -> usize {
        self.bytes
    }
    pub(crate) fn format_label(&self) -> &'static str {
        if self.first_frame {
            return "GIF (first frame)";
        }
        match self.mime {
            "image/png" => "PNG",
            "image/jpeg" => "JPEG",
            _ => "Image",
        }
    }
}

/// The caller retires returned image handles through App::drop_image, outside render.
#[derive(Default)]
pub(crate) struct Cache {
    entries: VecDeque<(Key, Thumbnail)>,
    bytes: usize,
}
impl Cache {
    pub(crate) fn get(&self, key: &Key) -> Option<&Thumbnail> {
        self.entries
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, thumb)| thumb)
    }
    pub(crate) fn touch(&mut self, keys: &[Key]) {
        for key in keys {
            if let Some(ix) = self.entries.iter().position(|(k, _)| k == key) {
                let entry = self.entries.remove(ix).unwrap();
                self.entries.push_back(entry);
            }
        }
    }
    pub(crate) fn insert(&mut self, key: Key, thumbnail: Thumbnail) -> Vec<Arc<RenderImage>> {
        let cost = thumbnail.bytes();
        let mut retired = self.remove_where(|k| k == &key);
        while self.entries.len() >= CACHE_ENTRIES || self.bytes.saturating_add(cost) > CACHE_BYTES {
            let Some((_, old)) = self.entries.pop_front() else {
                break;
            };
            self.bytes -= old.bytes;
            retired.push(old.image);
        }
        self.bytes += cost;
        self.entries.push_back((key, thumbnail));
        retired
    }
    pub(crate) fn retain(&mut self, keys: &BTreeSet<Key>) -> Vec<Arc<RenderImage>> {
        self.remove_where(|k| !keys.contains(k))
    }
    pub(crate) fn clear(&mut self) -> Vec<Arc<RenderImage>> {
        self.remove_where(|_| true)
    }
    fn remove_where(&mut self, remove: impl Fn(&Key) -> bool) -> Vec<Arc<RenderImage>> {
        let mut retired = Vec::new();
        let mut kept = VecDeque::new();
        for (key, thumbnail) in self.entries.drain(..) {
            if remove(&key) {
                self.bytes -= thumbnail.bytes;
                retired.push(thumbnail.image);
            } else {
                kept.push_back((key, thumbnail));
            }
        }
        self.entries = kept;
        retired
    }
    #[cfg(any(test, feature = "native-probes"))]
    pub(crate) fn usage(&self) -> (usize, usize) {
        (self.entries.len(), self.bytes)
    }
}

#[cfg(test)]
#[path = "artifact_gallery_tests.rs"]
mod tests;
