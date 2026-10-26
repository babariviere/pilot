//! App-owned native controls for transcript_find. See its upstream attribution.
use super::{
    TranscriptView,
    transcript_find::{self, Hit, Results},
};
use crate::{
    app_icon::AppIcon,
    model::Message,
    ui::{self, Action, Text},
};
use gpui_kit::{
    AppContext, Context, Entity, EntityInputHandler, FocusHandle, InteractiveElement, IntoElement,
    ParentElement, SharedString, StatefulInteractiveElement, Styled, Subscription, Task,
    TestSupportExt, Window,
    component::{
        ActiveTheme, Disableable, Sizable, StyledExt,
        input::{Input, InputEvent, InputState},
    },
    div, px,
};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

pub(super) struct Find {
    pub(super) focus: FocusHandle,
    input: Entity<InputState>,
    open: bool,
    reset: bool,
    generation: u64,
    results: Results,
    active: usize,
    selected: Option<Hit>,
    busy: bool,
    query_too_long: bool,
    cancel: Arc<AtomicBool>,
    task: Option<Task<()>>,
    sources: Vec<(crate::model::ReaderKey, Arc<String>)>,
    scanned_query: String,
    _change: Subscription,
}
impl Drop for Find {
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::Relaxed);
    }
}
impl Find {
    pub(super) fn new(w: &mut Window, cx: &mut Context<TranscriptView>) -> Self {
        let input = cx.new(|cx| InputState::new(w, cx).placeholder("Find source (case-sensitive)"));
        let change = cx.subscribe_in(&input, w, |v, _, event, w, cx| {
            if matches!(event, InputEvent::Change) && v.find.open && !v.find_marked(w, cx) {
                v.refresh_find(true, cx);
            }
        });
        Self {
            focus: cx.focus_handle().tab_stop(false),
            input,
            open: false,
            reset: false,
            generation: 0,
            results: Results::default(),
            active: 0,
            selected: None,
            busy: false,
            query_too_long: false,
            cancel: Arc::new(AtomicBool::new(false)),
            task: None,
            sources: Vec::new(),
            scanned_query: String::new(),
            _change: change,
        }
    }
}
impl TranscriptView {
    pub(super) fn find_is_open(&self) -> bool {
        self.find.open
    }

    #[cfg(feature = "native-probes")]
    pub(crate) fn find_probe_input(&self) -> Entity<InputState> {
        self.find.input.clone()
    }

    pub(crate) fn find_focused(&self, w: &Window, cx: &gpui_kit::App) -> bool {
        self.find.focus.contains_focused(w, cx)
    }

    pub(crate) fn open_find(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if self.find_marked(w, cx) {
            return;
        }
        self.find.reset = false;
        self.find.open = true;
        self.find.input.update(cx, |i, cx| i.focus(w, cx));
        self.refresh_find(false, cx);
        cx.notify();
    }
    pub(super) fn find_marked(&self, w: &mut Window, cx: &mut Context<Self>) -> bool {
        self.find
            .input
            .update(cx, |i, cx| i.marked_text_range(w, cx).is_some())
    }
    pub(super) fn invalidate_find(&mut self) {
        self.find.cancel.store(true, Ordering::Relaxed);
        self.find.task = None;
        self.find.generation += 1;
        self.find.results = Results::default();
        self.find.selected = None;
        self.find.sources.clear();
        self.find.scanned_query.clear();
        self.find.busy = false;
        self.find.reset = true;
    }
    pub(super) fn finish_find_reset(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if self.find.reset {
            // Same retained container is mounted in both read-only and fixture
            // views. Never restore a virtual row's potentially unmounted handle.
            if self.find.open && self.find.focus.contains_focused(w, cx) {
                self.find.focus.focus(w, cx);
            }
            self.find.open = false;
            self.find.reset = false;
            self.find.input.update(cx, |i, cx| i.set_value("", w, cx));
        }
    }
    pub(super) fn refresh_find(&mut self, navigate: bool, cx: &mut Context<Self>) {
        if !self.find.open || self.find.reset {
            return;
        }
        let query = self.find.input.read(cx).value().to_string();
        let rows: Vec<_> = self
            .transcript
            .messages()
            .iter()
            .filter(|r| transcript_find::eligible(r))
            .take(transcript_find::ROWS + 1)
            .cloned()
            .collect();
        let sources: Vec<_> = rows
            .iter()
            .map(|r| (r.reader_key().unwrap(), r.shared_source()))
            .collect();
        // Live deltas do not change committed sources. Avoid a scan/task and
        // count/marker churn when the bounded searchable window is unchanged.
        if query == self.find.scanned_query
            && sources.len() == self.find.sources.len()
            && sources
                .iter()
                .zip(&self.find.sources)
                .all(|((a, s), (b, t))| a == b && Arc::ptr_eq(s, t))
        {
            return;
        }
        self.find.sources = sources;
        self.find.scanned_query = if query.len() <= transcript_find::QUERY_BYTES {
            query.clone()
        } else {
            String::new()
        };
        let previous = self.find.selected.clone();
        self.find.cancel.store(true, Ordering::Relaxed);
        self.find.task = None;
        self.find.generation += 1;
        let generation = self.find.generation;
        let scope = self.history_scope;
        self.find.query_too_long = query.len() > transcript_find::QUERY_BYTES;
        self.find.results = Results::default();
        self.find.active = 0;
        self.find.busy = !query.is_empty() && !self.find.query_too_long;
        if !self.find.busy {
            cx.notify();
            return;
        }
        let cancel = Arc::new(AtomicBool::new(false));
        self.find.cancel = cancel.clone();
        // Cheap bounded-reader Arc captures; scanning runs off the UI thread.
        let work = cx
            .background_executor()
            .spawn(async move { transcript_find::scan(rows, &query, &cancel) });
        self.find.task = Some(cx.spawn(async move |view, cx| {
            let result = work.await;
            let _ = view.update(cx, |view, cx| {
                if !view.find.open
                    || view.find.generation != generation
                    || view.history_scope != scope
                    || view.find.reset
                {
                    return;
                }
                view.find.active = if navigate {
                    0
                } else {
                    previous
                        .and_then(|hit| result.hits.iter().position(|h| *h == hit))
                        .unwrap_or(0)
                };
                view.find.selected = result.hits.get(view.find.active).cloned();
                view.find.results = result;
                view.find.busy = false;
                // Only explicit query edits or navigation scroll. Receiving data
                // cannot move the reader or enable tail-following.
                if navigate {
                    view.navigate_find(cx);
                }
                cx.notify();
            });
        }));
        cx.notify();
    }
    fn navigate_find(&mut self, cx: &mut Context<Self>) {
        let Some(hit) = self.find.results.hits.get(self.find.active) else {
            return;
        };
        let Some(ix) = crate::model::reader_index(self.transcript.messages(), &hit.key) else {
            return;
        };
        let row = &self.transcript.messages()[ix];
        if !transcript_find::eligible(row) || row.source() != hit.source.as_str() {
            return;
        }
        self.scroller.update(cx, |s, cx| {
            s.restore_anchor(ix, px(0.), cx);
        });
        cx.notify();
    }
    fn step_find(&mut self, previous: bool, w: &mut Window, cx: &mut Context<Self>) {
        if self.find_marked(w, cx) || self.find.busy {
            return;
        }
        self.find.active =
            transcript_find::step(self.find.active, self.find.results.hits.len(), previous);
        self.find.selected = self.find.results.hits.get(self.find.active).cloned();
        self.navigate_find(cx);
    }
    fn close_find(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if self.find_marked(w, cx) {
            return;
        }
        // Deferred by Window, not Context::defer_in (which reborrows this entity).
        let view = cx.weak_entity();
        w.defer(cx, move |w, cx| {
            let _ = view.update(cx, |v, cx| {
                v.find.focus.focus(w, cx);
                v.invalidate_find();
                v.finish_find_reset(w, cx);
                cx.notify();
            });
        });
    }
    pub(super) fn find_context(&self, row: &Message) -> Option<SharedString> {
        let Hit { key, source, range } = self.find.results.hits.get(self.find.active)?;
        if !self.find.open
            || row.reader_key().as_ref() != Some(key)
            || row.source() != source.as_str()
        {
            return None;
        }
        let before: String = source[..range.start]
            .chars()
            .rev()
            .take(32)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        let after: String = source[range.end..].chars().take(32).collect();
        Some(
            format!(
                "Source match {}: …{}[{}]{}…",
                self.find.active + 1,
                before,
                &source[range.clone()],
                after
            )
            .replace(['\n', '\r'], " ")
            .into(),
        )
    }
    pub(super) fn render_find(&self, cx: &mut Context<Self>) -> Option<impl IntoElement + use<>> {
        if !self.find.open {
            return None;
        }
        let count = self.find.results.hits.len();
        let status = if self.find.query_too_long {
            "Query exceeds 1 KiB".into()
        } else if self.find.busy {
            "Searching…".into()
        } else if self.find.input.read(cx).value().is_empty() {
            String::new()
        } else if count == 0 {
            if self.find.results.limited {
                "No matches in scanned portion".into()
            } else {
                "No matches".into()
            }
        } else {
            format!(
                "{} of {}{}",
                self.find.active + 1,
                count,
                if self.find.results.limited {
                    "+ (limit)"
                } else {
                    ""
                }
            )
        };
        Some(
            div()
                .id("transcript-find")
                .test_support()
                .v_flex()
                .min_w_0()
                .px_3()
                .py_2()
                .gap_1()
                .bg(crate::appearance::tray(cx))
                .capture_any_mouse_down(cx.listener(|v, _, w, cx| {
                    if v.find_marked(w, cx) {
                        cx.stop_propagation();
                    }
                }))
                // Bound Input actions run before raw key listeners. Capture
                // them before Kit's Escape can unmark then bubble into Close.
                .capture_action(cx.listener(|v, e: &gpui_kit::base::input::Enter, w, cx| {
                    cx.stop_propagation();
                    if !e.secondary {
                        v.step_find(e.shift, w, cx);
                    }
                }))
                .capture_action(cx.listener(|v, _: &gpui_kit::base::input::Escape, w, cx| {
                    cx.stop_propagation();
                    v.close_find(w, cx);
                }))
                .capture_key_down(cx.listener(|v, e: &gpui_kit::KeyDownEvent, w, cx| {
                    if matches!(e.keystroke.key.as_str(), "enter" | "escape") {
                        cx.stop_propagation();
                        if v.find_marked(w, cx) {
                            return;
                        }
                        if e.keystroke.key == "escape" {
                            v.close_find(w, cx);
                        } else if !e.keystroke.modifiers.platform
                            && !e.keystroke.modifiers.control
                            && !e.keystroke.modifiers.alt
                        {
                            v.step_find(e.keystroke.modifiers.shift, w, cx);
                        }
                    }
                }))
                .child(
                    div()
                        .h_flex()
                        .items_center()
                        .min_w_0()
                        .gap_1()
                        .child(
                            div().flex_1().min_w_0().child(
                                Input::new(&self.find.input)
                                    .id("transcript-find-query")
                                    .small()
                                    .aria_label("Find in loaded conversation"),
                            ),
                        )
                        .child(
                            ui::icon_action(
                                "find-previous",
                                "Previous match (Shift-Enter)",
                                AppIcon::Earlier,
                                Action::Quiet,
                            )
                            .disabled(count == 0 || self.find.busy)
                            .on_click(cx.listener(|v, _, w, cx| v.step_find(true, w, cx))),
                        )
                        .child(
                            ui::icon_action(
                                "find-next",
                                "Next match (Enter)",
                                AppIcon::Latest,
                                Action::Quiet,
                            )
                            .disabled(count == 0 || self.find.busy)
                            .on_click(cx.listener(|v, _, w, cx| v.step_find(false, w, cx))),
                        )
                        .child(
                            ui::icon_action(
                                "find-close",
                                "Close find (Escape)",
                                AppIcon::Close,
                                Action::Quiet,
                            )
                            .on_click(cx.listener(|v, _, w, cx| v.close_find(w, cx))),
                        ),
                )
                .child(
                    div()
                        .h_flex()
                        .flex_wrap()
                        .gap_2()
                        .child(ui::text(Text::Caption, "Loaded messages · literal source"))
                        .child(
                            div()
                                .id("find-status")
                                .test_support()
                                .aria_label(SharedString::from(status.clone()))
                                .text_sm()
                                .text_color(cx.theme().muted_foreground)
                                .child(status),
                        ),
                ),
        )
    }
}
