//! Presentation-only image seam. The shipping decoder, admission and PNG encoder
//! remain authoritative. No source loader or second image cache.
use super::{Adapter, Location, ReaderKey};
use crate::conversation_images::Source;
use base64::{Engine, engine::general_purpose::STANDARD};
use std::sync::{
    Arc, LazyLock,
    atomic::{AtomicBool, Ordering},
    mpsc,
};

#[derive(Clone, PartialEq, Eq)]
pub struct InlineImage {
    pub reader: Option<ReaderKey>,
    source: Arc<Source>,
}
impl std::fmt::Debug for InlineImage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("InlineImage")
            .field("identity", &self.identity())
            .finish()
    }
}
impl InlineImage {
    pub(super) fn new(row: &crate::model::Message, source: Arc<Source>) -> Self {
        Self {
            reader: row.reader_key().map(ReaderKey),
            source,
        }
    }
    pub fn identity(&self) -> String {
        let owner = self
            .source
            .owner
            .as_ref()
            .map(|(h, c)| {
                format!(
                    "Local · host {} · daemon {} · lineage {} · chat {}",
                    h.host_id, h.daemon_id, h.lineage_id, c
                )
            })
            .unwrap_or_else(|| "Unqualified source".into());
        format!(
            "{} · {:?} · block {} · {} · source {}",
            owner,
            self.reader,
            self.source.block,
            self.source.mime,
            self.source.hash.as_deref().unwrap_or("unavailable")
        )
    }
    pub fn size(&self) -> Option<(u32, u32)> {
        self.source.size
    }
    pub fn block(&self) -> usize {
        self.source.block
    }
    pub fn problem(&self) -> Option<&'static str> {
        self.source.problem.or_else(|| {
            (self.source.owner.is_none() || self.reader.is_none())
                .then_some("Source identity unavailable. No preview loaded.")
        })
    }
    pub fn first_frame(&self) -> bool {
        self.source.mime == "image/gif"
    }
    /// Returns only a validated upright still PNG. Original bytes stay unchanged.
    /// One worker queues behind the shared production permit, never on the UI.
    pub async fn preview(&self, stop: Arc<AtomicBool>) -> Result<ImagePreview, &'static str> {
        if stop.load(Ordering::Acquire) {
            return Err("Image read cancelled.");
        }
        if let Some(error) = self.problem() {
            return Err(error);
        }
        let (reply, receive) = tokio::sync::oneshot::channel();
        WORKER
            .send(Job {
                image: self.clone(),
                stop,
                reply,
            })
            .map_err(|_| "Image worker unavailable.")?;
        receive.await.map_err(|_| "Image worker unavailable.")?
    }
}

/// One prepared display/copy payload, not another raster cache. NSH accepts
/// encoded images, not raw RGBA; its native ImageIO display upload is off-thread.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImagePreview {
    pub png: Arc<Vec<u8>>,
    pub uri: Arc<String>,
    pub original: Arc<String>,
    pub width: u32,
    pub height: u32,
    pub first_frame: bool,
}
struct Job {
    image: InlineImage,
    stop: Arc<AtomicBool>,
    reply: tokio::sync::oneshot::Sender<Result<ImagePreview, &'static str>>,
}
static WORKER: LazyLock<mpsc::Sender<Job>> = LazyLock::new(|| {
    let (send, jobs) = mpsc::channel::<Job>();
    std::thread::Builder::new()
        .name("nsh-images".into())
        .spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .build()
                .expect("image admission runtime");
            for job in jobs {
                let stopped = || job.stop.load(Ordering::Acquire) || job.reply.is_closed();
                if stopped() {
                    continue;
                }
                let permit = runtime.block_on(crate::artifact_image::Permit::queued());
                let result = (|| {
                    let raster = job.image.source.decode(stopped)?;
                    let png = crate::image_clipboard::png(&raster)?;
                    if stopped() {
                        return Err("Image read cancelled.");
                    }
                    Ok(ImagePreview {
                        uri: Arc::new(format!("data:image/png;base64,{}", STANDARD.encode(&png))),
                        original: Arc::new(format!(
                            "data:{};base64,{}",
                            job.image.source.mime,
                            job.image
                                .source
                                .data
                                .as_ref()
                                .ok_or("No supported inline image source.")?
                        )),
                        png: Arc::new(png),
                        width: raster.width,
                        height: raster.height,
                        first_frame: raster.first_frame,
                    })
                })();
                drop(permit);
                let _ = job.reply.send(result);
            }
        })
        .expect("image worker");
    send
});
impl Adapter {
    /// Fence both completion and actions against the current exact stored row.
    pub fn image_current(&self, location: &Location, image: &InlineImage) -> bool {
        self.current(location)
            && self.read.generation == self.generation
            && self.read.rows.iter().any(|row| {
                row.reader_key().map(ReaderKey) == image.reader
                    && row.image_data() == Some(&image.source)
            })
    }
}

#[cfg(feature = "native-probes")]
pub fn synthetic_images() -> Vec<serde_json::Value> {
    use image::{ImageEncoder, ImageFormat, Rgb, RgbImage, Rgba, RgbaImage};
    use std::io::Cursor;
    let mut result = Vec::new();
    let mut add = |mime: &str, bytes: Vec<u8>| {
        result
            .push(serde_json::json!({"type":"image","mimeType":mime,"data":STANDARD.encode(bytes)}))
    };
    for (w, h) in [(400, 600), (960, 480)] {
        let rgb = RgbImage::from_fn(w, h, |x, y| {
            Rgb([
                if x < w / 2 { 40 } else { 210 },
                if y < h / 2 { 120 } else { 220 },
                180,
            ])
        });
        let mut bytes = Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(rgb)
            .write_to(&mut bytes, ImageFormat::Png)
            .unwrap();
        add("image/png", bytes.into_inner());
    }
    let mut bytes = Vec::new();
    let mut jpeg = image::codecs::jpeg::JpegEncoder::new(&mut bytes);
    jpeg.set_exif_metadata(
        b"MM\0\x2a\0\0\0\x08\0\x01\x01\x12\0\x03\0\0\0\x01\0\x06\0\0\0\0\0\0".to_vec(),
    )
    .unwrap();
    jpeg.encode_image(&RgbImage::from_fn(600, 300, |x, y| {
        Rgb([
            if x < 300 { 240 } else { 40 },
            if y < 150 { 90 } else { 200 },
            60,
        ])
    }))
    .unwrap();
    add("image/jpeg", bytes);
    let mut bytes = Vec::new();
    {
        let mut gif = image::codecs::gif::GifEncoder::new(&mut bytes);
        gif.encode_frames([
            image::Frame::new(RgbaImage::from_pixel(960, 480, Rgba([40, 120, 200, 255]))),
            image::Frame::new(RgbaImage::from_pixel(960, 480, Rgba([200, 80, 40, 255]))),
        ])
        .unwrap();
    }
    add("image/gif", bytes);
    result
}

#[cfg(feature = "native-probes")]
pub struct ImageAdmission {
    _permit: crate::artifact_image::Permit,
}
#[cfg(feature = "native-probes")]
pub fn hold_image_previews() -> Result<ImageAdmission, &'static str> {
    crate::artifact_image::Permit::acquire().map(|permit| ImageAdmission { _permit: permit })
}
