use super::*;
#[test]
fn raw_sixteen_bit_output_is_bounded_before_pixel_allocation() {
    let raw = source(ImageFormat::Png);
    let mut bytes = STANDARD.decode(raw.split_once(',').unwrap().1).unwrap();
    bytes[16..20].copy_from_slice(&4096u32.to_be_bytes());
    bytes[20..24].copy_from_slice(&2048u32.to_be_bytes());
    bytes[24] = 16;
    fix_ihdr_crc(&mut bytes);
    assert!(
        decode(
            &format!("data:image/png;base64,{}", STANDARD.encode(bytes)),
            || false
        )
        .err()
        .unwrap()
        .contains("Raw decoded image exceeds the 32 MiB")
    );
}
#[test]
fn gif_independent_frame_scratch_is_bounded_not_just_its_canvas() {
    // A2x2 logical canvas with a4096x4096 frame requires64MiB independent
    // scratch. Admission must fail before allocating it or reading its pixels.
    let bytes=b"GIF89a\x02\0\x02\0\x80\0\0\0\0\0\xff\xff\xff\x2c\0\0\0\0\0\x10\0\x10\0\x02\x02\x44\x01\0\x3b";
    assert_eq!(
        decode(
            &format!("data:image/gif;base64,{}", STANDARD.encode(bytes)),
            || false
        )
        .err()
        .unwrap(),
        "Image codec or frame allocation limit exceeded."
    );
}
#[test]
fn jpeg_announced_extended_xmp_length_is_not_an_allocation_authority() {
    let raw = source(ImageFormat::Jpeg);
    let bytes = STANDARD.decode(raw.split_once(',').unwrap().1).unwrap();
    let mut payload = b"http://ns.adobe.com/xmp/extension/\0".to_vec();
    payload.extend_from_slice(&[b'A'; 32]);
    payload.extend_from_slice(&u32::MAX.to_be_bytes());
    payload.extend_from_slice(&0u32.to_be_bytes());
    payload.push(b'x');
    let mut input = bytes[..2].to_vec();
    input.extend_from_slice(&[0xff, 0xe1]);
    input.extend_from_slice(&u16::try_from(payload.len() + 2).unwrap().to_be_bytes());
    input.extend_from_slice(&payload);
    input.extend_from_slice(&bytes[2..]);
    let raster = decode(
        &format!("data:image/jpeg;base64,{}", STANDARD.encode(input)),
        || false,
    )
    .unwrap();
    assert_eq!((raster.width, raster.height), (3, 2));
}
fn fix_ihdr_crc(bytes: &mut [u8]) {
    let mut crc = !0u32;
    for b in &bytes[12..29] {
        crc ^= u32::from(*b);
        for _ in 0..8 {
            crc = if crc & 1 != 0 {
                (crc >> 1) ^ 0xedb88320
            } else {
                crc >> 1
            };
        }
    }
    bytes[29..33].copy_from_slice(&(!crc).to_be_bytes());
}
#[test]
fn artifact_image_rejects_pixel_bomb_before_decoding_image_data() {
    let raw = source(ImageFormat::Png);
    let mut bytes = STANDARD.decode(raw.split_once(',').unwrap().1).unwrap();
    bytes[16..20].copy_from_slice(&8192u32.to_be_bytes());
    bytes[20..24].copy_from_slice(&1025u32.to_be_bytes());
    let mut crc = !0u32;
    for b in &bytes[12..29] {
        crc ^= u32::from(*b);
        for _ in 0..8 {
            crc = if crc & 1 != 0 {
                (crc >> 1) ^ 0xedb88320
            } else {
                crc >> 1
            };
        }
    }
    bytes[29..33].copy_from_slice(&(!crc).to_be_bytes());
    assert!(
        decode(
            &format!("data:image/png;base64,{}", STANDARD.encode(bytes)),
            || false
        )
        .err()
        .unwrap()
        .contains("32 MiB")
    );
}
#[test]
fn artifact_image_gif_keeps_only_the_first_frame() {
    let mut bytes = Vec::new();
    {
        let mut encoder = image::codecs::gif::GifEncoder::new(&mut bytes);
        encoder
            .encode_frames([
                image::Frame::new(image::RgbaImage::from_pixel(
                    2,
                    2,
                    image::Rgba([240, 0, 0, 255]),
                )),
                image::Frame::new(image::RgbaImage::from_pixel(
                    2,
                    2,
                    image::Rgba([0, 0, 240, 255]),
                )),
            ])
            .unwrap();
    }
    let r = decode(
        &format!("data:image/gif;base64,{}", STANDARD.encode(bytes)),
        || false,
    )
    .unwrap();
    assert!(r.first_frame);
    assert_eq!(r.image.frame_count(), 1);
    assert_eq!(&r.image.as_bytes(0).unwrap()[..4], &[0, 0, 240, 255]);
}
fn source(format: ImageFormat) -> String {
    let image = image::DynamicImage::ImageRgb8(image::RgbImage::from_fn(3, 2, |x, y| {
        image::Rgb([230, x as u8 * 80, y as u8 * 90])
    }));
    let mut bytes = Cursor::new(Vec::new());
    image.write_to(&mut bytes, format).unwrap();
    let mime = match format {
        ImageFormat::Png => "png",
        ImageFormat::Jpeg => "jpeg",
        ImageFormat::Gif => "gif",
        ImageFormat::WebP => "webp",
        _ => unreachable!(),
    };
    format!(
        "data:image/{mime};base64,{}",
        STANDARD.encode(bytes.into_inner())
    )
}
#[test]
fn maintained_codecs_make_one_bounded_bgra_frame() {
    for format in [ImageFormat::Png, ImageFormat::Jpeg, ImageFormat::Gif] {
        let r = decode(&source(format), || false).unwrap();
        assert_eq!((r.width, r.height), (3, 2));
        assert_eq!(r.image.frame_count(), 1);
        assert_eq!(r.image.as_bytes(0).unwrap().len(), 24);
        assert_eq!(r.first_frame, format == ImageFormat::Gif);
        assert_eq!(r.source_hash.len(), 64);
        if format == ImageFormat::Png {
            assert_eq!(&r.image.as_bytes(0).unwrap()[..4], &[0, 0, 230, 255]);
        }
    }
}
#[test]
fn webp_is_truthfully_unsupported_before_unbounded_adapter_metadata() {
    assert!(
        decode("data:image/webp;base64,AAAA", || false)
            .err()
            .unwrap()
            .contains("WebP preview is unavailable")
    );
}
#[test]
fn rejects_external_svg_mime_mismatch_and_noncanonical_base64() {
    for s in [
        "/tmp/a.png",
        "https://example.com/a.png",
        "file:///tmp/a.png",
        "data:image/svg+xml;base64,PHN2Zz4=",
        "data:image/png;base64,QQ=",
        "data:image/png;base64,QR==",
        "data:image/png;base64, QQ==",
        "data:image/png;base64,",
    ] {
        assert!(decode(s, || false).is_err(), "{s}");
    }
    assert!(
        decode(
            &source(ImageFormat::Png).replace("image/png", "image/jpeg"),
            || false
        )
        .is_err()
    );
}
#[test]
fn rejects_malformed_and_truncated_data() {
    assert!(decode("data:image/png;base64,iVBORw0KGgo=", || false).is_err());
    let s = source(ImageFormat::Jpeg);
    let (_, b) = s.split_once(',').unwrap();
    let mut bytes = STANDARD.decode(b).unwrap();
    bytes.truncate(20);
    assert!(
        decode(
            &format!("data:image/jpeg;base64,{}", STANDARD.encode(bytes)),
            || false
        )
        .is_err()
    );
}
#[test]
fn dimension_and_source_budgets_have_exact_edges() {
    assert!(dimensions(8192, 1024).is_ok());
    assert!(dimensions(3840, 2160).is_ok());
    for (w, h) in [
        (0, 1),
        (1, 0),
        (8193, 1),
        (1, 8193),
        (8192, 1025),
        (u32::MAX, u32::MAX),
    ] {
        assert!(dimensions(w, h).is_err());
    }
    assert_eq!(SOURCE_CAP, 22_369_656);
    assert!(decode(&"x".repeat(SOURCE_CAP + 1), || false).is_err());
}
#[test]
fn cancellation_fences_all_output() {
    assert!(decode(&source(ImageFormat::Png), || true).is_err());
    let n = std::cell::Cell::new(0);
    assert!(
        decode(&source(ImageFormat::Png), || {
            n.set(n.get() + 1);
            n.get() >= 4
        })
        .is_err()
    );
    assert!(n.get() >= 4);
}
#[test]
fn permits_are_nonqueued_and_release_on_drop() {
    let p = Permit::acquire().unwrap();
    assert!(Permit::acquire().is_err());
    drop(p);
    assert!(Permit::acquire().is_ok());
}
