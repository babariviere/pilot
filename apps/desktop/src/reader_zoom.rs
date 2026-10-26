//! Reader-local geometry, never application zoom or rasterized native content.
use gpui_kit::{
    AnyElement, Context, InteractiveElement, IntoElement, ParentElement, Pixels, Point,
    ScrollHandle, StatefulInteractiveElement, Styled, TestSupportExt,
    component::{
        Sizable, StyledExt,
        button::{Button, ButtonVariants},
    },
    div, point, px,
};
use std::{cell::Cell, rc::Rc};

#[derive(Clone, Copy)]
pub(crate) enum Command {
    Fit,
    Actual,
    In,
    Out,
    Reset,
}
type Drag = Rc<Cell<Option<(Point<Pixels>, Point<Pixels>)>>>;
#[derive(Clone, Default)]
pub(crate) struct Zoom {
    pub(crate) scale: Option<f32>,
    pub(crate) scroll: ScrollHandle,
    pub(crate) viewport: Rc<Cell<[f32; 2]>>,
    drag: Drag,
}
impl Zoom {
    pub(crate) fn key(event: &gpui_kit::KeyDownEvent) -> Option<Command> {
        if !(event.keystroke.modifiers.platform || event.keystroke.modifiers.control) {
            return None;
        }
        match event.keystroke.key.as_str() {
            "+" | "=" => Some(Command::In),
            "-" => Some(Command::Out),
            "0" => Some(Command::Reset),
            "1" => Some(Command::Actual),
            _ => None,
        }
    }
    pub(crate) fn pan_key(&self, event: &gpui_kit::KeyDownEvent) -> bool {
        if !event.keystroke.modifiers.alt {
            return false;
        }
        let delta = match event.keystroke.key.as_str() {
            "left" => point(px(48.), px(0.)),
            "right" => point(px(-48.), px(0.)),
            "up" => point(px(0.), px(48.)),
            "down" => point(px(0.), px(-48.)),
            _ => return false,
        };
        self.scroll.set_offset(self.scroll.offset() + delta);
        true
    }
    pub(crate) fn apply(&mut self, command: Command, fit: f32) {
        self.scale = match command {
            Command::Fit | Command::Reset => None,
            Command::Actual => Some(1.),
            Command::In => Some((self.scale.unwrap_or(fit) * 1.25).clamp(0.1, 8.)),
            Command::Out => Some((self.scale.unwrap_or(fit) / 1.25).clamp(0.1, 8.)),
        };
        self.drag.set(None);
        self.scroll.set_offset(point(px(0.), px(0.)));
    }
    pub(crate) fn image_fit(&self, width: f32, height: f32) -> f32 {
        let [w, h] = self.viewport.get();
        (w / width).min(h / height).clamp(0.1, 8.)
    }
    pub(crate) fn toolbar<T: 'static>(
        &self,
        cx: &Context<T>,
        dispatch: impl Fn(&mut T, Command, &mut Context<T>) + Clone + 'static,
    ) -> AnyElement {
        let mut row = div().h_flex().flex_wrap().gap_1();
        for (id, label, command) in [
            ("reader-fit", "Fit", Command::Fit),
            ("reader-actual", "100%", Command::Actual),
            ("reader-out", "−", Command::Out),
            ("reader-in", "+", Command::In),
            ("reader-reset", "Reset", Command::Reset),
        ] {
            let dispatch = dispatch.clone();
            row = row.child(
                Button::new(id)
                    .ghost()
                    .small()
                    .label(label)
                    .tooltip(match command {
                        Command::In => "Zoom in (⌘+)",
                        Command::Out => "Zoom out (⌘−)",
                        Command::Actual => "Actual size (⌘1)",
                        Command::Fit | Command::Reset => "Fit and reset pan (⌘0)",
                    })
                    .accessibility_label(match command {
                        Command::In => "Zoom in",
                        Command::Out => "Zoom out",
                        Command::Actual => "Actual size (100%)",
                        _ => label,
                    })
                    .on_click(cx.listener(move |v, _, _, cx| dispatch(v, command, cx))),
            );
        }
        row.into_any_element()
    }
    pub(crate) fn surface<T: 'static>(&self, content: AnyElement, cx: &Context<T>) -> AnyElement {
        let owner = cx.weak_entity();
        let measured = self.viewport.clone();
        let drag = self.drag.clone();
        let down = drag.clone();
        let up = drag.clone();
        let scroll = self.scroll.clone();
        div()
            .id("reader-viewport")
            .test_support()
            .relative()
            .size_full()
            .min_h_0()
            .min_w_0()
            .overflow_hidden()
            .child(
                gpui_kit::canvas(
                    move |b, window, cx| {
                        let next = [f32::from(b.size.width), f32::from(b.size.height)];
                        if measured.replace(next) != next {
                            let owner = owner.clone();
                            window.defer(cx, move |_, cx| {
                                let _ = owner.update(cx, |_, cx| cx.notify());
                            });
                        }
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .inset_0(),
            )
            .child(
                div()
                    .id("reader-scroll")
                    .size_full()
                    .overflow_scroll()
                    .track_scroll(&self.scroll)
                    .on_mouse_down(gpui_kit::MouseButton::Middle, move |e, _, cx| {
                        down.set(Some((e.position, scroll.offset())));
                        cx.stop_propagation();
                    })
                    .on_mouse_move({
                        let scroll = self.scroll.clone();
                        move |e, window, cx| {
                            if e.pressed_button == Some(gpui_kit::MouseButton::Middle)
                                && let Some((start, offset)) = drag.get()
                            {
                                scroll.set_offset(offset + e.position - start);
                                window.refresh();
                                cx.stop_propagation();
                            }
                        }
                    })
                    .on_mouse_up(gpui_kit::MouseButton::Middle, move |_, _, _| up.set(None))
                    .child(content),
            )
            .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounded_zoom_fit_actual_reset() {
        let mut z = Zoom::default();
        z.viewport.set([400., 200.]);
        assert_eq!(z.image_fit(1600., 800.), 0.25);
        z.apply(Command::In, 0.25);
        assert_eq!(z.scale, Some(0.3125));
        for _ in 0..100 {
            z.apply(Command::In, 1.);
        }
        assert_eq!(z.scale, Some(8.));
        for _ in 0..100 {
            z.apply(Command::Out, 1.);
        }
        assert_eq!(z.scale, Some(0.1));
        z.apply(Command::Actual, 1.);
        assert_eq!(z.scale, Some(1.));
        z.apply(Command::Reset, 1.);
        assert_eq!(z.scale, None);
    }
}
