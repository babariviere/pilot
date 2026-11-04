//! Insights report chat: the header entry, its access panel and mission setup.
//! LocalViewer owns the writer; the panel only emits explicit user actions.
use super::*;
use crate::insights_view::{Event as InsightsEvent, Panel, Scope};
use gpui_kit::component::WindowExt as _;

impl LocalViewer {
    /// Header entry for a report chat: its scope, backlog and decisions.
    pub(super) fn insights_action(&self, cx: &mut Context<Self>) -> Option<gpui_kit::AnyElement> {
        let chat = self
            .selected
            .as_ref()
            .and_then(|id| self.state.chats.iter().find(|c| &c.id == id))
            .filter(|c| c.insights && !c.local_draft)?;
        let id = chat.id.clone();
        Some(
            crate::ui::action(
                "insights-access",
                "Insights access",
                crate::ui::Action::Quiet,
            )
            .small()
            .tooltip("Scope, backlog and finding decisions")
            .on_click(cx.listener(move |v, _, w, cx| {
                if v.editor.update(cx, |e, cx| e.marked(w, cx)) {
                    return;
                }
                v.open_insights(
                    Scope::Chat {
                        session: id.clone(),
                    },
                    w,
                    cx,
                );
            }))
            .into_any_element(),
        )
    }

    /// Explicit setup for an active mission, from its overview menu.
    pub(super) fn open_insights_setup(
        &mut self,
        mission: String,
        mission_title: String,
        project: String,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(path) = self
            .state
            .projects
            .iter()
            .find(|p| p.id == project)
            .map(|p| p.path.clone())
        else {
            self.nav_error = Some("The mission's project isn't available on this Local.");
            cx.notify();
            return;
        };
        self.open_insights(
            Scope::Setup {
                mission,
                mission_title,
                project,
                path,
            },
            w,
            cx,
        );
    }

    pub(super) fn open_insights(&mut self, scope: Scope, w: &mut Window, cx: &mut Context<Self>) {
        let Some(options) = self.usage_options.clone() else {
            return;
        };
        let model_label = match &scope {
            Scope::Chat { session } => self
                .state
                .chats
                .iter()
                .find(|c| &c.id == session)
                .and_then(|c| c.model_configuration.as_ref())
                .and_then(|m| m.model.clone()),
            Scope::Setup { .. } => None,
        };
        let panel = match &self.insights {
            Some((p, _)) if p.read(cx).matches(&scope, &options) => {
                let p = p.clone();
                p.update(cx, |p, cx| {
                    p.visible = true;
                    p.refresh(cx);
                });
                p
            }
            _ => {
                if self.insights.is_some() {
                    self.close_insights(w, cx);
                }
                let panel = cx.new(|cx| Panel::new(scope, options, model_label, cx));
                let events = cx.subscribe_in(&panel, w, |v, panel, event, w, cx| {
                    v.insights_event(panel, event, w, cx)
                });
                self.insights = Some((panel.clone(), events));
                panel
            }
        };
        let (book, reply) = (self.insights_book.clone(), self.insights_reply.clone());
        panel.update(cx, |p, cx| p.accept(book.as_ref(), reply.as_ref(), cx));
        self.insights_return = w.focused(cx);
        Panel::open(panel, w, cx);
    }

    fn insights_event(
        &mut self,
        panel: &Entity<Panel>,
        event: &InsightsEvent,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.insights.as_ref().is_none_or(|(p, _)| p != panel) {
            return;
        }
        match event {
            InsightsEvent::Close => self.close_insights(w, cx),
            InsightsEvent::Write { request, action } => {
                let sent = self.writer.as_ref().is_some_and(|writer| {
                    writer.command(crate::interaction::WriteCommand::Insights {
                        request: *request,
                        action: action.clone(),
                    })
                });
                if !sent {
                    panel.update(cx, |p, cx| p.not_sent(cx));
                }
            }
            InsightsEvent::OpenBacklog(mission) => {
                let mission = mission.clone();
                self.close_insights(w, cx);
                self.show_chat_mission(&mission, w, cx);
            }
            InsightsEvent::OpenChat(id) => {
                let mission = match &panel.read(cx).scope {
                    Scope::Setup { mission, .. } => Some(mission.clone()),
                    Scope::Chat { .. } => None,
                };
                self.close_insights(w, cx);
                if let Some(chat) = self
                    .state
                    .chats
                    .iter()
                    .find(|c| &c.id == id && !c.local_draft)
                    .cloned()
                {
                    self.open(chat, w, cx);
                } else if let Some(mission) = mission {
                    // The new chat appears with the next summary; its mission lists it.
                    self.show_chat_mission(&mission, w, cx);
                }
            }
        }
    }

    pub(super) fn close_insights(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        let Some((panel, _)) = &self.insights else {
            return;
        };
        let panel = panel.clone();
        if !panel.read(cx).visible {
            return;
        }
        let owned = panel.read(cx).owns_focus(w, cx);
        w.close_dialog(cx);
        panel.update(cx, |p, cx| {
            p.visible = false;
            cx.notify();
        });
        if owned && let Some(focus) = self.insights_return.take() {
            focus.focus(w, cx);
        }
        cx.notify();
    }
}
