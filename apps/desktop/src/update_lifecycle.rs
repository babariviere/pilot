//! Explicit install intent, separate from ordinary Quit. No timer is a flush ACK.
use super::*;
use pilot_desktop_updater::{Flush, Runtime, Safety, State};

impl LocalViewer {
    fn updater(&self, cx: &App) -> Option<Entity<crate::updates_view::Updates>> {
        self.settings.read(cx).updater.clone()
    }
    pub(super) fn connect_updates(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.update_events.push(cx.subscribe_in(
            &self.settings,
            window,
            |view, _, event, window, cx| match event {
                crate::updates_view::Event::Restart => view.begin_update_restart(window, cx),
                crate::updates_view::Event::Changed => view.advance_update_restart(window, cx),
            },
        ));
        self.update_events.push(
            cx.observe_in(&self.settings, window, |view, _, window, cx| {
                view.advance_update_restart(window, cx)
            }),
        );
    }
    fn secondary_update_safe(&self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        !self.mission_open
            && !self.add_project_open
            && self.jump.is_none()
            && self.queue_forms.is_empty()
            && self.queue_open.is_none()
            && self.chat_actions.read(cx).restart_safe()
            && self.mission.read(cx).restart_safe(cx)
            && self.missions.read(cx).restart_safe(cx)
            && !self.add_project.read(cx).pending
            && !self.add_project.read(cx).choosing
            && self.add_project.read(cx).path.is_none()
            && self.project_choices_ready(window, cx)
    }
    fn begin_update_restart(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(updater) = self.updater(cx) else {
            return;
        };
        if self.restart_pending {
            return;
        }
        if !matches!(
            updater.read(cx).state(),
            Some(State::ReadyToRestart(_) | State::Deferred { .. })
        ) {
            return;
        }
        if updater.read(cx).unsaved_access(cx) {
            updater.update(cx,|u,cx|u.defer("Use or clear the unsaved update access field before installing. It is never written to disk.",cx));
            return;
        }
        let settings = &self.settings.read(cx).state;
        if !settings.loaded()
            || settings.dirty()
            || settings.saving()
            || settings.unconfirmed()
            || settings.error().is_some()
            || self
                .settings
                .read(cx)
                .models
                .as_ref()
                .is_some_and(|m| m.read(cx).unsettled(cx))
            || !self.secondary_update_safe(window, cx)
        {
            updater.update(cx,|u,cx|u.defer("Finish or preserve secondary editor changes and pending operations before installing. Nothing was discarded.",cx));
            return;
        }
        if !crate::visual_runtime::fence_for_restart() {
            updater.update(cx,|u,cx|u.defer("A native visual helper is still active or its cleanup is unconfirmed. Close the visual and retry; no process was stopped.",cx));
            return;
        }
        let Some(generation) = self.restart_generation.checked_add(1) else {
            crate::visual_runtime::release_restart_fence();
            return;
        };
        self.restart_generation = generation;
        if !self.editor.update(cx, |e, cx| {
            e.begin_update_checkpoint(generation, window, cx)
        }) {
            crate::visual_runtime::release_restart_fence();
            updater.update(cx,|u,cx|u.defer("Finish preedit and resolve pending or unsaved drafts before installing. All text is retained.",cx));
            return;
        }
        self.restart_pending = true;
        self.settings.update(cx, |owner, cx| {
            if !owner.state.persisted() {
                owner.persist_update_checkpoint(cx);
            }
            owner.restart_locked = true;
            cx.notify();
        });
        updater.update(cx, |u, cx| {
            u.fenced = true;
            u.notice = Some("Saving an exact draft/outbox/preferences checkpoint…");
            cx.notify();
        });
        self.restart_timeout=Some(cx.spawn_in(window,async move |view,cx|{
            cx.background_executor().timer(Duration::from_secs(15)).await;
            let _=view.update_in(cx,|view,_,cx|{
                if view.restart_pending && view.restart_generation==generation
                    && view.updater(cx).is_some_and(|u|matches!(u.read(cx).state(),Some(State::ReadyToRestart(_)|State::Deferred{..}))) {
                    view.end_update_restart("Checkpoint durability was not acknowledged. Installation is deferred; drafts remain retained.",cx);
                }
            });
        }));
        self.advance_update_restart(window, cx);
        cx.notify();
    }
    fn safety(&self, window: &mut Window, cx: &mut Context<Self>) -> Option<Safety> {
        if !self.restart_pending {
            return None;
        }
        let settings_token = self.settings.read(cx).state.durability_token()?;
        let generation = self
            .editor
            .update(cx, |e, cx| e.update_receipt(window, cx))?;
        if generation != self.restart_generation {
            return None;
        }
        let receipt = Flush {
            requested: generation,
            acknowledged: Some(generation),
            failed: false,
        };
        Some(Safety {
            drafts: receipt,
            deliveries: receipt,
            settings: Flush {
                requested: settings_token,
                acknowledged: Some(settings_token),
                failed: false,
            },
            has_preedit: false,
            active_work: false,
            runtime: Runtime::Unknown,
            admissions_fenced: true,
        })
    }
    pub(super) fn advance_update_restart(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.acknowledge_update_startup(cx);
        #[cfg(feature = "native-probes")]
        if !self.restart_pending
            && pilot_desktop_updater::fixture::enabled()
            && let Some(updater) = self.updater(cx)
        {
            let authenticated = matches!(
                updater.read(cx).state(),
                Some(State::Available(_) | State::ReadyToRestart(_))
            );
            let draft_ready = authenticated
                && self
                    .editor
                    .update(cx, |editor, cx| editor.update_fixture_draft(window, cx));
            if updater.update(cx, |u, cx| u.drive_fixture(draft_ready, cx)) {
                self.begin_update_restart(window, cx);
            }
        }
        if !self.restart_pending {
            return;
        }
        let Some(updater) = self.updater(cx) else {
            return;
        };
        let state = updater.read(cx).state().cloned();
        match state {
            Some(State::ExitAuthorized) => {
                self.restart_timeout = None;
                cx.quit();
            }
            Some(State::ReadyToRestart(_)) => {
                if !updater.read(cx).fenced {
                    self.end_update_restart("Preparation cancelled. No installation is armed.", cx);
                    return;
                }
                if let Some(safety) = self.safety(window, cx) {
                    updater.update(cx, |u, cx| u.prepare(safety, cx));
                }
            }
            Some(State::ExitPrepared) => {
                if let Some(safety) = self.safety(window, cx) {
                    updater.update(cx, |u, cx| u.commit(safety, cx));
                } else {
                    updater.update(cx, |u, cx| {
                        u.cancel_prepared(
                            "Fresh checkpoint acknowledgement is missing. No COMMIT will be sent.",
                            cx,
                        )
                    });
                }
            }
            Some(State::Deferred { .. } | State::Failed(_) | State::Cancelled) => self
                .end_update_restart(
                    "Installation is deferred. The app and existing daemon were left unchanged.",
                    cx,
                ),
            Some(State::RecoveryRequired(_)) => {
                self.restart_timeout = None;
                cx.notify();
            }
            _ => {}
        }
    }
    pub(super) fn acknowledge_update_startup(&mut self, cx: &mut Context<Self>) {
        let Some(receipt) = crate::bundled_runtime::update_receipt() else {
            return;
        };
        if self.editor.read(cx).ready()
            && self.settings.read(cx).state.persisted()
            && let Some(updater) = self.updater(cx)
        {
            updater.update(cx, |u, cx| u.acknowledge_startup(receipt, cx));
        }
    }
    fn end_update_restart(&mut self, message: &'static str, cx: &mut Context<Self>) {
        self.restart_pending = false;
        self.restart_timeout = None;
        self.editor.update(cx, |e, cx| e.end_update_checkpoint(cx));
        self.settings.update(cx, |o, cx| {
            o.restart_locked = false;
            cx.notify();
        });
        crate::visual_runtime::release_restart_fence();
        if let Some(updater) = self.updater(cx) {
            updater.update(cx, |u, cx| u.defer(message, cx));
        }
        cx.notify();
    }
}
