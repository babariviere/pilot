//! Keep menu availability and Quit on the existing view/storage owners.
use super::*;
use gpui_kit::{AnyWindowHandle, Global};

gpui_kit::actions!(application_menu, [Minimize, Zoom]);

/// Window menu commands for a window root. Scoped to windows, not the app, so the
/// menu shows them disabled when no Pilot window is key and they act on that window.
pub(crate) fn window_commands<E: InteractiveElement>(root: E) -> E {
    root.on_action(|_: &Minimize, w, _| w.minimize_window())
        .on_action(|_: &Zoom, w, _| w.zoom_window())
}

#[derive(Clone)]
struct QuitOwner {
    view: gpui_kit::WeakEntity<LocalViewer>,
    window: AnyWindowHandle,
}
impl Global for QuitOwner {}

pub(super) fn register_quit_owner(
    window: &Window,
    cx: &mut Context<LocalViewer>,
) -> Option<Subscription> {
    let view = cx.weak_entity();
    #[cfg(target_os = "macos")]
    if let Some(previous) = cx.try_global::<QuitOwner>().cloned()
        && previous.view != view
    {
        let _ = previous
            .view
            .update(cx, |view, _| view.refuse_external_termination());
    }
    cx.set_global(QuitOwner {
        view,
        window: window.window_handle(),
    });
    #[cfg(target_os = "macos")]
    {
        cx.on_should_quit(external_quit);
        let weak = cx.weak_entity();
        let id = window.window_handle().window_id();
        // Window teardown must refuse even when a cache/test still retains the
        // view entity. Dropping the subscription/root otherwise closes its sender.
        Some(cx.on_window_closed(move |cx, closed| {
            if closed == id {
                let _ = weak.update(cx, |view, _| view.refuse_external_termination());
            }
        }))
    }
    #[cfg(not(target_os = "macos"))]
    None
}

#[cfg(target_os = "macos")]
pub(super) enum ExternalTermination {
    Idle,
    Waiting(async_channel::Sender<bool>),
    // A late Flushed after refusal is not permission to quit. A fresh explicit
    // request may try again, but neither a timer nor an old result can do so.
    Refused,
}

/// AppKit owns one deferred request. The current root owns its reply until
/// Flushed or refusal; dropping that root also closes the reply channel (NO).
#[cfg(target_os = "macos")]
pub(super) fn external_quit(cx: &mut App) -> impl std::future::Future<Output = bool> + use<> {
    let (reply, decision) = async_channel::bounded(1);
    if let Some(owner) = cx.try_global::<QuitOwner>().cloned() {
        cx.defer(move |cx| {
            if cx
                .try_global::<QuitOwner>()
                .is_none_or(|current| current.view != owner.view)
            {
                return;
            }
            let _ = owner.window.update(cx, |_, window, cx| {
                let _ = owner.view.update(cx, |view, cx| {
                    // The updater keeps its checkpoint fence after Flushed.
                    // Recheck the existing exact generation/preferences safety,
                    // never treat merely starting Close or COMMIT as permission.
                    if view.restart_pending {
                        let _ = reply.try_send(
                            !view.daemon_upgrade_pending
                                && view.editor.read(cx).close_confirmed()
                                && view.authorized_update_exit(window, cx),
                        );
                        return;
                    }
                    // Never replace an outstanding reply with a newer request.
                    if matches!(view.external_termination, ExternalTermination::Waiting(_))
                        || !view.editor.read(cx).external_close_ready()
                    {
                        return;
                    }
                    view.external_termination = ExternalTermination::Waiting(reply);
                    view.request_menu_quit(window, cx);
                    if !view.editor.read(cx).close_requested() {
                        view.refuse_external_termination();
                    }
                });
            });
        });
    }
    async move { decision.recv().await.unwrap_or(false) }
}

/// The main window, for app commands that need a home when no window is key.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn main_window(cx: &App) -> Option<AnyWindowHandle> {
    cx.try_global::<QuitOwner>()
        .filter(|owner| owner.view.upgrade().is_some())
        .map(|owner| owner.window)
}

/// The daemon behind the main window's live Local connection, read for About.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn connected_daemon(cx: &App) -> crate::local_client::ConnectedDaemon {
    cx.try_global::<QuitOwner>()
        .and_then(|owner| owner.view.upgrade())
        .and_then(|view| view.read(cx).client.as_ref().map(LocalClient::daemon))
        .unwrap_or_default()
}

/// App-level Quit from the menu or an auxiliary window (Settings, Usage).
/// Deferred because the dispatching window is borrowed during dispatch, and the
/// main owner may need to ask the Settings window before anything quits.
pub(crate) fn quit(cx: &mut App) {
    let Some(owner) = cx.try_global::<QuitOwner>().cloned() else {
        return exit(cx);
    };
    cx.defer(move |cx| {
        let asked = owner.window.update(cx, |_, w, cx| {
            owner.view.update(cx, |v, cx| v.request_menu_quit(w, cx))
        });
        // A failed window update is not proof that its draft owner is gone.
        if !matches!(asked, Ok(Ok(()))) && owner.view.upgrade().is_none() {
            exit(cx);
        }
    });
}

/// The only real exit, after every owner agreed or the draft writer reported Flushed.
pub(crate) fn exit(cx: &mut App) {
    #[cfg(test)]
    {
        let exits = cx.try_global::<Exits>().map_or(0, |e| e.0);
        cx.set_global(Exits(exits + 1));
    }
    cx.quit();
}
#[cfg(test)]
struct Exits(usize);
#[cfg(test)]
impl Global for Exits {}

impl LocalViewer {
    #[cfg(target_os = "macos")]
    pub(super) fn begin_fresh_quit(&mut self) {
        if matches!(self.external_termination, ExternalTermination::Refused) {
            self.external_termination = ExternalTermination::Idle;
        }
    }

    #[cfg(target_os = "macos")]
    pub(super) fn refuse_external_termination(&mut self) {
        if !matches!(self.external_termination, ExternalTermination::Waiting(_)) {
            return;
        }
        if let ExternalTermination::Waiting(reply) =
            std::mem::replace(&mut self.external_termination, ExternalTermination::Refused)
        {
            let _ = reply.try_send(false);
        }
    }

    pub(super) fn finish_quit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        #[cfg(not(target_os = "macos"))]
        let _ = window;
        // A released/replaced root cannot authorize termination for its successor.
        #[cfg(target_os = "macos")]
        if cx
            .try_global::<QuitOwner>()
            .is_some_and(|owner| owner.view.entity_id() != cx.entity_id())
        {
            self.refuse_external_termination();
            return;
        }
        #[cfg(target_os = "macos")]
        if matches!(self.external_termination, ExternalTermination::Refused) {
            return;
        }
        #[cfg(target_os = "macos")]
        if let ExternalTermination::Waiting(reply) =
            std::mem::replace(&mut self.external_termination, ExternalTermination::Idle)
        {
            let flushed = self.editor.read(cx).close_confirmed() && self.quit_allowed(window, cx);
            if !flushed {
                self.external_termination = ExternalTermination::Refused;
            }
            let _ = reply.try_send(flushed);
            return;
        }
        exit(cx);
    }

    pub(super) fn request_menu_quit(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if !self.quit_allowed(w, cx) {
            return;
        }
        #[cfg(target_os = "macos")]
        self.begin_fresh_quit();
        #[cfg(target_os = "macos")]
        if self.editor.read(cx).close_confirmed() {
            self.finish_quit(w, cx);
            return;
        }
        if self.editor.update(cx, |e, cx| e.request_close(cx)) {
            self.finish_quit(w, cx);
        }
    }

    fn quit_allowed(&mut self, w: &mut Window, cx: &mut Context<Self>) -> bool {
        if self.restart_pending
            || self.daemon_upgrade_pending
            || self.editor.update(cx, |e, cx| e.marked(w, cx))
            || self.queue_marked(w, cx)
        {
            // Keep the composition; show where it is when Quit came from another window.
            w.activate_window();
            return false;
        }
        if !self.settings_window_allows_quit(cx)
            || !self.settings.update(cx, |s, cx| s.request_close(cx))
        {
            return false;
        }
        true
    }

    /// Ask Settings in its own window, so its preedit checks read that window's
    /// input state, and bring it forward when it keeps the app open. A closed
    /// pane does not block; the shared preferences check still runs after this.
    fn settings_window_allows_quit(&self, cx: &mut App) -> bool {
        let (Some(handle), Some(pane)) = (self.settings_window, self.settings_pane.clone()) else {
            return true;
        };
        handle
            .update(cx, |_, sw, cx| {
                let ready = pane
                    .update(cx, |p, cx| p.request_close(sw, cx))
                    .unwrap_or(true);
                if !ready {
                    sw.activate_window();
                }
                ready
            })
            .unwrap_or(true)
    }

    pub(super) fn menu_navigation_ready(&mut self, w: &mut Window, cx: &mut Context<Self>) -> bool {
        use gpui_kit::{EntityInputHandler, component::WindowExt};
        !self.restart_pending
            && !self.queue_marked(w, cx)
            && self.jump.is_none()
            && !self.mission_open
            && !self.add_project_open
            && !w.has_active_dialog(cx)
            && !w.has_active_sheet(cx)
            && !self.editor.update(cx, |e, cx| e.marked(w, cx))
            && !self.missions.update(cx, |m, cx| m.brief_marked(w, cx))
            && (self.page != Page::Archive || self.archive.update(cx, |v, cx| v.ready(w, cx)))
            && !self
                .chats
                .read(cx)
                .query_input()
                .update(cx, |q, cx| q.marked_text_range(w, cx).is_some())
    }

    /// Jump stays a toggle: while the palette is open, Cmd-K and Go > Command Palette
    /// close it unless its query is mid-composition.
    pub(super) fn menu_jump_ready(&mut self, w: &mut Window, cx: &mut Context<Self>) -> bool {
        match self.jump.clone() {
            Some(palette) => !palette.update(cx, |p, cx| p.marked(w, cx)),
            None => self.menu_navigation_ready(w, cx),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transcript_view::Quit;
    use gpui_kit::base::input::{Copy, Cut, Paste, Redo, SelectAll, Undo};
    use gpui_kit::{
        AnyWindowHandle, EntityInputHandler, Focusable, TestAppContext, WindowOptions,
        component::input::{Input, InputState},
        div,
    };

    fn hidden() -> WindowOptions {
        WindowOptions {
            show: false,
            focus: false,
            ..Default::default()
        }
    }

    fn probe_state(flushed: bool) -> crate::interaction::WriteState {
        crate::interaction::WriteState {
            book: Some(Arc::new(crate::delivery_store::Book::shell_probe())),
            flushed,
            ..Default::default()
        }
    }

    /// Synthetic main owner: recording writer, probe book, one writable chat.
    fn main_owner(
        cx: &mut TestAppContext,
        writer: Interaction,
    ) -> (AnyWindowHandle, Entity<LocalViewer>) {
        cx.update(|cx| {
            gpui_kit::init(cx);
            LocalViewer::bind_keys(cx);
            TranscriptView::bind_keys(cx);
            #[cfg(target_os = "macos")]
            crate::app_menu::init(cx);
        });
        let (h, v) = cx.update(|cx| {
            gpui_kit::open_window(hidden(), cx, |w, cx| {
                cx.new(|cx| {
                    let mut v = LocalViewer::build(None, Some(writer), w, cx);
                    v.quit_window_closed = register_quit_owner(w, cx);
                    v.editor.update(cx, |e, cx| {
                        e.accept(probe_state(false), w, cx);
                        e.select("chat:source".into(), true, false, w, cx);
                    });
                    v
                })
            })
            .unwrap()
        });
        cx.run_until_parked();
        (h, v)
    }

    /// Stand-in auxiliary window (like Settings or Usage) with two plain inputs.
    struct Aux {
        first: Entity<InputState>,
        second: Entity<InputState>,
    }
    impl Render for Aux {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            window_commands(div())
                .child(Input::new(&self.first))
                .child(Input::new(&self.second))
        }
    }
    fn aux_window(cx: &mut TestAppContext) -> (AnyWindowHandle, Entity<Aux>) {
        let (h, aux) = cx.update(|cx| {
            gpui_kit::open_window(hidden(), cx, |w, cx| {
                cx.new(|cx| Aux {
                    first: cx.new(|cx| InputState::new(w, cx)),
                    second: cx.new(|cx| InputState::new(w, cx)),
                })
            })
            .unwrap()
        });
        cx.run_until_parked();
        (h, aux)
    }
    fn exits(cx: &mut TestAppContext) -> usize {
        cx.update(|cx| cx.try_global::<Exits>().map_or(0, |e| e.0))
    }
    fn clipboard(cx: &mut TestAppContext) -> Option<String> {
        cx.read_from_clipboard().and_then(|item| item.text())
    }

    #[cfg(target_os = "macos")]
    #[gpui_kit::test]
    fn about_reports_the_connected_daemon_in_one_alert(cx: &mut TestAppContext) {
        use crate::local_client::ConnectedDaemon;
        let (writer, _commands) = Interaction::recording();
        let (h, v) = main_owner(cx, writer);
        let (client, _local) = LocalClient::synthetic_commands();
        client.set_synthetic_daemon(ConnectedDaemon::Connected(Some("1.91.0".into())));
        v.update(cx, |v, _| v.client = Some(client));
        let about = |cx: &mut TestAppContext| {
            cx.update_window(h, |_, w, cx| {
                w.dispatch_action(Box::new(crate::app_menu::About), cx)
            })
            .unwrap();
            cx.run_until_parked();
        };
        let set = |cx: &mut TestAppContext, daemon: ConnectedDaemon| {
            v.read_with(cx, |v, _| {
                v.client.as_ref().unwrap().set_synthetic_daemon(daemon)
            })
        };
        let app = format!(
            "Pilot Next: {} (",
            crate::diagnostics::Build::current().version()
        );
        about(cx);
        let (title, detail) = cx.pending_prompt().expect("About alert");
        assert_eq!(title, "Pilot Next");
        assert!(detail.starts_with(&app), "{detail}");
        assert!(detail.ends_with("\nDaemon: 1.91.0"), "{detail}");
        assert!(!detail.contains("Experimental"));
        // A repeat request while the alert is open does not queue another one.
        about(cx);
        cx.simulate_prompt_answer("OK");
        cx.run_until_parked();
        assert!(!cx.has_pending_prompt());
        // Each opening reads the connection then: disconnected, then an older daemon.
        for (daemon, row) in [
            (ConnectedDaemon::NotConnected, "Daemon: Not connected"),
            (ConnectedDaemon::Connected(None), "Daemon: Version unknown"),
            (
                ConnectedDaemon::Connected(Some("1.92.0".into())),
                "Daemon: 1.92.0",
            ),
        ] {
            set(cx, daemon);
            about(cx);
            let detail = cx.pending_prompt().expect("About alert").1;
            assert!(detail.ends_with(row), "{detail}");
            cx.simulate_prompt_answer("OK");
            cx.run_until_parked();
        }
        assert!(!cx.has_pending_prompt());
    }

    #[gpui_kit::test]
    fn menus_preserve_preedit_and_route_new_chat_once(cx: &mut TestAppContext) {
        let (writer, commands) = Interaction::recording();
        let (h, v) = main_owner(cx, writer);
        let text = cx.update(|cx| v.read(cx).editor.read(cx).shell_probe().0);
        cx.update_window(h, |_, w, cx| {
            w.activate_window();
            text.update(cx, |t, cx| {
                t.focus(w, cx);
                t.replace_and_mark_text_in_range(None, "にほん", Some(3..3), w, cx);
            });
            w.draw(cx).clear(cx);
            assert!(!w.is_action_available(&NewChat, cx));
            w.dispatch_action(Box::new(NewChat), cx);
        })
        .unwrap();
        cx.run_until_parked();
        cx.update_window(h, |_, w, cx| {
            assert_eq!(
                v.read(cx).editor.read(cx).navigation_key(),
                Some("chat:source")
            );
            assert!(text.update(cx, |t, cx| t.marked_text_range(w, cx).is_some()));
            // Quit during composition keeps both the composition and the app.
            v.update(cx, |v, cx| v.request_menu_quit(w, cx));
            assert!(text.update(cx, |t, cx| t.marked_text_range(w, cx).is_some()));
            text.update(cx, |t, cx| t.unmark_text(w, cx));
        })
        .unwrap();
        cx.run_until_parked();
        assert_eq!(exits(cx), 0);
        cx.update_window(h, |_, w, cx| {
            w.draw(cx).clear(cx);
            assert!(w.is_action_available(&NewChat, cx));
            w.dispatch_action(Box::new(NewChat), cx);
        })
        .unwrap();
        cx.run_until_parked();
        v.read_with(cx, |v, cx| {
            assert!(
                v.editor
                    .read(cx)
                    .navigation_key()
                    .unwrap()
                    .starts_with("new:")
            );
            assert_eq!(v.editor.read(cx).new_drafts().len(), 1);
        });
        let all: Vec<_> = std::iter::from_fn(|| commands.try_recv().ok()).collect();
        assert!(!all.iter().any(|c| matches!(c, WriteCommand::Submit { .. })));
    }

    #[gpui_kit::test]
    fn diagnostics_menu_preserves_preedit_and_only_prepares_a_specialist(cx: &mut TestAppContext) {
        let (writer, commands) = Interaction::recording();
        let (h, v) = main_owner(cx, writer);
        let text = cx.update(|cx| v.read(cx).editor.read(cx).shell_probe().0);
        cx.update_window(h, |_, w, cx| {
            w.activate_window();
            text.update(cx, |t, cx| {
                t.focus(w, cx);
                t.replace_and_mark_text_in_range(None, "にほん", Some(3..3), w, cx);
            });
            w.draw(cx).clear(cx);
            assert!(!w.is_action_available(&AskAboutPilot, cx));
            w.dispatch_action(Box::new(AskAboutPilot), cx);
            assert_eq!(
                v.read(cx).editor.read(cx).navigation_key(),
                Some("chat:source")
            );
            text.update(cx, |t, cx| t.unmark_text(w, cx));
        })
        .unwrap();
        cx.run_until_parked();
        cx.update_window(h, |_, w, cx| {
            w.draw(cx).clear(cx);
            assert!(w.is_action_available(&AskAboutPilot, cx));
            w.dispatch_action(Box::new(AskAboutPilot), cx);
        })
        .unwrap();
        cx.run_until_parked();
        v.read_with(cx, |v, cx| {
            let e = v.editor.read(cx);
            assert!(e.shell_probe().2.unwrap().diagnostics);
            assert_eq!(e.new_drafts().len(), 1);
        });
        assert!(
            !std::iter::from_fn(|| commands.try_recv().ok())
                .any(|c| matches!(c, WriteCommand::Submit { .. }))
        );
    }

    #[gpui_kit::test]
    fn edit_actions_stay_with_the_focused_input(cx: &mut TestAppContext) {
        let (writer, _commands) = Interaction::recording();
        let (h, v) = main_owner(cx, writer);
        let composer = cx.update(|cx| v.read(cx).editor.read(cx).shell_probe().0);
        cx.update_window(h, |_, w, cx| {
            composer.update(cx, |t, cx| {
                t.focus(w, cx);
                t.replace_text_in_range(None, "draft", w, cx);
            });
        })
        .unwrap();
        cx.run_until_parked();
        let (aux, inputs) = aux_window(cx);
        let (first, second) = cx.update(|cx| {
            let a = inputs.read(cx);
            (a.first.clone(), a.second.clone())
        });
        cx.update_window(aux, |_, w, cx| {
            w.activate_window();
            first.update(cx, |i, cx| {
                i.focus(w, cx);
                i.replace_text_in_range(None, "alpha", w, cx);
            });
            second.update(cx, |i, cx| {
                i.focus(w, cx);
                i.replace_text_in_range(None, "beta", w, cx);
            });
            w.draw(cx).clear(cx);
            for action in [
                &SelectAll as &dyn gpui_kit::Action,
                &Copy,
                &Undo,
                &Redo,
                &Cut,
                &Paste,
            ] {
                assert!(w.is_action_available(action, cx), "{}", action.name());
            }
            w.dispatch_action(Box::new(SelectAll), cx);
            w.dispatch_action(Box::new(Copy), cx);
        })
        .unwrap();
        cx.run_until_parked();
        assert_eq!(clipboard(cx).as_deref(), Some("beta"));
        cx.update_window(aux, |_, w, cx| w.dispatch_action(Box::new(Undo), cx))
            .unwrap();
        cx.run_until_parked();
        cx.update_window(aux, |_, w, cx| {
            assert_eq!(second.read(cx).value().as_ref(), "");
            assert_eq!(first.read(cx).value().as_ref(), "alpha");
            w.dispatch_action(Box::new(Redo), cx);
        })
        .unwrap();
        cx.run_until_parked();
        cx.update_window(aux, |_, w, cx| {
            assert_eq!(second.read(cx).value().as_ref(), "beta");
            assert!(Focusable::focus_handle(second.read(cx), cx).is_focused(w));
            // The other input in the same window keeps its own text and history.
            first.update(cx, |i, cx| i.focus(w, cx));
            w.draw(cx).clear(cx);
            w.dispatch_action(Box::new(SelectAll), cx);
            w.dispatch_action(Box::new(Copy), cx);
        })
        .unwrap();
        cx.run_until_parked();
        assert_eq!(clipboard(cx).as_deref(), Some("alpha"));
        cx.update_window(aux, |_, w, cx| {
            w.dispatch_action(Box::new(SelectAll), cx);
            w.dispatch_action(Box::new(Cut), cx);
        })
        .unwrap();
        cx.run_until_parked();
        assert_eq!(clipboard(cx).as_deref(), Some("alpha"));
        cx.update_window(aux, |_, w, cx| {
            assert_eq!(first.read(cx).value().as_ref(), "");
            assert_eq!(second.read(cx).value().as_ref(), "beta");
            second.update(cx, |i, cx| i.focus(w, cx));
            w.draw(cx).clear(cx);
            w.dispatch_action(Box::new(SelectAll), cx);
            w.dispatch_action(Box::new(Paste), cx);
        })
        .unwrap();
        cx.run_until_parked();
        cx.update_window(aux, |_, _, cx| {
            assert_eq!(second.read(cx).value().as_ref(), "alpha");
            assert_eq!(first.read(cx).value().as_ref(), "");
        })
        .unwrap();
        // The main composer was never the target and still owns its window focus.
        cx.update_window(h, |_, w, cx| {
            assert_eq!(composer.read(cx).value().as_ref(), "draft");
            assert!(Focusable::focus_handle(composer.read(cx), cx).is_focused(w));
        })
        .unwrap();
    }

    #[gpui_kit::test]
    fn navigation_availability_is_truthful_and_jump_still_toggles(cx: &mut TestAppContext) {
        let (writer, _commands) = Interaction::recording();
        let (h, v) = main_owner(cx, writer);
        cx.update_window(h, |_, w, cx| {
            w.activate_window();
            w.draw(cx).clear(cx);
            assert!(!w.is_action_available(&NavigateBack, cx), "no history yet");
            assert!(!w.is_action_available(&NavigateForward, cx));
            assert!(w.is_action_available(&GoHome, cx));
            assert!(w.is_action_available(&ToggleJump, cx));
            assert!(w.is_action_available(&Minimize, cx));
            assert!(w.is_action_available(&Zoom, cx));
            w.dispatch_action(Box::new(ToggleJump), cx);
        })
        .unwrap();
        cx.run_until_parked();
        cx.update_window(h, |_, w, cx| {
            assert!(v.read(cx).jump.is_some());
            w.draw(cx).clear(cx);
            // Palette open: page navigation waits, but Command Palette still closes it.
            assert!(!w.is_action_available(&GoHome, cx));
            assert!(!w.is_action_available(&NewChat, cx));
            assert!(w.is_action_available(&ToggleJump, cx));
            w.dispatch_action(Box::new(ToggleJump), cx);
        })
        .unwrap();
        cx.run_until_parked();
        cx.update_window(h, |_, w, cx| {
            assert!(v.read(cx).jump.is_none());
            w.draw(cx).clear(cx);
            assert!(w.is_action_available(&GoHome, cx));
        })
        .unwrap();
    }

    #[gpui_kit::test]
    fn quit_from_auxiliary_window_flushes_main_owner_once(cx: &mut TestAppContext) {
        let (writer, commands, closes) = Interaction::recording_with_close();
        let (h, v) = main_owner(cx, writer);
        let (aux, _inputs) = aux_window(cx);
        cx.update_window(aux, |_, w, cx| {
            w.activate_window();
            w.draw(cx).clear(cx);
        })
        .unwrap();
        // App-level handler: enabled from any window, never quits directly.
        assert!(cx.update(|cx| cx.is_action_available(&Quit)));
        cx.update_window(aux, |_, w, cx| {
            w.dispatch_action(Box::new(Quit), cx);
            w.dispatch_action(Box::new(Quit), cx);
        })
        .unwrap();
        cx.run_until_parked();
        assert_eq!(std::iter::from_fn(|| closes.try_recv().ok()).count(), 1);
        assert_eq!(exits(cx), 0, "no exit before the writer reports Flushed");
        let all: Vec<_> = std::iter::from_fn(|| commands.try_recv().ok()).collect();
        assert!(!all.iter().any(|c| matches!(c, WriteCommand::Submit { .. })));
        let editor = cx.update(|cx| v.read(cx).editor.clone());
        cx.update_window(h, |_, w, cx| {
            editor.update(cx, |e, cx| e.accept(probe_state(true), w, cx));
        })
        .unwrap();
        cx.run_until_parked();
        assert_eq!(exits(cx), 1);
    }

    #[cfg(target_os = "macos")]
    #[gpui_kit::test]
    fn external_quit_waits_for_current_flush_and_keeps_one_reply(cx: &mut TestAppContext) {
        use futures_util::FutureExt;
        let (writer, _commands, closes) = Interaction::recording_with_close();
        let (h, view) = main_owner(cx, writer);
        let mut decision = Box::pin(cx.update(external_quit));
        cx.run_until_parked();
        assert!(decision.as_mut().now_or_never().is_none());
        assert_eq!(closes.try_recv(), Ok(()));
        // The platform coalesces native duplicates. This separately tests that
        // the root cannot replace an existing sender if it is asked twice.
        let duplicate = cx.update(external_quit);
        cx.run_until_parked();
        assert_eq!(duplicate.now_or_never(), Some(false));
        assert!(closes.try_recv().is_err());
        assert_eq!(exits(cx), 0);
        cx.update_window(h, |_, w, cx| {
            view.read(cx)
                .editor
                .clone()
                .update(cx, |e, cx| e.accept(probe_state(false), w, cx));
        })
        .unwrap();
        cx.run_until_parked();
        assert!(
            decision.as_mut().now_or_never().is_none(),
            "an intermediate projection is not Flushed"
        );
        cx.update_window(h, |_, w, cx| {
            view.read(cx)
                .editor
                .clone()
                .update(cx, |e, cx| e.accept(probe_state(true), w, cx));
        })
        .unwrap();
        cx.run_until_parked();
        assert_eq!(decision.now_or_never(), Some(true));
        assert_eq!(exits(cx), 0, "native reply, not another App::quit");
        let already_drained = cx.update(external_quit);
        cx.run_until_parked();
        assert_eq!(
            already_drained.now_or_never(),
            Some(true),
            "positively already drained"
        );
        assert!(closes.try_recv().is_err());
    }

    #[cfg(target_os = "macos")]
    #[gpui_kit::test]
    fn external_quit_rechecks_preferences_and_rejects_late_flush(cx: &mut TestAppContext) {
        use futures_util::FutureExt;
        let (writer, _commands, closes) = Interaction::recording_with_close();
        let (h, view) = main_owner(cx, writer);
        let decision = cx.update(external_quit);
        cx.run_until_parked();
        assert_eq!(closes.try_recv(), Ok(()));
        cx.update_window(h, |_, w, cx| {
            view.read(cx).settings.clone().update(cx, |s, _| {
                s.state
                    .set_automatic_update_checks(!s.state.current().automatic_update_checks);
            });
            view.read(cx)
                .editor
                .clone()
                .update(cx, |e, cx| e.accept(probe_state(true), w, cx));
        })
        .unwrap();
        cx.run_until_parked();
        assert_eq!(decision.now_or_never(), Some(false));
        cx.update_window(h, |_, w, cx| {
            view.read(cx)
                .settings
                .clone()
                .update(cx, |s, _| s.state.revert());
            view.read(cx)
                .editor
                .clone()
                .update(cx, |e, cx| e.accept(probe_state(true), w, cx));
        })
        .unwrap();
        cx.run_until_parked();
        assert_eq!(exits(cx), 0, "late Flushed cannot undo a refusal");
        let fresh = cx.update(external_quit);
        cx.run_until_parked();
        assert_eq!(
            fresh.now_or_never(),
            Some(true),
            "fresh explicit request may use the confirmed drain"
        );
        assert!(closes.try_recv().is_err(), "no second Close");
    }

    #[cfg(target_os = "macos")]
    #[gpui_kit::test]
    fn external_quit_replacement_and_teardown_refuse_old_attempt(cx: &mut TestAppContext) {
        use futures_util::FutureExt;
        let (writer, _commands, closes) = Interaction::recording_with_close();
        let (old_window, old) = main_owner(cx, writer);
        let decision = cx.update(external_quit);
        cx.run_until_parked();
        assert_eq!(closes.try_recv(), Ok(()));
        let (writer, _commands, new_closes) = Interaction::recording_with_close();
        let (new_window, new) = main_owner(cx, writer);
        assert_eq!(decision.now_or_never(), Some(false));
        cx.update_window(old_window, |_, w, cx| {
            old.read(cx)
                .editor
                .clone()
                .update(cx, |e, cx| e.accept(probe_state(true), w, cx));
        })
        .unwrap();
        cx.run_until_parked();
        assert_eq!(exits(cx), 0, "old root cannot quit its replacement");
        let decision = cx.update(external_quit);
        cx.run_until_parked();
        assert_eq!(new_closes.try_recv(), Ok(()));
        cx.update_window(new_window, |_, w, _| w.remove_window())
            .unwrap();
        drop(new);
        cx.run_until_parked();
        assert_eq!(
            decision.now_or_never(),
            Some(false),
            "dropped root is not authorization"
        );
        assert_eq!(exits(cx), 0);
    }

    #[cfg(target_os = "macos")]
    #[gpui_kit::test]
    fn external_quit_preserves_preedit_upgrade_and_checkpoint_vetoes(cx: &mut TestAppContext) {
        use futures_util::FutureExt;
        let (writer, _commands, closes) = Interaction::recording_with_close();
        let (h, view) = main_owner(cx, writer);
        for upgrade in [true, false] {
            view.update(cx, |v, _| {
                v.daemon_upgrade_pending = upgrade;
                v.restart_pending = !upgrade;
            });
            let decision = cx.update(external_quit);
            cx.run_until_parked();
            assert_eq!(decision.now_or_never(), Some(false));
            assert!(closes.try_recv().is_err());
        }
        view.update(cx, |v, _| v.restart_pending = false);
        let text = cx.update(|cx| view.read(cx).editor.read(cx).shell_probe().0);
        cx.update_window(h, |_, w, cx| {
            text.update(cx, |t, cx| {
                t.focus(w, cx);
                t.replace_and_mark_text_in_range(None, "にほん", Some(3..3), w, cx);
            });
        })
        .unwrap();
        let decision = cx.update(external_quit);
        cx.run_until_parked();
        assert_eq!(decision.now_or_never(), Some(false));
        assert!(closes.try_recv().is_err());
        cx.update_window(h, |_, w, cx| {
            assert!(text.update(cx, |t, cx| t.marked_text_range(w, cx).is_some()));
            text.update(cx, |t, cx| {
                t.unmark_text(w, cx);
                t.set_value("", w, cx);
            });
            view.read(cx).editor.clone().update(cx, |e, cx| {
                assert!(e.begin_gui_update_checkpoint(7, w, cx));
            });
        })
        .unwrap();
        let decision = cx.update(external_quit);
        cx.run_until_parked();
        assert_eq!(decision.now_or_never(), Some(false));
        assert!(closes.try_recv().is_err());
        assert_eq!(exits(cx), 0);
    }

    #[cfg(target_os = "macos")]
    #[gpui_kit::test]
    fn external_quit_refuses_pending_and_unconfirmed_preferences(cx: &mut TestAppContext) {
        use futures_util::FutureExt;
        let (writer, _commands, closes) = Interaction::recording_with_close();
        let (_, view) = main_owner(cx, writer);
        let settings = view.read_with(cx, |v, _| v.settings.clone());
        let request = settings.update(cx, |s, _| {
            assert!(s.state.loaded());
            assert!(
                s.state
                    .set_automatic_update_checks(!s.state.current().automatic_update_checks)
            );
            s.state.begin_save().unwrap()
        });
        let pending = cx.update(external_quit);
        cx.run_until_parked();
        assert_eq!(pending.now_or_never(), Some(false));
        settings.update(cx, |s, _| {
            assert!(s.state.finish_save(
                request,
                Err(crate::settings_state::SettingsError::DurabilityUnknown)
            ));
            assert!(s.state.unconfirmed());
        });
        let unconfirmed = cx.update(external_quit);
        cx.run_until_parked();
        assert_eq!(unconfirmed.now_or_never(), Some(false));
        assert!(closes.try_recv().is_err());
        assert_eq!(exits(cx), 0);
    }
}
