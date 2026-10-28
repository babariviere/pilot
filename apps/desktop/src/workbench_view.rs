//! Shell hierarchy only. Existing exact-ID routes, guards and projections own behavior.
use super::*;
use crate::app_icon::AppIcon;
use crate::appearance::{Space, TextRole};
use gpui_kit::EntityInputHandler;

impl LocalViewer {
    pub(super) fn open_usage(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        // A separate passive page preserves the current chat/draft and navigation.
        if !self.project_choices_ready(window, cx) {
            return;
        }
        if let Some(handle) = self.usage_window
            && handle.update(cx, |_, w, _| w.activate_window()).is_ok()
        {
            return;
        }
        let options = self.usage_options.clone();
        let result = gpui_kit::open_window(
            gpui_kit::WindowOptions {
                window_bounds: Some(gpui_kit::WindowBounds::Windowed(
                    gpui_kit::Bounds::centered(None, gpui_kit::size(px(780.), px(720.)), cx),
                )),
                window_min_size: Some(gpui_kit::size(px(640.), px(440.))),
                window_background: crate::appearance::window_background(cx),
                ..Default::default()
            },
            cx,
            |w, cx| {
                crate::appearance::follow_appearance(w, cx);
                w.set_window_title("Usage · Local");
                let pane = cx.new(|cx| crate::usage_overview_view::Usage::new(options, cx));
                pane.update(cx, |p, cx| {
                    p.focus(w, cx);
                    p.load(7, w, cx);
                });
                let weak = pane.downgrade();
                w.on_window_should_close(cx, move |_, cx| {
                    let _ = weak.update(cx, |p, cx| p.close(cx));
                    true
                });
                pane
            },
        );
        match result {
            Ok((handle, pane)) => {
                let focus = window.focused(cx);
                self.usage_window = Some(handle);
                self.usage_events =
                    Some(cx.observe_release_in(&pane, window, move |v, _, w, cx| {
                        v.usage_window = None;
                        if let Some(f) = &focus {
                            f.focus(w, cx);
                        }
                        cx.notify();
                    }));
            }
            Err(_) => {
                self.nav_error = Some("Usage could not be opened. Try again.");
            }
        }
        cx.notify();
    }
    pub(super) fn open_settings(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        // Same IME/search/picker guard as existing native navigation. Opening a separate
        // window never unmounts or retargets the transcript, composer or draft selection.
        if !self.project_choices_ready(window, cx) {
            return;
        }
        if let Some(handle) = self.settings_window
            && handle
                .update(cx, |_, window, _| window.activate_window())
                .is_ok()
        {
            return;
        }
        let preferences = self.settings.clone();
        let initial_size = gpui_kit::size(px(780.), px(620.));
        #[cfg(feature = "native-probes")]
        let initial_size = self.settings_fixture_size.unwrap_or(initial_size);
        let result = gpui_kit::open_window(
            gpui_kit::WindowOptions {
                window_bounds: Some(gpui_kit::WindowBounds::Windowed(
                    gpui_kit::Bounds::centered(None, initial_size, cx),
                )),
                window_min_size: Some(gpui_kit::size(px(640.), px(440.))),
                window_background: crate::appearance::window_background(cx),
                ..Default::default()
            },
            cx,
            |window, cx| {
                crate::appearance::follow_appearance(window, cx);
                window.set_window_title("Settings");
                let pane =
                    cx.new(|cx| crate::settings_view::SettingsView::new(preferences, window, cx));
                pane.update(cx, |pane, cx| pane.focus_categories(window, cx));
                let weak = pane.downgrade();
                window.on_window_should_close(cx, move |window, cx| {
                    weak.update(cx, |pane, cx| pane.request_close(window, cx))
                        .unwrap_or(true)
                });
                pane
            },
        );
        match result {
            Err(_) => {
                self.nav_error = Some("Settings could not be opened. Try again.");
                cx.notify();
            }
            Ok((handle, pane)) => {
                self.settings_return = window.focused(cx);
                self.settings_window = Some(handle);
                self.settings_pane = Some(pane.downgrade());
                self.settings_events = vec![
                    cx.subscribe(&pane, |_, _, event, cx| match event {
                        crate::settings_view::SettingsEvent::Quit => {
                            super::menu_routing::quit(cx);
                        }
                    }),
                    cx.observe_release_in(&pane, window, |view, _, window, cx| {
                        view.settings_window = None;
                        view.settings_pane = None;
                        if let Some(focus) = view.settings_return.take() {
                            focus.focus(window, cx);
                        }
                        cx.notify();
                    }),
                ];
                cx.notify();
            }
        }
    }
    pub(super) fn project_choices_ready(&self, w: &mut Window, cx: &mut Context<Self>) -> bool {
        if self.restart_pending {
            return false;
        }
        if self.queue_open.is_some()
            || self.jump.is_some()
            || self.mission_open
            || self.add_project_open
        {
            return false;
        }
        let q = self.chats.read(cx).query_input();
        if q.update(cx, |q, cx| q.marked_text_range(w, cx).is_some())
            || self.missions.update(cx, |m, cx| m.brief_marked(w, cx))
            || self.editor.update(cx, |e, cx| e.marked(w, cx))
            || (matches!(self.page, Page::Inbox(_))
                && !self.inbox.update(cx, |i, cx| i.prepare_jump(w, cx)))
        {
            return false;
        }
        true
    }
    pub(super) fn toggle_projects(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if !self.project_choices_ready(w, cx) {
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
        // Compose belongs with Home, as in Swift's SidebarHeader. Project
        // management lives in the disclosed selector, not a permanent row.
        div().id("chat-sidebar").test_support().v_flex().w(width).min_w(width).max_w(width).h_full()
            .bg(cx.theme().sidebar).border_r(appearance::hairline(w)).border_color(cx.theme().border)
            .child(div().id("global-navigation").test_support().v_flex().px(px(Space::SIDEBAR)).pt_2().gap_0p5().flex_shrink_0()
                .child(div().h_flex().min_w_0()
                    .child(sidebar_row("nav-home","Home",AppIcon::Home).flex_1().selected(self.page==Page::Home)
                        .on_click(cx.listener(|v,_,w,cx|v.show_home(w,cx))))
                    .child(crate::ui::icon_action("new-local-chat","New chat (⌘N)",AppIcon::NewChat,crate::ui::Action::Quiet)
                        .size_8().flex_shrink_0().disabled(!self.editor.read(cx).ready())
                        .tooltip("New chat (⌘N)")
                        .on_click(cx.listener(|v,_,w,cx|v.new_chat(w,cx)))))
                .child(sidebar_row("nav-inbox","Inbox",AppIcon::Inbox).selected(matches!(self.page,Page::Inbox(_)))
                    .on_click(cx.listener(|v,_,w,cx|v.show_inbox(v.project_scope.clone(),w,cx))))
                .child(sidebar_row("nav-missions","Missions",AppIcon::Mission).accessibility_label("Missions (Command-3)")
                    .selected(matches!(self.page,Page::Missions|Page::Mission(_)))
                    .on_click(cx.listener(|v,_,w,cx|{v.show_missions(w,cx);}))))
            .child(div().v_flex().px(px(Space::SIDEBAR)).pt_3().gap_0p5().flex_shrink_0()
                .child(Button::new("project-scope").ghost().small().w_full().min_w_0().h_8().px_2().justify_start()
                    .selected(self.projects_open)
                    .accessibility_label(SharedString::from(format!("Showing {scope}. Choose a project or add one")))
                    .tooltip("Choose which project's chats to show")
                    .child(nav_label("project-scope-title", SharedString::from(scope),if self.project_scope.is_some(){AppIcon::Project}else{AppIcon::Projects})
                        .child(gpui_kit::component::Icon::new(if self.projects_open{IconName::ChevronUp}else{IconName::ChevronDown}).small().flex_shrink_0()))
                    .on_click(cx.listener(|v,_,w,cx|v.toggle_projects(w,cx))))
                .when(self.projects_open,|this|this.child(div().id("project-choices").test_support().v_flex().min_w_0().py_1()
                    .child(div().h(px((self.state.projects.len().min(5)as f32*28.).min(f32::from(w.viewport_size().height)*0.22).max(30.))).min_h_0().w_full().child(List::new(&self.projects).scrollbar_visible(false)))
                    .child(sidebar_row("add-project","Add project…",AppIcon::AddProject)
                        .tooltip("Add a folder as a project")
                        .disabled(self.writer.is_none()).on_click(cx.listener(|v,_,w,cx|{
                            if !v.project_choices_ready(w,cx){return;}
                            // The selector list unmounts as the sheet opens.
                            // Capture a mounted return target for the existing flow.
                            v.chats.update(cx,|l,cx|l.focus(w,cx));
                            v.open_add_project(w,cx);
                        })))))
                // The one place a failed project refresh is reported.
                .when(self.state.projects_error.is_some()&&!self.state.projects.is_empty(),|this|this.child(div().id("projects-refresh-problem").h_flex().gap_1().px_2().py_1().min_w_0()
                    .text_size(px(TextRole::CAPTION)).text_color(cx.theme().muted_foreground)
                    .child(AppIcon::Error.inline().text_color(cx.theme().danger))
                    .child(div().min_w_0().truncate().child("Couldn't refresh projects"))))
                .when(self.project_scope.is_some(),|this|this.child(sidebar_row("project-overview","Overview",AppIcon::Overview)
                    .selected(matches!(&self.page,Page::Project(id) if self.project_scope.as_ref()==Some(id)))
                    .on_click(cx.listener(|v,_,w,cx|{if let Some(id)=v.project_scope.clone(){v.show_project(id,w,cx);}}))))
                .child(sidebar_row("nav-all-chats","All chats",AppIcon::Chats).selected(self.page==Page::Chat&&self.project_scope.is_none())
                    .on_click(cx.listener(|v,_,w,cx|v.show_chats(w,cx))))
                .child(div().h_flex().min_w_0().pl_2().pt_2().items_center().gap_1()
                    .child(div().id("sidebar-chat-count").test_support().flex_1().min_w_0().truncate().text_size(px(TextRole::LABEL)).text_color(cx.theme().muted_foreground)
                        .child("Chats"))
                    .child(self.chat_filter(cx)))
                .when(archived,|this|this.child(div().id("archives-active").test_support().px_2().text_size(px(TextRole::CAPTION)).text_color(cx.theme().muted_foreground).child("Archived included"))))
            // The sidebar scrolls without a visible scrollbar in any Kit mode.
            .child(div().id("chat-list-pane").test_support().px(px(Space::SIDEBAR)).flex_1().min_h_0().min_w_0().child(List::new(&self.chats).search_placeholder("Find a chat…").scrollbar_visible(false)))
            .child(self.chat_actions.clone())
            // One footer row: Jump to… plus quiet history, Usage and Settings icon actions.
            .child(div().id("sidebar-footer").test_support().h_flex().items_center().min_w_0().px(px(Space::SIDEBAR)).pb_2().pt_1().flex_shrink_0()
                // With history arrows the footer has no room for the words at either
                // sidebar width: keep the glyph rather than truncating the label.
                .child(sidebar_row("sidebar-jump",if self.navigation.can_move(false)||self.navigation.can_move(true){""}else{"Jump to…"},AppIcon::Search)
                    .flex_1().accessibility_label("Jump to…").tooltip("Jump to a page, project or chat (⌘K)")
                    .on_click(cx.listener(|v,_,w,cx|v.toggle_jump(w,cx))))
                .when(self.navigation.can_move(false)||self.navigation.can_move(true),|this|this.child(div().h_flex().flex_shrink_0()
                    .capture_any_mouse_down(cx.listener(|v,_,w,cx|{if !v.project_choices_ready(w,cx){cx.stop_propagation();}}))
                    .child(crate::ui::icon_action("nav-back","Back (⌘[)",AppIcon::Back,crate::ui::Action::Quiet).size_8().disabled(!self.navigation.can_move(false)).on_click(cx.listener(|v,_,w,cx|v.move_navigation(false,w,cx))))
                    .child(crate::ui::icon_action("nav-forward","Forward (⌘])",AppIcon::Forward,crate::ui::Action::Quiet).size_8().disabled(!self.navigation.can_move(true)).on_click(cx.listener(|v,_,w,cx|v.move_navigation(true,w,cx))))))
                .child(crate::ui::icon_action("open-usage","Usage",AppIcon::Usage,crate::ui::Action::Quiet).size_8().flex_shrink_0().accessibility_label("Open Local Usage")
                    .on_click(cx.listener(|view,_,window,cx|view.open_usage(window,cx))))
                .child(crate::ui::icon_action("open-settings","Settings (⌘,)",AppIcon::Settings,crate::ui::Action::Quiet).size_8().flex_shrink_0().accessibility_label("Settings (Command-comma)")
                    .on_click(cx.listener(|view,_,window,cx|view.open_settings(window,cx)))))
            .when_some(self.nav_error,|this,error|this.child(div().p(px(Space::SIDEBAR)).text_size(px(TextRole::CAPTION)).text_color(cx.theme().danger).child(error)))
            .children((!healthy).then(||div().id("sidebar-connection").test_support().v_flex().p(px(Space::SIDEBAR)).gap(px(Space::CONTROL)).flex_shrink_0().border_t(appearance::hairline(w)).border_color(cx.theme().border)
                .child(div().text_size(px(TextRole::CAPTION)).text_color(cx.theme().danger).child(SharedString::from(self.state.status.clone())))
                .child(Button::new("reconnect").ghost().small().label("Reconnect").icon(AppIcon::Retry.asset()).disabled(self.client.is_none()).on_click(cx.listener(|v,_,_,_|{if let Some(c)=&v.client{c.command(Command::Reconnect);}})))))
    }
}

// Fill the inner Button content slot, not just its outer Base wrapper.
fn sidebar_row(id: &'static str, title: &'static str, icon: AppIcon) -> Button {
    Button::new(id)
        .ghost()
        .small()
        .w_full()
        .min_w_0()
        .h_8()
        .px_2()
        .justify_start()
        .accessibility_label(title)
        .child(nav_label(
            SharedString::from(format!("{id}-title")),
            title,
            icon,
        ))
}
fn nav_label(
    id: impl Into<SharedString>,
    title: impl Into<SharedString>,
    icon: AppIcon,
) -> gpui_kit::Div {
    let id = id.into();
    div()
        .h_flex()
        .w_full()
        .min_w_0()
        .items_center()
        .gap_2()
        .text_left()
        .text_size(px(TextRole::BODY))
        .child(
            div()
                .id(SharedString::from(format!("{id}-icon")))
                .test_support()
                .size_4()
                .flex_shrink_0()
                .child(icon.icon()),
        )
        .child(
            div()
                .id(id)
                .test_support()
                .flex_1()
                .min_w_0()
                .truncate()
                .child(title.into()),
        )
}
