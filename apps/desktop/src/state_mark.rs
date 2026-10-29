//! Chat state for list rows: the summary signal (Swift `SessionSignal`), its
//! tints, and the still mark that sidebar and Inbox rows show for it.
//!
//! Marks never loop. A changed state cross-fades once on the shared
//! `transition::Transition` clock, instantly under reduced motion. Colour only
//! for amber Needs you, red Failed and green Ready; Working stays neutral.
use crate::{app_icon::AppIcon, local_model::Chat, transition::Transition};
use gpui_kit::{
    AnyElement, App, Div, Hsla, IntoElement, ParentElement, Styled, Window, component::ActiveTheme,
    div, px, rgb,
};
use std::time::Duration;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Signal {
    Working,
    NeedsYou,
    Failed,
    Ready,
}
impl Signal {
    pub(crate) fn rgb(self, dark: bool) -> u32 {
        match self {
            Self::Working if dark => 0x818cf8,
            Self::Working => 0x6366f1,
            Self::NeedsYou => 0xf59e0b,
            Self::Failed => 0xef4444,
            Self::Ready => 0x10b981,
        }
    }
}

/// What a row's trailing mark shows. Quiet chats show nothing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Mark {
    Working,
    /// Only background jobs are running: the same ring, fainter.
    Background,
    NeedsYou,
    Question,
    Failed,
    Ready,
}
impl Mark {
    pub(crate) fn of(chat: &Chat) -> Option<Self> {
        Some(match chat.signal? {
            Signal::Working if chat.background_work => Self::Background,
            Signal::Working => Self::Working,
            Signal::NeedsYou if chat.order.question => Self::Question,
            Signal::NeedsYou => Self::NeedsYou,
            Signal::Failed => Self::Failed,
            Signal::Ready => Self::Ready,
        })
    }
    /// The short word beside the mark on one-line rows.
    pub(crate) fn word(self) -> &'static str {
        match self {
            Self::Working => "Working",
            Self::Background => "Background",
            Self::NeedsYou => "Needs you",
            Self::Question => "Question",
            Self::Failed => "Failed",
            Self::Ready => "Ready",
        }
    }
    /// Amber, red and green carry meaning; Working is neutral.
    pub(crate) fn color(self, cx: &App) -> Hsla {
        let dark = cx.theme().is_dark();
        match self {
            Self::Working | Self::Background => cx.theme().muted_foreground,
            Self::NeedsYou | Self::Question => rgb(Signal::NeedsYou.rgb(dark)).into(),
            Self::Failed => rgb(Signal::Failed.rgb(dark)).into(),
            Self::Ready => rgb(Signal::Ready.rgb(dark)).into(),
        }
    }
    /// Roll-up bucket: questions count as Needs you, background as Working.
    pub(crate) fn bucket(self) -> Self {
        match self {
            Self::Question => Self::NeedsYou,
            Self::Background => Self::Working,
            other => other,
        }
    }
}

/// One mark cross-fade.
pub(crate) const FADE: Duration = Duration::from_millis(180);
/// Mark glyphs sit in a 12pt slot.
pub(crate) const SLOT: f32 = 12.;

/// A still 12pt glyph: ring Working (faint for background), amber dot Needs
/// you, red triangle Failed, green pull request Ready.
pub(crate) fn glyph(mark: Mark, cx: &App) -> AnyElement {
    let color = mark.color(cx);
    match mark {
        Mark::Working | Mark::Background => div()
            .size(px(9.))
            .rounded_full()
            .border(px(1.5))
            .border_color(color)
            .when_background(mark == Mark::Background)
            .into_any_element(),
        Mark::NeedsYou | Mark::Question => div()
            .size(px(7.))
            .rounded_full()
            .bg(color)
            .into_any_element(),
        Mark::Failed => AppIcon::Error
            .icon()
            .size_3()
            .text_color(color)
            .into_any_element(),
        Mark::Ready => AppIcon::PullRequest
            .icon()
            .size_3()
            .text_color(color)
            .into_any_element(),
    }
}
trait Faint {
    fn when_background(self, faint: bool) -> Self;
}
impl Faint for Div {
    fn when_background(self, faint: bool) -> Self {
        if faint { self.opacity(0.5) } else { self }
    }
}

/// A centered 12pt slot holding the current glyph, with the previous one
/// fading out on top while a change settles.
pub(crate) fn slot(shown: Option<Mark>, previous: Option<Mark>, t: f32, cx: &App) -> Div {
    let layer = |mark: Mark, opacity: f32| {
        div()
            .absolute()
            .inset_0()
            .flex()
            .items_center()
            .justify_center()
            .opacity(opacity)
            .child(glyph(mark, cx))
    };
    div()
        .relative()
        .flex_none()
        .size(px(SLOT))
        .children(shown.map(|mark| layer(mark, t)))
        .children(previous.filter(|_| t < 1.).map(|mark| layer(mark, 1. - t)))
}

/// The small neutral "new reply since you looked" dot.
pub(crate) fn reply_dot(cx: &App) -> Div {
    div()
        .flex_none()
        .size(px(6.))
        .rounded_full()
        .bg(cx.theme().muted_foreground)
}

/// One row's mark over time: a change cross-fades once, a first sight never does.
#[derive(Default)]
pub(crate) struct Fade {
    seen: bool,
    shown: Option<Mark>,
    previous: Option<Mark>,
    transition: Transition,
}
impl Fade {
    /// The mark to show, the one fading out and the fade progress (1 = settled).
    pub(crate) fn show(
        &mut self,
        mark: Option<Mark>,
        window: &mut Window,
        cx: &App,
    ) -> (Option<Mark>, Option<Mark>, f32) {
        if !self.seen {
            self.seen = true;
            self.shown = mark;
        } else if mark != self.shown {
            self.previous = self.shown;
            self.shown = mark;
            self.transition.start(cx);
        }
        let t = self.transition.progress(FADE, window, cx);
        if t >= 1. {
            self.previous = None;
        }
        (self.shown, self.previous, t)
    }
    #[cfg(feature = "native-probes")]
    pub(crate) fn fading(&self) -> bool {
        self.previous.is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn marks_follow_the_summary_signal_and_quiet_chats_show_none() {
        let mark = |v| Mark::of(&crate::local_model::chat(&v).unwrap());
        assert_eq!(
            mark(json!({"id":"a","state":"working","working":true})),
            Some(Mark::Working)
        );
        assert_eq!(
            mark(json!({"id":"a","state":"idle","runningJobs":[{"name":"j"}]})),
            Some(Mark::Background)
        );
        assert_eq!(
            mark(json!({"id":"a","state":"idle","outcome":"question","outcomeAt":1})),
            Some(Mark::Question)
        );
        assert_eq!(
            mark(json!({"id":"a","state":"working","attentionReason":{"kind":"tool_stall"}})),
            Some(Mark::NeedsYou)
        );
        assert_eq!(mark(json!({"id":"a","state":"failed"})), Some(Mark::Failed));
        assert_eq!(
            mark(json!({"id":"a","state":"idle","outcome":"done","outcomeAt":1})),
            None
        );
        assert_eq!(Mark::Question.bucket(), Mark::NeedsYou);
        assert_eq!(Mark::Background.bucket(), Mark::Working);
        assert_eq!(Signal::Working.rgb(false), 0x6366f1);
        for s in [Signal::NeedsYou, Signal::Failed, Signal::Ready] {
            assert_eq!(s.rgb(false), s.rgb(true));
        }
    }
}
