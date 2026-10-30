//! Retained canonical position -> bounded pages -> real hidden GPUI anchor.
use super::*;
use crate::{local_model::LiveTranscript, model::ReaderKey, navigation::ReadingMark};

fn entry(id: u64) -> serde_json::Value {
    let body = format!(
        "Canonical entry {id}. {}",
        "Stable reader position, 日本 👩‍💻 e\u{301}. ".repeat(160)
    );
    json!({"id":id,"kind":"pi.assistant","model":[{"role":"assistant","content":[{"type":"text","text":body}]}]})
}
fn snapshot(ids: &[u64], before: Option<u64>) -> LiveTranscript {
    let mut model = LiveTranscript::default();
    model.apply(&json!({"type":"snapshot","entries":ids.iter().map(|&id|entry(id)).collect::<Vec<_>>(),"history":{"context":{"conversationId":0,"tail":100},"more":before.is_some(),"before":before}}));
    model
}
fn publish(
    cx: &mut HeadlessAppContext,
    h: gpui_kit::AnyWindowHandle,
    v: &Entity<LocalViewer>,
    model: &mut LiveTranscript,
    revision: u64,
) {
    let rows = model.rows();
    cx.update_window(h, |_, w, cx| {
        v.update(cx, |v, cx| {
            let mut s = v.state.clone();
            s.rows = rows;
            s.generation = v.generation;
            s.loaded = true;
            s.reader_revision = v.generation;
            s.page_revision = revision;
            s.cursor = model.cursor;
            s.page_busy = false;
            s.page_error = false;
            s.chat_issue = false;
            s.chat_status = "Connected · Local".into();
            v.accept(s, w, cx);
        })
    })
    .unwrap();
    settle(cx, h);
}
fn page(model: &mut LiveTranscript, before: u64, ids: &[u64], next: Option<u64>) {
    assert!(model.page(before,&json!({"context":{"conversationId":0,"tail":100},"before":before,"entries":ids.iter().map(|&id|entry(id)).collect::<Vec<_>>(),"more":next.is_some(),"nextBefore":next})));
}
fn earlier(reads: &async_channel::Receiver<Command>, before: u64) {
    assert!(matches!(reads.try_recv(),Ok(Command::Earlier {before:b,generation:12}) if b==before));
    assert!(reads.is_empty());
}
pub(super) fn run(cx: &mut HeadlessAppContext) {
    for (width, mode, reduced) in [
        (680., ThemeMode::Light, false),
        (1100., ThemeMode::Dark, false),
        (680., ThemeMode::Light, true),
        (1100., ThemeMode::Dark, true),
    ] {
        cx.update(|cx| {
            crate::appearance::commit_appearance(
                if mode == ThemeMode::Dark {
                    crate::settings_state::AppearancePreference::Dark
                } else {
                    crate::settings_state::AppearancePreference::Light
                },
                cx,
            );
            cx.set_reduce_motion(reduced);
        });
        let (client, reads) = LocalClient::synthetic_commands();
        let (h, v) = cx.update(|cx| {
            gpui_kit::open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                        Default::default(),
                        size(px(width), px(650.)),
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
                        v.generation = 10;
                        v.state.generation = 10;
                        v.selected = Some("synthetic".into());
                        v.state.chats = Arc::new(
                            ["synthetic", "other"]
                                .iter()
                                .map(|id| {
                                    crate::local_model::chat(
                                        &json!({"id":id,"title":id,"state":"idle"}),
                                    )
                                    .unwrap()
                                })
                                .collect(),
                        );
                        v.rebuild_nav(w, cx);
                        v
                    })
                },
            )
            .unwrap()
        });
        let mut original = snapshot(&[20, 100], Some(20));
        publish(cx, h, &v, &mut original, 0);
        let key = ReaderKey::model(20, 0, Some(0));
        cx.update_window(h, |_, _, cx| {
            v.update(cx, |v, cx| {
                v.transcript.update(cx, |t, cx| {
                    assert!(t.restore_reading(
                        ReadingMark {
                            message: Some(key.clone()),
                            offset: 37.,
                            following: false
                        },
                        cx
                    ))
                })
            })
        })
        .unwrap();
        settle(cx, h);
        let saved = cx.update(|cx| v.read(cx).transcript.read(cx).reading_mark(cx).unwrap());
        assert_eq!(saved.message, Some(key.clone()));
        assert!(!saved.following);
        cx.update_window(h, |_, w, cx| {
            v.update(cx, |v, cx| {
                let chat = v
                    .state
                    .chats
                    .iter()
                    .find(|c| c.id == "other")
                    .unwrap()
                    .clone();
                assert!(v.open(chat, w, cx));
            })
        })
        .unwrap();
        assert!(matches!(
            reads.try_recv(),
            Ok(Command::Open { generation: 11, .. })
        ));
        let mut other = snapshot(&[90], None);
        publish(cx, h, &v, &mut other, 0);
        cx.update_window(h, |_, w, cx| {
            v.update(cx, |v, cx| {
                let chat = v
                    .state
                    .chats
                    .iter()
                    .find(|c| c.id == "synthetic")
                    .unwrap()
                    .clone();
                assert!(v.open(chat, w, cx));
            })
        })
        .unwrap();
        assert!(matches!(
            reads.try_recv(),
            Ok(Command::Open { generation: 12, .. })
        ));
        let focus = cx
            .update_window(h, |_, w, cx| {
                let focus = v.read(cx).root_focus.clone();
                focus.focus(w, cx);
                focus
            })
            .unwrap();
        let mut recent = snapshot(&[80, 100], Some(80));
        publish(cx, h, &v, &mut recent, 0);
        earlier(&reads, 80);
        cx.update_window(h, |_, w, cx| {
            assert!(v.read(cx).nav_error.is_none());
            assert!(v.read(cx).pending_reader.is_some());
            assert!(focus.is_focused(w), "restoration never takes focus");
        })
        .unwrap();
        page(&mut recent, 80, &[50, 60], Some(50));
        publish(cx, h, &v, &mut recent, 1);
        earlier(&reads, 50);
        recent.apply(&json!({"type":"entry_appended","entry":entry(101)}));
        publish(cx, h, &v, &mut recent, 1);
        assert!(reads.is_empty());
        page(&mut recent, 50, &[20, 30], Some(20));
        publish(cx, h, &v, &mut recent, 2);
        let (text, top) = cx
            .update_window(h, |_, w, cx| {
                let t = v.read(cx).transcript.read(cx);
                let mark = t.reading_mark(cx).unwrap();
                assert_eq!(mark.message, saved.message);
                assert!(!mark.following);
                assert!(
                    (mark.offset - saved.offset).abs() <= 2.,
                    "{mark:?} != {saved:?}"
                );
                assert!(v.read(cx).nav_error.is_none());
                assert!(v.read(cx).pending_reader.is_none());
                assert_eq!(v.read(cx).state.cursor, Some(20));
                assert!(focus.is_focused(w));
                let rows = t.link_snapshot_rows();
                let id = rows.iter().find(|m| m.matches_reader(&key)).unwrap().id();
                let text = t.history_probe_row(id);
                let top = f32::from(text.read(cx).bounds().top());
                (text, top)
            })
            .unwrap();
        assert!(reads.is_empty(), "do not drain history older than target");
        // The restored row retains its native text selection and pixel anchor on live growth.
        let selected = cx
            .update_window(h, |_, w, cx| {
                let b = text.read(cx).bounds();
                let viewport = w.find("viewport").bounds();
                let y = (b.top() + px(8.)).max(viewport.top() + px(8.));
                w.drag(
                    point(b.left() + px(2.), y),
                    point(b.left() + px(210.), y),
                    cx,
                );
                text.read(cx)
                    .selected_source_range()
                    .expect("native selection")
            })
            .unwrap();
        recent.apply(&json!({"type":"entry_appended","entry":entry(102)}));
        publish(cx, h, &v, &mut recent, 2);
        cx.update_window(h, |_, _, cx| {
            assert_eq!(text.read(cx).selected_source_range(), Some(selected));
            assert!((f32::from(text.read(cx).bounds().top()) - top).abs() <= 2.);
            assert!(v.read(cx).nav_error.is_none());
        })
        .unwrap();
        if let Some(dir) = std::env::var_os("PILOT_NEXT_READER_RESTORE_DIR") {
            std::fs::create_dir_all(&dir).unwrap();
            cx.capture_screenshot(h)
                .unwrap()
                .save(std::path::PathBuf::from(dir).join(format!(
                    "{}-{}-reduced{reduced}.png",
                    width as u32,
                    mode.name()
                )))
                .unwrap();
        }
        // Restart a restoration and scroll before its page returns. It must never fight the reader.
        cx.update_window(h, |_, _, cx| {
            v.update(cx, |v, cx| {
                v.pending_reader = Some(crate::navigation::ReaderRestoration {
                    generation: 12,
                    owner: "synthetic".into(),
                    mark: ReadingMark {
                        message: Some(ReaderKey::model(1, 0, Some(0))),
                        offset: 0.,
                        following: false,
                    },
                    revision: None,
                });
                v.restore_reader(cx);
            })
        })
        .unwrap();
        earlier(&reads, 20);
        settle(cx, h);
        cx.update_window(h, |_, w, cx| {
            w.scroll("viewport", ScrollDelta::Lines(point(0., -2.)), cx)
        })
        .unwrap();
        settle(cx, h);
        cx.update(|cx| {
            assert!(
                v.read(cx).pending_reader.is_none(),
                "wheel capture cancels restore"
            )
        });
        page(&mut recent, 20, &[1, 10], None);
        publish(cx, h, &v, &mut recent, 3);
        assert!(reads.is_empty());
        cx.update(|cx| {
            assert_ne!(
                v.read(cx)
                    .transcript
                    .read(cx)
                    .reading_mark(cx)
                    .unwrap()
                    .message,
                Some(ReaderKey::model(1, 0, Some(0)))
            )
        });
        println!(
            "{}",
            json!({"width":width,"mode":mode.name(),"reduced_motion":reduced,"automatic_two_page_restore":true,"canonical_offset_pixels":saved.offset,"no_absence_banner":true,"live_selection_and_anchor":true,"focus_retained":true,"wheel_cancels_late_restore":true,"older_history_stays_lazy":true,"native_offscreen":true})
        );
        cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
        cx.run_until_parked();
    }
    cx.update(|cx| cx.set_reduce_motion(false));
}
