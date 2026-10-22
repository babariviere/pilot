//! Portable chrome tokens from Swift Theme.swift / DitherCorner.swift.
//! Bounded app-owned dither motion is implemented in dither_view, without shaders.
use gpui_kit::component::{ActiveTheme, Theme, ThemeConfig, ThemeConfigColors, ThemeMode};
use gpui_kit::{App, AssetSource, SharedString, Window};
use std::{borrow::Cow, rc::Rc};

/// Swift Theme.Radius, picked by surface role rather than arbitrary size.
pub(crate) struct Radius;
impl Radius {
    pub const SMALL: f32 = 4.;
    pub const ROW: f32 = 6.;
    pub const CONTROL: f32 = 8.;
    pub const CARD: f32 = 10.;
    pub const BUBBLE: f32 = 12.;
    pub const TRAY: f32 = 14.;
}
pub(crate) fn tray(cx: &App) -> gpui_kit::Hsla {
    gpui_kit::rgb(if cx.theme().is_dark() {
        0x2c2c2c
    } else {
        0xf5f5f5
    })
    .into()
}
pub(crate) fn card(cx: &App) -> gpui_kit::Hsla {
    gpui_kit::rgb(if cx.theme().is_dark() {
        0x303030
    } else {
        0xffffff
    })
    .into()
}
pub(crate) fn code(cx: &App) -> gpui_kit::Hsla {
    gpui_kit::rgb(if cx.theme().is_dark() {
        0x2c2c2c
    } else {
        0xfafafa
    })
    .into()
}

fn config(dark: bool) -> Rc<ThemeConfig> {
    let (page, sidebar, ink, meta, muted, selected, border, card, error) = if dark {
        (
            "#262626",
            "#202020",
            "#d4d4d4",
            "#9a9a9a",
            "#ffffff0d",
            "#ffffff14",
            "#ffffff14",
            "#303030",
            "#f87171",
        )
    } else {
        (
            "#ffffff",
            "#fafafa",
            "#262626",
            "#6b6b6b",
            "#0000000a",
            "#0000000f",
            "#00000014",
            "#ffffff",
            "#dc2626",
        )
    };
    let s = |value: &'static str| Some(SharedString::from(value));
    Rc::new(ThemeConfig {
        name: if dark {
            "Desktop dark".into()
        } else {
            "Desktop light".into()
        },
        mode: if dark {
            ThemeMode::Dark
        } else {
            ThemeMode::Light
        },
        font_size: Some(14.),
        mono_font_size: Some(13.),
        radius: Some(Radius::CONTROL as usize),
        radius_lg: Some(Radius::CARD as usize),
        shadow: Some(false),
        colors: {
            let mut colors = ThemeConfigColors::default();
            colors.background = s(page);
            colors.foreground = s(ink);
            colors.sidebar = s(sidebar);
            colors.sidebar_foreground = s(ink);
            colors.sidebar_border = s(border);
            colors.muted = s(muted);
            colors.muted_foreground = s(meta);
            colors.border = s(border);
            colors.input = s(border);
            colors.ring = s("#00000000");
            colors.primary = s(ink);
            colors.primary_hover = s(ink);
            colors.primary_active = s(ink);
            colors.primary_foreground = s(page);
            colors.secondary = s(muted);
            colors.secondary_hover = s(selected);
            colors.secondary_foreground = s(ink);
            colors.button = s(page);
            colors.button_foreground = s(ink);
            colors.button_hover = s(muted);
            colors.button_active = s(selected);
            colors.list = s(sidebar);
            colors.list_active = s(muted);
            colors.list_active_border = s("#00000000");
            colors.list_hover = s(muted);
            colors.accent = s(muted);
            colors.accent_foreground = s(ink);
            colors.selection = s(if dark { "#ffffff26" } else { "#0000001f" });
            colors.danger = s(error);
            colors.danger_foreground = s(page);
            colors.popover = s(card);
            colors.popover_foreground = s(ink);
            colors.link = s(ink);
            colors.link_hover = s(ink);
            colors
        },
        ..Default::default()
    })
}
pub fn init_appearance(cx: &mut App) {
    crate::dither_view::prepare(cx);
    Theme::update(cx, |theme| {
        let mut light = (*config(false)).clone();
        light.highlight = theme.light_theme.highlight.clone();
        let mut dark = (*config(true)).clone();
        dark.highlight = theme.dark_theme.highlight.clone();
        theme.light_theme = Rc::new(light);
        theme.dark_theme = Rc::new(dark);
        theme.focus_ring = false;
        theme.list.active_highlight = true;
    });
    Theme::sync_system_appearance(None, cx);
}
/// Subscription belongs to this window. No polling or persisted appearance override.
pub fn follow_appearance(window: &mut Window, cx: &mut App) {
    Theme::sync_system_appearance(Some(window), cx);
    window
        .observe_window_appearance(|window, cx| Theme::sync_system_appearance(Some(window), cx))
        .detach();
}
pub(crate) fn selected(cx: &App) -> gpui_kit::Hsla {
    if cx.theme().is_dark() {
        gpui_kit::rgba(0xffffff14).into()
    } else {
        gpui_kit::rgba(0x0000000f).into()
    }
}
/// Embedded Kit icons only. Dither frames are trusted app-owned native cells.
pub struct ChromeAssets;
impl AssetSource for ChromeAssets {
    fn load(&self, path: &str) -> gpui_kit::Result<Option<Cow<'static, [u8]>>> {
        gpui_kit::assets::Assets.load(path)
    }
    fn list(&self, path: &str) -> gpui_kit::Result<Vec<SharedString>> {
        gpui_kit::assets::Assets.list(path)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn radii_and_embedded_assets_do_not_introduce_external_fallback() {
        assert_eq!(
            [
                Radius::SMALL,
                Radius::ROW,
                Radius::CONTROL,
                Radius::CARD,
                Radius::BUBBLE,
                Radius::TRAY
            ],
            [4., 6., 8., 10., 12., 14.]
        );
        assert!(!matches!(
            ChromeAssets.load("file:///private/unsupported"),
            Ok(Some(_))
        ));
    }
    #[gpui_kit::test]
    fn appearance_switches_both_palettes_without_blue_focus(cx: &mut gpui_kit::TestAppContext) {
        cx.update(|cx| {
            gpui_kit::init(cx);
            init_appearance(cx);
            for mode in [ThemeMode::Dark, ThemeMode::Light, ThemeMode::Dark] {
                Theme::change(mode, None, cx);
                assert!(!cx.theme().focus_ring);
                assert_eq!(cx.theme().is_dark(), mode.is_dark());
                let p: gpui_kit::Rgba = cx.theme().primary.into();
                assert_eq!(p.r, p.g);
                assert_eq!(p.g, p.b);
                assert_eq!(cx.theme().ring.a, 0.);
            }
        });
    }
}
