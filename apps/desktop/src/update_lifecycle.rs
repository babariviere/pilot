//! Explicit install intent, separate from ordinary Quit. No timer is a flush ACK.
use super::*;
use crate::update_hold::{Blocker, Hold};
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
                crate::updates_view::Event::UpgradeDaemon => view.begin_daemon_upgrade(window, cx),
                crate::updates_view::Event::DaemonChanged => {
                    view.advance_daemon_upgrade(window, cx)
                }
                crate::updates_view::Event::ShowBlocker => view.show_update_blocker(window, cx),
            },
        ));
        self.update_events.push(
            cx.observe_in(&self.settings, window, |view, _, window, cx| {
                view.advance_update_restart(window, cx)
            }),
        );
    }
    /// The first preference or secondary form state an update restart would lose or leave
    /// unconfirmed. The composer, its drafts and deliveries are checked by the checkpoint itself.
    pub(super) fn update_blocker(
        &self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<Blocker> {
        let owner = self.settings.read(cx);
        let s = &owner.state;
        let preferences = if !s.loaded() {
            Some(if s.error().is_some() {
                Blocker::PreferencesFailed
            } else {
                Blocker::PreferencesLoading
            })
        } else if s.saving() {
            Some(Blocker::Preferences(Hold::Sending))
        } else if s.unconfirmed() {
            Some(Blocker::Preferences(Hold::Unconfirmed))
        } else if s.dirty() {
            Some(Blocker::Preferences(Hold::Unsaved))
        } else if s.error().is_some() {
            Some(Blocker::PreferencesFailed)
        } else {
            owner
                .models
                .as_ref()
                .and_then(|m| m.read(cx).update_hold(cx))
                .map(Blocker::ScopedModels)
                .or_else(|| {
                    owner
                        .chats
                        .as_ref()
                        .and_then(|c| c.read(cx).update_hold())
                        .map(|_| Blocker::ChatSettings)
                })
                .or_else(|| {
                    owner
                        .projects
                        .as_ref()
                        .and_then(|p| p.read(cx).update_hold())
                        .map(Blocker::ProjectSettings)
                })
        };
        preferences.or_else(|| self.secondary_blocker(window, cx))
    }
    pub(super) fn secondary_blocker(
        &self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<Blocker> {
        use gpui_kit::component::WindowExt;
        // Preedit in secondary fields is a veto, never committed or discarded.
        if self
            .chats
            .read(cx)
            .query_input()
            .update(cx, |q, cx| q.marked_text_range(window, cx).is_some())
            || self.missions.update(cx, |m, cx| m.brief_marked(window, cx))
        {
            return Some(Blocker::Composition);
        }
        if self.jump.is_some() {
            return Some(Blocker::Jump);
        }
        if self.mission_open {
            return Some(Blocker::Conversion(Hold::Unsaved));
        }
        if let Some(hold) = self.mission.read(cx).update_hold() {
            return Some(Blocker::Conversion(hold));
        }
        let add = self.add_project.read(cx);
        if add.pending {
            return Some(Blocker::AddProject(Hold::Sending));
        }
        // A chosen folder outlives the closed sheet (and a finished registration) but holds
        // no typed input; the writer's book owns sent registrations.
        if self.add_project_open || add.choosing {
            return Some(Blocker::AddProject(Hold::Unsaved));
        }
        if let Some(chat) = self.queue_hold_chat(cx) {
            return Some(Blocker::QueuedMessage { chat });
        }
        let dialog = window.has_active_dialog(cx);
        if let Some(blocker) = self
            .chat_actions
            .read(cx)
            .update_blocker(dialog, cx)
            .or_else(|| self.missions.read(cx).update_blocker(cx))
        {
            return Some(blocker);
        }
        // What remains is preedit in the composer, a queue editor or the Inbox picker.
        (!self.project_choices_ready(window, cx)).then_some(Blocker::Composition)
    }
    /// Takes the user to the place named by the last refusal. Navigation goes through the
    /// ordinary guarded routes; nothing is saved, discarded or opened for editing.
    fn show_update_blocker(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        use crate::navigation::{Location, Target};
        use crate::update_hold::Destination;
        let Some(destination) = self
            .updater(cx)
            .and_then(|u| u.read(cx).blocker.as_ref().and_then(Blocker::destination))
        else {
            return;
        };
        if destination == Destination::ScopedModels {
            return; // The Settings window selects its own page.
        }
        window.activate_window();
        match destination {
            Destination::Chat(id) => {
                let scoped = Location {
                    scope: self.location(cx).scope,
                    target: Target::Chat(id.clone()),
                };
                let location = if self.can_restore(&scoped, cx) {
                    scoped
                } else {
                    Location {
                        scope: None,
                        target: Target::Chat(id),
                    }
                };
                if location != self.location(cx)
                    && self.can_restore(&location, cx)
                    && self.prepare_navigation(window, cx)
                    && self.restore_location(&location, window, cx)
                {
                    self.did_navigate(cx);
                }
            }
            Destination::Missions => {
                self.show_missions(window, cx);
            }
            Destination::Mission(key) => {
                self.show_mission_overview(key, window, cx);
            }
            Destination::ScopedModels | Destination::MainWindow => {}
        }
        cx.notify();
    }
    fn begin_update_restart(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(updater) = self.updater(cx) else {
            return;
        };
        if self.restart_pending {
            return;
        }
        if self.daemon_upgrade_pending {
            updater.update(cx, |u, cx| {
                u.defer(
                    "The daemon upgrade is running. Wait for its result before restarting the app.",
                    cx,
                )
            });
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
        if let Some(blocker) = self.update_blocker(window, cx) {
            updater.update(cx, |u, cx| u.block(blocker, cx));
            return;
        }
        // Only GUI-owned input and durable state are fenced. Independent agents
        // keep running while the app checkpoints, swaps and reconnects.
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
            e.begin_gui_update_checkpoint(generation, window, cx)
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
            u.blocker = None;
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
        if self.daemon_upgrade_pending {
            self.advance_daemon_upgrade(window, cx);
            return;
        }
        self.acknowledge_update_startup(cx);
        if !self.restart_pending {
            self.advance_startup_daemon_upgrade(cx);
        }
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
        let Some(updater) = self.updater(cx) else {
            return;
        };
        let receipt = crate::bundled_runtime::update_receipt();
        if receipt.is_none() && !updater.read(cx).has_startup_recovery() {
            return;
        }
        if self.editor.read(cx).ready() && self.settings.read(cx).state.persisted() {
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

/// The install gate on a production view: a clean loaded viewer, and forms that were opened
/// and closed or already answered, reach the checkpoint; held work is named and shown, never
/// discarded. No receipt, daemon, worker or profile is used; the writer only records.
#[cfg(feature = "native-probes")]
pub(crate) fn probe_update_blockers(cx: &mut gpui_kit::HeadlessAppContext) {
    use crate::mission_browser::{Home, Key};
    use crate::navigation::{Location, Target};
    use crate::settings_state::{AppearancePreference, LoadedPreferences, Preferences};
    use gpui_kit::{Bounds, WindowBounds, WindowOptions, size};
    use serde_json::json;
    let catalog = crate::local_model::projects(
        &json!([{"id":"a","name":"Synthetic Atlas","path":"/synthetic/a"}]),
    )
    .unwrap();
    let raw = json!({"id":"synthetic","projectId":"a","title":"Atlas conversation","cwd":"/synthetic/a","mode":"ask","state":"idle"});
    let chats = vec![crate::local_model::chat(&raw).unwrap()];
    let (client, _reads) = LocalClient::synthetic_commands();
    let (writer, writes) = Interaction::recording();
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
                    v
                })
            },
        )
        .unwrap()
    });
    cx.run_until_parked();
    cx.update_window(h, |_, w, cx| {
        v.update(cx, |v, cx| {
            let options = crate::LocalOptions::synthetic(1);
            let updater = cx.new(|_| crate::updates_view::Updates::probe_ready_local());
            v.settings
                .update(cx, |o, _| o.updater = Some(updater.clone()));
            let notice = |cx: &App| updater.read(cx).notice;

            // Preferences: loading, then the clean loaded baseline.
            if !v.settings.read(cx).state.loaded() {
                assert_eq!(v.update_blocker(w, cx), Some(Blocker::PreferencesLoading));
                v.settings.update(cx, |o, _| {
                    assert!(o.state.begin_load());
                    assert!(o.state.finish_load(Ok(LoadedPreferences {
                        preferences: Preferences::default(),
                        persisted: true,
                    })));
                });
            }
            assert_eq!(v.update_blocker(w, cx), None, "clean loaded idle viewer");

            // Each preference state is named, and Settings keeps the edit.
            v.settings.update(cx, |o, _| {
                assert!(o.state.set_appearance(AppearancePreference::Dark))
            });
            assert_eq!(
                v.update_blocker(w, cx),
                Some(Blocker::Preferences(Hold::Unsaved))
            );
            v.begin_update_restart(w, cx);
            assert!(!v.restart_pending);
            assert_eq!(
                notice(cx),
                Some(Blocker::Preferences(Hold::Unsaved).message())
            );
            assert_eq!(
                v.settings.read(cx).state.current().appearance,
                AppearancePreference::Dark,
                "nothing was reverted"
            );
            let save = v.settings.update(cx, |o, _| o.state.begin_save().unwrap());
            assert_eq!(
                v.update_blocker(w, cx),
                Some(Blocker::Preferences(Hold::Sending))
            );
            v.settings.update(cx, |o, _| {
                o.state.finish_save(
                    save,
                    Err(crate::settings_state::SettingsError::DurabilityUnknown),
                )
            });
            assert_eq!(
                v.update_blocker(w, cx),
                Some(Blocker::Preferences(Hold::Unconfirmed))
            );
            let retry = v.settings.update(cx, |o, _| o.state.begin_save().unwrap());
            v.settings
                .update(cx, |o, _| o.state.finish_save(retry, Ok(())));
            assert_eq!(v.update_blocker(w, cx), None, "confirmed save settles");

            // Forms that were opened and closed, or answered, hold nothing. Each of these
            // made the former existence-based gate refuse for the rest of the session.
            let key = Key {
                home: Home {
                    daemon: "synthetic-daemon".into(),
                    lineage: "synthetic-lineage".into(),
                },
                id: "mission-1".into(),
            };
            let source = crate::mission_brief::Source {
                key: key.clone(),
                project: "a".into(),
            };
            let projects = v.state.projects.as_ref().clone();
            let metadata = v.missions.update(cx, |b, cx| {
                b.brief =
                    Some(cx.new(|cx| {
                        crate::mission_brief_view::Workspace::new(options.clone(), w, cx)
                    }));
                b.activity_browser = Some(cx.new(crate::mission_activity_view::Activity::new));
                b.creation = Some(cx.new(|cx| {
                    crate::mission_create_view::Form::new(projects, options.clone(), w, cx)
                }));
                b.lifecycle.push(cx.new(|cx| {
                    crate::mission_lifecycle_view::Form::new(
                        source.clone(),
                        options.clone(),
                        crate::mission_lifecycle::Action::Archive,
                        cx,
                    )
                }));
                let metadata = cx.new(|cx| {
                    crate::mission_metadata_view::Form::new(source.clone(), options.clone(), w, cx)
                });
                b.metadata.push(metadata.clone());
                metadata
            });
            v.add_project
                .update(cx, |a, _| a.path = Some("/synthetic/added".into()));
            let target = crate::chat_actions::Target::new(&options, v.state.chats[0].clone());
            let evidence = crate::chat_actions::Evidence::read(&target, &raw, true).unwrap();
            let rename =
                cx.new(|cx| crate::chat_rename_view::Rename::new(options.clone(), evidence, w, cx));
            rename.update(cx, |r, cx| {
                r.input
                    .update(cx, |i, cx| i.set_value("Renamed atlas", w, cx));
                r.outcome = Some(crate::chat_actions::Outcome::Acknowledged);
            });
            v.chat_actions.update(cx, |a, _| {
                a.renames.insert("synthetic".into(), rename.clone());
                a.latest_rename = Some("synthetic".into());
            });
            v.mission.update(cx, |f, cx| {
                f.open(
                    crate::mission_conversion::Target {
                        source: "synthetic".into(),
                        project: "a".into(),
                        generation: v.generation,
                    },
                    "Atlas conversation",
                    w,
                    cx,
                );
                f.close(w, cx);
            });
            // The former gate refused on existence alone: a retained brief, activity,
            // creation, lifecycle or metadata form, any rename, a chosen project folder,
            // or the conversion sheet's prefilled title.
            let missions = v.missions.read(cx);
            assert!(missions.brief.is_some() && missions.activity_browser.is_some());
            assert!(missions.creation.is_some() && !missions.lifecycle.is_empty());
            assert!(!missions.metadata.is_empty());
            assert!(!v.chat_actions.read(cx).renames.is_empty());
            assert!(v.add_project.read(cx).path.is_some());
            assert!(!v.mission.read(cx).title.read(cx).value().is_empty());
            assert_eq!(
                v.update_blocker(w, cx),
                None,
                "opened, closed and answered forms"
            );
            v.begin_update_restart(w, cx);
            assert!(v.restart_pending, "the existing checkpoint flow starts");
            assert_eq!(updater.read(cx).blocker, None);
            assert!(updater.read(cx).fenced);
            v.end_update_restart("Probe cancelled before preparation.", cx);
            assert!(!v.restart_pending);

            // Unsent edits are named with a Show action and kept as typed.
            metadata.update(cx, |f, cx| {
                f.loaded = true;
                f.title
                    .update(cx, |t, cx| t.set_value("Retained 日本語 title", w, cx));
            });
            let held = Blocker::Mission {
                key: key.clone(),
                hold: Hold::Unsaved,
            };
            assert_eq!(v.update_blocker(w, cx), Some(held.clone()));
            v.begin_update_restart(w, cx);
            assert!(!v.restart_pending);
            assert_eq!(notice(cx), Some(held.message()));
            assert_eq!(updater.read(cx).blocker, Some(held));
            assert_eq!(
                metadata.read(cx).title.read(cx).value().as_ref(),
                "Retained 日本語 title"
            );
            // An answered save is settled; an Unknown one is never resent, so it holds nothing.
            let save = metadata.update(cx, |f, cx| {
                let title = f.title.read(cx).value().to_string();
                f.state.begin(&f.source, &title, "").unwrap()
            });
            assert_eq!(
                v.update_blocker(w, cx),
                Some(Blocker::Mission {
                    key: key.clone(),
                    hold: Hold::Sending
                })
            );
            metadata.update(cx, |f, _| {
                assert!(
                    f.state
                        .finish(&save, crate::mission_metadata::Outcome::Unknown("lost"))
                )
            });
            assert_eq!(v.update_blocker(w, cx), None);

            // A rename still waiting for Local names its chat, and Show opens it.
            rename.update(cx, |r, _| {
                r.outcome = None;
                r.pending = true;
            });
            let held = Blocker::ChatRename {
                chat: "synthetic".into(),
                hold: Hold::Sending,
            };
            assert_eq!(v.update_blocker(w, cx), Some(held.clone()));
            v.begin_update_restart(w, cx);
            assert_eq!(notice(cx), Some(held.message()));
            assert_eq!(v.location(cx), Location::home());
            v.show_update_blocker(w, cx);
            assert_eq!(v.location(cx).target, Target::Chat("synthetic".into()));
            rename.update(cx, |r, _| r.pending = false);
            // A closed rename's text is replaced on reopen; only the open dialog holds it.
            assert_eq!(rename.read(cx).update_hold(true, cx), Some(Hold::Unsaved));
            assert_eq!(v.update_blocker(w, cx), None);

            // Preedit in a secondary field is a veto, kept rather than committed.
            let query = v.chats.read(cx).query_input();
            query.update(cx, |q, cx| {
                q.replace_and_mark_text_in_range(None, "にほ", None, w, cx)
            });
            assert_eq!(v.update_blocker(w, cx), Some(Blocker::Composition));
            assert!(query.update(cx, |q, cx| q.marked_text_range(w, cx).is_some()));
            query.update(cx, |q, cx| {
                q.unmark_text(w, cx);
                q.set_value("", w, cx);
            });
            assert_eq!(v.update_blocker(w, cx), None);

            // Pending project registration and an open conversion sheet are named.
            v.add_project.update(cx, |a, _| a.pending = true);
            assert_eq!(
                v.update_blocker(w, cx),
                Some(Blocker::AddProject(Hold::Sending))
            );
            v.add_project.update(cx, |a, _| a.pending = false);
            v.mission_open = true;
            assert_eq!(
                v.update_blocker(w, cx),
                Some(Blocker::Conversion(Hold::Unsaved))
            );
            v.mission_open = false;
            assert_eq!(v.update_blocker(w, cx), None);
        })
    })
    .unwrap();
    cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
    cx.run_until_parked();
    let commands: Vec<_> = std::iter::from_fn(|| writes.try_recv().ok()).collect();
    assert!(
        commands
            .iter()
            .all(|c| matches!(c, crate::interaction::WriteCommand::Checkpoint(_))),
        "only the explicit checkpoint was written"
    );
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
