//! Real hidden LocalViewer and private draft worker. No user data or daemon writes.
use super::*;
use crate::delivery_store::{Draft, Store};
use gpui_kit::{
    Bounds, HeadlessAppContext, MouseButton, WindowBounds, WindowOptions, size,
    test::{TestEventExt, TestWindowExt},
};

fn settle(cx: &mut HeadlessAppContext, h: gpui_kit::AnyWindowHandle) {
    cx.run_until_parked();
    cx.advance_clock(Duration::from_millis(16));
    cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
}
#[track_caller]
fn until(
    cx: &mut HeadlessAppContext,
    h: gpui_kit::AnyWindowHandle,
    check: impl Fn(&mut Window, &mut App) -> bool,
) {
    let deadline = std::time::Instant::now() + Duration::from_secs(8);
    while !cx.update_window(h, |_, w, cx| check(w, cx)).unwrap() {
        assert!(
            std::time::Instant::now() < deadline,
            "draft discard did not settle at {}",
            std::panic::Location::caller()
        );
        settle(cx, h);
        std::thread::yield_now();
    }
    settle(cx, h);
}
fn menu(cx: &mut HeadlessAppContext, h: gpui_kit::AnyWindowHandle, key: &str, keyboard: bool) {
    let id = SharedString::from(format!("chat-menu-{key}"));
    cx.update_window(h, |_, w, cx| {
        w.hover(SharedString::from(format!("chat-row-{key}")), cx);
    })
    .unwrap();
    settle(cx, h);
    cx.update_window(h, |_, w, cx| {
        assert_ne!(w.find(id.clone()).disabled(), Some(true));
        if keyboard {
            for _ in 0..40 {
                if w.find(id.clone()).focused() == Some(true) {
                    break;
                }
                w.press("tab", cx);
            }
            assert_eq!(
                w.find(id.clone()).focused(),
                Some(true),
                "draft menu keyboard reachable"
            );
            w.press("space", cx);
        } else {
            w.click(id.clone(), cx);
        }
    })
    .unwrap();
    settle(cx, h);
    cx.update_window(h, |_, w, cx| {
        assert!(
            w.within("popup-menu")
                .try_find_by_label("Archive")
                .is_none(),
            "draft actions never expose server archive"
        );
        let item = w
            .within("popup-menu")
            .try_find_by_label("Discard draft…")
            .unwrap_or_else(|| w.within("popup-menu").find_by_label("Discard draft"));
        assert_ne!(item.disabled(), Some(true));
        if keyboard {
            w.press("down", cx);
            w.press("enter", cx);
        } else {
            let pos = item.bounds().center();
            w.pointer_down(pos, MouseButton::Left, cx);
            w.pointer_up(pos, MouseButton::Left, cx);
        }
    })
    .unwrap();
    settle(cx, h);
}

pub(super) fn run(cx: &mut HeadlessAppContext) {
    let reduced_motion = cx.update(|cx| cx.reduce_motion());
    for width in [680., 1100.] {
        for dark in [false, true] {
            cx.update(|cx| {
                crate::appearance::commit_appearance(
                    if dark {
                        crate::settings_state::AppearancePreference::Dark
                    } else {
                        crate::settings_state::AppearancePreference::Light
                    },
                    cx,
                );
                cx.set_reduce_motion(true);
            });
            let server =
                crate::chat_models_fixture::Server::start(crate::chat_models_fixture::Mode::Accept);
            let root =
                std::env::temp_dir().join(format!("native-draft-discard-{}", uuid::Uuid::new_v4()));
            {
                let mut store = Store::open(root.clone(), server.options.host()).unwrap();
                store
                    .save_edits(std::collections::BTreeMap::from([
                        (
                            "new:empty".into(),
                            Draft {
                                revision: 1,
                                ..Default::default()
                            },
                        ),
                        (
                            "new:populated".into(),
                            Draft {
                                revision: 2,
                                text: "Retain 日本語 👩‍💻 until confirmed".into(),
                                ..Default::default()
                            },
                        ),
                        (
                            "new:other".into(),
                            Draft {
                                revision: 1,
                                text: "Keep other draft".into(),
                                ..Default::default()
                            },
                        ),
                        (
                            "new:recovered".into(),
                            Draft {
                                revision: 1,
                                recovered: Arc::new(vec!["Recovered 日本語 content".into()]),
                                ..Default::default()
                            },
                        ),
                        (
                            "chat:synthetic".into(),
                            Draft {
                                revision: 1,
                                text: "Keep chat composer".into(),
                                ..Default::default()
                            },
                        ),
                    ]))
                    .unwrap();
            }
            let (writer, updates) = Interaction::start(server.options.clone(), Ok(root.clone()));
            let drain = updates.clone();
            let (client, reads) = LocalClient::synthetic_commands();
            let (h, view) = cx
                .update(|cx| {
                    gpui_kit::open_window(
                        WindowOptions {
                            window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                                Default::default(),
                                size(px(width), px(760.)),
                            ))),
                            show: false,
                            focus: false,
                            ..Default::default()
                        },
                        cx,
                        |w, cx| {
                            cx.new(|cx| {
                                let mut v =
                                    LocalViewer::build(Some(client), Some(writer.clone()), w, cx);
                                v.state.status = "Synthetic Local".into();
                                v.state.loaded = true;
                                v.state.list_loaded = true;
                                v.listen_writes(updates, w, cx);
                                v
                            })
                        },
                    )
                })
                .unwrap();
            until(cx, h, |_, cx| view.read(cx).editor.read(cx).ready());
            cx.update_window(h, |_, w, _| w.activate_window()).unwrap();
            let editor = cx.update(|cx| view.read(cx).editor.clone());
            cx.update_window(h, |_, w, cx| {
                view.update(cx, |v, cx| {
                    let row = v
                        .chats
                        .read(cx)
                        .delegate()
                        .all
                        .iter()
                        .find(|c| c.id == "new:empty")
                        .unwrap()
                        .clone();
                    assert!(v.open(row, w, cx));
                });
            })
            .unwrap();
            settle(cx, h);
            menu(cx, h, "new:empty", false);
            until(cx, h, |w, cx| {
                !editor.read(cx).has_navigation_draft("new:empty") && w.try_find("dialog").is_none()
            });
            cx.update_window(h, |_, w, cx| {
                assert!(view.read(cx).page == Page::Home);
                let list = view.read(cx).chats.clone();
                assert!(gpui_kit::Focusable::focus_handle(list.read(cx), cx).is_focused(w));
                view.update(cx, |v, cx| {
                    let row = v
                        .chats
                        .read(cx)
                        .delegate()
                        .all
                        .iter()
                        .find(|c| c.id == "new:populated")
                        .unwrap()
                        .clone();
                    assert!(v.open(row, w, cx));
                });
                editor.update(cx, |e, cx| e.focus(w, cx));
                w.input(" + unsaved", cx);
            })
            .unwrap();
            settle(cx, h);
            let retained = cx.update(|cx| editor.read(cx).shell_probe().0.read(cx).value());
            menu(cx, h, "new:populated", dark);
            until(cx, h, |w, _| w.try_find("draft-discard-cancel").is_some());
            if let Some(dir) = std::env::var_os("PILOT_NEXT_DRAFT_DISCARD_DIR") {
                std::fs::create_dir_all(&dir).unwrap();
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(std::path::PathBuf::from(dir).join(format!("{width}-{dark}-confirm.png")))
                    .unwrap();
            }
            cx.update_window(h, |_, w, cx| w.click("draft-discard-cancel", cx))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(w.try_find("dialog").is_none());
                assert!(editor.read(cx).has_navigation_draft("new:populated"));
                assert_eq!(editor.read(cx).shell_probe().0.read(cx).value(), retained);
                assert!(
                    gpui_kit::Focusable::focus_handle(view.read(cx).chats.read(cx), cx)
                        .is_focused(w),
                    "Cancel restores sidebar list focus"
                );
            })
            .unwrap();
            menu(cx, h, "new:populated", false);
            until(cx, h, |w, _| w.try_find("draft-discard-confirm").is_some());
            cx.update_window(h, |_, w, cx| w.press("enter", cx))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(
                    w.try_find("draft-discard-confirm").is_some(),
                    "ordinary Enter keeps the confirmation open"
                );
                assert!(editor.read(cx).has_navigation_draft("new:populated"));
            })
            .unwrap();
            cx.update_window(h, |_, w, cx| w.press("escape", cx))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(w.try_find("dialog").is_none());
                assert!(editor.read(cx).has_navigation_draft("new:populated"));
            })
            .unwrap();
            menu(cx, h, "new:populated", true);
            until(cx, h, |w, _| w.try_find("draft-discard-confirm").is_some());
            cx.update_window(h, |_, w, cx| w.click("draft-discard-confirm", cx))
                .unwrap();
            until(cx, h, |_, cx| {
                !editor.read(cx).has_navigation_draft("new:populated")
            });
            cx.update_window(h, |_, w, cx| {
                assert!(view.read(cx).page == Page::Home);
                assert!(editor.read(cx).has_navigation_draft("new:other"));
                assert!(
                    gpui_kit::Focusable::focus_handle(view.read(cx).chats.read(cx), cx)
                        .is_focused(w)
                );
                view.update(cx, |v, cx| {
                    let row = v
                        .chats
                        .read(cx)
                        .delegate()
                        .all
                        .iter()
                        .find(|c| c.id == "new:other")
                        .unwrap()
                        .clone();
                    assert!(v.open(row, w, cx));
                });
            })
            .unwrap();
            settle(cx, h);
            // A recovered-only background draft also needs confirmation. A newer
            // mailbox revision must refuse deletion without poisoning the open draft.
            menu(cx, h, "new:recovered", false);
            until(cx, h, |w, _| w.try_find("draft-discard-confirm").is_some());
            cx.update_window(h, |_, w, cx| {
                assert_eq!(editor.read(cx).navigation_key(), Some("new:other"));
                assert!(writer.edit(
                    "new:recovered".into(),
                    Draft {
                        revision: 2,
                        text: "Newer recovered draft".into(),
                        ..Default::default()
                    }
                ));
                w.click("draft-discard-confirm", cx);
            })
            .unwrap();
            until(cx, h, |_, cx| view.read(cx).nav_error.is_some());
            cx.update_window(h, |_, w, cx| {
                assert!(w.try_find("dialog").is_none());
                assert!(
                    editor.read(cx).resource_navigation_issue().is_none(),
                    "background discard error must not block this composer"
                );
                assert_eq!(editor.read(cx).navigation_key(), Some("new:other"));
                assert_eq!(
                    editor.read(cx).shell_probe().0.read(cx).value().as_ref(),
                    "Keep other draft"
                );
                assert!(editor.read(cx).has_navigation_draft("new:recovered"));
            })
            .unwrap();
            menu(cx, h, "new:recovered", false);
            until(cx, h, |w, _| w.try_find("draft-discard-confirm").is_some());
            cx.update_window(h, |_, w, cx| {
                for _ in 0..6 {
                    if w.find("draft-discard-confirm").focused() == Some(true) {
                        break;
                    }
                    w.press("tab", cx);
                }
                assert_eq!(w.find("draft-discard-confirm").focused(), Some(true));
                w.press("enter", cx);
            })
            .unwrap();
            until(cx, h, |_, cx| {
                !editor.read(cx).has_navigation_draft("new:recovered")
            });
            cx.update_window(h, |_, _, cx| {
                assert_eq!(editor.read(cx).navigation_key(), Some("new:other"));
                assert_eq!(
                    editor.read(cx).shell_probe().0.read(cx).value().as_ref(),
                    "Keep other draft"
                );
                assert!(view.read(cx).page == Page::Chat);
            })
            .unwrap();
            // Leaving an untouched new chat removes it; New chat on it reuses, not prunes.
            let shown = |cx: &mut HeadlessAppContext| {
                cx.update(|cx| editor.read(cx).navigation_key().unwrap().to_owned())
            };
            let gone = |key: String| {
                let editor = editor.clone();
                move |_: &mut Window, cx: &mut App| {
                    let e = editor.read(cx);
                    !e.has_navigation_draft(&key)
                        && e.draft_discard_blocked(&key) != Some("Discarding…")
                }
            };
            let new_chat = |cx: &mut HeadlessAppContext| {
                cx.update_window(h, |_, w, cx| view.update(cx, |v, cx| v.new_chat(w, cx)))
                    .unwrap();
                settle(cx, h);
            };
            new_chat(cx);
            let untouched = shown(cx);
            new_chat(cx);
            assert_eq!(
                shown(cx),
                untouched,
                "the slot in use is reused, never pruned"
            );
            cx.update_window(h, |_, w, cx| view.update(cx, |v, cx| v.show_home(w, cx)))
                .unwrap();
            until(cx, h, gone(untouched.clone()));
            cx.update(|cx| {
                assert!(view.read(cx).page == Page::Home);
                assert!(view.read(cx).nav_error.is_none());
                assert!(editor.read(cx).has_navigation_draft("new:other"));
            });
            // Typing then clearing, then switching to another draft, still removes it.
            new_chat(cx);
            let cleared = shown(cx);
            assert_ne!(cleared, untouched);
            cx.update_window(h, |_, w, cx| {
                editor.update(cx, |e, cx| e.focus(w, cx));
                w.input("Typed then cleared", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                let text = editor.read(cx).shell_probe().0;
                text.update(cx, |t, cx| t.set_value("", w, cx));
                view.update(cx, |v, cx| {
                    let row = v
                        .chats
                        .read(cx)
                        .delegate()
                        .all
                        .iter()
                        .find(|c| c.id == "new:other")
                        .unwrap()
                        .clone();
                    assert!(v.open(row, w, cx));
                });
            })
            .unwrap();
            until(cx, h, gone(cleared.clone()));
            assert_eq!(shown(cx), "new:other");
            // Text typed into a new chat survives leaving it.
            new_chat(cx);
            let kept = shown(cx);
            cx.update_window(h, |_, w, cx| {
                editor.update(cx, |e, cx| e.focus(w, cx));
                w.input("Keep me 日本語", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| view.update(cx, |v, cx| v.show_home(w, cx)))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(view.read(cx).page == Page::Home);
                assert!(editor.read(cx).has_navigation_draft(&kept));
                assert!(view.read(cx).nav_error.is_none());
                w.remove_window();
            })
            .unwrap();
            cx.run_until_parked();
            drop(view);
            drop(editor);
            assert!(writer.command(WriteCommand::Close));
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap()
                .block_on(async {
                    tokio::time::timeout(Duration::from_secs(3), async {
                        let mut flushed = false;
                        while let Ok(update) = drain.recv().await {
                            flushed |= update.flushed;
                        }
                        assert!(flushed);
                    })
                    .await
                    .unwrap();
                });
            let store = Store::open(root.clone(), server.options.host()).unwrap();
            assert!(!store.book.drafts.contains_key("new:empty"));
            assert!(!store.book.drafts.contains_key("new:populated"));
            assert!(!store.book.drafts.contains_key("new:recovered"));
            assert_eq!(store.book.drafts["new:other"].text, "Keep other draft");
            assert!(!store.book.drafts.contains_key(&untouched));
            assert!(!store.book.drafts.contains_key(&cleared));
            assert_eq!(store.book.drafts[&kept].text, "Keep me 日本語");
            assert_eq!(
                store.book.drafts["chat:synthetic"].text,
                "Keep chat composer"
            );
            assert_eq!(server.posts(), 0);
            while let Ok(read) = reads.try_recv() {
                assert!(
                    matches!(read, Command::Clear { .. }),
                    "discard never sends a session command"
                );
            }
            drop(store);
            drop(writer);
            std::fs::remove_dir_all(root).unwrap();
            println!(
                "draft_discard {width} dark={dark}: empty, Cancel/Escape, keyboard confirm, focus, durable removal/relaunch, other drafts retained, empty slots removed on leave (Home/draft switch, cleared text), typed kept; zero HTTP writes"
            );
        }
    }
    cx.update(|cx| cx.set_reduce_motion(reduced_motion));
}
