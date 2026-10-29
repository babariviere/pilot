//! A bounded vertical scroll area nested inside the transcript.
//!
//! The transcript's `ScrollBounce` takes every wheel packet in the capture
//! phase, so a plain `overflow_y_scroll` child never moves. Here the scroller
//! under the pointer when a gesture starts keeps that whole gesture: an area
//! that can still move that way takes it, otherwise the transcript does. A
//! transcript gesture that slides an area under a resting pointer stays with
//! the transcript, and an area that reaches its end stops there.
use gpui_kit::{
    App, DispatchPhase, Div, Global, HitboxBehavior, IntoElement, ParentElement, Pixels,
    ScrollDelta, ScrollHandle, ScrollEvent, StatefulInteractiveElement, Styled, TouchPhase,
    Window, canvas, component::scroll::Scrollbar, div, px,
};
use std::{
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant},
};

/// A longer silence between packets ends a phaseless gesture, as in Base's bounce.
const GAP: Duration = Duration::from_millis(250);

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum Owner {
    #[default]
    Undecided,
    Outer,
    Area(u64),
}

/// The current wheel gesture over a transcript.
#[derive(Default)]
struct Gesture {
    owner: Owner,
    last: Option<Instant>,
    /// The previous packet moved vertically, so an area could have taken it.
    moved: bool,
}

impl Global for Gesture {}

fn vertical(event: &ScrollEvent, window: &Window) -> Option<Pixels> {
    let delta = event.delta.pixel_delta(window.line_height());
    (delta.y != px(0.) && delta.y.abs() >= delta.x.abs()).then_some(delta.y)
}

/// Marks gesture starts for the areas inside a transcript. Put it in the
/// transcript's positioned viewport before the scroller, so it acts first.
pub(crate) fn tracker() -> impl IntoElement {
    canvas(
        |bounds, window, _| window.insert_hitbox(bounds, HitboxBehavior::Normal),
        |_, hitbox, window, _| {
            window.on_mouse_event(move |event: &ScrollEvent, phase, window, cx| {
                if phase != DispatchPhase::Capture || !hitbox.should_handle_scroll(window) {
                    return;
                }
                let now = cx.background_executor().now();
                let moved = vertical(event, window).is_some();
                let gesture = cx.default_global::<Gesture>();
                let begins = event.touch_phase == TouchPhase::Started
                    || matches!(event.delta, ScrollDelta::Lines(_))
                    || gesture
                        .last
                        .is_none_or(|at| now.saturating_duration_since(at) >= GAP);
                if begins {
                    gesture.owner = Owner::Undecided;
                } else if gesture.owner == Owner::Undecided && gesture.moved {
                    // No area took the gesture's first movement.
                    gesture.owner = Owner::Outer;
                }
                gesture.moved = moved;
                gesture.last = Some(now);
            });
        },
    )
    .absolute()
    .inset_0()
}

/// One nested area's scroll position and gesture identity.
#[derive(Clone)]
pub(crate) struct NestedScroll {
    key: u64,
    handle: ScrollHandle,
}

impl Default for NestedScroll {
    fn default() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(1);
        Self {
            key: NEXT.fetch_add(1, Ordering::Relaxed),
            handle: ScrollHandle::default(),
        }
    }
}

impl NestedScroll {
    #[cfg(test)]
    pub(crate) fn offset(&self) -> Pixels {
        self.handle.offset().y
    }

    /// Scrolls `viewport`, which sets its own bounded height, with a
    /// scrollbar that shows while it moves. The viewport keeps its id.
    pub(crate) fn area(
        &self,
        viewport: impl StatefulInteractiveElement + Styled + IntoElement + 'static,
    ) -> Div {
        let (key, handle) = (self.key, self.handle.clone());
        div()
            .relative()
            .min_w_0()
            .child(viewport.overflow_hidden().track_scroll(&self.handle))
            .child(
                div()
                    .absolute()
                    .inset_0()
                    .child(Scrollbar::vertical(&self.handle).viewport_from_layout()),
            )
            // Last, so the scrollbar's own hitbox does not hide the area.
            .child(
                canvas(
                    |bounds, window, _| window.insert_hitbox(bounds, HitboxBehavior::Normal),
                    move |_, hitbox, window, _| {
                        let view = window.current_view();
                        window.on_mouse_event(
                            move |event: &ScrollEvent, phase, window, cx| {
                                if phase != DispatchPhase::Capture
                                    || !hitbox.should_handle_scroll(window)
                                {
                                    return;
                                }
                                let Some(dy) = vertical(event, window) else {
                                    return;
                                };
                                if scroll(key, &handle, dy, cx) {
                                    cx.notify(view);
                                }
                                if cx.default_global::<Gesture>().owner == Owner::Area(key) {
                                    cx.stop_propagation();
                                }
                            },
                        );
                    },
                )
                .absolute()
                .inset_0(),
            )
    }
}

/// Applies `dy` when this area owns the gesture, deciding it first if
/// needed. Returns whether the offset changed.
fn scroll(key: u64, handle: &ScrollHandle, dy: Pixels, cx: &mut App) -> bool {
    let max = handle.max_offset().y;
    let mut offset = handle.offset();
    let gesture = cx.default_global::<Gesture>();
    if gesture.owner == Owner::Undecided {
        let movable = if dy < px(0.) {
            offset.y > -max
        } else {
            offset.y < px(0.)
        };
        gesture.owner = if movable {
            Owner::Area(key)
        } else {
            Owner::Outer
        };
    }
    if gesture.owner != Owner::Area(key) {
        return false;
    }
    let y = (offset.y + dy).clamp(-max, px(0.));
    if y == offset.y {
        return false;
    }
    offset.y = y;
    handle.set_offset(offset);
    true
}
