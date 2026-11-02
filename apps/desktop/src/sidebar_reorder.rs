//! Row moves after a data change: your sends, and chats that appear, leave,
//! are pinned or archived. Layout is final at once; only paint follows the
//! shared executor clock. A surviving row, with its own targets, eases from
//! where it showed into its slot; a new row fades in there; a removed row is
//! gone at once and its neighbours close the gap. Rows that keep their relative
//! order slide; the fewest others pass over them on an opaque backdrop.
//! Search, scope, folds and first loads never arm it. Resize and reduced motion
//! snap. While a row moves it blocks the List's slot click beneath it (whose
//! final row may differ), so a click there never opens another chat.
use crate::transition::{Transition, ease_out};
use gpui_kit::{
    AnyElement, App, Bounds, ContentMask, Element, ElementId, GlobalElementId, Hsla,
    InspectorElementId, InteractiveElement as _, IntoElement, LayoutId, ParentElement as _, Pixels,
    Size, Styled as _, Window,
    component::{Selectable, list::ListItem},
    div, point,
    prelude::FluentBuilder as _,
    px,
};
use std::{
    collections::{HashMap, HashSet},
    time::{Duration, Instant},
};

const DURATION: Duration = Duration::from_millis(200);

#[derive(Default)]
pub(super) struct Motion {
    /// Each moving row's offset from its slot at the start, and whether it
    /// passes over the rows that keep their order.
    moves: HashMap<String, (f32, bool)>,
    /// Each entering row's opacity at the start.
    entering: HashMap<String, f32>,
    /// Eased progress of the current motion.
    t: f32,
    pending: bool,
    sampled_at: Option<Instant>,
    transition: Transition,
    viewport: Option<(Size<Pixels>, Pixels, f32)>,
}
impl Motion {
    pub(super) fn cancel(&mut self) {
        let viewport = self.viewport;
        *self = Self {
            viewport,
            ..Self::default()
        };
    }
    pub(super) fn active(&self) -> bool {
        !self.moves.is_empty() || !self.entering.is_empty()
    }
    /// How far a row shows from its slot now.
    pub(super) fn offset(&self, key: &str) -> f32 {
        self.moves
            .get(key)
            .map_or(0., |(offset, _)| offset * (1. - self.t))
    }
    pub(super) fn raised(&self, key: &str) -> bool {
        self.moves.get(key).is_some_and(|(_, raised)| *raised)
    }
    pub(super) fn opacity(&self, key: &str) -> f32 {
        self.entering
            .get(key)
            .map_or(1., |from| from + (1. - from) * self.t)
    }
    /// Rows by key and top, in list order, before and after a data change.
    /// Each row starts from where it shows now, so a reversal never jumps.
    pub(super) fn arm(&mut self, before: &[(String, f32)], after: &[(String, f32)]) {
        if self.viewport.is_none() || before.is_empty() || before == after {
            return;
        }
        let shown: HashMap<&str, (usize, f32, f32)> = before
            .iter()
            .enumerate()
            .map(|(i, (key, y))| (key.as_str(), (i, y + self.offset(key), self.opacity(key))))
            .collect();
        let order: Vec<usize> = after
            .iter()
            .filter_map(|(key, _)| shown.get(key.as_str()).map(|s| s.0))
            .collect();
        let steady = steady(&order);
        let mut moves = HashMap::new();
        let mut entering = HashMap::new();
        for (key, y) in after {
            let Some(&(i, from, opacity)) = shown.get(key.as_str()) else {
                entering.insert(key.clone(), 0.);
                continue;
            };
            if (from - y).abs() >= 0.5 {
                moves.insert(key.clone(), (from - y, !steady.contains(&i)));
            }
            if opacity < 1. {
                entering.insert(key.clone(), opacity);
            }
        }
        let viewport = self.viewport;
        *self = Self {
            pending: !moves.is_empty() || !entering.is_empty(),
            moves,
            entering,
            viewport,
            ..Self::default()
        };
    }
    /// Once per frame: true while rows still move.
    pub(super) fn sample(&mut self, width: f32, w: &mut Window, cx: &App) -> bool {
        let viewport = (w.viewport_size(), w.rem_size(), width);
        let resized = self.viewport.is_some_and(|old| old != viewport);
        self.viewport = Some(viewport);
        if !self.active() {
            return false;
        }
        if resized || cx.reduce_motion() {
            self.cancel();
            return true;
        }
        let now = cx.background_executor().now();
        if !self.pending && self.sampled_at == Some(now) {
            return false;
        }
        self.sampled_at = Some(now);
        if self.pending {
            self.transition.start(cx);
            self.pending = false;
        }
        self.t = ease_out(self.transition.progress(DURATION, w, cx));
        if self.t >= 1. {
            self.cancel();
        }
        true
    }
}

/// The old positions of the longest run of rows that keeps its relative order.
fn steady(order: &[usize]) -> HashSet<usize> {
    let mut tails: Vec<usize> = Vec::new();
    let mut previous = vec![None; order.len()];
    for (i, value) in order.iter().enumerate() {
        let at = tails.partition_point(|j| order[*j] < *value);
        previous[i] = at.checked_sub(1).map(|p| tails[p]);
        if at == tails.len() {
            tails.push(i);
        } else {
            tails[at] = i;
        }
    }
    let mut out = HashSet::new();
    let mut next = tails.last().copied();
    while let Some(i) = next {
        out.insert(order[i]);
        next = previous[i];
    }
    out
}

/// The List's item: the Kit row, shown away from its slot while it moves.
pub(crate) struct Row {
    item: ListItem,
    offset: f32,
    opacity: f32,
    backdrop: Option<Hsla>,
    viewport: Option<Bounds<Pixels>>,
}
impl Row {
    pub(super) fn new(item: ListItem) -> Self {
        Self {
            item,
            offset: 0.,
            opacity: 1.,
            backdrop: None,
            viewport: None,
        }
    }
    /// `viewport` clips a moving row to the list rather than its slot.
    pub(super) fn moving(
        mut self,
        motion: &Motion,
        key: &str,
        backdrop: Hsla,
        viewport: Option<Bounds<Pixels>>,
    ) -> Self {
        self.offset = motion.offset(key);
        self.opacity = motion.opacity(key);
        self.backdrop = motion.raised(key).then_some(backdrop);
        self.viewport = viewport.filter(|b| !b.is_empty());
        self
    }
}
impl Selectable for Row {
    fn selected(mut self, selected: bool) -> Self {
        self.item = self.item.selected(selected);
        self
    }
    fn is_selected(&self) -> bool {
        self.item.is_selected()
    }
    fn secondary_selected(mut self, selected: bool) -> Self {
        self.item = self.item.secondary_selected(selected);
        self
    }
}
impl IntoElement for Row {
    type Element = Shift;
    fn into_element(self) -> Shift {
        let offset = if self.viewport.is_some() {
            self.offset
        } else {
            0.
        };
        let child = if offset == 0. && self.opacity >= 1. {
            self.item.into_any_element()
        } else {
            div()
                .w_full()
                .when(self.opacity < 1., |d| d.opacity(self.opacity))
                .when(offset != 0., |d| d.block_mouse_except_scroll())
                .when_some(self.backdrop.filter(|_| offset != 0.), |d, bg| d.bg(bg))
                .child(self.item)
                .into_any_element()
        };
        Shift {
            child: Some(child),
            offset,
            raised: self.backdrop.is_some(),
            viewport: self.viewport,
        }
    }
}

/// Lays out at the slot; a moving row prepaints, hitboxes included, at its
/// shown position over the list, clipped to the list's viewport.
pub(crate) struct Shift {
    child: Option<AnyElement>,
    offset: f32,
    raised: bool,
    viewport: Option<Bounds<Pixels>>,
}
impl IntoElement for Shift {
    type Element = Self;
    fn into_element(self) -> Self {
        self
    }
}
impl Element for Shift {
    type RequestLayoutState = ();
    type PrepaintState = ();
    fn id(&self) -> Option<ElementId> {
        None
    }
    fn source_location(&self) -> Option<&'static std::panic::Location<'static>> {
        None
    }
    fn request_layout(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        w: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, ()) {
        let child = self.child.as_mut().expect("row child before prepaint");
        (child.request_layout(w, cx), ())
    }
    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        _: Bounds<Pixels>,
        _: &mut (),
        w: &mut Window,
        cx: &mut App,
    ) {
        match self.viewport.filter(|_| self.offset != 0.) {
            Some(bounds) => w.defer_draw(
                self.child.take().expect("moving row child"),
                w.element_offset() + point(px(0.), px(self.offset)),
                usize::from(self.raised),
                Some(ContentMask { bounds }),
            ),
            None => {
                self.child.as_mut().expect("row child").prepaint(w, cx);
            }
        }
    }
    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        _: Bounds<Pixels>,
        _: &mut (),
        _: &mut (),
        w: &mut Window,
        cx: &mut App,
    ) {
        if let Some(child) = &mut self.child {
            child.paint(w, cx);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rows(keys: &[(&str, f32)]) -> Vec<(String, f32)> {
        keys.iter().map(|(k, y)| ((*k).to_owned(), *y)).collect()
    }
    fn armed() -> Motion {
        Motion {
            viewport: Some(Default::default()),
            ..Motion::default()
        }
    }

    #[test]
    fn steady_keeps_the_longest_ordered_run() {
        // "d" moved to the top: a, b, c keep their order and slide.
        assert_eq!(steady(&[3, 0, 1, 2]), HashSet::from([0, 1, 2]));
        assert_eq!(steady(&[]), HashSet::new());
        assert_eq!(steady(&[0, 1]), HashSet::from([0, 1]));
        assert_eq!(steady(&[1, 0]).len(), 1);
    }

    #[test]
    fn a_send_raises_one_row_and_slides_the_rest() {
        let mut m = armed();
        let before = rows(&[("a", 0.), ("b", 48.), ("c", 96.), ("d", 144.)]);
        let after = rows(&[("d", 0.), ("a", 48.), ("b", 96.), ("c", 144.)]);
        m.arm(&before, &after);
        assert!(m.active() && m.pending);
        assert_eq!(m.offset("d"), 144.);
        assert!(m.raised("d"));
        for key in ["a", "b", "c"] {
            assert_eq!(m.offset(key), -48.);
            assert!(!m.raised(key));
        }
        assert_eq!(m.opacity("d"), 1.);
    }

    #[test]
    fn entries_fade_exits_close_and_unchanged_layouts_keep_moving() {
        let mut m = armed();
        let before = rows(&[("a", 0.), ("gone", 48.), ("c", 96.)]);
        let after = rows(&[("new", 0.), ("a", 48.), ("c", 96.)]);
        m.arm(&before, &after);
        assert_eq!(m.opacity("new"), 0.);
        assert_eq!(m.offset("new"), 0.);
        assert_eq!(m.offset("a"), -48.);
        assert_eq!(m.offset("c"), 0.);
        assert!(!m.moves.contains_key("gone"));
        // Halfway, the same layout again (a refresh without a move) continues.
        m.pending = false;
        m.t = 0.5;
        m.arm(&after, &after);
        assert!(!m.pending);
        assert_eq!(m.offset("a"), -24.);
    }

    #[test]
    fn a_reversal_starts_where_rows_show() {
        let mut m = armed();
        let first = rows(&[("a", 0.), ("b", 48.)]);
        let swapped = rows(&[("b", 0.), ("a", 48.)]);
        m.arm(&first, &swapped);
        m.pending = false;
        m.t = 0.25;
        let a_shown = 48. + m.offset("a");
        let b_shown = m.offset("b");
        m.arm(&swapped, &first);
        assert_eq!(m.offset("a"), a_shown);
        assert_eq!(48. + m.offset("b"), b_shown);
        // A row still fading in keeps its shown opacity.
        let mut m = armed();
        let entered = rows(&[("new", 0.), ("a", 48.), ("b", 96.)]);
        m.arm(&first, &entered);
        m.pending = false;
        m.t = 0.5;
        m.arm(&entered, &rows(&[("new", 0.), ("b", 48.), ("a", 96.)]));
        assert_eq!(m.opacity("new"), 0.5);
    }

    #[test]
    fn first_lists_and_unsampled_lists_never_arm() {
        let mut m = Motion::default();
        m.arm(&rows(&[("a", 0.)]), &rows(&[("b", 0.), ("a", 48.)]));
        assert!(!m.active());
        let mut m = armed();
        m.arm(&[], &rows(&[("a", 0.)]));
        assert!(!m.active());
    }
}
