//! Conversation presentation of the existing exact-revision reader, not a second runtime.
use super::*;
use gpui_kit::component::scroll::ScrollableElement;

pub(crate) const HEIGHT: f32 = 440.;
pub(crate) struct Expand(pub(crate) Reference);
impl gpui_kit::EventEmitter<Expand> for ArtifactPane {}

impl ArtifactPane {
    pub(crate) fn suspend_inline(&mut self, cx: &mut Context<Self>) {
        self.close();
        if let Some(image) = self.retired_image.take() {
            cx.defer(move |cx| cx.drop_image(image, None));
        }
    }
    #[cfg(feature = "native-probes")]
    pub(crate) fn inline_probe_snapshot(&self) -> Snapshot {
        self.snapshot.clone()
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
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.inline = true;
        if self.inline_matches(&reference) {
            return;
        }
        // Inline hydration never focuses the reader or steals composition.
        self.close();
        self.flush_image(window, cx);
        self.reference = Some(reference);
        self.busy = true;
        self.begin_after_drain(window, cx);
        cx.notify();
    }
    pub(super) fn render_inline(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        self.sync_sliders(window, cx);
        let focus = self.focus.get_or_insert_with(|| cx.focus_handle()).clone();
        let generation = self.generation;
        let Some(reference) = self.reference.clone() else {
            return div()
                .h(px(HEIGHT))
                .child("Preview paused")
                .into_any_element();
        };
        let title = self
            .snapshot
            .revision
            .as_ref()
            .map_or(&reference.title, |r| &r.reference.title);
        let mut view = div()
            .id("inline-visual")
            .test_support()
            .track_focus(&focus)
            .v_flex()
            .w_full()
            .h(px(HEIGHT))
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
            .child(
                div()
                    .h_flex()
                    .gap_2()
                    .items_start()
                    .child(
                        crate::ui::text(
                            crate::ui::Text::Label,
                            format!("{} · r{}", title, reference.revision),
                        )
                        .flex_1()
                        .min_w_0(),
                    )
                    .child(
                        Button::new("inline-source")
                            .ghost()
                            .small()
                            .label(if self.source { "Preview" } else { "Source" })
                            .disabled(self.snapshot.revision.is_none())
                            .on_click(cx.listener(move |v, _, window, cx| {
                                if v.generation != generation {
                                    return;
                                }
                                window.focus(v.focus.as_ref().unwrap(), cx);
                                v.source = !v.source;
                                v.slider_flow.queued = None;
                                v.cancel_slider_wake();
                                cx.notify();
                            })),
                    )
                    .child(
                        Button::new("inline-expand")
                            .ghost()
                            .small()
                            .label("Expand")
                            .on_click(cx.listener(move |v, _, _, cx| {
                                if v.generation == generation {
                                    cx.emit(Expand(reference.clone()));
                                }
                            })),
                    ),
            );
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
                            v.open_inline(reference, window, cx);
                        }
                    })),
            );
        }
        if self.busy && self.snapshot.revision.is_none() {
            view = view.child("Loading native preview…");
        }
        if let Some(revision) = self.snapshot.revision.clone() {
            let mut content = div()
                .id("inline-visual-scroll-body")
                .v_flex()
                .size_full()
                .min_h_0()
                .min_w_0()
                .gap_3()
                .overflow_y_scroll();
            if self.source {
                let source = revision.source.clone();
                content = content.child(
                    Button::new("inline-copy-source")
                        .ghost()
                        .small()
                        .label("Copy exact source")
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
                if revision.source.chars().nth(8192).is_some() {
                    content = content.child(crate::ui::text(
                        crate::ui::Text::Caption,
                        "Showing first 8,192 characters. Copy retains the full source.",
                    ));
                }
                content = content.child(self.text(
                    "inline-source-text".into(),
                    revision.source.chars().take(8192).collect(),
                ));
            } else if let Some(raster) = &self.snapshot.raster {
                if raster.first_frame {
                    view = view.child(
                        crate::ui::text(crate::ui::Text::Caption, "First frame only")
                            .id("inline-image-frame-note")
                            .test_support()
                            .text_color(cx.theme().muted_foreground),
                    );
                }

                content = content
                    .relative()
                    .overflow_hidden()
                    .child(crate::artifact_image_view::preview(raster, false, window));
            } else if !revision.visual_supported {
                content = content.child(crate::ui::text(crate::ui::Text::Caption, "No native inline preview for this artifact. Source is retained; Expand opens its detail."));
            } else if let Some(scene) = self.snapshot.scene.clone() {
                content = content.child(self.node(&scene.root, "0", &mut 4096, cx));
            }
            view = view.child(
                div()
                    .id("inline-visual-content")
                    .test_support()
                    .flex_1()
                    .min_h_0()
                    .min_w_0()
                    .child(
                        content
                            .overflow_y_scrollbar()
                            .id(SharedString::from(format!(
                                "inline-scroll:{}:{}:{}:{}",
                                revision.reference.session,
                                revision.reference.id,
                                revision.reference.revision,
                                self.source
                            )))
                            .scroll_bounce(false),
                    ),
            );
        }
        view.into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui_kit::TestAppContext;
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
