//! Captured loaded-window inspector. Refresh is explicit; streaming never drives a scan.
use super::*;
use crate::{
    conversation_links::{self, Snapshot, Source},
    ui::{self, Action, Text},
};
use gpui_kit::{AnyElement, ClipboardItem, FocusHandle, StatefulInteractiveElement};

gpui_kit::actions!(conversation_links, [Close, Toggle]);

pub(super) struct Pane {
    owner: gpui_kit::WeakEntity<LocalViewer>,
    _scope_watch: Subscription,
    available: bool,
    chat: String,
    generation: u64,
    focus: FocusHandle,
    snapshot: Option<Snapshot>,
    expanded: Option<usize>,
    missing_source: bool,
    scroll: gpui_kit::ScrollHandle,
    scan: Option<Task<()>>,
}
impl Pane {
    fn refresh(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        let Some(rows) = self.owner.upgrade().and_then(|v| {
            let v = v.read(cx);
            self.current(v)
                .then(|| v.transcript.read(cx).link_snapshot_rows())
        }) else {
            return;
        };
        // Refresh may unmount the currently focused Copy/Source control.
        self.focus.focus(w, cx);
        self.start(rows, cx);
    }
    fn start(&mut self, rows: Vec<Message>, cx: &mut Context<Self>) {
        self.snapshot = None;
        self.expanded = None;
        self.missing_source = false;
        let work = cx
            .background_executor()
            .spawn(async move { conversation_links::scan(rows) });
        self.scan = Some(cx.spawn(async move |this, cx| {
            let snapshot = work.await;
            let _ = this.update(cx, |this, cx| {
                this.snapshot = Some(snapshot);
                cx.notify();
            });
        }));
        cx.notify();
    }
    fn current(&self, v: &LocalViewer) -> bool {
        v.page == Page::Chat
            && !v.artifacts_open
            && v.selected.as_ref() == Some(&self.chat)
            && v.generation == self.generation
            && v.state.generation == self.generation
            && v.state.loaded
    }
    fn ready(&self, w: &mut Window, cx: &mut Context<Self>) -> bool {
        self.owner
            .update(cx, |v, cx| {
                self.current(v) && v.project_choices_ready(w, cx)
            })
            .unwrap_or(false)
    }
    fn close(&self, w: &mut Window, cx: &mut Context<Self>) {
        let owner = self.owner.clone();
        w.defer(cx, move |w, cx| {
            let _ = owner.update(cx, |v, cx| v.close_conversation_links(w, cx));
        });
    }
    pub(super) fn copy(&self, ix: usize, w: &mut Window, cx: &mut Context<Self>) {
        if self.ready(w, cx)
            && let Some(link) = self.snapshot.as_ref().and_then(|s| s.links.get(ix))
        {
            cx.write_to_clipboard(ClipboardItem::new_string(link.url.clone()));
        }
    }
    fn source(&mut self, source: &Source, w: &mut Window, cx: &mut Context<Self>) {
        if !self.ready(w, cx) {
            return;
        }
        let found = self
            .owner
            .update(cx, |v, cx| {
                // Resolve only against the current mounted window, never a numeric alias.
                v.transcript.update(cx, |t, cx| {
                    t.restore_reading(
                        crate::navigation::ReadingMark {
                            message: Some(source.key.clone()),
                            offset: 0.,
                            following: false,
                        },
                        cx,
                    )
                })
            })
            .unwrap_or(false);
        self.missing_source = !found;
        cx.notify();
    }
}
impl Render for Pane {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let mut content = div().v_flex().min_w_0();
        let current = self
            .owner
            .upgrade()
            .is_some_and(|v| self.current(v.read(cx)));
        if !current {
            content = content.child(div().p_3().child(ui::Notice::new(
                "Loaded conversation changed. Close Links and reopen it for the active window.",
            )));
        } else if let Some(snapshot) = &self.snapshot {
            if self.missing_source {
                content = content.child(div().id("conversation-links-source-missing").test_support().p_3().child(ui::Notice::new(
                    "Source is no longer uniquely loaded. Refresh Links for the current window.",
                )));
            }
            content = content.child(div().p_3().v_flex().gap_2()
                .child(ui::text(Text::Caption, SharedString::from(format!("{} {} · {} loaded message rows scanned", snapshot.links.len(), if snapshot.links.len() == 1 { "link" } else { "links" }, snapshot.scanned))))
                .child(ui::text(Text::Caption, "Loaded message snapshot, not complete history. Excludes tools, reasoning, artifacts and uncommitted streaming. Refresh for newer text."))
                .when(snapshot.limited, |d| d.child(ui::Notice::new("Scan limit reached. More loaded text or links may be omitted."))));
            if snapshot.links.is_empty() {
                content = content.child(
                    div()
                        .p_3()
                        .child(ui::text(Text::Body, "No web links in the scanned text.")),
                );
            }
            for (ix, link) in snapshot.links.iter().enumerate() {
                let mut row = div()
                    .id(("conversation-link", ix))
                    .test_support()
                    .v_flex()
                    .min_w_0()
                    .p_3()
                    .gap_2()
                    .border_t_1()
                    .border_color(cx.theme().border)
                    .child(div().min_w_0().w_full().line_clamp(3).child(
                        gpui_kit::base::SelectableText::new(
                            SharedString::from(format!("conversation-link-url-{ix}")),
                            SharedString::from(link.url.clone()),
                        ),
                    ))
                    .child(
                        div()
                            .h_flex()
                            .gap_2()
                            .child(
                                ui::action(
                                    ("conversation-link-copy", ix),
                                    "Copy link",
                                    Action::Secondary,
                                )
                                .icon(AppIcon::Copy.asset())
                                .on_click(cx.listener(move |p, _, w, cx| p.copy(ix, w, cx))),
                            )
                            .child(
                                ui::action(
                                    ("conversation-link-sources", ix),
                                    SharedString::from(format!("Sources ({})", link.sources.len())),
                                    Action::Quiet,
                                )
                                .on_click(cx.listener(
                                    move |p, _, w, cx| {
                                        p.focus.focus(w, cx);
                                        p.expanded = if p.expanded == Some(ix) {
                                            None
                                        } else {
                                            Some(ix)
                                        };
                                        cx.notify();
                                    },
                                )),
                            ),
                    );
                if self.expanded == Some(ix) {
                    for (si, source) in link.sources.iter().enumerate() {
                        let source = source.clone();
                        row = row.child(
                            ui::action(
                                SharedString::from(format!("conversation-link-source-{ix}-{si}")),
                                SharedString::from(source.label.clone()),
                                Action::Quiet,
                            )
                            .w_full()
                            .on_click(cx.listener(move |p, _, w, cx| p.source(&source, w, cx))),
                        );
                    }
                }
                content = content.child(row);
            }
        } else {
            content = content.child(div().p_3().child("Scanning loaded text…"));
        }
        div()
            .id("conversation-links-pane")
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
            .key_context("ConversationLinks")
            .on_action(cx.listener(|p, _: &gpui_kit::base::input::Copy, w, cx| {
                if !p.ready(w, cx) {
                    return;
                }
                let text = gpui_kit::base::TextSelection::selected_text(w, cx);
                if text.is_empty() {
                    cx.propagate();
                } else {
                    cx.write_to_clipboard(ClipboardItem::new_string(text));
                }
            }))
            .on_action(cx.listener(|p, _: &Close, w, cx| {
                p.close(w, cx);
                cx.stop_propagation();
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
                    .child(ui::text(Text::Headline, "Links").flex_1())
                    .child(
                        ui::action("conversation-links-refresh", "Refresh", Action::Quiet)
                            .disabled(!current || self.snapshot.is_none())
                            .on_click(cx.listener(|p, _, w, cx| {
                                if p.ready(w, cx) {
                                    p.refresh(w, cx);
                                }
                            })),
                    )
                    .child(
                        ui::icon_action(
                            "conversation-links-close",
                            "Close links (Escape)",
                            AppIcon::Close,
                            Action::Quiet,
                        )
                        .on_click(cx.listener(|p, _, w, cx| p.close(w, cx))),
                    ),
            )
            .child(
                div()
                    .id("conversation-links-scroll")
                    .overflow_y_scroll()
                    .track_scroll(&self.scroll)
                    .flex_1()
                    .min_h_0()
                    .min_w_0()
                    .child(content),
            )
    }
}
impl LocalViewer {
    pub(super) fn close_conversation_links(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if let Some(p) = &self.conversation_links {
            if self.editor.update(cx, |e, cx| e.marked(w, cx)) {
                return;
            }
            if p.read(cx).focus.contains_focused(w, cx) {
                self.focus_mission_chat_destination(w, cx);
            }
            self.conversation_links = None;
            cx.notify();
        }
    }
    pub(super) fn toggle_conversation_links(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if !self.project_choices_ready(w, cx) {
            return;
        }
        if self.conversation_links.is_some() {
            self.close_conversation_links(w, cx);
            return;
        }
        let Some(chat) = self.selected.clone().filter(|id| {
            self.state
                .chats
                .iter()
                .any(|c| &c.id == id && !c.local_draft)
        }) else {
            return;
        };
        if self.page != Page::Chat
            || self.artifacts_open
            || !self.state.loaded
            || self.state.generation != self.generation
        {
            return;
        }
        self.close_workspace_changes(w, cx);
        if self.mission_context.read(cx).visible {
            self.mission_context_toggle(w, cx);
        }
        let viewer = cx.entity();
        let owner = viewer.downgrade();
        let generation = self.generation;
        let rows = self.transcript.read(cx).link_snapshot_rows();
        let pane = cx.new(|cx| Pane {
            owner,
            _scope_watch: cx.observe(&viewer, |p: &mut Pane, v, cx| {
                let available = p.current(v.read(cx));
                if available != p.available {
                    p.available = available;
                    cx.notify();
                }
            }),
            available: true,
            chat,
            generation,
            focus: cx.focus_handle().tab_stop(false),
            snapshot: None,
            expanded: None,
            missing_source: false,
            scroll: Default::default(),
            scan: None,
        });
        pane.update(cx, |p, cx| {
            p.start(rows, cx);
            p.focus.focus(w, cx);
        });
        self.conversation_links = Some(pane);
        cx.notify();
    }
    pub(super) fn conversation_links_action(
        &self,
        cx: &mut Context<Self>,
    ) -> Option<gpui_kit::Div> {
        let local = self.selected.as_ref().is_some_and(|id| {
            self.state
                .chats
                .iter()
                .any(|c| &c.id == id && !c.local_draft)
        }) && !self.artifacts_open;
        // Absent, not an empty wrapper: header actions share one flex gap.
        local.then(|| {
            div()
                .capture_any_mouse_down(cx.listener(|v, _, w, cx| {
                    if !v.project_choices_ready(w, cx) {
                        cx.stop_propagation();
                    }
                }))
                .child(
                    ui::icon_action(
                        "conversation-links-toggle",
                        "Links (⌘⌥L)",
                        crate::app_icon::AppIcon::Links,
                        Action::Quiet,
                    )
                    .disabled(
                        self.selected.is_none()
                            || !self.state.loaded
                            || self.state.generation != self.generation
                            || self.artifacts_open,
                    )
                    .selected(self.conversation_links.is_some())
                    .on_click(cx.listener(|v, _, w, cx| v.toggle_conversation_links(w, cx))),
                )
        })
    }
    pub(super) fn conversation_links_companion(
        &self,
        conversation: AnyElement,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let pane = self.conversation_links.as_ref();
        let side = f32::from(w.viewport_size().width) >= 1100.;
        div()
            .flex()
            .items_stretch()
            .size_full()
            .min_w_0()
            .min_h_0()
            .when(side, |d| d.flex_row())
            .when(!side, |d| d.flex_col())
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .min_h_0()
                    .overflow_hidden()
                    .child(conversation),
            )
            .when_some(pane, |d, pane| {
                d.child(
                    div()
                        .id("conversation-links-region")
                        .test_support()
                        .flex_none()
                        .min_w_0()
                        .min_h_0()
                        .overflow_hidden()
                        .capture_any_mouse_down(cx.listener(|v, _, w, cx| {
                            if !v.project_choices_ready(w, cx) {
                                cx.stop_propagation();
                            }
                        }))
                        .when(side, |d| d.w(px(320.)).h_full().border_l_1())
                        .when(!side, |d| d.w_full().h(px(280.)).border_t_1())
                        .border_color(cx.theme().border)
                        .child(pane.clone()),
                )
            })
            .into_any_element()
    }
}
