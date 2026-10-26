//! Font controls compose the existing explicit Save/Revert preferences owner.
use crate::{
    settings_state::{FontFamily, FontPreferences},
    settings_view::SettingsView,
    ui::{self, Action, FieldLayout, FieldRow, Notice, Text, Tone},
};
use gpui_kit::component::{
    Disableable, Sizable, StyledExt,
    button::ButtonGroup,
    menu::{DropdownMenu, PopupMenuItem},
};
use gpui_kit::{Context, ParentElement, SharedString, Styled, div, prelude::FluentBuilder};

impl SettingsView {
    pub(super) fn font_controls(
        &self,
        code: bool,
        fonts: FontPreferences,
        disabled: bool,
        wide: bool,
        cx: &mut Context<Self>,
    ) -> gpui_kit::Div {
        let prefix = if code { "code" } else { "chat" };
        let title = if code { "Code and tool output" } else { "Chat" };
        let family = if code {
            fonts.code_family
        } else {
            fonts.chat_family
        };
        let size = if code {
            fonts.code_size
        } else {
            fonts.chat_size
        };
        let label = if family.name().is_empty() {
            "App default"
        } else {
            family.name()
        };
        let names = crate::typography::names(cx);
        let ready = crate::typography::ready(cx);
        let disabled = disabled || !ready;
        // A bounded native menu, not thousands of font faces eagerly laid out.
        // Common installed reading/code families first, then alphabetical choices.
        let common = [
            "Arial",
            "Avenir Next",
            "Charter",
            "Georgia",
            "Helvetica Neue",
            "Times New Roman",
            "Verdana",
            "Menlo",
            "Monaco",
            "Courier New",
            "SF Mono",
            "JetBrains Mono",
            "Fira Code",
            "DejaVu Sans Mono",
            "Liberation Mono",
        ];
        let mut choices = vec![FontFamily::default()];
        let is_code = |name: &str| {
            [
                "Menlo",
                "Monaco",
                "Courier New",
                "SF Mono",
                "JetBrains Mono",
                "Fira Code",
                "DejaVu Sans Mono",
                "Liberation Mono",
            ]
            .contains(&name)
        };
        for name in common.into_iter().filter(|name| !code || is_code(name)) {
            if let Some(f) = FontFamily::new(name).filter(|f| names.contains(f)) {
                choices.push(f);
            }
        }
        if !family.name().is_empty() && names.contains(&family) && !choices.contains(&family) {
            choices.push(family);
        }
        for f in names.iter().copied().filter(|f| !code || is_code(f.name())) {
            if choices.len() >= 256 {
                break;
            }
            if !choices.contains(&f) {
                choices.push(f);
            }
        }
        let preferences = self.preferences.clone();
        let picker = ui::action(
            SharedString::from(format!("settings-{prefix}-font")),
            SharedString::from(label.to_owned()),
            Action::Secondary,
        )
        .dropdown_caret(true)
        .disabled(disabled)
        .accessibility_label(SharedString::from(format!("{title} font: {label}")))
        .dropdown_menu(move |menu, _, _| {
            let mut menu = menu;
            for f in choices.iter().copied() {
                let preferences = preferences.clone();
                let label = if f.name().is_empty() {
                    "App default"
                } else {
                    f.name()
                };
                menu = menu.item(
                    PopupMenuItem::new(SharedString::from(label.to_owned()))
                        .checked(family == f)
                        .on_click(move |_, _, cx| {
                            preferences.update(cx, |o, cx| {
                                let mut value = o.state.current().fonts;
                                if code {
                                    value.code_family = f;
                                } else {
                                    value.chat_family = f;
                                }
                                o.fonts(value, cx);
                            })
                        }),
                );
            }
            menu
        });
        let mut sizes = ButtonGroup::new(SharedString::from(format!("settings-{prefix}-sizes")))
            .small()
            .outline();
        for (suffix, label, delta) in [("smaller", "−", -1i16), ("larger", "+", 1)] {
            let preferences = self.preferences.clone();
            let base = size.unwrap_or(if code { 26 } else { 28 });
            let next = base as i16 + delta;
            let range = if code { 18..=40 } else { 22..=44 };
            sizes = sizes.child(
                ui::action(
                    SharedString::from(format!("settings-{prefix}-{suffix}")),
                    label,
                    Action::Secondary,
                )
                .disabled(disabled || !range.contains(&next))
                .accessibility_label(SharedString::from(format!("{title}: {suffix} text")))
                .on_click(move |_, _, cx| {
                    preferences.update(cx, |o, cx| {
                        let mut value = o.state.current().fonts;
                        if code {
                            value.code_size = Some(next as u8);
                        } else {
                            value.chat_size = Some(next as u8);
                        }
                        o.fonts(value, cx);
                    })
                }),
            );
        }
        let size_label = size
            .map(|s| format!("{} pt", s as f32 / 2.))
            .unwrap_or_else(|| "Default size".into());
        div().v_flex().gap_2()
            .child(ui::heading(SharedString::from(format!("settings-{prefix}-heading")), title, Text::Headline))
            .child(FieldRow::new(SharedString::from(format!("settings-{prefix}-family-field")), "Font", picker)
                .layout(if wide {FieldLayout::Inline} else {FieldLayout::Stacked})
                .description(if code {"Common installed monospaced fonts."} else {"Up to 256 installed choices. Restart after installing fonts."}))
            .child(FieldRow::new(SharedString::from(format!("settings-{prefix}-size-field")), "Size", div().h_flex().gap_2().items_center().child(ui::text(Text::Body, size_label)).child(sizes))
                .layout(if wide {FieldLayout::Inline} else {FieldLayout::Stacked})
                .description(if code {"9–20 pt. Code blocks and tool output; inline code keeps its proportional chat size."} else {"11–22 pt. Conversation text only, not the composer or app controls."}))
            .when(!ready, |d| d.child(Notice::new("Loading installed fonts…").tone(Tone::Quiet)))
            .when(ready && !crate::typography::available(family, cx), |d| d.child(Notice::new("Selected font is unavailable. Using the app default without changing your saved choice.").tone(Tone::Quiet)))
    }
}
