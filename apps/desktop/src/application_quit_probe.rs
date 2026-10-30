//! Real hidden AppKit windows/menu dispatch and application shutdown, not owner Close.
use super::*;
use crate::{
    delivery_store::{Book, Draft, Intent, Store},
    interaction::WriteState,
    lost_ack_fixture::{self as faux, Server},
};
use gpui_kit::{AsyncApp, WindowOptions, test::TestWindowExt};
use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use std::{cell::Cell, ffi::c_void, path::PathBuf, rc::Rc, sync::Mutex};

fn question() -> crate::question::Question {
    crate::question::Question::parse(
        17,
        &serde_json::json!({"question":"Retained reply?","options":[{"label":"Keep"}]}),
    )
    .unwrap()
}
fn captured() -> Draft {
    Draft {
        revision: 4,
        text: faux::ORIGINAL.into(),
        cwd: "/synthetic".into(),
        project_id: Some("p".into()),
        model_choice: Some(crate::chat_models::DraftChoice {
            project_id: "p".into(),
            cwd: "/synthetic".into(),
            choice: crate::chat_models::Choice {
                model: "synthetic/model".into(),
                thinking: Some("high".into()),
            },
        }),
        answer: Some(
            crate::question::AnswerDraft::capture(
                &question(),
                4,
                std::collections::BTreeSet::from([0]),
                "Unresolved 日本語 reply".into(),
            )
            .unwrap(),
        ),
        ..Default::default()
    }
}
fn disk(root: &std::path::Path) -> Book {
    serde_json::from_slice(&std::fs::read(root.join("state-v1.json")).unwrap()).unwrap()
}
fn unchanged(book: &Book, original: &Intent) {
    let mut current = book.pending[&original.id].clone();
    current.diagnostic = original.diagnostic;
    assert!(
        current == *original,
        "Close changed captured intent/request bytes"
    );
    assert_eq!(current.state, "unknown");
}

/// Each child owns its native application and exits through NSApplication.
/// The parent then opens the same Store independently, without retry or sleeps.
pub fn run_application_quit_probe() {
    if let Ok(mode) = std::env::var("PILOT_QUIT_FIXTURE") {
        let root = PathBuf::from(std::env::var_os("PILOT_QUIT_FIXTURE_ROOT").unwrap());
        child(mode, root);
        panic!("native termination unexpectedly returned");
    }
    for mode in [
        "update-exit",
        "unknown-update-exit",
        "answer-update-exit",
        "external-terminate",
        "close",
        "quit",
        "held-close",
        "held-quit",
        "unknown-quit",
        "answer-quit",
        "fault",
    ] {
        let root = std::env::temp_dir().join(format!("application-quit-{}", uuid::Uuid::new_v4()));
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .env("PILOT_QUIT_FIXTURE", mode)
            .env("PILOT_QUIT_FIXTURE_ROOT", &root)
            .status()
            .unwrap();
        assert!(status.success(), "hidden native {mode}: {status}");
        // Actual OS process exit, not a synthetic writer-lane ACK or a delay.
        let mut next = Store::open(root.clone(), LocalOptions::synthetic(1).host()).unwrap();
        let expected = if mode == "fault" {
            faux::ORIGINAL
        } else {
            faux::NEWER
        };
        if mode != "external-terminate" {
            assert_eq!(next.book.drafts["chat:a"].text, expected);
        }
        if mode != "fault" && mode != "external-terminate" {
            assert_eq!(next.book.drafts["chat:b"].text, "Separate 🦀 draft");
        }
        assert!(next.book.drafts["chat:a"].answer == captured().answer);
        assert_eq!(
            next.book.drafts["chat:a"].model_choice,
            captured().model_choice
        );
        assert_eq!(
            next.book.pending.len(),
            usize::from(
                mode.starts_with("held")
                    || mode == "unknown-quit"
                    || mode == "unknown-update-exit"
                    || mode == "answer-update-exit"
                    || mode == "external-terminate"
                    || mode == "answer-quit"
                    || mode == "fault"
            )
        );
        // Replacement owner is writable immediately after the child exited.
        next.save_edits(std::collections::BTreeMap::from([(
            "chat:replacement".into(),
            Draft {
                revision: 1,
                text: "Independent owner reopened".into(),
                ..Default::default()
            },
        )]))
        .unwrap();
        drop(next);
        std::fs::remove_dir_all(root).unwrap();
        println!(
            "application_quit: {mode} native process exit + immediate independent Store reopen passed"
        );
    }
}

async fn wait_for(
    cx: &mut AsyncApp,
    editor: &Entity<ChatEditor>,
    changed: &async_channel::Receiver<()>,
    condition: impl Fn(&WriteState) -> bool,
) {
    // Event-driven, including real courier publication. No polling or settling sleep.
    while !cx.update(|cx| condition(editor.read(cx).teardown_probe_state())) {
        changed.recv().await.unwrap();
    }
}

fn child(mode: String, root: PathBuf) {
    let server = Arc::new(Server::start());
    let mut store = Store::open(root.clone(), server.options.host()).unwrap();
    store
        .save_edits(std::collections::BTreeMap::from([(
            "chat:a".into(),
            captured(),
        )]))
        .unwrap();
    let original = if mode == "unknown-quit" || mode == "unknown-update-exit" {
        Some(store.prepare("chat:a", &captured(), false, false).unwrap())
    } else if mode == "answer-quit" || mode == "answer-update-exit" {
        let draft = captured();
        Some(
            store
                .prepare_answer(
                    "chat:a",
                    &draft,
                    &question(),
                    draft.answer.as_ref().unwrap(),
                )
                .unwrap(),
        )
    } else {
        None
    };
    drop(store);
    let root = root.canonicalize().unwrap();
    let original = Arc::new(Mutex::new(original));
    gpui_kit::application()
        .with_assets(crate::ChromeAssets)
        .run(move |cx| {
            gpui_kit::init(cx);
            crate::init_appearance(cx);
            TranscriptView::bind_keys(cx);
            LocalViewer::bind_keys(cx);
            crate::app_menu::init(cx);
            let (writer, writes) = Interaction::start(server.options.clone(), Ok(root.clone()));
            let (client, commands) = LocalClient::synthetic_commands();
            let (h, view) = gpui_kit::open_window(
                WindowOptions {
                    show: false,
                    focus: false,
                    ..Default::default()
                },
                cx,
                |w, cx| {
                    cx.new(|cx| {
                        let mut v = LocalViewer::build(Some(client), Some(writer.clone()), w, cx);
                        v.state.chats = Arc::new(
                            ["a", "b"]
                                .map(|id| crate::local_model::chat(&faux::summary(id)).unwrap())
                                .to_vec(),
                        );
                        v.state.list_loaded = true;
                        v.state.loaded = true;
                        if mode.ends_with("update-exit") {
                            let updater = cx.new(|_| crate::updates_view::Updates::probe_ready_local());
                            v.settings = cx.new(|_| crate::settings_view::SettingsPreferences::new(Some(Ok(root.join("preferences")))));
                            v.settings.update(cx, |s, cx| {
                                s.updater = Some(updater);
                                s.load(cx);
                            });
                            v.connect_updates(w, cx);
                        }
                        v.listen_writes(writes, w, cx);
                        LocalViewer::register_close(w, cx);
                        v
                    })
                },
            )
            .unwrap();
            let editor = view.read(cx).editor.clone();
            let (wake, changed) = async_channel::bounded(1);
            let settings_wake = wake.clone();
            cx.observe(&editor, move |_, _| {
                let _ = wake.try_send(());
            })
            .detach();
            let settings = view.read(cx).settings.clone();
            cx.observe(&settings, move |_, _| {
                let _ = settings_wake.try_send(());
            }).detach();
            let approved = Rc::new(Cell::new(false));
            let checked = approved.clone();
            let (exit_root, exit_server, exit_original, exit_mode) =
                (root.clone(), server.clone(), original.clone(), mode.clone());
            let exit_editor = editor.clone();
            let exit_writer = writer.clone();
            cx.on_app_quit(move |cx| {
                assert!(
                    checked.get(),
                    "application exited before its Close/veto checks"
                );
                let state = exit_editor.read(cx).teardown_probe_state();
                if exit_mode == "external-terminate" {
                    assert!(!state.flushed, "external terminate unexpectedly drained");
                    assert!(exit_writer.command(crate::interaction::WriteCommand::Checkpoint(999)), "external bypass no longer has an open input lane");
                    assert!(Store::open(exit_root.clone(), exit_server.options.host()).is_err(), "external terminate unexpectedly released Store before shutdown");
                    println!("application_quit: external terminate bypass observed: no Flushed, Store locked, input open");
                } else if exit_mode == "fault" {
                    assert!(
                        !state.flushed,
                        "failed private persistence must veto graceful Quit"
                    );
                } else {
                    assert!(state.flushed, "root bypassed courier drain");
                    assert!(!exit_writer.command(crate::interaction::WriteCommand::Checkpoint(999)), "courier input still accepts commands at app shutdown");
                    // This callback runs at actual GPUI/native application shutdown.
                    // Opening here must not race the worker's still-held lock.
                    let replacement =
                        Store::open(exit_root.clone(), exit_server.options.host()).unwrap();
                    assert_eq!(replacement.book.drafts["chat:a"].text, faux::NEWER);
                    assert_eq!(replacement.book.drafts["chat:b"].text, "Separate 🦀 draft");
                    assert!(replacement.book.drafts["chat:a"].answer == captured().answer);
                    assert_eq!(
                        replacement.book.drafts["chat:a"].model_choice,
                        captured().model_choice
                    );
                    if let Some(intent) = exit_original.lock().unwrap().as_ref() {
                        unchanged(&replacement.book, intent);
                    }
                    if exit_mode.starts_with("held") {
                        // The cancelled HTTP gets an exact late ACK while the independent
                        // replacement still owns the lock. It must not adopt into that Store.
                        exit_server.seen.lock().unwrap().accept_execute = true;
                        let before = std::fs::read(exit_root.join("state-v1.json")).unwrap();
                        exit_server.release.send_blocking(()).unwrap();
                        tokio::runtime::Builder::new_current_thread().enable_time().build().unwrap().block_on(async {
                            tokio::time::timeout(Duration::from_secs(2), exit_server.responded.recv()).await.unwrap().unwrap();
                        });
                        assert_eq!(
                            std::fs::read(exit_root.join("state-v1.json")).unwrap(),
                            before
                        );
                    }
                }
                let seen = exit_server.seen.lock().unwrap();
                assert_eq!(
                    seen.executes,
                    usize::from(exit_mode.starts_with("held") || exit_mode == "fault" || exit_mode == "external-terminate")
                );
                assert_eq!(
                    seen.lookups,
                    usize::from(exit_mode.starts_with("held") || exit_mode == "fault" || exit_mode == "external-terminate")
                );
                assert!(seen.panic.is_none(), "fixture handler: {:?}", seen.panic);
                assert!(seen.requests.iter().all(|(method, path)| method == "GET"
                    || path == "/api/operations"
                    || path == "/api/operations/receipt"));
                println!("application_quit: {exit_mode} real GPUI shutdown boundary checked");
                std::future::ready(())
            })
            .detach();
            // A failure deadline only, not a timer used as durability or readiness proof.
            cx.spawn(async move |cx| {
                cx.background_executor()
                    .timer(Duration::from_secs(12))
                    .await;
                eprintln!("hidden native Quit fixture exceeded its failure deadline");
                std::process::exit(1);
            })
            .detach();
            cx.spawn(async move |cx| {
                let _commands = commands;
                wait_for(cx, &editor, &changed, |s| s.book.is_some()).await;
                while !cx.update(|cx| {
                    let state = &view.read(cx).settings.read(cx).state;
                    assert!(state.error().is_none(), "private preferences: {:?}", state.error());
                    state.loaded()
                }) {
                    changed.recv().await.unwrap();
                }
                let open = |id: &str, cx: &mut AsyncApp| {
                    h.update(cx, |_, w, cx| {
                        view.update(cx, |v, cx| {
                            let chat = v.state.chats.iter().find(|c| c.id == id).unwrap().clone();
                            assert!(v.open(chat, w, cx), "open {id}: {:?}", v.nav_error);
                        })
                    })
                    .unwrap()
                };
                open("a", cx);
                let native = h.update(cx, |_, w, _| native_window(w)).unwrap();
                // Exercise existing Settings veto through BOTH native entry points.
                h.update(cx, |_, _, cx| {
                    view.read(cx).settings.clone().update(cx, |s, _| {
                        assert!(s.state.loaded());
                        s.state.set_automatic_update_checks(
                            !s.state.current().automatic_update_checks,
                        );
                    })
                })
                .unwrap();
                native_close(native);
                native_quit();
                h.update(cx, |_, _, cx| {
                    assert!(
                        editor.read(cx).ready(),
                        "veto must leave the draft owner open"
                    );
                    assert_eq!(editor.read(cx).navigation_key(), Some("chat:a"));
                    view.read(cx).settings.clone().update(cx, |s, _| {
                        assert!(s.state.dirty());
                        s.state.revert();
                    });
                })
                .unwrap();
                if mode == "unknown-quit" {
                    h.update(cx, |_, w, cx| {
                        editor.update(cx, |e, cx| {
                            assert_eq!(
                                e.shell_probe().0.read(cx).value().as_ref(),
                                "",
                                "source-owned shown_text hides pending original"
                            );
                            assert!(e.begin_gui_update_checkpoint(91, w, cx));
                        })
                    })
                    .unwrap();
                    wait_for(cx, &editor, &changed, |s| s.checkpoint == Some(91)).await;
                    h.update(cx, |_, w, cx| {
                        editor.update(cx, |e, cx| {
                            assert_eq!(e.update_receipt(w, cx), Some(91));
                            e.end_update_checkpoint(cx);
                        })
                    })
                    .unwrap();
                }
                if mode.starts_with("held") || mode == "fault" || mode == "external-terminate" {
                    h.update(cx, |_, w, cx| {
                        w.render_frame(cx);
                        w.click("local-send", cx);
                    })
                    .unwrap();
                    server.entered.recv().await.unwrap();
                    let intent = disk(&root).pending.values().next().unwrap().clone();
                    assert_eq!(
                        serde_json::to_value(intent.operation.as_ref().unwrap()).unwrap(),
                        server.seen.lock().unwrap().envelope.clone().unwrap()
                    );
                    *original.lock().unwrap() = Some(intent);
                    h.update(cx, |_, w, cx| {
                        editor.update(cx, |e, cx| {
                            assert!(
                                !e.begin_gui_update_checkpoint(92, w, cx),
                                "in-flight delivery vetoes restart checkpoint"
                            );
                        })
                    })
                    .unwrap();
                }
                if mode == "fault" {
                    let snapshot = root.join("state-v1.json");
                    let backup = root.join("before-fault.json");
                    std::fs::rename(&snapshot, &backup).unwrap();
                    std::fs::create_dir(&snapshot).unwrap();
                    server.seen.lock().unwrap().accept_execute = true;
                    server.release.send(()).await.unwrap();
                    wait_for(cx, &editor, &changed, |s| {
                        s.delivery_reports.values().any(|r| !r.saved)
                    })
                    .await;
                    h.update(cx, |_, w, cx| {
                        editor.update(cx, |e, cx| {
                            let state = e.teardown_probe_state();
                            let report = state.delivery_reports.values().next().unwrap();
                            assert_eq!(
                                report.delivery.diagnostic.unwrap().acknowledgment,
                                crate::delivery_store::diagnostic::Acknowledgment::Accepted
                            );
                            assert!(!e.begin_gui_update_checkpoint(93, w, cx));
                        })
                    })
                    .unwrap();
                    native_quit();
                    wait_for(cx, &editor, &changed, |s| s.notice == "Private writer is fenced after an I/O failure. Keep/copy unsaved text before restart.").await;
                    h.update(cx, |_, _, cx| {
                        assert!(!editor.read(cx).teardown_probe_state().flushed)
                    })
                    .unwrap();
                    // Fixture-only cleanup after the app vetoed. Not an app Close ACK.
                    std::fs::remove_dir(&snapshot).unwrap();
                    std::fs::rename(&backup, &snapshot).unwrap();
                    approved.set(true);
                    cx.update(|cx| cx.quit());
                    return;
                }
                // Ordinary production navigation, two exact IDs with identical titles.
                open("b", cx);
                h.update(cx, |_, w, cx| {
                    editor
                        .read(cx)
                        .shell_probe()
                        .0
                        .update(cx, |t, cx| t.set_value("Separate 🦀 draft", w, cx))
                })
                .unwrap();
                open("a", cx);
                if mode == "answer-quit" || mode == "answer-update-exit" {
                    h.update(cx, |_, w, cx| editor.update(cx, |e, cx| {
                        e.question_context(Some("a"), crate::question::Projection::Pending(Arc::new(question())), true, w, cx);
                    })).unwrap();
                }
                h.update(cx, |_, w, cx| {
                    editor
                        .read(cx)
                        .shell_probe()
                        .0
                        .update(cx, |t, cx| t.set_value(faux::NEWER, w, cx))
                })
                .unwrap();
                if mode.ends_with("update-exit") {
                    h.update(cx, |_, w, cx| view.update(cx, |v, cx| v.probe_begin_update_exit(w, cx))).unwrap();
                    wait_for(cx, &editor, &changed, |s| s.checkpoint == Some(1)).await;
                    while !cx.update(|cx| view.read(cx).settings.read(cx).state.persisted()) {
                        changed.recv().await.unwrap();
                    }
                    h.update(cx, |_, w, cx| view.update(cx, |v, cx| {
                        assert_eq!(v.editor.update(cx, |e, cx| e.update_receipt(w, cx)), Some(v.restart_generation));
                        assert!(v.settings.read(cx).state.persisted());
                        v.settings.read(cx).updater.clone().unwrap().update(cx, |u, _| u.probe_exit_authorized());
                    })).unwrap();
                    approved.set(true);
                    h.update(cx, |_, w, cx| view.update(cx, |v, cx| v.advance_update_restart(w, cx))).unwrap();
                    return;
                }
                if mode == "external-terminate" {
                    // Dirty preferences veto app Quit, but not this external AppKit entry.
                    h.update(cx, |_, _, cx| view.read(cx).settings.clone().update(cx, |s, _| {
                        s.state.set_automatic_update_checks(!s.state.current().automatic_update_checks);
                    })).unwrap();
                    approved.set(true);
                    native_terminate();
                    return;
                }
                // No settling wait/checkpoint: Close must drain the pending debounce.
                approved.set(true);
                if mode.ends_with("close") {
                    native_close(native);
                } else {
                    native_quit();
                }
            })
            .detach();
        });
}

type Id = *mut c_void;
type Sel = *const c_void;
#[link(name = "objc")]
unsafe extern "C" {
    fn objc_getClass(name: *const std::ffi::c_char) -> Id;
    fn sel_registerName(name: *const std::ffi::c_char) -> Sel;
    fn objc_msgSend();
}
unsafe fn object(receiver: Id, selector: &std::ffi::CStr) -> Id {
    let call: unsafe extern "C" fn(Id, Sel) -> Id =
        unsafe { std::mem::transmute(objc_msgSend as unsafe extern "C" fn()) };
    unsafe { call(receiver, sel_registerName(selector.as_ptr())) }
}
fn native_window(w: &Window) -> Id {
    let RawWindowHandle::AppKit(handle) = HasWindowHandle::window_handle(w).unwrap().as_raw()
    else {
        panic!("AppKit only")
    };
    // SAFETY: main thread, live GPUI-owned NSView/NSWindow; no pointer outlives it.
    unsafe { object(handle.ns_view.as_ptr(), c"window") }
}
fn native_close(window: Id) {
    // SAFETY: outside the App borrow so the real AppKit delegate may re-enter GPUI.
    unsafe {
        let visible: unsafe extern "C" fn(Id, Sel) -> bool =
            std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
        assert!(!visible(window, sel_registerName(c"isVisible".as_ptr())));
        let call: unsafe extern "C" fn(Id, Sel, Id) =
            std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
        call(
            window,
            sel_registerName(c"performClose:".as_ptr()),
            std::ptr::null_mut(),
        );
    }
}
fn native_quit() {
    // SAFETY: main-thread NSMenu/GPUI delegate entry, no visible window/activation.
    unsafe {
        let app = object(
            objc_getClass(c"NSApplication".as_ptr()),
            c"sharedApplication",
        );
        let menu = object(app, c"mainMenu");
        let at: unsafe extern "C" fn(Id, Sel, isize) -> Id =
            std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
        let item = at(menu, sel_registerName(c"itemAtIndex:".as_ptr()), 0);
        let submenu = object(item, c"submenu");
        let quit = at(submenu, sel_registerName(c"itemAtIndex:".as_ptr()), 10);
        let call: unsafe extern "C" fn(Id, Sel, Id) =
            std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
        call(
            object(submenu, c"delegate"),
            sel_registerName(c"handleGPUIMenuItem:".as_ptr()),
            quit,
        );
    }
}

fn native_terminate() {
    // SAFETY: main-thread entry on this fixture's own NSApplication, outside App borrow.
    unsafe {
        let app = object(
            objc_getClass(c"NSApplication".as_ptr()),
            c"sharedApplication",
        );
        let call: unsafe extern "C" fn(Id, Sel, Id) =
            std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
        call(
            app,
            sel_registerName(c"terminate:".as_ptr()),
            std::ptr::null_mut(),
        );
    }
}
