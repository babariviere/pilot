//! One-shot UI transitions on the executor clock: deterministic under test
//! clocks, frame-driven while running, instant under reduced motion. No timers,
//! tasks or per-control clocks; nothing animates layout.
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

/// Exponential-feeling ease-out for entrances.
pub(crate) fn ease_out(t: f32) -> f32 {
    1. - (1. - t.clamp(0., 1.)).powi(3)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ease_out_starts_fast_and_settles_exactly() {
        assert_eq!(ease_out(0.), 0.);
        assert_eq!(ease_out(1.), 1.);
        assert!(ease_out(0.5) > 0.5);
        assert_eq!(ease_out(2.), 1.);
    }
}
