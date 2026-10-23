//! Additive source-capturing header action. Never navigates or replaces the chat.
use super::*;

impl LocalViewer {
    pub(super) fn can_make_mission(&self, cx: &App) -> bool {
        self.page == Page::Chat
            && !self.mission_open
            && self
                .selected
                .as_ref()
                .and_then(|id| self.state.chats.iter().find(|chat| &chat.id == id))
                .is_some_and(|chat| {
                    !chat.local_draft
                        && chat.project_id.as_ref().is_some_and(|project| {
                            self.mission.read(cx).receipt_access(&chat.id, project)
                                || (chat.writable
                                    && self.writer.is_some()
                                    && self.editor.read(cx).ready())
                        })
                })
    }
    pub(super) fn open_mission(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.can_make_mission(cx) {
            return;
        }
        if self
            .editor
            .update(cx, |editor, cx| editor.marked(window, cx))
        {
            return;
        }
        let Some(chat) = self
            .selected
            .as_ref()
            .and_then(|id| self.state.chats.iter().find(|chat| &chat.id == id))
            .cloned()
        else {
            return;
        };
        let Some(project) = chat.project_id else {
            return;
        };
        // Receipt inspection is not creation or navigation. Keep it accessible
        // when private writes/editor readiness fail, without capturing a draft.
        if !self.mission.read(cx).receipt_access(&chat.id, &project)
            && (!self.project_choices_ready(window, cx)
                || !self
                    .editor
                    .update(cx, |editor, cx| editor.capture_navigation(window, cx)))
        {
            return;
        }
        self.projects_open = false;
        self.mission_return = window.focused(cx);
        self.mission_open = true;
        self.mission.update(cx, |form, cx| {
            form.open(
                crate::mission_conversion::Target {
                    source: chat.id,
                    project,
                    generation: self.generation,
                },
                &chat.title,
                window,
                cx,
            )
        });
        cx.notify();
    }
    pub(super) fn mission_overlay(
        &self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let width = (f32::from(window.viewport_size().width) - 32.).clamp(200., 560.);
        let height = (f32::from(window.viewport_size().height) - 32.).clamp(160., 620.);
        div()
            .id("mission-overlay")
            .test_support()
            .absolute()
            .inset_0()
            .occlude()
            .capture_any_mouse_down(cx.listener(|v, _, w, cx| {
                if v.mission.update(cx, |f, cx| f.marked(w, cx)) {
                    cx.stop_propagation();
                }
            }))
            .child(
                div()
                    .absolute()
                    .inset_0()
                    .bg(cx.theme().background.opacity(0.88)),
            )
            .child(
                div()
                    .id("mission-sheet")
                    .test_support()
                    .absolute()
                    .top(px(16.))
                    .left(px((f32::from(window.viewport_size().width) - width) / 2.))
                    .w(px(width))
                    .h(px(height))
                    .p_4()
                    .rounded(px(appearance::Radius::TRAY))
                    .bg(crate::ui::Surface::Card.color(cx))
                    .border_1()
                    .border_color(cx.theme().border)
                    .occlude()
                    .child(self.mission.clone()),
            )
    }
}
