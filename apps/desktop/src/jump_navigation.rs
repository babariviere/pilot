//! Only explicit jumps reach the existing guarded navigation paths.
use super::*;
use crate::{
    jump::{Destination, Snapshot},
    jump_view::{JumpEvent, JumpPalette},
};
use gpui_kit::{EntityInputHandler, StatefulInteractiveElement};

impl LocalViewer {
    pub(super) fn jump_source(&self) -> Snapshot {
        Snapshot {
            chats: self.state.chats.clone(),
            projects: self.state.projects.clone(),
            scope: self.project_scope.clone(),
            selected: self.selected.clone(),
            loaded: self.state.list_loaded,
            projects_error: self.state.projects_error.is_some(),
        }
    }
    pub(super) fn close_jump(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        self.jump_subscription = None;
        self.jump = None;
        if let Some(focus) = self.jump_return.take() {
            focus.focus(w, cx);
        }
        cx.notify();
    }
    pub(super) fn toggle_jump(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if self.mission_open {
            return;
        }
        if let Some(p) = self.jump.clone() {
            if !p.update(cx, |p, cx| p.marked(w, cx)) {
                self.close_jump(w, cx);
            }
            return;
        }
        let search = self.chats.read(cx).query_input();
        if search.update(cx, |q, cx| q.marked_text_range(w, cx).is_some())
            || self.editor.update(cx, |e, cx| e.marked(w, cx))
            || (matches!(self.page, Page::Inbox(_))
                && !self.inbox.update(cx, |i, cx| i.prepare_jump(w, cx)))
        {
            return;
        }
        self.jump_return = w.focused(cx);
        let source = self.jump_source();
        let palette = cx.new(|cx| JumpPalette::new(source, w, cx));
        self.jump_subscription = Some(cx.subscribe_in(&palette, w, |v, p, event, w, cx| {
            if v.jump.as_ref() != Some(p) {
                return;
            }
            match event {
                JumpEvent::Close => v.close_jump(w, cx),
                JumpEvent::Activate(destination) => {
                    if !p.read(cx).source.same(&v.jump_source()) {
                        let source = v.jump_source();
                        p.update(cx, |p, cx| p.sync(source, w, cx));
                        return;
                    }
                    // Capture exact ID first; stale rendered rows never index a new feed.
                    let destination = destination.clone();
                    let valid = match &destination {
                        Destination::Overview(id) | Destination::Project(id) => {
                            v.state.projects.iter().any(|p| &p.id == id)
                        }
                        Destination::Chat(id) => {
                            v.state.chats.iter().any(|c| &c.id == id && !c.local_draft)
                        }
                        _ => true,
                    };
                    if !valid {
                        return;
                    }
                    v.close_jump(w, cx);
                    match destination {
                        Destination::Home => v.show_home(w, cx),
                        Destination::Inbox => v.show_inbox(v.project_scope.clone(), w, cx),
                        Destination::Chats => v.show_chats(w, cx),
                        Destination::Overview(id) => v.show_project(id, w, cx),
                        Destination::Project(id) => v.focus_scope(id, w, cx),
                        Destination::Chat(id) => {
                            if let Some(chat) = v.state.chats.iter().find(|c| c.id == id).cloned() {
                                v.open(chat, w, cx);
                            }
                        }
                    }
                }
            }
        }));
        palette.update(cx, |p, cx| p.focus(w, cx));
        self.jump = Some(palette);
        cx.notify();
    }
    pub(super) fn jump_overlay(
        &self,
        palette: Entity<JumpPalette>,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let width = (f32::from(w.viewport_size().width) - 32.).clamp(200., 560.);
        let height = (f32::from(w.viewport_size().height) - 32.).clamp(160., 480.);
        div()
            .absolute()
            .inset_0()
            .occlude()
            .capture_any_mouse_down(cx.listener(|v, _, w, cx| {
                if let Some(p) = v.jump.clone()
                    && p.update(cx, |p, cx| p.marked(w, cx))
                {
                    cx.stop_propagation();
                }
            }))
            .child(
                div()
                    .id("jump-backdrop")
                    .absolute()
                    .inset_0()
                    .bg(cx.theme().background.opacity(0.88))
                    .on_click(cx.listener(|v, _, w, cx| v.close_jump(w, cx))),
            )
            .child(
                div()
                    .absolute()
                    .top(px(16.))
                    .left(px((f32::from(w.viewport_size().width) - width) / 2.))
                    .w(px(width))
                    .h(px(height))
                    .p_3()
                    .occlude()
                    .rounded(px(appearance::Radius::TRAY))
                    .bg(cx.theme().popover)
                    .border_1()
                    .border_color(cx.theme().border)
                    .child(palette),
            )
    }
}
