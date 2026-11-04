//! New chats started from a tracked Slack message. The draft keeps the message's identity and
//! its project; the courier links the two once the chat exists. Nothing is sent until the user
//! sends the draft.
use super::*;
use crate::delivery_store::Tracked;

/// Where Start chat leads for a message that already has one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Existing {
    /// The draft started from it: unsent, sending, or created (which opens its chat).
    Draft(String),
    /// The chat it created, once its draft is retired.
    Chat(String),
}

impl ChatEditor {
    pub(crate) fn tracked_draft(&self, item: &str) -> Option<Existing> {
        let draft = self.cache.iter().find(|(key, draft)| {
            key.starts_with("new:")
                && !self.removing_left(key)
                && draft.tracked.as_ref().is_some_and(|t| t.item_id == item)
        });
        if let Some((key, _)) = draft {
            return Some(Existing::Draft(key.clone()));
        }
        if let Some(chat) = self.state.linked.get(item) {
            return Some(Existing::Chat(chat.clone()));
        }
        self.state
            .book
            .as_ref()?
            .links
            .iter()
            .find(|(_, t)| t.item_id == item)
            .map(|(chat, _)| Existing::Chat(chat.clone()))
    }

    /// A new Build draft in the message's project, its first message written for the user to
    /// review and edit.
    pub(crate) fn new_tracked_draft(
        &mut self,
        tracked: Tracked,
        cwd: String,
        text: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        self.changed(cx);
        self.prune_cache();
        if !self.ready() {
            return false;
        }
        if self.cache.len() >= DRAFT_CAP {
            self.error = Some("Draft capacity reached. Existing drafts are retained.");
            cx.notify();
            return false;
        }
        let key = format!("new:{}", uuid::Uuid::new_v4());
        let draft = Draft {
            revision: 1,
            text,
            cwd,
            project_id: Some(tracked.project_id.clone()),
            tracked: Some(tracked),
            ..Default::default()
        };
        self.cache.insert(key.clone(), draft.clone());
        if let Some(client) = &self.client {
            client.edit(key.clone(), draft);
        }
        self.select(key, true, false, window, cx);
        // The caret waits after the context, where the user adds their own words.
        let last = self.text.read(cx).value().matches('\n').count() as u32;
        self.text.update(cx, |text, cx| {
            text.set_cursor_position(
                gpui_kit::component::input::Position::new(last, u32::MAX),
                window,
                cx,
            )
        });
        self.sync_project_picker(window, cx);
        self.sync_models(window, cx);
        cx.emit(EditorEvent::DraftsChanged);
        true
    }

    /// Keeps the draft but drops its message, so its project can change.
    pub(super) fn unlink_tracked(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.ready() || self.waiting() || self.marked(window, cx) {
            return;
        }
        self.changed(cx);
        let Some(draft) = self.selected.as_ref().and_then(|k| self.cache.get_mut(k)) else {
            return;
        };
        if !draft.editable() || draft.tracked.take().is_none() {
            return;
        }
        self.record_edit(true, cx);
        self.sync_project_picker(window, cx);
    }

    /// "#support · Atlas": the message the draft starts from and its fixed project.
    pub(super) fn tracked_row(
        &self,
        tracked: &Tracked,
        editable: bool,
        cx: &Context<Self>,
    ) -> impl IntoElement + use<> {
        let project = self
            .project_name(&tracked.project_id)
            .unwrap_or("Project unavailable");
        let row = div()
            .id("new-chat-tracked")
            .h_flex()
            .items_center()
            .min_w_0()
            .gap(px(crate::ui::Space::CONTROL))
            .text_color(cx.theme().muted_foreground)
            .child(
                div()
                    .flex_none()
                    .child(crate::app_icon::BrandMark::Slack.icon().size_3p5()),
            )
            .child(
                crate::ui::text(
                    crate::ui::Text::Body,
                    format!("{} · {project}", tracked.label),
                )
                .text_color(cx.theme().foreground)
                .flex_1()
                .min_w_0()
                .truncate(),
            )
            .children(editable.then(|| {
                crate::ui::icon_action(
                    "new-chat-unlink",
                    "Don't link to Slack",
                    AppIcon::Close,
                    crate::ui::Action::Quiet,
                )
                .on_click(cx.listener(|view, _, window, cx| view.unlink_tracked(window, cx)))
            }));
        #[cfg(any(test, feature = "native-probes"))]
        let row = row.test_support();
        row
    }
}
