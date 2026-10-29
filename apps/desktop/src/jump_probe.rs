//! Native production root, synthetic summaries and faux channels only.
use super::*;
use gpui_kit::{
    Bounds, EntityInputHandler, Focusable, HeadlessAppContext, WindowBounds, WindowOptions,
    component::{Theme, ThemeMode},
    size,
    test::TestWindowExt,
};
use serde_json::json;

fn settle(cx: &mut HeadlessAppContext, h: gpui_kit::AnyWindowHandle) {
    for _ in 0..24 {
        cx.advance_clock(Duration::from_millis(16));
        cx.run_until_parked();
        cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
    }
}
fn query(v: &Entity<LocalViewer>, cx: &App) -> Entity<gpui_kit::component::input::InputState> {
    v.read(cx)
        .jump
        .as_ref()
        .unwrap()
        .read(cx)
        .list
        .read(cx)
        .query_input()
}
fn rows() -> Vec<Message> {
    vec![Message::live(
        100,
        "assistant".into(),
        "Synthetic retained reader 👩‍💻 e\u{301}.".into(),
    )]
}
pub fn run_jump_probe(cx: &mut HeadlessAppContext) {
    let captures = std::env::var_os("PILOT_NEXT_JUMP_DIR").map(std::path::PathBuf::from);
    if let Some(dir) = &captures {
        std::fs::create_dir_all(dir).unwrap();
    }
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            cx.update(|cx| Theme::change(mode, None, cx));
            let (client, reads) = LocalClient::synthetic_commands();
            let (writer, writes) = Interaction::recording();
            let (h,v)=cx.update(|cx|gpui_kit::open_window(WindowOptions{
            window_bounds:Some(WindowBounds::Windowed(Bounds::new(Default::default(),size(px(width),px(600.))))),show:false,focus:false,..Default::default()
        },cx,|w,cx|cx.new(|cx|{
            let mut v=LocalViewer::preview(PreviewState::Conversation,w,cx);
            v.client=Some(client);v.writer=Some(writer.clone());v.editor.update(cx,|e,cx|e.shell_probe_setup(writer,w,cx));
            v.generation=10;v.state.generation=10;v.state.loaded=true;v.state.list_loaded=true;v.state.projects_loaded=true;
            v.state.projects=Arc::new(crate::local_model::projects(&json!([
                {"id":"a","name":"Résumé","path":"/synthetic/shared"},{"id":"b","name":"Boreal","path":"/synthetic/shared"}
            ])).unwrap());
            v.state.chats=Arc::new([
                json!({"id":"synthetic","title":"Current conversation","state":"idle","projectId":"a"}),
                json!({"id":"other","title":"Review package","state":"idle","projectId":"b","pullRequest":{"number":123,"url":"https://github.com/o/boreal/pull/123"}}),
                json!({"id":"archive","title":"Review package","state":"idle","archivedAt":1,"projectId":"a","pullRequest":{"number":123,"url":"https://github.com/o/resume/pull/123"}}),
                json!({"id":"longer","title":"Unrelated","pullRequest":{"number":1234,"url":"https://github.com/o/boreal/pull/1234"}})
            ].iter().map(|x|crate::local_model::chat(x).unwrap()).collect());
            v.state.cursor=Some(100);v.transcript.update(cx,|t,cx|{t.history_scope(10);t.replace_readonly(rows(),true,cx);});v.rebuild_nav(w,cx);v
        }))).unwrap();
            settle(cx, h);
            let transcript = cx.update(|cx| v.read(cx).transcript.entity_id());
            cx.update_window(h, |_, w, cx| {
                let text = v.read(cx).editor.read(cx).shell_probe().0;
                text.update(cx, |t, cx| {
                    t.replace_and_mark_text_in_range(None, "にほん", Some(3..3), w, cx)
                });
                w.press("secondary-k", cx);
                assert!(v.read(cx).jump.is_none());
                text.update(cx, |t, cx| {
                    t.unmark_text(w, cx);
                    t.set_value("Keep 👩‍💻 e\u{301}", w, cx);
                });
                let editor = v.read(cx).editor.clone();
                editor.update(cx, |e, cx| e.focus(w, cx));
                w.press("secondary-k", cx);
            })
            .unwrap();
            settle(cx, h);
            assert!(reads.try_recv().is_err() && writes.try_recv().is_err());
            if let Some(dir) = &captures {
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(dir.join(format!("{}-{}.png", width as u32, mode.name())))
                    .unwrap();
            }
            cx.update_window(h, |_, w, cx| {
                let pane = w.find("jump-palette").bounds();
                assert!(
                    pane.origin.x >= px(0.)
                        && pane.right() <= px(width)
                        && pane.bottom() <= px(600.)
                );
                assert!(v.read(cx).jump.as_ref().unwrap().read(cx).probe(cx).2);
                let q = query(&v, cx);
                assert!(
                    q.focus_handle(cx).is_focused(w),
                    "palette search must own focus"
                );
                let before = w.focused(cx);
                w.press("tab", cx);
                w.press("shift-tab", cx);
                w.press("secondary-f", cx);
                w.press("secondary-l", cx);
                assert_eq!(w.focused(cx), before, "modal search owns keyboard focus");
                assert!(q.read(cx).value().is_empty());
                v.update(cx, |v, cx| v.show_home(w, cx));
                assert_eq!(
                    v.read(cx).page,
                    Page::Chat,
                    "background/menu navigation cannot override active search intent"
                );
                w.input("#123", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(w.try_find("jump-row-chat:other").is_some());
                assert!(w.try_find("jump-row-chat:archive").is_some());
                assert!(w.try_find("jump-row-chat:longer").is_none());
                let p = v.read(cx).jump.as_ref().unwrap();
                assert_eq!(p.read(cx).probe(cx).3.as_deref(), Some("chat:other"));
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
                    Some("chat:archive")
                );
                w.press("up", cx);
                assert_eq!(
                    v.read(cx)
                        .jump
                        .as_ref()
                        .unwrap()
                        .read(cx)
                        .probe(cx)
                        .3
                        .as_deref(),
                    Some("chat:other")
                );
                v.update(cx, |v, cx| {
                    v.state.chats = Arc::new(v.state.chats.as_ref().clone());
                    cx.notify();
                });
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert_eq!(
                    v.read(cx)
                        .jump
                        .as_ref()
                        .unwrap()
                        .read(cx)
                        .probe(cx)
                        .3
                        .as_deref(),
                    Some("chat:other")
                );
                w.press("secondary-a", cx);
                w.input("#999", cx);
                w.press("enter", cx);
                assert!(v.read(cx).jump.is_some(), "old PR query cannot activate");
            })
            .unwrap();
            settle(cx, h);
            assert!(reads.try_recv().is_err() && writes.try_recv().is_err());
            cx.update_window(h, |_, w, cx| {
                w.press("secondary-a", cx);
                w.input("#123", cx);
            })
            .unwrap();
            settle(cx, h);
            if let Some(dir) = &captures {
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(dir.join(format!("pr-{}-{}.png", width as u32, mode.name())))
                    .unwrap();
            }
            cx.update_window(h, |_, w, cx| {
                w.press("escape", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(v.read(cx).jump.is_none());
                assert_eq!(
                    v.read(cx)
                        .editor
                        .read(cx)
                        .shell_probe()
                        .0
                        .read(cx)
                        .value()
                        .as_ref(),
                    "Keep 👩‍💻 e\u{301}"
                );
                w.press("secondary-k", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                w.input("ＲＥＳＵＭＥ", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(w.try_find("jump-row-project:a").is_some());
                let state = v.read(cx).jump.as_ref().unwrap().read(cx).probe(cx);
                assert_eq!(
                    state.3.as_deref(),
                    Some("project:a"),
                    "ready/selection before native Enter: {state:?}"
                );
                w.press("enter", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update(|cx| {
                assert!(v.read(cx).jump.is_none());
                assert_eq!(v.read(cx).project_scope.as_deref(), Some("a"));
                assert_eq!(v.read(cx).transcript.entity_id(), transcript);
                assert_eq!(
                    v.read(cx).editor.read(cx).shell_probe().2.unwrap().text,
                    "Keep 👩‍💻 e\u{301}"
                );
            });
            assert!(reads.try_recv().is_err());
            cx.update_window(h, |_, w, cx| w.press("secondary-k", cx))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| w.click("jump-row-page:inbox", cx))
                .unwrap();
            settle(cx, h);
            cx.update(|cx| assert_eq!(v.read(cx).page, Page::Inbox(Some("a".into()))));
            assert!(reads.try_recv().is_err());
            // The real searchable Select owns a fourth input. Palette opening
            // must refuse before focus loss can run Select::on_blur and clear it.
            cx.update_window(h, |_, w, cx| w.click("inbox-project-filter", cx))
                .unwrap();
            settle(cx, h);
            let picker = cx.update(|cx| v.read(cx).inbox.read(cx).probe_picker_query(cx));
            let (picker_focus, picker_mark) = cx
                .update_window(h, |_, w, cx| {
                    assert!(
                        picker.focus_handle(cx).is_focused(w),
                        "mounted picker search must really own focus"
                    );
                    let mark = picker.update(cx, |q, cx| {
                        q.replace_and_mark_text_in_range(None, "にほん", Some(3..3), w, cx);
                        q.marked_text_range(w, cx)
                    });
                    assert!(mark.is_some());
                    assert_eq!(
                        v.read(cx).inbox.read(cx).probe_picker_value(cx).as_deref(),
                        Some("a")
                    );
                    let focus = w.focused(cx);
                    w.press("secondary-k", cx);
                    assert!(
                        v.read(cx).jump.is_none(),
                        "picker preedit refuses palette before blur"
                    );
                    (focus, mark)
                })
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(v.read(cx).jump.is_none());
                assert_eq!(w.focused(cx), picker_focus);
                picker.update(cx, |q, cx| {
                    assert_eq!(q.value().as_ref(), "にほん");
                    assert_eq!(q.marked_text_range(w, cx), picker_mark);
                    q.unmark_text(w, cx);
                });
                assert_eq!(v.read(cx).page, Page::Inbox(Some("a".into())));
                assert_eq!(
                    v.read(cx).inbox.read(cx).probe_picker_value(cx).as_deref(),
                    Some("a")
                );
                assert_eq!(v.read(cx).transcript.entity_id(), transcript);
                assert_eq!(v.read(cx).state.cursor, Some(100));
                assert_eq!(
                    v.read(cx).editor.read(cx).shell_probe().2.unwrap().text,
                    "Keep 👩‍💻 e\u{301}"
                );
                assert!(reads.try_recv().is_err() && writes.try_recv().is_err());
                w.press("secondary-a", cx);
                w.input("Boreal", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                w.press("secondary-k", cx);
                assert!(
                    v.read(cx).jump.is_some(),
                    "unmarked picker does not disable Cmd-K"
                );
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                let q = query(&v, cx);
                assert!(
                    q.focus_handle(cx).is_focused(w),
                    "palette search owns focus after picker handoff"
                );
                assert_eq!(
                    v.read(cx).inbox.read(cx).probe_picker_value(cx).as_deref(),
                    Some("a")
                );
                q.update(cx, |q, cx| {
                    q.replace_and_mark_text_in_range(None, "にほん", Some(3..3), w, cx)
                });
                w.press("enter", cx);
                assert!(v.read(cx).jump.is_some(), "IME Return cannot activate");
                q.update(cx, |q, cx| {
                    assert!(
                        q.marked_text_range(w, cx).is_some(),
                        "IME Return preserves preedit"
                    )
                });
                w.press("escape", cx);
                assert!(
                    v.read(cx).jump.is_some(),
                    "IME Escape cannot dismiss palette"
                );
                q.update(cx, |q, cx| {
                    assert!(
                        q.marked_text_range(w, cx).is_some(),
                        "IME Escape preserves preedit"
                    )
                });
                w.press("secondary-k", cx);
                assert!(v.read(cx).jump.is_some());
                assert_eq!(v.read(cx).page, Page::Inbox(Some("a".into())));
                q.update(cx, |q, cx| {
                    assert!(q.marked_text_range(w, cx).is_some());
                    q.unmark_text(w, cx);
                });
                // Programmatic set_value is not a native Change notification.
                // Drive the real search input, including its list controller.
                w.press("secondary-a", cx);
                w.input("PR #123", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(w.try_find("jump-row-chat:other").is_some());
                let state = v.read(cx).jump.as_ref().unwrap().read(cx).probe(cx);
                assert_eq!(
                    state.3.as_deref(),
                    Some("chat:other"),
                    "post-preedit ready selection: {state:?}"
                );
                // Publication race: UI still shows an old row while the source changed.
                v.update(cx, |v, cx| {
                    v.state.chats = Arc::new(
                        v.state
                            .chats
                            .iter()
                            .filter(|c| c.id != "other")
                            .cloned()
                            .collect(),
                    );
                    cx.notify();
                });
                w.click("jump-row-chat:other", cx);
            })
            .unwrap();
            settle(cx, h);
            assert!(reads.try_recv().is_err());
            cx.update_window(h, |_, w, cx| {
                assert!(v.read(cx).jump.is_some());
                assert!(w.try_find("jump-row-chat:other").is_none());
                w.press("secondary-a", cx);
                w.input(&"z".repeat(241), cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                w.press("enter", cx);
                assert!(v.read(cx).jump.is_some());
                w.press("escape", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update(|cx| assert!(v.read(cx).jump.is_none()));
            cx.update_window(h,|_,w,cx|{
            v.update(cx,|v,cx|{let mut chats=v.state.chats.as_ref().clone();chats.insert(0,crate::local_model::chat(&json!({"id":"other","title":"Review package","state":"idle","projectId":"b","pullRequest":{"number":123,"url":"https://github.com/o/boreal/pull/123"}})).unwrap());v.state.chats=Arc::new(chats);v.rebuild_nav(w,cx);});
            w.press("secondary-k",cx);
        }).unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| w.input("123", cx)).unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| w.press("enter", cx))
                .unwrap();
            settle(cx, h);
            assert!(matches!(reads.try_recv(),Ok(Command::Open{id,generation:11})if id=="other"));
            assert!(reads.try_recv().is_err() && writes.try_recv().is_err());
            cx.update(|cx| assert_eq!(v.read(cx).selected.as_deref(), Some("other")));
            cx.update_window(h,|_,w,cx|v.update(cx,|v,cx|{
            v.state.chats=Arc::new((0..1000).map(|i|crate::local_model::chat(&json!({"id":format!("c{i}"),"title":format!("Conversation {i}"),"state":"idle"})).unwrap()).collect());
            v.state.projects=Arc::new((0..256).map(|i|crate::local_model::Project{id:format!("p{i}"),name:format!("Project {i}"),path:"/synthetic/shared".into(),..Default::default()}).collect());
            v.project_scope=None;v.rebuild_nav(w,cx);v.toggle_jump(w,cx);
        })).unwrap();
            settle(cx, h);
            let weak = cx.update(|cx| {
                let p = v.read(cx).jump.as_ref().unwrap();
                let (all, visible, ready, _) = p.read(cx).probe(cx);
                assert_eq!(all, 1259);
                assert!(ready && visible <= 18);
                p.downgrade()
            });
            cx.update_window(h, |_, w, cx| w.press("escape", cx))
                .unwrap();
            settle(cx, h);
            cx.update(|_| {
                assert!(
                    weak.upgrade().is_none(),
                    "closed palette releases list/catalog/tasks"
                )
            });
            cx.update_window(h, |_, w, cx| {
                v.update(cx, |v, cx| {
                    v.state.list_loaded = false;
                    v.state.projects_error = Some("Synthetic unavailable");
                    v.state.chats = Arc::new(vec![]);
                    v.state.projects = Arc::new(vec![]);
                    v.rebuild_nav(w, cx);
                    v.toggle_jump(w, cx);
                })
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(w.try_find("jump-row-page:home").is_some());
                w.press("escape", cx);
            })
            .unwrap();
            settle(cx, h);
            assert!(reads.try_recv().is_err() && writes.try_recv().is_err());
            println!(
                "{}",
                json!({"width":width,"mode":mode.name(),"native_offscreen":true,"keyboard_pointer_jumps":true,"unicode":true,"draft_and_palette_preedit":true,"stale_source_refused":true,"faux_open_reads":1,"canonical_write_commands":0,"exact_pr_keyboard":true,"same_title_repositories":true,"catalog_capacity":1259,"visible_max":18,"close_releases_palette":true,"empty_error_pages_retained":true})
            );
            cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
            cx.run_until_parked();
        }
    }
}
