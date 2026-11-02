//! Mission Overview's linked knowledge after archive, through the production Browser
//! and knowledge window. Synthetic GET-only Local.
use super::*;
use crate::{
    knowledge_fixture as kf,
    knowledge_probe::{open, settle, until},
    mission_browser_fixture::{self as f, Reply, Server},
};
use gpui_kit::{
    Bounds, HeadlessAppContext, WindowBounds, WindowOptions,
    component::{Theme, ThemeMode},
    size,
    test::TestWindowExt,
};
use std::time::{Duration, Instant};

fn input(id: &str) -> Input {
    Input {
        route: Some(Route::Detail(f::key(id))),
        filter: None,
        projects: Arc::new(vec![]),
        chats: Arc::new(vec![]),
        online: true,
        loaded: true,
    }
}
fn loaded(
    cx: &mut HeadlessAppContext,
    h: gpui_kit::AnyWindowHandle,
    v: &gpui_kit::Entity<Browser>,
    id: &str,
) {
    let end = Instant::now() + Duration::from_secs(10);
    while !cx.update(|cx| {
        let b = v.read(cx);
        !b.busy && b.detail.as_ref().is_some_and(|d| d.key.id == id)
    }) {
        assert!(Instant::now() < end, "bounded mission read");
        settle(cx, h);
        std::thread::yield_now();
    }
    settle(cx, h);
}

pub(crate) fn run(cx: &mut HeadlessAppContext) {
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            let server = Server::start();
            kf::install(&server);
            let mut archived = f::detail("mission-A");
            archived["mission"]["status"] = serde_json::json!("archived");
            server.reply("/api/missions/mission-A", Reply::json(200, archived));
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
                            let v = cx.new(Browser::new);
                            v.update(cx, |v, cx| {
                                v.options(server.options.clone());
                                v.catalog = Some(Arc::new(
                                    crate::mission_browser::catalog(&f::catalog()).unwrap(),
                                ));
                                v.sync(input("mission-A"), w, cx);
                            });
                            v
                        },
                    )
                })
                .unwrap();
            cx.update_window(h, |_, w, cx| Theme::change(mode, Some(w), cx))
                .unwrap();
            let events = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
            let sink = events.clone();
            let _subscription = cx.update(|cx| {
                cx.subscribe(&v, move |_, e: &Event, _| {
                    if let Event::Knowledge { project, entry, .. } = e {
                        sink.borrow_mut().push((project.clone(), entry.clone()));
                    }
                })
            });
            loaded(cx, h, &v, "mission-A");
            if let Some(dir) = std::env::var_os("PILOT_NEXT_KNOWLEDGE_DIR") {
                let dir = std::path::PathBuf::from(dir);
                std::fs::create_dir_all(&dir).unwrap();
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(dir.join(format!("{}-{}-mission.png", width as u32, mode.name())))
                    .unwrap();
            }
            // The archived mission still shows the same project entries it links.
            cx.update_window(h, |_, w, cx| {
                let d = v.read(cx).detail.clone().unwrap();
                assert_eq!(d.status, "archived");
                assert_eq!(
                    d.knowledge
                        .as_ref()
                        .unwrap()
                        .as_ref()
                        .unwrap()
                        .entries
                        .len(),
                    2
                );
                assert!(w.find("mission-knowledge").visible());
                assert!(
                    w.find(format!("mission-knowledge-row-{}", kf::COMPONENT))
                        .visible()
                );
                w.click(format!("mission-knowledge-open-{}", kf::COMPONENT), cx);
            })
            .unwrap();
            settle(cx, h);
            assert_eq!(
                events.borrow_mut().pop(),
                Some((
                    kf::PROJECT.to_owned(),
                    Some((kf::COMPONENT.to_owned(), Some(1)))
                ))
            );
            cx.update_window(h, |_, w, cx| w.click("mission-knowledge-all", cx))
                .unwrap();
            settle(cx, h);
            assert_eq!(
                events.borrow_mut().pop(),
                Some((kf::PROJECT.to_owned(), None))
            );
            // The pinned revision opens exactly; its history is readable after archive.
            let (kh, k) = open(
                cx,
                &server,
                width,
                mode,
                Some((kf::COMPONENT.into(), Some(1))),
            );
            until(cx, kh, &k);
            cx.update_window(kh, |_, w, cx| {
                let d = k.read(cx).detail.as_ref().unwrap();
                assert_eq!(d.revision.summary.revision, 1);
                assert!(w.find("knowledge-historical").visible());
                assert!(w.find("knowledge-body").visible());
                w.click("knowledge-history", cx);
            })
            .unwrap();
            until(cx, kh, &k);
            cx.update_window(kh, |_, _, cx| {
                assert_eq!(k.read(cx).history.as_ref().unwrap().1.revisions.len(), 2);
            })
            .unwrap();
            cx.update_window(kh, |_, w, _| w.remove_window()).unwrap();
            // A daemon without the catalog shows no section, not an empty claim.
            cx.update_window(h, |_, w, cx| {
                v.update(cx, |v, cx| v.sync(input("mission-B"), w, cx))
            })
            .unwrap();
            loaded(cx, h, &v, "mission-B");
            cx.update_window(h, |_, w, cx| {
                assert!(
                    v.read(cx)
                        .detail
                        .as_ref()
                        .unwrap()
                        .knowledge
                        .as_ref()
                        .unwrap()
                        .is_none()
                );
                assert!(w.try_find("mission-knowledge").is_none());
            })
            .unwrap();
            assert!(server.all_gets());
            cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
        }
    }
}
