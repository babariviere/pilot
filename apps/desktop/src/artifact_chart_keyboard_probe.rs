//! Production chart arm in ArtifactPane beside a real text input: actual Tab focus,
//! arrow keys, pointer coexistence, Escape/blur and IME/selection. Synthetic only.
use super::*;
use gpui_kit::{
    AnyWindowHandle, Bounds, EntityInputHandler, Focusable, HeadlessAppContext, InputEvent,
    ScrollDelta, WindowBounds, WindowOptions,
    component::input::{Input, InputState},
    point, size,
    test::{TestEventExt, TestWindowExt},
};
use std::time::Duration;

fn scene() -> crate::visual_scene::Scene {
    crate::visual_scene::Scene::parse(json!({"api":1,"root":{"type":"column","gap":12,"children":[
        {"type":"chart","kind":"bar","height":160,"yLabel":"Units","x":["North","South","West","East"],
         "series":[{"name":"Observed","values":[4,7,null,null]},{"name":"Forecast","values":[6,null,8,null]}]},
        {"type":"chart","kind":"scatter","height":140,"x":[100,-5,2],"series":[{"name":"Samples","values":[1,2,3]}]}
    ]}}))
    .unwrap()
}
struct Host {
    input: Entity<InputState>,
    pane: Entity<ArtifactPane>,
}
impl Render for Host {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .v_flex()
            .size_full()
            .gap_2()
            .child(Input::new(&self.input))
            .child(self.pane.clone())
    }
}
fn frame(cx: &mut HeadlessAppContext, h: AnyWindowHandle) {
    cx.advance_clock(Duration::from_millis(16));
    cx.run_until_parked();
    cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
}
fn readout(cx: &mut HeadlessAppContext, pane: &Entity<ArtifactPane>) -> Option<(String, String)> {
    cx.update(|cx| pane.read(cx).probe_chart_readout())
        .map(|(path, r)| (path, r.label))
}
fn shown(path: &str, label: &str) -> Option<(String, String)> {
    Some((path.into(), label.into()))
}
fn point_at(cx: &mut HeadlessAppContext, h: AnyWindowHandle, scope: &'static str, at: f32) {
    cx.update_window(h, |_, w, cx| {
        let b = w.within(scope).find("chart-plot").bounds();
        let x = b.left() + px(12.) + (b.size.width - px(24.)) * at;
        w.pointer_move(point(x, b.center().y), None, cx);
    })
    .unwrap();
    frame(cx, h);
}
fn leave(cx: &mut HeadlessAppContext, h: AnyWindowHandle) {
    cx.update_window(h, |_, w, cx| {
        w.pointer_move(point(px(2.), px(2.)), None, cx)
    })
    .unwrap();
    frame(cx, h);
}
fn press(cx: &mut HeadlessAppContext, h: AnyWindowHandle, key: &str) {
    cx.update_window(h, |_, w, cx| w.press(key, cx)).unwrap();
    frame(cx, h);
}
fn plot_focused(cx: &mut HeadlessAppContext, h: AnyWindowHandle, scope: &'static str) -> bool {
    cx.update_window(h, |_, w, _| {
        w.within(scope)
            .try_find("chart-plot")
            .and_then(|p| p.focused())
            == Some(true)
    })
    .unwrap()
}
/// Tabs forward (actual focus traversal) until the plot in `scope` has focus.
fn tab_to(cx: &mut HeadlessAppContext, h: AnyWindowHandle, scope: &'static str) {
    for _ in 0..40 {
        if plot_focused(cx, h, scope) {
            return;
        }
        cx.update_window(h, |_, w, cx| w.focus_next(cx)).unwrap();
        frame(cx, h);
    }
    panic!("Tab never reached the {scope} plot");
}
/// The readout card is drawn inside the window and the chart's plot.
fn card_visible(cx: &mut HeadlessAppContext, h: AnyWindowHandle, scope: &'static str, width: f32) {
    cx.update_window(h, |_, w, _| {
        let card = w.within(scope).find("chart-readout").bounds();
        let plot = w.within(scope).find("chart-plot").bounds();
        assert!(
            card.left() >= px(0.) && card.right() <= px(width),
            "{card:?}"
        );
        assert!(
            card.top() >= plot.top() && card.left() >= plot.left() && card.right() <= plot.right(),
            "{card:?} {plot:?}"
        );
    })
    .unwrap();
}
pub fn run_chart_keyboard_probe(cx: &mut HeadlessAppContext) {
    let captures = std::env::var_os("PILOT_NEXT_IMAGE_DIR").map(std::path::PathBuf::from);
    if let Some(dir) = &captures {
        std::fs::create_dir_all(dir).unwrap();
    }
    for width in [520., 1100.] {
        for dark in [false, true] {
            for inline in [false, true] {
                cx.update(|cx| {
                    crate::appearance::commit_appearance(
                        if dark {
                            crate::settings_state::AppearancePreference::Dark
                        } else {
                            crate::settings_state::AppearancePreference::Light
                        },
                        cx,
                    )
                });
                let reference = Reference {
                    id: "chart-keyboard".into(),
                    session: "synthetic".into(),
                    title: "Regional units".into(),
                    kind: "visual".into(),
                    revision: 1,
                };
                let (h, host) = cx.update(|cx| {
                    let reference = reference.clone();
                    gpui_kit::open_window(
                        WindowOptions {
                            window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                                Default::default(),
                                size(px(width), px(820.)),
                            ))),
                            show: false,
                            focus: false,
                            ..Default::default()
                        },
                        cx,
                        |window, cx| {
                            cx.new(|cx| Host {
                                input: cx.new(|cx| InputState::new(window, cx)),
                                pane: cx.new(|cx| {
                                    let mut p = ArtifactPane::new();
                                    p.preview(
                                        reference,
                                        "Synthetic chart values only".into(),
                                        scene(),
                                        cx,
                                    );
                                    p.inline = inline;
                                    p
                                }),
                            })
                        },
                    )
                    .unwrap()
                });
                // Focus events reach listeners only in the active window, as in the app.
                cx.update_window(h, |_, w, _| w.activate_window()).unwrap();
                let (input, pane) = cx.update(|cx| {
                    let host = host.read(cx);
                    (host.input.clone(), host.pane.clone())
                });
                frame(cx, h);
                let before = cx.update(|cx| pane.read(cx).inline_probe_snapshot());
                // A composing input keeps focus and preedit while the pointer reads a chart.
                cx.update_window(h, |_, w, cx| {
                    input.focus_handle(cx).focus(w, cx);
                    w.input("資料 e\u{301} ", cx);
                    input.update(cx, |i, cx| {
                        i.replace_and_mark_text_in_range(None, "にほん", Some(3..3), w, cx)
                    });
                })
                .unwrap();
                frame(cx, h);
                point_at(cx, h, "0.0", 0.125);
                assert_eq!(readout(cx, &pane), shown("0.0", "North"));
                cx.update_window(h, |_, w, cx| {
                    assert!(input.focus_handle(cx).is_focused(w));
                    input.update(cx, |i, cx| {
                        assert!(i.marked_text_range(w, cx).is_some(), "hover keeps preedit");
                        i.replace_text_in_range(None, "にほん", w, cx);
                    });
                })
                .unwrap();
                // Arrows belong to the focused input, not to a hovered chart.
                let caret = |cx: &mut HeadlessAppContext| {
                    cx.update_window(h, |_, w, cx| {
                        input.update(cx, |i, cx| {
                            i.selected_text_range(false, w, cx).unwrap().range
                        })
                    })
                    .unwrap()
                };
                let typed = caret(cx);
                press(cx, h, "left");
                assert_eq!(caret(cx).start + 1, typed.start, "input moved its caret");
                assert_eq!(readout(cx, &pane), shown("0.0", "North"));
                let value = cx.update(|cx| input.read(cx).value().to_string());
                assert_eq!(value, "資料 e\u{301} にほん");
                // Leaving an unfocused plot closes its pointer readout.
                leave(cx, h);
                assert_eq!(readout(cx, &pane), None);

                // Tab focus shows the first entry; arrows step over entries with values.
                tab_to(cx, h, "0.0");
                assert_eq!(
                    readout(cx, &pane),
                    shown("0.0", "North"),
                    "focus is visible"
                );
                card_visible(cx, h, "0.0", width);
                for (key, label) in [
                    ("right", "South"),
                    ("right", "West"),
                    ("right", "West"), // East has no values
                    ("home", "North"),
                    ("left", "North"),
                    ("end", "West"),
                    ("left", "South"),
                ] {
                    press(cx, h, key);
                    assert_eq!(readout(cx, &pane), shown("0.0", label), "{key}");
                    card_visible(cx, h, "0.0", width);
                }
                assert!(plot_focused(cx, h, "0.0"));
                if let Some(dir) = &captures {
                    cx.capture_screenshot(h)
                        .unwrap()
                        .save(dir.join(format!("{width}-{dark}-{inline}-keyboard.png")))
                        .unwrap();
                }
                // The pointer still reads a focused plot; its readout then stays
                // when the pointer leaves or content scrolls, and keys continue from it.
                point_at(cx, h, "0.0", 0.875);
                assert_eq!(readout(cx, &pane), shown("0.0", "West"));
                point_at(cx, h, "0.0", 0.125);
                assert_eq!(readout(cx, &pane), shown("0.0", "North"));
                cx.update_window(h, |_, w, cx| {
                    let at = w.within("0.0").find("chart-plot").bounds().center();
                    w.pointer_move(point(px(2.), px(2.)), None, cx);
                    w.dispatch_event(
                        gpui_kit::ScrollWheelEvent {
                            position: at,
                            delta: ScrollDelta::Pixels(point(px(0.), px(-1.))),
                            ..Default::default()
                        }
                        .to_platform_input(),
                        cx,
                    );
                    w.dispatch_event(gpui_kit::MouseExitEvent::default().to_platform_input(), cx);
                })
                .unwrap();
                frame(cx, h);
                assert_eq!(
                    readout(cx, &pane),
                    shown("0.0", "North"),
                    "focused readout stays"
                );
                press(cx, h, "right");
                assert_eq!(readout(cx, &pane), shown("0.0", "South"));
                assert!(plot_focused(cx, h, "0.0"), "pointer never takes focus");
                // Another chart's pointer readout replaces it; leaving that unfocused
                // chart closes only its own, and keys start again here.
                point_at(cx, h, "0.1", 0.);
                assert_eq!(readout(cx, &pane), shown("0.1", "-5"));
                leave(cx, h);
                assert_eq!(readout(cx, &pane), None);
                press(cx, h, "right");
                assert_eq!(readout(cx, &pane), shown("0.0", "North"));
                // Escape closes the readout and keeps focus on the plot.
                press(cx, h, "escape");
                assert_eq!(readout(cx, &pane), None);
                assert!(plot_focused(cx, h, "0.0"));
                cx.update_window(h, |_, w, _| {
                    assert!(w.within("0.0").try_find("chart-readout").is_none())
                })
                .unwrap();
                press(cx, h, "end");
                assert_eq!(readout(cx, &pane), shown("0.0", "West"));
                // Modified arrows are left to the surrounding view.
                press(cx, h, "shift-left");
                assert_eq!(readout(cx, &pane), shown("0.0", "West"));
                // Tabbing on blurs this plot and focuses the scatter, read in x order.
                cx.update_window(h, |_, w, cx| w.focus_next(cx)).unwrap();
                frame(cx, h);
                assert!(plot_focused(cx, h, "0.1"));
                assert_eq!(readout(cx, &pane), shown("0.1", "-5"));
                press(cx, h, "right");
                assert_eq!(readout(cx, &pane), shown("0.1", "2"));
                press(cx, h, "right");
                assert_eq!(readout(cx, &pane), shown("0.1", "100"));
                // Reading charts never dispatches to or changes the visual.
                let after = cx.update(|cx| pane.read(cx).inline_probe_snapshot());
                assert_eq!(
                    (after.version, &after.state),
                    (before.version, &before.state)
                );
                assert!(cx.update(|cx| pane.read(cx).inline_probe_idle()));
                // Returning focus to the input blurs the plot and closes its readout,
                // leaving the input's text and selection as they were.
                cx.update_window(h, |_, w, cx| input.focus_handle(cx).focus(w, cx))
                    .unwrap();
                frame(cx, h);
                assert_eq!(readout(cx, &pane), None, "blur closes the readout");
                assert_eq!(caret(cx).start + 1, typed.start);
                assert_eq!(cx.update(|cx| input.read(cx).value().to_string()), value);
                // A new presentation generation retires the old focus and readout.
                tab_to(cx, h, "0.0");
                assert_eq!(readout(cx, &pane), shown("0.0", "North"));
                cx.update(|cx| {
                    pane.update(cx, |p, cx| {
                        p.preview(reference.clone(), "Replacement".into(), scene(), cx);
                        p.inline = inline;
                    })
                });
                frame(cx, h);
                frame(cx, h);
                assert_eq!(readout(cx, &pane), None);
                assert!(!plot_focused(cx, h, "0.0"));
                press_unfocused(cx, h);
                assert_eq!(readout(cx, &pane), None, "keys need a focused plot");
                cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
                cx.run_until_parked();
            }
        }
    }
    println!(
        "chart_keyboard passed: Tab focus, arrows, Escape/blur, pointer and input coexistence"
    );
}
fn press_unfocused(cx: &mut HeadlessAppContext, h: AnyWindowHandle) {
    cx.update_window(h, |_, w, cx| {
        w.dispatch_event(
            gpui_kit::KeyDownEvent {
                keystroke: gpui_kit::Keystroke::parse("right").unwrap(),
                is_held: false,
                prefer_character_input: false,
            }
            .to_platform_input(),
            cx,
        );
    })
    .unwrap();
    frame(cx, h);
}
