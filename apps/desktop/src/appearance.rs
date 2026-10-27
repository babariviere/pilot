//! Portable chrome tokens from Swift Theme.swift / DitherCorner.swift.
//! Bounded app-owned dither motion is implemented in dither_view, without shaders.
//! Pilot's identity comes from its icon: the dithered sky supplies the one accent,
//! and the embedded Inter / JetBrains Mono faces carry interface and code text.
use crate::settings_state::AppearancePreference;
use gpui_kit::component::{ActiveTheme, Theme, ThemeConfig, ThemeConfigColors, ThemeMode};
use gpui_kit::{App, AssetSource, SharedString, Window};
use std::{borrow::Cow, rc::Rc};

/// Interface, page-title and code families. The files are embedded (licenses/INTER.txt,
/// licenses/JETBRAINS-MONO.txt), so the identity never depends on installed fonts.
pub const UI_FONT: &str = "Inter";
pub const DISPLAY_FONT: &str = "Inter Display";
pub const CODE_FONT: &str = "JetBrains Mono";
const FONTS: [&[u8]; 9] = [
    include_bytes!("../assets/fonts/Inter-Regular.ttf"),
    include_bytes!("../assets/fonts/Inter-Italic.ttf"),
    include_bytes!("../assets/fonts/Inter-Medium.ttf"),
    include_bytes!("../assets/fonts/Inter-SemiBold.ttf"),
    include_bytes!("../assets/fonts/Inter-Bold.ttf"),
    include_bytes!("../assets/fonts/InterDisplay-SemiBold.ttf"),
    include_bytes!("../assets/fonts/JetBrainsMono-Regular.ttf"),
    include_bytes!("../assets/fonts/JetBrainsMono-Italic.ttf"),
    include_bytes!("../assets/fonts/JetBrainsMono-Bold.ttf"),
];

/// Sky accent from the app icon: its deep sky on light pages, its base sky on dark.
/// Used for commit actions (including Send), links, text selection and the caret.
/// Navigation, row selection and chat-state tints keep their own neutral/state roles.
pub(crate) struct Accent {
    pub fill: &'static str,
    pub hover: &'static str,
    pub pressed: &'static str,
    pub on_fill: &'static str,
    pub selection: &'static str,
}
pub(crate) const fn accent(dark: bool) -> Accent {
    if dark {
        Accent {
            fill: "#7db9e8",
            hover: "#93c6ee",
            pressed: "#a9d2f2",
            on_fill: "#23262c",
            selection: "#7db9e84d",
        }
    } else {
        Accent {
            fill: "#2f6fc6",
            hover: "#285fab",
            pressed: "#22518f",
            on_fill: "#ffffff",
            selection: "#2f6fc638",
        }
    }
}

#[derive(Clone, Copy, Default)]
struct CommittedAppearance(AppearancePreference);
impl gpui_kit::Global for CommittedAppearance {}

/// Whether the embedded faces registered and whether windows are glass.
#[derive(Clone, Copy, Default)]
struct Surfaces {
    fonts: bool,
    glass: bool,
}
impl gpui_kit::Global for Surfaces {}

/// Glass needs a compositor that blurs what is behind a translucent window:
/// macOS always, KWin through its blur protocol, Hyprland by default. Elsewhere
/// a translucent window would show the raw desktop, so it stays opaque.
fn glass_supported() -> bool {
    if cfg!(target_os = "macos") {
        return true;
    }
    cfg!(target_os = "linux")
        && (std::env::var("XDG_CURRENT_DESKTOP")
            .is_ok_and(|desktop| desktop.split(':').any(|d| d.eq_ignore_ascii_case("KDE")))
            || std::env::var_os("HYPRLAND_INSTANCE_SIGNATURE").is_some())
}
/// Opt the app's windows into the frosted background where the platform supports it.
/// The page and sidebar become translucent tints over the blur; cards, the composer,
/// popovers and code stay opaque. Call before opening windows.
pub fn enable_glass(cx: &mut App) {
    if glass_supported() && !glass(cx) {
        let fonts = cx.try_global::<Surfaces>().is_some_and(|s| s.fonts);
        cx.set_global(Surfaces { fonts, glass: true });
        install_configs(cx);
    }
}
pub(crate) fn glass(cx: &App) -> bool {
    cx.try_global::<Surfaces>().is_some_and(|s| s.glass)
}
/// Window background matching the active surfaces.
pub fn window_background(cx: &App) -> gpui_kit::WindowBackgroundAppearance {
    if glass(cx) {
        gpui_kit::WindowBackgroundAppearance::Blurred
    } else {
        gpui_kit::WindowBackgroundAppearance::Opaque
    }
}

fn follows_system(cx: &App) -> bool {
    cx.try_global::<CommittedAppearance>()
        .is_none_or(|policy| policy.0 == AppearancePreference::System)
}
/// Only a successfully loaded or durably acknowledged preference reaches this hook.
/// Theme::change updates Kit's tokens/Base projection and refreshes existing windows.
pub(crate) fn commit_appearance(preference: AppearancePreference, cx: &mut App) {
    cx.set_global(CommittedAppearance(preference));
    // GPUI owns the macOS NSApplication override. Clear it for System rather than
    // pinning the OS's current color; no Swift defaults or host configuration change.
    cx.set_window_appearance(match preference {
        AppearancePreference::System => None,
        AppearancePreference::Light => Some(gpui_kit::WindowAppearance::Light),
        AppearancePreference::Dark => Some(gpui_kit::WindowAppearance::Dark),
    });
    match preference {
        AppearancePreference::System => Theme::sync_system_appearance(None, cx),
        AppearancePreference::Light => Theme::change(ThemeMode::Light, None, cx),
        AppearancePreference::Dark => Theme::change(ThemeMode::Dark, None, cx),
    }
}

/// Swift Theme.Radius, picked by surface role rather than arbitrary size.
pub struct Radius;
/// Shell-only visual roles. Never reset Kit or Markdown/editor metrics globally.
pub struct Space;
impl Space {
    pub const META: f32 = 4.;
    pub const CONTROL: f32 = 8.;
    pub const SIDEBAR: f32 = 12.;
    pub const HOME: f32 = 28.;
    pub const SECTION: f32 = 28.;
    pub const ROW: f32 = 52.;
}
pub struct TextRole;
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
/// Sky-tinted neutrals: the icon's blue at very low chroma, slate "night sky" in dark.
/// The hierarchy is unchanged: darker sidebar, white/lifted editor card on a soft tray.
pub(crate) struct Palette {
    pub page: &'static str,
    pub sidebar: &'static str,
    pub ink: &'static str,
    pub meta: &'static str,
    pub muted: &'static str,
    pub selected: &'static str,
    pub border: &'static str,
    pub popover: &'static str,
    pub tray: u32,
    pub card: u32,
    pub code: u32,
}
pub(crate) const fn palette(dark: bool) -> Palette {
    if dark {
        Palette {
            page: "#23262c",
            sidebar: "#1c1f24",
            ink: "#d6dbe3",
            meta: "#a3acba",
            muted: "#c8dcff0d",
            selected: "#c8dcff17",
            border: "#c8dcff17",
            popover: "#30343b",
            tray: 0x2a2e35,
            // Lifts the editor clearly off the tray, as white does in light.
            card: 0x363b44,
            code: 0x2a2e35,
        }
    } else {
        Palette {
            page: "#ffffff",
            sidebar: "#f6f8fb",
            ink: "#1f2633",
            meta: "#5f6b7d",
            muted: "#143c780b",
            selected: "#143c7812",
            border: "#0f285019",
            popover: "#ffffff",
            tray: 0xf1f4f8,
            card: 0xffffff,
            code: 0xf6f8fb,
        }
    }
}
pub(crate) fn tray(cx: &App) -> gpui_kit::Hsla {
    gpui_kit::rgb(palette(cx.theme().is_dark()).tray).into()
}
pub(crate) fn card(cx: &App) -> gpui_kit::Hsla {
    gpui_kit::rgb(palette(cx.theme().is_dark()).card).into()
}
pub(crate) fn code(cx: &App) -> gpui_kit::Hsla {
    gpui_kit::rgb(palette(cx.theme().is_dark()).code).into()
}

fn config(dark: bool, fonts: bool, glass: bool) -> Rc<ThemeConfig> {
    let Palette {
        page,
        sidebar,
        ink,
        meta,
        muted,
        selected,
        border,
        popover: card,
        ..
    } = palette(dark);
    let error = if dark { "#f87171" } else { "#dc2626" };
    let s = |value: &'static str| Some(SharedString::from(value));
    // Over the window blur the page stays a mostly solid reading surface and the
    // sidebar lets more of the frosted desktop through. Opaque without glass.
    let (page_alpha, sidebar_alpha) = if dark { ("d9", "b3") } else { ("d1", "a6") };
    let glassy = |hex: &str, alpha: &str| {
        Some(SharedString::from(if glass {
            format!("{hex}{alpha}")
        } else {
            hex.to_owned()
        }))
    };
    let accent = accent(dark);
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
        font_family: fonts.then(|| UI_FONT.into()),
        mono_font_family: fonts.then(|| CODE_FONT.into()),
        radius: Some(Radius::CONTROL as usize),
        radius_lg: Some(Radius::CARD as usize),
        shadow: Some(false),
        colors: {
            let mut colors = ThemeConfigColors::default();
            colors.background = glassy(page, page_alpha);
            colors.foreground = s(ink);
            colors.sidebar = glassy(sidebar, sidebar_alpha);
            colors.sidebar_foreground = s(ink);
            colors.sidebar_border = s(border);
            colors.muted = s(muted);
            colors.muted_foreground = s(meta);
            colors.border = s(border);
            colors.input = s(border);
            colors.ring = s("#00000000");
            colors.primary = s(accent.fill);
            colors.primary_hover = s(accent.hover);
            colors.primary_active = s(accent.pressed);
            colors.primary_foreground = s(accent.on_fill);
            colors.caret = s(accent.fill);
            colors.secondary = s(muted);
            colors.secondary_hover = s(selected);
            colors.secondary_foreground = s(ink);
            colors.button = s(page);
            colors.button_foreground = s(ink);
            colors.button_hover = s(muted);
            colors.button_active = s(selected);
            colors.list = glassy(sidebar, sidebar_alpha);
            colors.list_active = s(muted);
            colors.list_active_border = s("#00000000");
            colors.list_hover = s(muted);
            colors.accent = s(muted);
            colors.accent_foreground = s(ink);
            colors.selection = s(accent.selection);
            colors.danger = s(error);
            colors.danger_foreground = s(page);
            colors.popover = s(card);
            colors.popover_foreground = s(ink);
            colors.link = s(accent.fill);
            colors.link_active = s(accent.pressed);
            colors.chart_1 = s(if dark { "#60A5FA" } else { "#2563EB" });
            colors.success = s(if dark { "#34D399" } else { "#047857" });
            colors.warning = s(if dark { "#FBBF24" } else { "#B45309" });
            colors.chart_2 = s(if dark { "#FBBF24" } else { "#D97706" });
            colors.chart_3 = s(if dark { "#34D399" } else { "#059669" });
            colors.chart_4 = s(if dark { "#A78BFA" } else { "#7C3AED" });
            colors.chart_5 = s(if dark { "#FB7185" } else { "#E11D48" });
            colors.link_hover = s(accent.hover);
            colors
        },
        ..Default::default()
    })
}
pub fn init_appearance(cx: &mut App) {
    cx.set_global(CommittedAppearance::default());
    crate::dither_view::prepare(cx);
    // Before any layout: an unregistered family would fall back to another face.
    let fonts = cx
        .text_system()
        .add_fonts(FONTS.iter().map(|font| Cow::Borrowed(*font)).collect())
        .is_ok();
    cx.set_global(Surfaces {
        fonts,
        glass: false,
    });
    install_configs(cx);
}
fn install_configs(cx: &mut App) {
    let Surfaces { fonts, glass } = *cx.global::<Surfaces>();
    Theme::update(cx, |theme| {
        let mut light = (*config(false, fonts, glass)).clone();
        light.highlight = theme.light_theme.highlight.clone();
        let mut dark = (*config(true, fonts, glass)).clone();
        dark.highlight = theme.dark_theme.highlight.clone();
        theme.light_theme = Rc::new(light);
        theme.dark_theme = Rc::new(dark);
        theme.focus_ring = false;
        theme.list.active_highlight = true;
    });
    match cx.global::<CommittedAppearance>().0 {
        AppearancePreference::System => Theme::sync_system_appearance(None, cx),
        AppearancePreference::Light => Theme::change(ThemeMode::Light, None, cx),
        AppearancePreference::Dark => Theme::change(ThemeMode::Dark, None, cx),
    }
}
/// Subscription belongs to this window; a committed manual choice ignores OS changes.
pub fn follow_appearance(window: &mut Window, cx: &mut App) {
    if follows_system(cx) {
        Theme::sync_system_appearance(Some(window), cx);
    }
    window
        .observe_window_appearance(|window, cx| {
            if follows_system(cx) {
                Theme::sync_system_appearance(Some(window), cx);
            }
        })
        .detach();
}
pub(crate) fn selected(cx: &App) -> gpui_kit::Hsla {
    let selected = palette(cx.theme().is_dark()).selected;
    gpui_kit::Rgba::try_from(selected)
        .unwrap_or_default()
        .into()
}
/// Selected static app glyphs plus Kit's embedded primitive icons. No external fallback.
pub struct ChromeAssets;
impl AssetSource for ChromeAssets {
    fn load(&self, path: &str) -> gpui_kit::Result<Option<Cow<'static, [u8]>>> {
        if let Some(bytes) = crate::app_icon::AppIconAssets.load(path)? {
            Ok(Some(bytes))
        } else {
            gpui_kit::assets::Assets.load(path)
        }
    }
    fn list(&self, path: &str) -> gpui_kit::Result<Vec<SharedString>> {
        let mut paths = crate::app_icon::AppIconAssets.list(path)?;
        paths.extend(gpui_kit::assets::Assets.list(path)?);
        paths.sort();
        paths.dedup();
        Ok(paths)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[gpui_kit::test]
    fn committed_manual_policy_persists_until_system_is_explicit(
        cx: &mut gpui_kit::TestAppContext,
    ) {
        cx.update(|cx| {
            gpui_kit::init(cx);
            init_appearance(cx);
            commit_appearance(AppearancePreference::Light, cx);
            assert!(!cx.theme().is_dark());
            assert!(!follows_system(cx));
            commit_appearance(AppearancePreference::Dark, cx);
            assert!(cx.theme().is_dark());
            assert!(!follows_system(cx));
            commit_appearance(AppearancePreference::System, cx);
            assert!(follows_system(cx));
        });
    }
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
            assert_eq!(config(dark, true, false).font_size, Some(14.));
            assert_eq!(config(dark, true, false).mono_font_size, Some(13.));
            assert_eq!(
                config(dark, true, false).font_family.as_deref(),
                Some(UI_FONT)
            );
            assert_eq!(
                config(dark, true, false).mono_font_family.as_deref(),
                Some(CODE_FONT)
            );
            // A failed registration keeps the platform families instead of a missing name.
            assert!(config(dark, false, false).font_family.is_none());
            assert!(config(dark, false, false).mono_font_family.is_none());
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
    fn appearance_switches_both_palettes_with_sky_accent_and_no_focus_ring(
        cx: &mut gpui_kit::TestAppContext,
    ) {
        cx.update(|cx| {
            gpui_kit::init(cx);
            init_appearance(cx);
            for mode in [ThemeMode::Dark, ThemeMode::Light, ThemeMode::Dark] {
                Theme::change(mode, None, cx);
                assert!(!cx.theme().focus_ring);
                assert_eq!(cx.theme().is_dark(), mode.is_dark());
                let accent = accent(mode.is_dark());
                let hex = |c: gpui_kit::Hsla| {
                    let c: gpui_kit::Rgba = c.into();
                    let byte = |v: f32| (v * 255.).round() as u8;
                    format!("#{:02x}{:02x}{:02x}", byte(c.r), byte(c.g), byte(c.b))
                };
                for color in [cx.theme().primary, cx.theme().link, cx.theme().caret] {
                    assert_eq!(hex(color), accent.fill);
                }
                assert_eq!(hex(cx.theme().primary_foreground), accent.on_fill);
                // Navigation and list selection keep the faint neutral wash, not the accent.
                let list: gpui_kit::Rgba = cx.theme().list_active.into();
                let muted = gpui_kit::Rgba::try_from(palette(mode.is_dark()).muted).unwrap();
                assert_eq!(hex(cx.theme().list_active), hex(muted.into()));
                assert!(list.a < 0.1);
                assert_eq!(cx.theme().ring.a, 0.);
            }
        });
    }
    #[test]
    fn glass_tints_only_page_sidebar_and_list() {
        for dark in [false, true] {
            let solid = config(dark, true, false);
            let glass = config(dark, true, true);
            let alpha = |c: &Option<SharedString>| {
                gpui_kit::Rgba::try_from(c.as_deref().unwrap()).unwrap().a
            };
            for (solid, glass) in [
                (&solid.colors.background, &glass.colors.background),
                (&solid.colors.sidebar, &glass.colors.sidebar),
                (&solid.colors.list, &glass.colors.list),
            ] {
                assert_eq!(alpha(solid), 1.);
                assert!((0.5..0.9).contains(&alpha(glass)));
            }
            // Reading surfaces and controls stay opaque over the blur.
            for color in [
                &glass.colors.popover,
                &glass.colors.button,
                &glass.colors.primary,
            ] {
                assert_eq!(alpha(color), 1.);
            }
            assert!(alpha(&glass.colors.sidebar) < alpha(&glass.colors.background));
        }
    }
    #[gpui_kit::test]
    fn glass_is_opt_in_and_keeps_the_committed_mode(cx: &mut gpui_kit::TestAppContext) {
        cx.update(|cx| {
            gpui_kit::init(cx);
            init_appearance(cx);
            assert!(!glass(cx));
            assert_eq!(
                window_background(cx),
                gpui_kit::WindowBackgroundAppearance::Opaque
            );
            commit_appearance(AppearancePreference::Dark, cx);
            enable_glass(cx);
            assert!(cx.theme().is_dark(), "glass reinstall keeps a manual mode");
            if cfg!(target_os = "macos") {
                assert!(glass(cx));
                assert_eq!(
                    window_background(cx),
                    gpui_kit::WindowBackgroundAppearance::Blurred
                );
                assert!(cx.theme().background.a < 1.);
                assert_eq!(card(cx).a, 1.);
            }
        });
    }
    #[test]
    fn accent_meets_contrast_on_pages_and_fills() {
        fn luminance(hex: &str) -> f64 {
            let v = u32::from_str_radix(&hex[1..7], 16).unwrap();
            let channel = |shift: u32| {
                let c = ((v >> shift) & 0xff) as f64 / 255.;
                if c <= 0.03928 {
                    c / 12.92
                } else {
                    ((c + 0.055) / 1.055).powf(2.4)
                }
            };
            0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0)
        }
        let ratio = |a: &str, b: &str| {
            let (a, b) = (luminance(a), luminance(b));
            (a.max(b) + 0.05) / (a.min(b) + 0.05)
        };
        for dark in [false, true] {
            let Palette {
                page,
                sidebar,
                ink,
                meta,
                tray,
                card,
                ..
            } = palette(dark);
            let tray = format!("#{tray:06x}");
            let card = format!("#{card:06x}");
            for surface in [page, sidebar, tray.as_str(), card.as_str()] {
                assert!(ratio(ink, surface) >= 7., "{ink} text on {surface}");
                assert!(ratio(meta, surface) >= 4.5, "{meta} metadata on {surface}");
            }
            assert_ne!(tray, card, "editor card stays distinct from its tray");
            let accent = accent(dark);
            for surface in [page, sidebar] {
                for color in [accent.fill, accent.hover, accent.pressed] {
                    assert!(
                        ratio(color, surface) >= 4.5,
                        "{color} link text on {surface}"
                    );
                }
            }
            for fill in [accent.fill, accent.hover, accent.pressed] {
                assert!(
                    ratio(accent.on_fill, fill) >= 4.5,
                    "{} on {fill}",
                    accent.on_fill
                );
            }
        }
    }
}
