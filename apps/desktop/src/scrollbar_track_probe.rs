//! Hidden native pixels: scrollbar tracks are see-through at rest, on hover
//! and while dragging, in light and dark; only the thumb paints. Synthetic
//! content, offscreen windows. Not visible-window or motion evidence.
use crate::{local_model::LiveTranscript, model::Message, transcript_view::TranscriptView};
use gpui_kit::{
    AnyWindowHandle, AppContext, Bounds, Context, HeadlessAppContext, InputEvent, IntoElement,
    MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, ParentElement, Pixels, Point,
    Render, Styled, Window, WindowBounds, WindowOptions,
    component::{
        ActiveTheme, StyledExt, Theme, ThemeMode,
        scroll::{ScrollableElement, ScrollbarMode},
    },
    div, point, px, size,
    test::TestWindowExt,
};
use image::RgbaImage;
use serde_json::json;

struct Surface;
impl Render for Surface {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        use gpui_kit::{InteractiveElement, TestSupportExt};
        // The sidebar surface, where an opaque track showed as a white strip.
        div().size_full().bg(cx.theme().sidebar).p_4().child(
            div()
                .id("track-area")
                .test_support()
                .h(px(300.))
                .w(px(240.))
                .child(
                    div()
                        .size_full()
                        .child(
                            div().v_flex().children(
                                (0..80).map(|n| div().h(px(20.)).child(format!("Row {n}"))),
                            ),
                        )
                        .overflow_y_scrollbar(),
                ),
        )
    }
}

fn shot(cx: &mut HeadlessAppContext, h: AnyWindowHandle, width: f32) -> (RgbaImage, f32) {
    cx.update_window(h, |_, w, cx| w.draw(cx).clear(cx))
        .unwrap();
    let image = cx.capture_screenshot(h).expect("native renderer required");
    if let Some(dir) = std::env::var_os("PILOT_NEXT_SCROLLBAR_DIR") {
        let dir = std::path::PathBuf::from(dir);
        std::fs::create_dir_all(&dir).unwrap();
        let n = std::fs::read_dir(&dir).unwrap().count();
        image.save(dir.join(format!("shot-{n:02}.png"))).unwrap();
    }
    let scale = image.width() as f32 / width;
    (image, scale)
}

fn pixel(image: &RgbaImage, scale: f32, at: Point<Pixels>) -> [i32; 3] {
    let p = image
        .get_pixel(
            (f32::from(at.x) * scale) as u32,
            (f32::from(at.y) * scale) as u32,
        )
        .0;
    [p[0] as i32, p[1] as i32, p[2] as i32]
}

fn diff(a: [i32; 3], b: [i32; 3]) -> i32 {
    (0..3).map(|i| (a[i] - b[i]).abs()).sum()
}

/// Every track column pixel matches the surface beside the bar, and the
/// thumb column shows a thumb somewhere.
fn assert_clear(image: &RgbaImage, scale: f32, area: Bounds<Pixels>, label: &str) {
    let mut thumb = 0;
    let mut y = area.top() + px(3.);
    while y < area.bottom() - px(3.) {
        let surface = pixel(image, scale, point(area.right() - px(24.), y));
        for x in [px(1.5), px(14.5)] {
            let track = pixel(image, scale, point(area.right() - x, y));
            assert!(
                diff(track, surface) <= 3,
                "{label}: opaque scrollbar track at {y:?}: {track:?} over {surface:?}"
            );
        }
        thumb = thumb.max(diff(
            pixel(image, scale, point(area.right() - px(7.5), y)),
            surface,
        ));
        y += px(4.);
    }
    assert!(thumb >= 12, "{label}: the thumb stays visible ({thumb})");
}

fn mouse(cx: &mut HeadlessAppContext, h: AnyWindowHandle, event: gpui_kit::PlatformInput) {
    cx.update_window(h, |_, w, cx| {
        w.dispatch_event(event, cx);
    })
    .unwrap();
    cx.run_until_parked();
}

fn surface(cx: &mut HeadlessAppContext, mode: ThemeMode) {
    let width = 400.;
    let (h, _) = cx.update(|cx| {
        gpui_kit::open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                    Default::default(),
                    size(px(width), px(400.)),
                ))),
                show: false,
                focus: false,
                ..Default::default()
            },
            cx,
            |_, cx| cx.new(|_| Surface),
        )
        .unwrap()
    });
    let area = cx
        .update_window(h, |_, w, cx| {
            w.draw(cx).clear(cx);
            w.find("track-area").bounds()
        })
        .unwrap();
    let name = mode.name();
    let (image, scale) = shot(cx, h, width);
    assert_clear(&image, scale, area, &format!("{name} rest"));
    let thumb = point(area.right() - px(7.), area.top() + px(20.));
    mouse(
        cx,
        h,
        MouseMoveEvent {
            position: thumb,
            ..Default::default()
        }
        .to_platform_input(),
    );
    let (image, scale) = shot(cx, h, width);
    assert_clear(&image, scale, area, &format!("{name} hover"));
    mouse(
        cx,
        h,
        MouseDownEvent {
            button: MouseButton::Left,
            position: thumb,
            click_count: 1,
            ..Default::default()
        }
        .to_platform_input(),
    );
    mouse(
        cx,
        h,
        MouseMoveEvent {
            position: thumb + point(px(0.), px(60.)),
            pressed_button: Some(MouseButton::Left),
            ..Default::default()
        }
        .to_platform_input(),
    );
    let (image, scale) = shot(cx, h, width);
    assert_clear(&image, scale, area, &format!("{name} drag"));
    mouse(
        cx,
        h,
        MouseUpEvent {
            button: MouseButton::Left,
            position: thumb + point(px(0.), px(60.)),
            click_count: 1,
            ..Default::default()
        }
        .to_platform_input(),
    );
    cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
}

/// A tall expanded tool output's own scrollbar, over the code tint.
fn tool_output(cx: &mut HeadlessAppContext, mode: ThemeMode) {
    let mut model = LiveTranscript::default();
    model.apply(&json!({"type":"run_start"}));
    let calls = json!([{"type":"toolCall","id":"s","name":"codemode","arguments":{"code":"// Print rows\nreturn rows;"}}]);
    model.apply(&json!({"type":"entry_appended","entry":{"id":20,"kind":"pi.assistant","model":[{"role":"assistant","content":calls}]}}));
    let output = (0..120)
        .map(|n| format!("line {n}"))
        .collect::<Vec<_>>()
        .join("\n");
    model.apply(&json!({"type":"tool_execution_end","toolCallId":"s","isError":false,"entry":{"id":21,"kind":"pi.tool","model":[{"role":"toolResult","toolCallId":"s","isError":false,"content":[{"type":"text","text":output}]}]}}));
    model.apply(&json!({"type":"run_end"}));
    let work = model.rows();
    let id = work[0].id();
    let mut rows: Vec<Message> = (1..=6)
        .map(|n| Message::live(n, "assistant".into(), "Earlier reply. ".repeat(60)))
        .collect();
    rows.extend(work);
    let width = 960.;
    let (h, view) = cx.update(|cx| {
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
                cx.new(|cx| {
                    let mut view = TranscriptView::readonly(window, cx);
                    view.replace_readonly(rows, true, cx);
                    view
                })
            },
        )
        .unwrap()
    });
    cx.run_until_parked();
    for key in [format!("work-toggle-{id}"), "step-toggle-call:s".into()] {
        cx.update_window(h, |_, w, cx| {
            view.update(cx, |v, cx| v.probe_scroll_to_end(cx));
            w.draw(cx).clear(cx);
            w.render_frame(cx);
            w.click(gpui_kit::SharedString::from(key), cx);
        })
        .unwrap();
        cx.run_until_parked();
    }
    cx.update_window(h, |_, w, cx| {
        view.update(cx, |v, cx| v.probe_scroll_to_end(cx));
        w.draw(cx).clear(cx);
    })
    .unwrap();
    let (block, viewport) = cx
        .update_window(h, |_, w, cx| {
            w.draw(cx).clear(cx);
            (
                w.find("body-call:s-Output").bounds(),
                w.find("viewport").bounds(),
            )
        })
        .unwrap();
    let name = mode.name();
    let (image, scale) = shot(cx, h, width);
    let shown = block.intersect(&viewport);
    assert!(
        shown.size.height > px(120.),
        "the output is in view: {block:?}"
    );
    assert_clear(&image, scale, shown, &format!("{name} tool output"));
    cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
}

pub fn run_scrollbar_track_probe(cx: &mut HeadlessAppContext) {
    // Always shown, so every state can be sampled without waiting on motion.
    cx.update(|cx| Theme::set_scrollbar_mode(ScrollbarMode::Always, cx));
    for mode in [ThemeMode::Light, ThemeMode::Dark] {
        cx.update(|cx| Theme::change(mode, None, cx));
        surface(cx, mode);
        tool_output(cx, mode);
    }
    println!("scrollbar tracks stay transparent: light/dark, rest/hover/drag, tool output");
}
