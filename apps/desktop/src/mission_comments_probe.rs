//! Offscreen production Browser over a GET-only synthetic mission detail.
use super::*;
use crate::mission_browser_fixture::{self as f, Reply, Server};
use gpui_kit::{
    AnyWindowHandle, Bounds, Entity, EntityInputHandler, HeadlessAppContext, ScrollDelta,
    WindowBounds, WindowOptions,
    component::{ActiveTheme, Theme, ThemeMode},
    point, size,
    test::TestWindowExt,
};
use serde_json::{Value, json};
use std::time::{Duration, Instant};
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
    v: &Entity<Browser>,
    f: impl Fn(&Browser) -> bool,
) {
    let deadline = Instant::now() + Duration::from_secs(12);
    while !cx.update(|cx| f(v.read(cx))) {
        assert!(Instant::now() < deadline, "bounded reader wait");
        settle(cx, h);
        std::thread::yield_now();
    }
    settle(cx, h);
}
/// Wheel the overview until the element is comfortably in view.
fn reveal(cx: &mut HeadlessAppContext, h: AnyWindowHandle, id: &str) {
    for _ in 0..8 {
        let visible = cx
            .update_window(h, |_, w, cx| {
                let b = w.find(id.to_owned()).bounds();
                if b.top() >= px(20.) && b.bottom() <= w.viewport_size().height - px(20.) {
                    return true;
                }
                w.scroll(
                    "missions-page",
                    ScrollDelta::Pixels(point(px(0.), px(240.) - b.top())),
                    cx,
                );
                false
            })
            .unwrap();
        settle(cx, h);
        if visible {
            return;
        }
    }
    panic!("cannot reveal {id}");
}
fn capture(cx: &mut HeadlessAppContext, h: AnyWindowHandle, name: String) {
    if let Some(dir) = std::env::var_os("PILOT_NEXT_COMMENTS_DIR") {
        let dir = std::path::PathBuf::from(dir);
        std::fs::create_dir_all(&dir).unwrap();
        cx.capture_screenshot(h)
            .unwrap()
            .save(dir.join(name))
            .unwrap();
    }
}
fn input(route: &str, online: bool, chats: &Arc<Vec<Chat>>) -> Input {
    Input {
        route: Some(Route::Detail(f::key(route))),
        filter: None,
        projects: Arc::new(vec![]),
        chats: chats.clone(),
        online,
        loaded: true,
    }
}
const LONG: &str = "Which region should the canary use? 日本語の長い質問 👩‍💻 é. ";
/// The user coordinates mission-A: 40 open agent comments to nobody need them,
/// beside a quoted, a targeted, a user-written and two resolved comments.
fn detail() -> Value {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    // Minutes ago, oldest first.
    let at = |i: u64| now - (60 - i) * 60_000;
    let mut v = f::detail("mission-A");
    v["mission"]["coordinatorSessionId"] = json!(null);
    let mut c: Vec<Value> = (1..=40)
        .map(|i: u64| json!({"id":format!("c{i}"),"text":format!("Agent question {i}\nSecond line {i}"),"authorSessionId":"chat-B","createdAt":at(i)}))
        .collect();
    c[6]["text"] = json!(format!("{}\n\nEnd of question 7 終わり", LONG.repeat(12)));
    c.push(json!({"id":"quoted","text":"Is this sentence still current?","anchor":"Keep the existing chat and its draft. 私の目標","revision":1,"authorSessionId":"chat-B","targetSessionId":"chat-A","createdAt":at(41)}));
    c.push(json!({"id":"mine","text":"My own note to the team","createdAt":at(42)}));
    c.push(json!({"id":"done-1","text":"Resolved by the coordinator","authorSessionId":"chat-B","createdAt":at(1),"resolvedAt":at(50),"resolvedBySessionId":"chat-A"}));
    c.push(json!({"id":"done-2","text":"Resolved by the user","authorSessionId":"chat-B","createdAt":at(2),"resolvedAt":at(49)}));
    v["comments"] = json!(c);
    v
}
fn text_of(b: &Browser, id: &str) -> String {
    b.detail
        .as_ref()
        .unwrap()
        .comments
        .as_ref()
        .unwrap()
        .as_ref()
        .unwrap()
        .iter()
        .find(|c| c.id == id)
        .unwrap()
        .text
        .clone()
}
fn top_id(b: &Browser) -> String {
    b.comments.ids[b.comments.list.logical_scroll_top().item_ix].clone()
}
pub fn run_mission_comments_probe(cx: &mut HeadlessAppContext) {
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            let server = Server::start();
            let mut d = detail();
            server.reply("/api/missions/mission-A", Reply::json(200, d.clone()));
            let chats: Arc<Vec<Chat>> = Arc::new(
                [("chat-A", "Coordinator chat"), ("chat-B", "Planner 計画 with a long title")]
                    .iter()
                    .map(|(id, title)| crate::local_model::chat(&json!({"id":id,"title":title,"projectId":"project-A","cwd":"/synthetic/A","mode":"ask","state":"idle"})).unwrap())
                    .collect(),
            );
            let (h, view) = cx
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
                            let view = cx.new(Browser::new);
                            view.update(cx, |v, cx| {
                                v.options(server.options.clone());
                                v.catalog = Some(Arc::new(
                                    crate::mission_browser::catalog(&f::catalog()).unwrap(),
                                ));
                                v.sync(input("mission-A", true, &chats), w, cx);
                            });
                            view
                        },
                    )
                })
                .unwrap();
            cx.update_window(h, |_, w, cx| Theme::change(mode, Some(w), cx))
                .unwrap();
            until(cx, h, &view, |v| v.detail.is_some() && !v.busy);
            let requests = server.state.lock().unwrap().seen.len();
            let name = |s: &str| format!("{}-{}-{s}.png", width as u32, mode.name());
            // Overview: five comments, the remainder, and the Comments line.
            cx.update_window(h, |_, w, cx| {
                assert_eq!(cx.theme().mode, mode);
                for i in 1..=5 {
                    assert!(w.try_find(format!("mission-needs-comment-c{i}")).is_some());
                }
                assert!(w.try_find("mission-needs-comment-c6").is_none());
                assert_eq!(
                    w.find("mission-needs-comments-more").label(),
                    Some("35 more comments")
                );
                assert!(w.find("mission-comments-count").visible());
            })
            .unwrap();
            reveal(cx, h, "mission-needs-comment-c1");
            capture(cx, h, name("overview"));
            // The remainder opens Comments on the first unlisted comment, by keyboard.
            reveal(cx, h, "mission-needs-comments-more");
            let overview_offset = cx
                .update_window(h, |_, w, cx| {
                    let focus = view.read(cx).focus.clone();
                    focus.focus(w, cx);
                    for _ in 0..80 {
                        w.press("tab", cx);
                        if w.find("mission-needs-comments-more").focused() == Some(true) {
                            break;
                        }
                    }
                    assert_eq!(w.find("mission-needs-comments-more").focused(), Some(true));
                    let offset = view.read(cx).detail_scroll.offset();
                    w.press("enter", cx);
                    offset
                })
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                let b = view.read(cx);
                assert!(b.comments.open);
                assert_eq!(b.comments.selected.as_deref(), Some("c6"));
                assert_eq!(top_id(b), "c6");
                let list = w.find("mission-comments-list").bounds();
                let row = w.find("comment-c6").bounds();
                assert!((row.top() - list.top()).abs() < px(1.), "{row:?} {list:?}");
                assert!(
                    w.try_find("comment-c1").is_none(),
                    "virtual: off-screen rows unmounted"
                );
                assert!(w.find("comments-coverage").visible());
            })
            .unwrap();
            capture(cx, h, name("comments"));
            // Down selects the long Unicode comment; Copy copies it exactly.
            cx.update_window(h, |_, w, cx| {
                w.press("down", cx);
                w.press("secondary-c", cx);
                assert_eq!(view.read(cx).comments.selected.as_deref(), Some("c7"));
                assert_eq!(
                    cx.read_from_clipboard().unwrap().text().unwrap(),
                    text_of(view.read(cx), "c7")
                );
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, _| {
                let list = w.find("mission-comments-list").bounds();
                let tag = format!("{}-c7", f::key("mission-A").tag());
                let body = w.find(format!("comment-body-{tag}")).bounds();
                assert!(body.right() <= list.right() && body.left() >= list.left());
                assert!(body.size.height > px(60.), "long text wraps: {body:?}");
                assert!(list.bottom() <= w.viewport_size().height + px(1.));
                // Rows share the header's reading column at every width.
                let heading = w.find("comments-heading").bounds();
                assert!(
                    (body.left() - heading.left()).abs() < px(1.),
                    "{body:?} {heading:?}"
                );
            })
            .unwrap();
            // A real drag selection copies the selected text, not the row.
            cx.update_window(h, |_, w, cx| {
                let tag = format!("{}-c6", f::key("mission-A").tag());
                let b = w.find(format!("comment-body-{tag}")).bounds();
                let from = point(b.left() + px(1.), b.top() + px(8.));
                w.drag(from, from + point(px(60.), px(0.)), cx);
                w.press("secondary-c", cx);
                let copied = cx.read_from_clipboard().unwrap().text().unwrap();
                assert!(
                    !copied.is_empty() && "Agent question 6".starts_with(&copied),
                    "{copied:?}"
                );
            })
            .unwrap();
            // The row's Copy action is a keyboard stop that copies the exact text.
            cx.update_window(h, |_, w, cx| {
                let focus = view.read(cx).focus.clone();
                focus.focus(w, cx);
                for id in ["comments-back", "comments-refresh", "comment-copy-c6"] {
                    w.press("tab", cx);
                    assert_eq!(w.find(id).focused(), Some(true), "Tab reaches {id}");
                }
                assert_eq!(w.find("comment-copy-c6").label(), Some("Copy comment"));
                w.press("enter", cx);
                assert_eq!(
                    cx.read_from_clipboard().unwrap().text().unwrap(),
                    "Agent question 6\nSecond line 6"
                );
            })
            .unwrap();
            // Wheel through the virtual list to the quote, targets and resolved rows.
            for _ in 0..40 {
                if cx
                    .update_window(h, |_, w, _| w.try_find("comment-done-2").is_some())
                    .unwrap()
                {
                    break;
                }
                cx.update_window(h, |_, w, cx| {
                    w.scroll(
                        "mission-comments-list",
                        ScrollDelta::Pixels(point(px(0.), px(-400.))),
                        cx,
                    )
                })
                .unwrap();
                settle(cx, h);
            }
            cx.update_window(h, |_, w, _| {
                let tag = |id: &str| format!("{}-{id}", f::key("mission-A").tag());
                assert!(w.find(format!("comment-quote-{}", tag("quoted"))).visible());
                assert!(w.find("comment-state-done-1").visible());
                assert!(w.try_find("comment-state-done-2").is_some());
                assert!(
                    w.try_find("comment-state-mine").is_none(),
                    "open rows read as open"
                );
            })
            .unwrap();
            capture(cx, h, name("comments-end"));
            // Back keeps the overview where it was; a Needs you row opens its comment.
            cx.update_window(h, |_, w, cx| w.click("comments-back", cx))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(!view.read(cx).comments.open);
                assert_eq!(view.read(cx).detail_scroll.offset(), overview_offset);
                assert!(w.find("mission-needs-comment-c3").visible());
                w.click("mission-needs-comment-c3", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update(|cx| {
                let b = view.read(cx);
                assert!(b.comments.open && top_id(b) == "c3");
                assert_eq!(b.comments.selected.as_deref(), Some("c3"));
            });
            assert_eq!(
                server.state.lock().unwrap().seen.len(),
                requests,
                "reads the retained detail"
            );
            // Refresh keeps the reading position and selection on the same comment IDs.
            d["comments"].as_array_mut().unwrap().insert(0, json!({"id":"c0","text":"A newer first comment","authorSessionId":"chat-B","createdAt":0}));
            server.reply("/api/missions/mission-A", Reply::json(200, d.clone()));
            cx.update_window(h, |_, w, cx| w.click("comments-refresh", cx))
                .unwrap();
            until(cx, h, &view, |v| !v.busy);
            cx.update_window(h, |_, w, cx| {
                let b = view.read(cx);
                assert!(b.comments.open && b.comments.ids[0] == "c0");
                assert_eq!(top_id(b), "c3");
                assert_eq!(b.comments.selected.as_deref(), Some("c3"));
                assert!(w.try_find("comments-stale").is_none());
            })
            .unwrap();
            // A failed refresh and going offline keep the retained snapshot, marked stale.
            server.reply("/api/missions/mission-A", Reply::json(503, json!({})));
            cx.update_window(h, |_, w, cx| w.click("comments-refresh", cx))
                .unwrap();
            until(cx, h, &view, |v| v.error.is_some() && !v.busy);
            cx.update_window(h, |_, w, cx| {
                assert!(w.find("comments-stale").visible());
                assert!(w.find("comments-read-error").visible());
                assert!(w.find("comment-c3").visible());
                view.update(cx, |v, cx| v.sync(input("mission-A", false, &chats), w, cx));
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(view.read(cx).comments.open);
                assert!(w.find("comments-stale").visible() && w.find("comment-c3").visible());
                view.update(cx, |v, cx| v.sync(input("mission-A", true, &chats), w, cx));
            })
            .unwrap();
            capture(cx, h, name("comments-stale"));
            // Malformed comments are an error; an absent field is unknown, not empty.
            let mut bad = d.clone();
            bad["comments"] = json!({});
            server.reply("/api/missions/mission-A", Reply::json(200, bad));
            cx.update_window(h, |_, w, cx| w.click("comments-refresh", cx))
                .unwrap();
            until(cx, h, &view, |v| v.error.is_none() && !v.busy);
            cx.update_window(h, |_, w, _| {
                assert!(w.find("comments-error").visible());
                assert!(w.try_find("mission-comments-list").is_none());
            })
            .unwrap();
            let mut absent = d.clone();
            absent.as_object_mut().unwrap().remove("comments");
            server.reply("/api/missions/mission-A", Reply::json(200, absent));
            cx.update_window(h, |_, w, cx| w.click("comments-refresh", cx))
                .unwrap();
            until(cx, h, &view, |v| !v.busy);
            cx.update_window(h, |_, w, _| assert!(w.find("comments-unknown").visible()))
                .unwrap();
            // A marked sibling draft fences opening Comments; the draft survives.
            server.reply("/api/missions/mission-A", Reply::json(200, d.clone()));
            cx.update_window(h, |_, w, cx| w.click("comments-back", cx))
                .unwrap();
            cx.update_window(h, |_, w, cx| view.update(cx, |v, cx| v.read(w, cx)))
                .unwrap();
            until(cx, h, &view, |v| !v.busy && v.error.is_none());
            // The draft lives on the Tasks tab; composition fences leaving it.
            reveal(cx, h, "mission-tab-tasks");
            cx.update_window(h, |_, w, cx| w.click("mission-tab-tasks", cx))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| w.click("mission-task-new", cx))
                .unwrap();
            settle(cx, h);
            let form = cx.update(|cx| {
                view.read(cx)
                    .tasks_browser
                    .read(cx)
                    .creation
                    .clone()
                    .unwrap()
            });
            cx.update_window(h, |_, w, cx| {
                form.update(cx, |f, cx| {
                    f.focus(w, cx);
                    f.title.update(cx, |i, cx| {
                        i.replace_text_in_range(None, "Retained draft 👩‍💻", w, cx);
                        i.replace_and_mark_text_in_range(None, "に", Some(1..1), w, cx);
                    });
                });
            })
            .unwrap();
            settle(cx, h);
            let before = cx.update(|cx| form.read(cx).title.read(cx).value().to_string());
            cx.update_window(h, |_, w, cx| {
                w.click("mission-tab-overview", cx);
                assert!(
                    view.read(cx).tab == crate::mission_browser_view::Tab::Tasks,
                    "marked text is never interrupted"
                );
                let title = form.read(cx).title.clone();
                assert!(title.update(cx, |i, cx| i.marked_text_range(w, cx).is_some()));
                title.update(cx, |i, cx| i.unmark_text(w, cx));
                w.click("mission-tab-overview", cx);
            })
            .unwrap();
            settle(cx, h);
            reveal(cx, h, "mission-comments-open");
            cx.update_window(h, |_, w, cx| {
                let title = form.read(cx).title.clone();
                w.click("mission-comments-open", cx);
                assert!(view.read(cx).comments.open);
                assert_eq!(title.read(cx).value().as_ref(), before);
            })
            .unwrap();
            settle(cx, h);
            // Switching missions closes Comments; mission-B has none.
            cx.update_window(h, |_, w, cx| {
                view.update(cx, |v, cx| v.sync(input("mission-B", true, &chats), w, cx))
            })
            .unwrap();
            until(cx, h, &view, |v| {
                v.detail
                    .as_ref()
                    .is_some_and(|d| d.key == f::key("mission-B"))
                    && !v.busy
            });
            cx.update_window(h, |_, w, cx| {
                assert!(!view.read(cx).comments.open);
                assert!(view.read(cx).comments.ids.is_empty());
                assert!(w.try_find("comment-c3").is_none());
                assert!(w.try_find("mission-needs-comment-c1").is_none());
            })
            .unwrap();
            reveal(cx, h, "mission-comments-open");
            cx.update_window(h, |_, w, cx| w.click("mission-comments-open", cx))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, _| assert!(w.find("comments-empty").visible()))
                .unwrap();
            assert!(server.all_gets());
            println!(
                "PASS comments {width} {}: remainder/row reveal exact comment, virtual list, keyboard select+copy, drag copy, quote/target/resolved, back keeps overview, refresh keeps position, stale/offline/error/unknown, IME fence, mission switch, GET-only",
                mode.name()
            );
            cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
        }
    }
}
