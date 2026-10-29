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
    // No visible draft, but a retained immutable Unknown from an earlier send.
    // The old full-GUI checkpoint falsely refused this empty composer.
    let root = std::env::temp_dir().join(format!("daemon-empty-{}", uuid::Uuid::new_v4()));
    let mut store = crate::delivery_store::Store::open(
        root.clone(),
        crate::delivery_store::Book::shell_probe().host.clone(),
    )
    .unwrap();
    store
        .prepare(
            "chat:earlier",
            &crate::delivery_store::Draft {
                revision: 1,
                text: "previous synthetic send".into(),
                ..Default::default()
            },
            false,
            false,
        )
        .unwrap();
    store.book.drafts.clear();
    let retained = serde_json::to_vec(&store.book.pending).unwrap();
    cx.update_window(h, |_, w, cx| {
        view.update(cx, |v, cx| {
            v.editor.update(cx, |e, cx| {
                e.accept(
                    crate::interaction::WriteState {
                        book: Some(Arc::new(store.book.clone())),
                        ..Default::default()
                    },
                    w,
                    cx,
                )
            });
            assert!(input.read(cx).value().is_empty());
        });
        daemon.update(cx, |u, cx| u.request_probe(cx));
    })
    .unwrap();
    let end = std::time::Instant::now() + Duration::from_secs(5);
    while count.load(Ordering::SeqCst) == 0 {
        assert!(
            std::time::Instant::now() < end,
            "zero-draft daemon upgrade must not require GUI checkpoint settlement"
        );
        settle(cx, h);
        std::thread::yield_now();
    }
    cx.update_window(h, |_, w, cx| {
        let v = view.read(cx);
        assert!(!v.restart_pending && !v.settings.read(cx).restart_locked);
        assert!(v.daemon_upgrade_pending);
        // UI-only state remains live, even during native preedit and dirty secondary forms.
        input.focus_handle(cx).focus(w, cx);
        input.update(cx, |i, cx| {
            i.replace_and_mark_text_in_range(None, "にほん", Some(3..3), w, cx)
        });
        assert!(
            input
                .update(cx, |i, cx| i.marked_text_range(w, cx))
                .is_some()
        );
    })
    .unwrap();
    send.send(Err(Failure::Busy)).unwrap();
    while cx.update(|cx| daemon.read(cx).active()) {
        assert!(std::time::Instant::now() < end);
        settle(cx, h);
        std::thread::yield_now();
    }
    // A fresh explicit attempt must also admit pre-existing composition and forms.
    cx.update(|cx| {
        view.update(cx, |v, cx| {
            v.settings.update(cx, |o, _| {
                o.state
                    .set_appearance(crate::settings_state::AppearancePreference::Dark);
            });
            v.mission_open = true;
        });
        daemon.update(cx, |u, cx| u.request_probe(cx));
    });
    while count.load(Ordering::SeqCst) < 2 {
        assert!(
            std::time::Instant::now() < end,
            "live composition and secondary forms do not veto daemon replacement"
        );
        settle(cx, h);
        std::thread::yield_now();
    }
    send.send(Err(Failure::Unknown)).unwrap();
    while cx.update(|cx| daemon.read(cx).active()) {
        assert!(std::time::Instant::now() < end);
        settle(cx, h);
        std::thread::yield_now();
    }
    settle(cx, h);
    cx.update_window(h, |_, w, cx| {
        let v = view.read(cx);
        assert!(daemon.read(cx).uncertain());
        assert!(!v.restart_pending && !v.daemon_upgrade_pending);
        assert!(!v.settings.read(cx).restart_locked);
        assert!(v.settings.read(cx).state.dirty());
        assert!(v.mission_open);
        assert_eq!(v.editor.read(cx).retained_deliveries_probe(), retained);
        assert_eq!(input.read(cx).value().as_ref(), "にほん");
        assert!(
            input
                .update(cx, |i, cx| i.marked_text_range(w, cx))
                .is_some()
        );
        assert!(
            !daemon.update(cx, |u, cx| u.request_probe(cx)),
            "no uncertain lifecycle replay"
        );
    })
    .unwrap();
    while let Ok(command) = commands.try_recv() {
        assert!(
            !matches!(command, crate::interaction::WriteCommand::Checkpoint(_)),
            "daemon-only replacement must not checkpoint or replay UI actions"
        );
    }
    assert_eq!(serde_json::to_vec(&store.book.pending).unwrap(), retained);
    cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
    cx.run_until_parked();
    drop(store);
    std::fs::remove_dir_all(root).unwrap();
    eprintln!(
        "daemon-upgrade-root: empty composer + retained Unknown, live IME, no GUI fences, no replay"
    );
}
