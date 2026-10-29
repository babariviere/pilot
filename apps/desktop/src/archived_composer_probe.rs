//! Archived selected chat: the composer is replaced by a notice with Restore.
//! Actual production views over synthetic Local HTTP, offscreen, no live mutation.
use super::*;
use gpui_kit::Focusable;

const TITLE: &str = "This chat is archived";

fn open_raw() -> serde_json::Value {
    f::source()
}
fn other() -> crate::local_model::Chat {
    crate::local_model::chat(&json!({"id":"other","title":"Another open conversation","projectId":"project","cwd":"/synthetic/project","mode":"ask","state":"idle"})).unwrap()
}
/// Publishes the list (and this chat's rows) as the stream would.
fn publish(
    cx: &mut HeadlessAppContext,
    h: AnyWindowHandle,
    view: &Entity<LocalViewer>,
    rows: &[Message],
    source: &serde_json::Value,
) {
    let (view, rows, source) = (view.clone(), rows.to_vec(), source.clone());
    cx.update_window(h, |_, w, cx| {
        view.update(cx, |v, cx| {
            let mut state = v.state.clone();
            state.rows = rows.clone();
            state.generation = v.generation;
            state.loaded = true;
            state.chats = Arc::new(vec![crate::local_model::chat(&source).unwrap(), other()]);
            v.chats
                .update(cx, |list, _| list.delegate_mut().archived = true);
            v.accept(state, w, cx);
        })
    })
    .unwrap();
    settle(cx, h);
}
fn archived(w: &mut Window) -> bool {
    w.try_find("archived-composer").is_some()
}
#[track_caller]
fn composer_hidden(w: &mut Window) {
    assert!(archived(w));
    for id in [
        "composer-input",
        "composer-tray",
        "local-send",
        "local-stop",
    ] {
        assert!(
            w.try_find(id).is_none(),
            "{id} stays unmounted while archived"
        );
    }
}
fn detail(w: &mut Window) -> String {
    w.find("archived-detail")
        .label()
        .map(|l| l.to_string())
        .unwrap_or_default()
}

pub(super) fn run(cx: &mut HeadlessAppContext) {
    let dir = std::env::var_os("PILOT_NEXT_CHAT_ACTIONS_DIR").map(PathBuf::from);
    if let Some(d) = &dir {
        std::fs::create_dir_all(d).unwrap();
    }
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            journey(cx, width, mode, &dir);
        }
    }
}

fn journey(cx: &mut HeadlessAppContext, width: f32, mode: ThemeMode, dir: &Option<PathBuf>) {
    let full = width == 1100. && mode == ThemeMode::Light;
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
    let server = Server::start(Behavior::Accept);
    let root = std::env::temp_dir()
        .canonicalize()
        .unwrap()
        .join(format!("native-archived-composer-{}", uuid::Uuid::new_v4()));
    let (writer, updates) = Interaction::start(server.options.clone(), Ok(root.clone()));
    let drain = updates.clone();
    let (client, _commands) = LocalClient::synthetic_commands();
    let rows: Vec<Message> = (100..124)
        .map(|id| {
            Message::live(
                id,
                "assistant".into(),
                format!(
                    "Archived reader {id} 私 👩‍💻 {}",
                    "Still readable. ".repeat(30)
                ),
            )
        })
        .collect();
    let initial = rows.clone();
    let (h,view)=cx.update(|cx|gpui_kit::open_window(WindowOptions{window_bounds:Some(WindowBounds::Windowed(Bounds::new(Default::default(),size(px(width),px(840.))))),show:false,focus:false,..Default::default()},cx,|w,cx|cx.new(|cx|{
        let mut v=LocalViewer::build(Some(client),Some(writer.clone()),w,cx);v.chat_actions.update(cx,|a,cx|a.connect(server.options.clone(),cx));
        v.state.status="Synthetic Local fixture".into();v.state.loaded=true;v.state.list_loaded=true;v.state.generation=1;v.generation=1;
        v.state.chats=Arc::new(vec![crate::local_model::chat(&open_raw()).unwrap(),other()]);v.state.projects=Arc::new(crate::local_model::projects(&json!([{"id":"project","name":"Synthetic","path":"/synthetic/project"}])).unwrap());v.state.projects_loaded=true;
        v.selected=Some("source".into());v.title="Selected archived source".into();v.transcript.update(cx,|t,cx|t.replace_readonly(initial.clone(),true,cx));v.editor.update(cx,|e,cx|e.select("chat:source".into(),true,false,w,cx));v.rebuild_nav(w,cx);v.listen_writes(updates,w,cx);v
    }))).unwrap();
    until(cx, h, |_, cx| view.read(cx).editor.read(cx).ready());
    let editor = cx.update(|cx| view.read(cx).editor.clone());
    let transcript = cx.update(|cx| view.read(cx).transcript.clone());
    let input = cx.update(|cx| editor.read(cx).shell_probe().0);
    // A saved draft, then an active composition when the chat is archived elsewhere.
    cx.update_window(h, |_, w, cx| {
        input.update(cx, |i, cx| i.focus(w, cx));
        w.input("Kept archived draft 私の下書き 👩‍💻", cx);
    })
    .unwrap();
    until(cx, h, |_, cx| editor.read(cx).saved_probe(cx));
    let typed = cx.update(|cx| input.read(cx).value().to_string());
    cx.update_window(h, |_, w, cx| {
        input.update(cx, |i, cx| {
            i.replace_and_mark_text_in_range(None, "ガ", Some(1..1), w, cx)
        });
    })
    .unwrap();
    settle(cx, h);
    let mut archived_raw = open_raw();
    archived_raw["archivedAt"] = json!(1234);
    server.seen.lock().unwrap().source = archived_raw.clone();
    publish(cx, h, &view, &rows, &archived_raw);
    // The list is authoritative: the notice replaces the read-only editor at once,
    // and the editor entity keeps its text and saved draft unmounted.
    let text = cx.update(|cx| input.read(cx).value().to_string());
    assert!(text.starts_with(&typed));
    let saved = cx.update(|cx| editor.read(cx).shell_probe().2.unwrap().text);
    // No input method can finish the unmounted composition: it ends as typed and is saved.
    assert_eq!(saved, text);
    cx.update_window(h, |_, w, cx| {
        assert!(!editor.update(cx, |e, cx| e.marked(w, cx)))
    })
    .unwrap();
    until(cx, h, |_, cx| editor.read(cx).saved_probe(cx));
    cx.update_window(h, |_, w, cx| {
        composer_hidden(w);
        assert!(
            w.within("archived-composer")
                .try_find_by_label(TITLE)
                .is_some()
        );
        assert!(
            w.within("archived-composer")
                .try_find_by_label("Restore")
                .is_some()
        );
        assert_ne!(w.find("archived-restore").disabled(), Some(true));
        // Calm and compact: inside the readable column, shorter than the 76pt tray.
        let column = w.find("conversation-editor").bounds();
        let notice = w.find("archived-composer").bounds();
        let button = w.find("archived-restore").bounds();
        let copy = w.find("archived-detail").bounds();
        assert!(
            column.contains(&notice.origin)
                && notice.right() <= column.right()
                && notice.bottom() <= column.bottom()
        );
        assert!(notice.size.height < px(76.), "{:?}", notice.size);
        assert!(button.right() <= notice.right() && button.left() >= copy.right());
        assert!(copy.left() >= notice.left() && copy.bottom() <= notice.bottom());
        assert!(button.top() >= notice.top() && button.bottom() <= notice.bottom());
        // The transcript keeps the remaining height above it.
        assert!(w.find("viewport").bounds().bottom() <= notice.top() + px(1.));
        // The sidebar does not repeat what the notice says.
        assert_eq!(w.find("chat-action-status").bounds().size.height, px(0.));
        let _ = cx;
    })
    .unwrap();
    // The transcript stays readable: it scrolls, and typing restores nothing.
    let before = cx.update(|cx| transcript.read(cx).history_probe_anchor(cx));
    cx.update_window(h, |_, w, cx| {
        w.scroll(
            "viewport",
            gpui_kit::ScrollDelta::Pixels(point(px(0.), px(600.))),
            cx,
        );
    })
    .unwrap();
    settle(cx, h);
    let after = cx.update(|cx| transcript.read(cx).history_probe_anchor(cx));
    assert!(
        before.0 != after.0 || (before.1 - after.1).abs() > 1.,
        "archived transcript scrolls"
    );
    cx.update_window(h, |_, w, cx| {
        let root = view.read(cx).root_focus.clone();
        root.focus(w, cx);
        w.input("typed while archived", cx);
        w.press("enter", cx);
    })
    .unwrap();
    settle(cx, h);
    assert_eq!(server.posts(), 0, "no automatic restore");
    cx.update_window(h, |_, w, cx| {
        composer_hidden(w);
        assert_eq!(input.read(cx).value().as_ref(), text);
    })
    .unwrap();
    // Keyboard reaches Restore with Tab.
    for _ in 0..60 {
        let focused = cx
            .update_window(h, |_, w, cx| {
                if w.find("archived-restore").focused() == Some(true) {
                    true
                } else {
                    w.press("tab", cx);
                    false
                }
            })
            .unwrap();
        settle(cx, h);
        if focused {
            break;
        }
    }
    cx.update_window(h, |_, w, _| {
        assert_eq!(w.find("archived-restore").focused(), Some(true))
    })
    .unwrap();
    capture(
        cx,
        h,
        dir,
        format!("{}-{}-archived.png", width as u32, mode.name()),
    );

    if full {
        // Navigating away while eligibility is checked submits nothing.
        cx.update_window(h, |_, w, cx| {
            w.click("archived-restore", cx);
            assert_eq!(
                view.read(cx).chat_actions.read(cx).restore_view("source"),
                crate::chat_actions_view::RestoreView::Busy
            );
            w.click("chat-row-other", cx);
        })
        .unwrap();
        settle(cx, h);
        until(cx, h, |_, cx| {
            view.read(cx).chat_actions.read(cx).restore_view("source")
                == crate::chat_actions_view::RestoreView::Ready
        });
        assert_eq!(server.posts(), 0, "stale inspection never submits");
        cx.update_window(h, |_, w, cx| {
            assert_eq!(view.read(cx).selected.as_deref(), Some("other"));
            assert!(!archived(w));
            w.click("chat-row-source", cx);
        })
        .unwrap();
        settle(cx, h);
        publish(cx, h, &view, &rows, &archived_raw);
        cx.update_window(h, |_, w, cx| {
            assert_eq!(view.read(cx).selected.as_deref(), Some("source"));
            composer_hidden(w);
            assert_ne!(w.find("archived-restore").disabled(), Some(true));
        })
        .unwrap();
        // Inspection disagrees with the list: a visible failure, nothing submitted, retry offered.
        server.seen.lock().unwrap().source["title"] = json!("Renamed elsewhere");
        cx.update_window(h, |_, w, cx| w.click("archived-restore", cx))
            .unwrap();
        until(cx, h, |_, cx| {
            matches!(
                view.read(cx).chat_actions.read(cx).restore_view("source"),
                crate::chat_actions_view::RestoreView::Failed(_)
            )
        });
        assert_eq!(server.posts(), 0);
        cx.update_window(h, |_, w, _| {
            composer_hidden(w);
            assert_ne!(w.find("archived-restore").disabled(), Some(true));
            assert_eq!(
                detail(w),
                "This chat changed elsewhere. Nothing was submitted."
            );
        })
        .unwrap();
        capture(cx, h, dir, "1100-light-archived-failed.png".into());
        server.seen.lock().unwrap().source["title"] = archived_raw["title"].clone();
        // A lost answer is Unknown: never repeated, never shown as restored.
        server.seen.lock().unwrap().behavior = Behavior::Lost;
        cx.update_window(h, |_, w, cx| w.click("archived-restore", cx))
            .unwrap();
        until(cx, h, |_, cx| {
            view.read(cx).chat_actions.read(cx).outcome("source")
                == Some(&crate::chat_actions::Outcome::Unknown)
        });
        assert_eq!(server.posts(), 1);
        cx.update_window(h, |_, w, cx| {
            composer_hidden(w);
            assert_eq!(w.find("archived-restore").disabled(), Some(true));
            w.click("archived-restore", cx);
        })
        .unwrap();
        settle(cx, h);
        assert_eq!(server.posts(), 1, "Unknown is not repeated");
        capture(cx, h, dir, "1100-light-archived-unknown.png".into());
        // Leaving shows the retained Unknown in the sidebar; nothing is lost.
        cx.update_window(h, |_, w, cx| w.click("chat-row-other", cx))
            .unwrap();
        settle(cx, h);
        cx.update_window(h, |_, w, _| {
            assert!(w.find("chat-action-status").bounds().size.height > px(0.));
        })
        .unwrap();
        // The lost request did restore it; the list is authoritative.
        let restored = server.seen.lock().unwrap().source.clone();
        assert!(restored["archivedAt"].is_null());
        cx.update_window(h, |_, w, cx| w.click("chat-row-source", cx))
            .unwrap();
        settle(cx, h);
        publish(cx, h, &view, &rows, &restored);
        cx.update_window(h, |_, w, cx| {
            assert!(!archived(w));
            assert_eq!(input.read(cx).value().as_ref(), text);
            assert_ne!(w.find("local-send").disabled(), Some(true));
        })
        .unwrap();
    } else {
        // Keyboard (light) or pointer (dark) restore, confirmed by the list.
        server.seen.lock().unwrap().behavior = Behavior::Slow;
        cx.update_window(h, |_, w, cx| {
            if mode == ThemeMode::Light {
                w.press("enter", cx);
            } else {
                w.click("archived-restore", cx);
            }
        })
        .unwrap();
        until(cx, h, |_, _| server.posts() == 1);
        cx.update_window(h, |_, w, cx| {
            composer_hidden(w);
            assert_eq!(w.find("archived-restore").disabled(), Some(true));
            assert_eq!(
                view.read(cx).chat_actions.read(cx).restore_view("source"),
                crate::chat_actions_view::RestoreView::Busy
            );
        })
        .unwrap();
        capture(
            cx,
            h,
            dir,
            format!("{}-{}-restoring.png", width as u32, mode.name()),
        );
        server.released.notify_one();
        until(cx, h, |_, cx| {
            view.read(cx).chat_actions.read(cx).outcome("source")
                == Some(&crate::chat_actions::Outcome::Acknowledged)
        });
        // ACK alone is not the list: the composer waits for it.
        cx.update_window(h, |_, w, cx| {
            composer_hidden(w);
            assert_eq!(
                view.read(cx).chat_actions.read(cx).restore_view("source"),
                crate::chat_actions_view::RestoreView::Restored
            );
        })
        .unwrap();
        let restored = server.seen.lock().unwrap().source.clone();
        assert!(restored["archivedAt"].is_null());
        publish(cx, h, &view, &rows, &restored);
        settle(cx, h);
        cx.update_window(h, |_, w, cx| {
            assert!(!archived(w));
            assert_eq!(view.read(cx).editor, editor);
            assert_eq!(input.read(cx).value().as_ref(), text);
            assert_ne!(w.find("local-send").disabled(), Some(true));
            assert!(
                input.read(cx).focus_handle(cx).is_focused(w),
                "focus returns to the composer"
            );
        })
        .unwrap();
        assert_eq!(server.posts(), 1);
    }
    cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
    drop(view);
    drop(input);
    drop(editor);
    drop(transcript);
    cx.run_until_parked();
    assert!(writer.command(WriteCommand::Close));
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
                assert!(flushed);
            })
            .await
            .unwrap();
        });
    let store = Store::open(root.clone(), server.options.host()).unwrap();
    assert_eq!(store.book.drafts["chat:source"].text, saved);
    drop(store);
    std::fs::remove_dir_all(root).unwrap();
    println!(
        "{}",
        json!({"width":width,"mode":mode.name(),"archived_notice_replaces_composer":true,"composition_unmounts_with_saved_draft":true,"draft_retained":true,"transcript_scrolls":true,"no_restore_on_typing":true,"tab_reaches_restore":true,"stale_navigation_submits_nothing":full,"failure_retry":full,"unknown_not_repeated":full,"list_confirms_restore":true,"focus_returns":!full})
    );
}
