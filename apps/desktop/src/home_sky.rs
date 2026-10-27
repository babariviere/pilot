//! Home's dithered sky, a port of the Swift app's DitherScene(.homeSky).
//! The bundled daytime clouds (evening seascape in dark appearance) are cropped
//! to the band, their lightness ordered-dithered in hard square cells, and the
//! band's foot dissolves cell by cell into the page. Pixels are produced off the
//! UI thread once per size/appearance and painted 1:1 in device pixels.
//! Images: Pexels License, see apps/macos/Sources/Pilot/Resources/HomeScenes-CREDITS.txt.
use gpui_kit::{App, Corners, IntoElement, RenderImage, Styled, Task, Window, canvas, px};
use std::{cell::RefCell, rc::Rc, sync::Arc, sync::OnceLock};

const DAY: &[u8] = include_bytes!("../../macos/Sources/Pilot/Resources/HomeSky.png");
const NIGHT: &[u8] = include_bytes!("../../macos/Sources/Pilot/Resources/HomeSkyNight.png");
/// Band height in points; Home's title sits in its dissolving foot.
pub(crate) const HEIGHT: f32 = 220.;
const CELL: f32 = 2.5;
const FADE: f64 = 0.45;
const LEVELS: f64 = 10.;
const BAYER: [u8; 64] = [
    0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60,
    28, 52, 20, 62, 30, 54, 22, 3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15,
    47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21,
];

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
struct Key {
    width: u32,
    height: u32,
    cell: u32,
    dark: bool,
}

/// The last rendered band, plus the one request in flight.
#[derive(Default)]
pub(crate) struct Sky {
    shown: Option<(Key, Arc<RenderImage>)>,
    pending: Option<Key>,
    task: Option<Task<()>>,
}

pub(crate) fn element(state: Rc<RefCell<Sky>>, dark: bool) -> impl IntoElement {
    canvas(
        |_, _, _| (),
        move |bounds, (), window: &mut Window, cx: &mut App| {
            let scale = window.scale_factor();
            let key = Key {
                width: (f32::from(bounds.size.width) * scale).round() as u32,
                height: (f32::from(bounds.size.height) * scale).round() as u32,
                cell: (CELL * scale).round().max(1.) as u32,
                dark,
            };
            if key.width == 0 || key.height == 0 || key.width > 8192 {
                return;
            }
            let mut sky = state.borrow_mut();
            // While a new size renders, keep the previous band of the same appearance.
            if let Some((shown, image)) = &sky.shown
                && shown.dark == dark
            {
                let _ =
                    window.paint_image(bounds, bounds, Corners::default(), image.clone(), 0, false);
                if *shown == key {
                    return;
                }
            }
            if sky.pending == Some(key) {
                return;
            }
            sky.pending = Some(key);
            let state = state.clone();
            sky.task = Some(window.spawn(cx, async move |cx| {
                let image = cx
                    .background_executor()
                    .spawn(async move { render(key) })
                    .await;
                let _ = cx.update(|window, cx| {
                    let mut sky = state.borrow_mut();
                    if sky.pending != Some(key) {
                        return;
                    }
                    sky.pending = None;
                    let old = sky.shown.take().map(|(_, image)| image);
                    sky.shown = Some((key, image));
                    drop(sky);
                    if let Some(old) = old {
                        cx.drop_image(old, Some(window));
                    }
                    window.refresh();
                });
            }));
        },
    )
    .w_full()
    .h(px(HEIGHT))
}

fn source(dark: bool) -> &'static image::RgbaImage {
    static SOURCES: OnceLock<[image::RgbaImage; 2]> = OnceLock::new();
    let [day, night] = SOURCES.get_or_init(|| {
        let decode = |bytes| {
            image::load_from_memory_with_format(bytes, image::ImageFormat::Png)
                .map(|i| i.into_rgba8())
                .unwrap_or_else(|_| image::RgbaImage::new(1, 1))
        };
        [decode(DAY), decode(NIGHT)]
    });
    if dark { night } else { day }
}

/// Device-pixel BGRA, straight alpha (each cell either shown or dissolved).
fn render(key: Key) -> Arc<RenderImage> {
    let cols = key.width.div_ceil(key.cell);
    let rows = key.height.div_ceil(key.cell);
    let cells = cover(source(key.dark), cols, rows);
    let start = 1. - FADE;
    let mut out = image::RgbaImage::new(key.width, key.height);
    for y in 0..key.height {
        let cy = y / key.cell;
        let t = cy as f64 / (rows.max(2) - 1) as f64;
        for x in 0..key.width {
            let cx = x / key.cell;
            let threshold = (BAYER[((cy & 7) * 8 + (cx & 7)) as usize] as f64 + 0.5) / 64.;
            if t > start && threshold < (t - start) / FADE {
                continue;
            }
            let p = cells.get_pixel(cx, cy).0;
            let (r, g, b) = (p[0] as f64 / 255., p[1] as f64 / 255., p[2] as f64 / 255.);
            // Ordered dither of lightness in a few levels, keeping hue smooth.
            let lightness = (r + g + b) / 3.;
            let quantized = (lightness * LEVELS + threshold).floor() / LEVELS;
            let factor = if lightness > 0. {
                quantized / lightness
            } else {
                1.
            };
            let byte = |c: f64| ((c * factor).min(1.) * 255.) as u8;
            out.put_pixel(x, y, image::Rgba([byte(b), byte(g), byte(r), 255]));
        }
    }
    Arc::new(RenderImage::new(vec![image::Frame::new(out)]))
}

/// Scale to cover cols x rows and crop the centre, like Swift's aspect fill.
fn cover(src: &image::RgbaImage, cols: u32, rows: u32) -> image::RgbaImage {
    let (sw, sh) = (src.width().max(1) as f64, src.height().max(1) as f64);
    let scale = (cols as f64 / sw).max(rows as f64 / sh);
    let (w, h) = (
        ((sw * scale).ceil() as u32).max(cols),
        ((sh * scale).ceil() as u32).max(rows),
    );
    let resized = image::imageops::resize(src, w, h, image::imageops::FilterType::Triangle);
    image::imageops::crop_imm(&resized, (w - cols) / 2, (h - rows) / 2, cols, rows).to_image()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn band_fills_device_pixels_and_dissolves_only_at_its_foot() {
        for dark in [false, true] {
            let key = Key {
                width: 400,
                height: 220,
                cell: 5,
                dark,
            };
            let image = render(key);
            let size = image.size(0);
            assert_eq!((size.width.0, size.height.0), (400, 220));
            let bytes = image.as_bytes(0).unwrap();
            let alpha = |x: usize, y: usize| bytes[(y * 400 + x) * 4 + 3];
            assert!((0..400).all(|x| alpha(x, 0) == 255), "top row fully shown");
            assert!((0..400).any(|x| alpha(x, 219) == 0), "foot dissolves");
            // Hard cells: every pixel in a cell matches its first pixel.
            assert_eq!(&bytes[0..4], &bytes[4 * 4..4 * 4 + 4]);
        }
    }
}
