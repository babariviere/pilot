//! Production composer completion state. Only explicit Tab opens it; typing refines it.
use super::*;
use crate::{
    path_completion::{self as model, Capture, Target},
    path_completion_reader::{Candidates, Reader, Request},
};
use gpui_kit::{Focusable, Task, TestSupportExt, WeakEntity, component::Selectable};
#[derive(Clone)]
pub(crate) struct Source {
    pub(crate) options: crate::LocalOptions,
    pub(crate) target: Target,
}
impl Source {
    fn same(&self, other: &Self) -> bool {
        self.options.same_todo_source(&other.options) && self.target == other.target
    }
}
#[derive(Default)]
pub(super) struct Paths {
    owner: Option<WeakEntity<crate::LocalViewer>>,
    watch: Option<Subscription>,
    reader: Option<Reader>,
    updates: Option<Task<()>>,
    source: Option<Source>,
    serial: u64,
    intent: u64,
    observed: Option<(std::ops::Range<usize>, bool)>,
    capture: Option<Capture>,
    candidates: Option<Candidates>,
    error: Option<String>,
    selected: usize,
}
impl ChatEditor {
    pub(crate) fn enable_paths(
        &mut self,
        owner: WeakEntity<crate::LocalViewer>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.paths.owner = Some(owner.clone());
        if let Some(entity) = owner.upgrade() {
            self.paths.watch = Some(cx.observe_in(&entity, window, |v, _, _, cx| {
                if v.paths.source.is_none() {
                    return;
                }
                let current = v.path_source(cx);
                if v.paths
                    .source
                    .as_ref()
                    .is_some_and(|s| current.as_ref().is_none_or(|c| !s.same(c)))
                {
                    v.close_paths(cx);
                    v.paths.reader = None;
                    v.paths.updates = None;
                    v.paths.source = None;
                }
            }));
        }
    }
    fn path_source(&self, cx: &gpui_kit::App) -> Option<Source> {
        if self.diagnostic_chat() {
            return None;
        }
        self.paths
            .owner
            .as_ref()?
            .upgrade()?
            .read(cx)
            .path_completion_source()
    }
    fn path_capture(
        &mut self,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<(Source, Capture)> {
        let source = self.path_source(cx)?;
        if !self.writable
            || !self.ready()
            || self.waiting()
            || self.questions.current.is_some()
            || self.marked(w, cx)
        {
            return None;
        }
        let key = self.selected.clone()?;
        if key != format!("chat:{}", source.target.chat) || !self.draft()?.editable() {
            return None;
        }
        let input = self.text.read(cx);
        if input.text().len() > TEXT_CAP || !input.focus_handle(cx).is_focused(w) {
            return None;
        }
        let text = input.value().to_string();
        let selection = input.selected_range();
        let token = model::token(&text, selection.clone())?;
        Some((
            source.clone(),
            Capture {
                revision: self.draft()?.revision,
                target: source.target,
                key,
                intent: self.paths.intent,
                text,
                selection,
                token,
            },
        ))
    }
    pub(super) fn close_paths(&mut self, cx: &mut Context<Self>) {
        self.paths.serial = self.paths.serial.wrapping_add(1);
        if let Some(reader) = &self.paths.reader {
            reader.request(Request {
                serial: self.paths.serial,
                capture: None,
            });
        }
        let visible = self.paths.capture.take().is_some();
        self.paths.candidates = None;
        self.paths.error = None;
        if visible {
            cx.notify();
        }
    }
    pub(super) fn path_input_changed(
        &mut self,
        w: &mut Window,
        cx: &mut Context<Self>,
        force: bool,
    ) {
        // Cursor blink notifies this entity too. Never materialize text on unchanged notifications.
        let state = (self.text.read(cx).selected_range(), self.marked(w, cx));
        if !force && self.paths.observed.as_ref() == Some(&state) {
            return;
        }
        let composing = state.1;
        self.paths.observed = Some(state);
        self.paths.intent = self.paths.intent.wrapping_add(1);
        if composing && self.path_open() {
            // Keep the action guard until composition ends, but hide stale suggestions
            // and cancel reads. Escape must not reach Input's unmark-before-propagate path.
            self.paths.serial = self.paths.serial.wrapping_add(1);
            if let Some(reader) = &self.paths.reader {
                reader.request(Request {
                    serial: self.paths.serial,
                    capture: None,
                });
            }
            self.paths.candidates = None;
            cx.notify();
            return;
        }
        if let Some(previous) = self.paths.capture.clone() {
            let next = self.path_capture(w, cx);
            // Caret-only movement cancels, including away-and-back before a late click.
            if force && next.as_ref().is_some_and(|(_, c)| c.text != previous.text) {
                self.request_paths(w, cx);
            } else {
                self.close_paths(cx);
            }
        }
    }
    fn request_paths(&mut self, w: &mut Window, cx: &mut Context<Self>) -> bool {
        let Some((source, capture)) = self.path_capture(w, cx) else {
            self.close_paths(cx);
            return false;
        };
        if self.paths.source.as_ref().is_none_or(|s| !s.same(&source)) {
            self.paths.reader = None;
            self.paths.updates = None;
        }
        self.paths.source = Some(source.clone());
        if self.paths.reader.is_none() {
            match Reader::start(source.options) {
                Ok((reader, output)) => {
                    self.paths.reader = Some(reader);
                    self.paths.updates = Some(cx.spawn_in(w, async move |view, cx| {
                        while let Ok(r) = output.recv().await {
                            if view
                                .update_in(cx, |v, w, cx| {
                                    let current = v.path_capture(w, cx);
                                    if r.serial == v.paths.serial
                                        && v.paths.capture.as_ref() == Some(&r.capture)
                                        && current.as_ref().is_some_and(|(s, c)| {
                                            Some(c) == v.paths.capture.as_ref()
                                                && v.paths
                                                    .source
                                                    .as_ref()
                                                    .is_some_and(|old| old.same(s))
                                        })
                                    {
                                        match r.result {
                                            Ok(mut c) => {
                                                c.entries.retain(|entry| {
                                                    r.capture
                                                        .token
                                                        .replacement(&entry.path, entry.directory)
                                                        .is_some()
                                                });
                                                v.paths.candidates = Some(c);
                                                v.paths.error = None;
                                            }
                                            Err(e) => v.paths.error = Some(e),
                                        }
                                        v.paths.selected = 0;
                                        cx.notify();
                                    }
                                })
                                .is_err()
                            {
                                return;
                            }
                        }
                        let _ = view.update(cx, |v, cx| {
                            v.paths.reader = None;
                            v.paths.error = Some("Path completion unavailable.".into());
                            cx.notify();
                        });
                    }));
                }
                Err(e) => {
                    self.paths.error = Some(e.into());
                }
            }
        }
        self.paths.serial = self.paths.serial.wrapping_add(1);
        self.paths.capture = Some(capture.clone());
        self.paths.candidates = None;
        self.paths.selected = 0;
        self.paths.error = None;
        if !self.paths.reader.as_ref().is_some_and(|r| {
            r.request(Request {
                serial: self.paths.serial,
                capture: Some(capture),
            })
        }) {
            self.paths.error = Some("Path completion unavailable.".into());
        }
        cx.notify();
        true
    }
    fn accept_path(
        &mut self,
        captured: Capture,
        index: usize,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let current = self.path_capture(w, cx);
        if self.paths.capture.as_ref() != Some(&captured)
            || current.as_ref().is_none_or(|(s, c)| {
                c != &captured || self.paths.source.as_ref().is_none_or(|old| !s.same(old))
            })
        {
            self.close_paths(cx);
            return;
        }
        let Some(candidate) = self
            .paths
            .candidates
            .as_ref()
            .and_then(|c| c.entries.get(index))
        else {
            return;
        };
        let Some(replacement) = captured
            .token
            .replacement(&candidate.path, candidate.directory)
        else {
            return;
        };
        if captured.text.len() - captured.token.range.len() + replacement.len() > TEXT_CAP {
            self.paths.candidates = None;
            self.paths.error = Some("This path would exceed the draft limit.".into());
            cx.notify();
            return;
        }
        let range = captured.token.utf16(&captured.text);
        self.close_paths(cx);
        self.text.update(cx, |input, cx| {
            input.replace_text_in_range(Some(range), &replacement, w, cx)
        });
        self.changed(cx);
    }
    pub(super) fn path_tab(&mut self, w: &mut Window, cx: &mut Context<Self>) -> bool {
        if self.text.read(cx).text().len() > TEXT_CAP {
            self.close_paths(cx);
            return true;
        }
        if self.paths.capture.is_some() {
            self.path_accept_selected(w, cx);
            true
        } else {
            self.request_paths(w, cx)
        }
    }
    pub(super) fn path_accept_selected(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if self.marked(w, cx) {
            return;
        }
        if let Some(capture) = self.paths.capture.clone() {
            self.accept_path(capture, self.paths.selected, w, cx);
        }
    }
    pub(super) fn path_move(&mut self, delta: isize, cx: &mut Context<Self>) {
        if let Some(c) = &self.paths.candidates
            && !c.entries.is_empty()
        {
            self.paths.selected = (self.paths.selected as isize + delta)
                .rem_euclid(c.entries.len() as isize) as usize;
            cx.notify();
        }
    }
    pub(super) fn path_open(&self) -> bool {
        self.paths.capture.is_some()
    }
    pub(super) fn path_suggestions(&self, cx: &mut Context<Self>) -> Option<gpui_kit::AnyElement> {
        if self
            .paths
            .observed
            .as_ref()
            .is_some_and(|(_, marked)| *marked)
        {
            return None;
        }
        let captured = self.paths.capture.clone()?;
        let root = div()
            .id("path-suggestions")
            .absolute()
            .bottom_full()
            .left_0()
            .w_full()
            .min_w_0()
            .occlude()
            .p_1()
            .v_flex()
            .bg(cx.theme().popover)
            .border_1()
            .border_color(cx.theme().border)
            .rounded(px(crate::appearance::Radius::CARD))
            .capture_any_mouse_down(cx.listener(|v, _, w, cx| {
                w.prevent_default();
                if v.marked(w, cx) {
                    cx.stop_propagation();
                }
            }));
        #[cfg(any(test, feature = "native-probes"))]
        let root = root.test_support();
        let mut root = root;
        if let Some(candidates) = &self.paths.candidates {
            for (i, candidate) in candidates.entries.iter().enumerate() {
                let label = format!(
                    "{}{}",
                    candidate.path,
                    if candidate.directory { "/" } else { "" }
                );
                let capture = captured.clone();
                root = root.child(
                    Button::new(SharedString::from(format!(
                        "path-candidate-{}",
                        candidate.path
                    )))
                    .ghost()
                    .small()
                    .w_full()
                    .min_w_0()
                    .selected(i == self.paths.selected)
                    .accessibility_label(SharedString::from(format!("Insert path {label}")))
                    .tooltip(SharedString::from(label.clone()))
                    .child(
                        div()
                            .w_full()
                            .min_w_0()
                            .truncate()
                            .child(SharedString::from(label)),
                    )
                    .on_click(
                        cx.listener(move |v, _, w, cx| v.accept_path(capture.clone(), i, w, cx)),
                    ),
                );
            }
            let hint = if candidates.entries.is_empty() {
                "No matching paths"
            } else if candidates.truncated {
                "Limited matches · ↑↓ select · Tab/Enter insert · Esc close"
            } else {
                "↑↓ select · Tab/Enter insert · Esc close"
            };
            root = root.child(
                crate::ui::text(crate::ui::Text::Caption, hint)
                    .text_color(cx.theme().muted_foreground),
            );
        } else {
            root = root.child(
                crate::ui::text(
                    crate::ui::Text::Caption,
                    self.paths.error.as_deref().unwrap_or("Reading paths…"),
                )
                .id("path-status")
                .test_support()
                .text_color(cx.theme().muted_foreground),
            );
        }
        Some(root.into_any_element())
    }

    #[cfg(feature = "native-probes")]
    pub(crate) fn path_probe(&self) -> (Option<Capture>, usize) {
        (
            self.paths.capture.clone(),
            self.paths
                .candidates
                .as_ref()
                .map_or(0, |c| c.entries.len()),
        )
    }
    #[cfg(feature = "native-probes")]
    pub(crate) fn path_probe_accept(&mut self, c: Capture, w: &mut Window, cx: &mut Context<Self>) {
        self.accept_path(c, 0, w, cx);
    }

    #[cfg(feature = "native-probes")]
    pub(crate) fn path_probe_error(&self) -> Option<&str> {
        self.paths.error.as_deref()
    }
}
