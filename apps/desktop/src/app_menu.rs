//! Native macOS menus. Editing remains owned by the focused Kit control.
use crate::local_client::ConnectedDaemon;
use crate::local_view::menu_routing::{Minimize, Zoom, connected_daemon, main_window};
use crate::running_identity::{RunningApp, daemon_display};
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

/// One labeled row each for this app and the daemon it is connected to.
fn about_detail(app: &RunningApp, daemon: &ConnectedDaemon) -> String {
    let app = app.display();
    let daemon = daemon_display(daemon);
    format!("Pilot Next: {app}\nDaemon: {daemon}")
}

/// Deferred: the window that dispatched About is borrowed during dispatch.
fn show_about(cx: &mut App) {
    if cx.has_global::<AboutOpen>() {
        return;
    }
    let Some(window) = cx.active_window().or_else(|| main_window(cx)) else {
        return;
    };
    let detail = about_detail(&RunningApp::current(), &connected_daemon(cx));
    let answer = window.update(cx, |_, w, cx| {
        w.activate_window();
        // Platform alert, not a new application window or a second UI owner.
        w.prompt(
            gpui_kit::PromptLevel::Info,
            "Pilot Next",
            Some(&detail),
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

    fn release(build: Option<&str>) -> RunningApp {
        RunningApp {
            version: "1.92.0".into(),
            build: build.map(Into::into),
        }
    }

    #[test]
    fn about_names_the_running_app_and_the_connected_daemon_separately() {
        // A different daemon is shown as itself, never assumed to match the app.
        assert_eq!(
            about_detail(
                &release(Some("4210.1")),
                &ConnectedDaemon::Connected(Some("1.91.0".into()))
            ),
            "Pilot Next: 1.92.0 (Build 4210.1)\nDaemon: 1.91.0"
        );
        // An older daemon without a usable version is unknown, not the app's version.
        assert_eq!(
            about_detail(&release(Some("4210.1")), &ConnectedDaemon::Connected(None)),
            "Pilot Next: 1.92.0 (Build 4210.1)\nDaemon: Version unknown"
        );
        assert_eq!(
            about_detail(&release(None), &ConnectedDaemon::NotConnected),
            "Pilot Next: 1.92.0 (development build)\nDaemon: Not connected"
        );
    }

    #[test]
    fn about_app_row_is_the_compiled_binary_not_a_bundle_on_disk() {
        // Both values are compile-time constants of this executable, so an update
        // that replaces the app bundle cannot change what the running app reports.
        let package: serde_json::Value =
            serde_json::from_str(include_str!("../../../package.json")).unwrap();
        let app = RunningApp::current();
        assert_eq!(app.version, package["version"].as_str().unwrap());
        assert_eq!(
            app.build.as_deref(),
            option_env!("PILOT_NEXT_UPDATER_BUILD")
                .filter(|_| pilot_desktop_updater::helper::compiled_trust().is_ok())
        );
    }

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
