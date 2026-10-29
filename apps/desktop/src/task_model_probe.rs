//! Mounted production Browser/task form, only an owned synthetic daemon.
use crate::{
    mission_browser_fixture as f,
    mission_browser_view::{Browser, Input},
    mission_reader::Route,
    task_model::Outcome,
    task_model_fixture::{Reply, Server},
};
use gpui_kit::{
    AnyWindowHandle, App, AppContext, Bounds, Entity, HeadlessAppContext, ScrollDelta,
    WindowBounds, WindowOptions, component::ThemeMode, point, px, size, test::TestWindowExt,
};
use std::{
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};
fn settle(cx: &mut HeadlessAppContext, h: AnyWindowHandle) {
    for _ in 0..4 {
        cx.run_until_parked();
        cx.advance_clock(Duration::from_millis(16));
        cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
    }
}
#[track_caller]
fn until(cx: &mut HeadlessAppContext, h: AnyWindowHandle, f: impl Fn(&App) -> bool) {
    let end = Instant::now() + Duration::from_secs(8);
    while !cx.update(|cx| f(cx)) {
        assert!(
            Instant::now() < end,
            "task-create timeout at {}",
            std::panic::Location::caller()
        );
        settle(cx, h);
        std::thread::yield_now();
    }
    settle(cx, h);
}
fn input(route: Option<Route>) -> Input {
    Input {
        route,
        filter: None,
        projects: Arc::new(Vec::new()),
        chats: Arc::new(Vec::new()),
        online: true,
        loaded: true,
    }
}
fn reveal(cx: &mut HeadlessAppContext, h: AnyWindowHandle, id: &'static str) {
    if id.starts_with("task-model-") {
        // The editor is in the root dialog layer, not the page scroll view.
        settle(cx, h);
        return;
    }
    cx.update_window(h, |_, w, cx| {
        let viewport = w.find("missions-page").bounds();
        let target = w.find(id).bounds();
        w.scroll(
            "missions-page",
            ScrollDelta::Pixels(point(px(0.), viewport.top() + px(24.) - target.top())),
            cx,
        );
    })
    .unwrap();
    settle(cx, h);
}
fn click(cx: &mut HeadlessAppContext, h: AnyWindowHandle, id: &'static str) {
    reveal(cx, h, id);
    cx.update_window(h, |_, w, cx| w.click(id, cx)).unwrap();
    settle(cx, h);
    if id == "mission-task-model" {
        // Do not aim at a dialog while its existing native entrance is in flight.
        cx.advance_clock(Duration::from_millis(300));
        settle(cx, h);
    }
}
fn route(cx: &mut HeadlessAppContext, h: AnyWindowHandle, b: &Entity<Browser>, id: &str) {
    cx.update_window(h, |_, w, cx| {
        b.update(cx, |b, cx| {
            if !b.brief_marked(w, cx) {
                b.sync(input(Some(Route::Detail(f::key(id)))), w, cx);
            }
        })
    })
    .unwrap();
    settle(cx, h);
}
fn capture(cx: &mut HeadlessAppContext, h: AnyWindowHandle, dir: &Option<PathBuf>, name: String) {
    if let Some(d) = dir {
        cx.capture_screenshot(h)
            .unwrap()
            .save(d.join(name))
            .unwrap();
    }
}

fn open_preferences(cx: &mut HeadlessAppContext, h: AnyWindowHandle, b: &Entity<Browser>) {
    until(cx, h, |cx| !b.read(cx).busy);
    let pane = cx.update(|cx| b.read(cx).tasks_browser.clone());
    if !cx.update(|cx| pane.read(cx).opened) {
        click(cx, h, "mission-tab-tasks");
    }
    until(cx, h, |cx| {
        !pane.read(cx).state.busy && pane.read(cx).state.snapshot.is_some()
    });
    click(cx, h, "mission-tasks-row-task-A");
    crate::mission_tasks_probe::task_action(cx, h, "task-A", "Preferred model…");
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
pub fn run_task_model_probe(cx: &mut HeadlessAppContext) {
    let dir = std::env::var_os("PILOT_NEXT_TASK_MODEL_DIR").map(PathBuf::from);
    if let Some(d) = &dir {
        std::fs::create_dir_all(d).unwrap();
    }
    for (width, mode) in [(680., ThemeMode::Light), (1100., ThemeMode::Dark)] {
        let server = Server::start();
        let (h, b) = cx.update(|cx| {
            crate::appearance::commit_appearance(
                if mode == ThemeMode::Dark {
                    crate::settings_state::AppearancePreference::Dark
                } else {
                    crate::settings_state::AppearancePreference::Light
                },
                cx,
            );
            gpui_kit::open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                        point(px(0.), px(0.)),
                        size(px(width), px(850.)),
                    ))),
                    show: false,
                    focus: false,
                    ..Default::default()
                },
                cx,
                |w, cx| {
                    cx.new(|cx| {
                        let mut b = Browser::new(cx);
                        b.options(server.options.clone());
                        b.sync(input(Some(Route::Catalog)), w, cx);
                        b
                    })
                },
            )
            .unwrap()
        });
        until(cx, h, |cx| b.read(cx).catalog.is_some() && !b.read(cx).busy);
        route(cx, h, &b, "mission-A");
        until(cx, h, |cx| b.read(cx).detail.is_some() && !b.read(cx).busy);
        open_preferences(cx, h, &b);
        let pane = cx.update(|cx| b.read(cx).tasks_browser.clone());
        let form = cx.update(|cx| pane.read(cx).model_form.clone().unwrap());
        until(cx, h, |cx| form.read(cx).loaded.is_some());
        choose(cx, h, "task-model-picker", 1);
        assert_eq!(
            cx.update(|cx| form.read(cx).value.model.clone()),
            Some("p/a".into())
        );
        choose(cx, h, "task-model-thinking", 3);
        assert_eq!(
            cx.update(|cx| form.read(cx).value.thinking.clone()),
            Some("high".into())
        );
        // Enter selects but never submits. The draft survives close and reopen.
        assert_eq!(
            server
                .state
                .lock()
                .unwrap()
                .seen
                .iter()
                .filter(|(m, _, _)| m != "GET")
                .count(),
            0
        );
        capture(cx, h, &dir, format!("{}-{:?}.png", width as u32, mode));
        cx.update_window(h, |_, w, _| {
            let f = w.find("task-model-form").bounds();
            let picker = w.find("task-model-picker").bounds();
            assert!(f.size.width <= px(480.));
            assert!(picker.size.height <= px(35.));
            assert!(f.contains(&picker.center()));
        })
        .unwrap();
        click(cx, h, "task-model-close");
        assert!(cx.update(|cx| pane.read(cx).model_form.is_none()));
        cx.update_window(h, |_, w, cx| assert!(pane.read(cx).owns_focus(w, cx)))
            .unwrap();
        crate::mission_tasks_probe::task_action(cx, h, "task-A", "Preferred model…");
        assert_eq!(
            cx.update(|cx| pane.read(cx).model_form.clone().unwrap()),
            form
        );
        assert_eq!(
            cx.update(|cx| form.read(cx).value.thinking.clone()),
            Some("high".into())
        );
        // A real exact ACK is the only success path. Re-entry is an explicit fresh intent.
        click(cx, h, "task-model-save");
        until(cx, h, |cx| {
            matches!(
                form.read(cx).state.attempt.as_ref(),
                Some((_, Outcome::Saved))
            )
        });
        click(cx, h, "task-model-again");
        until(cx, h, |cx| form.read(cx).loaded.is_some());
        choose(cx, h, "task-model-picker", 1);
        choose(cx, h, "task-model-thinking", 3);
        choose(cx, h, "task-model-picker", 1);
        assert_eq!(
            cx.update(|cx| form.read(cx).value.model.clone()),
            Some("p/b*#~".into())
        );
        assert_eq!(
            cx.update(|cx| form.read(cx).value.thinking.clone()),
            None,
            "changing model resets incompatible thinking"
        );
        // Delayed wrong ACK, close before arrival: do not focus/close a different page or replay.
        let mut reply = Reply::json(200, serde_json::json!({"wrong":"ack"}));
        reply.delay = 250;
        server.reply("POST", "/api/missions/mission-A/tasks/task-A/model", reply);
        click(cx, h, "task-model-save");
        click(cx, h, "task-model-save");
        click(cx, h, "task-model-close");
        route(cx, h, &b, "mission-B");
        until(cx, h, |cx| {
            matches!(
                form.read(cx).state.attempt.as_ref(),
                Some((_, Outcome::Unknown(_)))
            )
        });
        assert_eq!(
            cx.update(|cx| b.read(cx).route.clone()),
            Some(Route::Detail(f::key("mission-B")))
        );
        assert_eq!(
            server
                .state
                .lock()
                .unwrap()
                .seen
                .iter()
                .filter(|(m, _, _)| m != "GET")
                .count(),
            2
        );
        route(cx, h, &b, "mission-A");
        until(cx, h, |cx| !b.read(cx).busy);
        open_preferences(cx, h, &b);
        click(cx, h, "task-model-save");
        assert_eq!(
            server
                .state
                .lock()
                .unwrap()
                .seen
                .iter()
                .filter(|(m, _, _)| m != "GET")
                .count(),
            2
        );
        capture(cx, h, &dir, format!("{}-unknown.png", width as u32));
        cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
    }
    println!(
        "task-model: 2 native light/dark popup, select, retention, explicit save and late Unknown journeys passed"
    );
}
