//! Explicit install intent, separate from ordinary Quit. No timer is a flush ACK.
use super::*;
use gpui_kit::EntityInputHandler;
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
            // Preedit in secondary fields is a veto, never committed or discarded.
            && !self
                .chats
                .read(cx)
                .query_input()
                .update(cx, |q, cx| q.marked_text_range(window, cx).is_some())
            && !self.missions.update(cx, |m, cx| m.brief_marked(window, cx))
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
        if updater.read(cx).choosing_local() {
            updater.update(cx, |u, cx| {
                u.defer("Finish choosing a local build before reloading. Nothing was staged or discarded.", cx)
            });
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
        // Like the Swift app, pause agents once their current tool calls finish. Input is not
        // fenced while waiting; the updater emits Restart again once every agent has paused.
        if !updater.update(cx, |u, cx| u.ensure_agents_paused(cx)) {
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
        self.restore_update_navigation(window, cx);
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
                    // The selection at the durable checkpoint, not at the click, is restored.
                    let navigation = self.update_navigation(cx);
                    updater.update(cx, |u, cx| {
                        u.navigation(navigation);
                        u.prepare(safety, cx)
                    });
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
                updater.update(cx, |u, _| u.release_agents());
                cx.notify();
            }
            _ => {}
        }
    }
    /// Passive selection only. The writer's durable outbox is authoritative; a reload
    /// never stores or replays a send, queue edit, mission inspector or scroll position.
    fn update_navigation(&self, cx: &App) -> serde_json::Value {
        use crate::navigation::Target;
        use serde_json::json;
        let location = self.location(cx);
        let target = match &location.target {
            Target::Home => json!({"target": "home"}),
            Target::Missions | Target::Mission(_) => json!({"target": "missions"}),
            Target::Inbox(filter) => json!({"target": "inbox", "id": filter}),
            Target::Project(id) => json!({"target": "project", "id": id}),
            Target::Chat(id) => json!({"target": "chat", "id": id}),
            Target::Draft(key) => json!({"target": "draft", "id": key}),
            Target::Empty => serde_json::Value::Null,
        };
        json!({"location": target, "scope": location.scope})
    }
    /// Woken by projection, writer and update events. The receipt token is taken once,
    /// only after projects, chats and drafts are loaded, so it is never lost to an early wake.
    pub(super) fn restore_update_navigation(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.state.projects_loaded || !self.state.list_loaded || !self.editor.read(cx).ready() {
            return;
        }
        let Some(value) = crate::bundled_runtime::take_update_navigation() else {
            return;
        };
        self.apply_update_navigation(&value, window, cx);
    }
    fn apply_update_navigation(
        &mut self,
        value: &serde_json::Value,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        const UNAVAILABLE: &str =
            "The previous selection is unavailable. Drafts and delivery evidence are retained.";
        // Navigation since launch is newer intent. The token is consumed, never deferred.
        if self.link_epoch != 0
            || self.location(cx) != crate::navigation::Location::home()
            || self.jump.is_some()
            || self.mission_open
            || self.add_project_open
        {
            return false;
        }
        let Some(location) = update_location(value) else {
            return false;
        };
        if location == self.location(cx) {
            return true;
        }
        if !self.can_restore(&location, cx) {
            self.nav_error = Some(UNAVAILABLE);
            cx.notify();
            return false;
        }
        // The ordinary guarded route: preedit and editor capture can still refuse.
        if !self.prepare_navigation(window, cx) {
            return false;
        }
        let restored = self.restore_location(&location, window, cx);
        if restored {
            self.did_navigate(cx);
        } else {
            self.nav_error = Some(UNAVAILABLE);
            cx.notify();
        }
        restored
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

/// Validates a receipt selection token. Malformed or unknown tokens restore nothing.
fn update_location(value: &serde_json::Value) -> Option<crate::navigation::Location> {
    use crate::navigation::{Location, Target};
    use serde_json::Value;
    let id = |value: &Value| match value {
        Value::Null => Some(None),
        Value::String(id) if crate::local_model::valid_id(id) => Some(Some(id.clone())),
        _ => None,
    };
    let scope = id(&value["scope"])?;
    let token = &value["location"];
    let target = match token["target"].as_str()? {
        "home" => Target::Home,
        "missions" => Target::Missions,
        "inbox" => Target::Inbox(id(&token["id"])?),
        "project" => Target::Project(id(&token["id"])??),
        "chat" => Target::Chat(id(&token["id"])??),
        "draft" => Target::Draft(
            token["id"]
                .as_str()
                .filter(|key| {
                    key.starts_with("new:")
                        && key.len() <= 256
                        && !key.chars().any(char::is_control)
                })?
                .into(),
        ),
        _ => return None,
    };
    Some(Location { scope, target })
}

#[cfg(test)]
mod tests {
    use super::update_location;
    use crate::navigation::{Location, Target};
    use serde_json::json;
    #[test]
    fn update_navigation_tokens_are_passive_and_validated() {
        let at = |target, scope: Option<&str>| Location {
            scope: scope.map(Into::into),
            target,
        };
        for (value, expected) in [
            (
                json!({"location":{"target":"home"},"scope":null}),
                at(Target::Home, None),
            ),
            (
                json!({"location":{"target":"missions"},"scope":"a"}),
                at(Target::Missions, Some("a")),
            ),
            (
                json!({"location":{"target":"inbox","id":null}}),
                at(Target::Inbox(None), None),
            ),
            (
                json!({"location":{"target":"inbox","id":"b"}}),
                at(Target::Inbox(Some("b".into())), None),
            ),
            (
                json!({"location":{"target":"project","id":"a"},"scope":"a"}),
                at(Target::Project("a".into()), Some("a")),
            ),
            (
                json!({"location":{"target":"chat","id":"chat-1"}}),
                at(Target::Chat("chat-1".into()), None),
            ),
            (
                json!({"location":{"target":"draft","id":"new:日本語"}}),
                at(Target::Draft("new:日本語".into()), None),
            ),
        ] {
            assert_eq!(update_location(&value), Some(expected), "{value}");
        }
        for value in [
            serde_json::Value::Null,
            json!({"location":null}),
            json!({"location":{"target":"send","id":"a"}}),
            json!({"location":{"target":"mission","id":"a"}}),
            json!({"location":{"target":"chat"}}),
            json!({"location":{"target":"chat","id":"../a"}}),
            json!({"location":{"target":"project","id":"a"},"scope":7}),
            json!({"location":{"target":"home"},"scope":"x/y"}),
            json!({"location":{"target":"draft","id":"chat:a"}}),
            json!({"location":{"target":"draft","id":"new:\u{7}"}}),
            json!({"location":{"target":"draft","id":format!("new:{}", "a".repeat(256))}}),
        ] {
            assert_eq!(update_location(&value), None, "{value}");
        }
    }
}

/// Hidden production-view restore checks. No receipt, daemon, writer or profile is read.
#[cfg(feature = "native-probes")]
pub(crate) fn probe_update_navigation(cx: &mut gpui_kit::HeadlessAppContext) {
    use crate::navigation::{Location, Target};
    use gpui_kit::{Bounds, WindowBounds, WindowOptions, size};
    use serde_json::json;
    let catalog = crate::local_model::projects(
        &json!([{"id":"a","name":"Synthetic Atlas","path":"/synthetic/a"}]),
    )
    .unwrap();
    let chats = vec![
        crate::local_model::chat(
            &json!({"id":"synthetic","title":"Atlas conversation","projectId":"a","state":"idle"}),
        )
        .unwrap(),
    ];
    let mut run = |value: serde_json::Value, navigate_first: bool| {
        let (client, _reads) = LocalClient::synthetic_commands();
        let (writer, _writes) = Interaction::recording();
        let (catalog, chats) = (catalog.clone(), chats.clone());
        let (h, v) = cx.update(|cx| {
            gpui_kit::open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                        Default::default(),
                        size(px(680.), px(600.)),
                    ))),
                    show: false,
                    focus: false,
                    ..Default::default()
                },
                cx,
                |w, cx| {
                    cx.new(|cx| {
                        let mut v = LocalViewer::preview(PreviewState::Conversation, w, cx);
                        v.client = Some(client);
                        v.writer = Some(writer.clone());
                        v.editor
                            .update(cx, |e, cx| e.shell_probe_setup(writer, w, cx));
                        v.state.projects = Arc::new(catalog);
                        v.state.projects_loaded = true;
                        v.state.list_loaded = true;
                        v.state.chats = Arc::new(chats);
                        assert!(v.restore_location(&Location::home(), w, cx));
                        v.link_epoch = 0;
                        v
                    })
                },
            )
            .unwrap()
        });
        cx.run_until_parked();
        let result = cx
            .update_window(h, |_, w, cx| {
                v.update(cx, |v, cx| {
                    assert!(v.editor.read(cx).ready(), "drafts loaded before restore");
                    if navigate_first {
                        // Navigation after launch is newer intent than the receipt.
                        v.show_inbox(None, w, cx);
                    }
                    let restored = v.apply_update_navigation(&value, w, cx);
                    (restored, v.location(cx), v.nav_error.is_some())
                })
            })
            .unwrap();
        cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
        cx.run_until_parked();
        result
    };
    let chat = json!({"location":{"target":"chat","id":"synthetic"},"scope":null});
    let (restored, location, error) = run(chat.clone(), false);
    assert!(restored && !error);
    assert_eq!(location.target, Target::Chat("synthetic".into()));
    let (restored, location, _) = run(chat, true);
    assert!(!restored);
    assert_eq!(
        location.target,
        Target::Inbox(None),
        "newer navigation kept"
    );
    let (restored, location, _) = run(
        json!({"location":{"target":"project","id":"a"},"scope":"a"}),
        false,
    );
    assert!(restored);
    assert_eq!(
        location,
        Location {
            scope: Some("a".into()),
            target: Target::Project("a".into())
        }
    );
    let (restored, location, _) = run(
        json!({"location":{"target":"missions"},"scope":null}),
        false,
    );
    assert!(restored);
    assert_eq!(location.target, Target::Missions);
    let (restored, location, error) = run(
        json!({"location":{"target":"chat","id":"missing"},"scope":null}),
        false,
    );
    assert!(
        !restored && error,
        "unavailable selection is reported, not guessed"
    );
    assert_eq!(location, Location::home());
    let (restored, location, error) = run(
        json!({"location":{"target":"send","id":"synthetic"}}),
        false,
    );
    assert!(!restored && !error);
    assert_eq!(location, Location::home());
}
