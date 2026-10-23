//! Shell hierarchy only. Existing exact-ID routes, guards and projections own behavior.
use super::*;
use crate::appearance::{Space, TextRole};
use gpui_kit::EntityInputHandler;

impl LocalViewer {
    pub(super) fn toggle_projects(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if self.jump.is_some() {
            return;
        }
        let q = self.chats.read(cx).query_input();
        if q.update(cx, |q, cx| q.marked_text_range(w, cx).is_some())
            || self.editor.update(cx, |e, cx| e.marked(w, cx))
        {
            return;
        }
        self.projects_open = !self.projects_open;
        if self.projects_open {
            self.projects.update(cx, |l, cx| l.focus(w, cx));
        } else {
            self.chats.update(cx, |l, cx| l.focus(w, cx));
        }
        cx.notify();
    }
    pub(super) fn sidebar(&self, w: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let width = px(if w.viewport_size().width < px(800.) {
            184.
        } else {
            232.
        });
        let archived = self.chats.read(cx).delegate().archived;
        let count = self.chats.read(cx).delegate().filtered.len();
        let scope = self
            .project_scope
            .as_ref()
            .map(|id| {
                self.state
                    .projects
                    .iter()
                    .find(|p| &p.id == id)
                    .map(|p| p.name.clone())
                    .unwrap_or_else(|| "Project unavailable".into())
            })
            .unwrap_or_else(|| "All projects".into());
        let healthy = self.state.status.starts_with("Connected")
            || self.state.status.starts_with("Synthetic")
            || self.state.status.starts_with("Read-only captured");
        div().id("chat-sidebar").test_support().v_flex().w(width).min_w(width).max_w(width).h_full()
            .bg(cx.theme().sidebar).border_r(appearance::hairline(w)).border_color(cx.theme().border)
            .child(div().h_flex().items_center().justify_between().p(px(Space::SIDEBAR)).gap(px(Space::CONTROL))
                .child(div().text_size(px(TextRole::BODY)).font_semibold().child("Pilot Next"))
                .child(Button::new("new-local-chat").ghost().small().icon(IconName::Plus).accessibility_label("New chat")
                    .tooltip("New Local chat with an explicit folder. Project scope is browse-only.").disabled(!self.editor.read(cx).ready())
                    .on_click(cx.listener(|v,_,w,cx|v.new_chat(w,cx)))))
            .child(div().id("global-navigation").test_support().v_flex().px(px(Space::SIDEBAR)).gap(px(Space::META))
                .child(Button::new("nav-home").ghost().small().w_full().justify_start().label("Home").selected(self.page==Page::Home).on_click(cx.listener(|v,_,w,cx|v.show_home(w,cx))))
                .child(Button::new("nav-inbox").ghost().small().w_full().justify_start().label("Inbox").selected(matches!(self.page,Page::Inbox(_))).on_click(cx.listener(|v,_,w,cx|v.show_inbox(v.project_scope.clone(),w,cx))))
                .child(div().text_size(px(TextRole::SMALL)).text_color(cx.theme().muted_foreground).child("⌘K Jump to…")))
            .child(div().v_flex().p(px(Space::SIDEBAR)).gap(px(Space::CONTROL))
                .child(div().id("scope-heading").test_support().text_size(px(TextRole::CAPTION)).text_color(cx.theme().muted_foreground).child("Browse scope"))
                .child(Button::new("project-scope").ghost().small().w_full().min_w_0().h(px(32.)).justify_start()
                    .accessibility_label(SharedString::from(format!("Project scope: {scope}")))
                    .tooltip("Choose a project for browsing. This never selects a new-chat working folder. Escape closes the choices.")
                    .child(div().h_flex().w_full().min_w_0().items_center().gap(px(Space::META))
                        .child(div().id("project-scope-title").test_support().flex_1().min_w_0().truncate().text_size(px(TextRole::BODY)).font_medium().child(SharedString::from(scope)))
                        .child(if self.projects_open{"▴"}else{"▾"}))
                    .on_click(cx.listener(|v,_,w,cx|v.toggle_projects(w,cx))))
                .when(self.projects_open,|this|this.child(div().id("project-choices").test_support().v_flex().min_w_0()
                    .when(!self.state.projects.is_empty(),|this|this.child(div().h(px((self.state.projects.len().min(5)as f32*30.).min(f32::from(w.viewport_size().height)*0.22).max(30.))).min_h_0().w_full().child(List::new(&self.projects))))
                    .when(self.state.projects.is_empty(),|this|this.child(div().text_size(px(TextRole::CAPTION)).text_color(cx.theme().muted_foreground).child(if self.state.projects_error.is_some(){"Project list unavailable"}else if !self.state.projects_loaded{"Loading Local projects…"}else{"No configured projects"})))))
                .when(self.state.projects_error.is_some()&&!self.state.projects.is_empty(),|this|this.child(div().text_size(px(TextRole::CAPTION)).text_color(cx.theme().muted_foreground).child("Project list unavailable · last loaded choices retained")))
                .when(self.project_scope.is_some(),|this|this.child(Button::new("project-overview").ghost().small().w_full().justify_start().label("Overview").on_click(cx.listener(|v,_,w,cx|{if let Some(id)=v.project_scope.clone(){v.show_project(id,w,cx);}}))))
                .child(Button::new("nav-all-chats").ghost().small().w_full().justify_start().label("All chats").selected(self.page==Page::Chat&&self.project_scope.is_none()).on_click(cx.listener(|v,_,w,cx|v.show_chats(w,cx))))
                .child(div().h_flex().gap(px(Space::META))
                    .child(Button::new("nav-back").ghost().small().label("Back").tooltip("Back (⌘[)").disabled(!self.navigation.can_move(false)).on_click(cx.listener(|v,_,w,cx|v.move_navigation(false,w,cx))))
                    .child(Button::new("nav-forward").ghost().small().label("Forward").tooltip("Forward (⌘])").disabled(!self.navigation.can_move(true)).on_click(cx.listener(|v,_,w,cx|v.move_navigation(true,w,cx)))))
                .child(Checkbox::new("archives").label("Include archived").checked(archived).on_change(cx.listener(|v,checked,_,cx|v.chats.update(cx,|l,cx|{l.delegate_mut().archived = *checked;l.delegate_mut().filter();cx.notify();}))))
                .child(div().text_size(px(TextRole::CAPTION)).text_color(cx.theme().muted_foreground).child(SharedString::from(format!("Chats · {count} shown")))))
            .child(div().id("chat-list-pane").test_support().flex_1().min_h_0().min_w_0().child(List::new(&self.chats).search_placeholder("Find a chat…")))
            .when_some(self.nav_error,|this,error|this.child(div().p(px(Space::SIDEBAR)).text_size(px(TextRole::CAPTION)).text_color(cx.theme().danger).child(error)))
            .children((!healthy).then(||div().v_flex().p(px(Space::SIDEBAR)).gap(px(Space::CONTROL)).border_t(appearance::hairline(w)).border_color(cx.theme().border)
                .child(div().text_size(px(TextRole::CAPTION)).text_color(cx.theme().danger).child(SharedString::from(self.state.status.clone())))
                .child(Button::new("reconnect").ghost().small().label("Reconnect").disabled(self.client.is_none()).on_click(cx.listener(|v,_,_,_|{if let Some(c)=&v.client{c.command(Command::Reconnect);}})))))
    }
}
