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
                                        vec![Message::live(ID, "assistant".into(), PREFIX.into())],
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
                    (
                        w.find(("copy-source", ID)).bounds(),
                        w.find("viewport").bounds(),
                        v.read(cx).transcript.read(cx).history_probe_row(ID),
                    )
                })
                .unwrap();
            let identity = text.entity_id();
            // Warm renderer/readback before starting the unchanged 280 ms fade.
            // PNG encoding must never consume the interval being sampled.
            drop(cx.capture_screenshot(h).unwrap());
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
            let mut frames = Vec::new();
            let mut snapshots = Vec::new();
            let mut previous = 0;
            for target in [0u64, 80, 160, 400, 600] {
                let remaining = Duration::from_millis(target).saturating_sub(started.elapsed());
                // The framework fade uses Instant, not the fake executor clock.
                // Bounded test-only wall time samples actual paint; no app clock.
                std::thread::sleep(remaining);
                cx.advance_clock(Duration::from_millis(target - previous));
                previous = target;
                cx.run_until_parked();
                cx.update_window(h, |_, w, cx| {
                    w.draw(cx).clear(cx);
                    assert_eq!(
                        w.find(("copy-source", ID)).bounds(),
                        header,
                        "word fade must not move its message"
                    );
                    let t = v.read(cx).transcript.read(cx);
                    assert_eq!(t.history_probe_row(ID).entity_id(), identity);
                    assert!(v.read(cx).text_parsers_ready(cx));
                })
                .unwrap();
                let image = cx.capture_screenshot(h).unwrap();
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
                frames.push((started.elapsed().as_millis(), pixels));
                if captures.is_some() {
                    snapshots.push((target, image));
                }
            }
            let first = &frames[0].1;
            let last = &frames[4].1;
            assert_eq!(
                frames[3].1, *last,
                "default fade must settle without further changes"
            );
            let luma = |p: &[u8; 4]| i32::from(p[0]) + i32::from(p[1]) + i32::from(p[2]);
            let intermediate = first
                .iter()
                .zip(last)
                .enumerate()
                .filter(|(i, (a, b))| {
                    let (a, b) = (luma(a), luma(b));
                    (a - b).abs() > 48
                        && frames[1..3].iter().any(|(_, p)| {
                            let m = luma(&p[*i]);
                            m > a.min(b) + 12 && m < a.max(b) - 12
                        })
                })
                .count();
            println!(
                "{}",
                serde_json::json!({"width":width,"mode":mode.name(),"actual_phase_ms":frames.iter().map(|(t,_)|*t).collect::<Vec<_>>(),"intermediate_pixels":intermediate,"png_encoding_after_sampling":true})
            );
            if let Some(dir) = &captures {
                for (target, image) in snapshots {
                    image
                        .save(dir.join(format!("{}-{}-{target}.png", width as u32, mode.name())))
                        .unwrap();
                }
            }
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
                w.click(("copy-source", ID), cx);
                assert_eq!(
                    cx.read_from_clipboard().unwrap().text().as_deref(),
                    Some(FULL)
                );
                assert_eq!(text.read(cx).rendered_text().source(), FULL);
            })
            .unwrap();
            println!(
                "{}",
                serde_json::json!({"width":width,"mode":mode.name(),"actual_sample_ms":frames.iter().map(|(t,_)|*t).collect::<Vec<_>>(),"intermediate_pixels":intermediate,"idle_transcript_renders":0,"message_geometry_and_entity_retained":true,"exact_copy":true,"native_production_root":true,"visible_smoothness_proof":false})
            );
            cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
            cx.run_until_parked();
        }
    }
}
