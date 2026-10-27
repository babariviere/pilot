//! Retained file detail nested in Changes. No editor or write capability.
use super::*;
use crate::{
    session_file_view::{Content, State as FileState},
    session_file_view_reader::{Reader as FileReader, Request as FileRequest, Target},
};

pub(super) struct FilePane {
    parent: gpui_kit::WeakEntity<Pane>,
    owner: gpui_kit::WeakEntity<LocalViewer>,
    _watch: Subscription,
    generation: u64,
    target: Target,
    options: Option<LocalOptions>,
    focus: FocusHandle,
    pub(super) state: FileState,
    reader: Option<FileReader>,
    updates: Option<Task<()>>,
    scroll: gpui_kit::ScrollHandle,
    text: SharedString,
    available: bool,
    details: bool,
}
impl FilePane {
    fn current(&self, v: &LocalViewer) -> bool {
        v.page == Page::Chat
            && crate::session_file_view_reader::same_source(
                self.options.as_ref(),
                v.usage_options.as_ref(),
            )
            && !v.artifacts_open
            && v.selected.as_ref() == Some(&self.target.chat)
            && v.generation == self.generation
            && v.state.generation == self.generation
            && v.state.loaded
            && v.state
                .chats
                .iter()
                .any(|c| c.id == self.target.chat && c.cwd == self.target.cwd && !c.local_draft)
    }
    fn ready(&self, w: &mut Window, cx: &mut Context<Self>) -> bool {
        self.owner
            .update(cx, |v, cx| {
                self.current(v) && v.project_choices_ready(w, cx)
            })
            .unwrap_or(false)
    }
    fn cancel(&mut self) {
        self.reader = None;
        self.updates = None;
        self.state.cancel();
    }
    fn refresh(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if !self.ready(w, cx) || self.state.busy {
            return;
        }
        self.focus.focus(w, cx);
        let serial = self.state.begin();
        if self.reader.is_none() {
            match self
                .options
                .clone()
                .ok_or("File reads are unavailable in fixture mode.")
                .and_then(FileReader::start)
            {
                Err(e) => {
                    self.state.accept(serial, Err(e));
                    cx.notify();
                    return;
                }
                Ok((reader, output)) => {
                    self.reader = Some(reader);
                    self.updates = Some(cx.spawn_in(w, async move |pane, cx| {
                        while let Ok(r) = output.recv().await {
                            if pane
                                .update(cx, |p, cx| {
                                    let current =
                                        p.owner.upgrade().is_some_and(|v| p.current(v.read(cx)));
                                    if current
                                        && r.target == p.target
                                        && p.state.accept(r.generation, r.result)
                                    {
                                        p.text = match &p.state.content {
                                            Some(Content::Text { shown, .. }) => {
                                                SharedString::from(shown.clone())
                                            }
                                            _ => SharedString::default(),
                                        };
                                        cx.notify();
                                    }
                                })
                                .is_err()
                            {
                                return;
                            }
                        }
                        let _ = pane.update(cx, |p, cx| {
                            p.reader = None;
                            p.state.cancel();
                            p.state.error = Some(
                                "Couldn't read the file. What's shown may be out of date; refresh to try again.",
                            );
                            cx.notify();
                        });
                    }));
                }
            }
        }
        if !self.reader.as_ref().is_some_and(|r| {
            r.request(FileRequest {
                generation: serial,
                target: Some(self.target.clone()),
            })
        }) {
            self.state.accept(
                serial,
                Err("Couldn't request the file. Refresh to try again."),
            );
        }
        cx.notify();
    }
    fn close(&self, w: &mut Window, cx: &mut Context<Self>) {
        let parent = self.parent.clone();
        w.defer(cx, move |w, cx| {
            let _ = parent.update(cx, |p, cx| p.close_file(w, cx));
        });
    }
}
impl Render for FilePane {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let current = self
            .owner
            .upgrade()
            .is_some_and(|v| self.current(v.read(cx)));
        let mut body = div().v_flex().min_w_0().gap_2();
        if !current {
            body = body.child(ui::Notice::new(
                "The chat changed. This file may be out of date; reopen Changes.",
            ));
        }
        if self.state.busy {
            body = body.child(
                div()
                    .id("session-file-loading")
                    .test_support()
                    .child(ui::Notice::new("Reading the file…")),
            );
        }
        if let Some(e) = self.state.error {
            body = body.child(
                div().id("session-file-error").test_support().child(
                    ui::Notice::new(e)
                        .detail("What's shown below may be out of date.")
                        .tone(Tone::Error),
                ),
            );
        }
        if self.details {
            body = body.child(ui::text(Text::Caption, format!(
                "Path: {}\nWorkspace: {}\nChat: {}\nSnapshot, not live. Up to 32 KiB, 300 lines, 1024 bytes per line. Reads are bracketed by Local identity/workspace checks, not an atomic filesystem revision.",
                model::display(&self.target.path), model::display(&self.target.cwd), self.target.chat
            )));
        }
        match &self.state.content {
            Some(Content::Binary) => {
                body = body.child(ui::Notice::new(
                    "Binary file. Text preview and copy are unavailable.",
                ));
            }
            Some(Content::Unsupported) => {
                body = body.child(ui::Notice::new("Unsupported text encoding or control characters. Exact text is unavailable; no replacement text displayed."));
            }
            Some(Content::Text { truncated, .. }) => {
                let completeness = if *truncated {
                    "Only the start of this file is shown. Copy includes only what's shown."
                } else {
                    "Full file."
                };
                body = body
                    .child(
                        div()
                            .id("session-file-completeness")
                            .test_support()
                            .child(ui::text(Text::Caption, completeness)),
                    )
                    .child(
                        ui::action(
                            "session-file-copy",
                            if *truncated {
                                "Copy shown portion"
                            } else {
                                "Copy file text"
                            },
                            Action::Quiet,
                        )
                        .self_start()
                        .on_click(cx.listener(|p, _, w, cx| {
                            if p.ready(w, cx) {
                                cx.write_to_clipboard(gpui_kit::ClipboardItem::new_string(
                                    p.text.to_string(),
                                ));
                            }
                        })),
                    )
                    .child(
                        div()
                            .id("session-file-text")
                            .test_support()
                            .min_w_0()
                            .font_family(cx.theme().mono_font_family.clone())
                            .text_sm()
                            .child(gpui_kit::base::SelectableText::new(
                                "session-file-exact-text",
                                self.text.clone(),
                            )),
                    );
            }
            None => {}
        }
        div()
            .id("session-file-pane")
            .test_support()
            .track_focus(&self.focus)
            .on_mouse_down(
                gpui_kit::MouseButton::Left,
                cx.listener(|p, _, w, cx| {
                    if !p.focus.contains_focused(w, cx) {
                        p.focus.focus(w, cx);
                    }
                }),
            )
            .on_action(cx.listener(|p, _: &Close, w, cx| {
                p.close(w, cx);
                cx.stop_propagation();
            }))
            .on_action(cx.listener(|p, _: &gpui_kit::base::input::Copy, w, cx| {
                if p.ready(w, cx) {
                    let text = gpui_kit::base::TextSelection::selected_text(w, cx);
                    if text.is_empty() {
                        cx.propagate();
                    } else {
                        cx.write_to_clipboard(gpui_kit::ClipboardItem::new_string(text));
                    }
                }
            }))
            .v_flex()
            .size_full()
            .min_w_0()
            .min_h_0()
            .overflow_hidden()
            .bg(ui::Surface::Sidebar.color(cx))
            .child(
                div()
                    .h_flex()
                    .px_3()
                    .py_2()
                    .gap_2()
                    .border_b_1()
                    .border_color(cx.theme().border)
                    .child(ui::text(Text::Headline, "File").flex_1())
                    .child(
                        ui::action("session-file-refresh", "Refresh", Action::Quiet)
                            .disabled(!current || self.state.busy)
                            .on_click(cx.listener(|p, _, w, cx| p.refresh(w, cx))),
                    )
                    .child(
                        ui::icon_action(
                            "session-file-close",
                            "Back to Changes (Escape)",
                            AppIcon::Close,
                            Action::Quiet,
                        )
                        .on_click(cx.listener(|p, _, w, cx| p.close(w, cx))),
                    ),
            )
            .child(
                div()
                    .px_3()
                    .py_2()
                    .v_flex()
                    .min_w_0()
                    .gap_1()
                    .child(ui::text(Text::Body, model::preview(&self.target.path)).truncate())
                    .child(
                        ui::action(
                            "session-file-details",
                            if self.details {
                                "Hide source details"
                            } else {
                                "Read-only · Details"
                            },
                            Action::Quiet,
                        )
                        .self_start()
                        .on_click(cx.listener(|p, _, w, cx| {
                            p.focus.focus(w, cx);
                            p.details = !p.details;
                            cx.notify();
                        })),
                    ),
            )
            .child(
                div()
                    .id("session-file-scroll")
                    .test_support()
                    .overflow_y_scroll()
                    .track_scroll(&self.scroll)
                    .flex_1()
                    .min_h_0()
                    .min_w_0()
                    .p_3()
                    .child(body),
            )
    }
}
impl Pane {
    pub(super) fn open_file(&mut self, ix: usize, w: &mut Window, cx: &mut Context<Self>) {
        if !self.ready(w, cx) || self.state.busy || self.state.error.is_some() {
            return;
        }
        let Some(file) = self.state.snapshot.as_ref().and_then(|s| s.files.get(ix)) else {
            return;
        };
        if !crate::session_file_view::valid_path(&file.path) || file.status == "deleted" {
            return;
        }
        if self.cwd.is_empty() {
            return;
        }
        let target = Target {
            chat: self.chat.clone(),
            cwd: self.cwd.clone(),
            path: file.path.clone(),
        };
        let parent = cx.entity().downgrade();
        let owner = self.owner.clone();
        let options = self.options.clone();
        let generation = self.generation;
        let v = self.owner.upgrade().unwrap();
        let pane = cx.new(|cx| FilePane {
            parent,
            owner,
            options,
            generation,
            target,
            _watch: cx.observe(&v, |p: &mut FilePane, v, cx| {
                let available = p.current(v.read(cx));
                if available != p.available {
                    p.available = available;
                    if !available {
                        p.cancel();
                    }
                    cx.notify();
                }
            }),
            focus: cx.focus_handle().tab_stop(false),
            state: FileState::default(),
            reader: None,
            updates: None,
            scroll: Default::default(),
            text: SharedString::default(),
            available: true,
            details: false,
        });
        self.file = Some(pane.clone());
        w.defer(cx, move |w, cx| pane.update(cx, |p, cx| p.refresh(w, cx)));
        cx.notify();
    }
    fn close_file(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        // Focus a still-mounted destination before the file subtree disappears.
        if self
            .owner
            .update(cx, |v, cx| {
                if v.editor.update(cx, |e, cx| e.marked(w, cx)) {
                    return false;
                }
                v.focus_mission_chat_destination(w, cx);
                true
            })
            .unwrap_or(false)
        {
            self.file = None;
            cx.notify();
        }
    }
}
