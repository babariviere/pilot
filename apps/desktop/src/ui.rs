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

/// Shared conversation/editor outer cap; responsive parents may shrink below it.
/// Pages and artifact inspectors keep their separate reading widths.
pub(crate) const CONVERSATION_MAX_WIDTH: f32 = 960.;

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
    match role {
        // Inter's display cut is drawn for 20pt and up: tighter, crisper page titles.
        Text::Display | Text::Title => view
            .font_family(crate::appearance::DISPLAY_FONT)
            .font_semibold(),
        Text::Headline => view.font_semibold(),
        _ => view,
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
/// Opaque popup chrome; Kit's default dialog background is the glass page token.
/// The dialog retains its native geometry, shadow, focus and dismissal behavior.
pub(crate) fn dialog(
    dialog: gpui_kit::component::dialog::Dialog,
    cx: &App,
) -> gpui_kit::component::dialog::Dialog {
    dialog
        .bg(cx.theme().popover)
        .text_color(cx.theme().popover_foreground)
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

/// Shared task status ladder (DESIGN.md): label, pie fill and row colour.
/// Empty to do, one-third in progress, two-thirds in review, full done.
pub fn task_status(status: &str, cx: &App) -> (SharedString, f32, Hsla) {
    use crate::dither::Signal;
    let dark = cx.theme().is_dark();
    let tint = |s: Signal| -> Hsla { gpui_kit::rgb(s.rgb(dark)).into() };
    let muted = cx.theme().muted_foreground;
    match status {
        "todo" => ("To do".into(), 0., muted),
        "in_progress" => ("In progress".into(), 1. / 3., tint(Signal::Working)),
        "in_review" => ("In review".into(), 2. / 3., tint(Signal::NeedsYou)),
        "blocked" => ("Blocked".into(), 0., tint(Signal::Failed)),
        "done" => ("Done".into(), 1., tint(Signal::Ready)),
        "dropped" => ("Dropped".into(), 0., muted),
        "delegated" => ("Delegated".into(), 1. / 3., muted),
        other => (SharedString::from(other.to_owned()), 0., muted),
    }
}
/// 14pt status pie: outline ring plus a clockwise sector from 12 o'clock.
pub fn status_pie(fraction: f32, color: Hsla) -> Div {
    use gpui_kit::{PathBuilder, canvas, point};
    div().size(px(14.)).flex_none().child(
        canvas(
            |_, _, _| (),
            move |b, (), window, _| {
                let c = b.center();
                let at = |a: f32| c + point(px(a.cos() * 5.5), px(a.sin() * 5.5));
                let mut ring = PathBuilder::stroke(px(1.5));
                for i in 0..=48 {
                    let p = at(std::f32::consts::TAU * i as f32 / 48.);
                    if i == 0 {
                        ring.move_to(p)
                    } else {
                        ring.line_to(p)
                    }
                }
                if let Ok(p) = ring.build() {
                    window.paint_path(p, color);
                }
                if fraction > 0. {
                    let mut sector = PathBuilder::fill();
                    sector.move_to(c);
                    let n = (48. * fraction).ceil() as usize;
                    for i in 0..=n {
                        let a = -std::f32::consts::FRAC_PI_2
                            + std::f32::consts::TAU * fraction * i as f32 / n as f32;
                        sector.line_to(at(a));
                    }
                    sector.close();
                    if let Ok(p) = sector.build() {
                        window.paint_path(p, color);
                    }
                }
            },
        )
        .size_full(),
    )
}
/// Plain 6pt capsule with proportional segments over a faint track; no animation.
pub fn progress_bar(segments: &[(usize, Hsla)], total: usize, track: Hsla) -> Div {
    let total = total.max(1) as f32;
    div()
        .h_flex()
        .h(px(6.))
        .w_full()
        .rounded_full()
        .overflow_hidden()
        .bg(track)
        .children(segments.iter().filter(|(n, _)| *n > 0).map(|(n, color)| {
            div()
                .h_full()
                .w(gpui_kit::relative(*n as f32 / total))
                .bg(*color)
        }))
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
