//! Conversation presentation of the existing exact-revision reader, not a second runtime.
use super::*;
use crate::artifact_model::RasterSize;

/// Height a pin of unknown kind reserves while it loads (it may be a legacy raster).
/// Loaded visuals take their natural height, like the rest of the conversation.
pub(crate) const HEIGHT: f32 = 440.;
/// Height a not-yet-loaded inline reader reserves: the revision's remembered
/// natural height, else 440pt for pins that may be legacy rasters. A visual of
/// unknown size reserves nothing and grows once, when it loads.
pub(crate) fn loading_reserve(kind: &str, remembered: Option<f32>) -> Option<f32> {
    remembered.or((kind != "visual").then_some(HEIGHT))
}
pub(crate) struct Expand(pub(crate) Reference);
impl gpui_kit::EventEmitter<Expand> for ArtifactPane {}
/// The inline reader's laid-out height changed, so its conversation row must remeasure.
pub(crate) struct Resized(pub(crate) f32);
impl gpui_kit::EventEmitter<Resized> for ArtifactPane {}

/// Title row shared by the pre-admission placeholder and the inline reader.
pub(crate) fn header(label: String, expand: Button) -> gpui_kit::Div {
    div()
        .h_flex()
        .gap_2()
        .items_start()
        .child(
            crate::ui::text(crate::ui::Text::Label, label)
                .flex_1()
                .min_w_0(),
        )
        .child(expand)
}
/// Raster body from one known size. The placeholder row, loading reader and decoded
/// pixels all use it, so the row keeps its geometry through read and decode.
pub(crate) fn raster_body<E: ParentElement + Styled>(
    view: E,
    size: RasterSize,
    fill: AnyElement,
    on_click: impl Fn(&gpui_kit::ClickEvent, &mut Window, &mut gpui_kit::App) + 'static,
    cx: &gpui_kit::App,
) -> E {
    let mut view = view.h_auto();
    if size.first_frame {
        view = view.child(
            crate::ui::text(crate::ui::Text::Caption, "First frame only")
                .id("inline-image-frame-note")
                .test_support()
                .text_color(cx.theme().muted_foreground),
        );
    }
    view.child(
        div()
            .id("inline-visual-content")
            .test_support()
            .w_full()
            .min_w_0()
            .child(crate::artifact_image_view::inline_frame(size.width, size.height).child(fill))
            .cursor_pointer()
            .on_click(on_click),
    )
}
pub(crate) fn raster_loading(cx: &gpui_kit::App) -> AnyElement {
    div()
        .absolute()
        .inset_0()
        .child(
            crate::ui::text(crate::ui::Text::Caption, "Loading image…")
                .id("inline-raster-loading")
                .test_support()
                .text_color(cx.theme().muted_foreground),
        )
        .into_any_element()
}

impl ArtifactPane {
    pub(crate) fn inline_raster_ready(&self) -> bool {
        self.snapshot.raster.is_some()
    }
    /// A native scene is shown, so the measured height is its natural height.
    pub(crate) fn inline_scene_ready(&self) -> bool {
        self.snapshot.scene.is_some()
    }
    pub(crate) fn inline_raster_size(&self) -> Option<RasterSize> {
        self.snapshot.raster.as_ref().map(|r| RasterSize {
            width: r.width,
            height: r.height,
            first_frame: r.first_frame,
        })
    }
    pub(crate) fn suspend_inline(&mut self, cx: &mut Context<Self>) {
        #[cfg(feature = "native-probes")]
        let _timing = crate::transcript_view::inline_visual::probe::scroll::work("suspend");
        self.close();
        if let Some(image) = self.retired_image.take() {
            cx.defer(move |cx| cx.drop_image(image, None));
        }
    }
    #[cfg(feature = "native-probes")]
    pub(crate) fn inline_probe_snapshot(&self) -> Snapshot {
        self.snapshot.clone()
    }
    #[cfg(feature = "native-probes")]
    pub(crate) fn inline_probe_idle(&self) -> bool {
        !self.busy
    }
    pub(crate) fn inline_drains(&self) -> Vec<async_channel::Receiver<()>> {
        let mut drains = self.reader_drains();
        if let Some(worker) = &self.worker {
            drains.push(worker.finished());
        }
        drains
    }
    pub(crate) fn inline_mode(&mut self, inline: bool, cx: &mut Context<Self>) {
        if self.inline != inline {
            self.inline = inline;
            self.cancel_slider_wake();
            self.slider_flow.clear();
            self.sliders.clear();
            self.slider_synced = None;
            cx.notify();
        }
    }
    pub(super) fn surface_event(
        &mut self,
        generation: u64,
        version: u64,
        id: String,
        value: Value,
        inline: bool,
        cx: &mut Context<Self>,
    ) {
        if self.inline == inline {
            self.event(generation, version, id, value, cx);
        }
    }
    pub(crate) fn focus_reader(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let focus = self.focus.get_or_insert_with(|| cx.focus_handle());
        window.focus(focus, cx);
    }
    pub(crate) fn inline_matches(&self, reference: &Reference) -> bool {
        self.reference
            .as_ref()
            .is_some_and(|r| r.same_revision(reference))
    }
    pub(crate) fn inline_admitting(&self) -> bool {
        // Unknown pins share the existing single raster-envelope admission.
        // Do not race two metadata reads or increase that permit's limit.
        self.reference.as_ref().is_some_and(|r| r.kind == "unknown")
            && self.snapshot.revision.is_none()
            && (self.worker.is_some() || self.busy)
    }
    pub(crate) fn open_inline(
        &mut self,
        reference: Reference,
        reserve: Option<RasterSize>,
        height: Option<f32>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.inline = true;
        if self.inline_matches(&reference) {
            return;
        }
        #[cfg(feature = "native-probes")]
        let _timing = crate::transcript_view::inline_visual::probe::scroll::work("open");
        // Inline hydration never focuses the reader or steals composition.
        self.close();
        self.flush_image(window, cx);
        self.reference = Some(reference);
        self.inline_reserve = reserve;
        self.inline_height = height;
        self.busy = true;
        self.begin_after_drain(window, cx);
        cx.notify();
    }
    pub(super) fn render_inline(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        #[cfg(feature = "native-probes")]
        let _timing = crate::transcript_view::inline_visual::probe::scroll::work("inline_render");
        self.sync_sliders(window, cx);
        let focus = self.focus.get_or_insert_with(|| cx.focus_handle()).clone();
        let generation = self.generation;
        let Some(reference) = self.reference.clone() else {
            return div()
                .h(px(self.inline_height.unwrap_or(HEIGHT)))
                .child("Preview paused")
                .into_any_element();
        };
        let kind = reference.kind.clone();
        let title = self
            .snapshot
            .revision
            .as_ref()
            .map_or(&reference.title, |r| &r.reference.title);
        let mut view = div()
            .id("inline-visual")
            .test_support()
            .track_focus(&focus)
            .relative()
            .v_flex()
            .w_full()
            .min_w_0()
            .gap_2()
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
            .child(header(
                format!("{} · r{}", title, reference.revision),
                Button::new("inline-expand")
                    .ghost()
                    .small()
                    .label("Expand")
                    .on_click(cx.listener(move |v, _, _, cx| {
                        if v.generation == generation {
                            cx.emit(Expand(reference.clone()));
                        }
                    })),
            ));
        if let Some(error) = &self.snapshot.error {
            view = view.child(
                crate::ui::text(crate::ui::Text::Caption, error.message.clone())
                    .text_color(cx.theme().danger),
            );
            view = view.child(
                Button::new("inline-retry")
                    .ghost()
                    .small()
                    .label("Reload preview")
                    .disabled(self.busy)
                    .on_click(cx.listener(move |v, _, window, cx| {
                        if v.generation == generation && !v.busy {
                            let reference = v.reference.clone().unwrap();
                            v.close();
                            v.open_inline(reference, v.inline_reserve, v.inline_height, window, cx);
                        }
                    })),
            );
        }
        // A still raster keeps its known geometry from placeholder to pixels.
        let raster = self
            .inline_raster_size()
            .or(self.inline_reserve.filter(|_| {
                self.snapshot.error.is_none()
                    && self
                        .snapshot
                        .revision
                        .as_ref()
                        .is_none_or(|r| r.reference.kind == "image")
            }));
        if let Some(size) = raster {
            let fill = match &self.snapshot.raster {
                Some(raster) => crate::artifact_image_view::preview(raster),
                None => raster_loading(cx),
            };
            let expand = cx.listener(move |v: &mut Self, _: &gpui_kit::ClickEvent, _, cx| {
                if v.generation == generation {
                    cx.emit(Expand(v.reference.clone().unwrap()));
                }
            });
            return raster_body(view, size, fill, expand, cx).into_any_element();
        }
        if self.busy && self.snapshot.revision.is_none() {
            view = view.child("Loading native preview…");
        }
        if self.busy
            && self.snapshot.scene.is_none()
            && self.snapshot.error.is_none()
            && let Some(reserve) = loading_reserve(&kind, self.inline_height)
        {
            view = view.min_h(px(reserve));
        }
        if let Some(revision) = self.snapshot.revision.clone() {
            // Natural height: the conversation scrolls, the visual does not.
            let mut content = div()
                .id("inline-visual-content")
                .test_support()
                .v_flex()
                .w_full()
                .min_w_0()
                .gap_3();
            if !revision.visual_supported {
                content = content.child(crate::ui::text(crate::ui::Text::Caption, "No native inline preview for this artifact. Source is retained; Expand opens its detail."));
            } else if let Some(scene) = self.snapshot.scene.clone() {
                content = content.child(self.node(&scene.root, "0", &mut 4096, cx));
            }
            view = view.child(content);
        }
        let measured = self.inline_measured.clone();
        let weak = cx.weak_entity();
        view.child(
            gpui_kit::canvas(
                move |bounds, window, cx| {
                    let height = f32::from(bounds.size.height);
                    if (height - measured.get()).abs() >= 0.5 {
                        measured.set(height);
                        window.defer(cx, move |_, cx| {
                            let _ = weak.update(cx, |_, cx| cx.emit(Resized(height)));
                        });
                    }
                },
                |_, _, _, _| {},
            )
            .absolute()
            .inset_0(),
        )
        .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui_kit::TestAppContext;
    #[test]
    fn only_unknown_or_raster_pins_reserve_a_guess_while_loading() {
        assert_eq!(loading_reserve("visual", None), None);
        assert_eq!(loading_reserve("visual", Some(581.)), Some(581.));
        assert_eq!(loading_reserve("unknown", None), Some(HEIGHT));
        assert_eq!(loading_reserve("image", Some(200.)), Some(200.));
    }
    fn reference(revision: u32) -> Reference {
        Reference {
            id: "study".into(),
            session: "owner".into(),
            revision,
            title: "Study".into(),
            kind: "visual".into(),
        }
    }
    fn snapshot(reference: Reference, version: u64) -> Snapshot {
        Snapshot {revision:Some(Arc::new(crate::artifact_model::Revision {reference,source:Arc::new("exact 🌍 source".into()),data:Value::Null,visual_supported:true,created_at:1.,updated_at:2.})),scene:Some(Arc::new(crate::visual_scene::Scene::parse(json!({"api":1,"root":{"type":"toggle","id":"0","label":"Forecast","value":false}})).unwrap())),live:true,version,state:Some("[]".into()),..Default::default()}
    }
    #[gpui_kit::test]
    fn unsupported_static_source_is_inert_not_a_failed_worker(cx: &mut TestAppContext) {
        let pane = cx.new(|_| ArtifactPane::new());
        pane.update(cx, |p, cx| {
            p.reference = Some(reference(1));
            let mut stored = snapshot(reference(1), 0);
            Arc::make_mut(stored.revision.as_mut().unwrap()).visual_supported = false;
            stored.scene = None;
            stored.live = false;
            p.accept(0, &reference(1), stored, cx);
            p.reader_ended(0, &reference(1), cx);
            assert!(p.snapshot.error.is_none() && p.snapshot.scene.is_none() && !p.snapshot.live);
            assert_eq!(
                p.snapshot.revision.as_ref().unwrap().source.as_str(),
                "exact 🌍 source"
            );
        });
    }
    #[gpui_kit::test]
    fn revision_generation_and_state_version_fence_late_inline_callbacks(cx: &mut TestAppContext) {
        let pane = cx.new(|_| ArtifactPane::new());
        pane.update(cx, |p, cx| {
            p.reference = Some(reference(1));
            p.accept(0, &reference(1), snapshot(reference(1), 1), cx);
            let (worker, commands) = Worker::synthetic();
            p.worker = Some(worker);
            p.event(0, 0, "0".into(), json!(true), cx);
            assert!(commands.is_empty());
            p.inline_mode(true, cx);
            p.surface_event(0, 1, "0".into(), json!(true), false, cx);
            assert!(
                commands.is_empty(),
                "retired pane callbacks cannot dispatch through the inline surface"
            );
            p.inline_mode(false, cx);
            p.surface_event(0, 1, "0".into(), json!(true), true, cx);
            assert!(
                commands.is_empty(),
                "retired inline callbacks cannot dispatch through the pane"
            );
            p.source = true;
            p.event(0, 1, "0".into(), json!(true), cx);
            assert!(
                commands.is_empty(),
                "source surface cannot dispatch a retired control"
            );
            p.source = false;
            p.event(0, 1, "0".into(), json!(true), cx);
            assert!(matches!(
                commands.try_recv(),
                Ok(Command::Event { version: 1, .. })
            ));
            p.close();
            p.reference = Some(reference(2));
            p.accept(0, &reference(1), snapshot(reference(1), 5), cx);
            assert!(p.snapshot.scene.is_none());
            p.accept(p.generation, &reference(2), snapshot(reference(1), 5), cx);
            assert!(p.snapshot.scene.is_none());
            p.accept(p.generation, &reference(2), snapshot(reference(2), 2), cx);
            p.accept(p.generation, &reference(2), snapshot(reference(2), 1), cx);
            assert_eq!(p.snapshot.version, 2);
            assert_eq!(p.snapshot.revision.as_ref().unwrap().reference.revision, 2);
        });
    }
    #[gpui_kit::test]
    fn changing_presentation_preserves_reader_and_exact_source(cx: &mut TestAppContext) {
        let pane = cx.new(|_| ArtifactPane::new());
        pane.update(cx, |p, cx| {
            p.reference = Some(reference(1));
            p.accept(0, &reference(1), snapshot(reference(1), 1), cx);
            let (worker, _) = Worker::synthetic();
            p.worker = Some(worker);
            p.inline_mode(true, cx);
            p.inline_mode(false, cx);
            assert!(p.worker.is_some());
            assert_eq!(p.generation, 0);
            assert_eq!(p.snapshot.version, 1);
            assert_eq!(
                p.snapshot.revision.as_ref().unwrap().source.as_str(),
                "exact 🌍 source"
            );
            p.close();
            assert!(p.worker.is_none() && p.snapshot.scene.is_none());
            assert_eq!(p.states.len(), 1);
        });
    }
}
