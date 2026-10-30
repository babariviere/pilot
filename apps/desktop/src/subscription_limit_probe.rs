//! Actual LocalViewer/composer subscription-limit row against the owned faux
//! model API: Force work / Pause at limit and Continue with another model….
use super::*;
use crate::chat_models_fixture::{Mode, Server};
use gpui_kit::{
    AnyWindowHandle, Bounds, EntityInputHandler, HeadlessAppContext, WindowBounds, WindowOptions,
    component::{ActiveTheme, ThemeMode},
    size,
    test::TestWindowExt,
};
use std::{path::PathBuf, time::Instant};
fn settle(cx: &mut HeadlessAppContext, h: AnyWindowHandle) {
    for _ in 0..3 {
        cx.run_until_parked();
        cx.advance_clock(Duration::from_millis(16));
        cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
    }
}
fn until(cx: &mut HeadlessAppContext, h: AnyWindowHandle, f: impl Fn(&mut App) -> bool) {
    let end = Instant::now() + Duration::from_secs(8);
    while !cx.update(|cx| f(cx)) {
        assert!(
            Instant::now() < end,
            "bounded native subscription publication"
        );
        settle(cx, h);
        std::thread::yield_now();
    }
    settle(cx, h);
}
fn posts(server: &Server, route: &str) -> usize {
    server
        .seen
        .lock()
        .unwrap()
        .requests
        .iter()
        .filter(|(m, p, _)| m == "POST" && p.ends_with(route))
        .count()
}
fn choose(cx: &mut HeadlessAppContext, h: AnyWindowHandle, trigger: &str, id: &str, pointer: bool) {
    cx.update_window(h, |_, w, cx| {
        w.click(SharedString::from(trigger.to_string()), cx)
    })
    .unwrap();
    settle(cx, h);
    cx.update_window(h, |_, w, cx| {
        let option = SharedString::from(format!("model-option-{id}"));
        let row = w.find(option.clone()).bounds();
        let root = w.find("desktop-root").bounds();
        assert!(
            row.left() >= root.left()
                && row.right() <= root.right()
                && row.top() >= root.top()
                && row.bottom() <= root.bottom(),
            "model menu must be contained"
        );
        if pointer {
            w.click(option, cx);
        } else {
            w.input(id, cx);
        }
    })
    .unwrap();
    settle(cx, h);
    if !pointer {
        // The search filter applies on the next frame; then pick its only row.
        cx.update_window(h, |_, w, cx| {
            w.press("down", cx);
            w.press("enter", cx);
        })
        .unwrap();
        settle(cx, h);
    }
}
pub fn run_subscription_limit_probe(cx: &mut HeadlessAppContext) {
    run_paused_status_probe(cx);
    let dir = std::env::var_os("PILOT_NEXT_SUBSCRIPTION_DIR").map(PathBuf::from);
    if let Some(d) = &dir {
        std::fs::create_dir_all(d).unwrap();
    }
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            let server = Server::start(Mode::Paused);
            let (writer, updates) =
                Interaction::start(server.options.clone(), Ok(server.home.join("state")));
            let drain = updates.clone();
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
            let raw = || server.seen.lock().unwrap().session();
            let (h, v) = cx
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
                                let mut v = LocalViewer::build(None, Some(writer.clone()), w, cx);
                                v.page = Page::Chat;
                                v.selected = Some("source".into());
                                v.title = "A held conversation".into();
                                v.generation = 1;
                                v.state.generation = 1;
                                v.state.loaded = true;
                                v.state.list_loaded = true;
                                v.state.projects_loaded = true;
                                let chat = crate::local_model::chat(&raw()).unwrap();
                                v.state.chats = Arc::new(vec![chat.clone()]);
                                v.transcript.update(cx, |t, cx| {
                                    t.replace_readonly(
                                        (1..30)
                                            .map(|id| {
                                                Message::live(
                                                    id,
                                                    "assistant".into(),
                                                    format!("Held work {id}. 日本語 👩‍💻"),
                                                )
                                            })
                                            .collect(),
                                        true,
                                        cx,
                                    )
                                });
                                v.connect_model_controls(server.options.clone(), w, cx);
                                v.editor.update(cx, |e, cx| {
                                    // A held run is "working" without live work: Stop and Steer stay.
                                    e.select("chat:source".into(), true, true, w, cx);
                                    e.model_context(
                                        "source",
                                        "/synthetic/project",
                                        chat.model_configuration.clone().unwrap(),
                                        w,
                                        cx,
                                    );
                                });
                                v.rebuild_nav(w, cx);
                                v.listen_writes(updates, w, cx);
                                v
                            })
                        },
                    )
                })
                .unwrap();
            let editor = cx.update(|cx| v.read(cx).editor.clone());
            let continued = std::rc::Rc::new(std::cell::RefCell::new(None::<String>));
            let record = continued.clone();
            let _continued = cx.update(|cx| {
                cx.subscribe(&editor, move |_, event: &EditorEvent, _| {
                    if let EditorEvent::OpenContinued(chat) = event {
                        *record.borrow_mut() = Some(chat.id.clone());
                    }
                })
            });
            let ready = |cx: &mut App| {
                let e = editor.read(cx);
                e.ready() && e.model_probe_state().0
            };
            until(cx, h, ready);
            let text = cx.update(|cx| editor.read(cx).shell_probe().0);
            cx.update_window(h, |_, w, cx| {
                let tray = w.find("composer-tray").bounds();
                assert_eq!(tray.size.height, px(76.));
                assert_eq!(w.find("composer-input").bounds().size.height, px(34.));
                let row = w.find("subscription-limit").bounds();
                let root = w.find("desktop-root").bounds();
                assert!(row.bottom() <= tray.top(), "recovery sits above the tray");
                for id in ["subscription-force", "subscription-continue"] {
                    let b = w.find(id).bounds();
                    assert!(
                        b.left() >= root.left()
                            && b.right() <= root.right()
                            && b.top() >= row.top()
                            && b.bottom() <= row.bottom(),
                        "{id} stays in its row"
                    );
                    assert_ne!(w.find(id).disabled(), Some(true), "{id}");
                }
                assert_eq!(w.find("subscription-force").label(), Some("Force work"));
                // The held chat is explained once, by the row, not a restriction caption.
                assert!(w.try_find("chat-model-restriction").is_none());
                assert!(w.try_find("subscription-continuation").is_none());
                assert!(w.find("local-stop").bounds().size.width > px(0.));
                text.update(cx, |t, cx| t.focus(w, cx));
                w.input("Draft kept through recovery 日本語 👩‍💻", cx);
                w.press("secondary-a", cx);
            })
            .unwrap();
            settle(cx, h);
            let selection = cx.update(|cx| text.read(cx).selected_range());
            let draft = "Draft kept through recovery 日本語 👩‍💻";
            if let Some(d) = &dir {
                cx.update(|cx| assert_eq!(cx.theme().is_dark(), mode == ThemeMode::Dark));
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(d.join(format!("{}-{}-paused.png", width as u32, mode.name())))
                    .unwrap();
            }
            // Continue with another model…: nothing is posted until confirmed.
            cx.update_window(h, |_, w, cx| w.click("subscription-continue", cx))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, _| {
                assert_eq!(
                    w.find("subscription-continue-confirm").disabled(),
                    Some(true)
                );
                assert_eq!(w.find("subscription-continue").disabled(), Some(true));
                let row = w.find("subscription-limit").bounds();
                let panel = w.find("subscription-continuation").bounds();
                assert!(panel.top() >= row.top() && panel.bottom() <= row.bottom());
                assert!(panel.bottom() <= w.find("composer-tray").bounds().top());
            })
            .unwrap();
            choose(
                cx,
                h,
                "subscription-continue-model",
                "p/b",
                mode == ThemeMode::Light,
            );
            cx.update(|cx| {
                assert_eq!(
                    editor.read(cx).subscription_probe().0,
                    Some(Some("p/b".into()))
                )
            });
            cx.update_window(h, |_, w, cx| {
                assert_eq!(
                    w.find("subscription-continue-confirm").label(),
                    Some("Switch model")
                );
                assert_ne!(
                    w.find("subscription-continue-confirm").disabled(),
                    Some(true)
                );
                // Marked text guards the confirmation: no POST while composing.
                text.update(cx, |t, cx| {
                    t.focus(w, cx);
                    t.replace_and_mark_text_in_range(None, "にほん", Some(3..3), w, cx);
                });
                w.click("subscription-continue-confirm", cx);
                assert!(text.update(cx, |t, cx| t.marked_text_range(w, cx).is_some()));
                text.update(cx, |t, cx| {
                    t.replace_text_in_range(None, "", w, cx);
                    t.unmark_text(w, cx);
                });
            })
            .unwrap();
            settle(cx, h);
            assert_eq!(server.posts(), 0);
            if let Some(d) = &dir {
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(d.join(format!(
                        "{}-{}-continue-same.png",
                        width as u32,
                        mode.name()
                    )))
                    .unwrap();
            }
            cx.update_window(h, |_, w, cx| {
                text.update(cx, |t, cx| t.set_value(draft, w, cx));
                w.click("subscription-continue-confirm", cx);
            })
            .unwrap();
            until(cx, h, |cx| {
                let (open, _, busy) = editor.read(cx).subscription_probe();
                !busy && open.is_none()
            });
            assert_eq!(posts(&server, "/continue-model"), 1);
            cx.update(|cx| {
                let e = editor.read(cx);
                assert_eq!(e.model_probe_state().2.unwrap().model, "p/b");
                assert_eq!(text.read(cx).value().as_ref(), draft);
                assert!(!e.model_probe_state().3, "acknowledged, nothing retained");
            });
            // Force work, then Pause at limit: one POST each, no continuation offered while forced.
            cx.update_window(h, |_, w, cx| w.click("subscription-force", cx))
                .unwrap();
            until(cx, h, |cx| {
                editor.read(cx).subscription_probe().1 == Some(true)
            });
            cx.update_window(h, |_, w, _| {
                assert_eq!(w.find("subscription-force").label(), Some("Pause at limit"));
                assert!(w.try_find("subscription-continue").is_none());
            })
            .unwrap();
            if let Some(d) = &dir {
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(d.join(format!("{}-{}-forced.png", width as u32, mode.name())))
                    .unwrap();
            }
            cx.update_window(h, |_, w, cx| w.click("subscription-force", cx))
                .unwrap();
            until(cx, h, |cx| {
                editor.read(cx).subscription_probe().1 == Some(false)
            });
            assert_eq!(posts(&server, "/subscription-force"), 2);
            // Another provider through the model chip: confirmed, then the new chat opens.
            until(cx, h, ready);
            choose(cx, h, "chat-model", "q/c", mode == ThemeMode::Dark);
            cx.update(|cx| {
                let e = editor.read(cx);
                assert_eq!(e.subscription_probe().0, Some(Some("q/c".into())));
                assert_eq!(
                    e.model_probe_state().2.unwrap().model,
                    "p/b",
                    "chip keeps the actual model"
                );
            });
            cx.update_window(h, |_, w, _| {
                assert_eq!(
                    w.find("subscription-continue-confirm").label(),
                    Some("Start new chat")
                );
                assert!(
                    w.find("subscription-continue-explanation")
                        .bounds()
                        .size
                        .height
                        > px(0.)
                );
            })
            .unwrap();
            if let Some(d) = &dir {
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(d.join(format!("{}-{}-continue-new.png", width as u32, mode.name())))
                    .unwrap();
            }
            // Cancel keeps everything and returns focus to the draft.
            cx.update_window(h, |_, w, cx| w.click("subscription-continue-cancel", cx))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(w.try_find("subscription-continuation").is_none());
                assert!(gpui_kit::Focusable::focus_handle(text.read(cx), cx).is_focused(w));
            })
            .unwrap();
            assert_eq!(server.posts(), 3);
            choose(cx, h, "chat-model", "q/c", true);
            cx.update_window(h, |_, w, cx| w.click("subscription-continue-confirm", cx))
                .unwrap();
            until(cx, h, |_| continued.borrow().is_some());
            assert_eq!(continued.borrow().as_deref(), Some("next"));
            assert_eq!(posts(&server, "/continue-model"), 2);
            assert_eq!(server.posts(), 4);
            cx.update(|cx| {
                // This captured viewer has no Local client, so the open is refused,
                // proving the replacement reached navigation without a silent switch.
                assert_eq!(
                    v.read(cx).nav_error,
                    Some("This captured view cannot open another chat.")
                );
                assert!(selection.end > selection.start);
                assert_eq!(text.read(cx).value().as_ref(), draft);
                assert!(editor.read(cx).subscription_probe().0.is_none());
            });
            cx.update(|cx| editor.read(cx).disconnect_model_fixture());
            until(cx, h, |cx| editor.read(cx).model_probe_state().4);
            cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
            assert!(writer.command(crate::interaction::WriteCommand::Close));
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap()
                .block_on(async {
                    tokio::time::timeout(Duration::from_secs(3), async {
                        let mut flushed = false;
                        while let Ok(s) = drain.recv().await {
                            flushed |= s.flushed;
                        }
                        assert!(flushed, "owned writer flushes before fixture removal");
                    })
                    .await
                    .unwrap();
                });
            drop(writer);
            let reopened = crate::delivery_store::Store::open(
                server.home.join("state"),
                server.options.host(),
            )
            .unwrap();
            // The draft survives every recovery action; nothing was sent or discarded.
            assert_eq!(reopened.book.drafts["chat:source"].text, draft);
            assert!(reopened.book.model_changes.is_empty());
            assert!(reopened.book.pending.is_empty());
            drop(reopened);
            println!(
                "{}",
                serde_json::json!({"probe":"subscription-limit","width":width,"mode":mode.name(),"tray":76,"input":34,"continue_same":true,"continue_new":true,"force_toggle":true,"preedit_guard":true,"posts":server.posts()})
            );
        }
    }
}

/// Production sidebar, Inbox and header. No transport or user profile.
fn run_paused_status_probe(cx: &mut HeadlessAppContext) {
    use serde_json::json;
    let captures = std::env::var_os("PILOT_NEXT_PAUSED_DIR").map(PathBuf::from);
    if let Some(dir) = &captures {
        std::fs::create_dir_all(dir).unwrap();
    }
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            cx.update(|cx| gpui_kit::component::Theme::change(mode, None, cx));
            let (h, view) = cx.update(|cx| {
                gpui_kit::open_window(
                    WindowOptions {
                        window_bounds: Some(WindowBounds::Windowed(Bounds::new(Default::default(), size(px(width), px(760.))))),
                        show: false, focus: false, ..Default::default()
                    },
                    cx,
                    |w, cx| cx.new(|cx| {
                        let mut v = LocalViewer::preview(PreviewState::Conversation, w, cx);
                        let values = [
                            json!({"id":"coord","title":"Coordinator","state":"idle","missionId":"m","missionCoordinator":true,"createdAt":1}),
                            json!({"id":"held","title":"Held work 日本語 👩‍💻","state":"working","working":false,"missionId":"m","subscriptionPause":{"windows":[]},"createdAt":2}),
                            json!({"id":"done","title":"Finished","state":"idle","missionId":"m","createdAt":3}),
                            json!({"id":"solo","title":"A paused standalone conversation","state":"idle","subscriptionPause":{"windows":[]},"createdAt":4}),
                        ];
                        v.state.chats = Arc::new(values.iter().map(|v| crate::local_model::chat(v).unwrap()).collect());
                        v.state.mission_titles = Some(Arc::new([("m".into(),"Synthetic work".into())].into_iter().collect()));
                        v.chats.update(cx, |l, _| l.delegate_mut().memory = crate::sidebar_memory::Memory::ephemeral(0.));
                        v.selected = Some("solo".into());
                        v.title = "A paused standalone conversation".into();
                        v.editor.update(cx, |e,cx|e.select("chat:solo".into(),true,false,w,cx));
                        v.rebuild_nav(w,cx);
                        v
                    }),
                ).unwrap()
            });
            settle(cx, h);
            if let Some(dir) = &captures {
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(dir.join(format!("{}-{}-sidebar.png", width as u32, mode.name())))
                    .unwrap();
            }
            cx.update_window(h, |_, w, cx| {
                let header = w.find("chat-paused-status");
                assert_eq!(header.label(), Some("Paused, Usage limit reached"));
                assert!(header.visible());
                assert!(header.bounds().right() <= w.find("chat-header").bounds().right());
                for id in ["held", "solo"] {
                    let label = w
                        .find(SharedString::from(id.to_owned()))
                        .label()
                        .unwrap()
                        .to_owned();
                    assert!(
                        label.contains("Paused") && label.contains("Usage limit reached"),
                        "{label}"
                    );
                    let row = w.within(SharedString::from(format!("chat-row-{id}")));
                    assert!(row.find("state-paused").visible());
                }
                assert!(
                    w.within("chat-row-held")
                        .find("sidebar-state-word")
                        .visible()
                );
                let tree = &view.read(cx).chats.read(cx).delegate().tree;
                assert_eq!(tree.threads[0].finished, 1);
                assert_eq!(tree.threads[0].rollup.words(), "1 paused");
                view.update(cx, |v, cx| {
                    v.chats.update(cx, |l, cx| {
                        let index = l.delegate().index("coord").unwrap();
                        l.set_selected_index(Some(index), w, cx);
                        l.focus(w, cx);
                    });
                });
                w.press("left", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(w.try_find("chat-row-held").is_none());
                assert!(w.find("coord").label().unwrap().contains("1 paused"));
                assert!(w.find("mission-rollup-Paused").visible());
                w.press("right", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(w.find("chat-row-held").visible());
                view.update(cx, |v, cx| v.show_inbox(None, w, cx));
            })
            .unwrap();
            settle(cx, h);
            if let Some(dir) = &captures {
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(dir.join(format!("{}-{}-inbox.png", width as u32, mode.name())))
                    .unwrap();
            }
            cx.update_window(h, |_,w,cx| {
                let header = w.find("inbox-section-2").bounds();
                for id in ["held","solo"] {
                    let row = w.find(SharedString::from(format!("inbox-{id}")));
                    assert!(row.visible());
                    assert!(header.bottom() <= row.bounds().top(), "Paused heading must reserve its height even with empty Needs you/Ready sections");
                    assert!(row.label().unwrap().contains("Paused · Usage limit reached"));
                    assert!(w.within(SharedString::from(format!("attention-{id}"))).find("state-paused").visible());
                }
                // Policy release replaces the summary, it never triggers a client-side resume.
                view.update(cx, |v,cx| {
                    let raw=json!({"id":"solo","title":"A paused standalone conversation","state":"idle","subscriptionPause":null});
                    let mut chats=(*v.state.chats).clone();
                    *chats.iter_mut().find(|c|c.id=="solo").unwrap()=crate::local_model::chat(&raw).unwrap();
                    v.state.chats=Arc::new(chats);
                    v.rebuild_nav(w,cx);
                });
            }).unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, _| {
                assert!(w.try_find("inbox-solo").is_none());
                assert!(w.find("inbox-held").visible());
                w.remove_window();
            })
            .unwrap();
        }
    }
}
