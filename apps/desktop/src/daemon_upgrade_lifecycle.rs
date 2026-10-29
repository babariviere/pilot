//! Explicit daemon replacement shares the existing exact UI durability checkpoint,
//! never the GUI install/COMMIT path. Unknown outcomes remain fenced for inspection.
use super::*;

impl LocalViewer {
    fn daemon_upgrade(
        &self,
        cx: &App,
    ) -> Option<Entity<crate::daemon_upgrade_view::DaemonUpgrade>> {
        self.settings.read(cx).daemon_upgrade.clone()
    }
    pub(super) fn begin_daemon_upgrade(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(upgrade) = self.daemon_upgrade(cx) else {
            return;
        };
        if self.restart_pending {
            upgrade.update(cx, |u, cx| {
                u.set_notice(
                    "Another update checkpoint is in progress. No daemon upgrade was started.",
                    cx,
                )
            });
            return;
        }
        if !upgrade.read(cx).checkpoint_requested() {
            return;
        }
        if self
            .editor
            .update(cx, |editor, cx| editor.marked(window, cx))
        {
            upgrade.update(cx, |u, cx| {
                u.set_notice(
                    "Finish text composition before upgrading. Nothing was discarded.",
                    cx,
                )
            });
            return;
        }
        if self
            .settings
            .read(cx)
            .updater
            .as_ref()
            .is_some_and(|u| u.read(cx).unsaved_access(cx))
        {
            upgrade.update(cx, |u, cx| {
                u.set_notice(
                    "Use or clear the unsaved update access field before upgrading. It is never written to disk.",
                    cx,
                )
            });
            return;
        }
        if let Some(blocker) = self.update_blocker(window, cx) {
            upgrade.update(cx, |u, cx| u.set_notice(blocker.message(), cx));
            return;
        }
        if !crate::visual_runtime::fence_for_restart() {
            upgrade.update(cx,|u,cx|u.set_notice("Close the active native visual before upgrading. Its cleanup must finish first.",cx));
            return;
        }
        let Some(generation) = self.restart_generation.checked_add(1) else {
            crate::visual_runtime::release_restart_fence();
            upgrade.update(cx, |u, cx| {
                u.set_notice(
                    "A new checkpoint could not be created. No daemon upgrade was started.",
                    cx,
                )
            });
            return;
        };
        if !self.editor.update(cx, |e, cx| {
            e.begin_update_checkpoint(generation, window, cx)
        }) {
            crate::visual_runtime::release_restart_fence();
            upgrade.update(cx,|u,cx|u.set_notice("Finish text composition and resolve unconfirmed deliveries before upgrading. Drafts are retained.",cx));
            return;
        }
        self.restart_generation = generation;
        self.restart_pending = true;
        self.daemon_upgrade_pending = true;
        self.settings.update(cx, |o, cx| {
            if !o.state.persisted() {
                o.persist_update_checkpoint(cx);
            }
            o.restart_locked = true;
            cx.notify();
        });
        self.restart_timeout=Some(cx.spawn_in(window,async move|view,cx|{
            cx.background_executor().timer(Duration::from_secs(15)).await;
            let _=view.update_in(cx,|view,_,cx|{
                if view.daemon_upgrade_pending && view.restart_generation==generation
                    && let Some(upgrade)=view.daemon_upgrade(cx)
                    && !upgrade.read(cx).active() && !upgrade.read(cx).uncertain() {
                    upgrade.update(cx,|u,cx|u.set_notice("Checkpoint durability was not acknowledged. No daemon upgrade was started.",cx));
                    view.finish_daemon_checkpoint(cx);
                }
            });
        }));
        self.advance_daemon_upgrade(window, cx);
        cx.notify();
    }
    pub(super) fn advance_daemon_upgrade(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.daemon_upgrade_pending {
            return;
        }
        let Some(upgrade) = self.daemon_upgrade(cx) else {
            return;
        };
        if upgrade.read(cx).uncertain() {
            self.restart_timeout = None;
            return;
        }
        if upgrade.read(cx).active() {
            return;
        }
        if !upgrade.read(cx).checkpoint_requested() {
            self.finish_daemon_checkpoint(cx);
            return;
        }
        let settings_ready = self.settings.read(cx).state.durability_token().is_some();
        let editor_ready = self.editor.update(cx, |e, cx| e.update_receipt(window, cx))
            == Some(self.restart_generation);
        if settings_ready && editor_ready {
            self.restart_timeout = None;
            upgrade.update(cx, |u, cx| u.begin(cx));
        }
    }
    pub(super) fn finish_daemon_checkpoint(&mut self, cx: &mut Context<Self>) {
        self.daemon_upgrade_pending = false;
        self.restart_pending = false;
        self.restart_timeout = None;
        self.editor.update(cx, |e, cx| e.end_update_checkpoint(cx));
        self.settings.update(cx, |o, cx| {
            o.restart_locked = false;
            cx.notify();
        });
        crate::visual_runtime::release_restart_fence();
        cx.notify();
    }
}
