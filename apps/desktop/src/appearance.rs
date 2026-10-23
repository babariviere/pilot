//! Portable chrome tokens from Swift Theme.swift / DitherCorner.swift.
//! Bounded app-owned dither motion is implemented in dither_view, without shaders.
use gpui_kit::component::{ActiveTheme, Theme, ThemeConfig, ThemeConfigColors, ThemeMode};
use gpui_kit::{App, AssetSource, SharedString, Window};
use std::{borrow::Cow, rc::Rc};

/// Swift Theme.Radius, picked by surface role rather than arbitrary size.
pub(crate) struct Radius;
/// Shell-only visual roles. Never reset Kit or Markdown/editor metrics globally.
pub(crate) struct Space;
impl Space {
    pub const META: f32 = 4.;
    pub const CONTROL: f32 = 8.;
    pub const SIDEBAR: f32 = 12.;
    pub const HOME: f32 = 28.;
    pub const SECTION: f32 = 28.;
    pub const ROW: f32 = 52.;
}
pub(crate) struct TextRole;
impl TextRole {
    pub const DISPLAY: f32 = 26.;
    pub const TITLE: f32 = 22.;
    pub const HEADLINE: f32 = 15.;
    pub const BODY: f32 = 13.;
    pub const LABEL: f32 = 12.;
    pub const CAPTION: f32 = 11.;
    pub const SMALL: f32 = 10.;
}
pub(crate) fn hairline(window: &Window) -> gpui_kit::Pixels {
    gpui_kit::px(1. / window.scale_factor().max(1.))
}
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
            colors.chart_1 = s(if dark { "#60A5FA" } else { "#2563EB" });
            colors.success = s(if dark { "#34D399" } else { "#047857" });
            colors.warning = s(if dark { "#FBBF24" } else { "#B45309" });
            colors.chart_2 = s(if dark { "#FBBF24" } else { "#D97706" });
            colors.chart_3 = s(if dark { "#34D399" } else { "#059669" });
            colors.chart_4 = s(if dark { "#A78BFA" } else { "#7C3AED" });
            colors.chart_5 = s(if dark { "#FB7185" } else { "#E11D48" });
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
    fn shell_roles_leave_global_type_and_surface_metrics_unchanged() {
        assert_eq!(
            [
                Space::META,
                Space::CONTROL,
                Space::SIDEBAR,
                Space::HOME,
                Space::SECTION,
                Space::ROW
            ],
            [4., 8., 12., 28., 28., 52.]
        );
        assert_eq!(
            [
                TextRole::DISPLAY,
                TextRole::TITLE,
                TextRole::HEADLINE,
                TextRole::BODY,
                TextRole::LABEL,
                TextRole::CAPTION,
                TextRole::SMALL
            ],
            [26., 22., 15., 13., 12., 11., 10.]
        );
        for dark in [false, true] {
            assert_eq!(config(dark).font_size, Some(14.));
            assert_eq!(config(dark).mono_font_size, Some(13.));
        }
        assert_eq!(Radius::TRAY, 14.);
    }
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
