use super::*;
use crate::navigation::{
    Cache, HISTORY_CAP, History, Location, ReadingMark, SCOPE_CAP, ScopeState, Target,
};
use gpui_kit::EntityInputHandler;

impl LocalViewer {
    pub(super) fn location(&self, cx: &App) -> Location {
        let target = match &self.page {
            Page::Home => Target::Home,
            Page::Missions => Target::Missions,
            Page::Mission(key) => Target::Mission(key.clone()),
            Page::Inbox(filter) => Target::Inbox(filter.clone()),
            Page::Project(id) => Target::Project(id.clone()),
            Page::Chat => {
                if let Some(id) = &self.selected {
                    Target::Chat(id.clone())
                } else if let Some(key) = self
                    .editor
                    .read(cx)
                    .navigation_key()
                    .filter(|k| k.starts_with("new:"))
                {
                    Target::Draft(key.into())
                } else {
                    Target::Empty
                }
            }
        };
        Location {
            scope: self.project_scope.clone(),
            target,
        }
    }
    /// Tells the composer which new-chat slot is on screen, so a slot left empty is removed.
    pub(super) fn sync_visible_draft(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let shown = match self.location(cx).target {
            Target::Draft(key) => Some(key),
            _ => None,
        };
        self.editor
            .update(cx, |e, cx| e.show_draft(shown, window, cx));
    }
    pub(super) fn navigation_state() -> (
        History,
        Cache<Option<String>, ScopeState>,
        Cache<String, ReadingMark>,
    ) {
        (
            History::new(Location::home()),
            Cache::new(SCOPE_CAP),
            Cache::new(HISTORY_CAP),
        )
    }
    pub(super) fn prepare_navigation(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        self.link_epoch += 1;
        // A resource search is newer user intent. Only its explicit activation
        // closes the palette before entering these existing guarded routes.
        if self.jump.is_some()
            || self.mission_open
            || self.add_project_open
            || self.queue_marked(window, cx)
        {
            return false;
        }
        if self.missions.update(cx, |m, cx| m.brief_marked(window, cx)) {
            return false;
        }
        if self.restoring_navigation {
            self.close_conversation_links(window, cx);
            self.close_workspace_changes(window, cx);
            return true;
        }
        let query = self.chats.read(cx).query_input();
        if query.update(cx, |q, cx| q.marked_text_range(window, cx).is_some())
            || !self
                .editor
                .update(cx, |e, cx| e.capture_navigation(window, cx))
        {
            return false;
        }
        self.close_conversation_links(window, cx);
        self.close_workspace_changes(window, cx);
        if self.subagent.take().is_some()
            && let Some(chat) = self
                .state
                .chats
                .iter()
                .find(|c| Some(&c.id) == self.selected.as_ref())
        {
            self.editor.update(cx, |e, cx| {
                e.select(
                    format!("chat:{}", chat.id),
                    chat.writable,
                    chat.busy,
                    window,
                    cx,
                )
            });
        }
        if self.session_failure_focus.contains_focused(window, cx) {
            self.focus_mission_chat_destination(window, cx);
        }
        let location = self.location(cx);
        if !self.navigation_seeded {
            self.navigation = History::new(location.clone());
            self.navigation_seeded = true;
        } else {
            self.navigation.record(location);
        }
        self.save_scope(cx);
        if self.page == Page::Chat
            && !self.refreshing
            && self.state.loaded
            && self.state.generation == self.generation
            && let Some(id) = &self.selected
            && let Some(mark) = self.transcript.read(cx).reading_mark(cx)
        {
            self.reader_marks.put(id.clone(), mark);
        }
        true
    }
    #[cfg(feature = "native-probes")]
    pub(crate) fn brief_fixture_setup(
        &mut self,
        options: LocalOptions,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) -> Entity<crate::mission_browser_view::Browser> {
        self.state.status = "Synthetic Local brief workspace".into();
        self.state.projects=Arc::new(crate::local_model::projects(&serde_json::json!([{"id":"project-A","name":"Synthetic brief project","path":"/synthetic/A"}])).unwrap());
        self.state.projects_loaded = true;
        self.state.list_loaded = true;
        self.missions.update(cx, |m, _| m.options(options));
        self.page = Page::Missions;
        self.rebuild_nav(w, cx);
        cx.notify();
        self.missions.clone()
    }
    #[cfg(feature = "native-probes")]
    pub(crate) fn brief_fixture_bits(&self) -> (bool, bool, bool, bool) {
        (
            matches!(self.page, Page::Mission(_)),
            self.jump.is_some(),
            self.settings_window.is_some(),
            self.projects_open,
        )
    }
    #[cfg(feature = "native-probes")]
    pub(crate) fn brief_fixture_restoring_guard(
        &mut self,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        self.restoring_navigation = true;
        let allowed = self.prepare_navigation(w, cx);
        self.restoring_navigation = false;
        allowed
    }
    #[cfg(feature = "native-probes")]
    pub(crate) fn brief_fixture_close_settings(&mut self, cx: &mut Context<Self>) {
        if let Some(h) = self.settings_window.take() {
            let _ = h.update(cx, |_, w, _| w.remove_window());
        }
    }
    pub(super) fn save_scope(&mut self, cx: &App) {
        let list = self.chats.read(cx);
        let d = list.delegate();
        let state = ScopeState {
            target: Some(self.location(cx).target),
            query: crate::navigation::bounded_query(list.query_input().read(cx).value().as_ref()),
            archived: d.archived,
            selected: d.selected.and_then(|ix| d.at(ix)).map(|c| c.id.clone()),
            sidebar_y: f32::from(list.scroll_handle().offset().y),
            overview_y: self.overview.read(cx).scroll_position(),
        };
        self.scope_states.put(self.project_scope.clone(), state);
    }
    pub(super) fn did_navigate(&mut self, cx: &mut Context<Self>) {
        if !self.restoring_navigation {
            self.navigation.record(self.location(cx));
            self.save_scope(cx);
        }
        cx.notify();
    }
    pub(super) fn change_scope(
        &mut self,
        scope: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if scope == self.project_scope {
            return;
        }
        let saved = self.scope_states.get(&scope).cloned().unwrap_or_default();
        self.project_scope = scope;
        self.rebuild_nav(window, cx);
        self.chats.update(cx, |list, cx| {
            list.delegate_mut().archived = saved.archived;
            list.restore_query(&saved.query, window, cx);
            let ix = saved
                .selected
                .as_ref()
                .and_then(|id| list.delegate().index(id));
            list.set_selected_index(ix, window, cx);
            list.scroll_handle().restore_offset(gpui_kit::point(
                px(0.),
                px(crate::navigation::offset(saved.sidebar_y)),
            ));
            cx.notify();
        });
        self.overview
            .update(cx, |v, cx| v.restore_scroll(saved.overview_y, cx));
    }
    pub(super) fn can_restore(&self, location: &Location, cx: &App) -> bool {
        if let Some(scope) = &location.scope
            && !self.state.projects.iter().any(|p| &p.id == scope)
        {
            return false;
        }
        match &location.target {
            Target::Home => location.scope.is_none(),
            Target::Missions => true,
            Target::Mission(key) => key.valid() && self.missions.read(cx).contains(key),
            Target::Inbox(filter) => filter
                .as_ref()
                .is_none_or(|id| self.state.projects.iter().any(|p| &p.id == id)),
            Target::Project(id) => {
                location.scope.as_ref() == Some(id)
                    && self.state.projects.iter().any(|p| &p.id == id)
            }
            Target::Chat(id) => self.state.chats.iter().any(|c| {
                &c.id == id
                    && location
                        .scope
                        .as_ref()
                        .is_none_or(|p| c.project_id.as_ref() == Some(p))
            }),
            Target::Draft(key) => {
                location.scope.is_none() && self.editor.read(cx).has_navigation_draft(key)
            }
            Target::Empty => true,
        }
    }
    pub(super) fn restore_location(
        &mut self,
        location: &Location,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        self.restoring_navigation = true;
        let success = match &location.target {
            Target::Missions => self.show_missions(window, cx),
            Target::Mission(key) => self.show_mission_overview(key.clone(), window, cx),
            Target::Home => {
                self.show_home(window, cx);
                true
            }
            Target::Inbox(filter) => {
                self.show_inbox(filter.clone(), window, cx);
                true
            }
            Target::Project(id) => {
                self.show_project(id.clone(), window, cx);
                true
            }
            Target::Chat(id) => {
                let chat = self.state.chats.iter().find(|c| &c.id == id).cloned();
                chat.is_some_and(|chat| self.open(chat, window, cx))
            }
            Target::Draft(key) => self.open(
                Chat {
                    mission: Default::default(),
                    mission_coordinator: false,
                    failure: None,
                    pull_requests: Vec::new(),
                    context_usage: Default::default(),
                    subscription_usage: None,
                    id: key.clone(),
                    title: "New chat".into(),
                    state: "Draft".into(),
                    archived: false,
                    local_draft: true,
                    session_path: None,
                    writable: false,
                    busy: false,
                    signal: None,
                    background_work: false,
                    order: Default::default(),
                    subagents: Default::default(),
                    running_jobs: Default::default(),
                    cwd: String::new(),
                    project_id: None,
                    model_configuration: None,
                    attention: None,
                },
                window,
                cx,
            ),
            Target::Empty => {
                self.page = Page::Chat;
                self.title = "Local chats".into();
                self.nav_error = None;
                self.clear_chat(cx);
                self.editor.update(cx, |e, cx| e.browse_empty(window, cx));
                true
            }
        };
        if success {
            self.change_scope(location.scope.clone(), window, cx);
            self.rebuild_nav(window, cx);
        }
        self.restoring_navigation = false;
        success
    }
    pub(super) fn move_navigation(
        &mut self,
        forward: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.prepare_navigation(window, cx) {
            return;
        }
        let mut candidate = self.navigation.clone();
        let Some(location) = candidate.move_to(forward, |l| self.can_restore(l, cx)) else {
            self.navigation = candidate;
            cx.notify();
            return;
        };
        if self.restore_location(&location, window, cx) {
            self.navigation = candidate;
            self.save_scope(cx);
        }
        cx.notify();
    }
    pub(super) fn focus_scope(&mut self, id: String, window: &mut Window, cx: &mut Context<Self>) {
        if self.project_scope.as_ref() == Some(&id)
            || !self.state.projects.iter().any(|p| p.id == id)
            || !self.prepare_navigation(window, cx)
        {
            return;
        }
        let scope = Some(id.clone());
        let saved = self.scope_states.get(&scope).and_then(|s| s.target.clone());
        let mut location = Location {
            scope,
            target: saved.unwrap_or(Target::Project(id.clone())),
        };
        // A fresh project focus presets Inbox to that project, never a filter
        // previously chosen while browsing some other scope. History is explicit.
        if matches!(self.page, Page::Inbox(_)) || matches!(location.target, Target::Inbox(_)) {
            location.target = Target::Inbox(Some(id.clone()));
        }
        if !self.can_restore(&location, cx) {
            location.target = Target::Project(id);
        }
        if self.restore_location(&location, window, cx) {
            self.did_navigate(cx);
        }
    }
    pub(super) fn restore_reader(&mut self, cx: &mut Context<Self>) {
        if self.page != Page::Chat || !self.state.loaded || self.state.generation != self.generation
        {
            return;
        }
        let Some((generation, id, mark)) = self.pending_reader.take() else {
            return;
        };
        if generation != self.generation
            || generation != self.state.generation
            || self.selected.as_ref() != Some(&id)
        {
            return;
        }
        if !self
            .transcript
            .update(cx, |v, cx| v.restore_reading(mark, cx))
        {
            self.nav_error =
                Some("Previous read position is outside the loaded page. Use More or Latest.");
        }
    }
}
