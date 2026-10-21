//! Portable chrome tokens from Theme.swift / DitherCorner.swift at 04830d53.
//! Static Bayer masks deliberately add no animation clock, shader or external assets.
use gpui_kit::component::{ActiveTheme, Theme, ThemeConfig, ThemeConfigColors, ThemeMode};
use gpui_kit::{App, AssetSource, SharedString, Styled, Window, px, svg};
use std::{borrow::Cow, rc::Rc, sync::OnceLock};

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
        radius: Some(6),
        radius_lg: Some(10),
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
#[derive(Clone, Copy)]
pub(crate) enum Corner {
    Working,
    Failed,
}
impl Corner {
    fn path(self) -> &'static str {
        match self {
            Self::Working => "chrome/working.svg",
            Self::Failed => "chrome/failed.svg",
        }
    }
    fn index(self) -> usize {
        match self {
            Self::Working => 0,
            Self::Failed => 1,
        }
    }
}
const BAYER: [u8; 64] = [
    0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60,
    28, 52, 20, 62, 30, 54, 22, 3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15,
    47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21,
];
fn mask(corner: Corner) -> Vec<u8> {
    let mut out = String::from(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"104\" height=\"48\" viewBox=\"0 0 104 48\"><path fill=\"black\" d=\"",
    );
    for y in 0..24 {
        for x in 0..52 {
            let dx = (51.5 - x as f64) / 46.;
            let dy = (23.5 - y as f64) / 25.;
            let f = (1. - dx.hypot(dy)).max(0.);
            let amount = f
                * f
                * (3. - 2. * f)
                * match corner {
                    Corner::Working => 0.55,
                    Corner::Failed => 0.68,
                };
            if (BAYER[(y % 8) * 8 + x % 8] as f64 + 0.5) / 64. < amount {
                use std::fmt::Write;
                write!(out, "M{} {}h2v2h-2z", x * 2, y * 2).unwrap();
            }
        }
    }
    out.push_str("\"/></svg>");
    out.into_bytes()
}
static MASKS: [OnceLock<Vec<u8>>; 2] = [OnceLock::new(), OnceLock::new()];
/// Two bounded application-owned SVG masks; fallback is Kit's embedded icon bundle only.
pub struct ChromeAssets;
impl AssetSource for ChromeAssets {
    fn load(&self, path: &str) -> gpui_kit::Result<Option<Cow<'static, [u8]>>> {
        for corner in [Corner::Working, Corner::Failed] {
            if path == corner.path() {
                return Ok(Some(Cow::Borrowed(
                    MASKS[corner.index()]
                        .get_or_init(|| mask(corner))
                        .as_slice(),
                )));
            }
        }
        gpui_kit::assets::Assets.load(path)
    }
    fn list(&self, path: &str) -> gpui_kit::Result<Vec<SharedString>> {
        let mut list = gpui_kit::assets::Assets.list(path)?;
        list.extend(
            [Corner::Working, Corner::Failed]
                .into_iter()
                .map(Corner::path)
                .filter(|p| p.starts_with(path))
                .map(Into::into),
        );
        Ok(list)
    }
}
pub(crate) fn corner(kind: Corner, _cx: &App) -> gpui_kit::Svg {
    let tint: gpui_kit::Hsla = match kind {
        Corner::Working => gpui_kit::rgb(0x6366f1).into(),
        Corner::Failed => gpui_kit::rgb(0xef4444).into(),
    };
    svg()
        .path(kind.path())
        .w(px(104.))
        .h(px(48.))
        .absolute()
        .bottom_0()
        .right_0()
        .text_color(tint)
        .opacity(0.4)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn masks_are_static_bounded_and_asset_paths_have_no_external_fallback() {
        let a = ChromeAssets.load(Corner::Working.path()).unwrap().unwrap();
        let b = ChromeAssets.load(Corner::Working.path()).unwrap().unwrap();
        assert_eq!(a.as_ptr(), b.as_ptr());
        assert!(a.len() < 16 * 1024);
        let f = mask(Corner::Failed);
        assert!(f.len() > a.len() && f.len() < 16 * 1024);
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
