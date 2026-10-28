//! Additive source-capturing header action. Never navigates or replaces the chat.
use super::*;
#[cfg(test)]
#[path = "mission_browser_navigation_tests.rs"]
mod tests;

impl LocalViewer {
    pub(super) fn focus_mission_chat_destination(
        &mut self,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        // The clicked mission control is now unmounted. Keep keyboard navigation
        // in a mounted scope, then prefer the retained composer when available.
        self.chats.update(cx, |list, cx| list.focus(w, cx));
        self.editor.update(cx, |editor, cx| editor.focus(w, cx));
    }
    pub(super) fn mission_navigation_ready(
        &mut self,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        if !self.prepare_navigation(w, cx) {
            return false;
        }
        if let Some(error) = self.editor.read(cx).resource_navigation_issue() {
            self.nav_error = Some(error);
            cx.notify();
            return false;
        }
        true
    }
    pub(super) fn show_missions(&mut self, w: &mut Window, cx: &mut Context<Self>) -> bool {
        if !self.mission_navigation_ready(w, cx) {
            return false;
        }
        self.leave_artifacts(cx);
        self.page = Page::Missions;
        self.nav_error = None;
        self.rebuild_nav(w, cx);
        self.missions.update(cx, |v, cx| v.focus(w, cx));
        self.did_navigate(cx);
        true
    }
    pub(super) fn show_mission_overview(
        &mut self,
        key: crate::mission_browser::Key,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        if !key.valid()
            || !self.missions.read(cx).contains(&key)
            || !self.mission_navigation_ready(w, cx)
        {
            return false;
        }
        self.leave_artifacts(cx);
        self.page = Page::Mission(key);
        self.nav_error = None;
        self.rebuild_nav(w, cx);
        self.missions.update(cx, |v, cx| v.focus(w, cx));
        self.did_navigate(cx);
        true
    }
    /// Opens the mission a chat summary links to: its overview when the
    /// mission list already has it, else the list, which opens it once listed
    /// or says it isn't there. Only the summary's own mission ID is used.
    pub(super) fn show_chat_mission(
        &mut self,
        mission: &str,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let key = self
            .missions
            .read(cx)
            .local_home()
            .map(|home| crate::mission_browser::Key {
                home,
                id: mission.to_owned(),
            })
            .filter(|key| key.valid());
        if let Some(key) = &key {
            if self.page == Page::Mission(key.clone()) {
                return true;
            }
            if self.missions.read(cx).contains(key) {
                return self.show_mission_overview(key.clone(), w, cx);
            }
        }
        if !self.show_missions(w, cx) {
            return false;
        }
        if let Some(key) = key {
            self.missions
                .update(cx, |v, cx| v.open_when_listed(key, cx));
        }
        true
    }
    pub(super) fn sync_missions(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        let route = match &self.page {
            Page::Missions => Some(crate::mission_reader::Route::Catalog),
            Page::Mission(key) => Some(crate::mission_reader::Route::Detail(key.clone())),
            _ => None,
        };
        let online = self.state.status.starts_with("Connected")
            || self.state.status.starts_with("Synthetic");
        self.missions.update(cx, |v, cx| {
            v.sync(
                crate::mission_browser_view::Input {
                    route,
                    filter: self.project_scope.clone(),
                    projects: self.state.projects.clone(),
                    chats: self.state.chats.clone(),
                    online,
                    loaded: self.state.list_loaded,
                },
                w,
                cx,
            )
        });
    }
    pub(super) fn can_make_mission(&self, cx: &App) -> bool {
        self.page == Page::Chat
            && !self.mission_open
            && !self.mission.read(cx).pending()
            && !self.add_project_open
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
