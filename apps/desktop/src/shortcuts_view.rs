//! Passive reference to the installed keymap, never a second dispatch owner.
use crate::ui::{self, Action, Space, Text};
use gpui_kit::{
    App, AsKeystroke, Context, FocusHandle, InteractiveElement, IntoElement, KeyBinding,
    ParentElement, Render, SharedString, Styled, TestSupportExt, Window,
    base::SelectableText,
    component::{ActiveTheme, StyledExt, kbd::Kbd, scroll::ScrollableElement},
    div, px,
};

gpui_kit::actions!(shortcuts, [OpenShortcuts, CloseShortcuts]);

struct Section {
    title: &'static str,
    note: &'static str,
    rows: Vec<(&'static str, String)>,
}

/// Read actual installed combinations, including platform resolution by ui::shortcut.
/// The descriptions are intentionally curated: a binding is not proof of availability.
fn sections(cx: &App) -> Vec<Section> {
    use super::{
        FocusChats, GoHome, NavigateBack, NavigateForward, NewChat, ShowAllChats, ShowMissions,
        SidebarCollapse, SidebarExpand, ToggleJump, conversation_links_view, queued_message_view,
        workspace_changes_view,
    };
    let mut sections = Vec::new();
    let mut section = |title, note, commands: Vec<(&'static str, Box<dyn gpui_kit::Action>)>| {
        let rows = commands
            .into_iter()
            .filter_map(|(label, action)| {
                let keymap = cx.key_bindings();
                let keymap = keymap.borrow();
                let mut keys = Vec::new();
                for binding in keymap.bindings_for_action(action.as_ref()) {
                    let mut key = binding
                        .keystrokes()
                        .iter()
                        .map(|k| Kbd::format(k.as_keystroke()))
                        .collect::<Vec<_>>()
                        .join(" ");
                    if binding
                        .predicate()
                        .is_some_and(|p| p.to_string() == "!Input")
                    {
                        key.push_str(" (outside text fields)");
                    }
                    if !keys.contains(&key) {
                        keys.push(key);
                    }
                }
                (!keys.is_empty()).then(|| (label, keys.join(" / ")))
            })
            .collect();
        sections.push(Section { title, note, rows });
    };
    section(
        "Main window",
        "Commands depend on the current view and available history. Open forms, palettes and text composition can keep their keys.",
        vec![
            ("Command Palette", Box::new(ToggleJump)),
            ("New chat", Box::new(NewChat)),
            ("Find in chat, otherwise search chats", Box::new(FocusChats)),
            (
                "Focus composer",
                Box::new(crate::transcript_view::FocusComposer),
            ),
            ("Home", Box::new(GoHome)),
            ("Chats", Box::new(ShowAllChats)),
            ("Missions", Box::new(ShowMissions)),
            ("Back", Box::new(NavigateBack)),
            ("Forward", Box::new(NavigateForward)),
            (
                "Changes, when a chat is selected",
                Box::new(workspace_changes_view::Toggle),
            ),
            (
                "Links, when a chat is selected",
                Box::new(conversation_links_view::Toggle),
            ),
            (
                "Mission details, in a mission chat",
                Box::new(crate::mission_inspector_view::Toggle),
            ),
            ("Settings", Box::new(crate::settings_view::OpenSettings)),
            (
                "Quit, after pending edits are saved",
                Box::new(crate::transcript_view::Quit),
            ),
        ],
    );
    section(
        "Sidebar list",
        "With the chat list focused, not its search field.",
        vec![
            (
                "Collapse project or mission thread",
                Box::new(SidebarCollapse),
            ),
            ("Expand project or mission thread", Box::new(SidebarExpand)),
        ],
    );
    section(
        "Settings window",
        "Save applies only when edits can be saved. Close may ask about unsaved changes.",
        vec![
            ("Save changes", Box::new(crate::settings_view::SaveSettings)),
            (
                "Close settings",
                Box::new(crate::settings_view::CloseSettings),
            ),
        ],
    );
    section(
        "Open forms",
        "Only inside the named form, when its current values can be submitted. Escape cancels that form; composition keeps its keys.",
        vec![
            (
                "Add project",
                Box::new(crate::project_add_view::ConfirmProject),
            ),
            (
                "Create mission from chat",
                Box::new(crate::mission_view::ConfirmMission),
            ),
            (
                "Save queued message edit",
                Box::new(queued_message_view::SaveQueue),
            ),
        ],
    );
    section(
        "Text fields and selection",
        "The focused text owner handles these keys. Cut, paste and undo require an editable field; copy requires a selection.",
        vec![
            ("Copy", Box::new(gpui_kit::base::input::Copy)),
            ("Select all", Box::new(gpui_kit::base::input::SelectAll)),
            ("Cut", Box::new(gpui_kit::base::input::Cut)),
            ("Paste", Box::new(gpui_kit::base::input::Paste)),
            ("Undo", Box::new(gpui_kit::base::input::Undo)),
            ("Redo", Box::new(gpui_kit::base::input::Redo)),
        ],
    );
    section(
        "This reference",
        "Text can be selected and copied. Copy reference includes every section.",
        vec![("Close reference", Box::new(CloseShortcuts))],
    );
    #[cfg(target_os = "macos")]
    section(
        "macOS windows",
        "Window commands act on the key window. Hide commands apply to the app.",
        vec![
            (
                "Minimize",
                Box::new(crate::local_view::menu_routing::Minimize),
            ),
            ("Hide Pilot Next", Box::new(crate::app_menu::Hide)),
            ("Hide other apps", Box::new(crate::app_menu::HideOthers)),
        ],
    );
    sections
}

pub(crate) struct Shortcuts {
    focus: FocusHandle,
    sections: Vec<Section>,
}
impl Shortcuts {
    pub(crate) fn new(w: &mut Window, cx: &mut Context<Self>) -> Self {
        let bindings = [
            KeyBinding::new("escape", CloseShortcuts, Some("Shortcuts")),
            ui::shortcut("secondary-w", CloseShortcuts, Some("Shortcuts"), cx),
        ];
        cx.bind_keys(bindings);
        let focus = cx.focus_handle().tab_stop(true);
        focus.focus(w, cx);
        Self {
            focus,
            sections: sections(cx),
        }
    }
    fn copy_text(&self) -> String {
        let mut text = String::from("Keyboard shortcuts\n");
        for section in &self.sections {
            text.push_str(&format!("\n{}\n{}\n", section.title, section.note));
            for (label, keys) in &section.rows {
                text.push_str(&format!("{label}: {keys}\n"));
            }
        }
        text
    }
}
impl Render for Shortcuts {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let mut page = ui::page().child(
            ui::header("shortcuts-title", "Keyboard shortcuts", Text::Title)
                .child(ui::text(Text::Body, "Common shortcuts for this platform. Contextual keys work only in their named view."))
                .child(div().h_flex().gap_2()
                    .child(ui::action("shortcuts-copy", "Copy reference", Action::Quiet)
                        .on_click(cx.listener(|v, _, _, cx| cx.write_to_clipboard(gpui_kit::ClipboardItem::new_string(v.copy_text())))))
                    .child(ui::action("shortcuts-close", "Close", Action::Quiet)
                        .on_click(|_, w, _| w.remove_window()))),
        );
        for section in &self.sections {
            let mut group = div()
                .v_flex()
                .gap(px(Space::CONTROL))
                .child(ui::heading(section.title, section.title, Text::Headline))
                .child(
                    ui::text(Text::Caption, section.note).text_color(cx.theme().muted_foreground),
                );
            for (label, keys) in &section.rows {
                group = group.child(
                    div()
                        .h_flex()
                        .justify_between()
                        .gap_4()
                        .min_w_0()
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .child(SelectableText::new(*label, *label)),
                        )
                        .child(
                            div()
                                .id(SharedString::from(format!("keys-{label}")))
                                .test_support()
                                .flex_shrink_0()
                                .child(SelectableText::new(
                                    SharedString::from(format!("keys-{label}")),
                                    SharedString::from(keys.clone()),
                                )),
                        ),
                );
            }
            page = page.child(group);
        }
        crate::local_view::menu_routing::window_commands(div())
            .id("shortcuts-root")
            .test_support()
            .key_context("Shortcuts")
            .track_focus(&self.focus)
            .size_full()
            .bg(cx.theme().background)
            .text_color(cx.theme().foreground)
            .on_action(|_: &CloseShortcuts, w, _| w.remove_window())
            .on_action(|_: &crate::transcript_view::Quit, _, cx| {
                crate::local_view::menu_routing::quit(cx)
            })
            .child(
                div()
                    .id("shortcuts-scroll")
                    .size_full()
                    .overflow_y_scrollbar()
                    .child(page),
            )
    }
}

#[cfg(feature = "native-probes")]
#[path = "shortcuts_probe.rs"]
pub(crate) mod probe;

#[cfg(test)]
mod tests {
    use super::*;

    #[gpui_kit::test]
    fn reference_reads_installed_keys_and_omits_unbound_commands(
        cx: &mut gpui_kit::TestAppContext,
    ) {
        cx.update(|cx| {
            gpui_kit::init(cx);
            crate::LocalViewer::bind_keys(cx);
            crate::TranscriptView::bind_keys(cx);
            let reference = sections(cx);
            let main = &reference[0];
            let palette = main.rows.iter().find(|r| r.0 == "Command Palette").unwrap();
            let binding = ui::shortcut("secondary-k", super::super::ToggleJump, None, cx);
            assert_eq!(
                palette.1,
                Kbd::format(binding.keystrokes()[0].as_keystroke())
            );
            assert!(
                reference
                    .iter()
                    .find(|s| s.title == "Sidebar list")
                    .unwrap()
                    .note
                    .contains("not its search field")
            );
            assert!(
                reference
                    .iter()
                    .find(|s| s.title == "Settings window")
                    .unwrap()
                    .note
                    .contains("only when")
            );
            #[cfg(target_os = "macos")]
            assert!(
                main.rows
                    .iter()
                    .find(|r| r.0 == "Back")
                    .unwrap()
                    .1
                    .contains("outside text fields")
            );
            // The reference cannot invent a key when a command is not installed.
            cx.clear_key_bindings();
            cx.bind_keys([KeyBinding::new("f6", super::super::ToggleJump, None)]);
            let reference = sections(cx);
            assert_eq!(reference[0].rows, [("Command Palette", "F6".into())]);
            assert!(reference.iter().skip(1).all(|s| s.rows.is_empty()));
        });
    }
}
