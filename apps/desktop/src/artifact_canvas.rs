//! Mounted canvas input. One warm Draw lane, latest pointer per mounted canvas.
use super::*;
use gpui_kit::{
    Bounds, DispatchPhase, HitboxBehavior, MouseExitEvent, MouseMoveEvent, Pixels, ScrollWheelEvent,
};
use std::cell::{Cell, RefCell};
use std::rc::Weak;

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
                });
            }
        }
    }
    pub(super) fn canvas_element(
        &self,
        id: String,
        height: f64,
        scale: f32,
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
                    && (f.width - width).abs() < 0.5
                    && (f.height - height).abs() < 0.5
            });
            (!matches).then(|| (id.clone(), width, height, m.pointer))
        });
        if let Some((id, width, height, pointer)) = next {
            self.draw_pointer(
                self.generation,
                self.snapshot.version,
                id,
                width,
                height,
                pointer,
                cx,
            );
        }
    }
}

#[cfg(feature = "native-probes")]
#[path = "artifact_canvas_probe.rs"]
pub(super) mod probe;
