//! Real native production viewer + pointer events; faux bounded reader channel.
//! No generated source execution, daemon, real data, canonical writes or visible window.
use super::*;
use gpui_kit::{
    Bounds, HeadlessAppContext, WindowBounds, WindowOptions,
    component::{Theme, ThemeMode},
    point, size,
    test::TestWindowExt,
};
use gpui_kit::{InputEvent, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent};
fn scene(value: f64) -> crate::visual_scene::Scene {
    crate::visual_scene::Scene::parse(json!({"api":1,"root":{"type":"slider","id":"0","label":"Load","unit":"%","min":0,"max":100,"step":1,"value":value}})).unwrap()
}
fn mounted(
    pane: &Entity<ArtifactPane>,
    window: &mut Window,
    cx: &gpui_kit::App,
) -> Bounds<gpui_kit::Pixels> {
    mounted_slider(pane, "0", window, cx)
}
fn mounted_slider(
    pane: &Entity<ArtifactPane>,
    id: &str,
    window: &mut Window,
    cx: &gpui_kit::App,
) -> Bounds<gpui_kit::Pixels> {
    let path = format!("{id}-slider");
    let outer = window.find(path.clone()).bounds();
    let thumb = window
        .within(path.clone())
        .find(("slider-thumb", 0u32))
        .bounds();
    assert!(
        thumb.left() >= outer.left() && thumb.right() <= outer.right(),
        "endpoint thumbs must not clip against the pane"
    );
    let entity = pane.read(cx).sliders[id].state.entity_id();
    window.within(path).find(("slider", entity)).bounds()
}
fn advance(cx: &HeadlessAppContext) {
    cx.run_until_parked();
    cx.advance_clock(crate::visual_slider::DRAG_INTERVAL);
    cx.run_until_parked();
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
fn pair(values: [f64; 2]) -> crate::visual_scene::Scene {
    let children:Vec<_>=values.into_iter().enumerate().map(|(i,value)|json!({"type":"slider","id":format!("0.{i}"),"label":format!("Synthetic {i}"),"min":0,"max":100,"step":1,"value":value})).collect();
    crate::visual_scene::Scene::parse(json!({"api":1,"root":{"type":"column","children":children}}))
        .unwrap()
}
fn fast_ack(
    cx: &mut HeadlessAppContext,
    pane: &Entity<ArtifactPane>,
    commands: &async_channel::Receiver<Command>,
) {
    if !commands.is_empty() {
        cx.update(|cx| fast_ack_in_app(cx, pane, commands));
    }
}
fn fast_ack_in_app(
    cx: &mut gpui_kit::App,
    pane: &Entity<ArtifactPane>,
    commands: &async_channel::Receiver<Command>,
) {
    if let Ok(command) = commands.try_recv() {
        let Command::Event { version, id, value } = command else {
            panic!("unexpected faux command")
        };
        pane.update(cx, |p, cx| {
            assert_eq!(version, p.snapshot.version);
            let scene = p.snapshot.scene.as_ref().unwrap();
            let mut values = [scene.sliders["0.0"].1, scene.sliders["0.1"].1];
            values[usize::from(id == "0.1")] = value.as_f64().unwrap();
            let mut next = p.snapshot.clone();
            next.version += 1;
            next.scene = Some(Arc::new(pair(values)));
            let reference = p.reference.clone().unwrap();
            p.accept(p.generation, &reference, next, cx);
        });
        assert!(
            commands.try_recv().is_err(),
            "instant ack must not release another command"
        );
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PacingFault {
    Unpaced,
    OldestQueued,
}
fn callback_rate_valid(samples: &VecDeque<(Instant, Instant, String)>) -> bool {
    samples.iter().zip(samples.iter().skip(1)).all(|(a, b)| {
        let (v, w) = (b.0 - a.0, b.1 - a.1);
        v >= crate::visual_slider::DRAG_INTERVAL && w >= std::time::Duration::from_millis(33)
    }) && samples.iter().all(|sample| {
        samples
            .iter()
            .filter(|s| s.1 >= sample.1 && s.1 < sample.1 + std::time::Duration::from_secs(1))
            .count()
            <= 30
    })
}
fn pending_latest_valid(p: &ArtifactPane, cx: &gpui_kit::App) -> bool {
    p.slider_flow.queued.as_ref().is_none_or(|q| {
        let binding = &p.sliders[&q.id];
        binding.state.read(cx).value().end() == binding.grid.position(q.value)
            && p.slider_wake.is_some()
    })
}
fn pacing_probe(
    cx: &mut HeadlessAppContext,
    width: f32,
    mode: ThemeMode,
    fault: Option<PacingFault>,
) {
    let (worker, commands) = Worker::synthetic();
    // The full LocalViewer lifecycle/pixel matrix runs separately above. Its
    // transcript redraw on every GPUI test update can throttle raw input below
    // the budget under test. Mount the same production ArtifactPane directly
    // for cadence, without changing dependencies or bypassing native drawing.
    let (handle, pane) = cx.update(|cx| {
        gpui_kit::open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                    point(px(0.), px(0.)),
                    size(px(width), px(500.)),
                ))),
                show: false,
                focus: false,
                ..Default::default()
            },
            cx,
            |_, cx| {
                cx.new(|cx| {
                    let mut p = ArtifactPane::new();
                    let reference = Reference {
                        id: "synthetic-cadence".into(),
                        session: "synthetic".into(),
                        revision: 1,
                        title: "Synthetic pacing".into(),
                        kind: "visual".into(),
                    };
                    p.preview(
                        reference,
                        "Synthetic values only; no source execution".into(),
                        pair([0., 0.]),
                        cx,
                    );
                    p.worker = Some(worker);
                    p.snapshot.live = true;
                    p.snapshot.state = Some("[]".into());
                    p.slider_dispatches.clear();
                    p
                })
            },
        )
        .unwrap()
    });
    advance(cx);
    let bounds = cx
        .update_window(handle, |_, window, cx| {
            window.render_frame(cx);
            [
                mounted_slider(&pane, "0.0", window, cx),
                mounted_slider(&pane, "0.1", window, cx),
            ]
        })
        .unwrap();
    let mut previous = point(bounds[0].left() + px(1.), bounds[0].center().y);
    let mut active = 0;
    let mut input_times = Vec::new();
    let mut latest_was_valid = true;
    const INPUTS_PER_TICK: usize = 4;
    for tick in 0..120 {
        // TestDispatcher time is virtual. Advance only 8ms after at least 8ms
        // actual waiting, never catch up render time or run the virtual clock
        // faster than wall time. Capture both clocks at production enqueue.
        std::thread::sleep(std::time::Duration::from_millis(8));
        cx.advance_clock(std::time::Duration::from_millis(8));
        cx.run_until_parked();
        fast_ack(cx, &pane, &commands);
        let old_queue = if fault == Some(PacingFault::OldestQueued) {
            cx.update(|cx| pane.read(cx).slider_flow.queued.clone())
        } else {
            None
        };
        if fault == Some(PacingFault::Unpaced) {
            // Test-instance mutation only: erase the private rate gate through
            // Default, preserving flight/latest. No production hook or limit edit.
            cx.update(|cx| {
                pane.update(cx, |p, _| {
                    let flight = p.slider_flow.flight.take();
                    let queued = p.slider_flow.queued.take();
                    p.slider_flow = Default::default();
                    p.slider_flow.flight = flight;
                    p.slider_flow.queued = queued;
                });
            });
        }
        let index = usize::from((tick / 30) % 2 != 0);
        cx.update_window(handle, |_, window, cx| {
            // Raw native input can outpace drawing. Rendering every move would
            // throttle the stress test itself instead of exercising the gate.
            if tick % 15 == 0 {
                window.render_frame(cx);
            }
            let b = mounted_slider(&pane, &format!("0.{index}"), window, cx);
            if tick == 0 || index != active {
                if tick != 0 {
                    window.dispatch_event(
                        MouseUpEvent {
                            button: MouseButton::Left,
                            position: previous,
                            modifiers: Default::default(),
                            click_count: 1,
                        }
                        .to_platform_input(),
                        cx,
                    );
                }
                previous = point(b.left() + px(1.), b.center().y);
                window.dispatch_event(
                    MouseDownEvent {
                        button: MouseButton::Left,
                        position: previous,
                        modifiers: Default::default(),
                        click_count: 1,
                        first_mouse: false,
                    }
                    .to_platform_input(),
                    cx,
                );
            }
            // HeadlessAppContext flushes/draws after every App update, even
            // without render_frame. A slow readback must not serialize raw
            // input behind a GPU frame. Deliver a bounded native event burst
            // with an immediate real production-pane ack after EACH event.
            // Time still advances only once per conservative wall-paced tick.
            for input in tick * INPUTS_PER_TICK..(tick + 1) * INPUTS_PER_TICK {
                let t = if (input / 15) % 2 == 0 {
                    0.25 + (input % 15) as f32 / 30.
                } else {
                    0.75 - (input % 15) as f32 / 30.
                };
                previous = point(b.left() + b.size.width * t, b.center().y);
                input_times.push(Instant::now());
                window.dispatch_event(
                    MouseMoveEvent {
                        position: previous,
                        pressed_button: Some(MouseButton::Left),
                        modifiers: Default::default(),
                    }
                    .to_platform_input(),
                    cx,
                );
                fast_ack_in_app(cx, &pane, &commands);
            }
        })
        .unwrap();
        active = index;
        cx.run_until_parked();
        if let Some(old) = old_queue {
            cx.update(|cx| {
                pane.update(cx, |p, _| {
                    if p.slider_flow.queued.as_ref().is_some_and(|q| {
                        q.id == old.id && q.binding == old.binding && q.generation == old.generation
                    }) {
                        // Deliberate keep-oldest coalescer defect in this probe
                        // instance; the shared latest/thumb oracle must reject it.
                        p.slider_flow.queued = Some(old);
                    }
                });
            });
            latest_was_valid &= cx.update(|cx| pending_latest_valid(pane.read(cx), cx));
        }
        fast_ack(cx, &pane, &commands);
        cx.update(|cx| {
            let p = pane.read(cx);
            let valid = pending_latest_valid(p, cx);
            latest_was_valid &= valid;
            if fault.is_none() {
                assert!(valid, "pending ack must not regress thumb or lose its wake");
            }
        });
    }
    cx.update_window(handle, |_, window, cx| {
        window.dispatch_event(
            MouseUpEvent {
                button: MouseButton::Left,
                position: previous,
                modifiers: Default::default(),
                click_count: 1,
            }
            .to_platform_input(),
            cx,
        );
        window.render_frame(cx);
    })
    .unwrap();
    // Flush the last latest intent with the same conservative real/virtual wait.
    std::thread::sleep(crate::visual_slider::DRAG_INTERVAL);
    advance(cx);
    fast_ack(cx, &pane, &commands);
    cx.update(|cx| {
        let p=pane.read(cx);let samples=&p.slider_dispatches;
        if let Some(fault) = fault {
            match fault {
                PacingFault::Unpaced => assert!(!callback_rate_valid(samples), "negative control: disabled pacer was not detected"),
                PacingFault::OldestQueued => assert!(!latest_was_valid, "negative control: broken latest coalescing was not detected"),
            }
            println!("{}", json!({"negative_control":format!("{fault:?}"),"rejected_by_shared_oracle":true,"enqueue_count":samples.len(),"pointer_input_count":input_times.len(),"faux_reader_only":true}));
            return;
        }
        let fast_inputs=input_times.windows(2).filter(|s|s[1]-s[0]<std::time::Duration::from_millis(25)).count();
        let input_window_max=input_times.iter().map(|&at|input_times.iter().filter(|&&t|t>=at&&t<at+std::time::Duration::from_secs(1)).count()).max().unwrap();
        assert!(fast_inputs>=90*INPUTS_PER_TICK&&input_window_max>30,"native input must actually outpace callback budget: {fast_inputs} fast gaps, {input_window_max} inputs/second");
        assert!(samples.len()>=15&&samples.len()<=31,"bounded continuous native fast-ack sample count: {}",samples.len());
        assert!(samples.iter().any(|s|s.2=="0.0")&&samples.iter().any(|s|s.2=="0.1"));
        let mut min_virtual=std::time::Duration::MAX;let mut min_wall=min_virtual;
        for (a,b) in samples.iter().zip(samples.iter().skip(1)) {
            let (v,w)=(b.0-a.0,b.1-a.1);min_virtual=min_virtual.min(v);min_wall=min_wall.min(w);
            assert!(v>=crate::visual_slider::DRAG_INTERVAL,"virtual dispatch gap {v:?}");
            assert!(w>=std::time::Duration::from_millis(33),"actual enqueue gap {w:?}; 1ms observation tolerance");
        }
        for sample in samples {assert!(samples.iter().filter(|s|s.1>=sample.1&&s.1<sample.1+std::time::Duration::from_secs(1)).count()<=30);}
        assert!(callback_rate_valid(samples), "shared callback-rate oracle");
        assert!(latest_was_valid, "shared latest/thumb oracle");
        assert!(p.slider_wake.is_none()&&p.slider_flow.queued.is_none()&&p.slider_flow.flight.is_none());
        println!("{}",json!({"width":width,"mode":mode.name(),"continuous_native_pointer":true,"cross_slider_fast_ack":true,"enqueue_count":samples.len(),"pointer_input_count":input_times.len(),"inputs_per_native_update":INPUTS_PER_TICK,"fast_input_gaps_under25ms":fast_inputs,"max_inputs_in_one_actual_second":input_window_max,"virtual_gap_min_ms":min_virtual.as_secs_f64()*1000.,"wall_gap_min_ms":min_wall.as_secs_f64()*1000.,"clock":"conservative wall-paced TestDispatcher","wall_tolerance_ms":1,"faux_reader_only":true}));
    });
    cx.update(|cx| {
        pane.update(cx, |p, _| {
            p.close();
            assert!(
                p.slider_wake.is_none()
                    && p.slider_flow.queued.is_none()
                    && p.slider_flow.flight.is_none(),
                "normal and negative-control fixtures must both clean up"
            );
        });
    });
    cx.update_window(handle, |_, window, _| window.remove_window())
        .unwrap();
    cx.run_until_parked();
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
            advance(cx);
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
            // Return to canonical during the cooldown must withdraw unsent
            // input, not leave a timer which later jumps away from the thumb.
            cx.update_window(handle, |_, window, cx| {
                window.drag(
                    point(bounds.right() - px(1.), bounds.center().y),
                    point(bounds.left() + bounds.size.width * 0.4, bounds.center().y),
                    cx,
                );
                window.drag(
                    point(bounds.left() + bounds.size.width * 0.4, bounds.center().y),
                    point(bounds.right() - px(1.), bounds.center().y),
                    cx,
                );
            })
            .unwrap();
            cx.run_until_parked();
            cx.update(|cx| {
                let p = pane.read(cx);
                assert!(p.slider_wake.is_none() && p.slider_flow.queued.is_none());
            });
            advance(cx);
            assert!(
                commands.try_recv().is_err(),
                "canonical return must not send after cooldown"
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
            advance(cx);
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
            advance(cx);
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
            advance(cx);
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
            advance(cx);
            assert!(
                commands.try_recv().is_err(),
                "closed pane cancels the drag deadline"
            );
            println!(
                "{}",
                json!({"width":width,"mode":mode.name(),"native_lifecycle":"exact-stepper-fault-rollback-replacement-stale-binding-close","faux_reader_only":true})
            );
            cx.update(|cx| pane.update(cx, |p, _| p.close()));
            cx.update_window(handle, |_, window, _| window.remove_window())
                .unwrap();
            cx.run_until_parked();
            pacing_probe(cx, width, mode, None);
        }
    }
    cx.update(|cx| Theme::change(ThemeMode::Light, None, cx));
    for fault in [PacingFault::Unpaced, PacingFault::OldestQueued] {
        pacing_probe(cx, 680., ThemeMode::Light, Some(fault));
    }
}
