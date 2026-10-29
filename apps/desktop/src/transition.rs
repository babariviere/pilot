//! One-shot UI transitions on the executor clock: deterministic under test
//! clocks, frame-driven while running, instant under reduced motion. No timers,
//! tasks or per-control clocks. Pulse loops a running indicator and holds still
//! under reduced motion. Only `Reveal` (chat side panels) animates layout.
use gpui_kit::{App, Window};
use std::time::{Duration, Instant};

#[derive(Default)]
pub(crate) struct Transition {
    start: Option<Instant>,
}
impl Transition {
    pub(crate) fn start(&mut self, cx: &App) {
        self.start = (!cx.reduce_motion()).then(|| cx.background_executor().now());
    }
    /// Linear progress 0..=1. Requests the next frame only while running.
    pub(crate) fn progress(&mut self, duration: Duration, window: &mut Window, cx: &App) -> f32 {
        let Some(start) = self.start else {
            return 1.;
        };
        let elapsed = cx
            .background_executor()
            .now()
            .saturating_duration_since(start);
        let t = elapsed.as_secs_f32() / duration.as_secs_f32();
        if t >= 1. || cx.reduce_motion() {
            self.start = None;
            return 1.;
        }
        window.request_animation_frame();
        t
    }
    #[cfg(feature = "native-probes")]
    pub(crate) fn running(&self) -> bool {
        self.start.is_some()
    }
}

/// A looping phase for an indicator that is live now (running dots): frame
/// driven while shown, so it costs nothing offscreen. None under reduced
/// motion, where the indicator holds still.
#[derive(Default)]
pub(crate) struct Pulse {
    start: Option<Instant>,
}
impl Pulse {
    /// Phase in 0..1 of the current period. Requests the next frame.
    pub(crate) fn phase(&mut self, period: Duration, window: &mut Window, cx: &App) -> Option<f32> {
        if cx.reduce_motion() {
            self.start = None;
            return None;
        }
        let now = cx.background_executor().now();
        let start = *self.start.get_or_insert(now);
        window.request_animation_frame();
        Some((now.saturating_duration_since(start).as_secs_f32() / period.as_secs_f32()).fract())
    }
    /// The indicator is gone: the next start begins a fresh period.
    pub(crate) fn stop(&mut self) {
        self.start = None;
    }
    #[cfg(test)]
    pub(crate) fn running(&self) -> bool {
        self.start.is_some()
    }
}

/// The extent a panel shows this frame. When the open panel (its key) changes,
/// eases from whatever is shown now, so reopening mid-close continues smoothly.
/// Extent changes for the same key (window resize) apply at once.
pub(crate) struct Reveal<K> {
    key: Option<K>,
    from: f32,
    shown: f32,
    transition: Transition,
}
impl<K> Default for Reveal<K> {
    fn default() -> Self {
        Self {
            key: None,
            from: 0.,
            shown: 0.,
            transition: Transition::default(),
        }
    }
}
impl<K: PartialEq> Reveal<K> {
    pub(crate) const DURATION: Duration = Duration::from_millis(200);
    pub(crate) fn extent(
        &mut self,
        target: Option<(K, f32)>,
        window: &mut Window,
        cx: &App,
    ) -> f32 {
        let (key, to) = match target {
            Some((key, extent)) => (Some(key), extent),
            None => (None, 0.),
        };
        if key != self.key {
            self.key = key;
            self.from = self.shown;
            self.transition.start(cx);
        }
        let t = ease_out(self.transition.progress(Self::DURATION, window, cx));
        self.shown = self.from + (to - self.from) * t;
        self.shown
    }
    #[cfg(feature = "native-probes")]
    pub(crate) fn running(&self) -> bool {
        self.transition.running()
    }
}

/// Exponential-feeling ease-out for entrances.
pub(crate) fn ease_out(t: f32) -> f32 {
    1. - (1. - t.clamp(0., 1.)).powi(3)
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui_kit::AppContext as _;
    #[test]
    fn ease_out_starts_fast_and_settles_exactly() {
        assert_eq!(ease_out(0.), 0.);
        assert_eq!(ease_out(1.), 1.);
        assert!(ease_out(0.5) > 0.5);
        assert_eq!(ease_out(2.), 1.);
    }

    struct Panel {
        reveal: Reveal<&'static str>,
        target: Option<(&'static str, f32)>,
        shown: f32,
    }
    impl gpui_kit::Render for Panel {
        fn render(
            &mut self,
            w: &mut Window,
            cx: &mut gpui_kit::Context<Self>,
        ) -> impl gpui_kit::IntoElement {
            self.shown = self.reveal.extent(self.target, w, cx);
            gpui_kit::div()
        }
    }

    #[gpui_kit::test]
    fn reveal_eases_key_changes_reverses_in_place_and_follows_resize(
        cx: &mut gpui_kit::TestAppContext,
    ) {
        let window = cx.add_window(|_, _| Panel {
            reveal: Reveal::default(),
            target: None,
            shown: 0.,
        });
        let at = |cx: &mut gpui_kit::TestAppContext, ms: u64, target| {
            cx.executor().advance_clock(Duration::from_millis(ms));
            window
                .update(cx, |p, _, cx| {
                    p.target = target;
                    cx.notify();
                })
                .unwrap();
            cx.update_window(window.into(), |_, w, cx| w.draw(cx).clear(cx))
                .unwrap();
            window.update(cx, |p, _, _| p.shown).unwrap()
        };
        assert_eq!(at(cx, 0, Some(("links", 320.))), 0.);
        let opening = at(cx, 64, Some(("links", 320.)));
        assert!(opening > 0. && opening < 320.);
        assert_eq!(at(cx, 200, Some(("links", 320.))), 320.);
        // Same panel, new extent (resize): applied at once.
        assert_eq!(at(cx, 0, Some(("links", 280.))), 280.);
        // Another panel eases from the shown extent.
        assert_eq!(at(cx, 0, Some(("changes", 360.))), 280.);
        let switching = at(cx, 64, Some(("changes", 360.)));
        assert!(switching > 280. && switching < 360.);
        // Closing mid-switch continues from there; reopening reverses in place.
        assert_eq!(at(cx, 0, None), switching);
        let closing = at(cx, 64, None);
        assert!(closing > 0. && closing < switching);
        assert_eq!(at(cx, 0, Some(("changes", 360.))), closing);
        assert_eq!(at(cx, 200, Some(("changes", 360.))), 360.);
        // Reduced motion lands on the end state immediately.
        cx.update(|cx| cx.set_reduce_motion(true));
        assert_eq!(at(cx, 0, None), 0.);
        assert_eq!(at(cx, 0, Some(("links", 320.))), 320.);
    }
}
