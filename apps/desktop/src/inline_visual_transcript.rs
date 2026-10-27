//! Bounded, paint-admitted readers. Hydration creates no workers. Pane and inline
//! surfaces transfer one Entity, never clone its runtime or dispatch ownership.
use super::*;
use crate::{artifact_model::Reference, artifact_view::ArtifactPane};
use gpui_kit::{AnyElement, canvas};
use std::{
    cell::{Cell, RefCell},
    rc::Rc,
};
#[cfg(feature = "native-probes")]
#[path = "inline_visual_probe.rs"]
pub(crate) mod probe;

const CACHED: usize = 8;
fn append_drains(
    pending: &mut Vec<async_channel::Receiver<()>>,
    drains: Vec<async_channel::Receiver<()>>,
) {
    pending.retain(|r| !r.is_closed());
    for drain in drains {
        if !drain.is_closed() && !pending.iter().any(|r| r.same_channel(&drain)) {
            pending.push(drain);
        }
    }
}
type Painted = Rc<RefCell<Vec<(u64, Reference)>>>;
#[derive(Clone, Copy, PartialEq, Eq)]
struct Survey {
    revision: u64,
    top: usize,
    offset: u32,
    bounds: [u32; 4],
}
struct Entry {
    reference: Reference,
    pane: Entity<ArtifactPane>,
    row: Option<u64>,
    _expand: Subscription,
    _admission: Subscription,
}
#[derive(Default)]
pub(super) struct State {
    options: Option<crate::LocalOptions>,
    owner: Option<String>,
    enabled: bool,
    entries: Vec<Entry>,
    painted: Painted,
    adopted: Option<gpui_kit::EntityId>,
    drains: Vec<async_channel::Receiver<()>>,
    waiting: Option<Task<()>>,
    desired: Vec<(u64, Reference)>,
    pub(super) revision: u64,
    surveyed: Rc<Cell<Option<Survey>>>,
    admission_pending: bool,
}
impl TranscriptView {
    pub(super) fn clear_inline(&mut self, cx: &mut App) {
        self.inline_visuals.waiting = None;
        for entry in self.inline_visuals.entries.drain(..) {
            if Some(entry.pane.entity_id()) != self.inline_visuals.adopted {
                entry.pane.update(cx, |p, cx| p.suspend_inline(cx));
            }
        }
    }
    #[cfg(feature = "native-probes")]
    pub(crate) fn inline_probe_panes(&self) -> Vec<(Reference, Entity<ArtifactPane>)> {
        self.inline_visuals
            .entries
            .iter()
            .filter(|e| e.row.is_some())
            .map(|e| (e.reference.clone(), e.pane.clone()))
            .collect()
    }
    #[cfg(feature = "native-probes")]
    pub(crate) fn inline_probe_scroll(&mut self, index: usize, cx: &mut Context<Self>) {
        self.scroller.update(cx, |s, cx| {
            s.scroll_to_item(index, cx);
        });
    }
    pub(crate) fn inline_context(
        &mut self,
        options: Option<crate::LocalOptions>,
        owner: Option<String>,
        enabled: bool,
        pane: &Entity<ArtifactPane>,
        cx: &mut Context<Self>,
    ) {
        let enabled = enabled && options.is_some() && owner.is_some();
        let changed = self.inline_visuals.owner != owner
            || self
                .inline_visuals
                .options
                .as_ref()
                .map(crate::LocalOptions::host)
                != options.as_ref().map(crate::LocalOptions::host);
        if changed {
            for entry in self.inline_visuals.entries.drain(..) {
                if Some(entry.pane.entity_id()) != self.inline_visuals.adopted {
                    append_drains(
                        &mut self.inline_visuals.drains,
                        entry.pane.read(cx).inline_drains(),
                    );
                    entry.pane.update(cx, |p, cx| p.suspend_inline(cx));
                }
            }
            self.inline_visuals.owner = owner;
            self.inline_visuals.options = options;
        }
        if self.inline_visuals.enabled != enabled || changed {
            self.inline_visuals.surveyed.set(None);
            self.inline_visuals.enabled = enabled;
            if !enabled {
                for entry in &mut self.inline_visuals.entries {
                    if entry.pane != *pane {
                        append_drains(
                            &mut self.inline_visuals.drains,
                            entry.pane.read(cx).inline_drains(),
                        );
                        entry.pane.update(cx, |p, cx| p.suspend_inline(cx));
                    }
                    entry.row = None;
                }
            } else {
                self.inline_visuals.adopted = None;
            }
            cx.notify();
        }
    }
    pub(crate) fn inline_expand(
        &mut self,
        reference: &Reference,
        cx: &mut Context<Self>,
    ) -> Option<Entity<ArtifactPane>> {
        let entry = self
            .inline_visuals
            .entries
            .iter()
            .find(|e| e.reference.same_revision(reference))?;
        let pane = entry.pane.clone();
        self.inline_visuals.adopted = Some(pane.entity_id());
        pane.update(cx, |p, cx| p.inline_mode(false, cx));
        Some(pane)
    }
    fn inline_reconcile(
        &mut self,
        rows: Vec<(u64, Reference)>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        #[cfg(feature = "native-probes")]
        let _timing = probe::scroll::work("reconcile");
        if !self.inline_visuals.enabled {
            return;
        }
        let Some(options) = self.inline_visuals.options.clone() else {
            return;
        };
        let mut desired: Vec<(u64, Reference)> = Vec::new();
        for (id, reference) in rows {
            if self.inline_visuals.owner.as_deref() != Some(&reference.session)
                || !self.transcript.messages().iter().any(|r| {
                    r.id() == id
                        && r.artifact_data()
                            .is_some_and(|r| r.same_revision(&reference))
                })
                || desired.iter().any(|(_, r)| r.same_revision(&reference))
            {
                continue;
            }
            desired.push((id, reference));
        }
        let mut changed = false;
        for entry in &mut self.inline_visuals.entries {
            let row = desired
                .iter()
                .find(|(_, r)| r.same_revision(&entry.reference))
                .map(|(id, _)| *id);
            if entry.row != row {
                // A decoded still image has no worker. It stays bound to its row
                // while scrolled out, so scrolling back neither reloads nor resizes it.
                let scrolled_out = entry.row.is_some_and(|id| {
                    self.transcript.messages().iter().any(|r| {
                        r.id() == id
                            && r.artifact_data()
                                .is_some_and(|a| a.same_revision(&entry.reference))
                    })
                });
                if row.is_none() && scrolled_out && entry.pane.read(cx).inline_raster_ready() {
                    continue;
                }
                changed = true;
                if row.is_none() {
                    append_drains(
                        &mut self.inline_visuals.drains,
                        entry.pane.read(cx).inline_drains(),
                    );
                    entry.pane.update(cx, |p, cx| p.suspend_inline(cx));
                }
                entry.row = row;
            }
            if row.is_some() && !entry.pane.read(cx).inline_matches(&entry.reference) {
                append_drains(
                    &mut self.inline_visuals.drains,
                    entry.pane.read(cx).inline_drains(),
                );
            }
        }
        self.inline_visuals.drains.retain(|r| !r.is_closed());
        self.inline_visuals.desired = desired.clone();
        if !self.inline_visuals.drains.is_empty() {
            if self.inline_visuals.waiting.is_none() {
                let drains = self.inline_visuals.drains.clone();
                self.inline_visuals.waiting = Some(cx.spawn_in(window, async move |view, cx| {
                    for done in drains {
                        let _ = done.recv().await;
                    }
                    let _ = view.update_in(cx, |v, w, cx| {
                        v.inline_visuals.waiting = None;
                        let desired = v.inline_visuals.desired.clone();
                        v.inline_reconcile(desired, w, cx);
                        cx.notify();
                    });
                }));
            }
            if changed {
                cx.notify();
            }
            return;
        }
        self.inline_visuals.admission_pending = false;
        for (id, reference) in desired {
            let index = self
                .inline_visuals
                .entries
                .iter()
                .position(|e| e.reference.same_revision(&reference));
            let index = match index {
                Some(index) => index,
                None => {
                    let offscreen = |e: &Entry| {
                        !self
                            .inline_visuals
                            .desired
                            .iter()
                            .any(|(_, r)| r.same_revision(&e.reference))
                    };
                    if self.inline_visuals.entries.len() >= CACHED
                        && let Some(index) = self.inline_visuals.entries.iter().position(offscreen)
                    {
                        let evicted = self.inline_visuals.entries.remove(index);
                        if evicted.row.is_some()
                            && Some(evicted.pane.entity_id()) != self.inline_visuals.adopted
                        {
                            evicted.pane.update(cx, |p, cx| p.suspend_inline(cx));
                        }
                    }
                    let pane = cx.new(|_| ArtifactPane::new());
                    let expand = cx.subscribe(
                        &pane,
                        |_, _, event: &crate::artifact_view::inline_visual::Expand, cx| {
                            cx.emit(ArtifactOpen(event.0.clone()))
                        },
                    );
                    let admission = cx.observe_in(&pane, window, |view, pane, window, cx| {
                        if pane.read(cx).inline_raster_ready()
                            && let Some(id) = view
                                .inline_visuals
                                .entries
                                .iter()
                                .find(|e| e.pane == pane)
                                .and_then(|e| e.row)
                            && let Some(ix) =
                                view.transcript.messages().iter().position(|r| r.id() == id)
                        {
                            #[cfg(feature = "native-probes")]
                            let _timing = probe::scroll::work("raster_remeasure");
                            view.scroller
                                .update(cx, |s, cx| s.remeasure_items(ix..ix + 1, cx));
                        }
                        if view.inline_visuals.admission_pending
                            && !pane.read(cx).inline_admitting()
                        {
                            let desired = view.inline_visuals.desired.clone();
                            view.inline_reconcile(desired, window, cx);
                        }
                    });
                    pane.update(cx, |p, cx| {
                        p.options(options.clone());
                        p.context(
                            Some(reference.session.clone()),
                            std::sync::Arc::new(vec![reference.clone()]),
                            cx,
                        );
                    });
                    self.inline_visuals.entries.push(Entry {
                        reference: reference.clone(),
                        pane,
                        row: Some(id),
                        _expand: expand,
                        _admission: admission,
                    });
                    changed = true;
                    self.inline_visuals.entries.len() - 1
                }
            };
            let opening = !self.inline_visuals.entries[index]
                .pane
                .read(cx)
                .inline_matches(&reference);
            if opening
                && self
                    .inline_visuals
                    .entries
                    .iter()
                    .any(|e| e.pane.read(cx).inline_admitting())
            {
                self.inline_visuals.admission_pending = true;
                continue;
            }
            changed |= opening;
            let entry = &mut self.inline_visuals.entries[index];
            entry.row = Some(id);
            entry
                .pane
                .update(cx, |p, cx| p.open_inline(reference, window, cx));
        }
        if changed {
            cx.notify();
        }
    }
    pub(super) fn inline_survey(&self, cx: &Context<Self>) -> AnyElement {
        let painted = self.inline_visuals.painted.clone();
        let weak = cx.weak_entity();
        let surveyed = self.inline_visuals.surveyed.clone();
        let scroller = self.scroller.clone();
        let revision = self.inline_visuals.revision;
        let images = self.images.painted.clone();
        // Prepaint runs before child paint, even for a retained/cached transcript.
        // Deferred reconciliation happens after all actual row paints. No timer/poll.
        canvas(
            move |bounds, window, cx| {
                let top = scroller.read(cx).logical_scroll_top();
                let sample = Survey {
                    revision,
                    top: top.item_ix,
                    offset: f32::from(top.offset_in_item).to_bits(),
                    bounds: [
                        f32::from(bounds.origin.x).to_bits(),
                        f32::from(bounds.origin.y).to_bits(),
                        f32::from(bounds.size.width).to_bits(),
                        f32::from(bounds.size.height).to_bits(),
                    ],
                };
                // Cached list rows need not replay prepaint when only a control
                // redraws. Resample membership only for actual reader geometry,
                // scrolling or transcript replacement, never an empty cache replay.
                if surveyed.replace(Some(sample)) == Some(sample) {
                    return;
                }
                painted.borrow_mut().clear();
                images.borrow_mut().clear();
                let painted = painted.clone();
                let images = images.clone();
                window.defer(cx, move |window, cx| {
                    let rows = std::mem::take(&mut *painted.borrow_mut());
                    let ids = std::mem::take(&mut *images.borrow_mut());
                    let _ = weak.update(cx, |v, cx| {
                        v.reconcile_images(ids, cx);
                        v.inline_reconcile(rows, window, cx);
                    });
                });
            },
            |_, _, _, _| {},
        )
        .absolute()
        .inset_0()
        .into_any_element()
    }
    pub(super) fn inline_row(
        &self,
        id: u64,
        reference: &Reference,
        cx: &App,
        owner: gpui_kit::WeakEntity<Self>,
    ) -> gpui_kit::Stateful<gpui_kit::Div> {
        let mut row = div()
            .id(("message", id))
            .relative()
            .v_flex()
            .w_full()
            .min_w_0();
        if let Some(guard) = self.history_guard.clone() {
            row = row.capture_any_mouse_down(move |_, w, cx| {
                if !guard(w, cx) {
                    cx.stop_propagation();
                }
            });
        }
        let candidate = matches!(reference.kind.as_str(), "visual" | "unknown" | "image");
        if candidate && self.inline_visuals.enabled {
            let painted = self.inline_visuals.painted.clone();
            let reference = reference.clone();
            row = row.child(
                canvas(
                    move |bounds, window, _| {
                        let visible = bounds.intersect(&window.content_mask().bounds);
                        if visible.size.width > px(0.) && visible.size.height > px(0.) {
                            let mut rows = painted.borrow_mut();
                            rows.retain(|(key, _)| *key != id);
                            if rows.len() < 128 {
                                rows.push((id, reference));
                            }
                        }
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .inset_0(),
            );
        }
        if let Some(entry) = self.inline_visuals.entries.iter().find(|e| {
            e.row == Some(id)
                && e.reference.same_revision(reference)
                && e.pane.read(cx).inline_matches(reference)
        }) {
            return row.child(entry.pane.clone());
        }
        if !candidate || !self.inline_visuals.enabled {
            row = row
                .p_3()
                .border_1()
                .rounded(px(crate::appearance::Radius::CARD))
                .bg(crate::appearance::card(cx))
                .border_color(cx.theme().border);
        }
        let reference = reference.clone();
        row = row.child(
            Button::new(("open-artifact", id))
                .ghost()
                .label(SharedString::from(format!(
                    "Open {} · r{}",
                    reference.title, reference.revision
                )))
                .on_click(move |_, _, cx| {
                    let _ = owner.update(cx, |_, cx| cx.emit(ArtifactOpen(reference.clone())));
                }),
        );
        if candidate && self.inline_visuals.enabled {
            row = row
                .h(px(crate::artifact_view::inline_visual::HEIGHT))
                .child(
                    crate::ui::text(crate::ui::Text::Caption, "Loading native preview…")
                        .text_color(cx.theme().muted_foreground),
                );
        }
        row
    }
}
