//! The failed chat's Retry: production LocalViewer banner and Kit button over
//! synthetic Local HTTP. Pointer and keyboard, draft/IME retention, pending,
//! Unknown, stale, disconnected and unavailable refusals. Offscreen only.
use super::*;

const REASON: &str = "Provider error: upstream unavailable 日本語 👩🏽‍💻";

fn failed_turn() -> serde_json::Value {
    let mut raw = f::source();
    raw["state"] = json!("parked");
    raw["outcome"] = json!("failed");
    raw["outcomeAt"] = json!(42);
    raw["outcomeReason"] = json!(REASON);
    raw
}
fn failed_startup() -> serde_json::Value {
    let mut raw = f::source();
    raw["state"] = json!("failed");
    raw["canRetryStartup"] = json!(true);
    raw["error"] = json!("Session startup: synthetic extension load failed");
    raw
}
/// pilotd's `canRetryHandoff` failure. A saved model still applies to this retry.
fn failed_handoff() -> serde_json::Value {
    let mut raw = failed_turn();
    raw["outcomeReason"] = json!(
        "Compaction failed: The handoff writer's model request failed. Original context was preserved."
    );
    raw["canRetryHandoff"] = json!(true);
    raw["nextAttemptModel"] = json!({"model":"provider/next"});
    raw
}
fn setup_failed() -> serde_json::Value {
    let mut raw = f::source();
    raw["workspaceSetup"] =
        json!({"state":"failed","detail":"Setup failed: Install dependencies (exit 1) 日本語"});
    raw
}
/// The private native-action file pilotd's GUI home holds; only setup reruns read it.
fn with_capability(options: LocalOptions) -> LocalOptions {
    use std::os::unix::fs::PermissionsExt;
    let home = std::env::temp_dir().join(format!("faux-capability-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&home).unwrap();
    let cap = home.join("github-app-capability");
    std::fs::write(
        &cap,
        json!({"daemonId":"test-daemon","lineageId":"test-lineage","token":"b".repeat(64)})
            .to_string(),
    )
    .unwrap();
    std::fs::set_permissions(&cap, std::fs::Permissions::from_mode(0o600)).unwrap();
    options.with_scope_home(home)
}

struct Journey {
    server: Server,
    h: AnyWindowHandle,
    view: Entity<LocalViewer>,
    input: Entity<gpui_kit::component::input::TextareaState>,
    writer: Interaction,
    drain: async_channel::Receiver<crate::interaction::WriteState>,
    root: std::path::PathBuf,
}
impl Journey {
    fn open(
        cx: &mut HeadlessAppContext,
        width: f32,
        behavior: Behavior,
        raw: serde_json::Value,
    ) -> Self {
        let mut server = Server::start(behavior);
        server.options = with_capability(server.options.clone());
        server.seen.lock().unwrap().source = raw.clone();
        let root = std::env::temp_dir()
            .canonicalize()
            .unwrap()
            .join(format!("native-failure-retry-{}", uuid::Uuid::new_v4()));
        let (writer, updates) = Interaction::start(server.options.clone(), Ok(root.clone()));
        let drain = updates.clone();
        let (client, _commands) = LocalClient::synthetic_commands();
        let rows: Vec<_> = (1..8)
            .map(|id| {
                Message::live(
                    id,
                    "assistant".into(),
                    format!(
                        "Reader {id} {}",
                        "Keep the failed conversation readable. ".repeat(12)
                    ),
                )
            })
            .collect();
        let (h, view) = cx
            .update(|cx| {
                gpui_kit::open_window(
                    WindowOptions {
                        window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                            Default::default(),
                            size(px(width), px(840.)),
                        ))),
                        show: false,
                        focus: false,
                        ..Default::default()
                    },
                    cx,
                    |w, cx| {
                        cx.new(|cx| {
                            let mut v = LocalViewer::build(Some(client), Some(writer.clone()), w, cx);
                            v.chat_actions
                                .update(cx, |a, cx| a.connect(server.options.clone(), cx));
                            v.state.status = "Synthetic Local fixture".into();
                            v.state.loaded = true;
                            v.state.list_loaded = true;
                            v.state.generation = 1;
                            v.generation = 1;
                            v.state.retry_entry = Some(7);
                            v.state.chats = Arc::new(vec![crate::local_model::chat(&raw).unwrap()]);
                            v.state.projects = Arc::new(
                                crate::local_model::projects(&json!([{"id":"project","name":"Synthetic","path":"/synthetic/project"}]))
                                    .unwrap(),
                            );
                            v.state.projects_loaded = true;
                            v.selected = Some("source".into());
                            v.title = "Failed source".into();
                            v.transcript
                                .update(cx, |t, cx| t.replace_readonly(rows.clone(), true, cx));
                            v.editor.update(cx, |e, cx| {
                                e.select("chat:source".into(), true, false, w, cx)
                            });
                            v.rebuild_nav(w, cx);
                            v.listen_writes(updates, w, cx);
                            v
                        })
                    },
                )
            })
            .unwrap();
        until(cx, h, |_, cx| view.read(cx).editor.read(cx).ready());
        let input = cx.update(|cx| view.read(cx).editor.read(cx).shell_probe().0);
        Self {
            server,
            h,
            view,
            input,
            writer,
            drain,
            root,
        }
    }
    /// A later summary from Local, as the chat list would publish it.
    fn publish(
        &self,
        cx: &mut HeadlessAppContext,
        edit: impl FnOnce(&mut crate::local_client::Presentation),
    ) {
        let raw = self.server.seen.lock().unwrap().source.clone();
        cx.update_window(self.h, |_, w, cx| {
            self.view.update(cx, |v, cx| {
                let mut state = v.state.clone();
                state.rows = v.transcript.read(cx).link_snapshot_rows();
                state.chats = Arc::new(vec![crate::local_model::chat(&raw).unwrap()]);
                edit(&mut state);
                v.accept(state, w, cx);
            })
        })
        .unwrap();
        settle(cx, self.h);
    }
    fn retry(&self, cx: &mut HeadlessAppContext) -> (String, bool) {
        cx.update_window(self.h, |_, w, _| {
            let b = w.find("session-failure-retry");
            (
                b.label().unwrap_or_default().to_owned(),
                b.disabled() == Some(true),
            )
        })
        .unwrap()
    }
    fn note(&self, cx: &mut HeadlessAppContext) -> Option<String> {
        cx.update_window(self.h, |_, w, _| {
            w.try_find("session-failure-retry-note")
                .and_then(|n| n.label().map(str::to_owned))
        })
        .unwrap()
    }
    fn click(&self, cx: &mut HeadlessAppContext) {
        cx.update_window(self.h, |_, w, cx| w.click("session-failure-retry", cx))
            .unwrap();
        settle(cx, self.h);
    }
    fn requests(&self) -> usize {
        self.server.seen.lock().unwrap().requests.len()
    }
    /// Closes the window, flushes the private store and returns the saved draft.
    fn close(self, cx: &mut HeadlessAppContext) -> String {
        cx.update_window(self.h, |_, w, _| w.remove_window())
            .unwrap();
        drop(self.view);
        drop(self.input);
        cx.run_until_parked();
        assert!(self.writer.command(WriteCommand::Close));
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                tokio::time::timeout(Duration::from_secs(3), async {
                    let mut flushed = false;
                    while let Ok(s) = self.drain.recv().await {
                        flushed |= s.flushed;
                    }
                    assert!(flushed);
                })
                .await
                .unwrap();
            });
        let store = Store::open(self.root.clone(), self.server.options.host()).unwrap();
        let text = store
            .book
            .drafts
            .get("chat:source")
            .map(|d| d.text.clone())
            .unwrap_or_default();
        drop(store);
        std::fs::remove_dir_all(&self.root).unwrap();
        text
    }
}

/// One explicit retry of a failed turn, by pointer or keyboard, at one layout.
fn journey(
    cx: &mut HeadlessAppContext,
    width: f32,
    mode: ThemeMode,
    keyboard: bool,
    dir: &Option<PathBuf>,
) {
    let j = Journey::open(cx, width, Behavior::Slow, failed_turn());
    let draft = "Retry keeps this draft 私の下書き 👩‍💻";
    cx.update_window(j.h, |_, w, cx| {
        assert_eq!(cx.theme().is_dark(), mode == ThemeMode::Dark);
        j.input.update(cx, |i, cx| i.focus(w, cx));
        w.input(draft, cx);
        j.input.update(cx, |i, cx| {
            i.replace_and_mark_text_in_range(None, "ガ", Some(1..1), w, cx)
        });
    })
    .unwrap();
    settle(cx, j.h);
    assert_eq!(j.retry(cx), ("Retry".into(), false));
    assert_eq!(j.note(cx), None, "a retryable failure needs no explanation");
    cx.update_window(j.h, |_, w, _| {
        let banner = w.find("session-failure").bounds();
        let retry = w.find("session-failure-retry").bounds();
        let copy = w.find("session-failure-copy").bounds();
        assert!(banner.contains(&retry.origin) && banner.contains(&copy.origin));
        assert!(retry.right() <= copy.left(), "Retry precedes Copy reason");
        assert!(
            (retry.center().y - copy.center().y).abs() < px(1.),
            "one action row"
        );
        assert!(retry.size.height >= px(20.), "usable target");
    })
    .unwrap();
    capture(
        cx,
        j.h,
        dir,
        format!(
            "failure-retry-{}-{}.png",
            width as u32,
            if mode == ThemeMode::Dark {
                "dark"
            } else {
                "light"
            }
        ),
    );
    // A pointer on the banner can't commit or blur the composition, nor retry.
    let reads = j.requests();
    j.click(cx);
    cx.update_window(j.h, |_, w, cx| {
        let marked = j.input.update(cx, |i, cx| i.marked_text_range(w, cx));
        assert!(marked.is_some(), "preedit kept");
        j.input
            .update(cx, |i, cx| i.replace_text_in_range(marked, "", w, cx));
    })
    .unwrap();
    settle(cx, j.h);
    assert_eq!(j.requests(), reads, "no read or write during composition");
    let text = cx.update(|cx| j.input.read(cx).value().to_string());
    assert_eq!(text, draft);
    if keyboard {
        for _ in 0..80 {
            let focused = cx
                .update_window(j.h, |_, w, cx| {
                    if w.find("session-failure-retry").focused() == Some(true) {
                        true
                    } else {
                        w.press("tab", cx);
                        false
                    }
                })
                .unwrap();
            settle(cx, j.h);
            if focused {
                break;
            }
        }
        cx.update_window(j.h, |_, w, cx| {
            assert_eq!(w.find("session-failure-retry").focused(), Some(true));
            w.press("enter", cx);
        })
        .unwrap();
    } else {
        j.click(cx);
    }
    until(cx, j.h, |_, _| j.server.posts() == 1);
    // Pending: shown in place, input waits, repeats submit nothing.
    assert_eq!(j.retry(cx), ("Retrying…".into(), true));
    cx.update_window(j.h, |_, w, cx| {
        assert_eq!(w.find("local-send").disabled(), Some(true));
        assert!(
            w.try_find("chat-action-status")
                .is_none_or(|s| s.bounds().size.height < px(1.)),
            "status is in the banner, not the sidebar"
        );
        if keyboard {
            w.press("enter", cx);
            w.press("space", cx);
        }
        w.click("session-failure-retry", cx);
    })
    .unwrap();
    settle(cx, j.h);
    {
        let seen = j.server.seen.lock().unwrap();
        let posts: Vec<_> = seen.requests.iter().filter(|r| r.0 == "POST").collect();
        assert_eq!(posts.len(), 1);
        assert_eq!(posts[0].1, "/api/sessions/source/rewind");
        assert_eq!(posts[0].2, json!({"action":"retry","entryId":7}));
    }
    capture(
        cx,
        j.h,
        dir,
        format!(
            "failure-retry-pending-{}-{}.png",
            width as u32,
            if mode == ThemeMode::Dark {
                "dark"
            } else {
                "light"
            }
        ),
    );
    j.server.released.notify_one();
    until(cx, j.h, |_, cx| {
        j.view.read(cx).chat_actions.read(cx).outcome("source")
            == Some(&crate::chat_actions::Outcome::Acknowledged)
    });
    assert_eq!(j.retry(cx), ("Retry sent".into(), true));
    cx.update_window(j.h, |_, w, cx| {
        assert_eq!(j.input.read(cx).value().as_ref(), draft);
        assert_ne!(
            w.find("local-send").disabled(),
            Some(true),
            "input returns after the ACK"
        );
    })
    .unwrap();
    // Local reports the new attempt running: the failure and its Retry leave.
    j.publish(cx, |s| s.retry_entry = None);
    cx.update_window(j.h, |_, w, cx| {
        assert!(w.try_find("session-failure").is_none());
        assert_eq!(j.input.read(cx).value().as_ref(), draft);
    })
    .unwrap();
    assert_eq!(j.server.posts(), 1);
    assert_eq!(j.close(cx), draft, "the private draft is retained");
}

/// Refusals, unavailable reasons, startup retry and an unconfirmed turn retry.
fn edges(cx: &mut HeadlessAppContext, dir: &Option<PathBuf>) {
    // Unavailable: shown disabled with the reason, and nothing is read or sent.
    let j = Journey::open(cx, 1100., Behavior::Accept, failed_turn());
    for (edit, reason) in [
        (
            0,
            "This failure has no turn to retry. Send a message to continue.",
        ),
        (
            1,
            "Your saved model applies to the next message you send. Send one to continue.",
        ),
        (2, "Reconnect to Local to retry."),
    ] {
        if edit == 1 {
            j.server.seen.lock().unwrap().source["nextAttemptModel"] =
                json!({"model":"provider/next","thinking":"high"});
        }
        j.publish(cx, |s| match edit {
            0 => s.retry_entry = None,
            1 => {}
            _ => s.status = "Disconnected".into(),
        });
        assert_eq!(j.retry(cx), ("Retry".into(), true), "{reason}");
        assert_eq!(j.note(cx).as_deref(), Some(reason));
        let before = j.requests();
        j.click(cx);
        cx.update_window(j.h, |_, w, cx| {
            w.find("session-failure-retry");
            w.press("enter", cx);
        })
        .unwrap();
        settle(cx, j.h);
        assert_eq!(j.requests(), before, "{reason}");
        if edit == 0 {
            capture(
                cx,
                j.h,
                dir,
                "failure-retry-unavailable-1100-light.png".into(),
            );
        }
        j.server.seen.lock().unwrap().source = failed_turn();
        j.publish(cx, |s| {
            s.retry_entry = Some(7);
            s.status = "Synthetic Local fixture".into();
        });
    }
    // Stale: Local's chat changed after this summary. Refused before any POST.
    j.server.seen.lock().unwrap().source["outcomeAt"] = json!(43);
    j.click(cx);
    until(cx, j.h, |_, cx| {
        j.view
            .read(cx)
            .chat_actions
            .read(cx)
            .retry_view("source", Some(42))
            != crate::chat_actions_view::RetryView::Busy
    });
    assert_eq!(
        j.note(cx).as_deref(),
        Some("This failure changed. Nothing was submitted.")
    );
    assert_eq!(
        j.retry(cx),
        ("Retry".into(), false),
        "nothing was submitted; offered again"
    );
    assert_eq!(j.server.posts(), 0);
    // Startup failure: reloads the worker on the existing route, once.
    j.server.seen.lock().unwrap().source = failed_startup();
    j.publish(cx, |s| s.retry_entry = None);
    assert_eq!(j.retry(cx), ("Retry".into(), false));
    j.click(cx);
    until(cx, j.h, |_, cx| {
        j.view.read(cx).chat_actions.read(cx).outcome("source")
            == Some(&crate::chat_actions::Outcome::Acknowledged)
    });
    {
        let seen = j.server.seen.lock().unwrap();
        let posts: Vec<_> = seen.requests.iter().filter(|r| r.0 == "POST").collect();
        assert_eq!(posts.len(), 1);
        assert_eq!(posts[0].1, "/api/sessions/source/retry-startup");
        assert!(posts[0].2.is_null());
    }
    j.close(cx);

    // Failed automatic handoff: no failed turn to rewind; one fresh run, once.
    let j = Journey::open(cx, 1100., Behavior::Accept, failed_handoff());
    j.publish(cx, |s| s.retry_entry = None);
    assert_eq!(j.retry(cx), ("Retry".into(), false));
    assert_eq!(j.note(cx), None, "a saved model never blocks this retry");
    j.click(cx);
    until(cx, j.h, |_, cx| {
        j.view.read(cx).chat_actions.read(cx).outcome("source")
            == Some(&crate::chat_actions::Outcome::Acknowledged)
    });
    {
        let seen = j.server.seen.lock().unwrap();
        let posts: Vec<_> = seen.requests.iter().filter(|r| r.0 == "POST").collect();
        assert_eq!(posts.len(), 1);
        assert_eq!(posts[0].1, "/api/sessions/source/retry-handoff");
        assert!(posts[0].2["operationId"].is_string());
    }
    j.click(cx);
    settle(cx, j.h);
    assert_eq!(j.server.posts(), 1, "never repeated");
    j.close(cx);

    // Lost ACK: Unknown is explained in place and never repeated.
    let j = Journey::open(cx, 1100., Behavior::Lost, failed_turn());
    j.click(cx);
    until(cx, j.h, |_, cx| {
        j.view.read(cx).chat_actions.read(cx).outcome("source")
            == Some(&crate::chat_actions::Outcome::Unknown)
    });
    assert_eq!(
        j.note(cx).as_deref(),
        Some(crate::chat_actions_view::RETRY_UNKNOWN)
    );
    assert_eq!(j.retry(cx), ("Retry".into(), true));
    capture(cx, j.h, dir, "failure-retry-unknown-1100-light.png".into());
    j.click(cx);
    cx.update_window(j.h, |_, w, cx| {
        j.input.update(cx, |i, cx| i.focus(w, cx));
        w.input("Continue after an unconfirmed retry", cx);
    })
    .unwrap();
    settle(cx, j.h);
    cx.update_window(j.h, |_, w, _| {
        assert_ne!(
            w.find("local-send").disabled(),
            Some(true),
            "Unknown never locks the composer"
        );
    })
    .unwrap();
    settle(cx, j.h);
    assert_eq!(j.server.posts(), 1, "Unknown must not be repeated");
    j.close(cx);
}

pub(super) fn run(cx: &mut HeadlessAppContext) {
    let dir = std::env::var_os("PILOT_NEXT_CHAT_ACTIONS_DIR").map(PathBuf::from);
    if let Some(d) = &dir {
        std::fs::create_dir_all(d).unwrap();
    }
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            cx.update(|cx| {
                crate::appearance::commit_appearance(
                    if mode == ThemeMode::Dark {
                        crate::settings_state::AppearancePreference::Dark
                    } else {
                        crate::settings_state::AppearancePreference::Light
                    },
                    cx,
                )
            });
            journey(cx, width, mode, mode == ThemeMode::Light, &dir);
            setup_rerun(cx, width, mode, &dir);
        }
    }
    cx.update(|cx| {
        crate::appearance::commit_appearance(crate::settings_state::AppearancePreference::Light, cx)
    });
    edges(cx, &dir);
    println!(
        "{}",
        json!({"failed_turn_retry":true,"handoff_retry":true,"setup_rerun":true,"startup_retry":true,"pointer_and_keyboard":true,"layouts":"680/1100 light/dark","preedit_guard":true,"pending_repeat_single_post":true,"unknown_never_repeated":true,"stale_disconnected_unavailable_refused":true,"draft_retained":true})
    );
}
/// Run setup again from the setup failure banner: one capability-carrying POST,
/// then the banner leaves once Local reports the queued setup.
fn setup_rerun(cx: &mut HeadlessAppContext, width: f32, mode: ThemeMode, dir: &Option<PathBuf>) {
    let j = Journey::open(cx, width, Behavior::Accept, setup_failed());
    cx.update_window(j.h, |_, w, _| {
        let banner = w.find("workspace-setup-failure").bounds();
        let b = w.find("workspace-setup-rerun");
        assert!(b.visible() && b.disabled() != Some(true));
        assert!(b.bounds().right() <= banner.right());
        assert!(
            w.try_find("session-failure").is_none(),
            "setup never claims the agent failed"
        );
    })
    .unwrap();
    if let Some(d) = dir {
        cx.capture_screenshot(j.h)
            .unwrap()
            .save(d.join(format!("setup-rerun-{width}-{mode:?}.png")))
            .unwrap();
    }
    cx.update_window(j.h, |_, w, cx| w.click("workspace-setup-rerun", cx))
        .unwrap();
    settle(cx, j.h);
    until(cx, j.h, |_, cx| {
        j.view
            .read(cx)
            .chat_actions
            .read(cx)
            .setup_rerun("source")
            .is_some_and(|o| o == Some(crate::chat_actions::Outcome::Acknowledged))
    });
    assert_eq!(j.server.posts(), 1);
    assert_eq!(
        j.server.seen.lock().unwrap().requests.last().unwrap().1,
        "/api/sessions/source/setup"
    );
    cx.update_window(j.h, |_, w, _| {
        assert!(w.find("workspace-setup-rerun").disabled() == Some(true));
        assert!(w.find("workspace-setup-rerun-note").visible());
    })
    .unwrap();
    assert!(
        !cx.update(|cx| j.view.read(cx).chat_actions.read(cx).read_only("source")),
        "setup never locks the composer"
    );
    // Local's next summary reports the queued setup: the failure banner leaves.
    j.publish(cx, |_| {});
    cx.update_window(j.h, |_, w, _| {
        assert!(w.try_find("workspace-setup-failure").is_none());
    })
    .unwrap();
    assert_eq!(j.server.posts(), 1, "never repeated");
    j.close(cx);
}
