//! Actual mounted LocalViewer, injected folder provider, owned faux HTTP/private state.
use super::*;
use crate::{
    project_registration::Outcome,
    project_registration_fixture::{Behavior, Server},
};
use gpui_kit::{
    AnyWindowHandle, Bounds, EntityInputHandler, Focusable, HeadlessAppContext, WindowBounds,
    WindowOptions,
    component::{Theme, ThemeMode},
    size,
    test::TestWindowExt,
};
use serde_json::json;
use std::{path::PathBuf, time::Instant};
fn settle(cx: &mut HeadlessAppContext, h: AnyWindowHandle) {
    for _ in 0..4 {
        cx.run_until_parked();
        cx.advance_clock(Duration::from_millis(16));
        cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
    }
}
fn until(
    cx: &mut HeadlessAppContext,
    h: AnyWindowHandle,
    v: &Entity<LocalViewer>,
    condition: impl Fn(&LocalViewer, &App) -> bool,
) {
    let end = Instant::now() + Duration::from_secs(8);
    while !cx.update(|cx| condition(v.read(cx), cx)) {
        assert!(Instant::now() < end, "bounded Add project publication");
        settle(cx, h);
        std::thread::yield_now();
    }
    settle(cx, h);
}
pub fn run_project_add_probe(cx: &mut HeadlessAppContext) {
    let dir = std::env::var_os("PILOT_NEXT_ADD_PROJECT_DIR").map(PathBuf::from);
    if let Some(d) = &dir {
        std::fs::create_dir_all(d).unwrap();
    }
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            let server = Server::start(Behavior::Accept);
            let private = std::env::temp_dir()
                .canonicalize()
                .unwrap()
                .join(format!("native-add-project-{}", uuid::Uuid::new_v4()));
            let (writer, updates) = Interaction::start(server.options.clone(), Ok(private.clone()));
            let drain = updates.clone();
            cx.update(|cx| Theme::change(mode, None, cx));
            let (handle,view)=cx.update(|cx|gpui_kit::open_window(WindowOptions {
            window_bounds:Some(WindowBounds::Windowed(Bounds::new(Default::default(),size(px(width),px(760.))))),show:false,focus:false,..Default::default()
        },cx,|w,cx|cx.new(|cx| {
            let mut v=LocalViewer::build(None,Some(writer.clone()),w,cx);
            v.selected=Some("source".into());v.title="Keep this conversation".into();v.generation=1;v.state.generation=1;
            v.state.loaded=true;v.state.projects_loaded=true;v.state.list_loaded=true;v.state.status="Synthetic Local fixture".into();
            v.state.chats=Arc::new(vec![crate::local_model::chat(&json!({"id":"source","title":"Keep this conversation","mode":"ask","cwd":"/synthetic/original","state":"idle"})).unwrap()]);
            v.transcript.update(cx,|t,cx|t.replace_readonly((1..24).map(|id|Message::live(id,"assistant".into(),format!("Retain this conversation {id}. {}","Synthetic paragraph 日本語 👩‍💻. ".repeat(12)))).collect(),true,cx));
            v.editor.update(cx,|e,cx|e.select("chat:source".into(),true,false,w,cx));
            v.rebuild_nav(w,cx);v.listen_writes(updates,w,cx);v
        }))).unwrap();
            until(cx, handle, &view, |v, cx| v.editor.read(cx).ready());
            let editor = cx.update(|cx| view.read(cx).editor.clone());
            let transcript = cx.update(|cx| view.read(cx).transcript.clone());
            cx.update_window(handle, |_, w, cx| {
                let input = editor.read(cx).shell_probe().0;
                input.update(cx, |t, cx| {
                    t.focus(w, cx);
                    t.set_value("Keep unsent 私 👩‍💻", w, cx);
                    t.replace_and_mark_text_in_range(None, "にほん", Some(3..3), w, cx);
                });
                view.update(cx, |v, cx| v.open_add_project(w, cx));
                assert!(!view.read(cx).add_project_open);
                input.update(cx, |t, cx| t.unmark_text(w, cx));
                input.update(cx, |t, cx| t.set_value("Keep unsent 私 👩‍💻", w, cx));
                assert!(
                    w.try_find("add-project").is_none(),
                    "no permanent Add project row"
                );
                w.click("project-scope", cx);
            })
            .unwrap();
            settle(cx, handle);
            if mode == ThemeMode::Dark {
                cx.update_window(handle, |_, w, cx| w.press("escape", cx))
                    .unwrap();
                settle(cx, handle);
                // Reach the selector through the native Tab order, not a
                // direct invocation or synthetic replacement focus handle.
                for _ in 0..8 {
                    if cx
                        .update_window(handle, |_, w, _| {
                            w.find("project-scope").focused() == Some(true)
                        })
                        .unwrap()
                    {
                        break;
                    }
                    cx.update_window(handle, |_, w, cx| w.press("shift-tab", cx))
                        .unwrap();
                    settle(cx, handle);
                }
                cx.update_window(handle, |_, w, cx| {
                    assert_eq!(w.find("project-scope").focused(), Some(true));
                    w.press("enter", cx);
                })
                .unwrap();
                settle(cx, handle);
            }
            cx.update_window(handle, |_, w, cx| {
                assert_eq!(w.find("add-project").label(), Some("Add project…"));
                assert!(view.read(cx).projects.focus_handle(cx).is_focused(w));
                // The first Tab from the nonsearchable project list reaches the
                // disclosed action. Exercise real native keyboard activation.
                if mode == ThemeMode::Dark {
                    w.press("tab", cx);
                } else {
                    w.click("add-project", cx);
                }
            })
            .unwrap();
            settle(cx, handle);
            if mode == ThemeMode::Dark {
                cx.update_window(handle, |_, w, cx| {
                    assert_eq!(w.find("add-project").focused(), Some(true));
                    w.press("enter", cx);
                })
                .unwrap();
                settle(cx, handle);
            }
            assert!(cx.update(|cx| view.read(cx).add_project_open));
            assert_eq!(server.posts(), 0);
            cx.update_window(handle, |_, w, cx| {
                let root = w.find("desktop-root").bounds();
                let sheet = w.find("add-project-sheet").bounds();
                assert_eq!(root.size.width, px(width));
                assert_eq!(root.size, w.viewport_size());
                assert!(
                    sheet.left() >= root.left()
                        && sheet.right() <= root.right()
                        && sheet.bottom() <= root.bottom()
                );
                assert_eq!(w.find("confirm-add-project").disabled(), Some(true));
                view.update(cx, |v, cx| {
                    v.show_home(w, cx);
                    v.toggle_jump(w, cx);
                    v.open_settings(w, cx);
                    assert_eq!(v.selected.as_deref(), Some("source"));
                    assert!(v.jump.is_none() && v.settings_window.is_none());
                });
                view.read(cx).add_project.clone().update(cx, |f, _| {
                    f.folders =
                        Some([Ok(None), Ok(Some(PathBuf::from("/synthetic/日本語 👩‍💻")))].into())
                });
                w.click("choose-project-folder", cx);
            })
            .unwrap();
            settle(cx, handle);
            assert_eq!(server.posts(), 0);
            cx.update_window(handle, |_, w, cx| w.press("escape", cx))
                .unwrap();
            settle(cx, handle);
            assert!(!cx.update(|cx| view.read(cx).add_project_open));
            assert_eq!(server.posts(), 0);
            cx.update_window(handle, |_, w, cx| {
                assert!(
                    view.read(cx).chats.focus_handle(cx).is_focused(w),
                    "close restores the mounted sidebar list"
                );
                w.click("project-scope", cx);
            })
            .unwrap();
            settle(cx, handle);
            cx.update_window(handle, |_, w, cx| {
                w.click("add-project", cx);
            })
            .unwrap();
            settle(cx, handle);
            cx.update_window(handle, |_, w, cx| w.click("choose-project-folder", cx))
                .unwrap();
            settle(cx, handle);
            if let Some(d) = &dir {
                cx.capture_screenshot(handle)
                    .unwrap()
                    .save(d.join(format!("{}-{}-confirm.png", width as u32, mode.name())))
                    .unwrap();
            }
            cx.update_window(handle, |_, w, cx| {
                assert_ne!(w.find("confirm-add-project").disabled(), Some(true));
                if mode == ThemeMode::Light {
                    w.click("confirm-add-project", cx);
                } else {
                    w.press("secondary-enter", cx);
                }
                view.read(cx)
                    .add_project
                    .clone()
                    .update(cx, |f, cx| f.confirm(cx));
            })
            .unwrap();
            until(cx, handle, &view, |v, cx| {
                matches!(v.add_project.read(cx).result, Some(Ok(Outcome::Created(_))))
                    && !v.state.projects.is_empty()
            });
            assert_eq!(server.posts(), 1);
            if let Some(d) = &dir {
                cx.capture_screenshot(handle)
                    .unwrap()
                    .save(d.join(format!("{}-{}-added.png", width as u32, mode.name())))
                    .unwrap();
            }
            cx.update_window(handle, |_, w, cx| {
                w.click("refresh-projects", cx);
            })
            .unwrap();
            until(cx, handle, &view, |v, cx| !v.add_project.read(cx).pending);
            cx.update_window(handle, |_, w, cx| {
                w.click("add-project-close", cx);
            })
            .unwrap();
            settle(cx, handle);
            cx.update(|cx| {
                let v = view.read(cx);
                assert!(v.editor == editor && v.transcript == transcript);
                assert_eq!(v.selected.as_deref(), Some("source"));
                assert!(v.project_scope.is_none());
                assert_eq!(v.state.projects[0].id, "registered-project");
                let (_, _, draft) = editor.read(cx).shell_probe();
                let draft = draft.unwrap();
                assert_eq!(draft.text, "Keep unsent 私 👩‍💻");
                assert!(draft.project_id.is_none() && draft.pending.is_none());
            });
            // New-chat chooser offers the same explicit registration action; opening
            // it never chooses a destination or creates a chat from catalog changes.
            cx.update_window(handle, |_, w, cx| w.click("new-local-chat", cx))
                .unwrap();
            settle(cx, handle);
            cx.update_window(handle, |_, w, cx| w.click("new-chat-add-project", cx))
                .unwrap();
            settle(cx, handle);
            assert!(cx.update(|cx| view.read(cx).add_project_open));
            assert_eq!(server.posts(), 1);
            cx.update_window(handle, |_, w, cx| w.press("escape", cx))
                .unwrap();
            settle(cx, handle);
            let snap = std::fs::read(private.join("state-v1.json")).unwrap();
            let book: serde_json::Value = serde_json::from_slice(&snap).unwrap();
            assert!(book["pending"].as_object().unwrap().is_empty());
            cx.update_window(handle, |_, w, _| w.remove_window())
                .unwrap();
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
            drop(writer);
            std::fs::remove_dir_all(private).unwrap();
            println!(
                "{}",
                json!({"width":width,"mode":mode.name(),"actual_local_viewer":true,"pointer_and_native_tab_enter_selector_action":true,"mounted_focus_return":true,"cancel_posts":0,"explicit_posts":server.posts(),"no_chat_create_send":true,"canonical_refresh":true,"retained_editor_reader_draft":true,"preedit_fenced":true,"private_flush":true})
            );
        }
    }
}
