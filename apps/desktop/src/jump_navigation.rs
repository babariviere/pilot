//! Only explicit jumps reach the existing guarded navigation paths.
use super::*;
use crate::{
    jump::{Destination, Snapshot},
    jump_view::{JumpEvent, JumpPalette},
};
use gpui_kit::StatefulInteractiveElement;

impl LocalViewer {
    pub(super) fn jump_source(&self) -> Snapshot {
        Snapshot {
            reader: (self.page == Page::Chat
                && self.state.loaded
                && self.state.generation == self.generation)
                .then(|| {
                    self.selected
                        .clone()
                        .map(|chat| crate::jump::links::Reader {
                            chat,
                            generation: self.generation,
                        })
                })
                .flatten(),
            chats: self.state.chats.clone(),
            projects: self.state.projects.clone(),
            scope: self.project_scope.clone(),
            selected: self.selected.clone(),
            archive: (self.page == Page::Chat
                && self.state.list_loaded
                && (self.state.status.starts_with("Connected")
                    || self.state.status.starts_with("Synthetic")))
            .then(|| {
                self.selected.as_ref().and_then(|id| {
                    self.state
                        .chats
                        .iter()
                        .find(|chat| &chat.id == id && !chat.archived && !chat.local_draft)
                        .map(|chat| chat.id.clone())
                })
            })
            .flatten(),
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
        if self.mission_open || self.add_project_open {
            return;
        }
        if let Some(p) = self.jump.clone() {
            if !p.update(cx, |p, cx| p.marked(w, cx)) {
                self.close_jump(w, cx);
            }
            return;
        }
        if self.missions.update(cx, |m, cx| m.brief_marked(w, cx))
            || self.editor.update(cx, |e, cx| e.marked(w, cx))
            || self.queue_marked(w, cx)
            || (matches!(self.page, Page::Inbox(_))
                && !self.inbox.update(cx, |i, cx| i.prepare_jump(w, cx)))
        {
            return;
        }
        self.jump_return = w.focused(cx);
        let source = self.jump_source();
        let rows = if source.reader.is_some() {
            self.transcript.read(cx).link_snapshot_rows()
        } else {
            Vec::new()
        };
        let palette = cx.new(|cx| JumpPalette::new(source, rows, w, cx));
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
                        Destination::ArchiveChat(id) => {
                            v.jump_source().archive.as_ref() == Some(id)
                        }
                        Destination::OpenLink { reader, url } => {
                            v.jump_source().reader.as_ref() == Some(reader)
                                && crate::external_links::web(url).is_some()
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
                        Destination::ArchiveChat(id) => v.archive_current_chat(id, w, cx),
                        Destination::OpenLink { url, .. } => {
                            if let Some(url) = crate::external_links::web(&url) {
                                crate::external_links::open(&url, cx);
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
                    .child(palette),
            )
    }
}

#[cfg(test)]
#[path = "jump_shortcut_tests.rs"]
mod tests;
