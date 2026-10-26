//! Minimal shell seam. No private writer/editor implementation or mission mutation.
use super::*;
use crate::{
    mission_inspector::{Link, Source},
    mission_inspector_view::{self as pane, Pane},
};
use gpui_kit::AnyElement;

impl LocalViewer {
    pub(super) fn mission_context_parts(
        w: &mut Window,
        cx: &mut Context<Self>,
    ) -> (Entity<Pane>, Subscription) {
        let inspector = cx.new(Pane::new);
        let events = cx.subscribe_in(&inspector, w, |v, _, event: &pane::Event, w, cx| {
            match event {
                pane::Event::Close => {
                    if v.editor.update(cx, |e, cx| e.marked(w, cx)) {
                        return;
                    }
                    v.close_mission_context(w, cx);
                }
                pane::Event::Chat {
                    source,
                    id,
                    generation,
                } => {
                    let current = v.mission_context_input(cx);
                    if !current.active
                        || current.source.as_ref() != Some(source)
                        || !v
                            .mission_context
                            .read(cx)
                            .link_ready(source, id, *generation)
                        || !v.mission_navigation_ready(w, cx)
                    {
                        return;
                    }
                    if let Some(chat) = v
                        .state
                        .chats
                        .iter()
                        .find(|c| &c.id == id && !c.local_draft)
                        .cloned()
                    {
                        v.open(chat, w, cx);
                    }
                }
            }
            cx.notify();
        });
        (inspector, events)
    }
    fn mission_context_input(&self, cx: &App) -> pane::Input {
        let mut availability =
            "Mission membership is not available in the received Local metadata.";
        let source = self.selected.as_ref().and_then(|id| {
            let chat = self
                .state
                .chats
                .iter()
                .find(|c| &c.id == id && !c.local_draft)?;
            match self.state.mission_metadata.link(id) {
                Link::Unknown => None,
                Link::Malformed => {
                    availability =
                        "Mission membership metadata is invalid. No guessed lookup was made.";
                    None
                }
                Link::Unlinked => {
                    availability = "This chat is not in a mission.";
                    None
                }
                Link::Mission { project, mission } if chat.project_id.as_ref() == Some(project) => {
                    let home = self.mission_context.read(cx).home()?;
                    Some(Source {
                        home,
                        chat: id.clone(),
                        project: project.clone(),
                        mission: mission.clone(),
                        selection: self.generation,
                    })
                }
                _ => {
                    availability = "Mission project identity differs. No lookup was made.";
                    None
                }
            }
        });
        pane::Input {
            source,
            availability,
            metadata: self.state.mission_metadata.clone(),
            chats: self.state.chats.clone(),
            online: self.state.status.starts_with("Connected")
                || self.state.status.starts_with("Synthetic"),
            active: self.page == Page::Chat && !self.artifacts_open,
        }
    }
    pub(super) fn sync_mission_context(&mut self, cx: &mut Context<Self>) {
        let input = self.mission_context_input(cx);
        self.mission_context.update(cx, |p, cx| p.sync(input, cx));
    }
    fn close_mission_context(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        let focused = self.mission_context.read(cx).focus.contains_focused(w, cx);
        self.mission_context.update(cx, |p, cx| p.hide(cx));
        if focused && self.page == Page::Chat {
            self.focus_mission_chat_destination(w, cx);
        }
    }
    pub(super) fn mission_context_toggle(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if self.jump.is_some()
            || self.mission_open
            || self.add_project_open
            || self.page != Page::Chat
            || self.artifacts_open
            || self.editor.update(cx, |e, cx| e.marked(w, cx))
        {
            return;
        }
        self.sync_mission_context(cx);
        if self.mission_context.read(cx).visible {
            self.close_mission_context(w, cx);
        } else if self.mission_context.read(cx).source.is_some() {
            self.close_conversation_links(w, cx);
            self.close_workspace_changes(w, cx);
            self.mission_context.update(cx, |p, cx| p.show(w, cx));
        }
        cx.notify();
    }
    pub(super) fn mission_context_action(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let p = self.mission_context.read(cx);
        div()
            .capture_any_mouse_down(cx.listener(|v, _, w, cx| {
                if v.editor.update(cx, |e, cx| e.marked(w, cx)) {
                    cx.stop_propagation();
                }
            }))
            .when(p.source.is_some() || p.visible, |this| {
                this.child(
                    crate::ui::icon_action(
                        "mission-context-toggle",
                        "Mission context (⌘⌥M)",
                        AppIcon::Overview,
                        crate::ui::Action::Quiet,
                    )
                    .selected(p.visible)
                    .on_click(cx.listener(|v, _, w, cx| v.mission_context_toggle(w, cx))),
                )
            })
    }
    pub(super) fn mission_companion(
        &self,
        conversation: AnyElement,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        // Reserve the existing workbench's maximum physical sidebar extent
        // (workbench_view::sidebar). At the side-pane threshold its actual width
        // is232pt; below it this conservative budget always chooses the dock.
        let (side, extent) = crate::mission_inspector::placement(
            f32::from(w.viewport_size().width) - 232.,
            f32::from(w.viewport_size().height),
        );
        let open = self.mission_context.read(cx).visible;
        div()
            .id("chat-mission-companion")
            .test_support()
            .flex()
            .items_stretch()
            .size_full()
            .flex_1()
            .min_h_0()
            .min_w_0()
            .when(side, |d| d.flex_row())
            .when(!side, |d| d.flex_col())
            .child(
                div()
                    .id("mission-context-conversation")
                    .test_support()
                    .flex_1()
                    .min_h_0()
                    .min_w_0()
                    .overflow_hidden()
                    .child(conversation),
            )
            .when(open, |d| {
                d.child(
                    div()
                        .id("mission-context-region")
                        .test_support()
                        .capture_any_mouse_down(cx.listener(|v, _, w, cx| {
                            // Refuse before a sibling button can blur/commit the
                            // composer's preedit, not merely in its later click.
                            if v.editor.update(cx, |e, cx| e.marked(w, cx)) {
                                cx.stop_propagation();
                            }
                        }))
                        .flex_none()
                        .min_h_0()
                        .min_w_0()
                        .overflow_hidden()
                        .when(side, |d| {
                            d.w(px(extent)).h_full().border_l(appearance::hairline(w))
                        })
                        .when(!side, |d| {
                            d.h(px(extent)).w_full().border_t(appearance::hairline(w))
                        })
                        .border_color(cx.theme().border)
                        .child(self.mission_context.clone()),
                )
            })
            .into_any_element()
    }
}
