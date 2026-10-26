//! Row/menu glue. Never selects or navigates to the target chat.
use super::*;
use crate::chat_actions::{Action, Evidence, Target};
use gpui_kit::component::menu::{PopupMenu, PopupMenuItem};

impl LocalViewer {
    fn chat_action_ready(
        &mut self,
        target: &Target,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let valid = self
            .chat_actions
            .read(cx)
            .options
            .as_ref()
            .is_some_and(|o| target.matches(o))
            && (self.state.status.starts_with("Connected")
                || self.state.status.starts_with("Synthetic"))
            && self.state.list_loaded
            && self.state.chats.iter().any(|c| c == &target.chat)
            && target.chat.project_id.as_ref().is_none_or(|id| {
                self.state.projects_loaded && self.state.projects.iter().any(|p| &p.id == id)
            })
            && !self.mission_open
            && !self.mission.read(cx).pending()
            && !self.add_project_open
            && self.jump.is_none();
        valid && self.project_choices_ready(w, cx)
    }
    pub(super) fn chat_row_guard(&mut self, w: &mut Window, cx: &mut Context<Self>) -> bool {
        self.project_choices_ready(w, cx)
    }
    pub(super) fn chat_actions_menu(
        owner: gpui_kit::WeakEntity<Self>,
        chat: Chat,
        menu: PopupMenu,
        w: &mut Window,
        cx: &mut Context<PopupMenu>,
    ) -> PopupMenu {
        let admission = owner
            .update(cx, |v, cx| {
                let target = v
                    .chat_actions
                    .read(cx)
                    .target(chat.clone())
                    .ok_or("Local chat actions are unavailable.")?;
                if !v.chat_action_ready(&target, w, cx) {
                    return Err("Chat actions are unavailable. Check Local and reopen this menu.");
                }
                let known_ack = v.chat_actions.read(cx).inspection_ack(&target.chat.id);
                let rx = v
                    .chat_actions
                    .read(cx)
                    .worker
                    .as_ref()
                    .ok_or("Local chat actions are unavailable.")?
                    .inspect(target)?;
                Ok((rx, known_ack))
            })
            .unwrap_or(Err("The source window is unavailable."));
        let (rx, known_ack) = match admission {
            Ok(rx) => rx,
            Err(e) => return menu.item(PopupMenuItem::new(e).disabled(true)),
        };
        cx.spawn_in(w, async move |popup, cx| {
            let result = rx
                .recv()
                .await
                .unwrap_or(Err("Local chat actions are unavailable."));
            let _ = popup.update_in(cx, |popup, w, cx| {
                popup.rebuild(w, cx, |menu, _, cx| match result {
                    Err(error) => menu.item(PopupMenuItem::new(error).disabled(true)),
                    Ok(evidence) => {
                        let _ = owner.update(cx, |v, cx| {
                            v.chat_actions
                                .update(cx, |a, _| a.inspected(&evidence, known_ack));
                            v.sync_chat_action_permission(cx);
                        });
                        if evidence.stamp["control"] == true {
                            return menu.label("Retained history is read-only");
                        }
                        let reason = owner
                            .update(cx, |v, cx| {
                                v.chat_actions
                                    .read(cx)
                                    .blocked_reason(&evidence.target.chat.id)
                            })
                            .unwrap_or(Some("The source window is unavailable."));
                        let blocked = reason.is_some();
                        let a = owner.clone();
                        let archive = evidence.clone();
                        let b = owner.clone();
                        let convert = evidence.clone();
                        menu.max_w(px(310.))
                            .label(SharedString::from(evidence.target.chat.title.clone()))
                            .when_some(reason, |menu, reason| menu.label(reason))
                            .item(
                                PopupMenuItem::new(if evidence.archive {
                                    if evidence.can_archive {
                                        "Archive"
                                    } else {
                                        "Archive (Stop first)"
                                    }
                                } else {
                                    "Restore"
                                })
                                .disabled(blocked || !evidence.can_archive)
                                .on_click(move |_, w, cx| {
                                    let _ = a.update(cx, |v, cx| {
                                        v.chat_row_action(archive.clone(), Action::Archive, w, cx)
                                    });
                                }),
                            )
                            .separator()
                            .item(
                                PopupMenuItem::new("Make a mission…")
                                    .disabled(blocked || !evidence.can_convert)
                                    .on_click(move |_, w, cx| {
                                        let _ = b.update(cx, |v, cx| {
                                            v.chat_row_action(
                                                convert.clone(),
                                                Action::Convert,
                                                w,
                                                cx,
                                            )
                                        });
                                    }),
                            )
                    }
                });
            });
        })
        .detach();
        menu.item(PopupMenuItem::new("Checking chat actions…").disabled(true))
    }
    fn chat_row_action(
        &mut self,
        evidence: Evidence,
        action: Action,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.chat_action_ready(&evidence.target, w, cx) {
            self.chat_actions.update(cx, |v, cx| {
                v.error(
                    "The original chat changed or Local is unavailable. Nothing was submitted.",
                    cx,
                )
            });
            return;
        }
        if self.chat_actions.read(cx).blocked(&evidence.target.chat.id) {
            return;
        }
        match action {
            Action::Archive if evidence.can_archive => {
                // No capture/select/stop/discard: disable sends while the exact selected
                // target archives, leaving its editor/draft and transcript mounted.
                self.chat_actions
                    .update(cx, |a, cx| a.submit(evidence, w, cx));
                self.sync_chat_action_permission(cx);
            }
            Action::Convert if evidence.can_convert => {
                self.open_row_mission(evidence.target, w, cx)
            }
            _ => {}
        }
    }
    fn open_row_mission(&mut self, target: Target, w: &mut Window, cx: &mut Context<Self>) {
        let Some(project) = target.chat.project_id else {
            return;
        };
        if self.writer.is_none()
            || !self.project_choices_ready(w, cx)
            || !self.editor.update(cx, |e, cx| e.capture_navigation(w, cx))
        {
            return;
        }
        // Do not select the clicked row, overwrite an open form, or derive the
        // operation from whichever chat happens to be selected at confirmation.
        self.projects_open = false;
        self.mission_return = w.focused(cx);
        self.mission_open = true;
        self.mission.update(cx, |form, cx| {
            form.open(
                crate::mission_conversion::Target {
                    source: target.chat.id,
                    project,
                    generation: self.generation,
                },
                &target.chat.title,
                w,
                cx,
            )
        });
        cx.notify();
    }
    pub(super) fn sync_chat_action_permission(&mut self, cx: &mut Context<Self>) {
        self.chat_actions
            .update(cx, |a, _| a.observe(&self.state.chats));
        let Some(chat) = self
            .selected
            .as_ref()
            .and_then(|id| self.state.chats.iter().find(|c| &c.id == id))
        else {
            return;
        };
        let writable = chat.writable && !self.chat_actions.read(cx).read_only(&chat.id);
        self.editor.update(cx, |e, cx| {
            e.permission(writable, chat.busy || self.state.queued > 0, cx)
        });
    }
}
