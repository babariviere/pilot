//! Static glyph paint proof, separate from production-root interaction checks.
use crate::app_icon::AppIcon;
use gpui_kit::{
    AppContext, Bounds, Context, HeadlessAppContext, InteractiveElement, IntoElement,
    ParentElement, Render, SharedString, Styled, TestSupportExt, Window, WindowBounds,
    WindowOptions,
    component::{ActiveTheme, StyledExt, Theme, ThemeMode},
    div, px, size,
};

pub(crate) fn assert_painted(
    bounds: Bounds<gpui_kit::Pixels>,
    scale: f32,
    name: &str,
    mut pixel: impl FnMut(u32, u32) -> [u8; 4],
) {
    let (mut low, mut high) = (u16::MAX, 0);
    for y in (f32::from(bounds.top()) * scale).ceil() as u32
        ..(f32::from(bounds.bottom()) * scale).floor() as u32
    {
        for x in (f32::from(bounds.left()) * scale).ceil() as u32
            ..(f32::from(bounds.right()) * scale).floor() as u32
        {
            let p = pixel(x, y);
            let value = u16::from(p[0]) + u16::from(p[1]) + u16::from(p[2]);
            low = low.min(value);
            high = high.max(value);
        }
    }
    assert!(
        high.saturating_sub(low) > 48,
        "{name} must paint strokes, not only allocate bounds"
    );
}

struct IconBoard;
impl Render for IconBoard {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .v_flex()
            .size_full()
            .p_4()
            .bg(cx.theme().background)
            .text_color(cx.theme().foreground)
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .w_full()
                    .min_w_0()
                    .gap_3()
                    .children(AppIcon::ALL.iter().map(|role| {
                        div()
                            .v_flex()
                            .w_32()
                            .gap_2()
                            .p_2()
                            .child(
                                div()
                                    .id(SharedString::from(format!("glyph-{role:?}")))
                                    .test_support()
                                    .size_4()
                                    .child(role.icon()),
                            )
                            .child(
                                div()
                                    .text_xs()
                                    .child(SharedString::from(format!("{role:?}"))),
                            )
                    })),
            )
    }
}
pub fn run_icon_probe(cx: &mut HeadlessAppContext) {
    let captures = std::env::var_os("PILOT_NEXT_ICON_DIR").map(std::path::PathBuf::from);
    if let Some(dir) = &captures {
        std::fs::create_dir_all(dir).unwrap();
    }
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            cx.update(|cx| Theme::change(mode, None, cx));
            let (h, _) = cx
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
                        |_, cx| cx.new(|_| IconBoard),
                    )
                })
                .unwrap();
            cx.run_until_parked();
            let bounds = cx
                .update_window(h, |_, w, cx| {
                    use gpui_kit::test::TestWindowExt;
                    w.render_frame(cx);
                    AppIcon::ALL
                        .iter()
                        .map(|role| {
                            let b = w.find(format!("glyph-{role:?}")).bounds();
                            assert_eq!(b.size, size(w.rem_size(), w.rem_size()));
                            assert!(
                                b.left() >= px(0.)
                                    && b.right() <= px(width)
                                    && b.bottom() <= px(760.)
                            );
                            (format!("{role:?}"), b)
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap();
            let image = cx.capture_screenshot(h).unwrap();
            let scale = image.width() as f32 / width;
            for (name, b) in bounds {
                assert_painted(b, scale, &name, |x, y| image.get_pixel(x, y).0);
            }
            if let Some(dir) = &captures {
                image
                    .save(dir.join(format!("glyphs-{}-{}.png", width as u32, mode.name())))
                    .unwrap();
            }
            println!(
                "icon glyph paint: {} roles at {width} {}",
                AppIcon::ALL.len(),
                mode.name()
            );
            cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
            cx.run_until_parked();
        }
    }
}
