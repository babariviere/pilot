//! Chat state for list rows: the summary signal (Swift `SessionSignal`), its
//! tints, and the still mark that sidebar and Inbox rows show for it.
//!
//! Marks never loop. A changed state cross-fades once on the shared
//! `transition::Transition` clock, instantly under reduced motion. Colour only
//! for amber Needs you, red Failed and green Ready; Working stays neutral.
//! Working and Background draw a neutral circle (fainter for Background). The
//! same circle fills when the agent replied since you last looked, and a quiet
//! chat with a new reply shows it filled; there is no separate reply dot.
use crate::{app_icon::AppIcon, local_model::Chat, transition::Transition};
use gpui_kit::{
    AnyElement, App, Div, Hsla, InteractiveElement, IntoElement, ParentElement, Styled,
    TestSupportExt, Window, component::ActiveTheme, div, px, rgb,
};
use std::time::Duration;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Signal {
    Working,
    Paused,
    NeedsYou,
    Failed,
    Ready,
}
impl Signal {
    pub(crate) fn rgb(self, dark: bool) -> u32 {
        match self {
            Self::Working if dark => 0x818cf8,
            Self::Working => 0x6366f1,
            // Same metadata neutrals as appearance::palette. Row paint uses
            // the active theme directly (Mark::color).
            Self::Paused if dark => 0xa3acba,
            Self::Paused => 0x5f6b7d,
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
    Paused,
    /// Only background jobs are running.
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
            Signal::Paused => Self::Paused,
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
            Self::Paused => "Paused",
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
            Self::Working | Self::Background | Self::Paused => cx.theme().muted_foreground,
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
    /// Needs you, Failed and Ready already ask for a look, so their rows show
    /// no separate "new reply" state.
    pub(crate) fn asks_for_look(self) -> bool {
        !matches!(self.bucket(), Self::Working | Self::Paused)
    }
}

/// What a trailing slot draws: a coloured mark or the neutral circle.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Glyph {
    /// Amber dot, red triangle or green pull request.
    Mark(Mark),
    /// Working (faint for Background), or a quiet chat with a new reply.
    /// Filled while the agent has replied since you last looked.
    Circle { faint: bool, filled: bool },
}
impl Glyph {
    /// A row's glyph for its mark and "replied since you looked" state.
    /// Coloured marks ignore `unread`; quiet, read chats draw nothing.
    pub(crate) fn of(mark: Option<Mark>, unread: bool) -> Option<Self> {
        match mark {
            Some(mark) => Some(match Self::from(mark) {
                Self::Circle { faint, .. } => Self::Circle {
                    faint,
                    filled: unread,
                },
                glyph => glyph,
            }),
            None => unread.then_some(Self::Circle {
                faint: false,
                filled: true,
            }),
        }
    }
}
impl From<Mark> for Glyph {
    fn from(mark: Mark) -> Self {
        match mark {
            Mark::Working | Mark::Background => Self::Circle {
                faint: mark == Mark::Background,
                filled: false,
            },
            mark => Self::Mark(mark),
        }
    }
}

/// One mark cross-fade.
pub(crate) const FADE: Duration = Duration::from_millis(180);
/// Mark glyphs sit in a 12pt slot.
pub(crate) const SLOT: f32 = 12.;

/// A still glyph: the neutral circle (hollow, or filled for a new reply),
/// amber dot Needs you, red triangle Failed, green pull request Ready.
pub(crate) fn glyph(glyph: Glyph, cx: &App) -> AnyElement {
    let mark = match glyph {
        Glyph::Circle { faint, filled } => {
            let color = cx.theme().muted_foreground;
            let circle = div()
                .id(if filled {
                    "state-circle-filled"
                } else {
                    "state-circle-hollow"
                })
                .test_support()
                .size(px(9.))
                .rounded_full()
                .border(px(1.5))
                .border_color(color);
            let circle = if filled { circle.bg(color) } else { circle };
            return if faint { circle.opacity(0.5) } else { circle }.into_any_element();
        }
        Glyph::Mark(mark) => mark,
    };
    let color = mark.color(cx);
    match mark {
        Mark::Working | Mark::Background => self::glyph(Glyph::from(mark), cx),
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
        Mark::Paused => div()
            .id("state-paused")
            .test_support()
            .text_color(color)
            .child(AppIcon::Paused.icon().size_3())
            .into_any_element(),
    }
}

/// A centered 12pt slot holding the current glyph, with the previous one
/// fading out on top while a change settles.
pub(crate) fn slot(shown: Option<Glyph>, previous: Option<Glyph>, t: f32, cx: &App) -> Div {
    let layer = |shown: Glyph, opacity: f32| {
        div()
            .id("state-glyph")
            .test_support()
            .absolute()
            .inset_0()
            .flex()
            .items_center()
            .justify_center()
            .opacity(opacity)
            .child(glyph(shown, cx))
    };
    div()
        .relative()
        .flex_none()
        .size(px(SLOT))
        .children(shown.map(|glyph| layer(glyph, t)))
        .children(
            previous
                .filter(|_| t < 1.)
                .map(|glyph| layer(glyph, 1. - t)),
        )
}

/// One row's glyph over time: a change cross-fades once, a first sight never does.
#[derive(Default)]
pub(crate) struct Fade {
    seen: bool,
    shown: Option<Glyph>,
    previous: Option<Glyph>,
    transition: Transition,
}
impl Fade {
    /// The glyph to show, the one fading out and the fade progress (1 = settled).
    pub(crate) fn show(
        &mut self,
        mark: Option<Glyph>,
        window: &mut Window,
        cx: &App,
    ) -> (Option<Glyph>, Option<Glyph>, f32) {
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
    #[test]
    fn usage_pause_is_current_per_chat_presentation_not_run_state() {
        use serde_json::json;
        for state in ["idle", "working", "starting", "parked", "failed"] {
            let mut v = json!({"id":"held","state":state,"working":false,
                "outcome":"done","subscriptionPause":{"windows":[]}});
            let held = crate::local_model::chat(&v).unwrap();
            assert_eq!(Mark::of(&held).map(Mark::word), Some("Paused"), "{state}");
            assert_eq!(held.signal_label(), "Paused");
            assert_eq!(held.row_reason(), Some("Paused"));
            assert_eq!(held.busy, state == "working" || state == "starting");
            assert_eq!(held.state, state);
            assert!(held.writable);
            // Actual tools/jobs still drain under the current hold. The daemon's
            // working:true remains Working, even though a durable run can be
            // busy (state:working) while its admission is paused.
            let mut draining = v.clone();
            draining["working"] = json!(true);
            assert_eq!(
                Mark::of(&crate::local_model::chat(&draining).unwrap())
                    .unwrap()
                    .bucket(),
                Mark::Working
            );
            v["subscriptionPause"]["forced"] = json!(true);
            let forced = crate::local_model::chat(&v).unwrap();
            assert_ne!(Mark::of(&forced).map(Mark::word), Some("Paused"));
            v["subscriptionPause"] = serde_json::Value::Null;
            let released = crate::local_model::chat(&v).unwrap();
            assert_eq!(Mark::of(&forced), Mark::of(&released));
        }
        for (state, expected) in [("failed", Some(Mark::Failed)), ("idle", Some(Mark::Ready))] {
            let mut raw = json!({"id":"ordinary","state":state,
                "usage":{"subscription":{"fetchedAt":1,"windows":[{"usedPercent":100}]}},
                "pullRequest":{"state":"open","readiness":{"state":"ready"}}});
            assert_eq!(Mark::of(&crate::local_model::chat(&raw).unwrap()), expected);
            raw["subscriptionPause"] = json!({"windows":[]});
            raw["usage"]["subscription"]["error"] = json!("unavailable");
            assert_eq!(
                Mark::of(&crate::local_model::chat(&raw).unwrap()),
                Some(Mark::Paused)
            );
        }
        for extra in [
            json!({"usage":{"subscription":{"windows":[{"usedPercent":100}]}}}),
            json!({"usage":{"subscription":{"error":"unavailable","fetchedAt":1}}}),
            json!({"subscriptionPause":null}),
            json!({"subscriptionPause":false}),
            json!({"subscriptionPause":"unknown"}),
        ] {
            let mut v = json!({"id":"ordinary","state":"idle","outcome":"done"});
            v.as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            assert!(Mark::of(&crate::local_model::chat(&v).unwrap()).is_none());
        }
        let failed =
            crate::local_model::chat(&json!({"id":"failed","state":"failed","outcome":"question"}))
                .unwrap();
        assert_eq!(
            Mark::of(&failed),
            Some(Mark::Failed),
            "An unrelated idle failure keeps its original precedence"
        );
        for extra in [
            json!({"state":"working","attentionReason":{"kind":"asks","detail":"Which?"}}),
            json!({"state":"idle","outcome":"question","runningJobs":[{"name":"j"}]}),
        ] {
            let mut v = json!({"id":"question","subscriptionPause":{"windows":[]}});
            v.as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            let c = crate::local_model::chat(&v).unwrap();
            assert_eq!(Mark::of(&c).map(Mark::word), Some("Question"));
            assert_eq!(c.attention.unwrap().kind, crate::attention::Kind::Question);
        }
    }
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
        // An unanswered question outranks background-only work.
        assert_eq!(
            mark(
                json!({"id":"a","state":"idle","working":true,"runningJobs":[{"name":"j"}],"outcome":"question","outcomeAt":1})
            ),
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

    #[test]
    fn the_circle_fills_for_new_replies_and_coloured_marks_ignore_them() {
        let circle = |faint, filled| Some(Glyph::Circle { faint, filled });
        for unread in [false, true] {
            assert_eq!(
                Glyph::of(Some(Mark::Working), unread),
                circle(false, unread)
            );
            assert_eq!(
                Glyph::of(Some(Mark::Background), unread),
                circle(true, unread)
            );
            for mark in [Mark::NeedsYou, Mark::Question, Mark::Failed, Mark::Ready] {
                assert!(mark.asks_for_look());
                assert_eq!(Glyph::of(Some(mark), unread), Some(Glyph::Mark(mark)));
            }
        }
        assert_eq!(Glyph::of(None, true), circle(false, true));
        assert_eq!(Glyph::of(None, false), None);
        assert!(!Mark::Working.asks_for_look() && !Mark::Background.asks_for_look());
        assert_eq!(
            Glyph::from(Mark::Background),
            Glyph::Circle {
                faint: true,
                filled: false
            }
        );
    }
}
