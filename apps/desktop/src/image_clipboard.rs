//! Copy the upright, displayed first frame, not a path or a data URL.
use crate::artifact_image::Raster;
use gpui_kit::{ClipboardItem, Image, ImageFormat};
use std::io::Cursor;

pub(crate) fn png(raster: &Raster) -> Result<Vec<u8>, &'static str> {
    let mut pixels = raster
        .image
        .as_bytes(0)
        .ok_or("Image pixels unavailable.")?
        .to_vec();
    for pixel in pixels.as_chunks_mut::<4>().0 {
        pixel.swap(0, 2);
    }
    let rgba = image::RgbaImage::from_raw(raster.width, raster.height, pixels)
        .ok_or("Image pixels unavailable.")?;
    let mut output = Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(rgba)
        .write_to(&mut output, image::ImageFormat::Png)
        .map_err(|_| "Could not encode image.")?;
    Ok(output.into_inner())
}

pub(crate) fn item(raster: &Raster) -> Result<ClipboardItem, &'static str> {
    Ok(ClipboardItem::new_image(&Image::from_bytes(
        ImageFormat::Png,
        png(raster)?,
    )))
}
