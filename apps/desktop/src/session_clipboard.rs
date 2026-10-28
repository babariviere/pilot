//! Swift `SessionClipboardActions`: copy a chat's session folder or Pilot link from
//! cached summary metadata. No lookup, I/O or mutation; a value the daemon did not
//! supply stays unavailable rather than being derived from cwd, project or title.
use crate::local_model::Chat;
use gpui_kit::{
    ClipboardItem, SharedString,
    component::menu::{PopupMenu, PopupMenuItem},
};
use serde_json::Value;

/// The daemon-reported session storage folder (`sessionPath`), absolute only.
pub(crate) fn path(raw: &Value) -> Option<String> {
    raw["sessionPath"]
        .as_str()
        .filter(|p| p.starts_with('/') && !p.contains('\0'))
        .map(str::to_owned)
}

/// Swift `DiagnosticTargetReference.chatURL`: `pilot://chat/<uuid>` in canonical
/// lowercase. Other IDs get no link rather than a case-changed or synthetic one.
pub(crate) fn link(chat: &Chat) -> Option<String> {
    (!chat.local_draft && canonical_uuid(&chat.id)).then(|| format!("pilot://chat/{}", chat.id))
}

fn canonical_uuid(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(ix, b)| match ix {
            8 | 13 | 18 | 23 => b == b'-',
            _ => b.is_ascii_digit() || (b'a'..=b'f').contains(&b),
        })
}

/// Appends both copy actions for this exact chat; without its summary both are
/// unavailable. Drafts are not sessions yet, so they get neither.
pub(crate) fn items(menu: PopupMenu, chat: Option<&Chat>) -> PopupMenu {
    if chat.is_some_and(|c| c.local_draft) {
        return menu;
    }
    menu.separator()
        .item(item(
            "Copy session path",
            chat.and_then(|c| c.session_path.clone()),
        ))
        .item(item("Copy session link", chat.and_then(link)))
}

fn item(label: &'static str, value: Option<String>) -> PopupMenuItem {
    let label = match value {
        Some(_) => SharedString::from(label),
        None => SharedString::from(format!("{label} (Unavailable)")),
    };
    PopupMenuItem::new(label)
        .disabled(value.is_none())
        .on_click(move |_, _, cx| {
            if let Some(value) = &value {
                cx.write_to_clipboard(ClipboardItem::new_string(value.clone()));
            }
        })
}

#[cfg(test)]
#[path = "session_clipboard_tests.rs"]
mod tests;
