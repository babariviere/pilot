//! Reader-owned numeric grid and one-in-flight/one-latest drag admission.
//! No transport, VM, clock, host access or canonical state.
use serde_json::Value;
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
}
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Offer {
    Send,
    Queued,
    Unchanged,
    Rejected,
}
impl Flow {
    pub(crate) fn offer(&mut self, intent: &Intent, busy: bool) -> Offer {
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
            self.queued = if flight.intent.value == intent.value {
                None
            } else {
                Some(intent.clone())
            };
            Offer::Queued
        } else if busy {
            Offer::Rejected
        } else {
            Offer::Send
        }
    }
    pub(crate) fn sent(&mut self, intent: Intent, version: u64) {
        self.flight = Some(Flight { intent, version });
        self.queued = None;
    }
    pub(crate) fn clear(&mut self) {
        self.flight = None;
        self.queued = None;
    }
    pub(crate) fn finish(&mut self, version: u64, healthy: bool) -> Option<Intent> {
        if !healthy {
            self.clear();
            return None;
        }
        if self.flight.as_ref().is_none_or(|f| version <= f.version) {
            return None;
        }
        self.flight = None;
        self.queued.take()
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
        assert_eq!(flow.offer(&intent(0.), false), Offer::Send);
        flow.sent(intent(0.), 7);
        for n in 1..=4096 {
            assert_eq!(flow.offer(&intent(f64::from(n)), true), Offer::Queued);
        }
        assert_eq!(flow.queued.as_ref(), Some(&intent(4096.)));
        assert!(flow.finish(7, true).is_none());
        assert!(flow.flight.is_some());
        assert_eq!(flow.finish(8, true), Some(intent(4096.)));
        assert!(flow.flight.is_none() && flow.queued.is_none());
    }
    #[test]
    fn release_duplicates_replacement_busy_and_faults_do_not_replay() {
        let mut flow = Flow::default();
        assert_eq!(flow.offer(&intent(1.), true), Offer::Rejected);
        flow.sent(intent(1.), 4);
        assert_eq!(flow.offer(&intent(1.), true), Offer::Unchanged);
        flow.offer(&intent(2.), true);
        assert_eq!(flow.offer(&intent(2.), true), Offer::Unchanged);
        flow.offer(&intent(1.), true);
        assert!(flow.queued.is_none());
        let mut other = intent(3.);
        other.binding += 1;
        assert_eq!(flow.offer(&other, true), Offer::Rejected);
        other = intent(3.);
        other.generation += 1;
        assert_eq!(flow.offer(&other, true), Offer::Rejected);
        flow.offer(&intent(9.), true);
        assert!(flow.finish(4, false).is_none());
        assert!(flow.flight.is_none() && flow.queued.is_none());
    }
}
