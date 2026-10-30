//! Fixed-height chat chrome; sidebar wheel frames leave it untouched.
//! LocalViewer retains state, exact identities and guarded callbacks.
use super::*;
use gpui_kit::StatefulInteractiveElement as _;

/// Existing toolbar geometry, shared by the cached root and its content.
pub(super) const HEIGHT: f32 = 48.;

pub(super) struct ChatHeader {
    owner: gpui_kit::WeakEntity<LocalViewer>,
    _changes: Vec<Subscription>,
    #[cfg(feature = "native-probes")]
    renders: u64,
}
impl ChatHeader {
    pub(super) fn new(
        owner: &Entity<LocalViewer>,
        editor: &Entity<ChatEditor>,
        mission: &Entity<crate::mission_view::MissionForm>,
        context: &Entity<crate::mission_inspector_view::Pane>,
        cx: &mut Context<Self>,
    ) -> Self {
        Self {
            owner: owner.downgrade(),
            // The header reads owner state, mission-context visibility and
            // mission-conversion eligibility. Sidebar redraws are not changes.
            _changes: vec![
                cx.observe(owner, |_, _, cx| cx.notify()),
                cx.observe(editor, |_, _, cx| cx.notify()),
                cx.observe(mission, |_, _, cx| cx.notify()),
                cx.observe(context, |_, _, cx| cx.notify()),
            ],
            #[cfg(feature = "native-probes")]
            renders: 0,
        }
    }
}
impl Render for ChatHeader {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        #[cfg(feature = "native-probes")]
        {
            self.renders += 1;
        }
        self.owner
            .update(cx, |owner, cx| owner.render_chat_header(window, cx))
            .unwrap_or_else(|_| gpui_kit::Empty.into_any_element())
    }
}

#[cfg(feature = "native-probes")]
#[path = "chat_header_probe.rs"]
pub(super) mod probe;
impl LocalViewer {
    pub(super) fn chat_header_element(
        &mut self,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> gpui_kit::AnyElement {
        // Same-source hidden A/B measurement only. Production has no switch.
        #[cfg(feature = "native-probes")]
        if std::env::var_os("PILOT_NEXT_SIDEBAR_SCROLL_EAGER_HEADER").is_some() {
            return self.render_chat_header(_window, _cx);
        }
        self.chat_header
            .clone()
            .cached(
                gpui_kit::StyleRefinement::default()
                    .w_full()
                    .h(px(HEIGHT))
                    .flex_shrink_0(),
            )
            .into_any_element()
    }

    fn render_chat_header(
        &mut self,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> gpui_kit::AnyElement {
        let cwd = self
            .selected
            .as_ref()
            .and_then(|id| self.state.chats.iter().find(|c| &c.id == id))
            .map(|c| c.cwd.clone())
            .unwrap_or_default();
        let history_status = if self.earlier_request.is_some() && self.pending_reader.is_some() {
            "Restoring reading position…"
        } else if self.earlier_request.is_some() {
            "Loading earlier messages…"
        } else if self.state.page_error {
            "Earlier messages could not be loaded"
        } else {
            self.state.chat_status.as_str()
        };
        // One quiet subtitle line: project, then only non-routine transport status.
        let project = self
            .selected
            .as_ref()
            .and_then(|id| self.state.chats.iter().find(|c| &c.id == id))
            .and_then(|c| c.project_id.as_ref())
            .and_then(|id| self.state.projects.iter().find(|p| &p.id == id))
            .map(|p| p.name.clone());
        let header_meta = project
            .into_iter()
            .chain(
                (!history_status.is_empty() && history_status != "Connected · Local")
                    .then(|| history_status.to_owned()),
            )
            .collect::<Vec<_>>()
            .join(" · ");
        let paused = self
            .selected
            .as_ref()
            .and_then(|id| self.state.chats.iter().find(|c| &c.id == id))
            .and_then(Chat::pause_reason);
        div()
            .id("chat-header")
            .test_support()
            // A cached view lays its content out as a root: keep the real
            // header at the same definite width as its cached layout node.
            .w_full()
            .min_w_0()
            .h_flex()
            .items_center()
            .gap_2()
            .h(px(HEIGHT))
            .px_3()
            .flex_shrink_0()
            .border_b_1()
            .border_color(cx.theme().border)
            .child(
                div()
                    .v_flex()
                    .items_start()
                    .justify_center()
                    .flex_1()
                    .min_w_0()
                    .child(
                        div()
                            .id("chat-title")
                            .max_w_full()
                            .truncate()
                            .text_size(px(crate::ui::TextRole::HEADLINE))
                            .line_height(px(crate::ui::TextRole::HEADLINE * 1.3))
                            .font_semibold()
                            .when(!cwd.is_empty(), |d| {
                                let cwd = SharedString::from(cwd.clone());
                                gpui_kit::StatefulInteractiveElement::tooltip(d, move |w, cx| {
                                    gpui_kit::component::tooltip::Tooltip::new(cwd.clone())
                                        .build(w, cx)
                                })
                            })
                            .child(SharedString::from(self.title.clone()))
                            .test_support(),
                    )
                    .when(!header_meta.is_empty(), |this| {
                        this.child(
                            div()
                                .id("chat-header-meta")
                                .test_support()
                                .max_w_full()
                                .truncate()
                                .text_size(px(crate::ui::TextRole::CAPTION))
                                .line_height(px(crate::ui::TextRole::CAPTION * 1.3))
                                .text_color(cx.theme().muted_foreground)
                                .child(SharedString::from(header_meta)),
                        )
                    }),
            )
            .when_some(paused, |d, reason| {
                d.child(
                    div()
                        .id("chat-paused-status")
                        .h_flex()
                        .items_center()
                        .gap_1()
                        .flex_none()
                        .text_color(cx.theme().muted_foreground)
                        .aria_label(SharedString::from(format!("Paused, {reason}")))
                        .tooltip(move |w, cx| {
                            gpui_kit::component::tooltip::Tooltip::new(reason).build(w, cx)
                        })
                        .test_support()
                        .child(crate::state_mark::slot(
                            Some(crate::state_mark::Mark::Paused.into()),
                            None,
                            1.,
                            cx,
                        ))
                        .child(crate::ui::text(crate::ui::Text::Caption, "Paused")),
                )
            })
            .child(
                div()
                    .h_flex()
                    .items_center()
                    .gap_0p5()
                    .flex_none()
                    .children(self.conversation_links_action(cx))
                    .children(self.workspace_changes_action(cx))
                    .when(
                        !self.state.artifacts.is_empty() || self.artifacts_open,
                        |this| {
                            this.child({
                                let b = Button::new("artifact-gallery").ghost().small();
                                if self.artifacts_open {
                                    b.icon(AppIcon::Back.asset()).label("Back to chat")
                                } else {
                                    b.icon(AppIcon::Artifacts.asset())
                                        .accessibility_label("Artifacts")
                                        .tooltip("Artifacts")
                                }
                                .on_click(cx.listener(
                                    |view, _, window, cx| {
                                        if !view.prepare_navigation(window, cx) {
                                            return;
                                        }
                                        view.artifacts_open = !view.artifacts_open;
                                        view.sync_mission_context(cx);
                                        if view.artifacts_open {
                                            view.artifacts
                                                .update(cx, |p, cx| p.show_gallery(window, cx));
                                        } else {
                                            view.artifacts.update(cx, |p, cx| p.hide_gallery(cx));
                                            view.editor
                                                .update(cx, |editor, cx| editor.focus(window, cx));
                                        }
                                        cx.notify();
                                    },
                                ))
                            })
                        },
                    )
                    .when(self.state.page_error && !self.state.page_busy, |this| {
                        this.child(
                            crate::ui::action(
                                "history-retry",
                                "Retry earlier",
                                crate::ui::Action::Quiet,
                            )
                            .small()
                            .on_click(cx.listener(|v, _, _, cx| v.earlier(true, cx))),
                        )
                    })
                    .children(self.mission_context_action(cx))
                    .when(self.selected.is_some() && !self.artifacts_open, |this| {
                        this.child(self.history_menu(cx))
                    }),
            )
            .map(|d| {
                #[cfg(feature = "native-probes")]
                let d = scroll_work::region(d, "header");
                d
            })
            .into_any_element()
    }
}
