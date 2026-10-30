//! Measured conversation disclosure slots. Only explicit user intent arms motion;
//! streaming and initial mount keep their natural geometry.
use crate::transition::{Transition, ease_out};
use gpui_kit::{
    App, ElementId, InteractiveElement, IntoElement, ParentElement, Pixels, Size, Styled,
    TestSupportExt, Window, component::StyledExt, div, prelude::FluentBuilder, px,
};
use std::{cell::RefCell, rc::Rc, time::Duration};

#[derive(Default)]
struct State {
    transition: Transition,
    natural: Option<Size<Pixels>>,
    shown: f32,
    from: f32,
    active: bool,
    first: bool,
    queued: bool,
    viewport: Size<Pixels>,
    rem: Pixels,
}

#[derive(Clone, Default)]
pub(crate) struct Height(Rc<RefCell<State>>);
impl Height {
    /// A parent disclosure owns this extent now; do not resume an unmounted
    /// child's old animation when the parent is opened again.
    pub(crate) fn finish(&self) {
        self.0.borrow_mut().active = false;
    }

    pub(crate) fn start(&self, cx: &App) {
        let mut s = self.0.borrow_mut();
        s.from = s.shown;
        s.active = s.natural.is_some() && !cx.reduce_motion();
        s.first = true;
        s.transition.start(cx);
    }

    /// Keep a full-size child in a clipped slot, never squeezing its text.
    /// Measurement runs in prepaint, after Taffy has resolved the actual width.
    /// The first changed frame holds the old extent while learning the target.
    pub(crate) fn wrap(
        &self,
        id: impl Into<ElementId>,
        child: impl IntoElement,
        w: &mut Window,
        cx: &App,
        on_frame: impl Fn(&mut Window, &mut App) + 'static,
    ) -> gpui_kit::AnyElement {
        let height = {
            let mut s = self.0.borrow_mut();
            if s.viewport != w.viewport_size() || s.rem != w.rem_size() || cx.reduce_motion() {
                s.active = false;
            }
            s.viewport = w.viewport_size();
            s.rem = w.rem_size();
            if s.active {
                let t = s.transition.progress(Duration::from_millis(200), w, cx);
                s.active = t < 1.;
                let target = s.natural.map_or(s.shown, |size| f32::from(size.height));
                s.shown = s.from + (target - s.from) * ease_out(t);
            }
            s.active.then_some(s.shown)
        };
        let state = self.0.clone();
        let on_frame = Rc::new(on_frame);
        div()
            .v_flex()
            .w_full()
            .min_w_0()
            .min_h_0()
            .overflow_hidden()
            .when_some(height, |slot, height| slot.h(px(height)))
            .child(div().w_full().min_w_0().flex_none().child(child))
            .on_children_prepainted(move |bounds, w, _| {
                let Some(bounds) = bounds.first() else { return };
                let mut s = state.borrow_mut();
                // Width/content changes are not disclosure intent. Stop rather
                // than animating streaming output or reflow during a resize.
                let resized = !s.first && s.natural.is_some_and(|size| size != bounds.size);
                let snap = s.active && resized;
                if snap {
                    s.active = false;
                }
                s.natural = Some(bounds.size);
                s.shown = height.unwrap_or_else(|| f32::from(bounds.size.height));
                s.first = false;
                if (s.active || snap) && !s.queued {
                    s.queued = true;
                    let state = state.clone();
                    let on_frame = on_frame.clone();
                    w.on_next_frame(move |w, cx| {
                        state.borrow_mut().queued = false;
                        on_frame(w, cx);
                    });
                }
            })
            .id(id)
            .test_support()
            .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::super::TranscriptView;
    use crate::model::{Message, ReaderKey};
    use gpui_kit::{
        AppContext, Bounds, TestAppContext, WindowBounds, WindowOptions, px, size,
        test::TestWindowExt,
    };
    use std::time::Duration;

    #[gpui_kit::test]
    fn window_resize_snaps_the_production_row_to_its_natural_height(cx: &mut TestAppContext) {
        cx.update(|cx| {
            gpui_kit::init(cx);
            crate::appearance::init_appearance(cx);
        });
        let (h, _) =
            cx.update(|cx| {
                gpui_kit::open_window(
                    WindowOptions {
                        window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                            Default::default(),
                            size(px(960.), px(760.)),
                        ))),
                        show: false,
                        ..Default::default()
                    },
                    cx,
                    |w, cx| {
                        cx.new(|cx| {
                            let mut t = TranscriptView::readonly(w, cx);
                            t.replace_readonly(
                                vec![
                                    Message::live(
                                        1,
                                        "You".into(),
                                        "Unicode 日本 and e\u{301} 👩‍💻 text fills this line. "
                                            .repeat(60),
                                    )
                                    .anchored(ReaderKey::model(1, 0, Some(0))),
                                ],
                                true,
                                cx,
                            );
                            t.hold_for_history(cx);
                            t
                        })
                    },
                )
                .unwrap()
            });
        let tick = |cx: &mut TestAppContext, ms| {
            cx.executor().advance_clock(Duration::from_millis(ms));
            cx.update_window(h, |_, w, cx| w.simulate_next_frame(cx))
                .unwrap();
            cx.run_until_parked();
            cx.update_window(h, |_, w, cx| {
                w.draw(cx).clear(cx);
                f32::from(w.find(("message-height", 1u64)).bounds().size.height)
            })
            .unwrap()
        };
        tick(cx, 0);
        cx.update_window(h, |_, w, cx| w.click(("message-fold", 1u64), cx))
            .unwrap();
        let opening = tick(cx, 64);
        cx.simulate_window_resize(h, size(px(640.), px(760.)));
        cx.run_until_parked();
        let resized = tick(cx, 0);
        assert!(
            resized > opening,
            "resize should immediately show the full rewrapped child"
        );
        cx.update(|cx| cx.set_reduce_motion(true));
        let natural = tick(cx, 0);
        assert_eq!(
            resized, natural,
            "no stale animated row measurement after resize"
        );
        cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
    }
}
