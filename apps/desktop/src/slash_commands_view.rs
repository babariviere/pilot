//! Composer slash command menu. A leading "/" opens it while typing; choosing completes
//! a prompt or skill, or opens a native control. Nothing is sent until the user sends.
use super::*;
use crate::slash_commands::{self as model, Action, Command, Scope};
use gpui_kit::{Focusable, ScrollHandle, Task, WeakEntity, component::Selectable};
use std::{ops::Range, sync::Arc};

/// Menu rows; type to narrow a longer list.
const LIMIT: usize = 50;

/// The exact composer text a menu or command applies to.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Capture {
    key: String,
    text: String,
    range: Range<usize>,
}

struct Menu {
    capture: Capture,
    matches: Vec<Command>,
    selected: usize,
}

#[derive(Default)]
pub(super) struct Slash {
    owner: Option<WeakEntity<crate::LocalViewer>>,
    /// The chat's prompt templates and skills, with the exact source they were read from.
    catalog: Option<(paths::Source, Arc<[Command]>)>,
    loading: Option<(paths::Source, Task<()>)>,
    failed: Option<paths::Source>,
    menu: Option<Menu>,
    /// The composer had a command token at the last refresh.
    active: bool,
    /// Escape keeps the menu closed until the text changes.
    dismissed: Option<(String, String)>,
    observed: Option<(Range<usize>, bool)>,
    scroll: ScrollHandle,
    /// Why the last command did nothing, for the chat it was typed in.
    note: Option<(String, SharedString)>,
}

fn same(a: &paths::Source, b: &paths::Source) -> bool {
    a.options.same_todo_source(&b.options)
        && a.target.chat == b.target.chat
        && a.target.generation == b.target.generation
}

impl ChatEditor {
    pub(crate) fn enable_slash(&mut self, owner: WeakEntity<crate::LocalViewer>) {
        self.slash.owner = Some(owner);
    }
    /// Reads the owning viewer, so only input, key and pointer handlers call it.
    fn slash_source(&self, key: &str, cx: &gpui_kit::App) -> Option<paths::Source> {
        let chat = key.strip_prefix("chat:")?;
        let viewer = self.slash.owner.as_ref()?.upgrade()?;
        let source = viewer.read(cx).path_completion_source()?;
        (source.target.chat == chat).then_some(source)
    }
    /// Built-ins and app controls for this composer, plus session commands read for
    /// exactly `source`. Another chat's or connection's list never applies.
    fn slash_available(&self, key: &str, source: Option<&paths::Source>) -> Option<Vec<Command>> {
        if self.diagnostic_chat() {
            return None;
        }
        let model = self.models.is_some();
        let scope = if key.starts_with("chat:") {
            Scope::Chat { model }
        } else if key.starts_with("new:") {
            Scope::NewChat { model }
        } else {
            return None;
        };
        let session = match (source, &self.slash.catalog) {
            (Some(source), Some((read, list))) if same(source, read) => &list[..],
            _ => &[],
        };
        Some(model::available(scope, session))
    }
    /// The selected draft accepts commands: writable, settled and not composing.
    fn slash_key(&mut self, w: &mut Window, cx: &mut Context<Self>) -> Option<String> {
        if !self.writable
            || !self.ready()
            || self.waiting()
            || self.questions.current.is_some()
            || self.marked(w, cx)
            || !self.draft()?.editable()
        {
            return None;
        }
        self.selected.clone()
    }
    fn slash_capture(&mut self, w: &mut Window, cx: &mut Context<Self>) -> Option<Capture> {
        let key = self.slash_key(w, cx)?;
        let input = self.text.read(cx);
        let rope = input.text();
        // Most drafts are not commands: decide that without copying the text.
        if rope.len() == 0
            || rope.byte(0) != b'/'
            || rope.len() > TEXT_CAP
            || !input.focus_handle(cx).is_focused(w)
        {
            return None;
        }
        let selection = input.selected_range();
        let text = input.value().to_string();
        let range = model::token(&text, selection)?;
        Some(Capture { key, text, range })
    }
    pub(super) fn slash_open(&self) -> bool {
        self.slash.menu.is_some()
    }
    pub(super) fn close_slash(&mut self, cx: &mut Context<Self>) {
        if self.slash.menu.take().is_some() {
            cx.notify();
        }
    }
    pub(super) fn reset_slash(&mut self, cx: &mut Context<Self>) {
        self.close_slash(cx);
        self.slash.active = false;
        self.slash.dismissed = None;
        self.slash.note = None;
    }
    pub(super) fn slash_input_changed(
        &mut self,
        w: &mut Window,
        cx: &mut Context<Self>,
        edited: bool,
    ) {
        // Cursor blink notifies the input too. Only edits and caret or preedit changes count.
        let state = (self.text.read(cx).selected_range(), self.marked(w, cx));
        if !edited && self.slash.observed.as_ref() == Some(&state) {
            return;
        }
        self.slash.observed = Some(state);
        if edited && self.slash.note.take().is_some() {
            cx.notify();
        }
        self.refresh_slash(w, cx);
    }
    fn refresh_slash(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        let Some(capture) = self.slash_capture(w, cx) else {
            self.slash.active = false;
            self.close_slash(cx);
            return;
        };
        let opening = !self.slash.active;
        self.slash.active = true;
        let source = self.slash_source(&capture.key, cx);
        if let Some(source) = source.clone() {
            let read = |s: &Option<paths::Source>| s.as_ref().is_some_and(|s| same(s, &source));
            let current = self
                .slash
                .catalog
                .as_ref()
                .is_some_and(|(s, _)| same(s, &source));
            let loading = self
                .slash
                .loading
                .as_ref()
                .is_some_and(|(s, _)| same(s, &source));
            // A failed read keeps the native commands and retries when the menu next opens.
            if !current && !loading && (opening || !read(&self.slash.failed)) {
                self.load_slash(source, w, cx);
            }
        }
        if self
            .slash
            .dismissed
            .as_ref()
            .is_some_and(|(key, text)| *key == capture.key && *text == capture.text)
        {
            self.close_slash(cx);
            return;
        }
        self.slash.dismissed = None;
        let Some(available) = self.slash_available(&capture.key, source.as_ref()) else {
            self.close_slash(cx);
            return;
        };
        let matches = model::matches(&capture.text[1..capture.range.end], &available, LIMIT);
        if matches.is_empty() {
            self.close_slash(cx);
            return;
        }
        let kept = self
            .slash
            .menu
            .as_ref()
            .and_then(|m| m.matches.get(m.selected))
            .and_then(|c| matches.iter().position(|m| m.name == c.name))
            .unwrap_or(0);
        self.slash.menu = Some(Menu {
            capture,
            matches,
            selected: kept,
        });
        self.slash.scroll.scroll_to_item(kept);
        cx.notify();
    }
    fn load_slash(&mut self, source: paths::Source, w: &mut Window, cx: &mut Context<Self>) {
        let (send, read) = async_channel::bounded(1);
        let options = source.options.clone();
        let chat = source.target.chat.clone();
        let started = std::thread::Builder::new()
            .name("session-commands-read".into())
            .spawn(move || {
                let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                else {
                    let _ = send.try_send(Err("Cannot read chat commands."));
                    return;
                };
                runtime.block_on(async {
                    tokio::select! {
                        biased;
                        _ = send.closed() => {},
                        result = crate::local_client::session_commands(&options, &chat) => {
                            let _ = send.try_send(result);
                        },
                    }
                });
            });
        if started.is_err() {
            self.slash.failed = Some(source);
            return;
        }
        let read_source = source.clone();
        let task = cx.spawn_in(w, async move |view, cx| {
            let result = read
                .recv()
                .await
                .unwrap_or(Err("Chat command reader stopped."));
            let _ = view.update_in(cx, |v, w, cx| v.slash_loaded(read_source, result, w, cx));
        });
        // Replacing an older read drops its task, which closes its channel and stops it.
        self.slash.loading = Some((source, task));
    }
    fn slash_loaded(
        &mut self,
        source: paths::Source,
        result: Result<Vec<Command>, &'static str>,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self
            .slash
            .loading
            .as_ref()
            .is_some_and(|(loading, _)| same(loading, &source))
        {
            return;
        }
        self.slash.loading = None;
        match result {
            Ok(list) => {
                self.slash.catalog = Some((source, list.into()));
                self.slash.failed = None;
            }
            Err(_) => self.slash.failed = Some(source),
        }
        if self.slash.active {
            self.refresh_slash(w, cx);
        }
        cx.notify();
    }
    pub(super) fn slash_move(&mut self, delta: isize, cx: &mut Context<Self>) {
        if let Some(menu) = &mut self.slash.menu {
            menu.selected =
                (menu.selected as isize + delta).rem_euclid(menu.matches.len() as isize) as usize;
            self.slash.scroll.scroll_to_item(menu.selected);
            cx.notify();
        }
    }
    pub(super) fn slash_dismiss(&mut self, cx: &mut Context<Self>) {
        if let Some(menu) = self.slash.menu.take() {
            self.slash.dismissed = Some((menu.capture.key, menu.capture.text));
            cx.notify();
        }
    }
    /// Enter runs a native command; Tab completes it so arguments or Enter can follow.
    /// Prompts and skills are always completed, never sent by the menu.
    pub(super) fn slash_choose_selected(
        &mut self,
        run: bool,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some((capture, name)) = self
            .slash
            .menu
            .as_ref()
            .and_then(|m| Some((m.capture.clone(), m.matches.get(m.selected)?.name.clone())))
        else {
            return;
        };
        self.slash_choose(capture, &name, run, w, cx);
    }
    fn slash_choose(
        &mut self,
        expected: Capture,
        name: &str,
        run: bool,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        // Choices apply only to the exact text, caret and chat the menu was built for.
        let current = self.slash_capture(w, cx);
        let Some(command) = self
            .slash
            .menu
            .as_ref()
            .filter(|m| m.capture == expected && current.as_ref() == Some(&expected))
            .and_then(|m| m.matches.iter().find(|c| c.name == name).cloned())
        else {
            self.close_slash(cx);
            return;
        };
        self.close_slash(cx);
        let Capture { key, text, range } = expected;
        let space = usize::from(text[range.end..].starts_with(' '));
        let range = range.start..range.end + space;
        if run && let Some(action) = command.action() {
            self.run_slash(action, Capture { key, text, range }, w, cx);
            return;
        }
        let replacement = format!("{} ", command.invocation());
        if text.len() - range.len() + replacement.len() > TEXT_CAP {
            self.slash.note = Some((key, "This command would exceed the draft limit.".into()));
            cx.notify();
            return;
        }
        self.replace_slash(&text, range, &replacement, w, cx);
    }
    fn replace_slash(
        &mut self,
        text: &str,
        range: Range<usize>,
        replacement: &str,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let utf16 =
            text[..range.start].encode_utf16().count()..text[..range.end].encode_utf16().count();
        self.text.update(cx, |input, cx| {
            input.replace_text_in_range(Some(utf16), replacement, w, cx)
        });
        self.changed(cx);
    }
    /// A whole-draft native command opens its control instead of being sent, queued or
    /// created. Returns true when the draft was a native command.
    pub(super) fn slash_submit(&mut self, w: &mut Window, cx: &mut Context<Self>) -> bool {
        let Some(key) = self.slash_key(w, cx) else {
            return false;
        };
        let text = self.text.read(cx).value().to_string();
        if !text.trim_start().starts_with('/') {
            return false;
        }
        // Submit may run inside the viewer's own update, so use the last list read for
        // this chat rather than reading the viewer.
        let source = self
            .slash
            .catalog
            .as_ref()
            .map(|(s, _)| s.clone())
            .filter(|s| key.strip_prefix("chat:") == Some(s.target.chat.as_str()));
        let Some(available) = self.slash_available(&key, source.as_ref()) else {
            return false;
        };
        let Some((command, arguments)) = model::invocation(&text, &available) else {
            return false;
        };
        let Some(action) = command.action() else {
            return false;
        };
        self.close_slash(cx);
        if !arguments.is_empty() {
            let note = format!("Use {} without arguments.", command.invocation());
            self.slash.note = Some((key, note.into()));
            cx.notify();
            return true;
        }
        let range = 0..text.len();
        self.run_slash(action, Capture { key, text, range }, w, cx);
        true
    }
    fn run_slash(
        &mut self,
        action: Action,
        capture: Capture,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if action == Action::Model {
            let result = self.open_model_menu(w, cx);
            self.finish_slash(capture, result, w, cx);
            return;
        }
        let Some(owner) = self.slash.owner.clone() else {
            self.finish_slash(capture, Err("This control isn't available here."), w, cx);
            return;
        };
        // The viewer owns these controls and their guards. Run after this update ends.
        let editor = cx.entity().downgrade();
        w.defer(cx, move |w, cx| {
            let Ok(result) =
                owner.update(cx, |v, cx| v.run_slash_action(action, &capture.key, w, cx))
            else {
                return;
            };
            let _ = editor.update(cx, |e, cx| e.finish_slash(capture, result, w, cx));
        });
    }
    /// After the control opened, remove only the exact invocation that ran.
    fn finish_slash(
        &mut self,
        capture: Capture,
        result: Result<(), &'static str>,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.selected.as_deref() != Some(capture.key.as_str()) {
            return;
        }
        match result {
            Err(reason) => {
                self.slash.note = Some((capture.key, reason.into()));
                cx.notify();
            }
            Ok(()) => {
                if self.slash_key(w, cx).is_some()
                    && self.text.read(cx).value().as_ref() == capture.text
                {
                    self.replace_slash(&capture.text, capture.range, "", w, cx);
                }
            }
        }
    }
    pub(super) fn slash_note(&self, key: &str) -> Option<SharedString> {
        self.slash
            .note
            .as_ref()
            .filter(|(k, _)| k == key)
            .map(|(_, note)| note.clone())
    }
    pub(super) fn slash_menu(&self, cx: &mut Context<Self>) -> Option<gpui_kit::AnyElement> {
        let menu = self.slash.menu.as_ref()?;
        if self.selected.as_ref() != Some(&menu.capture.key)
            || self
                .slash
                .observed
                .as_ref()
                .is_some_and(|(_, marked)| *marked)
        {
            return None;
        }
        let chat = menu.capture.key.strip_prefix("chat:");
        let reading =
            |s: Option<&paths::Source>| chat.is_some_and(|c| s.is_some_and(|s| s.target.chat == c));
        let muted = cx.theme().muted_foreground;
        let mut list = div()
            .id("slash-command-list")
            .v_flex()
            .min_w_0()
            .max_h(px(260.))
            .overflow_y_scroll()
            .track_scroll(&self.slash.scroll);
        for (i, command) in menu.matches.iter().enumerate() {
            let invocation = command.invocation();
            let label = match &command.description {
                Some(d) => format!("{invocation}. {d}"),
                None => invocation.clone(),
            };
            let capture = menu.capture.clone();
            let name = command.name.clone();
            let row = div()
                .h_flex()
                .w_full()
                .min_w_0()
                .gap_2()
                .child(div().flex_none().child(SharedString::from(invocation)))
                .children(command.argument_hint.clone().map(|hint| {
                    div()
                        .flex_none()
                        .max_w(px(160.))
                        .truncate()
                        .text_color(muted)
                        .child(SharedString::from(hint))
                }))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .text_color(muted)
                        .children(command.description.clone().map(SharedString::from)),
                );
            list = list.child(
                Button::new(SharedString::from(format!(
                    "slash-command-{}",
                    command.name
                )))
                .ghost()
                .small()
                .w_full()
                .min_w_0()
                .selected(i == menu.selected)
                .accessibility_label(SharedString::from(label))
                .child(row)
                .on_click(cx.listener(move |v, _, w, cx| {
                    v.slash_choose(capture.clone(), &name, true, w, cx)
                })),
            );
        }
        let status = if reading(self.slash.loading.as_ref().map(|(s, _)| s)) {
            "Loading commands… · "
        } else if reading(self.slash.failed.as_ref()) {
            "Chat commands unavailable · "
        } else {
            ""
        };
        let hint = "↑↓ select · Enter choose · Tab complete · Esc close";
        let root = div()
            .id("slash-commands")
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
            // Keep the editor focused, and its caret, while a row is clicked.
            .capture_any_mouse_down(cx.listener(|v, _, w, cx| {
                w.prevent_default();
                if v.marked(w, cx) {
                    cx.stop_propagation();
                }
            }))
            .child(list)
            .child(
                crate::ui::text(
                    crate::ui::Text::Caption,
                    SharedString::from(format!("{status}{hint}")),
                )
                .id("slash-commands-hint")
                .px_2()
                .pt_1()
                .text_color(muted),
            );
        #[cfg(any(test, feature = "native-probes"))]
        let root = root.test_support();
        Some(root.into_any_element())
    }
    #[cfg(any(test, feature = "native-probes"))]
    pub(crate) fn slash_probe(&self) -> Option<(Vec<String>, usize)> {
        let menu = self.slash.menu.as_ref()?;
        Some((
            menu.matches.iter().map(|c| c.name.clone()).collect(),
            menu.selected,
        ))
    }
    #[cfg(test)]
    pub(crate) fn slash_probe_note(&self) -> Option<SharedString> {
        self.slash.note.as_ref().map(|(_, n)| n.clone())
    }
    #[cfg(feature = "native-probes")]
    pub(crate) fn slash_probe_loaded(&self) -> bool {
        self.slash.catalog.is_some() && self.slash.loading.is_none()
    }
}

#[cfg(test)]
#[path = "slash_commands_view_tests.rs"]
mod tests;
