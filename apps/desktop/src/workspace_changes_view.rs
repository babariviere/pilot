//! On-open/explicit-refresh only. Each pane owns one cancellable bounded Local reader.
use super::*;
#[path = "session_file_view_native.rs"]
mod session_file_view_native;
#[cfg(feature = "native-probes")]
#[path = "session_file_view_probe.rs"]
pub(crate) mod session_file_view_probe;
use crate::{
    ui::{self, Action, Text, Tone},
    workspace_changes::{self as model, State},
    workspace_changes_reader::{Reader, Request},
};
use gpui_kit::{AnyElement, FocusHandle, StatefulInteractiveElement};
gpui_kit::actions!(workspace_changes, [Close, Toggle]);
pub(super) struct Pane {
    file: Option<Entity<session_file_view_native::FilePane>>,
    owner: gpui_kit::WeakEntity<LocalViewer>,
    _watch: Subscription,
    chat: String,
    cwd: String,
    generation: u64,
    available: bool,
    focus: FocusHandle,
    options: Option<LocalOptions>,
    reader: Option<Reader>,
    updates: Option<Task<()>>,
    pub(super) state: State,
    expanded: Option<usize>,
    details: bool,
    scroll: gpui_kit::ScrollHandle,
}
impl Pane {
    fn current(&self, v: &LocalViewer) -> bool {
        v.page == Page::Chat
            && crate::session_file_view_reader::same_source(
                self.options.as_ref(),
                v.usage_options.as_ref(),
            )
            && !v.artifacts_open
            && v.selected.as_ref() == Some(&self.chat)
            && v.generation == self.generation
            && v.state.generation == self.generation
            && v.state.loaded
            && v.state
                .chats
                .iter()
                .any(|c| c.id == self.chat && c.cwd == self.cwd)
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
        self.state.serial += 1;
        self.state.busy = false;
    }
    fn refresh(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if !self.ready(w, cx) || self.state.busy {
            return;
        }
        self.focus.focus(w, cx);
        self.expanded = None;
        let serial = self.state.begin();
        if self.reader.is_none() {
            match self
                .options
                .clone()
                .ok_or("Changes are unavailable in fixture mode. No host queried.")
                .and_then(Reader::start)
            {
                Err(e) => {
                    self.state.accept(serial, Err(e));
                    cx.notify();
                    return;
                }
                Ok((reader, output)) => {
                    self.reader = Some(reader);
                    self.updates = Some(cx.spawn_in(w, async move |pane,cx| {
                        while let Ok(r) = output.recv().await {
                            if pane.update(cx,|p,cx| {
                                let current = p.owner.upgrade().is_some_and(|v| p.current(v.read(cx)));
                                if current && r.chat == p.chat && p.state.accept(r.generation,r.result) { cx.notify(); }
                            }).is_err() {return;}
                        }
                        let _ = pane.update(cx,|p,cx| {p.reader=None; p.state.serial+=1; p.state.busy=false; p.state.error=Some("Changes reader stopped. Retained snapshot is stale. Refresh to retry.");cx.notify();});
                    }));
                }
            }
        }
        if !self.reader.as_ref().is_some_and(|r| {
            r.request(Request {
                generation: serial,
                target: Some(self.chat.clone()),
            })
        }) {
            self.state.accept(
                serial,
                Err("Changes request could not be queued. Refresh to retry."),
            );
        }
        cx.notify();
    }
    fn close(&self, w: &mut Window, cx: &mut Context<Self>) {
        let owner = self.owner.clone();
        w.defer(cx, move |w, cx| {
            let _ = owner.update(cx, |v, cx| v.close_workspace_changes(w, cx));
        });
    }
}
impl Render for Pane {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if let Some(file) = &self.file {
            return div()
                .track_focus(&self.focus)
                .key_context("WorkspaceChanges")
                .size_full()
                .min_w_0()
                .min_h_0()
                .child(file.clone())
                .into_any_element();
        }
        let current = self
            .owner
            .upgrade()
            .is_some_and(|v| self.current(v.read(cx)));
        let mut content = div().v_flex().min_w_0();
        if !current {
            content=content.child(div().p_3().child(ui::Notice::new("Chat or Local source changed. Reopen Changes for the active chat. Retained snapshot is stale.")));
        }
        if self.state.busy {
            content = content.child(
                div()
                    .id("workspace-changes-loading")
                    .test_support()
                    .p_3()
                    .child(ui::Notice::new(if self.state.snapshot.is_some() {
                        "Refreshing. Previous snapshot retained below."
                    } else {
                        "Reading canonical chat workspace…"
                    })),
            );
        }
        if let Some(e) = self.state.error {
            content = content.child(
                div()
                    .id("workspace-changes-error")
                    .test_support()
                    .p_3()
                    .child(
                        ui::Notice::new(e)
                            .detail("Changes are unknown. Any retained snapshot below is stale.")
                            .tone(Tone::Error),
                    ),
            );
        }
        if let Some(s) = &self.state.snapshot {
            content=content.child(div().id("workspace-changes-provenance").test_support().p_3().v_flex().gap_2()
                .child(ui::text(Text::Body,format!("{} files · since {}",s.total,model::preview(&s.base))))
                .child(ui::text(Text::Caption,format!("Branch: {}",s.branch.as_deref().map(model::preview).unwrap_or_else(||"Not reported".into()))))
                .child(ui::action("workspace-changes-details",if self.details {"Hide snapshot details"} else {"Local snapshot · Details"},Action::Quiet).self_start().on_click(cx.listener(|p,_,w,cx|{p.focus.focus(w,cx);p.details = !p.details;cx.notify();})))
                .when(self.details,|d|d
                    .child(ui::text(Text::Caption,format!("Base: {}",model::display(&s.base))))
                    .child(ui::text(Text::Caption,format!("Branch: {}",s.branch.as_deref().map(model::display).unwrap_or_else(||"Not reported".into()))))
                    .child(ui::text(Text::Caption,format!("Canonical workspace for chat {}. Snapshot, not live. Base and branch reported by Local; branch may be the chat’s recorded branch. Up to 128 files, 512 KiB parsed patch, 32 KiB / 200 lines per file, 1024 bytes per line. One diff open at a time.",model::display(&self.chat))))));
            if s.limited {
                content=content.child(div().id("workspace-changes-limited").test_support().p_3().child(ui::Notice::new("Partial changes. Files or patch content omitted; not a clean workspace.")));
            }
            if s.files.is_empty() {
                content = content.child(
                    div()
                        .id("workspace-changes-empty")
                        .test_support()
                        .p_3()
                        .child(ui::text(
                            Text::Body,
                            if s.limited {
                                "No files in this partial snapshot. Changes remain unknown."
                            } else {
                                "No changes reported against this base in this snapshot."
                            },
                        )),
                );
            }
            for (ix, f) in s.files.iter().enumerate() {
                let label = format!(
                    "{} · {} · +{} −{}",
                    model::display(&f.path),
                    f.status,
                    f.additions,
                    f.deletions
                );
                let mut row = div()
                    .v_flex()
                    .min_w_0()
                    .p_3()
                    .gap_2()
                    .border_t_1()
                    .border_color(cx.theme().border)
                    .child(
                        ui::action(("workspace-change-file", ix), "", Action::Quiet)
                            .accessibility_label(SharedString::from(label))
                            .w_full()
                            .h_auto()
                            .py_2()
                            .child(
                                ui::ResourceLabel::new(model::preview(&f.path))
                                    .detail(format!(
                                        "{} · +{} −{}",
                                        f.status, f.additions, f.deletions
                                    ))
                                    .icon(AppIcon::Read),
                            )
                            .disabled(!current)
                            .selected(self.expanded == Some(ix))
                            .on_click(cx.listener(move |p, _, w, cx| {
                                if p.ready(w, cx) {
                                    p.focus.focus(w, cx);
                                    p.expanded = if p.expanded == Some(ix) {
                                        None
                                    } else {
                                        Some(ix)
                                    };
                                    cx.notify();
                                }
                            })),
                    );
                if self.expanded == Some(ix)
                    && let Some(previous) = &f.previous
                {
                    row = row.child(ui::text(
                        Text::Caption,
                        format!("Previously {}", model::display(previous)),
                    ));
                }
                if self.expanded == Some(ix) {
                    row = row.child(
                        ui::action(("workspace-open-file", ix), "Open file", Action::Quiet)
                            .self_start()
                            .disabled(
                                !current
                                    || self.state.busy
                                    || self.state.error.is_some()
                                    || self.cwd.is_empty()
                                    || f.status == "deleted"
                                    || !crate::session_file_view::valid_path(&f.path),
                            )
                            .on_click(cx.listener(move |p, _, w, cx| p.open_file(ix, w, cx))),
                    );
                    if f.status == "deleted" {
                        row = row.child(ui::text(
                            Text::Caption,
                            "Deleted in this Changes snapshot. No current file to open.",
                        ));
                    }
                    row=row.child(ui::text(Text::Caption,model::display(&f.path))).child(
                        div().id(("workspace-change-diff",ix)).test_support().min_w_0().w_full()
                            .font_family(cx.theme().mono_font_family.clone()).text_sm()
                            .child(gpui_kit::base::SelectableText::new(
                                SharedString::from(format!("workspace-patch-{ix}")),
                                SharedString::from(f.patch.as_deref().map(model::display_patch).unwrap_or_else(||"Diff unavailable within display limits (binary, metadata-only, unsupported path, missing or incomplete patch). This does not mean unchanged.".into())))));
                }
                content = content.child(row);
            }
        }
        div()
            .id("workspace-changes-pane")
            .test_support()
            .track_focus(&self.focus)
            .key_context("WorkspaceChanges")
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
                    .child(ui::text(Text::Headline, "Changes").flex_1())
                    .child(
                        ui::action("workspace-changes-refresh", "Refresh", Action::Quiet)
                            .disabled(!current || self.state.busy)
                            .on_click(cx.listener(|p, _, w, cx| p.refresh(w, cx))),
                    )
                    .child(
                        ui::icon_action(
                            "workspace-changes-close",
                            "Close changes (Escape)",
                            AppIcon::Close,
                            Action::Quiet,
                        )
                        .on_click(cx.listener(|p, _, w, cx| p.close(w, cx))),
                    ),
            )
            .child(
                div()
                    .id("workspace-changes-scroll")
                    .overflow_y_scroll()
                    .track_scroll(&self.scroll)
                    .flex_1()
                    .min_h_0()
                    .min_w_0()
                    .child(content),
            )
            .into_any_element()
    }
}
impl LocalViewer {
    pub(super) fn close_workspace_changes(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if let Some(p) = &self.workspace_changes {
            if self.editor.update(cx, |e, cx| e.marked(w, cx)) {
                return;
            }
            if p.read(cx).focus.contains_focused(w, cx) {
                self.focus_mission_chat_destination(w, cx);
            }
            self.workspace_changes = None;
            cx.notify();
        }
    }
    pub(super) fn toggle_workspace_changes(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if !self.project_choices_ready(w, cx) {
            return;
        }
        if self.workspace_changes.is_some() {
            self.close_workspace_changes(w, cx);
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
        self.close_conversation_links(w, cx);
        if self.mission_context.read(cx).visible {
            self.mission_context_toggle(w, cx);
        }
        let viewer = cx.entity();
        let cwd = self
            .state
            .chats
            .iter()
            .find(|c| c.id == chat)
            .map(|c| c.cwd.clone())
            .unwrap_or_default();
        let pane = cx.new(|cx| Pane {
            file: None,
            cwd,
            owner: viewer.downgrade(),
            _watch: cx.observe(&viewer, |p: &mut Pane, v, cx| {
                let available = p.current(v.read(cx));
                if available != p.available {
                    p.available = available;
                    if !available {
                        p.cancel();
                    }
                    cx.notify();
                }
            }),
            chat,
            generation: self.generation,
            available: true,
            focus: cx.focus_handle().tab_stop(false),
            options: self.usage_options.clone(),
            reader: None,
            updates: None,
            state: State::default(),
            expanded: None,
            details: false,
            scroll: Default::default(),
        });
        self.workspace_changes = Some(pane.clone());
        // refresh checks the owner. Do not re-enter this borrowed LocalViewer.
        w.defer(cx, move |w, cx| pane.update(cx, |p, cx| p.refresh(w, cx)));
        cx.notify();
    }
    pub(super) fn workspace_changes_action(&self, cx: &mut Context<Self>) -> Option<gpui_kit::Div> {
        let shown = self.selected.as_ref().is_some_and(|id| {
            self.state
                .chats
                .iter()
                .any(|c| &c.id == id && !c.local_draft)
        }) && !self.artifacts_open;
        shown.then(|| {
            div()
                .capture_any_mouse_down(cx.listener(|v, _, w, cx| {
                    if !v.project_choices_ready(w, cx) {
                        cx.stop_propagation();
                    }
                }))
                .child(
                    ui::action("workspace-changes-toggle", "Changes", Action::Quiet)
                        .disabled(!self.state.loaded || self.state.generation != self.generation)
                        .selected(self.workspace_changes.is_some())
                        .on_click(cx.listener(|v, _, w, cx| v.toggle_workspace_changes(w, cx))),
                )
        })
    }
    pub(super) fn workspace_changes_companion(
        &self,
        conversation: AnyElement,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
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
            .when_some(self.workspace_changes.as_ref(), |d, p| {
                d.child(
                    div()
                        .id("workspace-changes-region")
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
                        .when(side, |d| d.w(px(360.)).h_full().border_l_1())
                        .when(!side, |d| d.w_full().h(px(300.)).border_t_1())
                        .border_color(cx.theme().border)
                        .child(p.clone()),
                )
            })
            .into_any_element()
    }
}
