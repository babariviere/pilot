//! Daemon replacement keeps the GUI alive. The daemon's pause and exact
//! reservation own mutation admission/drain, not the GUI restart checkpoint.
use super::*;

impl LocalViewer {
    pub(super) fn advance_startup_daemon_upgrade(&mut self, cx: &mut Context<Self>) {
        // An explicit unchanged-runtime control must never turn into an upgrade.
        #[cfg(target_os = "macos")]
        if crate::daemon_menu::manual(cx) || crate::daemon_menu::active(cx) {
            return;
        }
        if self.restart_pending
            || self.daemon_upgrade_pending
            || !self.editor.read(cx).ready()
            || !self.settings.read(cx).state.loaded()
        {
            return;
        }
        let Some(updater) = self.settings.read(cx).updater.clone() else {
            return;
        };
        if let Some(binding) = updater.update(cx, |u, _| u.take_coordinated_daemon_request()) {
            if let Some(upgrade) = self.daemon_upgrade(cx) {
                upgrade.update(cx, |u, cx| u.request_coordinated(binding, cx));
            }
            return;
        }
        if !updater.read(cx).daemon_upgrade_ready() {
            return;
        }
        if let Some(upgrade) = self.daemon_upgrade(cx) {
            upgrade.update(cx, |upgrade, cx| upgrade.startup(cx));
        }
    }

    fn daemon_upgrade(
        &self,
        cx: &App,
    ) -> Option<Entity<crate::daemon_upgrade_view::DaemonUpgrade>> {
        self.settings.read(cx).daemon_upgrade.clone()
    }
    pub(super) fn begin_daemon_upgrade(&mut self, _: &mut Window, cx: &mut Context<Self>) {
        let Some(upgrade) = self.daemon_upgrade(cx) else {
            return;
        };
        #[cfg(target_os = "macos")]
        if crate::daemon_menu::active(cx) {
            upgrade.update(cx, |u, cx| {
                u.set_notice(
                    "Wait for the daemon control request to finish before upgrading.",
                    cx,
                )
            });
            return;
        }
        if !upgrade.read(cx).checkpoint_requested() {
            return;
        }
        if self
            .settings
            .read(cx)
            .updater
            .as_ref()
            .is_some_and(|u| !u.read(cx).coordinated_manual_daemon_allowed())
        {
            upgrade.update(cx, |u,cx| u.set_notice("A coordinated update owns daemon replacement. Inspect its proposal in Updates.",cx));
            return;
        }
        if self.restart_pending {
            upgrade.update(cx, |u, cx| {
                u.set_notice(
                    "An app restart is in progress. Cancel it before upgrading the daemon.",
                    cx,
                )
            });
            return;
        }
        // No GUI exit: composition, secondary forms, volatile delivery observations
        // and visuals stay with their existing owners. Never flush, resolve or resend
        // an Unknown just to obtain permission to replace the daemon.
        self.daemon_upgrade_pending = true;
        #[cfg(target_os = "macos")]
        cx.defer(crate::app_menu::refresh);
        upgrade.update(cx, |u, cx| u.begin(cx));
        cx.notify();
    }
    pub(super) fn advance_daemon_upgrade(&mut self, _: &mut Window, cx: &mut Context<Self>) {
        self.advance_startup_daemon_upgrade(cx);
        if self.daemon_upgrade_pending
            && self
                .daemon_upgrade(cx)
                .is_none_or(|u| !u.read(cx).active() && !u.read(cx).checkpoint_requested())
        {
            let succeeded = self.daemon_upgrade(cx).is_some_and(|u| {
                u.read(cx).status() == crate::daemon_upgrade_view::Status::Succeeded
            });
            if let Some(updater) = self.settings.read(cx).updater.clone() {
                updater.update(cx, |u, cx| u.coordinated_daemon_finished(succeeded, cx));
            }
            self.finish_daemon_checkpoint(cx);
        }
    }
    pub(super) fn finish_daemon_checkpoint(&mut self, cx: &mut Context<Self>) {
        // Unknown fences another native handoff in DaemonUpgrade, not unrelated UI.
        self.daemon_upgrade_pending = false;
        #[cfg(target_os = "macos")]
        cx.defer(crate::app_menu::refresh);
        cx.notify();
    }

    pub(super) fn daemon_update_notice(&self, cx: &App) -> Option<&'static str> {
        self.daemon_upgrade(cx)?.read(cx).startup_notice()
    }
}
