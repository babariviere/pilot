//! Mounted production canvas, real GPUI pointer dispatch, synthetic Draw replies.
use super::*;
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
        pointer,
    } = command
    else {
        panic!("expected Draw")
    };
    let x = pointer.map_or(0., |p| p[0]);
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
pub(in crate::artifact_view) fn run(cx: &mut HeadlessAppContext) {
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
