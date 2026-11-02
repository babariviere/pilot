//! Actual hidden native knowledge window, owned faux Local GETs only. Not OS IME/AX,
//! performance or live-daemon acceptance.
use crate::{
    knowledge::{Kind, Query},
    knowledge_fixture as f,
    knowledge_view::{Knowledge, Screen},
    local_model::Project,
    mission_browser_fixture::{Reply, Server},
};
use gpui_kit::{
    AnyWindowHandle, AppContext, Bounds, Entity, HeadlessAppContext, WindowBounds, WindowOptions,
    component::{ActiveTheme, Theme, ThemeMode},
    px, size,
    test::TestWindowExt,
};
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

pub(crate) fn settle(cx: &mut HeadlessAppContext, h: AnyWindowHandle) {
    for _ in 0..3 {
        cx.run_until_parked();
        cx.advance_clock(Duration::from_millis(16));
        cx.update_window(h, |_, w, cx| {
            w.draw(cx).clear(cx);
        })
        .unwrap();
    }
}
pub(crate) fn until(cx: &mut HeadlessAppContext, h: AnyWindowHandle, v: &Entity<Knowledge>) {
    let end = Instant::now() + Duration::from_secs(8);
    while cx.update(|cx| v.read(cx).busy) {
        assert!(Instant::now() < end, "bounded synthetic knowledge response");
        settle(cx, h);
        std::thread::yield_now();
    }
    settle(cx, h);
}
pub(crate) fn open(
    cx: &mut HeadlessAppContext,
    server: &Server,
    width: f32,
    mode: ThemeMode,
    entry: Option<(String, Option<u64>)>,
) -> (AnyWindowHandle, Entity<Knowledge>) {
    let (h, v) = cx
        .update(|cx| {
            Theme::change(mode, None, cx);
            gpui_kit::open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                        Default::default(),
                        size(px(width), px(900.)),
                    ))),
                    show: false,
                    focus: false,
                    ..Default::default()
                },
                cx,
                |w, cx| {
                    let v = cx.new(|cx| {
                        Knowledge::new(
                            Some(server.options.clone()),
                            Project {
                                id: f::PROJECT.into(),
                                name: "Project knowledge 日本語 👩‍💻 and lasting engineering choices"
                                    .repeat(2),
                                path: "/synthetic/project-A".into(),
                                ..Default::default()
                            },
                            w,
                            cx,
                        )
                    });
                    v.update(cx, |v, cx| {
                        v.focus(w, cx);
                        match entry {
                            Some((id, revision)) => v.reveal(id, revision, w, cx),
                            None => v.load_list(w, cx),
                        }
                    });
                    v
                },
            )
        })
        .unwrap();
    cx.update_window(h, |_, w, cx| {
        Theme::change(mode, Some(w), cx);
        assert_eq!(cx.theme().is_dark(), mode == ThemeMode::Dark);
    })
    .unwrap();
    (h, v)
}
fn ids(cx: &mut HeadlessAppContext, v: &Entity<Knowledge>) -> Vec<String> {
    cx.update(|cx| {
        v.read(cx)
            .list
            .as_ref()
            .map(|l| l.entries.iter().map(|e| e.id.clone()).collect())
            .unwrap_or_default()
    })
}
fn reads(server: &Server) -> usize {
    server.state.lock().unwrap().seen.len()
}
fn capture(cx: &mut HeadlessAppContext, h: AnyWindowHandle, name: String) {
    if let Some(dir) = std::env::var_os("PILOT_NEXT_KNOWLEDGE_DIR") {
        let dir = std::path::PathBuf::from(dir);
        std::fs::create_dir_all(&dir).unwrap();
        cx.capture_screenshot(h)
            .unwrap()
            .save(dir.join(name))
            .unwrap();
    }
}

pub fn run_knowledge_probe(cx: &mut HeadlessAppContext) {
    let opened = Arc::new(Mutex::new(Vec::<String>::new()));
    let sink = opened.clone();
    cx.update(|cx| {
        cx.set_global(crate::external_links::Opener(Arc::new(move |url, _| {
            sink.lock().unwrap().push(url.to_owned())
        })))
    });
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            let server = Server::start();
            f::install(&server);
            let mut delayed = Reply::json(200, f::page(vec![f::component(), f::study()]));
            delayed.delay_ms = 400;
            server.reply(&f::list(Query::default()), delayed);
            let (h, v) = open(cx, &server, width, mode, None);
            settle(cx, h);
            cx.update_window(h, |_, w, _| {
                assert!(w.try_find("knowledge-loading").is_some());
                assert!(
                    w.try_find("knowledge-empty").is_none(),
                    "loading is not empty"
                );
            })
            .unwrap();
            // A newer filter supersedes the slow first read; its late reply is ignored.
            cx.update_window(h, |_, w, cx| w.click("knowledge-components", cx))
                .unwrap();
            until(cx, h, &v);
            assert_eq!(ids(cx, &v), vec![f::COMPONENT.to_owned()]);
            std::thread::sleep(Duration::from_millis(450));
            settle(cx, h);
            assert_eq!(
                ids(cx, &v),
                vec![f::COMPONENT.to_owned()],
                "stale reply fenced"
            );
            server.reply(
                &f::list(Query::default()),
                Reply::json(200, f::page(vec![f::component(), f::study()])),
            );
            cx.update_window(h, |_, w, cx| w.click("knowledge-all", cx))
                .unwrap();
            until(cx, h, &v);
            assert_eq!(ids(cx, &v).len(), 2);
            cx.update_window(h, |_, w, cx| w.click("knowledge-needs-check", cx))
                .unwrap();
            until(cx, h, &v);
            assert_eq!(ids(cx, &v), vec![f::COMPONENT.to_owned()]);
            assert!(cx.update(|cx| v.read(cx).query.needs_check));
            cx.update_window(h, |_, w, cx| w.click("knowledge-needs-check", cx))
                .unwrap();
            until(cx, h, &v);
            // Typing is a draft; Return applies one read and an empty result says so.
            let before = reads(&server);
            cx.update_window(h, |_, w, cx| {
                w.click("knowledge-search", cx);
                w.input("zzz", cx);
            })
            .unwrap();
            settle(cx, h);
            assert_eq!(reads(&server), before, "typing never reads");
            cx.update_window(h, |_, w, cx| w.press("enter", cx))
                .unwrap();
            until(cx, h, &v);
            cx.update_window(h, |_, w, _| {
                assert!(w.try_find("knowledge-empty").is_some());
                assert!(w.try_find("knowledge-search-clear").is_some());
            })
            .unwrap();
            cx.update_window(h, |_, w, cx| w.click("knowledge-search-clear", cx))
                .unwrap();
            until(cx, h, &v);
            assert_eq!(ids(cx, &v).len(), 2);
            capture(cx, h, format!("{}-{}-list.png", width as u32, mode.name()));
            // Keyboard reaches the row's open control and opens the readable entry.
            cx.update_window(h, |_, w, cx| {
                v.update(cx, |v, cx| v.focus(w, cx));
                for _ in 0..40 {
                    w.press("tab", cx);
                    if w.find(format!("knowledge-open-{}", f::COMPONENT)).focused() == Some(true) {
                        break;
                    }
                }
                assert_eq!(
                    w.find(format!("knowledge-open-{}", f::COMPONENT)).focused(),
                    Some(true)
                );
                w.press("enter", cx);
            })
            .unwrap();
            until(cx, h, &v);
            cx.update_window(h, |_, w, cx| {
                let k = v.read(cx);
                assert!(
                    matches!(&k.screen, Screen::Entry { id, revision: None } if id == f::COMPONENT)
                );
                let d = k.detail.as_ref().unwrap();
                assert!(d.freshness.needs_check() && !d.historical());
                assert!(w.find("knowledge-body").visible());
                assert!(w.find("knowledge-freshness").visible());
                assert!(w.try_find("knowledge-historical").is_none());
                assert!(
                    w.try_find("knowledge-provenance").is_none(),
                    "provenance is optional"
                );
                // Readable content comes before provenance controls.
                assert!(
                    w.find("knowledge-body").bounds().top()
                        < w.find("knowledge-entry-actions").bounds().top()
                );
                w.click("knowledge-sources", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(
                    w.try_find(("knowledge-source-open", 0usize)).is_none(),
                    "local file is unavailable, not opened"
                );
                assert!(w.try_find(("knowledge-source-open", 2usize)).is_none());
                w.click(("knowledge-source-open", 1usize), cx);
                w.click("knowledge-details", cx);
            })
            .unwrap();
            settle(cx, h);
            assert_eq!(
                opened.lock().unwrap().pop().as_deref(),
                Some("https://example.com/exploration")
            );
            cx.update_window(h, |_, w, _| {
                assert!(w.try_find("knowledge-provenance").is_some())
            })
            .unwrap();
            capture(cx, h, format!("{}-{}-entry.png", width as u32, mode.name()));
            // History opens an exact earlier revision, kept as written.
            cx.update_window(h, |_, w, cx| w.click("knowledge-history", cx))
                .unwrap();
            until(cx, h, &v);
            cx.update_window(h, |_, w, cx| w.click(("knowledge-open-revision", 1u64), cx))
                .unwrap();
            until(cx, h, &v);
            cx.update_window(h, |_, w, cx| {
                let d = v.read(cx).detail.as_ref().unwrap();
                assert!(d.historical());
                assert_eq!(d.revision.summary.revision, 1);
                assert_eq!(
                    d.freshness.state, "checked",
                    "a revision keeps its own check"
                );
                assert!(w.find("knowledge-historical").visible());
            })
            .unwrap();
            // Back returns to retained history and list without new reads; selection stays.
            let before = reads(&server);
            cx.update_window(h, |_, w, cx| w.click("knowledge-back", cx))
                .unwrap();
            settle(cx, h);
            assert!(matches!(
                cx.update(|cx| v.read(cx).screen.clone()),
                Screen::History { .. }
            ));
            assert_eq!(reads(&server), before);
            cx.update_window(h, |_, w, cx| w.click("knowledge-back", cx))
                .unwrap();
            until(cx, h, &v);
            assert!(!cx.update(|cx| v.read(cx).detail.as_ref().unwrap().historical()));
            let before = reads(&server);
            cx.update_window(h, |_, w, cx| w.click("knowledge-back", cx))
                .unwrap();
            settle(cx, h);
            assert_eq!(reads(&server), before, "retained list");
            cx.update_window(h, |_, w, cx| {
                assert_eq!(v.read(cx).screen, Screen::List);
                assert_eq!(v.read(cx).selected.as_deref(), Some(f::COMPONENT));
                assert!(w.try_find("knowledge-back").is_none());
                assert!(w.find(format!("knowledge-row-{}", f::COMPONENT)).visible());
            })
            .unwrap();
            // A failed refresh keeps the previous rows, labeled as such.
            server.reply(
                &f::list(Query::default()),
                Reply::json(503, serde_json::json!({})),
            );
            cx.update_window(h, |_, w, cx| w.click("knowledge-refresh", cx))
                .unwrap();
            until(cx, h, &v);
            cx.update_window(h, |_, w, _| {
                assert!(w.find("knowledge-error").visible());
                assert!(w.find("knowledge-retained").visible());
                assert!(w.find(format!("knowledge-row-{}", f::STUDY)).visible());
            })
            .unwrap();
            assert!(server.all_gets(), "knowledge reads are GET-only");
            cx.update_window(h, |_, w, cx| {
                v.update(cx, |v, cx| v.close(cx));
                w.remove_window();
            })
            .unwrap();
            let _ = Kind::Investigation;
        }
    }
    crate::mission_browser_view::knowledge_probe::run(cx);
    println!(
        "native knowledge: hidden production window and Mission Overview linked subset at 680/1100 light/dark; synthetic GET-only Local, not live daemon, OS IME/AX or performance acceptance"
    );
}
