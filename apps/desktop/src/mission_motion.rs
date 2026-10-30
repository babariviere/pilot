//! Mission-only presentation state. Counts and task identity stay authoritative;
//! only the displayed fractions and row offsets follow the shared executor clock.
use crate::{
    mission_browser::{BAR_ORDER, Key},
    transition::{self, Reveal, Transition},
    ui,
};
use gpui_kit::{
    AnyElement, App, Bounds, ContentMask, Element, ElementId, GlobalElementId, InspectorElementId,
    InteractiveElement, IntoElement, LayoutId, ParentElement, Pixels, ScrollHandle, SharedString,
    Styled, TestSupportExt, Window, canvas, component::ActiveTheme, div, point, px,
};
use std::{cell::RefCell, collections::HashMap, rc::Rc, time::Duration};

const DURATION: Duration = Duration::from_millis(200);

#[cfg(feature = "native-probes")]
#[path = "mission_motion_probe.rs"]
pub(crate) mod probe;

#[derive(Default)]
pub(super) struct BriefState {
    reveal: Reveal<()>,
    #[cfg(feature = "native-probes")]
    shown: f32,
}

#[derive(Default)]
pub(super) struct Motion {
    key: Option<Key>,
    bars: HashMap<String, Bar>,
    rows: HashMap<String, Rc<RefCell<Row>>>,
    pub(super) brief: Rc<RefCell<BriefState>>,
}
impl Motion {
    pub(super) fn enter(&mut self, key: Option<&Key>) {
        if self.key.as_ref() != key {
            *self = Self {
                key: key.cloned(),
                ..Default::default()
            };
        }
    }
    pub(super) fn retain_rows(
        &mut self,
        ids: &[&str],
        fallback: &gpui_kit::FocusHandle,
        w: &mut Window,
        cx: &mut App,
    ) {
        self.rows.retain(|id, row| {
            let keep = ids.contains(&id.as_str());
            if !keep && row.borrow().focus.iter().any(|f| f.is_focused(w)) {
                fallback.focus(w, cx);
            }
            keep
        });
    }
    pub(super) fn retain_bars(&mut self, ids: &[String]) {
        self.bars.retain(|id, _| ids.contains(id));
    }
    pub(super) fn hide_overview(&mut self) {
        self.bars.clear();
    }
    pub(super) fn focus(&mut self, id: &str, owner: bool, cx: &App) -> gpui_kit::FocusHandle {
        self.row_state(id, cx).borrow().focus[usize::from(owner)].clone()
    }
    fn row_state(&mut self, id: &str, cx: &App) -> Rc<RefCell<Row>> {
        self.rows
            .entry(id.into())
            .or_insert_with(|| {
                Rc::new(RefCell::new(Row {
                    focus: [cx.focus_handle(), cx.focus_handle()],
                    section: None,
                    viewport: Default::default(),
                    width: px(0.),
                    from: 0.,
                    shown: 0.,
                    target: 0.,
                    moving: false,
                    transition: Default::default(),
                }))
            })
            .clone()
    }
    pub(super) fn bar(
        &mut self,
        id: String,
        counts: &[(&'static str, usize)],
        w: &mut Window,
        cx: &App,
    ) -> AnyElement {
        let total = counts.iter().map(|c| c.1).sum::<usize>().max(1) as f32;
        let target = std::array::from_fn(|i| {
            counts
                .iter()
                .find(|c| c.0 == BAR_ORDER[i])
                .map_or(0., |c| c.1 as f32 / total)
        });
        let shown = self
            .bars
            .entry(id.clone())
            .or_default()
            .sample(target, w, cx);
        let mut track = cx.theme().muted_foreground;
        track.a *= 0.25;
        div()
            .id(SharedString::from(format!("{id}-bar")))
            .test_support()
            .flex()
            .h(px(6.))
            .w_full()
            .rounded_full()
            .overflow_hidden()
            .bg(track)
            .children(
                shown
                    .iter()
                    .enumerate()
                    .filter(|(_, f)| **f > 0.)
                    .map(|(i, f)| {
                        div()
                            .id(SharedString::from(format!("{id}-{}", BAR_ORDER[i])))
                            .test_support()
                            .h_full()
                            .w(gpui_kit::relative(*f))
                            .bg(ui::task_status(BAR_ORDER[i], cx).2)
                    }),
            )
            .into_any_element()
    }
    pub(super) fn row(
        &mut self,
        id: &str,
        section: &'static str,
        scroll: ScrollHandle,
        child: AnyElement,
        cx: &App,
    ) -> MovingRow {
        let state = self.row_state(id, cx);
        let backdrop = state.clone();
        let child = div()
            .relative()
            .w_full()
            .min_w_0()
            .child(
                canvas(
                    |_, _, _| (),
                    move |bounds, _, w, cx| {
                        if backdrop.borrow().moving {
                            w.paint_quad(gpui_kit::fill(bounds, cx.theme().background));
                        }
                    },
                )
                .absolute()
                .top_0()
                .left_0()
                .size_full(),
            )
            .child(child)
            .into_any_element();
        MovingRow {
            state,
            section,
            scroll,
            child: Some(child),
        }
    }
}

#[derive(Default)]
struct Bar {
    target: Option<[f32; 4]>,
    from: [f32; 4],
    shown: [f32; 4],
    transition: Transition,
}
impl Bar {
    fn sample(&mut self, target: [f32; 4], w: &mut Window, cx: &App) -> [f32; 4] {
        if self.target.is_none() {
            self.shown = target;
            self.from = target;
        } else if self.target != Some(target) {
            self.from = self.shown;
            self.transition.start(cx);
        }
        self.target = Some(target);
        let t = transition::ease_out(self.transition.progress(DURATION, w, cx));
        self.shown = std::array::from_fn(|i| self.from[i] + (target[i] - self.from[i]) * t);
        self.shown
    }
}

struct Row {
    focus: [gpui_kit::FocusHandle; 2],
    section: Option<&'static str>,
    viewport: gpui_kit::Size<Pixels>,
    width: Pixels,
    from: f32,
    shown: f32,
    target: f32,
    moving: bool,
    transition: Transition,
}

/// Layout is already the final layout. Only the live row's prepaint origin moves,
/// so hitboxes follow it and no obsolete copy can receive input. Scroll is removed
/// from the remembered position; scrolling itself must never become an animation.
pub(super) struct MovingRow {
    state: Rc<RefCell<Row>>,
    section: &'static str,
    scroll: ScrollHandle,
    child: Option<AnyElement>,
}
impl IntoElement for MovingRow {
    type Element = Self;
    fn into_element(self) -> Self {
        self
    }
}
impl Element for MovingRow {
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
        (
            self.child
                .as_mut()
                .expect("row child before prepaint")
                .request_layout(w, cx),
            (),
        )
    }
    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        w: &mut Window,
        cx: &mut App,
    ) {
        let mut row = self.state.borrow_mut();
        let target = f32::from(bounds.origin.y - self.scroll.offset().y);
        let resized = row.viewport != w.viewport_size() || row.width != bounds.size.width;
        if row.section.is_none() || resized || cx.reduce_motion() {
            row.shown = target;
            row.from = target;
            row.transition = Transition::default();
        } else if row.section != Some(self.section) {
            row.from = row.shown;
            row.transition.start(cx);
        } else if row.target != target {
            // A different row changed height/order: apply that layout immediately.
            row.from += target - row.target;
            row.shown += target - row.target;
        }
        row.section = Some(self.section);
        row.viewport = w.viewport_size();
        row.width = bounds.size.width;
        row.target = target;
        let t = transition::ease_out(row.transition.progress(DURATION, w, cx));
        row.shown = row.from + (target - row.from) * t;
        let offset = px(row.shown - target);
        row.moving = offset != px(0.);
        drop(row);
        if offset != px(0.) {
            // A moving row passes over section headings, never through their
            // letters. Keep its own hitboxes and the page's scroll/clip mask.
            w.defer_draw(
                self.child.take().expect("moving row child"),
                w.element_offset() + point(px(0.), offset),
                0,
                Some(w.content_mask()),
            );
        } else {
            self.child
                .as_mut()
                .expect("stationary row child")
                .prepaint(w, cx);
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

/// The brief is a full workspace, not an inline disclosure. Clip its full-size
/// child on entry; on exit remove that child immediately and collapse an empty
/// page-coloured edge over the returning overview. Focus/drafts remain with their
/// existing owners. No text reflow or retained interactive exit snapshot.
pub(super) struct Brief {
    pub(super) reveal: Rc<RefCell<BriefState>>,
    pub(super) open: bool,
    pub(super) child: AnyElement,
}
impl IntoElement for Brief {
    type Element = Self;
    fn into_element(self) -> Self {
        self
    }
}
impl Element for Brief {
    type RequestLayoutState = ();
    type PrepaintState = Bounds<Pixels>;
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
        (self.child.request_layout(w, cx), ())
    }
    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        w: &mut Window,
        cx: &mut App,
    ) -> Bounds<Pixels> {
        let mut state = self.reveal.borrow_mut();
        // Keep the clock in fractions: resize changes the full child and mask
        // immediately, without restarting the disclosure or retaining old pixels.
        let shown = state.reveal.extent(self.open.then_some(((), 1.)), w, cx)
            * f32::from(bounds.size.height);
        #[cfg(feature = "native-probes")]
        {
            state.shown = shown;
        }
        drop(state);
        let mut mask = bounds;
        if self.open {
            mask.size.height = px(shown);
        } else {
            mask.origin.y += px(shown);
            mask.size.height -= px(shown);
        }
        w.with_content_mask(Some(ContentMask { bounds: mask }), |w| {
            self.child.prepaint(w, cx);
        });
        mask
    }
    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        mask: &mut Bounds<Pixels>,
        w: &mut Window,
        cx: &mut App,
    ) {
        if !self.open && mask.origin.y > bounds.origin.y {
            let mut edge = bounds;
            edge.size.height = mask.origin.y - bounds.origin.y;
            w.paint_quad(gpui_kit::fill(edge, cx.theme().background));
        }
        w.with_content_mask(Some(ContentMask { bounds: *mask }), |w| {
            self.child.paint(w, cx)
        });
    }
}
