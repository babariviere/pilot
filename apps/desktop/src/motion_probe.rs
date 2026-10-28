//! Bounded native word-fade phases, not visible display/frame-pacing evidence.
//! Uses the production readonly transcript and Kit's unchanged motion policy.
use super::*;
use gpui_kit::{
    Bounds, HeadlessAppContext, WindowBounds, WindowOptions,
    component::{Theme, ThemeMode},
    size,
    test::TestWindowExt,
};
use std::time::Instant;

fn luma(p: &[u8; 4]) -> i32 {
    i32::from(p[0]) + i32::from(p[1]) + i32::from(p[2])
}

fn appended_word_mask(first: &[[u8; 4]], last: &[[u8; 4]], row_width: usize) -> Vec<bool> {
    assert_eq!(first.len(), last.len());
    assert_eq!(first.len() % row_width, 0);
    first
        .chunks_exact(row_width)
        .zip(last.chunks_exact(row_width))
        .flat_map(|(before, after)| {
            // This single unwrapped line ends in blank background. Existing
            // PREFIX ink must remain pixel-identical; sample only new ink
            // appearing over its previous background, never a shifted prefix.
            let background = before.last().unwrap();
            assert_eq!(
                Some(background),
                after.last(),
                "line must retain blank margin"
            );
            before.iter().zip(after).map(move |(a, b)| {
                let prefix_ink = (luma(a) - luma(background)).abs() > 12;
                if prefix_ink {
                    assert_eq!(a, b, "existing PREFIX glyphs must not move or fade");
                }
                !prefix_ink && (luma(a) - luma(b)).abs() > 48
            })
        })
        .collect()
}

fn intermediate_pixels(
    first: &[[u8; 4]],
    middle: &[&[[u8; 4]]],
    last: &[[u8; 4]],
    mask: &[bool],
) -> usize {
    assert_eq!(first.len(), last.len());
    assert_eq!(first.len(), mask.len());
    assert!(middle.iter().all(|frame| frame.len() == first.len()));
    first
        .iter()
        .zip(last)
        .enumerate()
        .filter(|(i, (a, b))| {
            let (a, b) = (luma(a), luma(b));
            mask[*i]
                && (a - b).abs() > 48
                && middle.iter().any(|pixels| {
                    let m = luma(&pixels[*i]);
                    m > a.min(b) + 12 && m < a.max(b) - 12
                })
        })
        .count()
}
fn relative_ms(at: Instant, start: Instant) -> i128 {
    if at >= start {
        at.duration_since(start).as_millis() as i128
    } else {
        -(start.duration_since(at).as_millis() as i128)
    }
}

pub fn run_motion_probe(cx: &mut HeadlessAppContext) {
    const ID: u64 = 30_000_001;
    const PREFIX: &str = "Streaming:";
    const FULL: &str = "Streaming: alpha beta gamma delta epsilon zeta";
    let captures = std::env::var_os("PILOT_NEXT_MOTION_DIR").map(std::path::PathBuf::from);
    if let Some(dir) = &captures {
        std::fs::create_dir_all(dir).unwrap();
    }
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            cx.update(|cx| Theme::change(mode, None, cx));
            let (h, v) = cx
                .update(|cx| {
                    gpui_kit::open_window(
                        WindowOptions {
                            window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                                Default::default(),
                                size(px(width), px(760.)),
                            ))),
                            show: false,
                            focus: false,
                            ..Default::default()
                        },
                        cx,
                        |w, cx| {
                            cx.new(|cx| {
                                let mut v = LocalViewer::preview(PreviewState::Empty, w, cx);
                                v.selected = Some("synthetic-motion".into());
                                v.title = "Synthetic word-fade phases".into();
                                v.transcript.update(cx, |t, cx| {
                                    t.replace_readonly(
                                        vec![Message::live(ID, "assistant".into(), FULL.into())],
                                        true,
                                        cx,
                                    )
                                });
                                v
                            })
                        },
                    )
                })
                .unwrap();
            cx.run_until_parked();
            let (header, viewport, text) = cx
                .update_window(h, |_, w, cx| {
                    w.draw(cx).clear(cx);
                    assert!(v.read(cx).text_parsers_ready(cx));
                    // The message's first line, where the copy action used to sit.
                    let text = v.read(cx).transcript.read(cx).history_probe_row(ID);
                    let top = text.read(cx).bounds();
                    let copy = w.find(("copy-source", ID)).bounds().size.height;
                    (
                        Bounds::new(top.origin, size(top.size.width, copy)),
                        w.find("viewport").bounds(),
                        text,
                    )
                })
                .unwrap();
            let identity = text.entity_id();
            // Warm the actual final text's layout, glyph atlas and full-size
            // GPU/readback, not just PREFIX. Initial text does not append/fade.
            // Replacing it with its shorter PREFIX clears prior fade segments
            // through Kit's normal set_text semantics, retaining this entity.
            let instant_image = cx
                .update_window(h, |_, w, _| w.render_to_image().unwrap())
                .unwrap();
            cx.update(|cx| {
                v.read(cx).transcript.clone().update(cx, |t, cx| {
                    t.replace_readonly(
                        vec![Message::live(ID, "assistant".into(), PREFIX.into())],
                        false,
                        cx,
                    )
                })
            });
            cx.run_until_parked();
            let baseline = cx
                .update_window(h, |_, w, cx| {
                    let paint = Instant::now();
                    w.draw(cx).clear(cx);
                    assert_eq!(
                        v.read(cx)
                            .transcript
                            .read(cx)
                            .history_probe_row(ID)
                            .read(cx)
                            .bounds()
                            .origin,
                        header.origin
                    );
                    assert_eq!(
                        v.read(cx)
                            .transcript
                            .read(cx)
                            .history_probe_row(ID)
                            .entity_id(),
                        identity
                    );
                    assert!(v.read(cx).text_parsers_ready(cx));
                    let image = w.render_to_image().unwrap();
                    (paint, Instant::now(), image)
                })
                .unwrap();
            // The zero-opacity endpoint is a REAL prefix-only native image,
            // captured before the append. Do not spend that readback inside
            // the unchanged 280ms production fade, or encode PNGs in it.
            macro_rules! region_pixels {
                ($image:expr) => {{
                    let image = &$image;
                    let scale = image.width() as f32 / width;
                    let mut pixels = Vec::new();
                    for y in ((f32::from(header.bottom()) + 1.) * scale) as u32
                        ..((f32::from(header.bottom()) + 36.) * scale) as u32
                    {
                        for x in (f32::from(viewport.left()) * scale) as u32
                            ..(f32::from(viewport.right()) * scale) as u32
                        {
                            pixels.push(image.get_pixel(x, y).0);
                        }
                    }
                    pixels
                }};
            }
            let scale = baseline.2.width() as f32 / width;
            let region_width = ((f32::from(viewport.right()) * scale) as u32
                - (f32::from(viewport.left()) * scale) as u32)
                as usize;
            let mut frames = vec![(baseline.0, baseline.1, region_pixels!(baseline.2))];
            let mut snapshots = Vec::new();
            if captures.is_some() {
                snapshots.push((0, baseline.2));
            }
            let started = Instant::now();
            cx.update(|cx| {
                v.read(cx).transcript.clone().update(cx, |t, cx| {
                    t.replace_readonly(
                        vec![Message::live(ID, "assistant".into(), FULL.into())],
                        false,
                        cx,
                    )
                })
            });
            cx.run_until_parked();
            let mut previous = 0;
            for target in [80u64, 160, 400, 600] {
                let remaining = Duration::from_millis(target).saturating_sub(started.elapsed());
                // The framework fade uses Instant, not the fake executor clock.
                // Bounded test-only wall time samples actual paint; no app clock.
                std::thread::sleep(remaining);
                cx.advance_clock(Duration::from_millis(target - previous));
                previous = target;
                cx.run_until_parked();
                // One update for paint + readback. capture_screenshot in a
                // second update would flush/draw the dirty window again.
                let (paint, captured, image) = cx
                    .update_window(h, |_, w, cx| {
                        let paint = Instant::now();
                        w.draw(cx).clear(cx);
                        assert_eq!(
                            v.read(cx)
                                .transcript
                                .read(cx)
                                .history_probe_row(ID)
                                .read(cx)
                                .bounds()
                                .origin,
                            header.origin,
                            "word fade must not move its message"
                        );
                        let t = v.read(cx).transcript.read(cx);
                        assert_eq!(t.history_probe_row(ID).entity_id(), identity);
                        assert!(v.read(cx).text_parsers_ready(cx));
                        let image = w.render_to_image().unwrap();
                        (paint, Instant::now(), image)
                    })
                    .unwrap();
                frames.push((paint, captured, region_pixels!(image)));
                if captures.is_some() {
                    snapshots.push((target, image));
                }
            }
            let first = &frames[0].2;
            let last = &frames[4].2;
            assert_eq!(
                frames[3].2, *last,
                "default fade must settle without further changes"
            );
            let mask = appended_word_mask(first, last, region_width);
            let middle = [&frames[1].2[..], &frames[2].2[..]];
            let intermediate = intermediate_pixels(first, &middle, last, &mask);
            // Executed instant-appearance negative control: initial FULL was
            // genuinely rendered by the SAME production entity before any
            // append. Initial text has no fade segments. Retain that actual
            // native image, not a substituted endpoint or fabricated pixels.
            let instant_pixels = region_pixels!(instant_image);
            assert_eq!(instant_pixels, *last, "initial FULL must appear settled");
            let instant_intermediate = intermediate_pixels(first, &[&instant_pixels], last, &mask);
            assert_eq!(
                instant_intermediate, 0,
                "instant appearance must fail the positive oracle"
            );
            println!(
                "{}",
                serde_json::json!({"width":width,"mode":mode.name(),"readback_end_ms":frames.iter().map(|(_,t,_)|relative_ms(*t,started)).collect::<Vec<_>>(),"draw_start_ms":frames.iter().map(|(t,_,_)|relative_ms(*t,started)).collect::<Vec<_>>(),"draw_and_readback_ms":frames.iter().map(|(paint,end,_)|end.duration_since(*paint).as_millis()).collect::<Vec<_>>(),"baseline_before_append":true,"intermediate_pixels":intermediate,"appended_word_mask_pixels":mask.iter().filter(|v|**v).count(),"existing_prefix_pixels_unchanged":true,"negative_control_native_initial_full_intermediate_pixels":instant_intermediate,"png_encoding_after_sampling":true})
            );
            if let Some(dir) = &captures {
                instant_image
                    .save(dir.join(format!("{}-{}-instant.png", width as u32, mode.name())))
                    .unwrap();
                for (target, image) in snapshots {
                    image
                        .save(dir.join(format!("{}-{}-{target}.png", width as u32, mode.name())))
                        .unwrap();
                }
            }
            assert!(
                frames[1..3].iter().any(|(paint, _, _)| paint.duration_since(started) < Duration::from_millis(280)),
                "host sampling limit: no post-append paint began inside the unchanged 280ms fade; timings above are not a native motion pass"
            );
            assert!(
                intermediate > 5,
                "new words must paint intermediate opacity, not jump between endpoints"
            );
            // Drain unrelated one-shot scroll/layout work before checking idle.
            for _ in 0..4 {
                cx.advance_clock(Duration::from_millis(500));
                cx.run_until_parked();
                cx.update_window(h, |_, w, cx| w.draw(cx).clear(cx))
                    .unwrap();
            }
            let idle = cx.update(|cx| v.read(cx).transcript.read(cx).probe_render_count());
            for _ in 0..12 {
                cx.advance_clock(Duration::from_millis(84));
                cx.run_until_parked();
                cx.update_window(h, |_, w, cx| w.draw(cx).clear(cx))
                    .unwrap();
            }
            assert_eq!(
                cx.update(|cx| v.read(cx).transcript.read(cx).probe_render_count()),
                idle,
                "settled words must not keep notifying the transcript"
            );
            cx.update_window(h, |_, w, cx| {
                crate::transcript_view::click_copy(w, ID, cx);
                assert_eq!(
                    cx.read_from_clipboard().unwrap().text().as_deref(),
                    Some(FULL)
                );
                assert_eq!(text.read(cx).rendered_text().source(), FULL);
            })
            .unwrap();
            println!(
                "{}",
                serde_json::json!({"width":width,"mode":mode.name(),"actual_sample_ms":frames.iter().map(|(_,t,_)|relative_ms(*t,started)).collect::<Vec<_>>(),"intermediate_pixels":intermediate,"idle_transcript_renders":0,"message_geometry_and_entity_retained":true,"exact_copy":true,"native_production_root":true,"visible_smoothness_proof":false})
            );
            cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
            cx.run_until_parked();
        }
    }
}
