//! Mounted canvas input. One warm Draw lane, latest pointer per mounted canvas.
//! Animated canvases draw again after each paint that shows them, so frames
//! follow the display and stop while offscreen, collapsed or in another pane.
use super::*;
use gpui_kit::{
    Bounds, DispatchPhase, HitboxBehavior, MouseExitEvent, MouseMoveEvent, Pixels, ScrollWheelEvent,
};
use std::cell::{Cell, RefCell};
use std::rc::Weak;
use std::time::Instant;

type Geometry = Bounds<Pixels>;
pub(super) struct Mounted {
    pub(super) bounds: Rc<Cell<Option<Geometry>>>,
    lifetime: RefCell<Weak<()>>,
    generation: u64,
    version: u64,
    inline: bool,
    geometry: Geometry,
    scale: f32,
    pointer: Option<[f64; 2]>,
    /// Seconds of animation shown so far, and the paint that last advanced it.
    t: f64,
    tick: Option<Instant>,
}
impl Mounted {
    /// Advances animation time at a paint. Time pauses while the window is hidden
    /// (a long gap adds at most a tenth of a second) and stays 0 for still
    /// canvases and under Reduce Motion.
    fn advance(&mut self, animated: bool, reduce_motion: bool, shown: bool, now: Instant) {
        if !animated || reduce_motion {
            self.t = 0.;
            self.tick = None;
        } else if !shown {
            self.tick = None;
        } else {
            if let Some(last) = self.tick {
                self.t += now.saturating_duration_since(last).as_secs_f64().min(0.1);
            }
            self.tick = Some(now);
        }
    }
}
impl ArtifactPane {
    pub(super) fn prepare_canvases(&mut self) {
        let scene = self.snapshot.scene.as_ref();
        self.canvases.retain(|id, m| {
            m.bounds.set(None);
            scene.is_some_and(|s| s.canvases.iter().any(|(key, _)| key == id))
        });
        if let Some(scene) = scene {
            for (id, _) in &scene.canvases {
                self.canvases.entry(id.clone()).or_insert_with(|| Mounted {
                    bounds: Rc::new(Cell::new(None)),
                    lifetime: RefCell::new(Weak::new()),
                    generation: self.generation,
                    version: self.snapshot.version,
                    inline: self.inline,
                    geometry: Geometry::default(),
                    scale: 1.,
                    pointer: None,
                    t: 0.,
                    tick: None,
                });
            }
        }
    }
    pub(super) fn canvas_element(
        &self,
        id: String,
        height: f64,
        scale: f32,
        animated: bool,
        plan: Option<Arc<crate::visual_canvas_plan::Plan>>,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let (generation, version, inline) = (self.generation, self.snapshot.version, self.inline);
        let Some(mounted) = self.canvases.get(&id) else {
            return Self::note("Canvas is no longer mounted.");
        };
        // Only the current painted element/event observers keep this token.
        // Retaining the pane after its parent unmounts cannot retain admission.
        let lifetime = Rc::new(());
        *mounted.lifetime.borrow_mut() = Rc::downgrade(&lifetime);
        let proof = mounted.bounds.clone();
        let colors = crate::visual_canvas_view::palette(cx);
        let mono = cx.theme().mono_font_family.clone();
        let weak = cx.weak_entity();
        let report = {
            let id = id.clone();
            let proof = proof.clone();
            move |bounds: Geometry, pointer, cx: &mut gpui_kit::App| {
                let _mounted = &lifetime;
                if proof.get() != Some(bounds) {
                    return;
                }
                let _ = weak.update(cx, |view, cx| {
                    if generation != view.generation
                        || version != view.snapshot.version
                        || inline != view.inline
                        || view.source
                    {
                        return;
                    }
                    if let Some(mounted) = view.canvases.get_mut(&id)
                        && mounted.geometry == bounds
                        && mounted.version == version
                    {
                        mounted.pointer = pointer;
                        view.pump_canvas(cx);
                    }
                });
            }
        };
        let weak = cx.weak_entity();
        gpui_kit::canvas(
            move |bounds, window, cx| {
                let visible = bounds.intersect(&window.content_mask().bounds);
                if visible.size.width > px(0.) && visible.size.height > px(0.) {
                    proof.set(Some(bounds));
                    let shown = window.visibility().is_visible();
                    let id = id.clone();
                    let proof = proof.clone();
                    let weak = weak.clone();
                    window.defer(cx, move |_, cx| {
                        if proof.get() != Some(bounds) {
                            return;
                        }
                        let _ = weak.update(cx, |view, cx| {
                            if generation != view.generation
                                || version != view.snapshot.version
                                || inline != view.inline
                                || view.source
                            {
                                return;
                            }
                            if let Some(mounted) = view.canvases.get_mut(&id) {
                                if mounted.geometry != bounds
                                    || mounted.version != version
                                    || mounted.scale != scale
                                {
                                    mounted.pointer = None;
                                }
                                mounted.generation = generation;
                                mounted.version = version;
                                mounted.inline = inline;
                                mounted.geometry = bounds;
                                mounted.scale = scale;
                                let now = cx.background_executor().now();
                                mounted.advance(animated, cx.reduce_motion(), shown, now);
                            }
                            view.pump_canvas(cx);
                        });
                    });
                }
                window.insert_hitbox(bounds, HitboxBehavior::Normal)
            },
            move |bounds, hitbox, window, cx| {
                if let Some(plan) = &plan
                    && (plan.width - f32::from(bounds.size.width) / scale).abs() < 0.5
                    && (plan.height - f32::from(bounds.size.height) / scale).abs() < 0.5
                {
                    crate::visual_canvas_view::paint_scaled(
                        plan, bounds, &colors, &mono, scale, window, cx,
                    );
                }
                let moved = report.clone();
                window.on_mouse_event(move |event: &MouseMoveEvent, phase, window, cx| {
                    if phase == DispatchPhase::Capture {
                        let pointer = hitbox.is_hovered(window).then(|| {
                            [
                                f64::from(f32::from(event.position.x - bounds.left()) / scale),
                                f64::from(f32::from(event.position.y - bounds.top()) / scale),
                            ]
                        });
                        moved(bounds, pointer, cx);
                    }
                });
                let leave = report.clone();
                window.on_mouse_event(move |_: &MouseExitEvent, phase, _, cx| {
                    if phase == DispatchPhase::Capture {
                        leave(bounds, None, cx);
                    }
                });
                window.on_mouse_event(move |_: &ScrollWheelEvent, phase, _, cx| {
                    if phase == DispatchPhase::Capture {
                        report(bounds, None, cx);
                    }
                });
            },
        )
        .w_full()
        .h(px(height as f32 * scale))
        .into_any_element()
    }

    pub(super) fn pump_canvas(&mut self, cx: &mut Context<Self>) {
        if self.busy || self.source || !self.snapshot.live {
            return;
        }
        let next = self.canvases.iter().find_map(|(id, m)| {
            if m.generation != self.generation
                || m.version != self.snapshot.version
                || m.inline != self.inline
                || m.bounds.get() != Some(m.geometry)
                || m.lifetime.borrow().upgrade().is_none()
            {
                return None;
            }
            let width = f64::from(f32::from(m.geometry.size.width) / m.scale);
            let height = f64::from(f32::from(m.geometry.size.height) / m.scale);
            let matches = self.snapshot.drawings.get(id).is_some_and(|f| {
                f.version == m.version
                    && f.pointer == m.pointer
                    && f.t == m.t
                    && (f.width - width).abs() < 0.5
                    && (f.height - height).abs() < 0.5
            });
            (!matches).then(|| (id.clone(), width, height, m.t, m.pointer))
        });
        if let Some((id, width, height, t, pointer)) = next {
            self.draw_pointer(
                self.generation,
                self.snapshot.version,
                id,
                width,
                height,
                t,
                pointer,
                cx,
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    fn mounted() -> Mounted {
        Mounted {
            bounds: Rc::new(Cell::new(None)),
            lifetime: RefCell::new(Weak::new()),
            generation: 0,
            version: 0,
            inline: false,
            geometry: Geometry::default(),
            scale: 1.,
            pointer: None,
            t: 0.,
            tick: None,
        }
    }
    #[test]
    fn animation_time_follows_paints_pauses_while_hidden_and_stays_zero_under_reduce_motion() {
        let start = Instant::now();
        let at = |ms| start + Duration::from_millis(ms);
        let mut m = mounted();
        m.advance(true, false, true, at(0));
        assert_eq!(m.t, 0., "the first frame draws at t = 0");
        m.advance(true, false, true, at(16));
        m.advance(true, false, true, at(33));
        assert!((m.t - 0.033).abs() < 1e-9);
        // A hidden window pauses time; coming back adds no more than 0.1 s.
        m.advance(true, false, false, at(500));
        assert!((m.t - 0.033).abs() < 1e-9);
        m.advance(true, false, true, at(5_000));
        m.advance(true, false, true, at(10_000));
        assert!((m.t - 0.133).abs() < 1e-9, "{}", m.t);
        m.advance(true, true, true, at(10_016));
        assert_eq!(m.t, 0., "Reduce Motion shows t = 0");
        m.advance(true, true, true, at(10_032));
        assert_eq!(m.t, 0.);
        let mut still = mounted();
        still.advance(false, false, true, at(0));
        still.advance(false, false, true, at(16));
        assert_eq!(still.t, 0.);
    }
}

#[cfg(feature = "native-probes")]
#[path = "artifact_canvas_probe.rs"]
pub(super) mod probe;
