//! The Day screen's styled controls, drawn from `nsh_base` behavior and the
//! theme's tokens: the Rust form of the TSX spike's `ui.tsx`, part for
//! part. Pages compose these; they do not restyle base controls.

use nsh_base::{button, theme, toggle};
use nsh_core::{element::StyleRefinement, prelude::*};
use pilot_day_native::model::{Evidence, Progress, Tone};

/// Tailwind's `max-w-2xl` (42rem), the TSX column's width.
pub const COLUMN_WIDTH: f32 = 672.0;

/// The theme's color `name` (`theme.json` holds the Day roles: `faint`,
/// `needs`, `ok-soft`, ...). A missing role shows as `destructive`, so it
/// is seen in review.
pub fn token(name: &str) -> AdaptiveColor {
    theme().color(name).unwrap_or(theme().destructive)
}

/// A still state mark. Words beside it carry the meaning.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MarkKind {
    Needs,
    Failed,
    Ready,
    Unknown,
    Moving,
    Paused,
    Later,
    Done,
}

/// A small round mark for a state that may change.
pub fn mark(kind: impl Fn() -> MarkKind + 'static) -> View {
    view()
        .size_2()
        .rounded_full()
        .style_with(move |s| match kind() {
            MarkKind::Needs => s.bg(token("needs")),
            MarkKind::Failed => s.bg(token("failed")),
            MarkKind::Ready => s.bg(token("ok")),
            MarkKind::Done | MarkKind::Paused => s.bg(token("faint")),
            MarkKind::Unknown => s.border_2().border_color(token("needs")),
            MarkKind::Moving => s.border_2().border_color(token("faint")),
            MarkKind::Later => s.border_1().border_dashed().border_color(token("faint")),
        })
}

/// The keyboard focus ring every control shares
/// (`focus-visible:ring-2 focus-visible:ring-ring/40`).
fn ring(s: StyleRefinement) -> StyleRefinement {
    s.ring(px(2.0)).ring_color(theme().ring.opacity(0.4))
}

/// A command. `primary` marks the decision's one default commit.
pub fn action(
    label: impl IntoReactive<SharedString>,
    primary: bool,
    disabled: impl Fn() -> bool + 'static,
    on_press: impl Fn() + 'static,
) -> impl IntoElement {
    let base = button()
        .disabled(disabled)
        .on_press(on_press)
        .min_h_8()
        .flex_row()
        .items_center()
        .rounded_lg()
        .disabled_style(|s| s.opacity(0.5))
        .focus(ring);
    let label = text(label).text_sm();
    if primary {
        base.bg(move || theme().primary)
            .px_3p5()
            .py_1()
            .active(|s| s.opacity(0.9))
            .child(
                label
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(move || theme().primary_foreground),
            )
    } else {
        base.px_3()
            .py_1()
            .hover(|s| s.bg(theme().accent))
            .active(|s| s.bg(theme().accent))
            .child(label.text_color(move || theme().muted_foreground))
    }
}

/// An inline text command inside a sentence.
pub fn inline_action(
    label: impl IntoReactive<SharedString>,
    on_press: impl Fn() + 'static,
) -> impl IntoElement {
    button().on_press(on_press).rounded_sm().focus(ring).child(
        text(label)
            .text_sm()
            .underline()
            .text_color(move || token("needs-ink")),
    )
}

/// A help toggle on a decision card.
pub fn help_chip(
    label: &'static str,
    pressed: impl Fn() -> bool + Copy + 'static,
    on_change: impl Fn(bool) + 'static,
) -> impl IntoElement {
    toggle()
        .pressed(pressed)
        .on_change(move |next: &bool| on_change(*next))
        .rounded_full()
        .border_1()
        .border_color(move || token("border-strong"))
        .px_3()
        .py_1()
        .hover(|s| s.bg(theme().accent))
        .aria_pressed(|s| {
            s.border_color(theme().primary.opacity(0.4))
                .bg(token("selection"))
        })
        .focus(ring)
        .child(text(label).text_xs().text_color(move || {
            if pressed() {
                theme().foreground
            } else {
                theme().muted_foreground
            }
        }))
}

/// The ink of a piece of evidence.
fn tone_color(tone: Tone) -> AdaptiveColor {
    match tone {
        Tone::Neutral => theme().muted_foreground,
        Tone::Warn => token("needs-ink"),
        Tone::Bad => token("failed-ink"),
    }
}

/// One piece of evidence, as a quiet chip.
pub fn evidence_chip(evidence: ReadSignal<Evidence>) -> impl IntoElement {
    view()
        .rounded_full()
        .bg(move || theme().muted)
        .px_2p5()
        .py_0p5()
        .child(
            text(move || evidence.with(|e| e.label.clone()))
                .text_xs()
                .text_color(move || evidence.with(|e| tone_color(e.tone))),
        )
}

/// A section's title with a count, shown when above zero.
pub fn section_title(
    title: &'static str,
    count: impl Fn() -> usize + Copy + 'static,
) -> impl IntoElement {
    view()
        .flex_row()
        .items_baseline()
        .gap_2()
        .child(
            text(title)
                .role(AccessibilityRole::Header)
                .text_sm()
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(move || theme().muted_foreground),
        )
        .child(when(
            move || count() > 0,
            move || {
                text(move || count().to_string())
                    .text_sm()
                    .text_color(move || token("faint"))
            },
        ))
        .child(view().flex_1())
}

/// A mission's tasks as one thin bar: done, in progress, stopped, not
/// started.
pub fn track(progress: impl Fn() -> Progress + Copy + 'static) -> impl IntoElement {
    let part = move |grow: fn(&Progress) -> u32| {
        view()
            .h_full()
            .basis(px(0.0))
            .flex_grow(move || grow(&progress()) as f32)
    };
    view()
        .h_1()
        .w_40()
        .flex_row()
        .overflow_hidden()
        .rounded_full()
        .bg(move || token("track"))
        .child(part(|p| p.done).bg(move || token("ok")))
        .child(part(|p| p.review + p.active).bg(move || token("progress")))
        .child(part(|p| p.blocked).bg(move || token("failed")))
        .child(part(|p| p.todo))
}
