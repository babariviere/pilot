//! Real native production viewer + pointer events; faux bounded reader channel.
//! No generated source execution, daemon, real data, canonical writes or visible window.
use super::*;
use gpui_kit::{
    Bounds, HeadlessAppContext, WindowBounds, WindowOptions,
    component::{Theme, ThemeMode},
    point, size,
    test::TestWindowExt,
};
fn scene(value: f64) -> crate::visual_scene::Scene {
    crate::visual_scene::Scene::parse(json!({"api":1,"root":{"type":"slider","id":"0","label":"Load","unit":"%","min":0,"max":100,"step":1,"value":value}})).unwrap()
}
fn mounted(
    pane: &Entity<ArtifactPane>,
    window: &mut Window,
    cx: &gpui_kit::App,
) -> Bounds<gpui_kit::Pixels> {
    let outer = window.find("0-slider").bounds();
    let thumb = window
        .within("0-slider")
        .find(("slider-thumb", 0u32))
        .bounds();
    assert!(
        thumb.left() >= outer.left() && thumb.right() <= outer.right(),
        "endpoint thumbs must not clip against the pane"
    );
    let entity = pane.read(cx).sliders["0"].state.entity_id();
    window.within("0-slider").find(("slider", entity)).bounds()
}
fn acknowledge(p: &mut ArtifactPane, value: f64, version: u64, cx: &mut Context<ArtifactPane>) {
    let mut snapshot = p.snapshot.clone();
    snapshot.version = version;
    snapshot.live = true;
    snapshot.error = None;
    snapshot.scene = Some(Arc::new(scene(value)));
    snapshot.state = Some("[]".into());
    let expected = p.reference.clone().unwrap();
    p.accept(p.generation, &expected, snapshot, cx);
}
pub fn run_slider_probe(cx: &mut HeadlessAppContext) {
    let captures = std::env::var_os("PILOT_NEXT_SLIDER_DIR").map(std::path::PathBuf::from);
    if let Some(dir) = &captures {
        std::fs::create_dir_all(dir).unwrap();
    }
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            cx.update(|cx| Theme::change(mode, None, cx));
            let (worker, commands) = Worker::synthetic();
            let (handle, view) = cx.update(|cx| {
                gpui_kit::open_window(
                    WindowOptions {
                        window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                            point(px(0.), px(0.)),
                            size(px(width), px(760.)),
                        ))),
                        show: false,
                        focus: false,
                        ..Default::default()
                    },
                    cx,
                    |window, cx| {
                        cx.new(|cx| {
                            let view = crate::LocalViewer::visual_preview(1, window, cx);
                            view.probe_artifact_pane().update(cx, |p, cx| {
                                let reference = Reference {
                                    id: "synthetic-visual".into(),
                                    session: "synthetic".into(),
                                    revision: 1,
                                    title: "Synthetic native slider".into(),
                                    kind: "visual".into(),
                                };
                                p.preview(
                                    reference,
                                    "Synthetic expected controls, no generated source execution."
                                        .into(),
                                    scene(0.),
                                    cx,
                                );
                                p.worker = Some(worker);
                                p.snapshot.live = true;
                                p.snapshot.state = Some("[]".into());
                            });
                            view
                        })
                    },
                )
                .unwrap()
            });
            cx.run_until_parked();
            let pane = cx.update(|cx| view.read(cx).probe_artifact_pane());
            let bounds = cx
                .update_window(handle, |_, window, cx| {
                    window.render_frame(cx);
                    mounted(&pane, window, cx)
                })
                .unwrap();
            assert!(bounds.size.width > px(40.) && bounds.size.height > px(4.));
            assert!(commands.try_recv().is_err(), "model creation must not send");
            let before = cx.capture_screenshot(handle).unwrap();
            cx.update_window(handle, |_, window, cx| {
                window.drag(
                    point(bounds.left() + px(1.), bounds.center().y),
                    point(bounds.right() - px(1.), bounds.center().y),
                    cx,
                )
            })
            .unwrap();
            cx.run_until_parked();
            let first = match commands.try_recv().unwrap() {
                Command::Event { version, id, value } => {
                    assert_eq!((version, id.as_str()), (1, "0"));
                    value.as_f64().unwrap()
                }
                _ => panic!("not a slider event"),
            };
            assert!(first < 100.);
            assert!(
                commands.try_recv().is_err(),
                "one command in flight, not a gesture queue"
            );
            cx.update(|cx| {
                let p = pane.read(cx);
                assert!(p.busy);
                assert_eq!(p.slider_flow.queued.as_ref().unwrap().value, 100.);
                assert_eq!(p.sliders["0"].state.read(cx).value().end(), 100.);
            });
            let during = cx
                .update_window(handle, |_, window, cx| {
                    window.render_frame(cx);
                    mounted(&pane, window, cx)
                })
                .unwrap();
            assert_eq!(
                during, bounds,
                "pending state must not move the drag target"
            );
            let after = cx.capture_screenshot(handle).unwrap();
            let scale = after.width() as f32 / width;
            let mut pixels = 0;
            for y in (f32::from(bounds.top()) * scale) as u32
                ..(f32::from(bounds.bottom()) * scale) as u32
            {
                for x in (f32::from(bounds.left()) * scale) as u32
                    ..(f32::from(bounds.right()) * scale) as u32
                {
                    pixels += usize::from(before.get_pixel(x, y) != after.get_pixel(x, y));
                }
            }
            assert!(
                pixels > 0,
                "real native track/thumb pixels must change, not only label text"
            );
            cx.update(|cx| pane.update(cx, |p, cx| acknowledge(p, first, 2, cx)));
            cx.run_until_parked();
            match commands.try_recv().unwrap() {
                Command::Event { version, value, .. } => {
                    assert_eq!(version, 2);
                    assert_eq!(value, json!(100.));
                }
                _ => panic!("not the coalesced slider event"),
            };
            assert!(commands.try_recv().is_err());
            cx.update_window(handle, |_, window, cx| {
                window.render_frame(cx);
                assert_eq!(
                    pane.read(cx).sliders["0"].state.read(cx).value().end(),
                    100.,
                    "intermediate ack must not pull thumb backwards"
                );
            })
            .unwrap();
            cx.update(|cx| pane.update(cx, |p, cx| acknowledge(p, 100., 3, cx)));
            cx.run_until_parked();
            cx.update_window(handle, |_, window, cx| {
                window.render_frame(cx);
                let p = pane.read(cx);
                assert!(
                    !p.busy && p.slider_flow.flight.is_none() && p.slider_flow.queued.is_none()
                );
                assert_eq!(p.sliders["0"].state.read(cx).value().end(), 100.);
            })
            .unwrap();
            assert!(
                commands.try_recv().is_err(),
                "release/programmatic adoption must not resend"
            );
            if let Some(dir) = &captures {
                cx.capture_screenshot(handle)
                    .unwrap()
                    .save(dir.join(format!("{}-{}-slider.png", width as u32, mode.name())))
                    .unwrap();
            }
            println!(
                "{}",
                json!({"width":width,"mode":mode.name(),"native_pointer":true,"first":first,"latest":100,"happy_drag_commands":2,"pending_capacity":1,"changed_track_pixels":pixels,"faux_reader_only":true})
            );
            // The exact buttons remain usable; their callbacks are not drag-queued.
            cx.update_window(handle, |_, window, cx| window.click("0-minus", cx))
                .unwrap();
            cx.run_until_parked();
            assert!(
                matches!(commands.try_recv(),Ok(Command::Event{version:3,value,..})if value==json!(99.))
            );
            cx.update(|cx| pane.update(cx, |p, cx| acknowledge(p, 99., 4, cx)));
            cx.run_until_parked();
            cx.update_window(handle, |_, window, cx| {
                window.render_frame(cx);
                let b = mounted(&pane, window, cx);
                window.drag(
                    point(b.right() - px(1.), b.center().y),
                    point(b.left() + px(1.), b.center().y),
                    cx,
                );
            })
            .unwrap();
            cx.run_until_parked();
            assert!(matches!(
                commands.try_recv(),
                Ok(Command::Event { version: 4, .. })
            ));
            cx.update(|cx| {
                pane.update(cx, |p, cx| {
                    assert!(p.slider_flow.queued.is_some());
                    let mut failed = p.snapshot.clone();
                    failed.live = false;
                    failed.error = Some(crate::visual_runtime::Fault {
                        kind: "timeout",
                        message: "Synthetic callback timeout".into(),
                        line: None,
                        limit: None,
                    });
                    let expected = p.reference.clone().unwrap();
                    p.accept(p.generation, &expected, failed, cx);
                })
            });
            cx.run_until_parked();
            cx.update_window(handle, |_, window, cx| {
                window.render_frame(cx);
                let p = pane.read(cx);
                assert_eq!(p.sliders["0"].state.read(cx).value().end(), 99.);
                assert!(p.slider_flow.flight.is_none() && p.slider_flow.queued.is_none());
            })
            .unwrap();
            assert!(
                commands.try_recv().is_err(),
                "failed callback cannot flush input"
            );
            cx.update(|cx| pane.update(cx, |p, cx| acknowledge(p, 25., 5, cx)));
            cx.run_until_parked();
            let old_token = cx.update(|cx| pane.read(cx).sliders["0"].serial);
            cx.update_window(handle, |_, window, cx| {
                window.render_frame(cx);
                let b = mounted(&pane, window, cx);
                window.drag(
                    point(b.left() + b.size.width / 4., b.center().y),
                    point(b.left() + b.size.width * 0.75, b.center().y),
                    cx,
                );
            })
            .unwrap();
            cx.run_until_parked();
            assert!(matches!(
                commands.try_recv(),
                Ok(Command::Event { version: 5, .. })
            ));
            cx.update(|cx| {
                pane.update(cx, |p, cx| {
                    assert!(p.slider_flow.queued.is_some());
                    let mut replaced = p.snapshot.clone();
                    replaced.version = 6;
                    let mut root = (*scene(30.).root).clone();
                    root["max"] = json!(50);
                    root["label"] = json!("Changed range");
                    replaced.scene = Some(Arc::new(
                        crate::visual_scene::Scene::parse(json!({"api":1,"root":root})).unwrap(),
                    ));
                    let expected = p.reference.clone().unwrap();
                    p.accept(p.generation, &expected, replaced, cx);
                })
            });
            cx.run_until_parked();
            cx.update_window(handle, |_, window, cx| {
                window.render_frame(cx);
                let p = pane.read(cx);
                assert_ne!(p.sliders["0"].serial, old_token);
                assert_eq!(p.sliders["0"].state.read(cx).value().end(), 30.);
                assert!(!p.busy);
            })
            .unwrap();
            assert!(
                commands.try_recv().is_err(),
                "replacement range/key/label cannot receive old queued values"
            );
            cx.update(|cx| {
                pane.update(cx, |p, cx| {
                    p.slide(
                        SliderIntent {
                            generation: p.generation,
                            binding: old_token,
                            id: "0".into(),
                            value: 40.,
                        },
                        cx,
                    )
                })
            });
            assert!(commands.try_recv().is_err());
            cx.update_window(handle, |_, window, cx| {
                let b = mounted(&pane, window, cx);
                window.drag(
                    point(b.left() + b.size.width * 0.6, b.center().y),
                    point(b.right() - px(1.), b.center().y),
                    cx,
                );
            })
            .unwrap();
            cx.run_until_parked();
            assert!(matches!(
                commands.try_recv(),
                Ok(Command::Event { version: 6, .. })
            ));
            cx.update(|cx| {
                pane.update(cx, |p, _| {
                    assert!(p.slider_flow.queued.is_some());
                    p.close();
                    assert!(
                        p.sliders.is_empty()
                            && p.slider_flow.flight.is_none()
                            && p.slider_flow.queued.is_none()
                    );
                })
            });
            cx.update_window(handle, |_, window, cx| {
                window.render_frame(cx);
                assert!(window.find_all("0-slider").is_empty());
            })
            .unwrap();
            assert!(commands.try_recv().is_err());
            println!(
                "{}",
                json!({"width":width,"mode":mode.name(),"native_lifecycle":"exact-stepper-fault-rollback-replacement-stale-binding-close","faux_reader_only":true})
            );
            cx.update(|cx| pane.update(cx, |p, _| p.close()));
            cx.update_window(handle, |_, window, _| window.remove_window())
                .unwrap();
            cx.run_until_parked();
        }
    }
}
