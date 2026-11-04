//! Hidden production LocalViewer with an owned GET-only retained fixture.
//! The global request list is the proposed shape, not backend evidence.
use crate::mission_browser_fixture::{Reply, Server};
use crate::{
    LocalViewer, native_review_fixture as r,
    native_review_view::Pane,
    navigation::{ReviewTarget, Target},
};
use gpui_kit::{
    AnyWindowHandle, App, AppContext, Bounds, Entity, HeadlessAppContext, WindowBounds,
    WindowOptions, px, size, test::TestWindowExt,
};
use serde_json::json;
use std::{
    path::PathBuf,
    time::{Duration, Instant},
};
fn settle(cx: &mut HeadlessAppContext, h: AnyWindowHandle) {
    for _ in 0..3 {
        cx.run_until_parked();
        cx.advance_clock(Duration::from_millis(16));
        cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
    }
}
#[track_caller]
fn until(cx: &mut HeadlessAppContext, h: AnyWindowHandle, p: impl Fn(&App) -> bool) {
    let end = Instant::now() + Duration::from_secs(8);
    while !cx.update(|cx| p(cx)) {
        assert!(
            Instant::now() < end,
            "Review timeout at {}",
            std::panic::Location::caller()
        );
        settle(cx, h);
        std::thread::yield_now();
    }
    settle(cx, h);
}
fn click(cx: &mut HeadlessAppContext, h: AnyWindowHandle, id: &'static str) {
    cx.update_window(h, |_, w, cx| w.click(id, cx)).unwrap();
    settle(cx, h);
}
fn choose(cx: &mut HeadlessAppContext, h: AnyWindowHandle, id: &'static str, down: usize) {
    click(cx, h, id);
    for _ in 0..down {
        cx.update_window(h, |_, w, cx| w.press("down", cx)).unwrap();
        settle(cx, h);
    }
    cx.update_window(h, |_, w, cx| w.press("enter", cx))
        .unwrap();
    settle(cx, h);
}
fn idle(cx: &mut HeadlessAppContext, h: AnyWindowHandle, p: &Entity<Pane>) {
    until(cx, h, |cx| !p.read(cx).probe(cx).0);
}
/// Opens one listed change from its row and waits for its exact revision.
fn open_row(cx: &mut HeadlessAppContext, h: AnyWindowHandle, p: &Entity<Pane>, ix: usize) {
    cx.update_window(h, |_, w, cx| w.click(("review-request", ix), cx))
        .unwrap();
    settle(cx, h);
    idle(cx, h, p);
}
fn shot(cx: &mut HeadlessAppContext, h: AnyWindowHandle, dir: &Option<PathBuf>, name: String) {
    if let Some(d) = dir {
        cx.capture_screenshot(h)
            .unwrap()
            .save(d.join(name))
            .unwrap();
    }
}
/// Opens retained source from a file header's View file action.
fn view_file(cx: &mut HeadlessAppContext, h: AnyWindowHandle, pane: &Entity<Pane>, ix: usize) {
    let path = cx.update(|cx| pane.read(cx).probe_files(cx)[ix].clone());
    cx.update_window(h, |_, w, cx| w.click(format!("review-view:{path}"), cx))
        .unwrap();
    settle(cx, h);
}
/// Every visible control stays inside the page.
fn contained(cx: &mut HeadlessAppContext, h: AnyWindowHandle, ids: &[&'static str]) {
    cx.update_window(h, |_, w, _| {
        let page = w.find("review-page").bounds();
        for id in ids {
            let b = w.find(*id).bounds();
            assert!(
                b.left() >= page.left() - px(1.) && b.right() <= page.right() + px(1.),
                "{id} overflows"
            );
        }
    })
    .unwrap();
}
fn target(cx: &mut HeadlessAppContext, view: &Entity<LocalViewer>) -> Target {
    cx.update(|cx| view.read(cx).review_fixture_target(cx))
}
fn review(chat: Option<&str>, request: Option<&str>) -> Target {
    Target::Review(ReviewTarget {
        chat: chat.map(Into::into),
        request: request.map(Into::into),
        snapshot: None,
    })
}
fn fixture_chat(id: &str, title: &str, project: &str) -> crate::local_model::Chat {
    crate::local_model::chat(&json!({"id":id,"title":title,"projectId":project,"state":"idle","cwd":format!("/synthetic/{id}")})).unwrap()
}
fn chats(b_project: &str) -> Vec<crate::local_model::Chat> {
    vec![
        fixture_chat("chat-B", r::PARSER, b_project),
        fixture_chat("chat-C", "Lexer worker", "project-A"),
        fixture_chat("chat-S", "Standalone notes chat", "project-A"),
        fixture_chat("chat-N", "New standalone chat", "project-B"),
    ]
}
fn set_chats(
    cx: &mut HeadlessAppContext,
    h: AnyWindowHandle,
    view: &Entity<LocalViewer>,
    chats: Vec<crate::local_model::Chat>,
) {
    cx.update_window(h, |_, w, cx| {
        view.update(cx, |v, cx| v.review_fixture_chats(chats, w, cx))
    })
    .unwrap();
    settle(cx, h);
}
fn open_chat(
    cx: &mut HeadlessAppContext,
    h: AnyWindowHandle,
    view: &Entity<LocalViewer>,
    id: &str,
) {
    let opened = cx
        .update_window(h, |_, w, cx| {
            view.update(cx, |v, cx| v.review_fixture_open(id, w, cx))
        })
        .unwrap();
    assert!(opened);
    settle(cx, h);
}
/// Review reads since `from` are GETs of the global list or exact chat routes, each chat
/// read expecting the project its request listed: never mission, project or live reads.
fn review_reads(s: &Server, from: usize) -> usize {
    assert_eq!(s.write_count(), 0, "Review never writes");
    let seen = &s.state.lock().unwrap().seen;
    let reads: Vec<_> = seen[from..]
        .iter()
        .filter(|(_, p)| p.contains("/review"))
        .collect();
    for (method, path) in &reads {
        assert_eq!(method, "GET", "{path}");
        let chat = ["chat-B", "chat-C", "chat-N", "chat-S"]
            .into_iter()
            .find(|c| {
                path.starts_with(&format!("{}/", r::chat(c)))
                    || path.starts_with(&format!("{}?after=", r::chat(c)))
            });
        assert!(
            path.starts_with("/api/review/requests?after=") || chat.is_some(),
            "unexpected Review read {path}"
        );
        if let Some(c) = chat {
            // After chat-B is known to have moved, only its saved list is read, under
            // the project it is in now.
            let moved = c == "chat-B"
                && path.starts_with(&format!("{}?after=", r::chat(c)))
                && path.ends_with("expectedProjectId=project-B");
            assert!(
                moved || path.ends_with(&format!("expectedProjectId={}", r::project_of(c))),
                "chat Review read without its listed project: {path}"
            );
        }
    }
    assert!(
        seen.iter().all(|(_, p)| !p.contains("/changes")
            && !p.contains("/workspace")
            && !p.contains("/files")),
        "no live workspace reads"
    );
    reads.len()
}
/// The global list from the sidebar: every change with a request, each opening its exact
/// revision; the list survives opening and going back.
#[allow(clippy::too_many_arguments)]
fn global(
    cx: &mut HeadlessAppContext,
    h: AnyWindowHandle,
    view: &Entity<LocalViewer>,
    s: &Server,
    retained: &serde_json::Value,
    dir: &Option<PathBuf>,
    width: f32,
    theme: &str,
) {
    let w0 = width as u32;
    click(cx, h, "nav-review");
    assert_eq!(target(cx, view), review(None, None));
    let pane = cx.update(|cx| view.read(cx).review_fixture_pane().unwrap());
    idle(cx, h, &pane);
    cx.update(|cx| {
        assert_eq!(
            pane.read(cx).probe_requests(),
            ["req-1", "req-2", "req-3", "req-4"]
        );
        assert_eq!(pane.read(cx).probe_state(), None);
    });
    cx.update_window(h, |_, w, _| {
        assert!(w.find("review-list").bounds().size.height > px(0.));
        assert!(w.find(("review-request", 3usize)).bounds().size.height > px(0.));
        assert!(w.try_find("review-page-all").is_none());
        assert!(
            w.try_find("review-diff").is_none(),
            "the list never auto-opens a change"
        );
    })
    .unwrap();
    contained(
        cx,
        h,
        &["review-page-header", "review-actions", "review-list"],
    );
    shot(cx, h, dir, format!("review-{w0}-{theme}-list.png"));
    // Loading shows where the diff goes.
    let first = r::comparison(1, "layer");
    let mut slow = Reply::json(200, r::snapshot(&first));
    slow.delay_ms = 600;
    r::reply(s, &format!("{}/{:064x}", r::ROOT, 1), slow);
    cx.update_window(h, |_, w, cx| w.click(("review-request", 0usize), cx))
        .unwrap();
    settle(cx, h);
    assert_eq!(target(cx, view), review(None, Some("req-1")));
    cx.update(|cx| assert_eq!(pane.read(cx).probe_state(), Some("Loading diff…")));
    cx.update_window(h, |_, w, _| {
        assert!(w.find("review-state").bounds().size.height > px(0.));
        assert!(w.try_find("review-list").is_none());
    })
    .unwrap();
    idle(cx, h, &pane);
    cx.update(|cx| {
        let p = pane.read(cx).probe(cx);
        assert_eq!(p.1, Some(format!("{:064x}", 1)));
        assert_eq!(p.3, 1);
        assert_eq!(p.4, None);
        assert_eq!(pane.read(cx).probe_state(), None);
    });
    cx.update_window(h, |_, w, cx| {
        let b = w.find("review-diff").bounds();
        assert!(b.size.height > px(160.));
        assert!(w.find("review-change-title").bounds().size.height > px(0.));
        assert!(
            w.find("review-details").bounds().bottom()
                <= w.find("review-summary").bounds().bottom() + px(1.),
            "Details must be visible without scrolling"
        );
        assert!(
            w.try_find("review-records").is_none(),
            "evidence stays in Revision details"
        );
        assert!(
            w.try_find("review-identities").is_none(),
            "no technical identity in the default view"
        );
        assert!(w.try_find("review-newer").is_none());
        assert!(w.find("review-files-summary").bounds().size.height > px(0.));
        assert!(w.try_find("review-jump").is_none(), "no jump for one file");
        assert!(b.right() <= w.find("native-review").bounds().right() + px(1.));
        w.click("review-diff", cx);
        w.press("down", cx);
        w.press("alt-down", cx);
    })
    .unwrap();
    settle(cx, h);
    // Revision details is reachable and operable from the keyboard alone.
    for _ in 0..40 {
        let focused = cx
            .update_window(h, |_, w, cx| {
                let on = w.find("review-details").focused() == Some(true);
                if !on {
                    w.press("tab", cx);
                }
                on
            })
            .unwrap();
        settle(cx, h);
        if focused {
            break;
        }
    }
    cx.update_window(h, |_, w, cx| {
        assert_eq!(w.find("review-details").focused(), Some(true));
        w.press("space", cx);
    })
    .unwrap();
    settle(cx, h);
    cx.update_window(h, |_, w, _| {
        assert!(w.find("review-details-panel").bounds().size.height > px(0.));
        assert!(w.find("review-identities").bounds().size.height > px(0.));
    })
    .unwrap();
    shot(cx, h, dir, format!("review-{w0}-{theme}-details.png"));
    cx.update_window(h, |_, w, cx| w.press("escape", cx))
        .unwrap();
    settle(cx, h);
    cx.update_window(h, |_, w, _| {
        assert!(w.try_find("review-details-panel").is_none())
    })
    .unwrap();
    // Escape closed only the dialog: the exact change and its diff remain.
    assert_eq!(target(cx, view), review(None, Some("req-1")));
    cx.update(|cx| assert_eq!(pane.read(cx).probe(cx).3, 1));
    click(cx, h, "review-split");
    click(cx, h, "review-unified");
    // Back returns to the same list; another row opens its own exact revision.
    click(cx, h, "review-page-back");
    assert_eq!(target(cx, view), review(None, None));
    idle(cx, h, &pane);
    cx.update(|cx| assert_eq!(pane.read(cx).probe(cx).1, None));
    open_row(cx, h, &pane, 1);
    cx.update(|cx| assert_eq!(pane.read(cx).probe(cx).1, Some(format!("{:064x}", 2))));
    // A new request for a later revision never changes the open exact layer/stack.
    let mut partial = r::comparison(3, "layer");
    partial["status"] = json!("partial");
    let mut manifest = r::snapshot(&partial);
    manifest["omissions"] = json!(["before: one blob omitted (limit)"]);
    let mut listed = r::requests();
    listed.push(r::request("req-5", 5, "chat-B", r::PARSER, &partial));
    s.reply(r::REQUESTS, Reply::json(200, r::list(listed.clone())));
    r::reply(
        s,
        &format!("{}/{:064x}", r::ROOT, 3),
        Reply::json(200, manifest),
    );
    r::reply(
        s,
        &format!("{}/{:064x}/patch", r::ROOT, 3),
        Reply::json(
            200,
            json!({"snapshotId":format!("{:064x}",3),"patch":r::PATCH}),
        ),
    );
    click(cx, h, "review-refresh");
    idle(cx, h, &pane);
    cx.update(|cx| assert_eq!(pane.read(cx).probe(cx).1, Some(format!("{:064x}", 2))));
    // The other scope's later revision is not newer for the stack.
    cx.update_window(h, |_, w, _| assert!(w.try_find("review-newer").is_none()))
        .unwrap();
    click(cx, h, "review-page-back");
    idle(cx, h, &pane);
    open_row(cx, h, &pane, 0);
    cx.update_window(h, |_, w, _| {
        assert!(w.find("review-newer").bounds().size.height > px(0.))
    })
    .unwrap();
    cx.update(|cx| assert_eq!(pane.read(cx).probe(cx).1, Some(format!("{:064x}", 1))));
    click(cx, h, "review-page-back");
    idle(cx, h, &pane);
    open_row(cx, h, &pane, 4);
    cx.update(|cx| assert_eq!(pane.read(cx).probe(cx).1, Some(format!("{:064x}", 3))));
    // The partial warning is visible without opening Details.
    cx.update_window(h, |_, w, _| {
        assert!(w.find("review-status").bounds().size.height > px(0.))
    })
    .unwrap();
    // A change that leaves the list stays pinned and says so.
    s.reply(r::REQUESTS, Reply::json(200, r::list(r::requests())));
    click(cx, h, "review-refresh");
    idle(cx, h, &pane);
    cx.update(|cx| assert_eq!(pane.read(cx).probe(cx).1, Some(format!("{:064x}", 3))));
    cx.update_window(h, |_, w, _| {
        assert!(w.find("review-unlisted").bounds().size.height > px(0.))
    })
    .unwrap();
    click(cx, h, "review-page-back");
    idle(cx, h, &pane);
    open_row(cx, h, &pane, 1);
    view_file(cx, h, &pane, 0);
    idle(cx, h, &pane);
    cx.update(|cx| {
        assert!(
            pane.read(cx)
                .probe(cx)
                .2
                .unwrap()
                .contains("retained lower")
        )
    });
    cx.update_window(h, |_, w, cx| w.press("escape", cx))
        .unwrap();
    settle(cx, h);
    cx.update(|cx| assert!(pane.read(cx).probe(cx).2.is_none()));
    assert_eq!(target(cx, view), review(None, Some("req-2")));
    // The same exact revision 2 now holds three files, shown as one continuous list.
    let (manifest, patch) = r::multi(&r::comparison(2, "stack"));
    r::reply(
        s,
        &format!("{}/{:064x}", r::ROOT, 2),
        Reply::json(200, manifest),
    );
    r::reply(
        s,
        &format!("{}/{:064x}/patch", r::ROOT, 2),
        Reply::json(
            200,
            json!({"snapshotId":format!("{:064x}",2),"patch":patch}),
        ),
    );
    click(cx, h, "review-refresh");
    idle(cx, h, &pane);
    cx.update(|cx| {
        let p = pane.read(cx).probe(cx);
        assert_eq!(p.1, Some(format!("{:064x}", 2)));
        assert_eq!(p.3, 3);
    });
    cx.update_window(h, |_, w, _| {
        assert!(w.find("review-jump").bounds().size.height > px(0.));
    })
    .unwrap();
    // Jumping scrolls the full list; it never narrows it to one file.
    choose(cx, h, "review-jump", 3);
    cx.update(|cx| assert_eq!(pane.read(cx).probe(cx).3, 3));
    // A deleted file opens its retained before side.
    r::reply(
        s,
        &format!(
            "{}/{:064x}/source?side=before&path=old.txt&sha256={}",
            r::ROOT,
            2,
            crate::native_review::hash(b"gone\n")
        ),
        Reply::json(
            200,
            json!({"snapshotId":format!("{:064x}",2),"text":"gone\n"}),
        ),
    );
    view_file(cx, h, &pane, 2);
    idle(cx, h, &pane);
    cx.update(|cx| assert_eq!(pane.read(cx).probe(cx).2.as_deref(), Some("gone\n")));
    // A deleted file has no after side: the switch is disabled, not a warning, and
    // there is no current file to open.
    click(cx, h, "review-after");
    cx.update(|cx| {
        let p = pane.read(cx).probe(cx);
        assert_eq!(p.2.as_deref(), Some("gone\n"));
        assert_eq!(p.4, None);
        assert!(!p.0);
    });
    cx.update_window(h, |_, w, _| {
        assert!(w.try_find("review-current-file").is_none())
    })
    .unwrap();
    click(cx, h, "review-back");
    cx.update(|cx| assert!(pane.read(cx).probe(cx).2.is_none()));
    // Back during a slow Before read cancels it: the late reply never reopens source.
    view_file(cx, h, &pane, 0);
    idle(cx, h, &pane);
    let mut slow = Reply::json(
        200,
        json!({"snapshotId":format!("{:064x}",2),"text":"before\n"}),
    );
    slow.delay_ms = 600;
    r::reply(
        s,
        &format!(
            "{}/{:064x}/source?side=before&path=a.rs&sha256={}",
            r::ROOT,
            2,
            crate::native_review::hash(b"before\n")
        ),
        slow,
    );
    click(cx, h, "review-before");
    cx.update(|cx| assert!(pane.read(cx).probe(cx).0, "before read pending"));
    click(cx, h, "review-back");
    let end = Instant::now() + Duration::from_millis(1200);
    while Instant::now() < end {
        settle(cx, h);
        std::thread::yield_now();
    }
    cx.update(|cx| {
        let p = pane.read(cx).probe(cx);
        assert!(
            p.2.is_none(),
            "late source reply reopened source after Back"
        );
        assert_eq!(p.1, Some(format!("{:064x}", 2)));
        assert_eq!(p.3, 3);
        assert_eq!(p.4, None);
        assert!(!p.0);
    });
    cx.update_window(h, |_, w, cx| {
        assert!(pane.read(cx).owns_focus(w, cx), "focus stays in Review");
    })
    .unwrap();
    let ids = [
        "review-page-header",
        "review-change",
        "review-actions",
        "review-files-bar",
    ];
    contained(cx, h, &ids);
    let other = if width == 680. { 1100. } else { 680. };
    cx.update_window(h, |_, w, cx| {
        w.resize(size(px(other), px(700.)));
        w.bounds_changed(cx);
    })
    .unwrap();
    settle(cx, h);
    contained(cx, h, &ids);
    cx.update_window(h, |_, w, _| {
        assert!(w.find("review-diff").bounds().size.height > px(100.))
    })
    .unwrap();
    shot(cx, h, dir, format!("review-{}-{theme}.png", other as u32));
    cx.update(|cx| pane.update(cx, |p, cx| p.probe_stale(cx)));
    // A refused target clears all prior authorized source/diff, not just its badge.
    r::reply(
        s,
        &format!("{}/{:064x}", r::ROOT, 2),
        Reply::json(403, json!({"error":"denied"})),
    );
    click(cx, h, "review-refresh");
    idle(cx, h, &pane);
    cx.update(|cx| {
        let p = pane.read(cx).probe(cx);
        assert_eq!(p.3, 0);
        assert!(p.4.is_some());
    });
    cx.update_window(h, |_, w, _| {
        assert!(w.find("review-error").bounds().size.height > px(0.))
    })
    .unwrap();
    r::install(s);
    click(cx, h, "review-refresh");
    idle(cx, h, &pane);
    cx.update(|cx| assert_eq!(pane.read(cx).probe(cx).3, 1));
    // Consume actual retained bytes, not the hand-authored demo manifest above.
    for (path, response) in retained["routes"].as_object().unwrap() {
        // The capture fixture names the mission-compatible path; reads use the chat route.
        let path = path.replacen("/api/missions/mission-A/review/chat-B", r::ROOT, 1);
        r::reply(s, &path, Reply::json(200, response.clone()));
    }
    let real = &retained["first"]["comparisons"][0];
    let real_id = real["snapshotId"].as_str().unwrap();
    let mut with_real = r::requests();
    with_real.push(r::request("req-real", 10, "chat-B", r::PARSER, real));
    s.reply(r::REQUESTS, Reply::json(200, r::list(with_real.clone())));
    click(cx, h, "review-page-back");
    idle(cx, h, &pane);
    click(cx, h, "review-refresh");
    idle(cx, h, &pane);
    open_row(cx, h, &pane, 4);
    cx.update(|cx| {
        assert_eq!(pane.read(cx).probe(cx).1.as_deref(), Some(real_id));
        assert_eq!(pane.read(cx).probe(cx).3, 1);
    });
    // A later real capture listed beside it never moves the open exact one; it is a
    // different change, so it is not called a newer revision of this one.
    let latest = retained["latest"]["comparisons"].as_array().unwrap();
    let newest = latest.last().unwrap();
    assert_ne!(newest["snapshotId"], real["snapshotId"]);
    with_real.push(r::request("req-real-2", 11, "chat-B", r::PARSER, newest));
    s.reply(r::REQUESTS, Reply::json(200, r::list(with_real)));
    click(cx, h, "review-refresh");
    idle(cx, h, &pane);
    cx.update(|cx| assert_eq!(pane.read(cx).probe(cx).1.as_deref(), Some(real_id)));
    cx.update_window(h, |_, w, _| assert!(w.try_find("review-newer").is_none()))
        .unwrap();
    view_file(cx, h, &pane, 0);
    idle(cx, h, &pane);
    cx.update(|cx| {
        assert!(
            pane.read(cx)
                .probe(cx)
                .2
                .as_deref()
                .unwrap()
                .contains("retained lower")
        )
    });
    click(cx, h, "review-back");
    click(cx, h, "review-page-back");
    idle(cx, h, &pane);
    // No request source is unavailable, distinct from an empty queue and from an error.
    s.reply(
        r::REQUESTS,
        Reply::json(
            200,
            json!({"requests":[],"next":null,"unavailable":"not installed"}),
        ),
    );
    click(cx, h, "review-refresh");
    idle(cx, h, &pane);
    cx.update(|cx| {
        assert_eq!(pane.read(cx).probe(cx).4, None);
        assert_eq!(
            pane.read(cx).probe_state(),
            Some("Review requests are unavailable.")
        );
    });
    cx.update_window(h, |_, w, _| {
        assert!(w.try_find("review-list").is_none());
        assert!(w.find("review-state").bounds().size.height > px(0.));
    })
    .unwrap();
    shot(
        cx,
        h,
        dir,
        format!("review-{}-{theme}-unavailable.png", other as u32),
    );
    s.reply(r::REQUESTS, Reply::json(200, r::list(vec![])));
    click(cx, h, "review-refresh");
    idle(cx, h, &pane);
    cx.update(|cx| {
        assert_eq!(
            pane.read(cx).probe_state(),
            Some("Nothing is waiting for review.")
        )
    });
    shot(
        cx,
        h,
        dir,
        format!("review-{}-{theme}-empty.png", other as u32),
    );
    // Escape from the list leaves Review for where it was opened.
    cx.update_window(h, |_, w, cx| {
        pane.update(cx, |p, cx| p.focus(w, cx));
        w.press("escape", cx);
    })
    .unwrap();
    settle(cx, h);
    assert!(!matches!(target(cx, view), Target::Review(_)));
    r::install(s);
}
/// A chat's Review button opens the same global Review narrowed to that chat; its rows
/// open the same exact targets. Standalone and mission chats get the same page.
fn from_chat(
    cx: &mut HeadlessAppContext,
    h: AnyWindowHandle,
    view: &Entity<LocalViewer>,
    s: &Server,
    dir: &Option<PathBuf>,
    name: &str,
) {
    r::install(s);
    let start = s.state.lock().unwrap().seen.len();
    set_chats(cx, h, view, chats("project-A"));
    open_chat(cx, h, view, "chat-B");
    click(cx, h, "chat-review");
    assert_eq!(target(cx, view), review(Some("chat-B"), None));
    let pane = cx.update(|cx| view.read(cx).review_fixture_pane().unwrap());
    idle(cx, h, &pane);
    cx.update(|cx| assert_eq!(pane.read(cx).probe_requests(), ["req-1", "req-2"]));
    cx.update_window(h, |_, w, _| {
        assert!(w.find("review-page-subtitle").bounds().size.height > px(0.));
        assert!(w.find("review-page-all").bounds().size.height > px(0.));
    })
    .unwrap();
    open_row(cx, h, &pane, 0);
    assert_eq!(target(cx, view), review(Some("chat-B"), Some("req-1")));
    cx.update(|cx| {
        let p = pane.read(cx).probe(cx);
        assert_eq!(p.1, Some(format!("{:064x}", 1)));
        assert_eq!((p.3, p.4), (1, None));
    });
    shot(cx, h, dir, format!("review-{name}-chat.png"));
    // A known move of this change's chat to another project closes it here, and
    // Refresh never reads that chat again under the old project.
    let chat_b_reads = |s: &Server| {
        s.state
            .lock()
            .unwrap()
            .seen
            .iter()
            .filter(|(_, p)| {
                p.starts_with("/api/sessions/chat-B/")
                    && !(p.contains("?after=") && p.ends_with("expectedProjectId=project-B"))
            })
            .count()
    };
    set_chats(cx, h, view, chats("project-B"));
    let before = chat_b_reads(s);
    cx.update(|cx| {
        let p = pane.read(cx).probe(cx);
        assert_eq!(p.3, 0, "moved chat content cleared");
        assert!(p.4.unwrap().contains("another project"));
    });
    click(cx, h, "review-refresh");
    idle(cx, h, &pane);
    cx.update(|cx| {
        let p = pane.read(cx).probe(cx);
        assert_eq!(p.3, 0, "Refresh never reopens it");
        assert!(p.4.unwrap().contains("another project"));
    });
    assert_eq!(
        before,
        chat_b_reads(s),
        "no change read, and nothing under the old project, after a known move"
    );
    cx.update_window(h, |_, w, _| {
        assert!(w.find("review-error").bounds().size.height > px(0.));
    })
    .unwrap();
    set_chats(cx, h, view, chats("project-A"));
    // Escape goes back through history: the chat's list, then the chat.
    cx.update_window(h, |_, w, cx| {
        pane.update(cx, |p, cx| p.focus(w, cx));
        w.press("escape", cx);
    })
    .unwrap();
    settle(cx, h);
    assert_eq!(target(cx, view), review(Some("chat-B"), None));
    idle(cx, h, &pane);
    cx.update_window(h, |_, w, cx| {
        pane.update(cx, |p, cx| p.focus(w, cx));
        w.press("escape", cx);
    })
    .unwrap();
    settle(cx, h);
    assert_eq!(target(cx, view), Target::Chat("chat-B".into()));
    // A stale target the host already has in another project is refused by the
    // expected-project check; nothing is shown.
    r::reply(
        s,
        &format!("{}/{:064x}", r::chat("chat-C"), 0xc001),
        Reply::json(
            403,
            json!({"error":"Retained Review unavailable in this scope"}),
        ),
    );
    open_chat(cx, h, view, "chat-C");
    click(cx, h, "chat-review");
    idle(cx, h, &pane);
    open_row(cx, h, &pane, 0);
    cx.update(|cx| {
        let p = pane.read(cx).probe(cx);
        assert_eq!(p.3, 0);
        assert_eq!(p.4, Some(crate::native_review_reader::ACCESS_REFUSED));
    });
    r::install(s);
    // The chat's saved revision without a request opens in the same view, as itself:
    // never labelled pending and never a minted request.
    click(cx, h, "review-page-back");
    idle(cx, h, &pane);
    cx.update(|cx| {
        assert_eq!(pane.read(cx).probe_requests(), ["req-3"]);
        assert_eq!(pane.read(cx).probe_saved(), [format!("{:064x}", 0xc002)]);
    });
    cx.update_window(h, |_, w, cx| w.click(("review-saved", 0usize), cx))
        .unwrap();
    settle(cx, h);
    idle(cx, h, &pane);
    assert_eq!(
        target(cx, view),
        Target::Review(ReviewTarget {
            chat: Some("chat-C".into()),
            request: None,
            snapshot: Some(format!("{:064x}", 0xc002)),
        })
    );
    cx.update(|cx| {
        let p = pane.read(cx).probe(cx);
        assert_eq!(p.1, Some(format!("{:064x}", 0xc002)));
        assert_eq!((p.3, p.4), (1, None));
        assert_eq!(pane.read(cx).probe_status(), Some("No review request"));
    });
    assert_eq!(s.write_count(), 0, "opening never requests review");
    // A new standalone chat's project-owned capture in another project shows its exact
    // revision; details name the project capture and no task scope.
    open_chat(cx, h, view, "chat-N");
    click(cx, h, "chat-review");
    idle(cx, h, &pane);
    cx.update(|cx| assert_eq!(pane.read(cx).probe_requests(), ["req-4"]));
    open_row(cx, h, &pane, 0);
    cx.update(|cx| {
        let p = pane.read(cx).probe(cx);
        assert_eq!(p.1, Some(format!("{:064x}", 0xc005)));
        assert_eq!((p.3, p.4), (1, None));
        assert_eq!(
            pane.read(cx).probe_enrollment().as_deref(),
            Some("project-owned chat capture · no task scope")
        );
    });
    click(cx, h, "review-details");
    cx.update_window(h, |_, w, _| {
        assert!(w.find("review-identities").bounds().size.height > px(0.));
    })
    .unwrap();
    shot(cx, h, dir, format!("review-{name}-standalone-captured.png"));
    cx.update_window(h, |_, w, cx| w.press("escape", cx))
        .unwrap();
    settle(cx, h);
    cx.update_window(h, |_, w, _| {
        assert!(w.try_find("review-details-panel").is_none());
    })
    .unwrap();
    // The current workspace file opens in its chat, outside Review.
    view_file(cx, h, &pane, 0);
    idle(cx, h, &pane);
    click(cx, h, "review-current-file");
    assert_eq!(target(cx, view), Target::Chat("chat-N".into()));
    cx.update(|cx| assert!(view.read(cx).review_fixture_file_open()));
    // Back from the chat returns to the exact change in global Review.
    cx.update_window(h, |_, w, cx| {
        view.update(cx, |v, cx| v.review_fixture_back(w, cx))
    })
    .unwrap();
    settle(cx, h);
    assert_eq!(target(cx, view), review(Some("chat-N"), Some("req-4")));
    idle(cx, h, &pane);
    cx.update(|cx| assert_eq!(pane.read(cx).probe(cx).1, Some(format!("{:064x}", 0xc005))));
    // A standalone chat without retained custody says so; no mission is needed.
    open_chat(cx, h, view, "chat-S");
    cx.update(|cx| assert!(!view.read(cx).review_fixture_file_open()));
    click(cx, h, "chat-review");
    assert_eq!(target(cx, view), review(Some("chat-S"), None));
    idle(cx, h, &pane);
    cx.update(|cx| {
        let p = pane.read(cx).probe(cx);
        assert_eq!(pane.read(cx).probe_state(), Some("Not captured"));
        assert_eq!(pane.read(cx).probe_capture_notice(), None);
        assert_eq!((p.1, p.3, p.4), (None, 0, None));
    });
    shot(cx, h, dir, format!("review-{name}-standalone.png"));
    // Failed capture is distinct from an empty inventory; its limits live in details.
    let saved_s = format!("{}?after=0", r::chat("chat-S"));
    r::reply(
        s,
        &saved_s,
        Reply::json(
            200,
            json!({"comparisons":[],"next":null,"capture":{"pending":0,"failed":1}}),
        ),
    );
    click(cx, h, "review-refresh");
    idle(cx, h, &pane);
    cx.update(|cx| {
        assert_eq!(pane.read(cx).probe_capture_notice(),Some("Saving some committed revisions couldn't be confirmed. They remain queued for exact recovery at the next worker checkpoint; existing saved revisions are unchanged."));
        assert_eq!(
            pane.read(cx).probe_state(),
            Some("Nothing from this chat is waiting for review.")
        );
    });
    cx.update_window(h, |_, w, _| {
        assert!(w.find("review-capture-notice").bounds().size.height > px(0.))
    })
    .unwrap();
    r::reply(
        s,
        &saved_s,
        Reply::json(
            200,
            json!({"comparisons":[],"next":null,"capture":{"pending":0,"failed":0,"unsupported":["divergent","multiple-parents","root-base","missing","unknown-custody","unknown-discovery","conflicted"]}}),
        ),
    );
    click(cx, h, "review-refresh");
    idle(cx, h, &pane);
    cx.update(|cx| {
        assert!(
            pane.read(cx)
                .probe_capture_notice()
                .unwrap()
                .contains("Conflicted")
        )
    });
    click(cx, h, "review-details");
    cx.update_window(h, |_, w, _| {
        assert!(w.find("review-capture-limitations").bounds().size.height > px(0.));
    })
    .unwrap();
    cx.update_window(h, |_, w, cx| w.press("escape", cx))
        .unwrap();
    settle(cx, h);
    r::install(s);
    // All changes is the same global list.
    click(cx, h, "review-page-all");
    assert_eq!(target(cx, view), review(None, None));
    idle(cx, h, &pane);
    cx.update(|cx| assert_eq!(pane.read(cx).probe_requests().len(), 4));
    click(cx, h, "review-page-back");
    assert_eq!(target(cx, view), review(Some("chat-S"), None));
    idle(cx, h, &pane);
    assert!(s.all_gets());
    // Each open, Back and Refresh reads once: no polling or repeated reads. A chat entry
    // reads its request page and saved list; this journey makes 29 such reads.
    let reads = review_reads(s, start);
    assert!(reads <= 30, "bounded Review reads, saw {reads}");
}
pub fn run_native_review_probe(cx: &mut HeadlessAppContext) {
    cx.update(|cx| cx.set_reduce_motion(true));
    // Real managed jj -> durable lifecycle outbox -> capture -> admitted list/patch/source.
    // Only the final transport is the owned faux HTTP server below, never production data.
    let output = std::process::Command::new("node")
        .arg(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../packages/daemon/src/testing/retained-review.ts"),
        )
        .output()
        .expect("real retained capture fixture must run");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).unwrap();
    let retained: serde_json::Value = serde_json::from_str(
        stdout
            .lines()
            .find(|line| line.starts_with("{\"first\":"))
            .expect("real retained capture response, separate from Node test-runner diagnostics"),
    )
    .unwrap();
    let dir = std::env::var_os("PILOT_NEXT_REVIEW_DIR").map(PathBuf::from);
    if let Some(d) = &dir {
        std::fs::create_dir_all(d).unwrap();
    }
    for width in [680., 1100.] {
        for dark in [false, true] {
            let s = Server::start();
            r::install(&s);
            let (h, view) = cx.update(|cx| {
                crate::appearance::commit_appearance(
                    if dark {
                        crate::settings_state::AppearancePreference::Dark
                    } else {
                        crate::settings_state::AppearancePreference::Light
                    },
                    cx,
                );
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
                    |w, cx| cx.new(|cx| LocalViewer::synthetic(w, cx)),
                )
                .unwrap()
            });
            // The window's appearance sync runs on open; pin the theme afterwards.
            cx.update(|cx| {
                gpui_kit::component::Theme::change(
                    if dark {
                        gpui_kit::component::ThemeMode::Dark
                    } else {
                        gpui_kit::component::ThemeMode::Light
                    },
                    None,
                    cx,
                )
            });
            settle(cx, h);
            cx.update(|cx| {
                use gpui_kit::component::ActiveTheme;
                assert_eq!(cx.theme().is_dark(), dark)
            });
            let browser = cx
                .update_window(h, |_, w, cx| {
                    view.update(cx, |v, cx| v.brief_fixture_setup(s.options.clone(), w, cx))
                })
                .unwrap();
            until(cx, h, |cx| {
                browser.read(cx).catalog.is_some() && !browser.read(cx).busy
            });
            set_chats(cx, h, &view, chats("project-A"));
            let theme = if dark { "dark" } else { "light" };
            let start = s.state.lock().unwrap().seen.len();
            global(cx, h, &view, &s, &retained, &dir, width, theme);
            assert!(s.all_gets());
            review_reads(&s, start);
            // Named for the width shown after the global journey's resize.
            let shown = if width == 680. { 1100 } else { 680 };
            from_chat(cx, h, &view, &s, &dir, &format!("{shown}-{theme}"));
            cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
            drop(browser);
            drop(view);
            cx.run_until_parked();
        }
    }
    println!(
        "native Review: four hidden production-root global list, chat entry, standalone v2, exact layer/stack, newer pin, unlisted pin, partial, source/back, current file handoff, resize, unavailable/empty/refusal/moved and keyboard journeys; GET-only synthetic request list, not backend, OS IME/AX or performance acceptance"
    );
}
