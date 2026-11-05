//! Hidden native retired Ask chats: passive history, no work-starting controls, explicit
//! Stop, and unchanged Build and restricted Ask routing. Every read/write is injected.
use super::*;
use gpui_kit::{
    Bounds, EntityInputHandler, HeadlessAppContext, WindowBounds, WindowOptions,
    component::{ActiveTheme, Theme, ThemeMode},
    size,
    test::TestWindowExt,
};
use serde_json::json;
fn settle(cx: &mut HeadlessAppContext, h: gpui_kit::AnyWindowHandle) {
    for _ in 0..16 {
        cx.run_until_parked();
        cx.advance_clock(Duration::from_millis(16));
        cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
    }
}
fn inventory() -> Vec<Chat> {
    [
        json!({"id":"synthetic","title":"Build conversation","state":"idle","mode":"build","projectId":"p","cwd":"/synthetic/p"}),
        json!({"id":"ask-idle","title":"Earlier question 日本語 👩‍💻","state":"idle","mode":"ask","projectId":"p","cwd":"/synthetic/p","outcome":"question"}),
        json!({"id":"ask-working","title":"Running Ask","state":"working","working":true,"mode":"ask","projectId":"p","cwd":"/synthetic/p","pending":[{"id":1}]}),
        json!({"id":"explorer","title":"Mission explorer","state":"idle","mode":"ask","projectId":"p","cwd":"/synthetic/p","missionId":"m","missionRole":"explorer"}),
    ]
    .iter()
    .map(|v| crate::local_model::chat(v).unwrap())
    .collect()
}
fn history() -> Vec<Message> {
    vec![
        Message::live(7, "user".into(), "質問 👩‍💻 e\u{301} exact".into()),
        Message::live(8, "assistant".into(), "Retained answer ﷽ 🏳️‍🌈".into()),
    ]
}
fn open(
    cx: &mut HeadlessAppContext,
    h: gpui_kit::AnyWindowHandle,
    v: &Entity<LocalViewer>,
    id: &str,
) {
    cx.update_window(h, |_, w, cx| {
        v.update(cx, |v, cx| {
            let chat = v.state.chats.iter().find(|c| c.id == id).unwrap().clone();
            assert!(v.open(chat, w, cx));
        })
    })
    .unwrap();
    settle(cx, h);
}
/// The client's page for the newly opened generation.
fn loaded(
    cx: &mut HeadlessAppContext,
    h: gpui_kit::AnyWindowHandle,
    v: &Entity<LocalViewer>,
    passive: bool,
) {
    cx.update_window(h, |_, w, cx| {
        v.update(cx, |v, cx| {
            let mut state = v.state.clone();
            state.generation = v.generation;
            state.loaded = true;
            state.passive_history = passive;
            state.rows = history();
            state.cursor = Some(7);
            v.accept(state, w, cx);
        })
    })
    .unwrap();
    settle(cx, h);
}
fn shot(
    cx: &mut HeadlessAppContext,
    h: gpui_kit::AnyWindowHandle,
    dir: &Option<std::path::PathBuf>,
    width: f32,
    dark: bool,
    name: &str,
) {
    if let Some(d) = dir {
        cx.capture_screenshot(h)
            .unwrap()
            .save(d.join(format!(
                "legacy-ask-{}-{}-{name}.png",
                width as u32,
                if dark { "dark" } else { "light" }
            )))
            .unwrap();
    }
}
pub fn run_legacy_ask_probe(cx: &mut HeadlessAppContext) {
    // Shares the archive target's existing capture directory.
    let dir = std::env::var_os("PILOT_NEXT_ARCHIVE_DIR").map(std::path::PathBuf::from);
    if let Some(d) = &dir {
        std::fs::create_dir_all(d).unwrap();
    }
    for width in [680., 1100.] {
        for dark in [false, true] {
            let (client, commands) = LocalClient::synthetic_commands();
            let (writer, writes) = Interaction::recording();
            let (h, v) = cx
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
                                w.activate_window();
                                let mut v = LocalViewer::preview(PreviewState::Conversation, w, cx);
                                v.client = Some(client);
                                v.editor.update(cx, |e, cx| e.shell_probe_setup(writer, w, cx));
                                v.state.chats = Arc::new(inventory());
                                v.state.projects = Arc::new(
                                    crate::local_model::projects(
                                        &json!([{"id":"p","name":"Pilot research","path":"/synthetic/p"}]),
                                    )
                                    .unwrap(),
                                );
                                v.state.projects_loaded = true;
                                v.state.summary_fresh = true;
                                v.state.list_loaded = true;
                                v.state.loaded = true;
                                v.rebuild_nav(w, cx);
                                v
                            })
                        },
                    )
                })
                .unwrap();
            cx.update(|cx| {
                Theme::change(
                    if dark {
                        ThemeMode::Dark
                    } else {
                        ThemeMode::Light
                    },
                    None,
                    cx,
                )
            });
            settle(cx, h);
            cx.update(|cx| assert_eq!(cx.theme().is_dark(), dark));
            let (editor, input) = cx.update(|cx| {
                let e = v.read(cx).editor.clone();
                (e.clone(), e.read(cx).shell_probe().0)
            });
            // A Build draft with IME composition survives the round trip.
            cx.update_window(h, |_, w, cx| {
                input.update(cx, |i, cx| {
                    i.focus(w, cx);
                    i.replace_text_in_range(None, "Build draft 👩‍💻 e\u{301}", w, cx);
                    i.replace_and_mark_text_in_range(None, "に", Some(1..1), w, cx);
                    i.unmark_text(w, cx);
                });
            })
            .unwrap();
            settle(cx, h);
            let draft = cx.update(|cx| input.read(cx).value().to_string());

            // Ordinary Ask opens passive stored history, never the live chat stream.
            open(cx, h, &v, "ask-idle");
            assert!(
                matches!(commands.try_recv(), Ok(Command::OpenArchive { id, .. }) if id == "ask-idle")
            );
            assert!(commands.is_empty());
            loaded(cx, h, &v, true);
            cx.update_window(h, |_, w, cx| {
                assert!(
                    w.try_find("archived-composer").is_none(),
                    "not archived: the read-only composer stays"
                );
                assert_eq!(w.find("local-send").disabled(), Some(true));
                assert!(
                    w.try_find("local-stop").is_none(),
                    "Stop only while working"
                );
                // Keyboard, pointer and a stale fixed send cannot dispatch.
                input.update(cx, |i, cx| i.focus(w, cx));
                w.press("enter", cx);
                w.press("alt-enter", cx);
                w.click("local-send", cx);
                editor.update(cx, |e, cx| {
                    assert!(e.fixed_send_problem("chat:ask-idle", cx).is_some());
                    assert!(!e.send_fixed("chat:ask-idle", "Continue", w, cx));
                });
                let rows: Vec<String> = v
                    .read(cx)
                    .transcript
                    .read(cx)
                    .rows()
                    .iter()
                    .map(|r| r.source().to_string())
                    .collect();
                assert_eq!(rows, ["質問 👩‍💻 e\u{301} exact", "Retained answer ﷽ 🏳️‍🌈"]);
                w.press("secondary-f", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(
                    w.try_find("transcript-find").is_some(),
                    "read-only Ask history keeps Find"
                );
                w.press("escape", cx);
            })
            .unwrap();
            settle(cx, h);
            assert!(writes.is_empty(), "no send, reply or queue write");
            shot(cx, h, &dir, width, dark, "idle");

            // Already active Ask work keeps explicit Stop, separately from Send.
            open(cx, h, &v, "ask-working");
            assert!(
                matches!(commands.try_recv(), Ok(Command::OpenArchive { id, .. }) if id == "ask-working")
            );
            loaded(cx, h, &v, true);
            cx.update_window(h, |_, w, cx| {
                assert_eq!(w.find("local-send").disabled(), Some(true));
                assert_ne!(w.find("local-stop").disabled(), Some(true));
                w.press("enter", cx);
            })
            .unwrap();
            settle(cx, h);
            assert!(writes.is_empty());
            shot(cx, h, &dir, width, dark, "working");
            cx.update_window(h, |_, w, cx| w.click("local-stop", cx))
                .unwrap();
            settle(cx, h);
            match writes.try_recv() {
                Ok(WriteCommand::Submit {
                    key,
                    stop: true,
                    follow_up: false,
                    ..
                }) => assert_eq!(key, "chat:ask-working"),
                _ => panic!("explicit Stop is the only write"),
            }
            assert!(writes.is_empty());
            // Stop only clears the local thinking line; it opens nothing.
            assert!(matches!(
                commands.try_recv(),
                Ok(Command::StopThinking { .. })
            ));
            assert!(commands.is_empty());

            // A restricted Ask member keeps its live chat and composer.
            open(cx, h, &v, "explorer");
            assert!(
                matches!(commands.try_recv(), Ok(Command::Open { id, .. }) if id == "explorer")
            );
            loaded(cx, h, &v, false);

            // Build returns through the live stream with its exact draft.
            open(cx, h, &v, "synthetic");
            assert!(
                matches!(commands.try_recv(), Ok(Command::Open { id, .. }) if id == "synthetic")
            );
            assert_eq!(cx.update(|cx| input.read(cx).value().to_string()), draft);
            assert!(writes.is_empty());
            assert!(
                commands.is_empty(),
                "opening, reading and Find start nothing"
            );
            cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
            cx.run_until_parked();
            println!(
                "legacy ask native {width} dark={dark}: passive history, no send/reply, Stop, Find, explorer/Build routing and draft passed"
            );
        }
    }
}
