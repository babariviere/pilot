//! Offscreen production reader links. All activations use an injected, inert opener.
use super::*;
use gpui_kit::InputEvent;
use gpui_kit::{
    AnyWindowHandle, Bounds, HeadlessAppContext, WindowBounds, WindowOptions,
    component::input::{Input, InputState},
    point, size,
    test::{TestEventExt, TestWindowExt},
};
use std::{sync::Mutex, time::Duration};

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
fn scene(target: &str) -> crate::visual_scene::Scene {
    crate::visual_scene::Scene::parse(json!({"api":1,"root":{"type":"column","children":[
        {"type":"link","label":"Documentation 日本語","href":target},
        {"type":"link","label":"Slack thread","href":"https://acme.slack.com/archives/C1/p1234567890000000?team=T1"},
        {"type":"link","label":"Linear issue","href":"https://linear.app/acme/issue/ENG-1"},
        {"type":"link","label":"Refused encoded control","href":"https://example.com/%0a"},
        {"type":"link","label":"Refused credentials","href":"https://user@example.com"},
        {"type":"text","runs":[{"text":"Selectable 日本語 é"}]}
    ]}})).unwrap()
}
fn frame(cx: &mut HeadlessAppContext, h: AnyWindowHandle) {
    cx.advance_clock(Duration::from_millis(16));
    cx.run_until_parked();
    cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
}
pub fn run_visual_links_probe(cx: &mut HeadlessAppContext) {
    let opened = Arc::new(Mutex::new(Vec::<String>::new()));
    cx.update(|cx| {
        let opened = opened.clone();
        cx.set_global(crate::external_links::Opener(Arc::new(move |url, _| {
            opened.lock().unwrap().push(url.into())
        })));
    });
    for width in [680., 1100.] {
        for dark in [false, true] {
            for inline in [false, true] {
                opened.lock().unwrap().clear();
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
                    id: "links".into(),
                    session: "synthetic".into(),
                    revision: 1,
                    title: "Visual resources".into(),
                    kind: "visual".into(),
                };
                let (h, host) = cx.update(|cx| {
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
                        |w, cx| {
                            cx.new(|cx| Host {
                                input: cx.new(|cx| InputState::new(w, cx)),
                                pane: cx.new(|cx| {
                                    let mut p = ArtifactPane::new();
                                    p.preview(
                                        reference.clone(),
                                        "inert exact source".into(),
                                        scene("https://example.com/docs"),
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
                cx.update_window(h, |_, w, _| w.activate_window()).unwrap();
                let (pane, input) = cx.update(|cx| {
                    let host = host.read(cx);
                    (host.pane.clone(), host.input.clone())
                });
                frame(cx, h);
                cx.update_window(h, |_, w, cx| {
                    use gpui_kit::Focusable;
                    input.focus_handle(cx).focus(w, cx);
                    w.input("Draft 日本語", cx);
                    w.hover("visual-link-0.0", cx);
                    assert!(input.focus_handle(cx).is_focused(w));
                    assert!(w.find("visual-link-refused-0.3").visible());
                    assert!(w.find("visual-link-refused-0.4").visible());
                })
                .unwrap();
                frame(cx, h);
                assert!(
                    opened.lock().unwrap().is_empty(),
                    "render/hover/read cannot open"
                );
                let link_focus = cx
                    .update_window(h, |_, w, cx| {
                        w.click("visual-link-0.0", cx);
                        let focus = w.focused(cx).unwrap();
                        use gpui_kit::Focusable;
                        input.focus_handle(cx).focus(w, cx);
                        focus
                    })
                    .unwrap();
                assert_eq!(&*opened.lock().unwrap(), &["https://example.com/docs"]);
                opened.lock().unwrap().clear();
                // Real keyboard traversal and native Enter/Space activation.
                let mut focused = false;
                for _ in 0..24 {
                    focused = cx
                        .update_window(h, |_, w, _| link_focus.is_focused(w))
                        .unwrap();
                    if focused {
                        break;
                    }
                    cx.update_window(h, |_, w, cx| w.focus_next(cx)).unwrap();
                    frame(cx, h);
                }
                assert!(focused, "Tab reaches link");
                cx.update_window(h, |_, w, cx| {
                    w.press("enter", cx);
                    w.press("space", cx);
                })
                .unwrap();
                assert_eq!(
                    &*opened.lock().unwrap(),
                    &["https://example.com/docs", "https://example.com/docs"]
                );
                opened.lock().unwrap().clear();
                // Pointer opens exact source URLs through the same injected route.
                cx.update_window(h, |_, w, cx| {
                    w.click("visual-link-0.1", cx);
                    w.click("visual-link-0.2", cx);
                    w.click("visual-link-refused-0.3", cx);
                    w.click("visual-link-refused-0.4", cx);
                })
                .unwrap();
                assert_eq!(
                    &*opened.lock().unwrap(),
                    &[
                        "https://acme.slack.com/archives/C1/p1234567890000000?team=T1",
                        "https://linear.app/acme/issue/ENG-1"
                    ]
                );
                opened.lock().unwrap().clear();
                cx.update_window(h, |_, w, cx| {
                    let b = w.find("visual-link-0.0").bounds();
                    w.drag(
                        point(b.left() + px(1.), b.center().y),
                        point(b.right() - px(1.), b.center().y),
                        cx,
                    );
                    assert_eq!(
                        gpui_kit::base::TextSelection::selected_text(w, cx),
                        "Documentation 日本語"
                    );
                    w.press("secondary-c", cx);
                    assert_eq!(
                        cx.read_from_clipboard().unwrap().text().unwrap(),
                        "Documentation 日本語"
                    );
                })
                .unwrap();
                assert!(
                    opened.lock().unwrap().is_empty(),
                    "selection must not activate"
                );
                cx.update(|cx| {
                    assert_eq!(input.read(cx).value().as_ref(), "Draft 日本語");
                });
                // Replace the scene between native pointer down/up, including a redraw.
                cx.update_window(h, |_, w, cx| {
                    let b = w.find("visual-link-0.0").bounds();
                    w.pointer_down(b.center(), gpui_kit::MouseButton::Left, cx);
                    pane.update(cx, |p, _| {
                        p.snapshot.scene = Some(Arc::new(scene("https://example.com/replacement")))
                    });
                    w.pointer_up(b.center(), gpui_kit::MouseButton::Left, cx);
                })
                .unwrap();
                assert!(
                    opened.lock().unwrap().is_empty(),
                    "retired scene callback cannot open"
                );
                frame(cx, h);
                assert!(
                    opened.lock().unwrap().is_empty(),
                    "replacement doesn't auto-open"
                );
                cx.update_window(h, |_, w, cx| w.click("visual-link-0.0", cx))
                    .unwrap();
                assert_eq!(
                    &*opened.lock().unwrap(),
                    &["https://example.com/replacement"]
                );
                opened.lock().unwrap().clear();
                // A pre-redraw callback also refuses a newly selected revision.
                cx.update_window(h, |_, w, cx| {
                    let at = w.find("visual-link-0.0").bounds().center();
                    w.pointer_down(at, gpui_kit::MouseButton::Left, cx);
                    pane.update(cx, |p, cx| {
                        let mut r = reference.clone();
                        r.revision = 2;
                        p.preview(
                            r,
                            "new inert source".into(),
                            scene("https://example.com/revision-2"),
                            cx,
                        );
                        p.inline = inline;
                    });
                    w.dispatch_event(
                        gpui_kit::MouseUpEvent {
                            position: at,
                            button: gpui_kit::MouseButton::Left,
                            click_count: 1,
                            ..Default::default()
                        }
                        .to_platform_input(),
                        cx,
                    );
                })
                .unwrap();
                frame(cx, h);
                assert!(opened.lock().unwrap().is_empty());
                if let Some(dir) = std::env::var_os("PILOT_NEXT_IMAGE_DIR") {
                    let dir = std::path::PathBuf::from(dir);
                    std::fs::create_dir_all(&dir).unwrap();
                    cx.capture_screenshot(h)
                        .unwrap()
                        .save(dir.join(format!("{width}-{dark}-{inline}.png")))
                        .unwrap();
                }
                cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
                cx.run_until_parked();
            }
        }
    }
    println!(
        "visual_links passed: 680/1100 light/dark inline/expanded, native keyboard/pointer, refused targets, selection and retired scenes"
    );
}
