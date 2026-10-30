//! Attachment-only composer seam. The existing draft owns identity and delivery.
use super::*;
use crate::image_attachments::{Attachment, Incoming};
use gpui_kit::{AnyElement, ObjectFit, StyledImage, Task, img};

#[derive(Default)]
pub(super) struct Previews {
    pub(super) coordinator: bool,
    pub(super) choosing: Option<Task<()>>,
    key: Option<String>,
    sources: Vec<Attachment>,
    pixels: Vec<Result<crate::artifact_image::Raster, &'static str>>,
    pub(super) task: Option<Task<()>>,
    pub(super) importing: Option<(String, Task<()>)>,
    pub(super) close_after_import: bool,
    error: Option<(String, &'static str)>,
}
impl ChatEditor {
    pub(crate) fn attachment_coordinator(&mut self, coordinator: bool, cx: &mut Context<Self>) {
        if self.attachments.coordinator != coordinator {
            self.attachments.coordinator = coordinator;
            if !coordinator {
                self.attachments.choosing = None;
            }
            cx.notify();
        }
    }

    pub(super) fn pick_images(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if !self.attachments.coordinator
            || !self.can_attach(w, cx)
            || self.attachments.choosing.is_some()
        {
            return;
        }
        self.changed(cx);
        let key = self.selected.clone();
        let revision = self.draft().map(|d| d.revision);
        let response = cx.prompt_for_paths(gpui_kit::PathPromptOptions {
            files: true,
            directories: false,
            multiple: true,
            prompt: Some("Attach images".into()),
        });
        self.attachments.choosing = Some(cx.spawn_in(w, async move |editor, cx| {
            let result = response.await;
            let _ = editor.update_in(cx, |v, w, cx| {
                v.attachments.choosing = None;
                if v.selected != key
                    || v.draft().map(|d| d.revision) != revision
                    || !v.attachments.coordinator
                {
                    return;
                }
                match result {
                    Ok(Ok(Some(paths))) => {
                        v.attach_images(paths.into_iter().map(Incoming::File).collect(), w, cx)
                    }
                    Ok(Ok(None)) => {}
                    _ => {
                        v.attachments.error =
                            key.map(|key| (key, "Could not choose images. Try again."));
                        cx.notify();
                    }
                }
                v.focus(w, cx);
                cx.notify();
            });
        }));
        cx.notify();
    }

    fn can_attach(&self, w: &mut Window, cx: &mut Context<Self>) -> bool {
        self.ready()
            && !self.diagnostic_chat()
            && self.writable
            && !self.waiting()
            && !self.marked(w, cx)
            && self.questions.current.is_none()
            && self.attachments.importing.is_none()
            && self.draft().is_some_and(Draft::editable)
    }

    pub(super) fn attachment_paste(&mut self, w: &mut Window, cx: &mut Context<Self>) -> bool {
        let Some(item) = cx.read_from_clipboard() else {
            return false;
        };
        let Some(incoming) = crate::image_attachments::clipboard(item) else {
            return false;
        };
        self.attach_images(incoming, w, cx);
        true
    }
    pub(super) fn attach_images(
        &mut self,
        incoming: Vec<Incoming>,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if incoming.is_empty() || !self.can_attach(w, cx) {
            return;
        }
        self.changed(cx);
        let key = self.selected.clone().unwrap();
        let Some(directory) = self.client.as_ref().and_then(|c| {
            if self.attachments.coordinator {
                c.pasted_attachment_directory.clone()
            } else {
                c.attachment_root
                    .as_ref()
                    .map(|root| root.join("attachments"))
            }
        }) else {
            return;
        };
        self.attachments.error = None;
        let capture = key.clone();
        let task = cx.spawn(async move |editor, cx| {
            let saved = cx
                .background_executor()
                .spawn(async move {
                    let _permit = crate::artifact_image::Permit::queued().await;
                    crate::image_attachments::save_to(&directory, incoming)
                })
                .await;
            let _ = editor.update(cx, |v, cx| {
                v.attachments.importing = None;
                let closing = std::mem::take(&mut v.attachments.close_after_import);
                let saved_ok = saved.is_ok();
                match saved {
                    Ok(images) => {
                        if let Some(draft) =
                            v.cache.get_mut(&capture).filter(|d| d.created.is_none())
                        {
                            draft.attachments.extend(images);
                            v.save_attachment_edit(&capture, cx);
                        }
                    }
                    Err(error) => v.attachments.error = Some((capture, error)),
                }
                v.sync_attachment_previews(cx);
                if closing && saved_ok {
                    v.request_close(cx);
                }
                cx.notify();
            });
        });
        self.attachments.importing = Some((key, task));
        cx.notify();
    }
    fn save_attachment_edit(&mut self, key: &str, cx: &mut Context<Self>) {
        let Some(draft) = self.cache.get_mut(key) else {
            return;
        };
        draft.revision += 1;
        if self
            .client
            .as_ref()
            .is_some_and(|c| c.edit(key.to_owned(), draft.clone()))
        {
            self.unsaved_local.remove(key);
            if self.selected.as_deref() == Some(key) {
                self.error = None;
            }
        } else {
            self.unsaved_local.insert(key.to_owned());
            self.error = Some("Image draft could not be saved. Keep this window open.");
        }
        cx.emit(EditorEvent::DraftsChanged);
        cx.notify();
    }
    pub(super) fn sync_attachment_previews(&mut self, cx: &mut Context<Self>) {
        let sources = self
            .draft()
            .filter(|d| {
                !self
                    .selected
                    .as_deref()
                    .is_some_and(|k| self.in_conversation(k, d))
            })
            .map(|d| d.attachments.clone())
            .unwrap_or_default();
        if self.attachments.key == self.selected && self.attachments.sources == sources {
            return;
        }
        for raster in self.attachments.pixels.drain(..).flatten() {
            cx.drop_image(raster.image, None);
        }
        self.attachments.task = None;
        self.attachments.key = self.selected.clone();
        self.attachments.sources = sources.clone();
        if sources.is_empty() {
            return;
        }
        let key = self.selected.clone();
        let capture = sources.clone();
        self.attachments.task = Some(cx.spawn(async move |editor, cx| {
            let pixels = cx
                .background_executor()
                .spawn(async move {
                    let _permit = crate::artifact_image::Permit::queued().await;
                    sources.iter().map(Attachment::preview).collect()
                })
                .await;
            let _ = editor.update(cx, |v, cx| {
                if v.selected == key && v.attachments.sources == capture {
                    v.attachments.pixels = pixels;
                    v.attachments.task = None;
                    cx.notify();
                }
            });
        }));
    }
    pub(super) fn attachment_strip(&self, cx: &Context<Self>) -> Option<AnyElement> {
        // A blocking question owns its reply input; ordinary draft images stay parked.
        if self.questions.current.is_some() {
            return None;
        }
        let key = self.selected.as_ref()?;
        let images = &self.attachments.sources;
        let importing = self
            .attachments
            .importing
            .as_ref()
            .is_some_and(|(k, _)| k == key);
        let error = self
            .attachments
            .error
            .as_ref()
            .filter(|(k, _)| k == key)
            .map(|(_, e)| *e);
        if images.is_empty() && !importing && error.is_none() {
            return None;
        }
        let row = div()
            .id("composer-attachments")
            .h_flex()
            .min_w_0()
            .gap_2()
            .overflow_x_scroll()
            .capture_any_mouse_down(cx.listener(|v, _, w, cx| {
                if v.marked(w, cx) {
                    cx.stop_propagation();
                }
            }));
        #[cfg(any(test, feature = "native-probes"))]
        let row = row.test_support();
        let mut row = row;
        for (ix, image) in images.iter().enumerate() {
            let id = image.id.clone();
            let remove_key = key.clone();
            let tile = div()
                .id(SharedString::from(format!("attachment:{id}")))
                .group("composer-attachment")
                .relative()
                .w(px(144.))
                .h(px(104.))
                .flex_shrink_0()
                .rounded(px(crate::appearance::Radius::CARD))
                .bg(crate::appearance::tray(cx))
                .overflow_hidden();
            #[cfg(any(test, feature = "native-probes"))]
            let tile = tile.test_support();
            let tile = match self.attachments.pixels.get(ix) {
                Some(Ok(raster)) => tile.child(
                    img(raster.image.clone())
                        .object_fit(ObjectFit::Contain)
                        .absolute()
                        .inset_0()
                        .size_full(),
                ),
                Some(Err(error)) => {
                    tile.child(crate::ui::text(crate::ui::Text::Caption, *error).p_2())
                }
                None => {
                    tile.child(crate::ui::text(crate::ui::Text::Caption, "Loading image…").p_2())
                }
            };
            row = row.child(
                tile.child(
                    div().absolute().top_0().right_0().child(
                        Button::new(SharedString::from(format!("remove-attachment:{id}")))
                            .custom(
                                gpui_kit::component::button::ButtonCustomVariant::new(cx)
                                    .color(crate::appearance::card(cx))
                                    .hover(crate::appearance::tray(cx))
                                    .active(crate::appearance::tray(cx)),
                            )
                            .bg(crate::appearance::card(cx))
                            .xsmall()
                            .opacity(0.)
                            .group_hover("composer-attachment", |s| s.opacity(1.))
                            .focus_visible(|s| s.opacity(1.))
                            .icon(AppIcon::Close.asset())
                            .accessibility_label("Remove attached image")
                            .tooltip("Remove attached image")
                            .disabled(
                                !self.writable
                                    || self.waiting()
                                    || !self.draft().is_some_and(Draft::editable),
                            )
                            .on_click(cx.listener(move |v, _, w, cx| {
                                if v.selected.as_ref() != Some(&remove_key)
                                    || v.marked(w, cx)
                                    || !v.writable
                                    || v.waiting()
                                    || !v.draft().is_some_and(Draft::editable)
                                {
                                    return;
                                }
                                v.changed(cx);
                                v.cache
                                    .get_mut(&remove_key)
                                    .unwrap()
                                    .attachments
                                    .retain(|a| a.id != id);
                                v.save_attachment_edit(&remove_key, cx);
                                v.sync_attachment_previews(cx);
                                v.text.update(cx, |s, cx| s.focus(w, cx));
                            })),
                    ),
                ),
            );
        }
        Some(
            div()
                .v_flex()
                .min_w_0()
                .gap_1()
                .when(!images.is_empty(), |v| v.child(row))
                .children(
                    importing.then(|| crate::ui::text(crate::ui::Text::Caption, "Adding image…")),
                )
                .children(error.map(|e| {
                    crate::ui::text(crate::ui::Text::Caption, e).text_color(cx.theme().danger)
                }))
                .into_any_element(),
        )
    }
}
