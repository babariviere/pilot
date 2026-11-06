//! Hidden production LocalViewer Review journey against a real disposable host.
//!
//! Live seam: packages/daemon/src/testing/review-host.ts runs the real daemon routes,
//! SessionManager.spawn creation-only standalone enrollment in two projects, managed jj
//! workspaces, the worker checkpoint capture and missions.sqlite review requests, behind a
//! logging proxy the app reads through. The worker is a fake: no provider, model turn or
//! reviewer runs. Review requests exist only after the fixture's explicit setup "suggest"
//! commands, which post straight to the daemon; this journey checks the app never writes.
//! Faults are fixture-only: in-memory chat metadata moves, an offline proxy and a proxied
//! 503 request list. Not OS input, IME, accessibility or performance acceptance.
use super::*;
use crate::{
    LocalOptions,
    native_review_view::Pane,
    navigation::{ReviewTarget, Target},
};
use gpui_kit::{
    AnyWindowHandle, App, Bounds, Entity, HeadlessAppContext, WindowBounds, WindowOptions,
    component::ThemeMode, px, size, test::TestWindowExt,
};
use serde_json::{Value, json};
use std::{
    io::{BufRead, Write},
    process::{Child, ChildStdin, Command as Process, Stdio},
    sync::{Arc, mpsc},
    time::{Duration, Instant},
};

/// The real host fixture process and its JSON-line control channel.
struct Host {
    child: Child,
    stdin: ChildStdin,
    lines: mpsc::Receiver<Value>,
    port: u16,
    projects: Value,
    /// Set by the checked normal finish; Drop is only best-effort cleanup after a panic.
    finished: bool,
}
impl Host {
    fn start() -> Self {
        let mut child = Process::new("node")
            .arg(
                std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../../packages/daemon/src/testing/review-host.ts"),
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("the real Review host fixture must run");
        let stdout = child.stdout.take().unwrap();
        let (tx, lines) = mpsc::channel();
        std::thread::spawn(move || {
            for line in std::io::BufReader::new(stdout)
                .lines()
                .map_while(Result::ok)
            {
                if let Ok(v) = serde_json::from_str::<Value>(&line) {
                    let _ = tx.send(v);
                }
            }
        });
        let first = lines
            .recv_timeout(Duration::from_secs(120))
            .expect("Review host start line");
        let stdin = child.stdin.take().unwrap();
        Self {
            child,
            stdin,
            lines,
            port: first["port"].as_u64().unwrap() as u16,
            projects: first["projects"].clone(),
            finished: false,
        }
    }
    fn options(&self) -> LocalOptions {
        LocalOptions::synthetic(self.port)
    }
    fn project(&self, key: &str) -> String {
        self.projects[key]["id"].as_str().unwrap().into()
    }
    /// Sends one command and waits for its reply. Setup commands may run real jj work.
    #[track_caller]
    fn send(&mut self, cmd: Value) -> Value {
        writeln!(self.stdin, "{cmd}").unwrap();
        self.stdin.flush().unwrap();
        let reply = self
            .lines
            .recv_timeout(Duration::from_secs(300))
            .unwrap_or_else(|_| panic!("Review host reply timeout for {cmd}"));
        assert_eq!(reply["ok"], cmd["cmd"], "{reply}");
        assert!(reply.get("error").is_none(), "{cmd}: {reply}");
        reply
    }
    fn chat(&mut self, project: &str, title: &str) -> String {
        self.send(json!({"cmd":"chat","project":project,"title":title}))["id"]
            .as_str()
            .unwrap()
            .into()
    }
    fn comparisons(&mut self, id: &str) -> Vec<Value> {
        self.send(json!({"cmd":"comparisons","id":id}))["comparisons"]
            .as_array()
            .unwrap()
            .clone()
    }
    fn suggest(&mut self, id: &str, c: &Value, title: &str) -> String {
        self.send(json!({"cmd":"suggest","id":id,"snapshotId":c["snapshotId"],"title":title}))
            ["requestId"]
            .as_str()
            .unwrap()
            .into()
    }
    /// Every stored request as [id, revision, state, sequence], read inside the host.
    fn requests(&mut self) -> Value {
        self.send(json!({"cmd":"requests"}))["requests"].clone()
    }
    /// Requests the app made through the proxy since the last call.
    fn log(&mut self) -> Vec<(String, String)> {
        self.send(json!({"cmd":"log"}))["requests"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| {
                (
                    r["method"].as_str().unwrap().into(),
                    r["path"].as_str().unwrap().into(),
                )
            })
            .collect()
    }
    fn sessions(&mut self) -> Vec<crate::local_model::Chat> {
        self.send(json!({"cmd":"sessions"}))["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| crate::local_model::chat(v).expect("real session summary"))
            .collect()
    }
    /// Normal end of the journey: the fixture's teardown must report no failures and the host
    /// must exit cleanly within the same bound Drop allows, before any success is printed.
    fn finish(mut self) {
        let reply = self.send(json!({"cmd":"close"}));
        assert_eq!(
            reply["failures"],
            json!([]),
            "Review host teardown failed: {reply}"
        );
        let end = Instant::now() + Duration::from_secs(30);
        let status = loop {
            if let Some(status) = self.child.try_wait().expect("Review host status") {
                break status;
            }
            assert!(Instant::now() < end, "Review host did not exit after close");
            std::thread::sleep(Duration::from_millis(20));
        };
        self.finished = true;
        assert!(status.success(), "Review host exited with {status}");
    }
}
impl Drop for Host {
    fn drop(&mut self) {
        if self.finished {
            return;
        }
        let _ = writeln!(self.stdin, "{}", json!({"cmd":"close"}));
        let _ = self.stdin.flush();
        let end = Instant::now() + Duration::from_secs(30);
        while Instant::now() < end {
            if matches!(self.child.try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let _ = self.child.kill();
    }
}

/// Every app request through the proxy is a read.
fn gets_only(log: &[(String, String)]) {
    for (method, path) in log {
        assert_eq!(method, "GET", "{path}");
    }
}
fn settle(cx: &mut HeadlessAppContext, h: AnyWindowHandle) {
    for _ in 0..3 {
        cx.run_until_parked();
        cx.advance_clock(Duration::from_millis(16));
        cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
    }
}
#[track_caller]
fn until(cx: &mut HeadlessAppContext, h: AnyWindowHandle, p: impl Fn(&App) -> bool) {
    let end = Instant::now() + Duration::from_secs(30);
    while !cx.update(|cx| p(cx)) {
        assert!(
            Instant::now() < end,
            "Review host journey timeout at {}",
            std::panic::Location::caller()
        );
        settle(cx, h);
        std::thread::sleep(Duration::from_millis(5));
    }
    settle(cx, h);
}
fn click(cx: &mut HeadlessAppContext, h: AnyWindowHandle, id: impl Into<gpui_kit::ElementId>) {
    let id = id.into();
    cx.update_window(h, |_, w, cx| w.click(id, cx)).unwrap();
    settle(cx, h);
}
fn press(cx: &mut HeadlessAppContext, h: AnyWindowHandle, key: &str) {
    cx.update_window(h, |_, w, cx| w.press(key, cx)).unwrap();
    settle(cx, h);
}
#[track_caller]
fn idle(cx: &mut HeadlessAppContext, h: AnyWindowHandle, p: &Entity<Pane>) {
    until(cx, h, |cx| !p.read(cx).probe(cx).0);
}
fn target(cx: &mut HeadlessAppContext, v: &Entity<LocalViewer>) -> Target {
    cx.update(|cx| v.read(cx).review_fixture_target(cx))
}
fn review(chat: Option<&str>, request: Option<&str>, snapshot: Option<&str>) -> Target {
    Target::Review(ReviewTarget {
        chat: chat.map(Into::into),
        request: request.map(Into::into),
        snapshot: snapshot.map(Into::into),
    })
}
fn shown(cx: &mut HeadlessAppContext, p: &Entity<Pane>) -> Option<String> {
    cx.update(|cx| p.read(cx).probe(cx).1)
}
fn rows(cx: &mut HeadlessAppContext, p: &Entity<Pane>) -> Vec<String> {
    cx.update(|cx| p.read(cx).probe_requests())
}
fn snapshot_id(c: &Value) -> String {
    c["snapshotId"].as_str().unwrap().into()
}
/// Opens one listed request slot by its exact ID.
fn open_request(cx: &mut HeadlessAppContext, h: AnyWindowHandle, p: &Entity<Pane>, id: &str) {
    let ix = rows(cx, p).iter().position(|r| r == id).expect("listed");
    click(cx, h, ("review-request", ix));
    idle(cx, h, p);
}
/// Opens retained source for one file of the shown diff.
fn view_file(cx: &mut HeadlessAppContext, h: AnyWindowHandle, p: &Entity<Pane>, path: &str) {
    assert!(cx.update(|cx| p.read(cx).probe_files(cx).iter().any(|f| f == path)));
    click(cx, h, format!("review-view:{path}"));
    idle(cx, h, p);
}
/// The real Kit Diff copies its selected source: select all of the active file, then copy.
fn copy_diff(cx: &mut HeadlessAppContext, h: AnyWindowHandle) -> String {
    click(cx, h, "review-diff");
    press(cx, h, "secondary-a");
    press(cx, h, "secondary-c");
    cx.update(|cx| {
        cx.read_from_clipboard()
            .and_then(|c| c.text())
            .unwrap_or_default()
    })
}
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
fn open_chat_review(
    cx: &mut HeadlessAppContext,
    h: AnyWindowHandle,
    v: &Entity<LocalViewer>,
    p: Option<&Entity<Pane>>,
    id: &str,
) {
    let opened = cx
        .update_window(h, |_, w, cx| {
            v.update(cx, |v, cx| v.review_fixture_open(id, w, cx))
        })
        .unwrap();
    assert!(opened);
    settle(cx, h);
    // The chat header's exact shortcut: global Review narrowed to this chat.
    click(cx, h, "chat-review");
    assert_eq!(target(cx, v), review(Some(id), None, None));
    if let Some(p) = p {
        idle(cx, h, p);
    }
}
fn set_chats(
    cx: &mut HeadlessAppContext,
    h: AnyWindowHandle,
    v: &Entity<LocalViewer>,
    chats: Vec<crate::local_model::Chat>,
) {
    cx.update_window(h, |_, w, cx| {
        v.update(cx, |v, cx| v.review_fixture_chats(chats, w, cx))
    })
    .unwrap();
    settle(cx, h);
}

pub fn run_native_review_host_probe(cx: &mut HeadlessAppContext) {
    cx.update(|cx| cx.set_reduce_motion(true));
    let mut host = Host::start();
    // Three new standalone Build chats, created through the real creation path, in two
    // projects. Real commits and worker checkpoints save exact revisions.
    let a = host.chat("A", "Parser chat");
    let b = host.chat("B", "Notes chat 日本語");
    let bulk = host.chat("A", "Bulk chat");
    let quiet = host.chat("A", "Quiet chat");
    let first = host.send(json!({"cmd":"commit","id":a,"files":{"tracked.txt":"first retained\n","code.ts":"export const one = 1;\n"},"message":"First"}));
    host.send(json!({"cmd":"checkpoint","id":a}));
    host.send(json!({"cmd":"commit","id":a,"files":{"tracked.txt":"second retained\n"},"message":"Second"}));
    host.send(json!({"cmd":"checkpoint","id":a}));
    host.send(json!({"cmd":"describe","id":a,"change":first["change"],"message":"First, revised"}));
    host.send(json!({"cmd":"checkpoint","id":a}));
    host.send(json!({"cmd":"commit","id":b,"files":{"notes.md":"notes retained 日本語\n"},"message":"Notes"}));
    host.send(json!({"cmd":"checkpoint","id":b}));
    host.send(json!({"cmd":"commits","id":bulk,"count":22}));
    // Each checkpoint saves a limited batch; later checkpoints save the rest.
    host.send(json!({"cmd":"checkpoint","id":bulk,"count":10}));
    let saved_a = host.comparisons(&a);
    let saved_b = host.comparisons(&b);
    let saved_bulk = host.comparisons(&bulk);
    // Two changes from one chat, each with two exact revisions.
    assert_eq!(saved_a.len(), 4, "{saved_a:?}");
    let changes: std::collections::BTreeSet<String> = saved_a
        .iter()
        .map(|c| c["request"]["changeId"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(changes.len(), 2);
    assert_eq!(saved_b.len(), 1);
    assert!(saved_bulk.len() > 20, "{}", saved_bulk.len());
    assert!(host.comparisons(&quiet).is_empty());
    assert_eq!(host.requests(), json!([]), "capture never requests review");

    let options = host.options();
    let (h, view) = cx.update(|cx| {
        crate::appearance::commit_appearance(
            crate::settings_state::AppearancePreference::Light,
            cx,
        );
        gpui_kit::open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                    Default::default(),
                    size(px(1100.), px(840.)),
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
    cx.update(|cx| gpui_kit::component::Theme::change(ThemeMode::Light, None, cx));
    settle(cx, h);
    let projects = json!([
        {"id":host.project("A"),"name":"Parser project","path":host.projects["A"]["path"]},
        {"id":host.project("B"),"name":"Notes project","path":host.projects["B"]["path"]},
    ]);
    cx.update_window(h, |_, w, cx| {
        view.update(cx, |v, cx| {
            v.brief_fixture_setup(options.clone(), w, cx);
            v.state.projects = Arc::new(crate::local_model::projects(&projects).unwrap());
            v.usage_options = Some(options.clone());
        })
    })
    .unwrap();
    settle(cx, h);
    let chats = host.sessions();
    assert_eq!(chats.len(), 4);
    set_chats(cx, h, &view, chats.clone());
    gets_only(&host.log());

    // 1. Nothing was requested yet: an honest empty global list, and reading mints nothing.
    click(cx, h, "nav-review");
    assert_eq!(target(cx, &view), review(None, None, None));
    let pane = cx.update(|cx| view.read(cx).review_fixture_pane().unwrap());
    idle(cx, h, &pane);
    cx.update(|cx| {
        assert_eq!(
            pane.read(cx).probe_state(),
            Some("Nothing is waiting for review.")
        );
        assert_eq!(pane.read(cx).probe(cx).4, None);
    });

    // 2. A chat's saved revisions without a request: each exact revision opens on its own.
    open_chat_review(cx, h, &view, Some(&pane), &a);
    let listed: Vec<String> = saved_a.iter().map(snapshot_id).collect();
    cx.update(|cx| {
        assert!(pane.read(cx).probe_requests().is_empty());
        assert_eq!(pane.read(cx).probe_saved(), listed);
    });
    for (ix, c) in saved_a.iter().enumerate() {
        click(cx, h, ("review-saved", ix));
        idle(cx, h, &pane);
        assert_eq!(target(cx, &view), review(Some(&a), None, Some(&listed[ix])));
        assert_eq!(shown(cx, &pane).as_deref(), Some(listed[ix].as_str()));
        cx.update(|cx| {
            assert_eq!(pane.read(cx).probe(cx).4, None);
            assert_eq!(
                pane.read(cx).probe_status(),
                Some("Request status not shown here")
            );
            assert_eq!(
                pane.read(cx).probe_enrollment().as_deref(),
                Some("project-owned chat capture · no task scope")
            );
        });
        // The first revision holds both files of the first change.
        if ix == 0 {
            cx.update(|cx| {
                let mut files = pane.read(cx).probe_files(cx);
                files.sort();
                assert_eq!(files, ["code.ts", "tracked.txt"]);
            });
            view_file(cx, h, &pane, "tracked.txt");
            cx.update(|cx| {
                assert_eq!(
                    pane.read(cx).probe(cx).2.as_deref(),
                    Some("first retained\n")
                )
            });
            click(cx, h, "review-before");
            idle(cx, h, &pane);
            cx.update(|cx| assert_eq!(pane.read(cx).probe(cx).2.as_deref(), Some("base\n")));
            // Escape closes source, then the change.
            press(cx, h, "escape");
            cx.update(|cx| assert!(pane.read(cx).probe(cx).2.is_none()));
        }
        assert_eq!(c["status"], "complete");
        press(cx, h, "escape");
        assert_eq!(target(cx, &view), review(Some(&a), None, None));
        idle(cx, h, &pane);
    }
    assert_eq!(host.requests(), json!([]), "browsing never requests review");

    // 3. Explicit fixture setup, not the app: requests for both projects, more than a page.
    let mut ids = vec![];
    for (ix, c) in saved_a.iter().enumerate() {
        ids.push(host.suggest(&a, c, &format!("Parser revision {}", ix + 1)));
    }
    let notes = host.suggest(&b, &saved_b[0], "Notes 日本語");
    ids.push(notes.clone());
    for (ix, c) in saved_bulk.iter().take(17).enumerate() {
        ids.push(host.suggest(&bulk, c, &format!("Bulk {}", ix + 1)));
    }
    host.send(json!({"cmd":"withdraw","id":ids[1]}));
    let stored = host.requests();
    assert_eq!(stored.as_array().unwrap().len(), 22);
    assert_eq!(stored[1][2], "withdrawn");
    // Steps 1 and 2: every app request through the proxy was a read.
    gets_only(&host.log());

    // 4. The global list pages by request order, with exact labels; history is not waiting.
    click(cx, h, "review-page-all");
    assert_eq!(target(cx, &view), review(None, None, None));
    idle(cx, h, &pane);
    assert_eq!(rows(cx, &pane), ids[..20]);
    cx.update(|cx| {
        let statuses = pane.read(cx).probe_statuses();
        assert_eq!(statuses[1], "Withdrawn · history");
        assert!(
            statuses
                .iter()
                .enumerate()
                .all(|(ix, s)| ix == 1 || s == "Pending · readiness unknown")
        );
    });
    cx.update_window(h, |_, w, _| {
        assert!(w.find("review-count").bounds().size.height > px(0.));
        assert!(w.try_find("review-first").is_none());
    })
    .unwrap();
    // The long list scrolls on its own.
    cx.update_window(h, |_, w, cx| {
        w.scroll(
            "review-list",
            gpui_kit::ScrollDelta::Pixels(gpui_kit::point(px(0.), px(-600.))),
            cx,
        )
    })
    .unwrap();
    settle(cx, h);
    click(cx, h, "review-more");
    idle(cx, h, &pane);
    assert_eq!(rows(cx, &pane), ids[20..]);
    click(cx, h, "review-first");
    idle(cx, h, &pane);
    assert_eq!(rows(cx, &pane), ids[..20]);

    // 5. A request from the other project opens its exact revision and real bytes.
    open_request(cx, h, &pane, &notes);
    assert_eq!(target(cx, &view), review(None, Some(&notes), None));
    assert_eq!(shown(cx, &pane), Some(snapshot_id(&saved_b[0])));
    assert_eq!(copy_diff(cx, h), "notes retained 日本語\n");
    // Agent assessments don't apply to a chat capture outside a mission.
    click(cx, h, "review-details");
    cx.update_window(h, |_, w, _| {
        assert!(w.find("review-records-none").bounds().size.height > px(0.));
        assert!(w.try_find("review-records").is_none());
    })
    .unwrap();
    press(cx, h, "escape");
    // Option-Down and Option-Up move between edits without leaving the change.
    click(cx, h, "review-diff");
    press(cx, h, "alt-down");
    press(cx, h, "alt-up");
    assert_eq!(target(cx, &view), review(None, Some(&notes), None));
    click(cx, h, "review-page-back");
    assert_eq!(target(cx, &view), review(None, None, None));
    idle(cx, h, &pane);

    // 6. The same chat's two changes and revisions stay separately selectable.
    for (ix, c) in saved_a.iter().enumerate() {
        open_request(cx, h, &pane, &ids[ix]);
        assert_eq!(shown(cx, &pane), Some(snapshot_id(c)));
        click(cx, h, "review-page-back");
        idle(cx, h, &pane);
    }

    // 7. Retained source is not the live file. Open current file leaves Review for the
    // chat's live file, and Back returns to the exact retained revision.
    let latest = saved_a
        .iter()
        .position(|c| {
            c["request"]["changeId"] != first["change"]
                && saved_a
                    .iter()
                    .filter(|o| o["request"]["changeId"] == c["request"]["changeId"])
                    .all(|o| o["sequence"].as_u64() <= c["sequence"].as_u64())
        })
        .unwrap();
    host.send(json!({"cmd":"write","id":a,"files":{"tracked.txt":"live, not saved\n"}}));
    open_request(cx, h, &pane, &ids[latest]);
    view_file(cx, h, &pane, "tracked.txt");
    cx.update(|cx| {
        assert_eq!(
            pane.read(cx).probe(cx).2.as_deref(),
            Some("second retained\n")
        )
    });
    // A drag over the retained source copies that text.
    cx.update_window(h, |_, w, cx| {
        let b = w.find("review-source").bounds();
        let from = gpui_kit::point(b.left() + px(14.), b.top() + px(16.));
        w.drag(from, from + gpui_kit::point(px(80.), px(0.)), cx);
        w.press("secondary-c", cx);
        let copied = cx.read_from_clipboard().unwrap().text().unwrap();
        assert!(
            !copied.is_empty() && "second retained".contains(copied.trim()),
            "{copied:?}"
        );
    })
    .unwrap();
    click(cx, h, "review-current-file");
    assert_eq!(target(cx, &view), Target::Chat(a.clone()));
    until(cx, h, |cx| {
        view.read(cx).session_file.as_ref().is_some_and(|f| {
            matches!(&f.read(cx).state.content, Some(crate::session_file_view::Content::Text { shown, .. }) if shown == "live, not saved\n")
        })
    });
    cx.update_window(h, |_, w, cx| {
        view.update(cx, |v, cx| v.review_fixture_back(w, cx))
    })
    .unwrap();
    settle(cx, h);
    assert_eq!(target(cx, &view), review(None, Some(&ids[latest]), None));
    idle(cx, h, &pane);
    assert_eq!(shown(cx, &pane), Some(snapshot_id(&saved_a[latest])));
    assert_eq!(copy_diff(cx, h), "second retained\n");
    click(cx, h, "review-page-back");
    idle(cx, h, &pane);

    // 8. A chat's Review lists exactly its requests, then its saved revisions, which page on
    // their own.
    open_chat_review(cx, h, &view, Some(&pane), &bulk);
    assert_eq!(rows(cx, &pane), ids[5..]);
    let page_one: Vec<String> = saved_bulk[17..20].iter().map(snapshot_id).collect();
    cx.update(|cx| assert_eq!(pane.read(cx).probe_saved(), page_one));
    click(cx, h, "review-saved-more");
    idle(cx, h, &pane);
    let page_two: Vec<String> = saved_bulk[20..].iter().map(snapshot_id).collect();
    cx.update(|cx| assert_eq!(pane.read(cx).probe_saved(), page_two));
    assert_eq!(rows(cx, &pane), ids[5..], "request paging is unchanged");
    // Saved revisions follow the chat's 17 requests; scroll the list to reach them.
    cx.update_window(h, |_, w, cx| {
        w.scroll(
            "review-list",
            gpui_kit::ScrollDelta::Pixels(gpui_kit::point(px(0.), px(-4000.))),
            cx,
        )
    })
    .unwrap();
    settle(cx, h);
    click(cx, h, ("review-saved", 0usize));
    idle(cx, h, &pane);
    assert_eq!(
        target(cx, &view),
        review(Some(&bulk), None, Some(&page_two[0]))
    );
    assert_eq!(shown(cx, &pane).as_deref(), Some(page_two[0].as_str()));
    press(cx, h, "escape");
    idle(cx, h, &pane);
    cx.update(|cx| assert_eq!(pane.read(cx).probe_saved(), page_two));
    click(cx, h, "review-saved-first");
    idle(cx, h, &pane);
    cx.update(|cx| assert_eq!(pane.read(cx).probe_saved(), page_one));
    // A new chat with no revisions is genuinely empty, not unavailable.
    open_chat_review(cx, h, &view, Some(&pane), &quiet);
    cx.update(|cx| {
        assert_eq!(
            pane.read(cx).probe_state(),
            Some("Nothing from this chat is waiting for review.")
        )
    });

    // 9. A request whose chat is no longer readable keeps its slot, says only its state and
    // can't be opened. Its open content is cleared; Refresh recovers it under current access.
    click(cx, h, "review-page-all");
    idle(cx, h, &pane);
    open_request(cx, h, &pane, &notes);
    host.send(json!({"cmd":"move","id":b,"project":"A"}));
    click(cx, h, "review-refresh");
    idle(cx, h, &pane);
    cx.update(|cx| {
        let p = pane.read(cx).probe(cx);
        assert_eq!((p.1, p.3), (None, 0), "unavailable content is cleared");
        assert_eq!(
            pane.read(cx).probe_state(),
            Some("This request is unavailable.")
        );
    });
    click(cx, h, "review-page-back");
    idle(cx, h, &pane);
    let slot = rows(cx, &pane).iter().position(|r| r == &notes).unwrap();
    cx.update(|cx| {
        assert_eq!(
            pane.read(cx).probe_statuses()[slot],
            "Unavailable · Pending"
        )
    });
    assert_eq!(rows(cx, &pane), ids[..20], "the slot keeps its place");
    click(cx, h, ("review-request", slot));
    assert_eq!(
        target(cx, &view),
        review(None, None, None),
        "unavailable rows don't open"
    );
    host.send(json!({"cmd":"unmove","id":b}));
    click(cx, h, "review-refresh");
    idle(cx, h, &pane);
    cx.update(|cx| {
        assert_eq!(
            pane.read(cx).probe_statuses()[slot],
            "Pending · readiness unknown"
        )
    });

    // 10. No request source is unavailable, never empty. A chat still shows its saved
    // revisions. All four have stored requests, so none is labelled as having no request.
    host.send(json!({"cmd":"fail-requests"}));
    click(cx, h, "review-refresh");
    idle(cx, h, &pane);
    cx.update(|cx| {
        assert!(pane.read(cx).probe_requests().is_empty());
        assert_eq!(
            pane.read(cx).probe_state(),
            Some("Review requests are unavailable.")
        );
    });
    open_chat_review(cx, h, &view, Some(&pane), &a);
    cx.update(|cx| {
        assert!(pane.read(cx).probe_requests().is_empty());
        assert_eq!(pane.read(cx).probe_saved(), listed);
    });
    cx.update_window(h, |_, w, _| {
        assert!(w.find("review-unavailable").bounds().size.height > px(0.))
    })
    .unwrap();
    let saved_label = |cx: &mut HeadlessAppContext| {
        cx.update_window(h, |_, w, _| {
            let label = w
                .find(("review-saved", 0usize))
                .label()
                .unwrap_or_default()
                .to_owned();
            assert!(
                label.contains("Request status not shown here")
                    && !label.contains("No review request"),
                "{label}"
            );
        })
        .unwrap();
    };
    saved_label(cx);
    // A requested revision opened through this fallback keeps the warning and an honest status,
    // through Refresh and Back.
    let warned = |cx: &mut HeadlessAppContext, pane: &Entity<Pane>| {
        cx.update_window(h, |_, w, _| {
            assert!(w.find("review-unavailable").bounds().size.height > px(0.))
        })
        .unwrap();
        cx.update(|cx| {
            assert_eq!(
                pane.read(cx).probe_status(),
                Some("Request status not shown here")
            )
        });
    };
    click(cx, h, ("review-saved", 0usize));
    idle(cx, h, &pane);
    assert_eq!(target(cx, &view), review(Some(&a), None, Some(&listed[0])));
    assert_eq!(shown(cx, &pane).as_deref(), Some(listed[0].as_str()));
    warned(cx, &pane);
    click(cx, h, "review-refresh");
    idle(cx, h, &pane);
    assert_eq!(shown(cx, &pane).as_deref(), Some(listed[0].as_str()));
    warned(cx, &pane);
    press(cx, h, "escape");
    assert_eq!(target(cx, &view), review(Some(&a), None, None));
    idle(cx, h, &pane);
    cx.update_window(h, |_, w, _| {
        assert!(w.find("review-unavailable").bounds().size.height > px(0.))
    })
    .unwrap();
    saved_label(cx);
    host.send(json!({"cmd":"restore-requests"}));
    // Offline is an error, never an empty list.
    host.send(json!({"cmd":"offline"}));
    click(cx, h, "review-page-all");
    idle(cx, h, &pane);
    cx.update(|cx| {
        assert_ne!(
            pane.read(cx).probe_state(),
            Some("Nothing is waiting for review.")
        );
        assert!(pane.read(cx).probe_requests().is_empty());
    });
    host.send(json!({"cmd":"online"}));
    click(cx, h, "review-refresh");
    idle(cx, h, &pane);
    assert_eq!(rows(cx, &pane), ids[..20]);

    // 11. Narrow and dark: the list and an exact change stay inside the page.
    cx.update(|cx| {
        crate::appearance::commit_appearance(crate::settings_state::AppearancePreference::Dark, cx);
        gpui_kit::component::Theme::change(ThemeMode::Dark, None, cx);
    });
    cx.update_window(h, |_, w, cx| {
        w.resize(size(px(680.), px(700.)));
        w.bounds_changed(cx);
    })
    .unwrap();
    settle(cx, h);
    cx.update(|cx| {
        use gpui_kit::component::ActiveTheme;
        assert!(cx.theme().is_dark());
    });
    contained(
        cx,
        h,
        &["review-page-header", "review-actions", "review-list"],
    );
    open_request(cx, h, &pane, &ids[latest]);
    contained(
        cx,
        h,
        &[
            "review-page-header",
            "review-change",
            "review-actions",
            "review-files-bar",
        ],
    );
    cx.update_window(h, |_, w, _| {
        assert!(w.find("review-diff").bounds().size.height > px(100.))
    })
    .unwrap();
    // Escape returns to the list, then leaves Review.
    cx.update_window(h, |_, w, cx| {
        pane.update(cx, |p, cx| p.focus(w, cx));
        w.press("escape", cx);
    })
    .unwrap();
    settle(cx, h);
    assert_eq!(target(cx, &view), review(None, None, None));

    // Browsing and faults changed no stored request's ID, revision, state or sequence, and
    // the app only read.
    assert_eq!(host.requests(), stored, "no request was added or changed");
    let log = host.log();
    assert!(!log.is_empty());
    gets_only(&log);
    for (_, path) in &log {
        assert!(
            !path.contains("/review")
                || !(path.contains("/missions/") || path.contains("/projects/")),
            "no mission or project Review reads: {path}"
        );
    }
    cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
    drop(view);
    cx.run_until_parked();
    host.finish();
    println!(
        "native Review host: real standalone creation/capture in two projects, real request store and routes; empty, saved-only, exact revisions/source/diff copy, request and saved paging, history labels, unavailable slot, missing request source, offline, current-file handoff, keyboard, scroll, narrow/dark. Fake worker, fixture-only setup requests and faults; not OS input, IME, AX or performance acceptance"
    );
}
