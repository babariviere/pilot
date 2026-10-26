//! Stored raster bytes only. No resource/URI loader, SVG or animation execution.
use base64::{Engine, engine::general_purpose::STANDARD};
use gpui_kit::RenderImage;
use image::{ImageDecoder, ImageFormat, ImageReader};
use sha2::{Digest, Sha256};
use std::{
    io::Cursor,
    sync::{Arc, LazyLock},
};

pub(crate) const ENCODED_CAP: usize = 16 * 1024 * 1024;
pub(crate) const SOURCE_CAP: usize = ENCODED_CAP.div_ceil(3) * 4 + 32;
// Canonical revision JSON includes both source and the derived image HTML.
pub(crate) const HTTP_CAP: usize = 44 * 1024 * 1024;
pub(crate) const PIXEL_CAP: u64 = 8 * 1024 * 1024;
pub(crate) const AXIS_CAP: u32 = 8192;
pub(crate) const BUFFER_CAP: u64 = 32 * 1024 * 1024;
// image::Limits::max_alloc is non-strict/advisory, not a process/RSS guarantee.
// The source, encoded input, dimensions and native RGBA admission are independent.
pub(crate) const ADVISORY_CODEC_LIMIT: u64 = 96 * 1024 * 1024;
static ADMISSION: LazyLock<Arc<tokio::sync::Semaphore>> =
    LazyLock::new(|| Arc::new(tokio::sync::Semaphore::new(1)));

/// One global decode/read lane. Async callers queue FIFO, never deny content.
/// Cancelled codecs retain admission until their bounded work finishes.
pub(crate) struct Permit {
    _permit: tokio::sync::OwnedSemaphorePermit,
}
impl Permit {
    pub(crate) fn acquire() -> Result<Self, &'static str> {
        ADMISSION
            .clone()
            .try_acquire_owned()
            .map(|_permit| Self { _permit })
            .map_err(|_| "Another preview is finishing. Retry this preview shortly.")
    }
    pub(crate) async fn queued() -> Self {
        Self {
            _permit: ADMISSION
                .clone()
                .acquire_owned()
                .await
                .expect("image admission stays open"),
        }
    }
}

#[derive(Clone)]
pub(crate) struct Raster {
    pub(crate) image: Arc<RenderImage>,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) mime: &'static str,
    pub(crate) encoded_bytes: usize,
    pub(crate) source_hash: String,
    pub(crate) first_frame: bool,
}
fn cancelled(stop: &impl Fn() -> bool) -> Result<(), &'static str> {
    if stop() {
        Err("Image read cancelled.")
    } else {
        Ok(())
    }
}
pub(crate) fn dimensions(width: u32, height: u32) -> Result<(), &'static str> {
    let pixels = u64::from(width)
        .checked_mul(u64::from(height))
        .ok_or("Image dimensions exceed the preview budget.")?;
    if width == 0 || height == 0 || width > AXIS_CAP || height > AXIS_CAP || pixels > PIXEL_CAP {
        return Err("Image exceeds 8192 pixels per axis or the 32 MiB decoded preview budget.");
    }
    Ok(())
}
fn signature(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(&[255, 216, 255]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else {
        None
    }
}
pub(crate) fn decode(source: &str, stop: impl Fn() -> bool) -> Result<Raster, &'static str> {
    cancelled(&stop)?;
    if source.len() > SOURCE_CAP {
        return Err("Image source exceeds the stored-image limit.");
    }
    let (prefix, text) = source
        .split_once(',')
        .ok_or("Preview requires an embedded PNG, JPEG or GIF data URL.")?;
    let (mime, format) = match prefix {
        "data:image/png;base64" => ("image/png", ImageFormat::Png),
        "data:image/jpeg;base64" => ("image/jpeg", ImageFormat::Jpeg),
        "data:image/gif;base64" => ("image/gif", ImageFormat::Gif),
        // image0.25.10's WebP adapter does not forward an allocation limit to
        // image-webp. EXIF/animation subframes can allocate outside canvas limits.
        "data:image/webp;base64" => {
            return Err(
                "WebP preview is unavailable here. Stored source is preserved; no animation is played.",
            );
        }
        _ => {
            return Err(
                "Preview accepts embedded PNG, JPEG or GIF. Other sources are preserved, not loaded.",
            );
        }
    };
    if text.is_empty() || !text.len().is_multiple_of(4) {
        return Err("Invalid canonical image base64.");
    }
    let padding = text
        .as_bytes()
        .iter()
        .rev()
        .take_while(|b| **b == b'=')
        .count();
    let length = text
        .len()
        .checked_div(4)
        .and_then(|n| n.checked_mul(3))
        .and_then(|n| n.checked_sub(padding))
        .ok_or("Invalid image byte length.")?;
    if length > ENCODED_CAP {
        return Err("Encoded image exceeds 16 MiB.");
    }
    let bytes = STANDARD
        .decode(text)
        .map_err(|_| "Invalid canonical image base64.")?;
    if bytes.len() != length || signature(&bytes) != Some(mime) {
        return Err("Image bytes do not match their declared format.");
    }
    cancelled(&stop)?;
    let mut reader = ImageReader::with_format(Cursor::new(&bytes), format);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(AXIS_CAP);
    limits.max_image_height = Some(AXIS_CAP);
    // GIF's first frame rectangle can exceed its logical canvas. Its adapter
    // explicitly reserves this independent scratch buffer against max_alloc.
    limits.max_alloc = Some(if format == ImageFormat::Gif {
        BUFFER_CAP
    } else {
        ADVISORY_CODEC_LIMIT
    });
    reader.limits(limits);
    let mut decoder = reader
        .into_decoder()
        .map_err(|_| "Image header is invalid or exceeds the decoder budget.")?;
    let (width, height) = decoder.dimensions();
    dimensions(width, height)?;
    if decoder.total_bytes() > BUFFER_CAP {
        return Err("Raw decoded image exceeds the 32 MiB preview-buffer limit.");
    }
    let orientation = decoder
        .orientation()
        .map_err(|_| "Image orientation metadata is invalid.")?;
    cancelled(&stop)?;
    // ImageDecoder reads one still/default frame, never collect_frames(). Limit
    // native RGBA to32MiB before any orientation conversion or renderer upload.
    let rgba = image::DynamicImage::from_decoder(decoder)
        .map_err(|error| match error {
            image::ImageError::Limits(_) => "Image codec or frame allocation limit exceeded.",
            _ => "Image is malformed, truncated or exceeds the decoder budget.",
        })?
        .into_rgba8();
    cancelled(&stop)?;
    let mut upright = image::DynamicImage::ImageRgba8(rgba);
    upright.apply_orientation(orientation);
    let mut rgba = upright.into_rgba8();
    let (width, height) = rgba.dimensions();
    dimensions(width, height)?;
    // GPUI RenderImage requires BGRA, not the codec's RGBA. This stays off-UI.
    for chunk in rgba.as_flat_samples_mut().samples.chunks_mut(256 * 1024) {
        cancelled(&stop)?;
        for p in chunk.as_chunks_mut::<4>().0 {
            p.swap(0, 2);
        }
    }
    let source_hash = format!("{:x}", Sha256::digest(source.as_bytes()));
    cancelled(&stop)?;
    Ok(Raster {
        image: Arc::new(RenderImage::new(vec![image::Frame::new(rgba)])),
        width,
        height,
        mime,
        encoded_bytes: bytes.len(),
        source_hash,
        first_frame: format == ImageFormat::Gif,
    })
}

#[cfg(test)]
#[path = "artifact_image_tests.rs"]
mod tests;
