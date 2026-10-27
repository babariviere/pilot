//! Paint-admitted stored images. One FIFO decode lane, all visible rows retained,
//! recently visible pixels kept for re-entry.
use super::*;
use gpui_kit::{
    AnyElement, ObjectFit, StyledImage, TestSupportExt, canvas, component::WindowExt, img,
};
use std::{
    cell::RefCell,
    collections::BTreeMap,
    rc::Rc,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};
/// Decoded pixels kept for rows scrolled out of view, so scrolling back shows
/// them without reloading. The least recently visible are released first;
/// visible rows never are.
const OFFSCREEN_BYTES: u64 = 256 * 1024 * 1024;
pub(super) struct Entry {
    key: crate::model::ReaderKey,
    source: Arc<crate::conversation_images::Source>,
    raster: Option<crate::artifact_image::Raster>,
    error: Option<&'static str>,
    stop: Arc<AtomicBool>,
    seen: u64,
    _task: Task<()>,
}
impl Drop for Entry {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
    }
}
#[derive(Default)]
pub(super) struct Preview {
    serial: u64,
    scope: u64,
    tick: u64,
    entries: BTreeMap<u64, Entry>,
    pub(super) painted: Rc<RefCell<Vec<u64>>>,
}
impl TranscriptView {
    pub(super) fn clear_image(&mut self, cx: &mut App) {
        self.images.serial += 1;
        for (_, entry) in std::mem::take(&mut self.images.entries) {
            if let Some(raster) = &entry.raster {
                let image = raster.image.clone();
                cx.defer(move |cx| cx.drop_image(image, None));
            }
        }
    }
    fn retire_image(&mut self, id: u64, cx: &mut App) {
        if let Some(e) = self.images.entries.remove(&id)
            && let Some(raster) = &e.raster
        {
            let image = raster.image.clone();
            cx.defer(move |cx| cx.drop_image(image, None));
        }
    }
    /// Keeps previews whose row still has the same identity and source.
    pub(super) fn retain_images(&mut self, rows: &[Message], cx: &mut App) {
        if self.images.scope != self.history_scope {
            self.clear_image(cx);
            return;
        }
        let stale: Vec<_> = self
            .images
            .entries
            .iter()
            .filter(|(id, e)| {
                !rows.iter().any(|r| {
                    r.id() == **id
                        && r.reader_key().as_ref() == Some(&e.key)
                        && r.image_data() == Some(&e.source)
                })
            })
            .map(|(id, _)| *id)
            .collect();
        for id in stale {
            self.retire_image(id, cx);
        }
    }
    pub(super) fn reconcile_images(&mut self, ids: Vec<u64>, cx: &mut Context<Self>) {
        self.images.tick += 1;
        let tick = self.images.tick;
        for id in &ids {
            if let Some(e) = self.images.entries.get_mut(id) {
                e.seen = tick;
            }
        }
        // Offscreen rows still waiting cancel their decode. Decoded or failed
        // rows stay, so re-entry neither reloads nor changes height.
        let mut pending = Vec::new();
        let mut decoded = Vec::new();
        let mut bytes = 0;
        for (id, e) in self.images.entries.iter().filter(|(_, e)| e.seen != tick) {
            match &e.raster {
                Some(r) => {
                    let size = u64::from(r.width) * u64::from(r.height) * 4;
                    bytes += size;
                    decoded.push((e.seen, *id, size));
                }
                None if e.error.is_none() => pending.push(*id),
                None => {}
            }
        }
        for id in pending {
            self.retire_image(id, cx);
        }
        decoded.sort_unstable();
        for (_, id, size) in decoded {
            if bytes <= OFFSCREEN_BYTES {
                break;
            }
            bytes -= size;
            self.retire_image(id, cx);
        }
        for id in ids {
            self.open_image(id, cx);
        }
    }
    fn open_image(&mut self, id: u64, cx: &mut Context<Self>) {
        if self.images.entries.contains_key(&id) {
            return;
        }
        let Some(source) = self
            .transcript
            .messages()
            .iter()
            .find(|r| r.id() == id)
            .and_then(|r| r.image_data())
            .cloned()
        else {
            return;
        };
        if source.problem.is_some() || source.owner.is_none() {
            return;
        }
        let Some(key) = self
            .transcript
            .messages()
            .iter()
            .find(|r| r.id() == id)
            .and_then(Message::reader_key)
        else {
            return;
        };
        self.images.scope = self.history_scope;
        let serial = self.images.serial;
        let scope = self.history_scope;
        let stop = Arc::new(AtomicBool::new(false));
        let decode_stop = stop.clone();
        let decode_source = source.clone();
        let entry_stop = stop.clone();
        let task = cx.spawn(async move |view, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    let _permit = crate::artifact_image::Permit::queued().await;
                    decode_source.decode(|| decode_stop.load(Ordering::Acquire))
                })
                .await;
            let _ = view.update(cx, |v, cx| {
                if v.images.serial != serial || v.history_scope != scope {
                    return;
                }
                let Some(entry) = v
                    .images
                    .entries
                    .get_mut(&id)
                    .filter(|e| Arc::ptr_eq(&e.stop, &stop))
                else {
                    return;
                };
                match result {
                    Ok(raster) => entry.raster = Some(raster),
                    Err(e) => entry.error = Some(e),
                }
                if let Some(ix) = v.transcript.messages().iter().position(|r| r.id() == id) {
                    v.scroller
                        .update(cx, |s, cx| s.remeasure_items(ix..ix + 1, cx));
                }
                cx.notify();
            });
        });
        self.images.entries.insert(
            id,
            Entry {
                key,
                source,
                raster: None,
                error: None,
                stop: entry_stop,
                seen: self.images.tick,
                _task: task,
            },
        );
        cx.notify();
    }
    pub(super) fn render_image(
        &self,
        row: &Message,
        cx: &App,
        owner: gpui_kit::WeakEntity<Self>,
    ) -> AnyElement {
        let source = row.image_data().unwrap();
        let id = row.id();
        let entry = self
            .images
            .entries
            .get(&id)
            .filter(|e| &e.source == source && self.images.scope == self.history_scope);
        let error = source
            .problem
            .or(if source.owner.is_none() {
                Some("Source identity unavailable. No preview loaded.")
            } else {
                None
            })
            .or(entry.and_then(|e| e.error));
        let provenance = format!(
            "{} · {:?} · {} · source {}",
            source
                .owner
                .as_ref()
                .map(|(h, c)| format!(
                    "Local · daemon {} · lineage {} · chat {}",
                    h.daemon_id, h.lineage_id, c
                ))
                .unwrap_or_else(|| "Unqualified source".into()),
            row.reader_key(),
            source.mime,
            source.hash.as_deref().unwrap_or("unavailable")
        );
        let scope = self.history_scope;
        let copy_owner = owner.clone();
        let copy_source = source.clone();
        let copy_key = row.reader_key();
        let expand_source = source.clone();
        let expand_key = row.reader_key();
        let pointer_source = source.clone();
        let pointer_key = row.reader_key();
        let painted = self.images.painted.clone();
        let identity = Button::new(("conversation-image-source", id))
            .ghost()
            .xsmall()
            .icon(crate::app_icon::AppIcon::Copy.asset())
            .accessibility_label("Copy source identity")
            .tooltip("Copy source identity")
            .on_click(move |_, _, cx| {
                let _ = copy_owner.update(cx, |v, cx| {
                    if v.history_scope == scope
                        && v.transcript.messages().iter().any(|r| {
                            r.id() == id
                                && r.reader_key() == copy_key
                                && r.image_data() == Some(&copy_source)
                        })
                    {
                        cx.write_to_clipboard(ClipboardItem::new_string(provenance.clone()));
                    }
                });
            });
        let supported =
            source.data.is_some() && source.owner.is_some() && row.reader_key().is_some();
        let expand_owner = owner.clone();
        // Image actions appear on hover; the image itself stays the content.
        let mut actions = div()
            .h_flex()
            .gap_1()
            .opacity(0.)
            .group_hover("conversation-image", |s| s.opacity(1.))
            .child(identity);
        if supported {
            actions = actions.child(
                Button::new(("conversation-image-expand", id))
                    .ghost()
                    .xsmall()
                    .icon(crate::app_icon::AppIcon::Enlarge.asset())
                    .accessibility_label("Expand")
                    .tooltip("Expand")
                    .disabled(entry.and_then(|e| e.raster.as_ref()).is_none())
                    .on_click(move |_, w, cx| {
                        let _ = expand_owner.update(cx, |v, cx| {
                            v.expand_image(id, scope, &expand_source, &expand_key, w, cx)
                        });
                    }),
            );
        }
        let mut content = div()
            .id(("conversation-image", id))
            .test_support()
            .group("conversation-image")
            .relative()
            .v_flex()
            .w_full()
            .min_w_0()
            .gap_2()
            .child(
                canvas(
                    move |bounds, w, _| {
                        let visible = bounds.intersect(&w.content_mask().bounds);
                        if visible.size.width > px(0.) && visible.size.height > px(0.) {
                            let mut rows = painted.borrow_mut();
                            if !rows.contains(&id) {
                                rows.push(id);
                            }
                        }
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .inset_0(),
            )
            .child(
                div()
                    .h_flex()
                    .flex_wrap()
                    .justify_between()
                    .gap_2()
                    .child(
                        crate::ui::text(crate::ui::Text::Caption, row.display_label().to_owned())
                            .text_color(
                                gpui_kit::component::ActiveTheme::theme(cx).muted_foreground,
                            )
                            .flex_1()
                            .min_w_0(),
                    )
                    .child(actions),
            );
        if supported {
            let raster = entry.and_then(|e| e.raster.as_ref());
            // Header size and decoded pixels share one geometry, so loading never
            // resizes the row. A failed decode uses the compact status row.
            let size = raster
                .map(|r| (r.width, r.height))
                .or(source.size.filter(|_| error.is_none()));
            let mut viewport = size
                .map(|(w, h)| crate::artifact_image_view::inline_frame(w, h))
                .unwrap_or_else(|| div().w_full().h_48())
                .id(("conversation-image-viewport", id))
                .test_support()
                .relative()
                .overflow_hidden();
            if let Some(raster) = raster {
                viewport = viewport.child(
                    img(raster.image.clone())
                        .object_fit(ObjectFit::Contain)
                        .id(("conversation-image-pixels", id))
                        .test_support()
                        .absolute()
                        .inset_0()
                        .size_full()
                        .min_w_0()
                        .min_h_0(),
                );
            } else {
                let status =
                    crate::ui::text(crate::ui::Text::Caption, error.unwrap_or("Loading image…"))
                        .id(("conversation-image-status", id))
                        .test_support();
                viewport = if size.is_some() {
                    viewport.child(div().absolute().inset_0().child(status))
                } else {
                    viewport.child(status)
                };
            }
            content = content.child(viewport.cursor_pointer().on_click(move |_, w, cx| {
                let _ = owner.update(cx, |v, cx| {
                    v.expand_image(id, scope, &pointer_source, &pointer_key, w, cx)
                });
            }));
        } else {
            content = content.child(
                crate::ui::text(
                    crate::ui::Text::Caption,
                    error.unwrap_or("Source identity unavailable. No preview loaded."),
                )
                .id(("conversation-image-problem", id))
                .test_support(),
            );
        }
        if source.mime == "image/gif" {
            content = content.child(crate::ui::text(
                crate::ui::Text::Caption,
                "First frame only",
            ));
        }
        content.into_any_element()
    }
    fn expand_image(
        &mut self,
        id: u64,
        scope: u64,
        source: &Arc<crate::conversation_images::Source>,
        key: &Option<crate::model::ReaderKey>,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self
            .transcript
            .messages()
            .iter()
            .any(|r| r.id() == id && &r.reader_key() == key && r.image_data() == Some(source))
        {
            return;
        }
        if self.history_scope != scope || self.history_guard.as_ref().is_some_and(|g| !g(w, cx)) {
            return;
        }
        let Some(e) = self.images.entries.get(&id) else {
            return;
        };
        let Some(raster) = e.raster.clone() else {
            return;
        };
        let source = e.source.clone();
        let key = e.key.clone();
        let parent = cx.entity();
        let reader = cx.new(|cx| ImageReader {
            parent: parent.downgrade(),
            key,
            scope,
            id,
            source,
            raster: Some(raster),
            zoom: Default::default(),
            focus: cx.focus_handle(),
            source_copy: None,
            _watch: cx.observe(&parent, |_, _, cx| {
                cx.notify();
            }),
        });
        let focus = reader.read(cx).focus.clone();
        w.open_dialog(cx, move |dialog, w, _| {
            let closing = reader.clone();
            dialog
                .on_close(move |_, _, cx| {
                    closing.update(cx, |v, _| {
                        v.source_copy = None;
                        v.raster = None;
                    })
                })
                .title("Image")
                .w(px((f32::from(w.viewport_size().width) - 48.).min(1040.)))
                .child(
                    div()
                        .h(px((f32::from(w.viewport_size().height) - 180.).max(240.)))
                        .child(reader.clone()),
                )
        });
        focus.focus(w, cx);
    }
}
struct ImageReader {
    parent: gpui_kit::WeakEntity<TranscriptView>,
    key: crate::model::ReaderKey,
    scope: u64,
    id: u64,
    source: Arc<crate::conversation_images::Source>,
    raster: Option<crate::artifact_image::Raster>,
    zoom: crate::reader_zoom::Zoom,
    focus: gpui_kit::FocusHandle,
    _watch: Subscription,
    source_copy: Option<Task<()>>,
}
impl ImageReader {
    fn valid(&self, cx: &App) -> bool {
        self.raster.is_some()
            && self.parent.upgrade().is_some_and(|p| {
                let p = p.read(cx);
                p.history_scope == self.scope
                    && p.transcript.messages().iter().any(|r| {
                        r.id() == self.id
                            && r.reader_key().as_ref() == Some(&self.key)
                            && r.image_data() == Some(&self.source)
                    })
            })
    }
    fn copy_source(&mut self, cx: &mut Context<Self>) {
        if !self.valid(cx) || self.source_copy.is_some() {
            return;
        }
        let source = self.source.clone();
        self.source_copy = Some(cx.spawn(async move |reader, cx| {
            let text = cx
                .background_executor()
                .spawn(async move {
                    source
                        .data
                        .as_ref()
                        .map(|d| format!("data:{};base64,{}", source.mime, d))
                })
                .await;
            let _ = reader.update(cx, |reader, cx| {
                reader.source_copy = None;
                if reader.valid(cx)
                    && let Some(text) = text
                {
                    cx.write_to_clipboard(ClipboardItem::new_string(text));
                }
                cx.notify();
            });
        }));
        cx.notify();
    }
}
impl Render for ImageReader {
    fn render(&mut self, w: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if !self.valid(cx) || self.raster.is_none() {
            self.raster = None;
            self.source_copy = None;
            return div()
                .child("Image source changed. Close this reader.")
                .into_any_element();
        }
        let raster = self.raster.as_ref().unwrap();
        let fit = self.zoom.image_fit(
            raster.width as f32 / w.scale_factor(),
            raster.height as f32 / w.scale_factor(),
        );
        let controls = self.zoom.toolbar(cx, move |v, command, cx| {
            v.zoom.apply(command, fit);
            cx.notify();
        });
        let pixels = crate::artifact_image_view::zoomed(raster, &self.zoom, w, cx);
        div()
            .id("conversation-reader")
            .track_focus(&self.focus)
            .v_flex()
            .size_full()
            .gap_2()
            .on_key_down(cx.listener(move |v, event, _, cx| {
                if let Some(command) = crate::reader_zoom::Zoom::key(event) {
                    v.zoom.apply(command, fit);
                    cx.stop_propagation();
                    cx.notify();
                } else if v.zoom.pan_key(event) {
                    cx.stop_propagation();
                    cx.notify();
                }
            }))
            .child(controls)
            .child(
                Button::new("conversation-reader-copy")
                    .ghost()
                    .small()
                    .label("Copy source")
                    .disabled(self.source_copy.is_some())
                    .on_click(cx.listener(|v, _, _, cx| v.copy_source(cx))),
            )
            .child(div().flex_1().min_h_0().child(pixels))
            .into_any_element()
    }
}
#[cfg(feature = "native-probes")]
#[path = "conversation_images_probe.rs"]
pub(crate) mod probe;
