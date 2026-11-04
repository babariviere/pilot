//! Global Review page: every change with a review request, across projects. A chat can
//! open it narrowed to its own changes; a mission is never a Review destination.
use super::*;
use crate::navigation::ReviewTarget;

impl LocalViewer {
    /// A chat filter must name a known chat; a request must be a valid ID; a saved
    /// revision needs its chat, and at most one change is open. The pane still opens a
    /// change only when the host lists it.
    pub(super) fn review_target_known(&self, t: &ReviewTarget) -> bool {
        t.request
            .as_deref()
            .is_none_or(crate::local_model::valid_id)
            && t.snapshot.as_deref().is_none_or(|s| {
                t.chat.is_some() && t.request.is_none() && crate::native_review::hex(s, 64)
            })
            && t.chat.as_ref().is_none_or(|id| {
                self.state
                    .chats
                    .iter()
                    .any(|c| &c.id == id && !c.local_draft)
            })
    }
    pub(super) fn show_review(
        &mut self,
        target: ReviewTarget,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        if !self.review_target_known(&target) || !self.prepare_navigation(w, cx) {
            return false;
        }
        self.leave_artifacts(cx);
        self.page = Page::Review(target);
        self.nav_error = None;
        self.rebuild_nav(w, cx);
        if let Some(review) = &self.review {
            review.update(cx, |p, cx| p.focus(w, cx));
        }
        self.did_navigate(cx);
        true
    }
    /// Review narrowed to the selected chat's changes, from its header.
    pub(super) fn review_selected_chat(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if let Some(target) = self.selected_review_target() {
            self.show_review(target, w, cx);
        }
    }
    pub(super) fn selected_review_target(&self) -> Option<ReviewTarget> {
        let id = self.selected.as_ref()?;
        let chat = self
            .state
            .chats
            .iter()
            .find(|c| &c.id == id && !c.local_draft)?;
        Some(ReviewTarget {
            chat: Some(chat.id.clone()),
            ..Default::default()
        })
    }
    /// Keeps the shared pane on the shown target; hidden Review cancels reads and clears content.
    pub(super) fn sync_review(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        let target = match &self.page {
            Page::Review(t) => Some(t.clone()),
            _ => None,
        };
        if target.is_some() && self.review.is_none() {
            let review = cx.new(|cx| crate::native_review_view::Pane::new(w, cx));
            cx.subscribe_in(
                &review,
                w,
                |v, _, e: &crate::native_review_view::Event, w, cx| match e {
                    crate::native_review_view::Event::Close => v.leave_review(w, cx),
                    crate::native_review_view::Event::Open(t) => v.open_review_change(t, w, cx),
                    crate::native_review_view::Event::CurrentFile {
                        home,
                        chat,
                        project,
                        path,
                    } => v.open_current_file(home, chat, project, path, w, cx),
                },
            )
            .detach();
            self.review = Some(review);
        }
        let Some(review) = self.review.clone() else {
            return;
        };
        let options = self.missions.read(cx).local_options();
        let home = self.missions.read(cx).local_home();
        let visible = target.is_some() && self.local_online();
        let open = target.as_ref().and_then(|t| {
            use crate::native_review_view::Target;
            t.request
                .clone()
                .map(Target::Request)
                .or_else(|| t.snapshot.clone().map(Target::Saved))
        });
        let scope = target
            .zip(home)
            .map(|(t, home)| crate::native_review_view::Scope { home, chat: t.chat });
        let chats = self.state.chats.clone();
        review.update(cx, |p, cx| {
            p.observe_chats(chats, cx);
            p.sync(scope, open, options, visible, w, cx);
        });
    }
    fn open_review_change(
        &mut self,
        open: &crate::native_review_view::Target,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        use crate::native_review_view::Target;
        let Page::Review(target) = self.page.clone() else {
            return;
        };
        let (request, snapshot) = match open {
            Target::Request(id) => (Some(id.clone()), None),
            Target::Saved(id) => (None, Some(id.clone())),
        };
        self.show_review(
            ReviewTarget {
                chat: target.chat,
                request,
                snapshot,
            },
            w,
            cx,
        );
    }
    /// The change's current workspace file, outside Review: its chat opens with the
    /// read-only file panel, and Back returns to the exact change. The home, project and
    /// chat are rechecked against current metadata first; a moved, projectless or unknown
    /// target opens nothing. Retained source is never replaced by current bytes.
    fn open_current_file(
        &mut self,
        home: &crate::mission_browser::Home,
        chat: &str,
        project: &str,
        path: &str,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !matches!(self.page, Page::Review(_))
            || self.missions.read(cx).local_home().as_ref() != Some(home)
            || !crate::session_file_view::valid_path(path)
        {
            return;
        }
        let Some(c) = self
            .state
            .chats
            .iter()
            .find(|c| {
                c.id == chat
                    && !c.local_draft
                    && !c.cwd.is_empty()
                    && c.project_id.as_deref() == Some(project)
            })
            .cloned()
        else {
            self.nav_error = Some("This change's chat isn't available here. Nothing was opened.");
            cx.notify();
            return;
        };
        if self.open(c, w, cx) {
            self.open_session_file(chat, path.to_owned(), w, cx);
        }
    }
    /// Escape or Back from Review returns where the user came from.
    pub(super) fn leave_review(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        let Page::Review(target) = self.page.clone() else {
            return;
        };
        if self.navigation.can_move(false) {
            self.move_navigation(false, w, cx);
        } else if target.request.is_some() || target.snapshot.is_some() {
            self.show_review(
                ReviewTarget {
                    chat: target.chat,
                    ..Default::default()
                },
                w,
                cx,
            );
        } else if let Some(chat) = target
            .chat
            .and_then(|id| self.state.chats.iter().find(|c| c.id == id).cloned())
        {
            self.open(chat, w, cx);
        } else {
            self.show_home(w, cx);
        }
    }
    pub(super) fn review_page(
        &self,
        target: &ReviewTarget,
        cx: &mut Context<Self>,
    ) -> gpui_kit::AnyElement {
        let chat = target
            .chat
            .as_ref()
            .and_then(|id| self.state.chats.iter().find(|c| &c.id == id))
            .map(|c| c.title.clone());
        let header = div()
            .id("review-page-header")
            .test_support()
            .h_flex()
            .items_center()
            .gap_2()
            .min_w_0()
            .flex_none()
            .child(
                crate::ui::icon_action(
                    "review-page-back",
                    "Back",
                    AppIcon::Back,
                    crate::ui::Action::Quiet,
                )
                .on_click(cx.listener(|v, _, w, cx| v.leave_review(w, cx))),
            )
            .child(
                div()
                    .v_flex()
                    .flex_1()
                    .min_w_0()
                    .child(crate::ui::heading(
                        "review-page-title",
                        "Review",
                        crate::ui::Text::Title,
                    ))
                    .children(chat.map(|title| {
                        crate::ui::text(
                            crate::ui::Text::Caption,
                            SharedString::from(format!("From {title}")),
                        )
                        .id("review-page-subtitle")
                        .test_support()
                        .truncate()
                        .text_color(cx.theme().muted_foreground)
                    })),
            )
            .when(
                target.chat.is_some() && target.request.is_none() && target.snapshot.is_none(),
                |d| {
                    d.child(
                        crate::ui::action(
                            "review-page-all",
                            "All changes",
                            crate::ui::Action::Quiet,
                        )
                        .accessibility_label("Review all changes")
                        .on_click(cx.listener(|v, _, w, cx| {
                            v.show_review(ReviewTarget::default(), w, cx);
                        })),
                    )
                },
            );
        div()
            .id("review-page")
            .test_support()
            .v_flex()
            .flex_1()
            .min_w_0()
            .min_h_0()
            .h_full()
            .gap(px(crate::ui::Space::CONTROL))
            .p(px(crate::ui::Space::HOME))
            .child(header)
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .min_w_0()
                    .children(self.review.clone()),
            )
            .into_any_element()
    }
}

#[cfg(feature = "native-probes")]
impl LocalViewer {
    pub(crate) fn review_fixture_chats(
        &mut self,
        chats: Vec<Chat>,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.state.chats = Arc::new(chats);
        self.rebuild_nav(w, cx);
        cx.notify();
    }
    /// Shows a listed chat as selected. The synthetic root has no daemon to open history,
    /// so this records navigation like `open` without reading a transcript.
    pub(crate) fn review_fixture_open(
        &mut self,
        id: &str,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let Some(chat) = self.state.chats.iter().find(|c| c.id == id).cloned() else {
            return false;
        };
        if !self.prepare_navigation(w, cx) {
            return false;
        }
        self.leave_artifacts(cx);
        self.selected = Some(chat.id);
        self.title = chat.title;
        self.page = Page::Chat;
        self.rebuild_nav(w, cx);
        self.did_navigate(cx);
        true
    }
    pub(crate) fn review_fixture_target(&self, cx: &App) -> crate::navigation::Target {
        self.location(cx).target
    }
    pub(crate) fn review_fixture_pane(&self) -> Option<Entity<crate::native_review_view::Pane>> {
        self.review.clone()
    }
    pub(crate) fn review_fixture_file_open(&self) -> bool {
        self.session_file.is_some()
    }
    pub(crate) fn review_fixture_back(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        self.move_navigation(false, w, cx);
    }
}
