//! Mounted production canvas, real GPUI pointer dispatch, synthetic Draw replies.
use super::*;
thread_local! {
    pub(super) static RENDERS: Cell<usize> = const { Cell::new(0) };
}
use gpui_kit::{
    HeadlessAppContext, InputEvent, MouseMoveEvent, WindowBounds, WindowOptions,
    component::{Theme, ThemeMode},
    point, size,
    test::TestWindowExt,
};

fn ack(p: &mut ArtifactPane, command: Command, cx: &mut Context<ArtifactPane>) {
    let Command::Draw {
        version,
        id,
        width,
        height,
        t,
        pointer,
    } = command
    else {
        panic!("expected Draw")
    };
    let x = pointer.map_or(0., |p| p[0]) + t * 100.;
    let drawing = crate::visual_drawing::Drawing::checked(
        1,
        vec![10., 1., 7., 1., 0., x, 20., 30., 30., 0.],
        vec![],
    )
    .unwrap();
    let mut next = p.snapshot.clone();
    Arc::make_mut(&mut next.drawings).insert(
        id,
        crate::artifact_worker::DrawingFrame {
            version,
            width,
            height,
            t,
            pointer,
            plan: crate::visual_canvas_plan::Plan::compile(&drawing, width, height).map(Arc::new),
        },
    );
    let reference = p.reference.clone().unwrap();
    p.accept(p.generation, &reference, next, cx);
}
fn pointer(command: &Command) -> Option<[f64; 2]> {
    let Command::Draw { pointer, .. } = command else {
        panic!("expected Draw")
    };
    *pointer
}
fn time(command: &Command) -> f64 {
    let Command::Draw { t, .. } = command else {
        panic!("expected Draw")
    };
    *t
}
fn thread_cpu() -> std::time::Duration {
    let mut ts = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    unsafe { libc::clock_gettime(libc::CLOCK_THREAD_CPUTIME_ID, &mut ts) };
    std::time::Duration::new(ts.tv_sec as u64, ts.tv_nsec as u32)
}
/// Animated canvas lifecycle on the real paint path: one Draw per shown frame
/// with advancing t, latest-only flight, pause offscreen and in source view,
/// a bounded catch-up on return, a retried slow frame and t = 0 under Reduce Motion.
fn animated(cx: &mut HeadlessAppContext) {
    const FRAME: std::time::Duration = std::time::Duration::from_millis(16);
    let reduce_motion = cx.update(|cx| {
        let previous = cx.reduce_motion();
        cx.set_reduce_motion(false);
        previous
    });
    let (worker, commands) = Worker::synthetic();
    let (handle, view) = cx.update(|cx| {
        gpui_kit::open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(Geometry::new(
                    Default::default(),
                    size(px(680.), px(760.)),
                ))),
                show: false,
                focus: false,
                ..Default::default()
            },
            cx,
            |window, cx| {
                cx.new(|cx| {
                    let view = crate::LocalViewer::visual_preview(9, window, cx);
                    view.probe_artifact_pane().update(cx, |p, cx| {
                        let reference = p.reference.clone().unwrap();
                        let mut children = vec![json!({"type":"canvas","id":"0.0","height":160,"animated":true,"label":"Synthetic animation"})];
                        children.extend((1..=40).map(|i| {
                            json!({"type":"text","runs":[{"text":format!("Synthetic row {i}")}]})
                        }));
                        let scene = crate::visual_scene::Scene::parse(
                            json!({"api":1,"root":{"type":"column","children":children}}),
                        )
                        .unwrap();
                        p.preview(reference, "Synthetic animated canvas. No source evaluation.".into(), scene, cx);
                        p.snapshot.live = true;
                        p.worker = Some(worker);
                    });
                    view
                })
            },
        )
        .unwrap()
    });
    let pane = cx.update(|cx| view.read(cx).probe_artifact_pane());
    let frame = |cx: &mut HeadlessAppContext| {
        cx.advance_clock(FRAME);
        cx.run_until_parked();
        cx.update_window(handle, |_, window, cx| window.draw(cx).clear(cx))
            .unwrap();
        cx.run_until_parked();
    };
    cx.run_until_parked();
    frame(cx);
    let first = commands.try_recv().expect("shown animated canvas draws");
    assert_eq!(time(&first), 0., "the first frame draws at t = 0");
    pane.update(cx, |p, cx| ack(p, first, cx));
    // Settle any layout-driven resize before measuring the steady loop.
    for _ in 0..4 {
        frame(cx);
        if let Ok(command) = commands.try_recv() {
            pane.update(cx, |p, cx| ack(p, command, cx));
        }
    }
    let before = cx.capture_screenshot(handle).unwrap();
    // Screenshot paint can start a draw. Reply before the next display tick,
    // rather than benchmarking a permanently late helper reply.
    if let Ok(command) = commands.try_recv() {
        pane.update(cx, |p, cx| ack(p, command, cx));
    }
    let mut last = pane.read_with(cx, |p, _| p.snapshot.drawings["0.0"].t);
    let (cpu, frames) = (thread_cpu(), 60);
    let renders = RENDERS.with(Cell::get);
    for _ in 0..frames {
        frame(cx);
        let next = commands
            .try_recv()
            .expect("each shown frame requests one Draw");
        assert!(commands.try_recv().is_err(), "one Draw in flight");
        let t = time(&next);
        assert!(
            t > last && t - last <= 0.1 + 1e-9,
            "t advances by frame time: {last} -> {t}"
        );
        last = t;
        assert!(
            commands.try_recv().is_err(),
            "a frame in flight blocks the next Draw"
        );
        pane.update(cx, |p, cx| ack(p, next, cx));
    }
    let per_frame = (thread_cpu() - cpu) / frames;
    let renders = RENDERS.with(Cell::get) - renders;
    assert_eq!(
        renders, frames as usize,
        "clock-only Draw admission must not rerender the pane before its reply"
    );
    let after = cx.capture_screenshot(handle).unwrap();
    assert_ne!(
        before.as_raw(),
        after.as_raw(),
        "animated replies paint new frames"
    );
    // A tolerated slow frame keeps the last frame and redraws at once.
    frame(cx);
    let missed = commands.try_recv().unwrap();
    let missed_t = time(&missed);
    frame(cx);
    frame(cx);
    assert!(commands.try_recv().is_err(), "slow helper stays one flight");
    pane.update(cx, |p, cx| {
        let (generation, reference, snapshot) = (
            p.generation,
            p.reference.clone().unwrap(),
            p.snapshot.clone(),
        );
        p.accept(generation, &reference, snapshot, cx);
    });
    let retried = commands.try_recv().expect("slow frame retried");
    assert!(time(&retried) >= missed_t);
    pane.update(cx, |p, cx| ack(p, retried, cx));
    // Scrolled offscreen: no draws however many frames pass.
    pane.update(cx, |p, cx| {
        p.zoom.scroll.set_offset(point(px(0.), px(-2000.)));
        cx.notify();
    });
    // A reply to the Draw sent before the scroll may still arrive.
    for _ in 0..2 {
        frame(cx);
        if let Ok(command) = commands.try_recv() {
            pane.update(cx, |p, cx| ack(p, command, cx));
        }
    }
    last = cx.update(|cx| pane.read(cx).snapshot.drawings["0.0"].t);
    for _ in 0..10 {
        frame(cx);
        assert!(commands.try_recv().is_err(), "offscreen canvas stays still");
    }
    let offscreen = cx
        .update_window(handle, |_, window, _| window.find("0.0").bounds())
        .unwrap();
    assert!(
        offscreen.bottom() < px(0.),
        "canvas scrolled out: {offscreen:?}"
    );
    pane.update(cx, |p, cx| {
        p.zoom.scroll.set_offset(point(px(0.), px(0.)));
        cx.notify();
    });
    frame(cx);
    let resumed = commands.try_recv().expect("returning canvas resumes");
    assert!(
        time(&resumed) > last && time(&resumed) - last <= 0.1 + 1e-9,
        "time paused offscreen: {last} -> {}",
        time(&resumed)
    );
    pane.update(cx, |p, cx| ack(p, resumed, cx));
    // Source view unmounts the canvas.
    pane.update(cx, |p, cx| {
        p.source = true;
        cx.notify();
    });
    // A Draw sent before the switch is already in flight.
    if let Ok(command) = commands.try_recv() {
        pane.update(cx, |p, cx| ack(p, command, cx));
    }
    last = cx.update(|cx| pane.read(cx).snapshot.drawings["0.0"].t);
    for _ in 0..10 {
        frame(cx);
        assert!(commands.try_recv().is_err(), "hidden canvas stays still");
    }
    pane.update(cx, |p, cx| {
        p.source = false;
        cx.notify();
    });
    frame(cx);
    let shown = commands.try_recv().expect("shown again resumes");
    assert!(time(&shown) > last && time(&shown) - last <= 0.1 + 1e-9);
    pane.update(cx, |p, cx| ack(p, shown, cx));
    // Reduce Motion: one still frame at t = 0, then nothing.
    cx.update(|cx| cx.set_reduce_motion(true));
    // A Draw sent before the switch may still be in flight; then t = 0 follows.
    let mut times = Vec::new();
    for _ in 0..3 {
        frame(cx);
        while let Ok(command) = commands.try_recv() {
            times.push(time(&command));
            pane.update(cx, |p, cx| ack(p, command, cx));
        }
    }
    assert_eq!(
        times.last(),
        Some(&0.),
        "Reduce Motion draws t = 0: {times:?}"
    );
    assert!(times.len() <= 2, "{times:?}");
    for _ in 0..10 {
        frame(cx);
        assert!(commands.try_recv().is_err(), "Reduce Motion stays still");
    }
    // Inject a clock-only request on the production admission path, without
    // depending on a global Reduce Motion change invalidating this test pane.
    pane.update(cx, |p, cx| {
        let f = &p.snapshot.drawings["0.0"];
        p.draw_pointer(
            p.generation,
            p.snapshot.version,
            "0.0".into(),
            f.width,
            f.height,
            f.t + 1.,
            f.pointer,
            cx,
        );
    });
    let _failed = commands
        .try_recv()
        .expect("clock-only request before error");
    pane.update(cx, |p, cx| {
        let mut failed = p.snapshot.clone();
        failed.live = false;
        failed.error = Some(crate::visual_runtime::Fault {
            kind: "timeout",
            message: "Synthetic canvas timeout".into(),
            line: None,
            limit: None,
        });
        let reference = p.reference.clone().unwrap();
        p.accept(p.generation, &reference, failed, cx);
        assert!(!p.busy && !p.drawing && p.snapshot.error.is_some());
    });
    for _ in 0..10 {
        frame(cx);
        assert!(
            commands.try_recv().is_err(),
            "failed animation stops drawing"
        );
    }
    // Restore a healthy still canvas so window removal is tested with live
    // admission, not merely rejected because of the previous worker error.
    cx.update(|cx| cx.set_reduce_motion(true));
    pane.update(cx, |p, cx| {
        let mut recovered = p.snapshot.clone();
        recovered.live = true;
        recovered.error = None;
        let reference = p.reference.clone().unwrap();
        p.accept(p.generation, &reference, recovered, cx);
    });
    for _ in 0..3 {
        frame(cx);
        if let Ok(command) = commands.try_recv() {
            pane.update(cx, |p, cx| ack(p, command, cx));
        }
    }
    cx.update(|cx| cx.set_reduce_motion(false));
    cx.update_window(handle, |_, window, _| window.remove_window())
        .unwrap();
    cx.run_until_parked();
    pane.update(cx, |p, cx| {
        p.pump_canvas(cx);
        assert!(
            commands.try_recv().is_err(),
            "removed window stops animation"
        );
        p.close();
    });
    cx.update(|cx| cx.set_reduce_motion(reduce_motion));
    println!(
        "Native animated canvas: per-frame Draw with advancing t, one flight, slow-frame retry, offscreen/source pause with bounded catch-up, Reduce Motion t=0, error stop, window removal. UI thread CPU per animated frame cycle (headless, synthetic replies): {:.2} ms; canvas element renders: {renders}/{frames} cycles.",
        per_frame.as_secs_f64() * 1000.,
    );
}
/// Replies to a Draw with `drawing(width, height)` at the Draw's own identity.
fn reply(
    p: &mut ArtifactPane,
    command: Command,
    drawing: fn(f64, f64) -> crate::visual_drawing::Drawing,
    cx: &mut Context<ArtifactPane>,
) {
    let Command::Draw {
        version,
        id,
        width,
        height,
        t,
        pointer,
    } = command
    else {
        panic!("expected Draw")
    };
    install(
        p,
        id,
        version,
        width,
        height,
        t,
        pointer,
        drawing(width, height),
        cx,
    );
}
#[allow(clippy::too_many_arguments)]
fn install(
    p: &mut ArtifactPane,
    id: String,
    version: u64,
    width: f64,
    height: f64,
    t: f64,
    pointer: Option<[f64; 2]>,
    drawing: crate::visual_drawing::Drawing,
    cx: &mut Context<ArtifactPane>,
) {
    let mut next = p.snapshot.clone();
    Arc::make_mut(&mut next.drawings).insert(
        id,
        crate::artifact_worker::DrawingFrame {
            version,
            width,
            height,
            t,
            pointer,
            plan: crate::visual_canvas_plan::Plan::compile(&drawing, width, height).map(Arc::new),
        },
    );
    let reference = p.reference.clone().unwrap();
    p.accept(p.generation, &reference, next, cx);
}
const COLS: usize = 40;
const ROWS: usize = 20;
/// One filled cell per command, cycling the six chart colors: 800 commands.
fn grid(width: f64, height: f64) -> crate::visual_drawing::Drawing {
    let (cw, ch) = (width / COLS as f64, height / ROWS as f64);
    let mut ops = Vec::new();
    for i in 0..COLS * ROWS {
        let (c, r) = ((i % COLS) as f64, (i / COLS) as f64);
        let color = 7. + (i % 6) as f64;
        ops.extend([
            10.,
            1.,
            color,
            1.,
            0.,
            c * cw + 1.,
            r * ch + 1.,
            cw - 2.,
            ch - 2.,
            0.,
        ]);
    }
    crate::visual_drawing::Drawing::checked(COLS * ROWS, ops, vec![]).unwrap()
}
/// 20,000 large rounded cards: valid commands whose triangles pass the native
/// vertex limit together.
fn cards(width: f64, _: f64) -> crate::visual_drawing::Drawing {
    let mut ops = Vec::new();
    for k in 0..20_000 {
        ops.extend([
            10.,
            1.,
            7.,
            1.,
            0.,
            (k as f64 * 7.) % (width - 80.),
            10.,
            80.,
            80.,
            40.,
        ]);
    }
    crate::visual_drawing::Drawing::checked(20_000, ops, vec![]).unwrap()
}
/// 20,000 small dots, the published per-draw command maximum.
fn dots(width: f64, height: f64) -> crate::visual_drawing::Drawing {
    let mut ops = Vec::new();
    for k in 0..20_000 {
        let (x, y) = (
            (k * 37) as f64 % (width - 8.) + 4.,
            (k * 53) as f64 % (height - 8.) + 4.,
        );
        ops.extend([11., 1., 7. + (k % 6) as f64, 0.9, 0., x, y, 2.]);
    }
    crate::visual_drawing::Drawing::checked(20_000, ops, vec![]).unwrap()
}
/// Canvases past 512 commands paint completely: every cell of an 800-command
/// grid is visible at both widths in both themes. A drawing past the native
/// vertex limit shows its error rather than a partial frame, and the next valid
/// frame paints in full again.
fn large(cx: &mut HeadlessAppContext) {
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            cx.update(|cx| Theme::change(mode, None, cx));
            let (worker, commands) = Worker::synthetic();
            let (handle, view) = cx.update(|cx| {
                gpui_kit::open_window(
                    WindowOptions {
                        window_bounds: Some(WindowBounds::Windowed(Geometry::new(
                            Default::default(),
                            size(px(width), px(760.)),
                        ))),
                        show: false,
                        focus: false,
                        ..Default::default()
                    },
                    cx,
                    |window, cx| {
                        cx.new(|cx| {
                            let view = crate::LocalViewer::visual_preview(9, window, cx);
                            view.probe_artifact_pane().update(cx, |p, cx| {
                                let reference = p.reference.clone().unwrap();
                                p.preview_canvas(reference, 320., cx);
                                p.snapshot.drawings = Default::default();
                                p.snapshot.live = true;
                                p.worker = Some(worker);
                                p.zoom.scale = Some(1.);
                            });
                            view
                        })
                    },
                )
                .unwrap()
            });
            let pane = cx.update(|cx| view.read(cx).probe_artifact_pane());
            let settle = |cx: &mut HeadlessAppContext| {
                for _ in 0..6 {
                    cx.run_until_parked();
                    cx.update_window(handle, |_, window, cx| window.render_frame(cx))
                        .unwrap();
                    cx.run_until_parked();
                    let Ok(command) = commands.try_recv() else {
                        return;
                    };
                    pane.update(cx, |p, cx| reply(p, command, grid, cx));
                }
                panic!("canvas never settled");
            };
            settle(cx);
            let frame = pane.read_with(cx, |p, _| p.snapshot.drawings["0.1"].clone());
            let plan = frame.plan.clone().expect("800-command grid plans");
            assert_eq!(plan.vertices(), COLS * ROWS * 6, "every cell is planned");
            let bounds = cx
                .update_window(handle, |_, window, cx| {
                    window.render_frame(cx);
                    window.find("0.1").bounds()
                })
                .unwrap();
            let scale = f64::from(f32::from(bounds.size.width)) / frame.width;
            assert!((scale - 1.).abs() < 0.01, "unzoomed reader {scale}");
            assert!(
                f32::from(bounds.right()) <= width && f32::from(bounds.bottom()) <= 760.,
                "whole canvas visible: {bounds:?}"
            );
            let missing = |cx: &mut HeadlessAppContext| {
                let image = cx.capture_screenshot(handle).unwrap();
                let k = f64::from(image.width()) / f64::from(width);
                let pixel = |x: f64, y: f64| {
                    let px = (f64::from(f32::from(bounds.left())) + x * scale) * k;
                    let py = (f64::from(f32::from(bounds.top())) + y * scale) * k;
                    *image.get_pixel(px as u32, py as u32)
                };
                let gap = pixel(0.3, 0.3);
                let (cw, ch) = (frame.width / COLS as f64, frame.height / ROWS as f64);
                (0..COLS * ROWS)
                    .filter(|i| {
                        let (c, r) = ((i % COLS) as f64, (i / COLS) as f64);
                        pixel(c * cw + cw / 2., r * ch + ch / 2.) == gap
                    })
                    .count()
            };
            assert_eq!(
                missing(cx),
                0,
                "every one of 800 cells paints ({width} {mode:?})"
            );
            let paint_cpu = |cx: &mut HeadlessAppContext| {
                let cpu = thread_cpu();
                for _ in 0..10 {
                    cx.update_window(handle, |_, window, cx| window.render_frame(cx))
                        .unwrap();
                }
                (thread_cpu() - cpu) / 10
            };
            let grid_cpu = paint_cpu(cx);
            // Past the vertex limit: explicit error, no partial frame.
            let identity = (frame.version, frame.width, frame.height);
            pane.update(cx, |p, cx| {
                install(
                    p,
                    "0.1".into(),
                    identity.0,
                    identity.1,
                    identity.2,
                    0.,
                    None,
                    cards(identity.1, identity.2),
                    cx,
                )
            });
            cx.run_until_parked();
            let error = pane.read_with(cx, |p, _| p.snapshot.drawings["0.1"].plan.clone().err());
            assert_eq!(
                error,
                Some("Canvas exceeds the native limit of 1,048,576 triangle vertices")
            );
            // The refused frame has no plan to paint, only its error.
            let empty_cpu = paint_cpu(cx);
            // Contract-scale dots: plan off the UI thread, then measure paint only.
            let started = std::time::Instant::now();
            let heavy = dots(identity.1, identity.2);
            pane.update(cx, |p, cx| {
                install(
                    p,
                    "0.1".into(),
                    identity.0,
                    identity.1,
                    identity.2,
                    0.,
                    None,
                    heavy,
                    cx,
                )
            });
            let planned = started.elapsed();
            let vertices = pane.read_with(cx, |p, _| {
                p.snapshot.drawings["0.1"]
                    .plan
                    .as_ref()
                    .map(|p| p.vertices())
                    .ok()
            });
            println!(
                "Native canvas {width} {mode:?} UI CPU per frame: no geometry {empty_cpu:?}, 800-cell grid {grid_cpu:?}, 20000 dots ({vertices:?} vertices; plan+accept {planned:?}) {:?}",
                paint_cpu(cx)
            );
            // A valid frame after the refusal paints in full again.
            pane.update(cx, |p, cx| {
                install(
                    p,
                    "0.1".into(),
                    identity.0,
                    identity.1,
                    identity.2,
                    0.,
                    None,
                    grid(identity.1, identity.2),
                    cx,
                )
            });
            cx.run_until_parked();
            cx.update_window(handle, |_, window, cx| window.render_frame(cx))
                .unwrap();
            assert_eq!(missing(cx), 0, "valid frame after refusal paints fully");
            assert!(
                commands.try_recv().is_err(),
                "installed frames request no Draw"
            );
            cx.update_window(handle, |_, window, _| window.remove_window())
                .unwrap();
            cx.run_until_parked();
        }
    }
    println!(
        "Native canvas large: 800-command grid fully painted at 680/1100, light/dark; vertex-limit refusal paints nothing, then recovers. Synthetic, offscreen only."
    );
}
pub(in crate::artifact_view) fn run(cx: &mut HeadlessAppContext) {
    animated(cx);
    large(cx);
    let reduce_motion = cx.update(|cx| {
        let previous = cx.reduce_motion();
        cx.set_reduce_motion(true);
        previous
    });
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            cx.update(|cx| Theme::change(mode, None, cx));
            let (worker, commands) = Worker::synthetic();
            let (handle, view) = cx.update(|cx| {
                gpui_kit::open_window(
                    WindowOptions {
                        window_bounds: Some(WindowBounds::Windowed(Geometry::new(
                            Default::default(),
                            size(px(width), px(760.)),
                        ))),
                        show: false,
                        focus: false,
                        ..Default::default()
                    },
                    cx,
                    |window, cx| {
                        cx.new(|cx| {
                            let view = crate::LocalViewer::visual_preview(9, window, cx);
                            view.probe_artifact_pane().update(cx, |p, cx| {
                                let reference = p.reference.clone().unwrap();
                                p.preview_canvas(reference, 320., cx);
                                p.snapshot.drawings = Default::default();
                                p.snapshot.live = true;
                                p.worker = Some(worker);
                                p.zoom.scale = Some(1.5);
                            });
                            view
                        })
                    },
                )
                .unwrap()
            });
            cx.run_until_parked();
            let pane = cx.update(|cx| view.read(cx).probe_artifact_pane());
            let initial = commands
                .try_recv()
                .expect("mounted canvas requests initial frame");
            assert_eq!(pointer(&initial), None);
            let dimensions = |command: &Command| {
                let Command::Draw { width, height, .. } = command else {
                    panic!("expected Draw")
                };
                (*width, *height)
            };
            let mut last_size = dimensions(&initial);
            pane.update(cx, |p, cx| ack(p, initial, cx));
            // Resolving the initial placeholder can change the zoomed reader's
            // natural width. Only a genuinely new size may request another frame.
            for _ in 0..4 {
                cx.run_until_parked();
                cx.update_window(handle, |_, window, cx| window.render_frame(cx))
                    .unwrap();
                cx.run_until_parked();
                let Ok(resize) = commands.try_recv() else {
                    break;
                };
                assert_eq!(pointer(&resize), None);
                let next_size = dimensions(&resize);
                assert_ne!(
                    next_size, last_size,
                    "same-size frame must settle without a draw loop"
                );
                last_size = next_size;
                pane.update(cx, |p, cx| ack(p, resize, cx));
            }
            cx.run_until_parked();
            assert!(commands.try_recv().is_err());
            let bounds = cx
                .update_window(handle, |_, window, cx| {
                    window.render_frame(cx);
                    window.find("0.1").bounds()
                })
                .unwrap();
            let before = cx.capture_screenshot(handle).unwrap();
            // The initial move dispatches once; all subsequent moves replace the
            // desired pointer while the same Draw is in flight.
            cx.update_window(handle, |_, window, cx| {
                for x in 20..120 {
                    window.dispatch_event(
                        MouseMoveEvent {
                            position: bounds.origin + point(px(x as f32), px(60.)),
                            ..Default::default()
                        }
                        .to_platform_input(),
                        cx,
                    );
                }
            })
            .unwrap();
            let first = commands.try_recv().expect("pointer move requests Draw");
            assert!(
                pointer(&first).is_some(),
                "move must target mounted bounds {bounds:?}"
            );
            assert!(
                commands.try_recv().is_err(),
                "one Draw in flight, no worker per move"
            );
            pane.update(cx, |p, cx| ack(p, first, cx));
            let latest = commands
                .try_recv()
                .expect("reply pumps latest pointer only");
            let [x, y] = pointer(&latest).unwrap();
            assert!(
                (x - 119. / 1.5).abs() < 0.01 && (y - 40.).abs() < 0.01,
                "canvas-local, zoom-normalized coordinates: {x},{y}"
            );
            pane.update(cx, |p, cx| ack(p, latest, cx));
            cx.run_until_parked();
            assert!(
                commands.try_recv().is_err(),
                "settled pointer must not redraw forever"
            );
            let after = cx.capture_screenshot(handle).unwrap();
            assert_ne!(
                before.as_raw(),
                after.as_raw(),
                "pointer reply must paint a changed native canvas"
            );
            cx.update_window(handle, |_, window, cx| {
                window.dispatch_event(
                    MouseMoveEvent {
                        position: point(px(1.), px(1.)),
                        ..Default::default()
                    }
                    .to_platform_input(),
                    cx,
                );
            })
            .unwrap();
            let leave = commands
                .try_recv()
                .expect("leaving canvas requests null pointer");
            assert_eq!(pointer(&leave), None);
            pane.update(cx, |p, cx| ack(p, leave, cx));
            cx.run_until_parked();
            assert!(commands.try_recv().is_err());
            // Window exit also clears a live pointer without a final move.
            cx.update_window(handle, |_, window, cx| {
                window.dispatch_event(
                    MouseMoveEvent {
                        position: bounds.origin + point(px(30.), px(45.)),
                        ..Default::default()
                    }
                    .to_platform_input(),
                    cx,
                );
            })
            .unwrap();
            let moved = commands.try_recv().unwrap();
            assert!(pointer(&moved).is_some());
            pane.update(cx, |p, cx| ack(p, moved, cx));
            cx.run_until_parked();
            cx.update_window(handle, |_, window, cx| {
                window.dispatch_event(MouseExitEvent::default().to_platform_input(), cx);
            })
            .unwrap();
            let exited = commands
                .try_recv()
                .expect("window exit requests null pointer");
            assert_eq!(pointer(&exited), None);
            pane.update(cx, |p, cx| ack(p, exited, cx));
            cx.run_until_parked();
            // Every pending request is revalidated, not merely its first move.
            pane.update(cx, |p, cx| {
                let mounted = p.canvases.get_mut("0.1").unwrap();
                mounted.pointer = Some([10., 10.]);
                let geometry = mounted.geometry;
                let proof = mounted.bounds.clone();
                mounted.generation = mounted.generation.wrapping_sub(1);
                p.pump_canvas(cx);
                assert!(commands.try_recv().is_err(), "old generation");
                p.canvases.get_mut("0.1").unwrap().generation = p.generation;
                p.snapshot.version += 1;
                p.pump_canvas(cx);
                assert!(commands.try_recv().is_err(), "old state version");
                p.snapshot.version -= 1;
                p.inline = !p.inline;
                p.pump_canvas(cx);
                assert!(commands.try_recv().is_err(), "different presentation");
                p.inline = !p.inline;
                p.source = true;
                p.pump_canvas(cx);
                assert!(commands.try_recv().is_err(), "source presentation");
                p.source = false;
                let mut resized = geometry;
                resized.size.width += px(1.);
                proof.set(Some(resized));
                p.pump_canvas(cx);
                assert!(commands.try_recv().is_err(), "old geometry");
                proof.set(None);
                p.pump_canvas(cx);
                assert!(commands.try_recv().is_err(), "detached mount");
                proof.set(Some(geometry));
            });
            cx.update_window(handle, |_, window, _| window.remove_window())
                .unwrap();
            cx.run_until_parked();
            // The retained entity must not admit pending work after its window
            // disappears without rendering that entity again.
            pane.update(cx, |p, cx| {
                p.pump_canvas(cx);
                assert!(commands.try_recv().is_err(), "unmounted retained pane");
                p.close();
                p.pump_canvas(cx);
                assert!(commands.try_recv().is_err(), "closed revision");
            });
        }
    }
    cx.update(|cx| cx.set_reduce_motion(reduce_motion));
    println!(
        "Native canvas pointer: narrow/wide, light/dark, zoom-local moves, latest-only one-flight Draw, leave, painted reply, detached/closed fences. Synthetic channel, offscreen only."
    );
}
