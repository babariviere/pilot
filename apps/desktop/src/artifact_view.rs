//! Native read-only artifact detail. User controls change isolated reader state only.
#[path = "artifact_canvas.rs"]
mod canvas;
#[cfg(feature = "native-probes")]
#[path = "artifact_chart_keyboard_probe.rs"]
pub(crate) mod chart_keyboard_probe;
#[path = "artifact_gallery_view.rs"]
pub(crate) mod gallery;
#[cfg(feature = "native-probes")]
#[path = "artifact_image_probe.rs"]
pub(crate) mod image_probe;
#[path = "inline_visual.rs"]
pub(crate) mod inline_visual;
#[cfg(feature = "native-probes")]
#[path = "native_mermaid_probe.rs"]
pub(crate) mod mermaid_probe;
#[cfg(feature = "native-probes")]
#[path = "artifact_slider_probe.rs"]
pub(crate) mod slider_probe;
#[cfg(test)]
#[path = "artifact_text_tests.rs"]
mod text_tests;
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
    ops::Range,
    rc::Rc,
    sync::Arc,
    time::Instant,
};
type Highlights = Vec<(Range<usize>, gpui_kit::HighlightStyle)>;
type Families = Vec<(Range<usize>, SharedString)>;
/// GPUI's default line height (phi), made explicit where text clamps to whole lines.
const LINE_HEIGHT: f32 = 1.618;
/// A visual text node's runs joined into one exact string, with each run's own
/// style as byte-range overrides of the node style (Swift VisualTextView). Every
/// run gets a range, even unstyled ones, so GPUI never merges a font-family
/// override's run with its neighbours (it applies only to whole runs).
fn text_runs(value: &Value, cx: &gpui_kit::App) -> (String, Highlights, Families) {
    let theme = cx.theme();
    let node_mono = value["mono"] == true;
    let (mut text, mut highlights, mut families) = (String::new(), Vec::new(), Vec::new());
    for run in value["runs"].as_array().into_iter().flatten() {
        let Some(piece) = run["text"].as_str() else {
            continue;
        };
        let range = text.len()..text.len() + piece.len();
        text.push_str(piece);
        if range.is_empty() {
            continue;
        }
        highlights.push((
            range.clone(),
            gpui_kit::HighlightStyle {
                color: run["color"]
                    .as_str()
                    .map(|c| crate::visual_chart_view::color(c, cx)),
                font_weight: run["weight"]
                    .as_f64()
                    .map(|w| gpui_kit::FontWeight(w as f32)),
                font_style: run["italic"].as_bool().map(|italic| {
                    if italic {
                        gpui_kit::FontStyle::Italic
                    } else {
                        gpui_kit::FontStyle::Normal
                    }
                }),
                strikethrough: (run["strike"] == true).then(|| gpui_kit::StrikethroughStyle {
                    thickness: px(1.),
                    color: None,
                }),
                ..Default::default()
            },
        ));
        if let Some(mono) = run["mono"].as_bool()
            && mono != node_mono
        {
            let family = if mono {
                &theme.mono_font_family
            } else {
                &theme.font_family
            };
            families.push((range, family.clone()));
        }
    }
    (text, highlights, families)
}
/// Swift's table default: end when every non-empty cell of a column is a number.
fn column_aligns(columns: &[Value], rows: &[Value]) -> Vec<&'static str> {
    (0..columns.len())
        .map(|j| match columns[j]["align"].as_str() {
            Some("center") => "center",
            Some("end") => "end",
            Some(_) => "start",
            None => {
                let mut cells = rows
                    .iter()
                    .filter_map(|row| row.get(j))
                    .filter(|cell| !cell.is_null())
                    .peekable();
                if cells.peek().is_some() && cells.all(Value::is_number) {
                    "end"
                } else {
                    "start"
                }
            }
        })
        .collect()
}
pub(crate) struct ArtifactPane {
    inline: bool,
    /// Raster geometry an inline preview reserves while its revision loads.
    inline_reserve: Option<crate::artifact_model::RasterSize>,
    /// Natural height an inline visual reserves while its revision loads, if known.
    inline_height: Option<f32>,
    /// Last laid-out inline height, so the conversation row remeasures on change.
    inline_measured: Rc<std::cell::Cell<f32>>,
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
    /// The in-flight command is a canvas draw, not a control event. Controls
    /// stay enabled; a control event waits in `queued_event` until it finishes.
    drawing: bool,
    /// Latest control event made during a draw: generation, version, id, value.
    queued_event: Option<(u64, u64, String, Value)>,
    source: bool,
    zoom: crate::reader_zoom::Zoom,
    retired_image: Option<Arc<gpui_kit::RenderImage>>,
    source_copy: Option<Task<()>>,
    states: VecDeque<(Reference, String)>,
    sliders: BTreeMap<String, SliderBinding>,
    slider_flow: SliderFlow,
    slider_serial: u64,
    slider_synced: Option<(u64, u64, bool)>,
    slider_wake: Option<(Instant, Task<()>)>,
    slider_wake_serial: u64,
    /// Chart under the pointer: generation, presentation, node path and x entry.
    /// Local presentation only; it never reaches the visual's state.
    chart_hover: Option<(u64, bool, String, usize)>,
    canvases: BTreeMap<String, canvas::Mounted>,
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
    fn reader_scale(&self) -> f32 {
        if self.inline {
            return 1.;
        }
        self.zoom.scale.unwrap_or_else(|| {
            let width = self.zoom.viewport.get()[0].max(240.);
            let natural = self.snapshot.scene.as_ref().map_or(width, |s| {
                s.mermaids
                    .values()
                    .filter_map(|m| m.diagram.as_ref().ok())
                    .map(|d| d.width)
                    .fold(width, f32::max)
            });
            (width / natural).clamp(0.1, 1.)
        })
    }
    pub(crate) fn new() -> Self {
        Self {
            inline: false,
            inline_reserve: None,
            inline_height: None,
            inline_measured: Rc::new(std::cell::Cell::new(-1.)),
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
            drawing: false,
            queued_event: None,
            source: false,
            zoom: Default::default(),
            retired_image: None,
            source_copy: None,
            states: VecDeque::new(),
            sliders: BTreeMap::new(),
            slider_flow: SliderFlow::default(),
            slider_serial: 0,
            slider_synced: None,
            slider_wake: None,
            slider_wake_serial: 0,
            chart_hover: None,
            canvases: BTreeMap::new(),
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
                t: 0.,
                pointer: None,
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
        self.drawing = false;
        self.queued_event = None;
        self.canvases.clear();
        self.source = false;
        self.zoom = Default::default();
        self.inline_measured.set(-1.);
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
        self.drawing = false;
        // A control used during a draw dispatches now, still fenced by its
        // generation, version and control type.
        if !self.busy
            && let Some((generation, version, id, value)) = self.queued_event.take()
        {
            self.event(generation, version, id, value, cx);
        }
        self.pump_slider(cx);
        self.pump_canvas(cx);
        cx.notify();
    }
    fn valid_slider(&self, intent: &SliderIntent) -> bool {
        !self.source
            && intent.generation == self.generation
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
        self.drawing = false;
        self.queued_event = None;
        self.canvases.clear();
        self.slider_flow.clear();
        self.cancel_slider_wake();
        self.sliders.clear();
        self.slider_synced = None;
        self.snapshot.live = false;
        if self.snapshot.error.is_none()
            && !self.snapshot.complete
            && self
                .snapshot
                .revision
                .as_ref()
                .is_none_or(|r| r.visual_supported || r.reference.kind == "image")
        {
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
            // A draw in flight queues the intent; pump_slider sends it after.
            self.busy && !self.drawing,
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
    #[cfg(test)]
    fn draw(
        &mut self,
        generation: u64,
        version: u64,
        id: String,
        width: f64,
        height: f64,
        cx: &mut Context<Self>,
    ) {
        self.draw_pointer(generation, version, id, width, height, 0., None, cx);
    }
    #[allow(clippy::too_many_arguments)]
    fn draw_pointer(
        &mut self,
        generation: u64,
        version: u64,
        id: String,
        width: f64,
        height: f64,
        t: f64,
        pointer: Option<[f64; 2]>,
        cx: &mut Context<Self>,
    ) {
        if generation != self.generation
            || self.source
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
            f.version == version
                && f.pointer == pointer
                && f.t == t
                && (f.width - width).abs() < 0.5
                && (f.height - height).abs() < 0.5
        }) {
            return;
        }
        // A clock-only draw keeps the same visible plan and control state.
        // Its reply will invalidate the pane when there is something to paint.
        let clock_only = self.snapshot.drawings.get(&id).is_some_and(|f| {
            f.version == version
                && f.pointer == pointer
                && f.t != t
                && (f.width - width).abs() < 0.5
                && (f.height - height).abs() < 0.5
        });
        if self.worker.as_ref().is_some_and(|w| {
            w.command(Command::Draw {
                version,
                id,
                width,
                height,
                t,
                pointer,
            })
        }) {
            self.busy = true;
            self.drawing = true;
            if !clock_only {
                cx.notify();
            }
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
        if self.drawing && generation == self.generation && version == self.snapshot.version {
            self.queued_event = Some((generation, version, id, value));
            return;
        }
        if generation != self.generation
            || self.source
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
    fn hover_chart(
        &mut self,
        generation: u64,
        inline: bool,
        path: String,
        index: Option<usize>,
        cx: &mut Context<Self>,
    ) {
        if generation != self.generation || inline != self.inline {
            return;
        }
        // Leaving one chart never clears another chart's readout.
        if index.is_none() && self.chart_hover.as_ref().is_none_or(|h| h.2 != path) {
            return;
        }
        let next = index.map(|i| (generation, inline, path, i));
        if self.chart_hover != next {
            self.chart_hover = next;
            cx.notify();
        }
    }
    /// The hovered x entry of the chart at `path` in this presentation, if current.
    fn chart_hovered(&self, path: &str) -> Option<usize> {
        self.chart_hover
            .as_ref()
            .filter(|(generation, inline, hovered, _)| {
                *generation == self.generation && *inline == self.inline && hovered == path
            })
            .map(|h| h.3)
    }
    #[cfg(feature = "native-probes")]
    pub(crate) fn probe_chart_readout(&self) -> Option<(String, crate::visual_chart::Readout)> {
        let (_, _, path, _) = self.chart_hover.as_ref()?;
        let index = self.chart_hovered(path)?;
        let chart = self
            .snapshot
            .scene
            .as_ref()?
            .charts
            .get(path)?
            .as_ref()
            .ok()?;
        Some((path.clone(), chart.readout(index)?))
    }
    fn text(&self, id: String, text: String) -> AnyElement {
        self.styled_text(id, text, "start", Vec::new(), Vec::new())
    }
    /// Exact selectable text. Center and end hug the text and move its box, never
    /// the glyphs within it, so selection geometry stays exact.
    fn styled_text(
        &self,
        id: String,
        text: String,
        align: &str,
        highlights: Highlights,
        families: Families,
    ) -> AnyElement {
        let focus = self.focus.clone();
        let mut hash = DefaultHasher::new();
        text.hash(&mut hash);
        let mut selectable = SelectableText::new(
            SharedString::from(format!("{id}-{}", hash.finish())),
            SharedString::from(text),
        );
        if !highlights.is_empty() || !families.is_empty() {
            selectable = selectable.styled_ranges(highlights, families);
        }
        let hug = matches!(align, "center" | "end");
        let selectable = if hug {
            div()
                .id(SharedString::from(format!("{id}-text")))
                .test_support()
                .max_w_full()
                .child(selectable)
                .into_any_element()
        } else {
            selectable.into_any_element()
        };
        div()
            .id(SharedString::from(id.clone()))
            .test_support()
            .min_w_0()
            .w_full()
            .when(hug, |d| d.v_flex())
            .when(align == "center", |d| d.items_center())
            .when(align == "end", |d| d.items_end())
            .on_mouse_down(gpui_kit::MouseButton::Left, move |_, window, cx| {
                if let Some(focus) = &focus {
                    focus.focus(window, cx);
                }
            })
            .child(selectable)
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
        let scale = self.reader_scale();
        let bytes: usize = match kind {
            "text" => value["runs"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|r| r["text"].as_str())
                .map(str::len)
                .sum(),
            "stat" => ["label", "value", "unit", "delta", "caption"]
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
        let inline = self.inline;
        // Controls stay usable while a canvas redraws; their events queue.
        let enabled = self.snapshot.live && (!self.busy || self.drawing);
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
                let (text, highlights, families) = text_runs(value, cx);
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
                let line = (size * LINE_HEIGHT).round();
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
                    .when(value["italic"] == true, |d| d.italic())
                    // Clip to whole lines rather than truncating, so the laid-out text
                    // stays the exact source and remains selectable.
                    .when_some(value["lines"].as_u64(), |d, lines| {
                        d.line_height(px(line))
                            .max_h(px(line * lines as f32))
                            .overflow_hidden()
                    })
                    .child(self.styled_text(
                        path.into(),
                        text,
                        value["align"].as_str().unwrap_or("start"),
                        highlights,
                        families,
                    ))
                    .into_any_element()
            }
            "stat" => {
                // Swift VisualStatView: muted label, baseline value/unit, then delta/caption.
                let tone = match value["tone"].as_str() {
                    Some("success") => crate::ui::Tone::Success,
                    Some("warning") => crate::ui::Tone::Warning,
                    Some("danger") => crate::ui::Tone::Error,
                    _ => crate::ui::Tone::Quiet,
                };
                let figures = gpui_kit::FontFeatures(Arc::new(vec![("tnum".into(), 1)]));
                div()
                    .v_flex()
                    .min_w_0()
                    .gap_0p5()
                    .child(
                        div()
                            .text_xs()
                            .text_color(cx.theme().muted_foreground)
                            .child(self.text(format!("{path}-label"), value["label"].as_str().unwrap_or("").into())),
                    )
                    .child(
                        div()
                            .h_flex()
                            .items_baseline()
                            .gap_1()
                            .child(div().min_w_0().text_2xl().font_semibold()
                                .font_features(figures.clone())
                                .text_color(cx.theme().foreground)
                                .child(self.text(path.into(), value["value"].as_str().unwrap_or("").into())))
                            .children(value["unit"].as_str().map(|unit| {
                                div().min_w_0().text_sm().text_color(cx.theme().muted_foreground)
                                    .child(self.text(format!("{path}-unit"), unit.into()))
                            })),
                    )
                    .when(value["delta"].is_string() || value["caption"].is_string(), |d| {
                        d.child(div().h_flex().items_baseline().flex_wrap().gap_1p5().text_xs()
                            .children(value["delta"].as_str().map(|delta| {
                                div().min_w_0().font_features(figures).text_color(tone.color(cx))
                                    .child(self.text(format!("{path}-delta"), delta.into()))
                            }))
                            .children(value["caption"].as_str().map(|caption| {
                                div().min_w_0().text_color(cx.theme().muted_foreground)
                                    .child(self.text(format!("{path}-caption"), caption.into()))
                            })))
                    })
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
                    view.surface_event(generation, version, id.clone(), Value::Null, inline, cx)
                }))
                .into_any_element(),
            "toggle" => Checkbox::new(SharedString::from(path.to_owned()))
                .label(SharedString::from(
                    value["label"].as_str().unwrap_or("").to_owned(),
                ))
                .checked(value["value"] == true)
                .disabled(!enabled)
                .on_change(cx.listener(move |view, v, _, cx| {
                    view.surface_event(generation, version, id.clone(), json!(*v), inline, cx)
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
                                view.surface_event(
                                    generation,
                                    version,
                                    id.clone(),
                                    val.clone(),
                                    inline,
                                    cx,
                                )
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
                let label = value["label"].as_str().unwrap_or("");
                // Exact steppers stay visible when the range cannot be dragged.
                // Beside a draggable slider they appear on hover or keyboard focus.
                let group = SharedString::from(format!("{path}-arm"));
                let quiet = binding.is_some();
                let stepper = |key: &str, glyph: &'static str, name: String, target: f64, off| {
                    let (id, key) = (id.clone(), format!("{path}-{key}"));
                    crate::ui::action(SharedString::from(key), glyph, crate::ui::Action::Quiet)
                        .accessibility_label(name)
                        .disabled(off)
                        .when(quiet, |b| {
                            b.opacity(0.)
                                .group_hover(group.clone(), |s| s.opacity(1.))
                                .focus_visible(|s| s.opacity(1.))
                        })
                        .on_click(cx.listener(move |v, _, _, cx| {
                            let value = json!(target);
                            v.surface_event(generation, version, id.clone(), value, inline, cx)
                        }))
                };
                let mut row = div().group(group.clone()).v_flex().gap_1().child(
                    div()
                        .h_flex()
                        .items_center()
                        .gap_2()
                        .child(div().flex_1().min_w_0().child(SharedString::from(format!(
                            "{label}: {} {}",
                            crate::visual_chart_view::number(n),
                            value["unit"].as_str().unwrap_or("")
                        ))))
                        .child(
                            div()
                                .flex_none()
                                .h_flex()
                                .gap_1()
                                .child(stepper(
                                    "minus",
                                    "−",
                                    format!("Decrease {label}"),
                                    (n - step).clamp(min, max),
                                    !enabled || n <= min,
                                ))
                                .child(stepper(
                                    "plus",
                                    "+",
                                    format!("Increase {label}"),
                                    (n + step).clamp(min, max),
                                    !enabled || n >= max,
                                )),
                        ),
                );
                if let Some(binding) = binding {
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
                                    .disabled(
                                        !self.snapshot.live
                                            || (self.busy && !own_flight && !self.drawing),
                                    )
                                    .w_full(),
                            ),
                    );
                }
                row.into_any_element()
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
                let aligns = column_aligns(columns, rows);
                let figures = gpui_kit::FontFeatures(Arc::new(vec![("tnum".into(), 1)]));
                let mut table = div()
                    .v_flex()
                    .w_full()
                    .flex_shrink_0()
                    .min_w_0()
                    .gap_1()
                    .p_2()
                    .border_1()
                    .border_color(cx.theme().border);
                let mut header = div().h_flex().gap_2().font_semibold();
                for (c, align) in columns.iter().zip(&aligns) {
                    header = header.child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .when(*align == "center", |d| d.text_center())
                            .when(*align == "end", |d| d.text_right())
                            .child(SharedString::from(
                                c["label"].as_str().unwrap_or("").to_owned(),
                            )),
                    );
                }
                table = table.child(header);
                for (i, row) in rows.iter().enumerate() {
                    let mut cells = div()
                        .h_flex()
                        .gap_2()
                        .border_t_1()
                        .border_color(cx.theme().border);
                    for (j, cell) in row.as_array().unwrap().iter().enumerate() {
                        cells = cells.child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .when(cell.is_number(), |d| d.font_features(figures.clone()))
                                .child(self.styled_text(
                                    format!("{path}-{i}-{j}"),
                                    if cell.is_null() {
                                        "—".into()
                                    } else if let Some(s) = cell.as_str() {
                                        s.into()
                                    } else {
                                        crate::visual_chart_view::number(
                                            cell.as_f64().unwrap_or(0.),
                                        )
                                    },
                                    aligns[j],
                                    Vec::new(),
                                    Vec::new(),
                                )),
                        );
                    }
                    table = table.child(cells);
                }
                table.into_any_element()
            }
            "shader" => Self::note(
                "Shader rendering is deferred. Stored shader source/translation remains intact; other nodes remain usable.",
            ),
            "mermaid" => self.snapshot.scene.as_ref().and_then(|scene| scene.mermaids.get(path)).map(|prepared| {
                let cost = prepared.diagram.as_ref().map_or(128, |p| p.nodes.len()*8+p.routes.iter().map(|r|r.points.len()*2).sum::<usize>());
                if cost > *budget { return Self::note("Diagram exceeds aggregate native display budget. Exact source is retained."); }
                *budget -= cost;
                crate::native_mermaid_view::Element::new(format!("mermaid-{}-{path}", cx.entity_id()), prepared.clone()).scope(self.generation).scale(scale).into_any_element()
            }).unwrap_or_else(|| Self::note("Native diagram display limit reached (8). Exact source remains in the artifact source; no browser fallback.")),
            "canvas" => {
                let frame = self
                    .snapshot
                    .drawings
                    .get(&id)
                    .filter(|f| f.version == version)
                    .cloned();
                let plan = frame.as_ref().and_then(|f| f.plan.as_ref().ok()).cloned();
                let error = frame.as_ref().and_then(|f| f.plan.as_ref().err()).copied();
                let height = value["height"].as_f64().unwrap_or(160.);
                let live = self.snapshot.live;
                let animated = value["animated"] == true;
                let canvas = self.canvas_element(id.clone(), height, scale, animated, plan, cx);
                div()
                    .id(SharedString::from(path.to_owned()))
                    .test_support()
                    .relative()
                    .w_full()
                    .max_w(px(2000. * scale))
                    .h(px(height as f32 * scale))
                    .min_h(px(height as f32 * scale))
                    .max_h(px(height as f32 * scale))
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
                        let weak = cx.weak_entity();
                        let key = path.to_owned();
                        crate::visual_chart_view::render_scaled(
                            chart.clone(),
                            path,
                            generation,
                            scale,
                            self.chart_hovered(path),
                            Rc::new(move |index, _, cx| {
                                let _ = weak.update(cx, |view, cx| {
                                    view.hover_chart(generation, inline, key.clone(), index, cx)
                                });
                            }),
                        )
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
        self.prepare_canvases();
        if self.inline {
            return self.render_inline(window, cx);
        }
        self.sync_sliders(window, cx);
        let focus = self.focus.get_or_insert_with(|| cx.focus_handle()).clone();
        let mut view = div()
            .id("artifact-detail")
            .test_support()
            .track_focus(&focus)
            .on_key_down(cx.listener(|v, event, window, cx| {
                if !v.inline
                    && !v.source
                    && let Some(command) = crate::reader_zoom::Zoom::key(event)
                {
                    let fit = v.snapshot.raster.as_ref().map_or(v.reader_scale(), |r| {
                        v.zoom.image_fit(
                            r.width as f32 / window.scale_factor(),
                            r.height as f32 / window.scale_factor(),
                        )
                    });
                    v.zoom.apply(command, fit);
                    cx.stop_propagation();
                    cx.notify();
                } else if !v.source && v.zoom.pan_key(event) {
                    cx.stop_propagation();
                    cx.notify();
                }
            }))
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
            return view
                .p_0()
                .gap_0()
                .child(self.render_gallery(window, cx))
                .into_any_element();
        };
        let scope = format!(
            "{}:{}:{}",
            reference.session, reference.id, reference.revision
        );
        let revision = self.snapshot.revision.clone();
        let scene = self.snapshot.scene.clone();
        let generation = self.generation;
        // Only images and native visuals preview; other stored kinds stay inert source.
        let unsupported = revision
            .as_ref()
            .is_some_and(|r| !r.visual_supported && r.reference.kind != "image");
        // One toolbar: back · title · revision, then source, copy and zoom actions.
        let provenance: SharedString = if revision
            .as_ref()
            .is_some_and(|r| r.reference.kind == "image")
            || reference.kind == "image"
        {
            "Local · stored raster · static preview only".into()
        } else if unsupported {
            "Local · current chat · stored source only".into()
        } else {
            "Local · current chat · visual controls have no file/network/tool bridge".into()
        };
        let mut header = div()
            .id("artifact-toolbar")
            .test_support()
            .h_flex()
            .items_center()
            .gap_1()
            .min_w_0()
            .child(
                Button::new("artifact-back")
                    .ghost()
                    .small()
                    .icon(AppIcon::Back.asset())
                    .accessibility_label("All artifacts")
                    .tooltip("All artifacts")
                    .on_click(cx.listener(move |v, _, window, cx| {
                        if v.generation != generation {
                            return;
                        }
                        v.show_gallery(window, cx);
                    })),
            )
            .child(
                div()
                    .id("artifact-title")
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .text_sm()
                    .font_semibold()
                    .tooltip(move |w, cx| {
                        gpui_kit::component::tooltip::Tooltip::new(provenance.clone()).build(w, cx)
                    })
                    .child(SharedString::from(format!(
                        "{} · r{}",
                        revision
                            .as_ref()
                            .map_or(reference.title.as_str(), |r| r.reference.title.as_str()),
                        reference.revision
                    ))),
            );
        if let Some(revision) = &revision {
            let source = revision.source.clone();
            let previous = reference.clone();
            header = header
                // Only offered when an earlier revision exists.
                .when(reference.revision > 1, |h| {
                    h.child(
                        Button::new("artifact-previous")
                            .ghost()
                            .small()
                            .label(format!("r{}", reference.revision.saturating_sub(1)))
                            .icon(AppIcon::Back.asset())
                            .accessibility_label("Previous revision")
                            .tooltip("Previous revision")
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
                })
                .child(
                    Button::new("artifact-source")
                        .ghost()
                        .small()
                        .icon(AppIcon::Source.asset())
                        .when(self.source, |b| {
                            gpui_kit::component::Selectable::selected(b, true)
                        })
                        .accessibility_label(if self.source { "Hide source" } else { "Source" })
                        .tooltip(if self.source { "Hide source" } else { "Source" })
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
                        .disabled(self.source_copy.is_some())
                        .icon(AppIcon::Copy.asset())
                        .accessibility_label(if self.source_copy.is_some() {
                            "Copying source…"
                        } else {
                            "Copy source"
                        })
                        .tooltip("Copy source")
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
                );
        }
        if !self.source && (self.snapshot.raster.is_some() || scene.is_some()) {
            let fit = self.snapshot.raster.as_ref().map_or(1., |r| {
                self.zoom.image_fit(
                    r.width as f32 / window.scale_factor(),
                    r.height as f32 / window.scale_factor(),
                )
            });
            header = header.child(self.zoom.toolbar(cx, move |v, command, cx| {
                if v.generation == generation && !v.source {
                    v.zoom.apply(command, fit);
                    cx.notify();
                }
            }));
        }
        view = view.child(header);
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
            if let Some(raster) = &self.snapshot.raster {
                view = view.child(
                    div().h_flex().flex_wrap().gap_2().child(
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
                    ),
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
                            "{} · stored timestamps {} / {} ms Unix · {} native nodes",
                            revision.reference.kind,
                            revision.created_at,
                            revision.updated_at,
                            self.snapshot.scene.as_ref().map_or(0, |s| s.nodes)
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
                content =
                    content
                        .relative()
                        .overflow_hidden()
                        .child(crate::artifact_image_view::zoomed(
                            raster, &self.zoom, window, cx,
                        ));
            } else if let Some(scene) = scene {
                let width = self.zoom.viewport.get()[0].max(240.);
                let natural = scene
                    .mermaids
                    .values()
                    .filter_map(|m| m.diagram.as_ref().ok())
                    .map(|d| d.width)
                    .fold(width, f32::max);
                let native = div()
                    .flex_shrink_0()
                    .w(px(natural * self.reader_scale()))
                    .child(self.node(&scene.root, "0", &mut 4096, cx))
                    .into_any_element();
                content = content.child(self.zoom.surface(native, cx));
            } else if unsupported {
                content = content.items_center().justify_center().child(
                    div()
                        .id("artifact-unsupported")
                        .test_support()
                        .v_flex()
                        .items_start()
                        .gap(px(crate::ui::Space::SIDEBAR))
                        .max_w(gpui_kit::rems(28.))
                        .child(
                            crate::ui::Notice::new(crate::artifact_model::unsupported_title(
                                &revision.reference.kind,
                            ))
                            .detail(crate::artifact_model::UNSUPPORTED_DETAIL),
                        )
                        .child(
                            crate::ui::action(
                                "artifact-view-source",
                                "View source",
                                crate::ui::Action::Secondary,
                            )
                            .icon(AppIcon::Source.asset())
                            .on_click(cx.listener(
                                move |v, _, _, cx| {
                                    if v.generation == generation {
                                        v.source = true;
                                        cx.notify();
                                    }
                                },
                            )),
                        ),
                );
            }
            view = view.child(content);
        }
        view.into_any_element()
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
    #[gpui_kit::test]
    fn controls_used_during_a_canvas_draw_queue_until_it_finishes(cx: &mut TestAppContext) {
        cx.update(|cx| {
            gpui_kit::init(cx);
            crate::init_appearance(cx);
        });
        let pane = cx.update(|cx| cx.new(|_| ArtifactPane::new()));
        let (worker, commands) = Worker::synthetic();
        pane.update(cx, |p, cx| {
            p.reference = Some(reference(1));
            p.generation = 3;
            p.worker = Some(worker);
            let mut s = snapshot(reference(1));
            s.scene = Some(Arc::new(crate::visual_scene::Scene::parse(json!({"api":1,"root":{"type":"column","children":[{"type":"toggle","id":"0.0","label":"Forecast","value":false},{"type":"canvas","id":"0.1","height":120,"animated":false}]}})).unwrap()));
            p.snapshot = s.clone();
            p.draw(3, 7, "0.1".into(), 320., 120., cx);
            assert!(matches!(commands.try_recv(), Ok(Command::Draw { version: 7, .. })));
            assert!(p.busy && p.drawing);
            // Stale or retired callbacks are never queued.
            p.event(2, 7, "0.0".into(), json!(true), cx);
            p.event(3, 6, "0.0".into(), json!(true), cx);
            assert!(p.queued_event.is_none());
            p.event(3, 7, "0.0".into(), json!(false), cx);
            p.event(3, 7, "0.0".into(), json!(true), cx);
            assert!(commands.try_recv().is_err(), "nothing races the draw");
            // The draw's reply dispatches the latest control use.
            p.accept(3, &reference(1), s.clone(), cx);
            assert!(matches!(
                commands.try_recv(),
                Ok(Command::Event { version: 7, value: Value::Bool(true), .. })
            ));
            assert!(p.busy && !p.drawing && p.queued_event.is_none());
            // An event in flight still blocks further control events.
            p.event(3, 7, "0.0".into(), json!(false), cx);
            assert!(commands.try_recv().is_err() && p.queued_event.is_none());
            // A queued event whose type no longer matches fails closed.
            p.busy = false;
            p.draw(3, 7, "0.1".into(), 320., 120., cx);
            let _ = commands.try_recv();
            p.event(3, 7, "0.0".into(), json!("wrong"), cx);
            p.accept(3, &reference(1), s, cx);
            assert!(commands.try_recv().is_err() && !p.busy);
        });
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
