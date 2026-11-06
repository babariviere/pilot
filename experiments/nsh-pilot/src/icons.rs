//! Lucide glyphs matching Pilot's app_icon.rs. License: apps/desktop/licenses/LUCIDE.txt.
use nsh_core::{
    element::{ImageSrc, Svg},
    prelude::*,
};

pub(crate) fn icon(name: &str) -> Svg {
    let source = match name {
        "home" => include_str!("../icons/house.svg"),
        "inbox" => include_str!("../icons/inbox.svg"),
        "review" => include_str!("../icons/git-compare.svg"),
        "missions" => include_str!("../icons/compass.svg"),
        "automations" => include_str!("../icons/clock.svg"),
        "projects" => include_str!("../icons/folders.svg"),
        "chats" => include_str!("../icons/messages-square.svg"),
        "new" => include_str!("../icons/square-pen.svg"),
        "down" => include_str!("../icons/chevron-down.svg"),
        "right" => include_str!("../icons/chevron-right.svg"),
        "send" => include_str!("../icons/arrow-up.svg"),
        "latest" => include_str!("../icons/arrow-down.svg"),
        "settings" => include_str!("../icons/settings.svg"),
        "stop" => include_str!("../icons/square.svg"),
        "search" => include_str!("../icons/search.svg"),
        "pin" => include_str!("../icons/pin.svg"),
        "more" => include_str!("../icons/ellipsis.svg"),
        "working" => include_str!("../icons/circle.svg"),
        _ => include_str!("../icons/paperclip.svg"),
    };
    svg(ImageSrc::svg_markup(source)).size(px(16.))
}
