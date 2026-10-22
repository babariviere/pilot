//! Native read-only artifact detail. User controls change isolated reader state only.
use crate::{
    LocalOptions,
    artifact_model::Reference,
    artifact_worker::{Command, Snapshot, Worker},
};
use gpui_kit::base::SelectableText;
use gpui_kit::{
    AnyElement, ClipboardItem, Context, InteractiveElement, IntoElement, ParentElement, Render,
    SharedString, StatefulInteractiveElement, Styled, Task, TestSupportExt, Window,
    component::{
        ActiveTheme, Disableable, Sizable, StyledExt,
        button::{Button, ButtonVariants},
        checkbox::Checkbox,
    },
    div,
    prelude::FluentBuilder,
    px,
};
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    hash::{DefaultHasher, Hash, Hasher},
    sync::Arc,
};
pub(crate) struct ArtifactPane {
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
    states: VecDeque<(Reference, String)>,
}
impl ArtifactPane {
    pub(crate) fn new() -> Self {
        Self {
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
            states: VecDeque::new(),
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
            self.owner = owner;
            cx.notify();
        }
        if !Arc::ptr_eq(&items, &self.items) {
            self.items = items;
            cx.notify();
        }
    }
    pub(crate) fn close(&mut self) {
        self.worker = None;
        self.updates = None;
        self.reference = None;
        self.snapshot = Snapshot::default();
        self.generation += 1;
        self.busy = false;
        self.source = false;
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
        self.reference = Some(reference.clone());
        self.busy = true;
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
        self.snapshot = snapshot;
        self.busy = false;
        cx.notify();
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
                let n = value["value"].as_f64().unwrap_or(0.);
                let min = value["min"].as_f64().unwrap_or(0.);
                let max = value["max"].as_f64().unwrap_or(1.);
                let step = value["step"].as_f64().unwrap_or(1.);
                let minus = id.clone();
                div()
                    .v_flex()
                    .gap_1()
                    .child(SharedString::from(format!(
                        "{}: {}",
                        value["label"].as_str().unwrap_or(""),
                        crate::visual_chart_view::number(n)
                    )))
                    .child(
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
                        crate::visual_chart_view::render(chart.clone(), cx)
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
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let focus = self.focus.get_or_insert_with(|| cx.focus_handle()).clone();
        let generation = self.generation;
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
            return view
                .overflow_y_scroll()
                .child(
                    div()
                        .text_sm()
                        .child("Artifacts · Local current chat · first64 only"),
                )
                .children(self.items.iter().enumerate().map(|(i, r)| {
                    let r = r.clone();
                    let label = format!("{} · {} · r{}", r.title, r.kind, r.revision);
                    Button::new(("artifact-card", i))
                        .ghost()
                        .label(SharedString::from(label))
                        .on_click(cx.listener(move |view, _, window, cx| {
                            if generation == view.generation && view.reference.is_none() {
                                view.open(r.clone(), window, cx);
                            }
                        }))
                }))
                .when(self.items.is_empty(), |d| {
                    d.child("No artifact metadata available for this chat.")
                });
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
                        .on_click(cx.listener(move |v, _, _, cx| {
                            if v.generation != generation {
                                return;
                            }
                            v.close();
                            cx.notify();
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
                .child("Local · current chat · visual controls have no file/network/tool bridge"),
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
                .is_some_and(|r| r.visual_supported)
            {
                view = view.child(
                    Button::new("artifact-retry")
                        .ghost()
                        .small()
                        .label("Retry in fresh worker")
                        .disabled(self.busy)
                        .on_click(cx.listener(move |v, _, _, cx| {
                            if generation == v.generation
                                && !v.busy
                                && v.snapshot.error.is_some()
                                && v.worker.as_ref().is_some_and(|w| w.command(Command::Retry))
                            {
                                v.busy = true;
                                cx.notify();
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
                            .label("Copy source")
                            .on_click(cx.listener(move |v, _, _, cx| {
                                if v.generation == generation {
                                    cx.write_to_clipboard(ClipboardItem::new_string(
                                        (*source).clone(),
                                    ));
                                }
                            })),
                    ),
            );
            if !revision.visual_supported {
                view=view.child(Self::note("Preview family/runtime is unsupported here. Source/provenance is retained; no HTML, React, shader or external execution."));
            }
            let mut content = div()
                .id(SharedString::from(scope))
                .test_support()
                .v_flex()
                .flex_1()
                .min_h_0()
                .overflow_y_scroll()
                .gap_3();
            if self.source {
                content=content.child(div().text_xs().child(SharedString::from(format!("{} · stored timestamps {} / {} ms Unix · source preview first8192 characters",revision.reference.kind,revision.created_at,revision.updated_at)))).child(self.text("artifact-source-text".into(),revision.source.chars().take(8192).collect()));
            } else if let Some(scene) = scene {
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
        Snapshot{drawings:Default::default(),revision:Some(Arc::new(crate::artifact_model::Revision{reference,source:Arc::new("synthetic source never evaluated".into()),data:Value::Null,visual_supported:true,created_at:1.,updated_at:2.})),scene:Some(Arc::new(crate::visual_scene::Scene::parse(json!({"api":1,"root":{"type":"toggle","id":"0","label":"Synthetic","value":false}})).unwrap())),state:Some("[]".into()),version:7,live:true,error:None}
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
