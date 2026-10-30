//! Passive reading column, scoped to one immutable Local project and host.
use crate::{
    LocalOptions,
    local_model::Project,
    project_memory::{Range, State},
    project_memory_reader::{Reader, Request},
    ui::{self, Action, Notice, Space, Text, Tone},
};
use gpui_kit::{
    App, AppContext, Context, Entity, FocusHandle, InteractiveElement, IntoElement, ParentElement,
    Render, SharedString, Styled, Subscription, Task, TestSupportExt, Window,
    base::SelectableText,
    component::{
        ActiveTheme, Disableable, StyledExt,
        input::{Input, InputEvent, InputState},
        scroll::ScrollableElement,
    },
    div, px,
};

pub(crate) struct Memory {
    pub(crate) state: State,
    project: Project,
    options: Option<LocalOptions>,
    reader: Option<Reader>,
    updates: Option<Task<()>>,
    parents: Vec<Option<Range>>,
    details: bool,
    focus: FocusHandle,
    pub(crate) search: Entity<InputState>,
    _search_change: Subscription,
}
impl Memory {
    pub(crate) fn new(
        options: Option<LocalOptions>,
        project: Project,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let search =
            cx.new(|cx| InputState::new(w, cx).placeholder("Filter loaded text (case-sensitive)"));
        // Presentation only. Query edits never call load or change the browsing path.
        let search_change = cx.subscribe(&search, |_, _, event, cx| {
            if matches!(event, InputEvent::Change) {
                cx.notify();
            }
        });
        Self {
            state: State::default(),
            project,
            options,
            reader: None,
            updates: None,
            parents: Vec::new(),
            details: false,
            focus: cx.focus_handle().tab_stop(true),
            search,
            _search_change: search_change,
        }
    }
    pub(crate) fn focus(&self, w: &mut Window, cx: &mut App) {
        self.focus.focus(w, cx);
    }
    pub(crate) fn close(&mut self, cx: &mut Context<Self>) {
        self.reader = None;
        self.updates = None;
        self.state.generation += 1;
        self.state.busy = false;
        cx.notify();
    }
    pub(crate) fn load(&mut self, range: Option<Range>, w: &mut Window, cx: &mut Context<Self>) {
        let generation = self.state.begin(range);
        self.details = false;
        if self.reader.is_none() {
            match self
                .options
                .clone()
                .ok_or("Memory is available only through Local. No host was queried.")
                .and_then(|o| Reader::start(o, self.project.id.clone()))
            {
                Err(e) => {
                    self.state.accept(generation, range, Err(e));
                    cx.notify();
                    return;
                }
                Ok((reader, output)) => {
                    self.reader = Some(reader);
                    self.updates = Some(cx.spawn_in(w, async move |v, cx| {
                        while let Ok(r) = output.recv().await {
                            if v.update(cx, |v, cx| {
                                if v.state.accept(r.generation, r.range, r.result) {
                                    cx.notify();
                                }
                            })
                            .is_err()
                            {
                                return;
                            }
                        }
                        let _ = v.update(cx, |v, cx| {
                            v.reader = None;
                            v.state.busy = false;
                            v.state.error = Some("Local memory reader stopped. Refresh to retry.");
                            cx.notify();
                        });
                    }));
                }
            }
        }
        if !self.reader.as_ref().is_some_and(|r| {
            r.request(Request {
                generation,
                target: range,
            })
        }) {
            self.state.accept(
                generation,
                range,
                Err("Local memory request could not be queued. Refresh to retry."),
            );
        }
        cx.notify();
    }
    fn open(&mut self, range: Range, w: &mut Window, cx: &mut Context<Self>) {
        if self.state.busy
            || !self
                .state
                .tree
                .as_ref()
                .is_some_and(|t| t.nodes.iter().any(|n| n.range == range && range.valid()))
        {
            return;
        }
        self.parents.push(self.state.range);
        self.load(Some(range), w, cx);
        self.focus(w, cx);
    }
    fn back(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if let Some(range) = self.parents.pop() {
            self.load(range, w, cx);
            self.focus(w, cx);
        }
    }
}
impl Render for Memory {
    fn render(&mut self, _w: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let mut page = ui::page().child(
            ui::header("memory-title", "Memory", Text::Title)
                .child(ui::text(
                    Text::Body,
                    SharedString::from(format!("{} · Local", self.project.name)),
                ))
                .child(
                    ui::text(Text::Caption, "")
                        .text_color(cx.theme().muted_foreground)
                        .child(SelectableText::new(
                            "memory-project-path",
                            SharedString::from(self.project.path.clone()),
                        )),
                ),
        );
        let mut controls = div()
            .id("memory-controls")
            .test_support()
            .h_flex()
            .flex_wrap()
            .gap(px(Space::CONTROL))
            .child(
                ui::action("memory-refresh", "Refresh", Action::Quiet)
                    .disabled(self.state.busy)
                    .on_click(cx.listener(|v, _, w, cx| v.load(v.state.range, w, cx))),
            );
        if !self.parents.is_empty() {
            controls = controls.child(
                ui::action("memory-back", "Back", Action::Quiet)
                    .on_click(cx.listener(|v, _, w, cx| v.back(w, cx))),
            );
        }
        controls = controls.child(
            ui::action("memory-details", "Details", Action::Quiet).on_click(cx.listener(
                |v, _, _, cx| {
                    v.details = !v.details;
                    cx.notify();
                },
            )),
        );
        page = page.child(controls);
        let query = self.search.read(cx).value();
        page = page.child(
            div()
                .v_flex()
                .gap(px(Space::CONTROL))
                .child(
                    Input::new(&self.search)
                        .id("memory-search")
                        .aria_label("Filter loaded memory text, case-sensitive"),
                )
                .child(notice(
                    "memory-search-scope",
                    "Loaded text in this range only. Unopened notes are not searched.",
                    Tone::Quiet,
                )),
        );
        if !query.is_empty() {
            page = page.child(
                ui::action("memory-search-clear", "Clear filter", Action::Quiet)
                    .self_start()
                    .on_click(cx.listener(|v, _, w, cx| {
                        v.search.update(cx, |i, cx| {
                            i.set_value("", w, cx);
                            i.focus(w, cx);
                        });
                        cx.notify();
                    })),
            );
        }
        if let Some(range) = self.state.range {
            page = page.child(ui::heading(
                "memory-range",
                SharedString::from(format!("Notes {}", range.label())),
                Text::Headline,
            ));
        }
        if self.state.busy {
            page = page.child(notice("memory-loading", "Loading memory…", Tone::Quiet));
        }
        if let Some(e) = self.state.error {
            page = page.child(notice("memory-error", e, Tone::Error));
            if self.state.tree.is_some() {
                page = page.child(notice(
                    "memory-retained",
                    "Showing the last read for this range, not a current snapshot.",
                    Tone::Quiet,
                ));
            }
        }
        if let Some(tree) = &self.state.tree {
            if self.state.range.is_none() {
                page = page.child(
                    ui::text(
                        Text::Caption,
                        SharedString::from(format!("{} project notes", tree.count)),
                    )
                    .text_color(cx.theme().muted_foreground),
                );
            }
            if tree.count == 0 && !self.state.busy && self.state.error.is_none() {
                page = page.child(notice(
                    "memory-empty",
                    "No memories yet. Lasting project notes from agents will appear here.",
                    Tone::Quiet,
                ));
            }
            if !query.is_empty() && !self.state.busy && tree.filtered(&query).next().is_none() {
                page = page.child(notice(
                    "memory-no-matches",
                    "No matches in loaded text.",
                    Tone::Quiet,
                ));
            }
            for node in tree.filtered(&query) {
                let generation = self.state.generation;
                let range = node.range;
                let id = SharedString::from(format!("memory-node-{}-{}", range.lo, range.hi));
                let status = if node.pending {
                    "Summary not built yet"
                } else if node.replaced {
                    "Replaced"
                } else if node.entry.is_some() {
                    "Note"
                } else {
                    "Summary"
                };
                let mut row = div()
                    .id(id.clone())
                    .test_support()
                    .v_flex()
                    .min_w_0()
                    .w_full()
                    .gap(px(Space::CONTROL))
                    .py(px(Space::CONTROL))
                    .child(ui::text(
                        Text::Caption,
                        SharedString::from(format!("{} · {status}", range.label())),
                    ));
                if let Some(text) = &node.text {
                    row = row.child(
                        div()
                            .id(SharedString::from(format!("memory-text-{}", range.lo)))
                            .test_support()
                            .min_w_0()
                            .w_full()
                            .child(SelectableText::new(
                                ("memory-note-text", range.lo),
                                SharedString::from(text.clone()),
                            )),
                    );
                }
                if range.valid() {
                    row = row.child(
                        ui::action(
                            SharedString::from(format!("memory-open-{}", range.lo)),
                            "Open notes",
                            Action::Quiet,
                        )
                        .self_start()
                        .disabled(self.state.busy)
                        .accessibility_label(SharedString::from(format!(
                            "Open notes {}",
                            range.label()
                        )))
                        .on_click(cx.listener(move |v, _, w, cx| {
                            if v.state.generation == generation {
                                v.open(range, w, cx);
                            }
                        })),
                    );
                }
                if let Some(entry) = &node.entry {
                    if let Some(by) = entry.replaced_by {
                        row = row.child(ui::text(
                            Text::Caption,
                            SharedString::from(format!("Replaced by #{by}")),
                        ));
                    }
                    if self.details {
                        let origin = entry
                            .shared_origin
                            .as_ref()
                            .map_or_else(|| "Not recorded".into(), ToString::to_string);
                        let text = format!(
                            "Note {}\nOrigin chat {}\nDevice {}\nRecorded at {} ms\nCorrects {}\nShared origin {}",
                            entry.id,
                            entry.session_id,
                            entry.device_id,
                            entry.at,
                            entry.replaces.join(", "),
                            origin,
                        );
                        row = row.child(SelectableText::new(
                            ("memory-origin", range.lo),
                            SharedString::from(text),
                        ));
                    }
                }
                page = page.child(row);
            }
        }
        if self.details {
            let scope = format!(
                "Project {}. Browse only; summaries may change between reads. Origin IDs are provenance, not links to a guessed chat.",
                self.project.id,
            );
            page = page.child(notice(
                "memory-scope",
                SharedString::from(scope),
                Tone::Quiet,
            ));
        }
        div()
            .id("memory-page")
            .test_support()
            .track_focus(&self.focus)
            .size_full()
            .min_w_0()
            .bg(cx.theme().background)
            .text_color(cx.theme().foreground)
            .child(page)
            .overflow_y_scrollbar()
    }
}

fn notice(id: &'static str, text: impl Into<SharedString>, tone: Tone) -> impl IntoElement {
    div()
        .id(id)
        .test_support()
        .child(Notice::new(text).tone(tone))
}
