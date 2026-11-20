//! Local export of an already displayed saved copy. Only the trusted app
//! registry exposes this class; captured previews have no such registry.
use base64::{Engine, engine::general_purpose::STANDARD};
use nsh_core::{element::pick_save_path, file_dialog::SaveDialog, prelude::*};
use serde_json::Value;
use std::{fs, io::Write, path::Path};

// Match the saved reader's 1 MiB container ceiling, before decoding any raster.
const MAX_IMAGE_SOURCE: usize = 1024 * 1024;
// Keep a decoded raster at most 64 MiB RGBA, with neither side above 8192 pixels.
const MAX_IMAGE_SIDE: i64 = 8192;
const MAX_IMAGE_PIXELS: i64 = 16 * 1024 * 1024;

/// Validates inline raster bytes before native decoding or export.
pub(crate) fn image(source: &str) -> Result<Vec<u8>, String> {
    if source.len() > MAX_IMAGE_SOURCE {
        return Err("oversized image".into());
    }
    let (header, data) = source.split_once(",").ok_or("invalid image")?;
    let mime = match header {
        "data:image/png;base64" => "image/png",
        "data:image/jpeg;base64" => "image/jpeg",
        "data:image/gif;base64" => "image/gif",
        "data:image/webp;base64" => "image/webp",
        _ => return Err("unsupported image".into()),
    };
    let bytes = STANDARD.decode(data).map_err(|_| "invalid image")?;
    let size = nsh_core::picker::image_size(&bytes).ok_or("invalid image size")?;
    let (w, h) = (i64::from(size.width.0), i64::from(size.height.0));
    if STANDARD.encode(&bytes) != data
        || nsh_core::picker::sniff(&bytes) != Some(mime)
        || w <= 0
        || h <= 0
    {
        return Err("invalid image".into());
    }
    if w > MAX_IMAGE_SIDE || h > MAX_IMAGE_SIDE || w * h > MAX_IMAGE_PIXELS {
        return Err("oversized image".into());
    }
    Ok(bytes)
}

fn prepared(snapshot: &str) -> Result<(String, Vec<u8>), String> {
    // A saved container plus the display envelope, without arbitrary JSON hydration.
    if snapshot.len() > 2 * 1024 * 1024 {
        return Err("saved copy is too large".into());
    }
    let v: Value = serde_json::from_str(snapshot).map_err(|_| "invalid saved copy")?;
    let revision = v["reference"]["revision"]
        .as_u64()
        .filter(|n| *n > 0)
        .ok_or("no version")?;
    let title = v["metadata"]["title"]
        .as_str()
        .filter(|s| s.len() <= 640) // 160 Unicode characters, at most four UTF-8 bytes each.
        .ok_or("no title")?;
    let kind = v["metadata"]["kind"].as_str().ok_or("no kind")?;
    if !crate::host::delivery_artifact::kind_ok(kind) {
        return Err("unsupported saved kind".into());
    }
    if v["version"] != 1 || v["rendering"] != "unsupported" {
        return Err("unsupported saved copy".into());
    }
    let content = crate::host::delivery_artifact::content(&v["content"], kind)
        .map_err(|_| "unsupported saved content")?;
    let source = content["source"]
        .as_str()
        .ok_or("saved content is unavailable")?;
    let (extension, bytes) = if kind == "image" {
        let bytes = image(source)?;
        let extension = match nsh_core::picker::sniff(&bytes) {
            Some("image/png") => "png",
            Some("image/jpeg") => "jpg",
            Some("image/gif") => "gif",
            Some("image/webp") => "webp",
            _ => return Err("unsupported image".into()),
        };
        (extension, bytes)
    } else {
        ("tsx", source.as_bytes().to_vec())
    };
    let stem: String = title
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .take(100)
        .collect();
    let stem = if stem.is_empty() { "Artifact" } else { &stem };
    Ok((format!("{stem}-v{revision}.{extension}"), bytes))
}

fn save(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::os::unix::fs::OpenOptionsExt;
    let parent = path
        .parent()
        .ok_or_else(|| std::io::Error::other("no parent"))?;
    let temp = parent.join(format!(".artifact-export-{}", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&temp, path)?;
        fs::File::open(parent)?.sync_all()
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

/// Exports a displayed snapshot through the system's Save dialog, without a TSX path grant.
#[class]
pub struct ArtifactExport;

#[class]
impl ArtifactExport {
    /// Creates a local exporter with no daemon access.
    pub fn new() -> Self {
        Self
    }

    /// Asks for a destination and writes the displayed exact bytes off the UI thread.
    pub async fn save(this: Instance<Self>, snapshot: String) -> String {
        let _ = this;
        let (name, bytes) = match prepared(&snapshot) {
            Ok(value) => value,
            Err(_) => return "This saved content cannot be exported.".into(),
        };
        let path =
            match pick_save_path(SaveDialog::new().file_name(&name).button_label("Export")).await {
                Ok(Some(path)) => path,
                Ok(None) => return "Export canceled.".into(),
                Err(_) => return "The Save dialog could not open. Nothing was exported.".into(),
            };
        let (tx, rx) = async_channel::bounded(1);
        if std::thread::Builder::new()
            .name("artifact-export".into())
            .spawn(move || {
                let result = save(&path, &bytes);
                let _ = tx.send_blocking(result.is_ok());
            })
            .is_err()
        {
            return "Export could not start.".into();
        }
        if rx.recv().await == Ok(true) {
            format!("Exported {name}.")
        } else {
            "Export did not finish. Check the destination before trying again.".into()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn export_keeps_exact_nsh_source_and_version_and_refuses_retired_formats() {
        let source = "export default () => null; // é\r\n";
        let mut v = json!({"version":1,"reference":{"revision":3},"metadata":{"title":"Before / after","kind":"nsh"},
            "rendering":"unsupported","content":{"state":"text","source":source,
            "containerSha256":"a".repeat(64),"containerBytes":100}});
        let (name, bytes) = prepared(&v.to_string()).unwrap();
        assert_eq!(name, "Before___after-v3.tsx");
        assert_eq!(bytes, source.as_bytes());
        for kind in ["html", "react", "swiftui", "shader", "visual"] {
            v["metadata"]["kind"] = json!(kind);
            assert!(prepared(&v.to_string()).is_err(), "{kind}");
        }
    }

    #[test]
    fn image_rejects_paths_urls_svg_and_mismatched_bytes() {
        for value in [
            "file:///private/image.png",
            "https://a/image.png",
            "data:image/svg+xml;base64,AAAA",
            "data:image/png;base64,AAAA",
        ] {
            assert!(image(value).is_err(), "{value}");
        }
    }

    #[test]
    fn png_export_keeps_decoded_bytes_title_and_version() {
        let data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAEElEQVR4AQEFAPr/AP8AAP8FAAH/+lyI0QAAAABJRU5ErkJggg==";
        let v = json!({"version":1,"reference":{"revision":4},"metadata":{"title":"Screenshot","kind":"image"},
            "rendering":"unsupported","content":{"state":"image","source":format!("data:image/png;base64,{data}"),
            "containerSha256":"a".repeat(64),"containerBytes":300}});
        let (name, bytes) = prepared(&v.to_string()).unwrap();
        assert_eq!(name, "Screenshot-v4.png");
        assert_eq!(bytes, STANDARD.decode(data).unwrap());
    }
}
