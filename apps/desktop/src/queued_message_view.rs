//! Inline USER queue editing inside the composer tray. Each captured row keeps its own
//! native draft and immutable operation, separate from the main composer draft.
use super::*;
use crate::{
    queued_message::{self as model, Change, Outcome, Row, Snapshot, Source, State},
    ui::{self, Action, Notice, Text, Tone},
};
use gpui_kit::{
    ClipboardItem, EntityInputHandler, EventEmitter, FocusHandle, StatefulInteractiveElement,
    component::input::{InputEvent, Textarea, TextareaState},
};
use std::{cell::Cell, collections::BTreeMap, rc::Rc};
gpui_kit::actions!(queued_message, [CloseQueue, SaveQueue]);
#[cfg(feature = "native-probes")]
#[path = "queued_message_probe.rs"]
pub(crate) mod probe;
// Match Swift's compact queue rows, with five visible before scrolling.
const QUEUE_ROW_HEIGHT: f32 = 26.;
const QUEUE_VISIBLE_ROWS: f32 = 5.;
// Swift caps the tray while a row is open for editing.
const QUEUE_EDITING_HEIGHT: f32 = 260.;

/// Stable composer slot; LocalViewer retains the per-chat forms and guarded actions.
pub(super) struct Entry {
    viewer: gpui_kit::WeakEntity<LocalViewer>,
    _subscription: Subscription,
}
pub(super) fn entry(w: &mut Window, cx: &mut Context<LocalViewer>) -> Entity<Entry> {
    let viewer = cx.entity();
    cx.new(|cx| Entry {
        viewer: viewer.downgrade(),
        _subscription: cx.observe_in(&viewer, w, |_, _, _, cx| cx.notify()),
    })
}
impl Render for Entry {
    fn render(&mut self, w: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.viewer
            .update(cx, |v, cx| v.queued_message_tray(w, cx))
            .unwrap_or_else(|_| div().hidden().into_any_element())
    }
}
pub(super) enum Event {
    /// The inline editor closed while it held focus; the composer takes it back.
    Closed,
    /// Move this unqueued draft's text into the main composer. Never a send.
    Restore(u64),
}
struct Draft {
    /// Exact capture. Never refreshed in place: a newer row is a new capture.
    row: Row,
    input: Entity<TextareaState>,
    last: String,
    mode: Option<String>,
    state: State,
    confirm_remove: bool,
    /// Unsaved text carried onto a newer capture after the row changed in the queue.
    rebased: bool,
    /// Bumped by every text or mode change, so an ACK closes only its own intent.
    serial: u64,
    error: Option<&'static str>,
    completion: Option<Task<()>>,
    _input: Subscription,
}
impl Draft {
    fn differs(&self, row: &Row, cx: &App) -> bool {
        let value = self.input.read(cx).value();
        row.text().is_some_and(|t| t != value.as_ref())
            || self.mode.as_ref().is_some_and(|m| m != &row.mode)
    }
    /// Text or mode the user changed that neither the queue nor an
    /// acknowledged edit already holds.
    fn unsaved(&self, current: Option<&Row>, cx: &App) -> bool {
        let value = self.input.read(cx).value();
        let mode = self.mode.clone().filter(|m| m != &self.row.mode);
        let saved = match &self.state.attempt {
            Some((op, Outcome::Acknowledged)) => matches!(
                &op.change,
                Change::Edit { text, mode: sent } if text.as_str() == value.as_ref() && *sent == mode
            ),
            _ => false,
        };
        !saved && self.differs(&self.row, cx) && current.is_none_or(|r| self.differs(r, cx))
    }
    fn keeps(&self, current: Option<&Row>, cx: &App) -> bool {
        self.state
            .retains(&self.row, self.unsaved(current, cx), current)
    }
    fn outcome(&self) -> Option<&Outcome> {
        self.state.attempt.as_ref().map(|(_, o)| o)
    }
    /// Text that exists only here: never submitted, or newer than the submitted
    /// edit. A pending or uncertain operation's own payload never qualifies.
    fn local_text(&self, cx: &App) -> Option<String> {
        let value = self.input.read(cx).value().to_string();
        let unsent = match &self.state.attempt {
            None | Some((_, Outcome::NotSent(_))) => true,
            Some((_, Outcome::Pending)) => false,
            Some((op, _)) => !matches!(&op.change, Change::Edit { text, .. } if *text == value),
        };
        (unsent && self.row.text().is_some() && self.unsaved(None, cx)).then_some(value)
    }
}
/// One chat's retained queue drafts and its single open inline editor.
pub(super) struct Form {
    pub(super) source: Source,
    options: LocalOptions,
    current: bool,
    snapshot: Arc<Snapshot>,
    editing: Option<u64>,
    drafts: BTreeMap<u64, Draft>,
    focus: FocusHandle,
    bounds: Rc<Cell<Option<gpui_kit::Bounds<gpui_kit::Pixels>>>>,
}
impl EventEmitter<Event> for Form {}
impl Form {
    pub(super) fn new(options: LocalOptions, source: Source, cx: &mut Context<Self>) -> Self {
        Self {
            source,
            options,
            current: false,
            snapshot: Arc::default(),
            editing: None,
            drafts: BTreeMap::new(),
            focus: cx.focus_handle(),
            bounds: Default::default(),
        }
    }
    fn row(&self, id: u64) -> Option<&Row> {
        self.snapshot.rows.iter().find(|r| r.id == id)
    }
    pub(super) fn marked(&mut self, w: &mut Window, cx: &mut Context<Self>) -> bool {
        self.editing
            .and_then(|id| self.drafts.get(&id))
            .is_some_and(|d| {
                d.input
                    .update(cx, |i, cx| i.marked_text_range(w, cx).is_some())
            })
    }
    fn available(&self, id: u64) -> bool {
        self.current
            && !self.snapshot.unavailable
            && self
                .drafts
                .get(&id)
                .is_some_and(|d| self.snapshot.rows.iter().any(|r| r == &d.row))
    }
    /// Drops drafts that hold nothing the user could lose, so the next open
    /// captures the row Local currently publishes.
    fn prune(&mut self, cx: &App) {
        if !self.current || self.snapshot.unavailable {
            return;
        }
        let keep: Vec<u64> = self
            .drafts
            .iter()
            .filter(|(id, d)| self.editing == Some(**id) || d.keeps(self.row(**id), cx))
            .map(|(id, _)| *id)
            .collect();
        self.drafts.retain(|id, _| keep.contains(id));
    }
    /// A new exact capture of the current row, optionally carrying unsaved text.
    fn capture(
        &mut self,
        row: Row,
        carried: Option<(String, Option<String>)>,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let rebased = carried.is_some();
        let (text, mode) = carried.unwrap_or_else(|| {
            (
                row.text()
                    .map(str::to_owned)
                    .unwrap_or_else(|| crate::local_model::queued_row(&row).source().to_owned()),
                None,
            )
        });
        let input = cx.new(|cx| {
            let mut i = TextareaState::new(w, cx).auto_grow(1, 6);
            i.set_submit_on_enter(false, cx);
            i.set_value(text.clone(), w, cx);
            i
        });
        let id = row.id;
        let subscription = cx.subscribe_in(&input, w, move |v, input, e, w, cx| {
            if !matches!(e, InputEvent::Change) {
                return;
            }
            // A replaced capture's input may still emit; only the retained one counts.
            if let Some(d) = v.drafts.get_mut(&id).filter(|d| &d.input == input) {
                let value = d.input.read(cx).value().to_string();
                if value.len() > model::TEXT_BYTES {
                    d.input.update(cx, |i, cx| i.set_value(d.last.clone(), w, cx));
                    d.error = Some("Edit exceeds 64 KiB and was rejected in full. Previous text retained; undo history reset.");
                } else {
                    d.last = value;
                    d.error = None;
                }
                d.confirm_remove = false;
                d.serial += 1;
            }
            cx.notify();
        });
        self.drafts.insert(
            id,
            Draft {
                row,
                input,
                last: text,
                mode,
                state: State::default(),
                confirm_remove: false,
                rebased,
                serial: 0,
                error: None,
                completion: None,
                _input: subscription,
            },
        );
    }
    /// Opens a row inline. A draft is reused while it is pending or its capture is
    /// still current, so no operation is ever repeated. A
    /// changed row is captured afresh, carrying any unsaved text onto it.
    /// Delete opens the same editor at its confirmation.
    fn open(&mut self, id: u64, remove: bool, w: &mut Window, cx: &mut Context<Self>) {
        if !self.current || self.snapshot.unavailable || self.marked(w, cx) {
            return;
        }
        let Some(row) = self.row(id).cloned() else {
            // An unqueued retained draft opens for inspection, copy or restore only.
            if self.drafts.contains_key(&id) {
                if let Some(previous) = self.editing.filter(|p| *p != id) {
                    self.editing = None;
                    self.release(previous, cx);
                }
                self.editing = Some(id);
                self.focus.focus(w, cx);
                cx.notify();
            }
            return;
        };
        if let Some(previous) = self.editing.filter(|p| *p != id) {
            self.editing = None;
            self.release(previous, cx);
        }
        let reuse = self.drafts.get(&id).map(|d| {
            // A pending or uncertain operation keeps its capture: never a second try.
            let pending = matches!(d.outcome(), Some(Outcome::Pending | Outcome::Unknown(_)));
            let carried = (d.row.text().is_some() && d.unsaved(Some(&row), cx)).then(|| {
                let mode = d.mode.clone().filter(|m| m != &row.mode);
                (d.input.read(cx).value().to_string(), mode)
            });
            (pending || d.row == row, carried)
        });
        match reuse {
            Some((true, _)) => {}
            Some((false, carried)) => self.capture(row, carried, w, cx),
            None => self.capture(row, None, w, cx),
        }
        self.editing = Some(id);
        let available = self.available(id);
        let d = self.drafts.get_mut(&id).unwrap();
        d.confirm_remove = remove && available && !d.state.blocked() && d.row.token.is_some();
        if d.row.text().is_some() && !d.state.blocked() {
            d.input.update(cx, |i, cx| i.focus(w, cx));
        } else {
            self.focus.focus(w, cx);
        }
        cx.notify();
    }
    fn release(&mut self, id: u64, cx: &App) {
        if self
            .drafts
            .get(&id)
            .is_some_and(|d| !d.keeps(self.row(id), cx))
        {
            self.drafts.remove(&id);
        }
    }
    fn close(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        let owned = self.focus.contains_focused(w, cx);
        self.editing = None;
        self.prune(cx);
        if owned {
            cx.emit(Event::Closed);
        }
        cx.notify();
    }
    /// Cancel closes and keeps the draft and any receipt; reopening restores both.
    fn dismiss(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if self.editing.is_some() && !self.marked(w, cx) {
            self.close(w, cx);
        }
    }
    /// Explicit discard of unsaved text. A blocked capture keeps its receipt.
    fn discard_edit(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        let Some(id) = self.editing else {
            return;
        };
        if self.marked(w, cx) || !self.discardable(id) {
            return;
        }
        self.drafts.remove(&id);
        self.close(w, cx);
    }
    fn copy(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if self.marked(w, cx) {
            return;
        }
        if let Some(d) = self.editing.and_then(|id| self.drafts.get(&id)) {
            cx.write_to_clipboard(ClipboardItem::new_string(
                d.input.read(cx).value().to_string(),
            ));
        }
    }
    pub(super) fn refuse(&mut self, id: u64, error: &'static str, cx: &mut Context<Self>) {
        if let Some(d) = self.drafts.get_mut(&id) {
            d.error = Some(error);
            cx.notify();
        }
    }
    /// A blocked capture keeps its receipt while it is still queued, so the
    /// same operation is never repeated. Pending work is never dropped.
    fn discardable(&self, id: u64) -> bool {
        self.drafts.get(&id).is_some_and(|d| {
            !matches!(d.outcome(), Some(Outcome::Pending))
                && (!d.state.blocked() || self.row(id).is_none())
        })
    }
    /// After a successful restore the local text lives in the composer.
    pub(super) fn restored(&mut self, id: u64, cx: &mut Context<Self>) {
        if self.row(id).is_none() && self.discardable(id) {
            self.drafts.remove(&id);
            if self.editing == Some(id) {
                self.editing = None;
            }
            cx.notify();
        }
    }
    pub(super) fn local_text(&self, id: u64, cx: &App) -> Option<String> {
        self.drafts
            .get(&id)
            .filter(|_| self.row(id).is_none())
            .and_then(|d| d.local_text(cx))
    }
    fn submit(&mut self, remove: bool, w: &mut Window, cx: &mut Context<Self>) {
        let Some(id) = self.editing else {
            return;
        };
        if self.marked(w, cx) || !self.available(id) {
            // The rendered notice follows the current snapshot.
            cx.notify();
            return;
        }
        let d = self.drafts.get_mut(&id).unwrap();
        if d.state.blocked() {
            return;
        }
        if remove && !d.confirm_remove {
            d.confirm_remove = true;
            cx.notify();
            return;
        }
        let text = d.input.read(cx).value().to_string();
        let mode = d.mode.clone().filter(|m| m != &d.row.mode);
        if !remove && d.row.text() == Some(text.as_str()) && mode.is_none() {
            return;
        }
        let change = if remove {
            Change::Remove
        } else {
            Change::Edit { text, mode }
        };
        let op = match d.state.begin(&self.source, &d.row, change) {
            Ok(op) => op,
            Err(e) => {
                d.error = Some(e);
                cx.notify();
                return;
            }
        };
        d.error = None;
        d.confirm_remove = false;
        let serial = d.serial;
        match crate::queued_message_transport::start(self.options.clone(), op.clone()) {
            Err(e) => {
                d.state.finish(&op, Outcome::NotSent(e));
            }
            Ok(output) => {
                d.completion = Some(cx.spawn_in(w, async move |v, cx| {
                    let outcome = output.recv().await.unwrap_or(Outcome::Unknown(
                        "Queue worker stopped without a receipt. Do not replay.",
                    ));
                    let _ = v.update_in(cx, |v, w, cx| v.finish(id, &op, serial, outcome, w, cx));
                }));
            }
        }
        cx.notify();
    }
    fn finish(
        &mut self,
        id: u64,
        op: &model::Operation,
        serial: u64,
        outcome: Outcome,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let acknowledged = outcome == Outcome::Acknowledged;
        let Some(d) = self.drafts.get_mut(&id) else {
            return;
        };
        if !d.state.finish(op, outcome) {
            return;
        }
        // Close only when nothing changed in the editor since this exact submit.
        let intent = matches!(op.change, Change::Remove) || d.serial == serial;
        // A saved row closes its editor; focus returns only if the editor still held it.
        if acknowledged && intent && self.editing == Some(id) {
            self.close(w, cx);
        } else {
            self.prune(cx);
        }
        cx.notify();
    }
    fn toggle_mode(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if self.marked(w, cx) {
            return;
        }
        if let Some(d) = self.editing.and_then(|id| self.drafts.get_mut(&id)) {
            let next = if d.mode.as_deref().unwrap_or(&d.row.mode) == "steer" {
                "followUp"
            } else {
                "steer"
            };
            d.mode = Some(next.into());
            d.confirm_remove = false;
            d.serial += 1;
        }
        cx.notify();
    }
}
fn status(outcome: &Outcome) -> (&'static str, Tone) {
    match outcome {
        Outcome::Pending => (
            "Saving… Cancel closes the editor without stopping the save.",
            Tone::Normal,
        ),
        Outcome::NotSent(e) | Outcome::Unknown(e) => (*e, Tone::Error),
        Outcome::Acknowledged => ("Saved. Local has not updated the queue yet.", Tone::Normal),
    }
}
impl Render for Form {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.bounds.set(None);
        let Some(id) = self.editing.filter(|id| self.drafts.contains_key(id)) else {
            return div().hidden().into_any_element();
        };
        let available = self.available(id);
        let queued = self.row(id).is_some();
        let d = &self.drafts[&id];
        let blocked = d.state.blocked();
        let editable = d.row.text().is_some() && d.row.token.is_some();
        let mode = d.mode.as_deref().unwrap_or(&d.row.mode).to_owned();
        let text = d.input.read(cx).value();
        let valid = !crate::mission_conversion::trim_text(&text).is_empty()
            && text.len() <= model::TEXT_BYTES;
        let changed = d.row.text() != Some(text.as_ref()) || mode != d.row.mode;
        let unsaved = d.unsaved(self.row(id), cx);
        let restorable = !queued && d.local_text(cx).is_some();
        let discardable = self.discardable(id) && (unsaved || !queued);
        let weak = cx.weak_entity();
        // Pointer input elsewhere must not blur an active composition.
        let fence = gpui_kit::canvas(
            |_, _, _| (),
            move |_, (), w, _| {
                w.on_mouse_event(move |event: &gpui_kit::MouseDownEvent, phase, w, cx| {
                    if phase == gpui_kit::DispatchPhase::Capture
                        && weak
                            .update(cx, |v, cx| {
                                v.marked(w, cx)
                                    && v.bounds.get().is_none_or(|b| !b.contains(&event.position))
                            })
                            .unwrap_or(false)
                    {
                        cx.stop_propagation();
                    }
                });
            },
        )
        .absolute()
        .inset_0()
        .size_full();
        let bounds = self.bounds.clone();
        let mut notices = div().v_flex().gap_1().min_w_0();
        if d.row.token.is_none() {
            notices = notices.child(Notice::new("This message has no safe-edit guard. Update Local before editing or removing it.").tone(Tone::Error));
        } else if d.row.text().is_none() {
            notices = notices.child(Notice::new("Structured or attachment content is read-only here, so nothing is lost. You can still remove it."));
        }
        let acknowledged = matches!(d.outcome(), Some(Outcome::Acknowledged));
        if !available && acknowledged {
            notices = notices.child(Notice::new(
                "Saved. Cancel and reopen to edit the current version.",
            ));
        } else if !available && !blocked {
            notices = notices.child(
                Notice::new(if queued {
                    "This message changed in the queue. Your edit has not been sent. Cancel and reopen to edit the current version."
                } else {
                    "This message is no longer queued. Your edit has not been sent."
                })
                .tone(Tone::Error),
            );
        } else if d.rebased && available && !blocked {
            notices = notices.child(
                Notice::new(
                    "This message changed in the queue since your edit began. Saving replaces it.",
                )
                .tone(Tone::Warning),
            );
        }
        if let Some(outcome) = d.outcome().filter(|_| available || !acknowledged) {
            let (text, tone) = status(outcome);
            notices = notices.child(
                div()
                    .id("queued-message-result")
                    .test_support()
                    .child(Notice::new(text).tone(tone)),
            );
        }
        if let Some(e) = d.error {
            notices = notices.child(Notice::new(e).tone(Tone::Error));
        }
        if d.confirm_remove {
            notices = notices.child(Notice::new(
                "Remove this queued message? It will not be delivered.",
            ));
        }
        div()
            .id("queued-message-editor")
            .test_support()
            .relative()
            .v_flex()
            .w_full()
            .min_w_0()
            .gap_1()
            .px_1()
            .py_0p5()
            .track_focus(&self.focus)
            .key_context("QueuedMessage")
            .capture_action(cx.listener(|v, e: &gpui_kit::base::input::Enter, w, cx| {
                if e.secondary && !e.shift {
                    cx.stop_propagation();
                    v.submit(false, w, cx);
                }
            }))
            .capture_action(cx.listener(|v, _: &gpui_kit::base::input::Escape, w, cx| {
                cx.stop_propagation();
                v.dismiss(w, cx);
            }))
            // Tab is the window's focus traversal once the textarea passes it on;
            // like the composer, keep it inside an active composition.
            .capture_action(
                cx.listener(|v, _: &gpui_kit::base::input::IndentInline, w, cx| {
                    if v.marked(w, cx) {
                        cx.stop_propagation();
                    }
                }),
            )
            .capture_action(
                cx.listener(|v, _: &gpui_kit::base::input::OutdentInline, w, cx| {
                    if v.marked(w, cx) {
                        cx.stop_propagation();
                    }
                }),
            )
            .on_action(cx.listener(|v, _: &CloseQueue, w, cx| v.dismiss(w, cx)))
            .on_action(cx.listener(|v, _: &SaveQueue, w, cx| v.submit(false, w, cx)))
            .child(
                div()
                    .h_flex()
                    .items_start()
                    .gap_1()
                    .min_w_0()
                    .child(
                        ui::icon_action(
                            "queued-message-mode",
                            if mode == "steer" {
                                "During current run. Click to send after it."
                            } else {
                                "After current run. Click to steer the current run."
                            },
                            if mode == "steer" {
                                AppIcon::Steer
                            } else {
                                AppIcon::Queued
                            },
                            Action::Quiet,
                        )
                        .flex_none()
                        .selected(mode != d.row.mode)
                        .disabled(blocked || !editable || !available)
                        .on_click(cx.listener(|v, _, w, cx| v.toggle_mode(w, cx))),
                    )
                    .child(
                        div()
                            .id("queued-message-input")
                            .test_support()
                            .relative()
                            .flex_1()
                            .min_w_0()
                            .child(
                                Textarea::new(&d.input)
                                    .aria_label("Queued message text")
                                    .readonly(d.row.text().is_none())
                                    // Typing while pending is kept as newer text;
                                    // an uncertain capture is final.
                                    .disabled(matches!(d.outcome(), Some(Outcome::Unknown(_)))),
                            )
                            .child(
                                gpui_kit::canvas(
                                    |_, _, _| (),
                                    move |b, (), _, _| bounds.set(Some(b)),
                                )
                                .absolute()
                                .inset_0()
                                .size_full(),
                            ),
                    ),
            )
            .child(notices)
            .child(
                div()
                    .h_flex()
                    .gap_2()
                    .min_w_0()
                    .when(restorable, |row| {
                        row.child(
                            ui::action("queued-message-restore", "Move to composer", Action::Quiet)
                                .tooltip("Put this text in the empty message box. Nothing is sent until you press Return (steer) or ⌥Return (after the current run).")
                                .on_click(cx.listener(move |v, _, w, cx| {
                                    if !v.marked(w, cx) {
                                        cx.emit(Event::Restore(id));
                                    }
                                })),
                        )
                    })
                    .when(queued, |row| row.child(
                        ui::action(
                            "queued-message-remove",
                            if d.confirm_remove { "Remove" } else { "Remove…" },
                            // Only the confirming step is emphasized as destructive.
                            if d.confirm_remove {
                                Action::Danger
                            } else {
                                Action::Quiet
                            },
                        )
                        .tooltip("Remove this queued message. It asks once to confirm.")
                        .disabled(blocked || !available || d.row.token.is_none())
                        .on_click(cx.listener(|v, _, w, cx| v.submit(true, w, cx))),
                    ))
                    .child(
                        ui::icon_action(
                            "queued-message-copy",
                            if d.row.text().is_some() {
                                "Copy draft"
                            } else {
                                "Copy message"
                            },
                            AppIcon::Copy,
                            Action::Quiet,
                        )
                        .flex_none()
                        .on_click(cx.listener(|v, _, w, cx| v.copy(w, cx))),
                    )
                    .child(div().flex_1())
                    .when(discardable, |row| {
                        row.child(
                            ui::action("queued-message-discard", "Discard", Action::Quiet)
                                .tooltip("Drop this retained edit. Nothing is sent or removed.")
                                .on_click(cx.listener(|v, _, w, cx| v.discard_edit(w, cx))),
                        )
                    })
                    .child(
                        ui::action("queued-message-cancel", "Cancel", Action::Quiet)
                            .tooltip("Cancel. Your edit stays until you save or discard it (Escape).")
                            .on_click(cx.listener(|v, _, w, cx| v.dismiss(w, cx))),
                    )
                    .child(
                        ui::action("queued-message-save", "Save", Action::Primary)
                            .tooltip("Save this queued message (⌘Enter).")
                            .loading(matches!(d.outcome(), Some(Outcome::Pending)))
                            .disabled(blocked || !available || !editable || !valid || !changed)
                            .on_click(cx.listener(|v, _, w, cx| v.submit(false, w, cx))),
                    ),
            )
            .child(fence)
            .into_any_element()
    }
}

/// A retained draft whose row Local no longer queues: its text can go back to
/// the main composer by explicit action, never as a new send.
struct Retained {
    id: u64,
    preview: String,
    detail: &'static str,
}
impl LocalViewer {
    fn queue_form(&self, cx: &App) -> Option<Entity<Form>> {
        let chat = self.selected.as_ref()?;
        let home = self.usage_options.as_ref()?.host();
        self.queue_forms
            .iter()
            .find(|(f, _)| {
                let s = &f.read(cx).source;
                &s.chat == chat && s.home == home
            })
            .map(|(f, _)| f.clone())
    }
    /// An active composition in this chat's inline queue editor. Navigation,
    /// focus moves and root shortcuts wait for it; nothing else is blocked.
    pub(super) fn queue_marked(&self, w: &mut Window, cx: &mut Context<Self>) -> bool {
        self.queue_form(cx)
            .is_some_and(|f| f.update(cx, |f, cx| f.marked(w, cx)))
    }
    /// Whether no queue form holds user state, so update lifecycle work may
    /// proceed. An empty per-chat form is only an allocation. Pending and
    /// uncertain receipts are drafts, so they keep this false.
    #[cfg(feature = "native-probes")]
    pub(super) fn queue_checkpoint_safe(&self, cx: &App) -> bool {
        self.queue_hold_chat(cx).is_none()
    }
    /// The chat whose queue form holds an open editor or retained drafts.
    pub(super) fn queue_hold_chat(&self, cx: &App) -> Option<String> {
        self.queue_forms.iter().find_map(|(f, _)| {
            let f = f.read(cx);
            (f.editing.is_some() || !f.drafts.is_empty()).then(|| f.source.chat.clone())
        })
    }
    fn queued_message_tray(&self, w: &mut Window, cx: &mut Context<Self>) -> gpui_kit::AnyElement {
        let rows = &self.sending_view.queued;
        // Unresolved sends of a busy chat wait here, where their queue row will be.
        let pending = self.sending_view.pending_rows(self.selected.as_deref());
        let ids: Vec<u64> = rows
            .iter()
            .filter_map(crate::local_model::queued_submission)
            .collect();
        let form = self.queue_form(cx);
        let (editing, retained) = form
            .as_ref()
            .map(|f| {
                let f = f.read(cx);
                let retained = f
                    .drafts
                    .iter()
                    .filter(|(id, _)| !ids.contains(*id) && f.row(**id).is_none())
                    .map(|(id, d)| {
                        let preview = d.input.read(cx).value().replace('\n', " ");
                        Retained {
                            id: *id,
                            preview: preview.chars().take(160).collect(),
                            detail: d.error.unwrap_or(match d.outcome() {
                                Some(Outcome::Pending) => "Saving…",
                                Some(Outcome::Unknown(_)) => "Not confirmed. Nothing was retried",
                                _ => "No longer queued. Edit not sent",
                            }),
                        }
                    })
                    .collect::<Vec<_>>();
                (f.editing, retained)
            })
            .unwrap_or_default();
        if self.page != Page::Chat
            || self.selected.is_none()
            || self.artifacts_open
            || (rows.is_empty() && pending.is_empty() && retained.is_empty())
        {
            return div().hidden().into_any_element();
        }
        let disabled = !self.state.loaded || self.state.generation != self.generation;
        let mut list = div()
            .id("composer-queue-rows")
            .test_support()
            .v_flex()
            .min_w_0()
            .gap_0p5()
            .max_h(px(if editing.is_some() {
                QUEUE_EDITING_HEIGHT
            } else {
                QUEUE_VISIBLE_ROWS * (QUEUE_ROW_HEIGHT + 2.)
            }))
            .overflow_y_scroll();
        // Presentation only: steering first, then follow-ups, each in server order.
        let ordered = rows
            .iter()
            .filter(|r| r.pending() == Some("Queued to steer"))
            .map(|r| (r, true))
            .chain(pending.iter().map(|r| (r, false)))
            .chain(
                rows.iter()
                    .filter(|r| r.pending() != Some("Queued to steer"))
                    .map(|r| (r, true)),
            );
        for (row, queued) in ordered {
            if !queued {
                list = list.child(super::submit_visibility::pending_send_row(
                    row,
                    px(QUEUE_ROW_HEIGHT),
                    cx,
                ));
                continue;
            }
            let Some(id) = crate::local_model::queued_submission(row) else {
                continue;
            };
            if editing == Some(id)
                && let Some(form) = &form
            {
                list = list.child(form.clone());
                continue;
            }
            let unsaved = form.as_ref().is_some_and(|f| {
                let f = f.read(cx);
                f.drafts.get(&id).is_some_and(|d| d.unsaved(f.row(id), cx))
            });
            let preview = row
                .source()
                .chars()
                .take(160)
                .collect::<String>()
                .replace('\n', " ");
            let label = format!(
                "{}: {}{}",
                row.pending().unwrap_or("Queued"),
                row.source(),
                if unsaved { " (unsaved edit)" } else { "" }
            );
            let focus = w
                .use_keyed_state(("queue-row-actions-focus", id), cx, |_, cx| {
                    cx.focus_handle()
                })
                .read(cx)
                .clone();
            let keyboard_focused = w.last_input_was_keyboard() && focus.contains_focused(w, cx);
            list = list.child(
                div()
                    .id(SharedString::from(format!("composer-queue-row-{id}")))
                    .test_support()
                    .group("queued-message")
                    .track_focus(&focus)
                    .h_flex()
                    .w_full()
                    .min_w_0()
                    .h(px(QUEUE_ROW_HEIGHT))
                    .flex_shrink_0()
                    .child(
                        ui::action(
                            SharedString::from(format!("composer-queue-{id}")),
                            "",
                            Action::Quiet,
                        )
                        .flex_1()
                        .min_w_0()
                        .h_full()
                        .justify_start()
                        .disabled(disabled)
                        .accessibility_label(SharedString::from(label))
                        .tooltip(row.pending().unwrap_or("Queued"))
                        .px_1()
                        .child(
                            div()
                                .h_flex()
                                .w_full()
                                .min_w_0()
                                .gap_2()
                                .child(
                                    div()
                                        .id(("queue-pending", id))
                                        .test_support()
                                        .aria_label(row.pending().unwrap_or("Queued"))
                                        .text_color(cx.theme().muted_foreground)
                                        .flex_none()
                                        .child(
                                            if row.pending() == Some("Queued to steer") {
                                                AppIcon::Steer
                                            } else {
                                                AppIcon::Queued
                                            }
                                            .inline(),
                                        ),
                                )
                                .child(
                                    ui::text(Text::Body, SharedString::from(preview))
                                        .id(("queue-preview", id))
                                        .test_support()
                                        .flex_1()
                                        .min_w_0()
                                        .truncate(),
                                )
                                .when(unsaved, |r| {
                                    r.child(
                                        div()
                                            .id(("queue-unsaved", id))
                                            .test_support()
                                            .flex_none()
                                            .size(px(6.))
                                            .rounded_full()
                                            .bg(cx.theme().warning),
                                    )
                                }),
                        )
                        .on_click(
                            cx.listener(move |v, _, w, cx| v.open_queue_row(id, false, w, cx)),
                        ),
                    )
                    .child(
                        ui::icon_action(
                            SharedString::from(format!("composer-queue-edit-{id}")),
                            "Edit queued message",
                            AppIcon::Edit,
                            Action::Quiet,
                        )
                        .flex_none()
                        .disabled(disabled)
                        .when(!keyboard_focused, |b| b.opacity(0.))
                        .group_hover("queued-message", |b| b.opacity(1.))
                        .focus_visible(|b| b.opacity(1.))
                        .on_click(
                            cx.listener(move |v, _, w, cx| v.open_queue_row(id, false, w, cx)),
                        ),
                    )
                    .child(
                        ui::icon_action(
                            SharedString::from(format!("composer-queue-delete-{id}")),
                            "Delete queued message…",
                            AppIcon::Delete,
                            Action::Quiet,
                        )
                        .flex_none()
                        .disabled(disabled)
                        .when(!keyboard_focused, |b| b.opacity(0.))
                        .group_hover("queued-message", |b| b.opacity(1.))
                        .focus_visible(|b| b.opacity(1.))
                        .on_click(
                            cx.listener(move |v, _, w, cx| v.open_queue_row(id, true, w, cx)),
                        ),
                    ),
            );
        }
        for r in retained {
            let id = r.id;
            if editing == Some(id)
                && let Some(form) = &form
            {
                list = list.child(form.clone());
                continue;
            }
            list = list.child(
                ui::action(
                    SharedString::from(format!("composer-queue-retained-{id}")),
                    "",
                    Action::Quiet,
                )
                .w_full()
                .min_w_0()
                .h(px(QUEUE_ROW_HEIGHT))
                .flex_shrink_0()
                .justify_start()
                .px_1()
                .disabled(disabled)
                .accessibility_label(SharedString::from(format!("{}: {}", r.detail, r.preview)))
                .child(
                    div()
                        .h_flex()
                        .w_full()
                        .min_w_0()
                        .gap_2()
                        .child(
                            ui::text(Text::Body, SharedString::from(r.preview))
                                .text_color(cx.theme().muted_foreground)
                                .flex_1()
                                .min_w_0()
                                .truncate(),
                        )
                        .child(ui::text(Text::Caption, r.detail).flex_none()),
                )
                .on_click(cx.listener(move |v, _, w, cx| v.open_queue_row(id, false, w, cx))),
            );
        }
        div()
            .id("composer-queue")
            .test_support()
            .v_flex()
            .min_w_0()
            .px_1()
            .pt_1()
            .pb_0p5()
            .gap_0p5()
            .capture_any_mouse_down(cx.listener(|v, _, w, cx| {
                if !v.project_choices_ready(w, cx) {
                    cx.stop_propagation();
                }
            }))
            .child(list)
            .into_any_element()
    }
    fn open_queue_row(&mut self, id: u64, remove: bool, w: &mut Window, cx: &mut Context<Self>) {
        // This entry opens the inline editor or its confirmation. It never dispatches.
        if let Some(form) = self.ensure_queue_form(w, cx) {
            form.update(cx, |f, cx| f.open(id, remove, w, cx));
            cx.notify();
        }
    }
    /// Moves a retained unqueued edit into the main composer. Never sends.
    fn restore_queue_draft(&mut self, id: u64, w: &mut Window, cx: &mut Context<Self>) {
        let (Some(form), Some(chat)) = (self.queue_form(cx), self.selected.clone()) else {
            return;
        };
        let Some(text) = form.read(cx).local_text(id, cx) else {
            return;
        };
        if self
            .editor
            .update(cx, |e, cx| e.restore_queued_text(&chat, &text, w, cx))
        {
            form.update(cx, |f, cx| f.restored(id, cx));
        } else {
            form.update(cx, |f, cx| {
                f.refuse(
                    id,
                    "Can't move this into the message box now. It needs an empty, ready message box. Your edit is kept here.",
                    cx,
                )
            });
        }
        cx.notify();
    }
    pub(super) fn sync_queue(&mut self, cx: &mut Context<Self>) {
        let ready = self.page == Page::Chat
            && self.state.loaded
            && self.state.generation == self.generation
            && !self.refreshing
            && self
                .selected
                .as_ref()
                .is_some_and(|id| self.state.chats.iter().any(|c| &c.id == id && c.writable));
        for (f, _) in &self.queue_forms {
            f.update(cx, |f, cx| {
                let current = ready && self.selected.as_ref() == Some(&f.source.chat);
                let changed = f.current != current
                    || (current && !Arc::ptr_eq(&f.snapshot, &self.state.user_queue));
                f.current = current;
                if current {
                    f.snapshot = self.state.user_queue.clone();
                }
                if changed {
                    f.prune(cx);
                    cx.notify();
                }
            });
        }
    }
    fn ensure_queue_form(
        &mut self,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<Entity<Form>> {
        if !self.project_choices_ready(w, cx) {
            return None;
        }
        let (Some(chat), Some(options)) = (self.selected.clone(), self.usage_options.clone())
        else {
            return None;
        };
        if self.page != Page::Chat
            || !self.state.loaded
            || self.state.generation != self.generation
            || self.artifacts_open
        {
            return None;
        }
        if !self.editor.update(cx, |e, cx| e.capture_navigation(w, cx)) {
            return None;
        }
        if let Some(f) = self.queue_form(cx) {
            self.sync_queue(cx);
            return Some(f);
        }
        let source = Source {
            home: options.host(),
            chat,
        };
        let f = cx.new(|cx| Form::new(options, source, cx));
        let sub = cx.subscribe_in(&f, w, |v, _, e: &Event, w, cx| {
            match e {
                Event::Closed => v.editor.update(cx, |e, cx| e.focus(w, cx)),
                Event::Restore(id) => v.restore_queue_draft(*id, w, cx),
            }
            cx.notify();
        });
        self.queue_forms.push((f.clone(), sub));
        self.sync_queue(cx);
        Some(f)
    }
}
