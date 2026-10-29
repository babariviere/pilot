//! Hidden production palette journeys. All opener calls are injected and counted.
use super::*;
use crate::model::ReaderKey;

fn chat(multiple: bool) -> Chat {
    crate::local_model::chat(&json!({
        "id":"synthetic", "title":"Current 修正 👩‍💻", "state":"idle", "mode":"ask", "archivedAt":1,
        "boundPullRequests": if multiple { vec!["https://github.com/o/one/pull/12", "https://github.com/o/two/pull/34"] }
            else { vec!["https://github.com/o/one/pull/12"] }
    })).unwrap()
}
fn text() -> Vec<Message> {
    vec![Message::live(10, "assistant".into(), "[修正](https://linear.app/team/issue/ABC-1/fix) https://github.com/o/one/pull/12 https://u:secret@example.com javascript:alert(1)".into())
        .anchored(ReaderKey::model(10, 0, None))]
}

pub(super) fn run(cx: &mut HeadlessAppContext) {
    let captures = std::env::var_os("PILOT_NEXT_JUMP_DIR").map(std::path::PathBuf::from);
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            let opened = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
            let (client, reads) = LocalClient::synthetic_commands();
            let (writer, writes) = Interaction::recording();
            cx.update(|cx| {
                Theme::change(mode, None, cx);
                let opened = opened.clone();
                cx.set_global(crate::external_links::Opener(Arc::new(move |url, _| {
                    opened.lock().unwrap().push(url.into());
                })));
            });
            let (h, v) = cx
                .update(|cx| {
                    gpui_kit::open_window(
                        WindowOptions {
                            window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                                Default::default(),
                                size(px(width), px(600.)),
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
                                v.writer = Some(writer);
                                v.generation = 10;
                                v.state.generation = 10;
                                v.state.loaded = true;
                                v.state.list_loaded = true;
                                v.state.chats = Arc::new(vec![chat(false)]);
                                v.transcript.update(cx, |t, cx| {
                                    t.history_scope(10);
                                    t.replace_readonly(text(), true, cx);
                                });
                                v.rebuild_nav(w, cx);
                                v
                            })
                        },
                    )
                })
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                w.press("secondary-k", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| w.input("open pull request", cx))
                .unwrap();
            settle(cx, h);
            assert!(opened.lock().unwrap().is_empty());
            cx.update_window(h, |_, w, cx| {
                assert!(
                    w.try_find("jump-row-link:https://github.com/o/one/pull/12")
                        .is_some()
                );
                w.press("enter", cx);
            })
            .unwrap();
            settle(cx, h);
            assert_eq!(
                *opened.lock().unwrap(),
                ["https://github.com/o/one/pull/12"]
            );
            cx.update_window(h, |_, w, cx| {
                assert!(v.read(cx).jump.is_none());
                v.update(cx, |v, cx| {
                    v.state.chats = Arc::new(vec![chat(true)]);
                    v.rebuild_nav(w, cx);
                });
                w.press("secondary-k", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| w.input("open", cx)).unwrap();
            settle(cx, h);
            assert_eq!(
                opened.lock().unwrap().len(),
                1,
                "filtering never opens a URL"
            );
            cx.update_window(h, |_, w, cx| {
                assert!(w.try_find("jump-section-Link").is_some());
                let first = w
                    .find("jump-row-link:https://github.com/o/one/pull/12")
                    .bounds();
                let pane = w.find("jump-palette").bounds();
                assert!(first.left() >= pane.left() && first.right() <= pane.right());
                w.press("down", cx);
                assert_eq!(
                    v.read(cx)
                        .jump
                        .as_ref()
                        .unwrap()
                        .read(cx)
                        .probe(cx)
                        .3
                        .as_deref(),
                    Some("link:https://github.com/o/two/pull/34")
                );
            })
            .unwrap();
            if let Some(dir) = &captures {
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(dir.join(format!("links-{}-{}.png", width as u32, mode.name())))
                    .unwrap();
            }
            cx.update_window(h, |_, w, cx| w.press("enter", cx))
                .unwrap();
            settle(cx, h);
            assert_eq!(
                *opened.lock().unwrap(),
                [
                    "https://github.com/o/one/pull/12",
                    "https://github.com/o/two/pull/34"
                ]
            );

            cx.update_window(h, |_, w, cx| w.press("secondary-k", cx))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| w.input("open pull request", cx))
                .unwrap();
            settle(cx, h);
            assert_eq!(
                opened.lock().unwrap().len(),
                2,
                "multiple PRs need a specific choice"
            );
            cx.update_window(h, |_, w, cx| {
                assert_eq!(v.read(cx).jump.as_ref().unwrap().read(cx).probe(cx).1, 2);
                let q = query(&v, cx);
                q.update(cx, |q, cx| {
                    q.replace_and_mark_text_in_range(None, "にほん", Some(3..3), w, cx)
                });
                w.press("enter", cx);
                w.press("escape", cx);
                assert!(v.read(cx).jump.is_some());
                q.update(cx, |q, cx| {
                    assert!(q.marked_text_range(w, cx).is_some());
                    q.unmark_text(w, cx);
                });
                w.press("secondary-a", cx);
                w.input("two", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(
                    w.try_find("jump-row-link:https://github.com/o/two/pull/34")
                        .is_some()
                );
                // A stale rendered target cannot open after a selected-reader switch.
                v.update(cx, |v, _| {
                    v.selected = Some("another".into());
                    v.generation += 1;
                    v.state.generation = v.generation;
                });
                w.click("jump-row-link:https://github.com/o/two/pull/34", cx);
            })
            .unwrap();
            settle(cx, h);
            assert_eq!(opened.lock().unwrap().len(), 2);
            cx.update_window(h, |_, w, cx| {
                assert!(
                    w.try_find("jump-row-link:https://github.com/o/two/pull/34")
                        .is_none()
                );
                w.press("escape", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                v.update(cx, |v, cx| {
                    v.state.chats = Arc::new(vec![]);
                    v.transcript
                        .update(cx, |t, cx| t.replace_readonly(vec![], true, cx));
                });
                w.press("secondary-k", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| w.input("open link", cx))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert_eq!(v.read(cx).jump.as_ref().unwrap().read(cx).probe(cx).1, 0);
                w.press("enter", cx);
                w.press("escape", cx);
            })
            .unwrap();
            settle(cx, h);
            assert_eq!(opened.lock().unwrap().len(), 2);
            assert!(reads.try_recv().is_err() && writes.try_recv().is_err());
            println!(
                "{}",
                json!({"contextual_links":true,"width":width,"mode":mode.name(),"injected_opens":2,"no_transport":true,"stale_reader_refused":true,"readonly_archived":true})
            );
            cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
            cx.run_until_parked();
        }
    }
}
