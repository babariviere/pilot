//! Transcript-owned, on-demand single preview. No URI resource loader or cache.
use super::*;
use gpui_kit::{AnyElement, ObjectFit, StyledImage, TestSupportExt, img};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

#[derive(Default)]
pub(super) struct Preview {
    serial: u64,
    scope: u64,
    selected: Option<(u64, Arc<crate::conversation_images::Source>)>,
    raster: Option<crate::artifact_image::Raster>,
    error: Option<&'static str>,
    stop: Option<Arc<AtomicBool>>,
    task: Option<Task<()>>,
}
impl Preview {
    pub(super) fn selected_id_source_missing(&self, rows: &[Message], scope: u64) -> bool {
        self.selected.as_ref().is_some_and(|(id, source)| {
            self.scope != scope
                || !rows
                    .iter()
                    .any(|row| row.id() == *id && row.image_data() == Some(source))
        })
    }
}
impl Drop for Preview {
    fn drop(&mut self) {
        if let Some(stop) = &self.stop {
            stop.store(true, Ordering::Release);
        }
    }
}
impl TranscriptView {
    pub(super) fn clear_image(&mut self, cx: &mut App) {
        self.images.serial += 1;
        if let Some(stop) = self.images.stop.take() {
            stop.store(true, Ordering::Release);
        }
        self.images.task = None;
        self.images.selected = None;
        self.images.error = None;
        if let Some(raster) = self.images.raster.take() {
            // Deferred until any borrowed window has been reattached to App.
            cx.defer(move |cx| {
                cx.drop_image(raster.image, None);
            });
        }
    }
    fn open_image(&mut self, id: u64, cx: &mut Context<Self>) {
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
        self.clear_image(cx);
        self.images.selected = Some((id, source.clone()));
        self.images.scope = self.history_scope;
        let permit = match crate::artifact_image::Permit::acquire() {
            Ok(permit) => permit,
            Err(error) => {
                self.images.error = Some(error);
                cx.notify();
                return;
            }
        };
        let serial = self.images.serial;
        let scope = self.history_scope;
        self.images.scope = scope;
        let stop = Arc::new(AtomicBool::new(false));
        self.images.stop = Some(stop.clone());
        self.images.task = Some(cx.spawn(async move |view, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    let _permit = permit;
                    source.decode(|| stop.load(Ordering::Acquire))
                })
                .await;
            let _ = view.update(cx, |view, cx| {
                if view.images.serial != serial || view.history_scope != scope {
                    return;
                }
                match result {
                    Ok(raster) => view.images.raster = Some(raster),
                    Err(error) => view.images.error = Some(error),
                }
                view.images.stop = None;
                cx.notify();
            });
        }));
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
        let active = self.images.scope == self.history_scope
            && self
                .images
                .selected
                .as_ref()
                .is_some_and(|(key, selected)| *key == id && selected == source);
        let error = source
            .problem
            .or(if source.owner.is_none() {
                Some("Source identity unavailable. No preview loaded.")
            } else {
                None
            })
            .or(if active { self.images.error } else { None });
        let provenance_owner = source
            .owner
            .as_ref()
            .map(|(host, chat)| {
                format!(
                    "Local · daemon {} · lineage {} · chat {}",
                    host.daemon_id, host.lineage_id, chat
                )
            })
            .unwrap_or_else(|| "Unqualified source".into());
        let provenance = format!(
            "{} · {:?} · {} · source {}",
            provenance_owner,
            row.reader_key(),
            source.mime,
            source
                .hash
                .as_deref()
                .unwrap_or("unavailable (not retained)")
        );
        let scope = self.history_scope;
        let captured = source.clone();
        let copy_owner = owner.clone();
        let copy_source = source.clone();
        let mut content = div()
            .text_color(cx.theme().muted_foreground)
            .id(("conversation-image", id))
            .test_support()
            .v_flex()
            .w_full()
            .min_w_0()
            .gap_2()
            .child(
                div()
                    .h_flex()
                    .flex_wrap()
                    .justify_between()
                    .gap_2()
                    .child(crate::ui::text(
                        crate::ui::Text::Caption,
                        format!("{} · {}", row.display_label(), source.mime),
                    ))
                    .child(
                        Button::new(("conversation-image-source", id))
                            .ghost()
                            .small()
                            .label("Copy source identity")
                            .on_click(move |_, _, cx| {
                                let _ = copy_owner.update(cx, |view, cx| {
                                    if view.history_scope == scope
                                        && view.transcript.messages().iter().any(|row| {
                                            row.id() == id && row.image_data() == Some(&copy_source)
                                        })
                                    {
                                        cx.write_to_clipboard(ClipboardItem::new_string(
                                            provenance.clone(),
                                        ));
                                    }
                                });
                            }),
                    ),
            );
        if (source.data.is_none() || source.owner.is_none())
            && let Some(error) = error
        {
            content = content.child(
                crate::ui::text(crate::ui::Text::Caption, error)
                    .id(("conversation-image-problem", id))
                    .test_support(),
            );
        }
        if source.data.is_some() && source.owner.is_some() {
            let mut viewport = div()
                .id(("conversation-image-viewport", id))
                .test_support()
                .relative()
                .w_full()
                .min_w_0()
                .h_48()
                .overflow_hidden();
            if active && let Some(raster) = &self.images.raster {
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
                viewport = viewport.child(
                    crate::ui::text(
                        crate::ui::Text::Caption,
                        if let Some(error) = error {
                            error
                        } else if active {
                            "Loading image…"
                        } else {
                            "Stored image preview"
                        },
                    )
                    .id(("conversation-image-status", id))
                    .test_support(),
                );
            }
            content = content.child(viewport).child(
                div().h_flex().child(
                    Button::new(("conversation-image-preview", id))
                        .ghost()
                        .small()
                        .label(if active && self.images.raster.is_some() {
                            "Hide image"
                        } else if active && error.is_some() {
                            "Retry preview"
                        } else {
                            "Preview image"
                        })
                        .disabled(active && self.images.stop.is_some())
                        .on_click(move |_, _, cx| {
                            let _ = owner.update(cx, |view, cx| {
                                if view.history_scope != scope
                                    || !view.transcript.messages().iter().any(|row| {
                                        row.id() == id && row.image_data() == Some(&captured)
                                    })
                                {
                                    return;
                                }
                                if active && view.images.raster.is_some() {
                                    view.clear_image(cx);
                                    cx.notify();
                                } else {
                                    view.open_image(id, cx);
                                }
                            });
                        }),
                ),
            );
            if source.mime == "image/gif" {
                content = content.child(crate::ui::text(
                    crate::ui::Text::Caption,
                    "First frame only. Animation is not played.",
                ));
            }
        }
        content.into_any_element()
    }
}

#[cfg(feature = "native-probes")]
#[path = "conversation_images_probe.rs"]
pub(crate) mod probe;
