//! Native controls opened by composer slash commands, through the same guarded
//! handlers as their header, menu and strip actions. Nothing is sent.
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
            Action::Help => {
                self.open_shortcuts(w, cx);
                self.shortcuts_window
                    .map(|_| ())
                    .ok_or("Keyboard shortcuts can't open right now.")
            }
            Action::Changes => {
                chat.ok_or("Changes open from an existing chat.")?;
                if self.workspace_changes.is_none() {
                    self.toggle_workspace_changes(w, cx);
                }
                self.workspace_changes
                    .as_ref()
                    .map(|_| ())
                    .ok_or("Changes can't open right now.")
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
}
