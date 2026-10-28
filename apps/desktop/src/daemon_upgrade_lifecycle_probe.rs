//! Actual LocalViewer checkpoint integration, entirely synthetic and memory-only.
use super::*;
use crate::{
    daemon_upgrade_view::{DaemonUpgrade, Target, Worker},
    settings_state::{LoadedPreferences, Preferences, SettingsState},
};
use gpui_kit::{
    Bounds, EntityInputHandler, Focusable, HeadlessAppContext, WindowBounds, WindowOptions, size,
    test::TestWindowExt,
};
use pilot_desktop_updater::{coordination::Location, daemon_upgrade::Failure};
use std::sync::{
    Mutex,
    atomic::{AtomicUsize, Ordering},
    mpsc,
};

fn settle(cx: &mut HeadlessAppContext, h: gpui_kit::AnyWindowHandle) {
    for _ in 0..4 {
        cx.run_until_parked();
        cx.advance_clock(Duration::from_millis(16));
        cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
    }
}
fn acknowledge(
    cx: &mut HeadlessAppContext,
    h: gpui_kit::AnyWindowHandle,
    view: &Entity<LocalViewer>,
    generation: u64,
) {
    cx.update_window(h, |_, w, cx| {
        view.update(cx, |v, cx| {
            let draft = v.editor.read(cx).shell_probe().2.unwrap();
            let mut book = crate::delivery_store::Book::shell_probe();
            book.drafts.insert("chat:synthetic".into(), draft);
            v.editor.update(cx, |e, cx| {
                e.accept(
                    crate::interaction::WriteState {
                        book: Some(Arc::new(book)),
                        checkpoint: Some(generation),
                        ..Default::default()
                    },
                    w,
                    cx,
                )
            });
            v.advance_daemon_upgrade(w, cx);
        })
    })
    .unwrap();
    settle(cx, h);
}
pub fn run_daemon_upgrade_lifecycle_probe(cx: &mut HeadlessAppContext) {
    let (writer, commands) = Interaction::recording();
    let count = Arc::new(AtomicUsize::new(0));
    let seen = count.clone();
    let (send, result) = mpsc::channel();
    let result = Mutex::new(result);
    let worker: Worker = Arc::new(
        move |_: Location, _: String, _: String, _: Arc<std::sync::atomic::AtomicBool>| {
            seen.fetch_add(1, Ordering::SeqCst);
            result.lock().unwrap().recv().unwrap()
        },
    );
    let (h, view) = cx
        .update(|cx| {
            gpui_kit::open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                        Default::default(),
                        size(px(1100.), px(760.)),
                    ))),
                    show: false,
                    focus: false,
                    ..Default::default()
                },
                cx,
                |w, cx| {
                    cx.new(|cx| {
                        let mut v = LocalViewer::preview(PreviewState::Conversation, w, cx);
                        v.writer = Some(writer.clone());
                        v.editor
                            .update(cx, |e, cx| e.shell_probe_setup(writer, w, cx));
                        let target = Target::new(
                            Location {
                                home: "/nonexistent/synthetic-daemon-profile".into(),
                                port: 1,
                                policy: Default::default(),
                            },
                            "synthetic-daemon".into(),
                            "synthetic-lineage".into(),
                        );
                        let daemon =
                            cx.new(|cx| DaemonUpgrade::with_target(Some(target), worker, cx));
                        v.settings = cx.new(|cx| {
                            let mut owner = crate::settings_view::SettingsPreferences::new(None);
                            let mut state = SettingsState::default();
                            assert!(state.begin_load());
                            assert!(state.finish_load(Ok(LoadedPreferences {
                                preferences: Preferences::default(),
                                persisted: true
                            })));
                            owner.state = state;
                            owner.daemon_upgrade = Some(daemon);
                            owner.load(cx);
                            owner
                        });
                        v.connect_updates(w, cx);
                        v
                    })
                },
            )
        })
        .unwrap();
    settle(cx, h);
    let ready_deadline = std::time::Instant::now() + Duration::from_secs(5);
    while !cx.update(|cx| view.read(cx).editor.read(cx).ready()) {
        assert!(
            std::time::Instant::now() < ready_deadline,
            "synthetic editor must become ready before IME check"
        );
        settle(cx, h);
    }
    let daemon = cx.update(|cx| {
        view.read(cx)
            .settings
            .read(cx)
            .daemon_upgrade
            .clone()
            .unwrap()
    });
    let input = cx.update(|cx| view.read(cx).editor.read(cx).shell_probe().0);
    // Genuine marked text vetoes the request, retaining the text/composition.
    cx.update_window(h, |_, w, cx| {
        input.focus_handle(cx).focus(w, cx);
        input.update(cx, |i, cx| {
            i.replace_and_mark_text_in_range(None, "にほん", Some(3..3), w, cx)
        });
        daemon.update(cx, |u, cx| u.request_probe(cx));
    })
    .unwrap();
    settle(cx, h);
    cx.update_window(h, |_, w, cx| {
        assert!(!view.read(cx).restart_pending);
        assert_eq!(
            daemon.read(cx).notice(),
            Some("Finish text composition before upgrading. Nothing was discarded.")
        );
        assert!(
            input
                .update(cx, |i, cx| i.marked_text_range(w, cx))
                .is_some()
        );
        input.update(cx, |i, cx| {
            i.replace_text_in_range(None, "retained draft 🐦", w, cx)
        });
    })
    .unwrap();
    assert_eq!(count.load(Ordering::SeqCst), 0);
    // Request freezes ordinary UI, but a missing or stale ACK never starts work.
    cx.update(|cx| daemon.update(cx, |u, cx| u.request_probe(cx)));
    settle(cx, h);
    let generation = cx.update(|cx| {
        let v = view.read(cx);
        assert!(v.daemon_upgrade_pending && v.restart_pending);
        assert!(v.settings.read(cx).restart_locked);
        v.restart_generation
    });
    assert_eq!(count.load(Ordering::SeqCst), 0);
    acknowledge(cx, h, &view, generation + 1);
    assert_eq!(
        count.load(Ordering::SeqCst),
        0,
        "stale checkpoint cannot authorize lifecycle"
    );
    // Cancel during checkpointing releases fences without any daemon action.
    cx.update(|cx| daemon.update(cx, |u, cx| u.cancel(cx)));
    settle(cx, h);
    cx.update(|cx| assert!(!view.read(cx).restart_pending));
    cx.update(|cx| daemon.update(cx, |u, cx| u.request_probe(cx)));
    settle(cx, h);
    let generation = cx.update(|cx| view.read(cx).restart_generation);
    acknowledge(cx, h, &view, generation);
    let end = std::time::Instant::now() + Duration::from_secs(5);
    while count.load(Ordering::SeqCst) == 0 {
        assert!(std::time::Instant::now() < end);
        settle(cx, h);
        std::thread::yield_now();
    }
    assert_eq!(count.load(Ordering::SeqCst), 1);
    send.send(Err(Failure::Unknown)).unwrap();
    while cx.update(|cx| daemon.read(cx).active()) {
        assert!(std::time::Instant::now() < end);
        settle(cx, h);
        std::thread::yield_now();
    }
    settle(cx, h);
    cx.update(|cx| {
        let v = view.read(cx);
        assert!(daemon.read(cx).uncertain());
        assert!(v.restart_pending && v.daemon_upgrade_pending);
        assert!(v.settings.read(cx).restart_locked);
        assert_eq!(input.read(cx).value().as_ref(), "retained draft 🐦");
    });
    while let Ok(command) = commands.try_recv() {
        assert!(
            matches!(command, crate::interaction::WriteCommand::Checkpoint(_)),
            "no user/agent action may be replayed"
        );
    }
    // Synthetic teardown only, not a product recovery action.
    cx.update(|cx| view.update(cx, |v, cx| v.finish_daemon_checkpoint(cx)));
    cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
    cx.run_until_parked();
    eprintln!(
        "daemon-upgrade-root: IME, missing/stale/exact checkpoint, cancel, Unknown fences; one synthetic worker"
    );
}
