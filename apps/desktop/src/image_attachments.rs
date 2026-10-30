//! Local immutable PNGs, matching Swift's read-tool attachment message contract.
//! Files outlive draft removal: queued/Unknown messages may still reference them.
use base64::{Engine, engine::general_purpose::STANDARD};
use gpui_kit::{ClipboardEntry, ClipboardItem};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{Read, Write},
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Attachment {
    pub(crate) id: String,
    pub(crate) path: PathBuf,
    pub(crate) hash: String,
}
impl Attachment {
    pub(crate) fn validate(&self) -> bool {
        uuid::Uuid::parse_str(&self.id).is_ok()
            && self.path.is_absolute()
            && self.path.file_name().and_then(|s| s.to_str())
                == Some(format!("{}.png", self.id).as_str())
            && self
                .path
                .to_str()
                .is_some_and(|s| s.len() <= 4096 && !s.contains(['`', '\n', '\r']))
            && self.hash.len() == 64
            && self.hash.bytes().all(|b| b.is_ascii_hexdigit())
    }
    pub(crate) fn preview(&self) -> Result<crate::artifact_image::Raster, &'static str> {
        let bytes = read(&self.path)?;
        if crate::delivery_store::hash_bytes(&bytes) != self.hash {
            return Err("Attached image changed on disk.");
        }
        let mut raster = decode(&bytes)?;
        // Retain only thumbnail pixels in the composer, not one full raster per tile.
        let pixels = raster
            .image
            .as_bytes(0)
            .ok_or("Image pixels unavailable.")?
            .to_vec();
        let bgra = image::RgbaImage::from_raw(raster.width, raster.height, pixels)
            .ok_or("Image pixels unavailable.")?;
        let thumbnail = image::DynamicImage::ImageRgba8(bgra)
            .thumbnail(raster.width.min(192), raster.height.min(144))
            .into_rgba8();
        (raster.width, raster.height) = thumbnail.dimensions();
        raster.image = std::sync::Arc::new(gpui_kit::RenderImage::new(vec![image::Frame::new(
            thumbnail,
        )]));
        Ok(raster)
    }
}

pub(crate) enum Incoming {
    Bytes(Vec<u8>),
    File(PathBuf),
}
pub(crate) fn clipboard(item: ClipboardItem) -> Option<Vec<Incoming>> {
    let paths: Vec<_> = item
        .entries()
        .iter()
        .filter_map(|e| match e {
            ClipboardEntry::ExternalPaths(p) => Some(p.paths()),
            _ => None,
        })
        .flatten()
        .collect();
    if !paths.is_empty() {
        // Mixed file selections remain ordinary text, just like Swift.
        return paths
            .iter()
            .all(|p| supported_path(p))
            .then(|| paths.into_iter().cloned().map(Incoming::File).collect());
    }
    let images: Vec<_> = item
        .into_entries()
        .filter_map(|e| match e {
            ClipboardEntry::Image(i) => Some(Incoming::Bytes(i.bytes)),
            _ => None,
        })
        .collect();
    (!images.is_empty()).then_some(images)
}
pub(crate) fn supported_path(path: &Path) -> bool {
    path.extension().and_then(|s| s.to_str()).is_some_and(|s| {
        matches!(
            s.to_ascii_lowercase().as_str(),
            "png" | "jpg" | "jpeg" | "gif" | "tif" | "tiff"
        )
    })
}
fn read(path: &Path) -> Result<Vec<u8>, &'static str> {
    let mut bytes = Vec::new();
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK)
        .open(path)
        .map_err(|_| "Could not read attached image.")?;
    if !file
        .metadata()
        .map_err(|_| "Could not inspect attached image.")?
        .is_file()
    {
        return Err("Attach a regular image file.");
    }
    file.take(crate::artifact_image::ENCODED_CAP as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Could not read attached image.")?;
    if bytes.len() > crate::artifact_image::ENCODED_CAP {
        return Err("Attached image exceeds 16 MiB.");
    }
    Ok(bytes)
}
fn decode(bytes: &[u8]) -> Result<crate::artifact_image::Raster, &'static str> {
    if bytes.len() > crate::artifact_image::ENCODED_CAP {
        return Err("Attached image exceeds 16 MiB.");
    }
    if bytes.starts_with(b"II\x2a\x00") || bytes.starts_with(b"MM\x00\x2a") {
        return crate::artifact_image::decode_bytes(
            bytes,
            "image/tiff",
            image::ImageFormat::Tiff,
            crate::delivery_store::hash_bytes(bytes),
            || false,
        );
    }
    let mime =
        crate::artifact_image::signature(bytes).ok_or("Attach a PNG, JPEG, GIF or TIFF image.")?;
    crate::artifact_image::decode(
        &format!("data:{mime};base64,{}", STANDARD.encode(bytes)),
        || false,
    )
}
pub(crate) fn save(root: &Path, incoming: Vec<Incoming>) -> Result<Vec<Attachment>, &'static str> {
    let directory = root.join("attachments");
    fs::create_dir_all(&directory).map_err(|_| "Could not create attachment storage.")?;
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
        .map_err(|_| "Could not protect attachment storage.")?;
    let mut saved = Vec::new();
    for input in incoming {
        let bytes = match input {
            Incoming::Bytes(bytes) => bytes,
            Incoming::File(path) => read(&path)?,
        };
        let raster = decode(&bytes)?;
        let png = crate::image_clipboard::png(&raster)?;
        if png.len() > crate::artifact_image::ENCODED_CAP {
            return Err("Normalized image exceeds 16 MiB.");
        }
        let id = uuid::Uuid::new_v4().to_string();
        let path = directory.join(format!("{id}.png"));
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)
            .map_err(|_| "Could not save attached image.")?;
        file.write_all(&png)
            .and_then(|_| file.sync_all())
            .map_err(|_| "Could not save attached image.")?;
        fs::File::open(&directory)
            .and_then(|f| f.sync_all())
            .map_err(|_| "Could not retain attached image.")?;
        saved.push(Attachment {
            id,
            path,
            hash: crate::delivery_store::hash_bytes(&png),
        });
    }
    Ok(saved)
}
pub(crate) fn message(text: &str, images: &[Attachment]) -> String {
    if images.is_empty() {
        return text.to_owned();
    }
    let paths = images
        .iter()
        .map(|i| format!("- `{}`", i.path.display()))
        .collect::<Vec<_>>()
        .join("\n");
    let instruction = format!("Attached images (use the read tool to view these files):\n{paths}");
    if text.trim().is_empty() {
        instruction
    } else {
        format!("{}\n\n{instruction}", text.trim())
    }
}

#[cfg(test)]
#[path = "image_attachments_tests.rs"]
mod tests;
