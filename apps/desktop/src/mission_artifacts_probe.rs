//! Real hidden GPUI input, production readers, faux GET-only loopback endpoints.
use super::*;
use crate::mission_browser_fixture::{self as f, Reply, Server};
use gpui_kit::{
    AnyWindowHandle, Bounds, HeadlessAppContext, ScrollDelta, WindowBounds, WindowOptions,
    component::{Theme, ThemeMode},
    point, size,
    test::TestWindowExt,
};
use serde_json::{Value, json};
use std::time::{Duration, Instant};
const PNG: &str = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAEElEQVR4AQEFAPr/AP8AAP8FAAH/+lyI0QAAAABJRU5ErkJggg==";
const SOURCE: &str = "<script>Never execute</script>\n  literal 日本語 👩‍💻  \n";
fn frame(cx: &mut HeadlessAppContext, h: AnyWindowHandle) {
    for _ in 0..4 {
        cx.run_until_parked();
        cx.advance_clock(Duration::from_millis(16));
        cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
    }
}
fn until(
    cx: &mut HeadlessAppContext,
    h: AnyWindowHandle,
    v: &Entity<Browser>,
    ready: impl Fn(&Browser, &App) -> bool,
) {
    let deadline = Instant::now() + Duration::from_secs(15);
    while !cx.update(|cx| ready(v.read(cx), cx)) {
        assert!(Instant::now() < deadline, "bounded artifact reader wait");
        frame(cx, h);
        std::thread::yield_now();
    }
    frame(cx, h);
}
fn body(id: &str, revision: u32, kind: &str, source: &str) -> Value {
    json!({"id":id,"sessionId":"owner","title":format!("Stored {id} 日本語 👩‍💻"),"revision":revision,"kind":kind,"source":source,"createdAt":123,"updatedAt":456,"data":{},"visual":{"api":1,"engine":"quickjs-ng 0.17.0"}})
}
fn path(id: &str, revision: u32) -> String {
    format!("/api/sessions/owner/artifacts/{id}?revision={revision}")
}
fn detail() -> Value {
    let mut d = f::detail("mission-A");
    let pin = |id, revision, kind| json!({"artifactId":id,"sessionId":"owner","title":format!("Pinned {id} 日本語 👩‍💻"),"revision":revision,"kind":kind,"linkedAt":1});
    let mut older = pin("image", 4, "html");
    older["taskId"] = json!("task-A");
    let mut loose = pin("loose", 1, "visual");
    loose.as_object_mut().unwrap().remove("revision");
    d["artifacts"] = json!([
        older,
        pin("image", 5, "image"),
        pin("legacy", 2, "html"),
        pin("visual", 2, "visual"),
        pin("missing", 3, "image"),
        pin("changed", 1, "image"),
        loose
    ]);
    d
}
fn input(id: &str, online: bool) -> Input {
    Input {
        route: Some(Route::Detail(f::key(id))),
        filter: None,
        projects: Arc::new(vec![]),
        chats: Arc::new(vec![]),
        online,
        loaded: true,
    }
}
fn loaded(v: &Browser, cx: &App) -> bool {
    v.artifacts.reader.as_ref().is_some_and(|p| {
        let p = p.read(cx);
        p.inline_probe_idle() && {
            let s = p.inline_probe_snapshot();
            s.revision.is_some() || s.error.is_some()
        }
    })
}
fn capture(cx: &mut HeadlessAppContext, h: AnyWindowHandle, name: String) {
    if let Some(dir) = std::env::var_os("PILOT_NEXT_MISSION_ARTIFACTS_DIR") {
        let dir = std::path::PathBuf::from(dir);
        std::fs::create_dir_all(&dir).unwrap();
        cx.capture_screenshot(h)
            .unwrap()
            .save(dir.join(name))
            .unwrap();
    }
}
pub fn run_mission_artifacts_probe(cx: &mut HeadlessAppContext) {
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            let server = Server::start();
            let d = detail();
            server.reply("/api/missions/mission-A", Reply::json(200, d.clone()));
            let mut ambiguous = f::detail("mission-B");
            ambiguous["artifacts"] = json!([d["artifacts"][1], d["artifacts"][1]]);
            server.reply("/api/missions/mission-B", Reply::json(200, ambiguous));
            server.reply(
                &path("image", 5),
                Reply::json(200, body("image", 5, "image", PNG)),
            );
            server.reply(
                &path("legacy", 2),
                Reply::json(200, body("legacy", 2, "html", SOURCE)),
            );
            server.reply(
                &path("visual", 2),
                Reply::json(
                    200,
                    body(
                        "visual",
                        2,
                        "visual",
                        "({ui}) => ui.text('Exact native pin')",
                    ),
                ),
            );
            server.reply(
                &path("changed", 1),
                Reply::json(200, body("changed", 1, "html", SOURCE)),
            );
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
                            let v = cx.new(Browser::new);
                            v.update(cx, |v, cx| {
                                v.options(server.options.clone());
                                v.catalog = Some(Arc::new(
                                    crate::mission_browser::catalog(&f::catalog()).unwrap(),
                                ));
                                v.sync(input("mission-A", true), w, cx);
                            });
                            v
                        },
                    )
                })
                .unwrap();
            cx.update_window(h, |_, w, cx| {
                Theme::change(mode, Some(w), cx);
                w.activate_window();
                v.read(cx).focus.clone().focus(w, cx);
            })
            .unwrap();
            until(cx, h, &v, |v, _| v.detail.is_some() && !v.busy);
            frame(cx, h);
            let before = server.state.lock().unwrap().seen.len();
            // Navigate from the actual overview button using Tab/Enter.
            cx.update_window(h, |_, w, cx| {
                for _ in 0..50 {
                    w.press("tab", cx);
                    if w.find("mission-artifacts-open").focused() == Some(true) {
                        break;
                    }
                }
                assert_eq!(w.find("mission-artifacts-open").focused(), Some(true));
                let b = w.find("mission-artifacts-open").bounds();
                w.scroll(
                    "missions-page",
                    ScrollDelta::Pixels(point(px(0.), px(240.) - b.top())),
                    cx,
                );
            })
            .unwrap();
            frame(cx, h);
            cx.update_window(h, |_, w, cx| w.press("enter", cx))
                .unwrap();
            frame(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(v.read(cx).artifacts.open);
                assert_eq!(v.read(cx).artifact_links().unwrap().len(), 6);
                assert_eq!(
                    server.state.lock().unwrap().seen.len(),
                    before,
                    "browsing links does not read bodies"
                );
                let list = w.find("mission-artifacts-list").bounds();
                assert!(list.size.width > px(300.));
                for row in v.read(cx).artifact_links().unwrap().iter() {
                    let id = format!("mission-artifact-{}", row.key);
                    let button = w.find(id.clone()).bounds();
                    let detail = w.within(id).find("resource-detail").bounds();
                    let heading = w.find("mission-artifacts-title").bounds();
                    assert!(
                        (detail.left() - heading.left()).abs() <= px(Space::CONTROL * 2.),
                        "list/header reading column: {detail:?} {heading:?}"
                    );
                    assert!(
                        detail.bottom() <= button.bottom(),
                        "two-line metadata must fit: {detail:?} {button:?}"
                    );
                    assert!(
                        button.size.height > px(36.),
                        "resource rows size from both lines"
                    );
                }
                w.press("enter", cx);
            })
            .unwrap();
            until(cx, h, &v, loaded);
            cx.update_window(h, |_, w, cx| {
                let p = v.read(cx).artifacts.reader.as_ref().unwrap().read(cx);
                assert!(p.inline_probe_snapshot().raster.is_some());
                assert_eq!(
                    p.inline_probe_snapshot()
                        .revision
                        .unwrap()
                        .reference
                        .revision,
                    5
                );
                assert!(
                    w.try_find("artifact-previous").is_none(),
                    "no unlinked revision stepping"
                );
                w.click("artifact-source", cx);
            })
            .unwrap();
            frame(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(w.find("artifact-pin-provenance").visible());
                w.click("artifact-copy-source", cx);
            })
            .unwrap();
            until(cx, h, &v, |_, cx| {
                cx.read_from_clipboard().and_then(|c| c.text()).as_deref() == Some(PNG)
            });
            capture(
                cx,
                h,
                format!("{}-{}-image-source.png", width as u32, mode.name()),
            );
            // Back returns to the retained list. Escape does the same from the next reader.
            cx.update_window(h, |_, w, cx| w.click("artifact-back", cx))
                .unwrap();
            frame(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(!v.read(cx).artifacts.reading);
                w.press("down", cx);
                w.press("enter", cx);
            })
            .unwrap();
            until(cx, h, &v, loaded);
            cx.update_window(h, |_, w, cx| {
                assert!(w.find("artifact-unsupported").visible());
                assert!(w.try_find("artifact-previous").is_none());
                // View source is reachable by real keyboard focus, not only pointer.
                v.read(cx).focus.clone().focus(w, cx);
                for _ in 0..30 {
                    w.press("tab", cx);
                    if w.find("artifact-view-source").focused() == Some(true) {
                        break;
                    }
                }
                assert_eq!(w.find("artifact-view-source").focused(), Some(true));
                w.press("enter", cx);
            })
            .unwrap();
            frame(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(w.find("artifact-source-text").visible());
                w.click("artifact-copy-source", cx);
            })
            .unwrap();
            frame(cx, h);
            cx.update(|cx| assert_eq!(cx.read_from_clipboard().unwrap().text().unwrap(), SOURCE));
            cx.update_window(h, |_, w, cx| {
                let b = w.find("artifact-source-text").bounds();
                let from = point(b.left() + px(1.), b.top() + px(8.));
                w.drag(from, from + point(px(60.), px(0.)), cx);
                w.press("secondary-c", cx);
                let text = cx.read_from_clipboard().unwrap().text().unwrap();
                assert!(
                    !text.is_empty() && SOURCE.contains(&text),
                    "literal source selection: {text:?}"
                );
            })
            .unwrap();
            capture(
                cx,
                h,
                format!("{}-{}-legacy-source.png", width as u32, mode.name()),
            );
            cx.update_window(h, |_, w, cx| {
                w.press("escape", cx);
            })
            .unwrap();
            frame(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(!v.read(cx).artifacts.reading);
                w.press("down", cx);
                w.press("enter", cx);
            })
            .unwrap();
            until(cx, h, &v, loaded);
            cx.update(|cx| {
                assert!(
                    v.read(cx)
                        .artifacts
                        .reader
                        .as_ref()
                        .unwrap()
                        .read(cx)
                        .inline_probe_snapshot()
                        .scene
                        .is_some(),
                    "existing native visual runtime"
                )
            });
            capture(
                cx,
                h,
                format!("{}-{}-visual.png", width as u32, mode.name()),
            );
            for expected in ["missing", "changed"] {
                cx.update_window(h, |_, w, cx| w.press("escape", cx))
                    .unwrap();
                frame(cx, h);
                cx.update_window(h, |_, w, cx| {
                    w.press("down", cx);
                    w.press("enter", cx);
                })
                .unwrap();
                until(cx, h, &v, loaded);
                cx.update(|cx| {
                    let p = v.read(cx).artifacts.reader.as_ref().unwrap().read(cx);
                    let s = p.inline_probe_snapshot();
                    assert!(s.error.is_some(), "{expected}");
                    assert!(
                        s.revision.is_none(),
                        "never substitute a body with another kind/revision"
                    );
                });
            }
            cx.update_window(h, |_, w, cx| w.press("escape", cx))
                .unwrap();
            frame(cx, h);
            let reads = server.state.lock().unwrap().seen.len();
            cx.update_window(h, |_, w, cx| {
                w.press("down", cx);
                w.press("enter", cx);
            })
            .unwrap();
            frame(cx, h);
            assert_eq!(
                server.state.lock().unwrap().seen.len(),
                reads,
                "unpinned link never opens latest"
            );
            capture(cx, h, format!("{}-{}-list.png", width as u32, mode.name()));
            // Held read, switch to a different pin, then mission A→B→A. No late source leaks.
            let mut held = Reply::json(200, body("legacy", 2, "html", "late old source"));
            held.delay_ms = 400;
            server.reply(&path("legacy", 2), held);
            let count = server
                .state
                .lock()
                .unwrap()
                .seen
                .iter()
                .filter(|(_, p)| p == &path("legacy", 2))
                .count();
            cx.update_window(h, |_, w, cx| {
                v.update(cx, |v, cx| {
                    let r = v.artifact_links().unwrap()[1].reference.clone().unwrap();
                    v.open_mission_pin(r, v.generation, w, cx);
                })
            })
            .unwrap();
            until(cx, h, &v, |_, _| {
                server
                    .state
                    .lock()
                    .unwrap()
                    .seen
                    .iter()
                    .filter(|(_, p)| p == &path("legacy", 2))
                    .count()
                    > count
            });
            cx.update_window(h, |_, w, cx| {
                w.press("escape", cx);
            })
            .unwrap();
            frame(cx, h);
            cx.update_window(h, |_, w, cx| {
                v.update(cx, |v, cx| {
                    let r = v.artifact_links().unwrap()[0].reference.clone().unwrap();
                    v.open_mission_pin(r, v.generation, w, cx);
                })
            })
            .unwrap();
            until(cx, h, &v, loaded);
            let late = Instant::now() + Duration::from_millis(500);
            until(cx, h, &v, |_, _| Instant::now() >= late);
            cx.update(|cx| {
                assert_eq!(
                    v.read(cx)
                        .artifacts
                        .reader
                        .as_ref()
                        .unwrap()
                        .read(cx)
                        .inline_probe_snapshot()
                        .revision
                        .unwrap()
                        .reference
                        .id,
                    "image"
                )
            });
            cx.update_window(h, |_, w, cx| {
                v.update(cx, |v, cx| v.sync(input("mission-B", true), w, cx))
            })
            .unwrap();
            until(cx, h, &v, |v, _| {
                !v.busy && v.detail.as_ref().is_some_and(|d| d.key.id == "mission-B")
            });
            cx.update_window(h, |_, w, cx| {
                assert!(v.read(cx).detail.as_ref().unwrap().artifacts.is_err());
                assert_eq!(w.find("mission-artifacts-open").disabled(), Some(true));
            })
            .unwrap();
            cx.update_window(h, |_, w, cx| {
                v.update(cx, |v, cx| v.sync(input("mission-A", true), w, cx))
            })
            .unwrap();
            until(cx, h, &v, |v, _| {
                !v.busy && v.detail.as_ref().is_some_and(|d| d.key.id == "mission-A")
            });
            cx.update_window(h, |_, w, cx| {
                v.update(cx, |v, cx| {
                    v.open_mission_artifacts(v.generation, w, cx);
                    v.sync(input("mission-A", false), w, cx);
                })
            })
            .unwrap();
            frame(cx, h);
            let reads = server.state.lock().unwrap().seen.len();
            cx.update_window(h, |_, w, cx| w.press("enter", cx))
                .unwrap();
            frame(cx, h);
            assert_eq!(
                server.state.lock().unwrap().seen.len(),
                reads,
                "offline retained links are not fresh reads"
            );
            cx.update_window(h, |_, w, cx| {
                w.press("escape", cx);
                assert!(!v.read(cx).artifacts.open);
                w.remove_window();
            })
            .unwrap();
            cx.run_until_parked();
            assert!(server.all_gets());
            let seen = server.state.lock().unwrap();
            for (_, p) in &seen.seen {
                assert!(
                    p == "/api/hello"
                        || p.starts_with("/api/missions/")
                        || p.starts_with("/api/sessions?archived=all&missionId=")
                        || [
                            path("image", 5),
                            path("legacy", 2),
                            path("visual", 2),
                            path("missing", 3),
                            path("changed", 1)
                        ]
                        .contains(p),
                    "unapproved route {p}"
                );
            }
            println!(
                "mission artifacts: hidden {} {} exact pin, source Copy, keyboard/Back/Escape, refusal/switch/offline passed",
                width,
                mode.name()
            );
        }
    }
}
