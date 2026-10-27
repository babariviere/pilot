//! Presentation and lifetime owner for the current-chat gallery.
#[cfg(feature = "native-probes")]
#[path = "artifact_gallery_probe.rs"]
pub(crate) mod probe;
use super::*;
use crate::{
    artifact_gallery::{self, Cache, Key, Metadata},
    artifact_gallery_worker::{self as reader, Outcome},
    ui::{self, Action, Surface, Text},
};
use gpui_kit::component::Selectable;
use gpui_kit::{
    Div, FocusHandle, KeyBinding, ObjectFit, ScrollStrategy, StyledImage, UniformListScrollHandle,
    canvas, img, rems, uniform_list,
};
use std::{cell::RefCell, collections::BTreeSet, rc::Rc};

gpui_kit::actions!(
    artifact_gallery,
    [
        MoveLeft, MoveRight, MoveUp, MoveDown, First, Last, PageUp, PageDown, OpenTarget
    ]
);

#[derive(Default)]
pub(super) struct State {
    visible: bool,
    metadata: Metadata,
    cache: Cache,
    errors: BTreeMap<Key, &'static str>,
    desired: Vec<Reference>,
    current: Option<(u64, Key)>,
    current_cancelled: bool,
    serial: u64,
    reader_epoch: u64,
    manifest: u64,
    worker: Option<reader::Worker>,
    updates: Option<Task<()>>,
    start: Option<Task<()>>,
    drains: Vec<async_channel::Receiver<()>>,
    problem: Option<&'static str>,
    focus: Option<FocusHandle>,
    target: Option<Key>,
    anchor: Option<Key>,
    anchor_row: usize,
    scroll: UniformListScrollHandle,
    cols: usize,
    geometry: Option<Geometry>,
    bound: bool,
    release: Option<Subscription>,
    retired: Rc<RefCell<Vec<Arc<gpui_kit::RenderImage>>>>,
}
#[derive(Clone, Copy, Debug, PartialEq)]
struct Geometry {
    width: f32,
    height: f32,
    offset: f32,
    stride: f32,
    rem: f32,
}
impl ArtifactPane {
    pub(super) fn reader_drains(&self) -> Vec<async_channel::Receiver<()>> {
        self.gallery.drains.clone()
    }
    pub(super) fn reader_drain(&mut self, finished: async_channel::Receiver<()>) {
        self.gallery.drains.retain(|r| !r.is_closed());
        if !finished.is_closed() {
            self.gallery.drains.push(finished);
        }
    }
    pub(super) fn suspend_gallery(&mut self) {
        self.gallery.reader_epoch += 1;
        self.gallery.start = None;
        self.gallery.visible = false;
        self.gallery.current = None;
        self.gallery.desired.clear();
        self.gallery.geometry = None;
        self.gallery.updates = None;
        if let Some(worker) = self.gallery.worker.take() {
            self.reader_drain(worker.finished());
            drop(worker); // No worker or cancellation sender is retained by a completion waiter.
        }
    }
    fn gallery_lifetime(&mut self, cx: &mut Context<Self>) {
        if self.gallery.release.is_none() {
            self.gallery.release = Some(cx.on_release(|view, cx| {
                view.close();
                let mut images = view.gallery.cache.clear();
                images.extend(view.gallery.retired.borrow_mut().drain(..));
                cx.defer(move |cx| {
                    for image in images {
                        cx.drop_image(image, None);
                    }
                });
            }));
        }
    }
    pub(super) fn reset_gallery(&mut self, cx: &mut Context<Self>) {
        self.gallery_lifetime(cx);
        let images = self.gallery.cache.clear();
        self.retire_thumbnails(images, cx);
        self.gallery.errors.clear();
        self.gallery.problem = None;
        self.gallery.target = None;
        self.gallery.anchor = None;
        self.gallery.metadata = Metadata::default();
        self.gallery.scroll = UniformListScrollHandle::new();
        self.gallery.manifest += 1;
    }
    pub(crate) fn artifact_metadata(&mut self, metadata: Metadata, cx: &mut Context<Self>) {
        self.gallery_lifetime(cx);
        if self.gallery.metadata == metadata {
            return;
        }
        self.gallery.metadata = metadata;
        self.gallery.geometry = None;
        self.gallery.manifest += 1;
        if !self.gallery_metadata_usable() {
            self.gallery.desired.clear();
            self.cancel_gallery_request();
        }
        cx.notify();
    }
    fn gallery_metadata_usable(&self) -> bool {
        self.gallery.metadata.is_received()
            && !self.gallery.metadata.is_stale()
            && self.gallery.metadata.problem().is_none()
    }
    pub(super) fn reconcile_gallery(&mut self, cx: &mut Context<Self>) {
        let keys: BTreeSet<_> = self.items.iter().map(Key::new).collect();
        let images = self.gallery.cache.retain(&keys);
        self.retire_thumbnails(images, cx);
        self.gallery.errors.retain(|k, _| keys.contains(k));
        self.gallery.desired.retain(|r| keys.contains(&Key::new(r)));
        if self
            .gallery
            .current
            .as_ref()
            .is_some_and(|(_, k)| !keys.contains(k))
        {
            self.cancel_gallery_request();
        }
        if self
            .gallery
            .target
            .as_ref()
            .is_none_or(|k| !keys.contains(k))
        {
            self.gallery.target = self
                .gallery
                .target
                .as_ref()
                .and_then(|key| self.items.iter().find(|r| key.same_artifact(r)))
                .or_else(|| self.items.first())
                .map(Key::new);
        }
        if let Some(anchor) = &self.gallery.anchor {
            let ix = self
                .items
                .iter()
                .position(|r| Key::new(r) == *anchor)
                .or_else(|| self.items.iter().position(|r| anchor.same_artifact(r)));
            if let Some(ix) = ix {
                let row = ix / self.gallery.cols.max(1);
                if row != self.gallery.anchor_row {
                    self.gallery.scroll.scroll_to_item(row, ScrollStrategy::Top);
                }
                self.gallery.anchor_row = row;
                self.gallery.anchor = Some(Key::new(&self.items[ix]));
            }
        }
        self.gallery.geometry = None;
        self.gallery.manifest += 1;
        // A clicked detail/pending detail is intentionally NOT reconciled against latest metadata.
    }
    pub(super) fn gallery_target(&mut self, reference: &Reference) {
        self.gallery.target = Some(Key::new(reference));
    }
    fn cancel_gallery_request(&mut self) {
        self.gallery.current_cancelled = true;
        if let Some(worker) = &self.gallery.worker {
            worker.cancel();
        }
    }
    pub(crate) fn hide_gallery(&mut self, cx: &mut Context<Self>) {
        self.close();
        let images = self.gallery.cache.clear();
        self.retire_thumbnails(images, cx);
        self.gallery.errors.clear();
    }
    pub(crate) fn show_gallery(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.inline = false;
        self.close();
        self.flush_image(window, cx);
        self.gallery_lifetime(cx);
        self.gallery.visible = true;
        self.gallery.problem = None;
        if self.gallery.focus.is_none() {
            self.gallery.focus = Some(cx.focus_handle().tab_stop(true));
        }
        if !self.gallery.bound {
            cx.bind_keys([
                KeyBinding::new("left", MoveLeft, Some("ArtifactGallery")),
                KeyBinding::new("right", MoveRight, Some("ArtifactGallery")),
                KeyBinding::new("up", MoveUp, Some("ArtifactGallery")),
                KeyBinding::new("down", MoveDown, Some("ArtifactGallery")),
                KeyBinding::new("home", First, Some("ArtifactGallery")),
                KeyBinding::new("end", Last, Some("ArtifactGallery")),
                KeyBinding::new("pageup", PageUp, Some("ArtifactGallery")),
                KeyBinding::new("pagedown", PageDown, Some("ArtifactGallery")),
                KeyBinding::new("enter", OpenTarget, Some("ArtifactGallery")),
                KeyBinding::new("space", OpenTarget, Some("ArtifactGallery")),
            ]);
            self.gallery.bound = true;
        }
        self.reconcile_gallery(cx);
        window.focus(self.gallery.focus.as_ref().unwrap(), cx);
        self.begin_after_drain(window, cx);
        cx.notify();
    }
    pub(super) fn begin_after_drain(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.gallery.drains.retain(|r| !r.is_closed());
        if self.gallery.drains.is_empty() {
            if self.reference.is_some() {
                self.start_detail_reader(window, cx);
            } else {
                self.pump_gallery(cx);
            }
            return;
        }
        let drains = self.gallery.drains.clone(); // Completion receivers ONLY, never the worker/lifetime sender.
        let generation = self.generation;
        let expected = self.reference.as_ref().map(Key::new);
        self.gallery.start = Some(cx.spawn_in(window, async move |view, cx| {
            for finished in drains {
                let _ = finished.recv().await;
            }
            let _ = view.update_in(cx, |view, window, cx| {
                if view.generation != generation
                    || view.reference.as_ref().map(Key::new) != expected
                {
                    return;
                }
                view.gallery.start = None;
                view.gallery.drains.retain(|r| !r.is_closed());
                if view.reference.is_some() {
                    view.start_detail_reader(window, cx);
                } else if view.gallery.visible {
                    view.pump_gallery(cx);
                }
                cx.notify();
            });
        }));
    }
    fn retire_thumbnails(
        &mut self,
        images: Vec<Arc<gpui_kit::RenderImage>>,
        cx: &mut Context<Self>,
    ) {
        if images.is_empty() {
            return;
        }
        let queue = self.gallery.retired.clone();
        let empty = queue.borrow().is_empty();
        queue.borrow_mut().extend(images);
        debug_assert!(queue.borrow().len() <= artifact_gallery::CACHE_ENTRIES);
        if !empty {
            return;
        }
        let view = cx.weak_entity();
        // App effect callback runs after the current window is reattached, including view release.
        cx.defer(move |cx| {
            for image in queue.borrow_mut().drain(..) {
                cx.drop_image(image, None);
            }
            let _ = view.update(cx, |view, cx| view.pump_gallery(cx));
        });
    }
    fn pump_gallery(&mut self, cx: &mut Context<Self>) {
        if !self.gallery.visible
            || self.reference.is_some()
            || self.gallery.start.is_some()
            || self.gallery.drains.iter().any(|r| !r.is_closed())
            || self.gallery.current.is_some()
            || self.gallery.problem.is_some()
            || !self.gallery.retired.borrow().is_empty()
            || !self.gallery_metadata_usable()
        {
            return;
        }
        let next = self
            .gallery
            .desired
            .iter()
            .find(|r| {
                let key = Key::new(r);
                self.gallery.cache.get(&key).is_none() && !self.gallery.errors.contains_key(&key)
            })
            .cloned();
        let Some(reference) = next else {
            return;
        };
        if self.gallery.worker.is_none() {
            let (Some(options), Some(owner)) = (self.options.clone(), self.owner.clone()) else {
                return;
            };
            match reader::Worker::start(options, owner) {
                Ok((worker, updates)) => {
                    self.gallery.worker = Some(worker);
                    let generation = self.generation;
                    let reader_epoch = self.gallery.reader_epoch;
                    self.gallery.updates = Some(cx.spawn(async move |view, cx| {
                        while let Ok(update) = updates.recv().await {
                            if view
                                .update(cx, |view, cx| {
                                    view.accept_thumbnail(generation, reader_epoch, update, cx)
                                })
                                .is_err()
                            {
                                break;
                            }
                        }
                        let _ = view.update(cx, |view, cx| {
                            if view.generation == generation
                                && view.gallery.reader_epoch == reader_epoch
                                && view.gallery.visible
                            {
                                view.gallery.current = None;
                                view.gallery.problem = Some(
                                    "Thumbnail reader stopped. Open an artifact or retry previews.",
                                );
                                cx.notify();
                            }
                        });
                    }));
                }
                Err(message) => {
                    self.gallery.problem = Some(message);
                    cx.notify();
                    return;
                }
            }
        }
        self.gallery.serial += 1;
        let attempt = self.gallery.serial;
        let key = Key::new(&reference);
        match self
            .gallery
            .worker
            .as_mut()
            .unwrap()
            .load(reference, attempt)
        {
            Ok(()) => {
                self.gallery.current = Some((attempt, key));
                self.gallery.current_cancelled = false;
            }
            Err(message) => self.gallery.problem = Some(message),
        }
        cx.notify();
    }
    fn accept_thumbnail(
        &mut self,
        generation: u64,
        reader_epoch: u64,
        update: reader::Update,
        cx: &mut Context<Self>,
    ) {
        let (attempt, reference, outcome) = update.into_parts();
        let key = Key::new(&reference);
        if self.generation != generation
            || self.gallery.reader_epoch != reader_epoch
            || self.gallery.current.as_ref() != Some(&(attempt, key.clone()))
        {
            return;
        }
        self.gallery.current = None;
        let cancelled = std::mem::take(&mut self.gallery.current_cancelled);
        if let Some(worker) = &mut self.gallery.worker {
            worker.complete(attempt);
        }
        if !cancelled
            && self.gallery.visible
            && self.reference.is_none()
            && self.gallery_metadata_usable()
            && self.items.iter().any(|r| Key::new(r) == key)
            && self.gallery.desired.iter().any(|r| Key::new(r) == key)
        {
            match outcome {
                Outcome::Ready(thumbnail) => {
                    let old = self.gallery.cache.insert(key, thumbnail);
                    self.retire_thumbnails(old, cx);
                }
                Outcome::Failed(message) => {
                    self.gallery.errors.insert(key, message);
                }
                Outcome::Cancelled => {}
            }
        }
        self.pump_gallery(cx);
        cx.notify();
    }
    fn gallery_viewport(
        &mut self,
        generation: u64,
        manifest: u64,
        geometry: Geometry,
        cx: &mut Context<Self>,
    ) {
        if generation != self.generation
            || manifest != self.gallery.manifest
            || !self.gallery.visible
            || self.reference.is_some()
        {
            return;
        }
        if self.gallery.geometry == Some(geometry) {
            return;
        }
        self.gallery.geometry = Some(geometry);
        let cols = artifact_gallery::columns(
            geometry.width - 1.5 * geometry.rem,
            geometry.rem,
            0.75 * geometry.rem,
        );
        if cols != self.gallery.cols {
            let previous = self.gallery.cols.max(1);
            let row = artifact_gallery::visible_rows(
                geometry.offset,
                geometry.height,
                geometry.stride,
                self.items.len().div_ceil(previous),
            )
            .start;
            self.gallery.cols = cols;
            self.gallery
                .scroll
                .scroll_to_item(row.saturating_mul(previous) / cols, ScrollStrategy::Top);
            self.gallery.geometry = None;
            cx.notify();
            return; // Wait for the newly bucketed rows' actual layout before requesting.
        }
        let rows = artifact_gallery::visible_rows(
            geometry.offset,
            geometry.height,
            geometry.stride,
            self.items.len().div_ceil(cols),
        );
        self.gallery.anchor_row = rows.start;
        self.gallery.anchor = self
            .items
            .get(rows.start.saturating_mul(cols))
            .map(Key::new);
        let desired = if self.gallery_metadata_usable() {
            artifact_gallery::requests(&self.items, rows, cols, self.gallery.target.as_ref())
        } else {
            Vec::new()
        };
        if let Some((_, key)) = &self.gallery.current
            && !desired.iter().any(|r| Key::new(r) == *key)
        {
            self.cancel_gallery_request();
        }
        self.gallery
            .cache
            .touch(&desired.iter().map(Key::new).collect::<Vec<_>>());
        self.gallery.desired = desired;
        self.pump_gallery(cx);
    }
    fn move_gallery_target(
        &mut self,
        step: isize,
        edge: Option<bool>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self
            .gallery
            .focus
            .as_ref()
            .is_some_and(|f| f.is_focused(window))
        {
            cx.propagate();
            return;
        }
        if self.items.is_empty() {
            return;
        }
        let old = self
            .gallery
            .target
            .as_ref()
            .and_then(|k| self.items.iter().position(|r| Key::new(r) == *k))
            .unwrap_or(0);
        let ix = match edge {
            Some(false) => 0,
            Some(true) => self.items.len() - 1,
            None => old.saturating_add_signed(step).min(self.items.len() - 1),
        };
        self.gallery.target = Some(Key::new(&self.items[ix]));
        self.gallery
            .scroll
            .scroll_to_item(ix / self.gallery.cols.max(1), ScrollStrategy::Nearest);
        self.gallery.geometry = None;
        cx.notify();
    }
    fn open_gallery_target(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self
            .gallery
            .focus
            .as_ref()
            .is_some_and(|f| f.is_focused(window))
        {
            cx.propagate();
            return;
        }
        if let Some(reference) = self
            .items
            .iter()
            .find(|r| Some(Key::new(r)) == self.gallery.target)
            .cloned()
        {
            self.open(reference, window, cx);
        }
    }
    fn retry_gallery(&mut self, cx: &mut Context<Self>) {
        self.suspend_gallery();
        self.gallery.visible = true;
        self.gallery.errors.clear();
        self.gallery.problem = None;
        self.gallery.geometry = None;
        cx.notify(); // Fresh viewport intent starts work only after any old completion closes.
        if self.gallery.drains.iter().any(|r| !r.is_closed()) {
            let drains = self.gallery.drains.clone();
            let generation = self.generation;
            self.gallery.start = Some(cx.spawn(async move |view, cx| {
                for done in drains {
                    let _ = done.recv().await;
                }
                let _ = view.update(cx, |view, cx| {
                    if view.generation == generation && view.gallery.visible {
                        view.gallery.start = None;
                        view.gallery.drains.retain(|r| !r.is_closed());
                        view.pump_gallery(cx);
                    }
                });
            }));
        }
    }
    pub(super) fn render_gallery(
        &self,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let cols = self.gallery.cols.max(1);
        let mut root = div()
            .id("artifact-gallery")
            .test_support()
            .v_flex()
            .size_full()
            .min_w_0()
            .min_h_0()
            .key_context("ArtifactGallery")
            .on_action(cx.listener(|v, _: &MoveLeft, w, cx| v.move_gallery_target(-1, None, w, cx)))
            .on_action(cx.listener(|v, _: &MoveRight, w, cx| v.move_gallery_target(1, None, w, cx)))
            .on_action(cx.listener(|v, _: &MoveUp, w, cx| {
                v.move_gallery_target(-(v.gallery.cols.max(1) as isize), None, w, cx)
            }))
            .on_action(cx.listener(|v, _: &MoveDown, w, cx| {
                v.move_gallery_target(v.gallery.cols.max(1) as isize, None, w, cx)
            }))
            .on_action(
                cx.listener(|v, _: &First, w, cx| v.move_gallery_target(0, Some(false), w, cx)),
            )
            .on_action(
                cx.listener(|v, _: &Last, w, cx| v.move_gallery_target(0, Some(true), w, cx)),
            )
            .on_action(cx.listener(|v, _: &PageUp, w, cx| {
                v.move_gallery_target(-(v.gallery.cols.max(1) as isize) * 3, None, w, cx)
            }))
            .on_action(cx.listener(|v, _: &PageDown, w, cx| {
                v.move_gallery_target(v.gallery.cols.max(1) as isize * 3, None, w, cx)
            }))
            .on_action(cx.listener(|v, _: &OpenTarget, w, cx| v.open_gallery_target(w, cx)));
        if let Some(focus) = &self.gallery.focus {
            root = root.track_focus(focus);
        }
        root = root.child(
            div()
                .h_flex()
                .px_3()
                .pt_3()
                .pb_2()
                .gap_3()
                .child(
                    ui::text(Text::Headline, "Artifacts")
                        .id("artifact-gallery-heading")
                        .flex_1()
                        // A limited list says so in the heading tooltip, not a footer.
                        .when(self.gallery.metadata.is_limited(), |d| {
                            d.tooltip(|w, cx| {
                                gpui_kit::component::tooltip::Tooltip::new(
                                    "Showing the first 64 artifacts",
                                )
                                .build(w, cx)
                            })
                        }),
                )
                .when(
                    !self.gallery.errors.is_empty() || self.gallery.problem.is_some(),
                    |d| {
                        d.child(
                            ui::action("artifact-gallery-retry", "Retry previews", Action::Quiet)
                                .on_click(cx.listener(|v, _, _, cx| v.retry_gallery(cx))),
                        )
                    },
                ),
        );
        let problem = self.gallery.metadata.problem().or(self.gallery.problem);
        if let Some(problem) = problem {
            root = root.child(
                ui::text(Text::Caption, problem)
                    .px_3()
                    .pb_2()
                    .text_color(cx.theme().muted_foreground),
            );
        } else if self.gallery.metadata.is_stale() {
            root = root.child(
                ui::text(
                    Text::Caption,
                    "Artifact list may be outdated. Return to chat to reconnect.",
                )
                .px_3()
                .pb_2()
                .text_color(cx.theme().muted_foreground),
            );
        }
        if !self.gallery.metadata.is_received() && self.items.is_empty() {
            return root
                .child(
                    ui::text(
                        Text::Body,
                        if problem.is_some() || self.gallery.metadata.is_stale() {
                            "Artifact metadata is unavailable."
                        } else {
                            "Loading artifacts…"
                        },
                    )
                    .p_3(),
                )
                .into_any_element();
        }
        if self.items.is_empty() {
            return root
                .child(
                    ui::text(
                        Text::Body,
                        if self.gallery_metadata_usable() {
                            "No artifacts in this chat."
                        } else {
                            "Waiting for current artifact metadata…"
                        },
                    )
                    .p_3(),
                )
                .into_any_element();
        }
        let entity = cx.entity();
        let generation = self.generation;
        let manifest = self.gallery.manifest;
        let count = self.items.len().div_ceil(cols);
        let scroll = self.gallery.scroll.clone();
        let list = uniform_list("artifact-gallery-rows", count, move |range, window, cx| {
            entity.update(cx, |view, cx| {
                range
                    .map(|row| view.gallery_row(row, cols, generation, window, cx))
                    .collect()
            })
        })
        .track_scroll(&scroll)
        .size_full()
        .min_w_0()
        .min_h_0();
        let observed = self.gallery.geometry;
        let weak = cx.weak_entity();
        root = root.child(
            div()
                .id("artifact-gallery-viewport")
                .test_support()
                .relative()
                .flex_1()
                .min_w_0()
                .min_h_0()
                .overflow_hidden()
                .child(list)
                .child(
                    canvas(
                        move |bounds, window, cx| {
                            let state = scroll.0.borrow();
                            let Some(size) = state.last_item_size else {
                                return;
                            };
                            let mask = window.content_mask().bounds;
                            let top = f32::from(bounds.origin.y).max(f32::from(mask.origin.y));
                            let bottom = (f32::from(bounds.origin.y)
                                + f32::from(bounds.size.height))
                            .min(f32::from(mask.origin.y) + f32::from(mask.size.height));
                            let geometry = Geometry {
                                width: bounds.size.width.into(),
                                height: (bottom - top).max(0.),
                                offset: f32::from(state.base_handle.offset().y)
                                    - (top - f32::from(bounds.origin.y)).max(0.),
                                // The handle's item is the LIST viewport, not one row.
                                // Contents is the resolved uniform rows' total height.
                                stride: f32::from(size.contents.height) / count.max(1) as f32,
                                rem: window.rem_size().into(),
                            };
                            if observed != Some(geometry) {
                                cx.defer(move |cx| {
                                    let _ = weak.update(cx, |view, cx| {
                                        view.gallery_viewport(generation, manifest, geometry, cx)
                                    });
                                });
                            }
                        },
                        |_, _, _, _| {},
                    )
                    .absolute()
                    .inset_0()
                    .size_full(),
                ),
        );
        root.into_any_element()
    }
    fn gallery_row(
        &self,
        row: usize,
        cols: usize,
        generation: u64,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Div {
        let mut line = div()
            .h_flex()
            .items_stretch()
            .h(rems(15.))
            .w_full()
            .min_w_0()
            .px_3()
            .pb_3()
            .gap_3();
        for reference in self.items.iter().skip(row * cols).take(cols) {
            let reference = reference.clone();
            let key = Key::new(&reference);
            let thumbnail = self.gallery.cache.get(&key);
            let kind = match reference.kind.as_str() {
                "image" => "Image",
                "visual" => "Native visual",
                "swiftui" => "SwiftUI",
                "html" => "HTML",
                "react" => "React",
                "shader" => "Shader",
                _ => "Artifact",
            };
            let status = if self.gallery.errors.contains_key(&key) {
                "Preview unavailable"
            } else if self
                .gallery
                .current
                .as_ref()
                .is_some_and(|(_, k)| k == &key)
            {
                "Loading preview…"
            } else if reference.kind != "image" {
                if reference.kind == "visual" {
                    "Open to view"
                } else {
                    "Source only"
                }
            } else if self.gallery.desired.iter().any(|r| Key::new(r) == key) {
                "Queued preview"
            } else {
                "Preview on demand"
            };
            let preview = ui::surface(Surface::Tray, cx)
                .id(SharedString::from(format!(
                    "gallery-preview-{}-{}",
                    reference.id, reference.revision
                )))
                .test_support()
                .relative()
                .w_full()
                .min_w_0()
                .h(rems(7.))
                .rounded(px(crate::appearance::Radius::CONTROL))
                .overflow_hidden()
                .when_some(thumbnail, |d, thumb| {
                    d.child(
                        img(thumb.image())
                            .absolute()
                            .inset_0()
                            .size_full()
                            .min_w_0()
                            .min_h_0()
                            .object_fit(ObjectFit::Contain),
                    )
                })
                .when(thumbnail.is_none(), |d| {
                    d.v_flex()
                        .items_center()
                        .justify_center()
                        .gap_2()
                        .child(AppIcon::Artifacts.icon())
                        .child(
                            ui::text(Text::Caption, status).text_color(cx.theme().muted_foreground),
                        )
                });
            let label = format!(
                "{} · {} · revision {}",
                reference.title, kind, reference.revision
            );
            let caption = format!(
                "{} · r{}",
                thumbnail.map_or(kind, |t| t.format_label()),
                reference.revision
            );
            let focused = self
                .gallery
                .focus
                .as_ref()
                .is_some_and(|f| f.is_focused(window))
                && self.gallery.target.as_ref() == Some(&key);
            line = line.child(
                Button::new(SharedString::from(key.element_id()))
                    .ghost()
                    .small()
                    .w_0()
                    .flex_1()
                    .min_w_0()
                    .h_full()
                    .p_2()
                    .selected(focused)
                    .accessibility_label(SharedString::from(label))
                    .child(
                        div()
                            .v_flex()
                            .size_full()
                            .min_w_0()
                            .text_left()
                            .gap_1()
                            .child(preview)
                            .child(
                                ui::text(Text::Label, SharedString::from(reference.title.clone()))
                                    .id(SharedString::from(format!(
                                        "gallery-title-{}-{}",
                                        reference.id, reference.revision
                                    )))
                                    .test_support()
                                    .mt_1()
                                    .w_full()
                                    .min_w_0()
                                    .truncate(),
                            )
                            .child(
                                ui::text(Text::Caption, SharedString::from(caption))
                                    .w_full()
                                    .truncate()
                                    .text_color(cx.theme().muted_foreground),
                            ),
                    )
                    .on_click(cx.listener(move |view, _, window, cx| {
                        // A metadata refresh may have replaced the latest row since paint.
                        // This click still names its exact stored revision, never the replacement.
                        if view.generation == generation
                            && view.reference.is_none()
                            && view.gallery.visible
                        {
                            view.open(reference.clone(), window, cx);
                        }
                    })),
            );
        }
        // Empty last-row slots keep the same column width, not giant stretched final cards.
        for _ in self.items.len().saturating_sub(row * cols).min(cols)..cols {
            line = line.child(div().w_0().flex_1());
        }
        line
    }
}
