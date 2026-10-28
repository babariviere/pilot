//! Trusted app decoration. Swift DitherCorner.swift geometry, not artifact execution.
use std::time::Duration;

pub(crate) const HOVER: Duration = Duration::from_millis(300);
pub(crate) const DISSOLVE: Duration = Duration::from_millis(600);
pub(crate) const BAYER: [u8; 64] = [
    0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60,
    28, 52, 20, 62, 30, 54, 22, 3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15,
    47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21,
];

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
/// Row corner grid in 2pt cells. Dither marks list-row state only, never controls.
pub(crate) const GRID: (usize, usize) = (52, 24);
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Spec {
    pub signal: Option<Signal>,
    pub background: bool,
}
impl Spec {
    pub(crate) fn row(signal: Option<Signal>, background: bool) -> Self {
        Self {
            signal,
            background: background && signal == Some(Signal::Working),
        }
    }
}
#[derive(Clone, Copy)]
pub(crate) struct Snapshot {
    pub spec: Spec,
    pub previous: Option<Signal>,
    pub mix: f64,
    pub recede: f64,
    pub ticking: bool,
    pub fast: bool,
}
pub(crate) struct Timeline {
    spec: Spec,
    previous: Option<Signal>,
    changed: Option<Duration>,
    hover_from: f64,
    hover_to: f64,
    hover_at: Duration,
}
impl Timeline {
    pub(crate) fn new(spec: Spec) -> Self {
        Self {
            spec,
            previous: None,
            changed: None,
            hover_from: 0.,
            hover_to: 0.,
            hover_at: Duration::ZERO,
        }
    }
    pub(crate) fn configure(&mut self, spec: Spec, now: Duration) {
        if spec.signal != self.spec.signal {
            self.previous = self.spec.signal;
            self.changed = Some(now);
        }
        self.spec = spec;
    }
    pub(crate) fn hover(&mut self, inside: bool, now: Duration, still: bool) -> bool {
        let target = if inside { 1. } else { 0. };
        if self.hover_to == target {
            return false;
        }
        self.hover_from = self.snapshot(now, still).recede;
        self.hover_to = target;
        self.hover_at = now;
        true
    }
    pub(crate) fn snapshot(&self, now: Duration, still: bool) -> Snapshot {
        let mix = if still {
            1.
        } else {
            self.changed
                .map_or(1., |at| ease(progress(now, at, DISSOLVE), true))
        };
        let hover = if still {
            1.
        } else {
            progress(now, self.hover_at, HOVER)
        };
        let recede = self.hover_from + (self.hover_to - self.hover_from) * ease(hover, false);
        // Corners hold still; only a state dissolve or hover recession moves them.
        let fast = mix < 1. || (hover < 1. && self.hover_from != self.hover_to);
        Snapshot {
            spec: self.spec,
            previous: self.previous,
            mix,
            recede,
            ticking: !still && fast,
            fast: !still && fast,
        }
    }
}
fn progress(now: Duration, at: Duration, duration: Duration) -> f64 {
    (now.saturating_sub(at).as_secs_f64() / duration.as_secs_f64()).min(1.)
}
// Core Animation's easeOut / easeInOut cubic Bezier curves, solved with fixed work.
fn ease(t: f64, both: bool) -> f64 {
    if t <= 0. || t >= 1. {
        return t.clamp(0., 1.);
    }
    let x1 = if both { 0.42 } else { 0. };
    let x2 = 0.58;
    let (mut lo, mut hi) = (0., 1.);
    for _ in 0..18 {
        let v = (lo + hi) / 2.;
        let x = 3. * (1. - v) * (1. - v) * v * x1 + 3. * (1. - v) * v * v * x2 + v * v * v;
        if x < t { lo = v } else { hi = v }
    }
    let v = (lo + hi) / 2.;
    3. * (1. - v) * v * v + v * v * v
}
fn threshold(x: usize, y: usize) -> f64 {
    (f64::from(BAYER[(y & 7) * 8 + (x & 7)]) + 0.5) / 64.
}
fn coverage(signal: Signal, background: bool, u: f64, v: f64, recede: f64) -> f64 {
    let dx = u / (46. * (1. - 0.55 * recede));
    let dy = v / (25. * (1. - 0.45 * recede));
    let distance = dx.hypot(dy);
    let f = (1. - distance).max(0.);
    let field = f * f * (3. - 2. * f);
    field
        * match signal {
            // Still rings: working rows keep their texture without motion.
            Signal::Working if background => 0.36 + 0.12 * (0.5 + 0.5 * (distance * 10.).sin()),
            Signal::Working => 0.44 + 0.16 * (0.5 + 0.5 * (distance * 14.).sin()),
            Signal::NeedsYou => 0.61,
            Signal::Failed => 0.68,
            Signal::Ready => 0.55,
        }
}
fn alpha(signal: Signal, background: bool, recede: f64, x: usize, y: usize) -> u8 {
    let (w, h) = GRID;
    let amount = coverage(
        signal,
        background,
        w as f64 - x as f64 - 0.5,
        h as f64 - y as f64 - 0.5,
        recede,
    );
    if threshold(x, y) < amount {
        (0.62 * (0.55 + 0.45 * amount) * 255.) as u8
    } else {
        0
    }
}
fn kind(signal: Signal, background: bool) -> usize {
    match signal {
        Signal::Working if background => 1,
        Signal::Working => 0,
        Signal::NeedsYou => 2,
        Signal::Failed => 3,
        Signal::Ready => 4,
    }
}
/// Ten still alpha layers (each state, resting and receded), about 12KiB.
/// Built once off the UI thread.
/// No per-frame SVG/image allocation, sprite upload or sampling blur: cells paint
/// as bounded native 2pt quads. A frame never interprets source or performs I/O.
pub(crate) struct Atlas {
    layers: Vec<Box<[u8]>>,
}
impl Atlas {
    pub(crate) fn build() -> Self {
        let mut layers = Vec::with_capacity(10);
        for k in 0..5 {
            for receded in [false, true] {
                let signal = [
                    Signal::Working,
                    Signal::Working,
                    Signal::NeedsYou,
                    Signal::Failed,
                    Signal::Ready,
                ][k];
                let (w, h) = GRID;
                let mut bytes = Vec::with_capacity(w * h);
                for y in 0..h {
                    for x in 0..w {
                        bytes.push(alpha(signal, k == 1, f64::from(receded), x, y));
                    }
                }
                layers.push(bytes.into_boxed_slice());
            }
        }
        Self { layers }
    }
    pub(crate) fn bytes(&self) -> usize {
        self.layers.iter().map(|l| l.len()).sum()
    }
    fn get(&self, signal: Signal, background: bool, receded: bool, point: (usize, usize)) -> u8 {
        let (x, y) = point;
        let k = kind(signal, background);
        self.layers[k * 2 + usize::from(receded)][y * GRID.0 + x]
    }
}
pub(crate) fn cell(
    snapshot: Snapshot,
    x: usize,
    y: usize,
    atlas: Option<&Atlas>,
) -> Option<(Signal, f32)> {
    let signal = if snapshot.mix < 1. && threshold(x, y) > snapshot.mix {
        snapshot.previous
    } else {
        snapshot.spec.signal
    }?;
    let bg = snapshot.spec.background && snapshot.spec.signal == Some(signal);
    let a = match atlas {
        Some(atlas) if snapshot.recede == 0. || snapshot.recede == 1. => {
            atlas.get(signal, bg, snapshot.recede == 1., (x, y))
        }
        _ => alpha(signal, bg, snapshot.recede, x, y),
    };
    (a > 0).then_some((signal, f32::from(a) / 255.))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn palette_and_interrupted_transitions_keep_only_latest_target() {
        assert_eq!(Signal::Working.rgb(false), 0x6366f1);
        assert_eq!(Signal::Working.rgb(true), 0x818cf8);
        for s in [Signal::NeedsYou, Signal::Failed, Signal::Ready] {
            assert_eq!(s.rgb(false), s.rgb(true));
        }
        let mut timeline = Timeline::new(Spec::row(None, false));
        for i in 0..64 {
            let now = Duration::from_millis(i * 7);
            timeline.configure(
                Spec::row(
                    Some(
                        [
                            Signal::Working,
                            Signal::NeedsYou,
                            Signal::Failed,
                            Signal::Ready,
                        ][i as usize % 4],
                    ),
                    false,
                ),
                now,
            );
            timeline.hover(i % 2 == 0, now, false);
            assert!(!timeline.snapshot(now, true).ticking);
        }
        timeline.configure(Spec::row(None, false), Duration::from_millis(500));
        let end = timeline.snapshot(Duration::from_millis(1200), false);
        assert!(end.spec.signal.is_none());
        assert_eq!(end.mix, 1.);
        assert!(!end.ticking);
    }
    #[test]
    fn still_layers_match_geometry_and_bounded_storage() {
        let atlas = Atlas::build();
        let (w, h) = GRID;
        assert_eq!(atlas.bytes(), 10 * w * h);
        for (signal, bg) in [
            (Signal::Working, false),
            (Signal::Working, true),
            (Signal::NeedsYou, false),
            (Signal::Failed, false),
            (Signal::Ready, false),
        ] {
            let mut painted = 0;
            for y in 0..h {
                for x in 0..w {
                    let a = atlas.get(signal, bg, false, (x, y));
                    assert_eq!(a, alpha(signal, bg, 0., x, y));
                    assert_eq!(
                        atlas.get(signal, bg, true, (x, y)),
                        alpha(signal, bg, 1., x, y)
                    );
                    painted += usize::from(a > 0);
                }
            }
            assert!(painted > 0, "{signal:?} paints a corner");
        }
    }
    #[test]
    fn transitions_settle_reduce_motion_is_still_and_hover_does_not_resize() {
        let spec = Spec::row(Some(Signal::Working), false);
        let mut t = Timeline::new(spec);
        assert!(
            !t.snapshot(Duration::ZERO, false).ticking,
            "a settled corner is still"
        );
        t.hover(true, Duration::ZERO, false);
        let middle = t.snapshot(Duration::from_millis(150), false);
        assert!(middle.recede > 0.5 && middle.recede < 1. && middle.fast);
        let end = t.snapshot(HOVER, false);
        assert_eq!(end.recede, 1.);
        assert!(!end.fast && !end.ticking);
        t.configure(Spec::row(Some(Signal::Failed), false), HOVER);
        assert_eq!(t.snapshot(HOVER, false).mix, 0.);
        let end = t.snapshot(HOVER + DISSOLVE, false);
        assert_eq!(end.mix, 1.);
        assert!(!end.ticking);
        t.configure(spec, Duration::from_secs(1));
        let still = t.snapshot(Duration::from_millis(1100), true);
        assert_eq!((still.mix, still.recede), (1., 1.));
        assert!(!still.ticking);
        t.configure(Spec::row(None, false), Duration::from_secs(2));
        assert!(!t.snapshot(Duration::from_secs(3), false).ticking);
    }
}
