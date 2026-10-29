//! Hidden native image-heavy transcript journeys with production dispatchers.
//! Records sequential row geometry and preview state for stored conversation
//! images and inline raster artifacts. Draw time is CPU work, not presentation.
use super::*;
use gpui_kit::{
    AnyWindowHandle, AsyncApp, BackgroundExecutor, Bounds, InputEvent as _, Pixels, ScrollDelta,
    ScrollEvent, WindowBounds, WindowOptions, point, size, test::TestWindowExt,
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

struct Host {
    view: Entity<TranscriptView>,
    width: f32,
}
impl Render for Host {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div().size_full().child(
            div()
                .w(px(self.width))
                .h_full()
                .min_w_0()
                .child(self.view.clone()),
        )
    }
}

fn png(width: u32, height: u32, seed: u32, noise: bool) -> String {
    let mut state = seed.max(1);
    let pixels = image::RgbImage::from_fn(width, height, |x, y| {
        if noise {
            image::Rgb(std::array::from_fn(|_| {
                state ^= state << 13;
                state ^= state >> 17;
                state ^= state << 5;
                state as u8
            }))
        } else if x < 6 || y < 6 || x >= width - 6 || y >= height - 6 {
            image::Rgb([240, 160, 40])
        } else if (x / 48 + y / 48 + seed).is_multiple_of(2) {
            image::Rgb([24, (seed * 37 % 200) as u8 + 40, 220])
        } else {
            image::Rgb([60, 150, 240])
        }
    });
    let mut bytes = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgb8(pixels)
        .write_to(&mut bytes, image::ImageFormat::Png)
        .unwrap();
    base64::Engine::encode(
        &base64::engine::general_purpose::STANDARD,
        bytes.into_inner(),
    )
}

const SHAPES: [(u32, u32, bool); 10] = [
    (1600, 800, false),
    (600, 1400, false),
    (96, 64, false),
    (760, 640, true),
    (1200, 1200, false),
    (2400, 900, false),
    (400, 1200, false),
    (64, 96, false),
    (760, 640, true),
    (1600, 1000, false),
];

fn image_row(id: u64, entry: u64, data: &str, host: &crate::delivery_store::Host) -> Message {
    let mut source =
        crate::conversation_images::Source::read(0, &json!({"mimeType":"image/png","data":data}));
    source.owner = Some((host.clone(), "owner".into()));
    Message::image(id, "Stored image".into(), source).anchored(crate::model::ReaderKey::model(
        entry,
        0,
        Some(0),
    ))
}

fn text_row(id: u64, n: u64) -> Message {
    Message::live(
        id,
        "Assistant".into(),
        format!(
            "Message {n}. Screenshot review with readable text around each image.\n\nThe reading position must stay put while images load."
        ),
    )
}

fn chat(
    base: u64,
    count: u64,
    seed: u32,
    host: &crate::delivery_store::Host,
) -> (Vec<Message>, usize) {
    let mut rows = Vec::new();
    let mut bytes = 0;
    for n in 0..count {
        let id = base + n * 4;
        rows.push(text_row(id, n));
        let (w, h, noise) = SHAPES[(n as usize + seed as usize) % SHAPES.len()];
        let data = png(w, h, seed * 1000 + n as u32 + 1, noise);
        bytes += data.len();
        rows.push(image_row(id + 1, id, &data, host));
    }
    (rows, bytes)
}

/// Visible image rows: id, identity, row bounds, pixels painted.
type Probe = fn(&mut Window, &TranscriptView, &App) -> Vec<(u64, String, Bounds<Pixels>, bool)>;

fn conversation_rows(
    w: &mut Window,
    t: &TranscriptView,
    _: &App,
) -> Vec<(u64, String, Bounds<Pixels>, bool)> {
    t.transcript
        .messages()
        .iter()
        .filter_map(|row| {
            let source = row.image_data()?;
            let id = row.id();
            let b = w.try_find(("conversation-image", id))?.bounds();
            let pixels = w.try_find(("conversation-image-pixels", id)).is_some();
            Some((id, source.hash.clone().unwrap_or_default(), b, pixels))
        })
        .collect()
}

fn artifact_rows(
    w: &mut Window,
    t: &TranscriptView,
    _: &App,
) -> Vec<(u64, String, Bounds<Pixels>, bool)> {
    let rows: Vec<_> = t
        .transcript
        .messages()
        .iter()
        .filter_map(|r| {
            r.artifact_data()
                .map(|a| (r.id(), format!("{}@{}", a.id, a.revision)))
        })
        .collect();
    // A pane registers its own IDs; its path contains the owning transcript row.
    let panes = w.find_all("inline-visual");
    let pixels = w.find_all("artifact-raster-pixels");
    let owned = |e: &gpui_kit::test::ElementSnapshot, id: u64| {
        e.path()
            .contains(&gpui_kit::ElementId::from(("message", id)))
    };
    rows.into_iter()
        .filter_map(|(id, identity)| {
            let b = panes.iter().find(|e| owned(e, id))?.bounds();
            let pixels = pixels.iter().any(|e| owned(e, id));
            Some((id, identity, b, pixels))
        })
        .collect()
}

#[derive(Clone, Copy, PartialEq)]
struct Seen {
    top: f32,
    height: f32,
    pixels: bool,
}

#[derive(Default)]
struct Journal {
    frames: Vec<Value>,
    // Last frame's visible image rows.
    previous: HashMap<u64, Seen>,
    // Rows already displayed with pixels, by row id and source identity.
    shown: HashMap<(u64, String), f32>,
    reversions: Vec<Value>,
    height_jumps: Vec<Value>,
    shift_jumps: Vec<Value>,
}

impl Journal {
    #[allow(clippy::too_many_arguments)]
    fn sample(
        &mut self,
        phase: &str,
        step: usize,
        delta: f32,
        draw_ms: f64,
        anchor: (usize, f32, bool, f32),
        viewport: Bounds<Pixels>,
        visible: Vec<(u64, String, Bounds<Pixels>, bool)>,
    ) {
        let mut seen = HashMap::new();
        let mut rows = Vec::new();
        for (id, identity, b, pixels) in visible {
            if b.bottom() <= viewport.top() || b.top() >= viewport.bottom() {
                continue;
            }
            let s = Seen {
                top: f32::from(b.top()),
                height: f32::from(b.size.height),
                pixels,
            };
            if !pixels {
                if self.shown.contains_key(&(id, identity.clone())) {
                    self.reversions
                        .push(json!({"phase":phase,"step":step,"id":id}));
                }
            } else {
                self.shown.insert((id, identity), s.height);
            }
            if let Some(p) = self.previous.get(&id)
                && (p.height - s.height).abs() > 0.5
            {
                self.height_jumps.push(json!({"phase":phase,"step":step,"id":id,"from":p.height,"to":s.height,"pixels":[p.pixels,s.pixels]}));
            }
            seen.insert(id, s);
            rows.push(json!([id, s.top, s.height, pixels]));
        }
        // Rows visible in both frames must move together, by the wheel delta unless clamped.
        let moved: Vec<f32> = seen
            .iter()
            .filter_map(|(id, s)| self.previous.get(id).map(|p| s.top - p.top))
            .collect();
        if let (Some(lo), Some(hi)) = (
            moved.iter().copied().reduce(f32::min),
            moved.iter().copied().reduce(f32::max),
        ) {
            let clamped = anchor.2 || (anchor.0 == 0 && anchor.1 <= 0.5);
            if hi - lo > 1. || (!clamped && delta != 0. && (lo - delta).abs() > 1.) {
                self.shift_jumps.push(json!({"phase":phase,"step":step,"delta":delta,"moved":[lo,hi],"anchor":[anchor.0,anchor.1,anchor.2]}));
            }
        }
        self.previous = seen;
        self.frames.push(json!({"phase":phase,"step":step,"delta":delta,"draw_ms":draw_ms,"anchor":[anchor.0,anchor.1,anchor.2],"rows":rows}));
    }
    fn phase(&self, p: &str) -> Value {
        let f: Vec<_> = self.frames.iter().filter(|f| f["phase"] == p).collect();
        let mut draws: Vec<f64> = f
            .iter()
            .filter(|f| f["delta"] != 0.)
            .map(|f| f["draw_ms"].as_f64().unwrap())
            .collect();
        draws.sort_by(f64::total_cmp);
        let mut cpu: Vec<f64> = f
            .iter()
            .filter(|f| f["delta"] != 0.)
            .map(|f| f["cpu_ms"].as_f64().unwrap_or(0.))
            .collect();
        cpu.sort_by(f64::total_cmp);
        let quantiles = |v: &[f64]| {
            let q = |p: f64| {
                v.get(((v.len() as f64 - 1.) * p).round() as usize)
                    .copied()
                    .unwrap_or(0.)
            };
            json!([q(0.5), q(0.95), v.last().copied().unwrap_or(0.)])
        };
        let count = |v: &[Value]| v.iter().filter(|r| r["phase"] == p).count();
        json!({
            "frames": f.len(),
            "reversions": count(&self.reversions),
            "height_jumps": count(&self.height_jumps),
            "shift_jumps": count(&self.shift_jumps),
            "loading_row_frames": f.iter().map(|f| f["rows"].as_array().unwrap().iter().filter(|r| r[3] == false).count()).sum::<usize>(),
            "wheel_draw_ms_median_p95_max": quantiles(&draws),
            "wheel_draw_cpu_ms_median_p95_max": quantiles(&cpu),
        })
    }
}

struct Run<'a> {
    executor: BackgroundExecutor,
    h: AnyWindowHandle,
    t: Entity<TranscriptView>,
    probe: Probe,
    journal: &'a mut Journal,
}
impl Run<'_> {
    fn anchor(&self, cx: &mut AsyncApp) -> (usize, f32, bool, f32) {
        cx.update(|cx| self.t.read(cx).history_probe_anchor(cx))
    }
    /// One frame: optional wheel packet, explicit draw, sample. 16ms between frames
    /// lets real background decode and foreground completion run as in production.
    async fn frame(&mut self, cx: &mut AsyncApp, phase: &str, step: usize, delta: f32) {
        if step == 0 {
            eprintln!("phase {phase}");
        }
        self.executor.timer(Duration::from_millis(16)).await;
        let (t, probe, journal) = (self.t.clone(), self.probe, &mut *self.journal);
        cx.update_window(self.h, |_, w, cx| {
            let viewport = w.find("viewport").bounds();
            if delta != 0. {
                let position = viewport.origin + point(px(8.), px(200.));
                w.dispatch_event(
                    ScrollEvent {
                        position,
                        delta: ScrollDelta::Pixels(point(px(0.), px(delta))),
                        ..Default::default()
                    }
                    .to_platform_input(),
                    cx,
                );
            }
            let start = Instant::now();
            let cpu = thread_cpu_ms();
            w.draw(cx).clear(cx);
            let ms = start.elapsed().as_secs_f64() * 1000.;
            let cpu = thread_cpu_ms() - cpu;
            let viewport = w.find("viewport").bounds();
            let visible = probe(w, t.read(cx), cx);
            journal.sample(
                phase,
                step,
                delta,
                ms,
                t.read(cx).history_probe_anchor(cx),
                viewport,
                visible,
            );
            if let Some(f) = journal.frames.last_mut() {
                f["cpu_ms"] = json!(cpu);
            }
        })
        .unwrap();
    }
    async fn settle(&mut self, cx: &mut AsyncApp, phase: &str, frames: usize) {
        for step in 0..frames {
            self.frame(cx, phase, step, 0.).await;
        }
    }
    /// Full traversal down to the tail, then back to the top.
    async fn traverse(&mut self, cx: &mut AsyncApp, phase: &str) {
        let mut step = 0;
        while !self.anchor(cx).2 && step < 900 {
            self.frame(cx, phase, step, -48.).await;
            step += 1;
        }
        for _ in 0..8 {
            self.frame(cx, phase, step, 0.).await;
            step += 1;
        }
        while {
            let a = self.anchor(cx);
            !(a.0 == 0 && a.1 <= 0.5)
        } && step < 1800
        {
            self.frame(cx, phase, step, 48.).await;
            step += 1;
        }
        for _ in 0..8 {
            self.frame(cx, phase, step, 0.).await;
            step += 1;
        }
    }
    /// Repeatedly scroll rows off and back onto the viewport near one position.
    async fn oscillate(&mut self, cx: &mut AsyncApp, phase: &str) {
        let mut step = 0;
        for _ in 0..3 {
            for delta in [-48., 48.] {
                for _ in 0..24 {
                    self.frame(cx, phase, step, delta).await;
                    step += 1;
                }
            }
        }
    }
}

/// Main-thread CPU time, to separate draw work from descheduling or waiting.
fn thread_cpu_ms() -> f64 {
    let mut t = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    unsafe { libc::clock_gettime(libc::CLOCK_THREAD_CPUTIME_ID, &mut t) };
    t.tv_sec as f64 * 1000. + t.tv_nsec as f64 / 1e6
}

fn window() -> WindowOptions {
    WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(Bounds::new(
            Default::default(),
            size(px(1100.), px(900.)),
        ))),
        show: false,
        focus: false,
        ..Default::default()
    }
}

pub fn run(cx: &mut App) {
    let dir = std::path::PathBuf::from(
        std::env::var_os("PILOT_NEXT_IMAGE_SCROLL_DIR").expect("private output directory"),
    );
    std::fs::create_dir_all(&dir).unwrap();
    let host = crate::LocalOptions::synthetic(9).host();
    let (rows, bytes) = chat(1000, 24, 1, &host);
    let (prefix, prefix_bytes) = chat(100, 6, 3, &host);
    let (other, _) = chat(5000, 6, 7, &host);
    assert!(
        bytes + prefix_bytes > 8 * 1024 * 1024,
        "exceeds the old aggregate source limit"
    );
    let options = window();
    let (h, root) = gpui_kit::open_window(options, cx, |w, cx| {
        let view = cx.new(|cx| {
            let mut t = TranscriptView::readonly(w, cx);
            t.history_scope(1);
            t.replace_readonly(rows.clone(), true, cx);
            t
        });
        cx.new(|_| Host { view, width: 1100. })
    })
    .unwrap();
    let t = root.read(cx).view.clone();
    t.update(cx, |v, cx| {
        v.scroller.update(cx, |s, cx| {
            s.restore_anchor(0, px(0.), cx);
        })
    });
    let executor = cx.background_executor().clone();
    cx.spawn(async move |cx| {
        let mut images = Journal::default();
        let mut run = Run { executor: executor.clone(), h, t: t.clone(), probe: conversation_rows, journal: &mut images };
        run.settle(cx, "mount", 4).await;
        run.traverse(cx, "cold").await;
        run.traverse(cx, "warm").await;
        cx.update(|cx| t.update(cx, |v, cx| v.scroller.update(cx, |s, cx| { s.restore_anchor(13, px(0.), cx); })));
        run.oscillate(cx, "nearby").await;
        // Same position and journey with only nearby pixels retained, to separate
        // retention from position effects in draw time.
        cx.update(|cx| t.update(cx, |v, cx| v.clear_image(cx)));
        run.settle(cx, "nearby-reload", 60).await;
        run.journal.shown.clear();
        run.oscillate(cx, "nearby-released").await;
        run.oscillate(cx, "nearby-again").await;
        // History prepend while reading the middle of the chat.
        cx.update(|cx| t.update(cx, |v, cx| v.scroller.update(cx, |s, cx| { s.restore_anchor(9, px(40.), cx); })));
        run.settle(cx, "prepend-before", 30).await;
        let before = run.anchor(cx);
        let before_tops = run.journal.previous.clone();
        let mut combined = prefix.clone();
        combined.extend(rows.iter().cloned());
        cx.update(|cx| t.update(cx, |v, cx| v.replace_readonly(combined.clone(), false, cx)));
        run.frame(cx, "prepend", 0, 0.).await;
        let after = run.anchor(cx);
        let prepend_shift: Vec<_> = run.journal.previous.iter().filter_map(|(id, s)| before_tops.get(id).map(|p| json!([id, s.top - p.top, p.pixels, s.pixels]))).collect();
        run.settle(cx, "prepend", 10).await;
        run.traverse(cx, "prepended").await;
        // Switch to another chat, then return: a new scope, so pixels reload.
        cx.update(|cx| t.update(cx, |v, cx| { v.history_scope(2); v.replace_readonly(other.clone(), true, cx); }));
        run.settle(cx, "switch-other", 20).await;
        cx.update(|cx| t.update(cx, |v, cx| { v.history_scope(3); v.replace_readonly(combined.clone(), true, cx); v.scroller.update(cx, |s, cx| { s.restore_anchor(0, px(0.), cx); }); }));
        run.journal.shown.clear();
        run.traverse(cx, "switch-back").await;
        // Narrow the actual containing column; images refit once, then scroll warm.
        cx.update(|cx| root.update(cx, |r, cx| { r.width = 700.; cx.notify(); }));
        run.journal.shown.clear();
        run.journal.previous.clear();
        run.settle(cx, "resize", 10).await;
        run.journal.previous.clear();
        run.traverse(cx, "resized").await;
        let retained = cx.update(|cx| t.read(cx).images.entries.values().filter(|e| e.raster.is_some()).count());
        cx.update_window(h, |_, w, _| w.remove_window()).unwrap();

        // Inline raster artifacts beside conversation images, through the real reader:
        // pins with their publication size, then legacy pins without one.
        let mut artifacts = Journal::default();
        let mut artifact_reads = serde_json::Map::new();
        for (prefix, hinted) in [("artifact", true), ("legacy", false)] {
            let server = crate::transcript_view::inline_visual::probe::Server::new();
            let mut rows = Vec::new();
            for n in 0..12u64 {
                let id = 3000 + n * 4;
                rows.push(text_row(id, n));
                let mut r = crate::transcript_view::inline_visual::probe::reference(&format!("raster-large-{prefix}-{n}"), 1);
                r.kind = "image".into();
                let size = crate::artifact_model::RasterSize { width: 1024, height: 640, first_frame: false };
                rows.push(Message::artifact(id + 1, r).with_artifact_size(hinted.then_some(size)));
            }
            let options = server.options.clone();
            let (h, viewer) = cx.update(|cx| {
                let window = window();
                gpui_kit::open_window(window, cx, |w, cx| {
                    cx.new(|cx| crate::LocalViewer::inline_visual_fixture(options.clone(), rows.clone(), w, cx))
                })
                .unwrap()
            });
            let t = cx.update(|cx| viewer.read(cx).inline_probe_transcript());
            cx.update(|cx| {
                viewer.update(cx, |v, cx| v.inline_probe_enable(server.options.clone(), cx));
                t.update(cx, |t, cx| t.inline_probe_scroll(0, cx));
            });
            artifacts.previous.clear();
            artifacts.shown.clear();
            let mut run = Run { executor: executor.clone(), h, t: t.clone(), probe: artifact_rows, journal: &mut artifacts };
            run.settle(cx, &format!("{prefix}-mount"), 4).await;
            let reads = || server.reads.lock().unwrap().len();
            let r0 = reads();
            run.traverse(cx, &format!("{prefix}-cold")).await;
            let r1 = reads();
            cx.update(|cx| t.update(cx, |v, cx| v.scroller.update(cx, |s, cx| { s.restore_anchor(9, px(0.), cx); })));
            run.settle(cx, &format!("{prefix}-position"), 20).await;
            let r2 = reads();
            run.oscillate(cx, &format!("{prefix}-nearby")).await;
            let r3 = reads();
            cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
            drop(server);
            artifact_reads.insert(prefix.into(), json!({"cold": r1 - r0, "position": r2 - r1, "nearby": r3 - r2}));
        }

        let mut phases = serde_json::Map::new();
        for p in ["cold", "warm", "nearby", "nearby-released", "nearby-again", "prepended", "switch-back", "resized"] {
            phases.insert(p.into(), images.phase(p));
        }
        for p in ["artifact-cold", "artifact-nearby", "legacy-cold", "legacy-nearby"] {
            phases.insert(p.into(), artifacts.phase(p));
        }
        let first = |j: &Journal| json!({
            "reversions": j.reversions.iter().take(6).collect::<Vec<_>>(),
            "height_jumps": j.height_jumps.iter().take(6).collect::<Vec<_>>(),
            "shift_jumps": j.shift_jumps.iter().take(6).collect::<Vec<_>>(),
        });
        let report = json!({
            "source_bytes": bytes + prefix_bytes,
            "phases": phases,
            "prepend": {"before": [before.0, before.1, before.2], "after": [after.0, after.1, after.2], "visible_top_shift": prepend_shift},
            "retained_decoded_conversation_images": retained,
            "artifact_reads": artifact_reads,
            "first_images": first(&images),
            "first_artifacts": first(&artifacts),
            "note": "Explicit Window::draw CPU time on hidden native windows, not presentation/VSync.",
        });
        let mut frames = images.frames;
        frames.extend(artifacts.frames);
        std::fs::write(dir.join("frames.json"), serde_json::to_vec(&frames).unwrap()).unwrap();
        std::fs::write(dir.join("report.json"), serde_json::to_vec_pretty(&report).unwrap()).unwrap();
        println!("{}", serde_json::to_string_pretty(&report).unwrap());
        cx.update(|cx| cx.quit());
    })
    .detach();
}
