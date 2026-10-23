//! Same fixed synthetic production-root fixture before and after shell styling.
//! Baseline mode relaxes only new-layout assertions, never route/write fences.
use super::*;
use gpui_kit::{
    Bounds, HeadlessAppContext, WindowBounds, WindowOptions,
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
fn capture(
    cx: &mut HeadlessAppContext,
    h: gpui_kit::AnyWindowHandle,
    dir: &Option<std::path::PathBuf>,
    name: String,
) {
    if let Some(dir) = dir {
        cx.capture_screenshot(h)
            .unwrap()
            .save(dir.join(name))
            .unwrap();
    }
}
pub fn run_workbench_probe(cx: &mut HeadlessAppContext) {
    let baseline = std::env::var_os("PILOT_NEXT_WORKBENCH_BASELINE").is_some();
    let captures = std::env::var_os("PILOT_NEXT_WORKBENCH_DIR").map(std::path::PathBuf::from);
    if let Some(d) = &captures {
        std::fs::create_dir_all(d).unwrap();
    }
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            cx.update(|cx| Theme::change(mode, None, cx));
            let (client, reads) = LocalClient::synthetic_commands();
            let (writer, writes) = Interaction::recording();
            let(h,v)=cx.update(|cx|gpui_kit::open_window(WindowOptions{window_bounds:Some(WindowBounds::Windowed(Bounds::new(Default::default(),size(px(width),px(760.))))),show:false,focus:false,..Default::default()},cx,|w,cx|cx.new(|cx|{
            let mut v=LocalViewer::preview(PreviewState::Conversation,w,cx);
            v.client=Some(client);v.writer=Some(writer.clone());v.editor.update(cx,|e,cx|e.shell_probe_setup(writer,w,cx));
            v.generation=20;v.state.generation=20;v.state.loaded=true;v.state.list_loaded=true;v.state.projects_loaded=true;
            v.state.projects=Arc::new(crate::local_model::projects(&json!([
                {"id":"a","name":format!("Atlas {}","long project name 👩‍💻 ".repeat(4)),"path":"/synthetic/shared"},
                {"id":"b","name":"Boreal","path":"/synthetic/shared"}
            ])).unwrap());
            v.state.chats=Arc::new([
                json!({"id":"synthetic","title":format!("Current {}","long conversation title ".repeat(4)),"projectId":"a","state":"working"}),
                json!({"id":"other","title":"Review package","projectId":"b","state":"idle"}),
                json!({"id":"failed","title":"Check failed build","projectId":"a","state":"failed"}),
                json!({"id":"archive","title":"Retained archived note","projectId":"b","state":"idle","archivedAt":1})
            ].iter().map(|x|crate::local_model::chat(x).unwrap()).collect());
            v.title="Synthetic workbench conversation".into();v.rebuild_nav(w,cx);v
        }))).unwrap();
            settle(cx, h);
            capture(
                cx,
                h,
                &captures,
                format!("{}-{}-chat.png", width as u32, mode.name()),
            );
            cx.update_window(h, |_, w, cx| {
                for id in [
                    "new-local-chat",
                    "archives",
                    "nav-home",
                    "nav-inbox",
                    "nav-all-chats",
                    "nav-back",
                    "nav-forward",
                ] {
                    let b = w.find(id).bounds();
                    assert!(
                        b.left() >= px(0.)
                            && b.right() <= px(if width < 800. { 184. } else { 232. }),
                        "sidebar target {id} stays in bounds"
                    );
                }
                w.click("nav-home", cx);
            })
            .unwrap();
            settle(cx, h);
            capture(
                cx,
                h,
                &captures,
                format!("{}-{}-home.png", width as u32, mode.name()),
            );
            cx.update_window(h, |_, w, cx| {
                let row = w.find("home-project-a").bounds();
                let title = w.find("overview-project-title-a").bounds();
                assert!(title.left() >= row.left() && title.right() <= row.right());
                if !baseline {
                    assert!(
                        w.find("home-projects-heading").bounds().top()
                            < w.find("home-working-heading").bounds().top()
                    );
                    assert!(
                        w.find("home-working-heading").bounds().top()
                            < w.find("home-recent-heading").bounds().top()
                    );
                    assert!(w.try_find("home-loaded-qualifier").is_some());
                }
                if w.try_find("project-scope").is_some() {
                    w.click("project-scope", cx);
                } else {
                    assert!(baseline);
                }
            })
            .unwrap();
            settle(cx, h);
            capture(
                cx,
                h,
                &captures,
                format!("{}-{}-scope.png", width as u32, mode.name()),
            );
            cx.update_window(h, |_, w, cx| {
                let b = w.find("project-b").bounds();
                assert!(b.right() <= px(if width < 800. { 184. } else { 232. }));
                w.click("project-b", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update(|cx| assert_eq!(v.read(cx).project_scope.as_deref(), Some("b")));
            assert!(reads.try_recv().is_err() && writes.try_recv().is_err());
            cx.update_window(h, |_, w, cx| {
                w.click("project-overview", cx);
                v.update(cx, |v, cx| {
                    v.state.projects = Arc::new(vec![v.state.projects[0].clone()]);
                    v.state.projects_error =
                        Some("Synthetic catalog unavailable; last valid chats remain.");
                    v.rebuild_nav(w, cx);
                });
            })
            .unwrap();
            settle(cx, h);
            capture(
                cx,
                h,
                &captures,
                format!("{}-{}-removed-project.png", width as u32, mode.name()),
            );
            cx.update(|cx| {
                assert_eq!(v.read(cx).page, Page::Project("b".into()));
                assert_eq!(v.read(cx).project_scope.as_deref(), Some("b"));
            });
            cx.update_window(h, |_, w, cx| w.press("secondary-2", cx))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                w.press("secondary-k", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(w.try_find("jump-palette").is_some());
                w.press("escape", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                w.press("secondary-1", cx);
                v.update(cx, |v, cx| {
                    v.state.chats = Arc::new(vec![]);
                    v.state.projects = Arc::new(vec![]);
                    v.state.projects_loaded = false;
                    v.state.list_loaded = false;
                    v.state.projects_error = None;
                    v.rebuild_nav(w, cx);
                });
            })
            .unwrap();
            settle(cx, h);
            capture(
                cx,
                h,
                &captures,
                format!("{}-{}-loading.png", width as u32, mode.name()),
            );
            cx.update_window(h, |_, w, cx| {
                v.update(cx, |v, cx| {
                    v.state.projects_loaded = true;
                    v.state.list_loaded = true;
                    v.rebuild_nav(w, cx);
                })
            })
            .unwrap();
            settle(cx, h);
            capture(
                cx,
                h,
                &captures,
                format!("{}-{}-empty.png", width as u32, mode.name()),
            );
            assert!(reads.try_recv().is_err() && writes.try_recv().is_err());
            println!(
                "{}",
                json!({"width":width,"mode":mode.name(),"baseline":baseline,"same_synthetic_fixture":"workbench-v1","exact_scope_and_removed_no_fallback":true,"long_label_bounds":true,"global_navigation_and_palette_reachable":true,"canonical_write_commands":0,"implicit_reads":0,"native_offscreen":true})
            );
            cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
            cx.run_until_parked();
        }
    }
}
