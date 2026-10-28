//! Retained focused popup. Native draft and immutable operation are separate from the composer.
use super::*;
use crate::{
    queued_message::{self as model, Change, Outcome, Row, Snapshot, Source, State},
    ui::{self, Action, Notice, Text, Tone},
};
use gpui_kit::{
    ClipboardItem, EntityInputHandler, EventEmitter, FocusHandle, Focusable,
    StatefulInteractiveElement,
    component::{
        WindowExt,
        input::{InputEvent, Textarea, TextareaState},
    },
};
use std::{cell::Cell, collections::BTreeMap, rc::Rc};
gpui_kit::actions!(queued_message, [CloseQueue, SaveQueue]);
#[cfg(feature = "native-probes")]
#[path = "queued_message_probe.rs"]
pub(crate) mod probe;
// Match Swift's compact queue rows, with five visible before scrolling.
const QUEUE_ROW_HEIGHT: f32 = 26.;
const QUEUE_VISIBLE_ROWS: f32 = 5.;

/// Stable composer slot; LocalViewer retains queue data, dialogs and guarded actions.
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
pub(super) struct Closed;
struct Draft {
    row: Row,
    input: Entity<TextareaState>,
    last: String,
    mode: Option<String>,
    state: State,
    confirm_remove: bool,
    error: Option<&'static str>,
    completion: Option<Task<()>>,
}
pub(super) struct Popup {
    pub(super) source: Source,
    options: LocalOptions,
    pub(super) visible: bool,
    current: bool,
    snapshot: Arc<Snapshot>,
    selected: Option<u64>,
    drafts: BTreeMap<u64, Draft>,
    subscriptions: Vec<Subscription>,
    focus: FocusHandle,
    bounds: Rc<Cell<Option<gpui_kit::Bounds<gpui_kit::Pixels>>>>,
    error: Option<&'static str>,
}
impl EventEmitter<Closed> for Popup {}
impl Popup {
    pub(super) fn new(options: LocalOptions, source: Source, cx: &mut Context<Self>) -> Self {
        Self {
            source,
            options,
            visible: false,
            current: false,
            snapshot: Arc::default(),
            selected: None,
            drafts: BTreeMap::new(),
            subscriptions: vec![],
            focus: cx.focus_handle(),
            bounds: Default::default(),
            error: None,
        }
    }
    pub(super) fn marked(&mut self, w: &mut Window, cx: &mut Context<Self>) -> bool {
        self.visible
            && self
                .selected
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
    fn select(&mut self, row: Row, w: &mut Window, cx: &mut Context<Self>) {
        if !self.visible || !self.current || self.marked(w, cx) {
            return;
        }
        if !self.drafts.contains_key(&row.id) {
            let text = row
                .text()
                .map(str::to_owned)
                .unwrap_or_else(|| crate::local_model::queued_row(&row).source().to_owned());
            let input = cx.new(|cx| {
                let mut i = TextareaState::new(w, cx).auto_grow(3, 6);
                i.set_submit_on_enter(false, cx);
                i.set_value(text.clone(), w, cx);
                i
            });
            let id = row.id;
            self.subscriptions.push(cx.subscribe_in(&input,w,move |v,_,e,w,cx| {
                if !matches!(e,InputEvent::Change){return;}
                if let Some(d)=v.drafts.get_mut(&id) {
                    let value=d.input.read(cx).value().to_string();
                    if value.len()>model::TEXT_BYTES {
                        d.input.update(cx,|i,cx|i.set_value(d.last.clone(),w,cx));
                        d.error=Some("Edit exceeds 64 KiB and was rejected in full. Previous text retained; undo history reset.");
                    } else {d.last=value;d.error=None;}
                    d.confirm_remove=false;
                }
                cx.notify();
            }));
            self.drafts.insert(
                id,
                Draft {
                    row: row.clone(),
                    input,
                    last: text,
                    mode: None,
                    state: State::default(),
                    confirm_remove: false,
                    error: None,
                    completion: None,
                },
            );
        }
        self.selected = Some(row.id);
        let d = &self.drafts[&row.id];
        if d.row.text().is_some() && !d.state.blocked() {
            d.input.read(cx).focus_handle(cx).focus(w, cx);
        } else {
            self.focus.focus(w, cx);
        }
        cx.notify();
    }
    fn close(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if self.visible && !self.marked(w, cx) {
            cx.emit(Closed);
        }
    }
    fn submit(&mut self, remove: bool, w: &mut Window, cx: &mut Context<Self>) {
        if !self.visible || self.marked(w, cx) {
            return;
        }
        let Some(id) = self.selected else {
            return;
        };
        if !self.available(id) {
            // The rendered availability notice follows the current snapshot.
            // Do not leave a stale error behind if this exact capture reappears.
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
        if !remove
            && d.row.text() == Some(text.as_str())
            && d.mode.as_ref().is_none_or(|m| m == &d.row.mode)
        {
            return;
        }
        let change = if remove {
            Change::Remove
        } else {
            Change::Edit {
                text,
                mode: d.mode.clone(),
            }
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
        match crate::queued_message_transport::start(self.options.clone(), op.clone()) {
            Err(e) => {
                d.state.finish(&op, Outcome::NotSent(e));
            }
            Ok(output) => {
                d.completion = Some(cx.spawn(async move |v, cx| {
                    let outcome = output.recv().await.unwrap_or(Outcome::Unknown(
                        "Queue worker stopped without a receipt. Do not replay.",
                    ));
                    let _ = v.update(cx, |v, cx| {
                        if let Some(d) = v.drafts.get_mut(&id) {
                            d.state.finish(&op, outcome);
                        }
                        cx.notify();
                    });
                }));
            }
        }
        cx.notify();
    }
    fn open(form: Entity<Self>, w: &mut Window, cx: &mut App) {
        w.open_dialog(cx, {
            let form = form.clone();
            move |dialog, _, cx| {
                crate::ui::dialog(dialog, cx)
                    .title("Queued messages")
                    .w(px(520.))
                    .overlay_closable(false)
                    .close_button(false)
                    .keyboard(false)
                    .on_cancel(|_, _, _| false)
                    .child(form.clone())
            }
        });
        form.update(cx, |f, cx| f.focus.focus(w, cx));
    }
}
impl Render for Popup {
    fn render(&mut self, w: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let weak = cx.weak_entity();
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
        let mut root = div()
            .id("queued-message-popup")
            .test_support()
            .relative()
            .v_flex()
            .w_full()
            .min_w_0()
            .gap_2()
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
                v.close(w, cx);
            }))
            .on_action(cx.listener(|v, _: &CloseQueue, w, cx| v.close(w, cx)))
            .on_action(cx.listener(|v, _: &SaveQueue, w, cx| v.submit(false, w, cx)))
            .child(ui::text(
                Text::Caption,
                "Only your queued messages. Edits never become a new send.",
            ));
        if !self.current || self.snapshot.unavailable {
            root = root.child(
                Notice::new("Queue unavailable or source changed. Retained drafts are unchanged.")
                    .tone(Tone::Error),
            );
        }
        let mut list = div()
            .id("queued-message-list")
            .test_support()
            .v_flex()
            .max_h(px(136.))
            .overflow_y_scroll();
        let retained = self
            .drafts
            .values()
            .filter(|draft| !self.snapshot.rows.iter().any(|row| row.id == draft.row.id))
            .map(|draft| &draft.row);
        let current_rows = self
            .snapshot
            .rows
            .iter()
            .filter(|r| r.mode == "steer")
            .chain(self.snapshot.rows.iter().filter(|r| r.mode != "steer"));
        for row in current_rows.chain(retained) {
            let r = row.clone();
            let current = self.snapshot.rows.iter().any(|r| r.id == row.id);
            list = list.child(
                ui::action(
                    SharedString::from(format!("queued-message-row-{}", row.id)),
                    "",
                    Action::Quiet,
                )
                .w_full()
                .h(px(54.))
                .flex_shrink_0()
                .justify_start()
                .accessibility_label(SharedString::from(format!(
                    "Edit queued message: {}",
                    row.preview()
                )))
                .child(
                    ui::ResourceLabel::new(SharedString::from(row.preview())).detail(if !current {
                        "Retained draft, no longer queued"
                    } else if row.mode == "steer" {
                        "During current run"
                    } else {
                        "After current run"
                    }),
                )
                .selected(self.selected == Some(row.id))
                .on_click(cx.listener(move |v, _, w, cx| v.select(r.clone(), w, cx))),
            );
        }
        if self.snapshot.rows.is_empty() && self.drafts.is_empty() {
            list = list.child(ui::text(
                Text::Caption,
                "No user messages are currently queued.",
            ));
        }
        root = root.child(list);
        self.bounds.set(None);
        if let Some(id) = self.selected {
            let available = self.available(id);
            let d = &self.drafts[&id];
            let blocked = d.state.blocked();
            if d.row.token.is_none() {
                root=root.child(Notice::new("This captured message has no safe-edit guard. Draft retained; update Local before editing or removing it.").tone(Tone::Error));
            }
            root = root.child(ui::rule(w, cx));
            {
                let bounds = self.bounds.clone();
                root = root.child(
                    div()
                        .id("queued-message-editor")
                        .test_support()
                        .relative()
                        .w_full()
                        .min_w_0()
                        .child(
                            Textarea::new(&d.input)
                                .aria_label("Queued message text")
                                .readonly(d.row.text().is_none())
                                .disabled(blocked),
                        )
                        .child(
                            gpui_kit::canvas(|_, _, _| (), move |b, (), _, _| bounds.set(Some(b)))
                                .absolute()
                                .inset_0()
                                .size_full(),
                        ),
                );
            }
            if d.row.text().is_none() {
                root=root.child(Notice::new("This message contains structured, attachment or oversized content. Text editing is unavailable to avoid losing it. Removal still requires the exact captured version."));
            }
            if !available {
                root=root.child(Notice::new("Captured message changed or is no longer queued. Your draft has not been sent.").tone(Tone::Error));
            }
            let selected_mode = d.mode.as_deref().unwrap_or(&d.row.mode).to_owned();
            let mut delivery = div()
                .h_flex()
                .flex_wrap()
                .gap_2()
                .child(ui::text(Text::Caption, "Delivery"));
            for (mode, label) in [
                ("steer", "During current run"),
                ("followUp", "After current run"),
            ] {
                delivery = delivery.child(
                    ui::action(
                        if mode == "steer" {
                            "queued-message-steer"
                        } else {
                            "queued-message-follow-up"
                        },
                        label,
                        Action::Quiet,
                    )
                    .selected(selected_mode == mode)
                    .disabled(blocked || d.row.text().is_none() || !available)
                    .on_click(cx.listener(move |v, _, w, cx| {
                        if v.marked(w, cx) {
                            return;
                        }
                        if let Some(d) = v.drafts.get_mut(&id) {
                            d.mode = Some(mode.into());
                            d.confirm_remove = false;
                        }
                        cx.notify();
                    })),
                );
            }
            root = root.child(delivery);
            if let Some((_, outcome)) = &d.state.attempt {
                let (text, tone) = match outcome {
                    Outcome::Pending => (
                        "Saving captured operation… Closing does not cancel it.",
                        Tone::Normal,
                    ),
                    Outcome::NotSent(e) => (*e, Tone::Error),
                    Outcome::Unknown(e) => (*e, Tone::Error),
                    Outcome::Acknowledged => (
                        "Local acknowledged this exact queued-message operation.",
                        Tone::Normal,
                    ),
                };
                root = root.child(
                    div()
                        .id("queued-message-result")
                        .test_support()
                        .child(Notice::new(text).tone(tone)),
                );
            }
            if let Some(e) = d.error {
                root = root.child(Notice::new(e).tone(Tone::Error));
            }
            if d.confirm_remove {
                root=root.child(Notice::new("Remove this captured queued message? It will not be delivered. Your edit stays in this window."));
            }
            let text = d.input.read(cx).value();
            let valid = !crate::mission_conversion::trim_text(&text).is_empty()
                && text.len() <= model::TEXT_BYTES;
            let changed = d.row.text() != Some(text.as_ref()) || selected_mode != d.row.mode;
            root = root.child(
                div()
                    .h_flex()
                    .flex_wrap()
                    .gap_2()
                    .child(
                        ui::action("queued-message-save", "Save", Action::Primary)
                            .tooltip("Save this captured queued message (⌘Enter).")
                            .disabled(
                                blocked
                                    || !available
                                    || d.row.text().is_none()
                                    || d.row.token.is_none()
                                    || !valid
                                    || !changed,
                            )
                            .on_click(cx.listener(|v, _, w, cx| v.submit(false, w, cx))),
                    )
                    .child(
                        ui::action(
                            "queued-message-remove",
                            if d.confirm_remove {
                                "Confirm removal"
                            } else {
                                "Remove…"
                            },
                            Action::Danger,
                        )
                        .disabled(blocked || !available || d.row.token.is_none())
                        .on_click(cx.listener(|v, _, w, cx| v.submit(true, w, cx))),
                    )
                    .child(
                        ui::action(
                            "queued-message-copy",
                            if d.row.text().is_some() {
                                "Copy draft"
                            } else {
                                "Copy message"
                            },
                            Action::Quiet,
                        )
                        .on_click(cx.listener(move |v, _, w, cx| {
                            if v.marked(w, cx) {
                                return;
                            }
                            if let Some(d) = v.drafts.get(&id) {
                                cx.write_to_clipboard(ClipboardItem::new_string(
                                    d.input.read(cx).value().to_string(),
                                ));
                            }
                        })),
                    )
                    .child(
                        ui::action("queued-message-close", "Close", Action::Quiet)
                            .tooltip("Close and retain the draft (Escape).")
                            .on_click(cx.listener(|v, _, w, cx| v.close(w, cx))),
                    ),
            );
        }
        if let Some(e) = self.error {
            root = root.child(Notice::new(e).tone(Tone::Error));
        }
        root.child(ui::text(
            Text::Caption,
            "Drafts and receipts are retained in this window only.",
        ))
        .when(self.selected.is_none(), |r| {
            r.child(
                ui::action("queued-message-close", "Close", Action::Quiet)
                    .on_click(cx.listener(|v, _, w, cx| v.close(w, cx))),
            )
        })
        .child(fence)
    }
}
impl LocalViewer {
    fn queued_message_tray(&self, w: &mut Window, cx: &mut Context<Self>) -> gpui_kit::AnyElement {
        let rows = &self.sending_view.queued;
        let retained = self.selected.as_ref().is_some_and(|id| {
            self.queue_forms
                .iter()
                .any(|(f, _)| &f.read(cx).source.chat == id)
        });
        if self.page != Page::Chat
            || self.selected.is_none()
            || self.artifacts_open
            || (rows.is_empty() && !retained)
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
            .max_h(px(QUEUE_VISIBLE_ROWS * (QUEUE_ROW_HEIGHT + 2.)))
            .overflow_y_scroll();
        let ordered = rows
            .iter()
            .filter(|r| r.pending() == Some("Queued to steer"))
            .chain(
                rows.iter()
                    .filter(|r| r.pending() != Some("Queued to steer")),
            );
        for row in ordered {
            let id = crate::local_model::queued_submission(row).expect("projected queue row");
            let preview = row
                .source()
                .chars()
                .take(160)
                .collect::<String>()
                .replace('\n', " ");
            let label = format!("{}: {}", row.pending().unwrap_or("Queued"), row.source());
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
                                ),
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
            .children((!rows.is_empty()).then_some(list))
            .when(rows.is_empty() && retained, |tray| {
                tray.child(
                    ui::action("queued-message-open", "Queue drafts", Action::Quiet)
                        .disabled(disabled)
                        .on_click(cx.listener(|v, _, w, cx| v.open_queue(w, cx))),
                )
            })
            .into_any_element()
    }
    fn open_queue_row(&mut self, id: u64, remove: bool, w: &mut Window, cx: &mut Context<Self>) {
        self.open_queue(w, cx);
        let Some(form) = self.queue_open.clone() else {
            return;
        };
        form.update(cx, |f, cx| {
            if let Some(row) = f.snapshot.rows.iter().find(|r| r.id == id).cloned() {
                f.select(row, w, cx);
                // This entry only opens the existing confirmation. It never dispatches removal.
                if f.selected == Some(id)
                    && f.available(id)
                    && !f.marked(w, cx)
                    && let Some(d) = f.drafts.get_mut(&id).filter(|d| !d.state.blocked())
                {
                    d.confirm_remove = remove;
                    cx.notify();
                }
            }
        });
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
                    cx.notify();
                }
            });
        }
    }
    fn open_queue(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if !self.project_choices_ready(w, cx) || self.queue_open.is_some() {
            return;
        }
        let (Some(chat), Some(options)) = (self.selected.clone(), self.usage_options.clone())
        else {
            return;
        };
        if self.page != Page::Chat
            || !self.state.loaded
            || self.state.generation != self.generation
            || self.artifacts_open
        {
            return;
        }
        if !self.editor.update(cx, |e, cx| e.capture_navigation(w, cx)) {
            return;
        }
        let source = Source {
            home: options.host(),
            chat,
        };
        let form = if let Some((f, _)) = self
            .queue_forms
            .iter()
            .find(|(f, _)| f.read(cx).source == source)
        {
            f.clone()
        } else {
            let f = cx.new(|cx| Popup::new(options, source, cx));
            let sub = cx.subscribe_in(&f, w, |v, f, _: &Closed, w, cx| {
                if v.queue_open.as_ref() != Some(f) {
                    return;
                }
                let owned = f.read(cx).focus.contains_focused(w, cx);
                let moved = w.focused(cx);
                w.close_dialog(cx);
                f.update(cx, |f, cx| {
                    f.visible = false;
                    cx.notify();
                });
                v.queue_open = None;
                if owned {
                    v.focus_mission_chat_destination(w, cx);
                } else if let Some(f) = moved {
                    f.focus(w, cx);
                }
                cx.notify();
            });
            self.queue_forms.push((f.clone(), sub));
            f
        };
        self.sync_queue(cx);
        form.update(cx, |f, cx| {
            f.visible = true;
            cx.notify();
        });
        self.queue_open = Some(form.clone());
        Popup::open(form, w, cx);
        cx.notify();
    }
}
