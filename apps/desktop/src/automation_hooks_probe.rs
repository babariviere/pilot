//! Actual LocalViewer Automations page, Hooks section, against an owned faux daemon.
use super::*;
use crate::automation_hooks_fixture::{Mode, Server};
use gpui_kit::{
    AnyWindowHandle, Bounds, HeadlessAppContext, WindowBounds, WindowOptions,
    component::{ActiveTheme, Theme, ThemeMode},
    size,
    test::TestWindowExt,
};
use serde_json::json;
use std::time::Instant;
fn settle(cx: &mut HeadlessAppContext, h: AnyWindowHandle) {
    for _ in 0..4 {
        cx.run_until_parked();
        cx.advance_clock(Duration::from_millis(16));
        cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
    }
}
type Hooks = crate::automation_hooks_view::Hooks;
fn hooks(cx: &mut HeadlessAppContext, v: &Entity<LocalViewer>) -> Entity<Hooks> {
    cx.update(|cx| v.read(cx).automations.read(cx).hooks.clone())
}
#[track_caller]
fn until(
    cx: &mut HeadlessAppContext,
    h: AnyWindowHandle,
    v: &Entity<LocalViewer>,
    done: impl Fn(&Hooks) -> bool,
) {
    let hooks = hooks(cx, v);
    let end = Instant::now() + Duration::from_secs(8);
    while !cx.update(|cx| done(hooks.read(cx))) {
        assert!(Instant::now() < end, "bounded faux hooks read");
        settle(cx, h);
        std::thread::yield_now();
    }
    settle(cx, h);
}
fn idle(h: &Hooks) -> bool {
    !h.busy && h.pending.is_none() && h.snapshot.is_some()
}
fn capture(cx: &mut HeadlessAppContext, h: AnyWindowHandle, name: String) {
    if let Some(dir) = std::env::var_os("PILOT_NEXT_HOOKS_DIR") {
        let dir = std::path::PathBuf::from(dir);
        std::fs::create_dir_all(&dir).unwrap();
        cx.capture_screenshot(h)
            .unwrap()
            .save(dir.join(format!("{name}.png")))
            .unwrap();
    }
}
fn exists(cx: &mut HeadlessAppContext, h: AnyWindowHandle, id: &str) -> bool {
    cx.update_window(h, |_, w, _| w.try_find(id.to_owned()).is_some())
        .unwrap()
}
#[track_caller]
fn click(cx: &mut HeadlessAppContext, h: AnyWindowHandle, id: &str) {
    cx.update_window(h, |_, w, cx| w.click(id.to_owned(), cx))
        .unwrap();
    settle(cx, h);
}
fn puts(s: &Server) -> Vec<serde_json::Value> {
    s.state.lock().unwrap().puts()
}
fn editor_open(cx: &mut HeadlessAppContext, v: &Entity<LocalViewer>) -> bool {
    let hooks = hooks(cx, v);
    cx.update(|cx| hooks.read(cx).editor.is_some())
}
/// What an app update would wait for, as the update lifecycle asks.
fn blocker(
    cx: &mut HeadlessAppContext,
    h: AnyWindowHandle,
    v: &Entity<LocalViewer>,
) -> Option<crate::update_hold::Blocker> {
    cx.update_window(h, |_, w, cx| v.update(cx, |v, cx| v.update_blocker(w, cx)))
        .unwrap()
}
/// Types into the open editor's fields through their real input states.
fn fill(
    cx: &mut HeadlessAppContext,
    h: AnyWindowHandle,
    v: &Entity<LocalViewer>,
    name: &str,
    command: &str,
) {
    let hooks = hooks(cx, v);
    cx.update_window(h, |_, w, cx| {
        let editor = hooks.read(cx).editor.clone().unwrap();
        let (n, c) = {
            let e = editor.read(cx);
            (e.name.clone(), e.command.clone())
        };
        n.update(cx, |i, cx| i.set_value(name.to_owned(), w, cx));
        c.update(cx, |i, cx| i.set_value(command.to_owned(), w, cx));
    })
    .unwrap();
    settle(cx, h);
}
pub fn run_automation_hooks_probe(cx: &mut HeadlessAppContext) {
    cx.update(|cx| cx.set_reduce_motion(true));
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            let s = Server::start();
            let (h, v) = cx
                .update(|cx| {
                    gpui_kit::open_window(
                        WindowOptions {
                            window_bounds: Some(WindowBounds::Windowed(Bounds::new(Default::default(), size(px(width), px(900.))))),
                            show: false,
                            focus: false,
                            ..Default::default()
                        },
                        cx,
                        |w, cx| {
                            cx.new(|cx| {
                                w.activate_window();
                                let mut v = LocalViewer::build(None, None, w, cx);
                                v.automations.update(cx, |a, _| a.connect(s.options.clone()));
                                v.state.projects = Arc::new(crate::local_model::projects(&json!([{"id":"project-a","name":"Pilot","path":"/synthetic/a"},{"id":"project-b","name":"Docs 日本語","path":"/synthetic/b"}])).unwrap());
                                v.state.chats = Arc::new(vec![crate::local_model::chat(&json!({"id":"chat-a","title":"Design review 👩‍💻","projectId":"project-a","state":"idle","automationRuns":[
                                    {"id":"t/install","automationId":"install","name":"Install dependencies","definitionRevision":3,"trigger":"workspace.created","state":"ok","attempt":1,"startedAt":1_790_000_000_000u64,"endedAt":1_790_000_040_000u64,"excerpt":""},
                                    {"id":"r/checks","automationId":"checks","name":"Lint","definitionRevision":3,"trigger":"run.finished","state":"failed","attempt":1,"exitCode":1,"startedAt":1_790_000_100_000u64,"endedAt":1_790_000_118_000u64,"excerpt":"FAIL"}
                                ]})).unwrap()]);
                                v.state.projects_loaded = true;
                                v.state.list_loaded = true;
                                v.state.loaded = true;
                                v.state.status = "Synthetic Local fixture".into();
                                v.rebuild_nav(w, cx);
                                v
                            })
                        },
                    )
                })
                .unwrap();
            cx.update(|cx| Theme::change(mode, None, cx));
            settle(cx, h);
            cx.update(|cx| assert_eq!(cx.theme().is_dark(), mode == ThemeMode::Dark));
            assert!(
                s.state.lock().unwrap().requests.is_empty(),
                "no read before navigation"
            );
            click(cx, h, "nav-automations");
            until(cx, h, &v, idle);
            for id in [
                "automations-hooks",
                "hooks-project-project-a",
                "hook-row-project-a-install",
                "hook-row-project-a-checks",
                "hook-row-project-a-continue",
                "hook-status-project-a-checks",
            ] {
                assert!(exists(cx, h, id), "{id}");
            }
            assert!(
                !exists(cx, h, "hooks-project-project-b"),
                "projects without hooks stay off the list"
            );
            assert!(
                !exists(cx, h, "hook-command-project-a-checks"),
                "details start collapsed"
            );
            cx.update_window(h, |_, w, _| {
                let right = w.find("automations").bounds().right();
                for id in [
                    "automations-hooks",
                    "hooks-new",
                    "hook-text-project-a-checks",
                    "hook-status-project-a-checks",
                    "hook-switch-project-a-checks",
                    "hook-details-project-a-checks",
                ] {
                    let b = w.find(id).bounds();
                    assert!(
                        b.size.width > px(0.) && b.right() <= right,
                        "{id}: {b:?} within {right:?}"
                    );
                }
            })
            .unwrap();
            capture(cx, h, format!("{width}-{mode:?}-list"));
            // The row opens its command and facts; technical fields stay under Details.
            click(cx, h, "hook-text-project-a-checks");
            assert!(exists(cx, h, "hook-command-project-a-checks"));
            assert!(!exists(cx, h, "hook-technical-text-project-a-checks"));
            click(cx, h, "hook-technical-project-a-checks");
            assert!(exists(cx, h, "hook-technical-text-project-a-checks"));
            capture(cx, h, format!("{width}-{mode:?}-details"));
            click(cx, h, "hook-technical-project-a-checks");
            click(cx, h, "hook-details-project-a-checks");
            assert!(
                !exists(cx, h, "hook-command-project-a-checks"),
                "the chevron folds it again"
            );
            // The switch: one PUT at the shown revision, only that hook changed.
            click(cx, h, "hook-switch-project-a-continue");
            until(cx, h, &v, idle);
            let sent = puts(&s);
            assert_eq!(sent.len(), 1);
            assert_eq!(sent[0]["expectedRevision"], 3);
            assert_eq!(sent[0]["items"][2]["enabled"], true);
            assert_eq!(
                sent[0]["items"][1],
                crate::automation_hooks_fixture::sample()["items"][1]
            );
            assert!(
                !exists(cx, h, "hook-note-project-a-continue"),
                "a confirmed toggle needs no note"
            );
            // Edit keeps the settings the editor doesn't show.
            click(cx, h, "hook-text-project-a-checks");
            click(cx, h, "hook-edit-project-a-checks");
            assert!(editor_open(cx, &v));
            assert!(exists(cx, h, "hook-editor-paths"));
            assert_eq!(
                blocker(cx, h, &v),
                None,
                "an untouched dialog holds nothing"
            );
            capture(cx, h, format!("{width}-{mode:?}-editor"));
            fill(cx, h, &v, "Lint", "pnpm lint");
            assert_eq!(
                blocker(cx, h, &v),
                Some(crate::update_hold::Blocker::Hook(
                    crate::update_hold::Hold::Unsaved
                ))
            );
            click(cx, h, "hook-editor-save");
            until(cx, h, &v, idle);
            assert!(!editor_open(cx, &v));
            assert_eq!(
                blocker(cx, h, &v),
                None,
                "a confirmed save releases the hold"
            );
            let sent = puts(&s);
            assert_eq!(sent.len(), 2);
            assert_eq!(sent[1]["expectedRevision"], 4);
            assert_eq!(sent[1]["items"][1]["name"], "Lint");
            assert_eq!(
                sent[1]["items"][1]["action"]["run"],
                json!({"shell":"pnpm lint"})
            );
            assert_eq!(sent[1]["items"][1]["action"]["env"], json!({"CI":"1"}));
            // A new hook in a project without any.
            let section = hooks(cx, &v);
            cx.update_window(h, |_, w, cx| {
                section.update(cx, |h, cx| h.edit("project-b".into(), None, w, cx))
            })
            .unwrap();
            settle(cx, h);
            assert!(editor_open(cx, &v));
            fill(cx, h, &v, "Setup 日本語", "make setup");
            click(cx, h, "hook-editor-save");
            until(cx, h, &v, idle);
            assert!(exists(cx, h, "hooks-project-project-b"));
            assert!(exists(cx, h, "hook-row-project-b-setup"));
            assert_eq!(puts(&s)[2]["expectedRevision"], 0);
            // A refused save keeps the dialog and its text, and says why.
            s.state.lock().unwrap().mode = Mode::Rejected;
            click(cx, h, "hook-text-project-a-install");
            click(cx, h, "hook-edit-project-a-install");
            fill(cx, h, &v, "Install", "pnpm install");
            click(cx, h, "hook-editor-save");
            until(cx, h, &v, idle);
            assert!(editor_open(cx, &v));
            assert!(exists(cx, h, "hook-editor-note"));
            capture(cx, h, format!("{width}-{mode:?}-rejected"));
            click(cx, h, "hook-editor-cancel");
            assert!(!editor_open(cx, &v));
            click(cx, h, "hook-details-project-a-install");
            // Someone else saved first: the row says so and shows Local's version.
            s.state.lock().unwrap().mode = Mode::Conflict;
            let before = puts(&s).len();
            click(cx, h, "hook-switch-project-a-install");
            until(cx, h, &v, idle);
            assert_eq!(puts(&s).len(), before + 1);
            assert!(exists(cx, h, "hook-note-project-a-install"));
            let revision = s.state.lock().unwrap().hooks("project-a")["revision"]
                .as_u64()
                .unwrap();
            let shown = cx.update(|cx| {
                section
                    .read(cx)
                    .snapshot
                    .as_ref()
                    .unwrap()
                    .projects
                    .iter()
                    .find(|p| p.project_id == "project-a")
                    .unwrap()
                    .revision
            });
            assert_eq!(shown, revision);
            // A lost answer is never repeated; a passive read shows what Local has.
            s.state.lock().unwrap().mode = Mode::Lost;
            let reads = |s: &Server| {
                s.state
                    .lock()
                    .unwrap()
                    .requests
                    .iter()
                    .filter(|(m, p, ..)| m == "GET" && p == "/api/projects")
                    .count()
            };
            let (before, read_before) = (puts(&s).len(), reads(&s));
            click(cx, h, "hook-switch-project-a-install");
            until(cx, h, &v, idle);
            assert_eq!(puts(&s).len(), before + 1);
            assert!(reads(&s) > read_before);
            assert!(exists(cx, h, "hook-note-project-a-install"));
            capture(cx, h, format!("{width}-{mode:?}-unconfirmed"));
            // Switched off on this host: listed, read-only.
            {
                let mut state = s.state.lock().unwrap();
                state.enabled = false;
                state.mode = Mode::Accept;
            }
            click(cx, h, "automations-refresh");
            until(cx, h, &v, idle);
            assert!(exists(cx, h, "hooks-off"));
            assert!(!exists(cx, h, "hooks-new"));
            let before = puts(&s).len();
            click(cx, h, "hook-switch-project-a-install");
            assert_eq!(puts(&s).len(), before, "no write while off");
            capture(cx, h, format!("{width}-{mode:?}-off"));
            // No hooks: an empty line with New hook when on, nothing when off.
            {
                let mut state = s.state.lock().unwrap();
                state.enabled = true;
                for (_, a) in state.projects.iter_mut() {
                    *a = None;
                }
            }
            click(cx, h, "automations-refresh");
            until(cx, h, &v, idle);
            assert!(exists(cx, h, "hooks-empty"));
            assert!(exists(cx, h, "hooks-new"));
            capture(cx, h, format!("{width}-{mode:?}-empty"));
            s.state.lock().unwrap().enabled = false;
            click(cx, h, "automations-refresh");
            until(cx, h, &v, idle);
            assert!(!exists(cx, h, "automations-hooks"));
            cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
        }
    }
}
