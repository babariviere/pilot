//! Reader-owned numeric grid and pane-wide, paced one-flight/one-latest admission.
//! Caller supplies monotonic time/canonical values. No transport, VM or host access.
use serde_json::Value;
use std::time::{Duration, Instant};
// Round up rather than allowing rounding to exceed 30 dispatches/second.
pub(crate) const DRAG_INTERVAL: Duration = Duration::from_millis(34);
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Spec {
    pub(crate) min: f64,
    pub(crate) max: f64,
    pub(crate) step: f64,
    pub(crate) label: String,
    pub(crate) unit: String,
    pub(crate) key: Option<String>,
}
impl Spec {
    pub(crate) fn checked_node(v: &Value) -> Self {
        Self {
            min: v["min"].as_f64().unwrap(),
            max: v["max"].as_f64().unwrap(),
            step: v["step"].as_f64().unwrap_or(1.),
            label: v["label"].as_str().unwrap_or("").into(),
            unit: v["unit"].as_str().unwrap_or("").into(),
            key: v["key"].as_str().map(str::to_owned),
        }
    }
}
#[derive(Clone, Copy, Debug)]
pub(crate) struct Grid {
    min: f64,
    max: f64,
    pub(crate) ticks: u32,
}
impl Grid {
    pub(crate) fn new(spec: &Spec) -> Option<Self> {
        let (min, max, step) = (spec.min, spec.max, spec.step);
        if !min.is_finite() || !max.is_finite() || !step.is_finite() || min >= max || step <= 0. {
            return None;
        }
        let scale = min.abs().max(max.abs()).max(step);
        let count = (max / scale - min / scale) / (step / scale);
        if !count.is_finite()
            || !(1. ..=1_000_000.).contains(&count)
            || (count - count.round()).abs() > count.max(1.) * 1e-9
        {
            return None;
        }
        Some(Self {
            min,
            max,
            ticks: count.round() as u32,
        })
    }
    pub(crate) fn position(self, value: f64) -> f32 {
        let scale = self.min.abs().max(self.max.abs());
        let position = (value.clamp(self.min, self.max) / scale - self.min / scale)
            / (self.max / scale - self.min / scale);
        (position.clamp(0., 1.) * f64::from(self.ticks)) as f32
    }
    pub(crate) fn value(self, index: f32) -> Option<f64> {
        if !index.is_finite() || !(0. ..=self.ticks as f32).contains(&index) {
            return None;
        }
        let t = f64::from(index.round()) / f64::from(self.ticks);
        let value = if t == 0. {
            self.min
        } else if t == 1. {
            self.max
        } else {
            self.min * (1. - t) + self.max * t
        };
        value.is_finite().then_some(value.clamp(self.min, self.max))
    }
}
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Intent {
    pub(crate) generation: u64,
    pub(crate) binding: u64,
    pub(crate) id: String,
    pub(crate) value: f64,
}
impl Intent {
    fn same_control(&self, other: &Self) -> bool {
        self.generation == other.generation && self.binding == other.binding && self.id == other.id
    }
}
#[derive(Debug)]
pub(crate) struct Flight {
    pub(crate) intent: Intent,
    pub(crate) version: u64,
}
#[derive(Default)]
pub(crate) struct Flow {
    pub(crate) flight: Option<Flight>,
    pub(crate) queued: Option<Intent>,
    next_dispatch: Option<Instant>,
}
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Offer {
    Send,
    Queued,
    Unchanged,
    Cancelled,
    Rejected,
}
impl Flow {
    pub(crate) fn offer(
        &mut self,
        intent: &Intent,
        busy: bool,
        canonical: f64,
        now: Instant,
    ) -> Offer {
        if !intent.value.is_finite() {
            return Offer::Rejected;
        }
        if let Some(flight) = &self.flight {
            if !flight.intent.same_control(intent) {
                return Offer::Rejected;
            }
            if self.queued.as_ref() == Some(intent)
                || (self.queued.is_none() && flight.intent == *intent)
            {
                return Offer::Unchanged;
            }
            if flight.intent.value == intent.value {
                self.queued = None;
                Offer::Cancelled
            } else {
                self.queued = Some(intent.clone());
                Offer::Queued
            }
        } else if busy {
            Offer::Rejected
        } else if intent.value == canonical {
            // Programmatic adoption of another slider must not erase this
            // slider's pending input. Only the owning control can withdraw it.
            if self.queued.as_ref().is_some_and(|q| q.same_control(intent)) {
                self.queued = None;
                Offer::Cancelled
            } else {
                Offer::Unchanged
            }
        } else {
            self.queued = Some(intent.clone());
            if self.next_dispatch.is_none_or(|due| now >= due) {
                Offer::Send
            } else {
                Offer::Queued
            }
        }
    }
    pub(crate) fn sent(&mut self, intent: Intent, version: u64, now: Instant) {
        self.flight = Some(Flight { intent, version });
        self.queued = None;
        self.next_dispatch = Some(now + DRAG_INTERVAL);
    }
    pub(crate) fn clear(&mut self) {
        self.flight = None;
        self.queued = None;
        // Cancellation/rebinding/faults must not reset the pane-wide rate gate.
    }
    pub(crate) fn finish(&mut self, version: u64, healthy: bool) {
        if !healthy {
            self.clear();
            return;
        }
        if self.flight.as_ref().is_none_or(|f| version <= f.version) {
            return;
        }
        self.flight = None;
    }
    pub(crate) fn ready(&self, now: Instant) -> Option<Intent> {
        (self.flight.is_none() && self.next_dispatch.is_none_or(|due| now >= due))
            .then(|| self.queued.clone())
            .flatten()
    }
    pub(crate) fn deadline(&self) -> Option<Instant> {
        (self.flight.is_none() && self.queued.is_some())
            .then_some(self.next_dispatch)
            .flatten()
    }
    pub(crate) fn latest(&self, id: &str, binding: u64) -> Option<f64> {
        self.queued
            .as_ref()
            .or_else(|| self.flight.as_ref().map(|f| &f.intent))
            .filter(|i| i.id == id && i.binding == binding)
            .map(|i| i.value)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn spec(min: f64, max: f64, step: f64) -> Spec {
        Spec {
            min,
            max,
            step,
            label: "Synthetic".into(),
            unit: String::new(),
            key: None,
        }
    }
    fn intent(value: f64) -> Intent {
        Intent {
            generation: 1,
            binding: 2,
            id: "0".into(),
            value,
        }
    }
    #[test]
    fn integer_index_grid_preserves_endpoints_steps_and_extreme_finite_ranges() {
        for s in [
            spec(0., 1., 0.1),
            spec(-5., 5., 2.),
            spec(-1e308, 1e308, 1e308),
            spec(5e-324, 1e-323, 5e-324),
        ] {
            let grid = Grid::new(&s).unwrap();
            assert_eq!(grid.value(0.), Some(s.min));
            assert_eq!(grid.value(grid.ticks as f32), Some(s.max));
            for i in 0..=grid.ticks {
                let v = grid.value(i as f32).unwrap();
                assert!(v.is_finite() && v >= s.min && v <= s.max);
                assert!((grid.position(v) - i as f32).abs() < 0.001);
            }
            assert!(grid.value(f32::NAN).is_none());
            assert!(grid.value(-1.).is_none());
        }
        assert_eq!(Grid::new(&spec(0., 1., 0.1)).unwrap().value(3.), Some(0.3));
        for s in [
            spec(0., 1., 0.3),
            spec(0., 1., 1e-9),
            spec(1., 1., 1.),
            spec(0., 1., f64::INFINITY),
        ] {
            assert!(Grid::new(&s).is_none());
        }
    }
    #[test]
    fn thousands_of_drag_updates_keep_one_command_and_only_latest_value() {
        let mut flow = Flow::default();
        let now = Instant::now();
        assert_eq!(flow.offer(&intent(0.), false, -1., now), Offer::Send);
        flow.sent(intent(0.), 7, now);
        for n in 1..=4096 {
            assert_eq!(
                flow.offer(&intent(f64::from(n)), true, -1., now),
                Offer::Queued
            );
        }
        assert_eq!(flow.queued.as_ref(), Some(&intent(4096.)));
        flow.finish(7, true);
        assert!(flow.flight.is_some());
        flow.finish(8, true);
        assert!(flow.ready(now).is_none());
        assert_eq!(flow.ready(now + DRAG_INTERVAL), Some(intent(4096.)));
        assert!(flow.flight.is_none() && flow.queued.is_some());
    }
    #[test]
    fn release_duplicates_replacement_busy_and_faults_do_not_replay() {
        let mut flow = Flow::default();
        let now = Instant::now();
        assert_eq!(flow.offer(&intent(1.), true, 0., now), Offer::Rejected);
        flow.sent(intent(1.), 4, now);
        assert_eq!(flow.offer(&intent(1.), true, 0., now), Offer::Unchanged);
        flow.offer(&intent(2.), true, 0., now);
        assert_eq!(flow.offer(&intent(2.), true, 0., now), Offer::Unchanged);
        flow.offer(&intent(1.), true, 0., now);
        assert!(flow.queued.is_none());
        let mut other = intent(3.);
        other.binding += 1;
        assert_eq!(flow.offer(&other, true, 0., now), Offer::Rejected);
        other = intent(3.);
        other.generation += 1;
        assert_eq!(flow.offer(&other, true, 0., now), Offer::Rejected);
        flow.offer(&intent(9.), true, 0., now);
        flow.finish(4, false);
        assert!(flow.flight.is_none() && flow.queued.is_none());
    }

    #[test]
    fn immediate_acks_and_cross_slider_switches_share_one_fixed_rate_gate() {
        let start = Instant::now();
        let mut flow = Flow::default();
        let mut sent = Vec::new();
        let mut version = 1;
        for ms in 0..2000 {
            let now = start + Duration::from_millis(ms);
            let mut next = intent(ms as f64);
            next.id = format!("slider-{}", ms % 2);
            flow.offer(&next, false, -1., now);
            if let Some(next) = flow.ready(now) {
                sent.push(now);
                flow.sent(next, version, now);
                flow.finish(version + 1, true); // Fastest possible helper.
                version += 1;
            }
        }
        assert!(sent.len() > 50 && sent.len() <= 60);
        assert!(sent.windows(2).all(|s| s[1] - s[0] >= DRAG_INTERVAL));
        for &at in &sent {
            assert!(
                sent.iter()
                    .filter(|&&t| t >= at && t < at + Duration::from_secs(1))
                    .count()
                    <= 30
            );
        }
        assert!(flow.queued.is_some());
        let due = flow.deadline().unwrap();
        let next = flow.ready(due).unwrap();
        assert_eq!(next.value, 1999.);
    }

    #[test]
    fn canonical_return_withdraws_only_unsent_own_input_and_does_not_reset_cadence() {
        let now = Instant::now();
        let mut flow = Flow::default();
        flow.sent(intent(10.), 1, now);
        // While in flight, returning to old canonical must remain queued: the
        // pending callback can still change canonical from 0 to 10.
        assert_eq!(flow.offer(&intent(0.), true, 0., now), Offer::Queued);
        flow.finish(2, true);
        assert_eq!(flow.ready(now + DRAG_INTERVAL), Some(intent(0.)));
        flow.offer(&intent(20.), false, 10., now);
        assert_eq!(flow.offer(&intent(10.), false, 10., now), Offer::Cancelled);
        assert!(flow.queued.is_none() && flow.deadline().is_none());
        flow.clear();
        let mut other = intent(30.);
        other.id = "other".into();
        assert_eq!(flow.offer(&other, false, 0., now), Offer::Queued);
        assert_eq!(flow.offer(&intent(10.), false, 10., now), Offer::Unchanged);
        assert_eq!(flow.queued, Some(other));
        assert_eq!(flow.deadline(), Some(now + DRAG_INTERVAL));
        assert!(flow.ready(now).is_none());
    }
}
