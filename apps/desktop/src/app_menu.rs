//! Native macOS menus. Editing remains owned by the focused Kit control.
use crate::local_view::menu_routing::{Minimize, Zoom, main_window};
use gpui_kit::base::input::{Copy, Cut, Paste, Redo, SelectAll, Undo};
use gpui_kit::{App, Global, KeyBinding, Menu, MenuItem, OsAction, SystemMenuType};

gpui_kit::actions!(application_menu, [About, Hide, HideOthers, ShowAll]);

/// Install platform menus after Kit and application keybindings are initialized.
pub fn init(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("cmd-h", Hide, None),
        KeyBinding::new("cmd-alt-h", HideOthers, None),
        KeyBinding::new("cmd-m", Minimize, None),
    ]);
    // App-wide commands only. Minimize and Zoom live on each window root
    // (menu_routing::window_commands), so they are disabled without a key window.
    cx.on_action(|_: &Hide, cx| cx.hide());
    cx.on_action(|_: &HideOthers, cx| cx.hide_other_apps());
    cx.on_action(|_: &ShowAll, cx| cx.unhide_other_apps());
    cx.on_action(|_: &About, cx| cx.defer(show_about));
    cx.set_menus(menus());
}

/// Set while the About alert is open, so a repeat request does not queue another sheet.
struct AboutOpen;
impl Global for AboutOpen {}

/// Deferred: the window that dispatched About is borrowed during dispatch.
fn show_about(cx: &mut App) {
    if cx.has_global::<AboutOpen>() {
        return;
    }
    let Some(window) = cx.active_window().or_else(|| main_window(cx)) else {
        return;
    };
    let answer = window.update(cx, |_, w, cx| {
        w.activate_window();
        // Platform alert, not a new application window or a second UI owner.
        w.prompt(
            gpui_kit::PromptLevel::Info,
            "Pilot Next",
            Some("Experimental native desktop app.\nThe original Pilot app remains available."),
            &["OK"],
            cx,
        )
    });
    if let Ok(answer) = answer {
        cx.set_global(AboutOpen);
        cx.spawn(async move |cx| {
            let _ = answer.await;
            cx.update(|cx| {
                if cx.has_global::<AboutOpen>() {
                    cx.remove_global::<AboutOpen>();
                }
            });
        })
        .detach();
    }
}

fn menus() -> Vec<Menu> {
    use crate::local_view::{
        GoHome, NavigateBack, NavigateForward, NewChat, ShowAllChats, ShowMissions, ToggleJump,
    };
    vec![
        Menu::new("Pilot Next").items([
            MenuItem::action("About Pilot Next", About),
            MenuItem::separator(),
            MenuItem::action("Settings…", crate::settings_view::OpenSettings),
            MenuItem::separator(),
            MenuItem::os_submenu("Services", SystemMenuType::Services),
            MenuItem::separator(),
            MenuItem::action("Hide Pilot Next", Hide),
            MenuItem::action("Hide Others", HideOthers),
            MenuItem::action("Show All", ShowAll),
            MenuItem::separator(),
            // Reuse LocalViewer's settings/draft flush, never bypass it with cx.quit().
            MenuItem::action("Quit Pilot Next", crate::transcript_view::Quit),
        ]),
        Menu::new("File").items([MenuItem::action("New Chat", NewChat)]),
        Menu::new("Edit").items([
            MenuItem::os_action("Undo", Undo, OsAction::Undo),
            MenuItem::os_action("Redo", Redo, OsAction::Redo),
            MenuItem::separator(),
            MenuItem::os_action("Cut", Cut, OsAction::Cut),
            MenuItem::os_action("Copy", Copy, OsAction::Copy),
            MenuItem::os_action("Paste", Paste, OsAction::Paste),
            MenuItem::os_action("Select All", SelectAll, OsAction::SelectAll),
        ]),
        Menu::new("Go").items([
            MenuItem::action("Back", NavigateBack),
            MenuItem::action("Forward", NavigateForward),
            MenuItem::separator(),
            MenuItem::action("Home", GoHome),
            MenuItem::action("Chats", ShowAllChats),
            MenuItem::action("Missions", ShowMissions),
            MenuItem::separator(),
            MenuItem::action("Jump to…", ToggleJump),
        ]),
        Menu::new("Window").items([
            MenuItem::action("Minimize", Minimize),
            MenuItem::action("Zoom", Zoom),
        ]),
    ]
}

#[cfg(feature = "native-probes")]
#[path = "app_menu_native.rs"]
mod native;
/// Verify the actual NSMenu without displaying or activating a window.
#[cfg(feature = "native-probes")]
pub fn run_native_probe() {
    native::run();
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn menu_actions_keep_focused_editing_and_guarded_quit() {
        let menus = menus();
        assert_eq!(
            menus.iter().map(|m| m.name.as_ref()).collect::<Vec<_>>(),
            ["Pilot Next", "File", "Edit", "Go", "Window"]
        );
        let edit = &menus[2];
        let actions: Vec<_> = edit
            .items
            .iter()
            .filter_map(|item| match item {
                MenuItem::Action {
                    action, os_action, ..
                } => Some((action.name(), os_action.is_some())),
                _ => None,
            })
            .collect();
        assert_eq!(actions.len(), 6);
        assert!(actions.iter().all(|(_, os)| *os));
        assert!(
            matches!(menus[0].items.last(), Some(MenuItem::Action { action, .. }) if action.as_any().is::<crate::transcript_view::Quit>())
        );
        // Window commands are the window-scoped actions, never app-wide no-ops.
        let window: Vec<_> = menus[4]
            .items
            .iter()
            .filter_map(|item| match item {
                MenuItem::Action { action, .. } => Some(action.as_any().type_id()),
                _ => None,
            })
            .collect();
        assert_eq!(
            window,
            [
                std::any::TypeId::of::<Minimize>(),
                std::any::TypeId::of::<Zoom>()
            ]
        );
        assert!(menus.iter().flat_map(|m| &m.items).all(|item| match item {
            MenuItem::Action { name, .. } =>
                !name.contains("Send") && !name.contains("Stop") && !name.contains("Terminal"),
            _ => true,
        }));
    }
}
