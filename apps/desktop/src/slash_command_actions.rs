//! Native controls opened by composer slash commands, through the same guarded
//! handlers as their header, menu and strip actions. No chat message is sent.
use super::*;
use crate::slash_commands::Action;

impl LocalViewer {
    pub(crate) fn run_slash_action(
        &mut self,
        action: Action,
        key: &str,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) -> Result<(), &'static str> {
        if self.page != Page::Chat || self.editor.read(cx).navigation_key() != Some(key) {
            return Err("The chat changed, so nothing was opened.");
        }
        let chat = key
            .strip_prefix("chat:")
            .filter(|id| self.selected.as_deref() == Some(*id))
            .map(str::to_owned);
        match action {
            Action::Compact => {
                self.compact_slash(chat.ok_or("Open an existing chat first.")?, w, cx)
            }
            Action::Help => {
                self.open_shortcuts(w, cx);
                self.shortcuts_window
                    .map(|_| ())
                    .ok_or("Keyboard shortcuts can't open right now.")
            }
            Action::Artifacts => {
                chat.ok_or("Artifacts open from an existing chat.")?;
                if self.state.artifacts.is_empty() {
                    return Err("This chat has no artifacts yet.");
                }
                if !self.artifacts_open {
                    self.toggle_artifacts(w, cx);
                }
                if self.artifacts_open {
                    Ok(())
                } else {
                    Err("Artifacts can't open right now.")
                }
            }
            Action::Jobs => {
                let chat = chat.ok_or("Jobs belong to an existing chat.")?;
                if !self.state.chats.iter().any(|c| {
                    c.id == chat && !c.archived && !c.local_draft && !c.running_jobs.is_empty()
                }) {
                    return Err("No background jobs are running in this chat.");
                }
                let entry = self
                    .editor
                    .read(cx)
                    .jobs_entry()
                    .and_then(|view| view.downcast::<session_jobs_tray::Entry>().ok())
                    .ok_or("Jobs can't open right now.")?;
                entry.update(cx, |entry, cx| entry.expand(&chat, cx));
                Ok(())
            }
            // The composer owns its model menu.
            Action::Model => Err("The model menu belongs to the composer."),
        }
    }

    fn compact_slash(
        &mut self,
        id: String,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) -> Result<(), &'static str> {
        if self.subagent.is_some() || !self.editor.update(cx, |e, cx| e.compact_ready(w, cx)) {
            return Err("Resolve pending work or delivery before compacting.");
        }
        if let Some(reason) = self.chat_actions.read(cx).blocked_reason(&id) {
            return Err(reason);
        }
        let chat = self
            .state
            .chats
            .iter()
            .find(|c| c.id == id && !c.archived && !c.local_draft)
            .cloned()
            .ok_or("This chat is unavailable.")?;
        let target = self
            .chat_actions
            .read(cx)
            .target(chat)
            .ok_or("Local is unavailable.")?;
        if !self.chat_action_ready(&target, w, cx) {
            return Err("Load this chat before compacting.");
        }
        let rx = self
            .chat_actions
            .read(cx)
            .worker
            .as_ref()
            .ok_or("Local is unavailable.")?
            .inspect(target)?;
        let generation = self.generation;
        self.chat_actions.update(cx, |a, cx| {
            a.compact_check = Some(id.clone());
            cx.notify();
        });
        cx.spawn_in(w, async move |view, cx| {
            let result = rx.recv().await.unwrap_or(Err("Local is unavailable."));
            let _ = view.update_in(cx, |v, w, cx| {
                if v.chat_actions.read(cx).compact_check.as_ref() != Some(&id) {
                    return;
                }
                v.chat_actions.update(cx, |a, _| a.compact_check = None);
                // A read admitted for an old selection can never start compaction.
                if v.generation != generation
                    || v.page != Page::Chat
                    || v.selected.as_ref() != Some(&id)
                {
                    return;
                }
                match result {
                    Ok(e)
                        if e.can_compact
                            && v.chat_action_ready(&e.target, w, cx)
                            && v.editor
                                .update(cx, |editor, cx| editor.compact_ready(w, cx)) =>
                    {
                        v.chat_actions.update(cx, |a, cx| {
                            a.submit(e, crate::chat_actions::Action::Compact, w, cx)
                        });
                        v.sync_chat_action_permission(cx);
                    }
                    Ok(_) => v.chat_actions.update(cx, |a, cx| {
                        a.error("Compaction requires a healthy idle chat.", cx)
                    }),
                    Err(reason) => v.chat_actions.update(cx, |a, cx| a.error(reason, cx)),
                }
            });
        })
        .detach();
        Ok(())
    }
}
