//! Sidebar wheel cost, cold vs warm, with production dispatchers.
//! `run`: hidden window, synchronous draw (layout+prepaint+paint) and CPU only.
//! `run_visible`: shown, focused glass window driven by the display's frame
//! callbacks; times frame-to-frame intervals, so draw, Metal submission and
//! drawable back-pressure all count. Compositor latency is not observed.
use super::*;
use gpui_kit::{
    Bounds, InputEvent, Pixels, ScrollDelta, ScrollWheelEvent, WindowBounds, WindowOptions, point,
    size, test::TestWindowExt,
};
use serde_json::json;
use std::{cell::RefCell, rc::Rc, time::Instant};

fn thread_cpu_ms() -> f64 {
    let mut t = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    // SAFETY: clock_gettime writes only the provided timespec.
    unsafe { libc::clock_gettime(libc::CLOCK_THREAD_CPUTIME_ID, &mut t) };
    t.tv_sec as f64 * 1000. + t.tv_nsec as f64 / 1e6
}

/// Process-wide retired instructions and CPU cycles: separates more work
/// from the same work at a lower clock.
fn instructions_cycles() -> (u64, u64) {
    // SAFETY: proc_pid_rusage fills the provided V4 struct for this process.
    unsafe {
        let mut info: libc::rusage_info_v4 = std::mem::zeroed();
        libc::proc_pid_rusage(
            libc::getpid(),
            libc::RUSAGE_INFO_V4,
            (&mut info as *mut libc::rusage_info_v4).cast(),
        );
        (info.ri_instructions, info.ri_cycles)
    }
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

fn open(visible: bool, cx: &mut App) -> (gpui_kit::AnyWindowHandle, Entity<LocalViewer>) {
    gpui_kit::open_window(
        WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(if visible {
                Bounds::centered(None, size(px(1100.), px(760.)), cx)
            } else {
                Bounds::new(Default::default(), size(px(1100.), px(760.)))
            })),
            show: visible,
            focus: visible,
            // Launched from a background agent, macOS won't activate the window
            // and may cover it: keep it above others, unthrottled like an active one.
            kind: if visible {
                gpui_kit::WindowKind::PopUp
            } else {
                gpui_kit::WindowKind::Normal
            },
            inactive_frame_interval: if visible {
                None
            } else {
                WindowOptions::default().inactive_frame_interval
            },
            window_background: if visible {
                crate::window_background(cx)
            } else {
                Default::default()
            },
            ..Default::default()
        },
        cx,
        |w, cx| {
            if visible {
                crate::follow_appearance(w, cx);
                w.set_window_title("Pilot Next · sidebar scroll benchmark (synthetic)");
            }
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
    .unwrap()
}

pub fn run(cx: &mut App) {
    let dir = std::env::var_os("PILOT_NEXT_SIDEBAR_SCROLL_DIR").map(std::path::PathBuf::from);
    let (h, view) = open(false, cx);
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
                        let renders = |cx: &App| {
                            let v = view.read(cx);
                            let corner_renders: u64 = v.chats.read(cx).delegate().corners.values().map(|c| c.read(cx).renders).sum();
                            (v.render_count, v.transcript.read(cx).probe_render_count(), corner_renders)
                        };
                        let renders_before = renders(cx);
                        let counters = instructions_cycles();
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
                        let after = instructions_cycles();
                        let renders_after = renders(cx);
                        let list = view.read(cx).chats.read(cx);
                        json!({
                            "step": step,
                            "dispatch_ms": dispatched,
                            "draw_ms": draw,
                            "thread_cpu_ms": cpu,
                            "minstructions": (after.0 - counters.0) as f64 / 1e6,
                            "local_renders": renders_after.0 - renders_before.0,
                            "transcript_renders": renders_after.1 - renders_before.1,
                            "corner_renders": renders_after.2 - renders_before.2,
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

/// One phase driven from frame callbacks: each tick logs, then wheels once,
/// so GPUI draws and presents that scroll in the same frame.
struct Phase {
    view: Entity<LocalViewer>,
    position: gpui_kit::Point<Pixels>,
    delta: f32,
    left: usize,
    last: Option<(Instant, f64, (u64, u64))>,
    frames: Rc<RefCell<Vec<serde_json::Value>>>,
    done: async_channel::Sender<()>,
}

fn tick(w: &mut Window, cx: &mut App, mut phase: Phase) {
    let (now, cpu, counters) = (Instant::now(), thread_cpu_ms(), instructions_cycles());
    let list = phase.view.read(cx).chats.read(cx);
    let corners = list.delegate().corners.len();
    let offset = f32::from(list.scroll_handle().offset().y);
    if let Some((at, cpu_at, (instructions, cycles))) = phase.last {
        // Previous tick's wheel, draw, present and anything else on the thread.
        phase.frames.borrow_mut().push(json!({
            "interval_ms": (now - at).as_secs_f64() * 1000.,
            "thread_cpu_ms": cpu - cpu_at,
            "process_minstructions": (counters.0 - instructions) as f64 / 1e6,
            "process_mcycles": (counters.1 - cycles) as f64 / 1e6,
            "corners": corners,
            "offset": offset,
            "active": w.is_window_active(),
        }));
    }
    if phase.left == 0 {
        let _ = phase.done.try_send(());
        return;
    }
    phase.left -= 1;
    phase.last = Some((now, cpu, counters));
    w.dispatch_event(
        ScrollWheelEvent {
            position: phase.position,
            delta: ScrollDelta::Pixels(point(px(0.), px(phase.delta))),
            ..Default::default()
        }
        .to_platform_input(),
        cx,
    );
    w.on_next_frame(move |w, cx| tick(w, cx, phase));
}

fn summarize(name: &str, frames: &[serde_json::Value], refresh: f64) -> serde_json::Value {
    let field =
        |key: &str| -> Vec<f64> { frames.iter().map(|f| f[key].as_f64().unwrap()).collect() };
    let (intervals, cpu) = (field("interval_ms"), field("thread_cpu_ms"));
    let sorted = |v: &[f64]| {
        let mut v = v.to_vec();
        v.sort_by(f64::total_cmp);
        v
    };
    let (si, sc) = (sorted(&intervals), sorted(&cpu));
    let late = |range: std::ops::Range<usize>| {
        intervals[range]
            .iter()
            .filter(|&&i| i > refresh * 1.5)
            .count()
    };
    let round = |v: &[f64]| {
        v.iter()
            .map(|x| (x * 10.).round() / 10.)
            .collect::<Vec<_>>()
    };
    json!({
        "phase": name,
        "frames": intervals.len(),
        "first8_interval_ms": round(&intervals[..8]),
        "first8_cpu_ms": round(&cpu[..8]),
        "median_interval_ms": si[si.len() / 2],
        "max_interval_ms": si[si.len() - 1],
        "late_first10": late(0..10),
        "late_rest": late(10..intervals.len()),
        "median_cpu_ms": sc[sc.len() / 2],
        "p95_cpu_ms": sc[sc.len() * 95 / 100],
        "max_cpu_ms": sc[sc.len() - 1],
        "active": frames.iter().all(|f| f["active"].as_bool().unwrap()),
    })
}

/// Visible, focused window: frame pacing while wheeling, first scroll vs later.
pub fn run_visible(cx: &mut App) {
    let dir = std::env::var_os("PILOT_NEXT_SIDEBAR_SCROLL_DIR").map(std::path::PathBuf::from);
    let delta: f32 = std::env::var("PILOT_NEXT_SIDEBAR_SCROLL_DELTA")
        .ok()
        .and_then(|d| d.parse().ok())
        .unwrap_or(24.);
    let (h, view) = open(true, cx);
    cx.activate(true);
    let executor = cx.background_executor().clone();
    cx.spawn(async move |cx| {
        // Opened, then idle like a real app before the user's first wheel.
        executor.timer(Duration::from_secs(2)).await;
        let mut phases = Vec::new();
        // Each phase follows 2s idle. Halves separate leaving the top from
        // reversing direction mid-list.
        for (name, sign, frames_left) in [
            ("first-down", -1., 150),
            ("half-up", 1., 75),
            ("mid-down", -1., 75),
            ("up-to-top", 1., 150),
            ("again-down", -1., 150),
        ] {
            let frames = Rc::new(RefCell::new(Vec::new()));
            let (done, finished) = async_channel::bounded(1);
            cx.update_window(h, |_, w, _| {
                let position = w.find("chat-list-pane").bounds().center();
                let phase = Phase {
                    view: view.clone(),
                    position,
                    delta: delta * sign,
                    left: frames_left,
                    last: None,
                    frames: frames.clone(),
                    done,
                };
                w.on_next_frame(move |w, cx| tick(w, cx, phase));
            })
            .unwrap();
            finished.recv().await.unwrap();
            phases.push((name, frames.take()));
            executor.timer(Duration::from_secs(2)).await;
        }
        // The display's own pace: the median interval over the later phases.
        let mut steady: Vec<f64> = phases[1..]
            .iter()
            .flat_map(|(_, f)| f.iter().map(|f| f["interval_ms"].as_f64().unwrap()))
            .collect();
        steady.sort_by(f64::total_cmp);
        let refresh = steady[steady.len() / 2];
        let records: Vec<_> = phases
            .iter()
            .map(|(name, frames)| {
                let summary = summarize(name, frames, refresh);
                println!("{summary}");
                json!({"summary": summary, "frames": frames})
            })
            .collect();
        if let Some(dir) = dir {
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(
                dir.join("sidebar-scroll-visible.json"),
                serde_json::to_vec_pretty(
                    &json!({"refresh_ms": refresh, "delta": delta, "phases": records}),
                )
                .unwrap(),
            )
            .unwrap();
        }
        println!("visible sidebar wheel journey: frame intervals at {refresh:.2}ms pace");
        cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
        cx.update(|cx| cx.quit());
    })
    .detach();
}
