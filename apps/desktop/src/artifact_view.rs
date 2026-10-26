//! Native read-only artifact detail. User controls change isolated reader state only.
#[path = "artifact_gallery_view.rs"]
pub(crate) mod gallery;
#[cfg(feature = "native-probes")]
#[path = "artifact_image_probe.rs"]
pub(crate) mod image_probe;
#[cfg(feature = "native-probes")]
#[path = "artifact_slider_probe.rs"]
pub(crate) mod slider_probe;
use crate::{
    LocalOptions,
    app_icon::AppIcon,
    artifact_model::Reference,
    artifact_worker::{Command, Snapshot, Worker},
    visual_slider::{
        Flow as SliderFlow, Grid as SliderGrid, Intent as SliderIntent, Offer as SliderOffer,
        Spec as SliderSpec,
    },
};
use gpui_kit::base::SelectableText;
use gpui_kit::{
    AnyElement, AppContext, ClipboardItem, Context, Entity, InteractiveElement, IntoElement,
    ParentElement, Render, SharedString, StatefulInteractiveElement, Styled, Subscription, Task,
    TestSupportExt, Window,
    component::{
        ActiveTheme, Disableable, Sizable, StyledExt,
        button::{Button, ButtonVariants},
        checkbox::Checkbox,
        slider::{Slider, SliderEvent, SliderState},
    },
    div,
    prelude::FluentBuilder,
    px,
};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, VecDeque},
    hash::{DefaultHasher, Hash, Hasher},
    sync::Arc,
    time::Instant,
};
pub(crate) struct ArtifactPane {
    gallery: gallery::State,
    focus: Option<gpui_kit::FocusHandle>,
    options: Option<LocalOptions>,
    owner: Option<String>,
    items: Arc<Vec<Reference>>,
    reference: Option<Reference>,
    snapshot: Snapshot,
    worker: Option<Worker>,
    updates: Option<Task<()>>,
    generation: u64,
    busy: bool,
    source: bool,
    image_actual: bool,
    retired_image: Option<Arc<gpui_kit::RenderImage>>,
    source_copy: Option<Task<()>>,
    states: VecDeque<(Reference, String)>,
    sliders: BTreeMap<String, SliderBinding>,
    slider_flow: SliderFlow,
    slider_serial: u64,
    slider_synced: Option<(u64, u64, bool)>,
    slider_wake: Option<(Instant, Task<()>)>,
    slider_wake_serial: u64,
    #[cfg(feature = "native-probes")]
    slider_dispatches: VecDeque<(Instant, Instant, String)>,
}
struct SliderBinding {
    serial: u64,
    spec: SliderSpec,
    grid: SliderGrid,
    state: Entity<SliderState>,
    _subscription: Subscription,
}
impl ArtifactPane {
    pub(crate) fn new() -> Self {
        Self {
            gallery: gallery::State::default(),
            focus: None,
            options: None,
            owner: None,
            items: Arc::new(Vec::new()),
            reference: None,
            snapshot: Snapshot::default(),
            worker: None,
            updates: None,
            generation: 0,
            busy: false,
            source: false,
            image_actual: false,
            retired_image: None,
            source_copy: None,
            states: VecDeque::new(),
            sliders: BTreeMap::new(),
            slider_flow: SliderFlow::default(),
            slider_serial: 0,
            slider_synced: None,
            slider_wake: None,
            slider_wake_serial: 0,
            #[cfg(feature = "native-probes")]
            slider_dispatches: VecDeque::new(),
        }
    }
    pub(crate) fn preview(
        &mut self,
        reference: Reference,
        source: String,
        scene: crate::visual_scene::Scene,
        cx: &mut Context<Self>,
    ) {
        self.close();
        self.owner = Some(reference.session.clone());
        self.items = Arc::new(vec![reference.clone()]);
        self.reference = Some(reference.clone());
        self.snapshot = Snapshot {
            drawings: Default::default(),
            revision: Some(Arc::new(crate::artifact_model::Revision {
                reference,
                source: Arc::new(source),
                data: Value::Null,
                visual_supported: true,
                created_at: 0.,
                updated_at: 0.,
            })),
            scene: Some(Arc::new(scene)),
            state: None,
            version: 1,
            live: false,
            error: None,
            ..Default::default()
        };
        cx.notify();
    }
    pub(crate) fn preview_canvas(
        &mut self,
        reference: Reference,
        width: f64,
        cx: &mut Context<Self>,
    ) {
        let scene=crate::visual_scene::Scene::parse(json!({"api":1,"root":{"type":"column","children":[{"type":"text","size":"lg","weight":700,"runs":[{"text":"Static native canvas"}]},{"type":"canvas","id":"0.1","height":180,"animated":false,"label":"Synthetic canvas record"}]}})).unwrap();
        self.preview(
            reference,
            "Synthetic expected draw packet. No source evaluation.".into(),
            scene,
            cx,
        );
        let drawing = crate::visual_drawing::Drawing::checked(
            4,
            vec![
                10.,
                1.,
                7.,
                0.9,
                0.,
                12.,
                20.,
                width * 0.42,
                100.,
                8.,
                11.,
                1.,
                8.,
                0.8,
                0.,
                width * 0.72,
                70.,
                36.,
                12.,
                2.,
                0.,
                1.,
                1.,
                12.,
                138.,
                width - 12.,
                138.,
                20.,
                1.,
                1.,
                width / 2.,
                170.,
                0.,
                2.,
                600.,
                1.,
                2.,
                0.,
            ],
            vec!["Synthetic drawing · native primitives".into()],
        )
        .unwrap();
        let plan = crate::visual_canvas_plan::Plan::compile(&drawing, width, 180.).map(Arc::new);
        self.snapshot.drawings = Arc::new(std::collections::BTreeMap::from([(
            "0.1".into(),
            crate::artifact_worker::DrawingFrame {
                version: 1,
                width,
                height: 180.,
                plan,
            },
        )]));
    }
    pub(crate) fn options(&mut self, options: LocalOptions) {
        if self.options.as_ref().map(LocalOptions::host) != Some(options.host()) {
            self.close();
            self.states.clear();
            self.owner = None;
            self.items = Arc::new(Vec::new());
        }
        self.options = Some(options);
    }
    pub(crate) fn context(
        &mut self,
        owner: Option<String>,
        items: Arc<Vec<Reference>>,
        cx: &mut Context<Self>,
    ) {
        if self.owner != owner {
            self.close();
            self.reset_gallery(cx);
            self.owner = owner;
            cx.notify();
        }
        if !Arc::ptr_eq(&items, &self.items) {
            self.items = items;
            self.reconcile_gallery(cx);
            cx.notify();
        }
    }
    pub(crate) fn close(&mut self) {
        self.suspend_gallery();
        if let Some(raster) = self.snapshot.raster.take() {
            debug_assert!(
                self.retired_image.is_none(),
                "flush retired pixels before starting another image"
            );
            self.retired_image = Some(raster.image.clone());
        }
        self.source_copy = None;
        self.cancel_slider_wake();
        self.sliders.clear();
        self.slider_flow.clear();
        self.slider_synced = None;
        if let Some(worker) = self.worker.take() {
            self.reader_drain(worker.finished());
            drop(worker);
        }
        self.updates = None;
        self.reference = None;
        self.snapshot = Snapshot::default();
        self.generation += 1;
        self.busy = false;
        self.source = false;
        self.image_actual = false;
    }
    fn flush_image(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(image) = self.retired_image.take() {
            cx.drop_image(image, Some(window));
        }
    }
    fn copy_image_source(
        &mut self,
        source: Arc<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.source_copy.is_some() {
            return;
        }
        let generation = self.generation;
        self.source_copy = Some(cx.spawn_in(window, async move |view, cx| {
            let text = cx
                .background_executor()
                .spawn(async move { (*source).clone() })
                .await;
            let _ = view.update_in(cx, |view, _, cx| {
                if view.generation != generation {
                    return;
                }
                view.source_copy = None;
                cx.write_to_clipboard(ClipboardItem::new_string(text));
                cx.notify();
            });
        }));
        cx.notify();
    }
    pub(crate) fn open(
        &mut self,
        reference: Reference,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.owner.as_deref() != Some(&reference.session) {
            return;
        }
        self.close();
        self.flush_image(window, cx);
        // A transcript pin never grants the large-image budget by its text.
        // Only exact current-chat canonical metadata may upgrade an unknown pin.
        let reference = if reference.kind == "unknown" {
            self.items
                .iter()
                .find(|r| r.same_revision(&reference))
                .cloned()
                .unwrap_or(reference)
        } else {
            reference
        };
        self.reference = Some(reference.clone());
        self.gallery_target(&reference);
        self.busy = true;
        let focus = self.focus.get_or_insert_with(|| cx.focus_handle()).clone();
        window.focus(&focus, cx);
        self.begin_after_drain(window, cx);
        cx.notify();
    }
    fn start_detail_reader(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(reference) = self.reference.clone() else {
            return;
        };
        let Some(options) = self.options.clone() else {
            self.busy = false;
            cx.notify();
            return;
        };
        let state = self
            .states
            .iter()
            .find(|(r, _)| r.same_revision(&reference))
            .map(|(_, s)| s.clone());
        let generation = self.generation;
        match Worker::start(options, reference.clone(), state) {
            Ok((worker, updates)) => {
                self.worker = Some(worker);
                self.updates = Some(cx.spawn_in(window, async move |view, cx| {
                    while let Ok(snapshot) = updates.recv().await {
                        if view
                            .update_in(cx, |view, _, cx| {
                                view.accept(generation, &reference, snapshot, cx);
                            })
                            .is_err()
                        {
                            break;
                        }
                    }
                    let _ = view.update_in(cx, |view, _, cx| {
                        view.reader_ended(generation, &reference, cx)
                    });
                }));
            }
            Err(message) => {
                self.busy = false;
                self.snapshot.error = Some(crate::visual_runtime::Fault {
                    kind: "unavailable",
                    message: message.into(),
                    line: None,
                    limit: None,
                });
            }
        }
        cx.notify();
    }
    fn accept(
        &mut self,
        generation: u64,
        expected: &Reference,
        snapshot: Snapshot,
        cx: &mut Context<Self>,
    ) {
        if snapshot.version < self.snapshot.version
            || generation != self.generation
            || !self
                .reference
                .as_ref()
                .is_some_and(|r| r.same_revision(expected))
            || snapshot
                .revision
                .as_ref()
                .is_some_and(|r| !r.reference.same_revision(expected))
        {
            return;
        }
        if let (Some(revision), Some(state), Some(_)) =
            (&snapshot.revision, &snapshot.state, &snapshot.scene)
        {
            self.states
                .retain(|(r, _)| !r.same_revision(&revision.reference));
            self.states
                .push_back((revision.reference.clone(), state.clone()));
            while self.states.len() > 8 {
                self.states.pop_front();
            }
        }
        let healthy = snapshot.live && snapshot.error.is_none();
        self.slider_flow.finish(snapshot.version, healthy);
        self.snapshot = snapshot;
        self.busy = self.slider_flow.flight.is_some();
        self.pump_slider(cx);
        cx.notify();
    }
    fn valid_slider(&self, intent: &SliderIntent) -> bool {
        intent.generation == self.generation
            && self.snapshot.live
            && self.snapshot.error.is_none()
            && self.sliders.get(&intent.id).is_some_and(|binding| {
                binding.serial == intent.binding
                    && self
                        .snapshot
                        .scene
                        .as_ref()
                        .and_then(|s| s.sliders.get(&intent.id))
                        .is_some_and(|(spec, _)| *spec == binding.spec)
                    && self
                        .snapshot
                        .scene
                        .as_ref()
                        .and_then(|s| s.controls.get(&intent.id))
                        .is_some_and(|c| c.accepts(&json!(intent.value)))
            })
    }
    fn reader_ended(&mut self, generation: u64, expected: &Reference, cx: &mut Context<Self>) {
        if generation != self.generation
            || !self
                .reference
                .as_ref()
                .is_some_and(|r| r.same_revision(expected))
        {
            return;
        }
        self.worker = None;
        self.updates = None;
        self.generation += 1;
        self.busy = false;
        self.slider_flow.clear();
        self.cancel_slider_wake();
        self.sliders.clear();
        self.slider_synced = None;
        self.snapshot.live = false;
        if self.snapshot.error.is_none() && !self.snapshot.complete {
            self.snapshot.error = Some(crate::visual_runtime::Fault {
                kind: "unavailable",
                message: "The isolated reader ended. Retry or reopen for a fresh preview.".into(),
                line: None,
                limit: None,
            });
        }
        cx.notify();
    }
    fn send_slider(&mut self, intent: SliderIntent, cx: &mut Context<Self>) {
        if self.busy || !self.valid_slider(&intent) {
            self.slider_flow.queued = None;
            self.cancel_slider_wake();
            self.slider_synced = None;
            return;
        }
        let version = self.snapshot.version;
        if self.worker.as_ref().is_some_and(|w| {
            w.command(Command::Event {
                version,
                id: intent.id.clone(),
                value: json!(intent.value),
            })
        }) {
            let now = cx.background_executor().now();
            #[cfg(feature = "native-probes")]
            {
                self.slider_dispatches
                    .push_back((now, Instant::now(), intent.id.clone()));
                if self.slider_dispatches.len() > 512 {
                    self.slider_dispatches.pop_front();
                }
            }
            self.slider_flow.sent(intent, version, now);
            self.busy = true;
        } else {
            self.worker = None;
            self.updates = None;
            self.generation += 1;
            self.slider_flow.clear();
            self.cancel_slider_wake();
            self.sliders.clear();
            self.slider_synced = None;
            self.snapshot.live = false;
            self.snapshot.error = Some(crate::visual_runtime::Fault {
                kind: "unavailable",
                message: "Isolated preview is unavailable. Reopen it to continue.".into(),
                line: None,
                limit: None,
            });
        }
        cx.notify();
    }
    fn slide(&mut self, intent: SliderIntent, cx: &mut Context<Self>) {
        if !intent.value.is_finite() || !self.valid_slider(&intent) {
            return;
        }
        let canonical = self.snapshot.scene.as_ref().unwrap().sliders[&intent.id].1;
        let offer = self.slider_flow.offer(
            &intent,
            self.busy,
            canonical,
            cx.background_executor().now(),
        );
        match offer {
            SliderOffer::Send | SliderOffer::Queued | SliderOffer::Cancelled => {
                self.slider_synced = None;
                cx.notify();
            }
            SliderOffer::Rejected => {
                self.slider_synced = None;
                cx.notify();
            }
            SliderOffer::Unchanged => {}
        }
        self.pump_slider(cx);
    }
    fn cancel_slider_wake(&mut self) {
        self.slider_wake = None;
        self.slider_wake_serial = self.slider_wake_serial.wrapping_add(1);
    }
    fn pump_slider(&mut self, cx: &mut Context<Self>) {
        if let Some(intent) = self.slider_flow.queued.as_ref()
            && (!self.valid_slider(intent)
                || (self.slider_flow.flight.is_none()
                    && self
                        .snapshot
                        .scene
                        .as_ref()
                        .is_some_and(|s| s.sliders[&intent.id].1 == intent.value)))
        {
            self.slider_flow.queued = None;
            self.slider_synced = None;
        }
        let now = cx.background_executor().now();
        if !self.busy
            && let Some(intent) = self.slider_flow.ready(now)
        {
            self.send_slider(intent, cx);
        }
        let deadline = (!self.busy).then(|| self.slider_flow.deadline()).flatten();
        if self.slider_wake.as_ref().map(|(due, _)| *due) == deadline {
            return;
        }
        self.cancel_slider_wake();
        if let Some(deadline) = deadline {
            let (serial, generation) = (self.slider_wake_serial, self.generation);
            let delay = deadline.saturating_duration_since(now);
            self.slider_wake = Some((
                deadline,
                cx.spawn(async move |view, cx| {
                    cx.background_executor().timer(delay).await;
                    let _ = view.update(cx, |view, cx| {
                        view.slider_due(generation, serial, cx);
                    });
                }),
            ));
        }
    }
    fn slider_due(&mut self, generation: u64, serial: u64, cx: &mut Context<Self>) {
        if serial != self.slider_wake_serial || generation != self.generation {
            return;
        }
        self.slider_wake = None;
        self.pump_slider(cx);
        cx.notify();
    }
    fn sync_sliders(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let key = (self.generation, self.snapshot.version, self.snapshot.live);
        if self.slider_synced == Some(key) {
            return;
        }
        self.slider_synced = Some(key);
        let Some(scene) = self.snapshot.scene.clone() else {
            self.sliders.clear();
            return;
        };
        self.sliders.retain(|id, b| {
            scene
                .sliders
                .get(id)
                .is_some_and(|(spec, _)| *spec == b.spec)
        });
        for (id, (spec, value)) in &scene.sliders {
            let Some(grid) = SliderGrid::new(spec) else {
                continue;
            };
            if !self.sliders.contains_key(id) {
                self.slider_serial = self.slider_serial.wrapping_add(1);
                let (serial, generation, id_) = (self.slider_serial, self.generation, id.clone());
                let state = cx.new(|_| {
                    SliderState::new()
                        .min(0.)
                        .max(grid.ticks as f32)
                        .step(1.)
                        .default_value(grid.position(*value))
                });
                let subscription = cx.subscribe(&state, move |v, _, event, cx| {
                    if let SliderEvent::Change(value) = event
                        && let Some(value) = grid.value(value.end())
                    {
                        v.slide(
                            SliderIntent {
                                generation,
                                binding: serial,
                                id: id_.clone(),
                                value,
                            },
                            cx,
                        );
                    }
                });
                self.sliders.insert(
                    id.clone(),
                    SliderBinding {
                        serial,
                        spec: spec.clone(),
                        grid,
                        state,
                        _subscription: subscription,
                    },
                );
            }
            let binding = &self.sliders[id];
            let shown = self
                .slider_flow
                .latest(id, binding.serial)
                .unwrap_or(*value);
            let index = binding.grid.position(shown);
            if binding.state.read(cx).value().end() != index {
                binding
                    .state
                    .update(cx, |state, cx| state.set_value(index, window, cx));
            }
        }
    }
    fn draw(
        &mut self,
        generation: u64,
        version: u64,
        id: String,
        width: f64,
        height: f64,
        cx: &mut Context<Self>,
    ) {
        if generation != self.generation
            || self.busy
            || !self.snapshot.live
            || version != self.snapshot.version
            || !(1.0..=2000.).contains(&width)
            || !self.snapshot.scene.as_ref().is_some_and(|s| {
                s.canvases
                    .iter()
                    .any(|(canvas, h)| canvas == &id && (*h - height).abs() < 0.5)
            })
        {
            return;
        }
        if self.snapshot.drawings.get(&id).is_some_and(|f| {
            f.version == version && (f.width - width).abs() < 0.5 && (f.height - height).abs() < 0.5
        }) {
            return;
        }
        if self.worker.as_ref().is_some_and(|w| {
            w.command(Command::Draw {
                version,
                id,
                width,
                height,
            })
        }) {
            self.busy = true;
            cx.notify();
        }
    }
    fn event(
        &mut self,
        generation: u64,
        version: u64,
        id: String,
        value: Value,
        cx: &mut Context<Self>,
    ) {
        if generation != self.generation
            || self.busy
            || !self.snapshot.live
            || version != self.snapshot.version
            || !self
                .snapshot
                .scene
                .as_ref()
                .and_then(|s| s.controls.get(&id))
                .is_some_and(|c| c.accepts(&value))
        {
            return;
        }
        if self
            .worker
            .as_ref()
            .is_some_and(|w| w.command(Command::Event { version, id, value }))
        {
            self.slider_flow.queued = None;
            self.cancel_slider_wake();
            self.slider_synced = None;
            self.busy = true;
            cx.notify();
        }
    }
    fn text(&self, id: String, text: String) -> AnyElement {
        let focus = self.focus.clone();
        let mut hash = DefaultHasher::new();
        text.hash(&mut hash);
        div()
            .id(SharedString::from(id.clone()))
            .test_support()
            .min_w_0()
            .w_full()
            .on_mouse_down(gpui_kit::MouseButton::Left, move |_, window, cx| {
                if let Some(focus) = &focus {
                    focus.focus(window, cx);
                }
            })
            .child(SelectableText::new(
                SharedString::from(format!("{id}-{}", hash.finish())),
                SharedString::from(text),
            ))
            .into_any_element()
    }
    fn note(text: &'static str) -> AnyElement {
        div()
            .p_3()
            .border_1()
            .rounded_md()
            .text_sm()
            .child(text)
            .into_any_element()
    }
    fn node(
        &self,
        value: &Value,
        path: &str,
        budget: &mut usize,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        if *budget < 8 {
            return Self::note("Native display budget reached. Source is retained.");
        }
        *budget -= 8;
        let kind = value["type"].as_str().unwrap_or("");
        let bytes: usize = match kind {
            "text" => value["runs"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|r| r["text"].as_str())
                .map(str::len)
                .sum(),
            "stat" => ["label", "value", "detail"]
                .iter()
                .filter_map(|k| value[*k].as_str())
                .map(str::len)
                .sum(),
            "table" => {
                value["rows"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .flat_map(|r| r.as_array().into_iter().flatten())
                    .filter_map(Value::as_str)
                    .map(str::len)
                    .sum::<usize>()
                    + value["columns"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|v| v["label"].as_str())
                        .map(str::len)
                        .sum::<usize>()
            }
            "tabs" => value["options"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|r| r["label"].as_str())
                .map(str::len)
                .sum(),
            "shader" | "mermaid" | "canvas" => 256,
            "chart" => {
                value["series"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|s| s["name"].as_str())
                    .map(str::len)
                    .sum::<usize>()
                    + value["x"]
                        .as_array()
                        .map(|labels| {
                            if labels.len() <= 12 {
                                labels
                                    .iter()
                                    .filter_map(Value::as_str)
                                    .map(str::len)
                                    .sum::<usize>()
                            } else {
                                [labels.first(), labels.last()]
                                    .into_iter()
                                    .flatten()
                                    .filter_map(Value::as_str)
                                    .map(str::len)
                                    .sum::<usize>()
                            }
                        })
                        .unwrap_or(0)
                    + 1024
            }
            "button" | "toggle" | "slider" | "link" => value["label"].as_str().map_or(0, str::len),
            _ => 0,
        };
        let text_cost = bytes.div_ceil(4);
        if text_cost > *budget {
            *budget = budget.saturating_sub(64);
            return Self::note(
                "Text exceeds the aggregate native display budget. Source retained.",
            );
        }
        *budget -= text_cost;
        let id = value["id"].as_str().unwrap_or(path).to_owned();
        let version = self.snapshot.version;
        let generation = self.generation;
        let enabled = self.snapshot.live && !self.busy;
        match kind {
            "column" | "row" | "grid" => {
                let mut box_ = div()
                    .id(SharedString::from(path.to_owned()))
                    .min_w_0()
                    .gap(px(value["gap"].as_f64().unwrap_or(12.) as f32));
                box_ = if kind == "row" {
                    box_.h_flex().items_start().flex_wrap()
                } else if kind == "grid" {
                    box_.grid()
                        .grid_cols(value["columns"].as_u64().unwrap_or(2) as u16)
                } else {
                    box_.v_flex()
                };
                box_ = match value["align"].as_str() {
                    Some("start") => box_.items_start(),
                    Some("center") => box_.items_center(),
                    Some("end") => box_.items_end(),
                    Some("baseline") => box_.items_baseline(),
                    _ => box_,
                };
                box_ = match value["justify"].as_str() {
                    Some("center") => box_.justify_center(),
                    Some("end") => box_.justify_end(),
                    Some("between") => box_.justify_between(),
                    _ => box_,
                };
                for (i, child) in value["children"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .enumerate()
                {
                    if *budget < 8 {
                        box_ = box_.child(Self::note("Native display budget reached."));
                        break;
                    }
                    box_ = box_.child(self.node(child, &format!("{path}.{i}"), budget, cx));
                }
                box_.into_any_element()
            }
            "text" => {
                let text = value["runs"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|r| r["text"].as_str())
                    .collect::<String>();
                if text.len() > 8192 {
                    return Self::note(
                        "Text exceeds the current native display limit. Copy Source retains it.",
                    );
                }
                let size = match value["size"].as_str() {
                    Some("xs") => 11.,
                    Some("sm") => 13.,
                    Some("lg") => 20.,
                    Some("xl") => 26.,
                    _ => 15.,
                };
                div()
                    .text_size(px(size))
                    .font_weight(gpui_kit::FontWeight(
                        value["weight"].as_f64().unwrap_or(400.) as f32,
                    ))
                    .text_color(crate::visual_chart_view::color(
                        value["color"].as_str().unwrap_or("text"),
                        cx,
                    ))
                    .when(value["mono"] == true, |d| {
                        d.font_family(cx.theme().mono_font_family.clone())
                    })
                    .child(self.text(path.into(), text))
                    .into_any_element()
            }
            "stat" => {
                div()
                    .v_flex()
                    .gap_1()
                    .p_3()
                    .rounded_md()
                    .border_1()
                    .border_color(cx.theme().border)
                    .child(
                        div()
                            .text_xs()
                            .text_color(cx.theme().muted_foreground)
                            .child(SharedString::from(
                                value["label"].as_str().unwrap_or("").to_owned(),
                            )),
                    )
                    .child(div().text_2xl().font_semibold().child(
                        self.text(path.into(), value["value"].as_str().unwrap_or("").into()),
                    ))
                    .children(
                        value["detail"]
                            .as_str()
                            .map(|s| div().text_xs().child(SharedString::from(s.to_owned()))),
                    )
                    .into_any_element()
            }
            "rule" => div()
                .w_full()
                .h(px(1.))
                .bg(cx.theme().border)
                .into_any_element(),
            "space" => div()
                .h(px(value["size"].as_f64().unwrap_or(12.) as f32))
                .into_any_element(),
            "link" => div()
                .v_flex()
                .child(self.text(path.into(), value["label"].as_str().unwrap_or("").into()))
                .child(
                    div()
                        .text_xs()
                        .text_color(cx.theme().muted_foreground)
                        .child("Link is inert; no external fetch."),
                )
                .into_any_element(),
            "button" => Button::new(SharedString::from(path.to_owned()))
                .small()
                .label(SharedString::from(
                    value["label"].as_str().unwrap_or("").to_owned(),
                ))
                .disabled(!enabled || value["disabled"] == true)
                .on_click(cx.listener(move |view, _, _, cx| {
                    view.event(generation, version, id.clone(), Value::Null, cx)
                }))
                .into_any_element(),
            "toggle" => Checkbox::new(SharedString::from(path.to_owned()))
                .label(SharedString::from(
                    value["label"].as_str().unwrap_or("").to_owned(),
                ))
                .checked(value["value"] == true)
                .disabled(!enabled)
                .on_change(cx.listener(move |view, v, _, cx| {
                    view.event(generation, version, id.clone(), json!(*v), cx)
                }))
                .into_any_element(),
            "tabs" => {
                let mut row = div().h_flex().flex_wrap().gap_1();
                for (i, option) in value["options"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .enumerate()
                {
                    let id = id.clone();
                    let val = option["value"].clone();
                    row = row.child(
                        Button::new(SharedString::from(format!("{path}-{i}")))
                            .ghost()
                            .small()
                            .label(SharedString::from(
                                option["label"].as_str().unwrap_or("").to_owned(),
                            ))
                            .disabled(!enabled || value["value"] == val)
                            .on_click(cx.listener(move |view, _, _, cx| {
                                view.event(generation, version, id.clone(), val.clone(), cx)
                            })),
                    );
                }
                row.into_any_element()
            }
            "slider" => {
                let binding = self.sliders.get(&id);
                let n = binding
                    .and_then(|b| self.slider_flow.latest(&id, b.serial))
                    .unwrap_or_else(|| value["value"].as_f64().unwrap_or(0.));
                let min = value["min"].as_f64().unwrap_or(0.);
                let max = value["max"].as_f64().unwrap_or(1.);
                let step = value["step"].as_f64().unwrap_or(1.);
                let minus = id.clone();
                let mut row = div().v_flex().gap_1().child(SharedString::from(format!(
                    "{}: {} {}",
                    value["label"].as_str().unwrap_or(""),
                    crate::visual_chart_view::number(n),
                    value["unit"].as_str().unwrap_or("")
                )));
                if let Some(binding) = binding {
                    let own_pending = self.slider_flow.latest(&id, binding.serial).is_some();
                    let own_flight =
                        self.slider_flow.flight.as_ref().is_some_and(|f| {
                            f.intent.id == id && f.intent.binding == binding.serial
                        });
                    row = row.child(
                        div()
                            .id(SharedString::from(format!("{path}-slider")))
                            .test_support()
                            .w_full()
                            .px_3()
                            .child(
                                Slider::new(&binding.state)
                                    .accessibility_label(format!(
                                        "{}: {} {}",
                                        binding.spec.label,
                                        crate::visual_chart_view::number(n),
                                        binding.spec.unit
                                    ))
                                    .disabled(!self.snapshot.live || (self.busy && !own_flight))
                                    .w_full(),
                            ),
                    );
                    if own_pending {
                        row = row.child(
                            div()
                                .text_xs()
                                .text_color(cx.theme().muted_foreground)
                                .child("Updating isolated preview…"),
                        );
                    }
                } else {
                    row = row.child(
                        div()
                            .text_xs()
                            .text_color(cx.theme().muted_foreground)
                            .child("This range/step uses precise steppers, not native dragging."),
                    );
                }
                row.child(
                    div()
                        .h_flex()
                        .gap_2()
                        .child(
                            Button::new(SharedString::from(format!("{path}-minus")))
                                .ghost()
                                .small()
                                .label("−")
                                .disabled(!enabled || n <= min)
                                .on_click(cx.listener(move |v, _, _, cx| {
                                    v.event(
                                        generation,
                                        version,
                                        minus.clone(),
                                        json!((n - step).clamp(min, max)),
                                        cx,
                                    )
                                })),
                        )
                        .child(
                            Button::new(SharedString::from(format!("{path}-plus")))
                                .ghost()
                                .small()
                                .label("+")
                                .disabled(!enabled || n >= max)
                                .on_click(cx.listener(move |v, _, _, cx| {
                                    v.event(
                                        generation,
                                        version,
                                        id.clone(),
                                        json!((n + step).clamp(min, max)),
                                        cx,
                                    )
                                })),
                        ),
                )
                .into_any_element()
            }
            "table" => {
                let rows = value["rows"].as_array().unwrap();
                let columns = value["columns"].as_array().unwrap();
                if rows.len() * columns.len() > 1024 || rows.len() * columns.len() > *budget {
                    return Self::note(
                        "Table exceeds the current native display budget. Source retained.",
                    );
                }
                *budget -= rows.len() * columns.len();
                let mut table = div()
                    .v_flex()
                    .min_w_0()
                    .gap_1()
                    .p_2()
                    .border_1()
                    .border_color(cx.theme().border);
                let mut header = div().h_flex().gap_2().font_semibold();
                for c in columns {
                    header = header.child(div().flex_1().min_w_0().child(SharedString::from(
                        c["label"].as_str().unwrap_or("").to_owned(),
                    )));
                }
                table = table.child(header);
                for (i, row) in rows.iter().enumerate() {
                    let mut cells = div()
                        .h_flex()
                        .gap_2()
                        .border_t_1()
                        .border_color(cx.theme().border);
                    for (j, cell) in row.as_array().unwrap().iter().enumerate() {
                        cells = cells.child(div().flex_1().min_w_0().child(self.text(
                            format!("{path}-{i}-{j}"),
                            if cell.is_null() {
                                "—".into()
                            } else if let Some(s) = cell.as_str() {
                                s.into()
                            } else {
                                crate::visual_chart_view::number(cell.as_f64().unwrap_or(0.))
                            },
                        )));
                    }
                    table = table.child(cells);
                }
                table.into_any_element()
            }
            "shader" => Self::note(
                "Shader rendering is deferred. Stored shader source/translation remains intact; other nodes remain usable.",
            ),
            "mermaid" => Self::note(
                "Native Mermaid renderer is not validated yet. Diagram source is retained; no browser fallback or external fetch.",
            ),
            "canvas" => {
                if value["animated"] == true {
                    return Self::note(
                        "Animated canvas rendering is not wired yet. Source remains intact.",
                    );
                }
                let frame = self
                    .snapshot
                    .drawings
                    .get(&id)
                    .filter(|f| f.version == version)
                    .cloned();
                let plan = frame.as_ref().and_then(|f| f.plan.as_ref().ok()).cloned();
                let error = frame.as_ref().and_then(|f| f.plan.as_ref().err()).copied();
                if let Some(plan) = &plan {
                    if plan.cost > *budget {
                        return Self::note(
                            "Canvas exceeds aggregate native display budget. Source retained.",
                        );
                    }
                    *budget -= plan.cost;
                }
                let weak = cx.weak_entity();
                let height = value["height"].as_f64().unwrap_or(160.);
                let colors = crate::visual_canvas_view::palette(cx);
                let mono = cx.theme().mono_font_family.clone();
                let live = self.snapshot.live;
                let busy = self.busy;
                let queued = frame.clone();
                let canvas = gpui_kit::canvas(
                    move |bounds, window, cx| {
                        let visible = bounds.intersect(&window.content_mask().bounds);
                        if visible.size.width <= px(0.)
                            || visible.size.height <= px(0.)
                            || !live
                            || busy
                        {
                            return;
                        }
                        let width = f32::from(bounds.size.width) as f64;
                        if queued.as_ref().is_some_and(|f| {
                            f.version == version
                                && (f.width - width).abs() < 0.5
                                && (f.height - height).abs() < 0.5
                        }) {
                            return;
                        }
                        let id = id.clone();
                        let weak = weak.clone();
                        window.defer(cx, move |_, cx| {
                            let _ = weak.update(cx, |view, cx| {
                                view.draw(generation, version, id, width, height, cx)
                            });
                        });
                    },
                    move |bounds, _, window, cx| {
                        if let Some(plan) = &plan {
                            crate::visual_canvas_view::paint(
                                plan, bounds, &colors, &mono, window, cx,
                            );
                        }
                    },
                )
                .size_full();
                div()
                    .id(SharedString::from(path.to_owned()))
                    .test_support()
                    .relative()
                    .w_full()
                    .h(px(height as f32))
                    .min_h(px(height as f32))
                    .max_h(px(height as f32))
                    .overflow_hidden()
                    .child(canvas)
                    .when(error.is_some(), |d| {
                        d.child(div().absolute().inset_0().child(Self::note(error.unwrap())))
                    })
                    .when(frame.is_none(), |d| {
                        d.child(div().absolute().inset_0().text_xs().child(if live {
                            "Drawing isolated canvas…"
                        } else {
                            "No canvas frame in this static snapshot."
                        }))
                    })
                    .into_any_element()
            }
            "chart" => match self
                .snapshot
                .scene
                .as_ref()
                .and_then(|s| s.charts.get(path))
            {
                Some(Ok(chart)) => {
                    let points = chart.series.iter().map(|s| s.points.len()).sum::<usize>();
                    if points > *budget {
                        Self::note(
                            "Chart exceeds aggregate native display budget. Source retained.",
                        )
                    } else {
                        *budget -= points;
                        crate::visual_chart_view::render(chart.clone(), path, cx)
                    }
                }
                Some(Err(message)) => Self::note(message),
                None => Self::note("Chart plan is unavailable; source retained."),
            },
            _ => Self::note("Unsupported native node. Source remains intact."),
        }
    }
}
impl Render for ArtifactPane {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.sync_sliders(window, cx);
        let focus = self.focus.get_or_insert_with(|| cx.focus_handle()).clone();
        let mut view = div()
            .id("artifact-detail")
            .test_support()
            .track_focus(&focus)
            .on_action(
                cx.listener(|_, _: &gpui_kit::base::input::Copy, window, cx| {
                    let text = gpui_kit::base::TextSelection::selected_text(window, cx);
                    if text.is_empty() {
                        cx.propagate();
                    } else {
                        cx.write_to_clipboard(ClipboardItem::new_string(text));
                    }
                }),
            )
            .v_flex()
            .size_full()
            .min_h_0()
            .min_w_0()
            .gap_2()
            .p_3();
        let Some(reference) = self.reference.clone() else {
            return view.p_0().gap_0().child(self.render_gallery(window, cx));
        };
        let scope = format!(
            "{}:{}:{}",
            reference.session, reference.id, reference.revision
        );
        let revision = self.snapshot.revision.clone();
        let scene = self.snapshot.scene.clone();
        let generation = self.generation;
        view = view.child(
            div()
                .h_flex()
                .flex_wrap()
                .gap_2()
                .child(
                    Button::new("artifact-back")
                        .ghost()
                        .small()
                        .label("All artifacts")
                        .icon(AppIcon::Artifacts.asset())
                        .on_click(cx.listener(move |v, _, window, cx| {
                            if v.generation != generation {
                                return;
                            }
                            v.show_gallery(window, cx);
                        })),
                )
                .child(
                    div()
                        .text_sm()
                        .font_semibold()
                        .child(SharedString::from(format!(
                            "{} · r{}",
                            revision
                                .as_ref()
                                .map_or(reference.title.as_str(), |r| r.reference.title.as_str()),
                            reference.revision
                        ))),
                ),
        );
        view = view.child(
            div()
                .text_xs()
                .text_color(cx.theme().muted_foreground)
                .child(
                    if revision
                        .as_ref()
                        .is_some_and(|r| r.reference.kind == "image")
                        || reference.kind == "image"
                    {
                        "Local · stored raster · static preview only"
                    } else {
                        "Local · current chat · visual controls have no file/network/tool bridge"
                    },
                ),
        );
        if self.busy && self.snapshot.scene.is_none() {
            view = view.child("Loading isolated preview…");
        }
        if let Some(error) = &self.snapshot.error {
            view = view.child(div().text_sm().text_color(cx.theme().danger).child(
                SharedString::from(format!(
                        "{}{}",
                        error
                            .line
                            .map(|n| format!("line {n}: "))
                            .unwrap_or_default(),
                        error.message
                    )),
            ));
            if self
                .snapshot
                .revision
                .as_ref()
                .is_some_and(|r| r.visual_supported || r.reference.kind == "image")
                || reference.kind == "image"
                || error.kind == "image"
            {
                let retry_reference = reference.clone();
                view = view.child(
                    Button::new("artifact-retry")
                        .ghost()
                        .small()
                        .label(
                            if reference.kind == "image"
                                || revision
                                    .as_ref()
                                    .is_some_and(|r| r.reference.kind == "image")
                            {
                                "Retry preview"
                            } else {
                                "Retry in fresh worker"
                            },
                        )
                        .icon(AppIcon::Retry.asset())
                        .disabled(self.busy)
                        .on_click(cx.listener(move |v, _, window, cx| {
                            if generation == v.generation && !v.busy && v.snapshot.error.is_some() {
                                if v.worker.as_ref().is_some_and(|w| w.command(Command::Retry)) {
                                    v.busy = true;
                                    cx.notify();
                                } else {
                                    v.open(retry_reference.clone(), window, cx);
                                }
                            }
                        })),
                );
            }
        }
        if let Some(revision) = revision {
            let source = revision.source.clone();
            let previous = reference.clone();
            view = view.child(
                div()
                    .h_flex()
                    .flex_wrap()
                    .gap_2()
                    .child(
                        Button::new("artifact-previous")
                            .ghost()
                            .small()
                            .label("Previous revision")
                            .icon(AppIcon::Back.asset())
                            .disabled(reference.revision <= 1 || self.busy)
                            .on_click(cx.listener(move |v, _, window, cx| {
                                if v.generation != generation || v.busy {
                                    return;
                                }
                                let mut r = previous.clone();
                                r.revision -= 1;
                                v.open(r, window, cx);
                            })),
                    )
                    .child(
                        Button::new("artifact-source")
                            .ghost()
                            .small()
                            .label(if self.source { "Hide source" } else { "Source" })
                            .icon(AppIcon::Source.asset())
                            .on_click(cx.listener(move |v, _, _, cx| {
                                if v.generation != generation {
                                    return;
                                }
                                v.source = !v.source;
                                cx.notify();
                            })),
                    )
                    .child(
                        Button::new("artifact-copy-source")
                            .ghost()
                            .small()
                            .label(if self.source_copy.is_some() {
                                "Copying source…"
                            } else {
                                "Copy source"
                            })
                            .disabled(self.source_copy.is_some())
                            .icon(AppIcon::Copy.asset())
                            .on_click(cx.listener(move |v, _, window, cx| {
                                if v.generation == generation {
                                    if v.snapshot
                                        .revision
                                        .as_ref()
                                        .is_some_and(|r| r.reference.kind == "image")
                                    {
                                        v.copy_image_source(source.clone(), window, cx);
                                    } else {
                                        cx.write_to_clipboard(ClipboardItem::new_string(
                                            (*source).clone(),
                                        ));
                                    }
                                }
                            })),
                    ),
            );
            if !revision.visual_supported && revision.reference.kind != "image" {
                view=view.child(Self::note("Preview family/runtime is unsupported here. Source/provenance is retained; no HTML, React, shader or external execution."));
            }
            if let Some(raster) = &self.snapshot.raster {
                view = view.child(
                    div()
                        .h_flex()
                        .flex_wrap()
                        .gap_2()
                        .child(
                            crate::ui::text(
                                crate::ui::Text::Caption,
                                format!(
                                    "{} · {} × {} pixels · {} encoded bytes{}",
                                    raster.mime,
                                    raster.width,
                                    raster.height,
                                    raster.encoded_bytes,
                                    if raster.first_frame {
                                        " · first frame only"
                                    } else {
                                        ""
                                    }
                                ),
                            )
                            .text_color(cx.theme().muted_foreground),
                        )
                        .when(!self.source, |row| {
                            row.child(
                                crate::ui::action(
                                    "artifact-image-scale",
                                    if self.image_actual {
                                        "Fit to window"
                                    } else {
                                        "Actual size"
                                    },
                                    crate::ui::Action::Quiet,
                                )
                                .on_click(cx.listener(
                                    move |view, _, _, cx| {
                                        if view.generation == generation
                                            && view.snapshot.raster.is_some()
                                        {
                                            view.image_actual = !view.image_actual;
                                            cx.notify();
                                        }
                                    },
                                )),
                            )
                        }),
                );
            }
            let mut content = div()
                .id(SharedString::from(scope))
                .test_support()
                .v_flex()
                .flex_1()
                .min_h_0()
                .min_w_0()
                .gap_3();
            if self.source {
                content =
                    content
                        .overflow_y_scroll()
                        .child(div().text_xs().child(SharedString::from(format!(
                            "{} · stored timestamps {} / {} ms Unix",
                            revision.reference.kind, revision.created_at, revision.updated_at
                        ))));
                if revision.reference.kind == "image" {
                    content=content.child(self.text("artifact-source-text".into(),format!("Stored embedded image source ({} bytes). Copy source explicitly to obtain the exact data URL.\nOwner: {}\nArtifact: {}\nRevision: {}",revision.source.len(),revision.reference.session,revision.reference.id,revision.reference.revision)));
                    if let Some(raster) = &self.snapshot.raster {
                        content = content.child(self.text(
                            "artifact-source-hash".into(),
                            format!("Source SHA-256: {}", raster.source_hash),
                        ));
                    }
                } else {
                    content = content.child(self.text(
                        "artifact-source-text".into(),
                        revision.source.chars().take(8192).collect(),
                    ));
                }
            } else if let Some(raster) = &self.snapshot.raster {
                content = content.relative().overflow_hidden().child(
                    crate::artifact_image_view::preview(raster, self.image_actual, window),
                );
            } else if let Some(scene) = scene {
                content = content.overflow_y_scroll();
                content = content.child(
                    div()
                        .text_xs()
                        .text_color(cx.theme().muted_foreground)
                        .child(SharedString::from(format!(
                            "{} validated nodes · {} canvas nodes",
                            scene.nodes,
                            scene.canvases.len()
                        ))),
                );
                content = content.child(self.node(&scene.root, "0", &mut 4096, cx));
            }
            view = view.child(content);
        }
        view
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use gpui_kit::{AppContext, TestAppContext};
    #[gpui_kit::test]
    fn artifact_image_static_completion_and_stale_generation_fences(cx: &mut TestAppContext) {
        let pane = cx.update(|cx| cx.new(|_| ArtifactPane::new()));
        pane.update(cx, |p, cx| {
            let mut r = reference(1);
            r.kind = "image".into();
            p.owner = Some(r.session.clone());
            p.reference = Some(r.clone());
            p.generation = 4;
            p.busy = true;
            let mut s = snapshot(r.clone());
            s.scene = None;
            s.state = None;
            s.live = false;
            s.complete = true;
            s.version = 1;
            p.accept(4, &r, s.clone(), cx);
            p.reader_ended(4, &r, cx);
            assert!(
                p.snapshot.complete && p.snapshot.error.is_none() && !p.busy && p.worker.is_none()
            );
            p.close();
            let generation = p.generation;
            p.accept(4, &r, s.clone(), cx);
            assert!(p.snapshot.revision.is_none());
            assert_eq!(p.generation, generation);
            p.reference = Some(r.clone());
            p.accept(generation, &reference(2), s, cx);
            assert!(p.snapshot.revision.is_none());
        });
    }
    fn reference(revision: u32) -> Reference {
        Reference {
            id: "synthetic".into(),
            session: "owner".into(),
            revision,
            title: "Synthetic".into(),
            kind: "visual".into(),
        }
    }
    fn snapshot(reference: Reference) -> Snapshot {
        Snapshot{drawings:Default::default(),revision:Some(Arc::new(crate::artifact_model::Revision{reference,source:Arc::new("synthetic source never evaluated".into()),data:Value::Null,visual_supported:true,created_at:1.,updated_at:2.})),scene:Some(Arc::new(crate::visual_scene::Scene::parse(json!({"api":1,"root":{"type":"toggle","id":"0","label":"Synthetic","value":false}})).unwrap())),state:Some("[]".into()),version:7,live:true,error:None,..Default::default()}
    }
    fn slider_snapshot(version: u64, value: f64) -> Snapshot {
        let mut s = snapshot(reference(1));
        s.version = version;
        s.scene=Some(Arc::new(crate::visual_scene::Scene::parse(json!({"api":1,"root":{"type":"slider","id":"0","label":"Load","min":0,"max":100,"step":1,"value":value}})).unwrap()));
        s
    }
    fn two_slider_snapshot(version: u64, values: [f64; 2]) -> Snapshot {
        let mut s = slider_snapshot(version, 0.);
        let children:Vec<_>=values.into_iter().enumerate().map(|(i,value)|json!({"type":"slider","id":format!("0.{i}"),"label":format!("Load {i}"),"min":0,"max":100,"step":1,"value":value})).collect();
        s.scene = Some(Arc::new(
            crate::visual_scene::Scene::parse(
                json!({"api":1,"root":{"type":"column","children":children}}),
            )
            .unwrap(),
        ));
        s
    }
    #[gpui_kit::test]
    fn continuous_fast_acks_cross_sliders_keep_one_deadline_and_no_burst(cx: &mut TestAppContext) {
        cx.update(|cx| {
            gpui_kit::init(cx);
            crate::init_appearance(cx);
        });
        let (worker, commands) = Worker::synthetic();
        let window = cx.add_window(|window, cx| {
            let mut p = ArtifactPane::new();
            p.reference = Some(reference(1));
            p.generation = 20;
            p.worker = Some(worker);
            p.snapshot = two_slider_snapshot(1, [0., 0.]);
            p.sync_sliders(window, cx);
            p
        });
        let pane = window.root(cx).unwrap();
        let mut values = [0., 0.];
        let mut times = Vec::new();
        let mut ids = Vec::new();
        for ms in 0..1000 {
            pane.update(cx, |p, cx| {
                let id = format!("0.{}", (ms / 11) % 2);
                let before = p
                    .slider_wake
                    .as_ref()
                    .map(|(due, _)| (*due, p.slider_wake_serial));
                p.slide(
                    SliderIntent {
                        generation: 20,
                        binding: p.sliders[&id].serial,
                        id,
                        value: f64::from(ms % 99 + 1),
                    },
                    cx,
                );
                if let (Some(before), Some((due, _))) = (before, &p.slider_wake) {
                    assert_eq!(
                        before,
                        (*due, p.slider_wake_serial),
                        "overwriting latest must reuse deadline/task"
                    );
                }
            });
            cx.run_until_parked();
            if let Ok(command) = commands.try_recv() {
                let Command::Event { version, id, value } = command else {
                    panic!("unexpected command")
                };
                times.push(cx.executor().now());
                ids.push(id.clone());
                assert!(commands.try_recv().is_err());
                values[usize::from(id == "0.1")] = value.as_f64().unwrap();
                pane.update(cx, |p, cx| {
                    p.accept(
                        20,
                        &reference(1),
                        two_slider_snapshot(version + 1, values),
                        cx,
                    )
                });
                assert!(
                    commands.try_recv().is_err(),
                    "even zero-latency acknowledgments cannot burst"
                );
            }
            cx.executor()
                .advance_clock(std::time::Duration::from_millis(1));
            cx.run_until_parked();
        }
        assert!(times.len() > 20 && times.len() <= 30);
        assert!(
            times
                .windows(2)
                .all(|t| t[1] - t[0] >= crate::visual_slider::DRAG_INTERVAL)
        );
        assert!(ids.iter().any(|id| id == "0.0") && ids.iter().any(|id| id == "0.1"));
        pane.update(cx, |p, _| p.close());
        let _ = commands.try_recv();
        cx.executor()
            .advance_clock(crate::visual_slider::DRAG_INTERVAL);
        cx.run_until_parked();
        assert!(commands.try_recv().is_err());
    }

    #[gpui_kit::test]
    fn pending_slider_deadline_revalidates_removal_binding_and_canonical_state(
        cx: &mut TestAppContext,
    ) {
        cx.update(|cx| {
            gpui_kit::init(cx);
            crate::init_appearance(cx);
        });
        for mode in ["removed", "binding", "canonical", "stepper"] {
            let (worker, commands) = Worker::synthetic();
            let window = cx.add_window(|window, cx| {
                let mut p = ArtifactPane::new();
                p.reference = Some(reference(1));
                p.generation = 20;
                p.worker = Some(worker);
                p.snapshot = slider_snapshot(1, 0.);
                p.sync_sliders(window, cx);
                p
            });
            let pane = window.root(cx).unwrap();
            pane.update(cx,|p,cx|{
                let make=|value|SliderIntent {generation:20,binding:p.sliders["0"].serial,id:"0".into(),value};
                let first=make(1.);let queued=make(80.);
                p.slide(first,cx);let _=commands.try_recv();
                p.accept(20,&reference(1),slider_snapshot(2,1.),cx);p.slide(queued,cx);
                assert!(p.slider_wake.is_some());
                match mode {
                    "removed"=>{let mut next=slider_snapshot(3,1.);next.scene=Some(Arc::new(crate::visual_scene::Scene::parse(json!({"api":1,"root":{"type":"text","runs":[{"text":"removed"}]}})).unwrap()));p.accept(20,&reference(1),next,cx);},
                    "binding"=>{p.sliders.get_mut("0").unwrap().serial+=1;},
                    "canonical"=>p.accept(20,&reference(1),slider_snapshot(3,80.),cx),
                    "stepper"=>{p.event(20,2,"0".into(),json!(2.),cx);assert!(matches!(commands.try_recv(),Ok(Command::Event{version:2,value,..})if value==json!(2.)));},
                    _=>unreachable!(),
                }
                if mode!="binding" {assert!(p.slider_wake.is_none()&&p.slider_flow.queued.is_none());}
            });
            cx.run_until_parked();
            cx.executor()
                .advance_clock(crate::visual_slider::DRAG_INTERVAL);
            cx.run_until_parked();
            assert!(
                commands.try_recv().is_err(),
                "{mode} must not replay pending drag"
            );
            pane.update(cx, |p, _| {
                assert!(p.slider_wake.is_none() && p.slider_flow.queued.is_none());
                p.close();
            });
        }
    }
    #[gpui_kit::test]
    fn slider_queue_uses_new_ack_version_and_drops_fault_replacement_close(
        cx: &mut TestAppContext,
    ) {
        cx.update(|cx| {
            gpui_kit::init(cx);
            crate::init_appearance(cx);
        });
        let (worker, commands) = Worker::synthetic();
        let window = cx.add_window(|window, cx| {
            let mut p = ArtifactPane::new();
            p.reference = Some(reference(1));
            p.generation = 20;
            p.worker = Some(worker);
            p.snapshot = slider_snapshot(1, 0.);
            p.sync_sliders(window, cx);
            p
        });
        let pane = window.root(cx).unwrap();
        let slide = |p: &mut ArtifactPane, value, cx: &mut Context<ArtifactPane>| {
            p.slide(
                SliderIntent {
                    generation: p.generation,
                    binding: p.sliders["0"].serial,
                    id: "0".into(),
                    value,
                },
                cx,
            );
        };
        pane.update(cx, |p, cx| {
            slide(p,0.,cx); assert!(commands.try_recv().is_err());
            slide(p,1.,cx); for i in 2..=100 {slide(p,f64::from(i),cx);}
            assert!(matches!(commands.try_recv(),Ok(Command::Event{version:1,value,..})if value==json!(1.)));
            p.accept(20,&reference(1),slider_snapshot(1,0.),cx);
            assert!(p.busy&&commands.try_recv().is_err(),"same-version update is not an ack");
            p.accept(19,&reference(1),slider_snapshot(2,1.),cx); assert!(commands.try_recv().is_err());
            p.accept(20,&reference(1),slider_snapshot(2,1.),cx);
            assert!(!p.busy&&p.slider_wake.is_some()&&commands.try_recv().is_err(),"fast ack cannot bypass pacing");
            assert_eq!(p.slider_flow.latest("0",p.sliders["0"].serial),Some(100.));
        });
        cx.run_until_parked();
        cx.executor()
            .advance_clock(std::time::Duration::from_millis(33));
        cx.run_until_parked();
        assert!(commands.try_recv().is_err());
        cx.executor()
            .advance_clock(std::time::Duration::from_millis(1));
        cx.run_until_parked();
        assert!(
            matches!(commands.try_recv(),Ok(Command::Event{version:2,value,..})if value==json!(100.))
        );
        pane.update(cx, |p, cx| {
            p.accept(20, &reference(1), slider_snapshot(3, 100.), cx);
            slide(p, 90., cx);
            let cancelled = p.slider_wake_serial;
            slide(p, 100., cx);
            assert!(
                p.slider_wake.is_none() && p.slider_flow.queued.is_none(),
                "return to canonical cancels deadline"
            );
            slide(p, 80., cx);
            let current = p.slider_wake_serial;
            p.slider_due(20, cancelled, cx);
            assert_eq!(
                p.slider_wake_serial, current,
                "old wake cannot consume replacement"
            );
            assert!(p.slider_wake.is_some());
            let mut failed = slider_snapshot(3, 100.);
            failed.live = false;
            failed.error = Some(crate::visual_runtime::Fault {
                kind: "timeout",
                message: "synthetic failure".into(),
                line: None,
                limit: None,
            });
            p.accept(20, &reference(1), failed, cx);
            assert!(p.slider_wake.is_none() && p.slider_flow.queued.is_none());
            p.accept(20, &reference(1), slider_snapshot(4, 50.), cx);
            slide(p, 60., cx);
            let mut replaced = slider_snapshot(5, 60.);
            let mut root = (*replaced.scene.take().unwrap().root).clone();
            root["label"] = json!("Different control");
            replaced.scene = Some(Arc::new(
                crate::visual_scene::Scene::parse(json!({"api":1,"root":root})).unwrap(),
            ));
            p.accept(20, &reference(1), replaced, cx);
            assert!(p.slider_wake.is_none() && p.slider_flow.queued.is_none());
            p.accept(20, &reference(1), slider_snapshot(6, 20.), cx);
            slide(p, 40., cx);
            p.reader_ended(19, &reference(1), cx);
            assert!(p.slider_flow.queued.is_some());
            p.reader_ended(20, &reference(1), cx);
            assert!(
                !p.busy
                    && !p.snapshot.live
                    && p.snapshot.scene.is_some()
                    && p.snapshot.error.is_some()
            );
            assert!(
                p.slider_wake.is_none()
                    && p.slider_flow.flight.is_none()
                    && p.slider_flow.queued.is_none()
            );
            p.close();
            assert!(p.sliders.is_empty());
        });
        cx.executor()
            .advance_clock(crate::visual_slider::DRAG_INTERVAL);
        cx.run_until_parked();
        assert!(
            commands.try_recv().is_err(),
            "cancelled deadlines cannot dispatch after close"
        );
    }
    #[gpui_kit::test]
    fn generation_revision_and_typed_event_fences_and_bounded_state_cache(cx: &mut TestAppContext) {
        cx.update(|cx| {
            gpui_kit::init(cx);
            crate::init_appearance(cx);
        });
        let pane = cx.update(|cx| cx.new(|_| ArtifactPane::new()));
        let (worker, commands) = Worker::synthetic();
        pane.update(cx, |p, cx| {
            p.reference = Some(reference(1));
            p.generation = 10;
            p.worker = Some(worker);
            p.snapshot = snapshot(reference(1));
            p.event(9, 7, "0".into(), json!(true), cx);
            p.event(10, 6, "0".into(), json!(true), cx);
            p.event(10, 7, "0".into(), json!("wrong type"), cx);
            assert!(commands.try_recv().is_err());
            p.accept(9, &reference(1), snapshot(reference(1)), cx);
            assert!(p.states.is_empty());
            p.accept(10, &reference(1), snapshot(reference(2)), cx);
            assert!(p.states.is_empty());
            p.event(10, 7, "0".into(), json!(true), cx);
            assert!(matches!(
                commands.try_recv(),
                Ok(Command::Event {
                    value: Value::Bool(true),
                    ..
                })
            ));
            assert!(p.busy);
            p.event(10, 7, "0".into(), json!(true), cx);
            assert!(commands.try_recv().is_err());
            let mut old=snapshot(reference(1));old.version=6;p.accept(10,&reference(1),old,cx);assert_eq!(p.snapshot.version,7);
            p.busy=false;p.snapshot.scene=Some(Arc::new(crate::visual_scene::Scene::parse(json!({"api":1,"root":{"type":"canvas","id":"0","height":120,"animated":false}})).unwrap()));
            p.draw(9,7,"0".into(),320.,120.,cx);p.draw(10,6,"0".into(),320.,120.,cx);p.draw(10,7,"wrong".into(),320.,120.,cx);p.draw(10,7,"0".into(),320.,130.,cx);assert!(commands.try_recv().is_err());p.draw(10,7,"0".into(),320.,120.,cx);assert!(matches!(commands.try_recv(),Ok(Command::Draw{version:7,..})));assert!(p.busy);
            for revision in 1..=12 {
                let r = reference(revision);
                p.reference = Some(r.clone());
                p.accept(10, &r, snapshot(r.clone()), cx);
            }
            assert_eq!(p.states.len(), 8);
            assert_eq!(p.states.front().unwrap().0.revision, 5);
            p.close();
            assert!(p.reference.is_none() && p.worker.is_none());
        });
    }
}
