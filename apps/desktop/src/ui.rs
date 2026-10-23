//! Small presentation-only vocabulary, not a second control framework.
//! Owners retain data, focus, enabled/loading state and every callback.
//! See `docs/design-system.md` and the compiled `catalog_probe` examples.
pub use crate::app_icon::AppIcon as IconRole;
pub use crate::appearance::{Radius, Space, TextRole};
use gpui_kit::{
    AnyElement, App, Div, ElementId, Hsla, InteractiveElement, IntoElement, ParentElement,
    RenderOnce, SharedString, Styled, TestSupportExt, Window,
    component::{
        ActiveTheme, Icon, Sizable, StyledExt,
        button::{Button, ButtonVariants},
    },
    div, px,
};

/// Physical shell metrics only. Never apply to transcript/Markdown/editor runs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Text {
    Display,
    Title,
    Headline,
    Body,
    Label,
    Caption,
    Small,
}
impl Text {
    pub fn size(self) -> f32 {
        match self {
            Self::Display => TextRole::DISPLAY,
            Self::Title => TextRole::TITLE,
            Self::Headline => TextRole::HEADLINE,
            Self::Body => TextRole::BODY,
            Self::Label => TextRole::LABEL,
            Self::Caption => TextRole::CAPTION,
            Self::Small => TextRole::SMALL,
        }
    }
}
pub fn text(role: Text, label: impl Into<SharedString>) -> Div {
    let view = div().text_size(px(role.size())).child(label.into());
    if matches!(role, Text::Display | Text::Title | Text::Headline) {
        view.font_semibold()
    } else {
        view
    }
}
pub fn heading(
    id: impl Into<ElementId>,
    label: impl Into<SharedString>,
    role: Text,
) -> impl IntoElement {
    text(role, label).id(id).test_support().truncate()
}
/// No hidden clipping, scrolling or focus owner. The caller supplies those.
pub fn page() -> Div {
    div()
        .v_flex()
        .gap(px(Space::SECTION))
        .p(px(Space::HOME))
        .w_full()
        .min_w_0()
        .max_w(px(760.))
        .mx_auto()
}
/// Append contextual metadata as children; it remains caller-owned, not inferred.
pub fn header(id: impl Into<ElementId>, title: impl Into<SharedString>, role: Text) -> Div {
    div()
        .v_flex()
        .gap(px(Space::META))
        .child(heading(id, title, role))
}

/// Color role only. Corners/insets stay separate so existing geometry is not reset.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Surface {
    Page,
    Sidebar,
    Card,
    Tray,
    Code,
}
impl Surface {
    pub fn color(self, cx: &App) -> Hsla {
        match self {
            Self::Page => cx.theme().background,
            Self::Sidebar => cx.theme().sidebar,
            Self::Card => crate::appearance::card(cx),
            Self::Tray => crate::appearance::tray(cx),
            Self::Code => crate::appearance::code(cx),
        }
    }
}
pub fn surface(role: Surface, cx: &App) -> Div {
    div().bg(role.color(cx))
}
pub fn rule(window: &Window, cx: &App) -> Div {
    div()
        .w_full()
        .h(crate::appearance::hairline(window))
        .bg(cx.theme().border)
}
pub fn selected_fill(cx: &App) -> Hsla {
    cx.theme().list_active
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IconSize {
    Chrome,
    Inline,
}
pub fn icon(role: IconRole, size: IconSize) -> Icon {
    match size {
        IconSize::Chrome => role.icon(),
        IconSize::Inline => role.inline(),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    Primary,
    Secondary,
    Quiet,
    Danger,
}
fn button(id: impl Into<ElementId>, role: Action) -> Button {
    let button = Button::new(id).small();
    match role {
        Action::Primary => button.primary(),
        Action::Secondary => button.secondary(),
        Action::Quiet => button.ghost(),
        Action::Danger => button.danger(),
    }
}
/// Return the real Kit Button, retaining its disabled/loading/selected and handlers.
pub fn action(id: impl Into<ElementId>, label: impl Into<SharedString>, role: Action) -> Button {
    button(id, role).label(label)
}
/// Icon-only controls always have an explicit accessible name and tooltip.
pub fn icon_action(
    id: impl Into<ElementId>,
    label: impl Into<SharedString>,
    glyph: IconRole,
    role: Action,
) -> Button {
    let label = label.into();
    button(id, role)
        .icon(glyph.icon())
        .accessibility_label(label.clone())
        .tooltip(label)
}

/// Content for a caller-owned Button/List row, not another interactive element.
/// Parts are scoped by that owner's stable ID: resource-icon/title/detail.
#[derive(IntoElement)]
pub struct ResourceLabel {
    title: SharedString,
    detail: Option<SharedString>,
    glyph: Option<IconRole>,
}
impl ResourceLabel {
    pub fn new(title: impl Into<SharedString>) -> Self {
        Self {
            title: title.into(),
            detail: None,
            glyph: None,
        }
    }
    pub fn detail(mut self, detail: impl Into<SharedString>) -> Self {
        self.detail = Some(detail.into());
        self
    }
    pub fn icon(mut self, glyph: IconRole) -> Self {
        self.glyph = Some(glyph);
        self
    }
}
impl RenderOnce for ResourceLabel {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let mut labels = div().v_flex().min_w_0().flex_1().text_left().child(
            text(Text::Body, self.title)
                .id("resource-title")
                .test_support()
                .truncate(),
        );
        if let Some(detail) = self.detail {
            labels = labels.child(
                text(Text::Caption, detail)
                    .id("resource-detail")
                    .test_support()
                    .truncate()
                    .text_color(cx.theme().muted_foreground),
            );
        }
        let mut row = div()
            .h_flex()
            .w_full()
            .min_w_0()
            .items_center()
            .gap(px(Space::CONTROL));
        if let Some(glyph) = self.glyph {
            row = row.child(
                div()
                    .id("resource-icon")
                    .test_support()
                    .size_4()
                    .flex_none()
                    .child(glyph.icon()),
            );
        }
        row.child(labels)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tone {
    Quiet,
    Normal,
    Warning,
    Error,
    Success,
}
impl Tone {
    pub fn color(self, cx: &App) -> Hsla {
        match self {
            Self::Quiet => cx.theme().muted_foreground,
            Self::Normal => cx.theme().foreground,
            Self::Warning => cx.theme().warning,
            Self::Error => cx.theme().danger,
            Self::Success => cx.theme().success,
        }
    }
}
/// Passive status/empty/error content. Owners supply truthful text and actions.
#[derive(IntoElement)]
pub struct Notice {
    title: SharedString,
    detail: Option<SharedString>,
    tone: Tone,
}
impl Notice {
    pub fn new(title: impl Into<SharedString>) -> Self {
        Self {
            title: title.into(),
            detail: None,
            tone: Tone::Normal,
        }
    }
    pub fn detail(mut self, detail: impl Into<SharedString>) -> Self {
        self.detail = Some(detail.into());
        self
    }
    pub fn tone(mut self, tone: Tone) -> Self {
        self.tone = tone;
        self
    }
}
impl RenderOnce for Notice {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let mut view = div()
            .v_flex()
            .min_w_0()
            .gap(px(Space::META))
            .text_color(self.tone.color(cx))
            .child(text(Text::Body, self.title));
        if let Some(detail) = self.detail {
            view = view.child(text(Text::Caption, detail));
        }
        view
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FieldLayout {
    Stacked,
    Inline,
}
/// Layout/validation only: the actual control and its accessible name/state remain
/// owner-supplied. No value mirror, focus capture, automatic save or submit.
#[derive(IntoElement)]
pub struct FieldRow {
    id: ElementId,
    title: SharedString,
    description: Option<SharedString>,
    validation: Option<(SharedString, Tone)>,
    control: AnyElement,
    layout: FieldLayout,
}
impl FieldRow {
    pub fn new(
        id: impl Into<ElementId>,
        title: impl Into<SharedString>,
        control: impl IntoElement,
    ) -> Self {
        Self {
            id: id.into(),
            title: title.into(),
            description: None,
            validation: None,
            control: control.into_any_element(),
            layout: FieldLayout::Stacked,
        }
    }
    pub fn description(mut self, description: impl Into<SharedString>) -> Self {
        self.description = Some(description.into());
        self
    }
    pub fn validation(mut self, message: impl Into<SharedString>, tone: Tone) -> Self {
        self.validation = Some((message.into(), tone));
        self
    }
    pub fn layout(mut self, layout: FieldLayout) -> Self {
        self.layout = layout;
        self
    }
}
impl RenderOnce for FieldRow {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let mut labels = div()
            .v_flex()
            .min_w_0()
            .flex_1()
            .gap(px(Space::META))
            .child(text(Text::Label, self.title));
        if let Some(description) = self.description {
            labels = labels
                .child(text(Text::Caption, description).text_color(cx.theme().muted_foreground));
        }
        let row = div().w_full().min_w_0().gap(px(Space::SIDEBAR));
        let row = match self.layout {
            FieldLayout::Stacked => row.v_flex(),
            FieldLayout::Inline => row.h_flex().items_start(),
        };
        let mut view = div()
            .id(self.id)
            .test_support()
            .v_flex()
            .w_full()
            .min_w_0()
            .gap(px(Space::META))
            .child(
                row.child(labels)
                    .child(div().min_w_0().flex_1().child(self.control)),
            );
        if let Some((message, tone)) = self.validation {
            view = view.child(text(Text::Caption, message).text_color(tone.color(cx)));
        }
        view
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn semantic_scale_has_one_existing_source() {
        assert_eq!(
            [
                Text::Display,
                Text::Title,
                Text::Headline,
                Text::Body,
                Text::Label,
                Text::Caption,
                Text::Small
            ]
            .map(Text::size),
            [26., 22., 15., 13., 12., 11., 10.]
        );
        assert_eq!(Space::HOME, Space::SECTION);
        const { assert!(Radius::CONTROL < Radius::TRAY) };
    }
}
