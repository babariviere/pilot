//! Native production chrome with synthetic content and a test-only visibility
//! lease. This is not native OS occlusion or visible-window performance evidence.
use super::{LocalViewer, PreviewState};
use crate::{dither::Signal, dither_view, local_model::Chat};
use gpui_kit::{
    AppContext, Bounds, HeadlessAppContext, WindowBounds, WindowOptions,
    component::{Theme, ThemeMode},
    px, size,
    test::TestWindowExt,
};
use serde_json::json;
use std::{sync::Arc, time::Duration};

fn pulse(cx: &mut HeadlessAppContext, handle: gpui_kit::AnyWindowHandle, count: usize, ms: u64) {
    for _ in 0..count {
        cx.advance_clock(Duration::from_millis(ms));
        cx.run_until_parked();
        cx.update_window(handle, |_, window, cx| window.draw(cx).clear(cx))
            .unwrap();
    }
}
fn snapshot(
    view: &gpui_kit::Entity<LocalViewer>,
    id: &str,
    cx: &gpui_kit::App,
) -> crate::dither::Snapshot {
    view.read(cx).chats.read(cx).delegate().corners[id]
        .read(cx)
        .probe(cx)
        .0
}

pub fn run_style_probe(cx: &mut HeadlessAppContext) {
    let captures = std::env::var_os("PILOT_NEXT_STYLE_DIR").map(std::path::PathBuf::from);
    if let Some(dir) = &captures {
        std::fs::create_dir_all(dir).unwrap();
    }
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            cx.update(|cx| Theme::change(mode, None, cx));
            let (handle, view) = cx.update(|cx| {
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
                    |window, cx| {
                        dither_view::probe_visible(true, window, cx);
                        cx.new(|cx| {
                            let mut view =
                                LocalViewer::preview(PreviewState::Conversation, window, cx);
                            view.state.chats = Arc::new(
                                [
                                    ("style-fg", "Working", Some(Signal::Working), false),
                                    ("style-bg", "Background jobs", Some(Signal::Working), true),
                                    ("style-needs", "Needs you", Some(Signal::NeedsYou), false),
                                    ("style-failed", "Failed", Some(Signal::Failed), false),
                                    ("style-ready", "Ready to merge", Some(Signal::Ready), false),
                                    ("style-idle", "Quiet", None, false),
                                ]
                                .into_iter()
                                .map(|(id, title, signal, background_work)| Chat {
                                    context_usage: Default::default(),
                                    id: id.into(),
                                    title: title.into(),
                                    state: title.into(),
                                    archived: false,
                                    local_draft: false,
                                    writable: false,
                                    busy: signal == Some(Signal::Working),
                                    signal,
                                    background_work,
                                    cwd: String::new(),
                                    project_id: None,
                                    model_configuration: None,
                                    attention: None,
                                })
                                .collect(),
                            );
                            view.selected = Some("style-idle".into());
                            view.title = "Rounded surfaces and status motion".into();
                            view.editor.update(cx, |v, cx| {
                                v.select("chat:style-idle".into(), false, false, window, cx)
                            });
                            view.rebuild_nav(window, cx);
                            view
                        })
                    },
                )
                .unwrap()
            });
            cx.run_until_parked();
            assert!(cx.update(|cx| view.read(cx).text_parsers_ready(cx)));
            let initial = cx
                .capture_screenshot(handle)
                .expect("native renderer required");
            let (baseline, rects, static_counts) = cx
                .update_window(handle, |_, window, cx| {
                    window.render_frame(cx);
                    let v = view.read(cx);
                    let list = v.chats.read(cx).delegate();
                    let rects = [
                        "style-fg",
                        "style-bg",
                        "style-needs",
                        "style-failed",
                        "style-ready",
                    ]
                    .map(|id| window.find(id).bounds());
                    let counts = ["style-failed", "style-ready"]
                        .map(|id| list.corners[id].read(cx).probe(cx).1);
                    (v.transcript.read(cx).probe_render_count(), rects, counts)
                })
                .unwrap();
            let mut trace = Vec::new();
            for frame in 0..12 {
                cx.advance_clock(Duration::from_millis(84));
                cx.run_until_parked();
                trace.push(cx.update_window(handle,|_,window,cx|{
    window.draw(cx).clear(cx);let v=view.read(cx);let list=v.chats.read(cx).delegate();
    let snapshot=list.corners["style-bg"].read(cx).probe(cx).0;
    let (ticks,members,running)=dither_view::probe_clock(window,cx);
    assert_eq!(v.transcript.read(cx).probe_render_count(),baseline,"dither must not re-render the cached transcript");
    for (id,count) in ["style-failed","style-ready"].into_iter().zip(static_counts) {assert_eq!(list.corners[id].read(cx).probe(cx).1,count,"nonmoving status must not be notified");}
    json!({"frame":frame,"phase":snapshot.frame,"ticks":ticks,"members":members,"running":running,"root_renders":v.render_count,"transcript_renders":v.transcript.read(cx).probe_render_count()})
   }).unwrap());
            }
            let after = cx.capture_screenshot(handle).unwrap();
            let scale = initial.width() as f32 / width;
            let mut changes = Vec::new();
            for rect in rects {
                let mut changed = 0;
                for y in (f32::from(rect.top()) * scale) as u32
                    ..(f32::from(rect.bottom()) * scale) as u32
                {
                    for x in (f32::from(rect.left()) * scale) as u32
                        ..(f32::from(rect.right()) * scale) as u32
                    {
                        changed += usize::from(initial.get_pixel(x, y) != after.get_pixel(x, y));
                    }
                }
                changes.push(changed);
            }
            assert!(
                changes[..3].iter().all(|n| *n > 0),
                "native working/background/needs-you pixels must actually animate: {changes:?}"
            );
            assert_eq!(&changes[3..], &[0, 0], "failed/ready must stay still");
            println!(
                "{}",
                json!({"width":width,"mode":mode.name(),"samples":trace,"changed_pixels":changes,"native_production_root":true})
            );
            if let Some(dir) = &captures {
                initial
                    .save(dir.join(format!("{}-{}-start.png", width as u32, mode.name())))
                    .unwrap();
                after
                    .save(dir.join(format!("{}-{}-loop.png", width as u32, mode.name())))
                    .unwrap();
            }
            // Geometry and hover: the decoration must not move/resize its host.
            let tray = cx
                .update_window(handle, |_, window, _| window.find("composer-tray").bounds())
                .unwrap();
            let sample = |x: f32, y: f32| after.get_pixel((x * scale) as u32, (y * scale) as u32).0;
            let (input, controls, stop, send) = cx
                .update_window(handle, |_, window, _| {
                    (
                        window.find("composer-input").bounds(),
                        window.find("composer-controls").bounds(),
                        window.find("composer-stop-slot").bounds(),
                        window.find("local-send").bounds(),
                    )
                })
                .unwrap();
            assert_eq!(
                tray.size.height,
                px(76.),
                "contrast must not enlarge the tray"
            );
            assert_eq!(
                input.size.height,
                px(34.),
                "contrast must not enlarge the editor"
            );
            assert_eq!(input.bottom(), controls.top());
            for rect in [input, controls, stop, send] {
                assert!(
                    rect.left() >= tray.left() && rect.right() <= tray.right(),
                    "control must not clip: {rect:?} vs {tray:?}"
                );
                assert!(rect.top() >= tray.top() && rect.bottom() <= tray.bottom());
            }
            assert_eq!(stop.center().y, send.center().y);
            let (card, tray_color) = cx.update(|cx| {
                let rgba = |color: gpui_kit::Hsla| {
                    let color: gpui_kit::Rgba = color.into();
                    [color.r, color.g, color.b, color.a]
                        .map(|channel| (channel * 255.).round() as u8)
                };
                (
                    rgba(crate::appearance::card(cx)),
                    rgba(crate::appearance::tray(cx)),
                )
            });
            let editor_pixel = sample(f32::from(input.left()) + 16., f32::from(input.top()) + 2.);
            let tray_pixel = sample(
                f32::from(controls.left()) + 16.,
                f32::from(controls.top()) + 2.,
            );
            assert_eq!(
                editor_pixel, card,
                "opaque editor must paint semantic card, not tray"
            );
            assert_eq!(
                tray_pixel, tray_color,
                "controls retain the soft tray surface"
            );
            assert_ne!(
                editor_pixel, tray_pixel,
                "compact spacing must not flatten editor/tray contrast"
            );
            println!(
                "{}",
                json!({"composer_width":width,"mode":mode.name(),"tray_height":f32::from(tray.size.height),"input_height":f32::from(input.size.height),"editor_rgba":editor_pixel,"tray_rgba":tray_pixel,"send_stop_one_row":true,"controls_contained":true,"native_production_root":true})
            );
            let outside = sample(f32::from(tray.left()) + 0.5, f32::from(tray.top()) + 0.5);
            let top = sample(f32::from(tray.left()) + 24., f32::from(tray.top()) + 2.);
            assert_ne!(
                outside, top,
                "the composer tray must actually paint a rounded, inset surface"
            );
            cx.update_window(handle, |_, window, cx| window.hover("style-fg", cx))
                .unwrap();
            cx.run_until_parked();
            pulse(cx, handle, 3, 50);
            let hover_mid = cx.update(|cx| snapshot(&view, "style-fg", cx));
            assert!(hover_mid.recede > 0.5 && hover_mid.recede < 1. && hover_mid.fast);
            pulse(cx, handle, 3, 50);
            let hover_end = cx.update(|cx| snapshot(&view, "style-fg", cx));
            assert_eq!(hover_end.recede, 1.);
            assert!(hover_end.ticking && !hover_end.fast);
            let rect = cx
                .update_window(handle, |_, window, _| window.find("style-fg").bounds())
                .unwrap();
            assert_eq!(rect, rects[0]);
            let hovered = cx.capture_screenshot(handle).unwrap();
            let x = ((f32::from(rect.left()) + 1.) * scale) as u32;
            let y = (f32::from(rect.center().y) * scale) as u32;
            assert_eq!(
                initial.get_pixel(x, y),
                hovered.get_pixel(x, y),
                "a dither row recedes without adding a hover fill"
            );
            if let Some(dir) = &captures {
                cx.capture_screenshot(handle)
                    .unwrap()
                    .save(dir.join(format!("{}-{}-hover.png", width as u32, mode.name())))
                    .unwrap();
            }
            cx.update_window(handle, |_, window, cx| window.hover("new-local-chat", cx))
                .unwrap();
            pulse(cx, handle, 6, 50);

            // A live signal changes in place and settles; it must leave the clock.
            cx.update_window(handle, |_, window, cx| {
                view.update(cx, |v, cx| {
                    let chats = Arc::make_mut(&mut v.state.chats);
                    chats[0].signal = Some(Signal::Failed);
                    chats[0].busy = false;
                    v.rebuild_nav(window, cx);
                })
            })
            .unwrap();
            cx.run_until_parked();
            cx.update_window(handle, |_, window, cx| window.draw(cx).clear(cx))
                .unwrap();
            let changed = cx.update(|cx| snapshot(&view, "style-fg", cx));
            assert!(changed.mix < 1. && changed.fast);
            pulse(cx, handle, 6, 50);
            let dissolve_mid = cx.update(|cx| snapshot(&view, "style-fg", cx));
            assert!((dissolve_mid.mix - 0.5).abs() < 0.02);
            pulse(cx, handle, 6, 50);
            let settled = cx.update(|cx| snapshot(&view, "style-fg", cx));
            assert_eq!(settled.mix, 1.);
            assert!(!settled.ticking);
            // A deadline may have one already-scheduled final clock packet.
            pulse(cx, handle, 1, 34);
            let (_, members, _) = cx
                .update_window(handle, |_, window, cx| dither_view::probe_clock(window, cx))
                .unwrap();
            assert_eq!(members, 2);

            // Filtered/unmounted corners retain models but lose their paint leases.
            cx.update_window(handle, |_, _, cx| {
                let chats = view.read(cx).chats.clone();
                chats.update(cx, |list, cx| {
                    let d = list.delegate_mut();
                    d.query = "quiet".into();
                    d.filter();
                    cx.notify();
                });
            })
            .unwrap();
            pulse(cx, handle, 3, 84);
            let offscreen = cx
                .update_window(handle, |_, window, cx| dither_view::probe_clock(window, cx))
                .unwrap();
            assert_eq!((offscreen.1, offscreen.2), (0, false));
            pulse(cx, handle, 12, 84);
            assert_eq!(
                cx.update_window(handle, |_, window, cx| dither_view::probe_clock(window, cx))
                    .unwrap(),
                offscreen,
                "unmounted retained corners cannot keep ticking"
            );
            cx.update_window(handle, |_, _, cx| {
                let chats = view.read(cx).chats.clone();
                chats.update(cx, |list, cx| {
                    let d = list.delegate_mut();
                    d.query.clear();
                    d.filter();
                    cx.notify();
                });
            })
            .unwrap();
            pulse(cx, handle, 1, 84);
            assert_eq!(
                cx.update_window(handle, |_, window, cx| dither_view::probe_clock(window, cx)
                    .1)
                    .unwrap(),
                2
            );

            // Reduce Motion is still, including immediate hover recession.
            cx.update(|cx| cx.set_reduce_motion(true));
            pulse(cx, handle, 2, 84);
            let reduced = cx
                .update_window(handle, |_, window, cx| dither_view::probe_clock(window, cx))
                .unwrap();
            assert_eq!((reduced.1, reduced.2), (0, false));
            cx.update_window(handle, |_, window, cx| window.hover("style-bg", cx))
                .unwrap();
            cx.run_until_parked();
            let still = cx.update(|cx| snapshot(&view, "style-bg", cx));
            assert_eq!((still.frame, still.recede, still.ticking), (0, 1., false));
            pulse(cx, handle, 12, 84);
            assert_eq!(
                cx.update_window(handle, |_, window, cx| dither_view::probe_clock(window, cx))
                    .unwrap(),
                reduced
            );
            cx.update(|cx| cx.set_reduce_motion(false));
            pulse(cx, handle, 1, 84);
            assert_eq!(
                cx.update_window(handle, |_, window, cx| dither_view::probe_clock(window, cx)
                    .1)
                    .unwrap(),
                2
            );

            // Test-only visibility override; same cancellation path as the native observer.
            cx.update_window(handle, |_, window, cx| {
                dither_view::probe_visible(false, window, cx)
            })
            .unwrap();
            let hidden = cx
                .update_window(handle, |_, window, cx| dither_view::probe_clock(window, cx))
                .unwrap();
            pulse(cx, handle, 12, 84);
            assert_eq!(
                cx.update_window(handle, |_, window, cx| dither_view::probe_clock(window, cx))
                    .unwrap(),
                hidden
            );
            assert_eq!((hidden.1, hidden.2), (0, false));
            cx.update_window(handle, |_, window, cx| {
                dither_view::probe_visible(true, window, cx)
            })
            .unwrap();
            pulse(cx, handle, 1, 84);
            assert_eq!(
                cx.update_window(handle, |_, window, cx| dither_view::probe_clock(window, cx)
                    .1)
                    .unwrap(),
                2
            );
            println!(
                "{}",
                json!({"width":width,"mode":mode.name(),"lifecycle":"hover300-dissolve600-offscreen-reduced-motion-hidden-resume","hover_mid":hover_mid.recede,"mix_mid":dissolve_mid.mix,"offscreen_clock":offscreen,"hidden_clock":hidden,"native_production_root":true,"visibility_simulated_for_headless":true})
            );
            if width == 1100. && mode == ThemeMode::Dark {
                for background in [false, true] {
                    cx.update(|cx| {
                        let editor = view.read(cx).editor.clone();
                        editor.update(cx, |v, cx| {
                            v.permission(false, true, cx);
                            v.background(background, cx);
                        });
                    });
                    // A state fade alone is not evidence of a settled work loop.
                    pulse(cx, handle, 9, 84);
                    let before = cx.capture_screenshot(handle).unwrap();
                    pulse(cx, handle, 12, 84);
                    let after = cx.capture_screenshot(handle).unwrap();
                    let (tray, editor) = cx
                        .update_window(handle, |_, window, _| {
                            (
                                window.find("composer-tray").bounds(),
                                window.find("composer-input").bounds(),
                            )
                        })
                        .unwrap();
                    // A blank interior strip must stay opaque while the working
                    // corner changes underneath. Avoid text and rounded edges.
                    let y = ((f32::from(editor.top()) + 2.) * scale) as u32;
                    for x in ((f32::from(editor.left()) + 16.) * scale) as u32
                        ..((f32::from(editor.right()) - 16.) * scale) as u32
                    {
                        assert_eq!(
                            before.get_pixel(x, y).0,
                            card,
                            "working dither must not bleed through editor"
                        );
                        assert_eq!(
                            after.get_pixel(x, y).0,
                            card,
                            "editor backing must remain opaque after dither ticks"
                        );
                    }
                    let mut pixels = 0;
                    for y in (f32::from(tray.top()) * scale) as u32
                        ..(f32::from(tray.bottom()) * scale) as u32
                    {
                        for x in (f32::from(tray.left()) * scale) as u32
                            ..(f32::from(tray.right()) * scale) as u32
                        {
                            pixels += usize::from(before.get_pixel(x, y) != after.get_pixel(x, y));
                        }
                    }
                    assert!(
                        pixels > 0,
                        "settled composer work must visibly loop beside opaque editor/controls"
                    );
                    println!(
                        "{}",
                        json!({"composer_background":background,"settled_changed_pixels":pixels,"width":width,"mode":mode.name()})
                    );
                    if let Some(dir) = &captures {
                        after
                            .save(dir.join(format!(
                                "1100-dark-composer-{}.png",
                                if background { "background" } else { "working" }
                            )))
                            .unwrap();
                    }
                }
            }
            cx.update_window(handle, |_, window, _| window.remove_window())
                .unwrap();
            cx.run_until_parked();
        }
    }
    run_large_motion(cx);
}

fn run_large_motion(cx: &mut HeadlessAppContext) {
    let mut source_bytes = 0;
    let (handle,view)=cx.update(|cx|gpui_kit::open_window(WindowOptions{
        window_bounds:Some(WindowBounds::Windowed(Bounds::new(Default::default(),size(px(1100.),px(760.))))),
        show:false,focus:false,..Default::default()
    },cx,|window,cx|{
        dither_view::probe_visible(true,window,cx);
        cx.new(|cx|{
            let mut v=LocalViewer::synthetic(window,cx);
            Arc::make_mut(&mut v.state.chats)[0].signal=Some(Signal::Working);
            let rows=(0..512).map(|i|{
                let text=format!("### Synthetic history {i}\n\n{}", "Bounded synthetic text, selection and copying remain unchanged.\n\n".repeat(24));
                source_bytes+=text.len();crate::model::Message::live(2_000_000+i,"Assistant".into(),text)
            }).collect();
            v.transcript.update(cx,|v,cx|v.replace_readonly(rows,true,cx));v.rebuild_nav(window,cx);v
        })
    }).unwrap());
    cx.run_until_parked();
    cx.update_window(handle, |_, window, cx| window.render_frame(cx))
        .unwrap();
    let baseline = cx.update(|cx| view.read(cx).transcript.read(cx).probe_render_count());
    let start = cx
        .update_window(handle, |_, window, cx| dither_view::probe_clock(window, cx))
        .unwrap();
    assert!(start.1 > 0);
    pulse(cx, handle, 12, 84);
    let count = cx.update(|cx| view.read(cx).transcript.read(cx).probe_render_count());
    assert_eq!(
        count, baseline,
        "large retained history must not re-render on dither ticks"
    );
    let end = cx
        .update_window(handle, |_, window, cx| dither_view::probe_clock(window, cx))
        .unwrap();
    assert!((1..=12).contains(&(end.0 - start.0)));
    assert_eq!(dither_view::probe_atlas_bytes(), 1_184_352);
    println!(
        "{}",
        json!({"large_history_rows":512,"source_bytes":source_bytes,"transcript_renders_during_ticks":count-baseline,"clock_ticks":end.0-start.0,"members":end.1,"atlas_bytes":dither_view::probe_atlas_bytes()})
    );
    cx.update_window(handle, |_, window, _| window.remove_window())
        .unwrap();
    cx.run_until_parked();
}
