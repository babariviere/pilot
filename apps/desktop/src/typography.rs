//! Conversation typography only. Chrome/editor metrics and native text state stay owned
//! by their existing components. No font installation or Swift preference access.
use crate::settings_state::{FontFamily, FontPreferences};
use gpui_kit::component::{
    ActiveTheme, Theme,
    text::{TextView, TextViewStyle},
};
use gpui_kit::{App, Global, SharedString, Styled, px};
use std::{rc::Rc, sync::Arc};

#[derive(Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct CommittedFonts(pub(crate) FontPreferences);
impl Global for CommittedFonts {}

struct Installed {
    names: Arc<Vec<FontFamily>>,
    ready: bool,
}
impl Global for Installed {}
struct CodeDefault {
    resolved: SharedString,
    light: Option<SharedString>,
    dark: Option<SharedString>,
}
impl Global for CodeDefault {}
/// One bounded background enumeration per app lifetime, never in rendering.
pub(crate) fn prepare(cx: &mut App) {
    if cx.try_global::<Installed>().is_some() {
        return;
    }
    cx.set_global(Installed {
        names: Arc::new(Vec::new()),
        ready: false,
    });
    let text = cx.text_system().clone();
    let task = cx.background_executor().spawn(async move {
        let mut names: Vec<_> = text
            .all_font_names()
            .into_iter()
            .filter(|s| !s.starts_with('.'))
            .filter_map(|s| FontFamily::new(&s))
            .take(4096)
            .collect();
        names.sort_by(|a, b| a.name().cmp(b.name()));
        names.dedup();
        Arc::new(names)
    });
    cx.spawn(async move |cx| {
        let names = task.await;
        cx.update(|cx| {
            cx.set_global(Installed { names, ready: true });
            let fonts = current(cx);
            if !fonts.chat_family.name().is_empty() || !fonts.code_family.name().is_empty() {
                apply_code_family(fonts, cx);
                cx.set_global(CommittedFonts(fonts));
            }
            cx.refresh_windows();
        });
    })
    .detach();
}
pub(crate) fn names(cx: &App) -> Arc<Vec<FontFamily>> {
    cx.global::<Installed>().names.clone()
}
pub(crate) fn ready(cx: &App) -> bool {
    cx.try_global::<Installed>().is_some_and(|i| i.ready)
}
pub(crate) fn available(family: FontFamily, cx: &App) -> bool {
    family.name().is_empty()
        || cx.try_global::<Installed>().is_some_and(|names| {
            names
                .names
                .binary_search_by(|f| f.name().cmp(family.name()))
                .is_ok()
        })
}
pub(crate) fn family(f: FontFamily, code: bool, cx: &App) -> SharedString {
    if !f.name().is_empty() && available(f, cx) {
        return f.name().to_owned().into();
    }
    if code {
        cx.try_global::<CodeDefault>()
            .map(|d| d.resolved.clone())
            .unwrap_or_else(|| cx.theme().mono_font_family.clone())
    } else {
        cx.theme().font_family.clone()
    }
}
pub(crate) fn current(cx: &App) -> FontPreferences {
    cx.try_global::<CommittedFonts>()
        .map(|f| f.0)
        .unwrap_or_default()
}

/// Theme configs retain only the committed code family so inline code uses the same
/// installed family as fenced code. Its existing proportional size is unchanged.
/// Body font/size is scoped to conversation text, never the app/editor root.
pub(crate) fn commit(fonts: FontPreferences, cx: &mut App) {
    prepare(cx);
    let previous = current(cx);
    if previous == fonts {
        return;
    }
    if previous.code_family != fonts.code_family {
        apply_code_family(fonts, cx);
    }
    cx.set_global(CommittedFonts(fonts));
    cx.refresh_windows();
}
fn apply_code_family(fonts: FontPreferences, cx: &mut App) {
    if cx.try_global::<CodeDefault>().is_none() {
        cx.set_global(CodeDefault {
            resolved: cx.theme().mono_font_family.clone(),
            light: cx.theme().light_theme.mono_font_family.clone(),
            dark: cx.theme().dark_theme.mono_font_family.clone(),
        });
    }
    let defaults = cx.global::<CodeDefault>();
    let chosen = (!fonts.code_family.name().is_empty() && available(fonts.code_family, cx))
        .then(|| SharedString::from(fonts.code_family.name().to_owned()));
    let light = chosen.clone().or(defaults.light.clone());
    let dark = chosen.clone().or(defaults.dark.clone());
    let resolved = chosen.unwrap_or_else(|| defaults.resolved.clone());
    Theme::update(cx, |theme| {
        let mut l = (*theme.light_theme).clone();
        l.mono_font_family = light;
        let mut d = (*theme.dark_theme).clone();
        d.mono_font_family = dark;
        theme.light_theme = Rc::new(l);
        theme.dark_theme = Rc::new(d);
        theme.mono_font_family = resolved;
    });
}

/// These are content roles, not a replacement chrome type scale or app zoom.
#[derive(Clone, Copy)]
pub(crate) enum Content {
    Chat,
    PlainChat,
    Code,
}

pub(crate) fn rich(view: TextView, fonts: FontPreferences, content: Content, cx: &App) -> TextView {
    let code_body = matches!(content, Content::Code);
    let plain_chat = matches!(content, Content::PlainChat);
    let f = if code_body {
        fonts.code_family
    } else {
        fonts.chat_family
    };
    let size = if code_body {
        fonts.code_size
    } else {
        fonts.chat_size
    };
    let mut view = view;
    if !f.name().is_empty() && available(f, cx) {
        view = view.font_family(family(f, code_body, cx));
    }
    if let Some(size) = size {
        view = view.text_size(px(size as f32 / 2.));
    }
    let mut block = gpui_kit::StyleRefinement::default();
    let block_family = if plain_chat {
        fonts.chat_family
    } else {
        fonts.code_family
    };
    let block_size = if plain_chat {
        fonts.chat_size
    } else {
        fonts.code_size
    };
    if !block_family.name().is_empty() && available(block_family, cx) {
        block = block.font_family(family(block_family, !plain_chat, cx));
    }
    if let Some(size) = block_size {
        block = block.text_size(px(size as f32 / 2.));
    }
    view.style(TextViewStyle::default().code_block(block))
}
