//! Chat-local presentation of the existing native coordinated-update owner.
use super::*;
use gpui_kit::AnyElement;

impl LocalViewer {
    pub(super) fn observe_chat_update(&mut self, state: &Presentation, cx: &mut Context<Self>) {
        let invalidated = state.runtime_update_revision != self.state.runtime_update_revision
            || state.control_connection_generation > self.model_connection_generation;
        self.state.runtime_update_revision = state.runtime_update_revision;
        let connected = self.client.as_ref().is_some_and(|client| {
            matches!(
                client.daemon(),
                crate::local_client::ConnectedDaemon::Connected(_)
            )
        });
        if let Some(updater) = self.settings.read(cx).updater.clone() {
            updater.update(cx, |updater, cx| {
                updater.coordinated_chat_connection(connected, cx);
                if invalidated && connected {
                    updater.coordinated_invalidated(cx);
                }
            });
        }
    }

    pub(super) fn refresh_chat_update(&self, cx: &mut Context<Self>) {
        if let Some(updater) = self.settings.read(cx).updater.clone() {
            updater.update(cx, |updater, cx| updater.coordinated_invalidated(cx));
        }
    }

    pub(super) fn chat_update_card(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        if self.page != Page::Chat || self.artifacts_open {
            return None;
        }
        let id = self.selected.as_ref()?;
        self.state
            .chats
            .iter()
            .find(|chat| &chat.id == id && chat.writable && !chat.archived && !chat.local_draft)?;
        let updater = self.settings.read(cx).updater.clone()?;
        let owner = cx.entity().downgrade();
        let activation_id = id.clone();
        let generation = self.generation;
        let guard: crate::updates_view::ChatProposalGuard =
            std::rc::Rc::new(move |window: &mut Window, app: &mut App| {
                owner
                    .update(app, |view, cx| {
                        view.chat_update_scope_matches(&activation_id, generation)
                            && view.project_choices_ready(window, cx)
                    })
                    .unwrap_or(false)
            });
        let card = updater.update(cx, |updater, cx| {
            updater.coordinated_chat_card(id, guard, cx)
        })?;
        let pointer_id = id.clone();
        let release_id = id.clone();
        let key_id = id.clone();
        let generation = self.generation;
        Some(
            div()
                .id("chat-update-card-slot")
                .test_support()
                .flex_none()
                .w_full()
                .min_w_0()
                .max_w(px(crate::ui::CONVERSATION_MAX_WIDTH))
                .mx_auto()
                // Match the composer's shell inset inside the same capped column.
                .px_3()
                // Guard before a sibling button can blur/commit composer preedit.
                .capture_any_mouse_down(cx.listener(move |view, _, window, cx| {
                    if !view.chat_update_scope_matches(&pointer_id, generation)
                        || !view.project_choices_ready(window, cx)
                    {
                        cx.stop_propagation();
                    }
                }))
                .capture_any_mouse_up(cx.listener(move |view, _, window, cx| {
                    if !view.chat_update_scope_matches(&release_id, generation)
                        || !view.project_choices_ready(window, cx)
                    {
                        cx.stop_propagation();
                    }
                }))
                .capture_key_down(cx.listener(move |view, _, window, cx| {
                    if !view.chat_update_scope_matches(&key_id, generation)
                        || !view.project_choices_ready(window, cx)
                    {
                        cx.stop_propagation();
                    }
                }))
                .child(card)
                .into_any_element(),
        )
    }

    fn chat_update_scope_matches(&self, id: &str, generation: u64) -> bool {
        self.page == Page::Chat
            && !self.artifacts_open
            && self.subagent.is_none()
            && self.selected.as_deref() == Some(id)
            && self.generation == generation
            && self
                .state
                .chats
                .iter()
                .any(|chat| chat.id == id && chat.writable && !chat.archived && !chat.local_draft)
    }

    #[cfg(feature = "native-probes")]
    pub(crate) fn chat_update_probe_mount(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let (client, commands) = LocalClient::synthetic_commands();
        client.set_synthetic_daemon(crate::local_client::ConnectedDaemon::Connected(Some(
            "1.110.0".into(),
        )));
        self.client = Some(client);
        for chat in Arc::make_mut(&mut self.state.chats) {
            if chat.id == "synthetic" {
                chat.writable = true;
            }
        }
        let (writer, writes) = Interaction::recording();
        self.editor.update(cx, |editor, cx| {
            editor.shell_probe_setup(writer, window, cx)
        });
        self.editor.update(cx, |editor, cx| {
            editor.select("chat:synthetic".into(), true, false, window, cx)
        });
        let updater = cx.new(|_| crate::updates_view::Updates::probe_ready_local());
        self.settings
            .update(cx, |settings, _| settings.updater = Some(updater));
        // Keep synthetic channels alive. They perform no effects and acknowledge no writes.
        self.updates = Some(cx.spawn(async move |_, _| {
            futures_util::future::join(
                async move { while commands.recv().await.is_ok() {} },
                async move { while writes.recv().await.is_ok() {} },
            )
            .await;
        }));
        self.connect_updates(window, cx);
        cx.notify();
    }

    #[cfg(feature = "native-probes")]
    pub(crate) fn chat_update_probe_updates(
        &self,
        cx: &App,
    ) -> Entity<crate::updates_view::Updates> {
        self.settings
            .read(cx)
            .updater
            .clone()
            .expect("synthetic update owner")
    }

    #[cfg(feature = "native-probes")]
    pub(crate) fn chat_update_probe_focus_root(&self, window: &mut Window, cx: &mut Context<Self>) {
        self.root_focus.focus(window, cx);
    }

    #[cfg(feature = "native-probes")]
    pub(crate) fn chat_update_probe_selected(&self) -> Option<String> {
        self.selected.clone()
    }
}
