use super::*;
use crate::delivery_store::{Draft, Store};
use gpui_kit::{ClipboardEntry, Image, ImageFormat};
use std::io::Cursor;

pub(super) fn image(format: image::ImageFormat) -> Vec<u8> {
    let pixels = image::RgbaImage::from_fn(48, 32, |x, y| {
        image::Rgba([x as u8 * 4, y as u8 * 6, 219, 255])
    });
    let mut bytes = Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(pixels)
        .write_to(&mut bytes, format)
        .unwrap();
    bytes.into_inner()
}
#[test]
fn copied_payload_is_upright_png_pixels_not_text() {
    let raster = decode(&image(image::ImageFormat::Png)).unwrap();
    let item = crate::image_clipboard::item(&raster).unwrap();
    assert!(item.text().is_none());
    let [ClipboardEntry::Image(copied)] = item.entries() else {
        panic!("native image entry");
    };
    assert_eq!(copied.format(), ImageFormat::Png);
    let decoded = image::load_from_memory(copied.bytes())
        .unwrap()
        .into_rgba8();
    assert_eq!(decoded.dimensions(), (48, 32));
    assert_eq!(decoded.get_pixel(10, 11).0, [40, 66, 219, 255]);
}
#[test]
fn copied_payload_uses_display_orientation_not_jpeg_metadata() {
    let mut bytes = Vec::new();
    let mut jpeg = image::codecs::jpeg::JpegEncoder::new(&mut bytes);
    image::ImageEncoder::set_exif_metadata(
        &mut jpeg,
        b"MM\0\x2a\0\0\0\x08\0\x01\x01\x12\0\x03\0\0\0\x01\0\x06\0\0\0\0\0\0".to_vec(),
    )
    .unwrap();
    jpeg.encode_image(&image::RgbImage::from_pixel(
        40,
        20,
        image::Rgb([20, 90, 200]),
    ))
    .unwrap();
    let raster = decode(&bytes).unwrap();
    assert_eq!((raster.width, raster.height), (20, 40));
    let item = crate::image_clipboard::item(&raster).unwrap();
    let [ClipboardEntry::Image(copied)] = item.entries() else {
        panic!("image entry");
    };
    let decoded = image::load_from_memory(copied.bytes())
        .unwrap()
        .into_rgba8();
    assert_eq!(decoded.dimensions(), (20, 40));
    let displayed = raster.image.as_bytes(0).unwrap();
    assert_eq!(
        decoded.get_pixel(0, 0).0,
        [displayed[2], displayed[1], displayed[0], displayed[3]]
    );
}
#[test]
fn tiff_clipboard_import_normalizes_to_png() {
    let root = std::env::temp_dir().join(format!("image-import-{}", uuid::Uuid::new_v4()));
    let item = ClipboardItem::new_image(&Image::from_bytes(
        ImageFormat::Tiff,
        image(image::ImageFormat::Tiff),
    ));
    let images = save(&root, clipboard(item).unwrap()).unwrap();
    assert_eq!(images.len(), 1);
    assert!(images[0].validate());
    assert!(
        fs::read(&images[0].path)
            .unwrap()
            .starts_with(b"\x89PNG\r\n\x1a\n")
    );
    assert_eq!(images[0].preview().unwrap().width, 48);
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn invalid_and_oversized_inputs_do_not_decode() {
    assert!(decode(b"not an image").is_err());
    assert!(decode(&vec![0; crate::artifact_image::ENCODED_CAP + 1]).is_err());
    assert!(clipboard(ClipboardItem::new_string("ordinary text".into())).is_none());
}

#[test]
fn coordinator_storage_is_exact_uuid_png_not_private_or_arbitrary_paths() {
    let root = std::env::temp_dir().join(format!("pasted-image-{}", uuid::Uuid::new_v4()));
    let directory = root.join("Library/Application Support/Pilot/Attachments");
    let images = save_to(
        &directory,
        vec![Incoming::Bytes(image(image::ImageFormat::Png))],
    )
    .unwrap();
    assert!(coordinator_readable(&images, &directory));
    assert_eq!(images[0].preview().unwrap().width, 48);
    assert!(!coordinator_readable(&images, &root.join("attachments")));
    for path in [
        directory.join("bad.png"),
        directory
            .join("nested")
            .join(format!("{}.png", images[0].id)),
        directory
            .join("nested/..")
            .join(format!("{}.png", images[0].id)),
        directory.join(format!("{}.jpg", images[0].id)),
    ] {
        let mut malformed = images[0].clone();
        malformed.path = path;
        assert!(!coordinator_readable(&[malformed], &directory));
    }
    let mut store = Store::open(
        root.join("drafts"),
        crate::LocalOptions::synthetic(1).host(),
    )
    .unwrap();
    store
        .save_edits(std::collections::BTreeMap::from([(
            "chat:coordinator".into(),
            Draft {
                revision: 1,
                text: "Review this image".into(),
                attachments: images.clone(),
                ..Default::default()
            },
        )]))
        .unwrap();
    drop(store);
    let store = Store::open(
        root.join("drafts"),
        crate::LocalOptions::synthetic(1).host(),
    )
    .unwrap();
    assert_eq!(store.book.drafts["chat:coordinator"].attachments, images);
    assert!(
        store.book.drafts["chat:coordinator"].attachments[0]
            .preview()
            .is_ok()
    );
    drop(store);
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn attachments_are_exact_durable_draft_content_and_unknown_is_not_replayed() {
    let root = std::env::temp_dir().join(format!("image-delivery-{}", uuid::Uuid::new_v4()));
    let mut store = Store::open(root.clone(), crate::LocalOptions::synthetic(1).host()).unwrap();
    let images = save(&root, vec![Incoming::Bytes(image(image::ImageFormat::Png))]).unwrap();
    let draft = Draft {
        revision: 1,
        attachments: images.clone(),
        ..Default::default()
    };
    store
        .save_edits(std::collections::BTreeMap::from([(
            "chat:a".into(),
            draft.clone(),
        )]))
        .unwrap();
    // An attachment-only draft must not be auto-retired.
    store.retire_empty("chat:a", 1).unwrap();
    assert_eq!(store.book.drafts["chat:a"].attachments, images);
    let intent = store.prepare("chat:a", &draft, false, false).unwrap();
    let payload: serde_json::Value =
        serde_json::from_str(&intent.operation.as_ref().unwrap().payload).unwrap();
    assert_eq!(payload["message"], message("", &images));
    drop(store);
    let mut store = Store::open(root.clone(), crate::LocalOptions::synthetic(1).host()).unwrap();
    assert_eq!(store.book.pending.len(), 1);
    assert_eq!(store.book.pending[&intent.id].state, "unknown");
    assert_eq!(store.book.drafts["chat:a"].attachments, images);
    assert_eq!(
        store.prepare("chat:a", &draft, false, false).unwrap().id,
        intent.id
    );
    store.finish(&intent.id, "accepted", None).unwrap();
    assert!(store.book.drafts["chat:a"].attachments.is_empty());
    assert!(
        images[0].path.exists(),
        "history retains its exact file after ACK"
    );
    drop(store);
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn modified_attachment_is_not_silently_previewed() {
    let root = std::env::temp_dir().join(format!("image-identity-{}", uuid::Uuid::new_v4()));
    let images = save(&root, vec![Incoming::Bytes(image(image::ImageFormat::Png))]).unwrap();
    fs::write(&images[0].path, b"replacement").unwrap();
    assert!(images[0].preview().is_err());
    fs::remove_dir_all(root).unwrap();
}
