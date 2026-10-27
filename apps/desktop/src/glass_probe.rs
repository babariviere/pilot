//! Production root over a synthetic backdrop: glass tints, opaque reading
//! surfaces and the calm page entrance. Offscreen; the OS blur itself is not
//! rendered here, so captures show the tints over an already-soft backdrop.
use super::*;
use gpui_kit::{
    Bounds, HeadlessAppContext, WindowBounds, WindowOptions,
    component::{Theme, ThemeMode},
    size,
    test::TestWindowExt,
};
use serde_json::json;

struct Backdrop {
    viewer: Entity<LocalViewer>,
    image: Option<Arc<gpui_kit::Image>>,
}
impl Render for Backdrop {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        use gpui_kit::StyledImage as _;
        // Saturated bands make any accidental opacity or stacking visible.
        let bands = [
            "#ff7a45", "#e0569b", "#7b6cff", "#3d8bff", "#2aa86b", "#b6e34a",
        ];
        let backdrop = match &self.image {
            Some(image) => gpui_kit::img(image.clone())
                .size_full()
                .object_fit(gpui_kit::ObjectFit::Cover)
                .into_any_element(),
            None => div()
                .v_flex()
                .size_full()
                .children(bands.map(|c| {
                    div()
                        .flex_1()
                        .w_full()
                        .bg(gpui_kit::Rgba::try_from(c).unwrap())
                }))
                .into_any_element(),
        };
        div()
            .size_full()
            .relative()
            .child(
                div()
                    .absolute()
                    .top_0()
                    .left_0()
                    .size_full()
                    .child(backdrop),
            )
            .child(
                div()
                    .absolute()
                    .top_0()
                    .left_0()
                    .size_full()
                    .child(self.viewer.clone()),
            )
    }
}
fn settle(cx: &mut HeadlessAppContext, h: gpui_kit::AnyWindowHandle) {
    for _ in 0..24 {
        cx.advance_clock(Duration::from_millis(16));
        cx.run_until_parked();
        cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
    }
}
fn backdrop(dark: bool) -> Option<Arc<gpui_kit::Image>> {
    let key = if dark {
        "PILOT_NEXT_GLASS_BACKDROP_DARK"
    } else {
        "PILOT_NEXT_GLASS_BACKDROP_LIGHT"
    };
    let bytes = std::fs::read(std::env::var_os(key)?).ok()?;
    Some(Arc::new(gpui_kit::Image::from_bytes(
        gpui_kit::ImageFormat::Png,
        bytes,
    )))
}
pub fn run_glass_probe(cx: &mut HeadlessAppContext) {
    let captures = std::env::var_os("PILOT_NEXT_GLASS_DIR").map(std::path::PathBuf::from);
    if let Some(d) = &captures {
        std::fs::create_dir_all(d).unwrap();
    }
    let glass = cx.update(|cx| crate::appearance::glass(cx));
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            cx.update(|cx| Theme::change(mode, None, cx));
            let (client, _) = LocalClient::synthetic_commands();
            let (writer, _) = Interaction::recording();
            let mut viewer = None;
            let h = cx
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
                            let v = cx.new(|cx| {
                                let mut v = LocalViewer::preview(PreviewState::Conversation, w, cx);
                                v.client = Some(client);
                                v.writer = Some(writer.clone());
                                v.editor.update(cx, |e, cx| e.shell_probe_setup(writer, w, cx));
                                v.generation = 20;
                                v.state.generation = 20;
                                v.state.loaded = true;
                                v.state.list_loaded = true;
                                v.state.projects_loaded = true;
                                v.state.projects = Arc::new(
                                    crate::local_model::projects(&json!([
                                        {"id":"a","name":"Atlas","path":"/synthetic/shared"},
                                        {"id":"b","name":"Boreal","path":"/synthetic/shared"}
                                    ]))
                                    .unwrap(),
                                );
                                v.state.chats = Arc::new(
                                    [
                                        json!({"id":"synthetic","title":"Tighten the release notes","projectId":"a","state":"working"}),
                                        json!({"id":"other","title":"Review package","projectId":"b","state":"idle"}),
                                        json!({"id":"failed","title":"Check failed build","projectId":"a","state":"failed"}),
                                    ]
                                    .iter()
                                    .map(|x| crate::local_model::chat(x).unwrap())
                                    .collect(),
                                );
                                v.title = "Tighten the release notes".into();
                                v.rebuild_nav(w, cx);
                                v
                            });
                            viewer = Some(v.clone());
                            cx.new(|_| Backdrop {
                                viewer: v,
                                image: backdrop(mode.is_dark()),
                            })
                        },
                    )
                })
                .unwrap();
            let (h, _root) = h;
            let _viewer = viewer.unwrap();
            settle(cx, h);
            let name = |page: &str| format!("{}-{}-{page}.png", width as u32, mode.name());
            let shot = cx.capture_screenshot(h).unwrap();
            if let Some(dir) = &captures {
                shot.save(dir.join(name("chat"))).unwrap();
            }
            let (sidebar, editor, card, opaque_sidebar) = cx
                .update_window(h, |_, w, cx| {
                    let rgba = |c: gpui_kit::Hsla| {
                        let c: gpui_kit::Rgba = c.into();
                        [c.r, c.g, c.b].map(|v| (v * 255.).round() as u8)
                    };
                    let p = crate::appearance::palette(cx.theme().is_dark());
                    (
                        w.find("chat-sidebar").bounds(),
                        w.find("composer-input").bounds(),
                        rgba(crate::appearance::card(cx)),
                        rgba(gpui_kit::Rgba::try_from(p.sidebar).unwrap().into()),
                    )
                })
                .unwrap();
            let scale = shot.width() as f32 / width;
            let pixel = |x: f32, y: f32| {
                let p = shot.get_pixel((x * scale) as u32, (y * scale) as u32).0;
                [p[0], p[1], p[2]]
            };
            // Opaque reading surface: the editor card never shows the backdrop.
            assert_eq!(
                pixel(f32::from(editor.left()) + 16., f32::from(editor.top()) + 3.),
                card,
                "editor card stays opaque"
            );
            let empty = pixel(
                f32::from(sidebar.left()) + 8.,
                f32::from(sidebar.bottom()) - 120.,
            );
            if glass {
                assert_ne!(empty, opaque_sidebar, "sidebar lets the backdrop through");
            } else {
                assert_eq!(empty, opaque_sidebar, "no glass: solid sidebar");
            }
            // Calm entrance: a paint-only rise that settles exactly.
            let before = cx
                .update_window(h, |_, w, cx| {
                    w.click("nav-inbox", cx);
                    w.render_frame(cx);
                    w.find("inbox").bounds().top()
                })
                .unwrap();
            if let Some(dir) = std::env::var_os("PILOT_NEXT_GLASS_FRAMES")
                .filter(|_| width > 800.)
                .map(std::path::PathBuf::from)
            {
                std::fs::create_dir_all(&dir).unwrap();
                for index in 0..16 {
                    cx.capture_screenshot(h)
                        .unwrap()
                        .save(dir.join(format!("{}-{index:02}.png", mode.name())))
                        .unwrap();
                    cx.advance_clock(Duration::from_millis(16));
                    cx.run_until_parked();
                    cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
                }
            }
            settle(cx, h);
            let after = cx
                .update_window(h, |_, w, _| w.find("inbox").bounds().top())
                .unwrap();
            assert!(before > after, "page enters with a short rise");
            assert_eq!(after, px(0.), "the entrance settles exactly");
            if let Some(dir) = &captures {
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(dir.join(name("inbox")))
                    .unwrap();
            }
            cx.update_window(h, |_, w, cx| w.click("nav-home", cx))
                .unwrap();
            settle(cx, h);
            if let Some(dir) = &captures {
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(dir.join(name("home")))
                    .unwrap();
            }
            println!(
                "{}",
                json!({"width":width,"mode":mode.name(),"glass":glass,"opaque_editor":true,"entrance_rise":f32::from(before - after)})
            );
            cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
            cx.run_until_parked();
        }
    }
}
