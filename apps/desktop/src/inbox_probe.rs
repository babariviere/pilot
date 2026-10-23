//! Offscreen production views. No live reads, private state, writes or actions.
use super::*;
use gpui_kit::{
    Bounds, EntityInputHandler, HeadlessAppContext, WindowBounds, WindowOptions,
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
fn chats() -> Vec<Chat> {
    [
        json!({"id":"synthetic","title":"Review deployment options","projectId":"a","state":"idle","outcome":"question","attentionReason":{"kind":"asks","detail":"Which region should receive the canary?"}}),
        json!({"id":"failed","title":"Check release package and retained native resources for the synthetic macOS desktop 日本語","projectId":"a","state":"idle","outcome":"failed","attentionReason":{"kind":"failed","detail":"Synthetic verification needs a correction before the next source checkpoint. Retain the exact chat identity and do not treat this fixture as production readiness."}}),
        json!({"id":"job","title":"Inspect metrics export","projectId":"a","state":"working","attentionReason":{"kind":"long_job","detail":"Export is still running"}}),
        json!({"id":"review","title":"Read the API summary","projectId":"b","state":"idle","attentionReason":{"kind":"not_reviewed"}}),
        json!({"id":"ready","title":"Refresh navigation icons","projectId":"b","state":"idle","pullRequest":{"state":"open","readiness":{"state":"ready"}}}),
        json!({"id":"busy","title":"Working, not attention","projectId":"b","state":"working","outcome":"failed"}),
        json!({"id":"archived","title":"Archived, not attention","projectId":"a","state":"failed","archivedAt":1}),
        json!({"id":"done","title":"Done does not imply unread","projectId":"b","state":"idle","outcome":"done"}),
        json!({"id":"unknown","title":"Unknown reason is not an approval","state":"idle","attentionReason":{"kind":"future","detail":"Do not expose unknown details"},"pendingApprovals":[1,2]}),
    ].iter().map(|v|crate::local_model::chat(v).unwrap()).collect()
}
fn rows() -> Vec<Message> {
    vec![Message::live(
        100,
        "assistant".into(),
        "Synthetic retained reader 👩‍💻 e\u{301}.".into(),
    )]
}
fn capture_state(
    cx: &mut HeadlessAppContext,
    h: gpui_kit::AnyWindowHandle,
    directory: Option<&std::path::Path>,
    width: f32,
    mode: ThemeMode,
    state: &str,
) {
    if let Some(directory) = directory {
        cx.update_window(h, |_, w, cx| w.draw(cx).clear(cx))
            .unwrap();
        cx.capture_screenshot(h)
            .unwrap()
            .save(directory.join(format!("{}-{}-{state}.png", width as u32, mode.name())))
            .unwrap();
    }
}
pub fn run_inbox_probe(cx: &mut HeadlessAppContext) {
    let captures = std::env::var_os("PILOT_NEXT_INBOX_DIR").map(std::path::PathBuf::from);
    if let Some(dir) = &captures {
        std::fs::create_dir_all(dir).unwrap();
    }
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            cx.update(|cx| Theme::change(mode, None, cx));
            let (client, reads) = LocalClient::synthetic_commands();
            let (writer, writes) = Interaction::recording();
            let (h, v) = cx.update(|cx| {
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
                            v.writer = Some(writer.clone());
                            v.editor
                                .update(cx, |e, cx| e.shell_probe_setup(writer, w, cx));
                            v.generation = 10;
                            v.state.generation = 10;
                            v.state.loaded = true;
                            v.state.list_loaded = true;
                            v.state.projects = Arc::new(
                                crate::local_model::projects(&json!([
                                    {"id":"a","name":"Atlas","path":"/synthetic/shared"},
                                    {"id":"b","name":"Boreal","path":"/synthetic/shared"}
                                ]))
                                .unwrap(),
                            );
                            v.state.projects_loaded = true;
                            v.state.chats = Arc::new(chats());
                            v.state.cursor = Some(100);
                            v.transcript.update(cx, |t, cx| {
                                t.history_scope(10);
                                t.replace_readonly(rows(), true, cx);
                            });
                            v.rebuild_nav(w, cx);
                            v
                        })
                    },
                )
                .unwrap()
            });
            settle(cx, h);
            let transcript = cx.update(|cx| v.read(cx).transcript.entity_id());
            cx.update_window(h, |_, w, cx| {
                let text = v.read(cx).editor.read(cx).shell_probe().0;
                text.update(cx, |t, cx| {
                    t.replace_and_mark_text_in_range(None, "にほん", Some(3..3), w, cx)
                });
                v.update(cx, |v, cx| v.show_inbox(None, w, cx));
                assert_eq!(v.read(cx).page, Page::Chat);
                text.update(cx, |t, cx| {
                    t.unmark_text(w, cx);
                    t.set_value("Keep this draft 👩‍💻 e\u{301}", w, cx);
                });
                w.click("nav-inbox", cx);
            })
            .unwrap();
            settle(cx, h);
            // Preserve keyboard selection by stable identity across urgency changes.
            cx.update_window(h, |_, w, cx| {
                let list = v.read(cx).inbox.read(cx).list.clone();
                list.update(cx, |l, cx| {
                    l.set_selected_index(Some(IndexPath::new(0)), w, cx)
                });
                v.update(cx, |v, cx| {
                    let mut s = v.state.clone();
                    s.rows = rows();
                    let mut changed = chats();
                    changed[1] = crate::local_model::chat(
                        &json!({"id":"failed","projectId":"a","state":"idle","outcome":"question"}),
                    )
                    .unwrap();
                    s.chats = Arc::new(changed);
                    v.accept(s, w, cx);
                });
            })
            .unwrap();
            settle(cx, h);
            cx.update(|cx| {
                assert_eq!(
                    v.read(cx).inbox.read(cx).probe_selected(cx).as_deref(),
                    Some("failed")
                )
            });
            cx.update_window(h, |_, w, cx| {
                v.update(cx, |v, cx| {
                    let mut s = v.state.clone();
                    s.rows = rows();
                    s.chats = Arc::new(chats());
                    v.accept(s, w, cx);
                })
            })
            .unwrap();
            settle(cx, h);
            capture_state(
                cx,
                h,
                captures.as_deref(),
                width,
                mode,
                "populated-selected",
            );
            cx.update_window(h, |_, w, cx| {
                let view = v.read(cx);
                assert_eq!(view.page, Page::Inbox(None));
                assert_eq!(view.inbox.read(cx).probe(cx).0, 4);
                assert_eq!(view.inbox.read(cx).probe(cx).1, 1);
                assert!(w.try_find("attention-failed").is_some());
                let pane = w.find("inbox-page").bounds();
                let filter = w.find("inbox-project-filter").bounds();
                assert!(filter.origin.x >= pane.origin.x && filter.right() <= pane.right());
                assert!(
                    (f32::from(filter.size.width) - 220.).abs() <= 1.,
                    "visible control and mounted hit target must agree: {filter:?}"
                );
                w.click("inbox-project-filter", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                w.input("Boreal", cx);
            })
            .unwrap();
            settle(cx, h);
            if let Some(dir) = &captures {
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(dir.join(format!(
                        "{}-{}-before-confirm.png",
                        width as u32,
                        mode.name()
                    )))
                    .unwrap();
            }
            cx.update_window(h, |_, w, cx| {
                w.press("down", cx);
                w.press("enter", cx);
            })
            .unwrap();
            settle(cx, h);
            if let Some(dir) = &captures {
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(dir.join(format!(
                        "{}-{}-filter-search.png",
                        width as u32,
                        mode.name()
                    )))
                    .unwrap();
            }
            cx.update(|cx| {
                let view = v.read(cx);
                assert_eq!(
                    view.page,
                    Page::Inbox(Some("b".into())),
                    "native searchable project filter"
                );
                assert!(
                    view.project_scope.is_none(),
                    "Inbox filter is independent of sidebar scope"
                );
                assert_eq!(view.inbox.read(cx).probe(cx).0, 1);
                assert_eq!(view.inbox.read(cx).probe(cx).1, 1);
            });
            cx.update_window(h, |_, w, cx| w.press("secondary-[", cx))
                .unwrap();
            settle(cx, h);
            cx.update(|cx| assert_eq!(v.read(cx).page, Page::Inbox(None)));
            cx.update_window(h, |_, w, cx| w.press("secondary-]", cx))
                .unwrap();
            settle(cx, h);
            cx.update(|cx| assert_eq!(v.read(cx).page, Page::Inbox(Some("b".into()))));
            cx.update_window(h, |_, w, cx| w.click("nav-inbox", cx))
                .unwrap();
            settle(cx, h);
            cx.update(|cx| {
                assert_eq!(
                    v.read(cx).page,
                    Page::Inbox(None),
                    "fresh Inbox entry presets scope, not last filter"
                )
            });
            if let Some(dir) = &captures {
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(dir.join(format!("{}-{}.png", width as u32, mode.name())))
                    .unwrap();
            }
            cx.update_window(h, |_, w, cx| w.click("project-scope", cx))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| w.click("project-a", cx))
                .unwrap();
            settle(cx, h);
            cx.update(|cx| assert_eq!(v.read(cx).page, Page::Inbox(Some("a".into()))));
            assert!(reads.try_recv().is_err());
            assert!(writes.try_recv().is_err());
            cx.update_window(h, |_, w, cx| w.click("attention-synthetic", cx))
                .unwrap();
            settle(cx, h);
            cx.update(|cx| {
                let view = v.read(cx);
                assert_eq!(view.page, Page::Chat);
                assert_eq!(view.transcript.entity_id(), transcript);
                assert_eq!(view.state.cursor, Some(100));
                assert_eq!(
                    view.editor.read(cx).shell_probe().2.unwrap().text,
                    "Keep this draft 👩‍💻 e\u{301}"
                );
            });
            assert!(reads.try_recv().is_err(), "same owner reader is retained");
            cx.update_window(h, |_, w, cx| w.click("nav-back", cx))
                .unwrap();
            settle(cx, h);
            cx.update(|cx| {
                assert_eq!(v.read(cx).page, Page::Inbox(Some("a".into())));
                assert_eq!(
                    v.read(cx).inbox.read(cx).probe(cx).0,
                    3,
                    "opening never clears review/status evidence"
                )
            });
            cx.update_window(h, |_, w, cx| w.click("attention-failed", cx))
                .unwrap();
            settle(cx, h);
            assert!(matches!(reads.try_recv(),Ok(Command::Open{id,generation:11}) if id=="failed"));
            assert!(reads.try_recv().is_err());
            cx.update_window(h, |_, w, cx| {
                v.update(cx, |v, cx| {
                    let mut s = v.state.clone();
                    s.rows = rows();
                    s.generation = 11;
                    s.loaded = true;
                    v.accept(s, w, cx);
                });
                w.click("nav-back", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                v.update(cx, |v, cx| {
                    let mut s = v.state.clone();
                    s.rows = rows();
                    s.projects_error = Some("Synthetic catalog interrupted");
                    v.accept(s, w, cx);
                })
            })
            .unwrap();
            settle(cx, h);
            capture_state(cx, h, captures.as_deref(), width, mode, "projects-error");
            cx.update_window(h, |_, w, cx| {
                v.update(cx, |v, cx| {
                    let mut s = v.state.clone();
                    s.rows = rows();
                    s.projects = Arc::new(vec![s.projects[1].clone()]);
                    s.projects_error = Some("Synthetic catalog interrupted");
                    v.accept(s, w, cx);
                })
            })
            .unwrap();
            settle(cx, h);
            capture_state(cx, h, captures.as_deref(), width, mode, "missing-project");
            cx.update_window(h, |_, w, cx| {
                assert_eq!(v.read(cx).page, Page::Inbox(Some("a".into())));
                assert_eq!(v.read(cx).inbox.read(cx).probe(cx).0, 3);
                assert!(
                    w.try_find("attention-review").is_none(),
                    "missing project cannot broaden to All"
                );
                w.click("nav-home", cx);
            })
            .unwrap();
            settle(cx, h);
            let (syncs, renders) = cx.update(|cx| {
                (
                    v.read(cx).inbox.read(cx).probe(cx).3,
                    v.read(cx).transcript.read(cx).probe_render_count(),
                )
            });
            // Late confirmations from an unmounted page must not navigate.
            cx.update(|cx| {
                v.read(cx).inbox.clone().update(cx, |_, cx| {
                    cx.emit(crate::inbox::InboxEvent::Filter(Some("b".into())));
                    cx.emit(crate::inbox::InboxEvent::Chat("synthetic".into()));
                })
            });
            cx.update_window(h, |_, w, cx| {
                v.update(cx, |v, cx| {
                    for _ in 0..32 {
                        let mut s = v.state.clone();
                        s.rows = rows();
                        s.chats = Arc::new(chats());
                        v.accept(s, w, cx);
                    }
                })
            })
            .unwrap();
            settle(cx, h);
            cx.update(|cx| {
                assert_eq!(
                    v.read(cx).page,
                    Page::Home,
                    "hidden page events cannot steal navigation"
                );
                assert_eq!(
                    v.read(cx).inbox.read(cx).probe(cx).3,
                    syncs,
                    "no hidden Inbox projection work"
                );
                assert_eq!(
                    v.read(cx).transcript.read(cx).probe_render_count(),
                    renders,
                    "no hidden transcript rendering"
                );
            });
            assert!(reads.try_recv().is_err());
            assert!(
                writes.try_recv().is_err(),
                "Inbox cannot replay create/send/Stop/approval"
            );
            cx.update_window(h,|_,w,cx|v.update(cx,|v,cx|{
                v.state.projects_error = None;
                v.state.projects=Arc::new((0..256).map(|i|crate::local_model::Project{id:format!("p{i}"),name:format!("Project {i}"),path:"/synthetic/shared".into()}).collect());
                v.state.chats=Arc::new((0..1000).map(|i|crate::local_model::chat(&json!({"id":format!("capacity-{i}"),"title":format!("Attention {i}"),"projectId":format!("p{}",i%256),"state":"failed"})).unwrap()).collect());
                v.show_inbox(None,w,cx);
            })).unwrap();
            settle(cx, h);
            cx.update(|cx| {
                let p = v.read(cx).inbox.read(cx).probe(cx);
                assert_eq!(p.0, 1000);
                assert!(
                    p.2 > 0 && p.2 < 64,
                    "only virtualized visible corner entities: {p:?}"
                );
            });
            cx.update_window(h, |_, w, cx| {
                v.update(cx, |v, cx| {
                    v.state.chats = Arc::default();
                    v.state.list_loaded = false;
                    v.rebuild_nav(w, cx);
                })
            })
            .unwrap();
            settle(cx, h);
            cx.update(|cx| assert_eq!(v.read(cx).inbox.read(cx).probe(cx).0, 0));
            capture_state(cx, h, captures.as_deref(), width, mode, "loading");
            cx.update_window(h, |_, w, cx| {
                v.update(cx, |v, cx| {
                    v.state.list_loaded = true;
                    v.state.status = "Synthetic interrupted read".into();
                    v.rebuild_nav(w, cx);
                })
            })
            .unwrap();
            settle(cx, h);
            capture_state(cx, h, captures.as_deref(), width, mode, "empty");
            cx.update(|cx| {
                let p = v.read(cx).inbox.read(cx).probe(cx);
                assert_eq!((p.0, p.1, p.2), (0, 0, 0));
            });
            assert!(reads.try_recv().is_err());
            assert!(writes.try_recv().is_err());
            println!(
                "{}",
                json!({"width":width,"mode":mode.name(),"native_searchable_filter":true,"history_and_fresh_scope_preset":true,"same_owner_draft_reader_retained":true,"explicit_different_owner_reads":1,"canonical_write_commands":0,"no_auto_read_status_archive":true,"hidden_publications":32,"hidden_inbox_syncs":0,"capacity_chats":1000,"capacity_projects":256,"loading_empty_error_missing_scope":true,"native_offscreen":true})
            );
            cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
            cx.run_until_parked();
        }
    }
}
