//! Measured composer slots. The full-size child keeps its layout and editing
//! state; only its clipped slot eases. Removed children disappear immediately.
use crate::transition::{Transition, ease_out};
use gpui_kit::{
    AnyElement, Context, InteractiveElement, IntoElement, ParentElement, Pixels, Size, Styled,
    Window, component::StyledExt, div, prelude::FluentBuilder, px,
};
use std::{cell::RefCell, rc::Rc, time::Duration};

pub(crate) type State = Rc<RefCell<Height>>;

#[derive(Default)]
pub(crate) struct Height {
    scope: Option<String>,
    viewport: Size<Pixels>,
    rem: Pixels,
    width: Option<Pixels>,
    target: Option<f32>,
    from: f32,
    shown: f32,
    transition: Transition,
}

/// `gap` is the parent's existing following gap. Include it in the reveal,
/// cancelling the parent's gap with a margin, so empty slots leave no space.
pub(crate) fn slot<T: 'static>(
    id: &'static str,
    state: &State,
    scope: Option<String>,
    child: Option<AnyElement>,
    gap: f32,
    w: &mut Window,
    cx: &mut Context<T>,
) -> AnyElement {
    let mut height = state.borrow_mut();
    if height.scope != scope || height.viewport != w.viewport_size() || height.rem != w.rem_size() {
        height.scope = scope;
        height.viewport = w.viewport_size();
        height.rem = w.rem_size();
        height.width = None;
        height.target = None;
        height.shown = 0.;
        height.from = 0.;
        height.transition = Transition::default();
    }
    if child.is_none() && height.target != Some(0.) {
        height.target = Some(0.);
        height.from = height.shown;
        if height.shown > 0. {
            height.transition.start(cx);
        } else {
            height.transition = Transition::default();
        }
    }
    let natural = height.target.is_none() || cx.reduce_motion();
    if let Some(target) = height.target {
        let t = ease_out(
            height
                .transition
                .progress(Duration::from_millis(200), w, cx),
        );
        height.shown = height.from + (target - height.from) * t;
    }
    let shown = height.shown;
    drop(height);
    if child.is_none() && (natural || shown == 0.) {
        return div().hidden().into_any_element();
    }
    let owner = cx.weak_entity();
    let state = state.clone();
    let slot = div()
        .v_flex()
        .flex_none()
        .min_w_0()
        .justify_end()
        .overflow_hidden()
        .mb(px(-gap))
        .when(!natural, |d| d.h(px(shown)))
        .children(child.map(|child| {
            div()
                .flex_none()
                .w_full()
                .min_w_0()
                .pb(px(gap))
                .child(child)
        }))
        .on_children_prepainted(move |bounds, w, cx| {
            let Some(bounds) = bounds.first() else {
                return;
            };
            let target = f32::from(bounds.size.height);
            let mut height = state.borrow_mut();
            let resized = height.width.is_some_and(|width| width != bounds.size.width);
            height.width = Some(bounds.size.width);
            if height.target == Some(target) && !resized {
                return;
            }
            if height.target.is_none() || resized || cx.reduce_motion() {
                height.shown = target;
                height.from = target;
                height.transition = Transition::default();
            } else {
                height.from = height.shown;
                height.transition.start(cx);
            }
            height.target = Some(target);
            drop(height);
            let _ = owner.update(cx, |_, cx| cx.notify());
            w.request_animation_frame();
        })
        .id(id);
    #[cfg(any(test, feature = "native-probes"))]
    let slot = {
        use gpui_kit::TestSupportExt;
        slot.test_support()
    };
    slot.into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui_kit::{AppContext, Render, TestAppContext, size, test::TestWindowExt};

    struct Fixture {
        state: State,
        height: f32,
        scope: &'static str,
    }
    impl Render for Fixture {
        fn render(&mut self, w: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
            let child = div().h(px(self.height)).into_any_element();
            div().v_flex().w_full().child(slot(
                "height-slot",
                &self.state,
                Some(self.scope.into()),
                Some(child),
                0.,
                w,
                cx,
            ))
        }
    }

    #[gpui_kit::test]
    fn viewport_resize_and_identity_change_snap_during_motion(cx: &mut TestAppContext) {
        let view = cx.add_window(|_, _| Fixture {
            state: Default::default(),
            height: 40.,
            scope: "chat-a",
        });
        let draw = |cx: &mut TestAppContext| {
            cx.update_window(view.into(), |_, w, cx| {
                w.draw(cx).clear(cx);
                f32::from(w.find("height-slot").bounds().size.height)
            })
            .unwrap()
        };
        assert_eq!(draw(cx), 40.);
        view.update(cx, |v, _, cx| {
            v.height = 100.;
            cx.notify();
        })
        .unwrap();
        assert_eq!(draw(cx), 40.);
        cx.executor().advance_clock(Duration::from_millis(64));
        view.update(cx, |_, _, cx| cx.notify()).unwrap();
        let partial = draw(cx);
        assert!(partial > 40. && partial < 100.);
        cx.simulate_window_resize(view.into(), size(px(600.), px(700.)));
        assert_eq!(
            draw(cx),
            100.,
            "viewport resize cancels easing in the same draw"
        );
        view.update(cx, |v, _, cx| {
            v.height = 60.;
            v.scope = "chat-b";
            cx.notify();
        })
        .unwrap();
        assert_eq!(
            draw(cx),
            60.,
            "another chat never inherits the previous height"
        );
    }
}
