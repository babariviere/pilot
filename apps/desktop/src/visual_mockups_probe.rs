//! Two UI mockup visuals (packages/protocol/fixtures/visual) rendered by the production native visual pane.
//! Trees come from the real confined helper (the shared runtime), never from
//! hand-written fixtures; controls go through the pane's own event path. No
//! daemon, real data, writes or visible window.
use super::*;
use gpui_kit::{
    AnyWindowHandle, Bounds, HeadlessAppContext, WindowBounds, WindowOptions, component::ThemeMode,
    size, test::TestWindowExt,
};

const MOBILE: &str = include_str!("../../../packages/protocol/fixtures/visual/mockup-mobile.js");
const DESKTOP: &str = include_str!("../../../packages/protocol/fixtures/visual/mockup-desktop.js");

/// The example files hold one visual function after a lint comment.
fn function(file: &str) -> String {
    file[file.find("function visual").unwrap()..]
        .trim()
        .to_owned()
}

/// One example running in the real helper, as the reader would run it.
struct Live {
    runtime: tokio::runtime::Runtime,
    session: crate::visual_session::Session,
}
impl Live {
    fn start(source: &str) -> Self {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let mut session = crate::visual_session::Session::new(
            crate::visual_session::Program {
                source: function(source),
                data: Value::Null,
                seed: "mockup".into(),
                now: 0.,
            },
            None,
        )
        .unwrap();
        runtime.block_on(async {
            session.prepare().await.unwrap();
            session.load().await.unwrap();
        });
        Self { runtime, session }
    }
    fn scene(&self) -> crate::visual_scene::Scene {
        (**self.session.scene.as_ref().unwrap()).clone()
    }
    fn event(&mut self, id: &str, value: Value) {
        let version = self.session.version;
        self.runtime
            .block_on(self.session.event(version, id, value))
            .unwrap();
    }
    fn stop(mut self) {
        self.runtime.block_on(self.session.stop());
    }
}

fn frame(cx: &mut HeadlessAppContext, h: AnyWindowHandle) {
    for _ in 0..3 {
        cx.advance_clock(std::time::Duration::from_millis(16));
        cx.run_until_parked();
        cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
    }
}

fn open(
    cx: &mut HeadlessAppContext,
    live: &Live,
    title: &str,
    width: f32,
    height: f32,
) -> (
    AnyWindowHandle,
    Entity<ArtifactPane>,
    async_channel::Receiver<Command>,
) {
    let (worker, commands) = Worker::synthetic();
    let scene = live.scene();
    let state = live.session.state.clone();
    let title = title.to_owned();
    let (h, pane) = cx
        .update(|cx| {
            gpui_kit::open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                        Default::default(),
                        size(px(width), px(height)),
                    ))),
                    show: false,
                    focus: false,
                    ..Default::default()
                },
                cx,
                |_, cx| {
                    cx.new(|cx| {
                        let mut pane = ArtifactPane::new();
                        pane.preview(
                            Reference {
                                id: "mockup".into(),
                                session: "synthetic".into(),
                                title,
                                kind: "visual".into(),
                                revision: 1,
                            },
                            "Bundled mockup example; trees from the confined helper".into(),
                            scene,
                            cx,
                        );
                        pane.worker = Some(worker);
                        pane.snapshot.live = true;
                        pane.snapshot.state = state;
                        pane
                    })
                },
            )
        })
        .unwrap();
    let h: AnyWindowHandle = h;
    frame(cx, h);
    (h, pane, commands)
}

/// Forwards the pane's one dispatched event to the helper and accepts its tree.
fn deliver(
    cx: &mut HeadlessAppContext,
    h: AnyWindowHandle,
    pane: &Entity<ArtifactPane>,
    commands: &async_channel::Receiver<Command>,
    live: &mut Live,
) -> (String, Value) {
    cx.run_until_parked();
    let Ok(Command::Event { version, id, value }) = commands.try_recv() else {
        panic!("the pressed control dispatched no event")
    };
    live.event(&id, value.clone());
    let scene = live.scene();
    let state = live.session.state.clone();
    cx.update(|cx| {
        pane.update(cx, |p, cx| {
            assert_eq!(version, p.snapshot.version);
            let mut next = p.snapshot.clone();
            next.version += 1;
            next.scene = Some(Arc::new(scene));
            next.state = state;
            let reference = p.reference.clone().unwrap();
            p.accept(p.generation, &reference, next, cx);
        })
    });
    frame(cx, h);
    (id, value)
}

fn bounds(cx: &mut HeadlessAppContext, h: AnyWindowHandle, id: &str) -> Bounds<gpui_kit::Pixels> {
    let id = SharedString::from(id.to_owned());
    cx.update_window(h, |_, w, _| w.find(id).bounds()).unwrap()
}

/// Mean RGB over a window-local rectangle of the screenshot, 0-1.
fn mean(shot: &image::RgbaImage, scale: f32, b: Bounds<gpui_kit::Pixels>) -> [f32; 3] {
    let (x0, y0) = (
        (f32::from(b.left()) * scale) as u32,
        (f32::from(b.top()) * scale) as u32,
    );
    let (x1, y1) = (
        ((f32::from(b.right()) * scale) as u32).min(shot.width()),
        ((f32::from(b.bottom()) * scale) as u32).min(shot.height()),
    );
    let mut sum = [0f64; 3];
    let mut n = 0f64;
    for y in y0..y1 {
        for x in x0..x1 {
            let p = shot.get_pixel(x, y);
            for c in 0..3 {
                sum[c] += f64::from(p[c]) / 255.;
            }
            n += 1.;
        }
    }
    sum.map(|s| (s / n.max(1.)) as f32)
}

fn capture(cx: &mut HeadlessAppContext, h: AnyWindowHandle, name: &str) -> (image::RgbaImage, f32) {
    let shot = cx.capture_screenshot(h).unwrap();
    if let Some(dir) = std::env::var_os("PILOT_NEXT_IMAGE_DIR").map(std::path::PathBuf::from) {
        std::fs::create_dir_all(&dir).unwrap();
        shot.save(dir.join(format!("{name}.png"))).unwrap();
    }
    let width = cx
        .update_window(h, |_, w, _| f32::from(w.bounds().size.width))
        .unwrap();
    let scale = shot.width() as f32 / width;
    (shot, scale)
}

fn theme(cx: &mut HeadlessAppContext, mode: ThemeMode) {
    cx.update(|cx| {
        crate::appearance::commit_appearance(
            if mode == ThemeMode::Dark {
                crate::settings_state::AppearancePreference::Dark
            } else {
                crate::settings_state::AppearancePreference::Light
            },
            cx,
        )
    });
}

fn mobile(cx: &mut HeadlessAppContext, width: f32, mode: ThemeMode) {
    let mut live = Live::start(MOBILE);
    // Tall enough to show both phones when they stack.
    let height = if width >= 1000. { 1000. } else { 1800. };
    let (h, pane, commands) = open(cx, &live, "Running coach · home screen", width, height);
    let name = format!("mockup-mobile-{}-{}", width as u32, mode.name());
    // Two 360 pt phone artboards: side by side when they fit, stacked when not.
    let a = bounds(cx, h, "0.1.0.0");
    let b = bounds(cx, h, "0.1.1.0");
    for phone in [a, b] {
        assert!(
            (f32::from(phone.size.width) - 360.).abs() < 0.5,
            "{name}: {phone:?}"
        );
        assert!(
            (f32::from(phone.size.height) - 720.).abs() < 0.5,
            "{name}: {phone:?}"
        );
    }
    let side_by_side = (a.top() - b.top()).abs() < px(0.5) && b.left() >= a.right() + px(27.5);
    let stacked = b.top() >= a.bottom() && (a.left() - b.left()).abs() < px(0.5);
    assert!(
        if width >= 1000. {
            side_by_side
        } else {
            stacked
        },
        "{name}: {a:?} {b:?}"
    );
    // The positioned label sits over the ring's centre, inside the 120 pt vector.
    let ring = bounds(cx, h, "0.1.0.0.1.1.0.0");
    assert!(
        (f32::from(ring.size.width) - 120.).abs() < 0.5,
        "{name}: ring {ring:?}"
    );
    let label = bounds(cx, h, "0.1.0.0.1.1.0.0.1");
    assert!(
        ring.contains(&label.center()) && (label.center().y - ring.center().y).abs() < px(2.),
        "{name}: {label:?}"
    );
    let (shot, scale) = capture(cx, h, &name);
    // Literal artboard colors hold in either app theme: A is light, B is dark.
    let inset = |r: Bounds<gpui_kit::Pixels>| {
        Bounds::new(
            r.origin + gpui_kit::point(px(10.), px(64.)),
            size(px(16.), px(8.)),
        )
    };
    let light = mean(&shot, scale, inset(a));
    let dark = mean(&shot, scale, inset(b));
    assert!(light.iter().all(|c| *c > 0.9), "{name}: A page {light:?}");
    assert!(dark.iter().all(|c| *c < 0.1), "{name}: B page {dark:?}");
    // The ring's progress arc starts at 12 o'clock in A's green accent.
    let arc = mean(
        &shot,
        scale,
        Bounds::new(
            ring.origin + gpui_kit::point(px(62.), px(3.)),
            size(px(4.), px(6.)),
        ),
    );
    assert!(
        arc[1] > arc[0] + 0.25 && arc[1] > arc[2] + 0.1,
        "{name}: ring arc {arc:?}"
    );

    // Press the Plan tab in phone A: the shared state switches both phones.
    cx.update_window(h, |_, w, cx| w.click("0.1.0.0.2.1", cx))
        .unwrap();
    let (id, value) = deliver(cx, h, &pane, &commands, &mut live);
    assert_eq!((id.as_str(), value), ("0.1.0.0.2.1", Value::Null));
    let content =
        live.scene().root["children"][1]["children"][0]["children"][0]["children"][1].clone();
    assert_eq!(
        content["children"][0]["runs"][0]["text"], "This week",
        "{name}"
    );
    assert_eq!(
        live.session.state.as_deref(),
        Some("[{\"tab\":\"plan\",\"width\":360}]")
    );
    capture(cx, h, &format!("{name}-plan"));
    // The pressed tab keeps focus, so Enter activates it again from the keyboard.
    cx.update_window(h, |_, w, cx| w.press("enter", cx))
        .unwrap();
    let (id, _) = deliver(cx, h, &pane, &commands, &mut live);
    assert_eq!(id, "0.1.0.0.2.1", "{name}: keyboard activation");
    // The width slider resizes both artboards through the same helper state.
    let slider = live.scene().root["children"][0]["children"][1]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    cx.update(|cx| {
        pane.update(cx, |p, cx| {
            let (generation, version) = (p.generation, p.snapshot.version);
            p.event(generation, version, slider, json!(400), cx)
        })
    });
    deliver(cx, h, &pane, &commands, &mut live);
    assert!(
        (f32::from(bounds(cx, h, "0.1.0.0").size.width) - 400.).abs() < 0.5,
        "{name}"
    );
    cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
    live.stop();
    println!(
        "{name}: helper trees, side-by-side/stacked artboards, layered ring label, literal palettes, pressable tab (pointer + Enter), slider resize"
    );
}

fn desktop(cx: &mut HeadlessAppContext, width: f32, mode: ThemeMode) {
    let mut live = Live::start(DESKTOP);
    let (h, pane, commands) = open(cx, &live, "Release dashboard · desktop", width, 900.);
    let name = format!("mockup-desktop-{}-{}", width as u32, mode.name());
    // The window sits in a sideways-scrolling strip under the header.
    let window = bounds(cx, h, "0.1.0");
    assert!(f32::from(window.size.width) <= 980.5, "{name}: {window:?}");
    let sidebar = bounds(cx, h, "0.1.0.1.0");
    assert!(
        (f32::from(sidebar.size.width) - 210.).abs() < 0.5,
        "{name}: {sidebar:?}"
    );
    let content = bounds(cx, h, "0.1.0.1.1");
    assert!(
        content.left() >= sidebar.right() - px(0.5) && content.right() <= window.right() + px(0.5),
        "{name}: content {content:?} in {window:?}"
    );
    let (shot, scale) = capture(cx, h, &name);
    let page = mean(
        &shot,
        scale,
        Bounds::new(
            content.origin + gpui_kit::point(px(4.), px(4.)),
            size(px(8.), px(8.)),
        ),
    );
    assert!(
        page.iter().all(|c| *c > 0.95),
        "{name}: light window {page:?}"
    );
    // Dark window palette, then a narrow window: the sidebar collapses to icons.
    let toggle = live.scene().root["children"][0]["children"][1]["children"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    cx.update(|cx| {
        pane.update(cx, |p, cx| {
            let (generation, version) = (p.generation, p.snapshot.version);
            p.event(generation, version, toggle, json!(true), cx)
        })
    });
    deliver(cx, h, &pane, &commands, &mut live);
    let (shot, scale) = capture(cx, h, &format!("{name}-dark"));
    let page = mean(
        &shot,
        scale,
        Bounds::new(
            content.origin + gpui_kit::point(px(4.), px(4.)),
            size(px(8.), px(8.)),
        ),
    );
    assert!(
        page.iter().all(|c| *c < 0.15),
        "{name}: dark window {page:?}"
    );
    // A pressable release row expands its detail line.
    cx.update_window(h, |_, w, cx| w.click("0.1.0.1.1.3.4", cx))
        .unwrap();
    let (id, _) = deliver(cx, h, &pane, &commands, &mut live);
    assert_eq!(id, "0.1.0.1.1.3.4", "{name}");
    assert!(
        live.session
            .state
            .as_deref()
            .unwrap()
            .contains("\"open\":\"2.3.2\""),
        "{name}"
    );
    let slider = live.scene().root["children"][0]["children"][1]["children"][1]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    cx.update(|cx| {
        pane.update(cx, |p, cx| {
            let (generation, version) = (p.generation, p.snapshot.version);
            p.event(generation, version, slider, json!(640), cx)
        })
    });
    deliver(cx, h, &pane, &commands, &mut live);
    assert!(
        (f32::from(bounds(cx, h, "0.1.0.1.0").size.width) - 60.).abs() < 0.5,
        "{name}: compact"
    );
    assert!(
        f32::from(bounds(cx, h, "0.1.0").size.width) <= 640.5,
        "{name}"
    );
    capture(cx, h, &format!("{name}-compact"));
    cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
    live.stop();
    println!(
        "{name}: helper trees, window/sidebar/content geometry, light/dark window palette, pressable row, responsive compact sidebar"
    );
}

pub fn run_visual_mockups_probe(cx: &mut HeadlessAppContext) {
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            theme(cx, mode);
            mobile(cx, width, mode);
            desktop(cx, width, mode);
        }
    }
}
