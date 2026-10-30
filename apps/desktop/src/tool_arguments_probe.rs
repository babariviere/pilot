//! Hidden production-root checks of full received arguments, without transport.
use super::*;
use gpui_kit::InputEvent;
use gpui_kit::component::{Theme, ThemeMode};
use std::{io::Write, time::Instant};

// Process CPU includes parser workers. ru_maxrss is the process high-water mark,
// not a section's retained memory or a per-frame allocation measurement.
fn usage() -> (f64, i64) {
    let mut usage = std::mem::MaybeUninit::<libc::rusage>::uninit();
    // SAFETY: getrusage initializes this correctly aligned out pointer on success.
    assert_eq!(
        unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) },
        0
    );
    // SAFETY: the successful call above initialized the entire struct.
    let usage = unsafe { usage.assume_init() };
    let seconds = |t: libc::timeval| t.tv_sec as f64 + t.tv_usec as f64 / 1e6;
    (
        seconds(usage.ru_utime) + seconds(usage.ru_stime),
        usage.ru_maxrss,
    )
}

fn measure<T>(stage: &str, records: &mut Vec<serde_json::Value>, f: impl FnOnce() -> T) -> T {
    let (cpu, _) = usage();
    let start = Instant::now();
    let result = f();
    let wall = start.elapsed().as_secs_f64() * 1000.;
    let (after, peak) = usage();
    records.push(json!({"stage":stage,"wall_ms":wall,"process_cpu_ms":(after-cpu)*1000.,"process_peak_rss_bytes":peak}));
    result
}

pub(super) fn run(cx: &mut HeadlessAppContext) {
    let dir = std::path::PathBuf::from(std::env::var_os("PILOT_NEXT_TOOL_ARGUMENTS_DIR").unwrap());
    std::fs::create_dir_all(&dir).unwrap();
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            cx.update(|cx| Theme::change(mode, None, cx));
            for (name, field, label) in [
                ("codemode", "code", "Code"),
                ("unknown", "text", "Arguments"),
            ] {
                let mut timings = Vec::new();
                let source = "// Synthetic 日本語 👩‍💻 e\u{301} <>&\n".repeat(8000);
                let args = json!({field:source});
                let entry = json!({"id":20,"kind":"pi.assistant","model":[{"role":"assistant","content":[{"type":"toolCall","id":"full","name":name,"arguments":args}]}]});
                let mut model = LiveTranscript::default();
                model.apply(&json!({"type":"snapshot","entries":[entry]}));
                let rows = model.rows();
                let group = rows[0].id();
                let (handle, view) = cx.update(|cx| {
                    gpui_kit::open_window(
                        WindowOptions {
                            window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                                Default::default(),
                                size(px(width), px(940.)),
                            ))),
                            show: false,
                            focus: false,
                            ..Default::default()
                        },
                        cx,
                        |window, cx| {
                            cx.new(|cx| {
                                let v = LocalViewer::synthetic(window, cx);
                                v.transcript
                                    .update(cx, |v, cx| v.replace_readonly(rows, true, cx));
                                v
                            })
                        },
                    )
                    .unwrap()
                });
                cx.run_until_parked();
                cx.update_window(handle, |_, window, cx| {
                    window.click(SharedString::from(format!("work-toggle-{group}")), cx);
                })
                .unwrap();
                cx.run_until_parked();
                measure("expand", &mut timings, || {
                    cx.update_window(handle, |_, window, cx| {
                        window.click("step-toggle-call:full", cx)
                    })
                    .unwrap();
                    cx.run_until_parked();
                });
                let mut retained_body = None;
                for phase in ["history", "live"] {
                    if phase == "live" {
                        timings.clear();
                    }
                    measure("update_and_settle", &mut timings, || {
                        if phase == "live" {
                            model.apply(&json!({"type":"run_start"}));
                            model.apply(&json!({"type":"message_start","message":{"role":"assistant","content":[{"type":"toolCall","id":"full","name":name,"arguments":{field:""}}]}}));
                            model.apply(&json!({"type":"message_update","changes":[{"type":"toolcall_delta","contentIndex":0,"path":[field],"delta":source}]}));
                            model.apply(&json!({"type":"tool_execution_update","toolCallId":"full","output":{"set":"ok"}}));
                            cx.update_window(handle, |_, _, cx| {
                                view.update(cx, |v, cx| {
                                    v.transcript.update(cx, |v, cx| {
                                        v.replace_readonly(model.rows(), false, cx)
                                    })
                                })
                            })
                            .unwrap();
                            cx.run_until_parked();
                        }
                    });
                    measure("settled_draw", &mut timings, || {
                        cx.update_window(handle, |_, window, cx| window.draw(cx).clear(cx))
                            .unwrap();
                    });
                    cx.update_window(handle, |_, window, cx| {
                        window.draw(cx).clear(cx);
                        assert!(view.read(cx).transcript.read(cx).disclosure_probe_step("full", cx).0);
                        let body = window.find(SharedString::from(format!("body-call:full-{label}"))).bounds();
                        assert!(body.size.height > px(0.) && body.size.height <= px(260.));
                        assert!(body.right() <= window.find("viewport").bounds().right());
                        window.click(SharedString::from(format!("copy-call:full-{label}")), cx);
                        let expected = if label == "Code" { source.clone() } else { serde_json::to_string_pretty(&args).unwrap() };
                        assert_eq!(cx.read_from_clipboard().unwrap().text().unwrap(), expected);
                        window.scroll(SharedString::from(format!("body-call:full-{label}")), ScrollDelta::Pixels(point(px(0.), px(-240.))), cx);
                        println!("{}", json!({"fixture":"full-tool-arguments", "phase":phase,"width":width,"appearance":mode.name(),"tool":name,"bytes":expected.len(),"exact_copy":true,"synthetic_only":true}));
                    }).unwrap();
                    cx.run_until_parked();
                    let body = cx.update(|cx| {
                        view.read(cx)
                            .transcript
                            .read(cx)
                            .disclosure_probe_body("full", label, cx)
                            .0
                    });
                    if let Some(prior) = &retained_body {
                        assert_eq!(prior, &body);
                    }
                    retained_body = Some(body.clone());
                    let mut offsets = Vec::new();
                    let profile = std::env::var_os("PILOT_NEXT_TOOL_ARGUMENTS_PROFILE").is_some()
                        && name == "unknown";
                    let mut sampler = profile.then(|| {
                        std::process::Command::new("/usr/bin/sample")
                            .args([
                                std::process::id().to_string(),
                                "1".into(),
                                "1".into(),
                                "-file".into(),
                                dir.join("sample.txt").display().to_string(),
                            ])
                            .spawn()
                            .unwrap()
                    });
                    for delta in [-240., -240., -240., -1e9, 240., 240., 240., 1e9] {
                        measure("scroll_dispatch", &mut timings, || {
                            cx.update_window(handle, |_, window, cx| {
                                let position = window
                                    .find(SharedString::from(format!("body-call:full-{label}")))
                                    .bounds()
                                    .center();
                                window.dispatch_event(
                                    gpui_kit::ScrollEvent {
                                        position,
                                        delta: ScrollDelta::Pixels(point(px(0.), px(delta))),
                                        touch_phase: gpui_kit::TouchPhase::Started,
                                        ..Default::default()
                                    }
                                    .to_platform_input(),
                                    cx,
                                );
                            })
                            .unwrap();
                        });
                        measure("scroll_settle", &mut timings, || cx.run_until_parked());
                        measure("scroll_draw", &mut timings, || {
                            cx.update_window(handle, |_, window, cx| window.draw(cx).clear(cx))
                                .unwrap();
                        });
                        offsets.push(cx.update(|cx| {
                            view.read(cx)
                                .transcript
                                .read(cx)
                                .disclosure_probe_body("full", label, cx)
                                .1
                                .as_f32()
                        }));
                    }
                    assert!(offsets[0] < 0. && offsets[1] < offsets[0] && offsets[3] < offsets[2]);
                    assert_eq!(offsets[7], 0.);
                    cx.update_window(handle, |_, _, cx| {
                        let expected = if label == "Code" {
                            source.clone()
                        } else {
                            serde_json::to_string_pretty(&args).unwrap()
                        };
                        assert_eq!(body.read(cx).rendered_text().source(), expected);
                    })
                    .unwrap();
                    let record = json!({"width":width,"appearance":mode.name(),"tool":name,"phase":phase,"timings":timings,"offsets":offsets});
                    let mut file = std::fs::OpenOptions::new()
                        .create(true)
                        .append(true)
                        .open(dir.join("timings.ndjson"))
                        .unwrap();
                    writeln!(file, "{record}").unwrap();
                    file.sync_all().unwrap();
                    if let Some(sampler) = &mut sampler {
                        assert!(sampler.wait().unwrap().success());
                    }
                    cx.capture_screenshot(handle)
                        .unwrap()
                        .save(dir.join(format!(
                            "args-{}-{}-{name}-{phase}.png",
                            width as u32,
                            mode.name()
                        )))
                        .unwrap();
                    if profile {
                        return;
                    }
                }
                cx.update_window(handle, |_, window, _| window.remove_window())
                    .unwrap();
                cx.run_until_parked();
            }
        }
    }
}
