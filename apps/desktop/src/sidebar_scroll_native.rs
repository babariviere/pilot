//! Hidden native window, production dispatchers: sidebar wheel cost, cold vs warm.
//! Times synchronous draw (layout+prepaint+paint) and main-thread CPU. Not
//! presentation, frame pacing or smoothness evidence.
use super::*;
use gpui_kit::{
    Bounds, InputEvent, ScrollDelta, ScrollWheelEvent, WindowBounds, WindowOptions, point, size,
    test::TestWindowExt,
};
use serde_json::json;
use std::time::Instant;

fn thread_cpu_ms() -> f64 {
    let mut t = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    // SAFETY: clock_gettime writes only the provided timespec.
    unsafe { libc::clock_gettime(libc::CLOCK_THREAD_CPUTIME_ID, &mut t) };
    t.tv_sec as f64 * 1000. + t.tv_nsec as f64 / 1e6
}

fn fixture() -> Vec<Chat> {
    let states = ["idle", "working", "idle", "failed", "idle", "idle"];
    (0..240)
        .map(|ix| {
            let state = states[ix % states.len()];
            let mut value = json!({
                "id": format!("chat{ix}"),
                "title": format!("{} {ix}", ["Review package", "Résumé des tâches 👩‍💻", "長いタイトルの会話", "Check failed build on main"][ix % 4]),
                "projectId": if ix % 3 == 0 { "b" } else { "a" },
                "state": state,
            });
            if ix % 11 == 0 {
                value["attentionReason"] = json!({"kind": "tool_stall"});
            }
            crate::local_model::chat(&value).unwrap()
        })
        .collect()
}

pub fn run(cx: &mut App) {
    let dir = std::env::var_os("PILOT_NEXT_SIDEBAR_SCROLL_DIR").map(std::path::PathBuf::from);
    let (h, view) = gpui_kit::open_window(
        WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                Default::default(),
                size(px(1100.), px(760.)),
            ))),
            show: false,
            focus: false,
            ..Default::default()
        },
        cx,
        |w, cx| {
            cx.new(|cx| {
                let mut v = LocalViewer::preview(PreviewState::Conversation, w, cx);
                v.state.loaded = true;
                v.state.list_loaded = true;
                v.state.projects_loaded = true;
                v.state.projects = Arc::new(
                    crate::local_model::projects(&json!([
                        {"id":"a","name":"Atlas","path":"/synthetic/a"},
                        {"id":"b","name":"Boreal","path":"/synthetic/b"}
                    ]))
                    .unwrap(),
                );
                v.state.chats = Arc::new(fixture());
                v.rebuild_nav(w, cx);
                v
            })
        },
    )
    .unwrap();
    let executor = cx.background_executor().clone();
    cx.spawn(async move |cx| {
        // Like an app that opened and then sat idle: one draw, the background
        // dither atlas finishes, one more draw. Nothing is prewarmed by scrolling.
        for _ in 0..2 {
            cx.update_window(h, |_, w, cx| w.draw(cx).clear(cx)).unwrap();
            executor.timer(Duration::from_millis(300)).await;
        }
        let mut records = Vec::new();
        for (phase, delta) in [("cold-down", -40.), ("warm-up", 40.), ("warm-down", -40.)] {
            let mut frames = Vec::new();
            for step in 0..170 {
                executor.timer(Duration::from_millis(16)).await;
                let record = cx
                    .update_window(h, |_, w, cx| {
                        let pane = w.find("chat-list-pane").bounds();
                        let position = pane.center();
                        let corners_before = view.read(cx).chats.read(cx).delegate().corners.len();
                        let (cpu, start) = (thread_cpu_ms(), Instant::now());
                        w.dispatch_event(
                            ScrollWheelEvent {
                                position,
                                delta: ScrollDelta::Pixels(point(px(0.), px(delta))),
                                ..Default::default()
                            }
                            .to_platform_input(),
                            cx,
                        );
                        let dispatched = start.elapsed().as_secs_f64() * 1000.;
                        let drawing = Instant::now();
                        w.draw(cx).clear(cx);
                        let draw = drawing.elapsed().as_secs_f64() * 1000.;
                        let cpu = thread_cpu_ms() - cpu;
                        let list = view.read(cx).chats.read(cx);
                        json!({
                            "step": step,
                            "dispatch_ms": dispatched,
                            "draw_ms": draw,
                            "thread_cpu_ms": cpu,
                            "new_corners": list.delegate().corners.len() - corners_before,
                            "offset": f32::from(list.scroll_handle().offset().y),
                        })
                    })
                    .unwrap();
                frames.push(record);
            }
            let draws: Vec<f64> = frames.iter().map(|f| f["draw_ms"].as_f64().unwrap()).collect();
            let mut sorted = draws.clone();
            sorted.sort_by(f64::total_cmp);
            let summary = json!({
                "phase": phase,
                "first_draw_ms": draws[0],
                "first5_draw_ms": &draws[..5],
                "median_draw_ms": sorted[sorted.len() / 2],
                "p95_draw_ms": sorted[sorted.len() * 95 / 100],
                "max_draw_ms": sorted[sorted.len() - 1],
                "new_corners": frames.iter().map(|f| f["new_corners"].as_u64().unwrap()).sum::<u64>(),
            });
            println!("{summary}");
            records.push(json!({"summary": summary, "frames": frames}));
        }
        if let Some(dir) = dir {
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(
                dir.join("sidebar-scroll.json"),
                serde_json::to_vec_pretty(&records).unwrap(),
            )
            .unwrap();
        }
        println!("hidden native sidebar wheel journey (draw/CPU, not presentation)");
        cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
        cx.update(|cx| cx.quit());
    })
    .detach();
}
